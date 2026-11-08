import { Buffer } from 'buffer/index.js';
import { SOL, b58encode, accountBytes } from './portable-wire.mjs';

/** Decode the exact serialized transaction; no provider JSON instruction list is trusted. */
export function parseUnsignedV0(serialized) {
  if (typeof serialized !== 'string' || serialized.length > 1644) throw Error('Invalid transaction encoding');
  const tx = Buffer.from(serialized, 'base64');
  if (tx.toString('base64') !== serialized || tx.length > 1232 || tx.length < 70 || tx[0] !== 1 || tx.subarray(1, 65).some(b => b !== 0)) throw Error('Only one unsigned signature is allowed');
  const message = Buffer.from(tx.subarray(65)); let pos = 0;
  const read = n => { if (pos + n > message.length) throw Error('Truncated v0 message'); const b = message.subarray(pos, pos + n); pos += n; return b; };
  const byte = () => read(1)[0];
  const compact = () => {
    let n = 0, count = 0, last;
    do { last = byte(); if (++count > 3 || (count === 3 && last > 3)) throw Error('Invalid shortvec'); n |= (last & 127) << ((count - 1) * 7); } while (last & 128);
    if (count > 1 && (last & 127) === 0) throw Error('Noncanonical shortvec');
    return n;
  };
  if (byte() !== 128 || byte() !== 1 || byte() !== 0) throw Error('Only v0 single writable signer supported');
  const readonly = byte(), keyCount = compact();
  if (keyCount < 2 || keyCount > 128 || readonly >= keyCount) throw Error('Invalid static account header');
  const staticKeys = Array.from({ length: keyCount }, () => b58encode(read(32)));
  const blockhash = b58encode(read(32)), count = compact();
  if (count < 1 || count > 24) throw Error('Invalid instruction count');
  const compiled = Array.from({ length: count }, () => {
    const program = byte(), length = compact(); if (length > 128) throw Error('Too many instruction accounts');
    const indexes = [...read(length)], dataLength = compact();
    return { program, indexes, data: Buffer.from(read(dataLength)) };
  });
  const lookupCount = compact(); if (lookupCount > 8) throw Error('Too many lookup tables');
  const lookups = Array.from({ length: lookupCount }, () => {
    const key = b58encode(read(32)), w = [...read(compact())], r = [...read(compact())];
    if (w.length + r.length > 256 || new Set([...w, ...r]).size !== w.length + r.length) throw Error('Duplicate lookup index');
    return { key, w, r };
  });
  if (pos !== message.length || new Set(staticKeys).size !== staticKeys.length || new Set(lookups.map(l => l.key)).size !== lookups.length) throw Error('Trailing bytes or duplicate account');
  return { message, serialized, trader: staticKeys[0], staticKeys, readonly, blockhash, compiled, lookups };
}

/** Table accounts must come from the vault's RPC, never from the quote response. */
export function resolveV0(parsed, tableAccounts) {
  if (!Array.isArray(tableAccounts) || tableAccounts.length !== parsed.lookups.length) throw Error('Lookup snapshot missing');
  const tables = tableAccounts.map((a, i) => {
    const data = accountBytes(a);
    if (!data || a.owner !== SOL.lookup || data.length < 56 || (data.length - 56) % 32 || data.readUInt32LE(0) !== 1 || data.readBigUInt64LE(4) !== (1n << 64n) - 1n) throw Error('Invalid lookup table');
    const addresses = [];
    for (let n = 56; n < data.length; n += 32) addresses.push(b58encode(data.subarray(n, n + 32)));
    const l = parsed.lookups[i]; if ([...l.w, ...l.r].some(n => n >= addresses.length)) throw Error('Lookup index out of bounds');
    return { ...l, addresses };
  });
  const writable = tables.flatMap(l => l.w.map(n => l.addresses[n]));
  const readonly = tables.flatMap(l => l.r.map(n => l.addresses[n]));
  const keys = [...parsed.staticKeys, ...writable, ...readonly];
  if (keys.length > 256 || new Set(keys).size !== keys.length) throw Error('Invalid resolved accounts');
  const meta = index => {
    if (index >= keys.length) throw Error('Instruction account out of bounds');
    return { pubkey: keys[index], isSigner: index === 0,
      isWritable: index < parsed.staticKeys.length ? index < parsed.staticKeys.length - parsed.readonly : index < parsed.staticKeys.length + writable.length };
  };
  const instructions = parsed.compiled.map(ix => {
    if (ix.program >= parsed.staticKeys.length || meta(ix.program).isWritable || meta(ix.program).isSigner) throw Error('Invalid instruction program');
    return { programId: keys[ix.program], accounts: ix.indexes.map(meta), data: ix.data };
  });
  return { instructions, keys, tables };
}
