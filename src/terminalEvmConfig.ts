import type { TerminalEvmConfig } from './terminal-evm/vault-guard.mjs';
// Reviewed deployment/runtime + finite market registry, never supplied by the app.
// Null means unsupported: this candidate must not be advertised as ready or silently fall back.
export const TERMINAL_EVM_POLICY: Readonly<Partial<Record<'robinhood' | 'bsc', TerminalEvmConfig>>> | null = null;
