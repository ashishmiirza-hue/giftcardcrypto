/*
 * AI token billing
 *
 * Users approve the TokenBilling contract on USDT and set their own limits on-chain.
 * Usage is recorded here (by the admin, or by your AI service through the service API).
 * The admin presses "Charge" in the admin panel; this server (the keeper wallet)
 * then calls TokenBilling.charge(), which moves USDT from the user to the treasury
 * only within the user's limits.
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { provider } from './chain.js';
import { formatUnits } from './pricing.js';
import BILLING_ABI from './billing-abi.json' with { type: 'json' };

const DEC = config.network.token.decimals;
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const enabled = !!config.billing.contract;
const billing = enabled ? new ethers.Contract(config.billing.contract, BILLING_ABI, provider) : null;
const token = new ethers.Contract(config.network.token.address, ERC20_ABI, provider);
const keeper = enabled && config.billing.keeperKey ? new ethers.Wallet(config.billing.keeperKey, provider) : null;

export class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new BillingError(status, msg); };
const lc = (a) => String(a || '').toLowerCase();
const fmt = (u) => formatUnits(u);
const now = () => Date.now();

// ------------------------------------------------------------------ settings

export function getSettings() {
  const num = (k, d) => { const v = Number(getMeta(`billing:${k}`)); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    pricePer1k: num('pricePer1k', config.billing.pricePer1k),
    defaultApprove: num('defaultApprove', config.billing.defaultApprove),
    defaultMaxPerCharge: num('defaultMaxPerCharge', config.billing.defaultMaxPerCharge),
    defaultMaxPerPeriod: num('defaultMaxPerPeriod', config.billing.defaultMaxPerPeriod),
  };
}

function saveSettings(body) {
  const out = {};
  for (const k of ['pricePer1k', 'defaultApprove', 'defaultMaxPerCharge', 'defaultMaxPerPeriod']) {
    if (body[k] === undefined || body[k] === '') continue;
    const v = Number(body[k]);
    need(Number.isFinite(v) && v > 0 && v < 1e9, 400, `${k} must be a positive number.`);
    out[k] = v;
  }
  const merged = { ...getSettings(), ...out };
  need(merged.defaultMaxPerCharge <= merged.defaultMaxPerPeriod, 400, 'Default per-charge limit cannot be above the 30-day limit.');
  for (const [k, v] of Object.entries(out)) setMeta(`billing:${k}`, v);
  return getSettings();
}

/** Cost of `tokens` AI tokens in USDT base units, rounded up. */
function costUnits(tokens) {
  const per1k = ethers.parseUnits(getSettings().pricePer1k.toFixed(8), DEC);
  return (BigInt(tokens) * per1k + 999n) / 1000n;
}

// ------------------------------------------------------------------ ledger

function ledger(wallet) {
  const w = lc(wallet);
  const usage = db.prepare('SELECT tokens, cost_units FROM usage_events WHERE wallet = ?').all(w);
  const charges = db.prepare(`SELECT amount_units, status FROM billing_charges WHERE wallet = ?`).all(w);
  const used = usage.reduce((a, r) => a + BigInt(r.cost_units), 0n);
  const tokens = usage.reduce((a, r) => a + Number(r.tokens), 0);
  const paid = charges.filter((c) => c.status === 'paid').reduce((a, c) => a + BigInt(c.amount_units), 0n);
  const inFlight = charges.filter((c) => c.status === 'pending' || c.status === 'sent').reduce((a, c) => a + BigInt(c.amount_units), 0n);
  const due = used - paid - inFlight;
  return { tokens, usedUnits: used, paidUnits: paid, inFlightUnits: inFlight, dueUnits: due > 0n ? due : 0n };
}

export function addUsage(wallet, tokens, note, source) {
  need(ethers.isAddress(wallet), 400, 'Wallet address is not valid.');
  const t = Math.round(Number(tokens));
  need(Number.isInteger(t) && t > 0 && t < 1e12, 400, 'Tokens must be a positive whole number.');
  const w = lc(wallet);
  const acct = db.prepare('SELECT wallet, blocked FROM billing_accounts WHERE wallet = ?').get(w);
  need(acct, 404, 'This wallet has not signed up for AI tokens yet.');
  const cost = costUnits(t);
  db.prepare(`INSERT INTO usage_events(wallet, tokens, cost_units, note, source, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
    .run(w, t, cost.toString(), note ? String(note).slice(0, 200) : null, source, now());
  return { wallet: w, tokens: t, cost: fmt(cost), due: fmt(ledger(w).dueUnits) };
}

// ------------------------------------------------------------------ chain reads

async function onChain(wallet) {
  if (!enabled) return null;
  const [acc, remaining, allowance, balance] = await Promise.all([
    billing.accounts(wallet),
    billing.remainingInPeriod(wallet),
    token.allowance(wallet, config.billing.contract),
    token.balanceOf(wallet),
  ]);
  return {
    active: acc.active,
    maxPerCharge: acc.maxPerCharge,
    maxPerPeriod: acc.maxPerPeriod,
    periodStart: Number(acc.periodStart) * 1000,
    spentInPeriod: acc.spentInPeriod,
    remaining,
    allowance,
    balance,
  };
}

const showChain = (c) => c && ({
  active: c.active,
  maxPerCharge: fmt(c.maxPerCharge),
  maxPerPeriod: fmt(c.maxPerPeriod),
  spentInPeriod: fmt(c.spentInPeriod),
  remainingInPeriod: fmt(c.remaining),
  periodResets: c.periodStart ? c.periodStart + 30 * 86400 * 1000 : null,
  allowance: c.allowance > 10n ** BigInt(DEC + 12) ? 'unlimited' : fmt(c.allowance),
  balance: fmt(c.balance),
});

/** Largest amount that can be charged right now, and why it might be zero. */
function chargeable(chain, dueUnits) {
  if (!chain?.active) return { max: 0n, reason: 'User is not enrolled on-chain (never activated, or cancelled).' };
  const caps = [
    [dueUnits, 'Nothing is due.'],
    [chain.maxPerCharge, 'Per-charge limit is 0.'],
    [chain.remaining, "User's 30-day limit is used up."],
    [chain.allowance, 'User has not approved enough USDT (or revoked approval).'],
    [chain.balance, "User's wallet doesn't have enough USDT."],
  ];
  let max = caps[0][0]; let reason = caps[0][1];
  for (const [v, r] of caps) if (v < max) { max = v; reason = r; }
  return { max: max > 0n ? max : 0n, reason: max > 0n ? null : reason };
}

// ------------------------------------------------------------------ sessions (sign-in with wallet)

const sessions = new Map();
setInterval(() => { const t = now(); for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k); }, 3600e3);

function loginMessage(wallet, iso) {
  return `Sign in to ${config.storeName} AI tokens\nWallet: ${ethers.getAddress(wallet)}\nTime: ${iso}`;
}

function login({ wallet, time, signature }) {
  need(ethers.isAddress(wallet), 400, 'Wallet address is not valid.');
  const t = Date.parse(time);
  need(Number.isFinite(t) && Math.abs(now() - t) < 10 * 60e3, 400, 'Sign-in request expired. Try again.');
  let signer;
  try { signer = ethers.verifyMessage(loginMessage(wallet, time), signature); } catch { signer = null; }
  need(signer && lc(signer) === lc(wallet), 401, 'Signature does not match this wallet.');
  const tokenStr = crypto.randomBytes(24).toString('base64url');
  sessions.set(tokenStr, { wallet: lc(wallet), exp: now() + 24 * 3600e3 });
  return tokenStr;
}

function sessionWallet(req) {
  const tok = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(tok);
  need(s && s.exp > now(), 401, 'Please sign in with your wallet again.');
  return s.wallet;
}

// ------------------------------------------------------------------ API keys

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');
function walletForApiKey(apiKey) {
  if (!apiKey) return null;
  return db.prepare('SELECT * FROM billing_accounts WHERE api_key_hash = ?').get(hashKey(String(apiKey)));
}

// ------------------------------------------------------------------ keeper charges (one at a time)

let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

function revertReason(e) {
  const inner = e?.error?.message || e?.info?.error?.message || '';
  if (/nonce/i.test(inner) || e?.code === 'NONCE_EXPIRED') return 'keeper wallet was busy with another transaction, press Charge again';
  if (/insufficient funds/i.test(inner) || e?.code === 'INSUFFICIENT_FUNDS') return `keeper wallet needs more ${config.network.gasToken} for gas`;
  return e?.reason || e?.revert?.args?.[0] || inner || e?.shortMessage || e?.message || 'unknown error';
}

export function charge(walletIn, amountIn) {
  return serial(async () => {
    need(enabled, 400, 'Billing contract is not configured (BILLING_CONTRACT).');
    need(keeper, 400, 'Keeper wallet is not configured (KEEPER_PRIVATE_KEY). Charges are disabled.');
    need(ethers.isAddress(walletIn), 400, 'Wallet address is not valid.');
    const wallet = lc(walletIn);
    need(db.prepare('SELECT 1 FROM billing_accounts WHERE wallet = ?').get(wallet), 404, 'Unknown wallet.');

    let chain;
    try { chain = await onChain(wallet); }
    catch (e) { throw new BillingError(503, `Blockchain is not reachable right now (${e.shortMessage || e.code || e.message}). Try again in a minute.`); }
    const { dueUnits } = ledger(wallet);
    const cap = chargeable(chain, dueUnits);

    let amount;
    if (amountIn !== undefined && amountIn !== null && String(amountIn).trim() !== '') {
      try { amount = ethers.parseUnits(String(amountIn).trim(), DEC); } catch { throw new BillingError(400, 'Amount is not a valid number.'); }
      need(amount > 0n, 400, 'Amount must be more than 0.');
      need(amount <= dueUnits, 400, `Amount is more than what's due (${fmt(dueUnits)}).`);
    } else {
      need(cap.max > 0n, 400, cap.reason);
      amount = cap.max;
    }

    const id = ethers.hexlify(crypto.randomBytes(32));
    db.prepare(`INSERT INTO billing_charges(id, wallet, amount_units, status, created_at, updated_at) VALUES(?, ?, ?, 'pending', ?, ?)`)
      .run(id, wallet, amount.toString(), now(), now());
    const fail = (msg) => {
      db.prepare(`UPDATE billing_charges SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(String(msg).slice(0, 300), now(), id);
      return new BillingError(400, `Charge failed: ${msg}`);
    };

    const c = billing.connect(keeper);
    // Dry run first: a failing charge costs no gas and gives a clear reason.
    try { await c.charge.staticCall(ethers.getAddress(wallet), amount, id); }
    catch (e) { throw fail(revertReason(e)); }

    let tx;
    try { tx = await c.charge(ethers.getAddress(wallet), amount, id); }
    catch (e) { throw fail(revertReason(e)); }
    db.prepare(`UPDATE billing_charges SET status = 'sent', tx_hash = ?, updated_at = ? WHERE id = ?`).run(tx.hash, now(), id);

    try {
      const receipt = await tx.wait(1, 120e3);
      if (receipt?.status === 1) {
        db.prepare(`UPDATE billing_charges SET status = 'paid', updated_at = ? WHERE id = ?`).run(now(), id);
      } else {
        throw fail('transaction reverted');
      }
    } catch (e) {
      if (e instanceof BillingError) throw e;
      // Timed out waiting: leave as "sent"; reconcile() will settle it.
      console.warn(`[billing] charge ${id} still pending: ${e.message}`);
    }
    return publicCharge(db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(id));
  });
}

/** Settle charges stuck in "sent" (e.g. server restarted while waiting). */
export async function reconcile() {
  if (!enabled) return;
  const stuck = db.prepare(`SELECT * FROM billing_charges WHERE status = 'sent'`).all();
  for (const ch of stuck) {
    try {
      const r = await provider.getTransactionReceipt(ch.tx_hash);
      if (!r) continue;
      db.prepare(`UPDATE billing_charges SET status = ?, updated_at = ? WHERE id = ?`).run(r.status === 1 ? 'paid' : 'failed', now(), ch.id);
    } catch { /* retry next round */ }
  }
  // "pending" rows older than 10 minutes never made it to the chain
  db.prepare(`UPDATE billing_charges SET status = 'failed', error = 'not sent', updated_at = ? WHERE status = 'pending' AND created_at < ?`).run(now(), now() - 10 * 60e3);
}

const publicCharge = (c) => ({
  id: c.id, wallet: c.wallet, amount: fmt(c.amount_units), status: c.status,
  tx_hash: c.tx_hash, error: c.error, created_at: c.created_at,
});

// ------------------------------------------------------------------ routes

export function mountBilling(app, { wrap, rateLimit }) {
  const serviceKeys = [process.env.SERVICE_API_KEY, config.adminKey].filter(Boolean).map((k) => String(k).trim());
  const service = (req, res, next) => {
    const k = String(req.get('x-service-key') || req.get('x-admin-key') || '');
    const ok = serviceKeys.some((s) => s.length === k.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(k)));
    if (!ok) return res.status(401).json({ error: 'Wrong service key.' });
    next();
  };

  // ---------- public ----------
  app.get('/api/billing/config', (req, res) => {
    const s = getSettings();
    res.json({
      enabled,
      contract: config.billing.contract,
      network: config.network,
      pricePer1k: s.pricePer1k,
      defaults: { approve: s.defaultApprove, maxPerCharge: s.defaultMaxPerCharge, maxPerPeriod: s.defaultMaxPerPeriod },
    });
  });

  app.get('/api/billing/login-message', (req, res) => {
    const wallet = String(req.query.wallet || '');
    if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Wallet address is not valid.' });
    const time = new Date().toISOString();
    res.json({ time, message: loginMessage(wallet, time) });
  });

  app.post('/api/billing/login', rateLimit(30, 10 * 60e3), wrap((req, res) => {
    res.json({ session: login(req.body || {}) });
  }));

  // Called after the user activates on-chain. Only works if the chain agrees.
  app.post('/api/billing/register', rateLimit(20, 10 * 60e3), wrap(async (req, res) => {
    need(enabled, 400, 'AI billing is not set up yet.');
    const wallet = sessionWallet(req);
    const chain = await onChain(wallet);
    need(chain.active, 400, 'Activation not found on-chain yet. Wait a few seconds and try again.');
    const email = String(req.body?.email || '').trim().slice(0, 200) || null;
    db.prepare(`INSERT INTO billing_accounts(wallet, email, created_at) VALUES(?, ?, ?)
                ON CONFLICT(wallet) DO UPDATE SET email = COALESCE(excluded.email, billing_accounts.email)`).run(wallet, email, now());
    res.json({ ok: true });
  }));

  app.get('/api/billing/me', wrap(async (req, res) => {
    const wallet = sessionWallet(req);
    const acct = db.prepare('SELECT * FROM billing_accounts WHERE wallet = ?').get(wallet);
    const chain = enabled ? await onChain(wallet) : null;
    const l = ledger(wallet);
    res.json({
      wallet,
      registered: !!acct,
      blocked: !!acct?.blocked,
      apiKeyHint: acct?.api_key_hint || null,
      chain: showChain(chain),
      tokensUsed: l.tokens,
      used: fmt(l.usedUnits),
      paid: fmt(l.paidUnits),
      due: fmt(l.dueUnits),
      usage: db.prepare('SELECT tokens, cost_units, note, created_at FROM usage_events WHERE wallet = ? ORDER BY id DESC LIMIT 50').all(wallet)
        .map((u) => ({ tokens: u.tokens, cost: fmt(u.cost_units), note: u.note, created_at: u.created_at })),
      charges: db.prepare('SELECT * FROM billing_charges WHERE wallet = ? ORDER BY created_at DESC LIMIT 50').all(wallet).map(publicCharge),
    });
  }));

  app.post('/api/billing/api-key', rateLimit(10, 10 * 60e3), wrap(async (req, res) => {
    const wallet = sessionWallet(req);
    const acct = db.prepare('SELECT * FROM billing_accounts WHERE wallet = ?').get(wallet);
    need(acct, 400, 'Activate AI tokens first.');
    need(!acct.blocked, 403, 'This account is blocked. Contact support.');
    const key = `sk_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE billing_accounts SET api_key_hash = ?, api_key_hint = ? WHERE wallet = ?').run(hashKey(key), key.slice(-4), wallet);
    res.json({ apiKey: key, note: 'Copy it now. It will not be shown again. Creating a new key disables the old one.' });
  }));

  // ---------- for your AI service (server to server) ----------
  // Check a customer's API key before serving a request.
  app.post('/api/service/check', service, wrap(async (req, res) => {
    const acct = walletForApiKey(req.body?.apiKey);
    if (!acct) return res.json({ ok: false, reason: 'unknown api key' });
    if (acct.blocked) return res.json({ ok: false, wallet: acct.wallet, reason: 'blocked by admin' });
    const chain = await onChain(acct.wallet);
    const l = ledger(acct.wallet);
    const ok = chain?.active && chain.allowance > 0n;
    res.json({
      ok: !!ok,
      wallet: acct.wallet,
      reason: ok ? null : !chain?.active ? 'not active on-chain (cancelled?)' : 'approval revoked',
      due: fmt(l.dueUnits),
      remainingInPeriod: chain ? fmt(chain.remaining) : null,
    });
  }));

  // Report usage after serving a request.
  app.post('/api/service/usage', service, wrap((req, res) => {
    const b = req.body || {};
    const acct = b.apiKey ? walletForApiKey(b.apiKey) : null;
    const wallet = acct?.wallet || b.wallet;
    need(wallet, 400, 'Send apiKey or wallet.');
    res.json(addUsage(wallet, b.tokens, b.note, 'api'));
  }));

  // ---------- admin (protected by the /api/admin middleware in server.js) ----------
  app.get('/api/admin/billing', wrap(async (req, res) => {
    const settings = getSettings();
    const status = { enabled, contract: config.billing.contract, keeperConfigured: !!keeper, problems: [] };
    if (enabled) {
      try {
        const [paused, onchainKeeper, treasury, owner, tokenAddr] = await Promise.all([
          billing.paused(), billing.keeper(), billing.treasury(), billing.owner(), billing.token(),
        ]);
        Object.assign(status, { paused, keeper: onchainKeeper, treasury, owner, token: tokenAddr });
        if (lc(tokenAddr) !== lc(config.network.token.address)) status.problems.push(`Contract token ${tokenAddr} is not the store's ${config.network.token.symbol} (${config.network.token.address}). Redeploy with the right token.`);
        if (keeper && lc(onchainKeeper) !== lc(keeper.address)) status.problems.push(`KEEPER_PRIVATE_KEY belongs to ${keeper.address}, but the contract's keeper is ${onchainKeeper}. Call setKeeper from the owner wallet.`);
        if (paused) status.problems.push('Contract is paused: charges will fail until the owner unpauses it.');
      } catch (e) {
        status.problems.push(`Could not read the billing contract: ${e.shortMessage || e.message}. Check BILLING_CONTRACT and NETWORK.`);
      }
    }
    if (keeper) {
      status.keeperAddress = keeper.address;
      try {
        const bal = await provider.getBalance(keeper.address);
        status.keeperGas = ethers.formatEther(bal);
        if (bal < ethers.parseEther('0.002')) status.problems.push(`Keeper wallet is low on ${config.network.gasToken} for gas.`);
      } catch { /* shown as unknown */ }
    }

    const accounts = db.prepare('SELECT * FROM billing_accounts ORDER BY created_at DESC LIMIT 200').all();
    const rows = await Promise.all(accounts.map(async (a) => {
      const l = ledger(a.wallet);
      let chain = null; let err = null;
      try { chain = await onChain(a.wallet); } catch (e) { err = e.shortMessage || e.message; }
      const cap = chain ? chargeable(chain, l.dueUnits) : { max: 0n, reason: err };
      return {
        wallet: a.wallet, email: a.email, label: a.label, blocked: !!a.blocked, apiKeyHint: a.api_key_hint, created_at: a.created_at,
        tokensUsed: l.tokens, used: fmt(l.usedUnits), paid: fmt(l.paidUnits), inFlight: fmt(l.inFlightUnits), due: fmt(l.dueUnits),
        chain: showChain(chain), chargeableNow: fmt(cap.max), cannotChargeReason: cap.reason,
      };
    }));
    const charges = db.prepare('SELECT * FROM billing_charges ORDER BY created_at DESC LIMIT 200').all().map(publicCharge);
    const totalPaid = db.prepare(`SELECT amount_units FROM billing_charges WHERE status = 'paid'`).all().reduce((a, r) => a + BigInt(r.amount_units), 0n);
    res.json({ settings, status, accounts: rows, charges, totals: { accounts: rows.length, paid: fmt(totalPaid) } });
  }));

  app.post('/api/admin/billing/settings', wrap((req, res) => res.json({ settings: saveSettings(req.body || {}) })));

  app.post('/api/admin/billing/usage', wrap((req, res) => {
    const b = req.body || {};
    res.json(addUsage(b.wallet, b.tokens, b.note, 'admin'));
  }));

  app.post('/api/admin/billing/charge', wrap(async (req, res) => {
    const b = req.body || {};
    res.json({ charge: await charge(b.wallet, b.amount) });
  }));

  app.post('/api/admin/billing/account', wrap((req, res) => {
    const b = req.body || {};
    need(ethers.isAddress(b.wallet || ''), 400, 'Wallet address is not valid.');
    const r = db.prepare('UPDATE billing_accounts SET label = COALESCE(?, label), blocked = COALESCE(?, blocked) WHERE wallet = ?')
      .run(b.label !== undefined ? String(b.label).slice(0, 80) : null, b.blocked !== undefined ? (b.blocked ? 1 : 0) : null, lc(b.wallet));
    need(r.changes, 404, 'Unknown wallet.');
    res.json({ ok: true });
  }));

  if (enabled) {
    reconcile();
    setInterval(() => reconcile().catch(() => {}), 60e3);
    console.log(`[billing] contract ${config.billing.contract}${keeper ? `, keeper ${keeper.address}` : ' (no keeper key: charges disabled)'}`);
  }
}
