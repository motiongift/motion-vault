// Earn on the USD balance — the vault module (src/earnEngine.ts) and its wiring into the USD balance (src/floatEngine.ts), end to
// end on a MOCKED Robinhood chain (test/fixtures/earn-world.mjs: USDG + a Morpho-Vault-V2-like ERC-4626 that decodes the real
// calldata, keeps balances, shares, allowances and liquidity, and writes receipts with the real event topics; the float's
// top-up router). Partial liquidity, a gated (paused) vault, a withdrawal that reverts on chain, a share-price drop, a vault that
// mints or pays other amounts than it records, a lost send answer, a trade running, the US geo answer. Nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { createFloat } from '../src/floatEngine.ts';
import { EARN, EARN_ABI, approveData, depositData } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, CFG, C, lc, assetsOfR, ROUTER_ABI } from './fixtures/earn-world.mjs';

const SIZES = [10n * USD, 25n * USD];
const sel = (tx) => String(tx.data).slice(0, 10);
const kinds = (wd) => wd.st.txs.map((t) => (lc(t.to) === lc(CFG.vault) ? decodeFunctionData({ abi: EARN_ABI, data: t.data }).functionName : lc(t.to) === lc(CFG.asset) ? 'approve' : lc(t.to) === lc(C.router) ? 'swap' : 'other'));
const keyScan = (wd, things) => {
  const blob = JSON.stringify(things, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + [...wd.store.values()].join('|') + JSON.stringify(wd.events) + JSON.stringify(wd.asks);
  for (const k of [wd.W_KEY, wd.R_KEY]) assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked');
};
async function earnOn(o = {}) {
  const wd = makeEarnWorld(o);
  const e = createEarn(wd.earnDeps);
  const r = await e.configure({ action: 'on', lang: 'en', cap6: o.cap6 ?? null, floatOn: true });
  assert.equal(r.ok, true);
  return { wd, e };
}
const tick = (wd, e, sizes = SIZES) => e.tick(wd.wallet, { sizes6: sizes, yieldNow: () => false, floatOn: true });

test('switch-on: the USD balance must be on, the geo answer must allow it, then the 2FA gate and ONE dialog with the risks; nothing moves then', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await assert.rejects(e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: false }), /Turn on the USD balance first/);
  wd.setGeo(false);
  await assert.rejects(e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }), /not available where you are/);
  assert.equal(wd.asks.length, 0); assert.equal(wd.gates(), 0);
  wd.setGeo(true);
  const r = await e.configure({ action: 'on', lang: 'ru', cap6: 500n * USD, floatOn: true });
  assert.equal(r.earn.on, true); assert.equal(r.earn.cap, 500);
  assert.equal(wd.gates(), 1); assert.equal(wd.asks.length, 1);
  assert.match(wd.asks[0].html, /Morpho/); assert.match(wd.asks[0].html, /Страховки нет/); assert.match(wd.asks[0].html, /США/);
  assert.equal(wd.st.txs.length, 0, 'the dialog moves nothing');
  const wd2 = makeEarnWorld({ answer: false }); const e2 = createEarn(wd2.earnDeps);
  await assert.rejects(e2.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }), /Cancelled/);
  assert.equal(e2.account().on, false);
  // a lane without a venue (NEAR) may switch the account on: nothing is read there, each chain's frame checks its own venue
  const wd3 = makeEarnWorld({ lane: 'near' }); const e3 = createEarn(wd3.earnDeps);
  const r3 = await e3.configure({ action: 'on', lang: 'en', cap6: null, chains: ['robinhood'], floatOn: true });
  assert.deepEqual(r3.earn.chainsOn, ['robinhood']); assert.equal(wd3.st.reads, 0);
  assert.equal((await e3.tick(wd3.wallet, { sizes6: SIZES, yieldNow: () => false })).why, 'lane');
});

test('deposit: the surplus over B, exact approve → deposit to R → allowance 0; shares grew by exactly what the vault minted; "Earned" from 0', async () => {
  const { wd, e } = await earnOn();
  const r = await tick(wd, e);
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.equal(r.usd, 425);
  assert.deepEqual(kinds(wd), ['approve', 'deposit']);
  const [ap, dep] = wd.st.txs;
  assert.equal(decodeFunctionData({ abi: EARN_ABI, data: ap.data }).args[1], 425_000_000n, 'the exact amount, never unlimited');
  assert.equal(lc(decodeFunctionData({ abi: EARN_ABI, data: ap.data }).args[0]), lc(CFG.vault));
  assert.equal(lc(decodeFunctionData({ abi: EARN_ABI, data: dep.data }).args[1]), lc(wd.R), 'receiver = R');
  assert.ok(wd.st.txs.every((t) => lc(t.from) === lc(wd.R) && t.value === 0n), 'R signs, no value');
  assert.equal(wd.st.allow.get(`${lc(wd.R)}>${lc(CFG.vault)}`), 0n, 'allowance back at 0');
  assert.equal(wd.st.usdg.get(lc(wd.R)), 75_000_000n, 'B stays liquid');
  assert.ok(wd.signerChecks.every((x) => x === null), 'the signer allow-list passed every one');
  const st = e.status(wd.wallet);
  assert.ok(Math.abs(st.usd - 425) < 0.01, JSON.stringify(st)); assert.ok(Math.abs(st.earned) < 0.01); assert.equal(st.liquid, 75);
  // the vault earns: "Earned" is the value less what went in
  wd.st.ta += wd.st.ta / 100n;
  wd.clock.t += EARN.gapMs + 1;
  const r2 = await tick(wd, e);
  assert.equal(r2.step, 'none'); assert.equal(wd.st.txs.length, 2, 'nothing above B: no second deposit');
  assert.ok(Math.abs(e.status(wd.wallet).earned - 4.25) < 0.01, JSON.stringify(e.status(wd.wallet)));
  keyScan(wd, [r, r2, st]);
});

test('the gap, the day and the account cap hold deposits back; a wallet without Earn is only read, never acted for', async () => {
  const { wd, e } = await earnOn({ rUsdg: 5_000_000_000n, cap6: 1_500n * USD });
  assert.equal((await tick(wd, e)).usd, 1_000, 'one deposit ≤ $1,000');
  wd.st.usdg.set(lc(wd.R), wd.st.usdg.get(lc(wd.R)) + 2_000_000_000n);
  assert.equal((await tick(wd, e)).why, 'gap');
  wd.clock.t += EARN.gapMs + 1;
  const r = await tick(wd, e);
  assert.ok(r.usd > 499 && r.usd <= 500, 'the account cap: $1,500 in all ' + JSON.stringify(r));
  wd.clock.t += EARN.gapMs + 1;
  assert.equal((await tick(wd, e)).why, 'cap');
  // no switch here, nothing in Earn: one read, no transaction
  const w2 = makeEarnWorld(); const e2 = createEarn(w2.earnDeps);
  assert.equal((await tick(w2, e2)).why, 'off'); assert.equal(w2.st.txs.length, 0);
  const reads = w2.st.reads; await tick(w2, e2); assert.equal(w2.st.reads, reads, 'read at most every 10 minutes');
});

test('refill: the liquid part under 60 % of B is withdrawn back to B (withdraw(assets, R, R)), the principal shrinks pro rata', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.st.usdg.set(lc(wd.R), 20_000_000n);   // R paid for buys
  wd.clock.t += 60_000;
  const r = await tick(wd, e);
  assert.equal(r.step, 'withdraw', JSON.stringify(r)); assert.equal(r.why, 'refill');
  assert.equal(r.usd, 46.75, 'B = 15 % of $445 = $66.75');
  const last = wd.st.txs.at(-1); const d = decodeFunctionData({ abi: EARN_ABI, data: last.data });
  assert.equal(d.functionName, 'withdraw'); assert.equal(lc(d.args[1]), lc(wd.R)); assert.equal(lc(d.args[2]), lc(wd.R));
  assert.equal(wd.st.usdg.get(lc(wd.R)), 66_750_000n);
  const st = e.status(wd.wallet); assert.ok(Math.abs(st.usd - 378.25) < 0.02, JSON.stringify(st)); assert.ok(Math.abs(st.earned) < 0.02); assert.equal(st.liquid, 66.75);
});

test('partial liquidity: the exit takes what the vault can pay now (halving probes), keeps the rest earning, and comes back for it', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.st.liquidity = 100_000_000n;   // the vault can pay $100 now
  const out = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(wd.asks.length, 2, 'one dialog to turn it off'); assert.match(wd.asks[1].html, /\$425\.00/);
  const wds = wd.st.txs.filter((t) => sel(t) === '0xb460af94');
  assert.equal(wds.length, 1, 'one part'); assert.ok(decodeFunctionData({ abi: EARN_ABI, data: wds[0].data }).args[0] <= 100_000_000n);
  assert.ok(out.left > 360 && out.left < 375, 'halving: $212 and $106 refused, $53 paid ' + JSON.stringify(out));
  assert.equal(e.account().on, false); assert.equal(e.account().exit, true);
  // nothing new goes in, the rest comes out as the vault's liquidity comes back
  wd.st.liquidity = 10n ** 15n; wd.clock.t += 60_000;
  const r = await tick(wd, e);
  assert.equal(r.step, 'withdraw'); assert.equal(r.why, 'exit');
  assert.equal(assetsOfR(wd), 0n, 'everything back in R');
  assert.equal(e.account().exit, false, 'exit done');
  assert.ok(wd.st.usdg.get(lc(wd.R)) >= 499_000_000n);
  wd.clock.t += EARN.gapMs + 1; assert.equal((await tick(wd, e)).step, 'none', 'off: no deposit');
});

test('a gated (paused) vault: Earn stops at once, nothing is sent, the funds stay; a click is told why; turning it on again needs the gate gone', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  const n = wd.st.txs.length; const shares = wd.st.shares.get(lc(wd.R));
  wd.st.gates.sendAssetsGate = '0x9999999999999999999999999999999999999999';
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;   // would refill
  const r = await tick(wd, e);
  // risk-off: nothing new goes in, and it tries to take everything out — the gate refuses every simulation: nothing is sent
  assert.equal(r.step, 'none'); assert.equal(r.why, 'liquidity', 'the gate lets nothing out: the simulation said so'); assert.equal(r.cls, 'riskOff'); assert.equal(wd.st.txs.length, n); assert.equal(wd.st.shares.get(lc(wd.R)), shares);
  assert.match(e.account().paused, /gate/); assert.equal(e.status(wd.wallet).cls, 'riskOff');
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: 10_000_000n, wReady6: 0n });
  assert.match(c.why, /cannot pay|liquidity/); assert.equal(wd.st.txs.length, n);
  await assert.rejects(e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }), /gate/);
  wd.st.gates.sendAssetsGate = '0x0000000000000000000000000000000000000000';
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.match(wd.asks.at(-1).html, /clears every one of these stops: Robinhood Chain: the vault has a gate set/, 'the dialog lists what it clears (review L4)');
  assert.equal(e.account().paused, undefined);
});

test('a withdrawal that simulated fine but reverts on chain: Earn pauses, shares untouched, no second try', async () => {
  const { wd, e } = await earnOn({ revertOnChain: null });
  await tick(wd, e);
  wd.st.revertOnChain = 'withdraw';
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  const shares = wd.st.shares.get(lc(wd.R));
  const r = await tick(wd, e);
  assert.match(r.paused, /reverted/, JSON.stringify(r));
  assert.equal(wd.st.shares.get(lc(wd.R)), shares);
  assert.equal(wd.st.txs.filter((t) => t.status === 'reverted').length, 1);
  wd.clock.t += 600_000;
  await tick(wd, e); await tick(wd, e);
  assert.equal(wd.st.txs.filter((t) => sel(t) === '0xb460af94').length, 1, 'paused: never tried again by itself');
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: 10_000_000n, wReady6: 0n });
  assert.match(c.why, /paused/);
});

test('a share-price drop of more than 0.5 % under its high-water mark pauses Earn: no deposit, no refill, nothing sent', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.st.ta = (wd.st.ta * 99n) / 100n;   // −1 %
  wd.st.usdg.set(lc(wd.R), 2_000_000_000n); wd.clock.t += EARN.gapMs + 1;
  const n = wd.st.txs.length;
  const r = await tick(wd, e);
  // risk-off (owner 2026-11-03: the monitor's flag → the engine withdraws): no deposit, everything comes back to R, checked
  assert.equal(r.step, 'withdraw', JSON.stringify(r)); assert.equal(r.why, 'risk-off');
  assert.equal(assetsOfR(wd), 0n);
  assert.ok(!kinds(wd).slice(n).includes('deposit'));
  assert.match(e.status(wd.wallet).paused, /share price/); assert.equal(e.status(wd.wallet).cls, 'riskOff');
  wd.clock.t += EARN.gapMs + 1; wd.st.usdg.set(lc(wd.R), 2_000_000_000n);
  assert.equal((await tick(wd, e)).step, 'none', 'still paused: no deposit until the user says yes again');
});

test('a vault that mints fewer shares than it records, or pays R less: the receipt / shares check catches it and Earn pauses', async () => {
  const a = await earnOn({ evil: 'mintLess' });
  const r = await tick(a.wd, a.e);
  assert.match(r.paused, /shares/, JSON.stringify(r));
  const b = await earnOn();
  await tick(b.wd, b.e);
  b.wd.st.evil = 'payLess'; b.wd.st.usdg.set(lc(b.wd.R), 10_000_000n); b.wd.clock.t += 60_000;
  const r2 = await tick(b.wd, b.e);
  assert.match(r2.paused, /did not receive/, JSON.stringify(r2));
  const c = await earnOn({ evil: 'noEvent' });
  assert.match((await tick(c.wd, c.e)).paused, /did not record/);
});

test('another vault contract at the address, a raised performance fee: paused before anything is read for a step', async () => {
  const a = await earnOn();
  a.wd.st.codeHash = '0x' + 'ab'.repeat(32);
  const e2 = createEarn(a.wd.earnDeps);   // a new session reads the code again
  const r = await tick(a.wd, e2);
  assert.match(r.paused, /contract/); assert.equal(a.wd.st.txs.length, 0);
  const b = await earnOn(); b.wd.st.performanceFee = 3n * 10n ** 17n;
  assert.match((await tick(b.wd, b.e)).paused, /performance fee/); assert.equal(b.wd.st.txs.length, 0);
});

test('a click: no read at all when the buffer covers it or nothing is in Earn; else the missing part comes out first (withdraw to R)', async () => {
  const { wd, e } = await earnOn();
  const r0 = wd.st.reads;
  assert.equal(await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: 500_000_000n, wReady6: 0n }), null, 'nothing in Earn: null, no read');
  await tick(wd, e);
  const r1 = wd.st.reads, s1 = wd.st.sims;
  assert.equal(await e.beforeClick(wd.wallet, { need6: 20n * USD, liquidRaw: 75_000_000n, wReady6: 0n }), null, 'covered: null');
  assert.equal(wd.st.reads, r1); assert.equal(wd.st.sims, s1, 'no read, no simulation');
  assert.ok(r1 > r0);
  const c = await e.beforeClick(wd.wallet, { need6: 200n * USD, liquidRaw: 75_000_000n, wReady6: 0n });
  assert.equal(c.usd, 176, JSON.stringify(c));
  assert.equal(wd.st.usdg.get(lc(wd.R)), 251_000_000n);
  // a trade between its call and its broadcast: not even a click's withdrawal is sent
  wd.click.clickAt = wd.clock.t + 1;
  const n = wd.st.txs.length;
  const c2 = await e.beforeClick(wd.wallet, { need6: 400n * USD, liquidRaw: 251_000_000n, wReady6: 0n });
  assert.match(c2.why, /trade is running/); assert.equal(wd.st.txs.length, n);
});

test('the background never sends in the click window, nor once a click wants the lock (yieldNow)', async () => {
  const { wd, e } = await earnOn();
  wd.click.focusAt = wd.clock.t;   // a token page just got focus
  const reads = wd.st.reads;
  assert.equal((await tick(wd, e)).why, 'click'); assert.equal(wd.st.reads, reads); assert.equal(wd.st.txs.length, 0);
  wd.click.focusAt = 0;
  let calls = 0;
  const r = await e.tick(wd.wallet, { sizes6: SIZES, floatOn: true, yieldNow: () => ++calls > 1 });
  assert.equal(wd.st.txs.length <= 1, true, 'stopped before the deposit ' + JSON.stringify(r));
});

test('a lost send answer: the deposit is followed by its receipt on the next tick, never sent twice; the principal is counted once', async () => {
  const wd = makeEarnWorld({ lose: 2 });   // the deposit's answer is lost (it did go out)
  const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const r = await tick(wd, e);
  assert.equal(r.ok, false);
  assert.equal(wd.st.txs.filter((t) => sel(t) === '0x6e553f65').length, 1);
  wd.clock.t += EARN.backoffMs + 1;
  await tick(wd, e);
  assert.equal(wd.st.txs.filter((t) => sel(t) === '0x6e553f65').length, 1, 'never re-sent');
  const st = e.status(wd.wallet);
  assert.ok(st.earned != null && Math.abs(st.earned) < 0.01 && Math.abs(st.usd - 425) < 0.01, JSON.stringify(st));
});

test('the signer refuses anything off the allow-list even if earnEngine were wrong (receiver, spender, unlimited approve, transfer)', async () => {
  const wd = makeEarnWorld();
  const evil = '0x2222222222222222222222222222222222222222';
  await assert.rejects(wd.earnDeps.evm.send('w1', { to: CFG.vault, data: depositData(1_000_000n, evil), value: 0n }, 100_000n), /receiver/);
  await assert.rejects(wd.earnDeps.evm.send('w1', { to: CFG.asset, data: approveData({ ...CFG, vault: evil }, 1n), value: 0n }, 100_000n), /spender/);
  await assert.rejects(wd.earnDeps.evm.send('w1', { to: CFG.asset, data: approveData(CFG, (1n << 256n) - 1n), value: 0n }, 100_000n), /above one deposit/);
  await assert.rejects(wd.earnDeps.evm.send('w1', { to: CFG.asset, data: '0xa9059cbb' + evil.slice(2).padStart(64, '0') + '1'.padStart(64, '0'), value: 0n }, 100_000n), /only approve/);
  assert.equal(wd.st.txs.length, 0);
});

test('geo: a later "no" (6 h cache) stops new deposits; withdrawals never need it', async () => {
  const { wd, e } = await earnOn();
  await tick(wd, e);
  wd.setGeo(false); wd.clock.t += EARN.geoMs + 1;
  wd.st.usdg.set(lc(wd.R), 2_000_000_000n);
  assert.equal((await tick(wd, e)).why, 'geo');
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  assert.equal((await tick(wd, e)).step, 'withdraw', 'the refill still runs');
});

// ── wired into the USD balance (src/floatEngine.ts) ──
async function floatWorld(o = {}) {
  const wd = makeEarnWorld(o);
  const earn = createEarn(wd.earnDeps);
  const f = createFloat({ readyFloat: true, gasFromW: true, ...wd.floatDeps, earn });
  const r = await f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.equal(r.ok, true);
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.') || k.startsWith('trenches.float.v1.keep.')) wd.store.delete(k);
  await f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'lane', presets: [10, 25] });
  return { wd, f, earn };
}
const settle = async () => { for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r)); };
// routine float ticks (a minute apart) until Earn has deposited: the first ones top W up to its ready float (a float move: Earn waits)
async function untilDeposit(wd, f) {
  for (let i = 0; i < 6 && !kinds(wd).includes('deposit'); i++) { wd.clock.t += 61_000; await f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick', presets: [10, 25] }); await settle(); }
  assert.ok(kinds(wd).includes('deposit'), JSON.stringify(kinds(wd)));
}

test('float.earn: switched on through the USD balance (one more dialog); a routine float tick deposits the surplus; status shows liquid + Earn and "Earned"', async () => {
  const { wd, f } = await floatWorld();
  await assert.rejects(f.earn({ walletId: 'w1', action: 'on', to: '0x00' }), /unknown field/);
  const on = await f.earn({ walletId: 'w1', action: 'on', lang: 'en' });
  assert.equal(on.earn.on, true);
  await untilDeposit(wd, f);
  const st = await f.status({ walletId: 'w1', scope: 'account' });
  const rh = st.wallets[0].chains.robinhood;
  assert.ok(Math.abs(st.usd.total - 500) < 1, 'the total: the $500 less the fees of the top-up ' + JSON.stringify(st.usd));
  assert.ok(Math.abs(st.usd.cash - (rh.stable.liquidUsd + rh.earn.usd)) < 0.01, 'cash = liquid + Earn, counted once ' + JSON.stringify(rh));
  assert.ok(Math.abs(rh.stable.usd - st.usd.cash) < 0.01);
  assert.ok(Math.abs(rh.stable.liquidUsd - st.usd.cash * 0.15) < 0.01, 'B = 15 % stays liquid');
  // review M5: what may PAY a click is stated apart — the liquid part, and the part a click on this chain may take out first
  assert.ok(Math.abs(rh.stable.earnUsd - rh.earn.usd) < 0.01 && rh.stable.earnReadyUsd > 0 && rh.stable.earnReadyUsd <= rh.stable.earnUsd + 0.01, JSON.stringify(rh.stable));
  assert.ok(Math.abs(st.usd.earn - rh.earn.usd) < 0.01); assert.ok(Math.abs(st.usd.earned) < 0.01);
  assert.equal(st.earn.on, true); assert.equal(st.earn.vault, 'Steakhouse USDG');
  keyScan(wd, st);
});

test('float click: a $200 buy over the buffer withdraws from Earn FIRST, then the usual exact-approve top-up pays W; a $10 buy reads nothing of Earn', async () => {
  const { wd, f } = await floatWorld();
  await f.earn({ walletId: 'w1', action: 'on', lang: 'en' });
  await untilDeposit(wd, f);
  const n0 = wd.st.txs.length;
  const reads0 = wd.st.reads;
  const small = await f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 10, reason: 'click' });
  assert.equal(small.earn, undefined); assert.equal(wd.st.reads, reads0, 'a covered click: no Earn read');
  assert.ok(!kinds(wd).slice(n0).includes('withdraw'));
  wd.clock.t += 30_000; wd.click.lastTradeAt = wd.clock.t;
  const n1 = wd.st.txs.length;
  const big = await f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 200, reason: 'click' });
  assert.ok(big.earn && big.earn.usd > 100, JSON.stringify(big.earn));
  const after = kinds(wd).slice(n1);
  assert.equal(after[0], 'withdraw', 'the withdrawal comes first: ' + JSON.stringify(after));
  assert.ok(after.includes('swap'), 'then the top-up');
  const top = big.planned.find((m) => m.kind === 'topup'); assert.ok(top && top.usd >= 200, JSON.stringify(big.planned));
  assert.ok(!big.planned.some((m) => m.skipped), 'nothing short ' + JSON.stringify(big));
  assert.equal(n1, n0, 'the $10 buy: W already covered it, nothing sent');
});

test('float.off with money in Earn: every share comes back to R first, then the switch-off converts what is liquid', async () => {
  const { wd, f } = await floatWorld();
  await f.earn({ walletId: 'w1', action: 'on', lang: 'en' });
  await untilDeposit(wd, f);
  assert.ok(assetsOfR(wd) > 0n);
  const n = wd.st.txs.length;
  const off = await f.off({ walletId: 'w1' });
  assert.equal(assetsOfR(wd), 0n);
  const after = kinds(wd).slice(n);
  assert.equal(after[0], 'redeem', JSON.stringify(after));
  assert.ok(after.includes('swap'), 'converted back to ETH');
  assert.equal(off.earn.left, 0);
  assert.equal((await f.status({ walletId: 'w1', scope: 'account' })).earn.on, false);
});

test('no Earn dep (an older host): the float answers carry no earn field and its click path is untouched', async () => {
  const wd = makeEarnWorld();
  const f = createFloat(Object.assign(wd.floatDeps, { readyFloat: true, gasFromW: true }));
  await f.configure({ walletId: 'w1', chains: ['robinhood'] });
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k);
  const r = await f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 10, reason: 'click' });
  assert.equal(r.earn, undefined);
  const st = await f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st.earn, undefined); assert.equal(st.usd.earn, undefined);
  await assert.rejects(f.earn({ walletId: 'w1', action: 'on' }), /next wallet update/);
});

// ── source pins: the signer asks the allow-list again; Earn sits outside the frozen trade core ──
test('source: webEngine signs Earn only through earnSendR (allow-list, Robinhood only, gas cap) and float.earn is in the facade; no pinned file imports Earn', () => {
  const we = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const fn = we.slice(we.indexOf('async function earnSendR'), we.indexOf('async function earnMulti'));
  assert.ok(fn.indexOf('earnTxProblem') > 0 && fn.indexOf('earnTxProblem') < fn.indexOf('floatSendR('), 'the allow-list before the signer');
  assert.match(fn, /earnVenueOf\(CFG\.key\)/); assert.match(fn, /EARN\.gasMax/);
  assert.match(we, /send: earnSendR,/);
  assert.match(we, /earn: float\.earn, buy:/);
  for (const f of ['solEngine.ts', 'bnbRouter.ts', 'evmV4Router.ts', 'standardRouter.ts', 'v13Guards.ts', 'turboGas.ts']) {
    assert.ok(!/earn(Core|Engine)/.test(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')), f);
  }
  const fe = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8');
  assert.match(fe, /if \(urgent && deps\.earn && urgent\.chain === c && !clickWants\(\) && earnAsk && deps\.earn\.clickNeeds\(w, earnAsk\)\)/, 'the click step only with Earn wired and needed');
  // the Earn block of webEngine: the float's own client only (the bucket or the click path, both behind a running trade), R's
  // lane only (floatSendR), never a trade client, nonce sheet or send path
  const eb = we.slice(we.indexOf('// ── Earn on the USD balance (src/earnEngine.ts'), we.indexOf('earnApi = earn;'));
  assert.ok(eb.length > 2000);
  assert.ok(!/publicClient|heavyFor\(|heavy\.|nonceSheet|nextNonce\(|signAndSend\(|broadcast\(|mkTransport/.test(eb), 'Earn reaches a trade client');
  assert.ok(!/privateKeyToAccount|signTransaction/.test(eb), 'Earn handles a key itself');
  const readLines = eb.split('\n').filter((l) => /\(pc\) =>/.test(l));
  assert.ok(readLines.length >= 6);
  for (const l of readLines) assert.match(l, /floatRpc|floatNow|\brun\(/, 'a read outside the float client: ' + l);
  assert.equal([...eb.matchAll(/const run = now \? floatNow : floatRpc;/g)].length, 2);
  assert.match(we, /get earn\(\) \{ return earnApi; \},/);
  const ee = readFileSync(new URL('../src/earnEngine.ts', import.meta.url), 'utf8');
  assert.ok(!/privateKey|reserveKeyOf|signTransaction|localStorage|window\.|document\./.test(ee), 'earnEngine sees a key or the page');
  assert.ok(!/fetch\(|localStorage/.test(readFileSync(new URL('../src/earnCore.ts', import.meta.url), 'utf8')), 'earnCore is not pure');
  const bc = ee.slice(ee.indexOf('async function beforeClick'), ee.indexOf('// ── what the USD balance'));
  assert.ok(bc.indexOf('return null') < bc.indexOf('await'), 'beforeClick answers null before its first await');
  // floatEngine awaits Earn on a click only when the synchronous check (no read) says the click needs it
  const fc = fe.slice(fe.indexOf('const earnAsk = '), fe.indexOf('const earnAsk = ') + 900);
  assert.match(fc, /deps\.earn\.clickNeeds\(w, earnAsk\)\) \{\n(\s+\/\/[^\n]*\n)*\s+const e = await fastly\(\(\) => deps\.earn!\.beforeClick/, 'review M3: inside the click path\'s fast reads');
  const cn = ee.slice(ee.indexOf('function clickNeeds('), ee.indexOf('async function beforeClick'));
  assert.ok(!/await|deps\.evm|async/.test(cn), 'clickNeeds is synchronous and reads nothing');
});
