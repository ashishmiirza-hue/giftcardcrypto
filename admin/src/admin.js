const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KEY = 'tohfa:admin-key';

let key = sessionStorage.getItem(KEY) || '';
let data = null;

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
  data = await api('/api/admin/overview');
  $('#login').hidden = true;
  $('#app').hidden = false;
  ['#logout', '#refresh'].forEach((s) => { $(s).hidden = false; });
  const pill = $('#net-pill');
  pill.textContent = data.network.key === 'base' ? 'Live: Base' : 'Test mode: Base Sepolia';
  pill.classList.toggle('test', data.network.key !== 'base');
  pill.hidden = false;
  render();
}

function render() {
  const { products, orders, unmatched, totals, rate, network, wallet, chain } = data;
  const warn = $('#chain-warn');
  warn.hidden = !!chain?.ok;
  warn.textContent = chain?.ok ? '' : `Blockchain se connection nahi hai, payments confirm nahi hongi. ${chain?.error || ''}`;
  const stock = products.reduce((n, p) => n + p.in_stock, 0);
  const waiting = orders.filter((o) => o.status === 'needs_code').length;

  $('#stats').innerHTML = [
    ['Paid orders', totals.orders],
    ['USDC received', totals.usdc],
    ['Codes in stock', stock],
    ['Paid, waiting for a code', waiting],
    ['USDC rate', `₹${Number(rate.rate).toFixed(2)} (${rate.source})`],
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
        <td>${esc(p.price_usdc)} USDC</td>
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
    <thead><tr><th>Seen</th><th>Amount USDC</th><th>From</th><th>Transaction</th></tr></thead>
    <tbody>${unmatched.map((u) => `
      <tr><td>${when(u.seen_at)}</td><td>${esc(u.amount)}</td>
      <td><a href="${network.explorer}/address/${esc(u.payer)}" target="_blank" rel="noopener">${short(u.payer)}</a></td>
      <td>${tx(u.tx_hash)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td>None. Every payment matched an order.</td></tr></tbody>';
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

$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

if (key) load().catch(() => logout());
// Auto-refresh every 30s, but not while you're editing a row in the cards table.
setInterval(() => {
  if (!key || document.hidden || $('#app').hidden || $('#products').contains(document.activeElement)) return;
  load().catch(() => {});
}, 30000);
