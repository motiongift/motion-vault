// trade-core.patch — proof that the Elysium patch changes NOTHING on the Robinhood / BNB / Solana / NEAR paths.
// The frozen trade core (test/fixtures/trade-core.json, owner-approved pins) is hashed again with the Elysium hunks taken back
// out, mechanically: the ELYSIUM section (E9), the lines tagged "(trade-core.patch E5|E7|E8)", and the one changed line of
// E6 restored. If any other byte of a pinned file, declaration or region had changed, a hash here would differ.
// (since e676b7d the owner's pins include Elysium r8; the region test below restores only the stage-3 line.)
// (test/trade-core-pin.mjs itself FAILS on the patched tree, on the region verifyCache…REASONS only — expected: it moved; the
// owner re-pins after his yes. This test is what tells him that the move is exactly the Elysium hunks and nothing else.)
//   node --experimental-strip-types --test test/elysium-pin-delta.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CORE_FILES, CORE_DECLS, CORE_REGIONS, declChunk, regionChunk } from '../scripts/trade-core.mjs';

const root = new URL('../', import.meta.url);
const pinned = JSON.parse(readFileSync(new URL('./fixtures/trade-core.json', import.meta.url), 'utf8'));
const sha = (s) => createHash('sha256').update(s.replace(/\r/g, '')).digest('hex');
const src = readFileSync(new URL('src/webEngine.ts', root), 'utf8').replace(/\r/g, '');

const E6_NEW = "const routeApi = () => (HOST && parentOrigin ? parentOrigin : location.origin) + (CFG.key === 'bsc' ? '/bsc' : CFG.key === 'elysium' ? '/elysium' : '') + '/api';   // (trade-core.patch E6: + '/elysium')";
const E6_OLD = "const routeApi = () => (HOST && parentOrigin ? parentOrigin : location.origin) + (CFG.key === 'bsc' ? '/bsc' : '') + '/api';";
export function withoutElysium(s) {
  const a = s.indexOf('// ── ELYSIUM (trade-core.patch E9'), b = s.indexOf('// ── /ELYSIUM ──\n');
  assert.ok(a > 0 && b > a, 'the ELYSIUM section is delimited');
  let out = s.slice(0, a) + s.slice(b + '// ── /ELYSIUM ──\n'.length);
  const lines = out.split('\n');
  const tagged = lines.filter((l) => /\(trade-core\.patch E(5|7|8)\)/.test(l));
  assert.equal(tagged.length, 4, 'E5, E7 and E8 (tradeOne + previewOne) are one line each');
  out = lines.filter((l) => !/\(trade-core\.patch E(5|7|8)\)/.test(l)).join('\n');
  assert.equal(out.split(E6_NEW).length - 1, 1, 'E6 is the one changed line');
  return out.replace(E6_NEW, E6_OLD);
}

test('pinned files are byte-identical (the patch adds files, it edits none of them)', () => {
  for (const f of CORE_FILES) assert.equal(sha(readFileSync(new URL(f, root), 'utf8')), pinned.files[f], f);
});

test('every pinned declaration of webEngine.ts is byte-identical', () => {
  for (const [f, names] of Object.entries(CORE_DECLS)) for (const n of names) assert.equal(sha(declChunk(src, n)), pinned.decls[`${f}#${n}`], `${f} ${n}`);
});

// Stage 3 (2026-11-04): the owner re-pinned the region WITH the Elysium r8 hunks (e676b7d, «Re-pin trade core for Elysium trading r8»).
// The stage-3 delta changes ONE line of it, in elyProbe (the probe's state = ELY.elyProbeState: the probe + the hook-code guard).
// Restoring that one line must give back exactly the owner's pin; nothing else in the region moved.
const S3_NEW = "'latest', ELY.elyProbeState(from, balance)] } as any)";
const S3_OLD = "'latest', { [from]: { code: ELY.ELYSIUM_PROBE_RUNTIME, balance: '0x' + balance.toString(16) } }] } as any)";
// Release 7.1: the probe is split under 256 KiB per call — two lines of elyProbe, tagged "(rel7.1 T1)"; restoring them gives the
// region the owner pinned after stage 3 back (test/trade-core-pin.mjs fails on the patched tree until the owner re-pins)
const R71_OLD = ["  const ret = await client.request({ method: 'eth_call', params: [{ from, to: from, data: ELY.probeData(cases), gas: '0x' + ELY_PROBE_GAS.toString(16), gasPrice: '0x' + gasPrice.toString(16) }, 'latest', ELY.elyProbeState(from, balance)] } as any) as `0x${string}`;", '  const seen = ELY.probeDecode(ret);'];
export function withoutRel71(s) {
  const lines = s.split('\n'), tagged = lines.map((l, i) => (l.includes('(rel7.1 T1)') ? i : -1)).filter((i) => i >= 0);
  if (!tagged.length) return s;
  assert.equal(tagged.length, 2, 'the two rel7.1 lines');
  lines[tagged[0]] = R71_OLD[0]; lines[tagged[1]] = R71_OLD[1];
  return lines.join('\n');
}
export function withoutStage3(s) { assert.equal(s.split(S3_NEW).length - 1, 1, 'the stage-3 line, once'); return s.replace(S3_NEW, S3_OLD); }
test('the pinned region verifyCache…REASONS minus exactly the stage-3 line hashes to the owner’s pin (e676b7d, Elysium r8)', () => {
  const back = withoutStage3(withoutRel71(src));
  // release #5: after the owner's re-pin for stage 3 the fixture carries the NEW region hash; the proof stays against the e676b7d pin
  const R8_PIN = { 'src/webEngine.ts#verifyCache…REASONS': '4455fa1f259c8f33692b82025941e07807773162c8a305dfa38d6c799ef7641f' };
  for (const [f, regions] of Object.entries(CORE_REGIONS)) for (const [a, b] of regions) assert.equal(sha(regionChunk(back, a, b)), R8_PIN[`${f}#${a}…${b}`], `${f} ${a}…${b}`);
  for (const [f, regions] of Object.entries(CORE_REGIONS)) for (const [a, b] of regions) assert.equal(sha(regionChunk(withoutRel71(src), a, b)), pinned.decls[`${f}#${a}…${b}`], 'the re-pin is this region with the stage-3 line');
});

test('the Robinhood and BNB chain entries are untouched; Elysium is a new key', () => {
  const head = src.slice(src.indexOf('const CHAIN_CFGS'), src.indexOf('// Host mode:'));
  const rh = head.slice(head.indexOf('  robinhood: {'), head.indexOf('  bsc: {'));
  const bsc = head.slice(head.indexOf('  bsc: {'), head.indexOf('  // Elysium (trade-core.patch E2'));
  const base = readFileSync(new URL('test/fixtures/elysium-base-chaincfgs.txt', root), 'utf8').replace(/\r/g, '');
  assert.equal(rh + bsc, base, 'robinhood + bsc entries byte-identical to the base tree');
  assert.match(head, /\n  elysium: \{\n    id: ELY\.ELY_CHAIN_ID, key: 'elysium'/);
});

test('every Elysium dispatch fires only for the Elysium frame or an ely route', () => {
  const lines = src.split('\n').filter((l) => /\(trade-core\.patch E(5|7|8)\)/.test(l));
  for (const l of lines) assert.match(l, /^\s+if \(CFG\.key === 'elysium' \|\| route\.type === 'ely'\) /, l.trim().slice(0, 80));
  assert.match(src, /async function elyTradeOne[^\n]*\n {2}if \(CFG\.key !== 'elysium' \|\| chain\.id !== ELY\.ELY_CHAIN_ID\) reject\(/, 'an ely route in another frame is refused before anything is read');
});
