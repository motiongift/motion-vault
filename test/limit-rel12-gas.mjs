// rel-12 fix (b) (2026-11-06, the AIMCAP report: 605,835 AIMCAP in an order wallet holding 0.00000032 ETH): cancel / sweep tops up
// the order wallet's gas from the main wallet when the way back cannot pay for itself, then returns everything (the top-up's rest
// comes back with the native). The cancel dialog says it first.
//   node --experimental-strip-types --test test/limit-rel12-gas.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitWorld, TOKEN, E } from './fixtures/limit-world.mjs';

const DUST = 5_000_000_000_000n;
const sell = (w, key, expiresIn = 86400) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'sell', kind: 'tp', price: (w.chain.price() * 1.2).toFixed(15), amount: '20000', slippageBps: 300, expiresIn, route: w.route, idempotencyKey: key });
// the order wallet's gas gone (what AIMCAP's looked like): 0.00000032 ETH left
const drain = (w, ow) => w.chain.fund(ow, -(w.chain.ethOf(ow) - 320_000_000_000n));
const mainTo = (w, ow) => w.sent.filter((s) => s.from === 'main' && s.tx.to.toLowerCase() === ow.toLowerCase());

test('cancel of a live sell whose order wallet has no gas: the dialog names the top-up, the main wallet sends it, every coin comes back, the swap is dead', async () => {
  const w = limitWorld();
  const { order: o } = await sell(w, 'place-b-0001');
  const tok0 = w.chain.balOf(w.main.address);
  drain(w, o.orderWallet);
  const funded = mainTo(w, o.orderWallet).length;
  const r = await w.limit.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'cancel-b-0001' });
  assert.equal(r.ok, true);
  assert.match(w.asks[w.asks.length - 1].html, /Gas for the way back/);
  assert.equal(mainTo(w, o.orderWallet).length, funded + 1, 'one top-up from the main wallet');
  assert.equal(w.chain.balOf(o.orderWallet), 0n); assert.equal(w.chain.balOf(w.main.address) - tok0, 20000n * 10n ** 18n, 'the coin is back');
  assert.ok(w.chain.nonceOf(o.orderWallet) > o.swapNonce, 'the signed swap can never land');
  assert.ok(w.chain.ethOf(o.orderWallet) <= DUST, 'the top-up\'s rest came back too');
  assert.ok(r.hashes.length >= 3, 'top-up, coin, native: ' + r.hashes.length);
  assert.ok(w.events.some((e) => e.step === 'gas' && e.state === 'done'));
});

test('the sweep of an expired order (no dialog) tops up the same way', async () => {
  const w = limitWorld();
  const { order: o } = await sell(w, 'place-b-0002', 3600);
  drain(w, o.orderWallet);
  w.clock.t += 2 * 3_600_000;
  const r = await w.limit.sweep({ walletId: 'w1', orderId: o.orderId });
  assert.equal(r.ok, true); assert.equal(w.chain.balOf(o.orderWallet), 0n);
  assert.ok(w.chain.nonceOf(o.orderWallet) > o.swapNonce);
});

test('the main wallet cannot pay the top-up: refused with what to do, nothing sent from the order wallet', async () => {
  const w = limitWorld();
  const { order: o } = await sell(w, 'place-b-0003');
  drain(w, o.orderWallet);
  w.chain.fund(w.main.address, -(w.chain.ethOf(w.main.address) - 1_000n));
  const n0 = w.chain.nonceOf(o.orderWallet);
  await assert.rejects(w.limit.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'cancel-b-0003' }), (e) => e.name === 'LimitRefused' && /needs .* of gas/.test(e.message) && /add ETH to Wallet 1/.test(e.message));
  assert.equal(w.chain.nonceOf(o.orderWallet), n0); assert.equal(w.chain.balOf(o.orderWallet), 20000n * 10n ** 18n, 'the coin stays where it is, recoverable');
});

test('control: an order wallet with its gas reserve gets no top-up', async () => {
  const w = limitWorld();
  const { order: o } = await sell(w, 'place-b-0004');
  const funded = mainTo(w, o.orderWallet).length;
  await w.limit.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'cancel-b-0004' });
  assert.equal(mainTo(w, o.orderWallet).length, funded);
  assert.doesNotMatch(w.asks[w.asks.length - 1].html, /Gas for the way back/);
  assert.equal(w.chain.balOf(o.orderWallet), 0n);
  assert.ok(E(1) > 0n);
});
