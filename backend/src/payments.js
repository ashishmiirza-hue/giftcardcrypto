/*
 * Which payment options (network + coin) customers can use at checkout.
 * Switched on/off from the admin panel; saved in the database.
 */
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';

const KEY = 'payments:enabled';

function load() {
  try {
    const saved = JSON.parse(getMeta(KEY) || 'null');
    if (Array.isArray(saved)) return new Set(saved.filter((id) => config.payOptions.some((o) => o.id === id)));
  } catch { /* fall back to defaults */ }
  return new Set(config.defaultEnabled);
}

let enabled = load();
if (!enabled.size) enabled = new Set(config.defaultEnabled);

export const isOptionEnabled = (id) => enabled.has(id);
export const activeOptions = () => config.payOptions.filter((o) => enabled.has(o.id));
export const isNetworkEnabled = (key) => config.payOptions.some((o) => o.network.key === key && enabled.has(o.id));

export class PaymentsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Replace the set of enabled options. At least one must stay on. */
export function setEnabledOptions(ids) {
  if (!Array.isArray(ids)) throw new PaymentsError(400, 'Send a list of payment options.');
  const valid = new Set(config.payOptions.map((o) => o.id));
  const next = new Set();
  for (const id of ids) {
    if (!valid.has(id)) throw new PaymentsError(400, `"${id}" can't be switched on (unknown, or its network is missing a setting).`);
    next.add(id);
  }
  if (!next.size) throw new PaymentsError(400, 'Keep at least one payment option on, or customers cannot pay.');
  enabled = next;
  setMeta(KEY, JSON.stringify([...next]));
  return [...next];
}

/** Orders on this network that could still receive a payment (open, or expired within the late window). */
export function openOrdersOn(key) {
  const lateMs = config.latePaymentHours * 3600e3;
  return db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE network = ? AND tx_hash IS NULL
                     AND (status = 'pending' OR (status = 'expired' AND expires_at > ?))`).get(key, Date.now() - lateMs).n;
}

/**
 * Should the server keep watching this network? Yes while it is switched on,
 * and also after it is switched off for as long as any order on it could
 * still be paid (so a customer who already paid still gets their code).
 */
export function needsWatching(key) {
  return isNetworkEnabled(key) || openOrdersOn(key) > 0;
}
