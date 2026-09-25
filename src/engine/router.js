// router.js — the risk-appetite router (the "Entity" decision).
// Partners are Nium entities paired with a bank/rail partner and a declared appetite: verticals, jurisdictions,
// max ticket, required licences, rails, reserve and fee. The router evaluates every candidate and returns the
// selected pairing plus the trail of skipped candidates with reason codes. Two partners can decline a flow
// without ever seeing it — that is the point.

export const REASON = {
  NO_APPETITE_VERTICAL: 'NO_APPETITE_VERTICAL',
  JURISDICTION_OUT_OF_APPETITE: 'JURISDICTION_OUT_OF_APPETITE',
  TICKET_ABOVE_MAX: 'TICKET_ABOVE_MAX',
  MARKET_REGISTRATION_REQUIRED: 'MARKET_REGISTRATION_REQUIRED',
  RAIL_UNAVAILABLE: 'RAIL_UNAVAILABLE',
  ENTITY_EXCLUDED: 'ENTITY_EXCLUDED',
};

/** @param {object} intent @param {object} policy @param {object[]} partners @param {{rails?:string[]}} opts — rails: the rail ids the beneficiary's choice/currency admits; a partner must offer at least one */
export function route(intent, policy, partners, opts = {}) {
  const vertical = policy.entity.vertical;
  const jurisdiction = intent.beneficiary?.jurisdiction || intent.beneficiary?.country;
  const amountUsd = intent.amountUsd ?? intent.amount?.value;
  const have = intent.context?.facts?.operatorLicences || [];
  const trail = [];
  const eligible = [];
  for (const p of partners) {
    if (policy.entity.excludeEntities?.includes(p.entity)) { trail.push({ partner: p.id, name: p.name, skipped: REASON.ENTITY_EXCLUDED, note: 'entity excluded by policy' }); continue; }
    if (!p.verticals.includes(vertical) && !p.verticals.includes('*')) { trail.push({ partner: p.id, name: p.name, skipped: REASON.NO_APPETITE_VERTICAL, note: `appetite: ${vertical} ✗` }); continue; }
    if (!(p.jurisdictions.includes('*') || p.jurisdictions.includes(jurisdiction)) || (p.exclude || []).includes(jurisdiction)) { trail.push({ partner: p.id, name: p.name, skipped: REASON.JURISDICTION_OUT_OF_APPETITE, note: (p.exclude || []).includes(jurisdiction) ? `${jurisdiction} excluded by appetite` : `jurisdictions: ${p.jurisdictions.join(', ')}` }); continue; }
    const reqRaw = (p.requires && p.requires[jurisdiction]) || [];
    const req = Array.isArray(reqRaw) ? reqRaw : (reqRaw[vertical] || []); // requires may be per-jurisdiction (array) or per-jurisdiction-and-vertical (object)
    const missing = req.filter(r => !have.includes(r));
    if (missing.length) { trail.push({ partner: p.id, name: p.name, skipped: REASON.MARKET_REGISTRATION_REQUIRED, note: `requires ${missing.join(', ')} for ${jurisdiction}` }); continue; }
    if (opts.rails && opts.rails.length && p.rails && !p.rails.includes('*') && !opts.rails.some(x => p.rails.includes(x))) { trail.push({ partner: p.id, name: p.name, skipped: REASON.RAIL_UNAVAILABLE, note: `rails: ${p.rails.join(', ')}` }); continue; }
    if (p.maxTicketUsd != null && amountUsd > p.maxTicketUsd) { eligible.push({ ...p, aboveMax: true }); trail.push({ partner: p.id, name: p.name, skipped: REASON.TICKET_ABOVE_MAX, note: `max ticket USD ${p.maxTicketUsd.toLocaleString()}` }); continue; }
    eligible.push(p);
    trail.push({ partner: p.id, name: p.name, selected: true, note: `appetite ✓ · reserve ${p.reserveBps || 0} bps · fee ${p.feeBps || 0} bps` });
    break; // partners are pre-ordered by preference (cost, then relationship); first eligible wins
  }
  const selected = eligible.find(p => !p.aboveMax) || null;
  const aboveMax = !selected && eligible.find(p => p.aboveMax) ? eligible.find(p => p.aboveMax) : null;
  return { selected, aboveMax, trail };
}
