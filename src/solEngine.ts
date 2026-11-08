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
// - (pumphop, 2026-11-01) a coin whose live curve is quoted in another pump coin Q, where Q trades against SOL on its own
//   curve or its canonical PumpSwap pool: PumpSwap multi_hop_swap, ONE instruction SOL → Q → the coin (a sell the reverse),
//   exact in with one minimum on the far end. Every account is derived from the two mints and read from the chain (never a
//   page hint), quoted locally (protocol fee on the SOL hop, creator fee on the coin's hop), always simulated before it is
//   signed; a simulation that fails for anything but the trader's own limits goes to the Jupiter route instead.
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
import { directIxsChecked, directInnerGuard, directBalanceGuard, directPriceCheck, directQuoteCheck } from './floatDirect.ts';   // the USD buy from the reserve (appended at the end)

export type SolAcct = { id: string; name: string; address: string; key?: string; ext?: string };
// mev (TC-M2, exec-quality 2026-11-04): webEngine's per-lane MEV-protection map; `mev.sol` on = Jito bundle-only sends
export type SolSettings = { slippage: number; gasBoost: number; turbo: boolean; solTip?: number; solPriority?: number; mev?: Record<string, boolean> };
// 'jupiter': a coin pump.fun quotes in another token, with no Meteora DLMM pool against SOL — `quote` is that token
export type SolRoute = { mint: string; venue: 'pump' | 'pumpswap' | 'dlmm' | 'jupiter' | 'pumphop'; tokenProgram: string; decimals: number; symbol: string; pool: string; isCashback: boolean; isMayhem: boolean; baseVault?: string; quoteVault?: string; dlmm?: DlmmRoute; dlmmAlts?: { pool: string; dlmm: DlmmRoute }[]; dlmmMore?: { p: Promise<{ pool: string; dlmm: DlmmRoute }[]>; v?: { pool: string; dlmm: DlmmRoute }[] }; quote?: string; quoteSymbol?: string; hop?: HopRoute; fee?: TransferFee };
// (token2022-fee, 2026-11-01) a Token-2022 coin that charges a transfer fee (TransferFeeConfig), read from its mint account:
// `bps` / `lowBps` the fee in force (the same figure), or — while a change the fee authority scheduled may not have taken effect
// yet — the higher / lower of the old and the new fee; `nextBps` from epoch `nextEpoch` on; `maxFee` the per-transfer cap in raw
// units; `changeable` = a fee authority exists (it can schedule a new fee, which takes effect two epochs later); `freezable` = the
// mint's freeze authority is set. Such a coin trades only through the Jupiter route (feeMintFacts, loadRoute).
export type TransferFee = { bps: number; lowBps: number; maxFee: string; nextBps: number; nextEpoch: number; changeable: boolean; freezable: boolean };
// 'pumphop': the quote coin Q (`quote`), its token program, and where Q meets SOL — its live curve, or its canonical PumpSwap
// pool and that pool's two vaults (read from the pool account; they never change)
export type HopRoute = { quote: string; quoteProgram: string; via: 'curve' | 'pool'; pool?: string; baseVault?: string; quoteVault?: string };
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
  multiHop: [43, 100, 73, 19, 233, 246, 111, 148],  // pump_amm multi_hop_swap (pump-public-docs idl/pump_amm.json, October 2026)
};
// Anchor account discriminators the vault checks before it trusts a DLMM account's bytes
const LB_PAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13], BIN_ARRAY_DISC = [92, 142, 92, 220, 5, 148, 70, 181];

// ── program derived addresses ──
const onCurve = (b: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
const pdaCache = new Map<string, string>();
export function pda(seeds: Uint8Array[], program: string, memo = true): string {
  const key = memo ? program + ':' + seeds.map((s) => b58e(s)).join(',') : ''; const hit = memo ? pdaCache.get(key) : undefined; if (hit) return hit;
  const prog = b58d(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), prog, te.encode('ProgramDerivedAddress')));
    if (!onCurve(h)) { const a = b58e(h); if (memo) pdaCache.set(key, a); return a; }
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
// F-38 V12: every read method here returns the JSON-RPC { context, value } envelope (value may legitimately be
// null/[] for an absent account). A node that answers with anything else — a bare string/number, or no value at
// all — is returning garbage, not a verdict on the call: treat it as that node being down and fall through to the
// next road, instead of handing the malformed result to the trade logic.
const validRead = (method: string, r: any): boolean => !READS.has(method) || (r != null && typeof r === 'object' && 'value' in r);
export async function solRpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  if (READS.has(method)) for (const u of USER_READS) {
    if (Date.now() < (userDown.get(u) || 0)) continue;
    try { const r = await rpcAt<T>(u, method, params, 6000); if (!validRead(method, r)) throw new RpcError('malformed RPC response', 0); return r; } catch { userDown.set(u, Date.now() + 30_000); }
  }
  if (READS.has(method) && Date.now() > publicDownUntil) {
    try { const r = await rpcAt<T>(PUBLIC_RPC, method, params); if (!validRead(method, r)) throw new RpcError('malformed RPC response', 0); return r; } catch { publicDownUntil = Date.now() + 30_000; }   // any trouble there: the indexer's node answers
  }
  const r = await rpcAt<T>(RPC_URL(), method, params);
  if (!validRead(method, r)) throw new RpcError('malformed RPC response', 0);   // last road: a bad shape is a failed read, not a usable result
  return r;
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
// TC-M2: the Jito tip with the read-only jitodontfront key appended (the System program ignores extra accounts; to be proven by a
// mainnet simulateTransaction before release — test/sol-mev-protect.mjs)
const tipIxGuarded = (from: string, to: string, lamports: bigint) => ix(P.system, [[from, true, true], [to, false, true], [JITO_DONT_FRONT, false, false]], cat(u32(2), u64(lamports)));
const ataCreate = (payer: string, owner: string, mint: string, tokenProgram: string) => ix(P.ata, [[payer, true, true], [ataOf(owner, mint, tokenProgram), false, true], [owner, false, false], [mint, false, false], [P.system, false, false], [tokenProgram, false, false]], Uint8Array.of(1));
const syncNative = (acc: string) => ix(P.token, [[acc, false, true]], Uint8Array.of(17));
const closeAcc = (acc: string, dest: string, owner: string, tokenProgram = P.token) => ix(tokenProgram, [[acc, false, true], [dest, false, true], [owner, true, false]], Uint8Array.of(9));

// ── state of a coin on chain ──
type Curve = { vTok: bigint; vQuote: bigint; realTok: bigint; realQuote: bigint; supply: bigint; complete: boolean; creator: string; mayhem: boolean; cashback: boolean; quoteMint: string; creatorFeeBps: bigint };
function decodeCurve(d: Uint8Array): Curve {
  return { vTok: rdU64(d, 8), vQuote: rdU64(d, 16), realTok: rdU64(d, 24), realQuote: rdU64(d, 32), supply: rdU64(d, 40), complete: d[48] === 1, creator: rdKey(d, 49), mayhem: d[81] === 1, cashback: d[82] === 1, quoteMint: d.length >= 115 ? rdKey(d, 83) : P.system, creatorFeeBps: d.length >= 123 ? rdU64(d, 115) : 0n };
}
type Tier = { threshold: bigint; lp: bigint; protocol: bigint; creator: bigint };
function decodeFeeConfig(d: Uint8Array): { flat: Tier; tiers: Tier[]; exotic?: Tier } {
  let o = 8 + 1 + 32; const fees = () => { const lp = rdU64(d, o), protocol = rdU64(d, o + 8), creator = rdU64(d, o + 16); o += 24; return { lp, protocol, creator }; };
  const flat = { threshold: 0n, ...fees() };
  const n = new DataView(d.buffer, d.byteOffset).getUint32(o, true); o += 4; const tiers: Tier[] = [];
  for (let i = 0; i < n && i < 64; i++) { const lo = rdU64(d, o), hi = rdU64(d, o + 8); o += 16; tiers.push({ threshold: (hi << 64n) | lo, ...fees() }); }
  // (pumphop) then stable_fee_tiers and exotic_flat_fees — the schedule of a curve quoted in a pump coin; absent on an older layout
  let exotic: Tier | undefined;
  if (n <= 64 && o + 4 <= d.length) { const m = new DataView(d.buffer, d.byteOffset).getUint32(o, true); o += 4 + 40 * m; if (m <= 64 && o + 24 <= d.length) exotic = { threshold: 0n, ...fees() }; }
  return { flat, tiers, ...(exotic ? { exotic } : {}) };
}
const feeCfgCache = new Map<string, { at: number; v: { flat: Tier; tiers: Tier[]; exotic?: Tier } }>();
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
  // V13 (speed, G1): a route up to 60 s old is served and, past 20 s, re-read behind the click (the trade re-reads the
  // market accounts in its first round trip anyway; a completed curve re-routes there as before)
  const hit = routeCache.get(mint);
  const load = () => { let p = routeLoads.get(mint); if (!p) { p = loadRoute(mint, hint).finally(() => routeLoads.delete(mint)); routeLoads.set(mint, p); } return p; };
  if (hit && Date.now() - hit.at < 20000) return Promise.resolve(hit.r);
  if (hit && Date.now() - hit.at < 60000) { load().catch(() => {}); return Promise.resolve(hit.r); }
  return load();
}
async function loadRoute(mint: string, hint?: any): Promise<SolRoute> {
  // the hint only names the symbol: it is fetched beside the chain read, never in front of it
  const hP = hint && hint.chain === 'sol' && hint.mint === mint ? Promise.resolve(hint) : fetch(API('/token/' + mint + '/route'), { signal: AbortSignal.timeout(4000) }).then((x) => x.json()).catch(() => null);
  // (fix1 trade-speed-06, 2026-11-01) a page hint that names no pump.fun market (Jupiter / DLMM / LaunchLab coins, ~1 in 5 on the
  // board): the vault's OWN indexer read that the no-pump branch below needs (F-54) starts now, beside the chain read, instead of
  // after it — one round trip less on a cold route. Still the vault's own fetch, never the page's word; a pump / PumpSwap hint
  // starts nothing extra, and a hint that turns out wrong is caught by the chain read as before.
  const idxP = hint && hint.chain === 'sol' && hint.mint === mint && hint.venue !== 'pump' && hint.venue !== 'pumpswap' && hint.venue !== 'pumphop'
    ? fetch(API('/token/' + mint + '/route'), { signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null) : null;
  // the facts that decide what gets signed are read from the chain, not taken from the hint: mint, curve and the
  // canonical PumpSwap pool (derived from the mint) in one read, so a migrated coin costs no second round trip
  const pool0 = canonicalPool(mint);
  // (pumphop) a hint naming the coin's quote token only says WHICH three accounts to read beside the coin's (that token's mint,
  // curve and canonical pool, all derived here): they are used only if the coin's own curve, read in the same call, names
  // exactly that token — otherwise they are read again from the curve's word. A hint without a quote reads what it always read.
  const hq = hint && hint.chain === 'sol' && hint.mint === mint && typeof hint.quote === 'string' && hint.quote !== mint && hint.quote !== P.wsol && SOL_ADDR.test(hint.quote) && b58d(hint.quote).length === 32 ? String(hint.quote) : '';
  const first = await accounts([mint, curveOf(mint), pool0, ...(hq ? [hq, curveOf(hq), canonicalPool(hq)] : [])]);
  const [mintAcc, curveAcc, poolAcc] = first;
  if (mintAcc === undefined || curveAcc === undefined || poolAcc === undefined) throw new Error(READ_FAIL);
  if (!mintAcc) throw new Error('Unknown mint');
  const tokenProgram = mintAcc.owner; if (tokenProgram !== P.token && tokenProgram !== P.token22) throw new Error('Not an SPL token');
  const decimals = mintAcc.data[44];
  // (token2022-fee, 2026-11-01; owner «я даю добро на все»: WOW 72yxYm…, a 3 % transfer-fee coin, was refused "charges a transfer
  // fee") a Token-2022 coin with a TransferFeeConfig trades through the Jupiter route only — never the vault's own pump / PumpSwap /
  // DLMM builders, whose quotes know nothing of the fee. Jupiter quotes what the wallet really receives after the fee (measured:
  // WOW buy outAmount = the simulated balance change to the unit; a sell's quote is what the pool pays for the amount less the fee),
  // and jupiterTradeOne still checks every instruction and the simulated balances against that minimum. A fee coin that also
  // carries an extension that can take, lock or hide the wallet's tokens is refused here (feeMintFacts), with nothing sent.
  // A classic SPL mint, or a Token-2022 mint without a fee (every pump.fun coin), goes on below exactly as before.
  const fee = tokenProgram === P.token22 ? feeMintFacts(mintAcc.data) : null;
  if (fee) {
    if (fee.refuse) throw new Error(fee.refuse);
    const h = await Promise.race([hP, Promise.resolve(null)]);
    const r: SolRoute = { mint, venue: 'jupiter', tokenProgram, decimals, symbol: String(h?.symbol || ''), pool: '', isCashback: false, isMayhem: false, quote: '', fee: fee.fee };
    routeCache.set(mint, { at: Date.now(), r }); return r;
  }
  let venue: SolRoute['venue'] = 'pumpswap'; let isCashback = false, isMayhem = false; let pool = '';
  let baseVault: string | undefined, quoteVault: string | undefined, dlmm: DlmmRoute | undefined, dlmmAlts: { pool: string; dlmm: DlmmRoute }[] | undefined, dlmmMore: SolRoute['dlmmMore'];
  // why pump.fun has no SOL market for this coin (then its Meteora DLMM pool against SOL is the venue, if it has one)
  let noPumpSol = '', quotedIn = '';
  // coins-fix (b): the quote token's symbol, for words only (the indexer's answer; never decides what is signed)
  let quoteSym = '';
  // (2026-10-30) a completed curve whose canonical PumpSwap pool does not exist (an older coin migrated to a Raydium pool)
  let pumpNoPool = false;
  if (curveAcc && curveAcc.owner === P.pump) {
    const c = decodeCurve(curveAcc.data); isCashback = c.cashback; isMayhem = c.mayhem;
    if (c.quoteMint !== P.system && c.quoteMint !== P.wsol) { noPumpSol = 'This coin\'s pump.fun market is quoted in another token, not SOL'; quotedIn = c.quoteMint; }
    venue = c.complete ? 'pumpswap' : 'pump';
  } else noPumpSol = 'Not a pump.fun coin: no curve and no PumpSwap pool';
  // (pumphop, 2026-11-01) a live curve quoted in a pump coin Q that trades against SOL (Q's live curve, or its canonical PumpSwap
  // pool): one multi_hop_swap from SOL. Q's three accounts come from the first read when the hint named Q, else one more read;
  // anything that does not check out (or a read that failed) leaves the coin to the routes below, exactly as before.
  if (quotedIn && venue === 'pump' && !isMayhem && !isCashback) {
    const qa: Got[] = hq === quotedIn ? first.slice(3, 6) : await accounts([quotedIn, curveOf(quotedIn), canonicalPool(quotedIn)]).catch(() => [undefined, undefined, undefined]);
    const ext = mintExtensions(mintAcc.data);
    const hop = ext.has(1) || ext.has(14) ? null : hopFromChain(mint, quotedIn, qa[0], qa[1], qa[2]);
    if (hop) {
      const h = await Promise.race([hP, Promise.resolve(null)]);
      const r: SolRoute = { mint, venue: 'pumphop', tokenProgram, decimals, symbol: String(h?.symbol || ''), pool: curveOf(mint), isCashback: false, isMayhem: false, hop, quote: quotedIn, quoteSymbol: symText(h?.quoteSymbol) };
      routeCache.set(mint, { at: Date.now(), r }); return r;
    }
  }
  if (!noPumpSol && venue === 'pumpswap') {
    pool = pool0;
    const pa = poolAcc;
    if (!pa || pa.owner !== P.pamm) { noPumpSol = 'The curve is complete and its PumpSwap pool is not open yet — try again in a few seconds'; pumpNoPool = true; }
    else {
      if (rdKey(pa.data, 43) !== mint || rdKey(pa.data, 75) !== P.wsol) throw new Error('Pool does not match the coin');
      isCashback = pa.data[8 + 1 + 2 + 32 * 6 + 8 + 32 + 1] === 1;
      // the pool's vaults never change: knowing them here lets a quote read pool + vaults in one call
      baseVault = rdKey(pa.data, 139); quoteVault = rdKey(pa.data, 171);
    }
  }
  if (noPumpSol) {
    // F-54 V12: DLMM candidates come ONLY from the indexer's program-account search, never from the page hint —
    // a compromised page must not be able to name the pool a trade routes through. The page hint is read only for
    // the display symbol (below); here the indexer's route is fetched fresh when the hint is a page hint, and each
    // candidate it names is still verified on chain in dlmmPoolsOf (enabled LB pair of exactly this mint vs SOL).
    const idxRoute = hint && hint.chain === 'sol' && hint.mint === mint
      ? await (idxP ?? fetch(API('/token/' + mint + '/route'), { signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null))
      : await hP;
    quoteSym = symText(idxRoute?.quoteSymbol);
    // (2026-10-28, jeff HAsTKX…: its market is a Raydium CPMM pool $58k deep, its DLMM pools $3k) a coin that is not a
    // pump.fun coin at all and whose indexer route names Jupiter (its real market is a Raydium pool or a LaunchLab curve,
    // sol-indexer raySwitch / isLab) trades through Jupiter, which routes over every venue, instead of a thin DLMM pool.
    // The indexer only names the PATH, never a pool or an account: jupiterTradeOne still builds, simulates and checks the
    // transaction itself (inner-instruction guard, wallet balances, its own price check) before anything is signed.
    // (2026-10-30, LAZARUS DBaxXw… / ALLINDOGE HyDKNd…: pump.fun coins whose curve completed before PumpSwap and migrated to a
    // Raydium AMM pool — "not open yet" on every click, for good) the same holds for a completed curve with no PumpSwap pool.
    const viaJupiter = !quotedIn && (!(curveAcc && curveAcc.owner === P.pump) || pumpNoPool) && !!idxRoute && idxRoute.ok === true && idxRoute.venue === 'jupiter' && idxRoute.mint === mint && idxRoute.tradeable !== false;
    if (viaJupiter) {
      const ext = mintExtensions(mintAcc.data);
      if (ext.has(1)) throw new Error('This coin charges a transfer fee (Token-2022) — not supported here');
      if (ext.has(14)) throw new Error('This coin carries a transfer hook (Token-2022) — not supported here');
      venue = 'jupiter'; isCashback = false;
      const h = await Promise.race([hP, Promise.resolve(null)]);
      const r: SolRoute = { mint, venue, tokenProgram, decimals, symbol: String(h?.symbol || ''), pool: '', isCashback, isMayhem, quote: '' };
      routeCache.set(mint, { at: Date.now(), r }); return r;
    }
    const named: string[] = Array.isArray(idxRoute?.dlmm) ? idxRoute.dlmm.filter((x: unknown) => typeof x === 'string' && SOL_ADDR.test(x)).slice(0, 8) : [];
    // V13 VA-9: the pools the vault finds on chain itself join the server's list. A coin the server names nothing for
    // waits for that search here (it is the only list there is); otherwise it finishes in the background and a sell
    // waits for it (solTradeIxs), a buy takes it once it is there.
    const disc = dlmmDiscover(mint);
    // (fix2 p2-speed-10, 2026-11-01; a pump.fun coin quoted in another token — the "buni" coins — waited 1.2–2.1 s cold on this
    // search, 5× getMultipleAccounts, before it settled on Jupiter anyway) a coin quoted in another token whose indexer route — the
    // vault's OWN read (F-54) — names Jupiter and no DLMM pool goes to Jupiter without waiting for it: Jupiter routes SOL → that
    // token → the coin over every venue, those DLMM pools included, and jupiterTradeOne still builds, simulates and checks the
    // transaction itself. The search still runs into dlmmMore. Any other coin waits for it exactly as before.
    // (pumphop) an indexer that named the one-instruction route the chain did not confirm here counts as Jupiter's word too
    const jupQuoted = !!quotedIn && !named.length && !!idxRoute && idxRoute.ok === true && (idxRoute.venue === 'jupiter' || idxRoute.venue === 'pumphop') && idxRoute.mint === mint && idxRoute.tradeable !== false;
    if (!named.length && !jupQuoted) named.push(...(await disc.catch(() => [] as string[])).slice(0, 8));
    const box: NonNullable<SolRoute['dlmmMore']> = { p: disc.then((all) => { const extra = all.filter((x) => !named.includes(x)).slice(0, 8); return extra.length ? dlmmPoolsOf(mint, extra) : []; }).then((xs) => (box.v = xs.map((f) => ({ pool: f.pool, dlmm: f.route })))) };
    box.p.catch(() => {}); dlmmMore = box;
    const dry: string[] = [];
    const found = named.length ? await dlmmPoolsOf(mint, named, dry) : [];
    const ext = mintExtensions(mintAcc.data);
    if (ext.has(1)) throw new Error('This coin charges a transfer fee (Token-2022) — not supported here');
    if (ext.has(14)) throw new Error('This coin carries a transfer hook (Token-2022) — not supported here');
    if (found.length) {
      // F-54 V12: keep up to 3 verified candidates. Reserve-balance ranking is donatable, so the trade does NOT trust
      // the order here — it quotes each candidate at the real amount and uses the best `out` (see solTradeIxs).
      venue = 'dlmm'; isCashback = false;
      dlmmAlts = found.slice(0, 3).map((f) => ({ pool: f.pool, dlmm: f.route }));
      pool = dlmmAlts[0].pool; dlmm = dlmmAlts[0].dlmm;
    } else if (quotedIn || dry.length) {
      // quoted in another token, no DLMM pool against SOL: Jupiter routes SOL → that token → the coin, and the vault
      // signs only what its own simulation shows to be exactly this trade (jupiterTradeOne)
      // (2026-10-30, HYPERPAD 31FZ9f…: a pump.fun coin quoted in HYPE whose only DLMM pool against SOL is empty — no reserves,
      // no bin array in its bitmap — was routed there and every buy failed "too little liquidity"): a coin whose verified
      // DLMM pools are all dry is routed by Jupiter too, under the same checks
      venue = 'jupiter';
    } else throw new Error(noPumpSol + (named.length ? ' — its Meteora DLMM pools could not be verified' : /not open yet/.test(noPumpSol) ? '' : ' — and no Meteora DLMM pool against SOL was found'));
  }
  const h = await Promise.race([hP, Promise.resolve(null)]);   // a symbol not here yet is not worth waiting for
  const r: SolRoute = { mint, venue, tokenProgram, decimals, symbol: String(h?.symbol || ''), pool, isCashback, isMayhem, baseVault, quoteVault, dlmm, dlmmAlts, dlmmMore, ...(venue === 'jupiter' ? { quote: quotedIn, ...(quotedIn ? { quoteSymbol: quoteSym || symText(h?.quoteSymbol) } : {}) } : {}) };
  routeCache.set(mint, { at: Date.now(), r }); return r;
}
// a symbol for display: short, printable, or nothing
const symText = (v: unknown) => { const t = String(v ?? '').trim(); return /^[\p{L}\p{N} .$_-]{1,16}$/u.test(t) ? t : ''; };
// coins-fix (b): what a coin pump.fun quotes in another token reads when no route from SOL reaches it yet (Jupiter picks a new
// one up minutes late, or never) — the quote token named, instead of a bare "no route"
export const quotedNoRoute = (r: { quote?: string; quoteSymbol?: string }) => `Can't be bought here yet: this coin is quoted in ${r.quoteSymbol || (r.quote ? r.quote.slice(0, 4) + '…' : 'another token')}, and no route from SOL reaches it yet — nothing was sent`;
// the TLV extensions of a Token-2022 mint (type → present); a classic mint has none
function mintExtensions(d: Uint8Array): Set<number> {
  const out = new Set<number>(); if (d.length <= 166 || d[165] !== 1) return out;
  const v = new DataView(d.buffer, d.byteOffset);
  for (let o = 166; o + 4 <= d.length;) { const t = v.getUint16(o, true), n = v.getUint16(o + 2, true); if (!t && !n) break; out.add(t); o += 4 + n; }
  return out;
}
// (token2022-fee) a Token-2022 mint's TLV entries (type → value); null when the layout does not hold together (an entry running
// past the account, or a type twice)
function mintTlv(d: Uint8Array): Map<number, Uint8Array> | null {
  const out = new Map<number, Uint8Array>(); if (d.length <= 166 || d[165] !== 1) return out;
  const v = new DataView(d.buffer, d.byteOffset);
  for (let o = 166; o + 4 <= d.length;) {
    const t = v.getUint16(o, true), n = v.getUint16(o + 2, true); if (!t && !n) break;
    if (o + 4 + n > d.length || out.has(t)) return null;
    out.set(t, d.subarray(o + 4, o + 4 + n)); o += 4 + n;
  }
  return out;
}
// a floor under the chain's current epoch with no read: epoch 1074 was running on 2026-11-01 (1793551206 s), and an epoch
// (432,000 slots) takes under 3 days even at 0.6 s a slot; only ever low, so a fee change counts as done only once it is
const epochFloor = () => 1074 + Math.max(0, Math.floor((Date.now() - 1_793_551_206_000) / 259_200_000));
/** the highest transfer fee a coin may charge here, current or scheduled (basis points) */
export const T22_FEE_MAX_BPS = 1000;
// what a fee coin may carry beside its fee: mint-close authority (only an empty mint closes), interest-bearing / scaled UI amount
// (display only), metadata / group pointers and data. Anything else is refused by type below; an unknown type is refused too.
const T22_FEE_OK = new Set([1, 3, 10, 18, 19, 20, 21, 22, 23, 25]);
const zeros = (b: Uint8Array) => b.every((x) => x === 0);
const feePct = (bps: number) => String(Number((bps / 100).toFixed(2))) + '%';
/**
 * A Token-2022 mint's transfer fee and the vault's verdict on it: null = no TransferFeeConfig (the coin takes the normal routes).
 * `refuse` is the trader's words when the coin must not be traded here: a fee over T22_FEE_MAX_BPS, or an extension that can take
 * tokens out of the wallet (permanent delegate), lock them (non-transferable; pausable; new accounts frozen by default), run
 * someone's code on every transfer (transfer hook), or move balances out of sight (confidential transfers / mint-burn).
 */
export function feeMintFacts(d: Uint8Array): { fee: TransferFee; refuse: string } | null {
  const tlv = mintTlv(d);
  const no = (why: string, fee?: TransferFee) => ({ fee: fee || { bps: 0, lowBps: 0, maxFee: '0', nextBps: 0, nextEpoch: 0, changeable: false, freezable: false }, refuse: `This coin ${why} (Token-2022) — not supported here` });
  if (!tlv) return mintExtensions(d).has(1) ? no('has a mint layout the vault cannot read') : null;
  const cfg = tlv.get(1); if (!cfg) return null;
  if (cfg.length !== 108) return no('has a transfer-fee setting the vault cannot read');
  const at = (o: number) => ({ epoch: Number(rdU64(cfg, o)), max: rdU64(cfg, o + 8), bps: rdU16(cfg, o + 16) });
  const older = at(72), newer = at(90);
  const eff = (f: { max: bigint; bps: number }) => (f.max > 0n ? f.bps : 0);
  // the newer fee is in force from its epoch on; once that epoch has surely passed, the older one is history (BERN: 4.2 % until
  // epoch 698, 2.69 % since) — otherwise (a change scheduled, or just made) both count: the ticket shows the range
  const settled = newer.epoch <= epochFloor();
  const fee: TransferFee = { bps: settled ? eff(newer) : Math.max(eff(older), eff(newer)), lowBps: settled ? eff(newer) : Math.min(eff(older), eff(newer)), maxFee: String(newer.max), nextBps: eff(newer), nextEpoch: newer.epoch, changeable: !zeros(cfg.subarray(0, 32)), freezable: d.length >= 82 && rdU32(d, 46) === 1 };
  for (const [t, v] of tlv) {
    if (T22_FEE_OK.has(t)) continue;
    if (t === 12) { if (v.length >= 32 && zeros(v.subarray(0, 32))) continue; return no('lets its issuer move tokens out of any wallet (permanent delegate)', fee); }
    if (t === 6) { if (v.length >= 1 && v[0] !== 2) continue; return no('opens every new token account frozen', fee); }
    if (t === 14) return no('carries a transfer hook', fee);
    if (t === 9) return no('cannot be transferred', fee);
    if (t === 4 || t === 16 || t === 24) return no('supports confidential (hidden) balances', fee);
    if (t === 26) return no('can be paused by its issuer', fee);
    return no(`carries an extension the vault does not know (type ${t})`, fee);
  }
  if (fee.bps > T22_FEE_MAX_BPS) return no(`charges a ${feePct(fee.bps)} transfer fee — over the ${feePct(T22_FEE_MAX_BPS)} motion trades`, fee);
  return { fee, refuse: '' };
}
/** the ticket's words for a coin's transfer fee: "Transfer fee 3%", "Transfer fee 2.69–4.2%" while a scheduled change is pending */
export const transferFeeText = (f: TransferFee) => 'Transfer fee ' + (f.lowBps === f.bps ? feePct(f.bps) : feePct(f.lowBps) + '–' + feePct(f.bps));
// (pumphop) where the quote coin Q meets SOL, from Q's own accounts as the chain holds them: Q is an SPL mint without a transfer fee
// or hook, has a pump.fun curve paired with SOL, not mayhem, not cashback; live → its curve, complete → its canonical PumpSwap pool
// (index 0, created by Q's pool authority, Q against wrapped SOL, not mayhem, not cashback). null → no pumphop for this coin.
export function hopFromChain(coin: string, q: string, qMint: Got, qCurve: Got, qPool: Got): HopRoute | null {
  if (q === coin || q === P.wsol || q === P.system) return null;
  if (!qMint || (qMint.owner !== P.token && qMint.owner !== P.token22) || qMint.data.length < 82) return null;
  const ext = mintExtensions(qMint.data); if (ext.has(1) || ext.has(14)) return null;
  if (!qCurve || qCurve.owner !== P.pump || qCurve.data.length < 83) return null;
  const qc = decodeCurve(qCurve.data);
  if (qc.mayhem || qc.cashback || (qc.quoteMint !== P.system && qc.quoteMint !== P.wsol)) return null;
  if (!qc.complete) return { quote: q, quoteProgram: qMint.owner, via: 'curve' };
  const d = qPool?.data;
  if (!qPool || qPool.owner !== P.pamm || !d || d.length < 261) return null;
  if (rdU16(d, 9) !== 0 || rdKey(d, 11) !== pumpPda('pool-authority', b58d(q)) || rdKey(d, 43) !== q || rdKey(d, 75) !== P.wsol || d[243] === 1 || d[244] === 1) return null;
  return { quote: q, quoteProgram: qMint.owner, via: 'pool', pool: canonicalPool(q), baseVault: rdKey(d, 139), quoteVault: rdKey(d, 171) };
}
// the named pools, verified on chain and ordered by their SOL reserve (the deepest first); a candidate that is not
// an enabled LB pair of exactly this mint and SOL is dropped, never used
async function dlmmPoolsOf(mint: string, named: string[], dry?: string[]): Promise<{ pool: string; route: DlmmRoute; solReserve: bigint }[]> {
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
    // (2026-10-30) no bin array with liquidity in the pair's own bitmap: quoteDlmm can only answer "too little liquidity"
    // here (it walks nothing past that bitmap), so the pool is no venue; the caller is told it exists but is dry
    if (lb.bitmap.every((w) => w === 0n)) { dry?.push(named[i]); continue; }
    ok.push({ pool: named[i], route: { solIsX, reserveX: lb.reserveX, reserveY: lb.reserveY, oracle: lb.oracle, activeIdx: binArrayIndex(lb.activeId), binStep: lb.binStep } });
  }
  if (!ok.length) return [];
  const res = await readBatch(ok.map((p) => (p.route.solIsX ? p.route.reserveX : p.route.reserveY)));
  const out = ok.map((p, i) => ({ ...p, solReserve: res[i] && res[i]!.data.length >= 72 ? rdU64(res[i]!.data, 64) : 0n }));
  return out.sort((a, b) => (a.solReserve === b.solReserve ? a.route.binStep - b.route.binStep : a.solReserve > b.solReserve ? -1 : 1));
}

// ── V13 VA-9: a coin's Meteora DLMM pools against SOL, found on chain ──
// Up to V12 the candidates came only from the indexer, so a lying server could name nothing but an attacker's pool for a
// non-pump coin and sells were dumped there. Meteora's permissionless pairs are PDAs of the program: [preset_parameter2
// PDA(index), min(mint, SOL), max(mint, SOL)] (verified 2026-10-25 against both live pools of a test coin: presets 14
// and 124; 392 presets exist), plus the customizable pair [ILM base, min, max] and the oldest kind [min, max, bin step].
// Every candidate address is derived here (in slices that yield the thread: ~80 ms of hashing per coin, once per 10 min)
// and checked for existence in batches of 100 through the relay with no account data (the full reads of the pools
// that exist go through dlmmPoolsOf, which verifies each one as before).
const DLMM_PRESETS = 400, DLMM_V1_STEPS = [1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 50, 60, 80, 100, 125, 150, 200, 250, 300, 400];
const DLMM_ILM_BASE = 'MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrcjgtFa';
const u16le = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const breathe = () => new Promise<void>((ok) => setTimeout(ok, 0));
let dlmmPresetList: Promise<string[]> | null = null;
const dlmmPresets = () => (dlmmPresetList ||= (async () => { const out: string[] = []; for (let i = 0; i < DLMM_PRESETS; i++) { out.push(pda([te.encode('preset_parameter2'), u16le(i)], P.dlmm, false)); if (i % 40 === 39) await breathe(); } return out; })());
const lessBytes = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
export async function dlmmCandidateAddrs(mint: string): Promise<string[]> {
  const x = b58d(mint), y = b58d(P.wsol); const [lo, hi] = lessBytes(x, y) ? [x, y] : [y, x];
  const out: string[] = [pda([b58d(DLMM_ILM_BASE), lo, hi], P.dlmm), ...DLMM_V1_STEPS.map((bs) => pda([lo, hi, u16le(bs)], P.dlmm))];
  for (const pre of await dlmmPresets()) { out.push(pda([b58d(pre), lo, hi], P.dlmm, false)); if (out.length % 40 === 0) await breathe(); }
  return out;
}
const dlmmFound = new Map<string, { at: number; p: Promise<string[]> }>();
export function dlmmDiscover(mint: string): Promise<string[]> {
  const hit = dlmmFound.get(mint); if (hit && Date.now() - hit.at < 600_000) return hit.p;
  const p = (async () => {
    const cands = await dlmmCandidateAddrs(mint);
    const parts = slices(cands, 100);
    const got = await Promise.all(parts.map((c) => rpcAt<any>(RPC_URL(), 'getMultipleAccounts', [c, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], 6000)));
    const out: string[] = [];
    got.forEach((g, i) => { const v = g?.value; if (!Array.isArray(v) || v.length !== parts[i].length) throw new Error(READ_FAIL); v.forEach((a: any, j: number) => { if (a && a.owner === P.dlmm) out.push(parts[i][j]); }); });
    return out;
  })();
  p.catch(() => dlmmFound.delete(mint));
  dlmmFound.set(mint, { at: Date.now(), p }); if (dlmmFound.size > 200) dlmmFound.delete(dlmmFound.keys().next().value as string);
  return p;
}

// ── quotes ──
// what a quote needs, as one list of accounts (fee config only when it is not cached)
function marketAddrs(r: SolRoute): string[] {
  if (r.venue === 'pumphop' && r.hop) return hopAddrs(r);
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
  // (native-scenarios 2026-11-04) a fee config read in the last 5 min is not asked for again: marketAddrs left it out of the click's
  // one read for that reason, and the read here was a whole extra round trip on every warm PumpSwap click (its answer was discarded)
  try { cfg = feeCfgFresh(P.ammFeeConfig) || feeConfigFrom(P.ammFeeConfig, m.has(P.ammFeeConfig) ? m.get(P.ammFeeConfig) ?? null : (await readBatch([P.ammFeeConfig]))[0] ?? null); } catch {}
  const mcap = base > 0n ? (quote * 1_000_000_000_000_000n) / base : 0n;
  const tier = cfg ? tierFor(cfg, mcap) : { threshold: 0n, lp: 20n, protocol: 5n, creator: 5n };
  const totalBps = tier.lp + tier.protocol + tier.creator;
  if (side === 'buy') { const net = (amountIn * 10000n) / (10000n + totalBps); return { out: (base * net) / (quote + net), baseVault, quoteVault, totalBps }; }
  const gross = (quote * amountIn) / (base + amountIn); return { out: gross - ceilFee(gross, totalBps), baseVault, quoteVault, totalBps };
}

// ── pumphop: SOL → Q → the coin in one PumpSwap multi_hop_swap (pump-public-docs MULTI_HOP_SWAP.md, October 2026) ──
// What a quote reads, in the click's one market read: the coin's curve, Q's curve (Q live) or Q's pool + its two vaults + Q's mint
// (its supply sizes the pool's fee tier), and the fee configs not cached.
function hopAddrs(r: SolRoute): string[] {
  const h = r.hop!;
  return [curveOf(r.mint), ...(h.via === 'curve' ? [curveOf(h.quote)] : [h.pool!, h.baseVault!, h.quoteVault!, h.quote]),
    ...(feeCfgFresh(P.pumpFeeConfig) ? [] : [P.pumpFeeConfig]), ...(h.via === 'pool' && !feeCfgFresh(P.ammFeeConfig) ? [P.ammFeeConfig] : [])];
}
// the route no longer holds on chain (Q's pool changed, the coin turned mayhem / cashback …): the click goes to Jupiter
const HOP_STALE = 'The route through this coin\'s quote token does not hold right now';
async function feeCfgOf(addr: string, m: Market) {
  const hit = feeCfgFresh(addr); if (hit) return hit;
  const acc = m.has(addr) ? m.get(addr) : (await readBatch([addr]))[0];
  if (acc === undefined) throw new Error(READ_FAIL);
  return feeConfigFrom(addr, acc ?? null);
}
// exact in, net of one fee taken on top (the program's rounding: fee = ceil(net × bps / 10 000), net + fee ≤ in)
const netOfFee = (x: bigint, bps: bigint) => { if (bps <= 0n) return x; let net = (x * 10000n) / (10000n + bps); const cost = net + ceilFee(net, bps); if (cost > x) net -= cost - x; return net; };
export type HopQuote = { out: bigint; mid: bigint; protocolBps: bigint; creatorBps: bigint };
// Fees once per route (MULTI_HOP_SWAP.md "Fees"): the protocol fee on the hop that trades SOL, at that curve's / pool's own rate;
// the creator fee on the coin's curve; nothing else (no LP fee: the pool is not the far end). The curve and pool formulas are the
// programs' own, checked against mainnet multi_hop_swap events (a buy spends net − 1 on both a curve and a pool; a sell takes
// gross − fee): test/pumphop.mjs. A buy past what a curve has left is quoted at what is left (the rest buys at a worse price).
export async function quotePumphop(r: SolRoute, side: 'buy' | 'sell', amountIn: bigint, pre?: Market): Promise<HopQuote> {
  const h = r.hop; if (r.venue !== 'pumphop' || !h) throw new Error(HOP_STALE);
  const addrs = hopAddrs(r);
  const m: Market = pre && addrs.every((a) => pre.has(a)) ? pre : (await readMarket(r)).m;
  const tAcc = m.get(curveOf(r.mint)); if (!tAcc || tAcc.owner !== P.pump) throw new Error('Curve not found');
  const tc = decodeCurve(tAcc.data);
  if (tc.complete) throw new Error(CURVE_DONE);
  if (tc.quoteMint !== h.quote || tc.mayhem || tc.cashback) throw new Error(HOP_STALE);
  const pumpCfg = await feeCfgOf(P.pumpFeeConfig, m);
  // a curve quoted in a pump coin: its own creator fee when set, else the schedule for such quotes (exotic_flat_fees)
  const creatorBps = tc.creator === P.system ? 0n : tc.creatorFeeBps > 0n ? tc.creatorFeeBps : (pumpCfg.exotic ?? tierFor(pumpCfg, 0n)).creator;
  // the SOL side: Q's curve (lamports / Q) or Q's pool (vault + the pool's virtual quote reserves / base vault)
  let protocolBps: bigint, solToQ: (lamports: bigint) => bigint, qToSol: (q: bigint) => bigint;
  if (h.via === 'curve') {
    const qAcc = m.get(curveOf(h.quote)); if (!qAcc || qAcc.owner !== P.pump) throw new Error(HOP_STALE);
    const qc = decodeCurve(qAcc.data);
    if (qc.complete) throw new Error(CURVE_DONE);   // Q just completed: the click re-reads the route (Q's pool, once it opens)
    if (qc.mayhem || qc.cashback || (qc.quoteMint !== P.system && qc.quoteMint !== P.wsol)) throw new Error(HOP_STALE);
    const mcap = qc.vTok > 0n ? (qc.vQuote * 1_000_000_000_000_000n) / qc.vTok : 0n;
    protocolBps = tierFor(pumpCfg, mcap).protocol;
    solToQ = (net) => { if (net <= 1n) return 0n; const t = ((net - 1n) * qc.vTok) / (qc.vQuote + net - 1n); return t > qc.realTok ? qc.realTok : t; };
    qToSol = (q) => (q * qc.vQuote) / (qc.vTok + q);
  } else {
    const pa = m.get(h.pool!);
    if (!pa || pa.owner !== P.pamm || pa.data.length < 261 || rdKey(pa.data, 43) !== h.quote || rdKey(pa.data, 75) !== P.wsol || rdKey(pa.data, 139) !== h.baseVault || rdKey(pa.data, 171) !== h.quoteVault || pa.data[243] === 1 || pa.data[244] === 1) throw new Error(HOP_STALE);
    const bv = m.get(h.baseVault!), qv = m.get(h.quoteVault!), qm = m.get(h.quote);
    if (!bv || !qv || bv.data.length < 72 || qv.data.length < 72) throw new Error('Pool vaults not found');
    const base = rdU64(bv.data, 64), quote = rdU64(qv.data, 64) + rdI128(pa.data, 245);
    if (base <= 0n || quote <= 0n) throw new Error(CODE_TEXT.TooLittlePoolTokenLiquidity);
    const supply = qm && qm.data.length >= 44 ? rdU64(qm.data, 36) : 1_000_000_000_000_000n;
    protocolBps = tierFor(await feeCfgOf(P.ammFeeConfig, m), (quote * supply) / base).protocol;
    solToQ = (net) => (net <= 1n ? 0n : (base * (net - 1n)) / (quote + net - 1n));
    qToSol = (q) => (quote * q) / (base + q);
  }
  if (side === 'buy') {
    const mid = solToQ(netOfFee(amountIn, protocolBps));
    const n2 = netOfFee(mid, creatorBps);
    let out = n2 <= 1n ? 0n : ((n2 - 1n) * tc.vTok) / (tc.vQuote + n2 - 1n); if (out > tc.realTok) out = tc.realTok;
    return { out, mid, protocolBps, creatorBps };
  }
  const g1 = (amountIn * tc.vQuote) / (tc.vTok + amountIn), mid = g1 - ceilFee(g1, creatorBps);
  if (mid <= 0n) return { out: 0n, mid: 0n, protocolBps, creatorBps };
  const g2 = qToSol(mid);
  return { out: g2 - ceilFee(g2, protocolBps), mid, protocolBps, creatorBps };
}
// the 16 fixed accounts of multi_hop_swap, then 5 per hop in route order (a curve hop: base mint, quote mint, curve, the curve's
// base and quote token accounts; a pool hop: base mint, quote mint, pool, its two vaults). A buy pays from this wallet's
// wrapped-SOL account (funded in this transaction when Q's SOL side is its pool; Q's curve takes native SOL and only reads the
// account's mint), a sell lands there; the account is opened if missing and closed at the end, so SOL comes back as SOL.
export function pumphopIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, minOut: bigint): Ix[] {
  const h = r.hop!; const wsolAta = ataOf(user, P.wsol, P.token), coinAta = ataOf(user, r.mint, r.tokenProgram);
  const tCurve = curveOf(r.mint), qCurve = curveOf(h.quote);
  const hopT: [string, boolean, boolean][] = [[r.mint, false, false], [h.quote, false, false], [tCurve, false, true], [ataOf(tCurve, r.mint, r.tokenProgram), false, true], [ataOf(tCurve, h.quote, h.quoteProgram), false, true]];
  const hopQ: [string, boolean, boolean][] = h.via === 'curve'
    ? [[h.quote, false, false], [P.wsol, false, false], [qCurve, false, true], [ataOf(qCurve, h.quote, h.quoteProgram), false, true], [ataOf(qCurve, P.wsol, P.token), false, true]]
    : [[h.quote, false, false], [P.wsol, false, false], [h.pool!, false, true], [h.baseVault!, false, true], [h.quoteVault!, false, true]];
  const [inAta, outAta] = side === 'buy' ? [wsolAta, coinAta] : [coinAta, wsolAta];
  const accs: [string, boolean, boolean][] = [
    [user, true, true], [inAta, false, true], [outAta, false, true], [P.ammGlobalConfig, false, false], [P.ammFeeConfig, false, false],
    [ammPda('user_volume_accumulator', b58d(user)), false, true], [ataOf(pick(BUYBACK), P.wsol, P.token), false, true],
    [P.token, false, false], [P.token22, false, false], [P.system, false, false], [ammPda('__event_authority'), false, false], [P.pamm, false, false],
    [P.pump, false, false], [pumpPda('global'), false, false], [P.pumpFeeConfig, false, false], [pumpPda('__event_authority'), false, false],
    ...(side === 'buy' ? [...hopQ, ...hopT] : [...hopT, ...hopQ]),
  ];
  const out: Ix[] = [ataCreate(user, user, P.wsol, P.token)];
  if (side === 'buy') { if (h.via === 'pool') out.push(transferIx(user, wsolAta, amount), syncNative(wsolAta)); out.push(ataCreate(user, user, r.mint, r.tokenProgram)); }
  out.push(ix(P.pamm, accs, cat(Uint8Array.from(DISC.multiHop), u64(amount), u64(minOut))), closeAcc(wsolAta, user, user));
  return out;
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
// V13 (speed, G1): stale-while-revalidate. A value up to SWR_MAX old is served at once and, past SWR_FRESH, one refresh
// starts behind it: the click no longer waits ~420 ms for the relay's fee estimate whenever the 10 s cache had just
// expired between two prewarms (13–30 % of clicks, measured 2026-10-25).
const SWR_FRESH = 5_000, SWR_MAX = 60_000;
let tipFloor: any = null, tipAt = 0, tipLoad: Promise<any> | null = null;
function tips(): Promise<any> {
  const age = Date.now() - tipAt;
  if (tipFloor && age < SWR_MAX) { if (age > SWR_FRESH) loadTips().catch(() => {}); return Promise.resolve(tipFloor); }
  return loadTips();
}
function loadTips(): Promise<any> {
  return (tipLoad ||= fetch(API('/jito/tipfloor'), { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => { tipLoad = null; if (j) { tipFloor = j; tipAt = Date.now(); } return j || tipFloor || FALLBACK_TIPS; }));
}
let feeLv: any = null, feeAt = 0, feeLoad: Promise<any> | null = null;
function feeLevels(): Promise<any> {
  const age = Date.now() - feeAt;
  if (feeLv && age < SWR_MAX) { if (age > SWR_FRESH) loadFeeLevels().catch(() => {}); return Promise.resolve(feeLv); }
  return loadFeeLevels();
}
function loadFeeLevels(): Promise<any> {
  return (feeLoad ||= Promise.race([solRpc<any>('getPriorityFeeEstimate', [{ accountKeys: [P.pump, P.pamm, P.dlmm], options: { includeAllPriorityFeeLevels: true } }]).catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 3000))])
    .then((est) => { feeLoad = null; const lv = est?.priorityFeeLevels; if (lv) { feeLv = lv; feeAt = Date.now(); } return lv || feeLv || {}; }));
}
// TC-M2: with MEV protection on, a trade is sent ONLY to Jito block engines as a one-transaction bundle (bundleOnly): it is
// never forwarded to a leader as a plain transaction, so nobody can put a trade in front of it inside the auction, and a
// bundle that would fail does not land (no fee). Such a send must tip (Jito's minimum is 1,000 lamports): at least the
// tip floor's p50 in every mode, Eco included. jitodontfront (read-only key on the tip transfer) makes the block engine
// refuse any bundle that places another transaction before ours.
export const JITO_DONT_FRONT = 'jitodontfront111111111111111111111111111111';
export async function sendPlan(s: SolSettings) {
  const mode = s.turbo ? 'turbo' : (s.gasBoost || 1) <= 1 ? 'eco' : 'fast';
  const protect = s.mev?.sol === true;
  const pinnedTip = s.solTip && s.solTip > 0 ? Math.min(0.1, s.solTip) : 0;
  const pinnedMicro = s.solPriority && s.solPriority > 0 ? s.solPriority : 0;
  // tip floor and fee levels side by side, and only the ones this plan actually uses
  const [t, lv] = await Promise.all([(pinnedTip || mode === 'eco') && !protect ? FALLBACK_TIPS : tips(), pinnedMicro ? ({} as any) : feeLevels()]);
  let tipSol = pinnedTip ? pinnedTip : mode === 'turbo' ? Math.min(0.003, Math.max(0.0002, t.p95 || 0.0015)) : mode === 'fast' ? Math.min(0.001, Math.max(0.00005, t.p75 || 0.00002)) : 0;
  // a protected send lands only through the tip: never under the floor's p50 (live 2026-11-04: ~0.0000078 SOL) or 1,000 lamports
  if (protect) tipSol = Math.max(tipSol, Math.min(0.001, Number(t.p50) || 0.00001), 0.000001);
  let micro = pinnedMicro || Number(mode === 'turbo' ? lv.veryHigh : mode === 'fast' ? lv.high : lv.medium) || (mode === 'eco' ? 1000 : 50000);
  micro = Math.ceil(Math.max(0, Math.min(Number(micro) || 0, mode === 'turbo' ? 5_000_000 : 2_000_000)));
  // F-8 V12: defense in depth. A settings page can pin solTip≤0.1 SOL and solPriority≤5M µlamports with no click,
  // which at 400k CU would cost ~2 SOL/tx in priority fee + tip. Clamp the APPLIED tip + priority so one
  // transaction's extra cost can't exceed ~0.005 SOL at the worst-case compute limit, whatever the settings say.
  // (Default eco/fast/turbo plans already sit at or under this, so legitimate trading is unchanged.)
  const FEE_CEIL = 5_000_000n;   // ~0.005 SOL total extra cost per transaction
  const CU_CEIL = 400_000n;      // the most compute units a trade is ever signed with (see maxUnits in tradeOne)
  let tipLamports = BigInt(Math.round(tipSol * 1e9));
  if (tipLamports > FEE_CEIL) tipLamports = FEE_CEIL;
  const prioCeilMicro = ((FEE_CEIL - tipLamports) * 1_000_000n) / CU_CEIL;   // µlamports/CU that keeps tip + priority ≤ the ceiling
  if (BigInt(micro) > prioCeilMicro) micro = Number(prioCeilMicro);
  return { mode, tipLamports, micro, protect };
}
// A blockhash stays valid for ~150 slots (≈60 s); one fetched up to maxAgeMs ago is reused, so all the
// wallets of a click (and a click right after a hover) sign over the same one without waiting for it.
// F-1/F-5 V12: the cache now also carries lastValidBlockHeight (lvh) — the last block height this blockhash can
// land at — and the time it was read. A signed send whose status is unknown is held until lvh passes, and the
// trade path refetches a blockhash older than 20 s before signing so the hold window stays tight.
type BlockhashInfo = { v: string; lvh: number; at: number };
let bhCache: BlockhashInfo | null = null, bhLoad: Promise<BlockhashInfo> | null = null;
function blockhash(maxAgeMs = 0): Promise<BlockhashInfo> {
  if (bhCache && Date.now() - bhCache.at < maxAgeMs) return Promise.resolve(bhCache);
  return (bhLoad ||= solRpc<any>('getLatestBlockhash', [{ commitment: 'confirmed' }])
    .then((r) => { const c: BlockhashInfo = { v: r.value.blockhash as string, lvh: Number(r.value.lastValidBlockHeight), at: Date.now() }; bhCache = c; return c; })
    .finally(() => { bhLoad = null; }));
}
async function newerBlockhash(than: string): Promise<BlockhashInfo> {
  let b = await blockhash(0);
  for (let i = 0; i < 4 && b.v === than; i++) { await new Promise((ok) => setTimeout(ok, 200)); b = await blockhash(0); }
  return b;
}
// hover / route check: the plan inputs and a blockhash are loaded before the click
let warmAt = 0;
export function solWarm() {
  if (Date.now() - warmAt < 3000) return; warmAt = Date.now();
  // V13 (G1): the blockhash is re-read once it is 5 s old (behind the hover, not on the click)
  tips().catch(() => {}); feeLevels().catch(() => {}); blockhash(SWR_FRESH).catch(() => {});
  jitoWarm();
}
// V13 (speed, G5): the Jito send roads stay warm and are ordered by what this browser measures. Nothing kept them warm
// (each send paid TCP + TLS, ~148 ms cold vs ~46 warm), and Fast took the list order (mainnet + ny; ny is 113 ms of TCP
// from Europe). The first warm-up times four close regions; afterwards the two fastest are pinged every 25 s while the
// lane is in use (getTipAccounts: no state, far under the ~1 request / s / region the block engine allows), and a send
// takes regions fastest first. A ping counts as that region's use for the next second, so a send never 429s on it.
const jitoRtt = new Map<string, number>(); let jitoWarmAt = 0;
function jitoWarm() {
  const now = Date.now(); if (now - jitoWarmAt < 25_000) return; jitoWarmAt = now;
  const first = jitoRtt.size === 0;
  const list = first ? JITO_ENDPOINTS.slice(0, 4) : [...jitoRtt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([u]) => u);
  for (const u of list) {
    if (now - (jitoLast.get(u) || 0) < 1000) continue;
    jitoLast.set(u, now); const t0 = performance.now();
    fetch(u + '/api/v1/bundles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getTipAccounts","params":[]}', keepalive: true, signal: AbortSignal.timeout(4000) })
      .then((r) => { if (r.ok) { const ms = performance.now() - t0; jitoRtt.set(u, Math.min(jitoRtt.get(u) ?? Infinity, ms)); } }).catch(() => {});
  }
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
function jitoRoads(mode: string, click?: Click, protect = false): string[] {
  if (mode === 'eco' && !protect) return [];
  const want = mode === 'turbo' ? Math.max(2, Math.ceil(JITO_ENDPOINTS.length / Math.max(1, click?.size || 1))) : 2;
  const now = Date.now();
  // V13 (G5): measured regions first, fastest first; the rest in the list's order
  const order = [...JITO_ENDPOINTS].sort((a, b) => (jitoRtt.get(a) ?? 1e9) - (jitoRtt.get(b) ?? 1e9));
  let picked = order.filter((u) => now - (jitoLast.get(u) || 0) >= 1000).slice(0, want);
  if (!picked.length) picked = [JITO_ENDPOINTS[jitoTurn++ % JITO_ENDPOINTS.length]];
  for (const u of picked) jitoLast.set(u, now);
  return picked;
}
// A send has three outcomes, not two: some road accepted it (the hash), every road refused it in words (not sent —
// the refusal is the message), or roads went silent (timeout / network) with none accepting — then the bytes may
// still have reached a leader, so the status is unknown: never re-sent by itself, tracked, and said so.
export class SolSendUnknown extends Error { hash = ''; }
const silent = (e: any) => Number(e?.status) >= 500 || /timeout|timed out|abort|failed to fetch|networkerror|load failed|fetch failed/i.test(String(e?.name || '') + ' ' + String(e?.message || e || ''));
async function broadcast(tx: Uint8Array, mode: string, click?: Click, protect = false) {
  const b64 = toB64(tx);
  // TC-M2: protected = Jito only, bundle-only; the RPC, publicnode and the user's nodes never see the bytes
  if (protect) {
    const roads = jitoRoads(mode === 'eco' ? 'fast' : mode, click, true).map((u) => rpcAt<string>(u + '/api/v1/transactions?bundleOnly=true', 'sendTransaction', [b64, { encoding: 'base64' }], 8000));
    try { return await firstOk(roads); } catch {
      const errs = (await Promise.allSettled(roads)).map((x) => (x.status === 'rejected' ? x.reason : null)).filter(Boolean);
      if (errs.some(silent)) throw new SolSendUnknown('No block engine confirmed it received the transaction — its status is unknown. Check the wallet before trying again');
      throw new Error('Not sent: ' + String((errs[0] as any)?.message || 'every block engine refused it').slice(0, 140) + ' (MEV protection is on: Jito only)');
    }
  }
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
  // Jupiter v6
  SlippageToleranceExceeded: SLIP,
  // pump_amm / pump multi_hop_swap (pumphop)
  MultiHopDiscontinuousPath: 'pump.fun refused the route through this coin\'s quote token (the hops do not connect) — nothing was sent',
  MultiHopCurveRunMismatch: 'pump.fun refused the route through this coin\'s quote token — nothing was sent; try again',
  MultiHopMixedDirection: 'pump.fun refused the route through this coin\'s quote token (mixed directions) — nothing was sent',
  MultiHopMayhemCurveNotSupported: 'pump.fun does not route through mayhem-mode coins — nothing was sent',
};
// a landed failure carries only {"InstructionError":[i,{"Custom":n}]}: the number means a different thing per program
const CUSTOM_TEXT: Record<string, Record<number, string>> = {
  pump: { 6002: SLIP, 6003: SLIP, 6042: SLIP, 6005: CODE_TEXT.BondingCurveComplete, 6040: CODE_TEXT.BuyNotEnoughSolToCoverRent, 6041: CODE_TEXT.BuyNotEnoughSolToCoverFees, 6021: CODE_TEXT.NotEnoughTokensToBuy, 6023: CODE_TEXT.NotEnoughTokensToSell },
  pumpswap: { 6004: SLIP, 6040: SLIP, 6002: CODE_TEXT.ZeroQuoteAmount, 6003: CODE_TEXT.TooLittlePoolTokenLiquidity, 6039: CODE_TEXT.BuyNotEnoughQuoteTokensToCoverFees, 6020: CODE_TEXT.DisabledBuy, 6021: CODE_TEXT.DisabledSell },
  jupiter: { 6001: SLIP },
  // a multi_hop_swap failure carries PumpSwap's code (6004 ExceededSlippage, 6084–6086 the route) or, from its curve hops, pump's
  // (6002 / 6003 / 6042 slippage, 6005 a curve completed, 6108 a mayhem curve)
  pumphop: { 6004: SLIP, 6040: SLIP, 6002: SLIP, 6003: SLIP, 6042: SLIP, 6005: CODE_TEXT.BondingCurveComplete, 6084: CODE_TEXT.MultiHopDiscontinuousPath, 6085: CODE_TEXT.MultiHopCurveRunMismatch, 6086: CODE_TEXT.MultiHopMixedDirection, 6108: CODE_TEXT.MultiHopMayhemCurveNotSupported },
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
  // a Jupiter route is fetched, checked and simulated per wallet (jupiterTradeOne) — never built from here
  if (r.venue === 'jupiter') throw new Error('This coin trades through Jupiter: use the wallet trade path');
  if (r.venue === 'pumphop') {
    const q = await quotePumphop(r, side, amount, pre);
    if (q.out <= 0n) throw new Error(side === 'buy' ? 'Amount too small to buy anything' : 'Amount too small for this pool');
    let minOut = slipMin(q.out, slippage); if (minOut <= 0n) minOut = 1n;   // multi_hop_swap refuses a zero minimum
    return { ixs: pumphopIxs(user, r, side, amount, minOut), expected: q.out, minOut };
  }
  if (r.venue === 'pump') {
    const q = await quotePump(r.mint, side, amount, pre);
    let minOut = slipMin(q.out, slippage); if (side === 'buy' && minOut <= 0n) minOut = 1n;
    return { ixs: pumpIxs(user, r, side, amount, minOut), expected: q.out, minOut };
  }
  if (r.venue === 'dlmm') {
    // F-54 V12: quote every verified candidate at the real amount and take the pool with the best `out`. The
    // deepest-reserve order from loadRoute is donatable, so the pool is chosen by what it actually fills here.
    // V13 VA-9: plus the pools the vault found on chain itself — a sell waits for that search (it is normally done since
    // the route was loaded), a buy takes it only when it is already there; a search that failed leaves the server's list.
    const base = r.dlmmAlts?.length ? r.dlmmAlts : (r.dlmm ? [{ pool: r.pool, dlmm: r.dlmm }] : []);
    const more = r.dlmmMore ? (side === 'sell' ? await r.dlmmMore.p.catch(() => []) : r.dlmmMore.v || []) : [];
    const cands = [...base, ...more.filter((m) => !base.some((b) => b.pool === m.pool))].slice(0, 6);
    let best: { q: DlmmQuote; rr: SolRoute } | null = null; let lastErr: unknown;
    // V13 (speed, G7): every candidate is quoted at once (one round trip, not one per candidate)
    const quotes = await Promise.all(cands.map(async (c) => {
      const rr: SolRoute = c.pool === r.pool && c.dlmm === r.dlmm ? r : { ...r, pool: c.pool, dlmm: c.dlmm };
      try { return { q: await quoteDlmm(rr, side, amount, rr === r ? pre : undefined), rr }; } catch (e) { lastErr = e; return null; }
    }));
    for (const x of quotes) if (x && x.q.out > 0n && (!best || x.q.out > best.q.out)) best = x;
    if (!best) { if (lastErr) throw lastErr; throw new Error(side === 'buy' ? 'Amount too small to buy anything' : 'Amount too small for this pool'); }
    let minOut = slipMin(best.q.out, slippage); if (minOut <= 0n) minOut = 1n;
    return { ixs: dlmmIxs(user, best.rr, side, amount, minOut, best.q.binArrays), expected: best.q.out, minOut };
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
// F-1/F-55 V12: a send whose status is unknown can still land until its blockhash's lastValidBlockHeight passes, and
// Solana has no nonce to make a second send collide — so ANY further outflow from that wallet (a trade, a transfer,
// an unwrap, a bridge) could land too and move the funds twice. The wallet is held by sender: every outflow refuses
// until the held signature is seen confirmed/finalized (it landed) or its blockhash expires (it never will). No
// wall-clock release — a silent node can sit on the bytes past any fixed timeout and still land them.
const unknownSends = new Map<string, { sig: string; lvh: number }>();
// release the hold only on a verdict from the relay or publicnode (never a user-set node): the signature is
// confirmed/finalized with a real slot (it landed), or the chain's confirmed height has passed the blockhash's
// lastValidBlockHeight (the signed bytes can no longer land). Anything else keeps the wallet held.
async function releaseIfSettled(held: { sig: string; lvh: number }): Promise<boolean> {
  const [st] = await solSigStatusesBoth([held.sig]).catch(() => [undefined]);
  if (st && typeof st.slot === 'number' && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return true;
  try { const h = await solRpc<number>('getBlockHeight', [{ commitment: 'confirmed' }]); if (typeof h === 'number' && h > held.lvh) return true; } catch {}
  return false;
}
async function solHoldGate(sender: string): Promise<void> {
  const held = unknownSends.get(sender);
  if (!held) return;
  if (await releaseIfSettled(held)) { unknownSends.delete(sender); return; }
  throw new Error(`Your previous send from this wallet (${held.sig.slice(0, 8)}…) has an unknown status and may still land — wait until it shows up or its blockhash expires before sending again`);
}
// every Solana outflow signs its bytes, then hands them here: the wallet is refused while a prior send is unknown
// (solHoldGate), the same bytes go out on every road (broadcast), and if every road went silent the send is NOT a
// failure — the bytes may have reached a leader. The wallet is then held by sender and a SolSendUnknown carrying
// the signature is thrown, so the caller (and webEngine's once()) keeps the job "sending", never retried.
async function sendSigned(tx: Uint8Array, hash: string, lvh: number, holdKey: string, opts: { mode?: string; click?: Click; venue?: string; protect?: boolean } = {}): Promise<string> {
  await solHoldGate(holdKey);
  const { mode = 'eco', click, venue = '', protect = false } = opts;
  try { await broadcast(tx, mode, click, protect); }
  catch (e) {
    if (e instanceof SolSendUnknown) { e.hash = hash; trackSig(hash, venue); unknownSends.set(holdKey, { sig: hash, lvh }); }
    throw e;
  }
  trackSig(hash, venue);
  return hash;
}
// ── Jupiter: coins pump.fun quotes in another token (2026-10-25) ──
// pump.fun now lets a coin be quoted in any token (BTC-pump, wBTC, USDC, PUMP …). One with no Meteora DLMM pool against
// SOL is routed by Jupiter: SOL → that token → the coin (XRP 83WuTB…: DLMM SOL→BTC-pump, then PumpSwap BTC-pump→XRP).
// The vault asks Jupiter for the quote and the instructions itself (never through the page or the motion server) and
// signs only what passes two checks:
//   1. the instructions (jupIxsChecked): token-account opens paid by and owned by this wallet, a SOL transfer into this
//      wallet's own wrapped-SOL account and its sync (a buy, at most the amount), ONE Jupiter v6 swap, closing the
//      wrapped-SOL account back to this wallet — nothing else, and no signer but this wallet;
//   2. the balances (jupBalanceGuard), from the vault's own simulation against the chain now: SOL out ≤ the amount +
//      fees + the rent of the accounts it opens (a sell: SOL in ≥ Jupiter's minimum − fees − rent); the coin in ≥
//      Jupiter's minimum (a sell: the coin out ≤ the amount); no other token account of this wallet loses a unit, gets
//      a new delegate or is closed, and the wrapped-SOL account never ends below what it held.
const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const JUP_API = 'https://lite-api.jup.ag/swap/v1';
const JUP_UNITS_MAX = 700_000;            // a two-hop DLMM + PumpSwap route measured well under it
const JUP_FEE_CEIL = 5_000_000n;          // the F-8 ceiling (tip + priority ≤ ~0.005 SOL) held at Jupiter's compute limit
const JUP_TOKENS_MAX = 60;                // the token accounts one simulation is checked against
export type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type JupQuote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number; routePlan?: { swapInfo?: { label?: string } }[] };
const JUP_REFUSE = 'Jupiter\'s transaction holds an instruction the vault does not sign — refused';

export function jupIxsChecked(list: JupIx[], user: string, side: 'buy' | 'sell', amount: bigint): { ixs: Ix[]; opens: number } {
  const wsolAta = ataOf(user, P.wsol, P.token);
  let swaps = 0, opens = 0;
  const ixs = list.map((x): Ix => {
    if (!x || typeof x.programId !== 'string' || !Array.isArray(x.accounts) || typeof x.data !== 'string') throw new Error(JUP_REFUSE);
    if (x.accounts.some((a) => a.isSigner && a.pubkey !== user)) throw new Error('Jupiter asked for a signer that is not this wallet — refused');
    const data = fromB64(x.data), keys = x.accounts.map((a) => a.pubkey);
    let ok = false;
    if (x.programId === JUP_PROGRAM) { swaps += 1; ok = true; }
    // create / create_idempotent: paid by this wallet, for this wallet
    else if (x.programId === P.ata) { ok = (data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1))) && keys[0] === user && keys[2] === user; if (ok) opens += 1; }
    // a buy funds this wallet's own wrapped-SOL account with at most the amount
    else if (x.programId === P.system) ok = side === 'buy' && data.length === 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0 && keys[0] === user && keys[1] === wsolAta && rdU64(data, 4) <= amount;
    else if (x.programId === P.token && data.length === 1) {
      if (data[0] === 17) ok = keys.length === 1 && keys[0] === wsolAta;                                                // sync_native
      else if (data[0] === 9) ok = keys.length === 3 && keys[0] === wsolAta && keys[1] === user && keys[2] === user;    // close_account → this wallet
    }
    if (!ok) throw new Error(JUP_REFUSE);
    return { program: x.programId, keys: x.accounts.map((a) => ({ pubkey: a.pubkey, signer: a.isSigner, writable: a.isWritable })), data };
  });
  if (swaps !== 1) throw new Error('Jupiter\'s transaction must hold exactly one swap — refused');
  return { ixs, opens };
}

// a token account's amount, owner and delegate (the SPL / Token-2022 base layout); null when it is not a token account
export type TokState = { mint: string; owner: string; amount: bigint; delegate: string };
export const tokState = (acc: { owner: string; data: Uint8Array } | null | undefined): TokState | null =>
  acc && (acc.owner === P.token || acc.owner === P.token22) && acc.data.length >= 165
    ? { mint: rdKey(acc.data, 0), owner: rdKey(acc.data, 32), amount: rdU64(acc.data, 64), delegate: acc.data[72] === 1 ? rdKey(acc.data, 76) : '' } : null;

// the simulated outcome must be exactly this trade (see the block comment); returns the reason it is not, or ''
export function jupBalanceGuard(g: {
  side: 'buy' | 'sell'; amount: bigint; minOut: bigint; feesMax: bigint; rentMax: bigint; user: string;
  solBefore: bigint; solAfter: bigint; coinBefore: bigint; coinAfter: bigint | null;
  wsolBefore: TokState | null; wsolAfter: TokState | null;
  others: { address: string; before: TokState; after: TokState | null }[];
  /** security audit VA-6: the wrapped-SOL account's lamports before / after (0 when it does not exist / was closed) */
  wsolLamportsBefore?: bigint; wsolLamportsAfter?: bigint;
}): string {
  // VA-6: the wallet's native SOL and its wrapped-SOL account count as ONE total — Jupiter's cleanup closes the wSOL account, so a
  // separate wSOL check saw nothing and pre-held wSOL could be spent (a buy) or stand in for the proceeds (a sell)
  const nativeBefore = g.solBefore + (g.wsolLamportsBefore ?? 0n), nativeAfter = g.solAfter + (g.wsolLamportsAfter ?? 0n);
  if (g.side === 'buy') {
    if (nativeBefore - nativeAfter > g.amount + g.feesMax + g.rentMax) return 'it would take more SOL than the amount and its fees';
    if (g.coinAfter === null || g.coinAfter - g.coinBefore < g.minOut) return 'it would deliver less of the coin than Jupiter\'s minimum';
  } else {
    if (g.coinAfter !== null && g.coinBefore - g.coinAfter > g.amount) return 'it would take more of the coin than the amount';
    if (nativeAfter - nativeBefore < g.minOut - g.feesMax - g.rentMax) return 'it would return less SOL than Jupiter\'s minimum';
  }
  if (g.wsolBefore && g.wsolAfter && g.wsolAfter.amount < g.wsolBefore.amount) return 'it would spend wrapped SOL this wallet already held';
  for (const o of g.others) {
    if (!o.after) return `it would close the token account ${o.address.slice(0, 6)}…`;
    if (o.after.owner !== g.user) return `it would hand the token account ${o.address.slice(0, 6)}… to someone else`;
    if (o.after.amount < o.before.amount) return `it would take ${o.before.mint.slice(0, 6)}… tokens this wallet holds`;
    if (o.after.delegate !== o.before.delegate) return `it would let someone spend ${o.before.mint.slice(0, 6)}… tokens`;
  }
  return '';
}

// security audit VA-7: Jupiter's price is not trusted alone — the route must pay within 30 % of motion's own market price (the
// SOL lane's pool / curve price ÷ SOL/USD), read beside the quote. A sell with no motion price is refused (it can lose up to the
// whole position); a buy without one goes ahead (bounded by the trade cap).
let solUsdMemo: { at: number; v: number } | null = null;
async function motionPriceSol(mint: string): Promise<number | null> {
  try {
    const solUsdP = solUsdMemo && Date.now() - solUsdMemo.at < 30_000 ? Promise.resolve(solUsdMemo.v)
      : fetch(API('/prices'), { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).then((j) => { const v = Number(j?.ethUsd); if (v > 0) solUsdMemo = { at: Date.now(), v }; return v; });
    const [q, solUsd] = await Promise.all([fetch(API('/quotes?addrs=' + encodeURIComponent(mint)), { signal: AbortSignal.timeout(3000) }).then((x) => x.json()), solUsdP]);
    const row = q?.quotes?.[mint]; const usd = Number(row?.price), age = Number(row?.priceAgeMs ?? 0);
    return usd > 0 && solUsd > 0 && age < 120_000 ? usd / solUsd : null;
  } catch { return null; }
}
// (token2022-fee) `feeBps`: a coin's transfer fee takes its share on the way — a buy delivers the coin less the fee, a sell's pool
// receives the amount less the fee — so the fair figure is that much lower (the lower of the mint's two fees: the stricter check)
export function jupPriceCheck(o: { side: 'buy' | 'sell'; amount: bigint; minOut: bigint; decimals: number; priceSol: number | null; feeBps?: number }): string {
  if (o.priceSol == null || !(o.priceSol > 0)) return o.side === 'sell' ? 'motion has no market price for this coin right now — a Jupiter sell needs one' : '';
  const amt = Number(o.amount), min = Number(o.minOut);
  const fair = o.side === 'buy' ? (amt / 1e9) / o.priceSol * 10 ** o.decimals : (amt / 10 ** o.decimals) * o.priceSol * 1e9;
  const net = o.feeBps && o.feeBps > 0 ? 1 - Math.min(o.feeBps, 10000) / 10000 : 1;
  return min < fair * net * 0.7 ? 'the route pays far less than the market price' : '';
}
// one quote per click for every wallet buying the same amount (Jupiter's free API answers 429 to bursts): shared for 1.5 s
const jupQuoteMemo = new Map<string, { at: number; p: Promise<JupQuote> }>();
function jupQuote(r: SolRoute, side: 'buy' | 'sell', amount: bigint, slippage: number): Promise<JupQuote> {
  const k = [r.mint, side, String(amount), slippage].join('|'), hit = jupQuoteMemo.get(k);
  if (hit && Date.now() - hit.at < 1500) return hit.p;
  const p = jupQuoteFresh(r, side, amount, slippage); jupQuoteMemo.set(k, { at: Date.now(), p }); p.catch(() => jupQuoteMemo.delete(k));
  for (const [x, v] of jupQuoteMemo) if (Date.now() - v.at > 10_000) jupQuoteMemo.delete(x);
  return p;
}
async function jupQuoteFresh(r: SolRoute, side: 'buy' | 'sell', amount: bigint, slippage: number): Promise<JupQuote> {
  const bps = Math.max(1, Math.min(5000, Math.round(slippage * 100)));
  const [inM, outM] = side === 'buy' ? [P.wsol, r.mint] : [r.mint, P.wsol];
  const url = `${JUP_API}/quote?inputMint=${inM}&outputMint=${outM}&amount=${amount}&slippageBps=${bps}&swapMode=ExactIn&restrictIntermediateTokens=true`;
  const q: JupQuote | null = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
  if (!q || typeof q.outAmount !== 'string' || typeof q.otherAmountThreshold !== 'string') throw new Error(r.quote ? quotedNoRoute(r) : 'Jupiter found no route for this coin right now — nothing was sent; try again');
  if (q.inputMint !== inM || q.outputMint !== outM || q.inAmount !== String(amount) || q.swapMode !== 'ExactIn' || Number(q.slippageBps) !== bps) throw new Error('Jupiter answered for a different trade — refused');
  const out = BigInt(q.outAmount), min = BigInt(q.otherAmountThreshold);
  // the minimum must be the quote less YOUR slippage — a looser one would let a bad fill through the balance check
  if (!(min > 0n) || min > out || min * 10000n < out * BigInt(10000 - bps) - 10000n) throw new Error('Jupiter\'s minimum does not match your slippage — refused');
  return q;
}
async function jupInstructions(q: JupQuote, user: string): Promise<{ list: JupIx[]; tables: string[] }> {
  const j: any = await fetch(`${JUP_API}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }), signal: AbortSignal.timeout(10000) }).then((x) => x.json()).catch(() => null);
  if (!j || j.error || !j.swapInstruction) throw new Error('Jupiter did not build the swap — nothing was sent; try again');
  if (j.tokenLedgerInstruction || (Array.isArray(j.otherInstructions) && j.otherInstructions.length)) throw new Error(JUP_REFUSE);
  const list: JupIx[] = [...(Array.isArray(j.setupInstructions) ? j.setupInstructions : []), j.swapInstruction, ...(j.cleanupInstruction ? [j.cleanupInstruction] : [])];
  const tables: string[] = Array.isArray(j.addressLookupTableAddresses) ? j.addressLookupTableAddresses.filter((x: unknown) => typeof x === 'string' && SOL_ADDR.test(x)).slice(0, 4) : [];
  return { list, tables };
}
// speed (2026-10-25): the route's lookup tables are cached for 10 minutes and the missing ones read in ONE call (they were read
// one by one on every click); a table only ever grows, so a cached prefix stays valid
const jupTableCache = new Map<string, { at: number; addresses: string[] }>();
async function jupTables(keys: string[]): Promise<{ key: string; addresses: string[] }[]> {
  const now = Date.now();
  const miss = keys.filter((k) => { const hit = jupTableCache.get(k); return !hit || now - hit.at > 600_000; });
  if (miss.length) {
    const got = await accounts(miss);
    miss.forEach((k, i) => { const acc = got[i]; if (!acc) throw new Error(READ_FAIL); const addrs: string[] = []; for (let o = 56; o + 32 <= acc.data.length; o += 32) addrs.push(b58e(acc.data.subarray(o, o + 32))); jupTableCache.set(k, { at: now, addresses: addrs }); });
  }
  return keys.map((k) => ({ key: k, addresses: jupTableCache.get(k)!.addresses }));
}
/** a coin's Jupiter route warmed when its page opens: the quote's connection and the route's lookup tables are ready before the
 *  click (a throwaway user key: the tables depend on the route, not the wallet) */
const jupWarmed = new Map<string, number>();
// Jupiter Swap V2 /build (2026-10-25; Swap V1 /quote + /swap-instructions is no longer maintained): ONE request returns the quote,
// the raw instructions and the route's lookup tables — no Jupiter fee on /build (the /order path charges 10–50 bps). Keyless from
// the browser (0.5 requests/s per user); on a 429 the same request goes once through motion's server (/sol/api/jup/build), which
// adds the API key server-side — the vault still checks every instruction, the price, the tables and the simulation itself.
const JUP_V2 = 'https://api.jup.ag/swap/v2';
type JupBuilt = { quote: JupQuote; list: JupIx[]; tables: string[]; claimed: Record<string, string[]> };
export async function jupBuild(r: SolRoute, side: 'buy' | 'sell', amount: bigint, slippage: number, user: string): Promise<JupBuilt> {
  const bps = Math.max(1, Math.min(5000, Math.round(slippage * 100)));
  const [inM, outM] = side === 'buy' ? [P.wsol, r.mint] : [r.mint, P.wsol];
  const qs = `inputMint=${inM}&outputMint=${outM}&amount=${amount}&taker=${user}&slippageBps=${bps}&wrapAndUnwrapSol=true`;
  const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(8000) }).then(async (x) => ({ status: x.status, j: await x.json().catch(() => null) }));
  let res = await get(`${JUP_V2}/build?${qs}`).catch(() => ({ status: 0, j: null as any }));
  if (res.status === 429 || res.status === 0) res = await get(API('/jup/build?' + qs)).catch(() => ({ status: 0, j: null as any }));
  const j: any = res.j;
  if (!j || j.error || !j.swapInstruction || typeof j.outAmount !== 'string' || typeof j.otherAmountThreshold !== 'string') throw new Error(res.status === 429 ? 'Jupiter is busy right now — nothing was sent; try again in a second' : r.quote ? quotedNoRoute(r) : 'Jupiter found no route for this coin right now — nothing was sent; try again');
  if (j.inputMint !== inM || j.outputMint !== outM || j.inAmount !== String(amount) || j.swapMode !== 'ExactIn' || Number(j.slippageBps) !== bps) throw new Error('Jupiter answered for a different trade — refused');
  const out = BigInt(j.outAmount), min = BigInt(j.otherAmountThreshold);
  // the minimum must be the quote less YOUR slippage — a looser one would let a bad fill through the balance check
  if (!(min > 0n) || min > out || min * 10000n < out * BigInt(10000 - bps) - 10000n) throw new Error('Jupiter\'s minimum does not match your slippage — refused');
  if ((Array.isArray(j.otherInstructions) && j.otherInstructions.length) || j.tipInstruction || j.tokenLedgerInstruction) throw new Error(JUP_REFUSE);
  const list: JupIx[] = [...(Array.isArray(j.setupInstructions) ? j.setupInstructions : []), j.swapInstruction, ...(j.cleanupInstruction ? [j.cleanupInstruction] : [])];
  const map = j.addressesByLookupTableAddress && typeof j.addressesByLookupTableAddress === 'object' ? j.addressesByLookupTableAddress as Record<string, unknown> : {};
  const tables = Object.keys(map).filter((k) => SOL_ADDR.test(k)).slice(0, 4);
  const claimed: Record<string, string[]> = {};
  for (const k of tables) claimed[k] = Array.isArray(map[k]) ? (map[k] as unknown[]).map(String) : [];
  const quote: JupQuote = { inputMint: j.inputMint, outputMint: j.outputMint, inAmount: j.inAmount, outAmount: j.outAmount, otherAmountThreshold: j.otherAmountThreshold, swapMode: j.swapMode, slippageBps: Number(j.slippageBps), routePlan: j.routePlan };
  return { quote, list, tables, claimed };
}

export function solJupWarm(r: SolRoute): void {
  if (r.venue !== 'jupiter' || Date.now() - (jupWarmed.get(r.mint) || 0) < 60_000) return;
  jupWarmed.set(r.mint, Date.now());
  const user = b58e(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  void jupBuild(r, 'buy', 100_000_000n, 5, user).then((b) => jupTables(b.tables)).catch(() => {});
}
// security without a slow read (2026-10-25): every move of this wallet's funds INSIDE the simulated transaction, from the node's
// parsed inner instructions. Allowed: SOL into its own wrapped-SOL account (a buy, ≤ the amount); a rent payment for an account the
// transaction creates; token transfers signed by this wallet only from its wrapped-SOL account, the coin's account (a sell, ≤ the
// amount) or an account this transaction created (a route's intermediate token, empty before); closing an account back to it.
// Anything else signed by this wallet (another token account, an approval, an authority change, a burn) is refused.
// `through` (owner's yes, 2026-10-27: a POOH sell routed through an account of this wallet that already existed and was refused):
// a transfer this wallet signs from another of its token accounts (or from its wSOL account on a sell) is collected there instead
// of refused; the caller then reads those accounts before the simulation and in it, and jupBalanceGuard refuses any that ends
// lower, closed, handed to someone else or delegated. Without `through` the old rule stands (refused).
export function jupInnerGuard(g: { inner: unknown; user: string; side: 'buy' | 'sell'; amount: bigint; wsolAta: string; coinAta: string; rentMax: bigint; through?: Set<string> }): string {
  const groups = Array.isArray(g.inner) ? g.inner : null;
  if (!groups) return 'no inner instructions';
  const created = new Set<string>();
  const big = (v: unknown) => { try { return BigInt(String(v ?? '0')); } catch { return -1n; } };
  for (const grp of groups) for (const x of (grp as any)?.instructions || []) {
    const t = x?.parsed?.type, i = x?.parsed?.info || {};
    if (x?.program === 'system' && (t === 'createAccount' || t === 'createAccountWithSeed') && i.source === g.user) { if (big(i.lamports) > g.rentMax) return 'it pays more rent than the accounts it opens need'; created.add(String(i.newAccount)); }
    else if (x?.program === 'spl-associated-token-account' && (t === 'create' || t === 'createIdempotent') && i.wallet === g.user) created.add(String(i.account));
  }
  let spent = 0n, wrapped = 0n;
  for (const grp of groups) for (const x of (grp as any)?.instructions || []) {
    const prog = x?.program, t = x?.parsed?.type, i = x?.parsed?.info || {};
    // a token instruction the node could not parse is refused (it could be anything); other programs' inner calls are the swap itself
    if (!x?.parsed) { if (x?.programId === P.token || x?.programId === P.token22 || x?.programId === P.system) return 'it holds an instruction the node could not read'; continue; }
    if (prog === 'system' && t === 'transfer' && i.source === g.user) {
      if (g.side === 'buy' && i.destination === g.wsolAta) { wrapped += big(i.lamports); continue; }
      if (created.has(String(i.destination))) continue;
      return 'it sends SOL from this wallet somewhere else';
    }
    if (prog === 'spl-token' || prog === 'spl-token-2022') {
      // initialising an account this transaction created names this wallet as its OWNER (not a signature): allowed
      if ((t === 'initializeAccount' || t === 'initializeAccount2' || t === 'initializeAccount3' || t === 'initializeImmutableOwner') && created.has(String(i.account))) continue;
      if (t === 'getAccountDataSize') continue;
      const auth = i.authority ?? i.owner ?? i.multisigAuthority ?? i.multisigOwner;
      if (auth !== g.user) continue;
      if (t === 'transfer' || t === 'transferChecked' || t === 'transferCheckedWithFee') {
        const src = String(i.source), amt = big(i.amount ?? i.tokenAmount?.amount);
        if (src === g.wsolAta && g.side === 'buy') continue;
        if (src === g.coinAta && g.side === 'sell') { spent += amt; continue; }
        if (created.has(src)) continue;
        if (g.through) { if (src !== g.wsolAta) g.through.add(src); continue; }
        return `it moves tokens out of ${src.slice(0, 6)}…`;
      }
      if (t === 'closeAccount' && i.destination === g.user && (i.account === g.wsolAta || created.has(String(i.account)))) continue;
      if (t === 'syncNative') continue;
      return `it signs a token ${t || 'instruction'} for this wallet`;
    }
  }
  if (wrapped > g.amount) return 'it wraps more SOL than the amount';
  if (spent > g.amount) return 'it sells more of the coin than the amount';
  return '';
}
// the rent this wallet pays for accounts the simulated transaction opens (jupInnerGuard has already capped each one at
// RENT_ATA22 and refused any other SOL leaving the wallet). A route opens accounts the top-level list does not show — an
// intermediate token's account, PumpSwap's per-user volume accumulator — so the balance check counts these, not the ATA
// creates it can see (2026-10-25: XRP via Meteora DLMM → PumpSwap opened 3 accounts, 4.37M lamports, vs 2 × 2.1M allowed:
// every such buy was refused). More than JUP_OPENS_MAX accounts is refused.
const JUP_OPENS_MAX = 6;
export function jupInnerRent(inner: unknown, user: string): { rent: bigint; opens: number } {
  let rent = 0n, opens = 0;
  for (const grp of Array.isArray(inner) ? inner : []) for (const x of (grp as any)?.instructions || []) {
    const t = x?.parsed?.type, i = x?.parsed?.info || {};
    if (x?.program === 'system' && (t === 'createAccount' || t === 'createAccountWithSeed') && i.source === user) { opens += 1; try { rent += BigInt(String(i.lamports ?? '0')); } catch { /* the guard refused it already */ } }
  }
  return { rent, opens };
}
// every token account of this wallet holding something (both token programs): what the simulation is checked against
async function walletTokenAccounts(user: string): Promise<{ address: string; state: TokState }[]> {
  const got = await Promise.all([P.token, P.token22].map((programId) => solRpc<any>('getTokenAccountsByOwner', [user, { programId }, { encoding: 'base64', commitment: 'processed' }])));
  const rows: { address: string; state: TokState }[] = [];
  for (const g of got) for (const x of g?.value || []) { const st = tokState({ owner: x.account.owner, data: fromB64(x.account.data[0]) }); if (st && st.amount > 0n) rows.push({ address: x.pubkey, state: st }); }
  if (rows.length > JUP_TOKENS_MAX) throw new Error(`This wallet holds over ${JUP_TOKENS_MAX} tokens — the vault cannot check this route against all of them; use a wallet with fewer`);
  return rows;
}
async function simulateSeeing(tx: Uint8Array, addrs: string[]) {
  const params = [toB64(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', innerInstructions: true, accounts: { encoding: 'base64', addresses: addrs } }];
  const r = await solRpc<any>('simulateTransaction', params).catch(() => rpcAt<any>(PUBLIC_RPC, 'simulateTransaction', params));
  const v = r?.value; if (!v) throw new Error(READ_FAIL);
  if (!v.err && (!Array.isArray(v.accounts) || v.accounts.length !== addrs.length)) throw new Error('The simulation did not show this wallet\'s balances — nothing was sent; try again');
  return v;
}
const simAcc = (x: any) => (x ? { owner: String(x.owner), data: fromB64(x.data?.[0] || ''), lamports: Number(x.lamports || 0) } : null);
async function jupiterTradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  const k = solKeys(a.key!); const user = k.address;
  await solHoldGate(user);
  const click = joinClick();
  const planP = sendPlan(s); const bhP = blockhash(10_000); planP.catch(() => {}); bhP.catch(() => {});
  const coinAta = ataOf(user, r.mint, r.tokenProgram), wsolAta = ataOf(user, P.wsol, P.token);
  // speed: a buy's quote starts with the wallet read, not after it (a sell needs the balance first: its amount is a share of it)
  const buyAmount = side === 'buy' ? BigInt(Math.floor(size * 1e9)) : 0n;
  if (side === 'buy' && buyAmount <= 0n) throw new Error('Enter an amount');
  const bEarly = side === 'buy' ? jupBuild(r, side, buyAmount, s.slippage, user) : null; bEarly?.catch(() => {});
  const priceP = motionPriceSol(r.mint);
  const [uAcc, cAcc, wAcc] = await accounts([user, coinAta, wsolAta]);
  if (uAcc === undefined || cAcc === undefined || wAcc === undefined) throw new Error('Could not read this wallet from the Solana nodes — nothing was sent; try again');
  const coinBefore = tokState(cAcc)?.amount ?? 0n, wsolBefore = tokState(wAcc);
  let amount = buyAmount;
  if (side === 'sell') { if (coinBefore <= 0n) throw new Error('Nothing to sell in this wallet'); amount = (coinBefore * BigInt(Math.round(Math.min(100, Math.max(0, size)) * 100))) / 10000n; if (amount <= 0n) throw new Error('Nothing to sell'); }
  const built0 = await (bEarly ?? jupBuild(r, side, amount, s.slippage, user));
  const minOut = BigInt(built0.quote.otherAmountThreshold);
  const { list, tables: tableKeys } = built0;
  const priceWhy = jupPriceCheck({ side, amount, minOut, decimals: r.decimals, priceSol: await priceP, feeBps: r.fee?.lowBps });
  if (priceWhy) throw new Error('Refused: ' + priceWhy + '. Nothing was sent.');
  const { ixs, opens } = jupIxsChecked(list, user, side, amount);
  const tables = await jupTables(tableKeys);
  // Jupiter's copy of each table must be what the chain holds (a forged map would point the signed indexes at other accounts)
  for (const t of tables) { const claimed = built0.claimed[t.key] || []; if (claimed.length > t.addresses.length || claimed.some((a, i) => a !== t.addresses[i])) throw new Error('Jupiter\'s lookup table does not match the chain — refused'); }
  const plan = await planP;
  const tip = plan.tipLamports > 0n ? [plan.protect ? tipIxGuarded(user, pick(JITO_TIP), plan.tipLamports) : transferIx(user, pick(JITO_TIP), plan.tipLamports)] : [];
  // the F-8 ceiling at this route's compute limit: tip + priority never past ~0.005 SOL
  const microAt = (units: number) => Math.min(plan.micro, Number(((JUP_FEE_CEIL - (plan.tipLamports > JUP_FEE_CEIL ? JUP_FEE_CEIL : plan.tipLamports)) * 1_000_000n) / BigInt(units)));
  const feesAt = (units: number) => plan.tipLamports + (BigInt(microAt(units)) * BigInt(units)) / 1_000_000n + SIG_FEE + 10_000n;
  const rentMax = BigInt(opens) * RENT_ATA22;
  const have = BigInt(uAcc?.lamports || 0), need = (side === 'buy' ? amount + RENT_WALLET + rentMax : 0n) + feesAt(JUP_UNITS_MAX);
  if (have < need) throw new Error(have === 0n ? 'This wallet has no SOL yet — fund it first' : `Not enough SOL: ${solTxt(have)} available, about ${solTxt(need)} needed (amount + fees + account rent)`);
  // A sell proves its real account-rent funding in the existing simulation, with the maximum priority charge already paid.
  // Every move is checked from inner instructions; the slow token-account list is read only when the node omits them.
  // Idempotent ATA instructions for existing accounts consume no rent. Do not reserve their nominal rent twice.
  const trialMicro = side === 'sell' ? microAt(JUP_UNITS_MAX) : 0;
  const trialPriority = (BigInt(trialMicro) * BigInt(JUP_UNITS_MAX) + 999_999n) / 1_000_000n;
  const trial = unsignedTx(compileV0(user, [...budget(JUP_UNITS_MAX, trialMicro), ...ixs, ...tip], P.system, tables));
  let sim = await simulateSeeing(trial, [user, coinAta, wsolAta]);
  if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
  let others: { address: string; state: TokState }[] = [];
  let post = (sim.accounts as any[]).map(simAcc);
  const through = new Set<string>();
  const innerWhy = Array.isArray(sim.innerInstructions) ? jupInnerGuard({ inner: sim.innerInstructions, user, side, amount, wsolAta, coinAta, rentMax: RENT_ATA22, through }) : 'no inner instructions';
  if (innerWhy && innerWhy !== 'no inner instructions') throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + innerWhy + '. Nothing was sent.');
  let rentSeen = rentMax;
  if (!innerWhy) {
    const opened = jupInnerRent(sim.innerInstructions, user);
    if (opened.opens > JUP_OPENS_MAX) throw new Error('Refused: Jupiter\'s transaction opens more accounts than a swap needs. Nothing was sent.');
    if (opened.rent > rentSeen) rentSeen = opened.rent;
  }
  if (!innerWhy && through.size) {
    // the route passes through token accounts this wallet already held: each is read now and again in the simulation, and the
    // balance check below refuses any that ends lower, closed, handed over or delegated (net zero is all a route may do there)
    const via = [...through].filter((t) => t !== coinAta && t !== wsolAta);
    if (via.length > 8) throw new Error('Refused: the Jupiter transaction passes through more token accounts of this wallet than a swap needs. Nothing was sent.');
    const pre = await accounts(via);
    if (pre.some((x) => x === undefined)) throw new Error('Could not read this wallet from the Solana nodes — nothing was sent; try again');
    const states = pre.map((x) => tokState(x));
    const bad = via.find((_, i) => !states[i] || states[i]!.owner !== user);
    if (bad) throw new Error(`Refused: Jupiter's transaction does not do what you asked — it moves tokens out of ${bad.slice(0, 6)}…. Nothing was sent.`);
    others = via.map((address, i) => ({ address, state: states[i]! }));
    sim = await simulateSeeing(trial, [user, coinAta, wsolAta, ...via]);
    if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
    post = (sim.accounts as any[]).map(simAcc);
  }
  if (innerWhy === 'no inner instructions') {
    others = (await walletTokenAccounts(user)).filter((t) => t.address !== coinAta && t.address !== wsolAta);
    sim = await simulateSeeing(trial, [user, coinAta, wsolAta, ...others.map((t) => t.address)]);
    if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
    post = (sim.accounts as any[]).map(simAcc);
  }
  // the compute it really used (+25 %), and the priority price at THAT limit (it was clamped at a 700k ceiling before)
  const units = Math.min(JUP_UNITS_MAX, Math.ceil(Number(sim.unitsConsumed || JUP_UNITS_MAX) * 1.25) + 5_000);
  // Solana rounds the priority charge up; normalize the simulated sell to the smaller signed limit exactly once.
  const finalPriority = (BigInt(microAt(units)) * BigInt(units) + (side === 'sell' ? 999_999n : 0n)) / 1_000_000n;
  const why = jupBalanceGuard({
    side, amount, minOut, feesMax: feesAt(units), rentMax: rentSeen, user,
    solBefore: have, solAfter: BigInt(post[0]?.lamports ?? 0) + trialPriority - finalPriority, coinBefore, coinAfter: post[1] ? tokState(post[1])?.amount ?? null : (side === 'sell' ? 0n : null),
    wsolBefore, wsolAfter: tokState(post[2]),
    others: others.map((t, i) => ({ address: t.address, before: t.state, after: tokState(post[3 + i]) })),
    wsolLamportsBefore: BigInt(wAcc?.lamports || 0), wsolLamportsAfter: BigInt(post[2]?.lamports || 0),
  });
  if (why) throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + why + '. Nothing was sent.');
  let bhi = await bhP; if (Date.now() - bhi.at > 20_000) bhi = await blockhash(0);
  let bh = bhi.v, lvh = bhi.lvh;
  const build = (b: string) => signMessage(compileV0(user, [...budget(units, microAt(units)), ...ixs, ...tip], b, tables), k.seed);
  let built = build(bh);
  for (let i = 0; i < 3 && sentSigs.has(b58e(built.sig)); i++) { const nb = await newerBlockhash(bh); bh = nb.v; lvh = nb.lvh; built = build(bh); }
  const { tx, sig } = built;
  if (tx.length > 1232) throw new Error('Jupiter\'s route does not fit one transaction — nothing was sent; try a different amount');
  const hash = b58e(sig);
  const now = Date.now(); for (const [x, at] of sentSigs) if (now - at > 120_000) sentSigs.delete(x);
  sentSigs.set(hash, now);
  // F-1/F-55 V12: the same single send path as every other outflow
  try { await sendSigned(tx, hash, lvh, user, { mode: plan.mode, click, venue: 'jupiter', protect: plan.protect }); }
  catch (e) { if (!(e instanceof SolSendUnknown)) sentSigs.delete(hash); throw e; }
  return { hash };
}
// the preview of a Jupiter route: Jupiter's own quote (the trade itself re-quotes, checks and simulates per wallet)
async function jupiterPreviewOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings) {
  const user = a.key && !a.ext ? solKeys(a.key).address : '';
  const out: any = { name: a.name, address: user, side, venue: r.quote ? 'Jupiter (pump.fun quoted in ' + r.quote.slice(0, 4) + '…)' : r.fee && r.fee.bps > 0 ? 'Jupiter (best route) · ' + transferFeeText(r.fee) : 'Jupiter (best route)', contract: JUP_PROGRAM, method: 'route', amountIn: size, amountInLabel: side === 'buy' ? size + ' SOL' : size + '%', notes: [] as string[] };
  try {
    if (!user) throw new Error('This wallet has no Solana key here');
    const bal = await solRpc<any>('getBalance', [user, { commitment: 'processed' }]); out.balanceEth = (bal?.value || 0) / 1e9;
    let amount = BigInt(Math.floor(size * 1e9));
    if (side === 'sell') { const tb = await solRpc<any>('getTokenAccountBalance', [ataOf(user, r.mint, r.tokenProgram)]).catch(() => null); amount = (BigInt(tb?.value?.amount || '0') * BigInt(Math.round(size * 100))) / 10000n; }
    if (amount <= 0n) throw new Error(side === 'buy' ? 'Enter an amount' : 'Nothing to sell in this wallet');
    const q = await jupQuote(r, side, amount, s.slippage);
    const dec = side === 'buy' ? r.decimals : 9;
    out.expected = Number(q.outAmount) / 10 ** dec; out.min = Number(q.otherAmountThreshold) / 10 ** dec;
    out.notes.push('route: ' + (q.routePlan || []).map((h) => h.swapInfo?.label || '?').join(' → '));
    // (token2022-fee) the coin's own transfer fee, on the ticket: Jupiter's figures above are already after it
    if (r.fee) {
      out.transferFeeBps = r.fee.bps; out.transferFee = transferFeeText(r.fee);
      if (r.fee.bps > 0) out.notes.push(`${out.transferFee} (Token-2022): every transfer of this coin pays it — ${side === 'buy' ? 'what reaches this wallet' : 'what reaches the pool'} is the amount less the fee; the figures above already count it`);
      if (r.fee.lowBps !== r.fee.bps) out.notes.push(`the fee moves to ${feePct(r.fee.nextBps)} at epoch ${r.fee.nextEpoch}`);
      if (r.fee.changeable) out.notes.push('the coin\'s fee authority can set a new fee (it takes effect two epochs later)');
      if (r.fee.freezable) out.notes.push('the coin\'s freeze authority is set: its issuer can freeze token accounts');
    }
    out.notes.push('signed only after the vault\'s own simulation shows exactly this trade');
    out.simulated = 'at signing'; out.funded = side === 'sell' || out.balanceEth >= size;
  } catch (e) { out.error = (e as Error).message; }
  return out;
}
// (pumphop) the same coin as a Jupiter route (SOL → its quote token → the coin), the quote token named for the words
const hopAsJupiter = (r: SolRoute): SolRoute => ({ ...r, venue: 'jupiter', pool: '', hop: undefined, quote: r.quote || r.hop?.quote || '' });
// the trader's own limits: the words stand and nothing else is tried. Anything else a multi_hop_swap simulation refuses (the route's
// codes 6084–6086 / 6108, an account the program did not accept, a code the vault has no words for) goes to Jupiter.
const HOP_FINAL = new Set([SLIP, CODE_TEXT.BuyZeroAmount, CODE_TEXT.SellZeroAmount, CODE_TEXT.ZeroQuoteAmount, CODE_TEXT.NotEnoughTokensToSell, CODE_TEXT.BondingCurveComplete, CODE_TEXT.BuyNotEnoughSolToCoverRent,
  'This wallet has no SOL yet — fund it first', 'Not enough SOL left for account rent — keep about 0.003 SOL in the wallet', 'Not enough SOL in this wallet', 'Not enough tokens in this wallet']);
export const hopFallback = (sim: any, side: 'buy' | 'sell') => !HOP_FINAL.has(errText(sim, side, 'pumphop'));
export async function solTradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  try { return await tradeOne(a, side, r, size, s); }
  catch (e) { if (e instanceof SolSendUnknown || !(e instanceof RpcError || /timeout|abort|failed to fetch|networkerror/i.test(String((e as Error)?.name) + ' ' + String((e as Error)?.message)))) throw e; throw new Error(nodeText(e)); }
}
async function tradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  if (!a.key || a.ext) throw new Error('This wallet signs through Privy, which has no Solana key here');
  if (r.isCashback) throw new Error('Cashback coins are not supported yet');
  if (r.venue === 'jupiter') return jupiterTradeOne(a, side, r, size, s);
  const k = solKeys(a.key); const user = k.address;
  // F-55 V12: refuse up front while a prior send from this wallet is unknown (also re-checked in sendSigned)
  await solHoldGate(user);
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
    // (2026-10-30) every DLMM candidate is too thin for this trade (a pool with liquidity on one side only, or less than the
    // amount): Jupiter routes it over every venue, under its own checks — nothing was signed yet. Only after that failure,
    // so a click a DLMM pool fills is unchanged.
    if (r.venue === 'dlmm' && (e as Error).message === DLMM_DRY) return jupiterTradeOne(a, side, { ...r, venue: 'jupiter', pool: '', dlmm: undefined, dlmmAlts: undefined, dlmmMore: undefined, quote: '' }, size, s);
    // (pumphop) the route through the quote token no longer holds on chain: Jupiter, under its own checks — nothing was signed yet
    if (r.venue === 'pumphop' && (e as Error).message === HOP_STALE) { routeCache.delete(r.mint); return jupiterTradeOne(a, side, hopAsJupiter(r), size, s); }
    // the curve completed since the route was read: the click re-routes once (one shared read for every wallet)
    // to the PumpSwap pool and quotes there — nothing was signed yet
    if ((e as Error).message !== CURVE_DONE) throw e;
    routeCache.delete(r.mint); r = await solRoute(r.mint);
    // (pumphop) a coin whose curve completed into a pool quoted in another token: Jupiter's route (solTradeIxs builds none for it)
    if (r.venue === 'jupiter') return jupiterTradeOne(a, side, r, size, s);
    ({ m, extra } = await read(r)); mine();
    if (side === 'sell') amount = sellAmount(extra[1]);
    ixs = (await solTradeIxs(user, r, side, amount, s.slippage, m)).ixs;
  }
  const plan = await planP;
  const tip = plan.tipLamports > 0n ? [plan.protect ? tipIxGuarded(user, pick(JITO_TIP), plan.tipLamports) : transferIx(user, pick(JITO_TIP), plan.tipLamports)] : [];
  // the most this transaction can be signed with: Fast simulates at 400k and signs ≤ 400k, Turbo signs 300k — 400k on
  // DLMM, where a sell that walks many bins measured 337k (pump / PumpSwap never pass 100k)
  const maxUnits = s.turbo ? (r.venue === 'dlmm' ? 400_000 : 300_000) : 400_000;
  {
    // what the wallet must hold besides a buy's amount: tip, priority and signature fee, the temporary wrapped-SOL
    // account on PumpSwap (refunded in the same transaction, but held during it), the token account and the volume
    // accumulator when they do not exist yet; a buy also keeps the wallet itself rent-exempt
    const have = BigInt(extra[0]?.lamports || 0);
    const rent = (side === 'buy' && !extra[1] ? (r.tokenProgram === P.token22 ? RENT_ATA22 : RENT_ATA) : 0n) + (r.venue === 'pumpswap' || r.venue === 'pumphop' ? RENT_ATA : 0n) + (r.venue === 'dlmm' ? (extra[2] ? 0n : RENT_ATA) : extra[2] ? 0n : RENT_UVA);
    const fees = plan.tipLamports + (BigInt(plan.micro) * BigInt(maxUnits)) / 1_000_000n + SIG_FEE;
    const need = (side === 'buy' ? amount + RENT_WALLET : 0n) + fees + rent;
    if (have < need) throw new Error(have === 0n ? 'This wallet has no SOL yet — fund it first' : side === 'buy' ? `Not enough SOL: ${solTxt(have)} available, about ${solTxt(need)} needed (amount + fees${rent ? ' + account rent' : ''})` : `Not enough SOL for the sell's fees: ${solTxt(have)} available, about ${solTxt(need)} needed`);
  }
  let units = s.turbo ? maxUnits : 200_000;
  // (pumphop) always simulated, Turbo too: a new instruction is never signed unseen
  if (!s.turbo || r.venue === 'pumphop') {
    // simulate with a generous limit, then sign with what it really used (+25%): a smaller limit lands sooner at the same price
    const sim = await simulate(unsignedTx(compileLegacy(user, [...budget(400_000, plan.micro), ...ixs, ...tip], P.system)));
    if (sim.err) {
      // (pumphop) a refusal that is not the trader's own limit (slippage, SOL, tokens, size): the Jupiter route instead — nothing was signed
      if (r.venue === 'pumphop' && hopFallback(sim, side)) return jupiterTradeOne(a, side, hopAsJupiter(r), size, s);
      throw new Error(errText(sim, side, r.venue));
    }
    if (sim.unitsConsumed) units = Math.min(400_000, Math.ceil(sim.unitsConsumed * 1.25) + 5_000);
  }
  // F-1 V12: a blockhash read before the click (hover warm, ≤10 s cache) may be stale by the time this wallet signs;
  // refetch if it is older than 20 s so lvh — the height the hold releases at — is close to when the bytes go out.
  let bhi = await bhP;
  if (Date.now() - bhi.at > 20_000) bhi = await blockhash(0);
  let bh = bhi.v, lvh = bhi.lvh;
  let built = signMessage(compileLegacy(user, [...budget(units, plan.micro), ...ixs, ...tip], bh), k.seed);
  // identical bytes carry the identical signature and land once: the same trade repeated within the
  // blockhash's reuse window is signed over a newer blockhash, so a second click is a second trade
  for (let i = 0; i < 3 && sentSigs.has(b58e(built.sig)); i++) { const nb = await newerBlockhash(bh); bh = nb.v; lvh = nb.lvh; built = signMessage(compileLegacy(user, [...budget(units, plan.micro), ...ixs, ...tip], bh), k.seed); }
  const { tx, sig } = built;
  if (tx.length > 1232) throw new Error('Transaction too large');
  const hash = b58e(sig);
  const now = Date.now(); for (const [x, at] of sentSigs) if (now - at > 120_000) sentSigs.delete(x);
  sentSigs.set(hash, now);
  // F-1/F-55 V12: one send path for every outflow — holds the wallet and throws SolSendUnknown on a silent send
  try { await sendSigned(tx, hash, lvh, user, { mode: plan.mode, click, venue: r.venue, protect: plan.protect }); }
  catch (e) { if (!(e instanceof SolSendUnknown)) sentSigs.delete(hash); throw e; }
  return { hash };
}
export async function solPreviewOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings) {
  if (r.venue === 'jupiter') return jupiterPreviewOne(a, side, r, size, s);
  const user = a.key && !a.ext ? solKeys(a.key).address : '';
  const hopSym = r.quoteSymbol || (r.quote ? r.quote.slice(0, 4) + '…' : 'its quote token');
  const out: any = { name: a.name, address: user, side, venue: r.venue === 'pumphop' ? `pump.fun curve via ${hopSym} (${r.hop?.via === 'pool' ? 'PumpSwap pool' : 'curve'})` : r.venue === 'pump' ? 'pump.fun curve' : r.venue === 'dlmm' ? 'Meteora DLMM' : 'PumpSwap', contract: r.venue === 'pump' ? P.pump : r.venue === 'dlmm' ? P.dlmm : P.pamm, method: r.venue === 'pumphop' ? 'multi_hop_swap' : r.venue === 'pump' ? (side === 'buy' ? 'buy_exact_quote_in_v3' : 'sell_v3') : r.venue === 'dlmm' ? 'swap2' : (side === 'buy' ? 'buy_exact_quote_in_v2' : 'sell_v2'), amountIn: size, amountInLabel: side === 'buy' ? size + ' SOL' : size + '%', notes: [] as string[] };
  try {
    if (!user) throw new Error('This wallet has no Solana key here');
    const bal = await solRpc<any>('getBalance', [user, { commitment: 'processed' }]); out.balanceEth = (bal?.value || 0) / 1e9;
    let amount = BigInt(Math.floor(size * 1e9));
    if (side === 'sell') { const tb = await solRpc<any>('getTokenAccountBalance', [ataOf(user, r.mint, r.tokenProgram)]).catch(() => null); amount = (BigInt(tb?.value?.amount || '0') * BigInt(Math.round(size * 100))) / 10000n; }
    const q = r.venue === 'pumphop' ? await quotePumphop(r, side, amount) : r.venue === 'pump' ? await quotePump(r.mint, side, amount) : r.venue === 'dlmm' ? await quoteDlmm(r, side, amount) : await quoteAmm(r, side, amount);
    if (r.venue === 'pumphop') out.notes.push(`one transaction: ${side === 'buy' ? `SOL → ${hopSym} → the coin` : `the coin → ${hopSym} → SOL`}, simulated before it is signed`);
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
  const bh = await blockhash();
  const { tx, sig } = signMessage(compileLegacy(k.address, [...budget(SOL_SEND_CU, SOL_SEND_PRICE), transferIx(k.address, to, lamports)], bh.v), k.seed);
  // F-1 V12: held-wallet gate + silent-send → SolSendUnknown (a lost response must never make a transfer re-send)
  await sendSigned(tx, b58e(sig), bh.lvh, k.address);
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
  const bh = await blockhash();
  const { tx, sig } = signMessage(compileLegacy(k.address, tokenTransferIxs(k.address, mint, to, units, dec, prog), bh.v), k.seed);
  // F-1 V12: held-wallet gate + silent-send → SolSendUnknown
  await sendSigned(tx, b58e(sig), bh.lvh, k.address);
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
  const bh = await blockhash();
  const { tx, sig } = signMessage(compileLegacy(me, wsolUnwrapIxs(me), bh.v), solKeys(a.key).seed);
  // F-1 V12: held-wallet gate + silent-send → SolSendUnknown
  await sendSigned(tx, b58e(sig), bh.lvh, me);
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
  const bh = await blockhash();
  const msg = compileV0(k.address, [...budget(300_000, plan.micro), ...ixs], bh.v, tables);
  const { tx, sig } = signMessage(msg, k.seed);
  // F-1 V12: held-wallet gate + silent-send → SolSendUnknown (a bridge deposit must never go out twice)
  await sendSigned(tx, b58e(sig), bh.lvh, k.address);
  return b58e(sig);
}

// ── limit orders (2026-10-25; src/solLimitEngine.ts, trench docs/drafts/LIMIT-ORDERS.md §14) ──
// The venue instructions with the floor the order names (not a fresh quote): the curve, or the canonical PumpSwap pool the
// curve lists into. That pool's vaults are its own associated accounts (checked on mainnet for Token and Token-2022), so
// the PumpSwap variant can be signed before the migration and becomes valid the moment the pool opens.
export function solVenueIxs(user: string, r: SolRoute, venue: 'pump' | 'pumpswap', side: 'buy' | 'sell', amount: bigint, minOut: bigint): Ix[] {
  if (venue === 'pump') return pumpIxs(user, { ...r, venue: 'pump' }, side, amount, minOut);
  const pool = canonicalPool(r.mint);
  return ammIxs(user, { ...r, venue: 'pumpswap', pool }, side, amount, minOut, { baseVault: ataOf(pool, r.mint, r.tokenProgram), quoteVault: ataOf(pool, P.wsol, P.token) });
}
// a simulation that returns the named accounts as they would be after it (the limit's "pays the main wallet" check)
export async function solSimulateAccounts(tx: Uint8Array, addrs: string[]): Promise<{ err: unknown; logs: string[]; accounts: ({ lamports: number; data: Uint8Array } | null)[] }> {
  const r = await solRpc<any>('simulateTransaction', [toB64(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: addrs } }]);
  const v = r?.value || {};
  return { err: v.err ?? null, logs: Array.isArray(v.logs) ? v.logs : [], accounts: (Array.isArray(v.accounts) ? v.accounts : []).map((a: any) => (a ? { lamports: Number(a.lamports), data: fromB64(a.data?.[0] || '') } : null)) };
}
// one outflow of a limit order's own wallets (funding from the main wallet, the order wallet's setup and its way back):
// the engine's single send path, held by sender on an unknown status like every other Solana outflow (F-1/F-55)
export async function solLimitSend(tx: Uint8Array, holdKey: string, lvh: number): Promise<string> {
  const hash = b58e(tx.subarray(1, 65));
  return sendSigned(tx, hash, lvh, holdKey, { mode: 'fast', venue: 'limit' });
}
export const solErrText = (sim: any, side: 'buy' | 'sell', venue: string) => errText(sim, side, venue);
export type SolIxT = Ix;

// ── USD balance (src/floatEngine.ts; 2026-10-25, owner-only, NOT released): the reserve's same-chain swap on ONE pinned
// Meteora DLMM SOL/USDC pool ── Appended beside the trade code: no trade function calls anything below.
// No aggregator, no third-party bytes: the vault's own swap2 instruction (dlmmIxs) and a System / SPL transfer that pays
// the OTHER wallet of the same key its floor in the same transaction, so the payout can never exceed what the swap returned.
// The float's reads are its own requests (accounts(), never readBatch: a float read can never ride in a click's same-tick
// batch, nor fill or read the 1.5 s market memo) and its blockhash is its own read (never the trade's cached one).
async function floatLbPair(pool: string): Promise<LbPair> {
  const [a] = await accounts([pool]);
  if (a === undefined) throw new Error(READ_FAIL);
  if (!a || a.owner !== P.dlmm || a.data.length < 904 || !hasDisc(a.data, LB_PAIR_DISC)) throw new Error('Pool not found');
  const lb = decodeLbPair(a.data); if (lb.status !== 0) throw new Error('Pool disabled');
  return lb;
}
export async function solFloatRoute(pool: string, mint: string): Promise<SolRoute> {
  const lb = await floatLbPair(pool).catch(() => null);
  const solIsX = !!lb && lb.tokenX === P.wsol && lb.tokenY === mint, solIsY = !!lb && lb.tokenY === P.wsol && lb.tokenX === mint;
  const closed = !!lb && (lb.pairType === 1 || lb.pairType === 2) && lb.activationType === 1 && Number(lb.activationPoint) > Date.now() / 1000;
  if (!lb || (!solIsX && !solIsY) || closed || lb.oracle !== dlmmOracleOf(pool)) throw new Error('The pinned SOL/USDC pool is not usable right now');
  return { mint, venue: 'dlmm', tokenProgram: P.token, decimals: 6, symbol: 'USDC', pool, isCashback: false, isMayhem: false,
    dlmm: { solIsX, reserveX: lb.reserveX, reserveY: lb.reserveY, oracle: lb.oracle, activeIdx: binArrayIndex(lb.activeId), binStep: lb.binStep } };
}
// the native price from a pool's active bin, in micro-dollars per SOL (an independent pool from the one swapped through)
export async function solFloatPrice6(pool: string, usdcMint: string): Promise<bigint> {
  const lb = await floatLbPair(pool).catch((e) => { throw new Error('Oracle pool: ' + String((e as Error)?.message || e)); });
  const p = dlmmPrice(lb.activeId, lb.binStep); if (p === null || p <= 0n) throw new Error('Oracle price overflow');
  if (lb.tokenX === P.wsol && lb.tokenY === usdcMint) return (p * 1_000_000_000n) >> 64n;          // USDC raw per lamport × 1e9
  if (lb.tokenY === P.wsol && lb.tokenX === usdcMint) return (1_000_000_000n << 64n) / p;          // its inverse
  throw new Error('Oracle pool is not SOL/USDC');
}
// the pool and the five bin arrays around its active bin in one request of the float's own (quoteDlmm reads further ones
// only if the walk gets there — not at the float's sizes)
async function floatMarket(r: SolRoute): Promise<Market> {
  const d = r.dlmm; if (!d) throw new Error('No DLMM pool on this route');
  const addrs = [r.pool, ...[-2, -1, 0, 1, 2].map((k) => binArrayOf(r.pool, d.activeIdx + k))];
  const got = await accounts(addrs);
  if (got[0] === undefined) throw new Error(READ_FAIL);
  const m: Market = new Map(); addrs.forEach((x, i) => { if (got[i] !== undefined) m.set(x, got[i] as Acc); });
  return m;
}
export async function solFloatQuote(r: SolRoute, side: 'buy' | 'sell', amountIn: bigint): Promise<bigint> { return (await quoteDlmm(r, side, amountIn, await floatMarket(r))).out; }
export async function solFloatSwapIxs(user: string, r: SolRoute, side: 'buy' | 'sell', amount: bigint, minOut: bigint): Promise<Ix[]> {
  if (minOut <= 0n) throw new Error('A float swap needs a floor');
  const q = await quoteDlmm(r, side, amount, await floatMarket(r));
  return dlmmIxs(user, r, side, amount, minOut, q.binArrays);
}
export const solFloatPayIx = (from: string, to: string, lamports: bigint): Ix => transferIx(from, to, lamports);
// USDC from `owner` to `to`'s token account (created if missing, idempotent), transferChecked — no compute budget of its own
export const solFloatTokenPayIxs = (owner: string, mint: string, to: string, units: bigint, decimals: number): Ix[] => {
  const src = ataOf(owner, mint, P.token), dst = ataOf(to, mint, P.token);
  return [ataCreate(owner, to, mint, P.token), ix(P.token, [[src, false, true], [mint, false, false], [dst, false, true], [owner, true, false]], cat(Uint8Array.of(12), u64(units), Uint8Array.of(decimals)))];
};
// sign and send instructions from one of the vault's keys, through the same held-wallet send path as every outflow
export async function solFloatSend(a: SolAcct, ixs: Ix[], units = 300_000, micro = 50_000): Promise<string> {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  const k = solKeys(a.key);
  const all = [...budget(units, micro), ...ixs];
  const sim = await simulate(unsignedTx(compileLegacy(k.address, all, P.system)));
  if (sim.err) throw new Error('Simulation failed: ' + JSON.stringify(sim.err).slice(0, 120));
  const bh = await solBlockhashInfo();
  const { tx, sig } = signMessage(compileLegacy(k.address, all, bh.blockhash), k.seed);
  if (tx.length > 1232) throw new Error('Transaction too large');
  await sendSigned(tx, b58e(sig), bh.lvh, k.address);
  return b58e(sig);
}

// ── USD balance: the buy straight from the reserve (src/floatDirect.ts; owner 2026-10-29 «давай делай это все»; NOT released,
// waits for the owner's yes: B:\tmp\float-direct\APPROVAL-REQUEST.md) ── Appended: no trade function above calls anything below.
// R (the wallet's own reserve) signs ONE transaction: a Jupiter route USDC → coin whose output lands in W's coin account
// (destinationTokenAccount), W's account created first (idempotent, R pays its rent), R's own coin account that the route
// opens on its way closed back to R at the end. Checked like every Jupiter buy, from R's side: the instruction list
// (directIxsChecked), motion's market price, the lookup tables against the chain, and R's own simulation — every move of R's
// funds inside it (directInnerGuard) and the balances after it (directBalanceGuard: R's USDC down ≤ the amount, W's coin up ≥
// Jupiter's minimum, R's SOL down ≤ fees + rent, nothing else of R's lower). Sent through the same held-wallet path.
const DIRECT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Jupiter Swap V2 /build with destinationTokenAccount; on a 429 Swap V1 (quote + swap-instructions, the same parameter) —
// motion's keyed /sol/api/jup/build proxy takes only the six parameters of a wallet's own swap, so it is not asked here.
// maxAccounts: the route is asked to leave room for the reserve's own instructions (W's coin account, the close, the tip):
// Jupiter sizes a route for ITS transaction, and with them a 64-account route did not fit (1 648 bytes, 2026-10-29)
const DIRECT_MAX_ACCOUNTS = [40, 28];
async function jupBuildDirect(mint: string, amount: bigint, slippage: number, taker: string, dest: string, maxAccounts = DIRECT_MAX_ACCOUNTS[0]): Promise<JupBuilt> {
  const bps = Math.max(1, Math.min(5000, Math.round(slippage * 100)));
  const want = { usdc: DIRECT_USDC, mint, amount, bps };
  const get = (url: string, init?: RequestInit) => fetch(url, { ...(init || {}), signal: AbortSignal.timeout(8000) }).then(async (x) => ({ status: x.status, j: await x.json().catch(() => null) }));
  const res = await get(`${JUP_V2}/build?inputMint=${DIRECT_USDC}&outputMint=${mint}&amount=${amount}&taker=${taker}&slippageBps=${bps}&destinationTokenAccount=${dest}&maxAccounts=${maxAccounts}`).catch(() => ({ status: 0, j: null as any }));
  let j: any = res.j, tables: string[] = [];
  const claimed: Record<string, string[]> = {};
  if (res.status === 429 || res.status === 0 || !j?.swapInstruction) {
    const q = await get(`${JUP_API}/quote?inputMint=${DIRECT_USDC}&outputMint=${mint}&amount=${amount}&slippageBps=${bps}&swapMode=ExactIn&restrictIntermediateTokens=true&maxAccounts=${maxAccounts}`).catch(() => ({ status: 0, j: null as any }));
    if (!q.j || typeof q.j.outAmount !== 'string') throw new Error(res.status === 429 || q.status === 429 ? 'Jupiter is busy right now — nothing was sent; try again in a second' : 'Jupiter found no route for this coin right now — nothing was sent; try again');
    directQuoteCheck(q.j, want);
    const si = await get(`${JUP_API}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q.j, userPublicKey: taker, destinationTokenAccount: dest, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }) }).catch(() => ({ status: 0, j: null as any }));
    if (!si.j || si.j.error || !si.j.swapInstruction) throw new Error('Jupiter did not build the swap — nothing was sent; try again');
    j = { ...q.j, setupInstructions: si.j.setupInstructions, swapInstruction: si.j.swapInstruction, cleanupInstruction: si.j.cleanupInstruction, otherInstructions: si.j.otherInstructions, tokenLedgerInstruction: si.j.tokenLedgerInstruction };
    tables = Array.isArray(si.j.addressLookupTableAddresses) ? si.j.addressLookupTableAddresses.filter((x: unknown) => typeof x === 'string' && SOL_ADDR.test(x)).slice(0, 4) : [];
  } else {
    const map = j.addressesByLookupTableAddress && typeof j.addressesByLookupTableAddress === 'object' ? j.addressesByLookupTableAddress as Record<string, unknown> : {};
    tables = Object.keys(map).filter((k) => SOL_ADDR.test(k)).slice(0, 4);
    for (const k of tables) claimed[k] = Array.isArray(map[k]) ? (map[k] as unknown[]).map(String) : [];
  }
  directQuoteCheck(j, want);
  if ((Array.isArray(j.otherInstructions) && j.otherInstructions.length) || j.tipInstruction || j.tokenLedgerInstruction) throw new Error(JUP_REFUSE);
  const list: JupIx[] = [...(Array.isArray(j.setupInstructions) ? j.setupInstructions : []), j.swapInstruction, ...(j.cleanupInstruction ? [j.cleanupInstruction] : [])];
  const quote: JupQuote = { inputMint: j.inputMint, outputMint: j.outputMint, inAmount: j.inAmount, outAmount: j.outAmount, otherAmountThreshold: j.otherAmountThreshold, swapMode: j.swapMode, slippageBps: Number(j.slippageBps), routePlan: j.routePlan };
  return { quote, list, tables, claimed };
}
// motion's own market price in USD per whole coin (the same /quotes row motionPriceSol reads); null = none fresh
async function motionPriceUsd(mint: string): Promise<number | null> {
  try {
    const q = await fetch(API('/quotes?addrs=' + encodeURIComponent(mint)), { signal: AbortSignal.timeout(3000) }).then((x) => x.json());
    const row = q?.quotes?.[mint]; const usd = Number(row?.price), age = Number(row?.priceAgeMs ?? 0);
    return usd > 0 && age < 120_000 ? usd : null;
  } catch { return null; }
}
export class SolDirectNoGas extends Error { name = 'SolDirectNoGas'; }
export type SolDirectBuilt = { tx: Uint8Array; hash: string; lvh: number; mode: string; protect?: boolean; minOut: bigint; outQuote: bigint; route: string; timing: Record<string, number> };
type DirectPlan = { message: (blockhash: string) => Uint8Array; bh: BlockhashInfo; mode: string; protect?: boolean; minOut: bigint; outQuote: bigint; route: string; timing: Record<string, number>; mark: (k: string) => void };
/** Build, check, simulate and sign R's buy — never sent here (solDirectBuy sends). */
export async function solDirectBuild(rAcct: SolAcct, w: string, r: SolRoute, usdcIn: bigint, s: SolSettings): Promise<SolDirectBuilt> {
  if (!rAcct.key || rAcct.ext) throw new Error('No Solana key for this reserve');
  const k = solKeys(rAcct.key);
  const p = await directPlan(k.address, w, r, usdcIn, s);
  let bh = p.bh.v, lvh = p.bh.lvh;
  const sign = (b: string) => signMessage(p.message(b), k.seed);
  let signed = sign(bh);
  for (let i = 0; i < 3 && sentSigs.has(b58e(signed.sig)); i++) { const nb = await newerBlockhash(bh); bh = nb.v; lvh = nb.lvh; signed = sign(bh); }
  if (signed.tx.length > 1232) throw new Error('Jupiter\'s route does not fit one transaction — nothing was sent; try a different amount');
  p.mark('signed');
  return { tx: signed.tx, hash: b58e(signed.sig), lvh, mode: p.mode, protect: p.protect, minOut: p.minOut, outQuote: p.outQuote, route: p.route, timing: p.timing };
}
/** Every step of R's buy up to its signature, for an address only (no key, nothing signed or sent): measurements and tests. */
export async function solDirectDryRun(R: string, w: string, r: SolRoute, usdcIn: bigint, s: SolSettings): Promise<{ bytes: number; minOut: bigint; outQuote: bigint; route: string; timing: Record<string, number> }> {
  const p = await directPlan(R, w, r, usdcIn, s);
  const bytes = unsignedTx(p.message(p.bh.v)).length; p.mark('compiled');
  return { bytes, minOut: p.minOut, outQuote: p.outQuote, route: p.route, timing: p.timing };
}
// a route that does not fit one transaction with the reserve's own instructions is asked again once, for fewer accounts
class DirectTooLarge extends Error {}
async function directPlan(R: string, w: string, r: SolRoute, usdcIn: bigint, s: SolSettings): Promise<DirectPlan> {
  try { return await directPlanAt(R, w, r, usdcIn, s, DIRECT_MAX_ACCOUNTS[0]); }
  catch (e) { if (!(e instanceof DirectTooLarge)) throw e; return directPlanAt(R, w, r, usdcIn, s, DIRECT_MAX_ACCOUNTS[1]); }
}
async function directPlanAt(R: string, w: string, r: SolRoute, usdcIn: bigint, s: SolSettings, maxAccounts: number): Promise<DirectPlan> {
  if (!SOL_ADDR.test(w) || !SOL_ADDR.test(R)) throw new Error('Bad trading wallet');
  if (r.isCashback) throw new Error('Cashback coins are not supported yet');
  if (usdcIn <= 0n) throw new Error('Enter an amount');
  const t0 = performance.now(); const timing: Record<string, number> = {}; const mark = (k: string) => { timing[k] = Math.round(performance.now() - t0); };
  if (R === w) throw new Error('The reserve cannot buy for itself');
  const usdcAta = ataOf(R, DIRECT_USDC, P.token), rWsolAta = ataOf(R, P.wsol, P.token);
  const wCoinAta = ataOf(w, r.mint, r.tokenProgram), rCoinAta = ataOf(R, r.mint, r.tokenProgram);
  const planP = sendPlan(s); const bhP = blockhash(10_000); planP.catch(() => {}); bhP.catch(() => {});
  const bP = jupBuildDirect(r.mint, usdcIn, s.slippage, R, wCoinAta, maxAccounts); bP.catch(() => {});
  const priceP = motionPriceUsd(r.mint);
  const [rAcc, uAcc, cAcc, rcAcc] = await accounts([R, usdcAta, wCoinAta, rCoinAta]);
  mark('read');
  if (rAcc === undefined || uAcc === undefined || cAcc === undefined || rcAcc === undefined) throw new Error(READ_FAIL);
  const usdcBefore = tokState(uAcc)?.amount ?? 0n;
  if (usdcBefore < usdcIn) throw new Error(`The reserve holds ${(Number(usdcBefore) / 1e6).toFixed(2)} USDC — less than this buy`);
  const coinState = tokState(cAcc);
  if (cAcc && (!coinState || coinState.owner !== w || coinState.mint !== r.mint)) throw new Error('The trading wallet\'s coin account is not what it should be — refused');
  const coinBefore = coinState?.amount ?? 0n;
  const built = await bP; mark('jupiter');
  const minOut = BigInt(built.quote.otherAmountThreshold);
  const priceWhy = directPriceCheck({ usdcIn, minOut, decimals: r.decimals, priceUsd: await priceP, feeBps: r.fee?.lowBps });
  if (priceWhy) throw new Error('Refused: ' + priceWhy + '. Nothing was sent.');
  const { opens } = directIxsChecked(built.list, { r: R, wCoinAta, rWsolAta });
  const ixs: Ix[] = built.list.map((x) => ({ program: x.programId, keys: x.accounts.map((a) => ({ pubkey: a.pubkey, signer: a.isSigner, writable: a.isWritable })), data: fromB64(x.data) }));
  // R's coin account, opened by the route's setup in this transaction (it did not exist): closed back to R at the end
  const opensRCoin = rcAcc === null && built.list.some((x) => x.programId === P.ata && x.accounts[1]?.pubkey === rCoinAta);
  const tail: Ix[] = opensRCoin ? [ix(r.tokenProgram, [[rCoinAta, false, true], [R, false, true], [R, true, false]], Uint8Array.of(9))] : [];
  const head: Ix[] = [ataCreate(R, w, r.mint, r.tokenProgram)];
  const tables = await jupTables(built.tables);
  for (const t of tables) { const claimed = built.claimed[t.key] || []; if (claimed.length > t.addresses.length || claimed.some((a, i) => a !== t.addresses[i])) throw new Error('Jupiter\'s lookup table does not match the chain — refused'); }
  mark('tables');
  const plan = await planP;
  mark('plan');
  const tip = plan.tipLamports > 0n ? [plan.protect ? tipIxGuarded(R, pick(JITO_TIP), plan.tipLamports) : transferIx(R, pick(JITO_TIP), plan.tipLamports)] : [];
  const microAt = (units: number) => Math.min(plan.micro, Number(((JUP_FEE_CEIL - (plan.tipLamports > JUP_FEE_CEIL ? JUP_FEE_CEIL : plan.tipLamports)) * 1_000_000n) / BigInt(units)));
  const feesAt = (units: number) => plan.tipLamports + (BigInt(microAt(units)) * BigInt(units)) / 1_000_000n + SIG_FEE + 10_000n;
  const rentMax = BigInt(opens + 1) * RENT_ATA22;   // the route's own opens + W's coin account
  const have = BigInt(rAcc?.lamports || 0), need = feesAt(JUP_UNITS_MAX) + rentMax + RENT_WALLET;
  if (have < need) throw new SolDirectNoGas(`The reserve needs about ${solTxt(need)} for the network fee and account rent — it has ${solTxt(have)}`);
  const all = (units: number, micro: number) => [...budget(units, micro), ...head, ...ixs, ...tail, ...tip];
  const trial = unsignedTx(compileV0(R, all(JUP_UNITS_MAX, 0), P.system, tables));
  if (trial.length > 1232) { if (maxAccounts > DIRECT_MAX_ACCOUNTS[1]) throw new DirectTooLarge(); throw new Error('Jupiter\'s route does not fit one transaction — nothing was sent; try a different amount'); }
  let sim = await simulateSeeing(trial, [R, usdcAta, wCoinAta]);
  mark('simulate');
  if (sim.err) throw new Error(errText(sim, 'buy', 'jupiter'));
  let post = (sim.accounts as any[]).map(simAcc);
  const through = new Set<string>();
  const innerWhy = directInnerGuard({ inner: sim.innerInstructions, r: R, w, usdcAta, rWsolAta, wCoinAta, amount: usdcIn, rentMax: RENT_ATA22, through });
  if (innerWhy && innerWhy !== 'no inner instructions') throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + innerWhy + '. Nothing was sent.');
  let others: { address: string; state: TokState }[] = [];
  let rentSeen = rentMax;
  if (!innerWhy) {
    const opened = jupInnerRent(sim.innerInstructions, R);
    if (opened.opens > JUP_OPENS_MAX + 1) throw new Error('Refused: Jupiter\'s transaction opens more accounts than a swap needs. Nothing was sent.');
    if (opened.rent > rentSeen) rentSeen = opened.rent;
    const via = [...through].filter((t) => t !== usdcAta && t !== wCoinAta);
    if (via.length) {
      // the route passes through token accounts R already held: read now and again in the simulation (net zero at most)
      if (via.length > 8) throw new Error('Refused: the Jupiter transaction passes through more of the reserve\'s token accounts than a swap needs. Nothing was sent.');
      const pre = await accounts(via);
      if (pre.some((x) => x === undefined)) throw new Error(READ_FAIL);
      const states = pre.map((x) => tokState(x));
      const bad = via.find((_, i) => !states[i] || states[i]!.owner !== R);
      if (bad) throw new Error(`Refused: Jupiter's transaction does not do what you asked — it moves tokens out of ${bad.slice(0, 6)}…. Nothing was sent.`);
      others = via.map((address, i) => ({ address, state: states[i]! }));
    }
  } else {
    // the node did not return the inner instructions: every token account R holds is checked instead (a reserve holds few)
    others = (await walletTokenAccounts(R)).filter((t) => t.address !== usdcAta);
  }
  if (others.length) {
    sim = await simulateSeeing(trial, [R, usdcAta, wCoinAta, ...others.map((t) => t.address)]);
    if (sim.err) throw new Error(errText(sim, 'buy', 'jupiter'));
    post = (sim.accounts as any[]).map(simAcc);
  }
  const units = Math.min(JUP_UNITS_MAX, Math.ceil(Number(sim.unitsConsumed || JUP_UNITS_MAX) * 1.25) + 5_000);
  const why = directBalanceGuard({
    amount: usdcIn, minOut, feesMax: feesAt(units), rentMax: rentSeen, r: R, w,
    usdcBefore, usdcAfter: post[1] ? tokState(post[1])?.amount ?? null : null,
    coinBefore, coinAfter: tokState(post[2]),
    solBefore: have, solAfter: BigInt(post[0]?.lamports ?? 0) - (BigInt(microAt(units)) * BigInt(units)) / 1_000_000n,
    others: others.map((t, i) => ({ address: t.address, before: t.state, after: tokState(post[3 + i]) })),
  });
  if (why) throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + why + '. Nothing was sent.');
  let bhi = await bhP; if (Date.now() - bhi.at > 20_000) bhi = await blockhash(0);
  return { message: (b) => compileV0(R, all(units, microAt(units)), b, tables), bh: bhi, mode: plan.mode, protect: plan.protect, minOut, outQuote: BigInt(built.quote.outAmount), route: (built.quote.routePlan || []).map((h) => h.swapInfo?.label || '?').join(' → '), timing, mark };
}
/** R's buy for W, sent through the engine's single held-wallet path (held by R's address on an unknown status). */
export async function solDirectBuy(rAcct: SolAcct, w: string, r: SolRoute, usdcIn: bigint, s: SolSettings, gate?: () => boolean): Promise<{ hash: string; minOut: bigint; route: string; timing: Record<string, number> }> {
  if (!rAcct.key || rAcct.ext) throw new Error('No Solana key for this reserve');
  const R = solKeys(rAcct.key).address;
  await solHoldGate(R);
  const click = joinClick();
  const b = await solDirectBuild(rAcct, w, r, usdcIn, s);
  // the caller's pre-send deadline (owner 2026-11-01, src/preSendDeadline.ts): a build it already answered "not started" is never sent
  if (gate && !gate()) throw new Error('The buy from your USD balance took too long to prepare — nothing was sent');
  const now = Date.now(); for (const [x, at] of sentSigs) if (now - at > 120_000) sentSigs.delete(x);
  sentSigs.set(b.hash, now);
  try { await sendSigned(b.tx, b.hash, b.lvh, R, { mode: b.mode, click, venue: 'jupiter', protect: b.protect }); }
  catch (e) { if (!(e instanceof SolSendUnknown)) sentSigs.delete(b.hash); throw e; }
  return { hash: b.hash, minOut: b.minOut, route: b.route, timing: b.timing };
}
