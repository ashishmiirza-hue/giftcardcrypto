import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base, baseSepolia, bsc, bscTestnet } from '@reown/appkit/networks';
import { defineChain } from 'viem';

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
