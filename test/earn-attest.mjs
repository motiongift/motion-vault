// release #5 (2026-11-04, owner: Earn for everyone): the one-time self-attestation in the vault's turn-on dialog — "not a US person
// or resident, not in a restricted country" — required before the first deposit, kept per account with its time. Mocked Robinhood
// world (test/fixtures/earn-world.mjs); nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEarn } from '../src/earnEngine.ts';
import { EARN_ATTEST, EARN_ATTEST_V, earnAttestHtml } from '../src/earnCore.ts';
import { USD } from '../src/floatCore.ts';
import { makeEarnWorld, lc } from './fixtures/earn-world.mjs';

const SIZES = [10n * USD, 25n * USD];
const tick = (wd, e) => e.tick(wd.wallet, { sizes6: SIZES, yieldNow: () => false, floatOn: true });
const KEY = 'trenches.earn.v2.attest';
const root = (checked) => ({ querySelector: (s) => (s === '[data-earn-attest]' ? { checked } : null) });

test('attest: the first switch-on carries the line; OK is refused until it is ticked; the tick is kept with its time', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  assert.equal(wd.store.get(KEY), undefined);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  const a = wd.asks[0];
  assert.match(a.html, /data-earn-attest/); assert.match(a.html, /not a US person or resident/); assert.match(a.html, /sanctioned/);
  assert.equal(typeof a.validate, 'function');
  assert.equal(a.validate(root(false), 'ok'), EARN_ATTEST.en.need, 'unticked: the dialog stays, with the reason');
  assert.equal(a.validate(root(true), 'ok'), null, 'ticked: OK');
  const rec = JSON.parse(wd.store.get(KEY));
  assert.equal(rec.v, EARN_ATTEST_V); assert.equal(rec.at, wd.clock.t);
  assert.equal((await tick(wd, e)).step, 'deposit', 'the first deposit after the attestation');
});

test('attest: asked once per account — the next switch-on has no line and no validate', async () => {
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'ru', cap6: null, floatOn: true });
  assert.match(wd.asks[0].html, new RegExp(EARN_ATTEST.ru.line.slice(0, 30)));
  await e.configure({ action: 'off', lang: 'en', floatOn: true }).catch(() => {});
  const n = wd.asks.length;
  await e.configure({ action: 'on', lang: 'en', cap6: 500n * USD, floatOn: true });
  const again = wd.asks.slice(n).find((x) => /USD/.test(x.html) && x.title);
  assert.ok(again, 'a dialog'); assert.doesNotMatch(again.html, /data-earn-attest/); assert.equal(again.validate, undefined);
});

test('attest: a cancelled dialog keeps nothing; without the attestation no deposit ever goes in — withdrawals still run', async () => {
  const wd0 = makeEarnWorld({ answer: false }); const e0 = createEarn(wd0.earnDeps);
  await assert.rejects(e0.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true }), /Cancelled/);
  assert.equal(wd0.store.get(KEY), undefined);
  // an account switched on before release #5 (a grant, no attestation): no deposit; the refill / exit path is untouched
  const wd = makeEarnWorld(); const e = createEarn(wd.earnDeps);
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true });
  assert.equal((await tick(wd, e)).step, 'deposit');
  wd.store.delete(KEY);
  wd.st.usdg.set(lc(wd.R), 2_000_000_000n); wd.clock.t += 3_600_000;
  const d = await tick(wd, e);
  assert.notEqual(d.step, 'deposit', JSON.stringify(d)); assert.equal(d.why, 'geo');
  wd.st.usdg.set(lc(wd.R), 10_000_000n); wd.clock.t += 60_000;
  assert.equal((await tick(wd, e)).step, 'withdraw', 'the refill still runs without it');
  // a session start on that grant cannot skip the dialog: the full one, with the line
  const n = wd.asks.length;
  await e.configure({ action: 'on', lang: 'en', cap6: null, floatOn: true, hours: 8 });
  assert.match(wd.asks.slice(n).map((x) => x.html).join(''), /data-earn-attest/);
});

test('attest: six languages, escaped; the vault dialog runs the validate (webEngine ask)', () => {
  for (const l of ['en', 'ru', 'zh', 'id', 'es', 'fr']) { assert.ok(EARN_ATTEST[l].line.length > 60, l); assert.ok(EARN_ATTEST[l].need, l); }
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  assert.match(earnAttestHtml('en', esc), /^<label class="dk-pick"><input type="checkbox" data-earn-attest><span class="dk-nm dk-decl">/);
  const web = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(web, /if \(o\.validate\) \{ const m = await o\.validate\(dlg, choice\); if \(m\) \{ fail\(m\); return; \} \}/);
});
