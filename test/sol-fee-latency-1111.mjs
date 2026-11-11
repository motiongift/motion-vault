// fee-final-1111 — the latency evidence docs/TRADE-CORE.md §4 asks for, in a form that cannot rot.
//
// The rule (§5): "anything that adds a request, an await, a dialog or a check between a click and the send IS a core change".
// The SOL fee leg adds NO network round trip and NO await on any click that succeeds:
//   · tradeOne        the collector's account rides in the EXISTING getMultipleAccounts of the market read (4th address)
//   · jupiterTradeOne the collector rides in the EXISTING accounts([user, coinAta, wsolAta]) read (4th address)
//   · directPlanAt    the collector's USDC account rides in the EXISTING accounts([...]) read (5th address)
//   · the fee instruction, the size check and the balance-guard arithmetic are pure CPU (no await, no fetch)
// The only extra reads exist on paths that used to END THE TRADE:
//   · one more simulate when the simulation failed WITH the fee (review #7) — before, that click threw;
//   · one more Jupiter build when the collector's readiness changed since the last click (the early build was priced on the
//     old reading) — at most once per change.
// This file counts the awaits and the network calls of each changed function against release 20, so a later edit that smuggles
// a round trip in front of a click fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
const BASE = execFileSync('git', ['show', '624791b:src/solEngine.ts'], { cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** the body of a top-level `async function <name>(` … up to the next top-level `}` */
function body(src, name) {
  const i = src.indexOf(`async function ${name}(`);
  assert.ok(i > 0, `${name} found`);
  const j = src.indexOf('\n}\n', i);
  assert.ok(j > i, `${name} body ends`);
  return src.slice(i, j);
}
const count = (s, re) => (s.match(re) || []).length;
const AWAIT = /\bawait\b/g;
const NET = /\b(fetch|rpc|rpcAll|accounts|readBatch|readMarket|simulate|simulateSeeing|blockhash|sendPlan|jupBuild|jupBuildDirect|motionPriceSol|motionPriceUsd|walletTokenAccounts|getTokenAccounts)\s*\(/g;

test('tradeOne: the fee adds no await and no network call (the collector rides in the market read)', () => {
  const now = body(SRC, 'tradeOne'), was = body(BASE, 'tradeOne');
  // one more simulate(), and it is the review-#7 retry that only runs when the first simulation FAILED
  assert.equal(count(now, AWAIT) - count(was, AWAIT), 1, 'exactly one await more');
  assert.match(now, /if \(sim\.err && leg\.on\) \{\s*\n\s*const sim2 = await simulate\(/, 'and it is behind `sim.err` (a click that used to throw)');
  // the collector is the 4th address of the read that was already there
  assert.match(now, /readMarket\(route, \[user, ataOf\(user, route\.mint, route\.tokenProgram\), uva\(route\), SOL_MARKET_FEE\.collector\]\)/);
  assert.equal(count(now, /readMarket\s*\(/g), count(was, /readMarket\s*\(/g), 'no extra market read');
  assert.equal(count(now, /\bsendPlan\s*\(/g), count(was, /\bsendPlan\s*\(/g));
  assert.equal(count(now, /\bblockhash\s*\(/g), count(was, /\bblockhash\s*\(/g));
});

test('jupiterTradeOne: the fee adds no await on the path that sends; the collector rides in the wallet read', () => {
  const now = body(SRC, 'jupiterTradeOne'), was = body(BASE, 'jupiterTradeOne');
  assert.equal(count(now, AWAIT) - count(was, AWAIT), 1, 'exactly one await more');
  assert.match(now, /if \(sim\.err && feeIxs\.length\) \{\s*\n\s*const bare = [\s\S]{0,200}?const sim2 = await simulateSeeing\(/, 'and it is behind `sim.err`');
  assert.match(now, /await accounts\(\[user, coinAta, wsolAta, SOL_MARKET_FEE\.collector\]\)/, 'the collector is the 4th address of the read that was already there');
  assert.equal(count(now, /\baccounts\s*\(/g), count(was, /\baccounts\s*\(/g), 'no extra wallet read');
  // the one conditional extra Jupiter build: only when this click's reading of the collector differs from the last click's
  assert.match(now, /const built0 = await \(bEarly && amount === earlyIn \? bEarly : jupBuild\(/);
  assert.match(now, /solCollectorLastReady = solBuyLeg\(1_000_000n, colAcc\)\.on;/);
});

test('directPlanAt (the USD-balance buy): the collector\'s USDC account rides in the read that was already there', () => {
  const now = body(SRC, 'directPlanAt'), was = body(BASE, 'directPlanAt');
  assert.equal(count(now, AWAIT) - count(was, AWAIT), 2, 'two awaits more: the review-#7 retry and the conditional rebuild');
  assert.match(now, /if \(sim\.err && feeIxs\.length\) \{/, 'the retry is behind `sim.err`');
  assert.match(now, /const built = jupIn === earlyIn \? await bP : await jupBuildDirect\(/, 'the rebuild only when the early build was priced on another reading');
  assert.match(now, /await accounts\(\[R, usdcAta, wCoinAta, rCoinAta, SOL_MARKET_FEE\.usdcCollectorAta\]\)/);
  assert.equal(count(now, /\baccounts\s*\(/g), count(was, /\baccounts\s*\(/g), 'no extra read');
});

test('the fee module itself is pure: no fetch, no await, no timer, no storage', () => {
  const fee = readFileSync(new URL('../src/solMarketFee.ts', import.meta.url), 'utf8');
  for (const re of [/\bfetch\s*\(/, /\bawait\b/, /setTimeout|setInterval/, /localStorage|sessionStorage|indexedDB/, /\bimport\s*\(/]) {
    assert.equal(re.test(fee), false, `src/solMarketFee.ts has no ${re}`);
  }
  // and nothing outside this file can change the collector, the rate or the switch
  assert.match(fee, /export const SOL_MARKET_FEE: Readonly<[\s\S]*?> = Object\.freeze\(\{/);
  assert.equal((fee.match(/enabled: (true|false)/g) || []).length, 1, 'the switch is written exactly once');
});

test('webEngine: the Solana coverage gate now does LESS work in front of a click than release 20', () => {
  const now = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const fn = (s) => s.slice(s.indexOf('function buyCovered('), s.indexOf('function buyCovered(') + 1400);
  const base = execFileSync('git', ['show', '624791b:src/webEngine.ts'], { cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = fn(now), b = fn(base);
  // release 20 read the route after a SOL click to classify it; with the fee inside the transaction there is nothing to classify
  assert.match(a, /if \(SOL_MODE && SOL_MARKET_FEE\.enabled\) return null;/);
  assert.ok(a.indexOf('if (SOL_MODE && SOL_MARKET_FEE.enabled) return null;') < a.indexOf('solRoute('), 'it returns before the route read');
  assert.match(b, /if \(SOL_MODE\) return typeof token === 'string'/, 'release 20 read the route');
});
