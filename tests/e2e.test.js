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
});
