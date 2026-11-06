// REVIEW (usd-buy-final) TC-1 loss bound counts EVERY signable donor's cold fee estimate ($0.40 placeholder + gas), even a donor
// whose dollars are dust. A $0.15 Solana reserve turns a $300 Robinhood click that the old plan pays into "infeasible".
//   node --test rv/review-tc1-dust.mjs   (from the engine tree)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
const CFG = F.FLOAT_CFG; const NOW0 = Date.now();
const ETH6 = 2_266_050_000n, BNB6x = 600_000_000n, SOL6 = 160_000_000n;
const cs = (o) => ({ price6: 0n, priceAt: NOW0, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const wEth = (usd) => (F.usd6(usd) * 10n ** 18n) / ETH6;
const fee = (kind) => (kind === 'cold' || kind === 'rebalance' ? F.usd6(0.42) : F.usd6(0.02));
const world = (solUsd) => ({
  robinhood: cs({ price6: ETH6, float: wEth(250.4) + CFG.robinhood.gasFloor + 1n, reserve: 0n, reserveNative: CFG.robinhood.reserveGas }),
  bsc: cs({ price6: BNB6x, reserve: F.usd6(50.37) * 10n ** 12n, reserveNative: CFG.bsc.reserveGas, float: CFG.bsc.gasFloor }),
  sol: cs({ price6: SOL6, reserve: F.usd6(solUsd), reserveNative: 10_000_000n }),
});
const plan = (chains, atomic) => F.planMoves({ now: NOW0, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(400), movedToday6: 0n, feesToday6: 0n, estFee6: fee,
  urgent: { chain: 'robinhood', usd6: F.usd6(300) }, urgentFrom: ['bsc'], urgentLater: ['sol'], ...(atomic ? { urgentAtomic: true, urgentSign: ['bsc', 'sol'] } : {}) });
test('REVIEW: no Solana dust — the $300 click is feasible (planned as before)', () => {
  const p = plan(world(0), true);
  assert.equal(p.short?.infeasible, undefined, JSON.stringify(p.short, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
});
test('REVIEW: + $0.15 in the Solana reserve — the fixed TC-1 keeps the click payable (the old plan lands W above the buy)', () => {
  const old = plan(world(0.15), false);
  const landed = old.moves.filter((m) => m.chain === 'robinhood' && (m.kind === 'cold' || m.kind === 'topup')).reduce((t, m) => t + m.usd6, 0n);
  const now6 = F.clickUsd6('robinhood', world(0.15).robinhood.float, ETH6);
  assert.ok(now6 + landed > F.usd6(300), 'old path: W reaches ' + F.fmtUsd6(now6 + landed));
  const p = plan(world(0.15), true);
  assert.equal(p.short?.infeasible, undefined, 'a reserve under its own move fee is not counted (neither reach nor loss)');
});
