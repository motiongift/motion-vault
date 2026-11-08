// Deployment-pinned switch. No browser request, account tier or network response may modify it.
// Keep off until the new execution capability is proven on every enabled terminal entrypoint.
const REQUIRED: Readonly<Record<string, boolean>> = Object.freeze({ robinhood: false, bsc: false, sol: false });
export function assertLegacyTerminalAllowed(chain: string, surface: 'trade' | 'float.buy'): void {
  if (REQUIRED[chain] !== true) return;
  throw Object.assign(new Error(surface === 'float.buy'
    ? 'USD reserve trades require the policy-authorized execution path; this route is not enabled'
    : 'This terminal requires a policy-authorized quote; the legacy trade path is disabled'),
  { code: 'TerminalPolicyRequired', name: 'TerminalPolicyRequired' });
}
