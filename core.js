/* core.js — shared trade engine for the dashboard.
 *
 * 1. TRADE QUEUE   Strategies hand their buys to one serial queue (Deriv allows one open
 *                  trade per account here). Each job is checked again right before it is sent.
 * 2. INSTANT STOP  stopRun(runId) cancels every queued job of that run, tells the server to
 *                  refuse any request still carrying that runId, and cancels a pending switch.
 *                  (A contract that Deriv already accepted cannot be recalled; it just settles.)
 * 3. SWITCH RULE   After an OVER/UNDER contract WINS, the very next trade is a DIFFERS
 *                  contract, then the bot goes back to Over/Under. Applies to the Smart
 *                  Strategy, the standalone Over/Under and the Major Scanner (UNDER3/4, OVER6/7).
 *                  Smart Strategy code is untouched: this layer watches its trade responses.
 */
(function (root) {
  'use strict';

  const CONFIG = {
    DIFFERS_BARRIER: 'most_frequent',   // 'most_frequent' (your documented Differs rule) or 'least_frequent'
    SWITCH_TTL_MS: 60000,               // a pending switch that never fires is dropped after this
    JOB_MAX_AGE_MS: 8000,               // a queued signal older than this is stale and dropped
    RETRIES_ON_409: 3,                  // server says another trade is running: wait and retry
    RETRY_DELAY_MS: 1200
  };

  const TRADE_URL = '/api/deriv/trade';
  const OVER_UNDER = new Set(['DIGITOVER', 'DIGITUNDER']);
  const isOverUnder = d => OVER_UNDER.has(d);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, p) => (listeners[ev] || []).forEach(fn => { try { fn(p); } catch (e) { console.error(e); } });

  const S = {
    switchEnabled: true,
    pendingSwitch: null,     // { origin, runId, at }
    queue: [],
    busy: false,
    stopped: new Set(),
    origins: {},             // origin id -> fn(runId) => is that origin still running?
    trades: []               // settled trades seen on this page (newest first)
  };

  const nativeFetch = root.fetch ? root.fetch.bind(root) : null;   // whatever fetch is at load time

  // --------------------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------------------
  const newRunId = id => `${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const registerOrigin = (id, fn) => { S.origins[id] = fn; };

  function originActive(origin, runId) {
    if (runId && S.stopped.has(runId)) return false;
    const fn = S.origins[origin];
    return fn ? !!fn(runId) : false;
  }

  function pickDiffersBarrier(counts, mode) {
    const m = mode || CONFIG.DIFFERS_BARRIER;
    let best = 0;
    for (let d = 1; d < 10; d++) {
      if (m === 'least_frequent' ? counts[d] < counts[best] : counts[d] > counts[best]) best = d;
    }
    return best;
  }

  // Same market as the winning trade if the live feed has it; otherwise the first feed market.
  function pickDiffersTarget(symbol) {
    const feed = root.DerivFeed;
    if (!feed || !feed.markets) return null;
    let mk = feed.markets.get(symbol);
    if (!mk || mk.digits.length < 100) mk = [...feed.markets.values()].find(m => m.digits.length >= 100);
    if (!mk) return null;
    return { symbol: mk.symbol, barrier: pickDiffersBarrier(mk.counts) };
  }

  function switchBlocking() {
    const p = S.pendingSwitch;
    if (!p) return false;
    if (Date.now() - p.at > CONFIG.SWITCH_TTL_MS || !originActive(p.origin, p.runId)) { S.pendingSwitch = null; return false; }
    return true;
  }

  const cancelSwitch = origin => { if (S.pendingSwitch && (!origin || S.pendingSwitch.origin === origin)) S.pendingSwitch = null; };

  // --------------------------------------------------------------------------------------
  // Serial trade queue
  // --------------------------------------------------------------------------------------
  function enqueue(job) {
    job.at = Date.now();
    job.maxAge = job.maxAge || CONFIG.JOB_MAX_AGE_MS;
    if (job.front) S.queue.unshift(job); else S.queue.push(job);
    pump();
    return job;
  }

  async function sendTrade(body) {
    const res = await root.fetch(TRADE_URL, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  }

  async function pump() {
    if (S.busy) return;
    S.busy = true;
    try {
      while (S.queue.length) {
        const job = S.queue.shift();
        const done = r => { try { job.onDone && job.onDone(r); } catch (e) { console.error(e); } };
        if (!job.isActive()) { done({ dropped: 'stopped' }); continue; }
        if (Date.now() - job.at > job.maxAge) { done({ dropped: 'stale' }); continue; }
        let attempt = 0, result;
        for (;;) {
          if (!job.isActive()) { result = { dropped: 'stopped' }; break; }
          try { result = await sendTrade(job.body); }
          catch (err) { result = { ok: false, status: 0, data: { error: err.message || 'Network error.' } }; break; }
          if (result.status === 409 && !result.data.stopped && attempt < CONFIG.RETRIES_ON_409) {
            attempt++; await sleep(CONFIG.RETRY_DELAY_MS); continue;
          }
          break;
        }
        done(result);
      }
    } finally { S.busy = false; }
  }

  // --------------------------------------------------------------------------------------
  // Instant stop
  // --------------------------------------------------------------------------------------
  function stopRun(runId) {
    if (!runId) return;
    S.stopped.add(runId);
    if (S.stopped.size > 500) S.stopped.delete(S.stopped.values().next().value);
    if (S.pendingSwitch && S.pendingSwitch.runId === runId) S.pendingSwitch = null;
    if (nativeFetch) {
      nativeFetch('/api/bot/stop', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runIds: [runId] })
      }).catch(() => {});
    }
  }

  // --------------------------------------------------------------------------------------
  // Over/Under WIN -> Differs
  // --------------------------------------------------------------------------------------
  function maybeQueueSwitch(body) {
    const origin = body.sid || 'smart';                // Smart Strategy trades carry no sid
    if (!originActive(origin, body.runId) || S.pendingSwitch) return;
    const target = pickDiffersTarget(body.symbol);
    if (!target) { emit('note', 'Over/Under won, but no live market data is ready for the Differs switch.'); return; }
    S.pendingSwitch = { origin, runId: body.runId || null, at: Date.now() };
    const jobBody = {
      symbol: target.symbol, direction: 'DIGITDIFF', barrier: target.barrier,
      duration: body.duration, stake: body.stake, strategy: 'Differs (auto-switch)',
      confirmReal: body.confirmReal === true, runId: body.runId, sid: 'switch', source: 'switch'
    };
    emit('switch', { from: body, to: jobBody });
    enqueue({
      body: jobBody, front: true, maxAge: 15000,
      isActive: () => originActive(origin, body.runId),
      onDone: r => { S.pendingSwitch = null; emit('switch-done', { result: r, body: jobBody }); }
    });
  }

  function handleResult(body, status, d) {
    if (status === 403 && d && d.halted) { emit('halt', { reason: d.error || 'Risk limit reached.' }); return; }
    const ok = status >= 200 && status < 300 && d && d.contractId;
    if (!ok) return;
    const rec = {
      time: Date.now(), strategy: body.strategy || body.direction, sid: body.sid || 'smart', source: body.source || 'smart',
      symbol: body.symbol, direction: body.direction, barrier: body.barrier, stake: Number(body.stake),
      profit: Number(d.profit) || 0, win: d.isWin === true, contractId: d.contractId
    };
    S.trades.unshift(rec);
    if (S.trades.length > 300) S.trades.pop();
    emit('trade', rec);
    if (S.switchEnabled && body.source !== 'switch' && d.isWin === true && isOverUnder(body.direction)) maybeQueueSwitch(body);
  }

  // Watches EVERY trade request (including the untouched Smart Strategy's).
  if (nativeFetch) {
    root.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes(TRADE_URL) || !init || typeof init.body !== 'string') return nativeFetch(input, init);
      let body;
      try { body = JSON.parse(init.body); } catch (_) { return nativeFetch(input, init); }

      // While a Differs follow-up is pending, no new Over/Under entry may jump ahead of it.
      if (isOverUnder(body.direction) && body.source !== 'switch' && switchBlocking()) {
        return new Response(JSON.stringify({ error: 'Over/Under paused: switching to Differs after the last Over/Under win.', switching: true }),
          { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      const res = await nativeFetch(input, init);
      let d = null;
      try { d = await res.clone().json(); } catch (_) {}
      handleResult(body, res.status, d);       // runs BEFORE the caller continues, so the switch is queued first
      return res;
    };
  }

  const getStats = () => {
    const t = S.trades, wins = t.filter(x => x.win).length;
    const pl = t.reduce((a, x) => a + x.profit, 0);
    let streak = 0;
    for (const x of t) { if (!t.length) break; if (streak === 0) streak = x.win ? 1 : -1; else if ((streak > 0) === x.win) streak += streak > 0 ? 1 : -1; else break; }
    return {
      trades: t.length, wins, losses: t.length - wins, pl,
      winRate: t.length ? (wins / t.length) * 100 : null,
      best: t.length ? Math.max(...t.map(x => x.profit)) : 0,
      worst: t.length ? Math.min(...t.map(x => x.profit)) : 0,
      streak, last: t[0] || null
    };
  };

  const api = {
    CONFIG, state: S, on, emit, enqueue, stopRun, newRunId, registerOrigin, cancelSwitch, originActive,
    pickDiffersBarrier, pickDiffersTarget, isOverUnder, getStats,
    setSwitchEnabled: v => { S.switchEnabled = !!v; if (!v) S.pendingSwitch = null; },
    isSwitchEnabled: () => S.switchEnabled
  };
  root.BotCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
