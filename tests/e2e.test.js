process.env.NODE_ENV = 'test';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const app = require('../src/app');
const {
  DB_SCHEMA,
  supabaseOptions,
  resetMockDb,
  createMockSupabaseClient
} = require('../src/config/supabase');

let server;
let baseUrl;

// IDs armazenados ao longo do fluxo E2E
let catLanchesId;
let catBebidasId;
let prodRefriId;
let prodHotDogId;
let orderPendingId;

/**
 * Executa uma requisição HTTP diretamente contra a instância Express (app)
 * usando streams em memória caso o ambiente sandbox bloqueie sockets TCP locais (EACCES).
 */
function dispatchInProcess(path, options = {}) {
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
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = function (chunk, encoding, callback) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
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
      resolve({ status: res.statusCode, body: parsedBody });
      return this;
    };

    app.handle(req, res, reject);

    process.nextTick(() => {
      if (rawBody.length > 0) {
        req.push(rawBody);
      }
      req.push(null);
    });
  });
}

async function apiRequest(path, options = {}) {
  if (baseUrl) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...options
      });

      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      return { status: response.status, body };
    } catch (err) {
      if (err?.cause?.code !== 'EACCES' && err?.code !== 'EACCES') {
        throw err;
      }
    }
  }

  return dispatchInProcess(path, options);
}

describe('Suíte E2E - Controle Social Jovens (Frente de Caixa, Estoque e Fechamento)', () => {
  before(async () => {
    // Limpa o banco em memória sem seed para testar o ciclo completo do zero
    resetMockDb(false);
  });

  after(async () => {});

  test('Teste 0: Configuração estrita do Schema "controle-social-jovens"', async () => {
    assert.equal(DB_SCHEMA, 'controle-social-jovens', 'DB_SCHEMA deve ser estritamente "controle-social-jovens"');
    assert.equal(
      supabaseOptions?.db?.schema,
      'controle-social-jovens',
      'supabaseOptions.db.schema deve ser estritamente "controle-social-jovens"'
    );

    // Garantir que tentativa de acesso a outro schema seja rejeitada
    const invalidClient = createMockSupabaseClient('public');
    const { data, error } = await invalidClient.from('categories').select('*');
    assert.equal(data, null);
    assert.ok(error, 'Deve bloquear consultas fora do schema controle-social-jovens');
    assert.equal(error.code, 'INVALID_SCHEMA');

    const health = await apiRequest('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.schema, 'controle-social-jovens');
    console.log('✔ [Teste 0] Schema validado:', health.body);
  });

  test('Teste 1: Cadastro e listagem de categorias e produtos COM e SEM controle de estoque', async () => {
    // 1.1 Cadastrar Categorias
    const resLanches = await apiRequest('/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lanches' })
    });
    assert.equal(resLanches.status, 201);
    assert.equal(resLanches.body.name, 'Lanches');
    catLanchesId = resLanches.body.id;

    const resBebidas = await apiRequest('/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bebidas' })
    });
    assert.equal(resBebidas.status, 201);
    assert.equal(resBebidas.body.name, 'Bebidas');
    catBebidasId = resBebidas.body.id;

    // Verificar duplicidade de categoria (409)
    const resDup = await apiRequest('/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lanches' })
    });
    assert.equal(resDup.status, 409);

    // Listar categorias
    const listCats = await apiRequest('/categories');
    assert.equal(listCats.status, 200);
    assert.equal(listCats.body.length, 2);

    // 1.2 Cadastrar produto COM controle de estoque (Refrigerante Lata, price: 6.00, stock_quantity: 20)
    const resRefri = await apiRequest('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Refrigerante Lata',
        category_id: catBebidasId,
        price: 6.0,
        stock_quantity: 20
      })
    });
    assert.equal(resRefri.status, 201);
    assert.equal(resRefri.body.name, 'Refrigerante Lata');
    assert.equal(resRefri.body.price, 6.0);
    assert.equal(resRefri.body.stock_quantity, 20);
    assert.equal(resRefri.body.has_stock_control, true);
    prodRefriId = resRefri.body.id;

    // 1.3 Cadastrar produto SEM controle de estoque (Cachorro-Quente na Chapa, price: 12.00, stock_quantity: null)
    const resHotDog = await apiRequest('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cachorro-Quente na Chapa',
        category_id: catLanchesId,
        price: 12.0,
        stock_quantity: null
      })
    });
    assert.equal(resHotDog.status, 201);
    assert.equal(resHotDog.body.name, 'Cachorro-Quente na Chapa');
    assert.equal(resHotDog.body.price, 12.0);
    assert.equal(resHotDog.body.stock_quantity, null);
    assert.equal(resHotDog.body.has_stock_control, false);
    prodHotDogId = resHotDog.body.id;

    // 1.4 Consultar GET /products e GET /products?grouped=true
    const listProds = await apiRequest('/products');
    assert.equal(listProds.status, 200);
    assert.equal(listProds.body.length, 2);

    const groupedProds = await apiRequest('/products?grouped=true');
    assert.equal(groupedProds.status, 200);
    assert.equal(groupedProds.body.Bebidas.length, 1);
    assert.equal(groupedProds.body.Bebidas[0].stock_quantity, 20);
    assert.equal(groupedProds.body.Lanches.length, 1);
    assert.equal(groupedProds.body.Lanches[0].stock_quantity, null);

    // 1.5 Editar produto cadastrado (PUT /products/:id) e restaurar valores para o próximo teste
    const editRes = await apiRequest(`/products/${prodRefriId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Refrigerante Lata 350ml',
        category_id: catBebidasId,
        price: 6.5,
        stock_quantity: 25
      })
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.body.name, 'Refrigerante Lata 350ml');
    assert.equal(editRes.body.price, 6.5);
    assert.equal(editRes.body.stock_quantity, 25);

    // Restaurar para price: 6.0 e stock_quantity: 20 para manter valores exatos dos testes seguintes
    await apiRequest(`/products/${prodRefriId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Refrigerante Lata',
        category_id: catBebidasId,
        price: 6.0,
        stock_quantity: 20
      })
    });

    console.log('✔ [Teste 1] Produtos cadastrados e edição validada:', listProds.body.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      stock_quantity: p.stock_quantity
    })));
  });

  test('Teste 2: Criação de pedidos, abatimento automático de estoque e validação de limite de estoque', async () => {
    // 2.1 Pedido #1: Lucas Mendes | pix | pago | 3x Refrigerante (6.00) + 2x Cachorro-Quente (12.00) = 42.00
    const order1 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Lucas Mendes',
        payment_method: 'pix',
        payment_status: 'pago',
        items: [
          { product_id: prodRefriId, quantity: 3 },
          { product_id: prodHotDogId, quantity: 2 }
        ]
      })
    });

    assert.equal(order1.status, 201);
    assert.equal(order1.body.customer_name, 'Lucas Mendes');
    assert.equal(order1.body.payment_method, 'pix');
    assert.equal(order1.body.payment_status, 'pago');
    assert.equal(order1.body.total_amount, 42.0);
    assert.equal(order1.body.order_items.length, 2);
    assert.ok(order1.body.paid_at, 'Pedido pago deve possuir data paid_at preenchida');

    // Comprovar que estoque do Refrigerante caiu de 20 para 17 e Cachorro-Quente permaneceu null
    const prodsAfterOrder1 = await apiRequest('/products');
    const refriAfter1 = prodsAfterOrder1.body.find((p) => p.id === prodRefriId);
    const hotDogAfter1 = prodsAfterOrder1.body.find((p) => p.id === prodHotDogId);
    assert.equal(refriAfter1.stock_quantity, 17, 'Estoque de Refrigerante deve cair de 20 para 17');
    assert.equal(hotDogAfter1.stock_quantity, null, 'Produto sem estoque controlado deve permanecer null');

    // 2.2 Pedido #2: Mariana Costa | dinheiro | pago | 1x Cachorro-Quente (12.00) = 12.00
    const order2 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Mariana Costa',
        payment_method: 'dinheiro',
        payment_status: 'pago',
        items: [{ product_id: prodHotDogId, quantity: 1 }]
      })
    });
    assert.equal(order2.status, 201);
    assert.equal(order2.body.customer_name, 'Mariana Costa');
    assert.equal(order2.body.payment_method, 'dinheiro');
    assert.equal(order2.body.payment_status, 'pago');
    assert.equal(order2.body.total_amount, 12.0);

    // 2.3 Pedido #3: Gabriel Oliveira | pix | pendente (fiado / na rua) | 2x Refrigerante + 1x Cachorro-Quente = 24.00
    const order3 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Gabriel Oliveira',
        payment_method: 'pix',
        payment_status: 'pendente',
        items: [
          { product_id: prodRefriId, quantity: 2 },
          { product_id: prodHotDogId, quantity: 1 }
        ]
      })
    });
    assert.equal(order3.status, 201);
    assert.equal(order3.body.customer_name, 'Gabriel Oliveira');
    assert.equal(order3.body.payment_status, 'pendente');
    assert.equal(order3.body.total_amount, 24.0);
    assert.equal(order3.body.paid_at, null, 'Pedido pendente não deve ter paid_at');
    orderPendingId = order3.body.id;

    // Comprovar que o estoque de Refrigerante caiu de 17 para 15
    const prodsAfterOrder3 = await apiRequest('/products');
    const refriAfter3 = prodsAfterOrder3.body.find((p) => p.id === prodRefriId);
    assert.equal(refriAfter3.stock_quantity, 15, 'Estoque de Refrigerante deve cair de 17 para 15');

    // 2.4 Tentativa de compra acima do estoque disponível (50 unidades quando há 15) -> Deve retornar 400
    const orderOverflow = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Cliente Sem Estoque',
        payment_method: 'pix',
        payment_status: 'pago',
        items: [{ product_id: prodRefriId, quantity: 50 }]
      })
    });
    assert.equal(orderOverflow.status, 400);
    assert.match(orderOverflow.body.error, /Estoque insuficiente/i);

    // Confirmar que o estoque permaneceu intacto em 15 após a falha
    const prodsAfterOverflow = await apiRequest('/products');
    const refriAfterOverflow = prodsAfterOverflow.body.find((p) => p.id === prodRefriId);
    assert.equal(refriAfterOverflow.stock_quantity, 15);

    console.log('✔ [Teste 2] Estoque final após pedidos e bloqueio de excesso:', {
      refrigerante_stock: refriAfterOverflow.stock_quantity,
      cachorro_quente_stock: hotDogAfter1.stock_quantity,
      overflow_error: orderOverflow.body.error
    });
  });

  test('Teste 3: Rota de Fechamento de Caixa (GET /cash-closing) separando pagos e pendentes ("na rua")', async () => {
    const closing = await apiRequest('/cash-closing');
    assert.equal(closing.status, 200);

    // Pagos: Pedido #1 (42.00 via pix) + Pedido #2 (12.00 via dinheiro) = 54.00
    assert.equal(closing.body.total_paid, 54.0);
    assert.equal(closing.body.paid_count, 2);
    assert.equal(closing.body.by_payment_method.pix, 42.0);
    assert.equal(closing.body.by_payment_method.dinheiro, 12.0);

    // Pendentes ("na rua"): Pedido #3 (24.00 de Gabriel Oliveira)
    assert.equal(closing.body.total_pending, 24.0);
    assert.equal(closing.body.pending_count, 1);
    assert.equal(closing.body.pending_orders.length, 1);
    assert.equal(closing.body.pending_orders[0].id, orderPendingId);
    assert.equal(closing.body.pending_orders[0].customer_name, 'Gabriel Oliveira');
    assert.equal(closing.body.pending_orders[0].total_amount, 24.0);

    // Resumo geral
    assert.equal(closing.body.summary.total_general, 78.0);
    assert.equal(closing.body.summary.total_orders, 3);

    console.log('✔ [Teste 3] Fechamento de Caixa (Antes da baixa do pendente):', {
      total_paid: closing.body.total_paid,
      by_payment_method: closing.body.by_payment_method,
      total_pending: closing.body.total_pending,
      pending_customers: closing.body.pending_orders.map((o) => o.customer_name)
    });
  });

  test('Teste 4: Baixa de pedido pendente (PATCH /orders/:id/pay) e reflexo imediato no Fechamento de Caixa', async () => {
    // 4.1 Dar baixa no pedido pendente de Gabriel Oliveira
    const payRes = await apiRequest(`/orders/${orderPendingId}/pay`, {
      method: 'PATCH',
      body: JSON.stringify({ payment_method: 'pix' })
    });
    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.id, orderPendingId);
    assert.equal(payRes.body.payment_status, 'pago');
    assert.ok(payRes.body.paid_at, 'Deve registrar timestamp paid_at ao quitar pedido');

    // 4.2 Tentar pagar novamente o mesmo pedido já pago deve retornar erro 400 amigável
    const payAgainRes = await apiRequest(`/orders/${orderPendingId}/pay`, {
      method: 'PATCH'
    });
    assert.equal(payAgainRes.status, 400);
    assert.match(payAgainRes.body.error, /já consta como pago/i);

    // 4.3 Consultar novamente o Fechamento de Caixa e comprovar migração do saldo
    const closingAfterPay = await apiRequest('/cash-closing');
    assert.equal(closingAfterPay.status, 200);
    assert.equal(closingAfterPay.body.total_paid, 78.0);
    assert.equal(closingAfterPay.body.paid_count, 3);
    assert.equal(closingAfterPay.body.by_payment_method.pix, 66.0);
    assert.equal(closingAfterPay.body.by_payment_method.dinheiro, 12.0);
    assert.equal(closingAfterPay.body.total_pending, 0.0);
    assert.equal(closingAfterPay.body.pending_count, 0);
    assert.deepEqual(closingAfterPay.body.pending_orders, []);

    console.log('✔ [Teste 4] Fechamento de Caixa (Após baixa do pendente):', {
      total_paid: closingAfterPay.body.total_paid,
      by_payment_method: closingAfterPay.body.by_payment_method,
      total_pending: closingAfterPay.body.total_pending,
      pending_count: closingAfterPay.body.pending_count
    });
  });

  test('Teste 5: Interface Web EJS (GET /) renderiza a Frente de Caixa com status 200', async () => {
    const htmlRes = await apiRequest('/');
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.body, /Controle Social Jovens/i);
    assert.match(htmlRes.body, /controle-social-jovens/i);
    console.log('✔ [Teste 5] Interface EJS renderizada com sucesso (tamanho HTML:', htmlRes.body.length, 'bytes)');
  });

  test('Teste 6: Gestão de Eventos, Ciclo de Vendas (Agendado -> Aberto -> Encerrado) e Cálculo de Adesão', async () => {
    // 6.1 Agendar um evento para sábado com 20 jovens presentes
    const createEv = await apiRequest('/events', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Social Noite do Hot Dog',
        event_date: '2026-11-14',
        attendance_count: 20,
        status: 'agendado'
      })
    });
    assert.equal(createEv.status, 201);
    const evId = createEv.body.id;
    assert.equal(createEv.body.status, 'agendado');
    assert.equal(createEv.body.attendance_count, 20);

    // 6.2 Tentar lançar pedido enquanto evento está "agendado" deve bloquear (400)
    const blockedOrder = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: evId,
        customer_name: 'Ana Clara',
        payment_method: 'pix',
        payment_status: 'pago',
        items: [{ product_id: prodHotDogId, quantity: 1 }]
      })
    });
    assert.equal(blockedOrder.status, 400);
    assert.match(blockedOrder.body.error, /não estão abertas/i);

    // 6.3 Iniciar vendas do evento (mudar status para "aberto")
    const openEv = await apiRequest(`/events/${evId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'aberto' })
    });
    assert.equal(openEv.status, 200);
    assert.equal(openEv.body.status, 'aberto');

    // 6.4 Registrar 2 pedidos para a mesma pessoa ("Ana Clara" e "ana clara ") e 1 para "Pedro Henrique"
    const ordA1 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: evId,
        customer_name: 'Ana Clara',
        payment_method: 'pix',
        payment_status: 'pago',
        items: [{ product_id: prodHotDogId, quantity: 1 }]
      })
    });
    assert.equal(ordA1.status, 201);

    const ordA2 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: evId,
        customer_name: '  ana clara ',
        payment_method: 'pix',
        payment_status: 'pendente',
        items: [{ product_id: prodRefriId, quantity: 1 }]
      })
    });
    assert.equal(ordA2.status, 201);

    const ordB1 = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: evId,
        customer_name: 'Pedro Henrique',
        payment_method: 'dinheiro',
        payment_status: 'pago',
        items: [{ product_id: prodHotDogId, quantity: 1 }]
      })
    });
    assert.equal(ordB1.status, 201);

    // 6.5 Verificar métricas de adesão do evento: 3 pedidos, mas 2 compradores únicos em 20 presentes = 10% de adesão
    const evList = await apiRequest('/events');
    assert.equal(evList.status, 200);
    const targetEv = evList.body.find((e) => e.id === evId);
    assert.equal(targetEv.orders_count, 3);
    assert.equal(targetEv.unique_buyers_count, 2, 'Deve unificar Ana Clara como 1 única participante');
    assert.equal(targetEv.adherence_rate, 10.0, '2 compradores / 20 presentes = 10% de adesão');

    // 6.6 Encerrar o evento e confirmar que ainda é possível dar baixa na pendência de Ana Clara
    const closeEv = await apiRequest(`/events/${evId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'encerrado' })
    });
    assert.equal(closeEv.status, 200);
    assert.equal(closeEv.body.status, 'encerrado');

    const payClosedEvOrder = await apiRequest(`/orders/${ordA2.body.id}/pay`, {
      method: 'PATCH'
    });
    assert.equal(payClosedEvOrder.status, 200);
    assert.equal(payClosedEvOrder.body.payment_status, 'pago');

    console.log('✔ [Teste 6] Evento e métricas de adesão validados:', {
      name: targetEv.name,
      attendance_count: targetEv.attendance_count,
      unique_buyers_count: targetEv.unique_buyers_count,
      adherence_rate: `${targetEv.adherence_rate}%`,
      orders_count: targetEv.orders_count
    });
  });

  test('Teste 7: Pagamento Parcial na criação do pedido e abatimentos parciais até quitar', async () => {
    // 7.1 Criar um pedido de 2x Cachorro-Quente (R$ 24,00) com entrada parcial de R$ 10,00
    const partialOrderRes = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Rafael Souza',
        payment_method: 'pix',
        payment_status: 'parcial',
        paid_amount: 10.0,
        items: [{ product_id: prodHotDogId, quantity: 2 }]
      })
    });
    assert.equal(partialOrderRes.status, 201);
    assert.equal(partialOrderRes.body.total_amount, 24.0);
    assert.equal(partialOrderRes.body.paid_amount, 10.0);
    assert.equal(partialOrderRes.body.remaining_amount, 14.0);
    assert.equal(partialOrderRes.body.is_partial, true);
    assert.equal(partialOrderRes.body.payment_status, 'pendente');

    const partialId = partialOrderRes.body.id;

    // 7.2 Verificar que o fechamento de caixa contabiliza os R$ 10,00 já pagos e R$ 14,00 pendentes
    const closingMid1 = await apiRequest('/cash-closing');
    assert.equal(closingMid1.status, 200);
    assert.equal(closingMid1.body.total_pending, 14.0);
    const pendingItem1 = closingMid1.body.pending_orders.find((o) => o.id === partialId);
    assert.ok(pendingItem1, 'Pedido parcial deve aparecer na lista de pendentes pelo saldo restante');
    assert.equal(pendingItem1.paid_amount, 10.0);
    assert.equal(pendingItem1.remaining_amount, 14.0);

    // 7.3 Abater mais R$ 6,00 parcialmente (total pago passa a R$ 16,00, restam R$ 8,00)
    const payPart2 = await apiRequest(`/orders/${partialId}/pay`, {
      method: 'PATCH',
      body: JSON.stringify({ amount: 6.0 })
    });
    assert.equal(payPart2.status, 200);
    assert.equal(payPart2.body.paid_amount, 16.0);
    assert.equal(payPart2.body.remaining_amount, 8.0);
    assert.equal(payPart2.body.payment_status, 'pendente');

    // 7.4 Quitar os R$ 8,00 restantes
    const payRest = await apiRequest(`/orders/${partialId}/pay`, {
      method: 'PATCH',
      body: JSON.stringify({ amount: 8.0 })
    });
    assert.equal(payRest.status, 200);
    assert.equal(payRest.body.paid_amount, 24.0);
    assert.equal(payRest.body.remaining_amount, 0);
    assert.equal(payRest.body.payment_status, 'pago');

    console.log('✔ [Teste 7] Pagamento parcial validado com sucesso!');
  });

  test('Teste 8: Gestão de Preço de Custo (cost_price) e Despesas Extras do Evento (/expenses)', async () => {
    // 8.1 Cadastrar produto com cost_price
    const prodRes = await apiRequest('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Pastel de Queijo Teste',
        category_id: catLanchesId || 1,
        price: 8.0,
        cost_price: 3.5,
        stock_quantity: 15
      })
    });
    assert.equal(prodRes.status, 201);
    assert.equal(prodRes.body.cost_price, 3.5);
    const costProdId = prodRes.body.id;

    // 8.2 Atualizar o produto com novo cost_price via PUT
    const prodUpdate = await apiRequest(`/products/${costProdId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Pastel de Queijo Especial',
        category_id: catLanchesId || 1,
        price: 9.0,
        cost_price: 4.0,
        stock_quantity: 15
      })
    });
    assert.equal(prodUpdate.status, 200);
    assert.equal(prodUpdate.body.cost_price, 4.0);

    // 8.3 Criar despesas extras para um evento
    const exp1 = await apiRequest('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        event_id: 1,
        description: 'Gelo e Copos Descartáveis',
        amount: 25.5
      })
    });
    assert.equal(exp1.status, 201);
    assert.equal(exp1.body.amount, 25.5);
    assert.equal(exp1.body.description, 'Gelo e Copos Descartáveis');
    const exp1Id = exp1.body.id;

    const exp2 = await apiRequest('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        event_id: 1,
        description: 'Guardanapos e Sacolas',
        amount: 14.5
      })
    });
    assert.equal(exp2.status, 201);

    // 8.4 Listar despesas do evento 1
    const listExp = await apiRequest('/expenses?event_id=1');
    assert.equal(listExp.status, 200);
    assert.ok(Array.isArray(listExp.body));
    const totalExp = listExp.body.reduce((acc, cur) => acc + Number(cur.amount), 0);
    assert.equal(totalExp, 40.0, '25.5 + 14.5 = 40.0 de despesas extras');

    // 8.5 Excluir uma despesa
    const delRes = await apiRequest(`/expenses/${exp1Id}`, {
      method: 'DELETE'
    });
    assert.equal(delRes.status, 200);

    const listAfterDel = await apiRequest('/expenses?event_id=1');
    assert.equal(listAfterDel.status, 200);
    assert.equal(listAfterDel.body.length, 1);
    assert.equal(listAfterDel.body[0].id, exp2.body.id);

    console.log('✔ [Teste 8] Custo unitário de produtos e despesas extras validados com sucesso!');
  });

  test('Teste 9: Gestão de Usuários, Login por PIN e Rastreamento de Vendas (/users e created_by_name)', async () => {
    // 9.1 Listar usuários iniciais padrão
    const listRes = await apiRequest('/users');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    const adminUser = listRes.body.find((u) => u.name === 'Gabriel');
    assert.ok(adminUser, 'Usuário inicial Gabriel (admin) deve existir');
    assert.equal(adminUser.role, 'admin');

    const sellerUser = listRes.body.find((u) => u.name === 'Caixa 1');
    assert.ok(sellerUser, 'Usuário inicial Caixa 1 (seller) deve existir');
    assert.equal(sellerUser.role, 'seller');

    // 9.2 Teste de Login: PIN incorreto
    const badLogin = await apiRequest('/users/login', {
      method: 'POST',
      body: JSON.stringify({ user_id: adminUser.id, pin: '0000' })
    });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.body.error, 'PIN incorreto. Tente novamente.');

    // 9.3 Teste de Login: PIN correto para Admin
    const goodLogin = await apiRequest('/users/login', {
      method: 'POST',
      body: JSON.stringify({ user_id: adminUser.id, pin: '1234' })
    });
    assert.equal(goodLogin.status, 200);
    assert.equal(goodLogin.body.success, true);
    assert.equal(goodLogin.body.user.role, 'admin');

    // 9.4 Cadastrar novo usuário (ex: Lucas Líder - role 'manager')
    const createRes = await apiRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Lucas Líder',
        pin: '2222',
        role: 'manager'
      })
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.name, 'Lucas Líder');
    assert.equal(createRes.body.role, 'manager');
    const newUserId = createRes.body.id;

    // 9.5 Atualizar PIN do usuário criado
    const updateRes = await apiRequest(`/users/${newUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pin: '9999' })
    });
    assert.equal(updateRes.status, 200);

    // Testar login com o novo PIN
    const newPinLogin = await apiRequest('/users/login', {
      method: 'POST',
      body: JSON.stringify({ user_id: newUserId, pin: '9999' })
    });
    assert.equal(newPinLogin.status, 200);
    assert.equal(newPinLogin.body.user.name, 'Lucas Líder');

    // 9.6 Criar pedido gravando o vendedor responsável (created_by_name)
    const orderWithSeller = await apiRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: 'Marcos Vinicius',
        payment_method: 'pix',
        payment_status: 'pago',
        created_by_name: 'Caixa 1',
        items: [{ product_id: prodRefriId || 1, quantity: 1 }]
      })
    });
    assert.equal(orderWithSeller.status, 201);
    assert.equal(orderWithSeller.body.created_by_name, 'Caixa 1');

    console.log('✔ [Teste 9] Autenticação por PIN, perfis e rastreamento de vendas validados com sucesso!');
  });
});
