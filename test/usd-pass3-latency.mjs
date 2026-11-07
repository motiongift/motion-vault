// USD balance pass 3, latency (2026-11-01, owner “full go-ahead … bring it up to fomo's level”, hard rule “we can never lose users' money, strictly”; spec local foreman/fix2-usd.md "Proposals" A1, A3):
//   A1  ready dollars: on every chain the user bought on in the last 7 days a routine background tick keeps the reserve R at 1.5 x
//       the ready size, moved in from the richest other EVM reserve through the public bridges (Relay → deBridge, every check
//       of a rebalance), from $10 instead of $100 on such chains; a click on that chain is then a direct buy from its own reserve
//       instead of a cross-chain top-up. Bounded: fee ≤ $0.10 + 0.5 % per move, ≤ $1 per wallet per 24 h, never on a click's
//       plan, never on an old snapshot, never while a move into that chain is open or after one whose arrival the snapshot
//       predates.
//   A3  motion's solver answers 'paid' at the payout's broadcast when the vault asks (`early`); the vault follows the job as
//       'relaying' and makes it 'arrived' only on chain evidence: the solver's 'filled' or this frame's own look at the payout
//       on its chain. The next part of a click waits for the part before it to arrive, as before.
//   node --experimental-strip-types --test test/usd-pass3-latency.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, toHex, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import { createFloat } from '../src/floatEngine.ts';
import { createSolverBridge } from '../src/bridgeSolver.ts';
import * as F from '../src/floatCore.ts';
import * as C from '../src/motionBridgeCore.ts';
import { setRelayProxyBase } from '../src/relayApi.ts';
setRelayProxyBase(() => 'https://motion.test');

const lc = (a) => String(a).toLowerCase();
const RH = F.FLOAT_CFG.robinhood, BSCC = F.FLOAT_CFG.bsc, SOLC = F.FLOAT_CFG.sol;
const ETH6 = 4000n * F.USD, BNB6 = 700n * F.USD, SOL6 = 100n * F.USD;

// ══ A1: the planner (pure) ══
const NOW = Date.now();
const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
// W's float full on each chain (above its target, under its high band): only the reserves can want anything
const rhFull = (o = {}) => cs({ price6: ETH6, float: RH.gasFloor + 20_000_000_000_000_000n /* $80 */, reserveNative: RH.reserveGas, ...o });
const solFull = (o = {}) => cs({ price6: SOL6, float: SOLC.gasFloor + 800_000_000n /* $80 */, reserveNative: SOLC.reserveGas, ...o });
const bscFull = (o = {}) => cs({ price6: BNB6, float: BSCC.gasFloor + 120_000_000_000_000_000n /* $84 */, reserveNative: BSCC.reserveGas, ...o });
const usdg = (usd) => BigInt(Math.round(usd * 1e6));            // RH USDG and SOL USDC: 6 decimals
const usdcBsc = (usd) => BigInt(Math.round(usd * 1e6)) * 10n ** 12n;   // BNB USDC: 18 decimals
function plan(chains, o = {}) {
  return F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(1000), movedToday6: 0n, feesToday6: 0n, estFee6: () => F.usd6(0.05),
    ...(o.ready !== false ? { ready: { feesDay6: o.feesDay6 ?? 0n, from: ['robinhood', 'bsc'] } } : {}), ...(o.urgent ? { urgent: o.urgent } : {}) });
}
const rebalances = (p) => p.moves.filter((m) => m.kind === 'rebalance');

test('A1 planner: a traded chain whose reserve is empty gets 1.5 x its ready size from the richest EVM reserve, flagged ready (before: nothing — W\'s float was full)', () => {
  const chains = { robinhood: rhFull({ reserve: usdg(500) }), sol: solFull({ traded: true, readyOk: true }) };
  const p = plan(chains);
  const r = rebalances(p);
  assert.equal(r.length, 1, JSON.stringify(p.moves, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(r[0].chain, 'sol'); assert.equal(r[0].from, 'robinhood'); assert.equal(r[0].usd6, F.readyTarget6([F.usd6(50)], []));
  assert.equal(r[0].usd6, F.usd6(75), '1.5 x the $50 preset');
  assert.equal(r[0].ready, true); assert.equal(r[0].reason, F.READY.reason);
  // the same plan without the background's ready input (a click, the refill, an older caller): exactly as before
  assert.equal(rebalances(plan(chains, { ready: false })).length, 0);
});

test('A1 planner: hysteresis — a reserve at 60 % of its ready size or more is left alone; under it, it is filled TO the size', () => {
  assert.equal(rebalances(plan({ robinhood: rhFull({ reserve: usdg(500) }), sol: solFull({ traded: true, readyOk: true, reserve: usdg(45) }) })).length, 0, '$45 of $75 = 60 %');
  const r = rebalances(plan({ robinhood: rhFull({ reserve: usdg(500) }), sol: solFull({ traded: true, readyOk: true, reserve: usdg(40) }) }));
  assert.equal(r.length, 1); assert.equal(r[0].usd6, F.usd6(35));
  // a want under the $10 minimum never moves (a $10 ready size at 55 % wants $4.50)
  assert.equal(rebalances(plan({ robinhood: rhFull({ reserve: usdg(500) }), sol: solFull({ traded: true, readyOk: true, presets6: [F.usd6(5)], reserve: usdg(5.5) }) })).length, 0);
});

test('A1 planner: small balances — $40 on Robinhood funds a traded Solana from $10 (before: the cross-chain minimum was $100, so nothing ever moved)', () => {
  // W's Solana float is empty too: the float's own rebalance takes the low minimum on a traded chain, and the reserve pass adds nothing on top
  const chains = { robinhood: rhFull({ reserve: usdg(40) }), sol: solFull({ traded: true, readyOk: true, presets6: [F.usd6(10)], float: SOLC.gasFloor }) };
  const r = rebalances(plan(chains));
  assert.equal(r.length, 1, 'one move into Solana per plan');
  assert.equal(r[0].usd6, F.usd6(15), 'the float lacks $15 (1.5 x $10)'); assert.equal(r[0].ready, true, 'under $100: a ready-dollar move');
  assert.equal(rebalances(plan(chains, { ready: false })).length, 0, 'before: a $40 donor is under the $100 cross-chain minimum');
});

test('A1 planner: a donor the user also trades keeps its own ready size (no ping-pong); Solana never sends (no public bridge signs from it)', () => {
  const r = rebalances(plan({ robinhood: rhFull({ reserve: usdg(100), traded: true, readyOk: true }), sol: solFull({ traded: true, readyOk: true }) }));
  assert.equal(r.length, 1); assert.equal(r[0].usd6, F.usd6(25), 'Robinhood keeps its $75');
  // both traded, both short: nobody gives
  assert.equal(rebalances(plan({ robinhood: rhFull({ reserve: usdg(30), traded: true, readyOk: true }), sol: solFull({ traded: true, readyOk: true }) })).length, 0);
  // only Solana's reserve holds dollars: a traded BNB gets nothing from it
  assert.equal(rebalances(plan({ robinhood: rhFull(), sol: solFull({ reserve: usdg(900) }), bsc: bscFull({ traded: true, readyOk: true }) })).length, 0);
  // BNB (18-decimal USDC) as the donor works the same
  const b = rebalances(plan({ robinhood: rhFull(), bsc: bscFull({ reserve: usdcBsc(300) }), sol: solFull({ traded: true, readyOk: true }) }));
  assert.equal(b.length, 1); assert.equal(b[0].from, 'bsc'); assert.equal(b[0].usd6, F.usd6(75));
});

test('A1 planner: never — on a click\'s plan, on a chain not traded, on an old snapshot, while a move into it is open or in flight, or once the day\'s $1 is spent', () => {
  const base = () => ({ robinhood: rhFull({ reserve: usdg(500) }), sol: solFull({ traded: true, readyOk: true }) });
  assert.equal(rebalances(plan(base())).length, 1, 'control');
  // a click (urgent) on Robinhood, which its own reserve covers: no ready-dollar move rides on it
  assert.equal(rebalances(plan(base(), { urgent: { chain: 'robinhood', usd6: F.usd6(20) } })).length, 0);
  const x = base(); delete x.sol.traded; assert.equal(rebalances(plan(x)).length, 0, 'no buy there in 7 days');
  const y = base(); delete y.sol.readyOk; assert.equal(rebalances(plan(y)).length, 0, 'snapshot too old or older than the last arrival');
  const z = base(); z.sol.busyBridge = true; assert.equal(rebalances(plan(z)).length, 0, 'a cross-chain move into it started under 2 min ago');
  const v = base(); v.sol.inFlightReserve6 = F.usd6(75); assert.equal(rebalances(plan(v)).length, 0, 'a rebalance into it is in flight');
  assert.equal(rebalances(plan(base(), { feesDay6: F.READY.dayFees6 })).length, 0, 'the day budget is spent');
  // rel-12 (READY_ROUTES): the bound is $0.10 + 0.75 % of the move (rel-10: $0.10 + 0.5 % = $0.475 here)
  assert.equal(F.readyFeeMax6(F.usd6(75)), F.usd6(0.6625), '$0.10 + 0.75 %');
});

// ══ A1: the engine, a Robinhood frame (the donor) on a mocked chain with Relay / deBridge answering like their APIs ══
const ERC20 = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const RELAY_ABI = [{ name: 'depositErc20', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'depositor', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'id', type: 'bytes32' }], outputs: [] }];
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
function rhWorld(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
  const ch = { eth: new Map([[lc(W), RH.gasFloor + 20_000_000_000_000_000n], [lc(R), RH.reserveGas]]), usdg: new Map([[lc(R), o.rUsdg ?? usdg(500)]]), allow: new Map(), receipts: new Map(), txs: [], deposits: [], n: 0 };
  const exec = (from, tx, apply) => {
    const to = lc(tx.to);
    if (to === lc(RH.stable.address)) { const d = decodeFunctionData({ abi: ERC20, data: tx.data }); if (d.functionName === 'approve' && apply) ch.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]); return '0x' + '1'.padStart(64, '0'); }
    if (to === DEPOSITORY) {
      const d = decodeFunctionData({ abi: RELAY_ABI, data: tx.data }); const al = ch.allow.get(`${lc(from)}>${DEPOSITORY}`) ?? 0n;
      if (al < d.args[2]) throw new Error('execution reverted: allowance');
      if (apply) { ch.allow.set(`${lc(from)}>${DEPOSITORY}`, al - d.args[2]); ch.usdg.set(lc(from), ch.usdg.get(lc(from)) - d.args[2]); ch.deposits.push({ bridge: 'relay', from, amount: d.args[2] }); }
      return '0x';
    }
    throw new Error('test: unexpected call to ' + tx.to);
  };
  const send = (from, tx) => { const hash = keccak256(toHex(`${from}:${ch.n++}:${tx.data}`)); let status = 'success'; try { exec(from, tx, true); } catch { status = 'reverted'; } ch.txs.push({ from, ...tx, hash }); ch.receipts.set(hash, status); return hash; };
  const word = (h) => lc(h).replace(/^0x/, '').padStart(64, '0');
  const fetchLog = [];
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  const fetchFn = async (url, init) => {
    fetchLog.push(String(url));
    if (url.startsWith('https://api.relay.link/requests/v2')) return ok({ requests: [] });
    if (url === 'https://api.relay.link/quote/v2') {
      const b = JSON.parse(init.body); const amount = BigInt(b.amount);
      return ok({ steps: [
        { id: 'approve', kind: 'transaction', items: [{ data: { to: RH.stable.address, data: '0x095ea7b3' + word(DEPOSITORY) + word(amount.toString(16)), value: '0' } }] },
        { id: 'deposit', kind: 'transaction', requestId: '0x' + 'e1'.repeat(32), items: [{ data: { to: DEPOSITORY, data: '0xe8017952' + word(b.user) + word(RH.stable.address) + word(amount.toString(16)) + 'ab'.repeat(32), value: '0' } }] },
      ], details: { currencyOut: { amount: String(amount * 999n / 1000n), minimumAmount: String(amount * 997n / 1000n) }, recipient: b.recipient, timeEstimate: 1 },
      fees: { relayer: { amountUsd: String(o.relayFeeUsd ?? 0.07) }, gas: { amountUsd: '0.005' } } });
    }
    if (url.startsWith('https://api.relay.link/intents/status')) return ok({ status: o.relayStatus || 'success' });
    if (url.startsWith('https://dln.debridge.finance/v1.0/dln/order/create-tx')) {
      const q = new URL(url).searchParams; const amount = BigInt(q.get('srcChainTokenInAmount'));
      return ok({ tx: { to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66', data: '0xb9303701' + '00'.repeat(64), value: '1000000000000000' }, estimation: { dstChainTokenOut: { amount: String(amount * 990n / 1000n) } }, fixFee: '1000000000000000', orderId: '0xorder', order: { approximateFulfillmentDelay: 4 } });
    }
    if (url.startsWith('https://price-api.mayan.finance')) return ok({ quotes: [] });
    throw new Error('test: unexpected fetch ' + url);
  };
  const store = new Map(); const events = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
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
    sol: { balance: async () => 0n, usdc: async () => 0n, oracle6: async () => SOL6, fees: async () => { throw new Error('defaults'); }, quote: async () => 0n, topup: async () => 'x', sweep: async () => 'x', gas: async () => 'x', status: async () => 'confirmed' },
    ask: async () => true, gate: async () => {}, html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h }, now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: (d) => events.push(d), fetch: fetchFn, click: () => click, wait: async () => {},
  };
  const f = createFloat(deps);
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
  // the Solana frame's snapshot as that frame wrote it: W's float full, R's USDC `reserveUsd`, written `at`
  const solSnap = (reserveUsd, at = Date.now()) => store.set(`trenches.float.v1.snap.sol.${lc(W)}`, JSON.stringify({ at, chain: 'sol', price6: String(SOL6), priceAt: at, float: String(SOLC.gasFloor + 800_000_000n), reserve: String(usdg(reserveUsd)), reserveNative: String(SOLC.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [String(F.usd6(50))] }));
  // a buy of $50 on Solana an hour ago (what noteBuy / the page's 'fill' report records)
  const tradedSol = (agoMs = 3_600_000) => store.set(`trenches.float.v1.prefs.sol.${lc(W)}`, JSON.stringify({ presets6: [String(F.usd6(50))], buys6: [String(F.usd6(50))], buysAt: [Date.now() - agoMs], activeAt: Date.now() - agoMs }));
  const on = async () => { await f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] }); for (const k of [...store.keys()]) if (k.startsWith('trenches.float.v1.order.')) store.delete(k); };
  const tick = async () => { await f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await settle(); };
  const jobs = async () => (await f.jobs({ walletId: 'w1' })).jobs;
  return { f, ch, W, R, store, events, fetchLog, settle, solSnap, tradedSol, on, tick, jobs, click };
}

test('A1 engine: the Robinhood frame pre-positions $75 into the reserve of a chain the user trades (Solana) through Relay — exact approval, R as depositor, flagged ready, its cost in the ledger', async () => {
  const wd = rhWorld(); await wd.on(); wd.tradedSol(); wd.solSnap(0);
  await wd.tick();
  const j = (await wd.jobs()).find((x) => x.kind === 'rebalance');
  assert.ok(j, 'a ready-dollar move ran: ' + JSON.stringify(await wd.jobs()));
  assert.equal(j.chain, 'sol'); assert.equal(j.from, 'robinhood'); assert.equal(j.ready, true); assert.equal(j.reason, F.READY.reason);
  assert.equal(j.bridge, 'relay'); assert.equal(j.state, 'relaying');
  assert.equal(wd.ch.deposits.length, 1); assert.equal(lc(wd.ch.deposits[0].from), lc(wd.R)); assert.equal(wd.ch.deposits[0].amount, usdg(75));
  const appr = wd.ch.txs.find((t) => lc(t.to) === lc(RH.stable.address));
  assert.equal(decodeFunctionData({ abi: ERC20, data: appr.data }).args[1], usdg(75), 'an exact approval');
  const q = wd.events.find((e) => e.step === 'quote' && e.ready);
  assert.ok(q && q.usd === 75 && q.from === 'robinhood' && q.chain === 'sol' && Math.abs(q.fee - 0.08) < 1e-9, 'logged with its cost (rel-12: the delivery is $0.075 under the amount, more than the $0.07 stated; + $0.005 gas): ' + JSON.stringify(q));
  const st = await wd.f.status({ walletId: 'w1' });
  assert.ok(st.usd.readyFeesWeek >= 0.075 && st.usd.readyFeesWeek < 0.2, 'stated apart: ' + st.usd.readyFeesWeek);
  assert.equal(st.usd.readyMovedWeek, 75);
});

test('A1 engine: no second move on the same read — open (busy), then arrived but the Solana snapshot predates the arrival; a fresh read decides again', async () => {
  const wd = rhWorld(); await wd.on(); wd.tradedSol(); wd.solSnap(0);
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 1);
  await wd.tick();   // reconcile: Relay says success → arrived; Solana's snapshot is the one from before
  const rb = (await wd.jobs()).filter((x) => x.kind === 'rebalance');
  assert.equal(rb.length, 1); assert.equal(rb[0].state, 'arrived');
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 1, 'an old read of Solana (it still shows $0) moves nothing more');
  wd.solSnap(75, Date.now() + 5);   // Solana's frame read its reserve after the arrival
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 1, 'at its ready size: nothing');
});

test('A1 engine: a quote over the fee bound is never signed — Relay at $0.705 for $75 (bound $0.6625 since rel-12), deBridge with its fixed fee: nothing sent, nothing counted', async () => {
  const wd = rhWorld({ relayFeeUsd: 0.7 }); await wd.on(); wd.tradedSol(); wd.solSnap(0);
  await wd.tick();
  assert.equal(wd.ch.deposits.length, 0); assert.equal(wd.ch.txs.length, 0, 'no approval either');
  // rel-12 (READY_HOLD): a refusal before any send is no job (no "Moved …" row); the route backs off with the reason kept
  assert.equal((await wd.jobs()).find((x) => x.kind === 'rebalance'), undefined);
  const hold = JSON.parse(wd.store.get(`trenches.float.v1.readyhold.${lc(wd.W)}`) || '{}')['robinhood>sol'];
  assert.equal(hold.n, 1); assert.match(hold.why, /Every bridge refused/);
  assert.equal(F.readyFeesOf(await wd.jobs(), Date.now()).day6, 0n, 'a refusal costs nothing');
});

test('A1 engine: guards — no buy on Solana in 7 days, or the day\'s $1 spent, or a click: no ready-dollar move', async () => {
  const a = rhWorld(); await a.on(); a.tradedSol(8 * 86_400_000); a.solSnap(0);
  await a.tick(); assert.equal(a.ch.deposits.length, 0, 'last buy 8 days ago');
  const b = rhWorld(); await b.on(); b.tradedSol(); b.solSnap(0);
  // $1 of ready-dollar fees in the last 24 h (an earlier move that left)
  b.store.set(`trenches.float.v1.jobs.robinhood.${lc(b.W)}`, JSON.stringify([{ id: 'x1', walletId: 'w1', kind: 'rebalance', chain: 'bsc', from: 'robinhood', usd6: String(F.usd6(80)), fee6: String(F.usd6(1)), state: 'arrived', at: Date.now() - 3_600_000, updatedAt: Date.now() - 3_000_000, hashes: ['0xa'], reason: F.READY.reason, ready: true }]));
  await b.tick(); assert.equal(b.ch.deposits.length, 0, 'the day budget');
  const c = rhWorld(); await c.on(); c.tradedSol(); c.solSnap(0);
  const r = await c.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 10, reason: 'click' }); await c.settle();
  assert.ok(!(r.planned || []).some((m) => m.kind === 'rebalance'), JSON.stringify(r.planned));
  assert.equal(c.ch.deposits.length, 0, 'a click never carries a pre-position');
});

// ══ A3: motion's 'paid' at the payout's broadcast — a BNB frame whose dollars sit in the Robinhood reserve ══
const b58 = (b) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };
const rnd32 = () => Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
let BNB_SQRT = 0n;
{ const want = BNB6; let lo = 1n, hi = 1n << 200n;
  for (let i = 0; i < 400 && lo < hi; i++) { const mid = (lo + hi) / 2n; const p = F.oraclePrice6(mid, BSCC.oracle); if (BSCC.oracle.nativeIsToken0 ? p < want : p > want) lo = mid + 1n; else hi = mid; }
  BNB_SQRT = lo; }
// a virtual clock (the part wait looks every 150 ms for up to 6 s): deps.wait moves it
function bnbWorld(o = {}) {
  const T = { t: Date.now() };
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const sol = { W: b58(ed25519.getPublicKey(rnd32())), R: b58(ed25519.getPublicKey(rnd32())) };
  const seed = rnd32(); const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposits = { robinhood: privateKeyToAccount(generatePrivateKey()).address, bsc: privateKeyToAccount(generatePrivateKey()).address, sol: b58(ed25519.getPublicKey(rnd32())) };
  // payouts: hash → { at (lands), amount, reverts }; W's BNB = its own + every landed payout − what its buys spent
  const st = { wBnb: BSCC.gasFloor, spent: 0n, quotes: new Map(), ledger: [], fills: [], bodies: [], payouts: new Map(), landMs: o.landMs ?? 400, never: !!o.never, statusOf: o.statusOf || (() => 'paid'), early: o.early !== false };
  const landed = () => [...st.payouts.values()].filter((p) => !p.reverts && T.t >= p.at).reduce((s, p) => s + p.amount, 0n);
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const solverFetch = async (url, init) => {
    const path = String(url).split('/api/bridge/motion')[1] || '';
    if (path.startsWith('/health')) return json({ ok: true, on: true, solver: pub, chains: ['robinhood', 'bsc', 'sol'], deposits, maxFillUsd: 1000, minFillUsd: 0.1, feeBps: 0 });
    if (path.startsWith('/quote')) {
      const b = JSON.parse(init.body);
      const usd6 = C.stableToUsd6(BigInt(b.amount), C.bridgeCfg(b.from).stable.decimals);
      const use = C.useOf(st.ledger, b.recipient, Date.now());
      const why = C.quoteRefusal({ on: true, from: b.from, to: b.to, usd6, caps: { ...C.DEFAULT_CAPS, perFill6: 1000n * C.USD6 }, use, dstInventory6: 1_000_000n * C.USD6, dstPrice6: 700n * C.USD6 });
      if (why) return json({ ok: false, reason: why });
      const { out, fee6 } = C.quoteOut(usd6, 700n * C.USD6, b.to, 0);
      const at = Date.now();
      const q = { v: 1, id: Buffer.from(rnd32().slice(0, 16)).toString('hex'), src: { chain: b.from, token: C.bridgeCfg(b.from).stable.address, amount: String(b.amount), depositor: b.depositor, deposit: deposits[b.from] },
        dst: { chain: b.to, recipient: b.recipient, amount: String(out) }, price6: String(700n * C.USD6), fee6: String(fee6), usd6: String(usd6), issuedAt: at, expiresAt: at + 45_000, solver: pub };
      st.quotes.set(q.id, q); st.ledger.push({ id: q.id, at, state: 'quoted', usd6: String(usd6), user: b.recipient });
      return json({ ok: true, quote: q, sig: C.signQuote(q, seed), etaMs: 1200 });
    }
    if (path.startsWith('/fill')) {
      const b = JSON.parse(init.body); st.bodies.push(b); const q = st.quotes.get(b.id);
      const tx = parseTransaction(b.raw); const from = await recoverTransactionAddress({ serializedTransaction: b.raw });
      const why = C.evmSourceProblem(tx, from, q); if (why) return json({ ok: false, state: 'failed', error: why });
      const srcHash = keccak256(b.raw); const dstHash = keccak256(toHex('payout:' + q.id));
      st.fills.push({ id: q.id, at: T.t, usd6: BigInt(q.usd6) });
      const rec = st.ledger.find((x) => x.id === q.id);
      if (b.early && st.early) {
        // the A3 solver: answered at the broadcast; the payout lands landMs later (or never)
        st.payouts.set(dstHash, { at: st.never ? Infinity : T.t + st.landMs, amount: BigInt(q.dst.amount), reverts: !!o.reverts, id: q.id });
        rec.state = 'paid';
        return json({ ok: true, state: 'paid', srcHash, dstHash, early: true });
      }
      // the solver as before: it waits until it sees the payout, then 'filled'
      st.payouts.set(dstHash, { at: T.t, amount: BigInt(q.dst.amount), id: q.id });
      rec.state = 'filled';
      return json({ ok: true, state: 'filled', srcHash, dstHash });
    }
    if (path.startsWith('/status')) {
      const id = new URL('https://x' + path).searchParams.get('id'); const p = [...st.payouts.entries()].find(([, v]) => v.id === id);
      return json({ ok: true, state: st.statusOf(id, T.t), dstHash: p ? p[0] : null });
    }
    throw new Error('test: unexpected motion path ' + path);
  };
  const store = new Map(); let nonce = 0; const receipts = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const deps = {
    chain: () => 'bsc',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W.address, sol: sol.W }, r: { evm: R.address, sol: sol.R } }; },
    evm: {
      call: async () => '0x', balance: async (a) => (lc(a) === lc(R.address) ? BSCC.reserveGas : lc(a) === lc(W.address) ? st.wBnb + landed() - st.spent : 0n), erc20: async () => 0n,
      allowance: async () => 0n, slot0: async () => BNB_SQRT, fees: async () => ({ baseFee: 1_000_000_000n, gasPrice: 1_000_000_000n, l1PerByte: 0n }),
      estimate: async () => 150_000n, sendR: async () => { throw new Error('test: nothing broadcast by the vault here'); }, sendW: async () => { throw new Error('test: nothing broadcast by the vault here'); },
      // the BNB frame's own look at a payout: a receipt once it landed (reverted for a payout that reverts)
      receipt: async (h) => { receipts.push(h); const p = st.payouts.get(h); if (!p || T.t < p.at) return null; return { status: p.reverts ? 'reverted' : 'success' }; },
    },
    sol: { balance: async () => 0n, usdc: async () => 0n, oracle6: async () => SOL6, fees: async () => { throw new Error('defaults'); }, quote: async () => 0n, topup: async () => { throw new Error('no'); }, sweep: async () => 'x', gas: async () => 'x', status: async () => 'confirmed' },
    solver: {
      base: () => 'https://motion.gift', pinnedKey: () => pub,
      signEvmTransfer: async (a) => { const raw = await R.signTransaction({ to: a.token, data: C.erc20TransferData(a.to, a.amount), value: 0n, gas: 120_000n, gasPrice: 20_000_000n, nonce: nonce++, chainId: C.bridgeCfg(a.chain).chainId, type: 'legacy' }); return { raw, hash: keccak256(raw) }; },
      signSolTransfer: async () => { throw new Error('no'); },
    },
    ask: async () => true, gate: async () => {}, html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => T.t,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {},
    fetch: async (url, init) => { const u = String(url); if (u.includes('/api/bridge/motion')) return solverFetch(u, init); return { ok: false, status: 503, json: async () => ({ message: 'no public bridge in this test' }) }; },
    click: () => click, wait: async (ms) => { T.t += ms; },
  };
  const f = createFloat(deps);
  const rhSnap = (reserveUsd) => store.set(`trenches.float.v1.snap.robinhood.${lc(W.address)}`, JSON.stringify({ at: T.t, chain: 'robinhood', price6: String(ETH6), priceAt: T.t, float: String(RH.gasFloor), reserve: String(F.usd6(reserveUsd)), reserveNative: String(RH.reserveGas), inFlight6: '0', inFlightReserve6: '0', active: true, presets6: [String(F.usd6(50))], buys6: [] }));
  const on = async () => { await f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] }); for (const k of [...store.keys()]) if (k.startsWith('trenches.float.v1.order.')) store.delete(k); };
  const colds = async () => (await f.jobs({ walletId: 'w1' })).jobs.filter((j) => j.kind === 'cold');
  const clickBuy = (usd) => f.ensure({ walletId: 'w1', chain: 'bsc', usd, reason: 'click' });
  const tick = () => f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'tick' }).then(async (r) => { for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x)); T.t += 400; await new Promise((x) => setTimeout(x, 5)); for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x)); return r; });
  return { f, st, T, store, rhSnap, on, colds, clickBuy, tick, receipts, W: W.address };
}

test('A3 bridgeSolver: the fill asks the solver for the early answer (an older solver ignores the field)', async () => {
  const bodies = [];
  const s = createSolverBridge({ base: () => 'https://m', now: () => Date.now(), pinnedKey: () => 'ab'.repeat(32), signEvmTransfer: async () => ({ raw: '0x01', hash: '0x' + '11'.repeat(32) }), signSolTransfer: async () => { throw new Error('no'); },
    fetch: async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, state: 'paid', dstHash: '0x' + '22'.repeat(32) }) }; } });
  const q = { id: 'ab'.repeat(16), src: { chain: 'robinhood', token: RH.stable.address, deposit: '0x' + '33'.repeat(20), amount: '1000000' } };
  const r = await s.fill(q, 'sig', 'w1', { early: true });
  assert.equal(bodies[0].early, true); assert.equal(r.state, 'paid'); assert.equal(r.dstHash, '0x' + '22'.repeat(32));
  await s.fill(q, 'sig', 'w1'); assert.equal('early' in bodies[1], false, 'not asked = the body of before');
});

test('A3 engine: a click\'s cold top-up answered "paid" at the broadcast is relaying with the payout\'s hash (the click is moving); it arrives only once THIS chain shows the payout landed', async () => {
  const wd = bnbWorld({ landMs: 400 }); await wd.on(); wd.rhSnap(2500);
  const r = await wd.clickBuy(50);
  assert.equal(r.click?.state, 'moving', JSON.stringify(r.click));
  assert.equal(wd.st.bodies[0].early, true, 'the vault asked for the early answer');
  let j = (await wd.colds())[0];
  assert.equal(j.state, 'relaying'); assert.equal(j.bridge, 'motion'); assert.match(j.dstHash, /^0x[0-9a-f]{64}$/);
  assert.equal(j.error, undefined, 'no "not landed yet" line for a broadcast payout');
  // the solver still says 'paid' (its own look has not run) and the payout has not landed: not arrived
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'tick' }); for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x));
  j = (await wd.colds())[0]; assert.equal(j.state, 'relaying', 'no receipt yet = still relaying');
  wd.T.t += 500;   // the payout lands
  await wd.f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'tick' }); for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x));
  j = (await wd.colds())[0];
  assert.equal(j.state, 'arrived', 'the BNB frame saw the payout\'s receipt'); assert.ok(j.hashes.includes(j.dstHash));
  assert.ok(wd.receipts.includes(j.dstHash));
});

test('A3 engine: a payout that reverted or never lands is never "arrived" — followed until the solver says refunded', async () => {
  for (const o of [{ reverts: true }, { never: true }]) {
    let refunded = false;
    const wd = bnbWorld({ ...o, statusOf: () => (refunded ? 'refunded' : 'paid') }); await wd.on(); wd.rhSnap(2500);
    await wd.clickBuy(50);
    wd.T.t += 10_000;
    await wd.f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'tick' }); for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x));
    assert.equal((await wd.colds())[0].state, 'relaying', JSON.stringify(o));
    refunded = true;
    await wd.f.ensure({ walletId: 'w1', chain: 'bsc', reason: 'tick' }); for (let i = 0; i < 60; i++) await new Promise((x) => setImmediate(x));
    assert.equal((await wd.colds())[0].state, 'refunded', JSON.stringify(o));
  }
});

test('A3 engine: parts — a $900 click\'s second part is sent only after the first part\'s payout landed (same click); a first part that does not land in time holds the second', async () => {
  const wd = bnbWorld({ landMs: 900 }); await wd.on(); wd.rhSnap(2500);
  const t0 = wd.T.t;
  const r = await wd.clickBuy(900);
  assert.equal(r.click?.state, 'moving');
  assert.equal(wd.st.fills.length, 2, 'both parts went in this click');
  assert.ok(wd.st.fills[1].at >= wd.st.fills[0].at + 900, `part 2 at +${wd.st.fills[1].at - t0} ms, after part 1's payout landed at +900 ms`);
  const cs = await wd.colds();
  assert.equal(cs[0].state, 'arrived'); assert.equal(cs[1].state, 'relaying');
  for (const c of cs) assert.ok(BigInt(c.usd6) <= F.XCHAIN.part6);
  const slow = bnbWorld({ never: true }); await slow.on(); slow.rhSnap(2500);
  const r2 = await slow.clickBuy(900);
  assert.equal(slow.st.fills.length, 1, 'part 2 is not sent behind a part whose payout never showed');
  assert.ok((r2.planned || []).some((m) => m.kind === 'cold' && m.skipped === 'held'), JSON.stringify(r2.planned));
});

test('A3 engine: a double tap after the first payout landed and was spent — the second click bridges its own need at once (no 15 s wait on a relaying job)', async () => {
  const wd = bnbWorld({ landMs: 300 }); await wd.on(); wd.rhSnap(2500);
  await wd.clickBuy(50);
  wd.T.t += 400;                                                   // landed
  const s = await wd.f.status({ walletId: 'w1', fresh: true });    // the hold's fresh read that fires the buy
  assert.ok(s.chains.bsc.ready >= 50, 'the hold sees the payout: ' + s.chains.bsc.ready);
  wd.st.spent = BigInt(wd.st.payouts.values().next().value.amount); // the buy spent it
  const r = await wd.clickBuy(50);
  assert.equal(r.click?.state, 'moving', JSON.stringify(r));
  assert.equal(wd.st.fills.length, 2, 'click 2 got its own fill');
});

test('A1 planner (reviewer): the day budget is spent move by move inside one plan — two traded destinations cannot both pass the same $0.99', () => {
  const chains = { robinhood: rhFull({ reserve: usdg(2000) }), sol: solFull({ traded: true, readyOk: true }), bsc: bscFull({ traded: true, readyOk: true }) };
  assert.equal(rebalances(plan(chains)).filter((m) => m.ready).length, 2, 'budget untouched: both destinations');
  const near = rebalances(plan(chains, { feesDay6: F.usd6(0.99) })).filter((m) => m.ready);
  assert.equal(near.length, 1, '$0.99 spent: one more move (its own fee is the overshoot), not two');
  assert.equal(rebalances(plan(chains, { feesDay6: F.usd6(1) })).filter((m) => m.ready).length, 0, '$1 spent: none');
});
