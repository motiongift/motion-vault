// motion's own bridge — the VAULT side (src/bridgeSolver.ts + the float engine's use of it).
//
// The solver is mocked here with the same pure core the real one runs (src/motionBridgeCore.ts), so the quote it signs
// and the transfer the vault signs are checked against each other exactly as in production. What this file proves:
// the vault signs ONE transfer, of the quoted amount, to the published deposit address, only after the quote's
// signature verifies against the PINNED key; a forged, tampered, expired or over-cap quote makes it sign nothing and
// fall through to Relay; a lost answer is followed, never signed again; and a Solana origin goes through motion only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import { createFloat } from '../src/floatEngine.ts';
import { createSolverBridge, SolverRefused, MOTION_BRIDGE_MAX6 } from '../src/bridgeSolver.ts';
import * as F from '../src/floatCore.ts';
import * as C from '../src/motionBridgeCore.ts';

const lc = (a) => String(a).toLowerCase();
const RH = F.FLOAT_CFG.robinhood;
const ETH_USD = 4000, SOL_USD = 100;
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const b58 = (b) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };

// ── the solver, as the vault sees it over fetch ──
function mockSolver(o = {}) {
  const seed = o.seed || Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposits = o.deposits || { robinhood: privateKeyToAccount(generatePrivateKey()).address, bsc: privateKeyToAccount(generatePrivateKey()).address, sol: b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))))) };
  const state = { quotes: new Map(), fills: [], calls: [], pub, seed, deposits, on: o.on !== false, refuse: o.refuse || null, prices: { robinhood: BigInt(ETH_USD) * C.USD6, bsc: 700n * C.USD6, sol: BigInt(SOL_USD) * C.USD6 } };
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  state.fetch = async (url, init) => {
    state.calls.push(String(url));
    const path = String(url).split('/api/bridge/motion')[1] || '';
    if (path.startsWith('/health')) return json({ ok: true, on: state.on, solver: pub, chains: o.chains || ['robinhood', 'bsc', 'sol'], deposits, maxFillUsd: o.maxFillUsd ?? 250, minFillUsd: 2, feeBps: 0 });
    if (path.startsWith('/gas')) {
      const b = JSON.parse(init?.body || '{}'); state.gas = [...(state.gas || []), b];
      if (o.gasRefuse) return json({ ok: false, reason: o.gasRefuse });
      if (o.onGas) o.onGas(b);
      return json({ ok: true, state: 'sent', hash: '0xgas' });
    }
    if (path.startsWith('/quote')) {
      if (!state.on) return json({ ok: false, reason: 'off' });
      if (state.refuse) return json({ ok: false, reason: state.refuse });
      const b = JSON.parse(init.body);
      const fc = C.bridgeCfg(b.from), tc = C.bridgeCfg(b.to);
      const usd6 = C.stableToUsd6(BigInt(b.amount), fc.stable.decimals);
      const { out, fee6 } = C.quoteOut(usd6, state.prices[b.to], b.to, 0);
      const at = o.now ? o.now() : Date.now();
      let q = {
        v: 1, id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
        src: { chain: b.from, token: fc.stable.address, amount: String(b.amount), depositor: b.depositor, deposit: deposits[b.from] },
        dst: { chain: b.to, recipient: o.payTo || b.recipient, amount: String(o.shortPay ? out / 2n : out) },
        price6: String(state.prices[b.to]), fee6: String(fee6), usd6: String(usd6), issuedAt: at, expiresAt: at + (o.ttlMs ?? 45_000), solver: o.claimKey || pub,
      };
      if (o.patch) q = o.patch(q);
      const sig = C.signQuote(q, o.signWith || seed);
      state.quotes.set(q.id, q);
      return json({ ok: true, quote: q, sig, etaMs: 1200 });
    }
    if (path.startsWith('/fill')) {
      const b = JSON.parse(init.body);
      const q = state.quotes.get(b.id);
      if (o.fillRefusal && (!o.fillRefusalFrom || q?.src.chain === o.fillRefusalFrom)) return { ok: false, status: o.fillRefusalStatus ?? 409, json: async () => ({ ok: false, ...o.fillRefusal }) };
      if (!q) return json({ ok: false, error: 'unknown quote', sent: false });
      if (o.fillThrows) throw new Error('network down');
      if (C.bridgeCfg(q.src.chain).kind === 'evm') {
        const tx = parseTransaction(b.raw); const from = await recoverTransactionAddress({ serializedTransaction: b.raw });
        const why = C.evmSourceProblem(tx, from, q);
        if (why) return json({ ok: false, state: 'failed', error: why });
        state.fills.push({ id: q.id, from, raw: b.raw, hash: keccak256(b.raw), quote: q });
      } else {
        state.fills.push({ id: q.id, raw: b.raw, quote: q });
      }
      if (o.fillState && o.fillState !== 'filled') return json({ ok: false, state: o.fillState, error: o.fillError || 'refunded', srcHash: '0xsrc' });
      return json({ ok: true, state: 'filled', srcHash: state.fills[state.fills.length - 1].hash || 'solsig', dstHash: '0xdst', ms: { paid: 900 } });
    }
    if (path.startsWith('/status')) return json({ ok: true, state: o.statusState || 'filled', dstHash: '0xdst' });
    throw new Error('test: unexpected motion path ' + path);
  };
  return state;
}

// ── a vault frame: one wallet (W and its reserve R), one chain's reads, and the solver's two signers ──
function makeWorld(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const solSeedW = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const solSeedR = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const sol = { W: b58(ed25519.getPublicKey(solSeedW)), R: b58(ed25519.getPublicKey(solSeedR)) };
  const solver = o.solver || mockSolver(o.solverOpts || {});
  const store = new Map(); const events = []; const relayCalls = [];
  const signedEvm = []; const signedSol = [];
  const chain = { eth: new Map([[lc(W.address), o.wEth ?? (RH.gasFloor + 20_000_000_000_000_000n)], [lc(R.address), RH.reserveGas]]), usdg: new Map([[lc(R.address), o.rUsdg ?? 2_000_000_000n]]), txs: [] };
  // the user is active (a ticket touch just now): W sends nothing on its own here (the quiet rule)
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/bridge/motion')) return solver.fetch(u, init);
    relayCalls.push(u);
    if (u.startsWith('https://api.relay.link/requests/v2')) return { ok: true, status: 200, json: async () => ({ requests: [] }) };
    if (u === 'https://api.relay.link/quote/v2') return { ok: false, status: 503, json: async () => ({ message: 'relay is down in this test' }) };
    if (u.startsWith('https://dln.debridge.finance')) return { ok: false, status: 503, json: async () => ({ errorMessage: 'deBridge is down in this test' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const deps = {
    chain: () => o.lane || 'robinhood',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W.address, sol: sol.W }, r: { evm: R.address, sol: sol.R } }; },
    evm: {
      call: async () => '0x', balance: async (a) => chain.eth.get(lc(a)) ?? 0n, erc20: async (_t, a) => chain.usdg.get(lc(a)) ?? 0n,
      allowance: async () => 0n, slot0: async () => sqrtFor(ETH_USD), fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }),
      estimate: async () => 150_000n, sendR: async () => { throw new Error('test: nothing may be broadcast by the vault here'); },
      sendW: async () => { throw new Error('test: nothing may be broadcast by the vault here'); }, receipt: async () => null,
      ...(o.evm || {}),
    },
    sol: {
      balance: async () => o.solFloat ?? 20_000_000n, usdc: async () => o.solUsdc ?? 0n, oracle6: async () => BigInt(SOL_USD) * F.USD,
      fees: async () => { throw new Error('defaults'); }, quote: async () => 0n,
      topup: async () => { throw new Error('test: no same-chain move expected'); }, sweep: async () => 'x', gas: async () => 'x', status: async () => 'confirmed',
    },
    solver: {
      base: () => 'https://motion.gift',
      pinnedKey: () => (o.pinned === undefined ? solver.pub : o.pinned),
      // the vault's real signers, in miniature: ONE ERC-20 transfer, ONE SPL transfer + memo, both signed and returned
      signEvmTransfer: async (a) => {
        const raw = await R.signTransaction({ to: a.token, data: C.erc20TransferData(a.to, a.amount), value: 0n, gas: 120_000n, gasPrice: 20_000_000n, nonce: signedEvm.length, chainId: C.bridgeCfg(a.chain).chainId, type: 'legacy' });
        signedEvm.push({ ...a, raw });
        return { raw, hash: keccak256(raw) };
      },
      signSolTransfer: async (a) => { signedSol.push(a); return { raw: 'base64-' + a.memo, sig: 'solsig' + signedSol.length }; },
      ...(o.reserveOn ? { reserveOn: o.reserveOn } : {}),
      ...(o.solReserveOn ? { solReserveOn: o.solReserveOn } : {}),
      ...(o.release ? { release: o.release } : {}),
    },
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: (d) => events.push(d), fetch: fetchFn, click: () => click, wait: async () => {},
    // (usd-mode 2026-11-05) this world rebalances into a chain never bought on: the rule of before (floatCore crossNeedsTrade)
    crossNeedsTrade: o.crossNeedsTrade ?? false,
  };
  const f = createFloat(Object.assign(deps, { readyFloat: o.readyFloat ?? true, gasFromW: o.gasFromW ?? true }));   // usd-mode2: the buffer of before unless asked
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  return { f, deps, solver, W: W.address, R: R.address, W_KEY, R_KEY, sol, store, events, relayCalls, signedEvm, signedSol, chain, click, settle };
}
// the standing permission alone: the switch-on conversion it orders is dropped (test/float-engine.mjs covers it)
const on = async (wd, caps) => { const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'], ...(caps ? { caps } : {}) }); for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k); return r; };
// the Solana frame's snapshot as that frame would have written it: the float is short and there is no USDC there
const solSnap = (wd, over = {}) => wd.store.set(`trenches.float.v1.snap.sol.${lc(wd.W)}`, JSON.stringify({ at: Date.now(), chain: 'sol', price6: String(BigInt(SOL_USD) * F.USD), priceAt: Date.now(), float: '1000000', reserve: '0', reserveNative: '10000000', inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [], ...over }));
const rhSnap = (wd, over = {}) => wd.store.set(`trenches.float.v1.snap.robinhood.${lc(wd.W)}`, JSON.stringify({ at: Date.now(), chain: 'robinhood', price6: String(BigInt(ETH_USD) * F.USD), priceAt: Date.now(), float: String(RH.gasFloor), reserve: '0', reserveNative: String(RH.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [], ...over }));

// ── the bridge client on its own ──
test('the quote must be signed by the PINNED key, pay this wallet\'s own W and beat our own oracle price', async () => {
  const s = mockSolver();
  const b = createSolverBridge({ base: () => 'https://motion.gift', fetch: s.fetch, now: () => Date.now(), pinnedKey: () => s.pub, signEvmTransfer: async () => { throw new Error('must not sign'); }, signSolTransfer: async () => { throw new Error('must not sign'); } });
  const me = privateKeyToAccount(generatePrivateKey()).address;
  const mine = b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)))));   // the destination is Solana: W there is a base58 address
  const ask = { from: 'robinhood', to: 'sol', amountIn: 100_000_000n, depositor: me, recipient: mine, oracle6: BigInt(SOL_USD) * C.USD6, maxSlipBps: 50, deposits: s.deposits };
  const q = await b.quote(ask);
  assert.equal(q.quote.dst.recipient, mine);
  assert.ok(q.out > 0n);
  // the pinned key is another one: nothing passes
  const wrong = createSolverBridge({ base: () => 'https://motion.gift', fetch: s.fetch, now: () => Date.now(), pinnedKey: () => Buffer.from(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))))).toString('hex'), signEvmTransfer: async () => { throw new Error('x'); }, signSolTransfer: async () => { throw new Error('x'); } });
  await assert.rejects(() => wrong.quote(ask), /not signed by motion's solver key/);
  // a solver that pays someone else, pays too little, or quotes a stale/eternal expiry
  for (const [opts, re] of [
    [{ payTo: b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))))) }, /pays someone else/],
    [{ shortPay: true }, /less than the oracle price/],
    [{ ttlMs: 10 * 60_000 }, /lives too long/],
    [{ signWith: Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))) }, /not signed by motion's solver key/],
  ]) {
    const bad = mockSolver({ ...opts, seed: s.seed, deposits: s.deposits });
    const bb = createSolverBridge({ base: () => 'https://motion.gift', fetch: bad.fetch, now: () => Date.now(), pinnedKey: () => s.pub, signEvmTransfer: async () => { throw new Error('must not sign'); }, signSolTransfer: async () => { throw new Error('must not sign'); } });
    await assert.rejects(() => bb.quote(ask), re, JSON.stringify(Object.keys(opts)));
  }
  // above the vault's own ceiling: not even asked
  await assert.rejects(() => b.quote({ ...ask, amountIn: 1_200_000_000n }), /above what motion's own bridge carries/);
});

test('a refused or off solver is a plain refusal (the caller falls through to Relay)', async () => {
  for (const opts of [{ on: false }, { refuse: 'inventory floor on the destination chain' }]) {
    const s = mockSolver(opts);
    const b = createSolverBridge({ base: () => 'https://motion.gift', fetch: s.fetch, now: () => Date.now(), pinnedKey: () => s.pub, signEvmTransfer: async () => { throw new Error('x'); }, signSolTransfer: async () => { throw new Error('x'); } });
    await assert.rejects(() => b.quote({ from: 'robinhood', to: 'sol', amountIn: 100_000_000n, depositor: privateKeyToAccount(generatePrivateKey()).address, recipient: b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))))), oracle6: BigInt(SOL_USD) * C.USD6, maxSlipBps: 50 }), SolverRefused);
  }
});

// ── the float engine using it ──
test('a BNB click with dollars only in the Robinhood reserve: the BNB frame itself signs the Robinhood transfer through motion (no Robinhood frame open; 2026-10-27)', async () => {
  const BSCC = F.FLOAT_CFG.bsc; const want = F.usd6(700); let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, BSCC.oracle); if (BSCC.oracle.nativeIsToken0 ? p < want : p > want) lo = mid + 1n; else hi = mid; }
  const wd = makeWorld({ lane: 'bsc', evm: { slot0: async () => lo, erc20: async () => 0n, balance: async (a) => (lc(a) === lc(wd.R) ? BSCC.reserveGas : BSCC.gasFloor) } });
  await on(wd);
  rhSnap(wd, { reserve: '1000000000' });   // $1,000 of USDG in the Robinhood reserve, as that frame last wrote it
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.ok(job, JSON.stringify(r));
  assert.equal(job.from, 'robinhood'); assert.equal(job.chain, 'bsc'); assert.equal(job.bridge, 'motion');
  assert.equal(wd.signedEvm.length, 1); assert.equal(wd.signedEvm[0].chain, 'robinhood');
  assert.equal(lc(wd.signedEvm[0].token), lc(RH.stable.address));
  assert.equal(wd.relayCalls.length, 0, 'no public bridge from a frame that is not the source chain');
});

test('a Solana click with dollars only in the Robinhood reserve: the Solana frame signs the Robinhood transfer through motion (2026-10-27: 15 s, no bridge)', async () => {
  const wd = makeWorld({ lane: 'sol' }); await on(wd);
  rhSnap(wd, { reserve: '1000000000' });
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.ok(job, JSON.stringify(r));
  assert.equal(job.from, 'robinhood'); assert.equal(job.chain, 'sol'); assert.equal(job.bridge, 'motion');
  assert.equal(wd.signedEvm.length, 1); assert.equal(wd.signedEvm[0].chain, 'robinhood');
  assert.equal(wd.relayCalls.length, 0);
});

test('a Solana click when the Robinhood snapshot is 20 min old (or missing): the reserve is read from Robinhood right here and bridged (2026-10-27: sol no-reserve)', async () => {
  for (const age of [20 * 60_000, null]) {
    const reads = [];
    const wd = makeWorld({ lane: 'sol', reserveOn: async (chain, token, owner) => { reads.push(chain); return chain === 'robinhood' ? { stable: 1_000_000_000n, native: RH.reserveGas } : { stable: 0n, native: 0n }; } });
    await on(wd);
    if (age) rhSnap(wd, { at: Date.now() - age, priceAt: Date.now() - age, reserve: '0' }); else wd.store.delete('trenches.float.v1.snap.robinhood.' + lc(wd.W));
    const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' }); await wd.settle();
    assert.ok(reads.includes('robinhood'), 'read Robinhood here');
    const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.ok(job, String(age) + ' ' + JSON.stringify(r));
    assert.equal(job.from, 'robinhood'); assert.equal(job.bridge, 'motion'); assert.equal(wd.signedEvm.length, 1);
  }
});

test('a click whose only dollars sit in a reserve with NO gas: motion drops it gas, then bridges (2026-10-27: no buy without native)', async () => {
  const BSCC = F.FLOAT_CFG.bsc; const want = F.usd6(700); let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, BSCC.oracle); if (BSCC.oracle.nativeIsToken0 ? p < want : p > want) lo = mid + 1n; else hi = mid; }
  for (const hasGas of [false, true]) {
    let rhGas = hasGas ? RH.reserveGas : 0n;
    const solver = mockSolver({ onGas: (b) => { if (b.chain === 'robinhood') rhGas = RH.reserveGas; } });
    const wd = makeWorld({ lane: 'bsc', solver, evm: { slot0: async () => lo, erc20: async () => 0n, balance: async (a) => (lc(a) === lc(wd.R) ? BSCC.reserveGas : BSCC.gasFloor) },
      reserveOn: async (chain) => (chain === 'robinhood' ? { stable: 1_000_000_000n, native: rhGas } : { stable: 0n, native: 0n }) });
    await on(wd);
    rhSnap(wd, { reserve: '1000000000', reserveNative: String(rhGas), float: '0' });   // $1,000 of USDG, with or without ETH, fresh
    await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
    const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    if (!hasGas) {
      assert.deepEqual((solver.gas || []).map((g) => g.chain), ['robinhood'], 'gas asked for the Robinhood reserve');
      assert.equal(lc(solver.gas[0].address), lc(wd.R));
    } else assert.equal((solver.gas || []).length, 0, 'a reserve with gas asks for none');
    assert.ok(job, 'bridged'); assert.equal(job.from, 'robinhood'); assert.equal(wd.signedEvm.length, 1);
  }
});

test('a cold top-up goes through motion: ONE signed transfer of the quoted amount to the published deposit address, and no Relay call', async () => {
  const wd = makeWorld(); await on(wd);
  solSnap(wd);
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' });
  await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.ok(job, JSON.stringify(r));
  assert.equal(job.bridge, 'motion');
  assert.equal(job.state, 'arrived');
  assert.equal(wd.signedEvm.length, 1, 'exactly one signature');
  const one = wd.signedEvm[0];
  assert.equal(lc(one.token), lc(RH.stable.address));
  assert.equal(lc(one.to), lc(wd.solver.deposits.robinhood));
  assert.equal(one.amount, F.usd6ToStable(BigInt(job.usd6), 6));
  // the bytes themselves: a plain ERC-20 transfer from R, nothing else
  const tx = parseTransaction(one.raw);
  const dec = C.decodeErc20Transfer(tx.data);
  assert.equal(lc(dec.to), lc(wd.solver.deposits.robinhood));
  assert.equal(dec.amount, one.amount);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: one.raw }), wd.R);
  assert.equal(wd.relayCalls.length, 0, 'Relay was not even asked');
  assert.ok(wd.solver.fills.length === 1);
  assert.ok(wd.events.some((e) => e.bridge === 'motion' && e.state === 'done'));
  const blob = JSON.stringify([...wd.store.values()]) + JSON.stringify(wd.events) + JSON.stringify((await wd.f.jobs({ walletId: 'w1' })).jobs);
  for (const k of [wd.W_KEY, wd.R_KEY]) assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked');
});

test('motion refuses → the vault signs nothing for it and falls through to the public bridges', async () => {
  const wd = makeWorld({ solverOpts: { on: false } }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(wd.signedEvm.length, 0, 'nothing signed for a solver that is off');
  assert.deepEqual(job.tried, ['motion', 'relay', 'debridge']);
  assert.match(job.error, /motion: the solver is off/);
  assert.ok(wd.relayCalls.some((u) => u.includes('api.relay.link/quote')), 'Relay was asked after motion refused');
});

test('a tampered quote from the solver: the vault signs nothing and says why', async () => {
  const attacker = privateKeyToAccount(generatePrivateKey()).address;
  const attackerSol = b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)))));
  for (const [opts, re] of [
    [{ payTo: attackerSol }, /pays someone else/],
    [{ shortPay: true }, /less than the oracle price/],
    [{ patch: (q) => ({ ...q, src: { ...q.src, deposit: attacker } }) }, /unpublished deposit address/],
    [{ patch: (q) => ({ ...q, src: { ...q.src, amount: String(BigInt(q.src.amount) * 2n) } }) }, /another amount/],
  ]) {
    const wd = makeWorld({ solverOpts: opts }); await on(wd);
    solSnap(wd);
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
    const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.equal(wd.signedEvm.length, 0, 'nothing signed: ' + JSON.stringify(Object.keys(opts)));
    assert.match(job.error, re);
  }
});

test('the solver answers "refunded" or "failed": the job says so and nothing is signed twice', async () => {
  for (const [state, re] of [['refunded', /sent back|refund/i], ['failed', /reverted|did not/i]]) {
    const wd = makeWorld({ solverOpts: { fillState: state, fillError: state === 'refunded' ? 'motion could not pay; your funds were sent back' : 'the source transfer reverted' } });
    await on(wd); solSnap(wd);
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
    const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.equal(wd.signedEvm.length, 1);
    assert.equal(job.state, state === 'refunded' ? 'refunded' : 'failed');
    assert.match(job.error || '', re);
  }
});

test('a lost answer to /fill: the transfer is followed by its hash, never signed again', async () => {
  const wd = makeWorld({ solverOpts: { fillThrows: true, statusState: 'filled' } }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
  let job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'relaying');
  assert.equal(job.bridge, 'motion');
  assert.equal(job.hashes.length, 1);
  assert.equal(wd.signedEvm.length, 1);
  // the next tick asks the solver's status route and closes the job — with no second signature
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'arrived');
  assert.equal(wd.signedEvm.length, 1, 'one signature for one need');
});

test('the solver\'s own status drives refunded / failed on a followed job', async () => {
  for (const [st, want] of [['refunded', 'refunded'], ['failed', 'failed'], ['expired', 'failed']]) {
    const wd = makeWorld({ solverOpts: { fillThrows: true, statusState: st } }); await on(wd);
    solSnap(wd);
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
    const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.equal(job.state, want, st);
  }
});

test('a Solana origin: motion signs one SPL transfer with the quote id in its memo (the public bridges still refuse it)', async () => {
  const wd = makeWorld({ lane: 'sol', solUsdc: 500_000_000n, solFloat: 20_000_000n }); await on(wd);
  rhSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 120, reason: 'click' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.ok(job, JSON.stringify((await wd.f.jobs({ walletId: 'w1' })).jobs));
  assert.equal(job.from, 'sol'); assert.equal(job.chain, 'robinhood');
  assert.equal(job.bridge, 'motion'); assert.equal(job.state, 'arrived');
  assert.equal(wd.signedSol.length, 1);
  assert.equal(wd.signedSol[0].to, wd.solver.deposits.sol);
  assert.equal(wd.signedSol[0].memo, job.requestId);
  assert.equal(wd.signedSol[0].decimals, 6);
  assert.equal(wd.relayCalls.length, 0);

  // with motion off, a Solana origin is refused outright, as before (Relay's Solana bytes are still unreviewed)
  const off = makeWorld({ lane: 'sol', solUsdc: 500_000_000n, solFloat: 20_000_000n, solverOpts: { on: false } }); await on(off);
  rhSnap(off);
  await off.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 120, reason: 'click' }); await off.settle();
  const j2 = (await off.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(j2.state, 'failed');
  assert.match(j2.error, /not signed through a public bridge yet/);
  assert.equal(off.signedSol.length, 0);
});

test('with no pinned key the motion bridge does not exist: every move takes Relay', async () => {
  const wd = makeWorld({ pinned: '' }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.deepEqual(job.tried, ['relay', 'debridge']);
  assert.equal(wd.solver.calls.length, 0, 'the solver was never even asked');
  assert.equal(wd.signedEvm.length, 0);
});

test('a rebalance between reserves never goes through motion (it is not the move anyone waits for)', async () => {
  const wd = makeWorld(); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();   // no click: a rebalance, not a cold top-up
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  const reb = jobs.find((j) => j.kind === 'rebalance');
  assert.ok(reb, JSON.stringify(jobs));
  assert.notEqual(reb.bridge, 'motion');
  assert.equal(wd.signedEvm.length, 0);
  assert.ok(!wd.solver.calls.some((u) => u.includes('/quote')), 'motion was not quoted for a rebalance');
});

test('the vault\'s own ceiling holds even if the solver offers more: a $900 click goes in parts under it, each its own fill (2026-11-01 pass 2: before, ONE $1,125 move was refused whole)', async () => {
  const wd = makeWorld({ solverOpts: { maxFillUsd: 5000 }, rUsdg: 2_000_000_000n }); await on(wd, { perDay: 2000, perChain: 400, total: 800 });
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 900, reason: 'click' }); await wd.settle();
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'cold');
  assert.ok(jobs.length >= 2, 'in parts: ' + JSON.stringify(jobs.map((j) => j.usd6)));
  for (const j of jobs) { assert.ok(BigInt(j.usd6) <= MOTION_BRIDGE_MAX6, 'no part above what motion carries: ' + j.usd6); assert.equal(j.bridge, 'motion'); assert.equal(j.state, 'arrived'); }
  assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length, 'each part its own job');
  assert.ok(jobs.reduce((t, j) => t + BigInt(j.usd6), 0n) >= F.usd6(1125), 'the need + 25 % in all');
  assert.equal(wd.signedEvm.length, jobs.length, 'one signed transfer per part');
  for (const t of wd.signedEvm) assert.ok(C.stableToUsd6(t.amount, RH.stable.decimals) <= MOTION_BRIDGE_MAX6);
  assert.ok(!wd.relayCalls.some((u) => u.includes('api.relay.link/quote')), 'no public bridge');
});

test('a refusal that never reached a broadcast falls through to Relay; one that may have is followed, never re-signed', async () => {
  // the solver refuses the fill itself and says nothing was broadcast
  const sent0 = makeWorld({ solverOpts: { fillRefusal: { error: 'that quote was lost in a restart; nothing was broadcast', sent: false } } });
  await on(sent0); solSnap(sent0);
  await sent0.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await sent0.settle();
  const a = (await sent0.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(sent0.signedEvm.length, 1, 'the transfer was signed before the refusal');
  assert.deepEqual(a.tried, ['motion', 'relay', 'debridge'], 'and the public bridges were tried after it');
  assert.match(a.error, /nothing was broadcast/);
  // the same refusal WITHOUT that flag: the bytes may be out there, so the job follows them and signs nothing more
  const unknown = makeWorld({ solverOpts: { fillRefusal: { error: 'the node did not answer' } }, });
  await on(unknown); solSnap(unknown);
  await unknown.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await unknown.settle();
  const b = (await unknown.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(unknown.signedEvm.length, 1);
  assert.equal(b.state, 'relaying');
  assert.equal(b.bridge, 'motion');
  assert.ok(!(b.tried || []).includes('relay'), 'a possibly-broadcast transfer must not start a second move');
});

// ── the Solana reserve as a donor of an EVM click (2026-10-27: "a Solana reserve cannot yet be a cross-frame bridge donor") ──
// a BNB frame (the oracle pool's slot0 priced at $700), with no dollars on BNB, and the account's other reserves as given
function bnbFrame(o = {}) {
  const BSCC = F.FLOAT_CFG.bsc; const want = F.usd6(700); let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, BSCC.oracle); if (BSCC.oracle.nativeIsToken0 ? p < want : p > want) lo = mid + 1n; else hi = mid; }
  const solReads = [];
  const wd = makeWorld({ lane: 'bsc', ...o, evm: { slot0: async () => lo, erc20: async () => 0n, balance: async (a) => (lc(a) === lc(wd.R) ? BSCC.reserveGas : BSCC.gasFloor) },
    ...(o.solReserve === undefined ? {} : { solReserveOn: async (owner) => { solReads.push(owner); if (o.solReserve instanceof Error) throw o.solReserve; return o.solReserve; } }) });
  return Object.assign(wd, { solReads });
}
const coldJobs = async (wd) => (await wd.f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'cold');

test('a BNB click with dollars only in the Solana reserve: the BNB frame signs ONE SPL transfer for motion (quote id in the memo), no public bridge', async () => {
  const wd = bnbFrame({ solReserve: { stable: 0n, native: 0n } }); await on(wd);
  solSnap(wd, { reserve: '500000000', reserveNative: '10000000' });   // $500 of USDC + 0.01 SOL, as the Solana frame wrote it seconds ago
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  const [job, ...more] = await coldJobs(wd);
  assert.ok(job, JSON.stringify(r)); assert.equal(more.length, 0);
  assert.equal(job.from, 'sol'); assert.equal(job.chain, 'bsc'); assert.equal(job.bridge, 'motion'); assert.equal(job.state, 'arrived');
  assert.equal(job.usd6, String(F.usd6(150)), 'need + 25 %');
  assert.equal(wd.signedSol.length, 1); assert.equal(wd.signedEvm.length, 0);
  const one = wd.signedSol[0];
  assert.equal(one.to, wd.solver.deposits.sol); assert.equal(one.mint, F.FLOAT_CFG.sol.stable.address); assert.equal(one.decimals, 6);
  assert.equal(one.amount, 150_000_000n); assert.equal(one.memo, job.requestId);
  assert.equal(wd.solver.fills.length, 1); assert.equal(wd.solver.fills[0].quote.src.depositor, wd.sol.R); assert.equal(wd.solver.fills[0].quote.dst.recipient, wd.W);
  assert.deepEqual(wd.solReads, [], 'a fresh Solana snapshot is not read again');
  assert.equal(wd.relayCalls.length, 0, 'a Solana origin never goes to a public bridge');
});

test('the Solana snapshot is old or missing: the BNB frame reads R on Solana itself (one read), then bridges from it', async () => {
  for (const age of [20 * 60_000, null]) {
    const wd = bnbFrame({ solReserve: { stable: 400_000_000n, native: 10_000_000n } }); await on(wd);
    if (age) solSnap(wd, { at: Date.now() - age, priceAt: Date.now() - age, reserve: '0' }); else wd.store.delete('trenches.float.v1.snap.sol.' + lc(wd.W));
    await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
    assert.deepEqual(wd.solReads, [wd.sol.R], String(age));
    const [job] = await coldJobs(wd);
    assert.ok(job, String(age)); assert.equal(job.from, 'sol'); assert.equal(job.state, 'arrived'); assert.equal(wd.signedSol.length, 1);
  }
});

test('a click the EVM reserves cover reads nothing on Solana and plans exactly as before', async () => {
  const wd = bnbFrame({ solReserve: { stable: 900_000_000n, native: 10_000_000n } }); await on(wd);
  rhSnap(wd, { reserve: '1000000000' }); solSnap(wd, { at: Date.now() - 20 * 60_000, reserve: '900000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  const jobs = await coldJobs(wd);
  assert.deepEqual(jobs.map((j) => j.from), ['robinhood']);
  assert.deepEqual(wd.solReads, [], 'no Solana read');
  assert.equal(wd.signedSol.length, 0); assert.equal(wd.signedEvm.length, 1);
});

test('the EVM reserves are short: Solana covers the rest (or the whole need, in one fill, when it alone can)', async () => {
  // Robinhood $50, Solana $500: one fill from Solana instead of two
  const one = bnbFrame({ solReserve: { stable: 0n, native: 0n } }); await on(one);
  rhSnap(one, { reserve: '50000000' }); solSnap(one, { reserve: '500000000' });
  await one.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await one.settle();
  assert.deepEqual((await coldJobs(one)).map((j) => [j.from, j.usd6]), [['sol', String(F.usd6(150))]]);
  assert.equal(one.signedEvm.length, 0); assert.equal(one.signedSol.length, 1);
  // Robinhood $50, Solana $60: both, the EVM reserve first
  // (PROPOSAL TC-1, 2026-11-04: was a $120 click — $110 of reserves could never pay it, yet both were moved and the page waited its
  // 15 s; now a $100 click, which they do pay; the $120 one moves nothing and says what it can pay)
  const two = bnbFrame({ solReserve: { stable: 0n, native: 0n } }); await on(two);
  rhSnap(two, { reserve: '50000000' }); solSnap(two, { reserve: '60000000' });
  await two.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 100, reason: 'click' }); await two.settle();
  // (PROPOSAL TC-6: the two parts are signed side by side now — the job list's order is the order they finished in)
  assert.deepEqual((await coldJobs(two)).map((j) => [j.from, j.usd6]).sort(), [['robinhood', String(F.usd6(50))], ['sol', String(F.usd6(60))]]);
  assert.equal(two.signedEvm.length, 1); assert.equal(two.signedSol.length, 1);
  const no = bnbFrame({ solReserve: { stable: 0n, native: 0n } }); await on(no);
  rhSnap(no, { reserve: '50000000' }); solSnap(no, { reserve: '60000000' });
  const r = await no.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await no.settle();
  assert.equal((await coldJobs(no)).length, 0); assert.equal(no.signedEvm.length + no.signedSol.length, 0, 'nothing signed for a click it cannot pay');
  assert.equal(r.click.state, 'failed'); assert.equal(r.click.code, 'short'); assert.ok(r.click.short.canUsd > 108 && r.click.short.canUsd <= 110, JSON.stringify(r.click));
});

test('a Solana reserve that cannot pay its transfer fee, a failed read, or a frame without the Solana read: nothing is signed for Solana (as before)', async () => {
  // R has dollars but too little SOL to stay rent-exempt after the fee, and motion refuses its gas drop: not signed for here
  const poor = bnbFrame({ solReserve: { stable: 500_000_000n, native: 898_879n }, solverOpts: { gasRefuse: 'gas already sent today' } }); await on(poor);
  poor.store.delete('trenches.float.v1.snap.sol.' + lc(poor.W));
  await poor.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await poor.settle();
  assert.equal(poor.solReads.length, 1); assert.equal(poor.signedSol.length, 0); assert.equal((await coldJobs(poor)).length, 0);
  assert.equal(poor.solver.calls.filter((u) => u.includes('/quote')).length, 0, 'not even quoted');
  assert.deepEqual(poor.solver.gas, [{ chain: 'sol', address: poor.sol.R }], 'the drop was asked for, once');
  // the read fails: the old plan (no Solana snapshot = no Solana donor)
  const failed = bnbFrame({ solReserve: new Error('node down') }); await on(failed);
  failed.store.delete('trenches.float.v1.snap.sol.' + lc(failed.W));
  await failed.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await failed.settle();
  assert.equal(failed.solReads.length, 1); assert.equal(failed.signedSol.length, 0); assert.equal((await coldJobs(failed)).length, 0);
  // an older host / the Solana frame's own deps (no solReserveOn): a Solana donor is planned but never signed in this frame
  const old = bnbFrame(); await on(old);
  solSnap(old, { reserve: '500000000' });
  await old.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await old.settle();
  assert.equal(old.signedSol.length, 0); assert.equal((await coldJobs(old)).length, 0);
});

test('a Solana donor keeps the bridge rules: a lost answer is followed, never re-signed; a second click signs nothing new', async () => {
  const wd = bnbFrame({ solReserve: { stable: 500_000_000n, native: 10_000_000n }, solverOpts: { fillThrows: true, statusState: 'filled' } }); await on(wd);
  solSnap(wd, { reserve: '500000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  let [job] = await coldJobs(wd);
  assert.equal(job.state, 'relaying'); assert.equal(job.bridge, 'motion'); assert.deepEqual(job.hashes, ['solsig1']);
  // a second click while it is in flight: the open move blocks a second one to this chain
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedSol.length, 1, 'one signature for one need');
  [job] = await coldJobs(wd);
  assert.equal(job.state, 'arrived', 'the solver status closed it');
  assert.equal(wd.relayCalls.length, 0);
});

test('a cross-chain move that arrived under 10 s ago still holds its lane (the payout may not show yet: the click waits for it); later, a new click of the same minute bridges again (2026-11-01: it was skipped until the next minute)', async () => {
  const wd = bnbFrame({ solReserve: { stable: 500_000_000n, native: 10_000_000n }, solverOpts: { fillThrows: true, statusState: 'filled' } }); await on(wd);
  solSnap(wd, { reserve: '500000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  const b = await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  let [job] = await coldJobs(wd);
  assert.equal(job.state, 'arrived'); assert.equal(wd.signedSol.length, 1, 'not bridged twice while the payout may still be on its way');
  assert.equal(b.click.state, 'moving', 'the click waits for the landing payout: ' + JSON.stringify(b.click));
  assert.equal(b.planned.find((m) => m.kind === 'cold').skipped, 'held');
  // 11 s later (same calendar minute): the payout was spent by the first buy, the next click bridges its own need
  const key = [...wd.store.keys()].find((k) => k.startsWith('trenches.float.v1.jobs.bsc.'));
  const jobs = JSON.parse(wd.store.get(key)); for (const j of jobs) { j.updatedAt -= 11_000; j.at -= 11_000; } wd.store.set(key, JSON.stringify(jobs));
  solSnap(wd, { reserve: '500000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedSol.length, 2, 'a new move of the lane: the first one keeps its own job');
  assert.equal((await coldJobs(wd)).length, 2);
});

test('a Solana donor the solver refuses (nothing broadcast) fails without a public bridge; above $1,000 it is not even signed', async () => {
  const no = bnbFrame({ solReserve: { stable: 0n, native: 0n }, solverOpts: { fillRefusal: { error: 'the transfer does not simulate', sent: false } } }); await on(no);
  solSnap(no, { reserve: '500000000' });
  await no.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await no.settle();
  const [a] = await coldJobs(no);
  assert.equal(a.state, 'failed'); assert.match(a.error, /nothing was broadcast/); assert.equal(no.signedSol.length, 1); assert.equal(no.relayCalls.length, 0);
  // a $1,000 click (2026-11-01 pass 2): its $1,250 goes as parts under the ceiling, never one transfer above it
  const big = bnbFrame({ solReserve: { stable: 0n, native: 0n }, solverOpts: { maxFillUsd: 5000 } }); await on(big);
  solSnap(big, { reserve: '3000000000' });
  await big.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 1000, reason: 'click' }); await big.settle();
  const parts = await coldJobs(big);
  assert.ok(parts.length >= 2, JSON.stringify(parts.map((j) => [j.usd6, j.state, j.error])));
  for (const b of parts) assert.ok(BigInt(b.usd6) <= MOTION_BRIDGE_MAX6);
  assert.equal(big.signedSol.length, parts.length);
  for (const t of big.signedSol) assert.ok(t.amount <= 1_000_000_000n, 'no SPL transfer above $1,000');
});

test('the vault\'s Solana bridge bytes (solBridgeTransferIxs, signed as webEngine signs them) pass the solver\'s own check, and their fee is what solBridgeFeeOk counts', async () => {
  const S = await import('../src/solEngine.ts');
  const L = await import('../src/solLimitCore.ts');
  const { solBridgeTransferIxs } = await import('../src/bridgeSolver.ts');
  const seed = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const owner = S.b58e(ed25519.getPublicKey(seed));
  const deposit = b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)))));
  const mint = F.FLOAT_CFG.sol.stable.address;
  const q = { v: 1, id: 'ab'.repeat(16), src: { chain: 'sol', token: mint, amount: '150000000', depositor: owner, deposit }, dst: { chain: 'bsc', recipient: '0x' + '11'.repeat(20), amount: '1' } };
  const ixs = solBridgeTransferIxs({ owner, src: S.ataOf(owner, mint), dst: S.ataOf(deposit, mint), mint, amount: 150_000_000n, decimals: 6, memo: q.id, units: F.SOL_BRIDGE.units, micro: BigInt(F.SOL_BRIDGE.micro) });
  const blockhash = b58(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32))));
  const { tx, sig } = S.signMessage(S.compileLegacy(owner, ixs, blockhash), seed);
  assert.ok(tx.length <= 1232);
  const parsed = L.parseLegacyTx(tx);
  assert.equal(C.solSourceProblem(parsed, q, (o, m) => L.ataAddress(o, m, L.SP.token)), '');
  assert.ok(ed25519.verify(parsed.sigs[0], parsed.message, L.b58d(owner)), 'signed by R');
  assert.equal(S.b58e(sig), S.b58e(parsed.sigs[0]));
  // one signature (5 000 lamports) + 60 000 CU at 50 000 µlamports (3 000 lamports): R pays 8 000 and keeps its rent
  const budget = parsed.ixs.filter((x) => x.program === C.SOL_PROGRAMS.budget).map((x) => x.data);
  assert.equal(new DataView(budget[0].buffer, budget[0].byteOffset).getUint32(1, true), 60_000);
  assert.equal(new DataView(budget[1].buffer, budget[1].byteOffset).getBigUint64(1, true), 50_000n);
  assert.equal(F.solFwdFee(F.SOL_BRIDGE.units, F.SOL_BRIDGE.micro), 8_000n);
  // the same builder with another amount, another payee or a missing memo is refused by the solver
  const other = b58(ed25519.getPublicKey(Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)))));
  for (const [over, re] of [[{ amount: 150_000_001n }, /another amount/], [{ dst: S.ataOf(other, mint) }, /pays another account/], [{ memo: 'cd'.repeat(16) }, /memo/]]) {
    const bad = solBridgeTransferIxs({ owner, src: S.ataOf(owner, mint), dst: S.ataOf(deposit, mint), mint, amount: 150_000_000n, decimals: 6, memo: q.id, units: 60_000, micro: 50_000n, ...over });
    assert.match(C.solSourceProblem(L.parseLegacyTx(S.signMessage(S.compileLegacy(owner, bad, blockhash), seed).tx), q, (o, m) => L.ataAddress(o, m, L.SP.token)), re);
  }
});

test('the EVM frame\'s Solana reserve read: one getMultipleAccounts, behind a running trade, never the background bucket; only EVM frames get it', () => {
  const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const i = WE.indexOf('async function bridgeSolReserveOn('); assert.ok(i > 0);
  const body = WE.slice(i, WE.indexOf('\n}\n', i));
  assert.match(body, /while \(tradeRunning\(\)\) await floatWait\(100\);/);
  assert.match(body, /solFloatRpc<any>\('getMultipleAccounts', \[\[owner, solFloatAta\(owner, FLOAT_CFG\.sol\.stable\.address\)\]/);
  assert.ok(!/floatBucket|floatQuiet|floatRpc\(|sendTransaction|solFloatSend/.test(body));
  assert.match(WE, /\.\.\.\(SOL_MODE \|\| NEAR_MODE \? \{\} : \{ solReserveOn: bridgeSolReserveOn \}\),/);
});

// ── the Solana gas drop (2026-10-27, owner: "do it too": a Solana reserve under ~0.0009 SOL could not pay fees or donate) ──
// a Solana frame: W and R each with their own lamports; R holds $300 of USDC; motion's drop lands in R when `lands`
function solFrame(o = {}) {
  const lam = new Map();
  const wd = makeWorld({ lane: 'sol', ...o, solverOpts: { ...(o.solverOpts || {}), onGas: (b) => { if (o.lands !== false) lam.set(b.address, (lam.get(b.address) ?? 0n) + F.SOL_GAS.drop); } } });
  lam.set(wd.sol.W, o.wLam ?? 0n); lam.set(wd.sol.R, o.rLam ?? 0n);
  wd.deps.sol.balance = async (a) => lam.get(a) ?? 0n;
  wd.deps.sol.usdc = async (a) => (a === wd.sol.R ? (o.rUsdc ?? 300_000_000n) : 0n);
  return Object.assign(wd, { lam });
}
const solClick = (wd) => wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' });
const quiet = (wd) => { Object.assign(wd.click, { ticketAt: 0, lastTradeAt: 0, focusChain: null }); };

test('Solana gas drop, Solana frame: a click whose reserve holds dollars but no SOL (and W none to spare) gets the drop, then R tops W up itself', async () => {
  const wd = solFrame(); await on(wd);
  const r = await solClick(wd); await wd.settle();
  assert.deepEqual(wd.solver.gas, [{ chain: 'sol', address: wd.sol.R }], 'the drop is asked for R on Solana');
  assert.equal(wd.lam.get(wd.sol.R), 3_000_000n);
  assert.ok(r.planned.some((m) => m.kind === 'topup' && m.chain === 'sol'), 'R swaps for the click: ' + JSON.stringify(r));
  assert.ok(!(r.skipped || []).some((s) => s.chain === 'sol' && s.why === 'no-gas'));
  assert.ok(!r.planned.some((m) => m.kind === 'gas'), 'no W → R gas move (W has none)');
});

test('Solana gas drop, Solana frame: refused, or sent but not landed → the click plans exactly as before (no-gas)', async () => {
  for (const o of [{ solverOpts: { gasRefuse: 'busy, try later' } }, { lands: false }]) {
    const wd = solFrame(o); await on(wd);
    const r = await solClick(wd); await wd.settle();
    assert.equal(wd.solver.gas.length, 1, 'asked once');
    assert.equal(wd.lam.get(wd.sol.R), 0n);
    assert.ok(r.skipped.some((s) => s.chain === 'sol' && s.why === 'no-gas'), JSON.stringify(r));
    assert.ok(!r.planned.some((m) => m.kind === 'topup'), 'R cannot pay a swap: none planned, as before');
  }
});

test('Solana gas drop, Solana frame: asked only when needed — not with SOL in R, not with W able to spare it, not under $2, not without a solver', async () => {
  // R already holds what its moves cost (2 100 000): no ask, and R swaps itself even though W has nothing to spare
  const enough = solFrame({ rLam: F.SOL_GAS.enough }); await on(enough);
  const r1 = await solClick(enough); await enough.settle();
  assert.equal((enough.solver.gas || []).length, 0);
  assert.ok(r1.planned.some((m) => m.kind === 'topup' && m.chain === 'sol'), JSON.stringify(r1));
  // W can spare R's gas: the old W → R gas move, no drop
  const rich = solFrame({ wLam: 100_000_000n }); await on(rich);
  const r2 = await solClick(rich); await rich.settle();
  assert.equal((rich.solver.gas || []).length, 0);
  assert.ok(r2.planned.some((m) => m.kind === 'gas' && m.chain === 'sol'), JSON.stringify(r2));
  // under $2 in R: nothing to move, nothing asked
  const poor = solFrame({ rUsdc: 1_999_999n }); await on(poor);
  await solClick(poor); await poor.settle();
  assert.equal((poor.solver.gas || []).length, 0);
  // no pinned solver key in this build: no drop, as before
  const none = solFrame({ pinned: '' }); await on(none);
  await solClick(none); await none.settle();
  assert.equal((none.solver.gas || []).length, 0);
});

test('Solana gas drop, background tick: asked once without waiting (the next tick has gas); not again the same day; again 10 min after a refusal', async () => {
  let t = Date.now();
  const wd = solFrame({ lands: false }); await on(wd);
  wd.deps.now = () => t; quiet(wd);
  await wd.f.sweep({ walletId: 'w1', chain: 'sol' }); await wd.settle();
  assert.deepEqual(wd.solver.gas, [{ chain: 'sol', address: wd.sol.R }]);
  t += 60 * 60_000; await wd.f.sweep({ walletId: 'w1', chain: 'sol' }); await wd.settle();
  assert.equal(wd.solver.gas.length, 1, 'an hour later: still the one ask of the day');
  t += 24 * 60 * 60_000; await wd.f.sweep({ walletId: 'w1', chain: 'sol' }); await wd.settle();
  assert.equal(wd.solver.gas.length, 2, 'the next day: asked again');
  // a refusal is asked again after 10 minutes, not before
  const no = solFrame({ solverOpts: { gasRefuse: 'busy, try later' } }); await on(no);
  no.deps.now = () => t; quiet(no);
  await no.f.sweep({ walletId: 'w1', chain: 'sol' }); await no.settle();
  t += 5 * 60_000; await no.f.sweep({ walletId: 'w1', chain: 'sol' }); await no.settle();
  assert.equal(no.solver.gas.length, 1);
  t += 6 * 60_000; await no.f.sweep({ walletId: 'w1', chain: 'sol' }); await no.settle();
  assert.equal(no.solver.gas.length, 2);
  // not while the user is trading (the quiet rule), and not for a reserve with SOL
  const busy = solFrame(); await on(busy); busy.deps.now = () => t; Object.assign(busy.click, { ticketAt: t, lastTradeAt: t });
  await busy.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'lane' }); await busy.settle();
  assert.equal((busy.solver.gas || []).length, 0, 'a ticket was just touched');
  const has = solFrame({ rLam: 10_000_000n }); await on(has); has.deps.now = () => t; quiet(has);
  await has.f.sweep({ walletId: 'w1', chain: 'sol' }); await has.settle();
  assert.equal((has.solver.gas || []).length, 0);
});

test('Solana gas drop, EVM frame: a click the EVM reserves leave short gets the drop for the Solana reserve, then signs its ONE transfer', async () => {
  const solReserve = { stable: 500_000_000n, native: 0n };
  const wd = bnbFrame({ solReserve, solverOpts: { onGas: (b) => { if (b.chain === 'sol') solReserve.native += F.SOL_GAS.drop; } } }); await on(wd);
  wd.store.delete('trenches.float.v1.snap.sol.' + lc(wd.W));
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.deepEqual(wd.solver.gas, [{ chain: 'sol', address: wd.sol.R }]);
  const [job, ...more] = await coldJobs(wd);
  assert.ok(job); assert.equal(more.length, 0);
  assert.equal(job.from, 'sol'); assert.equal(job.state, 'arrived'); assert.equal(wd.signedSol.length, 1);
  assert.ok(wd.solReads.length >= 2 && wd.solReads.length <= 4, 'read, polled once, read again: ' + wd.solReads.length);
});

test('Solana gas drop, EVM frame: not asked for a click the EVM reserves cover, nor for a Solana reserve that can pay its fee; a drop that never lands leaves the old answer', async () => {
  const covered = bnbFrame({ solReserve: { stable: 900_000_000n, native: 0n } }); await on(covered);
  rhSnap(covered, { reserve: '1000000000' }); covered.store.delete('trenches.float.v1.snap.sol.' + lc(covered.W));
  await covered.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await covered.settle();
  assert.deepEqual(covered.solReads, []); assert.equal((covered.solver.gas || []).length, 0);
  const paid = bnbFrame({ solReserve: { stable: 500_000_000n, native: 898_880n } }); await on(paid);
  paid.store.delete('trenches.float.v1.snap.sol.' + lc(paid.W));
  await paid.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await paid.settle();
  assert.equal((paid.solver.gas || []).length, 0, 'R can pay its one transfer: nothing asked');
  assert.equal(paid.signedSol.length, 1);
  const lost = bnbFrame({ solReserve: { stable: 500_000_000n, native: 0n } }); await on(lost);   // the mock answers 'sent' but nothing arrives
  lost.store.delete('trenches.float.v1.snap.sol.' + lc(lost.W));
  await lost.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await lost.settle();
  assert.equal(lost.solver.gas.length, 1); assert.equal(lost.signedSol.length, 0); assert.equal((await coldJobs(lost)).length, 0);
  assert.equal(lost.solReads.length, 21, 'one read, twenty 0.25 s looks (the same 5 s), then the plan as before');
  // a Solana reserve under $2: no drop is worth it
  const tiny = bnbFrame({ solReserve: { stable: 1_000_000n, native: 0n } }); await on(tiny);
  rhSnap(tiny, { reserve: '50000000' }); tiny.store.delete('trenches.float.v1.snap.sol.' + lc(tiny.W));
  await tiny.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await tiny.settle();
  assert.equal((tiny.solver.gas || []).length, 0);
});

test('Solana gas drop: the numbers (the solver uses the same: server/motion-bridge.mjs SOL_GAS_HAS, MOTION_GAS_SOL_LAMPORTS) cover every move R pays itself', () => {
  const topup = F.solFwdFee(300_000, 50_000) + F.SOL_FWD.ataRent;                          // the swap's fee + its temporary wSOL rent
  const fund = F.SOL_FWD.rentMin + F.solFwdFee(F.SOL_FWD.units, F.SOL_FWD.micro) + F.solFwdFee(F.SOL_FWD.fundUnits, F.SOL_FWD.fundMicro) + F.SOL_FWD.rentMin;
  assert.equal(topup, 2_059_280n); assert.equal(fund, 1_794_810n);
  assert.ok(F.SOL_GAS.enough >= topup && F.SOL_GAS.enough >= fund && F.solBridgeFeeOk(F.SOL_GAS.enough));
  assert.ok(F.SOL_GAS.drop > F.SOL_GAS.enough, 'a reserve at 0 is above the line after one drop');
  assert.equal(F.solForwardPlan({ wLamports: 0n, rLamports: F.SOL_GAS.drop, rStable: 1n }).pay, 'r', 'after a drop R can fund W\'s forward');
  assert.equal(F.solForwardPlan({ wLamports: 0n, rLamports: 898_879n, rStable: 1n }).pay, 'none', 'before it, nobody could');
});

test('a Solana click its own reserve covers reads no other reserve (2026-10-28: both EVM reserves were read on every click, up to 2.5 s in front of the top-up); one it does not cover still reads them', async () => {
  const reads = [];
  const reserveOn = async (chain) => { reads.push(chain); return chain === 'robinhood' ? { stable: 1_000_000_000n, native: RH.reserveGas } : { stable: 0n, native: 0n }; };
  const wd = makeWorld({ lane: 'sol', reserveOn, solUsdc: 300_000_000n });
  const swaps = [];
  wd.deps.sol.quote = async (dir, amountIn) => (amountIn * 1000n * 999n) / (BigInt(SOL_USD) * 1000n);
  wd.deps.sol.topup = async (id, usdcIn, minLamports) => { swaps.push({ usdcIn, minLamports }); return 'sigt' + swaps.length; };
  await on(wd);
  wd.store.delete('trenches.float.v1.snap.robinhood.' + lc(wd.W));   // no EVM snapshot at all: the old code read both reserves here
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' }); await wd.settle();
  assert.deepEqual(reads, [], 'nothing read on the EVM chains');
  assert.equal(swaps.length, 1, JSON.stringify(r));
  assert.ok(!r.planned.some((m) => m.kind === 'cold'));
  assert.equal(wd.signedEvm.length, 0);
  // the Solana reserve holds $10 of a $50 click: the other reserves are read, and the rest comes through motion
  const reads2 = [];
  const wd2 = makeWorld({ lane: 'sol', reserveOn: async (chain) => { reads2.push(chain); return reserveOn(chain); }, solUsdc: 10_000_000n });
  wd2.deps.sol.quote = wd.deps.sol.quote; wd2.deps.sol.topup = async () => 'sigt';
  await on(wd2);
  wd2.store.delete('trenches.float.v1.snap.robinhood.' + lc(wd2.W));
  const r2 = await wd2.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' }); await wd2.settle();
  assert.ok(reads2.includes('robinhood'), 'read Robinhood here');
  const job = (await wd2.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.ok(job, JSON.stringify(r2)); assert.equal(job.from, 'robinhood'); assert.equal(wd2.signedEvm.length, 1);
});

// ── 2026-10-28, the MIT buy: a Solana click, dollars in the Robinhood reserve; the solver's nodes were throttled and the fill
// died before anything was bound or broadcast. The page waited 15 s for a transfer that never left, then the buy went anyway ──
const BSC = F.FLOAT_CFG.bsc;
const bscSnap = (wd, over = {}) => wd.store.set(`trenches.float.v1.snap.bsc.${lc(wd.W)}`, JSON.stringify({ at: Date.now(), chain: 'bsc', price6: String(700n * F.USD), priceAt: Date.now(), float: String(BSC.gasFloor), reserve: '0', reserveNative: String(BSC.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [], ...over }));
const THROTTLED = { error: 'motion could not check your transfer right now (Rate Limit Hit, limit will reset in 60 seconds); nothing was broadcast', sent: false };

test('MIT case: the Robinhood fill is refused before any broadcast (sent:false) → the same click tries the BNB reserve at once, and the Robinhood nonce is freed', async () => {
  const released = [];
  const wd = makeWorld({ lane: 'sol', solverOpts: { fillRefusal: THROTTLED, fillRefusalFrom: 'robinhood', fillRefusalStatus: 503 }, release: (a) => released.push(a) });
  await on(wd);
  solSnap(wd); rhSnap(wd, { reserve: String(1_500_000_000n) }); bscSnap(wd, { reserve: String(1_000n * 10n ** 18n) });
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 15, reason: 'click' }); await wd.settle();
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'cold' && j.chain === 'sol');
  const rh = jobs.find((j) => j.from === 'robinhood'), bsc = jobs.find((j) => j.from === 'bsc');
  assert.equal(rh.state, 'failed'); assert.match(rh.error, /could not check your transfer/); assert.deepEqual(rh.hashes, []);
  assert.ok(bsc, 'the next reserve was tried in the same click: ' + JSON.stringify(r));
  assert.equal(bsc.state, 'arrived'); assert.equal(bsc.bridge, 'motion');
  assert.deepEqual(wd.signedEvm.map((x) => x.chain), ['robinhood', 'bsc']);
  assert.equal(released.length, 1); assert.equal(released[0].chain, 'robinhood'); assert.equal(released[0].hash, keccak256(wd.signedEvm[0].raw));
  assert.equal(r.click.state, 'moving');
  assert.ok(r.planned.some((m) => m.kind === 'cold' && m.from === 'bsc'), 'the answer names the move that ran');
  assert.equal(wd.relayCalls.length, 0, 'no public bridge from the Solana frame');
});

test('MIT case, no other reserve: the click answers failed at once (with why) instead of a 15 s wait; nothing is signed twice', async () => {
  const wd = makeWorld({ lane: 'sol', solverOpts: { fillRefusal: THROTTLED, fillRefusalStatus: 503 } });
  await on(wd);
  solSnap(wd); rhSnap(wd, { reserve: String(1_500_000_000n) });
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 15, reason: 'click' }); await wd.settle();
  assert.equal(r.click.state, 'failed');
  assert.match(r.click.why, /could not check your transfer/);
  assert.equal(wd.signedEvm.length, 1);
  // a second click right away: the refused donor is in its 30 s back-off, nothing new is signed, and it says so again
  const r2 = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 15, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedEvm.length, 1);
  assert.notEqual(r2.click.state, 'moving');
});

test('MIT case, the old bare 500 (no sent flag): the transfer may be out there — followed as moving, never retried from another reserve', async () => {
  const wd = makeWorld({ lane: 'sol', solverOpts: { fillRefusal: { error: 'Rate Limit Hit, limit will reset in 60 seconds' }, fillRefusalStatus: 500 } });
  await on(wd);
  solSnap(wd); rhSnap(wd, { reserve: String(1_500_000_000n) }); bscSnap(wd, { reserve: String(1_000n * 10n ** 18n) });
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 15, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedEvm.length, 1, 'never a second transfer while the first may land');
  assert.equal(r.click.state, 'moving');
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'relaying');
});

test('a click its own float covers, or a background tick: no click field, the answer is the old one', async () => {
  const wd = makeWorld({ lane: 'sol' }); await on(wd);
  solSnap(wd, { float: String(10n ** 10n) });
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 15, reason: 'click' }); await wd.settle();
  assert.equal(r.click?.state ?? 'none', 'none');
  const t = await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(t.click, undefined);
});

// ── 2026-11-01, audit pass 1: the solver no longer writes a late source off as 'failed' and no longer says 'filled' before the
// payout is seen; the vault follows those answers (never signs again) and tells the user what is happening ──
test('the solver answers "source-late": the job follows it (never failed, nothing signed again), says so, and closes on "filled"', async () => {
  const solverOpts = { fillState: 'source-late', fillError: 'your transfer has not landed yet — motion pays you as soon as it lands, or sends it back', statusState: 'source-late' };
  const wd = makeWorld({ solverOpts }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
  let job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'relaying', 'not failed: the transfer may still land');
  assert.equal(job.bridge, 'motion');
  assert.match(job.error || '', /not landed yet/);
  assert.doesNotMatch(job.error || '', /nothing was taken/);
  // the next tick: still late on the solver → still followed, still one signature
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'relaying');
  assert.match(job.error || '', /not landed yet/);
  // it landed and motion paid
  solverOpts.statusState = 'filled';
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
  assert.equal(job.state, 'arrived');
  assert.equal(wd.signedEvm.length, 1, 'one signature for one need');
});

test('the solver answers "paid" (payout out, not seen yet) or "refunding": followed until "filled" / "refunded", never re-signed', async () => {
  for (const [first, last, want, re] of [['paid', 'filled', 'arrived', null], ['refunding', 'refunded', 'refunded', /on their way back/]]) {
    const solverOpts = { fillState: first, fillError: '', statusState: first };
    const wd = makeWorld({ solverOpts }); await on(wd);
    solSnap(wd);
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 120, reason: 'click' }); await wd.settle();
    let job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.equal(job.state, 'relaying', first);
    if (re) assert.match(job.error || '', re); else assert.equal(job.error ?? undefined, undefined, first + ': nothing to add while it lands');
    solverOpts.statusState = last;
    await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
    job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'cold');
    assert.equal(job.state, want, first);
    assert.equal(wd.signedEvm.length, 1, first + ': one signature');
  }
});

test('the bridge core is the solver\'s byte for byte (trench src/motionBridgeCore.ts): the new non-terminal states', () => {
  assert.deepEqual(C.FILL_TERMINAL, ['filled', 'refunded', 'failed', 'expired']);
  for (const s of ['source-late', 'paid']) assert.ok(!C.FILL_TERMINAL.includes(s), s + ' is not terminal');
  assert.equal(C.canStep('source-included', 'failed'), false, 'once the source is in, only filled or refunded end a fill');
  assert.equal(C.canStep('refunding', 'failed'), false);
  assert.equal(C.canStep('paid', 'refunding'), true);
  assert.equal(C.USER_STATE['source-late'], 'source sent');
  assert.equal(C.USER_STATE.paid, 'source sent');
});

// ── 2026-11-01, audit pass 2: p2-money-settle-only-same-from ──
test('p2: a move INTO this chain that arrived under 10 s ago holds a second click\'s bridge from ANOTHER donor too (it bridged the same need twice); 11 s later it runs', async () => {
  const sr = { stable: 500_000_000n, native: 10_000_000n };
  const wd = bnbFrame({ solReserve: sr, solverOpts: { fillThrows: true, statusState: 'filled' } }); await on(wd);
  solSnap(wd, { reserve: '500000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedSol.length, 1, 'click 1: from the Solana reserve');
  // the Solana reserve is spent; the Robinhood reserve holds dollars: a lagging read plans the same need again from there
  sr.stable = 0n; solSnap(wd, { reserve: '0' }); rhSnap(wd, { reserve: '500000000' });
  const b = await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.equal((await coldJobs(wd))[0].state, 'arrived', 'click 1\'s move arrived (its payout may not show in this read yet)');
  assert.equal(wd.signedEvm.length, 0, 'not bridged again from Robinhood while that payout may still be on its way');
  const cold = b.planned.find((m) => m.kind === 'cold');
  assert.ok(cold && cold.from === 'robinhood' && cold.skipped === 'held', JSON.stringify(b.planned));
  // 11 s later: the read is current; a real need bridges
  for (const key of [...wd.store.keys()].filter((k) => k.startsWith('trenches.float.v1.jobs.'))) { const jobs = JSON.parse(wd.store.get(key)); for (const j of jobs) { j.updatedAt -= 11_000; j.at -= 11_000; } wd.store.set(key, JSON.stringify(jobs)); }
  rhSnap(wd, { reserve: '500000000' });
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', usd: 120, reason: 'click' }); await wd.settle();
  assert.equal(wd.signedEvm.length, 1);
});

// ── usd-mode2 (2026-11-05, a tester under rel-9: his wallet sent its reserve 0.0000868 ETH on a background tick, and the reserve
// swapped $100.46 of USDG into ETH for his wallet an hour after buys the reserve itself had paid) ──
test('usd-mode2: a routine tick with the reserve short of gas asks motion\'s gas drop and has W send nothing; the ready-ETH buffer is not topped up', async () => {
  // W holds 0.0002 ETH of floor + a little trading ETH (well under its $150 target), R holds $2,000 of USDG and 0.00001 ETH
  const wd = makeWorld({ wEth: RH.gasFloor + 5_000_000_000_000_000n, readyFloat: false, gasFromW: false }); await on(wd);
  wd.chain.eth.set(lc(wd.R), 10_000_000_000_000n);
  quiet(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.deepEqual(wd.solver.gas, [{ chain: 'robinhood', address: wd.R }], 'motion is asked for the reserve\'s gas');
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  assert.equal(jobs.filter((j) => j.kind === 'gas').length, 0, 'no W -> R gas send: ' + JSON.stringify(jobs.map((j) => [j.kind, j.reason])));
  assert.equal(jobs.filter((j) => j.kind === 'topup').length, 0, 'no ready-ETH top-up where the reserve pays the buys');
  // the same world on the rules of before: W refills R's gas (the planned 'gas' job; this world broadcasts nothing, so it fails)
  const old = makeWorld({ wEth: RH.gasFloor + 5_000_000_000_000_000n }); await on(old);
  old.chain.eth.set(lc(old.R), 10_000_000_000_000n); quiet(old);
  await old.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await old.settle();
  const oj = (await old.f.jobs({ walletId: 'w1' })).jobs;
  assert.ok(oj.some((j) => j.kind === 'gas' && j.reason === 'reserve gas' && BigInt(j.usd6) > 0n), JSON.stringify(oj.map((j) => [j.kind, j.reason])));
});
