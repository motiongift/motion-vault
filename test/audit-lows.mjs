// Security audit 2026-10-25, Low items of the limit-order engine (trench docs/drafts/SECURITY-AUDIT-2026-10-25.md §1):
//   LO-8  limit.list no longer hands the wallet's 24 h read token to the page (EVM and Solana)
//   LO-9  a pre-signed Robinhood tx carries L1_HEADROOM× its L1 gas on top of the estimate × 1.4 (NodeInterface read)
//   LO-10 Solana limit.list writes changes onto the record as it is after its awaits (a close in between is kept)
//   LO-12 the Solana dialog says the excess above the floor waits in the order wallet until the vault is open again
// Run: node --experimental-strip-types --test test/audit-lows.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createLimit, l1Headroom, NODE_INTERFACE, L1_HEADROOM, L1_FALLBACK_GAS } from '../src/limitEngine.ts';
import { createSolLimit, SOL_LIMIT_STORE } from '../src/solLimitEngine.ts';
import { orderIdOf, orderKey, gasLimitOf, MAX_GAS_LIMIT, LIMIT_CHAIN } from '../src/limitCore.ts';
import { b58e, SP } from '../src/solLimitCore.ts';

const MAIN_KEY = '0x' + '42'.repeat(32);
const MAIN = privateKeyToAccount(MAIN_KEY);
const TOKEN = '0x00000000000000000000000000000000000c0105';
const CURVE = '0x000000000000000000000000000000000000c0e5';
const NATIVE = '0x0000000000000000000000000000000000000000';
const W = { id: 'w1', name: 'Wallet 1', address: MAIN.address };

test('LO-9: l1Headroom = estimate × 1.4 + 4 × the L1 part (fallback 50k when unknown, nothing on BNB), never above the 6M ceiling', () => {
  const lim = gasLimitOf(300_000n);
  assert.equal(lim, 420_000n);
  assert.equal(L1_HEADROOM, 4n);
  assert.equal(l1Headroom(lim, 1_000n), 424_000n);
  assert.equal(l1Headroom(lim, null), 420_000n + L1_FALLBACK_GAS);
  assert.equal(l1Headroom(lim, 0n), 420_000n, 'BNB Chain: no L1 share');
  assert.equal(l1Headroom(5_900_000n, 100_000n), MAX_GAS_LIMIT, 'capped at the keeper\'s ceiling');
  assert.equal(l1Headroom(MAX_GAS_LIMIT, null), MAX_GAS_LIMIT);
});

// a Robinhood place() run up to the vault's dialog (answered "no"): the plan's gas reserve shows what every swap variant carries
async function planReserve(l1, { route = null, fetchImpl = null, chain = 'robinhood' } = {}) {
  const ni = []; const events = []; const fetched = [];
  const pc = {
    getBlock: async () => ({ baseFeePerGas: 20_000_000n }),            // 0.02 gwei → signed 0.2 gwei
    getGasPrice: async () => 20_000_000n,
    getBalance: async ({ address }) => (address.toLowerCase() === MAIN.address.toLowerCase() ? 10n ** 18n : 0n),
    getTransactionCount: async () => 0,
    estimateGas: async () => 300_000n,
    call: async () => '0x',
    readContract: async (a) => {
      if (a.address === NODE_INTERFACE) { ni.push(a); if (l1 instanceof Error) throw l1; return [l1, 20_000_000n, 1_000_000n]; }
      throw new Error('unexpected read ' + a.functionName);
    },
    getTransactionReceipt: async () => null,
  };
  const L = createLimit({
    lane: () => true, chain: () => chain,
    wallet: () => W, wallets: () => [W],
    orderIdAt: (id, i) => orderIdOf(MAIN_KEY, chain, i),
    orderSigner: async (id, orderId) => { const a = privateKeyToAccount(await orderKey(MAIN_KEY, chain, orderId)); return { address: a.address, sign: async () => '0x' }; },
    signAuth: async () => '0x' + '11'.repeat(65),
    sendTx: async () => { throw new Error('nothing is sent before the dialog'); },
    broadcast: async () => { throw new Error('nothing is sent before the dialog'); },
    receipt: async () => ({ status: 'success' }),
    verifyRoute: async () => {}, ponsCreatorTax: async () => 100,
    gasPrice: async () => 25_000_000n, pc,
    tokenMeta: async () => ({ symbol: 'MOCK', decimals: 18 }),
    ask: async () => false,
    html: { esc: String, sub: (h) => h, muted: (h) => h, addrRow: (n, a) => `${n} ${a}` },
    once: (opts, what, run) => run(() => {}), idemSeen: () => false, lock: (k, fn) => fn(),
    emit: (e) => events.push(e), fetch: async (u, i) => { fetched.push(String(u)); if (fetchImpl) return fetchImpl(u, i); throw new Error('no server'); }, api: () => 'https://motion.gift',
    store: { get: () => null, set: () => {} }, now: () => Date.UTC(2026, 9, 26, 12),
  });
  if (route) {
    const err = await L.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: '0.000001', amount: '0.01', expiresIn: 86400, idempotencyKey: 'audit-lo11-' + Math.random().toString(36).slice(2, 10), route }).then(() => null, (e) => e);
    return { err, fetched, events };
  }
  await assert.rejects(L.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: '0.000001', amount: '0.01', expiresIn: 86400, idempotencyKey: 'audit-lo9-' + String(l1).slice(0, 12).replace(/\W/g, ''), route: { type: 'pons', curve: CURVE, pairToken: NATIVE, feeBps: 100, creatorTaxBps: 100 } }), /Cancelled/);
  const plan = events.find((e) => e.step === 'plan' && e.state === 'done');
  return { reserve: Number(plan.reserve), ni };
}

test('LO-9: each Robinhood swap variant is priced with its L1 part read from the NodeInterface (eth_call), × 4 on top', async () => {
  const G = 200_000_000;   // the signed gas price (10 × base fee)
  const sweep = 420_000;   // the ETH way back: estimate × 1.4 (built when it is sent, not pre-signed for days)
  const a = await planReserve(250_000n);
  assert.ok(Math.abs(a.reserve - (420_000 + 4 * 250_000 + sweep) * G / 1e18) < 2e-6, `reserve ${a.reserve}`);
  // the read names each variant's own call: the curve and the V4 pool it migrates into (the Universal Router)
  assert.equal(a.ni.length, 2);
  assert.ok(a.ni.every((x) => x.functionName === 'gasEstimateL1Component' && x.args[1] === false && /^0x[0-9a-f]+$/i.test(x.args[2]) && x.args[2].length > 10));
  assert.ok(a.ni.some((x) => x.args[0].toLowerCase() === CURVE), 'the curve variant\'s own calldata');
  // the node cannot say: L1_FALLBACK_GAS instead (the placement is never blocked by this read)
  const b = await planReserve(new Error('no NodeInterface on this node'));
  assert.ok(Math.abs(b.reserve - (420_000 + 50_000 + sweep) * G / 1e18) < 2e-6, `reserve ${b.reserve}`);
});

// ── LO-11: a hookless V4 pool (anyone can create one) must be the pool motion's /limit-route names ──
const HOOKLESS = { currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE };
const v4Route = (poolKey) => ({ type: 'v4', pair: 'native', poolKey, chainId: 4663 });
const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 404, json: async () => body });
test('LO-11: a hookless pool the server also names is placed; another pool or a live curve is refused; no answer changes nothing; hooked pools are not asked', async () => {
  const same = await planReserve(0n, { route: v4Route(HOOKLESS), fetchImpl: answer({ ok: true, route: { type: 'v4', poolKey: { ...HOOKLESS, currency1: TOKEN.toUpperCase().replace('0X', '0x') } } }) });
  assert.equal(same.err?.name, 'Cancelled', 'the same pool: on to the dialog'); assert.deepEqual(same.fetched, [`https://motion.gift/api/token/${TOKEN}/limit-route`]);
  const other = await planReserve(0n, { route: v4Route(HOOKLESS), fetchImpl: answer({ ok: true, route: { type: 'v4', poolKey: { ...HOOKLESS, fee: 500, tickSpacing: 10 } } }) });
  assert.equal(other.err?.name, 'LimitRefused'); assert.match(other.err.message, /another market/);
  assert.ok(!other.events.some((e) => e.step === 'plan' && e.state === 'done'), 'refused before anything is priced or asked');
  const curve = await planReserve(0n, { route: v4Route(HOOKLESS), fetchImpl: answer({ ok: true, curve: true }) });
  assert.equal(curve.err?.name, 'LimitRefused');
  for (const f of [async () => { throw new Error('offline'); }, answer({ ok: false, error: 'Unknown token' }, false), answer('not json')]) {
    const r = await planReserve(0n, { route: v4Route(HOOKLESS), fetchImpl: f }); assert.equal(r.err?.name, 'Cancelled', 'no usable answer: as before');
  }
  const hooked = await planReserve(0n, { route: v4Route({ ...HOOKLESS, hooks: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544', fee: 0, tickSpacing: 200 }) });
  assert.equal(hooked.fetched.filter((u) => u.includes('limit-route')).length, 0, 'a pool behind an allow-listed hook is not asked about');
});

test('LO-11 (BNB): a V2 bridge through a quote token the server does not name is refused; the same path goes on', async () => {
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
  const QUOTE = '0x00000000000000000000000000000000000a11ce', EVIL = '0x0000000000000000000000000000000000000bad';
  const route = (q) => ({ type: 'v2', router: ROUTER, path: [WBNB, q, TOKEN], chainId: 56 });
  const ok = await planReserve(0n, { chain: 'bsc', route: route(QUOTE), fetchImpl: answer({ ok: true, route: { type: 'v2', path: [WBNB, QUOTE, TOKEN] } }) });
  assert.equal(ok.err?.name, 'Cancelled', String(ok.err?.message)); assert.deepEqual(ok.fetched.slice(0, 1), [`https://motion.gift/bsc/api/token/${TOKEN}/limit-route`]);
  const bad = await planReserve(0n, { chain: 'bsc', route: route(EVIL), fetchImpl: answer({ ok: true, route: { type: 'v2', path: [WBNB, QUOTE, TOKEN] } }) });
  assert.equal(bad.err?.name, 'LimitRefused'); assert.match(bad.err.message, /another market/);
  // a plain WBNB pair (fixed router, fixed path) is not asked about
  const plain = await planReserve(0n, { chain: 'bsc', route: { type: 'v2', router: ROUTER, path: [WBNB, TOKEN], chainId: 56 } });
  assert.equal(plain.fetched.filter((u) => u.includes('limit-route')).length, 0);
});

test('LO-8: EVM limit.list({ walletId }) answers without the 24 h read token and signs no read text for the page', async () => {
  const signed = [];
  const L = createLimit({
    lane: () => true, chain: () => 'robinhood', wallet: () => W, wallets: () => [W],
    orderIdAt: async () => { throw new Error('scan stops here'); }, orderSigner: async () => { throw new Error('no'); },
    signAuth: async (id, text) => { signed.push(text); return '0x' + '11'.repeat(65); },
    pc: { getTransactionCount: async () => 0, getBalance: async () => 0n }, fetch: async () => { throw new Error('no server'); }, api: () => 'https://motion.gift',
    emit: () => {}, store: { get: () => null, set: () => {} }, now: () => Date.UTC(2026, 9, 26, 12),
  });
  const r = await L.list({ walletId: 'w1' });
  assert.equal(r.ok, true); assert.ok(!('read' in r), 'no read token in the answer');
  assert.ok(!JSON.stringify(r).includes('11'.repeat(65)));
  assert.equal(signed.filter((t) => /action: read/.test(t)).length, 0, 'no read text signed for the page');
});

// a Solana record and its nonce account as the chain holds them
const key32 = (b) => b58e(new Uint8Array(32).fill(b));
const OW = key32(3), NONCE = key32(4), VALUE = key32(9), MAIN_SOL = key32(7), MINT = key32(8);
const nonceAcc = () => { const d = new Uint8Array(80); new DataView(d.buffer).setUint32(0, 1, true); new DataView(d.buffer).setUint32(4, 1, true); d.set(new Uint8Array(32).fill(3), 8); d.set(new Uint8Array(32).fill(9), 40); return { owner: SP.system, data: d, lamports: 1_447_680 }; };
function solWorld({ onPost } = {}) {
  const store = new Map(); const signed = [];
  const rec = { v: 1, id: 'ab'.repeat(16), index: 0, walletId: 'w1', wallet: MAIN_SOL, orderWallet: OW, nonce: NONCE, nonceValue: VALUE, token: MINT, tokenProgram: SP.token22, symbol: 'COIN', decimals: 6,
    side: 'buy', kind: 'limit', price: '0.00002', amount: '0.1', amountIn: '100000000', minOut: { pump: '5000000000' }, slippageBps: 100, expiry: Date.UTC(2026, 9, 27), createdAt: Date.UTC(2026, 9, 26),
    venues: ['pump'], txs: [{ venue: 'pump', raw: 'AAAA', sig: 'sig1' }], fund: [], setup: [], reserve: '0', stage: 'open', stored: false };
  store.set(SOL_LIMIT_STORE, JSON.stringify({ [rec.id]: rec }));
  const S = createSolLimit({
    lane: () => true, wallet: () => ({ id: 'w1', name: 'Wallet 1', address: MAIN_SOL }), wallets: () => [{ id: 'w1', name: 'Wallet 1', address: MAIN_SOL }],
    orderIdAt: () => { throw new Error('scan stops here'); }, orderSigner: () => { throw new Error('no'); },
    signAuth: (id, text) => { signed.push(text); return '22'.repeat(64); },
    accounts: async (addrs) => addrs.map((a) => (a === NONCE ? nonceAcc() : a === OW ? { owner: SP.system, data: new Uint8Array(0), lamports: 200_000_000 } : null)),
    statuses: async (s) => s.map(() => null),
    fetch: async () => { if (onPost) onPost(store, rec.id); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    api: () => 'https://motion.gift', emit: () => {},
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, now: () => Date.UTC(2026, 9, 26, 12),
  });
  return { S, store, signed, rec };
}

test('LO-8: Solana limit.list({ walletId }) answers without the read token', async () => {
  const w = solWorld();
  const r = await w.S.list({ walletId: 'w1' });
  assert.equal(r.ok, true); assert.ok(!('read' in r)); assert.ok(!JSON.stringify(r).includes('22'.repeat(64)));
  assert.equal(w.signed.filter((t) => /action: read/.test(t)).length, 0);
});

test('LO-10: a close that lands while limit.list awaits the server is kept (list patches the record, never writes back its stale copy)', async () => {
  // the record is open and not yet on our server: list posts it; meanwhile a cancel in another call closes it
  const w = solWorld({ onPost: (store, id) => { const all = JSON.parse(store.get(SOL_LIMIT_STORE)); all[id] = { ...all[id], closed: 'cancelled', sweptAt: 123 }; store.set(SOL_LIMIT_STORE, JSON.stringify(all)); } });
  await w.S.list({ walletId: 'w1' });
  const after = JSON.parse(w.store.get(SOL_LIMIT_STORE))[w.rec.id];
  assert.equal(after.closed, 'cancelled', 'the close is not overwritten'); assert.equal(after.sweptAt, 123);
  assert.equal(after.stored, true, 'and the post is recorded on top of it');
});

test('LO-12: the Solana dialog says the excess above the floor waits in the order wallet until this vault is open again', () => {
  const src = readFileSync(new URL('../src/solLimitEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /Anything the fill makes above the floor stays in the order wallet until this vault is open again/);
  assert.doesNotMatch(src, /anything above it comes back with the sweep/);
});
