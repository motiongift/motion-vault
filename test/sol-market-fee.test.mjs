// fee-cov-1110 (SOL, CANDIDATE): the 0.20 % terminal fee inside every Solana market trade the vault signs (src/solMarketFee.ts,
// wired into src/solEngine.ts tradeOne / jupiterTradeOne / directPlanAt). Offline: fetch is stubbed with recorded mainnet accounts
// (test/fixtures/pumpswap-market.json), the Jupiter and USD-balance paths run their extracted source against a local ledger.
// Nothing is signed for the chain or sent. The same instructions were simulated on mainnet state (fee-cov-1110/sol/tools/sim-mainnet.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as F from '../src/solMarketFee.ts';
import { solTradeOne, solTradeIxs, solKeys, ataOf, setSolRpcs, P, b58d, b58e } from '../src/solEngine.ts';

const COL = F.SOL_MARKET_FEE.collector;
const SYS = '11111111111111111111111111111111';
const ready = { owner: SYS, data: new Uint8Array(0), lamports: 56_446_022 };

// ── 1. the arithmetic and the readiness rules ──
test('switch, collector, rate: pinned (= the Solana receipt policy collector, 20 bps)', async () => {
  assert.equal(F.SOL_MARKET_FEE.enabled, true);
  assert.equal(F.SOL_MARKET_FEE.bps, 20);
  assert.equal(COL, '5ZtmhRo4q9DAtfV7Ccm7yEZWgcJmW33N43gWD5BRWMKx');
  const { TERMINAL_SOL_POLICY } = await import('../src/terminalFeeConfig.ts');
  assert.equal(TERMINAL_SOL_POLICY.feeRecipient, COL, 'one Solana collector');
  assert.equal(F.SOL_MARKET_FEE.usdcCollectorAta, ataOf(COL, F.USDC_MINT, P.token), 'the collector\'s USDC associated account');
  assert.ok(Object.isFrozen(F.SOL_MARKET_FEE));
});
test('buy: fee = floor(amount × 20 / 10 000), the swap gets the rest — fee + swap = the amount, to the lamport', () => {
  for (const [amount, fee] of [[20_000_000n, 40_000n], [100_000_000n, 200_000n], [1_000_000_000n, 2_000_000n], [123_456_789n, 246_913n], [4_999n, 9n], [499n, 0n]]) {
    const s = F.solBuySplit(amount, 20);
    assert.equal(s.fee, fee, String(amount)); assert.equal(s.fee + s.swapIn, amount);
  }
  assert.equal(F.solBuyLeg(499n, ready).on, false, 'dust pays nothing'); assert.equal(F.solBuyLeg(499n, ready).swapIn, 499n);
  assert.throws(() => F.solFeeOf(1n, 25), /rate/); assert.throws(() => F.solFeeOf(1n, 30), /rate/);
});
test('sell: fee = floor(minOut × 20 / 10 000) — never above 20 bps of any proceeds ≥ minOut', () => {
  assert.equal(F.solSellFee(15_064_084n, 20), 30_128n);
  for (const minOut of [1n, 4_999n, 5_000n, 15_055_367n, 987_654_321n]) for (const real of [minOut, minOut + 1n, minOut * 2n]) assert.ok(F.solSellFee(minOut, 20) * 10_000n <= real * 20n);
});
test('collector readiness: only a plain, rent-exempt system account takes the transfer', () => {
  assert.equal(F.collectorReady(ready), true);
  assert.equal(F.collectorReady({ ...ready, lamports: 890_880 }), true);
  assert.equal(F.collectorReady({ ...ready, lamports: 890_879 }), false, 'under rent: a small transfer would fail the transaction');
  assert.equal(F.collectorReady(null), false, 'missing');
  assert.equal(F.collectorReady(undefined), false, 'read failed');
  assert.equal(F.collectorReady({ ...ready, owner: P.token }), false, 'not a system account');
  assert.equal(F.collectorReady({ ...ready, data: new Uint8Array(1) }), false, 'carries data');
  for (const bad of [null, undefined, { ...ready, lamports: 0 }]) { const d = F.solBuyLeg(20_000_000n, bad); assert.equal(d.on, false); assert.equal(d.reason, 'collector'); assert.equal(d.swapIn, 20_000_000n, 'fee-free = exactly the legacy amount'); }
});
test('a sell fee is taken only when the wallet stays rent-exempt without counting the proceeds', () => {
  const spend = 1_005_000n, fee = 30_000n;
  assert.equal(F.sellFeeAffordable(F.RENT_SYSTEM_MIN + spend + fee, spend, fee), true);
  assert.equal(F.sellFeeAffordable(F.RENT_SYSTEM_MIN + spend + fee - 1n, spend, fee), false);
  const d = F.solSellLeg(15_000_000n, 1_000_000n, spend, ready); assert.equal(d.on, false); assert.equal(d.reason, 'funds');
  assert.equal(F.solSellLeg(15_000_000n, 1_000_000_000n, spend, ready).fee, 30_000n);
});
test('the USD balance leg: the collector\'s USDC account must be initialized, USDC, owned by the collector', () => {
  const d = new Uint8Array(165); d.set(b58d(F.USDC_MINT), 0); d.set(b58d(COL), 32); d[108] = 1;
  const usdc = { owner: P.token, data: d, lamports: 2_039_280 };
  assert.equal(F.usdcCollectorReady(usdc), true);
  assert.equal(F.usdcCollectorReady(null), false, 'does not exist (2026-11-10): the owner creates it');
  const frozen = new Uint8Array(d); frozen[108] = 2; assert.equal(F.usdcCollectorReady({ ...usdc, data: frozen }), false);
  const other = new Uint8Array(d); other.set(b58d(P.wsol), 0); assert.equal(F.usdcCollectorReady({ ...usdc, data: other }), false);
  const l = F.solUsdcLeg(25_000_000n, usdc); assert.equal(l.fee, 50_000n); assert.equal(l.swapIn, 24_950_000n);
  assert.equal(F.solUsdcLeg(25_000_000n, null).swapIn, 25_000_000n);
});
test('a skipped fee is reported (no address, no amount); a trade with the fee or with the switch off is not', () => {
  const seen = []; F.setSolFeeSkipHook((...a) => seen.push(a.join(' ')));
  F.noteSolFeeSkip('buy', 'pump', F.solBuyLeg(1n << 30n, null));
  F.noteSolFeeSkip('sell', 'pumpswap', F.solSellLeg(10n ** 8n, 10n ** 9n, 0n, ready));
  F.noteSolFeeSkip('buy', 'pump', { on: false, reason: 'off', swapIn: 1n });
  F.setSolFeeSkipHook(() => { throw new Error('a broken reporter'); });
  F.noteSolFeeSkip('buy', 'pump', F.solBuyLeg(1n << 30n, null));   // never throws into the trade
  F.setSolFeeSkipHook(() => {});
  assert.deepEqual(seen, ['buy pump collector']);
});

// ── 2. tradeOne (pump / PumpSwap / pumphop / DLMM path) end to end, stubbed network, recorded PumpSwap market ──
const FX = JSON.parse(readFileSync(new URL('./fixtures/pumpswap-market.json', import.meta.url), 'utf8'));
const KEY = '0x' + '22'.repeat(32), USER = solKeys(KEY).address;
const ROUTE = FX.route;
const coinAta = ataOf(USER, ROUTE.mint, ROUTE.tokenProgram);
const tokenAcct = (mint, owner, amount, program) => { const d = Buffer.alloc(165); Buffer.from(b58d(mint)).copy(d, 0); Buffer.from(b58d(owner)).copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1; return { owner: program, lamports: 2_039_280, data: d.toString('base64') }; };
let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;
const nextCase = () => { skew += 120_000; };
function stub({ user = 2_000_000_000, collector = { owner: SYS, lamports: 56_446_022, data: '' }, coin = null, sim = { err: null, logs: [], unitsConsumed: 90_000 } } = {}) {
  const orig = globalThis.fetch; const seen = { sims: [], sends: [] };
  const answer = (id, result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
  const one = (k) => {
    const a = k === USER ? { owner: SYS, lamports: user, data: '' } : k === COL ? collector : k === coinAta ? coin : FX.accounts[k] ? { owner: FX.accounts[k].owner, lamports: FX.accounts[k].lamports, data: FX.accounts[k].data } : null;
    return a ? { owner: a.owner, lamports: a.lamports, data: Array.isArray(a.data) ? a.data : [typeof a.data === 'string' ? a.data : Buffer.from(a.data).toString('base64'), 'base64'] } : null;
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/tipfloor|\/prices|\/quotes|\/route/.test(u)) return { ok: false, status: 503, json: async () => null };
    if (/jup\.ag|\/jup\//.test(u)) return { ok: false, status: 400, json: async () => ({ error: 'stub' }) };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'sendTransaction') { seen.sends.push(body.params[0]); return answer(body.id, b58e(Buffer.from(body.params[0], 'base64').subarray(1, 65))); }
    if (body.method === 'getMultipleAccounts') return answer(body.id, { context: { slot: 1 }, value: body.params[0].map(one) });
    if (body.method === 'simulateTransaction') { seen.sims.push(body.params[0]); return answer(body.id, { context: { slot: 1 }, value: sim }); }
    if (body.method === 'getLatestBlockhash') return answer(body.id, { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } });
    if (body.method === 'getPriorityFeeEstimate') return answer(body.id, { priorityFeeLevels: { medium: 1000, high: 50_000, veryHigh: 100_000 } });
    if (body.method === 'getSignatureStatuses') return answer(body.id, { context: { slot: 1 }, value: body.params[0].map(() => null) });
    return answer(body.id, null);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}
function decodeLegacy(tx) {
  const b = Buffer.from(tx, 'base64'); let o = 1 + 64 * b[0]; o += 3; const nk = b[o++]; const keys = []; for (let i = 0; i < nk; i++) { keys.push(b58e(b.subarray(o, o + 32))); o += 32; }
  o += 32; const ni = b[o++]; const ixs = [];
  for (let i = 0; i < ni; i++) { const prog = keys[b[o++]]; const na = b[o++]; const accs = [...b.subarray(o, o + na)].map((x) => keys[x]); o += na; let dl = b[o++]; if (dl & 0x80) dl = (dl & 0x7f) | (b[o++] << 7); const data = Buffer.from(b.subarray(o, o + dl)); o += dl; ixs.push({ prog, accs, data }); }
  return ixs;
}
const feeIxsOf = (ixs) => ixs.filter((x) => x.prog === SYS && x.data.readUInt32LE(0) === 2 && x.accs[1] === COL);
const ACCT = { id: 'w', name: 'W', address: '0x0', key: KEY };
const SET = { slippage: 12, gasBoost: 1.5, turbo: false };

test('PumpSwap BUY: the swap spends amount − fee, ONE transfer of exactly the fee to the collector, right after the swap; simulated = signed', async () => {
  setSolRpcs([], []); nextCase(); const s = stub(); const skips = []; F.setSolFeeSkipHook((...a) => skips.push(a));
  try {
    await solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET);
    const ixs = decodeLegacy(s.seen.sends[0]);
    const swap = ixs.find((x) => x.prog === P.pamm);
    assert.equal(swap.data.readBigUInt64LE(8), 19_960_000n, 'buy_exact_quote_in spends 0.02 SOL − 0.2 %');
    const wrap = ixs.find((x) => x.prog === SYS && x.data.readUInt32LE(0) === 2 && x.accs[1] === ataOf(USER, P.wsol, P.token));
    assert.equal(wrap.data.readBigUInt64LE(4), 19_960_000n, 'only amount − fee is wrapped');
    const fee = feeIxsOf(ixs); assert.equal(fee.length, 1); assert.equal(fee[0].accs[0], USER); assert.equal(fee[0].data.readBigUInt64LE(4), 40_000n);
    const iClose = ixs.findIndex((x) => x.prog === P.token && x.data[0] === 9), iFee = ixs.indexOf(fee[0]);
    assert.ok(iFee > ixs.indexOf(swap) && iFee > iClose, 'after the swap and the unwrap');
    const strip = (l) => l.filter((x) => x.prog !== P.budget).map((x) => x.prog + x.accs.join() + x.data.toString('hex'));
    assert.deepEqual(strip(ixs), strip(decodeLegacy(s.seen.sims.at(-1))), 'the simulated instructions are the signed ones');
    assert.deepEqual(skips, []);
  } finally { s.restore(); F.setSolFeeSkipHook(() => {}); }
});
test('PumpSwap SELL: fee = 0.2 % of the signed minimum, after the unwrap; the coin amount is unchanged', async () => {
  setSolRpcs([], []); nextCase(); const s = stub({ coin: tokenAcct(ROUTE.mint, USER, 1_000_000_000n, ROUTE.tokenProgram) });
  try {
    await solTradeOne(ACCT, 'sell', ROUTE, 50, SET);
    const ixs = decodeLegacy(s.seen.sends[0]);
    const swap = ixs.find((x) => x.prog === P.pamm);
    assert.equal(swap.data.readBigUInt64LE(8), 500_000_000n, '50 % of the coin');
    const minOut = swap.data.readBigUInt64LE(16);
    const { minOut: want } = await solTradeIxs(USER, ROUTE, 'sell', 500_000_000n, 12);
    assert.equal(minOut, want);
    const fee = feeIxsOf(ixs); assert.equal(fee.length, 1); assert.equal(fee[0].data.readBigUInt64LE(4), minOut * 20n / 10_000n);
    assert.ok(ixs.indexOf(fee[0]) > ixs.findIndex((x) => x.prog === P.token && x.data[0] === 9));
  } finally { s.restore(); }
});
test('Turbo / tip / priority: the fee rides in the same transaction (no fee-free fallback any more)', async () => {
  setSolRpcs([], []); nextCase(); const s = stub();
  try {
    await solTradeOne(ACCT, 'buy', ROUTE, 0.02, { ...SET, turbo: true, solTip: 0.001, solPriority: 200_000 });
    const ixs = decodeLegacy(s.seen.sends[0]);
    assert.equal(feeIxsOf(ixs)[0].data.readBigUInt64LE(4), 40_000n);
    assert.equal(ixs.find((x) => x.prog === P.pamm).data.readBigUInt64LE(8), 19_960_000n);
  } finally { s.restore(); }
});
test('collector missing / under rent: the trade goes EXACTLY as before (full amount, no transfer) and is reported', async () => {
  for (const collector of [null, { owner: SYS, lamports: 5_000, data: '' }]) {
    setSolRpcs([], []); nextCase(); const s = stub({ collector }); const skips = []; F.setSolFeeSkipHook((...a) => skips.push(a.join(' ')));
    try {
      await solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET);
      const ixs = decodeLegacy(s.seen.sends[0]);
      assert.equal(feeIxsOf(ixs).length, 0); assert.equal(ixs.find((x) => x.prog === P.pamm).data.readBigUInt64LE(8), 20_000_000n);
      assert.deepEqual(skips, ['buy pumpswap collector']);
    } finally { s.restore(); F.setSolFeeSkipHook(() => {}); }
  }
});
test('a sell from a wallet that can only just pay its own fees: the sell is sent, fee-free (the fee never blocks an exit)', async () => {
  // PumpSwap sell needs fees + 0.00204 (temporary wSOL) + 0.0017 (accumulator): give it that and nothing for the 0.2 %
  setSolRpcs([], []); nextCase();
  const s = stub({ user: 4_000_000, coin: tokenAcct(ROUTE.mint, USER, 1_000_000_000n, ROUTE.tokenProgram) }); const skips = []; F.setSolFeeSkipHook((...a) => skips.push(a.join(' ')));
  try {
    await solTradeOne(ACCT, 'sell', ROUTE, 100, SET);
    const ixs = decodeLegacy(s.seen.sends[0]);
    assert.equal(feeIxsOf(ixs).length, 0); assert.ok(ixs.find((x) => x.prog === P.pamm)); assert.deepEqual(skips, ['sell pumpswap funds']);
  } finally { s.restore(); F.setSolFeeSkipHook(() => {}); }
});
test('a buy is never made unaffordable by the fee: the same balance that bought before buys now (fee inside the amount)', async () => {
  // exactly enough for the legacy buy of 0.02 SOL (amount + rent-exempt wallet + fees + rent), not one lamport more
  setSolRpcs([], []); nextCase();
  const probe = stub({ user: 1 }); let need;
  try { await assert.rejects(solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET), (e) => { need = Number(/about ([0-9.]+) needed/.exec(e.message)[1]); return true; }); } finally { probe.restore(); }
  nextCase(); const s = stub({ user: Math.ceil(need * 1e9) + 50_000 });
  try { await solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET); assert.equal(feeIxsOf(decodeLegacy(s.seen.sends[0]))[0].data.readBigUInt64LE(4), 40_000n); } finally { s.restore(); }
});

// ── 3. jupiterTradeOne, the extracted source against a local ledger (as test/jupiter-sell-funding.test.mjs) ──
const SRC = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
const section = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
async function jupRun({ side = 'buy', have = 1_000_000_000n, collector = ready, minOut = 20_000_000n, size = side === 'buy' ? 0.02 : 100 } = {}) {
  const log = { builds: [], guard: null, inner: null, signed: null, skips: [] };
  const context = {
    SOL_MARKET_FEE: F.SOL_MARKET_FEE, solBuyLeg: F.solBuyLeg, solSellLeg: F.solSellLeg, noteSolFeeSkip: (...a) => { if (!a[2].on && a[2].reason !== 'off') log.skips.push(a[1] + ' ' + a[2].reason); },
    COLLECTOR_READY: { owner: SYS, data: new Uint8Array(0), lamports: 890_880 }, solCollectorLastReady: true,
    solKeys: () => ({ address: 'user', seed: 'MOCK' }), solHoldGate: async () => {}, joinClick: () => 1,
    sendPlan: async () => ({ tipLamports: 1_000_000n, micro: 0, mode: 'fast', protect: false }), blockhash: async () => ({ v: 'block', lvh: 1, at: Date.now() }),
    ataOf: (u, mint) => mint, P: { wsol: 'wsol', token: 'token', system: 'system' },
    accounts: async (keys) => keys.map((k) => (k === 'user' ? { lamports: Number(have) } : k === 'coin' ? { amount: 1_000n } : k === COL ? collector : null)),
    tokState: (x) => (x && 'amount' in x ? { amount: x.amount } : null),
    jupBuild: async (r, sd, amount) => { log.builds.push(amount); return { quote: { otherAmountThreshold: String(minOut) }, list: [], tables: [], claimed: {} }; },
    motionPriceSol: async () => 1, jupPriceCheck: () => '', jupIxsChecked: () => ({ ixs: [{ swap: true }], opens: 1 }), jupTables: async () => [],
    transferIx: (from, to, lamports) => ({ transfer: true, from, to, lamports }), tipIxGuarded: () => ({ tip: true }), pick: () => 'tip', JITO_TIP: [],
    JUP_FEE_CEIL: 5_000_000n, JUP_UNITS_MAX: 700_000, SIG_FEE: 5_000n, RENT_ATA22: 2_100_000n, RENT_WALLET: 890_880n, solTxt: (n) => (Number(n) / 1e9).toFixed(4),
    budget: () => [{ budget: true }], compileV0: (u, ixs) => ixs, unsignedTx: (x) => ({ length: 900, ixs: x }),
    simulateSeeing: async () => ({ err: null, unitsConsumed: 100_000, innerInstructions: [], accounts: [{ lamports: 1 }, { amount: 0n }, null] }),
    errText: () => 'sim', simAcc: (x) => x, jupInnerGuard: (g) => { log.inner = g; return ''; }, jupInnerRent: () => ({ rent: 0n, opens: 0 }), JUP_OPENS_MAX: 6,
    jupBalanceGuard: (g) => { log.guard = g; return ''; }, newerBlockhash: async () => ({ v: 'b2', lvh: 2 }),
    signMessage: (ixs) => { log.signed = ixs; return { tx: new Uint8Array(1), sig: 'signature' }; }, b58e: (x) => x, sentSigs: new Map(), sendSigned: async () => {}, SolSendUnknown: class extends Error {},
  };
  const fn = vm.runInNewContext(`(${stripTypeScriptTypes(section('async function jupiterTradeOne(', '// the preview of a Jupiter route:'))})`, context);
  await fn({ key: 'MOCK' }, side, { mint: 'coin', tokenProgram: 'token', decimals: 6 }, size, { slippage: 12 });
  return log;
}
test('Jupiter BUY: Jupiter swaps amount − fee, the fee transfer goes after Jupiter\'s instructions, the guard counts it', async () => {
  const l = await jupRun();
  assert.deepEqual([...l.builds], [19_960_000n], 'one build (the early one), for 0.02 SOL − 0.2 %');
  const t = l.signed.filter((x) => x.transfer && x.to === COL); assert.equal(t.length, 1); assert.equal(t[0].to, COL); assert.equal(t[0].lamports, 40_000n);
  assert.ok(l.signed.indexOf(t[0]) > l.signed.findIndex((x) => x.swap));
  assert.equal(l.guard.amount, 19_960_000n); assert.ok(l.guard.feesMax >= 40_000n); assert.equal(l.inner.amount, 19_960_000n);
});
test('Jupiter BUY with the collector not ready: rebuilt once for the full amount, no transfer, reported', async () => {
  const l = await jupRun({ collector: null });
  assert.deepEqual([...l.builds], [19_960_000n, 20_000_000n]);
  assert.equal(l.signed.filter((x) => x.transfer && x.to === COL).length, 0); assert.deepEqual([...l.skips], ['jupiter collector']);
});
test('Jupiter SELL: fee = 0.2 % of Jupiter\'s signed minimum; a wallet that cannot pay it besides its fees sells fee-free', async () => {
  const l = await jupRun({ side: 'sell' });
  assert.equal(l.signed.filter((x) => x.transfer && x.to === COL)[0].lamports, 40_000n);
  assert.equal(l.guard.amount, 1_000n, 'the coin amount'); assert.ok(l.guard.feesMax >= 40_000n);
  const poor = await jupRun({ side: 'sell', have: 3_000_000n });
  assert.equal(poor.signed.filter((x) => x.transfer && x.to === COL).length, 0); assert.deepEqual([...poor.skips], ['jupiter funds']);
});

// ── 4. a buy straight from the USD balance (directPlanAt), extracted source against a local ledger ──
async function directRun({ collectorUsdc = 'ready', lastReady = false } = {}) {
  const log = { builds: [], inner: null, guard: null, skips: [], msg: null };
  const d = new Uint8Array(165); d.set(b58d(F.USDC_MINT), 0); d.set(b58d(COL), 32); d[108] = 1;
  const usdcAcc = collectorUsdc === 'ready' ? { owner: P.token, data: d, lamports: 2_039_280 } : null;
  const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', W = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  const context = {
    SOL_MARKET_FEE: F.SOL_MARKET_FEE, solUsdcLeg: F.solUsdcLeg, noteSolFeeSkip: (...a) => { if (!a[2].on && a[2].reason !== 'off') log.skips.push(a[1] + ' ' + a[2].reason); },
    solUsdcCollectorLastReady: lastReady, USDC_COLLECTOR_READY: { owner: P.token, data: d, lamports: 2_039_280 },
    SOL_ADDR: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, performance: { now: () => 0 }, DIRECT_USDC: F.USDC_MINT, P: { token: P.token, wsol: P.wsol, system: SYS, ata: P.ata },
    ataOf: (o, m) => o + ':' + m.slice(0, 4), sendPlan: async () => ({ tipLamports: 0n, micro: 0, mode: 'fast', protect: false }), blockhash: async () => ({ v: 'bh', lvh: 1, at: Date.now() }),
    jupBuildDirect: async (mint, amount) => { log.builds.push(amount); return { quote: { otherAmountThreshold: '1000', outAmount: '1100', routePlan: [] }, list: [], tables: [], claimed: {} }; },
    motionPriceUsd: async () => null, READ_FAIL: 'read failed',
    accounts: async (keys) => keys.map((k) => (k === R ? { lamports: 50_000_000 } : k === F.SOL_MARKET_FEE.usdcCollectorAta ? usdcAcc : k.endsWith(':' + F.USDC_MINT.slice(0, 4)) && k.startsWith(R) ? { amount: 100_000_000n } : null)),
    tokState: (x) => (x && 'amount' in x ? { amount: x.amount, owner: W, mint: 'coin' } : null),
    directPriceCheck: (o) => { log.price = o; return ''; }, directIxsChecked: () => ({ opens: 0 }), ix: (program, keys, data) => ({ program, keys, data }), cat: (...a) => Buffer.concat(a.map((x) => Buffer.from(x))),
    u64: (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }, ataCreate: () => ({ ataCreate: true }), jupTables: async () => [], tipIxGuarded: () => ({}), transferIx: () => ({}), pick: () => '', JITO_TIP: [],
    JUP_FEE_CEIL: 5_000_000n, SIG_FEE: 5_000n, RENT_ATA22: 2_100_000n, RENT_WALLET: 890_880n, JUP_UNITS_MAX: 700_000, SolDirectNoGas: class extends Error {}, solTxt: String,
    budget: () => [], compileV0: (payer, ixs) => ixs, unsignedTx: (x) => ({ length: 900, x }), DIRECT_MAX_ACCOUNTS: [40, 28], DirectTooLarge: class extends Error {},
    simulateSeeing: async () => ({ err: null, unitsConsumed: 100_000, innerInstructions: [], accounts: [{ lamports: 1 }, { amount: 0n }, { amount: 1000n }] }), errText: () => 'sim', simAcc: (x) => x,
    directInnerGuard: (g) => { log.inner = g; return ''; }, jupInnerRent: () => ({ rent: 0n, opens: 0 }), JUP_OPENS_MAX: 6, walletTokenAccounts: async () => [],
    directBalanceGuard: (g) => { log.guard = g; return ''; },
  };
  const fn = vm.runInNewContext(`(${stripTypeScriptTypes(section('async function directPlanAt(', '/** R\'s buy for W, sent through'))})`, context);
  const plan = await fn(R, W, { mint: 'coin', tokenProgram: P.token, decimals: 6 }, 25_000_000n, { slippage: 12 }, 40);
  log.msg = plan.message('bh');
  return log;
}
test('USD balance BUY: 0.2 % of the USDC to the collector\'s USDC account, Jupiter swaps the rest, R\'s USDC down by exactly the amount', async () => {
  const l = await directRun({ lastReady: true });
  assert.deepEqual([...l.builds], [24_950_000n]);
  const t = l.msg.filter((x) => x.program === P.token && x.data?.[0] === 3);
  assert.equal(t.length, 1); assert.equal(Buffer.from(t[0].data).readBigUInt64LE(1), 50_000n);
  assert.deepEqual(JSON.parse(JSON.stringify(t[0].keys.map((k) => k[0]))), ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM:' + F.USDC_MINT.slice(0, 4), F.SOL_MARKET_FEE.usdcCollectorAta, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM']);
  assert.equal(l.inner.amount, 24_950_000n, 'Jupiter\'s own USDC debits ≤ the swap amount'); assert.equal(l.guard.amount, 25_000_000n, 'R\'s USDC down ≤ the whole amount (swap + fee)');
  assert.equal(l.price.usdcIn, 24_950_000n, 'engine-candidate-1110 (review #6): the fair-price bound is taken on what the swap gets');
});
test('USD balance BUY while the collector has no USDC account (today): rebuilt for the full amount, no transfer, reported', async () => {
  const l = await directRun({ collectorUsdc: null, lastReady: true });
  assert.deepEqual([...l.builds], [24_950_000n, 25_000_000n]);
  assert.equal(l.msg.filter((x) => x.program === P.token && x.data?.[0] === 3).length, 0); assert.deepEqual([...l.skips], ['usd-balance collector']);
  const l2 = await directRun({ collectorUsdc: null, lastReady: false });
  assert.deepEqual([...l2.builds], [25_000_000n], 'once seen missing: one build, exactly the legacy one');
});

// ── 5. the engine surface: the fallback count and the frame ──
test('webEngine: SOL buys are no longer counted fee-free by the coverage gate; a skipped leg is reported with its reason', () => {
  const web = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(web, /if \(SOL_MODE && SOL_MARKET_FEE\.enabled\) return null;/);
  assert.match(web, /setSolFeeSkipHook\(\(side, venue, reason\) => \{ FALLBACK\('sol', `\$\{side\}-\$\{venue\}`, `fee-leg-\$\{reason\}` as FallbackReason, 'na'\); \}\);/);
});
