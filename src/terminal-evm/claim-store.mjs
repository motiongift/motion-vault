// Durable write-ahead journal for the new terminal lane only. No timeout unlock.
const req = x => new Promise((resolve, reject) => { x.onsuccess = () => resolve(x.result); x.onerror = () => reject(x.error); });
const done = x => new Promise((resolve, reject) => { x.oncomplete = resolve; x.onerror = () => reject(x.error); x.onabort = () => reject(x.error || Error('Journal aborted')); });
export async function openEvmClaims({ indexedDB = globalThis.indexedDB, name, verifyFinal }) {
    if (!indexedDB || !name || typeof verifyFinal !== 'function')
        throw Error('Durable journal and trusted finality reader required');
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
        signed: (id, hash, phase) => tx('readwrite', async (c) => {
            const r = await req(c.get(id));
            if (!r || r.status !== 'idle' || !/^0x[a-fA-F0-9]{64}$/.test(hash) || !['approve-zero', 'approve-exact', 'swap'].includes(phase))
                throw Error('Journal refuses another signature');
            await req(c.put({ ...r, status: 'signed', hash, phase }));
        }),
        // Only exact persisted hash is eligible. No byte rebuild, transaction replacement or resend API.
        reconcile: async (id) => {
            const r = await get(id);
            if (!r || r.status !== 'signed')
                return r?.status;
            const p = await verifyFinal(Object.freeze({ ...r }));
            if (!p?.final || p.hash !== r.hash)
                return 'signed';
            return tx('readwrite', async (c, l) => {
                const current = await req(c.get(id));
                if (current?.hash !== r.hash || current.status !== 'signed')
                    throw Error('Journal changed');
                const terminal = r.phase === 'swap' || !p.success;
                const history = [...(current.history || []), { hash: r.hash, phase: r.phase, success: p.success === true }];
                const next = { ...current, history, status: terminal ? 'finished' : 'idle', hash: terminal ? r.hash : null, phase: terminal ? r.phase : null };
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
