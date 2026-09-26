import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { getRate, priceUnits, formatUnits } from './pricing.js';

const lateMs = () => config.latePaymentHours * 3600 * 1000;

export class OrderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Orders whose exact amount is still "reserved": open, or expired recently enough
 * that a late payment could still arrive. No two of these may share an amount,
 * which is how an incoming transfer is matched to exactly one order.
 */
function amountTaken(amountUnits, now) {
  return !!db.prepare(`
    SELECT 1 FROM orders
    WHERE amount_units = ? AND tx_hash IS NULL
      AND (status = 'pending' OR (status = 'expired' AND expires_at > ?))
    LIMIT 1`).get(amountUnits, now - lateMs());
}

export const createOrder = db.transaction((productId, email) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) throw new OrderError(404, 'This card is no longer available.');

  const code = db.prepare(`SELECT id FROM codes WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT 1`).get(productId);
  if (!code) throw new OrderError(409, 'This card is out of stock right now.');

  const now = Date.now();
  const { rate } = getRate();
  const base = priceUnits(product, rate);

  // Add a unique 0.0001–0.0099 USDC tail so the amount identifies the order.
  // (1 unit = 0.000001 USDC, so 0.0001 = 100 units; 99 open orders per price point.)
  let amount = null;
  for (let i = 0; i < 300; i++) {
    const candidate = (base + BigInt(crypto.randomInt(1, 100)) * 100n).toString();
    if (!amountTaken(candidate, now)) { amount = candidate; break; }
  }
  if (!amount) throw new OrderError(503, 'Too many open orders at this price. Try again in a minute.');

  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO orders(id, access_token, product_id, email, amount_units, usdc_inr_rate, created_at, expires_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, token, productId, email || null, amount, rate, now, now + config.orderTtlMin * 60 * 1000);
  db.prepare(`UPDATE codes SET status = 'reserved', order_id = ? WHERE id = ?`).run(id, code.id);

  return { id, token };
});

/** Mark an order paid for a verified transfer and hand over a code. Idempotent. */
export const settleOrder = db.transaction((orderId, txHash, payer) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.tx_hash) return false;
  if (db.prepare('SELECT 1 FROM orders WHERE tx_hash = ?').get(txHash)) return false;

  // Prefer the code reserved at checkout; after expiry it may have been released.
  const code = db.prepare(`SELECT id FROM codes WHERE status = 'reserved' AND order_id = ?`).get(orderId)
          || db.prepare(`SELECT id FROM codes WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT 1`).get(order.product_id);

  if (code) {
    db.prepare(`UPDATE codes SET status = 'sold', order_id = ? WHERE id = ?`).run(orderId, code.id);
  }
  db.prepare(`UPDATE orders SET status = ?, tx_hash = ?, payer = ?, code_id = ?, paid_at = ? WHERE id = ?`)
    .run(code ? 'paid' : 'needs_code', txHash, payer, code?.id ?? null, Date.now(), orderId);
  db.prepare('DELETE FROM unmatched_payments WHERE tx_hash = ?').run(txHash);

  console.log(`[orders] ${orderId} paid via ${txHash}${code ? '' : ' (waiting for stock)'}`);
  return true;
});

/** Find the open order a transfer of exactly `valueUnits` belongs to. */
export function findOrderForPayment(valueUnits, txHash) {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM orders
    WHERE amount_units = ? AND tx_hash IS NULL
      AND (status = 'pending' OR (status = 'expired' AND expires_at > ?))
    ORDER BY (claimed_tx = ?) DESC, created_at DESC
    LIMIT 1`).get(valueUnits, now - lateMs(), txHash);
}

export function expireOrders() {
  const now = Date.now();
  const stale = db.prepare(`SELECT id FROM orders WHERE status = 'pending' AND expires_at <= ?`).all(now);
  const tx = db.transaction(() => {
    for (const { id } of stale) {
      db.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?`).run(id);
      db.prepare(`UPDATE codes SET status = 'available', order_id = NULL WHERE status = 'reserved' AND order_id = ?`).run(id);
    }
  });
  tx();
  return stale.length;
}

/** After new codes are added, deliver them to paid orders that were waiting for stock. */
export const fulfillWaiting = db.transaction((productId) => {
  const waiting = db.prepare(`SELECT id FROM orders WHERE product_id = ? AND status = 'needs_code' ORDER BY paid_at`).all(productId);
  let done = 0;
  for (const { id } of waiting) {
    const code = db.prepare(`SELECT id FROM codes WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT 1`).get(productId);
    if (!code) break;
    db.prepare(`UPDATE codes SET status = 'sold', order_id = ? WHERE id = ?`).run(id, code.id);
    db.prepare(`UPDATE orders SET status = 'paid', code_id = ? WHERE id = ?`).run(code.id, id);
    done++;
  }
  return done;
});

export function getOrderForCustomer(id, token) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const a = Buffer.from(order.access_token);
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return order;
}

export function publicOrder(order) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  const code = order.status === 'paid' && order.code_id
    ? db.prepare('SELECT code FROM codes WHERE id = ?').get(order.code_id)?.code
    : null;
  return {
    id: order.id,
    status: order.status,
    product: { name: product.name, brand: product.brand, face_value_inr: product.face_value_inr, color: product.color },
    amount_units: order.amount_units,
    amount: formatUnits(order.amount_units),
    expires_at: order.expires_at,
    claimed_tx: order.claimed_tx,
    tx_hash: order.tx_hash,
    code,
  };
}
