// Wire utilities for the separate builder API. No key custody or transaction broadcasting.
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer/index.js';
import { ed25519 } from '@noble/curves/ed25519';
function isEd25519Point(bytes) {
  try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}

export const SOL = Object.freeze({
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token22: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  budget: 'ComputeBudget111111111111111111111111111111',
  wsol: 'So11111111111111111111111111111111111111112',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  lookup: 'AddressLookupTab1e1111111111111111111111111',
  genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n, out = '';
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
}
export function b58decode(s) {
  if (typeof s !== 'string' || !s.length || s.length > 88) throw new Error('invalid base58');
  let n = 0n; const bytes = [];
  for (const c of s) { const v = ALPHABET.indexOf(c); if (v < 0) throw new Error('invalid base58'); n = n * 58n + BigInt(v); }
  while (n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
export function publicKey(s) { const b = b58decode(s); if (b.length !== 32 || b58encode(b) !== s) throw new Error('invalid Solana address'); return s; }
export function associatedTokenAddress(owner, mint, program = SOL.token) {
  const seeds = [owner, program, mint].map((s) => b58decode(publicKey(s)));
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(Buffer.concat([...seeds, Buffer.from([bump]), b58decode(SOL.ata), Buffer.from('ProgramDerivedAddress')]));
    if (!isEd25519Point(hash)) return b58encode(hash);
  }
  throw new Error('cannot derive associated token address');
}
export function accountBytes(a) { return a && Array.isArray(a.data) && a.data[1] === 'base64' ? Buffer.from(a.data[0], 'base64') : null; }
export function tokenState(a) {
  const b = accountBytes(a);
  if (!a || ![SOL.token, SOL.token22].includes(a.owner) || !b || b.length < 165) return null;
  const invariant = Buffer.from(b); invariant.fill(0, 64, 72); // ONLY the trade balance may change, never delegated amounts/extensions.
  return { mint: b58encode(b.subarray(0, 32)), owner: b58encode(b.subarray(32, 64)), amount: b.readBigUInt64LE(64), invariant: invariant.toString('hex'),
    state: b[108], delegate: b.subarray(72, 108).toString('hex'), closeAuthority: b.subarray(129, 165).toString('hex'), program: a.owner };
}
function compact(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 65535) throw new Error('wire length');
  const out = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out);
}
export function decodeInstruction(x) {
  if (!x || !Array.isArray(x.accounts) || x.accounts.length > 128 || typeof x.data !== 'string' || x.data.length > 16384) throw new Error('invalid instruction');
  const data = Buffer.from(x.data, 'base64');
  if (data.toString('base64') !== x.data) throw new Error('invalid instruction encoding');
  return { programId: publicKey(x.programId), data, accounts: x.accounts.map((a) => {
    if (typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean') throw new Error('invalid account flags');
    return { pubkey: publicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable };
  }) };
}
export function compileUnsignedV0(payer, instructions, blockhash, tables = []) {
  publicKey(payer); publicKey(blockhash);
  const meta = new Map();
  function add(key, signer, writable, invoked = false) { const old = meta.get(key); if (old) { old.signer ||= signer; old.writable ||= writable; old.invoked ||= invoked; } else meta.set(publicKey(key), { signer, writable, invoked }); }
  add(payer, true, true);
  for (const ix of instructions) { add(ix.programId, false, false, true); for (const a of ix.accounts) add(a.pubkey, a.isSigner, a.isWritable); }
  if ([...meta].some(([k, v]) => v.signer && k !== payer)) throw new Error('unexpected signer');
  const fromTable = new Set(), lookups = [];
  for (const table of tables) {
    publicKey(table.key); if (table.addresses.length > 256) throw new Error('lookup too long');
    const w = [], r = [];
    for (const [k, v] of meta) {
      if (v.signer || v.invoked || fromTable.has(k)) continue;
      const i = table.addresses.indexOf(k); if (i < 0) continue;
      (v.writable ? w : r).push(i); fromTable.add(k);
    }
    if (w.length || r.length) lookups.push({ ...table, w, r });
  }
  const statics = [...meta].filter(([k]) => !fromTable.has(k));
  const ordered = [...statics.filter(([k]) => k === payer), ...statics.filter(([k, v]) => k !== payer && v.writable), ...statics.filter(([k, v]) => k !== payer && !v.writable)];
  const keys = ordered.map(([k]) => k), ro = ordered.filter(([, v]) => !v.writable).length;
  const loaded = [...lookups.flatMap((l) => l.w.map((i) => l.addresses[i])), ...lookups.flatMap((l) => l.r.map((i) => l.addresses[i]))];
  const all = [...keys, ...loaded]; if (all.length > 256) throw new Error('too many accounts');
  const idx = new Map(all.map((k, i) => [k, i]));
  const parts = [Buffer.from([128, 1, 0, ro]), compact(keys.length), ...keys.map(b58decode), b58decode(blockhash), compact(instructions.length)];
  for (const ix of instructions) parts.push(Buffer.from([idx.get(ix.programId)]), compact(ix.accounts.length), Buffer.from(ix.accounts.map((a) => idx.get(a.pubkey))), compact(ix.data.length), ix.data);
  parts.push(compact(lookups.length));
  for (const l of lookups) parts.push(b58decode(l.key), compact(l.w.length), Buffer.from(l.w), compact(l.r.length), Buffer.from(l.r));
  const message = Buffer.concat(parts), transaction = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
  if (transaction.length > 1232) throw new Error('transaction exceeds Solana packet limit');
  return { message, transaction };
}
