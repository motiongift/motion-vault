// rel-12 fix (c) (2026-11-06, the AIMCAP report): a recovered order wallet whose coin this vault does not know (the server never
// had the order, so the recovery scan got no fields) is never judged "empty" by its native alone. Before: native under the dust
// → closed 'cancelled', Cancel gone, while 605,835 AIMCAP sat in it. Now it stays 'recovered' with Cancel and coinUnknown; Cancel
// with the coin returns it (with fix (b)'s gas top-up); a record rel-10 closed that way is opened again by the next list.
//   node --experimental-strip-types --test test/limit-rel12-unknown-coin.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitWorld, TOKEN } from './fixtures/limit-world.mjs';

const STORE = 'trenches.limit.v1.robinhood';
// AIMCAP's state, rebuilt: a sell placed here, the server has no record of it, its gas is gone; then a wiped browser lists
async function aimcap() {
  const w = limitWorld();
  const { order: o } = await w.limit.place({ walletId: 'w1', token: TOKEN, side: 'sell', kind: 'tp', price: (w.chain.price() * 1.2).toFixed(15), amount: '20000', slippageBps: 300, expiresIn: 86400, route: w.route, idempotencyKey: 'place-c-0001' });
  w.keeper.orders.clear();
  w.chain.fund(o.orderWallet, -(w.chain.ethOf(o.orderWallet) - 320_000_000_000n));
  const b = w.device();
  return { w, o, b };
}

test('a wiped browser finds the order wallet: not "cancelled" by its 0.00000032 ETH — recovered, Cancel offered, the coin flagged unknown', async () => {
  const { o, b } = await aimcap();
  const l = await b.list({ walletId: 'w1' });
  assert.equal(l.recovered, 1);
  const row = l.orders.find((x) => x.orderId === o.orderId);
  assert.equal(row.state, 'recovered'); assert.equal(row.cancelable, true); assert.equal(row.coinUnknown, true); assert.equal(row.token, null);
  // listed again: still so (rel-10 closed it here, on the list itself)
  const again = (await b.list({ walletId: 'w1' })).orders.find((x) => x.orderId === o.orderId);
  assert.equal(again.state, 'recovered'); assert.equal(again.cancelable, true);
});

test('Cancel without the coin returns nothing and keeps the order open to "Return a coin"; with the coin, the gas is topped up and every coin comes back', async () => {
  const { w, o, b } = await aimcap();
  await b.list({ walletId: 'w1' });
  const r1 = await b.cancel({ walletId: 'w1', orderId: o.orderId, idempotencyKey: 'cancel-c-0001' });
  assert.equal(r1.ok, true); assert.equal(r1.state, 'recovered'); assert.equal(r1.coinUnknown, true);
  assert.equal(w.chain.balOf(o.orderWallet), 20000n * 10n ** 18n, 'nothing could be judged or lost');
  const tok0 = w.chain.balOf(w.main.address);
  const r2 = await b.cancel({ walletId: 'w1', orderId: o.orderId, token: TOKEN, idempotencyKey: 'cancel-c-0002' });
  assert.equal(r2.ok, true); assert.notEqual(r2.coinUnknown, true);
  assert.equal(w.chain.balOf(o.orderWallet), 0n); assert.equal(w.chain.balOf(w.main.address) - tok0, 20000n * 10n ** 18n);
  assert.ok(w.chain.nonceOf(o.orderWallet) > o.swapNonce, 'its signed swap is dead');
  const row = (await b.list({ walletId: 'w1' })).orders.find((x) => x.orderId === o.orderId);
  assert.equal(row.token, TOKEN, 'the coin is remembered'); assert.equal(row.cancelable, false); assert.notEqual(row.coinUnknown, true);
});

test('a record rel-10 closed by native alone (recovered, no coin, "cancelled", never swept) is opened again by the next list', async () => {
  const { o, w } = await aimcap();
  // the tester's browser as rel-10 left it: the adopted stub, closed 'cancelled' and seen "empty" by its native, never swept
  const st = new Map();
  const rec = { v: 1, id: o.orderId, index: 0, walletId: 'w1', wallet: w.main.address.toLowerCase(), orderWallet: o.orderWallet.toLowerCase(), token: '', symbol: '?', decimals: 18, side: 'buy', kind: 'limit', price: '', amount: '', amountIn: '', minOut: {}, slippageBps: 0, expiry: 0, createdAt: w.clock.t - 3_600_000, venues: [], swapNonce: null, txs: [], fund: [], approve: [], swap: {}, reserve: '0', gasPrice: '0', stage: 'open', stored: false, recovered: true, closed: 'cancelled', emptyAt: w.clock.t - 1_800_000 };
  st.set(STORE, JSON.stringify({ [o.orderId]: rec }));
  st.set(STORE + '.scan', JSON.stringify({ [w.main.address.toLowerCase()]: { full: true, at: w.clock.t - 1_800_000 } }));
  const t = w.device(st);
  const row = (await t.list({ walletId: 'w1' })).orders.find((x) => x.orderId === o.orderId);
  assert.equal(row.state, 'recovered'); assert.equal(row.cancelable, true); assert.equal(row.coinUnknown, true);
  const saved = JSON.parse(st.get(STORE))[o.orderId];
  assert.equal(saved.closed, undefined); assert.equal(saved.emptyAt, undefined);
  // a recovered order whose wallet WAS swept by a cancel stays closed (only native-only closings are undone)
  const st2 = new Map(); st2.set(STORE, JSON.stringify({ [o.orderId]: { ...rec, sweptAt: w.clock.t - 1_000 } })); st2.set(STORE + '.scan', st.get(STORE + '.scan'));
  const row2 = (await w.device(st2).list({ walletId: 'w1' })).orders.find((x) => x.orderId === o.orderId);
  assert.equal(row2.state, 'cancelled');
});
