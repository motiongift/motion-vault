// (release 6) HyperEVM HYPE → Elysium HYPE through motion's own bridge, 0.1 % fee — the VAULT side (src/elysiumHyperFund.ts) against a
// MOCK solver that runs the same pure core as the real one (src/motionBridgeCore.ts: sameCoinOut at 10 bps / $0.01, evmSourceProblem on
// the raw bytes the vault signed, its own ed25519 quote key pinned here). Throwaway keys, no network. What this file proves:
//   - 1 HYPE → 0.999 HYPE: the quote is a price read (nothing signed, no dialog); the vault's own dialog names the fee and the ~6-day way
//     out; ONE plain HYPE transfer on chain 999 from W to the published deposit address, nothing else;
//   - nothing is signed for a solver that takes more than the fee, names another deposit address or pays someone else; a contract
//     wallet, a paused route, a route the solver does not serve, a declined dialog, too little HYPE — nothing moves;
//   - the wiring in webEngine.ts: elysiumFund { from: 'hyperevm' } only, W's own key, the official HyperEVM node, no broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import * as C from '../src/motionBridgeCore.ts';
import { createSolverBridge } from '../src/bridgeSolver.ts';
import { createElyHyperFund, hyperFundArgs, hyperQuoteProblem, hyperMaxFeeWei, hyperTxProblem, weiOf, HYPER_FUND } from '../src/elysiumHyperFund.ts';

const lc = (a) => String(a).toLowerCase();
const E18 = 10n ** 18n, HYPE6 = 86n * C.USD6;

function mockSolver(o = {}) {
  const seed = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposit = privateKeyToAccount(generatePrivateKey()).address;
  const s = { quotes: new Map(), fills: [], pub, deposit };
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  s.fetch = async (url, init) => {
    const path = String(url).split('/api/bridge/motion')[1] || '';
    if (path.startsWith('/health')) return json({ ok: true, on: true, solver: pub, chains: o.chains || ['robinhood', 'bsc', 'sol', 'elysium', 'hyperevm'], deposits: { hyperevm: deposit, elysium: deposit }, maxFillUsd: 1000, minFillUsd: 0.1,
      elysium: { pay: ['stable', 'native'], assets: ['native'], withdrawDays: 6, paused: !!o.paused, why: o.paused ? ['the Bridge proxy implementation changed'] : [], maxFillUsd: 100, fee: { bps: 10, minUsd: 0.01 }, sources: ['hyperevm'] } });
    if (path.startsWith('/quote')) {
      const b = JSON.parse(init.body); s.lastQuoteBody = b;
      const r = C.sameCoinOut(BigInt(b.amount), HYPE6, 18, o.feeBps ?? 10, 10_000n);
      const at = Date.now();
      const q = { v: 1, id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
        src: { chain: b.from, token: C.NATIVE_TOKEN, amount: String(b.amount), depositor: b.depositor, deposit: o.otherDeposit || deposit },
        dst: { chain: 'elysium', recipient: o.payTo || b.recipient, amount: String(r.out) },
        price6: String(HYPE6), fee6: String(r.fee6), usd6: String(C.nativeToUsd6(BigInt(b.amount), HYPE6, 18)), issuedAt: at, expiresAt: at + 45_000, solver: pub };
      s.quotes.set(q.id, q);
      return json({ ok: true, quote: q, sig: C.signQuote(q, seed) });
    }
    if (path.startsWith('/fill')) {
      const b = JSON.parse(init.body); const q = s.quotes.get(b.id);
      const tx = parseTransaction(b.raw); const from = await recoverTransactionAddress({ serializedTransaction: b.raw });
      const why = C.evmSourceProblem(tx, from, q);
      s.fills.push({ q, tx, from, why, raw: b.raw });
      if (o.lost) throw new Error('socket hang up');
      if (why) return json({ ok: false, sent: false, error: why }, false);
      return json({ ok: true, state: 'paid', srcHash: keccak256(b.raw), dstHash: '0x' + 'd'.repeat(64) });
    }
    throw new Error('unexpected ' + path);
  };
  return s;
}
function world(o = {}) {
  const key = generatePrivateKey(), W = privateKeyToAccount(key);
  const solver = mockSolver(o.solver || {});
  const st = { asks: [], signed: [], gates: 0, bal: o.bal ?? 5n * E18 };
  const api = createElyHyperFund({
    now: () => Date.now(),
    wallet: (id) => ({ id, name: 'Wallet 1', w: W.address, sign: async (tx) => { st.signed.push(tx); return W.signTransaction(tx); } }),
    reads: { balance: async () => st.bal, code: async () => (o.contract ? '0xef0100' + 'a'.repeat(40) : '0x'), price6: async () => HYPE6, nonce: async () => 7, gasPrice: async () => 100_000_000n },
    bridge: (signEvm) => createSolverBridge({ base: () => 'https://motion.gift', fetch: solver.fetch, now: () => Date.now(), pinnedKey: () => solver.pub, signEvmTransfer: signEvm, signSolTransfer: async () => { throw new Error('no'); } }),
    gate: async () => { st.gates += 1; },
    ask: async (d) => { st.asks.push(d); return !o.decline; },
    esc: (v) => String(v).replace(/[<>&"]/g, ''), destBox: (a) => `<div>${a}</div>`,
    lock: (k, fn) => fn(), risk: 'Elysium\'s bridge can be upgraded by Kinetiq\'s 4-of-11 multisig without a delay.',
  });
  return { api, solver, st, W };
}
const fund = (x, extra = {}) => x.api.fund({ walletId: 'w1', from: 'hyperevm', pay: 'native', asset: 'HYPE', amount: 1, ...extra });

test('1 HYPE on HyperEVM → 0.999 HYPE on Elysium: a price read first; then the vault\'s dialog (fee 0.1 %, ~6 days out) and ONE plain HYPE transfer on chain 999', async () => {
  const x = world();
  const q = await fund(x, { phase: 'quote' });
  assert.equal(q.phase, 'quote'); assert.equal(q.in, String(E18)); assert.equal(q.out, String(999n * 10n ** 15n)); assert.equal(q.fee, String(10n ** 15n));
  assert.equal(q.outText, '0.9990 HYPE'); assert.equal(q.feeText, '0.1 %');
  assert.equal(q.back, 'Leaving Elysium goes through the official bridge and takes about 6 days.');
  assert.equal(x.st.signed.length, 0); assert.equal(x.st.asks.length, 0); assert.equal(x.st.gates, 0, 'a price read asks nothing and signs nothing');
  assert.equal(x.solver.lastQuoteBody.pay, 'native'); assert.equal(x.solver.lastQuoteBody.from, 'hyperevm'); assert.equal(x.solver.lastQuoteBody.to, 'elysium');
  assert.equal(lc(x.solver.lastQuoteBody.depositor), lc(x.W.address)); assert.equal(lc(x.solver.lastQuoteBody.recipient), lc(x.W.address));
  const r = await fund(x);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'paid'); assert.equal(r.out, String(999n * 10n ** 15n)); assert.equal(r.fee, String(10n ** 15n));
  assert.equal(x.st.gates, 1); assert.equal(x.st.asks.length, 1);
  const d = x.st.asks[0];
  assert.equal(d.title, 'Move HYPE from HyperEVM to Elysium'); assert.equal(d.ok, 'Move 1.0000 HYPE');
  assert.match(d.html, /1\.0000 HYPE from Wallet 1 on HyperEVM to motion's bridge\. 0\.9990 HYPE arrives at the same address on Elysium/);
  assert.match(d.html, /Fee 0\.1 % \(0\.0010 HYPE\)\./);
  assert.match(d.html, /Leaving Elysium goes through the official bridge and takes about 6 days\./);
  assert.doesNotMatch(d.html, /Kleos|cheaper|than /i, 'no comparison text');
  // the one signature
  assert.equal(x.st.signed.length, 1);
  const f = x.solver.fills[0];
  assert.equal(f.why, '', 'the solver\'s own check of the bytes passes');
  assert.equal(lc(f.from), lc(x.W.address)); assert.equal(Number(f.tx.chainId), 999); assert.equal(lc(f.tx.to), lc(x.solver.deposit));
  assert.equal(f.tx.value, E18); assert.ok(!f.tx.data || f.tx.data === '0x'); assert.equal(f.tx.gas, 21_000n); assert.equal(f.tx.nonce, 7);
});

test('nothing is signed for a solver that takes more than the fee, names an unpublished deposit address or pays someone else', async () => {
  const greedy = world({ solver: { feeBps: 50 } });
  await assert.rejects(fund(greedy), /more than motion's 0\.1 % fee/); assert.equal(greedy.st.signed.length, 0); assert.equal(greedy.st.asks.length, 0);
  const other = world({ solver: { otherDeposit: privateKeyToAccount(generatePrivateKey()).address } });
  await assert.rejects(fund(other), /unpublished deposit address/); assert.equal(other.st.signed.length, 0);
  const thief = world({ solver: { payTo: privateKeyToAccount(generatePrivateKey()).address } });
  await assert.rejects(fund(thief), /pays someone else/); assert.equal(thief.st.signed.length, 0);
});

test('nothing moves: a route the solver does not serve, a pause, a contract wallet, a declined dialog, more than the wallet holds', async () => {
  const off = world({ solver: { chains: ['robinhood', 'elysium'] } });
  await assert.rejects(fund(off), /does not take HYPE from HyperEVM/);
  const paused = world({ solver: { paused: true } });
  await assert.rejects(fund(paused), /paused: the Bridge proxy implementation changed/);
  const ctr = world({ contract: true });
  await assert.rejects(fund(ctr), /code on HyperEVM/);
  const no = world({ decline: true });
  await assert.rejects(fund(no), /Cancelled/); assert.equal(no.st.signed.length, 0); assert.equal(no.solver.fills.length, 0);
  const poor = world({ bal: E18 });
  await assert.rejects(fund(poor), /More than this wallet holds/);
  const max = await fund(world({ bal: 2n * E18 }), { amount: 'max', phase: 'quote' });
  assert.equal(BigInt(max.in), 2n * E18 - 2n * 21_000n * 125_000_000n, '"max" leaves twice the transfer\'s gas');
  for (const x of [off, paused, ctr, poor]) assert.equal(x.st.signed.length, 0);
});

test('a lost answer: the transfer may be out — "TransferUnknown" with its hash, never a second signature', async () => {
  const x = world({ solver: { lost: true } });
  const e = await fund(x).catch((err) => err);
  assert.equal(e.name, 'TransferUnknown'); assert.equal(e.unknown, true); assert.match(String(e.srcHash), /^0x[0-9a-f]{64}$/);
  assert.equal(x.st.signed.length, 1);
});

test('the pure rules: arguments, the fee bound, the transfer check', () => {
  assert.equal(hyperFundArgs({ walletId: 'w', from: 'hyperevm', amount: 1.5 }).amount, 15n * 10n ** 17n);
  assert.equal(weiOf(0.1), 10n ** 17n); assert.equal(weiOf(1.000000000000000001), E18, 'a JS number carries what it can');
  assert.throws(() => hyperFundArgs({ walletId: 'w', from: 'hyperevm', pay: 'stable', amount: 1 }), /HYPE only/);
  assert.throws(() => hyperFundArgs({ walletId: 'w', from: 'hyperevm', asset: 'USDC', amount: 1 }), /HYPE for HYPE only/);
  assert.throws(() => hyperFundArgs({ walletId: 'w', from: 'hyperevm', amount: 1, to: '0x1' }), /unknown field to/);
  assert.throws(() => hyperFundArgs({ walletId: 'w', from: 'robinhood', amount: 1 }), /from/);
  assert.throws(() => hyperFundArgs({ walletId: 'w', from: 'hyperevm', amount: -1 }), /Invalid amount/);
  assert.equal(hyperMaxFeeWei(E18, HYPE6), 10n ** 15n, '10 bps of 1 HYPE');
  assert.ok(hyperMaxFeeWei(10n ** 15n, HYPE6) >= C.sameCoinOut(10n ** 15n, HYPE6, 18, 10, 10_000n).fee, 'the $0.01 minimum fits under the bound');
  const dep = '0x' + '2'.repeat(40);
  const q = { v: 1, id: 'a'.repeat(32), src: { chain: 'hyperevm', token: C.NATIVE_TOKEN, amount: String(E18), depositor: '0x' + '1'.repeat(40), deposit: dep }, dst: { chain: 'elysium', recipient: '0x' + '1'.repeat(40), amount: String(999n * 10n ** 15n) }, price6: '1', fee6: '0', usd6: '1', issuedAt: 1, expiresAt: 2, solver: 'b'.repeat(64) };
  assert.equal(hyperQuoteProblem(q, E18, HYPE6, dep), '');
  assert.equal(hyperQuoteProblem({ ...q, dst: { ...q.dst, amount: String(998n * 10n ** 15n) } }, E18, HYPE6, dep), 'the quote takes more than motion\'s 0.1 % fee');
  assert.equal(hyperQuoteProblem({ ...q, dst: { ...q.dst, asset: 'stable' } }, E18, HYPE6, dep), 'the quote is not HYPE for HYPE');
  const tx = { chainId: 999, to: dep, value: E18, data: '0x', gas: 21_000n, gasPrice: 125_000_000n };
  assert.equal(hyperTxProblem(tx, q), '');
  assert.equal(hyperTxProblem({ ...tx, chainId: 99901 }, q), 'not HyperEVM');
  assert.equal(hyperTxProblem({ ...tx, data: '0xa9059cbb' }, q), 'carries calldata');
  assert.equal(hyperTxProblem({ ...tx, gasPrice: HYPER_FUND.maxGasPriceWei + 1n }, q), 'abnormal gas price');
  // the solver's own check agrees on these exact bytes
  assert.equal(C.evmSourceProblem({ ...tx }, q.src.depositor, q), '');
});

test('the wiring in webEngine.ts: only elysiumFund { from: "hyperevm" }, W\'s own key on chain 999, the official HyperEVM node, nothing broadcast by the vault', () => {
  const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const i = WE.indexOf('function elysiumFundFromHyperEvm('); assert.ok(i > 0);
  const fn = WE.slice(i, WE.indexOf('\n}\n', i));
  assert.match(WE, /elysiumFund: async \(o: [^\n]*\n {4}if \(\(o as \{ from\?: unknown \} \| null\)\?\.from === 'hyperevm'\) return elysiumFundFromHyperEvm\(o, auth\);/);
  assert.match(fn, /if \(NEAR_MODE \|\| SOL_MODE\) return Promise\.reject/);
  assert.match(fn, /if \(!a \|\| a\.ext \|\| a\.hop\) throw new Error\('Unknown wallet'\)/);
  assert.match(fn, /const pc = elysiumOraclePc\(\);/);
  assert.match(fn, /pinnedKey: \(\) => MOTION_SOLVER_KEY/);
  assert.match(fn, /gate: \(\) => gate\('transfer', auth\)/);
  assert.doesNotMatch(fn, /sendRawTransaction|signAndSend|broadcast\(|laneLock\(|nextNonce\(/, 'signed only; never the frame\'s own send lane');
  const ENG = readFileSync(new URL('../src/elysiumHyperFund.ts', import.meta.url), 'utf8');
  assert.match(ENG, /depositor: w\.w, recipient: w\.w,/); assert.doesNotMatch(ENG, /recipient: (?!w\.w)/, 'no other recipient');
  assert.ok(ENG.indexOf('hyperQuoteProblem(got.quote') < ENG.indexOf('await deps.gate()'), 'checked before the gate and the dialog');
  assert.ok(ENG.indexOf("if (!ok) throw new Error('Cancelled')") < ENG.indexOf('allowed = got.quote'), 'nothing may be signed before the click');
});
