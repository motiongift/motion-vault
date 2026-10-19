// Chain-only wallets (2026-10-19, owner: "it must understand Solana and NEAR keys too"). A vault wallet used to be one
// EVM key, with its Solana and NEAR identities derived from it (solEngine solKeys / nearEngine nearKeys: unchanged). A key
// pasted from Phantom or a NEAR wallet has no EVM key behind it, so it becomes a wallet of ONE chain, stored in the same
// Account record under a key string of its own:
//   'sol:'  + 64 hex                      the Solana ed25519 seed (32 bytes; the address is its public key)
//   'near:' + 64 hex [+ ':' + account]    the NEAR ed25519 seed; the account is a named account (alice.near) the key
//                                         belongs to, else the key's own implicit account (hex of the public key)
// Such a wallet shows and trades only on its own lane (webEngine: parked on the others). Where the vault needs an EVM-shaped
// address for it (the account backup's entry address, which the server validates as 0x + 40 hex; removal lists; the
// stored address list) it uses a placeholder derived from the chain and the native address — no key can have it.
// Pure: no DOM, no network. Every existing EVM key string is left exactly as it is.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';

export type NativeChain = 'sol' | 'near';
const SOL_KEY = /^sol:[0-9a-f]{64}$/;
const NEAR_KEY = /^near:[0-9a-f]{64}(?::([a-z0-9][a-z0-9._-]{1,63}))?$/;
export const NEAR_NAMED = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)+$|^[0-9a-f]{64}$/;

export const nativeChainOf = (key: unknown): NativeChain | null => {
  const k = String(key ?? '');
  return SOL_KEY.test(k) ? 'sol' : NEAR_KEY.test(k) ? 'near' : null;
};
/** A key string the vault stores: an EVM key (unchanged) or a chain-only one. */
export const storableKey = (key: unknown) => /^0x[0-9a-fA-F]{64}$/.test(String(key ?? '')) || nativeChainOf(key) !== null;

const hexBytes = (h: string) => Uint8Array.from((h.match(/../g) || []).map((x) => parseInt(x, 16)));
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** The 32-byte ed25519 seed of a chain-only key string. */
export const nativeSeed = (key: string) => hexBytes(key.split(':')[1]);
/** The named NEAR account a 'near:' key belongs to, or null (implicit account). */
export const nearNamedOf = (key: string) => NEAR_KEY.exec(key)?.[1] || null;

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; }
export function b58dec(s: string): Uint8Array { let n = 0n; for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; out.unshift(0); } return Uint8Array.from(out); }

/** The wallet's address on its own chain: Solana base58 public key; NEAR named account, else the implicit (hex) account. */
export function nativeAddress(key: string): string {
  const chain = nativeChainOf(key); if (!chain) return '';
  const pub = ed25519.getPublicKey(nativeSeed(key));
  return chain === 'sol' ? b58enc(pub) : nearNamedOf(key) || bytesToHex(pub);
}
/** The export format other wallets import: Solana base58(seed ‖ pub) (Phantom), NEAR 'ed25519:' + base58(seed ‖ pub). */
export function nativeSecret(key: string): string {
  const seed = nativeSeed(key), pub = ed25519.getPublicKey(seed), both = new Uint8Array(64); both.set(seed); both.set(pub, 32);
  return nativeChainOf(key) === 'near' ? 'ed25519:' + b58enc(both) : b58enc(both);
}
/** The EVM-shaped placeholder of a chain-only wallet (backup entry address, removal list): never a key's address. */
export function nativeSlot(chain: NativeChain, address: string): `0x${string}` {
  return ('0x' + bytesToHex(sha256(new TextEncoder().encode(`motion/native/v1/${chain}/${address}`))).slice(0, 40)) as `0x${string}`;
}
export const nativeSlotOf = (key: string) => { const c = nativeChainOf(key); return c ? nativeSlot(c, nativeAddress(key)) : null; };

// ── SLIP-0010 ed25519 (hardened only): Phantom m/44'/501'/0'/0', NEAR wallets m/44'/397'/0' ──
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  const parts = path.replace(/^m\/?/, '').split('/').filter(Boolean);
  for (const p of parts) {
    if (!/^\d+'$/.test(p)) throw new Error('ed25519 paths are hardened only');
    const index = (Number(p.slice(0, -1)) + 0x80000000) >>> 0;
    const data = new Uint8Array(37); data[0] = 0; data.set(key, 1); data[33] = index >>> 24; data[34] = (index >>> 16) & 255; data[35] = (index >>> 8) & 255; data[36] = index & 255;
    I = hmac(sha512, chain, data); key = I.slice(0, 32); chain = I.slice(32);
  }
  return key;
}
export const PATHS = { evm: "m/44'/60'/0'/0/0", sol: "m/44'/501'/0'/0'", near: "m/44'/397'/0'" } as const;
