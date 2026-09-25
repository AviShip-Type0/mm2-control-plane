// settlement.js — timing, netting and rail selection (the "Timing" and "Rail" decisions), plus the cost model.
// Rail facts below are illustrative but shaped like Nium's documented rail table (Faster Payments ≤ £1M then CHAPS,
// Interac ≤ CAD 25,000 then EFT, FAST ≤ SGD 200,000, Pix/SPEI/UPI 24/7, USDC on-chain, card balance load).
// Production: the rail catalogue is Nium's supported-corridors + rail-preference service; costs come from the fee engine.

import { money, convert, mulBps, round, FX } from './money.js';

/** Rail catalogue. fees in USD-equivalent for display; caps in rail currency. */
export const RAILS = {
  pix:          { id: 'pix', name: 'Pix (real-time)', ccy: 'BRL', country: 'BR', always: true, feeUsd: 0.20, etaSec: 10 },
  ted:          { id: 'ted', name: 'TED (same day, cut-off 15:00 BRT)', ccy: 'BRL', country: 'BR', always: false, feeUsd: 0.60, etaSec: 3600 },
  spei:         { id: 'spei', name: 'SPEI (real-time)', ccy: 'MXN', country: 'MX', always: true, feeUsd: 0.15, etaSec: 20 },
  upi:          { id: 'upi', name: 'UPI / IMPS (real-time)', ccy: 'INR', country: 'IN', always: true, feeUsd: 0.06, etaSec: 15, maxAmount: 200000 },
  neft:         { id: 'neft', name: 'NEFT (batch)', ccy: 'INR', country: 'IN', always: false, feeUsd: 0.06, etaSec: 7200 },
  instapay:     { id: 'instapay', name: 'InstaPay (real-time)', ccy: 'PHP', country: 'PH', always: true, feeUsd: 0.50, etaSec: 60, maxAmount: 50000 },
  pesonet:      { id: 'pesonet', name: 'PESONet (same-day batch)', ccy: 'PHP', country: 'PH', always: false, feeUsd: 0.50, etaSec: 14400 },
  gcash:        { id: 'gcash', name: 'GCash wallet', ccy: 'PHP', country: 'PH', always: true, feeUsd: 0.50, etaSec: 60, maxAmount: 100000, wallet: true },
  fps_uk:       { id: 'fps_uk', name: 'Faster Payments (24/7)', ccy: 'GBP', country: 'GB', always: true, feeUsd: 0.00, etaSec: 240, maxAmount: 1000000 },
  chaps:        { id: 'chaps', name: 'CHAPS (cut-off 15:30 GMT)', ccy: 'GBP', country: 'GB', always: false, feeUsd: 25.00, etaSec: 7200 },
  sepa_inst:    { id: 'sepa_inst', name: 'SEPA Instant (24/7)', ccy: 'EUR', country: 'EU', always: true, feeUsd: 0.20, etaSec: 10 },
  interac:      { id: 'interac', name: 'Interac e-Transfer (autodeposit)', ccy: 'CAD', country: 'CA', always: true, feeUsd: 0.35, etaSec: 120, maxAmount: 25000 },
  eft_ca:       { id: 'eft_ca', name: 'EFT (same day, cut-off 18:00 ET)', ccy: 'CAD', country: 'CA', always: false, feeUsd: 0.30, etaSec: 14400 },
  fast_sg:      { id: 'fast_sg', name: 'FAST (24/7)', ccy: 'SGD', country: 'SG', always: true, feeUsd: 0.10, etaSec: 10, maxAmount: 200000 },
  rtp_us:       { id: 'rtp_us', name: 'RTP / FedNow (24/7)', ccy: 'USD', country: 'US', always: true, feeUsd: 0.05, etaSec: 15, maxAmount: 10000000 },
  ach_us:       { id: 'ach_us', name: 'ACH (same day, cut-off 15:15 ET)', ccy: 'USD', country: 'US', always: false, feeUsd: 0.25, etaSec: 14400 },
  usdc_polygon: { id: 'usdc_polygon', name: 'USDC on Polygon', ccy: 'USDC', country: '*', always: true, feeUsd: 0.01, etaSec: 30 },
  usdc_base:    { id: 'usdc_base', name: 'USDC on Base', ccy: 'USDC', country: '*', always: true, feeUsd: 0.01, etaSec: 30 },
  card_load:    { id: 'card_load', name: 'Nium card balance load', ccy: 'USD', country: '*', always: true, feeUsd: 0.00, etaSec: 1 },
};

/** Beneficiary payout choices map to a preferred rail family. */
export const CHOICE_TO_RAILS = {
  'local': null, // resolved from beneficiary currency/country
  'usdc': ['usdc_polygon', 'usdc_base'],
  'card': ['card_load'],
};

export function isWeekendOrNight(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day === 0 || day === 6 || h < 6 || h >= 22;
}

/**
 * Select a rail. Order of precedence: beneficiary choice (if policy allows) → policy.allowed ∩ partner.rails →
 * currency/country match → amount cap → policy.preference (REALTIME first, LOWCOST cheapest).
 */
export function selectRail({ policy, partner, beneficiary, amount, choice, when }) {
  const allowed = new Set(policy.rail.allowed);
  const partnerRails = partner?.rails && !partner.rails.includes('*') ? new Set(partner.rails) : null;
  let candidates = Object.values(RAILS).filter(r => allowed.has(r.id) && (!partnerRails || partnerRails.has(r.id)));
  const ch = (choice || 'local').toLowerCase();
  if (ch !== 'local' && policy.rail.beneficiaryChoice) {
    const fam = CHOICE_TO_RAILS[ch] || [];
    candidates = candidates.filter(r => fam.includes(r.id));
  } else {
    candidates = candidates.filter(r => r.ccy === beneficiary.currency && (r.country === beneficiary.country || r.country === '*' || (r.country === 'EU' && beneficiary.sepa)));
  }
  // amount cap in rail currency
  const railAmount = (r) => r.ccy === amount.ccy ? amount.value : convert(amount, r.ccy).out.value;
  const overCap = candidates.filter(r => r.maxAmount != null && railAmount(r) > r.maxAmount).map(r => r.id);
  candidates = candidates.filter(r => !overCap.includes(r.id));
  if (isWeekendOrNight(when)) candidates = candidates.filter(r => r.always);
  if (!candidates.length) return { rail: null, reason: overCap.length ? `amount exceeds cap on ${overCap.join(', ')}` : 'no rail clears policy, partner, currency and time-window constraints', overCap };
  const pref = policy.rail.preference || 'REALTIME';
  if (beneficiary.preferWallet && candidates.some(r => r.wallet)) candidates = candidates.filter(r => r.wallet);
  else candidates = candidates.filter(r => !r.wallet).length ? candidates.filter(r => !r.wallet) : candidates;
  candidates.sort((a, b) => pref === 'LOWCOST' ? (a.feeUsd - b.feeUsd) || (a.etaSec - b.etaSec) : (a.etaSec - b.etaSec) || (a.feeUsd - b.feeUsd));
  return { rail: candidates[0], overCap };
}

/** Cost model. Returns line items (label, amount string) and the beneficiary net amount in rail currency. */
export function priceRoute({ policy, partner, rail, amount, conversionApplies, legs = 1, sourceLocal = null }) {
  const p = policy.pricing || {};
  const lines = [];
  let usd = money(amount.value, 'USD'); // amounts are USD-denominated at this point unless already local
  let conversion = money(0, 'USD');
  // Every line carries the decision that spent it (source · entity · timing · rail · policy): cost is attributed, never blended.
  if (conversionApplies && p.conversionBps) { conversion = mulBps(usd, p.conversionBps); lines.push([`Conversion ${p.conversionBps} bps (custodian)`, conversion, 'source']); }
  if (rail && rail.ccy === 'USDC' && p.onchainBps) { const c2 = mulBps(usd, p.onchainBps); conversion = money(conversion.value + c2.value, 'USD'); lines.push([`On-ramp conversion ${p.onchainBps} bps`, c2, 'rail']); }
  const sameCcy = sourceLocal && rail && sourceLocal.ccy === rail.ccy && rail.ccy !== 'USD' && rail.ccy !== 'USDC';
  const feeBps = (p.feeBps || 0) + (partner?.feeBps || 0);
  let fee = money(0, 'USD');
  if (feeBps) { fee = mulBps(usd, feeBps); lines.push([`Risk-priced payout fee ${feeBps} bps`, fee, 'entity']); }
  const reserveBps = p.reserveBps ?? partner?.reserveBps ?? 0;
  let reserve = money(0, 'USD');
  if (reserveBps) { reserve = mulBps(usd, reserveBps); lines.push([`Rolling reserve ${reserveBps / 100}% (released T+${p.reserveReleaseDays || partner?.reserveReleaseDays || 30})`, reserve, 'entity']); }
  const railFee = money((rail?.feeUsd || 0) * legs, 'USD');
  lines.push([`${rail?.name || 'rail'} fee${legs > 1 ? ` · ${legs} legs` : ''}`, railFee, legs > 1 ? 'timing' : 'rail']);
  const chargeTo = p.chargeTo || 'BENEFICIARY';
  // FX at the net: beneficiary receives (usd - conversion - fee - reserve) converted with spread, less rail fee in rail ccy
  const afterConv = money(chargeTo === 'SENDER' ? usd.value : usd.value - conversion.value - fee.value - reserve.value, 'USD');
  let out, spread = money(0, 'USD'), rate = 1;
  if (sameCcy) {
    // no FX: fee stack priced in USD-equivalent, settled in the source currency
    const localFee = round((fee.value + reserve.value + conversion.value + railFee.value) * FX[rail.ccy], 2);
    out = money(chargeTo === 'SENDER' ? sourceLocal.value : sourceLocal.value - localFee, rail.ccy);
    rate = 1;
    if (chargeTo === 'SENDER') lines.push(['Charged to sender (on top, incl. reserve)', money(localFee, rail.ccy), 'policy']);
  } else if (rail && rail.ccy !== 'USD' && rail.ccy !== 'USDC') {
    const c = convert(afterConv, rail.ccy, p.fxSpreadBps || 0);
    out = c.out; spread = c.spread; rate = c.rate;
    if (p.fxSpreadBps) lines.splice(conversionApplies && p.conversionBps ? 1 : 0, 0, [`FX spread ${p.fxSpreadBps / 100}% (at the net)`, spread, 'rail']);
    const railFeeLocal = round(railFee.value * FX[rail.ccy], 2);
    out = money(out.value - railFeeLocal, rail.ccy);
  } else {
    out = money(chargeTo === 'SENDER' ? afterConv.value : afterConv.value - railFee.value, rail?.ccy === 'USDC' ? 'USDC' : 'USD');
  }
  const totalCostUsd = money(conversion.value + fee.value + spread.value + railFee.value, 'USD'); // reserve excluded: it is returned, not charged
  const uneconomic = usd.value > 0 && railFee.value > usd.value * 0.25; // rail fees > 25% of value
  return { lines, out, rate, fee, reserve, conversion, spread, railFee, totalCostUsd, uneconomic, chargeTo, allInBps: usd.value ? round(totalCostUsd.value / usd.value * 10000, 1) : 0 };
}

/** Netting window: accumulate receipts per beneficiary/currency; close by time or threshold. */
export class NettingWindow {
  constructor({ key, windowHours = 24, thresholdUsd = null, openedAt }) { this.key = key; this.windowHours = windowHours; this.thresholdUsd = thresholdUsd; this.openedAt = openedAt ? new Date(openedAt) : new Date(); this.receipts = []; }
  add(receipt) { this.receipts.push(receipt); return this; }
  totalUsd() { return round(this.receipts.reduce((s, r) => s + r.amountUsd, 0), 2); }
  shouldClose(now = new Date()) {
    const elapsed = (new Date(now) - this.openedAt) / 36e5;
    return elapsed >= this.windowHours || (this.thresholdUsd != null && this.totalUsd() >= this.thresholdUsd);
  }
  /** Close: one net payout per window, or ceil(total/threshold) payouts when a threshold closes the window early
   *  (the remainder below the threshold pays at the window's end). */
  close() {
    const total = this.totalUsd();
    if (this.thresholdUsd != null && this.thresholdUsd > 0) {
      const legs = Math.max(1, Math.ceil(total / this.thresholdUsd));
      return { totalUsd: total, legs, receipts: this.receipts.length };
    }
    return { totalUsd: total, legs: 1, receipts: this.receipts.length };
  }
}

export function etaText(sec) {
  if (sec == null) return '—';
  if (sec <= 1) return 'instant';
  if (sec < 60) return `≈ ${sec} seconds`;
  if (sec < 3600) return `≈ ${Math.round(sec / 60)} minutes`;
  return `≈ ${Math.round(sec / 3600)} hours`;
}
