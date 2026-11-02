// USD balance — the click path (owner, 2026-10-26: he pressed "Turn on" on his iPhone and waited ~40 s for the vault's
// dialog). The background reads go through a 1 request/s bucket (burst 3) per frame; the switch's dialogs and the app's
// pre-dialog status read every wallet × chain through it, one after another. The reads a user's click is waiting on now
// skip the bucket: every wallet of a frame in ONE batched read (deps.fast), the price and the gas once, still behind a
// running trade (floatCore afterTrade). Three frames (Robinhood, BNB, Solana) on mocked nodes sharing the vault origin's
// storage, five wallets. Nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const lc = (a) => String(a).toLowerCase();
const E18 = 10n ** 18n;
const PRICE = { robinhood: 4000, bsc: 700, sol: 150 };
// the slot0 whose oracle price is `usd` (searched: the pool's orientation and decimals stay floatCore's)
function slotFor(chain, usd) {
  const o = F.FLOAT_CFG[chain].oracle; const want = F.usd6(usd);
  let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, o); if ((o.nativeIsToken0 ? p < want : p > want)) lo = mid + 1n; else hi = mid; }
  return lo;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkWallets(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i + 1}`, name: `Wallet ${i + 1}`,
    w: { evm: privateKeyToAccount(generatePrivateKey()).address, sol: `So1W${i}`.padEnd(44, 'w') },
    r: { evm: privateKeyToAccount(generatePrivateKey()).address, sol: `So1R${i}`.padEnd(44, 'r') },
  }));
}

/**
 * One vault origin: a store shared by three frames. Each frame's background reads pass a real floatCore bucket (1/s,
 * burst 3) and are counted; its click-path reads (deps.fast) take `latency` ms per request, are counted, and wait while
 * `trade.running` is true (the webEngine source gate: afterTrade(tradeRunning, …)).
 */
function makeVault(o = {}) {
  const wallets = o.wallets || mkWallets(5);
  const store = new Map(); const asks = [];
  const trade = { running: false };
  const node = {   // balances per chain: W native, R native, R stable (raw)
    robinhood: new Map(wallets.map((w) => [w.id, { w: E18, r: F.FLOAT_CFG.robinhood.reserveGas, s: 0n }])),
    bsc: new Map(wallets.map((w) => [w.id, { w: 2n * E18, r: F.FLOAT_CFG.bsc.reserveGas, s: 0n }])),
    sol: new Map(wallets.map((w) => [w.id, { w: 5_000_000_000n, r: F.FLOAT_CFG.sol.reserveGas, s: 0n }])),
  };
  const byEvm = (chain, a) => { for (const w of wallets) { const b = node[chain].get(w.id); if (lc(w.w.evm) === lc(a)) return b.w; if (lc(w.r.evm) === lc(a)) return b.r; } return 0n; };
  const bySol = (a) => { for (const w of wallets) { const b = node.sol.get(w.id); if (w.w.sol === a) return b.w; if (w.r.sol === a) return b.r; } return 0n; };
  const stats = { bucket: 0, bucketWaitMs: 0, fast: 0, sheets: [], inFlight: 0, maxInFlight: 0, failW: new Set() };
  const latency = o.latency ?? 40;
  const frame = (chain) => {
    const bk = F.bucket(1, 3, () => Date.now());
    // background: one bucket token per request, its wait recorded (not slept: the test would take that long)
    const bg = async (fn) => { stats.bucket += 1; stats.bucketWaitMs = Math.max(stats.bucketWaitMs, bk.take()); return fn(); };
    // the click path: the source gate, then one request of `latency` ms
    const req = (fn) => F.afterTrade(() => trade.running, (ms) => sleep(Math.min(ms, 5)), async () => {
      stats.fast += 1; stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try { await sleep(latency); return fn(); } finally { stats.inFlight -= 1; }
    });
    const fees = () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n });
    const evmSheet = (pool, stable, ws) => req(() => {
      stats.sheets.push({ chain, n: ws.length });
      return { slot0: slotFor(chain, PRICE[chain]), w: ws.map((x) => (stats.failW.has(lc(x.w)) ? null : byEvm(chain, x.w))), r: ws.map((x) => byEvm(chain, x.r)), stable: ws.map(() => 0n) };
    });
    const deps = {
      chain: () => chain,
      wallet: (id) => { const w = wallets.find((x) => x.id === id); if (!w) throw new Error('Unknown wallet'); return w; },
      wallets: () => ({ list: wallets, skipped: o.skipped || [] }),
      evm: {
        call: async () => { throw new Error('test: no call expected'); },
        balance: (a) => bg(() => { if (stats.failW.has(lc(a))) throw new Error("test: refused"); return byEvm(chain, a); }),
        erc20: () => bg(() => 0n),
        allowance: () => bg(() => 0n),
        slot0: () => bg(() => slotFor(chain, PRICE[chain])),
        fees: () => bg(fees),
        estimate: async () => { throw new Error('test: no estimate expected'); },
        sendR: async () => { throw new Error('test: no send expected'); },
        sendW: async () => { throw new Error('test: no send expected'); },
        receipt: async () => null,
      },
      sol: {
        balance: (a) => bg(() => bySol(a)),
        usdc: () => bg(() => 0n),
        oracle6: () => bg(() => F.usd6(PRICE.sol)),
        fees: async () => { throw new Error('defaults'); },
        topup: async () => { throw new Error('test: no send expected'); }, sweep: async () => { throw new Error('test: no send expected'); }, gas: async () => { throw new Error('test: no send expected'); },
        quote: async () => 0n, status: async () => null,
      },
      ...(o.noFast ? {} : { fast: {
        evm: { sheet: evmSheet, fees: () => req(fees) },
        sol: { sheet: (ws) => req(() => { stats.sheets.push({ chain, n: ws.length }); return { w: ws.map((x) => bySol(x.w)), r: ws.map((x) => bySol(x.r)), stable: ws.map(() => 0n) }; }), oracle6: () => req(() => F.usd6(PRICE.sol)) },
      } }),
      ask: async (a) => { asks.push({ ...a, at: Date.now() }); return true; },
      gate: async () => {},
      html: { esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
      now: () => Date.now(),
      store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
      lock: async (k, fn) => fn(),
      emit: () => {},
      fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
      click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }),
      wait: async () => {},
    };
    return createFloat(deps);
  };
  const frames = { robinhood: frame('robinhood'), bsc: frame('bsc'), sol: frame('sol') };
  const snap = (chain, w) => JSON.parse(store.get(`trenches.float.v1.snap.${chain}.${lc(w.w.evm)}`) || 'null');
  return { wallets, store, asks, trade, frames, stats, snap };
}
const rowsOf = (html) => [...html.matchAll(/<div class="ub-r"><div class="ub-w"><span class="ub-n">(.*?)<\/span><span class="ub-cs">(.*?)<\/span><\/div><b class="ub-u" translate="no">(.*?)<\/b><\/div>/g)]
  .map((m) => [m[1], [...m[2].matchAll(/<span class="ub-c" translate="no">(.*?)<\/span>/g)].map((c) => c[1]), m[3]]);

test('5 wallets × 3 chains: the pre-dialog status and the switch-on dialog read with no bucket wait — one batched read per frame, the dialog in well under a second', async () => {
  const v = makeVault();
  const t0 = Date.now();
  // the app's prime(): each chain's frame asked for a fresh account status, side by side
  const st = await Promise.all(['robinhood', 'bsc', 'sol'].map((c) => v.frames[c].status({ walletId: 'w1', scope: 'account', fresh: true })));
  const tStatus = Date.now() - t0;
  // the click: configure on the page's frame
  await v.frames.robinhood.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] });
  const tDialog = v.asks[0].at - t0;
  assert.equal(v.stats.bucket, 0, 'a click-path read went through the background bucket');
  assert.equal(v.stats.bucketWaitMs, 0);
  // one sheet per frame, all five wallets in it; price + gas once: EVM 2 requests a frame, Solana 2
  assert.deepEqual(v.stats.sheets.map((s) => [s.chain, s.n]).sort(), [['bsc', 5], ['robinhood', 5], ['sol', 5]]);
  assert.equal(v.stats.fast, 6, 'sheet + price/gas per frame, and configure re-read nothing (snapshots < 15 s)');
  assert.ok(v.stats.maxInFlight >= 3, 'the frames read side by side');
  // every wallet's every chain is in the dialog, read just now
  for (const s of st) assert.equal(s.wallets.length, 5);
  for (const w of v.wallets) for (const c of ['robinhood', 'bsc', 'sol']) assert.ok(Date.now() - v.snap(c, w).at < 5_000, `${w.name} ${c}`);
  const rows = rowsOf(v.asks[0].html);
  assert.equal(rows.length, 5); for (const r of rows) assert.equal(r[1].length, 3, r[0]);
  assert.match(rows[0][1].join(' | '), /^[\d.]+ ETH → USDG \| [\d.]+ BNB → USDC \| [\d.]+ SOL → USDC$/);
  console.log(`# click path, 5 wallets × 3 chains, mocked nodes at 40 ms a request: status(fresh) ${tStatus} ms, dialog ${tDialog} ms, ${v.stats.fast} requests, 0 bucket waits`);
  assert.ok(tDialog < 1000, `the dialog took ${tDialog} ms`);
});

test('the old path for comparison: the same reads through the background bucket queue for many seconds per frame', async () => {
  const v = makeVault({ noFast: true });
  await v.frames.robinhood.status({ walletId: 'w1', scope: 'account', fresh: true });
  // 5 wallets on one EVM frame: price + gas + 3 reads a wallet = 17 bucket tokens; the last waits (17 − 3) s
  assert.ok(v.stats.bucket >= 17, String(v.stats.bucket));
  assert.ok(v.stats.bucketWaitMs >= 13_000, `${v.stats.bucketWaitMs} ms`);
  console.log(`# background path, 5 wallets on one frame: ${v.stats.bucket} bucket tokens, the last one queued ${v.stats.bucketWaitMs} ms (per frame; status, then the dialog again)`);
});

test('wallets are read in parallel: one batched sheet for every wallet of the frame, not one wallet after another', async () => {
  const v = makeVault({ wallets: mkWallets(8), latency: 60 });
  const t0 = Date.now();
  await v.frames.robinhood.off({ walletId: 'w1' });   // nothing to convert back: the dialog's read still runs, no dialog
  const dt = Date.now() - t0;
  assert.deepEqual(v.stats.sheets, [{ chain: 'robinhood', n: 8 }]);
  assert.equal(v.stats.fast, 2); assert.equal(v.stats.bucket, 0);
  assert.ok(dt < 400, `8 wallets took ${dt} ms (sequential would be ≥ 8 × 60)`);
});

test('a running trade still goes first: the click-path read waits for it at the source, then runs without the bucket', async () => {
  const v = makeVault();
  v.trade.running = true;
  let done = false;
  const p = v.frames.bsc.status({ walletId: 'w2', scope: 'account', fresh: true }).then((r) => { done = true; return r; });
  await sleep(120);
  assert.equal(done, false, 'answered while a trade was running');
  assert.equal(v.stats.fast, 0, 'a request left during the trade');
  v.trade.running = false;
  const r = await p;
  assert.equal(done, true); assert.equal(r.wallets.length, 5);
  assert.equal(v.stats.bucket, 0); assert.equal(v.stats.fast, 2);
  // afterTrade itself: polls every 100 ms while running, then calls once
  let polls = 0, calls = 0; let running = 3;
  const out = await F.afterTrade(() => running-- > 0, async (ms) => { assert.equal(ms, 100); polls += 1; }, async () => { calls += 1; return 'go'; });
  assert.equal(out, 'go'); assert.equal(polls, 3); assert.equal(calls, 1);
});

test('fresh is rate-limited: concurrent callers share one read; a repeat within 3 s reads nothing; a failed wallet keeps no zero snapshot', async () => {
  const v = makeVault();
  await Promise.all([1, 2, 3].map(() => v.frames.robinhood.status({ walletId: 'w1', scope: 'account', fresh: true })));
  assert.equal(v.stats.sheets.length, 1, 'three callers, one read');
  await v.frames.robinhood.status({ walletId: 'w3', fresh: true });
  await v.frames.robinhood.status({ walletId: 'w1', scope: 'account', fresh: true });
  assert.equal(v.stats.sheets.length, 1, 'snapshots under 3 s are reused');
  // a wallet whose balance read failed: no snapshot is written for it (the dialog says its chain converts later)
  const w = mkWallets(2); const f = makeVault({ wallets: w });
  f.stats.failW.add(lc(w[1].w.evm));
  await f.frames.robinhood.status({ walletId: 'w1', scope: 'account', fresh: true });
  assert.ok(f.snap('robinhood', w[0])); assert.equal(f.snap('robinhood', w[1]), null);
  await f.frames.robinhood.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.deepEqual(rowsOf(f.asks[0].html).map((r) => r[0]), ['Wallet 1']);
  assert.match(f.asks[0].html, /<p class="ub-skip">Robinhood price not read yet \(converts later\)<\/p>/);
});

test('background stays behind the bucket: a plain status (no fresh) refreshes through the background reads only', async () => {
  const v = makeVault();
  const r = await v.frames.robinhood.status({ walletId: 'w1', scope: 'account' });
  assert.equal(r.wallets.length, 5);
  for (let i = 0; i < 50 && v.stats.bucket < 17; i++) await sleep(5);
  assert.equal(v.stats.fast, 0, 'a background refresh used the click path');
  assert.ok(v.stats.bucket >= 5, String(v.stats.bucket));
});
