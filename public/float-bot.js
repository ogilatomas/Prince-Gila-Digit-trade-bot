/* float-bot.js — golden floating scanner bot. Drag it anywhere; it stays on top of the page.
 * Tick the trade types you want (Differs / Over 0 / Under 9; at least one) before pressing START.
 * It scans every Volatility and Volatility (1s) market (last 1,000 ticks) and trades the selected set, 1 tick by default:
 *   1) Differs  — barrier = the market's most frequent digit            ×2 trades
 *   2) Over 0   — only on a market where digit 0 is the least frequent  ×2 trades
 *   3) Under 9  — only on a market where digit 9 is the least frequent  ×2 trades
 * = six trades in one set. A step with no qualifying market is skipped. */
(() => {
  'use strict';
  const B = window.BotLogic, Hub = window.TickHub, TC = window.TradeClient;
  if (!B || !Hub || !TC) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const KEY = 'goldBot.v1';
  const PER_STAGE = 2;

  const cfg = { stake: 1, ticks: 1, windowN: 1000, repeat: false, min: false, x: null, y: null, on: { diff: true, over0: true, under9: true } };
  const st = { running: false, stage: -1, done: [0, 0, 0], skipped: [false, false, false], pick: null, msg: 'Ready. Press START.', trades: 0, wins: 0, losses: 0, pl: 0, sets: 0, real: false, errors: 0 };
  let el = null, runId = 0;

  const load = () => { try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (_) {} cfg.on = Object.assign({ diff: true, over0: true, under9: true }, cfg.on || {}); };
  const chosen = () => B.STAGES.filter(s => cfg.on[s.id]);
  const setSize = () => chosen().length * PER_STAGE;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} };
  const toast = m => { if (typeof window.toast === 'function') return window.toast(m); const t = $('toast'); if (t) { t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 4500); } };

  function build() {
    el = document.createElement('aside'); el.className = 'gbot'; el.id = 'goldBot';
    el.innerHTML = `
<header id="gbHead"><span class="gb-title">🤖 GOLD SCANNER</span><span class="gb-pill" id="gbPill">IDLE</span><button type="button" id="gbMin" aria-label="Minimise">−</button></header>
<div class="gb-body" id="gbBody">
  <div class="gb-row">
    <label>Stake<input id="gbStake" type="number" min="0.35" step="0.01"></label>
    <label>Ticks<input id="gbTicks" type="number" min="1" max="10" step="1"></label>
    <label>Scan<select id="gbWin"><option value="100">100</option><option value="500">500</option><option value="1000">1000</option></select></label>
  </div>
  <label class="gb-check"><input type="checkbox" id="gbRepeat"> Keep repeating the <span id="gbSetN">6</span>-trade set</label>
  <button type="button" class="gb-go" id="gbGo">▶ START</button>
  <div class="gb-stages" id="gbStages"></div>
  <p class="gb-msg" id="gbMsg"></p>
  <div class="gb-scanwrap"><table class="gb-scan"><thead><tr><th>Market</th><th>Top</th><th>0%</th><th>9%</th></tr></thead><tbody id="gbScan"></tbody></table></div>
  <div class="gb-stats" id="gbStats"></div>
</div>`;
    document.body.appendChild(el);
    $('gbStake').value = cfg.stake; $('gbTicks').value = cfg.ticks; $('gbWin').value = String(cfg.windowN); $('gbRepeat').checked = cfg.repeat;
    ['gbStake', 'gbTicks'].forEach(id => $(id).addEventListener('input', () => { cfg.stake = $('gbStake').value; cfg.ticks = $('gbTicks').value; save(); }));
    $('gbWin').onchange = () => { cfg.windowN = Number($('gbWin').value); save(); renderScan(); };
    $('gbRepeat').onchange = () => { cfg.repeat = $('gbRepeat').checked; save(); };
    $('gbStages').addEventListener('change', e => {
      const box = e.target.closest('input[data-stage]'); if (!box) return;
      if (st.running) { box.checked = !!cfg.on[box.dataset.stage]; return; }
      cfg.on[box.dataset.stage] = box.checked;
      if (!chosen().length) { cfg.on[box.dataset.stage] = true; box.checked = true; toast('Keep at least one trade type selected.'); }
      save(); render();
    });
    $('gbGo').onclick = () => (st.running ? stop('Stopped.') : start());
    $('gbMin').onclick = () => { cfg.min = !cfg.min; save(); applyMin(); };
    drag($('gbHead'));
    place(); applyMin(); render(); renderScan();
    window.addEventListener('resize', place);
  }

  // ---- drag anywhere (mouse / touch / pen), remembered between visits ----
  function place() {
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let x = cfg.x, y = cfg.y;
    if (x == null) { x = vw - w - 16; y = vh - h - 16; }
    x = Math.max(0, Math.min(vw - w, x)); y = Math.max(0, Math.min(vh - Math.min(h, vh), y));
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  function drag(handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId); el.classList.add('drag');
      const move = ev => { cfg.x = ev.clientX - dx; cfg.y = ev.clientY - dy; place(); };
      const up = () => { handle.removeEventListener('pointermove', move); el.classList.remove('drag'); save(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up, { once: true }); handle.addEventListener('pointercancel', up, { once: true });
    });
  }
  function applyMin() { el.classList.toggle('min', !!cfg.min); $('gbMin').textContent = cfg.min ? '+' : '−'; place(); }

  // ---- rendering ----
  function render() {
    const pill = $('gbPill'); pill.textContent = st.running ? 'SCANNING' : 'IDLE'; pill.className = 'gb-pill' + (st.running ? ' on' : '');
    const go = $('gbGo'); go.textContent = st.running ? '■ STOP' : '▶ START'; go.classList.toggle('stop', st.running);
    $('gbStages').innerHTML = B.STAGES.map((s, i) => {
      const on = !!cfg.on[s.id];
      const cls = (on && st.running && st.stage === i ? ' now' : '') + (!on ? ' off' : '') + (on && st.skipped[i] ? ' skip' : '') + (on && st.done[i] >= PER_STAGE ? ' done' : '');
      const sub = !on ? 'off' : st.skipped[i] ? 'skipped' : st.done[i] + '/' + PER_STAGE;
      return `<label class="gb-stage${cls}"><input type="checkbox" data-stage="${s.id}"${on ? ' checked' : ''}${st.running ? ' disabled' : ''}><b>${s.label}</b><span>${sub}</span></label>`;
    }).join('');
    $('gbSetN').textContent = setSize();
    $('gbMsg').textContent = st.msg;
    $('gbStats').innerHTML = `<div><small>Trades</small><b>${st.trades}</b></div><div><small>Wins</small><b>${st.wins}</b></div><div><small>Losses</small><b class="gb-loss">${st.losses}</b></div><div><small>P/L</small><b class="${st.pl < 0 ? 'gb-loss' : ''}">${money(st.pl)}</b></div><div><small>Sets</small><b>${st.sets}</b></div>`;
  }
  let scanDirty = true;
  function renderScan() {
    const rows = [...Hub.markets.values()].filter(m => m.vol);   // Volatility + Volatility (1s) only
    if (!rows.length) { $('gbScan').innerHTML = `<tr><td colspan="4">${esc(Hub.status.text)}</td></tr>`; return; }
    $('gbScan').innerHTML = rows.map(mk => {
      const n = Math.min(cfg.windowN, mk.digits.length), c = B.countsOf(mk.digits, n), pct = d => (n ? c[d] / n * 100 : 0);
      const mx = Math.max(...c), top = c.indexOf(mx), uniqTop = c.filter(x => x === mx).length === 1;
      const o = B.stageCheck('over0', c), u = B.stageCheck('under9', c);
      const short = mk.name.replace(/^Volatility\s*/i, 'Vol ').replace(/\s*Index$/i, '');
      const sel = st.pick && st.pick.symbol === mk.symbol ? ' sel' : '';
      return `<tr class="${sel}"><td>${esc(short)}</td><td class="${uniqTop ? 'q' : ''}">${uniqTop ? top + ' · ' + pct(top).toFixed(1) + '%' : '—'}</td><td class="${o ? 'q' : ''}">${pct(0).toFixed(1)}</td><td class="${u ? 'q' : ''}">${pct(9).toFixed(1)}</td></tr>`;
    }).join('');
  }
  setInterval(() => { if (el && !cfg.min) renderScan(); }, 1000);

  // ---- the bot ----
  async function start() {
    if (!Hub.ready) { st.msg = 'Still loading market data…'; render(); return toast('Still loading market data. Try again in a moment.'); }
    const stake = Number(cfg.stake), ticks = Number(cfg.ticks);
    if (!chosen().length) return toast('Select at least one trade type.');
    if (!Number.isFinite(stake) || stake <= 0) return toast('Enter a stake above 0.');
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10) return toast('Ticks must be a whole number from 1 to 10.');
    const acc = await TC.account(true);
    if (!acc.connected) { st.msg = 'Connect your Deriv account first.'; render(); return toast('Connect your Deriv account first.'); }
    st.real = !acc.active.isVirtual;
    if (st.real && !window.confirm(`REAL MONEY AUTO-TRADING\n\nAccount: ${acc.active.loginid}\nThe gold bot will place up to ${setSize()} trades per set (${chosen().map(s => s.label + ' ×' + PER_STAGE).join(', ')}), stake ${stake}, ${ticks} tick(s) each${cfg.repeat ? ', and keep repeating' : ''}.\n\nYou can lose your stakes. Start?`)) return;
    st.running = true; st.errors = 0; st.trades = st.wins = st.losses = st.pl = st.sets = 0;
    const my = ++runId; TC.warm(); render();
    loop(my, stake, ticks);
  }
  function stop(msg) { runId++; st.running = false; st.stage = -1; st.pick = null; st.msg = msg || 'Stopped.'; render(); }

  async function loop(my, stake, ticks) {
    const alive = () => st.running && my === runId;
    while (alive()) {
      st.done = [0, 0, 0]; st.skipped = [false, false, false]; let placed = 0;
      for (let i = 0; i < B.STAGES.length && alive(); i++) {
        const stage = B.STAGES[i]; st.stage = i; st.pick = null;
        if (!cfg.on[stage.id]) continue;   // not selected
        st.msg = `Scanning markets for ${stage.label}…`; render(); renderScan();
        const pick = B.pickMarket(stage.id, [...Hub.markets.values()].filter(m => m.vol), cfg.windowN, 100);
        if (!pick) { st.skipped[i] = true; st.msg = `No market qualifies for ${stage.label}: skipped.`; render(); await sleep(400); continue; }
        st.pick = pick; renderScan();
        for (let k = 0; k < PER_STAGE && alive(); k++) {
          st.msg = `${pick.label} on ${pick.name} (${k + 1}/${PER_STAGE})…`; render();
          const r = await tradeOnce(pick, stake, ticks);
          if (!alive()) return;
          if (r === 'stop') { stop(st.msg); return; }
          if (r === 'ok') { st.done[i]++; placed++; }
          render();
        }
      }
      if (!alive()) return;
      if (placed > 0) st.sets++;
      if (!cfg.repeat) { st.running = false; st.stage = -1; st.pick = null; st.msg = placed ? `Set finished: ${placed} trade${placed > 1 ? 's' : ''} placed. Press START for another.` : 'No market qualified right now. Press START to scan again.'; render(); return; }
      if (!placed) { st.msg = 'Nothing qualified this pass. Scanning again…'; render(); await sleep(3000); }
    }
  }

  async function tradeOnce(pick, stake, ticks) {
    const body = { symbol: pick.symbol, direction: pick.direction, barrier: pick.barrier, duration: ticks, stake: Math.round(stake * 100) / 100, strategy: `GoldBot · ${pick.label}`, sid: 'bot', source: 'bot', confirmReal: st.real };
    const r = TC.classify(await TC.place(body));
    if (r.kind === 'win' || r.kind === 'loss') {
      st.errors = 0; st.trades++; st.pl += r.profit; r.kind === 'win' ? st.wins++ : st.losses++;
      st.msg = `${r.kind === 'win' ? 'WIN' : 'LOSS'} ${money(r.profit)} · ${pick.label}`;
      return 'ok';
    }
    if (r.kind === 'stop') { st.msg = 'Stopped: ' + r.msg; toast(r.msg); return 'stop'; }
    st.errors++; st.msg = 'Not placed: ' + r.msg;
    if (st.errors >= 3) { st.msg = 'Stopped after 3 failed attempts: ' + r.msg; toast(st.msg); return 'stop'; }
    return 'err';
  }

  load();
  (function wait() { if (!document.body) return setTimeout(wait, 100); build(); Hub.start(); Hub.on('status', () => { renderScan(); }); })();
})();
