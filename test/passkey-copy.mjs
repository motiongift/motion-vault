// The passkey-backup dialogs' words (src/passkeyCopy.ts) in the app's six languages, and how webEngine.ts uses them: every key in
// every language, no empty line, the same placeholders everywhere, the step label, "Nothing was changed." on every failure, and
// the English the dialogs show (the e2e stand clicks these labels). Run: node --test test/passkey-copy.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PK_COPY, PK_LANGS, PK_NOTHING_CHANGED, PK_DLG_RULES, pkT, pkStepHtml, pkWarnKey } from '../src/passkeyCopy.ts';
import { recoveryPaths } from '../src/passkeyBackup.ts';

const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const EN = PK_COPY.en;
const KEYS = Object.keys(EN);
const forms = (v) => (typeof v === 'string' ? [v] : Object.values(v));
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const method = (name) => { const i = src.indexOf(`\n  ${name}: async`); assert.ok(i > 0, name); const j = src.indexOf('\n  },\n', i); return src.slice(i, j); };

test('six languages, every key in each, nothing extra, nothing empty', () => {
  assert.deepEqual([...PK_LANGS], ['en', 'ru', 'zh', 'id', 'es', 'fr']);
  assert.deepEqual(Object.keys(PK_COPY).sort(), [...PK_LANGS].sort());
  assert.ok(KEYS.length >= 80, `${KEYS.length} keys`);
  for (const l of PK_LANGS) {
    assert.deepEqual(Object.keys(PK_COPY[l]).sort(), [...KEYS].sort(), `${l}: the same keys as English`);
    for (const k of KEYS) {
      const v = PK_COPY[l][k];
      assert.equal(typeof v, typeof EN[k], `${l}.${k}: a plain line where English has one, a plural where English has one`);
      if (typeof v === 'object') assert.ok(typeof v.other === 'string', `${l}.${k}: a plural has its 'other' form`);
      for (const f of forms(v)) assert.ok(typeof f === 'string' && f.trim().length > 0 && f === f.trim(), `${l}.${k}: no empty or padded line`);
    }
  }
});

test('the other five are translations, not English copies', () => {
  const same = (l) => KEYS.filter((k) => forms(PK_COPY[l][k]).join('|') === forms(EN[k]).join('|'));
  for (const l of PK_LANGS.filter((x) => x !== 'en')) assert.deepEqual(same(l), [], `${l}: lines left in English`);
});

test('placeholders are the same in every language and every plural form', () => {
  for (const k of KEYS) {
    const want = holes(forms(EN[k])[0]);
    for (const f of forms(EN[k])) assert.equal(holes(f), want, `en.${k}`);
    for (const l of PK_LANGS) for (const f of forms(PK_COPY[l][k])) assert.equal(holes(f), want, `${l}.${k}: ${f}`);
  }
  // the count-dependent lines carry the count
  for (const k of KEYS.filter((x) => typeof EN[x] === 'object')) assert.equal(holes(EN[k].other), 'n', k);
});

test('pkT: language codes, placeholders, plurals', () => {
  assert.equal(pkT('stepOf', 'en', { n: 2, of: 4 }), 'Step 2 of 4');
  assert.equal(pkT('stepOf', 'ru-RU', { n: 2, of: 4 }), 'Шаг 2 из 4');
  assert.equal(pkT('stepOf', 'zh-CN', { n: 2, of: 4 }), '第 2 步，共 4 步');
  assert.equal(pkT('stepOf', 'in', { n: 2, of: 4 }), 'Langkah 2 dari 4');
  assert.equal(pkT('stepOf', 'es-419', { n: 1, of: 2 }), 'Paso 1 de 2');
  assert.equal(pkT('stepOf', 'fr-CA', { n: 1, of: 2 }), 'Étape 1 sur 2');
  assert.equal(pkT('stepOf', 'de', { n: 1, of: 2 }), 'Step 1 of 2', 'anything else: English');
  assert.equal(pkT('rmTitle', 'en', { name: 'iCloud Keychain' }), 'Remove iCloud Keychain?');
  assert.equal(pkT('add1Count', 'en', { n: 1 }), 'Your backup has 1 passkey now.');
  assert.equal(pkT('add1Count', 'en', { n: 3 }), 'Your backup has 3 passkeys now.');
  assert.equal(pkT('add1Count', 'ru', { n: 1 }), 'Сейчас у копии 1 ключ доступа.');
  assert.equal(pkT('add1Count', 'ru', { n: 3 }), 'Сейчас у копии 3 ключа доступа.');
  assert.equal(pkT('add1Count', 'ru', { n: 5 }), 'Сейчас у копии 5 ключей доступа.');
  assert.equal(pkT('on1Entries', 'fr', { n: 1 }), 'Votre sauvegarde contient 1 entrée.');
  assert.equal(pkT('on1Entries', 'es', { n: 7 }), 'Tu copia contiene 7 entradas.');
  assert.equal(pkT('rmLeft', 'zh', { n: 2 }), '仍可用 2 个通行密钥打开。');
  assert.equal(pkT('errOther', 'en', { detail: 'x' }), 'The passkey did not answer (x). Nothing was changed. Click to try again.');
  // every line of every language renders with no placeholder left over
  for (const l of PK_LANGS) for (const k of KEYS) for (const n of [0, 1, 2, 5, 21]) assert.doesNotMatch(pkT(k, l, { n, of: 4, name: 'P', detail: 'd' }), /\{\w+\}/, `${l}.${k}`);
});

test('the step head: "Step n of m" in the page language and a bar of m segments with n lit', () => {
  const h = pkStepHtml({ n: 2, of: 4 }, 'en');
  assert.match(h, /^<p class="dk-step"><span class="dk-step-t">Step 2 of 4<\/span><span class="dk-bar" aria-hidden="true">/);
  assert.equal((h.match(/<i[ >]/g) || []).length, 4);
  assert.equal((h.match(/<i class="on">/g) || []).length, 2);
  assert.doesNotMatch(h, /style=/, 'classes only: the frame CSP ignores inline styles');
  for (const l of PK_LANGS) assert.ok(pkStepHtml({ n: 3, of: 4 }, l).includes(pkT('stepOf', l, { n: 3, of: 4 })), l);
  const c = pkStepHtml({ n: 9, of: 2 }, 'en');
  assert.match(c, /Step 2 of 2/, 'clamped');
  assert.equal((c.match(/<i class="on">/g) || []).length, 2);
  // its rules ride in the engine's own constructed sheet, next to the USD dialogs' rules (no vault.css change)
  for (const cls of ['.dk-head', '.dk-step', '.dk-bar', '.dk-bar i.on']) assert.ok(PK_DLG_RULES.some((r) => r.startsWith(cls + '{') || r.includes(' ' + cls + '{') || r.includes(cls + ' ')), cls);
  assert.match(src, /s\.replaceSync\(FLOAT_DLG_RULES\.join\('\\n'\) \+ '\\n' \+ PK_DLG_RULES\.join\('\\n'\)\)/);
  assert.match(src, /for \(const r of \[\.\.\.FLOAT_DLG_RULES, \.\.\.PK_DLG_RULES\]\)/);
  assert.match(src, /\$\{o\.step \? `<div class="dk-head">\$\{pkStepHtml\(o\.step, uiLang\(\)\)\}` : ''\}<h3>/, 'askChoice draws it above the title');
});

test('every failure and cancel line says "Nothing was changed." in its language', () => {
  for (const l of PK_LANGS) {
    const nc = pkT('nothingChanged', l);
    for (const k of PK_NOTHING_CHANGED) assert.ok(pkT(k, l, { detail: 'd' }).includes(nc), `${l}.${k}`);
    // the step notes promise nothing changes until the last step / when closed
    for (const k of ['on1Note', 'add1Note', 'checkNote', 'off2Note', 'confirmNote', 'rmNote']) assert.ok(pkT(k, l).length > 10, `${l}.${k}`);
  }
  assert.equal(pkT('cancelled', 'en'), 'Cancelled. Nothing was changed.');
  // a user's cancel still throws exactly 'Cancelled' (the page matches /^cancel/i): no localized cancel is thrown
  assert.doesNotMatch(src, /new Error\(pkt\('cancelled'\)\)/);
  for (const m of ['passkeyEnrol', 'passkeyRecover', 'passkeyRemove', 'passkeyNewCode', 'passkeyOff']) assert.match(method(m), /throw new Error\('Cancelled'\)/, m);
});

test('the English the dialogs show: every key webEngine uses exists, every dialog key is used, the e2e labels are unchanged', () => {
  const used = new Set([...src.matchAll(/\b(?:pkt|pkSub|pkLine|pkMuted)\('(\w+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/'(\w+)'/g)) if (m[1] in EN) used.add(m[1]);
  for (const k of used) if (/^[a-z]+[A-Z0-9]/.test(k) && !(k in EN) && src.includes(`pkt('${k}'`)) assert.fail(`webEngine uses a missing key ${k}`);
  // the page's line for a cancel; the test's phrase; pkStepHtml's own; the remove dialog's warning (through pkWarnKey)
  const pageOnly = new Set(['cancelled', 'nothingChanged', 'stepOf', 'warnOneWay', 'warnNoSync']);
  assert.match(method('passkeyRemove'), /warnKey = pkWarnKey\(left\)/);
  const unused = KEYS.filter((k) => !pageOnly.has(k) && !used.has(k));
  assert.deepEqual(unused, [], 'every dialog line is shown somewhere');
  // the labels scripts/passkey-e2e.mjs clicks, and the texts it reads
  assert.equal(EN.btnCreate, 'Create passkey');
  assert.equal(EN.btnUse, 'Use passkey');
  assert.equal(EN.btnSaved, 'I saved it');
  assert.equal(EN.btnRemove, 'Remove passkey');
  assert.equal(EN.btnContinue, 'Continue');
  assert.match(EN.recTypo, /wrong/);
  assert.match(EN.recNoOpen, /does not open/);
  // the recovery code is the first `.dk-sub b` of its dialog: the line above it is plain text
  assert.match(src, /\$\{pkSub\('codeLead'\)\}<p class="dk-sub" translate="no"><b>\$\{escHtml\(code\)\}<\/b>/);
  for (const l of PK_LANGS) assert.doesNotMatch(pkT('codeLead', l), /</, l);
  // no English left hard-coded in the passkey methods' dialogs
  for (const m of ['passkeyEnrol', 'passkeyVerify', 'passkeyUnlock', 'passkeyRecover', 'passkeyAdd', 'passkeyRemove', 'passkeyNewCode', 'passkeyOff']) {
    const body = method(m);
    assert.doesNotMatch(body, /title: '|title: `|ok: '[A-Z]|sub\('|muted\('|signedIn\(m\)/, `${m}: every dialog line comes from passkeyCopy`);
  }
});

test('the steps of each flow', () => {
  const st = (body, n, of) => assert.ok(body.includes(`step: { n: ${n}, of: ${of} }`), `step ${n} of ${of}`);
  const on = method('passkeyEnrol');
  st(on, 1, 4);                                                               // create
  assert.match(src, /step: \{ n: first\.step\.n \+ 1, of: first\.step\.of \}/); // confirm: 2 of 4 (add: 2 of 2)
  assert.match(on, /pkShowCode\(rc\.text, fileCurrent\(\), \{ step: \{ n: 3, of: 4 \} \}\)/);
  st(method('passkeyVerify'), 4, 4);                                          // the fresh touch on the staged copy
  const off = method('passkeyOff'); st(off, 1, 2); st(off, 2, 2);
  st(method('passkeyAdd'), 1, 2);
  for (const m of ['passkeyUnlock', 'passkeyRecover', 'passkeyRemove', 'passkeyNewCode']) assert.doesNotMatch(method(m), /step:/, `${m}: a single dialog`);
  // the order is unchanged: the danger confirmation before the touch (turn off), the code before anything is staged (turn on)
  assert.ok(off.indexOf('ask(') < off.indexOf('pkUnlockWith('));
  assert.ok(on.indexOf('pkEnrolPrf(') < on.indexOf('pkShowCode(') && on.indexOf('pkShowCode(') < on.indexOf('upgradeProfile('));
});

test('error names are unchanged; their message is the page language line', () => {
  for (const [name, keys] of Object.entries({ PasskeyNoPrf: ['noPrfCreate', 'noPrfSecond', 'noPrfDiffer'], PasskeyWrong: ['wrong'], PasskeyElsewhere: ['elsewhere'], PasskeyNeedsFile: ['needsFile'],
    PasskeyLocked: ['lockedFirst', 'lockedPublish', 'lockedConfirm'], PasskeyNoCode: ['noCode'], PasskeyUnsupported: ['unsupportedOrigin', 'unsupportedApp'], PasskeyBackupMissing: ['backupMissing'] })) {
    for (const k of keys) assert.ok(src.includes(`pkError('${name}', pkt('${k}'))`), `${name} ← ${k}`);
  }
  assert.doesNotMatch(src.slice(src.indexOf('const pkt = '), src.indexOf('const fileCurrent = ')), /pkError\('Passkey\w+', '/, 'no English message left on a named passkey error');
});

test('the remove dialog warning matches recoveryPaths (English text and the same cases)', () => {
  const slot = (sync) => ({ id: 'x', sync });
  const cases = [{ slots: [slot(true)] }, { slots: [slot(true)], rc: { iv: 'a', ct: 'b' } }, { slots: [slot(false), slot(false)] }, { slots: [slot(true), slot(false)] }, { slots: [slot(false), slot(false)], rc: { iv: 'a', ct: 'b' } }, { slots: [], rc: { iv: 'a', ct: 'b' } }];
  for (const pk of cases) {
    const r = recoveryPaths(pk, { dkCached: true });
    const k = pkWarnKey(r);
    assert.equal(k ? pkT(k, 'en') : '', r.warn, JSON.stringify(pk));
  }
});
