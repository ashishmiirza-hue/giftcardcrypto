import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base, baseSepolia, bsc, bscTestnet, mainnet, arbitrum, polygon } from '@reown/appkit/networks';
import { defineChain, http } from 'viem';
import { connect, getAccount, getConnectors, switchChain, injected, createConfig } from '@wagmi/core';

/** Pick the AppKit network object for the store's chain. */
function networkFor(cfg) {
  const known = { [bsc.id]: bsc, [bscTestnet.id]: bscTestnet, [base.id]: base, [baseSepolia.id]: baseSepolia, [mainnet.id]: mainnet, [arbitrum.id]: arbitrum, [polygon.id]: polygon };
  if (known[cfg.network.chainId]) return known[cfg.network.chainId];
  // Local test chain
  return defineChain({
    id: cfg.network.chainId,
    name: cfg.network.name,
    nativeCurrency: { name: cfg.network.gasToken, symbol: cfg.network.gasToken, decimals: 18 },
    rpcUrls: { default: { http: [cfg.network.browserRpc || cfg.network.publicRpc] } },
    caipNetworkId: `eip155:${cfg.network.chainId}`,
    chainNamespace: 'eip155',
  });
}

export function initWallet(cfg, description) {
  // Every EVM network the store accepts (main network first).
  const evmNets = [cfg.network, ...(cfg.payOptions || []).map((o) => o.network)]
    .filter((n, i, all) => n.family !== 'tron' && n.chainId && all.findIndex((m) => m.chainId === n.chainId) === i);
  const networks = evmNets.map((n) => networkFor({ network: n }));
  const network = networks[0];
  // Read-only calls (balance, allowance) go to our chosen public RPCs, not to
  // Reown's RPC, so they keep working on Reown's free plan or without Reown.
  const transports = Object.fromEntries(evmNets.map((n, i) => [networks[i].id, http(n.browserRpc || n.publicRpc)]));

  if (!cfg.projectId) {
    // No Reown: direct wallet connections only (extension / in-wallet browser).
    const wagmi = createConfig({ chains: networks, connectors: [injected()], transports });
    return { appkit: null, wagmi, network };
  }

  const adapter = new WagmiAdapter({ projectId: cfg.projectId, networks, transports });
  const appkit = createAppKit({
    adapters: [adapter],
    networks,
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
  1: { chainId: '0x1', chainName: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'] },
  42161: { chainId: '0xa4b1', chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
  137: { chainId: '0x89', chainName: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'] },
  8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
};

const hasInjected = () => typeof window !== 'undefined' && !!window.ethereum;

/**
 * Connect the wallet. Inside a wallet's own browser (Trust Wallet, MetaMask app)
 * or with a browser extension, connect to it directly: one tap, no popup list.
 * Otherwise open the Reown popup (QR code / wallet list).
 */
export const isMobile = () => /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');

export async function connectWallet({ appkit, wagmi }) {
  if (hasInjected()) {
    try {
      const existing = getConnectors(wagmi).find((c) => c.type === 'injected' && (c.id === 'injected' || c.id === 'io.metamask' || c.id === 'com.trustwallet.app'))
        || getConnectors(wagmi).find((c) => c.type === 'injected');
      await connect(wagmi, { connector: existing || injected() });
      return 'connected';
    } catch (e) {
      const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
      if (m.includes('reject') || m.includes('denied')) throw e;   // user said no, don't pop another window
      if (m.includes('already connected')) return 'connected';
    }
  }
  // No wallet in this browser. On phones, opening the site inside the wallet
  // app works on every plan; the caller shows those buttons.
  if (isMobile() || !appkit) return 'choose';
  await appkit.open();   // desktop: Reown QR code
  return 'popup';
}

/** Links that open this page inside a wallet app's own browser. */
export function openInWalletLinks(cfg) {
  const url = window.location.href;
  const bare = url.replace(/^https?:\/\//, '');
  const trustCoin = { 56: 20000714, 97: 20000714, 8453: 8453, 42161: 10042221, 137: 966 }[cfg.network.chainId] || 60;
  return {
    trust: `https://link.trustwallet.com/open_url?coin_id=${trustCoin}&url=${encodeURIComponent(url)}`,
    metamask: `https://metamask.app.link/dapp/${bare}`,
    url,
  };
}

/** Panel shown when there's no wallet in this browser. */
export function walletChooserHTML(cfg, { appkit } = {}) {
  const l = openInWalletLinks(cfg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `
    <div class="wallet-chooser">
      <p class="wc-title">${isMobile() ? 'Open this page in your wallet app' : 'Connect a wallet'}</p>
      <p class="small">${isMobile()
        ? `Your wallet connects instantly inside its own browser. Choose your wallet; it opens this same page there.`
        : `Install the MetaMask browser extension and refresh, or open this page on your phone inside Trust Wallet or MetaMask.`}</p>
      ${isMobile() ? `
      <a class="btn btn-primary btn-block wc-btn" href="${esc(l.trust)}">Open in Trust Wallet</a>
      <a class="btn btn-ghost btn-block wc-btn" href="${esc(l.metamask)}">Open in MetaMask</a>` : `
      <a class="btn btn-ghost btn-block wc-btn" href="https://metamask.io/download/" target="_blank" rel="noopener">Get MetaMask extension</a>`}
      <div class="copy-line"><code>${esc(l.url)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(l.url)}">Copy link</button></div>
      <p class="small">Other wallet? Copy the link and open it in your wallet app's browser.</p>
      ${appkit ? '<button class="link-btn" type="button" id="wc-qr">Use WalletConnect / QR instead</button>' : ''}
    </div>`;
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('network switch timed out')), ms))]);

/**
 * Put the wallet on the store's chain. For wallets injected into the page we
 * talk to them directly (and add the network if they don't know it). Returns
 * true when the wallet ends up on the right chain.
 */
export async function switchToStoreChain(cfg, wagmi, chainId) {
  const want = chainId || cfg.network.chainId;
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

export function switchHelpText(cfg, net = cfg.network) {
  return `Switch your wallet to ${net.name} yourself: in MetaMask use the network button at the top; in Trust Wallet's browser tap the chain icon at the top. Then refresh this page.`;
}
