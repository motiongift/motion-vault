// fix2 p2-speed-03 (2026-11-01): the vault's own route read. A FINISHED read that left no usable copy (motion answered "still
// looking" / "still measuring" for a cold coin — the page's prewarm meets that first) stood as "fresh" for OWN_FRESH (10 s): the
// click a few seconds later, holding motion's now-executable proposal (bridge.js clickHint re-asks a pending answer), got the
// empty read back and was refused ("the vault could not read this market from motion itself"). Now such a read is asked again
// after OWN_RETRY_MS; a copy in hand and a read in flight are served exactly as before (no extra request on the normal click).
// The REAL refreshOwnRoute / ownRouteNow / vouchHint / routeFor are cut out of webEngine.ts, transpiled and run on a stub fetch.
// WE_SRC=<old webEngine.ts> runs the same tests against the code before the fix (the first fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sameRoute } from '../src/v13Guards.ts';

const WE = readFileSync(process.env.WE_SRC || new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const a = WE.indexOf('const OWN_FRESH = 10_000'), b = WE.indexOf('// V13 VA-1: a V2 sell through');
assert.ok(a > 0 && b > a);
const CODE = ts.transpileModule(WE.slice(a, b), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const TOKEN = '0x' + 'ab'.repeat(20);
const ROUTE = { type: 'v4', chainId: 4663, poolKey: { currency0: '0x0', currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: '0x' + '0'.repeat(40) } };
const PENDING = { ok: false, pending: true, error: 'still looking this token up' };

function frame(answers) {
  let now = 1_800_000_000_000;
  const fetches = [];
  const S = {
    fetch: async (url) => { fetches.push(url); const v = answers.length > 1 ? answers.shift() : answers[0]; return { json: async () => v }; },
    AbortSignal: { timeout: () => undefined }, HOST: false, parentOrigin: '', location: { origin: 'https://vault.motion.gift' }, CFG: { key: 'robinhood', id: 4663, name: 'Robinhood Chain' },
    sameRoute, verifyRoute: () => Promise.resolve(), selfCanonical: () => false, KNOWN_HOOKS: [], BRIDGE_TOKENS: [], lc: (x) => String(x).toLowerCase(),
    reject: (why) => { throw new Error(`Route rejected: ${why}`); },
    Date: { now: () => now }, Map, WeakMap, Promise, Error, String, Number, JSON, Object,
  };
  const api = new Function('S', `with (S) { ${CODE}\n return { refreshOwnRoute, ownRouteNow, routeFor, vouchFor }; }`)(S);
  return { ...api, fetches, tick: (ms) => { now += ms; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('p2-speed-03: an empty own read (motion said "still looking") is asked again on the next click, not served for 10 s', async () => {
  const f = frame([PENDING, { ok: true, route: ROUTE }]);
  // the token page's prewarm: motion still looking; the vault reads it too and gets nothing
  await assert.rejects(f.routeFor(TOKEN, PENDING), /still looking/);
  await settle();
  assert.equal(f.fetches.length, 1);
  f.tick(3_000);
  // the click 3 s later carries motion's now-executable proposal: the vault reads motion again and vouches for it
  const route = await f.routeFor(TOKEN, { ok: true, route: ROUTE });
  await f.vouchFor(route);
  assert.equal(f.fetches.length, 2, 'the vault asked motion again (it served the empty read and refused the click)');
});

test('p2-speed-03: a copy in hand and a read in flight are served exactly as before (no extra request on a normal click)', async () => {
  const f = frame([{ ok: true, route: ROUTE }]);
  await f.refreshOwnRoute(TOKEN);
  f.tick(3_000);
  const r = await f.routeFor(TOKEN, { ok: true, route: ROUTE });
  assert.ok(sameRoute(r, ROUTE));
  assert.equal(f.fetches.length, 1, 'own copy younger than OWN_FRESH: no new read');
  // a failed re-read that keeps the last good copy is also not re-read on every click
  const g = frame([{ ok: true, route: ROUTE }, PENDING, { ok: true, route: ROUTE }]);
  await g.refreshOwnRoute(TOKEN); g.tick(11_000); await g.refreshOwnRoute(TOKEN);
  assert.equal(g.fetches.length, 2);
  g.tick(2_000); await g.routeFor(TOKEN, { ok: true, route: ROUTE });
  assert.equal(g.fetches.length, 2, 'the last good copy is in hand: served, not read again within OWN_FRESH');
  // two clicks at once share one read
  const h = frame([PENDING]);
  await h.refreshOwnRoute(TOKEN); h.tick(1_000);
  await Promise.all([h.refreshOwnRoute(TOKEN), h.refreshOwnRoute(TOKEN)]);
  assert.equal(h.fetches.length, 2, 'one new read for both');
  h.tick(100); await h.refreshOwnRoute(TOKEN);
  assert.equal(h.fetches.length, 2, 'not re-read sooner than OWN_RETRY_MS');
});
