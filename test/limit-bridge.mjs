// Limit orders on markets NOT quoted in the native coin (2026-10-25, trench docs/drafts/LIMIT-ORDERS.md §19): the pure parts in
// src/limitCore.ts. Robinhood: a Uniswap V4 pool quoted in USDG or a stock, reached from ETH through a Uniswap V3 path in the
// same Universal Router call ('v4bridge'). BNB: a PancakeSwap V2 pair quoted in another token, [WBNB, quote, token] ('v2bridge').
// The keeper's checkPosted rebuilds the bridged calldata from the order and refuses any other byte: forgeries signed by the
// order wallet itself (wrong quote, wrong pool key, wrong recipient, an extra command, a missing V3 leg, the floor on a middle
// leg, another deadline / amount) are each refused. Run: node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from 'viem';
import * as L from '../src/limitCore.ts';
import { encodeV4BuyViaPath, encodeV4SellViaPath, encodeV3Path } from '../src/evmV4Router.ts';

const TOKEN = '0x00000000000000000000000000000000000c0105';
const STOCK = '0x00000000000000000000000000000000005700c4';
const NATIVE = '0x0000000000000000000000000000000000000000';
const WETH = L.WETH_RH, USDG = L.USDG_RH;
const MAIN_KEY = '0x' + '42'.repeat(32);
const ID = '0123456789abcdef0123456789abcdef';
const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
const V3_IN = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }];
const sortKey = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
// a hookless USDG pool with a 1.9 % static fee (VRAX-like, live 2026-10-25) and a stock pool behind the Pons launcher hook
const [u0, u1] = sortKey(TOKEN, USDG);
const USDG_POOL = { currency0: u0, currency1: u1, fee: 19000, tickSpacing: 60, hooks: NATIVE };
const [s0, s1] = sortKey(TOKEN, STOCK);
const STOCK_POOL = { currency0: s0, currency1: s1, fee: 0, tickSpacing: 200, hooks: L.PONS_HOOK };
// the route as GET /api/token/<t>/route serves it (pulse-indexer.mjs, v4 branch)
const usdgRoute = () => ({ type: 'v4', chainId: 4663, poolKey: { ...USDG_POOL }, pair: 'usdg', quoteToken: USDG, quoteSymbol: '', bridgeFee: 100, bridgeHops: [WETH, USDG], bridgeFees: [100] });
const stockRoute = (hops = [WETH, STOCK], fees = [3000]) => ({ type: 'v4', chainId: 4663, poolKey: { ...STOCK_POOL }, pair: 'other', quoteToken: STOCK, quoteSymbol: 'QQQ', bridgeFee: fees[0], bridgeHops: hops, bridgeFees: fees });
const v2Route = (q) => ({ type: 'v2', chainId: 56, router: L.PANCAKE_V2, pool: '0x' + '9'.repeat(40), quoteToken: q, path: [L.WBNB, q, TOKEN], quoteSymbol: 'X', bridgeHops: [], bridgeFees: [] });
const ur = (commands, inputs, deadline) => encodeFunctionData({ abi: L.UR_ABI, functionName: 'execute', args: [commands, inputs, deadline] });
const urArgs = (data) => decodeFunctionData({ abi: L.UR_ABI, data }).args;

/** a bridged order as the vault posts it; `forge(ctx)` may replace the swap's calldata (signed by the order wallet all the same) */
async function bridged({ chain = 'robinhood', route = usdgRoute(), side = 'buy', kind = side === 'buy' ? 'limit' : 'tp', price = '0.000001', amountIn = side === 'buy' ? E(0.05) : 100_000n * 10n ** 18n, now = Date.now(), forge = null, mutate = null } = {}) {
  const P = L.LIMIT_CHAINS[chain];
  const main = privateKeyToAccount(MAIN_KEY);
  const ow = privateKeyToAccount(await L.orderKey(MAIN_KEY, chain, ID));
  const [v] = L.variantsFor(L.cleanRoute(route, chain), TOKEN);
  const expiry = now + 86400_000, deadline = BigInt(Math.floor(expiry / 1000));
  const gasPrice = chain === 'bsc' ? 100_000_000n : 200_000_000n;
  const txs = []; let n = 0;
  if (side === 'sell') for (const c of L.sellApprovals([v], TOKEN, amountIn, deadline)) txs.push({ nonce: n, role: 'approve', venue: c.what, raw: await ow.signTransaction({ to: c.to, data: c.data, value: 0n, nonce: n++, gas: 80_000n, gasPrice, chainId: P.chainId, type: 'legacy' }) });
  const minOut = L.minOutOf({ side, amountIn, price, decimals: 18, taxBps: L.variantTax(v), taxCapBps: L.variantTaxCap(v), slippageBps: 100 });
  const c = L.swapCall(v, { side, token: TOKEN, amountIn, minOut, recipient: main.address, deadline });
  const call = forge ? { ...c, ...forge({ v, c, minOut, main: main.address, deadline, amountIn, side }) } : c;
  txs.push({ nonce: n, role: 'swap', venue: v.venue, raw: await ow.signTransaction({ to: call.to, data: call.data, value: call.value, nonce: n, gas: 900_000n, gasPrice, chainId: P.chainId, type: 'legacy' }) });
  const order = { v: 1, id: ID, chain, wallet: main.address.toLowerCase(), orderWallet: ow.address.toLowerCase(), token: TOKEN, symbol: 'MOCK', decimals: 18, side, kind, price, amount: L.fromUnits(amountIn, 18), amountIn: amountIn.toString(), minOut: { [v.venue]: minOut.toString() }, slippageBps: 100, expiry, createdAt: now, txs, bridge: L.bridgeOf(v) };
  if (mutate) await mutate(order, { ow, main, v });
  const sig = await main.signMessage({ message: L.authText({ action: 'place', chain, wallet: main.address, id: ID, orderWallet: order.orderWallet, digest: L.orderDigest(order), at: now }) });
  return { order, body: { order, auth: { at: now, sig } }, v, minOut, main, ow, deadline, now };
}

test('bridge: the route keeps its bridge; variants, the floor counts both legs\' fees; bad bridges / pools refused', () => {
  const r = L.cleanRoute(usdgRoute());
  assert.deepEqual(r.bridgeHops, [WETH, USDG]); assert.deepEqual(r.bridgeFees, [100]); assert.equal(r.quoteToken, USDG);
  // an ETH pool's empty bridge fields stay out of the route (the engine's verifyRoute memo keys on the exact shape)
  assert.deepEqual(Object.keys(L.cleanRoute({ type: 'v4', poolKey: { currency0: NATIVE, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: L.PONS_HOOK }, pair: 'native', quoteToken: '', bridgeFee: 0, bridgeHops: [], bridgeFees: [] })).sort(), ['pair', 'poolKey', 'type']);
  const [v] = L.variantsFor(r, TOKEN);
  assert.equal(v.venue, 'v4bridge'); assert.equal(v.quote, USDG); assert.deepEqual(v.hops, [WETH, USDG]);
  // 0.01 % V3 tier and a 1.9 % V4 fee, compounded and rounded down: 1 − 0.9999 × 0.981 = 1.90981 % → 190 bps
  assert.equal(v.taxBps, 190); assert.equal(L.feesBps([100, 19000]), 190);
  assert.equal(L.variantTaxCap(v), L.BRIDGE_TAX_CAP_BPS);
  // the floor: 0.05 ETH at 0.000001 ETH / token, 1.9 % fees, 1 % slippage
  assert.equal(L.minOutOf({ side: 'buy', amountIn: E(0.05), price: '0.000001', decimals: 18, taxBps: 190, taxCapBps: L.BRIDGE_TAX_CAP_BPS, slippageBps: 100 }), (50_000n * 10n ** 18n * 9810n * 9900n) / 100_000_000n);
  // a non-bridge venue keeps its 5 % cap whatever cap is asked for
  assert.equal(L.minOutOf({ side: 'buy', amountIn: E(0.05), price: '0.000001', decimals: 18, taxBps: 900, taxCapBps: 4000, slippageBps: 100 }), L.minOutOf({ side: 'buy', amountIn: E(0.05), price: '0.000001', decimals: 18, taxBps: 500, slippageBps: 100 }));
  // a stock pool (Pons hook, fee 0) through a 0.3 % tier; a two-hop bridge through USDG
  assert.equal(L.variantsFor(L.cleanRoute(stockRoute()), TOKEN)[0].taxBps, 30);
  assert.equal(L.variantsFor(L.cleanRoute(stockRoute([WETH, USDG, STOCK], [100, 500])), TOKEN)[0].taxBps, 5);
  // a dynamic-fee pool (Doppler hook): the LP fee the vault read from the PoolManager counts
  const dyn = { ...stockRoute(), poolKey: { ...STOCK_POOL, fee: 0x800000, hooks: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544' } };
  assert.equal(L.variantsFor(L.cleanRoute(dyn), TOKEN, { v4LpFee: 10_000 })[0].taxBps, 129);
  assert.equal(L.variantsFor(L.cleanRoute(dyn), TOKEN)[0].taxBps, 30, 'an unread dynamic fee counts 0 (the floor only rises)');
  assert.equal(L.lpFeeOfSlot0('0x' + (10_000n << 208n).toString(16)), 10_000);
  // refusals
  const no = (route, re) => assert.throws(() => L.variantsFor(L.cleanRoute(route), TOKEN), re);
  no({ ...usdgRoute(), bridgeHops: [], bridgeFees: [], bridgeFee: 0 }, /no way from ETH/);
  no({ ...usdgRoute(), bridgeHops: [USDG, WETH] }, /start from WETH/);
  no(stockRoute([WETH, USDG]), /end at the pool's quote/);
  no(stockRoute([WETH, '0x' + '7'.repeat(40), STOCK], [100, 500]), /unknown asset/);
  no(stockRoute([WETH, STOCK], [3001]), /unknown V3 fee tier/);
  no({ ...stockRoute(), quoteToken: USDG }, /quote asset is not in the pool/);
  no({ ...stockRoute(), poolKey: { ...STOCK_POOL, hooks: '0x992118de23b4ebe9f527dacbbb7d8d4bbbf8e044' } }, /hook/);
  no({ ...usdgRoute(), poolKey: { ...USDG_POOL, fee: 200_000 } }, /fee is above the ceiling/);
  no({ ...usdgRoute(), poolKey: { ...USDG_POOL, currency0: USDG_POOL.currency1, currency1: USDG_POOL.currency0 } }, /not sorted/);
  assert.throws(() => L.cleanRoute({ ...usdgRoute(), bridgeHops: [WETH, USDG, STOCK, TOKEN], bridgeFees: [100, 100, 100] }), /bridge/);
  // BNB: a V2 pair quoted in another token
  const [b] = L.variantsFor(L.cleanRoute(v2Route(STOCK), 'bsc'), TOKEN);
  assert.equal(b.venue, 'v2bridge'); assert.equal(b.quote, STOCK); assert.equal(b.taxBps, 49);
  assert.throws(() => L.variantsFor(L.cleanRoute({ ...v2Route(STOCK), path: [STOCK, L.WBNB, TOKEN] }, 'bsc'), TOKEN), /WBNB → its quote/);
  assert.throws(() => L.variantsFor(L.cleanRoute({ ...v2Route(STOCK), router: '0x' + '1'.repeat(40) }, 'bsc'), TOKEN), /PancakeSwap V2 router/);
});

test('bridge calldata: the frozen engine\'s market shape, the payout TAKEn by the main wallet, the floor on the LAST leg only', () => {
  const rcpt = '0x1111111111111111111111111111111111111111'; const dl = 1_900_000_000n; const amt = E(0.05);
  const [v] = L.variantsFor(L.cleanRoute(stockRoute([WETH, USDG, STOCK], [100, 500])), TOKEN);
  const buy = L.swapCall(v, { side: 'buy', token: TOKEN, amountIn: amt, minOut: 777n, recipient: rcpt, deadline: dl });
  assert.equal(buy.to, L.UR); assert.equal(buy.value, amt);
  const [cmds, ins, d] = urArgs(buy.data);
  assert.equal(cmds, '0x0b0010'); assert.equal(d, dl);
  // WRAP_ETH and the V3 leg are byte for byte the engine's market buy (encodeV4BuyViaPath): only the V4 payout differs
  const path = encodeV3Path([WETH, USDG, STOCK], [100, 500]);
  const market = encodeV4BuyViaPath(STOCK_POOL, TOKEN, STOCK, path, amt, 777n);
  assert.equal(ins[0], market.inputs[0]); assert.equal(ins[1], market.inputs[1]);
  assert.deepEqual(decodeAbiParameters(V3_IN, ins[1]), [ADDRESS_THIS, amt, 0n, path, false], 'V3 leg: no floor of its own');
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ins[2]);
  assert.equal(actions, '0x0b060e', 'SETTLE, SWAP_EXACT_IN_SINGLE, TAKE (not TAKE_ALL)');
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[0]), [STOCK, CONTRACT_BALANCE, false]);
  const sw = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], params[1])[0];
  assert.equal(sw.amountOutMinimum, 777n, 'the floor sits on the V4 leg'); assert.equal(sw.amountIn, 0n); assert.equal(sw.zeroForOne, STOCK_POOL.currency0 === STOCK);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2]).map(String).map((x) => x.toLowerCase()), [TOKEN, rcpt, '0']);
  // the sell: V4 → quote to the router (no floor), V3 back to WETH with the floor, unwrap to the main wallet with the floor
  const sell = L.swapCall(v, { side: 'sell', token: TOKEN, amountIn: 10n ** 21n, minOut: 555n, recipient: rcpt, deadline: dl });
  assert.equal(sell.value, 0n);
  const [c2, i2] = urArgs(sell.data);
  assert.equal(c2, '0x10000c');
  const rev = encodeV3Path([STOCK, USDG, WETH], [500, 100]);
  const mk = encodeV4SellViaPath(STOCK_POOL, TOKEN, STOCK, rev, 10n ** 21n, 0n, 555n, rcpt);
  assert.deepEqual(i2, mk.inputs, 'the engine\'s market sell with its middle floor at 0 and the payout to the recipient');
  assert.deepEqual(decodeAbiParameters(V3_IN, i2[1]), [ADDRESS_THIS, CONTRACT_BALANCE, 555n, rev, false]);
  // BNB: one V2 swap over [WBNB, quote, token], to the main wallet
  const [b] = L.variantsFor(L.cleanRoute(v2Route(STOCK), 'bsc'), TOKEN);
  const bb = L.swapCall(b, { side: 'buy', token: TOKEN, amountIn: amt, minOut: 9n, recipient: rcpt, deadline: dl });
  const low = (args) => args.map((x) => (Array.isArray(x) ? x.map((a) => a.toLowerCase()) : typeof x === 'string' ? x.toLowerCase() : x));
  assert.deepEqual(low(decodeFunctionData({ abi: L.PANCAKE_V2_ABI, data: bb.data }).args), [9n, [L.WBNB, STOCK, TOKEN], rcpt, dl]);
  const bs = L.swapCall(b, { side: 'sell', token: TOKEN, amountIn: 5n, minOut: 9n, recipient: rcpt, deadline: dl });
  assert.deepEqual(low(decodeFunctionData({ abi: L.PANCAKE_V2_ABI, data: bs.data }).args), [5n, 9n, [TOKEN, STOCK, L.WBNB], rcpt, dl]);
  // a bridged sell's approvals are the venue's own (token → Permit2 → router; token → V2 router)
  assert.deepEqual(L.sellApprovals([v], TOKEN, 5n, dl).map((x) => x.what), ['approve-permit2', 'approve-router']);
  assert.deepEqual(L.sellApprovals([b], TOKEN, 5n, dl).map((x) => x.what), ['approve-v2']);
});

test('bridge keeper check: the vault\'s bridged orders pass; the digest covers the bridge', async () => {
  for (const [route, side] of [[usdgRoute(), 'buy'], [usdgRoute(), 'sell'], [stockRoute(), 'buy'], [stockRoute([WETH, USDG, STOCK], [100, 500]), 'sell']]) {
    const b = await bridged({ route, side });
    const r = await L.checkPosted(b.order, b.now);
    assert.equal(r.order.bridge.quote, side && route.quoteToken); assert.equal(r.swapNonce, side === 'sell' ? 2 : 0);
    assert.equal(L.orderDigest(r.order), L.orderDigest(b.order), 'the server computes the digest the main wallet signed');
  }
  const bsc = await bridged({ chain: 'bsc', route: v2Route(STOCK), amountIn: E(0.01) });
  assert.equal((await L.checkPosted(bsc.order, bsc.now, 'bsc')).order.bridge.quote, STOCK);
  const bscSell = await bridged({ chain: 'bsc', route: v2Route(STOCK), side: 'sell' });
  assert.equal((await L.checkPosted(bscSell.order, bscSell.now, 'bsc')).swapNonce, 1);
  // the bridge is in the digest: another quote, another digest (a signed place text cannot be reused for it)
  const d0 = L.orderDigest(bsc.order); const o2 = { ...bsc.order, bridge: { ...bsc.order.bridge, quote: USDG } };
  assert.notEqual(L.orderDigest(o2), d0);
  // and an order without a bridge digests as it always did (no key added)
  const plain = { ...bsc.order }; delete plain.bridge; assert.equal(L.orderDigest({ ...plain, bridge: undefined }), L.orderDigest(plain));
});

test('bridge keeper check: forgeries signed by the order wallet are refused — wrong quote, pool key, recipient, extra command, missing V3 leg, floor on a middle leg', async () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const refused = async (opts, re = /not the one this order describes/) => { const b = await bridged(opts); await assert.rejects(L.checkPosted(b.order, b.now, opts.chain || 'robinhood'), re); };
  const callWith = (patch) => ({ v, minOut, main, deadline, amountIn, side }) => ({ data: L.bridgeCalldata({ side, poolKey: v.poolKey, quote: v.quote, hops: v.hops, fees: v.fees, token: TOKEN, amountIn, minOut, recipient: main, deadline, ...patch }) });
  for (const side of ['buy', 'sell']) {
    // wrong quote: the V3 path ends at another asset (the posted bridge still says USDG)
    await refused({ side, forge: callWith({ hops: [WETH, STOCK], quote: STOCK }) });
    // wrong quote in the posted bridge itself (the calldata would then be rebuilt for another path)
    await refused({ side, mutate: (o) => { o.bridge = { ...o.bridge, quote: STOCK, hops: [WETH, STOCK] }; } }, /pool is not the coin's pool|not the one/);
    // wrong pool key: another fee / tick spacing / hook in the calldata
    await refused({ side, forge: callWith({ poolKey: { ...USDG_POOL, fee: 3000 } }) });
    await refused({ side, forge: callWith({ poolKey: { ...USDG_POOL, hooks: L.PONS_HOOK } }) });
    // wrong pool key in the posted bridge: a hook limit orders do not trade through
    await refused({ side, mutate: (o) => { o.bridge = { ...o.bridge, poolKey: { ...o.bridge.poolKey, hooks: '0x992118de23b4ebe9f527dacbbb7d8d4bbbf8e044' } }; } }, /hook/);
    // wrong recipient
    await refused({ side, forge: callWith({ recipient: OTHER }) });
    // another deadline, another amount, another floor than the order's minOut
    await refused({ side, forge: callWith({ deadline: 2_000_000_000n }) });
    await refused({ side, forge: ({ v, minOut, main, deadline, amountIn }) => ({ data: L.bridgeCalldata({ side, poolKey: v.poolKey, quote: v.quote, hops: v.hops, fees: v.fees, token: TOKEN, amountIn: amountIn - 1n, minOut, recipient: main, deadline }) }) });
    await refused({ side, forge: ({ v, minOut, main, deadline, amountIn }) => ({ data: L.bridgeCalldata({ side, poolKey: v.poolKey, quote: v.quote, hops: v.hops, fees: v.fees, token: TOKEN, amountIn, minOut: minOut / 2n, recipient: main, deadline }) }) });
    // an extra command (a SWEEP of the coin to another address after the swap)
    await refused({ side, forge: ({ c }) => { const [cmds, ins, d] = urArgs(c.data); return { data: ur(cmds + '04', [...ins, encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [TOKEN, OTHER, 0n])], d) }; } });
    // a missing V3 leg (the V4 leg alone, settled from a balance the router does not hold)
    await refused({ side, forge: ({ c }) => { const [cmds, ins, d] = urArgs(c.data); const keep = side === 'buy' ? [0, 2] : [0, 2]; return { data: ur('0x' + keep.map((i) => cmds.slice(2 + 2 * i, 4 + 2 * i)).join(''), keep.map((i) => ins[i]), d) }; } });
  }
  // the floor on a middle leg — buy: the V3 leg holds it, the V4 leg (the payout) has none
  await refused({ side: 'buy', forge: ({ v, minOut, main, deadline, amountIn }) => {
    const [cmds, ins, d] = urArgs(L.bridgeCalldata({ side: 'buy', poolKey: v.poolKey, quote: v.quote, hops: v.hops, fees: v.fees, token: TOKEN, amountIn, minOut: 0n, recipient: main, deadline }));
    return { data: ur(cmds, [ins[0], encodeAbiParameters(V3_IN, [ADDRESS_THIS, amountIn, minOut, encodeV3Path(v.hops, v.fees), false]), ins[2]], d) };
  } });
  // — sell: the V4 leg holds it, the V3 leg and the unwrap (the payout) have none (the engine's own encoder, minBridge = floor)
  await refused({ side: 'sell', forge: ({ v, minOut, main, amountIn, deadline }) => { const e = encodeV4SellViaPath(v.poolKey, TOKEN, v.quote, encodeV3Path([...v.hops].reverse(), [...v.fees].reverse()), amountIn, minOut, 0n, main); return { data: ur(e.commands, e.inputs, deadline) }; } });
  // the engine's market buy (TAKE_ALL: the coin would stay in the order wallet, never reach the main wallet)
  await refused({ side: 'buy', forge: ({ v, minOut, amountIn, deadline }) => { const e = encodeV4BuyViaPath(v.poolKey, TOKEN, v.quote, encodeV3Path(v.hops, v.fees), amountIn, minOut); return { data: ur(e.commands, e.inputs, deadline) }; } });
  // another router
  await refused({ forge: () => ({ to: '0x' + '3'.repeat(40) }) });
  // shape: no bridge, a bridge without its variant, a second variant beside the bridged one, junk in the bridge
  await refused({ mutate: (o) => { delete o.bridge; } }, /bad bridge/);
  await refused({ mutate: (o) => { o.bridge.extra = 1; } }, /unknown field/);
  await refused({ mutate: (o) => { o.bridge.fees = [3001]; } }, /fee tier/);
  await refused({ mutate: (o) => { o.bridge.hops = [WETH, '0x' + '7'.repeat(40), USDG]; o.bridge.fees = [100, 100]; } }, /unknown asset/);
  await refused({ mutate: async (o, { ow }) => { o.minOut.v4 = '1'; o.txs.push({ nonce: 0, role: 'swap', venue: 'v4', raw: await ow.signTransaction({ to: L.UR, value: BigInt(o.amountIn), nonce: 0, gas: 1n, gasPrice: 1n, chainId: 4663, type: 'legacy' }) }); } }, /one swap variant/);
  {
    const b = await bridged(); const o = { ...b.order, bridge: undefined }; delete o.bridge;
    o.txs = o.txs.map((t) => ({ ...t, venue: 'v4' })); o.minOut = { v4: o.minOut.v4bridge };
    const plain = await L.checkPosted({ ...o, bridge: { quote: USDG, hops: [WETH, USDG], fees: [100], poolKey: USDG_POOL } }, b.now).catch((e) => e);
    assert.match(String(plain.message), /bridge without its variant/);
  }
  // a bridged sell whose approvals are not the venue's (the V2 one on Robinhood)
  await refused({ side: 'sell', mutate: (o) => { o.txs[0].venue = 'approve-curve'; } }, /bad approval/);
  // BNB: the V2 path — wrong quote, wrong recipient, a 2-hop path under the bridged venue, an extra hop
  const bsc = (forge, mutate, re) => refused({ chain: 'bsc', route: v2Route(STOCK), amountIn: E(0.01), forge, mutate }, re);
  const v2 = (args) => ({ data: encodeFunctionData({ abi: L.PANCAKE_V2_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args }) });
  await bsc(({ minOut, main, deadline }) => v2([minOut, [L.WBNB, USDG, TOKEN], main, deadline]));
  await bsc(({ minOut, deadline }) => v2([minOut, [L.WBNB, STOCK, TOKEN], OTHER, deadline]));
  await bsc(({ minOut, main, deadline }) => v2([minOut, [L.WBNB, TOKEN], main, deadline]));
  await bsc(({ minOut, main, deadline }) => v2([minOut, [L.WBNB, STOCK, USDG, TOKEN], main, deadline]));
  await bsc(({ main, deadline }) => v2([1n, [L.WBNB, STOCK, TOKEN], main, deadline]));
  await bsc(null, (o) => { o.bridge = { quote: USDG, hops: [L.WBNB, USDG], fees: [] }; });
  await bsc(null, (o) => { o.bridge = { ...o.bridge, poolKey: USDG_POOL }; }, /no pool key/);
});
