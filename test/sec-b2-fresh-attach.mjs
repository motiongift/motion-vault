// Owner in chat 2026-11-04 (relayed by the coordinator): “approved” to "drop the typed code for a FRESH account's first attach and
// fix the copy; keep the code for restores". "Set up this device" (mainAttach) is a one-click dialog when the page hands in no
// expectFp, the vault holds no seed of any kind and no local wallet besides login / hop rows; every restore keeps SEC-5b's typed
// frame-drawn number. Runs the REAL engine.mainAttach and askChoice cut out of src/webEngine.ts in a Chromium vault frame whose
// observer always says "visible" (a masked frame looks exactly like this).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, source } from './sec-cut.mjs';
import { needsChallenge, challengeCode, challengeOk, tooSoon } from '../src/v13Guards.ts';

const SRC = source();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);
const GEO = /function clickProblem/.test(SRC) ? ['GEO_THRESHOLDS', 'GEO_KEEP', 'GEO_MIN_DPR', 'GEO_CUT', 'GEO_OFF', 'GEO_SMALL', 'GEO_MISS', 'geoSlot', 'geoButtons', 'geoView', 'geoEntryProblem', 'geoNow', 'geoUpdate', 'clickProblem'] : [];
const rect = (x, y, w, h) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h });
const MAIN = '0x' + 'ab'.repeat(20);
const SIG = '0x' + '11'.repeat(65);
const FRESH = 'Your trading wallets are created under your account.';
const RESTORE = 'Your trading wallets are restored here, and new ones are created under your account.';

function harness({ seeds = {}, accounts = [] } = {}) {
  const io = { cb: null };
  class FakeIO { constructor(cb) { io.cb = cb; } observe() {} disconnect() {} }
  let onClick = null;
  const err = { textContent: '', hidden: true };
  const input = { value: '' };
  const okBtn = { dataset: {}, closest: (sel) => (sel === '[data-ok]' ? okBtn : null), getBoundingClientRect: () => rect(359, 472, 383, 48), contains: (x) => x === okBtn };
  let html = '';
  const dlg = { querySelector: (sel) => ((sel === '#dk-code' || sel === 'input, textarea') && html.includes('dk-code') ? input : null), querySelectorAll: (sel) => (sel === '[data-ok]' ? [okBtn] : []) };
  const wrap = { className: '', set innerHTML(v) { html = v; }, get innerHTML() { return html; }, querySelector: (sel) => (sel === '.dlg' ? dlg : sel === '.dlg-err' ? err : null), addEventListener: (ev, fn) => { if (ev === 'click') onClick = fn; }, remove() {} };
  const document = { createElement: () => wrap, addEventListener() {}, removeEventListener() {}, body: { appendChild() {} }, elementFromPoint: () => okBtn };
  const window = { IntersectionObserver: FakeIO, innerWidth: 1100, innerHeight: 800, devicePixelRatio: 1 };
  const meta = {};
  const lc = (v) => String(v || '').toLowerCase();
  const stubs = {
    document, window, IntersectionObserver: FakeIO, IntersectionObserverEntry: class { get isVisible() { return true; } },
    HOST: true, crypto: globalThis.crypto, performance: globalThis.performance,
    needsChallenge, challengeCode, challengeOk, tooSoon, pkStepHtml: () => '', uiLang: () => 'en', SEC_LABEL: '', LOCK_SVG: '',
    readStorageAccess: () => {}, keepStorage: () => {}, post: () => {}, dialogsOpen: 0,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    // mainAttach's own surroundings: the vault state under test (seeds, accounts) and inert crypto / storage
    ready: Promise.resolve(), requireUnlocked: () => accounts, allAccounts: () => accounts, seeds, meta,
    mainAddr: (a) => lc(a), lc, same: (a, b) => lc(a) === lc(b), seedOf: (m) => (Object.prototype.hasOwnProperty.call(seeds, m) ? seeds[m] : undefined),
    mvOf: () => 1, MAIN_MSG: () => 'msg', recoverMessageAddress: async () => MAIN, signedIn: () => '',
    seedOfSignature: async () => '0x' + '22'.repeat(32), fingerprint: async () => 'fp-1', MS: (m) => 'ms:' + lc(m),
    persist: async () => {}, storageFlags: () => ({}), summary: () => ({}),
  };
  const f = cut(['escHtml', 'IO_V2', 'MIN_VISIBLE_MS', ...GEO, 'askChoice', 'ask', 'sub', 'muted', 'engine.mainAttach'], stubs);
  const see = () => io.cb([
    { target: dlg, isVisible: true, boundingClientRect: rect(330, 211, 440, 378), intersectionRect: rect(330, 211, 440, 378), intersectionRatio: 1 },
    { target: okBtn, isVisible: true, boundingClientRect: rect(359, 472, 383, 48), intersectionRect: rect(359, 472, 383, 48), intersectionRatio: 1 },
  ]);
  const click = () => onClick({ target: okBtn, isTrusted: true, detail: 1, clientX: 550, clientY: 496 });
  const noBtn = { closest: (sel) => (sel === '[data-no]' ? noBtn : null) };
  const cancel = () => onClick({ target: noBtn, isTrusted: true, detail: 1, clientX: 600, clientY: 540 });
  const typeCode = () => { const m = /Type <b translate="no">(\d+)<\/b>/.exec(html); input.value = m ? m[1] : ''; return !!m; };
  return { f, see, click, cancel, err, typeCode, html: () => html, seeds };
}

test('fresh account, no expectFp: "Set up this device" has no typed code, says the fresh copy, and one click attaches', async () => {
  // a Privy login row and a hop wallet do not make the vault a restore
  const h = harness({ accounts: [{ id: 'p', address: MAIN, ext: 'privy' }, { id: 'h', address: '0x' + 'cd'.repeat(20), key: '0x' + '33'.repeat(32), hop: true }] });
  const done = h.f.mainAttach({ address: MAIN, signature: SIG });
  await sleep(0);
  assert.doesNotMatch(h.html(), /dk-code/);
  assert.ok(h.html().includes(FRESH), 'fresh copy');
  assert.ok(!h.html().includes(RESTORE), 'no restore copy');
  assert.match(h.html(), /Not now/);   // the dialog itself stays: Continue / Not now
  h.see(); await sleep(800); h.click();
  const r = await settle(done, 500);
  assert.notEqual(r, 'pending', 'one click attaches a fresh account');
  assert.equal(r.ok, true);
  assert.equal(h.seeds[MAIN], '0x' + '22'.repeat(32));
});

const RESTORES = [
  ['expectFp set (the account has a profile)', {}, { expectFp: 'fp-1' }],
  ['a local wallet in this vault', { accounts: [{ id: 'w', address: '0x' + 'ef'.repeat(20), key: '0x' + '44'.repeat(32), kind: 'created' }] }, {}],
  ['an archived local wallet', { accounts: [{ id: 'w', address: '0x' + 'ef'.repeat(20), key: '0x' + '44'.repeat(32), archived: true }] }, {}],
  ['another main\'s seed in this vault', { seeds: { ['0x' + '99'.repeat(20)]: '0x' + '55'.repeat(32) } }, {}],
  ['a salt adopted from a backup', { seeds: { 'salt:v2': '0x' + '66'.repeat(32) } }, {}],
];
for (const [what, state, extra] of RESTORES) test(`restore (${what}): "Set up this device" keeps the typed code and the restore copy; one decoy click is refused`, async () => {
  const h = harness(state);
  const done = h.f.mainAttach({ address: MAIN, signature: SIG, ...extra });
  await sleep(0);
  assert.match(h.html(), /id="dk-code"/);
  assert.ok(h.html().includes(RESTORE), 'restore copy');
  assert.ok(!h.html().includes(FRESH), 'no fresh copy');
  h.see(); await sleep(800); h.click();
  assert.equal(await settle(done, 300), 'pending', 'one click must not attach on a restore');
  assert.match(h.err.textContent, /^Type \d{3} in the box to confirm\.$/);
  assert.ok(h.typeCode()); h.click();
  const r = await settle(done, 500);
  assert.equal(r.ok, true);
});

test('fresh account: "Not now" still cancels the first attach (the dialog is kept, only the code goes)', async () => {
  const h = harness();
  const done = h.f.mainAttach({ address: MAIN, signature: SIG }).catch((e) => e.message);
  await sleep(0);
  assert.doesNotMatch(h.html(), /dk-code/);
  h.cancel();
  assert.equal(await settle(done, 300), 'Cancelled');
  assert.equal(h.seeds[MAIN], undefined);
});

test('wiring: mainAttach computes fresh from expectFp, every seed slot and the local (non-login, non-hop) wallets', () => {
  assert.match(SRC, /const fresh = !src\?\.expectFp && !Object\.keys\(seeds\)\.length && !allAccounts\(\)\.some\(\(a\) => !a\.ext && !a\.hop\);/);
  assert.match(SRC, /ask\(\{ title: 'Set up this device', ok: 'Continue', cancelLabel: 'Not now', keep: true, funds: !fresh, /);
  assert.match(SRC, /Owner in chat 2026-11-04: “approved”/);
});
