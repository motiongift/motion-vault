// Earn on the USD balance — the pure rules (src/earnCore.ts): the buffer, the plan, a click's withdrawal, the allow-list every
// Earn transaction passes (twice: earnEngine and R's signer), the vault checks, the receipt outcome checks, the switch's digest
// and arguments, and the six languages of its dialogs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import * as E from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';

const CFG = E.EARN_VAULTS.robinhood;
const R = '0x1111111111111111111111111111111111111111';
const EVIL = '0x2222222222222222222222222222222222222222';
const ctx = { r: R, chainId: 4663, cfg: CFG };
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';
const base = { on: true, exit: false, paused: false, liquid6: 0n, assets6: 0n, redeemable6: 0n, buffer6: 75n * USD, capRoom6: 1_000n * USD, dayIn6: 0n, txToday: 0, lastDepositAt: 0, lastWithdrawAt: 0, backoffUntil: 0, gasOk: true, geoOk: true, now: 10_000_000_000 };

test('pinned vault: Robinhood 4663, Steakhouse USDG, USDG 6 decimals, shares 18, the code hash read on 2026-11-03, max* = 0 by design', () => {
  assert.equal(CFG.chainId, 4663);
  assert.equal(CFG.vault, '0xBeEff033F34C046626B8D0A041844C5d1A5409dd');
  assert.equal(CFG.asset.toLowerCase(), '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  assert.equal(CFG.assetDecimals, 6); assert.equal(CFG.shareDecimals, 18); assert.equal(CFG.maxZero, true);
  assert.match(CFG.codeHash, /^0x3492098028b641c5/);
  assert.deepEqual(E.EARN_CHAINS, ['robinhood', 'bsc', 'sol']);
  assert.equal(E.earnVenueOf('robinhood').kind, 'erc4626'); assert.equal(E.earnVenueOf('bsc').kind, 'aave3'); assert.equal(E.earnVenueOf('sol').kind, 'kamino'); assert.equal(E.earnVenueOf('near'), null);
  assert.equal(E.earnCfgOf('bsc'), null); assert.equal(E.earnCfgOf('sol'), null); assert.equal(E.earnCfgOf(null), null);
  assert.deepEqual(E.EARN_SELECTORS, { approve: '0x095ea7b3', deposit: '0x6e553f65', withdraw: '0xb460af94', redeem: '0xba087652' });
});

test('buffer B = max(2 × the largest buy, 15 % of R, $25)', () => {
  assert.equal(E.bufferOf6([], 0n), 25n * USD);
  assert.equal(E.bufferOf6([10n * USD, 25n * USD], 100n * USD), 50n * USD);
  assert.equal(E.bufferOf6([10n * USD, 25n * USD], 500n * USD), 75n * USD);
  assert.equal(E.bufferOf6([200n * USD], 500n * USD), 400n * USD);
  assert.equal(E.bufferOf6([1n * USD], 20n * USD), 25n * USD);
});

test('plan: the surplus over B goes in, within one deposit, the day, the account cap; the gap and the minimum hold', () => {
  assert.deepEqual(E.earnPlan({ ...base, liquid6: 500n * USD }), { kind: 'deposit', usd6: 425n * USD, why: 'surplus' });
  assert.equal(E.earnPlan({ ...base, liquid6: 5_000n * USD }).usd6, 1_000n * USD, 'one deposit at most $1,000');
  assert.equal(E.earnPlan({ ...base, liquid6: 5_000n * USD, capRoom6: 300n * USD }).usd6, 300n * USD, 'the account cap');
  assert.equal(E.earnPlan({ ...base, liquid6: 5_000n * USD, dayIn6: 2_400n * USD }).usd6, 100n * USD, 'the day');
  assert.equal(E.earnPlan({ ...base, liquid6: 90n * USD }).kind, 'none', 'under $25 above B');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, capRoom6: 10n * USD }).why, 'cap');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, lastDepositAt: base.now - 60_000 }).why, 'gap');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, txToday: E.EARN.txPerDay }).why, 'limit-day');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, geoOk: false }).why, 'geo');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, on: false }).why, 'off');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, gasOk: false }).why, 'gas');
  assert.equal(E.earnPlan({ ...base, liquid6: 500n * USD, backoffUntil: base.now + 1 }).why, 'backoff');
});

test('plan: a paused Earn does nothing at all (funds stay); a refill comes before any deposit; the exit takes out what the vault can pay', () => {
  assert.deepEqual(E.earnPlan({ ...base, paused: true, liquid6: 500n * USD }), { kind: 'none', why: 'paused' });
  assert.deepEqual(E.earnPlan({ ...base, paused: true, liquid6: 1n * USD, assets6: 400n * USD, redeemable6: 400n * USD }), { kind: 'none', why: 'paused' });
  const refill = E.earnPlan({ ...base, liquid6: 20n * USD, assets6: 400n * USD, redeemable6: 400n * USD });
  assert.deepEqual(refill, { kind: 'withdraw', usd6: 55n * USD, why: 'refill' });
  assert.equal(E.earnPlan({ ...base, liquid6: 50n * USD, assets6: 400n * USD, redeemable6: 400n * USD }).kind, 'none', '50 is above 60 % of 75');
  assert.equal(E.earnPlan({ ...base, liquid6: 20n * USD, assets6: 400n * USD, redeemable6: 0n }).why, 'liquidity');
  assert.equal(E.earnPlan({ ...base, liquid6: 20n * USD, assets6: 400n * USD, redeemable6: 30n * USD }).usd6, 30n * USD, 'partial liquidity: what it can pay');
  assert.equal(E.earnPlan({ ...base, liquid6: 20n * USD, assets6: 400n * USD, redeemable6: 400n * USD, on: false }).kind, 'withdraw', 'a refill needs no consent');
  const exit = E.earnPlan({ ...base, exit: true, on: false, liquid6: 500n * USD, assets6: 400n * USD, redeemable6: 400n * USD, txToday: 99 });
  assert.deepEqual(exit, { kind: 'withdraw', usd6: 400n * USD, all: true, why: 'exit' });
  assert.equal(E.earnPlan({ ...base, exit: true, on: false, assets6: 400n * USD, redeemable6: 100n * USD }).all, undefined, 'a part, not all');
  assert.equal(E.earnPlan({ ...base, exit: true, on: false, assets6: 400n * USD, redeemable6: 0n }).why, 'liquidity');
});

test('a click withdraws what its top-up will want (need + 25 % + $1) less what R and W hold; 0 when they cover it', () => {
  assert.equal(E.clickWithdraw6(20n * USD, 75n * USD, 0n, 400n * USD, 400n * USD), 0n);
  assert.equal(E.clickWithdraw6(200n * USD, 75n * USD, 0n, 400n * USD, 400n * USD), 176n * USD);
  assert.equal(E.clickWithdraw6(200n * USD, 75n * USD, 50n * USD, 400n * USD, 400n * USD), 126n * USD);
  assert.equal(E.clickWithdraw6(1_000n * USD, 75n * USD, 0n, 400n * USD, 400n * USD), 400n * USD, 'never more than is in Earn');
  assert.equal(E.clickWithdraw6(1_000n * USD, 75n * USD, 0n, 400n * USD, 100n * USD), 100n * USD, 'never more than it can pay');
  assert.equal(E.clickWithdraw6(1_000n * USD, 75n * USD, 0n, 0n, 0n), 0n);
});

test('allow-list: approve(vault, ≤ one deposit) on USDG; deposit / withdraw / redeem with receiver = owner = R; value 0; nothing else', () => {
  const ok = (data, to = CFG.vault) => E.earnTxProblem({ to, data, value: 0n }, ctx);
  assert.equal(ok(E.approveData(CFG, 425n * USD), CFG.asset), null);
  assert.equal(ok(E.approveData(CFG, 0n), CFG.asset), null);
  assert.equal(ok(E.depositData(425n * USD, R)), null);
  assert.equal(ok(E.withdrawData(55n * USD, R)), null);
  assert.equal(ok(E.redeemData(10n ** 20n, R)), null);
  // refused
  assert.match(ok(E.approveData(CFG, 1_001n * USD), CFG.asset), /above one deposit/);
  assert.match(ok(E.approveData(CFG, (1n << 256n) - 1n), CFG.asset), /above one deposit/);
  assert.match(ok(encodeFunctionData({ abi: E.EARN_ABI, functionName: 'approve', args: [EVIL, 1n] }), CFG.asset), /another spender/);
  assert.match(ok(E.depositData(425n * USD, EVIL)), /receiver/);
  assert.match(ok(E.depositData(0n, R)), /out of bounds/);
  assert.match(ok(E.depositData(1_001n * USD, R)), /out of bounds/);
  assert.match(ok(encodeFunctionData({ abi: E.EARN_ABI, functionName: 'withdraw', args: [1n, EVIL, R] })), /receiver/);
  assert.match(ok(encodeFunctionData({ abi: E.EARN_ABI, functionName: 'withdraw', args: [1n, R, EVIL] })), /owner/);
  assert.match(ok(encodeFunctionData({ abi: E.EARN_ABI, functionName: 'redeem', args: [1n, EVIL, R] })), /receiver/);
  assert.match(ok(E.withdrawData(5_001n * USD, R)), /out of bounds/);
  assert.match(ok(E.depositData(1n, R), CFG.asset), /only approve/);
  assert.match(ok(E.approveData(CFG, 1n), EVIL), /not the vault/);
  assert.match(ok('0xa9059cbb' + pad(EVIL).slice(2) + w32(1), CFG.asset), /only approve/, 'transfer is not allowed');
  assert.match(ok('0x94bf804d' + w32(1) + pad(R).slice(2)), /selector not allowed/, 'mint is not allowed');
  assert.match(ok(E.depositData(1n, R) + '00'), /bad deposit/, 'extra calldata');
  assert.match(E.earnTxProblem({ to: CFG.vault, data: E.depositData(1n, R), value: 1n }, ctx), /value/);
  assert.match(E.earnTxProblem({ to: CFG.vault, data: E.depositData(1n, R), value: 0n }, { ...ctx, chainId: 56 }), /wrong chain/);
  assert.match(E.earnTxProblem({ to: CFG.vault, data: E.depositData(1n, R), value: 0n }, { ...ctx, cfg: null }), /not available/);
});

test('vault checks: another code hash, another asset, a gate set, a fee raised, a share price out of bounds or 0.5 % under its high-water mark', () => {
  const good = { codeHash: CFG.codeHash, asset: CFG.asset, gates: [ZERO, ZERO, ZERO, ZERO], performanceFee: 0n, managementFee: 0n, price6: 1_012_246n };
  assert.equal(E.vaultProblem(good, CFG, 0n), null);
  assert.equal(E.vaultProblem({ ...good, codeHash: null }, CFG, 0n), null, 'not re-read this time');
  assert.match(E.vaultProblem({ ...good, codeHash: '0x' + '00'.repeat(32) }, CFG, 0n), /contract/);
  assert.match(E.vaultProblem({ ...good, asset: EVIL }, CFG, 0n), /another asset/);
  assert.match(E.vaultProblem({ ...good, gates: [ZERO, ZERO, ZERO, EVIL] }, CFG, 0n), /gate/);
  assert.match(E.vaultProblem({ ...good, gates: [ZERO, null, ZERO, ZERO] }, CFG, 0n), /gate/, 'an unread gate counts as set');
  assert.match(E.vaultProblem({ ...good, performanceFee: 2n * 10n ** 17n }, CFG, 0n), /performance fee/);
  assert.match(E.vaultProblem({ ...good, managementFee: 1n }, CFG, 0n), /management fee/);
  assert.match(E.vaultProblem({ ...good, price6: 400_000n }, CFG, 0n), /out of bounds/);
  assert.equal(E.vaultProblem({ ...good, price6: 1_010_000n }, CFG, 1_012_246n), null, '0.22 % under: fine');
  assert.match(E.vaultProblem({ ...good, price6: 1_006_000n }, CFG, 1_012_246n), /dropped/);
});

test('receipt outcomes: exactly the amount from R to the vault and the shares to R; a withdrawal pays R what it records', () => {
  const V = CFG.vault, A = CFG.asset; const T = E.TOPIC;
  const tr = (token, from, to, n) => ({ address: token, topics: [T.transfer, pad(from), pad(to)], data: '0x' + w32(n) });
  const dep = (sender, owner, a, s) => ({ address: V, topics: [T.deposit, pad(sender), pad(owner)], data: '0x' + w32(a) + w32(s) });
  const wd = (sender, rcv, owner, a, s) => ({ address: V, topics: [T.withdraw, pad(sender), pad(rcv), pad(owner)], data: '0x' + w32(a) + w32(s) });
  assert.deepEqual(E.depositOutcome([tr(A, R, V, 100), tr(V, ZERO, R, 99), dep(R, R, 100, 99)], CFG, R, 100n, 98n), { shares: 99n });
  assert.ok('why' in E.depositOutcome([tr(A, R, V, 101), dep(R, R, 100, 99)], CFG, R, 100n, 98n), 'paid another amount');
  assert.ok('why' in E.depositOutcome([tr(A, R, V, 100), tr(A, R, EVIL, 5), dep(R, R, 100, 99)], CFG, R, 100n, 98n), 'something else left R');
  assert.ok('why' in E.depositOutcome([tr(A, R, V, 100), dep(R, EVIL, 100, 99)], CFG, R, 100n, 98n), 'shares to someone else');
  assert.ok('why' in E.depositOutcome([tr(A, R, V, 100), dep(R, R, 100, 50)], CFG, R, 100n, 98n), 'fewer shares');
  assert.ok('why' in E.depositOutcome([tr(A, R, V, 100)], CFG, R, 100n, 98n), 'no Deposit event');
  assert.deepEqual(E.withdrawOutcome([tr(V, R, ZERO, 50), tr(A, V, R, 55), wd(R, R, R, 55, 50)], CFG, R, 55n, 51n), { assets: 55n, shares: 50n });
  assert.ok('why' in E.withdrawOutcome([tr(A, V, R, 27), wd(R, R, R, 55, 50)], CFG, R, 55n, 51n), 'R got less than recorded');
  assert.ok('why' in E.withdrawOutcome([tr(A, V, R, 55), wd(R, EVIL, R, 55, 50)], CFG, R, 55n, 51n), 'paid to someone else');
  assert.ok('why' in E.withdrawOutcome([tr(A, V, R, 55), wd(R, R, R, 55, 60)], CFG, R, 55n, 51n), 'burnt more shares');
  assert.ok('why' in E.withdrawOutcome([tr(A, V, R, 54), wd(R, R, R, 54, 50)], CFG, R, 55n, 51n), 'paid less than simulated');
  assert.equal(E.principalAfter(400n, 1000n, 250n), 300n);
  assert.equal(E.principalAfter(400n, 1000n, 1000n), 0n);
});

test('the switch: a whole grant only (digest, rules, dates, cap bounds); float.earn arguments; dialogs in six languages, risks and no promise', () => {
  const now = 1_800_000_000_000;
  const body = { v: 1, on: true, cap6: String(1_000n * USD), chains: ['robinhood', 'sol'], grantedAt: now - 1, expiresAt: now + 1_000, rules: E.EARN_RULES };
  const g = { ...body, digest: E.earnDigest(body) };
  assert.equal(E.earnLive(g, now), true);
  assert.equal(E.earnLive({ ...g, cap6: String(9_000n * USD) }, now), false, 'tampered cap');
  assert.equal(E.earnLive({ ...g, chains: ['robinhood', 'sol', 'bsc'] }, now), false, 'tampered chains');
  assert.equal(E.earnLive({ ...g, chains: [] }, now), false, 'no chain');
  assert.equal(E.earnLive({ ...g, expiresAt: now - 1 }, now), false);
  assert.equal(E.earnLive(null, now), false);
  assert.deepEqual(E.earnArgs({ walletId: 'w1', action: 'on', lang: 'ru', cap: 500 }), { walletId: 'w1', action: 'on', lang: 'ru', cap6: 500n * USD, chains: null, hours: null });
  assert.deepEqual(E.earnArgs({ walletId: 'w1', action: 'off', chains: ['bsc'] }).chains, ['bsc']);
  assert.equal(E.earnArgs({ walletId: 'w1', action: 'history' }).action, 'history');
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'on', chains: ['eth'] }), /chains/);
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'on', chains: ['sol', 'sol'] }), /chains/);
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'on', to: EVIL }), /unknown field to/);
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'deposit' }), /action/);
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'on', cap: 50_000 }), /cap/);
  assert.throws(() => E.earnArgs({ walletId: 'w1', action: 'on', lang: 'de' }), /lang/);
  assert.throws(() => E.earnArgs([]), /plain object/);
  for (const lang of ['en', 'ru', 'zh', 'id', 'es', 'fr']) {
    const html = E.earnOnHtml(lang, 1_000n * USD, (v) => String(v));
    // r6.1 (owner's rule): no figure — the rate is variable, read from each venue, never promised
    assert.ok(!/3–6/.test(html), lang + ': no unmeasured rate figure');
    assert.match(html, /—/, lang + ': the "read from each venue — never promised" line');
    assert.match(html, /\$1,000\.00/, lang + ': the cap');
    assert.match(html, /\$25/, lang + ': the buffer floor');
    assert.match(html, /Morpho/, lang);
    assert.ok(html.length > 250, lang);
    const W = E.EARN_WORDS[lang];
    for (const k of ['onTitle', 'onOk', 'offTitle', 'offOk', 'risk', 'us']) assert.ok(String(W[k]).length > 3, lang + ' ' + k);
    assert.ok(E.earnOffHtml(lang, 425n * USD, String).includes('$425.00'), lang);
  }
  assert.match(E.EARN_WORDS.en.risk, /smart-contract/); assert.match(E.EARN_WORDS.en.risk, /credit risk/); assert.match(E.EARN_WORDS.en.risk, /no insurance/); assert.match(E.EARN_WORDS.en.risk, /delayed/);
  assert.match(E.EARN_WORDS.en.lines('$1', 'x')[0], /variable rate, read from each venue — never promised/);
  // r6.1 (owner's rule): no unmeasured, promise-like rate figure in any language's dialog
  for (const l of ['en', 'ru', 'zh', 'id', 'es', 'fr']) { const W = E.EARN_WORDS[l]; const all = [...W.lines('$1', 'x'), W.risk, W.device, W.session('x'), ...W.sessionLines('$1', '$0', 'x', 'y'), W.reuse('y')].join(' '); assert.ok(!/\d\s*[–-]\s*\d+\s*%|%\s*(a year|годовых|per tahun|anual|par an)|年化/.test(all), l + ': a rate figure in the copy'); }
  assert.match(E.EARN_WORDS.en.us, /United States/);
});
