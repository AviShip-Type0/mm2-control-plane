// controlplane.js — the orchestrator. One call: evaluate(intent) → trace.
// Order of operations mirrors the five decisions: Source → Evidence → Entity (router) → Timing → Rail → price → ledger.
// Once the entity and timing are known the trace records the perimeter the payout ran inside; every cost line is
// attributed to the decision that spent it; and any later event (reserve release, netting close, event trigger,
// re-check, manual review) is registered as a follow-on that cites this trace.
// Outcome precedence: evidence DECLINE > no eligible partner > ticket above max (HELD) > evidence HOLD >
// awaiting event (HELD) > netting queued (QUEUED) > no rail (DECLINED) > uneconomic route (HELD) > APPROVED.

import { money, convert, fmt, FX, round } from './money.js';
import { validatePolicy, get } from './policy.js';
import { evaluateEvidence, gate } from './evidence.js';
import { route } from './router.js';
import { Ledger } from './ledger.js';
import { selectRail, priceRoute, NettingWindow, etaText, isWeekendOrNight, RAILS, CHOICE_TO_RAILS } from './settlement.js';
import { createTrace, decide, finish, followOn } from './trace.js';
import { derivePerimeter } from './perimeter.js';

export class ControlPlane {
  /** @param {{policies:object[], partners:object[]}} cfg */
  constructor({ policies, partners }) {
    for (const p of policies) { const errs = validatePolicy(p); if (errs.length) throw new Error(`policy ${p.id}: ${errs.join('; ')}`); }
    this.policies = policies;
    this.partners = partners;
    this.traces = new Map();
  }

  policyFor(intent) {
    const p = this.policies.filter(x => x.flow === intent.flow).sort((a, b) => b.version - a.version)[0];
    if (!p) throw new Error(`no policy for flow '${intent.flow}'`);
    return p;
  }

  /** @param {object} intent @param {{now?:string|Date}} opts */
  evaluate(intent, opts = {}) {
    const now = opts.now || intent.requestedAt || new Date().toISOString();
    const policy = this.policyFor(intent);
    const t = createTrace(intent, policy, now);
    const ledger = new Ledger();

    // ---- 1. SOURCE -------------------------------------------------------------------------------
    const asset = intent.source.asset;
    if (!policy.source.allowedAssets.includes(asset)) {
      decide(t, 'source', `${asset} is not an allowed source asset for this policy`);
      return this._store(finish(t, 'DECLINED', 'SOURCE_ASSET_NOT_ALLOWED', `Policy ${policy.id} accepts ${policy.source.allowedAssets.join(', ')}.`));
    }
    const amt = money(intent.amount.value, intent.amount.ccy);
    const amountUsd = (amt.ccy === 'USD' || amt.ccy === 'USDC') ? money(amt.value, 'USD') : convert(amt, 'USD').out;
    intent.amountUsd = amountUsd.value;
    const conversionApplies = asset === 'USDC' && policy.source.conversion === 'JIT';
    let sourceText = intent.source.description ? intent.source.description : `${fmt(amt)} from ${intent.source.account}`;
    if (conversionApplies) sourceText += ` → converted just-in-time via ${intent.source.custodian || 'regulated custodian'} → ${fmt(amountUsd)} credited`;
    if (intent.context?.split) {
      const s = intent.context.split;
      const fee = money(amountUsd.value * s.feeBps / 10000, 'USD');
      const net = money(amountUsd.value - fee.value, 'USD');
      sourceText += `\nSplit: ${s.feeBps / 100}% platform fee ${fmt(fee)} → ${s.feesAccount} · ${fmt(net)} → ${s.sellerAccount}`;
      intent._split = { fee, net };
    }
    if (intent.context?.netting) sourceText += `\n${intent.context.netting.receipts.toLocaleString()} receipts streamed on-chain over ${intent.context.netting.windowHours}h → ${fmt(amountUsd)} in facilitator escrow`;
    if (intent.source.note) sourceText += `\n${intent.source.note}`;
    decide(t, 'source', sourceText);

    // ---- 2. EVIDENCE -----------------------------------------------------------------------------
    t.evidence = evaluateEvidence(policy, intent);
    const g = gate(t.evidence);
    decide(t, 'evidence', `${t.evidence.filter(e => e.status === 'pass').length}/${t.evidence.length} passed · gate=${g.verdict}${g.by ? ` (${g.by})` : ''}`);

    // ---- 3. ENTITY (router) ----------------------------------------------------------------------
    const choice = (get(intent, policy.rail.beneficiaryChoiceField || 'beneficiary.payoutChoice') || 'local').toLowerCase();
    const fam = choice !== 'local' && policy.rail.beneficiaryChoice ? (CHOICE_TO_RAILS[choice] || []) : null;
    const admissible = Object.values(RAILS).filter(x => policy.rail.allowed.includes(x.id) && (fam ? fam.includes(x.id) : (x.ccy === intent.beneficiary.currency && (x.country === intent.beneficiary.country || x.country === '*' || (x.country === 'EU' && intent.beneficiary.sepa))))).map(x => x.id);
    const r = route(intent, policy, this.partners, { rails: admissible });
    t.routerTrail = r.trail;
    if (r.selected) decide(t, 'entity', `${r.selected.entity} · ${r.selected.name}`);
    else if (r.aboveMax) decide(t, 'entity', `${r.aboveMax.entity} · ${r.aboveMax.name} — eligible, ticket above max`);
    else decide(t, 'entity', `Router: 0 of ${this.partners.filter(p => !policy.entity.excludeEntities?.includes(p.entity)).length} candidate pairings eligible`);

    // ---- 4. TIMING -------------------------------------------------------------------------------
    const tm = Array.isArray(policy.timing.options) ? (policy.timing.options.find(o => o.id === intent.context?.timingOption) || policy.timing.options[0]) : policy.timing;
    let timingText = '';
    let netting = null;
    let queued = false, awaitingEvent = false;
    if (tm.mode === 'NOW') timingText = tm.label || 'Now · evaluated per payout';
    else if (tm.mode === 'JIT') timingText = tm.label || 'Just-in-time: convert at payout, not at funding';
    else if (tm.mode === 'EVENT') {
      const ev = get(intent, tm.eventField);
      awaitingEvent = !ev;
      timingText = ev ? `Event-triggered: ${tm.eventName || tm.eventField} → immediate payout` : `Waiting for ${tm.eventName || tm.eventField}`;
    } else if (tm.mode === 'NET') {
      const n = intent.context?.netting || {};
      const w = new NettingWindow({ key: `${intent.beneficiary.id}:${intent.beneficiary.currency}`, windowHours: n.windowHours ?? tm.windowHours, thresholdUsd: n.thresholdUsd ?? tm.threshold ?? null, openedAt: n.openedAt });
      const per = amountUsd.value / (n.receipts || 1);
      for (let i = 0; i < (n.receipts || 1); i++) w.add({ amountUsd: per });
      if (n.mode === 'PER_ITEM' || tm.perItem) { netting = { legs: n.receipts || 1, receipts: n.receipts || 1, totalUsd: amountUsd.value, perItem: true }; timingText = 'Per receipt (no netting) — evaluated by policy'; }
      else if (n.closeNow === false && !w.shouldClose(now)) { queued = true; timingText = `Netting: queued in ${w.windowHours}h window (${fmt(money(w.totalUsd(), 'USD'))} accumulated)`; }
      else { netting = w.close(); timingText = w.thresholdUsd ? `Streamed on-chain · netted at USD ${w.thresholdUsd} threshold (${netting.legs - 1} threshold close${netting.legs - 1 === 1 ? '' : 's'} + remainder at window end) → ${netting.legs} payouts` : `Streamed on-chain · netted every ${w.windowHours}h per beneficiary → 1 payout`; }
    }
    if (intent.context?.facts?.when) timingText += ` · ${intent.context.facts.when}`;
    decide(t, 'timing', timingText);
    t.perimeter = derivePerimeter({ intent, policy, partner: r.selected || r.aboveMax || null, timingMode: tm.mode, admissibleRails: admissible, evidence: t.evidence });

    // ---- 5. RAIL ---------------------------------------------------------------------------------
    const partner = r.selected || r.aboveMax;
    const sel = selectRail({ policy, partner, beneficiary: intent.beneficiary, amount: amountUsd, choice, when: intent.context?.facts?.whenIso });
    const legs = netting?.legs || 1;
    let price = null;
    const priceBase = intent._split ? intent._split.net : amountUsd;
    if (sel.rail) {
      price = priceRoute({ policy, partner, rail: sel.rail, amount: priceBase, conversionApplies, legs, sourceLocal: (intent.amount.ccy !== 'USD' && intent.amount.ccy !== 'USDC') ? intent.amount : null });
      t.cost = price.lines.map(([l, m, by]) => [l, fmt(m), by || '']);
      const receives = netting?.perItem && price.uneconomic ? `${fmt(price.out)} (negative — rail fees exceed value)` : fmt(price.out);
      t.cost.push([`All-in ${price.allInBps} bps`, '', '']);
      t.cost.push([`Beneficiary receives`, receives, '']);
      decide(t, 'rail', `${sel.rail.name}${legs > 1 ? ` · ${legs} payouts` : ''} · ETA ${etaText(sel.rail.etaSec)}${isWeekendOrNight(intent.context?.facts?.whenIso) ? ' · weekend/overnight window' : ''}${sel.overCap?.length ? ` (${sel.overCap.join(', ')} skipped: over cap)` : ''}`);
    } else decide(t, 'rail', `not routed — ${sel.reason}`);

    // ---- OUTCOME precedence ----------------------------------------------------------------------
    const decline = (code, why) => this._store(finish(t, 'DECLINED', code, why));
    const hold = (code, why) => this._store(finish(t, 'HELD', code, why));
    if (g.verdict === 'DECLINE') return decline(g.reasonCode, this._why(intent, g.reasonCode, `Evidence '${g.by}' failed.`));
    if (!r.selected && !r.aboveMax) {
      const codes = r.trail.map(x => x.skipped);
      const code = codes.includes('MARKET_REGISTRATION_REQUIRED') ? 'MARKET_REGISTRATION_REQUIRED' : codes.includes('JURISDICTION_OUT_OF_APPETITE') ? 'JURISDICTION_OUT_OF_APPETITE' : 'NO_APPETITE_VERTICAL';
      return decline(code, this._why(intent, code, 'No partner pairing has appetite for this payout. Nothing touched the core network.'));
    }
    if (!r.selected && r.aboveMax) { followOn(t, { event: 'MANUAL_REVIEW', watch: 'EDD decision', note: `ticket above USD ${r.aboveMax.maxTicketUsd.toLocaleString()} on ${r.aboveMax.short || r.aboveMax.name}` }); return hold('TICKET_ABOVE_MAX', this._why(intent, 'TICKET_ABOVE_MAX', `${r.aboveMax.name} accepts the operator and the jurisdiction but caps tickets at USD ${r.aboveMax.maxTicketUsd.toLocaleString()}. Held for manual EDD; split into two payouts offered.`)); }
    if (g.verdict === 'HOLD') { followOn(t, { event: 'EVIDENCE_RECHECK', watch: g.by, note: 'auto-releases when the check clears' }); return hold(g.reasonCode, this._why(intent, g.reasonCode, `Evidence '${g.by}' pending — funds stay in the source account, visible, not payable; auto-releases when it clears.`)); }
    if (awaitingEvent) { followOn(t, { event: 'EVENT_TRIGGER', watch: tm.eventName || tm.eventField, note: 'payout re-evaluated on the signal' }); return hold('AWAITING_EVENT', this._why(intent, 'AWAITING_EVENT', 'Payout is armed and waits for the event signal.')); }
    if (queued) { followOn(t, { event: 'NETTING_CLOSE', dueAt: new Date(new Date(now).getTime() + (intent.context?.netting?.windowHours ?? tm.windowHours ?? 24) * 3600e3).toISOString(), note: 'one rail-sized payout at close' }); return this._store(finish(t, 'QUEUED', 'NETTING_QUEUED', this._why(intent, 'NETTING_QUEUED', 'Accumulating in the netting window; one rail-sized payout at close.'))); }
    if (!sel.rail) return decline('RAIL_UNAVAILABLE', this._why(intent, 'RAIL_UNAVAILABLE', sel.reason));
    if (price.uneconomic) { followOn(t, { event: 'NETTING_CLOSE', watch: policy.timing.fallback || 'netting window', note: 're-priced as one netted payout' }); return hold('UNECONOMIC_ROUTE', this._why(intent, 'UNECONOMIC_ROUTE', `Rail fees ${fmt(price.railFee)} against ${fmt(amountUsd)} of value. The policy refuses to pay more to move money than the money is worth and falls back to the ${policy.timing.fallback || 'netting window'}.`)); }

    // ---- LEDGER ----------------------------------------------------------------------------------
    this._postLedger(ledger, intent, policy, partner, sel.rail, price, amountUsd, conversionApplies, netting);
    t.ledger = ledger.rows();
    t.ledgerBalanced = ledger.isBalanced();
    if (price.reserve.value) { const days = policy.pricing?.reserveReleaseDays || partner.reserveReleaseDays || 30; followOn(t, { event: 'RESERVE_RELEASE', dueAt: new Date(new Date(now).getTime() + days * 86400e3).toISOString(), amount: fmt(price.reserve), note: `T+${days} · ${partner.short || partner.name}` }); }
    if (legs > 1) followOn(t, { event: 'NETTING_LEGS', count: `${legs} legs`, note: 'each leg settles against this trace' });
    followOn(t, { event: 'RAIL_CONFIRMATION', watch: sel.rail.name, note: 'confirmation, return or recall lands here' });
    return this._store(finish(t, 'APPROVED', null, this._why(intent, 'APPROVED', `Routed on ${partner.short || partner.name}; ${t.evidence.length} evidence checks, route and cost recorded as one trace.`)));
  }

  _why(intent, code, fallback) { const n = intent.context?.narratives; return (n && n[code]) || fallback; }
  _store(t) { this.traces.set(t.id, t); return t; }

  _postLedger(L, intent, policy, partner, rail, price, amountUsd, conversionApplies, netting) {
    const src = intent.source;
    const legs = netting?.legs || 1;
    const sameCcy = intent.amount.ccy === rail.ccy && rail.ccy !== 'USD' && rail.ccy !== 'USDC';
    if (sameCcy) {
      // Local-currency source and rail (e.g. an operator's CAD balance → Interac): no FX legs. Fees are USD-priced, booked in local currency.
      const k = FX[rail.ccy], ccy = rail.ccy;
      const feeL = round(price.fee.value * k, 2), resL = round(price.reserve.value * k, 2), railL = round((rail.feeUsd || 0) * legs * k, 2);
      const onTop = price.chargeTo === 'SENDER' ? feeL + resL + railL : 0;
      L.post({ account: src.account, debit: round(intent.amount.value + onTop, 2), ccy, memo: onTop ? 'source + fees on top' : 'source' });
      if (feeL) L.post({ account: `Fee revenue (${ccy})`, credit: feeL, ccy, memo: 'risk-priced fee' });
      if (resL) L.post({ account: `Rolling reserve — ${partner.short || partner.name} (${ccy})`, credit: resL, ccy, memo: `released T+${policy.pricing.reserveReleaseDays || partner.reserveReleaseDays || 30}` });
      if (railL) L.post({ account: `Rail fees (${ccy})`, credit: railL, ccy });
      L.post({ account: `Payout clearing · ${rail.name} (${ccy})`, credit: price.out.value, ccy, memo: 'payout' });
      const drift = round(intent.amount.value + onTop - feeL - resL - railL - price.out.value, 2);
      if (Math.abs(drift) >= 0.01) L.post({ account: `Rounding (${ccy})`, credit: drift > 0 ? drift : 0, debit: drift < 0 ? -drift : 0, ccy });
      return;
    }
    let sourceAcct = src.account;
    // funding leg: USDC → USD through the custodian (just-in-time)
    if (conversionApplies) {
      const usdc = money(intent.amount.value, 'USDC');
      L.post({ account: `${src.custodian || 'Custodian'} · USDC receivable`, debit: usdc.value, ccy: 'USDC', memo: netting ? `${netting.receipts} receipts` : 'funding' })
       .post({ account: 'FX position USDC/USD', credit: usdc.value, ccy: 'USDC' })
       .post({ account: 'FX position USDC/USD', debit: amountUsd.value, ccy: 'USD' })
       .post({ account: src.account, credit: amountUsd.value, ccy: 'USD', memo: 'JIT conversion' });
    } else if (intent.amount.ccy !== 'USD' && intent.amount.ccy !== 'USDC') {
      // local-currency source with a different rail currency (e.g. GBP collected → USDC collateral): book through an FX position
      L.post({ account: src.account, debit: intent.amount.value, ccy: intent.amount.ccy, memo: 'source' })
       .post({ account: `FX position ${intent.amount.ccy}/USD`, credit: intent.amount.value, ccy: intent.amount.ccy })
       .post({ account: `FX position ${intent.amount.ccy}/USD`, debit: amountUsd.value, ccy: 'USD' })
       .post({ account: `${src.account} (USD equiv.)`, credit: amountUsd.value, ccy: 'USD' });
      sourceAcct = `${src.account} (USD equiv.)`;
    }
    // marketplace split
    if (intent._split) {
      const s = intent.context.split;
      L.post({ account: sourceAcct, debit: amountUsd.value, ccy: 'USD', memo: 'order settlement' })
       .post({ account: s.feesAccount, credit: intent._split.fee.value, ccy: 'USD', memo: `${s.feeBps / 100}% fee` })
       .post({ account: s.sellerAccount, credit: intent._split.net.value, ccy: 'USD' });
      sourceAcct = s.sellerAccount;
      amountUsd = intent._split.net;
    }
    // fee, reserve and conversion out of the source (USD)
    if (price.fee.value) L.transfer(sourceAcct, 'Fee revenue (USD)', price.fee.value, 'USD', 'risk-priced fee');
    if (price.reserve.value) L.transfer(sourceAcct, `Rolling reserve — ${partner.short || partner.name} (USD)`, price.reserve.value, 'USD', `released T+${policy.pricing.reserveReleaseDays || partner.reserveReleaseDays || 30}`);
    if (price.conversion.value) L.transfer(sourceAcct, 'Conversion cost (USD)', price.conversion.value, 'USD', 'custodian / on-ramp conversion');
    const toPay = round(amountUsd.value - price.fee.value - price.reserve.value - price.conversion.value, 2);
    if (rail.ccy === 'USD') {
      L.transfer(sourceAcct, `Payout clearing · ${rail.name} (USD)`, toPay, 'USD', legs > 1 ? `${legs} legs` : 'payout');
    } else if (rail.ccy === 'USDC') {
      const netFee = round(toPay - price.out.value, 2);
      L.post({ account: sourceAcct, debit: toPay, ccy: 'USD', memo: 'on-chain payout' })
       .post({ account: 'FX position USD/USDC', credit: toPay, ccy: 'USD' })
       .post({ account: 'FX position USD/USDC', debit: toPay, ccy: 'USDC' })
       .post({ account: `On-chain payout · ${rail.name}`, credit: price.out.value, ccy: 'USDC' })
       .post({ account: 'Network fees (USDC)', credit: netFee, ccy: 'USDC' });
    } else {
      const railFeeLocal = round((rail.feeUsd || 0) * legs * FX[rail.ccy], 2);
      const localGross = round(price.out.value + railFeeLocal, 2);
      L.post({ account: sourceAcct, debit: toPay, ccy: 'USD', memo: `FX @ ${price.rate}` })
       .post({ account: `FX position USD/${rail.ccy}`, credit: toPay, ccy: 'USD' })
       .post({ account: `FX position USD/${rail.ccy}`, debit: localGross, ccy: rail.ccy })
       .post({ account: `Payout clearing · ${rail.name} (${rail.ccy})`, credit: price.out.value, ccy: rail.ccy, memo: legs > 1 ? `${legs} legs` : 'payout' })
       .post({ account: `Rail fees (${rail.ccy})`, credit: railFeeLocal, ccy: rail.ccy });
    }
  }
}
