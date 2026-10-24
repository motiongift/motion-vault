// V12 batch-1 NEAR behavior tests (no network — global.fetch is stubbed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nearRpc, setNearRpcs, validAccessKey, b58encode } from '../src/nearEngine.ts';

const withFetch = async (fn, fetchImpl) => {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
};

test('F-39: both default nodes are tried once (the second is no longer skipped)', async () => {
  setNearRpcs([], []);   // NEAR_RPCS = the two defaults, rpcIdx reset to 0
  const hits = [];
  await withFetch(
    async () => { await assert.rejects(() => nearRpc('status', null)); },
    async (url) => { hits.push(String(url)); throw new Error('network down'); },   // transient => rotate
  );
  const unique = new Set(hits);
  assert.equal(unique.size, 2, `expected both nodes tried once, saw ${[...unique].join(', ')}`);
  assert.ok([...unique].some((u) => u.includes('fastnear')), 'the second default node was never tried');
});

test('F-10/F-38: a result failing the validator is skipped for the next node', async () => {
  setNearRpcs([], []);
  const hits = [];
  const result = await withFetch(
    async () => nearRpc('query', {}, (r) => (r && r.good ? undefined : 'bad shape')),
    async (url) => {
      hits.push(String(url));
      const good = hits.length > 1;   // first node bad shape, second good
      return { ok: true, status: 200, json: async () => ({ result: good ? { good: true } : { good: false } }) };
    },
  );
  assert.deepEqual(result, { good: true });
  assert.ok(hits.length >= 2, 'did not fall through past the bad-shape node');
});

test('F-10: validAccessKey accepts a sound full-access key', () => {
  const ok = { nonce: 123456, block_hash: b58encode(new Uint8Array(32).fill(7)), permission: 'FullAccess' };
  assert.equal(validAccessKey(ok), undefined);
});

test('F-10: validAccessKey rejects bad nonce / permission / block hash', () => {
  const base = { nonce: 1, block_hash: b58encode(new Uint8Array(32)), permission: 'FullAccess' };
  assert.match(String(validAccessKey({ ...base, nonce: '1.5' })), /nonce/);
  assert.match(String(validAccessKey({ ...base, nonce: '1'.repeat(21) })), /nonce/);
  assert.match(String(validAccessKey({ ...base, permission: { FunctionCall: {} } })), /full-access/);
  assert.match(String(validAccessKey({ ...base, block_hash: b58encode(new Uint8Array(16)) })), /32 bytes/);
});

test('F-10: a genuine error result is passed through (not treated as a bad shape)', () => {
  // leaves accessKey/InvalidNonce handling intact for "no such key/account"
  assert.equal(validAccessKey({ error: 'UNKNOWN_ACCESS_KEY' }), undefined);
  assert.equal(validAccessKey(null), undefined);
});
