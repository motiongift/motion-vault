// SEC-1 (security audit 2026-11-04, pass 1): move.plan / move.start take the ERC-20's `decimals` from the PAGE.
// The outside-transfer dialog (confirmOutside) prints the total with those decimals, while the legs send raw units.
// A page that says a 6-decimal stablecoin has 30 decimals makes "Send outside your vault" read "0 USDC in total"
// while the whole balance goes to the address. Runs the REAL planMove + confirmOutside cut out of src/webEngine.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEther, formatUnits } from 'viem';
import { cut } from './sec-cut.mjs';

const USDC = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const W = '0x1111111111111111111111111111111111111111';
const ATTACKER = '0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5';
const BALANCE = 5_000_000_000n;   // 5,000.000000 USDC (6 decimals)

function world() {
  const shown = [];
  const accounts = [{ id: 'w1', name: 'Wallet 1', address: W, key: '0x' + '11'.repeat(32) }];
  const publicClient = {
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? BALANCE : functionName === 'symbol' ? 'USDC' : functionName === 'decimals' ? 6 : 0n),
  };
  const stubs = {
    moveLaneCheck: () => {}, requireUnlocked: () => accounts, syncEthGas: async () => {}, feeFor: async () => 10_000_000n,
    publicClient, formatEther, formatUnits, structuredClone, plans: new Map(), MOVE_LANE: 'robinhood', moveLanePublic: (k) => k,
    ETH_GAS: 21_000n, ERC20_GAS: 80_000n, MAX_HOPS: 4,
    // used by the fixed planMove (the token's own decimals and symbol, read from the chain)
    tokenDecimals: async () => 6, tokenSymbolOf: async () => 'USDC', ERC20_ABI: [],
    isOwn: (a) => a.toLowerCase() === W, gate: async () => {}, unbackedOk: async () => {}, NATIVE: 'ETH',
    ask: async (o) => { shown.push(o.html); return true; },
  };
  const f = cut(['lc', 'escHtml', 'groupsOf', 'copyBtn', 'destBox', 'sub', 'muted', 'jid', 'gasCostWei', 'humanOf', 'weiOf', 'planMove', 'confirmOutside'], stubs);
  return { f, shown };
}

test('SEC-1: a page-declared decimals value cannot make the outside-send dialog understate the amount', async () => {
  const { f, shown } = world();
  const plan = await f.planMove({ fromIds: ['w1'], toAddresses: [ATTACKER], asset: { kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 30 }, amount: { mode: 'pct', value: 100, per: 'source' } });
  const raw = plan.legs.reduce((s, l) => s + BigInt(l.amount), 0n);
  assert.equal(raw, BALANCE, 'the legs move the whole balance');
  await f.confirmOutside(plan);
  assert.equal(shown.length, 1, 'the outside dialog was shown');
  // what the dialog states must be what the legs send: 5000 USDC
  assert.match(shown[0], />?5000 USDC in total/, `the dialog must state 5000 USDC, it said: ${shown[0].replace(/<[^>]+>/g, ' ').slice(0, 120)}`);
});

test('SEC-1: an amount typed in whole tokens is converted with the token\'s own decimals', async () => {
  const { f } = world();
  // the page asks for "10 USDC" but claims 18 decimals: 10 * 1e18 raw = 1e19 > balance → must be 10 USDC = 1e7 raw
  const plan = await f.planMove({ fromIds: ['w1'], toAddresses: [ATTACKER], asset: { kind: 'erc20', address: USDC, symbol: 'X', decimals: 18 }, amount: { mode: 'fixed', value: 10, per: 'source' } });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors || plan.sources));
  assert.equal(BigInt(plan.legs[0].amount), 10_000_000n);
  assert.equal(plan.asset.decimals, 6);
  assert.equal(plan.asset.symbol, 'USDC');
});

test('SEC-1: native ETH moves are unchanged', async () => {
  const { f, shown } = world();
  const plan = await f.planMove({ fromIds: ['w1'], toAddresses: [ATTACKER], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 0.1, per: 'source' } });
  assert.equal(BigInt(plan.legs[0].amount), 10n ** 17n);
  await f.confirmOutside(plan);
  assert.match(shown[0], /0\.1 ETH in total/);
});
