// fee-sprint3 2026-11-09 — terminal EVM journal release rules (review F3 dropped-tx release, F2 OPTION L2 release, default OFF).
// engine-review 2026-11-09: F3 reworked to an anchored proof (R1-R3, B:/tmp/fee-sprint3/engine-review/review.txt).
// Mock chain clients and a minimal in-memory IndexedDB only. No network, no key, nothing signed or sent.
//   node --test test/fee-sprint3-journal-release.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openEvmClaims } from '../src/terminal-evm/claim-store.mjs';
import { verifyEvmFinality, verifyEvmL2Receipt, verifyEvmDropped } from '../src/terminal-evm/finality.mjs';

// ── minimal IndexedDB (the subset claim-store.mjs uses): async requests, per-transaction rollback on abort, serialized writers ──
function memoryIDB() {
  const dbs = new Map();
  const later = f => setTimeout(f, 0);
  return { open(name) {
    const r = {};
    later(() => {
      let fresh = false;
      if (!dbs.has(name)) { dbs.set(name, new Map()); fresh = true; }
      const stores = dbs.get(name);
      let chain = Promise.resolve();
      const db = {
        createObjectStore: (s, o = {}) => { stores.set(s, { keyPath: o.keyPath, data: new Map() }); },
        close() {},
        transaction(names, mode) {
          const t = { aborted: false, pending: 0, finished: false };
          let release; const gate = mode === 'readwrite' ? new Promise(res => { release = res; }) : null;
          const prior = chain; if (gate) chain = chain.then(() => gate);
          const snap = new Map(names.map(n => [n, new Map(stores.get(n).data)]));
          const finish = () => later(() => { if (t.pending || t.finished || t.aborted) return; t.finished = true; release?.(); t.oncomplete?.(); });
          const run = (fn) => { const q = {}; t.pending++; prior.then(() => later(() => {
            t.pending--;
            if (t.aborted) return;
            try { q.result = fn(); q.onsuccess?.(); } catch (e) { q.error = e; q.onerror?.(); t.abort(); return; }
            finish();
          })); return q; };
          t.abort = () => { if (t.aborted || t.finished) throw Error('InvalidStateError'); t.aborted = true;
            for (const [n, m] of snap) stores.get(n).data = m; release?.(); later(() => t.onabort?.()); };
          t.objectStore = (n) => { const s = () => stores.get(n); return {
            get: k => run(() => structuredClone(s().data.get(k))),
            add: v => run(() => { const k = v[s().keyPath]; if (s().data.has(k)) throw Error('ConstraintError'); s().data.set(k, structuredClone(v)); return k; }),
            put: (v, key) => run(() => { const k = key ?? v[s().keyPath]; s().data.set(k, structuredClone(v)); return k; }),
            delete: k => run(() => { s().data.delete(k); }),
          }; };
          later(finish);
          return t;
        },
      };
      r.result = db;
      if (fresh) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  } };
}

const trader = '0x' + '33'.repeat(20), other = '0x' + '44'.repeat(20);
const swapHash = '0x' + 'ab'.repeat(32), apprHash = '0x' + '12'.repeat(32), finHash = '0x' + 'ee'.repeat(32);
const row = (n) => ({ id: n.toString(16).padStart(64, '0'), trader, nonce: String(n), reservation: n % 2 ? '0x' + 'aa'.repeat(32) : null });
const LATEST = 109700409n, FINALIZED = 109689509n; // Robinhood Chain read-only 2026-11-09T02:10:49Z (review F2): finalized lags ~18.7 min
// engine-review 2026-11-09 read-only probe (B:/tmp/fee-sprint3/engine-review/rh-probe.txt): account state by NUMBER is served only
// near the head (publicnode ~64 blocks, refuses 127 "Archive requests require a personal token"; rpc.mainnet.chain.robinhood.com
// ~6,000, refuses 7,000 "historical state ... is not available") while finalized lags ~9,500. Both serve state by block hash at the head.
const PUBLICNODE_DEPTH = 64n;
const bh = (n, fork = 0n) => '0x' + (BigInt(n) * 1000n + fork).toString(16).padStart(64, '0'); // hash of height n on a fork
const heightOf = h => BigInt(h) / 1000n;
const blockHash = bh(LATEST - 5n); // the mined swap's block
const notFound = (name) => () => { throw Object.assign(new Error('not found'), { name }); };

// A chain client. mined: the swap's receipt exists. count(blockNumber): account nonce in the state of that block.
// stateDepth: how far below the head the node still serves account state (by number or by hash); headers always.
// fork / forkFrom: blocks at or above forkFrom carry the fork id in their hash (bump fork to model a reorg).
function client({ chainId = 4663, mined = false, minedHash = null, finalized = FINALIZED, latest = LATEST, count = () => 0, tx = null, calls = [],
  stateDepth = PUBLICNODE_DEPTH, fork = 0n, forkFrom = 0n } = {}) {
  const c = { head: latest, fin: finalized, fork, forkFrom };
  const hashAt = n => bh(n, BigInt(n) >= c.forkFrom ? c.fork : 0n);
  const state = n => { if (c.head - BigInt(n) > stateDepth) throw Object.assign(new Error('historical state is not available'), { code: -32000 }); return count(BigInt(n)); };
  return Object.assign(c, {
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }) => { calls.push(['receipt', hash]);
      if (mined && (!minedHash || minedHash === hash)) return { transactionHash: hash, status: 'success', blockNumber: LATEST - 5n, blockHash };
      return notFound('TransactionReceiptNotFoundError')(); },
    getTransaction: async ({ hash }) => { calls.push(['tx', hash]); if (tx) return tx(hash); return notFound('TransactionNotFoundError')(); },
    getTransactionCount: async ({ address, blockNumber, blockTag }) => { calls.push(['count', address, blockNumber, blockTag]);
      return state(blockNumber ?? (blockTag === 'finalized' ? c.fin : c.head)); },
    request: async ({ method, params }) => {
      if (method !== 'eth_getTransactionCount' || params.length !== 2 || typeof params[1]?.blockHash !== 'string') throw Error('unsupported request');
      calls.push(['countByHash', params[0], params[1].blockHash]);
      const n = heightOf(params[1].blockHash);
      if (n > c.head) throw Object.assign(new Error('header not found'), { code: -32000 });
      return '0x' + BigInt(state(n)).toString(16);
    },
    getBlock: async ({ blockTag, blockNumber }) => blockTag === 'finalized' ? (c.fin === null ? null : { number: c.fin, hash: hashAt(c.fin) })
      : blockTag === 'latest' ? { number: c.head, hash: hashAt(c.head) } : { number: blockNumber, hash: blockNumber === LATEST - 5n ? blockHash : hashAt(blockNumber) },
    getBlockNumber: async () => c.head,
  });
}
let clock = 1_800_000_000_000;
const now = () => clock;
async function journal(c, { l2 = null, dropped = true, dropConfirmMs = 60000, idb = memoryIDB(), name = 'j', clockFn = now } = {}) {
  const conf = l2 ?? 2;
  return openEvmClaims({ indexedDB: idb, name, now: clockFn, dropConfirmMs,
    verifyFinal: r => l2 ? verifyEvmL2Receipt({ client: c, chainId: 4663, row: r, confirmations: conf }) : verifyEvmFinality({ client: c, chainId: 4663, row: r, confirmations: conf }),
    ...(dropped ? { verifyDropped: r => verifyEvmDropped({ client: c, chainId: 4663, row: r, confirmations: l2 ? conf : null }) } : {}) });
}
const finalizeAll = (c, by = 20_000n) => { c.head += by; c.fin = c.head - 1n; }; // the anchor's block reaches L1 finality

// ── F3: dropped transaction ──
test('F3.1 a swap that never landed: anchored (nonce consumed at the head, read by block hash), released once that block is final and >= 60 s later', async () => {
  const calls = [];
  const c = client({ count: () => 8, calls }); // account nonce 8 > signed nonce 5: another tx used nonce 5
  const j = await journal(c);
  assert.equal(await j.claim(row(1)), true);
  await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal((await j.get(row(1).id)).txNonce, '5');
  assert.equal(await j.reconcile(row(1).id), 'signed', 'first sighting only anchors');
  const anchored = await j.get(row(1).id);
  assert.deepEqual(anchored.dropAnchor, { blockNumber: LATEST.toString(), blockHash: bh(LATEST), accountNonce: '8' });
  assert.equal(anchored.dropSeenAt, clock);
  assert.ok(calls.some(x => x[0] === 'countByHash' && x[2] === bh(LATEST)), 'nonce read bound to the head block by hash');
  assert.ok(await j.pending(trader), 'still held after one sighting');
  clock += 61_000;
  assert.equal(await j.reconcile(row(1).id), 'signed', 'anchor not final yet (Robinhood: ~19 min)');
  assert.deepEqual((await j.get(row(1).id)).dropAnchor, anchored.dropAnchor, 'a pending proof keeps the anchor');
  finalizeAll(c);
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  assert.equal(await j.pending(trader), null, 'wallet released for NEW trades');
  const saved = await j.get(row(1).id);
  assert.equal(saved.status, 'dropped'); assert.equal(saved.hash, swapHash); assert.equal(saved.dropAnchor, null);
  assert.deepEqual(saved.history, [{ hash: swapHash, phase: 'swap', success: false, dropped: true, txNonce: '5', accountNonce: '8', atBlock: LATEST.toString(), atBlockHash: bh(LATEST) }]);
  // replay protection does not depend on the release: the same quote nonce / reservation can never be claimed again
  assert.equal(await j.claim(row(1)), false);
  assert.equal(await j.claim({ ...row(1), id: 'f'.repeat(64) }), false, 'nonce + reservation keys still consumed');
  assert.equal(await j.claim(row(2)), true, 'a NEW quote is accepted');
  // nothing re-signs the dropped row and the store has no resend / rebuild API
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 5));
  assert.deepEqual(Object.keys(j).sort(), ['cancelIdle', 'claim', 'close', 'get', 'pending', 'reconcile', 'signed']);
});

test('F3.1b fast finality (BSC-like, anchor final at once): the release still needs >= 60 s after the first sighting', async () => {
  const c = client({ count: () => 8, finalized: LATEST });
  const j = await journal(c, { name: 'fast' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed');
  c.head += 3n; c.fin = c.head;
  clock += 59_000;
  assert.equal(await j.reconcile(row(1).id), 'signed', 'second proof too early');
  clock += 2_000;
  assert.equal(await j.reconcile(row(1).id), 'dropped');
});

test('F3.2 (engine-review R1) no state read deeper than the default nodes keep; the finalized-height nonce read is refused by both', async () => {
  for (const depth of [PUBLICNODE_DEPTH, 6_000n]) {
    const calls = [];
    const c = client({ count: () => 9, calls, stateDepth: depth });
    // the round-3 read (account nonce at the finalized NUMBER) is refused by both default Robinhood nodes
    await assert.rejects(c.getTransactionCount({ address: trader, blockNumber: FINALIZED }), /historical state/);
    calls.length = 0;
    const j = await journal(c, { name: 'depth' + depth });
    await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
    assert.equal(await j.reconcile(row(1).id), 'signed');
    clock += 61_000; finalizeAll(c);
    assert.equal(await j.reconcile(row(1).id), 'dropped', 'released with head state + headers only');
    assert.ok(!calls.some(x => x[0] === 'count'), 'no account-state read by number at all');
  }
  // no finalized tag: anchored, never released
  const noFin = client({ finalized: null, count: () => 99 });
  const j = await journal(noFin, { dropConfirmMs: 0, name: 'nofin' });
  await j.claim(row(3)); await j.signed(row(3).id, swapHash, 'swap', 5);
  for (let i = 0; i < 3; i += 1) { noFin.head += 10_000n; assert.equal(await j.reconcile(row(3).id), 'signed', 'no finalized tag: never released'); }
  assert.ok((await j.get(row(3).id)).dropAnchor);
  // nonce not consumed at the head: nothing anchored, never released
  const live = client({ count: () => 5 });
  const k = await journal(live, { dropConfirmMs: 0, name: 'live' });
  await k.claim(row(5)); await k.signed(row(5).id, swapHash, 'swap', 5);
  for (let i = 0; i < 3; i += 1) { finalizeAll(live); assert.equal(await k.reconcile(row(5).id), 'signed'); }
  assert.equal((await k.get(row(5).id)).dropAnchor, null);
});

test('F3.3 a receipt for the exact hash (or a mined tx) is never a drop, and it voids an anchor', async () => {
  for (const c of [client({ mined: true, count: () => 9 }), client({ count: () => 9, tx: h => ({ hash: h, from: trader, nonce: 5, blockNumber: 7n }) })]) {
    const j = await journal(c, { dropConfirmMs: 0, name: Math.random().toString() });
    await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
    for (let i = 0; i < 3; i += 1) { finalizeAll(c); assert.notEqual(await j.reconcile(row(1).id), 'dropped'); }
  }
  let mined = false;
  const c = client({ count: () => 9 });
  const base = c.getTransactionReceipt;
  c.getTransactionReceipt = async a => (mined ? { transactionHash: a.hash, status: 'success', blockNumber: c.head + 1n, blockHash } : base(a));
  const j = await journal(c, { dropConfirmMs: 0, name: 'flap' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed'); assert.notEqual((await j.get(row(1).id)).dropAnchor, null);
  mined = true; finalizeAll(c); // a lagging node had hidden it: now visible -> anchor void
  assert.equal(await j.reconcile(row(1).id), 'signed');
  const r = await j.get(row(1).id); assert.equal(r.dropAnchor, null); assert.equal(r.dropSeenAt, null);
});

test('F3.4 still-pending tx with the same nonce is a drop (nonce consumed: it can never be mined); mismatching tx data is not', async () => {
  const pend = client({ count: () => 6, tx: h => ({ hash: h, from: trader, nonce: 5, blockNumber: null }) });
  const j = await journal(pend, { dropConfirmMs: 0, name: 'pend' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  await j.reconcile(row(1).id); finalizeAll(pend);
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  const dropAnchor = { blockNumber: LATEST.toString(), blockHash: bh(LATEST), accountNonce: '6' };
  for (const tx of [h => ({ hash: h, from: other, nonce: 5, blockNumber: null }), h => ({ hash: h, from: trader, nonce: 6, blockNumber: null }),
    () => ({ hash: apprHash, from: trader, nonce: 5, blockNumber: null })]) {
    const c = client({ count: () => 6, tx }); finalizeAll(c);
    assert.equal((await verifyEvmDropped({ client: c, chainId: 4663, row: { hash: swapHash, trader, txNonce: '5', dropAnchor } })).dropped, false);
  }
});

test('F3.5 fail closed: legacy rows without txNonce, wrong chain, RPC errors, malformed rows/anchors, no verifyDropped', async () => {
  const c = client({ count: () => 99 });
  const j = await journal(c, { dropConfirmMs: 0, name: 'fc' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap'); // legacy signature (no account nonce persisted)
  for (let i = 0; i < 3; i += 1) { finalizeAll(c); assert.equal(await j.reconcile(row(1).id), 'signed'); }
  const off = await journal(c, { dropConfirmMs: 0, dropped: false, name: 'off' });
  await off.claim(row(3)); await off.signed(row(3).id, swapHash, 'swap', 1);
  for (let i = 0; i < 3; i += 1) { finalizeAll(c); assert.equal(await off.reconcile(row(3).id), 'signed'); }
  const good = { blockNumber: LATEST.toString(), blockHash: bh(LATEST), accountNonce: '99' };
  const fin = () => { const x = client({ count: () => 99 }); finalizeAll(x); return x; };
  const r = { hash: swapHash, trader, txNonce: '5' };
  assert.equal((await verifyEvmDropped({ client: fin(), chainId: 4663, row: { ...r, dropAnchor: good } })).dropped, true, 'control: the good anchor proves');
  const bad = [
    { client: client({ chainId: 56, count: () => 99 }), row: r },
    { client: { ...client({ count: () => 99 }), request: async () => { throw Error('rate limited'); } }, row: r },
    { client: { ...client({ count: () => 99 }), getTransactionReceipt: async () => { throw Error('timeout'); } }, row: r },
    { client: { ...client({ count: () => 99 }), getBlock: async () => { throw Error('unsupported block tag'); } }, row: r },
    { client: { ...fin(), getTransactionReceipt: async () => { throw Error('timeout'); } }, row: { ...r, dropAnchor: good } },
    { client: { ...fin(), getChainId: async () => 56 }, row: { ...r, dropAnchor: good } },
    { client: fin(), row: { ...r, dropAnchor: { ...good, accountNonce: '5' } } }, // the anchor does not consume the signed nonce
    { client: fin(), row: { ...r, dropAnchor: { ...good, blockHash: bh(LATEST, 7n) } } }, // not the canonical block
    { client: fin(), row: { ...r, dropAnchor: 'yes' } }, { client: fin(), row: { ...r, dropAnchor: { ...good, blockNumber: 1 } } },
    { client: c, row: { ...r, txNonce: null } }, { client: c, row: { ...r, txNonce: '-1' } }, { client: c, row: { ...r, trader: 'x' } },
    { client: c, row: { ...r, hash: null } }, { client: c, row: r, confirmations: 0 },
  ];
  for (const b of bad) assert.equal((await verifyEvmDropped({ chainId: 4663, ...b })).dropped, false);
  // a transient error during the proof KEEPS the anchor (re-proven next time); it never releases
  const flaky = client({ count: () => 9 });
  const k = await journal(flaky, { dropConfirmMs: 0, name: 'flaky' });
  await k.claim(row(5)); await k.signed(row(5).id, swapHash, 'swap', 5);
  await k.reconcile(row(5).id); const a1 = await k.get(row(5).id);
  assert.ok(a1.dropAnchor);
  finalizeAll(flaky); const gb = flaky.getBlock; flaky.getBlock = async () => { throw Error('502'); };
  assert.equal(await k.reconcile(row(5).id), 'signed');
  assert.deepEqual(await k.get(row(5).id), a1, 'unchanged on a read error');
  flaky.getBlock = gb; assert.equal(await k.reconcile(row(5).id), 'dropped');
  await assert.rejects(openEvmClaims({ indexedDB: memoryIDB(), name: 'x', verifyFinal: async () => ({ final: false }), verifyDropped: 'yes' }), /release options/);
  await assert.rejects(openEvmClaims({ indexedDB: memoryIDB(), name: 'y', verifyFinal: async () => ({ final: false }), dropConfirmMs: -1 }), /release options/);
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 1.5), /refuses/);
});

test('F3.6 a dropped APPROVAL ends the trade (status dropped, not idle): the swap of that quote can never be signed', async () => {
  const c = client({ count: () => 4 });
  const j = await journal(c, { dropConfirmMs: 0, name: 'appr' });
  await j.claim(row(1)); await j.signed(row(1).id, apprHash, 'approve-exact', 3);
  await j.reconcile(row(1).id); finalizeAll(c);
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 4), /refuses/);
  await assert.rejects(j.cancelIdle(row(1).id));
  assert.equal(await j.pending(trader), null);
});

test('F3.7 the anchor and its first sighting are durable: the release survives a reload', async () => {
  const idb = memoryIDB();
  const c = client({ count: () => 9 });
  let j = await journal(c, { idb, name: 'persist' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  await j.reconcile(row(1).id); j.close();
  clock += 61_000; finalizeAll(c);
  j = await journal(c, { idb, name: 'persist' });
  assert.equal(await j.reconcile(row(1).id), 'dropped');
});

test('F3.8 (engine-review R1) a reorged anchor is void: re-anchored on the new chain, and the 60 s rule restarts', async () => {
  const c = client({ count: () => 9 });
  const j = await journal(c, { name: 'reorg' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  await j.reconcile(row(1).id);
  const first = await j.get(row(1).id);
  clock += 120_000;
  c.fork = 1n; c.forkFrom = LATEST - 10n; finalizeAll(c); // the anchor block was replaced before it finalized
  assert.equal(await j.reconcile(row(1).id), 'signed', 'a non-canonical anchor never releases');
  const voided = await j.get(row(1).id); assert.equal(voided.dropAnchor, null); assert.equal(voided.dropSeenAt, null);
  assert.equal(await j.reconcile(row(1).id), 'signed');
  const again = await j.get(row(1).id);
  assert.equal(again.dropAnchor.blockHash, bh(c.head, 1n)); assert.equal(again.dropSeenAt, clock); assert.notEqual(again.dropSeenAt, first.dropSeenAt);
  finalizeAll(c);
  assert.equal(await j.reconcile(row(1).id), 'signed', 'final, but < 60 s after the new anchor');
  clock += 60_000;
  assert.equal(await j.reconcile(row(1).id), 'dropped');
});

test('F3.9 (engine-review R3) a bad clock reading never stores a sighting and never skips the 60 s wait', async () => {
  const c = client({ count: () => 9, finalized: LATEST });
  let t = NaN;
  const j = await journal(c, { clockFn: () => t, name: 'nan' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed');
  const r1 = await j.get(row(1).id);
  assert.equal(r1.dropAnchor, null, 'nothing persisted with a NaN clock'); assert.equal(r1.dropSeenAt, null);
  t = clock;
  assert.equal(await j.reconcile(row(1).id), 'signed', 'first real sighting');
  c.head += 2n; c.fin = c.head;
  t = NaN; assert.equal(await j.reconcile(row(1).id), 'signed', 'no release on a NaN reading');
  t = clock + 30_000; assert.equal(await j.reconcile(row(1).id), 'signed', 'still < 60 s');
  t = clock + 60_000; assert.equal(await j.reconcile(row(1).id), 'dropped');
});

test('F3.10 (engine-review R2) two tabs: a tab with a stale row never overwrites or releases on the other tab\'s anchor', async () => {
  const idb = memoryIDB();
  const c = client({ count: () => 9 });
  const a = await journal(c, { idb, name: 'tabs' }), b = await journal(c, { idb, name: 'tabs' });
  await a.claim(row(1)); await a.signed(row(1).id, swapHash, 'swap', 5);
  // tab B starts a reconcile (reads the row, no anchor yet) while tab A anchors
  let release; const gate = new Promise(res => { release = res; });
  const slow = { ...c, getChainId: async () => { await gate; return 4663; } };
  const bSlow = await openEvmClaims({ indexedDB: idb, name: 'tabs', now, dropConfirmMs: 60000, verifyFinal: async () => ({ final: false }),
    verifyDropped: r => verifyEvmDropped({ client: slow, chainId: 4663, row: r, confirmations: null }) });
  const pendingB = bSlow.reconcile(row(1).id);
  await new Promise(res => setTimeout(res, 5));
  assert.equal(await a.reconcile(row(1).id), 'signed');
  const anchoredByA = await b.get(row(1).id);
  assert.ok(anchoredByA.dropAnchor);
  clock += 61_000; finalizeAll(c);
  release();
  assert.equal(await pendingB, 'signed', 'B saw a fresh head (a NEW anchor) on a stale row: it neither replaces nor releases');
  assert.deepEqual((await b.get(row(1).id)).dropAnchor, anchoredByA.dropAnchor);
  assert.equal(await b.reconcile(row(1).id), 'dropped', 'a fresh read of A\'s anchor releases');
});

// ── F2 OPTION (default OFF): Robinhood L2 receipt + N confirmations ──
test('F2.1 DEFAULT (L1 finality): on Robinhood a mined, confirmed swap holds the wallet; approval is not idle (the ~19 min lockout stays)', async () => {
  const j = await journal(client({ mined: true }), { name: 'f21' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed');
  assert.ok(await j.pending(trader));
  assert.equal(await j.claim(row(2)), false, "same wallet still locked");
  assert.equal(await j.claim({ ...row(2), trader: other }), true);
});

test('F2.2 OPTION on: the canonical L2 receipt + N confirmations releases a swap (soft, audited) and an approval to idle', async () => {
  const c = client({ mined: true });
  const j = await journal(c, { l2: 3, name: 'f22' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'finished');
  assert.equal(await j.pending(trader), null);
  assert.deepEqual((await j.get(row(1).id)).history, [{ hash: swapHash, phase: 'swap', success: true, txNonce: '5', soft: true, blockNumber: (LATEST - 5n).toString(), blockHash }]);
  assert.equal(await j.claim(row(1)), false, 'quote nonce stays consumed after a soft release');
  assert.equal(await j.claim(row(2)), true);
  await j.signed(row(2).id, apprHash, 'approve-exact', 6);
  assert.equal(await j.reconcile(row(2).id), 'idle', 'approve-then-sell can continue');
});

test('F2.3 OPTION on: too few confirmations, orphaned block, wrong chain or no receipt never release', async () => {
  const r = { hash: swapHash };
  assert.deepEqual(await verifyEvmL2Receipt({ client: client({ mined: true }), chainId: 4663, row: r, confirmations: 7 }), { final: false }, '5 blocks on top, 7 required');
  assert.equal((await verifyEvmL2Receipt({ client: client({ mined: true }), chainId: 4663, row: r, confirmations: 6 })).final, true, 'receipt block + 5 = 6 confirmations');
  const orphan = { ...client({ mined: true }), getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: finHash }) };
  for (const c of [orphan, client({ chainId: 56, mined: true }), client({ mined: false }), { ...client({ mined: true }), getBlockNumber: async () => { throw Error('x'); } }]) {
    assert.deepEqual(await verifyEvmL2Receipt({ client: c, chainId: 4663, row: r, confirmations: 2 }), { final: false });
  }
  assert.deepEqual(await verifyEvmL2Receipt({ client: client({ mined: true }), chainId: 4663, row: r, confirmations: 0 }), { final: false });
});

test('F2.4 OPTION on: the drop anchor must have N confirmations (latest-(N-1) >= anchor), the same finality as the release', async () => {
  const calls = [];
  const c = client({ count: () => 6, calls });
  const row0 = { hash: swapHash, trader, txNonce: '5' };
  const a = await verifyEvmDropped({ client: c, chainId: 4663, row: row0, confirmations: 10 });
  assert.deepEqual(a, { dropped: false, anchor: { blockNumber: LATEST.toString(), blockHash: bh(LATEST), accountNonce: '6' } });
  assert.deepEqual(calls.find(x => x[0] === 'countByHash'), ['countByHash', trader, bh(LATEST)]);
  c.head += 8n;
  assert.deepEqual(await verifyEvmDropped({ client: c, chainId: 4663, row: { ...row0, dropAnchor: a.anchor }, confirmations: 10 }), { dropped: false, anchor: a.anchor }, '9 confirmations');
  c.head += 1n;
  assert.deepEqual(await verifyEvmDropped({ client: c, chainId: 4663, row: { ...row0, dropAnchor: a.anchor }, confirmations: 10 }),
    { dropped: true, hash: swapHash, accountNonce: '6', atBlock: LATEST.toString(), atBlockHash: bh(LATEST) });
  assert.ok(!calls.some(x => x[0] === 'count'), 'no state read by number');
});

// ── engine wiring (the lane is OFF in this build, so the wiring is pinned by source) ──
const SRC = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const evm = SRC.slice(SRC.indexOf('async function terminalTradeEvm'));
test('W1 the F2 option is OFF in this build and lives in its own reviewed constant', () => {
  const cfg = readFileSync(new URL('../src/terminalEvmRelease.ts', import.meta.url), 'utf8');
  assert.match(cfg, /\nexport const TERMINAL_EVM_RH_L2_RELEASE: Readonly<\{ confirmations: number \}> \| null = null;\n$/);
  assert.equal((cfg.match(/export /g) || []).length, 1);
  assert.match(SRC, /const l2Release = key === 'robinhood' \? TERMINAL_EVM_RH_L2_RELEASE : null;/);
  assert.match(SRC, /const releaseConfirmations = l2Release \? Math\.max\(policy\.finalityBlocks, l2Release\.confirmations\) : policy\.finalityBlocks;/);
});
test('W2 option off: release = verifyEvmFinality(policy.finalityBlocks), approval wait = policy.finalityBlocks (unchanged rule)', () => {
  assert.ok(evm.includes(': verifyEvmFinality({ client: publicClient, chainId: policy.chainId, row, confirmations: policy.finalityBlocks }),'));
  assert.ok(evm.includes('verifyFinal: row => l2Release\n'));
  assert.ok(evm.includes('waitForTransactionReceipt({ hash, confirmations: releaseConfirmations, timeout: 30000, pollingInterval: 500 })'));
});
test('W3 the option is validated before any side effect; the signed account nonce is persisted before broadcast; drop check wired', () => {
  const guard = evm.indexOf("throw new Error('Invalid terminal release option')");
  assert.ok(guard > 0 && guard < evm.indexOf('keepHot();') && guard < evm.indexOf("await gate('transfer')") && guard < evm.indexOf('openEvmClaims('));
  assert.ok(evm.includes('policy.chainId !== 4663 ||'), 'Robinhood only');
  const signed = evm.indexOf('await journal.signed(claimId!, hash, phase, nonce);');
  assert.ok(signed > 0 && signed < evm.indexOf('broadcast(raw'));
  assert.ok(evm.includes('verifyDropped: row => verifyEvmDropped({ client: publicClient, chainId: policy.chainId, row, confirmations: l2Release ? releaseConfirmations : null })'));
  // unknown outcome is never retried: still exactly one broadcast per signature and no resend path
  assert.equal((evm.match(/broadcast\(raw/g) || []).length, 1);
});
test('W4 (engine-review) the held message names the anchored state, not a one-minute wait (Robinhood finality is ~19 min)', () => {
  assert.ok(evm.includes("${still.dropAnchor != null ? ' (it looks dropped; re-checking once that is final, try again in a few minutes)' : ''}"));
  assert.ok(!evm.includes('try again in a minute'));
});
