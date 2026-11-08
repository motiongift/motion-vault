import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { SOL, publicKey, associatedTokenAddress } from './portable-wire.mjs';
import { parseUnsignedV0 } from './message-v0.mjs';

const PURPOSE = 'motion-terminal-solana-v1';
const FIELDS = ['version', 'purpose', 'genesis', 'policyId', 'trader', 'recipient', 'token', 'side', 'amount',
  'quotedOut', 'minOut', 'slippageBps', 'feeBps', 'feeRecipient', 'feeAccount', 'feeAmount', 'maxNative',
  'recentBlockhash', 'lastValidBlockHeight', 'issuedAt', 'expiresAt', 'receiptId', 'reservationId', 'messageSha256'];
const hash = bytes => bytesToHex(sha256(bytes));
const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const uint = (v, positive = false) => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v)) throw Error('Invalid receipt integer');
  const n = BigInt(v); if (n >= 1n << 64n || (positive && n === 0n)) throw Error('Invalid receipt integer'); return n;
};
export const messageHash = hash;

export function canonicalReceipt(raw) {
  if (!raw || Object.keys(raw).length !== FIELDS.length || Object.keys(raw).some(k => !FIELDS.includes(k))) throw Error('Unexpected receipt field');
  const p = Object.fromEntries(FIELDS.map(k => [k, raw[k]]));
  if (p.version !== 1 || p.purpose !== PURPOSE || p.genesis !== SOL.genesis || !hex(p.policyId, 64) ||
    !hex(p.receiptId, 64) || /^0+$/.test(p.receiptId) || !hex(p.messageSha256, 64)) throw Error('Invalid receipt identity');
  for (const k of ['trader', 'recipient', 'token', 'feeRecipient', 'feeAccount', 'recentBlockhash']) publicKey(p[k]);
  if (p.recipient !== p.trader || p.feeRecipient === p.trader || p.token === SOL.wsol || p.token === SOL.system ||
    p.feeAccount !== associatedTokenAddress(p.feeRecipient, SOL.wsol) || !['buy', 'sell'].includes(p.side)) throw Error('Unsupported receipt account or pair');
  if (![0, 5, 10, 15, 20].includes(p.feeBps) || !Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > 3000) throw Error('Invalid receipt fee/slippage');
  if (p.feeBps < 20 ? (!hex(p.reservationId, 64) || /^0+$/.test(p.reservationId)) : p.reservationId !== null) throw Error('Invalid reservation');
  for (const k of ['amount', 'quotedOut', 'minOut', 'maxNative', 'lastValidBlockHeight']) uint(p[k], true);
  uint(p.feeAmount);
  if (p.feeBps === 0 && p.feeAmount !== '0') throw Error('Zero fee receipt claims a fee');
  if (uint(p.minOut) !== uint(p.quotedOut) * BigInt(10000 - p.slippageBps) / 10000n) throw Error('Receipt net minimum mismatch');
  if (p.side === 'buy' && (uint(p.amount) > uint(p.maxNative) || uint(p.feeAmount) !== uint(p.amount) * BigInt(p.feeBps) / 10000n)) throw Error('Receipt input fee/cap mismatch');
  const issued = uint(p.issuedAt), expires = uint(p.expiresAt);
  if (expires <= issued || expires - issued > 30000n || expires > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Receipt TTL outside bound');
  return Object.freeze(p);
}
export const receiptBytes = payload => new TextEncoder().encode(`${PURPOSE}\n${JSON.stringify(canonicalReceipt(payload))}`);

export function verifyPolicyReceipt(envelope, { signerPublicKey, policyId, feeRecipient, maxNative, trader, now = Date.now() }) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'payload,signature' || !hex(signerPublicKey, 64) || !hex(envelope.signature, 128)) throw Error('Invalid receipt signature envelope');
  const p = canonicalReceipt(envelope.payload), bytes = receiptBytes(p);
  if (!ed25519.verify(hexToBytes(envelope.signature), bytes, hexToBytes(signerPublicKey), { zip215: false })) throw Error('Receipt signature rejected');
  if (p.policyId !== policyId || p.feeRecipient !== feeRecipient || p.maxNative !== String(maxNative) || p.trader !== trader) throw Error('Receipt differs from pinned wallet policy');
  if (!Number.isSafeInteger(now) || BigInt(now) < BigInt(p.issuedAt) || BigInt(now) >= BigInt(p.expiresAt)) throw Error('Receipt expired or future dated');
  return { payload: p, receiptHash: hash(bytes) };
}

/** Trusted server boundary: quote is the adapter's completed verified result, never HTTP input.
 * sign(bytes) and claim(receiptId, hash, reservation) are injected dedicated server services.
 * No private key is read or stored here. */
export function createPolicyReceiptIssuer({ signerPublicKey, sign, claim, policyId, feeRecipient, maxNative, now = () => Date.now() }) {
  if (!hex(signerPublicKey, 64) || !hex(policyId, 64) || typeof sign !== 'function' || typeof claim !== 'function') throw Error('Dedicated receipt signer and durable claim required');
  publicKey(feeRecipient); uint(String(maxNative), true);
  return Object.freeze({ async issue(quote, receiptId) {
    if (quote?.simulation?.ok !== true || quote?.venue !== 'jupiter' || quote?.chain !== 'sol' || quote.fees?.atomic !== true ||
      quote.fees.recipient !== feeRecipient || quote.fees.motionFeeBps !== quote.motionFeeBps) throw Error('Verified terminal adapter result required');
    const parsed = parseUnsignedV0(quote.transaction.serialized), issued = now();
    const reservation = quote.authorization.reservationId;
    const payload = canonicalReceipt({ version: 1, purpose: PURPOSE, genesis: SOL.genesis, policyId,
      trader: quote.trader, recipient: quote.recipient, token: quote.address, side: quote.side,
      amount: quote.amount, quotedOut: quote.amountOut, minOut: quote.minOut, slippageBps: quote.slippageBps,
      feeBps: quote.motionFeeBps, feeRecipient, feeAccount: quote.fees.feeAccount, feeAmount: quote.fees.simulatedAmount,
      maxNative: String(maxNative), recentBlockhash: parsed.blockhash, lastValidBlockHeight: String(quote.transaction.lastValidBlockHeight),
      issuedAt: String(issued), expiresAt: String(Math.min(quote.expiresAt, issued + 30000)), receiptId,
      reservationId: reservation == null ? null : reservation.replace(/^0x/, '').toLowerCase(), messageSha256: hash(parsed.message) });
    if (parsed.trader !== payload.trader || quote.authorization.messageSha256 !== payload.messageSha256) throw Error('Verified message changed');
    const bytes = receiptBytes(payload), receiptHash = hash(bytes);
    if (await claim({ receiptId, receiptHash, reservationId: payload.reservationId, messageSha256: payload.messageSha256, expiresAt: payload.expiresAt }) !== true) throw Error('Receipt authorization conflict');
    const signature = await sign(bytes.slice());
    const envelope = Object.freeze({ payload, signature: bytesToHex(signature) });
    verifyPolicyReceipt(envelope, { signerPublicKey, policyId, feeRecipient, maxNative, trader: payload.trader, now: now() });
    return envelope;
  } });
}
