// PROPOSAL TC-1 (2026-11-04, local usd-scenarios; NOT applied — the owner's line-by-line yes and an independent review first):
// a click is planned all or nothing. The owner's $540 MOTION buy on Robinhood (local usd-buy-timeout): Wallet 1 could reach
// $489.51 there ($250.40 of ETH in W + the BNB reserve's $239.11); the plan still moved the whole BNB reserve, W landed at $489,
// the page waited its 15 s and said "try again". Now nothing moves for a click that cannot be paid, the answer says so at once
// (click.state 'failed', code 'short', short.canUsd), and every click that CAN be paid is planned byte for byte as before.
// The world (a BNB frame, motion's solver mocked with the real core) is test/usd-fix2.mjs's, copied.
//   node --test test/usd-atomic-click.mjs
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

// motion's solver over fetch: the per-fill cap and the wallet's open fills as the real solver counts them (motionBridgeCore
// quoteRefusal / useOf), a payout that lands in W on fill (st.payout), refusals on demand
function world(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const sol = { W: b58(ed25519.getPublicKey(rnd32())), R: b58(ed25519.getPublicKey(rnd32())) };
  const seed = rnd32(); const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposits = { robinhood: privateKeyToAccount(generatePrivateKey()).address, bsc: privateKeyToAccount(generatePrivateKey()).address, sol: b58(ed25519.getPublicKey(rnd32())) };
  const st = { wBnb: o.wBnb ?? BSCC.gasFloor, quotes: new Map(), fills: [], ledger: [], signed: [], relayCalls: [], quoteAsks: [], refuseQuote: o.refuseQuote || null, fillState: o.fillState || null, statusState: o.statusState || 'filled', maxFillUsd: o.maxFillUsd ?? 1000, payout: o.payout !== false };
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
    now: () => Date.now(),
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


const NOW0 = Date.now();
const ETH6 = 2_266_050_000n, BNB6x = 600_000_000n, SOL6 = 160_000_000n;
const CFG = F.FLOAT_CFG;
const cs = (o) => ({ price6: 0n, priceAt: NOW0, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(10), F.usd6(25), F.usd6(50), F.usd6(100)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const wEth = (usd) => (F.usd6(usd) * 10n ** 18n) / ETH6;
const incident = () => ({
  robinhood: cs({ price6: ETH6, float: wEth(250.4) + CFG.robinhood.gasFloor, reserve: 0n, reserveNative: CFG.robinhood.reserveGas }),
  bsc: cs({ price6: BNB6x, reserve: F.usd6(239.113576) * 10n ** 12n, reserveNative: CFG.bsc.reserveGas, float: CFG.bsc.gasFloor }),
  sol: cs({ price6: SOL6, float: (F.usd6(22.4) * 10n ** 9n) / SOL6 }),
});
const planOf = (chains, usd, o = {}) => F.planMoves({ now: NOW0, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(549), movedToday6: 0n, feesToday6: 0n, estFee6: o.fee ?? (() => 0n), urgent: { chain: 'robinhood', usd6: F.usd6(usd) }, urgentFrom: ['bsc'], ...o.extra });

test('TC-1 planner: the $540 click — nothing is planned (before: the whole BNB reserve), short.infeasible, can6 = what it CAN pay', () => {
  const before = planOf(incident(), 540);
  assert.deepEqual(before.moves.map((m) => [m.kind, m.from, m.usd6]), [['cold', 'bsc', F.usd6(239.113576)]], 'today: the BNB reserve goes whole');
  const p = planOf(incident(), 540, { extra: { urgentAtomic: true } });
  // (the BNB chain's own background top-up of W there from its reserve may stay in the plan: it runs only in the BNB frame, never here)
  assert.deepEqual(p.moves.filter((m) => m.chain === 'robinhood' || m.kind === 'cold'), [], 'no move at all for the click');
  assert.equal(p.short.infeasible, true);
  assert.ok(p.skips.some((x) => x.chain === 'robinhood' && x.why === 'no-reserve'), 'the skip the page already words as "funds"');
  // reach = $250.40 + $239.11; less 0.5 % slippage on what had to move
  const reach6 = F.usd6(250.4) + F.usd6(239.113576);
  const loss6 = ((F.usd6(540) - F.usd6(250.4)) * 50n) / 10_000n;
  assert.ok(p.short.can6 <= reach6 - loss6 + 2n && p.short.can6 >= reach6 - loss6 - 2n, F.fmtUsd6(p.short.can6));
  assert.ok(p.short.can6 >= F.usd6(487) && p.short.can6 < F.usd6(490), F.fmtUsd6(p.short.can6));
});

test('TC-1 planner: a payable click is planned EXACTLY as before (500 random worlds x 3 sizes); only infeasible ones change', () => {
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  let same = 0, changed = 0;
  for (let i = 0; i < 500; i++) {
    const r = (m) => Math.round(rnd() * m * 100) / 100;
    const chains = {
      robinhood: cs({ price6: ETH6, float: wEth(r(200)) + CFG.robinhood.gasFloor, reserve: F.usd6(r(300)), reserveNative: CFG.robinhood.reserveGas }),
      bsc: cs({ price6: BNB6x, reserve: F.usd6(r(300)) * 10n ** 12n, reserveNative: CFG.bsc.reserveGas, float: CFG.bsc.gasFloor }),
      sol: cs({ price6: SOL6, reserve: F.usd6(r(200)), reserveNative: rnd() < 0.5 ? 10_000_000n : 0n }),
    };
    for (const usd of [5, 120, 600]) {
      const later = rnd() < 0.5 ? ['sol'] : undefined;
      const extra = later ? { urgentLater: later } : {};
      const a = planOf(chains, usd, { extra });
      const b = planOf(chains, usd, { extra: { ...extra, urgentAtomic: true }, fee: () => F.usd6(0.02) });
      const b0 = planOf(chains, usd, { extra, fee: () => F.usd6(0.02) });
      if (b.short?.infeasible) { changed++; assert.equal(b.moves.filter((m) => m.chain === 'robinhood').length, 0); continue; }
      assert.deepEqual(b, b0, 'a feasible click: the plan is byte for byte the old one');
      same++;
      // and the old plan of a feasible click reaches the buy once it lands (the reason it was called feasible)
      const landed = a.moves.filter((m) => m.chain === 'robinhood' && (m.kind === 'topup' || m.kind === 'cold')).reduce((t, m) => t + m.usd6, 0n);
      const now6 = F.clickUsd6('robinhood', chains.robinhood.float, ETH6);
      assert.ok(now6 + landed >= F.usd6(usd) - 1n, `feasible => the moves cover the buy: ${usd} ${F.fmtUsd6(now6 + landed)}`);
    }
  }
  assert.ok(same > 300 && changed > 50, `${same} unchanged, ${changed} infeasible`);
});

test('TC-1 planner: a bridge landing into this chain right now keeps the old answer (bridge-busy: the page asks again)', () => {
  const ch = incident(); ch.robinhood.busyBridge = true;
  const p = planOf(ch, 540, { extra: { urgentAtomic: true } });
  assert.equal(p.short?.infeasible, undefined);
  assert.ok(p.skips.some((x) => x.why === 'bridge-busy'));
});

test('TC-1 planner: the wallet\'s own native elsewhere (urgentExtra6) makes a split click feasible; the reserve gas move is taken back when infeasible', () => {
  const p = planOf(incident(), 540, { extra: { urgentAtomic: true, urgentExtra6: F.usd6(100) } });
  assert.equal(p.short?.infeasible, undefined, 'reserves $489.5 + $100 of BNB in W on BNB: feasible — the reserves move, nativeDonorRun brings the rest');
  assert.ok(p.moves.some((m) => m.kind === 'cold' && m.from === 'bsc'));
  // R here without gas, W able to spare it: the plan takes a W -> R gas move first — and drops it again for an infeasible click
  const g = incident(); g.robinhood.reserve = F.usd6(5); g.robinhood.reserveNative = 0n;
  const q = planOf(g, 900, { extra: { urgentAtomic: true } });
  assert.equal(q.short.infeasible, true);
  assert.deepEqual(q.moves.filter((m) => m.chain === 'robinhood'), [], 'no gas move for a click that cannot happen');
  assert.ok(planOf(g, 900).moves.some((m) => m.kind === 'gas'), 'today: the gas move is planned');
});

test('TC-1 engine: an infeasible BNB click signs NOTHING and answers at once — failed, code "short", canUsd', async () => {
  const x = world(); await x.on(); x.rhSnap(300);
  const r = await x.clickBuy(540); await x.settle();
  assert.equal(x.st.signed.length, 0, 'no transfer signed');
  assert.equal(x.st.quoteAsks.length, 0, 'not even a quote asked');
  assert.equal(r.click.state, 'failed', JSON.stringify(r.click));
  assert.equal(r.click.code, 'short');
  assert.ok(r.click.short.canUsd > 295 && r.click.short.canUsd < 300.5, JSON.stringify(r.click.short));
  assert.equal(r.click.short.usd, 540);
  assert.equal((await x.colds()).length, 0);
});

test('TC-1 engine: a payable click is unchanged — the $250 click fills from the Robinhood reserve as before', async () => {
  const x = world(); await x.on(); x.rhSnap(500);
  const r = await x.clickBuy(250); await x.settle();
  assert.equal(r.click.state, 'moving');
  const parts = await x.colds();
  assert.deepEqual(parts.map((j) => [j.from, j.usd6, j.state]), [['robinhood', String(F.usd6(312.5)), 'arrived']]);
});
