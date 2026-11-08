import type { TerminalPolicy } from './terminal-fee/vault-consumer.mjs';
// Deployment-pinned server public key/policy/treasury/cap. No runtime setter and no HTTP overrides.
// Null keeps this candidate non-executable until all integration/release gates pass.
export const TERMINAL_SOL_POLICY: TerminalPolicy | null = null;
