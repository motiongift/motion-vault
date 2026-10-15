// Vault survival: everything that decides whether a user's wallets live through
// a lost key store, a fresh browser, or two tabs opening the vault at once.
//
// Incident 2026-10-14: the browser discarded the vault origin's IndexedDB (disk
// full) while localStorage survived. The engine found no device key, silently
// generated a new one, could not open the stored ciphertext, set it aside and
// started an empty vault: five created wallets were gone for good. The rules
// here make that impossible:
//   1. a stored ciphertext without its key (or with a key that does not open it)
//      is a "key missing" state, never a reset. Nothing is written; a new key
//      and an empty vault come only from an explicit trusted click in the frame,
//      and even then the old blob is copied aside (and the copy verified) first.
//   2. key creation runs under one Web Lock, so two tabs cannot both mint a key.
//   3. every keyed wallet (created, imported, derived, hop) and the vault's
//      gen-2 salts ride in the account profile, sealed under a key derived from
//      the main wallet's signature seed (backup v3) — so log in + one signature
//      restores everything on an empty browser.
//
// Pure module: storage, key store and lock are passed in, so the node tests
// (scripts/vault-recovery.test.mjs) run exactly the code the vault frame runs.
import { privateKeyToAccount } from 'viem/accounts';

export const VAULT_KEY = 'trenches.vault';
export const LOST_PREFIX = VAULT_KEY + '.lost-';
export const KEY_LOCK = 'trenches-vault-key';

const enc = new TextEncoder(), dec = new TextDecoder();
export const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
export const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 1) s += String.fromCharCode(u[i]); return btoa(s); };
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const hexBytes = (h: string) => Uint8Array.from((h.startsWith('0x') ? h.slice(2) : h).match(/../g) || [], (x) => parseInt(x, 16));
export const bytesHex = (u: Uint8Array) => '0x' + [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const lc = (a?: string) => String(a || '').toLowerCase();
const subtle = () => globalThis.crypto.subtle;

// ── key derivation (shared by the engine and the tests) ──
export async function hmac(keyHex: string, msg: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(hexBytes(keyHex)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(enc.encode(msg))));
}
// the exact text vault-client.js asks the main wallet to sign (Privy embedded or an external wallet)
export const MAIN_MSG = (main: string) => `copytrade.gg — trading wallets\nMain wallet: ${main.toLowerCase()}\n\nThis signature derives your trading wallets on this device. Sign it only on copytrade.gg.`;
export async function seedOfSignature(sig: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('That is not a wallet signature');
  return bytesHex(new Uint8Array(await subtle().digest('SHA-256', buf(hexBytes(sig)))));
}
export const fingerprint = async (seed: string) => bytesHex(await hmac(seed, 'copytrade/fp/v1')).slice(2, 18);
const aesKey = async (raw: Uint8Array) => subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
export async function subKeyV1(seed: string, index: number): Promise<`0x${string}`> {
  let k = bytesHex(await hmac(seed, `copytrade/sub/v1/${index}`)) as `0x${string}`;
  try { privateKeyToAccount(k); } catch { k = bytesHex(await hmac(seed, `copytrade/sub/v1/${index}/r`)) as `0x${string}`; }
  return k;
}
export const wrapKeyV1 = async (seed: string) => aesKey(await hmac(seed, 'copytrade/wrap/v1'));
export const seedV2 = async (seed: string, salt: string) => bytesHex(await hmac(salt, 'motion/seed/v2/' + seed));
export async function subKeyV2With(seed: string, salt: string, index: number): Promise<`0x${string}`> {
  const s2 = await seedV2(seed, salt);
  let k = bytesHex(await hmac(s2, `motion/sub/v2/${index}`)) as `0x${string}`;
  try { privateKeyToAccount(k); } catch { k = bytesHex(await hmac(s2, `motion/sub/v2/${index}/r`)) as `0x${string}`; }
  return k;
}
export const wrapKeyV2 = async (seed: string, salt: string) => aesKey(await hmac(await seedV2(seed, salt), 'motion/wrap/v2'));
// Backup v3: the account-profile key. Derived from the seed ALONE, on purpose.
// Why gen-2 salts block re-derivation: a gen-2 wallet is HMAC(HMAC(salt, seed), index) with 32 random bytes
// the frame drew for itself; another browser has the seed (one signature) but not the salt, so it cannot
// rebuild the key, and a v2-wrapped profile blob (wrapKeyV2(seed, salt)) does not open there either. That
// was the point of gen 2 — the page can obtain the main's signature (Privy signs silently; the signature
// also passes through the page on its way here) — and it is exactly why a lost key store lost the wallets.
// v3 trades that for survival: each wallet's key and the salts themselves are sealed under this seed key,
// so a fresh browser with the seed opens all of them. Consequence (owner decision, see the report): anyone
// who holds BOTH the account's Privy session and the main's derivation signature can open the backup —
// the same exposure the v1 wallets always had. The server alone never can.
export const backupKeyV3 = async (seed: string) => aesKey(await hmac(seed, 'motion/backup/v3'));

// ── the stored vault (localStorage) and its device key (IndexedDB) ──
export type StoredVault = { v: 2; iv: string; ct: string; siv?: string; sct?: string; meta?: Record<string, unknown>; addresses?: { id?: string; name?: string; address: string; archived?: boolean; hop?: boolean }[] };
export type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; key(i: number): string | null; readonly length: number };
export type KeyStore = { get(): Promise<CryptoKey | undefined>; put(k: CryptoKey): Promise<void> };
export type Locker = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
// one Web Lock per origin around everything that may create a key or replace the stored vault
export const webLocker: Locker = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
  const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined);
  return locks?.request ? (locks.request(name, { mode: 'exclusive' }, fn) as Promise<T>) : fn();
};
export const parseStored = (raw: string | null): StoredVault | null => { try { const v = JSON.parse(raw || 'null'); return v && v.v === 2 && typeof v.ct === 'string' && v.ct.length > 0 && typeof v.iv === 'string' ? v : null; } catch { return null; } };
export async function openWith(key: CryptoKey, stored: StoredVault): Promise<{ accounts: Record<string, unknown>[]; seeds: Record<string, string> } | null> {
  let accounts: unknown;
  try { accounts = JSON.parse(dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(stored.iv)) }, key, buf(unb64(stored.ct))))); } catch { return null; }
  if (!Array.isArray(accounts)) return null;
  let seeds: Record<string, string> = {};
  if (stored.sct && stored.siv) { try { seeds = JSON.parse(dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(stored.siv)) }, key, buf(unb64(stored.sct))))) || {}; } catch { seeds = {}; } }
  return { accounts: accounts as Record<string, unknown>[], seeds };
}
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-');
// a copy under a dated name, read back before anything may replace the original; a failed copy (quota, full
// disk) throws, and the caller then does not touch the original either
export function setAside(store: Store, raw: string, now = Date.now()): string {
  for (const b of lostBlobs(store)) if (b.raw === raw) return b.name;   // already kept
  let name = LOST_PREFIX + stamp(now);
  for (let i = 2; store.getItem(name) != null; i += 1) name = LOST_PREFIX + stamp(now) + '-' + i;
  store.setItem(name, raw);
  if (store.getItem(name) !== raw) throw new Error('could not keep a copy of the stored vault');
  return name;
}
export type LostBlob = { name: string; raw: string; stored: StoredVault | null; addresses: { name: string; address: string; hop?: boolean }[] };
export function lostBlobs(store: Store): LostBlob[] {
  const out: LostBlob[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const name = store.key(i); if (!name || !name.startsWith(LOST_PREFIX)) continue;
    const raw = store.getItem(name) || ''; const stored = parseStored(raw);
    const addresses = (stored?.addresses || []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a?.address || ''))).map((a) => ({ name: String(a.name || ''), address: String(a.address), ...(a.hop ? { hop: true } : {}) }));
    out.push({ name, raw, stored, addresses });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
// wallets listed (by address, in the plaintext index every blob carries) by a vault this browser set aside and that are not here now
export function unrecovered(lost: LostBlob[], have: string[], dismissed: string[] = []) {
  const here = new Set([...have, ...dismissed].map(lc)); const seen = new Set<string>();
  const out: { address: string; name: string; since: string }[] = [];
  for (const b of lost) for (const a of b.addresses) { const k = lc(a.address); if (here.has(k) || seen.has(k)) continue; seen.add(k); out.push({ address: a.address, name: a.name, since: b.name.slice(LOST_PREFIX.length) }); }
  return out;
}

export type Boot =
  | { state: 'open'; key: CryptoKey; accounts: Record<string, unknown>[]; seeds: Record<string, string>; meta: Record<string, unknown> | null; created: boolean; aside: string; raced?: boolean }
  | { state: 'keymissing'; reason: 'nokey' | 'mismatch'; key: CryptoKey | null; stored: StoredVault };
type BootDeps = { store: Store; keys: KeyStore; lock?: Locker; generate?: () => Promise<CryptoKey>; now?: () => number; commit?: (b: Extract<Boot, { state: 'open' }>) => Promise<void> };
async function createKey(d: BootDeps): Promise<CryptoKey> {
  const key = d.generate ? await d.generate() : await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
  await d.keys.put(key);
  return key;
}
// Opening the vault on load. A key is created ONLY when nothing readable is stored — never when a ciphertext
// is waiting for a key that is gone. Runs under the key lock: a second tab waits, then finds the first tab's key.
export async function bootVault(d: BootDeps): Promise<Boot> {
  return (d.lock || webLocker)(KEY_LOCK, async () => {
    const key = await d.keys.get();                       // throws if the key store fails: a failure is not an empty store
    const raw = d.store.getItem(VAULT_KEY);
    const stored = parseStored(raw);
    if (stored) {
      if (!key) return { state: 'keymissing', reason: 'nokey', key: null, stored };
      const opened = await openWith(key, stored);
      if (!opened) return { state: 'keymissing', reason: 'mismatch', key, stored };
      return { state: 'open', key, ...opened, meta: (stored.meta as Record<string, unknown>) || null, created: false, aside: '' };
    }
    // nothing readable is stored; whatever IS there (a damaged blob) is kept aside before an empty vault replaces it
    const aside = raw ? setAside(d.store, raw, d.now?.() ?? Date.now()) : '';
    const out = { state: 'open' as const, key: key || await createKey(d), accounts: [], seeds: {}, meta: null, created: !key, aside };
    if (d.commit) await d.commit(out);
    return out;
  });
}
// The explicit "start a new empty vault" (a trusted click in the frame, or a restore into an empty vault).
// If another tab already recovered (the stored vault opens with the key now in the store), nothing is reset.
// Otherwise the stored blob is copied aside and verified, a key is created only if none exists, and the first
// write of the new vault happens inside the same lock.
export async function resetVault(d: BootDeps): Promise<Extract<Boot, { state: 'open' }>> {
  return (d.lock || webLocker)(KEY_LOCK, async () => {
    const key = await d.keys.get();
    const raw = d.store.getItem(VAULT_KEY);
    const stored = parseStored(raw);
    if (stored && key) { const opened = await openWith(key, stored); if (opened) return { state: 'open' as const, key, ...opened, meta: (stored.meta as Record<string, unknown>) || null, created: false, aside: '', raced: true }; }
    const aside = raw ? setAside(d.store, raw, d.now?.() ?? Date.now()) : '';
    const out = { state: 'open' as const, key: key || await createKey(d), accounts: [], seeds: {}, meta: null, created: !key, aside };
    if (d.commit) await d.commit(out);
    return out;
  });
}

// ── the account profile (server/.accounts.json, shape fixed by the server's validProfile) ──
export type ProfileEntry = { address: string; name: string; iv: string; ct: string };
export type Profile = { v: 1; main: string; fp: string; count: number; names: Record<string, string>; attached: ProfileEntry[]; updatedAt?: number };
export type BackupWallet = { address: string; name: string; key: `0x${string}`; kind: 'created' | 'imported' | 'derived' | 'hop'; main?: string; index?: number; gen?: 2; archived?: boolean; createdAt?: number };
export type OpenedWallet = BackupWallet & { v: 1 | 2 | 3 };
export const PROFILE_CAP = 200;   // the server refuses a profile with more attached entries
// The server keeps only {address, name, iv, ct} per entry, so a salt rides in an entry of its own under a reserved
// pseudo-address ("5a17" ~ salt) that no key can have. Old engines see an entry they cannot open and count it as sealed.
export const SALT_SLOT = (i: number) => '0x5a17' + i.toString(16).padStart(36, '0');
export const isSaltSlot = (a: string) => /^0x5a17[0-9a-f]{36}$/i.test(String(a || ''));
const AAD_W = (address: string) => buf(enc.encode('motion/backup/v3/wallet/' + lc(address)));
const AAD_S = buf(enc.encode('motion/backup/v3/salt'));
const KIND_CODE: Record<BackupWallet['kind'], string> = { created: 'c', imported: 'i', derived: 'd', hop: 'h' };
const CODE_KIND: Record<string, BackupWallet['kind']> = { c: 'created', i: 'imported', d: 'derived', h: 'hop' };
async function seal(key: CryptoKey, aad: ArrayBuffer, body: unknown): Promise<{ iv: string; ct: string }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aad }, key, buf(enc.encode(JSON.stringify(body)))));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(key: CryptoKey, aad: ArrayBuffer | null, e: ProfileEntry): Promise<string | null> {
  try { return dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(e.iv)), ...(aad ? { additionalData: aad } : {}) }, key, buf(unb64(e.ct)))); } catch { return null; }
}
const validEntry = (e: unknown): e is ProfileEntry => !!e && typeof e === 'object' && /^0x[0-9a-fA-F]{40}$/.test(String((e as ProfileEntry).address || '')) && /^[A-Za-z0-9+/=]{16}$/.test(String((e as ProfileEntry).iv || '')) && /^[A-Za-z0-9+/=]{20,400}$/.test(String((e as ProfileEntry).ct || ''));

// What the server stores for the account. Order under the 200-entry cap: salts, then the vault's wallets in the
// order given (the engine puts funded/visible ones first), then entries carried over verbatim from the server copy
// (wallets other devices published, blobs this browser cannot open) — a publish never drops what it did not write.
export async function buildProfile(src: { main: string; seed: string; count: number; names: Record<string, string>; wallets: BackupWallet[]; salts: string[]; carry?: ProfileEntry[]; forget?: string[] }) {
  const kb = await backupKeyV3(src.seed);
  const attached: ProfileEntry[] = [];
  const salts = [...new Set(src.salts.filter((s) => /^0x[0-9a-f]{64}$/.test(s)))];
  for (let i = 0; i < salts.length && attached.length < PROFILE_CAP; i += 1) attached.push({ address: SALT_SLOT(i), name: 'motion vault salt', ...(await seal(kb, AAD_S, { v: 3, s: salts[i] })) });
  const covered: string[] = []; const mine = new Set<string>();
  for (const w of src.wallets) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(w.key) || mine.has(lc(w.address))) continue;
    mine.add(lc(w.address));
    if (attached.length >= PROFILE_CAP) continue;
    const body: Record<string, unknown> = { v: 3, k: w.key, t: KIND_CODE[w.kind] || 'i' };
    if (w.main && w.index != null) { body.m = lc(w.main); body.x = w.index; }
    if (w.gen === 2) body.g = 2;
    if (w.archived) body.a = 1;
    if (w.createdAt) body.c = Math.floor(w.createdAt);
    attached.push({ address: w.address, name: String(w.name || '').slice(0, 40), ...(await seal(kb, AAD_W(w.address), body)) });
    covered.push(lc(w.address));
  }
  const forget = new Set((src.forget || []).map(lc));
  const carried: ProfileEntry[] = [];
  for (const e of src.carry || []) {
    if (attached.length >= PROFILE_CAP) break;
    if (!validEntry(e) || isSaltSlot(e.address) || mine.has(lc(e.address)) || forget.has(lc(e.address)) || carried.some((c) => same(c, e))) continue;
    attached.push({ address: e.address, name: String(e.name || '').slice(0, 40), iv: e.iv, ct: e.ct }); carried.push(e);
  }
  const profile: Profile = { v: 1, main: lc(src.main), fp: await fingerprint(src.seed), count: src.count, names: src.names, attached };
  // a stable digest of the facts (fresh IVs make the blobs differ every time): the page posts only when it changes
  const saltTag = bytesHex(await hmac(src.seed, 'motion/backup/v3/salts/' + salts.join(','))).slice(2, 18);
  const facts = JSON.stringify({ count: src.count, names: src.names, w: src.wallets.filter((w) => covered.includes(lc(w.address))).map((w) => [lc(w.address), w.name, w.kind, w.main || '', w.index ?? '', !!w.archived]), s: saltTag, c: carried.map((c) => lc(c.address) + c.iv) });
  const digest = bytesHex(new Uint8Array(await subtle().digest('SHA-256', buf(enc.encode(facts))))).slice(2, 34);
  const total = new Set(src.wallets.filter((w) => /^0x[0-9a-fA-F]{64}$/.test(w.key)).map((w) => lc(w.address))).size;
  return { profile, digest, covered, dropped: total - covered.length };
}
const same = (a: ProfileEntry, b: ProfileEntry) => lc(a.address) === lc(b.address) && a.iv === b.iv && a.ct === b.ct;

// Everything a profile holds that this seed can open: the salts, then every wallet — v3 entries (any kind), and
// the older v2 (salted) and v1 (bare seed) wrapped keys. What does not open is returned as-is, to be carried over.
// A key is accepted only if it IS the entry's address.
export async function openProfile(profile: Profile | null | undefined, seed: string, localSalts: string[] = []) {
  const entries = (Array.isArray(profile?.attached) ? profile!.attached : []).slice(0, PROFILE_CAP).filter(validEntry);
  const kb = await backupKeyV3(seed);
  const salts: string[] = []; const wallets: OpenedWallet[] = []; const unopened: ProfileEntry[] = [];
  for (const e of entries) {
    if (!isSaltSlot(e.address)) continue;
    const t = await unseal(kb, AAD_S, e); let s = '';
    try { s = String(JSON.parse(t || 'null')?.s || ''); } catch {}
    if (/^0x[0-9a-f]{64}$/.test(s)) { if (!salts.includes(s)) salts.push(s); } else unopened.push(e);
  }
  const allSalts = [...new Set([...localSalts, ...salts])];
  const k2s = await Promise.all(allSalts.map((s) => wrapKeyV2(seed, s)));
  const k1 = await wrapKeyV1(seed);
  const seen = new Set<string>();
  for (const e of entries) {
    if (isSaltSlot(e.address)) continue;
    let w: OpenedWallet | null = null;
    const t3 = await unseal(kb, AAD_W(e.address), e);
    if (t3) {
      try {
        const p = JSON.parse(t3);
        if (p && p.v === 3 && /^0x[0-9a-fA-F]{64}$/.test(String(p.k))) {
          w = { v: 3, key: p.k, address: e.address, name: String(e.name || ''), kind: CODE_KIND[p.t] || 'imported', ...(p.m && Number.isInteger(p.x) && p.x >= 0 ? { main: lc(p.m), index: Number(p.x) } : {}), ...(p.g === 2 ? { gen: 2 as const } : {}), ...(p.a ? { archived: true } : {}), ...(Number(p.c) > 0 ? { createdAt: Number(p.c) } : {}) };
        }
      } catch {}
    }
    if (!w) for (const k of k2s) { const t = await unseal(k, null, e); if (t && /^0x[0-9a-fA-F]{64}$/.test(t)) { w = { v: 2, key: t as `0x${string}`, address: e.address, name: String(e.name || ''), kind: 'imported' }; break; } }
    if (!w) { const t = await unseal(k1, null, e); if (t && /^0x[0-9a-fA-F]{64}$/.test(t)) w = { v: 1, key: t as `0x${string}`, address: e.address, name: String(e.name || ''), kind: 'imported' }; }
    let real = '';
    if (w) { try { real = privateKeyToAccount(w.key).address; } catch {} }
    if (!w || lc(real) !== lc(e.address)) { unopened.push(e); continue; }
    if (seen.has(lc(real))) continue;
    seen.add(lc(real)); w.address = real as `0x${string}`; wallets.push(w);
  }
  return { salts, wallets, unopened };
}

// ── storage health: a browser short of disk space discards site data, and the vault key with it ──
export const GiB = 1024 ** 3;
export function storageHealth(est: { quota?: number; usage?: number } | null | undefined, persisted: boolean) {
  const quota = Number(est?.quota), usage = Number(est?.usage);
  if (!(quota > 0) || !(usage >= 0)) return { known: false, quota: 0, usage: 0, free: 0, low: false, critical: false, persisted };
  // Chromium caps an origin's quota at its usage plus the disk space still free: quota − usage tracks the free disk
  const free = Math.max(0, quota - usage);
  // the browser's estimate runs well below the real free disk (2.0 GB reported with 32 GB free on 2026-10-14):
  // warn only when it is truly tight
  return { known: true, quota, usage, free, low: free < 0.5 * GiB, critical: free < 0.2 * GiB, persisted };
}

// ── the "save a backup file" prompt: when it must stay on screen ──
// Persistent (not a toast) while a wallet of this vault holds funds — or the browser is short of space — and
// neither the account backup covers every wallet nor a backup file was written after the last wallet arrived.
export function backupNudge(i: { wallets: { address: string; createdAt?: number }[]; funded: string[]; backedUpAt: number; walletAddedAt?: number; account: { at: number; addrs: string[] } | null; storageLow: boolean }) {
  const keyed = i.wallets;
  const lastAdded = Math.max(Number(i.walletAddedAt) || 0, ...keyed.map((w) => Number(w.createdAt) || 0), 0);
  const fileCurrent = !!i.backedUpAt && i.backedUpAt >= lastAdded;
  const inAccount = new Set((i.account?.addrs || []).map(lc));
  const accountCovered = keyed.filter((w) => inAccount.has(lc(w.address))).length;
  const accountCurrent = !!i.account?.at && keyed.length > 0 && accountCovered === keyed.length;
  const funded = new Set(i.funded.map(lc)); const fundedCount = keyed.filter((w) => funded.has(lc(w.address))).length;
  const show = keyed.length > 0 && (fundedCount > 0 || i.storageLow) && !accountCurrent && !fileCurrent;
  return { show, wallets: keyed.length, funded: fundedCount, fileCurrent, accountCurrent, accountCovered, lastAdded };
}
