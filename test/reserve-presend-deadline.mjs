// The pre-send deadline of the buy straight from the USD reserve (owner 2026-11-01: «даю добро делай»; src/preSendDeadline.ts).
// A reserve direct buy (webEngine usdBuy on Solana, usdBuyEvm on Robinhood / BNB) whose build stalls BEFORE anything is handed
// to broadcast is answered "not started … nothing was sent" after PRE_SEND_MS and lets go of the per-wallet trade guard; a build
// that passed the gate (may have broadcast) keeps today's behaviour and the guard.
//
// webEngine.ts needs browser globals, so the REAL usdBuy / usdBuyEvm / tradeGuard / pooled are cut out of the source
// (scripts/trade-core.mjs declChunk), transpiled, and run against stubs of everything around them — the wiring under test is the
// shipped code, byte for byte. PRE_SEND_MS is stubbed to 60 ms for the clock.
//   node --test test/reserve-presend-deadline.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { declChunk } from '../scripts/trade-core.mjs';
import { preSendDeadline, PRE_SEND_MS, LATE_TEXT } from '../src/preSendDeadline.ts';
import { solDirectNeedOf } from '../src/floatCore.ts';   // usdBuy reads the refused build's figure (2026-11-01)

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const SOL = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

// the app's rules (motion-ios src/domain/usdHold.ts, 2026-11-01): a direct refusal that matches DIRECT_FALLBACK and not
// STILL_SENDING falls back to hold & fire
const DIRECT_FALLBACK = /not available|off for this wallet|holds .* USDC — less|reserve needs about|Bad arguments|unknown method|no fresh price|route pays far less than the market price|found no route|answered for a different trade|not supported yet|does not fit|nothing was sent|previous send from this wallet .*unknown status/i;
const STILL_SENDING = /is still being sent/i;
const APP = 'B:/rework/motion-ios/src/domain/usdHold.ts';

// ── the pure deadline ──
test('PRE_SEND_MS is 20 s and the late text is a fallback refusal for the app (nothing was sent, not "still being sent")', () => {
  assert.equal(PRE_SEND_MS, 20_000);
  assert.match(LATE_TEXT, /nothing was sent/);
  assert.ok(DIRECT_FALLBACK.test(LATE_TEXT) && !STILL_SENDING.test(LATE_TEXT));
  if (existsSync(APP)) {
    const app = readFileSync(APP, 'utf8');
    assert.ok(app.includes(`export const DIRECT_FALLBACK = ${DIRECT_FALLBACK.toString()};`), 'the app\'s DIRECT_FALLBACK is the one copied here');
    assert.ok(app.includes(`export const STILL_SENDING = ${STILL_SENDING.toString()};`));
  }
});

test('preSendDeadline: a build stalled before the gate is answered late; its gate then says false', async () => {
  let ctl;
  const t0 = performance.now();
  const v = await preSendDeadline(40, (c) => { ctl = c; return never(); }, () => 'late');
  assert.equal(v, 'late'); assert.ok(performance.now() - t0 >= 35);
  assert.equal(ctl.late(), true); assert.equal(ctl.gate(), false); assert.equal(ctl.gate(), false, 'never flips back');
});

test('preSendDeadline: past the gate the deadline is off for good, however long the send takes', async () => {
  let onLate = 0;
  const v = await preSendDeadline(30, async (c) => { assert.equal(c.gate(), true); await sleep(90); assert.equal(c.late(), false); assert.equal(c.gate(), true); return 'sent'; }, () => { onLate += 1; return 'late'; });
  assert.equal(v, 'sent'); assert.equal(onLate, 0);
});

test('preSendDeadline: a normal build answers itself, its failure is its own, a sync throw is a rejection; the timer never fires after', async () => {
  let onLate = 0; const late = () => { onLate += 1; return 'late'; };
  assert.equal(await preSendDeadline(30, async (c) => { c.gate(); return 'ok'; }, late), 'ok');
  await assert.rejects(preSendDeadline(30, async () => { throw new Error('refused — nothing was sent'); }, late), /refused/);
  await assert.rejects(preSendDeadline(30, () => { throw new Error('sync'); }, late), /sync/);
  await sleep(60); assert.equal(onLate, 0);
});

test('preSendDeadline: a build that comes back after the deadline is ignored (answer already given)', async () => {
  let ctl; let release;
  const v = await preSendDeadline(20, (c) => { ctl = c; return new Promise((r) => { release = r; }); }, () => 'late');
  assert.equal(v, 'late'); release('late-success'); await sleep(5);
  assert.equal(ctl.gate(), false);
});

// ── the shipped wiring: usdBuy / usdBuyEvm / tradeGuard / pooled out of webEngine.ts ──
const js = (names) => ts.transpileModule(names.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const CODE = js(['inFlightTimers', 'releaseInFlight', 'tradeGuard', 'pooled', 'usdBuy', 'usdBuyEvm']);
class SolDirectNoGas extends Error {}
class SolSendUnknown extends Error { hash = ''; }
class DirectUnsupported extends Error {}
function fakeLocks() {
  const held = new Set();
  return { request: async (name, opts, fn) => { if (held.has(name)) return fn(null); held.add(name); try { return await fn({ name }); } finally { held.delete(name); } }, held };
}
/** one engine frame: chain 'sol' | 'robinhood'; `send` = what the send path does (Solana solDirectBuy's send / EVM signAndSend) */
function frame({ chain, build, send, locks = true }) {
  const events = [], sent = [];
  const W = chain === 'sol' ? { id: 'w1', name: 'Main', address: 'Wsol111111111111111111111111111111111111111' } : { id: 'w1', name: 'Main', address: '0x00000000000000000000000000000000000000a1' };
  const S = {
    navigator: locks ? { locks: fakeLocks() } : {},
    SOL_MODE: chain === 'sol', NEAR_MODE: false, CFG: { key: chain === 'sol' ? 'solana' : 'robinhood' },
    usdBuyArgs: (o) => o, tradesInFlight: 0, post: () => {}, keepHot: () => {},
    requireUnlocked: () => [W], meta: { selectedAccountIds: ['w1'], activeAccountId: 'w1' },
    float: { directFor: () => ({ price6: 150_000_000n }), directGas: async () => true, noteBuy: () => {}, directAllowSoon: () => {} },
    loadSettings: () => ({ slippage: 12, gasBoost: 1.5 }), tradeSettings: () => ({ slippage: 12, gasBoost: 1.5 }), tradeSizeProblem: () => '', MAX_BUY: {}, laneKey: () => chain, MAX_BUY_ETH: 10,
    tradeLimits: async () => {}, unrecordBuy: () => {}, nothingSent: () => false, /* fix1 trade-speed-07: the ledger take-back is tested in test/hourly-limit-fix1.mjs */ clickId: (o) => o?.id || 'c', solAddressOf: (a) => a.address, txEvent: (e) => events.push(e),
    solRoute: async () => ({ mint: 'COIN', venue: 'jupiter' }), solReceipt: async () => ({ pending: false, status: 'success' }),
    poolSize: () => 4, inFlight: new Set(), solAcctsOf: () => ({ r: { key: 'k' } }), SolDirectNoGas, SolSendUnknown, DirectUnsupported, solDirectNeedOf,
    shortError: (e) => String(e?.message || e), scheduleWatch: () => {}, preSendDeadline, PRE_SEND_MS: 60, LATE_TEXT,
    // Solana: the real solDirectBuy's shape — build, then the gate, then the send (stubbed)
    solDirectBuy: async (r, w, route, usdc, s, gate) => { await build(); if (gate && !gate()) throw new Error('The buy from your USD balance took too long to prepare — nothing was sent'); sent.push('sol'); return send(); },
    // EVM: everything before signAndSend is the build; signAndSend is the send
    evmChainKey: () => 'robinhood', FLOAT_CFG: { robinhood: { stable: { decimals: 6 } } },
    routeFor: async () => ({ type: 'v3' }), verifyRoute: async () => {}, evmMotionPriceUsd: async () => 1, feeFor: async () => 1n,
    reserveOf: () => ({ key: '0x' + '11'.repeat(32) }), floatAccount: () => ({}), privateKeyToAccount: () => ({ address: '0x00000000000000000000000000000000000000b2' }),
    bridgeHeldNonce: new Map(), BRIDGE_HOLD_MS: 1, CURVE_BUY_MAX_USD: 100, curveRouterOk: async () => true,
    evmDirectPlan: () => ({ kind: 'v3', to: '0x00000000000000000000000000000000000000c3', build: () => '0x' }),
    publicClient: { call: async () => { await build(); return { data: '0x' }; }, estimateGas: async () => 100_000n },
    probeCall: () => '0x', PROBE_RUNTIME: '0x', decodeProbe: () => ({ allowance: 10n ** 30n, rNativeBefore: 10n ** 18n, ret: '0x', coinGot: 5n, decimals: 18 }),
    evmDirectGuard: () => '', routerOut: () => 5n, evmPriceCheck: () => '', minOutOf: (q) => q,
    createWalletClient: () => ({}), chain: {}, transport: {},
    signAndSend: async () => { sent.push('evm'); return send(); },
    // the guard's 120 s cap timers (frozen tradeGuard) must not keep the test process alive
    setTimeout: (fn, ms, ...x) => { const t = setTimeout(fn, ms, ...x); if (ms >= 100_000) t.unref(); return t; }, clearTimeout,
    watchReceipt: () => sleep(200).then(() => ({ status: 'success' })), lc: (s) => String(s).toLowerCase(),
  };
  const mk = new Function('S', `with (S) { ${CODE}\n return { usdBuy, usdBuyEvm, tradeGuard }; }`);
  const f = mk(S);
  const buy = (id = 'c1') => f.usdBuy({ token: chain === 'sol' ? 'COIN' : '0x020bfc650a365f8bb26819deaabf3e21291018b4', usd: 5, id, walletIds: ['w1'] });
  return { f, S, buy, events, sent, W };
}

for (const chain of ['sol', 'robinhood']) for (const locks of [true, false]) {
  const tag = `${chain}${locks ? '' : ' (no Web Locks)'}`;
  test(`${tag}: a build stalled before the send → "not started … nothing was sent" after the deadline, the guard is free, the abandoned build never sends`, async () => {
    let stall = true; let wake; const fr = frame({ chain, locks, build: () => (stall ? new Promise((r) => { wake = r; }) : Promise.resolve()), send: async () => (chain === 'sol' ? { hash: 'SIG2' } : '0xh2') });
    const t0 = performance.now();
    const a = await fr.buy('c1');
    assert.ok(performance.now() - t0 >= 55, 'answered by the deadline');
    const [r] = a.results;
    assert.equal(r.ok, false); assert.equal(r.state, 'not_started'); assert.equal(r.error, LATE_TEXT); assert.equal(a.outcome, 'none');
    assert.ok(DIRECT_FALLBACK.test(r.error) && !STILL_SENDING.test(r.error), 'the app falls back to hold & fire');
    assert.ok(!r.hash);
    assert.deepEqual(fr.events.filter((e) => e.id === 'c1').map((e) => e.state), ['preparing', 'not_started']);
    assert.equal(fr.S.inFlight.size, 0, 'the guard is released');
    if (locks) assert.equal(fr.S.navigator.locks.held.size, 0, 'the cross-tab lock is released');
    // the next buy of this coin from this wallet goes through (not "still being sent")
    stall = false;
    const b = await fr.buy('c2');
    assert.equal(b.results[0].ok, true, JSON.stringify(b.results[0])); assert.equal(b.results[0].state, 'submitted');
    // the abandoned build wakes up: it reaches its gate, which refuses — nothing more is sent, nothing more is said about c1
    const n = fr.sent.length; wake(); await sleep(10);
    assert.equal(fr.sent.length, n, 'the abandoned build never sends');
    assert.deepEqual(fr.events.filter((e) => e.id === 'c1').map((e) => e.state), ['preparing', 'not_started']);
  });

  test(`${tag}: a send that stalls AFTER the gate (may have broadcast) is never answered "not started" and keeps the guard`, async () => {
    const fr = frame({ chain, locks, build: async () => {}, send: never });
    let answered = false; fr.buy('c1').then(() => { answered = true; });
    await sleep(150);   // > 2× the deadline
    assert.equal(answered, false, 'no late answer once handed to the send');
    assert.equal(fr.sent.length, 1);
    assert.ok(!fr.events.some((e) => e.error === LATE_TEXT));
    assert.equal(fr.S.inFlight.size, 1, 'the guard is still held');
    const b = await fr.buy('c2');
    assert.equal(b.results[0].state, 'not_started'); assert.match(b.results[0].error, STILL_SENDING, 'a second buy meets the guard as today');
    assert.equal(fr.sent.length, 1);
  });

  test(`${tag}: a normal buy is unchanged — submitted, followed, the guard held until its receipt`, async () => {
    const fr = frame({ chain, locks, build: async () => {}, send: async () => (chain === 'sol' ? { hash: 'SIG1' } : '0xh1') });
    const a = await fr.buy('c1');
    const [r] = a.results;
    assert.equal(r.ok, true); assert.equal(r.state, 'submitted'); assert.equal(r.hash, chain === 'sol' ? 'SIG1' : '0xh1'); assert.equal(a.via, 'reserve'); assert.equal(a.outcome, 'all');
    assert.deepEqual(fr.events.filter((e) => e.id === 'c1').map((e) => e.state).slice(0, 2), ['preparing', 'submitted']);
    await sleep(100);
    assert.ok(!fr.events.some((e) => e.error === LATE_TEXT), 'the deadline never fires after a send');
    if (chain === 'robinhood') assert.equal(fr.S.inFlight.size, 1, 'held until the receipt (watchReceipt pending)');
  });

  test(`${tag}: an unknown send (after the gate) stays unknown and followed, not "not started"`, async () => {
    const fr = frame({ chain, locks, build: async () => {}, send: async () => { const e = chain === 'sol' ? Object.assign(new SolSendUnknown('every road silent'), { hash: 'SIGU' }) : Object.assign(new Error('Broadcast outcome unknown'), { txState: 'unknown', hash: '0xhu' }); throw e; } });
    const [r] = (await fr.buy('c1')).results;
    assert.equal(r.state, 'unknown'); assert.equal(r.hash, chain === 'sol' ? 'SIGU' : '0xhu');
    await sleep(100); assert.ok(!fr.events.some((e) => e.error === LATE_TEXT));
  });

  test(`${tag}: a refusal before the send (nothing sent) answers at once, as before, and frees the guard`, async () => {
    const fr = frame({ chain, locks, build: async () => { throw new Error('Jupiter found no route for this coin right now — nothing was sent; try again'); }, send: async () => 'x' });
    const t0 = performance.now(); const [r] = (await fr.buy('c1')).results;
    assert.ok(performance.now() - t0 < 50); assert.equal(r.state, 'not_started'); assert.match(r.error, /found no route/);
    assert.equal(fr.S.inFlight.size, 0); assert.equal(fr.sent.length, 0);
  });
}

test('Solana: a reserve short of SOL whose gas drop runs past the deadline is answered late and never built again', async () => {
  let drop; const fr = frame({ chain: 'sol', build: async () => {}, send: async () => ({ hash: 'S' }) });
  let first = true;
  fr.S.solDirectBuy = async (r, w, route, usdc, s, gate) => { if (first) { first = false; throw new SolDirectNoGas('no gas'); } if (gate && !gate()) throw new Error('late — nothing was sent'); fr.sent.push('sol'); return { hash: 'S' }; };
  fr.S.float.directGas = () => new Promise((r) => { drop = r; });
  const f = new Function('S', `with (S) { ${CODE}\n return { usdBuy }; }`)(fr.S);
  const a = await f.usdBuy({ token: 'COIN', usd: 5, id: 'c1', walletIds: ['w1'] });
  assert.equal(a.results[0].error, LATE_TEXT); assert.equal(fr.S.inFlight.size, 0);
  drop(true); await sleep(10); assert.equal(fr.sent.length, 0, 'the second build refuses at its gate');
});

// ── the source: where the gate sits ──
test('source: solDirectBuy checks the gate right after its build and before sentSigs / sendSigned (no await between)', () => {
  const fn = declChunk(SOL, 'solDirectBuy');
  assert.match(fn, /s: SolSettings, gate\?: \(\) => boolean\)/);
  const g = fn.indexOf('if (gate && !gate()) throw new Error('), b = fn.indexOf('await solDirectBuild('), m = fn.indexOf('sentSigs.set(b.hash'), x = fn.indexOf('await sendSigned(');
  assert.ok(b > 0 && g > b && m > g && x > m, 'build → gate → sentSigs → send');
  assert.ok(!fn.slice(g, x).includes('await'), 'nothing awaited between the gate and the send');
  assert.match(fn.slice(g, fn.indexOf('\n', g)), /nothing was sent/);
});

test('source: usdBuy / usdBuyEvm run their guarded build under preSendDeadline(PRE_SEND_MS); the EVM gate is the statement before signAndSend', () => {
  const sol = declChunk(WE, 'usdBuy'), evm = declChunk(WE, 'usdBuyEvm');
  for (const fn of [sol, evm]) {
    assert.match(fn, /return tradeGuard<Result>\(key, busy, \(\) => preSendDeadline\(PRE_SEND_MS, async \(ctl\) => \{/);
    assert.match(fn, /\}, late\)\);/);
    assert.match(fn, /const late = \(\): \{ ret: Result; landed\?: Promise<unknown> \| null \} => \{ const error = LATE_TEXT; txEvent\(\{ id, address, state: 'not_started', error \}\); return \{ ret: \{ name: x\.name, address, ok: false, error, state: 'not_started' as TxState \}, landed: null \}; \};/);
    assert.match(fn, /if \(!ctl\.late\(\)\) txEvent\(/);
  }
  assert.match(sol, /solDirectBuy\(r as SolAcct, address, route, usdc6, s, ctl\.gate\)/);
  const lines = evm.split('\n'); const i = lines.findIndex((l) => l.includes('await signAndSend('));
  assert.equal(lines.filter((l) => l.includes('signAndSend(')).length, 1);
  assert.match(lines[i - 1], /^\s*if \(!ctl\.gate\(\)\) throw new Error\('.*nothing was sent'\);$/);
  assert.equal(evm.split('ctl.gate()').length - 1, 1, 'one gate, at the send');
});

test('source: the normal buy path (trade / tradeInner, the frozen region) has no pre-send deadline', () => {
  for (const n of ['trade', 'tradeInner', 'tradeGuard']) assert.ok(!declChunk(WE, n).includes('preSendDeadline'), n);
  assert.equal(WE.split('preSendDeadline(').length - 1, 2, 'only usdBuy and usdBuyEvm');
});
