// rel-12 commit 4 (2026-11-06; RIFF #17 "Earn on/off triggered cross-chain transfers"): the USD balance's planner sees Earn.
// R's dollars in the venue that a buy can take out count as the destination's; a donor never sends below Earn's liquid buffer;
// no cross-chain move into or out of a chain within 10 minutes of an Earn step there. Earn on / off moves nothing across chains.
//   node --experimental-strip-types --test test/ready-rel12-earn.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
import { readyWorld, lc } from './fixtures/ready-world.mjs';

const NOW = 1_793_000_000_000; const RH = F.FLOAT_CFG.robinhood, BS = F.FLOAT_CFG.bsc;
const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(100)], buys6: [F.usd6(100)], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, directPays: true, ...o });
const rh = (o = {}) => cs({ price6: 4000n * F.USD, float: RH.gasFloor + 20_000_000_000_000_000n, reserveNative: RH.reserveGas, reserve: 500n * F.USD, ...o });
const bsc = (usd, o = {}) => cs({ price6: 1000n * F.USD, float: BS.gasFloor + 84_000_000_000_000_000n, reserveNative: BS.reserveGas, reserve: F.usd6ToStable(F.usd6(usd), 18), traded: true, readyOk: true, ...o });
const plan = (chains, o = {}) => F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc'], walletUsd6: F.usd6(1000), movedToday6: 0n, feesToday6: 0n, estFee6: () => F.usd6(0.05), ready: { feesDay6: 0n, from: ['robinhood', 'bsc'] }, ...o });
const cross = (p) => p.moves.filter((m) => m.kind === 'rebalance' || m.kind === 'cold');

test('Earn switched on at the destination: $200 on BNB becomes $25 liquid + $175 in Aave — rel-10 moved $125 in from Robinhood, rel-12 nothing', () => {
  assert.equal(cross(plan({ robinhood: rh(), bsc: bsc(200) })).length, 0, 'before Earn: $200 is enough');
  const before = cross(plan({ robinhood: rh(), bsc: bsc(25) }));   // what rel-10 saw after the deposit (liquid only)
  assert.equal(before.length, 1); assert.equal(before[0].usd6, F.usd6(125));
  assert.equal(cross(plan({ robinhood: rh(), bsc: bsc(25, { earn6: F.usd6(175), earnKeep6: F.usd6(25) }) })).length, 0, 'the $175 a buy there can take out counts');
  // switched off: the withdrawals bring the liquid part back over several ticks — the sum never moves, nothing crosses
  for (const [liq, inEarn] of [[100, 100], [175, 25], [200, 0]]) assert.equal(cross(plan({ robinhood: rh(), bsc: bsc(liq, inEarn ? { earn6: F.usd6(inEarn) } : {}) })).length, 0, `${liq}/${inEarn}`);
});

test('Earn at the donor: Robinhood keeps Earn\'s liquid buffer — a $500 reserve with $495 in its buffer gives nothing; a fresh Earn step on either side holds every cross-chain move', () => {
  assert.equal(cross(plan({ robinhood: rh(), bsc: bsc(0) }))[0].usd6, F.usd6(150), 'control');
  assert.deepEqual(cross(plan({ robinhood: rh({ earnKeep6: F.usd6(495) }), bsc: bsc(0) })), [], 'only $5 above the buffer (< $10)');
  assert.equal(cross(plan({ robinhood: rh({ earnKeep6: F.usd6(400) }), bsc: bsc(0) }))[0].usd6, F.usd6(100), 'what is above the buffer');
  assert.deepEqual(cross(plan({ robinhood: rh({ earnQuiet: true }), bsc: bsc(0) })), [], 'an Earn step on Robinhood in the last 10 min');
  assert.deepEqual(cross(plan({ robinhood: rh(), bsc: bsc(0, { earnQuiet: true }) })), [], 'an Earn step on BNB in the last 10 min');
});

test('the float\'s own rebalance (no directPays) never crosses chains for a chain whose dollars are in Earn: Earn\'s refill brings them back on that chain', () => {
  const lowW = { directPays: false, float: BS.gasFloor };   // W empty on BNB: 'below low'
  const p0 = cross(plan({ robinhood: rh(), bsc: bsc(5, { ...lowW, readyOk: false }) }, { ready: undefined }));
  assert.equal(p0.length, 1, 'rel-10: R short here, so Robinhood sends');
  const p1 = plan({ robinhood: rh(), bsc: bsc(5, { ...lowW, readyOk: false, earn6: F.usd6(195), earnKeep6: F.usd6(25) }) }, { ready: undefined });
  assert.equal(cross(p1).length, 0); assert.ok(p1.skips.some((s) => s.chain === 'bsc' && s.why === 'earn'));
});

// the engine with Earn's cached status as earnEngine.status gives it
function earnStub(rows, wants = true) {
  return { status: (w, c) => rows[c] ?? null, wants: () => wants, tick: async () => ({ ok: true, step: 'none' }), holds: () => false, account: () => ({}), stop: () => {}, clickNeeds: () => false };
}
test('engine: BNB\'s reserve is $25 liquid + $175 in Earn — no quote asked; a deposit on Robinhood 3 min ago holds the donor; 11 min later the move goes', async () => {
  const rows = { bsc: { chain: 'bsc', usd: 175, redeemable: 175, liquid: 25, buffer: 25, at: 0 } };
  const wd = readyWorld({ earn: earnStub(rows) }); await wd.on(); wd.tradedBsc(); wd.bscSnap(25);
  await wd.tick();
  assert.equal(wd.relay.bodies.length, 0); assert.equal(wd.ch.txs.length, 0);
  // Earn off on BNB: the venue paid it all back to R (liquid $200): still nothing
  rows.bsc = { chain: 'bsc', usd: 0, redeemable: 0, liquid: 200, buffer: 25, at: 0, stepAt: wd.T.t };
  wd.advance(60_000); wd.bscSnap(200); await wd.tick();
  assert.equal(wd.relay.bodies.length, 0);
  // the user spent it on BNB (empty), and Earn just deposited on Robinhood (the donor): held for 10 minutes
  rows.bsc = null; rows.robinhood = { chain: 'robinhood', usd: 300, redeemable: 300, liquid: 200, buffer: 75, at: 0, stepAt: wd.T.t - 3 * 60_000 };
  wd.advance(60_000); wd.bscSnap(0); await wd.tick();
  assert.equal(wd.relay.bodies.length, 0, 'a fresh Earn step on the donor');
  wd.advance(11 * 60_000); wd.bscSnap(0); await wd.tick();
  assert.equal(wd.ch.deposits.length, 1);
  const j = (await wd.jobs()).find((x) => x.kind === 'rebalance');
  assert.equal(j.from, 'robinhood'); assert.equal(j.chain, 'bsc');
  assert.ok(Number(j.usd6) <= 150e6, 'never more than the ready size');
});
