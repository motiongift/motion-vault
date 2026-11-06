// Elysium → HyperEVM, the way back (2026-11-04; owner «самое страшное — чтобы деньги нигде не застряли, а если застряли — чтобы
// могли вернуть»). PURE rules shared byte for byte by the vault (motion-vault src/elysiumExitCore.ts) and the server
// (server/elysium-exits.mjs, server/motion-bridge.mjs). No key, no clock, no network here.
//
//   1. Start (on Elysium, signed by the user's own wallet in the vault): HYPE = ArbSys(0x…64).withdrawEth(W) with value = the
//      amount; USDC = L2GatewayRouter.outboundTransfer(Circle USDC on HyperEVM, W, amount, 0, 0, "") — the canonical USDC burns
//      on Elysium. In both the destination is the SIGNER's own address (exitProblem refuses anything else).
//   2. Wait: the withdrawal is claimable once a rollup assertion that covers it is confirmed on HyperEVM — about 6 days (the
//      challenge period, Kinetiq's docs; 155 real exits were paid 5.96–6.56 days after they were sent).
//   3. Claim (on HyperEVM): Outbox.executeTransaction(proof, …) — anyone may send it, and it can only pay the `to` committed in the
//      L2→L1 message (W for HYPE, the gateway → W for USDC). motion's solver sends it and pays the gas, so the user needs no HYPE on
//      HyperEVM; the user may also send it from their own wallet.
// Plus the retryable-ticket id (to watch motion's own Elysium deliveries until they are redeemed: ticketId below).
import { keccak_256 } from '@noble/hashes/sha3';

export const ELY_EXIT = {
  chainId: 99901, parentChainId: 999,
  arbSys: '0x0000000000000000000000000000000000000064',
  nodeInterface: '0x00000000000000000000000000000000000000c8',
  arbRetryableTx: '0x000000000000000000000000000000000000006e',
  l2Router: '0x61ebbc3a29f1970af2ce862ba9c5364832e14d17',
  l2Gateway: '0x5dc84e4cb0f9082246e92a5585c5395592b1af1f',
  l1Gateway: '0xd97b30de0ba0c2eaee942afce77530e06c5f122c',
  l1Usdc: '0xb88339cb7199b77e23db6e890353e22632ba630f',
  l2Usdc: '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65',
  outbox: '0xec6b106dfa14428fe5eec2a4065a7be599f02728',
  rollup: '0x508c173dfe5f737b3493195bf785d71fa76fd217',
} as const;
/** what the card may say: claimable after about this many days (Kinetiq's docs) */
export const EXIT_DAYS = 6;
/** when to show "ready around …": the L2 time + the longest send→claim seen on the real chain (6.56 d) */
export const EXIT_READY_MS = Math.round(6.6 * 86_400_000);

export const SEL = {
  withdrawEth: '0x25e16063',            // withdrawEth(address)
  outboundTransfer: '0xd2ce7d65',       // outboundTransfer(address,address,uint256,uint256,uint256,bytes)
  executeTransaction: '0x08635a95',     // executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)
  finalizeInboundTransfer: '0x2e567b36', // finalizeInboundTransfer(address,address,address,uint256,bytes)
  redeem: '0xeda1122c',                 // ArbRetryableTx.redeem(bytes32)
  getTimeout: '0x9f1025c6',             // ArbRetryableTx.getTimeout(bytes32)
  constructOutboxProof: '0x42696350',   // NodeInterface.constructOutboxProof(uint64,uint64)
  isSpent: '0x5a129efe',                // Outbox.isSpent(uint256)
} as const;
export const TOPIC = {
  l2ToL1Tx: '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc',
  withdrawalInitiated: '0x3073a74ecb728d10be779fe19a74a1428e20468f5b4d167bf9c73d9067847d73',
  assertionConfirmed: '0xfc42829b29c259a7370ab56c8f69fce23b5f351a9ce151da453281993ec0090c',
  messageDelivered: '0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1',
  inboxMessageDelivered: '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b',
} as const;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const w32 = (v: bigint) => v.toString(16).padStart(64, '0');
const a32 = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export type ExitAsset = 'HYPE' | 'USDC';
export type ExitTx = { to: string; value: bigint; data: string };

/** the one transaction that starts a way back, to the signer's OWN address on HyperEVM */
export function exitCall(asset: ExitAsset, to: string, amount: bigint): ExitTx {
  if (!ADDR.test(to) || !(amount > 0n)) throw new Error('Elysium exit: bad recipient or amount');
  if (asset === 'HYPE') return { to: ELY_EXIT.arbSys, value: amount, data: SEL.withdrawEth + a32(to) };
  if (asset === 'USDC') return { to: ELY_EXIT.l2Router, value: 0n, data: SEL.outboundTransfer + a32(ELY_EXIT.l1Usdc) + a32(to) + w32(amount) + w32(0n) + w32(0n) + w32(0xc0n) + w32(0n) };
  throw new Error('Elysium exit: unknown asset');
}
/** '' = the bytes are exactly a way back of the signer's own funds to the signer's own address (anything else is refused) */
export function exitProblem(tx: { to?: string | null; value?: bigint; data?: string; chainId?: number }, signer: string): string {
  if (tx.chainId !== undefined && Number(tx.chainId) !== ELY_EXIT.chainId) return 'not an Elysium transaction';
  if (!ADDR.test(String(signer))) return 'no signer';
  const d = String(tx.data || '').toLowerCase(), to = String(tx.to || '').toLowerCase(), me = String(signer).toLowerCase();
  const word = (i: number) => d.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i: number) => (word(i).slice(0, 24) === '0'.repeat(24) ? '0x' + word(i).slice(24) : '');
  if (to === ELY_EXIT.arbSys) {
    if (!d.startsWith(SEL.withdrawEth) || d.length !== 10 + 64) return 'not a plain withdrawEth';
    if (addr(0) !== me) return 'the way back pays someone else';
    if (!((tx.value ?? 0n) > 0n)) return 'nothing to move';
    return '';
  }
  if (to === ELY_EXIT.l2Router) {
    if (!d.startsWith(SEL.outboundTransfer) || d.length !== 10 + 64 * 7) return 'not a plain outboundTransfer';
    if (addr(0) !== ELY_EXIT.l1Usdc) return 'another token';
    if (addr(1) !== me) return 'the way back pays someone else';
    if (!(BigInt('0x' + word(2)) > 0n)) return 'nothing to move';
    if (BigInt('0x' + word(3)) !== 0n || BigInt('0x' + word(4)) !== 0n || BigInt('0x' + word(5)) !== 0xc0n || BigInt('0x' + word(6)) !== 0n) return 'carries extra data';
    if ((tx.value ?? 0n) !== 0n) return 'sends value';
    return '';
  }
  return 'not an Elysium way back';
}

/** an L2→L1 message, from ArbSys's L2ToL1Tx log (topics + data), with who it finally pays */
export type ExitMsg = { position: bigint; caller: string; destination: string; arbBlock: bigint; ethBlock: bigint; timestamp: bigint; value: bigint; data: string; asset: ExitAsset | 'other'; recipient: string; amount: bigint };
export function decodeL2ToL1(log: { topics: string[]; data: string }): ExitMsg | null {
  if (!log || log.topics?.[0] !== TOPIC.l2ToL1Tx || log.topics.length < 4) return null;
  const d = String(log.data).toLowerCase().replace(/^0x/, '');
  const word = (i: number) => d.slice(64 * i, 64 * (i + 1));
  const caller = '0x' + word(0).slice(24), destination = '0x' + String(log.topics[1]).slice(26).toLowerCase();
  const off = Number(BigInt('0x' + word(5))) * 2, len = Number(BigInt('0x' + d.slice(off, off + 64)));
  const data = '0x' + d.slice(off + 64, off + 64 + len * 2);
  const msg: ExitMsg = { position: BigInt(log.topics[3]), caller, destination, arbBlock: BigInt('0x' + word(1)), ethBlock: BigInt('0x' + word(2)), timestamp: BigInt('0x' + word(3)), value: BigInt('0x' + word(4)), data, asset: 'other', recipient: '', amount: 0n };
  if (data === '0x' && msg.value > 0n) { msg.asset = 'HYPE'; msg.recipient = destination; msg.amount = msg.value; return msg; }
  // the standard gateway: finalizeInboundTransfer(token, from, to, amount, data) towards the L1 gateway
  if (caller === ELY_EXIT.l2Gateway && destination === ELY_EXIT.l1Gateway && data.startsWith(SEL.finalizeInboundTransfer)) {
    const p = data.slice(10), pw = (i: number) => p.slice(64 * i, 64 * (i + 1));
    if ('0x' + pw(0).slice(24) === ELY_EXIT.l1Usdc) { msg.asset = 'USDC'; msg.recipient = '0x' + pw(2).slice(24); msg.amount = BigInt('0x' + pw(3)); }
  }
  return msg;
}
export type ExitState = 'waiting' | 'claimable' | 'claimed';
/** where a way back stands: claimed (Outbox spent) · claimable (inside the last confirmed send count) · waiting */
export const exitState = (position: bigint, confirmedSize: bigint, spent: boolean): ExitState => (spent ? 'claimed' : position < confirmedSize ? 'claimable' : 'waiting');
/** the Outbox call that pays a confirmed way back (anyone may send it; it pays only the message's own `to`) */
export function claimCall(m: Pick<ExitMsg, 'position' | 'caller' | 'destination' | 'arbBlock' | 'ethBlock' | 'timestamp' | 'value' | 'data'>, proof: readonly string[]): ExitTx {
  if (!proof.length || proof.length > 64 || proof.some((p) => !/^0x[0-9a-fA-F]{64}$/.test(p))) throw new Error('Elysium claim: bad proof');
  const head = 9, dataOff = BigInt(32 * head);
  const proofOff = dataOff;                                                  // the proof array comes first in the tail
  const proofLen = BigInt(32 * (1 + proof.length));
  const dHex = m.data.replace(/^0x/, ''), dLen = BigInt(dHex.length / 2);
  const data = SEL.executeTransaction + w32(proofOff) + w32(m.position) + a32(m.caller) + a32(m.destination) + w32(m.arbBlock) + w32(m.ethBlock) + w32(m.timestamp) + w32(m.value)
    + w32(proofOff + proofLen) + w32(BigInt(proof.length)) + proof.map((p) => p.replace(/^0x/, '').toLowerCase()).join('') + w32(dLen) + dHex.padEnd(Math.ceil(dHex.length / 64) * 64, '0');
  return { to: ELY_EXIT.outbox, value: 0n, data };
}

// ── the retryable-ticket id (Nitro's ArbitrumSubmitRetryableTx hash): keccak256(0x69 ‖ rlp([chainId, requestId (32 bytes),
// from (the aliased L1 sender, as the Bridge's MessageDelivered names it), l1BaseFee, deposit, maxFeePerGas, gasLimit, to,
// l2CallValue, callValueRefundAddress, maxSubmissionCost, excessFeeRefundAddress, data])) — checked against a real ticket
// (HyperEVM tx 0x3026ea1d… → Elysium 0x04e657ca…, B:\tmp\elysium-funding\v3\logs) ──
const hexBytes = (h: string) => { const s = h.replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return o; };
const uintBytes = (v: bigint) => (v === 0n ? new Uint8Array(0) : hexBytes(v.toString(16).length % 2 ? '0' + v.toString(16) : v.toString(16)));
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
const rlpLen = (len: number, short: number) => (len < 56 ? Uint8Array.of(short + len) : (() => { const l = uintBytes(BigInt(len)); return cat(Uint8Array.of(short + 55 + l.length), l); })());
const rlpItem = (b: Uint8Array) => (b.length === 1 && b[0] < 0x80 ? b : cat(rlpLen(b.length, 0x80), b));
const rlpList = (items: Uint8Array[]) => { const body = cat(...items.map(rlpItem)); return cat(rlpLen(body.length, 0xc0), body); };
export function ticketId(t: { chainId: bigint; messageNumber: bigint; from: string; l1BaseFee: bigint; deposit: bigint; maxFeePerGas: bigint; gasLimit: bigint; to: string; l2CallValue: bigint; callValueRefund: string; maxSubmissionCost: bigint; excessFeeRefund: string; data: string }): string {
  const enc = rlpList([uintBytes(t.chainId), hexBytes(t.messageNumber.toString(16).padStart(64, '0')), hexBytes(t.from), uintBytes(t.l1BaseFee), uintBytes(t.deposit),
    uintBytes(t.maxFeePerGas), uintBytes(t.gasLimit), hexBytes(t.to), uintBytes(t.l2CallValue), hexBytes(t.callValueRefund), uintBytes(t.maxSubmissionCost), hexBytes(t.excessFeeRefund), hexBytes(t.data)]);
  const h = keccak_256(cat(Uint8Array.of(0x69), enc));
  return '0x' + Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
}
/** a payout's ticket(s) from its HyperEVM receipt: the Bridge's MessageDelivered (number, aliased sender, base fee) + the
 *  Inbox's InboxMessageDelivered payload of a retryable (kind 9) */
export function ticketsOfReceipt(logs: { address: string; topics: string[]; data: string }[], chainId = BigInt(ELY_EXIT.chainId)): string[] {
  const out: string[] = [];
  for (const md of logs) {
    if (md.topics?.[0] !== TOPIC.messageDelivered) continue;
    const d = md.data.replace(/^0x/, ''), w = (i: number) => d.slice(64 * i, 64 * (i + 1));
    if (parseInt(w(1), 16) !== 9) continue;                                        // L1MessageType_submitRetryableTx
    const num = BigInt(md.topics[1]);
    const imd = logs.find((l) => l.topics?.[0] === TOPIC.inboxMessageDelivered && BigInt(l.topics[1]) === num);
    if (!imd) continue;
    const raw = imd.data.replace(/^0x/, '').slice(128), W = (i: number) => raw.slice(64 * i, 64 * (i + 1));
    const dlen = Number(BigInt('0x' + W(8)));
    out.push(ticketId({ chainId, messageNumber: num, from: '0x' + w(2).slice(24), l1BaseFee: BigInt('0x' + w(4)), deposit: BigInt('0x' + W(2)), maxFeePerGas: BigInt('0x' + W(7)),
      gasLimit: BigInt('0x' + W(6)), to: '0x' + W(0).slice(24), l2CallValue: BigInt('0x' + W(1)), callValueRefund: '0x' + W(5).slice(24), maxSubmissionCost: BigInt('0x' + W(3)),
      excessFeeRefund: '0x' + W(4).slice(24), data: '0x' + raw.slice(64 * 9, 64 * 9 + dlen * 2) }));
  }
  return out;
}
