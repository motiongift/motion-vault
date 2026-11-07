// rel-12 commit 3 (2026-11-06): no ready-dollar move into a chain whose reserve already holds the next expected buy (the largest
// of the last 3 buys there, else the largest preset) with the click's 25 % margin.
//   node --experimental-strip-types --test test/ready-rel12-nextbuy.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
import { readyWorld } from './fixtures/ready-world.mjs';

const NOW = 1_793_000_000_000; const RH = F.FLOAT_CFG.robinhood, SO = F.FLOAT_CFG.sol;
const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const plan = (sol) => F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), enabled: ['robinhood', 'sol'], walletUsd6: F.usd6(1000), movedToday6: 0n, feesToday6: 0n, estFee6: () => F.usd6(0.05), ready: { feesDay6: 0n, from: ['robinhood'] },
  chains: { robinhood: cs({ price6: 4000n * F.USD, float: RH.gasFloor + 20_000_000_000_000_000n, reserveNative: RH.reserveGas, reserve: 900n * F.USD }), sol: cs({ price6: 100n * F.USD, float: SO.gasFloor + 800_000_000n, reserveNative: SO.reserveGas, traded: true, readyOk: true, directPays: true, ...sol }) } }).moves.filter((m) => m.ready);   // directPays: rel-10's live setting (no W buffer)

test('nextBuy6: the largest of the last 3 buys, else the largest preset, else $10', () => {
  assert.equal(F.nextBuy6([F.usd6(250)], [F.usd6(100), F.usd6(20), F.usd6(25), F.usd6(30)]), F.usd6(30));
  assert.equal(F.nextBuy6([F.usd6(50), F.usd6(250)], []), F.usd6(250));
  assert.equal(F.nextBuy6([], []), F.READY.min6);
});

test('planner: presets up to $250, buys of $20-$30 — $40 in the reserve is enough (before: under 60 % of $250, a $210 move)', () => {
  const sol = { presets6: [F.usd6(250)], buys6: [F.usd6(20), F.usd6(25), F.usd6(30)] };
  assert.deepEqual(plan({ ...sol, reserve: F.usd6(40) }), [], '$40 >= 1.25 x $30');
  assert.deepEqual(plan({ ...sol, reserve: F.usd6(37.5) }), [], 'exactly the margin');
  const m = plan({ ...sol, reserve: F.usd6(37) });
  assert.equal(m.length, 1); assert.equal(m[0].usd6, F.usd6(250 - 37), 'under it: filled to the ready size, as before');
  // a user who buys his preset: unchanged (the 60 % rule decides first)
  assert.equal(plan({ presets6: [F.usd6(50)], buys6: [F.usd6(50)], reserve: F.usd6(40) }).length, 1, '$40 < 60 % of $75 and < 1.25 x $50');
});

test('engine: BNB holds $40, the last buys there were $20-$30 — no quote is even asked; empty, it is filled', async () => {
  const wd = readyWorld({ preset: 250, buys: [20, 25, 30] }); await wd.on(); wd.tradedBsc(); wd.bscSnap(40);
  await wd.tick();
  assert.equal(wd.relay.bodies.length, 0); assert.equal(wd.ch.txs.length, 0);
  wd.advance(60_000); wd.bscSnap(0); await wd.tick();
  assert.equal(wd.ch.deposits.length, 1);
});
