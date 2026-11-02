// USD balance consent that follows the ACCOUNT across its devices (owner, 2026-10-28: "yes" to making the USD-balance consent
// follow the account). Until now the grant (floatCore AccountGrant + each wallet's Permission) lived in ONE vault's storage, so
// the APK, another browser or an iPhone home-screen app showed "Confirm here". Now every change of the switch is also written
// as ONE consent record into the account's encrypted backup profile (the same profile that carries the sealed wallets), and
// every other device of the account adopts it — or turns off — on its next sync, without a dialog.
//
// The record (ConsentBody) is the substance the user said yes to, nothing else: on/off, the chains, the caps, the rules
// version, grantedAt / expiresAt, and the account's wallets it covers. Three locks keep it the account's own:
//   1. SEALED: AES-GCM under a key derived from the account's seed (HMAC(seed, 'motion/usd-consent/v1')) — the seed comes
//      from the main wallet's own signature and never reaches the server. AAD binds the main wallet, the counter `n` and
//      the on/off flag `o` that ride outside in the clear, so the server can neither read, nor forge, nor relabel a record.
//   2. SIGNED: an EIP-191 signature by one of the account's own trading wallets over the record's canonical digest. A device
//      adopts a grant only if the signer is one of the wallets the grant names AND a key THIS vault holds — or (2026-11-02)
//      one of the record's CO-SIGNERS is: the device that writes a record also signs it with up to CO_MAX of the other named
//      wallets it holds, so a phone that holds Wallet 1 follows a record the desktop wrote while trading from Wallet 3. A
//      signer whose key only the account's backup holds counts ONLY when it was opened from a backup-v4 (passkey) entry
//      with a K4 this vault unwrapped itself (Own.v4); never a v3 / v2 / v1 entry and never a seed-derived address — a seed
//      holder can seal and derive those (security review 2026-11-02 H1).
//   3. BOUND: a device covers only the named wallets it holds; a record naming none of them is refused whole ('foreign';
//      2026-11-02: one wallet of another account in that device's vault no longer refuses the whole record).
//   4. TERMS (2026-11-02, review H2): a grant's caps, slippage and dates must be ones `configure` can write
//      (floatCore termsOk: CAP_BOUNDS, at most PERMISSION_DAYS) — otherwise 'terms', never followed.
// Ordering: `n` is a counter every device raises above everything it has seen (n = highest seen + 1). The higher `n` wins;
// on the same `n` (two devices at the same moment) OFF wins. Every device keeps the highest record it has seen (its
// high-water mark) and refuses anything older, so a server that replays an older grant after a revocation is refused, and
// a device never re-publishes a grant a newer revocation superseded. A revocation needs no more than lock 1 and a valid
// signature: turning off is always safe.
// Adoption also needs the grant to be in date (expiresAt) and on rules this build accepts (FLOAT_RULES.accepted).
//
// Pure module: no window, no storage, no clock (callers pass `now`). The vault frame (webEngine mainSync / mainProfile /
// mainConsent) calls only `consentReceive` and `consentOutgoing`; the tests run exactly these (test/float-consent.mjs).
import { recoverMessageAddress } from 'viem';
import { sha256 } from '@noble/hashes/sha256';
import { hmac, buf, b64, unb64 } from './vaultRecovery.ts';
import { FLOAT_CHAIN_KEYS, rulesOf, termsOk, type FloatChain } from './floatCore.ts';

export const CONSENT_INFO = 'motion/usd-consent/v1';
/** The largest sealed record the server keeps (validProfile `uc.ct`): 200 wallets fit with room to spare. */
export const CONSENT_CT_MAX = 16384;
export const CONSENT_WALLETS_MAX = 200;
export type CapsWire = { perDay6: string; feesPerDay6: string; perChain6: string; total6: string; maxSlipBps: number };
export type ConsentBody = {
  v: 1; n: number; on: boolean; at: number;
  // on only: what the grant allows
  chains?: FloatChain[]; caps?: CapsWire; grantedAt?: number; expiresAt?: number; rules?: number; wallets?: string[];
};
/** `co` (2026-11-02): the same record signed by other wallets it names (at most CO_MAX), so a device holding any one of them
 *  can vouch for it. An older engine ignores it. */
export type CoSig = { signer: string; sig: string };
export type ConsentRecord = { body: ConsentBody; signer: string; sig: string; co?: CoSig[] };
export const CO_MAX = 12;
/** What rides in the profile (`profile.uc`): the counter and the on/off flag in the clear (bound by AAD), the rest sealed. */
export type ConsentBlob = { v: 1; n: number; o: 0 | 1; iv: string; ct: string };

const enc = new TextEncoder(), dec = new TextDecoder();
const lc = (a: unknown) => String(a ?? '').toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/;
const hexOf = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('');
const isInt = (x: unknown, lo = 0) => Number.isSafeInteger(x) && (x as number) >= lo;
const isUint = (s: unknown) => typeof s === 'string' && /^\d{1,24}$/.test(s);

/** The record's canonical form: a fixed-order array, so no key order or spelling can change the digest. */
export function consentCanon(b: ConsentBody): string {
  return JSON.stringify(['motion/usd-consent', b.v, b.n, b.on ? 1 : 0, b.at,
    b.on ? [...(b.chains || [])].sort() : [],
    b.on && b.caps ? [b.caps.perDay6, b.caps.feesPerDay6, b.caps.perChain6, b.caps.total6, b.caps.maxSlipBps] : [],
    b.on ? b.grantedAt ?? 0 : 0, b.on ? b.expiresAt ?? 0 : 0, b.on ? rulesOf(b) : 0,
    b.on ? [...(b.wallets || [])].map(lc).sort() : []]);
}
export const consentDigest = (b: ConsentBody) => hexOf(sha256(enc.encode(consentCanon(b))));
/** The text the signing wallet signs (EIP-191 personal message): fixed words + the digest. It moves nothing. */
export const consentMessage = (b: ConsentBody) => `motion.gift — USD balance on all your devices v1\nRecord: ${consentDigest(b)}\n\nThis signature records your USD balance switch. It sends no transaction.`;
/** The same terms (everything but the counter and the time): a re-save of an unchanged grant writes no new record. */
export const sameTerms = (a: ConsentBody, b: ConsentBody) => consentCanon({ ...a, n: 1, at: 1 }) === consentCanon({ ...b, n: 1, at: 1 });

/** A body is well formed: on = chains, caps, dates, rules and 1..200 wallets; off = only n and at. */
export function validBody(b: unknown): b is ConsentBody {
  const x = b as ConsentBody;
  if (!x || typeof x !== 'object' || x.v !== 1 || !isInt(x.n, 1) || typeof x.on !== 'boolean' || !isInt(x.at, 1)) return false;
  if (!x.on) return true;
  const c = x.caps;
  return Array.isArray(x.chains) && x.chains.length > 0 && x.chains.every((k) => FLOAT_CHAIN_KEYS.includes(k)) && new Set(x.chains).size === x.chains.length
    && !!c && isUint(c.perDay6) && isUint(c.feesPerDay6) && isUint(c.perChain6) && isUint(c.total6) && Number.isInteger(c.maxSlipBps) && c.maxSlipBps >= 1 && c.maxSlipBps <= 10_000
    && isInt(x.grantedAt, 1) && isInt(x.expiresAt, 1) && (x.expiresAt as number) > (x.grantedAt as number)
    && (x.rules === undefined || isInt(x.rules, 2))
    && Array.isArray(x.wallets) && x.wallets.length > 0 && x.wallets.length <= CONSENT_WALLETS_MAX && x.wallets.every((w) => ADDR.test(w)) && new Set(x.wallets).size === x.wallets.length;
}
export const validBlob = (u: unknown): u is ConsentBlob => {
  const x = u as ConsentBlob;
  return !!x && typeof x === 'object' && x.v === 1 && isInt(x.n, 1) && (x.o === 0 || x.o === 1)
    && /^[A-Za-z0-9+/=]{16}$/.test(String(x.iv || '')) && typeof x.ct === 'string' && x.ct.length >= 20 && x.ct.length <= CONSENT_CT_MAX && /^[A-Za-z0-9+/=]+$/.test(x.ct);
};

/** `a` supersedes `b`: a higher counter; on the same counter the revocation; two grants on the same counter (two devices
 *  at the same moment) by their digest, so every device settles on the same one. */
export function newer(a: ConsentBody, b: ConsentBody | null | undefined): boolean {
  if (!b) return true;
  if (a.n !== b.n) return a.n > b.n;
  if (a.on !== b.on) return !a.on;
  return consentDigest(a) > consentDigest(b);
}

const keyOf = async (seed: string) => {
  const raw = await hmac(seed, CONSENT_INFO);
  return globalThis.crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};
const aadOf = (main: string, n: number, o: 0 | 1) => buf(enc.encode(`${CONSENT_INFO}/${lc(main)}/${n}/${o}`));

/** The record sealed for the profile under the account's seed (fresh IV every time). */
export async function sealConsent(main: string, seed: string, rec: ConsentRecord): Promise<ConsentBlob> {
  if (!validBody(rec.body)) throw new Error('Bad consent record');
  const o = rec.body.on ? 1 as const : 0 as const;
  const co = (rec.co || []).filter((x) => ADDR.test(lc(x.signer)) && /^0x[0-9a-fA-F]{130}$/.test(String(x.sig))).slice(0, CO_MAX);
  const seal = async (withCo: boolean): Promise<ConsentBlob> => {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const pt = JSON.stringify({ b: rec.body, s: lc(rec.signer), g: rec.sig, ...(withCo && co.length ? { c: co.map((x) => [lc(x.signer), x.sig]) } : {}) });
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aadOf(main, rec.body.n, o) }, await keyOf(seed), buf(enc.encode(pt))));
    return { v: 1, n: rec.body.n, o, iv: b64(iv), ct: b64(ct) };
  };
  // the co-signatures are an extra: a record that would not fit with them is sealed without them (a backup never fails for them)
  let blob = await seal(true);
  if (blob.ct.length > CONSENT_CT_MAX && co.length) blob = await seal(false);
  if (blob.ct.length > CONSENT_CT_MAX) throw new Error('Consent record too large');
  return blob;
}
/** The record inside a blob, or null: not this account's seed / main, altered (in the clear or sealed), or malformed. */
export async function openConsent(main: string, seed: string, blob: unknown): Promise<ConsentRecord | null> {
  if (!validBlob(blob)) return null;
  let t: string;
  try { t = dec.decode(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64(blob.iv)), additionalData: aadOf(main, blob.n, blob.o) }, await keyOf(seed), buf(unb64(blob.ct)))); } catch { return null; }
  let p: { b?: unknown; s?: unknown; g?: unknown; c?: unknown };
  try { p = JSON.parse(t); } catch { return null; }
  if (!p || !validBody(p.b) || p.b.n !== blob.n || (p.b.on ? 1 : 0) !== blob.o) return null;
  if (!ADDR.test(lc(p.s)) || !/^0x[0-9a-fA-F]{130}$/.test(String(p.g || ''))) return null;
  // co-signatures: well-formed pairs only, at most CO_MAX (anything else is left out; each is verified before it counts)
  const co = Array.isArray(p.c) ? p.c.slice(0, CO_MAX).flatMap((x) => (Array.isArray(x) && ADDR.test(lc(x[0])) && /^0x[0-9a-fA-F]{130}$/.test(String(x[1] || '')) ? [{ signer: lc(x[0]), sig: String(x[1]) }] : [])) : [];
  return { body: p.b, signer: lc(p.s), sig: String(p.g), ...(co.length ? { co } : {}) };
}
/** The signature is the named signer's, over this exact record; a grant's signer must be one of its wallets. */
export async function verifyConsent(rec: ConsentRecord): Promise<boolean> {
  if (!validBody(rec.body)) return false;
  if (rec.body.on && !(rec.body.wallets || []).map(lc).includes(lc(rec.signer))) return false;
  try { return lc(await recoverMessageAddress({ message: consentMessage(rec.body), signature: rec.sig as `0x${string}` })) === lc(rec.signer); } catch { return false; }
}

/** A co-signer of a grant that THIS vault holds and whose signature over this exact record checks (it must be a named wallet). */
export async function heldCoSigner(rec: ConsentRecord, held: (addr: string) => boolean): Promise<boolean> {
  if (!rec.body.on) return false;
  const named = new Set((rec.body.wallets || []).map(lc));
  for (const x of rec.co || []) {
    if (!named.has(lc(x.signer)) || !held(lc(x.signer))) continue;
    try { if (lc(await recoverMessageAddress({ message: consentMessage(rec.body), signature: x.sig as `0x${string}` })) === lc(x.signer)) return true; } catch { /* next */ }
  }
  return false;
}

// ── what a device does with the record it found in the profile ──
export type ConsentWhy = 'none' | 'unopened' | 'signature' | 'same' | 'older' | 'signer' | 'foreign' | 'expired' | 'rules' | 'unverified' | 'terms';
export type ConsentVerdict = { action: 'adopt' | 'revoke' | 'keep'; why?: ConsentWhy; rec?: ConsentRecord };
/**
 * Pure decision over an AUTHENTIC record (opened + signature checked) against this device's high-water mark:
 *   older or the same → keep (a replay / rollback changes nothing); a newer revocation → revoke; a newer grant → adopt only
 *   when it was signed by a wallet whose key THIS vault holds, every wallet it names is this account's own, it is in date
 *   and on rules this build accepts — otherwise keep. `grants` false (a seed this vault cannot vouch for: a legacy unbound
 *   recovery copy, webEngine seedSrc 'rk1') → a grant is never adopted; a revocation still is.
 */
export function judgeConsent(i: { local: ConsentBody | null; remote: ConsentRecord; vault: (addr: string) => boolean; own: (addr: string) => boolean; now: number; accepted: number; grants?: boolean; floor?: number; coHeld?: boolean }): ConsentVerdict {
  const r = i.remote.body;
  if (i.local && !newer(r, i.local)) return { action: 'keep', why: consentDigest(r) === consentDigest(i.local) ? 'same' : 'older', rec: i.remote };
  // (audit 2026-11-01, vault-security-consent-replay) the high-water mark also binds a device with no record of its own: a
  // grant under a counter this device has already seen in an authentic record (a revocation it saw, a grant it could not
  // adopt) is older than what it knows — a page replaying the account's old grant blob is refused, not adopted
  if (r.on && Number.isSafeInteger(i.floor) && r.n < (i.floor as number)) return { action: 'keep', why: 'older', rec: i.remote };
  if (!r.on) return { action: 'revoke', rec: i.remote };
  if (i.grants === false) return { action: 'keep', why: 'unverified', rec: i.remote };
  // (2026-11-02, review H2) terms `configure` could never have written (slippage above 1 %, caps outside CAP_BOUNDS, more than
  // 30 days, dated in the future): never followed, whoever signed it
  if (!termsOk({ caps: r.caps, grantedAt: r.grantedAt, expiresAt: r.expiresAt }, i.now)) return { action: 'keep', why: 'terms', rec: i.remote };
  // the signer: a key this vault holds, a co-signer this vault holds (checked by consentReceive), or a wallet `own` proves
  // (a backup-v4 entry opened with this vault's own K4 — never a v3 entry or a seed-derived address; review H1)
  if (!i.vault(lc(i.remote.signer)) && !i.coHeld && !i.own(lc(i.remote.signer))) return { action: 'keep', why: 'signer', rec: i.remote };
  // a named wallet this vault does not hold is left out (a device covers only the wallets it holds: floatEngine consent.apply);
  // a record naming NONE of this vault's wallets turns nothing on here (review M2)
  if (!(r.wallets || []).some((w) => i.vault(lc(w)))) return { action: 'keep', why: 'foreign', rec: i.remote };
  if (!((r.expiresAt as number) > i.now)) return { action: 'keep', why: 'expired', rec: i.remote };
  if (rulesOf(r) < i.accepted) return { action: 'keep', why: 'rules', rec: i.remote };
  return { action: 'adopt', rec: i.remote };
}

/** The float frame's side of it (src/floatEngine.ts createFloat → consent). */
export type ConsentHost = {
  /** this device's high-water record (what it agreed to or adopted last), or null */
  local: () => ConsentRecord | null;
  /** the highest counter this device has seen in any authentic record (a new record goes above it) */
  seen: (n: number) => void;
  /** that highest counter as stored (0 = none yet); optional for older hosts — judgeConsent's floor */
  seenMax?: () => number;
  /** apply a verdict: adopt the grant (on without a dialog) or the revocation (off, nothing converts here) */
  apply: (v: ConsentVerdict & { action: 'adopt' | 'revoke'; rec: ConsentRecord }) => void;
  /** the server holds this device's record (the very same one): it is on every device's way */
  synced: (n: number) => void;
  /** a live grant from before this build (no record yet): its record, signed now; null = nothing live */
  fromLive: () => Promise<ConsentRecord | null>;
  accepted: number;
  /** (2026-11-01) an authentic grant NEWER than this device's own that it did not adopt, and why (newer rules, out of date, a
   *  signer whose key this vault does not hold, a wallet that is not the account's, an unverified seed): the switch's dialog
   *  then says why this device asks, and converts nothing by default. Optional for older hosts. */
  kept?: (k: { n: number; why: ConsentWhy; rules: number; terms?: { chains: FloatChain[]; caps: CapsWire } }) => void;
};
/** The reasons a newer authentic grant was not adopted (what `ConsentHost.kept` hears). */
export const KEPT_WHYS: readonly ConsentWhy[] = ['rules', 'expired', 'signer', 'foreign', 'unverified'];
/** This account's own wallets as this device can PROVE them: `vault` = the wallets whose keys this vault holds (lower-case
 *  addresses); `v4` = on demand, the wallets opened from backup-v4 (passkey) entries with a K4 this vault unwrapped itself
 *  (webEngine consentOwn) — the only backup wallets that count as a signer (review H1: a v3 entry or a seed-derived address
 *  is within reach of anyone with the seed); `more` (older callers: any backup wallet) is no proof and is ignored;
 *  `grants` false = never adopt a grant under this seed (see judgeConsent). */
export type Own = { vault: Set<string>; v4?: () => Promise<Set<string>>; more?: () => Promise<Set<string>>; grants?: boolean };
async function ownCheck(rec: ConsentRecord, own: Own): Promise<Set<string>> {
  if (own.vault.has(lc(rec.signer)) || !own.v4) return own.vault;
  const v4 = await own.v4().catch(() => new Set<string>());
  return new Set([...own.vault, ...[...v4].map(lc)]);
}
/**
 * The profile's record → this device (mainSync, mainConsent, and before every publish). Returns what was done and why.
 * Nothing changes unless the record opens under this account's seed, carries a valid signature AND is newer than this
 * device's own; a grant then needs the signer / wallet / date / rules checks of judgeConsent.
 */
export async function consentReceive(host: ConsentHost, o: { main: string; seed: string; blob: unknown; own: Own; now: number }): Promise<ConsentVerdict> {
  if (o.blob == null) return { action: 'keep', why: 'none' };
  const rec = await openConsent(o.main, o.seed, o.blob);
  if (!rec) return { action: 'keep', why: 'unopened' };
  if (!(await verifyConsent(rec))) return { action: 'keep', why: 'signature' };
  const floor = Number(host.seenMax?.() ?? 0) || 0;   // read before this record raises it
  host.seen(rec.body.n);
  const local = host.local();
  if (local && consentDigest(local.body) === consentDigest(rec.body)) { host.synced(rec.body.n); return { action: 'keep', why: 'same', rec }; }
  const held = (a: string) => o.own.vault.has(lc(a));
  const coHeld = rec.body.on && !held(rec.signer) ? await heldCoSigner(rec, held) : false;
  const own = rec.body.on && !coHeld ? await ownCheck(rec, o.own) : o.own.vault;
  const v = judgeConsent({ local: local?.body ?? null, remote: rec, vault: held, own: (a) => own.has(a), now: o.now, accepted: host.accepted, grants: o.own.grants, floor, coHeld });
  if (v.action === 'adopt' || v.action === 'revoke') { host.apply({ ...v, action: v.action, rec }); host.synced(rec.body.n); }
  // a newer grant not followed: why, and — only when its authorship is proven (out of date / older rules) — its terms, the
  // baseline a buy click's one-button confirm may re-grant (floatEngine configure `click`)
  else if (rec.body.on && v.why && KEPT_WHYS.includes(v.why)) host.kept?.({ n: rec.body.n, why: v.why, rules: rulesOf(rec.body), ...((v.why === 'rules' || v.why === 'expired') && rec.body.caps && rec.body.chains ? { terms: { chains: [...rec.body.chains], caps: { ...rec.body.caps } } } : {}) });
  return v;
}
/**
 * What this device publishes as `profile.uc` (mainProfile): first the server's record is taken in (consentReceive), then
 * this device's high-water record is sealed — never one older than the server's authentic copy, so a stale device can
 * never put back a grant a newer revocation ended. A live grant from before this build gets its first record here (only
 * when the server holds no record at all). undefined blob = nothing to publish (the server keeps whatever it holds).
 */
export async function consentOutgoing(host: ConsentHost, o: { main: string; seed: string; blob: unknown; own: Own; now: number }): Promise<{ blob?: ConsentBlob; verdict: ConsentVerdict }> {
  const verdict = await consentReceive(host, o);
  let rec = host.local();
  if (!rec && o.blob == null) rec = await host.fromLive();
  if (!rec) return { verdict };
  // the server's authentic record is newer and this device did not take it (a grant it cannot vouch for, out of date, …):
  // its own stays local, the server's stays on the server
  if (verdict.rec && newer(verdict.rec.body, rec.body)) return { verdict };
  return { blob: await sealConsent(o.main, o.seed, rec), verdict };
}
