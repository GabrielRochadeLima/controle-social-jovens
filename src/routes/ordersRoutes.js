const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

const VALID_STATUSES = ['pago', 'pendente', 'parcial'];

function computeOrderFinancials(order) {
  const total = Number(order.total_amount) || 0;
  const status = String(order.payment_status || '').toLowerCase();
  const hasExplicitPaid = order.paid_amount !== undefined && order.paid_amount !== null;
  const rawPaid = hasExplicitPaid ? Number(order.paid_amount) : status === 'pago' ? total : 0;
  const paidAmount = status === 'pago' && (!hasExplicitPaid || rawPaid === 0)
    ? total
    : Number(Math.min(total, Math.max(0, rawPaid)).toFixed(2));
  const remainingAmount = Number(Math.max(0, total - paidAmount).toFixed(2));
  return {
    total_amount: Number(total.toFixed(2)),
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    is_partial: status === 'pendente' && paidAmount > 0 && remainingAmount > 0
  };
}

/**
 * GET /orders
 * Lista todos os pedidos (com seus itens e produtos), permitindo filtrar por ?payment_status=pendente|pago
 */
router.get('/', async (req, res) => {
  try {
    const { payment_status, event_id } = req.query;

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

    if (event_id !== undefined && event_id !== '' && event_id !== 'all') {
      query = query.eq('event_id', Number(event_id));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const formatted = (data || []).map((order) => {
      const fin = computeOrderFinancials(order);
      return {
        ...order,
        ...fin,
        order_items: (order.order_items || []).map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price),
          subtotal: Number((Number(item.quantity) * Number(item.unit_price)).toFixed(2))
        }))
      };
    });

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
    const { customer_name, payment_method, payment_status, items, event_id, paid_amount, created_by_name } = req.body || {};

    if (!customer_name || typeof customer_name !== 'string' || !customer_name.trim()) {
      return res.status(400).json({ error: 'O nome do cliente (customer_name) é obrigatório.' });
    }

    let parsedEventId = null;
    if (event_id !== undefined && event_id !== null && event_id !== '') {
      parsedEventId = Number(event_id);
      if (Number.isNaN(parsedEventId)) {
        return res.status(400).json({ error: 'ID do evento (event_id) inválido.' });
      }
      const { data: evData, error: evErr } = await supabase
        .from('events')
        .select('*')
        .eq('id', parsedEventId)
        .maybeSingle();

      if (!evErr && evData && String(evData.status).toLowerCase() !== 'aberto') {
        return res.status(400).json({
          error: `As vendas do evento "${evData.name}" não estão abertas (status atual: ${evData.status}). Inicie as vendas do evento primeiro.`
        });
      }
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

    // Calcular paid_amount inicial e status efetivo no banco ('pago' ou 'pendente')
    let initialPaidAmount = 0;
    let dbPaymentStatus = normalizedStatus === 'pago' ? 'pago' : 'pendente';

    if (normalizedStatus === 'pago') {
      initialPaidAmount = totalAmount;
    } else if (paid_amount !== undefined && paid_amount !== null && paid_amount !== '') {
      const parsedPaid = Number(paid_amount);
      if (Number.isNaN(parsedPaid) || parsedPaid < 0) {
        return res.status(400).json({ error: 'O valor pago inicialmente (paid_amount) deve ser >= 0.' });
      }
      if (parsedPaid > totalAmount) {
        return res.status(400).json({ error: `O valor pago (${parsedPaid}) não pode ser maior que o total do pedido (${totalAmount}).` });
      }
      initialPaidAmount = Number(parsedPaid.toFixed(2));
      if (initialPaidAmount >= totalAmount && totalAmount > 0) {
        dbPaymentStatus = 'pago';
        initialPaidAmount = totalAmount;
      } else {
        dbPaymentStatus = 'pendente';
      }
    }

    // 1. Inserir o Pedido na tabela orders
    const orderRowPayload = {
      customer_name: customer_name.trim(),
      payment_method: payment_method.trim().toLowerCase(),
      payment_status: dbPaymentStatus,
      total_amount: totalAmount,
      paid_amount: initialPaidAmount,
      created_by_name: created_by_name ? String(created_by_name).trim() : null,
      paid_at: dbPaymentStatus === 'pago' ? new Date().toISOString() : null
    };
    if (parsedEventId !== null) {
      orderRowPayload.event_id = parsedEventId;
    }

    const { data: createdOrder, error: orderError } = await supabase
      .from('orders')
      .insert([orderRowPayload])
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

    const fin = computeOrderFinancials({ ...createdOrder, paid_amount: initialPaidAmount });
    return res.status(201).json({
      ...createdOrder,
      ...fin,
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

    const currentFin = computeOrderFinancials(existingOrder);
    const rawAmount = req.body && req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
      ? Number(req.body.amount)
      : null;

    let newPaidAmount = currentFin.total_amount;
    let newStatus = 'pago';

    if (rawAmount !== null) {
      if (Number.isNaN(rawAmount) || rawAmount <= 0) {
        return res.status(400).json({ error: 'O valor do pagamento parcial (amount) deve ser maior que zero.' });
      }
      if (rawAmount > currentFin.remaining_amount + 0.001) {
        return res.status(400).json({
          error: `O valor informado (${rawAmount}) é maior que o saldo restante do pedido (${currentFin.remaining_amount}).`
        });
      }
      newPaidAmount = Number(Math.min(currentFin.total_amount, currentFin.paid_amount + rawAmount).toFixed(2));
      if (newPaidAmount >= currentFin.total_amount - 0.001) {
        newPaidAmount = currentFin.total_amount;
        newStatus = 'pago';
      } else {
        newStatus = 'pendente';
      }
    }

    const updatePayload = {
      payment_status: newStatus,
      paid_amount: newPaidAmount,
      paid_at: newStatus === 'pago' ? new Date().toISOString() : null
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

    const updatedFin = computeOrderFinancials(updatedOrder);
    return res.status(200).json({
      ...updatedOrder,
      ...updatedFin
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao dar baixa no pedido.', details: err.message });
  }
});

module.exports = router;
