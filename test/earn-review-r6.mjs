// r6: the re-review of r5 (B:\tmp\earn-review\review-r5.txt) — M5-1 (Kamino's pre-step simulation tolerates what else moved R's
// accounts; a simulation-only mismatch is retried, never a stop) and L5-1 (the signer's own nonce decides whether a silent step was
// dropped). Mocked chains only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { EARN } from '../src/earnCore.ts';
import { kaminoSimProblem } from '../src/earnKamino.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc } from './fixtures/earn-world.mjs';
import { makeKaminoWorld } from './fixtures/earn-world2.mjs';
const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });

test('M5-1: 1 micro-USDC landing in R between the read and the simulation (the fork flake) — the deposit goes ahead, no stop', async () => {
  const wk = makeKaminoWorld(); const sim0 = wk.earnDeps.sol.simulate; let drip = true;
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, simulate: async (...a) => { if (drip) { drip = false; wk.st.usdc += 1n; } return sim0(...a); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const r = await tick(wk, e);
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.notEqual(e.status(wk.wallet, 'sol').cls, 'hard');
});

test('M5-1: kUSDC dust landing in R before a redeem\'s simulation goes ahead; R\'s USDC spent elsewhere meanwhile = retried next tick, never a hard stop', async () => {
  const wk = makeKaminoWorld(); const sim0 = wk.earnDeps.sol.simulate; let mode = null;
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, simulate: async (...a) => { if (mode === 'dust') { mode = null; wk.st.c += 3n; } if (mode === 'spend') { mode = null; wk.st.usdc -= 2_000_000n; } return sim0(...a); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wk, e);
  wk.st.usdc = 1_000_000n; wk.clock.t += 61_000; mode = 'dust';
  assert.equal((await tick(wk, e)).step, 'withdraw', 'a cToken gift does not stop a redeem');
  // a deposit whose simulation sees R's USDC lower than read (the float spent some meanwhile): retried, then it goes
  wk.st.usdc += 300_000_000n; wk.clock.t += EARN.gapMs + 1; mode = 'spend';
  const r = await tick(wk, e);
  assert.match(String(r.why), /simulated: .*retried next tick/); assert.equal(r.paused, undefined); assert.notEqual(e.status(wk.wallet, 'sol').cls, 'hard');
  wk.clock.t += EARN.backoffMs + 1; assert.equal((await tick(wk, e)).step, 'deposit');
  // the pure judgement
  assert.equal(kaminoSimProblem('deposit', { usdc: 100n, c: 0n }, { usdc: 1n, c: 9n }, 100n, 9n), null, 'an inflow of 1 tolerated');
  assert.match(kaminoSimProblem('deposit', { usdc: 100n, c: 0n }, { usdc: 0n, c: 9n }, 99n, 9n), /more than the amount/);
  assert.match(kaminoSimProblem('redeem', { usdc: 0n, c: 10n }, { usdc: 5n, c: 0n }, 10n, 6n), /pay less/);
});

test('L5-1: every Earn send records the nonce the signer used — a click\'s withdrawal too', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps); const send0 = wd.earnDeps.evm.send; let lose = false;
  const e2 = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas, signed) => { if (lose) { lose = false; signed?.(42); throw Object.assign(new Error('timeout'), { hash: keccak256(toHex('click-lost')) }); } return send0(id, tx, gas, signed); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await tick(wd, e);
  wd.clock.t += 20 * 60_000; await tick(wd, e);
  lose = true;
  await e2.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: wd.st.usdg.get(lc(wd.R)), wReady6: 0n });
  const open = JSON.parse(wd.store.get('trenches.earn.v2.w.robinhood.' + lc(wd.R))).open;
  assert.equal(open.nonce, 42, 'the click\'s own nonce, from the signer');
});

test('L5-1: a silent step closes only when R\'s confirmed nonce is past ITS OWN nonce — another earlier R transaction confirming does not close it', async () => {
  const wd = makeEarnWorld(); const send0 = wd.earnDeps.evm.send; let once = true;
  const ownNonce = 7;   // signed above the chain's count (a held bridge nonce ahead of it)
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas, signed) => { if (once && String(tx.data).startsWith('0x6e553f65')) { once = false; signed?.(ownNonce); throw Object.assign(new Error('timeout'), { hash: keccak256(toHex('held-pending')) }); } return send0(id, tx, gas, signed); } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e); wd.st.silent = true;
  // another earlier R transaction confirms (the chain's count moves from 1 to 2 — still not past 7)
  wd.st.txs.push({ from: wd.R, to: wd.R, data: '0x', value: 0n, gas: 21_000n, hash: '0x' + 'aa'.repeat(32), status: 'success', block: BigInt(wd.st.txs.length + 1) });
  for (let i = 0; i < 20; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  assert.equal(e.status(wd.wallet).landing, true, 'r5 would have closed it (it compared with the count read before the send)');
  // the chain's count passes 7 (a transaction with that nonce is in, ours is not shown anywhere): dropped / replaced — closed
  wd.st.nonceStuck = 8; wd.clock.t += 60_000; await tick(wd, e);
  assert.equal(e.status(wd.wallet).landing, undefined); const er = e.status(wd.wallet).earned; assert.ok(er == null || Math.abs(er) < 0.01, 'never the dropped deposit as Earned: ' + er);
});
