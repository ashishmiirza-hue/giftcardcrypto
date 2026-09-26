import { config } from './config.js';

let rate = config.inrFallback;
let source = 'fallback';
let updatedAt = 0;

// Two free sources; if both fail (rate limits on shared hosts are common),
// the last good rate or INR_RATE_FALLBACK is used.
const SOURCES = [
  {
    name: 'coinbase',
    url: `https://api.coinbase.com/v2/exchange-rates?currency=${config.network.price.coinbase}`,
    read: (d) => Number(d?.data?.rates?.INR),
  },
  {
    name: 'coingecko',
    url: `https://api.coingecko.com/api/v3/simple/price?ids=${config.network.price.coingecko}&vs_currencies=inr`,
    read: (d) => Number(d?.[config.network.price.coingecko]?.inr),
  },
];

async function refresh() {
  const errors = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = src.read(await res.json());
      // Sanity range so one bad API response can't reprice the whole store
      if (!(r > 50 && r < 200)) throw new Error(`rate out of range: ${r}`);
      rate = r;
      source = src.name;
      updatedAt = Date.now();
      return;
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  console.warn(`[pricing] rate refresh failed (${errors.join('; ')}); using ₹${rate} (${source})`);
}

export function startPricing() {
  refresh();
  setInterval(refresh, 10 * 60 * 1000);
}

export function getRate() {
  return { rate, source, updatedAt };
}

const DEC = BigInt(config.network.token.decimals);
const ONE = 10n ** DEC;              // 1 token in base units
export const CENT = 10n ** (DEC - 2n); // 0.01 token
export const TAIL_STEP = 10n ** (DEC - 4n); // 0.0001 token

/** Price in token base units, rounded UP to the nearest cent. */
export function priceUnits(product, inrPerToken = rate) {
  const inr = product.face_value_inr * (1 - product.discount_pct / 100);
  const cents = Math.ceil((inr / inrPerToken) * 100);
  return BigInt(cents) * CENT;
}

/** Base units -> "12.3456" (at least 2 decimals, no trailing zeros beyond that). */
export function formatUnits(units) {
  const u = BigInt(units);
  const whole = u / ONE;
  const frac = (u % ONE).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return `${whole}.${frac.padEnd(2, '0')}`;
}
