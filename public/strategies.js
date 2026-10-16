/* strategies.js — Strategy Control Center.
 *
 * Every strategy (Over/Under, Differs, Even/Odd, Matches/Equals, Hot/Cold, UNDER3, UNDER4,
 * OVER6, OVER7) is an independent object with its OWN running flag, run id, cooldown, signal
 * memory and win/loss tally. Starting a strategy turns its AUTO-BUY on; stopping it turns it
 * off instantly. The Smart Strategy keeps its own panel and code; this file only presses its
 * Start/Stop buttons when you ask for it (Start All / Stop All / selected = Smart).
 *
 * Two button groups:
 *   1. ALL STRATEGIES  - enabled after you tick "Activate all strategies".
 *   2. SINGLE STRATEGY - pick one strategy from the list and start/stop just that one.
 */
(() => {
  'use strict';
  const L = window.StrategyLogic, C = window.BotCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COOLDOWN_MIN_S = 3;
  const SMART = { id: 'smart', label: 'Smart Strategy', group: 'Smart' };

  // ---- one independent state object per strategy ----------------------------------------
  const st = {};
  L.DEFS.forEach(def => {
    st[def.id] = {
      def, running: false, runId: null, pending: false, lastBuy: 0, confirmReal: false,
      lastKey: new Map(), sigs: new Map(), trades: 0, wins: 0, losses: 0, pl: 0, note: ''
    };
    C.registerOrigin(def.id, runId => st[def.id].running && (!runId || st[def.id].runId === runId));
  });
  const smartRunning = () => { const b = $('smartStop'); return !!b && !b.disabled; };
  C.registerOrigin('smart', () => smartRunning());
  const anyStandalone = () => L.DEFS.some(d => st[d.id].running);
  const anyRunning = () => anyStandalone() || smartRunning();

  // ---- helpers ----------------------------------------------------------------------------
  const toastMsg = t => { if (typeof window.toast === 'function') window.toast(t); };
  const shortName = n => String(n || '').replace(/^Volatility\s*/i, 'V').replace(/\s*Index$/i, '');

  function logRow(strategy, barrier, stake, status) {
    const tbody = $('tradeRows'); if (!tbody) return;
    if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
    const tr = document.createElement('tr');
    [new Date().toLocaleTimeString(), strategy, barrier === undefined ? '—' : barrier, stake, status].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    tbody.prepend(tr);
    while (tbody.children.length > 40) tbody.lastElementChild.remove();
  }

  async function checkAccount() {
    try {
      const d = await (await fetch('/api/deriv/accounts', { credentials: 'same-origin' })).json();
      if (!d.connected || !d.active) return { error: 'Connect a Deriv account first (use the Connect button in the Smart Strategy panel).' };
      const a = (d.accounts || []).find(x => x.loginid === d.active);
      if (!a) return { error: 'No active Deriv account selected.' };
      const mode = $('mode').value;
      if (mode === 'Demo' && !a.isVirtual) return { error: 'Selected account is real, but dashboard mode is Demo.' };
      if (mode === 'Real' && a.isVirtual) return { error: 'Selected account is virtual, but dashboard mode is Real.' };
      return { account: a };
    } catch (_) { return { error: 'Server unreachable.' }; }
  }

  async function pushLimits(resetSession) {
    try {
      await fetch('/api/risk', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionLossLimit: Number($('lossLimit').value), dailyStopLoss: Number($('stopLoss').value),
          dailyTarget: Number($('takeProfit').value), resetSession: !!resetSession
        })
      });
    } catch (_) { /* server-side defaults still apply */ }
  }

  const settings = () => ({
    ticks: Math.min(10, Math.max(1, Number($('stratTicks').value) || 1)),
    cooldownMs: Math.max(COOLDOWN_MIN_S, Number($('stratCooldown').value) || 15) * 1000,
    market: $('stratMarket').value
  });

  // ---- start / stop ------------------------------------------------------------------------
  function activate(id, real) {
    const s = st[id];
    s.running = true; s.runId = C.newRunId(id); s.confirmReal = real; s.pending = false;
    s.lastBuy = 0; s.lastKey.clear(); s.trades = s.wins = s.losses = 0; s.pl = 0; s.note = '';
  }

  function deactivate(id, why) {
    const s = st[id];
    if (!s.running) return;
    s.running = false;                    // 1. no more buys from this strategy, immediately
    C.stopRun(s.runId);                   // 2. queued jobs die, server refuses anything still in flight
    C.cancelSwitch(id);                   // 3. no Differs follow-up for this strategy
    s.runId = null; s.pending = false;
    s.note = why || 'Stopped';
  }

  let starting = false, cancelStart = false;
  async function startMany(ids) {
    if (starting) return false;
    starting = true; cancelStart = false;
    try {
      const acc = await checkAccount();
      if (cancelStart) return false;
      if (acc.error) { toastMsg(acc.error); return false; }
      const stake = Number($('stake').value), maxStake = Number($('maxStake').value);
      if (!Number.isFinite(stake) || stake <= 0 || stake > maxStake) { toastMsg('Stake must be positive and no greater than Max Stake.'); return false; }
      const real = !acc.account.isVirtual;
      if (real && !window.confirm('REAL MONEY WARNING: the selected strategies will automatically buy digit contracts on your REAL Deriv account. Losses are possible. Continue?')) return false;
      if (cancelStart) return false;
      if (!anyRunning()) await pushLimits(true);       // new session: P/L back to 0
      if (cancelStart) return false;
      ids.forEach(id => activate(id, real));
      return true;
    } finally { starting = false; refreshUI(); }
  }

  function clickSmart(start) {
    const b = $(start ? 'smartStart' : 'smartStop');
    if (b && !b.disabled) b.click();
  }

  function stopStandalone(why) { L.DEFS.forEach(d => deactivate(d.id, why)); }

  // Group 1 — all strategies
  async function startAll() {
    if (!$('activateAll').checked) return;
    const ok = await startMany(L.DEFS.map(d => d.id));
    if (ok) { clickSmart(true); toastMsg('All strategies started. Auto-buy is ON.'); }
    refreshUI();
  }
  function stopAll(why) {
    cancelStart = true;
    stopStandalone(why || 'Stopped by user');
    clickSmart(false);
    C.cancelSwitch();
    refreshUI();
    if (!why) toastMsg('All strategies stopped. No new trades will be placed.');
  }

  // Group 2 — one selected strategy
  async function startSelected() {
    if ($('activateAll').checked) return;
    const id = $('singleSelect').value;
    if (id === SMART.id) { clickSmart(true); refreshUI(); return; }
    const ok = await startMany([id]);
    if (ok) toastMsg(st[id].def.label + ' started. Auto-buy is ON.');
    refreshUI();
  }
  function stopSelected() {
    if ($('activateAll').checked) return;
    const id = $('singleSelect').value;
    cancelStart = true;
    if (id === SMART.id) clickSmart(false); else deactivate(id, 'Stopped by user');
    refreshUI();
    toastMsg('Stopped. No new trades from this strategy.');
  }

  // ---- ticks -> signals -> buys ---------------------------------------------------------------
  let dirty = true;
  function onTick(ev) {
    const feed = window.DerivFeed, mk = feed && feed.markets.get(ev.symbol);
    if (!mk) return;
    const cfg = settings();
    const inScope = cfg.market === 'volatility' || cfg.market === ev.symbol;
    L.DEFS.forEach(def => {
      const s = st[def.id];
      const sig = L.evaluate(def, mk, ev.epoch);
      const prev = s.sigs.get(ev.symbol);
      if (sig === undefined) { s.sigs.set(ev.symbol, { sig: null, at: 0, ready: false }); return; }
      if (sig) s.sigs.set(ev.symbol, { sig, at: Date.now(), ready: true });
      else if (def.momentary && prev && prev.sig && Date.now() - prev.at < L.CONFIG.HOLD_MS) { /* keep showing briefly */ }
      else s.sigs.set(ev.symbol, { sig: null, at: 0, ready: true });
      if (!inScope || !sig || !sig.type) return;
      C.emit('signal', { sid: def.id, label: def.label, symbol: mk.symbol, market: mk.name, short: sig.short, key: `${mk.symbol}:${sig.key}`, detail: sig.detail });
      if (s.running) tryBuy(s, mk, sig, cfg);
    });
    dirty = true;
  }

  function tryBuy(s, mk, sig, cfg) {
    const now = Date.now();
    if (s.pending || now - s.lastBuy < cfg.cooldownMs) return;
    if (s.lastKey.get(mk.symbol) === sig.key && s.def.momentary) return;
    s.lastKey.set(mk.symbol, sig.key);
    const stake = Number($('stake').value), maxStake = Number($('maxStake').value);
    const label = `${sig.name} · ${shortName(mk.name)}`;
    if (!(stake > 0) || stake > maxStake) { s.note = 'Stake must be positive and not above Max Stake.'; return; }
    const runId = s.runId;
    const body = {
      symbol: mk.symbol, direction: sig.type, duration: cfg.ticks, stake, strategy: sig.name,
      confirmReal: s.confirmReal, runId, sid: s.def.id, source: 'strategy'
    };
    if (sig.barrier !== undefined) body.barrier = sig.barrier;
    s.pending = true; s.lastBuy = now;
    logRow(label, sig.barrier, '—', 'SIGNAL → buying');
    C.enqueue({
      body,
      isActive: () => s.running && s.runId === runId,
      onDone: r => {
        if (s.runId === runId) { s.pending = false; s.lastBuy = Date.now(); }
        if (!r || r.dropped) return;                         // stopped or stale: nothing was bought
        const d = r.data || {};
        if (r.status === 403 && d.halted) { stopAll('Risk limit'); logRow(label, sig.barrier, stake, 'AUTO-BUY OFF: ' + d.error); return; }
        if (r.status === 409 && d.stopped) return;
        if (!r.ok) { logRow(label, sig.barrier, stake, 'NOT BOUGHT: ' + (d.error || 'Purchase failed.')); s.note = d.error || 'Purchase failed.'; return; }
        const profit = Number(d.profit) || 0;
        s.trades++; if (d.isWin) s.wins++; else s.losses++; s.pl += profit;
        logRow(label, sig.barrier, stake, `${d.isWin ? 'WIN' : 'LOSS'} #${d.contractId} · P/L ${profit}${s.running ? '' : ' (settled after stop)'}`);
        dirty = true;
      }
    });
  }

  // Switch rule messages (the engine lives in core.js)
  C.on('switch', e => logRow('Over/Under WIN → switching to Differs', e.to.barrier, e.to.stake, 'QUEUED next'));
  C.on('switch-done', e => {
    const r = e.result || {}, d = r.data || {};
    if (r.dropped) logRow('Differs (auto-switch)', e.body.barrier, e.body.stake, 'CANCELLED (strategy stopped)');
    else if (!r.ok) logRow('Differs (auto-switch)', e.body.barrier, e.body.stake, 'NOT BOUGHT: ' + (d.error || 'Purchase failed.'));
    else logRow('Differs (auto-switch)', e.body.barrier, e.body.stake, `${d.isWin ? 'WIN' : 'LOSS'} #${d.contractId} · P/L ${d.profit} · back to Over/Under`);
  });
  C.on('note', t => logRow('Auto-switch', '—', '—', t));
  C.on('halt', e => { stopAll('Risk limit'); toastMsg('Risk limit: ' + e.reason); });

  // ---- UI ----------------------------------------------------------------------------------------
  function buildPanel() {
    if ($('controlCenter')) return;
    const anchor = document.querySelector('.workgrid');
    if (!anchor) return;
    const opts = ['Original', 'Major Scanner'].map(g =>
      `<optgroup label="${g}">${L.DEFS.filter(d => d.group === g).map(d => `<option value="${d.id}">${esc(d.label)}</option>`).join('')}</optgroup>`
    ).join('') + `<optgroup label="Smart"><option value="smart">${SMART.label} (own panel)</option></optgroup>`;
    anchor.insertAdjacentHTML('afterend', `
<section class="panel control-center" id="controlCenter">
  <div class="sectionhead"><div><h2>🎛 Strategy Control Center</h2>
    <p>Every strategy runs on its own. Start = auto-buy ON. Stop = no new trade, instantly.</p></div>
    <span class="status" id="ccStatus">● All stopped</span></div>

  <div class="cc-settings">
    <label>Market <select id="stratMarket"><option value="volatility" selected>Volatility Markets</option></select></label>
    <label>Ticks per trade <select id="stratTicks">${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}"${n === 1 ? ' selected' : ''}>${n} tick${n > 1 ? 's' : ''}${n === 1 ? ' (default)' : ''}</option>`).join('')}</select></label>
    <label>Cooldown per strategy (s) <input id="stratCooldown" type="number" min="${COOLDOWN_MIN_S}" step="1" value="15"></label>
    <label class="cc-switch"><input type="checkbox" id="switchRule" checked> After an Over/Under WIN, switch to Differs automatically</label>
  </div>

  <div class="cc-groups">
    <div class="cc-group" id="groupAll">
      <h3>① ALL STRATEGIES AT ONCE</h3>
      <label class="cc-activate"><input type="checkbox" id="activateAll"> Activate all strategies</label>
      <div class="cc-buttons"><button class="start" id="startAll">▶ Start All</button><button class="stop" id="stopAll">■ Stop All</button></div>
      <small>Starts all 9 strategies plus the Smart Strategy, each with auto-buy.</small>
    </div>
    <div class="cc-group" id="groupSingle">
      <h3>② ONE SELECTED STRATEGY</h3>
      <label>Strategy <select id="singleSelect">${opts}</select></label>
      <div class="cc-buttons"><button class="start" id="startSel">▶ Start Selected</button><button class="stop" id="stopSel">■ Stop Selected</button></div>
      <small>Works on the chosen strategy only. Untick “Activate all” to use it.</small>
    </div>
  </div>

  <div class="cc-cards" id="ccCards"></div>
  <p class="smart-note">Trades are placed one at a time through a shared queue. A contract Deriv has already accepted cannot be recalled and settles normally; stopping prevents every later entry. Statistics are not predictions and no strategy guarantees profit.</p>
</section>`);

    $('ccCards').innerHTML = [...L.DEFS.map(d => ({ id: d.id, label: d.label, group: d.group })), SMART].map(d =>
      `<article class="cc-card" id="card-${d.id}"><header><b>${esc(d.label)}</b><small>${esc(d.group)}</small></header>
       <div class="cc-state" data-k="state">Stopped</div><div class="cc-sig" data-k="sig">—</div>
       <div class="cc-tally" data-k="tally"></div></article>`).join('');

    $('startAll').onclick = startAll;
    $('stopAll').onclick = () => stopAll();
    $('startSel').onclick = startSelected;
    $('stopSel').onclick = stopSelected;
    $('activateAll').onchange = refreshUI;
    $('singleSelect').onchange = refreshUI;
    $('switchRule').onchange = e => { C.setSwitchEnabled(e.target.checked); toastMsg(e.target.checked ? 'Over/Under win → Differs rule ON.' : 'Over/Under win → Differs rule OFF.'); };
    const ss = $('smartStop'); if (ss) ss.addEventListener('click', () => C.cancelSwitch('smart'));
  }

  function refreshUI() {
    if (!$('controlCenter')) return;
    const all = $('activateAll').checked, anyRun = anyRunning();
    const sel = $('singleSelect').value;
    const selRunning = sel === SMART.id ? smartRunning() : st[sel].running;
    $('activateAll').disabled = anyRun || starting;
    $('startAll').disabled = !all || starting || (anyStandalone() && smartRunning());
    $('stopAll').disabled = !all || !anyRun;
    $('singleSelect').disabled = all || anyRun;
    $('startSel').disabled = all || starting || anyRun;
    $('stopSel').disabled = all || !selRunning;
    $('groupAll').classList.toggle('off', !all);
    $('groupSingle').classList.toggle('off', all);
    const n = L.DEFS.filter(d => st[d.id].running).length + (smartRunning() ? 1 : 0);
    const badge = $('ccStatus');
    badge.textContent = n ? `● ${n} running (auto-buy ON)` : '● All stopped';
    badge.style.color = n ? '#00f59b' : '#ffc857';
  }

  function cardState(s) {
    if (!s.running) return [s.note && s.note !== 'Stopped' && s.note !== 'Stopped by user' ? 'Stopped · ' + s.note : 'Stopped', '#9fb7c9'];
    if (s.pending) return ['Trade in progress', '#ffe34e'];
    const ready = [...s.sigs.values()].some(v => v.ready);
    if (!ready) return ['Warming up (collecting ticks)', '#ffc857'];
    return ['Running · scanning', '#00f59b'];
  }

  function paint() {
    const feed = window.DerivFeed;
    const nameOf = sym => shortName(((feed && feed.markets.get(sym)) || {}).name || sym);
    L.DEFS.forEach(def => {
      const s = st[def.id], card = $('card-' + def.id); if (!card) return;
      const [txt, col] = cardState(s);
      const stEl = card.querySelector('[data-k=state]'); stEl.textContent = txt; stEl.style.color = col;
      const active = [...s.sigs.entries()].filter(([, v]) => v.sig);
      card.querySelector('[data-k=sig]').textContent = active.length
        ? `${nameOf(active[0][0])} ${active[0][1].sig.short}${active.length > 1 ? ` +${active.length - 1}` : ''}` : (s.sigs.size ? 'No signal' : 'Waiting for ticks');
      card.querySelector('[data-k=tally]').textContent = `${s.trades} trades · ${s.wins}W/${s.losses}L · ${s.pl >= 0 ? '+' : '-'}$${Math.abs(s.pl).toFixed(2)}`;
      card.classList.toggle('running', s.running);
    });
    const sc = $('card-smart');
    if (sc) {
      const run = smartRunning(), ssEl = sc.querySelector('[data-k=state]');
      ssEl.textContent = run ? 'Running (own panel)' : 'Stopped'; ssEl.style.color = run ? '#00f59b' : '#9fb7c9';
      sc.querySelector('[data-k=sig]').textContent = ($('smartProgress') || {}).textContent || '—';
      sc.classList.toggle('running', run);
    }
    // market list follows the live feed
    const sel = $('stratMarket');
    if (sel && feed && feed.markets.size && sel.options.length !== feed.markets.size + 1) {
      const keep = sel.value;
      sel.innerHTML = '<option value="volatility">Volatility Markets</option>' +
        [...feed.markets.values()].map(m => `<option value="${esc(m.symbol)}">${esc(m.name)}</option>`).join('');
      sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'volatility';
    }
    // floating monitors
    const PANELS = [{ panel: 'monitor1', ids: ['overunder', 'differs', 'evenodd', 'matches', 'hotcold'] }, { panel: 'monitor2', ids: ['UNDER3', 'UNDER4', 'OVER6', 'OVER7'] }];
    PANELS.forEach(p => {
      const rows = document.querySelectorAll('#' + p.panel + ' > div');
      p.ids.forEach((id, i) => {
        const row = rows[i], b = row && row.querySelector('b'); if (!b) return;
        const s = st[id];
        const tag = s.running ? ' ●' : '';
        const active = [...s.sigs.entries()].filter(([, v]) => v.sig);
        let text, colour, title = '';
        if (![...s.sigs.values()].some(v => v.ready)) { text = 'Waiting'; colour = '#ffc857'; }
        else if (!active.length) { text = 'No signal'; colour = '#9fb7c9'; }
        else { text = `${nameOf(active[0][0])} ${active[0][1].sig.short}` + (active.length > 1 ? ` +${active.length - 1}` : ''); colour = '#00f59b'; title = active.map(([sym, v]) => `${nameOf(sym)}: ${v.sig.detail}`).join('\n'); }
        b.textContent = text + tag; b.style.color = colour; row.title = title;
      });
    });
    refreshUI();
  }

  // ---- hub for other modules (profile.js) -----------------------------------------------------------
  window.StrategyHub = {
    snapshot: () => [...L.DEFS.map(d => ({ id: d.id, label: d.label, group: d.group, running: st[d.id].running, status: cardState(st[d.id])[0], trades: st[d.id].trades, wins: st[d.id].wins, losses: st[d.id].losses, pl: st[d.id].pl })),
      { id: 'smart', label: SMART.label, group: 'Smart', running: smartRunning(), status: smartRunning() ? 'Running (own panel)' : 'Stopped', trades: null, wins: null, losses: null, pl: null }],
    anyRunning, stopAll
  };

  function start() {
    const note = document.querySelector('#monitor2 small');
    if (note) note.textContent = 'Signals are not predictions. Each strategy auto-buys only while you have started it.';
    buildPanel();
    setInterval(paint, 500);
    window.DerivFeed.onTick(onTick);
  }
  (function waitForFeed() {
    if (window.DerivFeed && window.DerivFeed.markets && $('marketRows')) start(); else setTimeout(waitForFeed, 500);
  })();
})();
