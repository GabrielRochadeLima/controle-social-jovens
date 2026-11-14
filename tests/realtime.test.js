process.env.NODE_ENV = 'test';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const app = require('../src/app');
const sseBroadcaster = require('../src/services/sseBroadcaster');
const {
  DB_SCHEMA,
  resetMockDb
} = require('../src/config/supabase');

/**
 * Utilitário de requisição HTTP in-process.
 * Executa requisições contra o Express sem abrir portas TCP locais (compatível com sandbox EACCES).
 */
function apiCall(path, options = {}) {
  return new Promise((resolve, reject) => {
    const method = (options.method || 'GET').toUpperCase();
    const rawBody = options.body ? Buffer.from(options.body, 'utf8') : Buffer.alloc(0);

    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      }
    });

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = path;
    req.headers = {
      host: '127.0.0.1',
      'content-type': 'application/json',
      'content-length': String(rawBody.length),
      ...Object.fromEntries(
        Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
      )
    };

    const res = new http.ServerResponse(req);
    const chunks = [];

    res.write = function (chunk, encoding, callback) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = function (chunk, encoding, callback) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === 'function') callback();

      const fullBuffer = Buffer.concat(chunks);
      const text = fullBuffer.toString('utf8');
      const contentType = String(res.getHeader('content-type') || '');
      let parsedBody = text;
      if (contentType.includes('application/json') && text) {
        try {
          parsedBody = JSON.parse(text);
        } catch (_e) {
          parsedBody = text;
        }
      }
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: parsedBody });
      return this;
    };

    app.handle(req, res, reject);

    process.nextTick(() => {
      if (rawBody.length > 0) req.push(rawBody);
      req.push(null);
    });
  });
}

/**
 * Utilitário para conectar cliente SSE in-process.
 * Captura todos os chunks, comentários (ex: : connected, : ping) e mensagens JSON emitidas pelo servidor.
 */
function openSseSubscriber(path = '/orders/realtime/stream', options = {}) {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });

  const req = new http.IncomingMessage(socket);
  req.method = 'GET';
  req.url = path;
  req.headers = {
    host: '127.0.0.1',
    'content-length': '0',
    ...Object.fromEntries(
      Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
  };

  const res = new http.ServerResponse(req);
  const chunks = [];
  const events = [];
  let closed = false;

  res.write = function (chunk, encoding, callback) {
    if (chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      chunks.push(text);

      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(':')) {
          events.push({ isComment: true, comment: trimmed, raw: text });
        } else if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          try {
            const data = JSON.parse(jsonStr);
            events.push({ isComment: false, data, raw: text });
          } catch (e) {
            events.push({ isComment: false, raw: text, error: e.message });
          }
        }
      }
    }
    if (typeof callback === 'function') callback();
    return true;
  };

  app.handle(req, res);
  req.push(null);

  return {
    req,
    res,
    socket,
    chunks,
    events,
    getMessages: () => events.filter((e) => !e.isComment).map((e) => e.data),
    getComments: () => events.filter((e) => e.isComment).map((e) => e.comment),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        req.emit('close');
      } catch (_) {}
      try {
        res.emit('close');
      } catch (_) {}
      try {
        if (!res.writableEnded && typeof res.end === 'function') {
          res.end();
        }
      } catch (_) {}
      try {
        socket.destroy();
      } catch (_) {}
    }
  };
}

/**
 * Utilitários puros do Frontend espelhados de src/views/index.ejs para validação do Tier 3
 */
function createRealtimeEventDeduplicator() {
  const recentMap = new Map();
  return function isDuplicateRealtimeEvent(eventOrId) {
    if (!eventOrId) return false;
    let key;
    if (typeof eventOrId === 'string' || typeof eventOrId === 'number') {
      key = String(eventOrId);
    } else {
      const event = eventOrId;
      const order = event.order || {};
      const orderId = event.order_id || order.id || '';
      if (!orderId && !event.type) return false;
      const ts = event.timestamp ? Math.floor(event.timestamp / 2000) : Math.floor(Date.now() / 2000);
      key = `${event.type || 'evt'}_${orderId}_${ts}`;
    }
    const now = Date.now();
    for (const [k, time] of recentMap.entries()) {
      if (now - time > 10000) recentMap.delete(k);
    }
    if (recentMap.has(key)) return true;
    recentMap.set(key, now);
    return false;
  };
}

function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatRealtimeToastMessage(event) {
  if (!event || !event.type) return null;
  const order = event.order || {};
  const orderId = event.order_id || order.id || '?';
  const rawCustomer = order.customer_name ? String(order.customer_name).trim() : '';
  const isAnonymous = !rawCustomer || /^an[oô]nimo$/i.test(rawCustomer) || /^balc[aã]o$/i.test(rawCustomer);
  const clientTag = isAnonymous ? '' : ` (${rawCustomer})`;

  switch (event.type) {
    case 'order_created': {
      const totalStr = fmtBRL(order.total_amount || 0);
      return `🔔 Novo pedido #${orderId}${clientTag} registrado: ${totalStr}`;
    }
    case 'order_paid': {
      const isSettled = (order.payment_status === 'pago') || (Number(order.remaining_amount || 0) <= 0);
      const statusText = isSettled
        ? 'quitado'
        : `baixa de ${fmtBRL(order.paid_amount || 0)}`;
      return `💰 Pedido #${orderId}${clientTag} atualizado: ${statusText}`;
    }
    case 'order_updated': {
      return `✏️ Pedido #${orderId}${clientTag} modificado`;
    }
    case 'order_deleted': {
      return `🗑️ Pedido #${orderId}${clientTag} cancelado`;
    }
    default:
      return null;
  }
}

describe('Suíte Real-Time - Controle Social Jovens (SSE e Sincronização Multi-Dispositivo)', () => {
  before(async () => {
    resetMockDb(true);
    sseBroadcaster.reset();
  });

  after(async () => {
    sseBroadcaster.reset();
  });

  afterEach(() => {
    sseBroadcaster.reset();
  });

  // ==========================================================================
  // TIER 1: FEATURE COVERAGE (>=5 test cases per feature: F1 - F5)
  // ==========================================================================

  describe('Tier 1: Feature Coverage (F1 a F5)', () => {
    // ------------------------------------------------------------------------
    // F1: SSE endpoint connection & stream lifecycle
    // ------------------------------------------------------------------------
    test('F1.1: GET /orders/realtime/stream estabelece SSE com status 200, headers corretos e handshake : connected', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=pos_terminal_1');
      await new Promise((r) => setImmediate(r));

      assert.equal(sub.res.statusCode, 200);
      assert.equal(sub.res.getHeader('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(sub.res.getHeader('cache-control'), 'no-cache, no-transform');
      assert.equal(sub.res.getHeader('connection'), 'keep-alive');
      assert.equal(sub.res.getHeader('x-accel-buffering'), 'no');
      assert.equal(sub.res.getHeader('access-control-allow-origin'), '*');

      const comments = sub.getComments();
      assert.ok(comments.length >= 1, 'Deve receber ao menos 1 comentário de handshake');
      assert.equal(comments[0], ': connected client_id=pos_terminal_1');
      assert.equal(sseBroadcaster.getSubscribersCount(), 1);

      sub.close();
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);
    });

    test('F1.2: GET /orders/stream (alias) opera de maneira idêntica com headers e handshake', async () => {
      const sub = openSseSubscriber('/orders/stream?client_id=alias_terminal_2');
      await new Promise((r) => setImmediate(r));

      assert.equal(sub.res.statusCode, 200);
      assert.equal(sub.res.getHeader('content-type'), 'text/event-stream; charset=utf-8');
      const comments = sub.getComments();
      assert.equal(comments[0], ': connected client_id=alias_terminal_2');
      assert.equal(sseBroadcaster.getSubscribersCount(), 1);

      sub.close();
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);
    });

    test('F1.3: Envio de heartbeat ping (: ping) é transmitido para todos os assinantes ativos', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=ping_client');
      await new Promise((r) => setImmediate(r));

      sseBroadcaster.broadcastPing();
      const comments = sub.getComments();
      assert.ok(comments.includes(': ping'), 'Deve conter o comentário : ping transmitido pelo heartbeat');

      sub.close();
    });

    test('F1.4: Resolução de client_id anônimo quando nenhum parâmetro é enviado', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream');
      await new Promise((r) => setImmediate(r));

      const comments = sub.getComments();
      assert.equal(comments[0], ': connected client_id=anonymous');

      sub.close();
    });

    test('F1.5: Resolução de client_id via cabeçalho HTTP X-Client-Id', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream', {
        headers: { 'X-Client-Id': 'header_pos_99' }
      });
      await new Promise((r) => setImmediate(r));

      const comments = sub.getComments();
      assert.equal(comments[0], ': connected client_id=header_pos_99');

      sub.close();
    });

    // ------------------------------------------------------------------------
    // F2: POST /orders broadcasts order_created
    // ------------------------------------------------------------------------
    test('F2.1: POST /orders transmite order_created com pedido completo, itens e financeiro', async () => {
      resetMockDb(true);
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=subscriber_pos');
      await new Promise((r) => setImmediate(r));

      const res = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'acting_cashier_1' },
        body: JSON.stringify({
          customer_name: 'Guilherme Silva',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [
            { product_id: 1, quantity: 2 }, // 2x Cachorro-Quente (12.00) = 24.00
            { product_id: 3, quantity: 1 }  // 1x Refrigerante (6.00) = 6.00
          ]
        })
      });

      assert.equal(res.status, 201);
      const messages = sub.getMessages();
      assert.equal(messages.length, 1);
      const evt = messages[0];

      assert.equal(evt.type, 'order_created');
      assert.equal(evt.client_id, 'acting_cashier_1');
      assert.ok(evt.timestamp > 0);
      assert.equal(evt.order.id, res.body.id);
      assert.equal(evt.order.customer_name, 'Guilherme Silva');
      assert.equal(evt.order.total_amount, 30.0);
      assert.equal(evt.order.paid_amount, 30.0);
      assert.equal(evt.order.remaining_amount, 0.0);
      assert.equal(evt.order.is_partial, false);
      assert.equal(evt.order.order_items.length, 2);

      sub.close();
    });

    test('F2.2: POST /orders com status pendente transmite order_created com paid_amount 0 e saldo restante', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_pos');
      await new Promise((r) => setImmediate(r));

      const res = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'cashier_street' },
        body: JSON.stringify({
          customer_name: 'Felipe Pendente',
          payment_method: 'dinheiro',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }]
        })
      });

      assert.equal(res.status, 201);
      const messages = sub.getMessages();
      const evt = messages[messages.length - 1];

      assert.equal(evt.type, 'order_created');
      assert.equal(evt.order.payment_status, 'pendente');
      assert.equal(evt.order.total_amount, 12.0);
      assert.equal(evt.order.paid_amount, 0.0);
      assert.equal(evt.order.remaining_amount, 12.0);
      assert.equal(evt.order.paid_at, null);

      sub.close();
    });

    test('F2.3: POST /orders com pagamento parcial transmite order_created com is_partial: true', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_pos');
      await new Promise((r) => setImmediate(r));

      const res = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'pos_entry' },
        body: JSON.stringify({
          customer_name: 'Beatriz Parcial',
          payment_method: 'pix',
          payment_status: 'parcial',
          paid_amount: 5.0,
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }] // Total 12.00, pago 5.00, restam 7.00
        })
      });

      assert.equal(res.status, 201);
      const messages = sub.getMessages();
      const evt = messages[messages.length - 1];

      assert.equal(evt.type, 'order_created');
      assert.equal(evt.order.is_partial, true);
      assert.equal(evt.order.paid_amount, 5.0);
      assert.equal(evt.order.remaining_amount, 7.0);

      sub.close();
    });

    test('F2.4: POST /orders transmite seller responsável (created_by_name) no payload', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_pos');
      await new Promise((r) => setImmediate(r));

      const res = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'pos_caixa1' },
        body: JSON.stringify({
          customer_name: 'Camila Teste',
          payment_method: 'pix',
          payment_status: 'pago',
          created_by_name: 'Caixa 1',
          event_id: 1,
          items: [{ product_id: 4, quantity: 2 }]
        })
      });

      assert.equal(res.status, 201);
      const messages = sub.getMessages();
      const evt = messages[messages.length - 1];

      assert.equal(evt.order.created_by_name, 'Caixa 1');

      sub.close();
    });

    test('F2.5: POST /orders com client_id no corpo da requisição é repassado no evento SSE', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_pos');
      await new Promise((r) => setImmediate(r));

      const res = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          client_id: 'body_client_777',
          customer_name: 'Roberta Corpo',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 4, quantity: 1 }]
        })
      });

      assert.equal(res.status, 201);
      const messages = sub.getMessages();
      const evt = messages[messages.length - 1];
      assert.equal(evt.client_id, 'body_client_777');

      sub.close();
    });

    // ------------------------------------------------------------------------
    // F3: PATCH /orders/:id/pay broadcasts order_paid
    // ------------------------------------------------------------------------
    test('F3.1: PATCH /orders/:id/pay com quitação integral transmite order_paid com payment_status: pago', async () => {
      // Criar pedido pendente
      const ordRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Daniel Quitação',
          payment_method: 'pix',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }] // R$ 12.00
        })
      });
      const orderId = ordRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=listener_pay');
      await new Promise((r) => setImmediate(r));

      const payRes = await apiCall(`/orders/${orderId}/pay`, {
        method: 'PATCH',
        headers: { 'X-Client-Id': 'pos_cashier_2' },
        body: JSON.stringify({ payment_method: 'dinheiro' })
      });

      assert.equal(payRes.status, 200);
      assert.equal(payRes.body.payment_status, 'pago');
      assert.equal(payRes.body.remaining_amount, 0);

      const messages = sub.getMessages();
      assert.equal(messages.length, 1);
      const evt = messages[0];

      assert.equal(evt.type, 'order_paid');
      assert.equal(evt.client_id, 'pos_cashier_2');
      assert.equal(evt.order.id, orderId);
      assert.equal(evt.order.payment_status, 'pago');
      assert.equal(evt.order.paid_amount, 12.0);
      assert.equal(evt.order.remaining_amount, 0.0);
      assert.ok(evt.order.paid_at);

      sub.close();
    });

    test('F3.2: PATCH /orders/:id/pay com baixa parcial transmite order_paid com saldo restante atualizado', async () => {
      const ordRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Eduardo Parcial',
          payment_method: 'pix',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 1, quantity: 2 }] // R$ 24.00
        })
      });
      const orderId = ordRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=listener_pay');
      await new Promise((r) => setImmediate(r));

      // Pagar R$ 10.00
      const payRes = await apiCall(`/orders/${orderId}/pay`, {
        method: 'PATCH',
        headers: { 'X-Client-Id': 'pos_cashier_3' },
        body: JSON.stringify({ amount: 10.0 })
      });

      assert.equal(payRes.status, 200);
      const messages = sub.getMessages();
      const evt = messages[messages.length - 1];

      assert.equal(evt.type, 'order_paid');
      assert.equal(evt.order.paid_amount, 10.0);
      assert.equal(evt.order.remaining_amount, 14.0);
      assert.equal(evt.order.payment_status, 'pendente');

      sub.close();
    });

    test('F3.3: PATCH /orders/:id/pay atualiza payment_method e transmite no evento', async () => {
      const ordRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Helena Forma',
          payment_method: 'dinheiro',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 3, quantity: 1 }] // R$ 6.00
        })
      });
      const orderId = ordRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=listener_pay');
      await new Promise((r) => setImmediate(r));

      const payRes = await apiCall(`/orders/${orderId}/pay`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_method: 'cartao_credito' })
      });

      assert.equal(payRes.status, 200);
      assert.equal(payRes.body.payment_method, 'cartao_credito');

      const messages = sub.getMessages();
      assert.equal(messages[messages.length - 1].order.payment_method, 'cartao_credito');

      sub.close();
    });

    test('F3.4: Baixas parciais sucessivas até quitação total geram eventos progressivos consistentes', async () => {
      const ordRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Joao Parcelado',
          payment_method: 'pix',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 1, quantity: 2 }] // R$ 24.00
        })
      });
      const orderId = ordRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_multi_pay');
      await new Promise((r) => setImmediate(r));

      // Parcela 1: R$ 8.00 (restam R$ 16.00)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 8.0 }) });
      // Parcela 2: R$ 8.00 (restam R$ 8.00)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 8.0 }) });
      // Parcela 3: R$ 8.00 (restam R$ 0.00 -> quitado)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 8.0 }) });

      const messages = sub.getMessages();
      assert.equal(messages.length, 3);
      assert.equal(messages[0].order.remaining_amount, 16.0);
      assert.equal(messages[0].order.payment_status, 'pendente');
      assert.equal(messages[1].order.remaining_amount, 8.0);
      assert.equal(messages[1].order.payment_status, 'pendente');
      assert.equal(messages[2].order.remaining_amount, 0.0);
      assert.equal(messages[2].order.payment_status, 'pago');

      sub.close();
    });

    test('F3.5: Tentativa de pagar pedido já quitado retorna 400 e não emite evento SSE', async () => {
      const ordRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Igor Quitado',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 1 }]
        })
      });
      const orderId = ordRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_guard');
      await new Promise((r) => setImmediate(r));

      const badPay = await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH' });
      assert.equal(badPay.status, 400);

      const messages = sub.getMessages();
      assert.equal(messages.length, 0, 'Nenhum evento deve ser emitido quando a requisição falha');

      sub.close();
    });

    // ------------------------------------------------------------------------
    // F4: PUT /orders/:id broadcasts order_updated
    // ------------------------------------------------------------------------
    test('F4.1: PUT /orders/:id transmite order_updated ao alterar cliente e itens', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Original',
          payment_method: 'dinheiro',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }] // R$ 12.00
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_edit');
      await new Promise((r) => setImmediate(r));

      const updateRes = await apiCall(`/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'X-Client-Id': 'editor_terminal' },
        body: JSON.stringify({
          customer_name: 'Cliente Atualizado',
          payment_method: 'pix',
          payment_status: 'pago',
          items: [{ product_id: 1, quantity: 2 }] // R$ 24.00
        })
      });

      assert.equal(updateRes.status, 200);
      assert.equal(updateRes.body.customer_name, 'Cliente Atualizado');
      assert.equal(updateRes.body.total_amount, 24.0);

      const messages = sub.getMessages();
      assert.equal(messages.length, 1);
      const evt = messages[0];

      assert.equal(evt.type, 'order_updated');
      assert.equal(evt.client_id, 'editor_terminal');
      assert.equal(evt.order.id, orderId);
      assert.equal(evt.order.customer_name, 'Cliente Atualizado');
      assert.equal(evt.order.total_amount, 24.0);

      sub.close();
    });

    test('F4.2: PUT /orders/:id ao reduzir quantidade de itens restorna estoque e transmite evento', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Reduz',
          payment_method: 'dinheiro',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 5 }] // Refrigerante: estoque cai 5 un
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_edit');
      await new Promise((r) => setImmediate(r));

      const updateRes = await apiCall(`/orders/${orderId}`, {
        method: 'PUT',
        body: JSON.stringify({
          items: [{ product_id: 3, quantity: 2 }] // Deve devolver 3 un ao estoque
        })
      });

      assert.equal(updateRes.status, 200);
      assert.equal(updateRes.body.total_amount, 12.0);

      const messages = sub.getMessages();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'order_updated');
      assert.equal(messages[0].order.total_amount, 12.0);

      sub.close();
    });

    test('F4.3: PUT /orders/:id preserva campos não informados e atualiza financeiro', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Preserva',
          payment_method: 'dinheiro',
          payment_status: 'pendente',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }]
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_edit');
      await new Promise((r) => setImmediate(r));

      // Altera apenas o nome do cliente
      const updateRes = await apiCall(`/orders/${orderId}`, {
        method: 'PUT',
        body: JSON.stringify({
          customer_name: 'Cliente Nome Modificado'
        })
      });

      assert.equal(updateRes.status, 200);
      assert.equal(updateRes.body.customer_name, 'Cliente Nome Modificado');
      assert.equal(updateRes.body.payment_method, 'dinheiro');
      assert.equal(updateRes.body.payment_status, 'pendente');

      const messages = sub.getMessages();
      assert.equal(messages[0].order.customer_name, 'Cliente Nome Modificado');

      sub.close();
    });

    test('F4.4: PUT /orders/:id com erro de estoque insuficiente retorna 400 e emite zero eventos', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Teste Estoque',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 1 }]
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_edit');
      await new Promise((r) => setImmediate(r));

      const badUpdate = await apiCall(`/orders/${orderId}`, {
        method: 'PUT',
        body: JSON.stringify({
          items: [{ product_id: 3, quantity: 9999 }]
        })
      });

      assert.equal(badUpdate.status, 400);
      assert.equal(sub.getMessages().length, 0);

      sub.close();
    });

    test('F4.5: PUT /orders/:id com ID inexistente retorna 404 e emite zero eventos', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_edit');
      await new Promise((r) => setImmediate(r));

      const notFound = await apiCall('/orders/999999', {
        method: 'PUT',
        body: JSON.stringify({ customer_name: 'Fantasma' })
      });

      assert.equal(notFound.status, 404);
      assert.equal(sub.getMessages().length, 0);

      sub.close();
    });

    // ------------------------------------------------------------------------
    // F5: DELETE /orders/:id broadcasts order_deleted
    // ------------------------------------------------------------------------
    test('F5.1: DELETE /orders/:id transmite order_deleted com order_id, event_id e itens estornados', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Cancelar',
          payment_method: 'dinheiro',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 2 }] // 2x Refrigerante
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_delete');
      await new Promise((r) => setImmediate(r));

      const delRes = await apiCall(`/orders/${orderId}`, {
        method: 'DELETE',
        headers: { 'X-Client-Id': 'pos_canceller' }
      });

      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.success, true);

      const messages = sub.getMessages();
      assert.equal(messages.length, 1);
      const evt = messages[0];

      assert.equal(evt.type, 'order_deleted');
      assert.equal(evt.order_id, orderId);
      assert.equal(evt.event_id, 1);
      assert.equal(evt.client_id, 'pos_canceller');
      assert.ok(Array.isArray(evt.order.restored_items));
      assert.equal(evt.order.restored_items[0].product_id, 3);
      assert.equal(evt.order.restored_items[0].quantity, 2);

      sub.close();
    });

    test('F5.2: DELETE /orders/:id estorna efetivamente o estoque dos produtos controlados', async () => {
      const prodsBefore = await apiCall('/products');
      const refriBefore = prodsBefore.body.find((p) => p.id === 3).stock_quantity;

      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Prova Estoque',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 4 }]
        })
      });
      const orderId = createRes.body.id;

      const prodsMid = await apiCall('/products');
      assert.equal(prodsMid.body.find((p) => p.id === 3).stock_quantity, refriBefore - 4);

      await apiCall(`/orders/${orderId}`, { method: 'DELETE' });

      const prodsAfter = await apiCall('/products');
      assert.equal(prodsAfter.body.find((p) => p.id === 3).stock_quantity, refriBefore);
    });

    test('F5.3: DELETE /orders/:id com ID inexistente retorna 404 e não emite order_deleted', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_delete');
      await new Promise((r) => setImmediate(r));

      const delNotFound = await apiCall('/orders/88888', { method: 'DELETE' });
      assert.equal(delNotFound.status, 404);
      assert.equal(sub.getMessages().length, 0);

      sub.close();
    });

    test('F5.4: DELETE /orders/:id com ID inválido retorna 400 e não emite order_deleted', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_delete');
      await new Promise((r) => setImmediate(r));

      const delBadId = await apiCall('/orders/invalid_id', { method: 'DELETE' });
      assert.equal(delBadId.status, 400);
      assert.equal(sub.getMessages().length, 0);

      sub.close();
    });

    test('F5.5: DELETE /orders/:id transmite client_id da query caso não haja header', async () => {
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Query Delete',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }]
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_delete');
      await new Promise((r) => setImmediate(r));

      await apiCall(`/orders/${orderId}?client_id=query_canceller_44`, { method: 'DELETE' });

      const messages = sub.getMessages();
      assert.equal(messages[0].client_id, 'query_canceller_44');

      sub.close();
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 test cases)
  // ==========================================================================

  describe('Tier 2: Boundary & Corner Cases', () => {
    test('T2.1: Múltiplos assinantes concorrentes recebem transmissões simultaneamente e na mesma ordem', async () => {
      const clients = [
        openSseSubscriber('/orders/realtime/stream?client_id=sub_concurrent_1'),
        openSseSubscriber('/orders/realtime/stream?client_id=sub_concurrent_2'),
        openSseSubscriber('/orders/realtime/stream?client_id=sub_concurrent_3'),
        openSseSubscriber('/orders/realtime/stream?client_id=sub_concurrent_4'),
        openSseSubscriber('/orders/realtime/stream?client_id=sub_concurrent_5')
      ];
      await new Promise((r) => setImmediate(r));

      assert.equal(sseBroadcaster.getSubscribersCount(), 5);

      // Transmissão de 3 eventos em sequência
      sseBroadcaster.broadcast('order_created', { id: 101, total_amount: 15.0 }, 'pos_1');
      sseBroadcaster.broadcast('order_paid', { id: 101, paid_amount: 15.0 }, 'pos_2');
      sseBroadcaster.broadcast('order_deleted', { order_id: 101 }, 'pos_3');

      for (const client of clients) {
        const msgs = client.getMessages();
        assert.equal(msgs.length, 3, 'Cada assinante concorrente deve receber exatamente 3 mensagens');
        assert.equal(msgs[0].type, 'order_created');
        assert.equal(msgs[1].type, 'order_paid');
        assert.equal(msgs[2].type, 'order_deleted');
        client.close();
      }

      assert.equal(sseBroadcaster.getSubscribersCount(), 0);
    });

    test('T2.2: Desconexão abrupta do cliente via req.emit("close") remove o assinante sem erro no servidor', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_abrupt');
      await new Promise((r) => setImmediate(r));

      assert.equal(sseBroadcaster.getSubscribersCount(), 1);

      // Simular fechamento repentino do socket pelo cliente
      sub.req.emit('close');
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);

      // Transmissão pós-fechamento não deve disparar exceção
      assert.doesNotThrow(() => {
        sseBroadcaster.broadcast('order_created', { id: 202 });
      });

      sub.close();
    });

    test('T2.3: Transmissão sem assinantes conectados executa silenciosamente e retorna payload formatado', () => {
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);

      const payload = sseBroadcaster.broadcast('order_created', { id: 303, customer_name: 'Vazio' }, 'origin_no_sub');
      assert.ok(payload);
      assert.equal(payload.type, 'order_created');
      assert.equal(payload.client_id, 'origin_no_sub');
      assert.equal(payload.order.id, 303);
    });

    test('T2.4: Transições de liquidação incremental e quitação final calculam remaining_amount com precisão', async () => {
      // Criar pedido de R$ 50.00 com entrada de R$ 10.00
      const createRes = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: 'Cliente Fracionado',
          payment_method: 'pix',
          payment_status: 'parcial',
          paid_amount: 10.0,
          event_id: 1,
          items: [
            { product_id: 1, quantity: 4 }, // 48.00
            { product_id: 3, quantity: 1 }  // 6.00 -> total 54.00, pago 10.00, restam 44.00
          ]
        })
      });
      const orderId = createRes.body.id;

      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_fractions');
      await new Promise((r) => setImmediate(r));

      // Abatimento 1: R$ 14.00 (restam R$ 30.00)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 14.0 }) });
      // Abatimento 2: R$ 20.00 (restam R$ 10.00)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 20.0 }) });
      // Abatimento 3 (Quitação Final): R$ 10.00 (restam R$ 0.00)
      await apiCall(`/orders/${orderId}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: 10.0 }) });

      const msgs = sub.getMessages();
      assert.equal(msgs.length, 3);
      assert.equal(msgs[0].order.remaining_amount, 30.0);
      assert.equal(msgs[1].order.remaining_amount, 10.0);
      assert.equal(msgs[2].order.remaining_amount, 0.0);
      assert.equal(msgs[2].order.payment_status, 'pago');

      sub.close();
    });

    test('T2.5: Erros de validação (quantidades negativas, cliente vazio, valor pago inválido) retornam 400 e emitem ZERO eventos', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_leak_guard');
      await new Promise((r) => setImmediate(r));

      // Caso 1: Nome vazio
      const e1 = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_name: '', payment_method: 'pix', payment_status: 'pago', items: [{ product_id: 1, quantity: 1 }] })
      });
      assert.equal(e1.status, 400);

      // Caso 2: Itens vazios
      const e2 = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_name: 'Teste', payment_method: 'pix', payment_status: 'pago', items: [] })
      });
      assert.equal(e2.status, 400);

      // Caso 3: Quantidade inválida <= 0
      const e3 = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_name: 'Teste', payment_method: 'pix', payment_status: 'pago', items: [{ product_id: 1, quantity: -5 }] })
      });
      assert.equal(e3.status, 400);

      // Caso 4: Valor pago maior que total
      const e4 = await apiCall('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_name: 'Teste', payment_method: 'pix', payment_status: 'pendente', paid_amount: 9999, items: [{ product_id: 1, quantity: 1 }] })
      });
      assert.equal(e4.status, 400);

      // Nenhum evento deve ter sido transmitido
      assert.equal(sub.getMessages().length, 0);

      sub.close();
    });

    test('T2.6: Broadcaster detecta clientes mortos (writableEnded) durante o loop e os remove com segurança', () => {
      let writeAttempts = 0;
      const fakeRes = {
        writableEnded: true,
        writable: false,
        write() {
          writeAttempts++;
        },
        end() {}
      };
      const fakeClient = sseBroadcaster.addClient({}, fakeRes, 'dead_client');
      writeAttempts = 0; // Reseta contador após handshake inicial para medir estritamente a tentativa de broadcast
      assert.equal(sseBroadcaster.getSubscribersCount(), 1);

      // Broadcast deve detectar que fakeRes já encerrou e expulsá-lo sem chamar res.write
      sseBroadcaster.broadcast('test_event', { ok: true });
      assert.equal(writeAttempts, 0);
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);
    });

    test('T2.7: SseBroadcaster reset() encerra todos os clientes e interrompe o timer de heartbeat', async () => {
      const sub1 = openSseSubscriber('/orders/realtime/stream?client_id=sub_reset_1');
      const sub2 = openSseSubscriber('/orders/realtime/stream?client_id=sub_reset_2');
      await new Promise((r) => setImmediate(r));

      assert.equal(sseBroadcaster.getSubscribersCount(), 2);
      assert.ok(sseBroadcaster.heartbeatTimer !== null);

      sseBroadcaster.reset();
      assert.equal(sseBroadcaster.getSubscribersCount(), 0);
      assert.equal(sseBroadcaster.heartbeatTimer, null);

      sub1.close();
      sub2.close();
    });

    test('T2.8: PUT /orders/:id com produto inexistente retorna 404, preserva itens originais no banco e emite ZERO eventos SSE', async () => {
      // 1. Criar pedido inicial válido com 1 item (product_id: 1, quantidade: 2)
      const createRes = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'pos_creator_t28' },
        body: JSON.stringify({
          customer_name: 'Cliente Teste Integridade T2.8',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 1, quantity: 2 }]
        })
      });
      assert.equal(createRes.status, 201);
      const orderId = createRes.body.id;

      // 2. Conectar assinante SSE para monitorar se algum evento espúrio vaza
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_guard_t28');
      await new Promise((r) => setImmediate(r));

      try {
        // 3. Tentar atualizar o pedido com ID de produto inexistente (999999)
        const putRes = await apiCall(`/orders/${orderId}`, {
          method: 'PUT',
          headers: { 'X-Client-Id': 'pos_editor_t28' },
          body: JSON.stringify({
            items: [{ product_id: 999999, quantity: 1 }]
          })
        });

        // Assertiva 1: Deve retornar 404 e mensagem de erro específica
        assert.equal(putRes.status, 404);
        assert.match(putRes.body.error, /não encontrado/i);

        // Assertiva 2: Banco de dados NÃO pode ter itens corrompidos/deletados
        const listRes = await apiCall('/orders');
        const orderInDb = listRes.body.find((o) => o.id === orderId);
        assert.ok(orderInDb, 'Pedido original deve continuar existindo');
        assert.equal(orderInDb.order_items.length, 1, 'Itens do pedido devem permanecer intactos (não deletados)');
        assert.equal(orderInDb.order_items[0].product_id, 1);
        assert.equal(orderInDb.order_items[0].quantity, 2);

        // Assertiva 3: Zero transmissões SSE emitidas devido ao erro de validação
        assert.equal(sub.getMessages().length, 0, 'Nenhum evento SSE deve ser emitido quando PUT falha');
      } finally {
        // Teardown determinístico sem vazamento de socket ou resíduo no banco
        sub.close();
        await apiCall(`/orders/${orderId}`, { method: 'DELETE' });
      }
    });

    test('T2.9: GET /orders/realtime/stream sanitiza quebras de linha CRLF (\\r, \\n) em client_id impedindo injeção de blocos SSE espúrios', async () => {
      // 1. Conectar cliente com injeção maliciosa de CRLF (\r\n) simulando evento falso
      const maliciousClientId = 'legit_client\r\nevent: rogue_injected\r\ndata: {"evil":true}\r\n\r\n';
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=' + encodeURIComponent(maliciousClientId));
      await new Promise((r) => setImmediate(r));

      try {
        // Assertiva 1: Conexão SSE estabelecida com sucesso (200)
        assert.equal(sub.res.statusCode, 200);

        // Assertiva 2: Nenhum evento falso foi parseado pelo cliente SSE (0 mensagens de dados)
        const messages = sub.getMessages();
        assert.equal(messages.length, 0, 'Zero blocos SSE espúrios devem ser injetados via CRLF em client_id');

        // Assertiva 3: O comentário de handshake deve conter apenas uma linha sem quebras internas
        const comments = sub.getComments();
        assert.equal(comments.length, 1, 'Deve haver exatamente 1 comentário de handshake');
        assert.ok(comments[0].startsWith(': connected client_id='), 'Handshake formatado corretamente');
        assert.equal(comments[0].includes('\n') || comments[0].includes('\r'), false, 'Não deve conter quebras de linha internas');
        assert.equal(comments[0], ': connected client_id=legit_clientevent: rogue_injecteddata: {"evil":true}');

        // Assertiva 4: Registro interno do broadcaster não retém quebras de linha
        const activeClients = Array.from(sseBroadcaster.clients);
        const regClient = activeClients.find((c) => c.clientId.includes('legit_client'));
        assert.ok(regClient, 'Cliente deve estar registrado');
        assert.equal(/[\r\n]/.test(regClient.clientId), false, 'clientId registrado não deve conter CRLF');

        // Assertiva 5: client_id composto puramente por CRLF faz fallback limpo para "anonymous"
        const subEmpty = openSseSubscriber('/orders/realtime/stream?client_id=' + encodeURIComponent('\r\n\r\n'));
        await new Promise((r) => setImmediate(r));
        assert.equal(subEmpty.getComments()[0], ': connected client_id=anonymous');
        subEmpty.close();

        // Assertiva 6: Transmissão legítima subsequente funciona perfeitamente para o assinante sanitizado
        sseBroadcaster.broadcast('order_created', { id: 9999, total_amount: 10.0 }, 'server_pos');
        const msgsAfter = sub.getMessages();
        assert.equal(msgsAfter.length, 1, 'Deve receber o broadcast legítimo após o handshake sanitizado');
        assert.equal(msgsAfter[0].type, 'order_created');
        assert.equal(msgsAfter[0].order.id, 9999);
      } finally {
        // Teardown determinístico
        sub.close();
        assert.equal(sseBroadcaster.getSubscribersCount(), 0);
      }
    });
  });

  // ==========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS
  // ==========================================================================

  describe('Tier 3: Cross-Feature Interactions', () => {
    test('T3.1: Resolução de precedência de client_id (Header X-Client-Id > body client_id > query client_id)', async () => {
      const sub = openSseSubscriber('/orders/realtime/stream?client_id=sub_priority');
      await new Promise((r) => setImmediate(r));

      // Caso A: Ambos Header e Body enviados -> Header deve prevalecer
      await apiCall('/orders?client_id=query_low', {
        method: 'POST',
        headers: { 'X-Client-Id': 'header_winner' },
        body: JSON.stringify({
          client_id: 'body_runner_up',
          customer_name: 'Precedencia Teste',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }]
        })
      });

      let msgs = sub.getMessages();
      assert.equal(msgs[msgs.length - 1].client_id, 'header_winner');

      // Caso B: Apenas Body e Query -> Body deve prevalecer sobre Query
      await apiCall('/orders?client_id=query_low', {
        method: 'POST',
        body: JSON.stringify({
          client_id: 'body_winner',
          customer_name: 'Precedencia Teste 2',
          payment_method: 'pix',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 1, quantity: 1 }]
        })
      });

      msgs = sub.getMessages();
      assert.equal(msgs[msgs.length - 1].client_id, 'body_winner');

      sub.close();
    });

    test('T3.2: Lógica de supressão de toast no cliente originador vs notificação em clientes remotos', () => {
      const localClientId = 'pos_tablet_terminal_1';
      const remoteEvent = {
        type: 'order_created',
        client_id: 'pos_mobile_terminal_2',
        order: { id: 501, customer_name: 'Fernanda Lima', total_amount: 36.0 }
      };
      const ownEvent = {
        type: 'order_created',
        client_id: 'pos_tablet_terminal_1',
        order: { id: 502, customer_name: 'Meu Pedido Local', total_amount: 18.0 }
      };

      // Simulação da verificação do RealtimeManager:
      // const isRemote = Boolean(payload.client_id && payload.client_id !== myClientId);
      const isRemoteForRemoteEvent = Boolean(remoteEvent.client_id && remoteEvent.client_id !== localClientId);
      const isRemoteForOwnEvent = Boolean(ownEvent.client_id && ownEvent.client_id !== localClientId);

      assert.equal(isRemoteForRemoteEvent, true, 'Evento vindo de outro dispositivo deve ser marcado como remoto');
      assert.equal(isRemoteForOwnEvent, false, 'Evento gerado pelo próprio dispositivo deve ser marcado como local (suprimido)');

      // Validação de toast apenas para remoto
      const remoteToast = formatRealtimeToastMessage(remoteEvent);
      assert.ok(remoteToast.includes('Fernanda Lima'));
      assert.ok(remoteToast.includes('501'));
    });

    test('T3.3: Desduplicação multi-canal com isDuplicateRealtimeEvent descarta eventos repetidos dentro de 10s', () => {
      const isDuplicate = createRealtimeEventDeduplicator();
      const eventPayload = {
        type: 'order_created',
        order_id: 777,
        order: { id: 777, customer_name: 'Teste Duplicidade' },
        timestamp: Date.now()
      };

      // Primeiro recebimento (ex: via SSE) -> Deve aceitar (não é duplicata)
      assert.equal(isDuplicate(eventPayload), false);

      // Segundo recebimento do mesmo evento (ex: via BroadcastChannel ou Supabase Fallback) -> Deve descartar
      assert.equal(isDuplicate(eventPayload), true);

      // Terceiro recebimento por ID string direto -> Deve descartar
      assert.equal(isDuplicate('order_created_777_' + Math.floor(eventPayload.timestamp / 2000)), true);

      // Evento com ID diferente -> Deve aceitar
      const distinctEvent = {
        type: 'order_created',
        order_id: 778,
        order: { id: 778 },
        timestamp: Date.now()
      };
      assert.equal(isDuplicate(distinctEvent), false);
    });

    test('T3.4: Formatação de mensagens de Toast cobre todos os tipos de evento (created, paid, updated, deleted)', () => {
      // 1. Criado
      const msgCreated = formatRealtimeToastMessage({
        type: 'order_created',
        order: { id: 10, customer_name: 'Lucas', total_amount: 25.0 }
      });
      assert.match(msgCreated, /Novo pedido #10 \(Lucas\) registrado/);

      // 2. Quitado
      const msgPaidFull = formatRealtimeToastMessage({
        type: 'order_paid',
        order: { id: 10, customer_name: 'Lucas', payment_status: 'pago', paid_amount: 25.0, remaining_amount: 0 }
      });
      assert.match(msgPaidFull, /Pedido #10 \(Lucas\) atualizado: quitado/);

      // 3. Baixa parcial
      const msgPaidPartial = formatRealtimeToastMessage({
        type: 'order_paid',
        order: { id: 10, customer_name: 'Lucas', payment_status: 'pendente', paid_amount: 15.0, remaining_amount: 10.0 }
      });
      assert.match(msgPaidPartial, /Pedido #10 \(Lucas\) atualizado: baixa de/);

      // 4. Modificado
      const msgUpdated = formatRealtimeToastMessage({
        type: 'order_updated',
        order: { id: 10, customer_name: 'Lucas' }
      });
      assert.match(msgUpdated, /Pedido #10 \(Lucas\) modificado/);

      // 5. Cancelado
      const msgDeleted = formatRealtimeToastMessage({
        type: 'order_deleted',
        order_id: 10,
        order: { customer_name: 'Lucas' }
      });
      assert.match(msgDeleted, /Pedido #10 \(Lucas\) cancelado/);

      // 6. Cliente anônimo não exibe parênteses vazios
      const msgAnon = formatRealtimeToastMessage({
        type: 'order_created',
        order: { id: 11, customer_name: 'balcão', total_amount: 10.0 }
      });
      assert.ok(!msgAnon.includes('(balcão)'), 'Clientes balcão/anônimos não devem poluir com tags extras');
    });
  });

  // ==========================================================================
  // TIER 4: REAL-WORLD SOCIAL EVENT SIMULATION
  // ==========================================================================

  describe('Tier 4: Real-World Social Event Simulation', () => {
    test('T4.1: Simulação end-to-end multi-dispositivo de evento social com 2 caixas e 1 painel administrativo', async () => {
      resetMockDb(true);

      // 1. Conectar 3 dispositivos via SSE:
      // - Caixa 1 (Frente de Caixa 1)
      // - Caixa 2 (Frente de Caixa 2)
      // - Admin (Painel Gerencial / Fechamento de Caixa)
      const cashier1 = openSseSubscriber('/orders/realtime/stream?client_id=device_cashier_1');
      const cashier2 = openSseSubscriber('/orders/realtime/stream?client_id=device_cashier_2');
      const adminDashboard = openSseSubscriber('/orders/realtime/stream?client_id=device_admin');
      await new Promise((r) => setImmediate(r));

      assert.equal(sseBroadcaster.getSubscribersCount(), 3);

      // PASSO A: Caixa 1 registra um pedido pendente ("fiado") para o jovem "Marcos Paulo"
      // Itens: 2x Pastel de Carne (10.00 cada = 20.00) + 1x Refrigerante (6.00) = R$ 26.00
      const orderA = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'device_cashier_1' },
        body: JSON.stringify({
          customer_name: 'Marcos Paulo',
          payment_method: 'pix',
          payment_status: 'pendente',
          event_id: 1,
          items: [
            { product_id: 2, quantity: 2 },
            { product_id: 3, quantity: 1 }
          ]
        })
      });
      assert.equal(orderA.status, 201);
      const orderAId = orderA.body.id;

      // Verificar que Caixa 2 e Admin receberam o evento order_created em tempo real
      const c2MsgsA = cashier2.getMessages();
      const adminMsgsA = adminDashboard.getMessages();
      assert.equal(c2MsgsA.length, 1);
      assert.equal(adminMsgsA.length, 1);
      assert.equal(c2MsgsA[0].type, 'order_created');
      assert.equal(c2MsgsA[0].order.id, orderAId);
      assert.equal(c2MsgsA[0].client_id, 'device_cashier_1');

      // Caixa 1 reconhece que foi ação própria e suprime toast; Caixa 2 exibe toast
      assert.equal(c2MsgsA[0].client_id !== 'device_cashier_2', true, 'Caixa 2 detecta evento como remoto e exibe toast');
      assert.equal(c2MsgsA[0].client_id === 'device_cashier_1', true, 'Caixa 1 detecta como ação própria');

      // PASSO B: Mais tarde, Marcos Paulo vai ao Caixa 2 e faz um pagamento parcial de R$ 16.00
      const payPartial = await apiCall(`/orders/${orderAId}/pay`, {
        method: 'PATCH',
        headers: { 'X-Client-Id': 'device_cashier_2' },
        body: JSON.stringify({ amount: 16.0 })
      });
      assert.equal(payPartial.status, 200);
      assert.equal(payPartial.body.paid_amount, 16.0);
      assert.equal(payPartial.body.remaining_amount, 10.0);
      assert.equal(payPartial.body.payment_status, 'pendente');

      // Caixa 1 e Admin recebem a notificação de baixa parcial em tempo real
      const c1MsgsB = cashier1.getMessages();
      const adminMsgsB = adminDashboard.getMessages();
      assert.equal(c1MsgsB[c1MsgsB.length - 1].type, 'order_paid');
      assert.equal(c1MsgsB[c1MsgsB.length - 1].order.paid_amount, 16.0);
      assert.equal(c1MsgsB[c1MsgsB.length - 1].order.remaining_amount, 10.0);
      assert.equal(adminMsgsB[adminMsgsB.length - 1].order.paid_amount, 16.0);

      // PASSO C: Marcos Paulo quita os R$ 10.00 restantes no Caixa 2
      const payRest = await apiCall(`/orders/${orderAId}/pay`, {
        method: 'PATCH',
        headers: { 'X-Client-Id': 'device_cashier_2' },
        body: JSON.stringify({ amount: 10.0 })
      });
      assert.equal(payRest.status, 200);
      assert.equal(payRest.body.payment_status, 'pago');
      assert.equal(payRest.body.remaining_amount, 0.0);

      // PASSO D: O Admin consulta o fechamento de caixa e métricas do evento
      // Deve refletir exatamente: total_paid: 26.00, total_pending: 0.00 sem nenhum recarregamento de página
      const cashClosing = await apiCall('/cash-closing');
      assert.equal(cashClosing.status, 200);
      assert.equal(cashClosing.body.total_paid, 26.0);
      assert.equal(cashClosing.body.total_pending, 0.0);
      assert.equal(cashClosing.body.paid_count, 1);
      assert.equal(cashClosing.body.pending_count, 0);

      // Consultar métricas do evento 1 (adesão de compradores únicos sobre o público presente)
      const eventsRes = await apiCall('/events');
      assert.equal(eventsRes.status, 200);
      const ev1 = eventsRes.body.find((e) => e.id === 1);
      assert.equal(ev1.orders_count, 1);
      assert.equal(ev1.unique_buyers_count, 1);
      // 1 comprador único / 30 presentes no evento = 3.3% de adesão
      assert.equal(ev1.adherence_rate, 3.3);

      // PASSO E: Caixa 1 cria um segundo pedido para "Larissa" e em seguida cancela (DELETE)
      const orderB = await apiCall('/orders', {
        method: 'POST',
        headers: { 'X-Client-Id': 'device_cashier_1' },
        body: JSON.stringify({
          customer_name: 'Larissa Erro',
          payment_method: 'dinheiro',
          payment_status: 'pago',
          event_id: 1,
          items: [{ product_id: 3, quantity: 2 }]
        })
      });
      const orderBId = orderB.body.id;

      const delOrderB = await apiCall(`/orders/${orderBId}`, {
        method: 'DELETE',
        headers: { 'X-Client-Id': 'device_cashier_1' }
      });
      assert.equal(delOrderB.status, 200);

      // Caixa 2 e Admin recebem o evento order_deleted
      const c2Last = cashier2.getMessages();
      assert.equal(c2Last[c2Last.length - 1].type, 'order_deleted');
      assert.equal(c2Last[c2Last.length - 1].order_id, orderBId);

      // PASSO F: Teardown limpo de todos os 3 dispositivos
      cashier1.close();
      cashier2.close();
      adminDashboard.close();

      assert.equal(sseBroadcaster.getSubscribersCount(), 0, 'Todos os canais SSE devem ser encerrados sem vazamento');
    });
  });
});
