// policy.js — the policy DSL and its validator.
// A policy declares, for one flow type, the five decisions the control plane makes per payout:
//   source   — what the money may be when it arrives, and how it is converted
//   entity   — which vertical / jurisdiction / licence constraints drive partner selection
//   evidence — what must be true before the money moves (and what to do when it is not)
//   timing   — now | JIT | NET (streamed then netted) | EVENT (wait for an external signal)
//   rail     — which rails are allowed, how to choose, and whether the beneficiary may choose
// plus pricing and limits. Policies are data: they are versioned, reviewed by Risk, and evaluated per transaction.

export const TIMING_MODES = ['NOW', 'JIT', 'NET', 'EVENT'];
export const ON_FAIL = ['DECLINE', 'HOLD', 'WARN'];
export const OUTCOMES = ['APPROVED', 'DECLINED', 'HELD', 'QUEUED'];

/** @returns {string[]} list of validation errors (empty = valid) */
export function validatePolicy(p) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(typeof p?.id === 'string' && p.id.length > 0, 'id required');
  need(typeof p?.flow === 'string', 'flow required');
  need(Number.isInteger(p?.version) && p.version >= 1, 'version must be a positive integer');
  need(p?.source && Array.isArray(p.source.allowedAssets) && p.source.allowedAssets.length > 0, 'source.allowedAssets required');
  need(['JIT', 'PREFUNDED', 'NONE'].includes(p?.source?.conversion), 'source.conversion must be JIT|PREFUNDED|NONE');
  need(p?.entity && typeof p.entity.vertical === 'string', 'entity.vertical required');
  need(Array.isArray(p?.evidence), 'evidence must be an array');
  (Array.isArray(p?.evidence) ? p.evidence : []).forEach((e, i) => {
    need(typeof e.id === 'string', `evidence[${i}].id required`);
    need(typeof e.provider === 'string', `evidence[${i}].provider required`);
    need(ON_FAIL.includes(e.onFail || 'DECLINE'), `evidence[${i}].onFail invalid`);
  });
  const timings = Array.isArray(p?.timing?.options) ? p.timing.options : [p?.timing];
  need(timings.length > 0, 'timing required');
  timings.forEach((tm, i) => {
    need(TIMING_MODES.includes(tm?.mode), `timing[${i}].mode invalid`);
    if (tm?.mode === 'NET') need(tm.windowHours > 0 || tm.threshold > 0 || tm.perItem === true, `timing[${i}] NET needs windowHours, threshold or perItem`);
    if (tm?.mode === 'EVENT') need(typeof tm.eventField === 'string', `timing[${i}] EVENT needs eventField`);
  });
  need(Array.isArray(p?.rail?.allowed) && p.rail.allowed.length > 0, 'rail.allowed required');
  need(p?.pricing && typeof p.pricing === 'object', 'pricing required');
  return errs;
}

/** Resolve a dotted path against an object ("beneficiary.country"). */
export function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
