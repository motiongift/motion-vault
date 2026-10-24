// V12 batch-2 (recovery/keys) behavior tests. These exercise the PURE module src/vaultRecovery.ts with real wallet
// signatures (viem), the same code the vault frame runs. webEngine.ts itself pulls in browser globals and cannot be
// imported in node, so its wiring is pinned in v12-keys-source-pin.mjs. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import {
  MAIN_MSG, RECOVERY_MSG, seedOfSignature, recoveryKeyV1, sealRecovery, openRecovery,
  buildProfile, openProfile, buf, b64,
} from '../src/vaultRecovery.ts';

// a Rabby-style main and a Privy-style recovery wallet, with the real signatures each produces over the fixed texts
async function setup(mv = 1) {
  const mainPk = generatePrivateKey(), recPk = generatePrivateKey();
  const mainAcct = privateKeyToAccount(mainPk), recAcct = privateKeyToAccount(recPk);
  const main = mainAcct.address.toLowerCase(), recovery = recAcct.address.toLowerCase();
  const mainSig = await mainAcct.signMessage({ message: MAIN_MSG(main, mv) });
  const seed = await seedOfSignature(mainSig);
  const recoverySig = await recAcct.signMessage({ message: RECOVERY_MSG(main, recovery) });
  return { main, recovery, mainSig, seed, recoverySig, mv };
}

test('F-28: a sealed recovery copy keeps the outer {v:1} wire shape (server unchanged)', async () => {
  const { main, recovery, mainSig, seed, recoverySig } = await setup(1);
  const rk = await sealRecovery(main, recovery, recoverySig, seed, mainSig, 1);
  assert.equal(rk.v, 1, 'outer version stays 1');
  assert.equal(rk.addr, recovery);
  assert.match(rk.iv, /^[A-Za-z0-9+/=]{16}$/);
  assert.match(rk.ct, /^[A-Za-z0-9+/=]{20,400}$/, 'ciphertext stays within the server-validated bound');
});

test('F-28: opening a v2 copy returns the seed AND the bound main signature, which re-verifies', async () => {
  const { main, recovery, mainSig, seed, recoverySig, mv } = await setup(1);
  const rk = await sealRecovery(main, recovery, recoverySig, seed, mainSig, mv);
  const opened = await openRecovery(rk, main, recoverySig);
  assert.ok(opened, 'opens');
  assert.equal(opened.seed, seed);
  assert.equal(opened.ms, mainSig);
  assert.equal(opened.mv, mv);
  // the exact two checks mainAttachRecovery runs: ms is the main's signature over its text AND it derives the seed
  const signer = await recoverMessageAddress({ message: MAIN_MSG(main, opened.mv), signature: opened.ms });
  assert.equal(signer.toLowerCase(), main);
  assert.equal(await seedOfSignature(opened.ms), opened.seed);
});

test('F-28: the mv=2 (motion) text round-trips', async () => {
  const { main, recovery, mainSig, seed, recoverySig } = await setup(2);
  const rk = await sealRecovery(main, recovery, recoverySig, seed, mainSig, 2);
  const opened = await openRecovery(rk, main, recoverySig);
  assert.equal(opened.mv, 2);
  const signer = await recoverMessageAddress({ message: MAIN_MSG(main, 2), signature: opened.ms });
  assert.equal(signer.toLowerCase(), main);
});

test('F-28: sealRecovery refuses to make an unbound copy (no / malformed main signature)', async () => {
  const { main, recovery, seed, recoverySig } = await setup(1);
  await assert.rejects(() => sealRecovery(main, recovery, recoverySig, seed, '', 1), /main-wallet signature/);
  await assert.rejects(() => sealRecovery(main, recovery, recoverySig, seed, '0xdeadbeef', 1), /main-wallet signature/);
});

test('F-28: a stolen seed with a FORGED ms fails the binding checks (attacker cannot plant it)', async () => {
  const { main, recovery, recoverySig } = await setup(1);
  // the attacker controls the recovery wallet and picks a seed it knows, but has no main signature; it forges ms with
  // its OWN wallet instead. The copy "opens" (recovery wallet is real) but the two checks a reader runs both reject it.
  const attackerPk = generatePrivateKey(), attacker = privateKeyToAccount(attackerPk);
  const attackerSeed = await seedOfSignature(await attacker.signMessage({ message: 'x' }));
  const forgedMs = await attacker.signMessage({ message: MAIN_MSG(main, 1) });   // attacker's sig, not the main's
  const rk = await sealRecovery(main, recovery, recoverySig, attackerSeed, forgedMs, 1);
  const opened = await openRecovery(rk, main, recoverySig);
  const signer = await recoverMessageAddress({ message: MAIN_MSG(main, opened.mv), signature: opened.ms });
  assert.notEqual(signer.toLowerCase(), main, 'forged ms does not recover to the main wallet -> mainAttachRecovery throws');
});

test('F-28: a legacy {v:1} body still opens, with no ms (caller treats the seed as rk1)', async () => {
  const { main, recovery, seed, recoverySig } = await setup(1);
  // build a pre-fix v1 blob by hand: {v:1,s} sealed under recoveryKeyV1 with the same AAD the module uses
  const key = await recoveryKeyV1(recoverySig);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buf(new TextEncoder().encode('motion/recovery/v1/' + main + '/' + recovery));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aad }, key, buf(new TextEncoder().encode(JSON.stringify({ v: 1, s: seed })))));
  const legacy = { v: 1, addr: recovery, iv: b64(iv), ct: b64(ct) };
  const opened = await openRecovery(legacy, main, recoverySig);
  assert.ok(opened, 'legacy copy still opens -> existing recovery users keep access');
  assert.equal(opened.seed, seed);
  assert.equal(opened.ms, undefined, 'no bound signature -> unverified');
});

test('F-34: a page-imported wallet (via:page) rides as p:1 and restores as via:page everywhere', async () => {
  const seed = await seedOfSignature(await privateKeyToAccount(generatePrivateKey()).signMessage({ message: 'seed' }));
  const main = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const pagePk = generatePrivateKey(), typedPk = generatePrivateKey();
  const pageAddr = privateKeyToAccount(pagePk).address, typedAddr = privateKeyToAccount(typedPk).address;
  const built = await buildProfile({ main, seed, count: 0, names: {}, wallets: [
    { address: pageAddr, name: 'from page', key: pagePk, kind: 'imported', via: 'page' },
    { address: typedAddr, name: 'typed', key: typedPk, kind: 'imported' },
  ], salts: [] });
  const opened = await openProfile(built.profile, seed, []);
  const page = opened.wallets.find((w) => w.address.toLowerCase() === pageAddr.toLowerCase());
  const typed = opened.wallets.find((w) => w.address.toLowerCase() === typedAddr.toLowerCase());
  assert.ok(page && typed, 'both wallets round-trip');
  assert.equal(page.via, 'page', 'page import stays via:page (excluded from ownAccounts on every device)');
  assert.equal(typed.via, undefined, 'a wallet typed in the frame is NOT marked via:page');
});
