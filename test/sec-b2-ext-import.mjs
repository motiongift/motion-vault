// SECURITY BATCH 2 — EXT-1 (engine side): the extension side panel hands the legacy keys straight to the vault frame. The frame
// takes them only from the TOP-LEVEL window at a pinned extension origin, runs the ordinary import (its own dialog + trusted
// click), and answers only that window with no key in the answer. Runs the REAL onExtImport cut out of src/webEngine.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut } from './sec-cut.mjs';

const EXT = 'chrome-extension://nojealomoobhcodabdhmlajjfejeboec';
const KEY = '0x' + '11'.repeat(32);
function world() {
  const sent = [];
  const mk = (name) => ({ name, postMessage: (m, o) => sent.push({ to: name, m, o }) });
  const TOP = mk('top'), PARENT = mk('parent'), SELF = mk('self');
  const window = { top: TOP };
  const runs = [];
  const f = cut(['EXT_IMPORT_ORIGINS', 'onExtImport'], { window });
  const run = async (items) => { runs.push(items); return { ok: true, results: items.map((x, i) => ({ ok: true, name: x.name || 'W' + i, key: x.privateKey })) }; };
  return { f, run, runs, sent, TOP, PARENT, SELF };
}
const msg = (source, origin, data) => ({ source, origin, data });

test('EXT-1: the side panel (top window, pinned extension origin) imports straight into the frame; the answer carries no key', async () => {
  const w = world();
  assert.equal(await w.f.onExtImport(msg(w.TOP, EXT, { t: 'extImport', id: 'n1', items: [{ name: 'Old 1', privateKey: KEY }] }), w.run), true);
  assert.equal(w.runs.length, 1); assert.equal(w.runs[0][0].privateKey, KEY);
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].to, 'top'); assert.equal(w.sent[0].o, EXT);
  assert.ok(!JSON.stringify(w.sent[0].m).includes('11111111'), 'no key material goes back');
  assert.deepEqual(w.sent[0].m, { t: 'extImportRet', id: 'n1', ok: true, v: { results: [{ ok: true, name: 'Old 1' }] } });
});
test('EXT-1 hostile: the same message from the motion.gift document (the frame\'s parent) is ignored', async () => {
  const w = world();
  assert.equal(await w.f.onExtImport(msg(w.PARENT, 'https://motion.gift', { t: 'extImport', id: 'x', items: [{ privateKey: KEY }] }), w.run), false);
  assert.equal(await w.f.onExtImport(msg(w.TOP, 'https://motion.gift', { t: 'extImport', id: 'x', items: [{ privateKey: KEY }] }), w.run), false);
  assert.equal(w.runs.length, 0); assert.equal(w.sent.length, 0);
});
test('EXT-1 hostile: a pinned extension origin that is not the top window, or an unpinned extension, is ignored', async () => {
  const w = world();
  assert.equal(await w.f.onExtImport(msg(w.PARENT, EXT, { t: 'extImport', id: 'x', items: [{ privateKey: KEY }] }), w.run), false);
  assert.equal(await w.f.onExtImport(msg(w.TOP, 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh', { t: 'extImport', id: 'x', items: [{ privateKey: KEY }] }), w.run), false);
  assert.equal(w.runs.length, 0); assert.equal(w.sent.length, 0);
});
test('EXT-1: a refused or failed import answers with the reason only', async () => {
  const w = world();
  await w.f.onExtImport(msg(w.TOP, EXT, { t: 'extImport', id: 'n2', items: [{ privateKey: KEY }] }), async () => { throw new Error('Cancelled'); });
  assert.deepEqual(w.sent[0].m, { t: 'extImportRet', id: 'n2', ok: false, e: 'Cancelled' });
});
