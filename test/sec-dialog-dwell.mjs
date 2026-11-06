// SEC-2 (security audit 2026-11-04, pass 1): in Chromium (IntersectionObserver v2) a vault dialog accepted a trusted click
// the moment it became visible — and even a click that arrived while it was still reported NOT visible (the click handler
// waited up to 800 ms for a "visible" reading and then took the click). A compromised page keeps the frame at opacity 0
// over a decoy ("double-click to claim"), opens a danger dialog (e.g. transfer(…, attacker, 'max') with 2FA off), and flips
// the frame to opacity 1 between the two clicks: no rect change (Chrome's moved-frame input drop does not apply), IOv2
// reports visible ~100 ms later, the second click lands on "Send everything". Safari / Firefox already require 600 ms
// (MIN_DWELL_MS). Runs the REAL askChoice cut out of src/webEngine.ts against a minimal fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut } from './sec-cut.mjs';
import { needsChallenge, challengeCode, challengeOk, tooSoon } from '../src/v13Guards.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const io = { cb: null };
  class FakeIO { constructor(cb) { io.cb = cb; } observe() {} disconnect() {} }
  let onClick = null;
  const err = { textContent: '', hidden: true };
  const dlg = { querySelector: () => null };
  const wrap = {
    className: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    querySelector: (sel) => (sel === '.dlg' ? dlg : sel === '.dlg-err' ? err : null),
    addEventListener: (ev, fn) => { if (ev === 'click') onClick = fn; }, remove() {},
  };
  const okBtn = { dataset: {}, closest: (sel) => (sel === '[data-ok]' ? okBtn : null) };
  const document = { createElement: () => wrap, addEventListener() {}, removeEventListener() {}, body: { appendChild() {} } };
  const stubs = {
    document, window: { IntersectionObserver: FakeIO }, IntersectionObserver: FakeIO, IntersectionObserverEntry: class { get isVisible() { return true; } },
    HOST: true, crypto: globalThis.crypto, performance: globalThis.performance,
    needsChallenge, challengeCode, challengeOk, tooSoon, pkStepHtml: () => '', uiLang: () => 'en', SEC_LABEL: '', LOCK_SVG: '',
    readStorageAccess: () => {}, keepStorage: () => {}, post: () => {}, dialogsOpen: 0,
  };
  // batch 2 (SEC-5): askChoice's geometry helpers come along where the build has them
  const GEO = /function clickProblem/.test(source()) ? ['GEO_THRESHOLDS', 'GEO_KEEP', 'GEO_MIN_DPR', 'GEO_CUT', 'GEO_OFF', 'GEO_SMALL', 'GEO_MISS', 'geoSlot', 'geoButtons', 'geoView', 'geoEntryProblem', 'geoNow', 'geoUpdate', 'clickProblem'] : [];
  const f = cut(['escHtml', 'IO_V2', 'MIN_VISIBLE_MS', ...GEO, 'askChoice'].filter((n) => n !== 'MIN_VISIBLE_MS' || HAS_MIN), stubs);
  const see = (v) => io.cb([{ isVisible: v }]);
  const click = () => onClick({ target: okBtn, isTrusted: true });
  return { f, see, click, err };
}
// the fixed build declares MIN_VISIBLE_MS; the unfixed one does not (the harness must load both)
import { source } from './sec-cut.mjs';
const HAS_MIN = /\bconst MIN_VISIBLE_MS\b/.test(source());

const settle = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);

test('SEC-2: a click on a dialog that turned visible 30 ms earlier is refused (Chromium)', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Send outside your vault', html: 'x', ok: 'Send everything', danger: true });
  h.see(false);                 // the page keeps the frame at opacity 0
  await sleep(1200);            // the dialog has been open (invisible) for a while
  h.see(true);                  // the page flips the frame to opacity 1 between the two clicks of a double-click
  await sleep(30);
  h.click();
  assert.equal(await settle(answer, 1500), 'pending', 'the swapped-in dialog must not take the click');
  assert.equal(h.err.hidden, false, 'the user is told why');
});

test('SEC-2: a click that arrives while the dialog is reported NOT visible is refused, even if "visible" follows', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Send outside your vault', html: 'x', ok: 'Send', danger: true });
  h.see(false);
  await sleep(300);
  h.click();                    // while still invisible
  await sleep(50); h.see(true); // the observer's next reading
  assert.equal(await settle(answer, 1500), 'pending');
});

test('SEC-2: a dialog that has been visible for long enough takes the click (no change for a normal user)', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Create a wallet', html: 'x', ok: 'Create wallet' });
  await sleep(100); h.see(true);
  await sleep(700);
  h.click();
  assert.equal(await settle(answer, 1500), 'ok');
});

test('SEC-2: after a refused early click, the same dialog takes a later click', async () => {
  const h = harness();
  const answer = h.f.askChoice({ title: 'Send outside your vault', html: 'x', ok: 'Send', danger: true });
  h.see(true); await sleep(20); h.click();
  assert.equal(await settle(answer, 200), 'pending');
  await sleep(700); h.click();
  assert.equal(await settle(answer, 1500), 'ok');
});
