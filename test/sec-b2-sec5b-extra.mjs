// SECURITY BATCH 2 — SEC-5b (review addition, foreman's decision 2026-11-04): the typed frame-drawn number of SEC-5 (AskOpts.funds)
// also on the rare, security-relevant one-click dialogs that attach an identity or change where the vault reads / sends:
// "Set up this device" (a main becomes the parent of every new wallet), "A different account signed in" (another account's 2FA
// rules and codes take over), "Change network nodes" (custom RPCs read balances and broadcast trades), "Start a new vault"
// (the stored vault is set aside). In Chromium a page can mask / clip the frame so IntersectionObserver v2 still says "visible"
// (SEC-5): one decoy click would otherwise confirm them. Runs the REAL askChoice (and the real rebind) cut out of src/webEngine.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, source } from './sec-cut.mjs';
import { needsChallenge, challengeCode, challengeOk, tooSoon } from '../src/v13Guards.ts';

const SRC = source();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);
const GEO = /function clickProblem/.test(SRC) ? ['GEO_THRESHOLDS', 'GEO_KEEP', 'GEO_MIN_DPR', 'GEO_CUT', 'GEO_OFF', 'GEO_SMALL', 'GEO_MISS', 'geoSlot', 'geoButtons', 'geoView', 'geoEntryProblem', 'geoNow', 'geoUpdate', 'clickProblem'] : [];
const rect = (x, y, w, h) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h });

// a Chromium vault frame (IntersectionObserver v2 present, always "visible" — a masked frame looks exactly like this), 1100 × 800
function harness(extra = [], more = {}) {
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
  const stubs = {
    document, window, IntersectionObserver: FakeIO, IntersectionObserverEntry: class { get isVisible() { return true; } },
    HOST: true, crypto: globalThis.crypto, performance: globalThis.performance,
    needsChallenge, challengeCode, challengeOk, tooSoon, pkStepHtml: () => '', uiLang: () => 'en', SEC_LABEL: '', LOCK_SVG: '',
    readStorageAccess: () => {}, keepStorage: () => {}, post: () => {}, dialogsOpen: 0,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    ...more,
  };
  const f = cut(['escHtml', 'IO_V2', 'MIN_VISIBLE_MS', ...GEO, 'askChoice', 'ask', 'sub', 'muted', ...extra], stubs);
  const see = () => io.cb([
    { target: dlg, isVisible: true, boundingClientRect: rect(330, 211, 440, 378), intersectionRect: rect(330, 211, 440, 378), intersectionRatio: 1 },
    { target: okBtn, isVisible: true, boundingClientRect: rect(359, 472, 383, 48), intersectionRect: rect(359, 472, 383, 48), intersectionRatio: 1 },
  ]);
  const click = () => onClick({ target: okBtn, isTrusted: true, detail: 1, clientX: 550, clientY: 496 });
  const typeCode = () => { const m = /Type <b translate="no">(\d+)<\/b>/.exec(html); input.value = m ? m[1] : ''; return !!m; };
  return { f, see, click, err, typeCode, html: () => html };
}

// the four dialogs, with the flags their ask() call carries IN THE SOURCE (danger / keep / funds read off the line)
const DIALOGS = ["Set up this device", "A different account signed in", "Change network nodes", "Start a new empty vault?"];
const lineOf = (title) => { const ls = SRC.split('\n').filter((l) => l.includes(`ask({ title: '${title}'`)); assert.equal(ls.length, 1, title); return ls[0]; };
// "Set up this device" carries `funds: !fresh` (owner 2026-11-04: “approved”, test/sec-b2-fresh-attach.mjs): a restore keeps the
// typed number, so it counts here as funds; a fresh account's first attach is the one-click exception.
const flags = (title) => { const l = lineOf(title); return { danger: /ask\(\{ title: '[^']+', (?:[^}]*?)danger: true/.test(l), keep: / keep: true/.test(l), funds: / funds: (?:true|!fresh)/.test(l), ok: (/ ok: '([^']+)'/.exec(l) || [])[1] || 'OK' }; };

for (const title of DIALOGS) test(`SEC-5b hostile: "${title}" — a decoy click through a masked frame (Chromium, IOv2 says visible) is refused; the typed number goes through`, async () => {
  const fl = flags(title);
  const h = harness();
  const answer = h.f.askChoice({ title, html: 'x', ok: fl.ok, ...(fl.danger ? { danger: true } : {}), ...(fl.keep ? { keep: true } : {}), ...(fl.funds ? { funds: true } : {}) });
  h.see(); await sleep(800);
  h.click();
  assert.equal(await settle(answer, 300), 'pending', `one click must not confirm "${title}"`);
  assert.match(h.err.textContent, /^Type \d{3} in the box to confirm\.$/);
  assert.ok(h.typeCode()); h.click();
  assert.equal(await settle(answer, 500), 'ok');
});

test('SEC-5b hostile (real flow): rebind() — another account’s 2FA policy is not taken over by one decoy click', async () => {
  const store = new Map();
  const pending = { enabled: false, gates: {}, source: 'server', at: 2, user: 'did:privy:attacker' };
  const h = harness(['rebind'], { pendingPolicy: pending, serverPolicy: { enabled: true, gates: {}, source: 'server', at: 1, user: 'did:privy:me' }, localStorage: { setItem: (k, v) => store.set(k, v) }, TWOFA_KEY: 'k', noteEver: () => {}, stepUps: new Map() });
  const answer = h.f.rebind();
  h.see(); await sleep(800);
  h.click();
  assert.equal(await settle(answer, 300), 'pending', 'the other account must not take over on a decoy click');
  assert.equal(store.size, 0);
  assert.ok(h.typeCode()); h.click();
  assert.equal(await settle(answer, 500), true);
  assert.match(String(store.get('k')), /did:privy:attacker/);
});

test('SEC-5b wiring: the identity / node dialogs carry funds: true; "Set up this device" only on a restore (funds: !fresh)', () => {
  for (const t of DIALOGS) assert.ok(flags(t).funds, t);
  for (const t of DIALOGS.slice(1)) assert.match(lineOf(t), / funds: true/, t);
  assert.match(lineOf('Set up this device'), / funds: !fresh,/);
});
