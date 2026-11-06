// USD balance — the buy straight from the reserve (src/floatDirect.ts, src/solEngine.ts solDirectBuild). The fixture is a REAL
// mainnet simulation of R's one transaction (USDC → CLUTCH via Whirlpool → Manifest → Raydium CP, paid into W's coin
// account), captured 2026-10-29 with local float-direct/ab/capture-fixture.mjs (sigVerify off, nothing sent).
//   node --experimental-strip-types --test test/float-direct.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData } from 'viem';
import * as D from '../src/floatDirect.ts';
import * as F from '../src/floatCore.ts';
import { ataOf, P } from '../src/solEngine.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/direct-buy-inner-2026-10-29.json', import.meta.url), 'utf8'));
const R = fx.r, W = fx.w, MINT = fx.mint;
const usdcAta = ataOf(R, fx.usdc, P.token), rWsolAta = ataOf(R, P.wsol, P.token), wCoinAta = ataOf(W, MINT, P.token);
const ixBase = { r: R, wCoinAta, rWsolAta };
const guardBase = { r: R, w: W, usdcAta, rWsolAta, wCoinAta, amount: BigInt(fx.amount), rentMax: 2_100_000n };
const clone = (x) => JSON.parse(JSON.stringify(x));
const withInner = (ix) => { const inner = clone(fx.inner); inner[inner.length - 1].instructions.push(ix); return inner; };
const b64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

test('the real route passes the instruction check: setup opens R\'s own accounts, ONE swap that pays W\'s coin account', () => {
  const { opens } = D.directIxsChecked(fx.list, ixBase);
  assert.ok(opens >= 1);
  assert.ok(fx.list.find((x) => x.programId === D.JUP_PROGRAM).accounts.some((a) => a.pubkey === wCoinAta && a.isWritable));
});

test('the instruction check refuses: another signer, a second swap, a swap not paying W, an account opened for someone else, a SOL transfer, an approval', () => {
  const swap = fx.list.find((x) => x.programId === D.JUP_PROGRAM);
  const other = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  assert.throws(() => D.directIxsChecked([...fx.list, { ...clone(swap), accounts: [...swap.accounts, { pubkey: other, isSigner: true, isWritable: true }] }], ixBase), /signer that is not the reserve/);
  assert.throws(() => D.directIxsChecked([...fx.list, clone(swap)], ixBase), /exactly one swap/);
  assert.throws(() => D.directIxsChecked(fx.list, { ...ixBase, wCoinAta: ataOf(other, MINT, P.token) }), /does not pay the trading wallet/);
  const create = { programId: P.ata, accounts: [R, ataOf(other, MINT, P.token), other, MINT, P.system, P.token].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })), data: b64([1]) };
  assert.throws(() => D.directIxsChecked([create, ...fx.list], ixBase), /does not sign/);
  const sol = { programId: P.system, accounts: [{ pubkey: R, isSigner: true, isWritable: true }, { pubkey: other, isSigner: false, isWritable: true }], data: b64([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
  assert.throws(() => D.directIxsChecked([...fx.list, sol], ixBase), /does not sign/);
  const approve = { programId: P.token, accounts: [usdcAta, other, R].map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: i === 0 })), data: b64([4, 1, 0, 0, 0, 0, 0, 0, 0]) };
  assert.throws(() => D.directIxsChecked([...fx.list, approve], ixBase), /does not sign/);
});

test('the real simulation passes the inner check: R spends ≤ the amount of USDC, its intermediate accounts are its own and new', () => {
  const through = new Set();
  assert.equal(D.directInnerGuard({ ...guardBase, inner: fx.inner, through }), '');
  assert.equal(through.size, 0);
});

test('the inner check refuses what R must never sign inside the route', () => {
  const other = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  // more USDC than the amount
  assert.match(D.directInnerGuard({ ...guardBase, amount: 1n, inner: fx.inner }), /more USDC than the amount/);
  // a transfer out of another of R's token accounts: refused without `through`, collected with it
  const fromOther = { program: 'spl-token', programId: P.token, parsed: { type: 'transfer', info: { source: other, destination: 'X', amount: '1', authority: R } } };
  assert.match(D.directInnerGuard({ ...guardBase, inner: withInner(fromOther) }), /moves tokens out of/);
  const through = new Set();
  assert.equal(D.directInnerGuard({ ...guardBase, inner: withInner(fromOther), through }), '');
  assert.deepEqual([...through], [other]);
  // SOL to a stranger, an approval, an authority change, a burn, an unreadable token instruction
  assert.match(D.directInnerGuard({ ...guardBase, inner: withInner({ program: 'system', programId: P.system, parsed: { type: 'transfer', info: { source: R, destination: other, lamports: 1 } } }) }), /sends SOL from the reserve/);
  for (const type of ['approve', 'setAuthority', 'burn', 'approveChecked']) assert.match(D.directInnerGuard({ ...guardBase, inner: withInner({ program: 'spl-token', programId: P.token, parsed: { type, info: { source: usdcAta, account: usdcAta, delegate: other, owner: R, authority: R, amount: '1' } } }) }), /signs a token/);
  assert.match(D.directInnerGuard({ ...guardBase, inner: withInner({ programId: P.token, accounts: [], data: '' }) }), /could not read/);
  // over-priced rent for an account it opens
  assert.match(D.directInnerGuard({ ...guardBase, inner: withInner({ program: 'system', programId: P.system, parsed: { type: 'createAccount', info: { source: R, newAccount: other, lamports: 9_000_000, owner: P.token, space: 165 } } }) }), /more rent/);
  // a close that pays someone else
  const created = fx.inner.flatMap((g) => g.instructions).find((x) => x.parsed?.type === 'createAccount').parsed.info.newAccount;
  assert.match(D.directInnerGuard({ ...guardBase, inner: withInner({ program: 'spl-token', programId: P.token, parsed: { type: 'closeAccount', info: { account: created, destination: other, owner: R } } }) }), /signs a token closeAccount/);
  assert.equal(D.directInnerGuard({ ...guardBase, inner: withInner({ program: 'spl-token', programId: P.token, parsed: { type: 'closeAccount', info: { account: created, destination: R, owner: R } } }) }), '');
  assert.equal(D.directInnerGuard({ ...guardBase, inner: null }), 'no inner instructions');
});

test('the balance check: R\'s USDC, W\'s coin, R\'s SOL and every account the route passed through', () => {
  const coin = (amount, owner = W, delegate = '') => ({ mint: MINT, owner, amount, delegate });
  const ok = { amount: 5_000_000n, minOut: 100n, feesMax: 20_000n, rentMax: 4_200_000n, r: R, w: W, usdcBefore: 22_000_000n, usdcAfter: 17_000_000n, coinBefore: 0n, coinAfter: coin(150n), solBefore: 2_000_000_000n, solAfter: 1_996_000_000n, others: [] };
  assert.equal(D.directBalanceGuard(ok), '');
  assert.match(D.directBalanceGuard({ ...ok, usdcAfter: 16_999_999n }), /more USDC/);
  assert.match(D.directBalanceGuard({ ...ok, usdcAfter: null }), /close the reserve/);
  assert.match(D.directBalanceGuard({ ...ok, coinAfter: coin(99n) }), /less of the coin/);
  assert.match(D.directBalanceGuard({ ...ok, coinAfter: coin(150n, R) }), /not deliver the coin/);
  assert.match(D.directBalanceGuard({ ...ok, coinAfter: coin(150n, W, R) }), /spend the trading wallet/);
  assert.match(D.directBalanceGuard({ ...ok, coinAfter: null }), /not deliver/);
  assert.match(D.directBalanceGuard({ ...ok, solAfter: 1_995_000_000n - 1n }), /more SOL/);
  const tok = { mint: 'M', owner: R, amount: 10n, delegate: '' };
  assert.equal(D.directBalanceGuard({ ...ok, others: [{ address: 'A1', before: tok, after: { ...tok, amount: 10n } }] }), '');
  assert.match(D.directBalanceGuard({ ...ok, others: [{ address: 'A1', before: tok, after: { ...tok, amount: 9n } }] }), /take M/);
  assert.match(D.directBalanceGuard({ ...ok, others: [{ address: 'A1', before: tok, after: null }] }), /close the token/);
  assert.match(D.directBalanceGuard({ ...ok, others: [{ address: 'A1', before: tok, after: { ...tok, owner: W } }] }), /hand the token/);
  assert.match(D.directBalanceGuard({ ...ok, others: [{ address: 'A1', before: tok, after: { ...tok, delegate: W } }] }), /let someone spend/);
});

test('Jupiter\'s answer must be this buy, and pay near motion\'s market price', () => {
  const want = { usdc: fx.usdc, mint: MINT, amount: 5_000_000n, bps: 1200 };
  const j = { inputMint: fx.usdc, outputMint: MINT, inAmount: '5000000', outAmount: '1000', otherAmountThreshold: '880', swapMode: 'ExactIn', slippageBps: 1200 };
  assert.deepEqual(D.directQuoteCheck(j, want), { out: 1000n, min: 880n });
  assert.throws(() => D.directQuoteCheck({ ...j, outputMint: fx.usdc }, want), /different trade/);
  assert.throws(() => D.directQuoteCheck({ ...j, inAmount: '5000001' }, want), /different trade/);
  assert.throws(() => D.directQuoteCheck({ ...j, otherAmountThreshold: '500' }, want), /does not match your slippage/);
  assert.throws(() => D.directQuoteCheck({ ...j, outAmount: undefined }, want), /no route/);
  // $5 at $0.00003 per coin (6 decimals) = 166 666 coins: a floor of 120k passes, 100k (60 %) is refused, no price passes
  assert.equal(D.directPriceCheck({ usdcIn: 5_000_000n, minOut: 120_000_000_000n, decimals: 6, priceUsd: 0.00003 }), '');
  assert.match(D.directPriceCheck({ usdcIn: 5_000_000n, minOut: 100_000_000_000n, decimals: 6, priceUsd: 0.00003 }), /far less/);
  assert.equal(D.directPriceCheck({ usdcIn: 5_000_000n, minOut: 1n, decimals: 6, priceUsd: null }), '');
});

test('EVM: the router call carries W as the recipient and both floors; empty router = the path is off', () => {
  const b = { token: '0x1111111111111111111111111111111111111111', recipient: '0x2222222222222222222222222222222222222222', stableIn: 5_000_000n, minNative: 1n, venue: '0x3333333333333333333333333333333333333333', venueData: '0xdeadbeef', minTokens: 7n, deadline: 99n };
  const d = decodeFunctionData({ abi: D.USD_BUY_ABI, data: D.usdBuyCalldata(b) });
  assert.equal(d.functionName, 'buy');
  assert.equal(d.args[0].recipient, b.recipient); assert.equal(d.args[0].minTokens, 7n); assert.equal(d.args[0].venueData, '0xdeadbeef');
  assert.throws(() => D.usdBuyCalldata({ ...b, minTokens: 0n }), /two floors/);
  assert.equal(D.USD_BUY_ROUTER.robinhood, ''); assert.equal(D.USD_BUY_ROUTER.bsc, '');
});

test('the ready float follows the user\'s buys: largest of the last 5, a burst holds 4 buys, the sweep waits in a burst', () => {
  const U = (x) => BigInt(x) * 1_000_000n;
  assert.equal(F.readySize6([U(10)], []), U(10));
  assert.equal(F.readySize6([], [U(5), U(5), U(5), U(5), U(40)]), U(40));                 // the newest big buy counts at once
  assert.equal(F.readySize6([], [U(80), ...Array(5).fill(U(5))]), U(5));                  // a big buy 6 back and alone: p75 only
  const t = 1_000_000;
  assert.equal(F.burstOf([{ usd6: U(5), at: t - 10_000 }], t), false);
  assert.equal(F.burstOf([{ usd6: U(5), at: t - 10_000 }, { usd6: U(5), at: t - 2_000 }], t), true);
  assert.equal(F.burstOf([{ usd6: U(5), at: t - 70_000 }, { usd6: U(5), at: t - 2_000 }], t), false);
  assert.equal(F.readyMultTenths(true), 40n); assert.equal(F.readyMultTenths(false), 15n);
  assert.equal(F.sweepAllowed({ quiet: true, burst: false, lastTradeAt: t - 61_000, now: t }), true);
  assert.equal(F.sweepAllowed({ quiet: true, burst: true, lastTradeAt: t - 61_000, now: t }), false);
  assert.equal(F.sweepAllowed({ quiet: true, burst: true, lastTradeAt: t - 300_000, now: t }), true);
  assert.equal(F.sweepAllowed({ quiet: false, burst: false, lastTradeAt: 0, now: t }), false);
});
