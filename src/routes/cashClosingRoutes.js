const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

/**
 * GET /cash-closing
 * Relatório de Fechamento de Caixa:
 * - Soma o valor total recebido (apenas status = 'pago') agrupado por payment_method (Pix, Dinheiro, Cartão, etc.)
 * - Calcula o valor total pendente ("na rua" / fiado) somando os pedidos com status = 'pendente'
 * - Lista detalhadamente os pedidos pendentes para cobrança e controle
 */
router.get('/', async (req, res) => {
  try {
    const { event_id } = req.query;

    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, order_items ( id, product_id, quantity, unit_price, products ( id, name ) )')
      .order('id', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const allOrders = orders || [];
    const hasEventFilter = event_id !== undefined && event_id !== '' && event_id !== 'all';
    const filteredOrders = hasEventFilter
      ? allOrders.filter((o) => Number(o.event_id) === Number(event_id))
      : allOrders;

    let totalPaid = 0;
    let totalPending = 0;
    let paidCount = 0;
    let pendingCount = 0;
    const byPaymentMethod = {};
    const pendingOrders = [];
    const uniqueBuyersSet = new Set();

    for (const order of filteredOrders) {
      const amount = Number(order.total_amount) || 0;
      const status = String(order.payment_status || '').toLowerCase();
      const method = String(order.payment_method || 'outros').toLowerCase();
      const buyerKey = String(order.customer_name || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ');
      if (buyerKey) uniqueBuyersSet.add(buyerKey);

      if (status === 'pago') {
        totalPaid += amount;
        paidCount += 1;
        byPaymentMethod[method] = Number(((byPaymentMethod[method] || 0) + amount).toFixed(2));
      } else if (status === 'pendente') {
        totalPending += amount;
        pendingCount += 1;
        pendingOrders.push({
          id: order.id,
          event_id: order.event_id || null,
          customer_name: order.customer_name,
          payment_method: order.payment_method,
          payment_status: order.payment_status,
          total_amount: Number(amount.toFixed(2)),
          created_at: order.created_at,
          order_items: order.order_items || []
        });
      }
    }

    // Pendências de outros eventos (para alerta geral)
    const otherPendingOrders = hasEventFilter
      ? allOrders.filter(
          (o) =>
            String(o.payment_status || '').toLowerCase() === 'pendente' &&
            Number(o.event_id) !== Number(event_id)
        )
      : [];
    const otherPendingTotal = Number(
      otherPendingOrders.reduce((acc, o) => acc + (Number(o.total_amount) || 0), 0).toFixed(2)
    );

    totalPaid = Number(totalPaid.toFixed(2));
    totalPending = Number(totalPending.toFixed(2));
    const totalGeneral = Number((totalPaid + totalPending).toFixed(2));

    return res.status(200).json({
      summary: {
        total_paid: totalPaid,
        total_pending: totalPending,
        total_general: totalGeneral,
        paid_count: paidCount,
        pending_count: pendingCount,
        total_orders: filteredOrders.length,
        unique_buyers_count: uniqueBuyersSet.size
      },
      total_paid: totalPaid,
      by_payment_method: byPaymentMethod,
      total_pending: totalPending,
      paid_count: paidCount,
      pending_count: pendingCount,
      unique_buyers_count: uniqueBuyersSet.size,
      pending_orders: pendingOrders,
      other_events_pending_count: otherPendingOrders.length,
      other_events_pending_total: otherPendingTotal
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Erro interno ao gerar relatório de fechamento de caixa.',
      details: err.message
    });
  }
});

module.exports = router;
