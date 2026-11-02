// fix2 p2-speed-10 (2026-11-01): a pump.fun coin quoted in another token (the "buni" coins) whose indexer route — the vault's own
// read — names Jupiter and no DLMM pool waited for the vault's on-chain DLMM search (5× getMultipleAccounts, 0.5–1.7 s each) before
// it settled on Jupiter anyway: a cold Solana route 1.2–2.1 s. Now it goes to Jupiter without waiting; the search still runs.
// A quoted coin whose indexer names DLMM pools, or names no Jupiter path, waits for the search exactly as before.
// No network: fetch is stubbed (RPC answers + the indexer's /route); the DLMM search never answers here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solRoute, P, setSolRpcs } from '../src/solEngine.ts';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const mintData = () => { const d = new Uint8Array(82); d[44] = 6; d[45] = 1; return d; };
const quotedCurve = () => { const d = new Uint8Array(160); d.fill(7, 83, 115); return d; };   // live curve, quoteMint ≠ SOL

function stub({ route }) {
  const orig = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/route')) return { ok: true, status: 200, json: async () => route };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'getMultipleAccounts' && body.params?.[1]?.dataSlice?.length === 0) { searches += 1; return new Promise(() => {}); }   // the DLMM search: never answers
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0];
      const value = keys.map((k, i) => (i === 0 ? { owner: P.token, lamports: 1, data: [b64(mintData()), 'base64'] } : i === 1 ? { owner: P.pump, lamports: 1, data: [b64(quotedCurve()), 'base64'] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
  };
  return { restore: () => { globalThis.fetch = orig; }, searches: () => searches };
}
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms))]);

test('p2-speed-10: a quoted pump.fun coin the indexer routes through Jupiter (no DLMM pool named) does not wait for the DLMM search', async () => {
  setSolRpcs([], []);
  const MINT = '5f1RtDDzQy5wQxgsHBbRshfGns1Bpq1f7vGigMMtpump';
  const s = stub({ route: { ok: true, chain: 'sol', venue: 'jupiter', mint: MINT, tradeable: true } });
  try {
    const r = await within(solRoute(MINT), 1500);
    assert.equal(r.venue, 'jupiter');
    assert.ok(r.quote && r.quote !== P.wsol, 'Jupiter routes SOL → the quote token → the coin');
    assert.equal(r.pool, ''); assert.equal(r.dlmm, undefined);
    for (let i = 0; i < 40 && !s.searches(); i += 1) await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(s.searches() >= 1, 'the search still runs behind it');
  } finally { s.restore(); }
});

test('p2-speed-10: a quoted coin whose indexer names no Jupiter path still waits for the vault\'s own DLMM search (unchanged)', async () => {
  setSolRpcs([], []);
  const MINT = '3aKuEDCKiXGyUAqnsQPGXceNs5ePQ1wuQcQJpLJUpump';
  const s = stub({ route: { ok: true, chain: 'sol', venue: 'pump', mint: MINT, tradeable: true } });
  try {
    await assert.rejects(within(solRoute(MINT), 400), /still waiting/);
  } finally { s.restore(); }
});
