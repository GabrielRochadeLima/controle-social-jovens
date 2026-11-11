const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

/**
 * GET /expenses
 * Lista as despesas extras de eventos.
 * Suporta filtro opcional ?event_id=X
 */
router.get('/', async (req, res) => {
  try {
    const { event_id } = req.query;

    let query = supabase
      .from('event_expenses')
      .select('*')
      .order('id', { ascending: false });

    if (event_id !== undefined && event_id !== '') {
      query = query.eq('event_id', Number(event_id));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const expenses = (data || []).map((exp) => ({
      ...exp,
      id: Number(exp.id),
      event_id: Number(exp.event_id),
      amount: Number(exp.amount)
    }));

    return res.status(200).json(expenses);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar despesas.', details: err.message });
  }
});

/**
 * POST /expenses
 * Cadastra uma despesa extra vinculada a um evento.
 */
router.post('/', async (req, res) => {
  try {
    const { event_id, description, amount } = req.body || {};

    if (!event_id || Number.isNaN(Number(event_id))) {
      return res.status(400).json({ error: 'O evento (event_id) é obrigatório e deve ser válido.' });
    }

    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'A descrição da despesa é obrigatória.' });
    }

    const numericAmount = Number(amount);
    if (amount === undefined || amount === null || amount === '' || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'O valor da despesa (amount) deve ser um número maior que zero.' });
    }

    const { data, error } = await supabase
      .from('event_expenses')
      .insert([
        {
          event_id: Number(event_id),
          description: description.trim(),
          amount: Number(numericAmount.toFixed(2))
        }
      ])
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      ...data,
      id: Number(data.id),
      event_id: Number(data.event_id),
      amount: Number(data.amount)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao cadastrar despesa.', details: err.message });
  }
});

/**
 * DELETE /expenses/:id
 * Remove uma despesa extra cadastrada.
 */
router.delete('/:id', async (req, res) => {
  try {
    const expenseId = Number(req.params.id);
    if (!expenseId || Number.isNaN(expenseId)) {
      return res.status(400).json({ error: 'ID da despesa inválido.' });
    }

    const { error } = await supabase
      .from('event_expenses')
      .delete()
      .eq('id', expenseId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ message: 'Despesa excluída com sucesso.', id: expenseId });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao excluir despesa.', details: err.message });
  }
});

module.exports = router;
