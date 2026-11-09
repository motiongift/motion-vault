// fee-sprint-1109 merge: the legacy gate (src/terminalFeeGate.ts, PREP-1108 legacy-gate-extend) composed with the fee leg
// (src/terminalFeeLeg.ts). Runs the REAL feeLegOn / legacyOrFeeLeg / relayGate declarations cut out of src/webEngine.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cut, source } from './sec-cut.mjs';
const SRC = source();
const isFeeChain = c => ['robinhood', 'bsc', 'sol'].includes(c);
function world({ required = {}, leg = {} } = {}) {
  const refused = [];
  const assertLegacyTerminalAllowed = (chain, surface) => { if (required[chain] === true) { refused.push([chain, surface]); throw Object.assign(new Error('gated'), { code: 'TerminalPolicyRequired' }); } };
  const gatedCall = (chain, surface, run) => { try { assertLegacyTerminalAllowed(chain, surface); } catch (e) { return Promise.reject(e); } return run(); };
  const TERMINAL_FEE_LEG = { enabled: { robinhood: false, bsc: false, sol: false, ...leg } };
  return { refused, ...cut(['feeLegOn', 'legacyOrFeeLeg', 'relayGate'], { isFeeChain, TERMINAL_FEE_LEG, gatedCall, assertLegacyTerminalAllowed }) };
}
test('shipped OFF: nothing is gated, limit.place runs, relay passes', async () => {
  const w = world();
  assert.equal(await w.legacyOrFeeLeg('robinhood', 'limit.place', async () => 'placed'), 'placed');
  w.relayGate('robinhood', 'bsc'); w.relayGate('sol'); w.relayGate('unknown');
  assert.deepEqual(w.refused, []);
});
test('gate ON, leg OFF: limit.place and relaySwap are refused (legacy-gate-extend behaviour)', async () => {
  const w = world({ required: { robinhood: true } });
  let ran = false;
  await assert.rejects(w.legacyOrFeeLeg('robinhood', 'limit.place', async () => { ran = true; }), /gated/);
  assert.equal(ran, false);
  assert.throws(() => w.relayGate('robinhood'), /gated/);
});
test('gate ON, leg ON: limit.place runs (it pays its own fee); relay passes only when the origin also pays', async () => {
  const w = world({ required: { robinhood: true, bsc: true }, leg: { robinhood: true } });
  assert.equal(await w.legacyOrFeeLeg('robinhood', 'limit.place', async () => 'placed'), 'placed');
  w.relayGate('robinhood', 'robinhood'); w.relayGate('robinhood');
  assert.throws(() => w.relayGate('robinhood', 'unknown'), /gated/, 'frame leg must not waive a foreign-origin swap');
  assert.throws(() => w.relayGate('bsc'), /gated/, 'bsc has no leg');
  await assert.rejects(w.legacyOrFeeLeg('bsc', 'limit.place', async () => 'x'), /gated/);
});
// release 19 (test/fee-enforce.mjs): market buy and float.buy go through the per-market gate, a sell is never gated; still no
// fee-leg waiver on any of them
test('market buy and float.buy stay on the legacy gate (per market, no fee-leg waiver); sell is never gated', () => {
  assert.match(SRC, /buy: \(token: string, amount: number, accountIds\?: string\[\], hint\?: unknown, opts\?: unknown\) => gatedBuy\(laneKey\(\), 'trade', /);
  assert.match(SRC, /sell: \(token: string, percent: number, accountIds\?: string\[\], hint\?: unknown, opts\?: unknown\) => clickRun\(\(\) => trade\('sell', /);
  assert.match(SRC, /buy: \(o: unknown\) => gatedBuy\(laneKey\(\), 'float\.buy', /);
  assert.doesNotMatch(SRC, /legacyOrFeeLeg\(laneKey\(\), '(trade|float\.buy)'/);
});
test('every fee switch in this build is OFF', () => {
  const r = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
  assert.match(r('terminalFeeGate.ts'), /REQUIRED: Readonly<Record<string, boolean>> = Object\.freeze\(\{ robinhood: false, bsc: false, sol: false \}\)/);
  assert.match(r('terminalFeeLeg.ts'), /enabled: \{ robinhood: false, bsc: false, sol: false \}/);
  assert.match(r('terminalEvmConfig.ts'), /TERMINAL_EVM_POLICY: [^\n]*\| null = null;\n$/);
  assert.match(r('terminalEvmConfig.ts'), /TERMINAL_EVM_BNB_VENUES: [^\n]*= Object\.freeze\(\[\]\);/);
  assert.match(r('terminalEvmConfig.ts'), /TERMINAL_EVM_PONS_V2: boolean = false;/);
  assert.match(r('terminalFeePolicyConfig.ts'), /TERMINAL_FEE_POLICY: PinnedFeePolicy \| null = null;/);
  assert.match(r('terminalFeeConfig.ts'), /TERMINAL_SOL_POLICY: TerminalPolicy \| null = null;/);
});
test('policy review guarantees hold in the merged source (fee check before claim/sign; allowlists unchanged when null)', () => {
  assert.match(SRC, /TERMINAL_FEE_POLICY \? \['walletId', 'side', 'token', 'size', 'envelope', 'serialized', 'feePolicy'\] : \['walletId', 'side', 'token', 'size', 'envelope', 'serialized'\]/);
  assert.match(SRC, /TERMINAL_FEE_POLICY \? \['walletId', 'side', 'token', 'size', 'transaction', 'route', 'feePolicy'\] : \['walletId', 'side', 'token', 'size', 'transaction', 'route'\]/);
  const evm = SRC.slice(SRC.indexOf('async function terminalTradeEvm'));
  const at = s => evm.indexOf(s);
  assert.ok(at('assertQuoteMatchesDecision') > 0 && at('assertQuoteMatchesDecision') < at('journal.claim(') && at('assertQuoteMatchesDecision') < at('signTransaction'));
  const sol = SRC.slice(SRC.indexOf('async function terminalTrade(request'), SRC.indexOf('async function terminalTradeEvm'));
  assert.ok(sol.indexOf('assertQuoteMatchesDecision') > 0 && sol.indexOf('assertQuoteMatchesDecision') < sol.indexOf('solTerminalTrade('));
  assert.ok(sol.indexOf('if (!TERMINAL_SOL_POLICY) throw') >= 0 && sol.indexOf('if (!TERMINAL_SOL_POLICY) throw') < sol.indexOf('TERMINAL_FEE_POLICY'), 'SOL lane fast-fails before the fee-policy block');
});
