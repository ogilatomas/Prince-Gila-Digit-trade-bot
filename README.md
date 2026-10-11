# Prince Gila 👑 DigitTrade Bot

A Node.js + Express trading dashboard with a browser UI, public Deriv market tick display, two floating digit monitors, strategy builder, local simulated trading, and an optional Deriv OAuth connection.

## Important capability boundaries

- **Run Demo Bot** runs the saved strategy in local simulation mode when its execution is set to `Simulated`.
- The existing authenticated Deriv purchase route is for **Rise/Fall (CALL/PUT), 5 ticks** only. It is not the digit contract purchase engine.
- The 1,000-tick original digit signal engine and independent 500-tick UNDER3/UNDER4/OVER6/OVER7 scanner are **signal-only**. Their UI checkboxes do not place digit contracts.
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
