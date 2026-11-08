import { SOL } from './portable-wire.mjs';

const request = operation => new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
const finished = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || Error('Receipt transaction aborted')); });
const transitions = { claimed: ['signed', 'unknown'], signed: ['sending', 'unknown'], sending: ['submitted', 'unknown'], submitted: ['unknown'], unknown: ['unknown'] };
const lockKeys = row => [`wallet:${row.trader}`, ...(row.reservationId ? [`reservation:${row.reservationId}`] : [])];

/** Persistent browser/WebView store. Call reconcile only with a constructor-injected
 * trusted RPC finality reader. No receipt or wallet is released on wall-clock timeout.
 * A separate common vault hold still protects non-terminal outflows (sendExact seam).
 */
export async function openTerminalReceiptStore({ indexedDB = globalThis.indexedDB, name = 'motion-terminal-solana-v1', verifySettlement } = {}) {
  if (!indexedDB || typeof verifySettlement !== 'function') throw Error('IndexedDB and trusted finality reader required');
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => { const db = opening.result; db.createObjectStore('claims', { keyPath: 'receiptId' }); db.createObjectStore('locks'); };
  const db = await request(opening);
  const transact = async (mode, fn) => {
    const tx = db.transaction(['claims', 'locks'], mode), end = finished(tx);
    try { const value = await fn(tx.objectStore('claims'), tx.objectStore('locks')); await end; return value; }
    catch (error) { try { tx.abort(); } catch {} await end.catch(() => {}); throw error; }
  };
  return Object.freeze({
    close: () => db.close(),
    get: receiptId => transact('readonly', claims => request(claims.get(receiptId))),
    pending: trader => transact('readonly', async (claims, locks) => { const id = await request(locks.get(`wallet:${trader}`)); return id ? request(claims.get(id)) : null; }),
    async claim(row) {
      if (!row || row.status !== 'claimed' || !/^[0-9a-f]{64}$/.test(row.receiptId) || !row.trader || !row.messageSha256 || !row.receiptHash) throw Error('Invalid receipt claim');
      const value = structuredClone(row), keys = lockKeys(value);
      return transact('readwrite', async (claims, locks) => {
        const prior = await Promise.all([request(claims.get(value.receiptId)), ...keys.map(k => request(locks.get(k)))]);
        if (prior.some(Boolean)) return false;
        await Promise.all([request(claims.add(value)), ...keys.map(k => request(locks.put(value.receiptId, k)))]);
        return true;
      });
    },
    update(receiptId, patch) {
      if (!patch || Object.keys(patch).some(k => !['status', 'signature'].includes(k))) throw Error('Invalid receipt update');
      return transact('readwrite', async claims => {
        const row = await request(claims.get(receiptId));
        if (!row || !transitions[row.status]?.includes(patch.status) || (row.signature && patch.signature !== row.signature)) throw Error('Invalid receipt transition');
        await request(claims.put({ ...row, ...patch }));
      });
    },
    async reconcile(receiptId) {
      const original = await transact('readonly', claims => request(claims.get(receiptId)));
      if (!original) throw Error('Unknown receipt');
      if (['finalized', 'failed', 'expired'].includes(original.status)) return original.status;
      const proof = await verifySettlement(Object.freeze(structuredClone(original)));
      if (!proof || proof.genesis !== SOL.genesis) throw Error('Wrong finality network');
      const expired = proof.status === 'expired' && Number.isSafeInteger(proof.blockHeight) && BigInt(proof.blockHeight) > BigInt(original.lastValidBlockHeight);
      const final = ['finalized', 'failed'].includes(proof.status) && proof.finalized === true && original.signature && proof.signature === original.signature;
      if (!expired && !final) return original.status;
      return transact('readwrite', async (claims, locks) => {
        const current = await request(claims.get(receiptId));
        if (current.receiptHash !== original.receiptHash || current.signature !== original.signature || current.status !== original.status) throw Error('Receipt changed during finality read');
        await request(claims.put({ ...current, status: proof.status }));
        // Receipt and entitlement stay consumed; only this wallet's pending lock is released.
        const key = `wallet:${current.trader}`;
        if (await request(locks.get(key)) === receiptId) await request(locks.delete(key));
        return proof.status;
      });
    },
  });
}
