// Jupiter route for coins pump.fun quotes in another token (2026-10-25): the vault signs only (1) the instruction kinds it
// knows, with this wallet as the only signer, and (2) what its own simulation shows to be exactly the trade asked for.
// (1) runs on a real swap-instructions answer recorded for SOL → XRP (DLMM SOL→BTC-pump, PumpSwap BTC-pump→XRP); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jupIxsChecked, jupBalanceGuard, tokState, ataOf, P } from '../src/solEngine.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/jupiter-xrp-buy-2026-10-25.json', import.meta.url), 'utf8'));
const USER = fx.user, AMOUNT = BigInt(fx.amount);
const list = () => structuredClone([...fx.setupInstructions, fx.swapInstruction, fx.cleanupInstruction]);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const OTHER = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe';

test('the recorded Jupiter route passes: ATA opens for this wallet, wrap into its own WSOL account, one swap, close back to it', () => {
  assert.deepEqual(fx.quote.route, ['Meteora DLMM', 'Pump.fun Amm']);
  assert.deepEqual(fx.otherInstructions, []);
  const { ixs, opens } = jupIxsChecked(list(), USER, 'buy', AMOUNT);
  assert.equal(ixs.length, 7); assert.equal(opens, 3);
  assert.equal(ixs.filter((i) => i.program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4').length, 1);
});

test('anything else is refused before signing', () => {
  const wsol = ataOf(USER, P.wsol, P.token);
  // a signer that is not this wallet
  { const l = list(); l[5].accounts.push({ pubkey: OTHER, isSigner: true, isWritable: false }); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /signer that is not this wallet/); }
  // SOL sent somewhere other than this wallet's own wrapped-SOL account
  { const l = list(); const i = l.findIndex((x) => x.programId === P.system); l[i].accounts[1].pubkey = OTHER; assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  // more SOL wrapped than the amount
  { const l = list(); const i = l.findIndex((x) => x.programId === P.system); const d = Buffer.from(l[i].data, 'base64'); d.writeBigUInt64LE(AMOUNT + 1n, 4); l[i].data = d.toString('base64'); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  // the wrapped-SOL account closed to someone else
  { const l = list(); l[6].accounts[1].pubkey = OTHER; assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  // an ATA opened for someone else
  { const l = list(); const i = l.findIndex((x) => x.programId === P.ata); l[i].accounts[2].pubkey = OTHER; assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  // two swaps, or none
  { const l = list(); l.push(structuredClone(fx.swapInstruction)); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /exactly one swap/); }
  { const l = list().filter((x) => x.programId !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /exactly one swap/); }
  // a SOL transfer on a sell
  assert.throws(() => jupIxsChecked(list(), USER, 'sell', AMOUNT), /does not sign/);
  // a token transfer, an approve, an unknown program
  { const l = list(); l.push({ programId: P.token, accounts: [{ pubkey: wsol, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: USER, isSigner: true, isWritable: false }], data: b64([3, 1, 0, 0, 0, 0, 0, 0, 0]) }); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  { const l = list(); l.push({ programId: P.token, accounts: [{ pubkey: wsol, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: false }, { pubkey: USER, isSigner: true, isWritable: false }], data: b64([4, 1, 0, 0, 0, 0, 0, 0, 0]) }); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
  { const l = list(); l.push({ programId: OTHER, accounts: [], data: '' }); assert.throws(() => jupIxsChecked(l, USER, 'buy', AMOUNT), /does not sign/); }
});

const acc = (mint, owner, amount, delegate = '') => {
  const d = Buffer.alloc(165); Buffer.from(bytes58(mint)).copy(d, 0); Buffer.from(bytes58(owner)).copy(d, 32); d.writeBigUInt64LE(amount, 64);
  if (delegate) { d.writeUInt32LE(1, 72); Buffer.from(bytes58(delegate)).copy(d, 76); }
  return tokState({ owner: P.token, data: new Uint8Array(d) });
};
function bytes58(s) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const o = []; while (n > 0n) { o.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; o.unshift(0); } while (o.length < 32) o.unshift(0); return o; }

test('the simulated balances must be exactly the trade', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const usdc = acc(USDC, USER, 5_000_000n);
  const base = { side: 'buy', amount: 10_000_000n, minOut: 780_000_000n, feesMax: 200_000n, rentMax: 6_300_000n, user: USER,
    solBefore: 1_000_000_000n, solAfter: 1_000_000_000n - 10_000_000n - 150_000n - 4_100_000n, coinBefore: 0n, coinAfter: 900_000_000n,
    wsolBefore: null, wsolAfter: null, others: [{ address: OTHER, before: usdc, after: acc(USDC, USER, 5_000_000n) }] };
  assert.equal(jupBalanceGuard(base), '', 'a clean buy passes');
  assert.match(jupBalanceGuard({ ...base, solAfter: base.solAfter - 50_000_000n }), /more SOL than the amount/);
  assert.match(jupBalanceGuard({ ...base, coinAfter: 700_000_000n }), /less of the coin/);
  assert.match(jupBalanceGuard({ ...base, coinAfter: null }), /less of the coin/);
  assert.match(jupBalanceGuard({ ...base, others: [{ address: OTHER, before: usdc, after: acc(USDC, USER, 4_999_999n) }] }), /tokens this wallet holds/);
  assert.match(jupBalanceGuard({ ...base, others: [{ address: OTHER, before: usdc, after: acc(USDC, USER, 5_000_000n, OTHER) }] }), /let someone spend/);
  assert.match(jupBalanceGuard({ ...base, others: [{ address: OTHER, before: usdc, after: acc(USDC, OTHER, 5_000_000n) }] }), /to someone else/);
  assert.match(jupBalanceGuard({ ...base, others: [{ address: OTHER, before: usdc, after: null }] }), /close the token account/);
  assert.match(jupBalanceGuard({ ...base, wsolBefore: acc(P.wsol, USER, 3n), wsolAfter: acc(P.wsol, USER, 2n) }), /wrapped SOL this wallet already held/);
  const sell = { ...base, side: 'sell', amount: 900_000_000n, minOut: 8_000_000n, coinBefore: 900_000_000n, coinAfter: 0n, solAfter: base.solBefore + 9_000_000n };
  assert.equal(jupBalanceGuard(sell), '', 'a clean sell passes');
  assert.match(jupBalanceGuard({ ...sell, solAfter: base.solBefore - 10_000_000n }), /less SOL than Jupiter's minimum/);
  assert.match(jupBalanceGuard({ ...sell, coinBefore: 2_000_000_000n, coinAfter: 0n }), /more of the coin than the amount/);
});
