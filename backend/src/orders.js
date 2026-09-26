import crypto from 'node:crypto';
import { db } from './db.js';
import { config, findOption, findNetwork, publicNetwork } from './config.js';
import { activeOptions, isOptionEnabled } from './payments.js';
import { getRate, priceUnits, formatUnits, tailStep } from './pricing.js';

const lateMs = () => config.latePaymentHours * 3600 * 1000;

export class OrderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Orders whose exact amount is still "reserved": open, or expired recently enough
 * that a late payment could still arrive. No two of these may share an amount,
 * which is how an incoming transfer is matched to exactly one order.
 */
function amountTaken(networkKey, tokenAddress, amountUnits, now) {
  return !!db.prepare(`
    SELECT 1 FROM orders
    WHERE network = ? AND token_address = ? AND amount_units = ? AND tx_hash IS NULL
      AND (status = 'pending' OR (status = 'expired' AND expires_at > ?))
    LIMIT 1`).get(networkKey, tokenAddress, amountUnits, now - lateMs());
}

export const createOrder = db.transaction((productId, email, payWith) => {
  if (payWith && !(findOption(payWith) && isOptionEnabled(payWith))) {
    throw new OrderError(400, 'That payment method is not available right now. Pick another one.');
  }
  const option = payWith ? findOption(payWith) : activeOptions()[0];
  if (!option) throw new OrderError(503, 'Payments are paused right now. Please try again later.');
  const { network, token } = option;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) throw new OrderError(404, 'This card is no longer available.');

  const code = db.prepare(`SELECT id FROM codes WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT 1`).get(productId);
  if (!code) throw new OrderError(409, 'This card is out of stock right now.');

  const now = Date.now();
  const { rate } = getRate(token.symbol);
  const base = priceUnits(product, rate, token.decimals);

  // Add a unique 0.0001–0.0099 tail so the exact amount identifies the order
  // (99 open orders per price point).
  let amount = null;
  for (let i = 0; i < 300; i++) {
    const candidate = (base + BigInt(crypto.randomInt(1, 100)) * tailStep(token.decimals)).toString();
    if (!amountTaken(network.key, token.address, candidate, now)) { amount = candidate; break; }
  }
  if (!amount) throw new OrderError(503, 'Too many open orders at this price. Try again in a minute.');

  const id = crypto.randomBytes(8).toString('hex');
  const accessToken = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO orders(id, access_token, product_id, email, amount_units, usdc_inr_rate, created_at, expires_at,
                                 network, token_symbol, token_address, decimals)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, accessToken, productId, email || null, amount, rate, now, now + config.orderTtlMin * 60 * 1000,
      network.key, token.symbol, token.address, token.decimals);
  db.prepare(`UPDATE codes SET status = 'reserved', order_id = ? WHERE id = ?`).run(id, code.id);

  return { id, token: accessToken };
});

/** Customer wants a different payment method: drop this order and free its code. */
export const cancelOrder = db.transaction((orderId) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'pending' || o.claimed_tx || o.tx_hash) return false;
  // Expire it but keep its amount reserved for the late-payment window, in case
  // the customer had already sent money.
  db.prepare(`UPDATE orders SET status = 'expired', expires_at = ? WHERE id = ?`).run(Date.now(), orderId);
  db.prepare(`UPDATE codes SET status = 'available', order_id = NULL WHERE status = 'reserved' AND order_id = ?`).run(orderId);
  return true;
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

/** Find the open order a transfer of exactly `valueUnits` of this token on this network belongs to. */
export function findOrderForPayment(networkKey, tokenAddress, valueUnits, txHash) {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM orders
    WHERE network = ? AND lower(token_address) = lower(?) AND amount_units = ? AND tx_hash IS NULL
      AND (status = 'pending' OR (status = 'expired' AND expires_at > ?))
    ORDER BY (claimed_tx = ?) DESC, created_at DESC
    LIMIT 1`).get(networkKey, tokenAddress, valueUnits, now - lateMs(), txHash);
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
  const net = findNetwork(order.network);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  const code = order.status === 'paid' && order.code_id
    ? db.prepare('SELECT code FROM codes WHERE id = ?').get(order.code_id)?.code
    : null;
  return {
    id: order.id,
    status: order.status,
    product: { name: product.name, brand: product.brand, face_value_inr: product.face_value_inr, color: product.color },
    amount_units: order.amount_units,
    amount: formatUnits(order.amount_units, order.decimals),
    network: net ? publicNetwork(net) : { key: order.network, name: order.network, family: 'evm' },
    token: { symbol: order.token_symbol, address: order.token_address, decimals: order.decimals },
    recipient: net?.recipient || null,
    expires_at: order.expires_at,
    claimed_tx: order.claimed_tx,
    tx_hash: order.tx_hash,
    code,
  };
}
