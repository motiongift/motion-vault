// fix1 trade-speed-08 (2026-11-01): a cold NEAR route of a coin quoted in NEARLY / RHEA / QTC quoted the four DCL fee tiers of
// its NEAR → quote bridge one after another (4 view round trips). findBridgePool is cut out of nearEngine.ts, its types
// stripped, and run against a stub dclQuote with a simulated view latency. NEAR_SRC=<old copy> runs it on the old code.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(process.env.NEAR_SRC || new URL('../src/nearEngine.ts', import.meta.url), 'utf8');
const i = src.indexOf('async function findBridgePool(quote: string) {'), j = src.indexOf('export async function nearRoute(', i);
assert.ok(i > 0 && j > i);
const fn = stripTypeScriptTypes(src.slice(i, j));
const RTT = 40;

function run(outs) {
  let calls = 0, inFlight = 0, peak = 0;
  const ctx = { NEAR: { wnear: 'wrap.near' }, Promise, BigInt,
    dclQuote: async ([id]) => { calls += 1; inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, RTT)); inFlight -= 1; const fee = Number(id.split('|')[2]); const v = outs[fee]; if (v instanceof Error) throw v; return v ?? null; } };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.findBridgePool = findBridgePool;', ctx);
  return { find: ctx.findBridgePool, stats: () => ({ calls, peak }) };
}

test('trade-speed-08: the four bridge tiers are quoted in one round trip; the tier that buys the most wins', async () => {
  const r = run({ 100: null, 400: 5n, 2000: 9n, 10000: 9n });
  const t0 = performance.now();
  const id = await r.find('nearly.tkn.near');
  const ms = performance.now() - t0;
  assert.equal(id, 'nearly.tkn.near|wrap.near|2000', 'most out; a tie keeps the lower fee tier, as before');
  assert.equal(r.stats().calls, 4);
  assert.ok(r.stats().peak === 4, `all four at once (peak ${r.stats().peak})`);
  assert.ok(ms < RTT * 2.5, `one round trip: ${ms.toFixed(0)} ms (serial ≈ ${RTT * 4} ms)`);
});

test('trade-speed-08: no tier fills → null; a tier whose view fails is skipped like an empty one', async () => {
  assert.equal(await run({}).find('rhea.near'), null);
  assert.equal(await run({ 100: new Error('node down'), 400: 3n }).find('rhea.near'), 'rhea.near|wrap.near|400');
});
