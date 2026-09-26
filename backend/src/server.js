import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { startPricing, getRate, priceUnits, formatUnits } from './pricing.js';
import {
  createOrder, getOrderForCustomer, publicOrder, fulfillWaiting, OrderError,
} from './orders.js';
import { verifyClaim, startListener, chainStatus } from './chain.js';
import { mountBilling, BillingError } from './billing.js';

const app = express();
app.disable('x-powered-by');
// Kitne proxies ke peeche hai server: Render = 1, Netlify proxy + Render = 2.
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  // Optional CORS: only needed if the sites call the backend URL directly
  // instead of going through the Netlify /api proxy.
  const origin = req.get('origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type, x-admin-key, x-service-key, authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  network: config.network.key,
  blockchain: chainStatus.ok ? 'connected' : 'not connected',
  lastBlock: chainStatus.lastBlock,
  problem: chainStatus.error,
}));

// ---------- tiny per-IP rate limiter ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000);

const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof OrderError || e instanceof BillingError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  });

// ---------- public store API ----------
app.get('/api/config', (req, res) => {
  res.json({
    storeName: config.storeName,
    projectId: config.reownProjectId,
    network: { ...config.network, browserRpc: config.browserRpc },
    recipient: config.wallet,
    orderTtlMin: config.orderTtlMin,
  });
});

function productRow(p, rate) {
  const stock = db.prepare(`SELECT COUNT(*) AS n FROM codes WHERE product_id = ? AND status = 'available'`).get(p.id).n;
  return {
    id: p.id, name: p.name, brand: p.brand, category: p.category,
    face_value_inr: p.face_value_inr, discount_pct: p.discount_pct, color: p.color,
    price: formatUnits(priceUnits(p, rate)),
    in_stock: stock,
  };
}

app.get('/api/products', (req, res) => {
  const { rate } = getRate();
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, face_value_inr').all();
  res.json({ rate, products: rows.map((p) => productRow(p, rate)) });
});

app.post('/api/orders', rateLimit(10, 10 * 60 * 1000), wrap((req, res) => {
  const productId = Number(req.body?.productId);
  const email = String(req.body?.email || '').trim().slice(0, 200);
  if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Pick a card first.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email address looks incomplete.' });
  const { id, token } = createOrder(productId, email);
  const order = getOrderForCustomer(id, token);
  res.status(201).json({ token, order: publicOrder(order) });
}));

app.get('/api/orders/:id', wrap((req, res) => {
  const order = getOrderForCustomer(req.params.id, req.query.token);
  if (!order) return res.status(404).json({ error: 'Order not found. Check the link you used.' });
  res.json({ order: publicOrder(order) });
}));

// Browser reports the txHash right after the wallet sends the payment.
app.post('/api/orders/:id/tx', rateLimit(20, 10 * 60 * 1000), wrap((req, res) => {
  const order = getOrderForCustomer(req.params.id, req.body?.token);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const txHash = String(req.body?.txHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return res.status(400).json({ error: 'That transaction ID is not valid.' });
  if (order.tx_hash) return res.json({ order: publicOrder(order) });

  // The hash is only a hint. Nothing is marked paid until the chain confirms
  // the exact amount reached our wallet in the real token contract.
  db.prepare('UPDATE orders SET claimed_tx = ? WHERE id = ?').run(txHash, order.id);
  verifyClaim(txHash);
  res.json({ order: publicOrder({ ...order, claimed_tx: txHash }) });
}));

// ---------- admin API ----------
function admin(req, res, next) {
  const a = Buffer.from(String(req.get('x-admin-key') || ''));
  const b = Buffer.from(config.adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong admin key.' });
  next();
}
app.use('/api/admin', rateLimit(120, 60 * 1000), admin);

// AI token billing (public, service and admin routes)
mountBilling(app, { wrap, rateLimit });

app.get('/api/admin/overview', (req, res) => {
  const { rate, source, updatedAt } = getRate();
  const products = db.prepare('SELECT * FROM products ORDER BY id').all().map((p) => ({
    ...productRow(p, rate),
    active: !!p.active,
    sold: db.prepare(`SELECT COUNT(*) AS n FROM codes WHERE product_id = ? AND status = 'sold'`).get(p.id).n,
    reserved: db.prepare(`SELECT COUNT(*) AS n FROM codes WHERE product_id = ? AND status = 'reserved'`).get(p.id).n,
  }));
  const orders = db.prepare(`
    SELECT o.id, o.status, o.email, o.amount_units, o.tx_hash, o.claimed_tx, o.payer, o.created_at, o.paid_at,
           p.name AS product_name, p.face_value_inr
    FROM orders o JOIN products p ON p.id = o.product_id
    ORDER BY o.created_at DESC LIMIT 200`).all().map((o) => ({ ...o, amount: formatUnits(o.amount_units) }));
  const unmatched = db.prepare('SELECT * FROM unmatched_payments ORDER BY seen_at DESC LIMIT 100').all()
    .map((u) => ({ ...u, amount: formatUnits(u.value_units) }));
  // Summed as BigInt: 18-decimal amounts overflow SQLite integers.
  const paidRows = db.prepare(`SELECT amount_units FROM orders WHERE status IN ('paid','needs_code')`).all();
  const totals = { n: paidRows.length, units: paidRows.reduce((a, r) => a + BigInt(r.amount_units), 0n) };
  res.json({
    rate: { rate, source, updatedAt },
    network: config.network, wallet: config.wallet, chain: chainStatus,
    totals: { orders: totals.n, received: formatUnits(totals.units) },
    products, orders, unmatched,
  });
});

const COLOR = /^#[0-9a-fA-F]{6}$/;
function readProduct(body, partial = false) {
  const out = {};
  const str = (k, max) => { if (body[k] !== undefined) out[k] = String(body[k]).trim().slice(0, max); };
  str('name', 80); str('brand', 60); str('category', 40);
  if (body.face_value_inr !== undefined) out.face_value_inr = Math.round(Number(body.face_value_inr));
  if (body.discount_pct !== undefined) out.discount_pct = Number(body.discount_pct);
  if (body.color !== undefined) out.color = String(body.color);
  if (body.active !== undefined) out.active = body.active ? 1 : 0;

  if (!partial && (!out.name || !out.brand || !out.face_value_inr)) throw new OrderError(400, 'Name, brand and face value are required.');
  if (out.face_value_inr !== undefined && !(out.face_value_inr > 0)) throw new OrderError(400, 'Face value must be more than 0.');
  if (out.discount_pct !== undefined && !(out.discount_pct >= 0 && out.discount_pct < 90)) throw new OrderError(400, 'Discount must be between 0 and 90.');
  if (out.color !== undefined && !COLOR.test(out.color)) throw new OrderError(400, 'Colour must be a hex value like #2A6F97.');
  return out;
}

app.post('/api/admin/products', wrap((req, res) => {
  const p = readProduct(req.body || {});
  const r = db.prepare(`INSERT INTO products(name, brand, category, face_value_inr, discount_pct, color, created_at)
                        VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.brand, p.category || 'Shopping', p.face_value_inr, p.discount_pct ?? 0, p.color || '#2A6F97', Date.now());
  res.status(201).json({ id: r.lastInsertRowid });
}));

app.patch('/api/admin/products/:id', wrap((req, res) => {
  const p = readProduct(req.body || {}, true);
  const keys = Object.keys(p);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const r = db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => p[k]), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
}));

app.post('/api/admin/products/:id/codes', wrap((req, res) => {
  const productId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) return res.status(404).json({ error: 'Product not found.' });
  const lines = String(req.body?.codes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Paste at least one code, one per line.' });
  if (lines.length > 5000) return res.status(400).json({ error: 'Add at most 5,000 codes at a time.' });
  const ins = db.prepare('INSERT OR IGNORE INTO codes(product_id, code, created_at) VALUES(?, ?, ?)');
  const now = Date.now();
  let added = 0;
  db.transaction(() => { for (const c of lines) added += ins.run(productId, c.slice(0, 200), now).changes; })();
  const delivered = fulfillWaiting(productId);
  res.json({ added, duplicates: lines.length - added, delivered });
}));

// ---------- websites ----------
// If store/ and admin/ have been built (npm run build), serve them from this
// same server: store at /, admin at /admin/. This is the "everything on one
// Render service" setup. With Netlify, the dist folders don't exist here and
// only the API runs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const storeDist = path.join(root, 'store', 'dist');
const adminDist = path.join(root, 'admin', 'dist');
if (fs.existsSync(adminDist)) {
  app.use('/admin', (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('X-Frame-Options', 'DENY'); next(); },
    express.static(adminDist));
}
if (fs.existsSync(storeDist)) {
  app.use(express.static(storeDist));
} else {
  app.get('/', (req, res) => res.type('text').send(`${config.storeName} API is running on ${config.network.name}.`));
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- start ----------
startPricing();
app.listen(config.port, () => {
  console.log(`[server] ${config.storeName} on http://localhost:${config.port}  (${config.network.name})`);
  console.log(`[server] payments go to ${config.wallet}`);
});
// The site stays up even if the RPC is down; the listener keeps retrying.
startListener().catch((e) => console.error('[chain] listener stopped:', e.message));
