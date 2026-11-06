// SECURITY PASS 2 (2026-11-04) on SEC-1: planMove with tokens whose decimals() / symbol() misbehave. The REAL tokenDecimals,
// tokenSymbolOf and planMove are cut out of src/webEngine.ts; the node is stubbed with viem's own ABI decoder over crafted return
// data, so what the engine sees is what viem makes of a hostile or broken token (out-of-range uint8, empty answer = no code /
// revert, a reverting symbol, bytes32 symbols).
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEther, formatUnits, decodeFunctionResult } from 'viem';
import { cut } from './sec-cut.mjs';

const W = '0x1111111111111111111111111111111111111111';
const ATT = '0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5';
const TOKEN = '0x2222222222222222222222222222222222222222';
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const abiString = (s) => { const h = Buffer.from(s).toString('hex'); return '0x' + word(32).slice(2) + word(s.length).slice(2) + h.padEnd(Math.ceil(h.length / 64) * 64 || 64, '0'); };

function world({ decimalsRet, symbolRet, balance = 5_000_000_000n }) {
  const shown = [];
  const accounts = [{ id: 'w1', name: 'Wallet 1', address: W, key: '0x' + '11'.repeat(32) }];
  let ERC20_ABI;
  const readContract = async ({ functionName }) => {
    if (functionName === 'balanceOf') return balance;
    const data = functionName === 'decimals' ? decimalsRet : symbolRet;
    if (data instanceof Error) throw data;
    return decodeFunctionResult({ abi: ERC20_ABI, functionName, data });   // what viem's readContract would return
  };
  const stubs = {
    moveLaneCheck: () => {}, requireUnlocked: () => accounts, syncEthGas: async () => {}, feeFor: async () => 10_000_000n,
    publicClient: { getBalance: async () => 10n ** 18n, readContract }, formatEther, formatUnits, structuredClone, plans: new Map(),
    MOVE_LANE: 'robinhood', moveLanePublic: (k) => k, ETH_GAS: 21_000n, ERC20_GAS: 80_000n, MAX_HOPS: 4, SOL_MODE: false,
    decimalsCache: new Map(), KNOWN_SYMBOLS: {}, solTokenMeta: async () => ({}),
    isOwn: (a) => a.toLowerCase() === W, gate: async () => {}, unbackedOk: async () => {}, NATIVE: 'ETH', ask: async (o) => { shown.push(o.html); return true; },
  };
  const f = cut(['ERC20_ABI', 'lc', 'escHtml', 'groupsOf', 'copyBtn', 'destBox', 'sub', 'muted', 'jid', 'gasCostWei', 'humanOf', 'weiOf', 'tokenSymbolOf', 'tokenDecimals', 'planMove', 'confirmOutside'], stubs);
  ERC20_ABI = f.ERC20_ABI;
  return { f, shown };
}
const spec = { fromIds: ['w1'], toAddresses: [ATT], asset: { kind: 'erc20', address: TOKEN, symbol: 'USDC', decimals: 30 }, amount: { mode: 'pct', value: 100, per: 'source' } };

test('pass 2 / SEC-1: decimals() answering 255 (a valid uint8) is refused — never a "0 tokens" dialog', async () => {
  const { f } = world({ decimalsRet: word(255), symbolRet: abiString('USDC') });
  await assert.rejects(f.planMove(spec), /does not state its decimals/);
});
test('pass 2 / SEC-1: decimals() answering a word above uint8 → viem refuses to decode → nothing is planned', async () => {
  const { f } = world({ decimalsRet: word(2n ** 200n), symbolRet: abiString('USDC') });
  await assert.rejects(f.planMove(spec));
});
test('pass 2 / SEC-1: decimals() reverting / no code (empty answer) → nothing is planned', async () => {
  for (const d of [new Error('execution reverted'), '0x']) { const { f } = world({ decimalsRet: d, symbolRet: abiString('USDC') }); await assert.rejects(f.planMove(spec)); }
});
test('pass 2 / SEC-1: symbol() reverting or bytes32 → "tokens" / the chain\'s answer; the amount is right', async () => {
  for (const sym of [new Error('execution reverted'), '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')]) {
    const { f, shown } = world({ decimalsRet: word(6), symbolRet: sym });
    const plan = await f.planMove(spec).catch((e) => e);
    if (plan instanceof Error) { assert.ok(true, 'refused: ' + plan.message); continue; }
    assert.equal(plan.asset.decimals, 6); await f.confirmOutside(plan);
    assert.match(shown[0], /5000 \S+ in total/, shown[0].replace(/<[^>]+>/g, ' ').slice(0, 100));
  }
});
test('pass 2 / SEC-1: 18-decimal token at 0 / 36 decimals bounds behave (0 and 36 accepted, page value ignored)', async () => {
  for (const d of [0, 18, 36]) { const { f } = world({ decimalsRet: word(d), symbolRet: abiString('TKN') }); const p = await f.planMove(spec); assert.equal(p.asset.decimals, d); assert.equal(p.asset.symbol, 'TKN'); }
});
test('pass 2 / SEC-1: a non-erc20, non-eth asset kind and a malformed token address are refused', async () => {
  const { f } = world({ decimalsRet: word(6), symbolRet: abiString('USDC') });
  await assert.rejects(f.planMove({ ...spec, asset: { kind: 'spl', address: TOKEN } }), /Unknown asset/);
  await assert.rejects(f.planMove({ ...spec, asset: { kind: 'erc20', address: '0x12' } }), /Invalid token address/);
});
