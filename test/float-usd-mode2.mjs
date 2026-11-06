// usd-mode2 (2026-11-05, B:/tmp/usd-mode-1105 follow-up): where the reserve pays the buys, W keeps no ready-native buffer, and R's gas
// never comes out of W in a routine plan. Replays the tester's two rel-9 transactions:
//   0x469bddd5…2f75 17:25:37 UTC  R swapped 100.462606 USDG -> 0.044523696 ETH to W  (topup 'below low': W ~$50 under its $90 low band)
//   0xe2a2d4d7…e4a3 17:16:48 UTC  W sent R 0.000086837634614 ETH                     (gas 'reserve gas': R 0.0000132 -> reserveGas 0.0001)
//   node --experimental-strip-types --test test/float-usd-mode2.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';

const D = (n) => F.usd6(n);
const NOW = 1_792_950_000_000;
const ETH = 2256n * F.USD;   // the pool's price at 17:25 UTC (100.462606 USDG for 0.044523696 ETH)
const RH = F.FLOAT_CFG.robinhood;
const eth = (usd) => RH.gasFloor + F.usd6ToNative(D(usd), ETH, 18);
// the tester's Robinhood: $100 buys (target 1.5 x $100 = $150, low $90, high $300), W ~$50 of ETH, R $10,000 of USDG
const rh = (over = {}) => ({ price6: ETH, priceAt: NOW - 5_000, float: eth(50), reserve: 10_000n * 10n ** 6n, reserveNative: RH.reserveGas, active: true,
  presets6: [D(100)], buys6: [D(100), D(100), D(100)], inFlight6: 0n, inFlightReserve6: 0n, idle: true, busyBridge: false, traded: true, ...over });
const planIn = (over = {}) => ({ now: NOW, caps: F.DEFAULT_CAPS, enabled: ['robinhood'], walletUsd6: D(10_000), movedToday6: 0n, feesToday6: 0n, estFee6: () => D(0.01), chains: { robinhood: rh() }, ...over });
const kinds = (p) => p.moves.map((m) => m.kind + ':' + m.reason);

test('before: W under its low band gets the ready-ETH top-up back to 1.5 x the buy size (the tester\'s 0x469b, ~$100)', () => {
  const p = F.planMoves(planIn());
  assert.deepEqual(kinds(p), ['topup:below low']);
  const u = Number(p.moves[0].usd6) / 1e6; assert.ok(u > 99 && u < 101, String(u));
});

test('directPays: no ready-ETH top-up, no after-trade refill, no cross-chain move for a buffer', () => {
  assert.deepEqual(F.planMoves(planIn({ chains: { robinhood: rh({ directPays: true }) } })).moves, []);
  assert.deepEqual(F.planMoves(planIn({ chains: { robinhood: rh({ directPays: true, refill: true }) } })).moves, []);
  // W empty and no reserve here, BNB rich: nothing crosses chains to build a float W would not use
  const p = F.planMoves(planIn({ enabled: ['robinhood', 'bsc'], chains: { robinhood: rh({ directPays: true, float: 0n, reserve: 0n }), bsc: rh({ price6: 600n * F.USD, float: 0n, reserve: 500n * 10n ** 18n, directPays: true }) } }));
  assert.deepEqual(p.moves.filter((m) => m.kind === 'rebalance' || m.kind === 'topup'), []);
});

test('directPays: the sweep is the one of before (above 2 x the target only), and W\'s floor is never touched', () => {
  assert.deepEqual(F.planMoves(planIn({ chains: { robinhood: rh({ directPays: true, float: eth(150) }) } })).moves, [], '$150 in W: kept');
  const p = F.planMoves(planIn({ chains: { robinhood: rh({ directPays: true, float: eth(400) }) } }));
  assert.deepEqual(kinds(p), ['sweep:above high']);
  const u = Number(p.moves[0].usd6) / 1e6; assert.ok(u > 249 && u < 251, 'only what is above the $150 target: ' + u);
});

test('directPays: a waiting click (a market the reserve cannot buy) still tops W up for itself', () => {
  const p = F.planMoves(planIn({ chains: { robinhood: rh({ directPays: true, float: RH.gasFloor }) }, urgent: { chain: 'robinhood', usd6: D(100) } }));
  assert.ok(p.moves.some((m) => m.kind === 'topup' && m.reason === 'click'), JSON.stringify(kinds(p)));
});

test('before: R under half its gas, W able to spare it: W sends R exactly reserveGas - what R has (the tester\'s 0xe2a2, 0.0000868 ETH)', () => {
  const rN = 13_162_365_386_000n;   // R before 0xe2a2 = reserveGas - 86_837_634_614_000
  const p = F.planMoves(planIn({ chains: { robinhood: rh({ reserveNative: rN, float: eth(150) }) } }));
  const g = p.moves.find((m) => m.kind === 'gas');
  assert.ok(g && g.reason === 'reserve gas', JSON.stringify(kinds(p)));
  assert.equal(F.usd6ToNative(g.usd6, ETH, 18) > 86_000_000_000_000n, true);
});

test('gasFromWClickOnly: a routine plan never takes R\'s gas from W (motion\'s drop instead); R\'s own moves wait; a waiting click still may', () => {
  const rN = 13_162_365_386_000n;
  const p = F.planMoves(planIn({ gasFromWClickOnly: true, chains: { robinhood: rh({ reserveNative: rN, float: eth(50) }) } }));
  assert.deepEqual(p.moves, [], JSON.stringify(kinds(p)));
  assert.ok(p.skips.some((s) => s.chain === 'robinhood' && s.why === 'no-gas'));
  const c = F.planMoves(planIn({ gasFromWClickOnly: true, chains: { robinhood: rh({ reserveNative: rN, float: eth(50), directPays: true }) }, urgent: { chain: 'robinhood', usd6: D(100) } }));
  assert.deepEqual(kinds(c).slice(0, 2), ['gas:reserve gas', 'topup:click']);
});
