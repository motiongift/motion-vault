// r3: the re-review of r2 (local earn-review/review-r2.txt) — one test per item, and the reviewer's reproductions G1, G2, G3
// (local earn-review/tests/review-r2.mjs) passing THE SAFE WAY (its assertions inverted). Mocked chains only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { createEarn } from '../src/earnEngine.ts';
import { EARN, depositData } from '../src/earnCore.ts';
import { AAVE_BSC, aaveSupplyData } from '../src/earnAave.ts';
import { KAMINO_SOL } from '../src/earnKamino.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, CFG, lc } from './fixtures/earn-world.mjs';
import { makeAaveWorld, makeKaminoWorld } from './fixtures/earn-world2.mjs';

const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e, floatOn = true) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn });
const src = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
// a third party's own transaction on the mocked chain (it signs with ITS key; nothing of R's) — the reviewer's helper
function thirdParty(wd, from, tx) {
  const nonce = wd.st.nonces.get(lc(from)) ?? 0; wd.st.nonces.set(lc(from), nonce + 1);
  const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}`));
  const { logs } = wd.exec(from, tx, true);
  wd.st.txs.push({ from, ...tx, gas: 200_000n, hash, status: 'success', block: BigInt(wd.st.txs.length + 1) });
  wd.st.receipts.set(hash, { status: 'success', logs });
  return hash;
}
const X = '0x000000000000000000000000000000000000bEEF';
function grief(wd, amount = 1_000_000n) {   // $1 of USDG deposited by X FOR R (deposit(assets, receiver = R): anyone may)
  wd.st.usdg.set(lc(X), amount); wd.st.allow.set(`${lc(X)}>${lc(CFG.vault)}`, amount);
  return thirdParty(wd, X, { to: CFG.vault, data: depositData(amount, wd.R), value: 0n });
}

// ══ N1 (HIGH): a stranger's move for R is a gift, never "another device", never a stop ══
test('N1 / G1: a stranger deposits $1 FOR R — the device stays active: it refills, and "Earned" stays known', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  wd.clock.t += 20 * 60_000; await tick(wd, e);
  grief(wd);
  wd.st.usdg.set(lc(wd.R), 1_000_000n);
  let withdrew = 0;
  for (let i = 0; i < 20; i++) { wd.clock.t += 3 * 60_000; const r = await tick(wd, e); if (r.step === 'withdraw') withdrew++; }
  const st = e.status(wd.wallet, 'robinhood');
  assert.notEqual(st.foreign, true, 'G1 (reviewer: passive)'); assert.ok(withdrew >= 1, 'G1 (reviewer: 0 refills)');
  assert.ok(st.earned != null);
});

test('N1 / G2: a stranger\'s deposit for R landing between R\'s deposit and its position read — no stop; a click still withdraws', async () => {
  const wd = makeEarnWorld();
  const send0 = wd.earnDeps.evm.send; let armed = true;
  const deps = { ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas) => { const h = await send0(id, tx, gas); if (armed && String(tx.data).startsWith('0x6e553f65')) { armed = false; grief(wd); } return h; } } };
  const e = createEarn(deps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  for (let i = 0; i < 15; i++) { wd.clock.t += 60_000; await tick(wd, e); }
  const st = e.status(wd.wallet, 'robinhood');
  assert.notEqual(st.cls, 'hard', 'G2 (reviewer: hard)'); assert.equal(st.verifying, undefined);
  const c = await e.beforeClick(wd.wallet, { need6: 400n * USD, liquidRaw: 0n, wReady6: 0n });
  assert.ok(c && 'usd' in c && c.usd > 0, 'G2: the click withdraws (reviewer: "Earn is paused") ' + JSON.stringify(c));
});

test('N1 / G3: Solana — a stranger\'s transaction that merely lists R\'s cToken account is not "another device"; one R signed is', async () => {
  const wk = makeKaminoWorld(); const e = createEarn(wk.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wk, e)).step, 'deposit');
  const sig = 'StrangerSig' + '1'.repeat(70); wk.st.sent.push({ ixs: [], sig, at: wk.clock.t + 1 }); wk.st.sigs.set(sig, 'confirmed');
  wk.clock.t += EARN.gapMs + 1; wk.st.usdc += 300_000_000n;
  const r = await tick(wk, e);
  assert.notEqual(r.why, 'another-device', 'G3 (reviewer: another-device)'); assert.equal(r.step, 'deposit');
  // the same wallet's R signing elsewhere (another device) still is
  const sig2 = 'OtherDevice' + '2'.repeat(70); wk.st.sent.push({ ixs: [], sig: sig2, at: wk.clock.t + 1, signer: wk.R }); wk.st.sigs.set(sig2, 'confirmed');
  wk.clock.t += EARN.gapMs + 1; wk.st.usdc += 300_000_000n;
  assert.equal((await tick(wk, e)).why, 'another-device');
});

test('N1: Aave — a stranger\'s supply on behalf of R is not "another device" and never stops Earn; R\'s own supply from elsewhere is', async () => {
  const wa = makeAaveWorld(); const e = createEarn(wa.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wa, e)).step, 'deposit');
  const amt = 10n ** 18n;
  wa.st.usdc.set(lc(X), amt); wa.st.allow.set(`${lc(X)}>${lc(AAVE_BSC.pool)}`, amt);
  const { logs } = wa.exec(X, { to: AAVE_BSC.pool, data: aaveSupplyData(AAVE_BSC, amt, wa.R), value: 0n }, true);
  const h = '0x' + '55'.repeat(32); wa.st.txs.push({ from: X, to: AAVE_BSC.pool, data: '0x', hash: h, status: 'success', block: BigInt(wa.st.txs.length + 1) }); wa.st.receipts.set(h, { status: 'success', logs });
  wa.clock.t += EARN.gapMs + 1; wa.st.usdc.set(lc(wa.R), (wa.st.usdc.get(lc(wa.R)) ?? 0n) + 300n * 10n ** 18n);
  const r = await tick(wa, e);
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.notEqual(e.status(wa.wallet, 'bsc').foreign, true);
});

test('N1: Kamino — kUSDC dust sent to R\'s cToken account right after R\'s redeem never stops Earn', async () => {
  const wk = makeKaminoWorld(); let gift = true; const send0 = wk.earnDeps.sol.send;
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, send: async (id, ixs) => { const s = await send0(id, ixs); if (gift && wk.st.sent.length === 2) { gift = false; wk.st.c += 5n; } return s; } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wk, e);
  wk.st.usdc = 1_000_000n; wk.clock.t += 61_000;
  const r = await tick(wk, e); assert.equal(r.step, 'withdraw', JSON.stringify(r));
  for (let i = 0; i < 12; i++) { wk.clock.t += 61_000; await tick(wk, e); }
  assert.notEqual(e.status(wk.wallet, 'sol').cls, 'hard');
});

// ══ M-a: BNB log ranges ══
test('M-a: a node that caps eth_getLogs ranges — the scan halves its chunk and catches up; a scan that cannot read never holds back a refill', async () => {
  const wd = makeEarnWorld(); let refused = 0; const logs0 = wd.earnDeps.evm.logs;
  const capped = async (q) => { if (q.toBlock - q.fromBlock + 1n > 5_000n) { refused += 1; throw new Error('exceed maximum block range: 5000'); } return logs0(q); };
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, logs: capped, head: async () => 200_000n } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  // away for an hour and a half (scan cursor ~21,000 blocks back)
  wd.store.set('trenches.earn.v2.w.robinhood.' + lc(wd.R), JSON.stringify({ ...JSON.parse(wd.store.get('trenches.earn.v2.w.robinhood.' + lc(wd.R))), scan: { block: String(200_000n - 21_000n) } }));
  let r; for (let i = 0; i < 4; i++) { wd.clock.t += 61_000; r = await tick(wd, e); if (r.step === 'deposit') break; }
  assert.equal(r.step, 'deposit', JSON.stringify(r)); assert.ok(refused >= 1 && refused <= 2, 'halved once: ' + refused);
  assert.equal(EARN.scanChunk.bsc, 2_000n, 'BNB reads 2,000 blocks at a time (48 Club caps at 5,000)');
  // a node that refuses every log read: deposits wait, a refill goes on
  const e2 = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, logs: async () => { throw new Error('403'); }, head: async () => 300_000n } });
  wd.st.usdg.set(lc(wd.R), 1_000_000n); wd.clock.t += 61_000;
  assert.equal((await tick(wd, e2)).step, 'withdraw', 'the refill does not wait for the scan');
});

// ══ M-b (engine side): the monitor's hold ══
test('M-b: the monitor\'s "hold" (a cap raised on a market in use) = no new deposits after two answers, NO exit; it clears with the monitor', async () => {
  const wd = makeEarnWorld(); let hold = null;
  const e = createEarn({ ...wd.earnDeps, monitor: async () => ({ robinhood: hold ? { hold } : {} }) });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e); const sh = wd.st.shares.get(lc(wd.R));
  hold = 'Morpho: the curator raised a cap (increaseAbsoluteCap)';
  for (let i = 0; i < 3; i++) { wd.clock.t += EARN.gapMs + 1; wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 200_000_000n); await tick(wd, e); }
  const st = e.status(wd.wallet, 'robinhood');
  assert.equal(st.cls, 'changed'); assert.ok((wd.st.shares.get(lc(wd.R)) ?? 0n) >= sh, 'nothing withdrawn');
  const n = wd.st.txs.length; wd.clock.t += EARN.gapMs + 1; await tick(wd, e); assert.equal(wd.st.txs.length, n, 'no deposit');
  hold = null; wd.clock.t += EARN.gapMs + 1; await tick(wd, e);
  assert.equal(e.status(wd.wallet, 'robinhood').paused, undefined);
});

// ══ LOW ══
test('L-a: Kamino lowered its rate (a socialized loss) while its Reserve cannot be parsed — the user is told the figure; his second withdraw accepts it', async () => {
  const wk = makeKaminoWorld();
  let broken = false; const acc0 = wk.earnDeps.sol.accounts;
  const accounts = async (addrs, now) => { const r = await acc0(addrs, now); return addrs.map((a, i) => (broken && a === KAMINO_SOL.reserve ? { ...r[i], data: new Uint8Array(9000) } : r[i])); };
  const e = createEarn({ ...wk.earnDeps, sol: { ...wk.earnDeps.sol, accounts } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wk, e); const c0 = wk.st.c;
  broken = true; wk.st.borrowed = (wk.st.borrowed * 95n) / 100n;   // −5 % of the reserve's loans written off
  const one = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.match(one.why.join(' '), /Kamino would pay \$.* Withdraw again within 10 minutes to accept it/); assert.equal(wk.st.c, c0, 'nothing redeemed without his yes');
  await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.equal(wk.st.c, 0n, 'the second withdraw accepted the simulated amount');
});

test('L-b: the lock not free in 10 s — the user\'s withdraw says so (never silent)', async () => {
  const wd = makeEarnWorld(); const e0 = createEarn(wd.earnDeps);
  await e0.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await tick(wd, e0);
  const e = createEarn({ ...wd.earnDeps, lock: async () => null });
  const off = await e.configure({ action: 'off', lang: 'en', cap6: null, floatOn: true });
  assert.match(off.why.join(' '), /an Earn step is still running/);
});

test('L-d: a send that went out but answered an error WITHOUT its hash — the move it made is taken as this device\'s own, not another device\'s', async () => {
  const wd = makeEarnWorld(); const send0 = wd.earnDeps.evm.send; let once = true;
  const e = createEarn({ ...wd.earnDeps, evm: { ...wd.earnDeps.evm, send: async (id, tx, gas) => { const h = await send0(id, tx, gas); if (once && String(tx.data).startsWith('0x6e553f65')) { once = false; throw new Error('the node returned a different transaction hash'); } return h; } } });
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  await tick(wd, e);
  wd.clock.t += EARN.backoffMs + 1; wd.st.usdg.set(lc(wd.R), (wd.st.usdg.get(lc(wd.R)) ?? 0n) + 300_000_000n);
  const r = await tick(wd, e);
  assert.notEqual(r.why, 'another-device', JSON.stringify(r)); assert.notEqual(e.status(wd.wallet, 'robinhood').foreign, true);
  assert.equal(e.status(wd.wallet, 'robinhood').earned, null, 'the unbooked deposit: "Earned" unknown, honestly');
});

test('L-e: a passive device never withdraws for a click (it would make the active device passive) and its Earn is not counted to pay one', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }); await tick(wd, e);
  const k = 'trenches.earn.v2.w.robinhood.' + lc(wd.R);
  wd.store.set(k, JSON.stringify({ ...JSON.parse(wd.store.get(k)), foreign: { at: wd.clock.t, why: 'another device' } }));
  const n = wd.st.txs.length;
  const c = await e.beforeClick(wd.wallet, { need6: 400n * USD, liquidRaw: 0n, wReady6: 0n });
  assert.match(String(c?.why), /another device/); assert.equal(wd.st.txs.length, n);
  assert.match(src('floatEngine.ts'), /!er\.verifying && !er\.foreign/);
});

// EARN_MVP_DIR = a local checkout of the earn-mvp app + server copies (skipped without it)
const EARN_MVP = process.env.EARN_MVP_DIR || '';
test('L-c (app copy) and the monitor\'s Permit: source checks', { skip: !EARN_MVP }, () => {
  const app = readFileSync(EARN_MVP + '/app/src/i18n/copy/earn.ts', 'utf8');
  assert.match(app, /withdrawNow: \['Withdraw and turn off Earn on \{chain\}'/);
  assert.match(readFileSync(EARN_MVP + '/trench/server/earn-monitor.mjs', 'utf8'), /'0x40336af4b170f3dad5ddfb59897a8289adc3bed01417ca7e2bd77f85bc526413'\]\);/);
});
