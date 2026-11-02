// TRADE CORE is frozen (docs/TRADE-CORE.md). This test fails when a byte of the click → signed-transaction path changes.
// If it fails on your change: STOP. Do not re-pin. The owner decides; ask him in chat with a measured latency A/B
// (docs/TRADE-CORE.md §4). Only after his explicit "yes" for that change: node scripts/trade-core.mjs --write "<his words, date>".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentPins, CORE_FILES, CORE_DECLS, CORE_REGIONS } from '../scripts/trade-core.mjs';

const pinned = JSON.parse(readFileSync(new URL('./fixtures/trade-core.json', import.meta.url), 'utf8'));
const now = currentPins();
const STOP = 'TRADE CORE is frozen by the owner (docs/TRADE-CORE.md): this change needs his explicit approval in chat — do not re-pin';

test('every trade-core file is byte-for-byte the approved one', () => {
  for (const f of CORE_FILES) assert.equal(now.files[f], pinned.files[f], `${STOP}: ${f} changed`);
});

test('every trade-path declaration of webEngine.ts is the approved one', () => {
  for (const [f, names] of Object.entries(CORE_DECLS)) for (const n of names) assert.equal(now.decls[`${f}#${n}`], pinned.decls[`${f}#${n}`], `${STOP}: ${f} ${n}() changed`);
});

// the region (route checks → tradeOne → preview → leftovers → limits → tradeGuard → trade / tradeInner → receipts) was hashed
// but never compared until 2026-11-01 (owner: «я даю добро на все»)
test('every pinned region of webEngine.ts is the approved one', () => {
  for (const [f, regions] of Object.entries(CORE_REGIONS)) for (const [a, b] of regions) {
    const k = `${f}#${a}…${b}`;
    assert.ok(pinned.decls[k], `${STOP}: ${k} has no pin`);
    assert.equal(now.decls[k], pinned.decls[k], `${STOP}: ${f} ${a}…${b} changed`);
  }
});

test('the pin list itself is not shortened', () => {
  assert.deepEqual(Object.keys(pinned.files).sort(), [...CORE_FILES].sort(), STOP + ': the pinned file list changed');
  assert.deepEqual(Object.keys(pinned.decls).sort(), Object.keys(now.decls).sort(), STOP + ': the pinned declaration list changed');
  assert.ok(String(pinned.approval || '').length >= 10, 'the pins carry the owner\'s approval text');
});
