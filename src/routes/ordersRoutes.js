const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

const VALID_STATUSES = ['pago', 'pendente'];

/**
 * GET /orders
 * Lista todos os pedidos (com seus itens e produtos), permitindo filtrar por ?payment_status=pendente|pago
 */
router.get('/', async (req, res) => {
  try {
    const { payment_status } = req.query;

    let query = supabase
      .from('orders')
      .select('*, order_items ( id, product_id, quantity, unit_price, products ( id, name, category_id ) )')
      .order('id', { ascending: false });

    if (payment_status) {
      const normalizedStatus = String(payment_status).trim().toLowerCase();
      if (!VALID_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({ error: 'Filtro payment_status inválido. Use "pago" ou "pendente".' });
      }
      query = query.eq('payment_status', normalizedStatus);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const formatted = (data || []).map((order) => ({
      ...order,
      total_amount: Number(order.total_amount),
      order_items: (order.order_items || []).map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        subtotal: Number((Number(item.quantity) * Number(item.unit_price)).toFixed(2))
      }))
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar pedidos.', details: err.message });
  }
});

/**
 * POST /orders
 * Registra um pedido (customer_name, payment_method, payment_status, items: [{ product_id, quantity }]).
 * - Valida os itens e calcula o total_amount automaticamente com base no preço atual dos produtos.
 * - Verifica disponibilidade de estoque para produtos onde stock_quantity !== null.
 * - Abate automaticamente o stock_quantity apenas nos produtos com controle de estoque.
 */
router.post('/', async (req, res) => {
  try {
    const { customer_name, payment_method, payment_status, items } = req.body || {};

    if (!customer_name || typeof customer_name !== 'string' || !customer_name.trim()) {
      return res.status(400).json({ error: 'O nome do cliente (customer_name) é obrigatório.' });
    }

    if (!payment_method || typeof payment_method !== 'string' || !payment_method.trim()) {
      return res.status(400).json({ error: 'A forma de pagamento (payment_method) é obrigatória.' });
    }

    const normalizedStatus = String(payment_status || '').trim().toLowerCase();
    if (!VALID_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        error: 'O status de pagamento (payment_status) deve ser "pago" ou "pendente".'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'O pedido deve conter ao menos um item em "items".' });
    }

    // Consolidar quantidades por product_id caso o mesmo produto seja enviado mais de uma vez no array
    const consolidatedMap = new Map();
    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      const quantity = Number(rawItem.quantity);

      if (!productId || Number.isNaN(productId)) {
        return res.status(400).json({ error: 'Cada item do pedido deve possuir um product_id válido.' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({
          error: `Quantidade inválida para o produto ID ${productId}. Deve ser um inteiro maior que zero.`
        });
      }

      consolidatedMap.set(productId, (consolidatedMap.get(productId) || 0) + quantity);
    }

    const productIds = Array.from(consolidatedMap.keys());

    // Buscar produtos no banco de dados
    const { data: foundProducts, error: productsError } = await supabase
      .from('products')
      .select('*')
      .in('id', productIds);

    if (productsError) {
      return res.status(500).json({ error: productsError.message });
    }

    const productById = new Map((foundProducts || []).map((p) => [Number(p.id), p]));

    // Verificar existência e estoque antes de gravar
    let totalAmount = 0;
    const stockUpdates = [];
    const orderItemsPayload = [];

    for (const [productId, totalQty] of consolidatedMap.entries()) {
      const product = productById.get(productId);
      if (!product) {
        return res.status(404).json({ error: `Produto com ID ${productId} não encontrado.` });
      }

      // Se o produto possui controle de estoque (stock_quantity !== null), validar saldo
      if (product.stock_quantity !== null && product.stock_quantity !== undefined) {
        const currentStock = Number(product.stock_quantity);
        if (currentStock < totalQty) {
          return res.status(400).json({
            error: `Estoque insuficiente para o produto "${product.name}". Disponível: ${currentStock}, Solicitado: ${totalQty}.`
          });
        }
        stockUpdates.push({
          id: productId,
          newStock: currentStock - totalQty
        });
      }

      const unitPrice = Number(product.price);
      totalAmount += unitPrice * totalQty;

      orderItemsPayload.push({
        product_id: productId,
        quantity: totalQty,
        unit_price: Number(unitPrice.toFixed(2))
      });
    }

    totalAmount = Number(totalAmount.toFixed(2));

    // 1. Inserir o Pedido na tabela orders
    const { data: createdOrder, error: orderError } = await supabase
      .from('orders')
      .insert([
        {
          customer_name: customer_name.trim(),
          payment_method: payment_method.trim().toLowerCase(),
          payment_status: normalizedStatus,
          total_amount: totalAmount,
          paid_at: normalizedStatus === 'pago' ? new Date().toISOString() : null
        }
      ])
      .select('*')
      .single();

    if (orderError) {
      return res.status(400).json({ error: orderError.message });
    }

    // 2. Inserir os itens na tabela order_items vinculados ao pedido
    const itemsWithOrderId = orderItemsPayload.map((item) => ({
      ...item,
      order_id: createdOrder.id
    }));

    const { data: insertedItems, error: itemsError } = await supabase
      .from('order_items')
      .insert(itemsWithOrderId)
      .select('*, products ( id, name, category_id )');

    if (itemsError) {
      return res.status(500).json({ error: itemsError.message });
    }

    // 3. Abater estoque APENAS para os produtos que possuem controle de estoque (stock_quantity !== null)
    for (const stockItem of stockUpdates) {
      const { error: stockUpdateError } = await supabase
        .from('products')
        .update({ stock_quantity: stockItem.newStock })
        .eq('id', stockItem.id);

      if (stockUpdateError) {
        return res.status(500).json({ error: stockUpdateError.message });
      }
    }

    return res.status(201).json({
      ...createdOrder,
      total_amount: Number(createdOrder.total_amount),
      order_items: (insertedItems || []).map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        subtotal: Number((Number(item.quantity) * Number(item.unit_price)).toFixed(2))
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao registrar pedido.', details: err.message });
  }
});

/**
 * PATCH /orders/:id/pay
 * Dá baixa em um pedido que estava com status "pendente", alterando para "pago".
 * Permite atualizar opcionalmente o payment_method caso o cliente pague com outra forma na hora da baixa.
 */
router.patch('/:id/pay', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId || Number.isNaN(orderId)) {
      return res.status(400).json({ error: 'ID do pedido inválido.' });
    }

    const { data: existingOrder, error: findError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (findError) {
      return res.status(500).json({ error: findError.message });
    }

    if (!existingOrder) {
      return res.status(404).json({ error: `Pedido #${orderId} não encontrado.` });
    }

    if (String(existingOrder.payment_status).toLowerCase() === 'pago') {
      return res.status(400).json({ error: `O Pedido #${orderId} já consta como pago.` });
    }

    const updatePayload = {
      payment_status: 'pago',
      paid_at: new Date().toISOString()
    };

    if (req.body && req.body.payment_method && String(req.body.payment_method).trim()) {
      updatePayload.payment_method = String(req.body.payment_method).trim().toLowerCase();
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', orderId)
      .select('*, order_items ( id, product_id, quantity, unit_price, products ( id, name, category_id ) )')
      .single();

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    return res.status(200).json({
      ...updatedOrder,
      total_amount: Number(updatedOrder.total_amount)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao dar baixa no pedido.', details: err.message });
  }
});

module.exports = router;
