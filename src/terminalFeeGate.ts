// Deployment-pinned switch. No browser request, page argument, account tier or network response may modify it.
// Release 19 (fee enforcement, owner decision 7 "mandatory fee per chain"): REQUIRED is ON for robinhood, bsc and sol. The check
// sits at the engine dispatch boundary, outside the frozen trade-core region (no trade-core byte changes).
//   · a legacy BUY (engine.buy, engine.float.buy) on a market the terminal fee covers (src/terminalFeeCoverage.ts) is refused
//     before any click clock, busy flag, ledger or signing work starts: that buy has to go through terminalTrade/terminalTradeEvm;
//   · a buy on an UNCOVERED market (venue or coin outside the fee policy) runs exactly as before, fee-free;
//   · a SELL is never refused here (exits are never blocked): the app sends sells through the fee path when its quote works and
//     through the legacy sell otherwise (quote down, no fee path, a wallet the terminal lane cannot use);
//   · limit.place and relaySwap stay open (SURFACE_REQUIRED false: owner decision 15 — no keeper / Relay terminal fee yet).
// Turning REQUIRED off for a chain (or SURFACE_REQUIRED for a surface) is a new engine build (new hash / SRI / immutable URL).
const REQUIRED: Readonly<Record<string, boolean>> = Object.freeze({ robinhood: true, bsc: true, sol: true });
export type LegacySurface = 'trade' | 'float.buy' | 'limit.place' | 'relaySwap';
const SURFACE_REQUIRED: Readonly<Record<LegacySurface, boolean>> = Object.freeze({ trade: true, 'float.buy': true, 'limit.place': false, relaySwap: false });
const MESSAGES: Readonly<Record<LegacySurface, string>> = Object.freeze({
  trade: 'This market charges the 0.2% trading fee and this buy could not take the fee path (turbo or private send on, a Privy wallet, a 2FA step-up, or the fee service paused). Nothing was sent. Sells are not affected.',
  'float.buy': 'This market charges the 0.2% trading fee: a buy straight from the USD balance has no fee path yet. Buy with the coin balance instead. Sells are not affected.',
  'limit.place': 'New limit, take-profit and stop-loss orders require the policy-authorized execution path; this route is not enabled',
  relaySwap: 'Swaps require the policy-authorized execution path; this route is not enabled',
});
export const enforcedOn = (chain: string): boolean => REQUIRED[chain] === true;
// Release 20, owner decision 2026-11-09 ("trades must go through, but we must know who trades without the fee and keep fixing it"):
// the market-buy gate runs in OBSERVE mode on every chain. A buy on a covered market that reaches the legacy path is NOT refused:
// it runs at once, unchanged, and the market is classified AFTER the click has started (no request, await or check is added in
// front of the click); a covered market is then reported (onFallback: an addressless fee-fallback beacon). 'enforce' = release 19's
// refusal, kept for a later build. Deployment-pinned like REQUIRED.
export type GateMode = 'observe' | 'enforce';
export const GATE_MODE: GateMode = 'observe';
export function terminalPolicyRefusal(surface: LegacySurface): Error {
  return Object.assign(new Error(MESSAGES[surface] || MESSAGES.trade), { code: 'TerminalPolicyRequired', name: 'TerminalPolicyRequired' });
}
/** Chain-wide check for the surfaces with no market (limit.place, relaySwap): refused only when both switches are on. */
export function assertLegacyTerminalAllowed(chain: string, surface: LegacySurface): void {
  if (REQUIRED[chain] !== true || SURFACE_REQUIRED[surface] !== true) return;
  throw terminalPolicyRefusal(surface);
}
/** Refusal is a rejected promise before any click clock, busy flag, ledger or signing work starts. */
export function gatedCall<T>(chain: string, surface: LegacySurface, run: () => Promise<T>): Promise<T> {
  try { assertLegacyTerminalAllowed(chain, surface); } catch (e) { return Promise.reject(e); }
  return run();
}
/** covered(): a truthy value = the fee covers this market (release 20: the venue label, e.g. 'table', 'v4-launcher', 'pump'),
 *  false / null = fee-free market, a promise = the market has to be read first (the route the vault itself will trade).
 *  OBSERVE (this build): `run` starts at once; covered() is asked after, and a covered market calls onFallback(venue) — never
 *  awaited by the click, never able to fail it. ENFORCE: a covered market is refused before `run` (release 19).
 *  With the switch off nothing is read and nothing is checked. */
export function gatedBuy<T>(chain: string, surface: 'trade' | 'float.buy', covered: () => unknown, run: () => Promise<T>,
  onFallback: (venue: string) => void = () => {}, mode: GateMode = GATE_MODE): Promise<T> {
  if (REQUIRED[chain] !== true || SURFACE_REQUIRED[surface] !== true) return run();
  const label = (c: unknown): string | null => (c === true ? 'covered' : typeof c === 'string' && c ? c : null);
  if (mode === 'observe') {
    const out = run();
    try {
      void Promise.resolve().then(covered).then((c) => { const v = label(c); if (v) onFallback(v); }).catch(() => {});
    } catch { /* classification must never touch the trade */ }
    return out;
  }
  let v: unknown;
  try { v = covered(); } catch { v = false; }   // a market the vault cannot classify is the legacy trade's own problem (it refuses or trades as before)
  if (v !== null && typeof v === 'object' && typeof (v as Promise<unknown>).then === 'function')
    return Promise.resolve(v).catch(() => false).then((c) => (label(c) ? Promise.reject(terminalPolicyRefusal(surface)) : run()));
  if (label(v)) return Promise.reject(terminalPolicyRefusal(surface));
  return run();
}
/** The addressless fee-fallback line (same channel and shape as the app's feeFallbackBeacon.ts, scope 'fee-fallback'):
 *  chain, side, venue class, reason code, size bucket — no wallet, no token, no exact amount, no page path. Pure. */
export type FallbackReason = 'turbo' | 'private-send' | 'privy-wallet' | 'hop-wallet' | '2fa' | 'usd-balance' | 'sol-tip' | 'no-fee-path'
  // fee-cov-1110: a Solana trade without its in-transaction fee (src/solMarketFee.ts SolFeeDecision reasons)
  | 'fee-leg-collector' | 'fee-leg-dust' | 'fee-leg-funds' | 'fee-leg-size' | 'fee-leg-sim';
export const FALLBACK_SCOPE = 'fee-fallback';
/** native units (ETH / BNB / SOL) by default; 'usd' for a buy from the USD balance */
export function sizeBucket(x: unknown, unit: 'native' | 'usd' = 'native'): string {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return 'na';
  if (unit === 'usd') return n < 10 ? 'usd<10' : n < 100 ? 'usd10-100' : n < 1000 ? 'usd100-1000' : 'usd>=1000';
  return n < 0.01 ? '<0.01' : n < 0.1 ? '0.01-0.1' : n < 1 ? '0.1-1' : n < 10 ? '1-10' : '>=10';
}
export function fallbackBody(chain: string, venue: string, reason: FallbackReason, bucket: string, build: string): string {
  const w = (x: string) => String(x).replace(/[^A-Za-z0-9<>=.+-]/g, '').slice(0, 24);
  return JSON.stringify({ scope: FALLBACK_SCOPE, summary: `engine ${w(chain)} buy ${w(venue)} ${w(reason)} ${w(bucket)}`.slice(0, 120), stack: '', componentStack: '', path: '', build: w(build) });
}
/** One line per chain · venue · reason · bucket per engine load, at most `max` lines; fire-and-forget, never throws. */
export function createFallbackReporter({ post, max = 12, build = 'engine-r20' }: { post: (body: string) => void; max?: number; build?: string }) {
  const seen = new Set<string>();
  return (chain: string, venue: string, reason: FallbackReason, bucket: string): boolean => {
    try {
      const key = `${chain}|${venue}|${reason}|${bucket}`;
      if (seen.has(key) || seen.size >= max) return false;
      seen.add(key);
      post(fallbackBody(chain, venue, reason, bucket, build));
      return true;
    } catch { return false; }
  };
}
/** Relay origin chain id -> engine lane key. Unknown origins map to a key no switch can enable. */
export function relayOriginLane(chainId: number, solChainId: number, chains: Readonly<Record<number, { key: string }>>): string {
  if (chainId === solChainId) return 'sol';
  return Object.prototype.hasOwnProperty.call(chains, chainId) ? chains[chainId].key : 'unknown';
}
