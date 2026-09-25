#!/usr/bin/env node
// server.js — a minimal HTTP surface over the engine (no framework). `node src/api/server.js` then:
//   curl -s -X POST localhost:8402/api/mm2/v1/client/demo/payouts -H 'x-request-id: 1' -H 'content-type: application/json' -d @scenarios/gaming.json
// Implements a subset of api/openapi.yaml: POST payouts (accepts a raw intent or a scenario file with a `selection`), GET trace, policies, appetite.
import http from 'node:http';
import { ControlPlane } from '../engine/controlplane.js';
import { buildIntent } from '../engine/scenario.js';
import { loadPolicies, loadPartners, loadScenarios } from '../engine/load.js';

const partners = loadPartners();
const cp = new ControlPlane({ policies: loadPolicies(), partners });
const scenarios = loadScenarios();
const idem = new Map();
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/mm2\/v1\/client\/([^/]+)\/(.+)$/);
  if (!m) return json(res, 404, { error: 'not found' });
  const [, clientHashId, rest] = m;
  if (req.method === 'GET' && rest === 'policies') return json(res, 200, cp.policies);
  if (req.method === 'GET' && rest === 'partners/appetite') return json(res, 200, partners);
  if (req.method === 'GET' && rest === 'scenarios') return json(res, 200, scenarios.map(s => ({ id: s.id, name: s.name, knobs: s.knobs.map(k => ({ id: k.id, label: k.label, options: k.options.map(o => o.label) })) })));
  if (req.method === 'GET' && rest.startsWith('payouts/')) { const t = cp.traces.get(rest.slice(8)); return t ? json(res, 200, t) : json(res, 404, { error: 'unknown trace' }); }
  if (req.method === 'POST' && rest === 'payouts') {
    const key = req.headers['x-request-id'];
    if (!key) return json(res, 400, { code: 'field_missing', field: 'x-request-id', description: 'x-request-id is required (idempotency key)' });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        if (idem.has(key)) { const prev = idem.get(key); if (prev.body !== body) return json(res, 409, { error: 'x-request-id reused with a different body' }); return json(res, 200, prev.trace); }
        const parsed = JSON.parse(body);
        const intent = parsed.intent && parsed.knobs ? buildIntent(parsed, parsed.selection || {}) : parsed;
        if (!intent.flow || !intent.amount || !intent.source || !intent.beneficiary) return json(res, 400, { code: 'field_missing', description: 'flow, amount, source, beneficiary are required' });
        intent.clientHashId = clientHashId;
        const trace = cp.evaluate(intent);
        idem.set(key, { body, trace });
        json(res, 200, trace);
      } catch (e) { json(res, 400, { code: 'validation_error', description: e.message }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});
const port = process.env.PORT || 8402;
server.listen(port, () => console.log(`mm2 control plane listening on :${port} (HTTP 402 would have been on-brand, 8402 will do)`));
