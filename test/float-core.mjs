// USD balance — the pure core (src/floatCore.ts): money math, rounding, staleness, sizing, the plan, caps, the price check,
// argument shapes, the permission, jobs, click windows, bridges (failover, health, the deposit checks) and the network fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as F from '../src/floatCore.ts';

const D = (n) => F.usd6(n);
const NOW = 1_792_950_000_000;

test('R = HMAC-SHA256(W key, "motion/usd-reserve/v1"), refused for anything that is not an EVM key', () => {
  const k = '0x' + '11'.repeat(32);
  const want = '0x' + createHmac('sha256', Buffer.from(k.slice(2), 'hex')).update('motion/usd-reserve/v1').digest('hex');
  assert.equal(F.reserveKeyOf(k), want);
  assert.notEqual(F.reserveKeyOf('0x' + '22'.repeat(32)), want);
  assert.throws(() => F.reserveKeyOf('near:abc'), /EVM-key/);
  assert.throws(() => F.reserveKeyOf('0x1234'), /EVM-key/);
});

test('dollars ↔ native: amounts round down, costs round up, stable decimals 6 and 18', () => {
  const eth = 4000n * F.USD;   // $4,000 per ETH
  assert.equal(F.nativeToUsd6(10n ** 18n, eth, 18), 4000n * F.USD);
  assert.equal(F.nativeToUsd6(1n, eth, 18), 0n);            // 1 wei is less than a micro-dollar
  assert.equal(F.nativeToUsd6Up(1n, eth, 18), 1n);          // …but a cost of 1 wei is never shown as zero
  assert.equal(F.usd6ToNative(D(50), eth, 18), 12_500_000_000_000_000n);
  assert.equal(F.usd6ToNative(D(1), 3n * F.USD, 18), 333_333_333_333_333_333n);   // floor
  assert.equal(F.stableToUsd6(1_500_000n, 6), D(1.5));
  assert.equal(F.stableToUsd6(15n * 10n ** 17n, 18), D(1.5));
  assert.equal(F.usd6ToStable(D(1.5), 18), 15n * 10n ** 17n);
  assert.equal(F.stableToUsd6(F.usd6ToStable(D(123.456789), 18), 18), D(123.456789));
  assert.equal(F.usd6ToNative(D(5), 0n, 18), 0n);           // no price: nothing, never a division by zero
});

test('fmtUsd6: a real cost is never "$0.00", costs round up, balances round half up', () => {
  assert.equal(F.fmtUsd6(4_000n, { cost: true }), '<$0.01');
  assert.equal(F.fmtUsd6(10_001n, { cost: true }), '$0.02');
  assert.equal(F.fmtUsd6(10_001n), '$0.01');
  assert.equal(F.fmtUsd6(D(1234.5)), '$1,234.50');
  assert.equal(F.fmtUsd6(0n, { cost: true }), '$0.00');
  assert.equal(F.fmtUsd6(-D(2)), '−$2.00');
});

test('oracle: slot0 → micro-dollars per native, RH (WETH token0, USDG 6 dec) and BNB (WBNB token1, USDT 18 dec)', () => {
  // build sqrtPriceX96 for a known price and read it back
  const sqrtOf = (ratio) => { // ratio = token1 raw per token0 raw (a float), → sqrtPriceX96
    return BigInt(Math.floor(Math.sqrt(ratio) * 2 ** 96));
  };
  // ETH at $3,912.34: token1 (USDG raw, 6 dec) per token0 (wei) = 3912.34e6 / 1e18
  const rh = F.oraclePrice6(sqrtOf(3912.34e6 / 1e18), F.FLOAT_CFG.robinhood.oracle);
  assert.ok(Math.abs(Number(rh) / 1e6 - 3912.34) < 0.01, String(rh));
  // BNB at $612.5: token0 = USDT (18), token1 = WBNB (18); token1 per token0 = 1/612.5
  const bnb = F.oraclePrice6(sqrtOf(1 / 612.5), F.FLOAT_CFG.bsc.oracle);
  assert.ok(Math.abs(Number(bnb) / 1e6 - 612.5) < 0.01, String(bnb));
  assert.equal(F.oraclePrice6(0n, F.FLOAT_CFG.robinhood.oracle), 0n);
});

test('staleness: fresh < 60 s, stale < 10 min, then dead', () => {
  assert.equal(F.priceState(NOW - 59_000, NOW), 'fresh');
  assert.equal(F.priceState(NOW - 61_000, NOW), 'stale');
  assert.equal(F.priceState(NOW - 599_000, NOW), 'stale');
  assert.equal(F.priceState(NOW - 601_000, NOW), 'dead');
  assert.equal(F.priceState(0, NOW), 'dead');
});

test('sizing: max(largest preset, p75 of the last 20 buys); target clamp $10–$250 and the per-chain cap; idle chains hold the gas floor', () => {
  assert.equal(F.sizeOf([D(5), D(10), D(25), D(50)], []), D(50));
  assert.equal(F.sizeOf([D(10)], [D(20), D(30), D(40), D(200)]), D(200));   // p75 of 4 = index 3
  assert.equal(F.sizeOf([], Array.from({ length: 30 }, (_, i) => D(i + 1))), D(26));   // last 20 = 11..30, p75 = index 15 → 26
  let t = F.targetOf('robinhood', D(50), true, D(250));
  assert.deepEqual([t.trading6, t.low6, t.high6], [D(75), D(45), D(150)]);
  assert.equal(F.targetOf('robinhood', D(1), true, D(250)).trading6, D(10));
  assert.equal(F.targetOf('robinhood', D(1000), true, D(250)).trading6, D(250));
  assert.equal(F.targetOf('robinhood', D(1000), true, D(100)).trading6, D(100));
  t = F.targetOf('sol', D(50), false, D(250));
  assert.equal(t.trading6, 0n); assert.equal(t.gasFloor, 20_000_000n);
  assert.equal(F.tradingUsd6('robinhood', F.FLOAT_CFG.robinhood.gasFloor - 1n, 4000n * F.USD), 0n);
});

// a whole-wallet plan input
const ETH = 4000n * F.USD, BNB = 600n * F.USD, SOL = 100n * F.USD;
const chainState = (over = {}) => ({ price6: ETH, priceAt: NOW - 5_000, float: 0n, reserve: 0n, reserveNative: 10n ** 18n, active: true, presets6: [D(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...over });
const planIn = (over = {}) => ({ now: NOW, caps: F.DEFAULT_CAPS, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: D(5000), movedToday6: 0n, feesToday6: 0n, estFee6: () => D(0.02), chains: {}, ...over });
const eth = (usd) => F.FLOAT_CFG.robinhood.gasFloor + F.usd6ToNative(D(usd), ETH, 18);

test('plan: a float under 60 % of target is topped up to target from the same chain\'s reserve', () => {
  const p = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(20), reserve: 500_000_000n }) } }));
  assert.equal(p.moves.length, 1);
  const m = p.moves[0];
  assert.equal(m.kind, 'topup'); assert.equal(m.chain, 'robinhood');
  assert.ok(m.usd6 >= D(54.99) && m.usd6 <= D(55), String(m.usd6));   // target 75 − ~20 ready
  assert.equal(m.fee6, D(0.02));
});

test('plan: between low and high nothing moves (hysteresis); above high an idle chain sweeps back to target', () => {
  assert.equal(F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(60), reserve: 500_000_000n, idle: true }) } })).moves.length, 0);
  const notIdle = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(200), reserve: 500_000_000n, idle: false }) } }));
  assert.equal(notIdle.moves.length, 0);
  const p = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(200), reserve: 500_000_000n, idle: true }) } }));
  assert.equal(p.moves[0].kind, 'sweep');
  assert.ok(p.moves[0].usd6 > D(124) && p.moves[0].usd6 <= D(125));
  // nothing sweeps while a top-up is landing
  assert.equal(F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(200), idle: true, inFlight6: D(1) }) } })).moves.length, 0);
});

test('plan: caps — 30 % of the wallet, the daily volume, the daily fee cap; the newest intent is trimmed and says so', () => {
  const small = F.planMoves(planIn({ walletUsd6: D(100), chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n }) } }));
  assert.equal(small.moves[0].usd6, D(30)); assert.equal(small.moves[0].trimmed, true);
  const day = F.planMoves(planIn({ movedToday6: D(990), chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n }) } }));
  assert.equal(day.moves[0].usd6, D(10)); assert.equal(day.moves[0].trimmed, true);
  const dayFull = F.planMoves(planIn({ movedToday6: D(998), chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n }) } }));
  assert.equal(dayFull.moves.length, 0); assert.equal(dayFull.skips[0].why, 'cap-day');
  const fees = F.planMoves(planIn({ feesToday6: D(1.99), chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n }) } }));
  assert.equal(fees.moves.length, 0); assert.equal(fees.skips[0].why, 'cap-fees');
});

test('plan: a stale (dead) price plans nothing; R without gas gets it from W first, and only while idle', () => {
  const dead = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n, priceAt: NOW - 700_000 }) } }));
  assert.deepEqual(dead.skips.map((s) => s.why), ['stale-price']);
  const gas = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(20), reserve: 500_000_000n, reserveNative: 0n, idle: true }) } }));
  assert.equal(gas.moves[0].kind, 'gas');
  const noGas = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(20), reserve: 500_000_000n, reserveNative: 0n, idle: false }) } }));
  assert.equal(noGas.moves.length, 0); assert.equal(noGas.skips[0].why, 'no-gas');
});

// W's gas floor on BNB Chain in dollars at the tests' $600: a click on a chain where W holds nothing tops it up too (2026-11-01)
const BNB_FLOOR6 = F.nativeToUsd6Up(F.FLOAT_CFG.bsc.gasFloor, BNB, 18);
test('plan: a click whose chain reserve is short swaps all of it and bridges the rest from another reserve, any amount from $0.10 (2026-10-27: a $120 BNB buy got $115 and failed)', () => {
  const chains = {
    robinhood: chainState({ float: eth(0), reserve: 1_500n * 10n ** 6n }),
    bsc: chainState({ price6: BNB, float: 0n, reserve: 115n * 10n ** 18n }),
  };
  const ask = (ch) => F.planMoves(planIn({ caps: F.plannedCaps(F.DEFAULT_CAPS), chains: ch, enabled: ['robinhood', 'bsc'], urgent: { chain: 'bsc', usd6: D(120) } }));
  const u = ask(chains);
  const top = u.moves.find((m) => m.kind === 'topup' && m.chain === 'bsc');
  const cold = u.moves.find((m) => m.kind === 'cold' && m.chain === 'bsc');
  assert.equal(top.usd6, D(115));
  assert.ok(cold, JSON.stringify(u, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  // to $120 + 25 % + W's 0.001 BNB gas floor ($0.60: W holds no BNB at all; 2026-11-01, before it the click landed $0.60 short)
  assert.equal(cold.from, 'robinhood'); assert.equal(cold.usd6, D(150) - D(115) + BNB_FLOOR6);
  // a few cents short still bridges (was: under $5 dropped, and a bridge move needed $100)
  const tiny = ask({ ...chains, bsc: chainState({ price6: BNB, float: 0n, reserve: 150_400_000_000_000_000_000n }) });
  const c2 = tiny.moves.find((m) => m.kind === 'cold'); assert.ok(c2); assert.equal(c2.usd6, D(0.2));
});

test('plan: a click takes its cold top-up first from a reserve the clicking frame can sign for (urgentFrom), even when another is richer', () => {
  const chains = { robinhood: chainState({ float: eth(0), reserve: 300n * 10n ** 6n }), bsc: chainState({ price6: BNB, float: 0n, reserve: 0n }), sol: chainState({ price6: SOL, float: 0n, reserve: 900_000_000n }) };
  const ask = (from) => F.planMoves(planIn({ caps: F.plannedCaps(F.DEFAULT_CAPS), chains, urgent: { chain: 'bsc', usd6: D(100) }, urgentFrom: from }));
  assert.equal(ask(undefined).moves.find((m) => m.kind === 'cold').from, 'sol');   // richest
  assert.equal(ask(['robinhood']).moves.find((m) => m.kind === 'cold').from, 'robinhood');
});

test('plan: the Solana reserve an EVM frame can sign for (urgentLater) comes after the EVM reserves, unless it alone covers what they cannot (2026-10-27)', () => {
  const bsc0 = chainState({ price6: BNB, float: 0n, reserve: 0n });
  const ask = (rh, sol, later) => F.planMoves(planIn({ caps: F.plannedCaps(F.DEFAULT_CAPS), urgent: { chain: 'bsc', usd6: D(100) }, urgentFrom: ['robinhood'], ...(later ? { urgentLater: later } : {}),
    chains: { robinhood: chainState({ float: eth(0), reserve: D(rh) }), bsc: bsc0, sol: chainState({ price6: SOL, float: 0n, reserve: D(sol) }) } }));
  const colds = (p) => p.moves.filter((m) => m.kind === 'cold').map((m) => [m.from, Number(m.usd6) / 1e6]);
  // the EVM reserve covers the click (need + 25 % + W's $0.60 BNB gas floor): exactly the plan without the Solana reserve signable
  const F6 = Number(BNB_FLOOR6) / 1e6;
  assert.deepEqual(colds(ask(300, 900, ['sol'])), [['robinhood', 125 + F6]]);
  assert.deepEqual(ask(300, 900, ['sol']), ask(300, 900));
  // the EVM reserves are short and Solana alone covers the need: one fill from Solana, not two
  assert.deepEqual(colds(ask(50, 900, ['sol'])), [['sol', 125 + F6]]);
  // nobody covers alone: the EVM reserve first, then Solana, and what is still missing is reported
  const both = ask(50, 60, ['sol']);
  assert.deepEqual(colds(both), [['robinhood', 50], ['sol', 60]]);
  assert.deepEqual(both.short, { chain: 'bsc', usd6: D(15) + BNB_FLOOR6 });
  // without urgentLater nothing changes: the EVM reserve first, the rest planned from Solana as before (not signable here)
  assert.deepEqual(colds(ask(50, 900)), [['robinhood', 50], ['sol', 75 + F6]]);
  assert.equal(ask(50, 900).short, undefined);
  // no reserve anywhere: the whole need is short
  assert.deepEqual(ask(0, 0, ['sol']).short, { chain: 'bsc', usd6: D(125) + BNB_FLOOR6 });
  assert.equal(ask(300, 900).short, undefined);
});

test('a Solana reserve pays its one bridge transfer only if it stays rent-exempt (fee 5 000 + 3 000 lamports, rent 890 880)', () => {
  assert.deepEqual(F.SOL_BRIDGE, { units: 60_000, micro: 50_000 });
  assert.equal(F.solBridgeFeeOk(898_880n), true);
  assert.equal(F.solBridgeFeeOk(898_879n), false);
  assert.equal(F.solBridgeFeeOk(0n), false);
  assert.equal(F.solBridgeFeeOk(F.FLOAT_CFG.sol.reserveGas), true);
});

test('plan: no local reserve → a cross-chain rebalance of ≥ $100 from the richest reserve; a waiting click takes the cold top-up instead', () => {
  const chains = {
    robinhood: chainState({ float: eth(0), reserve: 0n }),
    bsc: chainState({ price6: BNB, float: 0n, reserve: 300n * 10n ** 18n, active: false }),
    sol: chainState({ price6: SOL, float: 20_000_000n, reserve: 120_000_000n, active: false }),
  };
  const p = F.planMoves(planIn({ chains }));
  const r = p.moves.find((m) => m.kind === 'rebalance');
  assert.ok(r); assert.equal(r.from, 'bsc'); assert.equal(r.chain, 'robinhood'); assert.equal(r.usd6, D(100));
  const u = F.planMoves(planIn({ chains, urgent: { chain: 'robinhood', usd6: D(150) } }));
  const c = u.moves.find((m) => m.chain === 'robinhood');
  assert.equal(c.kind, 'cold'); assert.equal(c.from, 'bsc'); assert.equal(c.usd6, (D(150) * 125n) / 100n);   // the need + 25 %
  // a bridge already landing on that chain: no second one
  const busy = F.planMoves(planIn({ chains: { ...chains, robinhood: chainState({ float: eth(0), reserve: 0n, busyBridge: true }) } }));
  assert.ok(busy.skips.some((s) => s.chain === 'robinhood' && s.why === 'bridge-busy'));
  // no donor with $100: nothing, said so
  const none = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(0), reserve: 0n }), sol: chainState({ price6: SOL, float: 20_000_000n, reserve: 50_000_000n, active: false }) } }));
  assert.ok(none.skips.some((s) => s.why === 'no-reserve'));
});

test('withinCaps: an asked-for move over a cap is refused with the cap named, never trimmed', () => {
  const led = { movedToday6: 0n, feesToday6: 0n, floatsUsd6: 0n, chainFloat6: 0n, walletUsd6: D(10_000) };
  assert.equal(F.withinCaps({ kind: 'topup', usd6: D(100), fee6: D(0.1) }, led, F.DEFAULT_CAPS), null);
  assert.match(F.withinCaps({ kind: 'topup', usd6: D(300), fee6: D(0.1) }, led, F.DEFAULT_CAPS), /per-chain cap of \$250/);
  assert.match(F.withinCaps({ kind: 'topup', usd6: D(100), fee6: D(0.1) }, { ...led, floatsUsd6: D(450) }, F.DEFAULT_CAPS), /total cap/);
  assert.match(F.withinCaps({ kind: 'rebalance', usd6: D(100), fee6: D(2.5) }, led, F.DEFAULT_CAPS), /fee cap/);
  assert.match(F.withinCaps({ kind: 'rebalance', usd6: D(100), fee6: 0n }, { ...led, movedToday6: D(950) }, F.DEFAULT_CAPS), /daily cap/);
});

test('price check: minOut ≥ (in − fees) at the oracle × (1 − max slippage), both directions', () => {
  const amountIn = 100_000_000n;   // 100 USDG
  const floor = F.minOutFloor('stable→native', amountIn, ETH, 'robinhood', 50, D(0.02));
  assert.equal(floor, ((F.usd6ToNative(D(99.98), ETH, 18)) * 9950n) / 10_000n);
  assert.equal(F.quoteOk('stable→native', amountIn, floor, ETH, 'robinhood', 50, D(0.02)), null);
  assert.match(F.quoteOk('stable→native', amountIn, floor - 1n, ETH, 'robinhood', 50, D(0.02)), /below the oracle/);
  assert.match(F.quoteOk('stable→native', amountIn, 0n, ETH, 'robinhood', 50, 0n), /no minimum/);
  assert.match(F.quoteOk('stable→native', amountIn, 1n, 0n, 'robinhood', 50, 0n), /No oracle/);
  assert.match(F.quoteOk('stable→native', 10_000n, 1n, ETH, 'robinhood', 50, D(0.02)), /eat the whole/);
  const back = F.minOutFloor('native→stable', 10n ** 16n, ETH, 'bsc', 50, 0n);   // 0.01 BNB at the BNB cfg's 18-dec USDC
  assert.equal(back, (F.usd6ToStable(D(40), 18) * 9950n) / 10_000n);
});

test('page arguments: exact shapes, unknown fields and bad values refused', () => {
  assert.doesNotThrow(() => F.floatArgs('status', { walletId: 'w1' }));
  assert.doesNotThrow(() => F.floatArgs('configure', { walletId: 'w1', chains: ['robinhood', 'sol'], caps: { perDay: 500, maxSlipBps: 30 } }));
  assert.doesNotThrow(() => F.floatArgs('ensure', { walletId: 'w1', chain: 'bsc', usd: 25, reason: 'click' }));
  assert.doesNotThrow(() => F.floatArgs('ensure', { walletId: 'w1', chain: 'bsc', reason: 'preset', presets: [5, 10, 25] }));
  for (const [m, o, re] of [
    ['status', { walletId: 'w1', to: '0xabc' }, /unknown field to/],
    ['ensure', { walletId: 'w1', chain: 'eth', reason: 'tick' }, /chain/],
    ['ensure', { walletId: 'w1', chain: 'sol', reason: 'because' }, /reason/],
    ['ensure', { walletId: 'w1', chain: 'sol', reason: 'click', usd: -1 }, /usd/],
    ['ensure', { walletId: 'w1', chain: 'sol', reason: 'click', usd: '5' }, /usd/],
    ['configure', { walletId: 'w1', chains: [] }, /chains/],
    ['configure', { walletId: 'w1', chains: ['sol', 'sol'] }, /chains/],
    ['configure', { walletId: 'w1', chains: ['sol'], caps: { perDay: 1e9 } }, /out of range/],
    ['configure', { walletId: 'w1', chains: ['sol'], caps: { recipient: 'x' } }, /unknown field caps.recipient/],
    ['configure', { walletId: 'w1', chains: ['sol'], caps: { perChain: 900, total: 500 } }, /perChain above total/],
    ['sweep', { walletId: 'w1' }, /chain missing/],
    ['send', { walletId: 'w1' }, /unknown method/],
    ['status', null, /one plain object/],
    ['status', { walletId: '../../x y' }, /walletId/],
  ]) assert.throws(() => F.floatArgs(m, o), re, `${m} ${JSON.stringify(o)}`);
});

test('permission: the dialog text states today\'s rules (no volume caps); the digest binds the caps; expiry and tampering void it', () => {
  const text = F.permissionText('Wallet 1', ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, D(0.35));
  for (const s of ['Wallet 1', 'Robinhood, BNB and Solana', 'plus 25 %', 'no daily or volume limits', 'from $0.10, up to $1,000 per transfer', 'about $0.20, at most once a day per chain', 'sent straight to a wallet joins its USD balance (from $1)', '0.50 %', 'Expected upkeep: about $0.35 a week', 'Nothing else can leave your wallets', 'own reserve: the reserve buys the coin', 'ETH / BNB / SOL', 'Valid for 30 days']) assert.ok(text.includes(s), s);
  for (const s of ['$1,000.00 a day', 'a day in fees', 'ready per chain']) assert.ok(!text.includes(s), s);
  const base = { v: 1, wallet: '0xAbC', reserve: '0xdef', chains: ['robinhood'], caps: F.DEFAULT_CAPS, grantedAt: NOW, expiresAt: NOW + 30 * 86_400_000, ...F.rulesField(F.FLOAT_RULES.current) };
  const p = { ...base, digest: F.permissionDigest(base) };
  assert.ok(F.permissionLive(p, NOW));
  assert.ok(!F.permissionLive(p, NOW + 31 * 86_400_000));
  assert.ok(!F.permissionLive({ ...p, caps: { ...p.caps, perDay6: D(10_000) } }, NOW));
  assert.ok(!F.permissionLive({ ...p, chains: ['robinhood', 'sol'] }, NOW));
  assert.ok(F.capsRaise(F.DEFAULT_CAPS, { ...F.DEFAULT_CAPS, total6: D(600) }));
  assert.ok(!F.capsRaise(F.DEFAULT_CAPS, { ...F.DEFAULT_CAPS, total6: D(400) }));
  assert.ok(F.capsRaise(null, F.DEFAULT_CAPS));
});

test('jobs: deterministic ids per minute (idempotent ensure), unknown is never retried, failed waits 30 s; the day\'s ledger', () => {
  assert.equal(F.jobIdOf('w', 'topup', 'sol', undefined, NOW), F.jobIdOf('w', 'topup', 'sol', undefined, NOW + 1_000));
  assert.notEqual(F.jobIdOf('w', 'topup', 'sol', undefined, NOW), F.jobIdOf('w', 'sweep', 'sol', undefined, NOW));
  const j = (state, updatedAt = NOW) => ({ id: 'x', walletId: 'w', kind: 'topup', chain: 'sol', usd6: String(D(50)), fee6: String(D(0.01)), state, at: NOW - 1000, updatedAt, hashes: [], reason: 't' });
  assert.ok(F.canRun(undefined, NOW));
  assert.ok(!F.canRun(j('unknown'), NOW + 3_600_000));
  assert.ok(!F.canRun(j('sent'), NOW));
  assert.ok(!F.canRun(j('failed', NOW), NOW + 10_000));
  assert.ok(F.canRun(j('failed', NOW), NOW + 31_000));
  const led = F.ledgerOf([j('arrived'), j('sent'), j('failed'), j('planned')], NOW);
  assert.equal(led.movedToday6, D(100)); assert.equal(led.feesToday6, D(0.02)); assert.equal(led.upkeepWeek6, D(0.02));
});

test('click windows (I3) and the sweep idle rule', () => {
  assert.ok(F.inClickWindow({ clickAt: NOW, clickDoneAt: NOW - 5_000, focusAt: 0 }, NOW + 100));     // between call and broadcast
  assert.ok(F.inClickWindow({ clickAt: NOW - 3_000, clickDoneAt: NOW - 1_000, focusAt: 0 }, NOW));    // + 2 s tail
  assert.ok(!F.inClickWindow({ clickAt: NOW - 5_000, clickDoneAt: NOW - 2_500, focusAt: 0 }, NOW));
  assert.ok(F.inClickWindow({ clickAt: 0, clickDoneAt: 0, focusAt: NOW - 9_000 }, NOW));              // focus + 10 s
  assert.ok(!F.inClickWindow({ clickAt: 0, clickDoneAt: 0, focusAt: NOW - 11_000 }, NOW));
  const base = { lastTradeAt: NOW - 61_000, focusedChain: null, hidden: false, ticketAt: NOW - 61_000, limitBusy: false };
  assert.ok(F.idleFor(base, 'sol', NOW));
  assert.ok(!F.idleFor({ ...base, lastTradeAt: NOW - 10_000 }, 'sol', NOW));
  assert.ok(!F.idleFor({ ...base, focusedChain: 'sol' }, 'sol', NOW));
  assert.ok(F.idleFor({ ...base, focusedChain: 'bsc' }, 'sol', NOW));
  assert.ok(!F.idleFor({ ...base, ticketAt: NOW - 5_000 }, 'sol', NOW));
  assert.ok(F.idleFor({ ...base, ticketAt: NOW - 5_000, hidden: true }, 'sol', NOW));
  assert.ok(!F.idleFor({ ...base, limitBusy: true }, 'sol', NOW));
});

test('token bucket: ≤ 1 request/s after the burst', () => {
  let t = 0; const b = F.bucket(1, 3, () => t);
  assert.deepEqual([b.take(), b.take(), b.take()], [0, 0, 0]);
  assert.equal(b.take(), 1000);
  t = 2000; assert.equal(b.take(), 0);
});

// a real Relay quote's origin transactions (2026-10-25, USDG on Robinhood → USDC on BNB, $100), re-addressed to a test reserve
const R = '0x7a3b9f1c2d4e5f60718293a4b5c6d7e8f9012345';
const relayTxs = (o = {}) => {
  const word = (h) => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const dep = o.depositor || R, token = o.token || '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amount = o.amount ?? 100_000_000n, spender = o.spender || '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  return [
    { to: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', data: '0x095ea7b3' + word(spender) + word((o.approve ?? amount).toString(16)), value: 0n },
    { to: o.to || '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0xe8017952' + word(dep) + word(token) + word(amount.toString(16)) + '4945845d828b7eb7584fb6a5f1607aa7e5be02757471905d6d2985d149cd51dd', value: o.value ?? 0n },
  ];
};
const quote = (o = {}) => ({ bridge: 'relay', route: 'robinhood>bsc', amountIn: 100_000_000n, out: 99_641_295_331_865_212_204n, minOut: 99_143_088_855_205_886_143n, fees6: D(0.36), etaMs: 4000, recipient: R, requestId: '0x1792', outDecimals: 18, txs: relayTxs(o.tx), ...o.q });
const want = { from: 'robinhood', to: 'bsc', signer: R, recipient: R, amountIn: 100_000_000n, stableIn: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', maxSlipBps: 50, feeRoom6: D(2) };

test('bridge deposit checks: a real Relay quote passes; every tampering is refused before anything is signed', () => {
  assert.equal(F.verifyBridgeQuote(quote(), want), null);
  const cases = [
    [{ tx: { depositor: '0x' + '99'.repeat(20) } }, /another depositor/],
    [{ tx: { amount: 200_000_000n, approve: 100_000_000n } }, /token or amount differs|exact amount/],
    [{ tx: { spender: '0x' + '66'.repeat(20) } }, /Approval to an unknown contract/],
    [{ tx: { approve: 2n ** 255n } }, /exact amount/],
    [{ tx: { to: '0x' + '55'.repeat(20) } }, /unknown contract/],
    [{ tx: { value: 1n } }, /Unexpected Relay call/],
    [{ q: { recipient: '0x' + '44'.repeat(20) } }, /someone else/],
    [{ q: { minOut: 90n * 10n ** 18n } }, /below the amount minus fees/],
    [{ q: { fees6: D(3) } }, /fee cap/],
    [{ q: { route: 'robinhood>sol' } }, /another route/],
    [{ q: { amountIn: 99_000_000n } }, /differs from the planned/],
  ];
  for (const [o, re] of cases) assert.match(F.verifyBridgeQuote(quote(o), want) || 'PASSED', re, JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  // a bridge that is not executable from the vault is refused at the transaction check
  assert.match(F.verifyBridgeTxs({ bridge: 'mayan', amountIn: 1n, txs: relayTxs() }, want) || '', /not allowed on this chain/);
});

test('bridge failover order and health: < 90 % success or p50 > 3× ETA demotes for 24 h; quote-only bridges stay last', () => {
  // motion's own solver is first on every route (docs/drafts/MOTION-BRIDGE.md); the public bridges keep their order
  assert.deepEqual(F.bridgeOrder('sol>bsc', {}, NOW, 'evm'), ['motion', 'relay', 'debridge', 'mayan']);
  assert.deepEqual(F.bridgeOrder('robinhood>sol', {}, NOW, 'evm'), ['motion', 'relay', 'debridge']);
  assert.deepEqual(F.bridgeOrder('sol>bsc', {}, NOW, 'sol'), ['motion', 'relay', 'mayan', 'debridge']);   // Solana origin: only motion's own transfer is signed
  const out = (ok, i, dur = 3000) => ({ bridge: 'relay', route: 'robinhood>sol', ok, sentAt: NOW - 100_000 + i * 1000, doneAt: NOW - 100_000 + i * 1000 + dur, etaMs: 4000 });
  const bad = F.bridgeHealth([out(true, 0), out(false, 1), out(false, 2), out(true, 3)], NOW);
  assert.ok(bad['relay:robinhood>sol'].demotedUntil > NOW);
  assert.deepEqual(F.bridgeOrder('robinhood>sol', bad, NOW, 'evm'), ['motion', 'debridge', 'relay']);
  assert.deepEqual(F.bridgeOrder('robinhood>sol', bad, NOW + 86_500_000, 'evm'), ['motion', 'relay', 'debridge']);
  // motion demoted too: the public bridges take over, and the float engine falls through to them
  const motionBad = F.bridgeHealth([0, 1, 2].map((i) => ({ bridge: 'motion', route: 'robinhood>sol', ok: false, sentAt: NOW - 10_000 + i * 100, doneAt: NOW - 9_000 + i * 100, etaMs: 1500 })), NOW);
  assert.deepEqual(F.bridgeOrder('robinhood>sol', motionBad, NOW, 'evm'), ['relay', 'debridge', 'motion']);
  const slow = F.bridgeHealth([0, 1, 2, 3].map((i) => out(true, i, 13_000)), NOW);
  assert.ok(slow['relay:robinhood>sol'].demotedUntil > NOW);
  const good = F.bridgeHealth(Array.from({ length: 20 }, (_, i) => out(i !== 5, i)), NOW);   // 95 %
  assert.equal(good['relay:robinhood>sol'].demotedUntil, 0);
});

const RH_IN = { at: NOW - 3_000, nativeUsd: 4000, evm: { baseFee: '20000000', gasPrice: '20000000', l1PerByte: '0' } };
const BSC_IN = { at: NOW - 3_000, nativeUsd: 600, evm: { baseFee: '0', gasPrice: '50000000', l1PerByte: '0' } };
const SOL_IN = { at: NOW - 3_000, nativeUsd: 100, sol: { tipP75: 0.00008, tipP95: 0.002, microMedium: 2000, microHigh: 60_000, microVeryHigh: 400_000 } };

test('network fee — Robinhood: gas × the BASE fee (Arbitrum pays the base, not the boosted price), + the L1 share when priced', () => {
  const f = F.netFeeOf('robinhood', 'pons', 'buy', RH_IN, { gasBoost: 1.5 }, NOW);
  assert.equal(f.native, 150_000n * 20_000_000n);   // 3e12 wei
  assert.equal(f.usd6, 12_000n);                     // $0.012
  assert.equal(F.fmtUsd6(f.usd6, { cost: true }), '$0.02');
  assert.equal(f.stale, false);
  const withL1 = F.netFeeOf('robinhood', 'pons', 'buy', { ...RH_IN, evm: { ...RH_IN.evm, l1PerByte: '1000000000' } }, {}, NOW);
  assert.equal(withL1.native, 150_000n * 20_000_000n + 440n * 1_000_000_000n);
  assert.deepEqual(withL1.parts.map((p) => p.label), ['gas', 'L1 data']);
  assert.equal(F.netFeeOf('robinhood', 'pons', 'buy', RH_IN, { gasBoost: 5 }, NOW).native, f.native);   // boost does not change what RH charges
});

test('network fee — BNB: the full signed price = max(base, gasPrice) × 1.25 × boost', () => {
  const f = F.netFeeOf('bsc', 'four', 'buy', BSC_IN, { gasBoost: 1.5 }, NOW);
  assert.equal(f.native, 190_000n * ((50_000_000n * 125n * 150n) / 10_000n));
  const eco = F.netFeeOf('bsc', 'four', 'buy', BSC_IN, { gasBoost: 1 }, NOW);
  assert.ok(eco.native < f.native);
  assert.equal(F.netFeeOf('bsc', 'v2', 'sell', BSC_IN, {}, NOW).native, 150_000n * ((50_000_000n * 125n * 150n) / 10_000n));   // default boost 1.5
});

test('network fee — Solana: 5 000 lamports + priority × units + the Jito tip, per mode; pinned values; the ~0.005 SOL ceiling', () => {
  const fast = F.netFeeOf('sol', 'pump', 'buy', SOL_IN, { gasBoost: 1.5 }, NOW);
  const units = BigInt(Math.ceil(90_000 * 1.25) + 5_000);
  assert.equal(fast.native, 5_000n + (60_000n * units + 999_999n) / 1_000_000n + 80_000n);
  assert.deepEqual(fast.parts.map((p) => p.label), ['base', 'priority', 'Jito tip']);
  const eco = F.netFeeOf('sol', 'pump', 'buy', SOL_IN, { gasBoost: 1 }, NOW);
  assert.equal(eco.native, 5_000n + (2_000n * units + 999_999n) / 1_000_000n);   // no tip
  const turbo = F.netFeeOf('sol', 'dlmm', 'buy', SOL_IN, { turbo: true, gasBoost: 2 }, NOW);
  assert.equal(turbo.native, 5_000n + (400_000n * 400_000n) / 1_000_000n + 2_000_000n);
  const pinned = F.netFeeOf('sol', 'pump', 'buy', SOL_IN, { solTip: 0.1, solPriority: 5_000_000, gasBoost: 1.5 }, NOW);
  assert.ok(pinned.native - 5_000n <= 5_000_000n + 1n, String(pinned.native));   // the engine's F-8 ceiling
});

test('network fee: stale inputs are flagged, dead ones give no figure (never a guess), extra top-up cost is added', () => {
  assert.equal(F.netFeeOf('robinhood', 'v4', 'buy', { ...RH_IN, at: NOW - 120_000 }, {}, NOW).stale, true);
  assert.equal(F.netFeeOf('robinhood', 'v4', 'buy', { ...RH_IN, at: NOW - 700_000 }, {}, NOW), null);
  assert.equal(F.netFeeOf('robinhood', 'v4', 'buy', null, {}, NOW), null);
  assert.equal(F.netFeeOf('sol', 'pump', 'buy', RH_IN, {}, NOW), null);   // EVM inputs on the Solana lane: no figure
  const base = F.netFeeOf('robinhood', 'v4', 'buy', RH_IN, {}, NOW);
  assert.equal(F.netFeeOf('robinhood', 'v4', 'buy', RH_IN, {}, NOW, D(0.05)).usd6, base.usd6 + D(0.05));
});

test('move fees for the planner and "Upkeep this week": gas + the 0.01 % pool fee; unknown gas counts a cent, never zero', () => {
  const f = F.moveFee6('robinhood', 'topup', RH_IN, NOW, D(100));
  assert.equal(f, F.nativeToUsd6Up(260_000n * 20_000_000n, 4000n * F.USD, 18) + D(0.01));
  assert.equal(F.moveFee6('bsc', 'gas', BSC_IN, NOW), F.nativeToUsd6Up(21_000n * 62_500_000n, 600n * F.USD, 18));
  assert.equal(F.moveFee6('sol', 'topup', null, NOW, D(100)), D(0.1) + D(0.01));
});

test('reserve without gas and W at its floor (owner 2026-10-27): a waiting click takes the cold top-up from another reserve; the conversion keeps R its gas', () => {
  const C = F.FLOAT_CFG.bsc;
  const chains = {
    robinhood: chainState({ float: eth(0.02), reserve: 1_500_000_000n, reserveNative: 10n ** 15n }),
    bsc: chainState({ price6: BNB, float: 200_000_000_000_000n, reserve: 112n * 10n ** 18n, reserveNative: 0n, active: false }),
  };
  // no click: nothing can move on BNB (no gas for R, W at its floor) — said, not attempted
  const idle = F.planMoves(planIn({ chains }));
  assert.ok(idle.skips.some((s) => s.chain === 'bsc' && s.why === 'no-gas'));
  // a $5 click on BNB: BNB's reserve is set aside, the cold top-up comes from Robinhood's reserve
  const u = F.planMoves(planIn({ chains, urgent: { chain: 'bsc', usd6: D(5) } }));
  const c = u.moves.find((m) => m.chain === 'bsc' && m.kind === 'cold');
  assert.ok(c, u.moves.map((m) => m.kind + ':' + m.chain).join(',') + ' / ' + u.skips.map((s) => s.chain + ':' + s.why).join(',')); assert.equal(c.from, 'robinhood');
  // a click while W still has half its floor spare: R gets its gas from W first
  const w = F.planMoves(planIn({ chains: { ...chains, bsc: chainState({ price6: BNB, float: C.gasFloor + C.reserveGas, reserve: 112n * 10n ** 18n, reserveNative: 0n, active: false }) }, urgent: { chain: 'bsc', usd6: D(5) } }));
  assert.ok(w.moves.some((m) => m.chain === 'bsc' && m.kind === 'gas'));
  // the switch-on conversion keeps R's gas in W when R has none
  const keep = F.keepOf('bsc', { price6: BNB, presets6: [], buys6: [], active: false, reserveNative: 0n }, F.DEFAULT_CAPS);
  assert.equal(keep, C.gasFloor + C.reserveGas);
});

test('the owner\'s state (0.000989 BNB in W, R without gas): a waiting click first moves R its gas from W, keeping a quarter of the floor', () => {
  const C = F.FLOAT_CFG.bsc;
  const chains = { bsc: chainState({ price6: BNB, float: 989_000_000_000_000n, reserve: 112n * 10n ** 18n, reserveNative: 0n, active: false }) };
  const u = F.planMoves(planIn({ chains, urgent: { chain: 'bsc', usd6: D(5) } }));
  const g = u.moves.find((m) => m.chain === 'bsc' && m.kind === 'gas');
  assert.ok(g, u.moves.map((m) => m.kind).join(','));
  assert.ok(989_000_000_000_000n - C.reserveGas >= C.gasFloor / 4n, 'W keeps at least a quarter of its floor');
});

test('a $5 click that needs $4.99 after rounding tops up at least the same-chain minimum, with a 15 % margin (owner 2026-10-27)', () => {
  const chains = { bsc: chainState({ price6: BNB, float: F.FLOAT_CFG.bsc.gasFloor, reserve: 112n * 10n ** 18n, reserveNative: 10n ** 18n, active: false }) };
  const u = F.planMoves(planIn({ chains, urgent: { chain: 'bsc', usd6: D(4.99) } }));
  const t = u.moves.find((m) => m.chain === 'bsc' && m.kind === 'topup');
  assert.ok(t, u.skips.map((s) => s.why).join(','));
  assert.ok(t.usd6 >= D(5), String(t.usd6));
  const big = F.planMoves(planIn({ chains, urgent: { chain: 'bsc', usd6: D(40) } })).moves.find((m) => m.kind === 'topup');
  assert.ok(big.usd6 >= D(46), 'need + 15 %');
});

test('plan: a Solana reserve that holds what its own moves cost (motion\'s gas drop) pays them itself when W cannot spare its gas; under that line, as before', () => {
  const SOL = 100n * F.USD;
  const sol = (over) => ({ sol: chainState({ price6: SOL, float: 0n, reserve: 300_000_000n, ...over }) });
  const click = { chain: 'sol', usd6: D(40) };
  // after a drop (3 000 000 lamports), W with no SOL: R swaps for the click, no 'no-gas'
  const after = F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.drop }), urgent: click }));
  assert.ok(after.moves.some((m) => m.kind === 'topup' && m.chain === 'sol'), JSON.stringify(after, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.ok(!after.skips.some((s) => s.why === 'no-gas'));
  // and in the background too (W's float under target)
  assert.ok(F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.enough }) })).moves.some((m) => m.kind === 'topup'));
  // under the line (the old ~0.0009 SOL reserve): no-gas, R is set aside — exactly the old answer
  for (const urgent of [click, undefined]) {
    const before = F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.enough - 1n }), ...(urgent ? { urgent } : {}) }));
    assert.ok(before.skips.some((s) => s.chain === 'sol' && s.why === 'no-gas'));
    assert.ok(!before.moves.some((m) => m.kind === 'topup'));
  }
  // W able to spare R's gas: the old W → R refill (while idle), not R paying from its drop
  const wRich = F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.drop, float: 200_000_000n, idle: true }) }));
  assert.equal(wRich.moves[0].kind, 'gas');
  const wRichBusy = F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.drop, float: 200_000_000n, idle: false }) }));
  assert.ok(wRichBusy.skips.some((s) => s.why === 'no-gas'), 'W could refill R later: the old wait');
  // EVM chains are untouched by the Solana line
  const evm = F.planMoves(planIn({ chains: { robinhood: chainState({ float: eth(0), reserve: 500_000_000n, reserveNative: F.SOL_GAS.drop, idle: false }) } }));
  assert.ok(evm.skips.some((s) => s.why === 'no-gas'));
});

test('plan: a click on Solana whose reserve can pay its own top-up (≥ SOL_GAS.enough) does not wait for a W → R gas send first (2026-10-28: "SOL ready" ~12 s after the tap)', () => {
  const SOL = 100n * F.USD;
  const sol = (over) => ({ sol: chainState({ price6: SOL, float: 50_000_000n, reserve: 300_000_000n, ...over }) });
  const click = { chain: 'sol', usd6: D(15) };
  const kinds = (p) => p.moves.map((m) => m.kind + ':' + m.chain);
  // R at the drop (0.003 SOL, under half its 0.01 gas), W with 0.05 SOL to spare: the click's top-up alone, R pays its fee
  for (const reserveNative of [F.SOL_GAS.drop, F.SOL_GAS.enough, F.FLOAT_CFG.sol.reserveGas / 2n - 1n]) {
    const p = F.planMoves(planIn({ chains: sol({ reserveNative }), urgent: click }));
    assert.deepEqual(kinds(p), ['topup:sol'], String(reserveNative));
    assert.ok(!p.skips.some((s) => s.why === 'no-gas'));
  }
  // under the line R cannot pay its swap: W gives R its gas first, as before (it lands, then R tops W up)
  const low = F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.enough - 1n }), urgent: click }));
  assert.deepEqual(kinds(low), ['gas:sol', 'topup:sol']);
  // no click: the idle refill W → R stands (the background keeps R's gas up), and a busy W still waits
  assert.equal(F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.drop, float: 200_000_000n, idle: true }) })).moves[0].kind, 'gas');
  assert.ok(F.planMoves(planIn({ chains: sol({ reserveNative: F.SOL_GAS.drop, float: 200_000_000n, idle: false }) })).skips.some((s) => s.why === 'no-gas'));
  // EVM: a click whose reserve is under half its gas still gets it from W first (R needs it for approve + swap)
  const C = F.FLOAT_CFG.bsc; const BNB6 = 700n * F.USD;
  const evm = F.planMoves(planIn({ chains: { bsc: chainState({ price6: BNB6, float: C.gasFloor + C.reserveGas, reserve: 112n * 10n ** 18n, reserveNative: C.reserveGas / 2n - 1n, active: false }) }, urgent: { chain: 'bsc', usd6: D(5) } }));
  assert.equal(evm.moves[0].kind, 'gas');
});
