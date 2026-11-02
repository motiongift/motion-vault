// USD balance — the vault module (src/floatEngine.ts) end to end on a MOCKED chain: a Robinhood frame with a SwapRouter02
// that really decodes the vault's calldata (multicall → exactInputSingle → unwrapWETH9) and moves balances at the pool
// price, an ERC-20 with allowances, nonces and receipts; Relay / deBridge answering like their APIs (recorded shapes);
// a Solana frame for the same-chain swap. Throwaway keys only, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat, topupCalldata } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';
import { setRelayProxyBase } from '../src/relayApi.ts';
const PROXY = 'https://motion.test';   // motion's keyed pass-through in these worlds (relayApi.ts)
setRelayProxyBase(() => PROXY);

const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'unwrapWETH9', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
];
const ERC20 = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const RELAY_ABI = [{ name: 'depositErc20', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'depositor', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'id', type: 'bytes32' }], outputs: [] }];
const C = F.FLOAT_CFG.robinhood;
const lc = (a) => String(a).toLowerCase();
const ETH_USD = 4000;
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const DLN = '0xef4fb24ad0916217251f553c0596f8edc630eb66';

function makeWorld(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
  const chain = {
    eth: new Map([[lc(W), o.wEth ?? (C.gasFloor + 5_000_000_000_000_000n)], [lc(R), o.rEth ?? C.reserveGas]]),   // W: floor + $20
    usdg: new Map([[lc(R), o.rUsdg ?? 500_000_000n]]),
    allow: new Map(), nonces: new Map(), receipts: new Map(), txs: [], skewBps: o.skewBps ?? 0, calls: 0, deposits: [],
  };
  const price = () => ETH_USD * (1 - chain.skewBps / 10_000);
  const swap = (from, value, data, apply) => {
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_ABI, data });
    assert.equal(functionName, 'multicall');
    const outs = []; let routerWeth = 0n;
    for (const inner of args[1]) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data: inner });
      if (d.functionName === 'exactInputSingle') {
        const p = d.args[0];
        let out;
        if (lc(p.tokenIn) === lc(C.stable.address)) {
          const al = chain.allow.get(`${lc(from)}>${lc(C.router)}`) ?? 0n;
          if (al < p.amountIn) throw new Error('execution reverted: STF');
          if ((chain.usdg.get(lc(from)) ?? 0n) < p.amountIn) throw new Error('execution reverted: STF balance');
          out = BigInt(Math.floor(Number(p.amountIn) / 1e6 / price() * 0.9999 * 1e18));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply) { chain.allow.set(`${lc(from)}>${lc(C.router)}`, al - p.amountIn); chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - p.amountIn); }
          if (lc(p.recipient) === '0x0000000000000000000000000000000000000002') routerWeth += out; else throw new Error('test: top-up must keep the WETH in the router');
        } else {
          assert.equal(lc(p.tokenIn), lc(C.wrapped)); assert.equal(value, p.amountIn);
          out = BigInt(Math.floor(Number(p.amountIn) / 1e18 * price() * 0.9999 * 1e6));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - value); chain.usdg.set(lc(p.recipient), (chain.usdg.get(lc(p.recipient)) ?? 0n) + out); }
        }
        outs.push(encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', result: out }));
      } else if (d.functionName === 'unwrapWETH9') {
        if (routerWeth < d.args[0]) throw new Error('execution reverted: Insufficient WETH9');
        if (apply) chain.eth.set(lc(d.args[1]), (chain.eth.get(lc(d.args[1])) ?? 0n) + routerWeth);
        routerWeth = 0n; outs.push('0x');
      }
    }
    return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', result: outs });
  };
  const exec = (from, tx, apply) => {
    chain.calls += 1;
    const to = lc(tx.to);
    if (to === lc(C.router)) return swap(from, tx.value, tx.data, apply);
    if (to === lc(C.stable.address)) {
      const d = decodeFunctionData({ abi: ERC20, data: tx.data });
      if (d.functionName === 'transfer') { const have = chain.usdg.get(lc(from)) ?? 0n; if (have < d.args[1]) throw new Error('execution reverted: balance'); if (apply) { chain.usdg.set(lc(from), have - d.args[1]); chain.usdg.set(lc(d.args[0]), (chain.usdg.get(lc(d.args[0])) ?? 0n) + d.args[1]); } return '0x' + '1'.padStart(64, '0'); }
      if (apply) chain.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]);
      return '0x' + '1'.padStart(64, '0');
    }
    if (to === DEPOSITORY) {
      const d = decodeFunctionData({ abi: RELAY_ABI, data: tx.data });
      const al = chain.allow.get(`${lc(from)}>${DEPOSITORY}`) ?? 0n;
      if (al < d.args[2]) throw new Error('execution reverted: allowance');
      if (apply) { chain.allow.set(`${lc(from)}>${DEPOSITORY}`, al - d.args[2]); chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - d.args[2]); chain.deposits.push({ bridge: 'relay', from, amount: d.args[2] }); }
      return '0x';
    }
    if (to === DLN) {
      const al = chain.allow.get(`${lc(from)}>${DLN}`) ?? 0n;
      if (al <= 0n) throw new Error('execution reverted: allowance');
      if (apply) { chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - al); chain.allow.set(`${lc(from)}>${DLN}`, 0n); chain.deposits.push({ bridge: 'debridge', from, amount: al }); }
      return '0x';
    }
    if (tx.data === '0x') { if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - tx.value); chain.eth.set(lc(tx.to), (chain.eth.get(lc(tx.to)) ?? 0n) + tx.value); } return '0x'; }
    throw new Error('test: unexpected call to ' + tx.to);
  };
  const send = (from, tx, gas) => {
    if (o.sendFails) { const e = new F.FloatRefusedProbe(); throw e; }
    const nonce = chain.nonces.get(lc(from)) ?? 0;
    const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}`));
    if (o.lose && chain.txs.length === (o.loseAt ?? 1)) { chain.txs.push({ from, ...tx, hash, lost: true }); exec(from, tx, true); chain.receipts.set(hash, 'success'); chain.nonces.set(lc(from), nonce + 1); throw Object.assign(new Error('Reserve send outcome unknown (timed out)'), { name: 'FloatUnknown', unknown: true, hash }); }
    let status = 'success';
    try { exec(from, tx, true); } catch { status = 'reverted'; }
    chain.nonces.set(lc(from), nonce + 1);
    chain.txs.push({ from, ...tx, gas, hash });
    chain.receipts.set(hash, status);
    return hash;
  };
  // the bridges' APIs (the shapes recorded on 2026-10-25), with knobs to tamper
  const fetchLog = [];
  const word = (h) => lc(h).replace(/^0x/, '').padStart(64, '0');
  const fetchFn = async (url, init) => {
    fetchLog.push(String(url));
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.startsWith('https://api.relay.link/requests/v2') && !o.requestsGone) return ok({ requests: o.relayRecent ? [{ user: new URL(url).searchParams.get('user'), createdAt: new Date(Date.now() - 30_000).toISOString(), data: { outTxs: [{ chainId: 792703809 }] } }] : [] });
    // (2026-10-29) Relay wants a key: its keyless quote refuses, motion's pass-through answers (full shape, tamper knobs)
    if (url === 'https://api.relay.link/quote/v2' && o.relayKeyed) return { ok: false, status: 401, json: async () => ({ errorCode: 'UNAUTHORIZED_QUOTE', message: 'An API key is required' }) };
    if (url === PROXY + '/api/bridge/vault-quote') {
      const b = JSON.parse(init.body); const amount = BigInt(b.amount); const t = o.proxyTamper || '';
      const spender = t === 'approve-spender' ? '0x' + '77'.repeat(20) : DEPOSITORY, approveAmt = t === 'approve-unlimited' ? (2n ** 256n - 1n) : amount;
      const depTo = t === 'depository' ? '0x' + '78'.repeat(20) : DEPOSITORY;
      const out = t === 'cheap' ? amount * 900n / 1000n : amount * 999n / 1000n;
      return ok({ requestId: '0x' + 'e2'.repeat(32),
        steps: [
          { id: 'approve', kind: 'transaction', items: [{ data: { to: C.stable.address, data: '0x095ea7b3' + word(spender) + word(approveAmt.toString(16)), value: '0', chainId: b.originChainId } }] },
          { id: 'deposit', kind: 'transaction', requestId: '0x' + 'e2'.repeat(32), items: [{ data: { to: depTo, data: '0xe8017952' + word(b.user) + word(C.stable.address) + word(amount.toString(16)) + 'ab'.repeat(32), value: '0', chainId: b.originChainId } }] },
        ],
        details: { sender: b.user, recipient: t === 'recipient' ? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' : b.recipient, timeEstimate: 1,
          currencyIn: { amount: b.amount, currency: { chainId: b.originChainId, address: b.originCurrency, decimals: 6 } },
          currencyOut: { amount: String(out), minimumAmount: String(out * 998n / 1000n), currency: { chainId: b.destinationChainId, address: b.destinationCurrency, decimals: 6 } } },
        fees: { relayer: { amountUsd: '0.07' }, gas: { amountUsd: '0.005' } } });
    }
    if (url === 'https://api.relay.link/price') { const b = JSON.parse(init.body); return ok({ details: { currencyOut: { amount: String(BigInt(b.amount) * 999n / 1000n) } } }); }
    if (url.startsWith('https://api.relay.link/requests/v2') && o.requestsGone) return { ok: false, status: 410, json: async () => ({ message: 'GET /requests/v2 was retired' }) };
    if (url.startsWith(PROXY + '/api/bridge/vault-requests')) {
      const user = new URL(url).searchParams.get('user'); const rows = typeof o.proxyRows === 'function' ? o.proxyRows(user) : (o.proxyRows || []);
      return ok({ requests: rows.map((r) => ({ createdAt: new Date(Date.now() - 30_000).toISOString(), data: { outTxs: [{ chainId: 792703809 }] }, ...r })) });
    }
    if (url === 'https://api.relay.link/quote/v2') {
      if (o.relayDown) return { ok: false, status: 503, json: async () => ({ message: 'down' }) };
      const b = JSON.parse(init.body);
      const amount = BigInt(b.amount);
      const depositor = o.relayDepositor || b.user;
      return ok({
        steps: [
          { id: 'approve', kind: 'transaction', items: [{ data: { to: C.stable.address, data: '0x095ea7b3' + word(DEPOSITORY) + word(amount.toString(16)), value: '0' } }] },
          { id: 'deposit', kind: 'transaction', requestId: '0x' + 'e1'.repeat(32), items: [{ data: { to: DEPOSITORY, data: '0xe8017952' + word(depositor) + word(C.stable.address) + word(amount.toString(16)) + 'ab'.repeat(32), value: '0' } }] },
        ],
        details: { currencyOut: { amount: String(amount * 999n / 1000n), minimumAmount: String(amount * 997n / 1000n) }, recipient: b.recipient, timeEstimate: 1 },
        fees: { relayer: { amountUsd: '0.07' }, gas: { amountUsd: '0.005' } },
      });
    }
    if (url.startsWith('https://api.relay.link/intents/status/v3') || url.startsWith('https://api.relay.link/intents/status/v2')) return ok({ status: o.relayStatus || 'success' });
    if (url.startsWith('https://dln.debridge.finance/v1.0/dln/order/create-tx')) {
      const q = new URL(url).searchParams; const amount = BigInt(q.get('srcChainTokenInAmount'));
      return ok({ tx: { to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66', data: '0xb9303701' + '00'.repeat(64), value: '1000000000000000' }, estimation: { dstChainTokenOut: { amount: String(amount * 990n / 1000n) } }, fixFee: '1000000000000000', orderId: '0xorder', order: { approximateFulfillmentDelay: 4 } });
    }
    if (url.startsWith('https://dln-api.debridge.finance/api/Orders/')) return ok({ status: 'Fulfilled' });
    if (url.startsWith('https://price-api.mayan.finance')) return ok({ quotes: [] });
    throw new Error('test: unexpected fetch ' + url);
  };
  const store = new Map();
  const events = []; const asks = []; let gates = 0;
  // the user is active by default (a trade 30 s ago and a ticket touch just now, outside any click window): W's own sends
  // need the quiet rule, idle(wd)
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const solCalls = [];
  // the Solana forward of W's USDC (o.solFwd): a small stateful chain — W / R lamports and USDC, and what status a signature reads
  const sw = o.solFwd ? { wUsdc: o.solFwd.wUsdc ?? 0n, rUsdc: o.solUsdc ?? 0n, wLam: o.solW ?? 20_000_000n, rLam: o.solR ?? 10_000_000n, st: o.solFwd.st ?? (() => 'confirmed'), n: 0, throwFwd: o.solFwd.throwFwd } : null;
  const deps = {
    chain: () => o.lane || 'robinhood',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W, sol: sol.W }, r: { evm: R, sol: sol.R } }; },
    evm: {
      call: async (tx) => exec(tx.from, tx, false),
      balance: async (a) => chain.eth.get(lc(a)) ?? 0n,
      erc20: async (t, a) => chain.usdg.get(lc(a)) ?? 0n,
      allowance: async (t, owner, spender) => chain.allow.get(`${lc(owner)}>${lc(spender)}`) ?? 0n,
      slot0: async () => sqrtFor(ETH_USD),
      fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }),
      estimate: async (tx) => { exec(tx.from, tx, false); return 150_000n; },
      sendR: async (walletId, tx, gas) => send(R, tx, gas),
      sendW: async (walletId, tx, gas) => send(W, tx, gas),
      receipt: async (h) => (chain.receipts.has(h) ? { status: chain.receipts.get(h) } : null),
    },
    sol: {
      balance: async (a) => (sw ? (a === sol.W ? sw.wLam : sw.rLam) : a === sol.W ? o.solW ?? 20_000_000n : 10_000_000n), usdc: async (owner) => (sw ? (owner === sol.W ? sw.wUsdc : sw.rUsdc) : o.solUsdc ?? 0n), oracle6: async () => 100n * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      topup: async (id, usdcIn, minLamports) => { solCalls.push({ kind: 'topup', usdcIn, minLamports }); return 'sig' + solCalls.length; },
      sweep: async (id, l, m) => { solCalls.push({ kind: 'sweep', l, m }); return 'sigs'; },
      gas: async (id, l) => { solCalls.push({ kind: 'gas', l }); return 'sigg'; },
      status: async (sig) => (sw ? sw.st(sig) : 'confirmed'),
      ...(sw ? {
        forward: async (id, units) => {
          solCalls.push({ kind: 'forward', id, units });
          if (sw.throwFwd) throw sw.throwFwd;
          if (units > sw.wUsdc) throw new Error('Simulation failed: insufficient funds');
          const sig = 'sigf' + ++sw.n; const fee = F.solFwdFee(F.SOL_FWD.units, F.SOL_FWD.micro) + (sw.rUsdc > 0n ? 0n : F.SOL_FWD.ataRent);
          if (sw.wLam < fee + F.SOL_FWD.rentMin) throw new Error('Simulation failed: insufficient lamports');
          if (sw.st(sig) === 'confirmed') { sw.wUsdc -= units; sw.rUsdc += units; sw.wLam -= fee; }
          return sig;
        },
        fundW: async (id, lamports) => { solCalls.push({ kind: 'fundW', id, lamports }); const sig = 'sigw' + ++sw.n; if (sw.st(sig) === 'confirmed') { sw.rLam -= lamports + F.solFwdFee(F.SOL_FWD.fundUnits, F.SOL_FWD.fundMicro); sw.wLam += lamports; } return sig; },
      } : {}),
    },
    ask: async (a) => { asks.push(a); return o.answer ?? true; },
    gate: async () => { gates += 1; },
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: o.lock || (async (k, fn) => fn()),
    emit: (d) => events.push(d),
    fetch: fetchFn,
    click: () => click,
    wait: async () => {},
  };
  const f = createFloat(deps);
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  return { f, chain, W, R, W_KEY, R_KEY, sol, store, events, asks, gates: () => gates, click, fetchLog, settle, solCalls, deps, sw };
}
const idle = (wd) => { wd.click.lastTradeAt = Date.now() - 120_000; wd.click.ticketAt = Date.now() - 120_000; };
const keyScan = (wd, things) => {
  const blob = JSON.stringify(things, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + [...wd.store.values()].join('|') + JSON.stringify(wd.events) + JSON.stringify(wd.asks);
  for (const k of [wd.W_KEY, wd.R_KEY]) { assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked'); }
};
// the standing permission alone: these tests cover the moves AFTER the switch, so the switch-on conversion it orders is
// dropped here (the switch-on / switch-off tests at the end of this file cover the conversions)
async function on(wd, caps) {
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'], ...(caps ? { caps } : {}) });
  assert.equal(r.ok, true);
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k);
  return r;
}

const rowsOf = (html) => [...html.matchAll(/<div class="ub-r"><div class="ub-w"><span class="ub-n">(.*?)<\/span><span class="ub-cs">(.*?)<\/span><\/div><b class="ub-u" translate="no">(.*?)<\/b><\/div>/g)]
  .map((m) => [m[1], [...m[2].matchAll(/<span class="ub-c" translate="no">(.*?)<\/span>/g)].map((c) => c[1]), m[3]]);
const leadOf = (html) => (html.match(/<p class="ub-lead">(.*?)<\/p>/) || [])[1] ?? '';
const skipOf = (html) => (html.match(/<p class="ub-skip">(.*?)<\/p>/) || [])[1] ?? '';
const noteOf = (html) => (html.match(/<p class="ub-note">(.*?)<\/p>/) || [])[1] ?? '';

test('configure: the dialog states the rules; cancel saves nothing; lowering a cap needs no dialog, raising one does (and the 2FA gate)', async () => {
  const wd = makeWorld({ answer: false });
  await assert.rejects(wd.f.configure({ walletId: 'w1', chains: ['robinhood'] }), /Cancelled/);
  assert.equal((await wd.f.status({ walletId: 'w1' })).enabled, false);
  const wd2 = makeWorld();
  await on(wd2);
  assert.equal(wd2.asks.length, 1); assert.equal(wd2.gates(), 1);
  assert.match(wd2.asks[0].html, /no daily or volume limits/); assert.match(wd2.asks[0].html, /Nothing else can leave your wallets/);
  await wd2.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'], caps: { perDay: 500 } });
  assert.equal(wd2.asks.length, 1, 'lowering: no dialog');
  await wd2.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'], caps: { perDay: 800 } });
  assert.equal(wd2.asks.length, 2, 'raising: the dialog again');
  const st = await wd2.f.status({ walletId: 'w1' });
  assert.equal(st.enabled, true); assert.equal(st.permission.caps.perDay, 800); assert.equal(st.reserve.evm, wd2.R);
  await wd2.f.off({ walletId: 'w1' });
  assert.equal((await wd2.f.status({ walletId: 'w1' })).enabled, false);
  keyScan(wd2, st);
});

test('top-up: R approves the EXACT amount, swaps USDG → ETH on its own nonce and the router pays W ≥ the oracle floor; the next tick sees it arrive', async () => {
  const wd = makeWorld(); await on(wd);
  const before = wd.chain.eth.get(lc(wd.W));
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  assert.equal(r.ok, true); assert.ok(r.jobId, JSON.stringify(r));
  const top = r.planned.find((m) => m.kind === 'topup'); assert.ok(top);
  assert.equal(wd.chain.txs.length, 2);
  const [approve, swap] = wd.chain.txs;
  assert.equal(lc(approve.from), lc(wd.R)); assert.equal(lc(swap.from), lc(wd.R));   // never W's nonce
  const amountIn = F.usd6ToStable(F.usd6(top.usd), 6);
  assert.equal(decodeFunctionData({ abi: ERC20, data: approve.data }).args[1], amountIn);
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: decodeFunctionData({ abi: ROUTER_ABI, data: swap.data }).args[1][1] });
  assert.equal(lc(inner.args[1]), lc(wd.W), 'unwrap pays W');
  const got = wd.chain.eth.get(lc(wd.W)) - before;
  const floor = F.minOutFloor('stable→native', amountIn, 4000n * F.USD, 'robinhood', 50, F.usd6(top.fee));
  assert.ok(got >= floor, `${got} < ${floor}`);
  assert.equal(wd.chain.allow.get(`${lc(wd.R)}>${lc(C.router)}`), 0n, 'nothing left approved');
  const s1 = await wd.f.jobs({ walletId: 'w1' });
  assert.equal(s1.jobs[0].state, 'sent');
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const s2 = await wd.f.jobs({ walletId: 'w1' });
  assert.equal(s2.jobs.find((j) => j.kind === 'topup').state, 'arrived');
  assert.ok(wd.events.some((e) => e.step === 'topup' && e.state === 'done'));
  keyScan(wd, [r, s1, s2]);
});

test('top-up refused before anything moves when the pool is below the oracle by more than the max slippage', async () => {
  const wd = makeWorld({ skewBps: -200 }); await on(wd);   // the pool pays 2 % less than the oracle says
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  assert.equal(jobs[0].state, 'failed'); assert.match(jobs[0].error, /below the oracle|Too little received/);
  assert.equal(wd.chain.txs.filter((t) => lc(t.to) === lc(C.router)).length, 0, 'no swap sent');
  assert.equal(wd.chain.usdg.get(lc(wd.R)), 500_000_000n, 'reserve untouched');
  assert.ok(r.ok);
});

test('click window: no float request at all while a trade runs or right after a token page got focus', async () => {
  const wd = makeWorld(); await on(wd);
  wd.click.clickAt = Date.now() + 1;   // a trade between its call and its broadcast
  const calls = wd.chain.calls;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.calls, calls, 'no read, no simulation'); assert.equal(wd.chain.txs.length, 0);
  wd.click.clickAt = 0; wd.click.focusAt = Date.now();
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0);
  const st = await wd.f.status({ walletId: 'w1' });   // status answers from the cache, no read (I6)
  assert.equal(wd.chain.calls, calls); assert.ok(st.ok);
});

test('a click top-up runs right after the ⚡ hover stamped focus (2026-10-27: every one was deferred 10 s and the buy failed); a running trade still holds it', async () => {
  const wd = makeWorld(); await on(wd);
  wd.click.focusAt = Date.now(); wd.click.ticketAt = Date.now();   // prewarm on hover
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  assert.ok(r.planned.find((m) => m.kind === 'topup'), JSON.stringify(r));
  assert.equal(wd.chain.txs.length, 2, 'approve + swap sent inside the focus window');
  assert.equal((await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'topup').state, 'sent');
  const wd2 = makeWorld(); await on(wd2);
  wd2.click.clickAt = Date.now() + 1;   // a trade between its call and its broadcast
  await wd2.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  assert.equal(wd2.chain.txs.length, 0, 'nothing sent while a trade runs');
});

test('a click whose lock another tab never lets go still tops up after 2 s (2026-10-27: "another tab is running the USD balance", the buy went without it)', async () => {
  let asked = null;
  const wd = makeWorld({ lock: async (k, fn, opts) => { asked = opts; return null; } }); await on(wd);
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  assert.equal(asked?.waitMs, 2_000);
  assert.ok(r.planned?.some((m) => m.kind === 'topup'), JSON.stringify(r));
  assert.equal(wd.chain.txs.length, 2, 'approve + swap sent without the lock');
  assert.equal([...wd.store.keys()].filter((k) => k.includes('clickwant')).length, 0, 'the mark is cleared');
});

test('a background tick in another tab lets the lock go when a click marks it', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 75_000_000_000_000_000n, rUsdg: 0n }); await on(wd);
  for (const k of wd.store.keys()) if (k.startsWith('trenches.float.v1.snap.')) wd.store.delete(k);
  wd.store.set('trenches.float.v1.clickwant.trench-float-' + wd.W.toLowerCase() + '-robinhood', String(Date.now()));
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'no move while a click waits');
  assert.ok(r.ok);
});

test('USDG sent straight to the trading wallet joins the USD balance: W forwards it to its own R in one transfer (quiet, or at once for a click)', async () => {
  // a click: forwarded at once even with a ticket just touched, before the plan
  const wd = makeWorld({ rUsdg: 0n }); await on(wd);
  wd.chain.usdg.set(lc(wd.W), 50_000_000n);   // 50 USDG sent to W
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 20, reason: 'click' }); await wd.settle();
  const fwd = wd.chain.txs.find((t) => lc(t.from) === lc(wd.W) && lc(t.to) === lc(C.stable.address));
  assert.ok(fwd, 'W sent one stable transfer');
  const d = decodeFunctionData({ abi: ERC20, data: fwd.data });
  assert.equal(d.functionName, 'transfer'); assert.equal(lc(d.args[0]), lc(wd.R), 'to its own R, nowhere else'); assert.equal(d.args[1], 50_000_000n);
  assert.equal(wd.chain.usdg.get(lc(wd.W)), 0n);
  // a routine tick while the user is active: nothing forwarded (the quiet rule)
  const wd2 = makeWorld({ rUsdg: 0n }); await on(wd2);
  wd2.chain.usdg.set(lc(wd2.W), 50_000_000n); wd2.click.ticketAt = Date.now();
  await wd2.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd2.settle();
  assert.equal(wd2.chain.txs.filter((t) => lc(t.from) === lc(wd2.W)).length, 0);
  // under $1: left alone
  const wd3 = makeWorld({ rUsdg: 0n }); await on(wd3);
  wd3.chain.usdg.set(lc(wd3.W), 900_000n);
  await wd3.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 20, reason: 'click' }); await wd3.settle();
  assert.equal(wd3.chain.txs.filter((t) => lc(t.from) === lc(wd3.W) && lc(t.to) === lc(C.stable.address)).length, 0);
});

test('EVM: a click its reserve R already covers (need + 25 %) is not held up by the forward of W stable (2026-11-01: up to 8 s + a gas drop in front of the top-up); it waits for a quiet tick', async () => {
  const wd = makeWorld({ rUsdg: 500_000_000n }); await on(wd);
  wd.chain.usdg.set(lc(wd.W), 50_000_000n);   // 50 USDG sent to W, R holds $500
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 20, reason: 'click' }); await wd.settle();
  assert.equal(wd.chain.txs.filter((t) => lc(t.from) === lc(wd.W) && lc(t.to) === lc(C.stable.address)).length, 0, 'no forward in front of the click');
  assert.ok(wd.chain.txs.some((t) => lc(t.from) === lc(wd.R)), 'the click top-up went from R: ' + JSON.stringify(r.planned));
  assert.equal(wd.chain.usdg.get(lc(wd.W)), 50_000_000n, 'W USDG waits for the next quiet tick');
  // R short of need + 25 % ($24 < $25): forwarded first, as before
  const short = makeWorld({ rUsdg: 24_000_000n }); await on(short);
  short.chain.usdg.set(lc(short.W), 50_000_000n);
  await short.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 20, reason: 'click' }); await short.settle();
  assert.equal(short.chain.txs.filter((t) => lc(t.from) === lc(short.W) && lc(t.to) === lc(C.stable.address)).length, 1);
});

// ── USDC sent straight to a Solana trading wallet (2026-10-27: the forward worked on EVM only) ──
const FWDKEY = (wd) => `trenches.float.v1.fwd.sol.${lc(wd.W)}`;
const solFwdWorld = (o = {}) => makeWorld({ lane: 'sol', solW: 20_000_000n, solR: 10_000_000n, solUsdc: 0n, ...o, solFwd: { wUsdc: 50_000_000n, ...(o.solFwd || {}) } });
const fwds = (wd) => wd.solCalls.filter((x) => x.kind === 'forward');
const funds = (wd) => wd.solCalls.filter((x) => x.kind === 'fundW');

test('Solana: USDC sent straight to W joins the USD balance — W forwards all of it to its own R in one transfer while quiet, W pays', async () => {
  const wd = solFwdWorld(); await on(wd); idle(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(fwds(wd).length, 1); assert.equal(fwds(wd)[0].units, 50_000_000n); assert.equal(fwds(wd)[0].id, 'w1');
  assert.equal(funds(wd).length, 0, 'W had the fee: R paid nothing');
  assert.equal(wd.sw.wUsdc, 0n); assert.equal(wd.sw.rUsdc, 50_000_000n);
  assert.equal(wd.store.get(FWDKEY(wd)), undefined, 'a landed forward is not kept');
  assert.ok(wd.events.some((e) => e.step === 'deposit' && e.state === 'done' && e.chain === 'sol'));
  // a second deposit (repeated / partial transfers): the next quiet tick forwards what W holds then
  wd.sw.wUsdc = 20_000_000n;
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.deepEqual(fwds(wd).map((x) => x.units), [50_000_000n, 20_000_000n]);
  // under $1: left alone until more arrives
  wd.sw.wUsdc = 900_000n;
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(fwds(wd).length, 2);
});

test('Solana: no forward while the user is active, nor with the USD balance off; a click forwards only when R alone cannot cover it', async () => {
  const busy = solFwdWorld(); await on(busy);   // a ticket touched just now
  await busy.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await busy.settle();
  assert.equal(fwds(busy).length, 0, 'the quiet rule');
  const off = solFwdWorld(); idle(off);
  await off.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await off.settle();
  assert.equal(fwds(off).length, 0, 'off: nothing moves');
  // a $20 click, R empty: W's USDC goes to R first, then R tops W up from it
  const click = solFwdWorld(); await on(click);
  await click.f.ensure({ walletId: 'w1', chain: 'sol', usd: 20, reason: 'click' }); await click.settle();
  assert.equal(fwds(click).length, 1, 'forwarded at once for the click');
  const iF = click.solCalls.findIndex((x) => x.kind === 'forward'), iT = click.solCalls.findIndex((x) => x.kind === 'topup');
  assert.ok(iT > iF, 'the top-up came after the forward: ' + JSON.stringify(click.solCalls.map((x) => x.kind)));
  // R holds $300: the click is not held up by a forward (it waits for the next quiet tick)
  const rich = solFwdWorld({ solUsdc: 300_000_000n }); await on(rich);
  await rich.f.ensure({ walletId: 'w1', chain: 'sol', usd: 20, reason: 'click' }); await rich.settle();
  assert.equal(fwds(rich).length, 0);
});

test('Solana: W without SOL — R pays W exactly the fee (and R\'s new USDC account rent) first, then W forwards; neither has SOL: nothing', async () => {
  const wd = solFwdWorld({ solW: 0n }); await on(wd); idle(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  const need = F.solFwdFee(F.SOL_FWD.units, F.SOL_FWD.micro) + F.SOL_FWD.ataRent + F.SOL_FWD.rentMin;
  assert.deepEqual(wd.solCalls.filter((x) => x.kind === 'fundW' || x.kind === 'forward').map((x) => x.kind), ['fundW', 'forward']);
  assert.equal(funds(wd)[0].lamports, need); assert.ok(need <= F.SOL_FWD.fundMax);
  assert.equal(wd.sw.rUsdc, 50_000_000n); assert.equal(wd.sw.wLam, F.SOL_FWD.rentMin, 'W ends rent-exempt, nothing more');
  // the plan itself: R's USDC account exists (it holds USDC) → no rent; R too poor → nobody pays
  assert.deepEqual(F.solForwardPlan({ wLamports: 20_000_000n, rLamports: 0n, rStable: 1n }), { pay: 'w', cost: F.solFwdFee(F.SOL_FWD.units, F.SOL_FWD.micro) });
  assert.equal(F.solForwardPlan({ wLamports: 0n, rLamports: 10_000_000n, rStable: 5n }).lamports, F.solFwdFee(F.SOL_FWD.units, F.SOL_FWD.micro) + F.SOL_FWD.rentMin);
  assert.equal(F.solForwardPlan({ wLamports: 0n, rLamports: 1_000_000n, rStable: 0n }).pay, 'none');
  const none = solFwdWorld({ solW: 0n, solR: 0n }); await on(none); idle(none);
  await none.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await none.settle();
  assert.equal(none.solCalls.filter((x) => x.kind === 'fundW' || x.kind === 'forward').length, 0, 'no SOL anywhere: the USDC waits in W');
});

test('Solana: idempotent — a forward in flight, an unknown send or a landed failure is never sent again blind; a dead blockhash is forgotten', async () => {
  // in flight: the signature reads nothing yet
  const wd = solFwdWorld({ solFwd: { st: () => null } }); await on(wd); idle(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(fwds(wd).length, 1); assert.equal(JSON.parse(wd.store.get(FWDKEY(wd))).sig, 'sigf1');
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(fwds(wd).length, 1, 'followed, not sent twice');
  // it lands: forgotten, nothing re-sent (the chain moved it)
  wd.sw.st = () => 'confirmed'; wd.sw.wUsdc = 0n; wd.sw.rUsdc = 50_000_000n;
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(fwds(wd).length, 1); assert.equal(wd.store.get(FWDKEY(wd)), undefined);
  // every road went silent: the signature the send carries is followed the same way
  const unk = solFwdWorld({ solFwd: { st: () => null, throwFwd: Object.assign(new Error('No node confirmed it'), { name: 'SolSendUnknown', hash: 'sigU' }) } }); await on(unk); idle(unk);
  await unk.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await unk.settle();
  assert.equal(JSON.parse(unk.store.get(FWDKEY(unk))).sig, 'sigU');
  unk.sw.throwFwd = null;
  await unk.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await unk.settle();
  assert.equal(fwds(unk).length, 1, 'no second send while the unknown one may land');
  // its blockhash is dead (over SOL_FWD.settleMs, still nothing): forgotten, sent again
  unk.store.set(FWDKEY(unk), JSON.stringify({ sig: 'sigU', at: Date.now() - F.SOL_FWD.settleMs - 1 }));
  await unk.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await unk.settle();
  assert.equal(fwds(unk).length, 2);
  // landed and failed: the next try waits SOL_FWD.retryMs
  const bad = solFwdWorld({ solFwd: { st: () => 'failed' } }); await on(bad); idle(bad);
  await bad.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await bad.settle();
  assert.ok(JSON.parse(bad.store.get(FWDKEY(bad))).failedAt);
  await bad.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await bad.settle();
  assert.equal(fwds(bad).length, 1, 'no retry inside the back-off');
  // R's funding is followed the same way: W is never paid twice for one forward
  const fund = solFwdWorld({ solW: 0n, solFwd: { st: () => null } }); await on(fund); idle(fund);
  await fund.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await fund.settle();
  await fund.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await fund.settle();
  assert.equal(funds(fund).length, 1); assert.equal(fwds(fund).length, 0, 'W forwards only once its fee landed');
});

test('Solana: a host without the forward dep reads no W USDC and sends nothing (older hosts; the EVM forward is unchanged)', async () => {
  const wd = makeWorld({ lane: 'sol', solW: 20_000_000n, solUsdc: 0n }); await on(wd); idle(wd);
  assert.equal(wd.deps.sol.forward, undefined);
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await wd.settle();
  assert.equal(wd.solCalls.filter((x) => x.kind === 'forward' || x.kind === 'fundW').length, 0);
  assert.equal(JSON.parse(wd.store.get(`trenches.float.v1.snap.sol.${lc(wd.W)}`)).wStable, undefined);
});

test('sweep: only while quiet (no trade / ticket touch for 10 s); W sends one router call that pays R in USDG ≥ the floor', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 75_000_000_000_000_000n, rUsdg: 0n }); await on(wd);   // W ≈ $300 ready
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'a ticket touched just now: nothing');
  await assert.rejects(wd.f.sweep({ walletId: 'w1', chain: 'robinhood' }), /Not now/);
  idle(wd);
  const r = await wd.f.sweep({ walletId: 'w1', chain: 'robinhood' });
  assert.equal(wd.chain.txs.length, 1); const t = wd.chain.txs[0];
  assert.equal(lc(t.from), lc(wd.W));
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: decodeFunctionData({ abi: ROUTER_ABI, data: t.data }).args[1][0] });
  assert.equal(lc(inner.args[0].recipient), lc(wd.R));
  assert.ok(wd.chain.usdg.get(lc(wd.R)) > 200_000_000n);
  assert.ok(r.planned.some((m) => m.kind === 'sweep'));
});

test('a lost answer is never re-sent: the job keeps the hash, the next tick only looks the receipt up', async () => {
  const wd = makeWorld({ lose: true, loseAt: 1 }); await on(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  const n = wd.chain.txs.length;
  let jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  assert.equal(jobs[0].state, 'sent'); assert.equal(jobs[0].hashes.length, 2);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  assert.equal(wd.chain.txs.length, n, 'nothing new sent while that job is open');
  jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  assert.equal(jobs.find((j) => j.kind === 'topup').state, 'arrived');
});

test('idempotent ensure: a burst of triggers is one tick and one job', async () => {
  const wd = makeWorld({ wEth: C.gasFloor }); await on(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'preset', presets: [25, 50] });
  const r2 = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'page' });
  assert.equal(r2.joined, true);
  await wd.settle();
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'topup');
  assert.equal(jobs.length, 1);
  assert.equal(wd.chain.txs.filter((t) => lc(t.to) === lc(C.router)).length, 1);
});

// the Solana frame's snapshot as that frame would have written it: a float short, no USDC there
const solSnap = (wd, over = {}) => wd.store.set(`trenches.float.v1.snap.sol.${lc(wd.W)}`, JSON.stringify({ at: Date.now(), chain: 'sol', price6: String(100n * F.USD), priceAt: Date.now(), float: '20000000', reserve: '0', reserveNative: '10000000', inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [], ...over }));

test('rebalance: Robinhood\'s reserve funds Solana\'s through Relay — exact approval, a deposit naming R as depositor, followed to arrival', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n }); await on(wd);   // RH float is full ($80): only SOL needs money
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  const j = jobs.find((x) => x.kind === 'rebalance');
  assert.ok(j, JSON.stringify(jobs)); assert.equal(j.from, 'robinhood'); assert.equal(j.chain, 'sol'); assert.equal(j.bridge, 'relay'); assert.equal(j.state, 'relaying');
  assert.equal(wd.chain.deposits.length, 1); assert.equal(lc(wd.chain.deposits[0].from), lc(wd.R)); assert.equal(wd.chain.deposits[0].amount, 100_000_000n);
  assert.ok(wd.fetchLog.some((u) => u.includes('/requests/v2?user=' + wd.R)), 'checked other devices first');
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal((await wd.f.jobs({ walletId: 'w1' })).jobs.find((x) => x.kind === 'rebalance').state, 'arrived');
  keyScan(wd, jobs);
});

test('failover before the send: a Relay quote naming another depositor is refused and deBridge carries the move; all refused = nothing sent', async () => {
  // (the old $2/day fee cap that stopped deBridge is gone, owner 2026-10-27)
  const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, relayDepositor: '0x' + '66'.repeat(20) }); await on(wd, { feesPerDay: 10 });
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const j = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((x) => x.kind === 'rebalance');
  assert.equal(j.bridge, 'debridge'); assert.deepEqual(j.tried, ['relay', 'debridge']);
  assert.equal(wd.chain.deposits[0].bridge, 'debridge'); assert.equal(wd.chain.deposits[0].amount, 100_000_000n, 'exact approval = exact amount');
});

test('another device started a move to that chain in the last 2 minutes: deferred, nothing sent', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, relayRecent: true }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0);
  assert.ok(!(await wd.f.jobs({ walletId: 'w1' })).jobs.some((x) => x.kind === 'rebalance'));
});

// ── Relay wants a key (2026-10-29, owner «USD-баланс: перевести его запросы к Relay на схему с ключом … делай тоже») ──
// (audit 2026-11-01, vault-security-relay-recipient) Relay pays out to the recipient in ITS record for the request id, which
// the vault cannot read before the deposit; a quote relayed by motion's server names the recipient only in the server's
// own JSON. So a keyed Relay is never signed through motion: the move goes to the next bridge, the pass-through is never
// even asked. An honest-looking relayed quote (details name this wallet, the server's record may not) is exactly the attack.
test('keyed Relay: a quote motion would relay is never fetched or signed (its recipient is unverifiable); the next bridge carries the move', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, relayKeyed: true }); await on(wd);
  solSnap(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const j = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((x) => x.kind === 'rebalance');
  assert.ok(wd.fetchLog.includes('https://api.relay.link/quote/v2'), 'keyless Relay is still asked first');
  assert.ok(!wd.fetchLog.includes(PROXY + '/api/bridge/vault-quote'), 'the pass-through is never asked for a quote');
  assert.ok(!wd.chain.deposits.some((d) => d.bridge === 'relay'), 'nothing went to Relay');
  assert.ok(!wd.chain.txs.some((t) => lc(t.to) === lc(DEPOSITORY) || String(t.data).toLowerCase().includes(DEPOSITORY.slice(2))), "nothing signed toward Relay's depository");
  assert.ok(j, 'the move still runs'); assert.notEqual(j.bridge, 'relay'); assert.ok(j.tried.includes('relay'));
});
for (const [tamper, why] of [['recipient', 'pays someone else'], ['approve-unlimited', 'asks for an unlimited approval'], ['approve-spender', 'approves another contract'], ['depository', 'deposits to another contract'], ['cheap', "pays under Relay's own price"]]) {
  test(`keyed Relay: a relayed quote that ${why} is refused before anything is signed for Relay (the next bridge carries the move)`, async () => {
    const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, relayKeyed: true, proxyTamper: tamper }); await on(wd);
    solSnap(wd);
    await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
    const j = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((x) => x.kind === 'rebalance');
    assert.ok(!wd.chain.deposits.some((d) => d.bridge === 'relay'), 'nothing went to Relay');
    assert.ok(!wd.chain.txs.some((t) => /(77){20}|(78){20}/.test(String(t.data)) || /^0x(78){20}$/.test(lc(t.to))), 'nothing signed toward the tampered contracts');
    assert.ok(j, 'the move still runs on another bridge'); assert.notEqual(j.bridge, 'relay'); assert.ok(j.tried.includes('relay'));
  });
}
test('keyed Relay: when requests/v2 is gone the other-device check reads motion\'s pass-through — only rows naming this reserve count', async () => {
  const other = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, requestsGone: true, proxyRows: [{ user: '0x' + '55'.repeat(20) }] }); await on(other);
  solSnap(other);
  await other.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await other.settle();
  assert.ok(other.fetchLog.some((u) => lc(u).startsWith(lc(PROXY + '/api/bridge/vault-requests?user=' + other.R))));
  assert.equal(other.chain.deposits.length, 1, "a row of another wallet does not defer this move");
  const mine = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n, requestsGone: true, proxyRows: (u) => [{ user: u }] }); await on(mine);
  solSnap(mine);
  await mine.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await mine.settle();
  assert.equal(mine.chain.txs.length, 0, "a recent move of this reserve (another device) defers: nothing sent");
});

test('Solana frame: the same-chain top-up hands the vault its floor (≥ the oracle floor), from R, one transaction', async () => {
  const wd = makeWorld({ lane: 'sol', solW: 20_000_000n, solUsdc: 300_000_000n }); await on(wd);
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' });
  assert.ok(r.jobId, JSON.stringify(r));
  const c = wd.solCalls.find((x) => x.kind === 'topup');
  const floor = F.minOutFloor('stable→native', c.usdcIn, 100n * F.USD, 'sol', 50, F.usd6(r.planned[0].fee));
  assert.equal(c.minLamports, floor);
  assert.equal(c.usdcIn, F.usd6ToStable(F.usd6(r.planned[0].usd), 6));
});

test('only this frame\'s moves run here: a Solana top-up planned in the Robinhood frame is reported, not executed', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 20_000_000_000_000_000n }); await on(wd);
  solSnap(wd, { reserve: '300000000' });   // SOL has its own USDC: its frame will top up locally
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 30, reason: 'click' });
  const t = r.planned.find((m) => m.chain === 'sol');
  assert.equal(t.kind, 'topup'); assert.equal(t.runsOn, 'sol');
  assert.equal(wd.chain.txs.length, 0);
});

test('the vault builds the calldata itself: the top-up pays W and nothing else', () => {
  const data = topupCalldata(C, 50_000_000n, 1n, '0x' + '12'.repeat(20), 1n);
  const outer = decodeFunctionData({ abi: ROUTER_ABI, data });
  assert.equal(outer.args[1].length, 2);
  const swap = decodeFunctionData({ abi: ROUTER_ABI, data: outer.args[1][0] }).args[0];
  assert.equal(lc(swap.recipient), '0x0000000000000000000000000000000000000002');
  assert.equal(lc(swap.tokenIn), lc(C.stable.address)); assert.equal(lc(swap.tokenOut), lc(C.wrapped)); assert.equal(swap.fee, 100);
});

// ── switch on = convert now, switch off = convert back, later deposits convert themselves (owner, 2026-10-26) ──
const BSC = F.FLOAT_CFG.bsc, SOLC = F.FLOAT_CFG.sol;
const bscSnap = (wd, over = {}) => wd.store.set(`trenches.float.v1.snap.bsc.${lc(wd.W)}`, JSON.stringify({ at: Date.now(), chain: 'bsc', price6: String(F.usd6(742.31)), priceAt: Date.now(), float: String(BSC.gasFloor + 1_560_000_000_000_000_000n), reserve: '0', reserveNative: String(BSC.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [], ...over }));
const orderOf = (wd, kind, chain) => JSON.parse(wd.store.get(`trenches.float.v1.order.${kind}.${chain}.${lc(wd.W)}`) || 'null');
const ETH_HALF = 500_000_000_000_000_000n;

test('switch on = convert now: the dialog states every chain\'s amount; this frame sweeps its native to R at once — exempt from the day cap and the quiet rule; the other chains wait for their own frames', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + ETH_HALF, rUsdg: 0n });   // W: 0.5 ETH above the gas floor ($2,000)
  bscSnap(wd);                                                         // the BNB frame read 1.56 BNB above its floor at $742.31
  solSnap(wd, { float: String(SOLC.gasFloor + 1_000_000_000n) });     // Solana: active, $75 target, 1 SOL above the floor at $100
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'], caps: { perDay: 50 } });
  assert.equal(wd.asks.length, 1); assert.equal(wd.gates(), 1);
  const html = wd.asks[0].html;
  assert.equal(leadOf(html), 'Convert $3,183 to dollars');
  assert.deepEqual(rowsOf(html), [['Wallet 1', ['0.50 ETH → USDG', '1.56 BNB → USDC', '0.25 SOL → USDC'], '$3,183']]);
  assert.equal(skipOf(html), '');
  assert.equal(noteOf(html), 'A little ETH / BNB / SOL stays on each chain so trades stay instant. Deposits later convert by themselves.');
  assert.match(html, /<li>no daily or volume limits, only what your reserves hold;/, 'the standing permission is still stated'); assert.ok(!/\$50\.00 a day/.test(html), 'no volume cap is stated');
  assert.deepEqual(r.convert.planned.map((p) => [p.chain, p.amount, p.to, p.runsOn]), [['robinhood', '0.50 ETH', 'USDG', 'robinhood'], ['bsc', '1.56 BNB', 'USDC', 'bsc'], ['sol', '0.25 SOL', 'USDC', 'sol']]);
  assert.equal(wd.chain.txs.length, 0, 'nothing is signed inside configure');
  const st0 = await wd.f.status({ walletId: 'w1' });
  assert.deepEqual(st0.orders.map((o) => [o.kind, o.chain, o.amount]), [['on', 'robinhood', '0.50 ETH'], ['on', 'bsc', '1.56 BNB'], ['on', 'sol', '0.25 SOL']]);
  // the frame ticks (the app asks right after the switch): ONE router call from W, the whole $2,000 although the day cap
  // is $50 and the ticket was touched a moment ago (the quiet rule does not hold)
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 1); const t = wd.chain.txs[0];
  assert.equal(lc(t.from), lc(wd.W)); assert.equal(t.value, ETH_HALF);
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: decodeFunctionData({ abi: ROUTER_ABI, data: t.data }).args[1][0] });
  assert.equal(lc(inner.args[0].recipient), lc(wd.R), 'paid to R');
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'sweep');
  assert.equal(job.confirmed, 'on'); assert.equal(job.reason, 'switch on'); assert.equal(job.state, 'sent'); assert.equal(job.usd6, String(F.usd6(2000)));
  assert.equal(inner.args[0].amountOutMinimum, F.minOutFloor('native→stable', ETH_HALF, 4000n * F.USD, 'robinhood', 50, BigInt(job.fee6)), 'the oracle floor with maxSlipBps');
  assert.ok(wd.chain.usdg.get(lc(wd.R)) >= BigInt(job.minOut));
  assert.equal(wd.chain.eth.get(lc(wd.W)), C.gasFloor, 'W keeps its gas floor (an inactive chain has no trading target)');
  assert.equal(F.ledgerOf((await wd.f.jobs({ walletId: 'w1' })).jobs, Date.now()).movedToday6, 0n, 'not counted against the day cap');
  assert.equal(orderOf(wd, 'on', 'robinhood'), null, 'done here');
  assert.ok(orderOf(wd, 'on', 'bsc') && orderOf(wd, 'on', 'sol'), 'BNB and Solana convert in their own frames');
  assert.ok(wd.events.some((e) => e.step === 'sweep' && e.confirmed === 'on' && e.amount === '0.50 ETH'));
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 1, 'never twice');
  keyScan(wd, [r, st0]);
});

test('switch on keeps the trading target in W, waits while a trade runs, and a later caps change converts nothing', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + ETH_HALF, rUsdg: 0n });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'lane' });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'preset', presets: [50] }); await wd.settle();
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.deepEqual(rowsOf(wd.asks[0].html), [['Wallet 1', ['0.4812 ETH → USDG'], '$1,925']], 'a $75 target (1.5 × $50) stays');
  wd.click.clickAt = Date.now() + 1;   // a trade between its call and its broadcast
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'no conversion while a trade runs'); assert.ok(orderOf(wd, 'on', 'robinhood'));
  wd.click.clickAt = Date.now() - 4_000; wd.click.clickDoneAt = Date.now() - 3_000;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 1);
  assert.equal(wd.chain.eth.get(lc(wd.W)), C.gasFloor + 18_750_000_000_000_000n, 'W keeps the gas floor + $75 of ETH');
  // a deposit, then a caps raise: the dialog again, but no conversion is ordered (only switching ON converts now)
  wd.chain.eth.set(lc(wd.W), wd.chain.eth.get(lc(wd.W)) + ETH_HALF);
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'], caps: { perDay: 2000 } });
  assert.equal(wd.asks.length, 2); assert.doesNotMatch(wd.asks[1].html, /ub-r/);
  assert.match(wd.asks[1].html, /^<p class="ub-lead">Your limits change to the ones below\. Nothing is converted\.<\/p><div class="ub-open">/, 'what it changes, then the consent laid open');
  assert.equal(orderOf(wd, 'on', 'robinhood'), null);
});

test('switch on: the price check still binds (the pool 2 % under the oracle: nothing sent, the order waits for another try); a chain with no fresh price is skipped and said so', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + ETH_HALF, rUsdg: 0n, skewBps: 200 });   // the pool pays 2 % fewer dollars per ETH than the oracle
  bscSnap(wd, { priceAt: Date.now() - 120_000 });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc'] });
  assert.deepEqual(rowsOf(wd.asks[0].html), [['Wallet 1', ['0.50 ETH → USDG'], '$2,000']]); assert.equal(skipOf(wd.asks[0].html), 'BNB price not read yet (converts later)');
  assert.equal(orderOf(wd, 'on', 'bsc'), null, 'nothing ordered for a chain without a fresh price');
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'sweep');
  assert.equal(job.state, 'failed'); assert.match(job.error, /below the oracle|Too little received/);
  assert.equal(wd.chain.txs.length, 0); assert.equal(wd.chain.eth.get(lc(wd.W)), C.gasFloor + ETH_HALF, 'W untouched');
  assert.equal(orderOf(wd, 'on', 'robinhood').tries, 1, 'kept for a later try (at most 3)');
});

test('a later deposit converts itself once the chain is quiet (60 s): $3,000 arriving is swept in one go (not trimmed by a $50 day cap); never while a trade runs', async () => {
  const wd = makeWorld({ wEth: C.gasFloor, rUsdg: 0n }); await on(wd, { perDay: 50 });
  wd.chain.eth.set(lc(wd.W), C.gasFloor + 750_000_000_000_000_000n);   // 0.75 ETH ($3,000) lands in W
  wd.click.lastTradeAt = Date.now() - 30_000; wd.click.ticketAt = Date.now() - 61_000;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'a trade 30 s ago: not quiet yet');
  wd.click.lastTradeAt = Date.now() - 61_000;
  wd.click.clickAt = Date.now() + 1;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'a trade is running: nothing');
  wd.click.clickAt = 0;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 1);
  const job = (await wd.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'sweep');
  assert.equal(job.confirmed, undefined); assert.equal(job.state, 'sent');
  assert.ok(BigInt(job.usd6) >= F.usd6(2999.99), job.usd6);
  assert.ok(wd.chain.usdg.get(lc(wd.R)) > 2_990_000_000n);
});

test('switch off = convert back: the dialog states the dollars; W pays R its gas first, then R\'s USDG becomes W\'s ETH (exempt from the caps); only then is the permission dropped', async () => {
  const wd = makeWorld({ wEth: C.gasFloor + 10_000_000_000_000_000n, rEth: 0n, rUsdg: 500_000_000n }); await on(wd, { perDay: 50 });
  const w0 = wd.chain.eth.get(lc(wd.W));
  const r = await wd.f.off({ walletId: 'w1' });
  assert.equal(wd.asks.length, 2); assert.equal(wd.asks[1].title, 'Turn off USD balance'); assert.equal(wd.gates(), 2);
  const html = wd.asks[1].html;
  assert.equal(leadOf(html), 'Convert $500 back to ETH'); assert.deepEqual(rowsOf(html), [['Wallet 1', ['$500.00 USDG → ETH'], '$500']]);
  assert.equal(skipOf(html), 'BNB and Solana not read yet (converts back when you turn off with it open)');
  assert.equal(noteOf(html), 'Each swap is checked against the on-chain price (slippage at most 0.50 %). A little gas stays in each reserve.');
  // W → R gas (R had none), R's exact approval, R's swap paying W
  assert.deepEqual(wd.chain.txs.map((t) => lc(t.from)), [lc(wd.W), lc(wd.R), lc(wd.R)]);
  assert.equal(wd.chain.txs[0].value, C.reserveGas); assert.equal(lc(wd.chain.txs[0].to), lc(wd.R));
  assert.equal(wd.chain.usdg.get(lc(wd.R)), 0n, 'every USDG converted ($500, ten times the day cap)');
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  const top = jobs.find((j) => j.kind === 'topup'); assert.equal(top.confirmed, 'off'); assert.equal(top.amountIn, '500000000');
  assert.ok(wd.chain.eth.get(lc(wd.W)) - w0 + C.reserveGas >= BigInt(top.minOut), 'W got ≥ the oracle floor');
  assert.equal(wd.chain.eth.get(lc(wd.R)), C.reserveGas, 'R keeps its own gas');
  assert.deepEqual(r.chains.map((c) => [c.chain, c.state]), [['robinhood', 'sent'], ['bsc', 'kept'], ['sol', 'kept']]);
  assert.equal((await wd.f.status({ walletId: 'w1' })).enabled, false);
  keyScan(wd, [r, jobs]);
});

test('switch off with a failing chain: still turned off; the answer says which chain kept its USD and why; another chain\'s conversion waits for its frame', async () => {
  const wd = makeWorld({ rUsdg: 500_000_000n, skewBps: -200 }); await on(wd);
  bscSnap(wd, { reserve: String(100n * 10n ** 18n) });   // $100 USDC in R on BNB
  solSnap(wd, { reserve: '0' });
  const r = await wd.f.off({ walletId: 'w1' });
  assert.equal(leadOf(wd.asks[1].html), 'Convert $600 back to ETH / BNB'); assert.deepEqual(rowsOf(wd.asks[1].html), [['Wallet 1', ['$500.00 USDG → ETH', '$100.00 USDC → BNB'], '$600']]);
  const rh = r.chains.find((c) => c.chain === 'robinhood');
  assert.equal(rh.state, 'kept'); assert.match(rh.why, /below the oracle|Too little received/); assert.equal(rh.usd, 500);
  assert.deepEqual(r.pending, ['bsc']);
  assert.equal(wd.chain.usdg.get(lc(wd.R)), 500_000_000n, 'nothing moved on Robinhood');
  assert.equal(wd.chain.txs.filter((t) => lc(t.to) === lc(C.router)).length, 0);
  const st = await wd.f.status({ walletId: 'w1' });
  assert.equal(st.enabled, false, 'turned off anyway');
  assert.deepEqual(st.orders.map((o) => [o.kind, o.chain, o.amount, o.to]), [['off', 'bsc', '$100.00 USDC', 'BNB']]);
  assert.equal(orderOf(wd, 'off', 'robinhood'), null, 'a refusal is reported, not retried behind the user\'s back');
  assert.ok(wd.events.some((e) => e.step === 'off' && e.state === 'failed' && e.chain === 'robinhood'));
});

test('switch off with nothing to convert back: one tap, no dialog (as before)', async () => {
  const wd = makeWorld({ rUsdg: 0n }); await on(wd);
  const r = await wd.f.off({ walletId: 'w1' });
  assert.equal(wd.asks.length, 1, 'only the switch-on dialog'); assert.equal(wd.chain.txs.length, 0);
  assert.equal((await wd.f.status({ walletId: 'w1' })).enabled, false); assert.ok(r.ok);
});

test('Solana frame: switch on sweeps SOL → USDC paying R the oracle floor; switch off sells R\'s USDC for SOL paying W, one transaction each', async () => {
  const on1 = makeWorld({ lane: 'sol', solW: SOLC.gasFloor + 5_000_000_000n, solUsdc: 0n });
  await on1.f.configure({ walletId: 'w1', chains: ['sol'] });
  assert.deepEqual(rowsOf(on1.asks[0].html), [['Wallet 1', ['5.00 SOL → USDC'], '$500']]);
  await on1.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await on1.settle();
  const sw = on1.solCalls.find((x) => x.kind === 'sweep');
  assert.equal(sw.l, 5_000_000_000n);
  const job = (await on1.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'sweep');
  assert.equal(sw.m, F.minOutFloor('native→stable', 5_000_000_000n, 100n * F.USD, 'sol', 50, BigInt(job.fee6)));
  const off1 = makeWorld({ lane: 'sol', solUsdc: 300_000_000n }); await on(off1);
  const r = await off1.f.off({ walletId: 'w1' });
  assert.equal(leadOf(off1.asks[1].html), 'Convert $300 back to SOL');
  const tp = off1.solCalls.find((x) => x.kind === 'topup');
  assert.equal(tp.usdcIn, 300_000_000n, 'the exact stated amount');
  const top = (await off1.f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'topup');
  assert.equal(tp.minLamports, F.minOutFloor('stable→native', 300_000_000n, 100n * F.USD, 'sol', 50, BigInt(top.fee6)));
  assert.equal(off1.solCalls.filter((x) => x.kind === 'gas').length, 0, 'R had its gas: none sent');
  assert.equal(r.chains[0].state, 'sent');
});

test('click with R out of gas and W at its floor (owner 2026-10-27): W gives R its gas, it lands, then R tops W up — in the same click, not held by the quiet rule', async () => {
  const wd = makeWorld({ wEth: C.gasFloor - 11_000_000_000n, rEth: 0n }); await on(wd);
  wd.click.lastTradeAt = Date.now(); wd.click.ticketAt = Date.now();   // the user is clicking: not quiet
  const before = wd.chain.eth.get(lc(wd.W));
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 10, reason: 'click' }); await wd.settle();
  assert.equal(r.ok, true, JSON.stringify(r));
  const kinds = r.planned.map((m) => m.kind);
  assert.ok(kinds.includes('gas'), kinds.join(','));
  const fromW = wd.chain.txs.filter((t) => lc(t.from) === lc(wd.W)); const fromR = wd.chain.txs.filter((t) => lc(t.from) === lc(wd.R));
  assert.equal(fromW.length, 1, 'one gas transfer from W'); assert.equal(lc(fromW[0].to), lc(wd.R));
  assert.ok(fromR.length >= 1, 'R signed its top-up after its gas landed');
  assert.ok(wd.chain.eth.get(lc(wd.W)) > before, 'W got ETH back from the dollars');
});

// ── speed of a Solana click's top-up (2026-10-28: "SOL ready — buying" ~12 s after the tap) ──
test('Solana click: the app\'s hold & fire reads afresh on every ask while the click\'s top-up lands (no 3 s snapshot reuse); without one, the reuse stands', async () => {
  const wd = makeWorld({ lane: 'sol', solW: 20_000_000n, solUsdc: 300_000_000n }); await on(wd);
  let reads = 0; const bal = wd.deps.sol.balance; wd.deps.sol.balance = async (a) => { reads += 1; return bal(a); };
  // no click move: two asks right after each other cost one read at most
  await wd.f.status({ walletId: 'w1', fresh: true }); const r0 = reads;
  await wd.f.status({ walletId: 'w1', fresh: true });
  assert.equal(reads, r0, 'a snapshot under 3 s old is reused');
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' });
  assert.ok(r.jobId, JSON.stringify(r));
  for (let i = 0; i < 3; i++) { const before = reads; await wd.f.status({ walletId: 'w1', scope: 'account', fresh: true }); assert.ok(reads > before, 'ask ' + i + ' read the chain'); }
});

test('Solana click: R holding 0.003 SOL (motion\'s drop) swaps for the click at once — no W → R gas send in front of it', async () => {
  const wd = makeWorld({ lane: 'sol', solW: 100_000_000n, solUsdc: 300_000_000n, solFwd: { wUsdc: 0n }, solR: F.SOL_GAS.drop }); await on(wd);
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' });
  assert.deepEqual(wd.solCalls.map((x) => x.kind), ['topup'], JSON.stringify(r));
});

test('Solana click: R without the SOL for its swap gets W\'s gas first, looked for every 300 ms (was 1 s) until it lands, then the top-up', async () => {
  let looks = 0;
  const wd = makeWorld({ lane: 'sol', solW: 100_000_000n, solUsdc: 300_000_000n, solFwd: { wUsdc: 0n, st: (sig) => (sig === 'sigg' ? (++looks > 3 ? 'confirmed' : null) : 'confirmed') }, solR: 0n }); await on(wd);
  const waits = []; wd.deps.wait = async (ms) => { waits.push(ms); };
  const r = await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' });
  assert.deepEqual(wd.solCalls.map((x) => x.kind), ['gas', 'topup'], JSON.stringify(r));
  assert.equal(looks, 4);
  assert.deepEqual(waits.filter((ms) => ms >= 300), [300, 300, 300]);
});

test('a click reconciles every open job at once (each a status read), not one after another', async () => {
  const wd = makeWorld({ lane: 'sol', solW: 20_000_000n, solUsdc: 300_000_000n }); await on(wd);
  const at = Date.now() - 20_000;
  wd.store.set('trenches.float.v1.jobs.sol.' + lc(wd.W), JSON.stringify(['a', 'b'].map((x) => ({ id: 'old-' + x, walletId: 'w1', kind: 'topup', chain: 'sol', usd6: '5000000', fee6: '1000', state: 'sent', at, updatedAt: at, hashes: ['sig-' + x], reason: 'click', click: true }))));
  let now = 0, most = 0;
  wd.deps.sol.status = async () => { now += 1; most = Math.max(most, now); await new Promise((ok) => setTimeout(ok, 20)); now -= 1; return 'confirmed'; };
  await wd.f.ensure({ walletId: 'w1', chain: 'sol', usd: 50, reason: 'click' });
  assert.equal(most, 2, 'both looked up side by side');
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs;
  assert.deepEqual(jobs.filter((j) => j.id.startsWith('old-')).map((j) => j.state), ['arrived', 'arrived']);
});

test('the Solana wiring: the pinned pool route is kept 3 s (the swap reads its pool and bins fresh), and a landed verdict comes from the first road that has one', () => {
  const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const memoAt = WE.indexOf('const solFloatPool = () => {'); assert.ok(memoAt > 0);
  const memo = WE.slice(memoAt, WE.indexOf('\n};', memoAt));
  assert.match(memo, /Date\.now\(\) - solFloatPoolMemo\.at < 3_000/);
  assert.match(memo, /m\.p\.catch\(\(\) => \{ if \(solFloatPoolMemo === m\) solFloatPoolMemo = null; \}\)/, 'a failed read is not kept');
  const i = WE.indexOf('    status: (sig) => floatQuiet(() => new Promise'); assert.ok(i > 0);
  const st = WE.slice(i, WE.indexOf('    })),', i));
  // the quick road decides only on a confirmed / finalized answer; anything else is the old answer of both roads, with history
  assert.match(st, /getSignatureStatuses', \[\[sig\], \{ searchTransactionHistory: false \}\]\)[\s\S]*if \(st && \(st\.confirmationStatus === 'confirmed' \|\| st\.confirmationStatus === 'finalized'\)\) end\(verdict\(st\)\)/);
  assert.match(st, /solSigStatusesBoth\(\[sig\]\)\.then\(\(\[st\]\) => end\(verdict\(st\)\)/);
});
