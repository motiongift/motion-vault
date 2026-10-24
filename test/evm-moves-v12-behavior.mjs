// V12 EVM moves / duplicate-send behavior tests. webEngine.ts needs browser globals so node cannot import it;
// these re-implement the EXACT predicates the engine is built from (the same approach as webengine-v12-behavior.mjs)
// and exercise their logic. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// ── F-69 / settleLeg drop proof: dropped only when TWO default nodes BOTH show the nonce passed AND not-found ──
const provenDropped = (votes) => votes.filter((v) => v.higher === true && v.notFound === true).length >= 2;

test('F-69: two default nodes, both certain the nonce passed and the tx is gone → dropped', () => {
  assert.equal(provenDropped([{ higher: true, notFound: true }, { higher: true, notFound: true }]), true);
});
test('F-69: a lookup error on either node is NOT a proof — keep polling, never re-send', () => {
  assert.equal(provenDropped([{ higher: true, notFound: true }, { higher: true, notFound: null }]), false);
  assert.equal(provenDropped([{ higher: null, notFound: null }, { higher: true, notFound: true }]), false);
});
test('F-69: nonce passed but tx still found (mined) → not dropped', () => {
  assert.equal(provenDropped([{ higher: true, notFound: false }, { higher: true, notFound: false }]), false);
});
test('F-69: only one node reachable → never enough to declare dropped', () => {
  assert.equal(provenDropped([{ higher: true, notFound: true }, { higher: null, notFound: null }]), false);
});

// ── F-58/F-69 / retryJob: re-queue (→ re-sign) only a pre-signature failure or a proven-dropped leg; never a ──
// ── signed/sent/unknown leg (money may be on chain), never a cancelled one. ──
function requeues(l) {
  if (l.error === 'cancelled') return false;                                 // F-32: a hand-cancelled leg never resumes
  const dropped = l.status === 'failed' && l.error === 'dropped before mining';
  return (l.status === 'failed' && !l.raw) || dropped || l.status === 'skipped';
}
test('retryJob re-queues a failure that never signed (no raw)', () => {
  assert.equal(requeues({ status: 'failed', error: 'insufficient ETH' }), true);
});
test('retryJob NEVER re-queues a signed/sent/unknown leg (it carries raw — recovery re-broadcasts the same bytes)', () => {
  assert.equal(requeues({ status: 'signed', raw: '0xabc' }), false);
  assert.equal(requeues({ status: 'sent', raw: '0xabc', hash: '0xh' }), false);
  assert.equal(requeues({ status: 'unknown', raw: '0xabc', hash: '0xh' }), false);
});
test('retryJob re-queues a proven-dropped leg (safe to re-sign), but not a reverted one', () => {
  assert.equal(requeues({ status: 'failed', raw: '0xabc', error: 'dropped before mining' }), true);
  assert.equal(requeues({ status: 'failed', raw: '0xabc', error: 'reverted on chain' }), false);
});
test('retryJob never re-queues a cancelled leg (F-32)', () => {
  assert.equal(requeues({ status: 'skipped', error: 'cancelled' }), false);
  assert.equal(requeues({ status: 'skipped', error: 'previous hop did not land' }), true);
});

// ── F-42 / once() outcome classification: preSend → delete record; unknown → keep 'sending'; else 'failed' ──
class SolSendUnknown extends Error { hash = ''; }
class NearSendUnknown extends Error { hash = ''; }
function classify(err) {
  if (err?.preSend === true) return 'delete';
  if (err instanceof SolSendUnknown || err instanceof NearSendUnknown || err?.unknown === true || err?.txState === 'unknown') return 'sending';
  return 'failed';
}
test('F-42: a {preSend:true} error deletes the idempotency record (retry allowed)', () => {
  assert.equal(classify(Object.assign(new Error('insufficient USDG'), { preSend: true })), 'delete');
});
test('contract: Sol/NearSendUnknown and EVM unknown keep the record as sending (never failed)', () => {
  assert.equal(classify(new SolSendUnknown('sol unknown')), 'sending');
  assert.equal(classify(new NearSendUnknown('near unknown')), 'sending');
  assert.equal(classify(Object.assign(new Error('x'), { unknown: true })), 'sending');
  assert.equal(classify(Object.assign(new Error('x'), { txState: 'unknown' })), 'sending');
});
test('a genuine pre-chain failure is recorded failed', () => {
  assert.equal(classify(new Error('Invalid address')), 'failed');
});

// ── F-70 / rolling 1-hour buy ledger per lane: entries merged + pruned by age, 5× cap triggers a confirm ──
const BUY_WINDOW_MS = 60 * 60_000;
function recordBuy(store, lane, total, now) {
  const all = store.buys && typeof store.buys === 'object' ? store.buys : {};
  const prev = Array.isArray(all[lane]) ? all[lane].filter((e) => now - Number(e[0]) < BUY_WINDOW_MS) : [];
  const merged = [...prev, [now, total]].slice(-500);
  store.buys = { ...all, [lane]: merged };
  return merged.reduce((s, [, a]) => s + (Number(a) || 0), 0);
}
test('F-70: under-cap buys accumulate across the hour and cross 5× the cap', () => {
  const store = {}; const cap = 1; const t = 1_000_000_000_000;
  assert.equal(recordBuy(store, 'robinhood', 2, t), 2);
  assert.equal(recordBuy(store, 'robinhood', 2, t + 1000), 4);
  const sum = recordBuy(store, 'robinhood', 2, t + 2000);
  assert.equal(sum, 6);
  assert.ok(sum > cap * 5, 'six beats 5× the cap of 1 → the engine asks');
});
test('F-70: entries older than an hour are not counted, and a sibling tab\'s entries are merged, not dropped', () => {
  const t = 2_000_000_000_000;
  const store = { buys: { bsc: [[t - BUY_WINDOW_MS - 1, 999], [t - 1000, 3]] } };  // one stale, one fresh (from another tab)
  const sum = recordBuy(store, 'bsc', 4, t);
  assert.equal(sum, 7, 'stale 999 pruned; fresh 3 kept and merged with this 4');
  assert.equal(store.buys.bsc.length, 2);
});

// ── F-52 / remove gate: a failed RPC read (null) or a used wallet (nonce>0) counts as held → gate required ──
function held(ethCache, tokenCache, addr, bal, nonce) {
  let h = (ethCache[addr] || 0) > 0 || Object.values(tokenCache).some((m) => (m[addr] || 0) > 0);
  if (!h) { if (bal === null || bal > 0n || nonce === null || nonce > 0) h = true; }
  return h;
}
test('F-52: a failed balance read cannot bypass the funded-remove gate', () => {
  assert.equal(held({}, {}, '0xa', null, 0), true);   // getBalance failed → held
  assert.equal(held({}, {}, '0xa', 0n, null), true);  // nonce read failed → held
});
test('F-52: a wallet that has transacted (nonce>0) or holds funds is held; a pristine empty one is not', () => {
  assert.equal(held({}, {}, '0xa', 0n, 3), true);     // used before
  assert.equal(held({}, {}, '0xa', 5n, 0), true);     // has balance
  assert.equal(held({ '0xa': 2 }, {}, '0xa', 0n, 0), true);   // cached balance
  assert.equal(held({}, {}, '0xa', 0n, 0), false);    // empty and never used → no gate
});

// ── F-41 / broadcast returns the LOCALLY computed hash; a node that reports a different hash is an error ──
function acceptHash(nodeResult, local) {
  if (String(nodeResult).toLowerCase() !== local.toLowerCase()) throw new Error('node returned a different transaction hash');
  return local;
}
test('F-41: a matching node hash yields the local hash; a different one throws', () => {
  const local = '0x' + 'ab'.repeat(32);
  assert.equal(acceptHash(local.toUpperCase(), local), local);
  assert.throws(() => acceptHash('0x' + 'cd'.repeat(32), local), /different transaction hash/);
});

// ── F-44 / bridgeSend max reserves the OP-stack L1 data fee on OP-stack chains, not on others ──
const OP_STACK = new Set([10, 8453]);
function maxValue(bal, gasCost, l1, chainId) {
  const extra = OP_STACK.has(chainId) ? l1 + l1 / 5n : 0n;
  return bal - gasCost - gasCost / 5n - extra;
}
test('F-44: on Base (OP-stack) the L1 fee is reserved; on Arbitrum it is not', () => {
  const bal = 1_000_000n, gasCost = 21_000n, l1 = 50_000n;
  const base = maxValue(bal, gasCost, l1, 8453);
  const arb = maxValue(bal, gasCost, l1, 42161);
  assert.ok(base < arb, 'Base reserves extra for the L1 data fee');
  assert.equal(arb, bal - gasCost - gasCost / 5n);
  assert.equal(base, bal - gasCost - gasCost / 5n - l1 - l1 / 5n);
});
