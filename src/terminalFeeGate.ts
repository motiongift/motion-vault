// Deployment-pinned switch. No browser request, account tier or network response may modify it.
// Keep off until the new execution capability is proven on every enabled terminal entrypoint.
// PREP-1108 candidate (NOT shipped): the check sits at the engine dispatch boundary, outside the frozen trade-core
// region, and also reaches limit.place and relaySwap. Every switch stays false.
const REQUIRED: Readonly<Record<string, boolean>> = Object.freeze({ robinhood: false, bsc: false, sol: false });
export type LegacySurface = 'trade' | 'float.buy' | 'limit.place' | 'relaySwap';
const MESSAGES: Readonly<Record<LegacySurface, string>> = Object.freeze({
  trade: 'This terminal requires a policy-authorized quote; the legacy trade path is disabled',
  'float.buy': 'USD reserve trades require the policy-authorized execution path; this route is not enabled',
  'limit.place': 'New limit, take-profit and stop-loss orders require the policy-authorized execution path; this route is not enabled',
  relaySwap: 'Swaps require the policy-authorized execution path; this route is not enabled',
});
export function assertLegacyTerminalAllowed(chain: string, surface: LegacySurface): void {
  if (REQUIRED[chain] !== true) return;
  throw Object.assign(new Error(MESSAGES[surface] || MESSAGES.trade), { code: 'TerminalPolicyRequired', name: 'TerminalPolicyRequired' });
}
/** Refusal is a rejected promise before any click clock, busy flag, ledger or signing work starts. */
export function gatedCall<T>(chain: string, surface: LegacySurface, run: () => Promise<T>): Promise<T> {
  try { assertLegacyTerminalAllowed(chain, surface); } catch (e) { return Promise.reject(e); }
  return run();
}
/** Relay origin chain id -> engine lane key. Unknown origins map to a key no switch can enable. */
export function relayOriginLane(chainId: number, solChainId: number, chains: Readonly<Record<number, { key: string }>>): string {
  if (chainId === solChainId) return 'sol';
  return Object.prototype.hasOwnProperty.call(chains, chainId) ? chains[chainId].key : 'unknown';
}
