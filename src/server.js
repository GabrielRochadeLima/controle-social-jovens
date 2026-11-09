const dotenv = require('dotenv');
dotenv.config();

const app = require('./app');
const { DB_SCHEMA, supabase } = require('./config/supabase');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  const mode = supabase.isMock ? 'Modo Local (In-Memory Mock)' : 'Conectado ao Supabase';
  console.log(`=============================================================`);
  console.log(`🚀 Controle Social Jovens rodando em http://localhost:${PORT}`);
  console.log(`📦 Schema configurado: "${DB_SCHEMA}" (${mode})`);
  console.log(`=============================================================`);
});
