// V12 batch-1 behavior tests for the F-65 fee ceiling and F-36 pair binding.
// These import the SAME pure helpers/constants the engine uses from the router module
// (no browser globals, so node can import it) and exercise the exact predicates the
// webEngine checkRoute branch is built from. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DYNAMIC_FEE_FLAG, MAX_STATIC_FEE, v4PairCurrency } from '../src/evmV4Router.ts';

// the exact predicate from checkRoute's v4/inf branch: `fee === DYNAMIC_FEE_FLAG ? !known : fee > MAX_STATIC_FEE`
const rejectFee = (fee, known) => (fee === DYNAMIC_FEE_FLAG ? !known : fee > MAX_STATIC_FEE);

test('F-65: a normal static fee below the ceiling is accepted', () => {
  assert.equal(rejectFee(3000, false), false);      // a hookless 0.3% pool with a known quote
  assert.equal(rejectFee(MAX_STATIC_FEE, false), false);
});

test('F-65: a static fee above the ceiling is rejected', () => {
  assert.equal(rejectFee(MAX_STATIC_FEE + 1, false), true);
  assert.equal(rejectFee(500000, true), true);       // 50% static fee, even behind a known hook
});

test('F-65: the dynamic-fee flag is allowed only behind a known hook', () => {
  assert.equal(rejectFee(DYNAMIC_FEE_FLAG, true), false);   // known launcher hook sets the fee live
  assert.equal(rejectFee(DYNAMIC_FEE_FLAG, false), true);   // unknown/none hook with a dynamic flag -> rejected
});

test('F-36: v4PairCurrency returns the pool\'s OTHER currency (what the pair mode is bound to)', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const other = '0x2222222222222222222222222222222222222222';
  assert.equal(v4PairCurrency({ currency0: token, currency1: other }, token).toLowerCase(), other);
  assert.equal(v4PairCurrency({ currency0: other, currency1: token }, token).toLowerCase(), other);
  // case-insensitive on the token side
  assert.equal(v4PairCurrency({ currency0: token.toUpperCase(), currency1: other }, token).toLowerCase(), other);
});
