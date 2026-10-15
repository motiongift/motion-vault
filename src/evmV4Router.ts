// Uniswap V4 execution on Robinhood Chain through the Uniswap Universal Router.
//
// Most active Robinhood tokens trade in Uniswap V4 pools created by Robinhood's
// launcher hook (fee 0 / dynamic, tickSpacing 200), paired with native ETH,
// USDG, or a numeraire token. This module discovers a token's V4 poolKey from
// the PoolManager `Initialize` event and encodes Universal Router calldata per
// Uniswap's documented command/action format. The shapes below were verified
// by read-only simulation against mainnet before shipping:
//   native pair : V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL(native), TAKE_ALL]
//   USDG pair   : WRAP_ETH → V3_SWAP_EXACT_IN(WETH→USDG, to router)
//                 → V4_SWAP[SETTLE(USDG, CONTRACT_BALANCE), SWAP(OPEN_DELTA), TAKE_ALL]
//   USDG sell   : V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL(token), TAKE(USDG → router)]
//                 → V3_SWAP_EXACT_IN(CONTRACT_BALANCE, USDG→WETH, to router) → UNWRAP_WETH
//                 (TAKE_ALL would pay the trader, leaving the router nothing for the V3 leg: 'AS')
// Pure: no chrome/runtime dependencies, so the encoders are unit-testable.
import { encodeAbiParameters, encodePacked, toHex } from 'viem';

export const UNIVERSAL_ROUTER = '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';
// Robinhood's token-launcher hook. Every canonical launch pool is created with
// this hook (fee 0 / dynamic, tickSpacing 200). Tokens also accumulate junk
// third-party V4 pools with absurd fees and no liquidity, so pool selection
// keys on this hook rather than recency.
export const ROBINHOOD_LAUNCHER_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
// Doppler's hook initializer — by volume the busiest launcher on the chain
// (roughly ten times the pool count of the Robinhood launcher). Its pools are
// ordinary V4 pools and swap through the Universal Router like any other.
export const DOPPLER_LAUNCHER_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
export const KNOWN_LAUNCHER_HOOKS = [ROBINHOOD_LAUNCHER_HOOK, DOPPLER_LAUNCHER_HOOK];
// Uniswap's dynamic-fee flag. Anything else above 10% is a spam pool: the chain
// is full of hookless V4 pools with 77-81% fees that quote garbage or revert.
export const DYNAMIC_FEE_FLAG = 0x800000;
export const MAX_STATIC_FEE = 100_000;
// Universal Router recipient sentinel meaning "the router itself".
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
// V4Router ActionConstants
export const CONTRACT_BALANCE = 1n << 255n;
export const OPEN_DELTA = 0n;
// PoolManager.Initialize(bytes32 id, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
export const V4_INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
// How far back to look for a token's pool. Discovery uses a precise topic
// filter, which the Robinhood RPC serves across very wide ranges.
export const V4_DISCOVERY_LOOKBACK_BLOCKS = 8_000_000n;

export const Commands = { V3_SWAP_EXACT_IN: 0x00, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
export const Actions = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;

export type V4PoolKey = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

export type V4Pair = 'native' | 'usdg' | 'weth';

export type V4Candidate = { poolKey: V4PoolKey; pair: V4Pair };

export type V4UrRoute = {
  type: 'v4-ur';
  poolKey: V4PoolKey;
  pair: V4Pair;
  // V3 fee tier of the WETH↔USDG bridge pool (usdg pair only).
  bridgeFee: number;
};

const POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ],
} as const;

export const UNIVERSAL_ROUTER_ABI = [{
  name: 'execute', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
  outputs: [],
}] as const;

export const V4_QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: POOL_KEY_ABI.components },
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const;

export const PERMIT2_ABI = [
  {
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
    outputs: [],
  },
] as const;

export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;

// ─── discovery ───────────────────────────────────────────────────────────────

export type V4Log = { topics: string[]; data: string; blockNumber: string };
export type RawGetLogs = (filter: { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string }) => Promise<V4Log[]>;

function padTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function decodeInitializeLog(log: V4Log): V4PoolKey {
  const data = log.data.slice(2);
  const word = (i: number) => data.slice(i * 64, (i + 1) * 64);
  const rawTick = parseInt(word(1), 16);
  return {
    currency0: `0x${log.topics[2].slice(26)}` as `0x${string}`,
    currency1: `0x${log.topics[3].slice(26)}` as `0x${string}`,
    fee: parseInt(word(0), 16),
    tickSpacing: rawTick >= 2 ** 23 ? rawTick - 2 ** 24 : rawTick,
    hooks: `0x${word(2).slice(24)}` as `0x${string}`,
  };
}

// Rank every tradeable V4 pool for a token, best first. Accepts pools paired
// with native ETH, WETH or USDG from any hook, ranks known launcher hooks and
// native pairs first, and drops spam pools with absurd static fees (the chain
// is full of hookless 77-97% fee pools). Returns candidates rather than one
// pool because an eligible pool can still be empty — the caller probes each
// with a quote and takes the first that actually prices.
export function rankV4Candidates(
  logs: V4Log[],
  token: string,
  usdgAddress: string,
  wethAddress = '',
): V4Candidate[] {
  const usdg = usdgAddress.toLowerCase();
  const weth = wethAddress.toLowerCase();
  const seen = new Set<string>();
  const candidates = logs
    .map((log) => ({ key: decodeInitializeLog(log), block: parseInt(log.blockNumber, 16) }))
    .map(({ key, block }) => {
      const other = (key.currency0.toLowerCase() === token.toLowerCase() ? key.currency1 : key.currency0).toLowerCase();
      const pair: V4Pair | null = other === NATIVE_CURRENCY ? 'native' : other === usdg ? 'usdg' : (weth && other === weth) ? 'weth' : null;
      return { poolKey: key, block, pair };
    })
    .filter((c): c is { poolKey: V4PoolKey; block: number; pair: V4Pair } => c.pair !== null)
    .filter((c) => c.poolKey.fee === DYNAMIC_FEE_FLAG || c.poolKey.fee <= MAX_STATIC_FEE)
    .filter((c) => {
      const id = `${c.poolKey.currency0}:${c.poolKey.currency1}:${c.poolKey.fee}:${c.poolKey.tickSpacing}:${c.poolKey.hooks}`.toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const rank = (c: { poolKey: V4PoolKey; pair: V4Pair }) =>
    (KNOWN_LAUNCHER_HOOKS.includes(c.poolKey.hooks.toLowerCase()) ? 0 : 1) * 10
    + (c.pair === 'native' ? 0 : c.pair === 'weth' ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b) || b.block - a.block);
  return candidates.map(({ poolKey, pair }) => ({ poolKey, pair }));
}

export async function resolveV4PoolCandidates(
  token: string,
  usdgAddress: string,
  latestBlock: bigint,
  getLogs: RawGetLogs,
  wethAddress = '',
): Promise<V4Candidate[]> {
  const tokenTopic = padTopic(token);
  const from = `0x${(latestBlock > V4_DISCOVERY_LOOKBACK_BLOCKS ? latestBlock - V4_DISCOVERY_LOOKBACK_BLOCKS : 0n).toString(16)}`;
  const filters = [
    [V4_INITIALIZE_TOPIC, null, null, tokenTopic],
    [V4_INITIALIZE_TOPIC, null, tokenTopic, null],
  ];
  const logs: V4Log[] = [];
  for (const topics of filters) {
    const found = await getLogs({ address: V4_POOL_MANAGER, topics, fromBlock: from, toBlock: 'latest' }).catch(() => []);
    logs.push(...found);
  }
  return rankV4Candidates(logs, token, usdgAddress, wethAddress);
}

// Best single pool (first candidate), kept for callers that do not probe.
export async function resolveV4PoolKey(
  token: string,
  usdgAddress: string,
  latestBlock: bigint,
  getLogs: RawGetLogs,
  wethAddress = '',
): Promise<V4Candidate | null> {
  const candidates = await resolveV4PoolCandidates(token, usdgAddress, latestBlock, getLogs, wethAddress);
  return candidates[0] ?? null;
}

// ─── encoders (Universal Router execute inputs) ──────────────────────────────

type Encoded = { commands: `0x${string}`; inputs: `0x${string}`[] };

function encodeSwapExactInSingle(poolKey: V4PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_ABI.components },
      { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
    ]}],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }],
  );
}

function encodeV4Swap(actions: number[], params: `0x${string}`[]): `0x${string}` {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
}

const encodeCurrencyAmount = (currency: string, amount: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency as `0x${string}`, amount]);

// Buy with native ETH into a pool paired with native ETH (single V4 hop).
export function encodeV4BuyNative(poolKey: V4PoolKey, token: string, amountIn: bigint, amountOutMinimum: bigint): Encoded {
  const zeroForOne = poolKey.currency0.toLowerCase() === NATIVE_CURRENCY;
  const v4 = encodeV4Swap(
    [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL],
    [
      encodeSwapExactInSingle(poolKey, zeroForOne, amountIn, amountOutMinimum),
      encodeCurrencyAmount(NATIVE_CURRENCY, amountIn),
      encodeCurrencyAmount(token, amountOutMinimum),
    ],
  );
  return { commands: toHex(new Uint8Array([Commands.V4_SWAP])), inputs: [v4] };
}

// Buy with native ETH into a pool paired with USDG: wrap, bridge WETH→USDG on
// V3 into the router, then settle the router's USDG balance into V4 and swap.
// Robinhood's launchpads quote in whatever they like — USDG, NVDA, GLD, META.
// Reaching such a pool from ETH is always the same shape: wrap, walk a V3 path
// to the quote asset, then swap that balance into the V4 pool. The path is
// handed in pre-packed so it can be one hop or three.
export function encodeV4BuyViaPath(
  poolKey: V4PoolKey, token: string, bridgeToken: string, path: `0x${string}`,
  amountIn: bigint, amountOutMinimum: bigint,
): Encoded {
  const wrap = encodeCurrencyAmount(ADDRESS_THIS, amountIn);
  const v3 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [ADDRESS_THIS, amountIn, 0n, path, false],
  );
  const zeroForOne = poolKey.currency0.toLowerCase() === bridgeToken.toLowerCase();
  const v4 = encodeV4Swap(
    [Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE_ALL],
    [
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [bridgeToken as `0x${string}`, CONTRACT_BALANCE, false]),
      encodeSwapExactInSingle(poolKey, zeroForOne, OPEN_DELTA, amountOutMinimum),
      encodeCurrencyAmount(token, amountOutMinimum),
    ],
  );
  return { commands: toHex(new Uint8Array([Commands.WRAP_ETH, Commands.V3_SWAP_EXACT_IN, Commands.V4_SWAP])), inputs: [wrap, v3, v4] };
}
// Sell out of a pool quoted in something that is not ETH: V4 into the quote
// asset, hand that balance to a V3 path back to WETH, unwrap to the trader.
export function encodeV4SellViaPath(
  poolKey: V4PoolKey, token: string, bridgeToken: string, path: `0x${string}`,
  amountIn: bigint, minBridge: bigint, minOut: bigint, recipient: string,
): Encoded {
  const zeroForOne = poolKey.currency0.toLowerCase() === token.toLowerCase();
  // TAKE (not TAKE_ALL): the quote asset goes to the router itself, where the V3 leg spends it; the swap's
  // amountOutMinimum already holds the minBridge floor, so the take claims the whole open delta
  const v4 = encodeV4Swap(
    [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE],
    [
      encodeSwapExactInSingle(poolKey, zeroForOne, amountIn, minBridge),
      encodeCurrencyAmount(token, amountIn),
      encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [bridgeToken as `0x${string}`, ADDRESS_THIS, OPEN_DELTA]),
    ],
  );
  const v3 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [ADDRESS_THIS, CONTRACT_BALANCE, minOut, path, false],
  );
  const unwrap = encodeCurrencyAmount(recipient, minOut);
  return { commands: toHex(new Uint8Array([Commands.V4_SWAP, Commands.V3_SWAP_EXACT_IN, Commands.UNWRAP_WETH])), inputs: [v4, v3, unwrap] };
}
// pack a V3 route: token | fee | token | fee | token …
export function encodeV3Path(tokens: string[], fees: number[]): `0x${string}` {
  const types: string[] = [], values: (string | number)[] = [];
  tokens.forEach((t, i) => { types.push('address'); values.push(t); if (i < fees.length) { types.push('uint24'); values.push(fees[i]); } });
  return encodePacked(types as never, values as never);
}
export function encodeV4BuyViaUsdg(
  poolKey: V4PoolKey, token: string, weth: string, usdg: string, bridgeFee: number,
  amountIn: bigint, amountOutMinimum: bigint,
): Encoded {
  const wrap = encodeCurrencyAmount(ADDRESS_THIS, amountIn);
  const path = encodePacked(['address', 'uint24', 'address'], [weth as `0x${string}`, bridgeFee, usdg as `0x${string}`]);
  const v3 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [ADDRESS_THIS, amountIn, 0n, path, false],
  );
  const zeroForOne = poolKey.currency0.toLowerCase() === usdg.toLowerCase();
  const v4 = encodeV4Swap(
    [Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE_ALL],
    [
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [usdg as `0x${string}`, CONTRACT_BALANCE, false]),
      encodeSwapExactInSingle(poolKey, zeroForOne, OPEN_DELTA, amountOutMinimum),
      encodeCurrencyAmount(token, amountOutMinimum),
    ],
  );
  return { commands: toHex(new Uint8Array([Commands.WRAP_ETH, Commands.V3_SWAP_EXACT_IN, Commands.V4_SWAP])), inputs: [wrap, v3, v4] };
}

// Buy with native ETH into a pool paired with WETH: wrap into the router, then
// settle the router's WETH balance into V4 and swap. Same shape as the USDG
// route minus the V3 bridge hop.
export function encodeV4BuyViaWeth(
  poolKey: V4PoolKey, token: string, weth: string, amountIn: bigint, amountOutMinimum: bigint,
): Encoded {
  const wrap = encodeCurrencyAmount(ADDRESS_THIS, amountIn);
  const zeroForOne = poolKey.currency0.toLowerCase() === weth.toLowerCase();
  const v4 = encodeV4Swap(
    [Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE_ALL],
    [
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [weth as `0x${string}`, CONTRACT_BALANCE, false]),
      encodeSwapExactInSingle(poolKey, zeroForOne, OPEN_DELTA, amountOutMinimum),
      encodeCurrencyAmount(token, amountOutMinimum),
    ],
  );
  return { commands: toHex(new Uint8Array([Commands.WRAP_ETH, Commands.V4_SWAP])), inputs: [wrap, v4] };
}

// Sell the token back to its pair currency (native ETH, WETH or USDG). The router
// pulls the token from the wallet through Permit2 (SETTLE_ALL, payer = user),
// so the wallet needs an ERC-20 allowance to Permit2 and a Permit2 allowance to
// the Universal Router first — see ensurePermit2 in background.
export function encodeV4Sell(poolKey: V4PoolKey, token: string, pairCurrency: string, amountIn: bigint, amountOutMinimum: bigint): Encoded {
  const zeroForOne = poolKey.currency0.toLowerCase() === token.toLowerCase();
  const v4 = encodeV4Swap(
    [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL],
    [
      encodeSwapExactInSingle(poolKey, zeroForOne, amountIn, amountOutMinimum),
      encodeCurrencyAmount(token, amountIn),
      encodeCurrencyAmount(pairCurrency, amountOutMinimum),
    ],
  );
  return { commands: toHex(new Uint8Array([Commands.V4_SWAP])), inputs: [v4] };
}

export function v4PairCurrency(poolKey: V4PoolKey, token: string): `0x${string}` {
  return (poolKey.currency0.toLowerCase() === token.toLowerCase() ? poolKey.currency1 : poolKey.currency0) as `0x${string}`;
}
