import { config } from './config.js';

let rate = config.usdcInrFallback;
let source = 'fallback';
let updatedAt = 0;

async function refresh() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=inr',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const r = Number(data?.['usd-coin']?.inr);
    // Sanity range so one bad API response can't reprice the whole store
    if (!(r > 50 && r < 200)) throw new Error(`rate out of range: ${r}`);
    rate = r;
    source = 'coingecko';
    updatedAt = Date.now();
  } catch (e) {
    console.warn(`[pricing] rate refresh failed (${e.message}); using ${rate} (${source})`);
  }
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
