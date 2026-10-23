// Solana in the vault: the same trading wallets get a Solana identity, and the
// vault builds, signs and sends pump.fun trades itself — straight to the
// programs, no third-party trade API in between.
//
// Keys: a 32-byte ed25519 seed = sha256("motion/sol/v1/" ‖ the wallet's EVM key);
// address = its public key in base58. The secret never leaves the vault frame
// except through the export dialog (64-byte base58, the Phantom import format).
//
// Venues (pump-fun/pump-public-docs, idl/pump.json + pump_amm.json, October 2026):
// - on the bonding curve: buy_exact_quote_in_v3 (spend exactly N SOL, at least M
//   tokens) and sell_v3 — 17 accounts each. Cashback coins refuse v3 (6094), so
//   they are refused here with a clear message rather than half-supported.
// - after migration: PumpSwap buy_exact_quote_in_v2 / sell_v2 on the canonical
//   pool, through a wrapped-SOL account the transaction opens and closes itself.
// - a coin whose pump market is not SOL (its curve quoted in another token, its PumpSwap pool paired with it)
//   trades on its Meteora DLMM pool against SOL: swap2 on the LB pair (lb_clmm 0.12, on-chain IDL), the quote
//   walked bin by bin from the pool's bin arrays exactly as the program does (fees, volatility, limit orders).
//   The indexer only names candidate pools; the vault reads each one and verifies owner, layout, mints and status.
// Sending — one signed transaction, several roads at once:
//   Fast  · priority fee at Helius "high" + a Jito tip at the landed-tip 75th
//           percentile; sent to Jito and to Helius together, simulated first.
//   Turbo · priority "veryHigh" + a tip near the 95th percentile, no simulation,
//           sent to every Jito region and to Helius.
//   Eco   · priority "medium", no tip, Helius only.
//   The tip and the priority fee can be pinned in the settings (solTip, solPriority).
// Speed (one click, any number of wallets):
//   · the wallets of one click share one read of the market (curve or pool + vaults +
//     fee config) and, for sells, every wallet's token account — one getMultipleAccounts
//     for the whole click, merged per tick (readBatch);
//   · the send plan (Jito tip floor + priority-fee levels) and the blockhash are fetched
//     once, in parallel with that read, never in front of it;
//   · the simulation is unsigned (64 zero bytes, sigVerify off, blockhash replaced), so it
//     starts as soon as the quote is known and no landable trial ever leaves the vault;
//   · the wallets of one click are spread over Jito regions (the public block engine
//     answers 429 to more than ~1 request per second per region);
//   · nothing waits for a confirmation: the hash comes back once one road accepted it,
//     and receipts for every hash in flight are read with one getSignatureStatuses.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { nativeChainOf, nativeSeed } from './nativeKeys.ts';

export type SolAcct = { id: string; name: string; address: string; key?: string; ext?: string };
export type SolSettings = { slippage: number; gasBoost: number; turbo: boolean; solTip?: number; solPriority?: number };
export type SolRoute = { mint: string; venue: 'pump' | 'pumpswap' | 'dlmm'; tokenProgram: string; decimals: number; symbol: string; pool: string; isCashback: boolean; isMayhem: boolean; baseVault?: string; quoteVault?: string; dlmm?: DlmmRoute };
// a Meteora DLMM pool as the vault verified it: which side is SOL, its reserves and oracle (fixed for the pool's life),
// the bin array the active bin sat in when the route was read (which arrays a quote prefetches)
export type DlmmRoute = { solIsX: boolean; reserveX: string; reserveY: string; oracle: string; activeIdx: number; binStep: number };

// ── base58 / bytes ──
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58e(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; }
export function b58d(s: string): Uint8Array { let n = 0n; for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; out.unshift(0); } return Uint8Array.from(out); }
const te = new TextEncoder();
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const compact = (n: number) => { const o: number[] = []; let v = n; for (;;) { let x = v & 0x7f; v >>= 7; if (v) x |= 0x80; o.push(x); if (!v) break; } return Uint8Array.from(o); };
const toB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── programs and fixed accounts ──
export const P = {
  system: '11111111111111111111111111111111', token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', token22: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', budget: 'ComputeBudget111111111111111111111111111111', wsol: 'So11111111111111111111111111111111111111112',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', pamm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', fees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  pumpFeeConfig: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', ammFeeConfig: '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx', ammGlobalConfig: 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
  dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};
const BUYBACK = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL', '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'];
const JITO_TIP = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'];
// the order is the order wallets are handed regions in: the geo-routed global endpoint and the close
// European/US regions first (≈50–115 ms), the far ones (slc/tokyo ≈180–270 ms) last
const JITO_ENDPOINTS = ['https://mainnet.block-engine.jito.wtf', 'https://ny.mainnet.block-engine.jito.wtf', 'https://frankfurt.mainnet.block-engine.jito.wtf', 'https://amsterdam.mainnet.block-engine.jito.wtf', 'https://london.mainnet.block-engine.jito.wtf', 'https://dublin.mainnet.block-engine.jito.wtf', 'https://slc.mainnet.block-engine.jito.wtf', 'https://tokyo.mainnet.block-engine.jito.wtf'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const DISC = {
  buyV3: [225, 247, 80, 30, 213, 179, 132, 136], sellV3: [28, 146, 222, 119, 38, 196, 105, 213],
  ammBuy: [194, 171, 28, 70, 104, 77, 91, 47], ammSell: [93, 246, 130, 60, 231, 233, 64, 178],
  dlmmSwap2: [65, 75, 63, 76, 235, 91, 91, 136],   // lb_clmm swap2 (the IDL on chain, 7UZRobkzaKVm1RbCH5WdFaYCGzCRjnu3prziHAsYiSyr)
};
// Anchor account discriminators the vault checks before it trusts a DLMM account's bytes
const LB_PAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13], BIN_ARRAY_DISC = [92, 142, 92, 220, 5, 148, 70, 181];

// ── program derived addresses ──
const onCurve = (b: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
const pdaCache = new Map<string, string>();
export function pda(seeds: Uint8Array[], program: string): string {
  const key = program + ':' + seeds.map((s) => b58e(s)).join(','); const hit = pdaCache.get(key); if (hit) return hit;
  const prog = b58d(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), prog, te.encode('ProgramDerivedAddress')));
    if (!onCurve(h)) { const a = b58e(h); pdaCache.set(key, a); return a; }
  }
  throw new Error('no PDA');
}
export const ataOf = (owner: string, mint: string, tokenProgram = P.token) => pda([b58d(owner), b58d(tokenProgram), b58d(mint)], P.ata);
const pumpPda = (...s: (string | Uint8Array)[]) => pda(s.map((x) => (typeof x === 'string' ? te.encode(x) : x)), P.pump);
const ammPda = (...s: (string | Uint8Array)[]) => pda(s.map((x) => (typeof x === 'string' ? te.encode(x) : x)), P.pamm);
const dlmmPda = (...s: (string | Uint8Array)[]) => pda(s.map((x) => (typeof x === 'string' ? te.encode(x) : x)), P.dlmm);
const i64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; };
export const binArrayOf = (pool: string, index: number) => dlmmPda('bin_array', b58d(pool), i64(index));
export const dlmmOracleOf = (pool: string) => dlmmPda('oracle', b58d(pool));
export const curveOf = (mint: string) => pumpPda('bonding-curve', b58d(mint));
export function canonicalPool(mint: string) {
  const authority = pumpPda('pool-authority', b58d(mint));
  return pda([te.encode('pool'), Uint8Array.of(0, 0), b58d(authority), b58d(mint), b58d(P.wsol)], P.pamm);
}

// ── keys ──
const seedOf = (evmKeyHex: string) => sha256(cat(te.encode('motion/sol/v1/'), Uint8Array.from((evmKeyHex.replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)))));
const keyCache = new Map<string, { seed: Uint8Array; pub: Uint8Array; address: string }>();
export function solKeys(evmKeyHex: string) {
  const hit = keyCache.get(evmKeyHex); if (hit) return hit;
  // a Solana-only wallet ('sol:' + seed, nativeKeys.ts) IS its seed; every EVM key derives exactly as before
  const own = nativeChainOf(evmKeyHex);
  if (own === 'near') throw new Error('A NEAR wallet has no Solana key');
  const seed = own === 'sol' ? nativeSeed(evmKeyHex) : seedOf(evmKeyHex); const pub = ed25519.getPublicKey(seed); const k = { seed, pub, address: b58e(pub) };
  keyCache.set(evmKeyHex, k); return k;
}
export const solAddressOf = (a: SolAcct) => (a.key && !a.ext && nativeChainOf(a.key) !== 'near' ? solKeys(a.key).address : '');
export const solSecretKey = (evmKeyHex: string) => { const k = solKeys(evmKeyHex); return b58e(cat(k.seed, k.pub)); };
// signs a short text note with the wallet's Solana key (the BGC entry): hex ed25519 signature over the UTF-8 bytes
export const solSignText = (evmKeyHex: string, text: string) => Array.from(ed25519.sign(new TextEncoder().encode(text), solKeys(evmKeyHex).seed), (b) => b.toString(16).padStart(2, '0')).join('');

// ── RPC (through the indexer: the RPC key stays on the server) ──
// Where /sol/api lives: the page's own origin, except inside the isolated vault frame (vault.motion.gift serves no
// API and its CSP allows only the terminal hosts) — there the frame's parent, which webEngine hands in once it binds
let apiBase: () => string = () => (typeof location !== 'undefined' ? location.origin : '');
export function setSolApiBase(fn: () => string) { apiBase = fn; }
const API = (path: string) => apiBase() + '/sol/api' + path;
const RPC_URL = () => API('/rpc');
// Reads go straight from this browser to a public Solana RPC (each visitor has their own limit there);
// sends, simulations and fee estimates go through the indexer to Helius. A 429 is retried with backoff.
// (api.mainnet-beta.solana.com refuses requests that carry a browser Origin; publicnode serves browsers)
const PUBLIC_RPC = 'https://solana-rpc.publicnode.com';
const READS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash', 'getSignatureStatuses', 'getTokenAccountsByOwner']);
let publicDownUntil = 0;
// every call has a deadline: a node that accepts the connection and never answers must not hold a click forever
export class RpcError extends Error { status: number; constructor(m: string, status = 0) { super(m); this.status = status; } }
// what a trader reads when the nodes, not the trade, failed
const READ_FAIL = 'Could not read the chain right now (the Solana nodes did not answer) — nothing was sent; try again';
const nodeText = (e: any) => {
  const m = String(e?.message || e || ''), st = Number(e?.status || 0);
  if (st === 429 || /429|too many|slow down|rate.?limit/i.test(m)) return 'The Solana nodes are rate-limiting this browser — nothing was sent; try again in a few seconds';
  if (st >= 500 || /^RPC 5\d\d/.test(m)) return 'The Solana node is not answering (HTTP ' + (st || m.slice(4, 7)) + ') — nothing was sent; try again';
  if (st === 403 || /request blocked|forbidden/i.test(m)) return 'A Solana node refused the request — nothing was sent; try again';
  if (/timeout|timed out|abort/i.test(String(e?.name || '') + ' ' + m)) return 'The Solana node did not answer in time — nothing was sent; try again';
  return m;
};
async function rpcAt<T>(url: string, method: string, params: unknown[], ms = 10_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
    if (r.status === 429 && attempt < 3) { await new Promise((ok) => setTimeout(ok, 300 * 2 ** attempt + Math.random() * 200)); continue; }
    const j = await r.json().catch(() => null);
    if (j?.error) throw new RpcError(String(j.error.message || 'RPC error'), r.status);
    if (!r.ok || !j || !('result' in j)) throw new RpcError('RPC ' + r.status, r.status);
    return j.result as T;
  }
}
// The user's own Solana nodes (Settings → RPC, rpcs.sol): reads go to them first (one that errors sits out 30 s),
// then publicnode, then the relay; simulations race them too, and every signed transaction is also posted to each
// of them and to any send-only node, beside the usual roads. Nothing here replaces a road — it only adds one.
let USER_READS: string[] = [], USER_SENDS: string[] = [];
const userDown = new Map<string, number>();
const isNode = (u: unknown): u is string => typeof u === 'string' && u.length < 300 && /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(u);
export function setSolRpcs(reads: unknown[] = [], sends: unknown[] = []) {
  USER_READS = [...new Set(reads.filter(isNode))].filter((u) => u !== PUBLIC_RPC).slice(0, 2);
  USER_SENDS = [...new Set(sends.filter(isNode))].filter((u) => u !== PUBLIC_RPC && !USER_READS.includes(u)).slice(0, 3);
  userDown.clear();
  return { rpcs: [...USER_READS, PUBLIC_RPC, RPC_URL()], send: [...USER_SENDS, ...USER_READS, PUBLIC_RPC, RPC_URL()] };
}
export async function solRpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  if (READS.has(method)) for (const u of USER_READS) {
    if (Date.now() < (userDown.get(u) || 0)) continue;
    try { return await rpcAt<T>(u, method, params, 6000); } catch { userDown.set(u, Date.now() + 30_000); }
  }
  if (READS.has(method) && Date.now() > publicDownUntil) {
    try { return await rpcAt<T>(PUBLIC_RPC, method, params); } catch { publicDownUntil = Date.now() + 30_000; }   // any trouble there: the indexer's node answers
  }
  return rpcAt<T>(RPC_URL(), method, params);
}
async function account(addr: string): Promise<{ owner: string; data: Uint8Array; lamports: number } | null> {
  const r = await solRpc<any>('getAccountInfo', [addr, { encoding: 'base64', commitment: 'processed' }]);
  return r?.value ? { owner: r.value.owner, data: fromB64(r.value.data[0]), lamports: r.value.lamports } : null;
}
// publicnode refuses getMultipleAccounts past 10 accounts ("Request blocked", 403 — measured 2026-10-14; the
// indexer's proxy then hit the same node while Helius was down, so a click over 7+ wallets failed outright): every
// multi-account read goes in slices of 10, side by side — more calls, the same one round trip
const MAX_ACCTS = 10;
const slices = <T>(a: T[], n = MAX_ACCTS) => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
// a slice that failed, or answered with the wrong number of accounts, leaves its accounts undefined (not read) —
// never null (absent) and never shifted onto other addresses; only when every slice failed does the read fail
async function accounts(addrs: string[]): Promise<Got[]> {
  const parts = slices(addrs);
  const got = await Promise.allSettled(parts.map((c) => solRpc<any>('getMultipleAccounts', [c, { encoding: 'base64', commitment: 'processed' }])));
  if (got.length && got.every((g) => g.status === 'rejected')) throw (got[0] as PromiseRejectedResult).reason;
  return got.flatMap((g, i) => { const v = g.status === 'fulfilled' && Array.isArray(g.value?.value) && g.value.value.length === parts[i].length ? g.value.value : null; return parts[i].map((_, j) => (v ? (v[j] ? { owner: v[j].owner, data: fromB64(v[j].data[0]), lamports: v[j].lamports } : null) : undefined)); });
}
// Every account asked for in the same tick goes out in one read (≤10 per call, the calls in parallel):
// the wallets of one click start together, so a click over N wallets reads the curve / pool once
// and every wallet's token account with it, instead of N × (curve + fee config + balance).
type Acc = { owner: string; data: Uint8Array; lamports: number } | null;
type Got = Acc | undefined;   // undefined: the read of this account failed
let batchQ: { addrs: Set<string>; done: Promise<Map<string, Got>> } | null = null;
function readBatch(addrs: string[]): Promise<Got[]> {
  if (!batchQ) {
    const addrsSet = new Set<string>();
    const done = new Promise<Map<string, Got>>((resolve, reject) => setTimeout(() => {
      batchQ = null; const list = [...addrsSet];
      accounts(list).then((res) => { const m = new Map<string, Got>(); list.forEach((x, i) => m.set(x, res[i])); resolve(m); }, reject);
    }, 0));
    batchQ = { addrs: addrsSet, done };
  }
  const q = batchQ; for (const x of addrs) q.addrs.add(x);
  return q.done.then((m) => addrs.map((x) => m.get(x)));
}
const rdU64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
const rdI128 = (d: Uint8Array, o: number) => { const v = new DataView(d.buffer, d.byteOffset); return (v.getBigInt64(o + 8, true) << 64n) | v.getBigUint64(o, true); };
const rdKey = (d: Uint8Array, o: number) => b58e(d.subarray(o, o + 32));
const rdU128 = (d: Uint8Array, o: number) => { const v = new DataView(d.buffer, d.byteOffset); return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true); };
const rdI32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getInt32(o, true);
const rdU16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getUint16(o, true);
const rdU32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getUint32(o, true);
const hasDisc = (d: Uint8Array, disc: number[]) => d.length >= 8 && disc.every((b, i) => d[i] === b);

// ── transactions ──
type Meta = { pubkey: string; signer: boolean; writable: boolean };
type Ix = { program: string; keys: Meta[]; data: Uint8Array };
const ix = (program: string, keys: [string, boolean, boolean][], data: Uint8Array): Ix => ({ program, keys: keys.map(([pubkey, signer, writable]) => ({ pubkey, signer, writable })), data });
// legacy message: [header][keys][blockhash][instructions]
export function compileLegacy(payer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const m = new Map<string, { s: boolean; w: boolean }>();
  const add = (k: string, s: boolean, w: boolean) => { const x = m.get(k); if (x) { x.s ||= s; x.w ||= w; } else m.set(k, { s, w }); };
  add(payer, true, true);
  for (const i of ixs) { for (const k of i.keys) add(k.pubkey, k.signer, k.writable); add(i.program, false, false); }
  const all = [...m.entries()];
  const ordered = [
    ...all.filter(([k]) => k === payer),
    ...all.filter(([k, v]) => k !== payer && v.s && v.w), ...all.filter(([k, v]) => k !== payer && v.s && !v.w),
    ...all.filter(([, v]) => !v.s && v.w), ...all.filter(([, v]) => !v.s && !v.w),
  ];
  const keys = ordered.map(([k]) => k); const idx = new Map(keys.map((k, i) => [k, i]));
  const nSig = ordered.filter(([, v]) => v.s).length, nRoSig = ordered.filter(([, v]) => v.s && !v.w).length, nRo = ordered.filter(([, v]) => !v.s && !v.w).length;
  const body: Uint8Array[] = [Uint8Array.of(nSig, nRoSig, nRo), compact(keys.length), ...keys.map((k) => b58d(k).length === 32 ? b58d(k) : (() => { throw new Error('bad key ' + k); })()), b58d(blockhash), compact(ixs.length)];
  for (const i of ixs) body.push(Uint8Array.of(idx.get(i.program)!), compact(i.keys.length), Uint8Array.from(i.keys.map((k) => idx.get(k.pubkey)!)), compact(i.data.length), i.data);
  return cat(...body);
}
// v0 message with address lookup tables (the Relay bridge hands instructions + a table)
export function compileV0(payer: string, ixs: Ix[], blockhash: string, tables: { key: string; addresses: string[] }[]): Uint8Array {
  const m = new Map<string, { s: boolean; w: boolean; invoked: boolean }>();
  const add = (k: string, s: boolean, w: boolean, invoked = false) => { const x = m.get(k); if (x) { x.s ||= s; x.w ||= w; x.invoked ||= invoked; } else m.set(k, { s, w, invoked }); };
  add(payer, true, true);
  for (const i of ixs) { for (const k of i.keys) add(k.pubkey, k.signer, k.writable); add(i.program, false, false, true); }
  // anything that is not a signer and not a program id may come from a table
  const lookups: { key: string; w: number[]; r: number[] }[] = []; const fromTable = new Map<string, { t: number; w: boolean }>();
  for (const t of tables) {
    const look = { key: t.key, w: [] as number[], r: [] as number[] };
    for (const [k, v] of m) { if (v.s || v.invoked || fromTable.has(k)) continue; const at = t.addresses.indexOf(k); if (at < 0) continue; (v.w ? look.w : look.r).push(at); fromTable.set(k, { t: lookups.length, w: v.w }); }
    if (look.w.length || look.r.length) lookups.push(look);
  }
  const statics = [...m.entries()].filter(([k]) => !fromTable.has(k));
  const ordered = [
    ...statics.filter(([k]) => k === payer),
    ...statics.filter(([k, v]) => k !== payer && v.s && v.w), ...statics.filter(([k, v]) => k !== payer && v.s && !v.w),
    ...statics.filter(([, v]) => !v.s && v.w), ...statics.filter(([, v]) => !v.s && !v.w),
  ];
  const keys = ordered.map(([k]) => k);
  // account indexes: statics, then every table's writable, then every table's readonly
  const loadedW: string[] = [], loadedR: string[] = [];
  for (const l of lookups) { const t = tables.find((x) => x.key === l.key)!; for (const i of l.w) loadedW.push(t.addresses[i]); }
  for (const l of lookups) { const t = tables.find((x) => x.key === l.key)!; for (const i of l.r) loadedR.push(t.addresses[i]); }
  const all = [...keys, ...loadedW, ...loadedR]; const idx = new Map(all.map((k, i) => [k, i]));
  const nSig = ordered.filter(([, v]) => v.s).length, nRoSig = ordered.filter(([, v]) => v.s && !v.w).length, nRo = ordered.filter(([, v]) => !v.s && !v.w).length;
  const body: Uint8Array[] = [Uint8Array.of(0x80), Uint8Array.of(nSig, nRoSig, nRo), compact(keys.length), ...keys.map((k) => b58d(k)), b58d(blockhash), compact(ixs.length)];
  for (const i of ixs) body.push(Uint8Array.of(idx.get(i.program)!), compact(i.keys.length), Uint8Array.from(i.keys.map((k) => idx.get(k.pubkey)!)), compact(i.data.length), i.data);
  body.push(compact(lookups.length));
  for (const l of lookups) body.push(b58d(l.key), compact(l.w.length), Uint8Array.from(l.w), compact(l.r.length), Uint8Array.from(l.r));
  return cat(...body);
}
export function signMessage(message: Uint8Array, seed: Uint8Array) { const sig = ed25519.sign(message, seed); return { sig, tx: cat(compact(1), sig, message) }; }
const budget = (units: number, microLamports: number): Ix[] => [ix(P.budget, [], cat(Uint8Array.of(2), u32(units))), ix(P.budget, [], cat(Uint8Array.of(3), u64(BigInt(Math.max(0, Math.floor(microLamports))))))];
const transferIx = (from: string, to: string, lamports: bigint) => ix(P.system, [[from, true, true], [to, false, true]], cat(u32(2), u64(lamports)));
const ataCreate = (payer: string, owner: string, mint: string, tokenProgram: string) => ix(P.ata, [[payer, true, true], [ataOf(owner, mint, tokenProgram), false, true], [owner, false, false], [mint, false, false], [P.system, false, false], [tokenProgram, false, false]], Uint8Array.of(1));
const syncNative = (acc: string) => ix(P.token, [[acc, false, true]], Uint8Array.of(17));
const closeAcc = (acc: string, dest: string, owner: string, tokenProgram = P.token) => ix(tokenProgram, [[acc, false, true], [dest, false, true], [owner, true, false]], Uint8Array.of(9));

// ── state of a coin on chain ──
type Curve = { vTok: bigint; vQuote: bigint; realTok: bigint; realQuote: bigint; supply: bigint; complete: boolean; creator: string; mayhem: boolean; cashback: boolean; quoteMint: string; creatorFeeBps: bigint };
function decodeCurve(d: Uint8Array): Curve {
  return { vTok: rdU64(d, 8), vQuote: rdU64(d, 16), realTok: rdU64(d, 24), realQuote: rdU64(d, 32), supply: rdU64(d, 40), complete: d[48] === 1, creator: rdKey(d, 49), mayhem: d[81] === 1, cashback: d[82] === 1, quoteMint: d.length >= 115 ? rdKey(d, 83) : P.system, creatorFeeBps: d.length >= 123 ? rdU64(d, 115) : 0n };
}
type Tier = { threshold: bigint; lp: bigint; protocol: bigint; creator: bigint };
function decodeFeeConfig(d: Uint8Array): { flat: Tier; tiers: Tier[] } {
  let o = 8 + 1 + 32; const fees = () => { const lp = rdU64(d, o), protocol = rdU64(d, o + 8), creator = rdU64(d, o + 16); o += 24; return { lp, protocol, creator }; };
  const flat = { threshold: 0n, ...fees() };
  const n = new DataView(d.buffer, d.byteOffset).getUint32(o, true); o += 4; const tiers: Tier[] = [];
  for (let i = 0; i < n && i < 64; i++) { const lo = rdU64(d, o), hi = rdU64(d, o + 8); o += 16; tiers.push({ threshold: (hi << 64n) | lo, ...fees() }); }
  return { flat, tiers };
}
const feeCfgCache = new Map<string, { at: number; v: { flat: Tier; tiers: Tier[] } }>();
const feeCfgFresh = (addr: string) => { const hit = feeCfgCache.get(addr); return hit && Date.now() - hit.at < 300000 ? hit.v : null; };
// the fee config rides in the same getMultipleAccounts as the curve / pool when it is not cached
function feeConfigFrom(addr: string, acc: Acc) {
  const hit = feeCfgFresh(addr); if (hit) return hit;
  if (!acc) throw new Error('fee config not found');
  const v = decodeFeeConfig(acc.data); feeCfgCache.set(addr, { at: Date.now(), v }); return v;
}
function tierFor(cfg: { flat: Tier; tiers: Tier[] }, mcapLamports: bigint): Tier {
  const t = cfg.tiers; if (!t.length) return cfg.flat;
  if (mcapLamports < t[0].threshold) return t[0];
  for (let i = t.length - 1; i >= 0; i--) if (mcapLamports >= t[i].threshold) return t[i];
  return t[0];
}
const ceilFee = (amount: bigint, bps: bigint) => (amount * bps + 9999n) / 10000n;

// ── route ──
const routeCache = new Map<string, { at: number; r: SolRoute }>();
const routeLoads = new Map<string, Promise<SolRoute>>();
// the wallets of a click (and a re-route after the curve completed) share one route read per mint
export function solRoute(mint: string, hint?: any): Promise<SolRoute> {
  if (!SOL_ADDR.test(mint)) return Promise.reject(new Error('Invalid Solana mint'));
  solWarm();   // tip floor, fee levels and a blockhash start loading while the route is checked (hover / click)
  const hit = routeCache.get(mint); if (hit && Date.now() - hit.at < 20000) return Promise.resolve(hit.r);
  let p = routeLoads.get(mint);
  if (!p) { p = loadRoute(mint, hint).finally(() => routeLoads.delete(mint)); routeLoads.set(mint, p); }
  return p;
}
async function loadRoute(mint: string, hint?: any): Promise<SolRoute> {
  // the hint only names the symbol: it is fetched beside the chain read, never in front of it
  const hP = hint && hint.chain === 'sol' && hint.mint === mint ? Promise.resolve(hint) : fetch(API('/token/' + mint + '/route'), { signal: AbortSignal.timeout(4000) }).then((x) => x.json()).catch(() => null);
  // the facts that decide what gets signed are read from the chain, not taken from the hint: mint, curve and the
  // canonical PumpSwap pool (derived from the mint) in one read, so a migrated coin costs no second round trip
  const pool0 = canonicalPool(mint);
  const [mintAcc, curveAcc, poolAcc] = await accounts([mint, curveOf(mint), pool0]);
  if (mintAcc === undefined || curveAcc === undefined || poolAcc === undefined) throw new Error(READ_FAIL);
  if (!mintAcc) throw new Error('Unknown mint');
  const tokenProgram = mintAcc.owner; if (tokenProgram !== P.token && tokenProgram !== P.token22) throw new Error('Not an SPL token');
  const decimals = mintAcc.data[44];
  let venue: SolRoute['venue'] = 'pumpswap'; let isCashback = false, isMayhem = false; let pool = '';
  let baseVault: string | undefined, quoteVault: string | undefined, dlmm: DlmmRoute | undefined;
  // why pump.fun has no SOL market for this coin (then its Meteora DLMM pool against SOL is the venue, if it has one)
  let noPumpSol = '';
  if (curveAcc && curveAcc.owner === P.pump) {
    const c = decodeCurve(curveAcc.data); isCashback = c.cashback; isMayhem = c.mayhem;
    if (c.quoteMint !== P.system && c.quoteMint !== P.wsol) noPumpSol = 'This coin\'s pump.fun market is quoted in another token, not SOL';
    venue = c.complete ? 'pumpswap' : 'pump';
  } else noPumpSol = 'Not a pump.fun coin: no curve and no PumpSwap pool';
  if (!noPumpSol && venue === 'pumpswap') {
    pool = pool0;
    const pa = poolAcc;
    if (!pa || pa.owner !== P.pamm) noPumpSol = 'The curve is complete and its PumpSwap pool is not open yet — try again in a few seconds';
    else {
      if (rdKey(pa.data, 43) !== mint || rdKey(pa.data, 75) !== P.wsol) throw new Error('Pool does not match the coin');
      isCashback = pa.data[8 + 1 + 2 + 32 * 6 + 8 + 32 + 1] === 1;
      // the pool's vaults never change: knowing them here lets a quote read pool + vaults in one call
      baseVault = rdKey(pa.data, 139); quoteVault = rdKey(pa.data, 171);
    }
  }
  if (noPumpSol) {
    // the indexer names candidate DLMM pools (it found them by program-account search); nothing in that list is
    // trusted: every candidate is read here and must be an enabled LB pair of this mint against SOL
    let h = await hP;
    if (!Array.isArray(h?.dlmm)) h = await fetch(API('/token/' + mint + '/route'), { signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null);   // a page hint names no pools: the indexer's route does
    const named: string[] = Array.isArray(h?.dlmm) ? h.dlmm.filter((x: unknown) => typeof x === 'string' && SOL_ADDR.test(x)).slice(0, 8) : [];
    const found = named.length ? await dlmmPoolsOf(mint, named) : [];
    if (!found.length) throw new Error(noPumpSol + (named.length ? ' — its Meteora DLMM pools could not be verified' : /not open yet/.test(noPumpSol) ? '' : ' — and no Meteora DLMM pool against SOL was found'));
    const ext = mintExtensions(mintAcc.data);
    if (ext.has(1)) throw new Error('This coin charges a transfer fee (Token-2022) — not supported here');
    if (ext.has(14)) throw new Error('This coin carries a transfer hook (Token-2022) — not supported here');
    const best = found[0]; venue = 'dlmm'; pool = best.pool; isCashback = false; dlmm = best.route;
  }
  const h = await Promise.race([hP, Promise.resolve(null)]);   // a symbol not here yet is not worth waiting for
  const r: SolRoute = { mint, venue, tokenProgram, decimals, symbol: String(h?.symbol || ''), pool, isCashback, isMayhem, baseVault, quoteVault, dlmm };
  routeCache.set(mint, { at: Date.now(), r }); return r;
}
// the TLV extensions of a Token-2022 mint (type → present); a classic mint has none
function mintExtensions(d: Uint8Array): Set<number> {
  const out = new Set<number>(); if (d.length <= 166 || d[165] !== 1) return out;
  const v = new DataView(d.buffer, d.byteOffset);
  for (let o = 166; o + 4 <= d.length;) { const t = v.getUint16(o, true), n = v.getUint16(o + 2, true); if (!t && !n) break; out.add(t); o += 4 + n; }
  return out;
}
// the named pools, verified on chain and ordered by their SOL reserve (the deepest first); a candidate that is not
// an enabled LB pair of exactly this mint and SOL is dropped, never used
async function dlmmPoolsOf(mint: string, named: string[]): Promise<{ pool: string; route: DlmmRoute; solReserve: bigint }[]> {
  const accs = await readBatch(named);
  if (accs.every((a) => a === undefined)) throw new Error(READ_FAIL);
  const ok: { pool: string; route: DlmmRoute }[] = [];
  for (let i = 0; i < named.length; i++) {
    const a = accs[i]; if (!a || a.owner !== P.dlmm || a.data.length < 904 || !hasDisc(a.data, LB_PAIR_DISC)) continue;
    const lb = decodeLbPair(a.data);
    const solIsX = lb.tokenX === P.wsol && lb.tokenY === mint, solIsY = lb.tokenY === P.wsol && lb.tokenX === mint;
    if (!solIsX && !solIsY) continue;
    if (lb.status !== 0) continue;   // PairStatus::Disabled
    // a permissioned / customizable pair opens at its activation point (slot or unix time); slot-gated ones are left
    // to the simulation, time-gated ones that are not open yet are skipped here
    if ((lb.pairType === 1 || lb.pairType === 2) && lb.activationType === 1 && Number(lb.activationPoint) > Date.now() / 1000) continue;
    if (lb.oracle !== dlmmOracleOf(named[i])) continue;
    ok.push({ pool: named[i], route: { solIsX, reserveX: lb.reserveX, reserveY: lb.reserveY, oracle: lb.oracle, activeIdx: binArrayIndex(lb.activeId), binStep: lb.binStep } });
  }
  if (!ok.length) return [];
  const res = await readBatch(ok.map((p) => (p.route.solIsX ? p.route.reserveX : p.route.reserveY)));
  const out = ok.map((p, i) => ({ ...p, solReserve: res[i] && res[i]!.data.length >= 72 ? rdU64(res[i]!.data, 64) : 0n }));
  return out.sort((a, b) => (a.solReserve === b.solReserve ? a.route.binStep - b.route.binStep : a.solReserve > b.solReserve ? -1 : 1));
}

// ── quotes ──
// what a quote needs, as one list of accounts (fee config only when it is not cached)
function marketAddrs(r: SolRoute): string[] {
  if (r.venue === 'pump') return [curveOf(r.mint), ...(feeCfgFresh(P.pumpFeeConfig) ? [] : [P.pumpFeeConfig])];
  // DLMM: the pair and the bin arrays around the active bin (a quote reads further ones only when the walk gets there)
  if (r.venue === 'dlmm' && r.dlmm) return [r.pool, binArrayOf(r.pool, r.dlmm.activeIdx - 1), binArrayOf(r.pool, r.dlmm.activeIdx), binArrayOf(r.pool, r.dlmm.activeIdx + 1)];
  if (!r.baseVault || !r.quoteVault) return [r.pool];
  return [r.pool, r.baseVault, r.quoteVault, ...(feeCfgFresh(P.ammFeeConfig) ? [] : [P.ammFeeConfig])];
}
type Market = Map<string, Acc>;
// the market accounts plus any extra accounts (a seller's token account) in the same tick's batch
// The market accounts of one click are read once: a click over many wallets runs them through a bounded pool, so
// later wallets start ticks after the first ones and would each re-read the curve / pool. A read younger than
// 1.5 s is shared (the quote's slippage covers that much drift); each wallet's own accounts are always fresh.
const marketMemo = new Map<string, { at: number; p: Promise<Got[]> }>();
async function readMarket(r: SolRoute, extra: string[] = []): Promise<{ m: Market; extra: Got[] }> {
  const addrs = marketAddrs(r); const k = addrs.join(',');
  let hit = marketMemo.get(k);
  if (!hit || Date.now() - hit.at > 1500) {
    hit = { at: Date.now(), p: readBatch(addrs) }; marketMemo.set(k, hit);
    const mine = hit; mine.p.then((g) => { if (g.some((x) => x === undefined) && marketMemo.get(k) === mine) marketMemo.delete(k); }, () => { if (marketMemo.get(k) === mine) marketMemo.delete(k); });
    if (marketMemo.size > 50) marketMemo.delete(marketMemo.keys().next().value as string);
  }
  const [mk, ex] = await Promise.all([hit.p, extra.length ? readBatch(extra) : Promise.resolve([] as Got[])]);
  if (mk.some((x) => x === undefined)) throw new Error(READ_FAIL);
  return { m: new Map(addrs.map((a, i) => [a, mk[i] as Acc] as [string, Acc])), extra: ex };
}
async function quotePump(mint: string, side: 'buy' | 'sell', amountIn: bigint, pre?: Market) {
  const curve = curveOf(mint);
  let m = pre;
  if (!m || !m.has(curve)) { const got = await readBatch([curve, P.pumpFeeConfig]); if (got[0] === undefined || got[1] === undefined) throw new Error(READ_FAIL); m = new Map([[curve, got[0]], [P.pumpFeeConfig, got[1]]]); }
  const curveAcc = m.get(curve); if (!curveAcc) throw new Error('Curve not found');
  const c = decodeCurve(curveAcc.data); if (c.complete) throw new Error(CURVE_DONE);
  const cfg = feeConfigFrom(P.pumpFeeConfig, m.get(P.pumpFeeConfig) ?? null);
  const supply = c.mayhem ? c.supply : 1_000_000_000_000_000n;
  const mcap = c.vTok > 0n ? (c.vQuote * supply) / c.vTok : 0n;
  const tier = tierFor(cfg, mcap);
  const creatorBps = c.creator === P.system ? 0n : (c.creatorFeeBps > 0n ? c.creatorFeeBps : tier.creator);
  const rates = { protocol: tier.protocol, creator: creatorBps };
  const fees = (x: bigint) => ceilFee(x, rates.protocol) + ceilFee(x, rates.creator);
  if (side === 'buy') {
    const total = rates.protocol + rates.creator;
    let net = total === 0n ? amountIn : (amountIn * 10000n) / (total + 10000n);
    const cost = net + fees(net); if (cost > amountIn) net -= cost - amountIn;
    if (net <= 1n) return { out: 0n, curve: c, rates };
    let tokens = ((net - 1n) * c.vTok) / (c.vQuote + net - 1n);
    if (tokens > c.realTok && !c.mayhem) tokens = c.realTok;   // the part past the curve buys from the pool-to-be at a worse price; quote the curve part
    return { out: tokens, curve: c, rates };
  }
  const gross = (amountIn * c.vQuote) / (c.vTok + amountIn);
  return { out: gross - fees(gross), curve: c, rates };
}
async function quoteAmm(r: SolRoute, side: 'buy' | 'sell', amountIn: bigint, pre?: Market) {
  const m = pre && pre.has(r.pool) ? pre : (await readMarket(r)).m;
  const pa = m.get(r.pool); if (!pa) throw new Error('Pool not found');
  const baseVault = rdKey(pa.data, 139), quoteVault = rdKey(pa.data, 171);
  const vq = rdI128(pa.data, 8 + 1 + 2 + 32 * 6 + 8 + 32 + 1 + 1);
  // a route from before the vaults were cached reads them in a second call
  const [bv, qv] = m.has(baseVault) && m.has(quoteVault) ? [m.get(baseVault) ?? null, m.get(quoteVault) ?? null] : await readBatch([baseVault, quoteVault]);
  if (bv === undefined || qv === undefined) throw new Error(READ_FAIL);
  if (!bv || !qv) throw new Error('Pool vaults not found');
  const base = rdU64(bv.data, 64), quote = rdU64(qv.data, 64) + vq;
  let cfg: { flat: Tier; tiers: Tier[] } | null = null;
  try { cfg = feeConfigFrom(P.ammFeeConfig, m.has(P.ammFeeConfig) ? m.get(P.ammFeeConfig) ?? null : (await readBatch([P.ammFeeConfig]))[0] ?? null); } catch {}
  const mcap = base > 0n ? (quote * 1_000_000_000_000_000n) / base : 0n;
  const tier = cfg ? tierFor(cfg, mcap) : { threshold: 0n, lp: 20n, protocol: 5n, creator: 5n };
  const totalBps = tier.lp + tier.protocol + tier.creator;
  if (side === 'buy') { const net = (amountIn * 10000n) / (10000n + totalBps); return { out: (base * net) / (quote + net), baseVault, quoteVault, totalBps }; }
  const gross = (quote * amountIn) / (base + amountIn); return { out: gross - ceilFee(gross, totalBps), baseVault, quoteVault, totalBps };
}

// ── Meteora DLMM: the pool's state, its math, a quote walked bin by bin ──
// Layouts from the program's on-chain IDL (lb_clmm 0.12.0): LbPair 904 bytes, BinArray 8 + 48 + 70 × 144 bytes.
type LbPair = {
  baseFactor: number; filterPeriod: number; decayPeriod: number; reductionFactor: number; variableFeeControl: number; maxVolatilityAccumulator: number;
  protocolShare: number; baseFeePowerFactor: number; functionType: number; collectFeeMode: number;
  va: number; vref: number; indexRef: number; lastUpdate: bigint;
  pairType: number; activeId: number; binStep: number; status: number; activationType: number;
  tokenX: string; tokenY: string; reserveX: string; reserveY: string; rewardMints: string[]; oracle: string; bitmap: bigint[]; activationPoint: bigint; flagX: number; flagY: number;
};
function decodeLbPair(d: Uint8Array): LbPair {
  return {
    baseFactor: rdU16(d, 8), filterPeriod: rdU16(d, 10), decayPeriod: rdU16(d, 12), reductionFactor: rdU16(d, 14), variableFeeControl: rdU32(d, 16), maxVolatilityAccumulator: rdU32(d, 20),
    protocolShare: rdU16(d, 32), baseFeePowerFactor: d[34], functionType: d[35], collectFeeMode: d[36],
    va: rdU32(d, 40), vref: rdU32(d, 44), indexRef: rdI32(d, 48), lastUpdate: new DataView(d.buffer, d.byteOffset).getBigInt64(56, true),
    pairType: d[75], activeId: rdI32(d, 76), binStep: rdU16(d, 80), status: d[82], activationType: d[86],
    tokenX: rdKey(d, 88), tokenY: rdKey(d, 120), reserveX: rdKey(d, 152), reserveY: rdKey(d, 184), rewardMints: [rdKey(d, 264), rdKey(d, 264 + 144)], oracle: rdKey(d, 552),
    bitmap: Array.from({ length: 16 }, (_, i) => rdU64(d, 584 + 8 * i)), activationPoint: rdU64(d, 816), flagX: d[880], flagY: d[881],
  };
}
const BINS_PER_ARRAY = 70, BITMAP_SIZE = 512, BIN_SIZE = 144, BINS_AT = 56;
export const binArrayIndex = (binId: number) => Math.floor(binId / BINS_PER_ARRAY);
const U128 = (1n << 128n) - 1n, Q64 = 1n << 64n;
const FEE_PRECISION = 1_000_000_000n, MAX_FEE_RATE = 100_000_000n, LIMIT_ORDER_FEE_SHARE = 5000n;
// (1 + bin_step / 10000) ^ id in Q64.64, bit for bit the program's u64x64_math::pow (19 exponent bits, the base
// inverted first so no product overflows 128 bits); null where the program would overflow
export function dlmmPow(base: bigint, exp: number): bigint | null {
  let invert = exp < 0; if (exp === 0) return Q64;
  const e = Math.abs(exp); if (e >= 0x80000) return null;
  let sq = base, result = Q64;
  if (sq >= result) { sq = U128 / sq; invert = !invert; }
  for (let bit = 1; bit <= 0x40000; bit <<= 1) {
    if (bit > 1) { const s2 = sq * sq; if (s2 > U128) return null; sq = s2 >> 64n; }
    if (e & bit) { const r = result * sq; if (r > U128) return null; result = r >> 64n; }
  }
  if (result === 0n) return null;
  return invert ? U128 / result : result;
}
export const dlmmPrice = (binId: number, binStep: number) => dlmmPow(Q64 + ((BigInt(binStep) << 64n) / 10000n), binId);
const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;
const fits64 = (v: bigint) => v <= 0xffffffffffffffffn;
// out for in and in for out at a bin's price (Q64.64), the program's rounding
const binOut = (amountIn: bigint, price: bigint, forY: boolean) => (forY ? (price * amountIn) >> 64n : (amountIn << 64n) / price);
const binIn = (amountOut: bigint, price: bigint, forY: boolean) => (forY ? divUp(amountOut << 64n, price) : divUp(amountOut * price, Q64));
// the pool's fee rate (1e9 = 100 %) at a volatility accumulator: base fee + variable fee, capped at 10 %
const dlmmTotalFee = (lb: LbPair, va: number) => {
  const base = BigInt(lb.baseFactor) * BigInt(lb.binStep) * 10n * 10n ** BigInt(lb.baseFeePowerFactor);
  const sq = (BigInt(va) * BigInt(lb.binStep)) ** 2n;
  const variable = lb.variableFeeControl > 0 ? (BigInt(lb.variableFeeControl) * sq + 99_999_999_999n) / 100_000_000_000n : 0n;
  const t = base + variable; return t > MAX_FEE_RATE ? MAX_FEE_RATE : t;
};
const feeOn = (amount: bigint, rate: bigint) => divUp(amount * rate, FEE_PRECISION - rate);          // fee to add on top of a net amount
const feeFrom = (amount: bigint, rate: bigint) => divUp(amount * rate, FEE_PRECISION);              // fee inside a gross amount
type Bin = { ax: bigint; ay: bigint; price: bigint; open: bigint; processed: bigint; ask: boolean };
const binAt = (arr: Uint8Array, i: number): Bin => { const o = BINS_AT + i * BIN_SIZE; return { ax: rdU64(arr, o), ay: rdU64(arr, o + 8), price: rdU128(arr, o + 16), open: rdU64(arr, o + 112), processed: rdU64(arr, o + 128), ask: arr[o + 140] !== 0 }; };
// the bitmap bit of a bin array index (the pair's own bitmap covers −512 … 511)
const bitmapHas = (bm: bigint[], idx: number) => { const o = idx + BITMAP_SIZE; return o >= 0 && o < 1024 && ((bm[o >> 6] >> BigInt(o & 63)) & 1n) === 1n; };
// the next bin array with liquidity from `from` in the swap direction (inclusive), inside the pair's own bitmap;
// null past it (the extension bitmap) — a swap that deep is refused rather than guessed
function nextArrayWithLiquidity(bm: bigint[], from: number, forY: boolean): number | null {
  for (let i = from; i >= -BITMAP_SIZE && i < BITMAP_SIZE; i += forY ? -1 : 1) if (bitmapHas(bm, i)) return i;
  return null;
}
export type DlmmQuote = { out: bigint; fee: bigint; binArrays: string[]; endId: number; lb: LbPair };
const DLMM_DRY = 'The pool has too little liquidity for this trade';
// The exact-in quote the program computes (commons/src/quote.rs of the SDK, lb_clmm 0.12): references and the
// volatility accumulator updated as a swap would, each bin filled from market-making liquidity, then processed and
// open limit orders where the pair supports them, the fee on the input or on the output per collect_fee_mode.
// Bin arrays are read as the walk needs them (the three around the active bin come with the market read).
async function quoteDlmm(r: SolRoute, side: 'buy' | 'sell', amountIn: bigint, pre?: Market): Promise<DlmmQuote> {
  const d = r.dlmm; if (!d) throw new Error('No DLMM pool on this route');
  const m: Market = pre && pre.has(r.pool) ? pre : (await readMarket(r)).m;
  const pa = m.get(r.pool); if (!pa) throw new Error('Pool not found');
  if (pa.owner !== P.dlmm || !hasDisc(pa.data, LB_PAIR_DISC)) throw new Error('Pool does not match the coin');
  const lb = decodeLbPair(pa.data);
  if (lb.status !== 0) throw new Error('Meteora has this pool disabled');
  const forY = side === 'buy' ? d.solIsX : !d.solIsX;   // selling X for Y walks bins down, selling Y for X walks up
  // references: a swap older than the filter period re-anchors the volatility reference (decayed inside the decay period)
  const now = BigInt(Math.floor(Date.now() / 1000)); const elapsed = now - lb.lastUpdate;
  let indexRef = lb.indexRef, vref = lb.vref, va = lb.va;
  if (elapsed >= BigInt(lb.filterPeriod)) { indexRef = lb.activeId; vref = elapsed < BigInt(lb.decayPeriod) ? Math.floor((lb.va * lb.reductionFactor) / 10000) : 0; }
  const limitOrders = lb.functionType === 2 || (lb.functionType === 0 && lb.rewardMints.every((x) => x === P.system));
  const feeOnInput = lb.collectFeeMode === 1 ? !forY : true;
  let activeId = lb.activeId, left = amountIn, out = 0n, fee = 0n;
  const arrays: string[] = []; const loads = new Map<string, Promise<Got[]>>();
  const arrayBytes = async (idx: number): Promise<Uint8Array> => {
    const key = binArrayOf(r.pool, idx);
    let acc: Got = m.has(key) ? m.get(key) : undefined;
    if (acc === undefined) { let p = loads.get(key); if (!p) { p = readBatch([key]); loads.set(key, p); } acc = (await p)[0]; if (acc === undefined) throw new Error(READ_FAIL); m.set(key, acc); }
    if (!acc || acc.owner !== P.dlmm || !hasDisc(acc.data, BIN_ARRAY_DISC) || acc.data.length < BINS_AT + BINS_PER_ARRAY * BIN_SIZE) throw new Error('Pool liquidity not found on chain');
    if (rdKey(acc.data, 24) !== r.pool || Number(new DataView(acc.data.buffer, acc.data.byteOffset).getBigInt64(8, true)) !== idx) throw new Error('Pool liquidity does not match the pool');
    return acc.data;
  };
  for (let guard = 0; left > 0n; guard++) {
    if (guard > 40) throw new Error(DLMM_DRY);
    const idx = nextArrayWithLiquidity(lb.bitmap, binArrayIndex(activeId), forY);
    if (idx === null) throw new Error(DLMM_DRY);
    const bytes = await arrayBytes(idx); const key = binArrayOf(r.pool, idx); if (!arrays.includes(key)) arrays.push(key);
    // an empty gap between the active bin and this array: the walk resumes at the array's near edge
    if (binArrayIndex(activeId) !== idx) activeId = forY ? idx * BINS_PER_ARRAY + BINS_PER_ARRAY - 1 : idx * BINS_PER_ARRAY;
    while (left > 0n && binArrayIndex(activeId) === idx) {
      const b = binAt(bytes, activeId - idx * BINS_PER_ARRAY);
      const [open, processed] = limitOrders && ((forY && !b.ask) || (!forY && b.ask)) ? [b.open, b.processed] : [0n, 0n];
      const mm = forY ? b.ay : b.ax;
      if (mm + open + processed > 0n) {
        va = Math.min(vref + Math.abs(indexRef - activeId) * 10000, lb.maxVolatilityAccumulator);
        const rate = dlmmTotalFee(lb, va);
        let price = b.price; if (price === 0n) { const p = dlmmPrice(activeId, lb.binStep); if (p === null) throw new Error('Bin price overflow'); price = p; }
        // the fill in this bin: market-making liquidity first, then processed, then open limit orders
        let fIn = feeOnInput ? feeFrom(left, rate) : 0n; let net = left - fIn;
        let used = 0n, got = 0n;
        for (const cap of [mm, processed, open]) {
          if (net <= 0n || cap === 0n) continue;
          const maxIn = binIn(cap, price, forY);
          if (net >= maxIn) { used += maxIn; got += cap; net -= maxIn; } else { used += net; got += binOut(net, price, forY); net = 0n; }
        }
        let gross = left;
        if (net > 0n) { gross = feeOnInput ? used + (fIn = feeOn(used, rate)) : used; }   // the bin ran dry: only what it took is spent
        let netOut = got;
        if (!feeOnInput) { const f = feeFrom(got, rate); fee += f; netOut = got - f; } else fee += fIn;
        if (!fits64(gross) || !fits64(netOut)) throw new Error('Amount overflow');
        if (gross > 0n) { left -= gross; out += netOut; }
      }
      if (left > 0n) { activeId += forY ? -1 : 1; if (activeId < -443636 || activeId > 443636) throw new Error(DLMM_DRY); }
    }
  }
  // one more array with liquidity beyond the walk rides along: the price can move a few bins before the swap lands
  const beyond = nextArrayWithLiquidity(lb.bitmap, binArrayIndex(activeId) + (forY ? -1 : 1), forY);
  if (beyond !== null && arrays.length < 4) { const k = binArrayOf(r.pool, beyond); if (!arrays.includes(k)) arrays.push(k); }
  return { out, fee, binArrays: arrays, endId: activeId, lb };
}

// ── building one trade ──
const slipMin =(v: bigint, slippagePct: number) => (v * BigInt(Math.floor((100 - Math.min(99, Math.max(0, slippagePct))) * 100))) / 10000n;
function pumpIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, minOut: bigint): Ix[] {
  const curve = curveOf(r.mint);
  const accs: [string, boolean, boolean][] = [
    [pumpPda('global'), false, false], [r.mint, false, false], [P.wsol, false, false], [r.tokenProgram, false, false], [P.token, false, false],
    [curve, false, true], [ataOf(curve, r.mint, r.tokenProgram), false, true], [ataOf(curve, P.wsol, P.token), false, true],
    [user, true, true], [ataOf(user, r.mint, r.tokenProgram), false, true], [ataOf(user, P.wsol, P.token), false, true],
    [pumpPda('user_volume_accumulator', b58d(user)), false, true], [P.pumpFeeConfig, false, false], [pick(BUYBACK), false, true],
    [P.system, false, false], [pumpPda('__event_authority'), false, false], [P.pump, false, false],
  ];
  const data = cat(Uint8Array.from(side === 'buy' ? DISC.buyV3 : DISC.sellV3), u64(amount), u64(minOut));
  const out: Ix[] = [];
  if (side === 'buy') out.push(ataCreate(user, user, r.mint, r.tokenProgram));
  out.push(ix(P.pump, accs, data));
  return out;
}
function ammIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, minOut: bigint, vaults: { baseVault: string; quoteVault: string }): Ix[] {
  const wsolAta = ataOf(user, P.wsol, P.token);
  const accs: [string, boolean, boolean][] = [
    [r.pool, false, true], [user, true, true], [P.ammGlobalConfig, false, false], [r.mint, false, false], [P.wsol, false, false],
    [ataOf(user, r.mint, r.tokenProgram), false, true], [wsolAta, false, true], [vaults.baseVault, false, true], [vaults.quoteVault, false, true],
    [r.tokenProgram, false, false], [P.token, false, false], [P.system, false, false],
    [ammPda('user_volume_accumulator', b58d(user)), false, true], [P.ammFeeConfig, false, false], [ataOf(pick(BUYBACK), P.wsol, P.token), false, true],
    [ammPda('__event_authority'), false, false], [P.pamm, false, false],
  ];
  const data = cat(Uint8Array.from(side === 'buy' ? DISC.ammBuy : DISC.ammSell), u64(amount), u64(minOut));
  const out: Ix[] = [ataCreate(user, user, P.wsol, P.token)];
  if (side === 'buy') { out.push(transferIx(user, wsolAta, amount), syncNative(wsolAta), ataCreate(user, user, r.mint, r.tokenProgram)); }
  out.push(ix(P.pamm, accs, data), closeAcc(wsolAta, user, user));
  return out;
}
// Meteora DLMM swap2 (16 accounts in the IDL's order, then the bin arrays the quote walked as remaining accounts);
// the optional bitmap-extension and host-fee slots carry the program id, Anchor's "none". The same wrapped-SOL
// account as PumpSwap: opened, funded on a buy, closed at the end so the SOL of a sell lands in the wallet.
function dlmmIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, minOut: bigint, binArrays: string[]): Ix[] {
  const d = r.dlmm!; const wsolAta = ataOf(user, P.wsol, P.token), tokAta = ataOf(user, r.mint, r.tokenProgram);
  const [mintX, mintY, progX, progY] = d.solIsX ? [P.wsol, r.mint, P.token, r.tokenProgram] : [r.mint, P.wsol, r.tokenProgram, P.token];
  const [inAta, outAta] = side === 'buy' ? [wsolAta, tokAta] : [tokAta, wsolAta];
  const accs: [string, boolean, boolean][] = [
    [r.pool, false, true], [P.dlmm, false, false], [d.reserveX, false, true], [d.reserveY, false, true], [inAta, false, true], [outAta, false, true],
    [mintX, false, false], [mintY, false, false], [d.oracle, false, true], [P.dlmm, false, false], [user, true, false],
    [progX, false, false], [progY, false, false], [P.memo, false, false], [dlmmPda('__event_authority'), false, false], [P.dlmm, false, false],
    ...binArrays.map((k) => [k, false, true] as [string, boolean, boolean]),
  ];
  const data = cat(Uint8Array.from(DISC.dlmmSwap2), u64(amount), u64(minOut), u32(0));   // remaining_accounts_info: no slices (no transfer hooks)
  const out: Ix[] = [ataCreate(user, user, P.wsol, P.token)];
  if (side === 'buy') out.push(transferIx(user, wsolAta, amount), syncNative(wsolAta), ataCreate(user, user, r.mint, r.tokenProgram));
  out.push(ix(P.dlmm, accs, data), closeAcc(wsolAta, user, user));
  return out;
}

// ── fees and tips ──
// Each of these is fetched once however many wallets ask at the same moment (the in-flight
// promise is shared) and kept for 10 s; solWarm() starts them on hover so a click finds them ready.
const FALLBACK_TIPS = { p75: 0.00002, p95: 0.0015 };
let tipFloor: any = null, tipAt = 0, tipLoad: Promise<any> | null = null;
function tips(): Promise<any> {
  if (tipFloor && Date.now() - tipAt < 10000) return Promise.resolve(tipFloor);
  return (tipLoad ||= fetch(API('/jito/tipfloor'), { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => { tipLoad = null; if (j) { tipFloor = j; tipAt = Date.now(); } return j || tipFloor || FALLBACK_TIPS; }));
}
let feeLv: any = null, feeAt = 0, feeLoad: Promise<any> | null = null;
function feeLevels(): Promise<any> {
  if (feeLv && Date.now() - feeAt < 10000) return Promise.resolve(feeLv);
  return (feeLoad ||= Promise.race([solRpc<any>('getPriorityFeeEstimate', [{ accountKeys: [P.pump, P.pamm, P.dlmm], options: { includeAllPriorityFeeLevels: true } }]).catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 3000))])
    .then((est) => { feeLoad = null; const lv = est?.priorityFeeLevels; if (lv) { feeLv = lv; feeAt = Date.now(); } return lv || feeLv || {}; }));
}
export async function sendPlan(s: SolSettings) {
  const mode = s.turbo ? 'turbo' : (s.gasBoost || 1) <= 1 ? 'eco' : 'fast';
  const pinnedTip = s.solTip && s.solTip > 0 ? Math.min(0.1, s.solTip) : 0;
  const pinnedMicro = s.solPriority && s.solPriority > 0 ? s.solPriority : 0;
  // tip floor and fee levels side by side, and only the ones this plan actually uses
  const [t, lv] = await Promise.all([pinnedTip || mode === 'eco' ? FALLBACK_TIPS : tips(), pinnedMicro ? ({} as any) : feeLevels()]);
  const tipSol = pinnedTip ? pinnedTip : mode === 'turbo' ? Math.min(0.003, Math.max(0.0002, t.p95 || 0.0015)) : mode === 'fast' ? Math.min(0.001, Math.max(0.00005, t.p75 || 0.00002)) : 0;
  let micro = pinnedMicro || Number(mode === 'turbo' ? lv.veryHigh : mode === 'fast' ? lv.high : lv.medium) || (mode === 'eco' ? 1000 : 50000);
  micro = Math.ceil(Math.max(0, Math.min(Number(micro) || 0, mode === 'turbo' ? 5_000_000 : 2_000_000)));
  return { mode, tipLamports: BigInt(Math.round(tipSol * 1e9)), micro };
}
// A blockhash stays valid for ~150 slots (≈60 s); one fetched up to maxAgeMs ago is reused, so all the
// wallets of a click (and a click right after a hover) sign over the same one without waiting for it.
let bhCache: { v: string; at: number } | null = null, bhLoad: Promise<string> | null = null;
function blockhash(maxAgeMs = 0): Promise<string> {
  if (bhCache && Date.now() - bhCache.at < maxAgeMs) return Promise.resolve(bhCache.v);
  return (bhLoad ||= solRpc<any>('getLatestBlockhash', [{ commitment: 'confirmed' }])
    .then((r) => { const v = r.value.blockhash as string; bhCache = { v, at: Date.now() }; return v; })
    .finally(() => { bhLoad = null; }));
}
async function newerBlockhash(than: string) {
  for (let i = 0; i < 4; i++) { const v = await blockhash(0); if (v !== than) return v; await new Promise((ok) => setTimeout(ok, 200)); }
  return than;
}
// hover / route check: the plan inputs and a blockhash are loaded before the click
let warmAt = 0;
export function solWarm() {
  if (Date.now() - warmAt < 3000) return; warmAt = Date.now();
  tips().catch(() => {}); feeLevels().catch(() => {}); blockhash(10_000).catch(() => {});
}
// the first promise that resolves wins; it fails only when every one failed
const firstOk = <T>(list: Promise<T>[]) => new Promise<T>((resolve, reject) => { let left = list.length; const errs: unknown[] = []; for (const p of list) p.then(resolve, (e) => { errs.push(e); if (--left === 0) reject(errs[0]); }); });
// The wallets that start in the same tick are one click; its size spreads the Jito regions between them.
type Click = { size: number };
let openClick: Click | null = null;
function joinClick(): Click { if (!openClick) { const c: Click = { size: 0 }; openClick = c; setTimeout(() => { if (openClick === c) openClick = null; }, 0); } openClick.size += 1; return openClick; }
// The public block engine answers 429 past ~1 request per second per region: each send takes the
// regions nobody used in the last second (fast: 2, turbo: its share of all of them), at least one.
const jitoLast = new Map<string, number>(); let jitoTurn = 0;
function jitoRoads(mode: string, click?: Click): string[] {
  if (mode === 'eco') return [];
  const want = mode === 'turbo' ? Math.max(2, Math.ceil(JITO_ENDPOINTS.length / Math.max(1, click?.size || 1))) : 2;
  const now = Date.now();
  let picked = JITO_ENDPOINTS.filter((u) => now - (jitoLast.get(u) || 0) >= 1000).slice(0, want);
  if (!picked.length) picked = [JITO_ENDPOINTS[jitoTurn++ % JITO_ENDPOINTS.length]];
  for (const u of picked) jitoLast.set(u, now);
  return picked;
}
// A send has three outcomes, not two: some road accepted it (the hash), every road refused it in words (not sent —
// the refusal is the message), or roads went silent (timeout / network) with none accepting — then the bytes may
// still have reached a leader, so the status is unknown: never re-sent by itself, tracked, and said so.
export class SolSendUnknown extends Error { hash = ''; }
const silent = (e: any) => Number(e?.status) >= 500 || /timeout|timed out|abort|failed to fetch|networkerror|load failed|fetch failed/i.test(String(e?.name || '') + ' ' + String(e?.message || e || ''));
async function broadcast(tx: Uint8Array, mode: string, click?: Click) {
  const b64 = toB64(tx);
  const viaRpc = rpcAt<string>(RPC_URL(), 'sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 8000);
  // a second RPC road straight from this browser: same bytes, so at most one copy ever lands
  const viaPublic = rpcAt<string>(PUBLIC_RPC, 'sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 8000);
  const jitos = jitoRoads(mode, click).map((u) => rpcAt<string>(u + '/api/v1/transactions', 'sendTransaction', [b64, { encoding: 'base64' }], 8000));
  const mine = [...USER_READS, ...USER_SENDS].map((u) => rpcAt<string>(u, 'sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 8000));
  const roads = [viaRpc, viaPublic, ...jitos, ...mine];
  // the first road that accepts it wins; the others land the same signature or drop it
  try { return await firstOk(roads); } catch {
    const errs = (await Promise.allSettled(roads)).map((x) => (x.status === 'rejected' ? x.reason : null)).filter(Boolean);
    if (errs.some(silent)) throw new SolSendUnknown('No node confirmed it received the transaction — its status is unknown. Check the wallet before trying again');
    const busy = (e: any) => Number(e?.status) === 429 || /429|rate|too many|congested/i.test(String(e?.message));
    const why = String((errs.find((e: any) => !busy(e)) || errs[0])?.message || 'refused');
    throw new Error(/blockhash not found/i.test(why) ? 'Not sent: the blockhash expired before it went out — try again' : errs.every(busy) ? 'Not sent: every node is rate-limiting right now — try again in a moment' : 'Not sent: ' + why.slice(0, 140));
  }
}
// the simulation asks the Helius proxy and publicnode at once and takes the first answer (publicnode is
// one hop shorter: ~65 ms against ~125 ms measured); either node's verdict is a verdict on the same bytes
async function simulate(tx: Uint8Array) {
  const params = [toB64(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }];
  const list = [solRpc<any>('simulateTransaction', params), rpcAt<any>(PUBLIC_RPC, 'simulateTransaction', params), ...USER_READS.map((u) => rpcAt<any>(u, 'simulateTransaction', params, 6000))];
  // a lagging node can fail a trade the chain would take (stale curve, "AccountNotFound" for a just-funded wallet):
  // the first success wins; a failure verdict is held 250 ms for a success from another node
  return new Promise<any>((resolve, reject) => {
    let left = list.length, firstBad: any = null, timer: any = null, done = false; const errs: unknown[] = [];
    const fin = (v: any) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    for (const p of list) p.then((r) => { const v = r?.value || {}; if (!v.err) fin(v); else if (!firstBad) { firstBad = v; timer = setTimeout(() => fin(firstBad), 250); } if (--left === 0 && firstBad) fin(firstBad); },
      (e) => { errs.push(e); if (--left === 0) { if (firstBad) fin(firstBad); else if (!done) { done = true; reject(errs[0]); } } });
  });
}
// what gets simulated carries no signature: sigVerify is off and the blockhash is replaced by the node,
// so the trial needs neither the key nor a blockhash, and a copy of it could never land
const unsignedTx = (message: Uint8Array) => cat(compact(1), new Uint8Array(64), message);
// the node's verdict in words a trader can act on (pump.json / pump_amm.json error names, runtime errors)
const SLIP = 'Price moved past your slippage';
const CODE_TEXT: Record<string, string> = {
  TooMuchSolRequired: SLIP, TooLittleSolReceived: SLIP, ExceededSlippage: SLIP,
  BondingCurveComplete: 'The curve just completed — the coin is moving to PumpSwap; try again in a few seconds',
  NotEnoughTokensToBuy: 'Not that many tokens left on the curve — buy a smaller amount', BuyZeroAmount: 'Amount too small to buy anything',
  NotEnoughTokensToSell: 'Not enough tokens in this wallet', SellZeroAmount: 'Nothing to sell',
  BuyMoreBaseAmountThanPoolReserves: 'Amount is larger than the pool can fill', DisabledBuy: 'PumpSwap has buys paused for this pool', DisabledSell: 'PumpSwap has sells paused for this pool',
  BuySlippageBelowMinTokensOut: SLIP, BuySlippageBelowMinBaseAmountOut: SLIP,
  BuyNotEnoughSolToCoverRent: 'Not enough SOL for the fees and account rent of this buy', BuyNotEnoughSolToCoverFees: 'Not enough SOL for the fees and account rent of this buy', BuyNotEnoughQuoteTokensToCoverFees: 'Not enough SOL for the fees and account rent of this buy',
  ZeroQuoteAmount: 'Amount too small for this pool', TooLittlePoolTokenLiquidity: 'The pool has too little liquidity for this trade',
  // lb_clmm (Meteora DLMM)
  ExceededAmountSlippageTolerance: SLIP, ExceededBinSlippageTolerance: SLIP, InsufficientOutAmount: SLIP,
  PairInsufficientLiquidity: 'The pool has too little liquidity for this trade', CannotFindNonZeroLiquidityBinArrayId: 'The pool has too little liquidity for this trade',
  BinArrayNotFound: 'The price moved further than the pool liquidity this trade carried — try again', BitmapExtensionAccountIsNotProvided: 'The price moved further than the pool liquidity this trade carried — try again',
  PoolDisabled: 'Meteora has this pool disabled', InsufficientInAmount: 'Amount too small for this pool',
};
// a landed failure carries only {"InstructionError":[i,{"Custom":n}]}: the number means a different thing per program
const CUSTOM_TEXT: Record<string, Record<number, string>> = {
  pump: { 6002: SLIP, 6003: SLIP, 6042: SLIP, 6005: CODE_TEXT.BondingCurveComplete, 6040: CODE_TEXT.BuyNotEnoughSolToCoverRent, 6041: CODE_TEXT.BuyNotEnoughSolToCoverFees, 6021: CODE_TEXT.NotEnoughTokensToBuy, 6023: CODE_TEXT.NotEnoughTokensToSell },
  pumpswap: { 6004: SLIP, 6040: SLIP, 6002: CODE_TEXT.ZeroQuoteAmount, 6003: CODE_TEXT.TooLittlePoolTokenLiquidity, 6039: CODE_TEXT.BuyNotEnoughQuoteTokensToCoverFees, 6020: CODE_TEXT.DisabledBuy, 6021: CODE_TEXT.DisabledSell },
  dlmm: { 6003: SLIP, 6004: SLIP, 6039: SLIP, 6012: CODE_TEXT.PairInsufficientLiquidity, 6037: CODE_TEXT.PairInsufficientLiquidity, 6009: CODE_TEXT.BinArrayNotFound, 6036: CODE_TEXT.BinArrayNotFound, 6042: CODE_TEXT.PoolDisabled, 6104: CODE_TEXT.InsufficientInAmount },
};
const errText = (sim: any, side: 'buy' | 'sell' = 'buy', venue = '') => {
  const logs: string[] = sim?.logs || []; const all = logs.join('\n'); const err = JSON.stringify(sim?.err ?? '');
  const code = all.match(/Error Code: (\w+)/)?.[1] || '';
  if (CODE_TEXT[code]) return CODE_TEXT[code];
  const hex = all.match(/custom program error: (0x[0-9a-f]+)/)?.[1] || '';
  if (/AccountNotFound/.test(err)) return 'This wallet has no SOL yet — fund it first';
  if (/InsufficientFundsForRent/.test(err)) return 'Not enough SOL left for account rent — keep about 0.003 SOL in the wallet';
  if (/insufficient lamports/i.test(all) || /InsufficientFundsForFee/.test(err)) return 'Not enough SOL in this wallet';
  if (/Error: insufficient funds/i.test(all)) return side === 'sell' ? 'Not enough tokens in this wallet' : 'Not enough SOL in this wallet';
  const msg = all.match(/Error Message: (.*)/)?.[1] || '';
  const custom = Number(err.match(/"Custom":(\d+)/)?.[1] || (hex ? parseInt(hex, 16) : 0));
  if (custom && CUSTOM_TEXT[venue]?.[custom]) return CUSTOM_TEXT[venue][custom];
  if (/slippage/i.test(msg)) return SLIP;
  return 'Simulation failed: ' + String(msg || code || hex || err).slice(0, 140);
};

// the instructions of one trade for one wallet (exported for the mainnet simulation test)
export async function solTradeIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, slippage: number, pre?: Market) {
  if (r.venue === 'pump') {
    const q = await quotePump(r.mint, side, amount, pre);
    let minOut = slipMin(q.out, slippage); if (side === 'buy' && minOut <= 0n) minOut = 1n;
    return { ixs: pumpIxs(user, r, side, amount, minOut), expected: q.out, minOut };
  }
  if (r.venue === 'dlmm') {
    const q = await quoteDlmm(r, side, amount, pre);
    if (q.out <= 0n) throw new Error(side === 'buy' ? 'Amount too small to buy anything' : 'Amount too small for this pool');
    let minOut = slipMin(q.out, slippage); if (minOut <= 0n) minOut = 1n;
    return { ixs: dlmmIxs(user, r, side, amount, minOut, q.binArrays), expected: q.out, minOut };
  }
  const q = await quoteAmm(r, side, amount, pre);
  let minOut = slipMin(q.out, slippage); if (minOut <= 0n) minOut = 1n;
  return { ixs: ammIxs(user, r, side, amount, minOut, q), expected: q.out, minOut };
}
export const solQuoteDlmm = (r: SolRoute, side: 'buy' | 'sell', amountIn: bigint) => quoteDlmm(r, side, amountIn);
export const solBudget = (units: number, micro: number) => budget(units, micro);
export const solSimulate = (tx: Uint8Array) => simulate(tx);

// ── one wallet, one trade ──
// Round trips on the click path: [market + this wallet's accounts ‖ plan ‖ blockhash] → simulate → send.
// Turbo skips the simulation. Signed bytes are what they were: the same instructions, a fresh quote,
// the simulated compute limit, one tip transfer, a recent blockhash.
const CURVE_DONE = 'Curve complete — trading moves to PumpSwap';
// rent a buy may have to put down besides the amount: the coin's token account (a Token-2022 account carries an
// extension, a little more), PumpSwap's temporary wrapped-SOL account (refunded by the same transaction), and the
// wallet itself must stay rent-exempt after paying
const RENT_ATA = 2_039_280n, RENT_ATA22 = 2_100_000n, RENT_WALLET = 890_880n, SIG_FEE = 5_000n;
const RENT_UVA = 1_700_000n;   // a user_volume_accumulator (pump 106 B / PumpSwap 90 B) and its margin
const solTxt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const sentSigs = new Map<string, number>();
// A send whose status is unknown can still land for ~60–90 s (its blockhash): a second press for the same wallet,
// coin and side meanwhile could land too and buy twice (Solana has no nonce to make them collide). Until that
// signature shows a status or the window passes, the pair is refused and the reason said.
const UNKNOWN_HOLD_MS = 90_000;
const unknownSends = new Map<string, { sig: string; at: number }>();
export async function solTradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  try { return await tradeOne(a, side, r, size, s); }
  catch (e) { if (e instanceof SolSendUnknown || !(e instanceof RpcError || /timeout|abort|failed to fetch|networkerror/i.test(String((e as Error)?.name) + ' ' + String((e as Error)?.message)))) throw e; throw new Error(nodeText(e)); }
}
async function tradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  if (!a.key || a.ext) throw new Error('This wallet signs through Privy, which has no Solana key here');
  if (r.isCashback) throw new Error('Cashback coins are not supported yet');
  const k = solKeys(a.key); const user = k.address;
  const holdKey = user + '|' + r.mint + '|' + side; const held = unknownSends.get(holdKey);
  if (held) {
    const st = statusOf.get(held.sig)?.st;
    if (st || Date.now() - held.at > UNKNOWN_HOLD_MS) unknownSends.delete(holdKey);
    else throw new Error(`Your previous ${side} from this wallet (${held.sig.slice(0, 8)}…) has an unknown status and may still land — wait until it shows up or ${Math.ceil((UNKNOWN_HOLD_MS - (Date.now() - held.at)) / 1000)} s pass before pressing again`);
  }
  const click = joinClick();
  // what does not depend on this wallet starts now, once for the whole click
  const planP = sendPlan(s); const bhP = blockhash(10_000);
  planP.catch(() => {}); bhP.catch(() => {});
  let amount = 0n;
  if (side === 'buy') { amount = BigInt(Math.floor(size * 1e9)); if (amount <= 0n) throw new Error('Enter an amount'); }
  // this wallet's own accounts ride in the click's one market read: its SOL (it must pay before anything is
  // simulated or signed), its token account (a sell's balance; a buy's "does the account exist yet") and the venue's
  // volume accumulator (a wallet's first trade there pays its rent)
  // (DLMM keeps no accumulator: the third account is the wrapped-SOL account, whose rent a first trade puts down)
  const uva = (route: SolRoute) => (route.venue === 'pump' ? pumpPda('user_volume_accumulator', b58d(user)) : route.venue === 'dlmm' ? ataOf(user, P.wsol, P.token) : ammPda('user_volume_accumulator', b58d(user)));
  const read = (route: SolRoute) => readMarket(route, [user, ataOf(user, route.mint, route.tokenProgram), uva(route)]);
  let { m, extra } = await read(r);
  // this wallet's slice of the read failed: this wallet stops here, the others go on
  const mine = () => { if (extra.some((x) => x === undefined)) throw new Error('Could not read this wallet from the Solana nodes — nothing was sent; try again'); };
  mine();
  let ixs: Ix[];
  const sellAmount = (acc: Got) => {
    const raw = acc && acc.owner === r.tokenProgram && acc.data.length >= 72 ? rdU64(acc.data, 64) : 0n; if (raw <= 0n) throw new Error('Nothing to sell in this wallet');
    const x = (raw * BigInt(Math.round(Math.min(100, Math.max(0, size)) * 100))) / 10000n; if (x <= 0n) throw new Error('Nothing to sell'); return x;
  };
  if (side === 'sell') amount = sellAmount(extra[1]);
  try { ixs = (await solTradeIxs(user, r, side, amount, s.slippage, m)).ixs; } catch (e) {
    // the curve completed since the route was read: the click re-routes once (one shared read for every wallet)
    // to the PumpSwap pool and quotes there — nothing was signed yet
    if ((e as Error).message !== CURVE_DONE) throw e;
    routeCache.delete(r.mint); r = await solRoute(r.mint); ({ m, extra } = await read(r)); mine();
    if (side === 'sell') amount = sellAmount(extra[1]);
    ixs = (await solTradeIxs(user, r, side, amount, s.slippage, m)).ixs;
  }
  const plan = await planP;
  const tip = plan.tipLamports > 0n ? [transferIx(user, pick(JITO_TIP), plan.tipLamports)] : [];
  // the most this transaction can be signed with: Fast simulates at 400k and signs ≤ 400k, Turbo signs 300k — 400k on
  // DLMM, where a sell that walks many bins measured 337k (pump / PumpSwap never pass 100k)
  const maxUnits = s.turbo ? (r.venue === 'dlmm' ? 400_000 : 300_000) : 400_000;
  {
    // what the wallet must hold besides a buy's amount: tip, priority and signature fee, the temporary wrapped-SOL
    // account on PumpSwap (refunded in the same transaction, but held during it), the token account and the volume
    // accumulator when they do not exist yet; a buy also keeps the wallet itself rent-exempt
    const have = BigInt(extra[0]?.lamports || 0);
    const rent = (side === 'buy' && !extra[1] ? (r.tokenProgram === P.token22 ? RENT_ATA22 : RENT_ATA) : 0n) + (r.venue === 'pumpswap' ? RENT_ATA : 0n) + (r.venue === 'dlmm' ? (extra[2] ? 0n : RENT_ATA) : extra[2] ? 0n : RENT_UVA);
    const fees = plan.tipLamports + (BigInt(plan.micro) * BigInt(maxUnits)) / 1_000_000n + SIG_FEE;
    const need = (side === 'buy' ? amount + RENT_WALLET : 0n) + fees + rent;
    if (have < need) throw new Error(have === 0n ? 'This wallet has no SOL yet — fund it first' : side === 'buy' ? `Not enough SOL: ${solTxt(have)} available, about ${solTxt(need)} needed (amount + fees${rent ? ' + account rent' : ''})` : `Not enough SOL for the sell's fees: ${solTxt(have)} available, about ${solTxt(need)} needed`);
  }
  let units = s.turbo ? maxUnits : 200_000;
  if (!s.turbo) {
    // simulate with a generous limit, then sign with what it really used (+25%): a smaller limit lands sooner at the same price
    const sim = await simulate(unsignedTx(compileLegacy(user, [...budget(400_000, plan.micro), ...ixs, ...tip], P.system)));
    if (sim.err) throw new Error(errText(sim, side, r.venue));
    if (sim.unitsConsumed) units = Math.min(400_000, Math.ceil(sim.unitsConsumed * 1.25) + 5_000);
  }
  let bh = await bhP;
  let built = signMessage(compileLegacy(user, [...budget(units, plan.micro), ...ixs, ...tip], bh), k.seed);
  // identical bytes carry the identical signature and land once: the same trade repeated within the
  // blockhash's reuse window is signed over a newer blockhash, so a second click is a second trade
  for (let i = 0; i < 3 && sentSigs.has(b58e(built.sig)); i++) { bh = await newerBlockhash(bh); built = signMessage(compileLegacy(user, [...budget(units, plan.micro), ...ixs, ...tip], bh), k.seed); }
  const { tx, sig } = built;
  if (tx.length > 1232) throw new Error('Transaction too large');
  const hash = b58e(sig);
  const now = Date.now(); for (const [x, at] of sentSigs) if (now - at > 120_000) sentSigs.delete(x);
  sentSigs.set(hash, now);
  try { await broadcast(tx, plan.mode, click); } catch (e) {
    // silence is not a refusal: the hash stays tracked (its receipt can still say "landed"), the pair is held, the caller is told
    if (e instanceof SolSendUnknown) { e.hash = hash; trackSig(hash, r.venue); unknownSends.set(holdKey, { sig: hash, at: Date.now() }); throw e; }
    sentSigs.delete(hash); throw e;
  }
  trackSig(hash, r.venue);
  return { hash };
}
export async function solPreviewOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings) {
  const user = a.key && !a.ext ? solKeys(a.key).address : '';
  const out: any = { name: a.name, address: user, side, venue: r.venue === 'pump' ? 'pump.fun curve' : r.venue === 'dlmm' ? 'Meteora DLMM' : 'PumpSwap', contract: r.venue === 'pump' ? P.pump : r.venue === 'dlmm' ? P.dlmm : P.pamm, method: r.venue === 'pump' ? (side === 'buy' ? 'buy_exact_quote_in_v3' : 'sell_v3') : r.venue === 'dlmm' ? 'swap2' : (side === 'buy' ? 'buy_exact_quote_in_v2' : 'sell_v2'), amountIn: size, amountInLabel: side === 'buy' ? size + ' SOL' : size + '%', notes: [] as string[] };
  try {
    if (!user) throw new Error('This wallet has no Solana key here');
    const bal = await solRpc<any>('getBalance', [user, { commitment: 'processed' }]); out.balanceEth = (bal?.value || 0) / 1e9;
    let amount = BigInt(Math.floor(size * 1e9));
    if (side === 'sell') { const tb = await solRpc<any>('getTokenAccountBalance', [ataOf(user, r.mint, r.tokenProgram)]).catch(() => null); amount = (BigInt(tb?.value?.amount || '0') * BigInt(Math.round(size * 100))) / 10000n; }
    const q = r.venue === 'pump' ? await quotePump(r.mint, side, amount) : r.venue === 'dlmm' ? await quoteDlmm(r, side, amount) : await quoteAmm(r, side, amount);
    if (r.venue === 'dlmm' && r.dlmm && 'binArrays' in q) out.notes.push(`DLMM pool ${r.pool.slice(0, 6)}… · bin step ${r.dlmm.binStep} · ${q.binArrays.length} bin arrays`);
    const exp = side === 'buy' ? Number(q.out) / 10 ** r.decimals : Number(q.out) / 1e9;
    out.expected = exp; out.min = side === 'buy' ? Number(slipMin(q.out, s.slippage)) / 10 ** r.decimals : Number(slipMin(q.out, s.slippage)) / 1e9;
    const plan = await sendPlan(s); out.gasEth = (plan.micro * (s.turbo ? 300000 : 150000)) / 1e15 + Number(plan.tipLamports) / 1e9 + 0.000005; out.notes.push(`${plan.mode} · tip ${(Number(plan.tipLamports) / 1e9).toFixed(6)} SOL · priority ${plan.micro} µlamports/CU`);
    out.simulated = 'skipped'; out.funded = side === 'sell' || out.balanceEth >= size + out.gasEth;
  } catch (e) { out.error = (e as Error).message; }
  return out;
}

// ── balances, transfers, receipts ──
export async function solBalancesFor(addrs: string[]): Promise<Record<string, number>> {
  const ok = addrs.filter((x) => SOL_ADDR.test(x)); if (!ok.length) return {};
  // ≤ 10 per call (publicnode's limit); a slice that failed leaves its wallets out rather than reporting them at 0
  const parts = slices(ok);
  const got = await Promise.all(parts.map((c) => solRpc<any>('getMultipleAccounts', [c, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'processed' }]).catch(() => null)));
  return Object.fromEntries(parts.flatMap((c, i) => (got[i]?.value ? c.map((x, j) => [x, (got[i].value[j]?.lamports || 0) / 1e9] as [string, number]) : [])));
}
export async function solTokenBalancesFor(mint: string, addrs: string[]): Promise<Record<string, number>> {
  if (!SOL_ADDR.test(mint)) return {};
  // a mint's program and decimals never change: read once, not on every 2 s balance poll
  let mm = mintFacts.get(mint);
  if (!mm) { const m = await account(mint).catch(() => null); if (!m) return {}; mm = { prog: m.owner, dec: m.data[44] }; mintFacts.set(mint, mm); }
  const ok = addrs.filter((x) => SOL_ADDR.test(x));
  const atas = ok.map((x) => ataOf(x, mint, mm!.prog));
  // a failed read is "unknown" (no entry), never a row of zeros that would read as "sold everything"
  const r = await accounts(atas).catch(() => null); if (!r) return {};
  // an account that could not be read is left out (unknown), never reported as 0
  return Object.fromEntries(ok.flatMap((x, i) => (r[i] === undefined ? [] : [[x, r[i] && r[i]!.owner === mm!.prog ? Number(rdU64(r[i]!.data, 64)) / 10 ** mm!.dec : 0] as [string, number]])));
}
const mintFacts = new Map<string, { prog: string; dec: number }>();
// A native send's lamports (pure — scripts/sol-send-amount.test.mjs). The fee is exact: one signature (5 000) plus the
// priority of the budget below. A system account may hold 0 or at least the rent-exempt minimum, never between: so
// "everything" is balance − fee (the account closes), a partial send must leave ≥ the minimum, and a new (empty)
// recipient must receive ≥ the minimum. (2026-10-19: "everything" kept 10 000 back, under rent — the network refused it.)
export const SOL_SEND_CU = 1_000, SOL_SEND_PRICE = 50_000;
export const SOL_RENT_MIN = 890_880n;
export const solSendFee = (): bigint => 5_000n + BigInt(Math.ceil((SOL_SEND_CU * SOL_SEND_PRICE) / 1e6));
const sol9 = (l: bigint) => (Number(l) / 1e9).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
export function solSendAmount(balance: bigint, want: bigint | 'max', recipientBalance: bigint | null, fee = solSendFee()): bigint {
  const lamports = want === 'max' ? balance - fee : want;
  if (lamports <= 0n) throw new Error('Nothing to send after the fee');
  if (lamports + fee > balance) throw new Error(`Not enough SOL: the wallet has ${sol9(balance)}, this send needs ${sol9(lamports + fee)} with the fee`);
  const left = balance - lamports - fee;
  if (left > 0n && left < SOL_RENT_MIN) throw new Error(`Leave at least ${sol9(SOL_RENT_MIN)} SOL in the wallet (Solana rent), or send everything`);
  if (recipientBalance === 0n && lamports < SOL_RENT_MIN) throw new Error(`A new Solana address must receive at least ${sol9(SOL_RENT_MIN)} SOL (rent)`);
  return lamports;
}
export async function solTransfer(a: SolAcct, to: string, amountSol: number | 'max'): Promise<string> {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  if (!SOL_ADDR.test(to) || b58d(to).length !== 32) throw new Error('Invalid Solana address');
  const k = solKeys(a.key);
  if (amountSol !== 'max' && !(amountSol > 0 && Number.isFinite(amountSol))) throw new Error('Invalid amount');
  const [mine, theirs] = await Promise.all([solRpc<any>('getBalance', [k.address]), solRpc<any>('getBalance', [to]).catch(() => null)]);
  const lamports = solSendAmount(BigInt(mine.value), amountSol === 'max' ? 'max' : toUnits(amountSol, 9), theirs ? BigInt(theirs.value) : null);
  const { tx, sig } = signMessage(compileLegacy(k.address, [...budget(SOL_SEND_CU, SOL_SEND_PRICE), transferIx(k.address, to, lamports)], await blockhash()), k.seed);
  await solRpc('sendTransaction', [toB64(tx), { encoding: 'base64', skipPreflight: false, maxRetries: 5 }]);
  return b58e(sig);
}
// the instructions of a token send (pure, so scripts/sol-token-transfer.test.mjs and a mainnet simulation check the bytes):
// a compute budget, the recipient's token account created if missing (idempotent), transferChecked (index 12)
export function tokenTransferIxs(owner: string, mint: string, to: string, units: bigint, decimals: number, prog: string): Ix[] {
  const src = ataOf(owner, mint, prog), dst = ataOf(to, mint, prog);
  return [...budget(80_000, 50_000), ataCreate(owner, to, mint, prog), ix(prog, [[src, false, true], [mint, false, false], [dst, false, true], [owner, true, false]], cat(Uint8Array.of(12), u64(units), Uint8Array.of(decimals)))];
}
// An exact decimal amount in a token's smallest units (never a float times 10^d: 0.1 USDC must be 100000, not 99999)
export function toUnits(amount: number, decimals: number): bigint {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0n;
  // the shortest decimal the number prints as ("0.3", not toFixed's "0.2999…989"), truncated to the token's decimals —
  // never rounded up past what was typed; tiny numbers JS prints in exponent form go through toFixed
  let str = String(amount); if (/e/i.test(str)) str = amount.toFixed(Math.min(100, decimals));
  const [i, f = ''] = str.split('.');
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
// SPL tokens out of a wallet (a USDC deposit, a coin) — 2026-10-17, a user's 2 USDC could be seen but not moved.
// The mint's own program (Token or Token-2022) and decimals; the recipient's token account is created when missing
// (idempotent, the sender pays its ~0.002 SOL rent); then transferChecked, which the program rejects on a wrong
// mint or decimals. A recipient that is itself a token account (a common paste) is refused: tokens go to wallets.
export async function solTokenTransfer(a: SolAcct, mint: string, to: string, amount: number | 'max'): Promise<{ hash: string; units: string; decimals: number }> {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  if (!SOL_ADDR.test(to) || b58d(to).length !== 32) throw new Error('Invalid Solana address');
  if (!SOL_ADDR.test(mint) || b58d(mint).length !== 32) throw new Error('Invalid token');
  const m = await account(mint); if (!m) throw new Error('Unknown token');
  const prog = m.owner; if (prog !== P.token && prog !== P.token22) throw new Error('Not an SPL token');
  const dec = m.data[44];
  const k = solKeys(a.key);
  if (to === k.address) throw new Error('That is this wallet');
  const dest = await account(to);
  if (dest && (dest.owner === P.token || dest.owner === P.token22)) throw new Error('That address is a token account — paste the wallet (owner) address instead');
  const src = ataOf(k.address, mint, prog);
  const s = await account(src); if (!s || s.owner !== prog) throw new Error('This wallet holds none of this token');
  const bal = rdU64(s.data, 64);
  const units = amount === 'max' ? bal : toUnits(amount, dec);
  if (units <= 0n) throw new Error('Nothing to send');
  if (units > bal) throw new Error('More than this wallet holds');
  const dst = ataOf(to, mint, prog);
  const needRent = !(await account(dst));
  const lamports = BigInt((await solRpc<any>('getBalance', [k.address, { commitment: 'processed' }])).value || 0);
  const need = (needRent ? 2_100_000n : 0n) + 20_000n;
  if (lamports < need) throw new Error(`Needs ${(Number(need) / 1e9).toFixed(4)} SOL for the network fee${needRent ? ' and the recipient\'s token account' : ''} — this wallet has ${(Number(lamports) / 1e9).toFixed(4)} SOL`);
  const { tx, sig } = signMessage(compileLegacy(k.address, tokenTransferIxs(k.address, mint, to, units, dec, prog), await blockhash()), k.seed);
  await solRpc('sendTransaction', [toB64(tx), { encoding: 'base64', skipPreflight: false, maxRetries: 5 }]);
  return { hash: b58e(sig), units: units.toString(), decimals: dec };
}
// ── wrapped SOL back to SOL (2026-10-20: a user held 6 wSOL the site could neither unwrap nor send) ──
// None of the vault's own trades leaves wSOL behind (PumpSwap and DLMM open, fund and CLOSE the wSOL account in the same
// transaction; the curve moves lamports). wSOL that came in from elsewhere had no way out but a token send. The way out:
// one SPL Token CloseAccount (instruction 9) on the wallet's own wSOL associated account — account = ataOf(owner, wSOL),
// destination = the owner, authority = the owner. A native account closes with any balance: its wSOL and its rent both
// land as SOL in the same wallet. No amount and no destination can be named: nothing leaves the wallet.
export const WSOL_UNWRAP_UNITS = 10_000, WSOL_UNWRAP_MICRO = 50_000;
export const wsolAtaOf = (owner: string) => ataOf(owner, P.wsol, P.token);
export const wsolUnwrapIxs = (owner: string): Ix[] => [...budget(WSOL_UNWRAP_UNITS, WSOL_UNWRAP_MICRO), closeAcc(wsolAtaOf(owner), owner, owner)];
export const solUnwrapFee = (): bigint => 5_000n + BigInt(Math.ceil((WSOL_UNWRAP_UNITS * WSOL_UNWRAP_MICRO) / 1e6));
// the SPL Token account (165 bytes) as read, before it is closed: wSOL mint @0, this owner @32, amount @64, state @108
// (1 initialized, 2 frozen), is_native COption @109, close_authority COption @129 — none, or the owner itself
export function wsolAccountCheck(acc: Got, owner: string): { units: bigint; lamports: bigint } {
  if (acc === undefined) throw new Error(READ_FAIL);
  if (!acc) throw new Error('This wallet holds no wrapped SOL');
  const d = acc.data;
  if (acc.owner !== P.token || d.length < 165 || rdKey(d, 0) !== P.wsol || rdKey(d, 32) !== owner) throw new Error('Not this wallet\'s wrapped-SOL account — nothing was sent');
  if (d[108] !== 1) throw new Error(d[108] === 2 ? 'This wrapped-SOL account is frozen' : 'Not an open token account — nothing was sent');
  if (rdU32(d, 109) !== 1) throw new Error('Not a native (wrapped SOL) account — nothing was sent');
  if (rdU32(d, 129) === 1 && rdKey(d, 133) !== owner) throw new Error('Another address holds the close authority of this wrapped-SOL account — nothing was sent');
  return { units: rdU64(d, 64), lamports: BigInt(acc.lamports) };
}
export async function solUnwrap(a: SolAcct): Promise<{ hash: string; units: string; lamports: string }> {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  const me = solKeys(a.key).address;
  const [acc, wallet] = await accounts([wsolAtaOf(me), me]);
  const { units, lamports } = wsolAccountCheck(acc, me);
  if (wallet === undefined) throw new Error(READ_FAIL);
  const have = BigInt(wallet?.lamports || 0), fee = solUnwrapFee();
  const sol7 = (l: bigint) => (Number(l) / 1e9).toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  if (have < fee) throw new Error(`Needs ${sol7(fee)} SOL for the network fee — this wallet has ${sol7(have)} SOL`);
  const { tx, sig } = signMessage(compileLegacy(me, wsolUnwrapIxs(me), await blockhash()), solKeys(a.key).seed);
  await solRpc('sendTransaction', [toB64(tx), { encoding: 'base64', skipPreflight: false, maxRetries: 5 }]);
  return { hash: b58e(sig), units: units.toString(), lamports: lamports.toString() };
}
// every wallet's wSOL (the token balance of its wSOL account; 0 when it has none, left out when the read failed)
export const solWsolBalancesFor = (addrs: string[]) => solTokenBalancesFor(P.wsol, addrs);
// ── wallet-to-wallet moves (src/moveChains.ts, 2026-10-19) ──
// The same compute budget as solTransfer / tokenTransferIxs above (1 000 CU · 50 000 µlamports for SOL, 80 000 CU for a
// token send), so a move costs what a withdrawal costs. Pure builders (tests decode the bytes), plus the reads a move needs.
export const SOL_XFER_UNITS = 1_000, SOL_XFER_MICRO = 50_000, SOL_SPL_UNITS = 80_000;
export const solTransferIxs = (from: string, to: string, lamports: bigint): Ix[] => [...budget(SOL_XFER_UNITS, SOL_XFER_MICRO), transferIx(from, to, lamports)];
// accounts as read (null = does not exist, undefined = the read failed), ≤ 10 per call
export const solAccounts = (addrs: string[]) => accounts(addrs);
export const solB64 = (b: Uint8Array) => toB64(b);
// a blockhash with the last block height it is valid at: a signed move that did not land by then never will
export async function solBlockhashInfo(): Promise<{ blockhash: string; lvh: number }> {
  const r = await solRpc<any>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  if (!r?.value?.blockhash || !Number.isFinite(Number(r.value.lastValidBlockHeight))) throw new RpcError('no blockhash');
  return { blockhash: String(r.value.blockhash), lvh: Number(r.value.lastValidBlockHeight) };
}
// the existing send path (the indexer's node, preflight on); a re-broadcast of the same bytes skips the preflight
export const solSendSigned = (b64: string, skipPreflight = false) => solRpc<string>('sendTransaction', [b64, { encoding: 'base64', skipPreflight, maxRetries: 5 }]);
// statuses with history, asked of BOTH roads (the indexer's node and publicnode): landed if either says so; null only
// when an answer said "unknown signature"; undefined when no road answered for that signature
export async function solSigStatusesBoth(sigs: string[]): Promise<(any | null | undefined)[]> {
  const params = [sigs, { searchTransactionHistory: true }];
  const got = await Promise.allSettled([rpcAt<any>(RPC_URL(), 'getSignatureStatuses', params, 8000), rpcAt<any>(PUBLIC_RPC, 'getSignatureStatuses', params, 8000)]);
  const lists = got.map((g) => (g.status === 'fulfilled' && Array.isArray(g.value?.value) ? g.value.value : null)).filter(Boolean) as any[][];
  return sigs.map((_, i) => { if (!lists.length) return undefined; const seen = lists.map((l) => l[i]).filter(Boolean); return seen.find((s) => s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed') || seen[0] || null; });
}

// Confirmation runs beside the click, never in it. The page asks for each hash in turn; the first ask
// reads the status of every hash still in flight in one getSignatureStatuses (≤256), the others are
// answered from that read, so N wallets cost one status call per poll instead of N.
const inFlight = new Map<string, number>();        // signature → sent at
const statusOf = new Map<string, { at: number; st: any }>();
let statusLoad: Promise<void> | null = null, statusOk = true, statusBackoff = 0, statusNextAt = 0;
const sigVenue = new Map<string, string>();       // signature → 'pump' | 'pumpswap' | 'dlmm' (a landed error code is read per program)
function trackSig(sig: string, venue = '') { inFlight.set(sig, Date.now()); if (venue) { sigVenue.set(sig, venue); if (sigVenue.size > 500) sigVenue.delete(sigVenue.keys().next().value as string); } }
const settledSt = (st: any) => !!st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
async function loadStatuses(extra: string) {
  const now = Date.now();
  for (const [x, at] of inFlight) if (now - at > 180_000) inFlight.delete(x);
  for (const [x, v] of statusOf) if (now - v.at > 180_000) statusOf.delete(x);
  const list = [...new Set([extra, ...[...inFlight.keys()].reverse()])].slice(0, 256);
  const r = await solRpc<any>('getSignatureStatuses', [list, { searchTransactionHistory: false }]).catch(() => null);
  if (!r || !Array.isArray(r.value)) { statusOk = false; statusBackoff = Math.min(8000, statusBackoff ? statusBackoff * 2 : 1000); statusNextAt = Date.now() + statusBackoff; return; }
  statusOk = true; statusBackoff = 0; statusNextAt = 0;
  const at = Date.now();
  list.forEach((x, i) => { const st = r.value?.[i] ?? null; statusOf.set(x, { at, st }); if (settledSt(st)) inFlight.delete(x); });
}
export async function solReceipt(sig: string) {
  let hit = statusOf.get(sig);
  const stale = () => !hit || (!settledSt(hit.st) && Date.now() - hit.at > 300);
  if (stale() && Date.now() >= statusNextAt) {
    await (statusLoad ||= loadStatuses(sig).finally(() => { statusLoad = null; }));
    hit = statusOf.get(sig);
    // a read that succeeded but was already under way without this hash: one more (shared), for it — never after a
    // failed read, which backs off for every caller at once
    if (!hit && statusOk && Date.now() >= statusNextAt) { await (statusLoad ||= loadStatuses(sig).finally(() => { statusLoad = null; })); hit = statusOf.get(sig); }
  }
  const st = hit?.st;
  // the same states as the EVM receipt (pending / confirmed / reverted) so the pages read one shape
  if (!st) return { ok: true, pending: true, state: 'pending' };
  if (st.confirmationStatus === 'processed') return { ok: true, pending: true, state: 'pending', block: st.slot };   // not final, an error at processed included
  if (st.err) return { ok: true, pending: false, state: 'reverted', status: 'reverted', block: st.slot, error: errText({ err: st.err, logs: [] }, 'buy', sigVenue.get(sig) || '').replace(/^Simulation failed: /, 'Failed on chain: ') };
  return { ok: true, pending: false, state: 'confirmed', status: 'success', block: st.slot };
}
export async function solTokenMeta(mint: string) {
  const r = await fetch(API('/token/' + mint + '/price')).then((x) => x.json()).catch(() => null);
  return { symbol: r?.symbol || mint.slice(0, 4), decimals: 6 };
}
// Relay deposits out of Solana: instructions + an address lookup table → a signed v0 transaction
// Relay's Solana deposit: one instruction to its depository program — 8-byte discriminator, the amount (u64),
// then a request id. Before signing, the vault asks Relay itself for the same route: the page's instructions
// must use the same programs and accounts and carry the same discriminator and amount; only the id may differ.
export const RELAY_SOL_CHAIN = 792703809;
type RelayIx = { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const ixBytes = (d: string) => (/^[0-9a-f]*$/i.test(d) && d.length % 2 === 0 ? Uint8Array.from((d.match(/../g) || []).map((h) => parseInt(h, 16))) : fromB64(d));
export async function solBridgeDeposit(a: SolAcct, q: { originChainId: number; destinationChainId: number; amount: string; recipient: string; step: { instructions?: RelayIx[]; addressLookupTableAddresses?: string[] } }) {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  if (Number(q.originChainId) !== RELAY_SOL_CHAIN) throw new Error('Not a Solana deposit');
  const me = solKeys(a.key).address;
  const page = q.step?.instructions || []; if (!page.length || page.length > 4) throw new Error('Relay gave no Solana deposit');
  const dest = Number(q.destinationChainId);
  const r = await fetch('https://api.relay.link/quote/v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: me, recipient: q.recipient, originChainId: RELAY_SOL_CHAIN, destinationChainId: dest, originCurrency: '11111111111111111111111111111111', destinationCurrency: '0x0000000000000000000000000000000000000000', amount: q.amount, tradeType: 'EXACT_INPUT' }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  const own: RelayIx[] = j?.steps?.find((s: any) => s.kind === 'transaction')?.items?.[0]?.data?.instructions || [];
  if (!own.length) throw new Error('Relay: ' + (j?.message || 'no quote to check against'));
  if (own.length !== page.length) throw new Error('Deposit does not match Relay\'s own quote — refused');
  for (let i = 0; i < own.length; i++) {
    const x = page[i], y = own[i];
    if (x.programId !== y.programId || x.keys.length !== y.keys.length || x.keys.some((k, n) => k.pubkey !== y.keys[n].pubkey || k.isSigner !== y.keys[n].isSigner || k.isWritable !== y.keys[n].isWritable)) throw new Error('Deposit accounts are not Relay\'s for this route — refused');
    const bx = ixBytes(x.data), by = ixBytes(y.data);
    if (bx.length !== by.length || bx.slice(0, 16).some((b, n) => b !== by[n])) throw new Error('Deposit amount or instruction differs from Relay\'s quote — refused');
  }
  const amt = ixBytes(page[0].data).slice(8, 16); let v = 0n; for (let n = 7; n >= 0; n--) v = (v << 8n) | BigInt(amt[n]);
  if (v !== BigInt(q.amount)) throw new Error('Deposit amount does not match what you typed — refused');
  return solSendInstructions(a, page, q.step.addressLookupTableAddresses || []);
}
export async function solSendInstructions(a: SolAcct, list: { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[], tableKeys: string[]) {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  const k = solKeys(a.key);
  const ixs: Ix[] = list.map((x) => ({ program: x.programId, keys: x.keys.map((y) => ({ pubkey: y.pubkey, signer: y.isSigner, writable: y.isWritable })), data: /^[0-9a-f]*$/i.test(x.data) && x.data.length % 2 === 0 ? Uint8Array.from((x.data.match(/../g) || []).map((h) => parseInt(h, 16))) : fromB64(x.data) }));
  if (ixs.some((i) => i.keys.some((y) => y.signer && y.pubkey !== k.address))) throw new Error('The bridge asked for a signer that is not this wallet');
  const tables: { key: string; addresses: string[] }[] = [];
  for (const t of tableKeys) { const acc = await account(t); if (!acc) continue; const d = acc.data; const addrs: string[] = []; for (let o = 56; o + 32 <= d.length; o += 32) addrs.push(b58e(d.subarray(o, o + 32))); tables.push({ key: t, addresses: addrs }); }
  const plan = await sendPlan({ slippage: 1, gasBoost: 1.5, turbo: false });
  const msg = compileV0(k.address, [...budget(300_000, plan.micro), ...ixs], await blockhash(), tables);
  const { tx, sig } = signMessage(msg, k.seed);
  await solRpc('sendTransaction', [toB64(tx), { encoding: 'base64', skipPreflight: false, maxRetries: 5 }]);
  return b58e(sig);
}
