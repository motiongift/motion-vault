// earn-ship (2026-11-04): the owner gate for putting Earn on the site. The server's geo answer may carry a per-account cap
// (capUsd) that can only LOWER what the account keeps in Earn; the vault frame sends the site's cookies on that ONE request so the
// server can say "on" only to the owner's preview browser. Mocked Robinhood world (test/fixtures/earn-world.mjs); nothing leaves
// the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEarn } from '../src/earnEngine.ts';
import { EARN } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc, assetsOfR } from './fixtures/earn-world.mjs';

const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });

test('gate: { on: false } and anything but on:true is a no — the switch-on is refused, no dialog, no 2FA', async () => {
  for (const g of [false, { on: false }, { on: 'true' }, null, { capUsd: 100 }]) {
    const wd = makeEarnWorld(); wd.setGeo(g); const e = createEarn(wd.earnDeps);
    await assert.rejects(e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }), /not available where you are/, JSON.stringify(g));
    assert.equal(wd.asks.length, 0); assert.equal(wd.gates(), 0);
  }
});

test('gate: the server cap lowers the account cap — the dialog states it, the deposits stop at it', async () => {
  const wd = makeEarnWorld(); wd.setGeo({ on: true, capUsd: 100 }); const e = createEarn(wd.earnDeps);
  const r = await e.configure({ action: 'on', lang: 'en', cap6: 1_000n * USD, floatOn: true });
  assert.equal(r.earn.cap, 100, 'the cap that applies');
  assert.match(wd.asks[0].html, /\$100/);
  const d = await tick(wd, e);
  assert.equal(d.step, 'deposit', JSON.stringify(d));
  assert.ok(d.usd <= 100, 'deposit ' + d.usd);
  wd.st.usdg.set(lc(wd.R), 2_000_000_000n); wd.clock.t += 3_600_000;
  const d2 = await tick(wd, e);
  assert.notEqual(d2.step, 'deposit', 'nothing more goes in above the server cap: ' + JSON.stringify(d2));
  assert.ok(Number(assetsOfR(wd)) / 1e6 <= 100.000001, 'in Earn ' + Number(assetsOfR(wd)) / 1e6);
  assert.equal(e.account().cap, 100);
});

test('gate: a server cap is clamped to [capMin, capMax]; a bad one is ignored (the account\'s own cap stands)', async () => {
  const cases = [[5, Number(EARN.capMin6 / USD)], [1e9, null], ['100', null], [NaN, null], [-5, null], [0, null]];
  for (const [capUsd, want] of cases) {
    const wd = makeEarnWorld(); wd.setGeo({ on: true, capUsd }); const e = createEarn(wd.earnDeps);
    const r = await e.configure({ action: 'on', lang: 'en', cap6: 500n * USD, floatOn: true });
    assert.equal(r.earn.cap, want ?? 500, `capUsd ${capUsd}`);
  }
  // above capMax: clamped to capMax, which is above the account's 500 → the account's own cap
  const wd = makeEarnWorld(); wd.setGeo({ on: true, capUsd: 1e9 }); const e = createEarn(wd.earnDeps);
  assert.equal((await e.configure({ action: 'on', lang: 'en', cap6: EARN.capMax6, floatOn: true })).earn.cap, Number(EARN.capMax6 / USD));
});

test('gate: the server turning the preview off (on:false after the 6 h cache) stops new deposits; withdrawals never need it', async () => {
  const wd = makeEarnWorld(); wd.setGeo({ on: true, capUsd: 1000 }); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wd, e)).step, 'deposit');
  wd.setGeo({ on: false }); wd.clock.t += EARN.geoMs + 1;
  wd.st.usdg.set(lc(wd.R), 2_000_000_000n);
  assert.equal((await tick(wd, e)).why, 'geo');
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  assert.equal((await tick(wd, e)).step, 'withdraw', 'the refill still runs');
});

test('gate: the old boolean answer still works (true = on, no server cap)', async () => {
  const wd = makeEarnWorld(); wd.setGeo(true); const e = createEarn(wd.earnDeps);
  assert.equal((await e.configure({ action: 'on', lang: 'en', cap6: 700n * USD, floatOn: true })).earn.cap, 700);
});

test('gate (source): only /api/earn/access carries the site cookies; the monitor read stays credential-less', () => {
  const web = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const access = web.split('\n').filter((l) => l.includes("'/api/earn/access'"));
  assert.equal(access.length, 1);
  assert.match(access[0], /credentials: 'include'/);
  assert.match(access[0], /j\.on === true \? \{ on: true, capUsd:/);
  const status = web.split('\n').filter((l) => l.includes("'/api/earn/status'"));
  assert.equal(status.length, 1);
  assert.match(status[0], /credentials: 'omit'/);
  // the live engine has exactly one credentialed request before Earn (the token check on the route API): Earn adds only this one
  assert.equal((web.match(/credentials: 'include'/g) || []).length, 2, 'no other request of the vault carries cookies');
});
