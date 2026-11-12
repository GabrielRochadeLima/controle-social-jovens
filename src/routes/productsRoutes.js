const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

/**
 * GET /products
 * Lista todos os produtos com suas categorias.
 * Suporta filtro opcional ?category_id=1 e ?grouped=true
 */
router.get('/', async (req, res) => {
  try {
    const { category_id, grouped } = req.query;

    let query = supabase
      .from('products')
      .select('*, categories ( id, name )')
      .order('id', { ascending: true });

    if (category_id !== undefined && category_id !== '') {
      query = query.eq('category_id', Number(category_id));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const products = (data || []).map((p) => ({
      ...p,
      price: Number(p.price),
      cost_price: p.cost_price !== null && p.cost_price !== undefined ? Number(p.cost_price) : 0,
      stock_quantity: p.stock_quantity === null || p.stock_quantity === undefined ? null : Number(p.stock_quantity),
      has_stock_control: p.stock_quantity !== null && p.stock_quantity !== undefined,
      category_name: p.categories ? p.categories.name : null
    }));

    if (grouped === 'true') {
      const byCategory = {};
      for (const product of products) {
        const catName = product.category_name || 'Sem Categoria';
        if (!byCategory[catName]) {
          byCategory[catName] = [];
        }
        byCategory[catName].push(product);
      }
      return res.status(200).json(byCategory);
    }

    return res.status(200).json(products);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar produtos.', details: err.message });
  }
});

/**
 * POST /products
 * Cadastra um novo produto vinculado a uma categoria.
 * stock_quantity pode ser null/undefined (sem controle de estoque) ou inteiro >= 0.
 */
router.post('/', async (req, res) => {
  try {
    const { name, category_id, price, cost_price, stock_quantity } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'O nome do produto é obrigatório.' });
    }

    if (category_id === undefined || category_id === null || category_id === '' || Number.isNaN(Number(category_id))) {
      return res.status(400).json({ error: 'A categoria (category_id) é obrigatória e deve ser válida.' });
    }

    const numericPrice = Number(price);
    if (price === undefined || price === null || price === '' || Number.isNaN(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'O preço (price) deve ser um número maior ou igual a zero.' });
    }

    let numericCost = 0;
    if (cost_price !== undefined && cost_price !== null && cost_price !== '') {
      numericCost = Number(cost_price);
      if (Number.isNaN(numericCost) || numericCost < 0) {
        return res.status(400).json({ error: 'O preço de custo (cost_price) deve ser um número maior ou igual a zero.' });
      }
    }

    let parsedStock = null;
    if (stock_quantity !== null && stock_quantity !== undefined && stock_quantity !== '') {
      parsedStock = Number(stock_quantity);
      if (!Number.isInteger(parsedStock) || parsedStock < 0) {
        return res.status(400).json({
          error: 'A quantidade em estoque (stock_quantity) deve ser nula (sem controle) ou um número inteiro maior ou igual a zero.'
        });
      }
    }

    const { data, error } = await supabase
      .from('products')
      .insert([
        {
          name: name.trim(),
          category_id: Number(category_id),
          price: Number(numericPrice.toFixed(2)),
          cost_price: Number(numericCost.toFixed(2)),
          stock_quantity: parsedStock
        }
      ])
      .select('*, categories ( id, name )')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      ...data,
      price: Number(data.price),
      cost_price: Number(data.cost_price || 0),
      stock_quantity: data.stock_quantity === null || data.stock_quantity === undefined ? null : Number(data.stock_quantity),
      has_stock_control: data.stock_quantity !== null && data.stock_quantity !== undefined,
      category_name: data.categories ? data.categories.name : null
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao cadastrar produto.', details: err.message });
  }
});

/**
 * PUT /products/:id e PATCH /products/:id
 * Atualiza um produto cadastrado (nome, categoria, preço, custo e controle de estoque).
 */
async function updateProductHandler(req, res) {
  try {
    const productId = Number(req.params.id);
    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID do produto inválido.' });
    }

    const { name, category_id, price, cost_price, stock_quantity } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'O nome do produto é obrigatório.' });
    }

    if (category_id === undefined || category_id === null || category_id === '' || Number.isNaN(Number(category_id))) {
      return res.status(400).json({ error: 'A categoria (category_id) é obrigatória e deve ser válida.' });
    }

    const numericPrice = Number(price);
    if (price === undefined || price === null || price === '' || Number.isNaN(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'O preço (price) deve ser um número maior ou igual a zero.' });
    }

    let numericCost = 0;
    if (cost_price !== undefined && cost_price !== null && cost_price !== '') {
      numericCost = Number(cost_price);
      if (Number.isNaN(numericCost) || numericCost < 0) {
        return res.status(400).json({ error: 'O preço de custo (cost_price) deve ser um número maior ou igual a zero.' });
      }
    }

    let parsedStock = null;
    if (stock_quantity !== null && stock_quantity !== undefined && stock_quantity !== '') {
      parsedStock = Number(stock_quantity);
      if (!Number.isInteger(parsedStock) || parsedStock < 0) {
        return res.status(400).json({
          error: 'A quantidade em estoque (stock_quantity) deve ser nula (sem controle) ou um número inteiro maior ou igual a zero.'
        });
      }
    }

    const { data, error } = await supabase
      .from('products')
      .update({
        name: name.trim(),
        category_id: Number(category_id),
        price: Number(numericPrice.toFixed(2)),
        cost_price: Number(numericCost.toFixed(2)),
        stock_quantity: parsedStock
      })
      .eq('id', productId)
      .select('*, categories ( id, name )')
      .single();

    if (error) {
      const status = error.code === 'PGRST116' ? 404 : 400;
      return res.status(status).json({ error: error.message });
    }

    return res.status(200).json({
      ...data,
      price: Number(data.price),
      cost_price: Number(data.cost_price || 0),
      stock_quantity: data.stock_quantity === null || data.stock_quantity === undefined ? null : Number(data.stock_quantity),
      has_stock_control: data.stock_quantity !== null && data.stock_quantity !== undefined,
      category_name: data.categories ? data.categories.name : null
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao atualizar produto.', details: err.message });
  }
}

router.put('/:id', updateProductHandler);
router.patch('/:id', updateProductHandler);

/**
 * DELETE /products/:id
 * Exclui um produto do catálogo caso não possua vendas registradas.
 */
router.delete('/:id', async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID do produto inválido.' });
    }

    // Verificar se o produto possui pedidos vinculados
    const { data: items, error: countErr } = await supabase
      .from('order_items')
      .select('id')
      .eq('product_id', productId);

    if (!countErr && items && items.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir este produto pois ele possui ${items.length} venda(s) registrada(s) no histórico. Você pode zerar o estoque para que não seja vendido.`
      });
    }

    const { data, error } = await supabase
      .from('products')
      .delete()
      .eq('id', productId)
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === '23503' || String(error.message).includes('foreign key')) {
        return res.status(400).json({
          error: 'Não é possível excluir este produto pois ele possui histórico de pedidos.'
        });
      }
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    return res.status(200).json({ success: true, message: 'Produto excluído com sucesso.', product: data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao excluir produto.', details: err.message });
  }
});

module.exports = router;
