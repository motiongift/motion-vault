// SECURITY BATCH 2 (2026-11-04) — NEAR-1: the NEAR ↔ quote bridge tier of a coin quoted in another token.
// Before the fix the tier was the one where a 0.1 NEAR BUY probe gets the most, and a sell took its signed minimum from a quote
// through that same tier. Rhea DCL's create_pool and add_liquidity are open to anyone (on chain: pools created by personal
// accounts this week, each choosing its own init_point), so an attacker can seed a tier one-sided — cheap quote coin for the
// probe, (next to) no NEAR the other way — and every dialog-less sell of that coin signs a near-zero minimum through it.
// The real nearEngine runs against a mocked Rhea (no network): the DCL `quote` view is a small pool model, every signed
// transaction is decoded and its Swap message read. Dummy test key only; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';

const NEAR = 10n ** 24n, QU = 10n ** 18n;   // yocto per NEAR; units per quote coin (18 decimals here)
// pool model: per pool and direction, out = f(amount); 0 = the pool cannot absorb that input (DCL answers 0 when unfinished)
const POOLS = new Map();
const pool = (id, fwd, back) => { const [x] = id.split('|'); POOLS.set(id, { x, fwd, back }); };   // fwd: x → y, back: y → x
const lin = (num, den, cap = Infinity) => (a) => (Number(a) > cap ? 0n : (a * num) / den);
const quoteOf = (ids, input, amount) => {
  let tok = input, a = amount;
  for (const id of ids) { const p = POOLS.get(id); if (!p) return 0n; const [x, y] = id.split('|'); if (tok === x) { a = p.fwd(a); tok = y; } else if (tok === y) { a = p.back(a); tok = x; } else return 0n; if (a <= 0n) return 0n; }
  return a;
};
const LAUNCH = new Map();   // token → factory launch record
const SENT = [];            // every decoded Swap message, in signing order
let calls = [];             // [t, method] of every view
let RTT = 0;
const enc = (o) => [...Buffer.from(JSON.stringify(o))];
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body); const p = b.params; let result;
  if (RTT) { calls.push([performance.now(), "*" + (b.method === "query" ? p.request_type + ":" + (p.method_name || "") : b.method)]); await new Promise((r) => setTimeout(r, RTT)); }
  if (b.method === 'query' && p.request_type === 'call_function') {
    const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()); const m = p.method_name; calls.push([performance.now(), m, p.account_id]);
    if (m === 'get_launch_by_token') result = enc(LAUNCH.get(args.token) ?? null);
    else if (m === 'ft_metadata') result = enc({ symbol: p.account_id.split('.')[0].toUpperCase().slice(0, 6), decimals: 18 });
    else if (m === 'ft_balance_of') result = enc(p.account_id === 'wrap.near' ? '0' : String(1000n * QU));
    else if (m === 'storage_balance_of') result = enc({ total: '1' });
    else if (m === 'storage_balance_bounds') result = enc({ min: '1250000000000000000000' });
    else if (m === 'quote') result = enc({ amount: String(quoteOf(args.pool_ids, args.input_token, BigInt(args.input_amount))) });
    else result = enc(null);
    result = { result };
  } else if (b.method === 'query' && p.request_type === 'view_access_key') result = { nonce: 5, permission: 'FullAccess', block_hash: '11111111111111111111111111111111' };
  else if (b.method === 'query' && p.request_type === 'view_account') result = { amount: String(500n * NEAR), storage_usage: 1000 };
  else if (b.method === 'send_tx') {
    const raw = Buffer.from(p.signed_tx_base64, 'base64').toString('latin1'); const i = raw.indexOf('{"receiver_id"');
    if (i >= 0) { try { const args = JSON.parse(raw.slice(i, raw.indexOf("}\"}", i) + 3)); SENT.push(JSON.parse(args.msg).Swap); } catch {} }
    result = { transaction: { hash: 'h' + SENT.length } };
  } else if (b.method === 'tx') result = { status: { SuccessValue: Buffer.from('"1"').toString('base64') }, transaction_outcome: { id: p.tx_hash, outcome: { gas_burnt: 1 } }, receipts_outcome: [] };
  else result = {};
  return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};
const ne = await import('../src/nearEngine.ts');
const KEY = '0x' + '11'.repeat(32);   // dummy test key, not a real wallet
let n = 0;
const wallet = () => ({ id: 'w' + (++n), name: 'w', address: '0x0', key: '0x' + (n + 16).toString(16).padStart(2, '0').repeat(32) });
const lastSwap = () => SENT.at(-1);
const sell = async (token, pct = 100) => { const before = SENT.length; const r = await ne.nearRoute(token); await new Promise((ok) => setTimeout(ok, 5)); await ne.nearTradeOne(wallet(), 'sell', r, pct, 12); assert.ok(SENT.length > before, 'a swap was signed'); return { r, sw: lastSwap() }; };
const buy = async (token, nearAmt) => { const before = SENT.length; const r = await ne.nearRoute(token); await new Promise((ok) => setTimeout(ok, 5)); await ne.nearTradeOne(wallet(), 'buy', r, nearAmt, 12); assert.ok(SENT.length > before, 'a swap was signed'); return { r, sw: lastSwap() }; };
// fair: 1 QTC = 0.1 NEAR; coin pools pay 0.99 quote per coin
const FAIR_NEAR_PER_QU = (NEAR / 10n);
const coinPool = (coin, quote) => { const id = [coin, quote].sort().join('|') + '|10000'; pool(id, lin(99n, 100n), lin(99n, 100n)); LAUNCH.set(coin, { pool_id: id, step: 'Done', quote, symbol: 'C' }); return id; };
// an honest, deep NEAR ↔ quote tier: 1 % fee each way
const honest = (quote, fee) => { const [x, y] = [quote, 'wrap.near'].sort(); const id = `${x}|${y}|${fee}`; const toNear = lin(FAIR_NEAR_PER_QU * 99n, QU * 100n), toQ = lin(QU * 99n, FAIR_NEAR_PER_QU * 100n); pool(id, x === quote ? toNear : toQ, x === quote ? toQ : toNear); return id; };
// the seeded tier: quote coin 9x too cheap for up to 0.2 NEAR (wins the 0.1 NEAR probe), NEAR bought back at 1/1000 of fair
const seeded = (quote, fee) => { const [x, y] = [quote, 'wrap.near'].sort(); const id = `${x}|${y}|${fee}`; const toNear = lin(FAIR_NEAR_PER_QU, QU * 1000n), toQ = lin(QU * 9n, FAIR_NEAR_PER_QU, 2e23); pool(id, x === quote ? toNear : toQ, x === quote ? toQ : toNear); return id; };
const nearOf = (v) => Number(BigInt(v)) / 1e24;

test('NEAR-1: a seeded one-sided tier beside the honest one — the sell is not routed through it, its minimum is the honest one', async () => {
  const cp = coinPool('coina.near', 'qtc.omft.near'); const good = honest('qtc.omft.near', 10000); const bad = seeded('qtc.omft.near', 100);
  const { r, sw } = await sell('coina.near');
  assert.ok(!sw.pool_ids.includes(bad), `the sell went through the seeded tier ${bad} (route.bridgePool=${r.bridgePool}); signed minimum ${nearOf(sw.min_output_amount)} NEAR`);
  assert.deepEqual(sw.pool_ids, [cp, good]);
  assert.equal(sw.output_token, 'wrap.near');
  // 1000 coins → 990 QTC → ~98 NEAR; minimum after 12 % slippage ≈ 86 NEAR
  assert.ok(nearOf(sw.min_output_amount) > 80, `signed minimum ${nearOf(sw.min_output_amount)} NEAR`);
});

test('NEAR-1: the only NEAR tier of a quote was made by someone (no trusted pool) — the sell pays out in the quote coin, never through that tier', async () => {
  const cp = coinPool('coinb.near', 'eth.bridge.near'); const bad = seeded('eth.bridge.near', 100);
  const { r, sw } = await sell('coinb.near');
  assert.ok(!sw.pool_ids.includes(bad), `the sell went through ${bad}: minimum ${nearOf(sw.min_output_amount)} NEAR`);
  assert.equal(r.bridgePool, null);
  assert.deepEqual(sw.pool_ids, [cp]); assert.equal(sw.output_token, 'eth.bridge.near'); assert.ok(sw.swap_out_recipient);
  assert.ok(BigInt(sw.min_output_amount) > (990n * QU * 88n) / 100n - QU, 'the minimum is the coin leg\'s own quote less the slippage');
});

test('NEAR-1: a buy of that coin is refused as for any quote without a NEAR pool (b1 bought through the made-up tier)', async () => {
  const r = await ne.nearRoute('coinb.near');
  await assert.rejects(ne.nearTradeOne(wallet(), 'buy', r, 0.1, 12), /has no NEAR → .* pool/);
});

test('NEAR-1: a TRUSTED tier drained one-sided (sells back 1/50) is skipped by the two-sided check; the other trusted tier is used', async () => {
  const U = 'usdt.tether-token.near'; const cp = coinPool('coinc.near', U); const good = honest(U, 2000);
  const thin = `${U}|wrap.near|100`; pool(thin, lin(FAIR_NEAR_PER_QU, QU * 50n), lin(QU * 101n, FAIR_NEAR_PER_QU * 100n));   // buys a bit better than fair, sells back 1/50
  const r = await ne.nearRoute('coinc.near'); await new Promise((ok) => setTimeout(ok, 20));
  const { sw } = await sell('coinc.near');
  assert.ok(!sw.pool_ids.includes(thin), `sold through the one-sided tier: minimum ${nearOf(sw.min_output_amount)} NEAR`);
  assert.deepEqual(sw.pool_ids, [cp, good]);
  assert.ok(nearOf(sw.min_output_amount) > 80);
  void r;
});

test('NEAR-1: a trusted tier too thin for this size (bridge leg fills at half the small rate) — the sell pays out in the quote coin', async () => {
  const Z = 'zec.omft.near'; const cp = coinPool('coind.near', Z);
  const id = `wrap.near|${Z}|10000`;   // honest at small size; above 10 ZEC in, half the price
  const toNear = (a) => (a > 10n * QU ? (a * FAIR_NEAR_PER_QU * 99n) / (QU * 200n) : (a * FAIR_NEAR_PER_QU * 99n) / (QU * 100n));
  pool(id, lin(QU * 99n, FAIR_NEAR_PER_QU * 100n), toNear);
  const { sw } = await sell('coind.near');
  assert.deepEqual(sw.pool_ids, [cp]); assert.equal(sw.output_token, Z);
});

test('control: an honest bridged sell and buy sign the same pools and minimum as before', async () => {
  const cp = coinPool('coine.near', 'prl.omft.near'); const good = honest('prl.omft.near', 10000);
  const { sw } = await sell('coine.near');
  assert.deepEqual(sw.pool_ids, [cp, good]); assert.equal(sw.output_token, 'wrap.near');
  const out = quoteOf([cp, good], 'coine.near', 1000n * QU); assert.equal(sw.min_output_amount, String((out * 8800n) / 10000n));
  const b = await buy('coine.near', 1);
  assert.deepEqual(b.sw.pool_ids, [good, cp]);
  const got = quoteOf([good, cp], 'wrap.near', NEAR); assert.equal(b.sw.min_output_amount, String((got * 8800n) / 10000n));
});

test('control: a NEAR-quoted coin sells and buys exactly as before (no bridge)', async () => {
  const cp = coinPool('coinf.near', 'wrap.near');
  const { sw } = await sell('coinf.near', 50);
  assert.deepEqual(sw.pool_ids, [cp]); assert.equal(sw.output_token, 'wrap.near');
  assert.equal(sw.min_output_amount, String((quoteOf([cp], 'coinf.near', 500n * QU) * 8800n) / 10000n));
  const b = await buy('coinf.near', 2);
  assert.deepEqual(b.sw.pool_ids, [cp]);
});

test('NEAR-1 latency: a bridged sell on a warm route still waits one round trip for its quotes (all tiers at once)', async () => {
  coinPool('coing.near', 'usdt.tether-token.near'); honest('usdt.tether-token.near', 100); honest('usdt.tether-token.near', 2000);   // two trusted tiers
  const r = await ne.nearRoute('coing.near'); await new Promise((ok) => setTimeout(ok, 50));   // the page's preview warmed the route
  const w = wallet(); await ne.nearPrewarm(w);
  RTT = 40; calls = [];
  const t0 = performance.now(); await ne.nearTradeOne(w, 'sell', r, 100, 12); const ms = performance.now() - t0; RTT = 0;
  // round trips before the signed send = clusters of requests (the next one starts when the previous answered)
  const reqs = calls.filter((c) => c[1][0] === '*' && c[1] !== '*tx'); const waves = [];
  for (const c of reqs) { if (!waves.length || c[0] - waves.at(-1)[0] > 20) waves.push([c[0], []]); waves.at(-1)[1].push(c[1].slice(1)); }
  const quoteWaves = waves.filter((x) => x[1].some((m) => m.endsWith(':quote')));
  console.log('sell timeline:', JSON.stringify(waves.map((x) => [Math.round(x[0] - t0), x[1].join(' ')])), `${ms.toFixed(0)} ms`);
  assert.equal(quoteWaves.length, 1, 'every quote of the sell goes out in one round trip');
  // balance + registrations, quotes, send: 3 round trips, as before the fix
  assert.ok(waves.length <= 3, `${waves.length} round trips`);
});
