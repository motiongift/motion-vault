export type Hex = `0x${string}`;
export interface TerminalEvmConfig {
  chainId: 56 | 4663; router: Hex; owner: Hex; signer: Hex; feeRecipient: Hex;
  wrappedNative: Hex; permit2: Hex; policyId: Hex; runtimeCodeHash: Hex;
  maxNativeAmount: string; marketKeys: readonly string[];
  /** Absent = original scope (bsc: v2, robinhood: v4). 'standard-pool' is Robinhood only. */
  venues?: readonly ('v2' | 'v4' | 'standard-pool')[];
  /** true = Standard graduated pools validated against the pinned on-chain registry need no per-coin market key. */
  standardPoolRegistry?: boolean;
  /** Release 20: venue classes (venue-registry.mjs REGISTRY_CLASSES) covered without a per-coin market key. Absent = none. */
  registry?: readonly string[];
  finalityBlocks: number; maxGas: string; maxGasPrice: string; maxGasCost: string;
  /** PONS-V2 (default OFF): Robinhood Pons V2 native-pair curves. Absent or enabled !== true = refused. */
  ponsV2?: { enabled: boolean; factory: Hex; factoryCodeHash: Hex };
}
export interface TerminalEvmIntent { trader: Hex; token: Hex; side: 'buy' | 'sell'; amount: string; slippageBps: number }
export interface TerminalEvmTx { to: Hex; data: Hex; value: bigint }
export interface VerifiedTerminalEvm {
  quote: { trader: Hex; deadline: number; nonce: bigint; minOut: bigint; motionFeeBps: number; issuedAt: number; entitlementId: Hex };
  digest: Hex; transaction: TerminalEvmTx; claim: { id: string; trader: string; nonce: string; reservation: string | null };
  approval: { token: Hex; spender: Hex; amount: bigint } | null; intent: TerminalEvmIntent;
}
export const TOKEN_READ_ABI: readonly any[];
export function terminalMarketKey(token: string, route: unknown): string;
export const SUPPORTED_VENUES: Readonly<{ bsc: readonly string[]; robinhood: readonly string[] }>;
export function terminalVenue(route: unknown): string | undefined;
export const PONS_CURVE_ABI: readonly any[];
export function ponsV2Enabled(config: TerminalEvmConfig | null | undefined, chain: string): boolean;
export function ponsV2CallsProblem(args: { calls: readonly any[]; tokens: readonly string[]; route: any; token: string; side: 'buy' | 'sell'; amount: bigint; executor: string; wrapped: string }): string | null;
export function verifyTerminalEvm(args: { config: TerminalEvmConfig; client: any; transaction: unknown; route: unknown; intent: TerminalEvmIntent; now?: number; bnbVenues?: readonly string[] }): Promise<VerifiedTerminalEvm>;
export function exactTerminalApproval(verified: VerifiedTerminalEvm, amount: bigint): TerminalEvmTx;
export function simulateTerminalEvm(args: { client: any; verified: VerifiedTerminalEvm; config: TerminalEvmConfig; now?: number }): Promise<bigint>;
