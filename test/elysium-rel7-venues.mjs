// Release 7: the venues of B:\tmp\elysium-venues (all 8 routers deployed by the owner, 2026-11-04, code == pin on both nodes):
// four stock V3Factory copies, two stock V4 PoolManager copies, Stockium's renamed-callback V3 fork (own pool init hash) and Kleos V3
// pools quoted in Kleos' own WHYPE 0x0269…9eef. V3 fee tiers: any integer in (0, 100000]. Pure: no network.
//   node --experimental-strip-types --test test/elysium-rel7-venues.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters } from 'viem';
import * as E from '../src/elysiumCore.ts';
import { UNIVERSAL_ROUTER_ABI } from '../src/evmV4Router.ts';

const ZERO = E.ELY_ZERO, WHYPE = E.ELY_WHYPE, KWHYPE = '0x0269031ace34a7821e9d9980d087c35ce7c19eef';
const SK_INIT = '0xab731c888a784cd72dd98028619d80deda496aa32aefca8b3c9062312c62bec4';
const COIN = '0x392ea0144a622773eaee0fa59141f058ad39eef3';
const NEW = {
  'x75-v3': ['v3', '0x75dc4e1ac45d332e96821c62dc72039f428b2225', '0x72f0b62115788a3e73c2e64130a181588f266f98', '0x7d37712b904d2866d276abddf614845e47cf472131db04a8720dd56a641727bd'],
  'x72-v3': ['v3', '0x7266c0ecff2a687b4ad0ead7b24840929540b697', '0x45a7f90f3cfd605c71cc2abf3ef50e67707d8384', '0x9932a405c19cee9aeaddb046b6b16342cc46b0ac6cc1e933dd706dc7c415d7be'],
  'x62-v3': ['v3', '0x626005ca43f45568ad5f084087e5ae7cbba04e06', '0xf2ee65cab8a036b2f344a3b52ed13327de5e8092', '0x5efa1616c9d465f599d707ca5477fbbf631ac18796befcdfa3e2fd6128375c7f'],
  'xf4-v3': ['v3', '0xf460854da9a40ad833c27996c749c1b8baaf3b86', '0xe8bd48bf9485d0a3304448175de9738c7d550f2b', '0x58586042025eb2d69f38da69246a190c603c9b439be33f7ebb7a98895305ee23'],
  'xe5-v4': ['v4', '0xe5bdc9a87b54ac1624cb51095dc86636378c4fb6', '0x53b1d0dc90912bbdb16f30edd8c9b4f0e30d0093', '0xedd95cc60bd7f0a445271883afd682ba4a51fe500e53f3a08e1b8a17592795fb'],
  'x9f-v4': ['v4', '0x9fc48776883a89b9611979069ce25be1e82a536d', '0x6914053b2bdcd1c30bb5476fed6018a2ae0c3449', '0x332506ee6e0aa6735ed45e1a027df013e5ddc5a89d3f1fa1c7a6437f848bb766'],
  'sk-v3': ['v3', '0x4f66184a9ffabb7f7071d590c2c48dedf41676f4', '0x78088ead4aea127d9134d992b29b40cfb6542964', '0xde5ddd916696fd2975fe127ebc8d71dd4e7cb19b18fed70adffae20167d3fa46'],
  'klw-v3': ['v3', '0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1', '0x49854cdc529f76dcf3b90b2ec04e6cfa94fd4b3f', '0x99471b4edde5884290c99a1167ab3c2c336f8ef1d75aec1e833b58f1c1286bab'],
};
const v3r = (venue, fee) => ({ type: 'ely', chainId: 99901, venue, pair: 'weth', fee });
const V3IN = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }];
const v3Path = (enc) => {
  const call = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: E.elyExecute(enc, 9n) });
  const cmds = call.args[0].slice(2).match(/../g).map((x) => parseInt(x, 16));
  return decodeAbiParameters(V3IN, call.args[1][cmds.indexOf(0x00)])[3].toLowerCase();
};

test('the 8 new venues: kind, factory / PoolManager, router, router code pin; ELY_ROUTERS includes every router', () => {
  for (const [v, [kind, at, router, pin]] of Object.entries(NEW)) {
    const x = E.ELY_VENUES[v]; assert.ok(x, v); assert.equal(x.kind, kind, v);
    assert.equal(kind === 'v4' ? x.manager : x.factory, at, v); assert.equal(x.router, router, v);
    assert.equal(E.ELY_ROUTER_PINS[router], pin, v); assert.equal(E.elyRouterPin(router), pin);
    assert.ok(E.ELY_ROUTERS.includes(router), v);
  }
  for (const v of Object.values(E.ELY_VENUES)) assert.ok(/^0x[0-9a-f]{64}$/.test(E.elyRouterPin(v.router)), 'every venue router is pinned: ' + v.router);
});

test('each new V3 venue routes through its own router; pool = CREATE2 of its factory with its init hash and wrapped HYPE', () => {
  for (const [v, [kind, factory, router, pin]] of Object.entries(NEW)) {
    if (kind !== 'v3') continue;
    assert.equal(E.elyRouteProblem(COIN, v3r(v, 10000)), '', v);
    const c = E.elyCandidates(COIN, v3r(v, 10000)).find((x) => x.hinted && x.venue === v);
    assert.ok(c, v); assert.equal(c.router, router); assert.equal(c.routerPin, pin);
    const wrapped = v === 'klw-v3' ? KWHYPE : WHYPE, init = v === 'sk-v3' ? SK_INIT : E.ELY_V3_INIT_HASH;
    assert.equal(E.elyWrappedOf(v), wrapped, v); assert.equal(E.elyV3InitHashOf(v), init, v);
    assert.equal(c.pool, E.v3PoolOf(factory, COIN, wrapped, 10000, init), v);
    assert.equal(c.check.target, c.pool);
    const pc = E.probeCase(c, COIN, { buy: 10n ** 16n, roundTrip: true, deadline: 9n });
    assert.equal(pc.wrapped.toLowerCase(), wrapped, 'probe wrapped ' + v);
    const buyPath = v3Path(E.elyBuyEnc(c, COIN, 7n, 5n)), sellPath = v3Path(E.elySellEnc(c, COIN, 7n, 5n));
    assert.equal(buyPath.slice(0, 42), wrapped, 'buy path starts with the venue wrapped HYPE: ' + v);
    assert.equal('0x' + sellPath.slice(-40), wrapped, 'sell path ends with it: ' + v);
  }
  // Stockium's pool is NOT at the canonical-init-hash address
  assert.notEqual(E.v3PoolOf(NEW['sk-v3'][1], COIN, WHYPE, 10000, SK_INIT), E.v3PoolOf(NEW['sk-v3'][1], COIN, WHYPE, 10000));
  // the old venues keep canonical WHYPE and init hash (Kleos V3 0x809f: both kl-v3 and klw-v3 exist)
  for (const v of ['uni-v3', 'ep-v3', 'kl-v3', 'bx-v3', 'rp-v3']) { assert.equal(E.elyWrappedOf(v), WHYPE, v); assert.equal(E.elyV3InitHashOf(v), E.ELY_V3_INIT_HASH, v); }
  assert.equal(E.ELY_VENUES['klw-v3'].factory, E.ELY_VENUES['kl-v3'].factory);
});

test('the two new V4 PoolManagers route hookless pools', () => {
  for (const v of ['xe5-v4', 'x9f-v4']) {
    const pk = { currency0: ZERO, currency1: COIN, fee: 10000, tickSpacing: 200, hooks: ZERO };
    const r = { type: 'ely', chainId: 99901, venue: v, pair: 'native', poolKey: pk };
    assert.equal(E.elyRouteProblem(COIN, r), '', v);
    const c = E.elyCandidates(COIN, r).find((x) => x.hinted);
    assert.equal(c.router, NEW[v][2]); assert.equal(c.check.target, NEW[v][1]);
  }
});

test('V3 fee tiers: any integer in (0, 100000]', () => {
  for (const fee of [100, 500, 3000, 10000, 20000, 40000, 50000, 100000]) assert.equal(E.elyRouteProblem(COIN, v3r('x75-v3', fee)), '', String(fee));
  for (const fee of [0, -1, 100001, 1e6, 2.5, NaN]) assert.notEqual(E.elyRouteProblem(COIN, v3r('x75-v3', fee)), '', String(fee));
  assert.match(E.elyRouteProblem(COIN, v3r('sk-v3', 100001)), /10 %/);
  // a V3 route stays WHYPE-quoted
  assert.notEqual(E.elyRouteProblem(COIN, { type: 'ely', chainId: 99901, venue: 'x75-v3', pair: 'native', fee: 3000 }), '');
});
