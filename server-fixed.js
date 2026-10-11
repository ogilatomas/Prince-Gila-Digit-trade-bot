const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DERIV_API_BASE = 'https://api.derivws.com';
const DERIV_AUTH_BASE = 'https://auth.deriv.com';
const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

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

      if (data.error) {
        cleanup();
        reject(new Error(data.error.message || 'Deriv WebSocket error.'));
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

app.get('/api/deriv/balance', async (req, res) => {
  const acct = getActiveAccount(req);
  const accessToken = getAccessToken(req);

  if (!acct || !accessToken) {
    return res.status(401).json({ error: 'No active Deriv account.' });
  }

  let ws;
  try {
    const wsUrl = await getAuthenticatedWsUrl(accessToken, acct.accountId);
    ws = await openDerivSocket(wsUrl);

    const data = await wsRequest(ws, {
      balance: 1
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
    res.status(502).json({
      error: err.message || 'Could not fetch balance from Deriv.'
    });
  } finally {
    closeSocket(ws);
  }
});

// -----------------------------------------------------------------------------
// Real/demo trading through the New API.
// RISE -> CALL, FALL -> PUT.
// -----------------------------------------------------------------------------

app.post('/api/deriv/trade', async (req, res) => {
  const acct = getActiveAccount(req);
  const accessToken = getAccessToken(req);

  if (!acct || !accessToken) {
    return res.status(401).json({ error: 'No active Deriv account.' });
  }

  const { symbol, direction, stake } = req.body || {};
  const amount = Number(stake);

  if (
    !symbol ||
    !['RISE', 'FALL'].includes(direction) ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return res.status(400).json({ error: 'Invalid trade request.' });
  }

  // Server-side safety ceiling. This is a code-level limit, not a profitability guarantee.
  const maxStake = Number(process.env.MAX_TRADE_STAKE || 100);
  if (amount > maxStake) {
    return res.status(400).json({
      error: `Stake exceeds the server limit of ${maxStake}.`
    });
  }

  let ws;

  try {
    const wsUrl = await getAuthenticatedWsUrl(accessToken, acct.accountId);
    ws = await openDerivSocket(wsUrl);

    const contractType = direction === 'RISE' ? 'CALL' : 'PUT';

    const proposalResponse = await wsRequest(ws, {
      proposal: 1,
      amount,
      basis: 'stake',
      contract_type: contractType,
      currency: acct.currency,
      duration_unit: 't',
      duration: 5,
      underlying_symbol: String(symbol),
      req_id: Date.now() % 1000000000
    }, {
      predicate: msg => msg.msg_type === 'proposal'
    });

    const proposal = proposalResponse.proposal || {};
    const proposalId = proposal.id;
    const askPrice = Number(proposal.ask_price);

    if (!proposalId || !Number.isFinite(askPrice)) {
      throw new Error('Deriv returned an incomplete trade proposal.');
    }

    const buyResponse = await wsRequest(ws, {
      buy: String(proposalId),
      price: askPrice,
      req_id: Date.now() % 1000000000
    }, {
      predicate: msg => msg.msg_type === 'buy'
    });

    const bought = buyResponse.buy || {};
    const contractId = bought.contract_id;

    if (!contractId) {
      throw new Error('Deriv did not return a contract ID after purchase.');
    }

    // Subscribe to the open contract until it is finally sold/settled.
    const finalContract = await new Promise((resolve, reject) => {
      const reqId = Date.now() % 1000000000;
      let done = false;

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

    res.json({
      isVirtual: acct.isVirtual,
      loginid: acct.loginid,
      contractId,
      buyPrice: Number(bought.buy_price ?? askPrice),
      payout: Number.isFinite(payout) ? payout : null,
      profit: Number.isFinite(profit) ? profit : 0,
      isWin: Number.isFinite(profit) ? profit > 0 : false,
      sellPrice: Number(finalContract.sell_price ?? finalContract.exit_spot ?? finalContract.current_spot ?? NaN),
      status: finalContract.status || null
    });
  } catch (err) {
    console.error('Deriv trade error:', err.message);
    res.status(502).json({
      error: err.message || 'Trade failed on Deriv.'
    });
  } finally {
    closeSocket(ws);
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
    stake: Math.max(1, Math.min(1000, Number(s.stake) || 10)),
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
