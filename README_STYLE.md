# Prince Gila DigitTrade Bot — neon dashboard style build

This build restyles the frontend to closely follow the supplied reference: navy/black background, cyan panel borders, neon green controls, compact scanner table, strategy cards, trading controls, performance panels, and two floating monitors.

## Run
- Keep `public/index.html`, `public/style.css`, and `public/script.js` together.
- Install Node.js dependencies with `npm install`.
- Start with `npm start` and open the host URL.
- The Node server and Deriv backend files are retained from the previous project build.

## Important limits
- This frontend includes interactive display controls, sample scanner rows, stake conversion display, floating monitor minimize buttons, and demo Start/Stop UI.
- The displayed market frequencies are illustrative until live market data is connected. The Start/Stop control does not place real trades.
- Digit scanner contract purchases are not implemented/verified. Existing Deriv backend purchase path is Rise/Fall only.
- Do not use sample balances or performance numbers as real results. Test in demo mode first.
- Set OAuth/session environment variables privately on the server; never commit `.env`.
