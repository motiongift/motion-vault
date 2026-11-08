import { ed25519 } from '@noble/curves/ed25519';
import { Buffer } from 'buffer/index.js';
import { verifyPolicyReceipt, messageHash } from './policy-receipt.mjs';
import { parseUnsignedV0, resolveV0 } from './message-v0.mjs';
import { SOL, b58encode, b58decode, associatedTokenAddress, accountBytes, tokenState, publicKey } from './portable-wire.mjs';
import { verifySolanaSwapInstruction, validateOuter, verifySolanaSimulation } from './portable-guards.mjs';

const fail = message => { throw Error(`Terminal vault: ${message}`); };
const slot = value => { if (!Number.isSafeInteger(value) || value < 0) fail('missing RPC slot'); return value; };

/** Independently reconstruct and simulate the EXACT signed-policy message on vault-owned RPC. */
export async function verifyExactTerminalMessage({ parsed, payload: p, rpc }) {
  const call = (method, params) => rpc(method, params);
  const accounts = async (keys, minContextSlot = undefined) => {
    const result = await call('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed', ...(minContextSlot == null ? {} : { minContextSlot }) }]);
    if (!Array.isArray(result?.value) || result.value.length !== keys.length) fail('incomplete accounts');
    slot(result.context?.slot); return result;
  };
  const [genesis, height, validHash, initial, walletLists] = await Promise.all([
    call('getGenesisHash', []), call('getBlockHeight', [{ commitment: 'confirmed' }]),
    call('isBlockhashValid', [parsed.blockhash, { commitment: 'confirmed' }]),
    accounts([...parsed.lookups.map(l => l.key), p.token, p.feeAccount]),
    Promise.all([SOL.token, SOL.token22].map(programId => call('getTokenAccountsByOwner', [p.trader, { programId }, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]))),
  ]);
  if (genesis !== p.genesis || !Number.isSafeInteger(height) || height < 0 || BigInt(height) >= BigInt(p.lastValidBlockHeight) || BigInt(p.lastValidBlockHeight) > BigInt(height) + 75n || validHash?.value !== true) fail('network or blockhash lifetime mismatch');
  const tableCount = parsed.lookups.length, mint = initial.value[tableCount], mintData = accountBytes(mint);
  if (!mintData || mintData.length < 82 || ![SOL.token, SOL.token22].includes(mint.owner) || mintData[45] !== 1) fail('invalid mint');
  if (mint.owner === SOL.token22 && mintData.length > 166) {
    for (let n = 166; n + 4 <= mintData.length;) {
      const type = mintData.readUInt16LE(n), size = mintData.readUInt16LE(n + 2); n += 4;
      if (n + size > mintData.length || ![0, 1, 3, 18, 19, 20, 21, 22, 23].includes(type)) fail('unsupported Token-2022 extension'); n += size;
    }
  }
  const treasury = tokenState(initial.value[tableCount + 1]);
  if (!treasury || treasury.program !== SOL.token || treasury.mint !== SOL.wsol || treasury.owner !== p.feeRecipient || treasury.state !== 1 || !/^0+$/.test(treasury.delegate) || !/^0+$/.test(treasury.closeAuthority)) fail('invalid fee ATA');
  const { instructions } = resolveV0(parsed, initial.value.slice(0, tableCount));
  const swaps = instructions.filter(ix => ix.programId === SOL.jupiter);
  if (swaps.length !== 1) fail('exactly one Jupiter swap required');
  const coinAta = associatedTokenAddress(p.trader, p.token, mint.owner), wsolAta = associatedTokenAddress(p.trader, SOL.wsol);
  const buy = p.side === 'buy';
  verifySolanaSwapInstruction(swaps[0], { trader: p.trader, inputMint: buy ? SOL.wsol : p.token, outputMint: buy ? p.token : SOL.wsol,
    inputAta: buy ? wsolAta : coinAta, outputAta: buy ? coinAta : wsolAta, feeAccount: p.feeAccount,
    amount: BigInt(p.amount), outAmount: BigInt(p.quotedOut), slippageBps: p.slippageBps, feeBps: p.feeBps });
  const setupAccounts = validateOuter(instructions, { trader: p.trader, side: p.side, amount: BigInt(p.amount), wsolAta, swap: swaps[0] });
  if (walletLists.some(list => !Array.isArray(list?.value))) fail('wallet inventory missing');
  const inventory = walletLists.flatMap(list => list.value);
  if (inventory.length > 80) fail('wallet inventory exceeds safety bound');
  const addresses = [...new Set([p.trader, coinAta, wsolAta, p.feeAccount, ...setupAccounts.map(a => a.address), ...inventory.map(a => publicKey(a.pubkey))])];
  const snapshot = await accounts(addresses, initial.context.slot), snapshotSlot = slot(snapshot.context.slot);
  if (snapshotSlot < initial.context.slot) fail('account snapshot moved backwards');
  const before = new Map(addresses.map((a, i) => [a, snapshot.value[i]]));
  if (tokenState(before.get(wsolAta))?.amount > 0n) fail('existing positive WSOL cannot be closed');
  const [fee, simulated] = await Promise.all([
    call('getFeeForMessage', [parsed.message.toString('base64'), { commitment: 'confirmed', minContextSlot: snapshotSlot }]),
    call('simulateTransaction', [parsed.serialized, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false,
      commitment: 'confirmed', minContextSlot: snapshotSlot, innerInstructions: true, accounts: { encoding: 'base64', addresses } }]),
  ]);
  if (!Number.isSafeInteger(fee?.value) || fee.value < 0 || fee.value > 5000000 || slot(simulated?.context?.slot) < snapshotSlot) fail('invalid fee or simulation slot');
  const checked = verifySolanaSimulation({ simulation: simulated.value, addresses, before, trader: p.trader, coinAta, wsolAta,
    feeAccount: p.feeAccount, side: p.side, amount: BigInt(p.amount), minOut: BigInt(p.minOut), networkFee: BigInt(fee.value),
    maxNative: BigInt(p.maxNative), feeBps: p.feeBps, setupAccounts });
  if (checked.fee !== p.feeAmount) fail('current fee differs from signed quote; requote required');
  return Object.freeze({ ...checked, snapshotSlot, simulationSlot: simulated.context.slot });
}

/** Scoped capability, never expose as a generic raw-message signer.
 * signExact returns ONLY a 64-byte trader signature. sendExact must use the existing
 * held-wallet send path, with no rebuilding/rebroadcast after unknown outcome.
 * store.claim/update are durable atomic transactions, not process-local maps.
 */
export function createTerminalVaultConsumer({ config, rpc, store, signExact, sendExact, verifyMarket, now = () => Date.now() }) {
  if (![rpc, signExact, sendExact, verifyMarket].every(f => typeof f === 'function') || !store?.claim || !store?.update) fail('vault dependencies missing');
  const pinned = Object.freeze({ ...config });
  publicKey(pinned.trader);
  return Object.freeze({ async consume({ envelope, serialized, intent }) {
    // Copy caller-owned data before any asynchronous stage.
    const receipt = structuredClone(envelope), expected = Object.freeze({ ...intent });
    const { payload: p, receiptHash } = verifyPolicyReceipt(receipt, { ...pinned, now: now() });
    if (!['trader', 'token', 'side', 'amount', 'slippageBps'].every(k => expected[k] === p[k])) fail('receipt differs from user trade intent');
    const parsed = parseUnsignedV0(serialized);
    if (parsed.trader !== pinned.trader || parsed.blockhash !== p.recentBlockhash || messageHash(parsed.message) !== p.messageSha256) fail('exact message differs from policy receipt');
    const checked = await verifyExactTerminalMessage({ parsed, payload: p, rpc });
    if (await verifyMarket(Object.freeze({ intent: expected, payload: p, checked })) !== true) fail('independent market price check failed');
    verifyPolicyReceipt(receipt, { ...pinned, now: now() });
    const claim = Object.freeze({ trader: p.trader, receiptId: p.receiptId, reservationId: p.reservationId, receiptHash,
      messageSha256: p.messageSha256, expiresAt: p.expiresAt, lastValidBlockHeight: p.lastValidBlockHeight, status: 'claimed' });
    if (await store.claim(claim) !== true) fail('wallet or receipt already used or pending');
    // From here, any error is conservatively held. A process crash also leaves claimed.
    let signatureText = null;
    try {
      verifyPolicyReceipt(receipt, { ...pinned, now: now() });
      const signature = await signExact(Uint8Array.from(parsed.message), Object.freeze({ trader: p.trader, receiptId: p.receiptId }));
      if (!(signature instanceof Uint8Array) || signature.length !== 64 ||
        !ed25519.verify(signature, parsed.message, b58decode(p.trader), { zip215: false })) fail('wallet returned wrong signature or changed message');
      signatureText = b58encode(signature);
      await store.update(p.receiptId, { status: 'signed', signature: signatureText });
      verifyPolicyReceipt(receipt, { ...pinned, now: now() });
      const tx = Buffer.concat([Buffer.from([1]), Buffer.from(signature), parsed.message]);
      await store.update(p.receiptId, { status: 'sending', signature: signatureText });
      const result = await sendExact(Uint8Array.from(tx), Object.freeze({ signature: signatureText, trader: p.trader,
        lastValidBlockHeight: Number(p.lastValidBlockHeight), receiptId: p.receiptId }));
      if (result?.signature !== signatureText) fail('sender did not acknowledge exact signature');
      await store.update(p.receiptId, { status: 'submitted', signature: signatureText });
      return Object.freeze({ status: 'submitted', signature: signatureText, receiptId: p.receiptId, checked });
    } catch (error) {
      // Do not release on a timeout, a sign error, or a failed persistence write.
      // A failed update still leaves the earlier durable claimed/signed/sending row.
      try { await store.update(p.receiptId, { status: 'unknown', signature: signatureText }); } catch {}
      throw Object.assign(new Error('Terminal trade status unknown; no automatic retry'), { name: 'TerminalSendUnknown', code: 'TerminalSendUnknown', unknown: true, hash: signatureText, signature: signatureText, receiptId: p.receiptId, cause: error });
    }
  } });
}
