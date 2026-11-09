// Terminal fee leg on Solana (fee-sprint "bypass", 2026-11-09): the fee is one more instruction INSIDE each pre-signed variant,
// a System transfer of the rate to the pinned collector. checkSolPosted enforces it under a fee policy and refuses a tampered one;
// with no policy (leg off) a transfer to any non-expected account is still refused, so behaviour is unchanged.
//   node --experimental-strip-types --test test/sol-fee-leg.mjs
// The compile/order helpers mirror the keeper test (snapshot scripts/sol-limit-orders.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import * as C from '../src/solLimitCore.ts';

const seed = (b) => new Uint8Array(32).fill(b);
const MAIN = seed(7), MAIN_ADDR = C.b58e(ed25519.getPublicKey(MAIN));
const MINT = 'MsGDybWRSNdNXkdDZhEksgzugT5CbVWUG2wkhwgpump';
const NONCE_VALUE = C.b58e(new Uint8Array(32).fill(9));
const COLLECTOR = 'C0LLECToR1111111111111111111111111111111111'.replace(/0/g, 'o').slice(0, 44);
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

function compile(payer, ixs, blockhash) {
  const metas = new Map(); const add = (k, s, w) => { const m = metas.get(k) || { s: false, w: false }; m.s ||= s; m.w ||= w; metas.set(k, m); };
  add(payer, true, true); for (const ix of ixs) { for (const k of ix.keys) add(k.pubkey, k.signer, k.writable); add(ix.program, false, false); }
  const keys = [...metas.entries()].sort(([a, x], [b, y]) => (a === payer ? -1 : b === payer ? 1 : (Number(y.s) - Number(x.s)) || (Number(y.w) - Number(x.w))));
  const idx = new Map(keys.map(([k], i) => [k, i]));
  const sig = keys.filter(([, m]) => m.s), roS = sig.filter(([, m]) => !m.w).length, roU = keys.filter(([, m]) => !m.s && !m.w).length;
  const cpt = (n) => { const o = []; let v = n; for (;;) { let x = v & 0x7f; v >>= 7; if (v) x |= 0x80; o.push(x); if (!v) break; } return Uint8Array.from(o); };
  const parts = [Uint8Array.of(sig.length, roS, roU), cpt(keys.length), ...keys.map(([k]) => C.b58d(k).length === 32 ? C.b58d(k) : (() => { const b = new Uint8Array(32); const d = C.b58d(k); b.set(d, 32 - d.length); return b; })()), C.b58d(blockhash), cpt(ixs.length)];
  for (const ix of ixs) parts.push(Uint8Array.of(idx.get(ix.program)), cpt(ix.keys.length), Uint8Array.from(ix.keys.map((k) => idx.get(k.pubkey))), cpt(ix.data.length), ix.data);
  return C.cat(...parts);
}
const sign = (msg, s) => C.cat(Uint8Array.of(1), ed25519.sign(msg, s), msg);
const budget = (units, micro) => [{ program: C.SP.budget, keys: [], data: C.cat(Uint8Array.of(2), C.u32le(units)) }, { program: C.SP.budget, keys: [], data: C.cat(Uint8Array.of(3), C.u64le(BigInt(micro))) }];
const pumpIx = (user, side, amount, minOut, mint = MINT) => ({ program: C.SP.pump, keys: [[C.SP.system, 0, 0], [mint, 0, 0], [user, 1, 1]].map(([pubkey, s, w]) => ({ pubkey, signer: !!s, writable: !!w })), data: C.cat(Uint8Array.from(side === 'buy' ? C.SOL_DISC.buyV3 : C.SOL_DISC.sellV3), C.u64le(amount), C.u64le(minOut)) });

// a buy variant with a terminal fee transfer inside it (bps of the amount)
function orderFor({ side = 'buy', amountIn = 100_000_000n, floor = 5_000_000_000n, feeBps = 20, feeTo = COLLECTOR, extraFee = null } = {}) {
  const id = C.solOrderIdOf(MAIN, 0); const ow = C.solOrderKeys(MAIN, id);
  const basis = side === 'buy' ? amountIn : floor;
  const feeLamports = (basis * BigInt(feeBps)) / 10_000n;
  const ixs = [C.nonceAdvanceIx(ow.address), ...budget(250_000, 100_000), pumpIx(ow.address, side, amountIn, floor),
    ...C.payoutIxs({ side, orderWallet: ow.address, main: MAIN_ADDR, mint: MINT, tokenProgram: C.SP.token22, decimals: 6, minOut: floor }),
    ...(feeLamports > 0n ? [C.sysTransfer(ow.address, feeTo, feeLamports)] : []),
    ...(extraFee ? [C.sysTransfer(ow.address, feeTo, extraFee)] : [])];
  const tx = sign(compile(ow.address, ixs, NONCE_VALUE), ow.seed);
  return { v: 1, id, chain: 'sol', wallet: MAIN_ADDR, orderWallet: ow.address, nonce: C.nonceAddressOf(ow.address), nonceValue: NONCE_VALUE, token: MINT, tokenProgram: C.SP.token22, symbol: 'MeiMei', decimals: 6,
    side, kind: side === 'buy' ? 'limit' : 'tp', price: side === 'buy' ? '0.00002' : '0.00004', amount: side === 'buy' ? '0.1' : '5000', amountIn: amountIn.toString(), minOut: { pump: floor.toString() }, slippageBps: 100,
    expiry: T0 + 86400_000, createdAt: T0, txs: [{ venue: 'pump', raw: C.toB64(tx) }] };
}

const policy = { collector: COLLECTOR, minBps: 20, required: true };

test('OFF: a variant with a fee transfer is refused (no policy: the collector is an unexpected account)', () => {
  assert.throws(() => C.checkSolPosted(orderFor({ feeBps: 20 }), T0, null), /unexpected account/);
  // and with no fee at all, no policy, it is the order of before
  assert.doesNotThrow(() => C.checkSolPosted(orderFor({ feeBps: 0 }), T0, null));
});

test('ON: a buy carrying the 0.20% fee to the collector is accepted and its lamports are counted into need', () => {
  const r = C.checkSolPosted(orderFor({ feeBps: 20 }), T0, policy);
  assert.equal(Object.values(r.sigs)[0], 'pump');
  assert.ok(r.need.lamports >= 100_000_000n + (100_000_000n * 20n) / 10_000n);
});

test('ON: a sell prices the fee on its floor and is accepted', () => {
  const r = C.checkSolPosted(orderFor({ side: 'sell', amountIn: 5_000_000_000n, floor: 190_000_000n, feeBps: 20 }), T0, policy);
  assert.equal(r.need.token, 5_000_000_000n);
});

test('ON: a missing fee, a short fee, a fee to the wrong account, and two fee transfers are all refused', () => {
  assert.throws(() => C.checkSolPosted(orderFor({ feeBps: 0 }), T0, policy), /no terminal fee/);
  assert.throws(() => C.checkSolPosted(orderFor({ feeBps: 5 }), T0, policy), /not the rate of this wallet/);
  const thief = C.b58e(ed25519.getPublicKey(seed(3)));
  assert.throws(() => C.checkSolPosted(orderFor({ feeBps: 20, feeTo: thief }), T0, policy), /unexpected account/);
  assert.throws(() => C.checkSolPosted(orderFor({ feeBps: 20, extraFee: 1_000n }), T0, policy), /one fee transfer per variant/);
});

test('ON: a wallet granted 0 bps may post a variant with no fee (required but minBps 0)', () => {
  assert.doesNotThrow(() => C.checkSolPosted(orderFor({ feeBps: 0 }), T0, { collector: COLLECTOR, minBps: 0, required: true }));
});
