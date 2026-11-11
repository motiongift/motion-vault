// fee-final-1111: the Solana half of the 2026-11-10 security review (findings #6 and #7) against the final SOL fee leg.
// The Elysium / EVM half of that review travels with the separate EVM candidate (its test/engine-candidate-1110.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as F from '../src/solMarketFee.ts';
import { solTradeOne, solKeys, ataOf, setSolRpcs, P, b58d, b58e } from '../src/solEngine.ts';

const SOLSRC = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
const WEB = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');

// ── #6 / #7 Solana ──
const FX = JSON.parse(readFileSync(new URL('./fixtures/pumpswap-market.json', import.meta.url), 'utf8'));
const KEY = '0x' + '22'.repeat(32), USER = solKeys(KEY).address, ROUTE = FX.route, COL = F.SOL_MARKET_FEE.collector, SYS = '11111111111111111111111111111111';
const coinAta = ataOf(USER, ROUTE.mint, ROUTE.tokenProgram);
let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;
function decodeLegacy(tx) {
  const b = Buffer.from(tx, 'base64'); let o = 1 + 64 * b[0]; o += 3; const nk = b[o++]; const keys = []; for (let i = 0; i < nk; i++) { keys.push(b58e(b.subarray(o, o + 32))); o += 32; }
  o += 32; const ni = b[o++]; const ixs = [];
  for (let i = 0; i < ni; i++) { const prog = keys[b[o++]]; const na = b[o++]; const accs = [...b.subarray(o, o + na)].map((x) => keys[x]); o += na; let dl = b[o++]; if (dl & 0x80) dl = (dl & 0x7f) | (b[o++] << 7); const data = Buffer.from(b.subarray(o, o + dl)); o += dl; ixs.push({ prog, accs, data }); }
  return ixs;
}
const feeIxsOf = (ixs) => ixs.filter((x) => x.prog === SYS && x.data.readUInt32LE(0) === 2 && x.accs[1] === COL);
function stub(simFor) {
  const orig = globalThis.fetch; const seen = { sims: [], sends: [] };
  const answer = (id, result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
  const one = (k) => { const a = k === USER ? { owner: SYS, lamports: 2_000_000_000, data: '' } : k === COL ? { owner: SYS, lamports: 56_446_022, data: '' } : k === coinAta ? null : FX.accounts[k] ? FX.accounts[k] : null;
    return a ? { owner: a.owner, lamports: a.lamports, data: Array.isArray(a.data) ? a.data : [typeof a.data === 'string' ? a.data : Buffer.from(a.data).toString('base64'), 'base64'] } : null; };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/tipfloor|\/prices|\/quotes|\/route/.test(u)) return { ok: false, status: 503, json: async () => null };
    if (/jup\.ag|\/jup\//.test(u)) return { ok: false, status: 400, json: async () => ({ error: 'stub' }) };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'sendTransaction') { seen.sends.push(body.params[0]); return answer(body.id, b58e(Buffer.from(body.params[0], 'base64').subarray(1, 65))); }
    if (body.method === 'getMultipleAccounts') return answer(body.id, { context: { slot: 1 }, value: body.params[0].map(one) });
    if (body.method === 'simulateTransaction') { seen.sims.push(body.params[0]); return answer(body.id, { context: { slot: 1 }, value: simFor(feeIxsOf(decodeLegacy(body.params[0])).length > 0) }); }
    if (body.method === 'getLatestBlockhash') return answer(body.id, { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } });
    if (body.method === 'getPriorityFeeEstimate') return answer(body.id, { priorityFeeLevels: { medium: 1000, high: 50_000, veryHigh: 100_000 } });
    if (body.method === 'getSignatureStatuses') return answer(body.id, { context: { slot: 1 }, value: body.params[0].map(() => null) });
    return answer(body.id, null);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}
const ACCT = { id: 'w', name: 'W', address: '0x0', key: KEY }, SET = { slippage: 12, gasBoost: 1.5, turbo: false };
const OK = { err: null, logs: [], unitsConsumed: 90_000 }, BAD = { err: { InstructionError: [3, { Custom: 6001 }] }, logs: ['Program log: stub'], unitsConsumed: 0 };
test('#7 SOL (PumpSwap): a simulation that fails only WITH the fee transfer is run once without it — the trade is signed fee-free, reported "sim"', async () => {
  setSolRpcs([], []); skew += 120_000; const s = stub((withFee) => (withFee ? BAD : OK)); const skips = []; F.setSolFeeSkipHook((...a) => skips.push(a.join(' ')));
  try {
    await solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET);
    const kinds = s.seen.sims.map((x) => feeIxsOf(decodeLegacy(x)).length > 0);
    assert.ok(kinds.includes(true) && kinds.includes(false), 'with the fee, then without it');
    assert.equal(kinds.indexOf(false) > kinds.indexOf(true), true, 'the fee-free run only after the fee run failed');
    const ixs = decodeLegacy(s.seen.sends[0]);
    assert.equal(feeIxsOf(ixs).length, 0, 'no fee transfer signed');
    assert.ok(ixs.find((x) => x.prog === P.pamm), 'the swap goes');
    assert.deepEqual(skips, ['buy pumpswap sim']);
  } finally { s.restore(); F.setSolFeeSkipHook(() => {}); }
});
test('#7 SOL: a simulation that fails WITHOUT the fee too is the trade\'s own failure: refused exactly as before (nothing sent)', async () => {
  setSolRpcs([], []); skew += 120_000; const s = stub(() => BAD);
  try { await assert.rejects(solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET)); assert.equal(s.seen.sends.length, 0); assert.deepEqual([...new Set(s.seen.sims.map((x) => feeIxsOf(decodeLegacy(x)).length > 0))].sort(), [false, true]); } finally { s.restore(); }
  setSolRpcs([], []); skew += 120_000; const t = stub(() => OK);
  try { await solTradeOne(ACCT, 'buy', ROUTE, 0.02, SET); assert.ok(t.seen.sims.every((x) => feeIxsOf(decodeLegacy(x)).length === 1), 'a passing simulation is not repeated without the fee'); assert.equal(feeIxsOf(decodeLegacy(t.seen.sends[0])).length, 1); } finally { t.restore(); }
});
const section = (from, to) => SOLSRC.slice(SOLSRC.indexOf(from), SOLSRC.indexOf(to));
async function jupRun({ simWithFee = OK }) {
  const log = { sims: 0, signed: null, skips: [], guard: null };
  const ready = { owner: SYS, data: new Uint8Array(0), lamports: 56_446_022 };
  const context = {
    SOL_MARKET_FEE: F.SOL_MARKET_FEE, solBuyLeg: F.solBuyLeg, solSellLeg: F.solSellLeg, noteSolFeeSkip: (...a) => { if (!a[2].on && a[2].reason !== 'off') log.skips.push(a[1] + ' ' + a[2].reason); },
    COLLECTOR_READY: ready, solCollectorLastReady: true, solKeys: () => ({ address: 'user', seed: 'MOCK' }), solHoldGate: async () => {}, joinClick: () => 1,
    sendPlan: async () => ({ tipLamports: 1_000_000n, micro: 0, mode: 'fast', protect: false }), blockhash: async () => ({ v: 'block', lvh: 1, at: Date.now() }),
    ataOf: (u, mint) => mint, P: { wsol: 'wsol', token: 'token', system: 'system' },
    accounts: async (keys) => keys.map((k) => (k === 'user' ? { lamports: 1_000_000_000 } : k === 'coin' ? { amount: 1_000n } : k === COL ? ready : null)),
    tokState: (x) => (x && 'amount' in x ? { amount: x.amount } : null),
    jupBuild: async () => ({ quote: { otherAmountThreshold: '20000000' }, list: [], tables: [], claimed: {} }),
    motionPriceSol: async () => 1, jupPriceCheck: () => '', jupIxsChecked: () => ({ ixs: [{ swap: true }], opens: 1 }), jupTables: async () => [],
    transferIx: (from, to, lamports) => ({ transfer: true, from, to, lamports }), tipIxGuarded: () => ({ tip: true }), pick: () => 'tip', JITO_TIP: [],
    JUP_FEE_CEIL: 5_000_000n, JUP_UNITS_MAX: 700_000, SIG_FEE: 5_000n, RENT_ATA22: 2_100_000n, RENT_WALLET: 890_880n, solTxt: (n) => (Number(n) / 1e9).toFixed(4),
    budget: () => [{ budget: true }], compileV0: (u, ixs) => ixs, unsignedTx: (x) => ({ length: 900, ixs: x }),
    simulateSeeing: async (trial) => { log.sims++; const fee = trial.ixs.some((x) => x.transfer && x.to === COL); return fee && simWithFee.err ? simWithFee : { err: null, unitsConsumed: 100_000, innerInstructions: [], accounts: [{ lamports: 1 }, { amount: 0n }, null] }; },
    errText: () => 'sim failed', simAcc: (x) => x, jupInnerGuard: () => '', jupInnerRent: () => ({ rent: 0n, opens: 0 }), JUP_OPENS_MAX: 6,
    jupBalanceGuard: (g) => { log.guard = g; return ''; }, newerBlockhash: async () => ({ v: 'b2', lvh: 2 }),
    signMessage: (ixs) => { log.signed = ixs; return { tx: new Uint8Array(1), sig: 'signature' }; }, b58e: (x) => x, sentSigs: new Map(), sendSigned: async () => {}, SolSendUnknown: class extends Error {},
  };
  const fn = vm.runInNewContext(`(${stripTypeScriptTypes(section('async function jupiterTradeOne(', '// the preview of a Jupiter route:'))})`, context);
  await fn({ key: 'MOCK' }, 'buy', { mint: 'coin', tokenProgram: 'token', decimals: 6 }, 0.02, { slippage: 12 });
  return log;
}
test('#7 SOL (Jupiter): failed only WITH the fee → once more without it, signed fee-free, the balance guard counts no fee', async () => {
  const l = await jupRun({ simWithFee: { err: { InstructionError: [2, 'x'] } } });
  assert.equal(l.sims, 2); assert.equal(l.signed.filter((x) => x.transfer && x.to === COL).length, 0); assert.deepEqual(l.skips, ['jupiter sim']);
  assert.equal(l.guard.feesMax < 40_000n + 5_000_000n, true);
  const ok = await jupRun({});
  assert.equal(ok.sims, 1); assert.equal(ok.signed.filter((x) => x.transfer && x.to === COL)[0].lamports, 40_000n);
});
async function directRun({ sizeWithFee = 900, sizeBare = 900, maxAccounts = 40, simWithFee = null }) {
  const log = { builds: [], skips: [], msg: null, price: null, sims: 0, threw: null };
  const d = new Uint8Array(165); d.set(b58d(F.USDC_MINT), 0); d.set(b58d(COL), 32); d[108] = 1;
  const usdcAcc = { owner: P.token, data: d, lamports: 2_039_280 };
  const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', W = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  class DirectTooLarge extends Error {}
  const hasFee = (ixs) => ixs.some((x) => x.program === P.token && x.data?.[0] === 3);
  const context = {
    SOL_MARKET_FEE: F.SOL_MARKET_FEE, solUsdcLeg: F.solUsdcLeg, noteSolFeeSkip: (...a) => { if (!a[2].on && a[2].reason !== 'off') log.skips.push(a[1] + ' ' + a[2].reason); },
    solUsdcCollectorLastReady: true, USDC_COLLECTOR_READY: usdcAcc,
    SOL_ADDR: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, performance: { now: () => 0 }, DIRECT_USDC: F.USDC_MINT, P: { token: P.token, wsol: P.wsol, system: SYS, ata: P.ata },
    ataOf: (o, m) => o + ':' + m.slice(0, 4), sendPlan: async () => ({ tipLamports: 0n, micro: 0, mode: 'fast', protect: false }), blockhash: async () => ({ v: 'bh', lvh: 1, at: Date.now() }),
    jupBuildDirect: async (mint, amount) => { log.builds.push(amount); return { quote: { otherAmountThreshold: '1000', outAmount: '1100', routePlan: [] }, list: [], tables: [], claimed: {} }; },
    motionPriceUsd: async () => null, READ_FAIL: 'read failed',
    accounts: async (keys) => keys.map((k) => (k === R ? { lamports: 50_000_000 } : k === F.SOL_MARKET_FEE.usdcCollectorAta ? usdcAcc : k.endsWith(':' + F.USDC_MINT.slice(0, 4)) && k.startsWith(R) ? { amount: 100_000_000n } : null)),
    tokState: (x) => (x && 'amount' in x ? { amount: x.amount, owner: W, mint: 'coin' } : null),
    directPriceCheck: (o) => { log.price = o; return ''; }, directIxsChecked: () => ({ opens: 0 }), ix: (program, keys, data) => ({ program, keys, data }), cat: (...a) => Buffer.concat(a.map((x) => Buffer.from(x))),
    u64: (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }, ataCreate: () => ({ ataCreate: true }), jupTables: async () => [], tipIxGuarded: () => ({}), transferIx: () => ({}), pick: () => '', JITO_TIP: [],
    JUP_FEE_CEIL: 5_000_000n, SIG_FEE: 5_000n, RENT_ATA22: 2_100_000n, RENT_WALLET: 890_880n, JUP_UNITS_MAX: 700_000, SolDirectNoGas: class extends Error {}, solTxt: String,
    budget: () => [], compileV0: (payer, ixs) => ixs, unsignedTx: (x) => ({ length: hasFee(x) ? sizeWithFee : sizeBare, x }), DIRECT_MAX_ACCOUNTS: [40, 28], DirectTooLarge,
    simulateSeeing: async (trial) => { log.sims++; return hasFee(trial.x) && simWithFee ? simWithFee : { err: null, unitsConsumed: 100_000, innerInstructions: [], accounts: [{ lamports: 1 }, { amount: 0n }, { amount: 1000n }] }; },
    errText: () => 'sim', simAcc: (x) => x, directInnerGuard: () => '', jupInnerRent: () => ({ rent: 0n, opens: 0 }), JUP_OPENS_MAX: 6, walletTokenAccounts: async () => [], directBalanceGuard: () => '',
  };
  const fn = vm.runInNewContext(`(${stripTypeScriptTypes(section('async function directPlanAt(', '/** R\'s buy for W, sent through'))})`, context);
  try { const plan = await fn(R, W, { mint: 'coin', tokenProgram: P.token, decimals: 6 }, 25_000_000n, { slippage: 12 }, maxAccounts); log.msg = plan.message('bh'); }
  catch (e) { log.threw = e instanceof DirectTooLarge ? 'DirectTooLarge' : e.message; }
  return log;
}
test('#6 SOL USD balance: a fee that does not fit at the larger account limit makes THAT route fee-free — it never pushes the buy to a smaller route', async () => {
  const l = await directRun({ sizeWithFee: 1300, sizeBare: 1100, maxAccounts: 40 });
  assert.equal(l.threw, null, 'no DirectTooLarge: the best route goes');
  assert.equal(l.msg.filter((x) => x.program === P.token && x.data?.[0] === 3).length, 0); assert.deepEqual(l.skips, ['usd-balance size']);
  const big = await directRun({ sizeWithFee: 1400, sizeBare: 1300, maxAccounts: 40 });
  assert.equal(big.threw, 'DirectTooLarge', 'too large even without the fee: the smaller limit is tried (with the fee again)');
  const small = await directRun({ sizeWithFee: 1300, sizeBare: 1100, maxAccounts: 28 });
  assert.equal(small.threw, null); assert.deepEqual(small.skips, ['usd-balance size']);
});
test('#6 SOL USD balance: the fair-price bound is taken on what the swap gets; #7 a simulation failing only with the fee goes fee-free', async () => {
  const l = await directRun({});
  assert.equal(l.price.usdcIn, 24_950_000n, 'jupIn = 25 USDC − 0.2 %');
  assert.equal(l.msg.filter((x) => x.program === P.token && x.data?.[0] === 3).length, 1);
  const s = await directRun({ simWithFee: { err: { InstructionError: [4, 'x'] } } });
  assert.equal(s.threw, null); assert.equal(s.sims, 2); assert.deepEqual(s.skips, ['usd-balance sim']);
  assert.equal(s.msg.filter((x) => x.program === P.token && x.data?.[0] === 3).length, 0);
});
test('#7 the new fallback reason is a reported kind (addressless fee-fallback line)', () => {
  const gate = readFileSync(new URL('../src/terminalFeeGate.ts', import.meta.url), 'utf8');
  assert.match(gate, /'fee-leg-size' \| 'fee-leg-sim';/);
  assert.match(readFileSync(new URL('../src/solMarketFee.ts', import.meta.url), 'utf8'), /'off' \| 'collector' \| 'dust' \| 'funds' \| 'size' \| 'sim'/);
});
