// SECURITY BATCH 2 — SEC-5 (High, Chromium): IntersectionObserver v2 does not see a CSS mask, a clip-path, an overflow:hidden crop
// or a CSS zoom the page puts on the vault frame (measured in Chrome 156, batch2\logs\sec5-probe-b1.json: isVisible stays true).
// Fix: (1) the dialogs that hand out a key or send value out of the vault's control ask for the frame-drawn number in Chromium too
// (AskOpts.funds) — trade dialogs keep the one click; (2) every dialog refuses a click when the frame's own geometry says it is
// not shown whole: the observer's intersection (clipped by every ancestor) smaller than the dialog / button, a button outside the
// frame's viewport, a devicePixelRatio under 0.7 (CSS zoom), or a hit target under the click point that is not the button.
// Runs the REAL askChoice cut out of src/webEngine.ts against a fake DOM (as sec-dialog-dwell.mjs). Real-Chrome evidence:
// batch2\logs\SEC-5-chrome-*.log (clickjack harness, b1 vs this build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, source } from './sec-cut.mjs';
import { needsChallenge, challengeCode, challengeOk, tooSoon } from '../src/v13Guards.ts';

const SRC = source();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);
const GEO = /function clickProblem/.test(SRC) ? ['GEO_THRESHOLDS', 'GEO_KEEP', 'GEO_MIN_DPR', 'GEO_CUT', 'GEO_OFF', 'GEO_SMALL', 'GEO_MISS', 'geoSlot', 'geoButtons', 'geoView', 'geoEntryProblem', 'geoNow', 'geoUpdate', 'clickProblem'] : [];
const rect = (x, y, w, h) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h });

// a Chromium vault frame (IntersectionObserver v2 present), 1100 × 800, the dialog centred, one confirm button
function harness({ dpr = 1, hit = 'button' } = {}) {
  const io = { cb: null };
  class FakeIO { constructor(cb) { io.cb = cb; } observe() {} disconnect() {} }
  let onClick = null;
  const err = { textContent: '', hidden: true };
  const input = { value: '' };
  const okBtn = { dataset: {}, closest: (sel) => (sel === '[data-ok]' ? okBtn : null), getBoundingClientRect: () => rect(359, 472, 383, 48), contains: (x) => x === okBtn };
  const dlg = { querySelector: (sel) => (sel === '#dk-code' ? (html.includes('dk-code') ? input : null) : sel === 'input, textarea' ? (html.includes('dk-code') ? input : null) : null), querySelectorAll: (sel) => (sel === '[data-ok]' ? [okBtn] : []) };
  let html = '';
  const wrap = { className: '', set innerHTML(v) { html = v; }, get innerHTML() { return html; }, querySelector: (sel) => (sel === '.dlg' ? dlg : sel === '.dlg-err' ? err : null), addEventListener: (ev, fn) => { if (ev === 'click') onClick = fn; }, remove() {} };
  const other = { tag: 'decoy' };
  const document = { createElement: () => wrap, addEventListener() {}, removeEventListener() {}, body: { appendChild() {} }, elementFromPoint: () => (hit === 'button' ? okBtn : other) };
  const window = { IntersectionObserver: FakeIO, innerWidth: 1100, innerHeight: 800, devicePixelRatio: dpr };
  const stubs = {
    document, window, IntersectionObserver: FakeIO, IntersectionObserverEntry: class { get isVisible() { return true; } },
    HOST: true, crypto: globalThis.crypto, performance: globalThis.performance,
    needsChallenge, challengeCode, challengeOk, tooSoon, pkStepHtml: () => '', uiLang: () => 'en', SEC_LABEL: '', LOCK_SVG: '',
    readStorageAccess: () => {}, keepStorage: () => {}, post: () => {}, dialogsOpen: 0,
    // the frame's 150 ms geometry tick, unref'd: a dialog a test leaves open must not hold the test process
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  };
  const f = cut(['escHtml', 'IO_V2', 'MIN_VISIBLE_MS', ...GEO, 'askChoice'], stubs);
  // one observer reading: the dialog and the button, each with its intersection (what the top-level viewport shows of it)
  const see = ({ dlgShown = rect(330, 211, 440, 378), btnShown = rect(359, 472, 383, 48) } = {}) => io.cb([
    { target: dlg, isVisible: true, boundingClientRect: rect(330, 211, 440, 378), intersectionRect: dlgShown, intersectionRatio: 1 },
    { target: okBtn, isVisible: true, boundingClientRect: rect(359, 472, 383, 48), intersectionRect: btnShown, intersectionRatio: 1 },
  ]);
  const click = (x = 550, y = 496) => onClick({ target: okBtn, isTrusted: true, detail: 1, clientX: x, clientY: y });
  const typeCode = () => { const m = /Type <b translate="no">(\d+)<\/b>/.exec(html); input.value = m ? m[1] : ''; return !!m; };
  return { f, see, click, err, typeCode, html: () => html };
}

test('SEC-5 hostile: in Chromium a "Send outside your vault" dialog asks for the frame-drawn number (a masked frame shows the decoy only)', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Send outside your vault', html: 'x', ok: 'Send everything', danger: true, funds: true });
  h.see(); await sleep(800);
  h.click();                    // the decoy click: everything else about the frame looks fine to the observer
  assert.equal(await settle(answer, 300), 'pending', 'a one-click confirm through a mask must not send');
  assert.match(h.err.textContent, /^Type \d{3} in the box to confirm\.$/);
  assert.ok(h.typeCode()); h.click();
  assert.equal(await settle(answer, 500), 'ok', 'the user who reads the number and types it goes through');
});
test('SEC-5 control: a trade danger dialog ("Large buy") stays one click in Chromium — speed', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Large buy', html: 'x', ok: 'Buy 2 ETH', danger: true });
  assert.doesNotMatch(h.html(), /dk-code/);
  h.see(); await sleep(700); h.click();
  assert.equal(await settle(answer, 500), 'ok');
});
test('SEC-5 hostile: a clip-path / crop around the frame (the observer\'s intersection is 8 px of the button) refuses the click', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Raise the gas boost', html: 'x', ok: 'Boost to 5x', danger: true });
  h.see({ dlgShown: rect(546, 492, 8, 8), btnShown: rect(546, 492, 8, 8) }); await sleep(800);
  h.click();
  assert.equal(await settle(answer, 300), 'pending');
  assert.match(h.err.textContent, /cut off or partly hidden/);
});
test('SEC-5 hostile: a CSS zoom on the frame (devicePixelRatio 0.12 inside it) refuses the click', async () => {
  const h = harness({ dpr: 0.12 });
  const answer = h.f.askChoice({ title: 'Raise the gas boost', html: 'x', ok: 'Boost to 5x', danger: true });
  h.see(); await sleep(800);
  h.click();
  assert.equal(await settle(answer, 300), 'pending');
  assert.match(h.err.textContent, /too small to read/);
});
test('SEC-5 hostile: a click whose point the frame does not hit-test as the button is refused', async () => {
  const h = harness({ hit: 'other' });
  const answer = h.f.askChoice({ title: 'Raise the gas boost', html: 'x', ok: 'Boost to 5x', danger: true });
  h.see(); await sleep(800);
  h.click();
  assert.equal(await settle(answer, 300), 'pending');
  assert.match(h.err.textContent, /did not land on the vault's button/);
});
test('SEC-5 hostile: un-clipping the frame right before the click does not count — the whole dialog must be shown for 600 ms', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Raise the gas boost', html: 'x', ok: 'Boost to 5x', danger: true });
  h.see({ dlgShown: rect(546, 492, 8, 8), btnShown: rect(546, 492, 8, 8) }); await sleep(900);
  h.see(); await sleep(100);   // the page lifts the clip on mousedown
  h.click();
  assert.equal(await settle(answer, 300), 'pending');
  await sleep(600); h.click();
  assert.equal(await settle(answer, 500), 'ok', 'shown whole long enough: taken');
});
test('SEC-5 no cost: an honest dialog shown whole is taken at the same moment as before (from the first reading)', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Create a wallet', html: 'x', ok: 'Create wallet' });
  await sleep(10); h.see(); await sleep(650);
  h.click();
  assert.equal(await settle(answer, 500), 'ok');
});
test('SEC-5 wiring: every key / outside-value dialog carries funds: true; the trade dialogs do not', () => {
  const lines = SRC.split('\n');
  const of = (re) => lines.filter((l) => re.test(l));
  for (const l of of(/title: 'Send outside your vault'/)) assert.match(l, /funds: true/, l.slice(0, 120));
  // + 1 (release 9): float.withdraw to an outside address (webEngine withdrawOk), Send's own dialog, funds: true
  assert.equal(of(/title: 'Send outside your vault'/).length, 6);
  assert.match(of(/title: login \? 'Bridge to your login wallet'/)[0], /funds: true/);
  assert.match(of(/title: login \? 'Swap to your login wallet'/)[0], /funds: true/);
  assert.match(of(/title: R\.title\(list\[i\]\.name\), danger: true/)[0], /funds: true/);
  assert.equal(of(/funds: true, guard: true, cancel: false, plain: true/).length, 2, 'both key exports');
  for (const t of ['High slippage', 'Large buy', 'Large hourly buy total', 'Sell through an unknown asset']) assert.doesNotMatch(of(new RegExp(`title: '${t}'`))[0], /funds: true/, t);
});
