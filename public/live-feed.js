/* live-feed.js — live Deriv tick data for the DigitTrade dashboard.
 *
 * Uses Deriv's PUBLIC WebSocket (no login, no token, no app id needed):
 *   wss://api.derivws.com/trading/v1/options/ws/public
 *
 * What it does:
 *   1. active_symbols  -> finds the Volatility indices
 *   2. ticks_history   -> loads the last 1,000 ticks per market
 *   3. ticks (stream)  -> keeps a rolling 1,000-tick window per market
 *   4. renders the Live Market Scanner table and the Digit Frequency chart
 *
 * Add to public/index.html AFTER script.js:
 *   <script src="live-feed.js"></script>
 */
(() => {
  'use strict';

  const WS_URL      = 'wss://api.derivws.com/trading/v1/options/ws/public';
  const WINDOW      = 1000;   // ticks kept per market
  const MAX_MARKETS = 8;
  const INCLUDE_1S  = false;  // set true to also include the "(1s)" volatility indices
  const HOT = 13, COLD = 8;   // % thresholds, same as your Hot/Cold rule
  const RENDER_MS   = 500;    // UI refresh interval (ticks arrive faster than this)

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const markets = new Map();   // symbol -> { symbol, name, decimals, digits[], counts[10], last }
  const reqMap  = new Map();   // req_id -> symbol (for history responses)
  const listeners = { tick: [] };
  let ws = null, pingTimer = null, retry = 1000, selected = null, dirty = false, nextReq = 100;

  // ---------------------------------------------------------------------------
  // Digit helpers
  // pip_size may arrive as a step (0.01) or as a decimal count (2): handle both.
  // ---------------------------------------------------------------------------
  function decimalsFrom(pip) {
    const p = Number(pip);
    if (!Number.isFinite(p) || p <= 0) return 2;
    if (p >= 1 && Number.isInteger(p)) return Math.min(p, 8);
    return Math.min(8, Math.max(0, Math.round(-Math.log10(p))));
  }
  function digitOf(quote, decimals) {
    return Number(Number(quote).toFixed(decimals).slice(-1));
  }
  function pushDigit(mk, d) {
    mk.digits.push(d);
    mk.counts[d]++;
    if (mk.digits.length > WINDOW) mk.counts[mk.digits.shift()]--;
    mk.last = d;
  }
  const pct = (mk, d) => (mk.digits.length ? (mk.counts[d] / mk.digits.length) * 100 : 0);

  // ---------------------------------------------------------------------------
  // Status badge (inside the scanner tab bar)
  // ---------------------------------------------------------------------------
  function setStatus(text, ok) {
    let el = $('feedStatus');
    if (!el) {
      el = document.createElement('span');
      el.id = 'feedStatus';
      el.style.cssText = 'margin-left:auto;font-size:10px;align-self:center';
      const tabs = document.querySelector('#scanner .tabs');
      if (tabs) tabs.appendChild(el);
    }
    el.textContent = '● ' + text;
    el.style.color = ok ? '#00f59b' : '#ffc857';
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------
  const send = obj => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  function connect() {
    setStatus('Connecting to Deriv…', false);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      retry = 1000;
      markets.clear();
      reqMap.clear();
      send({ active_symbols: 'brief', req_id: 1 });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ ping: 1 }), 30000);
    };

    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      handle(m);
    };

    ws.onerror = () => setStatus('Connection error', false);

    ws.onclose = () => {
      clearInterval(pingTimer);
      setStatus('Disconnected — retrying…', false);
      setTimeout(connect, retry + Math.random() * 500);   // exponential backoff + jitter
      retry = Math.min(retry * 2, 30000);
    };
  }

  function handle(m) {
    if (m.error) {
      console.warn('[DerivFeed] API error:', m.error);
      setStatus('API error: ' + (m.error.message || m.error.code || 'unknown'), false);
      return;
    }
    switch (m.msg_type) {
      case 'active_symbols': return onSymbols(m.active_symbols || []);
      case 'history':        return onHistory(m);
      case 'tick':           return onTick(m.tick);
    }
  }

  function onSymbols(list) {
    if (list[0]) console.log('[DerivFeed] sample active symbol:', list[0]);

    // New API: underlying_symbol / underlying_symbol_name. Legacy: symbol / display_name.
    const sym  = s => s.underlying_symbol || s.symbol;
    const name = s => s.underlying_symbol_name || s.display_name || sym(s);
    const isVol = s => /^Volatility/i.test(name(s)) || /^(R_\d+|1HZ\d+V)$/.test(sym(s));
    const is1s  = s => /1s|^1HZ/i.test(name(s)) || /^1HZ/.test(sym(s));
    const num   = s => parseInt((name(s).match(/\d+/) || [0])[0], 10);

    const picked = list
      .filter(s => isVol(s) && s.exchange_is_open !== 0 && s.is_trading_suspended !== 1)
      .filter(s => INCLUDE_1S || !is1s(s))
      .sort((a, b) => num(a) - num(b))
      .slice(0, MAX_MARKETS);

    if (!picked.length) {
      setStatus('No Volatility markets returned — see console', false);
      return;
    }

    picked.forEach(s => markets.set(sym(s), {
      symbol: sym(s),
      name: name(s),
      decimals: decimalsFrom(s.pip_size),
      digits: [],
      counts: Array(10).fill(0),
      last: null
    }));

    const allTab = document.querySelector('[data-tab="all"]');
    if (allTab) allTab.textContent = `All Markets (${markets.size})`;
    if (!selected || !markets.has(selected)) selected = sym(picked[0]);

    setStatus('Loading history…', false);
    markets.forEach(mk => {
      const id = nextReq++;
      reqMap.set(id, mk.symbol);
      send({ ticks_history: mk.symbol, count: WINDOW, end: 'latest', style: 'ticks', adjust_start_time: 1, req_id: id });
    });
  }

  function onHistory(m) {
    const symbol = reqMap.get(m.req_id) || (m.echo_req && m.echo_req.ticks_history);
    const mk = markets.get(symbol);
    if (!mk) return;
    const prices = (m.history && m.history.prices) || [];
    prices.slice(-WINDOW).forEach(p => pushDigit(mk, digitOf(p, mk.decimals)));
    send({ ticks: mk.symbol, subscribe: 1 });   // start the live stream after history is loaded
    setStatus('Live', true);
    dirty = true;
  }

  function onTick(t) {
    if (!t) return;
    const mk = markets.get(t.underlying_symbol || t.symbol);
    if (!mk) return;
    if (t.pip_size !== undefined) mk.decimals = decimalsFrom(t.pip_size);
    const d = digitOf(t.quote, mk.decimals);
    pushDigit(mk, d);
    listeners.tick.forEach(fn => {
      try { fn({ symbol: mk.symbol, name: mk.name, digit: d, quote: t.quote, epoch: t.epoch, digits: mk.digits }); }
      catch (e) { console.error(e); }
    });
    dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderTable() {
    const rows = [...markets.values()].map((mk, i) => {
      const n = mk.digits.length;
      const cells = mk.counts.map((_, d) => {
        const p = pct(mk, d);
        const bg = n >= 100 ? (p >= HOT ? '#00b861' : p <= COLD ? '#a8741a' : '') : '';
        return `<td class="digit"${bg ? ` style="background:${bg}"` : ''}>${p.toFixed(1)}%</td>`;
      }).join('');
      const top = mk.counts.indexOf(Math.max(...mk.counts));
      const sel = mk.symbol === selected ? ';background:#0b2b45' : '';
      return `<tr data-symbol="${esc(mk.symbol)}" style="cursor:pointer${sel}">` +
        `<td>${i + 1}</td><td>${esc(mk.name)}</td><td><b>${mk.last ?? '—'}</b></td>${cells}` +
        `<td style="color:#00f59b">Live<br><small>${n}/${WINDOW} ticks · top digit ${n ? top : '—'}</small></td>` +
        `<td><button class="tradebtn" data-goto="smartStrategy">Scan</button></td></tr>`;
    }).join('');
    $('marketRows').innerHTML = rows;
  }

  function renderChart() {
    const mk = markets.get(selected);
    if (!mk) return;
    const vals = mk.counts.map((_, d) => pct(mk, d));
    const max = Math.max(...vals), min = Math.min(...vals);
    $('chart').innerHTML = vals.map((v, d) => {
      const bg = v === max ? 'linear-gradient(#66ff7a,#00bd6d)'
               : v === min ? 'linear-gradient(#c77dff,#6e50c8)'
               :             'linear-gradient(#39b8ff,#1765db)';
      return `<div class="bar" style="height:${Math.max(4, v * 6)}px;background:${bg}"><b>${v.toFixed(1)}%</b><span>${d}</span></div>`;
    }).join('');
    const note = document.querySelector('#strategies .muted');
    if (note) note.textContent = `Live · ${mk.name} · last ${mk.digits.length} ticks (click a market row to switch)`;
  }

  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    renderTable();
    renderChart();
    const t = $('timer');
    if (t) t.textContent = 'LIVE';
  }, RENDER_MS);

  $('marketRows').addEventListener('click', e => {
    if (e.target.closest('[data-goto]')) {
      $('smartStrategy').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const tr = e.target.closest('tr[data-symbol]');
    if (tr) { selected = tr.dataset.symbol; dirty = true; }
  });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  $('marketRows').innerHTML = '<tr><td colspan="14">Connecting to live market data…</td></tr>';

  // Small public hook so other code (e.g. the Smart Strategy) can reuse this feed.
  window.DerivFeed = { markets, digitOf, decimalsFrom, onTick: fn => listeners.tick.push(fn) };

  connect();
})();
