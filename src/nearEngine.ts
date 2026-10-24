// NEAR side of the vault. The same wallets as everywhere else: each vault
// wallet's secret deterministically yields one ed25519 key, whose public key
// IS the NEAR account (an implicit account, 64 hex chars). Buys and sells go
// straight to Rhea DCL (dclv2.ref-labs.near) the way nearly.trade's own site
// does: wrap NEAR + ft_transfer_call with a Swap message, or the coin's
// ft_transfer_call back into the pool. The only receivers ever signed for are
// wrap.near, the DCL exchange, and the coin account the factory itself names.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { nativeChainOf, nativeSeed, nearNamedOf } from './nativeKeys.ts';

export const NEAR_DEFAULT_RPCS = ['https://near.drpc.org', 'https://free.rpc.fastnear.com'];
// Settings → RPC: the user's own NEAR nodes go in front of the defaults (reads try them first, every trade is
// sent to all of them); trades-only nodes get the signed transactions and never a read
export let NEAR_RPCS = [...NEAR_DEFAULT_RPCS];
let NEAR_SEND_ONLY: string[] = [];
const isNodeUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(u);
export function setNearRpcs(reads: unknown[] = [], sends: unknown[] = []) {
  NEAR_RPCS = [...new Set([...reads.filter(isNodeUrl), ...NEAR_DEFAULT_RPCS])];
  NEAR_SEND_ONLY = [...new Set(sends.filter(isNodeUrl))].filter((u) => !NEAR_RPCS.includes(u)).slice(0, 3);
  rpcIdx = 0;
  return { rpcs: [...NEAR_RPCS], send: [...NEAR_SEND_ONLY, ...NEAR_RPCS] };
}
export const NEAR = { dcl: 'dclv2.ref-labs.near', wnear: 'wrap.near', factory: 'nearlytrade.near', explorer: 'https://nearblocks.io' };
export const NEAR_ACCT = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TGAS = 1_000_000_000_000n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;   // 0.00125 NEAR: one NEP-145 registration
const GAS_RESERVE = 50n * 10n ** 21n;                        // 0.05 NEAR always left for gas

export type NearAcct = { id: string; name: string; address: string; key?: string; ext?: string };
export type NearRoute = { token: string; pool: string; quote: string; quoteDecimals: number; decimals: number; bridgePool: string | null; symbol: string; quoteSymbol: string; price: number; nearUsd: number };
type Action = { fn: { method: string; args: unknown; gas: bigint; deposit: bigint } } | { transfer: bigint };

// ── bytes ──
const te = new TextEncoder();
const hexToBytes = (h: string) => { const s = h.replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out; };
const bytesToHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...a: Uint8Array[]) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes: Uint8Array): string { let x = 0n; for (const b of bytes) x = x * 256n + BigInt(b); let s = ''; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; }
export function b58decode(s: string): Uint8Array { let x = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); x = x * 58n + BigInt(i); } const out: number[] = []; while (x > 0n) { out.unshift(Number(x % 256n)); x /= 256n; } for (const c of s) { if (c === '1') out.unshift(0); else break; } return new Uint8Array(out); }

// ── borsh (just what a transaction needs) ──
class W {
  parts: Uint8Array[] = [];
  u8(v: number) { this.parts.push(new Uint8Array([v])); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.parts.push(b); }
  u128(v: bigint) { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setBigUint64(0, v & ((1n << 64n) - 1n), true); dv.setBigUint64(8, v >> 64n, true); this.parts.push(b); }
  bytes(u: Uint8Array) { this.parts.push(u); }
  vec(u: Uint8Array) { this.u32(u.length); this.bytes(u); }
  str(s: string) { this.vec(te.encode(s)); }
  out() { return concat(...this.parts); }
}
// Transaction { signer_id, public_key{ED25519, 32}, nonce u64, receiver_id, block_hash[32], actions: Vec<Action> }
// Action enum: 2 = FunctionCall { method_name, args, gas u64, deposit u128 }, 3 = Transfer { deposit u128 }
export function serializeTx(signerId: string, pub: Uint8Array, nonce: bigint, receiverId: string, blockHash: Uint8Array, actions: Action[]) {
  const w = new W(); w.str(signerId); w.u8(0); w.bytes(pub); w.u64(nonce); w.str(receiverId); w.bytes(blockHash); w.u32(actions.length);
  for (const a of actions) { if ('transfer' in a) { w.u8(3); w.u128(a.transfer); } else { w.u8(2); w.str(a.fn.method); w.vec(te.encode(JSON.stringify(a.fn.args))); w.u64(a.fn.gas); w.u128(a.fn.deposit); } }
  return w.out();
}

// ── keys: one NEAR identity per vault wallet, derived, never stored ──
const keyCache = new Map<string, { seed: Uint8Array; pub: Uint8Array; accountId: string }>();
export function nearKeys(evmKeyHex: string) {
  let k = keyCache.get(evmKeyHex); if (k) return k;
  // a NEAR-only wallet ('near:' + seed [+ ':' + named account], nativeKeys.ts) IS its seed and signs for that account;
  // every EVM key derives exactly as before
  const own = nativeChainOf(evmKeyHex);
  if (own === 'sol') throw new Error('A Solana wallet has no NEAR key');
  const seed = own === 'near' ? nativeSeed(evmKeyHex) : sha256(concat(te.encode('copytrade/near/v1/'), hexToBytes(evmKeyHex)));
  const pub = ed25519.getPublicKey(seed);
  k = { seed, pub, accountId: (own === 'near' && nearNamedOf(evmKeyHex)) || bytesToHex(pub) }; keyCache.set(evmKeyHex, k); return k;
}
export const nearAccountId = (a: NearAcct) => (a.key && !a.ext && nativeChainOf(a.key) !== 'sol' ? nearKeys(a.key).accountId : '');
// is this ed25519 public key a FULL-ACCESS key of that NEAR account? (the import dialog checks a named account with it)
export async function nearFullAccess(accountId: string, pubB58: string): Promise<boolean> {
  const r = await nearRpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: pubB58 });
  return r?.permission === 'FullAccess';
}
export const nearPublicKey = (evmKeyHex: string) => 'ed25519:' + b58encode(nearKeys(evmKeyHex).pub);
// the NEAR wallet format (secret = seed ‖ public key), importable into any NEAR wallet
export const nearSecretKey = (evmKeyHex: string) => { const k = nearKeys(evmKeyHex); return 'ed25519:' + b58encode(concat(k.seed, k.pub)); };

// ── rpc ──
let rpcIdx = 0;
async function rpcAt(url: string, method: string, params: unknown, ms = 20000): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) { const d = j.error.data; const msg = (d && typeof d === 'object' && (d.message || d.TxExecutionError)) ? (d.message || JSON.stringify(d.TxExecutionError)) : typeof d === 'string' ? d : j.error.message || JSON.stringify(j.error); const e = new Error(String(msg).slice(0, 240)) as Error & { rpc?: unknown }; e.rpc = j.error; throw e; }
  return j.result;
}
// a node problem, not a verdict on the call: the next node is asked (reads) / the outcome is left to the watcher (sends).
// A 429 / rate limit is one too (it used to end a read on the first node). Only a standalone 5xx code counts:
// NEAR errors carry long yocto amounts and `5\d\d` alone matched inside them.
const transient = (m: string) => /timeout|timed out|fetch|network|aborted|Unexpected token|\b5\d\d\b|\b429\b|rate.?limit|too many requests/i.test(m);
// F-38/F-10 V12: an optional validator runs on a node's result inside the loop. If it returns a message the
// result is malformed for this call (a bad or forged shape, not a verdict): that node is skipped like a transient
// failure and the next one is tried, instead of the bad result being returned to the caller.
export async function nearRpc(method: string, params: unknown, validate?: (r: any) => string | void): Promise<any> {
  let last: unknown;
  // F-39 V12: snapshot the start index so the loop counter `i` advances independently of the rotation pointer.
  // Before, mutating rpcIdx inside the index expression skipped a node (with two defaults the second was never tried).
  const n = NEAR_RPCS.length, s = rpcIdx;
  for (let i = 0; i < n; i += 1) {
    const url = NEAR_RPCS[(s + i) % n];
    try {
      const r = await rpcAt(url, method, params);
      const bad = validate ? validate(r) : undefined;
      if (bad) { last = new Error(bad); rpcIdx = (s + i + 1) % n; continue; }
      return r;
    }
    catch (e) { last = e; const m = String((e as Error).message || ''); if (!transient(m)) throw e; rpcIdx = (s + i + 1) % n; }
  }
  throw last as Error;
}
export async function nearView<T = any>(account: string, method: string, args: unknown = {}): Promise<T> {
  const r = await nearRpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64: b64(te.encode(JSON.stringify(args))) });
  if (r.error) throw new Error(String(r.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}
export async function nearAccountState(accountId: string): Promise<{ amount: bigint; storage: number } | null> {
  try { const r = await nearRpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId }); return { amount: BigInt(r.amount), storage: Number(r.storage_usage || 0) }; }
  catch (e) { if (/does not exist|UNKNOWN_ACCOUNT/i.test(String((e as Error).message))) return null; throw e; }
}
export const yoctoToNear = (v: bigint) => Number(v) / 1e24;
export const nearToYocto = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
// spendable = balance − what the account's storage locks − a reserve for gas
export async function nearSpendable(accountId: string) {
  const st = await nearAccountState(accountId);
  if (!st) return { balance: 0, spendable: 0, exists: false };
  const locked = BigInt(st.storage) * 10n ** 19n + GAS_RESERVE;
  return { balance: yoctoToNear(st.amount), spendable: yoctoToNear(st.amount > locked ? st.amount - locked : 0n), exists: true };
}
const metaCache = new Map<string, { symbol: string; decimals: number }>();
export async function nearTokenMeta(token: string) {
  let m = metaCache.get(token); if (m) return m;
  if (token === NEAR.wnear) { m = { symbol: 'NEAR', decimals: 24 }; metaCache.set(token, m); return m; }
  const r = await nearView<any>(token, 'ft_metadata'); m = { symbol: String(r?.symbol || '?').slice(0, 16), decimals: Number.isInteger(r?.decimals) ? Number(r.decimals) : 18 }; metaCache.set(token, m); return m;
}

// ── signing and sending ──
// The nonce is tracked here after one read (prewarm on hover): the block hash a NEAR transaction
// names stays valid for a day, so a cached access key is good for minutes; a nonce someone else
// used (the key imported elsewhere) comes back as InvalidNonce and is re-read once.
const ACCESS_TTL = 5 * 60_000;
const accessCache = new Map<string, { nonce: bigint; blockHash: Uint8Array; at: number }>();
// F-10 V12: before an access key is cached and used to sign, its shape must be sound — a decimal nonce (≤20
// digits, a u64), a 32-byte block hash, and FullAccess permission. A node that answers with anything else is
// treated as a failed endpoint (nearRpc tries the next). A genuine "no such key/account" error is left to flow
// through unchanged (r.error / rpcAt), so the caller's InvalidNonce / missing-account handling still fires.
export function validAccessKey(r: any): string | void {
  if (!r || typeof r !== 'object' || r.error) return;
  if (!/^\d{1,20}$/.test(String(r.nonce))) return 'access key: bad nonce shape';
  if (r.permission !== 'FullAccess') return 'access key: not a full-access key';
  let bh: Uint8Array; try { bh = b58decode(String(r.block_hash)); } catch { return 'access key: bad block_hash'; }
  if (bh.length !== 32) return 'access key: block_hash is not 32 bytes';
}
async function accessKey(accountId: string, pubB58: string) {
  const r = await nearRpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: pubB58 }, validAccessKey);
  if (r.error) throw new Error(String(r.error));
  return { nonce: BigInt(r.nonce), blockHash: b58decode(r.block_hash) };
}
// a re-read never moves the nonce back: a transaction of ours still on its way is not on chain yet,
// and reusing its nonce would make one of the two fail
function storeAccess(accountId: string, fresh: { nonce: bigint; blockHash: Uint8Array }) {
  const old = accessCache.get(accountId);
  const v = { ...fresh, nonce: old && old.nonce > fresh.nonce ? old.nonce : fresh.nonce, at: Date.now() };
  accessCache.set(accountId, v); return v;
}
const noAccount = (m: string) => /does not exist|UNKNOWN_ACCOUNT|access key|UNKNOWN_ACCESS_KEY/i.test(m);
// a buy press should cost one round trip: nonce and block hash are fetched while the user hovers
export async function nearPrewarm(a: NearAcct) {
  if (!a.key || a.ext) return;
  const k = nearKeys(a.key);
  const hit = accessCache.get(k.accountId); if (hit && Date.now() - hit.at < 60_000) return;
  try { storeAccess(k.accountId, await accessKey(k.accountId, nearPublicKey(a.key))); } catch {}
}
const txSender = new Map<string, string>();   // tx hash → signer (the tx RPC needs it)
// a NEAR transaction hash is sha256 of the borsh transaction: known before anything is sent
const txHashOf = (tx: Uint8Array) => b58encode(sha256(tx));
// Did a hash reach the chain? Only a definite "doesn't exist" says no; anything unclear counts as yes,
// so a transaction is never signed again with a new nonce while the first one may still land.
async function knownOnChain(hash: string, sender: string) {
  // F-64 V12: a single node's "doesn't exist" is not a verdict — the tx is treated as dropped only when EVERY node
  // agrees it is missing (nearTxState aggregates them). Any other state (pending / unknown / known) counts as still
  // possibly on chain, so a transaction is never re-signed with a new nonce while the first one may still land.
  return (await nearTxState(hash, sender)).state !== 'missing';
}
// rejects only when every copy failed, with the first error carrying all of them (`.all`)
const firstOk = <T>(list: Promise<T>[]) => new Promise<T>((resolve, reject) => { let left = list.length; const errs: unknown[] = []; for (const p of list) p.then(resolve, (e) => { errs.push(e); if (--left === 0) { const e0 = errs[0] as { all?: unknown[] }; if (e0 && typeof e0 === 'object') e0.all = errs; reject(errs[0]); } }); });
const msgOf = (e: unknown) => String((e as Error)?.message || e || '');
// Transactions from one account leave in order with consecutive nonces: the
// nonce is taken synchronously from the cached access key (so two calls in the
// same tick never collide) and the broadcasts are chained per account.
// wait 'INCLUDED' (trades): the same signed bytes go to every NEAR RPC at once and the call returns
// when the first says the transaction is in a block — about one block (~0.6 s) instead of the 3–6 s
// a DCL swap's receipt chain takes. The node still validates it first (nonce, signature, balance for
// gas), so those errors come back here. What the swap did is read later (watchTx / nearReceipt).
// wait 'EXECUTED_OPTIMISTIC' (transfers, unwraps): as before, the call returns the full outcome.
const sendQueue = new Map<string, Promise<unknown>>();
type SendWait = 'INCLUDED' | 'EXECUTED_OPTIMISTIC';
// F-17 V12: a NEAR send whose response was lost (transient / TIMEOUT_ERROR) may still have executed. The wallet is
// held by account id until a node settles the hash: webEngine's once() detects a NearSendUnknown and keeps the job
// "sending" rather than "failed", so the user never re-presses and signs a second transfer of the same funds.
export class NearSendUnknown extends Error { hash = ''; }
const nearHold = new Map<string, { hash: string; nonce: bigint | null }>();
// refuse any outflow from a held account until the prior unknown send settles: nearTxState shows it succeeded or
// failed, or the key's on-chain nonce has reached ours (so the signed bytes can no longer land) while it is not
// already success. Only then is the wallet free; otherwise the send is refused and the reason said.
async function nearHoldGate(a: NearAcct, accountId: string): Promise<void> {
  const held = nearHold.get(accountId);
  if (!held) return;
  const st = await nearTxState(held.hash, accountId);
  if (st.state === 'success' || st.state === 'failed') { nearHold.delete(accountId); return; }
  // the key's on-chain nonce has reached ours: the signed bytes carry a nonce that can no longer land (success was
  // already handled above), so the prior send is terminal and the wallet is freed
  const n = await nearKeyNonce(a);
  if (n != null && held.nonce != null && n >= held.nonce) { nearHold.delete(accountId); return; }
  throw new Error(`Your previous NEAR send from this wallet (${held.hash.slice(0, 8)}…) has an unknown status and may still land — wait until it settles before sending again`);
}
export async function nearSend(a: NearAcct, receiverId: string, actions: Action[], opts: { wait?: SendWait } = {}): Promise<{ hash: string; outcome: any; pending?: boolean }> {
  if (!a.key || a.ext) throw new Error('This wallet cannot sign NEAR (Privy wallets are EVM only)');
  const k = nearKeys(a.key); const pubB58 = nearPublicKey(a.key);
  // F-17 V12: hold the wallet while a prior send from it is unknown (covers trades, transfers and unwraps)
  await nearHoldGate(a, k.accountId);
  const wait: SendWait = opts.wait || 'EXECUTED_OPTIMISTIC';
  let lastHash = '';
  const send = async (fresh: boolean): Promise<{ hash: string; res: any; pending?: boolean }> => {
    let ak = fresh ? undefined : accessCache.get(k.accountId);
    if (!ak || Date.now() - ak.at > ACCESS_TTL) {
      try { ak = storeAccess(k.accountId, await accessKey(k.accountId, pubB58)); }
      catch (e) { const m = String((e as Error).message); if (noAccount(m)) throw new Error(`Wallet ${k.accountId.slice(0, 8)}… has no NEAR yet — send NEAR to it first`); throw e; }
    }
    const nonce = ak.nonce + 1n; ak.nonce = nonce; ak.at = Date.now();
    const tx = serializeTx(k.accountId, k.pub, nonce, receiverId, ak.blockHash, actions);
    const signed = concat(tx, new Uint8Array([0]), ed25519.sign(sha256(tx), k.seed));
    const hash = txHashOf(tx); lastHash = hash; txSender.set(hash, k.accountId);
    if (wait === 'INCLUDED') {
      try { const res = await firstOk([...NEAR_SEND_ONLY, ...NEAR_RPCS].map((u) => rpcAt(u, 'send_tx', { signed_tx_base64: b64(signed), wait_until: 'INCLUDED' }))); return { hash, res }; }
      catch (e) {
        // any node that did not answer may still have taken it: the transaction may well be in, the watcher settles it
        // (a refusal from one node next to a timeout from another is not a verdict on the bytes the other one got)
        const all = ((e as { all?: unknown[] }).all || [e]).map(msgOf);
        if (all.some(transient)) return { hash, res: null, pending: true };
        accessCache.delete(k.accountId); throw e;
      }
    }
    const broadcastOpt = async () => {
      try { return await nearRpc('send_tx', { signed_tx_base64: b64(signed), wait_until: 'EXECUTED_OPTIMISTIC' }); }
      catch (e) { if (/method not found|-32601/i.test(String((e as Error).message))) return await nearRpc('broadcast_tx_commit', [b64(signed)]); throw e; }
    };
    try { return { hash, res: await broadcastOpt() }; }
    catch (e) {
      const m = String((e as Error).message);
      // F-17 V12: a transient / TIMEOUT_ERROR here is not a verdict — the transaction may well have executed but the
      // response was lost. Return pending and KEEP the access-key cache: deleting it would re-read a nonce and let a
      // retry sign a SECOND transfer of the same funds. The caller holds the wallet until a node settles the hash.
      if (transient(m) || /TIMEOUT_ERROR/i.test(m)) return { hash, res: null, pending: true };
      accessCache.delete(k.accountId); throw e;
    }
  };
  const run = async () => {
    try { return await send(false); }
    catch (e) {
      const m = String((e as Error).message);
      // a nonce or block-hash refusal is signed again with a fresh access key — unless the first copy is on chain:
      // then the refusal is about our own transaction already being in (a second node saw it after the first took
      // it), so it is reported as sent, never as a failure the user would click again
      if (/InvalidNonce|nonce|Expired|block hash/i.test(m)) {
        if (lastHash && await knownOnChain(lastHash, k.accountId)) return { hash: lastHash, res: null, pending: true };
        return send(true);
      }
      throw e;
    }
  };
  const prev = sendQueue.get(k.accountId) || Promise.resolve();
  const mine = prev.catch(() => {}).then(run);
  sendQueue.set(k.accountId, mine);
  const { hash: localHash, res, pending } = await mine;
  const hash = String(res?.transaction?.hash || res?.transaction_outcome?.id || localHash || '');
  if (hash) txSender.set(hash, k.accountId);
  return { hash, outcome: res, pending };
}
// ── wallet-to-wallet moves (src/moveChains.ts, 2026-10-19) ──
// A move signs first and keeps the bytes (a retry re-broadcasts the SAME transaction, which can land only once), then
// sends. The nonce comes from the same cached access key as the trades (taken synchronously: no collision in a tick).
export async function nearSignTransfer(a: NearAcct, to: string, amount: bigint, fresh = false): Promise<{ hash: string; signed: string; nonce: string; signer: string }> {
  if (!a.key || a.ext) throw new Error('This wallet cannot sign NEAR (Privy wallets are EVM only)');
  const k = nearKeys(a.key); const pubB58 = nearPublicKey(a.key);
  let ak = fresh ? undefined : accessCache.get(k.accountId);
  if (!ak || Date.now() - ak.at > ACCESS_TTL) {
    try { ak = storeAccess(k.accountId, await accessKey(k.accountId, pubB58)); }
    catch (e) { if (noAccount(String((e as Error).message))) throw new Error(`Wallet ${k.accountId.slice(0, 8)}… has no NEAR yet — send NEAR to it first`); throw e; }
  }
  const nonce = ak.nonce + 1n; ak.nonce = nonce; ak.at = Date.now();
  const tx = serializeTx(k.accountId, k.pub, nonce, to, ak.blockHash, [{ transfer: amount }]);
  const signed = concat(tx, new Uint8Array([0]), ed25519.sign(sha256(tx), k.seed));
  const hash = txHashOf(tx); txSender.set(hash, k.accountId);
  return { hash, signed: b64(signed), nonce: nonce.toString(), signer: k.accountId };
}
// the same bytes to every node at once; the first full outcome wins (rejects with `.all` when every node failed)
export const nearBroadcastSigned = (signedB64: string) => firstOk([...NEAR_SEND_ONLY, ...NEAR_RPCS].map((u) => rpcAt(u, 'send_tx', { signed_tx_base64: signedB64, wait_until: 'EXECUTED_OPTIMISTIC' })));
export const nearTransient = (m: string) => transient(m);
// what the chain says about one hash: executed (success / failed), known but not executed yet, unknown to EVERY node, or no answer
export async function nearTxState(hash: string, sender: string): Promise<{ state: 'success' | 'failed' | 'pending' | 'missing' | 'unknown'; error?: string }> {
  const got = await Promise.allSettled(NEAR_RPCS.map((u) => rpcAt(u, 'tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' }, 8000)));
  // F-64 V12: collect every node's verdict instead of trusting the first. A success from any node wins — it landed;
  // a Failure counts only when NO node contradicts it with a success (a lone forged/partial Failure must not release
  // the hold and let the same funds be sent again). Each node's result must be THIS transaction (executed checks the
  // outcome id against the hash) before it is read as a verdict at all.
  let missing = 0, known = false, success = false, failure = '';
  for (const g of got) {
    if (g.status === 'fulfilled') {
      if (executed(g.value, hash)) { const f = failureOf(g.value); if (f) failure ||= f; else success = true; } else known = true;
      continue;
    }
    const m = String((g.reason as Error)?.message || '');
    if (/doesn't exist|does not exist|UNKNOWN_TRANSACTION/i.test(m)) missing += 1; else if (!transient(m)) known = true;
  }
  if (success) return { state: 'success' };
  if (failure) return { state: 'failed', error: failure };
  return known ? { state: 'pending' } : missing === got.length && got.length > 0 ? { state: 'missing' } : { state: 'unknown' };
}
// the access key's nonce on chain (final): a transaction whose nonce is at or below it can no longer land
export async function nearKeyNonce(a: NearAcct): Promise<bigint | null> {
  if (!a.key || a.ext) return null;
  try { return (await accessKey(nearKeys(a.key).accountId, nearPublicKey(a.key))).nonce; } catch { return null; }
}
export const failureOf = (outcome: any): string => {
  const pick = (s: any) => (s && typeof s === 'object' && 'Failure' in s ? JSON.stringify(s.Failure) : '');
  const f = pick(outcome?.status) || (outcome?.receipts_outcome || []).map((ro: any) => pick(ro.outcome?.status)).find(Boolean) || '';
  const m = /"ExecutionError":"([^"]+)"/.exec(f); return (m ? m[1] : f).slice(0, 220);
};
// ft_transfer_call answers with the amount the receiver kept: 0 = the swap refused the funds (slippage) and they bounced
const usedOf = (outcome: any): bigint | null => { try { const sv = outcome?.status?.SuccessValue; if (sv == null) return null; const txt = atob(sv); const v = JSON.parse(txt); return BigInt(String(v)); } catch { return null; } };

// ── confirmation, beside the click ──
// After a trade is in a block, one tx(EXECUTED_OPTIMISTIC) per hash waits on the node for the receipt
// chain and the verdict is kept: success, a failure, or a swap that did not fill (refunded). The
// follow-ups that used to hold the click (unwrapping refunded / paid-out wNEAR) run from here.
type Verdict = { status: 'success' | 'reverted'; error?: string; outcome: any };
const verdicts = new Map<string, Verdict & { at: number }>();
const watching = new Map<string, Promise<void>>();
// F-64 V12: a status object is a final verdict only when it carries EXACTLY ONE of SuccessValue / SuccessReceiptId /
// Failure — a node still assembling the outcome answers with none (or an interim shape), which is not executed.
const finalStatus = (s: any): boolean => !!s && typeof s === 'object' && ['SuccessValue', 'SuccessReceiptId', 'Failure'].filter((key) => key in s).length === 1;
// executed only when the result is THIS transaction (its transaction_outcome.id equals the hash we asked about — a
// node must not answer one hash with another's receipt), its status is a single final verdict, and (when present)
// the final_execution_status says EXECUTED / FINAL. Otherwise it is still pending, not a verdict.
const executed = (r: any, expectHash?: string) => finalStatus(r?.status) && (!expectHash || r?.transaction_outcome?.id === expectHash) && (!r?.final_execution_status || /EXECUTED|FINAL/.test(String(r.final_execution_status)));
function watchTx(hash: string, sender: string, judge: (outcome: any) => Verdict) {
  if (!hash || watching.has(hash) || verdicts.has(hash)) return;
  const t0 = Date.now(); let seenMissing = false, answered = false;
  const p = (async () => {
    while (Date.now() - t0 < 90_000) {
      try {
        const r = await nearRpc('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' });
        if (executed(r, hash)) { verdicts.set(hash, { ...judge(r), at: Date.now() }); return; }
        answered = true;   // the chain knows it (in a block, receipts still running)
        await new Promise((ok) => setTimeout(ok, 600));
      } catch (e) {
        const m = String((e as Error).message);
        const missing = /doesn't exist|does not exist|UNKNOWN_TRANSACTION/i.test(m); if (missing) seenMissing = true; else if (!transient(m)) answered = true;
        // never a hot loop: an offline browser fails every fetch at once
        await new Promise((ok) => setTimeout(ok, missing ? 600 : transient(m) ? 300 : 1500));
      }
    }
    // only the chain saying "no such transaction" for 90 s is a verdict; a watcher that never got an answer (offline,
    // every node down) leaves the trade unknown — pending to the page, never "failed", so nothing is bought twice.
    // F-64 V12: confirm with ALL nodes before calling it dropped — the single-node poll above seeing "missing" is not
    // enough; only when every node agrees 'missing' is the transaction truly gone (any other state stays pending).
    if (seenMissing && !answered && (await nearTxState(hash, sender).catch(() => ({ state: 'unknown' as const }))).state === 'missing')
      verdicts.set(hash, { status: 'reverted', error: 'Not seen on chain within 90 s — the network dropped it', outcome: null, at: Date.now() });
  })();
  watching.set(hash, p); p.catch(() => {}).finally(() => watching.delete(hash));
  for (const [x, v] of verdicts) if (Date.now() - v.at > 30 * 60_000) verdicts.delete(x);
}

// ── the route: what the factory says the coin is ──
const routeCache = new Map<string, { r: NearRoute; at: number }>();
// the NEAR → quote pool that actually fills: four fee tiers may exist with
// nothing in them (RHEA's DCL pools are empty; its market is a classic pool), so
// the pick is by what 0.1 NEAR buys, not by existence
async function findBridgePool(quote: string) {
  const [x, y] = [quote, NEAR.wnear].sort(); let best: { id: string; out: bigint } | null = null;
  for (const fee of [100, 400, 2000, 10000]) {
    const id = `${x}|${y}|${fee}`;
    const out = await dclQuote([id], NEAR.wnear, quote, 10n ** 23n);
    if (out && (!best || out > best.out)) best = { id, out };
  }
  return best?.id || null;
}
export async function nearRoute(token: string, hint?: any): Promise<NearRoute> {
  const t = String(token || '').toLowerCase(); if (!NEAR_ACCT.test(t)) throw new Error('Invalid NEAR token account');
  const live = { price: Number(hint?.price) || 0, nearUsd: Number(hint?.nearUsd) || 0 };
  // F-21 V12: route cache cut from 10 min to 60 s — the bridge pool and the launch state are re-read before signing.
  const c = routeCache.get(t); if (c && Date.now() - c.at < 60_000) return { ...c.r, ...(live.price ? live : {}) };
  const startedAt = Date.now();
  // the page's hint is a hint; the receivers of a signed call come from the factory's own record
  const l = await nearView<any>(NEAR.factory, 'get_launch_by_token', { token: t });
  if (!l?.pool_id) throw new Error('Not a nearly.trade coin');
  if (l.step !== 'Done') throw new Error('This launch is not live yet');
  const quote = String(l.quote || NEAR.wnear);
  const [qm, tm] = await Promise.all([nearTokenMeta(quote), nearTokenMeta(t)]);
  let bridgePool: string | null = null;
  // a coin priced in something else than NEAR: buys go NEAR → quote → coin when Rhea has that first leg; without it buys need the quote itself and sells pay out in it
  // F-21 V12: the NEAR→quote bridge pool is always discovered on chain (findBridgePool) and never taken from the
  // page hint — a compromised page must not choose a leg of a signed swap.
  if (quote !== NEAR.wnear) bridgePool = await findBridgePool(quote);
  const r: NearRoute = { token: t, pool: String(l.pool_id), quote, quoteDecimals: qm.decimals, decimals: tm.decimals, bridgePool, symbol: String(l.symbol || tm.symbol), quoteSymbol: qm.symbol, ...live };
  // F-21 V12: a slow lookup that started earlier must not overwrite a fresher route written by a later one —
  // `at` holds when this read began, and we only write if no newer entry is already cached.
  const cur = routeCache.get(t);
  if (!cur || cur.at < startedAt) routeCache.set(t, { r, at: startedAt });
  return r;
}
// the wallets of one click ask for the same quote in the same tick: one view call answers them all
const quoteTick = new Map<string, Promise<bigint | null>>();
function dclQuote(poolIds: string[], input: string, output: string, amount: bigint): Promise<bigint | null> {
  const key = [poolIds.join(','), input, output, amount.toString()].join(' ');
  let p = quoteTick.get(key);
  if (!p) { p = dclQuoteNow(poolIds, input, output, amount); quoteTick.set(key, p); setTimeout(() => quoteTick.delete(key), 0); }
  return p;
}
async function dclQuoteNow(poolIds: string[], input: string, output: string, amount: bigint): Promise<bigint | null> {
  try { const r = await nearView<any>(NEAR.dcl, 'quote', { pool_ids: poolIds, input_token: input, output_token: output, input_amount: amount.toString(), tag: null }); const v = r?.amount ?? r; const n = BigInt(String(v)); return n > 0n ? n : null; } catch { return null; }
}
const bps = (slippage: number) => BigInt(Math.round(Math.min(99, Math.max(0.1, slippage)) * 100));
// a registration, once seen, is remembered (an account is almost never unregistered): no view call next time
const regSeen = new Map<string, number>();
// What a registration costs is the token's own storage_balance_bounds().min (0.00125 NEAR for most, more for some):
// a fixed 0.00125 under a higher minimum made the registration fail and the swap's payout bounce. Capped: a token
// asking more than 0.05 NEAR for one account is refused rather than paid.
const STORAGE_CAP = 50n * 10n ** 21n;
const minDeposit = new Map<string, Promise<bigint>>();
const depositFor = (token: string) => {
  let p = minDeposit.get(token);
  if (!p) { p = nearView<any>(token, 'storage_balance_bounds').then((b) => { const v = BigInt(String(b?.min ?? '0')); return v > STORAGE_DEPOSIT ? v : STORAGE_DEPOSIT; }).catch(() => { minDeposit.delete(token); return STORAGE_DEPOSIT; }); minDeposit.set(token, p); }
  return p;
};
// 0n = registered; otherwise the deposit this account's registration on that token needs
const reg = (token: string, me: string): Promise<bigint> => { const k = token + ' ' + me; const at = regSeen.get(k); if (at && Date.now() - at < 30 * 60_000) return Promise.resolve(0n); return nearView<any>(token, 'storage_balance_of', { account_id: me }).then((x) => { if (x) { regSeen.set(k, Date.now()); return 0n; } return depositFor(token); }).catch(() => depositFor(token)); };
const register = (a: NearAcct, token: string, me: string, deposit: bigint): Action => {
  if (deposit > STORAGE_CAP) throw new Error(`${token} asks ${yoctoToNear(deposit)} NEAR to register a wallet — refused`);
  return { fn: { method: 'storage_deposit', args: { account_id: me, registration_only: true }, gas: 10n * TGAS, deposit } };
};
// a refund the watcher could not unwrap (the tab closed first) is still wNEAR in the wallet, invisible in the NEAR
// balance: the first trade of a session on that wallet turns it back into NEAR (same receiver and method as above)
const swept = new Set<string>();
// F-11 V12: the wallet is marked swept optimistically to keep one sweep per session, but if the sweep fails
// (including a failed balance read, which now throws) the mark is dropped so the next trade retries — leftover
// wNEAR is never silently stranded.
const sweepOnce = (a: NearAcct, me: string) => { if (swept.has(me)) return; swept.add(me); unwrapLeftover(a, me).catch(() => swept.delete(me)); };

// ── trades ──
export async function nearTradeOne(a: NearAcct, side: 'buy' | 'sell', r: NearRoute, size: number, slippage: number): Promise<{ hash: string }> {
  const me = nearAccountId(a); if (!me) throw new Error('Privy wallets are EVM only');
  const slip = bps(slippage);
  sweepOnce(a, me);
  if (side === 'buy') {
    const amount = nearToYocto(size); if (amount <= 0n) throw new Error('Amount');
    if (r.quote !== NEAR.wnear && !r.bridgePool) throw new Error(`${r.symbol} is priced in ${r.quoteSymbol} and Rhea has no NEAR → ${r.quoteSymbol} pool: buy it with ${r.quoteSymbol} on nearly.trade`);
    const pools = r.bridgePool ? [r.bridgePool, r.pool] : [r.pool];
    // one round trip for everything the node can tell at once: balance, quote, both registrations
    const [{ spendable, exists }, q, regTok, regW] = await Promise.all([nearSpendable(me), dclQuote(pools, NEAR.wnear, r.token, amount), reg(r.token, me), reg(NEAR.wnear, me)]);
    if (!exists) throw new Error(`Wallet ${me.slice(0, 8)}… has no NEAR yet — send NEAR to it first`);
    if (size > spendable) throw new Error(`Not enough NEAR: ${spendable.toFixed(3)} spendable after storage and gas`);
    let minOut: bigint;
    if (q != null) minOut = (q * (10000n - slip)) / 10000n;
    // F-21 V12: no page-price fallback for the signed minimum — if Rhea gives no live DCL quote, refuse rather than
    // trust hint.price/nearUsd (a compromised page could set a minOut that makes a bad fill look acceptable).
    else throw new Error('No quote from Rhea');
    // the coin must know the wallet before the pool can hand it tokens (separate receiver → its own tx);
    // it goes first in this wallet's send queue and the swap follows once it is in a block: the swap's
    // payout runs ~3 blocks after that, by then the registration has executed
    const regTokAct = regTok ? register(a, r.token, me, regTok) : null;
    if (regTokAct) nearSend(a, r.token, [regTokAct], { wait: 'INCLUDED' }).catch(() => {});
    const actions: Action[] = [];
    if (regW) actions.push(register(a, NEAR.wnear, me, regW));
    actions.push({ fn: { method: 'near_deposit', args: {}, gas: 10n * TGAS, deposit: amount } });
    actions.push({ fn: { method: 'ft_transfer_call', args: { receiver_id: NEAR.dcl, amount: amount.toString(), msg: JSON.stringify({ Swap: { pool_ids: pools, output_token: r.token, min_output_amount: minOut.toString(), swap_out_recipient: me } }) }, gas: (pools.length > 1 ? 250n : 180n) * TGAS, deposit: 1n } });
    // back to the click as soon as the swap is in a block; its outcome is settled beside it
    const { hash } = await nearSend(a, NEAR.wnear, actions, { wait: 'INCLUDED' });
    watchTx(hash, me, (outcome) => {
      const f = failureOf(outcome); if (f) return { status: 'reverted', error: f, outcome };
      if (usedOf(outcome) === 0n) { unwrapLeftover(a, me).catch(() => {}); return { status: 'reverted', error: 'Swap did not fill — price moved past your slippage; NEAR is back in the wallet', outcome }; }
      return { status: 'success', outcome };
    });
    return { hash };
  }
  // sells pay out in NEAR when Rhea can bridge the quote back; otherwise in the coin's own quote asset (RHEA, ZEC, a stock)
  const toNear = r.quote === NEAR.wnear || !!r.bridgePool;
  const outToken = toNear ? NEAR.wnear : r.quote;
  const pools = toNear && r.bridgePool ? [r.pool, r.bridgePool] : [r.pool];
  const [balRaw, regOut] = await Promise.all([nearView<string>(r.token, 'ft_balance_of', { account_id: me }).then((v) => BigInt(v || '0')).catch(() => 0n), reg(outToken, me)]);
  const pct = Math.min(100, Math.max(0.01, size));
  const amount = pct >= 100 ? balRaw : (balRaw * BigInt(Math.round(pct * 100))) / 10000n;
  if (amount <= 0n) throw new Error('Nothing to sell');
  const q = await dclQuote(pools, r.token, outToken, amount);
  let minOut: bigint;
  if (q != null) minOut = (q * (10000n - slip)) / 10000n;
  // F-21 V12: no page-price fallback for the signed minimum — refuse the sell if Rhea gives no live DCL quote.
  else throw new Error('No quote from Rhea');
  // the payout account registration rides ahead of the swap in the same send queue; no block wait in between
  if (regOut) nearSend(a, outToken, [register(a, outToken, me, regOut)], { wait: 'INCLUDED' }).catch(() => {});
  const swap = toNear ? { pool_ids: pools, output_token: outToken, min_output_amount: minOut.toString(), skip_unwrap_near: false } : { pool_ids: pools, output_token: outToken, min_output_amount: minOut.toString(), swap_out_recipient: me };
  const { hash } = await nearSend(a, r.token, [{ fn: { method: 'ft_transfer_call', args: { receiver_id: NEAR.dcl, amount: amount.toString(), msg: JSON.stringify({ Swap: swap }) }, gas: (pools.length > 1 ? 250n : 180n) * TGAS, deposit: 1n } }], { wait: 'INCLUDED' });
  watchTx(hash, me, (outcome) => {
    const f = failureOf(outcome); if (f) return { status: 'reverted', error: f, outcome };
    if (usedOf(outcome) === 0n) return { status: 'reverted', error: 'Swap did not fill — price moved past your slippage; the tokens stayed in the wallet', outcome };
    if (toNear) unwrapLeftover(a, me).catch(() => {});   // whatever came back as wNEAR becomes NEAR
    return { status: 'success', outcome };
  });
  return { hash };
}
// wNEAR sitting in the wallet (a refused swap, an exchange that paid in wrapped) is turned back into NEAR
export async function unwrapLeftover(a: NearAcct, me: string) {
  // F-11 V12: a failed balance read must throw (not resolve 0) so sweepOnce's catch un-marks the wallet and the
  // leftover is retried, instead of a transient read error being mistaken for "nothing to sweep".
  const bal = BigInt(await nearView<string>(NEAR.wnear, 'ft_balance_of', { account_id: me }));
  if (bal <= 10n ** 20n) return;   // dust under 0.0001
  // in a block is enough: nothing reads its outcome, and a full wait here would hold this wallet's next trade in the queue
  await nearSend(a, NEAR.wnear, [{ fn: { method: 'near_withdraw', args: { amount: bal.toString() }, gas: 10n * TGAS, deposit: 1n } }], { wait: 'INCLUDED' });
}
export async function nearPreviewOne(a: NearAcct, side: 'buy' | 'sell', r: NearRoute, size: number, slippage: number) {
  const me = nearAccountId(a);
  const { balance } = me ? await nearSpendable(me) : { balance: 0 };
  const base = { name: a.name, address: me || a.address, side, venue: 'Rhea DCL', contract: NEAR.dcl as `0x${string}`, method: 'ft_transfer_call(Swap)', gas: 180, gasPriceGwei: 0, gasEth: 0.002, balanceEth: balance };
  if (side === 'buy') {
    const amount = nearToYocto(size); const pools = r.bridgePool ? [r.bridgePool, r.pool] : [r.pool];
    const q = await dclQuote(pools, NEAR.wnear, r.token, amount);
    const expected = q != null ? Number(q) / 10 ** r.decimals : r.price > 0 && r.nearUsd > 0 ? ((size * r.nearUsd) / r.price) * 0.99 : 0;
    return { ...base, amountIn: size, amountInLabel: `${size} NEAR`, expected, min: expected * (1 - slippage / 100), pricePerToken: expected > 0 ? size / expected : 0, funded: balance >= size + 0.06 };
  }
  const balRaw = me ? BigInt(await nearView<string>(r.token, 'ft_balance_of', { account_id: me }).catch(() => '0')) : 0n;
  const amount = size >= 100 ? balRaw : (balRaw * BigInt(Math.round(Math.max(0.01, size) * 100))) / 10000n;
  const toNear = r.quote === NEAR.wnear || !!r.bridgePool;
  const outToken = toNear ? NEAR.wnear : r.quote; const outDec = toNear ? 24 : r.quoteDecimals;
  const pools = toNear && r.bridgePool ? [r.pool, r.bridgePool] : [r.pool];
  const q = amount > 0n ? await dclQuote(pools, r.token, outToken, amount) : null;
  const tokens = Number(amount) / 10 ** r.decimals;
  const expected = q != null ? Number(q) / 10 ** outDec : toNear && r.price > 0 && r.nearUsd > 0 ? (tokens * r.price / r.nearUsd) * 0.99 : 0;
  return { ...base, venue: toNear ? 'Rhea DCL' : `Rhea DCL → ${r.quoteSymbol}`, amountIn: tokens, amountInLabel: `${tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${r.symbol}`, expected, min: expected * (1 - slippage / 100), pricePerToken: tokens > 0 ? expected / tokens : 0, funded: balance >= 0.06 && amount > 0n };
}

// ── balances, transfers, receipts ──
export async function nearBalancesFor(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all([...new Set(ids)].map(async (id) => { if (!NEAR_ACCT.test(id)) { out[id] = 0; return; } const st = await nearAccountState(id).catch(() => null); out[id] = st ? yoctoToNear(st.amount) : 0; }));
  return out;
}
export async function nearTokenBalancesFor(token: string, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}; const m = await nearTokenMeta(token).catch(() => ({ symbol: '?', decimals: 18 }));
  await Promise.all([...new Set(ids)].map(async (id) => { if (!NEAR_ACCT.test(id)) { out[id] = 0; return; } const raw = await nearView<string>(token, 'ft_balance_of', { account_id: id }).catch(() => '0'); out[id] = Number(BigInt(raw || '0')) / 10 ** m.decimals; }));
  return out;
}
export async function nearTransfer(a: NearAcct, to: string, amountNear: number | 'max'): Promise<string> {
  const me = nearAccountId(a); if (!me) throw new Error('Privy wallets are EVM only');
  if (!NEAR_ACCT.test(to)) throw new Error('Invalid NEAR account');
  let amount: bigint;
  if (amountNear === 'max') { const st = await nearAccountState(me); if (!st) throw new Error('Wallet has no NEAR'); const keep = BigInt(st.storage) * 10n ** 19n + 10n ** 22n; amount = st.amount > keep ? st.amount - keep : 0n; } else amount = nearToYocto(amountNear);
  if (amount <= 0n) throw new Error('Nothing to send');
  // a named account must exist; an implicit (64-hex) account is created by the transfer itself
  if (!/^[0-9a-f]{64}$/.test(to) && !(await nearAccountState(to))) throw new Error(`Account ${to} does not exist on NEAR`);
  const { hash, outcome, pending } = await nearSend(a, to, [{ transfer: amount }]);
  // F-17 V12: the send's response was lost — it may still land. Hold this wallet (by the nonce the signed bytes
  // carry, read back from the cache nearSend kept) and throw a NearSendUnknown so webEngine's once() keeps the job
  // "sending", never "failed": the user must not re-press and send the same NEAR a second time.
  if (pending) { nearHold.set(me, { hash, nonce: accessCache.get(me)?.nonce ?? null }); const err = new NearSendUnknown('Your NEAR transfer went out but no node confirmed it — it may still land; wait before sending again'); err.hash = hash; throw err; }
  const f = failureOf(outcome); if (f) throw new Error(f);
  return hash;
}
const burntOf = (r: any) => (r?.receipts_outcome || []).reduce((s: bigint, ro: any) => s + BigInt(ro.outcome?.tokens_burnt || 0), BigInt(r?.transaction_outcome?.outcome?.tokens_burnt || 0));
// a trade's verdict comes from its watcher (no RPC call here); any other hash is looked up once
export async function nearReceipt(hash: string) {
  const v = verdicts.get(hash);
  if (v) return { ok: true, pending: false, status: v.status, ...(v.error ? { error: v.error } : {}), block: 0, gasUsed: Number(v.outcome?.transaction_outcome?.outcome?.gas_burnt || 0), feeEth: yoctoToNear(burntOf(v.outcome)) };
  if (watching.has(hash)) return { ok: true, pending: true };
  const sender = txSender.get(hash); if (!sender) return { ok: true, pending: true };
  const r = await nearRpc('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' }).catch(() => null);
  if (!executed(r, hash)) return { ok: true, pending: true };
  const f = failureOf(r) || (usedOf(r) === 0n ? 'Swap did not fill' : '');
  return { ok: true, pending: false, status: f ? 'reverted' : 'success', ...(f ? { error: f } : {}), block: 0, gasUsed: Number(r.transaction_outcome?.outcome?.gas_burnt || 0), feeEth: yoctoToNear(burntOf(r)) };
}
