import type { TerminalStore } from './vault-consumer.mjs';
export interface StoredTerminalReceipt { receiptId: string; trader: string; signature?: string | null; lastValidBlockHeight: string; status: string }
export function openTerminalReceiptStore(deps: {
  indexedDB?: IDBFactory;
  name?: string;
  verifySettlement(row: Readonly<StoredTerminalReceipt>): Promise<{ genesis: string; status: string; finalized?: boolean; signature?: string; blockHeight?: number }>;
}): Promise<TerminalStore & {
  close(): void;
  get(receiptId: string): Promise<StoredTerminalReceipt | undefined>;
  pending(trader: string): Promise<StoredTerminalReceipt | null>;
  reconcile(receiptId: string): Promise<string>;
}>;
