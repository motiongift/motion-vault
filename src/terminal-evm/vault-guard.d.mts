export type Hex = `0x${string}`;
export interface TerminalEvmConfig {
  chainId: 56 | 4663; router: Hex; owner: Hex; signer: Hex; feeRecipient: Hex;
  wrappedNative: Hex; permit2: Hex; policyId: Hex; runtimeCodeHash: Hex;
  maxNativeAmount: string; marketKeys: readonly string[];
  finalityBlocks: number; maxGas: string; maxGasPrice: string; maxGasCost: string;
}
export interface TerminalEvmIntent { trader: Hex; token: Hex; side: 'buy' | 'sell'; amount: string; slippageBps: number }
export interface TerminalEvmTx { to: Hex; data: Hex; value: bigint }
export interface VerifiedTerminalEvm {
  quote: { trader: Hex; deadline: number; nonce: bigint; minOut: bigint };
  digest: Hex; transaction: TerminalEvmTx; claim: { id: string; trader: string; nonce: string; reservation: string | null };
  approval: { token: Hex; spender: Hex; amount: bigint } | null; intent: TerminalEvmIntent;
}
export const TOKEN_READ_ABI: readonly any[];
export function terminalMarketKey(token: string, route: unknown): string;
export function verifyTerminalEvm(args: { config: TerminalEvmConfig; client: any; transaction: unknown; route: unknown; intent: TerminalEvmIntent; now?: number }): Promise<VerifiedTerminalEvm>;
export function exactTerminalApproval(verified: VerifiedTerminalEvm, amount: bigint): TerminalEvmTx;
export function simulateTerminalEvm(args: { client: any; verified: VerifiedTerminalEvm; config: TerminalEvmConfig; now?: number }): Promise<bigint>;
