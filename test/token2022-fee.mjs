// (token2022-fee, 2026-11-01) Token-2022 coins that charge a transfer fee trade through the Jupiter route, with the fee on the
// ticket; coins whose extensions can take, lock or hide tokens stay refused. No network: real mint accounts and real read-only
// simulations (sigVerify:false, replaceRecentBlockhash:true; payer motion's public bridge address 9SeW…1BE / a WOW holder;
// nothing signed or sent) recorded on 2026-11-01, plus a stubbed fetch for the route read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feeMintFacts, transferFeeText, T22_FEE_MAX_BPS, solRoute, setSolRpcs, P, jupPriceCheck, jupInnerGuard, jupInnerRent, jupBalanceGuard, jupIxsChecked, tokState } from '../src/solEngine.ts';
import { directPriceCheck } from '../src/floatDirect.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/token2022-mints-2026-11-01.json', import.meta.url), 'utf8'));
const mintBytes = (k) => Uint8Array.from(Buffer.from(fx.mints[k].data, 'base64'));
const src = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');

// a synthetic Token-2022 mint: base (82) padded to 165, account type 1, then TLV entries
const tlv = (t, v) => { const b = Buffer.alloc(4 + v.length); b.writeUInt16LE(t, 0); b.writeUInt16LE(v.length, 2); Buffer.from(v).copy(b, 4); return b; };
const feeCfg = ({ auth = 1, older = [0n, 10n ** 15n, 300], newer = [0n, 10n ** 15n, 300] } = {}) => {
  const b = Buffer.alloc(108); if (auth) b.fill(7, 0, 32); b.fill(7, 32, 64);
  b.writeBigUInt64LE(older[0], 72); b.writeBigUInt64LE(older[1], 80); b.writeUInt16LE(older[2], 88);
  b.writeBigUInt64LE(newer[0], 90); b.writeBigUInt64LE(newer[1], 98); b.writeUInt16LE(newer[2], 106);
  return b;
};
const mint22 = (entries, { freeze = false } = {}) => {
  const base = Buffer.alloc(166); base[44] = 6; base[45] = 1; if (freeze) { base.writeUInt32LE(1, 46); base.fill(9, 50, 82); } base[165] = 1;
  return Uint8Array.from(Buffer.concat([base, ...entries]));
};
const key32 = (fill) => Buffer.alloc(32, fill);

test('real mints: the fee coins read as fee coins with the fee in force; others are not fee coins', () => {
  const wow = feeMintFacts(mintBytes('WOW'));
  assert.equal(wow.refuse, ''); assert.equal(wow.fee.bps, 300); assert.equal(wow.fee.lowBps, 300); assert.equal(wow.fee.changeable, true); assert.equal(wow.fee.freezable, false);
  assert.equal(transferFeeText(wow.fee), 'Transfer fee 3%');
  assert.equal(transferFeeText(feeMintFacts(mintBytes('SI')).fee), 'Transfer fee 1%');
  assert.equal(transferFeeText(feeMintFacts(mintBytes('PURR')).fee), 'Transfer fee 3%');
  assert.equal(transferFeeText(feeMintFacts(mintBytes('N1993')).fee), 'Transfer fee 5%');
  // BERN: 4.2 % until epoch 698, 2.69 % since — the old fee is history (measured on chain: a buy pays exactly 2.69 %)
  const bern = feeMintFacts(mintBytes('BERN'));
  assert.equal(bern.refuse, ''); assert.equal(bern.fee.bps, 269); assert.equal(bern.fee.lowBps, 269); assert.equal(transferFeeText(bern.fee), 'Transfer fee 2.69%');
  // tKalshi: 0.2 % and a freeze authority — traded, the freeze authority is said on the ticket
  const tk = feeMintFacts(mintBytes('tKalshi'));
  assert.equal(tk.refuse, ''); assert.equal(tk.fee.bps, 20); assert.equal(tk.fee.freezable, true);
  // a pump.fun Token-2022 coin (metadata only) and classic USDC: not fee coins — the normal routes, as before
  assert.equal(feeMintFacts(mintBytes('PUMP22')), null);
  assert.equal(feeMintFacts(mintBytes('USDC')), null);
  // an xStock (hook, permanent delegate, … but no fee): not a fee coin — its refusal is the old one, unchanged (route test below)
  assert.equal(feeMintFacts(mintBytes('GLDx')), null);
});

test('real mints: fee coins that can take or lock tokens are refused with clear words', () => {
  assert.match(feeMintFacts(mintBytes('PYUSD')).refuse, /permanent delegate.*Token-2022.*not supported here/);
  assert.match(feeMintFacts(mintBytes('ANTHROPICx')).refuse, /permanent delegate/);
});

test('every dangerous extension beside a fee is refused; harmless ones pass', () => {
  const fee = tlv(1, feeCfg());
  const meta = tlv(18, Buffer.alloc(64)), closeAuth = tlv(3, key32(5)), scaled = tlv(25, Buffer.alloc(56)), interest = tlv(10, Buffer.alloc(52));
  assert.equal(feeMintFacts(mint22([fee, meta, closeAuth, scaled, interest])).refuse, '');
  const cases = [
    [tlv(12, key32(3)), /permanent delegate/], [tlv(14, Buffer.concat([key32(1), key32(2)])), /transfer hook/], [tlv(9, Buffer.alloc(0)), /cannot be transferred/],
    [tlv(4, Buffer.alloc(65)), /confidential/], [tlv(16, Buffer.alloc(129)), /confidential/], [tlv(24, Buffer.alloc(32)), /confidential/],
    [tlv(26, Buffer.concat([key32(4), Buffer.from([0])])), /paused/], [tlv(6, Buffer.from([2])), /frozen/], [tlv(99, Buffer.alloc(4)), /does not know \(type 99\)/],
    [tlv(2, Buffer.alloc(8)), /does not know \(type 2\)/],
  ];
  for (const [e, why] of cases) assert.match(feeMintFacts(mint22([fee, e])).refuse, why, String(why));
  // a permanent delegate that is unset, a default state that is not Frozen: harmless
  assert.equal(feeMintFacts(mint22([fee, tlv(12, Buffer.alloc(32))])).refuse, '');
  assert.equal(feeMintFacts(mint22([fee, tlv(6, Buffer.from([1]))])).refuse, '');
});

test('the fee: cap, max-fee 0, a pending change shown as a range, a settled one as the new fee', () => {
  const over = feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 10n ** 15n, 1500], newer: [0n, 10n ** 15n, 1500] }))]));
  assert.match(over.refuse, /charges a 15% transfer fee — over the 10% motion trades/);
  assert.equal(T22_FEE_MAX_BPS, 1000);
  assert.equal(feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 10n ** 15n, 1000], newer: [0n, 10n ** 15n, 1000] }))])).refuse, '', 'exactly 10 % trades');
  // a raise scheduled for a future epoch counts at once against the cap
  assert.match(feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 10n ** 15n, 300], newer: [99999n, 10n ** 15n, 5000] }))])).refuse, /50% transfer fee/);
  // max fee 0: no fee is charged
  assert.equal(feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 0n, 300], newer: [0n, 0n, 300] }))])).fee.bps, 0);
  const pending = feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 10n ** 15n, 100], newer: [99999n, 10n ** 15n, 300] }))])).fee;
  assert.deepEqual([pending.lowBps, pending.bps, pending.nextBps, pending.nextEpoch], [100, 300, 300, 99999]);
  assert.equal(transferFeeText(pending), 'Transfer fee 1%–3%');
  const settled = feeMintFacts(mint22([tlv(1, feeCfg({ older: [0n, 10n ** 15n, 900], newer: [500n, 10n ** 15n, 300] }))])).fee;
  assert.deepEqual([settled.lowBps, settled.bps], [300, 300]);
  // no fee authority → not changeable; freeze authority → freezable
  const fixed = feeMintFacts(mint22([tlv(1, feeCfg({ auth: 0 }))], { freeze: true })).fee;
  assert.equal(fixed.changeable, false); assert.equal(fixed.freezable, true);
});

test('a broken layout: refused when it holds a fee, left to the old path when it does not', () => {
  const broken = mint22([tlv(1, feeCfg())]); const b = Buffer.from(broken); b.writeUInt16LE(500, 168);   // the fee entry runs past the end
  assert.match(feeMintFacts(Uint8Array.from(b)).refuse, /mint layout/);
  assert.match(feeMintFacts(mint22([tlv(1, Buffer.alloc(50))])).refuse, /transfer-fee setting/);
  assert.match(feeMintFacts(mint22([tlv(1, feeCfg()), tlv(1, feeCfg())])).refuse, /mint layout/, 'a type twice');
  const noFee = Buffer.from(mint22([tlv(18, Buffer.alloc(64))])); noFee.writeUInt16LE(900, 168);
  assert.equal(feeMintFacts(Uint8Array.from(noFee)), null);
});

// ── the route ──
const b64 = (u8) => Buffer.from(u8).toString('base64');
function stub(mintKey, route) {
  const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u.includes('/route')) return { ok: true, status: 200, json: async () => route };
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0];
      const value = keys.map((k, i) => (i === 0 ? { owner: fx.mints[mintKey].owner, lamports: 1, data: [fx.mints[mintKey].data, 'base64'] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }) };
    }
    if (body.method === 'getProgramAccounts') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: null }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('route: WOW (the tester\'s coin) is a Jupiter route with its fee; nothing from the server decides it', async () => {
  setSolRpcs([], []);
  const s = stub('WOW', { ok: true, chain: 'sol', venue: 'jupiter', mint: fx.mints.WOW.address, symbol: 'WOW', tradeable: true });
  try {
    const r = await solRoute(fx.mints.WOW.address, { ok: true, chain: 'sol', venue: 'jupiter', mint: fx.mints.WOW.address, symbol: 'WOW' });
    assert.equal(r.venue, 'jupiter'); assert.equal(r.pool, ''); assert.equal(r.quote, ''); assert.equal(r.tokenProgram, P.token22); assert.equal(r.decimals, 6);
    assert.equal(r.fee.bps, 300); assert.equal(r.symbol, 'WOW');
  } finally { s.restore(); }
});

test('route: a fee coin the server routes to a DLMM pool (PURR, BERN) still goes to Jupiter — never the own DLMM builder', async () => {
  setSolRpcs([], []);
  for (const k of ['PURR', 'BERN']) {
    const m = fx.mints[k].address;
    const s = stub(k, { ok: true, chain: 'sol', venue: 'dlmm', mint: m, tradeable: true, dlmm: ['A2cPP7kqbg84LinFoQ9644dND4Rr6h8gjHdtVDyJ3rdo'] });
    try {
      const r = await solRoute(m, { ok: true, chain: 'sol', venue: 'dlmm', mint: m });
      assert.equal(r.venue, 'jupiter', k); assert.equal(r.dlmm, undefined); assert.equal(r.dlmmAlts, undefined); assert.ok(r.fee, k);
      assert.ok(!s.calls.some((u) => u.includes('getProgramAccounts')), 'no DLMM search for a fee coin');
    } finally { s.restore(); }
  }
});

test('route: refusals — fee + permanent delegate (PYUSD); an xStock keeps its old hook refusal', async () => {
  setSolRpcs([], []);
  { const s = stub('PYUSD', { ok: true, chain: 'sol', venue: 'jupiter', mint: fx.mints.PYUSD.address, tradeable: true });
    try { await assert.rejects(solRoute(fx.mints.PYUSD.address), /permanent delegate/); } finally { s.restore(); } }
  { const s = stub('GLDx', { ok: true, chain: 'sol', venue: 'jupiter', mint: fx.mints.GLDx.address, tradeable: true });
    try { await assert.rejects(solRoute(fx.mints.GLDx.address), /This coin carries a transfer hook \(Token-2022\) — not supported here/); } finally { s.restore(); } }
});

// ── the click's checks on real simulations ──
test('WOW buy (bridge payer, read-only simulation): every guard passes; Jupiter\'s quote is what the wallet receives after the fee', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/t22-wow-buy-2026-11-01.json', import.meta.url), 'utf8'));
  const amount = BigInt(f.amount), minOut = BigInt(f.quote.otherAmountThreshold);
  const { opens } = jupIxsChecked(f.list, f.user, 'buy', amount);
  const through = new Set();
  assert.equal(jupInnerGuard({ inner: f.sim.innerInstructions, user: f.user, side: 'buy', amount, wsolAta: f.wsolAta, coinAta: f.coinAta, rentMax: 2_100_000n, through }), '');
  const acc = (x) => (x ? { owner: x.owner, data: Uint8Array.from(Buffer.from(x.data[0], 'base64')), lamports: x.lamports } : null);
  const post = f.sim.accounts.map(acc);
  const coinAfter = tokState(post[1]).amount;
  // the coin arrives net of the 3 %: the pool sent gross, the wallet's balance rose by the net, which is ≥ Jupiter's minimum
  let gross = 0n; for (const g of f.sim.innerInstructions) for (const x of g.instructions) { const i = x.parsed?.info; if (i && i.mint === f.mint && i.destination === f.coinAta) gross += BigInt(i.tokenAmount?.amount ?? i.amount); }
  assert.ok(gross > 0n);
  const fee = gross - coinAfter; assert.equal(fee, (gross * 300n + 9999n) / 10000n, 'the wallet received exactly the gross less the 3 % fee');
  assert.ok(coinAfter >= minOut && Number(coinAfter) / Number(f.quote.outAmount) > 0.999, 'Jupiter quoted the amount after the fee');
  const rent = jupInnerRent(f.sim.innerInstructions, f.user);
  const why = jupBalanceGuard({ side: 'buy', amount, minOut, feesMax: 15_000n, rentMax: rent.rent > BigInt(opens) * 2_100_000n ? rent.rent : BigInt(opens) * 2_100_000n, user: f.user, solBefore: BigInt(f.pre.sol), solAfter: BigInt(post[0].lamports), coinBefore: 0n, coinAfter, wsolBefore: null, wsolAfter: tokState(post[2]), others: [], wsolLamportsBefore: 0n, wsolLamportsAfter: BigInt(post[2]?.lamports || 0) });
  assert.equal(why, '');
  // a fill below the minimum is still refused
  assert.match(jupBalanceGuard({ side: 'buy', amount, minOut: coinAfter + 1n, feesMax: 15_000n, rentMax: 10_000_000n, user: f.user, solBefore: BigInt(f.pre.sol), solAfter: BigInt(post[0].lamports), coinBefore: 0n, coinAfter, wsolBefore: null, wsolAfter: null, others: [] }), /less of the coin/);
});

test('WOW sell (a holder, read-only simulation): exactly the amount leaves the wallet; the SOL is Jupiter\'s quote', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/t22-wow-sell-2026-11-01.json', import.meta.url), 'utf8'));
  const amount = BigInt(f.amount), minOut = BigInt(f.quote.otherAmountThreshold);
  jupIxsChecked(f.list, f.user, 'sell', amount);
  assert.equal(jupInnerGuard({ inner: f.sim.innerInstructions, user: f.user, side: 'sell', amount, wsolAta: f.wsolAta, coinAta: f.coinAta, rentMax: 2_100_000n, through: new Set() }), '');
  assert.match(jupInnerGuard({ inner: f.sim.innerInstructions, user: f.user, side: 'sell', amount: amount - 1n, wsolAta: f.wsolAta, coinAta: f.coinAta, rentMax: 2_100_000n, through: new Set() }), /sells more of the coin than the amount/);
  const acc = (x) => (x ? { owner: x.owner, data: Uint8Array.from(Buffer.from(x.data[0], 'base64')), lamports: x.lamports } : null);
  const post = f.sim.accounts.map(acc);
  const coinAfter = tokState(post[1]).amount;
  assert.equal(BigInt(f.pre.coin) - coinAfter, amount);
  const solGot = BigInt(post[0].lamports) - BigInt(f.pre.sol);
  assert.ok(solGot + 5_000n >= minOut, 'at least Jupiter\'s minimum reaches the wallet');
  assert.equal(jupBalanceGuard({ side: 'sell', amount, minOut, feesMax: 15_000n, rentMax: 2_100_000n, user: f.user, solBefore: BigInt(f.pre.sol), solAfter: BigInt(post[0].lamports), coinBefore: BigInt(f.pre.coin), coinAfter, wsolBefore: null, wsolAfter: tokState(post[2]), others: [], wsolLamportsBefore: 0n, wsolLamportsAfter: BigInt(post[2]?.lamports || 0) }), '');
});

test('a transferCheckedWithFee signed by the wallet counts like transferChecked (sell amount, other accounts)', () => {
  const user = '9SeWZmcsCUyBRe7LEjQvh65aTedBHHE6jK6p5BZXF1BE', coinAta = 'EJqsyqUEDNbPi6379q6t4nwbTjNmeLxZgaZ5DWiTjF3V', wsolAta = 'So11111111111111111111111111111111111111112', other = 'DnUSJ7gnRgmV9PustBRf5vb1Vho3k2vYwvEo5WAb9CJM';
  const ixOf = (source, amount) => [{ index: 0, instructions: [{ program: 'spl-token-2022', programId: P.token22, parsed: { type: 'transferCheckedWithFee', info: { source, destination: other, mint: 'm', authority: user, tokenAmount: { amount: String(amount) }, feeAmount: { amount: '3' } } } }] }];
  const g = { user, side: 'sell', amount: 100n, wsolAta, coinAta, rentMax: 2_100_000n };
  assert.equal(jupInnerGuard({ ...g, inner: ixOf(coinAta, 100) }), '');
  assert.match(jupInnerGuard({ ...g, inner: ixOf(coinAta, 101) }), /sells more of the coin/);
  assert.match(jupInnerGuard({ ...g, inner: ixOf(other, 1) }), /moves tokens out of/);
  const through = new Set(); assert.equal(jupInnerGuard({ ...g, inner: ixOf(other, 1), through }), ''); assert.ok(through.has(other), 'collected for the balance check');
});

test('price checks count the fee: the fair figure is lower by it; no fee = the exact old answer', () => {
  // 1 SOL buys 1000 coins at the market; a 3 % fee delivers 970; a 30 % band
  const buy = (minOut, feeBps) => jupPriceCheck({ side: 'buy', amount: 1_000_000_000n, minOut: BigInt(minOut), decimals: 0, priceSol: 0.001, feeBps });
  assert.equal(buy(700, undefined), ''); assert.match(buy(699, undefined), /far less/);
  assert.equal(buy(679, 300), ''); assert.match(buy(678, 300), /far less/);
  assert.equal(buy(700, 0), buy(700, undefined));
  const sell = (minOut, feeBps) => jupPriceCheck({ side: 'sell', amount: 1000n, minOut: BigInt(minOut), decimals: 0, priceSol: 0.001, feeBps });
  assert.equal(sell(700_000_000, undefined), ''); assert.match(sell(679_000_000, undefined), /far less/); assert.equal(sell(679_000_000, 300), '');
  assert.match(sell(1, 300), /far less/, 'a fee never excuses a bad fill');
  assert.match(jupPriceCheck({ side: 'sell', amount: 1n, minOut: 1n, decimals: 0, priceSol: null, feeBps: 300 }), /no market price/);
  const d = (minOut, feeBps) => directPriceCheck({ usdcIn: 1_000_000n, minOut: BigInt(minOut), decimals: 0, priceUsd: 0.001, feeBps });
  assert.equal(d(700, undefined), ''); assert.match(d(699, undefined), /far less/); assert.equal(d(679, 300), '');
});

test('source: the fee branch sits before every own-venue builder and only a fee mint takes it; the click passes the fee', () => {
  const lr = src.slice(src.indexOf('async function loadRoute('), src.indexOf('// a symbol for display'));
  const at = lr.indexOf('const fee = tokenProgram === P.token22 ? feeMintFacts(mintAcc.data) : null;');
  assert.ok(at > 0 && at < lr.indexOf('if (curveAcc && curveAcc.owner === P.pump)'), 'before the pump / PumpSwap / pumphop / DLMM logic');
  assert.match(lr, /if \(fee\) \{\n\s+if \(fee\.refuse\) throw new Error\(fee\.refuse\);\n\s+const h = await Promise\.race\(\[hP, Promise\.resolve\(null\)\]\);\n\s+const r: SolRoute = \{ mint, venue: 'jupiter',/);
  assert.match(src, /jupPriceCheck\(\{ side, amount, minOut, decimals: r\.decimals, priceSol: await priceP, feeBps: r\.fee\?\.lowBps \}\)/);
  // engine-candidate-1110 (review #6): the USD buy's fair figure is taken on what the swap gets (jupIn = the amount less the fee)
  assert.match(src, /directPriceCheck\(\{ usdcIn: jupIn, minOut, decimals: r\.decimals, priceUsd: await priceP, feeBps: r\.fee\?\.lowBps \}\)/);
  // the hook refusal for coins without a fee is the old one, unchanged
  assert.equal((src.match(/if \(ext\.has\(14\)\) throw new Error\('This coin carries a transfer hook \(Token-2022\) — not supported here'\);/g) || []).length, 2);
});
