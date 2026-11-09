// fee-sprint3 2026-11-09 — terminal EVM journal release rules (review F3 dropped-tx release, F2 OPTION L2 release, default OFF).
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
const swapHash = '0x' + 'ab'.repeat(32), apprHash = '0x' + '12'.repeat(32), blockHash = '0x' + 'cd'.repeat(32), finHash = '0x' + 'ee'.repeat(32);
const row = (n) => ({ id: n.toString(16).padStart(64, '0'), trader, nonce: String(n), reservation: n % 2 ? '0x' + 'aa'.repeat(32) : null });
const LATEST = 109700409n, FINALIZED = 109689509n; // Robinhood Chain read-only 2026-11-09T02:10:49Z (review F2): finalized lags ~18.7 min
const notFound = (name) => () => { throw Object.assign(new Error('not found'), { name }); };

// A chain client. mined: the swap's receipt exists. count(blockNumber): account nonce at that block.
function client({ chainId = 4663, mined = false, minedHash = null, finalized = FINALIZED, latest = LATEST, count = () => 0, tx = null, calls = [] } = {}) {
  return {
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }) => { calls.push(['receipt', hash]);
      if (mined && (!minedHash || minedHash === hash)) return { transactionHash: hash, status: 'success', blockNumber: latest - 5n, blockHash };
      return notFound('TransactionReceiptNotFoundError')(); },
    getTransaction: async ({ hash }) => { calls.push(['tx', hash]); if (tx) return tx(hash); return notFound('TransactionNotFoundError')(); },
    getTransactionCount: async ({ address, blockNumber, blockTag }) => { calls.push(['count', address, blockNumber, blockTag]); return count(blockNumber); },
    getBlock: async ({ blockTag, blockNumber }) => blockTag === 'finalized' ? (finalized === null ? null : { number: finalized, hash: finHash }) : { number: blockNumber, hash: blockHash },
    getBlockNumber: async () => latest,
  };
}
let clock = 1_800_000_000_000;
const now = () => clock;
async function journal(c, { l2 = null, dropped = true, dropConfirmMs = 60000, idb = memoryIDB(), name = 'j' } = {}) {
  const conf = l2 ?? 2;
  return openEvmClaims({ indexedDB: idb, name, now, dropConfirmMs,
    verifyFinal: r => l2 ? verifyEvmL2Receipt({ client: c, chainId: 4663, row: r, confirmations: conf }) : verifyEvmFinality({ client: c, chainId: 4663, row: r, confirmations: conf }),
    ...(dropped ? { verifyDropped: r => verifyEvmDropped({ client: c, chainId: 4663, row: r, confirmations: l2 ? conf : null }) } : {}) });
}

// ── F3: dropped transaction ──
test('F3.1 a swap that never landed, whose account nonce is consumed at L1 finality, releases the wallet after two proofs >= 60 s apart', async () => {
  const c = client({ count: () => 8 }); // finalized account nonce 8 > signed nonce 5: another tx used nonce 5
  const j = await journal(c);
  assert.equal(await j.claim(row(1)), true);
  await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal((await j.get(row(1).id)).txNonce, '5');
  assert.equal(await j.reconcile(row(1).id), 'signed', 'first proof only marks the sighting');
  assert.equal((await j.get(row(1).id)).dropSeenAt, clock);
  assert.ok(await j.pending(trader), 'still held after one proof');
  clock += 59_000;
  assert.equal(await j.reconcile(row(1).id), 'signed', 'second proof too early');
  clock += 2_000;
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  assert.equal(await j.pending(trader), null, 'wallet released for NEW trades');
  const saved = await j.get(row(1).id);
  assert.equal(saved.status, 'dropped'); assert.equal(saved.hash, swapHash);
  assert.deepEqual(saved.history, [{ hash: swapHash, phase: 'swap', success: false, dropped: true, txNonce: '5', accountNonce: '8', atBlock: FINALIZED.toString() }]);
  // replay protection does not depend on the release: the same quote nonce / reservation can never be claimed again
  assert.equal(await j.claim(row(1)), false);
  assert.equal(await j.claim({ ...row(1), id: 'f'.repeat(64) }), false, 'nonce + reservation keys still consumed');
  assert.equal(await j.claim(row(2)), true, 'a NEW quote is accepted');
  // nothing re-signs the dropped row and the store has no resend / rebuild API
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 5));
  assert.deepEqual(Object.keys(j).sort(), ['cancelIdle', 'claim', 'close', 'get', 'pending', 'reconcile', 'signed']);
});

test('F3.2 the account nonce is read at the FINALIZED block (no latest substitute); not yet passed = held forever', async () => {
  const calls = [];
  const c = client({ count: b => (b === FINALIZED ? 5 : 9), calls }); // latest already passed it, finalized not yet
  const j = await journal(c, { dropConfirmMs: 0 });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  for (let i = 0; i < 4; i += 1) assert.equal(await j.reconcile(row(1).id), 'signed');
  assert.ok(await j.pending(trader));
  assert.ok(calls.some(x => x[0] === 'count' && x[2] === FINALIZED && x[3] === undefined));
  const noFin = await journal(client({ finalized: null, count: () => 99 }), { dropConfirmMs: 0, name: 'nofin' });
  await noFin.claim(row(3)); await noFin.signed(row(3).id, swapHash, 'swap', 5);
  for (let i = 0; i < 3; i += 1) assert.equal(await noFin.reconcile(row(3).id), 'signed', 'no finalized tag: never released');
});

test('F3.3 a receipt for the exact hash (or a mined tx) is never a drop; a non-proof between two proofs resets the sighting', async () => {
  for (const c of [client({ mined: true, count: () => 9 }), client({ count: () => 9, tx: h => ({ hash: h, from: trader, nonce: 5, blockNumber: 7n }) })]) {
    const j = await journal(c, { dropConfirmMs: 0, name: Math.random().toString() });
    await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
    for (let i = 0; i < 3; i += 1) assert.equal(await j.reconcile(row(1).id), 'signed');
    assert.equal((await j.get(row(1).id)).dropSeenAt, null);
  }
  let mined = false;
  const c = client({ count: () => 9 });
  const base = c.getTransactionReceipt;
  c.getTransactionReceipt = async a => (mined ? { transactionHash: a.hash, status: 'success', blockNumber: LATEST - 5n, blockHash } : base(a));
  const j = await journal(c, { dropConfirmMs: 0, name: 'flap' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed'); assert.notEqual((await j.get(row(1).id)).dropSeenAt, null);
  mined = true; // a lagging node had hidden it: now visible (not final under L1 rule) -> sighting reset
  assert.equal(await j.reconcile(row(1).id), 'signed'); assert.equal((await j.get(row(1).id)).dropSeenAt, null);
});

test('F3.4 still-pending tx with the same nonce is a drop (nonce consumed: it can never be mined); mismatching tx data is not', async () => {
  const pend = client({ count: () => 6, tx: h => ({ hash: h, from: trader, nonce: 5, blockNumber: null }) });
  const j = await journal(pend, { dropConfirmMs: 0 });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  await j.reconcile(row(1).id);
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  for (const tx of [h => ({ hash: h, from: other, nonce: 5, blockNumber: null }), h => ({ hash: h, from: trader, nonce: 6, blockNumber: null }),
    () => ({ hash: apprHash, from: trader, nonce: 5, blockNumber: null })]) {
    assert.deepEqual(await verifyEvmDropped({ client: client({ count: () => 6, tx }), chainId: 4663, row: { hash: swapHash, trader, txNonce: '5' } }), { dropped: false });
  }
});

test('F3.5 fail closed: legacy rows without txNonce, wrong chain, RPC errors, malformed rows, no verifyDropped', async () => {
  const c = client({ count: () => 99 });
  const j = await journal(c, { dropConfirmMs: 0 });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap'); // legacy signature (no account nonce persisted)
  for (let i = 0; i < 3; i += 1) assert.equal(await j.reconcile(row(1).id), 'signed');
  const off = await journal(c, { dropConfirmMs: 0, dropped: false, name: 'off' });
  await off.claim(row(3)); await off.signed(row(3).id, swapHash, 'swap', 1);
  for (let i = 0; i < 3; i += 1) assert.equal(await off.reconcile(row(3).id), 'signed');
  const r = { hash: swapHash, trader, txNonce: '5' };
  const bad = [
    { client: client({ chainId: 56, count: () => 99 }), row: r },
    { client: { ...client({ count: () => 99 }), getTransactionCount: async () => { throw Error('rate limited'); } }, row: r },
    { client: { ...client({ count: () => 99 }), getTransactionReceipt: async () => { throw Error('timeout'); } }, row: r },
    { client: { ...client({ count: () => 99 }), getBlock: async () => { throw Error('unsupported block tag'); } }, row: r },
    { client: c, row: { ...r, txNonce: null } }, { client: c, row: { ...r, txNonce: '-1' } }, { client: c, row: { ...r, trader: 'x' } },
    { client: c, row: { ...r, hash: null } }, { client: c, row: r, confirmations: 0 },
  ];
  for (const b of bad) assert.deepEqual(await verifyEvmDropped({ chainId: 4663, ...b }), { dropped: false });
  await assert.rejects(openEvmClaims({ indexedDB: memoryIDB(), name: 'x', verifyFinal: async () => ({ final: false }), verifyDropped: 'yes' }), /release options/);
  await assert.rejects(openEvmClaims({ indexedDB: memoryIDB(), name: 'y', verifyFinal: async () => ({ final: false }), dropConfirmMs: -1 }), /release options/);
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 1.5), /refuses/);
});

test('F3.6 a dropped APPROVAL ends the trade (status dropped, not idle): the swap of that quote can never be signed', async () => {
  const c = client({ count: () => 4 });
  const j = await journal(c, { dropConfirmMs: 0 });
  await j.claim(row(1)); await j.signed(row(1).id, apprHash, 'approve-exact', 3);
  await j.reconcile(row(1).id);
  assert.equal(await j.reconcile(row(1).id), 'dropped');
  await assert.rejects(j.signed(row(1).id, swapHash, 'swap', 4), /refuses/);
  await assert.rejects(j.cancelIdle(row(1).id));
  assert.equal(await j.pending(trader), null);
});

test('F3.7 the first drop sighting is durable: the release survives a reload', async () => {
  const idb = memoryIDB();
  const c = client({ count: () => 9 });
  let j = await journal(c, { idb, name: 'persist' });
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  await j.reconcile(row(1).id); j.close();
  clock += 61_000;
  j = await journal(c, { idb, name: 'persist' });
  assert.equal(await j.reconcile(row(1).id), 'dropped');
});

// ── F2 OPTION (default OFF): Robinhood L2 receipt + N confirmations ──
test('F2.1 DEFAULT (L1 finality): on Robinhood a mined, confirmed swap holds the wallet; approval is not idle (the ~19 min lockout stays)', async () => {
  const j = await journal(client({ mined: true }));
  await j.claim(row(1)); await j.signed(row(1).id, swapHash, 'swap', 5);
  assert.equal(await j.reconcile(row(1).id), 'signed');
  assert.ok(await j.pending(trader));
  assert.equal(await j.claim(row(2)), false, "same wallet still locked");
  assert.equal(await j.claim({ ...row(2), trader: other }), true);
});

test('F2.2 OPTION on: the canonical L2 receipt + N confirmations releases a swap (soft, audited) and an approval to idle', async () => {
  const c = client({ mined: true });
  const j = await journal(c, { l2: 3 });
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

test('F2.4 OPTION on: the drop check reads the account nonce at latest-(N-1), the same finality as the release', async () => {
  const calls = [];
  const d = await verifyEvmDropped({ client: client({ count: () => 6, calls }), chainId: 4663, row: { hash: swapHash, trader, txNonce: '5' }, confirmations: 10 });
  assert.deepEqual(d, { dropped: true, hash: swapHash, accountNonce: '6', atBlock: (LATEST - 9n).toString() });
  assert.deepEqual(calls.find(x => x[0] === 'count'), ['count', trader, LATEST - 9n, undefined]);
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
