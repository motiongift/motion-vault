// Account backup v4: a PASSKEY as the second factor on the backup key (2026-10-30, owner: “approved, let the agents build all of it”).
//
// Backup v3 (vaultRecovery.ts backupKeyV3) seals every wallet key and the gen-2 salts under a key from the main wallet's
// signature alone: whoever holds the account's Privy session (email / Google login, a stolen browser session, a script on
// motion.gift — the Privy island signs MAIN_MSG silently) gets the signature, reads the profile and opens every wallet.
// v4 adds a factor that none of those hold: the WebAuthn PRF output of a passkey whose RP ID is the VAULT origin
// (vault.motion.gift). The page's origin (motion.gift) cannot exercise that credential at all, and the vault frame
// evaluates it only on a trusted click in its own dialog; the PRF output never leaves the frame.
//
// Key schedule (all HKDF-SHA-256, all AES-256-GCM; `main` lower-case, `salt` = pk.salt, 32 random bytes, public):
//   DK            32 random bytes per generation (pk.gen); the backup's data key. Never stored in the clear outside the vault.
//   K4            = HKDF(ikm = seed ‖ DK, salt, info 'motion/backup/v4/key/' + main)        — seals the profile entries
//   kc            = HMAC(K4raw, 'motion/backup/v4/check')[0..8] hex                        — "is this DK the right one"
//   PRF_i         = WebAuthn prf.eval(first = salt) of passkey i (the authenticator's HMAC; browser-domain-separated)
//   KEK_i         = HKDF(ikm = PRF_i, salt, info 'motion/backup/v4/kek/' + main + '/' + credId)
//   slot_i        = AES-GCM(KEK_i, DK, aad 'motion/backup/v4/slot/' + main + '/' + credId + '/' + gen)
//   KEK_rc        = HKDF(ikm = recovery-code bytes, salt, info 'motion/backup/v4/kek/rc/' + main)  (optional, shown once)
// So opening the backup needs the seed (one main-wallet signature, as before) AND one of: a passkey's PRF, the recovery
// code, or a device that already unwrapped DK (cached in its own encrypted vault, like the seed itself). The server holds
// salt, kc, the wrapped slots and the sealed entries — none of which opens anything without both factors.
//
// Why a data key instead of HKDF(seed ‖ PRF) directly: several passkeys per account (a second one as a spare) and a
// recovery code each unwrap the SAME DK, so adding or removing one never re-seals the entries, and an entry another device
// sealed stays openable. DK alone opens nothing either (K4 also needs the seed).
//
// Generations: a "start over" (every factor lost; the wallets come back from a backup file) mints a new DK under gen + 1
// and keeps the previous envelope core in pk.prev (at most 2), so entries sealed under the old DK — carried verbatim by
// every publish — still open if the old passkey or code turns up later.
//
// Pure module: no DOM, no storage, no network. webEngine.ts runs the WebAuthn ceremonies inside the vault frame's dialog
// and hands the PRF bytes in here; test/passkey-backup.mjs runs all of it in node.
import { hmac, hexBytes, bytesHex, b64, unb64, buf, fingerprint, openProfile, buildProfile, type Profile, type BackupWallet, type MainMsgVersion } from './vaultRecovery.ts';

const enc = new TextEncoder();
const lc = (a?: string) => String(a || '').toLowerCase();
const subtle = () => globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ── wire shapes (the server's validPk in trench server/account-passkey.mjs keeps exactly these fields) ──
// slot: id = the credential id (base64url), rp = the RP ID it was created for, name = a label for the list ("iCloud Keychain"),
// aaguid = the provider's id when the authenticator said it, sync = backup-eligible (a synced passkey), at = when it was added.
export type PkSlot = { id: string; rp: string; iv: string; ct: string; at: number; name: string; aaguid?: string; sync?: boolean };
export type PkCode = { iv: string; ct: string; at: number };
export type PkCore = { gen: number; salt: string; kc: string; slots: PkSlot[]; rc?: PkCode | null };
export type PkEnvelope = PkCore & { v: 4; prev?: PkCore[] };
export const PK_MAX_SLOTS = 10;
// Defaults the owner may flip (2026-10-30, pending his decision). codeAtEnrol: a recovery code is drawn and shown once in the
// vault's own dialog during enrolment. requireSaved: enrolment completes only after the user confirms the code is saved — or,
// when the code is skipped, only if a backup file written after the last wallet exists. offerNative: the app's native vault
// (no PRF path yet) is not offered v4; it keeps v3 and the file-only mode.
export const PASSKEY_POLICY = Object.freeze({ codeAtEnrol: true, requireSaved: true, offerNative: false });
export const PK_MAX_PREV = 2;

const B64 = /^[A-Za-z0-9+/=]+$/, B64U = /^[A-Za-z0-9_-]+$/;
const validCode = (c: unknown): c is PkCode => !!c && typeof c === 'object' && B64.test(String((c as PkCode).iv || '')) && String((c as PkCode).iv).length === 16
  && B64.test(String((c as PkCode).ct || '')) && String((c as PkCode).ct).length >= 40 && String((c as PkCode).ct).length <= 128 && Number.isSafeInteger((c as PkCode).at) && (c as PkCode).at >= 0;
const normSlot = (s: unknown): PkSlot | null => {
  if (!s || typeof s !== 'object') return null;
  const x = s as PkSlot;
  const id = String(x.id || ''), rp = lc(x.rp), iv = String(x.iv || ''), ct = String(x.ct || '');
  if (!B64U.test(id) || id.length < 16 || id.length > 256) return null;
  if (!/^[a-z0-9.-]{1,253}$/.test(rp)) return null;
  if (!B64.test(iv) || iv.length !== 16 || !B64.test(ct) || ct.length < 40 || ct.length > 128) return null;
  if (!Number.isSafeInteger(x.at) || x.at < 0) return null;
  const out: PkSlot = { id, rp, iv, ct, at: x.at, name: String(x.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40) };
  if (x.aaguid !== undefined) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(x.aaguid))) return null; out.aaguid = String(x.aaguid); }
  if (x.sync !== undefined) out.sync = !!x.sync;
  return out;
};
const normCore = (c: unknown): PkCore | null => {
  if (!c || typeof c !== 'object') return null;
  const x = c as PkCore;
  if (!Number.isSafeInteger(x.gen) || x.gen < 1 || x.gen > 1_000_000) return null;
  const salt = String(x.salt || ''); if (!B64.test(salt) || salt.length !== 44) return null;
  const kc = String(x.kc || ''); if (!/^[0-9a-f]{16}$/.test(kc)) return null;
  if (!Array.isArray(x.slots) || x.slots.length > PK_MAX_SLOTS) return null;
  const slots: PkSlot[] = [];
  for (const s of x.slots) { const n = normSlot(s); if (!n || slots.some((o) => o.id === n.id)) return null; slots.push(n); }
  let rc: PkCode | null | undefined;
  if (x.rc === null || x.rc === undefined) rc = x.rc === null ? null : undefined;
  else { if (!validCode(x.rc)) return null; rc = { iv: String(x.rc.iv), ct: String(x.rc.ct), at: x.rc.at }; }
  // an envelope that nothing can open (no passkey, no code) is never written: it would lock the account out
  if (!slots.length && !rc) return null;
  return { gen: x.gen, salt, kc, slots, ...(rc ? { rc } : {}) };
};
// The envelope exactly as the server stores it (same field order on both sides: the read-back compares JSON).
export function normPk(pk: unknown): PkEnvelope | null {
  if (!pk || typeof pk !== 'object' || (pk as PkEnvelope).v !== 4) return null;
  const core = normCore(pk); if (!core) return null;
  const prevIn = (pk as PkEnvelope).prev;
  let prev: PkCore[] | undefined;
  if (prevIn !== undefined) {
    if (!Array.isArray(prevIn) || prevIn.length > PK_MAX_PREV) return null;
    prev = [];
    for (const p of prevIn) { const n = normCore(p); if (!n || n.gen >= core.gen) return null; prev.push(n); }
  }
  return { v: 4, ...core, ...(prev && prev.length ? { prev } : {}) };
}
export const isV4 = (profile: unknown): boolean => !!normPk((profile as { pk?: unknown } | null)?.pk);
// every generation of an envelope, current first
export const coresOf = (pk: PkEnvelope): PkCore[] => [pk, ...(pk.prev || [])];

// ── the key schedule ──
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bits = 256): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(enc.encode(info)) }, k, bits));
}
const aes = (raw: Uint8Array) => subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const isHex32 = (h: string) => /^0x[0-9a-f]{64}$/.test(String(h || ''));
export const newDataKey = (): string => bytesHex(rand(32));
export const newPkSalt = (): string => b64(rand(32));

// K4 and its check value. The raw bits never leave this function.
export async function backupKeyV4(seed: string, dk: string, salt: string, main: string): Promise<{ key: CryptoKey; kc: string }> {
  if (!isHex32(seed) || !isHex32(dk)) throw new Error('backup v4 needs a seed and a data key');
  const ikm = new Uint8Array(64); ikm.set(hexBytes(seed), 0); ikm.set(hexBytes(dk), 32);
  const raw = await hkdf(ikm, unb64(salt), 'motion/backup/v4/key/' + lc(main));
  const kc = bytesHex(await hmac(bytesHex(raw), 'motion/backup/v4/check')).slice(2, 18);
  const key = await aes(raw); raw.fill(0); ikm.fill(0);
  return { key, kc };
}
export async function checkDk(core: PkCore, seed: string, main: string, dk: string): Promise<CryptoKey | null> {
  try { const k = await backupKeyV4(seed, dk, core.salt, main); return k.kc === core.kc ? k.key : null; } catch { return null; }
}
const slotAad = (main: string, id: string, gen: number) => buf(enc.encode(`motion/backup/v4/slot/${lc(main)}/${id}/${gen}`));
const codeAad = (main: string, gen: number) => buf(enc.encode(`motion/backup/v4/rc/${lc(main)}/${gen}`));
const kekOfPrf = async (prf: Uint8Array, salt: string, main: string, id: string) => aes(await hkdf(prf, unb64(salt), `motion/backup/v4/kek/${lc(main)}/${id}`));
const kekOfCode = async (code: Uint8Array, salt: string, main: string) => aes(await hkdf(code, unb64(salt), `motion/backup/v4/kek/rc/${lc(main)}`));
async function wrap(kek: CryptoKey, aad: ArrayBuffer, dk: string): Promise<{ iv: string; ct: string }> {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aad }, kek, buf(hexBytes(dk))));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unwrap(kek: CryptoKey, aad: ArrayBuffer, w: { iv: string; ct: string }): Promise<string | null> {
  try { const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(w.iv)), additionalData: aad }, kek, buf(unb64(w.ct)))); return pt.length === 32 ? bytesHex(pt) : null; } catch { return null; }
}
const validPrf = (prf: unknown): prf is Uint8Array => prf instanceof Uint8Array && prf.length === 32;

// A fresh generation: new DK, new salt, its check value; no slot yet (addSlot / setCode before it is written).
export async function newCore(src: { main: string; seed: string; gen: number; dk?: string; salt?: string }): Promise<{ core: PkCore; dk: string; key: CryptoKey }> {
  const dk = src.dk || newDataKey(), salt = src.salt || newPkSalt();
  const { key, kc } = await backupKeyV4(src.seed, dk, salt, src.main);
  return { core: { gen: src.gen, salt, kc, slots: [] }, dk, key };
}
export async function addSlot(core: PkCore, src: { main: string; dk: string; id: string; rp: string; prf: Uint8Array; name?: string; aaguid?: string; sync?: boolean; at?: number }): Promise<PkCore> {
  if (!validPrf(src.prf)) throw new Error('This passkey did not return its secret (PRF) — it cannot protect a backup');
  if (core.slots.some((s) => s.id === src.id)) throw new Error('This passkey already protects your backup');
  if (core.slots.length >= PK_MAX_SLOTS) throw new Error(`At most ${PK_MAX_SLOTS} passkeys per account`);
  const w = await wrap(await kekOfPrf(src.prf, core.salt, src.main, src.id), slotAad(src.main, src.id, core.gen), src.dk);
  const slot = normSlot({ id: src.id, rp: src.rp, ...w, at: Math.floor(src.at ?? Date.now()), name: src.name || 'Passkey', ...(src.aaguid ? { aaguid: src.aaguid } : {}), ...(src.sync !== undefined ? { sync: src.sync } : {}) });
  if (!slot) throw new Error('That passkey cannot be stored (bad credential id)');
  return { ...core, slots: [...core.slots, slot] };
}
export const removeSlot = (core: PkCore, id: string): PkCore => {
  const slots = core.slots.filter((s) => s.id !== id);
  if (slots.length === core.slots.length) throw new Error('No such passkey on this backup');
  if (!slots.length && !core.rc) throw new Error('This is the only way into your backup — add another passkey or a recovery code first');
  return { ...core, slots };
};
export async function setCode(core: PkCore, src: { main: string; dk: string; code: Uint8Array; at?: number }): Promise<PkCore> {
  if (!(src.code instanceof Uint8Array) || src.code.length !== CODE_BYTES) throw new Error('bad recovery code');
  const w = await wrap(await kekOfCode(src.code, core.salt, src.main), codeAad(src.main, core.gen), src.dk);
  return { ...core, rc: { ...w, at: Math.floor(src.at ?? Date.now()) } };
}
// DK from a passkey's PRF output: the slot with that credential id, in any generation (the caller checks it with kc).
export async function dkFromPrf(pk: PkEnvelope, src: { main: string; id: string; prf: Uint8Array }): Promise<{ dk: string; gen: number } | null> {
  if (!validPrf(src.prf)) return null;
  for (const c of coresOf(pk)) {
    const s = c.slots.find((x) => x.id === src.id); if (!s) continue;
    const dk = await unwrap(await kekOfPrf(src.prf, c.salt, src.main, s.id), slotAad(src.main, s.id, c.gen), s);
    if (dk) return { dk, gen: c.gen };
  }
  return null;
}
export async function dkFromCode(pk: PkEnvelope, src: { main: string; code: Uint8Array }): Promise<{ dk: string; gen: number } | null> {
  for (const c of coresOf(pk)) {
    if (!c.rc) continue;
    const dk = await unwrap(await kekOfCode(src.code, c.salt, src.main), codeAad(src.main, c.gen), c.rc);
    if (dk) return { dk, gen: c.gen };
  }
  return null;
}
// The PRF input for a generation's salt (the WebAuthn extension takes a BufferSource; the browser hashes it with its own
// "WebAuthn PRF\0" context before the authenticator sees it, so this input never collides with any other site's).
export const prfInput = (core: PkCore): Uint8Array => unb64(core.salt);

// ── the recovery code: 120 random bits, Crockford base32, + 20 check bits; shown once, typed into the vault's own dialog ──
// XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (28 characters; O→0, I/L→1, U→V and any case are accepted when typed back)
export const CODE_BYTES = 15;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const toB32 = (u: Uint8Array) => { let bits = 0, val = 0, out = ''; for (const b of u) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += CROCK[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += CROCK[(val << (5 - bits)) & 31]; return out; };
const fromB32 = (s: string): Uint8Array | null => { let bits = 0, val = 0; const out: number[] = []; for (const ch of s) { const i = CROCK.indexOf(ch); if (i < 0) return null; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Uint8Array.from(out); };
async function codeCheck(u: Uint8Array): Promise<string> { const h = new Uint8Array(await subtle().digest('SHA-256', buf(u))); return toB32(h.slice(0, 3)).slice(0, 4); }
export async function newRecoveryCode(): Promise<{ text: string; bytes: Uint8Array }> {
  const bytes = rand(CODE_BYTES);
  const body = toB32(bytes) + await codeCheck(bytes);   // 24 + 4
  return { text: body.match(/.{4}/g)!.join('-'), bytes };
}
// null = not a code at all; 'check' = the right length but a typo somewhere (the dialog says so before anything is tried)
export async function parseRecoveryCode(input: string): Promise<Uint8Array | 'check' | null> {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(s)) return null;
  const bytes = fromB32(s.slice(0, 24)); if (!bytes || bytes.length !== CODE_BYTES) return null;
  return (await codeCheck(bytes)) === s.slice(24) ? bytes : 'check';
}

// ── the staged-upgrade digest: the same canonical form the server hashes (trench server/account-passkey.mjs canon) ──
export const canon = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
};
export async function stageDigest(profile: unknown): Promise<string> {
  // only what the server keeps of a profile: its bookkeeping (user, version, times) is not part of what was verified
  const { user: _u, version: _v, updatedAt: _t, createdAt: _c, ...rest } = (profile || {}) as Record<string, unknown>;
  return bytesHex(new Uint8Array(await subtle().digest('SHA-256', buf(enc.encode(canon(rest)))))).slice(2, 34);
}

// ── WebAuthn: the options the vault frame passes to navigator.credentials, and what it reads back ──
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string) => unb64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
const short = (a: string) => `${lc(a).slice(0, 6)}…${lc(a).slice(-4)}`;
// The RP ID is the vault's own host, never the page's: motion.gift (the page) cannot use a credential scoped to
// vault.motion.gift, so a script there cannot reach the PRF. A future vault host lists itself in
// https://vault.motion.gift/.well-known/webauthn (Related Origin Requests) and keeps using this RP ID.
export const rpIdFor = (hostname: string): string => (/(^|\.)motion\.gift$/i.test(hostname) ? 'vault.motion.gift' : lc(hostname));
export function createOptions(src: { rpId: string; main: string; salt: Uint8Array; exclude: string[]; challenge?: Uint8Array; userId?: Uint8Array }) {
  return {
    rp: { id: src.rpId, name: 'motion vault' },
    // a random user handle per passkey: a second passkey on the same provider must not replace the first
    user: { id: buf(src.userId || rand(16)), name: `motion backup ${short(src.main)}`, displayName: `motion backup · ${short(src.main)}` },
    challenge: buf(src.challenge || rand(32)),
    pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }, { type: 'public-key' as const, alg: -257 }],
    authenticatorSelection: { residentKey: 'required' as const, requireResidentKey: true, userVerification: 'required' as const },
    attestation: 'none' as const,
    timeout: 180_000,
    excludeCredentials: src.exclude.map((id) => ({ type: 'public-key' as const, id: buf(unb64url(id)) })),
    extensions: { prf: { eval: { first: buf(src.salt) } }, credProps: true },
  };
}
// one assertion request for the given credentials, each with its own PRF input
export function getOptionsRaw(src: { rpId: string; items: { id: string; salt: Uint8Array }[]; challenge?: Uint8Array }) {
  const evalBy: Record<string, { first: ArrayBuffer }> = {}; const allow: { type: 'public-key'; id: ArrayBuffer }[] = [];
  for (const it of src.items) { if (evalBy[it.id]) continue; evalBy[it.id] = { first: buf(it.salt) }; allow.push({ type: 'public-key', id: buf(unb64url(it.id)) }); }
  return {
    challenge: buf(src.challenge || rand(32)), rpId: src.rpId, allowCredentials: allow, userVerification: 'required' as const, timeout: 180_000,
    extensions: { prf: { evalByCredential: evalBy } },
  };
}
// every slot of every generation that this RP ID can use, each with its own generation's salt
export function getOptions(src: { rpId: string; pk: PkEnvelope; only?: string[]; challenge?: Uint8Array }) {
  const items: { id: string; salt: Uint8Array }[] = [];
  for (const c of coresOf(src.pk)) for (const s of c.slots) if (s.rp === lc(src.rpId) && (!src.only || src.only.includes(s.id))) items.push({ id: s.id, salt: prfInput(c) });
  return getOptionsRaw({ rpId: src.rpId, items, challenge: src.challenge });
}
// What a ceremony returned, read defensively (the browser objects differ; tests pass plain objects).
const bytesOf = (v: unknown): Uint8Array | null => {
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  return null;
};
type CredLike = { rawId: ArrayBuffer; getClientExtensionResults?: () => Record<string, unknown>; response?: { getAuthenticatorData?: () => ArrayBuffer; authenticatorData?: ArrayBuffer } };
export function readPrf(cred: CredLike | null | undefined): { id: string; prf: Uint8Array | null; enabled: boolean | null } {
  const raw = bytesOf(cred?.rawId); if (!cred || !raw) return { id: '', prf: null, enabled: null };
  const id = b64url(raw);
  let ext: Record<string, unknown> = {}; try { ext = cred.getClientExtensionResults?.() || {}; } catch {}
  const p = (ext.prf || {}) as { enabled?: boolean; results?: { first?: ArrayBuffer } };
  const prf = bytesOf(p.results?.first);
  return { id, prf: prf && prf.length === 32 ? prf : null, enabled: typeof p.enabled === 'boolean' ? p.enabled : null };
}
// authenticator data of a create(): flags (BE = backup-eligible = a synced passkey) and the provider's AAGUID
export function readAuthData(cred: CredLike | null | undefined): { aaguid: string; sync: boolean | null } {
  let ad: ArrayBuffer | undefined;
  try { ad = cred?.response?.getAuthenticatorData?.() || cred?.response?.authenticatorData; } catch {}
  if (!ad || ad.byteLength < 37) return { aaguid: '', sync: null };
  const u = new Uint8Array(ad); const flags = u[32];
  const sync = !!(flags & 0x08);
  if (!(flags & 0x40) || u.length < 53) return { aaguid: '', sync };
  const h = [...u.slice(37, 53)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const aaguid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { aaguid: /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(aaguid) ? '' : aaguid, sync };
}
// the providers people actually use (the passkey-provider AAGUID list); anything else is "Passkey"
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain', 'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager', 'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello', '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello', '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password', 'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden', '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass', 'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass', '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
};
export const providerName = (aaguid: string, sync: boolean | null): string => PROVIDERS[aaguid] || (sync === false ? 'Security key' : 'Passkey');

// ── what the user can still do when something is lost (the recovery matrix, as the status reports it) ──
export function recoveryPaths(pk: PkEnvelope | null, here: { dkCached: boolean }) {
  if (!pk) return { passkeys: 0, synced: 0, code: false, here: false, warn: '' };
  const passkeys = pk.slots.length, synced = pk.slots.filter((s) => s.sync).length, code = !!pk.rc;
  // one way in is one loss away from none: say so (the dialogs and the settings card show this line)
  const ways = passkeys + (code ? 1 : 0);
  const warn = ways <= 1 ? 'Only one way into your backup: add a second passkey or a recovery code.'
    : passkeys && !synced && !code ? 'None of your passkeys syncs to another device: keep the recovery code or add a synced passkey.' : '';
  return { passkeys, synced, code, here: here.dkCached, warn };
}

// ── switching a profile between v3 and v4 (enrolment and "turn passkey protection off") ──
// Both directions re-seal EVERYTHING the profile holds that this seed (plus the keys given) opens — not only the wallets this
// device has restored — so nothing is left behind under the old format. Entries nothing here opens are carried verbatim.
// The server keeps the old copy until verifyStaged() passed on a fresh read and the client confirms (server/account-passkey.mjs).
type Reseal = { live: Profile | null; main: string; seed: string; mv: MainMsgVersion; count: number; names: Record<string, string>; wallets: BackupWallet[]; salts: string[]; liveKeys?: CryptoKey[] };
async function gather(src: Reseal) {
  const o = await openProfile(src.live, src.seed, src.salts, src.liveKeys || []);
  const byAddr = new Map<string, BackupWallet>();
  for (const w of src.wallets) byAddr.set(lc(w.address), w);
  for (const w of o.wallets) if (!byAddr.has(lc(w.address))) { const { v: _v, ...bw } = w; byAddr.set(lc(w.address), bw); }
  const salts = [...new Set([...src.salts, ...o.salts])];
  const count = Math.max(Number(src.live?.count) || 0, src.count);
  const names = { ...(src.live?.names || {}), ...src.names };
  return { wallets: [...byAddr.values()], salts, count, names, carry: o.unopened };
}
const carryExtras = (live: Profile | null, p: Profile) => {
  if (live && live.rk !== undefined) p.rk = live.rk;
  if (live?.uc) p.uc = live.uc;
  return p;
};
export async function upgradeProfile(src: Reseal & { pk: PkEnvelope; dk: string }): Promise<{ profile: Profile; addresses: string[]; salts: string[] }> {
  const pk = normPk(src.pk); if (!pk) throw new Error('bad passkey envelope');
  const key = await checkDk(pk, src.seed, src.main, src.dk); if (!key) throw new Error('the data key does not match this envelope');
  const g = await gather(src);
  const r = await buildProfile({ main: src.main, seed: src.seed, count: g.count, names: g.names, wallets: g.wallets, salts: g.salts, carry: g.carry, mv: src.mv, v4: { key } });
  if (r.dropped) throw new Error(`${r.dropped} wallet(s) do not fit in the backup`);
  const profile = carryExtras(src.live, { ...r.profile, pk } as Profile);
  return { profile, addresses: r.covered, salts: g.salts };
}
export async function downgradeProfile(src: Reseal): Promise<{ profile: Profile; addresses: string[]; salts: string[] }> {
  if (!src.liveKeys?.length) throw new Error('the backup must be unlocked with a passkey first');
  const g = await gather(src);
  const r = await buildProfile({ main: src.main, seed: src.seed, count: g.count, names: g.names, wallets: g.wallets, salts: g.salts, carry: g.carry, mv: src.mv });
  if (r.dropped) throw new Error(`${r.dropped} wallet(s) do not fit in the backup`);
  const profile = carryExtras(src.live, { ...r.profile } as Profile);
  delete (profile as { pk?: unknown }).pk;
  return { profile, addresses: r.covered, salts: g.salts };
}
// The check before the old copy may be deleted: the staged profile, as the server hands it back, opened with keys derived from
// a FRESH ceremony (not the ones that sealed it) holds every wallet and salt the live copy holds, with the same keys, all in the
// target format; nothing it carries is new; the non-secret fields and the other records match.
export type VerifyWhy = 'main' | 'fp' | 'mv' | 'envelope' | 'format' | 'missing-wallet' | 'wrong-key' | 'missing-salt' | 'foreign-entry' | 'count' | 'records';
export async function verifyStaged(src: { mode: 'up' | 'off'; staged: Profile | null; live: Profile | null; main: string; seed: string; stagedKeys: CryptoKey[]; liveKeys?: CryptoKey[]; localSalts?: string[] }): Promise<{ ok: true; wallets: number; salts: number } | { ok: false; why: VerifyWhy; detail?: string }> {
  const st = src.staged, lv = src.live, m = lc(src.main);
  if (!st || lc(st.main) !== m || (lv && lc(lv.main) !== m)) return { ok: false, why: 'main' };
  if (st.fp !== await fingerprint(src.seed) || (lv && lv.fp && lv.fp !== st.fp)) return { ok: false, why: 'fp' };
  if ((st.mv === 2 ? 2 : 1) !== (lv ? (lv.mv === 2 ? 2 : 1) : (st.mv === 2 ? 2 : 1))) return { ok: false, why: 'mv' };
  if (src.mode === 'up' ? !normPk(st.pk) : st.pk !== undefined) return { ok: false, why: 'envelope' };
  const target = src.mode === 'up' ? 4 : 3;
  // the staged copy opens with the fresh keys only (no local salts: every salt must come out of the copy itself)
  const os = await openProfile(st, src.seed, [], src.mode === 'up' ? src.stagedKeys : []);
  if (os.wallets.some((w) => w.v !== target)) return { ok: false, why: 'format', detail: 'an entry is still in the old format' };
  if (src.mode === 'up' ? os.salts.some((x) => !os.saltsV4.includes(x)) : os.saltsV4.length) return { ok: false, why: 'format', detail: 'a salt is still in the old format' };
  const ol = await openProfile(lv, src.seed, src.localSalts || [], src.liveKeys || []);
  const got = new Map(os.wallets.map((w) => [lc(w.address), w.key]));
  for (const w of ol.wallets) {
    const k = got.get(lc(w.address));
    if (!k) return { ok: false, why: 'missing-wallet', detail: lc(w.address) };
    if (k !== w.key) return { ok: false, why: 'wrong-key', detail: lc(w.address) };
  }
  for (const x of ol.salts) if (!os.salts.includes(x)) return { ok: false, why: 'missing-salt' };
  const liveUnopened = new Set(ol.unopened.map((e) => lc(e.address) + '|' + e.iv + '|' + e.ct));
  for (const e of os.unopened) if (!liveUnopened.has(lc(e.address) + '|' + e.iv + '|' + e.ct)) return { ok: false, why: 'foreign-entry', detail: lc(e.address) };
  if ((Number(st.count) || 0) < (Number(lv?.count) || 0)) return { ok: false, why: 'count' };
  if (canon(st.rk ?? null) !== canon(lv?.rk ?? null) || canon(st.uc ?? null) !== canon(lv?.uc ?? null)) return { ok: false, why: 'records' };
  return { ok: true, wallets: os.wallets.length, salts: os.salts.length };
}
