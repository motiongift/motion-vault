// Release 20 (coverage by venue): src/terminal-evm/venue-registry.mjs + its use in the vault guard and the engine's fee gate.
//   node --experimental-strip-types --test test/fee-coverage.mjs
// Fixture: real /route answers of motion (analytics top coins + board sample, 2026-11-09). The fork proof of exact 20 bps and of
// the refusal of foreign calls is B:/tmp/fee-coverage/fork (run-fork.mjs); this file is the pure + mocked-RPC part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { REGISTRY_PINS, REGISTRY_CLASSES, registryClass, registryScope, classContracts, verifyRegistryMarket, _resetRegistryCache } from '../src/terminal-evm/venue-registry.mjs';
import { verifyTerminalEvm } from '../src/terminal-evm/vault-guard.mjs';
import { TERMINAL_EXECUTE_ABI, TERMINAL_PURPOSE, ZERO_HASH } from '../src/terminal-evm/quote-authorization.mjs';
import { evmCovered, solCovered, solBuyCovered, createJupiterIndexCheck, gateRegistry, GATE_ROUTE_READ, SOL_COVERED_VENUES, COVERED_TOKENS } from '../src/terminalFeeCoverage.ts';
import { TERMINAL_EVM_POLICY, TERMINAL_EVM_BNB_VENUES } from '../src/terminalEvmConfig.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const FIX = JSON.parse(readFileSync(new URL('./fixtures/fee-coverage/routes-live-2026-11-09.json', import.meta.url), 'utf8')).routes;
const bySym = (chain, sym) => { const r = FIX.find(x => x.chain === chain && x.symbol === sym); assert.ok(r, `${chain} ${sym} in fixture`); return structuredClone(r); };
const RH = REGISTRY_PINS.robinhood, BSC = REGISTRY_PINS.bsc;

test('live routes: the venues that carry motion\'s volume classify; known exceptions stay per-coin', () => {
  const expect = [['robinhood', 'MOTION', 'v4-launcher'], ['robinhood', 'ORGENT', 'v4-launcher'], ['robinhood', 'PRIORS', 'v4-hookless'],
    ['robinhood', 'NOTE', 'v4-hookless'], ['robinhood', 'PONS', 'v3'], ['robinhood', 'FOBO', 'v3'], ['robinhood', 'RAETO', 'v3'],
    ['robinhood', 'LASTTRUCK', 'v4-doppler'], ['robinhood', 'AGI', 'v4-launcher'], ['bsc', 'BINF', 'v2'], ['bsc', 'うさぎ', 'v2'],
    ['bsc', 'BNCB', 'v3'], ['bsc', 'NVDAB', 'v3'], ['bsc', 'Osaru', 'four'], ['bsc', '三羊开泰', 'flap']];
  for (const [c, s, cls] of expect) { const r = bySym(c, s); assert.equal(registryClass(c, r.route, r.token), cls, `${c} ${s}`); }
  // every live v2/v3/v4/four route classifies; the per-coin exceptions are Pons (factory rule), Robinhood Flap and a 2-hop bridge
  const left = FIX.filter(x => ['v2', 'v3', 'v4', 'four'].includes(x.route.type) && registryClass(x.chain, x.route, x.token) === null);
  assert.deepEqual(left.map(x => `${x.chain} ${x.symbol}`), []);
  for (const x of FIX.filter(x => x.route.type === 'pons')) assert.equal(registryClass(x.chain, x.route, x.token), null, 'Pons is never a registry class');
  // the fixture's recorded class = today's rule (regression pin)
  for (const x of FIX) assert.equal(registryClass(x.chain, x.route, x.token), x.cls, `${x.chain} ${x.symbol}`);
});

test('tampered routes are not a registry class (foreign hook, fee, bridge, router, portal, manager, keys, chain, token)', () => {
  const m = bySym('robinhood', 'MOTION'), p = bySym('robinhood', 'PRIORS'), v3 = bySym('robinhood', 'FOBO'), v2 = bySym('bsc', 'BINF');
  const four = bySym('bsc', 'Osaru'), flap = bySym('bsc', '三羊开泰'), dop = bySym('robinhood', 'LASTTRUCK');
  const no = (c, r, t, why) => assert.equal(registryClass(c, r, t), null, why);
  no('robinhood', { ...m.route, poolKey: { ...m.route.poolKey, hooks: '0x' + '1'.repeat(40) } }, m.token, 'unknown hook');
  no('robinhood', { ...m.route, poolKey: { ...m.route.poolKey, fee: 3000 } }, m.token, 'launcher hook with another fee word');
  no('robinhood', { ...m.route, poolKey: { ...m.route.poolKey, tickSpacing: 60 } }, m.token, 'launcher hook with another spacing');
  no('robinhood', { ...p.route, poolKey: { ...p.route.poolKey, fee: 0x800000 } }, p.token, 'hookless dynamic fee');
  no('robinhood', { ...p.route, poolKey: { ...p.route.poolKey, fee: 200000 } }, p.token, 'hookless fee above 10 %');
  no('robinhood', { ...p.route, bridgeHops: [RH.wrapped, '0x' + '2'.repeat(40), RH.usdg], bridgeFees: [100, 100] }, p.token, 'two-hop bridge');
  no('robinhood', { ...p.route, bridgeHops: ['0x' + '2'.repeat(40), RH.usdg] }, p.token, 'bridge not from the wrapped native');
  no('robinhood', { ...p.route, bridgeFees: [2500], bridgeFee: 2500 }, p.token, 'bridge fee tier Uniswap does not have');
  no('robinhood', { ...m.route, extra: 1 }, m.token, 'unknown route key');
  no('robinhood', { ...m.route, poolKey: { ...m.route.poolKey, hookData: '0x' } }, m.token, 'unknown pool key field');
  no('robinhood', m.route, '0x' + '3'.repeat(40), 'pool does not hold the token');
  no('robinhood', { ...m.route, chainId: 56 }, m.token, 'other chain');
  no('bsc', m.route, m.token, 'a Robinhood route on BNB');
  no('robinhood', { ...dop.route, poolKey: { ...dop.route.poolKey, fee: 200000 } }, dop.token, 'doppler static fee above 10 %');
  no('robinhood', { ...v3.route, fee: 2500 }, v3.token, 'RH V3 fee tier that does not exist');
  no('robinhood', { ...v3.route, pool: undefined }, v3.token, 'V3 without its pool');
  no('robinhood', { ...v3.route, quoteToken: v3.token }, v3.token, 'V3 quoted in itself');
  no('bsc', { ...v2.route, router: '0x' + '4'.repeat(40) }, v2.token, 'V2 foreign router');
  no('bsc', { ...v2.route, path: [...v2.route.path].reverse() }, v2.token, 'V2 path not from WBNB to the coin');
  no('bsc', { ...v2.route, path: [BSC.wrapped, '0x' + '5'.repeat(40), '0x' + '6'.repeat(40), v2.token] }, v2.token, 'V2 four-hop path');
  no('bsc', { ...v2.route, bridgeHops: [BSC.wrapped] }, v2.token, 'V2 with a bridge leg');
  no('bsc', { ...four.route, manager: '0x' + '7'.repeat(40) }, four.token, 'four.meme foreign manager');
  no('bsc', { ...four.route, helper: '0x' + '7'.repeat(40) }, four.token, 'four.meme foreign helper');
  no('bsc', { ...flap.route, portal: '0x' + '8'.repeat(40) }, flap.token, 'Flap foreign portal');
  no('bsc', { ...flap.route, permitData: '0x1234' }, flap.token, 'Flap permit data');
  no('bsc', { ...flap.route, quoteToken: ZERO, nativeToQuote: true, bridgeHops: [], bridgeFees: [] }, flap.token, 'native Flap claiming a native-to-quote leg');
  no('robinhood', m.route, RH.wrapped, 'the wrapped native is not a coin');
  for (const bad of [null, undefined, [], 'v4', 1]) no('robinhood', bad, m.token, String(bad));
});

test('registryScope: only the chain\'s known classes, no duplicates; absent = none (release-19 scope)', () => {
  assert.deepEqual(registryScope('robinhood', undefined), []);
  assert.deepEqual(registryScope('bsc', ['v2', 'four']), ['v2', 'four']);
  for (const bad of [['v2'], ['v4-launcher', 'v4-launcher'], 'v3', [1]]) assert.throws(() => registryScope('robinhood', bad), /registry configuration/);
  assert.throws(() => registryScope('bsc', ['v4-hookless']), /registry configuration/);
  for (const c of ['robinhood', 'bsc']) for (const cls of REGISTRY_CLASSES[c]) assert.ok(classContracts(c, cls).length >= 1, `${c} ${cls}`);
  // the deployment config of this build lists every class, and only known ones
  assert.deepEqual([...TERMINAL_EVM_POLICY.robinhood.registry], ['v4-launcher', 'v3', 'v4-hookless', 'v4-doppler', 'standard-pool'], 'fork-proven classes only (standard-curve off)');
  assert.deepEqual([...TERMINAL_EVM_POLICY.bsc.registry].sort(), [...REGISTRY_CLASSES.bsc].sort());
  assert.deepEqual([...TERMINAL_EVM_BNB_VENUES].sort(), ['flap', 'four', 'v3']);
});

// a mock pinned-chain client: code by address, factory answers by args
function mockClient({ codes = {}, reads = { n: 0 } } = {}) {
  return {
    reads,
    async getBytecode({ address }) { reads.n++; return codes[address.toLowerCase()] ?? '0x'; },
    async readContract() { reads.n++; return ZERO; },
  };
}
// The real pins are keccak hashes of the live code, which a mock cannot produce: the mock proves the REFUSAL side (other code,
// no code, wrong class); the acceptance side runs against the live chain below (FEE_COVERAGE_LIVE=1) and on the forks.
test('verifyRegistryMarket refuses foreign or missing code and a class that is not the route own class', async () => {
  _resetRegistryCache();
  const m = bySym('robinhood', 'MOTION'), v3 = bySym('robinhood', 'FOBO'), v2 = bySym('bsc', 'BINF');
  const standIn = Object.fromEntries(classContracts('robinhood', 'v4-launcher').map(p => [p.address, '0x60016000f3']));
  await assert.rejects(verifyRegistryMarket({ chain: 'robinhood', cls: 'v4-launcher', route: m.route, token: m.token, client: mockClient({ codes: standIn }) }), /venue contract code differs/);
  await assert.rejects(verifyRegistryMarket({ chain: 'robinhood', cls: 'v4-hookless', route: m.route, token: m.token, client: mockClient() }), /registry class mismatch/);
  await assert.rejects(verifyRegistryMarket({ chain: 'robinhood', cls: 'v3', route: v3.route, token: v3.token, client: mockClient() }), /venue contract code differs/);
  await assert.rejects(verifyRegistryMarket({ chain: 'bsc', cls: 'v2', route: v2.route, token: v2.token, client: mockClient() }), /venue contract code differs/);
  await assert.rejects(verifyRegistryMarket({ chain: 'elysium', cls: 'v2', route: v2.route, token: v2.token, client: mockClient() }), /registry class mismatch/);
});

test('verifyRegistryMarket with the real pinned code (live read-only RPC): v3 pool / v2 pair must be the factory\'s', { skip: process.env.FEE_COVERAGE_LIVE !== '1' }, async () => {
  const { createPublicClient, http } = await import('viem');
  const rh = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com', { fetchOptions: { headers: { 'user-agent': 'motion-fee-coverage-test/1 (read-only)' } } }) });
  const bsc = createPublicClient({ transport: http('https://bsc-rpc.publicnode.com') });
  _resetRegistryCache();
  for (const [c, s, client] of [['robinhood', 'MOTION', rh], ['robinhood', 'PRIORS', rh], ['robinhood', 'FOBO', rh], ['robinhood', 'PONS', rh], ['bsc', 'BINF', bsc], ['bsc', 'BNCB', bsc], ['bsc', 'Osaru', bsc]]) {
    const r = bySym(c, s);
    assert.equal(await verifyRegistryMarket({ chain: c, cls: r.cls, route: r.route, token: r.token, client }), r.cls, `${c} ${s}`);
  }
  const v3 = bySym('robinhood', 'FOBO');
  await assert.rejects(verifyRegistryMarket({ chain: 'robinhood', cls: 'v3', route: { ...v3.route, pool: bySym('robinhood', 'RAETO').route.pool }, token: v3.token, client: rh }), /not the factory pool/);
  const v2 = bySym('bsc', 'BINF');
  await assert.rejects(verifyRegistryMarket({ chain: 'bsc', cls: 'v2', route: { ...v2.route, pool: bySym('bsc', 'うさぎ').route.pool }, token: v2.token, client: bsc }), /not the factory pair/);
});

// ── the vault guard: registry routes need the deployment's `registry`, nothing else changes ──
const quoteTx = (config, { token, trader }) => {
  const q = { trader, recipient: trader, tokenIn: ZERO, tokenOut: token, amountIn: 10n ** 15n, minOut: 1n, routeHash: ZERO_HASH, builderId: ZERO_HASH,
    builderRecipient: ZERO, motionFeeBps: 20, builderFeeBps: 0, issuedAt: 1, deadline: 2, nonce: 1n, purpose: TERMINAL_PURPOSE, policyId: config.policyId, entitlementId: ZERO_HASH };
  const call = { target: ZERO, value: 0n, data: '0x', approvalToken: ZERO, approvalSpender: ZERO, approvalAmount: 0n, usePermit2: false, amountOffset: 0n };
  return { chainId: config.chainId, to: config.router, value: '1000000000000000', data: encodeFunctionData({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', args: [q, [call], [token], '0x' + '1'.repeat(130)] }) };
};
test('verifyTerminalEvm: a registry route is "not deployment-approved" without `registry`, and passes the market stage with it', async () => {
  const trader = '0x' + '9'.repeat(40);
  const boom = { getChainId: async () => { throw Error('REACHED-RPC'); }, getBytecode: async () => { throw Error('REACHED-RPC'); }, getBlock: async () => { throw Error('REACHED-RPC'); } };
  // one coin per class that is NOT in the release-19 table (a table coin passes on its market key with or without the registry)
  const picks = [];
  for (const c of ['robinhood', 'bsc']) for (const cls of REGISTRY_CLASSES[c]) {
    const r = FIX.find(x => x.chain === c && x.cls === cls && !COVERED_TOKENS[c].has(x.token));
    if (r) picks.push(r);
  }
  assert.ok(picks.length >= 7, picks.map(x => x.cls).join(','));
  for (const r of picks) {
    const chain = r.chain, sym = `${r.symbol} (${r.cls})`, base = TERMINAL_EVM_POLICY[chain];
    const intent = { trader, token: r.token, side: 'buy', amount: '1000000000000000', slippageBps: 1200 };
    const without = { ...base, registry: undefined };
    await assert.rejects(verifyTerminalEvm({ config: without, client: boom, transaction: quoteTx(without, { token: r.token, trader }), route: r.route, intent, bnbVenues: TERMINAL_EVM_BNB_VENUES }),
      /market is not deployment-approved|venue not enabled/, `${chain} ${sym} without registry`);
    await assert.rejects(verifyTerminalEvm({ config: base, client: boom, transaction: quoteTx(base, { token: r.token, trader }), route: r.route, intent, bnbVenues: TERMINAL_EVM_BNB_VENUES }),
      /REACHED-RPC/, `${chain} ${sym} with registry: past the market check, at the first chain read`);
    const tampered = r.route.poolKey ? { ...r.route, poolKey: { ...r.route.poolKey, hooks: '0x' + 'a'.repeat(40) } } : { ...r.route, chainId: r.route.chainId, router: '0x' + 'b'.repeat(40), portal: '0x' + 'b'.repeat(40), manager: '0x' + 'b'.repeat(40), fee: 777 };
    await assert.rejects(verifyTerminalEvm({ config: base, client: boom, transaction: quoteTx(base, { token: r.token, trader }), route: tampered, intent, bnbVenues: TERMINAL_EVM_BNB_VENUES }),
      /market is not deployment-approved|venue not enabled|route/, `${chain} ${sym} tampered`);
  }
  await assert.rejects(verifyTerminalEvm({ config: { ...TERMINAL_EVM_POLICY.bsc, registry: ['v4-launcher'] }, client: boom, transaction: quoteTx(TERMINAL_EVM_POLICY.bsc, { token: bySym('bsc', 'BINF').token, trader }), route: bySym('bsc', 'BINF').route, intent: { trader, token: bySym('bsc', 'BINF').token, side: 'buy', amount: '1000000000000000', slippageBps: 1200 } }), /registry configuration/);
});

// ── the engine's fee gate ──
const SW = { ponsV2: true, registry: { robinhood: TERMINAL_EVM_POLICY.robinhood.registry, bsc: TERMINAL_EVM_POLICY.bsc.registry } };
test('evmCovered with the registry: a coin outside the table is decided on the vault\'s own route', () => {
  for (const x of FIX) {
    const want = x.cls !== null || (x.route.type === 'pons' && x.route.pairToken === ZERO && !(x.route.bridgeHops?.length));
    assert.equal(evmCovered(x.chain, '0x' + x.token.slice(2), x.route, SW) === true || evmCovered(x.chain, x.token, undefined, SW) === true, want, `${x.chain} ${x.symbol}`);
  }
  const OTHER = '0x1111111111111111111111111111111111111111';
  assert.equal(evmCovered('bsc', OTHER, undefined, SW), undefined, 'BNB now reads the route too');
  assert.equal(evmCovered('bsc', OTHER, undefined, { ponsV2: true }), false, 'no registry: release-19 answer, no read');
  assert.equal(evmCovered('robinhood', OTHER, { type: 'v4' }, SW), false);
  const m = bySym('robinhood', 'MOTION');
  assert.equal(evmCovered('robinhood', m.token, { ...m.route, poolKey: { ...m.route.poolKey, hooks: '0x' + 'c'.repeat(40) } }, { ...SW, tokens: { robinhood: new Set(), bsc: new Set() } }), false, 'foreign hook: fee-free');
  assert.equal(evmCovered('robinhood', m.token, m.route, { ponsV2: true, registry: { robinhood: ['v3'] }, tokens: { robinhood: new Set(), bsc: new Set() } }), false, 'class not enabled');
});

test('solCovered: Jupiter, pump.fun curve and PumpSwap take the Jupiter fee path; pumphop and DLMM stay fee-free', () => {
  assert.deepEqual([...SOL_COVERED_VENUES], ['jupiter', 'pump', 'pumpswap']);
  for (const venue of ['jupiter', 'pump', 'pumpswap']) assert.equal(solCovered({ venue }), true, venue);
  for (const venue of ['pumphop', 'dlmm', undefined, 'JUPITER']) assert.equal(solCovered({ venue }), false, String(venue));
  assert.equal(solCovered(null), false);
  assert.equal(solCovered({ venue: 'pump' }, ['jupiter']), false, 'release-19 list');
});

test('gateRegistry: the BNB gate reads no route before a click (owner 2026-11-09); Robinhood keeps its registry', () => {
  assert.deepEqual({ ...GATE_ROUTE_READ }, { robinhood: true, bsc: false });
  const g = gateRegistry(TERMINAL_EVM_POLICY);
  assert.deepEqual([...g.robinhood], [...TERMINAL_EVM_POLICY.robinhood.registry]);
  assert.deepEqual([...g.bsc], []);
  const B = bySym('bsc', 'BINF');
  assert.equal(evmCovered('bsc', '0x1111111111111111111111111111111111111111', undefined, { ponsV2: true, registry: g }), false, 'no read: false at once');
  assert.equal(evmCovered('bsc', B.token, B.route, { ponsV2: true, registry: g, tokens: { robinhood: new Set(), bsc: new Set() } }), false);
  assert.deepEqual(gateRegistry(null), { robinhood: [], bsc: [] });
});

test('solBuyCovered: pump / PumpSwap only while Jupiter routes the coin; Jupiter venue needs no read; failures never block', async () => {
  const MINT = 'So1aNaMint22222222222222222222222222222222';
  let asked = 0; const yes = async () => { asked++; return true; }, no = async () => { asked++; return false; }, bad = async () => { asked++; throw Error('x'); };
  assert.equal(solBuyCovered({ venue: 'jupiter', mint: MINT }, yes), true); assert.equal(asked, 0);
  for (const venue of ['pump', 'pumpswap']) {
    assert.equal(await solBuyCovered({ venue, mint: MINT }, yes), true, venue);
    assert.equal(await solBuyCovered({ venue, mint: MINT }, no), false, venue + ' not indexed');
    assert.equal(await solBuyCovered({ venue, mint: MINT }, bad), false, venue + ' Jupiter failure');
  }
  for (const venue of ['pumphop', 'dlmm', undefined]) assert.equal(solBuyCovered({ venue, mint: MINT }, yes), false, String(venue));
  assert.equal(solBuyCovered({ venue: 'pump' }, yes), false, 'no mint: not covered');
});

test('createJupiterIndexCheck: 200 + route = yes (remembered); NO_ROUTES_FOUND = no (briefly); 429 / errors = no, not remembered', async () => {
  const MINT = 'So1aNaMint22222222222222222222222222222222';
  let t = 0, n = 0, answer;
  const res = (status, j) => ({ status, json: async () => j });
  const check = createJupiterIndexCheck({ now: () => t, fetchImpl: async (url) => { n++; assert.match(url, /^https:\/\/lite-api\.jup\.ag\/swap\/v1\/quote\?inputMint=So111/); return answer(); } });
  answer = () => res(400, { error: 'No routes found', errorCode: 'NO_ROUTES_FOUND' });
  assert.equal(await check(MINT), false); assert.equal(await check(MINT), false); assert.equal(n, 1, 'definite no remembered for a moment');
  t += 3001;
  answer = () => res(200, { outputMint: MINT, routePlan: [{ swapInfo: { label: 'Pump.fun' } }] });
  assert.equal(await check(MINT), true, 'covered the moment Jupiter routes it'); assert.equal(n, 2);
  t += 60_000; assert.equal(await check(MINT), true); assert.equal(n, 2, 'yes remembered');
  const other = 'So1aNaMint33333333333333333333333333333333';
  answer = () => res(429, { code: 429 });
  assert.equal(await check(other), false); assert.equal(await check(other), false); assert.equal(n, 4, '429 not remembered');
  answer = () => { throw Error('net'); };
  assert.equal(await check(other), false);
  answer = () => res(200, { outputMint: MINT, routePlan: [] });
  assert.equal(await check(other), false, 'route for another mint / empty plan = no');
  answer = () => res(400, { errorCode: 'SOMETHING_ELSE' });
  const n0 = n; await check(other); await check(other); assert.equal(n - n0, 2, 'unknown 4xx not remembered');
  const M4 = 'So1aNaMint44444444444444444444444444444444';
  let release; answer = () => new Promise(r => { release = () => r(res(200, { outputMint: M4, routePlan: [1] })); });
  const a = check(M4), b = check(M4);
  await new Promise(r => setTimeout(r, 5)); release();
  assert.deepEqual(await Promise.all([a, b]), [true, true], 'one read in flight per mint');
});

test('createJupiterIndexCheck against live Jupiter (keyless, read-only)', { skip: process.env.FEE_COVERAGE_LIVE !== '1' }, async () => {
  const check = createJupiterIndexCheck();
  assert.equal(await check('9qghVo6gqg1nVYGZCq14mhsFFUDH3e2z1iH4JtkfLoat'), true, 'an indexed coin (BTC, Raydium CPMM)');
});
