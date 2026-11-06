// F2b (release #3 gate, 2026-11-04): engine-fix F2 keeps a dust reserve out of TC-1's reach and loss — and so, before F2b, out of
// the guard that decides whether TC-1 refuses at all. A click whose ONLY reserve is dust then took the old path and bridged the
// dust for a buy that cannot be paid (usd-scenarios S08: $0.40 moved, not sent). With F2b it is refused, nothing planned.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';
const CFG = F.FLOAT_CFG; const NOW0 = Date.now();
const ETH6 = 2_266_050_000n, BNB6x = 600_000_000n, SOL6 = 160_000_000n;
const cs = (o) => ({ price6: 0n, priceAt: NOW0, float: 0n, reserve: 0n, reserveNative: 0n, active: true, presets6: [F.usd6(50)], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: false, busyBridge: false, ...o });
const fee = (kind) => (kind === 'cold' || kind === 'rebalance' ? F.usd6(0.42) : F.usd6(0.02));
const world = (bscUsd) => ({
  robinhood: cs({ price6: ETH6, float: CFG.robinhood.gasFloor, reserve: 0n, reserveNative: CFG.robinhood.reserveGas }),
  bsc: cs({ price6: BNB6x, reserve: F.usd6(bscUsd) * 10n ** 12n, reserveNative: CFG.bsc.reserveGas, float: CFG.bsc.gasFloor }),
  sol: cs({ price6: SOL6 }),
});
const plan = (chains, usd, atomic) => F.planMoves({ now: NOW0, caps: F.plannedCaps(F.DEFAULT_CAPS), chains, enabled: ['robinhood', 'bsc', 'sol'], walletUsd6: F.usd6(10), movedToday6: 0n, feesToday6: 0n, estFee6: fee,
  urgent: { chain: 'robinhood', usd6: F.usd6(usd) }, urgentFrom: ['bsc'], ...(atomic ? { urgentAtomic: true, urgentSign: ['bsc'] } : {}) });
const clickMoves = (p) => p.moves.filter((m) => m.chain === 'robinhood' || m.reason === 'click');

test('F2b: the only reserve is dust ($0.40 BNB, under its own move fee) → a $1 click is refused, nothing is planned for it', () => {
  const old = plan(world(0.4), 1, false);
  assert.ok(clickMoves(old).length > 0, 'without TC-1 the dust is moved (the case being fixed)');
  const p = plan(world(0.4), 1, true);
  assert.equal(p.short?.infeasible, true, JSON.stringify(p.short, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(clickMoves(p).length, 0, 'no move for the click');
  assert.equal(p.short.can6, 0n, 'nothing can pay');
});

test('F2b: a reserve above its fee is still counted (a payable click stays payable; F2 unchanged)', () => {
  const p = plan(world(50), 10, true);
  assert.equal(p.short?.infeasible, undefined);
  assert.ok(clickMoves(p).length > 0);
});
