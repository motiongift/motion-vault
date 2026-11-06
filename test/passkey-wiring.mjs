// Backup v4 wiring in src/webEngine.ts, pinned by source (webEngine pulls in browser globals and cannot be imported in node; the
// ceremonies run for real in trench scripts/passkey-e2e.mjs with a Chrome virtual authenticator). Run: node --test test/passkey-wiring.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const method = (name) => { const i = src.indexOf(`\n  ${name}: async`); assert.ok(i > 0, name); const j = src.indexOf('\n  },\n', i); return src.slice(i, j); };

test('the ceremony starts inside the trusted click, before anything is awaited', () => {
  const click = src.slice(src.indexOf("if (!e.isTrusted) return;"), src.indexOf("if (o.validate)"));
  const g = click.indexOf('o.gesture()'), firstAwait = click.indexOf('await ');
  assert.ok(g > 0 && (firstAwait < 0 || g < firstAwait), 'gesture() runs before the first await of the OK handler (SEC-2: none left before validate)');
  assert.ok(click.indexOf('if (!e.isTrusted) return;') < g, 'after the isTrusted check');
  assert.match(src, /gesture: \(\) => \{ if \(!run\) run = start\(\); \}/, 'one ceremony per click, restartable after a failure');
});

test('the RP ID is the vault host; the page never gets a PRF output, a data key or the recovery code', () => {
  assert.match(src, /const PK_RP = typeof location !== 'undefined' \? rpIdFor\(location\.hostname\) : '';/);
  for (const m of ['passkeyEnrol', 'passkeyVerify', 'passkeyUnlock', 'passkeyRecover', 'passkeyAdd', 'passkeyRemove', 'passkeyNewCode', 'passkeyOff', 'passkeyStatus', 'passkeyConfirmed']) {
    const body = method(m);
    const rets = body.match(/return \{[^\n]*\};/g) || [];
    for (const r of rets) assert.doesNotMatch(r, /\bprf\b|\bdk\b|rc\.text|rc\.bytes|seed\b/, `${m}: ${r}`);
  }
  assert.doesNotMatch(method('passkeyRecover'), /post\(/, 'the code is typed and checked inside the frame');
});

test('publish: v4 accounts seal under K4; a locked vault and a server copy that lost its envelope write nothing', () => {
  const mp = method('mainProfile');
  assert.match(mp, /throw pkError\('PasskeyLocked'/);
  assert.match(mp, /throw pkError\('PasskeyBackupMissing'/);
  assert.match(mp, /pkRestoredAt\)\) \{ const \{ \[m\]: _, \.\.\.rest \} = meta\.pk4; meta\.pk4 = rest;/, 'an operator restore (server-set mark) lets the vault write v3 again');
  assert.ok(mp.indexOf('pkRestoredAt)) {') < mp.indexOf("throw pkError('PasskeyBackupMissing'"), 'checked before the refusal');
  assert.match(mp, /\.\.\.\(k4 \? \{ v4: \{ key: k4 \} \} : \{\}\)/);
  assert.ok(mp.indexOf("PasskeyLocked") < mp.indexOf('buildProfile('), 'checked before anything is built');
  assert.match(method('mainSync'), /openProfile\(p, seed, saltsOf\(\), k4\.keys\)/);
  assert.match(method('mainPublished'), /pkChange\.delete\(p\.main\)/);
});

test('enrolment: never with an unproven (rk1) seed; recovery code before anything is staged; nothing cached before the fresh verify', () => {
  assert.match(src, /if \(meta\.seedSrc\?\.\[m\] === 'rk1'\) throw new Error/);
  const e = method('passkeyEnrol');
  assert.ok(e.indexOf('pkShowCode(') < e.indexOf('upgradeProfile('));
  assert.doesNotMatch(e, /seeds\[PK\(/, 'no data key is kept at enrolment');
  assert.doesNotMatch(e, /meta\.pk4 =/, 'the account is not v4 here until the server confirmed');
  const v = method('passkeyVerify');
  assert.match(v, /pkUnlockWith\(m, pk,/, 'a fresh touch, not the sealing keys');
  assert.match(v, /verifyStaged\(/);
  assert.match(method('passkeyConfirmed'), /if \(!dkOf\(m, gen\)\) throw/);
});

test('turn off: a fresh touch, a warning, and a staged v3 copy (never a direct write)', () => {
  const o = method('passkeyOff');
  assert.match(o, /danger: true/);
  assert.ok(o.indexOf('ask(') < o.indexOf('pkUnlockWith('));
  assert.match(o, /downgradeProfile\(/);
  assert.doesNotMatch(o, /pkChange\.set/);
});

test('trade path untouched: nothing of backup v4 between verifyCache and REASONS', () => {
  const i = src.indexOf('const verifyCache = new Map'), j = src.indexOf('const REASONS: Record<string, string>');
  assert.ok(i > 0 && j > i);
  assert.doesNotMatch(src.slice(i, j), /passkey|pk4|PkEnvelope|v4KeysOf/i);
});
