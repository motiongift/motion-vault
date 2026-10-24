// V12 batch-2 perps replay/idempotency tests (node:test).
// Run: node --experimental-strip-types --test test/*.mjs
// Drives the REAL src/perpsEngine.ts (createPerps) + src/lighter/perpsCore.ts (args) against a mocked Lighter API and a
// fake signer, exercising F-48 (idempotencyKey required for money-moving ops), F-42 (pre-send sufficiency carries
// {preSend:true}) and F-27 (a failed USDG read does not plan a swap) through the actual code paths.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createPerps } = await import(new URL('../src/perpsEngine.ts', import.meta.url).href);

const ADDR = '0x1111111111111111111111111111111111111111';
const PUB = '0x' + 'a'.repeat(64);
const ACCOUNT = 42;
const CREATE_HASH = 'c'.repeat(80);
const CANCEL_HASH = 'd'.repeat(80);
const IDEM = 'idem-batch2-0001';

const market = (over = {}) => ({
  market_id: 1, symbol: 'ETH', size_decimals: 3, price_decimals: 2,
  min_initial_margin_fraction: 1000, default_initial_margin_fraction: 1000, maintenance_margin_fraction: 500,
  min_base_amount: '0.001', min_quote_amount: '1', mark_price: 100, index_price: 100, last_trade_price: 100,
  status: 'active', is_frozen: false, market_type: 'perp', ...over,
});
const position = (over = {}) => ({
  market_id: 1, symbol: 'ETH', position: '2', sign: 1, avg_entry_price: '100', position_value: '200',
  unrealized_pnl: '0', liquidation_price: '90', initial_margin_fraction: 0.1, margin_mode: 1,
  allocated_margin: '50', total_funding_paid_out: '0', open_order_count: 1, ...over,
});
const account = (positions) => ({
  accounts: [{ index: ACCOUNT, account_index: ACCOUNT, l1_address: ADDR, collateral: 1000, available_balance: 900, total_asset_value: 1000, positions }],
});

// opts: positions, activeOrders, askReturn, readContract (fn over functionName), getBalance (bigint)
function makeDeps(opts = {}) {
  let clock = 1_000_000;
  let nonce = 0;
  const posList = opts.positions === undefined ? [position()] : opts.positions;
  const activeOrders = opts.activeOrders || [];
  const asks = [];
  const askReturn = opts.askReturn ?? false;
  const getBalance = opts.getBalance ?? (async () => 0n);
  const readContract = opts.readContract ?? (async () => 0n);
  const simulate = opts.simulate ?? (async () => ({ result: 0n }));

  const fakeSigner = {
    async use() { return { publicKey: PUB }; },
    async authToken() { return { token: 'tok', deadline: clock / 1000 + 99_999 }; },
    async fromSeed() { return { privateKey: 'k', publicKey: PUB, l1Body: '' }; },
    async createOrder() { return { txType: 14, txInfo: 'create', txHash: CREATE_HASH }; },
    async cancelOrder() { return { txType: 15, txInfo: 'cancel', txHash: CANCEL_HASH }; },
    async cancelAll() { return { txType: 16, txInfo: 'cancelall', txHash: CANCEL_HASH }; },
    async updateLeverage() { return { txType: 20, txInfo: 'lev', txHash: CREATE_HASH }; },
    async updateMargin() { return { txType: 21, txInfo: 'margin', txHash: CREATE_HASH }; },
    async forget() {},
  };

  const json = (payload, status = 200) => ({ status, json: async () => payload });
  async function fetchMock(url, init) {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method === 'POST' && u.includes('/api/v1/sendTx')) {
      const body = new URLSearchParams(init.body);
      const t = body.get('tx_type');
      return json({ code: 200, tx_hash: t === '15' || t === '16' ? CANCEL_HASH : CREATE_HASH });
    }
    if (u.includes('/api/v1/account?by=l1_address')) return json(account(posList));
    if (u.includes('/api/v1/orderBookDetails')) return json({ order_book_details: [market()] });
    if (u.includes('/api/v1/apikeys')) return json({ api_keys: [{ api_key_index: 77, public_key: PUB }] });
    if (u.includes('/api/v1/nextNonce')) return json({ code: 200, nonce: nonce++ });
    if (u.includes('/api/v1/accountActiveOrders')) return json({ orders: activeOrders });
    if (u.includes('/api/v1/tx?by=hash')) {
      const value = new URL('https://x' + u.slice(u.indexOf('/api'))).searchParams.get('value');
      return json({ code: 200, status: '2', event_info: '{}' });
    }
    return json({ code: 200 });
  }

  const wallet = { id: 'w1', name: 'Wallet A', address: ADDR, lt: { v: 1, i: 77, a: ACCOUNT, k: 'deadbeef', p: PUB, st: 'ok', d: 1, region: clock, rby: 'tick', at: clock } };
  const deps = {
    lane: () => true,
    wallet: () => wallet,
    saveLt: async () => {},
    l1Sign: async () => '0x',
    apiKeySeed: async () => '00'.repeat(32),
    sendTx: async () => '0x',
    gasPrice: async () => 1n,
    receipt: async () => ({ status: 'success' }),
    pc: {
      readContract: async (args) => readContract(args && args.functionName),
      simulateContract: async (args) => simulate(args),
      estimateGas: async () => 0n,
      getBalance: async () => getBalance(),
    },
    ask: async (o) => { asks.push(o); return askReturn; },
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => `<muted>${h}</muted>`, addrRow: () => '', destBox: () => '' },
    once: (_o, _w, run) => run(() => {}),
    emit: () => {},
    fetch: fetchMock,
    signer: async () => fakeSigner,
    now: () => clock,
    store: (() => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) }; })(),
    lock: (_k, fn) => fn(),
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
  };
  return { deps, asks };
}

// ─────────────────────────── F-48: idempotencyKey required for money-moving ops ───────────────────────────
test('F-48: cancel without idempotencyKey is refused', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.cancel({ walletId: 'w1', market: 1, orderIndex: '5' }), /idempotencyKey/);
});

test('F-48: cancelAll without idempotencyKey is refused', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.cancelAll({ walletId: 'w1', market: 1 }), /idempotencyKey/);
});

test('F-48: leverage without idempotencyKey is refused', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.leverage({ walletId: 'w1', market: 1, leverage: 2, marginMode: 'cross' }), /idempotencyKey/);
});

test('F-48: margin without idempotencyKey is refused', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.margin({ walletId: 'w1', market: 1, direction: 'add', amountUsdg: '10' }), /idempotencyKey/);
});

test('F-48: claim without idempotencyKey is refused', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.claim({ walletId: 'w1' }), /idempotencyKey/);
});

test('F-48: a malformed idempotencyKey is refused (shape unchanged)', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  await assert.rejects(perps.cancel({ walletId: 'w1', market: 1, orderIndex: '5', idempotencyKey: 'short' }), /idempotencyKey/);
});

test('F-48: cancel WITH a valid key still signs and cancels (not a regression)', async () => {
  const { deps } = makeDeps({ activeOrders: [{ order_index: '5', market_index: 1, type: 'limit', reduce_only: false }] });
  const perps = createPerps(deps);
  const r = await perps.cancel({ walletId: 'w1', market: 1, orderIndex: '5', idempotencyKey: IDEM });
  assert.equal(r.ok, true);
  assert.equal(typeof r.txHash, 'string');
  assert.ok(r.txHash.length > 0, 'a cancel transaction hash was returned');
});

test('F-48: cancelAll WITH a valid key still signs (not a regression)', async () => {
  const { deps } = makeDeps();
  const perps = createPerps(deps);
  const r = await perps.cancelAll({ walletId: 'w1', market: 1, idempotencyKey: IDEM });
  assert.equal(r.ok, true);
  assert.equal(typeof r.txHash, 'string');
});

test('F-48: a duplicate key is blocked by fresh()/idemSeen before any signing', async () => {
  const { deps } = makeDeps();
  deps.idemSeen = (k) => k === IDEM;   // the key already ran (another tab / earlier try)
  const perps = createPerps(deps);
  await assert.rejects(perps.cancel({ walletId: 'w1', market: 1, orderIndex: '5', idempotencyKey: IDEM }), /already ran/);
});

// ─────────────────────────── F-42: pre-send sufficiency throw carries {preSend:true} ───────────────────────────
test('F-42: deposit short at the pre-send check throws with preSend:true', async () => {
  let balReads = 0;
  const { deps } = makeDeps({
    askReturn: true,
    getBalance: async () => 10n ** 18n,                    // plenty of ETH for gas
    readContract: async (fn) => {
      if (fn === 'allowance') return 10n ** 30n;           // already approved -> approve step is skipped
      if (fn === 'balanceOf') { balReads += 1; return balReads === 1 ? 100_000_000n : 0n; } // enough at plan, gone at pre-send
      return 0n;
    },
  });
  const perps = createPerps(deps);
  await assert.rejects(
    perps.deposit({ walletId: 'w1', amountUsdg: '100', pay: 'usdg', idempotencyKey: IDEM }),
    (e) => e.preSend === true && /nothing was deposited/.test(e.message),
  );
});

// ─────────────────────────── F-27: a failed USDG read must not plan a swap ───────────────────────────
test('F-27: USDG read failure surfaces an error and plans no swap', async () => {
  const { deps } = makeDeps({
    readContract: async () => { throw new Error('rpc down'); },   // both balanceOf and allowance fail
  });
  const perps = createPerps(deps);
  // sizeUsdg 2000 at 1x needs ~2000 margin vs 900 available -> a deposit is required, which is where the swap would be planned
  const q = await perps.quote({ walletId: 'w1', market: 1, side: 'long', type: 'market', sizeUsdg: '2000', slippageBps: 5, leverage: 1, marginMode: 'cross' });
  assert.ok(q.errors.some((e) => /USDG balance read failed/.test(e)), `expected a USDG-read error, got ${JSON.stringify(q.errors)}`);
  assert.ok(!q.steps.includes('swap'), 'no swap step is planned when the USDG balance is unknown');
});

test('F-27 control: with the USDG read working a swap IS planned for the shortfall', async () => {
  const { deps } = makeDeps({
    getBalance: async () => 10n ** 18n,
    readContract: async (fn) => (fn === 'balanceOf' ? 0n : null),   // 0 USDG held, allowance unknown
    simulate: async () => ({ result: 10n ** 12n }),                 // a live ETH -> USDG quote, so the swap can be planned
  });
  const perps = createPerps(deps);
  const q = await perps.quote({ walletId: 'w1', market: 1, side: 'long', type: 'market', sizeUsdg: '2000', slippageBps: 5, leverage: 1, marginMode: 'cross' });
  assert.ok(!q.errors.some((e) => /USDG balance read failed/.test(e)), 'no USDG-read error when the read works');
  assert.ok(q.steps.includes('swap'), 'a swap is planned to cover the shortfall when the balance really is 0');
});
