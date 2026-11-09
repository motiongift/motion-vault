// fee-sprint bypass — ADVERSARIAL REVIEW (2026-11-09): hostile tests of the terminal fee leg (limit / TP / SL, Solana, Relay).
//   node --experimental-strip-types --test test/fee-leg-hostile.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction } from 'viem';
import { limitWorld, TOKEN, E } from './fixtures/limit-world.mjs';
import { checkPosted } from '../src/limitCore.ts';
import { feeOf, relayAppFeeProblem, bpsFor, feeLegFor, TERMINAL_FEE_LEG } from '../src/terminalFeeLeg.ts';
import { readFileSync } from 'node:fs';

const COLLECTOR = '0x74f25914dccE21555188B523748D3B3f557ed297'.toLowerCase();
const POLICY = { collector: COLLECTOR, minBps: 20, required: true };
const DUST = 5_000_000_000_000n;
const buyAmt = (w, key, amount) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: (w.chain.price() * 0.9).toFixed(15), amount, expiresIn: 86400, route: w.route, idempotencyKey: key });
const sell = (w, key, amount = '20000') => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'sell', kind: 'tp', price: (w.chain.price() * 1.2).toFixed(15), amount, slippageBps: 300, expiresIn: 86400, route: w.route, idempotencyKey: key });
const posted = (w, id) => w.keeper.orders.get(id);
const swapOf = (p) => p.txs.find((t) => t.role === 'swap');
const feeTxOf = (p) => p.txs.find((t) => t.role === 'fee');

// H1 — rounding: feeOf floors, the keeper compared the floored fee against the exact rate → almost every real basis was refused
test('H1 keeper accepts the vault\'s own floored fee for a basis not divisible by 500 (buy and sell)', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h1-buy-000001', '0.050000000000000123');
  const p = posted(w, o.orderId);
  assert.equal(parseTransaction(feeTxOf(p).raw).value, feeOf(50_000_000_000_000_123n, 20));
  await assert.doesNotReject(checkPosted(p, w.clock.t, 'robinhood', POLICY));
  const w2 = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: s } = await sell(w2, 'h1-sell-00001', '20000.000000000000000777');
  const ps = posted(w2, s.orderId);
  const floor = Object.values(ps.minOut).map(BigInt).reduce((m, x) => (x < m ? x : m));
  assert.equal(parseTransaction(feeTxOf(ps).raw).value, feeOf(floor, 20));
  await assert.doesNotReject(checkPosted(ps, w2.clock.t, 'robinhood', POLICY));
});

// H2 — the fee of a FILLED order is paid exactly once (sweep after fill), never twice on a second sweep
test('H2 filled order: the sweep pays the collector exactly the fee once; a second sweep pays nothing more', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h2-buy-000001', '0.05');
  const p = posted(w, o.orderId);
  const fee = parseTransaction(feeTxOf(p).raw).value;
  const col0 = w.chain.ethOf(COLLECTOR);
  w.chain.pushPrice(0.8);   // the price dropped under the limit
  await w.chain.sendRaw(swapOf(p).raw);   // the keeper fills it
  assert.equal(w.chain.log.at(-1).status, '0x1', 'the swap filled');
  await w.limit.sweep({ walletId: 'w1', orderId: o.orderId });
  assert.equal(w.chain.ethOf(COLLECTOR) - col0, fee, 'the fee landed once');
  await w.limit.sweep({ walletId: 'w1', orderId: o.orderId }).catch(() => null);
  assert.equal(w.chain.ethOf(COLLECTOR) - col0, fee, 'no double charge');
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST);
});

// H3 — a fee tx the node refuses (gas spike, intrinsic-gas change, any send error) must never lock the user's funds
test('H3 filled order whose fee tx cannot be broadcast: the way back still returns everything (fee forfeited, funds not stuck)', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h3-buy-000001', '0.05');
  const p = posted(w, o.orderId);
  w.chain.pushPrice(0.8);
  await w.chain.sendRaw(swapOf(p).raw);
  assert.equal(w.chain.log.at(-1).status, '0x1', 'the swap filled');
  const feeRaw = feeTxOf(p).raw.toLowerCase();
  const real = w.chain.sendRaw;
  w.chain.sendRaw = async (raw) => { if (raw.toLowerCase() === feeRaw) throw new Error('max fee per gas less than block base fee'); return real(raw); };
  const before = w.chain.ethOf(o.orderWallet);
  assert.ok(before > DUST);
  const r = await w.limit.sweep({ walletId: 'w1', orderId: o.orderId });
  assert.equal(r.ok, true);
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST, 'the order wallet was emptied back to the main wallet');
});

// H4 — the swap is in flight (mempool) when the user cancels: the vault must not decide "unfilled" without a receipt and give the
//      fee nonce to a way-back send (fee lost) — it stops before touching the fee nonce, and pays the fee once the fill is known
test('H4 swap pending at cancel time: nothing is sent at the fee nonce until the swap\'s outcome is known; then the fee is paid', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h4-buy-000001', '0.05');
  const p = posted(w, o.orderId);
  const fee = parseTransaction(feeTxOf(p).raw).value;
  const col0 = w.chain.ethOf(COLLECTOR);
  w.chain.pushPrice(0.8);
  w.chain.setDrop(true);
  await w.chain.sendRaw(swapOf(p).raw);   // in the mempool, not mined
  w.chain.setDrop(false);
  const feeNonce = Number(o.swapNonce) + 1;
  await assert.rejects(w.limit.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'h4-cancel-0001' }), (e) => e.name === 'LimitUnknown' && /in flight/.test(e.message));
  const sentAtFee = w.chain.log.filter((x) => x.from === o.orderWallet.toLowerCase() && x.nonce === feeNonce);
  assert.equal(sentAtFee.length, 0, 'no way-back tx took the fee nonce');
  w.chain.mineDropped();   // the swap lands: filled
  await w.limit.sweep({ walletId: 'w1', orderId: o.orderId });
  assert.equal(w.chain.ethOf(COLLECTOR) - col0, fee, 'the filled order paid its fee');
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST);
});

// H5 — a REVERTED swap is not a fill: the fee nonce is burnt, the collector gets nothing
test('H5 reverted swap: no fee; the fee nonce is burnt', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h5-buy-000001', '0.05');
  const p = posted(w, o.orderId);
  const col0 = w.chain.ethOf(COLLECTOR);
  w.chain.pushPrice(4);   // the price ran away: the swap's floor cannot be met → it reverts on chain
  await w.chain.sendRaw(swapOf(p).raw);
  const last = w.chain.log.at(-1); assert.equal(last.status, '0x0');
  await w.limit.sweep({ walletId: 'w1', orderId: o.orderId });
  assert.equal(w.chain.ethOf(COLLECTOR), col0);
  assert.ok(w.chain.nonceOf(o.orderWallet) > Number(o.swapNonce) + 1, 'fee nonce burnt');
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST);
});

// H6 — a hostile server cannot steer the rate: a fee tx to another address, with calldata, at another nonce, or twice
test('H6 keeper: fee tx to another address / with data / wrong nonce / duplicated / above 20 bps are all refused', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h6-buy-000001', '0.05');
  const p = posted(w, o.orderId);
  await assert.rejects(checkPosted(p, w.clock.t, 'robinhood', { ...POLICY, collector: '0x000000000000000000000000000000000000dead' }), /bad fee tx/);
  await assert.rejects(checkPosted({ ...p, txs: [...p.txs, feeTxOf(p)] }, w.clock.t, 'robinhood', POLICY), /bad fee tx|bad txs/);
  await assert.rejects(checkPosted({ ...p, txs: p.txs.map((t) => (t.role === 'fee' ? { ...t, nonce: t.nonce + 1 } : t)) }, w.clock.t, 'robinhood', POLICY), /legacy tx|right after/);
  // an over-charging vault build (or a server-provided rate) above the cap → refused
  const w2 = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o2 } = await buyAmt(w2, 'h6-buy-000002', '0.05');
  const p2 = posted(w2, o2.orderId);
  // cap: a policy that requires more than the max cannot be met by any fee (no >20 bps fee is ever accepted)
  await assert.rejects(checkPosted(p2, w2.clock.t, 'robinhood', { ...POLICY, minBps: 25 }), /not the rate/);
});

// H7 — feeOf can never go above the cap / be fed a non-tier rate (a server answer cannot raise it)
test('H7 the engine never charges more than 20 bps: bpsFor caps at the tier list, an entitlement of 50 bps is ignored', async () => {
  const leg = feeLegFor('robinhood', { ...TERMINAL_FEE_LEG, enabled: { robinhood: true, bsc: false, sol: false } });
  const r = await bpsFor({ leg, wallet: '0x' + '11'.repeat(20), entitlement: { chain: 'robinhood', wallet: '0x' + '11'.repeat(20), bps: 50, notBefore: 0, expiresAt: 9e9, policyId: leg.policyId, sig: '0x' + '00'.repeat(65) }, nowMs: Date.now() });
  assert.equal(r.bps, 20);
  assert.throws(() => feeOf(1000n, 50));
});

// H8 — Relay: a quote that charges the app fee in another chain's coin, as a string with junk, or a negative / huge number
test('H8 relayAppFeeProblem refuses unreadable / foreign-chain app fees and a zero amount', () => {
  const erc = JSON.parse(readFileSync(new URL('./fixtures/relay-quote-erc20.json', import.meta.url)));
  const want = { originChainId: 56, originCurrency: '0x55d398326f99059ff775485246999027b3197955', amount: '20000000000000000000' };
  const RELAY_SOL = 792703809;
  assert.match(relayAppFeeProblem({ ...erc, fees: { ...erc.fees, app: { ...erc.fees.app, amount: '1e30' } } }, want, 20, RELAY_SOL), /cannot be read/);
  assert.match(relayAppFeeProblem({ ...erc, fees: { ...erc.fees, app: { ...erc.fees.app, amount: '-5' } } }, want, 20, RELAY_SOL), /cannot be read/);
  assert.match(relayAppFeeProblem({ ...erc, fees: { ...erc.fees, app: { ...erc.fees.app, currency: { ...erc.fees.app.currency, chainId: 1 } } } }, want, 20, RELAY_SOL), /not paid in the coin/);
  assert.match(relayAppFeeProblem(erc, { ...want, amount: '0' }, 20, RELAY_SOL), /cannot be read/);
});

// H9 — leg ON but the keeper still has no fee policy: the order is refused (bad role) and the funds come back; nothing is lost
test('H9 deploy-order mistake (engine leg on, keeper policy off): placement is refused and the funds go back', async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: o } = await buyAmt(w, 'h9-buy-000001', '0.05');
  await assert.rejects(checkPosted(posted(w, o.orderId), w.clock.t, 'robinhood', null), /bad role/);
});

// H10 — a minOut entry without a signed variant must not lower a sell's fee basis (keeper side, modified-client posting)
test('H10 keeper: an extra minOut entry with no variant cannot lower the sell basis to zero and drop the fee', async () => {
  const { CHAIN_VENUES } = await import('../src/limitCore.ts');
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const { order: s } = await sell(w, 'h10-sell-0001');
  const p = posted(w, s.orderId);
  const spare = CHAIN_VENUES.robinhood.find((v) => !(v in p.minOut));
  assert.ok(spare, 'a venue with no variant exists');
  const forged = { ...p, minOut: { ...p.minOut, [spare]: '1' }, txs: p.txs.filter((t) => t.role !== 'fee') };
  await assert.rejects(checkPosted(forged, w.clock.t, 'robinhood', POLICY), /no terminal fee/);
});
