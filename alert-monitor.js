// alert-monitor.js — server-side signal watcher. Runs on the server, so alerts arrive with NO browser open.
// Uses Deriv's public tick feed (no login), the same strategy rules as the dashboard (public/strategy-logic.js),
// and sends ONE WhatsApp digest listing every strategy that qualifies, plus a risk-based stake suggestion.
const L = require('./public/strategy-logic.js');
const { suggestStake } = require('./stake.js');

const WINDOW = 1000, MAX_MARKETS = 8, MAX_LINES = 6;
const decimalsFrom = pip => { const p = Number(pip); if (!Number.isFinite(p) || p <= 0) return 2; if (p >= 1 && Number.isInteger(p)) return Math.min(p, 8); return Math.min(8, Math.max(0, Math.round(-Math.log10(p)))); };
const digitOf = (q, dec) => Number(Number(q).toFixed(dec).slice(-1));
const shortName = n => String(n || '').replace(/^Volatility\s*/i, 'V').replace(/\s*Index$/i, '');

function createMonitor({ WebSocketImpl, send, url, env = process.env, log = console.log, now = () => Date.now() }) {
  const cfg = {
    cooldownMs: Math.max(1, Number(env.ALERT_COOLDOWN_MIN || 10)) * 60000,
    flushMs: Math.max(3, Number(env.ALERT_FLUSH_SEC || 8)) * 1000,
    includeDiffers: String(env.ALERT_INCLUDE_DIFFERS) === 'true',
    stake: {
      bankroll: Number(env.ALERT_BANKROLL), riskPct: Number(env.ALERT_RISK_PCT || 1),
      maxStake: Number(env.MAX_TRADE_STAKE || 500), sessionLossLimit: Number(env.SESSION_LOSS_LIMIT || 500),
      minStake: Number(env.ALERT_MIN_STAKE || 0.35)
    }
  };
  const defs = L.DEFS.filter(d => cfg.includeDiffers || d.id !== 'differs');
  const markets = new Map(), reqMap = new Map(), pending = new Map(), sentAt = new Map();
  let ws = null, retry = 1000, nextReq = 100, flushTimer = null, pingTimer = null, stopped = false, live = false;

  const tx = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const push = (mk, d) => { mk.digits.push(d); mk.counts[d]++; if (mk.digits.length > WINDOW) mk.counts[mk.digits.shift()]--; };

  function onSymbols(list) {
    const sym = s => s.underlying_symbol || s.symbol, name = s => s.underlying_symbol_name || s.display_name || sym(s);
    const isVol = s => /^Volatility/i.test(name(s)) || /^(R_\d+|1HZ\d+V)$/.test(sym(s));
    const is1s = s => /1s|^1HZ/i.test(name(s)) || /^1HZ/.test(sym(s));
    const num = s => parseInt((name(s).match(/\d+/) || [0])[0], 10);
    list.filter(s => isVol(s) && s.exchange_is_open !== 0 && s.is_trading_suspended !== 1 && !is1s(s))
      .sort((a, b) => num(a) - num(b)).slice(0, MAX_MARKETS)
      .forEach(s => markets.set(sym(s), { symbol: sym(s), name: name(s), decimals: decimalsFrom(s.pip_size), digits: [], counts: Array(10).fill(0) }));
    markets.forEach(mk => { const id = nextReq++; reqMap.set(id, mk.symbol); tx({ ticks_history: mk.symbol, count: WINDOW, end: 'latest', style: 'ticks', adjust_start_time: 1, req_id: id }); });
  }
  function onHistory(m) {
    const mk = markets.get(reqMap.get(m.req_id) || (m.echo_req && m.echo_req.ticks_history)); if (!mk) return;
    ((m.history && m.history.prices) || []).slice(-WINDOW).forEach(p => push(mk, digitOf(p, mk.decimals)));
    tx({ ticks: mk.symbol, subscribe: 1 }); live = true;
  }
  function onTick(t) {
    const mk = t && markets.get(t.underlying_symbol || t.symbol); if (!mk) return;
    if (t.pip_size !== undefined) mk.decimals = decimalsFrom(t.pip_size);
    push(mk, digitOf(t.quote, mk.decimals));
    defs.forEach(def => {
      const sig = L.evaluate(def, mk, t.epoch);
      if (!sig || !sig.type) return;
      const ck = def.momentary ? `${def.id}|${mk.symbol}` : `${def.id}|${mk.symbol}|${sig.key}`;
      if (now() - (sentAt.get(ck) || 0) < cfg.cooldownMs || pending.has(ck)) return;
      pending.set(ck, { def, symbol: mk.symbol, sig, at: now() });
    });
  }
  function handle(m) {
    if (m.error) { log('[alerts] Deriv API error:', m.error.message || m.error.code); return; }
    if (m.msg_type === 'active_symbols') onSymbols(m.active_symbols || []);
    else if (m.msg_type === 'history') onHistory(m);
    else if (m.msg_type === 'tick') onTick(m.tick);
  }

  function buildText(items) {
    const t = new Date(now()).toISOString().slice(11, 16) + ' UTC';
    const lines = items.slice(0, MAX_LINES).map((it, i) => `${i + 1}. ${it.def.label} · ${shortName((markets.get(it.symbol) || {}).name || it.symbol)} · ${it.sig.short}`);
    if (items.length > MAX_LINES) lines.push(`+${items.length - MAX_LINES} more`);
    const s = suggestStake(cfg.stake);
    const stakeLine = s
      ? `💰 Suggested stake: $${s.stake.toFixed(2)} per trade (${s.riskPct}% of $${s.bankroll} bankroll${s.capped ? ', capped by your limits' : ''}${s.belowMin ? ', platform minimum' : ''}). Most you can lose per trade = the stake.${s.heavy ? ' ⚠ Stake is large for this bankroll.' : ''}`
      : '💰 Set ALERT_BANKROLL on the server to get a stake suggestion.';
    return `📡 SIGNALS ${t}\n${lines.join('\n')}\n${stakeLine}\nNo stake guarantees profit. Use 1 tick, test on demo first.`;
  }

  async function flush() {
    if (!pending.size) return null;
    const entries = [...pending.entries()]; pending.clear();
    const keep = entries.filter(([, it]) => {
      if (it.def.momentary) return now() - it.at < 60000;
      const mk = markets.get(it.symbol); const s = mk && L.evaluate(it.def, mk, 0);
      return !!(s && s.type);                                   // continuous strategies must still qualify now
    });
    if (!keep.length) return null;
    const order = id => L.DEFS.findIndex(d => d.id === id);
    const items = keep.map(([, it]) => it).sort((a, b) => order(a.def.id) - order(b.def.id));
    const text = buildText(items);
    try { await send(text); keep.forEach(([k]) => sentAt.set(k, now())); log(`[alerts] sent ${items.length} signal(s)`); return text; }
    catch (err) {
      log('[alerts] WhatsApp send failed:', err.message);
      if (err.status === 429) keep.forEach(([k, it]) => pending.set(k, it));      // too fast: try again next flush
      return null;
    }
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocketImpl(url);
    ws.on('open', () => { retry = 1000; markets.clear(); reqMap.clear(); live = false; tx({ active_symbols: 'brief', req_id: 1 }); clearInterval(pingTimer); pingTimer = setInterval(() => tx({ ping: 1 }), 30000); });
    ws.on('message', d => { try { handle(JSON.parse(String(d))); } catch (e) { log('[alerts] bad message', e.message); } });
    ws.on('error', e => log('[alerts] socket error:', e && e.message));
    ws.on('close', () => { clearInterval(pingTimer); live = false; if (!stopped) { setTimeout(connect, retry + Math.random() * 500); retry = Math.min(retry * 2, 30000); } });
  }
  return {
    start() { stopped = false; connect(); flushTimer = setInterval(() => { flush().catch(() => {}); }, cfg.flushMs); log('[alerts] automatic WhatsApp alerts ON (server-side)'); },
    stop() { stopped = true; clearInterval(flushTimer); clearInterval(pingTimer); try { ws && ws.close(); } catch (_) {} },
    flush, cfg, isLive: () => live, _pending: pending, _markets: markets
  };
}
module.exports = { createMonitor };
