// Node's built-in SQLite: nothing to compile, so no Node-version mismatch errors on deploy.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = config.dbPath || path.join(dir, '..', 'store.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * db.transaction(fn) -> function that runs fn inside BEGIN/COMMIT and rolls
 * back if fn throws. Nested calls join the outer transaction.
 */
let depth = 0;
db.transaction = (fn) => (...args) => {
  if (depth > 0) return fn(...args);
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  brand          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'Shopping',
  face_value_inr INTEGER NOT NULL,
  discount_pct   REAL NOT NULL DEFAULT 0,
  color          TEXT NOT NULL DEFAULT '#2A6F97',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'available',  -- available | reserved | sold
  order_id   TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(product_id, code)
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  email          TEXT,
  amount_units   TEXT NOT NULL,          -- exact token amount in base units (USDT on BSC = 18 decimals)
  usdc_inr_rate  REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | paid | needs_code | expired
  claimed_tx     TEXT,                   -- txHash sent by the browser (not trusted until verified)
  tx_hash        TEXT UNIQUE,            -- verified payment tx
  payer          TEXT,
  code_id        INTEGER REFERENCES codes(id),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  paid_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_amount ON orders(amount_units, status);

-- Payments that reached the wallet but matched no order (wrong amount, very late, etc.)
CREATE TABLE IF NOT EXISTS unmatched_payments (
  tx_hash      TEXT PRIMARY KEY,
  payer        TEXT NOT NULL,
  value_units  TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL
);

-- ---------- AI token billing ----------
CREATE TABLE IF NOT EXISTS billing_accounts (
  wallet        TEXT PRIMARY KEY,      -- lowercase 0x address
  label         TEXT,
  email         TEXT,
  api_key_hash  TEXT UNIQUE,
  api_key_hint  TEXT,                  -- last 4 chars, to recognise the key
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet      TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  cost_units  TEXT NOT NULL,           -- token base units (USDT: 18 decimals)
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'admin',   -- admin | api
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_wallet ON usage_events(wallet, created_at);

CREATE TABLE IF NOT EXISTS billing_charges (
  id           TEXT PRIMARY KEY,       -- bytes32 invoice id sent to the contract
  wallet       TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  status       TEXT NOT NULL,          -- pending | sent | paid | failed
  tx_hash      TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_wallet ON billing_charges(wallet, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- migrations (safe to run on every start) ----------
function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
// Multi-network payments: which network/token an order is paid with.
addColumn('orders', 'network', 'TEXT');
addColumn('orders', 'token_symbol', 'TEXT');
addColumn('orders', 'token_address', 'TEXT');
addColumn('orders', 'decimals', 'INTEGER');
addColumn('unmatched_payments', 'network', 'TEXT');
addColumn('unmatched_payments', 'token_symbol', 'TEXT');
addColumn('unmatched_payments', 'decimals', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_pay ON orders(network, token_address, amount_units, status)');
// Older single-network rows: attach them to the main network.
{
  const main = config.network;
  db.prepare(`UPDATE orders SET network = ?, token_symbol = ?, token_address = ?, decimals = ? WHERE network IS NULL`)
    .run(main.key, main.token.symbol, main.token.address, main.token.decimals);
  db.prepare(`UPDATE unmatched_payments SET network = ?, token_symbol = ?, decimals = ? WHERE network IS NULL`)
    .run(main.key, main.token.symbol, main.token.decimals);
  // listener position used to be one global key
  const old = db.prepare(`SELECT value FROM meta WHERE key = 'last_block'`).get();
  if (old) {
    db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)`).run(`last_block:${main.key}`, old.value);
    db.prepare(`DELETE FROM meta WHERE key = 'last_block'`).run();
  }
}

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Seed a few sample products on first run so the store isn't empty.
const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (count === 0) {
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO products(name, brand, category, face_value_inr, discount_pct, color, created_at)
                          VALUES(?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Shopping card', 'Sample Store', 'Shopping', 500, 6, '#2A6F97', now);
  ins.run('Shopping card', 'Sample Store', 'Shopping', 1000, 7, '#2A6F97', now);
  ins.run('Gaming wallet top-up', 'Sample Games', 'Gaming', 1000, 5, '#7B2D8E', now);
  ins.run('Food delivery credit', 'Sample Eats', 'Food', 750, 8, '#C8553D', now);
  ins.run('Streaming, 3 months', 'Sample Stream', 'Entertainment', 499, 4, '#1F7A5C', now);
}
