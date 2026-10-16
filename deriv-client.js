const WebSocket = require('ws');

const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=';

/**
 * One short-lived authenticated session against the Deriv API.
 * Opens a socket, authorizes with the account's token, lets the caller
 * make a handful of requests, then must be closed. Not pooled — kept
 * simple and safe for a low-traffic demo deployment.
 */
class DerivSession {
  constructor(appId) {
    this.appId = appId;
    this.ws = null;
    this.reqId = 1;
    this.pending = new Map(); // req_id -> {resolve, reject}
    this.subscriptions = new Map(); // subscription id (contract_id) -> callback
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(DERIV_WS_URL + encodeURIComponent(this.appId));
      const timeout = setTimeout(() => reject(new Error('Deriv connection timed out')), 10000);

      this.ws.on('open', () => { clearTimeout(timeout); resolve(); });
      this.ws.on('error', (err) => { clearTimeout(timeout); reject(err); });

      this.ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch (e) { return; }

        // Ongoing contract updates (proposal_open_contract subscriptions)
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
          const cid = data.proposal_open_contract.contract_id;
          const cb = this.subscriptions.get(cid);
          if (cb) cb(data.proposal_open_contract);
        }

        if (data.req_id && this.pending.has(data.req_id)) {
          const { resolve: res, reject: rej } = this.pending.get(data.req_id);
          this.pending.delete(data.req_id);
          if (data.error) rej(new Error(data.error.message || 'Deriv API error'));
          else res(data);
        }
      });
    });
  }

  request(payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const req_id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('Deriv API request timed out'));
      }, timeoutMs);

      this.pending.set(req_id, {
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  async authorize(token) {
    const res = await this.request({ authorize: token });
    return res.authorize; // { loginid, currency, is_virtual, balance, ... }
  }

  async balance() {
    const res = await this.request({ balance: 1 });
    return res.balance; // { balance, currency, loginid }
  }

  /** Places a real (or virtual, depending on the authorized account) rise/fall contract. */
  async buyRiseFall({ symbol, direction, stake, duration = 5, durationUnit = 't', currency }) {
    const proposalRes = await this.request({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: direction === 'RISE' ? 'CALL' : 'PUT',
      currency,
      duration,
      duration_unit: durationUnit,
      symbol
    });
    const proposal = proposalRes.proposal;
    if (!proposal || !proposal.id) throw new Error('No tradable proposal returned for this market.');

    const buyRes = await this.request({ buy: proposal.id, price: proposal.ask_price });
    const buy = buyRes.buy;
    if (!buy || !buy.contract_id) throw new Error('Trade was not confirmed by Deriv.');

    return {
      contractId: buy.contract_id,
      buyPrice: buy.buy_price,
      payout: buy.payout,
      longcode: buy.longcode
    };
  }

  /** Waits for a bought contract to settle and returns the final profit/loss. */
  waitForSettlement(contractId, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subscriptions.delete(contractId);
        reject(new Error('Timed out waiting for the contract to settle.'));
      }, timeoutMs);

      this.subscriptions.set(contractId, (contract) => {
        if (contract.is_sold) {
          clearTimeout(timer);
          this.subscriptions.delete(contractId);
          resolve({
            isWin: Number(contract.profit) > 0,
            profit: Number(contract.profit),
            sellPrice: Number(contract.sell_price),
            exitTick: contract.exit_tick
          });
        }
      });

      this.request({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).catch((err) => {
        clearTimeout(timer);
        this.subscriptions.delete(contractId);
        reject(err);
      });
    });
  }

  close() {
    try { this.ws && this.ws.close(); } catch (e) { /* noop */ }
  }
}

module.exports = { DerivSession };
