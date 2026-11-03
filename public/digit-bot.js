/* digit-bot.js — Over/Under & Even/Odd auto-bot, placed under the Last-digit-prediction panel on the Manual Trading page.
 * Watches the last digit of every tick on the chosen market. When the chosen entry digits appear
 * Once / Twice / Thrice in a row, it places the trade immediately. One trade at a time; Stop works at once. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = window.BotLogic, Hub = window.TickHub, TC = window.TradeClient;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2);
  const KEY = 'digitBot.cfg';

  const cfg = { type: 'DIGITOVER', barrier: 3, need: 'once', symbol: '', ticks: 1, stake: 1, entryText: '', continuous: false, times: 1 };
  const st = { queue: B.makeQueue(), running: false, busy: false, streak: null, real: false, errors: 0, trades: 0, wins: 0, losses: 0, pl: 0, log: [] };

  function load() { try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (_) {} cfg.ticks = cfg.ticks || 1; cfg.times = Math.min(10, Math.max(1, Number(cfg.times) || 1)); cfg.continuous = cfg.continuous === true; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} }
  function toast(msg) { if (window.toast) return window.toast(msg); const t = $('toast'); if (!t) return; t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 4500); }

  function build() {
    const host = document.querySelector('.left'); if (!host || $('digitBot')) return !!$('digitBot');
    const p = document.createElement('div'); p.className = 'panel dbot'; p.id = 'digitBot';
    p.innerHTML = `
<div class="dbot-head"><h2>🤖 Over/Under &amp; Even/Odd Bot <small>(auto-trades when your entry digits appear)</small></h2><span class="dbot-pill" id="dbPill">STOPPED</span></div>
<div class="dbot-grid">
  <label>Market<select id="dbMarket"><option>Loading…</option></select></label>
  <label>Ticks<input id="dbTicks" type="number" min="1" max="10" step="1"></label>
  <label>Stake<input id="dbStake" type="number" min="0.35" step="0.01"></label>
</div>
<p class="lbl">Trade with</p>
<div class="dbot-seg" id="dbType">${Object.keys(B.TYPES).map(k => `<button type="button" data-t="${k}">${B.TYPES[k].label}</button>`).join('')}</div>
<div id="dbBarrierBox"><p class="lbl">Digit barrier</p><div class="digits" id="dbDigits"></div></div>
<div class="dbot-cont">
  <button type="button" id="dbCont" class="dbot-toggle">Continuous: OFF</button>
  <label>Trades each time<select id="dbTimes">${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
</div>
<p class="fine" id="dbContNote"></p>
<div id="dbEntryBox">
<label class="dbot-entry">Entry digits <small>(the bot watches for these)</small><input id="dbEntry" type="text" inputmode="numeric" autocomplete="off"></label>
<p class="lbl">Trade entry <small>(how many in a row before it trades)</small></p>
<div class="dbot-seg" id="dbNeed"><button type="button" data-n="once">Once</button><button type="button" data-n="twice">Twice</button><button type="button" data-n="thrice">Thrice</button></div>
</div>
<div class="dbot-live"><div id="dbWatch" class="dbot-watch"></div><div id="dbStrip" class="dbot-strip"></div></div>
<button type="button" class="dbot-go" id="dbGo">▶ START BOT</button>
<div class="dbot-stats" id="dbStats"></div>
<ul class="dbot-log" id="dbLog"></ul>
<p class="fine">One trade at a time. Your session loss limit, daily stop and stake ceiling on the server still apply. Wins and losses are not predictable; only trade what you can afford to lose.</p>`;
    host.appendChild(p);
    $('dbType').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; cfg.type = b.dataset.t; fixBarrier(); changed(); };
    $('dbNeed').onclick = e => { const b = e.target.closest('[data-n]'); if (!b) return; cfg.need = b.dataset.n; changed(); };
    $('dbCont').onclick = () => { cfg.continuous = !cfg.continuous; changed(); };
    $('dbTimes').onchange = () => { cfg.times = Number($('dbTimes').value); changed(true); };
    $('dbDigits').onclick = e => { const b = e.target.closest('[data-b]'); if (!b || b.disabled) return; cfg.barrier = Number(b.dataset.b); changed(); };
    $('dbMarket').onchange = () => { cfg.symbol = $('dbMarket').value; changed(); };
    ['dbTicks', 'dbStake', 'dbEntry'].forEach(id => $(id).addEventListener('input', () => { cfg.ticks = $('dbTicks').value; cfg.stake = $('dbStake').value; cfg.entryText = $('dbEntry').value; changed(true); }));
    $('dbGo').onclick = () => (st.running ? stop('Stopped.') : start());
    $('dbTimes').value = cfg.times; $('dbTicks').value = cfg.ticks; $('dbStake').value = cfg.stake; $('dbEntry').value = cfg.entryText;
    return true;
  }

  function fixBarrier() {                        // keep the barrier inside the allowed range for Over (0-8) / Under (1-9)
    const t = B.TYPES[cfg.type]; if (!t.barrier) return;
    cfg.barrier = Math.min(t.max, Math.max(t.min, Number(cfg.barrier)));
  }
  function changed(typing) {
    save(); if (st.streak) rebuildStreak();
    render(typing);
  }
  function rebuildStreak() { st.streak = B.makeStreak(B.effectiveEntry(cfg), B.NEEDS[cfg.need]); }

  function render(typing) {
    const t = B.TYPES[cfg.type], watch = B.effectiveEntry(cfg), need = B.NEEDS[cfg.need];
    document.querySelectorAll('#dbType [data-t]').forEach(b => b.classList.toggle('active', b.dataset.t === cfg.type));
    document.querySelectorAll('#dbNeed [data-n]').forEach(b => b.classList.toggle('active', b.dataset.n === cfg.need));
    $('dbBarrierBox').style.display = t.barrier ? '' : 'none';
    if (!typing) {
      $('dbDigits').innerHTML = Array.from({ length: 10 }, (_, d) => `<button type="button" data-b="${d}" class="${t.barrier && d === Number(cfg.barrier) ? 'active' : ''}"${t.barrier && (d < t.min || d > t.max) ? ' disabled' : ''}>${d}</button>`).join('');
      $('dbEntry').placeholder = 'auto: ' + (B.defaultEntry(cfg.type, cfg.barrier).join(',') || 'type digits');
    }
    const typed = B.parseDigits(cfg.entryText).length > 0;
    const run = st.streak ? st.streak.count : 0;
    const times = Number(cfg.times) || 1;
    const dc = $('dbCont'); dc.textContent = 'Continuous: ' + (cfg.continuous ? 'ON' : 'OFF'); dc.classList.toggle('active', !!cfg.continuous);
    $('dbEntryBox').style.opacity = cfg.continuous ? '.35' : '';
    $('dbContNote').textContent = cfg.continuous
      ? `Continuous ON: places ${times} trade${times > 1 ? 's' : ''} after every tick, as soon as the previous trade has settled. Entry digits are ignored.`
      : `Continuous OFF: places ${times} trade${times > 1 ? 's' : ''} each time your entry digits appear. An entry seen while a trade is open is queued and placed right after, never skipped.`;
    if (cfg.continuous) $('dbWatch').innerHTML = `Continuous · <b>${times}</b> trade${times > 1 ? 's' : ''} per cycle · queued <b>${st.queue.pending}</b>`;
    else $('dbWatch').innerHTML = `Watching <b>${watch.length ? watch.map(d => `<i>${d}</i>`).join('') : '—'}</b> ${typed ? '' : '<em>(auto)</em>'} · need <b>${need}</b> in a row · run <b>${run}/${need}</b> · queued <b>${st.queue.pending}</b>`;
    const mk = Hub.markets.get(cfg.symbol), ws = new Set(watch);
    $('dbStrip').innerHTML = mk ? mk.digits.slice(-14).map(d => `<span class="${ws.has(d) ? 'hit' : ''}">${d}</span>`).join('') : '';
    const pill = $('dbPill'); pill.textContent = st.busy ? 'TRADING…' : st.running ? 'RUNNING' : 'STOPPED'; pill.className = 'dbot-pill' + (st.busy ? ' busy' : st.running ? ' on' : '');
    const go = $('dbGo'); go.textContent = st.running ? '■ STOP BOT' : '▶ START BOT'; go.classList.toggle('stop', st.running);
    $('dbStats').innerHTML = `<div><small>Trades</small><b>${st.trades}</b></div><div><small>Wins</small><b class="g">${st.wins}</b></div><div><small>Losses</small><b class="r">${st.losses}</b></div><div><small>Bot P/L</small><b class="${st.pl >= 0 ? 'g' : 'r'}">${money(st.pl)}</b></div>`;
    $('dbLog').innerHTML = st.log.map(l => `<li class="${l.cls || ''}"><span>${esc(l.t)}</span><b>${esc(l.m)}</b></li>`).join('') || '<li class="muted">No bot trades yet.</li>';
  }
  const note = (m, cls) => { st.log.unshift({ t: new Date().toLocaleTimeString(), m, cls }); st.log = st.log.slice(0, 8); };

  async function start() {
    const err = B.validate(cfg);
    if (err) return toast(err);
    if (!Hub.ready || !Hub.markets.get(cfg.symbol)) return toast('Still loading market data. Try again in a moment.');
    const acc = await TC.account(true);
    if (!acc.connected) return toast('Connect your Deriv account first (button at the top of this page).');
    st.real = !acc.active.isVirtual;
    if (st.real && !window.confirm(`REAL MONEY AUTO-TRADING\n\nAccount: ${acc.active.loginid}\n${B.TYPES[cfg.type].label}${B.TYPES[cfg.type].barrier ? ' ' + cfg.barrier : ''} on ${cfg.symbol}, stake ${cfg.stake}, ${cfg.ticks} tick(s), entry: ${cfg.continuous ? 'continuous' : cfg.need}, ${cfg.times} trade(s) each time\n\nThe bot will place trades by itself until you press Stop. You can lose your stakes. Start?`)) return;
    rebuildStreak(); st.queue.clear(); st.running = true; st.busy = false; st.errors = 0;
    note(`Started · ${B.TYPES[cfg.type].label}${B.TYPES[cfg.type].barrier ? ' ' + cfg.barrier : ''} · ${cfg.symbol} · ${cfg.continuous ? 'continuous' : cfg.need} · ${cfg.times} per time`);
    TC.warm(); render();
  }
  function stop(msg) { st.running = false; st.queue.clear(); if (msg) note(msg); if (st.streak) st.streak.reset(); render(); }

  function onTick(t) {
    if (t.symbol !== cfg.symbol) return;
    if (st.running) {
      // Every tick is counted, even while a trade is open, so no entry chance is ever skipped.
      const hit = !cfg.continuous && st.streak.push(t.digit);
      const add = B.tradesToQueue(cfg, { hit, busy: st.busy, pending: st.queue.pending });
      if (add && st.queue.add(add) < add) note(`Queue is full (${B.MAX_QUEUE}); an entry was not queued.`, 'e');
      pump();                                        // places at once when idle
    }
    render(true);                                    // keep the digit strip / run counter live
  }

  // Starts the next queued trade if nothing is open. Called on every tick and right after each trade settles.
  function pump() {
    if (!st.running || st.busy) return;
    if (st.queue.take()) place();
  }

  async function place() {
    st.busy = true; render(true);
    const body = B.buildBody(cfg, { confirmReal: st.real });
    const r = TC.classify(await TC.place(body));
    st.busy = false;
    if (r.kind === 'win' || r.kind === 'loss') {
      st.errors = 0; st.trades++; st.pl += r.profit; r.kind === 'win' ? st.wins++ : st.losses++;
      note(`${r.kind === 'win' ? 'WIN' : 'LOSS'} ${money(r.profit)} · #${r.id}`, r.kind === 'win' ? 'w' : 'l');
    } else if (r.kind === 'stop') { note('Stopped: ' + r.msg, 'e'); toast(r.msg); st.running = false; st.queue.clear(); }
    else { st.errors++; note('Not placed: ' + r.msg, 'e'); if (st.errors >= 3) { st.running = false; st.queue.clear(); note('Stopped after 3 failed attempts.', 'e'); toast('Bot stopped after 3 failed attempts: ' + r.msg); } }
    render();
    pump();                                      // a queued entry goes out the moment this trade has settled
  }

  function fillMarkets() {
    const sel = $('dbMarket'); if (!sel || !Hub.markets.size) return;
    if (sel.options.length === Hub.markets.size && sel.dataset.filled) return;
    const byGroup = new Map();
    Hub.markets.forEach(m => { const g = m.group || 'Markets'; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(m); });
    sel.innerHTML = [...byGroup].map(([g, ms]) => `<optgroup label="${esc(g)}">${ms.map(m => `<option value="${esc(m.symbol)}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
    sel.dataset.filled = '1';
    const manual = $('market');
    if (!cfg.symbol || !Hub.markets.has(cfg.symbol)) cfg.symbol = (manual && Hub.markets.has(manual.value) ? manual.value : (Hub.markets.has('R_100') ? 'R_100' : [...Hub.markets.keys()][0]));
    sel.value = cfg.symbol; render();
  }

  window.DigitBotCfg = () => Object.assign({}, cfg);      // lets the Analysis Lab replay these exact settings

  load();
  (function wait() {
    if (!$('freq') || !B || !Hub || !TC) return setTimeout(wait, 300);
    build(); fixBarrier(); render();
    Hub.on('status', fillMarkets); Hub.on('ready', fillMarkets); Hub.on('tick', onTick);
    Hub.start(); fillMarkets();
  })();
})();
