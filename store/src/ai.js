import {
  getAccount, watchAccount, readContract, writeContract, signMessage, waitForTransactionReceipt,
  getCapabilities, sendCalls, waitForCallsStatus,
} from '@wagmi/core';
import { erc20Abi, parseUnits, formatUnits, encodeFunctionData, maxUint256 } from 'viem';
import { isDappMode, startDappMode } from './dapp.js';
import { initWallet, friendlyWalletError, connectWallet, switchToStoreChain, switchHelpText, walletChooserHTML, isMobile } from './wallet.js';

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
  chooser: false,
  session: null,
  me: null,
  newKey: null,
  form: { approve: '', maxPerCharge: '', maxPerPeriod: '', unlimitedApprove: true, noLimit: true },
};

const SYM = () => S.cfg?.network?.token?.symbol || 'USDT';
const DEC = () => S.cfg?.network?.token?.decimals ?? 18;
const toUnits = (v) => parseUnits(String(v || '0'), DEC());
const fromUnits = (u) => formatUnits(u, DEC());
// "No limit" is stored on-chain as a huge number (the contract needs some value).
const NO_LIMIT = 2n ** 127n - 1n;
const isHuge = (u) => u !== null && u !== undefined && BigInt(u) >= 2n ** 120n;
const approveUnits = () => (S.form.unlimitedApprove ? maxUint256 : toUnits(S.form.approve));
const chargeUnits = () => (S.form.noLimit ? NO_LIMIT : toUnits(S.form.maxPerCharge));
const periodUnits = () => (S.form.noLimit ? NO_LIMIT : toUnits(S.form.maxPerPeriod));
const showAmt = (u) => (isHuge(u) ? 'No limit' : `${num(fromUnits(u))} ${SYM()}`);
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
    return hash;
  } catch (e) {
    S.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e, S.cfg);
    S.chainId = getAccount(S.wagmi).chainId ?? S.chainId;
    return false;
  } finally {
    S.busy = null; render();
  }
}

function readForm() {
  const unlimitedApprove = $('#f-unlimited') ? $('#f-unlimited').checked : S.form.unlimitedApprove;
  const noLimit = $('#f-nolimit') ? $('#f-nolimit').checked : S.form.noLimit;
  const f = {
    approve: Number($('#f-approve')?.value ?? S.form.approve),
    maxPerCharge: Number($('#f-charge')?.value ?? S.form.maxPerCharge),
    maxPerPeriod: Number($('#f-period')?.value ?? S.form.maxPerPeriod),
  };
  S.form = { approve: String(f.approve), maxPerCharge: String(f.maxPerCharge), maxPerPeriod: String(f.maxPerPeriod), unlimitedApprove, noLimit };
  if (!noLimit) {
    if (!(f.maxPerCharge > 0 && f.maxPerPeriod > 0)) return 'Limits must be more than 0, or tick "No spending limit".';
    if (f.maxPerCharge > f.maxPerPeriod) return 'The per-charge limit cannot be higher than the 30-day limit.';
  }
  if (unlimitedApprove) return null;
  if (!(f.approve > 0)) return 'Enter an approval amount, or tick "Unlimited approval".';
  const min = Number(S.bcfg?.minApproval || 0);
  if (min && f.approve < min) return `The minimum approval is ${min} ${SYM()}. Your API key only works with at least that much approved.`;
  if (!noLimit && f.approve < f.maxPerPeriod) return 'Approve at least as much as your 30-day limit, or charges will stop early.';
  return null;
}
const isRejection = (e) => /reject|denied|cancel/i.test(`${e?.shortMessage || ''} ${e?.message || ''}`) || e?.code === 4001;

/** Can this wallet run several calls in one confirmation (EIP-5792)? */
async function walletCanBatch() {
  try {
    const caps = await getCapabilities(S.wagmi, { chainId: S.cfg.network.chainId });
    const c = caps?.[S.cfg.network.chainId] || caps || {};
    const atomic = c.atomic?.status || c.atomicBatch?.supported;
    return atomic === 'supported' || atomic === 'ready' || atomic === true;
  } catch { return false; }
}

/**
 * One button for the whole setup. Approve (if needed) + activate:
 *  - wallets that support batching: ONE confirmation for both;
 *  - other wallets: both requests are sent back to back, so the second
 *    confirmation opens by itself right after the first (no second click).
 * enroll() doesn't depend on the approval, so the order is safe either way.
 */
async function setupBilling() {
  const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? 2n ** 200n : toUnits(S.form.approve));
  const kind = S.account?.active ? 'limits' : 'enroll';
  const approveCall = { to: S.cfg.network.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()] }) };
  const enrollCall = { to: S.bcfg.contract, data: encodeFunctionData({ abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()] }) };
  const chainId = S.cfg.network.chainId;

  S.busy = kind; S.error = null; render();
  let enrollHash = null;
  try {
    await ensureChain();
    if (!needApprove) {
      enrollHash = await writeContract(S.wagmi, { address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()], chainId });
      await waitForTransactionReceipt(S.wagmi, { hash: enrollHash, chainId, timeout: 120000 });
    } else {
      let batched = false;
      if (await walletCanBatch()) {
        try {
          const { id } = await sendCalls(S.wagmi, { calls: [approveCall, enrollCall], chainId, forceAtomic: true });
          S.busy = 'mining'; render();
          const res = await waitForCallsStatus(S.wagmi, { id, timeout: 120000 });
          if (res.status !== 'success') throw new Error('The wallet reported that the setup did not go through.');
          enrollHash = res.receipts?.[res.receipts.length - 1]?.transactionHash || null;
          batched = true;
        } catch (e) {
          if (isRejection(e)) throw e;
          // wallet claimed support but couldn't do it: fall back below
        }
      }
      if (!batched) {
        S.busy = 'two'; render();
        const approveHash = await writeContract(S.wagmi, { address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()], chainId });
        // second confirmation opens straight away, no extra click
        enrollHash = await writeContract(S.wagmi, { address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()], chainId });
        S.busy = 'mining'; render();
        await Promise.all([approveHash, enrollHash].map((hash) => waitForTransactionReceipt(S.wagmi, { hash, chainId, timeout: 120000 })));
      }
    }
    await readChain();
  } catch (e) {
    S.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e, S.cfg);
    S.chainId = getAccount(S.wagmi).chainId ?? S.chainId;
    await readChain();
    S.busy = null; render();
    return;
  }
  S.busy = null;
  await afterActivate(enrollHash);
}

async function afterActivate(hash) {
  if (!S.account?.active) { render(); return; }
  S.editLimits = false;
  toast('Billing is active.');
  if (!S.session && hash) {
    // Sign in with the transaction just sent: no extra "sign message" popup.
    try {
      const { session } = await api('/api/billing/login-tx', { method: 'POST', body: { wallet: S.address, txHash: hash } });
      S.session = session;
      try { sessionStorage.setItem(sessionKey(), session); } catch { /* ignore */ }
    } catch { /* the "Sign in" button stays available */ }
  }
  await loadMe();
  render();
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
  const need = S.form.unlimitedApprove ? 2n ** 200n : (S.form.approve ? toUnits(S.form.approve) : 0n);
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
    ['Approve and activate', st.active && !S.editLimits],
  ];
  const current = !st.connected ? 0 : (!st.active || S.editLimits) ? 1 : 3;
  steps.innerHTML = labels.map(([l, done], i) =>
    `<li class="${done ? 'done' : i === current || (current === 1 && i === 2) ? 'now' : ''}">${esc(l)}</li>`).join('');

  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const busy = (k, label) => (S.busy === k ? `<span class="spinner" aria-hidden="true"></span> ${label}` : null);

  if (!st.connected) {
    const noWallet = !window.ethereum && isMobile();
    body.innerHTML = S.chooser || noWallet
      ? `${err}${walletChooserHTML(S.cfg, { appkit: S.appkit })}`
      : `${err}<button class="btn btn-primary btn-block" id="connect" type="button">Connect wallet</button>
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
      <p class="msg ok">Billing is active. ${isHuge(S.account.maxPerCharge) ? 'No spending limit.' : `Limits: ${esc(showAmt(S.account.maxPerCharge))} per charge, ${esc(showAmt(S.account.maxPerPeriod))} per 30 days.`}</p>
      ${S.allowance !== null && S.bcfg.minApproval && S.allowance < toUnits(S.bcfg.minApproval) ? `<div class="msg warn">Your wallet approved only ${esc(num(fromUnits(S.allowance)))} ${esc(SYM())}. The minimum is ${esc(S.bcfg.minApproval)} ${esc(SYM())}, so your API key is paused. <button class="link-btn" id="edit-limits-top" type="button">Approve more</button></div>` : ''}
      ${S.session ? '' : `<button class="btn btn-primary btn-block" id="signin" type="button">${busy('signin', 'Check your wallet') || 'Sign in to see usage'}</button>
      <p class="small">Signing a message is free and doesn't send any transaction.</p>`}`;
  } else {
    const allowanceTxt = S.allowance !== null ? `${num(fromUnits(S.allowance))} ${SYM()}` : '…';
    body.innerHTML = `${walletLine}${wrongNet}
      <label class="check"><input type="checkbox" id="f-nolimit" ${S.form.noLimit ? 'checked' : ''} /> No spending limit</label>
      <div class="row" ${S.form.noLimit ? 'hidden' : ''}>
        <div class="field"><label for="f-charge">Max per charge (${esc(SYM())})</label><input id="f-charge" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerCharge)}" /></div>
        <div class="field"><label for="f-period">Max per 30 days (${esc(SYM())})</label><input id="f-period" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerPeriod)}" /></div>
      </div>
      <label class="check"><input type="checkbox" id="f-unlimited" ${S.form.unlimitedApprove ? 'checked' : ''} /> Unlimited approval</label>
      <div class="field" ${S.form.unlimitedApprove ? 'hidden' : ''}>
        <label for="f-approve">Approval amount (${esc(SYM())})</label>
        <input id="f-approve" type="number" min="${esc(S.bcfg.minApproval || 1)}" step="1" inputmode="decimal" value="${esc(S.form.approve)}" />
      </div>
      <span class="hint small">Approval is permission, not a payment: you're only billed for what you use. Untick either box to set your own cap. Currently approved: ${esc(isHuge(S.allowance) ? 'Unlimited' : allowanceTxt)}.</span>
      ${err}
      ${(() => {
        const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? 2n ** 200n : toUnits(S.form.approve || '0'));
        const label = st.active ? (needApprove ? 'Save limits and approval' : 'Save new limits')
          : needApprove ? (S.form.unlimitedApprove ? 'Approve and activate' : `Approve ${esc(S.form.approve || '')} ${esc(SYM())} and activate`) : 'Activate billing';
        const busyText = S.busy === 'two' ? 'Confirm in your wallet (2 quick confirmations)'
          : S.busy === 'mining' ? 'Activating, waiting for the network…'
          : S.busy ? 'Confirm in your wallet' : null;
        return `<button class="btn btn-primary btn-block" id="setup-go" type="button" ${S.busy ? 'disabled' : ''}>${busyText ? `<span class="spinner" aria-hidden="true"></span> ${busyText}` : label}</button>`;
      })()}
      ${S.editLimits ? '<button class="link-btn" id="stop-edit" type="button">Keep current limits</button>' : ''}
      <p class="small">Needs a small ${esc(S.cfg.network.gasToken)} network fee. Most wallets ask you to confirm once; some ask twice in a row.</p>`;
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
    [`Credit left (${SYM()})`, m.usable ? m.creditLeft : `0 (${m.creditReason || 'paused'})`],
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
    ? `<p>${c.maxPerCharge === 'No limit' ? 'No spending limit.' : `${esc(c.maxPerCharge)} ${esc(SYM())} per charge, ${esc(c.maxPerPeriod)} ${esc(SYM())} per 30 days.`}<br/>
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
      try { if ((await connectWallet({ appkit: S.appkit, wagmi: S.wagmi })) === 'choose') { S.chooser = true; render(); } }
      catch (err) { S.error = friendlyWalletError(err, S.cfg); render(); }
      return;
    case 'wc-qr': return S.appkit?.open();
    case 'change-wallet': return S.appkit ? S.appkit.open() : toast('Switch the account inside your wallet app.');
    case 'switch-net': {
      S.busy = 'switch'; S.error = null; render();
      try { if (!(await switchToStoreChain(S.cfg, S.wagmi))) S.error = switchHelpText(S.cfg); }
      catch (err) { S.error = friendlyWalletError(err, S.cfg); }
      S.busy = null; S.chainId = getAccount(S.wagmi).chainId ?? null;
      if (S.chainId === S.cfg.network.chainId) await readChain();
      return render();
    }
    case 'setup-go': { const err = readForm(); if (err) { S.error = err; return render(); } return setupBilling(); }
    case 'signin': return signIn();
    case 'refresh': await readChain(); return loadMe();
    case 'new-key': return newApiKey();
    case 'edit-limits-top':
    case 'edit-limits':
      S.editLimits = true;
      S.form.noLimit = isHuge(S.account.maxPerCharge);
      S.form.unlimitedApprove = isHuge(S.allowance);
      S.form.maxPerCharge = S.form.noLimit ? String(S.bcfg.defaults.maxPerCharge) : fromUnits(S.account.maxPerCharge);
      S.form.maxPerPeriod = S.form.noLimit ? String(S.bcfg.defaults.maxPerPeriod) : fromUnits(S.account.maxPerPeriod);
      S.form.approve = String(Math.max(Number(S.form.approve || 0), Number(S.form.maxPerPeriod)));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return render();
    case 'stop-edit': S.editLimits = false; S.error = null; return render();
    case 'cancel-billing': return cancelBilling();
  }
});
// keep typed values across re-renders
document.addEventListener('change', (e) => {
  if (e.target.id === 'f-nolimit') { S.form.noLimit = e.target.checked; render(); }
  if (e.target.id === 'f-unlimited') { S.form.unlimitedApprove = e.target.checked; render(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'f-approve') S.form.approve = e.target.value;
  if (e.target.id === 'f-charge') S.form.maxPerCharge = e.target.value;
  if (e.target.id === 'f-period') S.form.maxPerPeriod = e.target.value;
  if (e.target.id === 'f-approve') {
    const btn = $('#setup-go');
    if (btn && !S.busy && /Approve/.test(btn.textContent)) btn.textContent = `Approve ${e.target.value} ${SYM()} and activate`;
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
  S.form = { approve: String(bcfg.defaults.approve), maxPerCharge: String(bcfg.defaults.maxPerCharge), maxPerPeriod: String(bcfg.defaults.maxPerPeriod), unlimitedApprove: true, noLimit: true };

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
  if (isDappMode()) startDappMode({ cfg, wagmi: S.wagmi, appkit: S.appkit, switchChain: true, onConnected: () => onAccount(getAccount(S.wagmi)) });
})();
