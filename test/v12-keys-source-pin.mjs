// V12 batch-2 (recovery/keys) source pins. webEngine.ts drags in browser globals and cannot be imported in node, so
// each fix in the engine wiring is asserted against the source text — a later edit that silently drops one fails CI.
// Refs = motion-vault 2673f23. Run:  node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const eng = readFileSync(join(here, '..', 'src', 'webEngine.ts'), 'utf8');
const rec = readFileSync(join(here, '..', 'src', 'vaultRecovery.ts'), 'utf8');

test('F-23: import() parses once, is all-or-nothing, loops the parsed entries only', () => {
  assert.match(eng, /V12 F-23/);
  assert.match(eng, /const parsed = list\.map\(readKeyOrNull\);/);
  assert.match(eng, /if \(list\.length > 200\) throw new Error\('Import up to 200 wallets at once'\);/);
  assert.match(eng, /const bad = parsed\.findIndex\(\(e\) => !e\);/);
  assert.match(eng, /if \(bad >= 0\) throw new Error\(`Item \$\{bad \+ 1\} is not a private key`\);/);
  // readKeyOrNull shows a chain-only key under its native address
  assert.match(eng, /const address = nativeChainOf\(key\) \? nativeAddress\(key\) : privateKeyToAccount\(key as `0x\$\{string\}`\)\.address;/);
  // the old path (shown from valid-only, then loop over EVERY item) is gone
  assert.ok(!/const shown = \(Array\.isArray\(items\)/.test(eng), 'old valid-only "shown" dialog still present');
  assert.ok(!/for \(const it of items\) \{ const name = String\(it\.name/.test(eng), 'old loop over raw items still present');
});

test('F-34: page imports are via:page, excluded from ownAccounts, and carried as p:1', () => {
  assert.match(eng, /V12 F-34/);
  assert.match(eng, /const ownAccounts = \(\) => requireUnlocked\(\)\.filter\(\(a\) => !a\.ext && a\.via !== 'page' &&/);
  assert.match(eng, /await addAccount\(name, e\.key as `0x\$\{string\}`, \{ kind: 'imported', via: 'page' \}\);/);
  // the flag rides in the sealed v3 body and round-trips through backup/restore
  assert.match(rec, /if \(w\.via === 'page'\) body\.p = 1;/);
  assert.match(rec, /p\.p === 1 \? \{ via: 'page' as const \} : \{\}/);
  assert.match(eng, /a\.via === 'page' \? \{ via: 'page' as const \} : \{\}/);   // backupWalletsOf carries it out
});

test('F-28: sealRecovery binds to the main signature; outer rk stays {v:1}; openRecovery returns ms', () => {
  assert.match(rec, /V12 F-28/);
  assert.match(rec, /\{ v: 2; s: string; ms: string; mv: MainMsgVersion \}/);
  assert.match(rec, /const body: RecoveryBody = \{ v: 2, s: seed, ms: String\(mainSig\), mv: mv === 2 \? 2 : 1 \};/);
  assert.match(rec, /return \{ v: 1, addr: lc\(recovery\), iv: s\.iv, ct: s\.ct \};/);   // wire shape unchanged
  assert.match(rec, /if \(p && p\.v === 2 && \/\^0x\[0-9a-fA-F\]\{130\}\$\/\.test\(String\(p\.ms \|\| ''\)\)\) return \{ seed: s, ms: String\(p\.ms\), mv: p\.mv === 2 \? 2 : 1 \};/);
  assert.match(rec, /return \{ seed: s \};/);   // legacy v1 still opens
});

test('F-28: the main signature is stored at attach and used to bind later seals', () => {
  assert.match(eng, /const MS = \(m: string\): string => 'ms:' \+ lc\(m\);/);
  assert.match(eng, /async function mainSigFor\(m: string, provided\?: string\)/);
  // mainSigFor verifies BOTH that ms is the main's signature over its text and that it derives the seed
  assert.match(eng, /if \(!same\(signer, m\)\) throw new Error\('That is not this main wallet\\'s signature'\);/);
  assert.match(eng, /if \(await seedOfSignature\(sig\) !== seed\) throw new Error\('That main-wallet signature does not match this account'\);/);
  // mainAttach records the verified source and remembers the signature
  assert.match(eng, /seeds\[MS\(m\)\] = String\(src\.signature\);/);
  assert.match(eng, /meta\.seedSrc = \{ \.\.\.\(meta\.seedSrc \|\| \{\}\), \[m\]: 'main' \};/);
  // both seal callers pass the resolved (sig, mv) into sealRecovery
  assert.equal((eng.match(/await sealRecovery\(m(?:ain)?, r(?:q\.r)?, (?:String\(src\.signature\)|rq\.sig), seeds\[m(?:ain)?\], sig, mv\);/g) || []).length, 2);
});

test('F-28: a v2 recovery copy is re-verified at attach; a legacy copy is marked rk1', () => {
  assert.match(eng, /const opened = await openRecovery\(p\.rk, m, String\(src\.signature\)\);/);
  assert.match(eng, /if \(!same\(msSigner, m\)\) throw new Error\('The recovery copy is not bound to this main wallet'\);/);
  assert.match(eng, /if \(await seedOfSignature\(opened\.ms\) !== seed\) throw new Error\('The recovery copy does not match this main wallet'\);/);
  // verified -> seedSrc 'main' + remember ms; unverified legacy -> 'rk1' + record exactly what was restored
  assert.match(eng, /meta\.seedSrc = \{ \.\.\.\(meta\.seedSrc \|\| \{\}\), \[m\]: 'rk1' \};/);
  assert.match(eng, /meta\.rk1 = \{ \.\.\.\(meta\.rk1 \|\| \{\}\), \[m\]: \{ addrs: \[\.\.\.o\.wallets\.map\(\(w\) => lc\(w\.address\)\), \.\.\.v1\.map\(\(x\) => lc\(x\.address\)\)\], salts: o\.salts \} \};/);
});

test('F-28: an rk1 main seals only what it restored, and create() generates standalone keys off it', () => {
  // mainProfile narrows wallets + salts for an rk1 main
  assert.match(eng, /const rk1 = meta\.seedSrc\?\.\[m\] === 'rk1';/);
  assert.match(eng, /const walletsToSeal = rk1 \? backupWalletsOf\(m\)\.filter\(\(w\) => rk1Covered!\.has\(lc\(w\.address\)\)\) : backupWalletsOf\(m\);/);
  assert.match(eng, /const saltsToSeal = rk1 \? \(meta\.rk1\?\.\[m\]\?\.salts \|\| \[\]\) : saltsOf\(\);/);
  // create() derives the v2 path only when NOT rk1
  assert.match(eng, /if \(main && meta\.seedSrc\?\.\[main\] !== 'rk1'\) \{/);
});

test('F-20: both recovery dialogs show the full recovery wallet address before sealing', () => {
  assert.match(eng, /V12 F-20/);
  assert.equal((eng.match(/addrRows\(\[\{ name: 'Recovery wallet', address: r \}\]\)/g) || []).length, 2);
});

test('F-56: main* methods validate the address and read seeds by own-property', () => {
  assert.match(eng, /V12 F-56/);
  assert.match(eng, /const mainAddr = \(a: unknown\): string => \{ const m = lc\(a as string\); if \(!\/\^0x\[0-9a-f\]\{40\}\$\/\.test\(m\)\) throw new Error\('Bad main address'\); return m; \};/);
  assert.match(eng, /const hasOwn = \(o: object, k: string\): boolean => Object\.prototype\.hasOwnProperty\.call\(o, k\);/);
  assert.match(eng, /const seedOf = \(m: string\): string \| undefined => \(hasOwn\(seeds, m\) \? seeds\[m\] : undefined\);/);
  // every main* entry point that takes an address now goes through mainAddr()
  for (const re of [/mainStatus:[^\n]*mainAddr\(address\)/, /const m = mainAddr\(src\?\.address\);\s+\/\/ V12 F-56/, /const m = mainAddr\(src\?\.address\), r = lc\(src\?\.recovery\);\s+\/\/ V12 F-56/, /const m = mainAddr\(address\); const seed = seedOf\(m\)/]) assert.match(eng, re);
});

test('F-25: persistNow rechecks the stored value right before writing and retries', () => {
  assert.match(eng, /V12 F-25/);
  assert.match(eng, /async function persistNow\(retry = 0\)/);
  assert.match(eng, /const before = localStorage\.getItem\(VAULT_KEY\);/);
  assert.match(eng, /if \(!replacing && retry < 3 && localStorage\.getItem\(VAULT_KEY\) !== before\) return persistNow\(retry \+ 1\);/);
  // the retry-safe chaining wrapper (persistNow is no longer passed straight to .then)
  assert.match(eng, /persisting = persisting\.then\(\(\) => persistNow\(\), \(\) => persistNow\(\)\);/);
});
