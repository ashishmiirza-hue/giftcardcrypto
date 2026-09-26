import { config } from './config.js';

// INR per 1 token, per symbol (USDT, USDC).
const symbols = [...new Set(config.payOptions.map((o) => o.token.symbol))];
const rates = Object.fromEntries(symbols.map((s) => [s, { rate: config.inrFallback, source: 'fallback', updatedAt: 0 }]));

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const sane = (r) => r > 50 && r < 200;   // one bad API response can't reprice the store

async function refreshSymbol(sym) {
  const ids = config.priceIds[sym];
  if (!ids) return;
  const tries = [
    ['coinbase', async () => Number((await fetchJson(`https://api.coinbase.com/v2/exchange-rates?currency=${ids.coinbase}`))?.data?.rates?.INR)],
    ['coingecko', async () => Number((await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.coingecko}&vs_currencies=inr`))?.[ids.coingecko]?.inr)],
  ];
  const errors = [];
  for (const [name, get] of tries) {
    try {
      const r = await get();
      if (!sane(r)) throw new Error(`rate out of range: ${r}`);
      rates[sym] = { rate: r, source: name, updatedAt: Date.now() };
      return;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  console.warn(`[pricing] ${sym} rate refresh failed (${errors.join('; ')}); using ₹${rates[sym].rate} (${rates[sym].source})`);
}

const refresh = () => Promise.all(symbols.map(refreshSymbol));

export function startPricing() {
  refresh();
  setInterval(refresh, 10 * 60 * 1000);
}

/** INR per 1 unit of `symbol` (defaults to the main network's token). */
export function getRate(symbol = config.network.token.symbol) {
  return rates[symbol] || rates[symbols[0]] || { rate: config.inrFallback, source: 'fallback', updatedAt: 0 };
}
export const allRates = () => ({ ...rates });

const pow10 = (n) => 10n ** BigInt(n);
export const centUnits = (decimals) => pow10(decimals - 2);          // 0.01 token
export const tailStep = (decimals) => pow10(decimals - 4);           // 0.0001 token

/** Price in token base units, rounded UP to the nearest cent. */
export function priceUnits(product, inrPerToken, decimals = config.network.token.decimals) {
  const inr = product.face_value_inr * (1 - product.discount_pct / 100);
  const cents = Math.ceil((inr / inrPerToken) * 100);
  return BigInt(cents) * centUnits(decimals);
}

/** Base units -> "12.3456" (at least 2 decimals, trailing zeros trimmed beyond that). */
export function formatUnits(units, decimals = config.network.token.decimals) {
  const u = BigInt(units);
  const one = pow10(decimals);
  const whole = u / one;
  const frac = (u % one).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${frac.padEnd(2, '0')}`;
}
