/* manual.js — Manual Trading page, connected to your server and Deriv.
 *
 * - Live ticks:  Deriv's public WebSocket (same address the dashboard uses). No fake data.
 * - Account:     /api/deriv/accounts, /api/deriv/select, /api/deriv/balance
 * - Trades:      POST /api/deriv/trade  (the server enforces stake + loss limits)
 * - Limits:      /api/risk
 */
(() => {
  'use strict';

  const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
  const HISTORY = 100;      // ticks kept for the chart and digit statistics
  const CHART_POINTS = 40;  // ticks drawn on the chart
  const $ = id => document.getElementById(id);

  // ---- trade types (names must match what server.js accepts) --------------
  const TABS = [
    { id: 'md', label: 'Matches / Differs', a: { type: 'DIGITMATCH', label: 'Matches' }, b: { type: 'DIGITDIFF', label: 'Differs' }, barrier: 'Prediction digit' },
    { id: 'eo', label: 'Even / Odd',        a: { type: 'DIGITEVEN',  label: 'Even' },    b: { type: 'DIGITODD',  label: 'Odd' },     barrier: null },
    { id: 'ou', label: 'Over / Under',      a: { type: 'DIGITOVER',  label: 'Over' },    b: { type: 'DIGITUNDER', label: 'Under' },  barrier: 'Barrier digit' },
    { id: 'rf', label: 'Rise / Fall',       a: { type: 'RISE',       label: 'Rise' },    b: { type: 'FALL',      label: 'Fall' },    barrier: null }
  ];
  const BARRIER_TYPES = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'];

  const S = {
    tab: TABS[0], digit: 5,
    markets: [], selected: null, decimals: 2, ticks: [],
    ws: null, retry: 1000, live: false,
    connected: false, configured: true, accounts: [], active: null, // active = {loginid,currency,isVirtual}
    pending: false, positions: [], seq: 0
  };

  // ---- small helpers ------------------------------------------------------
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 4500);
  }
  function decimalsFrom(pip) {
    const p = Number(pip);
    if (!Number.isFinite(p) || p <= 0) return 2;
    if (p >= 1 && Number.isInteger(p)) return Math.min(p, 8);
    return Math.min(8, Math.max(0, Math.round(-Math.log10(p))));
  }
  const digitOf = (q, dec) => Number(Number(q).toFixed(dec).slice(-1));
  const money = (n, cur) => (Number.isFinite(n) ? n.toFixed(2) : '—') + (cur ? ' ' + cur : '');
  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, data };
  }

  // =========================================================================
  // 1. LIVE TICKS (Deriv public WebSocket)
  // =========================================================================
  function setFeed(text, ok) { $('feedText').textContent = text; $('feedDot').className = 'dot' + (ok ? ' ok' : ''); }

  function connectFeed() {
    if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch (_) {} }
    setFeed('Connecting to Deriv…', false);
    const sock = new WebSocket(WS_URL);
    S.ws = sock;
    const send = o => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(o)); };
    let ping;

    sock.onopen = () => {
      S.retry = 1000;
      send({ active_symbols: 'brief', req_id: 1 });
      ping = setInterval(() => send({ ping: 1 }), 30000);
    };
    sock.onmessage = e => {
      if (sock !== S.ws) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.error) { setFeed('Feed error: ' + (m.error.message || m.error.code), false); return; }
      if (m.msg_type === 'active_symbols') onSymbols(m.active_symbols || [], send);
      else if (m.msg_type === 'history') onHistory(m, send);
      else if (m.msg_type === 'tick') onTick(m.tick);
    };
    sock.onerror = () => setFeed('Connection error', false);
    sock.onclose = () => {
      clearInterval(ping);
      if (sock !== S.ws) return;
      S.live = false;
      setFeed('Disconnected — retrying…', false);
      setTimeout(connectFeed, S.retry + Math.random() * 500);
      S.retry = Math.min(S.retry * 2, 30000);
    };
  }

  function onSymbols(list, send) {
    const sym = s => s.underlying_symbol || s.symbol;
    const name = s => s.underlying_symbol_name || s.display_name || sym(s);
    const isVol = s => /^Volatility/i.test(name(s)) || /^(R_\d+|1HZ\d+V)$/.test(sym(s));
    const is1s = s => /1s|^1HZ/i.test(name(s)) || /^1HZ/.test(sym(s));
    const num = s => parseInt((name(s).match(/\d+/) || [0])[0], 10);
    const picked = list.filter(s => isVol(s) && !is1s(s) && s.exchange_is_open !== 0 && s.is_trading_suspended !== 1)
      .sort((a, b) => num(a) - num(b)).slice(0, 8);
    if (!picked.length) { setFeed('No Volatility markets returned', false); return; }

    S.markets = picked.map(s => ({ symbol: sym(s), name: name(s), decimals: decimalsFrom(s.pip_size) }));
    const sel = $('market');
    if (!sel.options.length) {
      S.markets.forEach(m => { const o = document.createElement('option'); o.value = m.symbol; o.textContent = m.name; sel.appendChild(o); });
      S.selected = (S.markets.find(m => m.symbol === 'R_100') || S.markets[0]).symbol;
      sel.value = S.selected;
    }
    const cur = S.markets.find(m => m.symbol === S.selected) || S.markets[0];
    S.selected = cur.symbol; S.decimals = cur.decimals; S.ticks = [];
    setFeed('Loading history…', false);
    send({ ticks_history: S.selected, count: HISTORY, end: 'latest', style: 'ticks', adjust_start_time: 1, req_id: 2 });
  }

  function onHistory(m, send) {
    const prices = (m.history && m.history.prices) || [];
    const times = (m.history && m.history.times) || [];
    S.ticks = prices.slice(-HISTORY).map((p, i) => ({ price: Number(p), epoch: times[i], digit: digitOf(p, S.decimals) }));
    send({ ticks: S.selected, subscribe: 1 });
    S.live = true; setFeed('Live ticks', true); renderFeed();
  }

  function onTick(t) {
    if (!t || (t.underlying_symbol || t.symbol) !== S.selected) return;
    if (t.pip_size !== undefined) S.decimals = decimalsFrom(t.pip_size);
    S.ticks.push({ price: Number(t.quote), epoch: t.epoch, digit: digitOf(t.quote, S.decimals) });
    if (S.ticks.length > HISTORY) S.ticks.shift();
    S.live = true; setFeed('Live ticks', true); renderFeed();
  }

  function renderFeed() {
    const last = S.ticks[S.ticks.length - 1];
    $('price').textContent = last ? last.price.toFixed(S.decimals) : '—';
    $('lastDigit').textContent = last ? last.digit : '—';
    renderChart(); renderFreq();
  }

  function renderChart() {
    const pts = S.ticks.slice(-CHART_POINTS);
    const box = $('chart');
    if (pts.length < 2) { box.innerHTML = '<div class="empty">Waiting for ticks…</div>'; return; }
    const W = 800, H = 260, PX = 20, PY = 28;
    const ps = pts.map(p => p.price), min = Math.min(...ps), max = Math.max(...ps), r = max - min || 1;
    const xy = pts.map((p, i) => [PX + (i / (pts.length - 1)) * (W - PX * 2), PY + (1 - (p.price - min) / r) * (H - PY * 2)]);
    const line = xy.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
    const labels = xy.slice(-15).map((c, i) => {
      const d = pts[pts.length - xy.slice(-15).length + i].digit;
      return '<text x="' + c[0].toFixed(1) + '" y="' + (c[1] - 9).toFixed(1) + '" text-anchor="middle" fill="#91b3c8" font-size="11" font-family="monospace">' + d + '</text>';
    }).join('');
    const lp = xy[xy.length - 1];
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<path d="' + line + '" fill="none" stroke="#19c9f4" stroke-width="2"/>' + labels +
      '<circle cx="' + lp[0].toFixed(1) + '" cy="' + lp[1].toFixed(1) + '" r="6" fill="#00f59b"/></svg>';
  }

  function renderFreq() {
    const counts = Array(10).fill(0);
    S.ticks.forEach(t => counts[t.digit]++);
    const n = S.ticks.length || 1;
    const pct = counts.map(c => c / n * 100);
    const mx = Math.max(...pct), mn = Math.min(...pct);
    $('freqNote').textContent = '(last ' + S.ticks.length + ' ticks)';
    $('freq').innerHTML = pct.map((v, d) =>
      '<div class="fbar' + (v === mx ? ' max' : v === mn ? ' min' : '') + (S.tab.barrier && d === S.digit ? ' sel' : '') +
      '" style="height:' + Math.max(4, v * 4.5) + 'px"><b>' + v.toFixed(0) + '%</b><span>' + d + '</span></div>').join('');
  }

  // =========================================================================
  // 2. ACCOUNT (login, demo/real, balance)
  // =========================================================================
  async function loadAccount() {
    const { data } = await api('/api/deriv/accounts');
    S.connected = !!data.connected; S.configured = data.configured !== false;
    S.accounts = data.accounts || [];
    S.active = S.accounts.find(a => a.loginid === data.active) || null;

    const sel = $('acctSelect');
    sel.innerHTML = '';
    S.accounts.forEach(a => {
      const o = document.createElement('option');
      o.value = a.loginid;
      o.textContent = a.loginid + ' · ' + (a.isVirtual ? 'Demo' : 'Real') + ' · ' + a.currency;
      sel.appendChild(o);
    });
    if (S.active) sel.value = S.active.loginid;
    sel.disabled = !S.connected;

    $('connectBox').hidden = S.connected && !!S.active;
    $('connectMsg').textContent = S.configured
      ? 'Connect your Deriv account to place trades. Live prices work without logging in.'
      : 'Deriv login is not set up on the server (DERIV_CLIENT_ID and DERIV_REDIRECT_URI are missing).';
    $('connectBtn').style.display = S.configured ? '' : 'none';

    renderMode();
    updateBuyButtons();
    if (S.connected && S.active) { loadBalance(); loadRisk(); }
    else { $('balance').textContent = '—'; $('risk').innerHTML = '<span class="muted">Connect Deriv to see limits.</span>'; }
  }

  function renderMode() {
    const bar = $('modeBar'), badge = $('modeBadge');
    if (!S.active) {
      bar.className = 'modebar off'; bar.textContent = 'NOT CONNECTED — viewing live prices only';
      badge.className = 'badge'; badge.textContent = '—'; return;
    }
    if (S.active.isVirtual) {
      bar.className = 'modebar demo'; bar.textContent = 'DEMO ACCOUNT ' + S.active.loginid + ' — no real money';
      badge.className = 'badge demo'; badge.textContent = 'DEMO';
    } else {
      bar.className = 'modebar real'; bar.textContent = '⚠ REAL MONEY ACCOUNT ' + S.active.loginid + ' — trades use real funds';
      badge.className = 'badge real'; badge.textContent = 'REAL';
    }
  }

  async function loadBalance() {
    const { ok, data } = await api('/api/deriv/balance');
    $('balance').textContent = ok ? money(data.balance, data.currency) : '—';
  }

  $('acctSelect').addEventListener('change', async e => {
    const { ok, data } = await api('/api/deriv/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginid: e.target.value })
    });
    if (!ok) toast(data.error || 'Could not switch account.');
    await loadAccount();
    if (ok) toast('Switched to ' + (S.active && S.active.isVirtual ? 'DEMO' : 'REAL') + ' account ' + (S.active ? S.active.loginid : ''));
  });

  // =========================================================================
  // 3. LIMITS (server-side risk)
  // =========================================================================
  async function loadRisk() { const { ok, data } = await api('/api/risk'); if (ok) renderRisk(data); }

  function renderRisk(r) {
    if (!r) return;
    const cell = (label, val, cls) => '<div><small>' + label + '</small><b class="' + (cls || '') + '">' + val + '</b></div>';
    const pl = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2);
    let html =
      cell('Session P/L', pl(r.sessionPL), r.sessionPL >= 0 ? 'pos-g' : 'pos-r') +
      cell('Daily P/L', pl(r.dailyPL), r.dailyPL >= 0 ? 'pos-g' : 'pos-r') +
      cell('Wins / Losses', r.wins + ' / ' + r.losses) +
      cell('Loss limit', r.sessionLossLimit + ' (day ' + r.dailyStopLoss + ')');
    if (r.blockedReason) html += '<div class="warn">' + String(r.blockedReason).replace(/[<>&]/g, '') + '</div>';
    $('risk').innerHTML = html;
  }

  // =========================================================================
  // 4. TRADING
  // =========================================================================
  function canBuy(opt) {
    if (!S.connected || !S.active || S.pending) return false;
    if (opt.type === 'DIGITOVER' && S.digit > 8) return false;   // server rule: barrier 0-8
    if (opt.type === 'DIGITUNDER' && S.digit < 1) return false;  // server rule: barrier 1-9
    return true;
  }
  function updateBuyButtons() {
    $('buyA').textContent = S.tab.a.label; $('buyB').textContent = S.tab.b.label;
    $('buyA').disabled = !canBuy(S.tab.a); $('buyB').disabled = !canBuy(S.tab.b);
  }

  async function buy(opt) {
    if (S.pending || !canBuy(opt)) return;
    const stake = Number($('stake').value), dur = Number($('dur').value);
    if (!Number.isFinite(stake) || stake <= 0) return toast('Enter a stake above 0.');
    if (!Number.isInteger(dur) || dur < 1 || dur > 10) return toast('Duration must be a whole number from 1 to 10 ticks.');

    const needsBarrier = BARRIER_TYPES.includes(opt.type);
    const real = !S.active.isVirtual;
    const desc = opt.label + (needsBarrier ? ' ' + S.digit : '') + ' on ' + S.selected + ', ' + dur + ' ticks';
    if (real && !window.confirm('REAL MONEY TRADE\n\nAccount: ' + S.active.loginid + '\n' + desc + '\nStake: ' + stake + ' ' + S.active.currency + '\n\nPlace this trade?')) return;

    const pos = { id: ++S.seq, label: desc, stake, status: 'open' };
    S.positions.unshift(pos); S.positions = S.positions.slice(0, 20);
    S.pending = true; updateBuyButtons(); renderPositions();

    try {
      const { ok, status, data } = await api('/api/deriv/trade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: S.selected, direction: opt.type, barrier: needsBarrier ? S.digit : undefined,
          duration: dur, stake, strategy: 'Manual', confirmReal: real
        })
      });
      if (!ok) {
        pos.status = 'error'; pos.error = data.error || ('Trade failed (HTTP ' + status + ')');
        if (data.risk) renderRisk(data.risk);
        if (status === 401) loadAccount();
        toast(pos.error);
      } else {
        pos.status = data.isWin ? 'won' : 'lost'; pos.profit = data.profit; pos.payout = data.payout; pos.cur = S.active.currency;
        renderRisk(data.risk);
      }
    } catch (err) {
      pos.status = 'error'; pos.error = 'Network error: ' + err.message; toast(pos.error);
    } finally {
      S.pending = false; updateBuyButtons(); renderPositions(); loadBalance();
    }
  }

  function renderPositions() {
    const ul = $('positions');
    ul.innerHTML = '';
    if (!S.positions.length) { ul.innerHTML = '<li class="muted">No trades yet.</li>'; return; }
    S.positions.forEach(p => {
      const li = document.createElement('li');
      const left = document.createElement('span'); left.textContent = p.label + ' · ' + p.stake;
      const right = document.createElement('b');
      if (p.status === 'open') { right.textContent = 'waiting for result…'; }
      else if (p.status === 'error') { li.className = 'err'; right.textContent = p.error; right.style.color = '#ffb3c0'; right.style.fontWeight = 'normal'; }
      else { right.textContent = (p.profit >= 0 ? '+' : '') + Number(p.profit).toFixed(2) + ' ' + (p.cur || ''); right.className = p.status === 'won' ? 'pos-g' : 'pos-r'; }
      li.appendChild(left); li.appendChild(right); ul.appendChild(li);
    });
  }

  // =========================================================================
  // 5. UI wiring
  // =========================================================================
  function renderTabs() {
    const box = $('tabs'); box.innerHTML = '';
    TABS.forEach(t => {
      const b = document.createElement('button'); b.textContent = t.label;
      b.className = t.id === S.tab.id ? 'active' : '';
      b.onclick = () => { S.tab = t; renderTabs(); renderBarrier(); updateBuyButtons(); renderFreq(); };
      box.appendChild(b);
    });
  }
  function renderBarrier() {
    $('barrierBox').style.display = S.tab.barrier ? '' : 'none';
    if (!S.tab.barrier) return;
    $('barrierLabel').textContent = S.tab.barrier;
    const box = $('digits'); box.innerHTML = '';
    for (let d = 0; d < 10; d++) {
      const b = document.createElement('button'); b.textContent = d;
      b.className = d === S.digit ? 'active' : '';
      b.onclick = () => { S.digit = d; renderBarrier(); updateBuyButtons(); renderFreq(); };
      box.appendChild(b);
    }
  }

  $('buyA').onclick = () => buy(S.tab.a);
  $('buyB').onclick = () => buy(S.tab.b);
  $('market').addEventListener('change', e => { S.selected = e.target.value; S.ticks = []; renderFeed(); connectFeed(); });

  renderTabs(); renderBarrier(); updateBuyButtons(); renderChart(); renderFreq();
  connectFeed();
  loadAccount();
  setInterval(() => { if (S.connected && !S.pending) loadBalance(); }, 60000);
})();
