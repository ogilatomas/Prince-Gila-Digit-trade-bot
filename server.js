const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DERIV_API_BASE = 'https://api.derivws.com';
const DERIV_AUTH_BASE = 'https://auth.deriv.com';
const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'ogila-demo-session-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'OGILA TRADERS',
  mode: 'demo',
  api: 'deriv-new'
}));

// The frontend no longer needs an App ID for public market ticks.
// Keep the endpoint for compatibility with the existing UI.
app.get('/api/config', (req, res) => res.json({
  derivConfigured: Boolean(process.env.DERIV_CLIENT_ID && process.env.DERIV_REDIRECT_URI),
  aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  priceAppId: null,
  mode: 'demo',
  derivApi: 'new'
}));

// -----------------------------------------------------------------------------
// Deriv New API — OAuth 2.0 + PKCE
// Current Deriv OAuth uses an authorization code and PKCE.
// -----------------------------------------------------------------------------

function derivConfigured() {
  return Boolean(process.env.DERIV_CLIENT_ID && process.env.DERIV_REDIRECT_URI);
}

function base64Url(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makePkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(
    crypto.createHash('sha256').update(verifier).digest()
  );
  return { verifier, challenge };
}

function makeState() {
  return base64Url(crypto.randomBytes(24));
}

app.get('/auth/deriv/login', (req, res) => {
  if (!derivConfigured()) {
    return res.redirect('/?derivError=' + encodeURIComponent(
      'Deriv OAuth is not configured. Set DERIV_CLIENT_ID and DERIV_REDIRECT_URI.'
    ));
  }

  const { verifier, challenge } = makePkce();
  const state = makeState();

  req.session.derivOAuth = { state, verifier };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.DERIV_CLIENT_ID,
    redirect_uri: process.env.DERIV_REDIRECT_URI,
    scope: 'trade',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`${DERIV_AUTH_BASE}/oauth2/auth?${params.toString()}`);
});

async function exchangeOAuthCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.DERIV_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: process.env.DERIV_REDIRECT_URI
  });

  const response = await fetch(`${DERIV_AUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const message =
      data.error_description ||
      data.error ||
      data.message ||
      'Deriv OAuth token exchange failed.';
    throw new Error(message);
  }

  return data;
}

async function derivRest(pathname, accessToken, options = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {})
  };

  const response = await fetch(`${DERIV_API_BASE}${pathname}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiMessage =
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      data?.message ||
      `Deriv API request failed (${response.status}).`;
    const err = new Error(apiMessage);
    err.status = response.status;
    err.deriv = data;
    throw err;
  }

  return data;
}

function extractAccounts(payload) {
  const raw =
    payload?.data?.accounts ||
    payload?.data ||
    payload?.accounts ||
    [];

  if (!Array.isArray(raw)) return [];

  return raw.map((a) => {
    const accountId = String(
      a.account_id ??
      a.accountId ??
      a.loginid ??
      a.login_id ??
      a.id ??
      ''
    );

    const accountType = String(
      a.account_type ??
      a.accountType ??
      (a.is_virtual ? 'demo' : '') ??
      ''
    ).toLowerCase();

    const currency = String(a.currency || 'USD');

    return {
      // loginid is retained as a frontend-compatible field name.
      loginid: accountId,
      accountId,
      token: null,
      currency,
      accountType,
      isVirtual: accountType === 'demo' || accountType === 'virtual'
    };
  }).filter(a => a.accountId);
}

app.get('/auth/deriv/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const pending = req.session.derivOAuth;

  if (error) {
    delete req.session.derivOAuth;
    return res.redirect('/?derivError=' + encodeURIComponent(
      error_description || error || 'Deriv authorization was cancelled.'
    ));
  }

  if (!code || !state || !pending || state !== pending.state) {
    delete req.session.derivOAuth;
    return res.redirect('/?derivError=' + encodeURIComponent(
      'Invalid or expired Deriv OAuth callback.'
    ));
  }

  try {
    const tokenData = await exchangeOAuthCode(code, pending.verifier);
    const accountsPayload = await derivRest(
      '/trading/v1/options/accounts',
      tokenData.access_token
    );

    const accounts = extractAccounts(accountsPayload);

    if (!accounts.length) {
      throw new Error('Deriv login succeeded, but no Options trading accounts were returned.');
    }

    const preferred =
      accounts.find(a => a.isVirtual) ||
      accounts[0];

    req.session.deriv = {
      accessToken: tokenData.access_token,
      expiresAt: tokenData.expires_in
        ? Date.now() + Number(tokenData.expires_in) * 1000
        : null,
      accounts,
      activeLoginid: preferred.loginid
    };

    delete req.session.derivOAuth;
    res.redirect('/?derivConnected=1');
  } catch (err) {
    console.error('Deriv OAuth callback error:', err.message);
    delete req.session.derivOAuth;
    res.redirect('/?derivError=' + encodeURIComponent(
      err.message || 'Deriv login failed.'
    ));
  }
});

app.post('/auth/deriv/logout', (req, res) => {
  try { (req.session.deriv?.accounts || []).forEach(a => dropPooled(a)); } catch (_) {}   // close the saved fast connection
  delete req.session.deriv;
  delete req.session.derivOAuth;
  res.json({ ok: true });
});

app.get('/api/deriv/accounts', (req, res) => {
  const d = req.session.deriv;
  if (!d) {
    return res.json({
      connected: false,
      configured: derivConfigured(),
      accounts: [],
      active: null
    });
  }

  res.json({
    connected: true,
    configured: true,
    accounts: d.accounts.map(a => ({
      loginid: a.loginid,
      currency: a.currency,
      isVirtual: a.isVirtual
    })),
    active: d.activeLoginid
  });
});

app.post('/api/deriv/select', (req, res) => {
  const d = req.session.deriv;
  if (!d) return res.status(401).json({ error: 'Not connected to Deriv.' });

  const requested = String(req.body?.loginid || '');
  const acct = d.accounts.find(a => a.loginid === requested);

  if (!acct) return res.status(400).json({ error: 'Unknown account.' });

  d.activeLoginid = acct.loginid;
  res.json({
    ok: true,
    active: acct.loginid,
    isVirtual: acct.isVirtual,
    currency: acct.currency
  });
});

function getActiveAccount(req) {
  const d = req.session.deriv;
  if (!d) return null;
  return d.accounts.find(a => a.loginid === d.activeLoginid) || null;
}

function getAccessToken(req) {
  return req.session.deriv?.accessToken || null;
}

// -----------------------------------------------------------------------------
// Authenticated Deriv WebSocket helpers
// -----------------------------------------------------------------------------

function loadWebSocket() {
  try {
    return require('ws');
  } catch (err) {
    throw new Error(
      'The "ws" package is required for Deriv trading. Add "ws" to package.json dependencies and redeploy.'
    );
  }
}

async function getAuthenticatedWsUrl(accessToken, accountId) {
  const payload = await derivRest(
    `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    accessToken,
    { method: 'POST' }
  );

  const url = payload?.data?.url;
  if (!url) throw new Error('Deriv did not return an authenticated WebSocket URL.');
  return url;
}

function openDerivSocket(wsUrl) {
  const WebSocket = loadWebSocket();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.once('open', () => {
      if (!settled) {
        settled = true;
        resolve(ws);
      }
    });

    ws.once('error', fail);

    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      fail(new Error('Timed out connecting to Deriv.'));
    }, 15000);

    ws.once('open', () => clearTimeout(timer));
  });
}

function wsRequest(ws, payload, { timeoutMs = 15000, predicate } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = Number(payload.req_id || Date.now() % 1000000000);
    const request = { ...payload, req_id: reqId };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Deriv WebSocket response.'));
    }, timeoutMs);

    const onMessage = (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

     
      // Ignore responses that belong to a different request.
      if (data.req_id !== reqId) return;

      if (data.error) {
        cleanup();

        const apiError = data.error;
        const err = new Error(
          apiError.message || 'Deriv WebSocket error.'
        );

        err.derivCode = apiError.code || apiError.error_code || null;
        err.derivDetails = apiError.details || null;
        err.derivRequest = request;

        console.error('Deriv WebSocket request failed:', JSON.stringify({
          req_id: reqId,
          requestType: request.proposal
            ? 'proposal'
            : request.buy
              ? 'buy'
              : 'other',
          errorCode: err.derivCode,
          errorMessage: err.message,
          proposalId: request.buy || null
        }));

        reject(err);
        return;
      }

      if (data.req_id !== reqId) return;
      if (predicate && !predicate(data)) return;

      cleanup();
      resolve(data);
    };

    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Deriv WebSocket closed before the response arrived.'));
    };

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);

    ws.send(JSON.stringify(request), (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

function closeSocket(ws) {
  if (!ws) return;
  try { ws.close(); } catch (_) {}
}

// -----------------------------------------------------------------------------
// SPEED: one long-lived, already-authenticated Deriv socket per account.
// Before, every trade did: REST one-time-password call -> new TLS/WebSocket connection ->
// proposal -> buy. That setup alone cost a second or more per trade. Now the socket is opened
// once, kept alive with pings, and reused by trades, balance checks and quotes.
// -----------------------------------------------------------------------------
const socketPool = new Map();            // "loginid|accountId" -> { ws, pending, lastUsed, lastMsg, timer }
const SOCKET_IDLE_MS = 10 * 60 * 1000;   // close after 10 minutes without use
const SOCKET_PING_MS = 20 * 1000;
const SOCKET_DEAD_MS = 50 * 1000;        // no message (not even a pong) for this long = dead, replace it
let reqCounter = 1000;
const nextReq = () => (reqCounter = (reqCounter % 900000000) + 1);   // unique ids on a shared socket

const poolKey = acct => `${acct.loginid}|${acct.accountId}`;

function dropPooled(acct) {
  const k = poolKey(acct), e = socketPool.get(k);
  if (!e) return;
  socketPool.delete(k);
  clearInterval(e.timer);
  if (e.ws) closeSocket(e.ws);
}

async function getPooledSocket(acct, accessToken) {
  const k = poolKey(acct), existing = socketPool.get(k);
  if (existing) {
    if (existing.pending) return existing.pending;
    if (existing.ws && existing.ws.readyState === 1) { existing.lastUsed = Date.now(); return existing.ws; }
    dropPooled(acct);
  }
  const entry = { ws: null, pending: null, lastUsed: Date.now(), lastMsg: Date.now(), timer: null };
  entry.pending = (async () => {
    const url = await getAuthenticatedWsUrl(accessToken, acct.accountId);
    const ws = await openDerivSocket(url);
    if (ws.setMaxListeners) ws.setMaxListeners(100);
    ws.on('message', () => { entry.lastMsg = Date.now(); });
    ws.on('error', () => {});            // a 'close' event follows; avoids unhandled 'error' on an idle socket
    ws.on('close', () => {
      if (socketPool.get(k) === entry) socketPool.delete(k);
      clearInterval(entry.timer);
    });
    entry.timer = setInterval(() => {
      const now = Date.now();
      if (now - entry.lastUsed > SOCKET_IDLE_MS || now - entry.lastMsg > SOCKET_DEAD_MS) {
        if (socketPool.get(k) === entry) socketPool.delete(k);
        clearInterval(entry.timer); closeSocket(ws); return;
      }
      try { ws.send(JSON.stringify({ ping: 1 })); } catch (_) {}
    }, SOCKET_PING_MS);
    if (entry.timer.unref) entry.timer.unref();
    entry.ws = ws; entry.pending = null;
    return ws;
  })();
  socketPool.set(k, entry);
  try { return await entry.pending; }
  catch (err) { if (socketPool.get(k) === entry) socketPool.delete(k); throw err; }
}

// Lets the browser open the socket ahead of the first trade (called when a page/bot loads or starts).
app.post('/api/deriv/warm', async (req, res) => {
  const acct = getActiveAccount(req), accessToken = getAccessToken(req);
  if (!acct || !accessToken) return res.status(401).json({ error: 'No active Deriv account.' });
  try { await getPooledSocket(acct, accessToken); res.json({ ok: true }); }
  catch (err) { res.status(502).json({ error: err.message || 'Could not reach Deriv.' }); }
});

app.get('/api/deriv/balance', async (req, res) => {
  const acct = getActiveAccount(req);
  const accessToken = getAccessToken(req);

  if (!acct || !accessToken) {
    return res.status(401).json({ error: 'No active Deriv account.' });
  }

  try {
    const ws = await getPooledSocket(acct, accessToken);

    const data = await wsRequest(ws, {
      balance: 1, req_id: nextReq()
    }, {
      predicate: msg => msg.msg_type === 'balance'
    });

    const balance = data.balance || {};

    res.json({
      balance: Number(balance.balance),
      currency: balance.currency || acct.currency,
      loginid: acct.loginid,
      isVirtual: acct.isVirtual
    });
  } catch (err) {
    console.error('Deriv balance error:', err.message);
    if (!err.derivCode) dropPooled(acct);
    res.status(502).json({
      error: err.message || 'Could not fetch balance from Deriv.'
    });
  }
});

// -----------------------------------------------------------------------------
// Real/demo trading through the New API.
// RISE -> CALL, FALL -> PUT.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Server-side risk limits. Held in memory per Deriv account (resets if the
// server restarts). These are enforced HERE, so the browser cannot bypass them.
// -----------------------------------------------------------------------------
const riskStates = new Map(); // loginid -> state

function todayKey() { return new Date().toISOString().slice(0, 10); } // UTC day

function getRisk(loginid) {
  let r = riskStates.get(loginid);
  if (!r) {
    r = {
      sessionLossLimit: Number(process.env.SESSION_LOSS_LIMIT || 500),
      dailyStopLoss: Number(process.env.DAILY_STOP_LOSS || 500),
      dailyTarget: Number(process.env.DAILY_TARGET_PROFIT || 500),
      sessionPL: 0, dailyPL: 0, day: todayKey(),
      trades: 0, wins: 0, losses: 0, lastStake: 0, inFlight: false
    };
    riskStates.set(loginid, r);
  }
  if (r.day !== todayKey()) { r.day = todayKey(); r.dailyPL = 0; }
  return r;
}

// Returns a reason string if a trade of `stake` must NOT be placed, else null.
// A losing digit trade loses its stake, so we block any trade that COULD push
// the total past the limit; the limit is therefore never exceeded.
function riskBlockReason(r, stake) {
  if (r.sessionPL - stake < -r.sessionLossLimit) {
    return `Session loss limit (${r.sessionLossLimit}) reached.`;
  }
  if (r.dailyPL - stake < -r.dailyStopLoss) {
    return `Daily stop loss (${r.dailyStopLoss}) reached.`;
  }
  if (r.dailyPL >= r.dailyTarget) {
    return `Daily profit target (${r.dailyTarget}) reached.`;
  }
  return null;
}

function riskSnapshot(r) {
  const round = n => Math.round(n * 100) / 100;
  return {
    sessionLossLimit: r.sessionLossLimit,
    dailyStopLoss: r.dailyStopLoss,
    dailyTarget: r.dailyTarget,
    sessionPL: round(r.sessionPL),
    dailyPL: round(r.dailyPL),
    trades: r.trades, wins: r.wins, losses: r.losses,
    day: r.day,
    blockedReason: riskBlockReason(r, r.lastStake || 0)
  };
}

function recordResult(r, pl) {
  r.sessionPL += pl;
  r.dailyPL += pl;
  r.trades += 1;
  if (pl > 0) r.wins += 1; else r.losses += 1;
}

app.get('/api/risk', (req, res) => {
  const acct = getActiveAccount(req);
  if (!acct) return res.status(401).json({ error: 'No active Deriv account.' });
  res.json(riskSnapshot(getRisk(acct.loginid)));
});

app.post('/api/risk', (req, res) => {
  const acct = getActiveAccount(req);
  if (!acct) return res.status(401).json({ error: 'No active Deriv account.' });
  const r = getRisk(acct.loginid);
  const b = req.body || {};
  const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 1e6 ? n : null; };
  const s = pos(b.sessionLossLimit), d = pos(b.dailyStopLoss), t = pos(b.dailyTarget);
  if (s !== null) r.sessionLossLimit = s;
  if (d !== null) r.dailyStopLoss = d;
  if (t !== null) r.dailyTarget = t;
  if (b.resetSession === true) { r.sessionPL = 0; r.trades = 0; r.wins = 0; r.losses = 0; }
  res.json(riskSnapshot(r));
});

// -----------------------------------------------------------------------------
// Digit contract types the bot may buy (all strategies)
//   Over/Under, Differs, Matches  -> need a barrier digit 0-9
//   Even/Odd                      -> no barrier
// -----------------------------------------------------------------------------
const DIGIT_BARRIER_TYPES = ['DIGITOVER', 'DIGITUNDER', 'DIGITDIFF', 'DIGITMATCH'];
const DIGIT_PARITY_TYPES = ['DIGITEVEN', 'DIGITODD'];
const DIGIT_TYPES = [...DIGIT_BARRIER_TYPES, ...DIGIT_PARITY_TYPES];
const ALLOWED_DIRECTIONS = ['RISE', 'FALL', ...DIGIT_TYPES];

function digitTradeError(direction, barrier) {
  if (!DIGIT_BARRIER_TYPES.includes(direction)) return null;
  const b = Number(barrier);
  if (barrier === undefined || barrier === null || barrier === '' || !Number.isInteger(b) || b < 0 || b > 9) {
    return 'Digit barrier must be a whole number from 0 to 9.';
  }
  if (direction === 'DIGITOVER' && b > 8) return 'DIGITOVER needs a barrier of 0-8 (no digit is over 9).';
  if (direction === 'DIGITUNDER' && b < 1) return 'DIGITUNDER needs a barrier of 1-9 (no digit is under 0).';
  return null;
}

// Instant-stop support: the browser reports stopped run ids; any trade still carrying one is refused.
const stoppedRuns = new Set();
app.post('/api/bot/stop', (req, res) => {
  const ids = Array.isArray(req.body && req.body.runIds) ? req.body.runIds : [];
  ids.slice(0, 50).forEach(id => { stoppedRuns.add(String(id).slice(0, 80)); });
  while (stoppedRuns.size > 500) stoppedRuns.delete(stoppedRuns.values().next().value);
  res.json({ ok: true });
});

app.post('/api/deriv/trade', async (req, res) => {
  const acct = getActiveAccount(req);
  const accessToken = getAccessToken(req);

  if (!acct || !accessToken) {
    return res.status(401).json({ error: 'No active Deriv account.' });
  }

  const { symbol, direction, stake, barrier, duration } = req.body || {};
  const runId = String((req.body && req.body.runId) || '').slice(0, 80);
  if (runId && stoppedRuns.has(runId)) {
    return res.status(409).json({ error: 'This strategy was stopped; trade refused.', stopped: true });
  }
  const requestedDuration = Number(duration === undefined || duration === null || duration === '' ? 5 : duration);
  const amount = Number(stake);
  const isDigitContract = DIGIT_TYPES.includes(direction);
  if (!Number.isInteger(requestedDuration) || requestedDuration < 1 || requestedDuration > 10) {
    return res.status(400).json({ error: 'Ticks must be a whole number from 1 to 10.' });
  }
  const needsBarrier = DIGIT_BARRIER_TYPES.includes(direction);
  const strategyLabel = String((req.body && req.body.strategy) || '').slice(0, 40);
  const digitBarrier = Number(barrier);

  if (!symbol || !ALLOWED_DIRECTIONS.includes(direction) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid trade request.' });
  }
  const barrierProblem = digitTradeError(direction, barrier);
  if (barrierProblem) {
    return res.status(400).json({ error: barrierProblem });
  }

  // Real-account trading is ON by default (set ALLOW_REAL_DIGIT_TRADES=false to block it).
  // The UI must still send an explicit confirmation with the request.
  if (isDigitContract && !acct.isVirtual) {
    if (process.env.ALLOW_REAL_DIGIT_TRADES === 'false') {
      return res.status(403).json({ error: 'Real-account trading has been switched off on this server (ALLOW_REAL_DIGIT_TRADES=false).' });
    }
    if (req.body?.confirmReal !== true) {
      return res.status(403).json({ error: 'Real-account digit purchase requires explicit confirmation.' });
    }
  }

  // Server-side safety ceiling. This is a code-level limit, not a profitability guarantee.
  // Hard ceiling of 5000: MAX_TRADE_STAKE can lower it but never raise it, and a
  // missing/invalid value falls back to 5000 (a NaN here would disable the check).
  const envMax = Number(process.env.MAX_TRADE_STAKE);
  const maxStake = Number.isFinite(envMax) && envMax > 0 ? Math.min(envMax, 5000) : 5000;
  if (amount > maxStake) {
    return res.status(400).json({
      error: `Stake exceeds the server limit of ${maxStake}.`
    });
  }

  // Risk gate: one trade at a time, and never past the loss/profit limits.
  const risk = getRisk(acct.loginid);
  if (risk.inFlight) {
    return res.status(409).json({ error: 'Another trade is still in progress.' });
  }
  const blocked = riskBlockReason(risk, amount);
  if (blocked) {
    return res.status(403).json({ error: blocked, halted: true, risk: riskSnapshot(risk) });
  }
  risk.inFlight = true;
  risk.lastStake = amount;
  let boughtContract = null;
  let recorded = false;

  let ws;

  try {
    ws = await getPooledSocket(acct, accessToken);

    const contractType = direction === 'RISE' ? 'CALL' : direction === 'FALL' ? 'PUT' : direction;

    const buyParameters = {
      amount, basis: 'stake', contract_type: contractType,
      currency: acct.currency, duration_unit: 't',
      duration: requestedDuration,
      underlying_symbol: String(symbol)
    };
    if (needsBarrier) buyParameters.barrier = String(digitBarrier);

    // FAST PATH: buy straight away with the contract parameters. For a stake-basis contract the
    // price is the stake, so the separate proposal round trip is not needed.
    let askPrice = amount;
    let buyResponse;
    try {
      buyResponse = await wsRequest(ws, {
        buy: 1, price: amount, parameters: buyParameters, req_id: nextReq()
      }, { predicate: msg => msg.msg_type === 'buy' });
    } catch (buyErr) {
      // A timeout / dropped socket may mean the buy DID go through: never retry those (no double purchase).
      if (!buyErr.derivCode) throw buyErr;
      // Deriv answered with an error: ask for a fresh proposal (clearer message) and buy by its id.
      console.warn('Direct buy refused, retrying with a proposal:', buyErr.message);
      let fresh;
      try {
        fresh = await wsRequest(ws, { proposal: 1, ...buyParameters, req_id: nextReq() },
          { predicate: msg => msg.msg_type === 'proposal' });
      } catch (proposalErr) {
        // Log proposal parameters only; never log the OAuth token or authenticated URL.
        console.error('Deriv proposal rejected:', JSON.stringify({
          code: proposalErr.derivCode || null, message: proposalErr.message,
          symbol: String(symbol), contractType, duration: requestedDuration, durationUnit: 't',
          barrier: needsBarrier ? digitBarrier : undefined, currency: acct.currency
        }));
        const codeText = proposalErr.derivCode ? ` [${proposalErr.derivCode}]` : '';
        const err = new Error(`Deriv rejected ${contractType} proposal for ${String(symbol)} (${requestedDuration} ticks)${codeText}: ${proposalErr.message}`);
        err.derivCode = proposalErr.derivCode || buyErr.derivCode || 'rejected';
        throw err;
      }
      const fp = fresh.proposal || {};
      if (!fp.id || !Number.isFinite(Number(fp.ask_price))) throw buyErr;
      askPrice = Number(fp.ask_price);
      buyResponse = await wsRequest(ws, {
        buy: String(fp.id), price: askPrice, req_id: nextReq()
      }, { predicate: msg => msg.msg_type === 'buy' });
    }

    const bought = buyResponse.buy || {};
    const contractId = bought.contract_id;

    if (!contractId) {
      throw new Error('Deriv did not return a contract ID after purchase.');
    }
    boughtContract = contractId;
    console.log(`Trade: ${strategyLabel || direction} ${symbol}${needsBarrier ? ' barrier ' + digitBarrier : ''} stake ${amount} -> contract ${contractId} (${acct.isVirtual ? 'demo' : 'REAL'} ${acct.loginid})`);

    // Subscribe to the open contract until it is finally sold/settled.
    const finalContract = await new Promise((resolve, reject) => {
      const reqId = nextReq();
      let done = false, subId = null;

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      const finish = (value, error) => {
        if (done) return;
        done = true;
        cleanup();
        if (subId) { try { ws.send(JSON.stringify({ forget: subId })); } catch (_) {} }   // free the stream on the shared socket
        error ? reject(error) : resolve(value);
      };

      const onMessage = (raw) => {
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }

        if (data.error) {
          finish(null, new Error(data.error.message || 'Deriv contract error.'));
          return;
        }

        if (
          data.msg_type !== 'proposal_open_contract' ||
          data.req_id !== reqId
        ) return;

        const contract = data.proposal_open_contract || {};
        if (data.subscription && data.subscription.id) subId = data.subscription.id;

        if (contract.is_sold || ['sold', 'expired', 'cancelled'].includes(String(contract.status || '').toLowerCase())) {
          finish(contract);
        }
      };

      const onError = (err) => finish(null, err instanceof Error ? err : new Error(String(err)));
      const onClose = () => {
        if (!done) finish(null, new Error('Deriv WebSocket closed before settlement.'));
      };

      const timer = setTimeout(() => {
        finish(null, new Error('Timed out waiting for contract settlement.'));
      }, 120000);

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);

      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
        req_id: reqId
      }), (err) => {
        if (err) finish(null, err);
      });
    });

    const profit = Number(finalContract.profit);
    const payout = Number(finalContract.payout);
    // If Deriv gave no usable profit figure, assume the stake was lost (safe side).
    recordResult(risk, Number.isFinite(profit) ? profit : -amount);
    recorded = true;

    res.json({
      isVirtual: acct.isVirtual,
      loginid: acct.loginid,
      contractId,
      buyPrice: Number(bought.buy_price ?? askPrice),
      payout: Number.isFinite(payout) ? payout : null,
      profit: Number.isFinite(profit) ? profit : 0,
      isWin: Number.isFinite(profit) ? profit > 0 : false,
      sellPrice: Number(finalContract.sell_price ?? finalContract.exit_spot ?? finalContract.current_spot ?? NaN),
      status: finalContract.status || null,
      risk: riskSnapshot(risk)
    });
  } catch (err) {
    console.error('Deriv trade error:', err.message);
    let message = err.message || 'Trade failed on Deriv.';
    if (boughtContract && !recorded) {
      // Money was spent but we could not confirm the result: count it as a loss.
      recordResult(risk, -amount);
      recorded = true;
      message += ` (Contract ${boughtContract} was bought but not confirmed settled; counted as a loss of the stake for safety.)`;
    }
    if (ws && !err.derivCode) dropPooled(acct);      // timeout / closed socket: next trade opens a fresh one
    res.status(502).json({
      error: message,
      derivCode: err.derivCode || null,
      risk: riskSnapshot(risk)
    });
  } finally {
    risk.inFlight = false;
  }
});

// -----------------------------------------------------------------------------
// AI Analysis
// -----------------------------------------------------------------------------

const analyzeLimiter = { lastCall: 0 };

app.post('/api/analyze', async (req, res) => {
  const now = Date.now();
  if (now - analyzeLimiter.lastCall < 4000) {
    return res.status(429).json({
      error: 'Please wait a few seconds between analyses.'
    });
  }
  analyzeLimiter.lastCall = now;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({
      fallback: true,
      trend: 'UNAVAILABLE',
      momentum: 'N/A',
      risk: 'N/A',
      summary: 'AI Analysis is not connected yet. Set ANTHROPIC_API_KEY in your Render environment variables to enable live analysis.'
    });
  }

  const { markets } = req.body || {};
  if (!markets || typeof markets !== 'object') {
    return res.status(400).json({ error: 'Missing market data.' });
  }

  try {
    const prompt = `You are a market-structure analyst for a DEMO trading dashboard (no real trades, synthetic indices only).
Given this recent tick data (JSON, most recent price last), respond with ONLY a JSON object, no prose, no markdown fences, in this exact shape:
{"trend":"UPTREND|DOWNTREND|RANGE","momentum":"Weak|Moderate|Strong","risk":"Low|Medium|High","score":<0-100 integer>,"summary":"<one or two plain sentences, no financial advice, demo context>"}

Tick data:
${JSON.stringify(markets)}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({
        error: 'AI analysis service returned an error.'
      });
    }

    const data = await apiRes.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse AI response as JSON:', raw);
      return res.status(502).json({
        error: 'AI analysis returned an unexpected format.'
      });
    }

    res.json({ fallback: false, ...parsed });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// -----------------------------------------------------------------------------
// Strategies (demo, per-session)
// -----------------------------------------------------------------------------

app.get('/api/strategies', (req, res) => {
  res.json({ strategies: req.session.strategies || [] });
});

app.post('/api/strategies', (req, res) => {
  const s = req.body;

  if (!s || !s.symbol || !s.direction || !s.stake) {
    return res.status(400).json({
      error: 'Strategy needs symbol, direction and stake.'
    });
  }

  if (!req.session.strategies) req.session.strategies = [];

  const strategy = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    symbol: String(s.symbol).slice(0, 40),
    direction: s.direction === 'FALL' ? 'FALL' : 'RISE',
    stake: Math.max(1, Math.min(5000, Number(s.stake) || 10)),
    takeProfit: Math.max(0, Math.min(100, Number(s.takeProfit) || 0)),
    stopLoss: Math.max(0, Math.min(100, Number(s.stopLoss) || 0)),
    execution: s.execution === 'deriv' ? 'deriv' : 'simulated',
    createdAt: new Date().toISOString()
  };

  req.session.strategies.push(strategy);
  res.json({ strategy });
});

app.delete('/api/strategies/:id', (req, res) => {
  if (!req.session.strategies) req.session.strategies = [];
  req.session.strategies = req.session.strategies.filter(
    s => s.id !== req.params.id
  );
  res.json({ ok: true });
});

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OGILA TRADERS running on port ${PORT}`);
});
