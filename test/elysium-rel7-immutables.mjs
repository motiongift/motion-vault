// Release 7, hostile case for "trusted BY CODE HASH": a hook with the reviewed code but DIFFERENT immutables. Immutables are inside the
// runtime code, so they change EXTCODEHASH: same hash => same immutables (PoolManager, launcher, treasury ...). Fixture: 0xb3e2…2acc's
// runtime (BOXA; eth_getCode on the BOXA and Kleos nodes, which agreed, 2026-11-04; 10,313 B). Its launcher() immutable sits at 5
// PUSH32 sites; 0xd2f8…6acc is the same code with another launcher. Pure: no network.
//   node --experimental-strip-types --test test/elysium-rel7-immutables.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256 } from 'viem';
import * as E from '../src/elysiumCore.ts';

const BX = '0x06c63714fbf1f5753017123e2fcfdede4540b2c4';
const B3E2_PIN = '0x8241dd658e717e009a89c23d6365a209f3e23d46dc64ef2ad32f6edb6b8ad7c3', D2F8_PIN = '0x254a009a9d1cfba2d31faa5e46b4dfbc3322fda0d593658e9cd87da31c1c15f8';
const LAUNCHER = 'a9f082af704a8b2e0087cca2edb41e3ebf665e42', D2F8_LAUNCHER = '4cd0ca25d89f3ce6510f41cecf012cd909a321f2';
const code = readFileSync(new URL('./fixtures/hook-b3e2.hex', import.meta.url), 'utf8').trim().toLowerCase();
const FRESH = '0x' + 'ef'.repeat(18) + '2acc', COIN = '0x392ea0144a622773eaee0fa59141f058ad39eef3';
const route = (hash) => ({ type: 'ely', chainId: 99901, venue: 'bx-v4', pair: 'native', poolKey: { currency0: E.ELY_ZERO, currency1: COIN, fee: 0, tickSpacing: 200, hooks: FRESH }, hook: { codeHash: hash } });

test('the fixture is 0xb3e2 reviewed code (hash = its pin) and its launcher immutable appears 5 times', () => {
  assert.equal(keccak256(code), B3E2_PIN);
  assert.equal(code.split(LAUNCHER).length - 1, 5);
  assert.ok(Object.prototype.hasOwnProperty.call(E.ELY_HOOK_CODES[BX], B3E2_PIN));
});

test('changing ONLY the launcher immutable changes the hash: 0xd2f8 launcher gives exactly 0xd2f8 pin, a hostile one gives no pin', () => {
  assert.equal(keccak256(code.split(LAUNCHER).join(D2F8_LAUNCHER)), D2F8_PIN, 'the derivation of 0xd2f8 from 0xb3e2: launcher only');
  const hostile = code.split(LAUNCHER).join('6666666666666666666666666666666666666666'), h = keccak256(hostile);
  assert.notEqual(h, B3E2_PIN);
  for (const m of Object.values(E.ELY_HOOK_CODES)) assert.ok(!Object.prototype.hasOwnProperty.call(m, h), 'a hostile launcher is not reviewed anywhere');
  const v = E.elyHookVerdict(BX, FRESH, 0, { codeHash: h });
  assert.notEqual(v.tier, 'reviewed', 'at best unverified (its cap and the 80 % round trip), never the reviewed rules');
  const c = E.elyCandidates(COIN, route(h)).find((x) => x.hinted);
  if (c) { assert.notEqual(c.tier, 'reviewed'); assert.equal(c.pin.codeHash, h, 'the guard checks the hostile hash, not the pin'); }
  // claiming the REVIEWED hash for the hostile deployment: the guard compares EXTCODEHASH on chain (= h, not the pin) -> "no pool"
  const lie = E.elyCandidates(COIN, route(B3E2_PIN)).find((x) => x.hinted);
  assert.equal(lie.pin.codeHash, B3E2_PIN); assert.notEqual(h, lie.pin.codeHash);
});

test('any single-byte change anywhere changes the hash', () => {
  for (const at of [2, 1000, code.length - 2]) {
    const b = code.slice(at, at + 2), flip = (parseInt(b, 16) ^ 1).toString(16).padStart(2, '0');
    assert.notEqual(keccak256(code.slice(0, at) + flip + code.slice(at + 2)), B3E2_PIN);
  }
});
