// 2026-11-01, the click a tester could not make: "Buy $1 × 2 wallets" on Solana with $0 SOL and $4.90 of USD balance on
// Robinhood / BNB (local usd-xchain-click/plan-repro.mjs). The reserves' click top-up (floatCore planMoves) left out W's own
// gas floor: tradingUsd6 counts only what sits above the floor, so a click on a chain where W holds nothing got exactly its
// need + 25 % and W's ready stayed ~0.02 SOL short of the click — hold & fire waited its whole 15 s, then "buying anyway".
// Pure: planMoves with the live chain configuration, prices as on the day.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';

const NOW = Date.now();
const SOL6 = 95_330_000n, ETH6 = 3_900_000_000n, BNB6 = 1_100_000_000n;
const C = F.FLOAT_CFG;
const cs = (o) => ({ price6: 0n, priceAt: NOW, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(10), F.usd6(25), F.usd6(50), F.usd6(100)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const plan = (chains, usd, from = ['robinhood', 'bsc']) => F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(5), movedToday6: 0n, feesToday6: 0n, estFee6: () => 0n, urgent: { chain: 'sol', usd6: F.usd6(usd) }, urgentFrom: from });
// what a click may spend of W once every move of the plan to Solana has landed (clickUsd6: above the click's 0.009 SOL floor;
// the app's readiness for Solana reads the same, domain/usdBalance.ts clickReadyUsd)
const readyAfter = (p, solFloat = 0n) => {
  const cold = p.moves.filter((m) => m.chain === 'sol').reduce((t, m) => t + m.usd6, 0n);
  return F.clickUsd6('sol', F.usd6ToNative(cold, SOL6, 9) + solFloat, SOL6);
};
const cashRh = (usd) => cs({ price6: ETH6, reserve: F.usd6(usd), reserveNative: C.robinhood.reserveGas, float: C.robinhood.gasFloor });
const cashBnb = (usd) => cs({ price6: BNB6, reserve: F.usd6(usd) * 10n ** 12n, reserveNative: C.bsc.reserveGas, float: C.bsc.gasFloor });
// the click's Solana floor (0.009 SOL: this buy and a later sell, floatCore SOL_CLICK_FLOOR), not the 0.02 background floor
const floorUsd = F.nativeToUsd6Up(F.SOL_CLICK_FLOOR, SOL6, 9);

test('the tester\'s click: $1 × 2 wallets, each wallet $1.25 USDG on Robinhood + $1.20 USDC on BNB, no SOL → each wallet\'s own plan moves both reserves and lands ready for its $1 (before: short by the 0.02 SOL floor, a 15 s wait)', () => {
  // the app holds each selected wallet for its own share and asks the vault for each (floatVault ClickSizing): $1 a wallet
  const p = plan({ robinhood: cashRh(1.25), bsc: cashBnb(1.2), sol: cs({ price6: SOL6 }) }, 1);
  const colds = p.moves.filter((m) => m.kind === 'cold' && m.chain === 'sol');
  assert.deepEqual(colds.map((m) => m.from).sort(), ['bsc', 'robinhood']);
  assert.equal(colds.reduce((t, m) => t + m.usd6, 0n), F.usd6(1.25) + floorUsd, 'the $1 + 25 % and the click floor');
  assert.equal(p.short, undefined);
  assert.ok(readyAfter(p) >= F.usd6(1), 'W lands ready for its $1: ' + F.fmtUsd6(readyAfter(p)));
  // with the 0.02 background floor the same wallet could not: $1.25 + $1.91 > $2.45
  assert.ok(F.usd6(1.25) + F.nativeToUsd6Up(C.sol.gasFloor, SOL6, 9) > F.usd6(2.45));
  // a $2 click from ONE such wallet is short, and says by how much
  const two = plan({ robinhood: cashRh(1.25), bsc: cashBnb(1.2), sol: cs({ price6: SOL6 }) }, 2);
  assert.equal(two.short.usd6, F.usd6(2.5) + floorUsd - F.usd6(2.45));
});

test('one wallet, $10 of USDG on Robinhood, no SOL: a $2 click moves the need + 25 % + the gas floor and fires on landing', () => {
  const p = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6, float: C.bsc.gasFloor }), sol: cs({ price6: SOL6 }) }, 2);
  const cold = p.moves.find((m) => m.kind === 'cold' && m.chain === 'sol');
  assert.equal(cold.from, 'robinhood');
  assert.equal(cold.usd6, F.usd6(2.5) + floorUsd);
  assert.ok(readyAfter(p) >= F.usd6(2), 'W ready after landing covers the click: ' + F.fmtUsd6(readyAfter(p)));
  assert.equal(p.short, undefined);
  // the $1 share of a two-wallet click: the same rule for each wallet's own plan
  const one = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6, float: C.bsc.gasFloor }), sol: cs({ price6: SOL6 }) }, 1);
  assert.equal(one.moves.find((m) => m.kind === 'cold').usd6, F.usd6(1.25) + floorUsd);
  assert.ok(readyAfter(one) >= F.usd6(1));
});

test('W below the click floor (0.0045 SOL): only the missing part of the floor is added; W at or above it: just the need + 25 % (counted above the click floor)', () => {
  const half = F.SOL_CLICK_FLOOR / 2n;
  const p = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, float: half }) }, 2);
  assert.equal(p.moves.find((m) => m.kind === 'cold').usd6, F.usd6(2.5) + F.nativeToUsd6Up(F.SOL_CLICK_FLOOR - half, SOL6, 9));
  assert.ok(readyAfter(p, half) >= F.usd6(2));
  const at = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, float: F.SOL_CLICK_FLOOR }) }, 2);
  assert.equal(at.moves.find((m) => m.kind === 'cold').usd6, F.usd6(2.5));
  // W at the 0.02 background floor: what sits above the click floor ($1.05) already counts
  const bg = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, float: C.sol.gasFloor }) }, 2);
  assert.equal(bg.moves.find((m) => m.kind === 'cold').usd6, F.usd6(2.5) - F.clickUsd6('sol', C.sol.gasFloor, SOL6));
  // W already holds $1 above the click floor: the rest of the need + 25 %, no floor
  const some = F.SOL_CLICK_FLOOR + F.usd6ToNative(F.usd6(1), SOL6, 9);
  const s = plan({ robinhood: cashRh(10), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, float: some }) }, 2);
  const u = s.moves.find((m) => m.kind === 'cold').usd6;
  assert.ok(u >= F.usd6(1.5) - 1n && u <= F.usd6(1.5) + 1n, String(u));
});

test('the Solana reserve itself holds the dollars (same chain): its swap also carries the floor', () => {
  const p = plan({ robinhood: cs({ price6: ETH6, float: C.robinhood.gasFloor }), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, reserve: F.usd6(20), reserveNative: C.sol.reserveGas }) }, 2);
  const top = p.moves.find((m) => m.kind === 'topup' && m.chain === 'sol');
  assert.equal(top.usd6, F.usd6(2.5) + floorUsd);
});

test('a background tick (no click) is untouched by the floor rule', () => {
  const chains = { robinhood: cashRh(500), bsc: cs({ price6: BNB6 }), sol: cs({ price6: SOL6, reserve: F.usd6(300), reserveNative: C.sol.reserveGas }) };
  const p = F.planMoves({ now: NOW, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(800), movedToday6: 0n, feesToday6: 0n, estFee6: () => 0n });
  const top = p.moves.find((m) => m.kind === 'topup' && m.chain === 'sol');
  // the ready target ($100 preset × 1.5 = $150) from the chain's own reserve, no floor on top (the background top-up's rule)
  assert.equal(top.usd6, F.targetOf('sol', F.usd6(100), true, F.DEFAULT_CAPS.perChain6).trading6);
});

// The click's Solana floor against the vault's OWN trade checks (src/solEngine.ts, read here, not copied): a wallet topped up to
// the floor + the buy passes the buy's check, and what is left after the buy passes the later full sell's check.
test('click floor: a wallet topped up to 0.009 SOL + the buy can buy, and can still sell all of it afterwards (solEngine\'s own rent and fee constants)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/solEngine.ts', import.meta.url), 'utf8');
  const num = (re) => { const m = src.match(re); assert.ok(m, 'solEngine constant moved: ' + re); return BigInt(m[1].replace(/_/g, '')); };
  const RENT_ATA = num(/RENT_ATA = ([\d_]+)n/), RENT_ATA22 = num(/RENT_ATA22 = ([\d_]+)n/), RENT_WALLET = num(/RENT_WALLET = ([\d_]+)n/), SIG_FEE = num(/SIG_FEE = ([\d_]+)n/);
  const RENT_UVA = num(/const RENT_UVA = ([\d_]+)n/);
  // the default plan ("fast": gas boost 1.5) caps its tip at 0.001 SOL; the F-8 ceiling bounds tip + priority at 0.005 SOL
  assert.match(src, /mode === 'fast' \? Math\.min\(0\.001,/);
  const fee = 1_000_000n + 100_000n + SIG_FEE + 10_000n;   // tip cap + priority allowance + signature + feesAt's headroom
  // the worst venue for the floor: PumpSwap (a new token-2022 coin account, the volume account, the temporary wSOL account)
  const buyRent = RENT_ATA22 + RENT_UVA + RENT_ATA;
  assert.ok(F.SOL_CLICK_FLOOR >= RENT_WALLET + buyRent + 2n * fee, 'floor covers buy + sell: ' + (RENT_WALLET + buyRent + 2n * fee));
  for (const amount of [10_000_000n, 1_000_000_000n]) {   // a $1 and a $100 buy at $100
    let w = F.SOL_CLICK_FLOOR + amount;
    // tradeOne's buy check: amount + RENT_WALLET + fees + rent
    assert.ok(w >= amount + RENT_WALLET + fee + buyRent, 'the buy passes');
    w -= amount + fee + RENT_ATA22 + RENT_UVA;   // the temporary wSOL rent comes back in the same transaction
    // the sell's check: fees + the temporary wSOL account again (the coin and volume accounts exist now); W stays rent-exempt
    assert.ok(w >= fee + RENT_ATA + RENT_WALLET, 'the sell passes: ' + w);
  }
  // the background floor is unchanged
  assert.equal(F.FLOAT_CFG.sol.gasFloor, 20_000_000n);
  assert.equal(F.clickFloorOf('robinhood'), F.FLOAT_CFG.robinhood.gasFloor);
});
