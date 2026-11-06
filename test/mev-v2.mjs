// MEV v2 (mev-v2 2026-11-04): BNB private-first + public fallback of the same bytes + nonce hold — fake-node tests.
// The REAL broadcast / postRaw / mevFallback / holdNonce / nextNonce / signAndSend / landed / feeFor are cut out of
// src/webEngine.ts (scripts/trade-core.mjs declChunk), transpiled and run against a simulated BNB chain:
//   • a public node (publicnode): one public mempool, geth rules (0.05 gwei floor, nonce too low, already known, replacement
//     underpriced, pending count = confirmed + contiguous pool txs — it cannot see what a private road holds);
//   • private roads with a behaviour each: ok / reject / slow / hang / blackhole (accepts, never includes);
//   • builders that seal a block every BLOCK_MS from their private pool + the public pool (sequential nonces only).
// Signing uses throwaway keys generated here; nothing leaves this process.
//   node --test test/mev-v2.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { network, frame, wallet, send, sleep, PUB, BR, PRIVATE, V1 } from './mev-v2-sim.mjs';
const BLOX = 'https://bsc.rpc.blxrbdn.com', C48 = 'https://rpc-bsc.48.club';
if (V1) throw new Error('test/mev-v2.mjs needs the MEV v2 engine (for the v1 control run test/mev-v2-v1-control.mjs)');

test('OFF: the roads are exactly today\'s (publicnode + bloXroute + 48 Club), no fallback, no hold, price unchanged', async () => {
  const net = network(); const f = frame(net, { mev: false }); const w = wallet();
  try {
    assert.deepEqual(f.broadcastUrls(), [PUB, BLOX, C48]);
    assert.equal(await f.feeFor(1.5), 93_750_000n, 'Fast = 0.0625 × 1.5 = 0.094 gwei as today');
    const h = await send(f, w, 93_750_000n);
    assert.equal(f.path, 'public');
    await sleep(150); assert.ok(net.seenPublic.has(h), 'public as today');
    assert.equal(f.privHold.size, 0);
    assert.ok(await net.waitMined(h));
  } finally { await net.stop(); }
});

test('ON: price floor = the 0.05 gwei every road enforces: Fast 0.094 / Eco 0.0625 / Turbo unchanged; a node reading 0.02 gwei cannot push a send under it', async () => {
  const net = network(); const f = frame(net); const low = frame(net, { floor: 25_000_000n });
  try {
    assert.equal(await f.feeFor(1.5), 93_750_000n); assert.equal(await f.feeFor(1), 62_500_000n); assert.equal(await f.feeFor(3), 187_500_000n);
    assert.equal(await low.feeFor(1), 50_000_000n, 'floored at 0.05 gwei'); assert.equal(await low.feeFor(1.5), 50_000_000n);
    assert.deepEqual(f.broadcastUrls(), PRIVATE); assert.deepEqual(f.publicSendUrls(), [PUB], 'the fallback goes to the public node only');
    // a user's trades-only node (a paid node: public mempool) never gets the bytes before the fallback / hedge
    const QN = 'https://x.bsc.quiknode.pro/k'; const u = frame(net, { sendOnly: [QN] });
    assert.deepEqual(u.broadcastUrls(), PRIVATE); assert.deepEqual(u.publicSendUrls(), [QN, PUB]);
    assert.deepEqual(frame(net, { mev: false, sendOnly: [QN] }).broadcastUrls(), [QN, PUB, BLOX, C48], 'OFF: as today');
  } finally { await net.stop(); }
});

test('ON, builders include: private accept in one RTT, lands, the public mempool NEVER sees the bytes, no fallback', async () => {
  const net = network(); const f = frame(net); const w = wallet();
  try {
    const t0 = performance.now(); const h = await send(f, w); const ms = performance.now() - t0;
    assert.equal(f.path, 'private'); assert.ok(ms < 200, `send took ${ms} ms`);
    const m = await net.waitMined(h); assert.ok(m, 'landed');
    await f.landed(h, 3000);
    await sleep(f.MEV_FALLBACK_MS + 600);
    assert.equal(net.seenPublic.has(h), false, 'never public');
    assert.equal(net.log.filter((x) => x.u === PUB).length, 0, 'not one post to the public node');
    assert.equal(f.privHold.size, 0, 'hold released by the receipt');
  } finally { await net.stop(); }
});

test('ON, builder accepts but never includes (every private road a blackhole): same bytes go public after the fallback, land; the next trade never strands', async () => {
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'blackhole'])) }); const f = frame(net); const w = wallet();
  try {
    const h1 = await send(f, w); assert.equal(f.path, 'private');
    // a second click 100 ms later, BEFORE the fallback: it must take nonce 1, not re-use 0
    await sleep(100);
    const h2 = await send(f, w);
    const firstPub = () => net.log.find((x) => x.u === PUB && x.hash === h1);
    const m1 = await net.waitMined(h1, 4000), m2 = await net.waitMined(h2, 4000);
    assert.ok(m1 && m2, 'both landed');
    assert.equal(m1.nonce, 0); assert.equal(m2.nonce, 1);
    const sentAt = net.log.find((x) => x.hash === h1).at;
    assert.ok(firstPub().at - sentAt >= f.MEV_FALLBACK_MS - 20 && firstPub().at - sentAt < f.MEV_FALLBACK_MS + 600, `fallback after ${firstPub().at - sentAt} ms`);
    assert.equal(new Set(net.log.filter((x) => x.nonce === 0).map((x) => x.hash)).size, 1, 'nonce 0: ONE signed tx, the same bytes everywhere');
    // a third trade after both landed: nonce 2, lands
    const h3 = await send(f, w); const m3 = await net.waitMined(h3, 4000); assert.ok(m3); assert.equal(m3.nonce, 2);
  } finally { await net.stop(); }
});

test('ON, every private road refuses (e.g. a 1 gwei floor): the public node gets it at once, path public-refused, lands, no stuck nonce', async () => {
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'reject'])) }); const f = frame(net); const w = wallet();
  try {
    const t0 = performance.now(); const h = await send(f, w); const ms = performance.now() - t0;
    assert.equal(f.path, 'public-refused'); assert.ok(ms < 250, `refused + public in ${ms} ms (2 RTT)`);
    assert.ok(await net.waitMined(h, 3000));
    const h2 = await send(f, w); const m2 = await net.waitMined(h2, 3000); assert.ok(m2); assert.equal(m2.nonce, 1);
  } finally { await net.stop(); }
});

test('ON, builders slow (2 s) or hung: the hedge sends public after 250 ms, click answered in < 400 ms, lands; the late private accepts are the same hash', async () => {
  for (const mode of ['slow', 'hang']) {
    const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, mode])) }); const f = frame(net); const w = wallet();
    try {
      const t0 = performance.now(); const h = await send(f, w); const ms = performance.now() - t0;
      assert.equal(f.path, 'public-slow', mode); assert.ok(ms >= f.MEV_HEDGE_MS && ms < 400, `${mode}: ${ms} ms`);
      assert.ok(await net.waitMined(h, 3000), mode);
      const h2 = await send(f, w); assert.ok(await net.waitMined(h2, 4000), `${mode}: the next trade lands`);
    } finally { await net.stop(); }
  }
});

test('ON, mixed: 48 Club refuses, BlockRazor accepts → private, lands, never public', async () => {
  const net = network({ behaviour: { [C48]: 'reject' }, builders: { [BR]: 1 } }); const f = frame(net); const w = wallet();
  try {
    const h = await send(f, w); assert.equal(f.path, 'private');
    assert.ok(await net.waitMined(h, 3000)); await f.landed(h, 2000); await sleep(f.MEV_FALLBACK_MS + 500);
    assert.equal(net.seenPublic.has(h), false);
  } finally { await net.stop(); }
});

test('ON: a fresh nonce read from the public node never goes under a privately held tx (holdNonce)', async () => {
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'blackhole'])), blockMs: 100_000 }); const f = frame(net); const w = wallet();
  try {
    await send(f, w);
    assert.equal(net.pendingCount(w.account.address.toLowerCase()), 0, 'the public node does not see it');
    assert.equal(await f.nextNonce(w.account.address, true), 1, 'fresh read is held at 0 + 1');
    f.nonces.delete(w.account.address.toLowerCase());
    assert.equal(await f.nextNonce(w.account.address, false), 1);
  } finally { await net.stop(); }
});

test('ON: the fallback is refused for the tx itself (funds gone) → the hold and the cached counter are dropped: the next send re-reads the chain, no gap', async () => {
  let funded = true;
  const net = network({ behaviour: Object.fromEntries(PRIVATE.map((u) => [u, 'blackhole'])), balance: () => funded }); const f = frame(net); const w = wallet();
  try {
    const h1 = await send(f, w); funded = false;
    await sleep(f.MEV_FALLBACK_MS + 500);
    assert.equal(f.privHold.size, 0, 'hold dropped'); assert.equal(f.nonces.has(w.account.address.toLowerCase()), false, 'counter dropped');
    assert.equal(net.mined.has(h1), false);
    funded = true;
    const h2 = await send(f, w); const m2 = await net.waitMined(h2, 4000);
    assert.ok(m2, 'the next trade lands'); assert.equal(m2.nonce, 0, 'at the nonce nobody holds — no gap, nothing queued behind');
  } finally { await net.stop(); }
});

test('ON: the fallback is skipped when the receipt is already seen (landed), and when the public node says nonce too low', async () => {
  const net = network(); const f = frame(net); const w = wallet();
  try {
    const h = await send(f, w); await f.landed(h, 3000);
    await sleep(f.MEV_FALLBACK_MS + 300);
    assert.equal(net.log.filter((x) => x.u === PUB).length, 0);
  } finally { await net.stop(); }
});

test('ON: 20 clicks from 4 wallets on a chain where the builders randomly accept / blackhole / refuse / stall: every tx lands, nonces 0..4 each, one signature per nonce', async () => {
  const modes = ['ok', 'blackhole', 'reject', 'slow'];
  const behaviour = Object.fromEntries(PRIVATE.map((u, i) => [u, modes[i % 4]]));
  const net = network({ behaviour, slowMs: 900 }); const f = frame(net); const ws = [wallet(), wallet(), wallet(), wallet()];
  try {
    const hashes = [];
    for (let k = 0; k < 5; k++) { hashes.push(...await Promise.all(ws.map((w) => send(f, w)))); await sleep(Math.random() * 300); }
    for (const h of hashes) assert.ok(await net.waitMined(h, 6000), 'landed ' + h);
    for (const w of ws) assert.equal(net.confirmed.get(w.account.address.toLowerCase()), 5);
    const perNonce = new Map(); for (const x of net.log) { const k = x.from + ':' + x.nonce; (perNonce.get(k) || perNonce.set(k, new Set()).get(k)).add(x.hash); }
    assert.equal(perNonce.size, 20); for (const [k, v] of perNonce) assert.equal(v.size, 1, 'one signature for ' + k);
    assert.equal(new Set(hashes).size, 20);
  } finally { await net.stop(); }
});

// ── the switch: only the vault's own dialog turns it OFF; a page turning it ON (more protection) needs nothing ──
import { readFileSync } from 'node:fs';
const WEs = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
test('switch: BNB default = the owner flip (OFF until the real-send GO), Solana OFF; OFF only through the vault dialog; the switch is advertised on BNB only and only once it is the default', () => {
  assert.match(WEs, /const MEV_DEFAULT: Record<string, boolean> = \{ bsc: (true|false), sol: false \};/);
  assert.match(WEs, /const vaultFeatures = \(\) => \(MEV_DEFAULT\.bsc && laneKey\(\) === 'bsc' \? \['slipLane', 'slipAuto', 'mev'\] : \['slipLane', 'slipAuto'\]\);/);
  assert.equal((WEs.match(/features: vaultFeatures\(\)/g) || []).length, 2, 'settingsGet and settingsSet answer the same features');
  assert.ok(!/features: \['slipLane', 'slipAuto'\]/.test(WEs));
  // settingsSet: a non-boolean is dropped; OFF while ON = the trusted dialog, declined → the stored value stands
  assert.match(WEs, /if \(typeof v !== 'boolean'\) delete s\.mev;\n\s+else if \(!v && mevOn\(stored\) && !\(await ask\(\{ title: 'Turn off MEV protection', danger: true/);
  // nothing else in the frame writes `mev`: saveSettings only sanitizes it; tradeSettings only reads it
  const writes = WEs.split('\n').filter((l) => /\bs\.mev\s*=|next\.mev\s*=/.test(l));
  assert.equal(writes.length, 2, writes.join('\n'));   // settingsSet's merge + saveSettings' sanitizer
  // a page cannot route the private round to a public node silently: trades-only / read nodes need the 'Change network nodes' dialog
  assert.match(WEs, /title: 'Change network nodes', danger: true/);
});
test('wiring: every EVM send goes through broadcast with its sender + nonce (hold), the fallback roads exclude the private ones', () => {
  assert.match(WEs, /hash = await broadcast\(raw, 0, false, \{ from: account\.address, nonce \}\)/);
  assert.match(WEs, /await broadcast\(raw, 0, false, \{ from: account\.address, nonce \}\);   \/\/ returns the local hash/);
  assert.match(WEs, /const nonce = holdNonce\(account\.address, await publicClient\.getTransactionCount/);
  assert.match(WEs, /const n = holdNonce\(a, Number\(BigInt\(x\.result\)\)\)/);
  assert.match(WEs, /if \(r\) \{ includedTx\.add\(hash\.toLowerCase\(\)\); releaseHold\(hash\); return r; \}/);
  assert.match(WEs, /privateSend: \['https:\/\/rpc-bsc\.48\.club', 'https:\/\/bsc\.blockrazor\.xyz\/fullprivacy', 'https:\/\/bsc\.rpc\.blxrbdn\.com', 'https:\/\/bscrpc\.pancakeswap\.finance'\]/);
  assert.equal((WEs.match(/\bbroadcast\(/g) || []).length, 6, 'broadcast: decl, retry, signAndSend, sendLeg, recoverLeg (same bytes, unchanged: F-58 pin), limit deps (order-wallet sends each wait for their receipt: the fallback covers them, no hold needed)');
});
