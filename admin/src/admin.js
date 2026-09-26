const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KEY = 'tohfa:admin-key';

let key = sessionStorage.getItem(KEY) || '';
let data = null;
let bill = null;   // AI billing overview

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'x-admin-key': key, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Wrong admin key.'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function logout() {
  sessionStorage.removeItem(KEY);
  key = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
  ['#logout', '#refresh', '#net-pill'].forEach((s) => { $(s).hidden = true; });
}

async function load() {
  [data, bill] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/billing').catch((e) => ({ error: e.message })),
  ]);
  $('#login').hidden = true;
  $('#app').hidden = false;
  ['#logout', '#refresh'].forEach((s) => { $(s).hidden = false; });
  const pill = $('#net-pill');
  const isTest = data.network.key.includes('sepolia');
  pill.textContent = `${isTest ? 'Test mode' : 'Live'}: ${data.network.token.symbol} on ${data.network.name}`;
  pill.classList.toggle('test', isTest);
  pill.hidden = false;
  render();
}

function renderBilling() {
  const sym = data.network.token.symbol;
  const explorer = data.network.explorer;
  const link = (kind, h, text) => (h ? (explorer ? `<a href="${explorer}/${kind}/${esc(h)}" target="_blank" rel="noopener">${esc(text || short(h))}</a>` : esc(text || short(h))) : '');
  const box = $('#billing-status');
  if (!bill || bill.error) { box.innerHTML = `<p class="msg err">${esc(bill?.error || 'Billing data not available.')}</p>`; return; }
  const st = bill.status;
  if (!st.enabled) {
    box.innerHTML = `<p class="msg warn">Billing is off. <a href="./deploy.html">Deploy the billing contract</a> from your wallet, then add <code>BILLING_CONTRACT</code> and <code>KEEPER_PRIVATE_KEY</code> in Render.</p>`;
  } else {
    box.innerHTML = `
      ${st.problems.length ? `<div class="problems">${st.problems.map((p) => `<p class="msg err">${esc(p)}</p>`).join('')}</div>` : ''}
      <div class="stats">
        <div class="stat"><div class="k">Contract</div><div class="v">${link('address', st.contract)}</div></div>
        <div class="stat"><div class="k">Status</div><div class="v">${st.paused ? '<span class="pill off">Paused</span>' : '<span class="pill on">Running</span>'}</div></div>
        <div class="stat"><div class="k">Keeper wallet</div><div class="v">${st.keeperConfigured ? link('address', st.keeperAddress) : '<span class="pill off">No key</span>'}</div></div>
        <div class="stat"><div class="k">Keeper gas</div><div class="v">${st.keeperGas !== undefined ? `${Number(st.keeperGas).toFixed(4)} ${esc(data.network.gasToken)}` : '-'}</div></div>
        <div class="stat"><div class="k">Customers</div><div class="v">${bill.totals.accounts}</div></div>
        <div class="stat"><div class="k">Collected (${esc(sym)})</div><div class="v">${esc(bill.totals.paid)}</div></div>
      </div>`;
  }

  // settings form (don't overwrite while typing)
  const s = bill.settings;
  const setIfIdle = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  setIfIdle('#s-price', s.pricePer1k); setIfIdle('#s-approve', s.defaultApprove);
  setIfIdle('#s-charge', s.defaultMaxPerCharge); setIfIdle('#s-period', s.defaultMaxPerPeriod);
  $('label[for="s-price"]').textContent = `Price per 1,000 tokens (${sym})`;

  const sel = $('#u-wallet'); const cur = sel.value;
  sel.innerHTML = bill.accounts.length
    ? bill.accounts.map((a) => `<option value="${a.wallet}">${esc(a.label || short(a.wallet))}${a.email ? ` (${esc(a.email)})` : ''}</option>`).join('')
    : '<option value="">No customers yet</option>';
  if (cur) sel.value = cur;
  updateCost();

  $('#billing-accounts').innerHTML = bill.accounts.length ? `
    <thead><tr><th>Customer</th><th>On-chain</th><th>Limits (charge / 30d)</th><th>Left 30d</th><th>Approved</th><th>Balance</th><th>Tokens</th><th>Due</th><th>Can charge now</th><th>Amount</th><th></th><th></th></tr></thead>
    <tbody>${bill.accounts.map((a) => {
      const c = a.chain || {};
      return `<tr data-wallet="${a.wallet}">
        <td>${link('address', a.wallet, a.label || short(a.wallet))}${a.email ? `<br/><span class="small">${esc(a.email)}</span>` : ''}${a.blocked ? ' <span class="pill off">Blocked</span>' : ''}</td>
        <td>${c.active ? '<span class="pill on">Active</span>' : '<span class="pill off">Off</span>'}</td>
        <td>${c.active ? `${esc(c.maxPerCharge)} / ${esc(c.maxPerPeriod)}` : '-'}</td>
        <td>${esc(c.remainingInPeriod ?? '-')}</td>
        <td>${esc(c.allowance ?? '-')}</td>
        <td>${esc(c.balance ?? '-')}</td>
        <td>${Number(a.tokensUsed).toLocaleString('en-IN')}</td>
        <td><strong>${esc(a.due)}</strong>${Number(a.inFlight) > 0 ? `<br/><span class="small">${esc(a.inFlight)} in progress</span>` : ''}</td>
        <td>${Number(a.chargeableNow) > 0 ? esc(a.chargeableNow) : `<span class="small">${esc(a.cannotChargeReason || '0')}</span>`}</td>
        <td><input class="amt-in" type="number" min="0" step="0.01" placeholder="${esc(a.chargeableNow)}" aria-label="Amount to charge" /></td>
        <td><button class="btn btn-primary btn-sm" data-charge="${a.wallet}" type="button" ${Number(a.chargeableNow) > 0 && st.keeperConfigured ? '' : 'disabled'}>Charge</button></td>
        <td><button class="btn btn-ghost btn-sm" data-block="${a.wallet}" data-state="${a.blocked ? 0 : 1}" type="button">${a.blocked ? 'Unblock' : 'Block'}</button></td>
      </tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td>No customers yet. They appear after activating on the AI tokens page.</td></tr></tbody>';

  $('#billing-charges').innerHTML = bill.charges.length ? `
    <thead><tr><th>When</th><th>Customer</th><th>Amount (${esc(sym)})</th><th>Status</th><th>Transaction</th><th>Error</th></tr></thead>
    <tbody>${bill.charges.map((c) => `<tr>
      <td>${when(c.created_at)}</td><td>${esc(short(c.wallet))}</td><td>${esc(c.amount)}</td>
      <td class="status ${esc(c.status)}">${esc(c.status)}</td><td>${link('tx', c.tx_hash)}</td><td class="small">${esc(c.error || '')}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No charges yet.</td></tr></tbody>';
}

function updateCost() {
  if (!bill?.settings) return;
  const t = Number($('#u-tokens').value);
  $('#u-cost').textContent = t > 0 ? `Cost: ${(t / 1000 * bill.settings.pricePer1k).toFixed(6)} ${data.network.token.symbol}` : '';
}

function render() {
  const { products, orders, unmatched, totals, rate, network, wallet, chain } = data;
  const sym = network.token.symbol;
  const warn = $('#chain-warn');
  warn.hidden = !!chain?.ok;
  warn.textContent = chain?.ok ? '' : `Blockchain se connection nahi hai, payments confirm nahi hongi. ${chain?.error || ''}`;
  const stock = products.reduce((n, p) => n + p.in_stock, 0);
  const waiting = orders.filter((o) => o.status === 'needs_code').length;

  $('#stats').innerHTML = [
    ['Paid orders', totals.orders],
    [`${sym} received`, totals.received],
    ['Codes in stock', stock],
    ['Paid, waiting for a code', waiting],
    [`${sym} rate`, `₹${Number(rate.rate).toFixed(2)} (${rate.source})`],
    ['Receiving wallet', `<a href="${network.explorer}/address/${wallet}" target="_blank" rel="noopener">${short(wallet)}</a>`],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  $('#products').innerHTML = `
    <thead><tr><th>Card</th><th>Category</th><th>Face value ₹</th><th>Discount %</th><th>Price now</th><th>In stock</th><th>Held</th><th>Sold</th><th>Shown</th><th></th></tr></thead>
    <tbody>${products.map((p) => `
      <tr data-id="${p.id}">
        <td><span class="swatch" style="background:${esc(p.color)}"></span>${esc(p.brand)}, ${esc(p.name)}</td>
        <td>${esc(p.category)}</td>
        <td><input type="number" min="1" data-f="face_value_inr" value="${p.face_value_inr}" aria-label="Face value" /></td>
        <td><input type="number" min="0" max="89" step="0.5" data-f="discount_pct" value="${p.discount_pct}" aria-label="Discount" /></td>
        <td>${esc(p.price)} ${esc(sym)}</td>
        <td>${p.in_stock}</td>
        <td>${p.reserved}</td>
        <td>${p.sold}</td>
        <td><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''} aria-label="Show in store" style="width:auto" /></td>
        <td><button class="btn btn-ghost btn-sm" data-save="${p.id}" type="button">Save</button></td>
      </tr>`).join('')}</tbody>`;

  const sel = $('#codes-product').value;
  $('#codes-product').innerHTML = products.map((p) => `<option value="${p.id}">${esc(p.brand)}, ${esc(p.name)} ${inr(p.face_value_inr)}</option>`).join('');
  if (sel) $('#codes-product').value = sel;

  const tx = (h) => (h ? `<a href="${network.explorer}/tx/${esc(h)}" target="_blank" rel="noopener">${short(h)}</a>` : '');
  $('#orders').innerHTML = orders.length ? `
    <thead><tr><th>Created</th><th>Order</th><th>Card</th><th>Amount</th><th>Status</th><th>Payment</th><th>Payer</th><th>Email</th></tr></thead>
    <tbody>${orders.map((o) => `
      <tr>
        <td>${when(o.created_at)}</td>
        <td>${esc(o.id)}</td>
        <td>${esc(o.product_name)} ${inr(o.face_value_inr)}</td>
        <td>${esc(o.amount)}</td>
        <td class="status ${esc(o.status)}">${esc(o.status.replace('_', ' '))}</td>
        <td>${tx(o.tx_hash) || (o.claimed_tx ? `claimed ${tx(o.claimed_tx)}` : '')}</td>
        <td>${o.payer ? short(o.payer) : ''}</td>
        <td>${esc(o.email || '')}</td>
      </tr>`).join('')}</tbody>` : '<tbody><tr><td>No orders yet.</td></tr></tbody>';

  $('#unmatched').innerHTML = unmatched.length ? `
    <thead><tr><th>Seen</th><th>Amount ${esc(sym)}</th><th>From</th><th>Transaction</th></tr></thead>
    <tbody>${unmatched.map((u) => `
      <tr><td>${when(u.seen_at)}</td><td>${esc(u.amount)}</td>
      <td><a href="${network.explorer}/address/${esc(u.payer)}" target="_blank" rel="noopener">${short(u.payer)}</a></td>
      <td>${tx(u.tx_hash)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td>None. Every payment matched an order.</td></tr></tbody>';

  renderBilling();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.id === 'login-btn') {
      key = $('#key').value.trim();
      $('#login-err').hidden = true;
      try { await load(); sessionStorage.setItem(KEY, key); }
      catch (err) { $('#login-err').textContent = err.message; $('#login-err').hidden = false; }
      return;
    }
    if (b.id === 'logout') return logout();
    if (b.id === 'refresh') { await load(); return toast('Up to date'); }

    if (b.dataset.save) {
      const row = b.closest('tr');
      const body = {};
      row.querySelectorAll('[data-f]').forEach((i) => { body[i.dataset.f] = i.type === 'checkbox' ? i.checked : Number(i.value); });
      await api(`/api/admin/products/${b.dataset.save}`, { method: 'PATCH', body });
      await load();
      return toast('Card saved');
    }

    if (b.id === 'add-codes') {
      const codes = $('#codes').value;
      const r = await api(`/api/admin/products/${$('#codes-product').value}/codes`, { method: 'POST', body: { codes } });
      $('#codes').value = '';
      await load();
      return toast(`Added ${r.added}${r.duplicates ? `, skipped ${r.duplicates} duplicate${r.duplicates > 1 ? 's' : ''}` : ''}${r.delivered ? `, delivered ${r.delivered} waiting order${r.delivered > 1 ? 's' : ''}` : ''}`);
    }

    if (b.dataset.charge) {
      const row = b.closest('tr');
      const amount = row.querySelector('.amt-in').value.trim();
      const shown = amount || row.querySelector('.amt-in').placeholder;
      if (!confirm(`Charge ${shown} ${data.network.token.symbol} from ${short(b.dataset.charge)}?`)) return;
      b.disabled = true; b.textContent = 'Charging…';
      try {
        const r = await api('/api/admin/billing/charge', { method: 'POST', body: { wallet: b.dataset.charge, amount: amount || undefined } });
        toast(r.charge.status === 'paid' ? `Charged ${r.charge.amount} ${data.network.token.symbol}` : `Charge ${r.charge.status}`);
      } finally { await load(); }
      return;
    }

    if (b.dataset.block) {
      await api('/api/admin/billing/account', { method: 'POST', body: { wallet: b.dataset.block, blocked: b.dataset.state === '1' } });
      await load();
      return toast(b.dataset.state === '1' ? 'Customer blocked: their API key stops working' : 'Customer unblocked');
    }

    if (b.id === 'add-usage') {
      const wallet = $('#u-wallet').value;
      if (!wallet) return toast('No customer selected.');
      const r = await api('/api/admin/billing/usage', { method: 'POST', body: { wallet, tokens: Number($('#u-tokens').value), note: $('#u-note').value } });
      $('#u-tokens').value = ''; $('#u-note').value = '';
      await load();
      return toast(`Added ${r.cost} ${data.network.token.symbol}. Due now: ${r.due}`);
    }

    if (b.id === 'save-billing') {
      await api('/api/admin/billing/settings', { method: 'POST', body: {
        pricePer1k: $('#s-price').value, defaultApprove: $('#s-approve').value,
        defaultMaxPerCharge: $('#s-charge').value, defaultMaxPerPeriod: $('#s-period').value,
      } });
      await load();
      return toast('Billing settings saved');
    }

    if (b.id === 'add-product') {
      const body = {
        brand: $('#np-brand').value, name: $('#np-name').value || 'Gift card', category: $('#np-cat').value || 'Shopping',
        face_value_inr: Number($('#np-face').value), discount_pct: Number($('#np-disc').value), color: $('#np-color').value,
      };
      await api('/api/admin/products', { method: 'POST', body });
      ['#np-brand', '#np-name', '#np-cat', '#np-face'].forEach((s) => { $(s).value = ''; });
      await load();
      return toast('Card added. Add codes to put it in stock.');
    }
  } catch (err) {
    toast(err.message);
  }
});

$('#u-tokens').addEventListener('input', updateCost);
$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

if (key) load().catch(() => logout());
// Auto-refresh every 30s, but not while you're editing a row in the cards table.
setInterval(() => {
  if (!key || document.hidden || $('#app').hidden || $('#products').contains(document.activeElement) || $('#billing').contains(document.activeElement)) return;
  load().catch(() => {});
}, 30000);
