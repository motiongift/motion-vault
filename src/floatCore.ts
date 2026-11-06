// One USD balance on three chains — the pure core (design: trench docs/drafts/USDC-BALANCE.md, as built §16).
//
// Everything here is pure: no window, no network, no clock (callers pass `now`), no key is ever kept. The vault frame
// (src/floatEngine.ts) and the tests use the same functions, so what the tests prove is what the vault runs.
//
// The model, in one paragraph: a trade is exactly today's trade, from the trading wallet W, paid from a native "float"
// (ETH on Robinhood, BNB, SOL) that is already on that chain. A second wallet of the same key, the reserve R
// (HMAC(W key, "motion/usd-reserve/v1")), holds the dollars: USDG on Robinhood (the chain has no USDC), USDC on BNB Chain
// and Solana. In the background R tops W's floats up (a same-chain swap, R's own nonce), W's surplus is swept back to R
// whenever W may send (the quiet rule), and reserves are rebalanced between chains through public bridges with failover.
// Switching on converts W's native into R's dollars at once; switching off converts them back. Nothing of this runs
// between a click and its send.
//
// Units: dollars are integer micro-dollars (`usd6`, 1 USD = 1_000_000n). Native amounts are raw base units (wei,
// lamports). Stablecoins are counted at $1 (stated in the UI). Rounding: an amount we send rounds DOWN, a cost we show
// rounds UP — the figure never understates what the user pays.
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

export type FloatChain = 'robinhood' | 'bsc' | 'sol';
export const FLOAT_CHAIN_KEYS: FloatChain[] = ['robinhood', 'bsc', 'sol'];
export const USD = 1_000_000n;
export const usd6 = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6));

// ── chains ──
// oracle: the V3 pool the vault reads the native price from (slot0), never the pool it swaps through.
// RH: WETH/USDG 0.01 % (token0 = WETH) — the pool behind the indexer's ethUsd; BNB: USDT/WBNB 0.05 % (token0 = USDT, so
// the native is token1). The swap pools: RH WETH/USDG 0.01 % through the SwapRouter02 at 0xcaf6…; BNB USDC/WBNB 0.01 %
// (liquidity 4.96e23, the deepest tier, read 2026-10-25) through PancakeSwap's SmartRouter. Solana: a pinned Meteora
// DLMM SOL/USDC pool through the vault's own DLMM instruction (src/solEngine.ts), no aggregator.
export type EvmFloatCfg = {
  key: 'robinhood' | 'bsc'; kind: 'evm'; chainId: number; native: string; nativeDecimals: 18;
  stable: { address: `0x${string}`; symbol: string; decimals: number };
  wrapped: `0x${string}`; router: `0x${string}`; swapFee: number;
  oracle: { pool: `0x${string}`; nativeIsToken0: boolean; stableDecimals: number };
  gasFloor: bigint;      // kept in W, never swept: the native a trade's own gas needs
  reserveGas: bigint;    // kept in R for R's own approve + swap / deposit
  swapGas: bigint;       // gas units of approve + multicall(exactInputSingle, unwrapWETH9), measured on the fork, × 1.2
  relayChainId: number; debridgeChainId: number;
};
export type SolFloatCfg = {
  key: 'sol'; kind: 'sol'; native: 'SOL'; nativeDecimals: 9;
  stable: { address: string; symbol: 'USDC'; decimals: 6 };
  dlmmPool: string;
  gasFloor: bigint; reserveGas: bigint;
  relayChainId: number; debridgeChainId: number; mayanChain: string;
};
export type FloatCfg = EvmFloatCfg | SolFloatCfg;
export const FLOAT_CFG: { robinhood: EvmFloatCfg; bsc: EvmFloatCfg; sol: SolFloatCfg } = {
  robinhood: {
    key: 'robinhood', kind: 'evm', chainId: 4663, native: 'ETH', nativeDecimals: 18,
    stable: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
    wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', router: '0xcaf681a66d020601342297493863e78c959e5cb2', swapFee: 100,
    oracle: { pool: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', nativeIsToken0: true, stableDecimals: 6 },
    gasFloor: 200_000_000_000_000n,        // 0.0002 ETH
    reserveGas: 100_000_000_000_000n,      // 0.0001 ETH ≈ 250 swaps at 0.02 gwei
    swapGas: 260_000n,
    relayChainId: 4663, debridgeChainId: 4663,
  },
  bsc: {
    key: 'bsc', kind: 'evm', chainId: 56, native: 'BNB', nativeDecimals: 18,
    stable: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
    wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', swapFee: 100,
    oracle: { pool: '0x36696169c63e42cd08ce11f5deebbcebae652050', nativeIsToken0: false, stableDecimals: 18 },
    gasFloor: 1_000_000_000_000_000n,      // 0.001 BNB
    reserveGas: 500_000_000_000_000n,      // 0.0005 BNB
    swapGas: 260_000n,
    relayChainId: 56, debridgeChainId: 56,
  },
  sol: {
    key: 'sol', kind: 'sol', native: 'SOL', nativeDecimals: 9,
    stable: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    dlmmPool: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y',   // Meteora DLMM SOL/USDC, bin step 10 (pinned; the vault re-reads it on chain)
    gasFloor: 20_000_000n,                 // 0.02 SOL (incl. ~0.002 rent per new coin account)
    reserveGas: 10_000_000n,               // 0.01 SOL: R's own fees and its wSOL / USDC account rent
    relayChainId: 792703809, debridgeChainId: 7565164, mayanChain: 'solana',
  },
};
export const cfgOf = (c: FloatChain): FloatCfg => FLOAT_CFG[c];
const pow10 = (n: number) => 10n ** BigInt(n);

// ── the reserve wallet R ──
// R's EVM key = HMAC-SHA256(W's EVM key, RESERVE_TEXT). Solana and BNB use the same key as every wallet does (one key =
// all chains), so R exists on all three. Never stored, posted or exported; any device holding W derives it again.
export const RESERVE_TEXT = 'motion/usd-reserve/v1';
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
export function reserveKeyOf(walletKeyHex: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletKeyHex)) throw new Error('A USD reserve needs an EVM-key wallet');
  const key = Uint8Array.from(walletKeyHex.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  const out = hmac(sha256, key, new TextEncoder().encode(RESERVE_TEXT));
  const hex = Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  const n = BigInt('0x' + hex);
  if (n === 0n || n >= SECP_N) throw new Error('Reserve key out of range — refused');   // p ≈ 2⁻¹²⁸
  return `0x${hex}`;
}

// ── dollars ↔ native ──
export const nativeToUsd6 = (raw: bigint, price6: bigint, decimals: number): bigint => (raw * price6) / pow10(decimals);
export const nativeToUsd6Up = (raw: bigint, price6: bigint, decimals: number): bigint => { const d = pow10(decimals); return (raw * price6 + d - 1n) / d; };
export const usd6ToNative = (u: bigint, price6: bigint, decimals: number): bigint => (price6 > 0n ? (u * pow10(decimals)) / price6 : 0n);
export const stableToUsd6 = (raw: bigint, decimals: number): bigint => (decimals >= 6 ? raw / pow10(decimals - 6) : raw * pow10(6 - decimals));
export const usd6ToStable = (u: bigint, decimals: number): bigint => (decimals >= 6 ? u * pow10(decimals - 6) : u / pow10(6 - decimals));
// a V3 pool's slot0 sqrtPriceX96 → micro-dollars per ONE whole native coin
export function oraclePrice6(sqrtPriceX96: bigint, o: { nativeIsToken0: boolean; stableDecimals: number }, nativeDecimals = 18): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const Q192 = 1n << 192n; const sq = sqrtPriceX96 * sqrtPriceX96;
  // stable raw per one whole native
  const stableRaw = o.nativeIsToken0 ? (pow10(nativeDecimals) * sq) / Q192 : (pow10(nativeDecimals) * Q192) / sq;
  return stableToUsd6(stableRaw, o.stableDecimals);
}
// a price older than 60 s is stale (the ticket shows the native figure with a note); older than 10 min is dead
export const PRICE_FRESH_MS = 60_000, PRICE_DEAD_MS = 600_000;
export type PriceState = 'fresh' | 'stale' | 'dead';
export const priceState = (at: number, now: number): PriceState => (!(at > 0) || now - at > PRICE_DEAD_MS ? 'dead' : now - at > PRICE_FRESH_MS ? 'stale' : 'fresh');
// "$1.23", "$0.004" → "<$0.01" never shows a zero for a real cost
export function fmtUsd6(u: bigint, opts: { cost?: boolean } = {}): string {
  if (u < 0n) return '−' + fmtUsd6(-u, opts);
  if (opts.cost && u > 0n && u < 10_000n) return '<$0.01';
  const cents = opts.cost ? (u + 9_999n) / 10_000n : (u + 5_000n) / 10_000n;
  const s = (cents / 100n).toLocaleString('en-US');
  return `$${s}.${String(cents % 100n).padStart(2, '0')}`;
}

// ── sizing (§3) ──
export const RULES = {
  mult: 15n,                 // ×1.5 (tenths)
  tradingMin6: 10n * USD,
  tradingMax6: 250n * USD,
  lowPct: 60n, highPct: 200n,
  sameChainMin6: 5n * USD,
  crossChainMin6: 100n * USD,
  // a waiting click moves any amount from $0.10 (owner 2026-10-27: "make it from 10 cents"): its own swap and motion's bridge
  clickMin6: USD / 10n,
  clickMarginPct: 125n,      // a click tops W up to its need + 25 % (the platform fee, the swap's fee, the price's move)
  activeMs: 7 * 86_400_000,
  walletPct: 30n,            // floats ≤ 30 % of the wallet
};
// ── the ready float after a trade (owner 2026-10-29, «да добавляй тоже делай»; floatEngine afterTrade) ──
// Before: W's float was refilled only by the next routine tick (the app's 60 s timer, deferred inside a click / token-page
// window), so after two or three quick buys every buy took the slow hold path. Now:
//   1. a trade of W that CONFIRMED schedules one refill tick of that wallet x chain on the fast path, once no trade is between
//      its call and its broadcast (a running trade always goes first; nothing is signed while a buy is being signed);
//   2. the ready size follows the user's own buys: the largest of the presets, the p75 of the last 20 buys and the largest of
//      the last 5 (readySize6); while the user trades in a burst (>= 2 buys reported, or >= 2 trade clicks of this frame, on
//      this chain in the last 60 s) the float holds 4 buys instead of 1.5 — a refill lands ~4 s after the buy it follows
//      (confirmation, plan, top-up, landing), so at a buy every 2 s about two are in flight (simulated 2026-10-29: 3 holds of
//      5 at 3 buys, 2 at 4; B:\tmp\float-direct\ab\refill-sim.mjs) — within the per-chain cap and the $250 ceiling, as before;
//   3. that refill tops W up to the target as soon as it is under it (not only under the 60 % low band), from $1;
//   4. the sweep W -> R of a surplus waits 5 minutes after the last trade while the user is in a burst (re-entry is likely:
//      the surplus a sell left is the next buy's float); otherwise the usual 60 s quiet rule.
export const REFILL = { lastN: 5, burstMs: 60_000, burstBuys: 2, burstMultTenths: 40n, normalMultTenths: 15n, min6: 1_000_000n, sweepHoldMs: 300_000, delayMs: 150, waitMs: 15_000 } as const;
export type BuyMark = { usd6: bigint; at: number };
export function burstOf(buys: BuyMark[], now: number): boolean {
  return buys.filter((b) => now - b.at < REFILL.burstMs).length >= REFILL.burstBuys;
}
/** The size the ready float is kept for: max(largest preset, p75 of the last 20 buys, largest of the last 5). */
export function readySize6(presets6: bigint[], buys6: bigint[]): bigint {
  let size = sizeOf(presets6, buys6);
  for (const x of buys6.slice(-REFILL.lastN)) if (x > size) size = x;
  return size;
}
/** The target multiplier (tenths): 4 buys while the user buys in a burst, else the usual 1.5. */
export const readyMultTenths = (burst: boolean): bigint => (burst ? REFILL.burstMultTenths : REFILL.normalMultTenths);
/** Sweep W -> R now? Only on the quiet rule (`quiet`), and in a burst only REFILL.sweepHoldMs after the last trade. */
export function sweepAllowed(o: { quiet: boolean; burst: boolean; lastTradeAt: number; now: number }): boolean {
  return o.quiet && (!o.burst || o.now - o.lastTradeAt >= REFILL.sweepHoldMs);
}
// largest preset on the chain, or the 75th percentile of the last 20 buys, whichever is larger
export function sizeOf(presets6: bigint[], buys6: bigint[]): bigint {
  let size = presets6.reduce((m, x) => (x > m ? x : m), 0n);
  const last = buys6.slice(-20).filter((x) => x > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (last.length) { const p75 = last[Math.min(last.length - 1, Math.floor(last.length * 0.75))]; if (p75 > size) size = p75; }
  return size;
}
export type Target = { trading6: bigint; low6: bigint; high6: bigint; gasFloor: bigint };
export function targetOf(chain: FloatChain, size6: bigint, active: boolean, perChain6: bigint, multTenths: bigint = RULES.mult): Target {
  const max = perChain6 < RULES.tradingMax6 ? perChain6 : RULES.tradingMax6;
  let t = active ? (size6 * multTenths) / 10n : 0n;
  if (active) { if (t < RULES.tradingMin6) t = RULES.tradingMin6; if (t > max) t = max; }
  return { trading6: t, low6: (t * RULES.lowPct) / 100n, high6: (t * RULES.highPct) / 100n, gasFloor: FLOAT_CFG[chain].gasFloor };
}
// the trading part of a float in dollars: what sits above the gas floor
export const tradingUsd6 = (chain: FloatChain, floatRaw: bigint, price6: bigint): bigint => {
  const c = FLOAT_CFG[chain]; const over = floatRaw - c.gasFloor; return over > 0n ? nativeToUsd6(over, price6, c.nativeDecimals) : 0n;
};

// ── the floor a CLICK tops W up to (2026-11-01, owner «доводи до уровня фомо … я даю добро на все»: deposit on one chain, trade
// on any) ──
// The 0.02 SOL gas floor is the background refill's (it covers many trades); a click top-up of an empty Solana wallet asked for
// all of it on top of the buy, so $2.45 a wallet elsewhere could not pay a $1 buy there. A click now tops W up to what THIS buy
// and a later full sell of it need, taken from the vault's own Solana trade checks (src/solEngine.ts, tradeOne's `need`):
//   890 880      W stays rent-exempt (RENT_WALLET; the buy check adds it to the amount)
//   2 100 000    the coin account W opens (RENT_ATA22, the larger of the two token programs)
//   1 700 000    pump.fun / PumpSwap's user volume account (RENT_UVA), opened once
//   2 039 280    PumpSwap's temporary wSOL account (RENT_ATA): asked by the buy check and again by the sell's, returned in each tx
//   2 × 1 115 000  one buy and one sell: the default "fast" plan's tip cap (1 000 000, sendPlan) + a priority allowance of 100 000
//                + the signature fee 5 000 + 10 000 of headroom (feesAt)
// = 8 960 160 lamports, rounded up to 0.009 SOL. A wallet that pins a higher tip or priority in its settings may still be refused
// by the vault's own check before anything is sent (nothing lost). EVM chains keep their gas floor (a few cents) for a click.
export const SOL_CLICK_FLOOR = 9_000_000n;
/** The native a click leaves in W on its chain for the trade's own fees and rent (the click's floor; the background keeps gasFloor). */
export const clickFloorOf = (chain: FloatChain): bigint => (chain === 'sol' ? SOL_CLICK_FLOOR : FLOAT_CFG[chain].gasFloor);
/** What a click on this chain may spend of W's float: what sits above the click's floor, in dollars. */
export const clickUsd6 = (chain: FloatChain, floatRaw: bigint, price6: bigint): bigint => {
  const over = floatRaw - clickFloorOf(chain); return over > 0n ? nativeToUsd6(over, price6, FLOAT_CFG[chain].nativeDecimals) : 0n;
};

// ── the standing permission (§10.1) ──
export type Caps ={ perDay6: bigint; feesPerDay6: bigint; perChain6: bigint; total6: bigint; maxSlipBps: number };
export const DEFAULT_CAPS: Caps = { perDay6: 1000n * USD, feesPerDay6: 2n * USD, perChain6: 250n * USD, total6: 500n * USD, maxSlipBps: 50 };
export const CAP_BOUNDS = {
  perDay6: [50n * USD, 10_000n * USD], feesPerDay6: [USD / 2n, 10n * USD], perChain6: [10n * USD, 2_500n * USD], total6: [10n * USD, 5_000n * USD], maxSlipBps: [10, 100],
} as const;
// owner 2026-10-27: "the only limits are the bridge's balances — volume caps are nonsense, remove them": moves are planned with
// no daily volume, fee, per-chain or total cap and no 30 %-of-the-wallet rule; what limits a move is what the reserves hold
// and what motion's bridge can pay. The slippage bound stays (it guards each swap's price, not an amount).
export const UNCAPPED: Caps = { perDay6: 10n ** 15n, feesPerDay6: 10n ** 15n, perChain6: 10n ** 15n, total6: 10n ** 15n, maxSlipBps: 50 };
export const plannedCaps = (c: Caps): Caps => ({ ...UNCAPPED, maxSlipBps: c.maxSlipBps });
export const PERMISSION_DAYS = 30;
export type Permission = { v: 1; wallet: string; reserve: string; chains: FloatChain[]; caps: Caps; grantedAt: number; expiresAt: number; rules?: number; digest: string };
export function capsFrom(o: { perDay?: number; feesPerDay?: number; perChain?: number; total?: number; maxSlipBps?: number } | undefined): Caps {
  const c = { ...DEFAULT_CAPS };
  if (!o) return c;
  const num = (v: unknown, lo: bigint, hi: bigint, what: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Bad arguments: ${what}`); const u = usd6(n); if (u < lo || u > hi) throw new Error(`Bad arguments: ${what} out of range`); return u; };
  if (o.perDay != null) c.perDay6 = num(o.perDay, ...CAP_BOUNDS.perDay6, 'perDay');
  if (o.feesPerDay != null) c.feesPerDay6 = num(o.feesPerDay, ...CAP_BOUNDS.feesPerDay6, 'feesPerDay');
  if (o.perChain != null) c.perChain6 = num(o.perChain, ...CAP_BOUNDS.perChain6, 'perChain');
  if (o.total != null) c.total6 = num(o.total, ...CAP_BOUNDS.total6, 'total');
  if (o.maxSlipBps != null) { const b = Number(o.maxSlipBps); if (!Number.isInteger(b) || b < CAP_BOUNDS.maxSlipBps[0] || b > CAP_BOUNDS.maxSlipBps[1]) throw new Error('Bad arguments: maxSlipBps out of range'); c.maxSlipBps = b; }
  if (c.perChain6 > c.total6) throw new Error('Bad arguments: perChain above total');
  return c;
}
// raising any cap (or adding a chain) needs the dialog; lowering or removing does not
export function capsRaise(prev: Caps | null, next: Caps): boolean {
  if (!prev) return true;
  return next.perDay6 > prev.perDay6 || next.feesPerDay6 > prev.feesPerDay6 || next.perChain6 > prev.perChain6 || next.total6 > prev.total6 || next.maxSlipBps > prev.maxSlipBps;
}
const CHAIN_NAME: Record<FloatChain, string> = { robinhood: 'Robinhood', bsc: 'BNB', sol: 'Solana' };
// the one-wallet text (the account's dialog uses accountPermissionText): the same rules in the same words (PERM.en)
export function permissionText(walletName: string, chains: FloatChain[], caps: Caps, upkeepWeek6?: bigint): string {
  const names = chains.map((c) => CHAIN_NAME[c]);
  const where = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  const natives = chains.map((c) => FLOAT_CFG[c].native).join(' / ');
  const P = PERM.en;
  return [
    `Turn on USD balance for ${walletName}. The vault may move money between this wallet's own addresses on ${where} to keep it ready to trade:`,
    P.topup(String(RULES.clickMarginPct - 100n)), P.nocap, P.gas, P.forward, P.buy, P.slip((caps.maxSlipBps / 100).toFixed(2)),
    ...(upkeepWeek6 != null ? [`Expected upkeep: about ${fmtUsd6(upkeepWeek6, { cost: true })} a week in network and pool fees.`] : []),
    `Nothing else can leave your wallets this way: only a buy you tap is paid to a pool. Ready-to-trade amounts move with the price of ${natives}. Valid for ${PERMISSION_DAYS} days.`,
    // motion's own bridge (docs/drafts/MOTION-BRIDGE.md): the one line the user reads before any of this can use it
    'When the money is on another chain, motion may pay you on this one from its own funds as soon as your transfer is included — and if it cannot, your transfer comes straight back.',
  ].join('\n');
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function permissionDigest(p: Omit<Permission, 'digest'>): string {
  const canon = JSON.stringify({ v: p.v, wallet: p.wallet.toLowerCase(), reserve: p.reserve.toLowerCase(), chains: [...p.chains].sort(), caps: { perDay6: String(p.caps.perDay6), feesPerDay6: String(p.caps.feesPerDay6), perChain6: String(p.caps.perChain6), total6: String(p.caps.total6), maxSlipBps: p.caps.maxSlipBps }, grantedAt: p.grantedAt, expiresAt: p.expiresAt, ...rulesCanon(p) });
  return hex(sha256(new TextEncoder().encode(canon)));
}
export const permissionLive = (p: Permission | null | undefined, now: number, accepted: number = FLOAT_RULES.accepted): p is Permission => !!p && p.v === 1 && p.expiresAt > now && rulesOf(p) >= accepted && termsOk(p) && permissionDigest(p) === p.digest;
/**
 * (2026-11-02, review H2) The terms a grant may carry are the ones `configure` can write: every cap inside CAP_BOUNDS (slippage
 * 0.10–1.00 %), per chain at most the total, and at most PERMISSION_DAYS between grantedAt and expiresAt; with `now`, a grant
 * dated more than TERMS_SKEW_MS in the future is refused too. An adopted account record (floatConsent judgeConsent → 'terms',
 * floatEngine consent.apply) and every stored grant / permission (accountLive, permissionLive) are held to it, so a record
 * signed with slippage 100 % or a ten-year expiry is never followed, and one already stored is not live.
 */
export const TERMS_SKEW_MS = 10 * 60_000;
export function termsOk(t: { caps?: { perDay6?: unknown; feesPerDay6?: unknown; perChain6?: unknown; total6?: unknown; maxSlipBps?: unknown } | null; grantedAt?: unknown; expiresAt?: unknown } | null | undefined, now?: number): boolean {
  const c = t?.caps; if (!t || !c) return false;
  const n = (v: unknown): bigint | null => { try { const s = String(v); return /^\d{1,30}$/.test(s) ? BigInt(s) : null; } catch { return null; } };
  const inB = (v: unknown, b: readonly [bigint, bigint]) => { const x = n(v); return x != null && x >= b[0] && x <= b[1]; };
  if (!inB(c.perDay6, CAP_BOUNDS.perDay6) || !inB(c.feesPerDay6, CAP_BOUNDS.feesPerDay6) || !inB(c.perChain6, CAP_BOUNDS.perChain6) || !inB(c.total6, CAP_BOUNDS.total6)) return false;
  if ((n(c.perChain6) as bigint) > (n(c.total6) as bigint)) return false;
  const slip = Number(c.maxSlipBps); if (!Number.isInteger(slip) || slip < CAP_BOUNDS.maxSlipBps[0] || slip > CAP_BOUNDS.maxSlipBps[1]) return false;
  const g = Number(t.grantedAt), e = Number(t.expiresAt);
  if (!Number.isSafeInteger(g) || !Number.isSafeInteger(e) || g < 1 || e <= g || e - g > PERMISSION_DAYS * 86_400_000) return false;
  return now == null || g <= now + TERMS_SKEW_MS;
}

// ── what a grant agreed to: its RULES version, never its wording (2026-10-27; a user: "i turned on usd balance yday and
// its asking me to do it again today") ──
// A grant (AccountGrant, and each wallet's Permission) binds to the substance the user said yes to: the wallets, the chains,
// the caps, the dates, and the rules version below. It never binds to the text the dialog showed (reworded freely, six
// languages), to the engine build or to a release: a newer build reads the same record and computes the same digest
// (test/float-reconsent.mjs; the real builds of 26-27 Oct were also run against each other in a browser, nothing re-asked).
// FLOAT_RULES.current goes up ONLY when the vault may do something the older rules did not allow AND that needs a new yes;
// `accepted` follows it. A grant on older rules then stops being live, and the next switch asks only for what changed (one
// line of RULES_DELTA, the rules folded under it): no conversion, the grant's dates unchanged.
// Absent = rules 1 = every grant made up to 2026-10-27: no stored record has the field, so their digests are byte for byte
// what they were, and an older engine (a rollback) still reads a grant this one writes while `current` is 1.
// Rules 1: the vault may move money between each wallet's OWN addresses on the enabled chains to keep it ready to trade
// (top-ups R -> W, sweeps W -> R, rebalances and cold top-ups between the wallet's own reserves through a bridge, motion's
// bridge paying first from its own funds), each swap slippage-bounded; nothing can leave the wallets. What came after the
// first grants and does NOT bump it (2026-10-26/27), because it stays inside that sentence or only gives:
//   - no volume caps: the limits were the vault's own pacing, not a right the user handed out; what may move, from where
//     and to where is unchanged (ALLOWED_MOVES), nothing new can leave, and the slippage bound stays;
//   - the gas drop: motion SENDS a reserve a little gas; nothing of the user's moves;
//   - USDG / USDC sent straight to W joins R: W -> R, an own-address move of the kind rules 1 names (R pays W's fee only);
//   - a Solana reserve as a cross-chain donor through motion's bridge: the bridge line, from the wallet's own reserve.
// Rules 2 (owner 2026-10-29: «да делай давай» — "bump the consent rules so users re-confirm that the reserve may buy coins
// for them"): a buy the user taps in USD may be paid straight from the wallet's own reserve — R signs ONE transaction that
// spends its stable and delivers the coin to W (float.buy, src/floatDirect.ts). The stable leaves the wallet's addresses for a
// pool, which rules 1 ("nothing can leave the wallets") did not allow: a new yes. A grant on rules 1 stops being live; the
// next switch asks for that one line (RULES_DELTA[2]), no conversion, its dates kept. float.buy also checks rules >= 2 itself.
export const FLOAT_RULES: RulesCfg = Object.freeze({ current: 2, accepted: 2 });
/** The first rules version that lets the reserve buy a coin for its wallet (float.buy). */
export const DIRECT_BUY_RULES = 2;
export type RulesCfg = { readonly current: number; readonly accepted: number };
export const rulesOf = (x: { rules?: unknown } | null | undefined): number => (x && Number.isInteger(x.rules) && (x.rules as number) >= 1 ? (x.rules as number) : 1);
// the field is in the digest only when a record carries it (a rules-1 record never does)
const rulesCanon = (x: { rules?: unknown }) => (x.rules !== undefined ? { rules: x.rules } : {});
/** The `rules` field a new record carries: none for rules 1 (the format every engine reads), else the version. */
export const rulesField = (v: number): { rules?: number } => (v > 1 ? { rules: v } : {});

// ── the plan (§5) ──
export type MoveKind = 'topup' | 'sweep' | 'rebalance' | 'cold' | 'gas';
// allowed pairs only: what may move, from where, to where (the vault refuses anything else before it signs)
export const ALLOWED_MOVES: Record<MoveKind, { from: 'R' | 'W'; to: 'R' | 'W'; asset: 'stable→native' | 'native→stable' | 'stable→stable' | 'native→native'; crossChain: boolean }> = {
  topup: { from: 'R', to: 'W', asset: 'stable→native', crossChain: false },
  cold: { from: 'R', to: 'W', asset: 'stable→native', crossChain: true },
  rebalance: { from: 'R', to: 'R', asset: 'stable→stable', crossChain: true },
  sweep: { from: 'W', to: 'R', asset: 'native→stable', crossChain: false },
  gas: { from: 'W', to: 'R', asset: 'native→native', crossChain: false },
};
export type ChainState = {
  price6: bigint; priceAt: number;
  float: bigint;            // W's native balance (raw)
  reserve: bigint;          // R's stable balance (raw)
  reserveNative: bigint;    // R's native (its gas)
  active: boolean;          // a page of this chain open, or a trade on it in the last 7 days
  presets6: bigint[]; buys6: bigint[];
  inFlight6: bigint;        // already on its way to W's float (sent, not landed)
  inFlightReserve6: bigint; // on its way to R's reserve on this chain (a bridge in flight)
  idle: boolean;            // W may send now: the sweep quiet rule (quietFor: no click window, no trade / ticket touch for 60 s, no limit placing)
  busyBridge: boolean;      // a cross-chain move to this chain started in the last 2 min (any device): no second one
  burst?: boolean;          // the user buys on this chain in a burst (REFILL): the float holds 4 buys
  refill?: boolean;         // this plan is the after-trade refill of this chain (REFILL): W goes back to its target from $1
  // ready dollars (READY, 2026-11-01 pass 3): the user bought on this chain in the last 7 days, and this chain's snapshot is
  // recent enough (and newer than the last cross-chain arrival into it) for a background move to be planned from it
  traded?: boolean; readyOk?: boolean;
  // W's native the user chose to KEEP as native when the switch went on (2026-11-01, owner «я даю добро на все»: "why does it
  // ask me to convert when I already have $800 USDC?"): the routine sweep never converts it — only what arrives above it
  keep?: bigint;
  // (usd-mode2 2026-11-05, B:/tmp/usd-mode-1105 follow-up: a tester's wallet kept getting R's USDG swapped into ETH, "for buys",
  // while his buys were paid by R) buys on this chain are paid straight from the reserve (float.buy, rules >= 2): W keeps no
  // ready-native buffer here. No routine top-up ('below low', 'refill') and no cross-chain move for one; W keeps what it holds
  // (its gas floor is never swept) and the sweep's threshold is the one of before (a sell's proceeds above it still join R).
  // A waiting click (hold & fire, a market R cannot buy) still tops W up for itself. Left out = the buffer of before
  directPays?: boolean;
};
export type PlanInput = {
  now: number; caps: Caps; chains: Partial<Record<FloatChain, ChainState>>; enabled: FloatChain[];
  walletUsd6: bigint;              // the whole wallet in dollars (floats + reserves + coins at mark)
  movedToday6: bigint; feesToday6: bigint;
  estFee6: (kind: MoveKind, chain: FloatChain, from?: FloatChain) => bigint;
  urgent?: { chain: FloatChain; usd6: bigint };   // a click is waiting (hold & fire)
  urgentFrom?: FloatChain[];   // the reserves the clicking frame can sign a cold top-up from by itself (tried first)
  // reserves the clicking frame can ALSO sign for, tried only after every urgentFrom reserve (2026-10-27: the Solana reserve
  // from an EVM frame) — unless one of them alone covers what the urgentFrom reserves together cannot. Left out = as before
  urgentLater?: FloatChain[];
  // the largest ONE cross-chain part of a click's top-up through motion's bridge (XCHAIN; the solver's per-fill cap when it
  // names a lower one). Left out = XCHAIN.part6
  partMax6?: bigint;
  // ready dollars (READY): given = a routine background plan may pre-position the reserves of the chains the user trades.
  // `feesDay6` = what such moves cost this wallet in the last 24 h; `from` = the reserves a public bridge can send from (EVM).
  // Left out (a click, the after-trade refill, older callers, the tests of before) = the plan is exactly as before
  ready?: { feesDay6: bigint; from: FloatChain[] };
  // a click is planned all or nothing (TC-1, 2026-11-04, B:/tmp/usd-scenarios + B:/tmp/usd-buy-final): when everything this frame
  // can reach for it (W here, this chain's reserve, the reserves it can sign a cold top-up from within XCHAIN, and `urgentExtra6`:
  // what the wallet's own native on the other EVM chains can bring, the engine's estimate) cannot pay the bare need (the buy + W's
  // floor + what the moves may lose), NO move is planned for it and `short.infeasible` says what it can pay instead. The engine
  // leaves it out while a move into this chain is still landing or settling (its dollars are not in the read yet). Left out = as before
  urgentAtomic?: boolean;
  urgentExtra6?: bigint;
  // TC-1: the reserves whose cold top-up for this click runs in THIS frame (the engine knows: its own chain, the EVM reserves
  // through motion's bridge, the Solana reserve when it can pay its transfer). Left out = every other reserve counts (optimistic)
  urgentSign?: FloatChain[];
  // (usd-mode 2026-11-05, B:/tmp/usd-mode-1105: a tester's 100 USDG went Robinhood → BNB through Relay right after his deposit,
  // though he never bought on BNB; the BNB reserve and wallet hold no BNB, so those dollars could not even be used there): a
  // routine cross-chain rebalance 'local reserve short' goes INTO a chain only when the user bought there in the last 7 days
  // (`traded`), not because a page of it was open (`active`). A click's own cold top-up is unchanged. Left out = as before
  crossNeedsTrade?: boolean;
  // (usd-mode2 2026-11-05) the reserve's gas comes from motion's gas drop (the engine asks it), never from W in a ROUTINE plan:
  // W sends R gas only in front of a click that waits for R (job reason 'reserve gas', click). A tester saw his wallet send its
  // reserve 0.0000868 ETH on a background tick. Left out = as before (W refills R's gas whenever idle)
  gasFromWClickOnly?: boolean;
};
// ── a click's cross-chain top-up in parts (2026-11-01 pass 2, owner «я даю добро на все … главное скорость и стабильность»):
// motion's bridge carries at most $1,000 a fill (the vault's MOTION_BRIDGE_MAX6 and the solver's maxFillUsd). A click whose
// cross-chain part was larger — a $900 buy wants $1,125 with its 25 % — went to ONE reserve as ONE move, which motion refused
// whole, every time (two $2,500 reserves could not pay a $900 buy). Now a reserve's share goes in parts of at most part6 ($990:
// under the cap with room for rounding), at most `parts` per click ($3,960), each part its own move and job. The parts run one
// after another, the next only once the one before it FILLED (floatEngine runMoves): one fill of the wallet in flight at a
// time (the solver allows 2), and a part never goes out behind one whose outcome is not known.
export const XCHAIN = { part6: 990n * USD, parts: 4 } as const;
/** The largest part for a solver whose health names `max6` per fill (0 / unknown = XCHAIN.part6): a cent per $1 under it. */
export const partMaxOf = (max6: bigint | null | undefined): bigint => (max6 && max6 > 0n && (max6 * 99n) / 100n < XCHAIN.part6 ? (max6 * 99n) / 100n : XCHAIN.part6);
/** What one click may carry across chains through motion's bridge, in dollars (the app's ticket: never "Paid from" above it). */
export const xchainClickMax6 = (part6: bigint = XCHAIN.part6): bigint => part6 * BigInt(XCHAIN.parts);
// ── ready dollars on every chain the user trades (2026-11-01 pass 3, proposal A1; owner «я даю добро на все … доводи до уровня
// фомо», «мы не можем проебать бабки юзеров никак строго») ──
// A click on a chain whose reserve is empty waits for a cross-chain top-up (~3 s: quote, source inclusion, payout, the hold's
// read). A click on a chain whose reserve holds its dollars is a direct buy from that reserve (~0.7 s, TRADE-CORE 2026-10-29).
// So on every chain with a buy in the last 7 days the background keeps the reserve R at 1.5 x the ready size (readySize6: the
// largest preset, the p75 of the last 20 buys, the largest of the last 5; at least $10, at most $250), moved in from the
// richest other reserve through the public bridges (Relay, then deBridge, every check of a rebalance: exact approval, pinned
// contracts, recipient = this wallet's own R, the amount minus stated fees and slippage), never through motion's bridge (that
// pays native into W, for a click). On such chains the cross-chain background minimum is $10 instead of RULES.crossChainMin6.
//   - only a routine background plan does it (never a click's, never the after-trade refill): nothing new on any click path;
//   - hysteresis: R is refilled only once under 60 % of that size, to the size;
//   - a donor keeps its own ready size when the user trades there too (no ping-pong), and only EVM reserves send (a public
//     bridge does not sign from Solana yet);
//   - the destination's snapshot must be under 5 minutes old and newer than its last cross-chain arrival, and nothing may be in
//     flight into it (a second move planned on an old read would move the same dollars twice);
//   - cost: a move's stated bridge fee may be at most $0.10 + 0.5 % of it (Relay ~ $0.05 + 0.1-0.4 %; deBridge's fixed 0.001
//     ETH never passes at these sizes), and all of a wallet's ready-dollar moves at most $1 per rolling 24 h. Every such job
//     carries `ready` and reason READY.reason; the ledger states their fees apart (readyFeesOf) and in "upkeep this week".
// Worst case: the user's own dollars sit in another of the user's own reserves, minus at most $1 a day of bridge fees.
export const READY = {
  tradedMs: 7 * 86_400_000, min6: 10n * USD, multTenths: 15n, lowPct: 60n,
  feeBase6: USD / 10n, feeBps: 50n, dayFees6: USD, snapMs: 300_000, reason: 'ready dollars',
} as const;
/** The reserve a traded chain keeps (1.5 x the ready size, $10-$250). */
export const readyTarget6 = (presets6: bigint[], buys6: bigint[]): bigint => {
  const t = (readySize6(presets6, buys6) * READY.multTenths) / 10n;
  return t < RULES.tradingMin6 ? RULES.tradingMin6 : t > RULES.tradingMax6 ? RULES.tradingMax6 : t;
};
/** The most a ready-dollar move of `amount6` may cost in stated bridge fees. */
export const readyFeeMax6 = (amount6: bigint): bigint => READY.feeBase6 + (amount6 * READY.feeBps) / 10_000n;
/** A wallet's ready-dollar jobs over the last 24 h and 7 days: their fees and what they moved (the ledger line; the day budget). */
export function readyFeesOf(jobs: readonly FloatJob[], now: number): { day6: bigint; week6: bigint; movedWeek6: bigint; moves: number } {
  let day6 = 0n, week6 = 0n, movedWeek6 = 0n, moves = 0;
  for (const j of jobs) {
    if (!j.ready || j.state === 'planned') continue;
    // a move refused before anything was sent cost nothing; one that may have left (or did) counts its fee
    if (j.state === 'failed' && !j.hashes.length) continue;
    let f = 0n, u = 0n; try { f = BigInt(j.fee6 || '0'); u = BigInt(j.usd6 || '0'); } catch { /* a bad line counts nothing */ }
    if (now - j.at < 86_400_000) day6 += f;
    if (now - j.at < 7 * 86_400_000) { week6 += f; movedWeek6 += u; moves += 1; }
  }
  return { day6, week6, movedWeek6, moves };
}
export type Move = { kind: MoveKind; chain: FloatChain; from?: FloatChain; usd6: bigint; fee6: bigint; reason: string; trimmed?: boolean; ready?: boolean };
export type Skip = { chain: FloatChain; why: 'stale-price' | 'cap-total' | 'cap-day' | 'cap-fees' | 'no-reserve' | 'below-min' | 'bridge-busy' | 'no-gas' | 'not-traded' };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** What a click still lacks after every move the plan found. TC-1: `infeasible` = nothing was planned for it (it could not be paid
 *  at all), `can6` = the largest buy everything it can reach would pay (after the floor and the moves' losses). */
export type PlanShort = { chain: FloatChain; usd6: bigint; infeasible?: boolean; can6?: bigint };
export function planMoves(input: PlanInput): { moves: Move[]; skips: Skip[]; short?: PlanShort } {
  const moves: Move[] = []; const skips: Skip[] = [];
  // what a waiting click still lacks after every move this plan could find for it (no donor, or donors too poor)
  let short: PlanShort | undefined;
  const { caps, now } = input;
  const live = input.enabled.filter((c) => input.chains[c]);
  const stateOf = (c: FloatChain) => input.chains[c]!;
  // the floats' cap: min($total, 30 % of the wallet), in-flight amounts included
  const floatsNow = live.reduce((s, c) => { const x = stateOf(c); return s + tradingUsd6(c, x.float, x.price6) + x.inFlight6; }, 0n);
  let floatRoom = caps.total6 >= UNCAPPED.total6 ? caps.total6 : min(caps.total6, (input.walletUsd6 * RULES.walletPct) / 100n) - floatsNow;
  let dayRoom = caps.perDay6 - input.movedToday6;
  let feeRoom = caps.feesPerDay6 - input.feesToday6;
  const take = (m: Omit<Move, 'fee6'>): boolean => {
    const fee6 = input.estFee6(m.kind, m.chain, m.from);
    if (fee6 > feeRoom) { skips.push({ chain: m.chain, why: 'cap-fees' }); return false; }
    // the newest intent wins when a cap binds: the move is sized to the room left (and says so). A sweep is not counted
    // against the day's cap (2026-10-26): it only ever moves W's own surplus to R, priced by the
    // oracle check, and a deposit of a few thousand dollars has to become USD within a minute, not over days.
    const dayCapped = m.kind !== 'sweep';
    let u = m.usd6; let trimmed = false; let why: Skip['why'] = 'below-min';
    if (dayCapped && u > dayRoom) { u = dayRoom; trimmed = true; why = 'cap-day'; }
    if ((m.kind === 'topup' || m.kind === 'cold') && u > floatRoom) { u = floatRoom; trimmed = true; why = 'cap-total'; }
    const floor = m.kind === 'gas' ? 1n : /^click/.test(m.reason) ? RULES.clickMin6 : m.reason === 'refill' ? REFILL.min6 : m.ready ? READY.min6 : m.kind === 'rebalance' || m.kind === 'cold' ? RULES.crossChainMin6 : RULES.sameChainMin6;
    if (u < floor) { skips.push({ chain: m.chain, why }); return false; }
    moves.push({ ...m, usd6: u, fee6, ...(trimmed ? { trimmed } : {}) });
    if (dayCapped) dayRoom -= u;
    feeRoom -= fee6; if (m.kind === 'topup' || m.kind === 'cold') floatRoom -= u;
    return true;
  };
  // reserves left after this plan's own moves (a donor is never counted twice)
  const left = new Map<FloatChain, bigint>(live.map((c) => [c, stableToUsd6(stateOf(c).reserve, FLOAT_CFG[c].stable.decimals)]));
  // READY: a routine background plan whose day budget for ready-dollar moves is not spent
  // (reviewer 2026-11-01: the budget is spent as the plan takes moves - each ready move adds its fee estimate, the plan's $0.40
  // bridge placeholder + gas, which is above Relay's stated fee at these sizes - so one plan with two traded destinations cannot
  // pass the same $0.99 twice; the bound is $1 + the last move's own fee)
  let readyFees6 = input.ready ? input.ready.feesDay6 : 0n;
  const readyRoomNow = () => !!input.ready && !input.urgent && readyFees6 < READY.dayFees6;
  const readyRoom = readyRoomNow();
  const readyTook = () => { readyFees6 += moves[moves.length - 1].fee6; };
  // the urgent chain first, then the rest in a fixed order
  const order = [...live].sort((a, b) => (a === input.urgent?.chain ? -1 : b === input.urgent?.chain ? 1 : FLOAT_CHAIN_KEYS.indexOf(a) - FLOAT_CHAIN_KEYS.indexOf(b)));
  for (const c of order) {
    const x = stateOf(c); const cfg = FLOAT_CFG[c];
    // TC-1: the moves this chain's turn adds (its reserve's gas first) — taken back when the click turns out infeasible
    const movesAt = moves.length;
    if (priceState(x.priceAt, now) === 'dead' || !(x.price6 > 0n)) { skips.push({ chain: c, why: 'stale-price' }); continue; }
    // R needs its own gas before it can move anything: refilled from W's float above its gas floor (an idle W send)
    if (x.reserveNative < cfg.reserveGas / 2n && (left.get(c) ?? 0n) > 0n) {
      const want = cfg.reserveGas - x.reserveNative;
      // owner 2026-10-27: after the switch-on conversion W sat at its gas floor and R had no gas, so nothing could top up and
      // every buy failed. A waiting click may take R's gas from W down to a quarter of W's floor (a BNB buy needs ~0.00002 BNB of
      // gas, the floor is 0.001); when even that is not there, this
      // chain's reserve is set aside for this plan and the click takes the cold top-up from another chain's reserve (motion's
      // bridge pays the native straight to W — R here needs no gas for it)
      const urgentHere = input.urgent?.chain === c;
      const spare = x.float - (urgentHere ? cfg.gasFloor / 4n : cfg.gasFloor);
      // a Solana reserve that already holds what its own top-up costs (SOL_GAS.enough: the swap's fees + the temporary wSOL
      // rent with R staying rent-exempt; motion's gas drop leaves 0.003 SOL) pays it itself in front of a waiting click: the
      // click no longer waits for a W → R gas send to land first (2026-10-28: "SOL ready" ~12 s after the tap). W refills R
      // later, while idle (the rule below, unchanged for background ticks)
      const solPaysOwn = c === 'sol' && x.reserveNative >= SOL_GAS.enough;
      if (spare > want && (x.idle || urgentHere) && !(urgentHere && solPaysOwn) && !(input.gasFromWClickOnly && !urgentHere)) take({ kind: 'gas', chain: c, usd6: nativeToUsd6Up(want, x.price6, cfg.nativeDecimals), reason: 'reserve gas' });
      // a Solana reserve that already holds what its own moves cost (motion's gas drop, SOL_GAS) pays them itself when W cannot
      // spare its gas (2026-10-27) or a click is waiting; with W able to spare it later, the old rule (W refills R while idle) stands
      else if (solPaysOwn && (urgentHere || !(spare > want))) { /* R pays its own fees */ }
      else { skips.push({ chain: c, why: 'no-gas' }); left.set(c, 0n); if (!urgentHere) continue; }
    }
    const tgt = targetOf(c, readySize6(x.presets6, x.buys6), x.active, caps.perChain6, readyMultTenths(!!x.burst));
    const now6 = tradingUsd6(c, x.float, x.price6) + x.inFlight6;
    const urgentNeed = input.urgent?.chain === c ? input.urgent.usd6 : 0n;
    if (urgentNeed > 0n) {
      // a waiting click (owner 2026-10-27: a $120 buy got a $115 top-up and failed): W goes to the need + 25 %; this chain's
      // reserve swaps what it holds, and whatever it cannot cover comes from the other reserves through motion's bridge at once
      // (any amount from $0.10 — before, a remainder under $5 was dropped and a bridge move needed $100)
      // + W's own gas floor when W is below it (2026-11-01): tradingUsd6 counts only what sits above the floor, so a click on a
      // chain where W holds nothing got exactly its need + 25 % and W's ready stayed below the click (Solana: 0.02 SOL ≈ $1.90
      // short) — hold & fire waited its whole 15 s, then "buying anyway". The native donor already adds it (nativeDonorNeed)
      // (the click's floor, clickFloorOf: 0.009 SOL on Solana — what this buy and its later sell need — instead of the
      // background's 0.02; W's float is counted above that same floor, so a W between the two floors is not topped up twice)
      const cf = clickFloorOf(c);
      const deficit6 = x.float < cf ? nativeToUsd6Up(cf - x.float, x.price6, cfg.nativeDecimals) : 0n;
      const want6 = (urgentNeed * RULES.clickMarginPct) / 100n + deficit6;
      const clickNow6 = clickUsd6(c, x.float, x.price6) + x.inFlight6;
      // PROPOSAL TC-1 (2026-11-04, B:/tmp/usd-scenarios, the owner's $540 Robinhood buy): before, a click its reserves could not pay
      // still moved everything they held (the whole $239 BNB reserve became ETH in W) and the page waited 15 s for a figure W could
      // never reach. Now the plan first adds up what this click can reach at all; below the bare need it plans NOTHING for it (no
      // swap, no bridge, no gas move) and says what it can pay. A move landing here right now (bridge-busy) keeps the old answer
      if (input.urgentAtomic && clickNow6 < want6 && !(x.busyBridge || x.inFlightReserve6 > 0n)) {
        const bare6 = urgentNeed + deficit6;
        const part6 = input.partMax6 && input.partMax6 > 0n ? input.partMax6 : XCHAIN.part6;
        // only the reserves this frame signs a cold top-up from (no solver = none): a move planned from any other one never runs here
        // (review usd-buy-final) a reserve counts only when it holds more than its own move's fee estimate: a dust reserve would
        // add less reach than "loss" and turn a payable click infeasible
        // (release #3 gate, F2b) every signable reserve decides whether this click could move anything at all (the guard below);
        // reach and loss count only the reserves above their own move fee (F2): a click whose only reserve is dust is refused, not bridged
        const signableAll = live.filter((d) => d !== c && (!input.urgentSign || input.urgentSign.includes(d)) && (left.get(d) ?? 0n) >= RULES.clickMin6);
        const signable = signableAll.filter((d) => (left.get(d) ?? 0n) > input.estFee6('cold', c, d));
        const cross6 = min(signable.reduce((t, d) => t + (left.get(d) ?? 0n), 0n), part6 * BigInt(XCHAIN.parts));
        const local6 = left.get(c) ?? 0n;
        const reach6 = clickNow6 + local6 + cross6 + (input.urgentExtra6 && input.urgentExtra6 > 0n ? input.urgentExtra6 : 0n);
        // what the moves may lose on the way: each swap / payout within the slippage bound, and each move's own fee estimate
        const moved6 = bare6 > clickNow6 ? bare6 - clickNow6 : 0n;
        const loss6 = (moved6 * BigInt(caps.maxSlipBps)) / 10_000n + (local6 >= RULES.clickMin6 ? input.estFee6('topup', c) : 0n) + signable.reduce((t, d) => t + input.estFee6('cold', c, d), 0n);
        // only when the reserves could move something for it: a click no reserve can reach plans nothing either way (the old answer)
        if (local6 + cross6 + signableAll.filter((d) => !signable.includes(d)).reduce((t, d) => t + (left.get(d) ?? 0n), 0n) >= RULES.clickMin6 && reach6 < bare6 + loss6) {
          moves.splice(movesAt);
          skips.push({ chain: c, why: 'no-reserve' });
          short = { chain: c, usd6: bare6 + loss6 - reach6, infeasible: true, can6: reach6 > loss6 + deficit6 ? reach6 - loss6 - deficit6 : 0n };
          continue;
        }
      }
      if (clickNow6 < want6) {
        let rest = want6 - clickNow6;
        const local = left.get(c) ?? 0n;
        const here = min(rest, local);
        if (here >= RULES.clickMin6 && take({ kind: 'topup', chain: c, usd6: here, reason: 'click' })) { const got = moves[moves.length - 1].usd6; rest -= got; left.set(c, local - got); }
        if (rest >= RULES.clickMin6) {
          if (x.busyBridge || x.inFlightReserve6 > 0n) skips.push({ chain: c, why: 'bridge-busy' });
          else {
            // the richest reserves first, as many as it takes
            // the reserves this frame can sign for itself first (input.urgentFrom: no other frame needs to be open), each group richest first
            // input.urgentLater: signable here too, but after them — or first when one of them alone covers what they cannot together
            const pool = live.filter((d) => d !== c && (left.get(d) ?? 0n) >= RULES.clickMin6);
            const ownSum = pool.filter((d) => input.urgentFrom?.includes(d)).reduce((t, d) => t + (left.get(d) ?? 0n), 0n);
            const ownFrame = (d: FloatChain) => (!input.urgentFrom ? 0 : input.urgentFrom.includes(d) ? 1 : input.urgentLater?.includes(d) ? (ownSum < rest && (left.get(d) ?? 0n) >= rest ? 0 : 2) : 3);
            const donors = pool.sort((a, b) => ownFrame(a) - ownFrame(b) || ((left.get(b) ?? 0n) > (left.get(a) ?? 0n) ? 1 : -1));
            if (!donors.length) skips.push({ chain: c, why: 'no-reserve' });
            // each reserve's share in parts under motion's per-fill cap (XCHAIN), at most XCHAIN.parts for the whole click
            const part6 = input.partMax6 && input.partMax6 > 0n ? input.partMax6 : XCHAIN.part6;
            let parts = 0;
            for (const donor of donors) {
              while (rest >= RULES.clickMin6 && parts < XCHAIN.parts && (left.get(donor) ?? 0n) >= RULES.clickMin6) {
                const chunk = min(min(rest, left.get(donor)!), part6);
                if (!take({ kind: 'cold', chain: c, from: donor, usd6: chunk, reason: 'click, no local reserve' })) break;
                const got = moves[moves.length - 1].usd6; rest -= got; left.set(donor, left.get(donor)! - got); parts += 1;
              }
            }
            if (rest >= RULES.clickMin6) short = { chain: c, usd6: rest };
          }
        }
      }
      continue;
    }
    const want6 = x.directPays ? 0n : tgt.trading6;   // usd-mode2: no ready buffer where R pays the buys
    const refillNow = !!x.refill && want6 > 0n && now6 >= tgt.low6 && want6 - now6 >= REFILL.min6;
    if (want6 > 0n && (now6 < tgt.low6 || refillNow)) {
      const need = want6 - now6;
      const local = left.get(c) ?? 0n;
      let covered = 0n;
      if (local >= (x.refill ? REFILL.min6 : RULES.sameChainMin6)) {
        const amt = min(need, local);
        if (take({ kind: 'topup', chain: c, usd6: amt, reason: x.refill ? 'refill' : 'below low' })) { covered = moves[moves.length - 1].usd6; left.set(c, local - covered); }
      }
      const rest = need - covered;
      // a reserve elsewhere is asked only below the low band (a refill above it never starts a bridge move)
      if (!refillNow && rest >= RULES.sameChainMin6) {
        if (input.crossNeedsTrade && !x.traded) skips.push({ chain: c, why: 'not-traded' });
        else if (x.busyBridge || x.inFlightReserve6 > 0n) skips.push({ chain: c, why: 'bridge-busy' });
        else {
          // the richest other reserve that can send at least the cross-chain chunk: reserves rebalance, the next plan tops up locally
          // (READY: on a chain the user trades, from $10 instead of $100 - from a reserve a public bridge can send from)
          const lowMin = readyRoomNow() && !!x.traded && !!x.readyOk;
          const crossMin = lowMin ? READY.min6 : RULES.crossChainMin6;
          let donor = live.filter((d) => d !== c && (left.get(d) ?? 0n) >= RULES.crossChainMin6).sort((a, b) => ((left.get(b) ?? 0n) > (left.get(a) ?? 0n) ? 1 : -1))[0];
          if (!donor && lowMin) donor = live.filter((d) => d !== c && input.ready!.from.includes(d) && (left.get(d) ?? 0n) >= crossMin).sort((a, b) => ((left.get(b) ?? 0n) > (left.get(a) ?? 0n) ? 1 : -1))[0];
          if (!donor) skips.push({ chain: c, why: 'no-reserve' });
          else {
            const chunk = min(max(rest, crossMin), left.get(donor)!);
            // a move under the old $100 minimum exists only because of READY: it carries its fee bound and the day budget
            const small = chunk < RULES.crossChainMin6;
            if (take({ kind: 'rebalance', chain: c, from: donor, usd6: chunk, reason: small ? READY.reason : 'local reserve short', ...(small ? { ready: true } : {}) })) { left.set(donor, left.get(donor)! - moves[moves.length - 1].usd6); if (small) readyTook(); }
          }
        }
      }
      continue;
    }
    // sweep: a later deposit converts itself — whenever W may send (the quiet rule, not the old 60 s idle rule), never
    // while something is landing on this chain
    // (2026-11-01) the native the user kept when the switch went on is not swept: only what arrives above it
    const kept6 = x.keep && x.keep > 0n ? nativeToUsd6(x.keep, x.price6, cfg.nativeDecimals) : 0n;
    const sweepable6 = now6 > kept6 ? now6 - kept6 : 0n;
    if (x.idle && x.inFlight6 === 0n && sweepable6 > tgt.high6) {
      const surplus = sweepable6 - tgt.trading6;
      if (surplus >= RULES.sameChainMin6) take({ kind: 'sweep', chain: c, usd6: surplus, reason: 'above high' });
    }
  }
  // READY: the reserve of every chain the user trades, back to its ready size once under 60 % of it (after every move above:
  // what this plan already takes from a reserve is not counted twice)
  if (readyRoom) {
    const keepOf = (d: FloatChain) => { const y = stateOf(d); return y.traded ? readyTarget6(y.presets6, y.buys6) : 0n; };
    for (const c of order) {
      const x = stateOf(c);
      if (!readyRoomNow()) break;
      if (!x.traded || !x.readyOk) continue;
      if (x.busyBridge || x.inFlightReserve6 > 0n) continue;
      if (moves.some((m) => (m.kind === 'rebalance' || m.kind === 'cold') && m.chain === c)) continue;
      const tgt = readyTarget6(x.presets6, x.buys6); const have = left.get(c) ?? 0n;
      if (have * 100n >= tgt * READY.lowPct) continue;
      const want = tgt - have; if (want < READY.min6) continue;
      const donors = input.ready!.from.filter((d) => d !== c && live.includes(d)).map((d) => ({ d, spare: (left.get(d) ?? 0n) - keepOf(d) }))
        .filter((o) => o.spare >= READY.min6).sort((a, b) => (b.spare > a.spare ? 1 : b.spare < a.spare ? -1 : 0));
      if (!donors.length) continue;
      const { d, spare } = donors[0];
      if (take({ kind: 'rebalance', chain: c, from: d, usd6: min(want, spare), reason: READY.reason, ready: true })) { left.set(d, (left.get(d) ?? 0n) - moves[moves.length - 1].usd6); readyTook(); }
    }
  }
  return { moves, skips, ...(short ? { short } : {}) };
}
// a single move asked for by the page (ensure with a $ amount), checked against the caps — refused, never trimmed
export function withinCaps(m: { kind: MoveKind; usd6: bigint; fee6: bigint }, ledger: { movedToday6: bigint; feesToday6: bigint; floatsUsd6: bigint; chainFloat6: bigint; walletUsd6: bigint }, caps: Caps): string | null {
  if (m.usd6 <= 0n) return 'Nothing to move';
  if (ledger.movedToday6 + m.usd6 > caps.perDay6) return `Over the daily cap of ${fmtUsd6(caps.perDay6)}`;
  if (ledger.feesToday6 + m.fee6 > caps.feesPerDay6) return `Over the daily fee cap of ${fmtUsd6(caps.feesPerDay6)}`;
  if (m.kind === 'topup' || m.kind === 'cold') {
    if (ledger.chainFloat6 + m.usd6 > caps.perChain6) return `Over the per-chain cap of ${fmtUsd6(caps.perChain6)}`;
    const total = min(caps.total6, (ledger.walletUsd6 * RULES.walletPct) / 100n);
    if (ledger.floatsUsd6 + m.usd6 > total) return `Over the total cap of ${fmtUsd6(total)}`;
  }
  return null;
}

// ── the price check (§5 item 4) ──
// stable → native: minOut (native raw) must be worth at least (amountIn − stated fees) × (1 − maxSlip) at the oracle.
// native → stable (sweep): minOut (stable raw) ≥ (amountIn at the oracle − fees) × (1 − maxSlip).
export function minOutFloor(dir: 'stable→native' | 'native→stable', amountIn: bigint, oracle6: bigint, chain: FloatChain, maxSlipBps: number, fees6: bigint): bigint {
  const c = FLOAT_CFG[chain];
  const keep = BigInt(10_000 - maxSlipBps);
  if (dir === 'stable→native') {
    const in6 = stableToUsd6(amountIn, c.stable.decimals) - fees6; if (in6 <= 0n) return 0n;
    return (usd6ToNative(in6, oracle6, c.nativeDecimals) * keep) / 10_000n;
  }
  const in6 = nativeToUsd6(amountIn, oracle6, c.nativeDecimals) - fees6; if (in6 <= 0n) return 0n;
  return (usd6ToStable(in6, c.stable.decimals) * keep) / 10_000n;
}
export function quoteOk(dir: 'stable→native' | 'native→stable', amountIn: bigint, minOut: bigint, oracle6: bigint, chain: FloatChain, maxSlipBps: number, fees6: bigint): string | null {
  if (!(oracle6 > 0n)) return 'No oracle price — nothing sent';
  if (minOut <= 0n) return 'The quote has no minimum — nothing sent';
  const floor = minOutFloor(dir, amountIn, oracle6, chain, maxSlipBps, fees6);
  if (floor <= 0n) return 'The fees would eat the whole amount — nothing sent';
  return minOut >= floor ? null : `The quote is below the oracle price minus ${(maxSlipBps / 100).toFixed(2)} % — nothing sent`;
}

// ── switch on = convert now; switch off = convert back (owner, 2026-10-26: "he pressed the switch and the balance became
// USDC — why should the user do anything by hand") ──
// On: every enabled chain's native in W above what stays (the trading target + the gas floor) becomes that chain's stable
// in R, one sweep per chain. Off: every R stable balance becomes W's native on the same chain, one top-up per chain (R's
// own gas native stays). Both are sized here, stated in the vault's dialog, and then never exceed what the dialog said.
export const CONVERT_ORDER_MS = 120_000;           // a confirmed conversion not run within 2 minutes is dropped (owner 2026-10-27: a stuck order blocked every buy; later sweeps take over)
export const CONVERT_TRIES = 3;                    // a conversion refused 3 times (the price check, a revert) is dropped and reported
export const CONVERT_BACK_MIN6 = USD;              // below $1 a swap's own fees eat the amount: it stays as USD and the dialog says so
export type ConvertLine = { chain: FloatChain; nativeIn: bigint; usd6: bigint; keep: bigint; price6: bigint };
export type ConvertSkip = { chain: FloatChain; why: 'stale-price' | 'below-min' };
// what stays in W on a chain: the gas floor + the trading target in native at this price (rounded UP: never below target)
export function keepOf(chain: FloatChain, x: Pick<ChainState, 'price6' | 'presets6' | 'buys6' | 'active'> & { reserveNative?: bigint }, caps: Caps): bigint {
  const cfg = FLOAT_CFG[chain];
  const tgt = targetOf(chain, sizeOf(x.presets6, x.buys6), x.active, caps.perChain6);
  const trade = x.price6 > 0n ? (tgt.trading6 * pow10(cfg.nativeDecimals) + x.price6 - 1n) / x.price6 : 0n;
  // plus R's own gas when R has none yet: the next plan moves it from W, so the reserve can always top W up again
  const rGas = x.reserveNative != null && x.reserveNative < cfg.reserveGas ? cfg.reserveGas - x.reserveNative : 0n;
  return cfg.gasFloor + trade + rGas;
}
export function planConvert(chains: Partial<Record<FloatChain, ChainState>>, enabled: FloatChain[], caps: Caps, now: number): { lines: ConvertLine[]; skips: ConvertSkip[] } {
  const lines: ConvertLine[] = []; const skips: ConvertSkip[] = [];
  for (const c of FLOAT_CHAIN_KEYS.filter((k) => enabled.includes(k))) {
    const x = chains[c];
    // a conversion is sized and priced only with a FRESH price (≤ 60 s), never a stale one
    if (!x || !(x.price6 > 0n) || priceState(x.priceAt, now) !== 'fresh') { skips.push({ chain: c, why: 'stale-price' }); continue; }
    const cfg = FLOAT_CFG[c];
    const keep = keepOf(c, x, caps);
    const nativeIn = x.float > keep ? x.float - keep : 0n;
    const u = nativeToUsd6(nativeIn, x.price6, cfg.nativeDecimals);
    if (u < RULES.sameChainMin6) { skips.push({ chain: c, why: 'below-min' }); continue; }
    lines.push({ chain: c, nativeIn, usd6: u, keep, price6: x.price6 });
  }
  return { lines, skips };
}
// "0.50 ETH", "1.5642 BNB": rounded DOWN (an amount we send), at most 4 decimals, at least 2
export function fmtNative(raw: bigint, decimals: number, symbol: string): string {
  const scale = pow10(decimals > 4 ? decimals - 4 : 0);
  const units = raw / scale; const whole = units / 10_000n; let frac = String(units % 10_000n).padStart(4, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole.toLocaleString('en-US')}.${frac} ${symbol}`;
}
// "≈ $1,167" for $100 and up, cents below
export const fmtUsdApprox = (u: bigint): string => (u >= 100n * USD ? `$${((u + USD / 2n) / USD).toLocaleString('en-US')}` : fmtUsd6(u));
const listOf = (xs: string[]) => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs[0] || '');
// the switch-on lines of the dialog (after permissionText's); read at dialog time
export function convertText(plan: { lines: ConvertLine[]; skips: ConvertSkip[] }, enabled: FloatChain[]): string[] {
  const out: string[] = [];
  const parts = plan.lines.map((l) => { const c = FLOAT_CFG[l.chain]; return `${fmtNative(l.nativeIn, c.nativeDecimals, c.native)} ≈ ${fmtUsdApprox(l.usd6)} → ${c.stable.symbol} on ${CHAIN_NAME[l.chain]}`; });
  out.push(parts.length ? `Convert now: ${parts.join('; ')}.` : 'Nothing to convert now.');
  if (plan.skips.length) out.push(`Not converted now: ${plan.skips.map((s) => `${CHAIN_NAME[s.chain]} (${s.why === 'stale-price' ? 'no fresh price' : `less than ${fmtUsd6(RULES.sameChainMin6)} above what stays ready`})`).join('; ')}.`);
  const natives = enabled.map((c) => FLOAT_CFG[c].native).join(' / ');
  out.push(`A little ${natives} stays ready on each chain for gas and quick trades. ${natives} you deposit later converts the same way.`);
  return out;
}
export type BackLine = { chain: FloatChain; stableIn: bigint; usd6: bigint };
export type BackSkip = { chain: FloatChain; usd6: bigint; why: 'below-min' };
export function planConvertBack(chains: Partial<Record<FloatChain, Pick<ChainState, 'reserve'>>>): { lines: BackLine[]; skips: BackSkip[] } {
  const lines: BackLine[] = []; const skips: BackSkip[] = [];
  for (const c of FLOAT_CHAIN_KEYS) {
    const x = chains[c]; if (!x || !(x.reserve > 0n)) continue;
    const u = stableToUsd6(x.reserve, FLOAT_CFG[c].stable.decimals);
    if (u < CONVERT_BACK_MIN6) { if (u > 0n) skips.push({ chain: c, usd6: u, why: 'below-min' }); continue; }
    lines.push({ chain: c, stableIn: x.reserve, usd6: u });
  }
  return { lines, skips };
}
// the switch-off dialog: its first line is the title's sentence
export function offText(plan: { lines: BackLine[]; skips: BackSkip[] }, maxSlipBps: number, unread: FloatChain[] = []): string[] {
  const total = plan.lines.reduce((t, l) => t + l.usd6, 0n);
  const natives = [...new Set(plan.lines.map((l) => FLOAT_CFG[l.chain].native))].join(' / ');
  return [
    `Turn off USD balance: convert ${fmtUsd6(total)} back to ${natives}.`,
    ...plan.lines.map((l) => { const c = FLOAT_CFG[l.chain]; return `- ${CHAIN_NAME[l.chain]}: ${fmtUsd6(l.usd6)} ${c.stable.symbol} → ${c.native};`; }),
    ...(plan.skips.length ? [`Stays as USD: ${plan.skips.map((s) => `${fmtUsd6(s.usd6)} ${FLOAT_CFG[s.chain].stable.symbol} on ${CHAIN_NAME[s.chain]}`).join(', ')} (too small to convert).`] : []),
    ...(unread.length ? [`Not read yet: ${listOf(unread.map((c) => CHAIN_NAME[c]))}. Any USD there converts back when you turn this off with that chain open.`] : []),
    `Each swap is checked against the on-chain price (slippage at most ${(maxSlipBps / 100).toFixed(2)} %). The reserve keeps a little of its own gas.`,
  ];
}

// ── one switch for the whole account (owner, 2026-10-26: "so you have to turn USDC on for each wallet? Why can't it be
// done for all at once?") ──
// The switch is ONE grant for every vault wallet of the account: one dialog, one trusted click (and 2FA when on). Under it
// everything stays per wallet: each wallet W still has its own reserve R, its own Permission record (the same caps, chains
// and dates as the grant), its own caps and ledger, snapshots, conversion orders and jobs. The grant itself is stored in the
// vault origin's own storage (no page can write it) and carries its digest like a Permission does. A wallet added later
// while the grant is live gets its own Permission from the grant on its next tick, without a dialog: the grant's text says
// so, and that wallet's native is then converted by the ROUTINE sweep (quiet rule, fee cap, oracle check) — never by the
// dialog-confirmed conversion, whose exemptions exist only because the dialog stated the amount.
export type AccountGrant = { v: 1; chains: FloatChain[]; caps: Caps; grantedAt: number; expiresAt: number; wallets: string[]; rules?: number; digest: string };
export function accountDigest(a: Omit<AccountGrant, 'digest'>): string {
  const canon = JSON.stringify({ v: a.v, scope: 'account', chains: [...a.chains].sort(), caps: { perDay6: String(a.caps.perDay6), feesPerDay6: String(a.caps.feesPerDay6), perChain6: String(a.caps.perChain6), total6: String(a.caps.total6), maxSlipBps: a.caps.maxSlipBps }, grantedAt: a.grantedAt, expiresAt: a.expiresAt, wallets: a.wallets.map((x) => x.toLowerCase()).sort(), ...rulesCanon(a) });
  return hex(sha256(new TextEncoder().encode(canon)));
}
export const accountLive = (a: AccountGrant | null | undefined, now: number, accepted: number = FLOAT_RULES.accepted): a is AccountGrant => !!a && a.v === 1 && a.expiresAt > now && rulesOf(a) >= accepted && termsOk(a) && accountDigest(a) === a.digest;
/** A grant that is whole and in date but agreed to rules older than `accepted`: the switch asks only for the delta. */
export const accountOutdated = (a: AccountGrant | null | undefined, now: number, accepted: number = FLOAT_RULES.accepted): boolean => accountLive(a, now, 0) && rulesOf(a) < accepted;
// a wallet the vault cannot run a USD balance for: a Privy wallet (it does not sign here) or a chain-only key
export type WalletSkipWhy = 'privy' | 'other';
export const FLOAT_LANGS = ['en', 'ru', 'zh', 'id', 'es', 'fr'] as const;
export type FloatLang = typeof FLOAT_LANGS[number];
export const langOf = (v: unknown): FloatLang => ((FLOAT_LANGS as readonly unknown[]).includes(v) ? v as FloatLang : 'en');
// the dialogs' own words in the app's six languages (owner, 2026-10-26: "translate it into every language, not only ru")
export const ACCOUNT_DIALOG: Record<FloatLang, { onTitle: string; onOk: string; offTitle: string; offOk: string }> = {
  en: { onTitle: 'Turn on USD balance', onOk: 'Turn on', offTitle: 'Turn off USD balance', offOk: 'Turn off' },
  ru: { onTitle: 'Включить баланс в USD', onOk: 'Включить', offTitle: 'Выключить баланс в USD', offOk: 'Выключить' },
  zh: { onTitle: '开启 USD 余额', onOk: '开启', offTitle: '关闭 USD 余额', offOk: '关闭' },
  id: { onTitle: 'Aktifkan saldo USD', onOk: 'Aktifkan', offTitle: 'Matikan saldo USD', offOk: 'Matikan' },
  es: { onTitle: 'Activar saldo en USD', onOk: 'Activar', offTitle: 'Desactivar saldo en USD', offOk: 'Desactivar' },
  fr: { onTitle: 'Activer le solde en USD', onOk: 'Activer', offTitle: 'Désactiver le solde en USD', offOk: 'Désactiver' },
};
const AND: Record<FloatLang, string> = { en: ' and ', ru: ' и ', zh: '和', id: ' dan ', es: ' y ', fr: ' et ' };
const listIn = (xs: string[], lang: FloatLang) => (xs.length > 1 ? xs.slice(0, -1).join(lang === 'zh' ? '、' : ', ') + AND[lang] + xs[xs.length - 1] : xs[0] || '');
// The standing consent in the app's six languages. Owner 2026-10-27: no volume caps ("the only limits are the bridge's
// balances"), so the text states the rules that hold today: a buy's top-up (need + 25 %, this chain's reserve first, the
// rest through motion's bridge), no daily or volume limit, motion's bridge from $0.10 (up to $1,000 a transfer: bridgeSolver
// MOTION_BRIDGE_MAX6), the gas drop (Robinhood / BNB: about $0.20, once a day per address and chain), stable sent straight
// to a wallet joining its USD balance (from $1), and the slippage bound, the one cap still enforced.
const RULE_USD = { bridgeMin: '$0.10', bridgeMax: '$1,000', gas: '$0.20', forwardMin: '$1' } as const;
type PermWords = {
  head: (names: string, where: string) => string; topup: (pct: string) => string; nocap: string; gas: string; forward: string; buy: string;
  slip: (v: string) => string; upkeep: (v: string) => string; later: (natives: string) => string; safe: (natives: string, days: number) => string; bridge: string;
};
const PERM: Record<FloatLang, PermWords> = {
  en: {
    head: (n, w) => `Turn on USD balance for all your wallets (${n}). The vault may move money between each wallet's own addresses on ${w} to keep it ready to trade:`,
    topup: (p) => `- a buy tops up first, to what it needs plus ${p} %: from that chain's reserve, the rest through motion's bridge;`,
    nocap: `- no daily or volume limits, only what your reserves hold; motion's bridge moves any amount from ${RULE_USD.bridgeMin}, up to ${RULE_USD.bridgeMax} per transfer;`,
    gas: `- on Robinhood and BNB, a reserve with dollars but no gas gets a little gas from motion (about ${RULE_USD.gas}, at most once a day per chain);`,
    forward: `- USDG / USDC sent straight to a wallet joins its USD balance (from ${RULE_USD.forwardMin});`,
    buy: "- a buy you tap in USD may be paid straight from that wallet's own reserve: the reserve buys the coin and it lands in the wallet, in one transaction, within these limits;",
    slip: (v) => `- slippage at most ${v} %.`,
    upkeep: (v) => `Expected upkeep: about ${v} a week per wallet in network and pool fees.`,
    later: (n) => `Wallets you add later join by themselves while this is on: their ${n} converts once the wallet is quiet, and the app tells you.`,
    safe: (n, d) => `Nothing else can leave your wallets this way: only a buy you tap is paid to a pool. Ready-to-trade amounts move with the price of ${n}. Valid for ${d} days.`,
    bridge: 'When the money is on another chain, motion may pay you on this one from its own funds as soon as your transfer is included — and if it cannot, your transfer comes straight back.',
  },
  ru: {
    head: (n, w) => `Включить баланс в USD для всех ваших кошельков (${n}). Хранилище может переводить деньги между собственными адресами каждого кошелька на ${w}, чтобы он был готов к торговле:`,
    topup: (p) => `- покупка сначала пополняется — на нужную сумму плюс ${p} %: из резерва этой сети, остальное через мост motion;`,
    nocap: `- без дневных лимитов и лимитов объёма, только то, что есть в ваших резервах; мост motion переводит любую сумму от ${RULE_USD.bridgeMin} до ${RULE_USD.bridgeMax} за перевод;`,
    gas: `- на Robinhood и BNB резерв с долларами, но без газа, получает немного газа от motion (около ${RULE_USD.gas}, не чаще раза в день на сеть);`,
    forward: `- USDG / USDC, отправленные прямо на кошелёк, добавляются к его балансу в USD (от ${RULE_USD.forwardMin});`,
    buy: '- покупку, которую вы нажали в USD, может оплатить напрямую собственный резерв кошелька: резерв покупает монету, и она приходит на кошелёк одной транзакцией, в этих пределах;',
    slip: (v) => `- проскальзывание не больше ${v} %.`,
    upkeep: (v) => `Ожидаемое обслуживание: около ${v} в неделю на кошелёк — комиссии сети и пулов.`,
    later: (n) => `Кошельки, которые вы добавите позже, подключатся сами, пока это включено: их ${n} конвертируется, когда кошелёк не занят сделками, и приложение об этом скажет.`,
    safe: (n, d) => `Иначе так ничего не может уйти из ваших кошельков: в пул платится только покупка, которую нажали вы. Суммы «готово к торговле» меняются вместе с ценой ${n}. Действует ${d} дней.`,
    bridge: 'Если деньги на другой сети, motion может заплатить вам на этой из своих средств, как только ваш перевод попадёт в блок, — а если не сможет, ваш перевод сразу вернётся.',
  },
  zh: {
    head: (n, w) => `为你的所有钱包开启 USD 余额（${n}）。保管库可以在每个钱包自己的地址之间（${w}）转移资金，让它随时可以交易：`,
    topup: (p) => `- 买入前先补足：所需金额再加 ${p} %，先用该链的储备，其余经 motion 桥补足；`,
    nocap: `- 没有每日或交易量限额，只受储备余额限制；motion 桥每笔可转 ${RULE_USD.bridgeMin} 起，最多 ${RULE_USD.bridgeMax}；`,
    gas: `- 在 Robinhood 和 BNB 上，有美元但没有 gas 的储备会从 motion 获得少量 gas（约 ${RULE_USD.gas}，每条链每天最多一次）；`,
    forward: `- 直接发送到钱包的 USDG / USDC 会并入它的 USD 余额（${RULE_USD.forwardMin} 起）；`,
    buy: '- 你以 USD 点击的买入可直接由该钱包自己的储备支付：储备买入代币并在一笔交易中转入该钱包，在这些限制之内；',
    slip: (v) => `- 滑点最多 ${v} %。`,
    upkeep: (v) => `预计维护费用：每个钱包每周约 ${v}（网络和池子手续费）。`,
    later: (n) => `开启期间，你之后添加的钱包会自动加入：钱包空闲时，其 ${n} 会转换，应用会通知你。`,
    safe: (n, d) => `除此之外不会有任何资金离开你的钱包：只有你点击的买入会付给资金池。备用交易金额随 ${n} 价格变动。有效期 ${d} 天。`,
    bridge: '如果资金在另一条链上，motion 可能会在你的转账被打包后立即用自有资金在本链支付给你；如果做不到，你的转账会立即退回。',
  },
  id: {
    head: (n, w) => `Aktifkan saldo USD untuk semua dompet Anda (${n}). Vault boleh memindahkan dana antar alamat milik setiap dompet di ${w} agar selalu siap trading:`,
    topup: (p) => `- pembelian diisi dulu sebesar kebutuhannya ditambah ${p} %: dari cadangan jaringan itu, sisanya lewat jembatan motion;`,
    nocap: `- tanpa batas harian atau batas volume, hanya sebesar isi cadangan Anda; jembatan motion memindahkan berapa pun mulai ${RULE_USD.bridgeMin}, hingga ${RULE_USD.bridgeMax} per transfer;`,
    gas: `- di Robinhood dan BNB, cadangan yang punya dolar tapi tanpa gas mendapat sedikit gas dari motion (sekitar ${RULE_USD.gas}, paling banyak sekali sehari per jaringan);`,
    forward: `- USDG / USDC yang dikirim langsung ke dompet masuk ke saldo USD-nya (mulai ${RULE_USD.forwardMin});`,
    buy: '- pembelian yang Anda ketuk dalam USD dapat dibayar langsung dari cadangan dompet itu sendiri: cadangan membeli koinnya dan koin masuk ke dompet dalam satu transaksi, dalam batas ini;',
    slip: (v) => `- slippage maksimal ${v} %.`,
    upkeep: (v) => `Perkiraan biaya perawatan: sekitar ${v} per minggu per dompet untuk biaya jaringan dan pool.`,
    later: (n) => `Dompet yang Anda tambahkan nanti ikut otomatis selama ini aktif: ${n} miliknya dikonversi saat dompet tidak sedang trading, dan aplikasi akan memberi tahu.`,
    safe: (n, d) => `Selain itu tidak ada dana yang bisa keluar dari dompet Anda: hanya pembelian yang Anda ketuk yang dibayar ke pool. Jumlah siap-trading ikut bergerak dengan harga ${n}. Berlaku ${d} hari.`,
    bridge: 'Jika dana ada di jaringan lain, motion dapat membayar Anda di jaringan ini dari dananya sendiri segera setelah transfer Anda masuk blok — dan jika tidak bisa, transfer Anda langsung kembali.',
  },
  es: {
    head: (n, w) => `Activar el saldo en USD para todas tus carteras (${n}). La bóveda puede mover dinero entre las direcciones propias de cada cartera en ${w} para tenerla lista para operar:`,
    topup: (p) => `- una compra se recarga primero, con lo que necesita más un ${p} %: desde la reserva de esa red y el resto por el puente de motion;`,
    nocap: `- sin límites diarios ni de volumen, solo lo que tengan tus reservas; el puente de motion mueve cualquier importe desde ${RULE_USD.bridgeMin} y hasta ${RULE_USD.bridgeMax} por transferencia;`,
    gas: `- en Robinhood y BNB, una reserva con dólares pero sin gas recibe un poco de gas de motion (unos ${RULE_USD.gas}, como máximo una vez al día por red);`,
    forward: `- los USDG / USDC enviados directamente a una cartera se suman a su saldo en USD (desde ${RULE_USD.forwardMin});`,
    buy: '- una compra que pulses en USD puede pagarse directamente desde la reserva propia de esa cartera: la reserva compra la moneda y llega a la cartera en una sola transacción, dentro de estos límites;',
    slip: (v) => `- deslizamiento máximo de ${v} %.`,
    upkeep: (v) => `Mantenimiento estimado: unos ${v} a la semana por cartera en comisiones de red y de pools.`,
    later: (n) => `Las carteras que añadas más tarde se unen solas mientras esto esté activo: su ${n} se convierte cuando la cartera está tranquila y la app te avisa.`,
    safe: (n, d) => `Así no puede salir nada más de tus carteras: solo una compra que pulses se paga a un pool. Los importes listos para operar varían con el precio de ${n}. Válido durante ${d} días.`,
    bridge: 'Si el dinero está en otra red, motion puede pagarte en esta con sus propios fondos en cuanto tu transferencia entre en un bloque; y si no puede, tu transferencia vuelve al instante.',
  },
  fr: {
    head: (n, w) => `Activer le solde en USD pour tous vos portefeuilles (${n}). Le coffre peut déplacer de l'argent entre les adresses propres à chaque portefeuille sur ${w} pour le garder prêt à trader :`,
    topup: (p) => `- un achat est d'abord réapprovisionné, de ce qu'il lui faut plus ${p} % : depuis la réserve de ce réseau, le reste via le pont motion ;`,
    nocap: `- aucune limite quotidienne ni de volume, seulement ce que contiennent vos réserves ; le pont motion transfère tout montant dès ${RULE_USD.bridgeMin}, jusqu'à ${RULE_USD.bridgeMax} par transfert ;`,
    gas: `- sur Robinhood et BNB, une réserve avec des dollars mais sans gas reçoit un peu de gas de motion (environ ${RULE_USD.gas}, au plus une fois par jour et par réseau) ;`,
    forward: `- les USDG / USDC envoyés directement à un portefeuille rejoignent son solde en USD (dès ${RULE_USD.forwardMin}) ;`,
    buy: '- un achat que vous lancez en USD peut être payé directement par la réserve propre de ce portefeuille : la réserve achète le jeton et il arrive dans le portefeuille en une seule transaction, dans ces limites ;',
    slip: (v) => `- glissement au plus ${v} %.`,
    upkeep: (v) => `Entretien prévu : environ ${v} par semaine et par portefeuille en frais de réseau et de pools.`,
    later: (n) => `Les portefeuilles ajoutés plus tard rejoignent automatiquement tant que ceci est actif : leur ${n} est converti quand le portefeuille est calme, et l'app vous prévient.`,
    safe: (n, d) => `Rien d'autre ne peut quitter vos portefeuilles de cette façon : seul un achat que vous lancez est payé à un pool. Les montants prêts à trader suivent le prix de ${n}. Valable ${d} jours.`,
    bridge: "Si l'argent est sur un autre réseau, motion peut vous payer sur celui-ci avec ses propres fonds dès que votre transfert est inclus — et sinon, votre transfert revient aussitôt.",
  },
};
/** The grant's text: the standing permission for every wallet, the rules that hold today (no volume caps: of `caps` only the
 *  slippage bound is stated, the one still enforced), the upkeep and the later-wallet rule. */
export function accountPermissionText(names: string[], chains: FloatChain[], caps: Caps, upkeepWeek6?: bigint, lang: FloatLang = 'en'): string {
  const P = PERM[lang];
  const where = listIn(chains.map((c) => CHAIN_NAME[c]), lang);
  const natives = chains.map((c) => FLOAT_CFG[c].native).join(' / ');
  return [
    P.head(listIn(names, lang), where), P.topup(String(RULES.clickMarginPct - 100n)), P.nocap, P.gas, P.forward, P.buy, P.slip((caps.maxSlipBps / 100).toFixed(2)),
    ...(upkeepWeek6 != null ? [P.upkeep(fmtUsd6(upkeepWeek6, { cost: true }))] : []),
    P.later(natives), P.safe(natives, PERMISSION_DAYS), P.bridge,
  ].join('\n');
}
export type WalletConvert = { name: string; plan: { lines: ConvertLine[]; skips: ConvertSkip[] } };
export type SkippedWallet = { name: string; why: WalletSkipWhy };
export type WalletBack = { name: string; plan: { lines: BackLine[]; skips: BackSkip[] }; unread: FloatChain[] };
// ── the switch's dialogs, laid out (owner, 2026-10-26, on his iPhone: "a mess of text, not adapted, ugly") ──
// One total line; a table with one row per wallet that converts (its name, a small chip per chain, its dollars on the
// right); everything not converted as ONE muted line, grouped by reason; one plain sentence; and the standing consent
// (the caps, the upkeep, the later-wallets rule, the 30 days, the bridge) inside a collapsed "Limits and details" — still
// in the dialog, only folded. The amounts are the same figures the conversion orders carry. Every dynamic string (a
// wallet's name above all) passes the caller's `esc` in the renderer below; the views hold plain text only.
export type DialogRow = { name: string; usd: string; chips: string[] };
export type DialogView = { lead: string; rows: DialogRow[]; skip: string; note: string };
// The switch follows the account (src/floatConsent.ts, owner 2026-10-28): the line the on / off dialogs add when this vault is
// linked to the account (its main is attached, so the record reaches the account's other devices)
export const ACCOUNT_DEVICES: Record<FloatLang, { on: string; off: string }> = {
  en: { on: 'Your other devices signed in to this account follow it, with no new prompt.', off: 'This turns it off on all your devices.' },
  ru: { on: 'Другие ваши устройства с этим аккаунтом включат его сами, без нового запроса.', off: 'Это выключит его на всех ваших устройствах.' },
  zh: { on: '登录此账户的其他设备会自动跟随开启，无需再次确认。', off: '这会在你的所有设备上关闭它。' },
  id: { on: 'Perangkat lain yang masuk ke akun ini ikut aktif sendiri, tanpa konfirmasi baru.', off: 'Ini mematikannya di semua perangkat Anda.' },
  es: { on: 'Tus otros dispositivos con esta cuenta lo activan solos, sin volver a preguntar.', off: 'Esto lo desactiva en todos tus dispositivos.' },
  fr: { on: 'Vos autres appareils connectés à ce compte suivent, sans nouvelle demande.', off: 'Cela le désactive sur tous vos appareils.' },
};
export const ACCOUNT_MORE: Record<FloatLang, string> = { en: 'How it works', ru: 'Как это работает', zh: '运作方式', id: 'Cara kerjanya', es: 'Cómo funciona', fr: 'Comment ça marche' };
// A rules bump (FLOAT_RULES): what is new, ONE line per version, in the six languages; the dialog asks for that line alone,
// with the whole consent folded under it. Rules 2 (owner 2026-10-29 «да делай давай»): the buy straight from the reserve.
export const RULES_DELTA: Partial<Record<number, Record<FloatLang, string>>> = {
  2: { en: "New: a buy you tap in USD may be paid straight from your wallet's own reserve — the reserve buys the coin for that wallet in one transaction (no top-up first), within your limits. Nothing else changes.", ru: 'Новое: покупку в USD может оплатить напрямую собственный резерв вашего кошелька — резерв покупает монету для этого кошелька одной транзакцией (без пополнения заранее), в ваших пределах. Остальное не меняется.', zh: '新规则：你以 USD 点击的买入可直接由你钱包自己的储备支付——储备在一笔交易中为该钱包买入代币（无需先充值），在你的限制之内。其余不变。', id: 'Baru: pembelian yang Anda ketuk dalam USD dapat dibayar langsung dari cadangan dompet Anda sendiri — cadangan membeli koin untuk dompet itu dalam satu transaksi (tanpa isi ulang dulu), dalam batas Anda. Selebihnya tidak berubah.', es: 'Nuevo: una compra que pulses en USD puede pagarse directamente desde la reserva propia de tu cartera: la reserva compra la moneda para esa cartera en una sola transacción (sin recarga previa), dentro de tus límites. Nada más cambia.', fr: "Nouveau : un achat que vous lancez en USD peut être payé directement par la réserve propre de votre portefeuille — la réserve achète le jeton pour ce portefeuille en une seule transaction (sans recharge préalable), dans vos limites. Rien d'autre ne change." },
};
export const RULES_DIALOG: Record<FloatLang, { title: string; ok: string; fallback: string }> = {
  en: { title: 'USD balance: one new rule', ok: 'Agree', fallback: 'The USD balance has a new rule. Everything else stays as you agreed.' },
  ru: { title: 'Баланс в USD: одно новое правило', ok: 'Согласен', fallback: 'У баланса в USD новое правило. Всё остальное остаётся, как вы согласились.' },
  zh: { title: 'USD 余额：一条新规则', ok: '同意', fallback: 'USD 余额有一条新规则。其余一切保持你同意时的样子。' },
  id: { title: 'Saldo USD: satu aturan baru', ok: 'Setuju', fallback: 'Saldo USD punya satu aturan baru. Selebihnya tetap seperti yang Anda setujui.' },
  es: { title: 'Saldo en USD: una regla nueva', ok: 'Acepto', fallback: 'El saldo en USD tiene una regla nueva. Todo lo demás sigue como lo aceptaste.' },
  fr: { title: 'Solde en USD : une nouvelle règle', ok: 'J’accepte', fallback: 'Le solde en USD a une nouvelle règle. Tout le reste reste tel que vous l’avez accepté.' },
};
/** The lines a grant on rules `from` has not agreed to yet, up to `to` (a version without its own line: the fallback). */
export function rulesDeltaLines(from: number, to: number, lang: FloatLang, delta: Partial<Record<number, Record<FloatLang, string>>> = RULES_DELTA): string[] {
  const out: string[] = [];
  for (let v = from + 1; v <= to; v++) { const l = delta[v]?.[lang] ?? delta[v]?.en; if (l && !out.includes(l)) out.push(l); }
  return out.length ? out : [RULES_DIALOG[lang].fallback];
}

// ── a switch-on for an account that already holds dollars (2026-11-01, the owner, holding ~$800 as USD balance, got "Turn on
// USD balance · Convert $179 to dollars · …" and asked "why does it ask me to convert when I already have $800 USDC?"; owner
// «я даю добро на все», «мы не можем проебать бабки юзеров никак строго») ──
// The vault's grant is per device (floatConsent carries it to the account's other devices, when it can): a device whose own
// grant is not live — never confirmed here, ran out after 30 days, or another device's record it could not adopt (newer
// rules, a signer whose key this vault does not hold, …) — used to get the FIRST switch-on dialog, which bundles converting
// every wallet's native into the same "Turn on". Now: when the account already holds dollars (its reserves, as this vault's
// snapshots read them) or this device knows why it is not on, the dialog is a one-tap confirm that converts NOTHING, says
// why it shows, and offers the conversion only as a second, separately labelled button that states its exact amounts.
// The first switch-on of an account with no dollars keeps its conversion as the primary button, with "Turn on without
// converting" beside it. Whatever is not converted is kept as native (floatEngine KEEP): the routine sweep leaves it alone.
export type OnWhy = { kind: 'first' } | { kind: 'device'; cash6: bigint } | { kind: 'expired'; at: number } | { kind: 'rules'; from: number };
type ResumeWords = {
  title: string; ok: string; okConvert: (v: string) => string; firstConvert: (v: string) => string; firstKeep: string;
  device: (cash: string) => string; deviceOn: string; expired: (day: string) => string; rules: string;
  keep: (natives: string) => string; offer: (v: string, natives: string) => string;
  chain1: (names: string) => string; chainN: (names: string) => string; caps: string;
  /** (2026-11-02) a buy click's confirm (configure `click`): its one button, and the line that says the buy goes on */
  okBuy: string; buyNext: string;
};
export const RESUME: Record<FloatLang, ResumeWords> = {
  en: {
    title: 'USD balance on this device', ok: 'Confirm', okConvert: (v) => `Confirm and convert ${v}`, firstConvert: (v) => `Turn on and convert ${v}`, firstKeep: 'Turn on without converting',
    device: (c) => `You already have ${c} in your USD balance, but this device has not confirmed it yet. One tap and it works here too.`,
    deviceOn: 'Your USD balance is on for this account, but this device has not confirmed it yet. One tap and it works here too.',
    expired: (d) => `Your consent for the USD balance ran out on ${d} (it lasts 30 days). Confirm to keep it on.`,
    rules: 'The USD balance has a new rule since it was turned on, so this device asks once:',
    keep: (n) => `Nothing is converted: the ${n} your wallets hold now stays as it is (only what arrives later converts by itself).`,
    offer: (v, n) => `Optional: you can also convert ${v} of ${n} to dollars now:`,
    chain1: (n) => `${n} is not on yet for this account: this turns it on there too. Nothing is converted.`,
    chainN: (n) => `${n} are not on yet for this account: this turns them on too. Nothing is converted.`,
    caps: 'Your limits change to the ones below. Nothing is converted.',
    okBuy: 'Confirm and buy', buyNext: 'Your buy goes on right after this tap.',
  },
  ru: {
    title: 'Баланс в USD на этом устройстве', ok: 'Подтвердить', okConvert: (v) => `Подтвердить и конвертировать ${v}`, firstConvert: (v) => `Включить и конвертировать ${v}`, firstKeep: 'Включить без конвертации',
    device: (c) => `У вас уже ${c} на балансе в USD, но это устройство ещё не подтвердило его. Одно нажатие — и он работает и здесь.`,
    deviceOn: 'Баланс в USD включён для этого аккаунта, но это устройство ещё не подтвердило его. Одно нажатие — и он работает и здесь.',
    expired: (d) => `Согласие на баланс в USD истекло ${d} (оно действует 30 дней). Подтвердите, чтобы он остался включённым.`,
    rules: 'У баланса в USD появилось новое правило с тех пор, как его включили, поэтому это устройство спрашивает один раз:',
    keep: (n) => `Ничего не конвертируется: ${n} на ваших кошельках остаются как есть (сами конвертируются только новые поступления).`,
    offer: (v, n) => `По желанию: можно сразу конвертировать ${v} из ${n} в доллары:`,
    chain1: (n) => `Сеть ${n} ещё не включена для этого аккаунта: это включит её. Ничего не конвертируется.`,
    chainN: (n) => `Сети ${n} ещё не включены для этого аккаунта: это включит их. Ничего не конвертируется.`,
    caps: 'Ваши лимиты меняются на указанные ниже. Ничего не конвертируется.',
    okBuy: 'Подтвердить и купить', buyNext: 'Покупка продолжится сразу после этого нажатия.',
  },
  zh: {
    title: '在此设备上使用 USD 余额', ok: '确认', okConvert: (v) => `确认并转换 ${v}`, firstConvert: (v) => `开启并转换 ${v}`, firstKeep: '开启但不转换',
    device: (c) => `你的 USD 余额中已有 ${c}，但此设备尚未确认。点一下，这里也能用。`,
    deviceOn: '此账户已开启 USD 余额，但此设备尚未确认。点一下，这里也能用。',
    expired: (d) => `你对 USD 余额的授权已于 ${d} 到期（有效期 30 天）。确认即可继续开启。`,
    rules: 'USD 余额自开启以来新增了一条规则，因此此设备需确认一次：',
    keep: (n) => `不会转换任何资产：你的钱包现有的 ${n} 保持不变（只有之后转入的部分会自动转换）。`,
    offer: (v, n) => `可选：你也可以现在把 ${v} 的 ${n} 转换为美元：`,
    chain1: (n) => `此账户尚未在 ${n} 上开启：这将一并开启。不会转换任何资产。`,
    chainN: (n) => `此账户尚未在 ${n} 上开启：这将一并开启。不会转换任何资产。`,
    caps: '你的限额将改为下方所示。不会转换任何资产。',
    okBuy: '确认并买入', buyNext: '点一下之后，你的买入会立即继续。',
  },
  id: {
    title: 'Saldo USD di perangkat ini', ok: 'Konfirmasi', okConvert: (v) => `Konfirmasi dan konversi ${v}`, firstConvert: (v) => `Aktifkan dan konversi ${v}`, firstKeep: 'Aktifkan tanpa konversi',
    device: (c) => `Anda sudah punya ${c} di saldo USD, tetapi perangkat ini belum mengonfirmasinya. Sekali ketuk dan saldo ini juga berfungsi di sini.`,
    deviceOn: 'Saldo USD aktif untuk akun ini, tetapi perangkat ini belum mengonfirmasinya. Sekali ketuk dan saldo ini juga berfungsi di sini.',
    expired: (d) => `Persetujuan saldo USD Anda berakhir pada ${d} (berlaku 30 hari). Konfirmasi agar tetap aktif.`,
    rules: 'Saldo USD punya aturan baru sejak diaktifkan, jadi perangkat ini bertanya sekali:',
    keep: (n) => `Tidak ada yang dikonversi: ${n} yang ada di dompet Anda sekarang tetap seperti semula (hanya yang masuk nanti dikonversi otomatis).`,
    offer: (v, n) => `Opsional: Anda juga bisa mengonversi ${v} dari ${n} ke dolar sekarang:`,
    chain1: (n) => `${n} belum aktif untuk akun ini: ini juga mengaktifkannya. Tidak ada yang dikonversi.`,
    chainN: (n) => `${n} belum aktif untuk akun ini: ini juga mengaktifkannya. Tidak ada yang dikonversi.`,
    caps: 'Batas Anda berubah menjadi yang di bawah. Tidak ada yang dikonversi.',
    okBuy: 'Konfirmasi dan beli', buyNext: 'Pembelian Anda langsung berlanjut setelah ketukan ini.',
  },
  es: {
    title: 'Saldo en USD en este dispositivo', ok: 'Confirmar', okConvert: (v) => `Confirmar y convertir ${v}`, firstConvert: (v) => `Activar y convertir ${v}`, firstKeep: 'Activar sin convertir',
    device: (c) => `Ya tienes ${c} en tu saldo en USD, pero este dispositivo aún no lo ha confirmado. Un toque y funciona también aquí.`,
    deviceOn: 'Tu saldo en USD está activado en esta cuenta, pero este dispositivo aún no lo ha confirmado. Un toque y funciona también aquí.',
    expired: (d) => `Tu consentimiento para el saldo en USD venció el ${d} (dura 30 días). Confirma para mantenerlo activado.`,
    rules: 'El saldo en USD tiene una regla nueva desde que se activó, así que este dispositivo pregunta una vez:',
    keep: (n) => `No se convierte nada: los ${n} que tienen ahora tus carteras se quedan como están (solo lo que llegue después se convierte solo).`,
    offer: (v, n) => `Opcional: también puedes convertir ahora ${v} de ${n} a dólares:`,
    chain1: (n) => `${n} aún no está activado en esta cuenta: esto lo activa también. No se convierte nada.`,
    chainN: (n) => `${n} aún no están activados en esta cuenta: esto los activa también. No se convierte nada.`,
    caps: 'Tus límites pasan a ser los de abajo. No se convierte nada.',
    okBuy: 'Confirmar y comprar', buyNext: 'Tu compra sigue justo después de este toque.',
  },
  fr: {
    title: 'Solde en USD sur cet appareil', ok: 'Confirmer', okConvert: (v) => `Confirmer et convertir ${v}`, firstConvert: (v) => `Activer et convertir ${v}`, firstKeep: 'Activer sans convertir',
    device: (c) => `Vous avez déjà ${c} sur votre solde en USD, mais cet appareil ne l’a pas encore confirmé. Un geste et il fonctionne ici aussi.`,
    deviceOn: 'Votre solde en USD est activé pour ce compte, mais cet appareil ne l’a pas encore confirmé. Un geste et il fonctionne ici aussi.',
    expired: (d) => `Votre accord pour le solde en USD a expiré le ${d} (il dure 30 jours). Confirmez pour le garder actif.`,
    rules: 'Le solde en USD a une nouvelle règle depuis son activation, donc cet appareil demande une fois :',
    keep: (n) => `Rien n’est converti : les ${n} que vos portefeuilles détiennent restent tels quels (seul ce qui arrive ensuite se convertit tout seul).`,
    offer: (v, n) => `Facultatif : vous pouvez aussi convertir maintenant ${v} de ${n} en dollars :`,
    chain1: (n) => `${n} n’est pas encore activé pour ce compte : ceci l’active aussi. Rien n’est converti.`,
    chainN: (n) => `${n} ne sont pas encore activés pour ce compte : ceci les active aussi. Rien n’est converti.`,
    caps: 'Vos limites deviennent celles ci-dessous. Rien n’est converti.',
    okBuy: 'Confirmer et acheter', buyNext: 'Votre achat continue juste après ce geste.',
  },
};
const DAY_LOCALE: Record<FloatLang, string> = { en: 'en-US', ru: 'ru-RU', zh: 'zh-CN', id: 'id-ID', es: 'es-ES', fr: 'fr-FR' };
/** "Oct 31" / "31 окт." — the day a grant ran out (UTC), in the dialog's language; ISO when Intl is missing. */
export function fmtDay(ms: number, lang: FloatLang): string {
  try { return new Date(ms).toLocaleDateString(DAY_LOCALE[lang], { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { return new Date(ms).toISOString().slice(0, 10); }
}
/** The first lines of a switch-on dialog for a device that is not on although the account is (or was): why it shows. */
export function onWhyLines(why: OnWhy, lang: FloatLang, delta: string[] = []): string[] {
  const W = RESUME[lang];
  if (why.kind === 'device') return [why.cash6 >= USD ? W.device(fmtUsd6(why.cash6)) : W.deviceOn];
  if (why.kind === 'expired') return [W.expired(fmtDay(why.at, lang))];
  if (why.kind === 'rules') return [W.rules, ...delta];
  return [];
}
/** The lead of a caps raise / new chain on a live grant (no conversion there, as before): what this dialog changes. */
export function widenLine(added: FloatChain[], lang: FloatLang): string {
  const W = RESUME[lang];
  if (!added.length) return W.caps;
  const names = listIn(added.map((c) => CHAIN_NAME[c]), lang);
  return added.length > 1 ? W.chainN(names) : W.chain1(names);
}
/** The total a switch-on would convert (the conversion button's figure), "$179". */
export const convertTotalText = (convs: WalletConvert[]): string => fmtUsdApprox(convs.reduce((t, w) => t + w.plan.lines.reduce((s, l) => s + l.usd6, 0n), 0n));
/**
 * The confirm dialog of a device whose grant is not live while the account holds dollars (OnWhy other than 'first'): why it
 * shows, "nothing is converted", and — only when `offer` — the conversion the second button would run, with the SAME rows
 * (wallet, exact native amount per chain, dollars) the conversion orders then carry. Every string passes `esc`.
 */
export function accountResumeHtml(o: { why: OnWhy; delta?: string[]; convs: WalletConvert[]; skipped: SkippedWallet[]; enabled: FloatChain[]; offer: boolean; lang: FloatLang; esc: (s: unknown) => string }): string {
  const W = RESUME[o.lang];
  const natives = o.enabled.map((c) => FLOAT_CFG[c].native).join(' / ');
  const [lead, ...more] = onWhyLines(o.why, o.lang, o.delta);
  let html = `<p class="ub-lead">${o.esc(lead || W.title)}</p>${more.map((l) => `<p class="ub-note">${o.esc(l)}</p>`).join('')}<p class="ub-note">${o.esc(W.keep(natives))}</p>`;
  const withLines = o.convs.filter((w) => w.plan.lines.length);
  if (o.offer && withLines.length) {
    const v = accountConvertView(o.convs, o.skipped, o.enabled, o.lang);
    const conv = [...new Set(withLines.flatMap((w) => w.plan.lines.map((l) => FLOAT_CFG[l.chain].native)))].join(' / ');
    const rows = `<div class="ub-t">${v.rows.map((r) => `<div class="ub-r"><div class="ub-w"><span class="ub-n">${o.esc(r.name)}</span><span class="ub-cs">${r.chips.map((c) => `<span class="ub-c" translate="no">${o.esc(c)}</span>`).join('')}</span></div><b class="ub-u" translate="no">${o.esc(r.usd)}</b></div>`).join('')}</div>`;
    html += `<p class="ub-skip">${o.esc(W.offer(convertTotalText(o.convs), conv))}</p>${rows}${v.skip ? `<p class="ub-skip">${o.esc(v.skip)}</p>` : ''}`;
  }
  return html;
}
type ViewWords = {
  convert: (v: string) => string; nothing: string; empty: (names: string) => string; small: string;
  later1: (chain: string) => string; laterN: (chains: string) => string; privy: (names: string) => string; other: (names: string) => string;
  note: (natives: string) => string;
  back: (v: string, natives: string) => string; nothingBack: string; stays: (min: string, names: string) => string; unread: (chains: string) => string;
  offNote: (slip: string) => string;
};
const VIEW: Record<FloatLang, ViewWords> = {
  en: {
    convert: (v) => `Convert ${v} to dollars`, nothing: 'Nothing to convert now', empty: (n) => `nothing to convert on ${n}`, small: 'small amounts stay ready for gas',
    later1: (c) => `${c} price not read yet (converts later)`, laterN: (c) => `${c} prices not read yet (convert later)`,
    privy: (n) => `skipped ${n} (Privy signs outside the vault)`, other: (n) => `skipped ${n} (cannot hold a USD balance)`,
    note: (n) => `A little ${n} stays on each chain so trades stay instant. Deposits later convert by themselves.`,
    back: (v, n) => `Convert ${v} back to ${n}`, nothingBack: 'Nothing to convert back', stays: (m, n) => `under ${m} stays as USD on ${n}`,
    unread: (c) => `${c} not read yet (converts back when you turn off with it open)`,
    offNote: (s) => `Each swap is checked against the on-chain price (slippage at most ${s} %). A little gas stays in each reserve.`,
  },
  ru: {
    convert: (v) => `Конвертировать ${v} в доллары`, nothing: 'Сейчас конвертировать нечего', empty: (n) => `нечего конвертировать на ${n}`, small: 'мелкие суммы остаются для газа',
    later1: (c) => `цена ${c} ещё не прочитана (конвертируется позже)`, laterN: (c) => `цены ${c} ещё не прочитаны (конвертируются позже)`,
    privy: (n) => `пропуск: ${n} (Privy подписывает вне хранилища)`, other: (n) => `пропуск: ${n} (не может держать баланс в USD)`,
    note: (n) => `Немного ${n} остаётся на каждой сети, чтобы сделки шли мгновенно. Новые пополнения конвертируются сами.`,
    back: (v, n) => `Вернуть ${v} обратно в ${n}`, nothingBack: 'Возвращать нечего', stays: (m, n) => `меньше ${m} остаётся в USD на ${n}`,
    unread: (c) => `${c}: ещё не прочитано (вернётся, если выключить с открытой сетью)`,
    offNote: (s) => `Каждый обмен сверяется с ценой в сети (проскальзывание не больше ${s} %). В каждом резерве остаётся немного газа.`,
  },
  zh: {
    convert: (v) => `将 ${v} 转换为美元`, nothing: '现在没有可转换的', empty: (n) => `${n} 没有可转换的`, small: '少量余额留作 gas',
    later1: (c) => `尚未读取 ${c} 价格（稍后转换）`, laterN: (c) => `尚未读取 ${c} 价格（稍后转换）`,
    privy: (n) => `已跳过 ${n}（Privy 不在保管库内签名）`, other: (n) => `已跳过 ${n}（无法持有 USD 余额）`,
    note: (n) => `每条链上会保留少量 ${n}，交易依然即时。之后的充值会自动转换。`,
    back: (v, n) => `将 ${v} 转回 ${n}`, nothingBack: '没有可转回的', stays: (m, n) => `${n} 上低于 ${m} 的部分保留为 USD`,
    unread: (c) => `尚未读取 ${c}（在该链打开时关闭即可转回）`,
    offNote: (s) => `每次兑换都会对照链上价格检查（滑点最多 ${s} %）。每个储备会保留少量 gas。`,
  },
  id: {
    convert: (v) => `Konversi ${v} ke dolar`, nothing: 'Tidak ada yang dikonversi sekarang', empty: (n) => `tidak ada yang dikonversi di ${n}`, small: 'jumlah kecil tetap untuk gas',
    later1: (c) => `harga ${c} belum terbaca (dikonversi nanti)`, laterN: (c) => `harga ${c} belum terbaca (dikonversi nanti)`,
    privy: (n) => `dilewati ${n} (Privy menandatangani di luar vault)`, other: (n) => `dilewati ${n} (tidak bisa memegang saldo USD)`,
    note: (n) => `Sedikit ${n} tetap ada di setiap jaringan agar trading tetap instan. Setoran berikutnya dikonversi otomatis.`,
    back: (v, n) => `Konversi ${v} kembali ke ${n}`, nothingBack: 'Tidak ada yang dikembalikan', stays: (m, n) => `di bawah ${m} tetap sebagai USD di ${n}`,
    unread: (c) => `${c} belum terbaca (kembali saat Anda mematikan dengan jaringan itu terbuka)`,
    offNote: (s) => `Setiap swap dicek terhadap harga on-chain (slippage maksimal ${s} %). Sedikit gas tetap ada di setiap cadangan.`,
  },
  es: {
    convert: (v) => `Convertir ${v} a dólares`, nothing: 'Nada que convertir ahora', empty: (n) => `nada que convertir en ${n}`, small: 'los importes pequeños quedan para el gas',
    later1: (c) => `precio de ${c} aún no leído (se convierte después)`, laterN: (c) => `precios de ${c} aún no leídos (se convierten después)`,
    privy: (n) => `omitida ${n} (Privy firma fuera de la bóveda)`, other: (n) => `omitida ${n} (no puede tener saldo en USD)`,
    note: (n) => `Un poco de ${n} se queda en cada red para que las operaciones sigan siendo instantáneas. Los depósitos futuros se convierten solos.`,
    back: (v, n) => `Convertir ${v} de vuelta a ${n}`, nothingBack: 'Nada que devolver', stays: (m, n) => `menos de ${m} queda en USD en ${n}`,
    unread: (c) => `${c} aún no leído (se devuelve si desactivas con esa red abierta)`,
    offNote: (s) => `Cada intercambio se comprueba con el precio en cadena (deslizamiento máximo ${s} %). Queda un poco de gas en cada reserva.`,
  },
  fr: {
    convert: (v) => `Convertir ${v} en dollars`, nothing: 'Rien à convertir pour le moment', empty: (n) => `rien à convertir sur ${n}`, small: 'les petits montants restent pour le gas',
    later1: (c) => `prix ${c} pas encore lu (converti plus tard)`, laterN: (c) => `prix ${c} pas encore lus (convertis plus tard)`,
    privy: (n) => `ignoré ${n} (Privy signe hors du coffre)`, other: (n) => `ignoré ${n} (ne peut pas détenir de solde en USD)`,
    note: (n) => `Un peu de ${n} reste sur chaque réseau pour que les trades restent instantanés. Les dépôts suivants se convertissent seuls.`,
    back: (v, n) => `Reconvertir ${v} en ${n}`, nothingBack: 'Rien à reconvertir', stays: (m, n) => `moins de ${m} reste en USD sur ${n}`,
    unread: (c) => `${c} pas encore lu (reconverti si vous désactivez avec ce réseau ouvert)`,
    offNote: (s) => `Chaque échange est vérifié par rapport au prix on-chain (glissement au plus ${s} %). Un peu de gas reste dans chaque réserve.`,
  },
};
const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** The switch-on dialog's view: the total, a row per converting wallet, the grouped skips, the one plain sentence. */
export function accountConvertView(ws: WalletConvert[], skipped: SkippedWallet[], enabled: FloatChain[], lang: FloatLang = 'en'): DialogView {
  const V = VIEW[lang];
  const withLines = ws.filter((w) => w.plan.lines.length);
  const sum = (w: WalletConvert) => w.plan.lines.reduce((t, l) => t + l.usd6, 0n);
  const total = withLines.reduce((t, w) => t + sum(w), 0n);
  const lead = withLines.length ? V.convert(fmtUsdApprox(total)) : V.nothing;
  const rows = withLines.map((w) => ({ name: w.name, usd: fmtUsdApprox(sum(w)), chips: w.plan.lines.map((l) => { const c = FLOAT_CFG[l.chain]; return `${fmtNative(l.nativeIn, c.nativeDecimals, c.native)} → ${c.stable.symbol}`; }) }));
  const parts: string[] = [];
  // a wallet with nothing above what stays on the chains that were read: named once (its unread chains are in the price part)
  const empty = ws.filter((w) => !w.plan.lines.length && w.plan.skips.some((s) => s.why === 'below-min')).map((w) => w.name);
  if (empty.length) parts.push(V.empty(listIn(empty, lang)));
  // the small rest of a wallet that does convert elsewhere: never per chain, per wallet
  if (withLines.some((w) => w.plan.skips.some((s) => s.why === 'below-min'))) parts.push(V.small);
  // a chain without a fresh price: said once, whatever the number of wallets
  const later = FLOAT_CHAIN_KEYS.filter((c) => ws.some((w) => w.plan.skips.some((s) => s.chain === c && s.why === 'stale-price')));
  if (later.length) { const names = listIn(later.map((c) => CHAIN_NAME[c]), lang); parts.push(later.length > 1 ? V.laterN(names) : V.later1(names)); }
  const privy = skipped.filter((s) => s.why === 'privy').map((s) => s.name), other = skipped.filter((s) => s.why !== 'privy').map((s) => s.name);
  if (privy.length) parts.push(V.privy(listIn(privy, lang)));
  if (other.length) parts.push(V.other(listIn(other, lang)));
  const natives = enabled.map((c) => FLOAT_CFG[c].native).join(' / ');
  return { lead, rows, skip: parts.map(capFirst).join(' · '), note: V.note(natives) };
}
/** The switch-off dialog's view: the total going back, a row per wallet, what stays and what was not read as one line. */
export function accountOffView(ws: WalletBack[], maxSlipBps: number, lang: FloatLang = 'en'): DialogView {
  const V = VIEW[lang];
  const withLines = ws.filter((w) => w.plan.lines.length);
  const all = withLines.flatMap((w) => w.plan.lines);
  const total = all.reduce((t, l) => t + l.usd6, 0n);
  const natives = [...new Set(all.map((l) => FLOAT_CFG[l.chain].native))].join(' / ');
  const lead = all.length ? V.back(fmtUsdApprox(total), natives) : V.nothingBack;
  const rows = withLines.map((w) => ({ name: w.name, usd: fmtUsdApprox(w.plan.lines.reduce((t, l) => t + l.usd6, 0n)), chips: w.plan.lines.map((l) => { const c = FLOAT_CFG[l.chain]; return `${fmtUsd6(l.usd6)} ${c.stable.symbol} → ${c.native}`; }) }));
  const parts: string[] = [];
  const small = ws.filter((w) => w.plan.skips.length).map((w) => w.name);
  if (small.length) parts.push(V.stays(fmtUsd6(CONVERT_BACK_MIN6), listIn(small, lang)));
  const unread = FLOAT_CHAIN_KEYS.filter((c) => ws.some((w) => w.unread.includes(c)));
  if (unread.length) parts.push(V.unread(listIn(unread.map((c) => CHAIN_NAME[c]), lang)));
  return { lead, rows, skip: parts.map(capFirst).join(' · '), note: V.offNote((maxSlipBps / 100).toFixed(2)) };
}
/** A view as the vault's dialog html (classes styled by FLOAT_DLG_RULES); `esc` escapes every string that goes in. */
export function dialogViewHtml(v: DialogView, esc: (s: unknown) => string): string {
  const rows = v.rows.length ? `<div class="ub-t">${v.rows.map((r) => `<div class="ub-r"><div class="ub-w"><span class="ub-n">${esc(r.name)}</span><span class="ub-cs">${r.chips.map((c) => `<span class="ub-c" translate="no">${esc(c)}</span>`).join('')}</span></div><b class="ub-u" translate="no">${esc(r.usd)}</b></div>`).join('')}</div>` : '';
  return `<p class="ub-lead">${esc(v.lead)}</p>${rows}${v.skip ? `<p class="ub-skip">${esc(v.skip)}</p>` : ''}<p class="ub-note">${esc(v.note)}</p>`;
}
/**
 * The standing consent (accountPermissionText) as html: its first line, its "- " lines as a list, the rest as lines.
 * With `summary`, folded into <details> (no script: works under the frame's CSP); without, laid open (a caps raise,
 * where the consent IS the dialog).
 */
export function consentHtml(text: string, esc: (s: unknown) => string, summary?: string): string {
  const lines = text.split('\n').filter(Boolean); if (!lines.length) return '';
  const [first, ...rest] = lines; const items = rest.filter((l) => l.startsWith('- '));
  const body = `<p>${esc(first)}</p>${items.length ? `<ul class="ub-list">${items.map((l) => `<li>${esc(l.slice(2))}</li>`).join('')}</ul>` : ''}${rest.filter((l) => !l.startsWith('- ')).map((l) => `<p>${esc(l)}</p>`).join('')}`;
  return summary ? `<details class="ub-more"><summary>${esc(summary)}</summary><div class="ub-more-b">${body}</div></details>` : `<div class="ub-open">${body}</div>`;
}
// The rules for the classes above, in the vault's dark sheet (vault.css: --text, --sub, --line, --raised, --mono …).
// The engine adds them itself through the CSSOM (webEngine dialogCss), so the pinned vault page and its style-src 'self'
// stay as they are. Phones (≤ 560 px, where the sheet is full width): rows of at least 56 px, names and chips never wrap
// into a paragraph (a long name ends in "…", chips flow as whole chips).
export const FLOAT_DLG_RULES: string[] = [
  '.dlg-b .ub-lead{font-size:17px;line-height:1.35;font-weight:600;letter-spacing:-.015em;color:var(--text)}',
  '.ub-t{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:-4px}',
  '.ub-r{display:flex;align-items:center;gap:14px;min-height:56px;padding:9px 0;min-width:0}',
  '.ub-r+.ub-r{border-top:1px solid var(--line)}',
  '.ub-w{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}',
  '.ub-n{color:var(--text);font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.ub-cs{display:flex;flex-wrap:wrap;gap:4px 6px;min-width:0}',
  '.ub-c{font:12px/1.25 var(--mono);color:var(--sub-2);background:var(--raised);border-radius:6px;padding:3px 7px;white-space:nowrap;letter-spacing:0;font-variant-numeric:tabular-nums}',
  '.ub-u{flex:none;align-self:flex-start;padding-top:1px;font:500 15px/1.25 var(--mono);color:var(--text);text-align:right;font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap}',
  '.dlg-b .ub-skip{color:var(--sub);font-size:13px;line-height:1.45;margin-top:-6px}',
  '.dlg-b .ub-note{color:var(--sub-2);font-size:13.5px;line-height:1.5}',
  '.ub-more{border-top:1px solid var(--line);color:var(--sub);font-size:13px;line-height:1.5;min-width:0}',
  '.ub-more>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;cursor:pointer;color:var(--sub-2);font-weight:500}',
  '.ub-more>summary::-webkit-details-marker{display:none}',
  '.ub-more>summary::marker{content:""}',
  '.ub-more>summary::after{content:"+";font:400 18px/1 var(--mono);color:var(--sub)}',
  '.ub-more[open]>summary::after{content:"\\2212"}',
  '.ub-more>summary:focus-visible{outline:2px solid var(--accent-line);outline-offset:2px;border-radius:6px}',
  '.ub-more-b,.ub-open{display:flex;flex-direction:column;gap:8px;padding:0 0 6px;min-width:0}',
  '.ub-more-b p,.ub-more-b li{color:var(--sub);font-size:13px;line-height:1.5}',
  '.dlg-b .ub-open p,.ub-open li{font-size:13.5px;line-height:1.5}',
  '.ub-list{list-style:none;display:flex;flex-direction:column;gap:2px;padding:0;margin:0}',
  '.ub-list li{position:relative;padding-left:14px}',
  '.ub-list li::before{content:"";position:absolute;left:2px;top:.68em;width:4px;height:4px;border-radius:50%;background:var(--dim)}',
  '@media (max-width:560px){.ub-r{min-height:60px;padding:10px 0}.ub-u{font-size:16px}.ub-c{font-size:12.5px;padding:4px 8px}.ub-more>summary{min-height:48px}}',
];

// I3 at the source for the reads a user's click is waiting on (the switch's dialogs, the app's pre-dialog status): wait
// while a trade runs, then go at once — no background bucket (webEngine floatNow / floatNowQuiet)
export async function afterTrade<T>(running: () => boolean, wait: (ms: number) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  while (running()) await wait(100);
  return fn();
}

// ── page arguments: exact shapes, unknown fields refused ──
export const FLOAT_METHODS = ['status', 'configure', 'ensure', 'sweep', 'off', 'jobs', 'convert', 'withdraw'] as const;
export type FloatMethod = typeof FLOAT_METHODS[number];
export const ENSURE_REASONS = ['lane', 'page', 'preset', 'fill', 'visible', 'tick', 'click'] as const;
// status: `scope: 'account'` = every wallet of the account and the total; configure / off act on the whole account (the
// caller's walletId is the wallet the page is on, checked like before); `lang` picks the dialog's language; status
// `fresh: true` = the app's read right before it opens a dialog: this frame's chain is read now (no bucket) and awaited
const SHAPES: Record<FloatMethod, string[]> = {
  status: ['walletId', 'scope', 'fresh'],
  // click (2026-11-02): the confirm a buy click asks for (one button, nothing converted; the buy goes on after it)
  configure: ['walletId', 'chains', 'caps', 'lang', 'click'],
  ensure: ['walletId', 'chain', 'usd', 'reason', 'presets'],
  sweep: ['walletId', 'chain'],
  off: ['walletId', 'lang'],
  jobs: ['walletId'],
  // (release 9) the USD balance into this chain's own coin, kept in the wallet (float.convert)
  convert: ['walletId', 'chain', 'usd', 'lang'],
  // (release 9) the reserve's stablecoin out, as the stablecoin, to the wallet itself or to an outside address (float.withdraw)
  withdraw: ['walletId', 'chain', 'usd', 'to', 'address', 'idempotencyKey', 'lang', 'twofa'],
};
const REQUIRED: Record<FloatMethod, string[]> = { status: ['walletId'], configure: ['walletId', 'chains'], ensure: ['walletId', 'chain', 'reason'], sweep: ['walletId', 'chain'], off: ['walletId'], jobs: ['walletId'], convert: ['walletId', 'chain', 'usd'], withdraw: ['walletId', 'chain', 'usd', 'to', 'idempotencyKey'] };
export function floatArgs(method: string, o: unknown): Record<string, unknown> {
  if (!(FLOAT_METHODS as readonly string[]).includes(method)) throw new Error(`Bad arguments: unknown method float.${method}`);
  const m = method as FloatMethod;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!SHAPES[m].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  for (const k of REQUIRED[m]) if (rec[k] == null) throw new Error(`Bad arguments: ${k} missing`);
  if (typeof rec.walletId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(rec.walletId)) throw new Error('Bad arguments: walletId');
  if ('chain' in rec && !(FLOAT_CHAIN_KEYS as string[]).includes(String(rec.chain))) throw new Error('Bad arguments: chain');
  if ('chains' in rec) { const cs = rec.chains; if (!Array.isArray(cs) || !cs.length || cs.length > 3 || cs.some((c) => !(FLOAT_CHAIN_KEYS as string[]).includes(String(c))) || new Set(cs).size !== cs.length) throw new Error('Bad arguments: chains'); }
  if ('caps' in rec && rec.caps != null) {
    const c = rec.caps; if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Bad arguments: caps');
    for (const k of Object.keys(c)) if (!['perDay', 'feesPerDay', 'perChain', 'total', 'maxSlipBps'].includes(k)) throw new Error(`Bad arguments: unknown field caps.${k}`);
    capsFrom(c as never);   // range checks
  }
  if (m === 'withdraw') {
    const u = rec.usd; if (!(u === 'max' || (typeof u === 'number' && Number.isFinite(u) && u >= 0.1 && u <= WITHDRAW_MAX_USD))) throw new Error('Bad arguments: usd');
    if (rec.to !== 'wallet' && rec.to !== 'address') throw new Error('Bad arguments: to');
    if (rec.to === 'address') { const ad = rec.address; if (typeof ad !== 'string' || !(rec.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ad) : /^0x[0-9a-fA-F]{40}$/.test(ad) && !/^0x0{40}$/.test(ad))) throw new Error('Bad arguments: address'); }
    else if (rec.address != null) throw new Error('Bad arguments: address goes with to \'address\' only');
    if (typeof rec.idempotencyKey !== 'string' || !/^[\w:-]{8,64}$/.test(rec.idempotencyKey)) throw new Error('Bad arguments: idempotencyKey');
    if (rec.twofa != null && (typeof rec.twofa !== 'string' || !rec.twofa.length || rec.twofa.length > 4096)) throw new Error('Bad arguments: twofa');
  }
  if ('usd' in rec && rec.usd != null && m !== 'withdraw') { const u = Number(rec.usd); if (typeof rec.usd !== 'number' || !Number.isFinite(u) || u <= 0 || u > 10_000) throw new Error('Bad arguments: usd'); }
  if ('reason' in rec && !(ENSURE_REASONS as readonly string[]).includes(String(rec.reason))) throw new Error('Bad arguments: reason');
  if ('scope' in rec && rec.scope != null && rec.scope !== 'wallet' && rec.scope !== 'account') throw new Error('Bad arguments: scope');
  if ('fresh' in rec && rec.fresh != null && typeof rec.fresh !== 'boolean') throw new Error('Bad arguments: fresh');
  if ('click' in rec && rec.click != null && typeof rec.click !== 'boolean') throw new Error('Bad arguments: click');
  if ('lang' in rec && rec.lang != null && !(FLOAT_LANGS as readonly unknown[]).includes(rec.lang)) throw new Error('Bad arguments: lang');
  if ('presets' in rec && rec.presets != null) { const ps = rec.presets; if (!Array.isArray(ps) || ps.length > 8 || ps.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 10_000)) throw new Error('Bad arguments: presets'); }
  return rec;
}

// ── float.convert (release 9, owner 2026-11-05: the app's "Buy ETH / BNB" presets pay from the USD balance itself) ──
// { walletId, chain, usd, lang? }: the wallet's OWN reserve R on `chain` spends `usd` of its stable and the chain's native lands in
// the wallet W itself — the existing top-up move (ALLOWED_MOVES.topup: R → W, stable → native, the float's own pinned pool and
// router, the oracle price check at the permission's maxSlipBps, R's standing allowance), signed by R in ONE transaction. What
// lands is the user's coin from then on: it is kept out of the dollar figure and out of every sweep (convKept below). Covered by
// the rules-2 line the grant already agreed to ("a buy you tap in USD may be paid straight from that wallet's own reserve: the
// reserve buys the coin and it lands in the wallet, in one transaction"), so no new consent and no rules bump: it needs a live
// grant on rules >= DIRECT_BUY_RULES for that wallet and chain, like float.buy. No limits (owner in chat 2026-11-05: «убрать лимиты,
// тогда текст останется верным» — the consent says "no daily or volume limits"): the bounds are the $1 minimum, what R holds liquid,
// the oracle / slippage check of the top-up, the live grant and one move per wallet and chain at a time (the lock).
export const CONVERT_MIN6 = 1n * USD;
// a conversion sent less than this long ago and not landed yet: its kept amount is never shrunk (W's read may predate it)
export const CONVERT_SETTLE_MS = 180_000;
export type ConvertCode = 'lane' | 'off' | 'rules' | 'min' | 'trade' | 'busy' | 'price' | 'short' | 'gas' | 'quote' | 'failed';
/** The bounds of one conversion: null = it may go; else the code, its numbers, and the most that could go now (what R holds). */
export function convertCheck(x: { usd6: bigint; reserve6: bigint }): { code: ConvertCode; vars: Record<string, string>; max6: bigint } | null {
  if (x.usd6 < CONVERT_MIN6) return { code: 'min', vars: { min: fmtUsd6(CONVERT_MIN6) }, max6: x.reserve6 };
  if (x.usd6 > x.reserve6) return { code: 'short', vars: { have: fmtUsd6(x.reserve6) }, max6: x.reserve6 };
  return null;
}
export type ConvItem = { raw: bigint; at: number; job?: string | null };
/**
 * What of W's native on a chain is the user's converted coin (float.convert), not USD balance. `items` = the conversions still
 * counted, each with its job's state (null = settled). A failed / refunded one counts nothing. The sum is never more than W holds
 * above its gas floor — a trade or a send that spent W's native spends the ready float first, then the kept coin — except while a
 * conversion is still landing (W's read may predate it): then nothing is shrunk, it is only bounded by what W holds.
 * Returns the kept amount and the items to store (a shrink folds them into one settled item).
 */
export function convKept(items: (ConvItem & { state?: JobState | null })[], wNative: bigint, gasFloor: bigint, now: number): { kept: bigint; items: ConvItem[]; changed: boolean } {
  const live = items.filter((i) => i.raw > 0n && i.state !== 'failed' && i.state !== 'refunded');
  const sum = live.reduce((t, i) => t + i.raw, 0n);
  const room = wNative > gasFloor ? wNative - gasFloor : 0n;
  const strip = (l: typeof live): ConvItem[] => l.map((i) => ({ raw: i.raw, at: i.at, ...(i.job ? { job: i.job } : {}) }));
  if (sum <= room) return { kept: sum, items: strip(live), changed: live.length !== items.length };
  const landing = live.some((i) => i.state != null && i.state !== 'arrived' && now - i.at < CONVERT_SETTLE_MS);
  if (landing) return { kept: min(sum, wNative), items: strip(live), changed: live.length !== items.length };
  const at = live.reduce((t, i) => (i.at < t ? i.at : t), now);
  return { kept: room, items: room > 0n ? [{ raw: room, at }] : [], changed: true };
}
// the refusal texts (each ends "nothing was moved": nothing was signed), six languages
type CT = Record<ConvertCode, (v: Record<string, string>) => string>;
export const CONVERT_TEXT: Record<FloatLang, CT> = {
  en: {
    lane: () => 'Ask the vault of that network — nothing was moved',
    off: () => 'The USD balance is off for this wallet on this network — nothing was moved',
    rules: () => 'The USD balance needs your yes to its newer rule first (turn it on again) — nothing was moved',
    min: (v) => `The smallest amount is ${v.min} — nothing was moved`,
    trade: () => 'A trade is being sent: try again in a moment — nothing was moved',
    busy: () => 'This wallet\'s USD balance is moving right now: try again in a moment — nothing was moved',
    price: () => 'No fresh price on this network — nothing was moved',
    short: (v) => `Your USD balance on this network holds ${v.have} — nothing was moved`,
    gas: () => 'Your USD balance on this network has no gas for its swap yet — nothing was moved',
    quote: (v) => `The pool's price is off the market price (${v.why}) — nothing was moved`,
    failed: (v) => `The swap was not sent (${v.why}) — nothing was moved`,
  },
  ru: {
    lane: () => 'Спросите хранилище этой сети — ничего не перемещено',
    off: () => 'Баланс в USD выключен для этого кошелька в этой сети — ничего не перемещено',
    rules: () => 'Балансу в USD сначала нужно ваше согласие с новым правилом (включите его снова) — ничего не перемещено',
    min: (v) => `Минимальная сумма — ${v.min} — ничего не перемещено`,
    trade: () => 'Сейчас отправляется сделка: попробуйте через мгновение — ничего не перемещено',
    busy: () => 'Баланс в USD этого кошелька сейчас в движении: попробуйте через мгновение — ничего не перемещено',
    price: () => 'Нет свежей цены в этой сети — ничего не перемещено',
    short: (v) => `Ваш баланс в USD в этой сети: ${v.have} — ничего не перемещено`,
    gas: () => 'У баланса в USD в этой сети пока нет газа на обмен — ничего не перемещено',
    quote: (v) => `Цена пула отличается от рыночной (${v.why}) — ничего не перемещено`,
    failed: (v) => `Обмен не отправлен (${v.why}) — ничего не перемещено`,
  },
  zh: {
    lane: () => '请向该网络的保险库发起 — 未移动任何资金',
    off: () => '此钱包在该网络上的 USD 余额已关闭 — 未移动任何资金',
    rules: () => 'USD 余额需要你先同意其新规则（重新开启） — 未移动任何资金',
    min: (v) => `最小金额为 ${v.min} — 未移动任何资金`,
    trade: () => '正在发送一笔交易：请稍后再试 — 未移动任何资金',
    busy: () => '此钱包的 USD 余额正在移动：请稍后再试 — 未移动任何资金',
    price: () => '该网络没有最新价格 — 未移动任何资金',
    short: (v) => `你在该网络的 USD 余额为 ${v.have} — 未移动任何资金`,
    gas: () => '你在该网络的 USD 余额暂无兑换所需的 gas — 未移动任何资金',
    quote: (v) => `池子价格偏离市场价格（${v.why}） — 未移动任何资金`,
    failed: (v) => `兑换未发送（${v.why}） — 未移动任何资金`,
  },
  id: {
    lane: () => 'Minta ke vault jaringan itu — tidak ada yang dipindahkan',
    off: () => 'Saldo USD nonaktif untuk dompet ini di jaringan ini — tidak ada yang dipindahkan',
    rules: () => 'Saldo USD perlu persetujuan Anda atas aturan barunya dulu (aktifkan lagi) — tidak ada yang dipindahkan',
    min: (v) => `Jumlah terkecil adalah ${v.min} — tidak ada yang dipindahkan`,
    trade: () => 'Sebuah transaksi sedang dikirim: coba lagi sebentar lagi — tidak ada yang dipindahkan',
    busy: () => 'Saldo USD dompet ini sedang bergerak: coba lagi sebentar lagi — tidak ada yang dipindahkan',
    price: () => 'Tidak ada harga terbaru di jaringan ini — tidak ada yang dipindahkan',
    short: (v) => `Saldo USD Anda di jaringan ini ${v.have} — tidak ada yang dipindahkan`,
    gas: () => 'Saldo USD Anda di jaringan ini belum punya gas untuk swap — tidak ada yang dipindahkan',
    quote: (v) => `Harga pool berbeda dari harga pasar (${v.why}) — tidak ada yang dipindahkan`,
    failed: (v) => `Swap tidak terkirim (${v.why}) — tidak ada yang dipindahkan`,
  },
  es: {
    lane: () => 'Pídelo a la bóveda de esa red — no se movió nada',
    off: () => 'El saldo en USD está desactivado para esta cartera en esta red — no se movió nada',
    rules: () => 'El saldo en USD necesita primero tu sí a su nueva regla (actívalo de nuevo) — no se movió nada',
    min: (v) => `El importe mínimo es ${v.min} — no se movió nada`,
    trade: () => 'Se está enviando una operación: inténtalo en un momento — no se movió nada',
    busy: () => 'El saldo en USD de esta cartera se está moviendo ahora: inténtalo en un momento — no se movió nada',
    price: () => 'No hay precio reciente en esta red — no se movió nada',
    short: (v) => `Tu saldo en USD en esta red es ${v.have} — no se movió nada`,
    gas: () => 'Tu saldo en USD en esta red aún no tiene gas para el intercambio — no se movió nada',
    quote: (v) => `El precio del pool se aleja del precio de mercado (${v.why}) — no se movió nada`,
    failed: (v) => `El intercambio no se envió (${v.why}) — no se movió nada`,
  },
  fr: {
    lane: () => 'Demandez au coffre de ce réseau — rien n’a été déplacé',
    off: () => 'Le solde en USD est désactivé pour ce portefeuille sur ce réseau — rien n’a été déplacé',
    rules: () => 'Le solde en USD a d’abord besoin de votre accord à sa nouvelle règle (réactivez-le) — rien n’a été déplacé',
    min: (v) => `Le montant minimum est de ${v.min} — rien n’a été déplacé`,
    trade: () => 'Un ordre est en cours d’envoi : réessayez dans un instant — rien n’a été déplacé',
    busy: () => 'Le solde en USD de ce portefeuille bouge en ce moment : réessayez dans un instant — rien n’a été déplacé',
    price: () => 'Pas de prix récent sur ce réseau — rien n’a été déplacé',
    short: (v) => `Votre solde en USD sur ce réseau est de ${v.have} — rien n’a été déplacé`,
    gas: () => 'Votre solde en USD sur ce réseau n’a pas encore de gas pour l’échange — rien n’a été déplacé',
    quote: (v) => `Le prix du pool s’écarte du prix du marché (${v.why}) — rien n’a été déplacé`,
    failed: (v) => `L’échange n’a pas été envoyé (${v.why}) — rien n’a été déplacé`,
  },
};
export const convertWhy = (code: ConvertCode, lang: FloatLang, v: Record<string, string> = {}): string => (CONVERT_TEXT[lang] ?? CONVERT_TEXT.en)[code]({ why: '', ...v });

// ── float.withdraw (release 9, 2026-11-05: a tester "USD withdrawal is not available") ──
// { walletId, chain, usd: number | 'max', to: 'wallet' | 'address', address?, idempotencyKey, lang?, twofa? }: ONE plain transfer of
// the chain's pinned stablecoin (USDG on Robinhood, USDC on BNB / Solana) signed by the wallet's OWN reserve R — to the wallet itself
// (to 'wallet': no address argument) or to an outside address (to 'address'). No swap, no bridge. The consent is Send's own: an
// address the vault holds no key for = the 'withdraw' 2FA gate + the vault's "Send outside your vault" dialog (trusted click); the
// vault's own wallets = the 'transfer' gate. No limits (owner 2026-11-05: «убрать лимиты»): never more than R holds liquid, at
// least $0.10. A repeat of the same idempotencyKey returns the first answer and never sends twice.
export const WITHDRAW_MIN6 = 100_000n;              // $0.10
export const WITHDRAW_MAX_USD = 100_000;            // the argument's range (not a limit: R never pays more than it holds)
export type WithdrawCode = 'lane' | 'busy' | 'trade' | 'amount' | 'gas' | 'address' | 'unsupported' | 'failed';
type WT = Record<WithdrawCode, (v: Record<string, string>) => string>;
export const WITHDRAW_TEXT: Record<FloatLang, WT> = {
  en: {
    lane: () => 'Ask the vault of that network — nothing was sent',
    busy: () => 'This wallet\'s USD balance is moving right now: try again in a moment — nothing was sent',
    trade: () => 'A trade is being sent: try again in a moment — nothing was sent',
    amount: (v) => `Only ${v.have} can be withdrawn now (at least $0.10) — nothing was sent`,
    gas: () => 'Your USD balance on this network has no gas for the transfer yet — nothing was sent',
    address: () => 'That address is one of this account\'s USD-balance reserves — nothing was sent',
    unsupported: () => 'Withdrawing from the USD balance on this network arrives with the next wallet update — nothing was sent',
    failed: (v) => `The transfer was not sent (${v.why}) — nothing was sent`,
  },
  ru: {
    lane: () => 'Спросите хранилище этой сети — ничего не отправлено',
    busy: () => 'Баланс в USD этого кошелька сейчас в движении: попробуйте через мгновение — ничего не отправлено',
    trade: () => 'Сейчас отправляется сделка: попробуйте через мгновение — ничего не отправлено',
    amount: (v) => `Сейчас можно вывести только ${v.have} (не меньше $0.10) — ничего не отправлено`,
    gas: () => 'У баланса в USD в этой сети пока нет газа на перевод — ничего не отправлено',
    address: () => 'Этот адрес — резерв баланса в USD этого аккаунта — ничего не отправлено',
    unsupported: () => 'Вывод из баланса в USD в этой сети появится со следующим обновлением кошелька — ничего не отправлено',
    failed: (v) => `Перевод не отправлен (${v.why}) — ничего не отправлено`,
  },
  zh: {
    lane: () => '请向该网络的保险库发起 — 未发送任何资金',
    busy: () => '此钱包的 USD 余额正在移动：请稍后再试 — 未发送任何资金',
    trade: () => '正在发送一笔交易：请稍后再试 — 未发送任何资金',
    amount: (v) => `目前最多可提取 ${v.have}（至少 $0.10） — 未发送任何资金`,
    gas: () => '你在该网络的 USD 余额暂无转账所需的 gas — 未发送任何资金',
    address: () => '该地址是此账户 USD 余额的储备地址 — 未发送任何资金',
    unsupported: () => '该网络的 USD 余额提取将随下一次钱包更新推出 — 未发送任何资金',
    failed: (v) => `转账未发送（${v.why}） — 未发送任何资金`,
  },
  id: {
    lane: () => 'Minta ke vault jaringan itu — tidak ada yang dikirim',
    busy: () => 'Saldo USD dompet ini sedang bergerak: coba lagi sebentar lagi — tidak ada yang dikirim',
    trade: () => 'Sebuah transaksi sedang dikirim: coba lagi sebentar lagi — tidak ada yang dikirim',
    amount: (v) => `Saat ini hanya ${v.have} yang bisa ditarik (minimal $0.10) — tidak ada yang dikirim`,
    gas: () => 'Saldo USD Anda di jaringan ini belum punya gas untuk transfer — tidak ada yang dikirim',
    address: () => 'Alamat itu adalah cadangan saldo USD akun ini — tidak ada yang dikirim',
    unsupported: () => 'Penarikan saldo USD di jaringan ini hadir pada pembaruan dompet berikutnya — tidak ada yang dikirim',
    failed: (v) => `Transfer tidak terkirim (${v.why}) — tidak ada yang dikirim`,
  },
  es: {
    lane: () => 'Pídelo a la bóveda de esa red — no se envió nada',
    busy: () => 'El saldo en USD de esta cartera se está moviendo ahora: inténtalo en un momento — no se envió nada',
    trade: () => 'Se está enviando una operación: inténtalo en un momento — no se envió nada',
    amount: (v) => `Ahora solo se pueden retirar ${v.have} (mínimo $0.10) — no se envió nada`,
    gas: () => 'Tu saldo en USD en esta red aún no tiene gas para la transferencia — no se envió nada',
    address: () => 'Esa dirección es una reserva del saldo en USD de esta cuenta — no se envió nada',
    unsupported: () => 'Retirar del saldo en USD en esta red llega con la próxima actualización de la cartera — no se envió nada',
    failed: (v) => `La transferencia no se envió (${v.why}) — no se envió nada`,
  },
  fr: {
    lane: () => 'Demandez au coffre de ce réseau — rien n’a été envoyé',
    busy: () => 'Le solde en USD de ce portefeuille bouge en ce moment : réessayez dans un instant — rien n’a été envoyé',
    trade: () => 'Un ordre est en cours d’envoi : réessayez dans un instant — rien n’a été envoyé',
    amount: (v) => `Seuls ${v.have} peuvent être retirés maintenant (au moins 0,10 $) — rien n’a été envoyé`,
    gas: () => 'Votre solde en USD sur ce réseau n’a pas encore de gas pour le virement — rien n’a été envoyé',
    address: () => 'Cette adresse est une réserve du solde en USD de ce compte — rien n’a été envoyé',
    unsupported: () => 'Le retrait du solde en USD sur ce réseau arrive avec la prochaine mise à jour du portefeuille — rien n’a été envoyé',
    failed: (v) => `Le virement n’a pas été envoyé (${v.why}) — rien n’a été envoyé`,
  },
};
export const withdrawWhy = (code: WithdrawCode, lang: FloatLang, v: Record<string, string> = {}): string => (WITHDRAW_TEXT[lang] ?? WITHDRAW_TEXT.en)[code]({ why: '', have: '$0.00', ...v });
/** A raw token amount as a decimal string, exactly (12_500_000 at 6 decimals = "12.5"). */
export function decimalOf(raw: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals); const i = raw / d, f = raw % d;
  return f === 0n ? String(i) : `${i}.${f.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

// ── jobs (§5) ──
export type JobState = 'planned' | 'signing' | 'sent' | 'relaying' | 'arrived' | 'failed' | 'refunded' | 'unknown';
export const JOB_TERMINAL: JobState[] = ['arrived', 'failed', 'refunded'];
export type FloatJob = {
  id: string; walletId: string; kind: MoveKind; chain: FloatChain; from?: FloatChain; usd6: string; fee6: string;
  state: JobState; at: number; updatedAt: number; hashes: string[]; nonce?: number; bridge?: BridgeId; requestId?: string;
  amountIn?: string; minOut?: string; out?: string; error?: string; reason: string; tried?: BridgeId[];
  // a move planned for a waiting click (hold & fire): the user's own, so the quiet rule does not hold it back
  click?: boolean;
  // the after-trade refill of the ready float (REFILL): runs on the fast path and defers only to a trade being signed
  refill?: boolean;
  // a conversion the user confirmed in the vault's own dialog: 'on' = switch-on (W native → R stable), 'off' = switch-off
  // (R stable → W native). Exempt from the day / fee caps and the quiet rule; still priced by the oracle, still never in a
  // click window, never more than the dialog stated.
  confirmed?: 'on' | 'off';
  // a cold top-up paid from the trading wallet W's OWN native on the source chain (src/nativeDonor.ts, 2026-10-30), not
  // from the reserve R: W signed a Relay native deposit there, and W on `chain` receives it
  src?: 'w';
  // a click's cross-chain move into W (2026-11-01 pass 2): W's native in the read the plan was made from (`base`, raw) and that
  // read's time (`baseAt`; every move of one plan shares it). A later read of this frame showing W at base + what the plan's
  // arrived moves paid proves the payout shows here, so the settle wait (BRIDGE_SETTLE_MS) is over for them
  base?: string; baseAt?: number;
  // a ready-dollar move (READY, 2026-11-01 pass 3): its stated bridge fee is bounded (readyFeeMax6) and counted apart in the ledger
  ready?: boolean;
  // motion's payout transaction as the solver named it when it answered 'paid' at the payout's broadcast (A3, 2026-11-01 pass 3):
  // the vault looks it up on the destination chain itself; the job is 'arrived' only once that chain shows it landed
  dstHash?: string;
};
// job ids are deterministic per (wallet, kind, chain, minute bucket): a second ensure in the same minute joins the first
// `seq` > 0 = the next move of that lane in the same minute once the one before it is over (freeJobId); 0 is the old id
export const jobIdOf = (walletId: string, kind: MoveKind, chain: FloatChain, from: FloatChain | undefined, now: number, seq = 0) =>
  hex(sha256(new TextEncoder().encode(`${walletId}|${kind}|${from || ''}>${chain}|${Math.floor(now / 60_000)}${seq > 0 ? '|' + seq : ''}`))).slice(0, 24);
// The id a new move of a lane takes (2026-11-01: a second click, cross-chain move or after-trade refill of the same chain in the
// same calendar minute was silently skipped, because the first move's id was taken by a job that had ARRIVED; the buy then
// waited 15 s for a move that never ran). A job that is over and did move money (arrived / refunded) keeps its id and its
// ledger line, and the new move takes the next free one. Anything else keeps today's rule on the SAME id: an open or unknown
// job is never run again (canRun), a failed one only after its back-off.
// A cross-chain move (cold / rebalance) that ARRIVED this recently still holds its lane: its arrival is the solver's / Relay's
// word, and the destination chain's own read may not show the payout yet, so a new move planned on that read could bridge the
// same need twice. A same-chain top-up's arrival is its own receipt on the chain the plan reads: no such wait
export const BRIDGE_SETTLE_MS = 10_000;
/**
 * The settle wait is over for an arrived cross-chain move into W when one of this frame's own reads, taken after the plan's read
 * (`baseAt`), shows W at least at `base` + what every arrived move of that plan paid (minOut). 2026-11-01 pass 2: a second
 * cross-chain-funded click within 10 s of the first one's arrival — a double tap: the first buy already spent the payout — was
 * held behind the settle wait, answered "moving" and waited 15 s for nothing, then "not sent". The read the first click's hold
 * fired on had seen the payout. A move without `base` (an older engine's job, a rebalance) keeps the 10 s wait.
 * (Any other inflow to W in between can stand in for the payout: the worst case is one extra move of the user's own dollars
 * into the user's own W — nothing leaves the wallets.)
 */
export function payoutSeen(job: FloatJob, jobs: readonly FloatJob[], reads: readonly { at: number; float: bigint }[]): boolean {
  if (job.base == null || !(Number(job.baseAt) > 0)) return false;
  let base: bigint; try { base = BigInt(job.base); } catch { return false; }
  const paid = jobs.filter((j) => j.state === 'arrived' && j.kind === 'cold' && j.chain === job.chain && j.baseAt === job.baseAt && j.base === job.base)
    .reduce((t, j) => { try { return t + BigInt(j.minOut || j.out || '0'); } catch { return t; } }, 0n);
  if (!(paid > 0n)) return false;
  return reads.some((r) => r.at > job.baseAt! && r.float >= base + paid);
}
/** Why a click's top-up was refused, as a code the app words in the user's language (the vault's own why stays for the log). */
export type ClickCode = 'over-cap' | 'bridge-busy' | 'bridge-off' | 'bridge-limit' | 'settling' | 'refused';
export function clickCodeOf(why: string): ClickCode {
  const t = String(why || '');
  if (/per-fill cap|above what motion|motion's bridge may carry|motion carries/i.test(t)) return 'over-cap';
  if (/already in flight/i.test(t)) return 'bridge-busy';
  if (/inventory floor|daily cap|hourly cap/i.test(t)) return 'bridge-limit';
  if (/solver is off|(?:motion|bridge): off\b|not configured|restarting|draining|\b50[23]\b|timed out|throttl|not available/i.test(t)) return 'bridge-off';
  return 'refused';
}
export function freeJobId(jobs: readonly FloatJob[], walletId: string, kind: MoveKind, chain: FloatChain, from: FloatChain | undefined, now: number): { id: string; existing?: FloatJob } {
  let id = jobIdOf(walletId, kind, chain, from, now);
  for (let seq = 1; seq <= 64; seq++) {
    const existing = jobs.find((j) => j.id === id);
    if (!existing) return { id };
    if (existing.state !== 'arrived' && existing.state !== 'refunded') return { id, existing };
    id = jobIdOf(walletId, kind, chain, from, now, seq);
  }
  return { id, existing: jobs.find((j) => j.id === id) };
}
// never retry an unknown outcome: only planned/failed jobs may run again, and only after their back-off
export function canRun(job: FloatJob | undefined, now: number): boolean {
  if (!job) return true;
  if (job.state === 'failed') return now - job.updatedAt >= 30_000;
  return false;
}
export const isOpen = (j: FloatJob) => !JOB_TERMINAL.includes(j.state);
// what the day's ledger says: moved and fees since local midnight UTC (the caps' day). Not counted against the day's cap:
// sweeps (W's own surplus to R, see planMoves) and the conversions the user confirmed in the dialog (whose fees
// are not counted against the fee cap either: the dialog stated them). Every fee still shows in "Upkeep this week".
export function ledgerOf(jobs: FloatJob[], now: number): { movedToday6: bigint; feesToday6: bigint; upkeepWeek6: bigint } {
  const day = Math.floor(now / 86_400_000) * 86_400_000; const week = now - 7 * 86_400_000;
  let movedToday6 = 0n, feesToday6 = 0n, upkeepWeek6 = 0n;
  for (const j of jobs) {
    if (j.state === 'planned' || j.state === 'failed') continue;   // nothing left the wallet
    if (j.at >= day && !j.confirmed) { if (j.kind !== 'sweep') movedToday6 += BigInt(j.usd6); feesToday6 += BigInt(j.fee6); }
    if (j.at >= week) upkeepWeek6 += BigInt(j.fee6);
  }
  return { movedToday6, feesToday6, upkeepWeek6 };
}

// ── click windows (§4 I3) ──
// a click window runs from the trade call to its broadcast + 2 s, and from a token page's focus + 10 s: no float request
// and no W send in it. The engine stamps clickAt (one write, no await) on every trade entry.
export const CLICK_TAIL_MS = 2_000, FOCUS_MS = 10_000;
export function inClickWindow(t: { clickAt: number; clickDoneAt: number; focusAt: number }, now: number): boolean {
  if (t.clickAt > t.clickDoneAt) return true;                         // a trade is between its call and its broadcast
  if (t.clickDoneAt && now - t.clickDoneAt < CLICK_TAIL_MS) return true;
  if (t.focusAt && now - t.focusAt < FOCUS_MS) return true;
  return false;
}
// the sweep idle rule (§5): no trade in 60 s, no token page of this chain focused, the page hidden or the ticket
// untouched for 60 s, no limit placement running
export function idleFor(t: { lastTradeAt: number; focusedChain: string | null; hidden: boolean; ticketAt: number; limitBusy: boolean }, chain: FloatChain, now: number): boolean {
  return now - t.lastTradeAt >= 60_000 && t.focusedChain !== chain && (t.hidden || now - t.ticketAt >= 60_000) && !t.limitBusy;
}
// The quiet rule (2026-10-26, replaces the idle rule for W's own sends: sweeps and R's gas). A deposit has to become USD
// within a minute, so the 60 s idle and the "no focused token page" conditions are gone. What stays is what keeps a W send
// off a click: no click window (a trade between its call and broadcast + 2 s, a token page's focus + 10 s), no trade and
// no ticket touch in the last 10 s (a click is likely then: W's send lane would make it queue behind the sweep's
// broadcast), no limit placement running. The last check right before W signs is the click window (a click cancels a
// sweep that is not sent yet).
export const QUIET_MS = 60_000;   // 2026-10-26 controller: kept at the old idle rule so a sweep never shares W's lane with a likely click
export function quietFor(t: { clickAt: number; clickDoneAt: number; focusAt: number; lastTradeAt: number; hidden: boolean; ticketAt: number; limitBusy: boolean }, now: number): boolean {
  return !inClickWindow(t, now) && now - t.lastTradeAt >= QUIET_MS && (t.hidden || now - t.ticketAt >= QUIET_MS) && !t.limitBusy;
}

// ── token bucket for the float's own RPC clients (§4 I2: ≤ 1 request/s per lane) ──
export function bucket(ratePerSec: number, burst: number, clock: () => number) {
  let tokens = burst, at = clock();
  return {
    take(): number {   // ms to wait before the call may go (0 = now); the token is spent
      const now = clock(); tokens = Math.min(burst, tokens + ((now - at) / 1000) * ratePerSec); at = now;
      if (tokens >= 1) { tokens -= 1; return 0; }
      const wait = Math.ceil(((1 - tokens) / ratePerSec) * 1000); tokens -= 1; return wait;
    },
  };
}

// ── bridges (§6) ──
// 'motion' is motion's OWN solver (trench server/motion-bridge.mjs, docs/drafts/MOTION-BRIDGE.md): it pays the
// destination native from motion's inventory the moment the user's source transfer is included (~1 s), and it is tried
// first for a cold top-up that fits its per-fill cap. Everything else — and motion's own refusal — falls through to the
// public bridges below, exactly as before.
export type BridgeId = 'motion' | 'relay' | 'debridge' | 'mayan' | 'across';
export type RouteKey = `${FloatChain}>${FloatChain}`;
// the failover order per route (§6.2); a demoted bridge goes to the end for 24 h
export const BRIDGE_ORDER: Record<RouteKey, BridgeId[]> = {
  'robinhood>sol': ['motion', 'relay', 'debridge'], 'sol>robinhood': ['motion', 'relay', 'debridge'],
  'robinhood>bsc': ['motion', 'relay', 'debridge'], 'bsc>robinhood': ['motion', 'relay', 'debridge'],
  'sol>bsc': ['motion', 'relay', 'mayan', 'debridge'], 'bsc>sol': ['motion', 'relay', 'mayan', 'debridge'],
  'robinhood>robinhood': [], 'bsc>bsc': [], 'sol>sol': [],
};
// planning ETAs (§6.2: pump.fun's measured Relay figures, not Relay's quoted 1 s)
export const BRIDGE_ETA_MS: Record<BridgeId, number> = { motion: 1_500, relay: 4_000, debridge: 6_000, mayan: 5_000, across: 3_000 };
export const QUOTE_TIMEOUT_MS = 5_000;
// What each bridge may be asked to do from the vault today. A bridge without execution is quoted (so the failover is
// visible and measured) but never signed for, until its own security review (§6.2 "each new bridge is a security
// review"). Relay ships first; deBridge's EVM origin is reviewed here (DlnSource allow-list + createOrder decode).
export const BRIDGE_EXEC: Record<BridgeId, { evm: boolean; sol: boolean }> = {
  // motion's own solver: the vault signs ONE transfer of the quoted amount to a published deposit address — an ERC-20
  // transfer on EVM, an SPL transferChecked + the quote id in a memo on Solana — and never a third-party contract call.
  motion: { evm: true, sol: true },
  relay: { evm: true, sol: false },      // Solana origin: Relay returns raw instructions — reviewed with phase 4's SVM checks
  debridge: { evm: true, sol: false },
  mayan: { evm: false, sol: false },     // SOL ↔ BNB only; Swift needs SDK ≥ 13; quote-only until reviewed
  across: { evm: false, sol: false },    // deposits from Base / Arbitrum only (phase 5)
};
// contract allow-lists: the ONLY addresses a bridge deposit may call or approve (read 2026-10-25 from each bridge's API:
// Relay /chains + /quote/v2 steps, deBridge create-tx). The vault fetches quotes itself; these pins hold even if a
// bridge's API were compromised.
export const BRIDGE_CONTRACTS: Record<BridgeId, Partial<Record<FloatChain, string[]>>> = {
  relay: { robinhood: ['0x4cd00e387622c35bddb9b4c962c136462338bc31'], bsc: ['0x4cd00e387622c35bddb9b4c962c136462338bc31'], sol: ['99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'] },
  debridge: { robinhood: ['0xef4fb24ad0916217251f553c0596f8edc630eb66'], bsc: ['0xef4fb24ad0916217251f553c0596f8edc630eb66'], sol: ['src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4'] },
  // motion's solver is paid by a plain token transfer, not by a contract call: its deposit addresses are checked
  // against the ones its /health route publishes (src/motionBridgeCore.ts quoteProblem), never against a pin here.
  motion: {}, mayan: {}, across: {},
};
export const RELAY_DEPOSIT_ERC20 = '0xe8017952';   // depositErc20(address depositor, address token, uint256 amount, bytes32 id)
export const ERC20_APPROVE = '0x095ea7b3';
export type BridgeOutcome = { bridge: BridgeId; route: RouteKey; ok: boolean; sentAt: number; doneAt: number; etaMs: number };
export type Health = { n: number; success: number; p50: number; demotedUntil: number };
// rolling health over the last 20 moves of a bridge on a route; < 90 % success (n ≥ 3) or p50 > 3× ETA demotes it for 24 h
export function bridgeHealth(outcomes: BridgeOutcome[], now: number): Record<string, Health> {
  const out: Record<string, Health> = {};
  const groups = new Map<string, BridgeOutcome[]>();
  for (const o of outcomes) { const k = `${o.bridge}:${o.route}`; groups.set(k, [...(groups.get(k) || []), o]); }
  for (const [k, list] of groups) {
    const last = list.sort((a, b) => a.doneAt - b.doneAt).slice(-20);
    const ok = last.filter((x) => x.ok); const times = ok.map((x) => x.doneAt - x.sentAt).sort((a, b) => a - b);
    const success = last.length ? ok.length / last.length : 1; const p50 = times.length ? times[Math.floor(times.length / 2)] : 0;
    const eta = last[last.length - 1].etaMs || BRIDGE_ETA_MS[last[0].bridge];
    const bad = (last.length >= 3 && success < 0.9) || (times.length >= 3 && p50 > 3 * eta);
    const lastAt = last[last.length - 1].doneAt;
    out[k] = { n: last.length, success, p50, demotedUntil: bad ? lastAt + 86_400_000 : 0 };
  }
  for (const k of Object.keys(out)) if (out[k].demotedUntil && out[k].demotedUntil <= now) out[k].demotedUntil = 0;
  return out;
}
export function bridgeOrder(route: RouteKey, health: Record<string, Health>, now: number, kind: 'evm' | 'sol'): BridgeId[] {
  const base = BRIDGE_ORDER[route] || [];
  const usable = base.filter((b) => BRIDGE_EXEC[b][kind]);
  const quoteOnly = base.filter((b) => !BRIDGE_EXEC[b][kind]);
  const good = usable.filter((b) => !(health[`${b}:${route}`]?.demotedUntil > now));
  const demoted = usable.filter((b) => health[`${b}:${route}`]?.demotedUntil > now);
  return [...good, ...demoted, ...quoteOnly];
}
// a quote, normalised across bridges (what the vault checks before it signs anything)
export type BridgeQuote = {
  bridge: BridgeId; route: RouteKey; amountIn: bigint; out: bigint; minOut: bigint; fees6: bigint; etaMs: number;
  recipient: string; requestId: string;
  // EVM origin: the exact transactions, in order (approve first, then the deposit)
  txs?: { to: string; data: string; value: bigint }[];
  outDecimals: number;
};
// Failover happens only before the origin send: a quote that fails, times out, breaks the price check or the fee cap
// sends us to the next bridge. After a send the job waits on that bridge — never a second send for the same need.
export function verifyBridgeQuote(q: BridgeQuote, want: { from: FloatChain; to: FloatChain; signer: string; recipient: string; amountIn: bigint; stableIn: string; maxSlipBps: number; feeRoom6: bigint }): string | null {
  if (q.route !== `${want.from}>${want.to}`) return 'Quote is for another route';
  if (q.amountIn !== want.amountIn) return 'Quote amount differs from the planned amount';
  if (String(q.recipient).toLowerCase() !== want.recipient.toLowerCase()) return 'Quote pays someone else';
  if (q.fees6 > want.feeRoom6) return 'Over the daily fee cap';
  const in6 = stableToUsd6(q.amountIn, FLOAT_CFG[want.from].stable.decimals);
  const out6 = stableToUsd6(q.minOut, q.outDecimals);
  // stable → stable: the minimum out must be ≥ (in − stated fees) × (1 − maxSlip)
  const floor6 = ((in6 - q.fees6) * BigInt(10_000 - want.maxSlipBps)) / 10_000n;
  if (!(q.minOut > 0n) || out6 < floor6) return 'The quote is below the amount minus fees and slippage';
  return q.txs ? verifyBridgeTxs(q, want) : null;
}
// the origin transactions themselves: only the bridge's pinned contracts, an exact-amount approval, and (Relay) a deposit
// that names this reserve as depositor, the planned stablecoin and the planned amount
export function verifyBridgeTxs(q: Pick<BridgeQuote, 'bridge' | 'amountIn' | 'txs'>, want: { from: FloatChain; signer: string; stableIn: string }): string | null {
  const allow = (BRIDGE_CONTRACTS[q.bridge][want.from] || []).map((x) => x.toLowerCase());
  if (!allow.length) return 'This bridge is not allowed on this chain';
  if (!q.txs || !q.txs.length) return 'The quote has no transaction';
  const stable = want.stableIn.toLowerCase(); const me = want.signer.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let deposits = 0;
  for (const t of q.txs) {
    const to = t.to.toLowerCase(); const data = t.data.toLowerCase(); const sel = data.slice(0, 10);
    if (to === stable) {
      if (sel !== ERC20_APPROVE || t.value !== 0n || data.length !== 138) return 'Unexpected call to the stablecoin';
      const spender = '0x' + data.slice(34, 74); const amount = BigInt('0x' + data.slice(74, 138));
      if (!allow.includes(spender)) return 'Approval to an unknown contract';
      if (amount !== q.amountIn) return 'Approval is not for the exact amount';
      continue;
    }
    if (!allow.includes(to)) return 'Deposit to an unknown contract';
    deposits += 1;
    if (q.bridge === 'relay') {
      if (sel !== RELAY_DEPOSIT_ERC20 || t.value !== 0n || data.length !== 266) return 'Unexpected Relay call';
      const depositor = data.slice(10, 74); const token = '0x' + data.slice(98, 138); const amount = BigInt('0x' + data.slice(138, 202));
      if (depositor !== me) return 'Relay deposit names another depositor';
      if (token !== stable || amount !== q.amountIn) return 'Relay deposit token or amount differs';
    } else if (q.bridge === 'debridge') {
      // DlnSource.createOrder: its only native value is deBridge's fixed fee; token, amount and recipient are checked by the
      // simulation from R (after the exact approval, a different token or a larger amount reverts) and by the quote check
      if (t.value > 10n ** 16n) return 'deBridge native fee looks wrong';
    } else return 'This bridge is not executable from the vault yet';
  }
  return deposits === 1 ? null : 'Expected exactly one deposit';
}

// ── the network fee of a trade, in dollars (the owner's rule: every USD-mode trade shows it before the click) ──
// Pure, from CACHED inputs only (no round trip on the click path). Inputs come from the lane's /api/netfee (server
// cache, refreshed every 15 s) and the vault's own settings; the result says how old its inputs are.
export type FeeInputs = {
  at: number;                      // when the server read them
  nativeUsd: number;               // the lane's native price (ethUsd / BNB / SOL)
  evm?: { baseFee: string; gasPrice: string; l1PerByte: string };   // wei (strings: JSON-safe bigints)
  sol?: { tipP75: number; tipP95: number; microMedium: number; microHigh: number; microVeryHigh: number };   // tip in SOL, priority µlamports/CU
};
export type FeeSettings = { turbo?: boolean; gasBoost?: number; solTip?: number; solPriority?: number };
// gas units per venue (p50 of real receipts on 2026-10-25, motion's own venues; L1 gas is 0 on Robinhood today and is
// priced from ArbGasInfo's per-byte figure when it is not), and calldata bytes for the L1 share
export const EVM_GAS: Record<string, { buy: number; sell: number; bytes: number }> = {
  pons: { buy: 150_000, sell: 160_000, bytes: 330 }, v4: { buy: 185_000, sell: 215_000, bytes: 900 }, v3: { buy: 150_000, sell: 160_000, bytes: 330 },
  v2: { buy: 140_000, sell: 150_000, bytes: 330 }, standard: { buy: 320_000, sell: 360_000, bytes: 1200 }, four: { buy: 190_000, sell: 170_000, bytes: 200 },
  flap: { buy: 210_000, sell: 200_000, bytes: 400 }, inf: { buy: 200_000, sell: 230_000, bytes: 900 },
};
export const SOL_UNITS: Record<string, number> = { pump: 90_000, pumpswap: 110_000, dlmm: 200_000 };
export type NetFee = { usd6: bigint; native: bigint; nativeSymbol: string; parts: { label: string; native: bigint }[]; stale: boolean; ageMs: number };
// RH: Arbitrum-style — a legacy tx pays the BASE fee whatever gasPrice it signs (the rest is a balance requirement),
// plus the L1 share (bytes × per-byte price). BNB: a legacy tx pays its full signed gasPrice = max(base, gasPrice) ×
// 1.25 × boost (the engine's feeFor). Solana: 5 000 lamports per signature + priority (µlamports × units) + the Jito
// tip, with the engine's own mode rules (src/solEngine.ts sendPlan) and its ~0.005 SOL ceiling.
export function netFeeOf(chain: FloatChain, venue: string, side: 'buy' | 'sell', inp: FeeInputs | null, s: FeeSettings, now: number, extra6 = 0n): NetFee | null {
  if (!inp || !(inp.nativeUsd > 0) || priceState(inp.at, now) === 'dead') return null;
  const price6 = usd6(inp.nativeUsd); const c = FLOAT_CFG[chain];
  const parts: { label: string; native: bigint }[] = [];
  if (c.kind === 'evm') {
    if (!inp.evm) return null;
    const g = EVM_GAS[venue] || EVM_GAS.v4; const units = BigInt(side === 'buy' ? g.buy : g.sell);
    const base = BigInt(inp.evm.baseFee || '0'), gp = BigInt(inp.evm.gasPrice || '0'), l1 = BigInt(inp.evm.l1PerByte || '0');
    // the engine signs every EVM trade at feeFor(settings.gasBoost) — Turbo changes the gas limit, not the price
    const boost = BigInt(Math.round(Math.max(1, Math.min(5, s.gasBoost || 1.5)) * 100));
    const signed = ((base > gp ? base : gp) * 125n * boost) / 10_000n;
    const paid = chain === 'robinhood' ? (base > 0n ? base : gp) : signed;
    parts.push({ label: 'gas', native: units * paid });
    if (l1 > 0n) parts.push({ label: 'L1 data', native: BigInt(g.bytes + 110) * l1 });
  } else {
    if (!inp.sol) return null;
    const mode = s.turbo ? 'turbo' : (s.gasBoost || 1.5) <= 1 ? 'eco' : 'fast';   // the engine's default boost is 1.5 (Fast)
    const tipSol = s.solTip && s.solTip > 0 ? Math.min(0.1, s.solTip) : mode === 'turbo' ? Math.min(0.003, Math.max(0.0002, inp.sol.tipP95 || 0.0015)) : mode === 'fast' ? Math.min(0.001, Math.max(0.00005, inp.sol.tipP75 || 0.00002)) : 0;
    let micro = s.solPriority && s.solPriority > 0 ? s.solPriority : Number(mode === 'turbo' ? inp.sol.microVeryHigh : mode === 'fast' ? inp.sol.microHigh : inp.sol.microMedium) || (mode === 'eco' ? 1000 : 50000);
    micro = Math.ceil(Math.max(0, Math.min(micro, mode === 'turbo' ? 5_000_000 : 2_000_000)));
    let tip = BigInt(Math.round(tipSol * 1e9)); const CEIL = 5_000_000n; if (tip > CEIL) tip = CEIL;
    const prioCeil = ((CEIL - tip) * 1_000_000n) / 400_000n; if (BigInt(micro) > prioCeil) micro = Number(prioCeil);
    // Fast signs what the simulation used × 1.25 + 5 000; Turbo signs its fixed limit (300k, DLMM 400k)
    const used = SOL_UNITS[venue] || SOL_UNITS.pump;
    const units = BigInt(s.turbo ? (venue === 'dlmm' ? 400_000 : 300_000) : Math.min(400_000, Math.ceil(used * 1.25) + 5_000));
    parts.push({ label: 'base', native: 5_000n });
    parts.push({ label: 'priority', native: (BigInt(micro) * units + 999_999n) / 1_000_000n });
    if (tip > 0n) parts.push({ label: 'Jito tip', native: tip });
  }
  const native = parts.reduce((t, p) => t + p.native, 0n);
  const usd = nativeToUsd6Up(native, price6, c.nativeDecimals) + extra6;
  return { usd6: usd, native, nativeSymbol: c.native, parts, stale: priceState(inp.at, now) === 'stale', ageMs: Math.max(0, now - inp.at) };
}
// the cost of one same-chain move (R's approve + swap, or W's sweep), for the planner's fee cap and "Upkeep this week"
export function moveFee6(chain: FloatChain, kind: MoveKind, inp: FeeInputs | null, now: number, amount6 = 0n, bridgeFee6 = 0n): bigint {
  const poolFee = (amount6 * BigInt(chain === 'sol' ? 1_000 : FLOAT_CFG[chain as 'robinhood'].swapFee)) / 1_000_000n;   // the EVM pools are 0.01 % (fee 100 ppm); the SOL DLMM pool (bin step 10) charges ~0.1 %
  if (!inp || !(inp.nativeUsd > 0)) return poolFee + bridgeFee6 + USD / 100n;   // unknown gas: count a cent, never zero
  const price6 = usd6(inp.nativeUsd); const c = FLOAT_CFG[chain];
  let native = 0n;
  if (c.kind === 'evm' && inp.evm) { const base = BigInt(inp.evm.baseFee || '0'), gp = BigInt(inp.evm.gasPrice || '0'); const p = chain === 'robinhood' ? (base || gp) : ((base > gp ? base : gp) * 125n) / 100n; native = (kind === 'gas' ? 21_000n : c.swapGas) * p; }
  else if (c.kind === 'sol') native = 5_000n + 50_000n * 250_000n / 1_000_000n;
  void now;
  return nativeToUsd6Up(native, price6, c.nativeDecimals) + (kind === 'gas' ? 0n : poolFee) + bridgeFee6;
}

// ── USDC sent straight to a Solana trading wallet (2026-10-27: the forward worked on EVM only) ──
// W's USDC (the pinned mint, W's own associated account) goes to its own R in ONE transferChecked, R's account created if
// missing (idempotent). Who pays the network fee and that account's rent:
//   · W, when it can and still stays rent-exempt (one transaction, the same send path as the sweep);
//   · else R pays W exactly what W lacks first (R → W lamports, nothing else), then W forwards;
//   · else nothing moves: the USDC waits in W (a reserve with $2+ gets motion's gas drop first, SOL_GAS, and pays next tick).
// These are the numbers; floatEngine forwardSol runs them, webEngine builds the two transactions.
export const SOL_FWD = {
  units: 60_000, micro: 50_000,             // the forward: ATA create-if-missing (~25k CU when it creates) + transferChecked (~6k)
  fundUnits: 1_000, fundMicro: 50_000,      // R → W: one System transfer (as R's gas, W → R)
  sigFee: 5_000n,                           // lamports per signature
  ataRent: 2_039_280n,                      // a token account (165 bytes), when R has none yet
  rentMin: 890_880n,                        // a system account's rent-exempt minimum: no payer ends below it
  fundMax: 3_000_000n,                      // the most R ever pays W for this (fee + rent + W's minimum ≈ 2.94M)
  settleMs: 90_000,                         // a sent transaction is followed this long; its blockhash is dead by then
  retryMs: 600_000,                         // a forward that landed and failed is tried again after 10 minutes
} as const;
export const solFwdFee = (units: number, micro: number): bigint => SOL_FWD.sigFee + BigInt(Math.ceil((units * micro) / 1_000_000));
// The Solana reserve as a click's bridge donor from an EVM frame (2026-10-27): R pays its ONE transfer to motion's solver
// (webEngine bridgeSignSolTransfer: 60 000 CU at 50 000 µlamports, one signature) and never ends below the rent-exempt
// minimum. A reserve with less SOL than that asks motion's gas drop (SOL_GAS) first; refused or not landed, it is not signed for
export const SOL_BRIDGE = { units: 60_000, micro: 50_000 } as const;
export const solBridgeFeeOk = (rLamports: bigint): boolean => rLamports >= solFwdFee(SOL_BRIDGE.units, SOL_BRIDGE.micro) + SOL_FWD.rentMin;
// The Solana gas drop (2026-10-27, owner: "do it too": a reserve under ~0.0009 SOL could not pay fees or donate). motion's solver
// (server/motion-bridge.mjs solGasDrop, the same numbers) sends `drop` lamports to a reserve holding $2+ of USDC and less than
// `enough`, once a day. What R pays for its own moves, by the counts above:
//   · the click top-up swap (solFloatSend: 300 000 CU at 50 000 µlamports + one signature = 20 000) opens a temporary wSOL account
//     (SOL_FWD.ataRent, returned in the same transaction): 2 059 280 up front — the costliest;
//   · funding W for a forward (solForwardPlan, W at 0): 1 794 810; the donor transfer (solBridgeFeeOk): 898 880.
// `enough` rounds the first up: a reserve at or above it pays any of its own moves itself, so the plan lets it move without W's
// gas (when W cannot spare it). `drop` (0.003 SOL, ~$0.30 at $100) leaves ~45 top-ups of fees before R is under `enough` again.
export const SOL_GAS = { drop: 3_000_000n, enough: 2_100_000n, minUsd6: 2_000_000n } as const;
// What a refused Solana direct build said its reserve needs (solEngine's SolDirectNoGas, 2026-11-01: "The reserve needs about
// 0.0031 for the network fee and account rent — it has …", 4 decimals) in lamports, rounded UP past the shown figure, for the
// direct buy's gas ask (floatEngine directGas). Undefined = not read (then the ask is the plain SOL_GAS.enough one)
export function solDirectNeedOf(e: unknown): bigint | undefined {
  const m = /needs about (\d{1,3}(?:\.\d{1,9})?)(?![\d.])/.exec(String((e as Error)?.message ?? ''));
  if (!m) return undefined;
  const [i, f = ''] = m[1].split('.');
  const l = BigInt(i) * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9));
  return l > 0n ? l + 50_000n : undefined;   // toFixed(4) rounds to the nearest 100 000 lamports: +50 000 covers the rounding
}
export type SolForwardPlan = { pay: 'w'; cost: bigint } | { pay: 'r'; lamports: bigint; cost: bigint } | { pay: 'none'; cost: bigint };
/** Who pays a forward: W (if it stays rent-exempt), else R tops W up by exactly what it lacks, else nobody. `rStable` 0 =
 *  R's USDC account may not exist yet: its rent is counted (an existing one costs nothing; the create is idempotent). */
export function solForwardPlan(o: { wLamports: bigint; rLamports: bigint; rStable: bigint }): SolForwardPlan {
  const cost = solFwdFee(SOL_FWD.units, SOL_FWD.micro) + (o.rStable > 0n ? 0n : SOL_FWD.ataRent);
  if (o.wLamports >= cost + SOL_FWD.rentMin) return { pay: 'w', cost };
  const lamports = cost + SOL_FWD.rentMin - o.wLamports;
  if (lamports <= SOL_FWD.fundMax && o.rLamports >= lamports + solFwdFee(SOL_FWD.fundUnits, SOL_FWD.fundMicro) + SOL_FWD.rentMin) return { pay: 'r', lamports, cost };
  return { pay: 'none', cost };
}
