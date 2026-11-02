// A waiting click paid from the trading wallet's OWN native on another chain (src/nativeDonor.ts, floatEngine nativeDonorRun;
// 2026-10-30, a user: "I have eth on rh and can't do anything on solana still"). The float engine end to end in a Solana
// frame (and a BNB one) on fake chains: W's ETH on Robinhood / BNB on BNB Chain read and spent through deps.nativeDonor, Relay
// answering in the shape it answered on 2026-10-30 (test/fixtures/relay-quote-native-exact-out.json, read-only), its fill
// landing SOL in W after a delay. Throwaway keys only; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';
import * as N from '../src/nativeDonor.ts';
import { setRelayProxyBase, RELAY_DEPOSITORY } from '../src/relayApi.ts';
const PROXY = 'https://motion.test';
setRelayProxyBase(() => PROXY);

const lc = (a) => String(a).toLowerCase();
const word = (h) => lc(h).replace(/^0x/, '').padStart(64, '0');
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const FIX = JSON.parse(readFileSync(new URL('./fixtures/relay-quote-native-exact-out.json', import.meta.url), 'utf8'));
const ETH = 10n ** 18n;
const PRICE = { robinhood: 4000, bsc: 600, sol: 100 };
const CHAIN_ID = { 4663: 'robinhood', 56: 'bsc', 792703809: 'sol' };

function world(o = {}) {
  const W_KEY = generatePrivateKey();
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(F.reserveKeyOf(W_KEY)).address;
  const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
  const lane = o.lane || 'sol';
  // W's native on each chain (raw), the reserves' stables, the oracle prices; a Relay fill adds to the destination W
  const st = {
    w: { robinhood: o.rhEth ?? 50_000_000_000_000_000n /* 0.05 ETH = $200 */, bsc: o.bscBnb ?? 0n, sol: o.solW ?? 0n },
    rUsdc: o.rUsdc ?? 0n, gasPrice: { robinhood: 10_000_000n, bsc: 1_000_000_000n },
  };
  const t = o.t || {};   // simulated latencies (ms): the e2e measurement only; 0 elsewhere
  const log = { reads: [], sends: [], quotes: [], fetch: [] };
  const quotes = new Map(); const filled = new Set(); const fills = [];
  let n = 0;
  const quoteFor = (b) => {
    const tamper = (typeof o.tamper === 'function' ? o.tamper(b) : o.tamper) || '';
    const from = CHAIN_ID[b.originChainId], to = CHAIN_ID[b.destinationChainId];
    const out = BigInt(b.amount);
    const outUsd = Number(out) / (to === 'sol' ? 1e9 : 1e18) * PRICE[to];
    const feeUsd = tamper === 'fee' ? 5 : 0.047;
    const cost = (o.costPct?.[from] ?? 0.4) / 100;
    let amountIn = BigInt(Math.ceil((outUsd * (1 + cost) + feeUsd) / PRICE[from] * 1e18));
    if (tamper === 'expensive') amountIn = amountIn * 110n / 100n;
    const requestId = '0x' + (++n).toString(16).padStart(64, 'a');
    const id32 = keccak256(toHex(requestId)).slice(2);
    const user = tamper === 'depositor' ? '0x' + '66'.repeat(20) : b.user;
    let data = '0x49290c1c' + word(user) + id32;
    if (tamper === 'extra-word') data += '00'.repeat(32);
    if (tamper === 'erc20-deposit') data = '0xe8017952' + word(b.user) + word('0x' + '55'.repeat(20)) + word(amountIn.toString(16)) + id32;
    const steps = [{ id: 'deposit', kind: 'transaction', requestId, items: [{ status: 'incomplete', data: { from: b.user, to: tamper === 'depository' ? '0x' + '78'.repeat(20) : RELAY_DEPOSITORY, data, value: String(tamper === 'value' ? amountIn + 1n : amountIn), chainId: tamper === 'step-chain' ? 1 : b.originChainId, gas: '32969' }, check: { endpoint: '/intents/status?requestId=' + requestId, method: 'GET' } }] }];
    if (tamper === 'two-steps') steps.unshift({ id: 'approve', kind: 'transaction', items: [{ data: { to: '0x' + '55'.repeat(20), data: '0x095ea7b3' + word(RELAY_DEPOSITORY) + word('ff'), value: '0', chainId: b.originChainId } }] });
    const j = structuredClone(FIX.quote);
    j.requestId = requestId; j.steps = steps;
    j.details.sender = tamper === 'sender' ? '0x' + '44'.repeat(20) : b.user;
    j.details.recipient = tamper === 'recipient' ? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' : b.recipient;
    j.details.currencyIn = { ...j.details.currencyIn, amount: String(amountIn), currency: { ...j.details.currencyIn.currency, chainId: b.originChainId, address: tamper === 'currency-in' ? '0x' + '55'.repeat(20) : b.originCurrency } };
    const landed = tamper === 'less-out' ? out - 1n : out;
    j.details.currencyOut = { ...j.details.currencyOut, amount: String(landed), minimumAmount: String(tamper === 'min-less' ? out * 99n / 100n : landed), currency: { ...j.details.currencyOut.currency, chainId: tamper === 'chain-out' ? 8453 : b.destinationChainId, address: tamper === 'currency-out' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : b.destinationCurrency } };
    j.details.timeEstimate = o.eta?.[from] ?? 1;
    j.fees = { ...j.fees, relayer: { ...j.fees.relayer, amountUsd: String(feeUsd - 0.002) }, gas: { ...j.fees.gas, amountUsd: '0.002' }, app: { ...j.fees.app, amountUsd: '0' } };
    quotes.set(lc(data), { requestId, out: landed, to });
    return j;
  };
  const fetchFn = async (url, init) => {
    log.fetch.push(String(url));
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url === 'https://api.relay.link/quote/v2') {
      await sleep(t.quote || 0);
      const b = JSON.parse(init.body); log.quotes.push(b);
      if (o.relayDown) return { ok: false, status: 503, json: async () => ({ message: 'down' }) };
      if (o.relayKeyed) return { ok: false, status: 401, json: async () => ({ errorCode: 'UNAUTHORIZED_QUOTE', message: 'An API key is required' }) };
      return ok(quoteFor(b));
    }
    // motion's keyed pass-through: the live server forwards EXACT_INPUT only (pulse-indexer /api/bridge/vault-quote); with
    // B:/tmp/native-donor/server-vault-quote-exact-output.patch it forwards EXACT_OUTPUT too (o.proxyExactOut)
    if (url === PROXY + '/api/bridge/vault-quote' && JSON.parse(init.body).tradeType !== 'EXACT_INPUT' && !o.proxyExactOut) return { ok: false, status: 400, json: async () => ({ ok: false, error: 'bad quote request' }) };
    if (url === PROXY + '/api/bridge/vault-quote') { const b = JSON.parse(init.body); log.quotes.push(b); return ok(quoteFor(b)); }
    if (url === 'https://api.relay.link/price') {
      // Relay's own keyless price for the same input (EXACT_INPUT): what lands for it at the world's prices
      const b = JSON.parse(init.body); const from = CHAIN_ID[b.originChainId], to = CHAIN_ID[b.destinationChainId];
      const usd = Number(BigInt(b.amount)) / 1e18 * PRICE[from] * 0.996 - 0.047;
      const out = BigInt(Math.floor(usd / PRICE[to] * (to === 'sol' ? 1e9 : 1e18) * (o.proxyCheap ? 1.1 : 1)));
      return ok({ details: { currencyOut: { amount: String(out) } } });
    }
    if (url.startsWith('https://api.relay.link/intents/status/')) { const id = new URL(url).searchParams.get('requestId'); return ok({ status: filled.has(id) ? 'success' : o.relayStatus || 'pending' }); }
    throw new Error('test: unexpected fetch ' + url);
  };
  const store = new Map(); const events = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const evmBal = (c) => async (a) => { await sleep(t.read || 0); return lc(a) === lc(W) ? st.w[c] : 0n; };
  const deps = {
    chain: () => lane,
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W, sol: sol.W }, r: { evm: R, sol: sol.R } }; },
    // this frame's own chain when it is an EVM one (the BNB frame test): W and R there, no reserve
    evm: lane === 'sol' ? undefined : {
      call: async () => '0x', balance: evmBal(lane), erc20: async () => 0n, allowance: async () => 0n,
      // the oracle pools: Robinhood WETH/USDG (native = token0, 6-decimal stable), BNB USDT/WBNB (native = token1, 18 decimals)
      slot0: async () => (lane === 'bsc' ? BigInt(Math.floor(Math.sqrt(1 / PRICE.bsc) * 2 ** 96)) : sqrtFor(PRICE[lane])), fees: async () => ({ baseFee: st.gasPrice[lane], gasPrice: st.gasPrice[lane], l1PerByte: 0n }),
      estimate: async () => 100_000n, sendR: async () => { throw new Error('test: no R send'); }, sendW: async () => { throw new Error('test: no W send'); }, receipt: async () => null,
    },
    sol: {
      balance: async (a) => { await sleep(t.solRead || 0); return a === sol.W ? st.w.sol : 0n; },
      usdc: async (owner) => (owner === sol.R ? st.rUsdc : 0n), oracle6: async () => BigInt(PRICE.sol) * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      topup: async (id, usdcIn, minLamports) => { log.sends.push({ chain: 'sol', kind: 'topup', usdcIn }); st.rUsdc -= usdcIn; st.w.sol += minLamports; return 'sigt' + log.sends.length; },
      sweep: async () => 'sigs', gas: async () => 'sigg', status: async () => 'confirmed',
    },
    ...(o.noDonorDep ? {} : { nativeDonor: {
      read: async (chain, owner) => {
        await sleep(t.read || 0); log.reads.push(chain);
        assert.equal(lc(owner), lc(W), 'only W is read');
        if (o.readFails?.includes(chain)) throw new Error('node down');
        return { native: st.w[chain], price6: BigInt(PRICE[chain]) * F.USD, gasPrice: st.gasPrice[chain] };
      },
      send: async (walletId, chain, tx, gas) => {
        await sleep(t.send || 0);
        // what the vault frame (webEngine nativeDonorSend) refuses before W signs
        const bad = N.nativeDonorTxProblem(tx, W, gas); if (bad) throw new Error('Refusing to sign: ' + bad);
        log.sends.push({ chain, kind: 'deposit', tx, gas, at: Date.now() });
        const hash = keccak256(toHex(`${chain}:${log.sends.length}`));
        if (o.sendThrows && (!o.sendThrowsOn || o.sendThrowsOn === chain)) throw Object.assign(o.sendThrows, o.sendThrows.unknown ? { hash } : {});
        if (st.w[chain] < tx.value + gas * st.gasPrice[chain]) throw new Error('insufficient funds');
        st.w[chain] -= tx.value + gas * st.gasPrice[chain];
        const q = quotes.get(lc(tx.data));
        if (q && !o.neverFills) setTimeout(() => { st.w[q.to] += q.out; filled.add(q.requestId); fills.push(Date.now()); }, t.fill || 0);
        return hash;
      },
      receipt: async () => o.receipt ?? 'success',
    } }),
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: (d) => events.push(d), fetch: fetchFn, click: () => click, wait: async (ms) => sleep(Math.min(ms, 5)),
  };
  const f = createFloat(deps);
  return { f, st, W, R, W_KEY, sol, log, store, events, deps, click, fills, quotes };
}
async function on(wd, chains = ['robinhood', 'bsc', 'sol']) {
  const r = await wd.f.configure({ walletId: 'w1', chains });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k);
}
const clickBuy = (wd, usd, chain = 'sol') => wd.f.ensure({ walletId: 'w1', chain, usd, reason: 'click' });
const jobsOf = async (wd) => (await wd.f.jobs({ walletId: 'w1' })).jobs;
const js = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
// W trades on Robinhood (a $20 preset, active now): that chain keeps its ready float of 1.5 buys = $30
const activeOn = (wd, chain, presetUsd) => wd.store.set(`trenches.float.v1.prefs.${chain}.${lc(wd.W)}`, JSON.stringify({ presets6: [String(F.usd6(presetUsd))], buys6: [], buysAt: [], activeAt: Date.now() }));

// ── pure rules ──
test('need: W up to its gas floor + the click\'s need + 25 %, net of what is there or on its way; the $100 cap trims the margin, refuses beyond', () => {
  const P = 100n * F.USD;
  const a = N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 0n });
  assert.equal(a.out, F.SOL_CLICK_FLOOR + 125_000_000n);   // the click's 0.009 SOL floor + $12.50 at $100
  assert.equal(a.trimmed, false);
  // W already holds its floor + $5: only the rest
  const b = N.nativeDonorNeed({ chain: 'sol', float: F.SOL_CLICK_FLOOR + 50_000_000n, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 0n });
  assert.equal(b.out, 75_000_000n);
  // a reserve top-up of $12.50 this click already started: nothing
  assert.equal(N.nativeDonorNeed({ chain: 'sol', float: F.SOL_CLICK_FLOOR, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 12_500_000n }), null);
  // $90: $112.50 with the margin → trimmed to $100 (still covers $90), the floor on top
  const c = N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: 0n, need6: 90n * F.USD, started6: 0n });
  assert.equal(c.trimmed, true); assert.equal(c.out, F.SOL_CLICK_FLOOR + 1_000_000_000n);
  // $150: refused
  assert.match(N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: 0n, need6: 150n * F.USD, started6: 0n }).refuse, /\$100\.00/);
});

test('spare: W keeps its gas floor, its kept trading float and the deposit\'s gas; the most it sends is what lands + fee cap + slippage', () => {
  const P = 4000n * F.USD;
  const s = N.nativeDonorSpare({ chain: 'robinhood', float: 10n ** 16n, price6: P, keep6: 15n * F.USD, gasCost: 1_500_000_000_000n });
  assert.equal(s, 10n ** 16n - F.FLOAT_CFG.robinhood.gasFloor - (15n * F.USD * ETH / P + 1n) - 1_500_000_000_000n);
  assert.equal(N.nativeDonorSpare({ chain: 'robinhood', float: F.FLOAT_CFG.robinhood.gasFloor, price6: P, keep6: 0n, gasCost: 1n }), 0n);
  const m = N.nativeDonorMaxIn({ from: 'robinhood', out6: 14_500_000n, price6: P, spare: 10n ** 18n, maxSlipBps: 50 });
  assert.equal(m, (14_500_000n + 250_000n) * 10_100n / 10_000n * ETH / P);   // ($14.50 + the $0.25 fee floor) × 1.01 at $4,000
  assert.equal(N.nativeDonorMaxIn({ from: 'robinhood', out6: 14_500_000n, price6: P, spare: 7n, maxSlipBps: 50 }), 7n);
});

test('the recorded Relay quote (2026-10-30, Robinhood ETH → SOL, EXACT_OUTPUT) passes every check; each tampered field is refused', () => {
  const b = FIX.body; const j = FIX.quote; const out = BigInt(b.amount);
  const want = { from: 'robinhood', to: 'sol', user: b.user, recipient: b.recipient, out, maxIn: 10n ** 18n };
  const q = N.nativeDonorQuoteProblem(j, want);
  assert.ok(!('problem' in q), js(q));
  assert.equal(q.out, out); assert.equal(q.amountIn, BigInt(j.details.currencyIn.amount)); assert.equal(lc(q.deposit.to), RELAY_DEPOSITORY);
  assert.ok(q.fees6 > 0n && q.fees6 < 100_000n, String(q.fees6));
  const bad = (mut, re) => { const x = structuredClone(j); mut(x); const r = N.nativeDonorQuoteProblem(x, want); assert.ok('problem' in r, 'accepted: ' + re); assert.match(r.problem, re); };
  bad((x) => { x.details.recipient = 'So1W' + '1'.repeat(40); }, /pays someone else/);
  bad((x) => { x.details.recipient = b.recipient.toLowerCase(); }, /pays someone else/);   // Solana addresses are case-sensitive
  bad((x) => { x.details.sender = '0x' + '44'.repeat(20); }, /another sender/);
  bad((x) => { x.details.currencyOut.currency.address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; }, /another coin/);
  bad((x) => { x.details.currencyIn.currency.address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; }, /spends another coin/);
  bad((x) => { x.details.currencyOut.currency.chainId = 8453; }, /other chains/);
  bad((x) => { x.details.currencyIn.currency.chainId = 56; }, /other chains/);
  bad((x) => { x.details.currencyOut.amount = String(out - 1n); }, /lands less/);
  bad((x) => { x.details.currencyOut.minimumAmount = String(out - 1n); }, /lands less/);
  bad((x) => { delete x.details.currencyOut.minimumAmount; }, /no amount out/);
  bad((x) => { x.steps[0].items[0].data.to = '0x' + '78'.repeat(20); }, /depository/);
  bad((x) => { x.steps[0].items[0].data.value = String(BigInt(x.details.currencyIn.amount) + 1n); }, /value is not the amount/);
  bad((x) => { x.steps[0].items[0].data.data = x.steps[0].items[0].data.data.slice(0, 10) + '66'.repeat(32) + x.steps[0].items[0].data.data.slice(74); }, /name this wallet/);
  bad((x) => { x.steps[0].items[0].data.data += '00'.repeat(32); }, /two words/);
  bad((x) => { x.steps[0].items[0].data.chainId = 1; }, /another chain/);
  bad((x) => { x.steps.unshift({ id: 'approve', kind: 'transaction', items: [{ data: {} }] }); }, /unexpected steps/);
  bad((x) => { x.steps[0].requestId = '0x' + 'ab'.repeat(32); }, /another request/);
  bad((x) => { x.requestId = 'nope'; }, /request id/);
  const tight = N.nativeDonorQuoteProblem(j, { ...want, maxIn: BigInt(j.details.currencyIn.amount) - 1n });
  assert.match(tight.problem, /more than the wallet can spare/);
  assert.match(N.nativeDonorQuoteProblem(j, { ...want, from: 'sol', to: 'robinhood' }).problem, /EVM chain only/);
});

test('the price check across the two oracles: the recorded quote at the day\'s prices passes; a 10 % worse one or a $5 fee is refused', () => {
  const j = FIX.quote; const amountIn = BigInt(j.details.currencyIn.amount), out = BigInt(j.details.currencyOut.amount);
  // the day's prices, as Relay's own USD figures state them (in $12.67 for 0.005650 ETH, out $12.60 for 0.13 SOL)
  const inPrice6 = F.usd6(Number(j.details.currencyIn.amountUsd) / (Number(amountIn) / 1e18)), outPrice6 = F.usd6(Number(j.details.currencyOut.amountUsd) / (Number(out) / 1e9));
  const fees6 = F.usd6(Number(j.fees.relayer.amountUsd) + Number(j.fees.gas.amountUsd));
  assert.equal(N.nativeDonorPriceProblem({ from: 'robinhood', to: 'sol', amountIn, inPrice6, out, outPrice6, fees6, maxSlipBps: 50 }), null);
  assert.match(N.nativeDonorPriceProblem({ from: 'robinhood', to: 'sol', amountIn: amountIn * 110n / 100n, inPrice6, out, outPrice6, fees6, maxSlipBps: 50 }), /below the two chains/);
  assert.match(N.nativeDonorPriceProblem({ from: 'robinhood', to: 'sol', amountIn, inPrice6, out, outPrice6, fees6: 5n * F.USD, maxSlipBps: 50 }), /fee is too high/);
  assert.match(N.nativeDonorPriceProblem({ from: 'robinhood', to: 'sol', amountIn, inPrice6: 0n, out, outPrice6, fees6, maxSlipBps: 50 }), /no oracle/);
  // the bound: 2 × maxSlip over the two oracles (measured 76–90 bps on 2026-10-30, fee included): 0.9 % passes, 1.2 % does not
  const at = (pct) => N.nativeDonorPriceProblem({ from: 'robinhood', to: 'sol', amountIn: BigInt(Math.round(Number(14_500_000_000_000_000_000n / 4000n) * (1 + pct / 100))), inPrice6: 4000n * F.USD, out: 145_000_000n, outPrice6: 100n * F.USD, fees6: 0n, maxSlipBps: 50 });
  assert.equal(at(0.9), null); assert.match(at(1.2), /below the two chains/);
});

test('the vault frame signs only a Relay depositNative from this wallet (webEngine nativeDonorSend uses the same guard)', () => {
  const me = '0x' + '12'.repeat(20);
  const good = { to: RELAY_DEPOSITORY, data: '0x49290c1c' + word(me) + 'ab'.repeat(32), value: 5n };
  assert.equal(N.nativeDonorTxProblem(good, me, 50_000n), null);
  assert.match(N.nativeDonorTxProblem({ ...good, to: '0x' + '77'.repeat(20) }, me, 50_000n), /depository/);
  assert.match(N.nativeDonorTxProblem({ ...good, data: good.data.replace(word(me), word('0x' + '34'.repeat(20))) }, me, 50_000n), /another wallet/);
  assert.match(N.nativeDonorTxProblem({ ...good, data: '0xa9059cbb' + good.data.slice(10) }, me, 50_000n), /native deposit/);
  assert.match(N.nativeDonorTxProblem({ ...good, data: good.data + '00' }, me, 50_000n), /native deposit/);
  assert.match(N.nativeDonorTxProblem({ ...good, value: 0n }, me, 50_000n), /no value/);
  assert.match(N.nativeDonorTxProblem(good, me, N.NATIVE_DONOR.gasMax + 1n), /abnormal gas/);
  const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const send = WE.slice(WE.indexOf('async function nativeDonorSend('), WE.indexOf('async function nativeDonorReceipt('));
  assert.ok(/nativeDonorTxProblem\(tx, account\.address, gas\)/.test(send) && send.indexOf('nativeDonorTxProblem') < send.indexOf('signTransaction'), 'the guard runs before the signature');
  assert.ok(/floatAccount\(walletId\)/.test(send) && /chainId: oc\.id/.test(send), 'W\'s own key, the donor chain\'s own id');
  assert.ok(/nativeDonor: \{ read: nativeDonorRead/.test(WE), 'wired into the float');
});

// ── the engine end to end ──
test('Solana click, no SOL and no reserve, ETH in W on Robinhood: ONE Relay deposit by W there, exactly what the click needs lands in W on Solana, the job is followed to arrival', async () => {
  const wd = world(); await on(wd);
  const r = await clickBuy(wd, 10);
  assert.equal(r.click.state, 'moving', JSON.stringify(r));
  assert.equal(r.click.via, 'bridge'); assert.equal(r.click.from, 'robinhood'); assert.equal(r.click.src, 'w');
  const m = r.planned.find((x) => x.src === 'w');
  assert.deepEqual([m.kind, m.chain, m.from, m.runsOn], ['cold', 'sol', 'robinhood', 'sol']);
  // the quote asked for: W → W, native → native, EXACT_OUTPUT of W's gas floor + $12.50
  const qb = wd.log.quotes[0];
  assert.equal(qb.tradeType, 'EXACT_OUTPUT'); assert.equal(lc(qb.user), lc(wd.W)); assert.equal(qb.recipient, wd.sol.W);
  assert.equal(qb.originCurrency, '0x0000000000000000000000000000000000000000'); assert.equal(qb.destinationCurrency, '11111111111111111111111111111111');
  assert.equal(BigInt(qb.amount), F.SOL_CLICK_FLOOR + 125_000_000n);
  // one deposit, from Robinhood, into Relay's depository, naming W
  const deps = wd.log.sends.filter((x) => x.kind === 'deposit');
  assert.equal(deps.length, 1); assert.equal(deps[0].chain, 'robinhood');
  assert.equal(lc(deps[0].tx.to), RELAY_DEPOSITORY); assert.ok(deps[0].tx.data.toLowerCase().includes(word(wd.W)));
  assert.ok(deps[0].gas >= N.NATIVE_DONOR.gasMin && deps[0].gas <= N.NATIVE_DONOR.gasMax);
  let j = (await jobsOf(wd)).find((x) => x.src === 'w');
  assert.deepEqual([j.kind, j.chain, j.from, j.state, j.bridge, j.click], ['cold', 'sol', 'robinhood', 'relaying', 'relay', true]);
  assert.equal(j.hashes.length, 1);
  // the fill lands; the next look follows Relay's request to arrival and the app's fresh read shows the float
  await sleep(5);
  const s = await wd.f.status({ walletId: 'w1', fresh: true });
  assert.ok(s.chains.sol.ready >= 10, JSON.stringify(s.chains.sol));
  await clickBuy(wd, 1);   // any later tick reconciles it
  j = (await jobsOf(wd)).find((x) => x.src === 'w');
  assert.equal(j.state, 'arrived');
  assert.ok(wd.events.some((e) => e.step === 'cold' && e.state === 'active' && e.src === 'w' && e.from === 'robinhood'), 'the status the app shows');
});

test('the same from a BNB frame: a BNB click with ETH on Robinhood lands BNB in W', async () => {
  const wd = world({ lane: 'bsc' }); await on(wd);
  const r = await clickBuy(wd, 20, 'bsc');
  assert.equal(r.click.state, 'moving', JSON.stringify(r));
  const qb = wd.log.quotes[0];
  assert.equal(qb.destinationChainId, 56); assert.equal(qb.destinationCurrency, '0x0000000000000000000000000000000000000000'); assert.equal(lc(qb.recipient), lc(wd.W));
  // W up to its 0.001 BNB floor + $25 (a $20 buy + 25 %) at $600, at the BNB frame's own oracle
  assert.ok(Math.abs(Number(BigInt(qb.amount) - (F.FLOAT_CFG.bsc.gasFloor + 25n * ETH / 600n))) < 1e10, qb.amount);
  assert.equal(wd.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'robinhood');
});

test('donor selection: both chains can spare it → the cheaper quote; only one can → that one; a donor whose node is down is skipped', async () => {
  // BNB's route 0.25 % cheaper than Robinhood's
  const a = world({ bscBnb: 10n ** 18n, costPct: { robinhood: 0.45, bsc: 0.2 } }); await on(a);
  await clickBuy(a, 10);
  assert.deepEqual(a.log.reads.sort(), ['bsc', 'robinhood'], 'both donors read side by side');
  assert.equal(a.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'bsc');
  // same cost: the faster one
  const t = world({ bscBnb: 10n ** 18n, eta: { robinhood: 1, bsc: 6 } }); await on(t);
  await clickBuy(t, 10);
  assert.equal(t.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'robinhood');
  // Robinhood holds only its floor: BNB
  const b = world({ rhEth: F.FLOAT_CFG.robinhood.gasFloor, bscBnb: 10n ** 18n }); await on(b);
  await clickBuy(b, 10);
  assert.equal(b.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'bsc');
  // BNB's node is down: Robinhood
  const c = world({ bscBnb: 10n ** 18n, readFails: ['bsc'], costPct: { robinhood: 0.45, bsc: 0.2 } }); await on(c);
  await clickBuy(c, 10);
  assert.equal(c.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'robinhood');
  // a chain outside the permission is never a donor
  const d = world({ bscBnb: 10n ** 18n, rhEth: 0n }); await on(d, ['robinhood', 'sol']);
  const rd = await clickBuy(d, 10);
  assert.deepEqual(d.log.reads, ['robinhood']); assert.equal(d.log.sends.length, 0); assert.equal(rd.click.state, 'none');
});

// 2026-11-01 (owner «доводи до уровня фомо … я даю добро на все»: deposit on one chain, trade on any): a click may take the
// donor chain's kept ready float too — only W's gas floor and the deposit's own gas stay; that chain refills in the background.
// Before, the same wallet was "no donor" and the buy failed for want of SOL.
test('keep-float (a click): Robinhood keeps only its gas floor + the gas of the deposit; a donor that leaves its kept float alone is preferred; a wallet that cannot spare the need is refused with why, nothing signed', async () => {
  // Robinhood active (a $20 preset, $30 kept ready) holding the floor + $35: the click takes the $14.50 it needs out of the kept float
  const wd = world({ rhEth: F.FLOAT_CFG.robinhood.gasFloor + 35n * ETH / 4000n }); await on(wd);
  activeOn(wd, 'robinhood', 20);
  const before = wd.st.w.robinhood;
  const r = await clickBuy(wd, 10);
  assert.equal(r.click.state, 'moving', js(r));
  const dep = wd.log.sends.find((x) => x.kind === 'deposit');
  assert.equal(dep.chain, 'robinhood');
  assert.ok(before - dep.tx.value - dep.gas * wd.st.gasPrice.robinhood >= F.FLOAT_CFG.robinhood.gasFloor, 'the gas floor stays');
  // $13.46 above the floor and the deposit's gas: enough for the $13.40 that lands, not for Relay's fee on top — refused with why
  const edge = world({ rhEth: F.FLOAT_CFG.robinhood.gasFloor + 13_460_000n * ETH / 4000n / F.USD + N.NATIVE_DONOR.gasMax * 10_000_000n }); await on(edge);
  activeOn(edge, 'robinhood', 20);
  const re = await clickBuy(edge, 10);
  assert.equal(edge.log.sends.length, 0, js(re));
  assert.equal(re.click.state, 'failed'); assert.match(re.click.why, /Robinhood: the quote takes more than the wallet can spare there/);
  // both chains can pay: Robinhood is cheaper but would dip into its kept float, BNB pays above its own — BNB
  const pref = world({ rhEth: F.FLOAT_CFG.robinhood.gasFloor + 35n * ETH / 4000n, bscBnb: 10n ** 18n, costPct: { robinhood: 0.2, bsc: 0.45 } }); await on(pref);
  activeOn(pref, 'robinhood', 20);
  await clickBuy(pref, 10);
  assert.equal(pref.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'bsc');
  // neither dips into its kept float: the cheaper one, as before
  const cheap = world({ rhEth: 10n ** 17n, bscBnb: 10n ** 18n, costPct: { robinhood: 0.2, bsc: 0.45 } }); await on(cheap);
  activeOn(cheap, 'robinhood', 20);
  await clickBuy(cheap, 10);
  assert.equal(cheap.log.sends.filter((x) => x.kind === 'deposit').map((x) => x.chain).join(), 'robinhood');
});

test('caps: a $90 buy moves $100 + the gas floor (trimmed margin); a $150 buy is refused with why — nothing signed', async () => {
  const wd = world({ rhEth: 10n ** 17n }); await on(wd);
  const r = await clickBuy(wd, 90);
  assert.equal(r.click.state, 'moving', JSON.stringify(r));
  assert.equal(BigInt(wd.log.quotes[0].amount), F.SOL_CLICK_FLOOR + 1_000_000_000n);
  const dep = wd.log.sends.find((x) => x.kind === 'deposit');
  assert.ok(Number(dep.tx.value) / 1e18 * 4000 < 102 * 1.03, 'what leaves is the move + fees');
  const big = world({ rhEth: 10n ** 17n }); await on(big);
  const r2 = await clickBuy(big, 150);
  assert.equal(big.log.sends.length, 0); assert.equal(big.log.quotes.length, 0, 'not even quoted');
  assert.equal(r2.click.state, 'failed'); assert.match(r2.click.why, /more than the \$100\.00/);
  assert.equal(r2.click.src, 'w', "the app names it as this wallet's own move");
});

test('quote refusal paths: recipient, sender, coins, chains, depository, value, extra calldata, steps, less out, price, fee, Relay down — each refused with why, nothing signed', async () => {
  for (const [tamper, re] of [['recipient', /pays someone else/], ['sender', /another sender/], ['currency-out', /pays another coin/], ['currency-in', /spends another coin/], ['chain-out', /other chains/],
    ['depository', /depository/], ['depositor', /name this wallet/], ['value', /value is not the amount/], ['extra-word', /two words/], ['erc20-deposit', /name this wallet|not a native/], ['two-steps', /unexpected steps/],
    ['step-chain', /another chain/], ['less-out', /lands less/], ['min-less', /lands less/], ['expensive', /below the two chains|more than the wallet can spare/], ['fee', /fee is too high|more than the wallet can spare/]]) {
    const wd = world({ tamper }); await on(wd);
    const r = await clickBuy(wd, 10);
    assert.equal(wd.log.sends.length, 0, tamper + ': signed');
    assert.equal(r.click.state, 'failed', tamper + ': ' + JSON.stringify(r.click)); assert.match(r.click.why, re, tamper);
    assert.equal((await jobsOf(wd)).length, 0, tamper + ': no job');
  }
  const down = world({ relayDown: true }); await on(down);
  const r = await clickBuy(down, 10);
  assert.equal(down.log.sends.length, 0); assert.equal(r.click.state, 'failed'); assert.match(r.click.why, /Robinhood: Relay/);
});

// (audit 2026-11-01, vault-security-relay-recipient) the native donor has no dialog: a Relay quote motion would relay (its
// recipient lives only in Relay's record, which the vault cannot read before the deposit) is refused, never even fetched —
// also the honest-looking one and the one that would pass Relay's own price.
test('keyed Relay: the donor never asks motion\'s pass-through and never signs a relayed quote (recipient unverifiable) — a clear refusal, nothing sent', async () => {
  for (const o of [{ relayKeyed: true }, { relayKeyed: true, proxyExactOut: true }, { relayKeyed: true, proxyCheap: true, proxyExactOut: true }]) {
    const wd = world(o); await on(wd);
    const r = await clickBuy(wd, 10);
    assert.equal(wd.log.sends.length, 0, js(o) + ': signed');
    assert.equal(r.click.state, 'failed', js(o) + ': ' + JSON.stringify(r.click)); assert.match(r.click.why, /Robinhood: Relay.*API key/, js(o));
    assert.ok(!wd.log.fetch.includes(PROXY + '/api/bridge/vault-quote'), js(o) + ': the pass-through was asked');
    assert.equal((await jobsOf(wd)).length, 0, js(o) + ': no job');
  }
});

test('no donor → today\'s answer, unchanged: no ETH to spare anywhere (or an older host) — the click is told "none" with the reserves\' skip, nothing signed', async () => {
  const base = world({ noDonorDep: true }); await on(base);
  const before = await clickBuy(base, 10);
  for (const o of [{ rhEth: 0n }, { rhEth: F.FLOAT_CFG.robinhood.gasFloor }, { readFails: ['robinhood', 'bsc'] }]) {
    const wd = world(o); await on(wd);
    const r = await clickBuy(wd, 10);
    assert.equal(wd.log.sends.length, 0);
    assert.deepEqual(r.click, before.click, js(o));
    assert.deepEqual(r.planned, before.planned); assert.deepEqual(r.skipped, before.skipped);
    assert.equal((await jobsOf(wd)).length, 0);
  }
  assert.deepEqual(before.click, { state: 'none' }); assert.ok(before.skipped.some((x) => x.chain === 'sol' && x.why === 'no-reserve'));
});

test('a click the reserve covers never reads another chain: the same-chain top-up only', async () => {
  const wd = world({ rUsdc: 300_000_000n, solW: F.FLOAT_CFG.sol.gasFloor }); await on(wd);
  const r = await clickBuy(wd, 10);
  assert.deepEqual(wd.log.reads, []); assert.equal(wd.log.quotes.length, 0);
  assert.deepEqual(wd.log.sends.map((x) => x.kind), ['topup'], JSON.stringify(r));
});

test('a reserve that covers part: the reserve tops up what it holds, W\'s ETH elsewhere the rest — never both for the same dollars', async () => {
  const wd = world({ rUsdc: 5_000_000n, solW: F.FLOAT_CFG.sol.gasFloor }); await on(wd);
  const r = await clickBuy(wd, 10);
  assert.deepEqual(wd.log.sends.map((x) => x.kind), ['topup', 'deposit'], JSON.stringify(r));
  // $12.50 wanted, W already holds $1.10 above the click's 0.009 SOL floor: $5 from the reserve, $6.40 from Robinhood
  assert.equal(BigInt(wd.log.quotes[0].amount), 64_000_000n);
});

test('idempotent: a second click while the move is on its way sends nothing more; a lost answer keeps its hash and is followed, never re-sent', async () => {
  const wd = world({ neverFills: true }); await on(wd);
  await clickBuy(wd, 10);
  const r2 = await clickBuy(wd, 10);
  assert.equal(wd.log.sends.filter((x) => x.kind === 'deposit').length, 1);
  assert.equal(r2.click.state, 'moving', JSON.stringify(r2));
  const lost = world({ sendThrows: Object.assign(new Error('Deposit send outcome unknown (timed out)'), { name: 'FloatUnknown', unknown: true }), neverFills: true }); await on(lost);
  const r = await clickBuy(lost, 10);
  const j = (await jobsOf(lost)).find((x) => x.src === 'w');
  assert.equal(j.state, 'relaying'); assert.equal(j.hashes.length, 1);
  assert.equal(r.click.state, 'moving');
  await clickBuy(lost, 10);
  assert.equal(lost.log.sends.length, 1, 'never a second signature');
});

test('a refused send (node says no) is a failed job with why; a deposit that reverted on its chain ends the job once Relay has not seen it', async () => {
  const wd = world({ sendThrows: new Error('insufficient funds for gas * price + value') }); await on(wd);
  const r = await clickBuy(wd, 10);
  assert.equal(r.click.state, 'failed'); assert.match(r.click.why, /insufficient funds/);
  const rv = world({ neverFills: true, receipt: 'reverted' }); await on(rv);
  await clickBuy(rv, 10);
  const jobs = JSON.parse(rv.store.get('trenches.float.v1.jobs.sol.' + lc(rv.W)));
  jobs[0].at -= 60_000; rv.store.set('trenches.float.v1.jobs.sol.' + lc(rv.W), JSON.stringify(jobs));
  await rv.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await sleep(400);
  const j = (await jobsOf(rv)).find((x) => x.src === 'w');
  assert.equal(j.state, 'failed'); assert.match(j.error, /reverted on Robinhood/);
});

test('the USD balance off: nothing is read or moved from another chain', async () => {
  const wd = world();
  const r = await clickBuy(wd, 10);
  assert.equal(wd.log.reads.length + wd.log.sends.length + wd.log.quotes.length, 0, JSON.stringify(r));
});

// ── the measurement: click → native landed → buy sent, on the fake chains with the latencies measured on 2026-10-30 ──
// (read-only, B:\tmp\native-donor\live.mjs): Relay quote ~0.3–0.8 s, Robinhood reads ~0.1–0.2 s, a Solana read ~0.12 s; the
// fill ~1 s after the deposit's block (Relay's own request history, RH → SOL, 19 of 19 within 1 s) + ~0.5 s inclusion. The
// app's hold & fire asks for a fresh status every 0.5 s and fires on the first one that covers the buy.
test('timing: click → SOL landed → buy fired, within the app\'s 15 s hold (today: the buy fails at once)', async () => {
  const t = { quote: Number(process.env.T_QUOTE || 450), read: Number(process.env.T_READ || 150), send: Number(process.env.T_SEND || 200), solRead: 120, fill: Number(process.env.T_FILL || 1500) };
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const wd = world({ t }); await on(wd);
    const t0 = Date.now();
    const r = await clickBuy(wd, 10);
    const tEnsure = Date.now() - t0;
    assert.equal(r.click.state, 'moving');
    const tSent = wd.log.sends.find((x) => x.kind === 'deposit').at - t0;
    let fired = 0;
    for (;;) {
      const s = await wd.f.status({ walletId: 'w1', fresh: true });
      if (s.chains.sol.ready >= 10) { fired = Date.now() - t0; break; }
      if (Date.now() - t0 > 15_000) break;
      await sleep(500);
    }
    runs.push({ ensure: tEnsure, depositSent: tSent, landed: wd.fills[0] - t0, fired });
  }
  const base = world({ noDonorDep: true, t }); await on(base);
  const b0 = Date.now(); const rb = await clickBuy(base, 10); const tb = Date.now() - b0;
  console.log('# native donor timings (ms):', JSON.stringify(runs), '· today: answer', JSON.stringify(rb.click), 'after', tb, 'ms, then the engine refuses "This wallet has no SOL yet — fund it first"');
  for (const x of runs) { assert.ok(x.fired > 0 && x.fired < 15_000, JSON.stringify(x)); assert.ok(x.fired >= x.landed); }
});

// ── 2026-11-01: a click elsewhere from small balances (owner «доводи до уровня фомо … я даю добро на все»; a tester with $4.90 on
// Robinhood / BNB and nothing on Solana could not buy $1 there). The need now always carries W's gas floor; a click may take a
// chain's whole float above its gas floor; two chains pay one click together when neither can alone ──
const above = (chain, usd) => F.FLOAT_CFG[chain].gasFloor + BigInt(Math.round(usd * 1e6)) * ETH / (BigInt(PRICE[chain]) * F.USD);
test('need: the moves already on their way fill the gas floor of W first, then the buy (a reserve top-up that carried the floor is not counted twice)', () => {
  const P = 100n * F.USD, floor = F.SOL_CLICK_FLOOR;
  // the reserves started exactly the buy + 25 % ($12.50) for a W with no SOL: the click's floor ($0.90) is still missing — asked of the donor
  const a = N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 12_500_000n });
  assert.ok(a && !('refuse' in a), js(a));
  assert.equal(a.out, floor);
  // the reserves started the buy + 25 % + the floor ($13.40): nothing
  assert.equal(N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 13_400_000n }), null);
  // $1 of it on its way (in flight): the first $1 of the floor is covered, the rest of the floor + the whole buy is asked
  const b = N.nativeDonorNeed({ chain: 'sol', float: 0n, price6: P, inFlight6: F.USD, need6: 10n * F.USD, started6: 0n });
  assert.equal(b.out, floor - 10_000_000n + 125_000_000n);
  // W at its floor: exactly as before
  assert.equal(N.nativeDonorNeed({ chain: 'sol', float: floor, price6: P, inFlight6: 0n, need6: 10n * F.USD, started6: 0n }).out, 125_000_000n);
});

test('cap + split: what a donor of a given spare can land, and how two chains share one click (largest first, never a part under $0.10)', () => {
  const RH = 4000n * F.USD;
  // $10 spare on Robinhood: ($10 − $0.10) / 1.01 — a Relay move as measured (~0.4 % + ~$0.05) fits in the spare
  const cap = N.nativeDonorCap6({ from: 'robinhood', spare: 10n * ETH / 4000n, price6: RH, maxSlipBps: 50 });
  assert.equal(cap, 9_801_980n);
  assert.ok(cap * 1004n / 1000n + 50_000n <= 10n * F.USD, 'what leaves for that landing fits in the spare');
  assert.equal(N.nativeDonorCap6({ from: 'robinhood', spare: 0n, price6: RH, maxSlipBps: 50 }), 0n);
  const P = 100n * F.USD, out = 32_500_000n;   // 0.0325 SOL = $3.25
  const parts = N.nativeDonorSplit({ to: 'sol', out, price6: P, donors: [{ d: 'bsc', cap6: 2_000_000n }, { d: 'robinhood', cap6: 2_100_000n }] });
  assert.deepEqual(parts.map((p) => p.d), ['robinhood', 'bsc']);
  assert.equal(parts[0].out, 21_000_000n); assert.equal(parts[0].out + parts[1].out, out, 'the parts add up to exactly what the click needs');
  // together still short: nothing (a part alone would not make the click payable)
  assert.equal(N.nativeDonorSplit({ to: 'sol', out, price6: P, donors: [{ d: 'bsc', cap6: 1_000_000n }, { d: 'robinhood', cap6: 2_000_000n }] }), null);
  // one chain covers it: not a split (the single-donor path handles it)
  assert.equal(N.nativeDonorSplit({ to: 'sol', out, price6: P, donors: [{ d: 'robinhood', cap6: 5_000_000n }] }), null);
  // a remainder that would be under $0.10 on the second chain: the first takes less, the second at least $0.10
  const r2 = N.nativeDonorSplit({ to: 'sol', out, price6: P, donors: [{ d: 'robinhood', cap6: 3_200_000n }, { d: 'bsc', cap6: 2_000_000n }] });
  assert.ok(F.nativeToUsd6(r2[1].out, P, 9) >= F.RULES.clickMin6, js(r2)); assert.equal(r2[0].out + r2[1].out, out);
  // dust donors are no part
  assert.equal(N.nativeDonorSplit({ to: 'sol', out, price6: P, donors: [{ d: 'robinhood', cap6: 3_200_000n }, { d: 'bsc', cap6: 50_000n }] }), null);
});

test('small native balances on two chains (the tester: $2.45 a wallet — $1.25 of ETH above the floor on Robinhood + $1.20 of BNB — and no SOL, a $1 buy): ONE click is paid by both — two deposits, exactly the need lands, the buy fires', async () => {
  const wd = world({ rhEth: above('robinhood', 1.25), bscBnb: above('bsc', 1.2) }); await on(wd);
  // both chains active with $10 presets: they keep their ready floats — a click elsewhere may still take them (2026-11-01)
  activeOn(wd, 'robinhood', 10); activeOn(wd, 'bsc', 10);
  const r = await clickBuy(wd, 1);
  assert.equal(r.click.state, 'moving', js(r));
  assert.equal(r.click.src, 'w');
  const sent = wd.log.sends.filter((x) => x.kind === 'deposit');
  assert.deepEqual(sent.map((x) => x.chain).sort(), ['bsc', 'robinhood'], js(r));
  // the parts asked for add up to the click's floor (0.009 SOL) + the $1 buy at $100: with the 25 % margin the two cannot carry it
  // after Relay's costs and the deposits' gas, so the bare need is moved (Relay's EXACT_OUTPUT lands exactly that)
  const want = F.SOL_CLICK_FLOOR + 10_000_000n;
  const asked = wd.log.quotes.slice(-2).reduce((t, q) => t + BigInt(q.amount), 0n);
  assert.equal(asked, want);
  for (const d of sent) { assert.equal(lc(d.tx.to), RELAY_DEPOSITORY); assert.ok(wd.st.w[d.chain] >= F.FLOAT_CFG[d.chain].gasFloor, d.chain + ': the gas floor stays'); }
  const jobs = (await jobsOf(wd)).filter((x) => x.src === 'w');
  assert.equal(jobs.length, 2); assert.ok(jobs.every((j) => j.state === 'relaying' && j.click && j.hashes.length === 1));
  assert.equal(r.planned.filter((m) => m.src === 'w').length, 2);
  assert.ok(Math.abs(r.click.usd - 1.9) < 0.01, 'the toast names the whole amount: ' + r.click.usd);
  await sleep(5);
  // landed: W holds the click's floor + $1 (its click-ready, above 0.009 SOL, covers the $1 buy)
  assert.ok(wd.st.w.sol >= F.SOL_CLICK_FLOOR + 10_000_000n, String(wd.st.w.sol));
  assert.ok(F.clickUsd6('sol', wd.st.w.sol, 100n * F.USD) >= F.USD);
  // a second click while they land sends nothing more
  await clickBuy(wd, 1);
  assert.equal(wd.log.sends.filter((x) => x.kind === 'deposit').length, 2);
});

test('two chains together: one part refused (its quote fails a check) = nothing signed on either chain, the click is told why', async () => {
  const wd = world({ rhEth: above('robinhood', 1.45), bscBnb: above('bsc', 1.45), tamper: (b) => (b.originChainId === 56 && BigInt(b.amount) < 20_000_000n ? 'recipient' : '') }); await on(wd);
  const r = await clickBuy(wd, 1);
  assert.equal(wd.log.sends.length, 0, js(r));
  assert.equal(r.click.state, 'failed'); assert.match(r.click.why, /together: BNB: the quote pays someone else/);
  assert.equal((await jobsOf(wd)).length, 0);
  // Relay down for the parts: the same, nothing signed
  const down = world({ rhEth: above('robinhood', 1.45), bscBnb: above('bsc', 1.45), relayDown: true }); await on(down);
  const r2 = await clickBuy(down, 1);
  assert.equal(down.log.sends.length, 0); assert.equal(r2.click.state, 'failed');
});

test('two chains together still short: nothing is quoted part by part or signed, the answer is as before', async () => {
  const wd = world({ rhEth: above('robinhood', 0.5), bscBnb: above('bsc', 0.5) }); await on(wd);
  const r = await clickBuy(wd, 1);
  assert.equal(wd.log.sends.length, 0, js(r));
  assert.deepEqual(r.click, { state: 'none' });
});

test('two chains together, the answer of one part lost (unknown): it keeps its hash and is followed, the other part goes on; a later click never signs again', async () => {
  const wd = world({ rhEth: above('robinhood', 1.45), bscBnb: above('bsc', 1.45), sendThrowsOn: 'bsc', sendThrows: Object.assign(new Error('Deposit send outcome unknown (timed out)'), { name: 'FloatUnknown', unknown: true }), neverFills: true }); await on(wd);
  const r = await clickBuy(wd, 1);
  assert.equal(r.click.state, 'moving', js(r));
  const jobs = (await jobsOf(wd)).filter((x) => x.src === 'w');
  assert.deepEqual(jobs.map((j) => [j.from, j.state, j.hashes.length]).sort(), [['bsc', 'relaying', 1], ['robinhood', 'relaying', 1]]);
  const sends = wd.log.sends.length;
  await clickBuy(wd, 1); await clickBuy(wd, 5);
  assert.equal(wd.log.sends.length, sends, 'never a second signature while a part is open');
});

test('two chains together, one part refused at the send (node says no): that part fails with why, the other one is on its way — never re-sent', async () => {
  const wd = world({ rhEth: above('robinhood', 1.45), bscBnb: above('bsc', 1.45), sendThrowsOn: 'bsc', sendThrows: new Error('insufficient funds for gas * price + value'), neverFills: true }); await on(wd);
  const r = await clickBuy(wd, 1);
  assert.equal(r.click.state, 'moving', js(r));
  const jobs = (await jobsOf(wd)).filter((x) => x.src === 'w');
  assert.deepEqual(jobs.map((j) => [j.from, j.state]).sort(), [['bsc', 'failed'], ['robinhood', 'relaying']]);
  assert.match(jobs.find((j) => j.from === 'bsc').error, /insufficient funds/);
  const tries = wd.log.sends.length;   // both signatures were tried (the BNB one refused by its node)
  await clickBuy(wd, 1);
  assert.equal(wd.log.sends.length, tries, 'the open part blocks a new move on this lane');
});

test('W with no SOL at all and a Solana reserve without its own gas (nothing W can spare for it): W\x27s ETH elsewhere carries the whole need, gas floor included', async () => {
  const wd = world({ rUsdc: 5_000_000n, solW: 0n }); await on(wd);
  const r = await clickBuy(wd, 10);
  assert.deepEqual(wd.log.sends.map((x) => x.kind), ['deposit'], js(r));
  // $12.50 + the 0.02 SOL floor, exactly
  assert.equal(BigInt(wd.log.quotes[0].amount), F.SOL_CLICK_FLOOR + 125_000_000n);
  assert.equal(r.click.state, 'moving');
});

test('the 25 % margin is dropped only when no chain, alone or together, can carry it: then exactly the bare need lands (the gas floor + the buy)', async () => {
  const bare = F.SOL_CLICK_FLOOR + 10_000_000n;   // the click's 0.009 SOL + $1 at $100
  // one chain, $2.00 above its floor: $2.15 with the margin is too much, $1.90 bare fits — one deposit for the bare need
  const one = world({ rhEth: above('robinhood', 2) }); await on(one);
  const r1 = await clickBuy(one, 1);
  assert.equal(r1.click.state, 'moving', js(r1));
  const d1 = one.log.sends.filter((x) => x.kind === 'deposit');
  assert.equal(d1.length, 1); assert.equal(BigInt(one.log.quotes[one.log.quotes.length - 1].amount), bare);
  // two chains, $1.25 + $1.20 above their floors: together short of $2.15 after costs, enough for $1.90 — two parts of the bare need
  const two = world({ rhEth: above('robinhood', 1.25), bscBnb: above('bsc', 1.2) }); await on(two);
  const r2 = await clickBuy(two, 1);
  assert.equal(r2.click.state, 'moving', js(r2));
  const sent = two.log.sends.filter((x) => x.kind === 'deposit');
  assert.deepEqual(sent.map((x) => x.chain).sort(), ['bsc', 'robinhood']);
  const asked = two.log.quotes.slice(-2).reduce((t, q) => t + BigInt(q.amount), 0n);
  assert.equal(asked, bare);
  // a chain that carries the margin is never asked for less
  const rich = world({ rhEth: above('robinhood', 50) }); await on(rich);
  await clickBuy(rich, 1);
  assert.ok(rich.log.quotes.every((q) => BigInt(q.amount) === F.SOL_CLICK_FLOOR + 12_500_000n), js(rich.log.quotes.map((q) => q.amount)));
});
