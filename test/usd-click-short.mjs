// The click's `short` answer (2026-11-04, the owner's $540 MOTION buy on Robinhood: web r135, engine glncySWJ; B:\tmp\usd-buy-final).
// Wallet 1 held $549 in all — ~$250 of ETH in W on Robinhood, $239.11 USDC in the BNB reserve, $22.40 of SOL float (a click
// elsewhere never moves it) and ~$37 elsewhere. The click's plan moved the whole BNB reserve (the bridge log: "paid bsc→robinhood
// 239.113576 USD") and kept the rest in plan.short — which no answer carried, so the page waited 15 s for a figure W could never
// reach. Now (one design, B:/tmp/usd-buy-final):
//   TC-1  a click everything it can reach cannot pay is planned all or nothing: NO move, answered at once
//         { state: 'failed', code: 'short', short: { usd, canUsd } } (test/usd-atomic-click.mjs has the planner's 500-world proof);
//   E1    a click whose moves did go but leave W short (a part refused on the way, a donor that brought less) answers 'moving' +
//         `click.short` { usd: still missing, canUsd: what W can pay };
//   both  never while a move into this chain is still landing or settling (review F1: an arrived payout no read here shows yet, a
//         part held behind an unlanded part) — those dollars are in no read, so the old wait ('moving' + retryMs) stands.
// Runs the REAL engine (createFloat) over the usd-fix2 world: motion's solver mocked with the real core (motionBridgeCore), a BNB
// frame (oracle priced at $700), throwaway in-memory keys, nothing broadcast. The pure plan without TC-1 is checked first.
//   node --test test/usd-click-short.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import { createFloat } from '../src/floatEngine.ts';
import { MOTION_BRIDGE_MAX6 } from '../src/bridgeSolver.ts';
import * as F from '../src/floatCore.ts';
import * as C from '../src/motionBridgeCore.ts';

const lc = (a) => String(a).toLowerCase();
const RH = F.FLOAT_CFG.robinhood, BSCC = F.FLOAT_CFG.bsc;
const BNB_USD = 700n;
const b58 = (b) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };
const rnd32 = () => Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
let BNB_SQRT = 0n;
{ const want = F.usd6(Number(BNB_USD)); let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, BSCC.oracle); if (BSCC.oracle.nativeIsToken0 ? p < want : p > want) lo = mid + 1n; else hi = mid; }
  BNB_SQRT = lo; }

// motion's solver over fetch (= test/usd-fix2.mjs world; st.skew moves the engine's clock: deps.now)
function world(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const sol = { W: b58(ed25519.getPublicKey(rnd32())), R: b58(ed25519.getPublicKey(rnd32())) };
  const seed = rnd32(); const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposits = { robinhood: privateKeyToAccount(generatePrivateKey()).address, bsc: privateKeyToAccount(generatePrivateKey()).address, sol: b58(ed25519.getPublicKey(rnd32())) };
  const st = { wBnb: o.wBnb ?? BSCC.gasFloor, quotes: new Map(), fills: [], ledger: [], signed: [], relayCalls: [], quoteAsks: [], refuseQuote: o.refuseQuote || null, fillState: o.fillState || null, statusState: o.statusState || 'filled', maxFillUsd: o.maxFillUsd ?? 1000, payout: o.payout !== false, skew: 0 };
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const solverFetch = async (url, init) => {
    const path = String(url).split('/api/bridge/motion')[1] || '';
    if (path.startsWith('/health')) return json({ ok: true, on: true, solver: pub, chains: ['robinhood', 'bsc', 'sol'], deposits, maxFillUsd: st.maxFillUsd, minFillUsd: 0.1, feeBps: 0 });
    if (path.startsWith('/quote')) {
      const b = JSON.parse(init.body);
      const usd6 = C.stableToUsd6(BigInt(b.amount), C.bridgeCfg(b.from).stable.decimals);
      st.quoteAsks.push(usd6);
      const refuse = st.refuseQuote ? st.refuseQuote(usd6, st, b) : '';
      // the real solver's own refusals (cap, the wallet's fills in flight), from its ledger
      const use = C.useOf(st.ledger, b.recipient, Date.now());
      const why = refuse || C.quoteRefusal({ on: true, from: b.from, to: b.to, usd6, caps: { ...C.DEFAULT_CAPS, perFill6: BigInt(st.maxFillUsd) * C.USD6 }, use, dstInventory6: 1_000_000n * C.USD6, dstPrice6: BNB_USD * C.USD6 });
      if (why) return json({ ok: false, reason: why });
      const { out, fee6 } = C.quoteOut(usd6, BNB_USD * C.USD6, b.to, 0);
      const at = Date.now();
      const q = { v: 1, id: Buffer.from(rnd32().slice(0, 16)).toString('hex'), src: { chain: b.from, token: C.bridgeCfg(b.from).stable.address, amount: String(b.amount), depositor: b.depositor, deposit: deposits[b.from] },
        dst: { chain: b.to, recipient: b.recipient, amount: String(out) }, price6: String(BNB_USD * C.USD6), fee6: String(fee6), usd6: String(usd6), issuedAt: at, expiresAt: at + 45_000, solver: pub };
      st.quotes.set(q.id, q); st.ledger.push({ id: q.id, at, state: 'quoted', usd6: String(usd6), user: b.recipient });
      return json({ ok: true, quote: q, sig: C.signQuote(q, seed), etaMs: 1200 });
    }
    if (path.startsWith('/fill')) {
      const b = JSON.parse(init.body); const q = st.quotes.get(b.id);
      if (!q) return json({ ok: false, error: 'unknown quote', sent: false });
      if (q.src.chain !== 'sol') {
        const tx = parseTransaction(b.raw); const from = await recoverTransactionAddress({ serializedTransaction: b.raw });
        const why = C.evmSourceProblem(tx, from, q); if (why) return json({ ok: false, state: 'failed', error: why });
      }
      st.fills.push({ id: q.id, from: q.src.chain, usd6: BigInt(q.usd6), hash: q.src.chain === 'sol' ? 'solsig' : keccak256(b.raw) });
      const rec = st.ledger.find((x) => x.id === q.id);
      if (st.fillState) { rec.state = st.fillState; return json({ ok: false, state: st.fillState, error: 'your transfer has not landed yet', srcHash: st.fills[st.fills.length - 1].hash }); }
      rec.state = 'filled';
      if (st.payout) st.wBnb += BigInt(q.dst.amount);   // the payout lands in W on BNB
      return json({ ok: true, state: 'filled', srcHash: st.fills[st.fills.length - 1].hash, dstHash: '0xdst', ms: { paid: 900 } });
    }
    if (path.startsWith('/status')) return json({ ok: true, state: st.statusState, dstHash: '0xdst' });
    throw new Error('test: unexpected motion path ' + path);
  };
  const store = new Map(); let nonce = 0;
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const deps = {
    chain: () => 'bsc',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W.address, sol: sol.W }, r: { evm: R.address, sol: sol.R } }; },
    evm: {
      call: async () => '0x', balance: async (a) => (lc(a) === lc(R.address) ? BSCC.reserveGas : lc(a) === lc(W.address) ? st.wBnb : 0n), erc20: async () => 0n,
      allowance: async () => 0n, slot0: async () => BNB_SQRT, fees: async () => ({ baseFee: 1_000_000_000n, gasPrice: 1_000_000_000n, l1PerByte: 0n }),
      estimate: async () => 150_000n, sendR: async () => { throw new Error('test: nothing broadcast by the vault here'); }, sendW: async () => { throw new Error('test: nothing broadcast by the vault here'); }, receipt: async () => null,
    },
    sol: { balance: async () => 0n, usdc: async () => 0n, oracle6: async () => 100n * F.USD, fees: async () => { throw new Error('defaults'); }, quote: async () => 0n, topup: async () => { throw new Error('no'); }, sweep: async () => 'x', gas: async () => 'x', status: async () => 'confirmed' },
    solver: {
      base: () => 'https://motion.gift', pinnedKey: () => pub,
      signEvmTransfer: async (a) => {
        const raw = await R.signTransaction({ to: a.token, data: C.erc20TransferData(a.to, a.amount), value: 0n, gas: 120_000n, gasPrice: 20_000_000n, nonce: nonce++, chainId: C.bridgeCfg(a.chain).chainId, type: 'legacy' });
        st.signed.push(a); return { raw, hash: keccak256(raw) };
      },
      signSolTransfer: async (a) => { st.signed.push({ ...a, chain: 'sol' }); return { raw: 'base64-' + a.memo, sig: 'solsig' + st.signed.length }; },
      ...(o.solReserve ? { solReserveOn: async () => o.solReserve } : {}),
    },
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => Date.now() + st.skew,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {},
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes('/api/bridge/motion')) return solverFetch(u, init);
      st.relayCalls.push(u);
      return { ok: false, status: 503, json: async () => ({ message: 'no public bridge in this test' }) };
    },
    click: () => click, wait: async () => {},
  };
  const f = createFloat(deps);
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  const rhSnap = (reserveUsd) => store.set(`trenches.float.v1.snap.robinhood.${lc(W.address)}`, JSON.stringify({ at: Date.now(), chain: 'robinhood', price6: String(4000n * F.USD), priceAt: Date.now(), float: String(RH.gasFloor), reserve: String(F.usd6(reserveUsd)), reserveNative: String(RH.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [] }));
  const on = async () => { const r = await f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] }); for (const k of [...store.keys()]) if (k.startsWith('trenches.float.v1.order.')) store.delete(k); return r; };
  const jobsKey = () => [...store.keys()].find((k) => k.startsWith('trenches.float.v1.jobs.bsc.'));
  const colds = async () => (await f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'cold');
  const clickBuy = (usd) => f.ensure({ walletId: 'w1', chain: 'bsc', usd, reason: 'click' });
  const usdOfBnb = (raw) => F.nativeToUsd6(raw, BNB_USD * F.USD, 18);
  return { f, st, store, settle, rhSnap, on, jobsKey, colds, clickBuy, usdOfBnb, W: W.address, R: R.address };
}

const NOW = Date.now();
const ETH6 = 2_266_050_000n, BNB6 = 600_000_000n, SOL6 = 160_000_000n;
const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(10), F.usd6(25), F.usd6(50), F.usd6(100)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const wEth = (usd) => (F.usd6(usd) * 10n ** 18n) / ETH6;

test('plan (no urgentAtomic: an older caller): the $540 click — the BNB reserve goes whole, the plan is ~$186 short, and W lands below the buy', () => {
  const FC = F.FLOAT_CFG;
  const chains = {
    robinhood: cs({ price6: ETH6, float: wEth(250.4), reserve: 0n, reserveNative: FC.robinhood.reserveGas }),
    bsc: cs({ price6: BNB6, reserve: F.usd6(239.113576) * 10n ** 12n, reserveNative: FC.bsc.reserveGas, float: FC.bsc.gasFloor }),
    sol: cs({ price6: SOL6, float: (F.usd6(22.4) * 10n ** 9n) / SOL6 }),
  };
  const p = F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(549), movedToday6: 0n, feesToday6: 0n, estFee6: () => 0n, urgent: { chain: 'robinhood', usd6: F.usd6(540) }, urgentFrom: ['bsc'] });
  const colds = p.moves.filter((m) => m.kind === 'cold' && m.chain === 'robinhood');
  assert.deepEqual(colds.map((m) => [m.from, m.usd6]), [['bsc', F.usd6(239.113576)]], 'the exact payout of the bridge log');
  assert.equal(p.short?.chain, 'robinhood');
  const reach6 = F.clickUsd6('robinhood', chains.robinhood.float, ETH6) + colds[0].usd6;
  assert.ok(reach6 < F.usd6(540), `W can pay ${F.fmtUsd6(reach6)} after the move — below the $540 the hold waits for`);
  assert.ok(p.short.usd6 > F.usd6(180) && p.short.usd6 < F.usd6(190), F.fmtUsd6(p.short.usd6));
});

test('engine TC-1: the $540-shaped click (one donor reserve $239.11, W at its gas floor) moves NOTHING and answers at once — failed, code short, what it can pay', async () => {
  const x = world({ payout: true }); await x.on(); x.rhSnap(239.113576);
  const r = await x.clickBuy(540); await x.settle();
  assert.equal(r.click.state, 'failed', JSON.stringify(r.click)); assert.equal(r.click.code, 'short');
  assert.equal(r.click.short.usd, 540);
  assert.ok(r.click.short.canUsd > 230 && r.click.short.canUsd < 239.113576, 'canUsd = the reserve less what its move may lose: ' + JSON.stringify(r.click.short));
  assert.equal(x.st.signed.length, 0, 'nothing signed (before: the whole $239.11 reserve became BNB in W)');
  assert.equal((await x.colds()).length, 0, 'no cold job');
  assert.equal(r.planned.filter((m) => m.chain === 'bsc' && (m.kind === 'cold' || m.kind === 'topup')).length, 0, JSON.stringify(r.planned));
});

test('engine E1: a click whose moves went but a part was refused on the way (W stays short) answers moving + short {5, 995}', async () => {
  // $1,000 → need $1,250: parts $990 + $110 from the Robinhood reserve ($1,100) + $5 from Solana. TC-1 calls it payable; motion
  // refuses the second Robinhood part (inventory floor), the Solana $5 goes: W can pay $995 of the $1,000
  const x = world({ solReserve: { stable: F.usd6(5), native: 10_000_000n }, refuseQuote: (u, st, b) => (b.from === 'robinhood' && st.fills.length >= 1 ? 'inventory floor on the destination chain' : '') }); await x.on(); x.rhSnap(1100);
  x.store.set(`trenches.float.v1.snap.sol.${lc(x.W)}`, JSON.stringify({ at: Date.now(), chain: 'sol', price6: String(100n * F.USD), priceAt: Date.now(), float: '0', reserve: String(F.usd6(5)), reserveNative: '10000000', inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [], buys6: [] }));
  const r = await x.clickBuy(1000); await x.settle();
  assert.equal(r.click.state, 'moving', JSON.stringify(r.click));
  assert.deepEqual(r.click.short, { usd: 5, canUsd: 995 }, JSON.stringify(r.click));
  assert.equal(x.st.signed.length, 2, 'the $990 part and the Solana $5; the refused part signed nothing');
});

test('engine: a covered click answers exactly as before (no short)', async () => {
  const x = world({ payout: true }); await x.on(); x.rhSnap(2500);
  const r = await x.clickBuy(540); await x.settle();
  assert.equal(r.click.state, 'moving'); assert.equal(r.click.short, undefined, JSON.stringify(r.click));
  assert.equal(x.st.signed.length, 1);
});

// REGRESSION (review 2026-11-04 F1, review-tests/review-e1-settle.mjs test 1 flipped): click 1's payout ARRIVED (solver: filled)
// but no read here shows it yet (BRIDGE_SETTLE_MS), and the reserves left cannot cover click 2's need + 25 %. The planned cold move
// is held ('settling'), the answer is 'moving' + retryMs. Before the fix the same answer also said short { canUsd ~0 } (the arrived
// payout is neither in s.float nor in inFlight6, the held move not in went6), and the page ended the hold at once with "can't pay".
test('REGRESSION engine: a press within 10 s of an arrived-but-invisible payout is NOT short; after retryMs the payout pays the buy, nothing bridged twice', async () => {
  const x = world({ payout: false }); await x.on(); x.rhSnap(130);
  const a = await x.clickBuy(100); await x.settle();
  assert.equal(a.click.state, 'moving'); assert.equal(x.st.signed.length, 1);
  assert.ok(!a.click.short, 'click 1 is covered: ' + JSON.stringify(a.click));
  await x.f.status({ walletId: 'w1', fresh: true }); await x.settle();   // the payout does not show in this read yet
  x.rhSnap(5);                                                          // what the Robinhood reserve still holds
  const b = await x.clickBuy(100); await x.settle();
  assert.equal(x.st.signed.length, 1, 'nothing bridged twice');
  assert.equal(b.click.state, 'moving');
  assert.equal(b.planned.find((m) => m.kind === 'cold').skipped, 'held');
  assert.ok(b.click.retryMs > 0 && b.click.retryMs <= F.BRIDGE_SETTLE_MS + 250, 'the engine says: ask again after the settle wait: ' + JSON.stringify(b.click));
  assert.equal(b.click.short, undefined, 'no short while a move is held: ' + JSON.stringify(b.click));
  // the payout shows (the node caught up) and the page asks again once retryMs is over: W pays the $100 buy, no new bridge
  const q = [...x.st.quotes.values()].pop(); x.st.wBnb += BigInt(q.dst.amount);
  x.st.skew += b.click.retryMs;
  const again = await x.clickBuy(100); await x.settle();
  assert.equal(again.click.short, undefined, JSON.stringify(again.click));
  assert.notEqual(again.click.state, 'failed', JSON.stringify(again.click));
  assert.equal(x.st.signed.length, 1, 'still one signed transfer: ' + x.st.signed.length);
  assert.ok(x.usdOfBnb(x.st.wBnb - BSCC.gasFloor) >= F.usd6(100), 'W holds the $100 buy: ' + F.fmtUsd6(x.usdOfBnb(x.st.wBnb)));
  const st = await x.f.status({ walletId: 'w1', fresh: true });
  assert.ok(st.chains.bsc.ready >= 100, 'the page\'s ready figure covers the buy, so the hold fires: ' + JSON.stringify(st.chains.bsc.ready));
});

// The other `held` shape: a click over one fill whose first part is not known filled yet holds the next part. The plan is short
// ($1,000 → need $1,250, the Robinhood reserve holds $1,100), but the held part ($110) is on its way: no short, the page waits.
test('engine: a later part held behind an unlanded part is not reported short (its dollars are still coming)', async () => {
  const x = world({ fillState: 'source-late', statusState: 'source-late' }); await x.on(); x.rhSnap(1100);
  const r = await x.clickBuy(1000); await x.settle();
  assert.equal(x.st.signed.length, 1);
  assert.equal(r.click.state, 'moving');
  assert.equal(r.planned.filter((m) => m.kind === 'cold' && m.skipped === 'held').length, 1, JSON.stringify(r.planned));
  assert.equal(r.click.short, undefined, JSON.stringify(r.click));
});
