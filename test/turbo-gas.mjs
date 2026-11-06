// turboGas(): the gas limit of a turbo send, picked from the route shape (src/turboGas.ts, owner 2026-11-01 “full go-ahead”).
// Pure input → limit checks plus a source check of the two wired lines in webEngine.ts. No network.
//   node --test test/turbo-gas.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turboGas, TURBO_GAS, TURBO_GAS_MAX, TURBO_BIG_BUY } from '../src/turboGas.ts';

const UR = '0x00000000000000000000000000000000000000a1';
const V3 = '0x00000000000000000000000000000000000000a2';
const AT = { ur: UR, v3: V3 };
const TOKEN = '0x00000000000000000000000000000000000000b1';
const CURVE = '0x00000000000000000000000000000000000000c1';
const ROUTER = '0x00000000000000000000000000000000000000c2';
const PORTAL = '0x00000000000000000000000000000000000000c3';
const MANAGER = '0x00000000000000000000000000000000000000c4';
const ZERO = '0x0000000000000000000000000000000000000000';
const PONS_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const LONG_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';

const g = (route, to, side = 'buy', size = 0.01) => turboGas(route, side, size, to, AT);

test('constants', () => {
  assert.equal(TURBO_GAS, 900_000n);
  assert.equal(TURBO_GAS_MAX, 5_000_000n);
  assert.equal(TURBO_BIG_BUY, 1);
});

test('light routes keep 900k (unchanged from before)', () => {
  assert.equal(g({ type: 'v4', poolKey: { hooks: ZERO } }, UR), 900_000n);
  assert.equal(g({ type: 'v4', poolKey: { hooks: PONS_HOOK } }, UR), 900_000n);
  assert.equal(g({ type: 'v4', poolKey: { hooks: PONS_HOOK.toUpperCase().replace('0X', '0x') } }, UR), 900_000n);
  assert.equal(g({ type: 'v3' }, V3), 900_000n);
  assert.equal(g({ type: 'v2', router: ROUTER }, ROUTER), 900_000n);
  assert.equal(g({ type: 'inf', poolKey: { hooks: LONG_HOOK } }, UR), 900_000n);
  assert.equal(g({ type: 'pons', curve: CURVE }, CURVE), 900_000n);
  assert.equal(g({ type: 'standard', stage: 'pool', router: ROUTER }, UR), 900_000n);
});

test('heavy venue calls get their table value', () => {
  assert.equal(g({ type: 'v4', poolKey: { hooks: LONG_HOOK } }, UR), 2_000_000n);
  assert.equal(g({ type: 'v4', poolKey: { hooks: '0x745d717620052a97a22deee2e5eba59583f3e0cc' } }, UR), 2_000_000n);
  assert.equal(g({ type: 'standard', stage: 'curve', router: ROUTER }, ROUTER), 2_000_000n);
  assert.equal(g({ type: 'flap', portal: PORTAL, nativeToQuote: false }, PORTAL), 1_300_000n);
  assert.equal(g({ type: 'flap', portal: PORTAL, nativeToQuote: true }, PORTAL), 2_000_000n);
  assert.equal(g({ type: 'four', manager: MANAGER }, MANAGER), 2_400_000n);
});

test('sells use the same table, with no size step', () => {
  assert.equal(g({ type: 'v4', poolKey: { hooks: LONG_HOOK } }, UR, 'sell', 100), 2_000_000n);
  assert.equal(g({ type: 'four', manager: MANAGER }, MANAGER, 'sell', 100), 2_400_000n);
  assert.equal(g({ type: 'v3' }, V3, 'sell', 100), 900_000n);
});

test('approvals keep 900k, also on a big buy and on a heavy route', () => {
  for (const route of [{ type: 'v4', poolKey: { hooks: LONG_HOOK } }, { type: 'four', manager: MANAGER }, { type: 'flap', portal: PORTAL, nativeToQuote: true }, { type: 'pons', curve: CURVE }]) {
    assert.equal(g(route, TOKEN, 'buy', 0.01), 900_000n);
    assert.equal(g(route, TOKEN, 'buy', 50), 900_000n);
    assert.equal(g(route, TOKEN, 'sell', 50), 900_000n);
  }
});

test('size threshold: a buy of 1 or more lifts every swap call (venue and V3 leg) to 5M', () => {
  const four = { type: 'four', manager: MANAGER };
  assert.equal(g(four, MANAGER, 'buy', 0.99), 2_400_000n);
  assert.equal(g(four, MANAGER, 'buy', 1), 5_000_000n);
  assert.equal(g(four, V3, 'buy', 0.99), 900_000n);   // bridge leg, small
  assert.equal(g(four, V3, 'buy', 1), 5_000_000n);    // bridge leg, big
  assert.equal(g({ type: 'v3' }, V3, 'buy', 1), 5_000_000n);
  assert.equal(g({ type: 'v4', poolKey: { hooks: ZERO } }, UR, 'buy', 3), 5_000_000n);
  assert.equal(g({ type: 'pons', curve: CURVE }, CURVE, 'buy', 1), 5_000_000n);
  assert.equal(g({ type: 'v2', router: ROUTER }, ROUTER, 'buy', 2), 5_000_000n);
  assert.equal(g({ type: 'standard', stage: 'pool', router: ROUTER }, UR, 'buy', 1), 5_000_000n);
});

test('floor 900k and cap 5M hold for every input', () => {
  const routes = [{ type: 'v4', poolKey: { hooks: LONG_HOOK } }, { type: 'v4', poolKey: null }, { type: 'v3' }, { type: 'unknown' }, { type: 'flap', portal: PORTAL }, { type: 'four', manager: MANAGER }];
  for (const r of routes) for (const to of [UR, V3, TOKEN, PORTAL, MANAGER, '']) for (const side of ['buy', 'sell']) for (const size of [0, 0.5, 1, 100, NaN]) {
    const x = turboGas(r, side, size, to, AT);
    assert.ok(x >= 900_000n && x <= 5_000_000n, `${r.type} ${to} ${side} ${size} → ${x}`);
  }
});

test('the limits cover the gas measured on the live chains (2026-11-01, local foreman/turbo-gas.md)', () => {
  const cases = [
    [{ type: 'v4', poolKey: { hooks: LONG_HOOK } }, UR, 0.3, 1_400_000],
    [{ type: 'standard', stage: 'curve', router: ROUTER }, ROUTER, 0.5, 1_350_000],
    [{ type: 'flap', portal: PORTAL, nativeToQuote: false }, PORTAL, 0.5, 850_000],
    [{ type: 'flap', portal: PORTAL, nativeToQuote: true }, PORTAL, 0.5, 900_000],
    [{ type: 'four', manager: MANAGER }, MANAGER, 0.5, 1_560_000],
    [{ type: 'v3' }, V3, 1, 3_900_000],
  ];
  for (const [r, to, size, measured] of cases) assert.ok(turboGas(r, 'buy', size, to, AT) >= BigInt(measured), `${r.type}: ${measured}`);
});

test('webEngine.ts wires turboGas into the turbo send and the Pons pair-asset leg', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("import { turboGas } from './turboGas';"));
  assert.ok(src.includes('return sendCall(wallet, account, req, gasPrice, s.turbo ? turboGas(route, side, size, req.address, { ur: CFG.universalRouter, v3: UNISWAP_V3_ROUTER }) : req.gas, shared); };'));
  assert.ok(src.includes('const lh = await sendCall(wallet, account, leg.request, gasPrice, s.turbo ? turboGas(route, side, size, UNISWAP_V3_ROUTER, { ur: CFG.universalRouter, v3: UNISWAP_V3_ROUTER }) : (leg.request as any).gas, shared);'));
  // the approval sends are unchanged
  assert.equal((src.match(/s\.turbo \? 900_000n/g) || []).length, 3);
});
