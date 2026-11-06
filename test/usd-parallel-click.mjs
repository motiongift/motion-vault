// PROPOSAL TC-6 (2026-11-04, B:/tmp/usd-scenarios; NOT applied): a click's moves signed on different chains run side by side.
// A BNB click paid from the Robinhood reserve AND the Solana reserve: before, the Solana part's quote and fill started only after
// the Robinhood part had filled; now both go at once (motion allows two fills of a wallet in flight), and the parts of ONE reserve
// still go one after another. The world is test/usd-fix2.mjs's (copied), with a delay on motion's /fill.
//   node --test test/usd-parallel-click.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      // (TC-6 timing) each fill takes `fillMs` on motion's side: the quote, the source's inclusion, the payout's broadcast
      if (o.fillMs) { st.inFill = (st.inFill || 0) + 1; st.maxInFill = Math.max(st.maxInFill || 0, st.inFill); await new Promise((r) => setTimeout(r, o.fillMs)); st.inFill -= 1; }
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


const solSnapOf = (x, usd) => x.store.set(`trenches.float.v1.snap.sol.${lc(x.W)}`, JSON.stringify({ at: Date.now(), chain: 'sol', price6: String(100n * F.USD), priceAt: Date.now(), float: '0', reserve: String(F.usd6(usd)), reserveNative: '10000000', inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [], buys6: [] }));

test('TC-6 engine: two donors fill side by side — the click\'s top-up takes about ONE fill, not two; both parts arrive, exactly the need + 25 %', async () => {
  const x = world({ fillMs: 400, solReserve: { stable: F.usd6(200), native: 10_000_000n } }); await x.on(); x.rhSnap(150); solSnapOf(x, 200);
  const t0 = Date.now();
  const r = await x.clickBuy(250); await x.settle();
  const ms = Date.now() - t0;
  if (process.env.TC6MS) console.log('TC6MS', ms);
  const parts = await x.colds();
  assert.deepEqual(parts.map((j) => [j.from, j.state]).sort(), [['robinhood', 'arrived'], ['sol', 'arrived']], JSON.stringify(parts.map((j) => [j.from, j.usd6, j.state, j.error])));
  assert.equal(parts.reduce((t, j) => t + BigInt(j.usd6), 0n), F.usd6(312.5));
  assert.equal(x.st.maxInFill, 2, 'both fills were in flight at once');
  assert.ok(ms < 750, `about one fill (400 ms), not two: ${ms} ms`);
  assert.equal(r.click.state, 'moving');
});

test('TC-6 engine: the parts of ONE reserve still go one after another (never two transfers of the same reserve in flight)', async () => {
  const x = world({ fillMs: 200 }); await x.on(); x.rhSnap(2500);
  await x.clickBuy(900); await x.settle();
  const parts = await x.colds();
  assert.equal(parts.length, 2); assert.ok(parts.every((j) => j.state === 'arrived'));
  assert.equal(x.st.maxInFill, 1, 'one fill of that reserve at a time');
});

test('TC-6 engine: a background tick is untouched (one move after another)', async () => {
  const W = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8');
  assert.match(W, /if \(!urgent\) \{ for \(const m of mine\) \{ if \(clickWants\(\)\) break; await runOne\(m\); \} return; \}/);
  // and every lane is keyed by the chain its move is SIGNED on (a reserve's swap and its parts never share a nonce in parallel)
  assert.match(W, /const k = \(m\.kind === 'cold' \|\| m\.kind === 'rebalance'\) && m\.from \? m\.from : m\.chain;/);
});
