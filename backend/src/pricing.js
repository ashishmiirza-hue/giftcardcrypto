import { config } from './config.js';

let rate = config.usdcInrFallback;
let source = 'fallback';
let updatedAt = 0;

// Two free sources; if both fail (rate limits on shared hosts are common),
// the last good rate or USDC_INR_FALLBACK is used.
const SOURCES = [
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/exchange-rates?currency=USDC',
    read: (d) => Number(d?.data?.rates?.INR),
  },
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=inr',
    read: (d) => Number(d?.['usd-coin']?.inr),
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

/** Price in USDC base units (6 decimals), rounded UP to the nearest cent. */
export function priceUnits(product, usdcInr = rate) {
  const inr = product.face_value_inr * (1 - product.discount_pct / 100);
  const cents = Math.ceil((inr / usdcInr) * 100);
  return BigInt(cents) * 10000n; // 1 cent = 10_000 units
}

export function formatUnits(units) {
  const u = BigInt(units);
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.padEnd(2, '0')}` : `${whole}.00`;
}
