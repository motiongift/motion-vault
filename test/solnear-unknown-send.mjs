// V12 batch-2 — Group A "unknown-outcome sends" (F-1, F-17, F-55, F-64).
// The one danger these guard against: a transaction that LANDS on chain while the RPC response is lost must never be
// recorded as a failure and re-sent, or the funds move twice. Every test mocks a hung / silent RPC that still "lands"
// the tx and asserts the wallet is HELD — no second outflow — until the chain itself confirms or the send can no
// longer land. No network: global.fetch is stubbed and dispatched by JSON-RPC method.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SolSendUnknown, solTransfer, setSolRpcs } from '../src/solEngine.ts';
import { NearSendUnknown, nearTransfer, nearTxState, setNearRpcs, b58encode } from '../src/nearEngine.ts';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const withFetch = async (impl, fn) => { const orig = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = orig; } };
const bh32 = b58encode(new Uint8Array(32).fill(9));          // a valid 32-byte base58 blockhash / block_hash
const addr32 = b58encode(new Uint8Array(32).fill(5));        // a valid 32-byte Solana address to send to

// ── Solana: solTransfer over a silent send holds the wallet until the signature confirms ──
test('F-1/F-55 Solana: a silent send holds the wallet; no second outflow until it confirms', async () => {
  setSolRpcs([], []);                                        // no user nodes: roads are the relay + publicnode only
  const A = { id: 'a', name: 'w', address: '0x' + '0'.repeat(40), key: 'sol:' + '11'.repeat(32) };
  const st = { send: 'silent', sigStatus: null, lvh: 1000, height: 990 };
  const impl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'sendTransaction') { if (st.send === 'silent') throw new TypeError('failed to fetch'); return ok({ result: 'LANDED_SIG' }); }
    if (method === 'getBalance') return ok({ result: { context: { slot: 1 }, value: 2_000_000_000 } });
    if (method === 'getLatestBlockhash') return ok({ result: { context: { slot: 1 }, value: { blockhash: bh32, lastValidBlockHeight: st.lvh } } });
    if (method === 'getSignatureStatuses') return ok({ result: { context: { slot: 1 }, value: [st.sigStatus] } });
    if (method === 'getBlockHeight') return ok({ result: st.height });
    return ok({ result: null });
  };
  await withFetch(impl, async () => {
    // 1) the send goes silent on every road — not a failure: SolSendUnknown, carrying the signature, and the hold is set
    const e = await solTransfer(A, addr32, 0.01).then(() => null, (err) => err);
    assert.ok(e instanceof SolSendUnknown, `expected SolSendUnknown, got ${e}`);
    assert.ok(e.hash && e.hash.length > 0, 'the unknown send carries no signature hash');

    // 2) the tx may still have landed: while the signature shows no status and its blockhash has not expired, a
    //    second transfer from the SAME wallet is refused (this is what stops the double-send)
    st.send = 'ok';                                          // even though sends would now succeed…
    const held = await solTransfer(A, addr32, 0.01).then(() => null, (err) => err);
    assert.ok(held && /unknown status|may still land/i.test(String(held.message)), `expected a hold refusal, got ${held}`);

    // 3) the chain confirms the first signature → the outcome is known → the wallet is free again
    st.sigStatus = { slot: 100, confirmationStatus: 'confirmed', err: null };
    const sig = await solTransfer(A, addr32, 0.01);
    assert.equal(typeof sig, 'string');
  });
});

test('F-55 Solana: an expired blockhash (height past lvh) also releases the hold — the bytes can never land', async () => {
  setSolRpcs([], []);
  const A = { id: 'b', name: 'w', address: '0x' + '0'.repeat(40), key: 'sol:' + '22'.repeat(32) };
  const st = { send: 'silent', lvh: 1000, height: 990 };
  const impl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'sendTransaction') { if (st.send === 'silent') throw new TypeError('failed to fetch'); return ok({ result: 'SIG2' }); }
    if (method === 'getBalance') return ok({ result: { context: { slot: 1 }, value: 2_000_000_000 } });
    if (method === 'getLatestBlockhash') return ok({ result: { context: { slot: 1 }, value: { blockhash: bh32, lastValidBlockHeight: st.lvh } } });
    if (method === 'getSignatureStatuses') return ok({ result: { context: { slot: 1 }, value: [null] } });   // never confirms
    if (method === 'getBlockHeight') return ok({ result: st.height });
    return ok({ result: null });
  };
  await withFetch(impl, async () => {
    await assert.rejects(() => solTransfer(A, addr32, 0.01), (e) => e instanceof SolSendUnknown);
    st.send = 'ok';
    await assert.rejects(() => solTransfer(A, addr32, 0.01), /unknown status|may still land/i);   // still held
    st.height = st.lvh + 1;                                  // confirmed height has passed lastValidBlockHeight
    assert.equal(typeof await solTransfer(A, addr32, 0.01), 'string');   // released
  });
});

// ── NEAR: a lost EXECUTED_OPTIMISTIC response is pending, holds the wallet, and keeps the access-key cache ──
test('F-17 NEAR: a transient send is pending → NearSendUnknown + hold; second transfer refused until settled', async () => {
  setNearRpcs([], []);
  const A = { id: 'c', name: 'w', address: '0x' + '0'.repeat(40), key: 'near:' + '33'.repeat(32) };
  const to = 'ab'.repeat(32);                                // a 64-hex implicit account: no existence read needed
  const st = { phase: 'silent' };                            // silent → unknown → settled
  const accessKey = { nonce: 5, block_hash: b58encode(new Uint8Array(32).fill(1)), permission: 'FullAccess' };
  const impl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === 'query' && params?.request_type === 'view_access_key') return ok({ result: accessKey });
    if (method === 'send_tx' || method === 'broadcast_tx_commit') { if (st.phase === 'settled') return ok({ result: { status: { SuccessValue: '' }, transaction: { hash: 'X' } } }); throw new Error('network down'); }
    if (method === 'tx') {
      if (st.phase === 'unknown') throw new Error('timeout');                 // no node answers → nearTxState 'unknown'
      if (st.phase === 'settled') return ok({ result: { status: { SuccessValue: '' }, transaction_outcome: { id: params.tx_hash } } });
      throw new Error('timeout');
    }
    return ok({ result: {} });
  };
  await withFetch(impl, async () => {
    // 1) the EXECUTED_OPTIMISTIC send loses its response (transient): pending, not failed → NearSendUnknown + hold
    const e = await nearTransfer(A, to, 0.1).then(() => null, (err) => err);
    assert.ok(e instanceof NearSendUnknown, `expected NearSendUnknown, got ${e}`);
    assert.ok(e.hash && e.hash.length > 0, 'the unknown NEAR send carries no hash');

    // 2) while the hash is unknown and the on-chain nonce has not reached ours, a second transfer is refused
    st.phase = 'unknown';
    const held = await nearTransfer(A, to, 0.1).then(() => null, (err) => err);
    assert.ok(held && /unknown status|may still land/i.test(String(held.message)), `expected a hold refusal, got ${held}`);

    // 3) a node now shows the hash executed (success) → the hold clears and the wallet trades again
    st.phase = 'settled';
    const hash = await nearTransfer(A, to, 0.1);
    assert.equal(typeof hash, 'string');
  });
});

// ── NEAR: nearTxState only trusts THIS transaction's receipt and never lets a lone failure win ──
test('F-64 NEAR: a node answering with another tx\'s receipt is not "executed" (stays pending)', async () => {
  setNearRpcs([], []);
  const impl = async (url, init) => {
    const { params } = JSON.parse(init.body);
    // both nodes return a final SUCCESS status but for a DIFFERENT hash than the one asked about
    return ok({ result: { status: { SuccessValue: '' }, transaction_outcome: { id: 'SOME_OTHER_HASH' }, final_execution_status: 'EXECUTED' } });
  };
  const r = await withFetch(impl, () => nearTxState('THE_HASH', 'alice'));
  assert.equal(r.state, 'pending', 'a mismatched outcome id must not be read as executed');
});

test('F-64 NEAR: a lone Failure contradicted by a success resolves to success, not failed', async () => {
  setNearRpcs([], []);
  let n = 0;
  const impl = async (url, init) => {
    const { params } = JSON.parse(init.body);
    n += 1;
    const body = n === 1
      ? { status: { Failure: { error: 'x' } }, transaction_outcome: { id: params.tx_hash }, final_execution_status: 'EXECUTED' }
      : { status: { SuccessValue: '' }, transaction_outcome: { id: params.tx_hash }, final_execution_status: 'EXECUTED' };
    return ok({ result: body });
  };
  const r = await withFetch(impl, () => nearTxState('THE_HASH', 'alice'));
  assert.equal(r.state, 'success', 'a success from any node must override a single-node Failure');
});

test('F-64 NEAR: a status with more than one of Success*/Failure is not a final verdict (pending)', async () => {
  setNearRpcs([], []);
  const impl = async (url, init) => ok({ result: { status: { SuccessValue: '', Failure: {} }, transaction_outcome: { id: JSON.parse(init.body).params.tx_hash }, final_execution_status: 'EXECUTED' } });
  const r = await withFetch(impl, () => nearTxState('THE_HASH', 'alice'));
  assert.equal(r.state, 'pending');
});

test('F-64 NEAR: dropped only when EVERY node agrees the tx is missing', async () => {
  setNearRpcs([], []);
  const impl = async () => { throw new Error("doesn't exist"); };   // both defaults say unknown-transaction
  const r = await withFetch(impl, () => nearTxState('THE_HASH', 'alice'));
  assert.equal(r.state, 'missing');
});
