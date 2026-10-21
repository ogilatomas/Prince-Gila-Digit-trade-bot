/* analysis-lab.js — "Analysis Lab" panel (Manual Trading page, under the Over/Under bot).
 *  1) Randomness check: are the last digits of each market consistent with pure chance?
 *  2) Backtest: replays your Over/Under & Even/Odd bot settings over the recorded ticks, using estimated payouts. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = window.BotLogic, A = window.AnalysisLogic, Hub = window.TickHub;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2);
  const pct = x => (x * 100).toFixed(1) + '%';
  const pv = p => p === null ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3);
  const short = n => n.replace(/^Volatility\s*/i, 'Vol ').replace(/\s*Index$/i, '');

  function build() {
    const anchor = $('digitBot'); if (!anchor || $('analysisLab')) return !!$('analysisLab');
    const p = document.createElement('div'); p.className = 'panel dbot lab'; p.id = 'analysisLab';
    p.innerHTML = `
<div class="dbot-head"><h2>🔬 Analysis Lab <small>(check before you trust any pattern)</small></h2></div>
<p class="fine" style="margin-top:0">Uses the last ticks the page has recorded for each market (up to 1,000). Statistics on this little data can show patterns that are only luck, so treat every result as a question, not an answer.</p>
<div class="lab-actions"><button type="button" class="lab-btn" id="labRand">Run randomness check</button><button type="button" class="lab-btn alt" id="labBack">Backtest my bot settings</button></div>
<div id="labRandOut"></div>
<label class="lab-margin">Estimated Deriv margin in payouts (%)<input id="labMargin" type="number" min="0" max="20" step="0.5" value="4"></label>
<div id="labBackOut"></div>`;
    anchor.insertAdjacentElement('afterend', p);
    $('labRand').onclick = randomness; $('labBack').onclick = backtest;
    return true;
  }

  function randomness() {
    const rows = [...Hub.markets.values()].filter(m => m.digits.length);
    if (!rows.length) { $('labRandOut').innerHTML = '<p class="fine">Market data is still loading.</p>'; return; }
    let flagged = 0, tests = 0;
    const body = rows.map(m => {
      const u = A.uniformity(m.digits), d = A.dependence(m.digits);
      const bad = (u.p !== null && u.p < 0.01) || (d.p !== null && d.p < 0.01);
      [u.p, d.p].forEach(x => { if (x !== null) tests++; });
      if (bad) flagged++;
      return `<tr class="${bad ? 'flag' : ''}"><td>${esc(short(m.name))}</td><td>${m.digits.length}</td><td>${pv(u.p)}</td><td>${pv(d.p)}</td><td>${bad ? 'Unusual' : 'Looks random'}</td></tr>`;
    }).join('');
    const expect = (tests * 0.01).toFixed(2);
    $('labRandOut').innerHTML = `<table class="lab-table"><thead><tr><th>Market</th><th>Ticks</th><th>Digit spread p</th><th>Next-digit p</th><th>Result</th></tr></thead><tbody>${body}</tbody></table>
<p class="lab-sum"><b>${flagged}</b> of ${rows.length} markets flagged. With ${tests} tests at the 1% level, about <b>${expect}</b> would be flagged by pure chance. A p-value below 0.01 only means "unlikely under chance", not "tradable". Re-run later: a real pattern would persist on new ticks, luck will not.</p>`;
  }

  function backtest() {
    const cfg = window.DigitBotCfg ? window.DigitBotCfg() : null;
    if (!cfg) { $('labBackOut').innerHTML = '<p class="fine">The Over/Under bot panel has not loaded yet.</p>'; return; }
    const err = B.validate(cfg);
    if (err) { $('labBackOut').innerHTML = `<p class="fine">Fix the bot settings first: ${esc(err)}</p>`; return; }
    const margin = Number($('labMargin').value) || 0, mk = Hub.markets.get(cfg.symbol);
    const one = mk ? A.backtest(mk.digits, cfg, margin) : null;
    let all = { trades: 0, wins: 0, pl: 0 };
    Hub.markets.forEach(m => { const r = A.backtest(m.digits, cfg, margin); all.trades += r.trades; all.wins += r.wins; all.pl += r.pl; });
    const allRate = all.trades ? all.wins / all.trades : 0, ci = A.wilson(all.wins, all.trades);
    const t = B.TYPES[cfg.type], name = `${t.label}${t.barrier ? ' ' + cfg.barrier : ''}, ${cfg.need}, ${cfg.ticks} tick(s)`;
    const card = (title, r, extra) => !r ? '' : `<div class="lab-card"><h4>${esc(title)}</h4>
<div class="lab-grid"><div><small>Trades</small><b>${r.trades}</b></div><div><small>Win rate</small><b>${r.trades ? pct(r.rate) : '—'}</b></div><div><small>Chance alone</small><b>${pct(r.expected)}</b></div><div><small>Break-even</small><b>${pct(r.breakEven)}</b></div>
<div><small>95% range</small><b>${r.trades ? pct(r.ci[0]) + '–' + pct(r.ci[1]) : '—'}</b></div><div><small>P/L at stake ${esc(cfg.stake)}</small><b class="${r.pl >= 0 ? 'g' : 'r'}">${money(r.pl)}</b></div>${extra || ''}</div>
<p class="lab-verdict">${esc(r.verdict)}</p></div>`;
    const allR = { trades: all.trades, rate: allRate, expected: one ? one.expected : A.chanceOf(cfg.type, cfg.barrier), breakEven: one ? one.breakEven : 0, ci, pl: all.pl * 1, verdict: !all.trades ? 'No trades triggered.' : ci[1] < (one ? one.breakEven : 1) ? 'Loses money in this sample.' : ci[0] > (one ? one.breakEven : 0) ? 'Profitable in this sample. Confirm on fresh ticks before trusting it.' : "Can't tell. The result is within what chance alone produces." };
    $('labBackOut').innerHTML = `<p class="lab-sum">Replaying <b>${esc(name)}</b> with entry digits <b>${B.effectiveEntry(cfg).join(',')}</b>. Payouts are estimated from a ${margin}% margin; Deriv's real quotes differ.</p>
${card('Selected market: ' + (mk ? short(mk.name) : cfg.symbol), one, `<div><small>Max drawdown</small><b class="r">-${one ? one.maxDD.toFixed(2) : '0.00'}</b></div>`)}
${card('All markets combined', allR)}
<p class="lab-sum">Break-even is the win rate you need just to cover the platform's margin. On random digits the win rate settles at "chance alone", which sits below break-even, so a bot that looks profitable on a short sample is usually just a lucky streak.</p>`;
  }

  (function wait() {
    if (!B || !A || !Hub || !$('digitBot')) return setTimeout(wait, 400);
    build();
  })();
})();
