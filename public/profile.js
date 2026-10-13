/* profile.js — the giant "Bot Profile" card for the latest bot build.
 * Read-only: it only displays what the other modules already know.
 * Numbers are for THIS browser session (trades the page has seen settle).
 */
(() => {
  'use strict';
  const C = window.BotCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BUILD = { version: '2.0', name: 'Prince Gila 👑 DigitTrade Bot', date: '13 Oct 2026' };
  const loadedAt = Date.now();
  const usd = n => (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2);
  const col = n => (n < 0 ? '#ff6b6b' : n > 0 ? '#00f59b' : '#d3e6f4');
  const fmtUp = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + 'h ' : '') + m + 'm ' + (s % 60) + 's'; };

  function build() {
    if ($('botProfile')) return;
    const anchor = document.querySelector('.hero');
    if (!anchor) return;
    anchor.insertAdjacentHTML('afterend', `
<section class="panel profile-giant" id="botProfile">
  <div class="pg-head">
    <div class="pg-avatar">🤖<span>👑</span></div>
    <div class="pg-title">
      <h2>${esc(BUILD.name)}</h2>
      <p>Latest build · <b>v${BUILD.version}</b> · ${BUILD.date} — independent strategies, auto-buy, instant stop, Over/Under → Differs switch</p>
      <div class="pg-pills">
        <span class="pill" id="pgRun">● Idle</span><span class="pill" id="pgMode">Demo</span>
        <span class="pill" id="pgApi">API: …</span><span class="pill" id="pgFeed">Feed: …</span><span class="pill" id="pgRule">Switch rule: ON</span>
      </div>
    </div>
    <div class="pg-balance"><small>Account Balance</small><b id="pgBal">—</b><small id="pgUp">Session 0m 0s</small></div>
  </div>

  <div class="pg-kpis">
    <div><small>Session P/L</small><b id="pgPl">$0.00</b></div>
    <div><small>Trades</small><b id="pgTrades">0</b></div>
    <div><small>Win rate</small><b id="pgWr">—</b></div>
    <div><small>Wins / Losses</small><b id="pgWl">0 / 0</b></div>
    <div><small>Best trade</small><b id="pgBest">—</b></div>
    <div><small>Worst trade</small><b id="pgWorst">—</b></div>
    <div><small>Streak</small><b id="pgStreak">—</b></div>
    <div><small>Strategies running</small><b id="pgActive">0 / 10</b></div>
  </div>

  <div class="pg-body">
    <div class="pg-col"><h3>Strategies</h3><div class="pg-strats" id="pgStrats"></div></div>
    <div class="pg-col"><h3>Latest trades</h3><div class="pg-recent" id="pgRecent"><span class="muted">No trades yet this session.</span></div></div>
    <div class="pg-col"><h3>How this bot works</h3>
      <ul class="pg-rules">
        <li>Each strategy is independent: own signals, own cooldown, own tally.</li>
        <li>Start turns auto-buy on; Stop ends new entries immediately.</li>
        <li>After an Over/Under win, the next trade is Differs, then back.</li>
        <li>Default market: Volatility Markets, 1 tick per trade.</li>
        <li>Server enforces stake and loss/profit limits.</li>
      </ul>
    </div>
  </div>
</section>`);
  }

  function paint() {
    const hub = window.StrategyHub, st = C.getStats();
    if (!hub) return;
    const snap = hub.snapshot(), running = snap.filter(s => s.running);
    const set = (id, t, c) => { const e = $(id); if (!e) return; e.textContent = t; if (c) e.style.color = c; };

    set('pgRun', running.length ? `● Running · ${running.length} strateg${running.length > 1 ? 'ies' : 'y'}` : '● Idle', running.length ? '#00f59b' : '#ffc857');
    const mode = ($('mode') || {}).value || 'Demo';
    set('pgMode', mode + ' account', mode === 'Real' ? '#ff9f6b' : '#6bd6ff');
    set('pgApi', 'API: ' + (($('apiState') || {}).textContent || '—'));
    const feed = window.DerivFeed;
    const live = feed && feed.markets.size ? [...feed.markets.values()].filter(m => m.digits.length).length : 0;
    set('pgFeed', live ? `Feed: ${live} Volatility markets live` : 'Feed: connecting…', live ? '#00f59b' : '#ffc857');
    set('pgRule', 'Switch rule: ' + (C.isSwitchEnabled() ? 'ON (Over/Under win → Differs)' : 'OFF'), C.isSwitchEnabled() ? '#00f59b' : '#9fb7c9');
    set('pgBal', ($('balance') || {}).textContent || '—');
    set('pgUp', 'Session ' + fmtUp(Date.now() - loadedAt));

    set('pgPl', st.trades ? usd(st.pl) : '$0.00', col(st.pl));
    set('pgTrades', String(st.trades));
    set('pgWr', st.winRate === null ? '—' : st.winRate.toFixed(0) + '%');
    set('pgWl', `${st.wins} / ${st.losses}`);
    set('pgBest', st.trades ? usd(st.best) : '—', col(st.best));
    set('pgWorst', st.trades ? usd(st.worst) : '—', col(st.worst));
    set('pgStreak', st.streak === 0 ? '—' : (st.streak > 0 ? st.streak + ' wins' : -st.streak + ' losses'), st.streak > 0 ? '#00f59b' : st.streak < 0 ? '#ff6b6b' : null);
    set('pgActive', `${running.length} / ${snap.length}`);

    $('pgStrats').innerHTML = snap.map(s => {
      const tally = s.trades === null ? 'own panel' : `${s.wins}W/${s.losses}L ${usd(s.pl)}`;
      return `<div class="pg-s ${s.running ? 'on' : ''}"><i></i><span>${esc(s.label)}</span><em>${esc(tally)}</em></div>`;
    }).join('');

    const rec = C.state.trades.slice(0, 6);
    $('pgRecent').innerHTML = rec.length ? rec.map(t => {
      const b = t.barrier === undefined ? '' : ' ' + t.barrier;
      return `<div class="pg-t"><span>${new Date(t.time).toLocaleTimeString()}</span><b>${esc(t.strategy)}${b}</b><em style="color:${col(t.profit)}">${t.win ? 'WIN' : 'LOSS'} ${usd(t.profit)}</em></div>`;
    }).join('') : '<span class="muted">No trades yet this session.</span>';
  }

  (function wait() {
    if ($('marketRows') && window.StrategyHub) { build(); setInterval(paint, 1000); paint(); }
    else setTimeout(wait, 500);
  })();
})();
