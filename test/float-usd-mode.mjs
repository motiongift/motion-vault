// The USD balance never surprises (2026-11-05, B:/tmp/usd-mode-1105: a tester deposited USDG on Robinhood, never bought on BNB, and
// saw 100 USDG go to BNB as USDC; then a $500 buy paid from his reserve was followed by a $100.77 USDG -> ETH swap into his wallet).
//   1. a routine cross-chain rebalance goes INTO a chain only when the user bought there in the last 7 days (crossNeedsTrade);
//   2. a buy paid straight from the reserve (noteBuy) does not refill W's float when it confirms (afterTrade).
//   node --experimental-strip-types --test test/float-usd-mode.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
import { createFloat } from '../src/floatEngine.ts';

const D = (n) => F.usd6(n);
const NOW = 1_792_950_000_000;
const ETH = 4000n * F.USD, BNB = 600n * F.USD;
const chainState = (over = {}) => ({ price6: ETH, priceAt: NOW - 5_000, float: 0n, reserve: 0n, reserveNative: 10n ** 18n, active: true, presets6: [D(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...over });
const planIn = (over = {}) => ({ now: NOW, caps: F.DEFAULT_CAPS, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: D(13_000), movedToday6: 0n, feesToday6: 0n, estFee6: () => D(0.02), chains: {}, ...over });
const eth = (usd) => F.FLOAT_CFG.robinhood.gasFloor + F.usd6ToNative(D(usd), ETH, 18);

// the tester's world: $13,000 of USDG in the Robinhood reserve, W topped up there; BNB open in a page (active), never traded
const riff = (bsc = {}) => ({
  robinhood: chainState({ float: eth(150), reserve: 13_000n * 10n ** 6n, traded: true }),
  bsc: chainState({ price6: BNB, float: 0n, reserve: 0n, reserveNative: 0n, active: true, ...bsc }),
});
const rebalances = (p) => p.moves.filter((m) => m.kind === 'rebalance');

test('a chain only opened in a page gets no cross-chain rebalance; said so (not-traded)', () => {
  const p = F.planMoves(planIn({ chains: riff(), crossNeedsTrade: true }));
  assert.deepEqual(rebalances(p), []);
  assert.ok(p.skips.some((s) => s.chain === 'bsc' && s.why === 'not-traded'), JSON.stringify(p.skips));
});

test('before (flag left out): the same world moves $100 Robinhood -> BNB, the tester\'s 100 USDG', () => {
  const r = rebalances(F.planMoves(planIn({ chains: riff() })));
  assert.equal(r.length, 1); assert.equal(r[0].from, 'robinhood'); assert.equal(r[0].chain, 'bsc'); assert.equal(r[0].usd6, D(100));
  assert.equal(r[0].reason, 'local reserve short');
});

test('a chain the user bought on in the last 7 days is still rebalanced into, as before', () => {
  const r = rebalances(F.planMoves(planIn({ chains: riff({ traded: true }), crossNeedsTrade: true })));
  assert.equal(r.length, 1); assert.equal(r[0].chain, 'bsc'); assert.equal(r[0].usd6, D(100));
});

test('a click on the untraded chain still takes its cold top-up (the click path is unchanged)', () => {
  const p = F.planMoves(planIn({ chains: riff(), crossNeedsTrade: true, urgent: { chain: 'bsc', usd6: D(50) } }));
  const c = p.moves.find((m) => m.chain === 'bsc');
  assert.ok(c && c.kind === 'cold' && c.from === 'robinhood', JSON.stringify(p.moves, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
});

// -- 2. the engine: a buy from the reserve does not refill W (a Solana frame on a mocked chain, as test/float-refill.mjs) --
const SOLC = F.FLOAT_CFG.sol;
const W_EVM = '0x00000000000000000000000000000000000000a1', R_EVM = '0x00000000000000000000000000000000000000b2';
const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
const usd = (x) => BigInt(Math.round(x * 1e6));
const lamportsFor = (dollars) => BigInt(Math.round(dollars * 1e7));   // $100 a SOL
function world(o = {}) {
  let T = 1_800_000_000_000;
  const st = { wLam: SOLC.gasFloor + lamportsFor(o.wTrading ?? 12), rLam: 10_000_000n, rUsdc: usd(o.rUsdc ?? 200), sent: [] };
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: T, lastTradeAt: T - 5_000, limitBusy: false };
  const store = new Map();
  const w = { id: 'w1', name: 'Wallet 1', w: { evm: W_EVM, sol: sol.W }, r: { evm: R_EVM, sol: sol.R } };
  const f = createFloat({ readyFloat: true, gasFromW: true,   // usd-mode2: the buffer of before
    chain: () => 'sol',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return w; },
    wallets: () => ({ list: [w], skipped: [] }),
    sol: {
      balance: async (a) => (a === sol.W ? st.wLam : st.rLam), usdc: async (a) => (a === sol.R ? st.rUsdc : 0n), oracle6: async () => 100n * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      topup: async (id, usdcIn, minLamports) => { st.sent.push({ kind: 'topup', usdcIn }); st.rUsdc -= usdcIn; st.wLam += minLamports; return 'sig' + st.sent.length; },
      sweep: async () => { st.sent.push({ kind: 'sweep' }); return 'sigs'; },
      gas: async () => { st.sent.push({ kind: 'gas' }); return 'sigg'; },
      status: async () => 'confirmed',
    },
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => T,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {},
    fetch: async () => { throw new Error('no network in this test'); },
    click: () => click, wait: async (ms) => { T += ms; },
  });
  const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
  return { f, st, store, settle, advance: (ms) => { T += ms; } };
}
async function on(x) {
  assert.equal((await x.f.configure({ walletId: 'w1', chains: ['sol'] })).ok, true);
  for (const k of [...x.store.keys()]) if (k.startsWith('trenches.float.v1.order.') || k.startsWith('trenches.float.v1.keep.')) x.store.delete(k);
  x.store.set(`trenches.float.v1.prefs.sol.${W_EVM}`, JSON.stringify({ activeAt: 1_800_000_000_000, presets6: [String(usd(10))] }));
  await x.f.status({ walletId: 'w1', fresh: true });   // a snapshot with a price: noteBuy states the buy in dollars from it
}
const topups = (x) => x.st.sent.filter((s) => s.kind === 'topup');

test('a buy paid from the reserve confirms: no refill of W; a buy W signed afterwards refills as before', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  x.f.noteBuy(sol.W, 0.2);                 // R paid a $20 buy for W
  x.f.afterTrade(sol.W); await x.settle();
  assert.equal(topups(x).length, 0, 'the reserve buy spent no float of W');
  x.f.afterTrade(sol.W); await x.settle();  // the next confirmed trade is W's own: the refill runs
  assert.equal(topups(x).length, 1);
});

test('without a reserve buy the refill is unchanged; a reserve-buy mark that never confirmed expires after 10 minutes', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  x.f.afterTrade(sol.W); await x.settle();
  assert.equal(topups(x).length, 1);
  const y = world({ wTrading: 12 }); await on(y);
  y.f.noteBuy(sol.W, 0.2); y.advance(600_001);
  y.f.afterTrade(sol.W); await y.settle();
  assert.ok(topups(y).length >= 1, 'an old mark does not hold a later refill back');
});
