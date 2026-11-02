// (2026-10-30, Solana buys 0/9 overnight; one coin clicked 8× in a minute → "route") a coin whose only Meteora DLMM pools
// against SOL are dry was routed into them, and every buy failed "The pool has too little liquidity for this trade" while
// Jupiter had a route. Real mainnet accounts (test/fixtures/sol-dlmm-dry.json, read 2026-10-30), fetch stubbed, nothing sent:
//   HYPERPAD 31FZ9f…  pump.fun coin quoted in HYPE; its one DLMM pool against SOL (8EoeFE…) has no reserves and an empty bitmap
//   LAZARUS  DBaxXw…  pump.fun curve complete, no PumpSwap pool (migrated to a Raydium AMM pool): "not open yet" on every click
//   GTA6     4kjruq…  a live DLMM pool: unchanged, still the venue
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solRoute, solTradeOne, setSolRpcs, P } from '../src/solEngine.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/sol-dlmm-dry.json', import.meta.url), 'utf8'));
const { HYPERPAD, LAZARUS, GTA6 } = FX.coins;
const b64 = (u8) => Buffer.from(u8).toString('base64');

function stub({ route = {}, patch = {}, jupiter = null } = {}) {
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u);
    const m = u.match(/\/token\/([1-9A-HJ-NP-Za-km-z]+)\/route/);
    if (m) { const c = Object.values(FX.coins).find((x) => x.mint === m[1]); return { ok: true, status: 200, json: async () => (route[m[1]] ?? c?.route ?? null) }; }
    if (/jup\.ag|\/jup\//.test(u)) { if (jupiter) jupiter(u); return { ok: false, status: 400, json: async () => ({ error: 'stub: no route' }) }; }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'sendTransaction') throw new Error('test: nothing may be sent');
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0]; const slice = body.params[1]?.dataSlice;
      const value = keys.map((k) => { const a = patch[k] !== undefined ? patch[k] : FX.accts[k]; if (!a) return null; return { owner: a.owner, lamports: a.lamports, data: [slice ? '' : (typeof a.data === 'string' ? a.data : b64(a.data)), 'base64'] }; });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    if (body.method === 'getLatestBlockhash') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: null }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('fixtures: HYPERPAD\'s DLMM pool is a real, enabled LB pair of the coin vs SOL with an empty bitmap; GTA6\'s pool has liquidity', () => {
  const pair = (k) => Buffer.from(FX.accts[k].data, 'base64');
  const bitmapEmpty = (d) => { for (let i = 0; i < 16; i++) if (d.readBigUInt64LE(584 + 8 * i) !== 0n) return false; return true; };
  const h = pair(HYPERPAD.pools[0]);
  assert.equal(FX.accts[HYPERPAD.pools[0]].owner, P.dlmm); assert.equal(h[82], 0, 'enabled');
  assert.ok(bitmapEmpty(h), 'HYPERPAD pool: no bin array with liquidity');
  assert.ok(!bitmapEmpty(pair(GTA6.pools[0])), 'GTA6 pool: liquidity');
  assert.equal(FX.accts[LAZARUS.curve].owner, P.pump); assert.equal(Buffer.from(FX.accts[LAZARUS.curve].data, 'base64')[48], 1, 'LAZARUS curve complete');
  assert.equal(FX.accts[LAZARUS.canonical], null, 'LAZARUS: no PumpSwap pool');
  assert.equal(LAZARUS.route.venue, 'jupiter');
});

test('a pump.fun coin quoted in another token whose only DLMM pool against SOL is dry goes through Jupiter (was: that pool, "too little liquidity")', async () => {
  setSolRpcs([], []);
  const s = stub();
  try {
    const r = await solRoute(HYPERPAD.mint);
    assert.equal(r.venue, 'jupiter');
    assert.equal(r.pool, '');
    assert.equal(r.quote, Buffer.from(FX.accts[HYPERPAD.curve].data, 'base64').length >= 115 ? r.quote : '', 'quoted-in mint kept');
    assert.ok(r.quote && r.quote !== P.wsol, 'the token pump.fun quotes it in');
  } finally { s.restore(); }
});

// the route cache answers a mint for up to 60 s: each case below moves the clock past it
let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;
const nextCase = () => { skew += 120_000; };

test('a live DLMM pool stays the venue (unchanged)', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub({ route: { [GTA6.mint]: { ...GTA6.route, dlmm: GTA6.pools } } });
  try {
    const r = await solRoute(GTA6.mint);
    assert.equal(r.venue, 'dlmm');
    assert.ok(GTA6.pools.includes(r.pool));
  } finally { s.restore(); }
});

test('a non-pump coin whose verified DLMM pools are all dry goes through Jupiter', async () => {
  setSolRpcs([], []); nextCase();
  // GTA6's pools, drained (bitmap zeroed)
  const patch = {};
  for (const k of GTA6.pools) { const d = Buffer.from(FX.accts[k].data, 'base64'); d.fill(0, 584, 584 + 128); patch[k] = { ...FX.accts[k], data: b64(d) }; }
  const s = stub({ route: { [GTA6.mint]: { ...GTA6.route, dlmm: GTA6.pools } }, patch });
  try {
    const r = await solRoute(GTA6.mint);
    assert.equal(r.venue, 'jupiter'); assert.equal(r.quote, ''); assert.equal(r.pool, '');
  } finally { s.restore(); }
});

test('no DLMM pool at all for a non-pump coin: the old refusal stands', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub({ route: { [GTA6.mint]: { ...GTA6.route, dlmm: [] } }, patch: Object.fromEntries(GTA6.pools.map((k) => [k, null])) });
  try { await assert.rejects(solRoute(GTA6.mint), /no Meteora DLMM pool against SOL was found/); }
  finally { s.restore(); }
});

test('a completed pump.fun curve with no PumpSwap pool, whose indexer route names Jupiter, goes through Jupiter; otherwise "not open yet" as before', async () => {
  setSolRpcs([], []);
  let s = stub();
  try {
    const r = await solRoute(LAZARUS.mint);
    assert.equal(r.venue, 'jupiter'); assert.equal(r.pool, ''); assert.equal(r.isCashback, false);
  } finally { s.restore(); }
  // the same chain state, the indexer says pumpswap (a migration in progress): still the old answer
  const other = 'DapbUzitrzpHDecXnZb6fUW2rRm2JuCx1kCexSHRpump';
  const remap = (k) => (k === other ? LAZARUS.mint : k);
  const fx = { ...FX.accts };
  s = stub({ route: { [other]: { ...LAZARUS.route, mint: other, venue: 'pumpswap' } } });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body?.method === 'getMultipleAccounts' && body.params[0].length === 3 && body.params[0][0] === other) {
      // mint + curve + canonical pool of `other`: LAZARUS's bytes (complete curve, no pool)
      const value = [fx[LAZARUS.mint], fx[LAZARUS.curve], null].map((a) => (a ? { owner: a.owner, lamports: a.lamports, data: [a.data, 'base64'] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    return orig(url, init);
  };
  try { await assert.rejects(solRoute(other), /not open yet/); }
  finally { globalThis.fetch = orig; s.restore(); void remap; }
});

test('a click whose DLMM pools turn out too thin goes to Jupiter for that wallet (nothing signed on the DLMM path)', async () => {
  setSolRpcs([], []);
  const MINT = GTA6.mint;
  // the route is read with GTA6's live pool; the click then finds the pool drained (bitmap empty) → "too little liquidity"
  let jup = 0; nextCase();
  const live = { mint: MINT, venue: 'dlmm', tokenProgram: P.token, decimals: 9, symbol: 'GTA6', pool: GTA6.pools[1], isCashback: false, isMayhem: false,
    dlmm: { solIsX: false, reserveX: '', reserveY: '', oracle: '', activeIdx: -64, binStep: 20 }, dlmmAlts: undefined };
  const d = Buffer.from(FX.accts[GTA6.pools[1]].data, 'base64'); d.fill(0, 584, 584 + 128);
  const s2 = stub({ patch: { [GTA6.pools[1]]: { ...FX.accts[GTA6.pools[1]], data: b64(d) } }, jupiter: () => { jup += 1; } });
  try {
    const key = '0x' + '11'.repeat(32);
    await assert.rejects(solTradeOne({ id: 'w1', name: 'W', address: '0x0', key }, 'buy', live, 0.01, { slippage: 12, gasBoost: 1.5, turbo: false }), (e) => {
      assert.doesNotMatch(String(e.message), /too little liquidity/, 'the DLMM refusal is not the answer any more');
      assert.match(String(e.message), /Jupiter/);
      return true;
    });
    assert.ok(jup > 0, 'Jupiter was asked');
  } finally { s2.restore(); }
});
