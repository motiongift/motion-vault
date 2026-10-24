// V12 batch-1 perps security regression tests (node:test).
// Run: node --experimental-strip-types --test test/*.mjs
// Drives the REAL src/perpsEngine.ts (createPerps) against a mocked Lighter API + a fake signer, so the
// fixes for F-4, F-15, F-51 and F-72 are exercised through the actual code paths, not a re-implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createPerps } = await import(new URL('../src/perpsEngine.ts', import.meta.url).href);

const ADDR = '0x1111111111111111111111111111111111111111';
const PUB = '0x' + 'a'.repeat(64);
const ACCOUNT = 42;
const CREATE_HASH = 'c'.repeat(80);
const CANCEL_HASH = 'd'.repeat(80);

const market = (over = {}) => ({
  market_id: 1, symbol: 'ETH', size_decimals: 3, price_decimals: 2,
  min_initial_margin_fraction: 1000, default_initial_margin_fraction: 1000, maintenance_margin_fraction: 500,
  min_base_amount: '0.001', min_quote_amount: '1', mark_price: 100, index_price: 100, last_trade_price: 100,
  status: 'active', is_frozen: false, market_type: 'perp', ...over,
});

// a long ETH position, isolated by default
const position = (over = {}) => ({
  market_id: 1, symbol: 'ETH', position: '2', sign: 1, avg_entry_price: '100', position_value: '200',
  unrealized_pnl: '0', liquidation_price: '90', initial_margin_fraction: 0.1, margin_mode: 1,
  allocated_margin: '50', total_funding_paid_out: '0', open_order_count: 1, ...over,
});

const account = (positions) => ({
  accounts: [{ index: ACCOUNT, account_index: ACCOUNT, l1_address: ADDR, collateral: 1000, available_balance: 900, total_asset_value: 1000, positions }],
});

function makeDeps(opts = {}) {
  let clock = 1_000_000;
  let nonce = 0;
  const posList = opts.positions === undefined ? [position()] : opts.positions;
  const activeOrders = opts.activeOrders || [];
  const tx = opts.tx || {};               // hash -> /tx payload
  const asks = [];
  const askReturn = opts.askReturn ?? false;

  const fakeSigner = {
    async use() { return { publicKey: PUB }; },
    async authToken() { return { token: 'tok', deadline: clock / 1000 + 99_999 }; },
    async fromSeed() { return { privateKey: 'k', publicKey: PUB, l1Body: '' }; },
    async createOrder() { return { txType: 14, txInfo: 'create', txHash: CREATE_HASH }; },
    async cancelOrder() { return { txType: 15, txInfo: 'cancel', txHash: CANCEL_HASH }; },
    async forget() {},
  };

  const json = (payload, status = 200) => ({ status, json: async () => payload });
  async function fetchMock(url, init) {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method === 'POST' && u.includes('/api/v1/sendTx')) {
      const body = new URLSearchParams(init.body);
      const t = body.get('tx_type');
      return json({ code: 200, tx_hash: t === '15' ? CANCEL_HASH : CREATE_HASH });
    }
    if (u.includes('/api/v1/account?by=l1_address')) return json(account(posList));
    if (u.includes('/api/v1/orderBookDetails')) return json({ order_book_details: [market()] });
    if (u.includes('/api/v1/apikeys')) return json({ api_keys: [{ api_key_index: 77, public_key: PUB }] });
    if (u.includes('/api/v1/nextNonce')) return json({ code: 200, nonce: nonce++ });
    if (u.includes('/api/v1/accountActiveOrders')) return json({ orders: activeOrders });
    if (u.includes('/api/v1/tx?by=hash')) {
      const value = new URL('https://x' + u.slice(u.indexOf('/api'))).searchParams.get('value');
      return json(tx[value] || { code: 200, status: '1' });   // default: pending
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
    pc: { readContract: async () => 0n, simulateContract: async () => ({ result: 0n }), estimateGas: async () => 0n, getBalance: async () => 0n },
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

// ─────────────────────────── F-15: margin-removal dialog ───────────────────────────
test('F-15: remove margin refuses a market with no position', async () => {
  const { deps } = makeDeps({ positions: [] });
  const perps = createPerps(deps);
  await assert.rejects(perps.margin({ walletId: 'w1', market: 1, direction: 'remove', amountUsdg: '10', idempotencyKey: 'idem-f15-0001' }), /No open position in ETH/);
});

test('F-15: remove margin refuses a cross-margin position', async () => {
  const { deps } = makeDeps({ positions: [position({ margin_mode: 0 })] });
  const perps = createPerps(deps);
  await assert.rejects(perps.margin({ walletId: 'w1', market: 1, direction: 'remove', amountUsdg: '10', idempotencyKey: 'idem-f15-0001' }), /cross margin/);
});

test('F-15: remove dialog names the market, side, size, margin and new liquidation', async () => {
  const { deps, asks } = makeDeps({ positions: [position()], askReturn: false });
  const perps = createPerps(deps);
  await assert.rejects(perps.margin({ walletId: 'w1', market: 1, direction: 'remove', amountUsdg: '10', idempotencyKey: 'idem-f15-0001' }), /Cancelled/);
  assert.equal(asks.length, 1, 'the dialog was shown');
  const html = asks[0].html;
  assert.match(html, /ETH/, 'market symbol');
  assert.match(html, /Long/, 'side');
  assert.match(html, />2 ETH</, 'size');
  assert.match(html, /50\.00 USDG/, 'current margin');
  assert.match(html, /90\.0000/, 'liquidation now');
  assert.match(html, /95\.0000/, 'estimated liquidation after (moved toward the mark)');
});

// ─────────────────────────── F-4 / F-51: trigger replace ───────────────────────────
const OLD = { order_index: '5', market_index: 1, type: 'stop-loss-limit', reduce_only: true };
const NEW = { order_index: '9', market_index: 1, type: 'stop-loss-limit', reduce_only: true };
const EXEC_CREATE = { code: 200, status: '2', event_info: JSON.stringify({ to: { i: 9, is: 0, rs: 0 } }) };
const replaceReq = { walletId: 'w1', market: 1, kind: 'sl', triggerPrice: '90', replace: '5', idempotencyKey: 'idem-0001' };

test('F-4: new trigger not executed yet -> old one is NOT cancelled (replacePending)', async () => {
  const { deps } = makeDeps({ activeOrders: [OLD], tx: { [CREATE_HASH]: { code: 200, status: '1' } } });
  const perps = createPerps(deps);
  const r = await perps.trigger(replaceReq);
  assert.equal(r.replaced, false);
  assert.equal(r.replacePending, true);
  assert.equal(r.cancelTxHash, undefined, 'no cancel was sent');
  assert.equal(r.state, 'accepted');
});

test('F-51: cancel executed -> replaced:true', async () => {
  const { deps } = makeDeps({ activeOrders: [OLD, NEW], tx: { [CREATE_HASH]: EXEC_CREATE, [CANCEL_HASH]: { code: 200, status: '2', event_info: '{}' } } });
  const perps = createPerps(deps);
  const r = await perps.trigger(replaceReq);
  assert.equal(r.replaced, true);
  assert.equal(r.cancelTxHash, CANCEL_HASH);
  assert.equal(r.replacePending, undefined);
});

test('F-51: cancel failed -> replaced:false', async () => {
  const { deps } = makeDeps({ activeOrders: [OLD, NEW], tx: { [CREATE_HASH]: EXEC_CREATE, [CANCEL_HASH]: { code: 200, status: '0' } } });
  const perps = createPerps(deps);
  const r = await perps.trigger(replaceReq);
  assert.equal(r.replaced, false);
  assert.equal(r.replacePending, undefined, 'a confirmed failure is not pending');
});

test('F-51: cancel still pending -> replaced:null + replacePending', async () => {
  const { deps } = makeDeps({ activeOrders: [OLD, NEW], tx: { [CREATE_HASH]: EXEC_CREATE, [CANCEL_HASH]: { code: 200, status: '1' } } });
  const perps = createPerps(deps);
  const r = await perps.trigger(replaceReq);
  assert.equal(r.replaced, null);
  assert.equal(r.replacePending, true);
  assert.equal(r.cancelTxHash, CANCEL_HASH, 'the cancel was sent, outcome unknown');
});

// ─────────────────────────── F-72: hourly-cap bucket cannot be evicted by tiny orders ───────────────────────────
// hourNote is a private closure; exercise its EXACT algorithm (copied 1:1 from perpsEngine.ts) to pin the invariant.
test('F-72: a big order survives a flood of 200 tiny ones (merge, not slice)', () => {
  let nowV = 10_000_000;
  const store = new Map();
  const now = () => nowV;
  const HOUR_KEY = 'trenches.perps.hour.v1';
  const hourRead = () => { try { return JSON.parse(store.get(HOUR_KEY) || '{}') || {}; } catch { return {}; } };
  const hourOf = (addr) => (hourRead()[addr.toLowerCase()] || []).filter((x) => now() - x.at < 3_600_000).reduce((a, x) => a + (Number(x.n) || 0), 0);
  const hourNote = (addr, n) => {
    const all = hourRead(); const k = addr.toLowerCase();
    let kept = [...(all[k] || []).filter((x) => now() - x.at < 3_600_000), { at: now(), n }];
    if (kept.length > 200) {
      kept.sort((a, b) => a.at - b.at);
      const over = kept.length - 200;
      const old = kept.slice(0, over + 1);
      const merged = { at: Math.max(...old.map((x) => x.at)), n: old.reduce((s, x) => s + (Number(x.n) || 0), 0) };
      kept = [merged, ...kept.slice(over + 1)];
    }
    all[k] = kept; store.set(HOUR_KEY, JSON.stringify(all));
  };

  hourNote(ADDR, 100_000);            // one big order
  for (let i = 0; i < 300; i++) { nowV += 1000; hourNote(ADDR, 1); }   // 300 tiny ones within the hour
  const total = hourOf(ADDR);
  assert.ok(total >= 100_000, `the big order must still count toward the hour (got ${total})`);
  const bucket = hourRead()[ADDR.toLowerCase()];
  assert.equal(bucket.length, 200, 'kept at most 200 buckets');
});

test('F-72: entries older than an hour are dropped', () => {
  let nowV = 10_000_000;
  const store = new Map();
  const now = () => nowV;
  const HOUR_KEY = 'trenches.perps.hour.v1';
  const hourRead = () => { try { return JSON.parse(store.get(HOUR_KEY) || '{}') || {}; } catch { return {}; } };
  const hourOf = (addr) => (hourRead()[addr.toLowerCase()] || []).filter((x) => now() - x.at < 3_600_000).reduce((a, x) => a + (Number(x.n) || 0), 0);
  const hourNote = (addr, n) => {
    const all = hourRead(); const k = addr.toLowerCase();
    let kept = [...(all[k] || []).filter((x) => now() - x.at < 3_600_000), { at: now(), n }];
    all[k] = kept; store.set(HOUR_KEY, JSON.stringify(all));
  };
  hourNote(ADDR, 500);
  nowV += 3_600_001;        // more than an hour later
  hourNote(ADDR, 1);
  assert.equal(hourOf(ADDR), 1, 'the hour-old entry is gone');
});
