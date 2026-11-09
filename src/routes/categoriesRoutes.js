const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

/**
 * GET /categories
 * Lista todas as categorias do schema "controle-social-jovens"
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data || []);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar categorias.', details: err.message });
  }
});

/**
 * POST /categories
 * Cadastra uma nova categoria (Ex: Lanches, Bebidas, Doces)
 */
router.post('/', async (req, res) => {
  try {
    const { name } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'O nome da categoria é obrigatório.' });
    }

    const cleanName = name.trim();

    const { data, error } = await supabase
      .from('categories')
      .insert([{ name: cleanName }])
      .select('*')
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 400;
      return res.status(status).json({ error: error.message });
    }

    return res.status(201).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao criar categoria.', details: err.message });
  }
});

module.exports = router;
