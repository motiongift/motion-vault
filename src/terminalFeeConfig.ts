import type { TerminalPolicy } from './terminal-fee/vault-consumer.mjs';
// Deployment-pinned server public key/policy/treasury/cap. No runtime setter and no HTTP overrides.
// Null keeps this candidate non-executable until all integration/release gates pass.
export const TERMINAL_SOL_POLICY: TerminalPolicy | null = Object.freeze({
  signerPublicKey: '610e2cc7ccb39a383a9724c7990539d4ed06ab6b5f2a482f4be1b62ecbb9a350',
  policyId: 'a6d3d9627846882aa4e2ef467be35db7f1cac33083f1bbe7eced4a6a016ecee7',
  feeRecipient: '5ZtmhRo4q9DAtfV7Ccm7yEZWgcJmW33N43gWD5BRWMKx',
  maxNative: '300000000000',
});
