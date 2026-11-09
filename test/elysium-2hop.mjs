// Release 17: two-hop Elysium routes (coin → KNTQ / USDC / VOLTA → native HYPE) on Uniswap's PoolManager 0xe2e1 through router 0x1b34.
// Pure: no network (the on-chain proofs are B:\tmp\ely-2hop\sim\proof-*.json, read-only eth_call / eth_simulateV1).
//   node --test test/elysium-2hop.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData } from 'viem';
import * as E from '../src/elysiumCore.ts';

const Z = E.ELY_ZERO;
const PM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', UR = '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a';
const KNTQ = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0', USDC = '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65', VOLTA = '0x0f79931689af199e7cf868ed1107bba2c83c68f7';
const ERA = '0xacbda9f5cd2e043bd70e91c542398307219d41c5', BLOB = '0x547a2a9c5af6e4372ead794e80eaf3f42dbbaaac';
const VOLTA_HOOK = '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc', VOLTA_HASH = '0x5087d2c7278b95cc4b8db5013740d556b37a26e8798c3b4f9a2325cbec4c9c66';
const MONTRA = '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec', MONTRA_HASH = '0x1be97e9e' + '00'.repeat(28);   // a claim (the guard checks it on chain)
const DYN = 0x800000;
const eraLeg = { currency0: VOLTA, currency1: ERA, fee: 0, tickSpacing: 60, hooks: VOLTA_HOOK };
const volta7b18 = { currency0: Z, currency1: VOLTA, fee: 0, tickSpacing: 60, hooks: VOLTA_HOOK };
const kntqC96b = { currency0: Z, currency1: KNTQ, fee: 10000, tickSpacing: 200, hooks: Z };
const kntqD210 = { currency0: Z, currency1: KNTQ, fee: 8000, tickSpacing: 120, hooks: Z };
const blobLeg = { currency0: BLOB, currency1: KNTQ, fee: DYN, tickSpacing: 200, hooks: MONTRA };
const eraRoute = (over = {}) => ({ type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'native', poolKey: eraLeg, via: { token: VOLTA, poolKey: volta7b18 }, ...over });
const blobRoute = (leg = kntqD210, over = {}) => ({ type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'native', poolKey: blobLeg, hook: { codeHash: MONTRA_HASH }, via: { token: KNTQ, poolKey: leg }, ...over });
const GUARD_ABI = [{ name: 'check', type: 'function', stateMutability: 'view', inputs: [{ name: 'router', type: 'address' }, { name: 'routerHash', type: 'bytes32' }, { name: 'hook', type: 'address' }, { name: 'hookHash', type: 'bytes32' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
  { name: 'rules', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'op', type: 'uint8' }, { name: 'i', type: 'uint16' }, { name: 'j', type: 'uint16' }, { name: 'k', type: 'uint16' }, { name: 'value', type: 'uint256' }] }], outputs: [{ type: 'uint256' }] }];
const EXEC_ABI = [{ name: 'execute', type: 'function', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] }];
const POOL_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const SWAP = [{ type: 'tuple', components: [{ name: 'poolKey', ...POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }];
const lowKey = (k) => ({ currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks.toLowerCase() });
const v4Plan = (enc) => {
  assert.equal(enc.commands, '0x10');   // ONE V4_SWAP: no WRAP, no SWEEP, no UNWRAP
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], enc.inputs[0]);
  return { actions, params };
};
const seen = (over = {}) => ({ ran: true, buyOk: true, coinGot: 10n ** 21n, nativeSpent: 10n ** 16n, buyGas: 300_000n, sellOk: true, coinSold: 10n ** 21n, nativeBack: 95n * 10n ** 14n, sellGas: 150_000n, taxSent: 0n, taxGot: 0n, routerKept: false, err: '0x', ...over });

test('the middle tokens are exactly KNTQ, USDC 0xb47c and VOLTA (the lane config quoteTokens), on Uniswap V4 only', () => {
  assert.deepEqual([...E.ELY_VIA_TOKENS], [KNTQ, USDC, VOLTA]);
  assert.equal(E.ELY_VIA_VENUE, 'uni-v4');
  assert.equal(E.ELY_VENUES[E.ELY_VIA_VENUE].manager, PM);
  assert.equal(E.ELY_VENUES[E.ELY_VIA_VENUE].router, UR);
  assert.equal(E.ELY_VIA_MAX_LEGS, 5);
});

test('a two-hop route is signable only with a listed middle token, native HYPE, Uniswap V4 and two valid legs', () => {
  assert.equal(E.elyRouteProblem(ERA, eraRoute()), '');
  assert.equal(E.elyRouteProblem(BLOB, blobRoute()), '');
  assert.equal(E.elyRouteProblem(BLOB, blobRoute(kntqC96b)), '');
  assert.match(E.elyRouteProblem(ERA, eraRoute({ venue: 'ep-v4' })), /Uniswap V4 only/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ venue: 'uni-v3', fee: 3000 })), /Uniswap V4 only/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ pair: 'weth' })), /native HYPE only/);
  const other = '0x1111111111111111111111111111111111111111';
  assert.match(E.elyRouteProblem(ERA, eraRoute({ poolKey: { ...eraLeg, currency0: other }, via: { token: other, poolKey: { ...volta7b18, currency1: other } } })), /does not route through/);
  // the middle token itself (VOLTA is not bought through KNTQ: no third hop)
  assert.match(E.elyRouteProblem(VOLTA, { type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'native', poolKey: { currency0: VOLTA, currency1: KNTQ, fee: 10000, tickSpacing: 200, hooks: Z }, via: { token: KNTQ, poolKey: kntqC96b } }), /not bought through another/);
  // the coin leg must hold the coin and the middle token, the HYPE leg the middle token and native HYPE
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: { token: KNTQ, poolKey: kntqC96b } })), /not quoted in the route's middle token/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: { token: VOLTA, poolKey: { ...volta7b18, currency0: E.ELY_WHYPE.toLowerCase() < VOLTA ? E.ELY_WHYPE : VOLTA, currency1: E.ELY_WHYPE.toLowerCase() < VOLTA ? VOLTA : E.ELY_WHYPE, hooks: Z, fee: 3000 } } })), /not quoted in HYPE/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: { token: VOLTA, poolKey: { currency0: Z, currency1: KNTQ, fee: 10000, tickSpacing: 200, hooks: Z } } })), /does not contain this token/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: { token: VOLTA } })), /no pool key/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: 'x' })), /bad two-hop route/);
  // each leg's own fee / hook rules, exactly as a one-pool route's
  assert.match(E.elyRouteProblem(ERA, eraRoute({ via: { token: VOLTA, poolKey: { ...volta7b18, hooks: Z, fee: 200000 } } })), /above 10 %/);
  assert.match(E.elyRouteProblem(BLOB, blobRoute(kntqD210, { hook: undefined })), /has not been read yet/);   // a dynamic-fee hook needs its code hash
  assert.match(E.elyRouteProblem(BLOB, blobRoute({ currency0: Z, currency1: KNTQ, fee: DYN, tickSpacing: 300, hooks: '0xa129c69d439f30e6ffacc435a1627b7f4f9d30c4' })), /refuses/);
  assert.match(E.elyRouteProblem(ERA, eraRoute({ poolKey: { ...eraLeg, currency0: ERA, currency1: VOLTA } })), /not sorted/);
});

test('one-pool routes are unchanged by the two-hop rules (v4KeyProblem messages, no via = the old path)', () => {
  const nat = { currency0: Z, currency1: ERA, fee: 3000, tickSpacing: 60, hooks: Z };
  assert.equal(E.v4KeyProblem(ERA, nat, PM, 'native'), '');
  assert.equal(E.v4KeyProblem(ERA, eraLeg, PM, 'native'), 'the pool is not quoted in HYPE');
  assert.equal(E.v4KeyProblem(ERA, nat, PM, 'weth'), 'the pool is not quoted in HYPE');
  // the coin leg alone (no via) is still refused as a one-pool route
  assert.equal(E.elyRouteProblem(ERA, { type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'native', poolKey: eraLeg }), 'the pool is not quoted in HYPE');
  const one = E.elyCandidates(ERA, { type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'native', poolKey: nat });
  assert.equal(one.length, 16); assert.ok(one.every((c) => !c.via));
});

test('candidates: the coin leg × (the route\'s HYPE leg, hinted, then the middle token\'s canonical hookless native pools), at most 5', () => {
  const cs = E.elyCandidates(ERA, eraRoute()), two = cs.filter((c) => c.via);
  assert.equal(cs.length, 16 + 5);
  assert.equal(two.length, 5);
  assert.deepEqual(two.map((c) => !!c.hinted), [true, false, false, false, false]);
  assert.equal(cs.filter((c) => c.hinted).length, 1);
  assert.deepEqual(lowKey(two[0].via.poolKey), lowKey(volta7b18));
  assert.deepEqual(two.slice(1).map((c) => [c.via.poolKey.fee, c.via.poolKey.tickSpacing, c.via.poolKey.hooks]), [[100, 1, Z], [500, 10, Z], [3000, 60, Z], [10000, 200, Z]]);
  for (const c of two) {
    assert.equal(c.venue, 'uni-v4'); assert.equal(c.pair, 'native'); assert.equal(c.router, UR);
    assert.deepEqual(lowKey(c.poolKey), lowKey(eraLeg));
    assert.equal(c.via.token, VOLTA);
    assert.equal(c.pool, E.elyViaPathId(eraLeg, c.via.poolKey));
    assert.equal(c.via.pool, E.v4PoolId(lowKey(c.via.poolKey)));
    assert.equal(c.check.target, PM); assert.equal(c.via.check.target, PM);
    // the coin leg's Volta hook: pinned + its rules; tier reviewed (both legs reviewed or hookless)
    assert.equal(c.pin.hook, VOLTA_HOOK); assert.equal(c.pin.codeHash, VOLTA_HASH); assert.ok(c.rules.length > 0);
    assert.equal(c.tier, 'reviewed');
  }
  assert.equal(two[0].via.pin.codeHash, VOLTA_HASH); assert.ok(two[0].via.rules.length > 0);   // the HYPE leg's Volta hook too
  assert.ok(two.slice(1).every((c) => !c.via.pin && !c.via.rules));
  assert.equal(new Set(two.map((c) => c.pool)).size, 5);
  // the route's HYPE leg is a canonical one: no duplicate, 4 two-hop candidates
  const blob = E.elyCandidates(BLOB, blobRoute(kntqC96b)).filter((c) => c.via);
  assert.equal(blob.length, 4);
  assert.ok(blob[0].hinted); assert.deepEqual(lowKey(blob[0].via.poolKey), lowKey(kntqC96b));
});

test('tiers: the weaker leg decides (a Montra dynamic-fee coin leg = unverified: 3 HYPE cap, ≥ 80 % buy-and-sell-back)', () => {
  const two = E.elyCandidates(BLOB, blobRoute()).filter((c) => c.via);
  assert.ok(two.every((c) => c.tier === 'unverified' && c.via.coinTier === 'unverified' && !c.rules));
  assert.equal(two[0].pin.codeHash, MONTRA_HASH);
  // a lane claim of 'auto' cannot lift a dynamic fee above unverified
  assert.ok(E.elyCandidates(BLOB, blobRoute(kntqD210, { hook: { codeHash: MONTRA_HASH, tier: 'auto' } })).filter((c) => c.via).every((c) => c.tier === 'unverified'));
  const c = two[0];
  assert.match(E.elyTierBuyProblem(c, 3n * 10n ** 18n + 1n, seen()), /at most 3 HYPE per buy/);
  assert.equal(E.elyTierBuyProblem(c, 10n ** 16n, seen()), '');
  assert.match(E.elyTierBuyProblem(c, 10n ** 16n, seen({ nativeBack: 79n * 10n ** 14n })), /returns only 79\.0%/);
  // the pick never returns a failing unverified two-hop silently: its reason is reported
  const cands = [c], p = E.elyPick(cands, [seen({ nativeBack: 5n * 10n ** 15n })], 'buy');
  assert.match(E.elyBuyProblem(p.s, seen(), 10n ** 16n, 2n * 10n ** 14n), /not reviewed/);
  // sells never apply a tier rule
  assert.equal(E.elyPick(cands, [seen({ nativeBack: 5n * 10n ** 15n })], 'sell').s.tierProblem, undefined);
  // VOLTA's hookless HYPE leg with ERA's reviewed coin leg: reviewed
  assert.ok(E.elyCandidates(ERA, eraRoute({ via: { token: VOLTA, poolKey: { currency0: Z, currency1: VOLTA, fee: 10000, tickSpacing: 200, hooks: Z } } })).filter((x) => x.via).every((x) => x.tier === 'reviewed'));
});

test('buy calldata: V4_SWAP[HYPE → token exact in, token → coin OPEN_DELTA with the floor, SETTLE native from msg.value, TAKE coin → wallet]', () => {
  const [c] = E.elyCandidates(ERA, eraRoute()).filter((x) => x.via);
  const amountIn = 12345678901234567n, floor = 777n;
  const { actions, params } = v4Plan(E.elyBuyEnc(c, ERA, amountIn, floor));
  assert.equal(actions, '0x06060b0e');
  const [s1] = decodeAbiParameters(SWAP, params[0]), [s2] = decodeAbiParameters(SWAP, params[1]);
  assert.deepEqual(lowKey(s1.poolKey), lowKey(volta7b18)); assert.equal(s1.zeroForOne, true); assert.equal(s1.amountIn, amountIn); assert.equal(s1.amountOutMinimum, 0n); assert.equal(s1.minHopPriceX36, 0n); assert.equal(s1.hookData, '0x');
  assert.deepEqual(lowKey(s2.poolKey), lowKey(eraLeg)); assert.equal(s2.zeroForOne, true); /* VOLTA = currency0 → ERA */ assert.equal(s2.amountIn, 0n); assert.equal(s2.amountOutMinimum, floor); assert.equal(s2.minHopPriceX36, 0n);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[2]), [Z, amountIn, false]);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[3]).map((x) => (typeof x === 'string' ? x.toLowerCase() : x)), [ERA, '0x0000000000000000000000000000000000000001', 0n]);
  // BLOB is currency0 of its pool: the second swap goes KNTQ (currency1) → BLOB = oneForZero
  const [b] = E.elyCandidates(BLOB, blobRoute()).filter((x) => x.via);
  const bp = v4Plan(E.elyBuyEnc(b, BLOB, amountIn, floor));
  assert.equal(decodeAbiParameters(SWAP, bp.params[1])[0].zeroForOne, false);
  assert.equal(decodeAbiParameters(SWAP, bp.params[0])[0].zeroForOne, true);
  // the last look before the key accepts it, at exactly the buy's value
  const tx = { to: c.router, data: E.elyExecute(E.elyBuyEnc(c, ERA, amountIn, floor), 1n), value: amountIn };
  assert.equal(E.elyTxProblem(tx, ERA, amountIn), '');
  assert.equal(E.elyTxProblem({ ...tx, value: amountIn + 1n }, ERA, amountIn), 'more HYPE than the trade');
});

test('sell calldata: V4_SWAP[coin → token exact in, token → HYPE OPEN_DELTA, SETTLE_ALL coin ≤ amount, TAKE_ALL native ≥ min]', () => {
  const [c] = E.elyCandidates(BLOB, blobRoute()).filter((x) => x.via);
  const amountIn = 5n * 10n ** 21n, min = 4242n;
  const { actions, params } = v4Plan(E.elySellEnc(c, BLOB, amountIn, min));
  assert.equal(actions, '0x06060c0f');
  const [s1] = decodeAbiParameters(SWAP, params[0]), [s2] = decodeAbiParameters(SWAP, params[1]);
  assert.deepEqual(lowKey(s1.poolKey), lowKey(blobLeg)); assert.equal(s1.zeroForOne, true); assert.equal(s1.amountIn, amountIn); assert.equal(s1.amountOutMinimum, 0n);
  assert.deepEqual(lowKey(s2.poolKey), lowKey(kntqD210)); assert.equal(s2.zeroForOne, false); assert.equal(s2.amountIn, 0n); assert.equal(s2.amountOutMinimum, min);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]).map((x) => (typeof x === 'string' ? x.toLowerCase() : x)), [BLOB, amountIn]);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[3]), [Z, min]);
  // the probe's sell template finds both amount words (the swap's amountIn and SETTLE_ALL's maximum)
  const tpl = E.sellTemplate(c, BLOB, 1n);
  assert.equal(tpl.at.length, 2);
  const ex = decodeFunctionData({ abi: EXEC_ABI, data: tpl.data });
  assert.equal(ex.args[0], '0x10');
  assert.equal(E.elyTxProblem({ to: c.router, data: E.elyExecute(E.elySellEnc(c, BLOB, amountIn, min), 1n), value: 0n }, BLOB, 0n), '');
  // the exact approvals go to this router only
  assert.equal(E.elyApprovals({ token: BLOB, router: c.router, amount: amountIn, allowance: 0n, p2Amount: 0n, p2Expiry: 0, now: 1_800_000_000, wall: 1_800_000_000 }).length, 2);
});

test('the probe guard: the coin leg\'s guard wraps the HYPE leg\'s guard (both pins; both legs\' rules on a buy, none on a sell)', () => {
  const [c] = E.elyCandidates(ERA, eraRoute()).filter((x) => x.via);
  for (const side of ['buy', 'sell']) {
    const { check, checkData } = E.elyProbeCheck(c, side);
    assert.equal(check, E.ELY_GUARD);
    const outer = decodeFunctionData({ abi: GUARD_ABI, data: checkData }).args;
    assert.equal(outer[0].toLowerCase(), UR); assert.equal(outer[1], E.elyRouterPin(UR));
    assert.equal(outer[2].toLowerCase(), VOLTA_HOOK); assert.equal(outer[3], VOLTA_HASH);
    assert.equal(outer[4].toLowerCase(), E.ELY_GUARD);
    assert.equal(outer[6].length, side === 'buy' ? c.rules.length : 0);
    const inner = decodeFunctionData({ abi: GUARD_ABI, data: outer[5] }).args;
    assert.equal(inner[0].toLowerCase(), UR); assert.equal(inner[1], E.elyRouterPin(UR));
    assert.equal(inner[2].toLowerCase(), VOLTA_HOOK); assert.equal(inner[3], VOLTA_HASH);
    assert.equal(inner[4].toLowerCase(), PM);
    assert.equal(inner[5], encodeFunctionData({ abi: [{ name: 'extsload', type: 'function', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }], functionName: 'extsload', args: [E.v4StateSlot(lowKey(volta7b18))] }));
    assert.equal(inner[6].length, side === 'buy' ? c.via.rules.length : 0);
    // each leg's rules read its own pool (the Volta hook's poolFees(poolId))
    if (side === 'buy') {
      assert.ok(outer[6].every((r) => r.data.endsWith(E.v4PoolId(lowKey(eraLeg)).slice(2))));
      assert.ok(inner[6].every((r) => r.data.endsWith(E.v4PoolId(lowKey(volta7b18)).slice(2))));
    }
  }
  // a hookless HYPE leg: the inner guard has no hook pin; a hookless coin leg none either
  const [, h] = E.elyCandidates(ERA, eraRoute()).filter((x) => x.via);
  const inner = decodeFunctionData({ abi: GUARD_ABI, data: decodeFunctionData({ abi: GUARD_ABI, data: E.elyProbeCheck(h, 'buy').checkData }).args[5] }).args;
  assert.equal(inner[2], Z); assert.equal(inner[3], '0x' + '0'.repeat(64)); assert.equal(inner[6].length, 0);
  // the probe case carries the guard and both encodings
  const pc = E.probeCase(c, ERA, { buy: 10n ** 16n, roundTrip: true, deadline: 1n });
  assert.equal(pc.check, E.ELY_GUARD); assert.equal(pc.router, UR); assert.equal(pc.sellAt.length, 2);
});

test('the plain-wallet proof runs the two-hop buy, exact approvals and the two-hop sell back', () => {
  const [c] = E.elyCandidates(ERA, eraRoute()).filter((x) => x.via);
  const calls = E.elyEoaCalls({ wallet: '0x00000000000000000000000000000000e1e0f00d', c, token: ERA, amountIn: 10n ** 16n, floor: 1n, sellAmt: 99n, deadline: 1n, now: 1_800_000_000, buyGas: 500_000n, sellGas: E.ELY_SWAP_GAS_CAP, wall: 1_800_000_000 });
  assert.equal(calls.length, 11);
  assert.equal(calls[2].data, E.elyExecute(E.elyBuyEnc(c, ERA, 10n ** 16n, 1n), 1n));
  assert.equal(calls[8].data, E.elyExecute(E.elySellEnc(c, ERA, 99n, 0n), 1n));
  assert.equal(calls[2].to, UR); assert.equal(calls[8].to, UR);
});

test('the path id is the coin leg id and the HYPE leg id, in that order (the lane keys its readings on it)', () => {
  const a = E.elyViaPathId(eraLeg, volta7b18), b = E.elyViaPathId(volta7b18, eraLeg);
  assert.match(a, /^0x[0-9a-f]{64}$/); assert.notEqual(a, b);
  assert.equal(a, E.elyViaPathId({ ...eraLeg, currency1: ERA.toUpperCase().replace('0X', '0x') }, volta7b18));
});
