// USD balance fix pass (2026-11-01, owner “full go-ahead … trading speed and stability first”):
//   1. a second top-up / refill of the same chain in the same calendar minute ran nothing (its id was taken by the first, ARRIVED
//      job) while the answer still listed it as planned: the page waited 15 s, then "not sent" (usd-trading-same-minute-topup-skipped)
//   2. the Solana direct buy's gas ask waited for SOL_GAS.enough (2.1M lamports), not for what the build needs (~3.1M+), and
//      built again on a "has-gas" answer that could only be refused again (usd-trading-sol-direct-gas-mismatch)
//   3. stable sent straight to W on ANOTHER EVM chain was converted only by that chain's own frame (usd-trading-offframe-deposits)
// A Solana frame on a mocked chain with a fake clock (the float-refill world) plus motion's solver over fetch.
//   node --test test/usd-misc.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const SOLC = F.FLOAT_CFG.sol, RHC = F.FLOAT_CFG.robinhood;
const W_EVM = '0x00000000000000000000000000000000000000a1', R_EVM = '0x00000000000000000000000000000000000000b2';
const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
const usd = (x) => BigInt(Math.round(x * 1e6));
const lamportsFor = (dollars) => BigInt(Math.round(dollars * 1e7));   // $100 a SOL: $1 = 0.01 SOL
const T0 = 1_800_000_000_000;                                           // the first millisecond of a calendar minute

function world(o = {}) {
  let T = T0;
  const st = { wLam: SOLC.gasFloor + lamportsFor(o.wTrading ?? 12), rLam: o.rLam ?? 10_000_000n, rUsdc: usd(o.rUsdc ?? 200), sent: [], gas: [], landed: o.landed ?? true, topupFails: o.topupFails ?? null,
    other: { wUsdg: o.wUsdg ?? 0n, wEth: o.wEth ?? 1_000_000_000_000_000n, reads: 0 }, fwds: [], receipts: new Map() };
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: T, lastTradeAt: T - 5_000, limitBusy: false, ...(o.click || {}) };
  const store = new Map();
  const w = { id: 'w1', name: 'Wallet 1', w: { evm: W_EVM, sol: sol.W }, r: { evm: R_EVM, sol: sol.R } };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const deps = {
    chain: () => 'sol',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return w; },
    wallets: () => ({ list: [w], skipped: [] }),
    sol: {
      balance: async (a) => (a === sol.W ? st.wLam : st.rLam), usdc: async (a) => (a === sol.R ? st.rUsdc : 0n), oracle6: async () => 100n * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      topup: async (id, usdcIn, minLamports) => {
        if (st.topupFails) throw new Error(st.topupFails);
        st.sent.push({ kind: 'topup', usdcIn, at: T }); st.rUsdc -= usdcIn; st.wLam += minLamports; return 'sig' + st.sent.length;
      },
      sweep: async () => { st.sent.push({ kind: 'sweep', at: T }); return 'sigs'; },
      gas: async () => { st.sent.push({ kind: 'gas', at: T }); return 'sigg'; },
      status: async () => (st.landed ? 'confirmed' : null),
    },
    ...(o.solver === false ? {} : { solver: {
      base: () => 'https://motion.test', pinnedKey: () => 'ab'.repeat(32),
      signEvmTransfer: async () => { throw new Error('test: nothing to bridge'); }, signSolTransfer: async () => { throw new Error('test: nothing to bridge'); },
      reserveOn: async (k, token, owner) => { st.other.reads++; assert.equal(k, 'robinhood'); assert.equal(token.toLowerCase(), RHC.stable.address.toLowerCase()); return owner.toLowerCase() === W_EVM ? { stable: st.other.wUsdg, native: st.other.wEth } : { stable: 0n, native: 0n }; },
    } }),
    ...(o.nativeDonor === false ? {} : { nativeDonor: {
      read: async (k, owner) => { st.other.reads++; return { native: owner.toLowerCase() === W_EVM ? st.other.wEth : 0n, price6: 4000n * F.USD, gasPrice: 20_000_000n }; },
      send: async () => { throw new Error('test: no native donor move expected'); },
      receipt: async (k, h) => st.receipts.get(h) ?? null,
    } }),
    ...(o.wForward === false ? {} : { wForward: { send: async (id, k, amount) => {
      if (o.fwdLost) { const h = '0xlost' + st.fwds.length; st.fwds.push({ id, k, amount, h, lost: true }); throw Object.assign(new Error('Forward send outcome unknown (timed out)'), { name: 'FloatUnknown', hash: h }); }
      const h = '0xfwd' + st.fwds.length; st.fwds.push({ id, k, amount, h }); st.other.wUsdg -= amount; return h;
    } } }),
    ask: async () => true, gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => h, muted: (h) => h },
    now: () => T,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(),
    emit: () => {},
    fetch: async (url, init) => {
      const path = String(url).split('/api/bridge/motion')[1];
      if (path == null) throw new Error('no network in this test: ' + url);
      if (path.startsWith('/health')) return json({ ok: true, on: true, solver: 'ab'.repeat(32), chains: ['robinhood', 'bsc', 'sol'], deposits: {}, maxFillUsd: 250, minFillUsd: 2, feeBps: 0 });
      if (path.startsWith('/gas')) {
        const b = JSON.parse(init?.body || '{}'); st.gas.push({ ...b, at: T });
        const a = o.gasAnswer ? o.gasAnswer(b, st) : { ok: true, state: 'sent', hash: 'gas1' };
        return json(a);
      }
      throw new Error('test: unexpected solver call ' + path);
    },
    click: () => click,
    wait: async (ms) => { T += ms; if (st.onWait) st.onWait(T); },
  };
  const f = createFloat(Object.assign(deps, { readyFloat: true, gasFromW: true }));   // usd-mode2: the buffer of before
  const prefs = (p) => store.set(`trenches.float.v1.prefs.sol.${W_EVM}`, JSON.stringify({ activeAt: T, presets6: [String(usd(10))], ...p }));
  const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
  return { f, st, click, store, prefs, settle, deps, advance: (ms) => { T += ms; }, now: () => T };
}
async function on(x, chains = ['sol']) {
  const r = await x.f.configure({ walletId: 'w1', chains }); assert.equal(r.ok, true);
  for (const k of [...x.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) x.store.delete(k);   // the switch-on conversion is not this test's
  x.prefs({});
}
const topups = (x) => x.st.sent.filter((s) => s.kind === 'topup');
const jobsOf = (x) => JSON.parse(x.store.get(`trenches.float.v1.jobs.sol.${W_EVM}`) || '[]');
const click = (x, usdAmt) => x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'click', usd: usdAmt });
const buy = (x, dollars) => { x.st.wLam -= lamportsFor(dollars); };   // the buy the page sent after its top-up

// ── 1. the same calendar minute ──
test('same minute: a second click\'s top-up runs (it was skipped: the first click\'s ARRIVED job held its id) and both stay in the ledger', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  const a = await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 1, 'click 1 tops up');
  assert.equal(a.click.state, 'moving');
  buy(x, 20);
  x.advance(20_000);                                    // 20 s later, the same calendar minute
  assert.equal(Math.floor(x.now() / 60_000), Math.floor(T0 / 60_000));
  const b = await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 2, 'click 2 tops up too: ' + JSON.stringify(b));
  assert.equal(b.click.state, 'moving', 'the page waits for a move that really runs');
  assert.ok(b.planned.every((m) => !m.skipped), 'nothing planned was left out: ' + JSON.stringify(b.planned));
  const done = jobsOf(x).filter((j) => j.kind === 'topup');
  assert.equal(done.length, 2, 'the first top-up keeps its own ledger line');
  assert.equal(new Set(done.map((j) => j.id)).size, 2);
  assert.equal(done[0].state, 'arrived'); assert.ok(['sent', 'arrived'].includes(done[1].state), done[1].state);
  const led = F.ledgerOf(done, x.now());
  assert.equal(led.movedToday6, BigInt(done[0].usd6) + BigInt(done[1].usd6), 'the day\'s cap counts both');
});

test('same minute: the after-trade refill 4 s after a click\'s top-up runs (it was skipped until the next minute)', async () => {
  const x = world({ wTrading: 12 }); await on(x);
  await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 1);
  buy(x, 20);
  x.advance(4_000);
  x.f.afterTrade(sol.W); await x.settle();
  assert.equal(topups(x).length, 2, 'the refill ran');
  const refill = jobsOf(x).find((j) => j.refill);
  assert.ok(refill && refill.state !== 'failed', JSON.stringify(refill));
  assert.equal(jobsOf(x).filter((j) => j.kind === 'topup').length, 2, 'the click top-up keeps its own line');
});

test('same minute: while the earlier move of the lane is still landing, the click waits for THAT one (moving, skipped: held) — even when it was the refill', async () => {
  const x = world({ wTrading: 12, landed: false }); await on(x);
  x.f.afterTrade(sol.W); await x.settle();             // a refill (not a click's move) is on its way
  assert.equal(topups(x).length, 1);
  assert.equal(jobsOf(x)[0].refill, true);
  x.advance(3_000);
  const b = await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 1, 'never a second move of the lane while one is open');
  assert.equal(b.click.state, 'moving', 'the landing refill is what the click waits for: ' + JSON.stringify(b.click));
  const t = b.planned.find((m) => m.kind === 'topup');
  assert.equal(t.skipped, 'held');
});

test('same minute: a top-up that failed under 30 s ago is the click\'s answer at once (failed, with why; skipped: backoff) — no 15 s wait for nothing', async () => {
  const x = world({ wTrading: 12, topupFails: 'the pool moved' }); await on(x);
  const a = await click(x, 20); await x.settle();
  assert.equal(a.click.state, 'failed');
  x.advance(10_000);
  x.st.topupFails = null;
  const b = await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 0, 'the back-off still holds: nothing re-sent within 30 s');
  assert.equal(b.click.state, 'failed', JSON.stringify(b.click));
  assert.match(b.click.why, /the pool moved/);
  assert.equal(b.planned.find((m) => m.kind === 'topup').skipped, 'backoff');
  // after the back-off the same move may run again
  x.advance(25_000);
  const c = await click(x, 20); await x.settle();
  assert.equal(topups(x).length, 1);
  assert.equal(c.click.state, 'moving');
});

test('freeJobId: arrived / refunded jobs keep their id (the next free one is taken); open, unknown and failed jobs keep the old rule on the same id', () => {
  const now = T0 + 5_000;
  const id0 = F.jobIdOf('w1', 'topup', 'sol', undefined, now);
  assert.equal(F.freeJobId([], 'w1', 'topup', 'sol', undefined, now).id, id0, 'the first move of a minute keeps the old id');
  const mk = (id, state) => ({ id, state, updatedAt: now - 1_000 });
  for (const state of ['arrived', 'refunded']) {
    const r = F.freeJobId([mk(id0, state)], 'w1', 'topup', 'sol', undefined, now);
    assert.notEqual(r.id, id0); assert.equal(r.existing, undefined);
    assert.equal(r.id, F.jobIdOf('w1', 'topup', 'sol', undefined, now, 1));
    const id1 = r.id;
    const r2 = F.freeJobId([mk(id0, state), mk(id1, 'arrived')], 'w1', 'topup', 'sol', undefined, now);
    assert.equal(r2.id, F.jobIdOf('w1', 'topup', 'sol', undefined, now, 2));
  }
  for (const state of ['planned', 'signing', 'sent', 'relaying', 'unknown', 'failed']) {
    const r = F.freeJobId([mk(id0, state)], 'w1', 'topup', 'sol', undefined, now);
    assert.equal(r.id, id0); assert.equal(r.existing.state, state);
    assert.equal(F.canRun(r.existing, now), false, state + ' is not run again here');
  }
  assert.equal(F.canRun(mk(id0, 'failed'), now + 30_000), true, 'a failed one after its back-off');
});

// ── 2. the Solana direct buy's gas ask ──
test('solDirectNeedOf reads solEngine\'s SolDirectNoGas text, rounded up past its 4 decimals', () => {
  const src = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /const solTxt = \(l: bigint\) => \(Number\(l\) \/ 1e9\)\.toFixed\(4\);/, 'the figure has 4 decimals');
  assert.match(src, /throw new SolDirectNoGas\(`The reserve needs about \$\{solTxt\(need\)\} for the network fee and account rent — it has \$\{solTxt\(have\)\}`\)/);
  const msg = (need, have) => `The reserve needs about ${(Number(need) / 1e9).toFixed(4)} for the network fee and account rent — it has ${(Number(have) / 1e9).toFixed(4)}`;
  for (const need of [3_061_200n, 3_149_999n, 5_216_640n, 12_000_000n]) {
    const got = F.solDirectNeedOf(new Error(msg(need, 2_000_000n)));
    assert.ok(got >= need && got - need <= 100_000n, `${need} → ${got}`);
  }
  assert.equal(F.solDirectNeedOf(new Error('Refused: something else')), undefined);
  assert.equal(F.solDirectNeedOf(null), undefined);
});

test('direct buy gas (Solana): the solver says has-gas at its 2.1M threshold but the build needs 3.15M → false at once (no second build that can only fail)', async () => {
  const x = world({ rLam: 2_500_000n, gasAnswer: () => ({ ok: true, state: 'has-gas' }) }); await on(x);
  const t = x.now();
  assert.equal(await x.f.directGas('w1', 3_150_000n), false);
  assert.ok(x.now() - t < 1_000, 'no 5 s wait');
  // without a need (an older caller) the old answer stands
  assert.equal(await x.f.directGas('w1'), true);
});

test('direct buy gas (Solana): the drop lands and covers the need → true; it lands short → false as soon as it is seen, not after 5 s', async () => {
  const ok = world({ rLam: 2_500_000n, gasAnswer: (b, st) => { st.onWait = (T) => { if (!st.dropAt) st.dropAt = T; if (T - st.dropAt >= 750) st.rLam = 5_500_000n; }; return { ok: true, state: 'sent', hash: 'g' }; } }); await on(ok);
  assert.equal(await ok.f.directGas('w1', 5_266_640n), true);
  assert.equal(ok.st.gas.length, 1); assert.equal(ok.st.gas[0].address, sol.R);
  const short = world({ rLam: 100_000n, gasAnswer: (b, st) => { st.onWait = (T) => { if (!st.dropAt) st.dropAt = T; if (T - st.dropAt >= 500) st.rLam = 3_100_000n; }; return { ok: true, state: 'sent', hash: 'g' }; } }); await on(short);
  const t = short.now();
  assert.equal(await short.f.directGas('w1', 5_266_640n), false);
  assert.ok(short.now() - t <= 1_500, 'gave up once the drop was seen short: ' + (short.now() - t) + ' ms');
});

// ── 3. stable sent straight to W on another EVM chain ──
const quiet = { lastTradeAt: T0 - 600_000, ticketAt: T0 - 600_000, hidden: true };
test('another chain: USDG sent straight to W on Robinhood is forwarded to its own R there by a quiet tick of the Solana frame (the phone has no Robinhood frame)', async () => {
  const x = world({ click: quiet, wUsdg: 30_000_000n }); await on(x, ['sol', 'robinhood']);
  await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(x.st.fwds.length, 1, 'one forward');
  assert.deepEqual({ k: x.st.fwds[0].k, amount: x.st.fwds[0].amount, id: x.st.fwds[0].id }, { k: 'robinhood', amount: 30_000_000n, id: 'w1' });
  // paced: the next tick within 5 minutes reads nothing more and sends nothing, while that forward may still land
  const reads = x.st.other.reads; x.st.other.wUsdg = 10_000_000n;
  x.advance(60_000); await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(x.st.fwds.length, 1); assert.equal(x.st.other.reads, reads);
  // landed, 5 minutes on: a second deposit goes too
  x.st.receipts.set('0xfwd0', 'success'); x.advance(300_000);
  await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(x.st.fwds.length, 2); assert.equal(x.st.fwds[1].amount, 10_000_000n);
});

test('another chain: never while the user is active or for a click; under $1 stays; a lost answer is followed, never re-sent blind; no host signer = nothing', async () => {
  const busy = world({ wUsdg: 30_000_000n }); await on(busy, ['sol', 'robinhood']);   // ticket just touched
  await busy.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await busy.settle();
  assert.equal(busy.st.fwds.length, 0);
  const forClick = world({ click: quiet, wUsdg: 30_000_000n }); await on(forClick, ['sol', 'robinhood']);
  await click(forClick, 20); await forClick.settle();
  assert.equal(forClick.st.fwds.length, 0, 'a click is never held up by it');
  const dust = world({ click: quiet, wUsdg: 900_000n }); await on(dust, ['sol', 'robinhood']);
  await dust.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await dust.settle();
  assert.equal(dust.st.fwds.length, 0);
  const lost = world({ click: quiet, wUsdg: 30_000_000n, fwdLost: true }); await on(lost, ['sol', 'robinhood']);
  await lost.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await lost.settle();
  assert.equal(lost.st.fwds.length, 1);
  lost.advance(400_000); await lost.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await lost.settle();
  assert.equal(lost.st.fwds.length, 1, 'its hash may still land: not sent again');
  const off = world({ click: quiet, wUsdg: 30_000_000n }); await on(off, ['sol']);   // Robinhood is not part of the permission
  await off.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await off.settle();
  assert.equal(off.st.fwds.length, 0);
  const old = world({ click: quiet, wUsdg: 30_000_000n, wForward: false }); await on(old, ['sol', 'robinhood']);
  await old.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await old.settle();
  assert.equal(old.st.other.reads, 0, 'an older host reads nothing more');
});

test('another chain: W without the gas for its one transfer asks motion\'s gas drop for W on that chain first; refused = nothing sent', async () => {
  const x = world({ click: quiet, wUsdg: 30_000_000n, wEth: 0n, gasAnswer: (b) => ({ ok: false, reason: 'busy, try later' }) }); await on(x, ['sol', 'robinhood']);
  await x.f.ensure({ walletId: 'w1', chain: 'sol', reason: 'tick' }); await x.settle();
  assert.equal(x.st.gas.length, 1); assert.equal(x.st.gas[0].chain, 'robinhood'); assert.equal(x.st.gas[0].address.toLowerCase(), W_EVM);
  assert.equal(x.st.fwds.length, 0);
});

test('the host signer: one transfer of that chain\'s float stable to THIS wallet\'s R, built by the host (nothing from the caller but the amount)', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function wForwardSend('), src.indexOf('async function nativeDonorReceipt('));
  assert.ok(fn.length > 200);
  assert.match(fn, /const r = reserveOf\(a\)/);
  assert.match(fn, /to: token, data: bridgeTransferData\(r\.evm, amount\)/, 'to that chain\'s stable, paying its own R only');
  assert.match(fn, /const token = fc\.stable\.address/);
  assert.match(fn, /if \(held < amount\) throw/);
  assert.match(fn, /laneLock\(oc\.key \+ ':' \+ account\.address\.toLowerCase\(\)/);
  assert.match(fn, /while \(tradeRunning\(\)\) await floatWait\(100\)/);
  assert.doesNotMatch(fn, /tx\.data|tx\.to/, 'no caller-supplied bytes');
  assert.match(src, /wForward: \{ send: wForwardSend as never \}/);
});
