// Cross-chain swaps on Relay + the Relay-key fallback (2026-10-29; owner: “approved”). Pure decisions of src/relayApi.ts
// and src/relaySwap.ts against REAL Relay answers (test/fixtures/relay-quote-*.json: keyless quote/v2, 2026-10-29, never
// executed), every tampering a lying quote source could try, and source pins for the engine wiring. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  relayQuote, setRelayProxyBase, keyRefused, detailsProblem, evmStepsProblem, solStepsProblem, priceProblem, independentOut, relayBody,
  RELAY_DEPOSITORY, NATIVE_EVM, NATIVE_SOL, RELAY_SOL, SOL_PROGRAMS,
} from '../src/relayApi.ts';
import { solSimProblem, swapRequestProblem, bindSwap, SOL_COST_CAP } from '../src/relaySwap.ts';
import { b58d } from '../src/solEngine.ts';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const ERC = fx('relay-quote-erc20.json'), SOLTOK = fx('relay-quote-sol-token.json'), SOLNAT = fx('relay-quote-sol-native.json');
const DEAD = '0x000000000000000000000000000000000000dEaD', USDT = '0x55d398326f99059ff775485246999027b3197955';
const SOLU = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const clone = (x) => JSON.parse(JSON.stringify(x));
const wantErc = { user: DEAD, originChainId: 56, originCurrency: USDT, amount: '20000000000000000000' };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ── where the quote comes from ──
test('quote source: keyless Relay first; motion\'s keyed pass-through ONLY when Relay wants a key; anything else is an error', async () => {
  const calls = [];
  const f = (answers) => async (url, init) => { calls.push([url, init]); return answers.shift(); };
  setRelayProxyBase(() => 'https://motion.gift');
  const body = relayBody({ user: DEAD, recipient: DEAD, originChainId: 56, destinationChainId: 4663, originCurrency: USDT, destinationCurrency: NATIVE_EVM, amount: '1' });
  let r = await relayQuote(body, f([reply(200, ERC)]));
  assert.equal(r.source, 'relay'); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://api.relay.link/quote/v2');
  assert.ok(!('x-api-key' in calls[0][1].headers), 'the vault never sends a key');
  calls.length = 0;
  // (audit 2026-11-01, vault-security-relay-recipient) by default a key refusal is a refusal: the pass-through is never asked
  await assert.rejects(relayQuote(body, f([reply(401, { errorCode: 'UNAUTHORIZED_QUOTE', message: 'API key required' }), reply(200, ERC)])), /API key.*cannot be checked for where it pays out/);
  assert.equal(calls.length, 1, "a key refusal never reaches motion's pass-through");
  calls.length = 0;
  // a bare 403 (a WAF / Cloudflare page) is not Relay asking for a key: never the pass-through, even when opted in
  await assert.rejects(relayQuote(body, f([reply(403, null), reply(200, ERC)]), { viaMotion: true }), /Relay: no quote/);
  assert.equal(calls.length, 1, "a bare 403 never reaches motion's pass-through");
  assert.equal(keyRefused(403, null), false); assert.equal(keyRefused(403, { message: 'Forbidden' }), false); assert.equal(keyRefused(403, { errorCode: 'UNAUTHORIZED_QUOTE' }), true);
  calls.length = 0;
  r = await relayQuote(body, f([reply(401, { errorCode: 'UNAUTHORIZED_QUOTE', message: 'API key required' }), reply(200, ERC)]), { viaMotion: true });
  assert.equal(r.source, 'motion'); assert.equal(calls[1][0], 'https://motion.gift/api/bridge/vault-quote');
  assert.equal(calls[1][1].headers['content-type'], 'text/plain', 'a simple request, like the 2FA check');
  assert.deepEqual(JSON.parse(calls[1][1].body), body, 'the pass-through gets exactly the vault\'s body (its pinned app fee included)');
  calls.length = 0;
  await assert.rejects(relayQuote(body, f([reply(400, { message: 'Amount too low' })])), /Amount too low/);
  assert.equal(calls.length, 1, 'a refusal that is not about the key never goes to motion');
  setRelayProxyBase(() => 'javascript:alert(1)');
  await assert.rejects(relayQuote(body, f([reply(401, { errorCode: 'UNAUTHORIZED_QUOTE' })]), { viaMotion: true }), /Relay/, 'no pass-through outside an https origin');
  setRelayProxyBase(() => '');
  assert.equal(keyRefused(401, {}), true); assert.equal(keyRefused(400, { message: 'missing x-api-key header' }), true); assert.equal(keyRefused(400, { message: 'no route' }), false);
  assert.deepEqual(body.appFees, [{ recipient: '0xaBA747718975a4d0a25EcB0Ac5Ebe609A6c340ad', fee: '50' }]);
});

// ── the quote's claims ──
test('details: depositor, recipient, both chains, both coins, the exact amount — a real quote passes, every swap of a field is refused', () => {
  const want = { user: DEAD, recipient: DEAD, originChainId: 56, destinationChainId: 4663, originCurrency: USDT, destinationCurrency: NATIVE_EVM, amount: '20000000000000000000' };
  assert.equal(detailsProblem(ERC, want), null);
  const bad = (fn, re) => { const j = clone(ERC); fn(j); assert.match(String(detailsProblem(j, want)), re); };
  bad((j) => { j.details.recipient = '0x' + '1'.repeat(40); }, /another recipient/);
  bad((j) => { j.details.sender = '0x' + '2'.repeat(40); }, /another depositor/);
  bad((j) => { j.details.currencyIn.amount = '1'; }, /another amount/);
  bad((j) => { j.details.currencyOut.currency.address = USDT; }, /pays another coin/);
  bad((j) => { j.details.currencyIn.currency.address = NATIVE_EVM; }, /spends another coin/);
  bad((j) => { j.details.currencyOut.currency.chainId = 1; }, /other chains/);
  bad((j) => { j.requestId = 'x'; }, /request id/);
});

// ── EVM steps ──
test('EVM: an exact approve of the coin to Relay\'s pinned depository, then depositErc20(this wallet, coin, amount) — and nothing else', () => {
  const ok = evmStepsProblem(ERC, wantErc);
  assert.ok(!('problem' in ok), JSON.stringify(ok));
  assert.equal(ok.deposit.to.toLowerCase(), RELAY_DEPOSITORY); assert.equal(ok.approve.to.toLowerCase(), USDT);
  const bad = (fn, re, want = wantErc) => { const j = clone(ERC); fn(j); const r = evmStepsProblem(j, want); assert.ok('problem' in r, 'not refused: ' + re); assert.match(r.problem, re); };
  const ap = (j) => j.steps[0].items[0].data, dep = (j) => j.steps[1].items[0].data;
  bad((j) => { ap(j).data = ap(j).data.slice(0, 74) + 'f'.repeat(64); }, /exactly the amount/);                          // unlimited approve
  bad((j) => { ap(j).data = '0x095ea7b3' + '0'.repeat(24) + 'b'.repeat(40) + ap(j).data.slice(74); }, /not to Relay/); // another spender
  bad((j) => { ap(j).to = '0x' + 'c'.repeat(40); }, /another coin/);
  bad((j) => { ap(j).data = '0xa9059cbb' + ap(j).data.slice(10); }, /plain approve/);                                  // transfer instead
  bad((j) => { dep(j).to = '0x' + 'd'.repeat(40); }, /depository/);
  bad((j) => { dep(j).data = dep(j).data.slice(0, 10) + '0'.repeat(24) + 'e'.repeat(40) + dep(j).data.slice(74); }, /name this wallet/);
  bad((j) => { dep(j).data = dep(j).data.slice(0, 138) + '0'.repeat(63) + '1' + dep(j).data.slice(202); }, /not the amount/);
  bad((j) => { dep(j).value = '1'; }, /native coin/);
  bad((j) => { j.steps.push({ id: 'authorize1', kind: 'signature', items: [{ data: {} }] }); }, /unexpected steps/);
  bad((j) => { j.steps.splice(1, 0, clone(j.steps[1])); }, /unexpected steps/);
  bad((j) => { dep(j).chainId = 1; }, /another chain/);
  // a quote with no approve (allowance already there) is fine; the vault re-reads the allowance and approves exactly if short
  const noAp = clone(ERC); noAp.steps.shift(); assert.ok(!('problem' in evmStepsProblem(noAp, wantErc)));
});
test('EVM native: depositNative(this wallet) into the depository with exactly the amount as value', () => {
  const step = { to: RELAY_DEPOSITORY, data: '0x49290c1c' + '0'.repeat(24) + DEAD.slice(2).toLowerCase() + 'ab'.repeat(32), value: '10000000000000000', chainId: 4663 };
  const j = { steps: [{ id: 'deposit', kind: 'transaction', items: [{ data: step }] }] };
  const want = { user: DEAD, originChainId: 4663, originCurrency: NATIVE_EVM, amount: '10000000000000000' };
  assert.ok(!('problem' in evmStepsProblem(j, want)));
  assert.match(evmStepsProblem(j, { ...want, amount: '1' }).problem, /value is not the amount/);
  const router = clone(j); router.steps[0].items[0].data.to = '0x0729e2a4716d9f7dd17858d5d504426d228697f7';
  assert.match(evmStepsProblem(router, want).problem, /depository/, 'Relay\'s router (POL / AVAX native) is never accepted on this check');
});

// ── Solana steps + simulation ──
test('Solana: one deposit; Relay / Jupiter / standard programs only; this wallet the only signer; Relay\'s depository vault in it', () => {
  for (const j of [SOLTOK, SOLNAT]) assert.ok(!('problem' in solStepsProblem(j, SOLU)), JSON.stringify(solStepsProblem(j, SOLU)));
  const bad = (fn, re) => { const j = clone(SOLTOK); fn(j.steps[0].items[0].data); const r = solStepsProblem(j, SOLU); assert.ok('problem' in r); assert.match(r.problem, re); };
  bad((d) => { d.instructions[2].programId = 'Evi1Program1111111111111111111111111111111'; }, /not Relay's or a standard one/);
  bad((d) => { d.instructions[3].keys.push({ pubkey: 'F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe', isSigner: true, isWritable: true }); }, /signer other than this wallet/);
  bad((d) => { d.instructions = d.instructions.filter((x) => x.programId !== 'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr'); }, /no deposit into Relay/);
  bad((d) => { for (const x of d.instructions) x.keys = x.keys.filter((k) => k.pubkey !== '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'); }, /depository vault/);
  assert.ok(SOL_PROGRAMS.has('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') && !SOL_PROGRAMS.has('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
});
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const tokAcc = (mint, owner, amount, delegate = '') => { const d = new Uint8Array(165); d.set(b58d(mint), 0); d.set(b58d(owner), 32); new DataView(d.buffer).setBigUint64(64, BigInt(amount), true); if (delegate) { d[72] = 1; d.set(b58d(delegate), 76); } return { owner: TOKEN, lamports: 2039280n, data: d }; };
const wal = (l) => ({ owner: '11111111111111111111111111111111', lamports: BigInt(l), data: new Uint8Array(0) });
test('Solana simulation: the wallet may lose only the amount of the origin coin and ≤ 0.02 SOL; no account handed over, delegated or drained', () => {
  const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', ATA1 = 'Dzk6FuwJxFaaJhRZt6N1kz9wvi3SStjdHJXYPgYD5kLi', ATA2 = 'FrBGXeGEc6vJZ5JTX8rZkUVLuzu8Z6Ag1QYkGrXbrHtH', EVIL = 'F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe';
  const base = { user: SOLU, originCurrency: BONK, amount: 200000000000n, addrs: [SOLU, ATA1, ATA2] };
  const pre = [wal(1e9), tokAcc(BONK, SOLU, 300000000000n), null];
  assert.equal(solSimProblem({ ...base, pre, post: [wal(1e9 - 2_100_000), tokAcc(BONK, SOLU, 100000000000n), tokAcc(OTHER, SOLU, 0)] }), null, 'the amount + fee + a new account\'s rent');
  assert.match(solSimProblem({ ...base, pre, post: [wal(1e9 - 30_000_000), tokAcc(BONK, SOLU, 100000000000n), null] }), /more SOL/);
  assert.match(solSimProblem({ ...base, pre, post: [wal(1e9), tokAcc(BONK, SOLU, 0n), null] }), /more of the coin than the amount/);
  assert.match(solSimProblem({ ...base, pre: [wal(1e9), tokAcc(BONK, SOLU, 3e11), tokAcc(OTHER, SOLU, 50)], post: [wal(1e9), tokAcc(BONK, SOLU, 1e11), tokAcc(OTHER, SOLU, 0)] }), /a coin this swap does not spend/);
  assert.match(solSimProblem({ ...base, pre, post: [wal(1e9), tokAcc(BONK, EVIL, 3e11), null] }), /hand one of this wallet's token accounts/);
  assert.match(solSimProblem({ ...base, pre, post: [wal(1e9), tokAcc(BONK, SOLU, 1e11, EVIL), null] }), /someone else spend/);
  assert.match(solSimProblem({ ...base, pre, post: [wal(1e9), null, null] }), /close one of this wallet's token accounts/);
  // SOL origin: the amount itself may leave the wallet as lamports
  assert.equal(solSimProblem({ user: SOLU, originCurrency: NATIVE_SOL, amount: 100_000_000n, addrs: [SOLU], pre: [wal(1e9)], post: [wal(1e9 - 100_000_000 - 1_000_000)] }), null);
  assert.equal(SOL_COST_CAP, 20_000_000n);
});

// ── price sanity for a quote that came through motion ──
test('price: a relayed quote must pay ≥ 97 % of Relay\'s own keyless price (or, failing that, ≥ 85 % of the coins\' USD value); no reading → refused', async () => {
  assert.equal(priceProblem(970n, 18, { out: 1000n }), null);
  assert.match(priceProblem(969n, 18, { out: 1000n }), /less than Relay's own price/);
  assert.match(priceProblem(1n, 18, null), /no independent Relay price/);
  assert.equal(priceProblem(10n ** 18n, 18, { usdIn: 100, pOut: 90 }), null);
  assert.match(priceProblem(10n ** 18n, 18, { usdIn: 200, pOut: 90 }), /far less/);
  const body = relayBody({ user: DEAD, recipient: DEAD, originChainId: 56, destinationChainId: 4663, originCurrency: USDT, destinationCurrency: NATIVE_EVM, amount: '20000000000000000000' });
  const viaPrice = await independentOut(body, 18, async (u) => (String(u).endsWith('/price') ? reply(200, { details: { currencyOut: { amount: '777' } } }) : reply(500, {})));
  assert.deepEqual(viaPrice, { out: 777n });
  const viaUsd = await independentOut(body, 18, async (u) => (String(u).endsWith('/price') ? reply(401, {}) : reply(200, { price: String(u).includes(USDT) ? 1 : 2300 })));
  assert.deepEqual(viaUsd, { usdIn: 20, pOut: 2300 });
});

test('bind: the real ERC-20 quote binds keyless; a quote motion would relay is refused (its recipient is unverifiable)', async () => {
  const q = { originChainId: 56, destinationChainId: 4663, originCurrency: USDT, destinationCurrency: NATIVE_EVM, amount: '20000000000000000000', recipient: DEAD };
  const b = await bindSwap(DEAD, q, async () => reply(200, ERC));
  assert.equal(b.source, 'relay'); assert.deepEqual(b.steps, ['approve', 'deposit']); assert.equal(b.inSymbol, 'USDT'); assert.equal(b.out, ERC.details.currencyOut.amount);
  setRelayProxyBase(() => 'https://motion.gift');
  const routed = (priceOut) => async (u) => (String(u).endsWith('/quote/v2') ? reply(401, { errorCode: 'UNAUTHORIZED_QUOTE' }) : String(u).endsWith('/vault-quote') ? reply(200, ERC) : String(u).endsWith('/price') ? reply(200, { details: { currencyOut: { amount: priceOut } } }) : reply(404, {}));
  // (audit 2026-11-01, vault-security-relay-recipient) an honest-looking relayed quote (details name DEAD as the recipient,
  // Relay's own record may name the server's address) is never bound: Relay wants a key → refused, motion never asked
  const asked = []; const logged = (g) => async (u, i) => { asked.push(String(u)); return g(u, i); };
  await assert.rejects(bindSwap(DEAD, q, logged(routed(ERC.details.currencyOut.amount))), /API key/);
  await assert.rejects(bindSwap(DEAD, q, logged(routed((BigInt(ERC.details.currencyOut.amount) * 2n).toString()))), /API key/);
  assert.ok(!asked.some((u) => u.endsWith('/vault-quote')), "motion's pass-through is never asked for a swap quote");
  setRelayProxyBase(() => '');
  assert.equal(swapRequestProblem({ ...q, originChainId: 56, destinationChainId: 56 }, () => true), 'Pick two different networks');
  assert.equal(swapRequestProblem({ ...q, originCurrency: BONK }, () => true), 'Bad coin address');
  assert.equal(swapRequestProblem({ ...q, recipient: SOLU }, () => true), 'Bad recipient for the destination chain');
  assert.equal(swapRequestProblem(q, (c) => c !== 4663), 'This network is not offered here');
  assert.equal(RELAY_SOL, 792703809);
});

// ── engine wiring (source pins) ──
test('engine: relaySwap has the bridge\'s two phases, gates and dialogs; bridges fall back to the pass-through only with the extra checks', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const sw = src.slice(src.indexOf('  relaySwap: async (id: string'), src.indexOf('  relayTokenBalances: async'));
  assert.ok(sw.includes("await gate('withdraw', auth);") && sw.includes("await gate('transfer', auth);") && sw.includes("title: login ? 'Swap to your login wallet' : 'Swap outside your vault', danger: true"));   // SEC-6 (batch 2): danger either way
  assert.ok(sw.includes("if (!t || t.id !== id || Date.now() - t.at > 90_000) throw new Error('This swap quote expired — press Swap again');"));
  assert.ok(sw.indexOf('swapTickets.set(ticket') > sw.indexOf("await gate('transfer', auth);"), 'the ticket is minted only after the gate and the trusted click');
  assert.ok(sw.includes('const bound = await bindSwap(user,'), 'the vault binds its own quote; the page\'s numbers are only the request');
  assert.ok(src.includes("{ method: 'relaySwap', does:") && src.includes("needs: ['click', 'transfer'], outside: ['click', 'withdraw'] },"));
  const ob = src.slice(src.indexOf('async function ownBridgeQuote('), src.indexOf('const bridgeTickets'));
  assert.ok(ob.includes('const { j, source } = await relayQuote(body as never);') && ob.includes('relayQuoteProblem(j,') && ob.includes("if (source === 'motion') {") && ob.includes('priceProblem('));
  assert.ok(!ob.includes("fetch('https://api.relay.link"), 'the quote goes through relayApi (keyless first)');
  assert.ok(src.includes("bound.source === 'motion' ? await solMotion(bound) : await solBridgeDeposit(a, bound as never)"), 'the frozen Solana deposit stays the keyless path');
  assert.ok(src.includes('setRelayProxyBase(() => (HOST && parentOrigin ? parentOrigin : location.origin));'));
  const be = readFileSync(new URL('../src/bridgeEngine.ts', import.meta.url), 'utf8');
  assert.ok(be.includes("if (q.source === 'motion') {") && be.includes('const own = await relayQuoteDirect('));
  // no key header and no key value anywhere in the vault's Relay code (the word appears only in the refusal it recognises)
  for (const f of ['relayApi.ts', 'relaySwap.ts', 'bridgeEngine.ts']) assert.ok(!/['"]x-api-key['"]\s*:|RELAY_API_KEY|apiKey/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')), `${f}: never a key in the vault`);
});

// ── the USD balance's reads (2026-10-29, owner “USD balance: move its Relay requests to the keyed scheme … do that too”) ──
test('status: keyless and direct (v3, the key optional there; v2 the fallback); never through motion; only a real request id', async () => {
  const { relayStatus } = await import('../src/relayApi.ts');
  const seen = [];
  const f = (answers) => async (url) => { seen.push(url); return answers.shift() || reply(500, {}); };
  const id = '0x' + 'ab'.repeat(32);
  assert.deepEqual(await relayStatus(id, f([reply(200, { status: 'success' })])), { status: 'success' });
  assert.ok(seen[0].startsWith('https://api.relay.link/intents/status/v3?requestId='));
  seen.length = 0;
  assert.deepEqual(await relayStatus(id, f([reply(500, {}), reply(200, { status: 'pending' })])), { status: 'pending' });
  assert.ok(seen[1].startsWith('https://api.relay.link/intents/status/v2?requestId='));
  assert.ok(seen.every((u) => u.startsWith('https://api.relay.link/')), 'never motion');
  assert.equal(await relayStatus('0xreq1', f([])), null);
});
test('request list: keyless v2 first; motion\'s keyed pass-through only when v2 is refused or gone; only rows naming this wallet count', async () => {
  const { relayRequestsOf } = await import('../src/relayApi.ts');
  setRelayProxyBase(() => 'https://motion.gift');
  const R = '0x' + '12'.repeat(20);
  const f = (answers) => async (url) => answers.shift()(url);
  let r = await relayRequestsOf(R, f([() => reply(200, { requests: [{ user: R.toUpperCase().replace('0X', '0x') }, { user: '0x' + '34'.repeat(20) }] })]));
  assert.equal(r.source, 'relay'); assert.equal(r.requests.length, 1);
  const urls = [];
  r = await relayRequestsOf(R, f([(u) => { urls.push(u); return reply(410, { message: 'retired' }); }, (u) => { urls.push(u); return reply(200, { requests: [{ user: R }, { user: '0x' + '56'.repeat(20) }] }); }]));
  assert.equal(r.source, 'motion'); assert.equal(r.requests.length, 1, 'a row of another wallet is dropped');
  assert.equal(urls[1], `https://motion.gift/api/bridge/vault-requests?user=${R}&limit=5`);
  await assert.rejects(relayRequestsOf(R, f([() => reply(401, {}), () => reply(200, { nope: 1 })])), /through motion/);
  setRelayProxyBase(() => '');
});
