#!/usr/bin/env node
// demo.js — run every scenario through the control plane and print the traces. `node src/cli/demo.js [scenarioId] [knobId=optionIndex ...]`
import { ControlPlane } from '../engine/controlplane.js';
import { renderTrace } from '../engine/trace.js';
import { buildIntent } from '../engine/scenario.js';
import { loadPolicies, loadPartners, loadScenarios } from '../engine/load.js';

const partners = loadPartners();
const cp = new ControlPlane({ policies: loadPolicies(), partners });
const scenarios = loadScenarios();
const [, , which, ...pairs] = process.argv;
const selection = Object.fromEntries(pairs.map(p => { const [k, v] = p.split('='); return [k, +v]; }));
const order = ['marketplace', 'usdc', 'prediction', 'perps', 'agent', 'gaming'];
const list = which ? scenarios.filter(s => s.id === which) : order.map(id => scenarios.find(s => s.id === id));
for (const s of list) {
  const intent = buildIntent(s, selection);
  const t = cp.evaluate(intent, { now: '2026-09-23T09:00:00Z' });
  console.log(`\n=== ${s.name} — ${s.sub}\n`);
  console.log(renderTrace(t, partners));
}
