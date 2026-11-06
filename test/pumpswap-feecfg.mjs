// trade-core-proposal SOL-1 (native-scenarios 2026-11-04): a PumpSwap quote does not re-read the pump_amm fee config it already
// holds. Offline: recorded mainnet accounts (test/fixtures/pumpswap-market.json), mocked fetch, nothing leaves the process.
// On the frozen solEngine.ts the second test FAILS (2 reads): that is the extra round trip on every warm PumpSwap click,
// measured −81 ms p50 (229 → 148 ms click → signed) in an interleaved A/B on live nodes (nothing sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FX = JSON.parse(readFileSync(new URL('./fixtures/pumpswap-market.json', import.meta.url), 'utf8'));
const ENGINE = process.env.ENGINE_SOL || fileURLToPath(new URL('../src/solEngine.ts', import.meta.url));
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const m = JSON.parse(init.body || '{}');
  calls.push(m.method);
  if (/send/i.test(m.method)) throw new Error('refused');
  if (m.method === 'getMultipleAccounts') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: m.params[0].map((a) => FX.accounts[a] ?? null) } }), { status: 200 });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'not in fixture: ' + m.method } }), { status: 200 });
};
const S = await import(pathToFileURL(ENGINE).href);
S.setSolApiBase(() => 'http://127.0.0.1:9');
const route = FX.route, user = FX.user;
const reads = () => calls.filter((x) => x === 'getMultipleAccounts').length;

test('first PumpSwap quote reads the market once (the fee config rides in it)', async () => {
  const r0 = reads();
  const first = await S.solTradeIxs(user, route, 'buy', 10_000_000n, 12);
  assert.equal(reads() - r0, 1);
  assert.ok(first.expected > 0n);
});

test('a later PumpSwap quote (fee config cached) makes exactly ONE read — the market — and quotes the same', async () => {
  await new Promise((r) => setTimeout(r, 1600));   // past the 1.5 s market memo: a real later click
  const r0 = reads();
  const again = await S.solTradeIxs(user, route, 'buy', 10_000_000n, 12);
  assert.equal(reads() - r0, 1, 'the cached fee config must not be read again');
  const sell = await S.solTradeIxs(user, route, 'sell', 1_000_000_000n, 12);
  assert.ok(sell.expected > 0n);
  // same numbers as the first quote (same recorded accounts, same fee tier)
  const first = await S.solTradeIxs(user, route, 'buy', 10_000_000n, 12);
  assert.equal(String(again.expected), String(first.expected));
  assert.equal(String(again.minOut), String(first.minOut));
});
