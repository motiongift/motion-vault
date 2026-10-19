// What a pasted text is, for the vault's own "Import a private key" dialog (webEngine.ts importKeyDialog; 2026-10-19,
// the mobile app's Add wallet, then the owner: "it must understand Solana and NEAR too — smart"). Runs inside the vault
// frame; no key is kept, logged or returned by this module beyond the candidates it hands the dialog.
//   EVM private key            0x + 64 hex, or the 64 hex alone (MetaMask copies it without 0x)  → an EVM wallet (as before:
//                              one key = the wallet on every chain, its Solana / NEAR addresses derived by motion)
//   Solana secret key          base58 of 64 bytes (Phantom, Solflare) or a JSON array of 64 numbers (solana-keygen)
//                              → a Solana-only wallet (nativeKeys.ts 'sol:')
//   NEAR secret key            ed25519:<base58 of 64 bytes> (NEAR CLI, MyNearWallet, Meteor) → a NEAR-only wallet
//   Recovery phrase (BIP-39)   12–24 words: the first account the common wallets make — EVM m/44'/60'/0'/0/0
//                              (MetaMask, Rabby), Solana m/44'/501'/0'/0' (Phantom), NEAR m/44'/397'/0' — the dialog
//                              lists all three and the user keeps the ones they use
// Refused and named: a Solana address or NEAR public key (32 bytes: public, not a key), a phrase with a bad checksum,
// a 64-byte secret whose second half is not its public key, anything else.
import { privateKeyToAccount } from 'viem/accounts';
import { validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { ed25519 } from '@noble/curves/ed25519';
import { b58dec, bytesToHex, nativeAddress, slip10Ed25519, PATHS, type NativeChain } from './nativeKeys.ts';

export type KeyChain = 'evm' | NativeChain;
/** One wallet a pasted text makes: the key string the vault stores, its address, and for a phrase the path used. */
export type KeyCandidate = { chain: KeyChain; key: string; address: string; path?: string };
export type KeyKind = 'evm' | 'sol' | 'near' | 'seed' | 'empty' | 'seed-bad' | 'sol-address' | 'near-public' | 'mismatch' | 'short' | 'bad';
export type KeyRead = { kind: KeyKind; candidates: KeyCandidate[] };

const evmCandidate = (hex: string, path?: string): KeyCandidate => {
  const key = `0x${hex.toLowerCase()}`;
  return { chain: 'evm', key, address: privateKeyToAccount(key as `0x${string}`).address, ...(path ? { path } : {}) };
};
const edCandidate = (chain: NativeChain, seed: Uint8Array, path?: string): KeyCandidate => {
  const key = `${chain}:${bytesToHex(seed)}`;
  return { chain, key, address: nativeAddress(key), ...(path ? { path } : {}) };
};
// a 64-byte ed25519 secret is seed ‖ public key: the second half must be the first half's public key
const fromSecret64 = (chain: NativeChain, b: Uint8Array): KeyRead => {
  const seed = b.slice(0, 32), pub = b.slice(32);
  return bytesToHex(ed25519.getPublicKey(seed)) === bytesToHex(pub) ? { kind: chain, candidates: [edCandidate(chain, seed)] } : { kind: 'mismatch', candidates: [] };
};
const none = (kind: KeyKind): KeyRead => ({ kind, candidates: [] });

export function readKey(raw: unknown): KeyRead {
  // a key copied with its quotes, or with spaces / a line break around it
  const s = String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return none('empty');
  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) { try { return { kind: 'evm', candidates: [evmCandidate(hex)] }; } catch { return none('bad'); } }
  // NEAR: ed25519:<base58>
  const near = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/i.exec(s);
  if (near) {
    let b: Uint8Array; try { b = b58dec(near[1]); } catch { return none('bad'); }
    return b.length === 64 ? fromSecret64('near', b) : b.length === 32 ? none('near-public') : none('bad');
  }
  // Solana: JSON byte array (solana-keygen) or base58
  if (/^\[[\d\s,]+\]$/.test(s)) {
    const nums = s.slice(1, -1).split(',').map((x) => Number(x.trim()));
    if (nums.length !== 64 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return none('bad');
    return fromSecret64('sol', Uint8Array.from(nums));
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s)) {
    let b: Uint8Array; try { b = b58dec(s); } catch { return none('bad'); }
    // 32 bytes in base58 is what a Solana ADDRESS looks like: importing it as a seed would make some other, empty wallet
    return b.length === 64 ? fromSecret64('sol', b) : b.length === 32 ? none('sol-address') : none('bad');
  }
  // a recovery phrase
  const words = s.toLowerCase().split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/.test(w))) {
    const phrase = words.join(' ');
    if (![12, 15, 18, 21, 24].includes(words.length) || !validateMnemonic(phrase, wordlist)) return none('seed-bad');
    const seed = mnemonicToSeedSync(phrase);
    const evmKey = HDKey.fromMasterSeed(seed).derive(PATHS.evm).privateKey;
    if (!evmKey) return none('bad');
    return { kind: 'seed', candidates: [evmCandidate(bytesToHex(evmKey), PATHS.evm), edCandidate('sol', slip10Ed25519(seed, PATHS.sol), PATHS.sol), edCandidate('near', slip10Ed25519(seed, PATHS.near), PATHS.near)] };
  }
  if (/^(0x)?[0-9a-fA-F]+$/.test(s)) return none('short');
  return none('bad');
}

// one plain sentence per case, shown under the field while typing (and as the dialog's error on Import)
export const KEY_TEXT: Record<KeyKind, string> = {
  empty: 'Paste a private key or a recovery phrase: EVM (MetaMask, Rabby), Solana (Phantom, Solflare) or NEAR.',
  evm: 'EVM key',
  sol: 'Solana key',
  near: 'NEAR key',
  seed: 'Recovery phrase — keep the wallets you use',
  'seed-bad': 'That recovery phrase does not check out. Check the words and their order.',
  'sol-address': 'That is a Solana address. Paste the private key (Phantom: Settings → Show private key).',
  'near-public': 'That is a NEAR public key. Paste the secret key (it also starts with ed25519:).',
  mismatch: 'That key is damaged: its two halves do not match. Copy it again.',
  short: 'A private key is 64 hexadecimal characters.',
  bad: 'That is not a key or a recovery phrase.',
};
export const CHAIN_LABEL: Record<KeyChain, string> = { evm: 'EVM', sol: 'Solana', near: 'NEAR' };
