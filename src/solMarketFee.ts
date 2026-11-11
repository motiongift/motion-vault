// fee-cov-1110 (SOL): the 0.20 % terminal fee INSIDE every Solana market trade the vault signs — pump.fun curve, PumpSwap,
// pumphop, Meteora DLMM and Jupiter routes (buy and sell), and a buy straight from the USD balance. CANDIDATE: owner review.
//
// Why: the Solana fee path of release 19/20 is a separate lane (server Jupiter quote with platformFeeBps → solTerminalTrade).
// Measured 2026-11-10: 0 of the motion SOL trades reached it (pump.fun / PumpSwap / DLMM have no Jupiter quote, the quote lane
// answers a no-fee-path code, turbo / tip / priority / MEV refuse it) and the collector received nothing since 2026-11-09.
// This module puts the fee where every one of those trades already goes: the vault's own transaction. There is no router on
// Solana, so the fee is ONE SystemProgram transfer from the trader to the pinned collector in the SAME transaction as the
// swap — atomic: a swap that fails pays no fee, a fee that is not paid means the swap did not land either.
//
// Amounts (exact to the lamport; the same arithmetic as the TerminalRouter on RH/BNB and Jupiter's platform fee):
//   buy   fee = floor(amount × bps / 10 000), the swap gets amount − fee. The trader spends exactly the amount typed — never
//         more than the legacy trade, so the fee can never make a buy unaffordable that was affordable before.
//   sell  fee = floor(minOut × bps / 10 000) in lamports, minOut = the trade's own signed minimum. What the swap really pays is
//         ≥ minOut, so the fee is ≤ bps of the real proceeds: NEVER above the user's rate (it is up to the slippage share lower).
// Never blocks a trade: the fee instruction is added only when it cannot be the reason the transaction fails —
//   · the collector's account was read in the click's own read and is a plain, rent-exempt system account (a transfer of a
//     few lamports into a missing / under-rent account would fail the whole transaction);
//   · a sell's fee is paid from what the wallet already holds after fees and rent, keeping the wallet rent-exempt (proceeds
//     are not counted on);
//   · fee > 0 (a dust trade pays nothing).
// Otherwise the trade runs exactly as before, fee-free, and the vault reports it (addressless fee-fallback line, reason
// 'fee-leg-skip'). Rate: the standard 20 bps for every wallet. Holder discounts exist on Robinhood only (owner 2026-11-10);
// when a Solana discount is built, the rate must come from a verified entitlement (src/terminalFeeLeg.ts bpsFor), never
// above 20.
// Deployment-pinned: no request, page argument, setting or network answer can change the collector, the rate or the switch.
export const SOL_MARKET_FEE: Readonly<{ enabled: boolean; collector: string; bps: number; usdcCollectorAta: string }> = Object.freeze({
  enabled: true,
  // = engine TERMINAL_SOL_POLICY.feeRecipient = server sol.config.json pins.collector = signer roles.solReceipt.feeRecipient
  collector: '5ZtmhRo4q9DAtfV7Ccm7yEZWgcJmW33N43gWD5BRWMKx',
  bps: 20,
  // the collector's USDC associated token account (a buy from the USD balance pays its fee in USDC there). It does not exist on
  // 2026-11-10: until the owner creates it, those buys stay fee-free (checked on every click; nothing is ever created by the vault)
  usdcCollectorAta: 'GvvCAr4zjpTvjLNxFGz3w7DH1SSghmW7TU286SSs9qLs',
});
export const SOL_FEE_TIERS: readonly number[] = Object.freeze([20, 15, 10, 5, 0]);
/** the rent-exempt minimum of a 0-byte system account (getMinimumBalanceForRentExemption(0)) */
export const RENT_SYSTEM_MIN = 890_880n;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const okBps = (bps: number) => SOL_FEE_TIERS.includes(bps);
/** floor(basis × bps / 10 000); 0 for a non-positive basis */
export function solFeeOf(basis: bigint, bps: number): bigint {
  if (!okBps(bps)) throw new Error('bad Solana fee rate');
  return basis > 0n ? (basis * BigInt(bps)) / 10_000n : 0n;
}
/** a buy of `amount` lamports: what the collector gets and what the swap gets (fee + swapIn === amount) */
export function solBuySplit(amount: bigint, bps: number): { fee: bigint; swapIn: bigint } {
  const fee = solFeeOf(amount, bps);
  return { fee, swapIn: amount - fee };
}
/** a sell whose signed minimum is `minOut` lamports: the fee in lamports (≤ bps of anything the swap may really pay) */
export const solSellFee = (minOut: bigint, bps: number): bigint => solFeeOf(minOut, bps);

type AccLike = { owner: string; data: Uint8Array; lamports: number } | null | undefined;
/** the collector can take a lamport transfer of any size without failing the transaction: a system-owned, data-less,
 *  rent-exempt account (undefined = the read failed → no). */
export function collectorReady(acc: AccLike): boolean {
  return !!acc && acc.owner === SYSTEM_PROGRAM && acc.data.length === 0 && Number.isSafeInteger(acc.lamports) && BigInt(acc.lamports) >= RENT_SYSTEM_MIN;
}
/** the collector's USDC account can take an SPL transfer: initialized, mint USDC, owner = collector, not frozen, Token program */
export function usdcCollectorReady(acc: AccLike, collector: string = SOL_MARKET_FEE.collector): boolean {
  if (!acc || acc.owner !== TOKEN_PROGRAM || acc.data.length < 165) return false;
  const d = acc.data;
  const key = (o: number) => b58(d.subarray(o, o + 32));
  return key(0) === USDC_MINT && key(32) === collector && d[108] === 1;   // state 1 = initialized (2 = frozen)
}
/** a sell's fee is affordable from what the wallet holds BEFORE the proceeds: after the network fee, tip, priority, rent and
 *  the fee itself the wallet stays rent-exempt. `have` = the wallet's lamports now; `spend` = every other lamport outflow. */
export function sellFeeAffordable(have: bigint, spend: bigint, fee: bigint): boolean {
  return fee > 0n && have - spend - fee >= RENT_SYSTEM_MIN;
}

export type SolFeeDecision =
  | { on: true; fee: bigint; swapIn: bigint; collector: string; bps: number }
  | { on: false; reason: 'off' | 'collector' | 'dust' | 'funds' | 'size' | 'sim'; swapIn: bigint };   // 'sim' (engine-candidate-1110): failed only WITH the fee
/** The buy leg. `collector` = the collector's account as read in this click (undefined = not read). */
export function solBuyLeg(amount: bigint, collector: AccLike, cfg = SOL_MARKET_FEE): SolFeeDecision {
  if (!cfg.enabled) return { on: false, reason: 'off', swapIn: amount };
  if (!collectorReady(collector)) return { on: false, reason: 'collector', swapIn: amount };
  const { fee, swapIn } = solBuySplit(amount, cfg.bps);
  if (fee <= 0n || swapIn <= 0n) return { on: false, reason: 'dust', swapIn: amount };
  return { on: true, fee, swapIn, collector: cfg.collector, bps: cfg.bps };
}
/** The sell leg, decided once the trade's own minimum is known. */
export function solSellLeg(minOut: bigint, have: bigint, spend: bigint, collector: AccLike, cfg = SOL_MARKET_FEE): SolFeeDecision {
  if (!cfg.enabled) return { on: false, reason: 'off', swapIn: 0n };
  if (!collectorReady(collector)) return { on: false, reason: 'collector', swapIn: 0n };
  const fee = solSellFee(minOut, cfg.bps);
  if (fee <= 0n) return { on: false, reason: 'dust', swapIn: 0n };
  if (!sellFeeAffordable(have, spend, fee)) return { on: false, reason: 'funds', swapIn: 0n };
  return { on: true, fee, swapIn: 0n, collector: cfg.collector, bps: cfg.bps };
}
/** A buy from the USD balance (USDC from the wallet's reserve R): fee in USDC base units, the swap gets the rest. */
export function solUsdcLeg(usdcIn: bigint, collectorUsdc: AccLike, cfg = SOL_MARKET_FEE): SolFeeDecision {
  if (!cfg.enabled) return { on: false, reason: 'off', swapIn: usdcIn };
  if (!usdcCollectorReady(collectorUsdc, cfg.collector)) return { on: false, reason: 'collector', swapIn: usdcIn };
  const { fee, swapIn } = solBuySplit(usdcIn, cfg.bps);
  if (fee <= 0n || swapIn <= 0n) return { on: false, reason: 'dust', swapIn: usdcIn };
  return { on: true, fee, swapIn, collector: cfg.collector, bps: cfg.bps };
}

// the vault reports a trade that ran without the fee (no address, no amount): set by webEngine to its fee-fallback reporter
let skipHook: (side: 'buy' | 'sell', venue: string, reason: string) => void = () => {};
export function setSolFeeSkipHook(fn: typeof skipHook): void { skipHook = typeof fn === 'function' ? fn : () => {}; }
export function noteSolFeeSkip(side: 'buy' | 'sell', venue: string, d: SolFeeDecision): void {
  if (d.on || d.reason === 'off') return;
  try { skipHook(side, venue, d.reason); } catch { /* reporting never touches the trade */ }
}

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; }
