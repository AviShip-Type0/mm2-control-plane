// evidence.js — the evidence gate.
// Each policy lists evidence requirements; each requirement names a provider. Providers are pluggable:
// in production they adapt Nium's Customer Onboarding v5 / RFI v5 (KYC/KYB), Nium Verify (account + name match),
// sanctions screening, licence registries (MGA, UKGC, iGaming Ontario, CFTC DCM list, VASP registers),
// venue attestations, the agent registry (principal KYB + mandates), and oracle/resolution feeds.
// This reference implementation ships deterministic mock providers that read facts from the payout intent's
// `context`, so the same engine runs in tests, the CLI and the browser.

/** @typedef {{id:string, name:string, status:'pass'|'fail'|'wait', detail:string, onFail:'DECLINE'|'HOLD'|'WARN', reasonCode?:string}} EvidenceResult */

const providers = new Map();
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function registerProvider(name, fn) { providers.set(name, fn); }
export function hasProvider(name) { return providers.has(name); }

/** Evaluate all evidence requirements of a policy against an intent. Providers run "in parallel" (pure functions here). */
export function evaluateEvidence(policy, intent) {
  return policy.evidence.filter((req) => !req.when || getPath(intent, req.when.field) === req.when.equals).map((req) => {
    const fn = providers.get(req.provider);
    if (!fn) return { id: req.id, name: req.name || req.id, status: 'fail', detail: `no provider '${req.provider}'`, onFail: 'HOLD', reasonCode: 'EVIDENCE_PROVIDER_MISSING' };
    const r = fn(intent, req) || { status: 'fail', detail: 'provider returned nothing' };
    return { id: req.id, name: req.name || req.id, status: r.status, detail: r.detail, onFail: req.onFail || 'DECLINE', reasonCode: r.reasonCode || req.reasonCode };
  });
}

/** Fold evidence results into a gate verdict. DECLINE beats HOLD beats WARN. */
export function gate(results) {
  const failed = results.filter(r => r.status !== 'pass');
  if (failed.some(r => r.status === 'fail' && r.onFail === 'DECLINE')) {
    const r = failed.find(x => x.status === 'fail' && x.onFail === 'DECLINE');
    return { verdict: 'DECLINE', reasonCode: r.reasonCode || 'EVIDENCE_FAILED', by: r.id };
  }
  if (failed.some(r => (r.status === 'fail' || r.status === 'wait') && r.onFail === 'HOLD')) {
    const r = failed.find(x => (x.status === 'fail' || x.status === 'wait') && x.onFail === 'HOLD');
    return { verdict: 'HOLD', reasonCode: r.reasonCode || 'EVIDENCE_PENDING', by: r.id };
  }
  if (failed.some(r => r.status === 'wait')) {
    const r = failed.find(x => x.status === 'wait');
    return { verdict: 'HOLD', reasonCode: r.reasonCode || 'EVIDENCE_PENDING', by: r.id };
  }
  return { verdict: 'PASS' };
}

// ---------------------------------------------------------------------------------------------
// Mock providers. Facts live in intent.context.facts (e.g. facts.kyb = 'verified').
// ---------------------------------------------------------------------------------------------
const facts = (intent) => intent.context?.facts || {};

registerProvider('kyc', (intent) => {
  const f = facts(intent);
  return f.kyc === 'verified' ? { status: 'pass', detail: 'beneficiary verified (Onboarding v5)' } : { status: 'wait', detail: 'beneficiary KYC pending', reasonCode: 'KYC_PENDING' };
});
registerProvider('kyb', (intent) => {
  const f = facts(intent);
  if (f.kyb === 'verified') return { status: 'pass', detail: `KYB verified${f.kybDetail ? ' — ' + f.kybDetail : ''}` };
  if (f.kyb === 'rejected') return { status: 'fail', detail: 'KYB rejected', reasonCode: 'KYB_REJECTED' };
  return { status: 'wait', detail: 'KYB in progress', reasonCode: 'KYB_PENDING' };
});
registerProvider('verify', (intent) => {
  const f = facts(intent);
  return f.verify === false ? { status: 'fail', detail: 'account does not resolve / name mismatch', reasonCode: 'VERIFY_FAILED' } : { status: 'pass', detail: f.verifyDetail || 'account verified, name match' };
});
registerProvider('sanctions', (intent) => {
  const f = facts(intent);
  return f.sanctionsHit ? { status: 'fail', detail: 'sanctions hit', reasonCode: 'SANCTIONS_HIT' } : { status: 'pass', detail: 'parties screened' };
});
registerProvider('lineage', (intent) => {
  const f = facts(intent);
  return f.lineage ? { status: 'pass', detail: f.lineage } : { status: 'fail', detail: 'no funds lineage attached', reasonCode: 'LINEAGE_MISSING' };
});
registerProvider('sourceOfFunds', (intent) => {
  const f = facts(intent);
  return f.sourceOfFunds ? { status: 'pass', detail: f.sourceOfFunds } : { status: 'wait', detail: 'source of funds requested (RFI v5)', reasonCode: 'SOF_PENDING' };
});
registerProvider('purpose', (intent) => {
  const f = facts(intent);
  return f.purpose ? { status: 'pass', detail: f.purpose } : { status: 'fail', detail: 'purpose code missing', reasonCode: 'PURPOSE_MISSING' };
});
registerProvider('venueLicence', (intent, req) => {
  const f = facts(intent);
  const ok = Array.isArray(f.venueLicences) && (req.accepts || []).some(a => f.venueLicences.includes(a));
  return ok ? { status: 'pass', detail: `venue licence on file: ${f.venueLicences.join(', ')}` } : { status: 'fail', detail: 'venue not licensed for this flow', reasonCode: req.reasonCode || 'VENUE_LICENCE_REQUIRED' };
});
registerProvider('operatorLicence', (intent, req) => {
  const f = facts(intent);
  const have = f.operatorLicences || [];
  const missing = (req.requiresAll || []).filter(x => !have.includes(x));
  return missing.length === 0 ? { status: 'pass', detail: `operator licences: ${have.join(', ')}` } : { status: 'fail', detail: `missing: ${missing.join(', ')}`, reasonCode: req.reasonCode || 'LICENCE_REQUIRED' };
});
registerProvider('attestation', (intent, req) => {
  const f = facts(intent);
  return f.attestation ? { status: 'pass', detail: f.attestation } : { status: 'wait', detail: `${req.name || 'attestation'} not received`, reasonCode: 'ATTESTATION_PENDING' };
});
registerProvider('resolution', (intent) => {
  const f = facts(intent);
  return f.resolution ? { status: 'pass', detail: f.resolution } : { status: 'wait', detail: 'market not resolved', reasonCode: 'AWAITING_RESOLUTION' };
});
registerProvider('agentPrincipal', (intent) => {
  const a = intent.context?.agent || {};
  return a.principalVerified ? { status: 'pass', detail: `agent ${a.id} → principal KYB verified · reputation ${a.reputation ?? 'n/a'}` } : { status: 'fail', detail: 'no verified principal on record', reasonCode: 'AGENT_PRINCIPAL_UNVERIFIED' };
});
registerProvider('mandate', (intent) => {
  const a = intent.context?.agent || {};
  const spent = (a.spentTodayUsd || 0) + (intent.amount?.value || 0);
  if (a.dailyCapUsd == null) return { status: 'fail', detail: 'no mandate', reasonCode: 'MANDATE_MISSING' };
  return spent <= a.dailyCapUsd ? { status: 'pass', detail: `USD ${spent.toFixed(2)} within USD ${a.dailyCapUsd}/day mandate` } : { status: 'fail', detail: `USD ${spent.toFixed(2)} exceeds USD ${a.dailyCapUsd}/day mandate`, reasonCode: 'MANDATE_EXCEEDED' };
});
registerProvider('velocity', (intent) => {
  const f = facts(intent);
  return f.velocityBreach ? { status: 'wait', detail: 'velocity ceiling breached — EDD case opened', reasonCode: 'VELOCITY_EDD' } : { status: 'pass', detail: f.velocityDetail || 'within velocity ceilings' };
});
registerProvider('responsibleGaming', (intent) => {
  const f = facts(intent);
  return f.rgFlag ? { status: 'fail', detail: 'responsible-gaming flag on player', reasonCode: 'RG_FLAG' } : { status: 'pass', detail: 'no responsible-gaming flags' };
});
registerProvider('sla', (intent, req) => {
  return { status: 'pass', detail: `${req.name || 'service window'}: ${intent.context?.facts?.when || 'now'} · 24/7 rail available` };
});
