const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

const VALID_ROLES = ['admin', 'manager', 'seller'];

/**
 * GET /users
 * Lista usuários cadastrados para o seletor de login e gerenciamento.
 */
router.get('/', async (req, res) => {
  try {
    const { all } = req.query;

    let query = supabase
      .from('app_users')
      .select('id, name, role, active, created_at')
      .order('id', { ascending: true });

    if (all !== 'true') {
      query = query.eq('active', true);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const users = (data || []).map((u) => ({
      ...u,
      id: Number(u.id),
      active: Boolean(u.active)
    }));

    return res.status(200).json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar usuários.', details: err.message });
  }
});

/**
 * POST /users/login
 * Autentica o usuário pelo ID e PIN.
 */
router.post('/login', async (req, res) => {
  try {
    const { user_id, pin } = req.body || {};

    if (!user_id || Number.isNaN(Number(user_id))) {
      return res.status(400).json({ error: 'Selecione um usuário válido.' });
    }

    if (!pin || typeof pin !== 'string' || !pin.trim()) {
      return res.status(400).json({ error: 'Informe o PIN de acesso.' });
    }

    const { data: user, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('id', Number(user_id))
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!user || user.active === false) {
      return res.status(401).json({ error: 'Usuário não encontrado ou desativado.' });
    }

    if (String(user.pin).trim() !== String(pin).trim()) {
      return res.status(401).json({ error: 'PIN incorreto. Tente novamente.' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: Number(user.id),
        name: user.name,
        role: user.role
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno no login.', details: err.message });
  }
});

/**
 * POST /users
 * Cadastra um novo usuário / operador (exclusivo para administradores).
 */
router.post('/', async (req, res) => {
  try {
    const { name, pin, role } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'O nome do usuário é obrigatório.' });
    }

    if (!pin || typeof pin !== 'string' || pin.trim().length < 4 || pin.trim().length > 10) {
      return res.status(400).json({ error: 'O PIN deve conter entre 4 e 10 dígitos.' });
    }

    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!VALID_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: `Cargo inválido. Use um dos seguintes: ${VALID_ROLES.join(', ')}.` });
    }

    const { data, error } = await supabase
      .from('app_users')
      .insert([
        {
          name: name.trim(),
          pin: pin.trim(),
          role: normalizedRole,
          active: true
        }
      ])
      .select('id, name, role, active, created_at')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      ...data,
      id: Number(data.id),
      active: Boolean(data.active)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao criar usuário.', details: err.message });
  }
});

/**
 * PATCH /users/:id
 * Atualiza dados de um usuário (nome, cargo, PIN ou status ativo).
 */
router.patch('/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID do usuário inválido.' });
    }

    const { name, pin, role, active } = req.body || {};
    const updates = {};

    if (name !== undefined) {
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'O nome do usuário não pode ser vazio.' });
      }
      updates.name = name.trim();
    }

    if (pin !== undefined && pin !== null && String(pin).trim() !== '') {
      const pinStr = String(pin).trim();
      if (pinStr.length < 4 || pinStr.length > 10) {
        return res.status(400).json({ error: 'O PIN deve conter entre 4 e 10 dígitos.' });
      }
      updates.pin = pinStr;
    }

    if (role !== undefined) {
      const normalizedRole = String(role).trim().toLowerCase();
      if (!VALID_ROLES.includes(normalizedRole)) {
        return res.status(400).json({ error: `Cargo inválido. Use: ${VALID_ROLES.join(', ')}.` });
      }
      updates.role = normalizedRole;
    }

    if (active !== undefined) {
      updates.active = Boolean(active);
    }

    const { data, error } = await supabase
      .from('app_users')
      .update(updates)
      .eq('id', userId)
      .select('id, name, role, active, created_at')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({
      ...data,
      id: Number(data.id),
      active: Boolean(data.active)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao atualizar usuário.', details: err.message });
  }
});

/**
 * DELETE /users/:id
 * Remove ou desativa um usuário.
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID do usuário inválido.' });
    }

    const { error } = await supabase
      .from('app_users')
      .delete()
      .eq('id', userId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ message: 'Usuário removido com sucesso.', id: userId });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao remover usuário.', details: err.message });
  }
});

module.exports = router;
