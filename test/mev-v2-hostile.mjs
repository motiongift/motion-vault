// MEV v2 review (mev-v2-review 2026-11-04): hostile fake-node tests on top of test/mev-v2-sim.mjs (REAL declarations of
// src/webEngine.ts, throwaway keys, nothing leaves the process). Each one is a failure the reviewer found or ruled out:
// lagging / hung receipt node, a public node that throttles or refuses the fallback, a private road that hangs or is blocked
// by the CSP while the wallet cannot pay, a nonce gap behind a dead private tx, two tabs and two devices on one wallet.
//   node --test test/mev-v2-hostile.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { network, frame, wallet, send, sleep, PUB, BR, PRIVATE } from './mev-v2-sim.mjs';
const CAKE = 'https://bscrpc.pancakeswap.finance';
const all = (m) => Object.fromEntries(PRIVATE.map((u) => [u, m]));
const ans = (j) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...j }), { headers: { 'content-type': 'application/json' } });
const isSend = (init) => JSON.parse(init.body).method === 'eth_sendRawTransaction';
const hashOf = (init) => keccak256(JSON.parse(init.body).params[0]);
const wrap = (net, fn) => { const orig = net.fetch; net.fetch = (u, init) => fn(String(u), init, orig); return net; };   // before frame()
const sendD = (f, w, d) => f.signAndSend(w.client, w.account, { to: w.account.address, value: 0n, data: d }, 93_750_000n, 30000n);
const device = (mk) => { const BC = globalThis.BroadcastChannel; globalThis.BroadcastChannel = undefined; try { return mk(); } finally { globalThis.BroadcastChannel = BC; } };
const RUNS = 6;

test('receipt node lags 1.5 s: the fallback re-posts a sealed tx, the public node says "nonce too low", one landing, the next trade follows', async () => {
  const net = wrap(network(), async (u, init, orig) => (u === PUB && isSend(init) && net.mined.has(hashOf(init)) ? (await sleep(55), ans({ error: { message: 'nonce too low' } })) : orig(u, init)));
  net.receipt = (h) => { const m = net.mined.get(h.toLowerCase()); if (!m || Date.now() - m.at < 1500) throw new Error('Transaction receipt could not be found'); return { status: 'success', blockNumber: BigInt(m.block) }; };
  const f = frame(net); const w = wallet();
  try {
    const h1 = await sendD(f, w, '0x01'); await sleep(1400); const h2 = await sendD(f, w, '0x02');
    const [m1, m2] = await Promise.all([net.waitMined(h1), net.waitMined(h2)]);
    assert.ok(m1 && m2); assert.equal(m2.nonce, m1.nonce + 1);
  } finally { await net.stop(); }
});

test('a private road hangs and the wallet cannot pay: the public refusal settles the click at once, as a refusal (not 8 s later as "unknown")', async () => {
  const net = network({ behaviour: { [BR]: 'hang' }, balance: () => false }); const f = frame(net); const w = wallet();
  try {
    const t0 = performance.now(); const e = await send(f, w).then(() => null, (x) => x); const ms = performance.now() - t0;
    assert.ok(e); assert.equal(e.txState, 'signed'); assert.match(e.message, /insufficient funds/); assert.ok(ms < 1000, `${ms} ms`);
  } finally { await net.stop(); }
});

test('two private roads blocked by the CSP ("Failed to fetch", an APK without the new rpcHosts): a funded buy lands privately, an unfunded one is a refusal', async () => {
  for (const pay of [true, false]) {
    const net = wrap(network({ balance: () => pay }), async (u, init, orig) => { if (u === BR || u === CAKE) throw new TypeError('Failed to fetch'); return orig(u, init); });
    const f = frame(net); const w = wallet();
    try {
      const r = await send(f, w).then((h) => ({ h }), (e) => ({ e }));
      if (pay) { assert.equal(f.path, 'private'); assert.ok(await net.waitMined(r.h, 2000)); }
      else { assert.equal(r.e?.txState, 'signed'); assert.match(r.e.message, /insufficient funds/); }
    } finally { await net.stop(); }
  }
});

test('a dead private tx (blackholed, its fallback refused for itself) while the next one is held: the next send fills the gap at once, nothing waits 30 s', async () => {
  let bad = null;
  const net = wrap(network({ behaviour: all('blackhole') }), async (u, init, orig) => (u === PUB && isSend(init) && hashOf(init) === bad ? (await sleep(55), ans({ error: { message: 'transaction underpriced: gas tip cap 1, minimum needed 50000000' } })) : orig(u, init)));
  const f = frame(net); const w = wallet();
  try {
    const h1 = await sendD(f, w, '0x01'); bad = h1; await sleep(100);
    const t2 = Date.now(); const h2 = await sendD(f, w, '0x02'); await sleep(1500);
    const h3 = await sendD(f, w, '0x03');
    assert.equal(net.log.find((x) => x.hash === h3)?.nonce, 0, 'fills the dead nonce');
    const [m2, m3] = await Promise.all([net.waitMined(h2, 4000), net.waitMined(h3, 4000)]);
    assert.ok(m2 && m3); assert.ok(m2.at - t2 < 6000, 'the held tx ran within seconds, not after the 30 s hold');
  } finally { await net.stop(); }
});

test('the public node throttles the fallback 3× while the builders blackhole: the wallet is not stranded, the next trade lands', async () => {
  const net = wrap(network({ behaviour: all('blackhole') }), async (u, init, orig) => (u === PUB && isSend(init) && net.thr ? (await sleep(55), ans({ error: { message: 'Too many requests (429)' } })) : orig(u, init)));
  net.thr = true; const f = frame(net); const w = wallet();
  try {
    await sendD(f, w, '0x01'); await sleep(2900); net.thr = false;
    const h2 = await sendD(f, w, '0x02'); assert.ok(await net.waitMined(h2, 3000));
  } finally { await net.stop(); }
});

test('builders slow 2 s and the receipt node hung: hedge, lands, one hash', async () => {
  const net = network({ behaviour: all('slow') }); net.receipt = () => new Promise(() => {}); const f = frame(net); const w = wallet();
  try { const h = await send(f, w); assert.ok(await net.waitMined(h, 4000)); assert.equal(f.path, 'public-slow'); } finally { await net.stop(); }
});

test('two TABS on one wallet, 100 ms apart (warm and fresh counters): both trades land (the hold is shared between the vault frames)', async () => {
  for (const warm of [false, true]) {
    let both = 0;
    for (let i = 0; i < RUNS; i++) {
      const net = network(); const A = frame(net), B = frame(net); const w = wallet();
      try {
        if (warm) { await sendD(A, w, '0x01'); await sleep(900); await sendD(B, w, '0x02'); await sleep(900); }
        const pa = sendD(A, w, '0x0a'); await sleep(100); const hb = await sendD(B, w, '0x0b'); const ha = await pa;
        const [ma, mb] = await Promise.all([net.waitMined(ha, 3000), net.waitMined(hb, 3000)]);
        if (ma && mb) both++;
      } finally { await net.stop(); }
    }
    assert.equal(both, RUNS, `${warm ? 'warm' : 'fresh'}: both landed ${both}/${RUNS}`);
  }
});

test('two DEVICES on one wallet, 100 ms apart (residual, documented): one of the two trades is dropped, never both run, the wallet is not stranded', async () => {
  for (let i = 0; i < RUNS; i++) {
    const net = network(); const A = frame(net), B = device(() => frame(net)); const w = wallet();
    try {
      const pa = sendD(A, w, '0x0a'); await sleep(100); const hb = await sendD(B, w, '0x0b').catch(() => null); const ha = await pa;
      const ms = await Promise.all([net.waitMined(ha, 2500), hb ? net.waitMined(hb, 2500) : null]);
      assert.equal(ms.filter(Boolean).length, 1, 'exactly one of the two at that nonce');
      await sleep(1500); const h3 = await sendD(A, w, '0x0c'); assert.ok(await net.waitMined(h3, 3000), 'the next trade lands');
    } finally { await net.stop(); }
  }
});
