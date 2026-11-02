// coins-fix (b), 2026-11-01: a pump.fun coin quoted in another pump coin that Jupiter does not route yet (pee Eyrm…, quoted in nut;
// GTA IV CTQue…, quoted in BTC-pump, for its first minutes) failed with a bare "Jupiter found no route…". The vault now names the
// quote token. Words only: the symbol comes from the indexer's answer and never decides what is signed.
// No network: fetch is stubbed (RPC answers, the indexer's /route, Jupiter's /build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { solRoute, jupBuild, quotedNoRoute, P, setSolRpcs } from '../src/solEngine.ts';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const mintData = () => { const d = new Uint8Array(82); d[44] = 6; d[45] = 1; return d; };
const quotedCurve = () => { const d = new Uint8Array(160); d.fill(7, 83, 115); return d; };   // live curve, quoteMint ≠ SOL

function stub({ route, build }) {
  const orig = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); seen.push(u);
    if (u.includes('/route')) return { ok: true, status: 200, json: async () => route };
    if (u.includes('/build')) return { ok: build.status === 200, status: build.status, json: async () => build.body };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'getMultipleAccounts' && body.params?.[1]?.dataSlice?.length === 0) return new Promise(() => {});   // the DLMM search never answers
    if (body.method === 'getMultipleAccounts') {
      const value = body.params[0].map((k, i) => (i === 0 ? { owner: P.token, lamports: 1, data: [b64(mintData()), 'base64'] } : i === 1 ? { owner: P.pump, lamports: 1, data: [b64(quotedCurve()), 'base64'] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
  };
  return { restore: () => { globalThis.fetch = orig; }, seen };
}
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

test('coins-fix (b): the route keeps the quote token\'s symbol from the indexer, and a "no route" names it', async () => {
  setSolRpcs([], []);
  const MINT = 'EyrmrJgAiqfniXdqB1L59Bw4GEJWUsjtTYSxhWUGpump';
  const s = stub({ route: { ok: true, chain: 'sol', venue: 'jupiter', mint: MINT, tradeable: true, quote: 'ERXoTjSZ58XdAdeinR4Mp9b3aQr375FvHdE9W5L2pump', quoteSymbol: 'nut' }, build: { status: 400, body: { error: 'No routes found' } } });
  try {
    const r = await solRoute(MINT);
    assert.equal(r.venue, 'jupiter');
    assert.equal(r.quoteSymbol, 'nut');
    await assert.rejects(jupBuild(r, 'buy', 50_000_000n, 12, USER), (e) => {
      assert.equal(e.message, "Can't be bought here yet: this coin is quoted in nut, and no route from SOL reaches it yet — nothing was sent");
      return true;
    });
  } finally { s.restore(); }
});

test('coins-fix (b): a symbol that is not plain text is dropped (the mint\'s first letters stand in); a 429 still reads "busy"', async () => {
  setSolRpcs([], []);
  const MINT = 'CTQueM31p5h9GMjFEARgA63Vw62AFSj5bAvVsgHkpump';
  const s = stub({ route: { ok: true, chain: 'sol', venue: 'jupiter', mint: MINT, tradeable: true, quoteSymbol: '<img src=x onerror=alert(1)>' }, build: { status: 429, body: {} } });
  try {
    const r = await solRoute(MINT);
    assert.equal(r.quoteSymbol, '');
    assert.match(quotedNoRoute(r), /quoted in [1-9A-HJ-NP-Za-km-z]{4}…, and no route from SOL/);
    await assert.rejects(jupBuild(r, 'buy', 50_000_000n, 12, USER), /Jupiter is busy right now/);
  } finally { s.restore(); }
});

test('coins-fix (b): a Jupiter route with no quote token (a non-pump coin) keeps the old words', async () => {
  const r = { mint: 'HAsTKXq3nYFkeeqgKwxhNWkUjNN3uSYdezjrAHdnpump', venue: 'jupiter', tokenProgram: P.token, decimals: 6, symbol: 'jeff', pool: '', isCashback: false, isMayhem: false, quote: '' };
  const s = stub({ route: {}, build: { status: 400, body: { error: 'No routes found' } } });
  try { await assert.rejects(jupBuild(r, 'buy', 50_000_000n, 12, USER), /^Error: Jupiter found no route for this coin right now — nothing was sent; try again$/); }
  finally { s.restore(); }
});
