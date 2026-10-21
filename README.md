# Prince Gila 👑 DigitTrade Bot — v2.0

## What's new in v2.0
- **Independent strategies.** Over/Under, Differs, Even/Odd, Matches/Equals, Hot/Cold, UNDER3, UNDER4, OVER6 and OVER7 each have their own signals, cooldown, run state and win/loss tally (`public/strategy-logic.js`, `public/strategies.js`). **Smart Strategy is unchanged.**
- **Auto-buy on every strategy.** Starting a strategy turns its auto-buy on; the old "Auto-buy" checkboxes are gone.
- **Instant stop.** Stop ends new entries at once: queued trades are cancelled and the server refuses any request still carrying the stopped run id (`POST /api/bot/stop`). A contract Deriv has already accepted cannot be recalled and settles normally.
- **Two control groups** (Strategy Control Center): ① tick *Activate all strategies*, then Start All / Stop All; ② pick one strategy, then Start Selected / Stop Selected.
- **Over/Under win → Differs rule** (`public/core.js`). After any OVER/UNDER contract wins (Smart Strategy, standalone Over/Under, UNDER3/4, OVER6/7), the next trade is one Differs contract (same stake and ticks, barrier = most frequent digit per the Differs rule), then the bot returns to Over/Under. While it is pending, no new Over/Under entry jumps ahead. Can be turned off with the checkbox. To use the least frequent digit instead, set `DIFFERS_BARRIER: 'least_frequent'` in `core.js`.
- **Volatility Markets** option (Smart Strategy market filter and Control Center market list) and **1 tick** is the default ticks per trade.
- **Giant Bot Profile** card for this build (status, balance, session P/L, win rate, streak, per-strategy tally, latest trades).
- Hot/Cold now trades: DIFFERS on the coldest persistent digit, otherwise MATCHES on the hottest.
- Run `npm test` for the logic tests (switch rule, stop behaviour, strategy definitions).

Trading can lose money. Test on a Deriv **demo** account first.

---


A Node.js + Express trading dashboard with a browser UI, public Deriv market tick display, two floating digit monitors, strategy builder, local simulated trading, and an optional Deriv OAuth connection.

## Important capability boundaries

- **Run Demo Bot** runs the saved strategy in local simulation mode when its execution is set to `Simulated`.
- The existing authenticated Deriv purchase route is for **Rise/Fall (CALL/PUT), 5 ticks** only. It is not the digit contract purchase engine.
- The original and 500-tick major strategies auto-buy digit contracts only while started from the Strategy Control Center (v2.0).
- Never treat displayed sample figures or digit frequencies as a prediction or guarantee. Keep execution simulated until you have personally tested every behavior.
- The dashboard includes illustrative/demo UI elements. Do not assume an indicator means a live account is connected or an order was accepted; check the Deriv account and trade history.

## Run locally

Requirements: Node.js 18 or newer and npm.

1. Extract this ZIP.
2. In the extracted folder, run `npm install`.
3. Copy `.env.example` to `.env` and set a unique random `SESSION_SECRET`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

The Express server serves the web UI from `public/`; keep `public/index.html`, `public/style.css`, and `public/script.js` together. Root copies are retained for convenience but the server uses `public/`.

## GitHub / hosting

1. Upload the contents of this ZIP to the root of a private GitHub repository. The `public/` folder must be preserved.
2. Deploy the repository to a Node.js host such as Render.
3. Build command: `npm install`; start command: `npm start`.
4. Configure environment variables in the host dashboard, not in committed files.
5. Set `NODE_ENV=production`, `SESSION_SECRET` to a strong random value, and configure the exact Deriv OAuth callback URL if enabling account connection.
6. Do not deploy the server code to GitHub Pages: Pages cannot run Node.js or protect server-side secrets.

## Optional Deriv OAuth setup

1. Register a Deriv application and set its redirect URL to `https://YOUR-DOMAIN/auth/deriv/callback`.
2. Set `DERIV_CLIENT_ID` to the registered application ID and `DERIV_REDIRECT_URI` to that exact URL on the hosting provider.
3. Deploy and test account connection with a **virtual/demo account** first.
4. Do not share tokens or commit `.env`. The application should be security-reviewed and risk controls independently tested before real-money use.

## Files

- `public/index.html`, `public/style.css`, `public/script.js`: browser UI (served by Express).
- Root `index.html`, `style.css`, `script.js`: convenient copies of the UI files.
- `server.js`: Node.js/Express API and OAuth/trade endpoints.
- `server-fixed.js`: retained alternate copy; start command uses `server.js`.
- `deriv-client.js`: helper client module.
- `package.json`: dependencies and start script.
- `FREQUENCY_GUARD_README.md`: floating monitor notes.
- `.env.example`: names of optional environment settings, with blank secrets.

## Risk notes

Trading can lose money. No strategy guarantees profits. The digit scanner is not wired to purchase digit contracts; the current Deriv trade endpoint supports Rise/Fall only. Stop-loss/target-profit settings in a strategy should not be treated as a substitute for independently verified server-side safeguards. Do not enable real-money trading until contract semantics, stake/payout checks, duplicate prevention, settlement handling, session persistence, and loss limits have been audited and tested.


## Smart Strategy automatic digit purchases
- Smart Strategy has independent Start/Stop controls. Starting it enables automatic digit-contract purchase attempts for qualifying signals.
- Auto digit purchases are restricted server-side to an authenticated Deriv virtual/demo account. A connected account with trade authorization is required.
- Set Stake per Trade and Max Stake before starting. The server also enforces MAX_TRADE_STAKE (default 100 account-currency units).
- This is experimental software. Verify Deriv API support, symbol digit precision and contract availability in demo mode before relying on it. Market scanning subscribes to up to 80 eligible symbols per session; API availability/rate limits may reduce that number.
- A signal is not a prediction or guarantee of profit. Stop the strategy to stop further entries. A contract already purchased will continue to settle at Deriv.

## Manual Trading
Open **Manual Trading** from the sidebar (or visit `/manual/`) for the live tick chart with manual Matches/Differs, Even/Odd, Over/Under, Rise/Fall, Higher/Lower and Touch/No Touch trades (demo balance). Built files live in `public/manual/`; editable source is in `manual-trading-src/`.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. On render.com: New → Web Service → pick the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add env var `SESSION_SECRET` (any long random text) plus any from `.env.example` you use.
