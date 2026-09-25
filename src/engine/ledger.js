// ledger.js — a small double-entry ledger with per-currency balancing.
// Cross-currency movements balance through an FX position account per pair (the treasury's book), so every
// posting set balances in every currency it touches. This is reference semantics only: production posts to the
// wallet ledger Nium already runs, and nothing here prescribes how balances are kept.

export class Ledger {
  constructor() { this.entries = []; }
  /** @param {{account:string, debit?:number, credit?:number, ccy:string, memo?:string}} e */
  post(e) {
    if (!e.account || !e.ccy) throw new Error('account and ccy required');
    const debit = +(e.debit || 0), credit = +(e.credit || 0);
    if (debit < 0 || credit < 0) throw new Error('negative posting');
    this.entries.push({ account: e.account, debit, credit, ccy: e.ccy, memo: e.memo || '' });
    return this;
  }
  /** Post a balanced pair in one currency. */
  transfer(from, to, amount, ccy, memo) { return this.post({ account: from, debit: amount, ccy, memo }).post({ account: to, credit: amount, ccy, memo }); }
  totals() {
    const t = {};
    for (const e of this.entries) { t[e.ccy] ??= { debit: 0, credit: 0 }; t[e.ccy].debit += e.debit; t[e.ccy].credit += e.credit; }
    return t;
  }
  isBalanced(eps = 0.005) { return Object.values(this.totals()).every(t => Math.abs(t.debit - t.credit) < eps); }
  balance(account, ccy) { return this.entries.filter(e => e.account === account && e.ccy === ccy).reduce((s, e) => s + e.credit - e.debit, 0); }
  rows() { return this.entries.map(e => ({ account: e.account, debit: e.debit ? `${e.debit.toFixed(2)} ${e.ccy}` : '', credit: e.credit ? `${e.credit.toFixed(2)} ${e.ccy}` : '', memo: e.memo })); }
}
