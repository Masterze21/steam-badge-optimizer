// ── Icônes SVG (réutilisées dans le contenu dynamique) ──────────────────────

const ICONS = {
  scan:    '<svg class="ico ico--lg" viewBox="0 0 16 16"><circle cx="6.8" cy="6.8" r="4.3"/><line x1="9.9" y1="9.9" x2="14" y2="14"/></svg>',
  spinner: '<svg class="ico ico--lg ico-spin" viewBox="0 0 16 16"><path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8"/></svg>',
  pause:   '<svg class="ico ico--fill" viewBox="0 0 16 16"><rect x="4.2" y="3" width="2.6" height="10" rx="1"/><rect x="9.2" y="3" width="2.6" height="10" rx="1"/></svg>',
  play:    '<svg class="ico ico--fill" viewBox="0 0 16 16"><path d="M4.8 3l8 5-8 5z"/></svg>',
};

// ── Helpers ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function sendMsg(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res || {});
    });
  });
}

function fmt(cents) {
  return (Math.abs(cents) / 100).toFixed(2).replace('.', ',') + ' €';
}
function fmtSigned(cents) {
  return (cents >= 0 ? '+' : '−') + fmt(Math.abs(cents));
}

// ── État ───────────────────────────────────────────────────────────────────

let pollTimer    = null;
let lastPlan     = null;
let activeFilter = 'all';

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  loadSettings();
  bindEvents();
  await refreshStatus();
  startPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshStatus, 1500);
}

// ── Refresh (polling 1,5s) ─────────────────────────────────────────────────

async function refreshStatus() {
  let status;
  try { status = await sendMsg('GET_STATUS'); } catch (_) { return; }

  // Session indicator
  const si = $('session-indicator');
  const sl = $('session-label');
  if (status.hasSession) {
    si.className = 'session-pill session-on';
    sl.textContent = 'Connecté';
  } else {
    si.className = 'session-pill session-off';
    sl.textContent = 'Non connecté';
  }

  // Billing alert
  const ba = $('billing-alert');
  if (ba) ba.classList.toggle('hidden', status.hasBilling !== false);

  // Plan
  if (status.plan) {
    lastPlan = status.plan;
    renderDashboard(status.plan);
    renderPlanTab(status.plan);
  }

  // Running / progress
  const running = status.running;
  $('progress-section').classList.toggle('hidden', !running);
  $('action-buttons').classList.toggle('hidden', running);

  if (running) {
    const { done, total, lastAction } = status.progress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const labels = {
      phase1:  'Mise en vente des doublons',
      phase2:  'Achat & craft des badges',
      gems:    'Conversion en Gemmes',
      analyze: 'Scan de l\'inventaire…',
    };
    $('progress-phase-label').textContent = labels[status.currentPhase] || 'En cours…';
    $('progress-pct').textContent  = `${done} / ${total}  —  ${pct} %`;
    $('progress-fill').style.width = `${pct}%`;
    $('progress-detail').textContent = lastAction || '';
    $('btn-pause').innerHTML = status.paused
      ? `${ICONS.play}<span>Reprendre</span>`
      : `${ICONS.pause}<span>Pause</span>`;
  }
}

// ── Rendu Dashboard ────────────────────────────────────────────────────────

function renderDashboard(plan) {
  const sellQty = (plan.toSell || []).reduce((s, c) => s + c.qty, 0);
  const buyQty  = (plan.toBuy  || []).reduce((s, c) => s + c.qty, 0);

  // Stats row
  $('sc-sell').textContent   = sellQty   || '—';
  $('sc-buy').textContent    = buyQty    || '—';
  $('sc-badges').textContent = (plan.selected || []).length || '—';
  $('sc-xp').textContent     = plan.expectedXP ? `+${plan.expectedXP}` : '—';
  $('summary-grid').classList.remove('hidden');

  // Bilan
  $('bal-revenue').textContent = '+' + fmt(plan.totalSellRevenue || 0);
  $('bal-cost').textContent    = '−' + fmt(plan.totalBuyCost     || 0);
  const net   = plan.netBalance || 0;
  const netEl = $('bal-net');
  netEl.textContent = fmtSigned(net);
  netEl.className   = net >= 0 ? 'val-green' : 'val-red';
  $('balance-card').classList.remove('hidden');

  // Chips catégories
  const s = plan.stats || {};
  if (s.free || s.profitable || s.efficient) {
    $('badge-categories').classList.remove('hidden');
    setCatChip('cat-free',      s.free,       'chip-green');
    setCatChip('cat-profit',    s.profitable, 'chip-yellow');
    setCatChip('cat-efficient', s.efficient,  'chip-blue');
  }

  // Compteurs sur boutons
  setActionCount('btn-phase1-count', sellQty);
  setActionCount('btn-phase2-count', buyQty);

  // Enable
  $('btn-phase1').disabled = !plan.toSell || plan.toSell.length === 0;
  $('btn-phase2').disabled = !(plan.toBuy?.length) && !(plan.selected?.length);
}

function setCatChip(id, count, cls) {
  const el = $(id);
  if (!el) return;
  if (!count) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  // <b> inside chip holds count, text node holds label
  const b = el.querySelector('b');
  if (b) b.textContent = count;
}

function setActionCount(id, count) {
  const el = $(id);
  if (!el) return;
  if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

// ── Rendu onglet Plan ──────────────────────────────────────────────────────

function renderPlanTab(plan) {
  if (!plan.selected?.length) return;
  $('plan-empty').classList.add('hidden');
  $('plan-list-wrap').classList.remove('hidden');
  const tc = $('tab-plan-count');
  tc.textContent = plan.selected.length;
  tc.classList.remove('hidden');
  renderPlanList(plan.selected, activeFilter);
}

function renderPlanList(selected, filter) {
  const list = $('plan-list');
  list.innerHTML = '';

  const items = filter === 'all' ? selected : selected.filter(b => b.category === filter);

  if (!items.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--c-text-muted);font-size:11px">Aucun badge dans cette catégorie.</div>';
    return;
  }

  const catLabel = { free: 'Gratuit', profitable: 'Rentable', efficient: 'Efficace', expensive: 'Coûteux' };
  const catCls   = { free: 'pchip-free', profitable: 'pchip-profit', efficient: 'pchip-eff', expensive: 'pchip-exp' };

  for (const b of items.slice(0, 60)) {
    const nc = b.netCostToCraft;
    const costStr = nc < 0
      ? '+' + fmt(-nc) + ' gain'
      : nc === 0 ? 'Gratuit'
      : '−' + fmt(nc);
    const costCls = nc <= 0 ? 'cost-green' : 'cost-red';
    const roi = b.xpPerCent === Infinity ? '∞ XP/¢' : `${b.xpPerCent?.toFixed(1)} XP/¢`;

    const el = document.createElement('div');
    el.className = 'plan-item';
    el.innerHTML = `
      <div class="plan-item-left">
        <div class="plan-item-title">${b.isFoil ? '✦ ' : ''}${b.title || b.appid}</div>
        <div class="plan-item-sub">Niv. ${b.targetLevel} · ${b.cardsMissing?.length || 0} manquante(s) · ${roi}</div>
      </div>
      <div class="plan-item-right">
        <span class="plan-item-cost ${costCls}">${costStr}</span>
        <span class="plan-chip ${catCls[b.category] || 'pchip-exp'}">${catLabel[b.category] || b.category}</span>
      </div>`;
    list.appendChild(el);
  }
}

// ── Bindings ───────────────────────────────────────────────────────────────

function bindEvents() {
  // Onglets
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  // Filtres plan
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      if (lastPlan) renderPlanList(lastPlan.selected, activeFilter);
    });
  });

  // Modale info
  $('btn-info').addEventListener('click', () => $('modal-overlay').classList.remove('hidden'));
  $('modal-close').addEventListener('click', () => $('modal-overlay').classList.add('hidden'));
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) $('modal-overlay').classList.add('hidden');
  });

  // Bouton Scanner
  $('btn-analyze').addEventListener('click', async () => {
    clearError();
    setScanning(true);
    try {
      const res = await sendMsg('ANALYZE');
      if (res.error) throw new Error(res.error);
    } catch (e) { showError(e.message); }
    finally { setScanning(false); }
  });

  // Boutons d'action
  $('btn-phase1').addEventListener('click', async () => {
    clearError();
    try { const r = await sendMsg('RUN_PHASE1'); if (r.error) throw new Error(r.error); }
    catch (e) { showError(e.message); }
  });
  $('btn-phase2').addEventListener('click', async () => {
    clearError();
    try { const r = await sendMsg('RUN_PHASE2'); if (r.error) throw new Error(r.error); }
    catch (e) { showError(e.message); }
  });
  $('btn-gems').addEventListener('click', async () => {
    clearError();
    try { const r = await sendMsg('RUN_GEMS'); if (r.error) throw new Error(r.error); }
    catch (e) { showError(e.message); }
  });

  // Contrôles progress
  $('btn-pause').addEventListener('click', async () => {
    const s = await sendMsg('GET_STATUS');
    await sendMsg(s.paused ? 'RESUME' : 'PAUSE');
  });
  $('btn-stop').addEventListener('click', () => sendMsg('STOP'));

  // Réglages : sliders
  $('range-delay').addEventListener('input', () => {
    $('delay-val').textContent = Number($('range-delay').value).toLocaleString('fr') + ' ms';
  });
  $('range-maxlevel').addEventListener('input', () => {
    $('maxlevel-val').textContent = $('range-maxlevel').value;
  });

  $('btn-save-settings').addEventListener('click', saveSettings);
}

// ── Persistance des réglages ───────────────────────────────────────────────

async function loadSettings() {
  const s = await new Promise(r => chrome.storage.local.get('settings', d => r(d.settings || {})));
  if (s.strategy) {
    const r = document.querySelector(`input[name="strategy"][value="${s.strategy}"]`);
    if (r) r.checked = true;
  }
  if (s.includeFoils)       $('toggle-foils').checked = true;
  if (s.multiLevel !== false) $('toggle-multilevel').checked = true;
  if (s.maxCostPerBadge)    $('input-maxcost').value = s.maxCostPerBadge;
  if (s.delayMs)   { $('range-delay').value = s.delayMs;   $('delay-val').textContent   = Number(s.delayMs).toLocaleString('fr') + ' ms'; }
  if (s.maxLevel)  { $('range-maxlevel').value = s.maxLevel; $('maxlevel-val').textContent = s.maxLevel; }
  if (s.excludeAppids) $('input-exclude').value = s.excludeAppids.join(', ');
}

async function saveSettings() {
  const strategy = document.querySelector('input[name="strategy"]:checked')?.value || 'maxROI';
  const settings = {
    strategy,
    includeFoils:    $('toggle-foils').checked,
    multiLevel:      $('toggle-multilevel').checked,
    maxCostPerBadge: parseFloat($('input-maxcost').value) || 0,
    delayMs:         parseInt($('range-delay').value),
    maxLevel:        parseInt($('range-maxlevel').value),
    excludeAppids:   $('input-exclude').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  await new Promise(r => chrome.storage.local.set({ settings }, r));
  const el = $('settings-saved');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
}

// ── Helpers UI ─────────────────────────────────────────────────────────────

function setScanning(on) {
  $('btn-analyze').disabled = on;
  const label = $('btn-analyze').querySelector('.btn-primary-label');
  const hint  = $('btn-analyze').querySelector('.btn-primary-hint');
  if (label) label.innerHTML = on
    ? `${ICONS.spinner}<span class="btn-primary-text">Scan en cours…</span>`
    : `${ICONS.scan}<span class="btn-primary-text">Scanner l'inventaire</span>`;
  if (hint)  hint.textContent = on
    ? 'Inventaire · badges · prix du marché…'
    : 'Inventaire · badges · prix du marché Steam';
}

function showError(msg) {
  let el = $('error-msg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'error-msg';
    el.style.cssText = [
      'padding:8px 10px',
      'background:rgba(191,53,53,.12)',
      'border:1px solid rgba(191,53,53,.35)',
      'border-left:3px solid var(--c-red)',
      'border-radius:var(--radius)',
      'font-size:11px',
      'color:var(--c-red-text)',
      'line-height:1.45',
    ].join(';');
    $('tab-dashboard').appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  $('error-msg')?.classList.add('hidden');
}

init();
