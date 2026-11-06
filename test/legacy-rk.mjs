// Legacy phone-access copies (V12 F-28 follow-up, 2026-10-28): src/rkMigrate.ts with real signatures (viem), and the
// wiring in src/webEngine.ts pinned by source (webEngine pulls in browser globals and cannot be imported in node; the full
// flow runs in the trench repo's scripts/account-sync-e2e.mjs, scenario legacy-rk). Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { MAIN_MSG, RECOVERY_MSG, seedOfSignature, recoveryKeyV1, sealRecovery, openRecovery, fingerprint, buf, b64 } from '../src/vaultRecovery.ts';
import { recoveryBodyVersion, adoptCheck, localOnly, rkLangOf, RK_LANGS, UPDATE_DIALOG, REMOVE_DIALOG, UNBACKED_SEND, RK_LEGACY_CT_BYTES, RK_V2_CT_BYTES } from '../src/rkMigrate.ts';

const enc = new TextEncoder();
async function setup(mv = 1) {
  const mainA = privateKeyToAccount(generatePrivateKey()), recA = privateKeyToAccount(generatePrivateKey());
  const main = mainA.address.toLowerCase(), recovery = recA.address.toLowerCase();
  const mainSig = await mainA.signMessage({ message: MAIN_MSG(main, mv) });
  const seed = await seedOfSignature(mainSig);
  const recoverySig = await recA.signMessage({ message: RECOVERY_MSG(main, recovery) });
  return { main, recovery, mainSig, seed, recoverySig, mv, fp: await fingerprint(seed) };
}
// exactly what every engine before V12 F-28 (2026-10-19 … 24) sealed: body {v:1, s}, no main signature
async function sealLegacy(main, recovery, recoverySig, seed) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode('motion/recovery/v1/' + main + '/' + recovery)) }, await recoveryKeyV1(recoverySig), buf(enc.encode(JSON.stringify({ v: 1, s: seed })))));
  return { v: 1, addr: recovery, iv: b64(iv), ct: b64(ct) };
}
const recover = (message, signature) => recoverMessageAddress({ message, signature });

test('legacy-rk: the body version reads off the outer envelope — a legacy copy is 96 bytes, a v2 copy 243, for both texts', async () => {
  for (const mv of [1, 2]) {
    const s = await setup(mv);
    const old = await sealLegacy(s.main, s.recovery, s.recoverySig, s.seed);
    const now = await sealRecovery(s.main, s.recovery, s.recoverySig, s.seed, s.mainSig, mv);
    assert.equal(Buffer.from(old.ct, 'base64').length, RK_LEGACY_CT_BYTES);
    assert.equal(Buffer.from(now.ct, 'base64').length, RK_V2_CT_BYTES);
    assert.equal(recoveryBodyVersion(old), 1, 'legacy body');
    assert.equal(recoveryBodyVersion(now), 2, 'v2 body');
    // and what each one actually holds, opened (the envelope never lies about it)
    assert.equal((await openRecovery(old, s.main, s.recoverySig)).ms, undefined);
    assert.equal((await openRecovery(now, s.main, s.recoverySig)).ms, s.mainSig);
  }
  assert.equal(recoveryBodyVersion(null), 0);
  assert.equal(recoveryBodyVersion({ v: 1, addr: '0x' + '1'.repeat(40), iv: 'A'.repeat(16), ct: 'A'.repeat(40) }), 0, 'an unknown length is neither');
  assert.equal(recoveryBodyVersion({ v: 2, addr: '0x' + '1'.repeat(40), iv: 'A'.repeat(16), ct: 'A'.repeat(128) }), 0, 'outer v must be 1');
});

test('legacy-rk: a phone adopts a v2 copy only when its main signature derives exactly the seed the phone already uses', async () => {
  const s = await setup(2);
  const v2 = await sealRecovery(s.main, s.recovery, s.recoverySig, s.seed, s.mainSig, 2);
  const opened = await openRecovery(v2, s.main, s.recoverySig);
  const ok = await adoptCheck({ opened, main: s.main, localSeed: s.seed, localMv: 2, fp: s.fp, fingerprint, recover });
  assert.deepEqual(ok, { ok: true, ms: s.mainSig, mv: 2 });
});

test('legacy-rk: every way an adoption can be wrong is refused, and says which', async () => {
  const s = await setup(1);
  const legacy = await openRecovery(await sealLegacy(s.main, s.recovery, s.recoverySig, s.seed), s.main, s.recoverySig);
  const base = { main: s.main, localSeed: s.seed, localMv: 1, fp: s.fp, fingerprint, recover };
  assert.deepEqual(await adoptCheck({ ...base, opened: legacy }), { ok: false, why: 'not-v2' }, 'a legacy body proves nothing');
  assert.deepEqual(await adoptCheck({ ...base, opened: null }), { ok: false, why: 'not-v2' });
  const v2 = await openRecovery(await sealRecovery(s.main, s.recovery, s.recoverySig, s.seed, s.mainSig, 1), s.main, s.recoverySig);
  // a phone whose seed was planted through the unbound copy: the main's real signature derives ANOTHER seed
  const planted = '0x' + 'ab'.repeat(32);
  assert.deepEqual(await adoptCheck({ ...base, opened: v2, localSeed: planted }), { ok: false, why: 'local-seed' });
  // a v2 body whose ms is another wallet's signature (a page that controls only the recovery wallet)
  const other = privateKeyToAccount(generatePrivateKey());
  const otherMs = await other.signMessage({ message: MAIN_MSG(s.main, 1) });
  assert.deepEqual(await adoptCheck({ ...base, opened: { seed: await seedOfSignature(otherMs), ms: otherMs, mv: 1 }, localSeed: await seedOfSignature(otherMs) }), { ok: false, why: 'signer' });
  // ms is the main's but the body's seed is not the one it derives
  assert.deepEqual(await adoptCheck({ ...base, opened: { seed: planted, ms: s.mainSig, mv: 1 } }), { ok: false, why: 'seed' });
  // the profile's fingerprint is another seed's
  assert.deepEqual(await adoptCheck({ ...base, opened: v2, fp: 'f'.repeat(16) }), { ok: false, why: 'fp' });
  assert.deepEqual(await adoptCheck({ ...base, opened: v2, fp: '' }), { ok: false, why: 'fp' });
  // the phone attached with the other fixed text (other text = other wallets)
  assert.deepEqual(await adoptCheck({ ...base, opened: v2, localMv: 2 }), { ok: false, why: 'text' });
});

test('legacy-rk: the local-only wallets are exactly the ones the account did not restore (case-insensitive, nothing else)', () => {
  const ws = [{ address: '0xAAaa000000000000000000000000000000000001' }, { address: '0xbbbb000000000000000000000000000000000002' }, { address: '0xcccc000000000000000000000000000000000003' }];
  assert.deepEqual(localOnly(ws, ['0xaaaa000000000000000000000000000000000001', '0xCCCC000000000000000000000000000000000003']).map((w) => w.address), ['0xbbbb000000000000000000000000000000000002']);
  assert.deepEqual(localOnly(ws, []).length, 3);
  assert.deepEqual(localOnly([], ['0x1']).length, 0);
});

test('legacy-rk: the dialogs are worded in all six languages and say the truth about the backup', () => {
  assert.deepEqual([...RK_LANGS], ['en', 'ru', 'zh', 'id', 'es', 'fr']);
  for (const l of RK_LANGS) {
    for (const [k, v] of Object.entries(UPDATE_DIALOG[l])) assert.ok(typeof v === 'string' && v.length > 1, `UPDATE_DIALOG.${l}.${k}`);
    for (const [k, v] of Object.entries(UNBACKED_SEND[l])) assert.ok(typeof v === 'function' ? v('Wallet 3').includes('Wallet 3') : v.length > 1, `UNBACKED_SEND.${l}.${k}`);
    const R = REMOVE_DIALOG[l];
    assert.ok(R.title('Wallet 3').includes('Wallet 3'));
    for (const k of ['ok', 'cancel', 'kept', 'keptNote', 'lost', 'lostNote']) assert.ok(R[k].length > 1, `REMOVE_DIALOG.${l}.${k}`);
  }
  // the engine draws no cancel button for the label 'Cancel' (askChoice: only the ×) — every dialog here keeps a real one
  for (const D of [UPDATE_DIALOG, REMOVE_DIALOG, UNBACKED_SEND]) for (const l of RK_LANGS) assert.notEqual(D[l].cancel, 'Cancel', `${l} cancel label`);
  // the owner's words, verbatim, in English
  assert.equal(REMOVE_DIALOG.en.kept, 'Removed from this device. It stays in your encrypted backup and can be restored.');
  assert.ok(!/leaves your encrypted backup/.test(JSON.stringify(REMOVE_DIALOG)), 'the old promise is gone');
  assert.equal(UPDATE_DIALOG.en.title, 'Update your phone access');
  assert.equal(UPDATE_DIALOG.en.sub, 'Sign once to keep every wallet backed up.');
  assert.equal(UPDATE_DIALOG.en.note, 'Cancel keeps everything as it is.');
  for (const [v, l] of [['ru-RU', 'ru'], ['zh-CN', 'zh'], ['in', 'id'], ['ms-MY', 'id'], ['es-419', 'es'], ['fr-CA', 'fr'], ['uk', 'ru'], ['de', 'en'], ['', 'en'], [null, 'en'], ['EN', 'en']]) assert.equal(rkLangOf(v), l, String(v));
});

// ── the wiring in webEngine.ts (by source) ──
const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const method = (name) => { const i = src.indexOf(`\n  ${name}: async`); assert.ok(i > 0, name + ' exists'); const j = src.indexOf('\n  },\n', i); return src.slice(i, j); };

test('legacy-rk wiring: the desktop update re-seals as v2 only after its own trusted click, with the same recovery wallet', () => {
  const m = method('mainRecoveryUpdate');
  assert.match(m, /recoveryBodyVersion\(p\.rk\) === 2\) return \{ ok: true, already: true \}/, 'a v2 copy is left as it is');
  assert.match(m, /lc\(p\.rk\.addr\) !== r\) throw/, 'the same recovery wallet as the copy it replaces');
  assert.match(m, /RECOVERY_MSG\(m, r\)[\s\S]*same\(signer, r\)/, 'the recovery wallet\'s own signature');
  assert.match(m, /mainSigFor\(m, src\.mainSignature\)/, 'bound to the main\'s verified signature');
  assert.ok(m.indexOf('await ask(') > 0 && m.indexOf('await ask(') < m.indexOf('sealRecovery('), 'the click comes before the seal');
  assert.match(m, /throw new Error\('Cancelled'\)/);
  assert.match(m, /rk1 && !\/\^0x\[0-9a-fA-F\]\{130\}\$\/\.test\(String\(src\?\.mainSignature/, 'an rk1 device needs the main\'s signature handed in');
});

test('legacy-rk wiring: the phone adopts only through adoptCheck, then marks the seed main and publishes a union', () => {
  const m = method('mainRecoveryAdopt');
  assert.match(m, /meta\.seedSrc\?\.\[m\] !== 'rk1'\) return \{ ok: true, already: true \}/);
  assert.match(m, /recoveryBodyVersion\(p\.rk\) !== 2\) return \{ ok: false, why: 'legacy' \}/);
  assert.match(m, /RECOVERY_MSG\(m, r\)[\s\S]*same\(signer, r\)/);
  assert.match(m, /adoptCheck\(\{ opened, main: m, localSeed: seed, localMv: mvOf\(m\)/);
  assert.ok(m.indexOf('if (!v.ok) return') < m.indexOf("[m]: 'main'"), 'nothing changes before the check passed');
  assert.ok(!/removedAddrs|splice|delete\(|addAccount/.test(m), 'adopting removes and adds no wallet');
  // mainProfile still seals a full union once seedSrc is 'main' (and only the restored set while 'rk1')
  const p = method('mainProfile');
  assert.match(p, /const walletsToSeal = rk1 \? backupWalletsOf\(m\)\.filter\(\(w\) => rk1Covered!\.has\(lc\(w\.address\)\)\) : backupWalletsOf\(m\);/);
  assert.match(p, /carry: \[\.\.\.fromServer, \.\.\.\(remoteCarry\.get\(m\) \|\| \[\]\)\]/, 'the server copy is carried (union)');
});

test('legacy-rk wiring: the backup state names the local-only wallets; mainStatus says where the seed came from', () => {
  assert.match(src, /const unbound = rk1Main \? \{ main: rk1Main, count:/);
  assert.match(src, /ok: true, wallets: keyed\.length, changedAt: meta\.changedAt \|\| 0, backedUpAt: meta\.backedUpAt \|\| 0, unbound,/);
  assert.match(src, /s\.unbound \? s\.unbound\.count \+ s\.unbound\.hops : -1\]\)/, 'a change of it is pushed to the page');
  assert.match(method('mainStatus'), /seedSrc: sd \? \(meta\.seedSrc\?\.\[m\] === 'rk1' \? 'rk1' : 'main'\) : null, ms:/);
});

test('legacy-rk wiring: every transfer between own wallets asks once more before it lands in a local-only wallet', () => {
  // + 1 (release 9): float.withdraw to one of the vault's own wallets (webEngine withdrawOk), the same check as transferToken
  assert.equal((src.match(/await unbackedOk\(/g) || []).length, 6, 'transfer, transferToken, distribute, consolidate, move, float.withdraw');
  for (const name of ['transfer', 'transferToken']) assert.match(method(name), /else \{ await gate\('transfer', auth\); await unbackedOk\(\[to\]\); \}/, name);
  assert.match(src, /async function unbackedOk\(tos: string\[\]\): Promise<void> \{\n  const m = meta\.main \? lc\(meta\.main\) : ''; if \(!m \|\| meta\.seedSrc\?\.\[m\] !== 'rk1'\) return;/, 'a no-op everywhere but an rk1 device');
  // never in the trade path (TRADE-CORE.md §5: no step between a click and the send)
  const i = src.indexOf('const verifyCache = new Map'), j = src.indexOf('const REASONS: Record<string, string>');
  assert.ok(i > 0 && j > i && !/unbackedOk|UNBACKED_SEND|uiLang/.test(src.slice(i, j)), 'not in the frozen trade region');
});

test('legacy-rk wiring: "Remove wallet" says what happens to the backup, in the page\'s language', () => {
  const m = method('remove');
  assert.match(m, /REMOVE_DIALOG\[uiLang\(\)\]/);
  assert.match(m, /inBackup\(list\[i\]\) && !unboundOf\(meta\.main \|\| ''\)\.some/);
  assert.ok(!/leaves your encrypted backup/.test(src), 'the old promise is gone from the engine');
  assert.match(src, /uiLang: async \(lang: string\) => \{ if \(typeof lang === 'string' && lang\) pageLang = rkLangOf\(lang\);/);
});
