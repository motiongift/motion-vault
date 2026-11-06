// SECURITY BATCH 2 — PERP-1 (Medium, bounded by the perps caps $1k / 20x / $5k per hour per wallet): a market order and a close
// were capped off Lighter's BOOK top (ref ± slippage) and never compared with the mark. A compromised page sends the user's
// wallet to a thin market where someone rests an ask far over the mark: a dialog-less market long fills there. Limits already had
// LIMIT_BAND; now the market path and the close do too (the mark is the vault's own read of Lighter, no extra request).
// Runs the REAL buildOrder / buildClose (src/lighter/perpsCore.ts). PoC base: sec-vault/pass2/agent-near/perps-mark-band.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrder, buildClose, marketOf } from '../src/lighter/perpsCore.ts';

const m = marketOf({ market_id: 7, symbol: 'THIN', size_decimals: 2, price_decimals: 4, min_initial_margin_fraction: 500, mark_price: '1.00', status: 'active', market_type: 'perp', min_base_amount: '0.01', min_quote_amount: '1' });
const order = (o, book) => buildOrder({ market: 7, side: 'long', type: 'market', sizeUsdg: '900', slippageBps: 500, leverage: 5, marginMode: 'cross', ...o }, m, book, Date.now());

test('PERP-1 hostile: a market long into an ask 10× the mark is refused (was: no error, worst price 10.5)', () => {
  const b = order({}, { ask: 10, bid: 0 });
  assert.ok(b.errors.some((e) => /mark price/.test(e)), JSON.stringify(b.errors));
});
test('PERP-1 hostile: a market short into a bid at 0.1× the mark is refused', () => {
  const b = order({ side: 'short' }, { ask: 0, bid: 0.1 });
  assert.ok(b.errors.some((e) => /mark price/.test(e)), JSON.stringify(b.errors));
});
test('PERP-1 hostile: closing a long into a bid at 0.1× the mark never sells under mark·(1 − 5 % − slippage)', () => {
  const c = buildClose(m, { size: 100000n, side: 'long' }, 1, 500, { bid: 0.1, ask: 0 });
  assert.ok(c.worst >= 1 * (1 - 0.05 - 0.05) - 1e-9, `worst ${c.worst}`);
  assert.equal(c.clamped, true);
});
test('PERP-1 hostile: closing a short into an ask 10× the mark never buys over mark·(1 + 5 % + slippage)', () => {
  const c = buildClose(m, { size: 100000n, side: 'short' }, 1, 500, { bid: 0, ask: 10 });
  assert.ok(c.worst <= 1 * (1 + 0.05 + 0.05) + 1e-9, `worst ${c.worst}`);
});
test('PERP-1 hostile: a TP / SL child 100× away from the mark is refused (as on an open position)', () => {
  const b = order({ tp: { trigger: '150' } }, { ask: 1.001, bid: 0.999 });
  assert.ok(b.errors.some((e) => /away from the mark/.test(e)), JSON.stringify(b.errors));
});
test('PERP-1 no regression: an honest market long (ask 0.2 % over the mark) and an honest close are unchanged', () => {
  const b = order({}, { ask: 1.002, bid: 0.998 });
  assert.deepEqual(b.errors, []);
  assert.ok(Math.abs(b.worst - 1.002 * 1.05) < 1e-9);
  const c = buildClose(m, { size: 100000n, side: 'long' }, 1, 500, { bid: 0.998, ask: 1.002 });
  assert.ok(Math.abs(c.worst - 0.998 * 0.95) < 1e-9); assert.notEqual(c.clamped, true);
  const t = order({ tp: { trigger: '1.5' }, sl: { trigger: '0.8' } }, { ask: 1.002, bid: 0.998 });
  assert.deepEqual(t.errors, []); assert.equal(t.orders.length, 3);
});
