// The EVM buy from the reserve, pure parts (src/usdBuyEvm.ts) and the background allowances (src/floatEngine.ts). The REAL
// contracts: test/usd-buy-evm-fork.mjs.
//   node --experimental-strip-types --test test/usd-buy-evm.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// FLOAT_DIRECT_DIR = a local checkout of the float-direct contracts (the checks that need it are skipped without it)
const FD = process.env.FLOAT_DIRECT_DIR || '../float-direct';
import { decodeFunctionData, parseAbi, encodeAbiParameters } from 'viem';
import * as E from '../src/usdBuyEvm.ts';
import * as F from '../src/floatCore.ts';
import { createFloat } from '../src/floatEngine.ts';
import { UNIVERSAL_ROUTER, PERMIT2 } from '../src/evmV4Router.ts';

const RH = F.FLOAT_CFG.robinhood, BSC = F.FLOAT_CFG.bsc;
const lc = (a) => a.toLowerCase();
const W = '0x00000000000000000000000000000000000000a1', COIN = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const WETH = lc(RH.wrapped), USDG = lc(RH.stable.address), WBNB = lc(BSC.wrapped);
const base = { chain: 'robinhood', coin: COIN, amountIn: 5_000_000n, recipient: W, deadline: 99n };
const ROUTER = parseAbi(['function multicall(uint256 deadline, bytes[] data)', 'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum))',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))', 'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to)']);
const inner = (data) => decodeFunctionData({ abi: ROUTER, data }).args[1].map((d) => decodeFunctionData({ abi: ROUTER, data: d }));

test('V3: stable → coin, stable → WETH → coin, through bridge hops; always the float\'s own router, W the recipient', () => {
  const viaWeth = E.evmDirectPlan({ ...base, route: { type: 'v3', fee: 3000, quoteToken: WETH } });
  assert.equal(viaWeth.to, lc(RH.router)); assert.equal(viaWeth.spender, lc(RH.router)); assert.deepEqual(viaWeth.hops, [USDG, WETH, lc(COIN)]);
  const [x] = inner(viaWeth.build(777n));
  assert.equal(x.functionName, 'exactInput'); assert.equal(lc(x.args[0].recipient), W); assert.equal(x.args[0].amountIn, 5_000_000n); assert.equal(x.args[0].amountOutMinimum, 777n);
  assert.equal(x.args[0].path, `${USDG}${'000064'}${WETH.slice(2)}${'000bb8'}${lc(COIN).slice(2)}`);
  assert.deepEqual(E.evmDirectPlan({ ...base, route: { type: 'v3', fee: 10000, quoteToken: USDG, bridgeHops: [WETH, USDG], bridgeFees: [100] } }).hops, [USDG, lc(COIN)]);
  const stock = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(E.evmDirectPlan({ ...base, route: { type: 'v3', fee: 500, quoteToken: stock, bridgeHops: [WETH, USDG, stock], bridgeFees: [100, 500] } }).hops, [USDG, stock, lc(COIN)], 'starts where the stable sits on the bridge');
  assert.deepEqual(E.evmDirectPlan({ ...base, route: { type: 'v3', fee: 500, quoteToken: stock, bridgeHops: [WETH, stock], bridgeFees: [3000] } }).hops, [USDG, WETH, stock, lc(COIN)]);
  for (const route of [{ type: 'v3', fee: 1234, quoteToken: WETH }, { type: 'v3', fee: 500, quoteToken: stock, bridgeHops: [stock], bridgeFees: [] }, { type: 'v3', fee: 500, quoteToken: stock }])
    assert.throws(() => E.evmDirectPlan({ ...base, route }), E.DirectUnsupported, JSON.stringify(route));
});

test('V2 on BNB: the stable → WBNB leg kept in the router, then the pair along the indexer\'s path to W; only PancakeSwap V2', () => {
  const p = E.evmDirectPlan({ ...base, chain: 'bsc', amountIn: 5n * 10n ** 18n, route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', path: [WBNB, lc(COIN)] } });
  assert.equal(p.to, lc(BSC.router));
  const [a, b] = inner(p.build(5n));
  assert.equal(a.functionName, 'exactInputSingle'); assert.equal(lc(a.args[0].recipient), E.ADDRESS_THIS); assert.equal(a.args[0].amountOutMinimum, 0n); assert.equal(lc(a.args[0].tokenIn), lc(BSC.stable.address));
  assert.equal(b.functionName, 'swapExactTokensForTokens'); assert.equal(b.args[0], 0n, 'the router\'s own balance'); assert.equal(b.args[1], 5n); assert.equal(lc(b.args[3]), W);
  assert.throws(() => E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'v2', router: '0x0000000000000000000000000000000000000bad', path: [WBNB, lc(COIN)] } }), E.DirectUnsupported, 'an unknown V2 router');
  assert.throws(() => E.evmDirectPlan({ ...base, route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', path: [WETH, lc(COIN)] } }), E.DirectUnsupported, 'no V2 on Robinhood');
  assert.throws(() => E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', path: [WBNB, '0x2222222222222222222222222222222222222222'] } }), E.DirectUnsupported, 'a path that ends elsewhere');
});

test('V4 on Robinhood: the Universal Router through Permit2, only hookless or the known launcher hook; curves and Infinity are not yet', () => {
  const key = (hooks) => ({ currency0: '0x0000000000000000000000000000000000000000', currency1: lc(COIN), fee: 0, tickSpacing: 200, hooks });
  const p = E.evmDirectPlan({ ...base, route: { type: 'v4', pair: 'native', poolKey: key('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044') } });
  assert.equal(p.to, lc(UNIVERSAL_ROUTER)); assert.equal(p.spender, lc(PERMIT2)); assert.deepEqual(p.permit2, { token: USDG, spender: lc(UNIVERSAL_ROUTER) });
  assert.ok(p.build(1n).startsWith('0x3593564c'), 'execute(bytes,bytes[],uint256)');
  assert.throws(() => E.evmDirectPlan({ ...base, route: { type: 'v4', pair: 'native', poolKey: key('0x000000000000000000000000000000000000dead') } }), E.DirectUnsupported, 'an unknown hook');
  assert.throws(() => E.evmDirectPlan({ ...base, route: { type: 'v4', pair: 'other', poolKey: key('0x0000000000000000000000000000000000000000') } }), E.DirectUnsupported);
  for (const route of [{ type: 'inf' }, { type: 'standard' }, { type: 'four' }, { type: 'flap' }, { type: 'pons', pairToken: USDG }]) assert.throws(() => E.evmDirectPlan({ ...base, route }), /not available for this market yet/, route.type);
});

test('the guard: exactly the amount from R, the coin to W, no native moved, nothing left in the router', () => {
  const ok = { allowance: 10n ** 30n, stableSpent: 5n, coinGot: 100n, rNativeBefore: 1n, rNativeAfter: 1n, wNativeBefore: 0n, wNativeAfter: 0n,
    routerStableBefore: 3n, routerStableAfter: 3n, routerWrappedBefore: 0n, routerWrappedAfter: 0n, routerCoinBefore: 0n, routerCoinAfter: 0n, decimals: 18, called: true,
    ret: encodeAbiParameters([{ type: 'bytes[]' }], [[encodeAbiParameters([{ type: 'uint256' }], [100n])]]) };
  assert.equal(E.evmDirectGuard(ok, 5n), '');
  assert.equal(E.evmDirectGuard({ ...ok, allowance: 4n, called: false }, 5n), 'allowance');
  assert.match(E.evmDirectGuard({ ...ok, stableSpent: 6n }, 5n), /another amount/);
  assert.match(E.evmDirectGuard({ ...ok, stableSpent: (1n << 256n) - 1n }, 5n), /another amount/, 'a refund is not a buy');
  assert.match(E.evmDirectGuard({ ...ok, coinGot: 0n }, 5n), /not deliver/);
  assert.match(E.evmDirectGuard({ ...ok, rNativeAfter: 0n }, 5n), /reserve's native/);
  assert.match(E.evmDirectGuard({ ...ok, wNativeBefore: 2n, wNativeAfter: 1n }, 5n), /trading wallet's native/);
  assert.equal(E.evmDirectGuard({ ...ok, wNativeAfter: 1n }, 5n), '', "a curve's refund to W is fine");
  assert.match(E.evmDirectGuard({ ...ok, routerStableAfter: 4n }, 5n), /leave funds in the router/);
  assert.match(E.evmDirectGuard({ ...ok, routerWrappedAfter: 1n }, 5n), /leave funds in the router/);
  assert.match(E.evmDirectGuard({ ...ok, routerCoinAfter: 1n }, 5n), /leave funds in the router/);
});

test('curves through UsdBuyRouter: four.meme / Flap with BNB, the Pons family with native; W written into the call; the router checked once by code hash and allow-list', () => {
  const FOUR = '0x5c952063c7fc8610ffdb798152d69f0b9550762b', FLAPP = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', Z = '0x0000000000000000000000000000000000000000';
  const ABI = parseAbi(['function buy((address token,address recipient,uint256 stableIn,uint256 minNative,address venue,bytes venueData,uint256 minTokens,uint256 deadline))']);
  const four = E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'four', manager: FOUR, quoteToken: Z }, minNative: 7n });
  assert.equal(four.kind, 'curve'); assert.equal(four.to, E.CURVE_ROUTER.bsc.address); assert.equal(four.spender, E.CURVE_ROUTER.bsc.address);
  assert.deepEqual(four.router.spec, [68, 36, 4, 0, false]); assert.equal(four.router.codeHash, E.CURVE_ROUTER.bsc.codeHash);
  const b = decodeFunctionData({ abi: ABI, data: four.build(9n) }).args[0];
  assert.equal(lc(b.recipient), W); assert.equal(b.minTokens, 9n); assert.equal(b.minNative, 7n); assert.equal(lc(b.venue), FOUR); assert.equal(b.venueData.slice(0, 10), '0x7f79f6df');
  assert.equal(E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'flap', portal: FLAPP, quoteToken: Z } }).router.selector, '0xef7ec2e7');
  assert.equal(E.evmDirectPlan({ ...base, route: { type: 'pons', pairToken: Z } }).router.venue, E.CURVE_ROUTER.robinhood.pons);
  assert.throws(() => E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'flap', portal: FLAPP, quoteToken: Z, nativeToQuote: true } }), E.DirectUnsupported, 'a Flap coin quoted in another token');
  assert.throws(() => E.evmDirectPlan({ ...base, chain: 'bsc', route: { type: 'four', manager: '0x0000000000000000000000000000000000000bad', quoteToken: Z } }), E.DirectUnsupported, 'another manager');
  assert.throws(() => E.evmDirectPlan({ ...base, route: { type: 'four', manager: FOUR, quoteToken: Z } }), E.DirectUnsupported, 'no four.meme on Robinhood');
  // the deploy config the contract is deployed with = the vault's copy (offsets and venues)
  const deployCfg = FD + '/contracts/deploy/venues.mjs';
  if (existsSync(deployCfg)) {
    const src = readFileSync(deployCfg, 'utf8');
    assert.match(src, /four = \(manager\) => \(\{ venue: manager, selector: SEL\.fourBuy, amountOffset: 68, recipientOffset: 36, tokenOffset: 4, nativeOffset: 0, ponsFactory: false \}\)/);
    assert.match(src, /flap = \(portal\) => \(\{ venue: portal, selector: SEL\.flapSwap, amountOffset: 100, recipientOffset: 0, tokenOffset: 68, nativeOffset: 36, ponsFactory: false \}\)/);
    assert.match(src, /pons = \(factory\) => \(\{ venue: factory, selector: SEL\.ponsBuy, amountOffset: 4, recipientOffset: 68, tokenOffset: 0, nativeOffset: 0, ponsFactory: true \}\)/);
    for (const a of [E.CURVE_ROUTER.bsc.four, E.CURVE_ROUTER.bsc.flap, E.CURVE_ROUTER.bsc.pons, E.CURVE_ROUTER.robinhood.pons]) assert.ok(src.includes(a), a);
  }
});

test('the price guard reads the EXPECTED out (a 30 % slippage setting never trips it); the floor is the quote less the slippage', () => {
  // $5 at $0.10 a coin (18 decimals) = 50 coins fair
  const fair = 50n * 10n ** 18n;
  assert.equal(E.evmPriceCheck({ usdIn: 5, expectedOut: fair * 95n / 100n, decimals: 18, priceUsd: 0.1 }), '');
  const minOut = E.minOutOf(fair * 95n / 100n, 30);
  assert.equal(minOut, fair * 95n / 100n * 7000n / 10000n, 'the floor follows the user');
  assert.equal(E.evmPriceCheck({ usdIn: 5, expectedOut: fair * 95n / 100n, decimals: 18, priceUsd: 0.1 }), '', 'the expected out passes even though the floor is 66.5 % of fair');
  assert.match(E.evmPriceCheck({ usdIn: 5, expectedOut: fair * 60n / 100n, decimals: 18, priceUsd: 0.1 }), /far less/);
  assert.equal(E.evmPriceCheck({ usdIn: 5, expectedOut: 1n, decimals: 18, priceUsd: null }), '');
  assert.equal(E.minOutOf(1000n, 12), 880n); assert.equal(E.minOutOf(1n, 50), 1n);
});

test('the probe the vault embeds is the one compiled from contracts/UsdBuyProbe.sol (when the toolchain is here)', { skip: !existsSync(FD + '/contracts/artifacts/UsdBuyProbe.json') }, () => {
  const a = JSON.parse(readFileSync(FD + '/contracts/artifacts/UsdBuyProbe.json', 'utf8'));
  assert.equal(E.PROBE_RUNTIME, a.deployedBytecode);
});

// ── the background allowances ──
function world({ chain = 'robinhood', active = true, allowance = {}, permit2 = { amount: 0n, expiration: 0 } } = {}) {
  const cfg = F.FLOAT_CFG[chain]; const R = '0x00000000000000000000000000000000000000b2';
  const sent = []; const store = new Map(); let now = 1_800_000_000_000;
  const w = { id: 'w1', name: 'W', w: { evm: W, sol: '' }, r: { evm: R, sol: '' } };
  const P2 = parseAbi(['function allowance(address,address,address) view returns (uint160,uint48,uint48)']);
  const f = createFloat({
    chain: () => chain, wallet: () => w, wallets: () => ({ list: [w], skipped: [] }),
    evm: {
      call: async (tx) => (lc(tx.to) === lc(PERMIT2) ? encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [permit2.amount, permit2.expiration, 0]) : '0x'),
      balance: async () => 10n ** 17n, erc20: async (t, o) => (lc(o) === lc(R) ? 100n * 10n ** BigInt(cfg.stable.decimals) : 0n),
      allowance: async (t, o, sp) => allowance[lc(sp)] ?? 0n, slot0: async () => 0n,
      fees: async () => ({ baseFee: 1n, gasPrice: 1n, l1PerByte: 0n }), estimate: async () => 60_000n,
      sendR: async (id, tx) => { sent.push(tx); return '0x' + String(sent.length).padStart(64, '0'); }, sendW: async () => { throw new Error('no'); }, receipt: async () => ({ status: 'success' }),
    },
    ask: async () => true, gate: async () => {}, html: { esc: String, sub: (h) => h, muted: (h) => h }, now: () => now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {}, fetch: async () => { throw new Error('no'); },
    click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }), wait: async (ms) => { now += ms; },
  });
  const snap = (over = {}) => store.set(`trenches.float.v1.snap.${chain}.${lc(W)}`, JSON.stringify({ at: now, chain, price6: '3000000000', priceAt: now, float: String(10n ** 18n), reserve: String(100n * 10n ** BigInt(cfg.stable.decimals)), reserveNative: String(cfg.reserveGas), inFlight6: '0', inFlightReserve6: '0', active, presets6: [], buys6: [], ...over }));
  return { f, sent, store, snap, advance: (ms) => { now += ms; }, cfg };
}
const settle = async () => { for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r)); };
const APPROVE = parseAbi(['function approve(address,uint256)']);

test('background: R approves the float\'s router, then Permit2, then Permit2 for the Universal Router — one per tick, only on a chain in use', async () => {
  const x = world();
  await x.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  for (const k of [...x.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) x.store.delete(k);
  x.snap();
  // a page of this chain open (reason 'lane'): the chain is in use
  await x.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'lane' }); await settle();
  assert.equal(x.sent.length, 1);
  assert.equal(lc(x.sent[0].to), lc(RH.stable.address));
  const d = decodeFunctionData({ abi: APPROVE, data: x.sent[0].data }); assert.equal(lc(d.args[0]), lc(RH.router)); assert.equal(d.args[1], (1n << 256n) - 1n);
  // the next tick right away: the first approval is still landing (no second ask for 2 min)
  await x.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await settle();
  assert.equal(x.sent.length, 1);
  // a chain not in use (no page or trade in 7 days): nothing
  const y = world({ active: false }); await y.f.configure({ walletId: 'w1', chains: ['robinhood'] }); for (const k of [...y.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) y.store.delete(k);
  y.snap({ active: false }); await y.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await settle();
  assert.equal(y.sent.length, 0);
  // the router already approved: Permit2 next; both: Permit2's allowance for the Universal Router (≈ 1 year)
  const z = world({ allowance: { [lc(RH.router)]: 1n << 255n } }); await z.f.configure({ walletId: 'w1', chains: ['robinhood'] }); for (const k of [...z.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) z.store.delete(k);
  z.snap(); await z.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'lane' }); await settle();
  assert.equal(lc(decodeFunctionData({ abi: APPROVE, data: z.sent[0].data }).args[0]), lc(PERMIT2));
  const v = world({ allowance: { [lc(RH.router)]: 1n << 255n, [lc(PERMIT2)]: 1n << 255n } }); await v.f.configure({ walletId: 'w1', chains: ['robinhood'] }); for (const k of [...v.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) v.store.delete(k);
  v.snap(); await v.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'lane' }); await settle();
  assert.equal(lc(v.sent[0].to), lc(PERMIT2));
  const p2 = decodeFunctionData({ abi: E.PERMIT2_APPROVE_ABI, data: v.sent[0].data });
  assert.deepEqual([lc(p2.args[0]), lc(p2.args[1])], [lc(RH.stable.address), lc(UNIVERSAL_ROUTER)]);
  // all set on BNB (only the router there): nothing more
  const b = world({ chain: 'bsc', allowance: { [lc(BSC.router)]: 1n << 255n } }); await b.f.configure({ walletId: 'w1', chains: ['bsc'] }); for (const k of [...b.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) b.store.delete(k);
  b.snap(); await b.f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'lane' }); await settle();
  assert.equal(b.sent.length, 0);
});

test('the curve router: the pinned code hashes are the audited runtime with the owner\'s RESCUE; the per-buy cap is $100 (vault-side)', { skip: !existsSync(FD + '/contracts/deploy/expected-hash.mjs') }, async () => {
  const { expectedHashes } = await import(pathToFileURL(FD + '/contracts/deploy/expected-hash.mjs').href);
  const { RESCUE } = await import(pathToFileURL(FD + '/contracts/deploy/venues.mjs').href);
  assert.equal(RESCUE, E.CURVE_RESCUE);
  const h = await expectedHashes();
  assert.equal(E.CURVE_ROUTER.bsc.codeHash, h.bsc); assert.equal(E.CURVE_ROUTER.robinhood.codeHash, h.robinhood);
  assert.equal(E.CURVE_BUY_MAX_USD, 100);
  const we = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(we, /if \(plan\.kind === 'curve' && a\.usd > CURVE_BUY_MAX_USD\) throw new Error\(`A buy straight from the USD balance is not available above/);
});
