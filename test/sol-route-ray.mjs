// (2026-10-28, jeff HAsTKX…) a non-pump.fun coin whose indexer route names Jupiter trades through Jupiter, not a thin DLMM
// pool; the indexer can only name that PATH — a pump.fun coin, a quoted-elsewhere coin or a route for another mint never moves.
// No network: fetch is stubbed (RPC answers + the indexer's /route).
import test from 'node:test';
import assert from 'node:assert/strict';
import { solRoute, P, setSolRpcs } from '../src/solEngine.ts';

const MINT_A = 'HAsTKXYvv65zM7J6Cu5o5PcZsiKMQYo5oz4WPjgqwP6k', MINT_B = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', MINT_C = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pB263';
const b64 = (u8) => Buffer.from(u8).toString('base64');
const mintData = () => { const d = new Uint8Array(82); d[44] = 9; d[45] = 1; return d; };   // SPL mint: decimals 9, initialized
const curveData = () => { const d = new Uint8Array(160); return d; };

function stub({ route, curveOwner = null }) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u.includes('/route')) return { ok: true, status: 200, json: async () => route };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0];
      const value = keys.map((k, i) => {
        if (i === 0 && keys.length === 3) return { owner: P.token, lamports: 1, data: [b64(mintData()), 'base64'] };
        if (i === 1 && keys.length === 3 && curveOwner) return { owner: curveOwner, lamports: 1, data: [b64(curveData()), 'base64'] };
        return null;
      });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    if (body.method === 'getProgramAccounts') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: null }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('a non-pump coin whose indexer route names Jupiter routes through Jupiter (no DLMM pool, no pool from the server)', async () => {
  setSolRpcs([], []);
  const s = stub({ route: { ok: true, chain: 'sol', venue: 'jupiter', mint: MINT_A, tradeable: true, dlmm: ['ShouldNotBeUsed1111111111111111111111111111'], pool: 'JCXWfcZGjgJC8NZa5Qb6JP3cgvqW4vGUg4Tqj87G5ZnY' } });
  try {
    const r = await solRoute(MINT_A);
    assert.equal(r.venue, 'jupiter');
    assert.equal(r.pool, '', 'the server never names the pool a trade goes through');
    assert.equal(r.quote, '');
    assert.equal(r.dlmm, undefined); assert.equal(r.dlmmAlts, undefined);
    assert.equal(r.decimals, 9);
  } finally { s.restore(); }
});

test('a route for ANOTHER mint, an untradeable one, or a not-ok answer never switches the path', async () => {
  setSolRpcs([], []);
  for (const route of [{ ok: true, venue: 'jupiter', mint: MINT_C, tradeable: true }, { ok: true, venue: 'jupiter', mint: MINT_B, tradeable: false }, { ok: false, venue: 'jupiter', mint: MINT_B }]) {
    const s = stub({ route });
    try {
      await assert.rejects(solRoute(MINT_B + ''), /no Meteora DLMM pool against SOL was found|could not be verified/, JSON.stringify(route));
    } finally { s.restore(); }
  }
});

test('a pump.fun coin stays on its pump.fun market whatever the indexer route says', async () => {
  setSolRpcs([], []);
  const s = stub({ route: { ok: true, venue: 'jupiter', mint: MINT_C, tradeable: true }, curveOwner: P.pump });
  try {
    const r = await solRoute(MINT_C);
    assert.notEqual(r.venue, 'jupiter');
    assert.ok(r.venue === 'pump' || r.venue === 'pumpswap', r.venue);
  } finally { s.restore(); }
});
