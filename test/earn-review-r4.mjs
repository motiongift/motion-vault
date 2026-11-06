// r4: the re-review of r3 (local earn-review/review-r3.txt) — M3-1 (silence is never a stop; only a positive reorg signal is),
// L3-3 (a click's withdrawal is re-read later for the books), L3-2 (Kamino: the landed USDC is booked), L3-1 (a signature flood:
// paged, budgeted, nothing skipped). S1 / S2: test/earn-session.mjs "r4 …". Mocked chains only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { EARN } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc } from './fixtures/earn-world.mjs';
import { makeKaminoWorld } from './fixtures/earn-world2.mjs';

const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });

test('M3-1: nodes that do not answer after a successful step are never a stop — the booked step is accepted after verifyMs; a click then withdraws', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  wd.st.silent = true;   // every receipt re-read and block read goes unanswered (429s, timeouts)
  assert.equal((await tick(wd, e)).step, 'deposit');
  assert.equal(e.status(wd.wallet).verifying, true);
  for (let i = 0; i < 12; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  const st = e.status(wd.wallet);
  assert.notEqual(st.cls, 'hard', 'reviewer: silence became a hard stop'); assert.equal(st.verifying, undefined, 'accepted');
  const c = await e.beforeClick(wd.wallet, { need6: 400n * USD, liquidRaw: 0n, wReady6: 0n });
  assert.ok(c && 'usd' in c && c.usd > 0, JSON.stringify(c));
});

test('M3-1: a sent step with no receipt — silence never stops; nodes ANSWERING "not found" for 10 min do (it never showed up)', async () => {
  const mk = () => { const wd = makeEarnWorld(); let once = true; const send0 = wd.earnDeps.evm.send;
    const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas) => { if (once && String(tx.data).startsWith('0x6e553f65')) { once = false; throw Object.assign(new Error('timeout'), { hash: keccak256(toHex('dropped')) }); } return send0(id, tx, gas); } } });
    return { wd, e }; };
  const a = mk(); await a.e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); a.wd.st.silent = true;
  await tick(a.wd, a.e);
  for (let i = 0; i < 60; i++) { a.wd.clock.t += 60_000; await tick(a.wd, a.e); }
  assert.notEqual(a.e.status(a.wd.wallet).cls, 'hard', 'an hour of silence: still followed, no stop'); assert.equal(a.e.status(a.wd.wallet).landing, true);
  const b = mk(); await b.e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(b.wd, b.e);
  for (let i = 0; i < 12; i++) { b.wd.clock.t += 60_000; await tick(b.wd, b.e); }
  assert.equal(b.e.status(b.wd.wallet).cls, 'hard'); assert.match(b.e.status(b.wd.wallet).paused, /never showed up/);
});

test('L3-3: a click\'s withdrawal is re-read by the next background tick — a reorg of it makes "Earned" unknown (no stop); one still there is done', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await tick(wd, e);
  wd.clock.t += 20 * 60_000; await tick(wd, e);
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: wd.st.usdg.get(lc(wd.R)), wReady6: 0n }); assert.ok(c.usd > 0);
  assert.ok(e.status(wd.wallet).earned != null);
  const wdTx = wd.st.txs.at(-1); wd.st.receipts.delete(wdTx.hash); wd.st.reorgSalt = 'r';
  wd.clock.t += 31_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet).earned, null, 'the click\'s booking is no longer trusted'); assert.notEqual(e.status(wd.wallet).cls, 'hard');
});

test('L3-2: Kamino — a redeem that landed less USDC than simulated is booked as it landed (and said)', async () => {
  const wk = makeKaminoWorld(); const send0 = wk.earnDeps.sol.send; let cut = false;
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, send: async (id, ixs) => { const s = await send0(id, ixs); if (cut) { cut = false; wk.st.usdc -= 3_000_000n; } return s; } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await tick(wk, e);
  cut = true; const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true }); void off;
  const row = e.history().rows.filter((r) => r.kind === 'withdraw').at(-1);
  const short = wk.events.find((x) => x.earn === 'withdraw' && x.state === 'short');
  assert.ok(short && short.landed < short.simulated, JSON.stringify(short));
  assert.equal(Number(row.usd6) / 1e6, short.landed, 'booked as it landed');
});

test('L3-1: a flood of 250 transactions listing R\'s cToken account — paged and budgeted (≤ 3 pages, ≤ 5 signer reads a tick), nothing skipped: the one R signed deep in it is found', async () => {
  const wk = makeKaminoWorld(); const e = createEarn(wk.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wk, e)).step, 'deposit');
  const other = 'OtherDev' + '9'.repeat(72); wk.st.sent.push({ ixs: [], sig: other, at: wk.clock.t + 1, signer: wk.R }); wk.st.sigs.set(other, 'confirmed');
  for (let i = 0; i < 250; i++) { const s = 'Flood' + String(i).padStart(4, '0') + 'x'.repeat(70); wk.st.sent.push({ ixs: [], sig: s, at: wk.clock.t + 2 }); wk.st.sigs.set(s, 'confirmed'); }
  wk.st.usdc += 300_000_000n;
  let found = null;
  for (let i = 0; i < 80 && !found; i++) {
    wk.clock.t += EARN.gapMs + 1; const p0 = wk.st.sigPages ?? 0, r0 = wk.st.signerReads ?? 0;
    const r = await tick(wk, e);
    assert.ok((wk.st.sigPages ?? 0) - p0 <= 3 && (wk.st.signerReads ?? 0) - r0 <= 5, 'the budget a tick');
    assert.notEqual(r.step, 'deposit', 'no deposit before the scan is through');
    if (r.why === 'another-device') found = i;
  }
  assert.ok(found != null, 'the R-signed move, oldest in the flood, was reached');
});
