import 'dotenv/config';
import { ethers } from 'ethers';

const NETWORKS = {
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: 'https://basescan.org',
  },
  'base-sepolia': {
    key: 'base-sepolia',
    name: 'Base Sepolia (testnet)',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
  },
};

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`\n[config] Missing ${name} in .env (see .env.example)\n`);
    process.exit(1);
  }
  return v.trim();
}

const networkKey = (process.env.NETWORK || 'base-sepolia').trim();
const network = NETWORKS[networkKey];
if (!network) {
  console.error(`[config] NETWORK must be one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const wallet = required('RECEIVING_WALLET');
if (!ethers.isAddress(wallet)) {
  console.error('[config] RECEIVING_WALLET is not a valid address');
  process.exit(1);
}

const adminKey = required('ADMIN_KEY');
if (adminKey.length < 16 || adminKey.startsWith('change-this')) {
  console.error('[config] ADMIN_KEY must be a long random string (16+ chars)');
  process.exit(1);
}

export const config = {
  storeName: process.env.STORE_NAME || 'Tohfa',
  port: Number(process.env.PORT || 3001),
  network,
  rpcUrl: required('RPC_URL'),
  rpcUrl2: (process.env.RPC_URL_2 || '').trim() || null,
  wallet: ethers.getAddress(wallet),
  reownProjectId: required('REOWN_PROJECT_ID'),
  adminKey,
  confirmations: Math.max(1, Number(process.env.CONFIRMATIONS || 2)),
  pollIntervalMs: Math.max(3000, Number(process.env.POLL_INTERVAL_MS || 10000)),
  orderTtlMin: Number(process.env.ORDER_TTL_MIN || 30),
  latePaymentHours: Number(process.env.LATE_PAYMENT_HOURS || 24),
  usdcInrFallback: Number(process.env.USDC_INR_FALLBACK || 88),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
  usdcDecimals: 6,
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  dbPath: (process.env.DB_PATH || '').trim() || null,
};
