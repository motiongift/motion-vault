// rel-12 (2026-11-06): a Robinhood frame (the donor of ready dollars) on a mocked chain, with BNB Chain as the traded destination.
// Relay / deBridge answer like their public APIs; the Relay quote is shaped by the test: its stated fee, how far the delivery is
// under "amount - stated fee" (the 0.156 % measured on BNB -> Robinhood), how long it takes, or a refusal. A virtual clock moves
// the vault's time (the back-off); setTimeout stays real (the quote clocks).
import { decodeFunctionData, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../../src/floatEngine.ts';
import * as F from '../../src/floatCore.ts';
import { setRelayProxyBase } from '../../src/relayApi.ts';
setRelayProxyBase(() => 'https://motion.test');

export const lc = (a) => String(a).toLowerCase();
export const RH = F.FLOAT_CFG.robinhood, BSCC = F.FLOAT_CFG.bsc;
export const usdg = (usd) => BigInt(Math.round(usd * 1e6));
export const usdcBsc = (usd) => BigInt(Math.round(usd * 1e6)) * 10n ** 12n;
export const ERC20 = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const RELAY_ABI = [{ name: 'depositErc20', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'depositor', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'id', type: 'bytes32' }], outputs: [] }];
export const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const ETH6 = 4000n * F.USD, BNB6 = 1000n * F.USD;

export function readyWorld(o = {}) {
  const T = { t: Date.UTC(2026, 10, 6, 12, 0, 0) };
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
  const ch = { eth: new Map([[lc(W), RH.gasFloor + 20_000_000_000_000_000n], [lc(R), RH.reserveGas]]), usdg: new Map([[lc(R), o.rUsdg ?? usdg(500)]]), allow: new Map(), receipts: new Map(), txs: [], deposits: [], n: 0 };
  const exec = (from, tx, apply) => {
    const to = lc(tx.to);
    if (to === lc(RH.stable.address)) { const d = decodeFunctionData({ abi: ERC20, data: tx.data }); if (d.functionName === 'approve' && apply) ch.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]); return '0x' + '1'.padStart(64, '0'); }
    if (to === DEPOSITORY) {
      if (ch.revertDeposit) throw new Error('execution reverted: test deposit');
      const d = decodeFunctionData({ abi: RELAY_ABI, data: tx.data }); const al = ch.allow.get(`${lc(from)}>${DEPOSITORY}`) ?? 0n;
      if (al < d.args[2]) throw new Error('execution reverted: allowance');
      if (apply) { ch.allow.set(`${lc(from)}>${DEPOSITORY}`, al - d.args[2]); ch.usdg.set(lc(from), ch.usdg.get(lc(from)) - d.args[2]); ch.deposits.push({ bridge: 'relay', from, amount: d.args[2] }); }
      return '0x';
    }
    throw new Error('test: unexpected call to ' + tx.to);
  };
  const send = (from, tx) => { const hash = keccak256(toHex(`${from}:${ch.n++}:${tx.data}`)); let status = 'success'; try { exec(from, tx, true); } catch { status = 'reverted'; } ch.txs.push({ from, ...tx, hash }); ch.receipts.set(hash, status); return hash; };
  const word = (h) => lc(h).replace(/^0x/, '').padStart(64, '0');
  // the Relay quote's shape, changeable between ticks
  const relay = { feeUsd: o.relayFeeUsd ?? 0.03, gasUsd: 0.005, shortBps: o.shortBps ?? 0, pct: o.relayPct ?? 0.0041, delayMs: o.delayMs ?? 0, refuse: o.refuse ?? null, bodies: [] };
  const fetchLog = [];
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
  const fetchFn = async (url, init) => {
    fetchLog.push(String(url));
    if (url.startsWith('https://api.relay.link/requests/v2')) return ok({ requests: [] });
    if (url === 'https://api.relay.link/quote/v2') {
      const b = JSON.parse(init.body); relay.bodies.push(b);
      if (relay.delayMs) await new Promise((r) => setTimeout(r, relay.delayMs));
      if (relay.refuse) return ok({ message: relay.refuse, errorCode: 'NO_SWAP_ROUTES_FOUND' }, 400);
      const amount = BigInt(b.amount); const in6 = F.stableToUsd6(amount, RH.stable.decimals);
      const fee = relay.feeUsd + (Number(in6) / 1e6) * relay.pct;
      const out6 = in6 - F.usd6(fee) - (in6 * BigInt(relay.shortBps)) / 10_000n;
      const out = F.usd6ToStable(out6, BSCC.stable.decimals);
      const minOut = (out * BigInt(10_000 - Number(b.slippageTolerance))) / 10_000n;
      return ok({ steps: [
        { id: 'approve', kind: 'transaction', items: [{ data: { to: RH.stable.address, data: '0x095ea7b3' + word(DEPOSITORY) + word(amount.toString(16)), value: '0' } }] },
        { id: 'deposit', kind: 'transaction', requestId: '0x' + 'e1'.repeat(32), items: [{ data: { to: DEPOSITORY, data: '0xe8017952' + word(b.user) + word(RH.stable.address) + word(amount.toString(16)) + 'ab'.repeat(32), value: '0' } }] },
      ], details: { currencyOut: { amount: String(out), minimumAmount: String(minOut) }, recipient: b.recipient, timeEstimate: 1 },
      fees: { relayer: { amountUsd: String(fee) }, gas: { amountUsd: String(relay.gasUsd) } } });
    }
    if (url.startsWith('https://api.relay.link/intents/status')) return ok({ status: o.relayStatus || 'success' });
    if (url.startsWith('https://dln.debridge.finance/v1.0/dln/order/create-tx')) {
      // deBridge as measured: ~$0.28 out of the amount + a fixed 0.001 ETH (= $4 here) paid in value
      const q = new URL(url).searchParams; const amount = BigInt(q.get('srcChainTokenInAmount'));
      const out6 = F.stableToUsd6(amount, RH.stable.decimals) - F.usd6(0.28);
      return ok({ tx: { to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66', data: '0xb9303701' + '00'.repeat(64), value: '1000000000000000' }, estimation: { dstChainTokenOut: { amount: String(F.usd6ToStable(out6, BSCC.stable.decimals)) } }, fixFee: '1000000000000000', orderId: '0xorder', order: { approximateFulfillmentDelay: 4 } });
    }
    if (url.startsWith('https://price-api.mayan.finance')) return ok({ quotes: [] });
    throw new Error('test: unexpected fetch ' + url);
  };
  const store = new Map(); const events = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: T.t, lastTradeAt: T.t - 30_000, limitBusy: false };
  const deps = {
    chain: () => 'robinhood',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W, sol: sol.W }, r: { evm: R, sol: sol.R } }; },
    evm: {
      call: async (tx) => exec(tx.from, tx, false), balance: async (a) => ch.eth.get(lc(a)) ?? 0n, erc20: async (t, a) => ch.usdg.get(lc(a)) ?? 0n,
      allowance: async (t, owner, spender) => ch.allow.get(`${lc(owner)}>${lc(spender)}`) ?? 0n, slot0: async () => sqrtFor(4000),
      fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }), estimate: async (tx) => { exec(tx.from, tx, false); return 150_000n; },
      sendR: async (walletId, tx) => send(R, tx), sendW: async (walletId, tx) => send(W, tx),
      receipt: async (h) => (ch.receipts.has(h) ? { status: ch.receipts.get(h) } : null),
    },
    sol: { balance: async () => 0n, usdc: async () => 0n, oracle6: async () => 100n * F.USD, fees: async () => { throw new Error('defaults'); }, quote: async () => 0n, topup: async () => 'x', sweep: async () => 'x', gas: async () => 'x', status: async () => 'confirmed' },
    ask: async () => true, gate: async () => {}, html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h }, now: () => T.t,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: (d) => events.push(d), fetch: fetchFn, click: () => click, wait: async () => {},
    ...(o.earn ? { earn: o.earn } : {}),
  };
  const f = createFloat(deps);
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
  // the BNB frame's snapshot as that frame wrote it: W's float full, R's USDC `reserveUsd`, written now
  const bscSnap = (reserveUsd, at = T.t) => store.set(`trenches.float.v1.snap.bsc.${lc(W)}`, JSON.stringify({ at, chain: 'bsc', price6: String(BNB6), priceAt: at, float: String(BSCC.gasFloor + 84_000_000_000_000_000n), reserve: String(usdcBsc(reserveUsd)), reserveNative: String(BSCC.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(o.preset ?? 100))], buys6: (o.buys ?? [o.preset ?? 100]).map((x) => String(F.usd6(x))) }));
  // buys on BNB an hour ago (what the page's 'fill' report records)
  const tradedBsc = (agoMs = 3_600_000) => store.set(`trenches.float.v1.prefs.bsc.${lc(W)}`, JSON.stringify({ presets6: [String(F.usd6(o.preset ?? 100))], buys6: (o.buys ?? [o.preset ?? 100]).map((x) => String(F.usd6(x))), buysAt: [T.t - agoMs], activeAt: T.t - agoMs }));
  const on = async () => { await f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] }); for (const k of [...store.keys()]) if (k.startsWith('trenches.float.v1.order.')) store.delete(k); };
  const tick = async () => { const r = await f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await settle(); return r; };
  const jobs = async () => (await f.jobs({ walletId: 'w1' })).jobs;
  const advance = (ms) => { T.t += ms; click.ticketAt = T.t; click.lastTradeAt = T.t - 30_000; };
  return { f, ch, W, R, T, store, events, fetchLog, relay, settle, bscSnap, tradedBsc, on, tick, jobs, advance, ETH6 };
}
