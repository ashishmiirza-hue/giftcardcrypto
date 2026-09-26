import {
  getAccount, watchAccount, readContract, writeContract, signMessage, waitForTransactionReceipt,
} from '@wagmi/core';
import { erc20Abi, parseUnits, formatUnits } from 'viem';
import { initWallet, friendlyWalletError, connectWallet, switchToStoreChain, switchHelpText } from './wallet.js';

const BILLING_ABI = [
  { type: 'function', name: 'enroll', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'setLimits', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'accounts', stateMutability: 'view', inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: 'active', type: 'bool' }, { name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }, { name: 'periodStart', type: 'uint64' }, { name: 'spentInPeriod', type: 'uint128' }] },
];

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const num = (v, d = 2) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: d });

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) };
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

let toastTimer;
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ------------------------------------------------------------------ state
const S = {
  cfg: null, bcfg: null, appkit: null, wagmi: null,
  address: null, chainId: null,
  allowance: null, balance: null, account: null,   // on-chain reads (bigint / struct)
  busy: null,          // 'approve' | 'enroll' | 'limits' | 'cancel' | 'signin' | null
  error: null,
  editLimits: false,
  session: null,
  me: null,
  newKey: null,
  form: { approve: '', maxPerCharge: '', maxPerPeriod: '' },
};

const SYM = () => S.cfg?.network?.token?.symbol || 'USDT';
const DEC = () => S.cfg?.network?.token?.decimals ?? 18;
const toUnits = (v) => parseUnits(String(v || '0'), DEC());
const fromUnits = (u) => formatUnits(u, DEC());
const sessionKey = () => `ai-session:${S.address?.toLowerCase()}`;

// ------------------------------------------------------------------ chain reads
async function readChain() {
  if (!S.address || !S.bcfg?.enabled) return;
  const { token } = S.cfg.network;
  const contract = S.bcfg.contract;
  const chainId = S.cfg.network.chainId;
  try {
    const [allowance, balance, acc] = await Promise.all([
      readContract(S.wagmi, { address: token.address, abi: erc20Abi, functionName: 'allowance', args: [S.address, contract], chainId }),
      readContract(S.wagmi, { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [S.address], chainId }),
      readContract(S.wagmi, { address: contract, abi: BILLING_ABI, functionName: 'accounts', args: [S.address], chainId }),
    ]);
    S.allowance = allowance; S.balance = balance;
    S.account = { active: acc[0], maxPerCharge: acc[1], maxPerPeriod: acc[2], spentInPeriod: acc[4] };
  } catch (e) {
    S.error = `Couldn't read your wallet on ${S.cfg.network.name}. ${e.shortMessage || ''}`;
  }
}

// ------------------------------------------------------------------ writes
async function ensureChain() {
  const ok = await switchToStoreChain(S.cfg, S.wagmi);
  if (!ok) throw new Error(switchHelpText(S.cfg));
}

async function send(kind, request) {
  S.busy = kind; S.error = null; render();
  try {
    await ensureChain();
    const hash = await writeContract(S.wagmi, { ...request, chainId: S.cfg.network.chainId });
    toast('Sent. Waiting for confirmation…');
    await waitForTransactionReceipt(S.wagmi, { hash, chainId: S.cfg.network.chainId, timeout: 120000 });
    await readChain();
    return true;
  } catch (e) {
    S.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e, S.cfg);
    S.chainId = getAccount(S.wagmi).chainId ?? S.chainId;
    return false;
  } finally {
    S.busy = null; render();
  }
}

function readForm() {
  const f = {
    approve: Number($('#f-approve')?.value ?? S.form.approve),
    maxPerCharge: Number($('#f-charge')?.value ?? S.form.maxPerCharge),
    maxPerPeriod: Number($('#f-period')?.value ?? S.form.maxPerPeriod),
  };
  S.form = { approve: String(f.approve), maxPerCharge: String(f.maxPerCharge), maxPerPeriod: String(f.maxPerPeriod) };
  if (!(f.maxPerCharge > 0 && f.maxPerPeriod > 0 && f.approve > 0)) return 'All three amounts must be more than 0.';
  if (f.maxPerCharge > f.maxPerPeriod) return 'The per-charge limit cannot be higher than the 30-day limit.';
  if (f.approve < f.maxPerPeriod) return 'Approve at least as much as your 30-day limit, or charges will stop early.';
  return null;
}

const approve = () => send('approve', {
  address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'approve',
  args: [S.bcfg.contract, toUnits(S.form.approve)],
});

async function activate() {
  const ok = await send(S.account?.active ? 'limits' : 'enroll', {
    address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll',
    args: [toUnits(S.form.maxPerCharge), toUnits(S.form.maxPerPeriod)],
  });
  if (ok) { S.editLimits = false; toast(S.account?.active ? 'Billing is active.' : 'Saved.'); if (!S.session) signIn(); else loadMe(); }
}

async function cancelBilling() {
  if (!confirm('Cancel AI billing? Your API key will stop working until you activate again.')) return;
  const ok = await send('cancel', { address: S.bcfg.contract, abi: BILLING_ABI, functionName: 'cancel', args: [] });
  if (ok) { toast('Billing cancelled.'); loadMe(); }
}

// ------------------------------------------------------------------ sign in + dashboard
async function signIn() {
  S.busy = 'signin'; S.error = null; render();
  try {
    const { time, message } = await api(`/api/billing/login-message?wallet=${S.address}`);
    const signature = await signMessage(S.wagmi, { message });
    const { session } = await api('/api/billing/login', { method: 'POST', body: { wallet: S.address, time, signature } });
    S.session = session;
    try { sessionStorage.setItem(sessionKey(), session); } catch { /* ignore */ }
    if (S.account?.active) await api('/api/billing/register', { method: 'POST', body: {}, auth: session }).catch(() => {});
    await loadMe();
  } catch (e) {
    S.error = e.status ? e.message : friendlyWalletError(e, S.cfg);
  } finally {
    S.busy = null; render();
  }
}

async function loadMe() {
  if (!S.session) return;
  try {
    S.me = await api('/api/billing/me', { auth: S.session });
    if (S.me.chain?.active && !S.me.registered) {
      await api('/api/billing/register', { method: 'POST', body: {}, auth: S.session });
      S.me = await api('/api/billing/me', { auth: S.session });
    }
  } catch (e) {
    if (e.status === 401) { S.session = null; S.me = null; try { sessionStorage.removeItem(sessionKey()); } catch { /* ignore */ } }
    else S.error = e.message;
  }
  render();
}

async function newApiKey() {
  if (S.me?.apiKeyHint && !confirm('Create a new key? The old key stops working immediately.')) return;
  try {
    const r = await api('/api/billing/api-key', { method: 'POST', body: {}, auth: S.session });
    S.newKey = r.apiKey;
    await loadMe();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ render
function stepState() {
  const connected = !!S.address;
  const need = S.form.approve ? toUnits(S.form.approve) : 0n;
  const approved = connected && S.allowance !== null && S.allowance > 0n && S.allowance >= (need || 1n);
  const active = !!S.account?.active;
  return { connected, approved, active };
}

function render() {
  if (!S.cfg) return;
  const body = $('#setup-body');
  const steps = $('#setup-steps');

  if (!S.bcfg?.enabled) {
    steps.innerHTML = '';
    body.innerHTML = `<p class="msg warn">AI billing isn't switched on yet. Please check back soon.</p>`;
    return;
  }

  const st = stepState();
  const labels = [
    ['Connect wallet', st.connected],
    ['Choose limits', st.active && !S.editLimits],
    [`Approve ${SYM()}`, st.approved],
    ['Activate', st.active && !S.editLimits],
  ];
  const current = !st.connected ? 0 : (!st.active || S.editLimits) ? (st.approved ? 3 : 1) : 4;
  steps.innerHTML = labels.map(([l, done], i) =>
    `<li class="${done ? 'done' : i === current || (current === 1 && i === 2) ? 'now' : ''}">${esc(l)}</li>`).join('');

  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const busy = (k, label) => (S.busy === k ? `<span class="spinner" aria-hidden="true"></span> ${label}` : null);

  if (!st.connected) {
    body.innerHTML = `${err}<button class="btn btn-primary btn-block" id="connect" type="button">Connect wallet</button>
      <p class="small">Works with Trust Wallet, MetaMask and other wallets on ${esc(S.cfg.network.name)}.</p>`;
    $('#dashboard').hidden = true;
    return;
  }

  const walletLine = `<div class="wallet-row"><span>Wallet <code>${esc(short(S.address))}</code>${S.balance !== null ? `, ${esc(num(fromUnits(S.balance), 4))} ${esc(SYM())}` : ''}</span>
    <button class="link-btn" id="change-wallet" type="button">Change</button></div>`;
  const wrongNet = S.chainId !== S.cfg.network.chainId
    ? `<div class="msg warn">Your wallet is on another network. <button class="link-btn" id="switch-net" type="button">${S.busy === 'switch' ? 'Check your wallet…' : `Switch to ${esc(S.cfg.network.name)}`}</button></div>` : '';

  if (st.active && !S.editLimits) {
    body.innerHTML = `${walletLine}${wrongNet}${err}
      <p class="msg ok">Billing is active. Limits: ${esc(num(fromUnits(S.account.maxPerCharge)))} ${esc(SYM())} per charge, ${esc(num(fromUnits(S.account.maxPerPeriod)))} ${esc(SYM())} per 30 days.</p>
      ${S.session ? '' : `<button class="btn btn-primary btn-block" id="signin" type="button">${busy('signin', 'Check your wallet') || 'Sign in to see usage'}</button>
      <p class="small">Signing a message is free and doesn't send any transaction.</p>`}`;
  } else {
    const allowanceTxt = S.allowance !== null ? `${num(fromUnits(S.allowance))} ${SYM()}` : '…';
    body.innerHTML = `${walletLine}${wrongNet}
      <div class="row">
        <div class="field"><label for="f-charge">Max per charge (${esc(SYM())})</label><input id="f-charge" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerCharge)}" /></div>
        <div class="field"><label for="f-period">Max per 30 days (${esc(SYM())})</label><input id="f-period" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerPeriod)}" /></div>
      </div>
      <div class="field">
        <label for="f-approve">Approval amount (${esc(SYM())})</label>
        <input id="f-approve" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.approve)}" />
        <span class="hint">This is permission, not a payment. Charges still stop at your limits above. Currently approved: ${esc(allowanceTxt)}.</span>
      </div>
      ${err}
      ${!st.approved || (S.form.approve && S.allowance < toUnits(S.form.approve))
        ? `<button class="btn btn-primary btn-block" id="approve" type="button" ${S.busy ? 'disabled' : ''}>${busy('approve', 'Confirm in your wallet') || `Step 1 of 2: Approve ${esc(S.form.approve || '')} ${esc(SYM())}`}</button>` : ''}
      <button class="btn ${st.approved ? 'btn-primary' : 'btn-ghost'} btn-block" id="activate" type="button" ${S.busy || !st.approved ? 'disabled' : ''}>
        ${busy('enroll', 'Confirm in your wallet') || busy('limits', 'Confirm in your wallet') || (st.active ? 'Save new limits' : 'Step 2 of 2: Activate billing')}
      </button>
      ${S.editLimits ? '<button class="link-btn" id="stop-edit" type="button">Keep current limits</button>' : ''}
      <p class="small">Each step asks for a small ${esc(S.cfg.network.gasToken)} network fee in your wallet.</p>`;
  }

  renderDashboard();
}

function renderDashboard() {
  const d = $('#dashboard');
  if (!S.session || !S.me) { d.hidden = true; return; }
  d.hidden = false;
  const m = S.me; const c = m.chain || {};
  $('#dash-stats').innerHTML = [
    ['Tokens used', num(m.tokensUsed, 0)],
    [`Due now (${SYM()})`, m.due],
    [`Paid so far (${SYM()})`, m.paid],
    [`Left this 30 days (${SYM()})`, c.remainingInPeriod ?? '-'],
  ].map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  $('#key-box').innerHTML = S.newKey
    ? `<div class="copy-line"><code>${esc(S.newKey)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(S.newKey)}">Copy</button></div>
       <p class="msg warn">Copy it now. It won't be shown again.</p>`
    : m.apiKeyHint ? `<p>Active key ending in <code>${esc(m.apiKeyHint)}</code></p>` : '<p class="small">No key yet.</p>';
  $('#new-key').textContent = m.apiKeyHint || S.newKey ? 'Create new key' : 'Create API key';
  $('#new-key').disabled = !c.active;

  $('#limit-box').innerHTML = c.active
    ? `<p>${esc(c.maxPerCharge)} ${esc(SYM())} per charge, ${esc(c.maxPerPeriod)} ${esc(SYM())} per 30 days.<br/>
       <span class="small">Approved: ${esc(c.allowance)} ${esc(SYM())}. Used this window: ${esc(c.spentInPeriod)}. Resets ${esc(when(c.periodResets))}.</span></p>`
    : `<p class="msg warn">Billing is cancelled. Activate again above to use your API key.</p>`;
  $('#cancel-billing').hidden = !c.active;
  $('#edit-limits').hidden = !c.active;

  const explorer = S.cfg.network.explorer;
  $('#usage-table').innerHTML = m.usage.length
    ? `<thead><tr><th>When</th><th>Tokens</th><th>Cost (${esc(SYM())})</th><th>Note</th></tr></thead><tbody>${m.usage.map((u) =>
        `<tr><td>${esc(when(u.created_at))}</td><td>${esc(num(u.tokens, 0))}</td><td>${esc(u.cost)}</td><td>${esc(u.note || '')}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No usage yet.</td></tr></tbody>';
  $('#charge-table').innerHTML = m.charges.length
    ? `<thead><tr><th>When</th><th>Amount (${esc(SYM())})</th><th>Status</th><th>Transaction</th></tr></thead><tbody>${m.charges.map((ch) =>
        `<tr><td>${esc(when(ch.created_at))}</td><td>${esc(ch.amount)}</td><td class="status ${esc(ch.status)}">${esc(ch.status)}</td>
         <td>${ch.tx_hash && explorer ? `<a href="${esc(explorer)}/tx/${esc(ch.tx_hash)}" target="_blank" rel="noopener">${esc(short(ch.tx_hash))}</a>` : esc(short(ch.tx_hash || ''))}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No charges yet.</td></tr></tbody>';
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy failed'); } return; }
  switch (b.id) {
    case 'connect':
      S.error = null;
      try { await connectWallet({ appkit: S.appkit, wagmi: S.wagmi }); }
      catch (err) { S.error = friendlyWalletError(err, S.cfg); render(); }
      return;
    case 'change-wallet': return S.appkit.open();
    case 'switch-net': {
      S.busy = 'switch'; S.error = null; render();
      try { if (!(await switchToStoreChain(S.cfg, S.wagmi))) S.error = switchHelpText(S.cfg); }
      catch (err) { S.error = friendlyWalletError(err, S.cfg); }
      S.busy = null; S.chainId = getAccount(S.wagmi).chainId ?? null;
      if (S.chainId === S.cfg.network.chainId) await readChain();
      return render();
    }
    case 'approve': { const err = readForm(); if (err) { S.error = err; return render(); } return approve(); }
    case 'activate': { const err = readForm(); if (err) { S.error = err; return render(); } return activate(); }
    case 'signin': return signIn();
    case 'refresh': await readChain(); return loadMe();
    case 'new-key': return newApiKey();
    case 'edit-limits':
      S.editLimits = true;
      S.form.maxPerCharge = fromUnits(S.account.maxPerCharge);
      S.form.maxPerPeriod = fromUnits(S.account.maxPerPeriod);
      S.form.approve = String(Math.max(Number(S.form.approve || 0), Number(S.form.maxPerPeriod)));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return render();
    case 'stop-edit': S.editLimits = false; S.error = null; return render();
    case 'cancel-billing': return cancelBilling();
  }
});
// keep typed values across re-renders
document.addEventListener('input', (e) => {
  if (e.target.id === 'f-approve') S.form.approve = e.target.value;
  if (e.target.id === 'f-charge') S.form.maxPerCharge = e.target.value;
  if (e.target.id === 'f-period') S.form.maxPerPeriod = e.target.value;
  if (e.target.id === 'f-approve') {
    const btn = $('#approve');
    if (btn && !S.busy) btn.textContent = `Step 1 of 2: Approve ${e.target.value} ${SYM()}`;
  }
});

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    [S.cfg, S.bcfg] = await Promise.all([api('/api/config'), api('/api/billing/config')]);
  } catch {
    $('#setup-body').innerHTML = '<p class="msg err">The server isn\'t reachable right now. Refresh in a minute.</p>';
    return;
  }
  const { cfg, bcfg } = S;
  document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = cfg.storeName; });
  document.querySelectorAll('[data-token]').forEach((el) => { el.textContent = SYM(); });
  document.querySelectorAll('[data-net]').forEach((el) => { el.textContent = cfg.network.name; });
  document.title = `${cfg.storeName} AI tokens, billed in ${SYM()}`;
  $('#price').textContent = num(bcfg.pricePer1k, 6);
  const pill = $('#net-pill'); pill.textContent = cfg.network.name; pill.hidden = false;
  if (bcfg.contract) {
    const link = cfg.network.explorer ? `<a href="${esc(cfg.network.explorer)}/address/${esc(bcfg.contract)}#code" target="_blank" rel="noopener">${esc(short(bcfg.contract))}</a>` : esc(short(bcfg.contract));
    $('#contract-line').innerHTML = `Billing contract: ${link}. You can read its code and every charge on the explorer.`;
  }
  S.form = { approve: String(bcfg.defaults.approve), maxPerCharge: String(bcfg.defaults.maxPerCharge), maxPerPeriod: String(bcfg.defaults.maxPerPeriod) };

  const w = initWallet(cfg, 'AI tokens billed in USDT');
  S.appkit = w.appkit; S.wagmi = w.wagmi;

  const onAccount = async (acct) => {
    const changed = acct.address !== S.address;
    S.address = acct.isConnected ? acct.address : null;
    S.chainId = acct.chainId ?? null;
    if (!changed && acct.chainId === S.cfg.network.chainId && S.allowance === null && S.address) { await readChain(); }
    if (changed) {
      S.allowance = S.balance = S.account = null; S.me = null; S.newKey = null; S.error = null;
      try { S.session = S.address ? sessionStorage.getItem(sessionKey()) : null; } catch { S.session = null; }
      render();
      if (S.address) { await readChain(); if (S.session) await loadMe(); }
    }
    render();
  };
  watchAccount(S.wagmi, { onChange: onAccount });
  await onAccount(getAccount(S.wagmi));
})();
