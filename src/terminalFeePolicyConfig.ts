import type { PinnedFeePolicy } from './terminal-fee/fee-policy.mjs';
// Deployment-pinned fee-policy verifier (economics server Ed25519 key, policyId, per-chain collectors).
// Separate from the quote signer. No runtime setter, no HTTP/app override. Null = OFF: the terminal lanes behave
// exactly as without this file (the request field `feePolicy` is not even accepted).
export const TERMINAL_FEE_POLICY: PinnedFeePolicy | null = Object.freeze({
  signerPublicKey: 'ac89c7f76bdf2b9df1631489551384fe689dbcb49e1e7895dc5a0da60c260553',
  policyId: '9842c8718fa51808a183748b869f7f07b3ddcec5dd17633d2c7dc04f619f01f5',
  baseBps: 20 as const,
  maxSkewMs: 5000,
  collectors: Object.freeze({ robinhood: '0x74f25914dcce21555188b523748d3b3f557ed297', bsc: '0x74f25914dcce21555188b523748d3b3f557ed297', sol: '5ZtmhRo4q9DAtfV7Ccm7yEZWgcJmW33N43gWD5BRWMKx' }),
});
