import { initWallet as createWallet, connectWallet, switchToStoreChain, switchHelpText, walletChooserHTML, isMobile } from './wallet.js';
import { writeContract, getAccount, watchAccount, readContract } from '@wagmi/core';
import { erc20Abi, formatUnits } from 'viem';
import QRCode from 'qrcode';

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const LAST_ORDER_KEY = 'tohfa:last-order';
// The store's token (USDT on BSC, or USDC on Base) comes from the server config.
const SYM = () => state.cfg?.network?.token?.symbol || 'USDT';
const GAS = () => state.cfg?.network?.gasToken || 'BNB';
// The network/token of the order being paid (falls back to the main network)
const ON = () => state.order?.network || state.cfg.network;
const OT = () => state.order?.token || state.cfg.network.token;
const LAST_PAY_KEY = 'tohfa:pay-with';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast('Copy failed. Select the text and copy it manually.'); }
}

function saveLastOrder(id, token) {
  try { localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ id, token })); } catch { /* private mode */ }
  $('#my-order').hidden = false;
}
function readLastOrder() {
  try { return JSON.parse(localStorage.getItem(LAST_ORDER_KEY) || 'null'); } catch { return null; }
}

function ticketHTML(p, { price } = {}) {
  const off = Number(p.discount_pct) > 0 ? `<span class="off">${Number(p.discount_pct)}% off</span>` : '';
  return `
    <div class="ticket" style="--c:${esc(p.color)}">
      <div class="ticket-face">
        <span class="brand">${esc(p.brand)}</span>
        <span class="value">${inr(p.face_value_inr)}</span>
        <span class="name">${esc(p.name)}</span>
      </div>
      <div class="ticket-stub">
        <span class="you-pay">You pay</span>
        <span class="price">${esc(price ?? p.price)}</span>
        <span class="unit">${esc(SYM())}</span>
        ${off}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- state
const state = {
  cfg: null,
  products: [],
  filter: 'All',
  appkit: null,
  wagmi: null,
  selected: null,       // product being bought
  order: null,          // public order object from the API
  token: null,
  view: 'form',         // form | pay | sending | confirming | done
  error: null,
  balance: null,
  pollTimer: null,
  errorDetail: null,
  confirmSince: null,
  tickTimer: null,
};

// ---------------------------------------------------------------- wallet (Reown AppKit)
function initWallet(cfg) {
  const w = createWallet(cfg, `Gift cards paid in ${cfg.network.token.symbol}`);
  state.wagmi = w.wagmi;
  state.appkit = w.appkit;

  watchAccount(state.wagmi, {
    onChange() {
      state.balance = null;
      if (state.view === 'pay') { refreshBalance(); renderSheet(); }
    },
  });
}

async function refreshBalance() {
  const acct = getAccount(state.wagmi);
  if (!acct.isConnected) return;
  try {
    const bal = await readContract(state.wagmi, {
      address: OT().address, abi: erc20Abi, functionName: 'balanceOf',
      args: [acct.address], chainId: ON().chainId,
    });
    state.balance = bal;
    if (state.view === 'pay') renderSheet();
  } catch { /* balance is only a hint */ }
}

function friendlyWalletError(e) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  if (m.includes('reject') || m.includes('denied') || m.includes('cancel')) return 'You cancelled the payment in your wallet. Nothing was sent.';
  if (m.includes('insufficient') || m.includes('exceeds balance')) return `Your wallet doesn't have enough ${OT().symbol}, or not enough ${ON().gasToken} for the network fee, on ${ON().name}.`;
  if (m.includes('chain') || m.includes('network')) return `Switch your wallet to ${ON().name} and try again.`;
  return e?.shortMessage || 'Your wallet could not send the payment. Try again.';
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(label), { timeout: true })), ms)),
]);

async function pay() {
  const { cfg, wagmi, order, token } = state;
  let acct = getAccount(wagmi);
  if (!acct.isConnected) {
    try { if ((await connectWallet({ appkit: state.appkit, wagmi })) === 'choose') { state.chooser = true; renderSheet(); } }
    catch (e) { state.error = friendlyWalletError(e); renderSheet(); }
    return;
  }

  state.error = null;
  state.errorDetail = null;
  state.view = 'sending';
  renderSheet();

  // Step 1: get the wallet onto the right network. Some in-app wallet browsers
  // (Trust Wallet, for one) never answer this request, so don't wait forever.
  if (acct.chainId !== ON().chainId) {
    try {
      const ok = await switchToStoreChain(cfg, wagmi, ON().chainId);
      if (!ok) throw new Error(switchHelpText(cfg, ON()));
    } catch (e) {
      state.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e);
      state.errorDetail = e.shortMessage || null;
      state.view = 'pay';
      renderSheet();
      return;
    }
    acct = getAccount(wagmi);
    if (acct.chainId !== ON().chainId) {
      state.error = `Your wallet is still on another network. Switch it to ${ON().name} manually, then press Pay again.`;
      state.view = 'pay';
      renderSheet();
      return;
    }
  }

  // Step 2: the token transfer itself.
  let hash;
  try {
    hash = await writeContract(wagmi, {
      address: OT().address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [order.recipient, BigInt(order.amount_units)],
      chainId: ON().chainId,
    });
  } catch (e) {
    state.error = friendlyWalletError(e);
    state.errorDetail = e.shortMessage || e.message;
    state.view = 'pay';
    renderSheet();
    return;
  }

  // The payment is on its way. Tell the server; if that call fails the
  // listener still matches the payment by its exact amount.
  state.view = 'confirming';
  state.confirmSince = Date.now();
  state.order = { ...order, claimed_tx: hash };
  try {
    const r = await api(`/api/orders/${order.id}/tx`, { method: 'POST', body: { token, txHash: hash } });
    state.order = r.order;
  } catch { /* polling picks it up */ }
  renderSheet();
}

// ---------------------------------------------------------------- catalog
function renderFilters() {
  const cats = ['All', ...new Set(state.products.map((p) => p.category))];
  $('#filters').innerHTML = cats.length > 2
    ? cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === state.filter}">${esc(c)}</button>`).join('')
    : '';
}

function renderGrid() {
  const list = state.products.filter((p) => state.filter === 'All' || p.category === state.filter);
  if (!list.length) {
    $('#grid').innerHTML = '<p class="empty">No cards here yet. Check back soon.</p>';
    return;
  }
  $('#grid').innerHTML = list.map((p) => {
    const out = p.in_stock < 1;
    const stock = out ? 'Sold out' : p.in_stock <= 3 ? `Only ${p.in_stock} left` : `${p.in_stock} in stock`;
    return `
      <article class="item ${out ? 'sold-out' : ''}" data-id="${p.id}">
        ${ticketHTML(p)}
        <div class="item-foot">
          <span class="stock ${!out && p.in_stock <= 3 ? 'low' : ''}">${stock}</span>
          <button class="btn btn-primary" type="button" data-buy="${p.id}" ${out ? 'disabled' : ''}>
            ${out ? 'Sold out' : 'Buy card'}
          </button>
        </div>
      </article>`;
  }).join('');
}

function renderHero() {
  const p = [...state.products].filter((x) => x.in_stock > 0).sort((a, b) => b.discount_pct - a.discount_pct)[0] || state.products[0];
  $('#hero-ticket').innerHTML = p ? ticketHTML(p) : '';
}

async function loadProducts() {
  try {
    const { rate, products } = await api('/api/products');
    state.products = products;
    $('#rate-note').textContent = `${SYM()} prices use today's rate of ₹${Number(rate).toFixed(2)} per ${SYM()}. The price is locked when you reserve a card.`;
    renderFilters(); renderGrid(); renderHero();
  } catch (e) {
    $('#grid').innerHTML = `<p class="msg err">Cards couldn't load: ${esc(e.message)} Refresh the page to try again.</p>`;
  }
}

// ---------------------------------------------------------------- checkout sheet
function setProgress(step) {
  [...$('#progress').children].forEach((li, i) => {
    li.className = i < step ? 'done' : i === step ? 'now' : '';
  });
}

function timeLeft() {
  const ms = state.order.expires_at - Date.now();
  if (ms <= 0) return { text: '0:00', low: true, over: true };
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return { text: `${m}:${String(s).padStart(2, '0')}`, low: ms < 5 * 60000, over: false };
}

const FEE_LABEL = { low: 'low fee', medium: 'small fee', high: 'high fee' };
function payPickerHTML() {
  const opts = state.cfg.payOptions || [];
  if (opts.length <= 1) return '';
  const sel = state.payWith && opts.some((o) => o.id === state.payWith) ? state.payWith : opts[0].id;
  const groups = {};
  for (const o of opts) (groups[o.token.symbol] = groups[o.token.symbol] || []).push(o);
  return `
    <div class="field">
      <label for="pay-with">Pay with</label>
      <select id="pay-with">
        ${Object.entries(groups).map(([sym, list]) => `<optgroup label="${esc(sym)}">${list.map((o) =>
          `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(sym)} on ${esc(o.network.short || o.network.name)} (${esc(FEE_LABEL[o.network.fee] || 'fee varies')})</option>`).join('')}</optgroup>`).join('')}
      </select>
      <span class="hint">Pick the coin and network you hold. TRON and BSC are the cheapest to send from exchanges.</span>
    </div>`;
}

function renderSheet() {
  const body = $('#sheet-body');
  const { cfg, order } = state;
  const err = state.error
    ? `<div class="msg err" role="alert">${esc(state.error)}${state.errorDetail ? `<details class="small" style="margin-top:6px"><summary>Technical details</summary>${esc(String(state.errorDetail).slice(0, 400))}</details>` : ''}</div>`
    : '';

  // ---- 1. reserve
  if (state.view === 'form') {
    const p = state.selected;
    setProgress(0);
    body.innerHTML = `
      ${ticketHTML(p)}
      <form id="reserve-form" class="field-stack" novalidate>
        ${payPickerHTML()}
        <div class="field">
          <label for="email">Email (optional)</label>
          <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" />
          <span class="hint">Only used if you contact support about this order.</span>
        </div>
      </form>
      ${err}
      <button class="btn btn-primary btn-block" id="reserve" type="button">Reserve card</button>
      <p class="small">We'll hold one code for you for ${cfg.orderTtlMin} minutes while you pay.</p>`;
    return;
  }

  const product = order.product;
  const net = order.network || cfg.network;
  const tok = order.token || cfg.network.token;
  const change = order.status === 'pending' && !order.claimed_tx
    ? '<button class="link-btn" type="button" id="change-method">Pay with a different coin or network</button>' : '';
  const status = order.status;

  // ---- 4. done
  if (status === 'paid' || status === 'needs_code') {
    setProgress(status === 'paid' ? 4 : 3);
    stopTimers();
    const txLink = order.tx_hash ? `<a class="tx-link" href="${net.txUrl}${esc(order.tx_hash)}" target="_blank" rel="noopener">View payment on the explorer</a>` : '';
    body.innerHTML = status === 'paid' ? `
      <p class="msg ok">Payment confirmed. Here's your ${esc(product.brand)} ${inr(product.face_value_inr)} code.</p>
      <div class="code-reveal" ${state.view !== 'done' ? 'data-new' : ''}>
        <span class="small">Your code</span>
        <span class="code" id="gift-code">${esc(order.code)}</span>
        <button class="btn btn-primary" type="button" data-copy="${esc(order.code)}">Copy code</button>
      </div>
      <div class="field">
        <span class="small">Bookmark this order link to see the code again later.</span>
        <div class="copy-line"><code>${esc(orderLink())}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(orderLink())}" data-label="Order link copied">Copy link</button></div>
      </div>
      <p class="small">Order ID: ${esc(order.id)}</p>
      ${txLink}` : `
      <p class="msg warn">Payment confirmed, but this card just ran out of stock. Your code will appear on this page as soon as it's restocked. Keep this link, or contact support with your order ID.</p>
      <div class="copy-line"><code>${esc(orderLink())}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(orderLink())}" data-label="Order link copied">Copy link</button></div>
      <p class="small">Order ID: ${esc(order.id)}</p>
      ${txLink}`;
    if (status === 'needs_code') startPolling(15000);
    state.view = 'done';
    return;
  }

  // ---- expired
  if (status === 'expired') {
    setProgress(1);
    stopTimers();
    body.innerHTML = `
      <p class="msg warn">This order expired before a payment arrived. If you already sent the payment, it will still be matched for the next 24 hours; keep this page open or save the link.</p>
      <div class="copy-line"><code>${esc(orderLink())}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(orderLink())}" data-label="Order link copied">Copy link</button></div>
      <button class="btn btn-primary btn-block" type="button" id="new-order">Start a new order</button>`;
    startPolling(15000);
    return;
  }

  // ---- 3. confirming (browser sent a tx, waiting for chain)
  if (state.view === 'confirming' || (order.claimed_tx && state.view !== 'pay' && state.view !== 'sending')) {
    setProgress(2);
    state.view = 'confirming';
    state.confirmSince ||= Date.now();
    const slow = Date.now() - state.confirmSince > 180000;
    body.innerHTML = `
      <div class="amount-box">
        <span class="lbl">Payment sent</span>
        <span class="amt">${esc(order.amount)}<small>${esc(tok.symbol)}</small></span>
      </div>
      <p class="msg info"><span class="spinner" aria-hidden="true"></span> Confirming your payment on ${esc(net.name)}. This usually takes under 15 seconds. You can keep this page open.</p>
      ${order.claimed_tx ? `<a class="tx-link" href="${net.txUrl}${esc(order.claimed_tx)}" target="_blank" rel="noopener">View transaction on the explorer</a>` : ''}
      ${slow ? `<p class="msg warn">This is taking longer than usual. Open the transaction link above: if it failed or sent a different amount, go back and pay again. If it succeeded, contact support with your order ID.</p>
        <button class="btn btn-ghost btn-block" type="button" id="back-to-pay">Back to payment</button>` : ''}
      <p class="small">Order ID: ${esc(order.id)}</p>`;
    startPolling(3000);
    if (!slow) setTimeout(() => { if (state.view === 'confirming') renderSheet(); }, 180000 - (Date.now() - state.confirmSince) + 500);
    return;
  }

  // ---- 2a. pay on TRON: send to the address, the watcher confirms it
  if (net.family === 'tron') {
    setProgress(1);
    const t = timeLeft();
    body.innerHTML = `
      <div class="amount-box">
        <span class="lbl">Send exactly</span>
        <span class="amt">${esc(order.amount)}<small>${esc(tok.symbol)}</small></span>
        <span class="meta">
          <span>For ${esc(product.brand)} ${inr(product.face_value_inr)}</span>
          <span>on ${esc(net.name)}</span>
          <span>Time left <span class="timer ${t.low ? 'low' : ''}" id="timer">${t.text}</span></span>
        </span>
      </div>
      <div class="tron-pay">
        <img id="tron-qr" class="qr" alt="QR code of the TRON address" width="168" height="168" />
        <div class="tron-fields">
          <span class="small">To this TRON address</span>
          <div class="copy-line"><code>${esc(order.recipient)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(order.recipient)}" data-label="Address copied">Copy</button></div>
          <span class="small">Exact amount</span>
          <div class="copy-line"><code>${esc(order.amount)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(order.amount)}" data-label="Amount copied">Copy</button></div>
        </div>
      </div>
      <ul class="plain small tron-notes">
        <li>Send <strong>USDT on TRON (TRC-20)</strong> only. Other networks or tokens can't be matched.</li>
        <li>The amount must arrive to the last digit. If your exchange takes its withdrawal fee from the amount, add the fee on top.</li>
        <li>From Trust Wallet or TronLink you need a little <strong>TRX</strong> for the network fee.</li>
        <li>We detect the payment automatically, usually within 1–2 minutes. Keep this page open or save the order link.</li>
      </ul>
      <p class="msg info"><span class="spinner" aria-hidden="true"></span> Waiting for your payment…</p>
      ${change}
      <p class="small">Order ID: ${esc(order.id)}</p>`;
    QRCode.toDataURL(order.recipient, { margin: 1, width: 336 }).then((u) => { const img = $('#tron-qr'); if (img) img.src = u; }).catch(() => {});
    startPolling(5000);
    startTick();
    return;
  }

  // ---- 2b. pay on an EVM network with a wallet
  setProgress(1);
  const acct = getAccount(state.wagmi);
  const t = timeLeft();
  const need = BigInt(order.amount_units);
  const lowBal = state.balance !== null && state.balance < need;
  const sending = state.view === 'sending';
  const viaPhone = acct.connector?.id === 'walletConnect' || acct.connector?.type === 'walletConnect';

  body.innerHTML = `
    <div class="amount-box">
      <span class="lbl">Send exactly</span>
      <span class="amt">${esc(order.amount)}<small>${esc(tok.symbol)}</small></span>
      <span class="meta">
        <span>For ${esc(product.brand)} ${inr(product.face_value_inr)}</span>
        <span>on ${esc(net.name)}</span>
        <span>Time left <span class="timer ${t.low ? 'low' : ''}" id="timer">${t.text}</span></span>
      </span>
    </div>
    ${acct.isConnected ? `
      <div class="wallet-row">
        <span>Wallet <code>${esc(short(acct.address))}</code>${state.balance !== null ? `, balance ${esc(Number(formatUnits(state.balance, tok.decimals)).toFixed(4))} ${esc(tok.symbol)}` : ''}</span>
        <button class="link-btn" type="button" id="change-wallet">Change</button>
      </div>` : ''}
    ${acct.isConnected && acct.chainId !== net.chainId ? `<p class="msg warn">Your wallet is on another network. Pressing Pay will ask to switch to ${esc(net.name)}. If nothing happens, switch the network to ${esc(net.name)} inside your wallet app yourself (in Trust Wallet: the network button at the top of the browser).</p>` : ''}
    ${lowBal ? `<p class="msg warn">This wallet has less ${esc(tok.symbol)} on ${esc(net.name)} than the order amount. Top it up or connect another wallet.</p>` : ''}
    ${err}
    ${!acct.isConnected && (state.chooser || (!window.ethereum && isMobile())) ? walletChooserHTML(cfg, { appkit: state.appkit }) : `
    <button class="btn btn-primary btn-block" id="pay" type="button" ${sending ? 'disabled' : ''}>
      ${sending ? '<span class="spinner" aria-hidden="true"></span> Waiting for your wallet' : acct.isConnected ? `Pay ${esc(order.amount)} ${esc(tok.symbol)}` : 'Connect wallet to pay'}
    </button>`}
    ${sending ? `
      <p class="msg info">${viaPhone
        ? `Open your wallet app on your phone and approve the request. It may first ask to switch to ${esc(net.name)}, then to send ${esc(tok.symbol)}. If nothing shows up, open the wallet app manually and check for a pending request.`
        : `Approve the request in your wallet. It may first ask to switch to ${esc(net.name)}, then to send ${esc(tok.symbol)}.`}</p>
      <button class="btn btn-ghost btn-block" type="button" id="cancel-wait">I closed it or nothing happened</button>` : ''}
    <details class="manual">
      <summary>Paying from an exchange or another app?</summary>
      <div class="inner">
        <p>Send exactly <strong>${esc(order.amount)} ${esc(tok.symbol)}</strong> on <strong>${esc(net.name)}</strong> to this address. The order is matched by the exact amount, so it must arrive to the last digit. If your exchange deducts a withdrawal fee from the amount, add it on top.</p>
        <div class="copy-line"><code>${esc(order.recipient)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(order.recipient)}" data-label="Address copied">Copy</button></div>
        <div class="copy-line"><code>${esc(order.amount)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(order.amount)}" data-label="Amount copied">Copy</button></div>
        <p>Only send ${esc(tok.symbol)} on ${esc(net.name)}. Other tokens or networks can't be matched to your order.</p>
      </div>
    </details>
    ${change}
    <p class="small">Order ID: ${esc(order.id)}</p>`;
  startPolling(5000);
  startTick();
}

function orderLink() {
  return `${location.origin}${location.pathname}?order=${state.order.id}&t=${state.token}`;
}

// polling keeps the sheet in sync with the server (payments from exchanges, late payments, restocks)
function startPolling(ms) {
  if (state.pollTimer?.ms === ms) return;
  clearInterval(state.pollTimer?.id);
  const id = setInterval(pollOrder, ms);
  state.pollTimer = { id, ms };
}
function startTick() {
  if (state.tickTimer) return;
  state.tickTimer = setInterval(() => {
    const el = $('#timer');
    if (!el || !state.order) return;
    const t = timeLeft();
    el.textContent = t.text;
    el.classList.toggle('low', t.low);
    if (t.over) pollOrder();
  }, 1000);
}
function stopTimers() {
  clearInterval(state.pollTimer?.id); state.pollTimer = null;
  clearInterval(state.tickTimer); state.tickTimer = null;
}

async function pollOrder() {
  if (!state.order) return;
  try {
    const { order } = await api(`/api/orders/${state.order.id}?token=${encodeURIComponent(state.token)}`);
    const changed = order.status !== state.order.status || order.claimed_tx !== state.order.claimed_tx;
    state.order = order;
    if (changed && state.view !== 'sending') renderSheet();
  } catch { /* try again next tick */ }
}

// The sheet is opened with show() (non-modal), not showModal(). A modal dialog
// makes everything outside it inert, and the wallet popup lives outside it,
// which made "Connect wallet" dead on mobile and froze the popup on desktop.
function openSheet() {
  const d = $('#checkout');
  if (!d.open) d.show();
  $('#sheet-backdrop').hidden = false;
  document.body.classList.add('sheet-open');
  d.focus({ preventScroll: true });
}
function closeSheet() {
  const d = $('#checkout');
  if (d.open) d.close();
}
function isWalletPopupOpen() {
  try { return !!state.appkit?.getState?.().open; } catch { return false; }
}

function startCheckout(productId) {
  const p = state.products.find((x) => x.id === productId);
  if (!p) return;
  stopTimers();
  Object.assign(state, { selected: p, order: null, token: null, view: 'form', error: null, balance: null, confirmSince: null });
  renderSheet();
  openSheet();
}

async function reserve() {
  const btn = $('#reserve');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Reserving…';
  try {
    const email = $('#email')?.value.trim() || '';
    const payWith = $('#pay-with')?.value || state.payWith || undefined;
    if (payWith) { state.payWith = payWith; try { localStorage.setItem(LAST_PAY_KEY, payWith); } catch { /* ignore */ } }
    const r = await api('/api/orders', { method: 'POST', body: { productId: state.selected.id, email, payWith } });
    state.order = r.order;
    state.token = r.token;
    state.view = 'pay';
    state.error = null;
    saveLastOrder(r.order.id, r.token);
    history.replaceState(null, '', `?order=${r.order.id}&t=${r.token}`);
    refreshBalance();
    loadProducts(); // stock changed
  } catch (e) {
    state.error = e.message;
  }
  renderSheet();
}

async function openExistingOrder(id, token) {
  try {
    const { order } = await api(`/api/orders/${id}?token=${encodeURIComponent(token)}`);
    stopTimers();
    Object.assign(state, { order, token, error: null, confirmSince: null, view: order.claimed_tx ? 'confirming' : 'pay' });
    saveLastOrder(id, token);
    renderSheet();
    openSheet();
    if (state.view === 'pay') refreshBalance();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .ticket');
  if (!t) return;
  if (t.dataset.buy) return startCheckout(Number(t.dataset.buy));
  if (t.classList.contains('ticket')) {
    const item = t.closest('.item');
    if (item && !item.classList.contains('sold-out')) startCheckout(Number(item.dataset.id));
    return;
  }
  if (t.dataset.cat) { state.filter = t.dataset.cat; renderFilters(); renderGrid(); return; }
  if (t.dataset.copy) return copy(t.dataset.copy, t.dataset.label || 'Code copied');
  switch (t.id) {
    case 'reserve': return reserve();
    case 'pay': return pay();
    case 'change-wallet': return state.appkit ? state.appkit.open() : toast('Switch the account inside your wallet app.');
    case 'wc-qr': return state.appkit?.open();
    case 'change-method': {
      try { await api(`/api/orders/${state.order.id}/cancel`, { method: 'POST', body: { token: state.token } }); } catch { /* order may have moved on */ }
      const p = state.products.find((x) => x.name === state.order.product.name && x.face_value_inr === state.order.product.face_value_inr);
      history.replaceState(null, '', location.pathname);
      loadProducts();
      return p ? startCheckout(p.id) : closeSheet();
    }
    case 'cancel-wait':
      state.view = 'pay';
      state.error = "If you already approved the payment in your wallet, don't pay again: it will show up here within a minute.";
      return renderSheet();
    case 'back-to-pay': state.view = 'pay'; state.confirmSince = null; state.order = { ...state.order, claimed_tx: null }; return renderSheet();
    case 'close-sheet': return closeSheet();
    case 'new-order': {
      const p = state.products.find((x) => x.name === state.order.product.name && x.face_value_inr === state.order.product.face_value_inr);
      history.replaceState(null, '', location.pathname);
      return p ? startCheckout(p.id) : closeSheet();
    }
    case 'my-order': {
      const last = readLastOrder();
      if (last) openExistingOrder(last.id, last.token);
    }
  }
});

$('#checkout').addEventListener('close', () => {
  $('#sheet-backdrop').hidden = true;
  document.body.classList.remove('sheet-open');
  stopTimers();
  if (state.order && ['paid', 'expired'].includes(state.order.status)) history.replaceState(null, '', location.pathname);
});
// click on the backdrop or Escape closes the sheet (unless the wallet popup is on top)
$('#sheet-backdrop').addEventListener('click', () => { if (!isWalletPopupOpen()) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#checkout').open && !isWalletPopupOpen()) closeSheet();
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    state.cfg = await api('/api/config');
  } catch (e) {
    $('#grid').innerHTML = `<p class="msg err">The store server isn't reachable right now. Refresh in a minute.</p>`;
    return;
  }
  const { cfg } = state;
  document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = cfg.storeName; });
  document.querySelectorAll('[data-ttl]').forEach((el) => { el.textContent = `${cfg.orderTtlMin} minutes`; });
  document.title = `${cfg.storeName}: gift cards below face value, paid in ${SYM()}`;
  document.querySelectorAll('[data-token]').forEach((el) => { el.textContent = SYM(); });
  const netNames = [...new Set((cfg.payOptions || []).map((o) => o.network.short || o.network.name))];
  const syms = [...new Set((cfg.payOptions || []).map((o) => o.token.symbol))];
  document.querySelectorAll('[data-net]').forEach((el) => { el.textContent = netNames.length > 1 ? netNames.join(', ') : cfg.network.name; });
  const pill = $('#net-pill');
  const isTest = cfg.network.key.includes('sepolia');
  pill.textContent = isTest ? `Test mode: ${cfg.network.name}`
    : netNames.length > 1 ? `Pay with ${syms.join(' or ')} on ${netNames.length} networks` : `Pay with ${SYM()} on ${cfg.network.name}`;
  pill.classList.toggle('test', isTest);
  pill.hidden = false;
  if (readLastOrder()) $('#my-order').hidden = false;
  try { state.payWith = localStorage.getItem(LAST_PAY_KEY) || null; } catch { /* ignore */ }

  initWallet(cfg);
  await loadProducts();

  const q = new URLSearchParams(location.search);
  if (q.get('order') && q.get('t')) openExistingOrder(q.get('order'), q.get('t'));
})();
