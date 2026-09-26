import { ethers } from 'ethers';
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { settleOrder, findOrderForPayment, expireOrders } from './orders.js';

const net = ethers.Network.from(config.network.chainId);
const makeProvider = (url) => new ethers.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1 });

export const provider = makeProvider(config.rpcUrl);
const provider2 = config.rpcUrl2 ? makeProvider(config.rpcUrl2) : null;

const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const iface = new ethers.Interface(TRANSFER_ABI);
const usdc = new ethers.Contract(config.network.usdc, TRANSFER_ABI, provider);
const USDC = config.network.usdc.toLowerCase();
const WALLET = config.wallet.toLowerCase();
const TRANSFER_TOPIC = iface.getEvent('Transfer').topicHash;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a tx from one RPC and return how much USDC it sent to our wallet.
 * state: 'pending' (not mined / not enough confirmations) | 'failed' | 'ok'
 */
async function readPayment(p, txHash) {
  const receipt = await p.getTransactionReceipt(txHash);
  if (!receipt) return { state: 'pending' };
  if (receipt.status !== 1) return { state: 'failed' };

  const latest = await p.getBlockNumber();
  if (latest - receipt.blockNumber + 1 < config.confirmations) return { state: 'pending' };

  let value = 0n;
  let from = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC) continue;           // only the real USDC contract
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const { args } = iface.parseLog(log);
    if (args.to.toLowerCase() !== WALLET) continue;             // only transfers to our wallet
    value += args.value;
    from = args.from;
  }
  return { state: 'ok', value, from, block: receipt.blockNumber };
}

/** Verify with the main RPC, and with the second RPC too if one is configured. */
async function verifiedPayment(txHash) {
  const a = await readPayment(provider, txHash);
  if (a.state !== 'ok' || !provider2) return a;
  const b = await readPayment(provider2, txHash);
  if (b.state === 'pending') return b;
  if (b.state !== 'ok' || b.value !== a.value) {
    console.warn(`[chain] RPC mismatch for ${txHash}; not settling`);
    return { state: 'pending' };
  }
  return a;
}

/** Record a transfer we saw: settle the matching order, or park it for the admin. */
function handlePayment(txHash, payer, value, block) {
  if (value === 0n) return;
  if (db.prepare('SELECT 1 FROM orders WHERE tx_hash = ?').get(txHash)) return;

  const order = findOrderForPayment(value.toString(), txHash);
  if (order) {
    settleOrder(order.id, txHash, payer);
  } else {
    db.prepare(`INSERT OR IGNORE INTO unmatched_payments(tx_hash, payer, value_units, block_number, seen_at)
                VALUES(?, ?, ?, ?, ?)`).run(txHash, payer, value.toString(), block, Date.now());
    console.warn(`[chain] unmatched payment ${txHash}: ${value} units from ${payer}`);
  }
}

/**
 * Fast path: the browser sent us a txHash right after paying.
 * Wait for confirmations, then verify on-chain. Runs in the background.
 */
const inFlight = new Set();
export async function verifyClaim(txHash) {
  if (inFlight.has(txHash)) return;
  inFlight.add(txHash);
  try {
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      const r = await verifiedPayment(txHash).catch((e) => {
        console.warn(`[chain] verify ${txHash}: ${e.shortMessage || e.message}`);
        return { state: 'pending' };
      });
      if (r.state === 'failed') return;
      if (r.state === 'ok') return handlePayment(txHash, r.from, r.value, r.block);
      await sleep(2500);
    }
    // Not confirmed in 3 minutes: the polling listener will still pick it up.
  } finally {
    inFlight.delete(txHash);
  }
}

/**
 * Backup path: every POLL_INTERVAL_MS, read USDC Transfer logs to our wallet
 * from confirmed blocks. Remembers the last block in the DB, so after a restart
 * it catches up on anything it missed.
 */
export async function startListener() {
  let last = Number(getMeta('last_block'));
  if (!last) {
    const head = await provider.getBlockNumber();
    last = (config.startBlock ?? head) - 1;
    setMeta('last_block', last);
  }
  console.log(`[chain] listening on ${config.network.name} from block ${last + 1} every ${config.pollIntervalMs / 1000}s`);

  const filter = usdc.filters.Transfer(null, config.wallet);
  const CHUNK = 500;

  for (;;) {
    try {
      const expired = expireOrders();
      if (expired) console.log(`[orders] expired ${expired} unpaid order(s)`);

      const confirmed = (await provider.getBlockNumber()) - config.confirmations + 1;
      while (confirmed > last) {
        const to = Math.min(confirmed, last + CHUNK);
        const logs = await usdc.queryFilter(filter, last + 1, to);

        // A single tx can carry several transfers; add them up per tx.
        const byTx = new Map();
        for (const log of logs) {
          const cur = byTx.get(log.transactionHash) || { value: 0n, from: log.args.from, block: log.blockNumber };
          cur.value += log.args.value;
          byTx.set(log.transactionHash, cur);
        }
        for (const [hash, p] of byTx) {
          if (provider2) {
            const check = await verifiedPayment(hash);
            // Second RPC not caught up yet: stop here and retry this range next round.
            if (check.state === 'pending') throw new Error(`waiting for second RPC on ${hash}`);
            if (check.state !== 'ok') continue;
          }
          handlePayment(hash, p.from, p.value, p.block);
        }

        last = to;
        setMeta('last_block', last);
      }
    } catch (e) {
      console.error(`[chain] listener error: ${e.shortMessage || e.message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}
