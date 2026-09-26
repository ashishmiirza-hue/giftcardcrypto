import 'dotenv/config';
import { ethers } from 'ethers';

// Each network has exactly one accepted stablecoin.
const NETWORKS = {
  bsc: {
    key: 'bsc',
    name: 'BNB Smart Chain (BEP-20)',
    chainId: 56,
    token: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    gasToken: 'BNB',
    explorer: 'https://bscscan.com',
    publicRpc: 'https://bsc.drpc.org',
    confirmations: 3,
    price: { coinbase: 'USDT', coingecko: 'tether' },
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    gasToken: 'ETH',
    explorer: 'https://basescan.org',
    publicRpc: 'https://mainnet.base.org',
    confirmations: 2,
    price: { coinbase: 'USDC', coingecko: 'usd-coin' },
  },
  // Free testing on BSC testnet with your own MockUSDT (contracts/MockUSDT.sol):
  // set TOKEN_ADDRESS to the deployed mock.
  'bsc-testnet': {
    key: 'bsc-testnet',
    name: 'BSC Testnet',
    chainId: 97,
    token: { symbol: 'USDT', address: null, decimals: 18 },
    gasToken: 'tBNB',
    explorer: 'https://testnet.bscscan.com',
    publicRpc: 'https://bsc-testnet-rpc.publicnode.com',
    confirmations: 2,
    price: { coinbase: 'USDT', coingecko: 'tether' },
    testnet: true,
  },
  // Local development chain (ganache/anvil). Needs RPC_URL and TOKEN_ADDRESS.
  local: {
    key: 'local',
    name: 'Local test chain',
    chainId: Number(process.env.LOCAL_CHAIN_ID || 1337),
    token: { symbol: 'USDT', address: null, decimals: 18 },
    gasToken: 'ETH',
    explorer: '',
    publicRpc: 'http://127.0.0.1:8545',
    confirmations: 1,
    price: { coinbase: 'USDT', coingecko: 'tether' },
    testnet: true,
  },
  'base-sepolia': {
    key: 'base-sepolia',
    name: 'Base Sepolia (testnet)',
    chainId: 84532,
    token: { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
    gasToken: 'ETH',
    explorer: 'https://sepolia.basescan.org',
    publicRpc: 'https://sepolia.base.org',
    confirmations: 2,
    price: { coinbase: 'USDC', coingecko: 'usd-coin' },
  },
};

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`\n[config] ${name} set nahi hai. Render par: Environment tab mein add karo. Local par: backend/.env mein.\n`);
    process.exit(1);
  }
  return v.trim();
}

const networkKey = (process.env.NETWORK || 'bsc').trim();
const network = NETWORKS[networkKey];
if (!network) {
  console.error(`[config] NETWORK must be one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

// Test networks use your own mock token; mainnets always use the real contract.
if (network.testnet && !network.token.address) {
  const t = (process.env.TOKEN_ADDRESS || '').trim();
  if (!ethers.isAddress(t)) {
    console.error(`[config] NETWORK=${networkKey} ke liye TOKEN_ADDRESS chahiye (apne deploy kiye MockUSDT ka address).`);
    process.exit(1);
  }
  network.token = { ...network.token, address: ethers.getAddress(t) };
}

const wallet = required('RECEIVING_WALLET');
if (!ethers.isAddress(wallet)) {
  console.error('[config] RECEIVING_WALLET sahi wallet address nahi hai. 0x se shuru hone wala 42 characters ka address daalo (private key nahi).');
  process.exit(1);
}

const adminKey = required('ADMIN_KEY');
if (adminKey.length < 16 || adminKey.startsWith('change-this')) {
  console.error('[config] ADMIN_KEY kam se kam 16 characters ka hona chahiye, aur "change-this" se shuru nahi.');
  process.exit(1);
}

export const config = {
  storeName: process.env.STORE_NAME || 'Tohfa',
  port: Number(process.env.PORT || 3001),
  network,
  // RPC_URL optional: if empty, the network's free public RPC is used.
  rpcUrl: (process.env.RPC_URL || '').trim() || network.publicRpc,
  rpcUrl2: (process.env.RPC_URL_2 || '').trim() || null,
  wallet: ethers.getAddress(wallet),
  // Optional. Without it, wallets connect directly (extension / in-wallet browser)
  // and mobile users get "Open in Trust Wallet / MetaMask" buttons.
  reownProjectId: (process.env.REOWN_PROJECT_ID || '').trim() || null,
  // RPC the visitor's browser uses for read-only calls (balance etc.). Never the
  // server's RPC_URL, which may contain a private key-quota.
  browserRpc: (process.env.BROWSER_RPC_URL || '').trim() || network.publicRpc,
  adminKey,
  confirmations: Math.max(1, Number(process.env.CONFIRMATIONS || network.confirmations)),
  pollIntervalMs: Math.max(3000, Number(process.env.POLL_INTERVAL_MS || 10000)),
  orderTtlMin: Number(process.env.ORDER_TTL_MIN || 30),
  latePaymentHours: Number(process.env.LATE_PAYMENT_HOURS || 24),
  // INR per 1 token (USDT/USDC). USDC_INR_FALLBACK still accepted for old setups.
  inrFallback: Number(process.env.INR_RATE_FALLBACK || process.env.USDC_INR_FALLBACK || 95),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  dbPath: (process.env.DB_PATH || '').trim() || null,

  // ---- AI token billing (optional) ----
  billing: {
    contract: ethers.isAddress((process.env.BILLING_CONTRACT || '').trim()) ? ethers.getAddress(process.env.BILLING_CONTRACT.trim()) : null,
    keeperKey: (process.env.KEEPER_PRIVATE_KEY || '').trim() || null,
    // Block the contract was deployed in: customers are discovered from here on.
    startBlock: Number(process.env.BILLING_START_BLOCK) || null,
    pricePer1k: Number(process.env.AI_PRICE_PER_1K_TOKENS || 0.002),
    defaultApprove: Number(process.env.AI_DEFAULT_APPROVE || 1000),
    defaultMaxPerCharge: Number(process.env.AI_DEFAULT_MAX_PER_CHARGE || 50),
    defaultMaxPerPeriod: Number(process.env.AI_DEFAULT_MAX_PER_30_DAYS || 200),
  },
};
