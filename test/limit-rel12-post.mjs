// rel-12 fix (a) (2026-11-06, the AIMCAP report): a limit order whose post to motion's server fails after funding is posted twice
// more (1.5 s, 4 s); still not taken, everything goes back to the main wallet at once and the swap's nonce is burnt (a copy the
// server may hold can never fill). Before: a 5xx / timeout left it 'open, not stored' for a later list of the SAME browser.
//   node --experimental-strip-types --test test/limit-rel12-post.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitWorld, TOKEN, E } from './fixtures/limit-world.mjs';
import { POST_RETRY_MS } from '../src/limitEngine.ts';

const DUST = 5_000_000_000_000n;
const buy = (w, key) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: (w.chain.price() * 0.9).toFixed(15), amount: '0.05', expiresIn: 86400, route: w.route, idempotencyKey: key });
const sell = (w, key) => w.limit.place({ walletId: 'w1', token: TOKEN, side: 'sell', kind: 'tp', price: (w.chain.price() * 1.2).toFixed(15), amount: '20000', slippageBps: 300, expiresIn: 86400, route: w.route, idempotencyKey: key });
const orderWalletOf = (w) => Object.values(JSON.parse([...w.store.entries()].find(([k]) => k === 'trenches.limit.v1.robinhood')[1]))[0];

test('no answer three times: the funds come back at once, the nonce is burnt, the server is told to drop it', async () => {
  const w = limitWorld(); w.keeper.answer = ['throw'];
  const eth0 = w.chain.ethOf(w.main.address);
  await assert.rejects(buy(w, 'place-a-0001'), (e) => e.name === 'LimitRefused' && /did not take the order/.test(e.message) && /went back to Wallet 1/.test(e.message));
  assert.equal(w.keeper.posts, 3); assert.deepEqual(w.sleeps, [...POST_RETRY_MS]);
  const rec = orderWalletOf(w);
  assert.equal(rec.closed, 'failed'); assert.ok(rec.emptyAt, 'seen empty');
  assert.ok(w.chain.ethOf(rec.orderWallet) <= DUST, 'nothing left in the order wallet');
  assert.ok(w.chain.nonceOf(rec.orderWallet) > rec.swapNonce, 'the swap\'s nonce is used: its signed bytes can never land');
  assert.ok(eth0 - w.chain.ethOf(w.main.address) < E(0.0005), 'only gas was spent');
  assert.deepEqual(w.keeper.deletes, [rec.id]);
  const l = await w.limit.list({ walletId: 'w1' });
  assert.equal(l.orders[0].state, 'failed');
});

test('a 500 then a taken post: the order is live and stored, nothing comes back', async () => {
  const w = limitWorld(); w.keeper.answer = [500, 'ok'];
  const r = await buy(w, 'place-a-0002');
  assert.equal(r.ok, true); assert.equal(r.order.state, 'open'); assert.equal(r.order.stored, true);
  assert.equal(w.keeper.posts, 2); assert.deepEqual(w.sleeps, [POST_RETRY_MS[0]]);
  assert.ok(w.chain.ethOf(r.order.orderWallet) > E(0.05));
  assert.ok(w.events.some((e) => e.step === 'post' && e.state === 'done'));
});

test('a 4xx is a refusal: no retry, the funds back (as before)', async () => {
  const w = limitWorld(); w.keeper.answer = [400];
  await assert.rejects(buy(w, 'place-a-0003'), /refused the order/);
  assert.equal(w.keeper.posts, 1); assert.deepEqual(w.sleeps, []);
  assert.ok(w.chain.ethOf(orderWalletOf(w).orderWallet) <= DUST);
});

test('the server kept the order but answered 500 every time: the return burns the nonce, so its copy can never fill', async () => {
  const w = limitWorld(); w.keeper.answer = ['kept500'];
  await assert.rejects(buy(w, 'place-a-0004'));
  const rec = orderWalletOf(w);
  const kept = [...w.keeper.orders.values()];
  assert.equal(kept.length, 0, 'the server was told to drop it');
  // what it held, sent anyway: refused by the chain
  assert.ok(w.chain.nonceOf(rec.orderWallet) > rec.swapNonce);
  const swapRaw = rec.txs.find((t) => t.role === 'swap').raw;
  await assert.rejects(w.chain.sendRaw(swapRaw), /nonce too low/);
});

test('a sell: the coin and the gas reserve come back when the post fails', async () => {
  const w = limitWorld(); w.keeper.answer = [503];
  const tok0 = w.chain.balOf(w.main.address);
  await assert.rejects(sell(w, 'place-a-0005'), /did not take the order/);
  const rec = orderWalletOf(w);
  assert.equal(w.chain.balOf(rec.orderWallet), 0n); assert.equal(w.chain.balOf(w.main.address), tok0, 'every coin back');
  assert.ok(w.chain.ethOf(rec.orderWallet) <= DUST);
});
