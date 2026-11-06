// trade-core.patch E1 — the Elysium trade path's pure decisions (src/elysiumCore.ts), one test per guard.
// Real addresses / pool ids are the ones read on chain 99901 on 2026-11-03 (local elysium-trade/logs/probe*.txt).
//   node --experimental-strip-types --test test/elysium-core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters, toFunctionSelector, encodeFunctionData } from 'viem';
import * as E from '../src/elysiumCore.ts';
import { UNIVERSAL_ROUTER_ABI, PERMIT2_ABI } from '../src/evmV4Router.ts';

const ZERO = E.ELY_ZERO, WHYPE = E.ELY_WHYPE;
const LINERPE = '0xc8c300557db88150977ee6a77959c9bf90f00999';   // Uniswap V4, hook 0xb676…e000 (beforeInitialize only), fee 4 %
const LINERPE_KEY = { currency0: ZERO, currency1: LINERPE, fee: 40000, tickSpacing: 200, hooks: '0xb67656ce894ac93c0164d8490ad23161a77ee000' };
const BLOB_EP = '0x9a9815af521149e8d982791703a31bca2f95f534';   // ElysPump V4 launch, hook 0xe11c…20cc
const BLOB_EP_KEY = { currency0: ZERO, currency1: BLOB_EP, fee: 0, tickSpacing: 200, hooks: '0xe11cafa5901b0aab51eb78251488400f9e4320cc' };
const PERPME = '0x11aed7f6b23bb9ccb2bbf9e39e67ddf7f4210999';    // Uniswap V3 1 %, pool 0x5b34…ce68
const EGG = '0x86795b85d6360df2c7c7ece8c1024199f5392c01';       // ElysPump V3 1 %, pool 0xaee5…daef
// stage 3 (2026-11-04): ElysPump's "HomerPoolHook" (afterSwap fee = pool fee / 9, pool fee ≤ 9 % fixed at init), reviewed and pinned
const HOMER = '0x1295bd9d641185f361016a898a61a801c0d3e044';
const QUOTED = '0x66f46517d0c2cfa489bcbf776d127d59c79fa499';   // ElysPump V4 2.7 % behind HOMER, pool 0x88f9…2044
const QUOTED_KEY = { currency0: ZERO, currency1: QUOTED, fee: 27000, tickSpacing: 200, hooks: HOMER };
const v4 = (venue, poolKey, pair = 'native') => ({ type: 'ely', chainId: 99901, venue, pair, poolKey });
const v3 = (venue, fee) => ({ type: 'ely', chainId: 99901, venue, pair: 'weth', fee });

test('selectors the tx check relies on', () => {
  assert.equal(toFunctionSelector('function execute(bytes,bytes[],uint256)'), '0x3593564c');
  assert.equal(toFunctionSelector('function approve(address,uint256)'), '0x095ea7b3');
  assert.equal(toFunctionSelector('function approve(address,address,uint160,uint48)'), '0x87517c45');
});

test('addresses the vault computes itself match the chain: V3 pools (canonical init hash) and V4 pool ids', () => {
  assert.equal(E.v3PoolOf(E.ELY_VENUES['uni-v3'].factory, PERPME, WHYPE, 10000), '0x5b34f4548e931567db20a511d4bc205fcd7fce68');
  assert.equal(E.v3PoolOf(E.ELY_VENUES['ep-v3'].factory, EGG, WHYPE, 10000), '0xaee5b83d4c94d2eff56b50d50091529d1e63daef');
  assert.equal(E.v3PoolOf(E.ELY_VENUES['ep-v3'].factory, WHYPE, EGG, 10000), '0xaee5b83d4c94d2eff56b50d50091529d1e63daef', 'order-independent');
  assert.equal(E.v4PoolId(LINERPE_KEY), '0x97aaa859706f0f90d3418c38563d8b2b8317e48b962f18796e1e664c47194748');
  assert.equal(E.v4PoolId(BLOB_EP_KEY), '0x3f3fad70b4529921780f2dc3c61917d5217da0824e6e1facf9a081b799c88a7d');
});

test('hook permissions are read from the address', () => {
  assert.equal(E.hookSwapFlags('0xb67656ce894ac93c0164d8490ad23161a77ee000'), 0, 'beforeInitialize only: never called on a swap');
  assert.equal(E.hookSwapFlags('0xe11cafa5901b0aab51eb78251488400f9e4320cc'), 0xcc);
  assert.equal(E.hookSwapFlags('0x1295bd9d641185f361016a898a61a801c0d3e044'), 0x44, 'afterSwap + afterSwapReturnDelta');
  assert.equal(E.hookSwapFlags(ZERO), 0);
});

test('route rules: the four venues are accepted, in their own shapes only', () => {
  assert.equal(E.elyRouteProblem(LINERPE, v4('uni-v4', LINERPE_KEY)), '');
  assert.equal(E.elyRouteProblem(BLOB_EP, v4('ep-v4', BLOB_EP_KEY)), '', 'ElysPump launch pool behind its own hook on its own PoolManager');
  assert.equal(E.elyRouteProblem(PERPME, v3('uni-v3', 10000)), '');
  assert.equal(E.elyRouteProblem(EGG, v3('ep-v3', 10000)), '');
  const hookless = { currency0: ZERO, currency1: LINERPE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  assert.equal(E.elyRouteProblem(LINERPE, v4('uni-v4', hookless)), '');
  assert.equal(E.elyRouteProblem(LINERPE, v4('uni-v4', { ...hookless, currency0: LINERPE < WHYPE ? LINERPE : WHYPE, currency1: LINERPE < WHYPE ? WHYPE : LINERPE }, 'weth')), '');
});

test('route rules: everything else is refused', () => {
  const R = (t, r) => E.elyRouteProblem(t, r);
  assert.match(R(LINERPE, { ...v4('uni-v4', LINERPE_KEY), type: 'v4' }), /not an Elysium route/);
  assert.match(R(LINERPE, { ...v4('uni-v4', LINERPE_KEY), chainId: 4663 }), /another chain/);
  assert.match(R(LINERPE, { ...v4('uni-v4', LINERPE_KEY), venue: 'kleos-v4' }), /venue/, 'Kleos: no trusted router');
  assert.match(R(LINERPE, { ...v4('uni-v4', LINERPE_KEY), venue: 'boxa-v3' }), /venue/, 'BOXA: no trusted router');
  assert.match(R(PERPME, { ...v3('uni-v3', 10000), pair: 'native' }), /WHYPE/);
  // release 7: any integer V3 tier up to 10 % (launchpad factories enable 2 %, 4 %, 5 % …); 0 / > 10 % refused
  assert.equal(R(PERPME, v3('uni-v3', 2500)), '');
  assert.match(R(PERPME, v3('uni-v3', 0)), /fee tier/); assert.match(R(PERPME, v3('uni-v3', 100001)), /above 10/);
  assert.match(R(LINERPE, v4('uni-v4', { ...LINERPE_KEY, currency0: LINERPE, currency1: ZERO })), /sorted/);
  assert.match(R('0x' + '1'.repeat(40), v4('uni-v4', LINERPE_KEY)), /does not contain/);
  assert.match(R(LINERPE, v4('uni-v4', LINERPE_KEY, 'weth')), /quoted in HYPE/);
  assert.match(R(LINERPE, v4('uni-v4', { ...LINERPE_KEY, hooks: ZERO, fee: 200000 })), /above 10/);
  assert.match(R(LINERPE, v4('uni-v4', { ...LINERPE_KEY, fee: 0x800000 })), /dynamic fee/);
  // release 7: an unpinned swap hook on a stock PoolManager needs the lane's code hash (route.hook) before anything else
  assert.match(R(LINERPE, v4('uni-v4', { ...LINERPE_KEY, hooks: '0xbacf71bf02b8cfe171853c5ec4a060ba2ac1e0cc' })), /not been read/, 'a swap hook on Uniswap\'s PoolManager without its code hash');
  assert.match(R(BLOB_EP, v4('uni-v4', BLOB_EP_KEY)), /not been read/, 'ElysPump\'s hook is pinned only on ElysPump\'s PoolManager');
  assert.match(R(BLOB_EP, v4('uni-v4', { ...BLOB_EP_KEY, fee: 27000, hooks: HOMER })), /refuses/, 'release 7: the HomerPoolHook is refused everywhere');
  assert.match(R(BLOB_EP, v4('ep-v4', { ...BLOB_EP_KEY, fee: 200000, hooks: HOMER })), /refuses/);
  assert.match(R(BLOB_EP, v4('ep-v4', { ...BLOB_EP_KEY, fee: 200000 })), /above 10/, 'a trusted hook does not lift the 10 % ceiling');
  assert.match(R(WHYPE, v3('uni-v3', 10000)), /gas token/);
  assert.match(R('nope', v3('uni-v3', 10000)), /not a token/);
  assert.match(R(LINERPE, null), /not an Elysium route/);
});

test('candidates: every canonical pool of the coin, the hint marked or added — never a refused one', () => {
  const plain = E.elyCandidates(PERPME, null);
  assert.equal(plain.length, 16, '4 tiers × 2 V3 factories + 4 V4 pairs × native/WHYPE');
  assert.ok(plain.every((c) => !c.hinted));
  assert.ok(plain.every((c) => E.ELY_ROUTERS.includes(c.router)));
  const h3 = E.elyCandidates(PERPME, v3('uni-v3', 10000));
  assert.equal(h3.length, 16); assert.equal(h3.filter((c) => c.hinted).length, 1);
  assert.equal(h3.find((c) => c.hinted).pool, '0x5b34f4548e931567db20a511d4bc205fcd7fce68');
  const h4 = E.elyCandidates(BLOB_EP, v4('ep-v4', BLOB_EP_KEY));
  assert.equal(h4.length, 17, 'the launch pool behind the trusted hook is added');
  assert.equal(h4[16].pool, '0x3f3fad70b4529921780f2dc3c61917d5217da0824e6e1facf9a081b799c88a7d');
  assert.equal(h4[16].router, E.ELY_VENUES['ep-v4'].router);
  const bad = E.elyCandidates(BLOB_EP, v4('uni-v4', BLOB_EP_KEY));
  assert.equal(bad.length, 16, 'a refused hint adds nothing');
  assert.ok(bad.every((c) => !c.hinted));
});

const decodeExec = (data) => decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data }).args;
test('calldata: V3 buy / sell through the Universal Router, floors where the wallet is paid', () => {
  const c = E.elyCandidates(PERPME, v3('uni-v3', 10000)).find((x) => x.hinted);
  const [cmd, inputs] = decodeExec(E.elyExecute(E.elyBuyEnc(c, PERPME, 10n ** 17n, 123n), 9n));
  assert.equal(cmd, '0x0b00', 'r8: WRAP_ETH(amountIn), V3_SWAP_EXACT_IN(amountIn) — exact, no final UNWRAP of all the router WHYPE');
  assert.equal(inputs.length, 2);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[0]).map(String), ['0x0000000000000000000000000000000000000002', String(10n ** 17n)]);
  const [rcp, amt, min, path, payer] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], inputs[1]);
  assert.equal(rcp, '0x0000000000000000000000000000000000000001', 'to the wallet (MSG_SENDER)');
  assert.equal(amt, 10n ** 17n); assert.equal(min, 123n); assert.equal(payer, false);
  assert.equal(path, WHYPE + '002710' + PERPME.slice(2));
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], inputs[1])[5], [], 'v2.1 router: maxHopSlippage, empty');
  const [scmd, sin] = decodeExec(E.elyExecute(E.elySellEnc(c, PERPME, 5n, 77n), 9n));
  assert.equal(scmd, '0x000c', 'V3_SWAP_EXACT_IN, UNWRAP_WETH');
  const s = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], sin[0]);
  assert.equal(s[0], '0x0000000000000000000000000000000000000002'); assert.equal(s[1], 5n); assert.equal(s[2], 77n); assert.equal(s[4], true, 'the coin is pulled from the wallet through Permit2');
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], sin[1]).map(String), ['0x0000000000000000000000000000000000000001', '77'], 'native HYPE to the wallet, at least the floor');
});

test('calldata: V4 native buy / sell (evmV4Router encoders) and the WHYPE-pool sell', () => {
  const c = E.elyCandidates(LINERPE, v4('uni-v4', LINERPE_KEY)).find((x) => x.hinted);
  const [nc, ni] = decodeExec(E.elyExecute(E.elyBuyEnc(c, LINERPE, 1n, 1n), 9n));
  assert.equal(nc, '0x10', 'r8: V4_SWAP only — no SWEEP of all the router HYPE');
  { const [acts, ps] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ni[0]);
    assert.equal(acts, '0x060b0e', 'SWAP_EXACT_IN_SINGLE, SETTLE, TAKE');
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], ps[1]).map((x) => String(x).toLowerCase()), [ZERO, '1', 'false'], 'SETTLE exactly amountIn of native, paid from this call value');
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], ps[2]).map((x) => String(x).toLowerCase()), [LINERPE, '0x0000000000000000000000000000000000000001', '0'], 'TAKE the coin owed (open delta) to the wallet');
    const sw = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], ps[0])[0];
    assert.equal(sw.zeroForOne, true); assert.equal(sw.amountIn, 1n); assert.equal(sw.amountOutMinimum, 1n, 'the floor on the swap itself'); }
  assert.equal(decodeExec(E.elyExecute(E.elySellEnc(c, LINERPE, 1n, 1n), 9n))[0], '0x10');
  const w = E.elyCandidates(LINERPE, null).find((x) => x.venue === 'uni-v4' && x.pair === 'weth');
  { const [wc, wi] = decodeExec(E.elyExecute(E.elyBuyEnc(w, LINERPE, 7n, 1n), 9n));
    assert.equal(wc, '0x0b10', 'r8: WRAP_ETH(amountIn), V4_SWAP — no final UNWRAP');
    const [acts, ps] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], wi[1]);
    assert.equal(acts, '0x060b0e');
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], ps[1]).map((x) => String(x).toLowerCase()), [WHYPE, '7', 'false'], 'SETTLE exactly 7 WHYPE (was CONTRACT_BALANCE: every WHYPE in the router)'); }
  // r8: the r7 plans are kept for the equivalence check only (scripts/elysium-exact-plans.mjs) and still decode as before
  assert.equal(decodeExec(E.elyExecute(E.elyBuyEncR7(c, LINERPE, 1n, 1n), 9n))[0], '0x1004');
  // r8: a WHYPE-pool sell's own part; the ticket text
  assert.equal(E.elySellOwnBack(100n, 'native', 50n), 100n); assert.equal(E.elySellOwnBack(100n, 'weth', 30n), 70n); assert.equal(E.elySellOwnBack(100n, undefined, 0n), 100n); assert.equal(E.elySellOwnBack(100n, 'weth', 100n), null);
  assert.equal(E.elyTicketText({ origin: 'https://motion.gift', wallet: '0xAB' + '00'.repeat(19), exp: 1700000000, nonce: '0011223344556677' }),
    ['motion · Elysium sell priority — not a transaction, not a permit', 'purpose: elysium-sell-share', 'origin: https://motion.gift', 'wallet: 0xab' + '00'.repeat(19), 'expires: 1700000000', 'nonce: 0011223344556677'].join(String.fromCharCode(10)));
  const [cmd, inputs] = decodeExec(E.elyExecute(E.elySellEnc(w, LINERPE, 5n, 66n), 9n));
  assert.equal(cmd, '0x100c', 'V4_SWAP (TAKE to the router), UNWRAP_WETH to the wallet');
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[1]).map(String), ['0x0000000000000000000000000000000000000001', '66']);
});

test('sell template: the probe writes the amount where the calldata carries it — identical to encoding that amount', () => {
  const dl = 1793740000n;
  for (const [coin, hint, n] of [[PERPME, v3('uni-v3', 10000), 1], [LINERPE, v4('uni-v4', LINERPE_KEY), 2], [BLOB_EP, v4('ep-v4', BLOB_EP_KEY), 2]]) {
    const c = E.elyCandidates(coin, hint).find((x) => x.hinted);
    const t = E.sellTemplate(c, coin, dl);
    assert.equal(t.at.length, n, `${c.venue}: ${n} amount word(s)`);
    for (const amount of [1n, 123456789n * 10n ** 18n, (1n << 127n) - 1n]) {
      const hex = t.data.slice(2).split('');
      const w = amount.toString(16).padStart(64, '0');
      for (const at of t.at) for (let i = 0; i < 64; i++) hex[Number(at) * 2 + i] = w[i];
      assert.equal('0x' + hex.join(''), E.elyExecute(E.elySellEnc(c, coin, amount, 0n), dl));
    }
  }
  const w = E.elyCandidates(LINERPE, null).find((x) => x.venue === 'uni-v4' && x.pair === 'weth');
  assert.equal(E.sellTemplate(w, LINERPE, dl).at.length, 2);
});

const seen = (o = {}) => ({ ran: true, buyOk: true, coinGot: 1000n, nativeSpent: 100n, buyGas: 150000n, sellOk: true, coinSold: 1000n, nativeBack: 92n, sellGas: 80000n, taxSent: 0n, taxGot: 0n, routerKept: false, err: '0x', ...o });
test('pick: the best measured pool; the hint stands within 2 %; a router that keeps funds never wins', () => {
  const cs = [{ venue: 'uni-v3' }, { venue: 'uni-v4', hinted: true }, { venue: 'ep-v3' }];
  assert.equal(E.elyPick(cs, [seen({ coinGot: 1000n }), seen({ coinGot: 990n }), seen({ coinGot: 1001n })], 'buy').i, 1, 'hint within 2 %');
  assert.equal(E.elyPick(cs, [seen({ coinGot: 1000n }), seen({ coinGot: 970n }), seen({ coinGot: 1001n })], 'buy').i, 2, 'hint 3 % worse: the best');
  assert.equal(E.elyPick(cs, [seen({ coinGot: 5000n, routerKept: true }), seen({ coinGot: 0n, buyOk: false }), seen({ ran: false, coinGot: 9000n })], 'buy'), null);
  assert.equal(E.elyPick(cs, [seen({ nativeBack: 50n }), seen({ nativeBack: 40n }), seen({ nativeBack: 60n })], 'sell').i, 2);
  assert.equal(E.elyPick(cs, [seen({ sellOk: false, nativeBack: 90n }), seen({ nativeBack: 49n }), seen({ nativeBack: 10n })], 'sell').i, 1);
});

test('buy guards: honeypot, round trip, tax, impact, the router, the amount', () => {
  const ok = seen({ coinGot: 1000n, nativeBack: 92n }), ref = seen({ coinGot: 20n, nativeSpent: 2n });
  assert.equal(E.elyBuyProblem(ok, ref, 100n, 2n), '');
  assert.match(E.elyBuyProblem(seen({ ran: false }), ref, 100n, 2n), /does not exist/);
  assert.match(E.elyBuyProblem(seen({ buyOk: false }), ref, 100n, 2n), /would not go through/);
  assert.match(E.elyBuyProblem(seen({ routerKept: true }), ref, 100n, 2n), /router would keep/);
  assert.match(E.elyBuyProblem(seen({ nativeSpent: 101n }), ref, 100n, 2n), /more HYPE/);
  assert.match(E.elyBuyProblem(seen({ sellOk: false }), ref, 100n, 2n), /honeypot/);
  assert.match(E.elyBuyProblem(seen({ nativeBack: 0n }), ref, 100n, 2n), /honeypot/);
  assert.match(E.elyBuyProblem(seen({ nativeBack: 69n }), ref, 100n, 2n), /only 69\.0%/);
  assert.equal(E.elyBuyProblem(seen({ nativeBack: 71n }), ref, 100n, 2n), '');
  assert.match(E.elyBuyProblem(seen({ taxSent: 100n, taxGot: 89n }), ref, 100n, 2n), /10% of a plain transfer, or refuses it/);
  assert.match(E.elyBuyProblem(ok, null, 100n, 2n), /impact could not be measured/);
  assert.match(E.elyBuyProblem(ok, seen({ buyOk: false }), 100n, 2n), /impact could not be measured/);
  // impact: 1000 for 100 vs 20 for 2 (= 1000 per 100) → 0 %; 700 for 100 → exactly 30 % → refused; 701 → 29.9 % → fine
  assert.match(E.elyBuyProblem(seen({ coinGot: 700n }), ref, 100n, 2n), /30% or more to price impact/);
  assert.equal(E.elyBuyProblem(seen({ coinGot: 701n }), ref, 100n, 2n), '');
  assert.equal(E.elyImpactBps(seen({ coinGot: 700n }), ref, 100n, 2n), 3000);
  assert.equal(E.elyImpactBps(ok, ref, 100n, 2n), 0);
});

test('sell guards: never refused for price impact (a holder can always exit), only for a broken sell', () => {
  assert.equal(E.elySellProblem(seen({ nativeBack: 1n }), 1000n), '', 'a sell returning almost nothing is still allowed (the page warns)');
  assert.match(E.elySellProblem(seen({ sellOk: false }), 1000n), /would not go through/);
  assert.match(E.elySellProblem(seen({ coinSold: 999n }), 1000n), /another amount/);
  assert.match(E.elySellProblem(seen({ nativeBack: 0n }), 1000n), /nothing/);
  assert.match(E.elySellProblem(seen({ routerKept: true }), 1000n), /router would keep/);
  assert.match(E.elySellProblem(seen({ ran: false }), 1000n), /does not exist/);
});

test('floor: simulated output minus slippage, never zero', () => {
  assert.equal(E.elyFloor(10_000n, 1200n), 8_800n);
  assert.equal(E.elyFloor(10_000n, 0n), 10_000n);
  assert.throws(() => E.elyFloor(0n, 1200n), /minimum-out/);
  assert.throws(() => E.elyFloor(10_000n, 10_000n), /minimum-out/);
  assert.throws(() => E.elyFloor(1n, 1200n), /minimum-out/, '1 × 0.88 rounds to 0');
  assert.throws(() => E.elyFloor(10_000n, 20_000n), /minimum-out/, 'a slippage above 100 % is clamped, never a negative floor');
});

const low = (xs) => xs.map((x) => (typeof x === 'string' ? x.toLowerCase() : x));
const dec20 = (d) => low(decodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], data: d }).args);
const decP2 = (d) => low(decodeFunctionData({ abi: PERMIT2_ABI, data: d }).args);
test('exact approvals: exactly the amount, 0 first over a smaller one, Permit2 for 30 minutes to the pool\'s own router', () => {
  const ur = E.ELY_VENUES['ep-v3'].router, now = 1_793_740_000, amt = 12345n, wall = now;
  assert.deepEqual(E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: now + 1200, now, wall }), [], 'a standing allowance that covers it and lives > 10 min: nothing');
  const fresh = E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: 0n, p2Amount: 0n, p2Expiry: 0, now, wall });
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].to, EGG); assert.deepEqual(dec20(fresh[0].data), [E.ELY_PERMIT2, amt]);
  assert.equal(fresh[1].to, E.ELY_PERMIT2); assert.deepEqual(decP2(fresh[1].data), [EGG, ur, amt, now + 1800]);
  const smaller = E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: 5n, p2Amount: amt, p2Expiry: now + 1200, now, wall });
  assert.deepEqual(smaller.map((x) => dec20(x.data)[1]), [0n, amt], 'reset to 0, then exactly the amount');
  assert.equal(E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: now + 10, now, wall }).length, 1, 'Permit2 about to expire: renewed');
  assert.throws(() => E.elyApprovals({ token: EGG, router: '0x7d812380c241b331d753e8eef1cefdea4e539496', amount: amt, allowance: 0n, p2Amount: 0n, p2Expiry: 0, now }), /router this vault does not know/, 'BOXA\'s router');
  assert.throws(() => E.elyApprovals({ token: EGG, router: ur, amount: 1n << 160n, allowance: 0n, p2Amount: 0n, p2Expiry: 0, now }), /size/);
  assert.throws(() => E.elyApprovals({ token: EGG, router: ur, amount: 0n, allowance: 0n, p2Amount: 0n, p2Expiry: 0, now }), /size/);
});

// (release 9, owner in chat 2026-11-05: “yes, the Permit2 fix”) the live revert: tx 0x57f0c734…7781, block 829998, EINU — Permit2
// AllowanceExpired(1793873306 = 10:08:26Z). The allowance was set 15 min before; the sell read a block time 20 s before expiry,
// reused it (the old rule renewed only within 30 s) and was included 19 s after it had expired.
test('Permit2 (r9): an allowance expiring 20 s after signing is renewed, for 30 minutes from the later of block time and wall clock', () => {
  const ur = E.ELY_VENUES['ep-v3'].router, amt = 12345n, expiry = 1_793_873_306;
  const signedAt = expiry - 20;                        // the read's block time when the sell was built
  const ap = E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: expiry, now: signedAt, wall: signedAt });
  assert.equal(ap.length, 1, 'renewed (the old rule left it: expiry > now + 30)');
  assert.equal(ap[0].to, E.ELY_PERMIT2); assert.deepEqual(decP2(ap[0].data), [EGG, ur, amt, signedAt + 1800]);
  // a 1-minute inclusion (3× the 10-20 s seen) still lands with 29 minutes to spare
  assert.ok(signedAt + 60 < Number(decP2(ap[0].data)[3]) - 1500);
  // the boundary: renewed within 10 minutes, left alone above it
  assert.equal(E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: signedAt + 600, now: signedAt, wall: signedAt }).length, 1);
  assert.equal(E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: signedAt + 601, now: signedAt, wall: signedAt }).length, 0);
  // a lagging node: its block time is 5 minutes behind the device clock — the allowance is judged (and set) by the clock
  const lag = E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: amt, p2Expiry: signedAt + 500, now: signedAt - 300, wall: signedAt });
  assert.equal(lag.length, 1, 'only 500 s left by the clock: renewed, though the node thinks 800 s are left');
  assert.equal(Number(decP2(lag[0].data)[3]), signedAt + 1800, 'expiry from the wall clock, never from the lagging block');
  // a device clock behind the chain: the block time wins
  assert.equal(E.elyPermitNow(signedAt, signedAt - 120), signedAt);
  assert.equal(E.elyPermitExpiry(signedAt, signedAt - 120), signedAt + 1800);
  // with no `wall` given the device clock is used (the vault frame's calls pass none)
  const t0 = Math.floor(Date.now() / 1000);
  const live = E.elyApprovals({ token: EGG, router: ur, amount: amt, allowance: amt, p2Amount: 0n, p2Expiry: 0, now: 1 });
  assert.ok(Number(decP2(live[0].data)[3]) >= t0 + 1800 && Number(decP2(live[0].data)[3]) <= t0 + 1802, 'wall clock + 30 min');
});

test('Permit2 (r9): the sell probe\'s approve (elyEoaCalls #7) carries the same expiry rule', () => {
  const c = E.elyCandidates(LINERPE, v4('uni-v4', LINERPE_KEY)).find((x) => x.hinted);
  const now = 1_793_873_286, calls = E.elyEoaCalls({ wallet: '0x' + '11'.repeat(20), c, token: LINERPE, amountIn: 10n ** 15n, floor: 1n, sellAmt: 5n, deadline: BigInt(now + 300), now, buyGas: 500_000n, sellGas: 500_000n, wall: now + 300 });
  const p2 = calls.find((x) => String(x.to).toLowerCase() === E.ELY_PERMIT2);
  assert.ok(p2, 'the probe approves the router through Permit2');
  assert.equal(Number(decP2(p2.data)[3]), now + 300 + 1800, 'from the later of the block time and the clock');
});

test('resets after a sell that did not land: only what this sell gave', () => {
  const ur = E.ELY_VENUES['uni-v4'].router;
  const r = E.elyResets({ token: LINERPE, router: ur, amount: 100n, allowance: 100n, p2Amount: 100n });
  assert.equal(r.length, 2); assert.deepEqual(dec20(r[0].data), [E.ELY_PERMIT2, 0n]); assert.deepEqual(decP2(r[1].data), [LINERPE, ur, 0n, 0]);
  assert.deepEqual(E.elyResets({ token: LINERPE, router: ur, amount: 100n, allowance: 0n, p2Amount: 0n }), [], 'consumed: nothing to reset');
  assert.deepEqual(E.elyResets({ token: LINERPE, router: ur, amount: 100n, allowance: 2n ** 255n, p2Amount: 0n }), [], 'somebody else\'s larger allowance is left alone');
});

test('the last look before the key: only these four kinds of transaction are ever signed on Elysium', () => {
  const ur = E.ELY_VENUES['uni-v4'].router, token = LINERPE;
  const exec = E.elyExecute(E.elyBuyEnc(E.elyCandidates(token, v4('uni-v4', LINERPE_KEY)).find((x) => x.hinted), token, 10n, 1n), 9n);
  assert.equal(E.elyTxProblem({ to: ur, data: exec, value: 10n }, token, 10n), '');
  assert.match(E.elyTxProblem({ to: ur, data: exec, value: 11n }, token, 10n), /more HYPE/);
  assert.match(E.elyTxProblem({ to: ur, data: '0x24856bc3', value: 0n }, token, 0n), /not a router execute/);
  const ap = (spender, amt = 1n) => encodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], args: [spender, amt] });
  assert.equal(E.elyTxProblem({ to: token, data: ap(E.ELY_PERMIT2), value: 0n }, token, 0n), '');
  assert.match(E.elyTxProblem({ to: token, data: ap(ur), value: 0n }, token, 0n), /approve to Permit2/, 'a direct approval to a router is never signed');
  assert.match(E.elyTxProblem({ to: token, data: '0xa9059cbb' + '0'.repeat(128), value: 0n }, token, 0n), /approve to Permit2/, 'no transfer');
  assert.match(E.elyTxProblem({ to: token, data: ap(E.ELY_PERMIT2), value: 1n }, token, 0n), /value/);
  const p2 = (tok, spender) => encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [tok, spender, 1n, 2] });
  assert.equal(E.elyTxProblem({ to: E.ELY_PERMIT2, data: p2(token, ur), value: 0n }, token, 0n), '');
  assert.match(E.elyTxProblem({ to: E.ELY_PERMIT2, data: p2(token, '0x7d812380c241b331d753e8eef1cefdea4e539496'), value: 0n }, token, 0n), /known router/);
  assert.match(E.elyTxProblem({ to: E.ELY_PERMIT2, data: p2(EGG, ur), value: 0n }, token, 0n), /this coin/);
  assert.match(E.elyTxProblem({ to: '0x' + '9'.repeat(40), data: '0x', value: 0n }, token, 0n), /never calls/);
});

test('ceilings: gas price, fee, deadline, Permit2 life, impact / round trip / tax limits', () => {
  assert.equal(E.ELY_MAX_GAS_PRICE, 5_000_000_000n);
  assert.equal(E.ELY_MAX_FEE_WEI, 5n * 10n ** 16n);
  assert.equal(E.ELY_DEADLINE_S, 300);
  assert.equal(E.ELY_PERMIT_S, 1800); assert.equal(E.ELY_PERMIT_REFRESH_S, 600);
  assert.equal(E.ELY_IMPACT_MAX_BPS, 3000n); assert.equal(E.ELY_ROUNDTRIP_MAX_BPS, 3000n); assert.equal(E.ELY_TAX_MAX_BPS, 1000n);
  // release 6: + Kleos, BOXA, Eleos, RonsPad (each pinned by code, ELY_ROUTER_PINS)
  // release 7: + the 8 venue routers (B:	mpelysium-venues; deployed 2026-11-04, code == pin on both nodes)
  assert.deepEqual([...E.ELY_ROUTERS].sort(), ['0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a', '0x45a7f90f3cfd605c71cc2abf3ef50e67707d8384', '0x49854cdc529f76dcf3b90b2ec04e6cfa94fd4b3f', '0x53b1d0dc90912bbdb16f30edd8c9b4f0e30d0093', '0x6914053b2bdcd1c30bb5476fed6018a2ae0c3449', '0x72f0b62115788a3e73c2e64130a181588f266f98', '0x751cefb96ac88db5327d39e0fbdd5d882d80b430', '0x78088ead4aea127d9134d992b29b40cfb6542964', '0x90d63fd4ab5bc0b9815cda273cfd5b918afb9168', '0x93a5d9271ac5dbe68a2b96ef7a23576eaad15a11', '0xa226f04cececc3b1ee0ac6f18132db96987cea37', '0xe8bd48bf9485d0a3304448175de9738c7d550f2b', '0xeff2423d2b7fb97cbc41994b01c7a8177990394f', '0xf2ee65cab8a036b2f344a3b52ed13327de5e8092']);
  assert.deepEqual(Object.keys(E.ELY_ROUTER_PINS).sort(), [...E.ELY_ROUTERS].sort());
});

test('src/elysiumCore.ts is the file the trench server shares (same sha256 asserted in trench scripts/elysium-trade.test.mjs)', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(readFileSync(new URL('../src/elysiumCore.ts', import.meta.url), 'utf8').replace(/\r/g, '')).digest('hex');
  assert.equal(sha, readFileSync(new URL('./fixtures/elysium-core.sha256', import.meta.url), 'utf8').trim());
});

test('the probe bytes are the build of contracts/ElysiumProbe.sol (solc 0.8.26; skipped without SOLC_DIR)', { skip: !process.env.SOLC_DIR }, async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [new URL('../scripts/elysium-probe-build.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '--check'], { encoding: 'utf8' });
  assert.match(out, /MATCH/);
});

test('r2 M-T4: Elysium slippage — 5 % unless the user chose one', () => {
  assert.equal(E.elySlippageBps(12, false), 500n, 'the engine default (never set) becomes 5 % on Elysium');
  assert.equal(E.elySlippageBps(12, true), 1200n, 'a setting the user chose is respected');
  assert.equal(E.elySlippageBps(2.5, true), 250n);
  assert.equal(E.elySlippageBps(0, true), 500n);
  assert.equal(E.elySlippageBps(500, true), 10_000n, 'clamped to 100 % (the vault\'s own dialog guards > 15 %)');
});

// r3 (N1 / N4 / N6): one pool, one fixed size (0.002 HYPE round trip) on both sides; the server's age; buys fail closed, sells only
// refuse on a fresh independent disagreeing reading of the very pool they sell into
const POOL = '0xp00l', REF = E.ELY_LANE_REF_IN;
const reading = (o = {}, c = {}) => ({ checks: [{ pool: POOL, buyIn: String(REF), buyOut: '1000000', sellIn: '1000000', sellOut: '1900000000000000', ...c }], ageMs: 5_000, independent: true, ...o });
const own = (o = {}) => ({ buyOut: 1_000_000n, sellIn: 1_000_000n, sellOut: 1_900_000_000_000_000n, ...o });
test('r3 N1: a SELL goes whenever the second reading cannot judge it — every listed case', () => {
  const S = (r, o = own(), pool = POOL, slip = 500n) => E.elyLaneProblem('sell', pool, o, r, slip);
  assert.equal(S(null), '', '(a)/(b)/(c) no reading at all: the coin failed the buy guards, is not indexed, the lane is down or busy');
  assert.equal(S(reading({ independent: false })), '', 'N4: the reading came from the vault\'s own node');
  assert.equal(S(reading({ ageMs: 61_000 })), '', '(d) stale by the SERVER\'s count (no device clock involved)');
  assert.equal(S(reading({ ageMs: NaN })), '', 'age unreadable');
  assert.equal(S(reading({}, { pool: '0xother' })), '', '(f) the reading is for another pool');
  assert.equal(S(reading({}, { buyIn: '123' })), '', 'a reading at another size');
  assert.equal(S(reading({}, { sellOut: 'x' })), '', 'unreadable numbers');
  assert.equal(S(reading(), null), '', 'the vault has no own reading at the fixed size for that pool');
  assert.equal(S(reading(), own({ sellOut: 1_750_000_000_000_000n })), '', '(e) 7.9 % worse at the fixed size is inside the 10 % bound; a large position\'s own impact never enters it');
  assert.equal(S(reading(), own({ sellOut: 500_000_000_000_000n }), POOL, 10_000n), '', 'a 100 % slippage setting');
  // the one refusal: fresh, independent, same pool, same size, and the vault's HYPE back is worse by more than max(slippage, 10 %)
  assert.match(S(reading(), own({ sellOut: 1_330_000_000_000_000n })), /30% worse than motion's second reading of this pool/);
});
test('r3 N1: a BUY needs the reading (fail closed) and compares the picked pool at the fixed size (N6)', () => {
  const B = (r, o = own(), pool = POOL) => E.elyLaneProblem('buy', pool, o, r, 500n);
  assert.equal(B(reading()), '');
  assert.match(B(null), /could not confirm/);
  assert.match(B(reading({ independent: false })), /same node/);
  assert.match(B(reading({ ageMs: 61_000 })), /too old/);
  assert.match(B(reading({}, { pool: '0xother' })), /no second price reading for this pool/);
  assert.match(B(reading({}, { buyIn: '123' })), /unreadable/);
  assert.match(B(reading(), null), /no price at the reference size/);
  assert.equal(B(reading(), own({ buyOut: 910_000n })), '', '9 % worse: inside the bound');
  assert.match(B(reading(), own({ buyOut: 700_000n })), /30% worse/);
  assert.equal(E.elyLaneProblem('buy', POOL, own({ buyOut: 860_000n }), reading(), 1500n), '', 'a 15 % slippage widens the bound');
  assert.equal(B(reading(), own({ buyOut: 5_000_000n })), '', 'a better figure is never refused');
  assert.equal(E.ELY_LANE_REF_IN, 2_000_000_000_000_000n);
  assert.equal(E.ELY_LANE_MAX_AGE_MS, 60_000);
});
test('r3 N5: Elysium keeps its own slippage key; nothing else writes it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.equal(E.ELY_SLIP_KEY, 'trenches.engine.elysium.slippage');
  assert.match(src, /if \(CFG\.key === 'elysium' && s && typeof s === 'object' && 'slippage' in s\) \{ try \{ localStorage\.setItem\(ELY\.ELY_SLIP_KEY/, 'only a settings save IN the Elysium frame writes it');
  assert.equal(src.split('ELY.ELY_SLIP_KEY').length - 1, 2, 'one writer (settingsSet in the Elysium frame), one reader (elySlip)');
  assert.match(src, /const elySlip = \(s: Settings\): bigint => \{ let v: string \| null = null; try \{ v = localStorage\.getItem\(ELY\.ELY_SLIP_KEY\); \} catch \{\} return v != null \? ELY\.elySlippageBps\(Number\(v\), true\) : ELY\.elySlippageBps\(s\.slippage, false\); \};/, 'the global setting (which a save / restore writes as 12) is ignored on Elysium');
});
test('r3 N2: the plain-wallet proof runs with validation and the next block time', async () => {
  assert.deepEqual(E.elySimBlock(1_793_800_000), { validation: true, blockOverrides: { time: '0x' + (1_793_800_001).toString(16) } });
  assert.deepEqual(E.elySimBlock(1_793_800_000, 100_000_000n), { validation: true, blockOverrides: { time: '0x' + (1_793_800_001).toString(16), baseFeePerGas: '0x5f5e100' } }, 'the latest base fee too');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /ELY\.elyEoaCalls\(\{ wallet: first, c: pick!\.c, token, amountIn: amountBuy, floor, sellAmt, deadline, now: ts, buyGas, sellGas: backGas \}\), amountBuy \+ QUOTE_FUNDING, gasPrice, \{ latestTs: ts, baseFee, block: b0\.number \?\? undefined \}\)/, 'the click\'s proof passes the real-block parameters');
  assert.match(src, /\.\.\.\(blk \? \{ validation: true \} : \{\}\)/);
});
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sim = (o = {}) => { const ok = { status: '0x1', returnData: '0x', gasUsed: '0x30d40' }; const r = Array.from({ length: 11 }, () => ({ ...ok }));
  const v = { eth0: 10n ** 18n, coin1: 0n, eth3: 10n ** 18n - 10n ** 16n, coin4: 1000n, eth9: 10n ** 18n - 10n ** 16n + 9n * 10n ** 15n, coin10: 10n, ...o };
  r[0].returnData = word(v.eth0); r[1].returnData = word(v.coin1); r[3].returnData = word(v.eth3); r[4].returnData = word(v.coin4); r[9].returnData = word(v.eth9); r[10].returnData = word(v.coin10);
  for (const i of o.fail || []) r[i] = { status: '0x0', returnData: '0x', gasUsed: '0x0' };
  return r; };
test('r2 M-T2: the plain-wallet proof — the calls, in order, as the EOA', () => {
  const c = E.elyCandidates(LINERPE, v4('uni-v4', LINERPE_KEY)).find((x) => x.hinted);
  const w = '0x' + '5'.repeat(40);
  const calls = E.elyEoaCalls({ wallet: w, c, token: LINERPE, amountIn: 10n ** 16n, floor: 900n, sellAmt: 990n, deadline: 9n, now: 100, buyGas: 250_000n, sellGas: 180_000n, wall: 100 });
  assert.equal(calls.length, 11);
  // r4 (M2): the buy and the sell-back at the limits they are signed with; approvals at ELY_APPROVE_GAS
  assert.equal(calls[2].gas, '0x' + (250_000).toString(16)); assert.equal(calls[8].gas, '0x' + (180_000).toString(16));
  for (const i of [5, 6, 7]) assert.equal(calls[i].gas, '0x' + E.ELY_APPROVE_GAS.toString(16));
  assert.ok([2, 5, 6, 7, 8].every((i) => calls[i].from === w), 'every state-changing call from the wallet itself');
  assert.ok([0, 1, 3, 4, 9, 10].every((i) => calls[i].from === E.ELY_OBSERVER), 'r3 N2: balances are read by the observer (its fees never touch the wallet numbers)');
  assert.ok(calls.every((x) => /^0x[0-9a-f]+$/.test(x.gas)), 'r3 N2: an explicit gas limit on every call (validation)');
  assert.equal(calls[2].to, c.router); assert.equal(calls[2].value, '0x2386f26fc10000');
  assert.equal(calls[2].data, E.elyExecute(E.elyBuyEnc(c, LINERPE, 10n ** 16n, 900n), 9n), 'the buy exactly as it will be signed, floor included');
  assert.deepEqual(low(decodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], data: calls[5].data }).args), [E.ELY_PERMIT2, 0n]);
  assert.deepEqual(low(decodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], data: calls[6].data }).args), [E.ELY_PERMIT2, 990n]);
  assert.deepEqual(low(decodeFunctionData({ abi: PERMIT2_ABI, data: calls[7].data }).args), [LINERPE, c.router, 990n, 100 + 1800]);
  assert.equal(calls[8].data, E.elyExecute(E.elySellEnc(c, LINERPE, 990n, 0n), 9n));
  for (const t of calls) assert.equal(E.elyTxProblem({ to: t.to, data: t.data, value: BigInt(t.value) }, LINERPE, 10n ** 16n) === '' || [E.ELY_MULTICALL3, LINERPE].includes(t.to), true);
});
test('r2 M-T2: the plain-wallet proof — every way it refuses', () => {
  const o = { amountIn: 10n ** 16n, floor: 900n, sellAmt: 990n };
  assert.deepEqual(E.elyEoaProblem(sim(), o), { problem: '', buyGas: 200_000n });
  // r3 N2: under validation the wallet pays its gas — the buy may take its amount plus at most its own gas at the call's price
  const fee = 200_000n * 300_000_000n;
  assert.equal(E.elyEoaProblem(sim({ eth3: 10n ** 18n - 10n ** 16n - fee }), { ...o, gasPrice: 300_000_000n }).problem, '');
  assert.match(E.elyEoaProblem(sim({ eth3: 10n ** 18n - 10n ** 16n - fee - 1n }), { ...o, gasPrice: 300_000_000n }).problem, /more HYPE/);
  assert.match(E.elyEoaProblem(null, o).problem, /did not answer/);
  assert.match(E.elyEoaProblem(sim({ fail: [2] }), o).problem, /buy would not go through as a plain wallet/);
  assert.match(E.elyEoaProblem(sim({ coin4: 899n, coin10: 0n }), o).problem, /less than the floor/, 'the coin gives an EOA less than the probe said');
  assert.match(E.elyEoaProblem(sim({ eth3: 10n ** 18n - 2n * 10n ** 16n }), o).problem, /more HYPE/);
  for (const i of [5, 6, 7, 8]) assert.match(E.elyEoaProblem(sim({ fail: [i] }), o).problem, /plain wallet right after the buy \(honeypot/);
  assert.match(E.elyEoaProblem(sim({ coin10: 100n }), o).problem, /another amount/);
  assert.match(E.elyEoaProblem(sim({ eth9: 10n ** 18n - 10n ** 16n + 6n * 10n ** 15n }), o).problem, /only 60\.0%/);
  assert.match(E.elyEoaProblem(sim({ fail: [0] }), o).problem, /did not answer/);
  // r7b: HYPE that comes BACK from the router's final SWEEP (other traders' leftovers stranded in the Universal Router; 4 Nov: 0.98 HYPE in
  // Uniswap's router) is not an overspend — the bound is on what the buy takes; an unreadable balance word still refuses
  const gain = 10n ** 18n + 97n * 10n ** 16n;
  assert.equal(E.elyEoaProblem(sim({ eth3: gain, eth9: gain + 9n * 10n ** 15n }), o).problem, '', 'the router handed the wallet 0.98 HYPE: bought');
  { const r = sim(); r[3].returnData = '0x'; assert.match(E.elyEoaProblem(r, o).problem, /did not answer/, 'an unreadable balance is not a gain'); }
});

// ── r4 (merged review M1 / M2 / L2) ──
test('r4 M1: a SELL is judged only by a reading at most 5 s old (the server\'s count); a fresh disagreeing one is a question, never "not sent"', () => {
  const POOL = '0x' + 'ab'.repeat(32);
  const reading = (o = {}) => ({ checks: [{ pool: POOL, buyIn: String(E.ELY_LANE_REF_IN), buyOut: '1000000', sellIn: '1000000', sellOut: String(19n * 10n ** 14n) }], ageMs: 0, independent: true, ...o });
  const own = (sellOut) => ({ buyOut: 1_000_000n, sellIn: 1_000_000n, sellOut });
  const S = (r, o) => E.elyLaneProblem('sell', POOL, o, r, 500n);
  // the reviewer's case: a reading 55 s old and 15 % above the live price — the sell goes
  assert.equal(S(reading({ ageMs: 55_000 }), own((19n * 10n ** 14n * 85n) / 100n)), '', '55 s old: ignored for a sell');
  assert.equal(S(reading({ ageMs: 5_001 }), own(10n ** 14n)), '', 'just over 5 s: ignored');
  const q = S(reading({ ageMs: 4_000 }), own((19n * 10n ** 14n * 85n) / 100n));
  assert.match(q, /15% worse than motion's second reading of this pool$/, 'a fresh disagreement is reported');
  assert.doesNotMatch(q, /not sent/, 'and it is a question for the user (the engine asks), not a refusal');
  assert.equal(E.ELY_LANE_SELL_MAX_AGE_MS, 5_000);
  // buys keep the 60 s window and fail closed
  assert.match(E.elyLaneProblem('buy', POOL, { buyOut: 800_000n, sellIn: 1n, sellOut: 1n }, reading({ ageMs: 55_000 }), 500n), /20% worse/);
});
test('r4 M1: the engine re-reads fresh before deciding, and on a sell ASKS with both figures (one dialog per click)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(src, /async function elyLaneCheck\(token: `0x\$\{string\}`, fresh = false, wallets: string\[\] = \[\], sized: \{ side: 'buy' \| 'sell'; size: bigint \} \| null = null, avoid: string\[\] = \[\]\)/);
  assert.match(src, /let p = !fresh && !sized && !wallets\.length && !avoid\.length && e && now - e\.t < 5_000 \? e\.p : null;/, 'a fresh read skips the device memo');
  assert.match(src, /const q = \[fresh \|\| sized \? 'fresh=1' : '', sized \? `side=\$\{sized\.side\}&size=\$\{sized\.size\.toString\(\)\}` : '', avoid\.length \? 'avoid=' \+ avoid\.slice\(0, 3\)\.map\(encodeURIComponent\)\.join\(','\) : ''\]/);
  assert.match(src, /const laneP = shared\.once\(`ely:lane:\$\{lc\(token\)\}:\$\{amountBuy\}`, \(\) => elyLaneCheck\(token, side === 'sell', shared\.addresses, side === 'buy' \? \{ side: 'buy', size: amountBuy \} : null\)\);/, 'a sell reads fresh from the start; a buy asks at its size');
  const sell = src.slice(src.indexOf('// ── sell ──'), src.indexOf('// the preflight of the same click'));
  assert.match(sell, /if \(why\) why = ELY\.elyLaneProblem\('sell', pick!\.c\.pool, own, await shared\.once\(`ely:fresh:\$\{lc\(token\)\}`, \(\) => elyLaneCheck\(token, true\)\), slippageBps\);/);
  assert.match(sell, /const go = await shared\.once\(`ely:sellask:\$\{lc\(pick!\.c\.pool\)\}`, \(\) => ask\(\{ title: 'Prices disagree', danger: true, ok: 'Sell anyway'/);
  assert.doesNotMatch(sell, /elyLaneProblem\('sell'[^\n]*if \(why\) throw new Error\(why\)/, 'no silent refusal of a sell');
  const buy = src.slice(src.indexOf("if (side === 'buy') {", src.indexOf('async function elyTradeOne')), src.indexOf('// ── sell ──'));
  assert.match(buy, /if \(why\) why = ELY\.elyLaneProblem\('buy', pick!\.c\.pool, own, await shared\.once\(`ely:fresh:\$\{lc\(token\)\}`, \(\) => elyLaneCheck\(token, true\)\), slippageBps\);\n      if \(why\) throw new Error\(why\);/, 'a buy is refused only on a fresh reading');
});
test('r4 M2: one gas formula — the proof, the sell-time simulation and the signature use the same limits', async () => {
  assert.equal(E.elySwapGas(0n), 0n);
  assert.equal(E.elySwapGas(200_000n), 360_000n, 'measured + 50 % + 60 k');
  assert.equal(E.elySwapGas(10_000_000n), E.ELY_SWAP_GAS_CAP, 'capped');
  assert.ok(E.ELY_SWAP_GAS_CAP * E.ELY_MAX_GAS_PRICE <= E.ELY_MAX_FEE_WEI, 'the cap at the highest gas price stays under the fee ceiling');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  const buy = src.slice(src.indexOf("if (side === 'buy') {", src.indexOf('async function elyTradeOne')), src.indexOf('// ── sell ──'));
  assert.match(buy, /const buyGas = ELY\.elySwapGas\(pick!\.s\.buyGas\), backGas = ELY\.ELY_SWAP_GAS_CAP;/, 'r5 (B1): the proof\'s sell-back at the cap');
  assert.match(buy, /return elySend\(wallet, account, token, tx, amountBuy, gasPrice, buyGas, shared\);/, 'signed at the proven limit');
  assert.doesNotMatch(buy, /estimateGas/, 'no separate estimate decides the buy\'s gas any more');
  const sell = src.slice(src.indexOf('// ── sell ──'), src.indexOf('// the preflight of the same click'));
  assert.match(sell, /let gases: bigint\[\] = \[\.\.\.approvals\.map\(\(\) => ELY\.ELY_APPROVE_GAS\), sellGas\];/);
  assert.match(sell, /gas: hxg\(g\[i\]\) \}\)\), null, gasPrice, \{ latestTs: now, baseFee: block\.baseFeePerGas \?\? undefined, block: block\.number \?\? undefined \}\);/, 'simulated at those limits, with validation (N2)');
  assert.match(sell, /await elySend\(wallet, account, token, txs\[i\], 0n, gasPrice, gases\[i\], shared\);/);
  assert.match(sell, /hash = await elySend\(wallet, account, token, sellTx, 0n, gasPrice, gases\[gases\.length - 1\], shared\);/);
});
test('r4 L2: the settings screen shows Elysium\'s own slippage; a save in the Elysium frame writes only that key', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(src, /settingsGet: async \(\) => \{ const st = loadSettings\(\); return \{ ok: true, settings: \{ \.\.\.st, slippage: CFG\.key === 'elysium' \? Number\(elySlip\(st\)\) \/ 100 : laneSlip\(st\),/, 'ship (on release #3): Elysium shows its own key; every other frame its lane figure (TC-S1)');
  assert.match(src, /delete s\.slippage; \}   \/\/ \(trade-core\.patch E10: N5, r4 L2\)\n    \/\/ TC-S1 \/ TC-S2 \/ TC-M1: per-lane switches/, 'ship: the Elysium write runs before the per-lane block, so the lane slippage of other frames is untouched');
  assert.match(src, /const shown = \{ \.\.\.settings, slippage: CFG\.key === 'elysium' \? Number\(elySlip\(settings\)\) \/ 100 : laneSlip\(settings\),/);
  assert.match(src, /localStorage\.setItem\(ELY\.ELY_SLIP_KEY, String\(Math\.min\(100, Math\.max\(0\.1, Number\(s\.slippage\) \|\| 5\)\)\)\); \} catch \{\} delete s\.slippage; \}/, 'the global slippage is left alone in the Elysium frame');
  assert.equal(src.split('ELY.ELY_SLIP_KEY').length - 1, 2, 'one writer, one reader');
});
test('r4 preview: /check carries the preview cookie (credentials) and the click\'s wallets; nothing else changes the frozen transport', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(src, /credentials: 'include', headers, signal: AbortSignal\.timeout\(OWN_TIMEOUT\)/);
  assert.match(src, /'x-ely-wallets': wallets\.slice\(0, 8\)\.map\(lc\)\.join\(','\)/);
  // (earn-ship, 2026-11-04) + Earn's one geo request to motion's own /api/earn/access (the owner-preview cookie; test/earn-gate.mjs)
  assert.equal(src.split("credentials: 'include'").length - 1, 2, 'only /check and Earn\'s /api/earn/access send credentials (motion\'s own host)');
  assert.ok(src.split('\n').filter((l) => l.includes("credentials: 'include'") && !l.includes('OWN_TIMEOUT')).every((l) => l.includes("'/api/earn/access'")), 'the second one is Earn\'s access read');
});

// ── r5 (review of r4: B1 / B7 / R2 / R3 / R5) ──
test('r5 B7: the floor from the more conservative reading at the CLICK\'s size; a buy far below the other operator is refused', () => {
  const POOL = '0x' + 'ab'.repeat(32), size = 10n ** 17n;
  const reading = (o = {}) => ({ checks: [], ageMs: 0, independent: true, sized: [{ pool: POOL, side: 'buy', size: size.toString(), out: '1000000' }, { pool: POOL, side: 'sell', size: '5000', out: String(10n ** 16n) }], ...o });
  assert.equal(E.elyLaneSizedOut(reading(), POOL, 'buy', size), 1_000_000n);
  assert.equal(E.elyLaneSizedOut(reading(), POOL, 'buy', size + 1n), null, 'another size: nothing');
  assert.equal(E.elyLaneSizedOut(reading({ independent: false }), POOL, 'buy', size), null, 'not independent: nothing');
  assert.equal(E.elyLaneSizedOut(reading({ ageMs: 61_000 }), POOL, 'buy', size), null, 'stale: nothing');
  // a node that under-quotes the real size (900k vs 1M) cannot widen the buy floor: it is set from the other operator
  assert.equal(E.elySizedFloor('buy', 900_000n, 1_000_000n, 500n), E.elyFloor(1_000_000n, 500n));
  assert.equal(E.elySizedFloor('buy', 1_000_000n, null, 500n), E.elyFloor(1_000_000n, 500n), 'no reading: our own');
  assert.match(E.elySizedBuyProblem(700_000n, 1_000_000n, 500n), /30% worse than motion's second reading at your size/);
  assert.equal(E.elySizedBuyProblem(950_000n, 1_000_000n, 500n), '', 'inside the bound');
  // r6 (Q2): a sell floor is NEVER raised: own quote × (1 − slippage), whatever the other reading says
  const own = 10n ** 16n;
  for (const lane of [own * 2n, own / 2n, (own * 103n) / 100n, null]) assert.equal(E.elySizedFloor('sell', own, lane, 500n), E.elyFloor(own, 500n));
  assert.equal(E.elySizedSellGap(own, (own * 130n) / 100n, 500n).startsWith('23.07'), true, 'a reading 30 % above ours: a question');
  assert.equal(E.elySizedSellGap(own, (own * 105n) / 100n, 500n), '', 'inside the bound: nothing');
  assert.equal(E.elySizedSellGap(own, null, 500n), '');
  // r7 (X4): the auto-sell floor — median of three; bounded without a third; one reading only = own floor
  const H = 10n ** 16n, f = (x) => E.elyFloor(x, 500n);
  assert.equal(E.elyAutosellFloor((H * 70n) / 100n, H, H, 500n), f(H), 'own lies −30 %: the median of three is the honest figure');
  assert.equal(E.elyAutosellFloor(H, (H * 130n) / 100n, H, 500n), f(H), 'the second reading lies +30 %: the median is honest again');
  assert.equal(E.elyAutosellFloor(H / 10n, H, null, 500n), (H * 8_000n) / 10_000n, 'own lies −90 %, no third: the floor is second × (1 − 2·max(s,10 %)) = 0.8 ×');
  assert.equal(E.elyAutosellFloor(H, (H * 110n) / 100n, null, 500n), f(H), 'a second reading 10 % high, no third: own × (1 − s) stands (0.88 < 0.95)');
  assert.equal(E.elyAutosellFloor(H, null, null, 500n), f(H));
  assert.equal(E.elyAutosellFloor(H, null, (H * 90n) / 100n, 500n), f(H), 'only a third reading: treated as the other one (bounded)');
  assert.equal(E.elyAutosellFloor(H, H, H, 2_000n), E.elyFloor(H, 2_000n));
  assert.equal(E.elyOpsDisjoint(['a.com'], ['b.com']), true); assert.equal(E.elyOpsDisjoint(['a.com'], ['a.com', 'b.com']), false); assert.equal(E.elyOpsDisjoint(undefined, ['b']), false);
});
test('r5 B1 / R5 / R2 / R3: the proof sells back at the cap; a sell escalates to the caps; an unanswered dialog lets the sell go; buys need mayBuy', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  const buy = src.slice(src.indexOf("if (side === 'buy') {", src.indexOf('async function elyTradeOne')), src.indexOf('// ── sell ──'));
  const sell = src.slice(src.indexOf('// ── sell ──'), src.indexOf('// the preflight of the same click'));
  assert.match(buy, /backGas = ELY\.ELY_SWAP_GAS_CAP;/);
  assert.match(src, /sellGas: ELY\.ELY_SWAP_GAS_CAP \}\),/, 'the preview proof too');
  assert.match(sell, /const capped = \[\.\.\.approvals\.map\(\(\) => ELY\.ELY_APPROVE_GAS_CAP\), ELY\.ELY_SWAP_GAS_CAP\];/);
  assert.match(sell, /if \(again && again\.every\(\(c\) => c\?\.status === '0x1'\)\) \{ gases = capped; res = again; \}/, 'signed at the limits its own simulation passed at');
  assert.ok(E.ELY_SWAP_GAS_CAP * E.ELY_MAX_GAS_PRICE <= E.ELY_MAX_FEE_WEI && E.ELY_APPROVE_GAS_CAP < E.ELY_SWAP_GAS_CAP);
  // r6 (P1): no timer at all; only an unattended (auto-sell) click skips the question
  assert.doesNotMatch(sell, /setTimeout|timedOut/);
  assert.match(sell, /const unattended = String\(click\.id \|\| ''\)\.startsWith\('autosell:'\);/);
  assert.match(sell, /if \(\(why \|\| sizedGap\) && !unattended\) \{/);
  assert.match(buy, /if \(lr && lr\.mayBuy === false\) throw new Error\('Elysium buys are not open to this session on motion \(preview\)/);
  assert.match(sell, /const sizedP = elyLaneCheck\(token, true, \[account\.address\], \{ side: 'sell', size: amountIn \}\)\.catch\(\(\) => null\);/);
  assert.match(sell, /const floor = autoFloor \?\? ELY\.elySizedFloor\('sell', ownBack, null, slippageBps\);/, 'r6 (Q2): own quote × (1 − slippage); r7 (X4): an auto-sell whose readings disagree takes the median / bounded floor; r8: own part only');
  assert.match(sell, /const ownBack = ELY\.elySellOwnBack\(pick!\.s\.nativeBack, pick!\.c\.pair, leftover\);/, 'r8: a WHYPE-pool sell floors on its own part (the router\u2019s WHYPE taken off)');
  assert.match(sell, /const ticketP = elyTicket\(hv as any, account\);/); assert.match(sell, /await Promise\.race\(\[ticketP, elyPause\(800\)\]\);\s*\/\/[^\n]*\n\s*const probeP = elyProbe\(hv,/, 'r8 (Y1): the ticket goes out before the probe');
  assert.match(sell, /if \(\(why \|\| sizedGap\) && unattended\) \{\n      const r2 = await sizedP, second = ELY\.elyLaneSizedOut\(r2, pick!\.c\.pool, 'sell', amountIn\);\n      const r3 = r2\?\.ops\?\.length \? await elyLaneCheck\(token, true, \[account\.address\], \{ side: 'sell', size: amountIn \}, r2\.ops\)/, 'r7 (X4): the third operator, avoiding the second one');
  assert.match(buy, /if \(laneSized == null\) throw new Error\('motion has no second reading of this pool at your size — not bought/, 'r6 (Q3): fail closed');
});

test('stage 3 → release 7: the HomerPoolHook is REFUSED (owner setRecipient freezes sells); the launch hook stays pinned', () => {
  assert.match(E.elyRouteProblem(QUOTED, v4('ep-v4', QUOTED_KEY)), /refuses/);
  assert.match(E.elyRouteProblem(QUOTED, { ...v4('ep-v4', QUOTED_KEY), hook: { codeHash: '0xd350af6a60352c50a365717fa9c2cfd34e27d274a7893fa5a530d1b76f1e3047' } }), /refuses/);
  assert.ok(!E.elyCandidates(QUOTED, v4('ep-v4', QUOTED_KEY)).some((x) => x.hinted), 'a refused hint adds nothing');
  assert.equal(E.v4PoolId(QUOTED_KEY), '0x88f96934aca58ed9d2d5d080f48985093aa6434d95e8476414b008b593d22044', 'the pool id read on chain');
  assert.equal(E.elyHookPin(E.ELY_VENUES['ep-v4'].manager, HOMER), '', 'release 7: no pin any more');
  assert.equal(E.elyHookPin(E.ELY_VENUES['ep-v4'].manager, '0xe11cafa5901b0aab51eb78251488400f9e4320cc'), '0xe092fe7f04001d4a23e8a3d50b1afbde84ea3abfc2d48da2e96d3cd4f947fee3', 'the launch hook is pinned too');
  assert.equal(E.elyHookPin(E.ELY_VENUES['uni-v4'].manager, HOMER), '', 'not on Uniswap’s PoolManager');
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(E.elyHookPin(E.ELY_VENUES['ep-v4'].manager, k), '', k);
    assert.match(E.elyRouteProblem(QUOTED, v4('ep-v4', { ...QUOTED_KEY, hooks: k })), /bad pool key/);
  }
  assert.equal(E.elyHookPin('0x' + '0'.repeat(40), HOMER), '');
  // every trusted hook has a 32-byte pin and swap permissions (a hook without them never needs one)
  for (const [pm, hooks] of Object.entries(E.ELY_SWAP_HOOKS)) for (const [h, pin] of Object.entries(hooks)) {
    assert.match(pin, /^0x[0-9a-f]{64}$/, h); assert.ok(E.hookSwapFlags(h) !== 0, h); assert.match(pm, /^0x[0-9a-f]{40}$/);
  }
});

// release 6 (B:	mpelysium-hooks): ELY_GUARD measures EVERY pool (router code pin; a hooked pool's hook pin; a buy's hook rules)
const GUARD_IN = [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }, { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint256' }] }];
const guardArgs = (checkData) => { assert.equal(checkData.slice(0, 10), toFunctionSelector('function check(address,bytes32,address,bytes32,address,bytes,(address,bytes,uint8,uint16,uint16,uint16,uint256)[])')); return decodeAbiParameters(GUARD_IN, '0x' + checkData.slice(10)); };
test('stage 3 → release 6: a pool behind a trusted swap hook is measured only through the guard with its hook pin; every pool with its router pin', () => {
  // (release 7: the example is ElysPump's launch hook; the HomerPoolHook is refused)
  const HK = BLOB_EP_KEY.hooks;
  const c = E.elyCandidates(BLOB_EP, v4('ep-v4', BLOB_EP_KEY)).find((x) => x.hinted);
  assert.ok(c && c.pin, 'the hinted launch-hook pool carries its pin');
  assert.deepEqual(c.pin, { manager: E.ELY_VENUES['ep-v4'].manager, slot: E.v4StateSlot(BLOB_EP_KEY), hook: HK, codeHash: E.elyHookPin(E.ELY_VENUES['ep-v4'].manager, HK) });
  const pc = E.probeCase(c, BLOB_EP, { buy: 10n ** 16n, roundTrip: true, deadline: 9999999999n });
  assert.equal(pc.check, E.ELY_GUARD);
  const [router, rpin, h, pin, target, data, rules] = guardArgs(pc.checkData);
  assert.equal(router.toLowerCase(), E.ELY_VENUES['ep-v4'].router); assert.equal(rpin, E.ELY_ROUTER_PINS[E.ELY_VENUES['ep-v4'].router]);
  assert.equal(h.toLowerCase(), HK); assert.equal(pin, c.pin.codeHash);
  assert.equal(target.toLowerCase(), E.ELY_VENUES['ep-v4'].manager); assert.equal(data, c.check.data, 'the guard answers extsload(the pool slot0)');
  assert.deepEqual(rules, [], 'the launch hook (stage 3) carries no rules');
  assert.equal(c.check.target, E.ELY_VENUES['ep-v4'].manager, 'the plain existence check (the lane’s multicall) is unchanged');
  // hookless, beforeInitialize-only and V3 pools: no hook pin; the guard asks the same existence check as in r8, behind the router pin
  for (const x of [...E.elyCandidates(LINERPE, v4('uni-v4', LINERPE_KEY)), ...E.elyCandidates(PERPME, null)]) {
    assert.equal(x.pin, undefined);
    const q = E.probeCase(x, x.poolKey ? LINERPE : PERPME, { buy: 1n, deadline: 1n });
    assert.equal(q.check, E.ELY_GUARD);
    const [r2, rp2, h2, p2, t2, d2, ru2] = guardArgs(q.checkData);
    assert.equal(r2.toLowerCase(), x.router); assert.equal(rp2, E.ELY_ROUTER_PINS[x.router]); assert.equal(h2, ZERO); assert.equal(p2, '0x' + '0'.repeat(64));
    assert.equal(t2.toLowerCase(), x.check.target); assert.equal(d2, x.check.data); assert.deepEqual(ru2, []);
  }
  // the launch hook's pools go through the guard with their pin too
  const l = E.elyCandidates(BLOB_EP, v4('ep-v4', BLOB_EP_KEY)).find((x) => x.hinted);
  const lc = E.probeCase(l, BLOB_EP, { buy: 1n, deadline: 1n });
  assert.equal(lc.check, E.ELY_GUARD); assert.equal(guardArgs(lc.checkData)[3], E.elyHookPin(E.ELY_VENUES['ep-v4'].manager, BLOB_EP_KEY.hooks));
});

test('release 6: the probe state = the probe at the wallet + ELY_GUARD at its fixed empty address; the stage-3 guard bytes (kept for the record) do only what they say', () => {
  const st = E.elyProbeState('0x' + 'ab'.repeat(20), 5n);
  assert.deepEqual(Object.keys(st).sort(), ['0x' + 'ab'.repeat(20), E.ELY_GUARD].sort());
  assert.equal(st['0x' + 'ab'.repeat(20)].code, E.ELYSIUM_PROBE_RUNTIME); assert.equal(st['0x' + 'ab'.repeat(20)].balance, '0x5');
  assert.equal(st[E.ELY_GUARD].code, E.ELY_GUARD_CODE); assert.equal(st[E.ELY_GUARD].balance, undefined);
  assert.match(E.ELY_GUARD, /^0x0{32}[0-9a-f]{8}$/, 'a fixed address with no contract (the override puts the guard there for the probe call only)');
  assert.notEqual(E.ELY_GUARD, E.ELY_HOOK_GUARD);
  // the stage-3 50 bytes: EXTCODEHASH(arg 2) == arg 3, then ONE STATICCALL (no CALL / DELEGATECALL / SSTORE / LOG / CREATE / SELFDESTRUCT)
  const b = E.ELY_HOOK_GUARD_CODE.slice(2).match(/../g).map((x) => parseInt(x, 16));
  const ops = []; for (let i = 0; i < b.length; i++) { ops.push(b[i]); if (b[i] >= 0x60 && b[i] <= 0x7f) i += b[i] - 0x5f; }
  assert.equal(b.length, 50);
  assert.deepEqual(ops.filter((o) => [0xf1, 0xf2, 0xf4, 0xf0, 0xf5, 0xff, 0x55, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4].includes(o)), [], 'nothing that writes or calls out with value');
  assert.equal(ops.filter((o) => o === 0xfa).length, 1, 'one STATICCALL');
  assert.ok(E.ELY_HOOK_GUARD_CODE.includes('631e2eaeaf'), 'the call is PoolManager.extsload(bytes32)');
  assert.equal(toFunctionSelector('function extsload(bytes32)'), '0x1e2eaeaf');
  // ELY_GUARD (solc output, 1,846 bytes): walk the code, no state-changing or value-moving opcode anywhere (STATICCALL only)
  const g = E.ELY_GUARD_CODE.slice(2).match(/../g).map((x) => parseInt(x, 16));
  const gops = []; for (let i = 0; i < g.length; i++) { gops.push(g[i]); if (g[i] >= 0x60 && g[i] <= 0x7f) i += g[i] - 0x5f; }
  assert.deepEqual(gops.filter((o) => [0xf1, 0xf2, 0xf4, 0xf0, 0xf5, 0xff, 0x55, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4].includes(o)), [], 'ELY_GUARD: no CALL / CALLCODE / DELEGATECALL / CREATE / SELFDESTRUCT / SSTORE / LOG');
  assert.ok(gops.filter((o) => o === 0xfa).length >= 2, 'STATICCALLs (the rules, the existence check)');
  assert.ok(gops.includes(0x3f), 'EXTCODEHASH');
});
