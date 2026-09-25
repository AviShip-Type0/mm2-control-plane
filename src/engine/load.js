// load.js — Node-only loader for policies, partners and scenarios from disk (the browser bundle embeds them).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export function loadPolicies() { return readdirSync(join(root, 'policies')).filter(f => f.endsWith('.json')).map(f => readJson(join(root, 'policies', f))); }
export function loadPartners() { return readJson(join(root, 'partners', 'appetite.json')); }
export function loadScenarios() { return readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json')).map(f => readJson(join(root, 'scenarios', f))); }
export { root };
