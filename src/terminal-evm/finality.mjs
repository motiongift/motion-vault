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
// Its outcome is KNOWN only when the account nonce it was signed with is consumed in the state of a block that is at or
// below the chosen finality (confirmations === null: the L1 'finalized' tag, the default; a number: the F2 option's
// latest-(N-1)) AND no receipt and no mined transaction exist for the exact persisted hash. Same nonce, consumed in final
// state: this transaction can never be included any more. Every read error, mismatch or missing field is "not dropped".
// engine-review 2026-11-09 (R1): the nonce is NOT read at the finalized height. Both default Robinhood nodes refuse state
// that deep (publicnode keeps ~64-127 blocks, rpc.mainnet.chain.robinhood.com ~6,000-7,000; finalized lags ~9,500), so the
// old read failed closed for ever there. Two steps instead:
//   1. ANCHOR (row.dropAnchor absent): the nonce is read in the state of the current head BY BLOCK HASH (EIP-1898), so the
//      answer is bound to that exact block whichever fallback node serves it. Consumed + no receipt -> { anchor } to persist.
//   2. PROOF (row.dropAnchor present, a later reconcile): the anchor height is now at/below the chosen finality and the
//      canonical header at that height still has the anchor's hash (headers only, no historical state). State of a final
//      canonical block is final. Then no receipt and no mined transaction for the exact hash -> dropped.
// A pending or unreadable proof keeps the anchor (it is re-proven from scratch every time); a reorged anchor or a receipt
// voids it. The verdict only lets the journal release the wallet lock for NEW trades. Nothing is rebuilt, replaced or re-sent.
const anchorShape = (a, txNonce) => !!a && typeof a === 'object' && typeof a.blockNumber === 'string' && /^\d{1,20}$/.test(a.blockNumber) &&
  typeof a.blockHash === 'string' && /^0x[a-f0-9]{64}$/.test(a.blockHash) && typeof a.accountNonce === 'string' && /^\d{1,16}$/.test(a.accountNonce) &&
  BigInt(a.accountNonce) > BigInt(txNonce);
export async function verifyEvmDropped({ client, chainId, row, confirmations = null }) {
  if (!row?.hash || !/^0x[a-f0-9]{40}$/.test(String(row.trader)) || typeof row.txNonce !== 'string' || !/^\d{1,16}$/.test(row.txNonce)) return { dropped: false };
  if (confirmations !== null && (!Number.isSafeInteger(confirmations) || confirmations < 1)) return { dropped: false };
  const anchor = row.dropAnchor == null ? null : row.dropAnchor;
  if (anchor !== null && !anchorShape(anchor, row.txNonce)) return { dropped: false };
  const keep = anchor ? { anchor: { blockNumber: anchor.blockNumber, blockHash: anchor.blockHash, accountNonce: anchor.accountNonce } } : {};
  try {
    if (await client.getChainId() !== chainId) return { dropped: false, ...keep };
    if (!anchor) {
      const head = await client.getBlock({ blockTag: 'latest' });
      if (!head?.hash || typeof head.number !== 'bigint' || !/^0x[a-fA-F0-9]{64}$/.test(head.hash)) return { dropped: false };
      const blockHash = head.hash.toLowerCase();
      const count = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [row.trader, { blockHash }] }));
      if (count <= BigInt(row.txNonce)) return { dropped: false };
      if (await receiptOrNull(client, row.hash)) return { dropped: false };
      return { dropped: false, anchor: { blockNumber: head.number.toString(), blockHash, accountNonce: count.toString() } };
    }
    const at = BigInt(anchor.blockNumber);
    let final;
    if (confirmations === null) {
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (!finalized?.hash || typeof finalized.number !== 'bigint') return { dropped: false, ...keep }; // no 'latest' substitute
      final = finalized.number;
    } else {
      final = (await client.getBlockNumber()) - BigInt(confirmations - 1);
    }
    if (final < at) return { dropped: false, ...keep }; // anchor not final yet
    const canonical = await client.getBlock({ blockNumber: at });
    if (!canonical?.hash || canonical.number !== at) return { dropped: false, ...keep };
    if (canonical.hash.toLowerCase() !== anchor.blockHash) return { dropped: false }; // reorged away: the anchor is void
    // Read AFTER finality: had this exact transaction consumed the nonce at or below the anchor, its receipt exists now.
    const [receipt, transaction] = await Promise.all([receiptOrNull(client, row.hash), transactionOrNull(client, row.hash)]);
    if (receipt) return { dropped: false };
    if (transaction && (transaction.blockNumber != null || String(transaction.hash).toLowerCase() !== row.hash.toLowerCase() ||
      String(transaction.from).toLowerCase() !== row.trader || BigInt(transaction.nonce) !== BigInt(row.txNonce))) return { dropped: false };
    return { dropped: true, hash: row.hash, accountNonce: anchor.accountNonce, atBlock: anchor.blockNumber, atBlockHash: anchor.blockHash };
  } catch {
    return { dropped: false, ...keep };
  }
}
