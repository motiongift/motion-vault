// pumphop (2026-11-01, owner “they must be buyable”; trade core: “full go-ahead”): a pump.fun coin whose live curve is
// quoted in another pump coin Q is bought / sold from SOL in ONE PumpSwap multi_hop_swap — SOL → Q (Q's SOL curve or its canonical
// PumpSwap pool) → the coin. Before this every such coin went to Jupiter, which routes a new one minutes late or never (pee Eyrm…,
// quoted in nut: "can't be bought here yet").
// No network: fetch is stubbed with real mainnet accounts (test/fixtures/pumphop-2026-11-01.json, read-only) and the layouts / events
// of real multi_hop_swap transactions (pee 2X2C… buy, ttgB… sell; GTA IV 2eveLd… sell). Nothing is signed for the chain or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solRoute, solTradeOne, solTradeIxs, quotePumphop, pumphopIxs, hopFromChain, hopFallback, solErrText, solKeys, ataOf, curveOf, canonicalPool, setSolRpcs, P, b58d, b58e } from '../src/solEngine.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/pumphop-2026-11-01.json', import.meta.url), 'utf8'));
const { PEE, CURVEHOP, GTA } = FX.coins;
const BUYBACK = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL', '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'];
const KEY = '0x' + '11'.repeat(32), USER = solKeys(KEY).address;
const SETTINGS = { slippage: 12, gasBoost: 1.5, turbo: false };
const acc = (a) => (a ? { owner: a.owner, lamports: a.lamports, data: new Uint8Array(Buffer.from(a.data, 'base64')) } : null);
const bytesOf = (k) => Buffer.from(FX.accts[k].data, 'base64');
const withBytes = (k, edit) => { const d = bytesOf(k); edit(d); return { ...FX.accts[k], data: d.toString('base64') }; };

// the route cache answers a mint for up to 60 s and the market memo for 1.5 s: each case moves the clock past both
let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;
const nextCase = () => { skew += 120_000; };

function stub({ route = {}, patch = {}, sim = { err: null, logs: [], unitsConsumed: 170_000 } } = {}) {
  const orig = globalThis.fetch; const seen = { reads: [], jup: 0, sims: [], sends: [] };
  const answer = (id, result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
  const one = (k) => { const a = k in patch ? patch[k] : k === USER ? { owner: P.system, lamports: 2_000_000_000, data: '' } : FX.accts[k]; return a ? { owner: a.owner, lamports: a.lamports, data: [a.data, 'base64'] } : null; };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/\/token\/([1-9A-HJ-NP-Za-km-z]+)\/route/);
    if (m) return { ok: true, status: 200, json: async () => route[m[1]] ?? null };
    if (/jup\.ag|\/jup\//.test(u)) { seen.jup += 1; return { ok: false, status: 400, json: async () => ({ error: 'No routes found' }) }; }
    if (/tipfloor|\/prices|\/quotes/.test(u)) return { ok: false, status: 503, json: async () => null };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'sendTransaction') { seen.sends.push(body.params[0]); return answer(body.id, b58e(Buffer.from(body.params[0], 'base64').subarray(1, 65))); }
    if (body.method === 'getMultipleAccounts') { seen.reads.push(body.params[0]); return answer(body.id, { context: { slot: 1 }, value: body.params[0].map(one) }); }
    if (body.method === 'simulateTransaction') { seen.sims.push(body.params[0]); return answer(body.id, { context: { slot: 1 }, value: sim }); }
    if (body.method === 'getLatestBlockhash') return answer(body.id, { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } });
    if (body.method === 'getPriorityFeeEstimate') return answer(body.id, { priorityFeeLevels: { medium: 1000, high: 50_000, veryHigh: 100_000 } });
    return answer(body.id, null);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}
// the instructions of a legacy message: [header 3][n keys][keys][blockhash][n ix][ix…]
function decodeLegacy(tx) {
  const b = Buffer.from(tx, 'base64'); let o = 1 + 64 * b[0]; o += 3; const nk = b[o++]; const keys = []; for (let i = 0; i < nk; i++) { keys.push(b58e(b.subarray(o, o + 32))); o += 32; }
  o += 32; const ni = b[o++]; const ixs = [];
  for (let i = 0; i < ni; i++) { const prog = keys[b[o++]]; const na = b[o++]; const accs = [...b.subarray(o, o + na)].map((x) => keys[x]); o += na; let dl = b[o++]; if (dl & 0x80) dl = (dl & 0x7f) | (b[o++] << 7); const data = b.subarray(o, o + dl); o += dl; ixs.push({ prog, accs, data }); }
  return ixs;
}

test('fixtures are what they claim: pee is a live curve quoted in nut, nut a completed curve with its canonical PumpSwap pool; the other coin\'s quote is still on its SOL curve', () => {
  const pee = bytesOf(PEE.curve), nut = bytesOf(PEE.qCurve), q2 = bytesOf(CURVEHOP.qCurve);
  assert.equal(pee[48], 0); assert.equal(b58e(pee.subarray(83, 115)), PEE.quote); assert.equal(pee[141], 1, 'depth 1');
  assert.equal(nut[48], 1); assert.equal(FX.accts[PEE.qPool].owner, P.pamm);
  assert.equal(q2[48], 0); assert.equal(b58e(q2.subarray(83, 115)), '11111111111111111111111111111111', 'SOL-quoted, live');
  assert.equal(FX.accts[GTA.qPool], null, 'BTC-pump has no pool against SOL (its pair is wBTC)');
});

test('route: pee (quoted in nut, nut on its PumpSwap pool) → pumphop through the pool, vaults read from the pool account', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub();
  try {
    const r = await solRoute(PEE.mint);
    assert.equal(r.venue, 'pumphop');
    assert.deepEqual(r.hop, { quote: PEE.quote, quoteProgram: P.token22, via: 'pool', pool: PEE.qPool, baseVault: PEE.baseVault, quoteVault: PEE.quoteVault });
    assert.equal(r.quote, PEE.quote); assert.equal(r.isCashback, false); assert.equal(r.isMayhem, false);
    assert.equal(s.seen.jup, 0, 'Jupiter not asked');
  } finally { s.restore(); }
});

test('route: a coin whose quote token is still on its SOL curve → pumphop through that curve (native SOL)', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub();
  try {
    const r = await solRoute(CURVEHOP.mint);
    assert.equal(r.venue, 'pumphop');
    assert.equal(r.hop.via, 'curve'); assert.equal(r.hop.quote, CURVEHOP.quote); assert.equal(r.hop.pool, undefined);
  } finally { s.restore(); }
});

test('route: a hint naming the quote token reads everything in ONE call; a hint naming another token is never trusted', async () => {
  setSolRpcs([], []); nextCase();
  let s = stub();
  try {
    const r = await solRoute(PEE.mint, { chain: 'sol', mint: PEE.mint, venue: 'pumphop', quote: PEE.quote, quoteSymbol: 'nut', symbol: 'pee' });
    assert.equal(r.venue, 'pumphop'); assert.equal(r.quoteSymbol, 'nut');
    assert.equal(s.seen.reads.length, 1, 'one getMultipleAccounts');
    assert.deepEqual(s.seen.reads[0], [PEE.mint, PEE.curve, canonicalPool(PEE.mint), PEE.quote, PEE.qCurve, PEE.qPool]);
  } finally { s.restore(); }
  nextCase(); s = stub();
  try {
    // the page names CURVEHOP's quote for pee: those accounts are read, but the curve says nut — nut is read and used
    const r = await solRoute(PEE.mint, { chain: 'sol', mint: PEE.mint, venue: 'pumphop', quote: CURVEHOP.quote });
    assert.equal(r.venue, 'pumphop'); assert.equal(r.hop.quote, PEE.quote, 'the curve\'s word, not the hint\'s'); assert.equal(r.hop.via, 'pool');
    assert.equal(s.seen.reads.length, 2);
    assert.deepEqual(s.seen.reads[1], [PEE.quote, PEE.qCurve, PEE.qPool]);
  } finally { s.restore(); }
});

test('route: a hint without a quote token reads exactly what it always read (mint, curve, canonical pool)', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub();
  try {
    await solRoute(PEE.mint, { chain: 'sol', mint: PEE.mint, venue: 'jupiter', symbol: 'pee' });
    assert.deepEqual(s.seen.reads[0], [PEE.mint, PEE.curve, canonicalPool(PEE.mint)]);
  } finally { s.restore(); }
});

test('no pumphop where the route would not hold: GTA IV (its quote token trades against wBTC), a mayhem / cashback quote, a quote awaiting its pool, a mayhem or completed coin', async () => {
  setSolRpcs([], []);
  const jupRoute = (c) => ({ [c.mint]: { ok: true, chain: 'sol', venue: 'jupiter', mint: c.mint, tradeable: true, quote: c.quote } });
  const cases = [
    ['GTA IV', GTA, {}],
    ['quote is mayhem', PEE, { [PEE.qCurve]: withBytes(PEE.qCurve, (d) => { d[81] = 1; }) }],
    ['quote is cashback', PEE, { [PEE.qCurve]: withBytes(PEE.qCurve, (d) => { d[82] = 1; }) }],
    ['quote pool is mayhem', PEE, { [PEE.qPool]: withBytes(PEE.qPool, (d) => { d[243] = 1; }) }],
    ['quote completed, pool not open', PEE, { [PEE.qPool]: null }],
    ['quote curve quoted in another token', CURVEHOP, { [CURVEHOP.qCurve]: withBytes(CURVEHOP.qCurve, (d) => { d.set(b58d(GTA.quote), 83); }) }],
    ['the coin is mayhem', PEE, { [PEE.curve]: withBytes(PEE.curve, (d) => { d[81] = 1; }) }],
    ['the coin completed', PEE, { [PEE.curve]: withBytes(PEE.curve, (d) => { d[48] = 1; }) }],
  ];
  for (const [why, c, patch] of cases) {
    nextCase(); const s = stub({ route: jupRoute(c), patch });
    try { const r = await solRoute(c.mint); assert.notEqual(r.venue, 'pumphop', why); assert.equal(r.venue, 'jupiter', why); }
    finally { s.restore(); }
  }
});

test('hopFromChain: only a pump.fun quote paired with SOL, live on its curve or on its canonical pool', () => {
  const a = (k) => acc(FX.accts[k]);
  assert.equal(hopFromChain(PEE.mint, PEE.quote, a(PEE.quote), a(PEE.qCurve), a(PEE.qPool)).via, 'pool');
  assert.equal(hopFromChain(CURVEHOP.mint, CURVEHOP.quote, a(CURVEHOP.quote), a(CURVEHOP.qCurve), a(CURVEHOP.qPool)).via, 'curve');
  assert.equal(hopFromChain(GTA.mint, GTA.quote, a(GTA.quote), a(GTA.qCurve), a(GTA.qPool)), null);
  assert.equal(hopFromChain(PEE.mint, PEE.quote, a(PEE.quote), a(PEE.qCurve), undefined), null, 'a pool read that failed is no route');
  assert.equal(hopFromChain(PEE.mint, PEE.quote, null, a(PEE.qCurve), a(PEE.qPool)), null);
  assert.equal(hopFromChain(PEE.mint, PEE.mint, a(PEE.quote), a(PEE.qCurve), a(PEE.qPool)), null);
  // a pool at the right address with another base mint (cannot happen on chain; refused all the same)
  assert.equal(hopFromChain(PEE.mint, PEE.quote, a(PEE.quote), a(PEE.qCurve), acc(withBytes(PEE.qPool, (d) => { d.set(b58d(GTA.mint), 43); }))), null);
});

const routeOf = (c, via) => ({ mint: c.mint, venue: 'pumphop', tokenProgram: P.token22, decimals: 6, symbol: '', pool: curveOf(c.mint), isCashback: false, isMayhem: false, quote: c.quote,
  hop: via === 'pool' ? { quote: c.quote, quoteProgram: P.token22, via, pool: c.qPool, baseVault: c.baseVault, quoteVault: c.quoteVault } : { quote: c.quote, quoteProgram: acc(FX.accts[c.quote]).owner, via } });

test('layout: the instruction is byte-for-byte the mainnet multi_hop_swap of pee (buy 2X2C…, sell ttgB…), every account derived from the two mints', () => {
  for (const [name, side] of [['peeBuy', 'buy'], ['peeSell', 'sell']]) {
    const h = FX.history[name]; const d = Buffer.from(h.data, 'base64');
    const user = h.accounts[0];
    const ixs = pumphopIxs(user, routeOf(PEE, 'pool'), side, d.readBigUInt64LE(8), d.readBigUInt64LE(16));
    const mh = ixs.find((x) => x.program === P.pamm);
    assert.deepEqual(Buffer.from(mh.data), d, name + ' data');
    assert.equal(mh.keys.length, 26, '16 fixed + 2 hops × 5');
    mh.keys.forEach((k, i) => {
      if (i === 6) return assert.ok(BUYBACK.some((b) => ataOf(b, P.wsol, P.token) === h.accounts[i]) && BUYBACK.some((b) => ataOf(b, P.wsol, P.token) === k.pubkey), 'buyback: a buyback wallet\'s wSOL account');
      // ttgB… came through a router that passed a temporary wSOL account of its own; the vault passes the wallet's associated one
      if (name === 'peeSell' && i === 2) return assert.equal(k.pubkey, ataOf(user, P.wsol, P.token));
      assert.equal(k.pubkey, h.accounts[i], `${name} account ${i + 1}`);
    });
    assert.deepEqual(mh.keys.map((k) => +k.writable).join(''), '11100110000000000011100111', 'writable: user, its two accounts, volume accumulator, buyback, each hop\'s curve / pool and its two token accounts');
    assert.ok(mh.keys[0].signer && mh.keys.slice(1).every((k) => !k.signer));
  }
  // GTA IV's coin hop (a curve quoted in BTC-pump): the same five accounts the program took
  const g = FX.history.gtaSell.accounts.slice(16, 21);
  const hop = pumphopIxs(USER, routeOf(GTA, 'curve'), 'sell', 1n, 1n).find((x) => x.program === P.pamm).keys.slice(16, 21).map((k) => k.pubkey);
  assert.deepEqual(hop, g);
});

test('instructions: through Q\'s pool a buy wraps exactly the amount; through Q\'s curve it wraps nothing (native SOL); the wSOL account is opened and closed; min out > 0', () => {
  const pool = pumphopIxs(USER, routeOf(PEE, 'pool'), 'buy', 10_000_000n, 5n), curve = pumphopIxs(USER, routeOf(CURVEHOP, 'curve'), 'buy', 10_000_000n, 5n);
  const wsol = ataOf(USER, P.wsol, P.token);
  assert.deepEqual(pool.map((x) => x.program), [P.ata, P.system, P.token, P.ata, P.pamm, P.token]);
  assert.equal(Buffer.from(pool[1].data).readBigUInt64LE(4), 10_000_000n); assert.equal(pool[1].keys[1].pubkey, wsol);
  assert.deepEqual(curve.map((x) => x.program), [P.ata, P.ata, P.pamm, P.token], 'no transfer into wSOL: the curve takes lamports');
  const sell = pumphopIxs(USER, routeOf(PEE, 'pool'), 'sell', 1000n, 1n);
  assert.deepEqual(sell.map((x) => x.program), [P.ata, P.pamm, P.token]);
  assert.equal(sell[2].keys[0].pubkey, wsol); assert.equal(sell[2].keys[1].pubkey, USER, 'closed back to the wallet: SOL comes back as SOL');
  // the sell's in / out: the coin's account in, the wSOL account out; the route order reversed
  const k = sell[1].keys.map((x) => x.pubkey);
  assert.equal(k[1], ataOf(USER, PEE.mint, P.token22)); assert.equal(k[2], wsol); assert.equal(k[16], PEE.mint); assert.equal(k[21], PEE.quote);
});

test('quote: quotePumphop reproduces all six mainnet pee trades exactly (2 buys, 4 sells: Q amount in the middle, the far-end amount, both fee rates)', async () => {
  const u64 = (d, o, v) => d.writeBigUInt64LE(BigInt(v), o);
  for (const e of FX.events) {
    const ca = e.curveAfter, ta = BigInt(e.tokenAmount), qa = BigInt(e.quoteAmount);
    const curve = withBytes(PEE.curve, (d) => { u64(d, 8, e.buy ? BigInt(ca.vTok) + ta : BigInt(ca.vTok) - ta); u64(d, 16, e.buy ? BigInt(ca.vQuote) - qa : BigInt(ca.vQuote) + qa); u64(d, 24, e.buy ? BigInt(ca.realTok) + ta : BigInt(ca.realTok) - ta); });
    const pool = withBytes(PEE.qPool, (d) => { const v = BigInt.asUintN(128, BigInt(e.pool.vq)); u64(d, 245, v & ((1n << 64n) - 1n)); u64(d, 253, v >> 64n); });
    const vault = (k, amt) => withBytes(k, (d) => u64(d, 64, amt));
    const mint = withBytes(PEE.quote, (d) => u64(d, 36, e.pool.supply));
    const m = new Map([[PEE.curve, curve], [PEE.qPool, pool], [PEE.baseVault, vault(PEE.baseVault, e.pool.base)], [PEE.quoteVault, vault(PEE.quoteVault, e.pool.quote)], [PEE.quote, mint], [P.pumpFeeConfig, FX.accts[P.pumpFeeConfig]], [P.ammFeeConfig, FX.accts[P.ammFeeConfig]]].map(([k, v]) => [k, acc(v)]));
    const q = await quotePumphop(routeOf(PEE, 'pool'), e.buy ? 'buy' : 'sell', BigInt(e.buy ? e.quoteAmountIn : e.tokenAmount), m);
    assert.equal(q.protocolBps, BigInt(e.pool.protocolBps), e.sig.slice(0, 8) + ' protocol fee (the SOL hop)');
    assert.equal(q.creatorBps, BigInt(e.creatorBps), e.sig.slice(0, 8) + ' creator fee (the coin\'s hop)');
    assert.equal(q.mid, BigInt(e.buy ? e.baseAmountOut : e.baseAmountIn), e.sig.slice(0, 8) + ' nut between the hops');
    assert.equal(q.out, BigInt(e.buy ? e.tokenAmount : e.userQuoteOut), e.sig.slice(0, 8) + ' what the trader got');
  }
});

test('quote through Q\'s curve: the SOL hop pays pump\'s protocol rate at Q\'s tier, the coin\'s hop its creator rate; a sell of the buy returns less than was paid', async () => {
  const r = routeOf(CURVEHOP, 'curve');
  const m = new Map([CURVEHOP.curve, CURVEHOP.qCurve, P.pumpFeeConfig].map((k) => [k, acc(FX.accts[k])]));
  const b = await quotePumphop(r, 'buy', 10_000_000n, m);
  assert.equal(b.protocolBps, 95n); assert.equal(b.creatorBps, 30n);
  assert.ok(b.out > 0n && b.mid > 0n);
  const s = await quotePumphop(r, 'sell', b.out, m);
  assert.ok(s.out < 10_000_000n && s.out > 9_500_000n, 'round trip ≈ the two fees, ' + s.out);
});

test('click: always simulated, Turbo too; the trader\'s own limit is the answer (nothing else tried, nothing sent)', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub({ sim: { err: { InstructionError: [4, { Custom: 6004 }] }, logs: ['Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6004. Error Message: Slippage tolerance exceeded.'], unitsConsumed: 100_000 } });
  try {
    const r = await solRoute(PEE.mint);
    await assert.rejects(solTradeOne({ id: 'w', name: 'W', address: '0x0', key: KEY }, 'buy', r, 0.01, { ...SETTINGS, turbo: true }), /Price moved past your slippage/);
    assert.equal(s.seen.sims.length >= 1, true, 'Turbo simulated the new instruction');
    assert.equal(s.seen.jup, 0, 'slippage is not a reason to try Jupiter');
    assert.equal(s.seen.sends.length, 0);
  } finally { s.restore(); }
});

test('click: a refusal that is not the trader\'s limit (the route codes 6084–6086 / 6108, an unknown error) goes to Jupiter — nothing signed on the pumphop path', async () => {
  setSolRpcs([], []);
  for (const sim of [
    { err: { InstructionError: [4, { Custom: 6084 }] }, logs: ['Program log: AnchorError occurred. Error Code: MultiHopDiscontinuousPath. Error Number: 6084.'] },
    { err: { InstructionError: [4, { Custom: 6108 }] }, logs: [] },
    { err: { InstructionError: [4, 'InvalidAccountData'] }, logs: [] },
  ]) {
    nextCase(); const s = stub({ sim: { ...sim, unitsConsumed: 1 } });
    try {
      const r = await solRoute(PEE.mint);
      await assert.rejects(solTradeOne({ id: 'w', name: 'W', address: '0x0', key: KEY }, 'buy', r, 0.01, SETTINGS), (e) => { assert.match(e.message, /quoted in/, 'Jupiter\'s answer, naming the quote token'); return true; });
      assert.ok(s.seen.jup > 0, 'Jupiter was asked'); assert.equal(s.seen.sends.length, 0);
    } finally { s.restore(); }
  }
});

test("click: the route no longer holding at the click (Q's pool turned mayhem; the coin's curve completed into a pool quoted in Q) goes to Jupiter, nothing signed on the pumphop path", async () => {
  setSolRpcs([], []);
  for (const patch of [{ [PEE.qPool]: withBytes(PEE.qPool, (d) => { d[243] = 1; }) }, { [PEE.curve]: withBytes(PEE.curve, (d) => { d[48] = 1; }) }]) {
    nextCase(); let s = stub();
    let r; try { r = await solRoute(PEE.mint); assert.equal(r.venue, 'pumphop'); } finally { s.restore(); }
    skew += 2_000;   // past the 1.5 s market memo, inside the route's 20 s
    s = stub({ patch, route: { [PEE.mint]: { ok: true, chain: 'sol', venue: 'jupiter', mint: PEE.mint, tradeable: true, quote: PEE.quote } } });
    try {
      await assert.rejects(solTradeOne({ id: 'w', name: 'W', address: '0x0', key: KEY }, 'buy', r, 0.01, SETTINGS), /quoted in/);
      assert.ok(s.seen.jup > 0, 'Jupiter was asked'); assert.equal(s.seen.sims.length, 0, 'no pumphop simulation'); assert.equal(s.seen.sends.length, 0);
    } finally { s.restore(); }
  }
});

test('click: the simulated instructions are what is signed and sent — one multi_hop_swap, a real minimum, the simulated compute limit', async () => {
  setSolRpcs([], []); nextCase();
  const s = stub();
  try {
    const r = await solRoute(PEE.mint);
    const { hash } = await solTradeOne({ id: 'w', name: 'W', address: '0x0', key: KEY }, 'buy', r, 0.01, SETTINGS);
    assert.ok(hash);
    assert.ok(s.seen.sends.length >= 1, 'handed to the send roads (stubbed)');
    const ixs = decodeLegacy(s.seen.sends[0]);
    const mh = ixs.filter((x) => x.prog === P.pamm);
    assert.equal(mh.length, 1);
    assert.deepEqual([...mh[0].data.subarray(0, 8)], [43, 100, 73, 19, 233, 246, 111, 148]);
    assert.equal(mh[0].data.readBigUInt64LE(8), 10_000_000n);
    const { expected, minOut } = await solTradeIxs(USER, r, 'buy', 10_000_000n, 12);
    assert.ok(minOut > 0n && minOut < expected);
    assert.equal(mh[0].data.readBigUInt64LE(16) > 0n, true);
    const cu = ixs.find((x) => x.prog === P.budget && x.data[0] === 2); assert.equal(cu.data.readUInt32LE(1), Math.ceil(170_000 * 1.25) + 5_000);
    // the signed instructions are the simulated ones (budget aside)
    const simIxs = decodeLegacy(s.seen.sims.at(-1)).filter((x) => x.prog !== P.budget).map((x) => x.prog + x.accs.join());
    assert.deepEqual(ixs.filter((x) => x.prog !== P.budget).map((x) => x.prog + x.accs.join()), simIxs);
  } finally { s.restore(); }
});

test('error words: the multi-hop codes for the pumphop venue (landed receipts carry only the number)', () => {
  const t = (n) => solErrText({ err: { InstructionError: [4, { Custom: n }] }, logs: [] }, 'buy', 'pumphop');
  assert.match(t(6084), /hops do not connect/); assert.match(t(6085), /refused the route/); assert.match(t(6086), /mixed directions/); assert.match(t(6108), /mayhem/);
  assert.equal(t(6004), 'Price moved past your slippage');
  assert.equal(hopFallback({ err: { InstructionError: [4, { Custom: 6004 }] }, logs: [] }, 'buy'), false);
  assert.equal(hopFallback({ err: 'InsufficientFundsForFee', logs: [] }, 'buy'), false);
  assert.equal(hopFallback({ err: { InstructionError: [4, { Custom: 6084 }] }, logs: [] }, 'buy'), true);
  assert.equal(hopFallback({ err: { InstructionError: [4, { Custom: 7777 }] }, logs: [] }, 'buy'), true);
});

test('limit orders refuse a pumphop coin (v1 trades SOL-quoted curves and pools only)', () => {
  const src = readFileSync(new URL('../src/solLimitEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /r\.venue === 'dlmm' \|\| r\.venue === 'jupiter' \|\| r\.venue === 'pumphop'\) throw named\('LimitRefused'/);
});
