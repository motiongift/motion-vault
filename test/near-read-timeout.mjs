// trade-core-proposal NEAR-2 (native-scenarios 2026-11-04): a NEAR view read on a node that accepts the connection and never
// answers goes to the next node after 8 s (it waited 20 s: a click's balance / quote / route reads sat that long). Sends and
// the receipt watcher keep their 20 s. Offline: mocked fetch, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';

const seen = [];
globalThis.fetch = (url, init = {}) => {
  const body = JSON.parse(init.body || '{}'); seen.push({ url: String(url), method: body.method, at: Date.now() });
  if (/send_tx|broadcast/.test(body.method)) return Promise.reject(new Error('refused'));
  if (String(url).includes('drpc')) return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))); });
  return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { amount: '2000000000000000000000000', storage_usage: 500, block_hash: 'x', block_height: 1 } }), { status: 200 }));
};
const E = await import(new URL('../src/nearEngine.ts', import.meta.url).href);

test('a hung first node hands a view read to the second within ~8 s (was 20 s)', { timeout: 30_000 }, async () => {
  const t0 = Date.now();
  const st = await E.nearAccountState('someone.near');
  const ms = Date.now() - t0;
  assert.equal(String(st.amount), '2000000000000000000000000');
  assert.ok(ms >= 7_500 && ms < 10_000, `took ${ms} ms`);
  assert.deepEqual(seen.map((x) => x.url.includes('drpc') ? 'drpc' : 'fastnear'), ['drpc', 'fastnear']);
});
