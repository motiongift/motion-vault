// rel-12 commit 1 (2026-11-06, owner “make it work without failures”): the routes of a ready-dollar (READY) move — each with its own quote clock
// and cost bound (floatCore READY_ROUTES), Relay asked for a 0.25 % minimum, the cost counted as what the move takes out of the
// amount. Numbers from Relay's public request history and deBridge's quotes on 2026-11-06 (local rel12/logs).
//   node --experimental-strip-types --test test/ready-rel12-routes.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
import { readyWorld, usdg, lc, RH, BSCC } from './fixtures/ready-world.mjs';

test('READY_ROUTES: Relay 12 s / deBridge 8 s, a 0.25 % minimum asked, cost bound $0.10 + 0.75 % (the measured BNB -> Robinhood cost fits $10-$250)', () => {
  assert.equal(F.READY_ROUTES.relay.quoteMs, 12_000); assert.equal(F.READY_ROUTES.debridge.quoteMs, 8_000);
  assert.equal(F.READY_ROUTES.relay.slipBps, 25);
  assert.equal(F.readyFeeMax6(F.usd6(10)), F.usd6(0.175)); assert.equal(F.readyFeeMax6(F.usd6(250)), F.usd6(1.975));
  assert.equal(F.readyFeeMax6(F.usd6(250), 'debridge'), F.usd6(1.975));
  // measured (Relay, BNB USDT -> Robinhood USDG): $0.025 + 0.41 % stated, delivered 0.156 % further under; + ~$0.015 of R's gas
  const cost = (usd) => usd - (usd - (0.025 + usd * 0.0041) - usd * 0.00156) + 0.015;
  for (const usd of [10, 15, 50, 100, 150, 250]) assert.ok(F.usd6(cost(usd)) <= F.readyFeeMax6(F.usd6(usd)), `$${usd}: ${cost(usd).toFixed(3)}`);
  // deBridge as measured ($0.28 + 0.005 BNB ~ $5): never fits — it is the last route, asked only after Relay refused
  for (const usd of [15, 50, 150, 250]) assert.ok(F.usd6(0.28 + 5) > F.readyFeeMax6(F.usd6(usd), 'debridge'));
  assert.equal(F.isReadyRoute('relay'), true); assert.equal(F.isReadyRoute('motion'), false, 'motion\'s bridge pays native into W: no ready route');
  assert.equal(F.readyCost6(F.usd6(100), F.usd6(99.41), F.usd6(0.43)), F.usd6(0.59), 'the delivery\'s shortfall when it is more than the stated fees');
  assert.equal(F.readyCost6(F.usd6(100), F.usd6(99.8), F.usd6(0.23)), F.usd6(0.23), 'else the stated fees');
});

test('before / after on the measured quote: rel-10 refused it at the floor (Relay\'s 0.50 % minimum = the vault\'s 0.50 % bound), rel-12 passes the same check', () => {
  const in6 = F.usd6(150), stated6 = F.usd6(0.025 + 150 * 0.0041), out6 = in6 - stated6 - (in6 * 156n) / 100_000n;
  const outRaw = F.usd6ToStable(out6, BSCC.stable.decimals);
  const q = (minOut, fees6) => ({ bridge: 'relay', route: 'robinhood>bsc', amountIn: usdg(150), out: outRaw, minOut, fees6, etaMs: 4000, recipient: '0x' + '22'.repeat(20), requestId: '', outDecimals: BSCC.stable.decimals });
  const want = { from: 'robinhood', to: 'bsc', signer: '0x' + '11'.repeat(20), recipient: '0x' + '22'.repeat(20), amountIn: usdg(150), stableIn: RH.stable.address, maxSlipBps: 50, feeRoom6: 10n ** 15n };
  // rel-10: minimum at 0.50 %, fees = the stated ones + gas
  assert.equal(F.verifyBridgeQuote(q((outRaw * 9950n) / 10_000n, stated6 + F.usd6(0.005)), want), 'The quote is below the amount minus fees and slippage');
  // rel-12: minimum at 0.25 %, the cost = the delivery's shortfall + gas; the vault's own floor (0.50 %) unchanged
  assert.equal(F.verifyBridgeQuote(q((outRaw * 9975n) / 10_000n, F.readyCost6(in6, out6, stated6) + F.usd6(0.005)), want), null);
});

test('engine: the measured BNB-like quote ($150, 0.156 % short) is signed — Relay asked for 25 bps, the ledger counts what the move really cost', async () => {
  const wd = readyWorld({ relayFeeUsd: 0.025, relayPct: 0.0041, shortBps: 16 });   // 0.156 % ~ 16 bps
  await wd.on(); wd.tradedBsc(); wd.bscSnap(0);
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 1, JSON.stringify(await wd.jobs()));
  assert.equal(wd.ch.deposits[0].amount, usdg(150), '1.5 x the $100 buy');
  assert.equal(wd.relay.bodies[0].slippageTolerance, '25');
  assert.equal(lc(wd.relay.bodies[0].recipient), lc(wd.R), 'into this wallet\'s own reserve on BNB');
  const j = (await wd.jobs()).find((x) => x.kind === 'rebalance');
  assert.equal(j.ready, true); assert.equal(j.state, 'relaying'); assert.equal(j.bridge, 'relay');
  const fee = Number(j.fee6) / 1e6;
  // 0.025 + 0.615 stated = 0.64; shortfall 0.64 + 0.24 = 0.88 (> stated) + 0.005 gas (+ the plan's gas estimate)
  assert.ok(fee >= 0.885 && fee < 1.0, 'the cost, not only the stated fee: ' + fee);
});

test('engine: a cost over the bound is never signed (Relay at 1 % for $150: $1.53 > $1.225); deBridge ($4.28) does not fit either', async () => {
  const wd = readyWorld({ relayFeeUsd: 0.03, relayPct: 0.01 }); await wd.on(); wd.tradedBsc(); wd.bscSnap(0);
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 0); assert.equal(wd.ch.txs.length, 0, 'no approval either');
  assert.ok(wd.fetchLog.some((u) => u.startsWith('https://dln.debridge.finance')), 'deBridge was asked after Relay');
});

test('engine: a Relay quote that takes 6 s is used (its 12 s clock; a click\'s 5 s clock cut it off before)', { timeout: 30_000 }, async () => {
  const wd = readyWorld({ delayMs: 6_000 }); await wd.on(); wd.tradedBsc(); wd.bscSnap(0);
  await wd.tick();
  for (let i = 0; i < 80 && !wd.ch.deposits.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(wd.ch.deposits.length, 1);
  assert.ok(!wd.fetchLog.some((u) => u.startsWith('https://dln.debridge.finance')), 'no fall-through to deBridge');
});
