// Terminal fee leg (fee-sprint "bypass", 2026-11-09): the fee-paying replacement for the UNCOVERED limit / TP / SL path, plus the
// pure fee helpers (rate, entitlement fail-closed, Relay app-fee floor). Default off = byte-for-byte the behaviour of before.
//   node --experimental-strip-types --test test/terminal-fee-leg.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction } from 'viem';
import { limitWorld, TOKEN, E } from './fixtures/limit-world.mjs';
import { checkPosted } from '../src/limitCore.ts';
import {
  feeOf, feeLegFor, feeLegConfigProblem, bpsFor, entitlementText, relayAppFeeProblem, TERMINAL_FEE_LEG, FEE_TIERS_BPS,
} from '../src/terminalFeeLeg.ts';
import { readFileSync } from 'node:fs';

const COLLECTOR = '0x74f25914dccE21555188B523748D3B3f557ed297'.toLowerCase();
const DUST = 5_000_000_000_000n;
const buy = (w, key, leg) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: (w.chain.price() * 0.9).toFixed(15), amount: '0.05', expiresIn: 86400, route: w.route, idempotencyKey: key });
const sell = (w, key) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'sell', kind: 'tp', price: (w.chain.price() * 1.2).toFixed(15), amount: '20000', slippageBps: 300, expiresIn: 86400, route: w.route, idempotencyKey: key });
const recOf = (w) => Object.values(JSON.parse([...w.store.entries()].find(([k]) => k === 'trenches.limit.v1.robinhood')[1]))[0];
const postedOf = (w, id) => w.keeper.orders.get(id);

// ── the config and the leg ──
test('the shipped config is OFF on every chain; feeLegFor is null, so a placement is exactly the one of before', () => {
  for (const c of ['robinhood', 'bsc', 'sol']) assert.equal(TERMINAL_FEE_LEG.enabled[c], false);
  assert.equal(feeLegConfigProblem(TERMINAL_FEE_LEG), '');
  assert.equal(feeLegFor('robinhood'), null);
  assert.equal(feeLegFor('bsc'), null);
  assert.equal(feeLegFor('sol'), null);
});

test('feeLegFor: on with a collector gives the leg; on without one throws (never a fee-free trade); off is null', () => {
  const on = { ...TERMINAL_FEE_LEG, enabled: { robinhood: true, bsc: false, sol: false } };
  const leg = feeLegFor('robinhood', on);
  assert.equal(leg.collector, COLLECTOR); assert.equal(leg.baseBps, 20);
  const bad = { ...TERMINAL_FEE_LEG, enabled: { robinhood: false, bsc: true, sol: false } };   // bsc collector is null
  assert.throws(() => feeLegFor('bsc', bad), /not configured/);
});

test('feeOf: 20/15/10/5/0 bps, floored, never above the basis; a non-tier rate throws', () => {
  assert.equal(feeOf(1_000_000n, 20), 2000n);
  assert.equal(feeOf(1_000_000n, 15), 1500n);
  assert.equal(feeOf(1_000_000n, 5), 500n);
  assert.equal(feeOf(1_000_000n, 0), 0n);
  assert.equal(feeOf(3n, 20), 0n);   // floor
  assert.throws(() => feeOf(1n, 17), /bad fee rate/);
});

// ── entitlements: a signed discount, fail-closed to the base rate ──
test('bpsFor: base rate with no entitlement / no signer; a valid tier entitlement lowers it; anything wrong is the base rate', async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const cfg = { ...TERMINAL_FEE_LEG, enabled: { robinhood: true, bsc: false, sol: false }, entitlementSigner: signer.address };
  const leg = feeLegFor('robinhood', cfg);
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const now = Date.UTC(2026, 10, 9);
  const mk = async (over = {}) => {
    const body = { chain: 'robinhood', wallet, bps: 10, notBefore: Math.floor(now / 1000) - 10, expiresAt: Math.floor(now / 1000) + 600, policyId: cfg.policyId, ...over };
    const sig = await signer.signMessage({ message: entitlementText(body) });
    return { ...body, sig };
  };
  // no signer pinned → base
  assert.deepEqual(await bpsFor({ leg, wallet, entitlement: await mk(), nowMs: now }, { ...cfg, entitlementSigner: null }), { bps: 20, source: 'base', reason: 'no signer pinned' });
  // none → base
  assert.equal((await bpsFor({ leg, wallet, entitlement: null, nowMs: now }, cfg)).bps, 20);
  // valid 10-bps entitlement → 10
  assert.deepEqual(await bpsFor({ leg, wallet, entitlement: await mk(), nowMs: now }, cfg), { bps: 10, source: 'entitlement' });
  // another wallet → base
  const other = await mk({ wallet: privateKeyToAccount(generatePrivateKey()).address });
  assert.equal((await bpsFor({ leg, wallet, entitlement: other, nowMs: now }, cfg)).reason, 'another wallet');
  // expired → base
  assert.equal((await bpsFor({ leg, wallet, entitlement: await mk({ expiresAt: Math.floor(now / 1000) - 1 }), nowMs: now }, cfg)).reason, 'window');
  // tampered rate (signature no longer matches) → base
  const t = await mk(); t.bps = 0;
  assert.equal((await bpsFor({ leg, wallet, entitlement: t, nowMs: now }, cfg)).reason, 'signature');
  // a rate off the tier list → base
  assert.equal((await bpsFor({ leg, wallet, entitlement: await mk({ bps: 7 }), nowMs: now }, cfg)).reason, 'rate');
});

// ── the EVM limit / TP / SL replacement: the order carries a fee tx the keeper enforces ──
test('OFF: a placed order has no fee tx and the keeper accepts it with no fee policy (regression)', async () => {
  const w = limitWorld();
  const { order: o } = await buy(w, 'off-000001');
  const posted = postedOf(w, o.orderId);
  assert.ok(!posted.txs.find((t) => t.role === 'fee'), 'no fee tx when the leg is off');
  await assert.doesNotReject(checkPosted(posted, w.clock.t, 'robinhood', null));
});

test('ON: a limit buy carries a fee tx of 0.20% one nonce after the swap, to the collector; the keeper accepts it under the base policy', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buy(w, 'on-order-0001');
  const posted = postedOf(w, o.orderId);
  const fee = posted.txs.find((t) => t.role === 'fee');
  assert.ok(fee, 'a fee tx is pre-signed');
  const p = parseTransaction(fee.raw);
  assert.equal(p.to.toLowerCase(), COLLECTOR);
  assert.equal(Number(fee.nonce), Number(o.swapNonce) + 1, 'the fee sits right after the swap');
  // 0.20% of the buy size (0.05 ETH)
  assert.equal(p.value, E(0.05) * 20n / 10000n);
  await assert.doesNotReject(checkPosted(posted, w.clock.t, 'robinhood', { collector: COLLECTOR, minBps: 20, required: true }));
});

test('ON: the keeper refuses a tampered fee (too low), a wrong collector, and a missing fee; it accepts a higher-tier wallet paying less', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buy(w, 'on-order-0002');
  const posted = postedOf(w, o.orderId);
  const policy = { collector: COLLECTOR, minBps: 20, required: true };
  // a tampered order: drop the fee tx entirely → refused (required, 20 bps)
  const noFee = { ...posted, txs: posted.txs.filter((t) => t.role !== 'fee') };
  await assert.rejects(checkPosted(noFee, w.clock.t, 'robinhood', policy), /no terminal fee/);
  // a wallet the server grants 0 bps: the SAME order (with its 20-bps fee) is still fine (fee ≥ minBps, ≤ 20)
  await assert.doesNotReject(checkPosted(posted, w.clock.t, 'robinhood', { collector: COLLECTOR, minBps: 0, required: true }));
  // a 10-bps order posted to a 20-bps policy → refused (under this wallet's rate)
  const w2 = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 10 } });
  const { order: o2 } = await buy(w2, 'on-order-0003');
  await assert.rejects(checkPosted(postedOf(w2, o2.orderId), w2.clock.t, 'robinhood', policy), /not the rate of this wallet/);
});

test('ON: cancelling an unfilled order burns the fee nonce too and pays the collector nothing', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buy(w, 'on-order-0004');
  const col0 = w.chain.ethOf(COLLECTOR);
  const r = await w.limit.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'cancel-order-0004' });
  assert.equal(r.ok, true);
  assert.ok(w.chain.nonceOf(o.orderWallet) > Number(o.swapNonce) + 1, 'the fee nonce is burnt with the swap nonce');
  assert.equal(w.chain.ethOf(COLLECTOR), col0, 'an order that never filled pays no fee');
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST, 'everything (the fee reserve included) came back');
});

test('ON: a sell order prices the fee on its lowest floor and carries one fee tx', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await sell(w, 'on-sell-order-0001');
  const posted = postedOf(w, o.orderId);
  const fee = posted.txs.find((t) => t.role === 'fee');
  assert.ok(fee);
  await assert.doesNotReject(checkPosted(posted, w.clock.t, 'robinhood', { collector: COLLECTOR, minBps: 20, required: true }));
  const floor = Math.min(...Object.values(posted.minOut).map(Number));
  assert.equal(Number(parseTransaction(fee.raw).value), Math.floor(floor * 20 / 10000));
});

// ── Relay swaps: the quote must carry Relay's app fee at the base rate in the origin coin ──
const RELAY_SOL = 792703809;
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
test('relayAppFeeProblem: an ERC-20 quote whose app fee is ~0.5% clears a 20-bps floor; a missing or too-small app fee is refused', () => {
  const erc = fx('relay-quote-erc20.json');
  const want = { originChainId: 56, originCurrency: '0x55d398326f99059ff775485246999027b3197955', amount: '20000000000000000000' };
  assert.equal(relayAppFeeProblem(erc, want, 20, RELAY_SOL), '');      // 0.5% ≥ 0.20%
  assert.equal(relayAppFeeProblem(erc, want, 20, RELAY_SOL).length, 0);
  // no app fee at all
  const none = { ...erc, fees: { ...erc.fees, app: undefined } };
  assert.match(relayAppFeeProblem(none, want, 20, RELAY_SOL), /no app fee/);
  // a sol fixture whose app fee is 0 → under any positive floor
  const sol = fx('relay-quote-sol-token.json');
  const wsol = { originChainId: RELAY_SOL, originCurrency: 'ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB', amount: '200000000000' };
  assert.match(relayAppFeeProblem(sol, wsol, 20, RELAY_SOL), /under the/);
  // the app fee paid in a different coin than the one swapped → refused
  assert.match(relayAppFeeProblem(erc, { ...want, originCurrency: '0x0000000000000000000000000000000000000001' }, 20, RELAY_SOL), /not paid in the coin/);
});
