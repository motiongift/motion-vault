// rel-12 commit 2 (2026-11-06, owner “make it work without failures”): a ready-dollar move refused before anything was sent leaves no job, no
// event, no row in the user's history; its route backs off 10 min, 30 min, then 2 h (floatCore READY_HOLD). A move that sent
// anything stays a job with where the funds are and why (as before). rel-10's leftover "failed, never sent" rows are hidden.
//   node --experimental-strip-types --test test/ready-rel12-backoff.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
import { readyWorld, usdg, lc } from './fixtures/ready-world.mjs';

const MIN = 60_000;
test('READY_HOLD: 10 min, 30 min, then 2 h for every refusal after that; counted afresh 24 h after the last one', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(F.readyHoldMs), [10 * MIN, 30 * MIN, 120 * MIN, 120 * MIN, 120 * MIN]);
  let h = F.readyRefused({}, 'robinhood>bsc', 0, 'Every bridge refused: relay: x');
  assert.equal(h['robinhood>bsc'].n, 1);
  assert.deepEqual(F.readyHeldPairs(h, 9 * MIN), ['robinhood>bsc']); assert.deepEqual(F.readyHeldPairs(h, 10 * MIN), []);
  h = F.readyRefused(h, 'robinhood>bsc', 11 * MIN, 'again'); assert.equal(h['robinhood>bsc'].n, 2);
  assert.deepEqual(F.readyHeldPairs(h, 40 * MIN), ['robinhood>bsc']); assert.deepEqual(F.readyHeldPairs(h, 41 * MIN), []);
  h = F.readyRefused(h, 'robinhood>bsc', 11 * MIN + 25 * 3_600_000, 'a day later'); assert.equal(h['robinhood>bsc'].n, 1, 'a fresh count after 24 h');
  assert.equal(F.quietRefusal({ ready: true, state: 'failed', hashes: [] }), true);
  assert.equal(F.quietRefusal({ ready: true, state: 'failed', hashes: ['0xa'] }), false, 'an approval went out: shown');
  assert.equal(F.quietRefusal({ state: 'failed', hashes: [] }), false, 'not a ready move: shown as before');
});

test('planner: a held route plans no ready move; another donor still may', () => {
  const NOW = 1_793_000_000_000; const RH = F.FLOAT_CFG.robinhood, BS = F.FLOAT_CFG.bsc, SO = F.FLOAT_CFG.sol;
  const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
  const chains = { robinhood: cs({ price6: 4000n * F.USD, float: RH.gasFloor + 20_000_000_000_000_000n, reserveNative: RH.reserveGas, reserve: 500n * F.USD }),
    bsc: cs({ price6: 1000n * F.USD, float: BS.gasFloor + 84_000_000_000_000_000n, reserveNative: BS.reserveGas, reserve: 0n }),
    sol: cs({ price6: 100n * F.USD, float: SO.gasFloor + 800_000_000n, reserveNative: SO.reserveGas, traded: true, readyOk: true }) };
  const plan = (held, c = chains) => F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains: c, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(1000), movedToday6: 0n, feesToday6: 0n, estFee6: () => F.usd6(0.05), ready: { feesDay6: 0n, from: ['robinhood', 'bsc'], held } }).moves.filter((m) => m.ready);
  assert.equal(plan([])[0].from, 'robinhood');
  assert.deepEqual(plan(['robinhood>sol']), [], 'the only donor\'s route is held');
  const two = { ...chains, bsc: { ...chains.bsc, reserve: 300n * 10n ** 18n } };
  assert.equal(plan(['robinhood>sol'], two)[0].from, 'bsc', 'BNB\'s route to Solana is not held');
});

test('engine: Relay refuses — no job, no event, no "Moved …" row; the route waits 10 min, then 30 min, then 2 h; the next quote that fits moves and clears it', async () => {
  const wd = readyWorld({ refuse: 'No routes found' }); await wd.on(); wd.tradedBsc(); wd.bscSnap(0);
  const hold = () => JSON.parse(wd.store.get(`trenches.float.v1.readyhold.${lc(wd.W)}`) || '{}')['robinhood>bsc'];
  await wd.tick();
  assert.equal(wd.relay.bodies.length, 1, 'asked once');
  assert.deepEqual((await wd.jobs()).filter((j) => j.kind === 'rebalance'), [], 'no job in the history');
  assert.ok(!wd.events.some((e) => e.step === 'rebalance'), 'no event: ' + JSON.stringify(wd.events.filter((e) => e.step === 'rebalance')));
  assert.equal(hold().n, 1); assert.match(hold().why, /Every bridge refused/);
  const st = await wd.f.status({ walletId: 'w1' });
  assert.ok(!st.jobs.some((j) => j.kind === 'rebalance'), 'the status shows nothing either');
  // ticks inside the hold ask nothing
  for (const ms of [MIN, 5 * MIN, 3 * MIN]) { wd.advance(ms); wd.bscSnap(0); await wd.tick(); }
  assert.equal(wd.relay.bodies.length, 1, 'held for 10 min');
  wd.advance(2 * MIN); wd.bscSnap(0); await wd.tick();   // 11 min
  assert.equal(wd.relay.bodies.length, 2); assert.equal(hold().n, 2);
  wd.advance(29 * MIN); wd.bscSnap(0); await wd.tick(); assert.equal(wd.relay.bodies.length, 2, 'the second hold is 30 min');
  wd.advance(2 * MIN); wd.bscSnap(0); await wd.tick(); assert.equal(wd.relay.bodies.length, 3); assert.equal(hold().n, 3);
  wd.advance(100 * MIN); wd.bscSnap(0); await wd.tick(); assert.equal(wd.relay.bodies.length, 3, 'then 2 h');
  // Relay quotes again: the move goes, the job shows, the hold is gone
  wd.relay.refuse = null;
  wd.advance(25 * MIN); wd.bscSnap(0); await wd.tick();
  assert.equal(wd.ch.deposits.length, 1); assert.equal(wd.ch.deposits[0].amount, usdg(150));
  const j = (await wd.jobs()).filter((x) => x.kind === 'rebalance');
  assert.equal(j.length, 1); assert.equal(j[0].state, 'relaying');
  assert.equal(hold(), undefined, 'cleared by a move that went');
  assert.equal(wd.ch.txs.length, 2, 'one approval, one deposit — over 2 h 40 min of refusals');
});

test('engine: a move that SENT something and then stopped stays in the history with why (the approval landed, the deposit reverted in simulation)', async () => {
  const wd = readyWorld(); await wd.on(); wd.tradedBsc(); wd.bscSnap(0);
  wd.ch.revertDeposit = true;
  await wd.tick();
  const j = (await wd.jobs()).filter((x) => x.kind === 'rebalance');
  assert.equal(j.length, 1); assert.equal(j[0].state, 'failed'); assert.equal(j[0].hashes.length, 1, 'the approval\'s hash');
  assert.match(j[0].error, /reverted/);
  assert.equal(wd.ch.deposits.length, 0, 'the dollars never left R');
  assert.ok(wd.events.some((e) => e.step === 'rebalance' && e.state === 'failed'), 'said, as before');
});

test('rel-10 leftovers: a ready move stored as failed with no hash is not shown; one with a hash is', async () => {
  const wd = readyWorld(); await wd.on();
  const at = wd.T.t - 3_600_000;
  const base = { walletId: 'w1', kind: 'rebalance', chain: 'bsc', from: 'robinhood', usd6: String(F.usd6(150)), fee6: '0', at, updatedAt: at, ready: true, reason: F.READY.reason };
  wd.store.set(`trenches.float.v1.jobs.robinhood.${lc(wd.W)}`, JSON.stringify([
    { ...base, id: 'old1', state: 'failed', hashes: [], error: 'Every bridge refused: relay: The quote is below the amount minus fees and slippage' },
    { ...base, id: 'old2', state: 'failed', hashes: ['0x' + 'ab'.repeat(32)], error: 'The approval did not land' },
  ]));
  const ids = (await wd.jobs()).map((j) => j.id);
  assert.deepEqual(ids, ['old2']);
  assert.deepEqual((await wd.f.status({ walletId: 'w1' })).jobs.map((j) => j.id), ['old2']);
});
