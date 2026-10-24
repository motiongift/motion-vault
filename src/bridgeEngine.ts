// Cross-chain moves through Relay (relay.link) from the vault's own wallets.
// One EVM key is the same address on every EVM chain, so a bridge is just a
// deposit transaction on the origin chain to Relay's deposit contract carrying
// the quote's request id; Relay pays out on the destination within seconds.
//
// The page fetches the quote (through our server, which may add the app fee)
// and hands the deposit step here. Before signing, this module asks Relay for
// its own keyless quote of the same route and refuses unless the deposit goes
// to the same contract, the calldata names this wallet as depositor, and the
// value is exactly the amount the user typed — a tampered page cannot redirect
// funds anywhere but Relay.
import { createPublicClient, createWalletClient, defineChain, http, fallback, formatEther, parseEther, serializeTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// F-44 (V12): OP-stack chains charge an L1 data fee ON TOP of the L2 gas (gas × maxFeePerGas), billed at execution and
// not reflected in the gas estimate. A "max" transfer that reserves only L2 gas leaves too little and the tx fails.
// The GasPriceOracle predeploy quotes that L1 fee for a given serialized tx; on non-OP chains the call reverts → 0.
const OP_STACK = new Set([10, 8453]);   // Optimism, Base (Arbitrum/Robinhood fold the L1 cost into the inflated gas estimate)
const L1_GAS_ORACLE = '0x420000000000000000000000000000000000000F' as const;
const L1_FEE_ABI = [{ type: 'function', name: 'getL1Fee', stateMutability: 'view', inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ name: '', type: 'uint256' }] }] as const;
async function opL1Fee(pc: ReturnType<typeof createPublicClient>, chainId: number, serialized: `0x${string}`): Promise<bigint> {
  if (!OP_STACK.has(chainId)) return 0n;
  try { return await pc.readContract({ address: L1_GAS_ORACLE, abi: L1_FEE_ABI, functionName: 'getL1Fee', args: [serialized] }) as bigint; } catch { return 0n; }
}

export const BRIDGE_CHAINS: Record<number, { id: number; key: string; name: string; symbol: string; rpcs: string[]; explorer: string }> = {
  1: { id: 1, key: 'ethereum', name: 'Ethereum', symbol: 'ETH', rpcs: ['https://ethereum-rpc.publicnode.com'], explorer: 'https://etherscan.io' },
  10: { id: 10, key: 'optimism', name: 'Optimism', symbol: 'ETH', rpcs: ['https://optimism-rpc.publicnode.com'], explorer: 'https://optimistic.etherscan.io' },
  56: { id: 56, key: 'bsc', name: 'BNB Chain', symbol: 'BNB', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-mainnet.nodereal.io'], explorer: 'https://bscscan.com' },
  137: { id: 137, key: 'polygon', name: 'Polygon', symbol: 'POL', rpcs: ['https://polygon-bor-rpc.publicnode.com'], explorer: 'https://polygonscan.com' },
  4663: { id: 4663, key: 'robinhood', name: 'Robinhood Chain', symbol: 'ETH', rpcs: ['https://robinhood-rpc.publicnode.com', 'https://rpc.mainnet.chain.robinhood.com'], explorer: 'https://robin.etherscan.io' },
  5042: { id: 5042, key: 'arc', name: 'Arc', symbol: 'USDC', rpcs: ['https://rpc.mainnet.arc.io'], explorer: 'https://explorer.arc.io' },
  8453: { id: 8453, key: 'base', name: 'Base', symbol: 'ETH', rpcs: ['https://base-rpc.publicnode.com'], explorer: 'https://basescan.org' },
  42161: { id: 42161, key: 'arbitrum', name: 'Arbitrum', symbol: 'ETH', rpcs: ['https://arbitrum-one-rpc.publicnode.com'], explorer: 'https://arbiscan.io' },
  43114: { id: 43114, key: 'avalanche', name: 'Avalanche', symbol: 'AVAX', rpcs: ['https://avalanche-c-chain-rpc.publicnode.com'], explorer: 'https://snowtrace.io' },
};
const RELAY = 'https://api.relay.link';
const NATIVE = '0x0000000000000000000000000000000000000000';
type Acct = { id: string; name: string; address: `0x${string}`; key?: `0x${string}`; ext?: string };
export type DepositStep = { to: string; data: string; value: string; chainId: number; gas?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
// phase 'bind' (vault quotes + gates, signs nothing, hands back a single-use ticket and the request id to follow);
// ticket (sign what the bind fixed); minOut (the floor the page showed, in the destination's smallest unit)
export type BridgeQuoteLite = { requestId: string; originChainId: number; destinationChainId: number; amount: string; recipient: string; step: DepositStep; out?: string; outFormatted?: string; minOut?: string; phase?: 'bind'; ticket?: string };

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
function chainOf(chainId: number) {
  const c = BRIDGE_CHAINS[chainId]; if (!c) throw new Error(`Chain ${chainId} is not bridgeable here`);
  return defineChain({ id: c.id, name: c.name, nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 }, rpcUrls: { default: { http: c.rpcs } } });
}
export function publicFor(chainId: number) {
  let p = clients.get(chainId); if (p) return p;
  const c = BRIDGE_CHAINS[chainId]; if (!c) throw new Error(`Chain ${chainId} is not bridgeable here`);
  p = createPublicClient({ chain: chainOf(chainId), transport: fallback(c.rpcs.map((u) => http(u, { retryCount: 1, timeout: 12000 })), { rank: false }) });
  clients.set(chainId, p); return p;
}
export async function bridgeBalances(chainId: number, addresses: string[]): Promise<Record<string, number>> {
  const pc = publicFor(chainId); const out: Record<string, number> = {};
  // F-29 (V12): a failed read is OMITTED, never reported as 0 — a rate-limited node must not make a funded wallet look empty.
  await Promise.all([...new Set(addresses.map((a) => a.toLowerCase()))].map(async (a) => { try { out[a] = Number(formatEther(await pc.getBalance({ address: a as `0x${string}` }))); } catch { /* omit */ } }));
  return out;
}

// Relay's own view of the route, fetched from this frame (no app fee, no key):
// the deposit contract it names is the only place a deposit may go
async function relayQuoteDirect(user: string, originChainId: number, destinationChainId: number, amount: string, recipient: string) {
  const r = await fetch(`${RELAY}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, recipient, originChainId, destinationChainId, originCurrency: NATIVE, destinationCurrency: destinationChainId === 792703809 ? '11111111111111111111111111111111' : NATIVE, amount, tradeType: 'EXACT_INPUT' }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.steps) throw new Error('Relay: ' + (j?.message || r.status));
  const step = j.steps.find((s: any) => s.kind === 'transaction')?.items?.[0]?.data;
  if (!step?.to) throw new Error('Relay quote has no deposit step');
  return { to: String(step.to).toLowerCase(), chainId: Number(step.chainId), data: String(step.data || '') };
}
const selectorOf = (data: string) => String(data || '').slice(0, 10).toLowerCase();

// sign and send the page's deposit step after verifying it against Relay directly
export async function bridgeDeposit(a: Acct, q: BridgeQuoteLite): Promise<`0x${string}`> {
  if (!a.key || a.ext) throw new Error('This wallet cannot sign here (Privy wallets sign through Privy)');
  const me = a.address.toLowerCase();
  const { step } = q;
  if (Number(step.chainId) !== Number(q.originChainId)) throw new Error('Deposit step is on the wrong chain');
  if (!BRIDGE_CHAINS[q.originChainId]) throw new Error(`Chain ${q.originChainId} is not bridgeable here`);
  if (BigInt(step.value) !== BigInt(q.amount)) throw new Error('Deposit value does not match the amount');
  const data = String(step.data || '').toLowerCase();
  if (!data.includes(me.slice(2))) throw new Error('Deposit calldata does not name this wallet');
  const own = await relayQuoteDirect(a.address, q.originChainId, q.destinationChainId, q.amount, q.recipient);
  if (own.to !== String(step.to).toLowerCase() || own.chainId !== Number(step.chainId) || selectorOf(own.data) !== selectorOf(data)) throw new Error('Deposit target is not Relay\'s contract for this route — refused');
  const account = privateKeyToAccount(a.key);
  const pc = publicFor(q.originChainId);
  const bal = await pc.getBalance({ address: account.address });
  const value = BigInt(step.value);
  const gas = step.gas ? (BigInt(step.gas) * 13n) / 10n : 60_000n;
  const fees = await pc.estimateFeesPerGas().catch(() => null);
  const maxFee = fees?.maxFeePerGas ?? (step.maxFeePerGas ? BigInt(step.maxFeePerGas) : undefined);
  if (maxFee && bal < value + gas * maxFee) throw new Error(`Not enough ${BRIDGE_CHAINS[q.originChainId].symbol} for the amount plus gas on ${BRIDGE_CHAINS[q.originChainId].name}`);
  const wc = createWalletClient({ account, chain: chainOf(q.originChainId), transport: http(BRIDGE_CHAINS[q.originChainId].rpcs[0], { timeout: 20000 }) });
  return wc.sendTransaction({ to: step.to as `0x${string}`, data: data as `0x${string}`, value, gas, ...(fees?.maxFeePerGas ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}) });
}
// a plain native transfer on any bridgeable chain (the hop → final leg, or topping up a wallet elsewhere)
export async function bridgeSend(a: Acct, chainId: number, to: string, amount: number | 'max'): Promise<`0x${string}`> {
  if (!a.key || a.ext) throw new Error('This wallet cannot sign here');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Invalid address');
  const account = privateKeyToAccount(a.key); const pc = publicFor(chainId);
  const fees = await pc.estimateFeesPerGas();
  const gas = 21_000n; const gasCost = gas * (fees.maxFeePerGas || 0n);
  let value: bigint;
  if (amount === 'max') {
    const bal = await pc.getBalance({ address: account.address });
    // F-44 (V12): reserve the L2 gas (+20%) AND the OP-stack L1 data fee (+20%), so "max" keeps enough for both
    let l1 = 0n;
    if (OP_STACK.has(chainId)) {
      try {
        const nonce = await pc.getTransactionCount({ address: account.address });
        const sample = serializeTransaction({ chainId, nonce, to: to as `0x${string}`, value: bal, gas, maxFeePerGas: fees.maxFeePerGas || 0n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas || 0n });
        l1 = await opL1Fee(pc, chainId, sample);
      } catch { l1 = 0n; }
    }
    value = bal - gasCost - gasCost / 5n - l1 - l1 / 5n;
    if (value <= 0n) throw new Error('Nothing to send after gas');
  } else value = parseEther(String(amount));
  if (value <= 0n) throw new Error('Nothing to send');   // F-67 (V12): a non-positive value is refused before anything is signed
  const wc = createWalletClient({ account, chain: chainOf(chainId), transport: http(BRIDGE_CHAINS[chainId].rpcs[0], { timeout: 20000 }) });
  return wc.sendTransaction({ to: to as `0x${string}`, value, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
}
export async function bridgeReceipt(chainId: number, hash: string) {
  const r = await publicFor(chainId).getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
  if (!r) return { ok: true, pending: true };
  return { ok: true, pending: false, status: r.status, block: Number(r.blockNumber) };
}
