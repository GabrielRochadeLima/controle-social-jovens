const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

const VALID_EVENT_STATUSES = ['agendado', 'aberto', 'encerrado'];

function normalizeCustomerKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function enrichEventMetrics(event, eventOrders = []) {
  const uniqueMap = new Map();
  let totalPaid = 0;
  let totalPending = 0;

  for (const order of eventOrders) {
    const key = normalizeCustomerKey(order.customer_name);
    if (key && !uniqueMap.has(key)) {
      uniqueMap.set(key, String(order.customer_name).trim());
    }
    const amt = Number(order.total_amount) || 0;
    const isPaid = String(order.payment_status).toLowerCase() === 'pago';
    const paidAmt = isPaid ? amt : Math.min(amt, Math.max(0, Number(order.paid_amount || 0)));
    const remAmt = Math.max(0, amt - paidAmt);
    totalPaid += paidAmt;
    totalPending += remAmt;
  }

  const uniqueBuyersCount = uniqueMap.size;
  const attendanceCount = Number(event.attendance_count || 0);
  const totalSales = Number((totalPaid + totalPending).toFixed(2));
  const adherenceRate =
    attendanceCount > 0 ? Number(((uniqueBuyersCount / attendanceCount) * 100).toFixed(1)) : null;
  const avgTicket =
    uniqueBuyersCount > 0 ? Number((totalSales / uniqueBuyersCount).toFixed(2)) : 0;

  return {
    ...event,
    attendance_count: attendanceCount,
    unique_buyers_count: uniqueBuyersCount,
    unique_buyers: Array.from(uniqueMap.values()),
    adherence_rate: adherenceRate,
    avg_ticket: avgTicket,
    orders_count: eventOrders.length,
    total_sales: totalSales,
    total_paid: Number(totalPaid.toFixed(2)),
    total_pending: Number(totalPending.toFixed(2))
  };
}

/**
 * GET /events
 * Lista todos os eventos ordenados por data/id com métricas de participação, adesão e vendas.
 */
router.get('/', async (req, res) => {
  try {
    const [{ data: events, error: evErr }, { data: orders, error: ordErr }] = await Promise.all([
      supabase.from('events').select('*').order('id', { ascending: false }),
      supabase.from('orders').select('*')
    ]);

    if (evErr) {
      return res.status(500).json({ error: evErr.message });
    }
    if (ordErr) {
      return res.status(500).json({ error: ordErr.message });
    }

    const allOrders = orders || [];
    const enriched = (events || []).map((ev) => {
      const evOrders = allOrders.filter((o) => Number(o.event_id) === Number(ev.id));
      return enrichEventMetrics(ev, evOrders);
    });

    return res.status(200).json(enriched);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao listar eventos.', details: err.message });
  }
});

/**
 * POST /events
 * Cria um novo evento/dia de social (name, event_date, attendance_count, status)
 */
router.post('/', async (req, res) => {
  try {
    const { name, event_date, attendance_count, status } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'O nome/tema do evento é obrigatório.' });
    }

    if (!event_date || typeof event_date !== 'string' || !event_date.trim()) {
      return res.status(400).json({ error: 'A data do evento (event_date) é obrigatória.' });
    }

    const normalizedStatus = status ? String(status).trim().toLowerCase() : 'agendado';
    if (!VALID_EVENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({ error: 'Status inválido. Use "agendado", "aberto" ou "encerrado".' });
    }

    const parsedAttendance =
      attendance_count === undefined || attendance_count === null || attendance_count === ''
        ? 0
        : Number(attendance_count);

    if (!Number.isInteger(parsedAttendance) || parsedAttendance < 0) {
      return res.status(400).json({ error: 'O número de presentes (attendance_count) deve ser um inteiro >= 0.' });
    }

    const { data, error } = await supabase
      .from('events')
      .insert([
        {
          name: name.trim(),
          event_date: event_date.trim(),
          status: normalizedStatus,
          attendance_count: parsedAttendance
        }
      ])
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json(enrichEventMetrics(data, []));
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao cadastrar evento.', details: err.message });
  }
});

/**
 * PATCH /events/:id e PUT /events/:id
 * Atualiza status ('agendado', 'aberto', 'encerrado'), attendance_count, name ou event_date.
 */
async function updateEventHandler(req, res) {
  try {
    const eventId = Number(req.params.id);
    if (!eventId || Number.isNaN(eventId)) {
      return res.status(400).json({ error: 'ID do evento inválido.' });
    }

    const { name, event_date, status, attendance_count } = req.body || {};
    const updatePayload = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: 'O nome do evento não pode ser vazio.' });
      }
      updatePayload.name = String(name).trim();
    }

    if (event_date !== undefined) {
      if (!String(event_date).trim()) {
        return res.status(400).json({ error: 'A data do evento não pode ser vazia.' });
      }
      updatePayload.event_date = String(event_date).trim();
    }

    if (status !== undefined) {
      const normalizedStatus = String(status).trim().toLowerCase();
      if (!VALID_EVENT_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({ error: 'Status inválido. Use "agendado", "aberto" ou "encerrado".' });
      }
      updatePayload.status = normalizedStatus;
    }

    if (attendance_count !== undefined && attendance_count !== null && attendance_count !== '') {
      const parsedAttendance = Number(attendance_count);
      if (!Number.isInteger(parsedAttendance) || parsedAttendance < 0) {
        return res.status(400).json({ error: 'O número de presentes (attendance_count) deve ser um inteiro >= 0.' });
      }
      updatePayload.attendance_count = parsedAttendance;
    }

    const { data: updatedEvent, error } = await supabase
      .from('events')
      .update(updatePayload)
      .eq('id', eventId)
      .select('*')
      .single();

    if (error) {
      const statusHttp = error.code === 'PGRST116' ? 404 : 400;
      return res.status(statusHttp).json({ error: error.message });
    }

    const { data: evOrders } = await supabase.from('orders').select('*').eq('event_id', eventId);

    return res.status(200).json(enrichEventMetrics(updatedEvent, evOrders || []));
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno ao atualizar evento.', details: err.message });
  }
}

router.patch('/:id', updateEventHandler);
router.put('/:id', updateEventHandler);

module.exports = router;
