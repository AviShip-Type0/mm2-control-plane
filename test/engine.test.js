import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlane } from '../src/engine/controlplane.js';
import { validatePolicy } from '../src/engine/policy.js';
import { Ledger } from '../src/engine/ledger.js';
import { NettingWindow, priceRoute, RAILS, selectRail } from '../src/engine/settlement.js';
import { round, money, convert } from '../src/engine/money.js';
import { buildIntent } from '../src/engine/scenario.js';
import { loadPolicies, loadPartners, loadScenarios } from '../src/engine/load.js';

const policies = loadPolicies(), partners = loadPartners(), scenarios = loadScenarios();
const cp = new ControlPlane({ policies, partners });
const S = Object.fromEntries(scenarios.map(s => [s.id, s]));
const run = (id, sel = {}) => cp.evaluate(buildIntent(S[id], sel), { now: '2026-09-23T09:00:00Z' });

test('all shipped policies validate', () => { for (const p of policies) assert.deepEqual(validatePolicy(p), [], p.id); });
test('invalid policy is rejected', () => { assert.ok(validatePolicy({ id: 'x', flow: 'y', version: 0, source: {}, evidence: 'no', timing: { mode: 'LATER' }, rail: {} }).length >= 5); });

test('money: HALF_EVEN rounding and conversion', () => {
  assert.equal(round(2.345, 2), 2.34); assert.equal(round(2.355, 2), 2.36); assert.equal(round(2.3451, 2), 2.35);
  const c = convert(money(100, 'USD'), 'BRL', 0); assert.equal(c.out.value, 542);
});

test('ledger balances per currency and rejects negatives', () => {
  const L = new Ledger(); L.transfer('a', 'b', 10, 'USD'); assert.ok(L.isBalanced());
  L.post({ account: 'c', debit: 1, ccy: 'EUR' }); assert.ok(!L.isBalanced());
  assert.throws(() => L.post({ account: 'd', debit: -1, ccy: 'USD' }));
});

test('marketplace: Pix payout approved with balanced ledger and 12% split', () => {
  const t = run('marketplace');
  assert.equal(t.outcome, 'APPROVED'); assert.ok(t.ledgerBalanced);
  assert.ok(t.decisions.rail.startsWith('Pix'));
  assert.ok(t.ledger.some(r => r.account === 'Platform · Fees (USD)' && r.credit === '120.00 USD'));
  assert.ok(t.routerTrail.find(r => r.partner === 'NIUM_INC_CFSB').skipped === 'JURISDICTION_OUT_OF_APPETITE');
});
test('marketplace: KYB pending → HELD, weekly net → QUEUED, card → approved, USDC to Brazil → declined (Res. 561)', () => {
  assert.equal(run('marketplace', { kyb: 1 }).outcome, 'HELD');
  assert.equal(run('marketplace', { kyb: 1 }).reasonCode, 'KYB_PENDING');
  assert.equal(run('marketplace', { timing: 1 }).outcome, 'QUEUED');
  const card = run('marketplace', { payee: 2 }); assert.equal(card.outcome, 'APPROVED'); assert.ok(card.decisions.rail.startsWith('Nium card'));
  const usdc = run('marketplace', { payee: 1 }); assert.equal(usdc.outcome, 'DECLINED'); assert.equal(usdc.reasonCode, 'JURISDICTION_OUT_OF_APPETITE');
});

test('stablecoin: JIT USDC funding approved on InstaPay; pre-funded USD also approved; GCash and USDC choices route correctly', () => {
  const t = run('usdc'); assert.equal(t.outcome, 'APPROVED'); assert.ok(t.decisions.rail.startsWith('InstaPay')); assert.ok(t.ledgerBalanced);
  assert.ok(t.ledger.some(r => r.account.includes('USDC receivable')));
  const pre = run('usdc', { fund: 1 }); assert.equal(pre.outcome, 'APPROVED'); assert.ok(!pre.ledger.some(r => r.account.includes('USDC receivable')));
  assert.ok(run('usdc', { payee: 1 }).decisions.rail.startsWith('GCash'));
  const u = run('usdc', { payee: 2 }); assert.ok(u.decisions.rail.startsWith('USDC on Base')); assert.ok(u.decisions.entity.includes('Coinbase'));
});

test('prediction: MX approved via SPEI; AZ declined; NJ approved via RTP; UK requires UKGC; offshore venue declined', () => {
  const mx = run('prediction'); assert.equal(mx.outcome, 'APPROVED'); assert.ok(mx.decisions.rail.startsWith('SPEI')); assert.ok(mx.ledgerBalanced);
  const az = run('prediction', { juris: 1 }); assert.equal(az.outcome, 'DECLINED'); assert.equal(az.reasonCode, 'JURISDICTION_OUT_OF_APPETITE');
  const nj = run('prediction', { juris: 2 }); assert.equal(nj.outcome, 'APPROVED'); assert.ok(nj.decisions.rail.startsWith('RTP'));
  const uk = run('prediction', { juris: 3 }); assert.equal(uk.outcome, 'DECLINED'); assert.equal(uk.reasonCode, 'MARKET_REGISTRATION_REQUIRED');
  const off = run('prediction', { venue: 1 }); assert.equal(off.outcome, 'DECLINED'); assert.equal(off.reasonCode, 'VENUE_LICENCE_REQUIRED');
});

test('perps: weekend withdrawal approved on Faster Payments; offshore venue declined; margin top-up lands USDC', () => {
  const t = run('perps'); assert.equal(t.outcome, 'APPROVED'); assert.ok(t.decisions.rail.includes('Faster Payments')); assert.ok(t.decisions.rail.includes('weekend'));
  assert.ok(t.evidence.find(e => e.id === 'attest')); assert.ok(t.ledgerBalanced);
  const off = run('perps', { venue: 1 }); assert.equal(off.outcome, 'DECLINED'); assert.equal(off.reasonCode, 'VENUE_OUT_OF_APPETITE');
  const up = run('perps', { dir: 1 }); assert.equal(up.outcome, 'APPROVED'); assert.ok(up.decisions.rail.startsWith('USDC on Base')); assert.ok(!up.evidence.find(e => e.id === 'attest')); assert.ok(up.ledgerBalanced);
});

test('agent: 24h netting → one payout; threshold → 2 legs; per-call → HELD uneconomic; unverified principal / mandate exceeded → DECLINED', () => {
  const t = run('agent'); assert.equal(t.outcome, 'APPROVED'); assert.ok(t.decisions.timing.includes('1 payout')); assert.ok(t.ledgerBalanced);
  const th = run('agent', { net: 1 }); assert.equal(th.outcome, 'APPROVED'); assert.ok(th.decisions.rail.includes('2 payouts'));
  const per = run('agent', { net: 2 }); assert.equal(per.outcome, 'HELD'); assert.equal(per.reasonCode, 'UNECONOMIC_ROUTE');
  assert.equal(run('agent', { principal: 1 }).reasonCode, 'AGENT_PRINCIPAL_UNVERIFIED');
  assert.equal(run('agent', { mandate: 1 }).reasonCode, 'MANDATE_EXCEEDED');
});

test('gaming: Ontario approved on Partner C after A and B are skipped; Quebec declined; no iGO declined; CAD 40k held', () => {
  const t = run('gaming'); assert.equal(t.outcome, 'APPROVED'); assert.ok(t.decisions.entity.includes('Pateno')); assert.ok(t.ledgerBalanced);
  assert.equal(t.routerTrail.find(r => r.partner === 'NIUM_INC_CFSB').skipped, 'NO_APPETITE_VERTICAL');
  assert.equal(t.routerTrail.find(r => r.partner === 'NIUM_EU_BC_GAMING').skipped, 'JURISDICTION_OUT_OF_APPETITE');
  assert.ok(t.cost.some(c => c[0].startsWith('Risk-priced payout fee 85')));
  assert.ok(t.cost.some(c => c[1] === 'CAD 2,150.00')); // sender pays on top
  assert.equal(run('gaming', { prov: 1 }).reasonCode, 'JURISDICTION_OUT_OF_APPETITE');
  assert.equal(run('gaming', { lic: 1 }).reasonCode, 'MARKET_REGISTRATION_REQUIRED');
  const big = run('gaming', { ticket: 1 }); assert.equal(big.outcome, 'HELD'); assert.equal(big.reasonCode, 'TICKET_ABOVE_MAX');
});

test('netting window closes on time or threshold', () => {
  const w = new NettingWindow({ key: 'k', windowHours: 24, openedAt: '2026-09-22T00:00:00Z' });
  for (let i = 0; i < 100; i++) w.add({ amountUsd: 0.5 });
  assert.equal(w.totalUsd(), 50); assert.ok(!w.shouldClose('2026-09-22T10:00:00Z')); assert.ok(w.shouldClose('2026-09-23T01:00:00Z'));
  const th = new NettingWindow({ key: 'k', windowHours: 24, thresholdUsd: 20, openedAt: '2026-09-22T00:00:00Z' }); for (let i = 0; i < 100; i++) th.add({ amountUsd: 0.5 });
  assert.ok(th.shouldClose('2026-09-22T00:01:00Z')); assert.equal(th.close().legs, 3);
});

test('rail selection respects caps and 24/7 windows', () => {
  const pol = { rail: { allowed: ['fps_uk', 'chaps'], preference: 'REALTIME', beneficiaryChoice: false } };
  const b = { currency: 'GBP', country: 'GB' };
  assert.equal(selectRail({ policy: pol, partner: null, beneficiary: b, amount: money(5000, 'USD'), choice: 'local' }).rail.id, 'fps_uk');
  assert.equal(selectRail({ policy: pol, partner: null, beneficiary: b, amount: money(2000000, 'USD'), choice: 'local', when: '2026-09-22T14:00:00Z' }).rail.id, 'chaps');
  assert.equal(selectRail({ policy: pol, partner: null, beneficiary: b, amount: money(2000000, 'USD'), choice: 'local', when: '2026-09-26T03:00:00Z' }).rail, null);
});

test('every trace of every knob combination is well-formed and every approved ledger balances', () => {
  let n = 0;
  for (const s of scenarios) {
    const dims = s.knobs.map(k => k.options.length);
    const total = dims.reduce((a, b) => a * b, 1);
    for (let i = 0; i < total; i++) {
      let rem = i; const sel = {};
      s.knobs.forEach((k, j) => { sel[k.id] = rem % dims[j]; rem = Math.floor(rem / dims[j]); });
      const t = run(s.id, sel); n++;
      assert.ok(['APPROVED', 'DECLINED', 'HELD', 'QUEUED'].includes(t.outcome), `${s.id} ${JSON.stringify(sel)}`);
      assert.ok(t.decisions.source && t.decisions.evidence && t.decisions.entity && t.decisions.timing && t.decisions.rail, `${s.id} decisions`);
      if (t.outcome === 'APPROVED') assert.ok(t.ledgerBalanced, `${s.id} ${JSON.stringify(sel)} ledger`);
    }
  }
  assert.ok(n >= 60);
});

test('perimeter: derived from policy ∩ appetite ∩ beneficiary; same box, same decisions; no partner → no perimeter', () => {
  const t = run('gaming');
  assert.ok(t.perimeter && t.perimeter.entity.startsWith('Nium Canada'));
  assert.equal(t.perimeter.key.split('|').length, 5);
  assert.equal(t.perimeter.jurisdiction, 'CA-ON'); assert.equal(t.perimeter.vertical, 'gaming'); assert.equal(t.perimeter.currency, 'CAD');
  assert.equal(t.perimeter.ticketMaxUsd, 18400); assert.deepEqual(t.perimeter.registrations, ['iGO']); assert.equal(t.perimeter.reserveBps, 500);
  assert.equal(run('gaming').perimeter.key, run('gaming', { ticket: 1 }).perimeter.key); // ticket size does not change the box
  assert.notEqual(run('prediction').perimeter.key, run('prediction', { juris: 2 }).perimeter.key); // MX vs US-NJ: different entity, different box
  const none = run('gaming', { prov: 1 }); assert.equal(none.perimeter.entity, null); assert.ok(none.perimeter.label.startsWith('no perimeter'));
  const early = cp.evaluate({ ...buildIntent(S.usdc, {}), source: { asset: 'EURC', account: 'x' } }); assert.equal(early.reasonCode, 'SOURCE_ASSET_NOT_ALLOWED'); assert.equal(early.perimeter, null);
});

test('cost: every priced line is attributed to the decision that spent it; totals are not', () => {
  const BY = new Set(['source', 'entity', 'timing', 'rail', 'policy']);
  for (const s of scenarios) {
    const t = run(s.id);
    if (!t.cost.length) continue;
    const priced = t.cost.slice(0, -2), totals = t.cost.slice(-2);
    for (const c of priced) assert.ok(BY.has(c[2]), `${s.id}: '${c[0]}' attributed to '${c[2]}'`);
    for (const c of totals) assert.equal(c[2], '');
  }
  const g = run('gaming');
  assert.equal(g.cost.find(c => c[0].startsWith('Risk-priced'))[2], 'entity');
  assert.equal(g.cost.find(c => c[0].startsWith('Charged to sender'))[2], 'policy');
  assert.equal(run('agent', { net: 1 }).cost.find(c => c[0].includes('legs'))[2], 'timing');
  assert.equal(run('usdc').cost.find(c => c[0].startsWith('Conversion'))[2], 'source');
  assert.equal(run('marketplace').cost.find(c => c[0].startsWith('FX spread'))[2], 'rail');
});

test('follow-ons: every later event cites the trace that created it', () => {
  const g = run('gaming');
  const rel = g.followOns.find(f => f.event === 'RESERVE_RELEASE');
  assert.ok(rel && rel.ref === g.id && rel.dueAt.startsWith('2026-10-23') && rel.amount === 'USD 79.04');
  assert.ok(g.followOns.find(f => f.event === 'RAIL_CONFIRMATION'));
  const q = run('marketplace', { timing: 1 }); assert.equal(q.followOns.find(f => f.event === 'NETTING_CLOSE').ref, q.id);
  assert.equal(run('marketplace', { kyb: 1 }).followOns[0].event, 'EVIDENCE_RECHECK');
  assert.equal(run('gaming', { ticket: 1 }).followOns[0].event, 'MANUAL_REVIEW');
  assert.equal(run('agent', { net: 2 }).followOns[0].event, 'NETTING_CLOSE');
  assert.ok(run('agent', { net: 1 }).followOns.find(f => f.event === 'NETTING_LEGS'));
  for (const s of scenarios) { const t = run(s.id); for (const f of t.followOns) assert.equal(f.ref, t.id); } // ref is always the trace's own id
  assert.deepEqual(run('gaming', { prov: 1 }).followOns, []); // a decline has no future
});
