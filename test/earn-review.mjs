// r2: one test per finding of the independent review (local earn-review/review.txt), and the reviewer's own reproductions R1, R2,
// R3, R5, R6 (local earn-review/tests/review-earn.mjs) — each now passing THE SAFE WAY (the reviewer's assertions inverted where
// they asserted the bug). Mocked chains only (test/fixtures/earn-world*.mjs): throwaway keys, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEarn } from '../src/earnEngine.ts';
import { EARN, earnPlan, EARN_WORDS } from '../src/earnCore.ts';
import { AAVE_BSC, aaveDeltaOk } from '../src/earnAave.ts';
import { KAMINO_SOL, KAMINO_DISC, kRedeemFloor } from '../src/earnKamino.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, CFG, lc, assetsOfR } from './fixtures/earn-world.mjs';
import { makeAaveWorld, makeKaminoWorld } from './fixtures/earn-world2.mjs';

const SIZES = [10n * USD, 25n * USD];
const sel = (tx) => String(tx.data).slice(0, 10);
const isWd = (t) => sel(t) === '0xb460af94' || sel(t) === '0xba087652';
const reverted = (wd) => wd.st.txs.filter((t) => t.status === 'reverted' && isWd(t)).length;
async function earnOn(o = {}, extra = {}) { const wd = makeEarnWorld(o); const e = createEarn({ ...wd.earnDeps, ...extra }); await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); return { wd, e }; }
const tick = (wd, e, floatOn = true) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn });
const src = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

// ══ HIGH ══
test('H1 / R1: a switch-off whose withdrawal simulates but reverts on chain is NOT re-sent: one revert, then a hard stop; the user may retry within the day budget', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  assert.ok((wd.st.shares.get(lc(wd.R)) ?? 0n) > 0n);
  wd.st.revertOnChain = 'withdraw';
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.match(off.why.join(' '), /reverted/);
  for (let i = 0; i < 40; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  assert.equal(reverted(wd), 1, 'R1 (reviewer: 21 in 40 ticks): exactly the one the user started');
  assert.equal(e.status(wd.wallet).cls, 'hard');
  // the user's own retry (the switch-off again): allowed, counted in the day's budget; past it, nothing is sent
  for (let i = 0; i < EARN.exitPerDay + 3; i++) await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(reverted(wd), EARN.exitPerDay, 'the user\'s retries stop at EARN.exitPerDay a day');
  const last = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.match(last.why.join(' '), /used up/);
});

test('H1: the automatic switch-off backs off and doubles (a step that keeps failing is not tried every tick); its reads back off too', async () => {
  const wd = makeEarnWorld(); let gasHigh = false; const gp0 = wd.earnDeps.evm.gasPrice;
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, gasPrice: async () => (gasHigh ? 10n ** 12n : gp0()) } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  gasHigh = true;   // every withdrawal now waits ("gas is far above normal") — a refusal, not an anomaly
  e.stop();         // the USD balance went off elsewhere: the automatic switch-off
  for (let i = 0; i < 120; i++) { wd.clock.t += 60_000; await tick(wd, e, false); }
  const tries = wd.events.filter((x) => x.earn === 'withdraw' && x.state === 'deferred').length;
  assert.equal(wd.st.txs.filter(isWd).length, 0, 'nothing sent');
  assert.ok(tries >= 3 && tries <= 5, '10, 20, 40, 80 min apart over two hours: ' + tries);
  // a venue that pays nothing: its probe runs every 5 min, not every tick (read-only, still not one per tick)
  gasHigh = false; wd.st.liquidity = 0n; let calls = 0; const call0 = wd.earnDeps.evm.call;
  const e2 = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, call: async (tx, now) => { if (isWd(tx)) calls += 1; return call0(tx, now); } } });
  for (let i = 0; i < 60; i++) { wd.clock.t += 60_000; await tick(wd, e2, false); }
  assert.ok(calls <= 4 * 14, 'probes: ' + calls);
  assert.equal(earnPlan({ on: false, exit: true, paused: false, exitToday: EARN.exitPerDay, liquid6: 0n, assets6: 10n * USD, redeemable6: 10n * USD, buffer6: 0n, capRoom6: 0n, dayIn6: 0n, txToday: 0, lastDepositAt: 0, lastWithdrawAt: 0, backoffUntil: 0, gasOk: true, geoOk: true, now: 1e12 }).why, 'limit-exit');
  assert.equal(earnPlan({ on: false, exit: true, paused: true, liquid6: 0n, assets6: 10n * USD, redeemable6: 10n * USD, buffer6: 0n, capRoom6: 0n, dayIn6: 0n, txToday: 0, lastDepositAt: 0, lastWithdrawAt: 0, backoffUntil: 0, gasOk: true, geoOk: true, now: 1e12 }).why, 'paused', 'a hard stop holds the switch-off too');
});

test('M8 / R2: after a hard stop neither a lapsed 90-day grant nor a remote stop() withdraws by itself', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.st.revertOnChain = 'withdraw';
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  const r = await tick(wd, e); assert.match(String(r.paused), /reverted/);
  const before = reverted(wd);
  wd.clock.t += 91 * 86_400_000;
  for (let i = 0; i < 6; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  e.stop();
  for (let i = 0; i < 6; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  assert.equal(reverted(wd) - before, 0, 'R2 (reviewer: ≥ 1): nothing automatic after the stop');
  assert.equal(wd.st.txs.length, wd.st.txs.length);
});

test('H2 / R6: two devices, Earn on on both, the user turns it OFF on device A: device B never deposits again (it saw A\'s moves: passive)', async () => {
  const wd = makeEarnWorld();
  const storeB = new Map();
  const depsB = { ...wd.earnDeps, store: { get: (k) => storeB.get(k) ?? null, set: (k, v) => storeB.set(k, v), del: (k) => storeB.delete(k) } };
  const A = createEarn(wd.earnDeps), B = createEarn(depsB);
  await A.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await B.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await A.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  await A.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  let deposits = 0;
  for (let i = 0; i < 60; i++) {
    wd.clock.t += 60_000;
    const rb = await B.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true }); if (rb.step === 'deposit') deposits++;
    await A.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  }
  assert.equal(deposits, 0, 'R6 (reviewer: ≥ 1)');
  assert.equal(wd.st.shares.get(lc(wd.R)) ?? 0n, 0n, 'A\'s switch-off holds');
  assert.equal(B.status(wd.wallet, 'robinhood').foreign, true); assert.equal(B.account().foreign, true);
  assert.match(B.account().stops.join(' '), /another device/);
  // the copy says Earn is one device's
  assert.match(EARN_WORDS.en.device, /one device/);
});

test('H2: never here before and money is already in Earn → passive; turning it on HERE takes over, and the other device goes passive once it sees this one\'s deposit', async () => {
  const wd = makeEarnWorld();
  const storeB = new Map();
  const depsB = { ...wd.earnDeps, store: { get: (k) => storeB.get(k) ?? null, set: (k, v) => storeB.set(k, v), del: (k) => storeB.delete(k) } };
  const A = createEarn(wd.earnDeps);
  await A.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await A.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  // device B: a grant written without this device ever seeing the wallet (an older device's state, a reset of its records)
  const B = createEarn(depsB);
  await B.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  for (const k of [...storeB.keys()]) if (k.startsWith('trenches.earn.v2.w.')) storeB.delete(k);
  wd.clock.t += EARN.gapMs + 1; wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 300_000_000n);
  const rb = await B.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.notEqual(rb.step, 'deposit'); assert.equal(B.status(wd.wallet, 'robinhood').foreign, true);
  assert.equal(B.status(wd.wallet, 'robinhood').earned, null, 'what went in is not known on B');
  // the user turns it on on B: B takes over (the dialog lists the stop it clears), deposits; A sees B's deposit and goes passive
  await B.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.match(wd.asks.at(-1).html, /did not put there/);
  wd.clock.t += EARN.gapMs + 1;
  assert.equal((await B.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).step, 'deposit');
  wd.clock.t += EARN.gapMs + 1; wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 300_000_000n);
  const ra = await A.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.equal(ra.why, 'another-device', JSON.stringify(ra)); assert.equal(A.status(wd.wallet, 'robinhood').foreign, true);
});

test('H2 on BNB and Solana: the Pool\'s Supply / Withdraw events and the signatures on R\'s cToken account name another device', async () => {
  const wa = makeAaveWorld(); const A = createEarn(wa.earnDeps);
  const storeB = new Map(); const B = createEarn({ ...wa.earnDeps, store: { get: (k) => storeB.get(k) ?? null, set: (k, v) => storeB.set(k, v), del: (k) => storeB.delete(k) } });
  await A.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await B.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await A.tick(wa.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).step, 'deposit');
  wa.clock.t += EARN.gapMs + 1; wa.st.usdc.set(lc(wa.R), (wa.st.usdc.get(lc(wa.R)) ?? 0n) + 300n * 10n ** 18n);
  assert.equal((await B.tick(wa.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).why, 'another-device');
  const wk = makeKaminoWorld(); const KA = createEarn(wk.earnDeps);
  const storeC = new Map(); const KB = createEarn({ ...wk.earnDeps, store: { get: (k) => storeC.get(k) ?? null, set: (k, v) => storeC.set(k, v), del: (k) => storeC.delete(k) } });
  await KA.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await KB.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await KA.tick(wk.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).step, 'deposit');
  wk.clock.t += EARN.gapMs + 1; wk.st.usdc += 300_000_000n;
  assert.equal((await KB.tick(wk.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).why, 'another-device');
  // the device's own moves never count as another device's
  wk.clock.t += EARN.gapMs + 1; wk.st.usdc += 300_000_000n;
  assert.equal((await KA.tick(wk.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).step, 'deposit');
});

test('H3: a Kamino Reserve this build cannot parse — a hard stop that says it needs an update; the user\'s switch-off still takes everything out (pinned accounts, R\'s own token accounts, the simulation decides)', async () => {
  const wk = makeKaminoWorld();
  let broken = false; const acc0 = wk.earnDeps.sol.accounts;
  const accounts = async (addrs, now) => { const r = await acc0(addrs, now); return addrs.map((a, i) => (broken && a === KAMINO_SOL.reserve ? { ...r[i], data: new Uint8Array(9000) } : r[i])); };
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, accounts } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wk, e)).step, 'deposit');
  const c0 = wk.st.c; assert.ok(c0 > 0n);
  broken = true; wk.clock.t += 60_000;
  const r = await tick(wk, e);
  assert.equal(r.cls, 'hard'); const st = e.status(wk.wallet, 'sol'); assert.equal(st.update, true, 'the app says: this needs an app update');
  const sent = wk.st.sent.length;
  for (let i = 0; i < 5; i++) { wk.clock.t += 60_000; await tick(wk, e); }
  assert.equal(wk.st.sent.length, sent, 'nothing automatic');
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(wk.st.c, 0n, 'every cToken redeemed: ' + JSON.stringify(off));
  const last = wk.st.sent.at(-1).ixs; assert.deepEqual(Array.from(last[2].data.subarray(0, 8)), KAMINO_DISC.redeem);
  assert.equal(last[1].keys[5][0], KAMINO_SOL.scope, 'the pinned oracle');
  assert.ok(wk.st.usdc >= 499_000_000n, 'the money is back in R');
  // no rate ever read on this device: the floor is 0 → no blind redeem
  assert.equal(kRedeemFloor(10n ** 9n, 0n), 0n);
});

test('H4: one step per wallet × chain is held to its end; a step past EARN.stepMs sends nothing more; no step starts beside an open transaction', async () => {
  // (a) the vault's lock is never let go early (source: no 45 s race in the Earn lock)
  const web = src('webEngine.ts'); const blk = web.slice(web.indexOf('// one Earn step per wallet × chain across this vault\'s tabs'), web.indexOf('// the server\'s geo answer'));
  assert.ok(blk.length > 100 && !/45_000/.test(blk) && !/Promise\.race/.test(blk), 'the Earn lock has no cap');
  // (b) a step whose approval landed after 130 s: the deposit is not sent in that step (the left-over allowance is used next tick)
  const wd = makeEarnWorld(); let slow = true; const rc0 = wd.earnDeps.evm.receipt;
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, receipt: async (h) => { const tx = wd.st.txs.find((t) => t.hash === h); if (slow && tx && sel(tx) === '0x095ea7b3') { slow = false; wd.clock.t += 130_000; } return rc0(h); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  assert.deepEqual(wd.st.txs.map(sel), ['0x095ea7b3'], 'only the approval: the step ran out of time');
  wd.clock.t += 60_000;
  assert.equal((await tick(wd, e)).step, 'deposit');
  assert.deepEqual(wd.st.txs.map(sel), ['0x095ea7b3', '0x6e553f65'], 'the left-over exact allowance is used, never a second approval');
  // (c) an open transaction (its answer lost): a click sends nothing beside it
  const w2 = makeEarnWorld({ lose: 2 }); const e2 = createEarn(w2.earnDeps);
  await e2.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(w2, e2);
  const n = w2.st.txs.length;
  const c = await e2.beforeClick(w2.wallet, { need6: 400n * USD, liquidRaw: 10_000_000n, wReady6: 0n });
  assert.ok(c === null || /still landing|landing/.test(String(c.why)), JSON.stringify(c)); assert.equal(w2.st.txs.length, n);
});

// ══ MEDIUM ══
test('M1 / R5: ONE monitor answer with a pause does nothing; two in a row = risk-off; a clean answer clears it (the engine\'s own findings stay)', async () => {
  const wd = makeEarnWorld();
  let flag = null;
  const e = createEarn({ ...wd.earnDeps, monitor: async () => ({ robinhood: flag ? { pause: flag } : {} }) });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  const sh0 = wd.st.shares.get(lc(wd.R)) ?? 0n; assert.ok(sh0 > 0n);
  flag = 'a node returned 0x for getReserveData'; wd.clock.t += 61_000; await tick(wd, e);
  flag = null;
  for (let i = 0; i < 30; i++) { wd.clock.t += 61_000; wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 50_000_000n); await tick(wd, e); }
  assert.ok((wd.st.shares.get(lc(wd.R)) ?? 0n) >= sh0, 'R5 (reviewer: everything withdrawn)');
  assert.notEqual(e.status(wd.wallet, 'robinhood').cls, 'riskOff');
  // two in a row act; the flag gone, the monitor's pause goes too
  flag = 'liquidity under the floor'; wd.clock.t += 61_000; await tick(wd, e); wd.clock.t += 61_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet, 'robinhood').cls, 'riskOff');
  flag = null; wd.clock.t += 61_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet, 'robinhood').paused, undefined);
  // the engine's own finding (a gate) is sticky: a clean monitor does not clear it
  wd.st.gates.sendSharesGate = '0x9999999999999999999999999999999999999999'; wd.clock.t += 61_000; await tick(wd, e);
  wd.st.gates.sendSharesGate = '0x0000000000000000000000000000000000000000'; wd.clock.t += 61_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet, 'robinhood').cls, 'riskOff');
});

test('M2 / R3: a deposit whose landed receipt fails the outcome check is a hard stop AND "Earned" is unknown (never the deposit as yield)', async () => {
  const { wd, e } = await earnOn({ evil: 'noEvent' });
  const r = await tick(wd, e);
  for (let i = 0; i < 3; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  const s = e.status(wd.wallet, 'robinhood');
  assert.equal(r.cls, 'hard'); assert.ok(s.usd > 0);
  assert.equal(s.earned, null, 'R3 (reviewer: Earned ≈ the deposit)');
});

test('M2: a position read that lags behind the receipt is read again — no stop; the principal comes from the events', async () => {
  const wd = makeEarnWorld(); let lag = 2;
  const multi0 = wd.earnDeps.evm.multi;
  const balOfR = '0x70a08231' + lc(wd.R).slice(2).padStart(64, '0');
  const multi = async (calls) => { const r = await multi0(calls); if (lag > 0 && calls.length === 1 && lc(calls[0].to) === lc(CFG.vault) && lc(calls[0].data) === balOfR) { lag -= 1; return [('0x' + '0'.repeat(64))]; } return r; };
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, multi } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wd, e)).step, 'deposit');
  const s = e.status(wd.wallet, 'robinhood');
  assert.equal(s.cls, undefined, 'no stop'); assert.ok(s.earned != null && Math.abs(s.earned) < 0.01, JSON.stringify(s));
  // aaveDeltaOk: a first supply is not judged with a 2-wei slack (interest between the receipt and the read)
  assert.equal(aaveDeltaOk(0n, 425n * 10n ** 18n + 10n ** 12n, 425n * 10n ** 18n, 'in'), true);
});

test('M3: a click reads the venue once, simulates once, never re-reads Earn after it, and never waits on the code / impl checks', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  let batches = 0, codes = 0, slots = 0; const sims0 = wd.st.sims;
  const e2 = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, multi: async (c, now) => { if (c.length === 12) batches += 1; return wd.earnDeps.evm.multi(c, now); }, codeHash: async () => { codes += 1; return CFG.codeHash; }, storageAt: async (a, s) => { slots += 1; return wd.earnDeps.evm.storageAt(a, s); } } });
  const c = await e2.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: wd.st.usdg.get(lc(wd.R)), wReady6: 0n });
  assert.ok(c.usd > 0, JSON.stringify(c));
  assert.equal(batches, 1, 'one read of the venue'); assert.equal(codes + slots, 0, 'no code / implementation read on the click (it uses the last one)');
  assert.ok(wd.st.sims - sims0 <= 3, 'previewWithdraw, the withdraw simulation, the gas estimate: ' + (wd.st.sims - sims0));
  // the cached snapshot follows the booked step at once (no re-read)
  assert.ok(Math.abs(e2.status(wd.wallet, 'robinhood').usd - (425 - c.usd)) < 0.02);
  assert.match(src('floatEngine.ts'), /fastly\(\(\) => deps\.earn!\.beforeClick\(w, earnAsk\)\)/);
});

test('M4: Earn\'s tick runs only for a wallet Earn wants (the switch, an exit, a position, an open step): without Earn nothing is read', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  assert.equal(e.wants(wd.wallet), false);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal(e.wants(wd.wallet), true);
  await tick(wd, e); await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(e.wants(wd.wallet), false, 'off and nothing left');
  const fe = src('floatEngine.ts');
  assert.match(fe, /if \(deps\.earn && deps\.earn\.wants\(w\) && !urgent && !refill && !started/);
  assert.match(fe, /if \(deps\.earn && c && deps\.earn\.wants\(w\) && !urgent && !clickBusy\(\) && quietOn\(c\)\)/);
});

test('M5: the view states the liquid part (liquidUsd) and what a click on Earn\'s own chain may take out first (earnReadyUsd; never after a hard stop) apart from the total', () => {
  const fe = src('floatEngine.ts');
  assert.match(fe, /liquidUsd: Number\(liq6\) \/ 1e6, earnUsd: Number\(earn6\) \/ 1e6, earnReadyUsd: Number\(earnReady6\) \/ 1e6/);
  assert.match(fe, /earnReady6 = er && earn6 > 0n && er\.cls !== 'hard' && !er\.landing && !er\.verifying/);
  // (the app's funding checks: tests/usd-earn.test.ts "M5 …" — the liquid part anywhere, Earn's ready part on its own chain only)
});

test('M6: the status says what is true — blocked (the venue pays nothing now), needs an update, another device, what came out while the USD balance was off', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.st.liquidity = 0n; wd.clock.t += 61_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet, 'robinhood').blocked, true);
  wd.st.liquidity = 10n ** 15n;
  // the USD balance went off elsewhere (stop): what comes out later is shown as residue until the USD balance holds it again
  // (a probe that found nothing payable is repeated after 5 min)
  e.stop(); wd.clock.t += 300_001;
  const r = await tick(wd, e, false);
  assert.equal(r.step, 'withdraw', JSON.stringify(r));
  assert.ok(e.status(wd.wallet, 'robinhood').residue > 400); assert.ok(e.account().residue > 400);
  assert.equal(e.wants(wd.wallet), true, 'the residue keeps the wallet looked at');
  wd.clock.t += 61_000; await tick(wd, e, true);
  assert.equal(e.status(wd.wallet, 'robinhood').residue, undefined);
});

test('M7: Aave pays out of the Pool\'s virtual balance (not USDC.balanceOf(aToken)); a refused simulation halves', async () => {
  const wa = makeAaveWorld({ virtual: 100n * 10n ** 18n });
  const e = createEarn(wa.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  wa.st.virtual = null; assert.equal((await tick(wa, e)).step, 'deposit');
  wa.st.virtual = 100n * 10n ** 18n;               // the Pool can pay $100 though the aToken holds $1M
  wa.st.virtualRead = 160n * 10n ** 18n;           // and one read says $160: the simulation refuses it, half ($80) goes
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  const paid = wa.st.txs.filter((t) => t.status === 'success' && sel(t) === '0x69328dec');
  assert.equal(paid.length, 1, JSON.stringify(off)); assert.ok(off.left > 340 && off.left < 350, JSON.stringify(off));
});

test('M9 (engine side) / L5: USDG or BNB USDC upgraded → nothing new goes in, withdrawals go on; Aave naming another provider → a hard stop that needs an update', async () => {
  const { wd, e } = await earnOn({ assetImpl: '0x1111111111111111111111111111111111111111' });
  const r = await tick(wd, e);
  assert.notEqual(r.step, 'deposit'); assert.equal(e.status(wd.wallet, 'robinhood').cls, 'changed'); assert.match(e.status(wd.wallet, 'robinhood').paused, /USDG/);
  const wa = makeAaveWorld(); const ea = createEarn(wa.earnDeps);
  await ea.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wa, ea)).step, 'deposit');
  wa.st.assetImpl = '0x2222222222222222222222222222222222222222'; wa.clock.t += EARN.implCheckMs + 1;
  wa.st.usdc.set(lc(wa.R), (wa.st.usdc.get(lc(wa.R)) ?? 0n) + 300n * 10n ** 18n); wa.clock.t += EARN.gapMs;
  assert.notEqual((await tick(wa, ea)).step, 'deposit'); assert.equal(ea.status(wa.wallet, 'bsc').cls, 'changed');
  wa.st.provider = '0x3333333333333333333333333333333333333333'; wa.clock.t += 61_000;
  await tick(wa, ea); const st = ea.status(wa.wallet, 'bsc'); assert.equal(st.cls, 'hard'); assert.equal(st.update, true);
  assert.equal(AAVE_BSC.assetImpl, '0xba5fe23f8a3a24bed3236f05f2fcf35fd0bf0b5c'); assert.equal(CFG.assetImpl, '0x68184c449e1a8f34fa18d289737129fd27b66f8f');
});

// ══ LOW ══
test('L2: the Solana signer takes the oracle accounts from its own read of the reserve (or the pinned set), never from the instructions it checks', () => {
  const web = src('webEngine.ts'); const chk = web.slice(web.indexOf('async function earnSolCheck'), web.indexOf('async function earnSolSimulate'));
  assert.ok(chk.includes('await earnSolOracles()') && !/refresh\.keys/.test(chk) && !/ixs\[1\]/.test(chk));
  assert.match(web, /readReserve\(acc\.data \?\? null, acc\.owner \?\? null, KAMINO_SOL\)/);
});

test('L4: the "on" dialog lists EVERY stop it clears (each chain, each wallet), not the first one', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  wd.st.revertOnChain = 'withdraw'; wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000; await tick(wd, e);
  const storeKeys = [...wd.store.keys()];
  wd.store.set('trenches.earn.v2.vault.bsc', JSON.stringify({ pause: { cls: 'riskOff', why: 'Aave paused this reserve', at: 1 } }));
  assert.equal(e.account().stops.length, 2, JSON.stringify(e.account().stops)); void storeKeys;
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const html = wd.asks.at(-1).html;
  assert.match(html, /reverted on chain/); assert.match(html, /Aave paused this reserve/);
});

test('L6: a reset that failed is due, not swallowed: the next tick sets the allowance back to 0 first', async () => {
  const wd = makeEarnWorld(); let failSim = true, failReset = true;
  const call0 = wd.earnDeps.evm.call, send0 = wd.earnDeps.evm.send;
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm,
    call: async (tx, now) => { if (failSim && sel(tx) === '0x6e553f65') throw new Error('execution reverted'); return call0(tx, now); },
    send: async (id, tx, gas) => { if (failReset && sel(tx) === '0x095ea7b3' && BigInt('0x' + tx.data.slice(74)) === 0n) throw new Error('rpc down'); return send0(id, tx, gas); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  assert.ok((wd.st.allow.get(`${lc(wd.R)}>${lc(CFG.vault)}`) ?? 0n) > 0n, 'the exact approval is still there');
  failSim = false; failReset = false; wd.clock.t += EARN.backoffMs + 1;
  // Earn off now: the due reset runs (nothing else)
  await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  assert.equal(wd.st.allow.get(`${lc(wd.R)}>${lc(CFG.vault)}`) ?? 0n, 0n);
});
