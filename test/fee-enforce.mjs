// Release 19 (fee enforcement): a legacy BUY on a market the terminal fee covers is refused at the engine dispatch boundary; an
// uncovered market and every SELL run exactly as before. Runs the REAL engine.buy / engine.sell / engine.float / buyCovered
// declarations cut out of src/webEngine.ts, and the real src/terminalFeeGate.ts + src/terminalFeeCoverage.ts.
//   node --experimental-strip-types --test test/fee-enforce.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cut, source } from './sec-cut.mjs';
import { gatedBuy, gatedCall, assertLegacyTerminalAllowed, enforcedOn } from '../src/terminalFeeGate.ts';
import { COVERED_TOKENS, evmCovered, solCovered, nativePonsRoute } from '../src/terminalFeeCoverage.ts';
import { TERMINAL_EVM_POLICY, TERMINAL_EVM_PONS_V2 } from '../src/terminalEvmConfig.ts';
import { TERMINAL_SOL_POLICY } from '../src/terminalFeeConfig.ts';
import { terminalMarketKey } from '../src/terminal-evm/vault-guard.mjs';

const table = (n) => JSON.parse(readFileSync(new URL(`./fixtures/fee-enforce/routes-${n}.json`, import.meta.url), 'utf8')).routes;
const RH_TOKEN = table('robinhood').find((e) => e.route.type === 'v4').token.toLowerCase();
const BSC_FLAP = table('bsc').find((e) => e.route.type === 'flap').token.toLowerCase();
const OTHER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
const PONS = { type: 'pons', chainId: 4663, curve: '0x2222222222222222222222222222222222222222', pairToken: ZERO, feeBps: 100, creatorTaxBps: 0, bridgeFee: 0, bridgeHops: [], bridgeFees: [] };
const SW = { ponsV2: true };

test('switches: enforcement ON for robinhood, bsc, sol only; limit.place and relaySwap stay open (decision 15)', async () => {
  for (const c of ['robinhood', 'bsc', 'sol']) assert.equal(enforcedOn(c), true, c);
  for (const c of ['elysium', 'near', 'arc', 'unknown', '__proto__']) assert.equal(enforcedOn(c), false, c);
  for (const c of ['robinhood', 'bsc', 'sol']) {
    assert.doesNotThrow(() => assertLegacyTerminalAllowed(c, 'limit.place'));
    assert.doesNotThrow(() => assertLegacyTerminalAllowed(c, 'relaySwap'));
    assert.equal(await gatedCall(c, 'limit.place', async () => 'placed'), 'placed');
  }
});

test('coverage lists = the quote route tables, and every table market key is deployment-approved', () => {
  for (const n of ['robinhood', 'bsc']) {
    const t = table(n);
    assert.deepEqual([...COVERED_TOKENS[n]].sort(), t.map((e) => e.token.toLowerCase()).sort(), n);
    const keys = new Set(TERMINAL_EVM_POLICY[n].marketKeys);
    for (const e of t) assert.ok(keys.has(terminalMarketKey(e.token, e.route)), `${n} ${e.token} key not in marketKeys`);
    assert.equal(keys.size, t.length, `${n}: every approved key has its table entry`);
  }
  assert.ok(TERMINAL_EVM_PONS_V2 && TERMINAL_EVM_POLICY.robinhood.ponsV2.enabled, 'Pons V2 on (Robinhood Pons curves covered)');
  assert.ok(TERMINAL_SOL_POLICY, 'Solana terminal policy pinned');
});

test('evmCovered: table coin covered on any route; Pons native curve covered on Robinhood only; the rest fee-free', () => {
  assert.equal(evmCovered('robinhood', RH_TOKEN, undefined, SW), true);
  assert.equal(evmCovered('robinhood', RH_TOKEN.toUpperCase().replace('0X', '0x'), undefined, SW), true);
  assert.equal(evmCovered('bsc', BSC_FLAP, undefined, SW), true);
  assert.equal(evmCovered('bsc', RH_TOKEN, undefined, SW), false, 'a Robinhood table coin is not a BNB market');
  assert.equal(evmCovered('robinhood', OTHER, undefined, SW), undefined, 'not in the table: the route decides');
  assert.equal(evmCovered('robinhood', OTHER, PONS, SW), true);
  assert.equal(evmCovered('robinhood', OTHER, PONS, { ponsV2: false }), false);
  assert.equal(evmCovered('robinhood', OTHER, { ...PONS, pairToken: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }, SW), false, 'stock-pair Pons: no fee path');
  assert.equal(evmCovered('robinhood', OTHER, { ...PONS, bridgeHops: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'] }, SW), false);
  for (const type of ['v4', 'v3', 'v2', 'standard', 'flap', 'four', 'inf']) assert.equal(evmCovered('robinhood', OTHER, { type }, SW), false, type);
  assert.equal(evmCovered('bsc', OTHER, undefined, SW), false, 'BNB: no factory-wide market (four.meme / V3 / Infinity / new coins fee-free)');
  assert.equal(evmCovered('bsc', OTHER, PONS, SW), false);
  assert.equal(evmCovered('robinhood', OTHER, null, SW), false);
  assert.equal(evmCovered('robinhood', 'not-an-address', PONS, SW), false);
  assert.equal(evmCovered('elysium', RH_TOKEN, PONS, SW), false);
  assert.equal(nativePonsRoute({ ...PONS, bridgeFee: 100 }), false);
});

// release 20: + pump.fun curve and PumpSwap (the Jupiter fee path routes them; test/fee-coverage.mjs)
test('solCovered: Jupiter, pump.fun curve, PumpSwap', () => {
  for (const venue of ['jupiter', 'pump', 'pumpswap']) assert.equal(solCovered({ venue }), true, venue);
  for (const venue of ['pumphop', 'dlmm', undefined]) assert.equal(solCovered({ venue }), false, String(venue));
  assert.equal(solCovered(null), false);
});

test('gatedBuy: covered = refused before run; uncovered = run; promise and throw paths; switch off = never asks', async () => {
  let ran = 0; const run = async () => { ran += 1; return 'sent'; };
  await assert.rejects(gatedBuy('robinhood', 'trade', () => true, run), (e) => e.code === 'TerminalPolicyRequired' && /0\.2% trading fee/.test(e.message));
  assert.equal(ran, 0);
  assert.equal(await gatedBuy('robinhood', 'trade', () => false, run), 'sent');
  await assert.rejects(gatedBuy('sol', 'trade', () => Promise.resolve(true), run), /fee path/);
  assert.equal(await gatedBuy('sol', 'trade', () => Promise.resolve(false), run), 'sent');
  assert.equal(await gatedBuy('bsc', 'trade', () => Promise.reject(new Error('read failed')), run), 'sent', 'unreadable market: the legacy trade decides');
  assert.equal(await gatedBuy('bsc', 'trade', () => { throw new Error('bad'); }, run), 'sent');
  await assert.rejects(gatedBuy('bsc', 'float.buy', () => true, run), /USD balance/);
  let asked = false;
  assert.equal(await gatedBuy('elysium', 'trade', () => { asked = true; return true; }, run), 'sent');
  assert.equal(asked, false);
  assert.equal(ran, 5);
});

// ── the real dispatch (engine.buy / engine.sell / engine.float.buy / buyCovered) ──
function world({ lane = 'robinhood', own = null, read = null, solRoute = null, mode = 'evm' } = {}) {
  const calls = { trade: [], usdBuy: [], reads: 0, sol: 0 };
  const stubs = {
    gatedBuy, gatedCall, evmCovered, solCovered,
    SOL_MODE: mode === 'sol', NEAR_MODE: false, CFG: { key: lane },
    SOL_ADDR: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    TERMINAL_EVM_PONS_V2: true, TERMINAL_EVM_POLICY,
    laneKey: () => (mode === 'sol' ? 'sol' : lane),
    lc: (x) => String(x).toLowerCase(),
    ownRouteNow: () => own,
    refreshOwnRoute: () => { calls.reads += 1; return read ? read() : Promise.resolve(null); },
    solRoute: (mint, hint) => { calls.sol += 1; return solRoute ? solRoute(mint, hint) : Promise.reject(new Error('no route')); },
    clickRun: (fn) => fn(),
    trade: async (side, token) => { calls.trade.push([side, token]); return { results: [{ ok: true }] }; },
    usdBuy: async (o) => { calls.usdBuy.push(o); return { ok: true }; },
    float: { status: 0, configure: 0, sweep: 0, off: 0, jobs: 0, earn: 0, convert: 0, withdraw: 0 },
    floatEnsure: () => 0,
  };
  // engine.float's literal reads the module's own `float` object: renamed property, same bytes for its methods
  const text = source().replace('  float: { status: float.status,', '  floatApi: { status: float.status,');
  const got = cut(['hintRoute', 'buyCovered', 'engine.buy', 'engine.sell', 'engine.floatApi'], stubs, text);
  return { ...got, float: got.floatApi, calls };
}

test('engine.buy: a table coin is refused without trading; an uncovered coin trades; sells always trade', async () => {
  const w = world();
  await assert.rejects(w.buy(RH_TOKEN, 0.1, ['a']), { code: 'TerminalPolicyRequired' });
  assert.deepEqual(w.calls.trade, []);
  assert.equal(w.calls.reads, 0, 'a table coin needs no route read');
  await w.sell(RH_TOKEN, 100, ['a']);
  assert.deepEqual(w.calls.trade, [['sell', RH_TOKEN]]);
  await w.buy(OTHER, 0.1, ['a']);
  assert.deepEqual(w.calls.trade.at(-1), ['buy', OTHER]);
  assert.equal(w.calls.reads, 1, 'cold: the vault\'s own read (shared with the click)');
});

test('engine.buy on Robinhood Pons: decided on the vault\'s own route, the hint only when that read gives nothing', async () => {
  const warm = world({ own: PONS });
  await assert.rejects(warm.buy(OTHER, 0.1), { code: 'TerminalPolicyRequired' });
  assert.equal(warm.calls.reads, 0, 'warm copy: no read, no await on the network');
  const cold = world({ read: () => Promise.resolve(PONS) });
  await assert.rejects(cold.buy(OTHER, 0.1, undefined, { ok: true, route: { type: 'v3' } }), { code: 'TerminalPolicyRequired' }, 'a page hint naming another venue does not decide over the vault\'s own route');
  const dead = world({ read: () => Promise.resolve(null) });
  await assert.rejects(dead.buy(OTHER, 0.1, undefined, { ok: true, route: PONS }), { code: 'TerminalPolicyRequired' });
  const dead2 = world({ read: () => Promise.reject(new Error('down')) });
  await dead2.buy(OTHER, 0.1, undefined, { ok: true, route: { type: 'v3' } });
  assert.deepEqual(dead2.calls.trade, [['buy', OTHER]]);
  const v4 = world({ own: { type: 'v4' } });
  await v4.buy(OTHER, 0.1);
  assert.deepEqual(v4.calls.trade, [['buy', OTHER]], 'a V4 coin outside the table stays fee-free');
});

// release 20: a BNB coin outside the table is decided on the vault's own route (registry classes), like a Robinhood Pons coin
test('engine.buy on BNB: table coins refused with no read; other coins by the vault own route (registry class refused, the rest trades)', async () => {
  const w = world({ lane: 'bsc' });
  await assert.rejects(w.buy(BSC_FLAP, 0.1), { code: 'TerminalPolicyRequired' });
  assert.equal(w.calls.reads, 0, 'a table coin needs no route read');
  await w.buy(OTHER, 0.1);
  assert.deepEqual(w.calls.trade, [['buy', OTHER]], 'no route: the legacy trade decides');
  assert.equal(w.calls.reads, 1, "cold: the vault's own read (shared with the click)");
  const V2 = { type: 'v2', chainId: 56, router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', pool: '0x' + '3'.repeat(40), quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', path: ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', OTHER], quoteSymbol: '', bridgeHops: [], bridgeFees: [] };
  const v2 = world({ lane: 'bsc', own: V2 });
  await assert.rejects(v2.buy(OTHER, 0.1), { code: 'TerminalPolicyRequired' });
  assert.equal(v2.calls.reads, 0, 'warm copy: no read');
  const inf = world({ lane: 'bsc', own: { type: 'inf', chainId: 56 } });
  await inf.buy(OTHER, 0.1);
  assert.deepEqual(inf.calls.trade, [['buy', OTHER]], 'Infinity stays fee-free');
});

test('engine.buy on Solana: Jupiter / pump.fun / PumpSwap routes refused, pumphop / DLMM trade; sells never read the route', async () => {
  const MINT = 'So1aNaMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, '2');
  const jup = world({ mode: 'sol', solRoute: async () => ({ venue: 'jupiter' }) });
  await assert.rejects(jup.buy(MINT, 0.1), { code: 'TerminalPolicyRequired' });
  assert.deepEqual(jup.calls.trade, []);
  await jup.sell(MINT, 50);
  assert.deepEqual(jup.calls.trade, [['sell', MINT]]);
  assert.equal(jup.calls.sol, 1, 'only the buy asked for the route');
  for (const venue of ['pump', 'pumpswap']) {
    const w = world({ mode: 'sol', solRoute: async () => ({ venue }) });
    await assert.rejects(w.buy(MINT, 0.1), { code: 'TerminalPolicyRequired' }, venue);
    assert.deepEqual(w.calls.trade, [], venue);
  }
  for (const venue of ['pumphop', 'dlmm']) {
    const w = world({ mode: 'sol', solRoute: async () => ({ venue }) });
    await w.buy(MINT, 0.1);
    assert.deepEqual(w.calls.trade, [['buy', MINT]], venue);
  }
  const none = world({ mode: 'sol' });
  await none.buy(MINT, 0.1);
  assert.deepEqual(none.calls.trade, [['buy', MINT]], 'no route: the legacy trade reports it itself');
});

test('engine.float.buy: same market rule (USD-balance buy has no fee path)', async () => {
  const w = world();
  await assert.rejects(w.float.buy({ token: RH_TOKEN, usd: 5 }), /USD balance/);
  assert.deepEqual(w.calls.usdBuy, []);
  await w.float.buy({ token: OTHER, usd: 5, hint: { ok: true, route: { type: 'v4' } } });
  assert.equal(w.calls.usdBuy.length, 1);
});

test('the dispatch source: sell has no gate, buy and float.buy go through gatedBuy, limit/relay keep the chain-wide check', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const line = (re) => src.split('\n').find((l) => re.test(l)) || '';
  assert.match(line(/^\s+sell: \(token: string, percent/), /=> clickRun\(\(\) => trade\('sell'/);
  assert.doesNotMatch(line(/^\s+sell: \(token: string, percent/), /gate/i);
  assert.match(line(/^\s+buy: \(token: string, amount/), /gatedBuy\(laneKey\(\), 'trade'/);
  assert.match(line(/^\s+float: \{ status/), /gatedBuy\(laneKey\(\), 'float\.buy'/);
  assert.match(src, /const legacyOrFeeLeg = .*gatedCall\(lane, surface, run\)/);
});
