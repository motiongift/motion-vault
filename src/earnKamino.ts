// Earn on the USD balance — Solana: USDC in Kamino Lend's main market (pure rules; the engine side is src/earnEngine.ts, adapter
// 'kamino'). Chosen over Jupiter Lend because klend publishes its Anchor IDL on chain (kamino_lending 1.27.0, read 2026-11-03 from
// its IDL account 8qLKwp1fk8WyqmzarkuMeZEX3AzL4VDSmA2UZTKT2aCJ): every instruction, account list and the Reserve layout below are
// checked against it (B:\tmp\earn-mvp\probe\idl\klend.idl.json, reserve-layout.txt). Jupiter Lend has no on-chain IDL.
//
// R holds Kamino's collateral token (kUSDC, the reserve's cToken) in its own token account — no obligation, no borrowing, no
// farm. R signs ONE transaction per step, built only here: [create R's token account (idempotent)], refresh_reserve,
// deposit_reserve_liquidity(amount)  — or —  refresh_reserve, redeem_reserve_collateral(cTokens). Owner = R, source and
// destination = R's own associated token accounts. Simulated on mainnet state 2026-11-03 (sigVerify off, nothing signed):
// a $10 deposit minted 8.269857 kUSDC; deposit + redeem of everything returned $10 less 1 micro-USDC (rounding); a wrong supply
// vault was refused by klend (Custom 2012). Log: B:\tmp\earn-mvp\logs\sol-kamino-readonly-probe.log.
import { sha256 } from '@noble/hashes/sha2';
import { USD } from './floatCore.ts';

export type KaminoCfg = {
  kind: 'kamino'; chain: 'sol'; name: string; protocol: 'Kamino';
  program: string; market: string; reserve: string; lma: string;
  mint: string; supplyVault: string; cMint: string; assetSymbol: 'USDC'; assetDecimals: 6;
  tokenProgram: string; ataProgram: string; sysvarIx: string; systemProgram: string;
  // the oracle the reserve names (scope only on 2026-11-03; unset Pyth / Switchboard = the program id in refresh_reserve)
  scope: string; pyth: string | null; sbPrice: string | null; sbTwap: string | null;
  // the program's last deploy (BPF upgradeable loader ProgramData) as read 2026-11-03: another one = new code, nothing new goes in
  programData: string; deploySlot: bigint;
};
export const KAMINO_SOL: KaminoCfg = {
  kind: 'kamino', chain: 'sol', name: 'Kamino Main · USDC', protocol: 'Kamino',
  program: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  reserve: 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59', lma: '9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', supplyVault: 'Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6', cMint: 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D',
  assetSymbol: 'USDC', assetDecimals: 6,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ataProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  sysvarIx: 'Sysvar1nstructions1111111111111111111111111', systemProgram: '11111111111111111111111111111111',
  scope: '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH', pyth: null, sbPrice: null, sbTwap: null,
  programData: '9uSbGW1y9H5Av6H5TKxQ1wnFApSq2t3oEpfF2YfjDQGA', deploySlot: 461_744_249n,
};
const te = new TextEncoder();
const disc = (name: string) => Array.from(sha256(te.encode('global:' + name)).subarray(0, 8));
export const KAMINO_DISC = { refresh: disc('refresh_reserve'), deposit: disc('deposit_reserve_liquidity'), redeem: disc('redeem_reserve_collateral') } as const;
export const RESERVE_DISC = Array.from(sha256(te.encode('account:Reserve')).subarray(0, 8));
export const RESERVE_SIZE = 8624;
// the Reserve layout (IDL 1.27.0; byte offsets incl. the 8-byte discriminator)
export const OFF = { lendingMarket: 32, mint: 128, supplyVault: 160, available: 224, borrowedSf: 232, mintDecimals: 272, protoSf: 344, refSf: 360, pendSf: 376, tokenProgram: 408,
  cMint: 2560, cSupply: 2592, status: 4856, emergency: 4864, depositLimit: 5016, scope: 5112, sbPrice: 5160, sbTwap: 5192, pyth: 5224 } as const;
export const MARKET_EMERGENCY = 122;   // LendingMarket.emergencyMode (8 disc + version 8 + bump 8 + owner 32 + owner cached 32 + quote 32 + referral 2)

// base58 (the same alphabet as solEngine's)
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const b58e = (b: Uint8Array) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; };
const pkAt = (d: Uint8Array, o: number) => b58e(d.subarray(o, o + 32));
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const u128At = (d: Uint8Array, o: number) => u64At(d, o) + (u64At(d, o + 8) << 64n);
export const le64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const SYS = '11111111111111111111111111111111';

export type ReserveRead = {
  lendingMarket: string; mint: string; supplyVault: string; cMint: string; tokenProgram: string; available: bigint; totalLiquidity: bigint; cSupply: bigint;
  status: number; emergency: number; depositLimit: bigint; oracles: { pyth: string | null; sbPrice: string | null; sbTwap: string | null; scope: string | null };
};
/** The Reserve account's bytes → the facts Earn uses, or why they cannot be trusted. */
export function readReserve(data: Uint8Array | null, owner: string | null, cfg: KaminoCfg = KAMINO_SOL): ReserveRead | { why: string } {
  if (!data || owner !== cfg.program) return { why: 'the Kamino reserve is not owned by klend' };
  if (data.length !== RESERVE_SIZE || RESERVE_DISC.some((b, i) => data[i] !== b)) return { why: 'the Kamino reserve has another layout' };
  const unset = (k: string) => (k === SYS ? null : k);
  const borrowed = u128At(data, OFF.borrowedSf), fees = u128At(data, OFF.protoSf) + u128At(data, OFF.refSf) + u128At(data, OFF.pendSf);
  const available = u64At(data, OFF.available);
  const totalLiquidity = available + (borrowed > fees ? (borrowed - fees) >> 60n : 0n);
  return {
    lendingMarket: pkAt(data, OFF.lendingMarket), mint: pkAt(data, OFF.mint), supplyVault: pkAt(data, OFF.supplyVault), cMint: pkAt(data, OFF.cMint), tokenProgram: pkAt(data, OFF.tokenProgram),
    available, totalLiquidity, cSupply: u64At(data, OFF.cSupply), status: data[OFF.status], emergency: data[OFF.emergency], depositLimit: u64At(data, OFF.depositLimit),
    oracles: { pyth: unset(pkAt(data, OFF.pyth)), sbPrice: unset(pkAt(data, OFF.sbPrice)), sbTwap: unset(pkAt(data, OFF.sbTwap)), scope: unset(pkAt(data, OFF.scope)) },
  };
}
/** The reserve against what this build pins: 'hard' (another reserve / mint / vault), 'changed' (another oracle set, program
 *  upgraded: nothing new goes in), 'riskOff' (not active, emergency mode: take it out), null = fine. */
export function kaminoProblem(r: ReserveRead, marketEmergency: number | null, deploySlot: bigint | null, cfg: KaminoCfg = KAMINO_SOL): { cls: 'hard' | 'changed' | 'riskOff'; why: string } | null {
  if (r.lendingMarket !== cfg.market || r.mint !== cfg.mint || r.supplyVault !== cfg.supplyVault || r.cMint !== cfg.cMint || r.tokenProgram !== cfg.tokenProgram) return { cls: 'hard', why: 'the Kamino reserve names other accounts' };
  if (r.status !== 0) return { cls: 'riskOff', why: 'the Kamino reserve is not active' };
  if (r.emergency !== 0 || (marketEmergency ?? 0) !== 0) return { cls: 'riskOff', why: 'Kamino is in emergency mode' };
  if (r.oracles.scope !== cfg.scope || r.oracles.pyth !== cfg.pyth || r.oracles.sbPrice !== cfg.sbPrice || r.oracles.sbTwap !== cfg.sbTwap) return { cls: 'changed', why: 'the Kamino reserve uses another oracle' };
  if (deploySlot == null || deploySlot !== cfg.deploySlot) return { cls: 'changed', why: 'Kamino\'s program was upgraded' };
  return null;
}
/** Liquidity per cToken in micro-USDC per 1e6 cTokens (the "share price"); cTokens → USDC; USDC → cTokens (rounded up). */
export const kPrice6 = (r: ReserveRead) => (r.cSupply > 0n ? (r.totalLiquidity * 1_000_000n) / r.cSupply : 0n);
export const kAssets = (r: ReserveRead, c: bigint) => (r.cSupply > 0n ? (c * r.totalLiquidity) / r.cSupply : 0n);
export const kCollateralFor = (r: ReserveRead, usdc: bigint) => (r.totalLiquidity > 0n ? (usdc * r.cSupply + r.totalLiquidity - 1n) / r.totalLiquidity : 0n);

// ── instructions (the engine's Ix: { program, keys: [pubkey, signer, writable][], data }) ──
export type KIx = { program: string; keys: [string, boolean, boolean][]; data: Uint8Array };
const optOr = (k: string | null, program: string) => k ?? program;
export function refreshIx(cfg: KaminoCfg, oracles: ReserveRead['oracles']): KIx {
  return { program: cfg.program, keys: [[cfg.reserve, false, true], [cfg.market, false, false], [optOr(oracles.pyth, cfg.program), false, false], [optOr(oracles.sbPrice, cfg.program), false, false], [optOr(oracles.sbTwap, cfg.program), false, false], [optOr(oracles.scope, cfg.program), false, false]], data: Uint8Array.from(KAMINO_DISC.refresh) };
}
export function createAtaIx(cfg: KaminoCfg, r: string, ata: string, mint: string): KIx {
  return { program: cfg.ataProgram, keys: [[r, true, true], [ata, false, true], [r, false, false], [mint, false, false], [cfg.systemProgram, false, false], [cfg.tokenProgram, false, false]], data: Uint8Array.of(1) };
}
export function depositIx(cfg: KaminoCfg, r: string, rUsdc: string, rCtoken: string, amount: bigint): KIx {
  return { program: cfg.program, keys: [[r, true, false], [cfg.reserve, false, true], [cfg.market, false, false], [cfg.lma, false, false], [cfg.mint, false, false], [cfg.supplyVault, false, true], [cfg.cMint, false, true], [rUsdc, false, true], [rCtoken, false, true], [cfg.tokenProgram, false, false], [cfg.tokenProgram, false, false], [cfg.sysvarIx, false, false]], data: concat(Uint8Array.from(KAMINO_DISC.deposit), le64(amount)) };
}
export function redeemIx(cfg: KaminoCfg, r: string, rUsdc: string, rCtoken: string, collateral: bigint): KIx {
  return { program: cfg.program, keys: [[r, true, false], [cfg.market, false, false], [cfg.reserve, false, true], [cfg.lma, false, false], [cfg.mint, false, false], [cfg.cMint, false, true], [cfg.supplyVault, false, true], [rCtoken, false, true], [rUsdc, false, true], [cfg.tokenProgram, false, false], [cfg.tokenProgram, false, false], [cfg.sysvarIx, false, false]], data: concat(Uint8Array.from(KAMINO_DISC.redeem), le64(collateral)) };
}
const concat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
export const kDepositIxs = (cfg: KaminoCfg, r: string, rUsdc: string, rCtoken: string, oracles: ReserveRead['oracles'], amount: bigint): KIx[] => [createAtaIx(cfg, r, rCtoken, cfg.cMint), refreshIx(cfg, oracles), depositIx(cfg, r, rUsdc, rCtoken, amount)];
export const kRedeemIxs = (cfg: KaminoCfg, r: string, rUsdc: string, rCtoken: string, oracles: ReserveRead['oracles'], collateral: bigint): KIx[] => [createAtaIx(cfg, r, rUsdc, cfg.mint), refreshIx(cfg, oracles), redeemIx(cfg, r, rUsdc, rCtoken, collateral)];

const same = (a: KIx, b: KIx) => a.program === b.program && a.keys.length === b.keys.length && a.keys.every((k, i) => k[0] === b.keys[i][0] && k[1] === b.keys[i][1] && k[2] === b.keys[i][2]) && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);
/**
 * null = exactly one of the two shapes R may sign on Solana; else why not. The list is rebuilt here from the reserve's pinned
 * accounts, R's own associated token accounts and the amount the instruction carries, and compared byte for byte: a deposit of
 * 0 < amount ≤ one deposit's cap into R's cToken account from R's USDC account, or a redeem of 0 < cTokens from R's cToken
 * account into R's USDC account. Nothing else (no other program, no other account, no transfer, no close, no authority change).
 */
export function kaminoIxsProblem(ixs: readonly KIx[], ctx: { r: string; rUsdc: string; rCtoken: string; oracles: ReserveRead['oracles']; perTxMax6: bigint; cfg?: KaminoCfg }): string | null {
  const cfg = ctx.cfg ?? KAMINO_SOL;
  if (!Array.isArray(ixs) || ixs.length !== 3) return 'not an Earn transaction';
  const last = ixs[2]; if (!last || last.program !== cfg.program || last.data.length !== 16) return 'not an Earn transaction';
  const d = Array.from(last.data.subarray(0, 8)); const amount = u64At(last.data, 8);
  if (!(amount > 0n)) return 'amount out of bounds';
  if (d.every((x, i) => x === KAMINO_DISC.deposit[i])) {
    if (amount > ctx.perTxMax6) return 'deposit above one deposit';
    const want = kDepositIxs(cfg, ctx.r, ctx.rUsdc, ctx.rCtoken, ctx.oracles, amount);
    return want.every((w, i) => same(w, ixs[i])) ? null : 'the deposit names other accounts';
  }
  if (d.every((x, i) => x === KAMINO_DISC.redeem[i])) {
    const want = kRedeemIxs(cfg, ctx.r, ctx.rUsdc, ctx.rCtoken, ctx.oracles, amount);
    return want.every((w, i) => same(w, ixs[i])) ? null : 'the redeem names other accounts';
  }
  return 'instruction not allowed';
}
/** A simulated / landed step from R's two token accounts: a deposit spends exactly `amount` USDC and mints ≥ minC cTokens; a
 *  redeem burns exactly `c` cTokens and pays ≥ minUsdc. */
export function kaminoOutcome(kind: 'deposit' | 'redeem', pre: { usdc: bigint; c: bigint }, post: { usdc: bigint; c: bigint }, amount: bigint, min: bigint): string | null {
  if (kind === 'deposit') {
    if (pre.usdc - post.usdc !== amount) return 'the deposit did not take exactly the amount from the reserve';
    if (post.c - pre.c < min || post.c <= pre.c) return 'Kamino minted fewer cTokens than expected';
    return null;
  }
  if (pre.c - post.c !== amount) return 'the redeem did not burn exactly the cTokens asked';
  if (post.usdc - pre.usdc < min || post.usdc <= pre.usdc) return 'Kamino paid less than expected';
  return null;
}
/** A token account's amount (SPL layout: mint 32, owner 32, amount u64 at 64); null = no account (0), undefined = not a token account of that mint / owner. */
export function tokenAmount(data: Uint8Array | null, mint: string, owner: string): bigint | null | undefined {
  if (!data) return null;
  if (data.length < 72) return undefined;
  if (pkAt(data, 0) !== mint || pkAt(data, 32) !== owner) return undefined;
  return u64At(data, 64);
}
export const KAMINO_SLIP_BPS = 10n;
export const KAMINO_ATA_RENT = 2_039_280n;    // lamports of a token account's rent (165 bytes)
export const KAMINO_FEE = 200_000n;           // what one Earn transaction may cost R in lamports at most (base + priority)
export const KAMINO_UNITS = 200_000, KAMINO_MICRO = 20_000;
export const KAMINO_MIN_LIQUIDITY6 = 1_000n * USD;
/** The oracle set this build pins for the reserve (review L2: the signer's fallback when it cannot read the reserve itself). */
export const kPinnedOracles = (cfg: KaminoCfg = KAMINO_SOL): ReserveRead['oracles'] => ({ pyth: cfg.pyth, sbPrice: cfg.sbPrice, sbTwap: cfg.sbTwap, scope: cfg.scope });
/** review H3: a redeem when the Reserve can no longer be parsed — the floor of what `c` cTokens pay, from the last exchange rate
 *  this device read (price6 = USDC raw per 1e6 cToken raw; the rate only grows), less the slippage. 0 = no rate known: no exit. */
export const kRedeemFloor = (c: bigint, price6: bigint): bigint => {
  if (!(c > 0n) || !(price6 > 0n)) return 0n;
  const v = (c * price6) / 1_000_000n;
  return v - (v * KAMINO_SLIP_BPS) / 10_000n - 1n;
};
/** r6 (re-review M5-1): the pre-step SIMULATION judged by deltas that tolerate what else moved R's accounts between the read and
 *  the simulation (the float's own forward, a refund, anyone's dust — tokens may be sent to R's accounts by anyone): a deposit
 *  spends at most `amount` of R's USDC and mints at least `min` cTokens; a redeem burns at most `amount` cTokens (a gift of
 *  cTokens only makes it look smaller) and pays at least `min`. null = fine. The engine retries a mismatch next tick (never a
 *  stop: nothing was sent); the LANDED step is checked again from R's accounts (verify / settle). */
export function kaminoSimProblem(kind: 'deposit' | 'redeem', pre: { usdc: bigint; c: bigint }, post: { usdc: bigint; c: bigint }, amount: bigint, min: bigint): string | null {
  if (kind === 'deposit') {
    if (pre.usdc - post.usdc > amount) return 'the deposit would take more than the amount from the reserve';
    if (post.c - pre.c < min || post.c <= pre.c) return 'Kamino would mint fewer cTokens than expected';
    return null;
  }
  if (pre.c - post.c > amount) return 'the redeem would burn more cTokens than asked';
  if (post.usdc - pre.usdc < min || post.usdc <= pre.usdc) return 'Kamino would pay less than expected';
  return null;
}
