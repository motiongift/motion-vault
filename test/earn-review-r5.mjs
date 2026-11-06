// r5: the re-review of r4 (local earn-review/review-r4.txt) — the reviewer's X1, X2, X3 (tests\review-r4.mjs) passing THE SAFE WAY,
// plus the nonce rule of X2. Mocked chain only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { EARN } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc } from './fixtures/earn-world.mjs';
const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
const shares = (wd) => wd.st.shares.get(lc(wd.R)) ?? 0n;

test('X1: a live session cannot be EXTENDED silently — each extension is the short vault confirmation; declined, the confirmed end stands and the money comes back', async () => {
  const wd = makeEarnWorld(); let answer = true;
  const e = createEarn({ ...wd.earnDeps, ask: async (a) => { wd.asks.push(a); return answer; } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, hours: 1 });
  const asks0 = wd.asks.length, gates0 = wd.gates();
  await tick(wd, e); assert.ok(shares(wd) > 0n);
  answer = false;
  wd.clock.t += 59 * 60_000;
  await assert.rejects(e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, hours: 24 }), /Cancelled/);
  assert.equal(wd.asks.length - asks0, 1, 'X1 (reviewer: 0 dialogs)'); assert.equal(wd.gates() - gates0, 0, 'no 2FA');
  wd.clock.t += 2 * 60_000; for (let i = 0; i < 3; i++) { await tick(wd, e); wd.clock.t += 60_000; }
  assert.equal(shares(wd), 0n, 'the end the user confirmed came');
  // shortening stays silent
  const w2 = makeEarnWorld(); const e2 = createEarn(w2.earnDeps);
  await e2.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, hours: 8 }); const a2 = w2.asks.length;
  w2.clock.t += 60 * 60_000; await e2.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, hours: 2 });
  assert.equal(w2.asks.length, a2); assert.equal(e2.account().session.until, w2.clock.t + 2 * 3_600_000);
});

test('X2: a lost send answer, then hours of silence — the step is closed past openMs (R\'s nonce moved past it) and the user\'s own switch-off withdraws', async () => {
  const wd = makeEarnWorld({ lose: 2 }); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  wd.st.silent = true;
  for (let i = 0; i < 6; i++) { wd.clock.t += 30 * 60_000; await tick(wd, e); }
  assert.equal(e.status(wd.wallet).landing, undefined, 'closed: no node ever confirmed it, R\'s nonce moved past it');
  assert.equal(e.status(wd.wallet).earned, null, 'what went in is unknown, said'); assert.notEqual(e.status(wd.wallet).cls, 'hard');
  wd.st.silent = false;
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(shares(wd), 0n, 'X2 (reviewer: "still landing", money stays) ' + JSON.stringify(off.why));
});

test('X2: R\'s nonce has NOT moved (the step may still be pending): the background keeps following it up to an hour, but the user\'s own withdraw is never held past openMs', async () => {
  const wd = makeEarnWorld(); let once = true; const send0 = wd.earnDeps.evm.send;
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas) => { if (once && String(tx.data).startsWith('0x6e553f65')) { once = false; throw Object.assign(new Error('timeout'), { hash: keccak256(toHex('pending')) }); } return send0(id, tx, gas); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e); wd.st.silent = true;
  for (let i = 0; i < 20; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  assert.equal(e.status(wd.wallet).landing, true, 'nonce not moved: still followed (it may land)');
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.ok(!/still landing/.test((off.why || []).join(' ')), JSON.stringify(off.why));
  assert.equal(e.status(wd.wallet).landing, undefined);
  wd.clock.t += 61 * 60_000; await tick(wd, e);   // and the background closes it after an hour in any case
});

test('X3: a booked deposit whose position never reaches the expected level — closed against a fresh read after verifyMs: refills and clicks work again, "Earned" unknown, no stop', async () => {
  const wd = makeEarnWorld();
  const send0 = wd.earnDeps.evm.send; let armed = true;
  const deps = { ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas) => { const h = await send0(id, tx, gas); if (armed && String(tx.data).startsWith('0x6e553f65')) { armed = false; const s = wd.st.shares.get(lc(wd.R)); wd.st.shares.set(lc(wd.R), s / 2n); wd.st.ts -= s / 2n; } return h; } } };
  const e = createEarn(deps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  let last; for (let i = 0; i < 12; i++) { wd.clock.t += 10 * 60_000; last = await tick(wd, e); }
  const st = e.status(wd.wallet, 'robinhood');
  assert.notEqual(last.why, 'following', 'X3 (reviewer: following forever)'); assert.equal(st.verifying, undefined); assert.equal(st.earned, null); assert.notEqual(st.cls, 'hard');
  const c = await e.beforeClick(wd.wallet, { need6: 400n * USD, liquidRaw: 0n, wReady6: 0n });
  assert.ok(c && 'usd' in c && c.usd > 0, JSON.stringify(c));
});
