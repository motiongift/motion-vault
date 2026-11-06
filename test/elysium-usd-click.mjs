// A buy on Elysium paid from the USD balance (src/elysiumUsdCore.ts + src/elysiumUsdEngine.ts), against a MOCK solver that runs
// the same pure core as the real one (src/motionBridgeCore.ts): it signs its quotes with its own ed25519 key (pinned here), checks
// the raw transfer the vault signed with evmSourceProblem, and reports the fill's states. Nothing leaves this process: throwaway
// keys, no network. What this file proves:
//   - the owner's case: a $50 click on an Elysium coin from USDG on Robinhood → ONE transfer of the deficit + margin from the
//     wallet's own reserve R to the published deposit address → HYPE to W → ready; the one-time notice shown once per account;
//   - money safety: no double fill (concurrent clicks, a lost answer, a reload with an open job), the refund path, nothing moved
//     when the click cannot be paid in full (short / split / over the cap / paused / contract wallet / quote under the need);
//   - (release 6) motion's fee into Elysium, 0.1 % (at least $0.01): the mock solver charges it like the real one (quoteOut, 10 bps);
//     a click moves deficit + margin + fee; a deposit's HYPE is its amount less the fee; a quote charging more signs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import * as C from '../src/motionBridgeCore.ts';
import * as EC from '../src/elysiumUsdCore.ts';
import { createSolverBridge } from '../src/bridgeSolver.ts';
import { createElyUsd, elyUsdArgs } from '../src/elysiumUsdEngine.ts';
import { readFileSync } from 'node:fs';
import { planElyClick, planElyDeposit, xwOk, xwKeyOf, noticeOf, exitWindow, challengeMs, ELY_USD, ELY_EXIT_TIME, ackOk, ackKeyOf, jobStateOf, fmt6, ELY_FEE, elyFeeOf, elyFee6, grossForNet6, elyFeeTooHigh, elyFeeText, ELY_LEAVE_LINE } from '../src/elysiumUsdCore.ts';

const lc = (a) => String(a).toLowerCase();
const HYPE_USD = 40n;
const E18 = 10n ** 18n;
const USDG = C.bridgeCfg('robinhood').stable.address;

function mockSolver(o = {}) {
  const seed = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
  const deposits = { robinhood: privateKeyToAccount(generatePrivateKey()).address, bsc: privateKeyToAccount(generatePrivateKey()).address, sol: '9SeWZmcsCUyBRe7LEjQvh65aTedBHHE6jK6p5BZXF1BE' };
  const s = { quotes: new Map(), fills: [], statusCalls: 0, pub, deposits, onFill: o.onFill || (() => {}), statuses: o.statuses || ['landed', 'filled'], paused: !!o.paused };
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  s.fetch = async (url, init) => {
    const path = String(url).split('/api/bridge/motion')[1] || '';
    if (path.startsWith('/health')) return json({ ok: true, on: o.on !== false, solver: pub, chains: ['robinhood', 'bsc', 'sol', 'elysium'], deposits, maxFillUsd: 1000, minFillUsd: 0.1, feeBps: 0,
      elysium: { pay: ['stable'], assets: ['native'], withdrawDays: 6, paused: s.paused, why: s.paused ? ['the Bridge proxy implementation changed'] : [], maxFillUsd: o.elyMaxFill ?? 100, fee: { bps: 10, minUsd: 0.01 } } });
    if (path.startsWith('/gas')) { s.gas = (s.gas || 0) + 1; if (o.onGas) o.onGas(); return json({ ok: true, state: 'sent', hash: '0xgas' }); }
    if (path.startsWith('/quote')) {
      const b = JSON.parse(init.body);
      s.lastQuoteBody = b;
      const usd6 = C.stableToUsd6(BigInt(b.amount), C.bridgeCfg(b.from).stable.decimals);
      const { out, fee6 } = C.quoteOut(usd6, HYPE_USD * C.USD6, 'elysium', o.feeBps ?? 10, undefined, 10_000n);   // the real solver's 0.1 %, at least $0.01
      const at = Date.now();
      let q = { v: 1, id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
        src: { chain: b.from, token: C.bridgeCfg(b.from).stable.address, amount: String(b.amount), depositor: b.depositor, deposit: deposits[b.from] },
        dst: { chain: 'elysium', recipient: o.payTo || b.recipient, amount: String(o.payHalf ? out / 2n : out) },
        price6: String(HYPE_USD * C.USD6), fee6: String(fee6), usd6: String(usd6), issuedAt: at, expiresAt: at + 45_000, solver: pub };
      const sig = C.signQuote(q, seed);
      s.quotes.set(q.id, q);
      return json({ ok: true, quote: q, sig });
    }
    if (path.startsWith('/fill')) {
      const b = JSON.parse(init.body); const q = s.quotes.get(b.id);
      if (o.fillRefuse) return { ok: false, status: 409, json: async () => ({ ok: false, sent: false, error: 'inventory floor on the destination chain' }) };
      const tx = parseTransaction(b.raw); const from = await recoverTransactionAddress({ serializedTransaction: b.raw });
      const why = C.evmSourceProblem(tx, from, q);
      if (why) return json({ ok: false, state: 'failed', error: why });
      s.fills.push({ id: q.id, from, hash: keccak256(b.raw), quote: q, tx });
      s.onFill(q);
      if (o.fillLost && s.fills.length === 1) throw new Error('socket hang up');
      return json({ ok: true, state: 'paid', srcHash: keccak256(b.raw), dstHash: '0x' + 'd'.repeat(64) });
    }
    if (path.startsWith('/status')) {
      const id = String(url).split('id=')[1];
      s.statusCalls += 1;
      const k = (s.seen = s.seen || new Map()).get(id) || 0; s.seen.set(id, k + 1);
      const st = s.statuses[Math.min(k, s.statuses.length - 1)];
      if (st === 'filled' && o.creditOnFilled) o.creditOnFilled(s.quotes.get(id));
      return json({ ok: true, state: st, dstHash: '0x' + 'd'.repeat(64), ...(st === 'refunded' ? { refundHash: '0x' + 'e'.repeat(64) } : {}) });
    }
    throw new Error('unexpected ' + path);
  };
  return s;
}

// (release 8) the permission's caps, wide by default (the bounds' maxima); a test of the caps narrows them
const WIDE_CAPS = { perDay6: 10_000n * C.USD6, feesPerDay6: 10n * C.USD6, perChain6: 2_500n * C.USD6, total6: 5_000n * C.USD6 };
function world(o = {}) {
  const W_KEY = generatePrivateKey(), R_KEY = generatePrivateKey();
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const st = { wHype: o.wHype ?? 0n, reserves: { robinhood: { stable: o.rhUsdg ?? 500_000_000n, native: o.rhGas ?? 10n ** 15n }, bsc: { stable: o.bscUsdc ?? 0n, native: 0n }, sol: { stable: o.solUsdc ?? 0n, native: 0n } }, asks: [], store: new Map(), nonce: 0, events: [] };
  const solver = mockSolver({ ...o.solver, ...(o.gasDrop ? { onGas: () => { st.reserves.robinhood.native = 10n ** 14n; } } : {}), creditOnFilled: (q) => { if (!st.credited?.has(q.id)) { (st.credited = st.credited || new Set()).add(q.id); st.wHype += BigInt(q.dst.amount); } } });
  const bridge = createSolverBridge({
    base: () => 'https://motion.gift', fetch: solver.fetch, now: () => Date.now(), pinnedKey: () => solver.pub,
    signEvmTransfer: async (a) => {
      assert.equal(lc(a.token), lc(C.bridgeCfg(a.chain).stable.address), 'only the chain\'s stablecoin');
      const raw = await R.signTransaction({ to: a.token, data: C.erc20TransferData(a.to, a.amount), value: 0n, gas: 120_000n, gasPrice: 10_000_000n, nonce: st.nonce++, chainId: C.bridgeCfg(a.chain).chainId, type: 'legacy' });
      return { raw, hash: keccak256(raw) };
    },
    signSolTransfer: async () => { throw new Error('no Solana in this world'); },
  });
  const locks = new Map();
  const api = createElyUsd({
    now: () => (o.clock ? o.clock() : Date.now()), wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    store: { get: (k) => st.store.get(k) ?? null, set: (k, v) => st.store.set(k, v) },
    lock: (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const p = prev.then(fn, fn); locks.set(key, p.catch(() => {})); return p; },
    ask: async (d) => { st.asks.push(d); return o.decline ? false : true; },
    esc: (v) => String(v).replace(/[<>&"]/g, ''),
    account: () => o.account ?? W.address,
    wallet: (id) => ({ id, name: 'Wallet 1', w: W.address, r: { evm: R.address, sol: '' } }),
    permission: () => (o.off ? null : { chains: o.chains || ['robinhood', 'bsc', 'sol'], ...(o.noCaps ? {} : { caps: o.caps || WIDE_CAPS, moved6: o.moved6 ?? 0n, fees6: o.fees6 ?? 0n, floats6: o.floats6 ?? 0n }) }),
    reads: {
      wHype: async () => st.wHype,
      price6: async () => HYPE_USD * C.USD6,
      reserve: async (c) => st.reserves[c],
      code: async () => (o.contract ? '0xef0100' + 'a'.repeat(40) : '0x'),
    },
    bridge,
    emit: (d) => st.events.push(d),
    ...(o.waitMs ? { waitMs: o.waitMs } : {}),
  });
  return { api, st, solver, W, R };
}
const click = (x, usd, extra = {}) => x.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'click', hype: String((BigInt(Math.round(usd * 1e6)) * E18) / (HYPE_USD * C.USD6)), ...extra });

test('the owner\'s case: a $50 Elysium buy from USDG on Robinhood — one transfer from R, HYPE to W, ready; the notice once per account', async () => {
  const x = world();
  const t0 = Date.now();
  const a = await click(x, 50);
  assert.equal(a.state, 'ready', JSON.stringify(a));
  assert.ok(Date.now() - t0 < 2_000, 'well inside the click wait');
  // the move: (1.25 + 0.002 HYPE) × $40 × 1.03 = $51.5824, + motion's 0.1 % on the whole ($0.0516) = $51.634 → $51.64 (whole cents, up)
  assert.equal(x.solver.fills.length, 1, 'one fill');
  const f = x.solver.fills[0];
  assert.equal(lc(f.from), lc(x.R.address), 'signed by the wallet\'s OWN reserve');
  assert.equal(f.quote.src.amount, '51640000', 'the deficit + 3 % margin + the 0.1 % fee in USDG (6 decimals)');
  assert.equal(f.quote.fee6, '51640', 'the fee: 0.1 % of what left R');
  assert.equal(lc(f.quote.dst.recipient), lc(x.W.address), 'HYPE to W itself');
  assert.equal(f.quote.dst.chain, 'elysium');
  assert.equal(lc(f.tx.to), lc(USDG), 'an ERC-20 transfer of USDG');
  assert.equal(f.tx.value ?? 0n, 0n);
  assert.equal(x.solver.lastQuoteBody.pay, undefined, 'paid with the stablecoin (the one shape of every route)');
  assert.equal(x.solver.lastQuoteBody.depositor, x.R.address);
  assert.ok(x.st.wHype >= 1_252_000_000_000_000_000n, 'W now covers the buy + its gas');
  x.st.wHype -= 1_250_000_000_000_000_000n;   // the buy itself spent its HYPE
  // the notice: shown once, with the exit time and the dates
  assert.equal(x.st.asks.length, 1);
  assert.equal(x.st.asks[0].ok, 'I understand');
  assert.match(x.st.asks[0].html, /\$51\.64 from your USD balance \(USDG on Robinhood\)/);
  assert.match(x.st.asks[0].html, /Fee 0\.1 % \(\$0\.05\), included/);
  assert.match(x.st.asks[0].html, /about 6 days/);
  assert.match(x.st.asks[0].html, /483,840 HyperEVM blocks/);
  assert.ok(ackOk(x.st.store.get(ackKeyOf(x.W.address)), x.W.address), '"I understand" stored for this account');
  // the next click is covered by what arrived (margin + gas left over is enough for a small buy): no dialog, no quote
  const b = await click(x, 0.5);
  assert.equal(b.state, 'covered');
  x.st.wHype -= 12_500_000_000_000_000n;
  assert.equal(x.st.asks.length, 1, 'no second notice');
  assert.equal(x.solver.fills.length, 1);
  // a bigger buy moves again, straight through (no dialog)
  const c = await click(x, 30);
  assert.equal(c.state, 'ready');
  assert.equal(x.solver.fills.length, 2);
  assert.equal(x.st.asks.length, 1, 'after "I understand", buys go straight through');
});

test('declined notice: nothing quoted, nothing signed, nothing stored', async () => {
  const x = world({ decline: true });
  const a = await click(x, 50);
  assert.equal(a.state, 'cancelled');
  assert.equal(x.solver.fills.length, 0);
  assert.equal(x.solver.quotes.size, 0, 'the solver was never asked for a quote');
  assert.equal(x.st.store.get(ackKeyOf(x.W.address)), undefined);
});

test('no double fill: two clicks at once, a lost fill answer, a reload with an open job — one transfer only', async () => {
  const x = world({ solver: { statuses: ['landed', 'landed', 'landed', 'filled'] } });
  const [a, b] = await Promise.all([click(x, 50), click(x, 50)]);
  assert.equal(x.solver.fills.length, 1, 'the second click joined the first move');
  assert.equal(a.state, 'ready'); assert.ok(b.state === 'ready' || b.state === 'covered', JSON.stringify(b));
  // a lost answer: the bytes are out → 'unknown', followed through the solver's status; a click in between never re-signs
  const y = world({ solver: { fillLost: true, statuses: ['landed', 'filled'] } });
  const p = click(y, 50);
  const q = click(y, 50);
  const [r1, r2] = await Promise.all([p, q]);
  assert.equal(y.solver.fills.length, 1, 'never signed again after a lost answer');
  assert.equal(r1.state, 'ready'); assert.ok(r2.state === 'ready' || r2.state === 'covered');
  // an open job in storage (a reload mid-move): the click follows it
  const z = world({ solver: { statuses: ['landed', 'filled'] } });
  await click(z, 50);
  const job = JSON.parse([...z.st.store.entries()].find(([k]) => k.startsWith('trenches.ely-usd.job.v1.'))[1]);
  job.state = 'sent'; job.at = Date.now(); z.st.store.set('trenches.ely-usd.job.v1.' + lc(z.W.address), JSON.stringify(job));
  z.st.wHype = 0n;
  z.solver.seen.delete(job.id);
  const again = await click(z, 50);
  assert.equal(z.solver.fills.length, 1, 'followed, not moved again');
  assert.equal(again.state, 'ready');
  // a record that cannot be read blocks a new move (never read as "nothing is open")
  z.st.store.set('trenches.ely-usd.job.v1.' + lc(z.W.address), '{"v":1,"id":"broken"');
  const bad = await click(z, 50);
  assert.equal(bad.code, 'job-unreadable'); assert.equal(z.solver.fills.length, 1);
});

test('refund: the solver could not pay — the dollars went back, the click says so, the next click may move again', async () => {
  const x = world({ solver: { statuses: ['refunding', 'refunded'] } });
  const a = await click(x, 50);
  assert.equal(a.state, 'failed'); assert.equal(a.code, 'refunded');
  assert.match(a.why, /went back to your USD balance/);
  assert.equal(a.refundHash, '0x' + 'e'.repeat(64));
  assert.equal(x.st.wHype, 0n, 'nothing arrived, nothing bought');
  x.solver.statuses = ['landed', 'filled'];
  const b = await click(x, 50);
  assert.equal(b.state, 'ready'); assert.equal(x.solver.fills.length, 2);
  // the solver refused the fill (sent:false): nothing of the user's moved; the job is closed, a later click may try again
  const y = world({ solver: { fillRefuse: true } });
  const r = await click(y, 50);
  assert.equal(r.state, 'failed'); assert.equal(r.code, 'refused'); assert.equal(y.solver.fills.length, 0);
});

test('nothing stranded: short, split, over the cap, paused, contract wallet, quote under the need, off — nothing moves', async () => {
  const short = world({ rhUsdg: 20_000_000n });
  const s = await click(short, 50);
  assert.equal(s.code, 'short'); assert.equal(short.solver.quotes.size, 0);
  // (release 8) the refusal names where the money is (here: this wallet's own reserve) and the account's total
  assert.deepEqual(s.short, { usd: 51.64, canUsd: 20, best: { walletId: 'w1', name: 'Wallet 1', chain: 'robinhood', usd: 20 }, accountUsd: 20, earn: null });
  assert.equal(s.why, 'This buy needs $51.64 on Elysium; none of your wallets\' USD balance holds that on one network (best: Wallet 1, $20.00 on Robinhood) — nothing was moved');
  const split = world({ rhUsdg: 30_000_000n, bscUsdc: 30n * 10n ** 18n });
  const sp = await click(split, 50);
  assert.equal(sp.code, 'split'); assert.equal(split.solver.quotes.size, 0);
  const big = world({ rhUsdg: 10_000_000_000n });
  const o = await click(big, 300);
  assert.equal(o.code, 'over-cap', 'the solver\'s Elysium cap ($100) binds'); assert.equal(big.solver.quotes.size, 0);
  const paused = world({ solver: { paused: true } });
  const pz = await click(paused, 50);
  assert.equal(pz.code, 'paused'); assert.match(pz.why, /Bridge proxy implementation changed/); assert.equal(paused.solver.quotes.size, 0);
  const ctr = world({ contract: true });
  const ct = await click(ctr, 50);
  assert.equal(ct.code, 'contract'); assert.equal(ctr.solver.quotes.size, 0);
  const half = world({ solver: { payHalf: true } });
  const h = await click(half, 50);
  assert.equal(h.state, 'failed'); assert.equal(half.solver.fills.length, 0, 'a quote under OUR price − slippage signs nothing');
  const greedy = world({ solver: { feeBps: 50 } });   // a solver naming 0.5 %: over the vault's own bound
  const gr = await click(greedy, 50);
  assert.equal(gr.state, 'failed'); assert.match(gr.why, /more than its 0\.1 % fee/); assert.equal(greedy.solver.fills.length, 0, 'nothing signed');
  const other = world({ solver: { payTo: privateKeyToAccount(generatePrivateKey()).address } });
  const ot = await click(other, 50);
  assert.equal(ot.state, 'failed'); assert.match(ot.why, /pays someone else/); assert.equal(other.solver.fills.length, 0);
  const off = world({ off: true });
  assert.equal((await click(off, 50)).state, 'off');
  const notIn = world({ chains: ['bsc'] });
  assert.equal((await click(notIn, 50)).code, 'short', 'a reserve outside the permission is never a donor');
});

test('a reserve with no gas gets motion\'s gas drop first; still none → nothing moved', async () => {
  const x = world({ rhGas: 0n, gasDrop: true });
  const a = await click(x, 50);
  assert.equal(a.state, 'ready');
  const y = world({ rhGas: 0n });
  const b = await click(y, 50);
  assert.equal(b.code, 'no-gas'); assert.equal(y.solver.fills.length, 0);
});

test('a move delayed past 10 minutes blocks new moves ("nothing is lost"), never a second fill', async () => {
  let skew = 0;
  const x = world({ clock: () => Date.now() + skew, waitMs: 300, solver: { statuses: ['landed'] } });
  const a = await click(x, 50);
  assert.equal(a.state, 'moving');
  skew += 11 * 60_000;
  const b = await click(x, 50);
  assert.equal(b.code, 'delayed'); assert.equal(x.solver.fills.length, 1);
  const jobs = await x.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'jobs' });
  assert.equal(jobs.job.delayed, true); assert.equal(jobs.job.state, 'arriving');
});

test('the notice text: in seconds, out ~6 days with the dates of a withdrawal started now (483,840 blocks × 0.984 s ≈ 5.5 d)', () => {
  const now = Date.UTC(2026, 10, 4, 12, 0);
  const w = exitWindow(now);
  assert.equal(challengeMs(), 483_840 * 984);
  assert.ok(Math.abs((w.earliest - now) / 86_400_000 - 5.51) < 0.01);
  assert.ok(Math.abs((w.latest - now) / 86_400_000 - 6.6) < 0.01);
  const en = noticeOf(now, 'en');
  assert.match(en.lines[1], /between Tue 10 Nov and Wed 11 Nov/);
  const ru = noticeOf(now, 'ru');
  assert.equal(ru.ok, 'Понятно'); assert.match(ru.lines[1], /около 6 дней/);
  for (const l of ['en', 'ru', 'zh', 'id', 'es', 'fr']) { const n = noticeOf(now, l); assert.equal(n.lines.length, 4); assert.ok(n.lines.every((x) => x.length > 20)); }
  assert.equal(ELY_EXIT_TIME.confirmPeriodBlocks, 483_840);
});

test('the plan: covered, cents rounding, the $1 floor, the order of donors, the vault\'s own $250 ceiling', () => {
  const h = { on: true, chains: ['robinhood', 'bsc', 'sol', 'elysium'], maxFill6: 1000n * C.USD6, minFill6: C.USD6 / 10n, paused: false, hasDeposit: () => true };
  const res = (rh, bsc, sol) => [{ chain: 'robinhood', stable: rh, native: 10n ** 15n, address: '0x1' }, { chain: 'bsc', stable: bsc, native: 10n ** 15n, address: '0x2' }, { chain: 'sol', stable: sol, native: 10n ** 7n, address: 's' }];
  const p = (o) => planElyClick({ buyWei: E18, wHype: 0n, price6: 40n * C.USD6, reserves: res(500n * C.USD6, 0n, 0n), chains: ['robinhood', 'bsc', 'sol'], health: h, ...o });
  assert.equal(p({ wHype: E18 + ELY_USD.gasWei }).kind, 'covered');
  const m = p({}); assert.equal(m.kind, 'move'); assert.equal(m.usd6, 41_330_000n);   // (1.002 × 40) × 1.03 = 41.2824, + 0.1 % on the whole = 41.3237 → 41.33
  assert.equal(p({ buyWei: 1n, wHype: ELY_USD.gasWei }).usd6, C.USD6, 'below $1 → $1');
  const both = p({ reserves: res(500n * C.USD6, 500n * 10n ** 18n, 0n) }); assert.equal(both.from, 'robinhood');
  const bscOnly = p({ reserves: res(0n, 500n * 10n ** 18n, 0n) }); assert.equal(bscOnly.from, 'bsc'); assert.equal(bscOnly.amountIn, 41_330_000n * 10n ** 12n, 'BNB USDC has 18 decimals');
  assert.equal(p({ health: { ...h, fee: { bps: 0, min6: 0n } } }).usd6, 41_290_000n, 'a solver with no fee: deficit + margin only');
  assert.equal(p({ buyWei: 7n * E18, reserves: res(10_000n * C.USD6, 0n, 0n) }).code, 'over-cap', '$288 > the vault\'s own $250');
  assert.equal(p({ wHype: null }).code, 'not-read');
  assert.equal(p({ price6: 0n }).code, 'no-price');
  assert.equal(p({ health: { ...h, chains: ['robinhood'] } }).code, 'bridge-off');
  assert.equal(fmt6(51_582_400n), '$51.58');
  assert.equal(jobStateOf('filled', 'arriving'), 'done'); assert.equal(jobStateOf('landed', 'sent'), 'arriving'); assert.equal(jobStateOf('expired', 'sent'), 'sent', 'a sent move is followed, never written off');
});

test('arguments: only the Elysium shape; nothing else reaches the click', () => {
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'robinhood', reason: 'click', usd: 5 }), /chain/);
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'click' }), /hype or usd/);
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'click', usd: 5, to: '0x1' }), /unknown field to/);
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'click', hype: '-1' }), /hype/);
  assert.equal(elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'notice', lang: 'xx' }).lang, 'en');
});

test('"Add HYPE on Elysium" from the USD balance: quote = a price read (nothing asked of the solver); go = the vault dialog, one fill, credited', async () => {
  const x = world();
  const dep = (o) => x.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'deposit', usd: 25, ...o });
  const q = await dep({ phase: 'quote' });
  assert.equal(q.state, 'quote'); assert.equal(q.from, 'robinhood'); assert.equal(q.usd, 25); assert.equal(q.feeUsd, 0.025); assert.equal(q.fee, '0.1 %');
  assert.equal(q.outWei, String(624_375n * 10n ** 12n), '($25 − the $0.025 fee) at $40 = 0.624375 HYPE');
  assert.equal(q.back, 'Leaving Elysium goes through the official bridge and takes about 6 days.');
  assert.deepEqual(q.etaS, [5, 20]); assert.equal(q.notice.length, 4);
  assert.equal(x.solver.quotes.size, 0, 'a price read asks the solver nothing'); assert.equal(x.st.asks.length, 0);
  const g = await dep({});
  assert.equal(g.state, 'ready', JSON.stringify(g));
  assert.equal(x.solver.fills.length, 1); assert.equal(x.solver.fills[0].quote.src.amount, '25000000');
  assert.equal(x.st.asks.length, 1); assert.equal(x.st.asks[0].title, 'Add HYPE on Elysium'); assert.equal(x.st.asks[0].ok, 'Add $25.00');
  assert.match(x.st.asks[0].html, /0\.6244 HYPE in Wallet 1 on Elysium/); assert.match(x.st.asks[0].html, /about 6 days/);
  assert.match(x.st.asks[0].html, /Fee 0\.1 % \(\$0\.03\)\./); assert.doesNotMatch(x.st.asks[0].html, /fee: none/);
  assert.match(x.st.asks[0].html, /Leaving Elysium goes through the official bridge and takes about 6 days\./);
  assert.ok(ackOk(x.st.store.get(ackKeyOf(x.W.address)), x.W.address), 'a confirmed deposit counts as "I understand"');
  const fromBsc = await dep({ from: 'bsc', phase: 'quote' });
  assert.equal(fromBsc.code, 'short', 'BNB holds nothing in this world');
  const y = world({ decline: true });
  const n = await y.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'deposit', usd: 25 });
  assert.equal(n.state, 'cancelled'); assert.equal(y.solver.fills.length, 0);
  assert.equal((await y.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'deposit', usd: 500 })).code, 'over-cap');
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'deposit' }), /usd/);
  assert.throws(() => elyUsdArgs({ walletId: 'w1', chain: 'elysium', reason: 'deposit', usd: 5, from: 'elysium' }), /from/);
});

test('(release 6) the fee: 0.1 %, at least $0.01; the vault never accepts more; deficit + margin + fee covers the buy after the fee', () => {
  assert.deepEqual(ELY_FEE, { bps: 10, min6: 10_000n });
  assert.equal(elyFee6(25_000_000n), 25_000n); assert.equal(elyFee6(1_000_000n), 10_000n, '$1 → the $0.01 minimum');
  assert.deepEqual(elyFeeOf({ bps: 10, minUsd: 0.01 }), { bps: 10, min6: 10_000n });
  assert.deepEqual(elyFeeOf({ bps: 50, minUsd: 1 }), { bps: 10, min6: 10_000n }, 'never above the vault\'s own bound');
  assert.deepEqual(elyFeeOf({ bps: 5, minUsd: 0 }), { bps: 5, min6: 0n }, 'a lower fee is taken as published');
  assert.deepEqual(elyFeeOf(null), { bps: 10, min6: 10_000n }); assert.deepEqual(elyFeeOf({ bps: 'x' }), { bps: 10, min6: 10_000n });
  for (const net of [1n, 5_000n, 999_999n, 10_000_000n, 51_582_400n, 99_999_999n]) {
    const g = grossForNet6(net); assert.ok(g - elyFee6(g) >= net, String(net)); assert.ok(g - 1n - elyFee6(g - 1n) < net, 'the smallest such amount: ' + net);
  }
  assert.equal(elyFeeTooHigh(51_640n, 51_640_000n), false); assert.equal(elyFeeTooHigh(51_641n, 51_640_000n), true);
  assert.equal(elyFeeTooHigh(10_000n, 1_000_000n), false, 'the minimum is allowed'); assert.equal(elyFeeText(), '0.1 %');
  for (const l of ['en', 'ru', 'zh', 'id', 'es', 'fr']) { assert.match(ELY_LEAVE_LINE[l], /6/); assert.match(noticeOf(Date.now(), l).lines[0], /0[.,]1\s?%/, 'the notice names the fee: ' + l); }
});

// ── (release 8) a dollar-mode buy on Elysium funded from the ACCOUNT's dollars, not only the clicking wallet's own reserve ──
// An account of several vault wallets, each with its own W, its own reserve R and its own permission. The signer resolves R from
// the walletId it is handed (as webEngine's bridgeSignEvmTransfer does: reserveOf(floatAccount(walletId))); the mock solver
// checks the raw transfer against its quote (evmSourceProblem: signed by the quote's depositor) and debits the paying reserve.
const BSC6 = (usd) => BigInt(Math.round(usd * 1e6)) * 10n ** 12n;   // BNB USDC: 18 decimals
const RH6 = (usd) => BigInt(Math.round(usd * 1e6));                 // Robinhood USDG: 6 decimals
function account(o = {}) {
  const specs = o.wallets || [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 65 }];
  const ws = new Map(specs.map((s) => {
    const W = privateKeyToAccount(generatePrivateKey()), R = privateKeyToAccount(generatePrivateKey());
    return [s.id, { ...s, W, R, nonce: 0, perm: s.perm === undefined ? { chains: ['robinhood', 'bsc', 'sol'] } : s.perm,
      reserves: { robinhood: { stable: RH6(s.rh ?? 0), native: s.rhGas ?? 10n ** 15n }, bsc: { stable: BSC6(s.bsc ?? 0), native: 10n ** 15n }, sol: { stable: 0n, native: 0n } } }];
  }));
  const byR = (addr) => [...ws.values()].find((x) => lc(x.R.address) === lc(addr));
  const st = { wHype: new Map(specs.map((s) => [s.id, 0n])), asks: [], store: new Map(), reads: [], signedBy: [], locks: [], permAsks: [] };
  const solver = mockSolver({ ...o.solver,
    onFill: (q) => { const x = byR(q.src.depositor); if (x) x.reserves[q.src.chain].stable -= BigInt(q.src.amount); },
    creditOnFilled: (q) => { const x = [...ws.values()].find((v) => lc(v.W.address) === lc(q.dst.recipient)); if (x && !st.credited?.has(q.id)) { (st.credited = st.credited || new Set()).add(q.id); st.wHype.set(x.id, st.wHype.get(x.id) + BigInt(q.dst.amount)); } } });
  const bridge = createSolverBridge({
    base: () => 'https://motion.gift', fetch: solver.fetch, now: () => Date.now(), pinnedKey: () => solver.pub,
    signEvmTransfer: async (a) => {
      const x = ws.get(a.walletId); if (!x) throw new Error('Unknown wallet');
      st.signedBy.push(a.walletId);
      const raw = await x.R.signTransaction({ to: a.token, data: C.erc20TransferData(a.to, a.amount), value: 0n, gas: 120_000n, gasPrice: 10_000_000n, nonce: x.nonce++, chainId: C.bridgeCfg(a.chain).chainId, type: 'legacy' });
      return { raw, hash: keccak256(raw) };
    },
    signSolTransfer: async () => { throw new Error('no Solana in this world'); },
  });
  const locks = new Map();
  const main = ws.get(specs[0].id);
  const api = createElyUsd({
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    store: { get: (k) => st.store.get(k) ?? null, set: (k, v) => st.store.set(k, v) },
    lock: (key, fn) => { st.locks.push(key); const prev = locks.get(key) || Promise.resolve(); const p = prev.then(fn, fn); locks.set(key, p.catch(() => {})); return p; },
    ask: async (d) => { st.asks.push(d); return o.decline ? false : true; },
    esc: (v) => String(v).replace(/[<>&"]/g, ''),
    account: () => main.W.address,
    wallet: (id) => { const x = ws.get(id); if (!x) throw new Error('Unknown wallet'); return { id, name: x.name, w: x.W.address, r: { evm: x.R.address, sol: '' } }; },
    permission: (id) => { st.permAsks.push(id); const x = ws.get(id); const p = typeof x?.perm === 'function' ? x.perm() : x?.perm ?? null; return p && !('caps' in p) ? { ...p, caps: WIDE_CAPS } : p; },
    ...(o.noWallets ? {} : { wallets: () => specs.map((s) => s.id) }),
    ...(o.earn ? { earnReady: (id, c) => o.earn[id + ':' + c] ?? null } : {}),
    reads: {
      wHype: async (w) => st.wHype.get([...ws.values()].find((x) => lc(x.W.address) === lc(w)).id),
      price6: async () => HYPE_USD * C.USD6,
      reserve: async (c, owner) => { st.reads.push(c + ':' + lc(owner)); const x = byR(owner); if (!x) throw new Error('unknown reserve'); return { ...x.reserves[c] }; },
      code: async () => '0x',
    },
    bridge,
    emit: () => {},
  });
  const acc = lc(main.W.address);
  if (o.acked) st.store.set(ackKeyOf(main.W.address), JSON.stringify({ v: 1, notice: ELY_USD.noticeVersion, at: Date.now(), account: acc }));
  if (o.xw) st.store.set(xwKeyOf(main.W.address), JSON.stringify({ v: 1, at: Date.now(), account: acc }));
  return { api, st, solver, ws, w: (id) => ws.get(id) };
}
const clickOf = (x, id, usd) => x.api.ensure({ walletId: id, chain: 'elysium', reason: 'click', hype: String((BigInt(Math.round(usd * 1e6)) * E18) / (HYPE_USD * C.USD6)) });
const jobOf = (x, id) => JSON.parse(x.st.store.get('trenches.ely-usd.job.v1.' + lc(x.w(id).W.address)));

test('(rel-8) own reserve covers → the plan and the answer are what they were; no other wallet is read or asked', async () => {
  const h = { on: true, chains: ['robinhood', 'bsc', 'sol', 'elysium'], maxFill6: 1000n * C.USD6, minFill6: C.USD6 / 10n, paused: false, hasDeposit: () => true };
  const own = [{ chain: 'robinhood', stable: 500n * C.USD6, native: 10n ** 15n, address: '0x1' }, { chain: 'bsc', stable: 0n, native: 10n ** 15n, address: '0x2' }];
  const rich = [{ chain: 'robinhood', stable: 5_000n * C.USD6, native: 10n ** 15n, address: '0x9', walletId: 'w2', name: 'Wallet 2', own: false, chains: ['robinhood'] }];
  const base = { buyWei: E18, wHype: 0n, price6: 40n * C.USD6, chains: ['robinhood', 'bsc', 'sol'], health: h };
  const before = planElyClick({ ...base, reserves: own });
  const after = planElyClick({ ...base, reserves: [...own, ...rich], self: { walletId: 'w1', name: 'Main' } });
  assert.deepEqual(after, before, 'byte-for-byte the same plan');
  assert.deepEqual(before, { kind: 'move', from: 'robinhood', usd6: 41_330_000n, amountIn: 41_330_000n, deficitWei: E18 + ELY_USD.gasWei, gasOk: true });
  assert.equal('donor' in after, false, 'no donor when the wallet pays itself');
  // the engine: the owner's own reserve pays; Wallet 2's reserve is never read, its permission never asked
  const x = account({ wallets: [{ id: 'w1', name: 'Main', rh: 500 }, { id: 'w2', name: 'Wallet 2', rh: 5_000 }] });
  const a = await clickOf(x, 'w1', 50);
  assert.equal(a.state, 'ready'); assert.equal(a.paidBy, undefined, 'the answer carries nothing new');
  assert.deepEqual(Object.keys(a).sort(), ['jobId', 'ms', 'ok', 'outWei', 'state']);
  assert.equal(lc(x.solver.fills[0].from), lc(x.w('w1').R.address)); assert.deepEqual(x.st.signedBy, ['w1']);
  assert.ok(x.st.reads.every((r) => r.endsWith(lc(x.w('w1').R.address)) || r === 'sol:'), 'only the own reserves were read (this world has no Solana reserve address)');
  assert.ok(!x.st.reads.some((r) => r.endsWith(lc(x.w('w2').R.address))));
  assert.deepEqual([...new Set(x.st.permAsks)], ['w1']);
  assert.equal(x.st.asks.length, 1); assert.equal(x.st.asks[0].ok, 'I understand');
  assert.match(x.st.asks[0].html, /This buy: \$51\.64 from your USD balance \(USDG on Robinhood\) → HYPE in this wallet on Elysium\. Fee 0\.1 % \(\$0\.05\), included\./, 'the notice text unchanged');
  assert.equal(jobOf(x, 'w1').donorId, undefined, 'the job record unchanged');
  assert.equal(x.st.store.get(xwKeyOf(x.w('w1').W.address)), undefined, 'no cross-wallet permission asked or stored');
  assert.ok(x.st.locks.includes('ely-usd-r:robinhood:' + lc(x.w('w1').R.address)), 'its own reserve is locked for its signature too');
});

test('(rel-8) the owner\'s case: Main $0, Wallet 2 $65 USDG on Robinhood → ONE transfer from Wallet 2\'s reserve, HYPE to Main; asked once', async () => {
  const x = account();
  const a = await clickOf(x, 'w1', 5);
  assert.equal(a.state, 'ready', JSON.stringify(a));
  assert.deepEqual(a.paidBy, { walletId: 'w2', name: 'Wallet 2' });
  assert.equal(x.solver.fills.length, 1);
  const f = x.solver.fills[0];
  assert.equal(lc(f.from), lc(x.w('w2').R.address), 'signed by Wallet 2\'s reserve');
  assert.deepEqual(x.st.signedBy, ['w2'], 'the signer was handed the donor\'s walletId');
  assert.equal(lc(f.quote.src.depositor), lc(x.w('w2').R.address), 'the depositor (where a refund goes) is the donor\'s reserve');
  assert.equal(lc(f.quote.dst.recipient), lc(x.w('w1').W.address), 'HYPE to the clicking wallet');
  assert.equal(lc(x.solver.lastQuoteBody.recipient), lc(x.w('w1').W.address));
  assert.equal(f.quote.src.amount, '5250000', '(0.125 + 0.002 HYPE) × $40 × 1.03 + 0.1 % → $5.25');
  assert.equal(x.w('w2').reserves.robinhood.stable, RH6(65) - 5_250_000n, 'only Wallet 2\'s reserve paid');
  assert.ok(x.st.wHype.get('w1') > 0n && x.st.wHype.get('w2') === 0n, 'the HYPE is in Main, never in Wallet 2');
  // the job: under Main's key, saved before the signature, naming the donor and its reserve
  const j = jobOf(x, 'w1');
  assert.equal(j.walletId, 'w1'); assert.equal(j.w, lc(x.w('w1').W.address)); assert.equal(j.donorId, 'w2'); assert.equal(j.donorName, 'Wallet 2'); assert.equal(j.payer, lc(x.w('w2').R.address));
  assert.equal(x.st.store.get('trenches.ely-usd.job.v1.' + lc(x.w('w2').W.address)), undefined, 'nothing written under the donor\'s key');
  const jobs = await x.api.ensure({ walletId: 'w1', chain: 'elysium', reason: 'jobs' });
  assert.equal(jobs.job.donorId, 'w2'); assert.equal(jobs.job.donorName, 'Wallet 2');
  // one dialog for a fresh account: the notice + the cross-wallet permission, naming the paying wallet and the amount
  assert.equal(x.st.asks.length, 1);
  assert.match(x.st.asks[0].html, /Main cannot pay this buy on Elysium from its own USD balance\. Wallet 2 can: \$5\.25 from Wallet 2's USD balance \(USDG on Robinhood\) → HYPE in Main on Elysium/);
  assert.match(x.st.asks[0].html, /about 6 days/);
  assert.ok(xwOk(x.st.store.get(xwKeyOf(x.w('w1').W.address)), x.w('w1').W.address), 'allowed once for this account');
  // the next donor-funded click goes straight through
  x.st.wHype.set('w1', 0n);
  const b = await clickOf(x, 'w1', 5);
  assert.equal(b.state, 'ready'); assert.equal(x.st.asks.length, 1, 'no second dialog'); assert.equal(x.solver.fills.length, 2);
  assert.ok(x.st.locks.includes('ely-usd:' + lc(x.w('w1').W.address)) && x.st.locks.includes('ely-usd-r:robinhood:' + lc(x.w('w2').R.address)), 'W\'s lock and the donor reserve\'s');
});

test('(rel-8) the notice already acknowledged: the cross-wallet dialog alone, once; declined = nothing quoted, nothing signed', async () => {
  const x = account({ acked: true });
  const a = await clickOf(x, 'w1', 5);
  assert.equal(a.state, 'ready');
  assert.equal(x.st.asks.length, 1); assert.equal(x.st.asks[0].title, 'Pay from another of your wallets'); assert.equal(x.st.asks[0].ok, 'Pay from Wallet 2');
  assert.match(x.st.asks[0].html, /\$5\.25 from Wallet 2's USD balance/); assert.doesNotMatch(x.st.asks[0].html, /483,840/);
  const y = account({ acked: true, decline: true });
  const n = await clickOf(y, 'w1', 5);
  assert.equal(n.state, 'cancelled'); assert.equal(y.solver.quotes.size, 0); assert.equal(y.solver.fills.length, 0);
  assert.equal(y.st.store.get(xwKeyOf(y.w('w1').W.address)), undefined);
  assert.equal(xwOk(JSON.stringify({ v: 1, at: 1, account: lc(x.w('w2').W.address) }), x.w('w1').W.address), false, 'stored per account');
});

test('(rel-8) donors: permission off → not a donor; its permission without that chain → not a donor; never read either way', async () => {
  const off = account({ wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 65, perm: null }] });
  const a = await clickOf(off, 'w1', 5);
  assert.equal(a.code, 'short'); assert.equal(off.solver.quotes.size, 0);
  assert.equal(a.why, 'This buy needs $5.25 on Elysium; none of your wallets\' USD balance holds that on one network — nothing was moved');
  assert.deepEqual(a.short, { usd: 5.25, canUsd: 0, best: null, accountUsd: 0, earn: null });
  assert.ok(!off.st.reads.some((r) => r.endsWith(lc(off.w('w2').R.address))), 'an off wallet\'s reserve is not read');
  const chain = account({ wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 65, perm: { chains: ['bsc'] } }] });
  const b = await clickOf(chain, 'w1', 5);
  assert.equal(b.code, 'short'); assert.equal(chain.solver.quotes.size, 0);
  assert.ok(!chain.st.reads.includes('robinhood:' + lc(chain.w('w2').R.address)), 'only the chains of ITS permission are read');
  // a donor whose permission goes off between the plan and the move pays nothing
  let n = 0;
  const flip = account({ acked: true, xw: true, wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 65, perm: () => (n++ === 0 ? { chains: ['robinhood'] } : null) }] });
  const c = await clickOf(flip, 'w1', 5);
  assert.equal(c.code, 'donor-off'); assert.equal(flip.solver.quotes.size, 0); assert.equal(flip.solver.fills.length, 0);
  // no account list (an older host): today's behaviour, own reserves only
  const old = account({ noWallets: true });
  assert.equal((await clickOf(old, 'w1', 5)).code, 'short'); assert.equal(old.solver.quotes.size, 0);
});

test('(rel-8) split across wallets → refused with the best wallet; short → the exact per-wallet text; Earn is named, never moved', async () => {
  const split = account({ wallets: [{ id: 'w1', name: 'Main', rh: 3 }, { id: 'w2', name: 'Wallet 2', bsc: 3.1 }] });
  const s = await clickOf(split, 'w1', 5);
  assert.equal(s.code, 'split'); assert.equal(split.solver.quotes.size, 0);
  assert.equal(s.why, 'Your wallets\' USD balance holds $6.10, but no single wallet holds the $5.25 this buy needs on Elysium on one network (best: Wallet 2, $3.10 on BNB) — nothing was moved');
  assert.deepEqual(s.short, { usd: 5.25, canUsd: 3.1, best: { walletId: 'w2', name: 'Wallet 2', chain: 'bsc', usd: 3.1 }, accountUsd: 6.1, earn: null });
  const short = account({ wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', bsc: 3.1 }] });
  const t = await clickOf(short, 'w1', 5);
  assert.equal(t.code, 'short');
  assert.equal(t.why, 'This buy needs $5.25 on Elysium; none of your wallets\' USD balance holds that on one network (best: Wallet 2, $3.10 on BNB) — nothing was moved');
  // Earn's ready part would make Wallet 2's Robinhood reserve whole: the refusal says how much to take out first
  const earn = account({ wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 3 }], earn: { 'w2:robinhood': 10n * C.USD6 } });
  const e = await clickOf(earn, 'w1', 5);
  assert.equal(e.code, 'short'); assert.equal(earn.solver.quotes.size, 0, 'nothing is taken out of Earn by this click');
  assert.match(e.why, /\(best: Wallet 2, \$3\.00 on Robinhood\); \$2\.25 more is in Earn on Robinhood \(Wallet 2\) — take it out first — nothing was moved$/);
  assert.deepEqual(e.short.earn, { walletId: 'w2', name: 'Wallet 2', chain: 'robinhood', usd: 2.25 });
});

test('(rel-8) the recipient is always the clicking wallet: a quote paying anyone else signs nothing', async () => {
  const bad = account({ acked: true, xw: true, solver: { payTo: '0x' + '7'.repeat(40) } });
  const r = await clickOf(bad, 'w1', 5);
  assert.equal(r.state, 'failed'); assert.match(r.why, /pays someone else/); assert.equal(bad.solver.fills.length, 0);
  // the donor's own W is "someone else" too
  const x = account({ acked: true, xw: true });
  const y = account({ acked: true, xw: true, solver: { payTo: x.w('w2').W.address } });
  const r2 = await clickOf(y, 'w1', 5);
  assert.equal(r2.state, 'failed'); assert.equal(y.solver.fills.length, 0);
  const ENG = readFileSync(new URL('../src/elysiumUsdEngine.ts', import.meta.url), 'utf8');
  assert.equal(ENG.split('deps.bridge.quote(').length - 1, 1, 'one quote call');
  assert.match(ENG, /deps\.bridge\.quote\(\{ from: plan\.from, to: 'elysium', amountIn: plan\.amountIn, depositor: payer, recipient: w\.w,/, 'recipient = W (w.w); payer = the paying reserve');
  assert.match(ENG, /deps\.bridge\.fill\(got\.quote, got\.sig, pw\.id, \{ early: true \}\)/, 'the paying wallet signs');
});

test('(rel-8) one move per reserve: two wallets\' clicks on one donor at once → one fill; the second sees the spent reserve and moves nothing', async () => {
  const x = account({ acked: true, xw: true, wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 65 }, { id: 'w3', name: 'Wallet 3' }] });
  const [a, b] = await Promise.all([clickOf(x, 'w1', 50), clickOf(x, 'w3', 50)]);
  assert.equal(x.solver.fills.length, 1, 'one fill from the donor reserve');
  const states = [a, b].map((r) => r.state + ':' + (r.code || '')).sort();
  assert.deepEqual(states, ['failed:short', 'ready:'], JSON.stringify([a, b]));
  assert.match([a, b].find((r) => r.code === 'short').why, /changed a moment ago/);
  assert.equal(x.st.locks.filter((k) => k === 'ely-usd-r:robinhood:' + lc(x.w('w2').R.address)).length, 2, 'both went through the donor reserve\'s lock');
});

test('(rel-8) caps: the same per-fill cap; the donor\'s own permission decides its chains; a refund goes back to the donor', async () => {
  const big = account({ acked: true, xw: true, wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 5_000 }] });
  const o = await clickOf(big, 'w1', 300);
  assert.equal(o.code, 'over-cap', 'a donor never lifts the per-fill cap'); assert.equal(big.solver.quotes.size, 0);
  // the donor's permission (not W's) decides: Main's permission without Robinhood does not stop Wallet 2's Robinhood reserve,
  // Wallet 2's own permission without it does (the donors test above)
  const mixed = account({ acked: true, xw: true, wallets: [{ id: 'w1', name: 'Main', perm: { chains: ['bsc'] } }, { id: 'w2', name: 'Wallet 2', rh: 65, perm: { chains: ['robinhood'] } }] });
  assert.equal((await clickOf(mixed, 'w1', 5)).state, 'ready');
  assert.equal(lc(mixed.solver.fills[0].from), lc(mixed.w('w2').R.address));
  // refund: the dollars go back to the donor's reserve (the solver refunds the quote's depositor = Wallet 2's R)
  const ref = account({ acked: true, xw: true, solver: { statuses: ['refunding', 'refunded'] } });
  const r = await clickOf(ref, 'w1', 5);
  assert.equal(r.code, 'refunded'); assert.match(r.why, /went back to Wallet 2's USD balance/);
  assert.equal(lc(ref.solver.fills[0].quote.src.depositor), lc(ref.w('w2').R.address));
});

test('(rel-8) the plan: own first, then other wallets (gas, network order, larger balance); a reserve without an owner is never a donor', () => {
  const h = { on: true, chains: ['robinhood', 'bsc', 'sol', 'elysium'], maxFill6: 1000n * C.USD6, minFill6: C.USD6 / 10n, paused: false, hasDeposit: () => true };
  const o = (id, chain, usd, extra = {}) => ({ chain, stable: chain === 'bsc' ? BSC6(usd) : RH6(usd), native: 10n ** 15n, address: '0x' + id, walletId: id, name: 'W ' + id, own: false, chains: ['robinhood', 'bsc'], ...extra });
  const p = (reserves) => planElyClick({ buyWei: E18, wHype: 0n, price6: 40n * C.USD6, reserves, chains: ['robinhood', 'bsc', 'sol'], health: h, self: { walletId: 'w1', name: 'Main' } });
  assert.equal(p([{ chain: 'bsc', stable: BSC6(100), native: 10n ** 15n, address: '0x1' }, o('w2', 'robinhood', 900)]).from, 'bsc', 'own reserve (even BNB) before a richer other wallet');
  assert.equal(p([{ chain: 'bsc', stable: BSC6(100), native: 10n ** 15n, address: '0x1' }, o('w2', 'robinhood', 900)]).donor, undefined);
  assert.deepEqual(p([o('w2', 'bsc', 900), o('w3', 'robinhood', 50)]).donor, { walletId: 'w3', name: 'W w3', chain: 'robinhood' }, 'network order first');
  assert.deepEqual(p([o('w2', 'robinhood', 50), o('w3', 'robinhood', 90)]).donor, { walletId: 'w3', name: 'W w3', chain: 'robinhood' }, 'then the larger balance');
  assert.equal(p([o('w2', 'robinhood', 900, { native: 0n }), o('w3', 'bsc', 50)]).donor.walletId, 'w3', 'a reserve that pays its own gas first');
  assert.equal(p([o('w2', 'robinhood', 900, { walletId: undefined })]).kind, 'refused', 'no owner, no donor');
  assert.equal(p([o('w1', 'robinhood', 900)]).kind, 'refused', 'the clicking wallet is never its own "other" donor');
  assert.equal(p([o('w2', 'robinhood', 900, { chains: undefined })]).kind, 'refused', 'no permission chains, no donor');
  assert.equal(planElyDeposit({ usd6: 10n * C.USD6, from: null, reserves: [o('w2', 'robinhood', 900)], chains: ['robinhood'], health: h }).kind, 'refused', 'a deposit never takes another wallet\'s reserve');
});

// ── (release 9, owner in chat 2026-11-05: “remove the limits, then the text stays true”) no permission caps on the Elysium funding
// path: the consent says "no daily or volume limits" and the code matches it. Release 8's caps tests became these "no cap" tests ──
test('(rel-9 no caps) the rule and its day ledger are gone from the core; the source enforces no perDay / feesPerDay / perChain / total', () => {
  for (const k of ['elyCapsProblem', 'elyDayAdd', 'elyDayFrom', 'elyDayOf', 'ELY_DAY_KEY']) assert.equal(EC[k], undefined, k);
  const eng = readFileSync(new URL('../src/elysiumUsdEngine.ts', import.meta.url), 'utf8');
  assert.ok(!/perDay6|feesPerDay6|perChain6|total6|ELY_DAY_KEY|elyCapsProblem/.test(eng), 'no cap is read or enforced on Elysium');
  const fe = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8');
  assert.match(fe, /function liveFor\(walletId: string\): \{ chains: FloatChain\[\] \} \| null \{/, 'liveFor hands the Elysium path the chains only');
});

test('(rel-9 no caps) own reserve: two $50 buys in a row both move (no daily cap); nothing is written to a day ledger', async () => {
  const x = world({ caps: { ...WIDE_CAPS, perDay6: 100n * C.USD6 }, moved6: 90n * C.USD6 });   // what release 8 would have refused
  const a = await click(x, 50);
  assert.equal(a.state, 'ready', JSON.stringify(a));
  x.st.wHype = 0n;
  const b = await click(x, 50);
  assert.equal(b.state, 'ready', JSON.stringify(b));
  assert.equal(x.solver.fills.length, 2, 'two transfers, one per click');
  assert.ok(![...x.st.store.keys()].some((k) => k.startsWith('trenches.ely-usd.day.')), 'no day ledger');
});

test('(rel-9 no caps) per-chain and total: HYPE already on Elysium and the float\'s floats do not block; a grant without caps moves', async () => {
  const perChain = world({ caps: { ...WIDE_CAPS, perChain6: 100n * C.USD6 }, wHype: 5n * E18 / 4n - 10n ** 17n });
  const a = await click(perChain, 100);
  assert.equal(a.state, 'ready', JSON.stringify(a)); assert.equal(perChain.solver.fills.length, 1);
  const total = world({ caps: { ...WIDE_CAPS, total6: 100n * C.USD6 }, floats6: 60n * C.USD6 });
  const b = await click(total, 50);
  assert.equal(b.state, 'ready', JSON.stringify(b)); assert.equal(total.solver.fills.length, 1);
  const none = world({ noCaps: true });
  const c = await click(none, 50);
  assert.equal(c.state, 'ready', JSON.stringify(c)); assert.equal(none.solver.fills.length, 1);
});

test('(rel-9 no caps) the bounds that stay: no live grant → nothing moves; short → nothing moves (refused, never trimmed)', async () => {
  const off = world({ off: true });
  const a = await click(off, 50);
  assert.notEqual(a.state, 'ready'); assert.equal(off.solver.fills.length, 0);
  const short = world({ rhUsdg: 10_000_000n });
  const b = await click(short, 50);
  assert.notEqual(b.state, 'ready'); assert.equal(short.solver.fills.length, 0);
});

test('(rel-9 no caps) a donor pays with no cap of its own: a second $50 from the same donor moves; its grant is still checked', async () => {
  const tight = { ...WIDE_CAPS, perDay6: 60n * C.USD6 };
  const x = account({ acked: true, xw: true, wallets: [{ id: 'w1', name: 'Main' }, { id: 'w2', name: 'Wallet 2', rh: 200, perm: { chains: ['robinhood'], caps: tight } }] });
  const a = await clickOf(x, 'w1', 50);
  assert.equal(a.state, 'ready', JSON.stringify(a));
  x.st.wHype.set('w1', 0n);
  const b = await clickOf(x, 'w1', 50);
  assert.equal(b.state, 'ready', JSON.stringify(b));
  assert.deepEqual(x.st.signedBy, ['w2', 'w2'], 'the donor paid both');
  assert.ok(![...x.st.store.keys()].some((k) => k.startsWith('trenches.ely-usd.day.')), 'no day ledger');
});
