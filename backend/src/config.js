import 'dotenv/config';
import { ethers } from 'ethers';

// ---------------------------------------------------------------- networks
// family: 'evm' (MetaMask/Trust, 0x addresses) or 'tron' (T... addresses).
// tokens[0] is the network's main token (used for AI billing on the primary network).
const NETWORKS = {
  bsc: {
    key: 'bsc', family: 'evm', name: 'BNB Smart Chain (BEP-20)', short: 'BSC (BEP-20)', chainId: 56,
    tokens: [
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
    gasToken: 'BNB', fee: 'low', explorer: 'https://bscscan.com', publicRpc: 'https://bsc.drpc.org',
    ankr: 'bsc', confirmations: 3,
  },
  tron: {
    key: 'tron', family: 'tron', name: 'TRON (TRC-20)', short: 'TRON (TRC-20)', chainId: null,
    tokens: [{ symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }],
    gasToken: 'TRX', fee: 'medium', explorer: 'https://tronscan.org/#', api: 'https://api.trongrid.io',
  },
  arbitrum: {
    key: 'arbitrum', family: 'evm', name: 'Arbitrum One', short: 'Arbitrum', chainId: 42161,
    tokens: [
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
    gasToken: 'ETH', fee: 'low', explorer: 'https://arbiscan.io', publicRpc: 'https://arb1.arbitrum.io/rpc',
    ankr: 'arbitrum', confirmations: 5,
  },
  polygon: {
    key: 'polygon', family: 'evm', name: 'Polygon', short: 'Polygon', chainId: 137,
    tokens: [
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    ],
    gasToken: 'POL', fee: 'low', explorer: 'https://polygonscan.com', publicRpc: 'https://polygon.drpc.org',
    ankr: 'polygon', confirmations: 5,
  },
  base: {
    key: 'base', family: 'evm', name: 'Base', short: 'Base', chainId: 8453,
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }],
    gasToken: 'ETH', fee: 'low', explorer: 'https://basescan.org', publicRpc: 'https://mainnet.base.org',
    ankr: 'base', confirmations: 2,
  },
  ethereum: {
    key: 'ethereum', family: 'evm', name: 'Ethereum (ERC-20)', short: 'Ethereum (ERC-20)', chainId: 1,
    tokens: [
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
    gasToken: 'ETH', fee: 'high', explorer: 'https://etherscan.io', publicRpc: 'https://ethereum-rpc.publicnode.com',
    ankr: 'eth', confirmations: 3,
  },
  // ---- test networks (single mock token via TOKEN_ADDRESS) ----
  'bsc-testnet': {
    key: 'bsc-testnet', family: 'evm', name: 'BSC Testnet', short: 'BSC Testnet', chainId: 97,
    tokens: [{ symbol: 'USDT', address: null, decimals: 18 }],
    gasToken: 'tBNB', fee: 'low', explorer: 'https://testnet.bscscan.com', publicRpc: 'https://bsc-testnet-rpc.publicnode.com',
    confirmations: 2, testnet: true,
  },
  local: {
    key: 'local', family: 'evm', name: 'Local test chain', short: 'Local', chainId: Number(process.env.LOCAL_CHAIN_ID || 1337),
    tokens: [{ symbol: 'USDT', address: null, decimals: 18 }],
    gasToken: 'ETH', fee: 'low', explorer: '', publicRpc: 'http://127.0.0.1:8545', confirmations: 1, testnet: true,
  },
  'base-sepolia': {
    key: 'base-sepolia', family: 'evm', name: 'Base Sepolia (testnet)', short: 'Base Sepolia', chainId: 84532,
    tokens: [{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }],
    gasToken: 'ETH', fee: 'low', explorer: 'https://sepolia.basescan.org', publicRpc: 'https://sepolia.base.org',
    confirmations: 2, testnet: true,
  },
};

const PRICE_IDS = {
  USDT: { coinbase: 'USDT', coingecko: 'tether' },
  USDC: { coinbase: 'USDC', coingecko: 'usd-coin' },
};

function fail(msg) {
  console.error(`\n[config] ${msg}\n`);
  process.exit(1);
}
function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) fail(`${name} set nahi hai. Render par: Environment tab mein add karo. Local par: backend/.env mein.`);
  return v.trim();
}

// ---------------------------------------------------------------- TRON address helpers
export function isTronAddress(a) {
  try {
    const bytes = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(String(a)), 25));
    if (bytes.length !== 25 || bytes[0] !== 0x41) return false;
    const check = ethers.getBytes(ethers.sha256(ethers.sha256(bytes.slice(0, 21)))).slice(0, 4);
    return check.every((b, i) => b === bytes[21 + i]);
  } catch { return false; }
}

// ---------------------------------------------------------------- primary network (billing, AI page)
const primaryKey = (process.env.NETWORK || 'bsc').trim();
const network = NETWORKS[primaryKey];
if (!network) fail(`NETWORK must be one of: ${Object.keys(NETWORKS).filter((k) => NETWORKS[k].family === 'evm').join(', ')}`);
if (network.family !== 'evm') fail('NETWORK (main network, also used for AI billing) must be an EVM network such as bsc. Add tron in ENABLED_NETWORKS instead.');

// Test networks use your own mock token; mainnets always use the real contracts.
for (const n of Object.values(NETWORKS)) {
  if (n.testnet && !n.tokens[0].address && (n.key === primaryKey)) {
    const t = (process.env.TOKEN_ADDRESS || '').trim();
    if (!ethers.isAddress(t)) fail(`NETWORK=${n.key} ke liye TOKEN_ADDRESS chahiye (apne deploy kiye MockUSDT ka address).`);
    n.tokens = [{ ...n.tokens[0], address: ethers.getAddress(t) }];
  }
}
network.token = network.tokens[0];

// ---------------------------------------------------------------- payment networks
// Every mainnet network is built in and can be switched on/off from the admin
// panel. ENABLED_NETWORKS / ENABLED_TOKENS only decide what is ON the first
// time the server starts (before anyone has touched the admin switches).
const defaultKeys = [...new Set(
  (process.env.ENABLED_NETWORKS || primaryKey).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)];
if (!defaultKeys.includes(primaryKey)) defaultKeys.unshift(primaryKey);
for (const k of defaultKeys) {
  if (!NETWORKS[k]) fail(`ENABLED_NETWORKS mein "${k}" samajh nahi aaya. Ye use karo: bsc, tron, arbitrum, polygon, base, ethereum`);
  if (NETWORKS[k].testnet && k !== primaryKey) fail(`Test network "${k}" sirf NETWORK ke roop mein chal sakta hai.`);
}
// Optional: restrict tokens by default, e.g. ENABLED_TOKENS=USDT  (default: all tokens)
const tokenFilter = (process.env.ENABLED_TOKENS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// ---------------------------------------------------------------- receiving wallets
const wallet = required('RECEIVING_WALLET');
if (!ethers.isAddress(wallet)) fail('RECEIVING_WALLET sahi wallet address nahi hai. 0x se shuru hone wala 42 characters ka address daalo (private key nahi).');

const tronWallet = (process.env.TRON_RECEIVING_WALLET || '').trim() || null;
if (tronWallet && !isTronAddress(tronWallet)) fail('TRON_RECEIVING_WALLET sahi TRON address nahi hai (T... 34 characters).');
if (defaultKeys.includes('tron') && !tronWallet) console.warn('[config] ENABLED_NETWORKS mein tron hai, lekin TRON_RECEIVING_WALLET nahi hai. TRON tab tak band rahega.');

const adminKey = required('ADMIN_KEY');
if (adminKey.length < 16 || adminKey.startsWith('change-this')) fail('ADMIN_KEY kam se kam 16 characters ka hona chahiye, aur "change-this" se shuru nahi.');

/** Server-side RPC per EVM network: RPC_URL_<KEY>, then RPC_URL (main network only), then public. */
function rpcEnvKey(n) { return `RPC_URL_${n.key.toUpperCase().replace(/-/g, '_')}`; }
function serverRpc(n) {
  return (process.env[rpcEnvKey(n)] || '').trim() || (n.key === primaryKey ? (process.env.RPC_URL || '').trim() : '') || n.publicRpc;
}

// Main network first, then every mainnet network (a test main network is only paired with itself).
const availableKeys = network.testnet
  ? [primaryKey, ...defaultKeys.filter((k) => k !== primaryKey)]
  : [primaryKey, ...Object.keys(NETWORKS).filter((k) => k !== primaryKey && !NETWORKS[k].testnet)];

const networks = availableKeys.map((k) => {
  const n = NETWORKS[k];
  const missing = n.family === 'tron' && !tronWallet ? 'TRON_RECEIVING_WALLET' : null;
  return {
    ...n,
    tokens: n.tokens.filter((t) => t.address),
    ready: !missing,
    missing,
    recipient: n.family === 'tron' ? tronWallet : ethers.getAddress(wallet),
    rpcUrl: n.family === 'evm' ? serverRpc(n) : null,
    rpcSource: n.family === 'evm' ? (serverRpc(n) === n.publicRpc ? 'public' : 'custom') : (process.env.TRONGRID_API_KEY ? 'custom' : 'public'),
    rpcEnvKey: n.family === 'evm' ? (k === primaryKey ? 'RPC_URL' : rpcEnvKey(n)) : 'TRONGRID_API_KEY',
    confirmations: n.family === 'evm'
      ? Math.max(1, Number(process.env[`CONFIRMATIONS_${k.toUpperCase().replace(/-/g, '_')}`] || (k === primaryKey && process.env.CONFIRMATIONS) || n.confirmations))
      : null,
  };
});

/** Everything that CAN be switched on, e.g. "bsc:USDT", "tron:USDT" (only networks that have what they need). */
const payOptions = networks.filter((n) => n.ready).flatMap((n) => n.tokens.map((t) => ({ id: `${n.key}:${t.symbol}`, network: n, token: t })));
/** What is ON before the admin changes anything. */
const defaultEnabled = payOptions
  .filter((o) => defaultKeys.includes(o.network.key) && (!tokenFilter.length || tokenFilter.includes(o.token.symbol)))
  .map((o) => o.id);
if (!defaultEnabled.length) defaultEnabled.push(payOptions[0].id);

export const config = {
  storeName: process.env.STORE_NAME || 'Tohfa',
  port: Number(process.env.PORT || 3001),
  // main network: AI billing, default checkout option
  network: networks.find((n) => n.key === primaryKey),
  networks,
  payOptions,
  defaultEnabled,
  priceIds: PRICE_IDS,
  rpcUrl: serverRpc(network),
  rpcUrl2: (process.env.RPC_URL_2 || '').trim() || null,
  wallet: ethers.getAddress(wallet),
  tronWallet,
  tronApiKey: (process.env.TRONGRID_API_KEY || '').trim() || null,
  // Optional. Without it, wallets connect directly (extension / in-wallet browser)
  // and mobile users get "Open in Trust Wallet / MetaMask" buttons.
  reownProjectId: (process.env.REOWN_PROJECT_ID || '').trim() || null,
  // RPC the visitor's browser uses for read-only calls on the main network.
  // Never the server's RPC_URL, which may contain a private key.
  browserRpc: (process.env.BROWSER_RPC_URL || '').trim() || network.publicRpc,
  adminKey,
  confirmations: Math.max(1, Number(process.env.CONFIRMATIONS || network.confirmations)),
  pollIntervalMs: Math.max(3000, Number(process.env.POLL_INTERVAL_MS || 10000)),
  orderTtlMin: Number(process.env.ORDER_TTL_MIN || 30),
  latePaymentHours: Number(process.env.LATE_PAYMENT_HOURS || 24),
  // INR per 1 USDT/USDC if the live rate can't be fetched.
  inrFallback: Number(process.env.INR_RATE_FALLBACK || process.env.USDC_INR_FALLBACK || 95),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  dbPath: (process.env.DB_PATH || '').trim() || null,

  // ---- AI token billing (optional, runs on the main network) ----
  billing: {
    contract: ethers.isAddress((process.env.BILLING_CONTRACT || '').trim()) ? ethers.getAddress(process.env.BILLING_CONTRACT.trim()) : null,
    keeperKey: (process.env.KEEPER_PRIVATE_KEY || '').trim() || null,
    // Block the contract was deployed in: customers are discovered from here on.
    startBlock: Number(process.env.BILLING_START_BLOCK) || null,
    pricePer1k: Number(process.env.AI_PRICE_PER_1K_TOKENS || 0.002),
    defaultApprove: Number(process.env.AI_DEFAULT_APPROVE || 1000),
    defaultMaxPerCharge: Number(process.env.AI_DEFAULT_MAX_PER_CHARGE || 50),
    defaultMaxPerPeriod: Number(process.env.AI_DEFAULT_MAX_PER_30_DAYS || 200),
    // Customers must approve at least this much (USDT) for their API key to work.
    minApproval: process.env.AI_MIN_APPROVAL !== undefined && process.env.AI_MIN_APPROVAL !== '' ? Math.max(0, Number(process.env.AI_MIN_APPROVAL) || 0) : 0,
  },
};

/** Public description of a network, safe to send to browsers. */
export function publicNetwork(n) {
  return {
    key: n.key, family: n.family, name: n.name, short: n.short, chainId: n.chainId,
    gasToken: n.gasToken, fee: n.fee, explorer: n.explorer, testnet: !!n.testnet,
    // explorer link prefixes (TRON's explorer uses different paths)
    txUrl: n.explorer ? `${n.explorer}${n.family === 'tron' ? '/transaction/' : '/tx/'}` : '',
    addressUrl: n.explorer ? `${n.explorer}/address/` : '',
    browserRpc: n.key === config.network.key ? config.browserRpc : n.publicRpc,
  };
}
export const findOption = (id) => config.payOptions.find((o) => o.id === id);
export const findNetwork = (key) => config.networks.find((n) => n.key === key);
