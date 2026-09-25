// trace.js — the decision trace: the audit object every payout leaves behind.
// A trace is append-only and self-describing: which policy version ran, the perimeter the payout ran inside, the five
// decisions and their inputs, every evidence result, the router trail (including partners that were skipped and why),
// the route and its cost attributed line by line to the decision that spent it, the ledger postings, the outcome with a
// reason code, and the follow-on events (reserve release, netting close, event trigger, re-check) that will cite this
// trace when they happen. It is what Risk, a bank partner or a regulator reads.

let counter = 0;
export function newTraceId(prefix = 'trace') { counter += 1; return `${prefix}-${Date.now().toString(36)}-${counter.toString(36).padStart(3, '0')}`; }

export function createTrace(intent, policy, now) {
  return {
    id: newTraceId(),
    at: new Date(now || Date.now()).toISOString(),
    intentId: intent.id,
    flow: intent.flow,
    policy: { id: policy.id, version: policy.version },
    perimeter: null,
    decisions: { source: null, entity: null, evidence: null, timing: null, rail: null },
    evidence: [],
    routerTrail: [],
    route: null,
    cost: [],
    ledger: [],
    outcome: null,
    reasonCode: null,
    narrative: '',
    followOns: [],
  };
}

export function decide(trace, layer, value) { trace.decisions[layer] = value; return trace; }
export function finish(trace, outcome, reasonCode, narrative) { trace.outcome = outcome; trace.reasonCode = reasonCode || null; trace.narrative = narrative || ''; return trace; }
/** Register a later event that will cite this trace: reserve release, netting close, event trigger, evidence re-check, manual review. */
export function followOn(trace, ev) { trace.followOns.push({ ref: trace.id, ...ev }); return trace; }

/** Collapse the router trail for display: keep selected / above-max / jurisdiction / registration / rail / entity-excluded
 *  entries and the core partner; fold the rest ("no appetite for this vertical") into one line. */
export function summarizeTrail(trail, partners = []) {
  const core = new Set(partners.filter(p => p.core).map(p => p.id));
  const keep = [], folded = [];
  for (const r of trail) {
    if (r.selected || r.skipped !== 'NO_APPETITE_VERTICAL' || core.has(r.partner)) keep.push(r); else folded.push(r);
  }
  if (folded.length) keep.splice(keep.findIndex(k => !core.has(k.partner)) < 0 ? keep.length : keep.findIndex(k => !core.has(k.partner)), 0, { partner: '*', name: `${folded.length} partner${folded.length > 1 ? 's' : ''} without appetite for this vertical`, skipped: 'NO_APPETITE_VERTICAL', note: folded.map(f => f.name.split(' — ')[0].split(' (')[0]).join(', '), folded: true });
  return keep;
}

/** Plain-text rendering for CLIs and logs. */
export function renderTrace(t, partners = []) {
  const L = [];
  L.push(`${t.id} · ${t.at} · flow=${t.flow} · policy=${t.policy.id}@v${t.policy.version}`);
  for (const k of ['source', 'entity']) if (t.decisions[k]) L.push(`  ${k.toUpperCase().padEnd(9)} ${t.decisions[k]}`);
  if (t.perimeter) L.push(`  PERIMETER ${t.perimeter.label}`);
  if (t.evidence.length) L.push(`  EVIDENCE  ${t.evidence.map(e => `${e.status === 'pass' ? '✓' : e.status === 'fail' ? '✕' : '…'} ${e.name}`).join(' · ')}`);
  for (const e of t.evidence) if (e.status !== 'pass') L.push(`            ${e.name}: ${e.detail}`);
  if (t.routerTrail.length) for (const r of summarizeTrail(t.routerTrail, partners)) L.push(`  ROUTER    ${r.selected ? '→ ' : '   '}${r.name}: ${r.selected ? 'selected' : r.skipped} — ${r.note}`);
  for (const k of ['timing', 'rail']) if (t.decisions[k]) L.push(`  ${k.toUpperCase().padEnd(9)} ${t.decisions[k]}`);
  if (t.cost.length) { L.push('  COST'); for (const c of t.cost) L.push(`            ${c[0].padEnd(52)} ${String(c[1]).padEnd(16)} ${c[2] ? `← ${c[2]}` : ''}`.trimEnd()); }
  if (t.ledger.length) { L.push('  LEDGER'); for (const r of t.ledger) L.push(`            ${r.account.padEnd(48)} ${(r.debit || '').padStart(18)} ${(r.credit || '').padStart(18)}`); }
  L.push(`  OUTCOME   ${t.outcome}${t.reasonCode ? ` (${t.reasonCode})` : ''} — ${t.narrative}`);
  for (const f of t.followOns || []) L.push(`  FOLLOW-ON ${f.event}${f.dueAt ? ` · ${f.dueAt.slice(0, 10)}` : ''}${f.amount ? ` · ${f.amount}` : ''}${f.watch ? ` · watching ${f.watch}` : ''}${f.count ? ` · ${f.count}` : ''} → cites ${f.ref}`);
  return L.join('\n');
}
