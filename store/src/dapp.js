/*
 * dApp mode: the same website, tuned for wallet browsers (Trust Wallet,
 * MetaMask mobile, Bitget, OKX…).
 *
 * Turned on when:
 *  - the page is opened inside a wallet's own browser on a phone, or
 *  - the site is opened on an "app." or "dapp." subdomain, or
 *  - the URL has ?dapp=1  (?dapp=0 turns it off, remembered for the session)
 *
 * In dApp mode the wallet connects by itself, the page is compact, and a
 * wallet chip in the header shows the connected address and network.
 */
import { getAccount, watchAccount } from '@wagmi/core';
import { connectWallet, switchToStoreChain, isMobile } from './wallet.js';

const KEY = 'tohfa:dapp';

export function isDappMode() {
  try {
    const q = new URLSearchParams(location.search).get('dapp');
    if (q === '1' || q === '0') sessionStorage.setItem(KEY, q);
    const saved = sessionStorage.getItem(KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch { /* storage blocked */ }
  if (/^(app|dapp)\./i.test(location.hostname)) return true;
  return !!window.ethereum && isMobile();
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function chainName(cfg, id) {
  const all = [cfg.network, ...(cfg.payOptions || []).map((o) => o.network)];
  const common = { 1: 'Ethereum', 56: 'BSC', 97: 'BSC Testnet', 137: 'Polygon', 42161: 'Arbitrum', 8453: 'Base', 10: 'Optimism', 43114: 'Avalanche' };
  return all.find((n) => n.chainId === id)?.short || common[id] || (id ? `Chain ${id}` : '');
}

/** Header chip: "● 0x12ab…34cd · BSC", or a Connect button. */
function renderChip(cfg, wagmi, onConnect) {
  const el = document.querySelector('#wallet-chip');
  if (!el) return;
  const a = getAccount(wagmi);
  el.hidden = false;
  el.innerHTML = a.isConnected
    ? `<span class="dot" aria-hidden="true"></span><span>${short(a.address)}</span><span class="chip-net">${chainName(cfg, a.chainId)}</span>`
    : '<button type="button" class="chip-connect">Connect</button>';
  el.querySelector('.chip-connect')?.addEventListener('click', onConnect);
}

/**
 * Switch the page into dApp mode and connect the wallet right away.
 * `switchChain`: also move the wallet to the main network after connecting
 * (the AI page wants this; the store switches per order at checkout).
 */
export async function startDappMode({ cfg, wagmi, appkit, switchChain = false, onConnected }) {
  document.body.classList.add('dapp');
  const connect = async () => {
    try {
      await connectWallet({ appkit, wagmi });
      if (switchChain && getAccount(wagmi).chainId !== cfg.network.chainId) {
        await switchToStoreChain(cfg, wagmi).catch(() => {});
      }
      onConnected?.();
    } catch { /* user said no; the Connect chip stays */ }
    renderChip(cfg, wagmi, connect);
  };
  watchAccount(wagmi, { onChange: () => renderChip(cfg, wagmi, connect) });
  renderChip(cfg, wagmi, connect);
  if (!getAccount(wagmi).isConnected && window.ethereum) await connect();
  else if (switchChain && getAccount(wagmi).isConnected && getAccount(wagmi).chainId !== cfg.network.chainId) {
    await switchToStoreChain(cfg, wagmi).catch(() => {});
  }
}
