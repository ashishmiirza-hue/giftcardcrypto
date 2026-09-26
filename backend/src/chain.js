import { ethers } from 'ethers';
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { settleOrder, findOrderForPayment, expireOrders } from './orders.js';
import { needsWatching } from './payments.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const iface = new ethers.Interface(TRANSFER_ABI);
const TRANSFER_TOPIC = iface.getEvent('Transfer').topicHash;

// AI-billing charges pull USDT from customers into the treasury on the main
// network. If the treasury is also RECEIVING_WALLET, those transfers must never
// be treated as gift-card payments.
const BILLING = (process.env.BILLING_CONTRACT || '').trim().toLowerCase();
function isBillingTx(networkKey, txHash, logs) {
  if (networkKey !== config.network.key) return false;
  if (db.prepare('SELECT 1 FROM billing_charges WHERE tx_hash = ?').get(txHash)) return true;
  return !!(BILLING && logs?.some((l) => l.address.toLowerCase() === BILLING));
}

// ------------------------------------------------------------------ status per network
/** e.g. { bsc: { ok, lastBlock, error, family }, tron: {...} } */
export const networkStatus = Object.fromEntries(config.networks.map((n) => [n.key, { ok: false, lastBlock: null, error: null, family: n.family, watching: false }]));
/** Main network status (health checks, AI billing). */
export const chainStatus = networkStatus[config.network.key];

function rpcHint(n, e) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`;
  const ankr = n.ankr ? `https://rpc.ankr.com/${n.ankr}/KEY` : 'apna RPC';
  const envKey = n.key === config.network.key ? 'RPC_URL' : `RPC_URL_${n.key.toUpperCase()}`;
  if (/does not exist|not available|UNSUPPORTED_OPERATION|-32601/i.test(m)) return `${envKey} ${n.name} ka normal RPC nahi lagta. Sahi format: ${ankr}`;
  if (/401|403|unauthori|api key/i.test(m)) return `${envKey} ki key galat hai ya expire ho gayi.`;
  if (/429|408|timeout|rate|retry limit|too many/i.test(m)) return `Free public RPC ne limit laga di. ${envKey} mein apna RPC daalo (${ankr}).`;
  return `${envKey} check karo.`;
}

// ------------------------------------------------------------------ recording payments

/** A confirmed transfer reached one of our wallets: settle the matching order, or park it. */
function handlePayment(n, tokenAddress, txHash, payer, value, block) {
  if (value === 0n) return;
  if (isBillingTx(n.key, txHash)) return;
  if (db.prepare('SELECT 1 FROM orders WHERE tx_hash = ?').get(txHash)) return;

  const token = n.tokens.find((t) => t.address.toLowerCase() === String(tokenAddress).toLowerCase());
  if (!token) return;
  const order = findOrderForPayment(n.key, token.address, value.toString(), txHash);
  if (order) {
    settleOrder(order.id, txHash, payer);
  } else if (!db.prepare('SELECT 1 FROM unmatched_payments WHERE tx_hash = ?').get(txHash)) {
    db.prepare(`INSERT OR IGNORE INTO unmatched_payments(tx_hash, payer, value_units, block_number, seen_at, network, token_symbol, decimals)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(txHash, payer, value.toString(), Number(block) || 0, Date.now(), n.key, token.symbol, token.decimals);
    console.warn(`[${n.key}] unmatched ${token.symbol} payment ${txHash}: ${value} units from ${payer}`);
  }
}

// ------------------------------------------------------------------ EVM networks

class EvmWatcher {
  constructor(n, rpcUrl, rpcUrl2) {
    this.n = n;
    const net = ethers.Network.from(n.chainId);
    // cacheTimeout -1: never reuse a cached nonce/receipt (back-to-back keeper charges need fresh nonces)
    const make = (url) => new ethers.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1, cacheTimeout: -1 });
    this.provider = make(rpcUrl);
    this.provider2 = rpcUrl2 ? make(rpcUrl2) : null;
    this.tokenAddrs = n.tokens.map((t) => t.address.toLowerCase());
    this.wallet = n.recipient.toLowerCase();
    this.walletTopic = ethers.zeroPadValue(n.recipient, 32);
    this.inFlight = new Set();
    this.status = networkStatus[n.key];
  }

  /** How much of which accepted token this tx sent to our wallet. */
  async readPayment(p, txHash) {
    const receipt = await p.getTransactionReceipt(txHash);
    if (!receipt) return { state: 'pending' };
    if (receipt.status !== 1) return { state: 'failed' };
    const latest = await p.getBlockNumber();
    if (latest - receipt.blockNumber + 1 < this.n.confirmations) return { state: 'pending' };
    if (isBillingTx(this.n.key, txHash, receipt.logs)) return { state: 'ok', value: 0n, block: receipt.blockNumber };

    const sums = new Map();   // token -> { value, from }
    for (const log of receipt.logs) {
      const addr = log.address.toLowerCase();
      if (!this.tokenAddrs.includes(addr) || log.topics[0] !== TRANSFER_TOPIC) continue;   // only real stablecoin contracts
      const { args } = iface.parseLog(log);
      if (args.to.toLowerCase() !== this.wallet) continue;
      const cur = sums.get(addr) || { value: 0n, from: args.from };
      cur.value += args.value;
      sums.set(addr, cur);
    }
    const [token, s] = [...sums.entries()][0] || [null, { value: 0n, from: null }];
    return { state: 'ok', token, value: s.value, from: s.from, block: receipt.blockNumber };
  }

  async verifiedPayment(txHash) {
    const a = await this.readPayment(this.provider, txHash);
    if (a.state !== 'ok' || !this.provider2) return a;
    const b = await this.readPayment(this.provider2, txHash);
    if (b.state === 'pending') return b;
    if (b.state !== 'ok' || b.value !== a.value || b.token !== a.token) {
      console.warn(`[${this.n.key}] RPC mismatch for ${txHash}; not settling`);
      return { state: 'pending' };
    }
    return a;
  }

  /** Fast path: the browser reported a txHash right after paying. */
  async verifyClaim(txHash) {
    if (this.inFlight.has(txHash)) return;
    this.inFlight.add(txHash);
    try {
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        const r = await this.verifiedPayment(txHash).catch((e) => {
          console.warn(`[${this.n.key}] verify ${txHash}: ${e.shortMessage || e.message}`);
          return { state: 'pending' };
        });
        if (r.state === 'failed') return;
        if (r.state === 'ok') { if (r.token) handlePayment(this.n, r.token, txHash, r.from, r.value, r.block); return; }
        await sleep(2500);
      }
    } finally {
      this.inFlight.delete(txHash);
    }
  }

  async waitForRpc() {
    for (;;) {
      try {
        const [head, chainIdHex] = await Promise.all([this.provider.getBlockNumber(), this.provider.send('eth_chainId', [])]);
        if (Number(chainIdHex) !== this.n.chainId) throw Object.assign(new Error(`RPC chain ${Number(chainIdHex)} hai, ${this.n.name} ko ${this.n.chainId} chahiye`), { wrongChain: true });
        this.status.ok = true; this.status.error = null;
        return head;
      } catch (e) {
        this.status.ok = false;
        this.status.error = e.wrongChain ? `RPC galat network ka hai (${this.n.name}).` : rpcHint(this.n, e);
        console.error(`[${this.n.key}] RPC se connect nahi ho paya: ${e.shortMessage || e.message}. ${this.status.error} 30s baad dobara.`);
        await sleep(30000);
      }
    }
  }

  /**
   * Backup path: every POLL_INTERVAL_MS read confirmed stablecoin transfers to our wallet.
   * Paused (no RPC calls) while the network is switched off and no order on it can still be paid.
   */
  async run() {
    const metaKey = `last_block:${this.n.key}`;
    const alwaysOn = this.n.key === config.network.key;   // main network: AI billing needs its RPC
    const CHUNK = 500;
    let last = null;
    for (;;) {
      if (!alwaysOn && !needsWatching(this.n.key)) {
        if (this.status.watching) console.log(`[${this.n.key}] switched off, not watching`);
        Object.assign(this.status, { watching: false, ok: null, error: null });
        last = null;
        await sleep(15000);
        continue;
      }
      if (last === null) {
        // (re)start: pick up where we left off, or a little before "now" after a pause
        const head = await this.waitForRpc();
        const saved = Number(getMeta(metaKey));
        const resumeFrom = head - this.n.confirmations - 40;
        last = saved && (alwaysOn || saved >= resumeFrom) ? saved
          : ((alwaysOn && config.startBlock) ? config.startBlock - 1 : resumeFrom);
        setMeta(metaKey, last);
        this.status.watching = true;
        console.log(`[${this.n.key}] watching ${this.n.tokens.map((t) => t.symbol).join('/')} to ${this.n.recipient} from block ${last + 1}`);
      }
      try {
        const confirmed = (await this.provider.getBlockNumber()) - this.n.confirmations + 1;
        while (confirmed > last) {
          const to = Math.min(confirmed, last + CHUNK);
          // one request for all accepted tokens: Transfer(any -> our wallet)
          const logs = await this.provider.getLogs({
            address: this.n.tokens.map((t) => t.address),
            topics: [TRANSFER_TOPIC, null, this.walletTopic],
            fromBlock: last + 1,
            toBlock: to,
          });
          const byTx = new Map();
          for (const log of logs) {
            const { args } = iface.parseLog(log);
            const k = `${log.transactionHash}:${log.address.toLowerCase()}`;
            const cur = byTx.get(k) || { hash: log.transactionHash, token: log.address, value: 0n, from: args.from, block: log.blockNumber };
            cur.value += args.value;
            byTx.set(k, cur);
          }
          for (const p of byTx.values()) {
            if (this.provider2) {
              const check = await this.verifiedPayment(p.hash);
              if (check.state === 'pending') throw new Error(`waiting for second RPC on ${p.hash}`);
              if (check.state !== 'ok') continue;
            }
            handlePayment(this.n, p.token, p.hash, p.from, p.value, p.block);
          }
          last = to;
          setMeta(metaKey, last);
        }
        this.status.ok = true; this.status.error = null; this.status.lastBlock = last;
      } catch (e) {
        this.status.ok = false;
        this.status.error = rpcHint(this.n, e);
        console.error(`[${this.n.key}] listener error: ${e.shortMessage || e.message}`);
      }
      await sleep(config.pollIntervalMs);
    }
  }
}

// ------------------------------------------------------------------ TRON (TRC-20 via TronGrid)

class TronWatcher {
  constructor(n) {
    this.n = n;
    this.status = networkStatus[n.key];
    this.token = n.tokens[0];
    this.headers = { accept: 'application/json', ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}) };
  }

  async page(minTs, fingerprint) {
    const u = new URL(`${this.n.api}/v1/accounts/${this.n.recipient}/transactions/trc20`);
    u.searchParams.set('only_to', 'true');
    u.searchParams.set('only_confirmed', 'true');
    u.searchParams.set('limit', '200');
    u.searchParams.set('contract_address', this.token.address);
    u.searchParams.set('min_timestamp', String(minTs));
    u.searchParams.set('order_by', 'block_timestamp,asc');
    if (fingerprint) u.searchParams.set('fingerprint', fingerprint);
    const res = await fetch(u, { headers: this.headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) throw new Error('429 rate limited');
    if (!res.ok) throw new Error(`TronGrid HTTP ${res.status}`);
    return res.json();
  }

  async run() {
    const metaKey = 'last_ts:tron';
    const interval = Math.max(config.pollIntervalMs, config.tronApiKey ? 8000 : 15000);
    let last = null;
    for (;;) {
      if (!needsWatching(this.n.key)) {
        if (this.status.watching) console.log('[tron] switched off, not watching');
        Object.assign(this.status, { watching: false, ok: null, error: null });
        last = null;
        await sleep(15000);
        continue;
      }
      if (last === null) {
        const saved = Number(getMeta(metaKey));
        const resumeFrom = Date.now() - 10 * 60 * 1000;
        last = saved && saved >= resumeFrom ? saved : resumeFrom;
        this.status.watching = true;
        console.log(`[tron] watching USDT (TRC-20) to ${this.n.recipient}`);
      }
      try {
        // re-read the last few minutes each round; duplicates are ignored
        let fingerprint = null; let maxTs = last;
        const since = Math.max(0, last - 3 * 60 * 1000);
        do {
          const j = await this.page(since, fingerprint);
          for (const t of j.data || []) {
            if (t.token_info?.address !== this.token.address || t.to !== this.n.recipient || t.type !== 'Transfer') continue;
            handlePayment(this.n, this.token.address, t.transaction_id, t.from, BigInt(t.value), t.block_timestamp);
            if (t.block_timestamp > maxTs) maxTs = t.block_timestamp;
          }
          fingerprint = j.meta?.fingerprint || null;
        } while (fingerprint);
        last = maxTs;
        setMeta(metaKey, last);
        this.status.ok = true; this.status.error = null; this.status.lastBlock = last;
      } catch (e) {
        this.status.ok = false;
        this.status.error = /429/.test(e.message)
          ? 'TronGrid ne limit laga di. TRONGRID_API_KEY daalo (trongrid.io par free milti hai).'
          : `TronGrid se connect nahi ho paya (${e.message}).`;
        console.error(`[tron] ${this.status.error}`);
      }
      await sleep(interval);
    }
  }
}

// ------------------------------------------------------------------ wiring

const evm = Object.fromEntries(config.networks.filter((n) => n.family === 'evm' && n.ready).map((n) => [
  n.key,
  new EvmWatcher(n, n.rpcUrl, n.key === config.network.key ? config.rpcUrl2 : null),
]));

/** Main network provider (AI billing, keeper). */
export const provider = evm[config.network.key].provider;

/** Fast path for EVM orders. TRON payments are picked up by the watcher. */
export function verifyClaim(networkKey, txHash) {
  const w = evm[networkKey];
  if (w) w.verifyClaim(txHash);
}

export async function startListener() {
  // expire unpaid orders on a timer, independent of any network's RPC
  const expire = () => { try { const n = expireOrders(); if (n) console.log(`[orders] expired ${n} unpaid order(s)`); } catch { /* ignore */ } };
  expire();
  setInterval(expire, 30e3);
  for (const n of config.networks.filter((x) => x.ready)) {
    const w = n.family === 'tron' ? new TronWatcher(n) : evm[n.key];
    w.run().catch((e) => console.error(`[${n.key}] watcher stopped: ${e.message}`));
  }
}
