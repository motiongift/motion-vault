// Release 6 (owner, 2026-11-04: «поключи ансаппортед чтобы тоже можно было ими всеми торговать … делай нормально»; B:\tmp\elysium-hooks):
// the launchpads' routers (pinned by code), the 9 reviewed hooks (pinned by code) with their buy-time rules, ELY_GUARD, and the
// 6-field SWAP_EXACT_IN_SINGLE of Elysium's Universal Routers. Pure: no network (the guard on a real EVM: D:\tmp\agent-tmp\rel6\hooks\
// guard-live.mjs; the 25-coin flow on the live routers: hooks\fullflow-rel6.mjs).
//   node --experimental-strip-types --test test/elysium-hooks-r6.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters, toFunctionSelector } from 'viem';
import * as E from '../src/elysiumCore.ts';
import { UNIVERSAL_ROUTER_ABI, encodeV4Sell } from '../src/evmV4Router.ts';

const ZERO = E.ELY_ZERO;
const SENDU = '0x392ea0144a622773eaee0fa59141f058ad39eef3', KLEOS_HOOK = '0xd5068e7f4e2d70d5efbac6fd28a8407252e1eacc';
const SENDU_KEY = { currency0: ZERO, currency1: SENDU, fee: 0, tickSpacing: 200, hooks: KLEOS_HOOK };
const AGORA = '0x5e5d56ba8b3e7bc3f9b4ebf2b71e2a3a1f9e1fb4', KLEOS_HOOK2 = '0x0c835e6a51717a514144d95c7f0a1c640179e0cc';
const VOLTA = '0x1111111111111111111111111111111111111111', FLAUNCH = '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc';
const route = (venue, pk) => ({ type: 'ely', chainId: 99901, venue, pair: 'native', poolKey: pk });
const key = (coin, hooks, fee = 0) => ({ currency0: ZERO, currency1: coin, fee, tickSpacing: 200, hooks });
const GUARD_IN = [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }, { type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'op', type: 'uint8' }, { name: 'i', type: 'uint16' }, { name: 'j', type: 'uint16' }, { name: 'k', type: 'uint16' }, { name: 'value', type: 'uint256' }] }];
const guardArgs = (d) => decodeAbiParameters(GUARD_IN, '0x' + d.slice(10));

test('the four launchpad routers: venues, fixed CREATE2 addresses, code pins (and the two of today, read on chain)', () => {
  const want = {
    'kl-v4': ['v4', '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', '0xa226f04cececc3b1ee0ac6f18132db96987cea37'],
    'kl-v3': ['v3', '0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1', '0xa226f04cececc3b1ee0ac6f18132db96987cea37'],
    'bx-v4': ['v4', '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', '0xeff2423d2b7fb97cbc41994b01c7a8177990394f'],
    'bx-v3': ['v3', '0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3', '0xeff2423d2b7fb97cbc41994b01c7a8177990394f'],
    'el-v4': ['v4', '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', '0x93a5d9271ac5dbe68a2b96ef7a23576eaad15a11'],
    'rp-v3': ['v3', '0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f', '0x90d63fd4ab5bc0b9815cda273cfd5b918afb9168'],
  };
  for (const [v, [kind, at, router]] of Object.entries(want)) {
    const x = E.ELY_VENUES[v]; assert.equal(x.kind, kind, v); assert.equal(kind === 'v4' ? x.manager : x.factory, at, v); assert.equal(x.router, router, v);
  }
  assert.equal(E.ELY_ROUTER_PINS['0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a'], '0xa3b1ff66d689e45ddfb2f0ba861e5e681a476be3ced9c7376f1952c478dc9f53');
  assert.equal(E.ELY_ROUTER_PINS['0x751cefb96ac88db5327d39e0fbdd5d882d80b430'], '0x6bbdf8bdcb1336bc11b6014cf9632ad922e7466a4902abded04dd24d9de06999');
  assert.equal(E.ELY_ROUTER_PINS['0xa226f04cececc3b1ee0ac6f18132db96987cea37'], '0xe15f85a796df9e204082c594e27a4ef335485cd91c52f78654f4daa5454c2e6a');
  assert.equal(E.ELY_ROUTER_PINS['0xeff2423d2b7fb97cbc41994b01c7a8177990394f'], '0x5688072bb686278f17ac1f6ce29e756aaa3cd4c2937f89a3bf50bceef392588c');
  assert.equal(E.ELY_ROUTER_PINS['0x93a5d9271ac5dbe68a2b96ef7a23576eaad15a11'], '0xd7a30e8e5513e151186b98c5fc26e671a896f4b2936c67736d585b98a2b54548');
  assert.equal(E.ELY_ROUTER_PINS['0x90d63fd4ab5bc0b9815cda273cfd5b918afb9168'], '0x864430ad14bc9df3312c83b69e54038b6ff53bf0cdc803bb3c83684a933215b4');
  assert.equal(E.elyRouterPin('0x' + '12'.repeat(20)), '');
  assert.equal(E.elyRouterPin('__proto__'), '');
});

test('the 9 hooks: pinned per PoolManager; the two refused ones and a hook on the wrong PoolManager stay refused', () => {
  const pins = {
    '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1': { [FLAUNCH]: '0x5087d2c7278b95cc4b8db5013740d556b37a26e8798c3b4f9a2325cbec4c9c66', '0xe6b9d1636b0a7529bb93295bc41707439263a0cc': '0x0c2cc553af57e37c95b72b787778d052c43333474ce7bd9688bb4ec04a1f1311' },
    '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': { [KLEOS_HOOK]: '0x8e43719af855137925a6e23aa7de68e5088043482d96c4e671b84a692fca3874', [KLEOS_HOOK2]: '0xaf16a01031be47d7e640b63afd04fd8e6d5bc28d9711e83aca70734cc65b1633' },
    '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': { '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc': '0x210aad55bc3dee165cb7855e5e08c4466e66640d9f73ad25a758d430929954c2', '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc': '0x8241dd658e717e009a89c23d6365a209f3e23d46dc64ef2ad32f6edb6b8ad7c3', '0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc': '0x254a009a9d1cfba2d31faa5e46b4dfbc3322fda0d593658e9cd87da31c1c15f8', '0xa07345953c6efaf223676dabfe05421583a0e8cc': '0x125509302c3939efc28fec672c677ff368834a3a9a37c33ee7a5e32097650f07' },
    '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da': { '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc': '0x32738acdbbfb485c66475a975598df41427bd050071ceb9f4e9ceaded2428044' },
  };
  for (const [pm, hs] of Object.entries(pins)) for (const [h, pin] of Object.entries(hs)) { assert.equal(E.elyHookPin(pm, h), pin, h); assert.ok(E.ELY_HOOK_RULES[h], 'rules for ' + h); }
  // stage 3's two ElysPump hooks unchanged, no rules
  assert.equal(E.elyHookPin('0x5fb015a49f5b35073f9ce01c2adb287a75f89600', '0xe11cafa5901b0aab51eb78251488400f9e4320cc'), '0xe092fe7f04001d4a23e8a3d50b1afbde84ea3abfc2d48da2e96d3cd4f947fee3');
  assert.deepEqual(E.elyHookRules('0xe11cafa5901b0aab51eb78251488400f9e4320cc', SENDU, '0x' + '0'.repeat(64)), []);
  // refused: BOXA's graduated-pool hook (freeze lever), Kleos' rugged launcher hook, any other, and a trusted hook on another PoolManager
  assert.match(E.elyRouteProblem(SENDU, route('bx-v4', key(SENDU, '0xf38d13c56eafa1143a6ee99a56d2f1234540eaec'))), /refuses/);
  assert.match(E.elyRouteProblem(SENDU, route('kl-v4', key(SENDU, '0x4d5f470c2c59202f646c26e4de807ed75ecc68c0'))), /refuses/);
  // release 7: a pinned hook on another (stock) PoolManager is not pinned there: without the lane's code hash it is not even considered
  assert.match(E.elyRouteProblem(SENDU, route('bx-v4', SENDU_KEY)), /not been read/, 'a Kleos hook behind BOXA\'s PoolManager');
  assert.match(E.elyRouteProblem(SENDU, route('uni-v4', SENDU_KEY)), /not been read/);
  assert.equal(E.elyRouteProblem(SENDU, route('kl-v4', SENDU_KEY)), '');
  assert.equal(E.elyRouteProblem(VOLTA, route('uni-v4', key(VOLTA, FLAUNCH))), '');
  assert.equal(E.elyRouteProblem(SENDU, { type: 'ely', chainId: 99901, venue: 'rp-v3', pair: 'weth', fee: 10000 }), '');
  assert.match(E.elyRouteProblem(SENDU, { type: 'ely', chainId: 99901, venue: 'rp-v4', pair: 'native', poolKey: SENDU_KEY }), /venue this vault does not trade/);
});

test('candidates: the launchpad venues come in only through the hint, with their router pin, the hook pin and the buy rules', () => {
  const own = E.elyCandidates(SENDU, null);
  assert.ok(own.every((c) => ['uni-v4', 'ep-v4', 'uni-v3', 'ep-v3'].includes(c.venue)), 'no launchpad venue without a hint');
  assert.ok(own.every((c) => c.routerPin === E.ELY_ROUTER_PINS[c.router]));
  const c = E.elyCandidates(SENDU, route('kl-v4', SENDU_KEY)).find((x) => x.hinted);
  assert.equal(c.venue, 'kl-v4'); assert.equal(c.router, '0xa226f04cececc3b1ee0ac6f18132db96987cea37'); assert.equal(c.routerPin, E.ELY_ROUTER_PINS[c.router]);
  assert.equal(c.pin.hook, KLEOS_HOOK); assert.equal(c.pool, E.v4PoolId(SENDU_KEY)); assert.equal(c.rules.length, 3);
  const v3 = E.elyCandidates(SENDU, { type: 'ely', chainId: 99901, venue: 'rp-v3', pair: 'weth', fee: 10000 }).find((x) => x.hinted);
  assert.equal(v3.venue, 'rp-v3'); assert.equal(v3.pool, E.v3PoolOf('0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f', SENDU, E.ELY_WHYPE, 10000)); assert.equal(v3.rules, undefined);
  // a refused hint adds nothing
  assert.equal(E.elyCandidates(SENDU, route('bx-v4', key(SENDU, '0xf38d13c56eafa1143a6ee99a56d2f1234540eaec'))).length, own.length);
});

test('the rules: selectors and word layouts per hook (read on chain), on BUYS only — a sell runs the code pins alone', () => {
  const id = E.v4PoolId(SENDU_KEY), w = (x) => x.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const R = (h) => E.elyHookRules(h, SENDU, id).map((r) => [r.target, r.data, r.op, r.i, r.j, r.k, r.value]);
  const { LE, HASH, AFTER, WINDOW_LE } = E.ELY_RULE;
  assert.equal(toFunctionSelector('function book(address)'), '0x7ca81460');
  assert.deepEqual(R(KLEOS_HOOK), [[KLEOS_HOOK, '0xbbb356a6' + w(SENDU), LE, 2, 0, 0, 1000n], [KLEOS_HOOK, '0xbbb356a6' + w(SENDU), LE, 3, 0, 0, 1000n], [KLEOS_HOOK, '0x8652edf9' + w(SENDU), HASH, 0, 0, 0, BigInt(id)]]);
  assert.deepEqual(R(KLEOS_HOOK2).map((r) => r.slice(2)), R(KLEOS_HOOK).map((r) => r.slice(2)), 'the mutable-tax Kleos hook: the same reads at every buy');
  const bcc1 = '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc', b3e2 = '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc';
  assert.deepEqual(R(bcc1), [[bcc1, '0xb5217bb4' + w(id), LE, 8, 0, 0, 100000n], [bcc1, '0xb5217bb4' + w(id), LE, 9, 0, 0, 100000n], [bcc1, '0xb5217bb4' + w(id), AFTER, 7, 0, 0, 60n]]);
  assert.deepEqual(R(b3e2).map((r) => [r[2], r[3], r[6]]), [[LE, 9, 100000n], [LE, 10, 100000n], [AFTER, 8, 60n]]);
  assert.deepEqual(R('0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc').map((r) => [r[2], r[3], r[6]]), [[LE, 9, 100000n], [LE, 10, 100000n], [AFTER, 8, 60n]]);
  const a073 = '0xa07345953c6efaf223676dabfe05421583a0e8cc';
  assert.deepEqual(R(a073).map((r) => [r[1].slice(0, 10), r[2], r[3], r[6]]), [['0x0eb1b8aa', LE, 0, 1000n], ['0x0eb1b8aa', LE, 1, 1000n], ['0x1daf62d6', LE, 0, 0n], ['0x55d1cb60', HASH, 0, BigInt(id)]]);
  const eleos = '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc';
  assert.deepEqual(R(eleos).map((r) => [r[1].slice(0, 10), r[2], r[3], r[6]]), [['0x0e68ec95', LE, 1, 1000n], ['0x0e68ec95', LE, 2, 1000n], ['0x2a9c5cb1', HASH, 0, BigInt(id)], ['0x7ca81460', AFTER, 0, 600n]]);
  assert.deepEqual(R(FLAUNCH).map((r) => [r[1].slice(0, 10), r[2], r[3], r[4], r[5], r[6]]), [['0x2cb79b72', LE, 0, 0, 0, 500n], ['0x2cb79b72', WINDOW_LE, 3, 2, 1, 1000n]]);
  assert.deepEqual(R('0xe6b9d1636b0a7529bb93295bc41707439263a0cc').map((r) => [r[1].slice(0, 10), r[2], r[3], r[6]]), [['0x0885f732', LE, 3, 1000n]]);
  // in the probe: the buy case carries them, the sell case does not; the pins are in both
  const c = E.elyCandidates(SENDU, route('kl-v4', SENDU_KEY)).find((x) => x.hinted);
  const buy = guardArgs(E.probeCase(c, SENDU, { buy: 10n ** 16n, roundTrip: true, deadline: 9n }).checkData);
  const sell = guardArgs(E.probeCase(c, SENDU, { sell: 10n ** 18n, deadline: 9n }).checkData);
  assert.equal(buy[6].length, 3); assert.equal(sell[6].length, 0);
  for (const g of [buy, sell]) { assert.equal(g[0].toLowerCase(), c.router); assert.equal(g[1], c.routerPin); assert.equal(g[2].toLowerCase(), KLEOS_HOOK); assert.equal(g[3], c.pin.codeHash); }
});

test('the 6-field SWAP_EXACT_IN_SINGLE (minHopPriceX36 = 0 before hookData) on every V4 buy and sell; Robinhood\'s encoder untouched', () => {
  const SIX = [{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }];
  const swapOf = (enc) => {
    const call = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: E.elyExecute(enc, 9n) });
    const cmds = call.args[0].slice(2).match(/../g).map((x) => parseInt(x, 16)); const v4 = call.args[1][cmds.indexOf(0x10)];
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], v4);
    return { actions: actions.slice(2).match(/../g).map((x) => parseInt(x, 16)), params, swap: decodeAbiParameters(SIX, params[0])[0] };
  };
  for (const pair of ['native', 'weth']) {
    const pk = pair === 'native' ? SENDU_KEY : { currency0: SENDU < E.ELY_WHYPE ? SENDU : E.ELY_WHYPE, currency1: SENDU < E.ELY_WHYPE ? E.ELY_WHYPE : SENDU, fee: 3000, tickSpacing: 60, hooks: ZERO };
    const c = { venue: 'kl-v4', pair, router: E.ELY_VENUES['kl-v4'].router, routerPin: '0x', poolKey: pk, pool: E.v4PoolId(pk), check: { target: ZERO, data: '0x' } };
    for (const [label, enc] of [['buy', E.elyBuyEnc(c, SENDU, 7n, 5n)], ['sell', E.elySellEnc(c, SENDU, 7n, 5n)]]) {
      const s = swapOf(enc);
      assert.equal(s.swap.minHopPriceX36, 0n, pair + ' ' + label); assert.equal(s.swap.hookData, '0x'); assert.equal(s.swap.amountIn, 7n); assert.equal(s.swap.amountOutMinimum, 5n);
      assert.equal(s.params[0].length, 2 + 2 * 32 * 12, 'tuple head (5 key words + 5 fields) + the empty bytes\' offset target: 12 words');
    }
  }
  // the native sell = encodeV4Sell's plan (SWAP_EXACT_IN_SINGLE, SETTLE_ALL coin, TAKE_ALL native ≥ min) but for the swap's 6th field
  const c = { venue: 'kl-v4', pair: 'native', router: E.ELY_VENUES['kl-v4'].router, routerPin: '0x', poolKey: SENDU_KEY, pool: E.v4PoolId(SENDU_KEY), check: { target: ZERO, data: '0x' } };
  const ours = swapOf(E.elySellEnc(c, SENDU, 7n, 5n)), rh = encodeV4Sell(SENDU_KEY, SENDU, ZERO, 7n, 5n);
  const [rhActions, rhParams] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], rh.inputs[0]);
  assert.deepEqual(ours.actions, [0x06, 0x0c, 0x0f]); assert.equal(rhActions, '0x060c0f');
  assert.equal(ours.params[1], rhParams[1]); assert.equal(ours.params[2], rhParams[2]);
  assert.equal(rh.commands, '0x10');
  // the template's amount words are still found (the probe rewrites the sell amount in place)
  const t = E.sellTemplate(c, SENDU, 9n); assert.equal(t.at.length, 2);
});

test('ELY_GUARD_CODE is the build of contracts/ElysiumGuard.sol (solc 0.8.26; skipped without SOLC_DIR)', { skip: !process.env.SOLC_DIR }, async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['scripts/elysium-probe-build.mjs', '--check'], { cwd: new URL('..', import.meta.url), env: process.env, encoding: 'utf8' });
  assert.match(out, /MATCH: src\/elysiumCore.ts ELY_GUARD_CODE carries exactly this build/);
  assert.match(out, /MATCH: src\/elysiumCore.ts ELYSIUM_PROBE_RUNTIME carries exactly this build/);
});
