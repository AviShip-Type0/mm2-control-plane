// perimeter.js — the perimeter a payout runs inside.
// A perimeter is the intersection a partner has opted into: entity × jurisdiction × vertical × currency × ticket band ×
// evidence set × rails × timing. It is derived, never configured by hand: policy ∩ partner appetite ∩ beneficiary.
// Two payouts with the same perimeter key get the same decisions; a new vertical is a new perimeter, not a new product.
// This is what a bank partner, Risk or a regulator signs: the box, not the individual payout.

/**
 * @param {{intent:object, policy:object, partner:object|null, timingMode:string, admissibleRails?:string[], evidence?:object[]}} a
 */
export function derivePerimeter({ intent, policy, partner, timingMode, admissibleRails = [], evidence = [] }) {
  const jurisdiction = intent.beneficiary?.jurisdiction || intent.beneficiary?.country || '—';
  const vertical = policy.entity.vertical;
  const currency = intent.beneficiary?.currency || intent.amount?.ccy || '—';
  const rails = partner && partner.rails && !partner.rails.includes('*') ? admissibleRails.filter(r => partner.rails.includes(r)) : admissibleRails;
  const reqRaw = partner?.requires?.[jurisdiction];
  const registrations = Array.isArray(reqRaw) ? reqRaw : (reqRaw?.[vertical] || []);
  const p = {
    entity: partner?.entity || null,
    sponsor: partner ? (partner.short || partner.name) : null,
    jurisdiction,
    vertical,
    currency,
    ticketMaxUsd: partner?.maxTicketUsd ?? null,
    evidence: evidence.map(e => e.name),
    registrations,
    rails,
    timing: timingMode,
    reserveBps: policy.pricing?.reserveBps ?? partner?.reserveBps ?? 0,
    feeBps: (policy.pricing?.feeBps || 0) + (partner?.feeBps || 0),
  };
  p.key = [p.entity || '∅', jurisdiction, vertical, currency, timingMode].join('|');
  p.label = partner
    ? `${p.entity} · ${p.sponsor} · ${jurisdiction} · ${vertical} · ${currency} · ${timingMode}${p.ticketMaxUsd != null ? ` · ≤ USD ${p.ticketMaxUsd.toLocaleString()}` : ''}${registrations.length ? ` · requires ${registrations.join(', ')}` : ''}`
    : `no perimeter opted in for ${jurisdiction} · ${vertical} · ${currency}`;
  return p;
}
