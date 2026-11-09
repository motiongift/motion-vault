export interface EvmClaim { id: string; trader: string; nonce: string; reservation: string | null; status?: string; hash?: string | null; phase?: string | null; txNonce?: string | null; dropSeenAt?: number | null }
export interface EvmClaims {
  close(): void; get(id: string): Promise<EvmClaim | undefined>; pending(trader: string): Promise<EvmClaim | null>;
  claim(row: EvmClaim): Promise<boolean>; signed(id: string, hash: string, phase: 'approve-zero' | 'approve-exact' | 'swap', txNonce?: number): Promise<void>;
  reconcile(id: string): Promise<string | undefined>; cancelIdle(id: string): Promise<void>;
}
export function openEvmClaims(args: { indexedDB?: IDBFactory; name: string;
  verifyFinal(row: Readonly<EvmClaim>): Promise<{ final: boolean; hash?: string; success?: boolean; soft?: true; blockNumber?: string; blockHash?: string }>;
  verifyDropped?: ((row: Readonly<EvmClaim>) => Promise<{ dropped: boolean; hash?: string; accountNonce?: string; atBlock?: string }>) | null;
  now?: () => number; dropConfirmMs?: number }): Promise<EvmClaims>;
