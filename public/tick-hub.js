/* tick-hub.js — shared by the Over/Under & Even/Odd bot and the golden floating bot.
 *  TickHub     : one WebSocket to Deriv's PUBLIC feed; keeps the last 1,000 last-digits for every synthetic index (Volatility, 1s, Jump, Boom/Crash, Step, etc.).
 *  TradeClient : sends bot trades to your server (/api/deriv/trade), one at a time, using the dashboard queue when present. */
(function (root) {
  'use strict';
  const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
  const WINDOW = 1000, MAX_MARKETS = 60;

  // ---------------------------------------------------------------- TickHub
  const markets = new Map();           // symbol -> { symbol, name, decimals, digits[], counts[10], last, ready }
  const handlers = { tick: [], ready: [], status: [] };
  const reqMap = new Map();
  let ws = null, ping = null, retry = 1000, started = false, nextReq = 100, status = { ok: false, text: 'Connecting…' };

  const emit = (k, a) => handlers[k].forEach(fn => { try { fn(a); } catch (e) { console.error(e); } });
  const on = (k, fn) => { handlers[k].push(fn); };
  function setStatus(ok, text) { status = { ok, text }; emit('status', status); }

  function decimalsFrom(pip) {
    const p = Number(pip);
    if (!Number.isFinite(p) || p <= 0) return 2;
    if (p >= 1 && Number.isInteger(p)) return Math.min(p, 8);
    return Math.min(8, Math.max(0, Math.round(-Math.log10(p))));
  }
  const digitOf = (q, dec) => Number(Number(q).toFixed(dec).slice(-1));
  function push(mk, d) {
    mk.digits.push(d); mk.counts[d]++;
    if (mk.digits.length > WINDOW) mk.counts[mk.digits.shift()]--;
    mk.last = d;
  }

  function start() {
    if (started) return; started = true; connect();
  }
  function connect() {
    setStatus(false, 'Connecting…');
    const sock = new WebSocket(WS_URL); ws = sock;
    const send = o => { if (sock.readyState === 1) sock.send(JSON.stringify(o)); };
    sock.onopen = () => { retry = 1000; send({ active_symbols: 'brief', req_id: 1 }); ping = setInterval(() => send({ ping: 1 }), 30000); };
    sock.onmessage = e => {
      if (sock !== ws) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.error) {
        if (m.req_id && reqMap.has(m.req_id)) { markets.delete(reqMap.get(m.req_id)); reqMap.delete(m.req_id); checkReady(); return; }   // one market failed: drop it, don't block the rest
        if (m.msg_type !== 'tick') setStatus(false, 'Feed error: ' + (m.error.message || m.error.code)); return;
      }
      if (m.msg_type === 'active_symbols') onSymbols(m.active_symbols || [], send);
      else if (m.msg_type === 'history') onHistory(m, send);
      else if (m.msg_type === 'tick') onTick(m.tick);
    };
    sock.onerror = () => setStatus(false, 'Connection error');
    sock.onclose = () => {
      clearInterval(ping);
      if (sock !== ws) return;
      markets.forEach(mk => { mk.ready = false; });
      setStatus(false, 'Disconnected — retrying…');
      setTimeout(connect, retry + Math.random() * 500); retry = Math.min(retry * 2, 30000);
    };
  }

  function onSymbols(list, send) {
    const sym = s => s.underlying_symbol || s.symbol;
    const name = s => s.underlying_symbol_name || s.display_name || sym(s);
    const isVol = s => /^Volatility/i.test(name(s)) || /^(R_\d+|1HZ\d+V)$/.test(sym(s));
    const is1s = s => /1s|^1HZ/i.test(name(s)) || /^1HZ/.test(sym(s));
    const SYNTH_SYM = /^(R_\d+|1HZ\d+V|JD\d+|BOOM\d+N?|CRASH\d+N?|stpRNG\d*|RB\d+|RDBEAR|RDBULL|DEX\d+(UP|DOWN)|DSI\d+|WLD[A-Z]+|CRYETH|CRYBTC)$/i;
    const isSynth = s => /synthetic/i.test(String(s.market || '')) || SYNTH_SYM.test(sym(s));
    const num = s => parseInt((name(s).match(/\d+/) || [0])[0], 10);
    const group = s => s.submarket_display_name || s.submarket || 'Synthetic indices';
    const picked = list.filter(s => isSynth(s) && s.exchange_is_open !== 0 && s.is_trading_suspended !== 1)
      .sort((a, b) => group(a).localeCompare(group(b)) || num(a) - num(b) || name(a).localeCompare(name(b))).slice(0, MAX_MARKETS);
    if (!picked.length) { setStatus(false, 'No synthetic markets returned'); return; }
    reqMap.clear();
    picked.forEach(s => {
      let mk = markets.get(sym(s));
      if (!mk) { mk = { symbol: sym(s), name: name(s), decimals: decimalsFrom(s.pip_size), digits: [], counts: Array(10).fill(0), last: null, ready: false }; markets.set(mk.symbol, mk); }
      mk.digits = []; mk.counts = Array(10).fill(0); mk.ready = false; mk.decimals = decimalsFrom(s.pip_size);
      mk.group = group(s); mk.vol = isVol(s) && !is1s(s);   // vol = the original regular-Volatility set (used by the gold scanner)
      const id = nextReq++; reqMap.set(id, mk.symbol);
      send({ ticks_history: mk.symbol, count: WINDOW, end: 'latest', style: 'ticks', adjust_start_time: 1, req_id: id });
    });
    setStatus(false, 'Loading history…');
  }

  function onHistory(m, send) {
    const symbol = reqMap.get(m.req_id), mk = symbol && markets.get(symbol); if (!mk) return;
    const prices = (m.history && m.history.prices) || [];
    mk.digits = []; mk.counts = Array(10).fill(0);
    prices.slice(-WINDOW).forEach(p => push(mk, digitOf(p, mk.decimals)));
    mk.ready = true;
    send({ ticks: mk.symbol, subscribe: 1 });
    checkReady();
  }
  function checkReady() {
    if (markets.size && [...markets.values()].every(x => x.ready)) { setStatus(true, 'Live · ' + markets.size + ' markets'); emit('ready', markets); }
  }

  function onTick(t) {
    const mk = t && markets.get(t.underlying_symbol || t.symbol); if (!mk || !mk.ready) return;
    if (t.pip_size !== undefined) mk.decimals = decimalsFrom(t.pip_size);
    const d = digitOf(t.quote, mk.decimals);
    push(mk, d);
    emit('tick', { symbol: mk.symbol, name: mk.name, digit: d, price: Number(t.quote), epoch: t.epoch });
  }

  const TickHub = { start, on, markets, get status() { return status; }, get ready() { return markets.size > 0 && [...markets.values()].every(m => m.ready); } };

  // ------------------------------------------------------------- TradeClient
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let acctCache = null, acctAt = 0, chain = Promise.resolve();

  async function account(force) {
    if (!force && acctCache && Date.now() - acctAt < 20000) return acctCache;
    try {
      const r = await fetch('/api/deriv/accounts', { credentials: 'same-origin' }), d = await r.json();
      const active = (d.accounts || []).find(a => a.loginid === d.active) || null;
      acctCache = { connected: !!d.connected && !!active, active, configured: d.configured !== false };
    } catch (e) { acctCache = { connected: false, active: null, error: e.message }; }
    acctAt = Date.now(); return acctCache;
  }
  const warm = () => { fetch('/api/deriv/warm', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); };

  function sendDirect(body) {                // used on pages without the dashboard queue (BotCore)
    const run = async () => {
      for (let i = 0; i < 4; i++) {
        let res;
        try { res = await fetch('/api/deriv/trade', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
        catch (e) { return { ok: false, status: 0, data: { error: 'Network error: ' + e.message } }; }
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && !data.stopped && i < 3) { await sleep(300); continue; }   // another trade still settling: retry fast
        return { ok: res.ok, status: res.status, data };
      }
    };
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
  }

  function place(body) {
    const C = root.BotCore;
    if (C && C.enqueue) return new Promise(resolve => C.enqueue({
      body, front: true, maxAge: 20000, isActive: () => true,
      onDone: r => resolve(r && !r.dropped ? r : { ok: false, status: 0, dropped: true, data: { error: 'Not sent: the previous trade took too long.' } })
    }));
    return sendDirect(body);
  }

  // Turns a server answer into something both bots understand.
  function classify(r) {
    const d = (r && r.data) || {};
    if (!r || r.dropped || r.status === 0) return { kind: 'error', msg: d.error || 'Trade not sent.' };
    if (r.status === 401) return { kind: 'stop', msg: 'Connect your Deriv account first.' };
    if (r.status === 403) return { kind: 'stop', msg: d.error || 'Blocked by a risk limit.' };
    if (!r.ok) return { kind: 'error', msg: d.error || 'Purchase failed.' };
    const profit = Number(d.profit) || 0;
    return { kind: d.isWin ? 'win' : 'loss', profit, payout: d.payout, id: d.contractId };
  }

  root.TickHub = TickHub;
  root.TradeClient = { account, warm, place, classify };
})(window);
