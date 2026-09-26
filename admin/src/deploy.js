import { BrowserProvider, ContractFactory, Contract, Wallet, getAddress, isAddress, parseEther, formatEther } from 'ethers';
import BUILD from './billing-build.json';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');

let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400); }
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Copy failed, select and copy manually'); } }

const S = {
  cfg: null, provider: null, signer: null, account: null, chainId: null, balance: null,
  keeperSecret: null, busy: null, error: null, deployed: null, funded: false,
};

// Explorer/network details for the wallet's "add network" request.
const CHAIN_PARAMS = {
  56: { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
};

function friendly(e) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  if (e?.code === 'ACTION_REJECTED' || m.includes('reject') || m.includes('denied')) return 'You cancelled it in your wallet. Nothing happened.';
  if (m.includes('insufficient funds')) return `Not enough ${S.cfg.network.gasToken} in this wallet for the network fee.`;
  return e?.shortMessage || e?.message || 'Something went wrong.';
}

// ------------------------------------------------------------------ wallet
async function connect() {
  if (!window.ethereum) {
    S.error = 'No wallet found in this browser. Open this page on a computer with the MetaMask extension, or in the MetaMask app\'s built-in browser.';
    return render();
  }
  try {
    S.provider = new BrowserProvider(window.ethereum, 'any');
    await S.provider.send('eth_requestAccounts', []);
    await refreshWallet();
    window.ethereum.on?.('accountsChanged', () => refreshWallet());
    window.ethereum.on?.('chainChanged', () => refreshWallet());
  } catch (e) { S.error = friendly(e); }
  render();
}

async function refreshWallet() {
  try {
    S.provider = new BrowserProvider(window.ethereum, 'any');
    S.signer = await S.provider.getSigner();
    S.account = await S.signer.getAddress();
    S.chainId = Number((await S.provider.getNetwork()).chainId);
    S.balance = await S.provider.getBalance(S.account);
    if (S.pendingOpen && S.chainId === S.cfg.network.chainId && !S.deployed) {
      const addr = S.pendingOpen; S.pendingOpen = null;
      await loadContract(addr, { quiet: true });
    }
    if (!$('#treasury').value) $('#treasury').value = S.cfg?.recipient || S.account;
  } catch { /* shown as not connected */ }
  render();
}

async function switchNetwork() {
  const id = S.cfg.network.chainId;
  const hex = `0x${id.toString(16)}`;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if ((e?.code === 4902 || String(e?.message).includes('Unrecognized')) && CHAIN_PARAMS[id]) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[id]] });
    } else { S.error = friendly(e); }
  }
  await refreshWallet();
}

// ------------------------------------------------------------------ keeper
function generateKeeper() {
  if (S.keeperSecret && !confirm('Create another keeper wallet? The one shown now will be discarded.')) return;
  const w = Wallet.createRandom();
  S.keeperSecret = { address: w.address, privateKey: w.privateKey, saved: false };
  $('#keeper').value = w.address;
  render();
}

// ------------------------------------------------------------------ deploy
function readInputs() {
  const keeper = $('#keeper').value.trim();
  const treasury = $('#treasury').value.trim();
  if (!isAddress(keeper)) return { error: 'Enter a valid keeper address, or create a new keeper wallet.' };
  if (!isAddress(treasury)) return { error: 'Enter a valid treasury address.' };
  if (getAddress(keeper) === getAddress(treasury)) return { error: 'Keeper and treasury must be different wallets.' };
  if (S.account && getAddress(keeper) === getAddress(S.account)) return { error: "Don't use your owner wallet as the keeper. Its key would have to go on the server." };
  if (S.keeperSecret && getAddress(keeper) === getAddress(S.keeperSecret.address) && !S.keeperSecret.saved) return { error: "Save the keeper's private key first and tick the box in step 2." };
  return { keeper: getAddress(keeper), treasury: getAddress(treasury) };
}

async function deploy() {
  const inp = readInputs();
  if (inp.error) { S.error = inp.error; return render(); }
  const net = S.cfg.network;
  if (!confirm(`Deploy the billing contract on ${net.name}?\n\nToken: ${net.token.symbol} ${net.token.address}\nTreasury: ${inp.treasury}\nKeeper: ${inp.keeper}\n\nYour wallet will ask you to confirm and pay a small ${net.gasToken} fee.`)) return;
  S.busy = 'deploy'; S.error = null; render();
  try {
    const factory = new ContractFactory(BUILD.abi, BUILD.bytecode, S.signer);
    const c = await factory.deploy(net.token.address, inp.treasury, inp.keeper);
    S.busy = 'mining'; render();
    await c.waitForDeployment();
    const address = await c.getAddress();
    const tx = c.deploymentTransaction();
    let block = null;
    try { block = (await tx?.wait())?.blockNumber ?? null; } catch { /* optional */ }
    // Read back what the chain actually stored
    const live = new Contract(address, BUILD.abi, S.provider);
    const [token, treasury, keeper, owner] = await Promise.all([live.token(), live.treasury(), live.keeper(), live.owner()]);
    S.deployed = { address, tx: tx?.hash, block, token, treasury, keeper, owner, paused: false };
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ address, tx: tx?.hash, block })); } catch { /* ignore */ }
    toast('Contract deployed');
  } catch (e) {
    S.error = friendly(e);
  } finally {
    S.busy = null; render();
  }
}

const SAVED_KEY = 'tohfa:deployed-billing';

/** Read an already-deployed TokenBilling contract from the chain. */
async function loadContract(address, { quiet = false } = {}) {
  if (!isAddress(address)) { if (!quiet) { S.error = 'That is not a valid contract address.'; render(); } return false; }
  if (!S.provider || !S.account) { if (!quiet) { S.error = 'Connect your wallet in step 1 first.'; render(); } return false; }
  if (S.chainId !== S.cfg.network.chainId) { if (!quiet) { S.error = `Switch your wallet to ${S.cfg.network.name} first.`; render(); } return false; }
  try {
    const live = new Contract(getAddress(address), BUILD.abi, S.provider);
    const [token, treasury, keeper, owner, paused] = await Promise.all([live.token(), live.treasury(), live.keeper(), live.owner(), live.paused()]);
    let saved = null; try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); } catch { /* ignore */ }
    const same = saved?.address && getAddress(saved.address) === getAddress(address);
    S.deployed = { address: getAddress(address), tx: same ? saved.tx : null, block: same ? saved.block : null, token, treasury, keeper, owner, paused };
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ address: S.deployed.address, tx: S.deployed.tx, block: S.deployed.block })); } catch { /* ignore */ }
    S.error = null;
    render();
    return true;
  } catch (e) {
    if (!quiet) { S.error = `Couldn't read a billing contract at that address on ${S.cfg.network.name}. ${e.shortMessage || ''}`; render(); }
    return false;
  }
}

async function ownerTx(label, fn) {
  S.busy = label; S.error = null; render();
  try {
    const c = new Contract(S.deployed.address, BUILD.abi, S.signer);
    const tx = await fn(c);
    await tx.wait();
    await loadContract(S.deployed.address, { quiet: true });
    toast('Done');
  } catch (e) { S.error = friendly(e); }
  S.busy = null; render();
}

function changeKeeper() {
  const k = $('#keeper').value.trim();
  if (!isAddress(k)) { S.error = 'Create a new keeper wallet in step 2 first (or paste a keeper address there).'; return render(); }
  if (S.keeperSecret && getAddress(k) === getAddress(S.keeperSecret.address) && !S.keeperSecret.saved) { S.error = "Save the new keeper's private key and tick the box in step 2 first."; return render(); }
  if (getAddress(k) === getAddress(S.deployed.keeper)) { S.error = 'That is already the keeper.'; return render(); }
  if (!confirm(`Change the keeper to ${k}?\n\nThe old keeper stops working immediately. Put the new keeper's private key in Render afterwards.`)) return;
  return ownerTx('keeper', (c) => c.setKeeper(getAddress(k)));
}

async function fundKeeper() {
  const amt = $('#fund-amt').value.trim() || '0.005';
  S.busy = 'fund'; S.error = null; render();
  try {
    const tx = await S.signer.sendTransaction({ to: S.deployed.keeper, value: parseEther(amt) });
    await tx.wait();
    S.funded = true;
    toast(`Sent ${amt} ${S.cfg.network.gasToken} to the keeper`);
  } catch (e) { S.error = friendly(e); }
  S.busy = null; await refreshWallet();
}

// ------------------------------------------------------------------ render
function render() {
  const net = S.cfg?.network;
  if (!net) return;
  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const explorer = net.explorer;
  const addrLink = (a) => (explorer ? `<a href="${explorer}/address/${a}" target="_blank" rel="noopener">${esc(a)}</a>` : esc(a));

  // step 1
  const onRight = S.chainId === net.chainId;
  $('#wallet-body').innerHTML = !S.account
    ? `${err}<button class="btn btn-primary" id="connect" type="button">Connect MetaMask</button>`
    : `<p>Connected: <span class="mono">${esc(S.account)}</span></p>
       <p class="small">Balance: ${S.balance !== null ? esc(Number(formatEther(S.balance)).toFixed(5)) : '…'} ${esc(net.gasToken)}. This wallet becomes the contract <strong>owner</strong>: it can pause billing and change the keeper or treasury. Keep it off the server.</p>
       ${onRight ? `<p class="msg ok">Wallet is on ${esc(net.name)}.</p>` : `<p class="msg warn">Your wallet is on another network (chain ${esc(S.chainId)}). The store runs on ${esc(net.name)} (chain ${net.chainId}).</p>
       <button class="btn btn-primary" id="switch" type="button">Switch to ${esc(net.name)}</button>`}`;

  // step 2 secret
  const ks = S.keeperSecret;
  $('#keeper-secret').innerHTML = ks ? `
    <div class="secret">
      <strong>New keeper wallet: save this private key now</strong>
      <span class="small">It is shown only once and is not stored anywhere. You'll paste it into Render as KEEPER_PRIVATE_KEY. Anyone with it can use the keeper's gas money, but cannot take customer funds.</span>
      <div class="copy-line"><code class="mono">${esc(ks.privateKey)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(ks.privateKey)}">Copy</button></div>
      <label class="small"><input type="checkbox" id="saved-key" ${ks.saved ? 'checked' : ''}/> I saved the private key somewhere safe</label>
    </div>` : '';

  $('#token-line').innerHTML = `${esc(net.token.symbol)} on ${esc(net.name)}: ${addrLink(net.token.address)}`;

  // step 4
  const d = S.deployed;
  if (d) {
    const ok = [d.token, d.treasury, d.keeper].every(Boolean);
    const env = `NETWORK=${net.key}\nBILLING_CONTRACT=${d.address}${d.block ? `\nBILLING_START_BLOCK=${d.block}` : ''}${ks && ks.address === d.keeper ? `\nKEEPER_PRIVATE_KEY=${ks.privateKey}` : '\nKEEPER_PRIVATE_KEY=<private key of ' + d.keeper + '>'}`;
    $('#deploy-body').innerHTML = `
      <p class="msg ok">Deployed. Contract address:</p>
      <div class="copy-line"><code class="mono">${esc(d.address)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(d.address)}">Copy</button></div>
      ${d.tx && explorer ? `<a href="${explorer}/tx/${d.tx}" target="_blank" rel="noopener">View deployment on the explorer</a>` : ''}
      <table><tbody>
        <tr><th>Owner</th><td class="mono">${addrLink(d.owner)}</td></tr>
        <tr><th>Token</th><td class="mono">${addrLink(d.token)}</td></tr>
        <tr><th>Treasury</th><td class="mono">${addrLink(d.treasury)}</td></tr>
        <tr><th>Keeper</th><td class="mono">${addrLink(d.keeper)}</td></tr>
      </tbody></table>
      ${ok ? '' : '<p class="msg err">Could not read back all values. Check the contract on the explorer.</p>'}

      ${d.paused ? '<p class="msg err">Billing is paused. Charges will fail until you unpause.</p>' : ''}
      ${S.account && getAddress(S.account) === getAddress(d.owner) ? `
        <h3>Owner controls</h3>
        <p class="small">Lost the keeper key, or think it leaked? Create a new keeper wallet in step 2, tick the box, then change the keeper here. No need to deploy again.</p>
        <div class="row">
          <button class="btn btn-ghost btn-sm" id="set-keeper" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'keeper' ? '<span class="spinner"></span> Confirm in wallet' : 'Change keeper to the address in step 2'}</button>
          <button class="btn btn-ghost btn-sm ${d.paused ? '' : 'danger'}" id="toggle-pause" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'pause' ? '<span class="spinner"></span> Confirm in wallet' : d.paused ? 'Unpause billing' : 'Pause all billing'}</button>
        </div>` : `<p class="small">Connect the owner wallet (${esc(short(d.owner))}) to change the keeper or pause billing.</p>`}

      <h3>Give the keeper gas money</h3>
      <p class="small">The keeper pays a tiny ${esc(net.gasToken)} fee for each charge.</p>
      <div class="row">
        <div class="field"><label for="fund-amt">Amount (${esc(net.gasToken)})</label><input id="fund-amt" type="number" min="0" step="0.001" value="0.005" /></div>
      </div>
      <button class="btn ${S.funded ? 'btn-ghost' : 'btn-primary'}" id="fund" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'fund' ? '<span class="spinner"></span> Confirm in wallet' : S.funded ? 'Send more' : 'Send to keeper'}</button>

      <h3>Last step: add these in Render → Environment</h3>
      <div class="env-lines">${esc(env)}</div>
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(env)}">Copy all</button>
      <p class="small">Also add SERVICE_API_KEY (any long password). Save, let Render redeploy, then check the AI token billing section in the admin panel.</p>
      ${err}
      <p class="small"><button class="link-btn" id="new-deploy" type="button">Deploy a different contract instead</button></p>`;
    return;
  }
  const busyLabel = S.busy === 'deploy' ? 'Confirm in your wallet' : S.busy === 'mining' ? 'Deploying, waiting for the block' : null;
  $('#deploy-body').innerHTML = `
    ${err}
    <button class="btn btn-primary" id="deploy" type="button" ${!S.account || !onRight || S.busy ? 'disabled' : ''}>
      ${busyLabel ? `<span class="spinner"></span> ${busyLabel}` : 'Deploy contract'}
    </button>
    ${!S.account ? '<p class="small">Connect your wallet in step 1 first.</p>' : !onRight ? `<p class="small">Switch to ${esc(net.name)} in step 1 first.</p>` : `<p class="small">Costs a small ${esc(net.gasToken)} network fee, paid by your connected wallet.</p>`}
    <h3>Already deployed?</h3>
    <p class="small">You don't need to deploy again. Paste the contract address to open it (find it in MetaMask activity, or on the explorer under your owner wallet as "Contract Creation").</p>
    <div class="copy-line"><input id="existing" placeholder="0x... contract address" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:6px;font:inherit" /><button class="btn btn-ghost btn-sm" id="open-existing" type="button">Open</button></div>`;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) return copy(b.dataset.copy);
  S.error = null;
  switch (b.id) {
    case 'connect': return connect();
    case 'switch': return switchNetwork();
    case 'gen-keeper': return generateKeeper();
    case 'deploy': return deploy();
    case 'fund': return fundKeeper();
    case 'open-existing': return loadContract($('#existing').value.trim());
    case 'set-keeper': return changeKeeper();
    case 'toggle-pause': {
      const next = !S.deployed.paused;
      if (!confirm(next ? 'Pause all billing? No charges can go through until you unpause.' : 'Unpause billing?')) return;
      return ownerTx('pause', (c) => c.setPaused(next));
    }
    case 'new-deploy':
      if (!confirm('Clear this contract from the page and deploy a new one? The old contract keeps existing on the chain.')) return;
      S.deployed = null; try { localStorage.removeItem(SAVED_KEY); } catch { /* ignore */ }
      return render();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'saved-key' && S.keeperSecret) { S.keeperSecret.saved = e.target.checked; }
});

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    const res = await fetch('/api/config');
    S.cfg = await res.json();
  } catch {
    $('#wallet-body').innerHTML = '<p class="msg err">The server is not reachable.</p>';
    return;
  }
  const pill = $('#net-pill'); pill.textContent = `${S.cfg.network.token.symbol} on ${S.cfg.network.name}`; pill.hidden = false;
  let known = null;
  try {
    const b = await (await fetch('/api/billing/config')).json();
    if (b.contract) {
      known = b.contract;
      $('.intro').insertAdjacentHTML('afterend', `<p class="msg ok">The server already uses billing contract ${esc(b.contract)}. It opens below once your wallet is connected. No need to deploy again.</p>`);
    }
  } catch { /* ignore */ }
  if (!known) { try { known = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null')?.address || null; } catch { /* ignore */ } }
  S.pendingOpen = known;
  render();
  if (window.ethereum) {
    try {
      const accts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accts?.length) { S.provider = new BrowserProvider(window.ethereum, 'any'); await refreshWallet(); }
    } catch { /* not connected yet */ }
  }
})();
