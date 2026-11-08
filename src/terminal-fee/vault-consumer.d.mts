export interface TerminalIntent { trader: string; token: string; side: 'buy' | 'sell'; amount: string; slippageBps: number }
export interface TerminalPolicy { signerPublicKey: string; policyId: string; feeRecipient: string; maxNative: string }
export interface TerminalPayload extends TerminalIntent { minOut: string; receiptId: string; feeBps: 0 | 5 | 10 | 15 | 20 }
export interface TerminalInput { envelope: unknown; serialized: string; intent: TerminalIntent }
export interface TerminalStore {
  claim(row: Record<string, unknown>): Promise<boolean>;
  update(receiptId: string, patch: Record<string, unknown>): Promise<void>;
}
export function createTerminalVaultConsumer(deps: {
  config: TerminalPolicy & { trader: string };
  rpc(method: string, params: unknown[]): Promise<unknown>;
  store: TerminalStore;
  signExact(message: Uint8Array, metadata: { trader: string; receiptId: string }): Promise<Uint8Array>;
  sendExact(transaction: Uint8Array, metadata: { signature: string; trader: string; lastValidBlockHeight: number; receiptId: string }): Promise<{ signature: string }>;
  verifyMarket(value: { intent: TerminalIntent; payload: TerminalPayload; checked: Readonly<Record<string, unknown>> }): Promise<boolean>;
  now?: () => number;
}): { consume(input: TerminalInput): Promise<{ status: 'submitted'; signature: string; receiptId: string }> };
