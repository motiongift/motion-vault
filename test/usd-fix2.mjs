// USD balance fix pass 2 (2026-11-01, owner «я даю добро на все … главное для нас это скорость и стабильность как торговли так и
// приложения», «мы не можем проебать бабки юзеров никак строго»), B:\tmp\audit2\pass2.json "p2-usd-parity-*":
//   xchain-cap-800      a click whose cross-chain part was over motion's $1,000 per-fill cap went as ONE move, refused whole, every
//                       time: now parts of at most $990 (XCHAIN), one after another, each only once the one before it FILLED
//   settle-window-hang  a second cross-chain-funded click within 10 s of the first one's arrival (a double tap) answered "moving"
//                       and waited 15 s for nothing: a read here that showed the payout ends the settle wait (payoutSeen), and a
//                       wait that is only the settle window names when to ask again (retryMs)
//   open-job-lockout    an earlier click's move still open after 20 s (a late source, a refund on its way) made every later click
//                       hang 15 s: answered at once, "still settling" (code 'settling'); the one-open-move rule stays
//   no-click-failover   a refusal carries a code the app words for the user (over-cap / bridge-busy / bridge-off / bridge-limit)
// A BNB frame (oracle priced at $700) whose dollars sit in the Robinhood reserve; motion's solver mocked with the real core.
//   node --test test/usd-fix2.mjs
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

// ── 1. over motion's per-fill cap ──
test('planner: a $900 click with $2,500 in each of two other reserves goes as parts of at most $990 (before: ONE $1,125 move, refused whole)', () => {
  const NOW = Date.now(); const ETH6 = 4000n * F.USD, BNB6 = BNB_USD * F.USD;
  const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
  const chains = { robinhood: cs({ price6: ETH6, reserve: F.usd6(2500), reserveNative: RH.reserveGas, float: RH.gasFloor }), sol: cs({ price6: 100n * F.USD, reserve: F.usd6(2500), reserveNative: F.FLOAT_CFG.sol.reserveGas }), bsc: cs({ price6: BNB6, float: BSCC.gasFloor }) };
  const plan = (usd, partMax6) => F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(5000), movedToday6: 0n, feesToday6: 0n, estFee6: () => 0n, urgent: { chain: 'bsc', usd6: F.usd6(usd) }, urgentFrom: ['robinhood'], ...(partMax6 ? { partMax6 } : {}) });
  const p = plan(900);
  const cold = p.moves.filter((m) => m.kind === 'cold');
  assert.ok(cold.length >= 2, JSON.stringify(cold.map((m) => String(m.usd6))));
  for (const m of cold) assert.ok(m.usd6 <= F.XCHAIN.part6 && m.usd6 <= MOTION_BRIDGE_MAX6, String(m.usd6));
  assert.equal(cold.reduce((t, m) => t + m.usd6, 0n), F.usd6(1125), 'the need + 25 % (W already holds its gas floor)');
  assert.equal(p.short, undefined);
  assert.deepEqual(cold.map((m) => m.from), ['robinhood', 'robinhood'], 'the frame\'s own-signable reserve first, while it holds enough');
  // at most XCHAIN.parts for the whole click: a $5,000 click is short by what four parts cannot carry, and says so
  const huge = plan(5000);
  assert.equal(huge.moves.filter((m) => m.kind === 'cold').length, F.XCHAIN.parts);
  const hugeCold = huge.moves.filter((m) => m.kind === 'cold');
  assert.ok(hugeCold.every((m) => m.usd6 <= F.XCHAIN.part6));
  assert.equal(huge.short.usd6, F.usd6(6250) - hugeCold.reduce((t, m) => t + m.usd6, 0n), 'short by what the parts could not carry');
  // a solver whose health names a lower cap: parts under it
  const low = plan(900, F.partMaxOf(F.usd6(250)));
  assert.ok(low.moves.filter((m) => m.kind === 'cold').every((m) => m.usd6 <= F.usd6(247.5)));
  assert.equal(F.partMaxOf(0n), F.XCHAIN.part6); assert.equal(F.partMaxOf(F.usd6(1000)), F.usd6(990)); assert.equal(F.partMaxOf(F.usd6(5000)), F.usd6(990));
  assert.equal(F.xchainClickMax6(), F.usd6(3960));
  // a click under the cap is one move, exactly as before
  const small = plan(100);
  assert.deepEqual(small.moves.filter((m) => m.kind === 'cold').map((m) => m.usd6), [F.usd6(125)]);
});

test('engine: a $900 BNB click paid from $2,500 in the Robinhood reserve fills in two parts under $1,000, one after another (before: refused, "Top-up didn\'t arrive")', async () => {
  const x = world(); await x.on(); x.rhSnap(2500);
  const r = await x.clickBuy(900); await x.settle();
  const parts = await x.colds();
  assert.equal(parts.length, 2, JSON.stringify(parts.map((j) => [j.usd6, j.state, j.error])));
  for (const j of parts) { assert.equal(j.state, 'arrived', j.error); assert.equal(j.bridge, 'motion'); assert.ok(BigInt(j.usd6) <= MOTION_BRIDGE_MAX6); assert.equal(j.click, true); }
  assert.equal(new Set(parts.map((j) => j.id)).size, 2);
  assert.equal(parts.reduce((t, j) => t + BigInt(j.usd6), 0n), F.usd6(1125));
  assert.equal(x.st.signed.length, 2, 'one signed transfer per part');
  for (const s of x.st.signed) assert.ok(C.stableToUsd6(s.amount, RH.stable.decimals) <= MOTION_BRIDGE_MAX6);
  assert.equal(x.st.relayCalls.length, 0);
  assert.equal(r.click.state, 'moving');
  // W now holds the $900 buy (the payouts landed): the click is covered
  assert.ok(x.usdOfBnb(x.st.wBnb - BSCC.gasFloor) >= F.usd6(900), F.fmtUsd6(x.usdOfBnb(x.st.wBnb)));
  // the wallet status tells the app how much one click may carry across chains
  const stt = await x.f.status({ walletId: 'w1' });
  assert.equal(stt.limits.xchainUsd, 3960); assert.equal(stt.limits.partUsd, 990);
});

test('engine: the next part waits for the one before it — a part whose fill is not known yet holds the rest (never two transfers of a wallet in flight from one click)', async () => {
  const x = world({ fillState: 'source-late', statusState: 'source-late' }); await x.on(); x.rhSnap(2500);
  const r = await x.clickBuy(900); await x.settle();
  const parts = await x.colds();
  assert.equal(parts.length, 1, 'the second part was not signed: ' + JSON.stringify(parts.map((j) => [j.usd6, j.state])));
  assert.equal(parts[0].state, 'relaying');
  assert.equal(x.st.signed.length, 1);
  assert.equal(r.click.state, 'moving');
  assert.equal(r.planned.filter((m) => m.kind === 'cold' && m.skipped === 'held').length, 1);
});

test('engine: a second part refused before anything was signed (Robinhood at its limit) is planned again from the Solana reserve for ITS share only — never the whole need twice (before: no retry once any part went)', async () => {
  // the Solana reserve holds $1,000 and can pay its own transfer fee; motion refuses a second Robinhood part (inventory floor)
  const x = world({ solReserve: { stable: F.usd6(1000), native: 10_000_000n }, refuseQuote: (u, st, b) => (b.from === 'robinhood' && st.fills.length >= 1 ? 'inventory floor on the destination chain' : '') }); await x.on(); x.rhSnap(2500);
  x.store.set(`trenches.float.v1.snap.sol.${lc(x.W)}`, JSON.stringify({ at: Date.now(), chain: 'sol', price6: String(100n * F.USD), priceAt: Date.now(), float: '0', reserve: String(F.usd6(1000)), reserveNative: '10000000', inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [], buys6: [] }));
  const r = await x.clickBuy(900); await x.settle();
  const parts = await x.colds();
  const went = parts.filter((j) => j.state !== 'failed');
  assert.deepEqual(went.map((j) => [j.from, j.usd6, j.state]), [['robinhood', String(F.usd6(990)), 'arrived'], ['sol', String(F.usd6(135)), 'arrived']], JSON.stringify(parts.map((j) => [j.from, j.usd6, j.state, j.error])));
  const failed = parts.filter((j) => j.state === 'failed');
  assert.equal(failed.length, 1); assert.match(failed[0].error, /inventory floor/); assert.equal(failed[0].from, 'robinhood');
  assert.equal(x.st.signed.length, 2, 'the refused part signed nothing');
  assert.ok(x.usdOfBnb(x.st.wBnb - BSCC.gasFloor) >= F.usd6(1125) - F.usd6(0.01), 'W got the need + 25 %, no more');
  assert.equal(r.click.state, 'moving');
});

test('engine: a refusal of the only move carries a code the page words for the user (inventory floor → bridge-limit)', async () => {
  const x = world({ refuseQuote: () => 'inventory floor on the destination chain' }); await x.on(); x.rhSnap(500);
  const r = await x.clickBuy(100); await x.settle();
  assert.equal(r.click.state, 'failed', JSON.stringify(r.click));
  assert.equal(r.click.code, 'bridge-limit');
  assert.equal(x.st.signed.length, 0, 'nothing signed');
});

test('clickCodeOf: the vault\'s and the solver\'s refusal texts', () => {
  for (const [t, c] of [
    ['motion: above what motion carries (the public bridges run from the source chain frame)', 'over-cap'],
    ['motion: above the solver per-fill cap (the public bridges run from the source chain frame)', 'over-cap'],
    ['motion: motion bridge: above the per-fill cap', 'over-cap'],
    ['motion: motion bridge: a fill of this wallet is already in flight (x)', 'bridge-busy'],
    ['motion: motion bridge: inventory floor on the destination chain', 'bridge-limit'],
    ['motion: motion bridge: above this wallet\'s daily cap', 'bridge-limit'],
    ['motion: the solver is off (the public bridges run from the source chain frame)', 'bridge-off'],
    ['motion: motion bridge: off', 'bridge-off'],
    ['motion: restarting', 'bridge-off'],
    ['motion: quote timed out', 'bridge-off'],
    ['The approval did not land', 'refused'],
  ]) assert.equal(F.clickCodeOf(t), c, t);
});

// ── 2. the settle window ──
test('engine: a double tap — click 2 right after click 1\'s payout arrived AND was seen here AND spent by the buy — bridges its own need at once (before: "moving", 15 s, "not sent")', async () => {
  const x = world(); await x.on(); x.rhSnap(2500);
  const a = await x.clickBuy(100); await x.settle();
  assert.equal(a.click.state, 'moving'); assert.equal(x.st.signed.length, 1);
  // the page's hold reads the chain (fresh) and sees the payout, then fires the buy, which spends it
  await x.f.status({ walletId: 'w1', fresh: true }); await x.settle();
  x.st.wBnb = BSCC.gasFloor;
  x.rhSnap(2500 - 125);
  const b = await x.clickBuy(100); await x.settle();
  assert.equal(x.st.signed.length, 2, 'click 2 bridged its own need: ' + JSON.stringify(b));
  assert.equal(b.click.state, 'moving');
  assert.ok(!b.planned.some((m) => m.skipped), JSON.stringify(b.planned));
  assert.equal((await x.colds()).filter((j) => j.state === 'arrived').length, 2);
});

test('engine: click 2 within the settle window whose payout NO read here showed yet still waits (no second bridge of the same need) and says when to ask again', async () => {
  const x = world({ payout: false }); await x.on(); x.rhSnap(2500);
  await x.clickBuy(100); await x.settle();
  await x.f.status({ walletId: 'w1', fresh: true }); await x.settle();   // W unchanged: the payout does not show yet
  const b = await x.clickBuy(100); await x.settle();
  assert.equal(x.st.signed.length, 1, 'never bridged twice while the payout may still be on its way');
  assert.equal(b.click.state, 'moving');
  assert.ok(b.click.retryMs > 0 && b.click.retryMs <= F.BRIDGE_SETTLE_MS + 250, JSON.stringify(b.click));
  assert.equal(b.planned.find((m) => m.kind === 'cold').skipped, 'held');
});

test('payoutSeen: only a read after the plan\'s read, at base + every arrived move of that plan', () => {
  const j = (o) => ({ id: 'a', walletId: 'w', kind: 'cold', chain: 'bsc', from: 'robinhood', usd6: '1', fee6: '0', state: 'arrived', at: 0, updatedAt: 0, hashes: [], reason: 'click', base: '100', baseAt: 1000, minOut: '50', ...o });
  const a = j({}), b = j({ id: 'b', minOut: '30' });
  assert.equal(F.payoutSeen(a, [a, b], [{ at: 1500, float: 179n }]), false, 'both parts must show');
  assert.equal(F.payoutSeen(a, [a, b], [{ at: 1500, float: 180n }]), true);
  assert.equal(F.payoutSeen(a, [a, b], [{ at: 900, float: 10_000n }]), false, 'a read before the plan proves nothing');
  assert.equal(F.payoutSeen(j({ base: undefined }), [a], [{ at: 1500, float: 10_000n }]), false, 'an older job keeps the wait');
  assert.equal(F.payoutSeen(a, [a, j({ id: 'c', baseAt: 2000, minOut: '1000' })], [{ at: 1500, float: 150n }]), true, 'another plan\'s move is not counted');
});

// ── 3. an earlier click's move still open ──
test('engine: an earlier click\'s move still open 25 s later (a late source on motion\'s side): the next click is answered at once — failed, code "settling" — and nothing more is signed', async () => {
  const x = world({ fillState: 'source-late', statusState: 'source-late' }); await x.on(); x.rhSnap(2500);
  await x.clickBuy(100); await x.settle();
  assert.equal(x.st.signed.length, 1);
  // 25 s on
  const k = x.jobsKey(); const jobs = JSON.parse(x.store.get(k)); for (const j of jobs) { j.at -= 25_000; j.updatedAt -= 25_000; } x.store.set(k, JSON.stringify(jobs));
  const b = await x.clickBuy(100); await x.settle();
  assert.equal(b.click.state, 'failed', JSON.stringify(b.click));
  assert.equal(b.click.code, 'settling');
  assert.match(b.click.why, /still settling/);
  assert.equal(x.st.signed.length, 1, 'the one-open-move rule stays');
  // a click right after the first one (its move is young) still waits for it, as before
  const y = world({ fillState: 'source-late', statusState: 'source-late' }); await y.on(); y.rhSnap(2500);
  await y.clickBuy(100); await y.settle();
  const c = await y.clickBuy(100); await y.settle();
  assert.equal(c.click.state, 'moving', JSON.stringify(c.click));
});
