// Release 7 (owner in chat 2026-11-04: «Да, автохуки»; «выводи и также пиши что не проверено …»): hook tiers.
// Tier 1 'reviewed' = a reviewed CODE HASH on its PoolManager (any address); 'auto' = the lane's claim for a hash the watcher passed;
// 'unverified' = any other non-refused hook on a stock V4 PoolManager with a static fee ≤ 10 %. The claimed hash goes into ELY_GUARD,
// which checks EXTCODEHASH on chain (a wrong claim = "no pool"). Pure: no network.
//   node --experimental-strip-types --test test/elysium-rel7-tiers.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import * as E from '../src/elysiumCore.ts';

const ZERO = E.ELY_ZERO, WHYPE = E.ELY_WHYPE;
const PM = {
  uni: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', ep: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', kl: '0xb308b5df891c300a5f5a5b8fdbc30108ba842490',
  bx: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', el: '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', e5: '0xe5bdc9a87b54ac1624cb51095dc86636378c4fb6', f9: '0x9fc48776883a89b9611979069ce25be1e82a536d',
};
const VENUE_OF = { [PM.uni]: 'uni-v4', [PM.ep]: 'ep-v4', [PM.kl]: 'kl-v4', [PM.bx]: 'bx-v4', [PM.el]: 'el-v4', [PM.e5]: 'xe5-v4', [PM.f9]: 'x9f-v4' };
const KLEOS_HASH = '0x8e43719af855137925a6e23aa7de68e5088043482d96c4e671b84a692fca3874';   // 0xd506…eacc's code
const ASC_HOOK = '0xe0def4221b9840a610d4e7d55812a79a6431a8ec', ASC_HASH = '0x190f4d572cbca47e96519434e6c6dfd537ffd13ce9e5a657fa5fa120a4bad6f1';
const BOXA2_HOOK = '0x00c002cdae688f39a90cf2ad74c59421c9502acc', BOXA2_HASH = '0x1d27e76e5d5d09ce30d09b9ee4eed615751ed29f45de3b0fe2e78aeb402a69fd';
const KCLONE_HOOK = '0x0fa71294c909b11a0b805df4763ba576c69c2acc', KCLONE_HASH = '0x5953588a651a4f7832020a4cc69be9db52ad0589713358b2413ed127ad6d0459';
const BOZO_HOOK = '0x050a7676df43e3c99da7fea35ed78bea4eebeaec', BOZO_HASH = '0x5f3291975395008efee3c304ce7cfe003942e0302f8683cf668f212537722518';
const EACC = '0x7e2e70332829036984fb1d337799ddd43401cdcb';
const COIN = '0x392ea0144a622773eaee0fa59141f058ad39eef3';
const FRESH_HOOK = '0x' + 'ab'.repeat(18) + '2acc';            // a new deployment: beforeSwap / afterSwap / both return deltas
const UNKNOWN_HASH = '0x' + '5a'.repeat(32);
const DYN = 0x800000;
const nat = (coin, hooks, fee = 0, ts = 200) => ({ currency0: ZERO, currency1: coin, fee, tickSpacing: ts, hooks });
const weth = (coin, hooks, fee = 0, ts = 200) => (coin < WHYPE ? { currency0: coin, currency1: WHYPE, fee, tickSpacing: ts, hooks } : { currency0: WHYPE, currency1: coin, fee, tickSpacing: ts, hooks });
const v4r = (venue, pk, hook, pair = 'native') => ({ type: 'ely', chainId: 99901, venue, pair, poolKey: pk, ...(hook ? { hook } : {}) });
const hinted = (coin, r) => E.elyCandidates(coin, r).find((c) => c.hinted);
const GUARD_IN = [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }, { type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'op', type: 'uint8' }, { name: 'i', type: 'uint16' }, { name: 'j', type: 'uint16' }, { name: 'k', type: 'uint16' }, { name: 'value', type: 'uint256' }] }];
const guardArgs = (d) => decodeAbiParameters(GUARD_IN, '0x' + d.slice(10));
const seen = (nativeBack, over = {}) => ({ ran: true, buyOk: true, coinGot: 10n ** 18n, nativeSpent: E.ELY_LANE_REF_IN, buyGas: 1n, sellOk: true, coinSold: 10n ** 18n, nativeBack, sellGas: 1n, taxSent: 0n, taxGot: 0n, routerKept: false, err: '0x', ...over });
const pctOfRef = (bps) => (E.ELY_LANE_REF_IN * BigInt(bps)) / 10_000n;

test('the constants of the tiers', () => {
  assert.deepEqual([...E.ELY_OPEN_MANAGERS].map((x) => x.toLowerCase()).sort(), Object.values(PM).sort());
  assert.equal(E.ELY_UNVERIFIED_MAX_BUY, 3n * 10n ** 18n);
  assert.equal(E.ELY_UNREVIEWED_ROUNDTRIP_MIN_BPS, 8000n);
  assert.equal(E.elyTierLabel('reviewed'), 'Reviewed'); assert.equal(E.elyTierLabel('auto'), 'Auto-checked'); assert.equal(E.elyTierLabel('unverified'), 'Unverified');
  assert.equal(E.elyTierLabel('none'), '');
});

test('rel7 reviewed hashes: ASC, BOXA v2, the Kleos clone, BOZO — on Uniswap\'s PoolManager', () => {
  const want = { [ASC_HASH]: ASC_HOOK, [BOXA2_HASH]: BOXA2_HOOK, [KCLONE_HASH]: KCLONE_HOOK, [BOZO_HASH]: BOZO_HOOK };
  for (const [h, addr] of Object.entries(want)) {
    assert.ok(Object.prototype.hasOwnProperty.call(E.ELY_HOOK_CODES[PM.uni], h), 'reviewed on Uniswap PM: ' + h);
    assert.equal(typeof E.ELY_HOOK_CODE_RULES[h], 'function', 'rules for ' + h);
    const v = E.elyHookVerdict(PM.uni, addr, 0, { codeHash: h });
    assert.equal(v.ok, true, addr); assert.equal(v.tier, 'reviewed', addr); assert.equal(v.codeHash, h);
  }
  // ASC's pools: WHYPE-quoted, DYNAMIC fee flag — allowed because the hook is reviewed
  const asc = weth(EACC, ASC_HOOK, DYN);
  assert.equal(E.elyRouteProblem(EACC, v4r('uni-v4', asc, { codeHash: ASC_HASH }, 'weth')), '');
  const c = hinted(EACC, v4r('uni-v4', asc, { codeHash: ASC_HASH }, 'weth'));
  assert.equal(c.tier, 'reviewed'); assert.equal(c.pin.codeHash, ASC_HASH); assert.ok(c.rules?.length >= 1);
  const r = c.rules[0];
  assert.equal(r.target, ASC_HOOK); assert.equal(r.data.slice(0, 10), '0xcaa93ee8'); assert.equal(r.op, E.ELY_RULE.LE); assert.equal(r.value, 100000n);
});

test('reviewed BY HASH: the same code at a NEW address on the same PoolManager is reviewed, its rules read the new address', () => {
  const v = E.elyHookVerdict(PM.kl, FRESH_HOOK, 0, { codeHash: KLEOS_HASH });
  assert.equal(v.ok, true); assert.equal(v.tier, 'reviewed');
  const c = hinted(COIN, v4r('kl-v4', nat(COIN, FRESH_HOOK), { codeHash: KLEOS_HASH }));
  assert.ok(c, 'a candidate for the new deployment');
  assert.equal(c.tier, 'reviewed'); assert.equal(c.pin.hook, FRESH_HOOK); assert.equal(c.pin.codeHash, KLEOS_HASH);
  const id = E.v4PoolId(nat(COIN, FRESH_HOOK));
  assert.ok(c.rules.length === 3 && c.rules.every((r) => r.target === FRESH_HOOK), 'the Kleos rules, targeting the new deployment');
  assert.deepEqual(c.rules.map((r) => [r.data.slice(0, 10), r.op, r.i]), [['0xbbb356a6', E.ELY_RULE.LE, 2], ['0xbbb356a6', E.ELY_RULE.LE, 3], ['0x8652edf9', E.ELY_RULE.HASH, 0]]);
  assert.equal(c.rules[2].value, BigInt(id));
  // the guard gets the new address and the hash: on chain it checks EXTCODEHASH(new address) == the reviewed hash
  const g = guardArgs(E.probeCase(c, COIN, { buy: 10n ** 16n, roundTrip: true, deadline: 9n }).checkData);
  assert.equal(g[2].toLowerCase(), FRESH_HOOK); assert.equal(g[3], KLEOS_HASH); assert.equal(g[6].length, 3);
  const s = guardArgs(E.probeCase(c, COIN, { sell: 10n ** 18n, deadline: 9n }).checkData);
  assert.equal(s[2].toLowerCase(), FRESH_HOOK); assert.equal(s[3], KLEOS_HASH); assert.equal(s[6].length, 0, 'a sell never runs the buy rules');
});

test('the same reviewed hash on ANOTHER PoolManager is not reviewed (it may still be unverified)', () => {
  const v = E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, { codeHash: KLEOS_HASH });   // Kleos' code reviewed on Kleos' PM only
  assert.notEqual(v.tier, 'reviewed');
  const c = hinted(COIN, v4r('uni-v4', nat(COIN, FRESH_HOOK), { codeHash: KLEOS_HASH }));
  if (c) { assert.notEqual(c.tier, 'reviewed'); assert.ok(!c.rules || c.rules.length === 0, 'no reviewed rules on another PoolManager'); }
});

test('unverified: any non-refused hook with a 32-byte hash and a static fee ≤ 10 % on every open PoolManager', () => {
  for (const pm of Object.values(PM)) {
    const v = E.elyHookVerdict(pm, FRESH_HOOK, 0, { codeHash: UNKNOWN_HASH });
    assert.equal(v.ok, true, pm); assert.equal(v.tier, 'unverified', pm); assert.equal(v.codeHash, UNKNOWN_HASH);
    assert.equal(E.elyHookVerdict(pm, FRESH_HOOK, 100_000, { codeHash: UNKNOWN_HASH }).ok, true, 'static 10 % ' + pm);
    assert.equal(E.elyHookVerdict(pm, FRESH_HOOK, 100_001, { codeHash: UNKNOWN_HASH }).ok, false, 'static > 10 % ' + pm);
    const venue = VENUE_OF[pm];
    assert.equal(E.elyRouteProblem(COIN, v4r(venue, nat(COIN, FRESH_HOOK), { codeHash: UNKNOWN_HASH })), '', venue);
    const c = hinted(COIN, v4r(venue, nat(COIN, FRESH_HOOK), { codeHash: UNKNOWN_HASH }));
    assert.equal(c.tier, 'unverified', venue); assert.equal(c.pin.codeHash, UNKNOWN_HASH, venue); assert.equal(c.pin.hook, FRESH_HOOK);
    assert.ok(!c.rules || c.rules.length === 0, 'no rules for an unknown code');
    const g = guardArgs(E.probeCase(c, COIN, { buy: 10n ** 16n, roundTrip: true, deadline: 9n }).checkData);
    assert.equal(g[2].toLowerCase(), FRESH_HOOK); assert.equal(g[3], UNKNOWN_HASH, 'the claimed hash reaches ELY_GUARD');
    assert.equal(g[0].toLowerCase(), c.router); assert.equal(g[1], c.routerPin);
  }
});

test('unverified on a PoolManager that is not open: refused', () => {
  const v = E.elyHookVerdict('0x' + '77'.repeat(20), FRESH_HOOK, 0, { codeHash: UNKNOWN_HASH });
  assert.equal(v.ok, false); assert.ok(v.problem.length > 0);
});

test('missing or malformed code hash: refused (no candidate, no route)', () => {
  for (const claim of [undefined, {}, { codeHash: '' }, { codeHash: '0x1234' }, { codeHash: '0x' + 'zz'.repeat(32) }, { codeHash: '0x' + '00'.repeat(32) }, { codeHash: 42 }]) {
    const v = E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, claim);
    assert.equal(v.ok, false, JSON.stringify(claim)); assert.ok(v.problem);
    assert.notEqual(E.elyRouteProblem(COIN, v4r('uni-v4', nat(COIN, FRESH_HOOK), claim)), '', JSON.stringify(claim));
  }
  const own = E.elyCandidates(COIN, null).length;
  assert.equal(E.elyCandidates(COIN, v4r('uni-v4', nat(COIN, FRESH_HOOK))).length, own, 'a hint without a hash adds nothing');
});

test('a dynamic fee: refused behind an unverified hook, allowed behind the reviewed ASC hook', () => {
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, DYN, { codeHash: UNKNOWN_HASH }).ok, false);
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, DYN, { codeHash: UNKNOWN_HASH, tier: 'auto' }).ok, false, 'auto too');
  assert.notEqual(E.elyRouteProblem(COIN, v4r('uni-v4', nat(COIN, FRESH_HOOK, DYN), { codeHash: UNKNOWN_HASH })), '');
  assert.equal(E.elyHookVerdict(PM.uni, ASC_HOOK, DYN, { codeHash: ASC_HASH }).ok, true);
  // a hook WITHOUT swap flags and a dynamic fee: still refused, as in rel6
  const noSwap = '0x' + 'ab'.repeat(18) + '2000';
  assert.notEqual(E.elyRouteProblem(COIN, v4r('uni-v4', nat(COIN, noSwap, DYN))), '');
  assert.equal(E.elyRouteProblem(COIN, v4r('uni-v4', nat(COIN, noSwap, 10_000))), '', 'no swap flags + static fee: open, no hash needed');
});

test('the lane\'s tier claim: "auto" only for a non-reviewed, non-refused hash; "reviewed" for an unknown hash is ignored', () => {
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, { codeHash: UNKNOWN_HASH, tier: 'auto' }).tier, 'auto');
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, { codeHash: UNKNOWN_HASH, tier: 'reviewed' }).tier, 'unverified');
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, { codeHash: UNKNOWN_HASH, tier: 'bogus' }).tier, 'unverified');
  assert.equal(E.elyHookVerdict(PM.kl, FRESH_HOOK, 0, { codeHash: KLEOS_HASH, tier: 'auto' }).tier, 'reviewed', 'reviewed wins over a lower claim');
  assert.equal(E.elyHookVerdict(PM.kl, FRESH_HOOK, 0, { codeHash: KLEOS_HASH, tier: 'unverified' }).tier, 'reviewed');
  const refusedHash = '0xfe4a1e6e2cbffbe314fdeb28824292a83494d8c87f74c9bd91f128fbc15dc55a';   // AKA 0x6441's code
  assert.equal(E.elyHookVerdict(PM.uni, FRESH_HOOK, 0, { codeHash: refusedHash, tier: 'auto' }).ok, false);
  const c = hinted(COIN, v4r('uni-v4', nat(COIN, FRESH_HOOK), { codeHash: UNKNOWN_HASH, tier: 'auto' }));
  assert.equal(c.tier, 'auto');
});

test('buy-time tier guards: the 3 HYPE cap is for unverified only; the 0.002 HYPE round trip ≥ 80 % for auto and unverified', () => {
  const mk = (tier, hash, hook = FRESH_HOOK, pm = 'kl-v4') => hinted(COIN, v4r(pm, nat(COIN, hook), { codeHash: hash, ...(tier === 'auto' ? { tier } : {}) }));
  const un = mk('unverified', UNKNOWN_HASH), au = mk('auto', UNKNOWN_HASH), rv = mk('reviewed', KLEOS_HASH);
  assert.equal(un.tier, 'unverified'); assert.equal(au.tier, 'auto'); assert.equal(rv.tier, 'reviewed');
  const good = seen(pctOfRef(9500)), low = seen(pctOfRef(7999)), edge = seen(pctOfRef(8000));
  // the cap
  assert.equal(E.elyTierBuyProblem(un, E.ELY_UNVERIFIED_MAX_BUY, good), '');
  assert.notEqual(E.elyTierBuyProblem(un, E.ELY_UNVERIFIED_MAX_BUY + 1n, good), '');
  assert.equal(E.elyTierBuyProblem(au, 10n * 10n ** 18n, good), '', 'auto: normal limits');
  assert.equal(E.elyTierBuyProblem(rv, 10n * 10n ** 18n, good), '', 'reviewed: normal limits');
  // the round trip at the fixed small size
  assert.notEqual(E.elyTierBuyProblem(un, 10n ** 16n, low), '');
  assert.notEqual(E.elyTierBuyProblem(au, 10n ** 16n, low), '');
  assert.equal(E.elyTierBuyProblem(rv, 10n ** 16n, low), '', 'reviewed hooks are bounded by their own rules');
  assert.equal(E.elyTierBuyProblem(un, 10n ** 16n, edge), '', '80 % exactly passes');
  // no reading / a reading whose sell failed: fail closed for the unreviewed tiers
  assert.notEqual(E.elyTierBuyProblem(un, 10n ** 16n, null), '');
  assert.notEqual(E.elyTierBuyProblem(au, 10n ** 16n, seen(pctOfRef(9500), { sellOk: false })), '');
  // hookless / no-hook candidates: no tier guard
  const plain = E.elyCandidates(COIN, null)[0];
  assert.equal(E.elyTierBuyProblem(plain, 10n * 10n ** 18n, null), '');
});
