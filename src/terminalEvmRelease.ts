// fee-sprint3 (review F2) — OPTION, OFF in every reviewed build. Compile-time only: never set from a request, account,
// storage or network response. Changing it is a new engine build (new hash / SRI / immutable URL).
//
// null (default): the terminal EVM journal releases a wallet only when the exact persisted transaction is in a block at or
//   below the chain's L1 'finalized' tag (on Robinhood Chain about 19 minutes after inclusion), so on Robinhood one terminal
//   trade per wallet per ~19 min, and approve-then-sell trades end as "Approval outcome unknown".
// { confirmations: N } (Robinhood 4663 only): release on the canonical L2 receipt plus max(N, policy.finalityBlocks)
//   confirmations (sequencer soft finality). The quote nonce / reservation keys stay consumed forever either way; the
//   journal history marks such releases soft (block number + hash) for a later reorg audit. Risk comparison for the owner:
//   B:/tmp/fee-sprint3/engine/F2-release-options.txt
export const TERMINAL_EVM_RH_L2_RELEASE: Readonly<{ confirmations: number }> | null = null;
