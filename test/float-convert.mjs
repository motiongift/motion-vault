// USD balance — switch on = convert now, switch off = convert back, later deposits convert themselves (owner, 2026-10-26).
// The pure parts (src/floatCore.ts): the conversion plan (what it keeps, skips and how it sizes), the dialog texts, the
// quiet rule that replaced the idle rule for W's sends, sweeps outside the day's cap, and the ledger's exemptions. The vault
// side end to end (configure / tick / off on a mocked chain) is in test/float-engine.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';

const D = (n) => F.usd6(n);
const NOW = 1_792_950_000_000;
const RH = F.FLOAT_CFG.robinhood, BSC = F.FLOAT_CFG.bsc, SOLC = F.FLOAT_CFG.sol;
const E18 = 10n ** 18n;
const st = (over = {}) => ({ price6: 4000n * F.USD, priceAt: NOW - 5_000, float: 0n, reserve: 0n, reserveNative: E18, active: false, presets6: [], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: true, busyBridge: false, ...over });

// the owner's example: 0.50 ETH ≈ $1,167 on Robinhood, 1.56 BNB ≈ $1,158 on BNB; Solana has only $4 above what stays
const example = () => ({
  robinhood: st({ price6: D(2334), float: RH.gasFloor + E18 / 2n }),
  bsc: st({ price6: D(742.31), float: BSC.gasFloor + 1_560_000_000_000_000_000n }),
  sol: st({ price6: D(100), active: true, presets6: [D(50)], float: SOLC.gasFloor + 750_000_000n + 40_000_000n }),
});

test('convert plan: everything above the trading target + the gas floor, per chain, sized at the fresh price', () => {
  const p = F.planConvert(example(), ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, NOW);
  assert.deepEqual(p.lines.map((l) => l.chain), ['robinhood', 'bsc']);
  const [rh, bnb] = p.lines;
  assert.equal(rh.nativeIn, E18 / 2n); assert.equal(rh.usd6, D(1167)); assert.equal(rh.keep, RH.gasFloor, 'an inactive chain keeps the gas floor only');
  assert.equal(bnb.nativeIn, 1_560_000_000_000_000_000n); assert.equal(bnb.usd6, 1_158_003_600n); assert.equal(bnb.keep, BSC.gasFloor);
  assert.deepEqual(p.skips, [{ chain: 'sol', why: 'below-min' }], 'Solana: $4 above what stays < the $5 same-chain minimum');
});

test('convert plan: an active chain keeps its trading target (1.5 × the largest preset, rounded UP in native) so trades stay instant', () => {
  const x = st({ active: true, presets6: [D(50)], float: RH.gasFloor + E18 / 2n });
  const keep = F.keepOf('robinhood', x, F.DEFAULT_CAPS);
  assert.equal(keep, RH.gasFloor + 18_750_000_000_000_000n);                   // $75 at $4,000 = 0.01875 ETH
  const p = F.planConvert({ robinhood: x }, ['robinhood'], F.DEFAULT_CAPS, NOW);
  assert.equal(p.lines[0].nativeIn, x.float - keep);
  assert.equal(p.lines[0].usd6, D(1925));
  // the per-chain cap bounds the target: a $1,000 preset keeps $250 ready, not $1,500
  const big = st({ active: true, presets6: [D(1000)], float: RH.gasFloor + E18 / 2n });
  assert.equal(F.keepOf('robinhood', big, F.DEFAULT_CAPS), RH.gasFloor + F.usd6ToNative(D(250), 4000n * F.USD, 18));
  // a price that does not divide evenly: what stays is never below the target
  const odd = st({ active: true, presets6: [D(50)], price6: 3_333_333_333n });
  const k2 = F.keepOf('robinhood', odd, F.DEFAULT_CAPS) - RH.gasFloor;
  assert.ok(F.nativeToUsd6(k2, odd.price6, 18) >= D(75), 'rounded up');
});

test('convert plan: no fresh price (older than 60 s, or none) = skipped; nothing above the floor = skipped; a chain not enabled is not planned', () => {
  const p = F.planConvert({ robinhood: st({ float: RH.gasFloor + E18, priceAt: NOW - 61_000 }), bsc: st({ price6: D(600), float: BSC.gasFloor }) }, ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, NOW);
  assert.deepEqual(p.lines, []);
  assert.deepEqual(p.skips, [{ chain: 'robinhood', why: 'stale-price' }, { chain: 'bsc', why: 'below-min' }, { chain: 'sol', why: 'stale-price' }]);
  assert.deepEqual(F.planConvert(example(), ['robinhood'], F.DEFAULT_CAPS, NOW).lines.map((l) => l.chain), ['robinhood']);
  // under the float, nothing at all
  assert.deepEqual(F.planConvert({ robinhood: st({ float: RH.gasFloor - 1n }) }, ['robinhood'], F.DEFAULT_CAPS, NOW).skips, [{ chain: 'robinhood', why: 'below-min' }]);
});

test('the switch-on dialog states the amounts per chain, what is skipped and why, and that later deposits convert too', () => {
  const p = F.planConvert(example(), ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, NOW);
  assert.deepEqual(F.convertText(p, ['robinhood', 'bsc', 'sol']), [
    'Convert now: 0.50 ETH ≈ $1,167 → USDG on Robinhood; 1.56 BNB ≈ $1,158 → USDC on BNB.',
    'Not converted now: Solana (less than $5.00 above what stays ready).',
    'A little ETH / BNB / SOL stays ready on each chain for gas and quick trades. ETH / BNB / SOL you deposit later converts the same way.',
  ]);
  const stale = F.planConvert({ robinhood: st({ float: RH.gasFloor + E18 / 4n }) }, ['robinhood', 'sol'], F.DEFAULT_CAPS, NOW);
  assert.deepEqual(F.convertText(stale, ['robinhood', 'sol']).slice(0, 2), ['Convert now: 0.25 ETH ≈ $1,000 → USDG on Robinhood.', 'Not converted now: Solana (no fresh price).']);
  assert.equal(F.convertText({ lines: [], skips: [] }, ['bsc'])[0], 'Nothing to convert now.');
  assert.equal(F.fmtNative(1_564_299_999_999_999_999n, 18, 'BNB'), '1.5642 BNB', 'rounded down, at most 4 decimals');
  assert.equal(F.fmtNative(5_000_000_000n, 9, 'SOL'), '5.00 SOL');
  assert.equal(F.fmtNative(1_234_567_000_000_000_000_000n, 18, 'ETH'), '1,234.567 ETH');
  assert.equal(F.fmtUsdApprox(D(99.5)), '$99.50'); assert.equal(F.fmtUsdApprox(D(1157.9036)), '$1,158');
});

test('convert back: every reserve stable ≥ $1 returns to the native, smaller ones stay (and say so); the dialog states the total', () => {
  const p = F.planConvertBack({ robinhood: { reserve: 1_167_000_000n }, bsc: { reserve: 1_158n * E18 }, sol: { reserve: 400_000n } });
  assert.deepEqual(p.lines.map((l) => [l.chain, l.stableIn, l.usd6]), [['robinhood', 1_167_000_000n, D(1167)], ['bsc', 1_158n * E18, D(1158)]]);
  assert.deepEqual(p.skips, [{ chain: 'sol', usd6: D(0.4), why: 'below-min' }]);
  assert.deepEqual(F.offText(p, 50), [
    'Turn off USD balance: convert $2,325.00 back to ETH / BNB.',
    '- Robinhood: $1,167.00 USDG → ETH;',
    '- BNB: $1,158.00 USDC → BNB;',
    'Stays as USD: $0.40 USDC on Solana (too small to convert).',
    'Each swap is checked against the on-chain price (slippage at most 0.50 %). The reserve keeps a little of its own gas.',
  ]);
  assert.match(F.offText({ lines: [{ chain: 'sol', stableIn: 300_000_000n, usd6: D(300) }], skips: [] }, 50, ['bsc']).join('\n'), /convert \$300\.00 back to SOL\.[\s\S]*Not read yet: BNB\./);
  assert.deepEqual(F.planConvertBack({ robinhood: { reserve: 0n } }), { lines: [], skips: [] }, 'an empty reserve is not mentioned');
});

test("quiet rule for W's sends (kept at 60 s on 2026-10-26): no click window, no trade / ticket touch for 60 s, no limit placing", () => {
  const base = { clickAt: 0, clickDoneAt: 0, focusAt: 0, lastTradeAt: NOW - 61_000, hidden: false, ticketAt: NOW - 61_000, limitBusy: false };
  assert.ok(F.quietFor(base, NOW), 'a trade 61 s ago and an untouched ticket: a sweep may go');
  assert.ok(!F.quietFor({ ...base, lastTradeAt: NOW - 30_000 }, NOW), 'a trade 30 s ago still blocks it');
  assert.ok(!F.quietFor({ ...base, clickAt: NOW, clickDoneAt: NOW - 5_000 }, NOW + 100), 'a trade between its call and its broadcast');
  assert.ok(!F.quietFor({ ...base, clickAt: NOW - 3_000, clickDoneAt: NOW - 1_000, lastTradeAt: NOW - 3_000 }, NOW), 'the 2 s tail');
  assert.ok(!F.quietFor({ ...base, focusAt: NOW - 5_000 }, NOW), 'a token page focused 5 s ago');
  assert.ok(!F.quietFor({ ...base, ticketAt: NOW - 30_000 }, NOW), 'the ticket touched 30 s ago');
  assert.ok(F.quietFor({ ...base, ticketAt: NOW - 5_000, hidden: true }, NOW), 'hidden page: the ticket does not count');
  assert.ok(!F.quietFor({ ...base, limitBusy: true }, NOW), 'a limit placement uses W too');
});

test('a later deposit converts itself: the sweep is not trimmed by the day\'s cap and does not use it up; top-ups still are', () => {
  const ETH = 4000n * F.USD;
  const eth = (usd) => RH.gasFloor + F.usd6ToNative(D(usd), ETH, 18);
  const planIn = (over) => ({ now: NOW, caps: { ...F.DEFAULT_CAPS, perDay6: D(1000) }, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: D(10_000), movedToday6: D(990), feesToday6: 0n, estFee6: () => D(0.02), chains: {}, ...over });
  // $3,000 of ETH arrives on an inactive chain: the whole of it is swept, with $10 of the day's cap left
  const p = F.planMoves(planIn({ chains: { robinhood: st({ price6: ETH, float: eth(3000) }) } }));
  assert.equal(p.moves.length, 1); assert.equal(p.moves[0].kind, 'sweep'); assert.equal(p.moves[0].trimmed, undefined);
  assert.ok(p.moves[0].usd6 >= D(2999.99), String(p.moves[0].usd6));
  // the same plan still tops up another chain within the day's room (the sweep did not use it up); the total cap is raised
  // here because the $3,000 not yet swept still counts as ready (the existing total-cap rule, unchanged)
  const both = F.planMoves(planIn({ movedToday6: D(960), walletUsd6: D(20_000), caps: { ...F.DEFAULT_CAPS, perDay6: D(1000), total6: D(5000) }, chains: { robinhood: st({ price6: ETH, float: eth(3000) }), bsc: st({ price6: D(600), active: true, presets6: [D(50)], float: BSC.gasFloor, reserve: 500n * E18 }) } }));
  const top = both.moves.find((m) => m.kind === 'topup');
  assert.equal(top.chain, 'bsc'); assert.equal(top.usd6, D(40)); assert.equal(top.trimmed, true, 'the top-up is still trimmed to the $40 left');
  // but never while something lands on the chain, and never while W may not send
  assert.equal(F.planMoves(planIn({ chains: { robinhood: st({ price6: ETH, float: eth(3000), inFlight6: D(1) }) } })).moves.length, 0);
  assert.equal(F.planMoves(planIn({ chains: { robinhood: st({ price6: ETH, float: eth(3000), idle: false }) } })).moves.length, 0);
  // the fee cap still binds sweeps
  assert.deepEqual(F.planMoves(planIn({ feesToday6: D(1.99), chains: { robinhood: st({ price6: ETH, float: eth(3000) }) } })).skips, [{ chain: 'robinhood', why: 'cap-fees' }]);
});

test('ledger: sweeps are not counted against the day\'s cap; confirmed conversions count against neither cap; every fee is upkeep', () => {
  const j = (kind, over = {}) => ({ id: kind, walletId: 'w', kind, chain: 'robinhood', usd6: String(D(1000)), fee6: String(D(0.05)), state: 'sent', at: NOW - 1_000, updatedAt: NOW, hashes: [], reason: 't', ...over });
  const led = F.ledgerOf([j('topup'), j('sweep'), j('sweep', { confirmed: 'on' }), j('topup', { confirmed: 'off' })], NOW);
  assert.equal(led.movedToday6, D(1000), 'only the top-up');
  assert.equal(led.feesToday6, D(0.10), 'the top-up and the plain sweep');
  assert.equal(led.upkeepWeek6, D(0.20), 'all four');
});
