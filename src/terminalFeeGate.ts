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
/** covered(): true = the fee covers this market (refuse the legacy buy), false = fee-free market, a promise = the market has to be
 *  read first (the route the vault itself will trade). An uncovered or unreadable market runs `run` unchanged; a covered one is
 *  refused. With the switch off nothing is read and nothing is checked. */
export function gatedBuy<T>(chain: string, surface: 'trade' | 'float.buy', covered: () => boolean | Promise<boolean>, run: () => Promise<T>): Promise<T> {
  if (REQUIRED[chain] !== true || SURFACE_REQUIRED[surface] !== true) return run();
  let v: boolean | Promise<boolean>;
  try { v = covered(); } catch { v = false; }   // a market the vault cannot classify is the legacy trade's own problem (it refuses or trades as before)
  if (v === true) return Promise.reject(terminalPolicyRefusal(surface));
  if (v === false) return run();
  return Promise.resolve(v).catch(() => false).then((c) => (c === true ? Promise.reject(terminalPolicyRefusal(surface)) : run()));
}
/** Relay origin chain id -> engine lane key. Unknown origins map to a key no switch can enable. */
export function relayOriginLane(chainId: number, solChainId: number, chains: Readonly<Record<number, { key: string }>>): string {
  if (chainId === solChainId) return 'sol';
  return Object.prototype.hasOwnProperty.call(chains, chainId) ? chains[chainId].key : 'unknown';
}
