# Controle Social Jovens

Sistema Web de **Frente de Caixa, Controle de Estoque Opcional e Fechamento Financeiro** desenvolvido em **Node.js (Express + EJS)** integrado ao **Supabase (PostgreSQL)** utilizando estritamente o schema `"controle-social-jovens"`.

## Arquitetura do Projeto

```text
controle-social-jovens/
├── sql/
│   └── schema.sql                 # DDL completo e seed no schema "controle-social-jovens"
├── src/
│   ├── config/
│   │   └── supabase.js            # Cliente Supabase configurado com db.schema = 'controle-social-jovens' + In-Memory Mock
│   ├── routes/
│   │   ├── categoriesRoutes.js    # GET /categories, POST /categories
│   │   ├── productsRoutes.js      # GET /products, POST /products
│   │   ├── ordersRoutes.js        # GET /orders, POST /orders, PATCH /orders/:id/pay
│   │   └── cashClosingRoutes.js   # GET /cash-closing
│   ├── views/
│   │   └── index.ejs              # Interface Web (Frente de Caixa + Relatório de Fechamento)
│   ├── app.js                     # Configuração do Express
│   └── server.js                  # Inicialização do servidor HTTP
├── .env.example                   # Exemplo de variáveis de ambiente
└── package.json
```

## Configuração do Banco de Dados no Supabase

1. No painel do Supabase, acesse **SQL Editor** e execute o conteúdo de `sql/schema.sql`.
2. Para permitir que a API PostgREST do Supabase acesse o schema customizado:
   - Acesse **Project Settings -> API -> Data API Settings -> Exposed schemas**.
   - Adicione `controle-social-jovens` à lista de schemas expostos.
3. Copie `.env.example` para `.env` e preencha `SUPABASE_URL` e `SUPABASE_KEY`.

## Endpoints Principais

- `GET /categories` e `POST /categories`: Listagem e cadastro de categorias.
- `GET /products` e `POST /products`: Listagem e cadastro de produtos (`stock_quantity: null` para produtos sem controle de estoque, ou inteiro `>= 0` para produtos com abatimento automático).
- `GET /orders` e `POST /orders`: Listagem (com filtro `?payment_status=pendente|pago`) e criação de pedidos com cálculo automático de `total_amount` e baixa automática de estoque apenas para produtos controlados.
- `PATCH /orders/:id/pay`: Dá baixa em pedidos pendentes, alterando `payment_status` para `'pago'`.
- `GET /cash-closing`: Relatório consolidado de fechamento de caixa com total pago por forma de pagamento (`by_payment_method`), total pendente ("na rua") e listagem de pedidos pendentes.
