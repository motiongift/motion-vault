// Durable write-ahead journal for the new terminal lane only. No timeout unlock.
// fee-sprint3 (review F3): the only non-receipt release is a PROVEN drop (verifyDropped: the signed account nonce is consumed
// at the chosen finality and the exact hash has no receipt), seen on two reconciles at least dropConfirmMs apart. It releases
// the wallet lock only; the quote nonce / reservation keys stay consumed and nothing is re-signed or re-sent.
const req = x => new Promise((resolve, reject) => { x.onsuccess = () => resolve(x.result); x.onerror = () => reject(x.error); });
const done = x => new Promise((resolve, reject) => { x.oncomplete = resolve; x.onerror = () => reject(x.error); x.onabort = () => reject(x.error || Error('Journal aborted')); });
export async function openEvmClaims({ indexedDB = globalThis.indexedDB, name, verifyFinal, verifyDropped = null, now = Date.now, dropConfirmMs = 60000 }) {
    if (!indexedDB || !name || typeof verifyFinal !== 'function')
        throw Error('Durable journal and trusted finality reader required');
    if ((verifyDropped !== null && typeof verifyDropped !== 'function') || typeof now !== 'function' || !Number.isSafeInteger(dropConfirmMs) || dropConfirmMs < 0)
        throw Error('Invalid journal release options');
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => { opening.result.createObjectStore('claims', { keyPath: 'id' }); opening.result.createObjectStore('locks'); };
    const db = await req(opening);
    const tx = async (mode, fn) => { const t = db.transaction(['claims', 'locks'], mode), end = done(t); try {
        const out = await fn(t.objectStore('claims'), t.objectStore('locks'));
        await end;
        return out;
    }
    catch (e) {
        try {
            t.abort();
        }
        catch { }
        await end.catch(() => { });
        throw e;
    } };
    const keys = r => [`wallet:${r.trader}`, `nonce:${r.trader}:${r.nonce}`, ...(r.reservation ? [`reservation:${r.reservation}`] : [])];
    const get = id => tx('readonly', c => req(c.get(id)));
    // F3: release a held wallet whose signed transaction provably never landed. The status becomes 'dropped' (terminal; the
    // approval -> swap continuation of that trade is over). Two consecutive proofs >= dropConfirmMs apart (one read of a
    // lagging load-balanced node cannot release); a non-proof in between resets the first sighting.
    const reconcileDrop = async (id, r) => {
        if (!verifyDropped || r.txNonce == null)
            return 'signed';
        const d = await verifyDropped(Object.freeze({ ...r }));
        const proven = d?.dropped === true && d.hash === r.hash, at = now();
        if (!proven && r.dropSeenAt == null)
            return 'signed';
        return tx('readwrite', async (c, l) => {
            const current = await req(c.get(id));
            if (current?.hash !== r.hash || current.status !== 'signed' || current.txNonce !== r.txNonce)
                throw Error('Journal changed');
            if (!proven) {
                await req(c.put({ ...current, dropSeenAt: null }));
                return 'signed';
            }
            if (current.dropSeenAt == null || !Number.isFinite(at) || at - current.dropSeenAt < dropConfirmMs) {
                if (current.dropSeenAt == null)
                    await req(c.put({ ...current, dropSeenAt: at }));
                return 'signed';
            }
            const history = [...(current.history || []), { hash: r.hash, phase: r.phase, success: false, dropped: true, txNonce: r.txNonce,
                    accountNonce: String(d.accountNonce), atBlock: String(d.atBlock) }];
            await req(c.put({ ...current, history, status: 'dropped', dropSeenAt: null }));
            await req(l.delete(`wallet:${r.trader}`));
            return 'dropped';
        });
    };
    return Object.freeze({ close: () => db.close(), get,
        pending: trader => tx('readonly', async (c, l) => { const id = await req(l.get(`wallet:${trader.toLowerCase()}`)); return id ? req(c.get(id)) : null; }),
        claim: row => tx('readwrite', async (c, l) => {
            if (!row || !/^[a-f0-9]{64}$/.test(row.id) || !/^0x[a-f0-9]{40}$/.test(row.trader) || !/^\d+$/.test(row.nonce))
                throw Error('Invalid claim');
            const k = keys(row);
            if ((await Promise.all([req(c.get(row.id)), ...k.map(x => req(l.get(x)))])).some(Boolean))
                return false;
            await req(c.add({ ...row, status: 'idle', hash: null, phase: null }));
            for (const key of k)
                await req(l.put(row.id, key));
            return true;
        }),
        // txNonce = the account nonce the transaction was signed with (F3). Omitted = legacy row: never eligible for a drop release.
        signed: (id, hash, phase, txNonce) => tx('readwrite', async (c) => {
            const r = await req(c.get(id));
            if (!r || r.status !== 'idle' || !/^0x[a-fA-F0-9]{64}$/.test(hash) || !['approve-zero', 'approve-exact', 'swap'].includes(phase) ||
                (txNonce !== undefined && (!Number.isSafeInteger(txNonce) || txNonce < 0)))
                throw Error('Journal refuses another signature');
            await req(c.put({ ...r, status: 'signed', hash, phase, txNonce: txNonce === undefined ? null : String(txNonce), dropSeenAt: null }));
        }),
        // Only exact persisted hash is eligible. No byte rebuild, transaction replacement or resend API.
        reconcile: async (id) => {
            const r = await get(id);
            if (!r || r.status !== 'signed')
                return r?.status;
            const p = await verifyFinal(Object.freeze({ ...r }));
            if (!p?.final || p.hash !== r.hash)
                return reconcileDrop(id, r);
            return tx('readwrite', async (c, l) => {
                const current = await req(c.get(id));
                if (current?.hash !== r.hash || current.status !== 'signed')
                    throw Error('Journal changed');
                const terminal = r.phase === 'swap' || !p.success;
                // soft = the F2 option's L2 release (default OFF), kept with its block for a later reorg audit
                const history = [...(current.history || []), { hash: r.hash, phase: r.phase, success: p.success === true,
                        ...(current.txNonce != null ? { txNonce: current.txNonce } : {}),
                        ...(p.soft === true ? { soft: true, blockNumber: String(p.blockNumber), blockHash: String(p.blockHash) } : {}) }];
                const next = { ...current, history, status: terminal ? 'finished' : 'idle', hash: terminal ? r.hash : null, phase: terminal ? r.phase : null,
                    ...(current.dropSeenAt != null ? { dropSeenAt: null } : {}) };
                await req(c.put(next));
                if (terminal)
                    await req(l.delete(`wallet:${r.trader}`));
                return next.status;
            });
        },
        // A known no-send boundary may release only the wallet, never receipt/nonce/reservation.
        cancelIdle: id => tx('readwrite', async (c, l) => { const r = await req(c.get(id)); if (!r || r.status !== 'idle')
            throw Error('Cannot release an uncertain send'); await req(c.put({ ...r, status: 'cancelled' })); await req(l.delete(`wallet:${r.trader}`)); }),
    });
}
