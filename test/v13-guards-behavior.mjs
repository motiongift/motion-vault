// V13 hardening — behaviour tests of the pure decisions in src/v13Guards.ts (security audit 2026-10-25, VA-1 … VA-5).
// webEngine.ts calls exactly these functions (pinned in test/v13-source-pin.mjs). Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BUY, tradeSizeProblem, ledgerAdd, BUY_WINDOW_MS, LEDGER_MAX, SLIP_SILENT, slipNeedsClick, slipCeiling,
  routeSig, sameRoute, selfCanonical, v2UnknownHops, v4Candidates, infCandidates, infParameters, infTickSpacing, sameKey, pickPool,
  relayQuoteProblem, BRIDGE_APP_FEE, needsChallenge, challengeCode, challengeOk, tooSoon, MIN_DWELL_MS,
} from '../src/v13Guards.ts';

const T = '0x1111111111111111111111111111111111111111';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ZERO = '0x0000000000000000000000000000000000000000';

// ── VA-2 ──
test('VA-2: buy(t, -1e300), NaN, Infinity, 0, strings and sizes above the lane maximum are refused before anything is recorded', () => {
  for (const bad of [-1e300, -1, 0, NaN, Infinity, -Infinity, '1', null, undefined, 101]) assert.equal(tradeSizeProblem('buy', bad, MAX_BUY.robinhood), 'Amount out of range', String(bad));
  assert.equal(tradeSizeProblem('buy', 0.01, MAX_BUY.robinhood), null);
  assert.equal(tradeSizeProblem('buy', 100, MAX_BUY.robinhood), null);
  for (const bad of [0, -5, 100.01, NaN, Infinity]) assert.ok(tradeSizeProblem('sell', bad, 100), String(bad));
  assert.equal(tradeSizeProblem('sell', 0.01, 100), null);
  assert.equal(tradeSizeProblem('sell', 100, 100), null);
});

test('VA-2: a negative or non-finite stored entry counts as 0 — the hourly total can only grow', () => {
  const now = 1_800_000_000_000;
  const { sum } = ledgerAdd([[now - 1000, -1e300], [now - 2000, 'x'], [now - 3000, 2]], now, 0.5);
  assert.equal(sum, 2.5);
  assert.equal(ledgerAdd([[now - 1000, Infinity]], now, 1).sum, 1);
});

test('VA-2: 500 zero-sized buys cannot push real spending out of the window (folded, not dropped)', () => {
  const now = 1_800_000_000_000;
  let entries = [[now - 10_000, 7]];
  for (let i = 0; i < 600; i += 1) entries = ledgerAdd(entries, now - 9000 + i, 0).entries;
  const { entries: last, sum } = ledgerAdd(entries, now, 0.1);
  assert.ok(last.length <= LEDGER_MAX);
  assert.ok(Math.abs(sum - 7.1) < 1e-9, `sum ${sum}`);
});

test('VA-2: entries leave the ledger by age only (and a future-dated entry is ignored)', () => {
  const now = 1_800_000_000_000;
  const { sum } = ledgerAdd([[now - BUY_WINDOW_MS - 1, 5], [now - BUY_WINDOW_MS + 1000, 3], [now + 10 * 60_000, 9]], now, 1);
  assert.equal(sum, 4);
});

// ── VA-1 (slippage) ──
test('VA-1: a page may lower slippage or raise it to 15 % silently; above that (or above what was confirmed) a click', () => {
  assert.equal(SLIP_SILENT, 15);
  assert.equal(slipNeedsClick(12, undefined), false);
  assert.equal(slipNeedsClick(15, undefined), false);
  assert.equal(slipNeedsClick(22, undefined), true);            // the audit's settingsSet({ slippage: 22 })
  assert.equal(slipNeedsClick(22, 30), false);                  // the user confirmed 30 % in the vault before
  assert.equal(slipNeedsClick(31, 30), true);
  assert.equal(slipCeiling(undefined), 15);
  assert.equal(slipNeedsClick(NaN, undefined), false);
});

// ── VA-1 (the vault's own route vs the page's hint) ──
test('VA-1: the page\'s copy of the same /route answer compares equal (case, key order); another pool does not', () => {
  const server = { type: 'v4', chainId: 4663, pair: 'native', poolKey: { currency0: ZERO, currency1: T, fee: 3000, tickSpacing: 60, hooks: ZERO } };
  const page = { poolKey: { hooks: ZERO, tickSpacing: 60, fee: 3000, currency1: T.toUpperCase().replace('0X', '0x'), currency0: ZERO }, pair: 'native', chainId: 4663, type: 'v4' };
  assert.ok(sameRoute(server, page));
  const attacker = { ...server, poolKey: { ...server.poolKey, fee: 0, tickSpacing: 1 } };
  assert.ok(!sameRoute(server, attacker));
  assert.ok(!sameRoute(server, null));
  assert.equal(routeSig(server), routeSig(page));
});

test('VA-1: without the vault\'s own read only routes whose pool no page can choose are signed', () => {
  const known = { hooks: new Set(), bridgeTokens: new Set([WETH, '0x5fc5360d0400a0fd4f2af552add042d716f1d168']) };
  assert.ok(selfCanonical({ type: 'pons', bridgeHops: [] }, known, T));
  assert.ok(selfCanonical({ type: 'four' }, known, T));
  assert.ok(selfCanonical({ type: 'standard' }, known, T));
  assert.ok(selfCanonical({ type: 'v4', pair: 'native' }, known, T));          // compared on chain (pickPool)
  assert.ok(!selfCanonical({ type: 'v4', pair: 'usdg' }, known, T));           // bridge tier chosen by the page
  assert.ok(!selfCanonical({ type: 'pons', bridgeHops: [WETH, '0x5fc5360d0400a0fd4f2af552add042d716f1d168'], bridgeFees: [500] }, known, T));
  assert.ok(!selfCanonical({ type: 'v3' }, known, T));                         // the tier is the page's
  assert.ok(selfCanonical({ type: 'v2', path: [WETH, T] }, known, T));
  assert.ok(!selfCanonical({ type: 'v2', path: [WETH, '0x2222222222222222222222222222222222222222', T] }, known, T));
  assert.ok(!selfCanonical({ type: 'v2', path: [] }, known, T));               // bridged V2 (V3 leg tier)
});

test('VA-1: V2 hops through assets the chain does not know are named (a sell through them needs the vault dialog)', () => {
  const bridge = new Set([WETH]);
  assert.deepEqual(v2UnknownHops([WETH, T], bridge, T), []);
  assert.deepEqual(v2UnknownHops([WETH, '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa', T], bridge, T), ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
});

test('VA-1: hookless candidates are the standard tiers against the gas token AND its wrapped form, sorted keys', () => {
  const c = v4Candidates(T, WETH);
  assert.equal(c.length, 8);
  for (const x of c) { assert.equal(x.key.hooks, ZERO); assert.ok(BigInt(x.key.currency0) < BigInt(x.key.currency1)); }
  assert.deepEqual(c.filter((x) => x.pair === 'native').map((x) => [x.key.fee, x.key.tickSpacing]), [[100, 1], [500, 10], [3000, 60], [10000, 200]]);
  const inf = infCandidates(T, WETH, '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b');
  assert.equal(inf.length, 8);
  assert.deepEqual(inf.map((x) => infTickSpacing(x.key.parameters)).slice(0, 4), [1, 10, 50, 200]);
  assert.equal(infParameters(10), '0x' + (10n << 16n).toString(16).padStart(64, '0'));
  assert.ok(sameKey(c[0].key, { ...c[0].key }));
});

test('VA-1: the attacker\'s dust pool loses to a real tier; a hint within 2 % stands; nothing quoted → refuse', () => {
  const real = { key: 'real', pair: 'native', out: 1_000_000n };
  // the audit's scenario: hookless pool with dust at an absurd price
  assert.deepEqual(pickPool({ key: 'attacker', out: 10n }, [real]), { use: 'candidate', key: 'real', pair: 'native', out: 1_000_000n });
  assert.deepEqual(pickPool({ key: 'hint', out: 985_000n }, [real]), { use: 'hint' });           // within 2 %
  assert.equal(pickPool({ key: 'hint', out: 979_000n }, [real]).use, 'candidate');               // more than 2 % below
  assert.deepEqual(pickPool({ key: 'hint', out: 5n }, [{ key: 'none', pair: 'weth', out: null }]), { use: 'hint' });   // no candidate pool exists
  assert.deepEqual(pickPool({ key: 'hint', out: null }, []), { use: 'refuse' });
  assert.equal(pickPool({ key: 'hint', out: 0n }, [real]).use, 'candidate');
});

// ── VA-3 ──
const relayAnswer = (o = {}) => ({
  requestId: '0x' + 'ab'.repeat(32),
  steps: [{ kind: 'transaction', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', chainId: 8453, value: '10000000000000000', data: '0x49290c1c' } }] }],
  details: { sender: '0x000000000000000000000000000000000000dEaD', recipient: '0x000000000000000000000000000000000000bEEF', currencyIn: { amount: '10000000000000000', currency: { chainId: 8453 } }, currencyOut: { amount: '1', currency: { chainId: 42161 } } },
  ...o,
});
const want = { user: '0x000000000000000000000000000000000000dead', recipient: '0x000000000000000000000000000000000000beef', originChainId: 8453, destinationChainId: 42161, amount: '10000000000000000', evm: (id) => id !== 792703809 };
test('VA-3: the vault signs Relay\'s own answer only when it names this depositor, the confirmed recipient, chains and amount', () => {
  assert.equal(relayQuoteProblem(relayAnswer(), want), null);
  assert.match(relayQuoteProblem(relayAnswer({ details: { ...relayAnswer().details, recipient: '0x000000000000000000000000000000000000c0de' } }), want), /another recipient/);
  assert.match(relayQuoteProblem(relayAnswer({ details: { ...relayAnswer().details, sender: '0x000000000000000000000000000000000000c0de' } }), want), /another depositor/);
  assert.match(relayQuoteProblem(relayAnswer({ details: { ...relayAnswer().details, currencyIn: { amount: '1', currency: { chainId: 8453 } } } }), want), /another amount/);
  assert.match(relayQuoteProblem(relayAnswer({ requestId: 'nope' }), want), /request id/);
  assert.match(relayQuoteProblem(relayAnswer({ steps: [] }), want), /deposit step/);
  const wrongValue = relayAnswer(); wrongValue.steps[0].items[0].data.value = '1';
  assert.match(relayQuoteProblem(wrongValue, want), /value/);
  const wrongChain = relayAnswer(); wrongChain.steps[0].items[0].data.chainId = 1;
  assert.match(relayQuoteProblem(wrongChain, want), /another chain/);
});
test('VA-3: a Solana-origin answer is checked by its instructions and base58 names (case-sensitive)', () => {
  const sol = 'So1anaWa11et1111111111111111111111111111111';
  const ans = { requestId: '0x' + 'cd'.repeat(32), steps: [{ kind: 'transaction', items: [{ data: { instructions: [{}], addressLookupTableAddresses: [] } }] }], details: { sender: sol, recipient: want.recipient, currencyIn: { amount: '5', currency: { chainId: 792703809 } }, currencyOut: { currency: { chainId: 8453 } } } };
  const w = { ...want, user: sol, originChainId: 792703809, destinationChainId: 8453, amount: '5' };
  assert.equal(relayQuoteProblem(ans, w), null);
  assert.match(relayQuoteProblem({ ...ans, details: { ...ans.details, sender: sol.toLowerCase() } }, w), /depositor/);
});
test('VA-3: the app fee the vault asks Relay for is pinned (recipient, ≤ 50 bps)', () => {
  assert.match(BRIDGE_APP_FEE.recipient, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(BRIDGE_APP_FEE.bps >= 0 && BRIDGE_APP_FEE.bps <= 50);
});

// ── VA-5 ──
test('VA-5: outside Chromium a danger dialog in the frame asks for the code drawn inside it; clicks within 600 ms are ignored', () => {
  assert.equal(needsChallenge(true, false, true), true);     // Safari / Firefox, danger dialog in the vault frame
  assert.equal(needsChallenge(true, true, true), false);     // Chromium: IntersectionObserver v2 decides
  assert.equal(needsChallenge(true, false, false), false);   // a plain dialog: the dwell only
  assert.equal(needsChallenge(false, false, true), false);   // inline engine (no frame to overlay)
  const code = challengeCode(Uint8Array.of(0xff, 0xff));
  assert.match(code, /^[1-9]\d{2}$/);
  assert.ok(challengeOk(` ${code} `, code));
  assert.ok(!challengeOk('', code));
  assert.ok(!challengeOk(String(Number(code) + 1), code));
  assert.equal(MIN_DWELL_MS, 600);
  assert.ok(tooSoon(1000, 1000 + MIN_DWELL_MS - 1));
  assert.ok(!tooSoon(1000, 1000 + MIN_DWELL_MS));
  assert.ok(tooSoon(Infinity, 5));   // a click before the dialog is even in the document
});
