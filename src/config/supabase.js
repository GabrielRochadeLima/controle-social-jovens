const dotenv = require('dotenv');
dotenv.config();

let createClient;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (err) {
  createClient = null;
}

const DB_SCHEMA = 'controle-social-jovens';

/**
 * Armazenamento em memória fiel à API do Supabase (PostgREST) para o schema "controle-social-jovens".
 * Usado automaticamente quando NODE_ENV === 'test' ou quando SUPABASE_URL / SUPABASE_KEY
 * não estão configurados com credenciais reais.
 */
const initialSeed = () => ({
  categories: [
    { id: 1, name: 'Lanches', created_at: new Date().toISOString() },
    { id: 2, name: 'Bebidas', created_at: new Date().toISOString() },
    { id: 3, name: 'Doces', created_at: new Date().toISOString() }
  ],
  products: [
    { id: 1, name: 'Cachorro-Quente Completo', category_id: 1, price: 12.00, stock_quantity: null, created_at: new Date().toISOString() },
    { id: 2, name: 'Pastel de Carne', category_id: 1, price: 10.00, stock_quantity: null, created_at: new Date().toISOString() },
    { id: 3, name: 'Refrigerante Lata 350ml', category_id: 2, price: 6.00, stock_quantity: 48, created_at: new Date().toISOString() },
    { id: 4, name: 'Brigadeiro Gourmet', category_id: 3, price: 4.50, stock_quantity: 30, created_at: new Date().toISOString() }
  ],
  events: [
    {
      id: 1,
      name: 'Social de Sábado',
      event_date: new Date().toISOString().slice(0, 10),
      status: 'aberto',
      attendance_count: 30,
      created_at: new Date().toISOString()
    }
  ],
  orders: [],
  order_items: []
});

let mockStore = initialSeed();
let counters = {
  categories: 4,
  products: 5,
  events: 2,
  orders: 1,
  order_items: 1
};

function resetMockDb(withSeed = false) {
  if (withSeed) {
    mockStore = initialSeed();
    counters = { categories: 4, products: 5, events: 2, orders: 1, order_items: 1 };
  } else {
    mockStore = {
      categories: [],
      products: [],
      events: [],
      orders: [],
      order_items: []
    };
    counters = { categories: 1, products: 1, events: 1, orders: 1, order_items: 1 };
  }
}

function enrichRow(table, row, selectSpec = '*') {
  const clone = { ...row };
  const spec = String(selectSpec || '*');

  if (table === 'products' && (spec.includes('categories') || spec.includes('category'))) {
    const category = mockStore.categories.find((c) => Number(c.id) === Number(clone.category_id)) || null;
    clone.categories = category ? { ...category } : null;
  }

  if (table === 'orders' && spec.includes('events')) {
    const ev = (mockStore.events || []).find((e) => Number(e.id) === Number(clone.event_id)) || null;
    clone.events = ev ? { ...ev } : null;
  }

  if (table === 'orders' && spec.includes('order_items')) {
    const items = mockStore.order_items
      .filter((item) => Number(item.order_id) === Number(clone.id))
      .map((item) => {
        const itemClone = { ...item };
        if (spec.includes('products')) {
          const prod = mockStore.products.find((p) => Number(p.id) === Number(itemClone.product_id)) || null;
          itemClone.products = prod ? { ...prod } : null;
        }
        return itemClone;
      });
    clone.order_items = items;
  }

  if (table === 'order_items' && spec.includes('products')) {
    const prod = mockStore.products.find((p) => Number(p.id) === Number(clone.product_id)) || null;
    clone.products = prod ? { ...prod } : null;
  }

  return clone;
}

class MockQueryBuilder {
  constructor(table, schema = DB_SCHEMA) {
    this.table = table;
    this.schema = schema;
    this.operation = 'select';
    this.selectSpec = '*';
    this.payload = null;
    this.filters = [];
    this.orders = [];
    this.expectSingle = false;
    this.expectMaybeSingle = false;
  }

  select(spec = '*') {
    this.selectSpec = spec;
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }

  in(column, values) {
    const set = new Set((values || []).map((v) => String(v)));
    this.filters.push((row) => set.has(String(row[column])));
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending });
    return this;
  }

  single() {
    this.expectSingle = true;
    return this;
  }

  maybeSingle() {
    this.expectMaybeSingle = true;
    return this;
  }

  _execute() {
    if (this.schema !== DB_SCHEMA) {
      return {
        data: null,
        error: { message: `Schema inválido: "${this.schema}". Use estritamente "${DB_SCHEMA}".`, code: 'INVALID_SCHEMA' }
      };
    }

    const collection = mockStore[this.table];
    if (!collection) {
      return {
        data: null,
        error: { message: `Tabela "${this.table}" não existe no schema "${this.schema}".`, code: '42P01' }
      };
    }

    try {
      let resultRows = [];

      if (this.operation === 'select') {
        resultRows = collection.filter((row) => this.filters.every((fn) => fn(row)));
      } else if (this.operation === 'insert') {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = [];

        for (const item of items) {
          if (this.table === 'categories') {
            const exists = collection.some(
              (c) => c.name.trim().toLowerCase() === String(item.name || '').trim().toLowerCase()
            );
            if (exists) {
              return {
                data: null,
                error: { message: 'Já existe uma categoria com este nome.', code: '23505' }
              };
            }
          }

          if (this.table === 'products') {
            const catExists = mockStore.categories.some((c) => Number(c.id) === Number(item.category_id));
            if (!catExists) {
              return {
                data: null,
                error: { message: 'Categoria informada não existe.', code: '23503' }
              };
            }
          }

          const newRow = {
            id: item.id !== undefined ? Number(item.id) : counters[this.table]++,
            ...item
          };
          if (this.table !== 'order_items' && !newRow.created_at) {
            newRow.created_at = new Date().toISOString();
          }
          if (this.table === 'products') {
            newRow.price = Number(newRow.price);
            newRow.category_id = Number(newRow.category_id);
            newRow.stock_quantity =
              newRow.stock_quantity === null || newRow.stock_quantity === undefined || newRow.stock_quantity === ''
                ? null
                : Number(newRow.stock_quantity);
          }
          if (this.table === 'events') {
            newRow.attendance_count = Number(newRow.attendance_count || 0);
            newRow.status = newRow.status || 'agendado';
          }
          if (this.table === 'orders') {
            newRow.total_amount = Number(newRow.total_amount);
            newRow.event_id = newRow.event_id === undefined || newRow.event_id === null || newRow.event_id === '' ? null : Number(newRow.event_id);
          }
          if (this.table === 'order_items') {
            newRow.order_id = Number(newRow.order_id);
            newRow.product_id = Number(newRow.product_id);
            newRow.quantity = Number(newRow.quantity);
            newRow.unit_price = Number(newRow.unit_price);
          }

          collection.push(newRow);
          inserted.push(newRow);
        }

        resultRows = inserted;
      } else if (this.operation === 'update') {
        const matched = collection.filter((row) => this.filters.every((fn) => fn(row)));
        for (const row of matched) {
          Object.assign(row, this.payload);
          if (this.table === 'products' && row.stock_quantity !== null && row.stock_quantity !== undefined) {
            row.stock_quantity = Number(row.stock_quantity);
          }
        }
        resultRows = matched;
      } else if (this.operation === 'delete') {
        const remaining = [];
        const deleted = [];
        for (const row of collection) {
          if (this.filters.every((fn) => fn(row))) {
            deleted.push(row);
          } else {
            remaining.push(row);
          }
        }
        mockStore[this.table] = remaining;
        resultRows = deleted;
      }

      if (this.orders.length > 0) {
        resultRows = [...resultRows].sort((a, b) => {
          for (const { column, ascending } of this.orders) {
            if (a[column] < b[column]) return ascending ? -1 : 1;
            if (a[column] > b[column]) return ascending ? 1 : -1;
          }
          return 0;
        });
      }

      const enriched = resultRows.map((r) => enrichRow(this.table, r, this.selectSpec));

      if (this.expectSingle) {
        if (enriched.length === 0) {
          return {
            data: null,
            error: { message: 'Registro não encontrado.', code: 'PGRST116' }
          };
        }
        return { data: enriched[0], error: null };
      }

      if (this.expectMaybeSingle) {
        return { data: enriched[0] || null, error: null };
      }

      return { data: enriched, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message, code: 'INTERNAL_ERROR' } };
    }
  }

  then(resolve, reject) {
    return Promise.resolve(this._execute()).then(resolve, reject);
  }
}

function createMockSupabaseClient(schema = DB_SCHEMA) {
  return {
    schemaName: schema,
    isMock: true,
    schema(customSchema) {
      return createMockSupabaseClient(customSchema);
    },
    from(table) {
      return new MockQueryBuilder(table, schema);
    }
  };
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const hasRealCredentials =
  Boolean(supabaseUrl) &&
  Boolean(supabaseKey) &&
  !supabaseUrl.includes('seu-projeto.supabase.co') &&
  !supabaseKey.includes('sua-anon-ou-service-role-key') &&
  process.env.NODE_ENV !== 'test';

const supabaseOptions = {
  db: {
    schema: DB_SCHEMA
  },
  auth: {
    persistSession: false
  }
};

const supabase =
  hasRealCredentials && typeof createClient === 'function'
    ? createClient(supabaseUrl, supabaseKey, supabaseOptions)
    : createMockSupabaseClient(DB_SCHEMA);

module.exports = {
  supabase,
  DB_SCHEMA,
  supabaseOptions,
  resetMockDb,
  createMockSupabaseClient
};
