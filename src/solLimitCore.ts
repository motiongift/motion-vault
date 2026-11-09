// Limit orders on Solana (2026-10-25; trench docs/drafts/LIMIT-ORDERS.md §14): the pure parts, shared by the vault
// (src/solLimitEngine.ts) and the keeper (trench server/sol-limit-orders.mjs, which imports this file under
// node --experimental-strip-types).
//
// The same idea as the EVM orders (src/limitCore.ts), with Solana's own tools:
//   · per order an ORDER WALLET, its ed25519 seed = HMAC-SHA256(main Solana seed, "motion/limit-order/v1\nsol\n<orderId>");
//   · per order a DURABLE NONCE account owned by the System program, address = createWithSeed(order wallet, "motion-limit"),
//     authority = the order wallet. A transaction whose first instruction advances that nonce and whose blockhash IS the
//     nonce's value never expires — until the nonce moves. Every pre-signed variant uses the same nonce, so at most one can
//     ever land; a cancel advances (or closes) the nonce and every pre-signed byte is dead;
//   · each variant pays the main wallet its floor INSIDE the same transaction (buy: a transferChecked of minOut tokens to the
//     main wallet's token account; sell: a System transfer of minOut lamports), so the floor reaches the main wallet
//     atomically or nothing happens. What the swap returns above the floor stays in the order wallet until the vault sweeps it.
// The keeper holds only signed bytes it can send or not; checkSolPosted() refuses any byte outside this shape.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

export const SOL_LIMIT_CHAIN = 'sol';
export const SOL_LIMIT_VERSION = 1;
// ── limits ──
export const SOL_MAX_OPEN = 10;
export const SOL_MIN_SIZE = 50_000_000n;                  // 0.05 SOL: a buy's size, a sell's value at its limit price
export const SOL_MIN_EXPIRY_S = 3600, SOL_MAX_EXPIRY_S = 7 * 86400;
export const SOL_SLIP_DEFAULT_BPS = 100, SOL_SLIP_MIN_BPS = 10, SOL_SLIP_MAX_BPS = 2000;   // 1 % default (review M4), a custom value up to 20 %
// the venue fee counted into the floor (pump.fun's curve and PumpSwap charge ≤ 1.25 % at the top tier; a lower floor than
// needed is the safe side: the swap never fails on it)
export const SOL_VENUE_FEE_BPS = 125;
// a pre-signed tx's compute: the limit and the priority price it carries (fixed at signing: the order must still land days later)
export const SOL_MAX_UNITS = 400_000;
export const SOL_MAX_MICRO = 5_000_000;                   // µ-lamports per unit: ≤ 0.002 SOL of priority at 400k units
export const SOL_MAX_TIP = 2_000_000n;                    // ≤ 0.002 SOL Jito tip per variant
export const SOL_MAX_TX_BYTES = 1232;
export const SOL_DUST = 10_000n;                          // below this an order wallet counts as empty (lamports)
export const SOL_NONCE_SEED = 'motion-limit';
export const SOL_NONCE_SPACE = 80;
export const SOL_NONCE_RENT = 1_447_680n;                 // rent-exempt minimum of an 80-byte account (returned on close)
export const SOL_ORDER_ID = /^[0-9a-f]{32}$/;
export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SOL_AUTH_WINDOW_MS = 10 * 60_000, SOL_READ_WINDOW_MS = 24 * 3600_000;

export const SP = {
  system: '11111111111111111111111111111111', token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', token22: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', budget: 'ComputeBudget111111111111111111111111111111', wsol: 'So11111111111111111111111111111111111111112',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', pamm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  recentBlockhashes: 'SysvarRecentB1ockHashes11111111111111111111', rent: 'SysvarRent111111111111111111111111111111111',
};
export const JITO_TIP_ACCOUNTS = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'];
// the venue instructions a variant may carry (src/solEngine.ts DISC)
export const SOL_DISC = { buyV3: [225, 247, 80, 30, 213, 179, 132, 136], sellV3: [28, 146, 222, 119, 38, 196, 105, 213], ammBuy: [194, 171, 28, 70, 104, 77, 91, 47], ammSell: [93, 246, 130, 60, 231, 233, 64, 178] };
export type SolVenue = 'pump' | 'pumpswap';

// ── bytes ──
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58e(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; }
export function b58d(s: string): Uint8Array { let n = 0n; for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c !== '1') break; out.unshift(0); } return Uint8Array.from(out); }
const te = new TextEncoder();
export const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
export const u64le = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
export const u32le = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const rdU32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
const rdU64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
export const toB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── addresses ──
const onCurve = (b: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
export function pdaOf(seeds: Uint8Array[], program: string): string {
  const prog = b58d(program);
  for (let bump = 255; bump >= 0; bump--) { const h = sha256(cat(...seeds, Uint8Array.of(bump), prog, te.encode('ProgramDerivedAddress'))); if (!onCurve(h)) return b58e(h); }
  throw new Error('no PDA');
}
export const ataAddress = (owner: string, mint: string, tokenProgram: string) => pdaOf([b58d(owner), b58d(tokenProgram), b58d(mint)], SP.ata);
/** System createWithSeed: sha256(base ‖ seed ‖ owner) — no curve check */
export const withSeed = (base: string, seed: string, owner: string) => b58e(sha256(cat(b58d(base), te.encode(seed), b58d(owner))));
export const nonceAddressOf = (orderWallet: string) => withSeed(orderWallet, SOL_NONCE_SEED, SP.system);

// ── keys (run where the main seed lives; results go straight into a signer) ──
const mac = (seed: Uint8Array, message: string) => { if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Bad wallet seed'); return hmac(sha256, seed, te.encode(message)); };
export const solOrderIdMessage = (index: number) => `motion/limit-order-id/v1\n${SOL_LIMIT_CHAIN}\n${index}`;
export const solOrderKeyMessage = (orderId: string) => `motion/limit-order/v1\n${SOL_LIMIT_CHAIN}\n${orderId}`;
/** the public order id at `index` of a main wallet: the first 16 bytes of HMAC(main seed, solOrderIdMessage) */
export function solOrderIdOf(mainSeed: Uint8Array, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Bad order index');
  const m = mac(mainSeed, solOrderIdMessage(index)); const id = hexOf(m.slice(0, 16)); m.fill(0); return id;
}
/** the order wallet's 32-byte ed25519 seed (never stored, posted or shown) and its address */
export function solOrderKeys(mainSeed: Uint8Array, orderId: string): { seed: Uint8Array; address: string } {
  if (!SOL_ORDER_ID.test(orderId)) throw new Error('Bad order id');
  const seed = mac(mainSeed, solOrderKeyMessage(orderId));
  return { seed, address: b58e(ed25519.getPublicKey(seed)) };
}

// ── instructions (the vault compiles them with src/solEngine.ts compileLegacy) ──
export type SolIx = { program: string; keys: { pubkey: string; signer: boolean; writable: boolean }[]; data: Uint8Array };
const ixOf = (program: string, keys: [string, boolean, boolean][], data: Uint8Array): SolIx => ({ program, keys: keys.map(([pubkey, signer, writable]) => ({ pubkey, signer, writable })), data });
export const sysTransfer = (from: string, to: string, lamports: bigint) => ixOf(SP.system, [[from, true, true], [to, false, true]], cat(u32le(2), u64le(lamports)));
/** the nonce account: created with seed from the order wallet (it pays the rent) and initialised with it as authority */
export function nonceCreateIxs(orderWallet: string): SolIx[] {
  const n = nonceAddressOf(orderWallet); const seed = te.encode(SOL_NONCE_SEED);
  return [
    ixOf(SP.system, [[orderWallet, true, true], [n, false, true]], cat(u32le(3), b58d(orderWallet), u64le(BigInt(seed.length)), seed, u64le(SOL_NONCE_RENT), u64le(BigInt(SOL_NONCE_SPACE)), b58d(SP.system))),
    ixOf(SP.system, [[n, false, true], [SP.recentBlockhashes, false, false], [SP.rent, false, false]], cat(u32le(6), b58d(orderWallet))),
  ];
}
export const nonceAdvanceIx = (orderWallet: string) => ixOf(SP.system, [[nonceAddressOf(orderWallet), false, true], [SP.recentBlockhashes, false, false], [orderWallet, true, false]], u32le(4));
export const nonceWithdrawIx = (orderWallet: string, to: string, lamports: bigint) => ixOf(SP.system, [[nonceAddressOf(orderWallet), false, true], [to, false, true], [SP.recentBlockhashes, false, false], [SP.rent, false, false], [orderWallet, true, false]], cat(u32le(5), u64le(lamports)));
/** an initialised nonce account owned by the System program with this authority → its current value (the blockhash to sign with) */
export function nonceValueOf(data: Uint8Array, owner: string, authority: string): string | null {
  if (owner !== SP.system || data.length !== SOL_NONCE_SPACE) return null;
  if (rdU32(data, 4) !== 1) return null;   // state: initialized
  if (b58e(data.subarray(8, 40)) !== authority) return null;
  return b58e(data.subarray(40, 72));
}
export const ataCreateIdem = (payer: string, owner: string, mint: string, tokenProgram: string) => ixOf(SP.ata, [[payer, true, true], [ataAddress(owner, mint, tokenProgram), false, true], [owner, false, false], [mint, false, false], [SP.system, false, false], [tokenProgram, false, false]], Uint8Array.of(1));
export const tokenTransferChecked = (owner: string, mint: string, to: string, units: bigint, decimals: number, tokenProgram: string) =>
  ixOf(tokenProgram, [[ataAddress(owner, mint, tokenProgram), false, true], [mint, false, false], [ataAddress(to, mint, tokenProgram), false, true], [owner, true, false]], cat(Uint8Array.of(12), u64le(units), Uint8Array.of(decimals)));
export const tokenClose = (account: string, dest: string, owner: string, tokenProgram: string) => ixOf(tokenProgram, [[account, false, true], [dest, false, true], [owner, true, false]], Uint8Array.of(9));
/** the payout that ends every variant: the floor to the main wallet, inside the same transaction */
export function payoutIxs(o: { side: 'buy' | 'sell'; orderWallet: string; main: string; mint: string; tokenProgram: string; decimals: number; minOut: bigint }): SolIx[] {
  if (o.side === 'buy') return [ataCreateIdem(o.orderWallet, o.main, o.mint, o.tokenProgram), tokenTransferChecked(o.orderWallet, o.mint, o.main, o.minOut, o.decimals, o.tokenProgram)];
  return [sysTransfer(o.orderWallet, o.main, o.minOut)];
}

// ── prices and floors (price = SOL per ONE whole token, a plain decimal string) ──
export function parseDecimal(s: unknown, what = 'price'): { num: bigint; den: bigint } {
  const m = /^(\d{1,20})(?:\.(\d{1,24}))?$/.exec(String(s ?? ''));
  if (!m) throw new Error(`Bad ${what}: a plain decimal string`);
  const frac = m[2] || ''; const num = BigInt(m[1] + frac), den = 10n ** BigInt(frac.length);
  if (num <= 0n) throw new Error(`Bad ${what}: must be above 0`);
  return { num, den };
}
export function toUnits(s: unknown, decimals: number, what = 'amount'): bigint {
  const m = /^(\d{1,30})(?:\.(\d{1,36}))?$/.exec(String(s ?? ''));
  if (!m) throw new Error(`Bad ${what}: a plain decimal string`);
  const frac = m[2] || ''; if (frac.length > decimals) throw new Error(`Bad ${what}: more than ${decimals} decimals`);
  const v = BigInt(m[1] + frac.padEnd(decimals, '0')); if (v <= 0n) throw new Error(`Bad ${what}: must be above 0`);
  return v;
}
export function fromUnits(v: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals); const i = v / d, f = v % d;
  const fs = decimals ? f.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return i.toString() + (fs ? '.' + fs : '');
}
/** buy (lamports in): tokens ≥ in × (1 − fee) / price × (1 − slip); sell (token units in): lamports ≥ in × price × (1 − fee) × (1 − slip) */
export function solMinOut(o: { side: 'buy' | 'sell'; amountIn: bigint; price: string; decimals: number; slippageBps: number; feeBps?: number }): bigint {
  const { num, den } = parseDecimal(o.price);
  const slip = BigInt(o.slippageBps); if (slip < BigInt(SOL_SLIP_MIN_BPS) || slip > BigInt(SOL_SLIP_MAX_BPS)) throw new Error('Slippage out of range');
  const fee = BigInt(o.feeBps ?? SOL_VENUE_FEE_BPS);
  const keep = (10_000n - fee) * (10_000n - slip); const scale = 10n ** BigInt(o.decimals);
  const out = o.side === 'buy' ? (o.amountIn * den * scale * keep) / (num * 1_000_000_000n * 100_000_000n) : (o.amountIn * num * 1_000_000_000n * keep) / (den * scale * 100_000_000n);
  if (out <= 0n) throw new Error('The limit price leaves nothing to receive');
  return out;
}
export const solNotional = (amountIn: bigint, price: string, decimals: number) => { const { num, den } = parseDecimal(price); return (amountIn * num * 1_000_000_000n) / (den * 10n ** BigInt(decimals)); };
export function solTriggerHit(kind: string, price: string, markSol: number): boolean {
  const p = Number(price); if (!(markSol > 0) || !(p > 0)) return false;
  return kind === 'tp' ? markSol >= p : (kind === 'limit' || kind === 'sl') ? markSol <= p : false;
}

// ── a legacy transaction, read back ──
export type ParsedIx = { program: string; accounts: string[]; data: Uint8Array };
export type ParsedTx = { sigs: Uint8Array[]; message: Uint8Array; header: [number, number, number]; keys: string[]; blockhash: string; ixs: ParsedIx[] };
function readCompact(d: Uint8Array, o: { i: number }): number { let v = 0, s = 0; for (;;) { if (o.i >= d.length) throw new Error('truncated'); const b = d[o.i++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7; if (s > 21) throw new Error('bad length'); } }
export function parseLegacyTx(tx: Uint8Array): ParsedTx {
  const o = { i: 0 }; const n = readCompact(tx, o); if (n < 1 || n > 4) throw new Error('bad signatures');
  const sigs: Uint8Array[] = []; for (let k = 0; k < n; k++) { sigs.push(tx.slice(o.i, o.i + 64)); o.i += 64; }
  const message = tx.slice(o.i); const m = { i: 0 };
  if (message[0] & 0x80) throw new Error('not a legacy message');
  const header: [number, number, number] = [message[0], message[1], message[2]]; m.i = 3;
  const kc = readCompact(message, m); const keys: string[] = []; for (let k = 0; k < kc; k++) { keys.push(b58e(message.slice(m.i, m.i + 32))); m.i += 32; }
  const blockhash = b58e(message.slice(m.i, m.i + 32)); m.i += 32;
  const ic = readCompact(message, m); const ixs: ParsedIx[] = [];
  for (let k = 0; k < ic; k++) {
    const p = message[m.i++]; const ac = readCompact(message, m); const accounts: string[] = [];
    for (let a = 0; a < ac; a++) { const idx = message[m.i++]; if (idx >= keys.length) throw new Error('bad account index'); accounts.push(keys[idx]); }
    const dl = readCompact(message, m); const data = message.slice(m.i, m.i + dl); m.i += dl;
    if (p >= keys.length || data.length !== dl) throw new Error('truncated');
    ixs.push({ program: keys[p], accounts, data });
  }
  if (m.i !== message.length) throw new Error('trailing bytes');
  return { sigs, message, header, keys, blockhash, ixs };
}
export const txSignature = (tx: Uint8Array) => b58e(parseLegacyTx(tx).sigs[0]);

// ── what the vault posts and the keeper keeps ──
export type SolSignedTx = { venue: SolVenue; raw: string };   // raw = base64 of the signed transaction
export type PostedSolOrder = {
  v: 1; id: string; chain: 'sol'; wallet: string; orderWallet: string; nonce: string; nonceValue: string; token: string; tokenProgram: string; symbol: string; decimals: number;
  side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; amountIn: string; minOut: Partial<Record<SolVenue, string>>; slippageBps: number; expiry: number; createdAt: number; txs: SolSignedTx[];
};
export function solOrderDigest(o: PostedSolOrder): string {
  const c = [o.v, o.id, o.chain, o.wallet, o.orderWallet, o.nonce, o.nonceValue, o.token, o.tokenProgram, o.symbol, o.decimals, o.side, o.kind, o.price, o.amount, o.amountIn,
    Object.keys(o.minOut).sort().map((k) => [k, o.minOut[k as SolVenue]]), o.slippageBps, o.expiry, o.createdAt, o.txs.map((t) => [t.venue, t.raw])];
  return hexOf(sha256(te.encode(JSON.stringify(c))));
}
export const SOL_AUTH_HEAD = 'motion limit orders v1';
export type SolAuthAction = 'place' | 'cancel' | 'read';
export function solAuthText(a: { action: SolAuthAction; wallet: string; at: number; id?: string; orderWallet?: string; digest?: string }): string {
  const lines = [SOL_AUTH_HEAD, `action: ${a.action}`, `chain: ${SOL_LIMIT_CHAIN}`, `wallet: ${a.wallet}`];
  if (a.action !== 'read') lines.push(`order: ${a.id}`);
  if (a.action === 'place') lines.push(`order wallet: ${a.orderWallet}`, `digest: ${a.digest}`);
  lines.push(`at: ${a.at}`);
  return lines.join('\n');
}
/** why a text is not one of the three Solana auth texts of this wallet ('' = fine): the vault signs nothing else for our server */
export function solAuthTextProblem(text: string, wallet: string): string {
  if (typeof text !== 'string' || text.length > 600) return 'not a limit-order text';
  const m = /^motion limit orders v1\naction: (place|cancel|read)\nchain: sol\nwallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\n(?:order: ([0-9a-f]{32})\n(?:order wallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\ndigest: ([0-9a-f]{64})\n)?)?at: (\d{13})$/.exec(text);
  if (!m) return 'not a limit-order text';
  if (m[2] !== wallet) return 'another wallet';
  if (m[1] === 'read' && m[3]) return 'not a limit-order text';
  if (m[1] === 'cancel' && (!m[3] || m[4])) return 'not a limit-order text';
  if (m[1] === 'place' && !(m[3] && m[4] && m[5])) return 'not a limit-order text';
  return '';
}
/** the main wallet's ed25519 signature (hex) over an auth text */
export function solAuthVerify(text: string, sigHex: string, wallet: string): boolean {
  try { if (!/^[0-9a-f]{128}$/.test(sigHex)) return false; return ed25519.verify(Uint8Array.from(sigHex.match(/../g)!.map((h) => parseInt(h, 16))), te.encode(text), b58d(wallet)); } catch { return false; }
}

/**
 * The keeper's check of a posted order. Exact fields; every variant a legacy transaction signed ONLY by the order wallet
 * (valid signature, fee payer = the order wallet), its blockhash = the order's nonce value, its first instruction the
 * nonce advance by the order wallet, nothing but System / ComputeBudget / ATA / Token / Token-2022 / pump / PumpSwap
 * instructions of the shapes below, the venue's swap with the order's amount and its floor, and the floor paid to the
 * main wallet. Compute, priority and tip within bounds. Returns the signatures by venue.
 */
/** fee-sprint bypass (default off): the keeper's terminal-fee rule. null = the rule of before (a transfer to the collector is an
 *  unexpected account). minBps = the lowest rate the server grants this wallet; required = a variant without it is refused. */
export type SolFeePolicy = { collector: string; minBps: number; required: boolean };
export const SOL_FEE_MAX_BPS = 20;
export function checkSolPosted(o: unknown, now: number, feePolicy: SolFeePolicy | null = null): { order: PostedSolOrder; sigs: Record<string, SolVenue>; need: { lamports: bigint; token: bigint } } {
  const bad = (why: string): never => { throw Object.assign(new Error(why), { status: 400 }); };
  const r = o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : bad('bad order');
  const keys = ['v', 'id', 'chain', 'wallet', 'orderWallet', 'nonce', 'nonceValue', 'token', 'tokenProgram', 'symbol', 'decimals', 'side', 'kind', 'price', 'amount', 'amountIn', 'minOut', 'slippageBps', 'expiry', 'createdAt', 'txs'];
  for (const k of Object.keys(r)) if (!keys.includes(k)) bad('unknown field ' + k.slice(0, 20));
  if (r.v !== 1 || r.chain !== SOL_LIMIT_CHAIN || !SOL_ORDER_ID.test(String(r.id))) bad('bad order');
  for (const k of ['wallet', 'orderWallet', 'nonce', 'nonceValue', 'token']) if (!SOL_ADDR.test(String(r[k]))) bad('bad ' + k);
  const wallet = String(r.wallet), ow = String(r.orderWallet), mint = String(r.token);
  if (wallet === ow) bad('bad order wallet');
  if (r.nonce !== nonceAddressOf(ow)) bad('the nonce is not the order wallet\'s');
  if (r.tokenProgram !== SP.token && r.tokenProgram !== SP.token22) bad('bad token program');
  const tp = String(r.tokenProgram);
  if (typeof r.symbol !== 'string' || r.symbol.length > 24) bad('bad symbol');
  if (!Number.isInteger(r.decimals) || (r.decimals as number) < 0 || (r.decimals as number) > 18) bad('bad decimals');
  const side = r.side, kind = r.kind;
  if (!((side === 'buy' && kind === 'limit') || (side === 'sell' && (kind === 'tp' || kind === 'sl')))) bad('bad side / kind');
  try { parseDecimal(r.price); } catch { bad('bad price'); }
  if (typeof r.amount !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(r.amount) || typeof r.amountIn !== 'string' || !/^\d{1,20}$/.test(r.amountIn)) bad('bad amount');
  const amountIn = BigInt(r.amountIn as string);
  if (!Number.isInteger(r.slippageBps) || (r.slippageBps as number) < SOL_SLIP_MIN_BPS || (r.slippageBps as number) > SOL_SLIP_MAX_BPS) bad('bad slippage');
  const mo = r.minOut && typeof r.minOut === 'object' && !Array.isArray(r.minOut) ? r.minOut as Record<string, unknown> : bad('bad minOut');
  for (const [k, v] of Object.entries(mo)) if (!['pump', 'pumpswap'].includes(k) || typeof v !== 'string' || !/^\d{1,20}$/.test(v) || BigInt(v) <= 0n) bad('bad minOut');
  if (!Number.isSafeInteger(r.expiry) || !Number.isSafeInteger(r.createdAt)) bad('bad expiry');
  if ((r.expiry as number) - now < SOL_MIN_EXPIRY_S * 1000 - 15 * 60_000 || (r.expiry as number) - (r.createdAt as number) > SOL_MAX_EXPIRY_S * 1000 + 60_000 || (r.createdAt as number) > now + 120_000) bad('expiry must be 1 h to 7 d away');
  const txs = Array.isArray(r.txs) ? r.txs : bad('bad txs');
  if (!txs.length || txs.length > 2) bad('bad txs');
  const size = side === 'buy' ? amountIn : solNotional(amountIn, String(r.price), r.decimals as number);
  if (size < SOL_MIN_SIZE) bad('below the 0.05 SOL minimum');
  const sigs: Record<string, SolVenue> = {}; const seen = new Set<string>(); const out: SolSignedTx[] = [];
  const owAta = ataAddress(ow, mint, tp), mainAta = ataAddress(wallet, mint, tp), owWsol = ataAddress(ow, SP.wsol, SP.token);
  let needLamports = 0n;
  for (const t of txs) {
    const x = t && typeof t === 'object' ? t as Record<string, unknown> : bad('bad tx');
    for (const k of Object.keys(x)) if (!['venue', 'raw'].includes(k)) bad('bad tx');
    const venue = String(x.venue) as SolVenue;
    if (!['pump', 'pumpswap'].includes(venue) || seen.has(venue) || !(venue in mo)) bad('bad venue'); seen.add(venue);
    if (typeof x.raw !== 'string' || x.raw.length > 2000 || !/^[A-Za-z0-9+/]+=*$/.test(x.raw)) bad('bad raw tx');
    let bytes: Uint8Array; let p: ParsedTx;
    try { bytes = fromB64(x.raw as string); p = parseLegacyTx(bytes); } catch { return bad('unreadable tx'); }
    if (bytes.length > SOL_MAX_TX_BYTES) bad('tx too large');
    if (p.sigs.length !== 1 || p.header[0] !== 1 || p.keys[0] !== ow) bad('a variant must be signed by the order wallet alone');
    if (!ed25519.verify(p.sigs[0], p.message, b58d(ow))) bad('a variant is not signed by the order wallet');
    if (p.blockhash !== r.nonceValue) bad('a variant is not on the order\'s nonce');
    const [first, ...rest] = p.ixs;
    if (!first || first.program !== SP.system || !same(first.data, u32le(4)) || first.accounts[0] !== r.nonce || first.accounts[1] !== SP.recentBlockhashes || first.accounts[2] !== ow) bad('the first instruction must advance the order\'s nonce');
    const floor = BigInt(mo[venue] as string);
    let swaps = 0, paid = false, units = 200_000, micro = 0, tip = 0n, toWsol = 0n, feePaid = 0n, feeIxs = 0;
    for (const ix of rest) {
      if (ix.program === SP.budget) {
        if (ix.data[0] === 2 && ix.data.length === 5) units = rdU32(ix.data, 1);
        else if (ix.data[0] === 3 && ix.data.length === 9) micro = Number(rdU64(ix.data, 1));
        else bad('bad compute budget instruction');
      } else if (ix.program === SP.system) {
        if (!(ix.data.length === 12 && rdU32(ix.data, 0) === 2) || ix.accounts[0] !== ow) bad('only transfers from the order wallet');
        const to = ix.accounts[1], lamports = rdU64(ix.data, 4);
        if (to === wallet && side === 'sell') { if (lamports !== floor || paid) bad('the payout must be exactly the floor, once'); paid = true; }
        else if (to === owWsol && side === 'buy' && venue === 'pumpswap') toWsol += lamports;
        else if (JITO_TIP_ACCOUNTS.includes(to)) tip += lamports;
        else if (feePolicy && to === feePolicy.collector) { feePaid += lamports; feeIxs += 1; }
        else bad('a transfer to an unexpected account');
      } else if (ix.program === SP.ata) {
        if (!(ix.data.length === 1 && ix.data[0] === 1) || ix.accounts[0] !== ow || ![ow, wallet].includes(ix.accounts[2])) bad('bad token-account instruction');
      } else if (ix.program === SP.token || ix.program === SP.token22) {
        const op = ix.data[0];
        if (op === 17 && ix.program === SP.token && ix.accounts[0] === owWsol) { /* sync_native of the order wallet's wSOL */ }
        else if (op === 9 && ix.accounts[1] === ow && ix.accounts[2] === ow) { /* close an order-wallet account back to it */ }
        else if (op === 12 && side === 'buy' && ix.program === tp && ix.data.length === 10 && ix.accounts[0] === owAta && ix.accounts[1] === mint && ix.accounts[2] === mainAta && ix.accounts[3] === ow) {
          if (rdU64(ix.data, 1) !== floor || ix.data[9] !== r.decimals || paid) bad('the payout must be exactly the floor, once'); paid = true;
        } else bad('a token instruction outside the payout');
      } else if (ix.program === SP.pump || ix.program === SP.pamm) {
        const disc = Array.from(ix.data.slice(0, 8));
        const want = venue === 'pump' ? (side === 'buy' ? SOL_DISC.buyV3 : SOL_DISC.sellV3) : (side === 'buy' ? SOL_DISC.ammBuy : SOL_DISC.ammSell);
        if ((venue === 'pump') !== (ix.program === SP.pump) || disc.join() !== want.join() || ix.data.length < 24) bad('the swap is not this venue\'s');
        if (rdU64(ix.data, 8) !== amountIn) bad('the swap does not spend the order\'s amount');
        if (rdU64(ix.data, 16) !== floor) bad('the swap\'s own minimum must be the floor');   // the payout after it can then never fail
        if (!ix.accounts.includes(ow) || !ix.accounts.includes(mint)) bad('the swap is not the order wallet\'s on this coin');
        swaps += 1;
      } else bad('a program a limit order does not use');
    }
    if (swaps !== 1) bad('exactly one swap per variant');
    if (!paid) bad('the variant does not pay the main wallet its floor');
    if (units > SOL_MAX_UNITS || micro > SOL_MAX_MICRO || tip > SOL_MAX_TIP) bad('compute, priority or tip out of range');
    if (toWsol !== 0n && toWsol !== amountIn) bad('the wrapped SOL must be the order\'s amount');
    if (feePolicy) {
      // (review 2026-11-09) bounds floored exactly like the vault's feeOf (an exact-rate comparison refused almost every real basis).
      // The basis stays this variant's own floor: a minOut entry without a variant can never lower it (the vault's floors are equal)
      const basis = side === 'buy' ? amountIn : floor;
      if (feeIxs > 1) bad('one fee transfer per variant');
      if (feeIxs === 1 && (feePaid < (basis * BigInt(feePolicy.minBps)) / 10_000n || feePaid > (basis * BigInt(SOL_FEE_MAX_BPS)) / 10_000n)) bad('the fee is not the rate of this wallet');
      if (feeIxs === 0 && feePolicy.required && (basis * BigInt(feePolicy.minBps)) / 10_000n > 0n) bad('this order carries no terminal fee');
    }
    const cost = 5_000n + (BigInt(units) * BigInt(micro)) / 1_000_000n + tip + feePaid + (side === 'buy' ? amountIn : 0n);
    if (cost > needLamports) needLamports = cost;
    sigs[b58e(p.sigs[0])] = venue;
    out.push({ venue, raw: x.raw as string });
  }
  const order = { ...(r as unknown as PostedSolOrder), txs: out };
  return { order, sigs, need: { lamports: needLamports, token: side === 'sell' ? amountIn : 0n } };
}

// ── the vault's argument allow-lists ──
const WID = /^[A-Za-z0-9_.:-]{1,80}$/, IDEM = /^[A-Za-z0-9_.:-]{8,100}$/;
function shape(o: unknown, allowed: string[], required: string[]) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one object');
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!allowed.includes(k)) throw new Error('Bad arguments: unknown field ' + k.slice(0, 20));
  for (const k of required) if (r[k] == null || r[k] === '') throw new Error('Bad arguments: ' + k + ' is required');
  if (r.walletId != null && !WID.test(String(r.walletId))) throw new Error('Bad arguments: walletId');
  if (r.idempotencyKey != null && !IDEM.test(String(r.idempotencyKey))) throw new Error('Bad arguments: idempotencyKey');
  if (r.orderId != null && !SOL_ORDER_ID.test(String(r.orderId))) throw new Error('Bad arguments: orderId');
  if (r.token != null && !SOL_ADDR.test(String(r.token))) throw new Error('Bad arguments: token');
  return r;
}
export type SolPlaceArgs = { walletId: string; token: string; side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; slippageBps: number; expiresIn: number; idempotencyKey: string };
export const solLimitArgs = {
  place(o: unknown): SolPlaceArgs {
    const r = shape(o, ['walletId', 'token', 'side', 'kind', 'price', 'amount', 'slippageBps', 'expiresIn', 'route', 'idempotencyKey'], ['walletId', 'token', 'side', 'kind', 'price', 'amount', 'expiresIn', 'idempotencyKey']);
    if (!((r.side === 'buy' && r.kind === 'limit') || (r.side === 'sell' && (r.kind === 'tp' || r.kind === 'sl')))) throw new Error('Bad arguments: side / kind (buy + limit, sell + tp | sl)');
    parseDecimal(r.price);
    if (typeof r.amount !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(r.amount)) throw new Error('Bad arguments: amount (a decimal string)');
    const slippageBps = r.slippageBps == null ? SOL_SLIP_DEFAULT_BPS : Number(r.slippageBps);
    if (!Number.isInteger(slippageBps) || slippageBps < SOL_SLIP_MIN_BPS || slippageBps > SOL_SLIP_MAX_BPS) throw new Error(`Bad arguments: slippageBps (${SOL_SLIP_MIN_BPS}–${SOL_SLIP_MAX_BPS})`);
    if (!Number.isInteger(r.expiresIn) || (r.expiresIn as number) < SOL_MIN_EXPIRY_S || (r.expiresIn as number) > SOL_MAX_EXPIRY_S) throw new Error('Bad arguments: expiresIn (3600–604800 seconds)');
    // `route` (the page's hint) is accepted and ignored: the vault reads the coin's market itself (src/solEngine.ts solRoute)
    return { walletId: String(r.walletId), token: String(r.token), side: r.side as 'buy' | 'sell', kind: r.kind as SolPlaceArgs['kind'], price: String(r.price), amount: String(r.amount), slippageBps, expiresIn: r.expiresIn as number, idempotencyKey: String(r.idempotencyKey) };
  },
  cancel(o: unknown) { const r = shape(o, ['walletId', 'orderId', 'token', 'swapNonce', 'idempotencyKey'], ['walletId', 'orderId', 'idempotencyKey']); return { walletId: String(r.walletId), orderId: String(r.orderId), ...(r.token ? { token: String(r.token) } : {}), idempotencyKey: String(r.idempotencyKey) }; },
  sweep(o: unknown) { const r = shape(o, ['walletId', 'orderId', 'token', 'swapNonce', 'idempotencyKey'], ['walletId', 'orderId']); return { walletId: String(r.walletId), orderId: String(r.orderId), ...(r.token ? { token: String(r.token) } : {}), ...(r.idempotencyKey ? { idempotencyKey: String(r.idempotencyKey) } : {}) }; },
  list(o: unknown) { const r = shape(o ?? {}, ['walletId'], []); return r.walletId ? { walletId: String(r.walletId) } : {}; },
};
