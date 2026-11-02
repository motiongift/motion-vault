// motion's own instant cross-chain bridge — the PURE core, shared byte for byte by the vault (src/bridgeSolver.ts) and
// the solver (trench server/motion-bridge.mjs). Design: trench docs/drafts/MOTION-BRIDGE.md.
//
// The model in one paragraph: the user's money never leaves their own key's wallets except by their own signature, for
// exactly the amount a signed quote names. The vault asks the solver for a quote (source chain + stablecoin + amount →
// destination chain + native amount, recipient = the SAME key's trading wallet W on the destination chain, expiry,
// nonce), checks the quote's ed25519 signature against a public key pinned in the engine, pre-signs the source transfer
// (R → the solver's published deposit address, exactly the quoted amount) and hands the solver the RAW SIGNED bytes.
// The solver re-checks those bytes against its own quote, broadcasts them, and pays the destination native to W as soon
// as the source transaction is INCLUDED. If it cannot pay, it refunds the source amount to R. Nothing here keeps a key,
// reads a clock or touches the network: both sides run the same functions, so what the tests prove is what runs.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

// ── chains ──
export type BridgeChain = 'robinhood' | 'bsc' | 'sol';
export const BRIDGE_CHAINS: BridgeChain[] = ['robinhood', 'bsc', 'sol'];
export type BridgeChainCfg = {
  key: BridgeChain; kind: 'evm' | 'sol'; chainId: number; native: string; nativeDecimals: number;
  stable: { address: string; symbol: string; decimals: number };
  // the pool the USD price of the native coin is read from (never swapped through): a V3 pool on EVM (slot0), a
  // Meteora DLMM pool on Solana (active bin). The same pools floatCore.ts uses, so the vault and the solver agree.
  oracle: { pool: string; nativeIsToken0: boolean; stableDecimals: number; kind: 'v3' | 'dlmm' };
  // how long inclusion normally takes, and the longest we wait before the fill is given up and refunded
  inclusionMs: number; inclusionTimeoutMs: number;
};
export const BRIDGE_CFG: Record<BridgeChain, BridgeChainCfg> = {
  robinhood: {
    key: 'robinhood', kind: 'evm', chainId: 4663, native: 'ETH', nativeDecimals: 18,
    stable: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
    oracle: { pool: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', nativeIsToken0: true, stableDecimals: 6, kind: 'v3' },
    inclusionMs: 250, inclusionTimeoutMs: 8_000,
  },
  bsc: {
    key: 'bsc', kind: 'evm', chainId: 56, native: 'BNB', nativeDecimals: 18,
    stable: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
    oracle: { pool: '0x36696169c63e42cd08ce11f5deebbcebae652050', nativeIsToken0: false, stableDecimals: 18, kind: 'v3' },
    inclusionMs: 750, inclusionTimeoutMs: 12_000,
  },
  sol: {
    key: 'sol', kind: 'sol', chainId: 0, native: 'SOL', nativeDecimals: 9,
    stable: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    oracle: { pool: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y', nativeIsToken0: true, stableDecimals: 6, kind: 'dlmm' },
    inclusionMs: 400, inclusionTimeoutMs: 15_000,
  },
};
export const bridgeCfg = (c: BridgeChain): BridgeChainCfg => {
  const cfg = BRIDGE_CFG[c]; if (!cfg) throw new Error('motion bridge: unknown chain ' + String(c).slice(0, 20));
  return cfg;
};

// ── money ──
export const USD6 = 1_000_000n;
const pow10 = (n: number) => 10n ** BigInt(n);
export const stableToUsd6 = (raw: bigint, decimals: number): bigint => (decimals >= 6 ? raw / pow10(decimals - 6) : raw * pow10(6 - decimals));
export const usd6ToStable = (u: bigint, decimals: number): bigint => (decimals >= 6 ? u * pow10(decimals - 6) : u / pow10(6 - decimals));
export const nativeToUsd6 = (raw: bigint, price6: bigint, decimals: number): bigint => (raw * price6) / pow10(decimals);
export const usd6ToNative = (u: bigint, price6: bigint, decimals: number): bigint => (price6 > 0n ? (u * pow10(decimals)) / price6 : 0n);
// a Uniswap-V3-style pool's slot0 → micro-dollars for one whole native coin
export function v3Price6(sqrtPriceX96: bigint, o: { nativeIsToken0: boolean; stableDecimals: number }, nativeDecimals = 18): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const Q192 = 1n << 192n; const sq = sqrtPriceX96 * sqrtPriceX96;
  const stableRaw = o.nativeIsToken0 ? (pow10(nativeDecimals) * sq) / Q192 : (pow10(nativeDecimals) * Q192) / sq;
  return stableToUsd6(stableRaw, o.stableDecimals);
}
// a Meteora DLMM pool's active bin → micro-dollars for one whole SOL (the same maths as src/solEngine.ts dlmmPrice)
const U128 = (1n << 128n) - 1n, Q64 = 1n << 64n;
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
export const dlmmPrice = (binId: number, binStep: number) => dlmmPow(Q64 + ((BigInt(binStep) << 64n) / 10_000n), binId);
/** the SOL price in micro-dollars from the pinned DLMM pool's account bytes (solIsX: SOL is token X) */
export function dlmmPrice6(data: Uint8Array, solIsX: boolean): bigint {
  if (!data || data.length < 904) return 0n;
  const dv = new DataView(data.buffer, data.byteOffset);
  const activeId = dv.getInt32(76, true), binStep = dv.getUint16(80, true);
  const p = dlmmPrice(activeId, binStep); if (p === null || p <= 0n) return 0n;
  return solIsX ? (p * 1_000_000_000n) >> 64n : (1_000_000_000n << 64n) / p;
}

// ── the quote ──
export const QUOTE_DOMAIN = 'motion-bridge/quote/v1';
export const QUOTE_ID = /^[0-9a-f]{32}$/;
export const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const SOL_ADDR58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type Quote = {
  v: 1; id: string;
  src: { chain: BridgeChain; token: string; amount: string; depositor: string; deposit: string };
  dst: { chain: BridgeChain; recipient: string; amount: string };
  price6: string;        // the destination native's USD price the solver quoted at
  fee6: string;          // what motion keeps on this fill, micro-dollars (0 today)
  usd6: string;          // the source amount in micro-dollars
  issuedAt: number; expiresAt: number;
  solver: string;        // the quote-signing public key (hex ed25519), pinned in the vault
};
const te = new TextEncoder();
export const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
/** the exact bytes that are signed: a fixed order, never JSON key order, never a field the other side cannot see */
export function quoteMessage(q: Quote): Uint8Array {
  const parts = [
    QUOTE_DOMAIN, String(q.v), q.id,
    q.src.chain, String(q.src.token).toLowerCase(), q.src.amount, String(q.src.depositor).toLowerCase(), String(q.src.deposit).toLowerCase(),
    q.dst.chain, String(q.dst.recipient).toLowerCase(), q.dst.amount,
    q.price6, q.fee6, q.usd6, String(q.issuedAt), String(q.expiresAt), q.solver.toLowerCase(),
  ];
  return te.encode(parts.join('\n'));
}
export const signQuote = (q: Quote, seed: Uint8Array): string => hexOf(ed25519.sign(quoteMessage(q), seed));
export function verifyQuoteSig(q: Quote, sigHex: string, pubHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(String(sigHex)) || !/^[0-9a-f]{64}$/i.test(String(pubHex))) return false;
    if (String(q.solver).toLowerCase() !== String(pubHex).toLowerCase()) return false;
    return ed25519.verify(unhex(sigHex), quoteMessage(q), unhex(pubHex));
  } catch { return false; }
}
/** a quote's shape, before anything else looks at it (both sides run this on what the other sent) */
export function quoteShapeProblem(o: unknown): string {
  const q = o as Quote;
  if (!q || typeof q !== 'object' || Array.isArray(q)) return 'not a quote';
  if (q.v !== 1 || !QUOTE_ID.test(String(q.id))) return 'not a quote';
  const keys = ['v', 'id', 'src', 'dst', 'price6', 'fee6', 'usd6', 'issuedAt', 'expiresAt', 'solver'];
  for (const k of Object.keys(q)) if (!keys.includes(k)) return 'unknown field ' + k.slice(0, 20);
  if (!q.src || !q.dst || typeof q.src !== 'object' || typeof q.dst !== 'object') return 'not a quote';
  for (const k of Object.keys(q.src)) if (!['chain', 'token', 'amount', 'depositor', 'deposit'].includes(k)) return 'unknown src field ' + k.slice(0, 20);
  for (const k of Object.keys(q.dst)) if (!['chain', 'recipient', 'amount'].includes(k)) return 'unknown dst field ' + k.slice(0, 20);
  if (!BRIDGE_CHAINS.includes(q.src.chain) || !BRIDGE_CHAINS.includes(q.dst.chain)) return 'unknown chain';
  if (q.src.chain === q.dst.chain) return 'same chain is not a bridge';
  const addrOk = (c: BridgeChain, a: string) => (bridgeCfg(c).kind === 'evm' ? EVM_ADDR.test(String(a)) : SOL_ADDR58.test(String(a)));
  if (!addrOk(q.src.chain, q.src.depositor) || !addrOk(q.src.chain, q.src.deposit)) return 'bad source address';
  if (!addrOk(q.dst.chain, q.dst.recipient)) return 'bad recipient';
  if (String(q.src.token).toLowerCase() !== String(bridgeCfg(q.src.chain).stable.address).toLowerCase()) return 'not the chain\'s stablecoin';
  for (const n of [q.src.amount, q.dst.amount, q.price6, q.fee6, q.usd6]) if (!/^[0-9]{1,40}$/.test(String(n))) return 'bad amount';
  if (!(BigInt(q.src.amount) > 0n) || !(BigInt(q.dst.amount) > 0n)) return 'bad amount';
  if (!Number.isInteger(q.issuedAt) || !Number.isInteger(q.expiresAt) || q.expiresAt <= q.issuedAt) return 'bad expiry';
  if (!/^[0-9a-f]{64}$/i.test(String(q.solver))) return 'bad solver key';
  return '';
}

// ── motion's risk bounds (the solver's own money) ──
export type BridgeCaps = {
  perFill6: bigint;        // the most one fill may carry
  minFill6: bigint;        // below this the public bridges are cheap enough
  perUserDay6: bigint;     // per user (their W address on the destination chain), rolling 24 h
  globalHour6: bigint;     // everyone together, rolling 60 min
  floor6: Record<BridgeChain, bigint>;   // inventory floor per chain: below it the quote is refused
  quoteTtlMs: number;      // how long a quote may be used
  maxOpenPerUser: number;  // quotes in flight per user
  feeBps: number;          // motion's fee on a fill (0 = the platform-fee-0 % promise)
};
export const DEFAULT_CAPS: BridgeCaps = {
  // owner 2026-10-27: "from 10 cents, let everyone trade through the bridge fast" — the only real limit is the inventory
  perFill6: 1_000n * USD6, minFill6: USD6 / 10n, perUserDay6: 50_000n * USD6, globalHour6: 250_000n * USD6,
  floor6: { robinhood: 10n * USD6, bsc: 10n * USD6, sol: 10n * USD6 },
  quoteTtlMs: 45_000, maxOpenPerUser: 2, feeBps: 0,
};
export const CAP_BOUNDS = {
  perFill6: [USD6, 5_000n * USD6], perUserDay6: [USD6, 50_000n * USD6], globalHour6: [USD6, 250_000n * USD6], feeBps: [0, 100],
} as const;
export function capsFromEnv(env: Record<string, string | undefined>, base: BridgeCaps = DEFAULT_CAPS): BridgeCaps {
  const num = (v: string | undefined, dflt: bigint, lo: bigint, hi: bigint): bigint => {
    if (v == null || v === '') return dflt;
    const n = Number(v); if (!Number.isFinite(n) || n <= 0) return dflt;
    const u = BigInt(Math.round(n * 1e6)); return u < lo ? lo : u > hi ? hi : u;
  };
  const caps: BridgeCaps = {
    ...base,
    perFill6: num(env.MOTION_BRIDGE_MAX_FILL_USD, base.perFill6, ...CAP_BOUNDS.perFill6),
    minFill6: num(env.MOTION_BRIDGE_MIN_FILL_USD, base.minFill6, USD6 / 100n, 100n * USD6),
    perUserDay6: num(env.MOTION_BRIDGE_USER_DAY_USD, base.perUserDay6, ...CAP_BOUNDS.perUserDay6),
    globalHour6: num(env.MOTION_BRIDGE_HOUR_USD, base.globalHour6, ...CAP_BOUNDS.globalHour6),
    floor6: { ...base.floor6 },
    feeBps: Math.max(CAP_BOUNDS.feeBps[0], Math.min(CAP_BOUNDS.feeBps[1], Math.round(Number(env.MOTION_BRIDGE_FEE_BPS ?? base.feeBps) || 0))),
  };
  for (const c of BRIDGE_CHAINS) {
    const v = env[`MOTION_BRIDGE_FLOOR_${c.toUpperCase()}_USD`];
    caps.floor6[c] = num(v, base.floor6[c], 0n, 100_000n * USD6);
  }
  if (caps.perFill6 > caps.perUserDay6) caps.perFill6 = caps.perUserDay6;
  return caps;
}
export type LedgerUse = { userDay6: bigint; globalHour6: bigint; openForUser: number };
/** why motion refuses to quote ('' = it will): the caps, the inventory floor and the kill switch, in that order */
export function quoteRefusal(a: {
  on: boolean; from: BridgeChain; to: BridgeChain; usd6: bigint; caps: BridgeCaps; use: LedgerUse;
  dstInventory6: bigint; dstPrice6: bigint; srcPrice6?: bigint; dstReserved6?: bigint;
}): string {
  if (!a.on) return 'off';
  if (a.from === a.to) return 'same chain';
  if (!BRIDGE_CHAINS.includes(a.from) || !BRIDGE_CHAINS.includes(a.to)) return 'unknown chain';
  if (!(a.dstPrice6 > 0n)) return 'no price for the destination chain';
  if (a.usd6 < a.caps.minFill6) return 'below the minimum fill';
  if (a.usd6 > a.caps.perFill6) return 'above the per-fill cap';
  if (a.use.userDay6 + a.usd6 > a.caps.perUserDay6) return 'above this wallet\'s daily cap';
  if (a.use.globalHour6 + a.usd6 > a.caps.globalHour6) return 'above the hourly cap';
  if (a.use.openForUser >= a.caps.maxOpenPerUser) return 'a fill of this wallet is already in flight';
  const left = a.dstInventory6 - (a.dstReserved6 ?? 0n) - a.usd6;
  if (left < a.caps.floor6[a.to]) return 'inventory floor on the destination chain';
  return '';
}
/** the destination native a quote pays: the source dollars, less motion's fee, at the solver's price */
export function quoteOut(usd6: bigint, price6: bigint, dst: BridgeChain, feeBps: number): { out: bigint; fee6: bigint } {
  const fee6 = (usd6 * BigInt(Math.max(0, Math.round(feeBps)))) / 10_000n;
  const net6 = usd6 - fee6;
  return { out: usd6ToNative(net6 > 0n ? net6 : 0n, price6, bridgeCfg(dst).nativeDecimals), fee6 };
}
/**
 * The vault's own check of a quote, against what IT asked for and ITS own oracle price — the solver's numbers are never
 * trusted. Everything here is refusable before a single byte of the user's money is signed.
 */
export function quoteProblem(q: Quote, sig: string, want: {
  pinnedSolver: string; from: BridgeChain; to: BridgeChain; amountIn: bigint; depositor: string; recipient: string;
  oracle6: bigint; maxSlipBps: number; maxFill6: bigint; now: number; deposits?: Partial<Record<BridgeChain, string>>;
}): string {
  const shape = quoteShapeProblem(q); if (shape) return shape;
  if (!verifyQuoteSig(q, sig, want.pinnedSolver)) return 'the quote is not signed by motion\'s solver key';
  if (q.src.chain !== want.from || q.dst.chain !== want.to) return 'the quote is for another route';
  if (BigInt(q.src.amount) !== want.amountIn) return 'the quote is for another amount';
  if (String(q.src.depositor).toLowerCase() !== String(want.depositor).toLowerCase()) return 'the quote names another payer';
  if (String(q.dst.recipient).toLowerCase() !== String(want.recipient).toLowerCase()) return 'the quote pays someone else';
  if (want.deposits && want.deposits[q.src.chain] && String(q.src.deposit).toLowerCase() !== String(want.deposits[q.src.chain]).toLowerCase()) return 'the quote names an unpublished deposit address';
  if (q.expiresAt <= want.now) return 'the quote has expired';
  if (q.expiresAt - want.now > 120_000) return 'the quote lives too long';
  if (q.issuedAt > want.now + 30_000) return 'the quote is from the future';
  const in6 = stableToUsd6(BigInt(q.src.amount), bridgeCfg(q.src.chain).stable.decimals);
  if (in6 > want.maxFill6) return 'above the amount motion\'s bridge may carry';
  if (!(want.oracle6 > 0n)) return 'no price of our own for the destination chain';
  const floor = (usd6ToNative(in6, want.oracle6, bridgeCfg(q.dst.chain).nativeDecimals) * BigInt(10_000 - Math.max(0, Math.min(1_000, want.maxSlipBps)))) / 10_000n;
  if (BigInt(q.dst.amount) < floor) return 'the quote pays less than the oracle price minus slippage';
  return '';
}

// ── the source transfer the vault pre-signs ──
export const ERC20_TRANSFER = '0xa9059cbb';
export const SPL_TRANSFER_CHECKED = 12;
export type EvmTransfer = { to: string; amount: bigint };
/** `transfer(address,uint256)` and nothing else; any other shape is refused */
export function decodeErc20Transfer(data: string): EvmTransfer | null {
  const d = String(data || '').toLowerCase();
  if (!/^0x[0-9a-f]{136}$/.test(d) || d.slice(0, 10) !== ERC20_TRANSFER) return null;
  if (!/^0{24}/.test(d.slice(10, 74))) return null;
  return { to: '0x' + d.slice(34, 74), amount: BigInt('0x' + d.slice(74, 138)) };
}
export const erc20TransferData = (to: string, amount: bigint): string =>
  ERC20_TRANSFER + String(to).toLowerCase().replace(/^0x/, '').padStart(64, '0') + amount.toString(16).padStart(64, '0');
/**
 * The solver's check of the raw EVM transfer the vault signed: exactly this quote's token, amount, deposit address and
 * payer, on this chain, with no value and a sane gas limit. `from` is what the signature recovers to — never what the
 * caller claims.
 */
export function evmSourceProblem(tx: { chainId: number; to?: string | null; data?: string; value?: bigint; gas?: bigint; nonce?: number; type?: string }, from: string, q: Quote): string {
  const cfg = bridgeCfg(q.src.chain);
  if (cfg.kind !== 'evm') return 'not an EVM source';
  if (Number(tx.chainId) !== cfg.chainId) return 'the transaction is for another chain';
  if (String(tx.to || '').toLowerCase() !== String(q.src.token).toLowerCase()) return 'the transaction does not call the stablecoin';
  if ((tx.value ?? 0n) !== 0n) return 'the transaction sends native value';
  const t = decodeErc20Transfer(String(tx.data || ''));
  if (!t) return 'not a plain ERC-20 transfer';
  if (t.to.toLowerCase() !== String(q.src.deposit).toLowerCase()) return 'the transfer pays another address';
  if (t.amount !== BigInt(q.src.amount)) return 'the transfer is for another amount';
  if (String(from).toLowerCase() !== String(q.src.depositor).toLowerCase()) return 'the transaction is signed by another wallet';
  if ((tx.gas ?? 0n) > 400_000n) return 'the gas limit is unreasonable';
  return '';
}
/**
 * The solver's check of the raw Solana transfer: fee payer = the quote's depositor, exactly one SPL transferChecked of
 * the quoted mint, amount and destination token account, an optional compute budget, a memo carrying the quote id, and
 * nothing else. `tx` is the parsed legacy transaction (src/solLimitCore.ts parseLegacyTx shape).
 */
export type ParsedSolIx = { program: string; accounts: string[]; data: Uint8Array };
export type ParsedSolTx = { sigs: Uint8Array[]; message: Uint8Array; header: [number, number, number]; keys: string[]; blockhash: string; ixs: ParsedSolIx[] };
export const SOL_PROGRAMS = {
  system: '11111111111111111111111111111111', token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', budget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};
export function solSourceProblem(tx: ParsedSolTx, q: Quote, ata: (owner: string, mint: string) => string): string {
  if (bridgeCfg(q.src.chain).kind !== 'sol') return 'not a Solana source';
  if (!tx || !Array.isArray(tx.ixs) || !tx.keys?.length) return 'not a transaction';
  if (tx.sigs.length !== 1) return 'the transaction has more than one signature';
  if (tx.keys[0] !== q.src.depositor) return 'the transaction is signed by another wallet';
  const mint = q.src.token;
  const src = ata(q.src.depositor, mint), dst = ata(q.src.deposit, mint);
  let transfers = 0, memos = 0, budget = 0;
  for (const ix of tx.ixs) {
    if (ix.program === SOL_PROGRAMS.budget) { budget += 1; if (budget > 2) return 'too many compute-budget instructions'; continue; }
    if (ix.program === SOL_PROGRAMS.memo) {
      memos += 1; if (memos > 1) return 'more than one memo';
      if (new TextDecoder().decode(ix.data) !== q.id) return 'the memo does not carry this quote id';
      continue;
    }
    if (ix.program === SOL_PROGRAMS.token) {
      transfers += 1; if (transfers > 1) return 'more than one transfer';
      if (ix.data.length !== 10 || ix.data[0] !== SPL_TRANSFER_CHECKED) return 'not an SPL transferChecked';
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset);
      const amount = dv.getBigUint64(1, true); const decimals = ix.data[9];
      if (amount !== BigInt(q.src.amount)) return 'the transfer is for another amount';
      if (decimals !== bridgeCfg(q.src.chain).stable.decimals) return 'wrong token decimals';
      if (ix.accounts.length !== 4) return 'unexpected transfer accounts';
      if (ix.accounts[0] !== src) return 'the transfer comes from another account';
      if (ix.accounts[1] !== mint) return 'the transfer is of another token';
      if (ix.accounts[2] !== dst) return 'the transfer pays another account';
      if (ix.accounts[3] !== q.src.depositor) return 'the transfer is authorised by someone else';
      continue;
    }
    return 'unexpected instruction (' + ix.program.slice(0, 8) + ')';
  }
  if (transfers !== 1) return 'the transaction carries no transfer';
  if (memos !== 1) return 'the transaction carries no quote memo';
  return '';
}

// ── the fill's state machine (the ledger's only transitions) ──
// 2026-11-01 (audit: a source that landed after the inclusion timeout was written 'failed' and never looked at again; a
// payout was written 'filled' the moment it was broadcast):
//   · 'source-late' — the user's transfer was broadcast but not seen included in time. It may still land, so it is NOT
//     terminal: the solver follows it and pays (or refunds) once it lands, and writes 'failed' only once it provably can
//     never land (EVM: the payer's nonce was used by another transaction; Solana: its blockhash expired, no status).
//   · 'paid' — the payout's bytes are out; 'filled' only once it is seen on chain. A payout that provably can never land
//     (or reverted) is refunded; one that may still land is never refunded.
//   · once the source is included there is no terminal but 'filled' or 'refunded' (no 'failed' with the user's money held).
export type FillState = 'quoted' | 'bound' | 'source-sent' | 'source-late' | 'source-included' | 'paying' | 'paid' | 'filled' | 'refunding' | 'refunded' | 'failed' | 'expired';
export const FILL_TERMINAL: FillState[] = ['filled', 'refunded', 'failed', 'expired'];
export const FILL_NEXT: Record<FillState, FillState[]> = {
  quoted: ['bound', 'expired', 'failed'],
  bound: ['source-sent', 'source-late', 'source-included', 'failed'],
  'source-sent': ['source-included', 'source-late', 'failed', 'refunding'],
  'source-late': ['source-included', 'failed', 'refunding'],
  'source-included': ['paying', 'refunding'],
  paying: ['paid', 'filled', 'refunding'],
  paid: ['filled', 'refunding'],
  refunding: ['refunded'],
  filled: [], refunded: [], failed: [], expired: [],
};
export const canStep = (from: FillState, to: FillState): boolean => (FILL_NEXT[from] || []).includes(to);
/** what the vault shows the user */
export const USER_STATE: Record<FillState, string> = {
  quoted: 'quoted', bound: 'quoted', 'source-sent': 'source sent', 'source-late': 'source sent', 'source-included': 'source sent', paying: 'source sent', paid: 'source sent',
  filled: 'filled', refunding: 'refunding', refunded: 'refunded', failed: 'failed', expired: 'expired',
};
export const DIALOG_LINE = 'motion pays you on the other chain from its own funds the moment your transfer is included; if it cannot, your transfer is sent back.';

// ── the ledger (append-only, hash-chained; the solver's crash safety) ──
// quote / srcNonce / srcBlockhash (at 'bound'): what a restart needs to pay or refund, and to tell whether the user's
// transfer can still land. Our own payout (dstRaw) and refund (refundRaw) carry that in their bytes (EVM nonce, Solana
// blockhash); dstAt / refundAt are when they were signed. Older ledgers kept a refund's bytes in dstRaw: they are only re-sent
// when they hash to refundHash.
export type LedgerRecord = {
  at: number; id: string; state: FillState; usd6?: string; user?: string; from?: BridgeChain; to?: BridgeChain; srcHash?: string; dstHash?: string; dstRaw?: string; refundHash?: string; note?: string;
  quote?: Quote; boundAt?: number; srcNonce?: number; srcBlockhash?: string; dstAt?: number; refundRaw?: string; refundAt?: number;
};
export const ledgerLine = (rec: LedgerRecord, prev: string): string => {
  const body = JSON.stringify(rec);
  return JSON.stringify({ p: prev.slice(0, 32), r: rec, h: hexOf(sha256(te.encode(prev.slice(0, 32) + body))) });
};
export function ledgerReplay(lines: string[]): { fills: Map<string, LedgerRecord & { history: FillState[] }>; broken: number; last: string } {
  const fills = new Map<string, LedgerRecord & { history: FillState[] }>();
  let prev = '', broken = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let x: { p: string; r: LedgerRecord; h: string };
    try { x = JSON.parse(line); } catch { broken += 1; continue; }
    const want = hexOf(sha256(te.encode(String(x.p ?? '') + JSON.stringify(x.r))));
    if (want !== x.h || String(x.p ?? '') !== prev.slice(0, 32)) { broken += 1; continue; }
    prev = x.h;
    const cur = fills.get(x.r.id);
    fills.set(x.r.id, { ...(cur || { history: [] }), ...x.r, history: [...(cur?.history || []), x.r.state] });
  }
  return { fills, broken, last: prev };
}
/**
 * Rolling use of the caps, from the ledger's own records (never a counter that a restart could lose).
 *
 * A quote that was never used costs motion NOTHING, so it must not eat a cap: anyone can ask for quotes, and if
 * `quoted` counted, a stranger could spend the hour's cap for free and keep everyone else off the fast path. Spending
 * starts at `bound` — the moment a signed transfer of the user's is in our hands. A quote still in flight does hold a
 * slot (one wallet, two fills at a time) and reserves inventory, but only until it expires.
 */
export function useOf(fills: Iterable<LedgerRecord>, user: string, now: number, quoteTtlMs = DEFAULT_CAPS.quoteTtlMs): LedgerUse {
  let userDay6 = 0n, globalHour6 = 0n, openForUser = 0;
  const u = String(user).toLowerCase();
  for (const f of fills) {
    const spent = f.state !== 'failed' && f.state !== 'expired' && f.state !== 'refunded' && f.state !== 'quoted';
    const usd = BigInt(f.usd6 || '0');
    if (spent && now - f.at < 86_400_000 && String(f.user || '').toLowerCase() === u) userDay6 += usd;
    if (spent && now - f.at < 3_600_000) globalHour6 += usd;
    const live = !FILL_TERMINAL.includes(f.state) && (f.state !== 'quoted' || now - f.at < quoteTtlMs + 5_000);
    if (live && String(f.user || '').toLowerCase() === u) openForUser += 1;
  }
  return { userDay6, globalHour6, openForUser };
}

// ── inventory and the background rebalancer (§5 of the design) ──
export type Inventory = Record<BridgeChain, { native: bigint; stable: bigint; price6: bigint }>;
export const inventoryUsd6 = (inv: Inventory, c: BridgeChain): bigint =>
  nativeToUsd6(inv[c].native, inv[c].price6, bridgeCfg(c).nativeDecimals) + stableToUsd6(inv[c].stable, bridgeCfg(c).stable.decimals);
export type RebalanceMove = { from: BridgeChain; to: BridgeChain; usd6: bigint; why: string };
/**
 * One move at a time: the poorest chain under its floor is topped up from the richest chain above its own floor, in
 * chunks of at least `min6`. Pure, so the plan can be shown on the status route without moving anything.
 */
export function planRebalance(inv: Inventory, caps: BridgeCaps, opts: { min6?: bigint; target6?: bigint; inFlight?: Partial<Record<BridgeChain, bigint>> } = {}): RebalanceMove | null {
  const min6 = opts.min6 ?? 100n * USD6;
  const target6 = opts.target6 ?? 0n;
  const level = (c: BridgeChain) => inventoryUsd6(inv, c) + (opts.inFlight?.[c] ?? 0n);
  // each chain aims at its floor + $500 (two of the old $250 fills): the $1,000 fill cap (2026-10-27) would make every chain look short
  const want = (c: BridgeChain) => (target6 > 0n ? target6 : caps.floor6[c] + 500n * USD6);
  const needy = BRIDGE_CHAINS.filter((c) => level(c) < want(c)).sort((a, b) => Number(level(a) - want(a) - (level(b) - want(b))))[0];
  if (!needy) return null;
  const need = want(needy) - level(needy);
  const donors = BRIDGE_CHAINS.filter((c) => c !== needy && level(c) - want(c) >= min6).sort((a, b) => Number(level(b) - want(b) - (level(a) - want(a))));
  if (!donors.length) return null;
  const spare = level(donors[0]) - want(donors[0]);
  const usd6 = need > spare ? spare : need < min6 ? min6 : need;
  if (usd6 < min6 || usd6 > spare) return null;
  return { from: donors[0], to: needy, usd6, why: `${needy} is ${Number(need) / 1e6} USD under target` };
}
