// 2026-10-25 live bug: "Refused: Jupiter's transaction does not do what you asked" on every buy of a coin whose route opens accounts
// the top-level list does not show (XRP 83WuTB…pump: SOL → Meteora DLMM → PumpSwap opened the coin's account, the intermediate
// token's account and PumpSwap's volume accumulator — 4.37M lamports — while the balance check allowed 2 ATA creates × 2.1M).
// The fixture is that route's real mainnet simulation. Now the rent of accounts opened inside the swap is what the check allows.
//   node --experimental-strip-types --test test/jupiter-rent-opens.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jupInnerGuard, jupInnerRent, jupBalanceGuard, ataOf, P } from '../src/solEngine.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/jupiter-inner-buy-xrp-3opens-2026-10-25.json', import.meta.url), 'utf8'));
const amount = BigInt(fx.amount), minOut = BigInt(fx.minOut);
const wsolAta = ataOf(fx.user, P.wsol, P.token), coinAta = ataOf(fx.user, fx.mint, P.token22);
const feesMax = BigInt(fx.prioritizationFeeLamports) + 5_000n + 10_000n;   // the trade's own fee ceiling (no tip in this fixture)
const guard = (rentMax) => jupBalanceGuard({
  side: 'buy', amount, minOut, feesMax, rentMax, user: fx.user,
  solBefore: BigInt(fx.solBefore), solAfter: BigInt(fx.solAfter), coinBefore: 0n, coinAfter: minOut,
  wsolBefore: null, wsolAfter: null, others: [],
  wsolLamportsBefore: BigInt(fx.wsolLamportsBefore), wsolLamportsAfter: BigInt(fx.wsolLamportsAfter),
});

test('the real route passes the inner guard', () => {
  assert.equal(jupInnerGuard({ inner: fx.inner, user: fx.user, side: 'buy', amount, wsolAta, coinAta, rentMax: 2_100_000n }), '');
});

test('it opens 3 accounts inside the swap for 4 373 880 lamports', () => {
  assert.deepEqual(jupInnerRent(fx.inner, fx.user), { rent: 4_373_880n, opens: 3 });
});

test('the old allowance (2 visible ATA creates × 2.1M) refused this honest buy; the rent seen inside the swap lets it through', () => {
  assert.match(guard(2n * 2_100_000n), /more SOL than the amount/);
  assert.equal(guard(jupInnerRent(fx.inner, fx.user).rent), '');
});

test('SOL taken beyond the opened accounts is still refused', () => {
  const rent = jupInnerRent(fx.inner, fx.user).rent;
  assert.match(jupBalanceGuard({
    side: 'buy', amount, minOut, feesMax, rentMax: rent, user: fx.user,
    solBefore: BigInt(fx.solBefore), solAfter: BigInt(fx.solAfter) - 50_000n, coinBefore: 0n, coinAfter: minOut,
    wsolBefore: null, wsolAfter: null, others: [], wsolLamportsBefore: BigInt(fx.wsolLamportsBefore), wsolLamportsAfter: BigInt(fx.wsolLamportsAfter),
  }), /more SOL than the amount/);
});

test('rent paid by someone else is not counted', () => {
  const other = JSON.parse(JSON.stringify(fx.inner));
  for (const g of other) for (const x of g.instructions) if (x.program === 'system' && x.parsed?.type === 'createAccount') x.parsed.info.source = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  assert.deepEqual(jupInnerRent(other, fx.user), { rent: 0n, opens: 0 });
});
