export interface PinnedFeePolicy {
  signerPublicKey: string; policyId: string; baseBps: 20; maxSkewMs: number;
  collectors: Partial<Record<'robinhood' | 'bsc' | 'sol', string | null>>;
}
export interface FeeDecision {
  rateBps: number; failClosed: boolean; reason: string; nonce: string | null; basis: string;
  expiresAtMs: number | null; issuedAtMs: number | null;
}
export interface SeenNonces { has(nonce: string): boolean; add(nonce: string, expiresAtMs: number, now?: number): void }
export const FEE_POLICY_PURPOSE: string;
export const TERMINAL_BASE_BPS: 20;
export const API_FEE_BPS: 10;
export function canonicalFeePolicy(raw: unknown): Readonly<Record<string, unknown>>;
export function feePolicyBytes(payload: unknown): Uint8Array;
export function validatePinnedFeePolicy(pinned: unknown): PinnedFeePolicy;
export function createSeenNonces(limit?: number): SeenNonces;
export interface Ed25519Verifier { verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, opts?: { zip215?: boolean }): boolean }
export function terminalFeeDecision(envelope: unknown, ctx: {
  ed25519: Ed25519Verifier;
  pinned: PinnedFeePolicy; chain: 'robinhood' | 'bsc' | 'sol'; trader: string; side: 'buy' | 'sell'; token: string; amount: string;
  seen?: SeenNonces | null; now?: number;
}): FeeDecision;
export function assertQuoteMatchesDecision(decision: FeeDecision, q: {
  pinned: PinnedFeePolicy; quoteBps: unknown; reservation: unknown; quoteIssuedAtMs: number;
}): true;
