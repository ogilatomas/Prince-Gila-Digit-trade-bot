/* manual.js — Manual Trading page, connected to your server and Deriv.
 *
 * - Live ticks:  Deriv's public WebSocket (same address the dashboard uses). No fake data.
 * - Chart:       canvas chart with zoom, scroll, hover price, latest-price tag and trade markers.
 * - Digits:      last-digit prediction bars with a selectable tick window (25 to 1000).
 * - Account:     /api/deriv/accounts, /api/deriv/select, /api/deriv/balance
 * - Trades:      POST /api/deriv/trade  (the server enforces stake + loss limits)
 * - Limits:      /api/risk
 */
(() => {
  'use strict';

  const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
  const MAX_TICKS = 1000;                 // ticks kept in memory
  const STAT_WINDOWS = [25, 50, 100, 500, 1000];
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
    view: { count: 60, offset: 0 },     // chart: ticks shown, and how far back from the latest tick
    statN: 1000,                         // digit statistics window
    hover: null, drag: null, geo: null,
    connected: false, configured: true, accounts: [], active: null,
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
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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
    send({ ticks_history: S.selected, count: MAX_TICKS, end: 'latest', style: 'ticks', adjust_start_time: 1, req_id: 2 });
  }

  function onHistory(m, send) {
    const prices = (m.history && m.history.prices) || [];
    const times = (m.history && m.history.times) || [];
    S.ticks = prices.slice(-MAX_TICKS).map((p, i) => ({ price: Number(p), epoch: times[i], digit: digitOf(p, S.decimals) }));
    S.view.offset = 0; S.hover = null;
    send({ ticks: S.selected, subscribe: 1 });
    S.live = true; setFeed('Live ticks', true); renderFeed();
  }

  function onTick(t) {
    if (!t || (t.underlying_symbol || t.symbol) !== S.selected) return;
    if (t.pip_size !== undefined) S.decimals = decimalsFrom(t.pip_size);
    S.ticks.push({ price: Number(t.quote), epoch: t.epoch, digit: digitOf(t.quote, S.decimals) });
    if (S.ticks.length > MAX_TICKS) S.ticks.shift();
    // If you've scrolled back in time, keep the view still instead of dragging it forward.
    if (S.view.offset > 0) S.view.offset = Math.min(S.view.offset + 1, maxOffset());
    S.live = true; setFeed('Live ticks', true); renderFeed();
  }

  function renderFeed() {
    const last = S.ticks[S.ticks.length - 1];
    $('price').textContent = last ? last.price.toFixed(S.decimals) : '—';
    $('lastDigit').textContent = last ? last.digit : '—';
    scheduleDraw(); renderFreq();
  }

  // =========================================================================
  // 2. CHART  (canvas: line, zoom, scroll, hover, price tag, trade markers)
  // =========================================================================
  const cv = $('chartCanvas');
  const ctx = cv.getContext('2d');
  let raf = 0;
  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawChart(); });
  }
  const effCount = () => Math.max(2, Math.min(S.view.count, S.ticks.length));
  function maxOffset() { return Math.max(0, S.ticks.length - effCount()); }

  // Nearest tick at or before an epoch time (-1 if none in memory).
  function idxByEpoch(epoch) {
    if (epoch == null) return -1;
    for (let i = S.ticks.length - 1; i >= 0; i--) if (S.ticks[i].epoch <= epoch) return i;
    return -1;
  }

  // Where a trade's entry and exit ticks are. Exact if the server supplied the times, otherwise estimated.
  function positionSpan(p) {
    if (p.exact && p.exact.entryTime != null) {
      const e = idxByEpoch(p.exact.entryTime);
      if (e < 0) return null;
      const x = p.exact.exitTime != null ? idxByEpoch(p.exact.exitTime) : -1;
      return { e, x: x >= 0 ? x : e + p.dur - 1 };
    }
    const b = idxByEpoch(p.clickEpoch);
    if (b < 0) return null;
    return { e: b + 1, x: b + p.dur };      // entry = first tick after you pressed Buy
  }

  function drawChart() {
    const r = cv.getBoundingClientRect();
    const W = Math.max(200, r.width), H = Math.max(160, r.height);
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const n = S.ticks.length;
    $('goLive').className = 'live' + (S.view.offset > 0 ? ' on' : '');
    if (n < 2) {
      ctx.fillStyle = '#91b3c8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Waiting for ticks…', W / 2, H / 2); S.geo = null; return;
    }

    const eff = effCount();
    const off = Math.min(S.view.offset, n - eff);
    const end = n - off, start = end - eff;
    const padL = 10, padR = 74, padT = 22, padB = 16;
    const plotW = W - padL - padR - 8, plotH = H - padT - padB;
    const step = plotW / (eff - 1);
    const xAt = i => padL + (i - start) * step;

    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < end; i++) { const p = S.ticks[i].price; if (p < lo) lo = p; if (p > hi) hi = p; }
    let pad = (hi - lo) * 0.14; if (!pad) pad = Math.abs(hi) * 0.0005 || 0.01;
    lo -= pad; hi += pad;
    const yAt = p => padT + (1 - (p - lo) / (hi - lo)) * plotH;
    S.geo = { padL, step, start, end, W, H, padR };

    // grid + price axis
    ctx.font = '11px monospace'; ctx.textAlign = 'left'; ctx.lineWidth = 1;
    for (let g = 0; g <= 5; g++) {
      const v = lo + (hi - lo) * (g / 5), y = yAt(v);
      ctx.strokeStyle = '#0d2a40'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = '#6f93a8'; ctx.fillText(v.toFixed(S.decimals), W - padR + 6, y + 4);
    }

    // area + line
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, 'rgba(25,201,244,0.28)'); grad.addColorStop(1, 'rgba(25,201,244,0)');
    ctx.beginPath();
    for (let i = start; i < end; i++) { const x = xAt(i), y = yAt(S.ticks[i].price); i === start ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = '#19c9f4'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(xAt(end - 1), H - padB); ctx.lineTo(xAt(start), H - padB); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // dots + last digits when zoomed in
    if (eff <= 60) {
      for (let i = start; i < end; i++) {
        ctx.beginPath(); ctx.arc(xAt(i), yAt(S.ticks[i].price), 2.6, 0, Math.PI * 2); ctx.fillStyle = '#19c9f4'; ctx.fill();
      }
    }
    if (eff <= 40) {
      ctx.textAlign = 'center'; ctx.font = '11px monospace'; ctx.fillStyle = '#9bbdd0';
      for (let i = start; i < end; i++) ctx.fillText(String(S.ticks[i].digit), xAt(i), yAt(S.ticks[i].price) - 9);
    }

    drawMarkers(xAt, yAt, start, end, padT, H - padB, W - padR);

    // latest-price tag
    const li = end - 1, lt = S.ticks[li], ly = yAt(lt.price);
    const up = li === 0 || lt.price >= S.ticks[li - 1].price;
    ctx.setLineDash([3, 4]); ctx.strokeStyle = up ? '#00f59b' : '#ff4d6a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xAt(li), ly); ctx.lineTo(W - padR, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = up ? '#00f59b' : '#ff4d6a';
    ctx.fillRect(W - padR + 2, ly - 10, padR - 4, 20);
    ctx.fillStyle = '#00160f'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left';
    ctx.fillText(lt.price.toFixed(S.decimals), W - padR + 6, ly + 4);
    ctx.beginPath(); ctx.arc(xAt(li), ly, 5, 0, Math.PI * 2); ctx.fillStyle = up ? '#00f59b' : '#ff4d6a'; ctx.fill();

    // hover crosshair + tooltip
    if (S.hover != null && S.hover >= start && S.hover < end) {
      const t = S.ticks[S.hover], hx = xAt(S.hover), hy = yAt(t.price);
      ctx.strokeStyle = '#3b6a86'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, H - padB); ctx.moveTo(padL, hy); ctx.lineTo(W - padR, hy); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      const lines = [t.price.toFixed(S.decimals), 'Last digit ' + t.digit, t.epoch ? new Date(t.epoch * 1000).toLocaleTimeString() : ''];
      const bw = 128, bh = 52;
      const bx = hx + 12 + bw > W - padR ? hx - 12 - bw : hx + 12, by = clamp(hy - bh / 2, padT, H - padB - bh);
      ctx.fillStyle = '#0b2b45'; ctx.strokeStyle = '#087fa9'; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = 'bold 12px monospace'; ctx.fillText(lines[0], bx + 8, by + 17);
      ctx.fillStyle = '#9bbdd0'; ctx.font = '11px sans-serif'; ctx.fillText(lines[1], bx + 8, by + 32); ctx.fillText(lines[2], bx + 8, by + 46);
    }
  }

  function drawMarkers(xAt, yAt, start, end, top, bottom, right) {
    const n = S.ticks.length;
    S.positions.forEach(p => {
      if (p.sym !== S.selected || p.status === 'error') return;
      const sp = positionSpan(p);
      if (!sp || sp.e >= n) return;
      const color = p.status === 'won' ? '#00f59b' : p.status === 'lost' ? '#ff4d6a' : '#ffe34e';
      const settled = p.status === 'won' || p.status === 'lost';
      const xi = Math.min(sp.x, n - 1);
      const showExit = settled || sp.x < n;

      // entry: vertical line + label
      if (sp.e >= start && sp.e < end) {
        const ex = xAt(sp.e);
        ctx.strokeStyle = '#ffe34e88'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ex, top); ctx.lineTo(ex, bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.textAlign = 'center'; ctx.font = 'bold 11px sans-serif';
        const lab = p.optLabel + (p.needsBarrier ? ' ' + p.digit : '');
        const w = ctx.measureText(lab).width + 12;
        ctx.fillStyle = '#3a3410'; ctx.fillRect(ex - w / 2, top - 18, w, 17);
        ctx.fillStyle = '#ffe34e'; ctx.fillText(lab, ex, top - 5);
        ctx.beginPath(); ctx.arc(ex, yAt(S.ticks[sp.e].price), 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#ffe34e'; ctx.stroke();
      }
      // Rise/Fall: price barrier line from entry to exit
      if (!p.needsBarrier && (p.optLabel === 'Rise' || p.optLabel === 'Fall')) {
        const x1 = Math.max(xAt(Math.max(sp.e, start)), 0), x2 = Math.min(xAt(Math.min(xi, end - 1)), right);
        if (sp.e < end && xi >= start && x2 > x1) {
          const by = yAt(S.ticks[sp.e].price);
          ctx.strokeStyle = '#ffe34e'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x1, by); ctx.lineTo(x2, by); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // exit marker
      if (showExit && xi >= start && xi < end) {
        const x = xAt(xi), y = yAt(S.ticks[xi].price);
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = settled ? color : '#8fa3b3'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        if (settled) {
          const txt = (p.profit >= 0 ? '+' : '') + Number(p.profit).toFixed(2);
          ctx.textAlign = 'center'; ctx.font = 'bold 12px sans-serif'; ctx.fillStyle = color; ctx.fillText(txt, x, y - 14);
        }
      }
    });
  }

  // ---- chart interaction: hover, drag to scroll, wheel / pinch to zoom ----
  const relX = e => e.clientX - cv.getBoundingClientRect().left;
  function indexAtX(x) {
    const g = S.geo; if (!g) return null;
    return clamp(g.start + Math.round((x - g.padL) / g.step), g.start, g.end - 1);
  }
  function zoomBy(factor) {
    const cur = S.view.count;
    let next = Math.round(cur * factor);
    if (next === cur) next += factor > 1 ? 1 : -1;
    S.view.count = clamp(next, 10, 500);
    S.view.offset = Math.min(S.view.offset, maxOffset());
    scheduleDraw();
  }
  function panTo(x) {
    if (!S.drag || !S.geo) return;
    const moved = Math.round((x - S.drag.x0) / S.geo.step);
    S.view.offset = clamp(S.drag.off0 + moved, 0, maxOffset());
    scheduleDraw();
  }

  cv.addEventListener('mousedown', e => { S.drag = { x0: relX(e), off0: S.view.offset }; });
  cv.addEventListener('mousemove', e => {
    if (S.drag) { panTo(relX(e)); return; }
    S.hover = indexAtX(relX(e)); scheduleDraw();
  });
  const stopDrag = () => { S.drag = null; };
  cv.addEventListener('mouseup', stopDrag);
  cv.addEventListener('mouseleave', () => { S.drag = null; S.hover = null; scheduleDraw(); });
  cv.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.2 : 1 / 1.2); }, { passive: false });

  let pinch = null;
  const dist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  cv.addEventListener('touchstart', e => {
    if (e.touches.length === 2) { pinch = { d: dist(e.touches), count: S.view.count }; S.drag = null; }
    else if (e.touches.length === 1) { S.drag = { x0: e.touches[0].clientX - cv.getBoundingClientRect().left, off0: S.view.offset }; }
  }, { passive: true });
  cv.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && pinch) {
      S.view.count = clamp(Math.round(pinch.count * pinch.d / dist(e.touches)), 10, 500);
      S.view.offset = Math.min(S.view.offset, maxOffset()); scheduleDraw();
    } else if (e.touches.length === 1 && S.drag) {
      panTo(e.touches[0].clientX - cv.getBoundingClientRect().left);
    }
  }, { passive: false });
  cv.addEventListener('touchend', () => { S.drag = null; pinch = null; });

  $('zoomIn').onclick = () => zoomBy(1 / 1.5);
  $('zoomOut').onclick = () => zoomBy(1.5);
  $('goLive').onclick = () => { S.view.offset = 0; scheduleDraw(); };
  window.addEventListener('resize', scheduleDraw);

  // =========================================================================
  // 3. LAST DIGIT PREDICTION (frequency bars with a tick window)
  // =========================================================================
  function renderStatN() {
    const box = $('statN'); box.innerHTML = '';
    STAT_WINDOWS.forEach(n => {
      const b = document.createElement('button'); b.textContent = String(n);
      b.className = n === S.statN ? 'active' : '';
      b.onclick = () => { S.statN = n; renderStatN(); renderFreq(); };
      box.appendChild(b);
    });
  }

  function renderFreq() {
    const N = Math.min(S.statN, S.ticks.length);
    const counts = Array(10).fill(0);
    S.ticks.slice(S.ticks.length - N).forEach(t => counts[t.digit]++);
    const pct = counts.map(c => (N ? c / N * 100 : 0));
    const mx = Math.max(...pct), mn = Math.min(...pct);
    const cur = S.ticks.length ? S.ticks[S.ticks.length - 1].digit : -1;
    $('freqNote').textContent = '(' + N + (N < S.statN ? ' of ' + S.statN : '') + ' ticks)';
    $('freqSummary').textContent = N ? 'Most: ' + pct.indexOf(mx) + ' (' + mx.toFixed(1) + '%) · Least: ' + pct.indexOf(mn) + ' (' + mn.toFixed(1) + '%) · Current digit: ' + cur : 'Waiting for ticks…';
    $('freq').innerHTML = pct.map((v, d) =>
      '<div class="fbar' + (v === mx ? ' max' : v === mn ? ' min' : '') + (S.tab.barrier && d === S.digit ? ' sel' : '') + (d === cur ? ' cur' : '') +
      '" style="height:' + Math.max(4, v * 5) + 'px">' + (d === cur ? '<em>▼</em>' : '') + '<b>' + v.toFixed(1) + '%</b><span>' + d + '</span></div>').join('');
  }

  // =========================================================================
  // 4. ACCOUNT (login, demo/real, balance)
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
  // 5. LIMITS (server-side risk)
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
  // 6. TRADING
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

    const lastTick = S.ticks[S.ticks.length - 1];
    const pos = {
      id: ++S.seq, label: desc, stake, status: 'open',
      sym: S.selected, optLabel: opt.label, needsBarrier, digit: S.digit, dur,
      clickEpoch: lastTick ? lastTick.epoch : null, exact: null
    };
    S.positions.unshift(pos); S.positions = S.positions.slice(0, 20);
    S.pending = true; updateBuyButtons(); renderPositions(); scheduleDraw();

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
        // Exact entry/exit tick times, if your server sends them (optional server.js change).
        if (data.entryTime != null) pos.exact = { entryTime: data.entryTime, exitTime: data.exitTime != null ? data.exitTime : null };
        renderRisk(data.risk);
      }
    } catch (err) {
      pos.status = 'error'; pos.error = 'Network error: ' + err.message; toast(pos.error);
    } finally {
      S.pending = false; updateBuyButtons(); renderPositions(); scheduleDraw(); loadBalance();
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
  // 7. UI wiring
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
  $('market').addEventListener('change', e => { S.selected = e.target.value; S.ticks = []; S.view.offset = 0; renderFeed(); connectFeed(); });

  renderTabs(); renderBarrier(); renderStatN(); updateBuyButtons(); renderFreq(); scheduleDraw();
  connectFeed();
  loadAccount();
  setInterval(() => { if (S.connected && !S.pending) loadBalance(); }, 60000);
})();
