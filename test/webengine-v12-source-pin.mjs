// V12 batch-1 source pins for src/webEngine.ts (the EVM wallet/trading engine).
// These assert each fix in this clone is still present, so a later edit that silently
// drops one fails CI. Refs = motion-vault 2673f23 (the live engine). Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const eng = readFileSync(join(here, '..', 'src', 'webEngine.ts'), 'utf8');

test('F-6: applySlippage refuses a non-positive minimum-out floor', () => {
  assert.match(eng, /F-6 \(V12\)/);
  assert.match(eng, /if \(floor <= 0n\) throw new Error\('Refusing to trade without a minimum-out floor'\)/);
});

test('F-37 + F-6 + F-8: settingsSet gates nodes, gas boost and Solana tip/priority', () => {
  assert.match(eng, /F-37 \+ F-6 \+ F-8 \(V12\)/);
  // RPC change -> trusted click; decline drops the change
  assert.match(eng, /title: 'Change network nodes', danger: true/);
  assert.match(eng, /if \(!ok\) delete s\.rpcs;/);
  // gas boost raised above stored -> ask, else revert to stored
  assert.match(eng, /title: 'Raise the gas boost', danger: true/);
  assert.match(eng, /if \(want > now && !\(await ask\([\s\S]*?\)\)\) delete s\.gasBoost;/);
  // Solana tip + priority raised above stored -> ask, else revert
  assert.match(eng, /title: 'Raise the Solana tip', danger: true/);
  assert.match(eng, /delete s\.solTip;/);
  assert.match(eng, /title: 'Raise the Solana priority fee', danger: true/);
  assert.match(eng, /delete s\.solPriority;/);
  // the gate runs BEFORE saveSettings
  assert.ok(eng.indexOf("title: 'Change network nodes'") < eng.indexOf('const settings = saveSettings(s);'), 'gate must run before saveSettings');
});

test('F-36 + F-65: V4 checkRoute binds pair, rejects unknown hooks and caps the fee', () => {
  assert.match(eng, /F-36 \+ F-65 \(V12\)/);
  assert.match(eng, /reject\('V4 pair mode does not match the pool'\)/);
  assert.match(eng, /const knownV4 = KNOWN_HOOKS\.has\(lc\(pk\.hooks\)\), hooklessV4 = same\(pk\.hooks, ZERO\);/);
  assert.match(eng, /if \(!knownV4 && !\(hooklessV4 && knownQuote\(other\)\)\) reject\('V4 pool has an unknown hook and an unknown quote asset'\)/);
  assert.match(eng, /const feeV4 = Number\(pk\.fee\); if \(feeV4 === DYNAMIC_FEE_FLAG \? !knownV4 : feeV4 > MAX_STATIC_FEE\) reject\('V4 fee is above the ceiling'\)/);
  // the constants are imported from the router module
  assert.match(eng, /DYNAMIC_FEE_FLAG, MAX_STATIC_FEE,/);
});

test('F-36 + F-65: Infinity checkRoute mirrors the V4 binding/hook/fee checks', () => {
  assert.match(eng, /reject\('Infinity pair mode does not match the pool'\)/);
  assert.match(eng, /const feeInf = Number\(pk\.fee\); if \(feeInf === DYNAMIC_FEE_FLAG \? !knownInf : feeInf > MAX_STATIC_FEE\) reject\('Infinity fee is above the ceiling'\)/);
});

test('F-57: V3 checkRoute restricts the quote asset to known bridge assets or Standard stocks', () => {
  assert.match(eng, /F-57 \(V12\)/);
  assert.match(eng, /const STD_STOCKS = new Set\(Object\.keys\(CFG\.standard\?\.stocks \|\| \{\}\)\.map\(lc\)\);/);
  assert.match(eng, /if \(!knownQuote\(route\.quoteToken\) && !STD_STOCKS\.has\(lc\(route\.quoteToken\)\)\) reject\('V3 quote asset is not a known one'\)/);
});

test('F-57: BSC V3 sells are guarded against fee-tier manipulation (one multicall, >102%)', () => {
  assert.match(eng, /const v3TierGuard = async \(quoteAsset: `0x\$\{string\}`\) => \{/);
  assert.match(eng, /if \(side !== 'sell' \|\| CFG\.key !== 'bsc' \|\| !multicallOk\) return;/);
  assert.match(eng, /if \(best \* 100n > chosen \* 102n\) reject\('a PancakeSwap V3 pool at another fee tier pays materially more for this sell — the route tier looks manipulated'\)/);
  // wired into both V3 sell paths
  assert.equal((eng.match(/await v3TierGuard\(/g) || []).length, 2);
});

test('F-57: a V3 sell unwraps only what the sell delivered, never `quoted`', () => {
  // the old buggy unwrap(acct.id, quoted) is gone
  assert.ok(!/unwrap\(acct\.id, quoted\)/.test(eng), 'old unwrap(acct.id, quoted) still present');
  // both V3 sell tails read before/after and unwrap the delta
  assert.equal((eng.match(/const got = afterWeth - beforeWeth;/g) || []).length, 2);
  assert.equal((eng.match(/if \(got > 0n\) await unwrap\(acct\.id, got\)\.catch\(\(\) => \{\}\);/g) || []).length, 2);
});

test('F-53: walk-backs sweep only delta+owed, capped at balance, via a per-wallet+quote ledger', () => {
  assert.match(eng, /F-53 \(V12\)/);
  assert.match(eng, /const LEFTOVER_KEY = 'trenches\.engine\.leftovers';/);
  assert.match(eng, /const leftoverOwed = \(wallet: string, quote: string\): bigint =>/);
  assert.match(eng, /const leftoverAdd = \(wallet: string, quote: string, amount: bigint\) =>/);
  assert.match(eng, /const leftoverClear = \(wallet: string, quote: string\) =>/);
  // bridgeBack takes the pre-sell balance and walks back only the delta + recorded leftovers
  assert.match(eng, /const bridgeBack = \(quote: `0x\$\{string\}`, r: Bridge, hash: `0x\$\{string\}`, before: bigint\) =>/);
  assert.match(eng, /let amount = \(bal > before \? bal - before : 0n\) \+ owed;\s*\n\s*if \(amount > bal\) amount = bal;/);
  // pons walk-back uses the same delta+owed pattern against the pre-sell pair balance
  assert.match(eng, /let amount = \(bal > beforePair \? bal - beforePair : 0n\) \+ owed;/);
  // a bridged buy records its leftover so the coin's next sell can reclaim it
  assert.match(eng, /leftoverAdd\(account\.address, quote, q - floor\);/);
  // the old "swap the whole balanceOf" amountIn: bal is gone from the walk-backs
  assert.ok(!/amountIn: bal, amountOutMinimum: 0n/.test(eng), 'a walk-back still swaps the whole balance');
});

test('F-73: chain cfg has generous gas ceilings; feeFloor and signAndSend enforce them', () => {
  assert.match(eng, /F-73 \(V12\)/);
  assert.match(eng, /maxGasPrice\?: bigint; maxFeeWei\?: bigint;/);
  assert.match(eng, /maxGasPrice: parseGwei\('20'\), maxFeeWei: parseEther\('0\.1'\)/);   // Robinhood
  assert.match(eng, /maxGasPrice: parseGwei\('50'\), maxFeeWei: parseEther\('0\.5'\)/);   // BSC
  // feeFloor throws above the ceiling (and never caches the bad value)
  assert.match(eng, /if \(CFG\.maxGasPrice && floor > CFG\.maxGasPrice\) throw new Error\('Gas price is far above normal/);
  assert.ok(eng.indexOf('if (CFG.maxGasPrice && floor > CFG.maxGasPrice) throw') < eng.indexOf('feeCache = { floor, at: Date.now() };'), 'feeFloor must throw before caching');
  // signAndSend refuses before signing
  assert.match(eng, /if \(CFG\.maxGasPrice && gasPrice > CFG\.maxGasPrice \* 5n\) throw new Error\('Refusing to sign: gas price is far above normal/);
  assert.match(eng, /if \(CFG\.maxFeeWei && effGas > 0n && effGas \* gasPrice > CFG\.maxFeeWei\) throw new Error\('Refusing to sign: this transaction would spend/);
});
