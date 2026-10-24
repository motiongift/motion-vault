// V12 batch-1 Solana behavior tests (no network — global.fetch is stubbed or settings are pinned).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPlan, solRpc, setSolRpcs } from '../src/solEngine.ts';

const CU_CEIL = 400_000n, CEIL = 5_000_000n;   // the clamp's worst-case compute limit and ceiling
const costOf = (p) => p.tipLamports + (BigInt(p.micro) * CU_CEIL) / 1_000_000n;

test('F-8: a pinned turbo tip + priority can never cost more than ~0.005 SOL/tx', async () => {
  // 0.1 SOL tip + 5M µlamports would be ~2 SOL/tx uncapped
  const p = await sendPlan({ slippage: 1, gasBoost: 1, turbo: true, solTip: 0.1, solPriority: 5_000_000 });
  assert.ok(costOf(p) <= CEIL, `cost ${costOf(p)} over ceiling`);
  assert.ok(p.tipLamports <= CEIL);
});

test('F-8: a modest pinned plan is left intact under the ceiling', async () => {
  const p = await sendPlan({ slippage: 1, gasBoost: 1, turbo: true, solTip: 0.001, solPriority: 5_000_000 });
  assert.equal(p.tipLamports, 1_000_000n);     // 0.001 SOL untouched
  assert.equal(p.micro, 5_000_000);            // fits: 1M tip + 2M priority = 3M < 5M ceiling
  assert.ok(costOf(p) <= CEIL);
});

test('F-8: eco plan (no pins, no network needed) stays well under the ceiling', async () => {
  const p = await sendPlan({ slippage: 1, gasBoost: 1, turbo: false });   // gasBoost<=1 => eco, FALLBACK_TIPS, no fetch
  assert.ok(costOf(p) <= CEIL);
  assert.equal(p.mode, 'eco');
});

test('F-38: a node answering a read with a malformed shape is skipped for the next road', async () => {
  setSolRpcs([], []);   // no user nodes: order is publicnode then the relay
  const hits = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    hits.push(String(url));
    const publicnode = String(url).includes('publicnode');
    // publicnode returns garbage (no { context, value }); the relay returns a well-formed empty account
    const body = publicnode ? { result: 'garbage-not-an-object' } : { result: { context: { slot: 1 }, value: null } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const r = await solRpc('getAccountInfo', ['So11111111111111111111111111111111111111112', { encoding: 'base64' }]);
    assert.deepEqual(r, { context: { slot: 1 }, value: null });   // the good relay answer, not the garbage
    assert.ok(hits.some((u) => u.includes('publicnode')), 'publicnode was not tried');
    assert.ok(hits.length >= 2, 'did not fall through past the malformed node');
  } finally { globalThis.fetch = orig; }
});
