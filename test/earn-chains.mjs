// Earn on every USD-balance chain: BNB (Aave v3) and Solana (Kamino) on high-fidelity mocks of the real ABIs / instruction layouts
// (test/fixtures/earn-world2.mjs), and the reliability rules across chains — the server's monitor, two tabs at once, RPC failures,
// stale snapshots, lost answers, per-chain switches, the live rate, "Earned" lifetime + 30 d, the history and its tax export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { EARN, earnCsv, apyFromSamples } from '../src/earnCore.ts';
import { AAVE_BSC, AAVE_ABI, aaveTxProblem, aaveApproveData, aaveSupplyData, aaveWithdrawData, aaveApyBps, MAX_UINT, reserveFacts } from '../src/earnAave.ts';
import { KAMINO_SOL, kaminoIxsProblem, kDepositIxs, kRedeemIxs, readReserve, kaminoProblem, depositIx, createAtaIx, refreshIx } from '../src/earnKamino.ts';
import { USD } from '../src/floatCore.ts';
import { makeAaveWorld, makeKaminoWorld } from './fixtures/earn-world2.mjs';
import { makeEarnWorld, assetsOfR } from './fixtures/earn-world.mjs';

const SIZES = [10n * USD, 25n * USD];
const lc = (a) => String(a).toLowerCase();
const on = async (wd, e, chains) => { const r = await e.configure({ action: 'on', lang: 'en', cap6: null, ...(chains ? { chains } : {}), floatOn: true }); assert.equal(r.ok, true); return r; };
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
const E18 = 10n ** 18n;

// ══ BNB: Aave v3 ══
test('Aave allow-list: approve(Pool, ≤ one deposit) on USDC; supply(USDC, ≤ cap, onBehalfOf R, 0); withdraw(USDC, ≤ cap or max, to R); nothing else', () => {
  const R = '0x1111111111111111111111111111111111111111', X = '0x2222222222222222222222222222222222222222';
  const ctx = { r: R, chainId: 56, cfg: AAVE_BSC, perTxMax6: EARN.perTxMax6, withdrawMax6: EARN.withdrawMax6 };
  const t = (to, data) => aaveTxProblem({ to, data, value: 0n }, ctx);
  assert.equal(t(AAVE_BSC.asset, aaveApproveData(AAVE_BSC, 425n * E18)), null);
  assert.equal(t(AAVE_BSC.pool, aaveSupplyData(AAVE_BSC, 425n * E18, R)), null);
  assert.equal(t(AAVE_BSC.pool, aaveWithdrawData(AAVE_BSC, 55n * E18, R)), null);
  assert.equal(t(AAVE_BSC.pool, aaveWithdrawData(AAVE_BSC, MAX_UINT, R)), null, 'everything (exit)');
  assert.match(t(AAVE_BSC.asset, aaveApproveData(AAVE_BSC, MAX_UINT)), /above one deposit/);
  assert.match(t(AAVE_BSC.asset, encodeFunctionData({ abi: AAVE_ABI, functionName: 'approve', args: [X, 1n] })), /another spender/);
  assert.match(t(AAVE_BSC.pool, aaveSupplyData(AAVE_BSC, 425n * E18, X)), /on behalf of someone else/);
  assert.match(t(AAVE_BSC.pool, aaveWithdrawData(AAVE_BSC, 1n, X)), /to someone else/);
  assert.match(t(AAVE_BSC.pool, encodeFunctionData({ abi: AAVE_ABI, functionName: 'supply', args: [X, 1n, R, 0] })), /another asset/);
  assert.match(t(AAVE_BSC.pool, encodeFunctionData({ abi: AAVE_ABI, functionName: 'supply', args: [AAVE_BSC.asset, 1n, R, 7] })), /referral/);
  assert.match(t(AAVE_BSC.pool, aaveSupplyData(AAVE_BSC, 1_001n * E18, R)), /out of bounds/);
  assert.match(t(AAVE_BSC.pool, aaveWithdrawData(AAVE_BSC, 5_001n * E18, R)), /out of bounds/);
  assert.match(t(AAVE_BSC.pool, '0xa415bcad' + '00'.repeat(128)), /selector/, 'borrow is not allowed');
  assert.match(aaveTxProblem({ to: AAVE_BSC.pool, data: aaveSupplyData(AAVE_BSC, 1n, R), value: 0n }, { ...ctx, chainId: 4663 }), /wrong chain/);
  assert.equal(aaveApyBps(51_534_128_611_494_068_248_343_088n), 529, 'the 5.15 % APR read on 2026-11-03 compounds to 5.29 %');
  assert.equal(reserveFacts('0x00'), null);
});

test('BNB deposit: exact approve → supply on behalf of R → aTokens grew by the amount → allowance 0; "Earned" follows the liquidity index; the live rate is the reserve\'s own', async () => {
  const wd = makeAaveWorld(); const e = createEarn(wd.earnDeps); await on(wd, e);
  const r = await tick(wd, e);
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.equal(r.usd, 425);
  assert.deepEqual(wd.st.txs.map((t) => t.data.slice(0, 10)), ['0x095ea7b3', '0x617ba037']);
  const ap = decodeFunctionData({ abi: AAVE_ABI, data: wd.st.txs[0].data }); assert.equal(ap.args[1], 425n * E18); assert.equal(lc(ap.args[0]), lc(AAVE_BSC.pool));
  const sp = decodeFunctionData({ abi: AAVE_ABI, data: wd.st.txs[1].data }); assert.equal(lc(sp.args[2]), lc(wd.R)); assert.equal(sp.args[3], 0);
  assert.equal(wd.st.allow.get(`${lc(wd.R)}>${lc(AAVE_BSC.pool)}`), 0n);
  assert.ok(wd.signerChecks.every((x) => x === null));
  assert.ok(wd.aBal() >= 425n * E18 - 2n);
  const st = e.status(wd.wallet); assert.ok(Math.abs(st.usd - 425) < 0.01); assert.equal(st.apyBps, 529); assert.equal(st.apyBasis, 'now');
  wd.st.index += wd.st.index / 100n;   // +1 %
  wd.clock.t += 61_000; await tick(wd, e);
  assert.ok(Math.abs(e.status(wd.wallet).earned - 4.25) < 0.01, JSON.stringify(e.status(wd.wallet)));
});

test('BNB withdrawals: the refill by amount, the exit by max, partial liquidity pays what the aToken holds now', async () => {
  const wd = makeAaveWorld(); const e = createEarn(wd.earnDeps); await on(wd, e);
  await tick(wd, e);
  wd.st.usdc.set(lc(wd.R), 20n * E18); wd.clock.t += 61_000;
  const r = await tick(wd, e);
  assert.equal(r.step, 'withdraw'); assert.equal(r.why, 'refill');
  const d = decodeFunctionData({ abi: AAVE_ABI, data: wd.st.txs.at(-1).data }); assert.equal(lc(d.args[2]), lc(wd.R));
  // the vault's liquidity is short: the exit takes what is there now, the rest comes on the next ticks
  wd.st.usdc.set(lc(AAVE_BSC.aToken), 100n * E18);
  const out = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.ok(out.left > 250 && out.left < 300, JSON.stringify(out));
  wd.st.usdc.set(lc(AAVE_BSC.aToken), 1_000_000n * E18); wd.clock.t += 61_000;
  const r2 = await tick(wd, e);
  assert.equal(r2.step, 'withdraw'); assert.equal(r2.why, 'exit');
  assert.equal(decodeFunctionData({ abi: AAVE_ABI, data: wd.st.txs.at(-1).data }).args[1], MAX_UINT, 'everything');
  assert.ok(wd.aBal() <= 2n);
});

test('BNB: a paused reserve — risk-off, its withdrawals simulate as refused, nothing is sent; a frozen one — everything comes out; an upgrade — no deposit, withdrawals go on', async () => {
  const a = makeAaveWorld(); const ea = createEarn(a.earnDeps); await on(a, ea); await tick(a, ea);
  const n = a.st.txs.length; a.st.paused = true; a.clock.t += 61_000;
  const r = await tick(a, ea);
  assert.equal(a.st.txs.length, n, 'nothing sent'); assert.equal(ea.status(a.wallet).cls, 'riskOff'); assert.ok(r.ok === false || r.step === 'none');
  const b = makeAaveWorld(); const eb = createEarn(b.earnDeps); await on(b, eb); await tick(b, eb);
  b.st.frozen = true; b.clock.t += 61_000;
  const r2 = await tick(b, eb);
  assert.equal(r2.step, 'withdraw', JSON.stringify(r2)); assert.ok(b.aBal() <= 2n);
  const c = makeAaveWorld({ rUsdc: 2_000n * E18 }); const ec = createEarn(c.earnDeps); await on(c, ec); await tick(c, ec);
  c.st.poolImpl = '0x' + '99'.repeat(20);
  const e2 = createEarn(c.earnDeps);   // a new session reads the implementation again
  c.clock.t += EARN.gapMs + 1; c.st.usdc.set(lc(c.R), 3_000n * E18);
  const r3 = await tick(c, e2);
  assert.equal(r3.step, 'none'); assert.equal(e2.status(c.wallet).cls, 'changed');
  c.st.usdc.set(lc(c.R), 10n * E18); c.clock.t += 61_000;
  assert.equal((await tick(c, e2)).step, 'withdraw', 'a refill still runs after an upgrade');
});

test('BNB: a supply Aave records with another amount, a withdrawal that reverts on chain → a hard stop, funds stay', async () => {
  const a = makeAaveWorld({ evil: 'supplyLess' }); const ea = createEarn(a.earnDeps); await on(a, ea);
  assert.match((await tick(a, ea)).paused, /another amount/);
  const b = makeAaveWorld(); const eb = createEarn(b.earnDeps); await on(b, eb); await tick(b, eb);
  b.st.revertOnChain = 'withdraw'; b.st.usdc.set(lc(b.R), 10n * E18); b.clock.t += 61_000;
  const r = await tick(b, eb);
  assert.match(r.paused, /reverted/); assert.equal(eb.status(b.wallet).cls, 'hard');
  const c = await eb.beforeClick(b.wallet, { need6: 300n * USD, liquidRaw: 10n * E18, wReady6: 0n });
  assert.match(c.why, /paused/);
});

// ══ Solana: Kamino ══
test('Kamino allow-list: exactly [create R\'s token account, refresh, deposit] or [create, refresh, redeem] from / to R\'s own accounts', () => {
  const k = makeKaminoWorld(); const o = { pyth: null, sbPrice: null, sbTwap: null, scope: KAMINO_SOL.scope };
  const ctx = { r: k.R, rUsdc: k.rUsdc, rCtoken: k.rC, oracles: o, perTxMax6: EARN.perTxMax6 };
  assert.equal(kaminoIxsProblem(kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 425_000_000n), ctx), null);
  assert.equal(kaminoIxsProblem(kRedeemIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 100n), ctx), null);
  assert.match(kaminoIxsProblem(kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 1_001_000_000n), ctx), /above one deposit/);
  assert.match(kaminoIxsProblem(kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 0n), ctx), /out of bounds/);
  assert.match(kaminoIxsProblem([...kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 1n), createAtaIx(KAMINO_SOL, k.R, k.rC, KAMINO_SOL.cMint)], ctx), /not an Earn/, 'an extra instruction');
  const other = 'So1Other1111111111111111111111111111111111';
  const x = kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 10n); x[2] = depositIx(KAMINO_SOL, k.R, k.rUsdc, k.W, 10n);
  assert.match(kaminoIxsProblem(x, ctx), /other accounts/, 'cTokens to another account');
  const y = kRedeemIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 10n); y[2].keys[8] = [k.W, false, true];
  assert.match(kaminoIxsProblem(y, ctx), /other accounts/, 'USDC to another account');
  const z = kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 10n); z[0] = createAtaIx(KAMINO_SOL, k.W, k.rC, KAMINO_SOL.cMint);
  assert.match(kaminoIxsProblem(z, ctx), /other accounts/, 'someone else pays / owns');
  const t = kDepositIxs(KAMINO_SOL, k.R, k.rUsdc, k.rC, o, 10n); t[2] = { program: KAMINO_SOL.tokenProgram, keys: [], data: new Uint8Array(16) };
  assert.match(kaminoIxsProblem(t, ctx), /not an Earn/, 'a token transfer');
  assert.equal(KAMINO_SOL.reserve, 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
  assert.ok(refreshIx(KAMINO_SOL, o).keys.slice(2, 5).every((x) => x[0] === KAMINO_SOL.program), 'unset oracles = the program id');
});

test('Solana deposit: simulated first (R\'s USDC −amount exactly, cTokens up), sent, the cTokens checked after; the redeem pays back; the exchange rate is the "Earned"', async () => {
  const wd = makeKaminoWorld(); const e = createEarn(wd.earnDeps); await on(wd, e);
  const r = await tick(wd, e);
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.equal(r.usd, 425);
  assert.equal(wd.st.sent.length, 1); assert.equal(wd.st.usdc, 75_000_000n); assert.ok(wd.st.c > 0n);
  assert.ok(wd.st.sims >= 1, 'simulated before the send');
  const st = e.status(wd.wallet); assert.ok(Math.abs(st.usd - 425) < 0.01, JSON.stringify(st)); assert.ok(Math.abs(st.earned) < 0.01);
  wd.st.borrowed += wd.total() / 100n;   // the reserve earned 1 %
  wd.clock.t += 61_000; await tick(wd, e);
  assert.ok(e.status(wd.wallet).earned > 4, JSON.stringify(e.status(wd.wallet)));
  wd.st.usdc = 10_000_000n; wd.clock.t += 61_000;
  const r2 = await tick(wd, e);
  assert.equal(r2.step, 'withdraw', JSON.stringify(r2)); assert.ok(wd.st.usdc > 60_000_000n);
});

test('Solana: partial liquidity (the reserve\'s available USDC), a reserve not active, an upgraded program, a step that fails on chain, a reserve that mints less (caught in the simulation)', async () => {
  const a = makeKaminoWorld(); const ea = createEarn(a.earnDeps); await on(a, ea); await tick(a, ea);
  a.st.borrowed += a.st.available - 100_000_000n; a.st.available = 100_000_000n;   // borrowed out: $100 left to pay out now
  const out = await ea.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.ok(out.left > 320 && out.left < 330, JSON.stringify(out));
  const b = makeKaminoWorld(); const eb = createEarn(b.earnDeps); await on(b, eb); await tick(b, eb);
  b.st.status = 1; const n = b.st.sent.length; b.clock.t += 61_000;
  await tick(b, eb);
  assert.equal(b.st.sent.length, n, 'the reserve refuses: nothing sent'); assert.equal(eb.status(b.wallet).cls, 'riskOff');
  const c = makeKaminoWorld({ rUsdc: 2_000_000_000n }); const ec = createEarn(c.earnDeps);
  c.st.deploySlot += 1n;   // upgraded before this session read it (a running session re-reads it every EARN.vaultCheckMs)
  await on(c, ec);
  assert.equal((await tick(c, ec)).step, 'none'); assert.equal(ec.status(c.wallet).cls, 'changed'); assert.equal(c.st.sent.length, 0);
  const d = makeKaminoWorld(); const ed = createEarn(d.earnDeps); await on(d, ed);
  d.st.failOnChain = true;
  assert.match((await tick(d, ed)).paused, /failed on chain/);
  const f = makeKaminoWorld({ evil: 'mintLess' }); const ef = createEarn(f.earnDeps); await on(f, ef);
  const r = await tick(f, ef);
  // r6 (re-review M5-1): a mismatch found only in the simulation is retried, never a stop; three in a row stop deposits ('changed')
  assert.match(r.why, /simulated: Kamino would mint fewer/); assert.equal(r.paused, undefined); assert.equal(f.st.sent.length, 0, 'never sent');
  for (let i = 0; i < 3; i++) { f.clock.t += 200 * 60_000; await tick(f, ef); }
  assert.equal(ef.status(f.wallet, 'sol').cls, 'changed'); assert.equal(f.st.sent.length, 0);
});

test('Solana: a lost send answer is followed by its signature (never sent twice); an RPC that fails changes nothing', async () => {
  const wd = makeKaminoWorld({ loseSend: 1 }); const e = createEarn(wd.earnDeps); await on(wd, e);
  const r = await tick(wd, e); assert.equal(r.ok, false);
  wd.clock.t += EARN.backoffMs + 1; await tick(wd, e);
  assert.equal(wd.st.sent.length, 1, 'never re-sent');
  assert.ok(Math.abs(e.status(wd.wallet).usd - 425) < 0.01 && e.status(wd.wallet).earned != null);
  let down = false; const w2 = makeKaminoWorld({ readFails: () => down }); const e2 = createEarn(w2.earnDeps); await on(w2, e2); down = true;
  const r2 = await tick(w2, e2); assert.equal(r2.ok, false); assert.equal(w2.st.sent.length, 0);
  down = false; w2.clock.t += EARN.backoffMs + 1;
  assert.equal((await tick(w2, e2)).step, 'deposit');
});

// ══ across chains ══
test('the server\'s monitor flags a chain: risk-off there — nothing new goes in, everything comes out (it can never switch Earn on)', async () => {
  let flag = null;
  const wd = makeEarnWorld(); const e = createEarn({ ...wd.earnDeps, monitor: async () => (flag ? { robinhood: { pause: flag } } : {}) });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.ok(assetsOfR(wd) > 0n);
  flag = 'liquidity below our users\' need'; wd.clock.t += 61_000;
  const e2 = createEarn({ ...wd.earnDeps, monitor: async () => ({ robinhood: { pause: flag } }) });
  // review M1: one answer is not enough (a node's bad answer); the second one in a row acts
  const r1 = await e2.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.notEqual(r1.step, 'withdraw', JSON.stringify(r1)); assert.ok(assetsOfR(wd) > 0n);
  wd.clock.t += 61_000;
  const r = await e2.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.equal(r.step, 'withdraw', JSON.stringify(r)); assert.equal(assetsOfR(wd), 0n);
  assert.match(e2.account().paused, /monitor/);
  // the flag goes away: the monitor's pause goes with it (only the engine's own findings stay until the user's next "on")
  const e3 = createEarn({ ...wd.earnDeps, monitor: async () => ({}) });
  wd.clock.t += EARN.gapMs + 1; wd.st.usdg.set(lc(wd.R), 2_000_000_000n);
  assert.equal((await e3.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).step, 'deposit');
  assert.equal(e3.account().paused, undefined);
});

test('two tabs at once: one Earn step per wallet × chain across tabs (the browser lock) — never two deposits from one surplus', async () => {
  const wd = makeEarnWorld();
  const held = new Map();
  const lock = async (key, fn, opts) => { if (held.get(key)) { if (!opts?.waitMs) return null; await held.get(key).catch(() => {}); } const p = fn(); held.set(key, p); try { return await p; } finally { held.delete(key); } };
  const tabA = createEarn({ ...wd.earnDeps, lock }), tabB = createEarn({ ...wd.earnDeps, lock });
  await tabA.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const [a, b] = await Promise.all([tabA.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true }), tabB.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })]);
  const deposits = wd.st.txs.filter((t) => t.data.startsWith('0x6e553f65')).length;
  assert.equal(deposits, 1, JSON.stringify([a, b]));
  assert.ok([a.step, b.step].includes('deposit') && [a.why, b.why].includes('busy'));
});

test('a stale snapshot never moves money by itself: the click reads the chain first (here nothing is in Earn any more) and sends nothing', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  wd.st.shares.set(lc(wd.R), 0n);   // moved out elsewhere (another device): the snapshot here still says $425
  const n = wd.st.txs.length;
  assert.equal(e.clickNeeds(wd.wallet, { need6: 200n * USD, liquidRaw: 75_000_000n, wReady6: 0n }), true, 'the cached view thinks so');
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: 75_000_000n, wReady6: 0n });
  assert.equal(wd.st.txs.length, n); assert.ok(c.usd === 0 || /nothing/.test(c.why || ''), JSON.stringify(c));
});

test('per-chain switches: on for BNB only leaves Robinhood alone; off for BNB keeps the others; the history and its tax export; "Earned" 30 d; the rate from the share price', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, chains: ['bsc'], floatOn: true });
  assert.equal((await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).why, 'off', 'Robinhood not switched on');
  await e.configure({ action: 'on', lang: 'en', cap6: null, chains: ['robinhood', 'bsc'], floatOn: true });
  assert.deepEqual(e.account().chainsOn.sort(), ['bsc', 'robinhood']);
  await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  await e.configure({ action: 'off', lang: 'en', cap6: null, chains: ['bsc'], floatOn: true });
  assert.deepEqual(e.account().chainsOn, ['robinhood']);
  // a month of the vault earning: a daily mark, the share price sampled hourly
  for (let d = 0; d < 35; d++) { wd.clock.t += 86_400_000; wd.st.ta += wd.st.ta / 10_000n; await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true }); }
  const st = e.status(wd.wallet, 'robinhood');
  assert.ok(st.earned > 1.4 && st.earned < 1.6, '425 × 35 bp ' + JSON.stringify(st));
  assert.ok(st.earned30 > 1.1 && st.earned30 < st.earned, 'the last 30 days only ' + JSON.stringify(st));
  assert.equal(st.apyBasis, '30d'); assert.ok(st.apyBps > 300 && st.apyBps < 500, 'about 1 bp a day = ~3.7 % a year ' + st.apyBps);
  // out: realized yield is its own line in the export
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 61_000;
  await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  const h = e.history();
  assert.deepEqual(h.rows.map((r) => r.kind), ['deposit', 'withdraw']);
  assert.ok(BigInt(h.rows[1].yield6) > 0n);
  const lines = h.csv.trim().split('\n');
  assert.equal(lines[0], 'date,network,wallet,kind,usd,tx');
  assert.ok(lines.some((l) => /Robinhood Chain,Wallet 1,deposit,425\.000000,0x/.test(l)));
  assert.ok(lines.some((l) => /yield \(realized\)/.test(l)) && lines.some((l) => /yield \(unrealized\)/.test(l)));
});

test('pure: the APY from samples (needs the span), the CSV quotes and signs', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(apyFromSamples([{ at: t0, p: 1_000_000n }, { at: t0 + 3 * 86_400_000, p: 1_000_100n }], 7 * 86_400_000, t0 + 3 * 86_400_000), null);
  assert.equal(apyFromSamples([{ at: t0, p: 1_000_000n }, { at: t0 + 365 * 86_400_000, p: 1_045_000n }], 7 * 86_400_000, t0 + 365 * 86_400_000), 450);
  const csv = earnCsv([{ at: t0, chain: 'sol', wallet: 'My, "wallet"', kind: 'withdraw', usd6: '1500000', hash: 'sig', yield6: '-1' }], [], t0);
  assert.match(csv, /"My, ""wallet"""/); assert.match(csv, /-0\.000001/);
});

test('pure: the Kamino reserve read refuses a foreign owner / layout, names the risk class', () => {
  const k = makeKaminoWorld();
  assert.ok('why' in readReserve(new Uint8Array(8624), 'Other111111111111111111111111111111111111'));
  assert.ok('why' in readReserve(new Uint8Array(100), KAMINO_SOL.program));
  const ok = { lendingMarket: KAMINO_SOL.market, mint: KAMINO_SOL.mint, supplyVault: KAMINO_SOL.supplyVault, cMint: KAMINO_SOL.cMint, tokenProgram: KAMINO_SOL.tokenProgram, available: 1n, totalLiquidity: 2n, cSupply: 1n, status: 0, emergency: 0, depositLimit: 1n, oracles: { pyth: null, sbPrice: null, sbTwap: null, scope: KAMINO_SOL.scope } };
  assert.equal(kaminoProblem(ok, 0, KAMINO_SOL.deploySlot), null);
  assert.equal(kaminoProblem({ ...ok, supplyVault: k.W }, 0, KAMINO_SOL.deploySlot).cls, 'hard');
  assert.equal(kaminoProblem({ ...ok, status: 2 }, 0, KAMINO_SOL.deploySlot).cls, 'riskOff');
  assert.equal(kaminoProblem(ok, 1, KAMINO_SOL.deploySlot).cls, 'riskOff');
  assert.equal(kaminoProblem({ ...ok, oracles: { ...ok.oracles, scope: k.W } }, 0, KAMINO_SOL.deploySlot).cls, 'changed');
  assert.equal(kaminoProblem(ok, 0, KAMINO_SOL.deploySlot + 1n).cls, 'changed');
});

test('a reorg: a lagging position read is never a stop on its own (r4); a positive signal — the receipt gone with its block replaced — is a hard stop, nothing more is sent', async () => {
  const wd = makeEarnWorld();
  let reorged = false;
  const receipt = async (h) => {
    const r = await wd.earnDeps.evm.receipt(h);   // (with its block)
    const tx = wd.st.txs.find((t) => t.hash === h);
    if (r && tx && tx.data.startsWith('0x6e553f65') && !reorged) { reorged = true; wd.st.shares.set(lc(wd.R), 0n); }   // the block that held it is gone
    return r;
  };
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, receipt } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const r = await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  // review M2: the receipt's own events are booked; the position read that does not show them is NOT a stop at once (a lagging
  // node looks the same) — the step stays open and is read again; nothing new is sent meanwhile
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.equal(e.status(wd.wallet).verifying, true);
  const n = wd.st.txs.length; wd.clock.t += 61_000;
  assert.equal((await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true })).why, 'following');
  assert.equal(wd.st.txs.length, n, 'nothing more while it is checked');
  // r4 (re-review M3-1): the receipt is still there and only R's position lags: never a stop on its own; a POSITIVE reorg signal —
  // the receipt gone and the block it was seen in now has another hash — is the hard stop (r5: a lag alone closes after verifyMs:
  // test/earn-review-r5.mjs X3)
  assert.notEqual(e.status(wd.wallet).cls, 'hard'); assert.equal(e.status(wd.wallet).verifying, true);
  const dep = wd.st.txs.find((t) => t.data.startsWith('0x6e553f65')); wd.st.receipts.delete(dep.hash); wd.st.reorgSalt = 'reorg';
  wd.clock.t += 61_000; await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.equal(wd.st.txs.length, n, 'stopped: nothing more');
  assert.equal(e.status(wd.wallet).cls, 'hard'); assert.match(e.status(wd.wallet).paused, /gone from the chain/);
  const st = e.status(wd.wallet); assert.equal(st.earned, null, 'what went in is unknown');
});

test('a grant that ran out is no consent to stay in: the money comes back by itself; a USD-balance switch-off anywhere does the same', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.ok(assetsOfR(wd) > 0n);
  wd.clock.t += (EARN.grantDays + 1) * 86_400_000;
  const r = await e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  assert.equal(r.step, 'withdraw', JSON.stringify(r)); assert.equal(assetsOfR(wd), 0n);
  assert.equal(e.account().on, false);
  const w2 = makeEarnWorld(); const e2 = createEarn(w2.earnDeps);
  await e2.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await e2.tick(w2.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
  e2.stop();   // the USD balance turned off in another frame / device
  w2.clock.t += 61_000;
  assert.equal((await e2.tick(w2.wallet, { sizes6: [], yieldNow: () => false, floatOn: false })).step, 'withdraw');
  assert.equal(assetsOfR(w2), 0n);
});

test('a Kamino reserve this build cannot read (another layout): a hard stop, the snapshot keeps the last known position', async () => {
  const wd = makeKaminoWorld(); const e = createEarn(wd.earnDeps); await on(wd, e); await tick(wd, e);
  const before = e.status(wd.wallet).usd; assert.ok(before > 400);
  const acc = wd.earnDeps.sol.accounts;
  wd.earnDeps.sol.accounts = async (addrs) => (await acc(addrs)).map((a, i) => (i === 0 && a ? { ...a, data: a.data.subarray(0, 8000) } : a));
  wd.clock.t += 61_000;
  const r = await tick(wd, e);
  assert.equal(r.cls, 'hard'); assert.match(r.paused, /layout/);
  assert.equal(e.status(wd.wallet).usd, before, 'not overwritten with zeros');
  assert.equal(e.status(wd.wallet).cls, 'hard');
});
