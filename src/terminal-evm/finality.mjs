// Fail closed: confirmation count alone does not release an uncertain wallet.
export async function verifyEvmFinality({ client, chainId, row, confirmations }) {
  if (!row?.hash || !Number.isSafeInteger(confirmations) || confirmations < 1) return { final: false };
  try {
    const [network, receipt] = await Promise.all([
      client.getChainId(), client.getTransactionReceipt({ hash: row.hash }),
    ]);
    if (network !== chainId || !receipt || receipt.transactionHash.toLowerCase() !== row.hash.toLowerCase() ||
      !['success', 'reverted'].includes(receipt.status)) return { final: false };
    const [canonical, finalized, latest] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlock({ blockTag: 'finalized' }),
      client.getBlockNumber(),
    ]);
    if (!canonical?.hash || !finalized?.hash || finalized.number == null ||
      canonical.number !== receipt.blockNumber || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      finalized.number < receipt.blockNumber || latest < receipt.blockNumber + BigInt(confirmations - 1) ||
      (finalized.number === receipt.blockNumber && finalized.hash.toLowerCase() !== canonical.hash.toLowerCase())) return { final: false };
    return { final: true, hash: row.hash, success: receipt.status === 'success' };
  } catch {
    // An unavailable/unsupported finalized tag is not replaced with "latest".
    return { final: false };
  }
}

// ---- fee-sprint3 (2026-11-09): review F3 (dropped transaction) and the F2 OPTION (Robinhood L2 release, default OFF) ----
const notFound = e => /^(TransactionReceiptNotFoundError|TransactionNotFoundError)$/.test(String(e?.name || ''));
const receiptOrNull = async (client, hash) => { try { return (await client.getTransactionReceipt({ hash })) ?? null; } catch (e) { if (notFound(e)) return null; throw e; } };
const transactionOrNull = async (client, hash) => { try { return (await client.getTransaction({ hash })) ?? null; } catch (e) { if (notFound(e)) return null; throw e; } };

// F2 OPTION, used only when src/terminalEvmRelease.ts pins TERMINAL_EVM_RH_L2_RELEASE (null in every reviewed build).
// Soft release: the exact persisted hash has a receipt in a canonical L2 block with `confirmations` blocks on top.
// It does NOT wait for L1 finality; the caller keeps the quote nonce / reservation keys consumed forever, so replay
// protection never depends on this verdict. The result is marked soft for the journal's reorg-audit history.
export async function verifyEvmL2Receipt({ client, chainId, row, confirmations }) {
  if (!row?.hash || !Number.isSafeInteger(confirmations) || confirmations < 1) return { final: false };
  try {
    const [network, receipt] = await Promise.all([client.getChainId(), receiptOrNull(client, row.hash)]);
    if (network !== chainId || !receipt || String(receipt.transactionHash).toLowerCase() !== row.hash.toLowerCase() ||
      !['success', 'reverted'].includes(receipt.status) || typeof receipt.blockNumber !== 'bigint' || !receipt.blockHash) return { final: false };
    const [canonical, latest] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber()]);
    if (!canonical?.hash || canonical.number !== receipt.blockNumber || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      latest < receipt.blockNumber + BigInt(confirmations - 1)) return { final: false };
    return { final: true, soft: true, hash: row.hash, success: receipt.status === 'success',
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase() };
  } catch {
    return { final: false };
  }
}

// F3: a signed transaction that never lands (dropped from the mempool, or its account nonce consumed by another lane).
// Its outcome is KNOWN only when the account nonce it was signed with is already consumed at the chosen finality
// (confirmations === null: the L1 'finalized' tag, the default; a number: the F2 option's latest-(N-1) block) AND no
// receipt and no mined transaction exist for the exact persisted hash. Same nonce, consumed: this transaction can never
// be included any more. Every read error, mismatch or missing field is "not dropped" (the wallet stays held).
// The verdict only lets the journal release the wallet lock for NEW trades. Nothing is rebuilt, replaced or re-sent.
export async function verifyEvmDropped({ client, chainId, row, confirmations = null }) {
  if (!row?.hash || !/^0x[a-f0-9]{40}$/.test(String(row.trader)) || typeof row.txNonce !== 'string' || !/^\d{1,16}$/.test(row.txNonce)) return { dropped: false };
  if (confirmations !== null && (!Number.isSafeInteger(confirmations) || confirmations < 1)) return { dropped: false };
  try {
    if (await client.getChainId() !== chainId) return { dropped: false };
    let ref;
    if (confirmations === null) {
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (!finalized?.hash || typeof finalized.number !== 'bigint') return { dropped: false }; // no 'latest' substitute
      ref = finalized.number;
    } else {
      ref = (await client.getBlockNumber()) - BigInt(confirmations - 1);
      if (ref < 0n) return { dropped: false };
    }
    const count = BigInt(await client.getTransactionCount({ address: row.trader, blockNumber: ref }));
    if (count <= BigInt(row.txNonce)) return { dropped: false };
    // Read AFTER the nonce: had this exact transaction consumed the nonce at or below `ref`, its receipt exists now.
    const [receipt, transaction, head] = await Promise.all([receiptOrNull(client, row.hash), transactionOrNull(client, row.hash), client.getBlockNumber()]);
    if (receipt || head < ref) return { dropped: false };
    if (transaction && (transaction.blockNumber != null || String(transaction.hash).toLowerCase() !== row.hash.toLowerCase() ||
      String(transaction.from).toLowerCase() !== row.trader || BigInt(transaction.nonce) !== BigInt(row.txNonce))) return { dropped: false };
    return { dropped: true, hash: row.hash, accountNonce: count.toString(), atBlock: ref.toString() };
  } catch {
    return { dropped: false };
  }
}
