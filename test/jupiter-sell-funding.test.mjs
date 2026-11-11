import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

// Runs the actual extracted trade function against an entirely local ledger.
// No network, key material, signing library or chain dispatch exists in this harness.
const sources = { baseline: readFileSync(new URL('./fixtures/jupiter-sell-rent-baseline.ts', import.meta.url), 'utf8'), candidate: readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8') };
// fee-cov-1110: the Solana in-transaction fee the candidate's Jupiter path now carries (src/solMarketFee.ts); this ledger has
// no collector account, so every leg here is off and the path is exactly the one this harness was written for
const FEE = await import(new URL('../src/solMarketFee.ts', import.meta.url).href);
const section = s => s.slice(s.indexOf('async function jupiterTradeOne('), s.indexOf('// the preview of a Jupiter route:'));
async function run(which, { have = 4_500_000n, missing = 0, micro = 0, side = 'sell', tip = 1_000_000n, guardError = '', simError = false, consumed = 100_000 } = {}) {
  const log = { reads: 0, builds: 0, simulations: 0, signs: 0, sends: 0, balance: null, trial: null, signed: null };
  const ceilFee = (m, u) => (BigInt(m) * BigInt(u) + 999_999n) / 1_000_000n;
  const context = {
    SOL_MARKET_FEE: FEE.SOL_MARKET_FEE, solBuyLeg: FEE.solBuyLeg, solSellLeg: FEE.solSellLeg, noteSolFeeSkip: () => {}, COLLECTOR_READY: { owner: 'system', data: new Uint8Array(0), lamports: 890_880 }, solCollectorLastReady: true,
    solKeys: () => ({ address: 'user', seed: 'MOCK' }), solHoldGate: async () => {}, joinClick: () => 1,
    sendPlan: async () => ({ tipLamports: tip, micro, mode: 'fast', protect: false }), blockhash: async () => ({ v: 'block', lvh: 1, at: Date.now() }),
    ataOf: (u, mint) => mint, P: { wsol: 'wsol', token: 'token', system: 'system' },
    accounts: async () => { log.reads++; return [{ lamports: Number(have) }, { amount: 100n }, null]; },
    tokState: x => x ? { amount: x.amount } : null,
    jupBuild: async () => { log.builds++; return { quote: { otherAmountThreshold: '20000000' }, list: [], tables: [], claimed: {} }; },
    motionPriceSol: async () => 1, jupPriceCheck: () => '', jupIxsChecked: () => ({ ixs: [], opens: 3 }), jupTables: async () => [],
    transferIx: () => ({ tip }), pick: () => 'tip', JITO_TIP: [],
    JUP_FEE_CEIL: 5_000_000n, JUP_UNITS_MAX: 700_000, SIG_FEE: 5_000n, RENT_ATA22: 2_100_000n, RENT_WALLET: 890_880n,
    solTxt: n => (Number(n) / 1e9).toFixed(4),
    budget: (units, price) => [{ units, price }], compileV0: (u, ixs) => ixs[0], unsignedTx: x => x,
    simulateSeeing: async tx => {
      log.simulations++; log.trial = tx;
      // Fees are deducted before instructions; all account rent is paid before sale proceeds.
      const priority = ceilFee(tx.price, tx.units), rent = BigInt(missing) * 2_100_000n;
      const err = simError || have < 5_000n + priority + tip + rent;
      return { err, unitsConsumed: consumed, innerInstructions: [], accounts: [{ lamports: Number(have - 5_000n - priority - tip - rent + 20_000_000n) }, { amount: 0n }, null] };
    },
    errText: () => 'insufficient actual funding', simAcc: x => x, jupInnerGuard: () => '',
    jupInnerRent: () => ({ rent: BigInt(missing) * 2_100_000n, opens: missing }), JUP_OPENS_MAX: 6,
    jupBalanceGuard: g => { log.balance = g; return guardError; },
    signMessage: compiled => { log.signs++; log.signed = compiled; return { tx: new Uint8Array(1), sig: 'signature' }; },
    b58e: x => x, sentSigs: new Map(), sendSigned: async () => { log.sends++; }, SolSendUnknown: class extends Error {},
  };
  const fn = vm.runInNewContext(`(${stripTypeScriptTypes(section(sources[which]))})`, context);
  try { await fn({ key: 'MOCK' }, side, { mint: 'coin', tokenProgram: 'token', decimals: 6 }, side === 'sell' ? 100 : 0.01, { slippage: 12 }); return { log, error: null }; }
  catch (error) { return { log, error: error.message }; }
}

test('baseline falsely rejects .0045 SOL for three existing idempotent ATA creates', async () => {
  const r = await run('baseline');
  assert.match(r.error, /0.0045 available, about 0.0073 needed/);
  assert.equal(r.log.simulations, 0); assert.equal(r.log.signs, 0);
});
test('candidate evaluates actual rent in the existing simulation and dispatches once', async () => {
  const r = await run('candidate');
  assert.equal(r.error, null); assert.equal(r.log.simulations, 1); assert.equal(r.log.reads, 1); assert.equal(r.log.builds, 1);
  assert.equal(r.log.signs, 1); assert.equal(r.log.sends, 1);
});
test('one genuinely absent account is affordable; three missing accounts remain refused before sign', async () => {
  assert.equal((await run('candidate', { missing: 1 })).error, null);
  const r = await run('candidate', { missing: 3 });
  assert.match(r.error, /insufficient actual funding/); assert.equal(r.log.signs, 0); assert.equal(r.log.sends, 0);
});
test('simulation charges worst-case priority and normalizes final balance once, including ceil rounding', async () => {
  const r = await run('candidate', { micro: 100_003, missing: 1 });
  assert.equal(r.error, null); assert.equal(r.log.trial.price, 100_003);
  const expectedFee = (100_003n * BigInt(r.log.signed.units) + 999_999n) / 1_000_000n;
  assert.equal(r.log.balance.solAfter, 4_500_000n - 5_000n - 1_000_000n - 2_100_000n + 20_000_000n - expectedFee);
});
test('fee-only insufficiency, simulation failure and balance violation never sign', async () => {
  for (const args of [{ have: 500_000n }, { simError: true }, { guardError: 'bad token delta' }]) {
    const r = await run('candidate', args); assert.ok(r.error); assert.equal(r.log.signs, 0); assert.equal(r.log.sends, 0);
  }
});
test('buy refusal and sufficiently funded buy trial remain unchanged', async () => {
  for (const have of [4_500_000n, 100_000_000n]) {
    const a = await run('baseline', { side: 'buy', have }), b = await run('candidate', { side: 'buy', have });
    assert.equal(a.error, b.error); assert.deepEqual(structuredClone(a.log), structuredClone(b.log));
  }
});
test('simulation cannot spend rent while omitting the priority fee', async () => {
  const r = await run('candidate', { have: 3_110_000n, missing: 1, micro: 100_003 });
  assert.match(r.error, /insufficient actual funding/); assert.equal(r.log.simulations, 1); assert.equal(r.log.signs, 0);
});
test('final bounded priority charge never exceeds trial charge over fee/CU ranges', () => {
  for (const micro of [0, 1, 100_003, 1_000_000, 1_000_000_000]) for (const tip of [0n, 1_000_000n, 5_000_000n]) {
    const at = u => Math.min(micro, Number((5_000_000n - tip) * 1_000_000n / BigInt(u)));
    const fee = u => (BigInt(at(u)) * BigInt(u) + 999_999n) / 1_000_000n;
    for (let u = 5_000; u <= 700_000; u += 997) assert.ok(fee(u) <= fee(700_000));
  }
});
test('candidate edits only Jupiter trade and adds no awaits or network calls', () => {
  const a = section(sources.baseline), b = section(sources.candidate);
  // Pin the entire baseline outside the function without duplicating a full engine fixture.
  assert.equal(createHash('sha256').update(sources.candidate.replace(b, '')).digest('hex'), '401adb3a3b866283b271da591378ba22810d8e85a6faa29a8177861eb6973c34');
  assert.equal((a.match(/\bawait\b/g) || []).length, (b.match(/\bawait\b/g) || []).length);
});
