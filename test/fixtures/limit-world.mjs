// rel-12 (2026-11-06, the AIMCAP report): the real vault limit module (src/limitEngine.ts) with real signing by throwaway keys on
// the mocked Robinhood Chain (test/fixtures/limit-mock-chain.mjs, a copy of trench's). motion's keeper is a fake behind fetch:
// it answers POST / DELETE / GET /api/limit as the test says (taken, a 5xx, a 4xx, no answer) and keeps what it took.
// No real transaction, no real key.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { createChain } from './limit-mock-chain.mjs';
import { createLimit } from '../../src/limitEngine.ts';
import { orderKey, orderIdOf, authTextProblem, LIMIT_CHAIN } from '../../src/limitCore.ts';

export const TOKEN = '0x00000000000000000000000000000000000c0105';
export const CURVE = '0x000000000000000000000000000000000000c0e5';
const hx = (v) => '0x' + BigInt(v).toString(16);
export const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;   // ETH → wei

export function limitWorld({ mainKey = generatePrivateKey() } = {}) {
  const clock = { t: Date.UTC(2026, 10, 6, 12, 0, 0) };
  const now = () => clock.t;
  const chain = createChain({ token: TOKEN, curve: CURVE, now });
  const main = privateKeyToAccount(mainKey);
  chain.fund(main.address, E(5));
  chain.give(main.address, 1_000_000n * 10n ** 18n);
  const rpc = chain.rpc;
  // the fake keeper: `answer` decides each POST ('ok' | 500 | 400 | 'throw'); what it took and every request it saw
  const keeper = { answer: ['ok'], posts: 0, deletes: [], orders: new Map() };
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url); if (u.pathname !== '/api/limit') return json(404, { ok: false, error: 'not found' });
    const m = (init.method || 'GET').toUpperCase();
    if (m === 'POST') {
      const a = keeper.answer.length > 1 ? keeper.answer.shift() : keeper.answer[0]; keeper.posts += 1;
      const b = JSON.parse(init.body);
      if (a === 'throw') throw new Error('fetch failed');
      if (a === 'ok') { keeper.orders.set(b.order.id, b.order); return json(200, { ok: true }); }
      if (a === 'kept500') { keeper.orders.set(b.order.id, b.order); return json(500, { ok: false, error: 'internal' }); }
      return json(Number(a), { ok: false, error: Number(a) >= 500 ? 'internal' : 'bad order' });
    }
    if (m === 'DELETE') { const b = JSON.parse(init.body); keeper.deletes.push(b.id); keeper.orders.delete(b.id); return json(200, { ok: true }); }
    return json(200, { ok: true, orders: [...keeper.orders.values()] });
  };
  const store = new Map(); const idem = new Map();
  const asks = []; const events = []; const sent = []; const sleeps = [];
  let askAnswer = true;
  const once = async (opts, what, run) => {
    const k = opts?.idempotencyKey; if (!k) return run(() => {});
    if (idem.has(k)) throw new Error('test: key reused');
    idem.set(k, 'started');
    return run(() => idem.set(k, 'sending'));
  };
  const locks = new Map();
  const lock = (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const run = prev.then(fn); locks.set(key, run.then(() => {}, () => {})); return run; };
  const fee = async () => 25_000_000n;
  const pc = {
    getBlock: async () => { const b = await rpc('eth_getBlockByNumber', ['latest', false]); return { baseFeePerGas: BigInt(b.baseFeePerGas) }; },
    getGasPrice: async () => BigInt(await rpc('eth_gasPrice')),
    getBalance: async ({ address }) => BigInt(await rpc('eth_getBalance', [address, 'latest'])),
    getTransactionCount: async ({ address, blockTag }) => Number(BigInt(await rpc('eth_getTransactionCount', [address, blockTag]))),
    estimateGas: async ({ account, to, data, value }) => BigInt(await rpc('eth_estimateGas', [{ from: account, to, data, value: hx(value || 0n) }])),
    call: async ({ account, to, data, value }) => rpc('eth_call', [{ from: account, to, data, value: hx(value || 0n) }, 'latest']),
    readContract: async ({ address, abi, functionName, args }) => decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']) }),
    callOverride: async ({ to, data, code }) => rpc('eth_call', [{ to, data }, 'latest', { [to]: { code } }]),
    getTransactionReceipt: async ({ hash }) => { const r = await rpc('eth_getTransactionReceipt', [hash]); return r ? { status: r.status === '0x1' ? 'success' : 'reverted' } : null; },
  };
  const W = { id: 'w1', name: 'Wallet 1', address: main.address };
  const signerOf = async (orderId) => { const k = await orderKey(mainKey, LIMIT_CHAIN, orderId); const acct = privateKeyToAccount(k); return { address: acct.address, sign: (tx) => acct.signTransaction({ to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice, chainId: 4663, type: 'legacy' }) }; };
  const mk = (st) => createLimit({
    lane: () => true,
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return W; },
    wallets: () => [W],
    orderIdAt: (id, index) => orderIdOf(mainKey, LIMIT_CHAIN, index),
    ponsCreatorTax: async () => 100,
    orderSigner: async (id, orderId) => signerOf(orderId),
    signAuth: async (id, text) => { const why = authTextProblem(text, main.address); if (why) throw new Error('Refused: ' + why); return main.signMessage({ message: text }); },
    sendTx: async (id, tx, gas) => {
      const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [main.address, 'pending'])));
      const g = gas ?? (await pc.estimateGas({ account: main.address, ...tx })) * 12n / 10n;
      const raw = await main.signTransaction({ to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, nonce, gas: g, gasPrice: await fee(), chainId: 4663, type: 'legacy' });
      sent.push({ from: 'main', tx }); return chain.sendRaw(raw);
    },
    broadcast: async (raw) => { sent.push({ from: 'order', raw }); return chain.sendRaw(raw); },
    receipt: async (hash) => { const r = await rpc('eth_getTransactionReceipt', [hash]); if (!r) throw new Error('Transaction not confirmed in time'); return { status: r.status === '0x1' ? 'success' : 'reverted' }; },
    verifyRoute: async (token, route) => { if (route.type === 'pons' && route.curve.toLowerCase() !== CURVE) throw new Error('Route rejected: curve'); },
    gasPrice: fee,
    pc,
    tokenMeta: async () => ({ symbol: 'MOCK', decimals: 18 }),
    ask: async (o) => { asks.push(o); return askAnswer; },
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<p>${h}</p>`, addrRow: (n, a) => `<div>${n} ${a}</div>` },
    once, idemSeen: () => false, lock,
    emit: (d) => events.push(d),
    fetch: fetchFn,
    api: () => 'https://motion.test',
    store: { get: (k) => st.get(k) ?? null, set: (k, v) => st.set(k, v) },
    now,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const limit = mk(store);
  const route = { type: 'pons', curve: CURVE, pairToken: '0x0000000000000000000000000000000000000000', feeBps: 100, creatorTaxBps: 100, chainId: 4663, quoteSymbol: 'ETH' };
  // another browser of the same wallet (a wiped one): its own empty vault storage, the same key and chain
  const device = (st = new Map()) => mk(st);
  return { clock, chain, keeper, main, store, asks, events, sent, sleeps, limit, device, route, signerOf, W, setAsk: (v) => { askAnswer = v; } };
}
