// Release 19 (fee enforcement): a legacy BUY on a market the terminal fee covers is refused at the engine dispatch boundary; an
// uncovered market and every SELL run exactly as before. Runs the REAL engine.buy / engine.sell / engine.float / buyCovered
// declarations cut out of src/webEngine.ts, and the real src/terminalFeeGate.ts + src/terminalFeeCoverage.ts.
//   node --experimental-strip-types --test test/fee-enforce.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cut, source } from './sec-cut.mjs';
import { gatedBuy, gatedCall, assertLegacyTerminalAllowed, enforcedOn, GATE_MODE, fallbackBody, sizeBucket, createFallbackReporter } from '../src/terminalFeeGate.ts';
import { COVERED_TOKENS, evmCovered, solCovered, evmCoverVenue, solCoverVenue, gateRegistry, nativePonsRoute } from '../src/terminalFeeCoverage.ts';
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

// Release 20, owner 2026-11-09: OBSERVE mode — no buy is refused; a covered-market buy on the legacy path runs at once and is
// reported (venue label) after the click has started. ENFORCE (release 19) stays testable through the `mode` argument.
const settle = () => new Promise((r) => setTimeout(r, 5));
test('gatedBuy OBSERVE (this build): runs at once, classifies after, reports a covered market; nothing is refused', async () => {
  assert.equal(GATE_MODE, 'observe');
  let ran = 0, order = []; const run = async () => { ran += 1; order.push('run'); return 'sent'; };
  const seen = [];
  const rep = (v) => { seen.push(v); order.push('report'); };
  assert.equal(await gatedBuy('robinhood', 'trade', () => { order.push('ask'); return 'table'; }, run, rep), 'sent');
  await settle();
  assert.deepEqual(order, ['run', 'ask', 'report'], 'the click starts before anything is asked');
  assert.equal(await gatedBuy('sol', 'trade', () => Promise.resolve('pump'), run, rep), 'sent');
  assert.equal(await gatedBuy('bsc', 'trade', () => null, run, rep), 'sent');
  assert.equal(await gatedBuy('bsc', 'trade', () => Promise.reject(new Error('read failed')), run, rep), 'sent');
  assert.equal(await gatedBuy('bsc', 'trade', () => { throw new Error('bad'); }, run, rep), 'sent');
  assert.equal(await gatedBuy('bsc', 'float.buy', () => true, run, () => { throw new Error('reporter broke'); }), 'sent', 'a broken reporter never touches the trade');
  let asked = false;
  assert.equal(await gatedBuy('elysium', 'trade', () => { asked = true; return 'table'; }, run, rep), 'sent');
  await settle();
  assert.equal(asked, false);
  assert.deepEqual(seen, ['table', 'pump']);
  assert.equal(ran, 7);
  const fail = async () => { throw new Error('legacy trade error'); };
  await assert.rejects(gatedBuy('robinhood', 'trade', () => 'table', fail, rep), /legacy trade error/, 'the trade outcome is the trade\'s own');
});
test('gatedBuy ENFORCE (kept for a later build): covered = refused before run', async () => {
  let ran = 0; const run = async () => { ran += 1; return 'sent'; };
  await assert.rejects(gatedBuy('robinhood', 'trade', () => 'table', run, undefined, 'enforce'), (e) => e.code === 'TerminalPolicyRequired' && /0\.2% trading fee/.test(e.message));
  await assert.rejects(gatedBuy('sol', 'trade', () => Promise.resolve(true), run, undefined, 'enforce'), /fee path/);
  assert.equal(await gatedBuy('sol', 'trade', () => Promise.resolve(null), run, undefined, 'enforce'), 'sent');
  assert.equal(await gatedBuy('bsc', 'trade', () => Promise.reject(new Error('x')), run, undefined, 'enforce'), 'sent');
  await assert.rejects(gatedBuy('bsc', 'float.buy', () => 'v2', run, undefined, 'enforce'), /USD balance/);
  assert.equal(ran, 2);
});
test('fallback line: chain, venue, reason, size bucket only; one per kind per load, at most 12', () => {
  const body = JSON.parse(fallbackBody('robinhood', 'v4-launcher', 'turbo', sizeBucket(0.05), 'engine-r20'));
  assert.deepEqual(body, { scope: 'fee-fallback', summary: 'engine robinhood buy v4-launcher turbo 0.01-0.1', stack: '', componentStack: '', path: '', build: 'engine-r20' });
  assert.equal(JSON.parse(fallbackBody('sol', 'a b/c"d e', 'no-fee-path', 'na', 'x')).summary, 'engine sol buy abcde no-fee-path na', 'labels are reduced to a safe alphabet');
  assert.doesNotMatch(fallbackBody('bsc', '0x' + 'ab'.repeat(20), 'turbo', 'na', 'x'), /0x[0-9a-f]{40}/, 'labels are cut to 24 characters (no address fits)');
  assert.deepEqual(['<0.01', '0.01-0.1', '0.1-1', '1-10', '>=10', 'na'], [0.001, 0.05, 0.5, 5, 50, -1].map((x) => sizeBucket(x)));
  assert.equal(sizeBucket(25, 'usd'), 'usd10-100');
  const posted = [];
  const r = createFallbackReporter({ post: (b) => posted.push(b) });
  assert.equal(r('bsc', 'v2', 'turbo', '<0.01'), true);
  assert.equal(r('bsc', 'v2', 'turbo', '<0.01'), false, 'same kind once per load');
  for (let i = 0; i < 20; i++) r('bsc', 'v2', 'turbo', 'b' + i);
  assert.equal(posted.length, 12);
  const throwing = createFallbackReporter({ post: () => { throw new Error('net'); } });
  assert.equal(throwing('sol', 'pump', '2fa', 'na'), false, 'never throws');
  for (const p of posted) assert.doesNotMatch(p, /0x[0-9a-f]{40}/i, 'no address');
});

// ── the real dispatch (engine.buy / engine.sell / engine.float.buy / buyCovered) ──
function world({ lane = 'robinhood', own = null, read = null, solRoute = null, mode = 'evm', jupIndexed = async () => true, solFee = false } = {}) {
  const calls = { trade: [], usdBuy: [], reads: 0, sol: 0, jup: 0, fallback: [] };
  const stubs = {
    gatedBuy, gatedCall, evmCoverVenue, solCoverVenue, gateRegistry, GATE_MODE,
    JUP_INDEXED: (m) => { calls.jup += 1; return jupIndexed(m); },
    noteFallback: (surface, size) => (venue) => { calls.fallback.push([surface, venue, size]); },
    SOL_MODE: mode === 'sol', NEAR_MODE: false, CFG: { key: lane },
    // fee-cov-1110: the in-transaction Solana fee switch (src/solMarketFee.ts); off = the release-20 observe count below
    SOL_MARKET_FEE: { enabled: solFee },
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
  const text = source().replace('  float: { status: float.status,', '  floatApi: { status: float.status,');
  const got = cut(['hintRoute', 'buyCovered', 'engine.buy', 'engine.sell', 'engine.floatApi'], stubs, text);
  return { ...got, float: got.floatApi, calls };
}

test('engine.buy: every buy trades at once; a table coin is reported as a fee fallback; an uncovered coin is not; sells never ask', async () => {
  const w = world();
  await w.buy(RH_TOKEN, 0.1, ['a']);
  assert.deepEqual(w.calls.trade, [['buy', RH_TOKEN]]);
  await settle();
  assert.deepEqual(w.calls.fallback, [['trade', 'table', 0.1]]);
  assert.equal(w.calls.reads, 0, 'a table coin needs no route read');
  await w.sell(RH_TOKEN, 100, ['a']);
  assert.deepEqual(w.calls.trade.at(-1), ['sell', RH_TOKEN]);
  await w.buy(OTHER, 0.1, ['a']);
  await settle();
  assert.deepEqual(w.calls.trade.at(-1), ['buy', OTHER]);
  assert.equal(w.calls.fallback.length, 1, 'uncovered: nothing reported');
});

test('engine.buy on Robinhood: Pons curve / registry classes reported by the vault\'s own route; trades are never held', async () => {
  const warm = world({ own: PONS });
  await warm.buy(OTHER, 0.1); await settle();
  assert.deepEqual(warm.calls.trade, [['buy', OTHER]]);
  assert.deepEqual(warm.calls.fallback.map((x) => x[1]), ['pons-curve']);
  const L = { type: 'v4', chainId: 4663, poolKey: { currency0: ZERO, currency1: OTHER, fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' }, pair: 'native', quoteToken: '', quoteSymbol: '', bridgeFee: 0, bridgeHops: [], bridgeFees: [] };
  let release; const cold = world({ read: () => new Promise((r) => { release = () => r(L); }) });
  const p = cold.buy(OTHER, 0.1);
  await settle();
  assert.deepEqual(cold.calls.trade, [['buy', OTHER]], 'the click ran before the route read answered');
  release(); await p; await settle();
  assert.deepEqual(cold.calls.fallback.map((x) => x[1]), ['v4-launcher']);
  const v4 = world({ own: { type: 'v4' } });
  await v4.buy(OTHER, 0.1); await settle();
  assert.deepEqual(v4.calls.fallback, [], 'a malformed / foreign V4 route is not a covered market');
});

test('engine.buy on BNB: table and registry classes reported (classification after the click), Infinity not', async () => {
  const w = world({ lane: 'bsc' });
  await w.buy(BSC_FLAP, 0.1); await settle();
  assert.deepEqual(w.calls.trade, [['buy', BSC_FLAP]]);
  assert.deepEqual(w.calls.fallback.map((x) => x[1]), ['table']);
  const V2 = { type: 'v2', chainId: 56, router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', pool: '0x' + '3'.repeat(40), quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', path: ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', OTHER], quoteSymbol: '', bridgeHops: [], bridgeFees: [] };
  const v2 = world({ lane: 'bsc', own: V2 });
  await v2.buy(OTHER, 0.1); await settle();
  assert.deepEqual(v2.calls.trade, [['buy', OTHER]]);
  assert.deepEqual(v2.calls.fallback.map((x) => x[1]), ['v2']);
  const inf = world({ lane: 'bsc', own: { type: 'inf', chainId: 56 } });
  await inf.buy(OTHER, 0.1); await settle();
  assert.deepEqual(inf.calls.fallback, []);
});

test('engine.buy on Solana: Jupiter and indexed pump.fun / PumpSwap reported; not indexed / pumphop / DLMM not; all trade', async () => {
  const MINT = 'So1aNaMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, '2');
  const jup = world({ mode: 'sol', solRoute: async () => ({ venue: 'jupiter', mint: MINT }) });
  await jup.buy(MINT, 0.1); await settle();
  assert.deepEqual(jup.calls.trade, [['buy', MINT]]);
  assert.deepEqual(jup.calls.fallback.map((x) => x[1]), ['jupiter']);
  assert.equal(jup.calls.jup, 0, 'a Jupiter-venue coin needs no Jupiter read');
  await jup.sell(MINT, 50);
  assert.equal(jup.calls.sol, 1, 'only the buy asked for the route');
  for (const venue of ['pump', 'pumpswap']) {
    const w = world({ mode: 'sol', solRoute: async () => ({ venue, mint: MINT }) });
    await w.buy(MINT, 0.1); await settle();
    assert.deepEqual(w.calls.trade, [['buy', MINT]]);
    assert.deepEqual(w.calls.fallback.map((x) => x[1]), [venue]);
    for (const jupIndexed of [async () => false, async () => { throw new Error('jupiter down'); }]) {
      const f = world({ mode: 'sol', solRoute: async () => ({ venue, mint: MINT }), jupIndexed });
      await f.buy(MINT, 0.1); await settle();
      assert.deepEqual(f.calls.trade, [['buy', MINT]]);
      assert.deepEqual(f.calls.fallback, [], venue + ' not indexed: not a covered market');
    }
  }
  for (const venue of ['pumphop', 'dlmm']) {
    const w = world({ mode: 'sol', solRoute: async () => ({ venue }) });
    await w.buy(MINT, 0.1); await settle();
    assert.deepEqual(w.calls.trade, [['buy', MINT]]);
    assert.deepEqual(w.calls.fallback, []);
  }
});

// fee-cov-1110: with the in-transaction Solana fee on, a Solana buy pays its fee inside its own transaction (whatever the venue):
// it is not counted as a fee-free fallback and the gate reads no route and asks Jupiter nothing (zero work in front of the click)
test('engine.buy on Solana with the in-transaction fee on: every venue trades at once, nothing is read, nothing counted fee-free', async () => {
  const MINT = 'So1aNaMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, '2');
  for (const venue of ['jupiter', 'pump', 'pumpswap', 'pumphop', 'dlmm']) {
    const w = world({ mode: 'sol', solFee: true, solRoute: async () => ({ venue, mint: MINT }) });
    await w.buy(MINT, 0.1); await settle();
    assert.deepEqual(w.calls.trade, [['buy', MINT]]);
    assert.deepEqual(w.calls.fallback, [], venue);
    assert.equal(w.calls.sol + w.calls.jup, 0, venue + ': no read');
    await w.float.buy({ token: MINT, usd: 5 }); await settle();
    assert.deepEqual(w.calls.fallback, [], venue + ' (USD balance)');
  }
});

test('engine.float.buy: never refused; a covered market is reported with its USD size', async () => {
  const w = world();
  assert.deepEqual(await w.float.buy({ token: RH_TOKEN, usd: 5 }), { ok: true });
  await settle();
  assert.deepEqual(w.calls.fallback, [['float.buy', 'table', 5]]);
  await w.float.buy({ token: OTHER, usd: 5, hint: { ok: true, route: { type: 'v4' } } });
  assert.equal(w.calls.usdBuy.length, 2);
});

test('the dispatch source: sell has no gate, buy and float.buy go through gatedBuy with a fallback reporter, limit/relay keep the chain-wide check', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const line = (re) => src.split('\n').find((l) => re.test(l)) || '';
  assert.match(line(/^\s+sell: \(token: string, percent/), /=> clickRun\(\(\) => trade\('sell'/);
  assert.doesNotMatch(line(/^\s+sell: \(token: string, percent/), /gate/i);
  assert.match(line(/^\s+buy: \(token: string, amount/), /gatedBuy\(laneKey\(\), 'trade'.*noteFallback\('trade'/);
  assert.match(line(/^\s+float: \{ status/), /gatedBuy\(laneKey\(\), 'float\.buy'.*noteFallback\('float\.buy'/);
  assert.match(src, /const legacyOrFeeLeg = .*gatedCall\(lane, surface, run\)/);
  assert.match(src, /'\/api\/app\/error', \{ method: 'POST', mode: 'no-cors'/);
});

test('fallbackReason (the vault side of "why no fee path"): settings and wallets only, never throws', () => {
  const mk = ({ s = {}, mev = false, accts = [{ id: 'a' }], pol = { enabled: false, gates: {} }, sol = false, step = null, throws = false } = {}) => cut(['fallbackReason'], {
    tradeSettings: () => { if (throws) throw new Error('locked'); return s; }, mevOn: () => mev, requireUnlocked: () => accts, policyNow: () => pol,
    stepUps: new Map(step ? [['transfer', step]] : []), SOL_MODE: sol, NEAR_MODE: false }).fallbackReason;
  assert.equal(mk()('float.buy'), 'usd-balance');
  assert.equal(mk({ s: { turbo: true } })('trade'), 'turbo');
  assert.equal(mk({ mev: true })('trade'), 'private-send');
  assert.equal(mk({ sol: true, s: { solTip: 0.001 } })('trade'), 'sol-tip');
  assert.equal(mk({ accts: [{ id: 'a', ext: 'privy' }] })('trade', ['a']), 'privy-wallet');
  assert.equal(mk({ accts: [{ id: 'a', ext: 'privy' }, { id: 'b' }] })('trade', ['b']), 'no-fee-path', 'only the order\'s wallets count');
  assert.equal(mk({ accts: [{ id: 'a', hop: true }] })('trade'), 'hop-wallet');
  assert.equal(mk({ pol: { enabled: true, gates: { transfer: true } } })('trade'), '2fa');
  assert.equal(mk({ pol: { enabled: true, gates: { transfer: true } }, step: { token: 't', exp: Date.now() + 60000 } })('trade'), 'no-fee-path', 'a fresh 2FA step-up is not the reason');
  assert.equal(mk({ throws: true })('trade'), 'no-fee-path');
});
