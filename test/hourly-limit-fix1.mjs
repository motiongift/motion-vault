// fix1 trade-speed-07 (2026-11-01): the hourly buy total (F-70). The "Large hourly buy total" dialog said "Confirm once" but
// nothing was kept, so once the rolling hour passed 5× the cap EVERY later buy opened it again; a cancelled ask still counted;
// and a refused buy straight from the USD balance counted again when the app fell back to hold & fire for the same click.
// The REAL tradeLimits / recordBuy / unrecordBuy / nothingSent are cut out of webEngine.ts (declChunk), transpiled, and run on a
// stub localStorage with the real ledgerAdd. WE_SRC=<old webEngine.ts> runs the same tests against the code before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { declChunk } from '../scripts/trade-core.mjs';
import { ledgerAdd, BUY_WINDOW_MS, SLIP_SILENT, slipNeedsClick } from '../src/v13Guards.ts';

const WE = readFileSync(process.env.WE_SRC || new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const has = (n) => { try { declChunk(WE, n); return true; } catch { return false; } };
const names = ['LIMITS_KEY', 'CAP_DEFAULT', ...(has('CAP_OLD') ? ['CAP_OLD'] : []), 'laneKey', 'laneUnit', 'loadLimits', 'saveLimits', 'buyCap', 'recordBuy', 'tradeLimits', ...(has('unrecordBuy') ? ['unrecordBuy', 'nothingSent'] : [])];
const CODE = ts.transpileModule(names.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

// a stored cap of 2 ETH (not a default, old or new: the hourly behaviour is tested apart from the default caps — those are in
// test/buy-cap-defaults.mjs)
function frame({ answers = [] } = {}) {
  const store = new Map([['trenches.engine.limits', JSON.stringify({ cap: { robinhood: 2 } })]]); const asks = [];
  let now = 1_800_000_000_000;
  const S = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    SOL_MODE: false, NEAR_MODE: false, CFG: { key: 'robinhood' }, NATIVE: 'ETH', ledgerAdd, BUY_WINDOW_MS, SLIP_SILENT, slipNeedsClick,
    escHtml: (x) => String(x), sub: (x) => x, muted: (x) => x,
    ask: async (o) => { asks.push(o.title); return answers.length ? answers.shift() : true; },
    Date: { now: () => now }, JSON, Number, Math, Array, Object, String,
  };
  const api = new Function('S', `with (S) { ${CODE}\n return { tradeLimits, recordBuy, loadLimits, ${has('unrecordBuy') ? 'unrecordBuy, nothingSent' : 'unrecordBuy: null, nothingSent: null'} }; }`)(S);
  const total = () => (api.loadLimits().buys?.robinhood || []).reduce((s, [, a]) => s + a, 0);
  return { ...api, asks, total, tick: (ms) => { now += ms; }, now: () => now };
}
const SET = { slippage: 12 };

test('trade-speed-07: past 5× the cap the hourly dialog asks ONCE, then not again for another 5× the cap within the hour', async () => {
  const f = frame();
  // cap 2 ETH on Robinhood: 10 wallets × 0.1 ETH = 1 ETH a click; the 11th click passes 10 ETH
  for (let i = 0; i < 10; i++) await f.tradeLimits('buy', 0.1, SET, 10);
  assert.equal(f.asks.length, 0);
  await f.tradeLimits('buy', 0.1, SET, 10);
  assert.deepEqual(f.asks, ['Large hourly buy total'], 'asked once past 10 ETH');
  for (let i = 0; i < 10; i++) await f.tradeLimits('buy', 0.1, SET, 10);
  assert.equal(f.asks.length, 1, 'the next 10 ETH of buys (up to the confirmed 11 + 5× the cap) do not ask again (they used to ask on every click)');
  await f.tradeLimits('buy', 0.1, SET, 10);
  assert.equal(f.asks.length, 2, 'past the confirmed amount + 5× the cap it asks again');
  // an hour later the kept confirmation is gone (and the old buys have left the window)
  f.tick(BUY_WINDOW_MS + 1000);
  for (let i = 0; i < 11; i++) await f.tradeLimits('buy', 0.1, SET, 10);
  assert.equal(f.asks.length, 3);
});

test('trade-speed-07: a cancelled hourly ask records nothing; every buy that goes on is in the ledger before it is sent', async () => {
  const f = frame({ answers: [false] });
  for (let i = 0; i < 10; i++) await f.tradeLimits('buy', 0.1, SET, 10);
  assert.ok(Math.abs(f.total() - 10) < 1e-9);
  await assert.rejects(f.tradeLimits('buy', 0.1, SET, 10), /Cancelled: the last hour's buys total above 5×/);
  assert.ok(Math.abs(f.total() - 10) < 1e-9, `the cancelled buy is not counted (total ${f.total()})`);
  await f.tradeLimits('buy', 0.1, SET, 10);   // confirmed this time
  assert.ok(Math.abs(f.total() - 11) < 1e-9);
});

test('trade-speed-07: a USD direct buy that sent nothing takes its own ledger entry back; a send or an unknown keeps it', async () => {
  const f = frame();
  assert.ok(f.unrecordBuy, 'unrecordBuy exists');
  await f.tradeLimits('buy', 0.2, SET, 2);
  const since = f.now(); f.tick(5);
  await f.tradeLimits('buy', 0.1, SET, 3);   // the USD click: 0.3 ETH
  assert.ok(Math.abs(f.total() - 0.7) < 1e-9);
  assert.equal(f.nothingSent([{ ok: false, state: 'not_started' }, { ok: false, state: 'not_started' }]), true);
  assert.equal(f.nothingSent([{ ok: false, state: 'not_started' }, { ok: false, state: 'unknown' }]), false, 'an unknown may have been sent');
  assert.equal(f.nothingSent([{ ok: true, state: 'submitted' }]), false);
  assert.equal(f.nothingSent([]), false);
  f.unrecordBuy(since, 0.1 * Math.max(1, 3));
  assert.ok(Math.abs(f.total() - 0.4) < 1e-9, `only this click's 0.3 left the hour (total ${f.total()})`);
  f.unrecordBuy(since, 0.3);
  assert.ok(Math.abs(f.total() - 0.4) < 1e-9, 'an older entry (before the click started) is never taken out');
});

test('trade-speed-07: usdBuy / usdBuyEvm hand the entry back only when every wallet answered not_started, or the route failed', () => {
  for (const fn of ['usdBuy', 'usdBuyEvm']) {
    const c = declChunk(WE, fn);
    assert.ok(c.includes('const ledgerAt = Date.now();'), fn);
    assert.ok(/if \(nothingSent\(results\)\) unrecordBuy\(ledgerAt, \w+ \* Math\.max\(1, targets\.length\)\);/.test(c), fn);
    assert.equal((c.match(/unrecordBuy\(ledgerAt/g) || []).length, 2, `${fn}: the route failure and the all-refused answer`);
  }
});
