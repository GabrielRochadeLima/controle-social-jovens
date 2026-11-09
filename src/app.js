const fs = require('fs');
const path = require('path');
const express = require('express');
const { DB_SCHEMA } = require('./config/supabase');

const categoriesRoutes = require('./routes/categoriesRoutes');
const productsRoutes = require('./routes/productsRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const cashClosingRoutes = require('./routes/cashClosingRoutes');

const app = express();
const rootDir = path.join(__dirname, '..');

// Configurações de Middlewares e View Engine
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Arquivos de PWA (Manifest, Service Worker e Ícones)
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.end(fs.readFileSync(path.join(rootDir, 'manifest.json')));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.end(fs.readFileSync(path.join(rootDir, 'sw.js')));
});

app.get('/icon-192.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.end(fs.readFileSync(path.join(rootDir, 'icon-192.png')));
});

app.get('/icon-512.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.end(fs.readFileSync(path.join(rootDir, 'icon-512.png')));
});

// Interface Web (Frente de Caixa e Relatório)
app.get('/', (req, res) => {
  res.render('index', { schema: DB_SCHEMA });
});

// Status / Healthcheck da API
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    project: 'controle-social-jovens',
    schema: DB_SCHEMA
  });
});

// Rotas REST principais
app.use('/categories', categoriesRoutes);
app.use('/products', productsRoutes);
app.use('/orders', ordersRoutes);
app.use('/cash-closing', cashClosingRoutes);

module.exports = app;
