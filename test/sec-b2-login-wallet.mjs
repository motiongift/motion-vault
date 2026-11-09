// SECURITY BATCH 2 — SEC-6: "your login wallet" was the page's word. bridgeDeposit / relaySwap called a recipient "your login
// wallet" — and dropped the outside dialog's danger (no typed code where IntersectionObserver v2 is missing) — whenever it matched a
// Privy entry the PAGE attached (linkExternal takes any address list a script names). A compromised page attaches its own address
// as "Main", then bridges the wallet's funds there under a calm "Bridge to your login wallet … It is your login wallet" dialog.
// Fix: the words only for the account's main as the vault verified it (its own signature, seedOf, not an 'rk1' copy); the dialog
// stays danger either way. Runs the REAL engine.bridgeDeposit / engine.relaySwap / outsideOk cut out of src/webEngine.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, source } from './sec-cut.mjs';

const SRC = source();
const has = (n) => new RegExp(`\\bconst ${n}\\b`).test(SRC);
const ATTACKER = '0x00000000000000000000000000000000000a77ac';
const MAIN = '0x1111111111111111111111111111111111111111';
const lc = (s) => String(s || '').toLowerCase();
const same = (a, b) => lc(a) === lc(b) && !!a;

function world({ main = null, seedSrc = 'main', attached = [] } = {}) {
  const asked = [];
  const wallet = { id: 'w1', name: 'Wallet 1', address: '0x2222222222222222222222222222222222222222', key: '0x' + '22'.repeat(32) };
  const list = [wallet, ...attached.map((a) => ({ id: 'privy:' + lc(a), name: 'Main', address: a, key: '0x', ext: 'privy' }))];
  const seeds = main ? { [lc(main)]: 'seed' } : {};
  const bound = { originChainId: 8453, destinationChainId: 1, amount: '1000000000000000000', out: '990000000000000000', outFormatted: '0.99', requestId: 'r1', inFormatted: '1', inSymbol: 'ETH', outSymbol: 'ETH', steps: ['deposit'] };
  const stubs = {
    requireUnlocked: () => list, allAccounts: () => list, ownAccounts: () => [wallet], same, lc, seedOf: (m) => seeds[m],
    meta: { main, seedSrc: main ? { [lc(main)]: seedSrc } : {} },
    gate: async () => {}, ask: async (o) => { asked.push(o); return false; },
    escHtml: (v) => String(v ?? ''), sub: (h) => h, muted: (h) => h, destBox: (a) => a, addrRow: () => '',
    solAddressOf: () => '', nativeChainOf: () => null, NATIVE_SOL: 'sol', RELAY_SOL_CHAIN: 792703809,
    BRIDGE_CHAINS: { 8453: { name: 'Base', symbol: 'ETH' }, 1: { name: 'Ethereum', symbol: 'ETH' } },
    bridgeTickets: new Map(), swapTickets: new Map(), formatUnits: (v) => String(Number(v) / 1e18),
    ownBridgeQuote: async () => bound, bindSwap: async () => bound, swapRequestProblem: () => '',
    solSwapSend: async () => '', solBridgeDeposit: async () => '', bridgeDeposit: async () => '', evmSwapSend: async () => ({ hash: '' }),
    // fee-sprint-1109: the shipped OFF state of the fee leg / legacy gate (TERMINAL_FEE_LEG all false, REQUIRED all false)
    feeLegFor: () => null, LIMIT_CHAIN_ID: 4663, BSC_CHAIN_ID: 56, laneKey: () => 'robinhood', relayGate: () => {}, relayOriginLane: () => 'unknown',
  };
  const extra = has('verifiedLogin') ? ['verifiedLogin'] : [];
  // two cuts: engine.bridgeDeposit is cut as `const bridgeDeposit`, the name of the module function it calls on phase 2 (not reached here)
  const { bridgeDeposit: _drop, ...rest } = stubs;
  const f = { ...cut(['engine.bridgeDeposit', ...extra], rest), ...cut(['engine.relaySwap', ...extra], stubs) };
  return { f, asked };
}
const bridge = (w, to) => w.f.bridgeDeposit('w1', { recipient: to, destinationChainId: 1, originChainId: 8453, amount: '1000000000000000000' }).catch(() => {});
const swap = (w, to) => w.f.relaySwap('w1', { recipient: to, originChainId: 8453, destinationChainId: 1, originCurrency: '0x0', destinationCurrency: '0x0', amount: '1000000000000000000' }).catch(() => {});

for (const [name, run] of [['bridgeDeposit', bridge], ['relaySwap', swap]]) {
  test(`SEC-6 hostile: ${name} to an address the PAGE attached as "Main" is a plain outside dialog — danger, no "login wallet" words`, async () => {
    const w = world({ main: MAIN, attached: [ATTACKER] });
    await run(w, ATTACKER);
    assert.equal(w.asked.length, 1);
    const o = w.asked[0];
    assert.equal(o.danger, true, 'the page must not be able to downgrade the outside dialog');
    assert.doesNotMatch(o.title, /login wallet/);
    assert.doesNotMatch(o.html, /your login wallet/);
  });
  test(`SEC-6 hostile: ${name} with no main verified here — a page-attached entry is never "your login wallet"`, async () => {
    const w = world({ main: null, attached: [ATTACKER] });
    await run(w, ATTACKER);
    assert.equal(w.asked[0].danger, true); assert.doesNotMatch(w.asked[0].title, /login wallet/);
  });
  test(`SEC-6 hostile: ${name} — an unproven legacy ('rk1') main is not called the login wallet either`, async () => {
    const w = world({ main: MAIN, seedSrc: 'rk1', attached: [MAIN] });
    await run(w, MAIN);
    assert.equal(w.asked[0].danger, true); assert.doesNotMatch(w.asked[0].title, /login wallet/);
  });
  test(`SEC-6 control: ${name} to the main the vault verified still says "your login wallet" (and stays a danger dialog)`, async () => {
    const w = world({ main: MAIN, attached: [MAIN] });
    await run(w, MAIN);
    assert.match(w.asked[0].title, /login wallet/);
    assert.equal(w.asked[0].danger, true);
  });
}
