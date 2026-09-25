// scenario.js — helpers shared by the CLI, the tests and the browser demo: deep-merge knob patches into a base intent.

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  for (const k of Object.keys(patch)) out[k] = (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) ? deepMerge(out[k], patch[k]) : (Array.isArray(patch[k]) ? patch[k].slice() : patch[k]);
  return out;
}

/** Build an intent from a scenario and a selection map {knobId: optionIndex}. Unselected knobs use option 0. */
export function buildIntent(scenario, selection = {}) {
  let intent = deepMerge({}, scenario.intent);
  for (const knob of scenario.knobs || []) {
    const idx = selection[knob.id] ?? 0;
    const opt = knob.options[idx] || knob.options[0];
    intent = deepMerge(intent, opt.patch || {});
  }
  intent.id = `${intent.id}-${Object.entries(selection).map(([k, v]) => `${k}${v}`).join('') || 'base'}`;
  return intent;
}
