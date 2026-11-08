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
