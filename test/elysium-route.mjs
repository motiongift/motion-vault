// (2026-11-04) the route choice into Elysium + the official route (src/elysiumRoute.ts). Throwaway keys, no network: Relay's answers
// are real quotes read 4 Nov (test/fixtures/ely-route, api.relay.link POST /quote, fresh address, appFees 10 bps to 0x9646…), the
// HyperEVM / Elysium reads are mocks. What this file proves:
//   - selection: the float while it can fill the amount (and serves the source), the official route above it / when the float is off;
//   - the Relay leg: motion's 10 bps app fee and no more, native HYPE on 999 to W itself, Relay's pinned depository / programs, a
//     bound on what arrives against OUR prices — for every source (RH ETH / USDG, BNB BNB / USDC, SOL SOL / USDC);
//   - the HyperEVM leg: exactly W's own Inbox.depositEth() (0x439370b1, chain 999, the pinned Inbox, value ≤ what arrived);
//   - arrival: Elysium's deposit-tx hash from the Inbox message number (a real deposit: msg 423768 → 0xcd60c2ae…);
//   - the runner: job before every signature, two signatures exactly, a resume re-broadcasts the SAME deposit bytes (never re-signs),
//     a refund stops it, a wallet with code on HyperEVM is never asked to deposit;
//   - the wiring: elysiumFund (the float path) byte-identical to release 6, nothing on the trade path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseTransaction, recoverTransactionAddress, keccak256, toFunctionSelector } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  ELY_ROUTE, ELY_ROUTE_SRC, pickRoute, elyRelayBody, elyRelayProblem, inboxDepositTx, inboxDepositProblem, relayArrival, depositAmount,
  elyDepositHash, inboxMessageNum, l1ToL2Alias, createElyRoute, elyAppFees,
} from '../src/elysiumRoute.ts';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/ely-route/${n}.json`, import.meta.url), 'utf8'));
const FRESH = '0x1cd8f32e97313bc9c7f1e7aa61c79d1e10669e70', SOL_USER = 'eQfvBJe854RnrokdKz2uGiSXrCXqGoakWh7nr9sgNpC';
const SRC = { 'rh-eth-500': ['robinhood', 'native'], 'rh-usdg-500': ['robinhood', 'stable'], 'bsc-bnb-20k': ['bsc', 'native'], 'bsc-usdc-500': ['bsc', 'stable'], 'sol-sol-500': ['sol', 'native'], 'sol-usdc-20k': ['sol', 'stable'] };
// OUR prices for a fixture: its input's USD value, HYPE's price (from Relay's own USD figures of that very quote)
const oursOf = (j) => ({ inUsd6: BigInt(Math.round(Number(j.details.currencyIn.amountUsd) * 1e6)), hypePrice6: BigInt(Math.round(Number(j.details.currencyOut.amountUsd) / Number(j.details.currencyOut.amountFormatted) * 1e6)) });
const bodyOf = (name, j) => { const [src, coin] = SRC[name]; return elyRelayBody({ src, coin, payer: src === 'sol' ? SOL_USER : FRESH, w: FRESH, amount: BigInt(j.details.currencyIn.amount) }); };
const H = (o = {}) => ({ on: true, chains: ['robinhood', 'bsc', 'sol', 'elysium', 'hyperevm'], maxFillUsd: 1000, minFillUsd: 0.5, elysium: { paused: false, assets: ['native'], maxFillUsd: 1100, sources: ['robinhood', 'bsc', 'sol', 'hyperevm'] }, ...o });

test('selection: float while it can fill, official above it, official when the float is off or paused; force is honoured', () => {
  assert.equal(pickRoute({ usd: 50, src: 'robinhood', coin: 'native', health: H() }).route, 'float');
  assert.equal(pickRoute({ usd: 1100, src: 'bsc', coin: 'stable', health: H() }).route, 'float');
  const big = pickRoute({ usd: 1100.01, src: 'bsc', coin: 'stable', health: H() });
  assert.equal(big.route, 'official'); assert.match(big.float.why, /above motion's float \(\$1,100/);
  assert.equal(pickRoute({ usd: 50, src: 'sol', coin: 'native', health: H({ on: false }) }).route, 'official');
  assert.equal(pickRoute({ usd: 50, src: 'sol', coin: 'native', health: H({ elysium: { paused: true, assets: ['native'] } }) }).route, 'official');
  assert.equal(pickRoute({ usd: 50, src: 'sol', coin: 'native', health: null }).route, 'official');
  assert.equal(pickRoute({ usd: 50, src: 'bsc', coin: 'native', health: H({ elysium: { paused: false, assets: ['native'], maxFillUsd: 1100, sources: ['robinhood'] } }) }).route, 'official');
  assert.equal(pickRoute({ usd: 50, src: 'robinhood', coin: 'native', health: H(), force: 'official' }).route, 'official');
  assert.equal(pickRoute({ usd: 5000, src: 'robinhood', coin: 'native', health: H(), force: 'float' }).route, null);
  assert.equal(pickRoute({ usd: 0.5, src: 'robinhood', coin: 'native', health: H({ on: false }) }).route, null);   // below both minimums
  assert.equal(pickRoute({ usd: 2_000_000, src: 'robinhood', coin: 'native', health: H() }).route, null);
  assert.equal(pickRoute({ usd: 900_000, src: 'robinhood', coin: 'native', health: H() }).route, 'official');      // no float cap on this route
});

test('Relay body: payer → W on HyperEVM 999, native HYPE, motion\'s 10 bps to 0x9646…5380 as the only app fee', () => {
  const b = elyRelayBody({ src: 'sol', coin: 'stable', payer: SOL_USER, w: FRESH, amount: 5_000_000n });
  assert.deepEqual(b, { user: SOL_USER, recipient: FRESH, originChainId: 792703809, destinationChainId: 999, originCurrency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', destinationCurrency: '0x0000000000000000000000000000000000000000', amount: '5000000', tradeType: 'EXACT_INPUT', appFees: [{ recipient: '0x9646BC34af009358873dC1B94e5B4C737E915380', fee: '10' }] });
  assert.deepEqual(elyAppFees(), [{ recipient: ELY_ROUTE.fee.recipient, fee: '10' }]);
  assert.equal(elyRelayBody({ src: 'robinhood', coin: 'stable', payer: FRESH, w: FRESH, amount: 1n }).originCurrency, ELY_ROUTE_SRC.robinhood.stable);
  assert.equal(elyRelayBody({ src: 'bsc', coin: 'native', payer: FRESH, w: FRESH, amount: 1n }).originChainId, 56);
  assert.throws(() => elyRelayBody({ src: 'robinhood', coin: 'native', payer: FRESH, w: 'nope', amount: 1n }), /no EVM address/);
  assert.throws(() => elyRelayBody({ src: 'robinhood', coin: 'native', payer: FRESH, w: FRESH, amount: 0n }), /Invalid amount/);
});

for (const name of Object.keys(SRC)) {
  test(`Relay leg, real quote ${name}: accepted; the fee, recipient, coin, chain and value checks bite`, () => {
    const j = fx(name), body = bodyOf(name, j), ours = oursOf(j);
    const b = elyRelayProblem(j, body, ours);
    assert.equal(b.problem, undefined);
    assert.equal(b.requestId, j.requestId);
    assert.equal(b.out, BigInt(j.details.currencyOut.amount));
    assert.equal(b.appFee, BigInt(body.amount) * 10n / 10_000n);                                   // exactly 10 bps, in the input coin
    assert.ok(b.minOut > 0n && b.minOut <= b.out);
    if (SRC[name][0] === 'sol') assert.ok(b.sol && b.sol.ixs.length >= 1); else assert.ok(b.evm && b.evm.deposit.to.toLowerCase() === '0x4cd00e387622c35bddb9b4c962c136462338bc31');
    const mut = (f) => { const c = structuredClone(j); f(c); return elyRelayProblem(c, body, ours); };
    assert.match(mut((c) => { c.fees.app.amount = String(BigInt(c.fees.app.amount) * 2n + 2n); }).problem, /more than motion's 0.1 % fee/);
    assert.match(mut((c) => { c.details.recipient = '0x' + '11'.repeat(20); }).problem, /another recipient/);
    assert.match(mut((c) => { c.details.currencyOut.currency.address = '0x' + '22'.repeat(20); }).problem, /another coin/);
    assert.match(mut((c) => { c.details.currencyOut.currency.chainId = 99901; }).problem, /other chains/);
    assert.match(mut((c) => { c.details.currencyIn.amount = '1'; }).problem, /another amount/);
    assert.match(mut((c) => { c.details.currencyOut.minimumAmount = String(BigInt(c.details.currencyOut.amount) + 1n); }).problem, /no sane minimum/);
    // what arrives must stand against OUR prices: a quote paying 5 % less than the input is worth is refused
    assert.match(elyRelayProblem(j, body, { ...ours, inUsd6: ours.inUsd6 * 105n / 100n }).problem, /far less HYPE/);
    assert.match(elyRelayProblem(j, body, { ...ours, hypePrice6: 0n }).problem, /no fresh price/);
    assert.match(mut((c) => { c.details.currencyOut.minimumAmount = String(BigInt(c.details.currencyOut.amount) * 94n / 100n); }).problem, /guaranteed minimum/);
    // the source steps: Relay's depository only
    if (SRC[name][0] !== 'sol') assert.match(mut((c) => { c.steps.at(-1).items[0].data.to = '0x' + '33'.repeat(20); }).problem, /depository/);
    else assert.match(mut((c) => { c.steps[0].items[0].data.instructions[0].programId = 'Evi1111111111111111111111111111111111111111'; }).problem, /program/);
  });
}

test('HyperEVM leg: exactly W\'s own Inbox.depositEth() on 999 — selector, Inbox, value bound, gas bounds', () => {
  assert.equal(toFunctionSelector('depositEth()'), ELY_ROUTE.depositEth);
  const tx = { ...inboxDepositTx(10n ** 18n), gas: 120_000n, gasPrice: 1_000_000_000n, chainId: 999 };
  assert.deepEqual({ to: tx.to, data: tx.data, value: tx.value }, { to: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff', data: '0x439370b1', value: 10n ** 18n });
  assert.equal(inboxDepositProblem(tx, 10n ** 18n), '');
  assert.equal(inboxDepositProblem({ ...tx, chainId: 99901 }, 10n ** 18n), 'not HyperEVM');
  assert.equal(inboxDepositProblem({ ...tx, to: '0x' + '44'.repeat(20) }, 10n ** 18n), 'not the Elysium Inbox');
  assert.equal(inboxDepositProblem({ ...tx, data: '0x439370b1' + '00'.repeat(32) }, 10n ** 18n), 'not a plain depositEth()');
  assert.equal(inboxDepositProblem({ ...tx, data: '0x679b6ded' }, 10n ** 18n), 'not a plain depositEth()');
  assert.equal(inboxDepositProblem(tx, 10n ** 18n - 1n), 'another amount');
  assert.equal(inboxDepositProblem({ ...tx, gas: 150_001n }, 10n ** 18n), 'abnormal gas');
  assert.equal(inboxDepositProblem({ ...tx, gasPrice: 50_000_000_001n }, 10n ** 18n), 'abnormal gas price');
  assert.throws(() => inboxDepositTx(0n), /nothing to deposit/);
});

test('arrival: Relay\'s HYPE at W (balance rise ≥ minimum, or Relay success), refund stops; the deposit takes only what arrived, less gas', () => {
  assert.equal(relayArrival({ before: 5n, now: 105n, minOut: 100n, status: 'pending' }), 'arrived');
  assert.equal(relayArrival({ before: 5n, now: 104n, minOut: 100n, status: 'pending' }), 'waiting');
  assert.equal(relayArrival({ before: 5n, now: 50n, minOut: 100n, status: 'success' }), 'arrived');
  assert.equal(relayArrival({ before: 5n, now: 5n, minOut: 100n, status: 'success' }), 'waiting');
  assert.equal(relayArrival({ before: 5n, now: 500n, minOut: 100n, status: 'refund' }), 'refunded');
  assert.equal(relayArrival({ before: 0n, now: 0n, minOut: 1n, status: 'failure' }), 'refunded');
  // W held 1 HYPE before; 10 arrived; quote paid 10: deposit 10 − gas (W's own 1 HYPE is never swept)
  assert.equal(depositAmount({ before: 10n ** 18n, now: 11n * 10n ** 18n, out: 10n ** 19n, gasCost: 10n ** 14n }), 10n ** 19n - 10n ** 14n);
  // more arrived than the quote (another inflow): capped at the quote
  assert.equal(depositAmount({ before: 0n, now: 20n * 10n ** 18n, out: 10n ** 19n, gasCost: 10n ** 14n }), 10n ** 19n - 10n ** 14n);
  // W had nothing: the gas comes out of what arrived
  assert.equal(depositAmount({ before: 0n, now: 10n ** 18n, out: 10n ** 18n, gasCost: 10n ** 14n }), 10n ** 18n - 2n * 10n ** 14n);
  assert.equal(depositAmount({ before: 0n, now: 10n ** 13n, out: 10n ** 18n, gasCost: 10n ** 14n }), 0n);
});

test('Elysium arrival hash = keccak256(0x64 ‖ rlp([99901, msgNum, alias(W), W, value])) — a real deposit (msg 423768)', () => {
  assert.equal(l1ToL2Alias('0x0894ed6c7cb37565464becf358e475231e86fa57'), '0x19a5ed6c7cb37565464becf358e475231e870b68');
  assert.equal(elyDepositHash(423768n, '0x0894ed6c7cb37565464becf358e475231e86fa57', 230000000000000000n), '0xcd60c2aec10f098b10a1427255578aa9733d05889e1f3d27a374bdeeac97df9c');
  const topic1 = '0x' + (423768n).toString(16).padStart(64, '0');
  assert.equal(inboxMessageNum([{ address: '0x503d572157113faaad4dbed2647bb10b949216b6', topics: ['0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1', topic1] }, { address: '0xCE59F8B65AD41C9DAE4C07A0571A39824BD92CFF', topics: [ELY_ROUTE.inboxMessageDelivered, topic1] }]), 423768n);
  assert.equal(inboxMessageNum([{ address: '0x' + '55'.repeat(20), topics: [ELY_ROUTE.inboxMessageDelivered, topic1] }]), null);
});

// ── the runner against mocks: one Robinhood wallet, Relay's real rh-eth-500 quote ──
function world(o = {}) {
  const key = generatePrivateKey(), acct = privateKeyToAccount(key), W = acct.address;
  const j = structuredClone(fx('rh-eth-500')); j.details.sender = W; j.details.recipient = W;
  j.steps[0].items[0].data.data = '0x49290c1c' + W.slice(2).toLowerCase().padStart(64, '0') + j.steps[0].items[0].data.data.slice(10 + 64);
  const amount = BigInt(j.details.currencyIn.amount), out = BigInt(j.details.currencyOut.amount);
  const s = { t: 0, store: new Map(), hyper: 3n * 10n ** 16n, ely: 0n, code: '0x', relayStatus: 'pending', relayed: [], signed: [], sent: [], asks: [], gates: 0, events: [], elyTxs: new Set(), receipt: null, arriveAfter: 2, polls: 0, ...o };
  const ours = oursOf(j);
  const deps = {
    now: () => s.t, wait: async (ms) => { s.t += ms; s.polls += 1; if (s.polls === s.arriveAfter && s.relayStatus !== 'refund') { s.hyper += out; s.relayStatus = 'success'; } },
    store: { get: (k) => s.store.get(k) ?? null, set: (k, v) => s.store.set(k, v) },
    lock: (_k, fn) => fn(), src: () => 'robinhood',
    wallet: (id) => ({ id, name: 'Main', w: W, payer: W, signHyper: async (tx) => { const raw = await acct.signTransaction(tx); s.signed.push(raw); return raw; } }),
    reads: {
      srcBalance: async () => 10n ** 18n, inUsd6: async () => ours.inUsd6, hypePrice6: async () => ours.hypePrice6,
      hyperBalance: async () => s.hyper, hyperCode: async () => s.code, hyperNonce: async () => 7, hyperGasPrice: async () => 200_000_000n,
      hyperEstimate: async () => 92_957n,
      hyperReceipt: async (h) => (s.sent.length && s.receiptOk !== false ? { status: 'success', logs: [{ address: ELY_ROUTE.inbox, topics: [ELY_ROUTE.inboxMessageDelivered, '0x' + (427587n).toString(16).padStart(64, '0')] }] } : null),
      elyBalance: async () => s.ely, elyTx: async (h) => (s.elyTxs.has(h) ? { blockNumber: 1n } : null),
    },
    relay: { quote: async (body) => { s.relayBody = body; return j; }, status: async () => s.relayStatus },
    sendRelay: async (id, body, b) => { s.relayed.push({ id, body, b }); return '0x' + 'ab'.repeat(32); },
    sendHyper: async (raw) => { s.sent.push(raw); const tx = parseTransaction(raw); s.elyTxs.add(elyDepositHash(427587n, W, tx.value)); },
    gate: async () => { s.gates += 1; }, ask: async (d) => { s.asks.push(d); return s.answer ?? true; },
    esc: (v) => String(v), destBox: (a) => `[${a}]`, back: 'about 6 days back', risk: 'multisig risk', fmtIn: (_c, a) => `${a} wei ETH`,
    emit: (d) => s.events.push(d),
  };
  return { s, deps, W, j, amount, out, r: createElyRoute(deps) };
}

test('runner quote: Relay\'s checked quote, nothing signed, no dialog; the page fields', async () => {
  const { s, r, amount, W } = world();
  const q = await r.quote({ walletId: 'w1', coin: 'native', amount });
  assert.equal(s.asks.length + s.signed.length + s.relayed.length, 0);
  assert.equal(s.relayBody.recipient, W); assert.equal(s.relayBody.destinationChainId, 999); assert.deepEqual(s.relayBody.appFees, elyAppFees());
  assert.equal(q.view.route, 'official'); assert.deepEqual(q.view.steps, ['relay', 'hyperevm', 'inbox', 'elysium']);
  assert.ok(q.view.etaMs >= 38_000 && q.view.etaMs < 120_000);
  assert.equal(q.view.fees.motion.bps, 10); assert.ok(q.view.fees.motion.usd > 0.49 && q.view.fees.motion.usd < 0.51);
  assert.match(q.view.feeText, /^motion 0\.1 % \(\$0\.50\) \+ Relay \$1\.\d\d$/);
});

test('runner go: one Relay deposit, then W\'s own depositEth (exact bytes, signer W), then Elysium — job before each signature', async () => {
  const { s, r, amount, W, out } = world();
  const v = await r.go({ walletId: 'w1', coin: 'native', amount });
  assert.equal(v.state, 'done'); assert.equal(s.gates, 1); assert.equal(s.asks.length, 1);
  assert.match(s.asks[0].html, /Two signatures/); assert.match(s.asks[0].html, /motion 0\.1 %/); assert.match(s.asks[0].html, /about 6 days back/);
  assert.equal(s.relayed.length, 1); assert.equal(s.signed.length, 1);
  const tx = parseTransaction(s.signed[0]);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: s.signed[0] }), W);
  assert.equal(tx.chainId, 999); assert.equal(tx.to, ELY_ROUTE.inbox); assert.equal(tx.data, '0x439370b1'); assert.equal(tx.nonce, 7);
  assert.equal(tx.gas, 120_844n);                                                         // 92 957 × 1.3
  assert.equal(tx.value, out - 150_000n * 250_000_000n);                                   // what arrived, less the deposit's gas (W's prior 0.03 HYPE untouched)
  const states = s.events.map((e) => e.state);
  assert.deepEqual(states, ['planned', 'relay', 'hyper', 'hyper', 'inbox', 'done']);      // planned before the Relay signature; the deposit's bytes saved before broadcast
  const job = JSON.parse(s.store.get('trenches.elyRoute.jobs'))[v.jobId];
  assert.equal(job.depositHash, keccak256(s.signed[0])); assert.equal(job.elyHash, elyDepositHash(427587n, W, tx.value));
});

test('resume re-broadcasts the SAME deposit bytes and never signs again', async () => {
  const { s, r, amount } = world();
  // the first run's receipt never shows up: the job is left at 'hyper' with its signed bytes
  s.receiptOk = false;
  const v = await r.go({ walletId: 'w1', coin: 'native', amount });
  assert.equal(v.state, 'hyper'); assert.equal(v.waiting, true); assert.equal(s.signed.length, 1);
  s.receiptOk = true; const before = s.sent.length;
  const v2 = await r.resume(v.jobId);
  assert.equal(v2.state, 'done'); assert.equal(s.signed.length, 1);
  assert.ok(s.sent.length > before && s.sent.every((x) => x === s.signed[0]));
});

test('a resume of a job whose HYPE arrived but was never deposited asks first, then signs once', async () => {
  // stop right after arrival: the HyperEVM code read fails at the deposit step (the quote's read is the first)
  let n = 0;
  const w2 = world(); w2.deps.reads.hyperCode = async () => (++n === 2 ? null : '0x');
  const r2 = createElyRoute(w2.deps);
  await assert.rejects(r2.go({ walletId: 'w1', coin: 'native', amount: w2.amount }), /HyperEVM could not be read/);
  assert.equal(w2.s.signed.length, 0);
  const id = Object.keys(JSON.parse(w2.s.store.get('trenches.elyRoute.jobs')))[0];
  const v = await r2.resume(id);
  assert.equal(v.state, 'done'); assert.equal(w2.s.signed.length, 1); assert.equal(w2.s.asks.length, 2);
  assert.match(w2.s.asks[1].title, /Finish moving to Elysium/);
});

test('a refund on Relay stops the job: no deposit is signed', async () => {
  const { s, r, amount } = world({ relayStatus: 'refund' });
  const v = await r.go({ walletId: 'w1', coin: 'native', amount });
  assert.equal(v.state, 'refunded'); assert.equal(v.ok, false); assert.equal(s.signed.length, 0); assert.equal(s.relayed.length, 1);
});

test('nothing moves for a wallet with code on HyperEVM (7702 / contract: Nitro would credit its alias), a declined dialog, too little balance', async () => {
  const a = world({ code: '0xef0100' + '66'.repeat(20) });
  await assert.rejects(a.r.go({ walletId: 'w1', coin: 'native', amount: a.amount }), /code on HyperEVM/);
  assert.equal(a.s.relayed.length + a.s.signed.length + a.s.asks.length, 0);
  const b = world({ answer: false });
  await assert.rejects(b.r.go({ walletId: 'w1', coin: 'native', amount: b.amount }), /Cancelled/);
  assert.equal(b.s.relayed.length + b.s.signed.length, 0);
  const c = world(); c.deps.reads.srcBalance = async () => c.amount - 1n;
  await assert.rejects(c.r.go({ walletId: 'w1', coin: 'native', amount: c.amount }), /More than this wallet holds/);
  assert.equal(c.s.relayed.length, 0);
  // code appears between the Relay leg and the deposit: the deposit is refused, the HYPE stays at W on HyperEVM
  const d = world(); let k = 0; d.deps.reads.hyperCode = async () => (++k >= 2 ? '0xef0100' + '77'.repeat(20) : '0x');
  await assert.rejects(d.r.go({ walletId: 'w1', coin: 'native', amount: d.amount }), /stays at your HyperEVM address/);
  assert.equal(d.s.relayed.length, 1); assert.equal(d.s.signed.length, 0);
  // HyperEVM gas far above normal: nothing signed, resumable
  const e = world(); e.deps.reads.hyperGasPrice = async () => 45_000_000_000n;
  await assert.rejects(e.r.go({ walletId: 'w1', coin: 'native', amount: e.amount }), /gas is far above normal/);
  assert.equal(e.s.signed.length, 0);
});

test('wiring: elysiumFund (the float path) is byte-identical to release 6; the new facade calls only the new module; trade core untouched', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  let base = '';
  try { base = execFileSync('git', ['show', 'c12d6f4:src/webEngine.ts'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r/g, ''); } catch { /* not a git checkout */ }
  const chunk = (s, from, to) => { const i = s.indexOf(from); const j = s.indexOf(to, i); assert.ok(i > 0 && j > i, from); return s.slice(i, j); };
  if (base) {
    assert.equal(chunk(src, '  elysiumFund: async (o:', '  elysiumExit: async'), chunk(base, '  elysiumFund: async (o:', '  elysiumExit: async'));
    assert.equal(chunk(src, 'function elysiumFundFromHyperEvm(', 'const ELYSIUM_DOCS'), chunk(base, 'function elysiumFundFromHyperEvm(', 'const ELYSIUM_DOCS'));
  }
  assert.match(src, /elysiumRoute: \(o: \{ walletId: string; pay: 'native' \| 'stable'; amount: number; route\?: 'auto' \| 'float' \| 'official'; phase\?: 'quote' \}, auth\?: Auth\) => elysiumRoute\(o, auth\)/);
  assert.match(src, /elysiumRouteStatus: async \(jobId: string\) => elyRoute\.status/);
  assert.match(src, /elysiumRouteResume: \(jobId: string\) => elyRoute\.resume/);
  // the trade path never reaches the route (the pinned region verifyCache…REASONS names none of it)
  const region = chunk(src, 'const verifyCache = new Map', 'const REASONS: Record');
  assert.doesNotMatch(region, /\belyRoute\b|\belysiumRoute\b|\bELY_ROUTE\b|ELY_ROUTE_SRC|pickElyRoute|createElyRoute/);
  // the official route's HyperEVM reads / broadcast use the official node only (the same client as the release-6 HyperEVM leg)
  const block = chunk(src, 'const elyRoute = createElyRoute({', '// engine.elysiumRoute {');
  assert.doesNotMatch(block, /https?:\/\//);
  assert.match(block, /sendRawTransaction/); assert.match(block, /elysiumOraclePc\(\)\.sendRawTransaction/);
  assert.match(block, /relayQuote\(body\)\)\.j/);                     // keyless, never viaMotion
});
