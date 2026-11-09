// (2026-11-09) the per-wallet buy cap ("Large buy") and the hourly total ("Large hourly buy total", 5× the cap) are a
// last-resort guard against a hostile page, not a step in normal trading. Defaults per lane in its native unit:
// Robinhood 25 ETH, BNB 100 BNB, Solana 500 SOL, NEAR 1000 NEAR (unchanged), Elysium 500 HYPE. A stored cap the user chose
// still applies; a stored cap equal to its lane's OLD default (1 ETH, 5 BNB, 25 SOL, 1000 NEAR, 1 elsewhere) reads as unset.
// The REAL tradeLimits / buyCap are cut out of webEngine.ts (declChunk), transpiled, and run on a stub localStorage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { declChunk } from '../scripts/trade-core.mjs';
import { ledgerAdd, BUY_WINDOW_MS, SLIP_SILENT, slipNeedsClick } from '../src/v13Guards.ts';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const names = ['LIMITS_KEY', 'CAP_DEFAULT', 'CAP_OLD', 'laneKey', 'laneUnit', 'loadLimits', 'saveLimits', 'buyCap', 'recordBuy', 'tradeLimits'];
const CODE = ts.transpileModule(names.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const LANES = { robinhood: { key: 'robinhood', NATIVE: 'ETH' }, bsc: { key: 'bsc', NATIVE: 'BNB' }, elysium: { key: 'elysium', NATIVE: 'HYPE' }, sol: { SOL_MODE: true }, near: { NEAR_MODE: true } };

function frame(lane, cap) {
  const L = LANES[lane]; const store = new Map(); const asks = [];
  if (cap !== undefined) store.set('trenches.engine.limits', JSON.stringify({ cap: { [lane]: cap } }));
  const S = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    SOL_MODE: !!L.SOL_MODE, NEAR_MODE: !!L.NEAR_MODE, CFG: { key: L.key || 'robinhood' }, NATIVE: L.NATIVE || 'ETH', ledgerAdd, BUY_WINDOW_MS, SLIP_SILENT, slipNeedsClick,
    escHtml: (x) => String(x), sub: (x) => x, muted: (x) => x,
    ask: async (o) => { asks.push(o.title); return true; },
    Date: { now: () => 1_800_000_000_000 }, JSON, Number, Math, Array, Object, String,
  };
  const api = new Function('S', `with (S) { ${CODE}\n return { tradeLimits, buyCap }; }`)(S);
  return { ...api, asks };
}
const SET = { slippage: 12 };
const NEW = { robinhood: 25, bsc: 100, sol: 500, near: 1000, elysium: 500 };
const OLD = { robinhood: 1, bsc: 5, sol: 25, near: 1000, elysium: 1 };

test('nocap: the default caps are 25 ETH / 100 BNB / 500 SOL / 1000 NEAR / 500 HYPE; a buy at the cap asks nothing, above it asks once', async () => {
  for (const [lane, cap] of Object.entries(NEW)) {
    const f = frame(lane);
    assert.equal(f.buyCap(), cap, lane);
    await f.tradeLimits('buy', cap, SET, 1);
    assert.deepEqual(f.asks, [], `${lane}: ${cap} asks nothing`);
    const g = frame(lane);
    await g.tradeLimits('buy', cap * 1.01, SET, 1);
    assert.deepEqual(g.asks, ['Large buy'], `${lane}: above ${cap} asks`);
  }
});

test('nocap: a stored cap equal to the OLD default reads as unset (the user never chose it)', async () => {
  for (const [lane, old] of Object.entries(OLD)) {
    const f = frame(lane, old);
    assert.equal(f.buyCap(), NEW[lane], lane);
    if (lane === 'near') continue;   // the NEAR default did not change
    await f.tradeLimits('buy', old * 2, SET, 1);
    assert.deepEqual(f.asks, [], `${lane}: ${old * 2} under the new default asks nothing`);
  }
});

test('nocap: a cap the user stored (lower or higher than the default) still applies', async () => {
  const low = frame('robinhood', 0.5);
  assert.equal(low.buyCap(), 0.5);
  await low.tradeLimits('buy', 0.6, SET, 1);
  assert.deepEqual(low.asks, ['Large buy']);
  const near = frame('near', 1);   // 1 is the OLD default of the EVM lanes, not of NEAR: the user's
  assert.equal(near.buyCap(), 1);
  const ely = frame('elysium', 3);
  assert.equal(ely.buyCap(), 3);
  await ely.tradeLimits('buy', 4, SET, 1);
  assert.deepEqual(ely.asks, ['Large buy']);
  const high = frame('bsc', 150);
  await high.tradeLimits('buy', 150, SET, 1);
  assert.deepEqual(high.asks, []);
  for (const bad of [0, -1, 'x', null]) assert.equal(frame('sol', bad).buyCap(), 500, `stored ${bad}`);
});

test('nocap: the hourly total still asks past 5× the (new) cap — 125 ETH on Robinhood across wallets', async () => {
  const f = frame('robinhood');
  for (let i = 0; i < 5; i++) await f.tradeLimits('buy', 2.5, SET, 10);   // 25 ETH a click, 125 ETH in the hour
  assert.deepEqual(f.asks, []);
  await f.tradeLimits('buy', 2.5, SET, 10);
  assert.deepEqual(f.asks, ['Large hourly buy total']);
});
