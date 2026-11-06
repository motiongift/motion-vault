// The ready float after a trade (owner 2026-10-29 “approved, add it too”; src/floatCore.ts REFILL, src/floatEngine.ts
// afterTrade): a confirmed trade refills W on the fast path once no trade is being signed; the target follows the buys and
// holds 4 of them in a burst (buys reported, or this frame's own trade clicks); the sweep waits in a burst. A Solana frame on a
// mocked chain with a fake clock.
//   node --experimental-strip-types --test test/float-refill.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const SOLC = F.FLOAT_CFG.sol;
const W_EVM = '0x00000000000000000000000000000000000000a1', R_EVM = '0x00000000000000000000000000000000000000b2';
const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
const usd = (x) => BigInt(Math.round(x * 1e6));
const lamportsFor = (dollars) => BigInt(Math.round(dollars * 1e7));   // $100 a SOL: $1 = 0.01 SOL

function world(o = {}) {
  let T = 1_800_000_000_000;
  const st = { wLam: SOLC.gasFloor + lamportsFor(o.wTrading ?? 12), rLam: 10_000_000n, rUsdc: usd(o.rUsdc ?? 200), sent: [] };
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: T, lastTradeAt: T - 5_000, limitBusy: false, ...(o.click || {}) };
  const store = new Map();
  const w = { id: 'w1', name: 'Wallet 1', w: { evm: W_EVM, sol: sol.W }, r: { evm: R_EVM, sol: sol.R } };
  const deps = {
    chain: () => 'sol',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return w; },
    wallets: () => ({ list: [w], skipped: [] }),
    sol: {
      balance: async (a) => (a === sol.W ? st.wLam : st.rLam), usdc: async (a) => (a === sol.R ? st.rUsdc : 0n), oracle6: async () => 100n * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      // a top-up lands at once: R's USDC → W's SOL (the oracle floor is what the vault asked)
      topup: async (id, usdcIn, minLamports) => { st.sent.push({ kind: 'topup', usdcIn, at: T }); st.rUsdc -= usdcIn; st.wLam += minLamports; return 'sig' + st.sent.length; },
      sweep: async (id, l, m) => { st.sent.push({ kind: 'sweep', l, at: T }); return 'sigs'; },
      gas: async (id, l) => { st.sent.push({ kind: 'gas', l, at: T }); return 'sigg'; },
      status: async () => 'confirmed',
    },
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => T,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(),
    emit: () => {},
    fetch: async () => { throw new Error('no network in this test'); },
    click: () => click,
    wait: async (ms) => { T += ms; },
  };
  const f = createFloat(Object.assign(deps, { readyFloat: true, gasFromW: true }));   // usd-mode2: the buffer of before
  const prefs = (p) => store.set(`trenches.float.v1.prefs.sol.${W_EVM}`, JSON.stringify({ activeAt: T, presets6: [String(usd(10))], ...p }));
  const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
  return { f, st, click, store, prefs, settle, advance: (ms) => { T += ms; }, now: () => T };
}
async function on(x) {
  const r = await x.f.configure({ walletId: 'w1', chains: ['sol'] }); assert.equal(r.ok, true);
  // the switch-on conversion is not this test's — nor the native kept at switch-on (KEEP, 2026-11-01: R already holds dollars
  // here, so the switch-on converts nothing and keeps W's native as it is)
  for (const k of [...x.store.keys()]) if (k.startsWith('trenches.float.v1.order.') || k.startsWith('trenches.float.v1.keep.')) x.store.delete(k);
  x.prefs({});
}
const topups = (x) => x.st.sent.filter((s) => s.kind === 'topup');

test('a confirmed trade refills W up to its target at once — above the 60 % low band, inside a token page\'s focus window; a routine tick would not', async () => {
  // presets $10 → target $15, low $9: W holds $12 of trading SOL after a buy
  const x = world({ wTrading: 12, click: { focusAt: 1_800_000_000_000 - 1_000 } }); await on(x);
  const before = await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(topups(x).length, 0, 'a routine tick in the focus window moves nothing: ' + JSON.stringify(before));
  x.f.afterTrade(sol.W); await x.settle();
  assert.equal(topups(x).length, 1);
  const got = Number(topups(x)[0].usdcIn) / 1e6;
  assert.ok(got >= 2.9 && got <= 3.1, 'tops W up by ~$3 to its $15 target: ' + got);
  const job = JSON.parse(x.store.get(`trenches.float.v1.jobs.sol.${W_EVM}`)).find((j) => j.kind === 'topup');
  assert.equal(job.refill, true); assert.equal(job.reason, 'refill');
});

test('the refill never runs while a trade is being signed: it waits for the broadcast, then goes; still signing after 15 s = nothing', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  x.click.clickAt = x.now(); x.click.clickDoneAt = x.now() - 1;           // a trade between its call and its broadcast
  x.f.afterTrade(sol.W);
  await x.settle();
  assert.equal(topups(x).length, 0);
  // the fake clock ran the 15 s wait out while the trade was still being signed: given up, nothing sent
  const y = world({ wTrading: 12 }); await on(y);
  y.click.clickAt = y.now() + 1e9;                                          // never broadcast in this test
  y.f.afterTrade(sol.W); await y.settle();
  assert.equal(topups(y).length, 0);
  // a trade that finished: the refill goes
  const z = world({ wTrading: 12 }); await on(z);
  z.click.clickAt = z.now() - 500; z.click.clickDoneAt = z.now() - 100;   // in the 2 s tail, not being signed
  z.f.afterTrade(sol.W); await z.settle();
  assert.equal(topups(z).length, 1);
});

test('a burst of buys: the target holds 4 buys (not 1.5) and the newest big buy sizes it; the refill brings W there', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  const t = x.now();
  x.prefs({ buys6: [String(usd(10)), String(usd(20))], buysAt: [t - 4_000, t - 2_000] });   // two buys in the last minute, the last $20
  x.f.afterTrade(sol.W); await x.settle();
  const got = Number(topups(x)[0].usdcIn) / 1e6;
  assert.ok(got >= 67.9 && got <= 68.1, 'target 4 × $20 = $80, W has $12 → ~$68: ' + got);
  // the same buys spread over 10 minutes are no burst: 1.5 × $20 = $30 → ~$18
  const y = world({ wTrading: 12 }); await on(y);
  y.prefs({ buys6: [String(usd(10)), String(usd(20))], buysAt: [y.now() - 600_000, y.now() - 300_000] });
  y.f.afterTrade(sol.W); await y.settle();
  const got2 = Number(topups(y)[0].usdcIn) / 1e6;
  assert.ok(got2 >= 17.9 && got2 <= 18.1, '' + got2);
  // the frame's own trade clicks are a burst too (seen at the click, before any buy is reported): $10 preset → 4 × $10 = $40
  const z = world({ wTrading: 12 }); await on(z);
  z.click.clicks = [z.now() - 3_000, z.now() - 1_000];
  z.f.afterTrade(sol.W); await z.settle();
  const got3 = Number(topups(z)[0].usdcIn) / 1e6;
  assert.ok(got3 >= 27.9 && got3 <= 28.1, '' + got3);
});

test('the sweep waits 5 minutes after the last trade in a burst (re-entry is likely), and runs on the quiet rule otherwise', async () => {
  // W holds $100 of trading SOL (a sell landed), target $15 → high $30: a surplus
  const quietAgo = 120_000;
  const x = world({ wTrading: 100 }); await on(x);
  x.click.lastTradeAt = x.now() - quietAgo; x.click.ticketAt = x.now() - quietAgo;
  x.prefs({ buys6: [String(usd(10)), String(usd(10))], buysAt: [x.now() - 50_000, x.now() - 40_000] });   // a burst ending 2 min ago... buys still within 60 s of each other
  // burst = ≥ 2 buys in the LAST 60 s: these are 40–50 s old → burst; the last trade 2 min ago < 5 min → no sweep
  await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(x.st.sent.filter((s) => s.kind === 'sweep').length, 0);
  // no burst: the usual quiet rule sweeps
  const y = world({ wTrading: 100 }); await on(y);
  y.click.lastTradeAt = y.now() - quietAgo; y.click.ticketAt = y.now() - quietAgo;
  await y.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await y.settle();
  assert.equal(y.st.sent.filter((s) => s.kind === 'sweep').length, 1);
});

test('nothing for a wallet the USD balance is off for, an unknown address, or a refill already running (it runs once more instead)', async () => {
  const x = world({ wTrading: 12 });                                        // never switched on
  x.f.afterTrade(sol.W); await x.settle();
  assert.equal(topups(x).length, 0);
  const y = world({ wTrading: 12 }); await on(y);
  y.f.afterTrade('So1Z' + '9'.repeat(40)); await y.settle();
  assert.equal(topups(y).length, 0);
  y.f.afterTrade(sol.W); y.f.afterTrade(sol.W); y.f.afterTrade(W_EVM); await y.settle();
  assert.equal(topups(y).length, 1, 'one top-up: the repeat re-plans and finds W at its target');
});

test('the buy from the reserve: only with the switch on for that wallet and chain, and a live price', async () => {
  const x = world();
  assert.throws(() => x.f.directFor('w1'), /USD balance is off/);
  await on(x);
  await x.f.status({ walletId: 'w1', fresh: true });
  const d = x.f.directFor('w1');
  assert.equal(d.w.r.sol, sol.R); assert.equal(d.price6, 100n * F.USD);
  x.f.noteBuy(sol.W, 0.2);                                                 // 0.2 SOL at $100 = $20, recorded for the sizing
  const p = JSON.parse(x.store.get(`trenches.float.v1.prefs.sol.${W_EVM}`));
  assert.equal(p.buys6.at(-1), String(usd(20))); assert.equal(p.buysAt.length, p.buys6.length);
});
