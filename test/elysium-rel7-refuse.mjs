// Release 7: the explicit REFUSE lists, by address and by code hash (they stay on every tier). Evidence:
//   0xf38d…eaec ELYSIAN   BOXA's fee treasury admin revokes the hook's role → every sell reverts (simulated)
//   0x4d5f…68c0 Kleos     its owner pulled APOGEE's liquidity (block 404612)
//   0x6441…84cc AKA       an admin EOA's setTotalFee up to 100 % → the sell pays 0 (simulated)
//   0xa129…30c4 HELIOS    flow-reactive dynamic fee up to 99 % (code constant)
//   0x1295…e044 Homer     its owner's setRecipient(contract that rejects HYPE) → every sell reverts (simulated; trusted since stage 3)
//   node --experimental-strip-types --test test/elysium-rel7-refuse.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/elysiumCore.ts';

const ZERO = E.ELY_ZERO;
const PM = { uni: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', ep: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', kl: '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', bx: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4' };
const VENUE_OF = { [PM.uni]: 'uni-v4', [PM.ep]: 'ep-v4', [PM.kl]: 'kl-v4', [PM.bx]: 'bx-v4' };
const REFUSED = [
  // [address, code hash, PoolManager it lives on]
  ['0xf38d13c56eafa1143a6ee99a56d2f1234540eaec', '0x0458549495d84b58e89640603a4137c3c90d336572aea8b4829156a7afc47957', PM.bx],
  ['0x4d5f470c2c59202f646c26e4de807ed75ecc68c0', '0xd381bbdeeb78b26e06d9aacd8165322651364039adb946e954f7b6efc8045497', PM.kl],
  ['0x6441fabd29d541f5c74a302685ca2354703d84cc', '0xfe4a1e6e2cbffbe314fdeb28824292a83494d8c87f74c9bd91f128fbc15dc55a', PM.uni],
  ['0xa129c69d439f30e6ffacc435a1627b7f4f9d30c4', '0xce1f76ba2c7609b7a8abd9d4b6e502e151fdee3024d2187358a22de2d9ae2311', PM.uni],
  ['0x1295bd9d641185f361016a898a61a801c0d3e044', '0xd350af6a60352c50a365717fa9c2cfd34e27d274a7893fa5a530d1b76f1e3047', PM.ep],
];
const KLEOS_HOOK = '0xd5068e7f4e2d70d5efbac6fd28a8407252e1eacc', KLEOS_HASH = '0x8e43719af855137925a6e23aa7de68e5088043482d96c4e671b84a692fca3874';
const COIN = '0x392ea0144a622773eaee0fa59141f058ad39eef3';
const FRESH = '0x' + 'cd'.repeat(18) + '2acc';
const nat = (coin, hooks, fee = 0) => ({ currency0: ZERO, currency1: coin, fee, tickSpacing: 200, hooks });
const v4r = (venue, pk, hook) => ({ type: 'ely', chainId: 99901, venue, pair: 'native', poolKey: pk, ...(hook ? { hook } : {}) });

test('the refuse lists hold exactly the five hooks, by address and by hash', () => {
  for (const [a, h] of REFUSED) {
    assert.ok(Object.prototype.hasOwnProperty.call(E.ELY_REFUSED_HOOKS, a), 'address ' + a);
    assert.ok(Object.prototype.hasOwnProperty.call(E.ELY_REFUSED_HOOK_CODES, h), 'hash ' + h);
    assert.ok(String(E.ELY_REFUSED_HOOKS[a]).length > 0 && String(E.ELY_REFUSED_HOOK_CODES[h]).length > 0, 'a reason is given');
  }
  assert.equal(Object.keys(E.ELY_REFUSED_HOOKS).length, REFUSED.length);
  assert.equal(Object.keys(E.ELY_REFUSED_HOOK_CODES).length, REFUSED.length);
  // no refused hash is also reviewed anywhere
  for (const m of Object.values(E.ELY_HOOK_CODES)) for (const [, h] of REFUSED) assert.ok(!Object.prototype.hasOwnProperty.call(m, h), 'refused and reviewed: ' + h);
  assert.equal(E.ELY_REFUSED_HOOKS['__proto__'] === undefined || !Object.prototype.hasOwnProperty.call(E.ELY_REFUSED_HOOKS, '__proto__'), true);
});

test('each refused hook: refused at its address with its own hash, with no hash, and whatever tier the lane claims', () => {
  for (const [a, h, pm] of REFUSED) {
    for (const claim of [{ codeHash: h }, { codeHash: h, tier: 'auto' }, { codeHash: h, tier: 'reviewed' }, undefined]) {
      const v = E.elyHookVerdict(pm, a, 0, claim);
      assert.equal(v.ok, false, a + ' ' + JSON.stringify(claim)); assert.ok(v.problem, 'a reason');
    }
    assert.notEqual(E.elyRouteProblem(COIN, v4r(VENUE_OF[pm], nat(COIN, a), { codeHash: h })), '', a);
    const own = E.elyCandidates(COIN, null).length;
    assert.equal(E.elyCandidates(COIN, v4r(VENUE_OF[pm], nat(COIN, a), { codeHash: h })).length, own, 'a refused hint adds no candidate: ' + a);
  }
});

test('a refused CODE at a fresh address is refused on every open PoolManager', () => {
  for (const [, h] of REFUSED) for (const pm of Object.values(PM)) {
    const v = E.elyHookVerdict(pm, FRESH, 0, { codeHash: h });
    assert.equal(v.ok, false, h + ' on ' + pm);
    assert.notEqual(E.elyRouteProblem(COIN, v4r(VENUE_OF[pm], nat(COIN, FRESH), { codeHash: h })), '');
  }
});

test('a refused ADDRESS claiming a reviewed hash is refused (the address list wins)', () => {
  for (const [a, , pm] of REFUSED) {
    assert.equal(E.elyHookVerdict(pm, a, 0, { codeHash: KLEOS_HASH }).ok, false, a);
    assert.equal(E.elyHookVerdict(PM.kl, a, 0, { codeHash: KLEOS_HASH }).ok, false, a + ' on Kleos');
  }
  assert.notEqual(E.elyRouteProblem(COIN, v4r('kl-v4', nat(COIN, '0x4d5f470c2c59202f646c26e4de807ed75ecc68c0'), { codeHash: KLEOS_HASH })), '');
});

test('HomerPoolHook 0x1295 (stage 3) is refused now; the other rel6 address pins stay reviewed', () => {
  assert.equal(E.elyHookPin(PM.ep, '0x1295bd9d641185f361016a898a61a801c0d3e044') || '', '', 'no pin left for 0x1295');
  assert.notEqual(E.elyRouteProblem(COIN, v4r('ep-v4', nat(COIN, '0x1295bd9d641185f361016a898a61a801c0d3e044', 3000))), '');
  const still = [
    [PM.ep, 'ep-v4', '0xe11cafa5901b0aab51eb78251488400f9e4320cc'],
    [PM.uni, 'uni-v4', '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc'],
    [PM.uni, 'uni-v4', '0xe6b9d1636b0a7529bb93295bc41707439263a0cc'],
    [PM.kl, 'kl-v4', KLEOS_HOOK],
    [PM.kl, 'kl-v4', '0x0c835e6a51717a514144d95c7f0a1c640179e0cc'],
    [PM.bx, 'bx-v4', '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc'],
    [PM.bx, 'bx-v4', '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc'],
    [PM.bx, 'bx-v4', '0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc'],
    [PM.bx, 'bx-v4', '0xa07345953c6efaf223676dabfe05421583a0e8cc'],
    ['0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', 'el-v4', '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc'],
  ];
  for (const [pm, venue, hook] of still) {
    // a rel6 route without any hash claim still works for an address-pinned reviewed hook
    assert.equal(E.elyRouteProblem(COIN, v4r(venue, nat(COIN, hook))), '', hook);
    const c = E.elyCandidates(COIN, v4r(venue, nat(COIN, hook))).find((x) => x.hinted);
    assert.equal(c.tier, 'reviewed', hook); assert.equal(c.pin.hook, hook); assert.ok(/^0x[0-9a-f]{64}$/.test(c.pin.codeHash));
    assert.equal(E.elyHookVerdict(pm, hook, 0).tier, 'reviewed', hook);
    // and the pinned hash is in the by-hash table on its PoolManager
    assert.ok(Object.prototype.hasOwnProperty.call(E.ELY_HOOK_CODES[pm], c.pin.codeHash), 'by hash: ' + hook);
  }
});

test('a reviewed address that claims ANOTHER hash: the claim is not trusted over its pin', () => {
  // the lane says the Kleos hook's code is something else: either refused or guarded with the pinned hash, never with the claim as reviewed
  const v = E.elyHookVerdict(PM.kl, KLEOS_HOOK, 0, { codeHash: '0x' + '5a'.repeat(32) });
  assert.ok(!v.ok || v.codeHash === KLEOS_HASH || v.tier !== 'reviewed', JSON.stringify(v));
});
