// Account backup v4 (src/passkeyBackup.ts + the additive v4 paths of src/vaultRecovery.ts): key schedule, envelope, recovery
// code, multi-passkey, generations, upgrade / turn-off with the verification that gates the deletion of the old copy.
// PRF outputs are random 32-byte strings here (what an authenticator returns); the browser ceremonies run in
// scripts/passkey-e2e.mjs with a Chrome virtual authenticator. Run: node --test test/passkey-backup.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { MAIN_MSG, seedOfSignature, fingerprint, buildProfile, openProfile, backupKeyV3, bytesHex, SALT_SLOT } from '../src/vaultRecovery.ts';
import {
  normPk, isV4, newCore, addSlot, removeSlot, setCode, dkFromPrf, dkFromCode, checkDk, backupKeyV4, newRecoveryCode, parseRecoveryCode, CODE_BYTES,
  stageDigest, canon, createOptions, getOptions, readPrf, readAuthData, providerName, b64url, unb64url, rpIdFor, recoveryPaths,
  upgradeProfile, downgradeProfile, verifyStaged, PK_MAX_SLOTS,
} from '../src/passkeyBackup.ts';

const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const credId = () => b64url(rnd(32));
async function account(mv = 2) {
  const mainA = privateKeyToAccount(generatePrivateKey());
  const main = mainA.address.toLowerCase();
  const seed = await seedOfSignature(await mainA.signMessage({ message: MAIN_MSG(main, mv) }));
  return { main, seed, mv, fp: await fingerprint(seed) };
}
const wallet = (kind = 'created', extra = {}) => { const key = generatePrivateKey(); return { address: privateKeyToAccount(key).address, name: kind, key, kind, createdAt: 1_700_000_000_000, ...extra }; };
const salt = () => bytesHex(rnd(32));
// a live v3 profile as today's engine writes it
async function v3Profile(a, wallets, salts, extra = {}) {
  const r = await buildProfile({ main: a.main, seed: a.seed, count: 2, names: { 0: 'one', 1: 'two' }, wallets, salts, mv: a.mv });
  return { ...r.profile, ...extra };
}
// a full enrolment of one passkey, as the engine does it (minus the ceremony)
async function enrol(a, prf = rnd(32), id = credId()) {
  const { core, dk } = await newCore({ main: a.main, seed: a.seed, gen: 1 });
  const c1 = await addSlot(core, { main: a.main, dk, id, rp: 'vault.motion.gift', prf, name: 'iCloud Keychain', sync: true, at: 1 });
  return { pk: normPk({ v: 4, ...c1 }), dk, id, prf };
}

test('v4 key schedule: seed AND data key are both needed; kc tells the right data key from a wrong one', async () => {
  const a = await account();
  const { core, dk } = await newCore({ main: a.main, seed: a.seed, gen: 1 });
  assert.ok(await checkDk(core, a.seed, a.main, dk));
  assert.equal(await checkDk(core, a.seed, a.main, bytesHex(rnd(32))), null, 'another data key');
  const other = await account();
  assert.equal(await checkDk(core, other.seed, a.main, dk), null, 'another seed');
  assert.equal(await checkDk(core, a.seed, other.main, dk), null, 'another main (info binds the account)');
  const k1 = await backupKeyV4(a.seed, dk, core.salt, a.main), k2 = await backupKeyV4(a.seed, dk, core.salt, a.main);
  assert.equal(k1.kc, k2.kc, 'deterministic');
  await assert.rejects(backupKeyV4('0x12', dk, core.salt, a.main));
});

test('a passkey slot opens with its own PRF only: wrong PRF, missing PRF, another credential id, another account all fail', async () => {
  const a = await account();
  const { pk, dk, id, prf } = await enrol(a);
  assert.deepEqual(await dkFromPrf(pk, { main: a.main, id, prf }), { dk, gen: 1 });
  assert.equal(await dkFromPrf(pk, { main: a.main, id, prf: rnd(32) }), null, 'wrong PRF');
  assert.equal(await dkFromPrf(pk, { main: a.main, id, prf: null }), null, 'no PRF');
  assert.equal(await dkFromPrf(pk, { main: a.main, id, prf: prf.slice(0, 16) }), null, 'short PRF');
  assert.equal(await dkFromPrf(pk, { main: a.main, id: credId(), prf }), null, 'unknown credential');
  const b = await account();
  assert.equal(await dkFromPrf(pk, { main: b.main, id, prf }), null, 'slot bound to its account');
  // a slot moved under another credential id does not open (the id is in the KEK and the AAD)
  const id2 = credId(); const moved = { ...pk, slots: [{ ...pk.slots[0], id: id2 }] };
  assert.equal(await dkFromPrf(normPk(moved), { main: a.main, id: id2, prf }), null);
  // never enrol a passkey that returned no PRF
  const { core } = await newCore({ main: a.main, seed: a.seed, gen: 1 });
  await assert.rejects(addSlot(core, { main: a.main, dk, id: credId(), rp: 'vault.motion.gift', prf: null }), /PRF/);
});

test('several passkeys unwrap the SAME data key; removing one keeps the others; the last way in cannot be removed', async () => {
  const a = await account();
  const { pk, dk, id } = await enrol(a);
  const prf2 = rnd(32), id2 = credId();
  const c2 = await addSlot(pk, { main: a.main, dk, id: id2, rp: 'vault.motion.gift', prf: prf2, name: 'Google Password Manager', sync: true });
  const pk2 = normPk({ v: 4, ...c2 });
  assert.equal(pk2.slots.length, 2);
  assert.deepEqual(await dkFromPrf(pk2, { main: a.main, id: id2, prf: prf2 }), { dk, gen: 1 });
  await assert.rejects(addSlot(pk2, { main: a.main, dk, id: id2, rp: 'vault.motion.gift', prf: prf2 }), /already/);
  const pk3 = normPk({ v: 4, ...removeSlot(pk2, id) });
  assert.equal(pk3.slots.length, 1);
  assert.deepEqual(await dkFromPrf(pk3, { main: a.main, id: id2, prf: prf2 }), { dk, gen: 1 });
  assert.throws(() => removeSlot(pk3, id2), /only way/);
  // with a recovery code the last passkey may go (the code still opens)
  const code = await newRecoveryCode();
  const pk4 = normPk({ v: 4, ...(await setCode(pk3, { main: a.main, dk, code: code.bytes })) });
  const pk5 = normPk({ v: 4, ...removeSlot(pk4, id2) });
  assert.equal(pk5.slots.length, 0);
  assert.deepEqual(await dkFromCode(pk5, { main: a.main, code: code.bytes }), { dk, gen: 1 });
  // cap
  let c = (await newCore({ main: a.main, seed: a.seed, gen: 1, dk })).core;
  for (let i = 0; i < PK_MAX_SLOTS; i += 1) c = await addSlot(c, { main: a.main, dk, id: credId(), rp: 'vault.motion.gift', prf: rnd(32) });
  await assert.rejects(addSlot(c, { main: a.main, dk, id: credId(), rp: 'vault.motion.gift', prf: rnd(32) }), /At most/);
});

test('recovery code: 28 characters, typo-tolerant reading, a check that catches a wrong character, wrong code does not open', async () => {
  const a = await account();
  const code = await newRecoveryCode();
  assert.match(code.text, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(code.bytes.length, CODE_BYTES);
  assert.deepEqual(await parseRecoveryCode(code.text), code.bytes);
  assert.deepEqual(await parseRecoveryCode(code.text.toLowerCase().replace(/-/g, ' ')), code.bytes, 'lower case, spaces');
  assert.deepEqual(await parseRecoveryCode(code.text.replace(/0/g, 'O').replace(/1/g, 'I')), code.bytes, 'O/0 and I/1 confusions');
  const chars = code.text.replace(/-/g, '').split('');
  chars[3] = chars[3] === 'A' ? 'B' : 'A';
  assert.equal(await parseRecoveryCode(chars.join('')), 'check', 'one wrong character is caught');
  assert.equal(await parseRecoveryCode('hello'), null);
  const { pk, dk } = await enrol(a);
  const withCode = normPk({ v: 4, ...(await setCode(pk, { main: a.main, dk, code: code.bytes })) });
  assert.deepEqual(await dkFromCode(withCode, { main: a.main, code: code.bytes }), { dk, gen: 1 });
  assert.equal(await dkFromCode(withCode, { main: a.main, code: (await newRecoveryCode()).bytes }), null);
  assert.equal(await dkFromCode(pk, { main: a.main, code: code.bytes }), null, 'no code slot');
});

test('envelope validation: the shape the server keeps; refuses broken, empty, oversized or mis-ordered generations', async () => {
  const a = await account();
  const { pk } = await enrol(a);
  assert.deepEqual(normPk(JSON.parse(JSON.stringify(pk))), pk, 'stable through JSON');
  assert.equal(JSON.stringify(normPk(pk)), JSON.stringify(pk), 'same field order (the read-back compares JSON)');
  assert.ok(isV4({ pk }) && !isV4({}) && !isV4(null));
  assert.equal(normPk({ ...pk, v: 3 }), null);
  assert.equal(normPk({ ...pk, slots: [] }), null, 'no way in');
  assert.equal(normPk({ ...pk, kc: 'zz' }), null);
  assert.equal(normPk({ ...pk, salt: 'abc' }), null);
  assert.equal(normPk({ ...pk, slots: [{ ...pk.slots[0], id: 'short' }] }), null);
  assert.equal(normPk({ ...pk, slots: [pk.slots[0], pk.slots[0]] }), null, 'duplicate credential');
  assert.equal(normPk({ ...pk, prev: [{ ...pk, gen: 1 }] }), null, 'a previous generation must be older');
  assert.equal(normPk({ ...pk, slots: [{ ...pk.slots[0], name: 'a\u0000b'.repeat(30) }] }).slots[0].name.length, 40);
});

test('generations: a start-over keeps the old envelope; an old passkey still opens the old generation', async () => {
  const a = await account();
  const { pk, dk, id, prf } = await enrol(a);
  const fresh = await newCore({ main: a.main, seed: a.seed, gen: 2 });
  const id2 = credId(), prf2 = rnd(32);
  const c2 = await addSlot(fresh.core, { main: a.main, dk: fresh.dk, id: id2, rp: 'vault.motion.gift', prf: prf2 });
  const { v: _v, prev: _p, ...oldCore } = pk;
  const pk2 = normPk({ v: 4, ...c2, prev: [oldCore] });
  assert.ok(pk2 && pk2.prev.length === 1);
  assert.deepEqual(await dkFromPrf(pk2, { main: a.main, id, prf }), { dk, gen: 1 });
  assert.deepEqual(await dkFromPrf(pk2, { main: a.main, id: id2, prf: prf2 }), { dk: fresh.dk, gen: 2 });
  // getOptions asks every slot with its own generation's salt
  const opts = getOptions({ rpId: 'vault.motion.gift', pk: pk2 });
  assert.equal(opts.allowCredentials.length, 2);
  assert.deepEqual(Object.keys(opts.extensions.prf.evalByCredential).sort(), [id, id2].sort());
  assert.notDeepEqual(new Uint8Array(opts.extensions.prf.evalByCredential[id].first), new Uint8Array(opts.extensions.prf.evalByCredential[id2].first));
  assert.equal(getOptions({ rpId: 'vault.other.example', pk: pk2 }).allowCredentials.length, 0, 'another RP ID asks nothing');
});

test('backup v4 entries: open only with K4 (never with the seed alone); v3 readers carry them verbatim', async () => {
  const a = await account();
  const { pk, dk } = await enrol(a);
  const key = await checkDk(pk, a.seed, a.main, dk);
  const ws = [wallet('created'), wallet('imported', { via: 'page' }), wallet('derived', { main: a.main, index: 3, gen: 2 }), wallet('hop')];
  const s1 = salt();
  const r = await buildProfile({ main: a.main, seed: a.seed, count: 1, names: {}, wallets: ws, salts: [s1], mv: 2, v4: { key } });
  const p = { ...r.profile, pk };
  const seedOnly = await openProfile(p, a.seed, []);
  assert.equal(seedOnly.wallets.length, 0, 'the seed alone opens no v4 entry');
  assert.equal(seedOnly.salts.length, 0, 'nor its salt');
  assert.equal(seedOnly.unopened.length, ws.length + 1, 'all carried verbatim');
  const o = await openProfile(p, a.seed, [], [key]);
  assert.equal(o.wallets.length, ws.length);
  assert.ok(o.wallets.every((w) => w.v === 4));
  assert.deepEqual(o.salts, [s1]); assert.deepEqual(o.saltsV4, [s1]);
  assert.equal(o.wallets.find((w) => w.kind === 'imported').via, 'page', 'body flags survive');
  assert.equal(o.wallets.find((w) => w.kind === 'derived').gen, 2);
  // a v3 key never opens a v4 entry even with the right AAD swapped in (different key) — and K4 never opens a v3 entry as v4
  const v3 = await buildProfile({ main: a.main, seed: a.seed, count: 0, names: {}, wallets: ws.slice(0, 1), salts: [], mv: 2 });
  const mixed = await openProfile(v3.profile, a.seed, [], [key]);
  assert.equal(mixed.wallets[0].v, 3);
  // v3 build/open unchanged when no v4 key is passed
  assert.equal((await openProfile(v3.profile, a.seed)).wallets[0].v, 3);
  assert.ok(await backupKeyV3(a.seed));
});

test('upgrade: re-seals every wallet and salt the live v3 copy holds (also ones this device never restored), carries rk/uc and foreign entries', async () => {
  const a = await account();
  const here = [wallet('created')], elsewhere = [wallet('imported'), wallet('derived', { main: a.main, index: 0, gen: 2 })];
  const s1 = salt(), s2 = salt();
  const foreign = { address: privateKeyToAccount(generatePrivateKey()).address, name: 'x', iv: 'AAAAAAAAAAAAAAAA', ct: 'B'.repeat(64) };
  const rk = { v: 1, addr: '0x' + '1'.repeat(40), iv: 'AAAAAAAAAAAAAAAA', ct: 'C'.repeat(128) };
  const uc = { v: 1, n: 3, o: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'D'.repeat(64) };
  const liveB = await buildProfile({ main: a.main, seed: a.seed, count: 2, names: { 0: 'one' }, wallets: [...here, ...elsewhere], salts: [s1, s2], carry: [foreign], mv: 2 });
  const live = { ...liveB.profile, rk, uc };
  const { pk, dk, id, prf } = await enrol(a);
  const t0 = performance.now();
  const up = await upgradeProfile({ live, main: a.main, seed: a.seed, mv: 2, count: 0, names: {}, wallets: here, salts: [s1], pk, dk });
  const tUp = performance.now() - t0;
  assert.equal(up.addresses.length, 3);
  assert.deepEqual(up.profile.rk, rk); assert.deepEqual(up.profile.uc, uc); assert.deepEqual(up.profile.pk, pk);
  assert.equal(up.profile.count, 2); assert.equal(up.profile.mv, 2); assert.equal(up.profile.fp, a.fp);
  // the server hands it back through JSON; a FRESH ceremony gives the PRF again → DK → K4
  const staged = JSON.parse(JSON.stringify(up.profile));
  const t1 = performance.now();
  const again = await dkFromPrf(normPk(staged.pk), { main: a.main, id, prf });
  const k = await checkDk(normPk(staged.pk), a.seed, a.main, again.dk);
  const v = await verifyStaged({ mode: 'up', staged, live, main: a.main, seed: a.seed, stagedKeys: [k] });
  const tVerify = performance.now() - t1;
  assert.deepEqual(v, { ok: true, wallets: 3, salts: 2 });
  assert.equal((await openProfile(staged, a.seed)).wallets.length, 0, 'nothing of the staged copy opens with the seed alone');
  console.log(`   timing: upgrade seal ${tUp.toFixed(1)} ms, unwrap+verify ${tVerify.toFixed(1)} ms (3 wallets, 2 salts, node)`);
});

test('verify refuses: wrong key, a dropped wallet, a dropped salt, a leftover v3 entry, a planted entry, another seed, changed rk', async () => {
  const a = await account();
  const ws = [wallet('created'), wallet('imported')], s1 = salt();
  const live = await v3Profile(a, ws, [s1]);
  const { pk, dk } = await enrol(a);
  const key = await checkDk(pk, a.seed, a.main, dk);
  const up = (await upgradeProfile({ live, main: a.main, seed: a.seed, mv: 2, count: 0, names: {}, wallets: [], salts: [], pk, dk })).profile;
  const vfy = (staged, keys = [key], l = live) => verifyStaged({ mode: 'up', staged, live: l, main: a.main, seed: a.seed, stagedKeys: keys });
  assert.equal((await vfy(up)).ok, true);
  // a key from a different PRF (a ceremony that answered differently): nothing opens → the live wallets are missing
  const wrong = (await newCore({ main: a.main, seed: a.seed, gen: 1, salt: pk.salt })).key;
  assert.equal((await vfy(up, [wrong])).why, 'missing-wallet');
  // a dropped wallet
  assert.equal((await vfy({ ...up, attached: up.attached.filter((e) => e.address !== ws[1].address) })).why, 'missing-wallet');
  // a dropped salt
  assert.equal((await vfy({ ...up, attached: up.attached.filter((e) => e.address !== SALT_SLOT(0)) })).why, 'missing-salt');
  // an entry left in v3 (opens with the seed alone)
  const v3e = live.attached.find((e) => e.address === ws[0].address);
  assert.equal((await vfy({ ...up, attached: up.attached.map((e) => (e.address === ws[0].address ? v3e : e)) })).why, 'format');
  // a planted entry that nothing here opens and the live copy did not have
  const planted = { address: privateKeyToAccount(generatePrivateKey()).address, name: 'p', iv: 'AAAAAAAAAAAAAAAA', ct: 'E'.repeat(64) };
  assert.equal((await vfy({ ...up, attached: [...up.attached, planted] })).why, 'foreign-entry');
  // another seed
  const b = await account();
  assert.equal((await verifyStaged({ mode: 'up', staged: up, live, main: a.main, seed: b.seed, stagedKeys: [key] })).why, 'fp');
  // rk changed on the way
  assert.equal((await vfy({ ...up, rk: { v: 1, addr: '0x' + '2'.repeat(40), iv: 'AAAAAAAAAAAAAAAA', ct: 'F'.repeat(128) } })).why, 'records');
  // no envelope
  const { pk: _pk, ...noPk } = up;
  assert.equal((await vfy(noPk)).why, 'envelope');
  // a count that went down
  assert.equal((await vfy({ ...up, count: 0 })).why, 'count');
});

test('turn passkey protection off: re-seals as v3 under the seed; verify needs every v4 wallet in v3 form; refuses without the passkey', async () => {
  const a = await account();
  const ws = [wallet('created'), wallet('derived', { main: a.main, index: 1, gen: 2 })], s1 = salt();
  const { pk, dk } = await enrol(a);
  const key = await checkDk(pk, a.seed, a.main, dk);
  const live = { ...(await buildProfile({ main: a.main, seed: a.seed, count: 1, names: {}, wallets: ws, salts: [s1], mv: 2, v4: { key } })).profile, pk };
  await assert.rejects(downgradeProfile({ live, main: a.main, seed: a.seed, mv: 2, count: 0, names: {}, wallets: [], salts: [] }), /unlocked/);
  const off = (await downgradeProfile({ live, main: a.main, seed: a.seed, mv: 2, count: 0, names: {}, wallets: [], salts: [], liveKeys: [key] })).profile;
  assert.equal(off.pk, undefined);
  const staged = JSON.parse(JSON.stringify(off));
  assert.deepEqual(await verifyStaged({ mode: 'off', staged, live, main: a.main, seed: a.seed, stagedKeys: [], liveKeys: [key] }), { ok: true, wallets: 2, salts: 1 });
  assert.equal((await openProfile(staged, a.seed)).wallets.length, 2, 'the seed alone opens it again (that is what off means)');
  // a staged "off" copy that still carries v4 entries is refused
  assert.equal((await verifyStaged({ mode: 'off', staged: { ...live, pk: undefined }, live, main: a.main, seed: a.seed, stagedKeys: [], liveKeys: [key] })).why, 'missing-wallet');
});

test('stage digest: canonical (key order, bookkeeping fields ignored); any change of a blob changes it', async () => {
  const a = await account();
  const p = await v3Profile(a, [wallet()], []);
  const d = await stageDigest(p);
  const shuffled = Object.fromEntries(Object.entries(p).reverse());
  assert.equal(await stageDigest(shuffled), d);
  assert.equal(await stageDigest({ ...p, user: 'did:privy:x', version: 9, updatedAt: 1, createdAt: 2 }), d);
  assert.notEqual(await stageDigest({ ...p, attached: [{ ...p.attached[0], ct: p.attached[0].ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }] }), d);
  assert.equal(canon({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

test('WebAuthn options and readers: RP ID is the vault host; UV required; PRF requested at create; results parsed defensively', () => {
  assert.equal(rpIdFor('vault.motion.gift'), 'vault.motion.gift');
  assert.equal(rpIdFor('motion.gift'), 'vault.motion.gift');
  assert.equal(rpIdFor('vault.motion.test'), 'vault.motion.test');
  const s = rnd(32), ex = credId();
  const c = createOptions({ rpId: 'vault.motion.gift', main: '0x' + 'ab'.repeat(20), salt: s, exclude: [ex] });
  assert.equal(c.rp.id, 'vault.motion.gift');
  assert.equal(c.authenticatorSelection.userVerification, 'required');
  assert.equal(c.authenticatorSelection.residentKey, 'required');
  assert.deepEqual(new Uint8Array(c.extensions.prf.eval.first), s);
  assert.deepEqual(new Uint8Array(c.excludeCredentials[0].id), unb64url(ex));
  assert.equal(c.user.id.byteLength, 16);
  assert.notDeepEqual(new Uint8Array(createOptions({ rpId: 'x', main: '0x' + 'ab'.repeat(20), salt: s, exclude: [] }).user.id), new Uint8Array(c.user.id), 'a fresh user handle each time');
  const raw = rnd(32), prf = rnd(32);
  const got = readPrf({ rawId: raw.buffer, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prf.buffer } } }) });
  assert.equal(got.id, b64url(raw)); assert.deepEqual(got.prf, prf); assert.equal(got.enabled, true);
  assert.deepEqual(readPrf({ rawId: raw.buffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }), { id: b64url(raw), prf: null, enabled: true }, 'enabled, results only on get');
  assert.deepEqual(readPrf({ rawId: raw.buffer, getClientExtensionResults: () => ({}) }), { id: b64url(raw), prf: null, enabled: null }, 'no PRF support');
  assert.equal(readPrf({ rawId: raw.buffer, getClientExtensionResults: () => ({ prf: { results: { first: rnd(16).buffer } } }) }).prf, null, 'wrong length');
  assert.equal(readPrf({ rawId: raw.buffer, getClientExtensionResults: () => { throw new Error('x'); } }).prf, null);
  assert.equal(readPrf(null).id, '');
  // authenticator data: rpIdHash(32) flags(1) count(4) aaguid(16)…
  const ad = new Uint8Array(37 + 16 + 2); ad[32] = 0x45 | 0x08; ad.set([0xfb, 0xfc, 0x30, 0x07, 0x15, 0x4e, 0x4e, 0xcc, 0x8c, 0x0b, 0x6e, 0x02, 0x05, 0x57, 0xd7, 0xbd], 37);
  const r = readAuthData({ rawId: raw.buffer, response: { getAuthenticatorData: () => ad.buffer } });
  assert.deepEqual(r, { aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd', sync: true });
  assert.equal(providerName(r.aaguid, r.sync), 'iCloud Keychain');
  assert.equal(providerName('', false), 'Security key');
  assert.deepEqual(readAuthData({ response: {} }), { aaguid: '', sync: null });
});

test('recovery matrix line: one way in warns; two passkeys or a passkey + code do not; device-bound only warns', async () => {
  const a = await account();
  const { pk, dk } = await enrol(a);
  assert.match(recoveryPaths(pk, { dkCached: true }).warn, /Only one way/);
  const withCode = normPk({ v: 4, ...(await setCode(pk, { main: a.main, dk, code: (await newRecoveryCode()).bytes })) });
  assert.equal(recoveryPaths(withCode, { dkCached: false }).warn, '');
  const bound = normPk({ ...pk, slots: [{ ...pk.slots[0], sync: false }, { ...pk.slots[0], id: credId(), sync: false }] });
  assert.match(recoveryPaths(bound, { dkCached: false }).warn, /syncs/);
  assert.equal(recoveryPaths(null, { dkCached: false }).passkeys, 0);
});
