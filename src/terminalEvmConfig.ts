import type { TerminalEvmConfig } from './terminal-evm/vault-guard.mjs';
// Reviewed deployment/runtime + finite market registry, never supplied by the app.
// Null means unsupported: this candidate must not be advertised as ready or silently fall back.
// BNB venues beyond Pancake V2 for the terminal-fee lane. Empty = OFF (original candidate: BNB V2 only).
// Allowed values: 'v3' (Pancake V3 SmartRouter), 'inf' (Pancake Infinity CL, hookless pools only), 'four' (four.meme TokenManager2), 'flap' (Flap Portal).
// Deployment-pinned; never set from a request, account or network response. Each market must still be in policy.marketKeys.
export const TERMINAL_EVM_BNB_VENUES: readonly ('v3' | 'inf' | 'four' | 'flap')[] = Object.freeze([]);
export const TERMINAL_EVM_POLICY: Readonly<Partial<Record<'robinhood' | 'bsc', TerminalEvmConfig>>> | null = null;
// PONS-V2 (default OFF): Robinhood Pons V2 native-pair curves through TerminalRouter. Even a reviewed policy with
// ponsV2.enabled cannot route Pons unless this reviewed constant is also true in the published engine build.
export const TERMINAL_EVM_PONS_V2: boolean = false;
