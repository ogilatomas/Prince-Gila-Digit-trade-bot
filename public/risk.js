/* risk.js — browser side of the loss-limit protection.
 *
 * The REAL enforcement is in server.js (the server refuses to place a trade
 * that could pass a limit). This file only:
 *   1. sends your Session Loss Limit / Stop Loss / Target Profit boxes to the server
 *   2. shows the real profit/loss in the dashboard cards
 *   3. presses "Stop Smart Strategy" automatically when a limit is reached
 *
 * Add to public/index.html AFTER live-feed.js:
 *   <script src="risk.js"></script>
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const KES = 125;                                  // same display rate as the rest of the page
  const usd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const kes = n => 'KSh ' + Math.round(n * KES).toLocaleString('en-US');
  const colour = n => (n < 0 ? '#ff6b6b' : '#00f59b');

  function setMoney(id, n) {
    const el = $(id);
    if (!el) return;
    el.textContent = usd(n);
    el.style.color = colour(n);
    const next = el.nextElementSibling;
    if (next && next.tagName === 'STRONG') next.textContent = kes(n);
  }

  function render(r) {
    if (!r) return;
    setMoney('sessionpl', r.sessionPL);   // since you last pressed Start
    setMoney('totalpl', r.dailyPL);       // today (UTC) — the server only keeps today
    setMoney('perfpl', r.dailyPL);
    const tc = $('tradeCount');
    if (tc) tc.textContent = String(r.trades);
  }

  function showCurrent(profit) {
    if (typeof profit === 'number') setMoney('currentpl', profit);   // result of the latest trade
  }

  function haltBot(reason) {
    const stop = $('smartStop');
    if (stop && !stop.disabled) stop.click();
    setTimeout(() => {
      const p = $('smartProgress');
      if (p) p.textContent = 'Stopped by risk limit: ' + reason;
      const s = $('smartStatus');
      if (s) s.textContent = '● Stopped (risk limit)';
    }, 80);
    if (typeof window.toast === 'function') window.toast('Risk limit: ' + reason);
  }

  // ---- send the three limit boxes to the server -----------------------------
  async function pushLimits(resetSession) {
    try {
      const res = await fetch('/api/risk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionLossLimit: Number($('lossLimit').value),
          dailyStopLoss: Number($('stopLoss').value),
          dailyTarget: Number($('takeProfit').value),
          resetSession: !!resetSession
        })
      });
      if (res.ok) render(await res.json());
    } catch (_) { /* server unreachable: server-side defaults still apply */ }
  }

  ['lossLimit', 'stopLoss', 'takeProfit'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => pushLimits(false));
  });
  const startBtn = $('smartStart');
  if (startBtn) startBtn.addEventListener('click', () => pushLimits(true));   // new session = P/L back to 0

  // ---- watch trade responses so P/L updates and the bot stops at a limit ----
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/deriv/trade')) {
        response.clone().json().then(d => {
          if (!d) return;
          if (d.risk) render(d.risk);
          showCurrent(d.profit);
          const reason = d.halted ? d.error : (d.risk && d.risk.blockedReason);
          if (reason) haltBot(reason);
        }).catch(() => {});
      }
    } catch (_) { /* never break the page's own request */ }
    return response;
  };

  // ---- show the current numbers on page load (works once you are connected) --
  fetch('/api/risk', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(render)
    .catch(() => {});
})();
