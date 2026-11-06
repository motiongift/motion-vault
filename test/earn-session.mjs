// r3 (owner 2026-11-03 «лочить на 8 часов / 11 часов пока ночь идёт»): Earn in timed sessions — the end brings everything back by
// itself (the switch-off's path, its budget and its stops), also when the device was offline at the end; nothing is locked during
// a session; sessions replace each other; a clock that jumps back ends one. Mocked chain only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarn } from '../src/earnEngine.ts';
import { EARN, earnArgs } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc, assetsOfR } from './fixtures/earn-world.mjs';

const SIZES = [10n * USD, 25n * USD];
const H = 3_600_000;
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
const on = (e, hours, o = {}) => e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, ...(hours != null ? { hours } : {}), ...o });

test('session: 8 h — deposits while it runs; at its end everything comes back by itself (the switch-off\'s path); nothing new goes in after', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  const r = await on(e, 8);
  assert.match(wd.asks.at(-1).html, /This session ends at .*Nothing is locked/);
  assert.equal(r.earn.session.until, wd.clock.t + 8 * H); assert.equal(r.earn.session.ended, false);
  assert.equal((await tick(wd, e)).step, 'deposit');
  wd.clock.t += 4 * H; assert.notEqual((await tick(wd, e)).step, 'withdraw', 'mid-session: it stays');
  wd.clock.t += 4 * H + 60_000;
  const end = await tick(wd, e);
  assert.equal(end.step, 'withdraw'); assert.equal(end.why, 'exit'); assert.equal(assetsOfR(wd), 0n);
  assert.equal(e.account().session.ended, true);
  wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 500_000_000n);
  for (let i = 0; i < 3; i++) { wd.clock.t += EARN.gapMs + 1; assert.equal((await tick(wd, e)).step, 'none'); }
  assert.equal(e.wants(wd.wallet), false, 'after the end nothing is read any more');
});

test('session: the device offline at the end — the first tick after it brings the money back', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 11); await tick(wd, e);
  wd.clock.t += 20 * H;   // the laptop slept through the end
  assert.equal(e.wants(wd.wallet), true);
  const r = await tick(wd, e); assert.equal(r.step, 'withdraw'); assert.equal(assetsOfR(wd), 0n);
});

test('session: nothing is locked — a buy above the buffer withdraws during the session; "Withdraw" ends it early', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 8); await tick(wd, e);
  wd.clock.t += H;
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: wd.st.usdg.get(lc(wd.R)), wReady6: 0n });
  assert.ok(c.usd > 0, JSON.stringify(c));
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(assetsOfR(wd), 0n, JSON.stringify(off)); assert.equal(e.account().session, undefined);
});

test('session: overlapping — a LIVE session is only SHORTENED without a dialog (r5); any other start is confirmed in the vault (no 2FA on a valid permission); new networks or a stop get the full dialog; a network dropped comes back', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 8, { chains: ['robinhood', 'bsc'] }); const asks = wd.asks.length;
  await tick(wd, e);
  wd.clock.t += 2 * H;
  // r5 (re-review X1): shortening a live session asks nothing; extending it is the short vault confirmation (no 2FA)
  await on(e, 3, { chains: ['robinhood', 'bsc'] }); assert.equal(wd.asks.length, asks, 'shorter: no dialog');
  const r = await on(e, 11, { chains: ['robinhood', 'bsc'] });
  assert.equal(wd.asks.length, asks + 1, 'longer: confirmed'); assert.equal(r.earn.session.until, wd.clock.t + 11 * H);
  // only Robinhood now (other networks than the live session's): a start — the short vault confirmation (r4 S1), no 2FA; BNB is
  // dropped (its money comes back in its own frame: its exit is set)
  const g0 = wd.gates();
  await on(e, 6, { chains: ['robinhood'] });
  assert.equal(wd.asks.length, asks + 2); assert.equal(wd.gates(), g0, 'no 2FA'); assert.match(wd.asks.at(-1).html, /90 days/); assert.equal(e.account().chains.bsc.exit, true);
  // Solana is new: the full dialog (2FA)
  await on(e, 6, { chains: ['robinhood', 'sol'] }); assert.equal(wd.asks.length, asks + 3); assert.equal(wd.gates(), g0 + 1);
  // a stop pending: the full dialog (it lists the stop)
  wd.store.set('trenches.earn.v2.vault.robinhood', JSON.stringify({ pause: { cls: 'riskOff', why: 'the vault has a gate set', at: 1 } }));
  await on(e, 6, { chains: ['robinhood', 'sol'] }); assert.equal(wd.asks.length, asks + 4); assert.match(wd.asks.at(-1).html, /gate set/);
});

test('session: the wall clock — a jump back of more than 10 min ends it (the money comes back); a small one does not; at most 24 h', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 8); await tick(wd, e);
  wd.clock.t -= 2 * 60_000; assert.notEqual((await tick(wd, e)).step, 'withdraw', 'NTP-size drift: still on');
  wd.clock.t -= H; const r = await tick(wd, e);
  assert.equal(r.step, 'withdraw', 'the clock went back an hour: the session ends, conservatively ' + JSON.stringify(r));
  assert.throws(() => earnArgs({ walletId: 'w1', action: 'on', hours: 25 }), /hours/);
  assert.throws(() => earnArgs({ walletId: 'w1', action: 'on', hours: 0.5 }), /hours/);
  assert.throws(() => earnArgs({ walletId: 'w1', action: 'off', hours: 8 }), /hours/);
  assert.equal(earnArgs({ walletId: 'w1', action: 'on', hours: 7.51 }).hours, 451 / 60);
});

test('session: a hard stop holds the end\'s exit too (only the user\'s own withdraw moves money then); "until I turn it off" never ends', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 8); await tick(wd, e);
  wd.st.revertOnChain = 'withdraw'; wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  assert.equal((await tick(wd, e)).cls, 'hard');
  wd.clock.t += 9 * H; const n = wd.st.txs.length;
  await tick(wd, e); assert.equal(wd.st.txs.length, n, 'nothing automatic after a hard stop, even at the session end');
  const w2 = makeEarnWorld(); const e2 = createEarn(w2.earnDeps);
  const r = await on(e2, null); assert.equal(r.earn.session.until, null);
  await tick(w2, e2); w2.clock.t += 30 * H; assert.notEqual((await tick(w2, e2)).step, 'withdraw');
});

// ══ r4: the re-review of r3 (B:\tmp\earn-review\review-r3.txt) — S1 / S2 pass the safe way ══
const shares = (wd) => wd.st.shares.get(lc(wd.R)) ?? 0n;
test('r4 S1: after a session ENDED, a new one is confirmed in the vault (no 2FA on the valid permission): declined → nothing goes in; accepted → it runs', async () => {
  const wd = makeEarnWorld(); const e = createEarn({ ...wd.earnDeps, ask: async (a) => { wd.asks.push(a); return answer; } });
  let answer = true;
  await on(e, 1); const asks0 = wd.asks.length, gates0 = wd.gates();
  await tick(wd, e); assert.ok(shares(wd) > 0n);
  wd.clock.t += 61 * 60_000; for (let i = 0; i < 3; i++) { await tick(wd, e); wd.clock.t += 60_000; }
  assert.equal(shares(wd), 0n);
  wd.clock.t += 3 * H;
  answer = false;
  await assert.rejects(on(e, 24), /Cancelled/);
  assert.equal(wd.asks.length - asks0, 1, 'S1 (reviewer: 0 dialogs)'); assert.equal(wd.gates() - gates0, 0, 'no 2FA: the permission is valid and unchanged');
  const html = wd.asks.at(-1).html;
  assert.match(html, /Up to \$1,000\.00 of your USD balance/); assert.match(html, /Robinhood Chain · Morpho/); assert.match(html, /valid until .* \(90 days\)/); assert.match(html, /comes back to your USD balance by itself on /);
  await tick(wd, e); assert.equal(shares(wd), 0n, 'declined: nothing goes in');
  answer = true; await on(e, 24); wd.clock.t += EARN.gapMs + 1; await tick(wd, e); assert.ok(shares(wd) > 0n);
  // the full "on" dialog says the 90-day reuse
  const w2 = makeEarnWorld(); const e2 = createEarn(w2.earnDeps); await on(e2, 8);
  assert.match(w2.asks.at(-1).html, /valid for 90 days .* a new session asks only a short confirmation here, without 2FA/);
});

test('r4 S2: the session end is latched — a clock stepped back after it never re-opens it; only a new switch-on does', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 1); await tick(wd, e); const s0 = shares(wd); assert.ok(s0 > 0n);
  wd.clock.t += 60 * 60_000 + 30_000; await tick(wd, e); const s1 = shares(wd); assert.ok(s1 < s0);
  wd.clock.t -= 5 * 60_000;
  const r = await tick(wd, e);
  assert.ok(shares(wd) <= s1, 'S2 (reviewer: deposited again) ' + JSON.stringify(r)); assert.equal(e.account().session.ended, true);
  for (let i = 0; i < 3; i++) { wd.clock.t += EARN.gapMs + 1; await tick(wd, e); } assert.ok(shares(wd) <= s1);
  await on(e, 2); assert.equal(e.account().session.ended, false, 'a new start clears it');
});

test('r4: the dialog\'s end time carries its date; a session ended under a hard stop says it is held (not "coming back")', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await on(e, 24);
  const end = new Date(wd.clock.t + 24 * H).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  assert.ok(wd.asks.at(-1).html.includes(end), 'the end with its date: ' + end);
  await tick(wd, e);
  wd.st.revertOnChain = 'withdraw'; wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000; await tick(wd, e);
  wd.clock.t += 25 * H; await tick(wd, e);
  const s = e.account().session; assert.equal(s.ended, true); assert.equal(s.held, true);
});
