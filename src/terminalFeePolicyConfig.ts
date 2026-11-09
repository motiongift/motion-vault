import type { PinnedFeePolicy } from './terminal-fee/fee-policy.mjs';
// Deployment-pinned fee-policy verifier (economics server Ed25519 key, policyId, per-chain collectors).
// Separate from the quote signer. No runtime setter, no HTTP/app override. Null = OFF: the terminal lanes behave
// exactly as without this file (the request field `feePolicy` is not even accepted).
export const TERMINAL_FEE_POLICY: PinnedFeePolicy | null = null;
