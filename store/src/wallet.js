import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base, baseSepolia, bsc, bscTestnet } from '@reown/appkit/networks';
import { defineChain } from 'viem';
import { connect, getAccount, getConnectors, switchChain, injected } from '@wagmi/core';

/** Pick the AppKit network object for the store's chain. */
function networkFor(cfg) {
  const known = { [bsc.id]: bsc, [bscTestnet.id]: bscTestnet, [base.id]: base, [baseSepolia.id]: baseSepolia };
  if (known[cfg.network.chainId]) return known[cfg.network.chainId];
  // Local test chain
  return defineChain({
    id: cfg.network.chainId,
    name: cfg.network.name,
    nativeCurrency: { name: cfg.network.gasToken, symbol: cfg.network.gasToken, decimals: 18 },
    rpcUrls: { default: { http: [cfg.network.publicRpc] } },
    caipNetworkId: `eip155:${cfg.network.chainId}`,
    chainNamespace: 'eip155',
  });
}

export function initWallet(cfg, description) {
  const network = networkFor(cfg);
  const adapter = new WagmiAdapter({ projectId: cfg.projectId, networks: [network] });
  const appkit = createAppKit({
    adapters: [adapter],
    networks: [network],
    defaultNetwork: network,
    projectId: cfg.projectId,
    metadata: {
      name: cfg.storeName,
      description,
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.png`],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false },
    // Don't lock the page with a "Switch network" popup when the wallet is on
    // another chain. Our own UI shows a Switch button instead; some in-app
    // wallet browsers never answer AppKit's switch request, which froze the page.
    allowUnsupportedChain: true,
    themeMode: 'light',
    themeVariables: { '--w3m-accent': '#2775CA', '--w3m-font-family': 'Figtree, system-ui, sans-serif', '--w3m-z-index': 3000 },
  });
  return { appkit, wagmi: adapter.wagmiConfig, network };
}

export function friendlyWalletError(e, cfg) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  if (m.includes('reject') || m.includes('denied') || m.includes('cancel')) return 'You cancelled the request in your wallet. Nothing was changed.';
  if (m.includes('insufficient funds')) return `Your wallet needs a little ${cfg.network.gasToken} on ${cfg.network.name} for the network fee.`;
  if (m.includes('chain') || m.includes('network')) return `Switch your wallet to ${cfg.network.name} and try again.`;
  return e?.shortMessage || 'Your wallet could not complete the request. Try again.';
}

// ------------------------------------------------------------------ connect + switch

const CHAIN_PARAMS = {
  56: { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  97: { chainId: '0x61', chainName: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], blockExplorerUrls: ['https://testnet.bscscan.com'] },
  8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
};

const hasInjected = () => typeof window !== 'undefined' && !!window.ethereum;

/**
 * Connect the wallet. Inside a wallet's own browser (Trust Wallet, MetaMask app)
 * or with a browser extension, connect to it directly: one tap, no popup list.
 * Otherwise open the Reown popup (QR code / wallet list).
 */
export async function connectWallet({ appkit, wagmi }) {
  if (hasInjected()) {
    try {
      const existing = getConnectors(wagmi).find((c) => c.type === 'injected' && (c.id === 'injected' || c.id === 'io.metamask' || c.id === 'com.trustwallet.app'))
        || getConnectors(wagmi).find((c) => c.type === 'injected');
      await connect(wagmi, { connector: existing || injected() });
      return;
    } catch (e) {
      const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
      if (m.includes('reject') || m.includes('denied')) throw e;   // user said no, don't pop another window
      if (m.includes('already connected')) return;
      // fall through to the popup
    }
  }
  await appkit.open();
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('network switch timed out')), ms))]);

/**
 * Put the wallet on the store's chain. For wallets injected into the page we
 * talk to them directly (and add the network if they don't know it). Returns
 * true when the wallet ends up on the right chain.
 */
export async function switchToStoreChain(cfg, wagmi) {
  const want = cfg.network.chainId;
  if (getAccount(wagmi).chainId === want) return true;
  const acct = getAccount(wagmi);
  const injectedConn = acct.connector?.type === 'injected' && hasInjected();
  try {
    if (injectedConn) {
      const hex = `0x${want.toString(16)}`;
      try {
        await timeout(window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }), 20000);
      } catch (e) {
        const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '');
        if (!unknown || !CHAIN_PARAMS[want]) throw e;
        await timeout(window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[want]] }), 30000);
      }
    } else {
      await timeout(switchChain(wagmi, { chainId: want }), 25000);
    }
  } catch (e) {
    const m = `${e?.message || ''}`.toLowerCase();
    if (m.includes('reject') || m.includes('denied')) throw e;
  }
  // give the wallet a moment to report the new chain
  for (let i = 0; i < 10 && getAccount(wagmi).chainId !== want; i++) await new Promise((r) => setTimeout(r, 300));
  return getAccount(wagmi).chainId === want;
}

export function switchHelpText(cfg) {
  return `Switch your wallet to ${cfg.network.name} yourself: in MetaMask use the network button at the top; in Trust Wallet's browser tap the chain icon at the top. Then refresh this page.`;
}
