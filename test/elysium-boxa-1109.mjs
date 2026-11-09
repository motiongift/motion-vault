// Release 20 (ely-boxa-1109; owner 2026-11-09, variant B): the BOXA hook family (0xb3e2 / 0xd2f8 / 0xbcc1 and BOXA2 0x00c0) has no
// launch-window rule any more: every BOXA launch was "no pool" for its first 60 s (701 coins in 3 hours) while read-only sims showed
// the same fixed fee, no surcharge and no revert inside the window. The fee caps (<= 10 % a side) and BOXA2's pool record stay; Eleos,
// Volta / Flaunch and BOZO keep their windows. Plus the probe's revert in words (elyRevertWhy / elyNoFillWhy, real revert bytes).
// Pure: no network.   node --experimental-strip-types --test test/elysium-boxa-1109.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../src/elysiumCore.ts';

const ZERO = E.ELY_ZERO;
const SAELIS = '0xd9063c6e16fb0b4cb3b68a12e80711190778615a';   // a BOXA launch, hook 0xb3e2, 3 % / 3 %
const H = { b3e2: '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc', d2f8: '0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc', bcc1: '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc',
  eleos: '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc', flaunch: '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc', boxa2: '0x00c002cdae688f39a90cf2ad74c59421c9502acc', bozo: '0x050a7676df43e3c99da7fea35ed78bea4eebeaec' };
const HASH = { boxa2: '0x1d27e76e5d5d09ce30d09b9ee4eed615751ed29f45de3b0fe2e78aeb402a69fd', bozo: '0x5f3291975395008efee3c304ce7cfe003942e0302f8683cf668f212537722518' };
const nat = (coin, hooks, fee = 0, ts = 200) => ({ currency0: ZERO, currency1: coin, fee, tickSpacing: ts, hooks });
const poolId = (hooks) => E.v4PoolId(nat(SAELIS, hooks));
const ops = (rules) => rules.map((r) => r.op);
const { LE, HASH: HSH, AFTER, WINDOW_LE } = E.ELY_RULE;

test('the BOXA family (0xb3e2 / 0xd2f8 / 0xbcc1): fee caps only, no launch window', () => {
  for (const h of [H.b3e2, H.d2f8, H.bcc1]) {
    const r = E.ELY_HOOK_RULES[h]({ token: SAELIS, poolId: poolId(h) });
    assert.deepEqual(ops(r), [LE, LE], h);
    for (const x of r) { assert.equal(x.value, E.ELY_HOOK_MAX_PIPS, h + ' <= 10 % in pips'); assert.equal(x.target, h); assert.match(x.data, /^0xb5217bb4/, 'pools(poolId) of THIS pool'); }
  }
});

test('BOXA2 (code family 0x00c0): fee caps + the coin\'s record of exactly this pool, no launch window', () => {
  const f = E.ELY_HOOK_CODE_RULES[HASH.boxa2];
  assert.ok(f);
  const r = f(H.boxa2, { token: SAELIS, poolId: poolId(H.boxa2) });
  assert.deepEqual(ops(r), [LE, LE, HSH]);
  assert.ok(!ops(r).includes(AFTER));
});

test('the other windows are unchanged: Eleos 600 s, Volta / Flaunch anti-snipe <= 10 %, BOZO 60 s', () => {
  const el = E.ELY_HOOK_RULES[H.eleos]?.({ token: SAELIS, poolId: poolId(H.eleos) });
  assert.ok(el, 'Eleos rules'); assert.deepEqual(el.filter((x) => x.op === AFTER).map((x) => x.value), [600n]);
  const fl = E.ELY_HOOK_RULES[H.flaunch]({ token: SAELIS, poolId: poolId(H.flaunch) });
  assert.deepEqual(ops(fl), [LE, WINDOW_LE]);
  const bz = E.ELY_HOOK_CODE_RULES[HASH.bozo](H.bozo, { token: SAELIS, poolId: poolId(H.bozo) });
  assert.deepEqual(bz.filter((x) => x.op === AFTER).map((x) => x.value), [60n]);
});

test('a BOXA candidate (what ELY_GUARD is asked to check on a buy) carries no AFTER rule', () => {
  const route = { type: 'ely', chainId: 99901, venue: 'bx-v4', pair: 'native', poolKey: nat(SAELIS, H.b3e2), hook: { codeHash: '0x8241dd658e717e009a89c23d6365a209f3e23d46dc64ef2ad32f6edb6b8ad7c3', tier: 'reviewed' } };
  const c = E.elyCandidates(SAELIS, route).find((x) => x.hinted);
  assert.ok(c); assert.equal(c.tier, 'reviewed');
  assert.deepEqual(ops(c.rules), [LE, LE]);
});

test('elyRevertWhy / elyNoFillWhy: the probe\'s own revert bytes in words (real reverts read 2026-11-09)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/ely-boxa-1109/revert-fixtures.json', import.meta.url), 'utf8'));
  const want = { TILL: /has not opened trading on this pool yet/, Swing: /only its launchpad's own router trade \(an allow-list\)/, BOOT1: /only its launchpad's own router trade/,
    sato: /swapper data in hookData/, DIVI: /no liquidity to buy from \(empty/, HRBN: /no liquidity to buy from \(it holds no coins\)/, CRYPT: /no liquidity/, KNTQ: /no liquidity/ };
  for (const [sym, re] of Object.entries(want)) { assert.ok(fx[sym], sym); assert.match(E.elyRevertWhy(fx[sym].err), re, sym); }
  assert.equal(E.elyRevertWhy('0x'), ''); assert.equal(E.elyRevertWhy('0xdeadbeef'), ''); assert.equal(E.elyRevertWhy('0x90bfb865'), '');
  const NO = { ran: false, buyOk: false, err: '0x' };
  assert.equal(E.elyNoFillWhy([{ ...NO, err: fx.TILL.err }, { ...NO, ran: true, err: '0x' }, { ...NO, ran: true, err: fx.DIVI.err }]), E.elyRevertWhy(fx.DIVI.err));
  assert.equal(E.elyNoFillWhy([null, undefined, { ...NO }]), '');
  assert.equal(E.elyNoFillWhy([{ ran: true, buyOk: true, err: fx.TILL.err }]), '', 'a buy that went through is not a no-fill');
});
