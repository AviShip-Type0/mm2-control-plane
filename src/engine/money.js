// money.js — minor-unit arithmetic and illustrative FX. No floating-point money leaves this module unrounded.
// Amounts are plain numbers in major units (e.g. 1000.00 USD) but every operation rounds HALF_EVEN to the
// currency's precision, matching Nium's documented numeric(19,4)/HALF_EVEN convention.

export const PRECISION = { USD: 2, USDC: 2, EUR: 2, GBP: 2, BRL: 2, PHP: 2, MXN: 2, INR: 2, CAD: 2, SGD: 2, JPY: 0, VND: 0, IDR: 0, HUF: 0 };

/** Illustrative mid rates, USD base. Production: quote service (Reuters feed, 5-minute refresh) + lock periods. */
export const FX = { USD: 1, USDC: 1, BRL: 5.42, PHP: 56.1, MXN: 18.2, GBP: 0.78, INR: 87.4, CAD: 1.36, EUR: 0.92, SGD: 1.34, JPY: 149.0 };

export function precision(ccy) { return PRECISION[ccy] ?? 2; }

/** HALF_EVEN rounding to n decimals. */
export function round(value, n) {
  const f = Math.pow(10, n);
  const x = value * f;
  const floor = Math.floor(x);
  const diff = x - floor;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = (floor % 2 === 0) ? floor : floor + 1; // half to even
  else r = Math.round(x);
  return r / f;
}

export function money(value, ccy) { return { value: round(value, precision(ccy)), ccy }; }

export function add(a, b) { if (a.ccy !== b.ccy) throw new Error(`currency mismatch ${a.ccy}/${b.ccy}`); return money(a.value + b.value, a.ccy); }
export function sub(a, b) { if (a.ccy !== b.ccy) throw new Error(`currency mismatch ${a.ccy}/${b.ccy}`); return money(a.value - b.value, a.ccy); }
export function mulBps(a, bps) { return money(a.value * bps / 10000, a.ccy); }

/** Convert with an optional spread in bps applied against the client (we sell at mid * (1 - spread) when selling USD). */
export function convert(a, toCcy, spreadBps = 0) {
  if (a.ccy === toCcy) return { out: money(a.value, toCcy), rate: 1, spread: money(0, a.ccy) };
  const fromUsd = FX[a.ccy], toUsd = FX[toCcy];
  if (!fromUsd || !toUsd) throw new Error(`no rate for ${a.ccy}->${toCcy}`);
  const mid = toUsd / fromUsd; // units of toCcy per unit of fromCcy
  const spread = mulBps(a, spreadBps);
  const net = a.value - spread.value;
  return { out: money(net * mid, toCcy), rate: round(mid, 6), spread };
}

export function fmt(m) {
  const n = precision(m.ccy);
  return `${m.ccy} ${m.value.toLocaleString('en-US', { minimumFractionDigits: n, maximumFractionDigits: n })}`;
}
