// The fast Jupiter path (2026-10-25): every move of the wallet's funds inside the simulated transaction is checked from the node's
// parsed inner instructions (jupInnerGuard) instead of reading all its token accounts first; tables cached; one quote per click.
// The fixture is a real mainnet simulation (SOL → BTC-pump DLMM → the coin's PumpSwap pool, 0.025 SOL), saved 2026-10-25.
//   node --experimental-strip-types --test test/jupiter-fast.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jupInnerGuard, ataOf, P } from '../src/solEngine.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/jupiter-inner-buy-2026-10-25.json', import.meta.url), 'utf8'));
const base = { user: fx.user, side: 'buy', amount: BigInt(fx.amount), wsolAta: ataOf(fx.user, P.wsol, P.token), coinAta: ataOf(fx.user, fx.mint, P.token22), rentMax: 2_100_000n };
const withExtra = (ix) => { const inner = JSON.parse(JSON.stringify(fx.inner)); inner[inner.length - 1].instructions.push(ix); return inner; };

test('a real two-hop route passes: wrapping ≤ the amount, its own intermediate account created and emptied in the same transaction', () => {
  assert.equal(jupInnerGuard({ ...base, inner: fx.inner }), '');
});

test('anything else this wallet signs inside the swap is refused', () => {
  const other = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'transfer', info: { source: other, destination: 'X', amount: '1', authority: fx.user } } }) }), /moves tokens out of/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'transferChecked', info: { source: other, mint: 'M', destination: 'X', tokenAmount: { amount: '1' }, authority: fx.user } } }) }), /moves tokens out of/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'approve', info: { source: base.coinAta, delegate: 'X', amount: '1', owner: fx.user } } }) }), /approve/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'spl-token-2022', programId: P.token22, parsed: { type: 'setAuthority', info: { account: base.coinAta, authorityType: 'accountOwner', newAuthority: 'X', authority: fx.user } } }) }), /setAuthority/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'closeAccount', info: { account: other, destination: 'X', owner: fx.user } } }) }), /closeAccount/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'system', programId: P.system, parsed: { type: 'transfer', info: { source: fx.user, destination: 'X', lamports: 1 } } }) }), /sends SOL/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'system', programId: P.system, parsed: { type: 'transfer', info: { source: fx.user, destination: base.wsolAta, lamports: Number(fx.amount) + 1 } } }) }), /wraps more SOL/);   // (outer + inner together: the SOL balance guard)
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ programId: P.token, accounts: [fx.user], data: 'x' }) }), /could not read/);
  assert.match(jupInnerGuard({ ...base, inner: withExtra({ program: 'system', programId: P.system, parsed: { type: 'createAccount', info: { source: fx.user, newAccount: 'N', lamports: 9_000_000, space: 0, owner: P.token } } }) }), /rent/);
});

test('a sell: the coin out of its own account at most the amount; never the wrapped SOL it held', () => {
  const sell = { ...base, side: 'sell', amount: 100n };
  const mk = (src, amount) => [{ index: 0, instructions: [{ program: 'spl-token-2022', programId: P.token22, parsed: { type: 'transferChecked', info: { source: src, mint: fx.mint, destination: 'POOL', tokenAmount: { amount: String(amount) }, authority: fx.user } } }] }];
  assert.equal(jupInnerGuard({ ...sell, inner: mk(base.coinAta, 100) }), '');
  assert.match(jupInnerGuard({ ...sell, inner: mk(base.coinAta, 101) }), /more of the coin/);
  assert.match(jupInnerGuard({ ...sell, inner: mk(base.wsolAta, 1) }), /moves tokens out of/);
});

test('a route through an account this wallet already holds (owner yes 2026-10-27, POOH): collected for the balance check, never passed blind', async () => {
  const other = 'GJ7f1aLYhBVjWb4dGeZm5hUvC3FtrDDZYe9cT9pVJkSa';
  const sell = { ...base, side: 'sell', amount: 100n };
  const hop = [{ index: 0, instructions: [
    { program: 'spl-token-2022', programId: P.token22, parsed: { type: 'transferChecked', info: { source: base.coinAta, mint: fx.mint, destination: 'POOL', tokenAmount: { amount: '100' }, authority: fx.user } } },
    { program: 'spl-token', programId: P.token, parsed: { type: 'transfer', info: { source: other, destination: 'POOL2', amount: '5000', authority: fx.user } } },
    { program: 'spl-token', programId: P.token, parsed: { type: 'transfer', info: { source: base.wsolAta, destination: 'POOL3', amount: '7', authority: fx.user } } },
  ] }];
  assert.match(jupInnerGuard({ ...sell, inner: hop }), /moves tokens out of/, 'without `through` the old rule stands');
  const through = new Set();
  assert.equal(jupInnerGuard({ ...sell, inner: hop, through }), '');
  assert.deepEqual([...through], [other], 'the account is handed to the balance check (wSOL is checked there already)');
  // everything else this wallet signs is still refused with `through` given
  assert.match(jupInnerGuard({ ...base, through: new Set(), inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'approve', info: { source: other, delegate: 'X', amount: '1', owner: fx.user } } }) }), /approve/);
  assert.match(jupInnerGuard({ ...base, through: new Set(), inner: withExtra({ program: 'spl-token', programId: P.token, parsed: { type: 'closeAccount', info: { account: other, destination: 'X', owner: fx.user } } }) }), /closeAccount/);
  assert.match(jupInnerGuard({ ...base, through: new Set(), inner: withExtra({ program: 'system', programId: P.system, parsed: { type: 'transfer', info: { source: fx.user, destination: 'X', lamports: 1 } } }) }), /sends SOL/);
  // and the balance check refuses any such account that ends lower, closed, handed over or delegated
  const { jupBalanceGuard } = await import('../src/solEngine.ts');
  const st = (amount, over = {}) => ({ mint: 'USDCmint', owner: fx.user, amount, delegate: '', ...over });
  const g = { side: 'sell', amount: 100n, minOut: 1n, feesMax: 0n, rentMax: 0n, user: fx.user, solBefore: 10n, solAfter: 20n, coinBefore: 100n, coinAfter: 0n, wsolBefore: null, wsolAfter: null };
  assert.equal(jupBalanceGuard({ ...g, others: [{ address: other, before: st(5000n), after: st(5000n) }] }), '');
  assert.match(jupBalanceGuard({ ...g, others: [{ address: other, before: st(5000n), after: st(4999n) }] }), /would take/);
  assert.match(jupBalanceGuard({ ...g, others: [{ address: other, before: st(5000n), after: null }] }), /close/);
  assert.match(jupBalanceGuard({ ...g, others: [{ address: other, before: st(5000n), after: st(5000n, { owner: 'X' }) }] }), /someone else/);
  assert.match(jupBalanceGuard({ ...g, others: [{ address: other, before: st(5000n), after: st(5000n, { delegate: 'X' }) }] }), /let someone spend/);
});

test('wiring: a route through held accounts reads them before and in a second simulation, at most 8, owned by this wallet', () => {
  const eng = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
  assert.ok(eng.includes('jupInnerGuard({ inner: sim.innerInstructions, user, side, amount, wsolAta, coinAta, rentMax: RENT_ATA22, through })'));
  assert.ok(eng.includes('if (!innerWhy && through.size) {'));
  assert.ok(eng.includes('if (via.length > 8)'));
  assert.ok(eng.includes("const bad = via.find((_, i) => !states[i] || states[i]!.owner !== user);"));
  assert.ok(eng.includes('sim = await simulateSeeing(trial, [user, coinAta, wsolAta, ...via]);'));
});

test('no inner instructions from the node: the slow path (all token accounts) is used, never a silent pass', () => {
  assert.equal(jupInnerGuard({ ...base, inner: undefined }), 'no inner instructions');
});

test('wiring: one simulation with inner instructions, tables cached and read at once, one quote per click, warmed on prewarm', () => {
  const eng = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8'), web = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.ok(eng.includes("innerInstructions: true, accounts: { encoding: 'base64', addresses: addrs }"));
  assert.ok(eng.includes('const jupTableCache = new Map') && eng.includes('const got = await accounts(miss);'));
  assert.ok(eng.includes('const jupQuoteMemo = new Map') && eng.includes('Date.now() - hit.at < 1500'));
  assert.ok(!/walletTokenAccounts\(user\)\]\)/.test(eng), 'the token-account list is no longer read on every click');
  assert.ok(web.includes('solJupWarm(r);'));
});

// security audit VA-6 / VA-7 (2026-10-25)
test('VA-6: SOL and wrapped SOL are one total — pre-held wSOL cannot be spent on a buy or stand in for a sell\'s proceeds', async () => {
  const { jupBalanceGuard } = await import('../src/solEngine.ts');
  const g = { side: 'buy', amount: 10n ** 8n, minOut: 1000n, feesMax: 10n ** 5n, rentMax: 3n * 10n ** 6n, user: fx.user, coinBefore: 0n, coinAfter: 5000n, wsolBefore: null, wsolAfter: null, others: [] };
  assert.equal(jupBalanceGuard({ ...g, solBefore: 10n ** 9n, solAfter: 10n ** 9n - 10n ** 8n - 10n ** 5n, wsolLamportsBefore: 0n, wsolLamportsAfter: 0n }), '');
  // the wallet held 1 SOL of wSOL; the route spends it AND the amount (wSOL closed → after 0): refused now
  assert.match(jupBalanceGuard({ ...g, solBefore: 10n ** 9n, solAfter: 10n ** 9n - 10n ** 8n, wsolLamportsBefore: 10n ** 9n + 2_039_280n, wsolLamportsAfter: 0n }), /more SOL than the amount/);
  // a sell paying ~0 while the closed wSOL account's own lamports make native SOL rise: refused
  assert.match(jupBalanceGuard({ ...g, side: 'sell', amount: 5000n, minOut: 10n ** 8n, coinBefore: 5000n, coinAfter: 0n, solBefore: 10n ** 9n, solAfter: 10n ** 9n + 10n ** 9n, wsolLamportsBefore: 10n ** 9n + 2_039_280n, wsolLamportsAfter: 0n }), /less SOL than Jupiter/);
});
test('VA-7: the route must pay within 30 % of motion\'s own price; a sell without one is refused', async () => {
  const { jupPriceCheck } = await import('../src/solEngine.ts');
  // 0.1 SOL at 0.00002 SOL per token (6 decimals) = 5000 tokens = 5e9 units
  assert.equal(jupPriceCheck({ side: 'buy', amount: 10n ** 8n, minOut: 4_800_000_000n, decimals: 6, priceSol: 0.00002 }), '');
  assert.match(jupPriceCheck({ side: 'buy', amount: 10n ** 8n, minOut: 2_000_000_000n, decimals: 6, priceSol: 0.00002 }), /far less than the market/);
  assert.equal(jupPriceCheck({ side: 'buy', amount: 10n ** 8n, minOut: 1n, decimals: 6, priceSol: null }), '', 'a buy without a motion price is bounded by the trade cap');
  assert.match(jupPriceCheck({ side: 'sell', amount: 5_000_000_000n, minOut: 1n, decimals: 6, priceSol: null }), /no market price/);
  assert.match(jupPriceCheck({ side: 'sell', amount: 5_000_000_000n, minOut: 10_000_000n, decimals: 6, priceSol: 0.00002 }), /far less/);
  assert.equal(jupPriceCheck({ side: 'sell', amount: 5_000_000_000n, minOut: 95_000_000n, decimals: 6, priceSol: 0.00002 }), '');
});

// Swap V2 /build (2026-10-25): one request — quote, instructions, lookup tables; keyless first, motion's proxy on a 429
test('/build: a real answer is taken; a looser minimum, extra instructions, another trade are refused; a 429 goes through motion', async () => {
  const { jupBuild } = await import('../src/solEngine.ts');
  const real = JSON.parse(readFileSync(new URL('./fixtures/jupiter-build-2026-10-25.json', import.meta.url), 'utf8'));
  const r = { mint: real.outputMint, venue: 'jupiter', tokenProgram: P.token22, decimals: 6, symbol: 'X', pool: '', isCashback: false, isMayhem: false };
  const user = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
  const calls = []; const realFetch = globalThis.fetch;
  const answer = (body, status = 200) => async (url) => { calls.push(String(url)); return { status, json: async () => body }; };
  try {
    globalThis.fetch = answer(real);
    const b = await jupBuild(r, 'buy', BigInt(real.inAmount), real.slippageBps / 100, user);
    assert.equal(b.quote.otherAmountThreshold, real.otherAmountThreshold); assert.equal(b.tables.length, Object.keys(real.addressesByLookupTableAddress).length);
    assert.match(calls[0], /^https:\/\/api\.jup\.ag\/swap\/v2\/build\?/); assert.match(calls[0], new RegExp('taker=' + user));
    globalThis.fetch = answer({ ...real, otherAmountThreshold: '1' });
    await assert.rejects(jupBuild(r, 'buy', BigInt(real.inAmount), real.slippageBps / 100, user), /minimum does not match/);
    globalThis.fetch = answer({ ...real, otherInstructions: [real.swapInstruction] });
    await assert.rejects(jupBuild(r, 'buy', BigInt(real.inAmount), real.slippageBps / 100, user), /does not sign/);
    globalThis.fetch = answer({ ...real, inAmount: '1' });
    await assert.rejects(jupBuild(r, 'buy', BigInt(real.inAmount), real.slippageBps / 100, user), /different trade/);
    calls.length = 0; let n = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); n += 1; return n === 1 ? { status: 429, json: async () => ({ code: 429 }) } : { status: 200, json: async () => real }; };
    await jupBuild(r, 'buy', BigInt(real.inAmount), real.slippageBps / 100, user);
    assert.equal(calls.length, 2); assert.match(calls[1], /\/sol\/api\/jup\/build\?/, 'the second try goes through motion\'s server (the key stays there)');
  } finally { globalThis.fetch = realFetch; }
});
