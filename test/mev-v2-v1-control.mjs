// CONTROL for test/mev-v2.mjs: the same fake network run against the review-ship engine (TC-M1 v1: private-only, no fallback,
// no hedge, no nonce hold) with protection forced ON. It must show the failure the review blocked TC-M1 for — so the v2 tests
// are known to be able to see it.
//   MEV_WEBENGINE=<path to the review-ship webEngine.ts> node --test test/mev-v2-v1-control.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const SRC = process.env.MEV_WEBENGINE;
const { network, frame, wallet, send, sleep, PRIVATE, V1 } = SRC ? await import('./mev-v2-sim.mjs') : {};

test('v1 control: builders accept but never include → the trade never lands and the next trade of the wallet queues behind it', { skip: !SRC && 'set MEV_WEBENGINE to the review-ship webEngine.ts' }, async () => {
  assert.equal(V1, true, 'MEV_WEBENGINE must be the v1 (review-ship) engine');
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'blackhole'])) }); const f = frame(net); const w = wallet();
  try {
    const h1 = await send(f, w);            // "submitted": a private road accepted it
    await sleep(100); const h2 = await send(f, w);
    assert.equal(await net.waitMined(h1, 3000), null, 'v1: the first trade never lands (no public fallback)');
    assert.equal(await net.waitMined(h2, 500), null, 'v1: the next trade is stuck behind it');
    assert.equal(net.seenPublic.size, 0);
  } finally { await net.stop(); }
});

test('v1 control: builders refuse every send → the trade fails outright (no public road), where v2 lands it', { skip: !SRC && 'set MEV_WEBENGINE' }, async () => {
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'reject'])) }); const f = frame(net); const w = wallet();
  try { await assert.rejects(send(f, w), /underpriced/); } finally { await net.stop(); }
});
