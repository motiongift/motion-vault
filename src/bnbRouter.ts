// BNB Chain execution: the three launchpads' own entry points and the
// PancakeSwap venues their coins graduate into.
//
//   four.meme  — one TokenManager for every curve: buyTokenAMAP(token, funds,
//                minAmount) payable / sellToken(token, amount); the helper
//                contract answers tryBuy / trySell with the exact msg.value,
//                approval and expected amounts.
//   Flap       — one Portal: swapExactInput({inputToken, outputToken,
//                inputAmount, minOutputAmount, permitData}) payable with
//                address(0) standing for BNB; quoteExactInput for the quote.
//   genius.fun — the Pons V2 curve family (same buy/sell/getReserves as
//                Robinhood's Pons V2), handled by the Pons executor.
//   PancakeSwap V2 pair (Flap / four.meme after listing), V3 pool (SmartRouter,
//   exactInput without deadline), Infinity CL pool (genius after graduation)
//   through PancakeSwap's Universal Router — a fork of Uniswap's, same command
//   and action ids, but the pool key carries the PoolManager and a packed
//   `parameters` word instead of a tick spacing.
// Pure encoders: no window, no chain client.
import { encodeAbiParameters, toHex } from 'viem';

export const BSC = {
  id: 56,
  // Measured from a browser origin (2026-10-14, vault.motion.gift as Origin): all
  // three answer CORS with `*`, serve eth_call / estimateGas / eth_simulateV1 in
  // ~50-70 ms, take 8 parallel heavy calls without a 429, and accept
  // eth_sendRawTransaction. Every signed transaction goes to all three at once:
  // publicnode (public mempool), bloXroute (its BDN), 48 Club (its validators'
  // builder). The NodeReal key that used to be second answers 429 to a burst
  // and to sends ("maximum API usage limit of public").
  rpc: 'https://bsc-rpc.publicnode.com',
  rpcSingle: 'https://bsc.rpc.blxrbdn.com',
  rpc2: 'https://rpc-bsc.48.club',
  explorer: 'https://bscscan.com',
  wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as `0x${string}`,   // WBNB
  stable: '0x55d398326f99059fF775485246999027B3197955' as `0x${string}`,    // USDT (18 decimals)
  // PancakeSwap
  v3Router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as `0x${string}`,  // SmartRouter: exactInput / exactInputSingle, no deadline
  v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as `0x${string}`,
  universalRouter: '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB' as `0x${string}`,   // Infinity-aware Universal Router
  permit2: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768' as `0x${string}`,          // PancakeSwap's Permit2 deployment
  clQuoter: '0xd0737C9762912dD34c3271197E362Aa736Df0926' as `0x${string}`,          // Infinity CLQuoter
  v3Quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as `0x${string}`,          // PancakeSwap V3 QuoterV2: prices a walk back the wallet cannot simulate yet
  clPoolManager: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
  // launchpads
  fourManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as `0x${string}`,
  fourHelper: '0xF251F83e40a78868FcfA3FA4599Dad6494E46034' as `0x${string}`,
  flapPortal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0' as `0x${string}`,
} as const;

export const FOUR_MANAGER_ABI = [
  { name: 'buyTokenAMAP', type: 'function', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'funds', type: 'uint256' }, { name: 'minAmount', type: 'uint256' }], outputs: [] },
  { name: 'sellToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const;
export const FOUR_HELPER_ABI = [
  { name: 'tryBuy', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'funds', type: 'uint256' }],
    outputs: [{ name: 'tokenManager', type: 'address' }, { name: 'quote', type: 'address' }, { name: 'estimatedAmount', type: 'uint256' }, { name: 'estimatedCost', type: 'uint256' }, { name: 'estimatedFee', type: 'uint256' }, { name: 'amountMsgValue', type: 'uint256' }, { name: 'amountApproval', type: 'uint256' }, { name: 'amountFunds', type: 'uint256' }] },
  { name: 'trySell', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'tokenManager', type: 'address' }, { name: 'quote', type: 'address' }, { name: 'funds', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
] as const;
export const FLAP_PORTAL_ABI = [
  { name: 'swapExactInput', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'inputToken', type: 'address' }, { name: 'outputToken', type: 'address' }, { name: 'inputAmount', type: 'uint256' }, { name: 'minOutputAmount', type: 'uint256' }, { name: 'permitData', type: 'bytes' },
    ] }], outputs: [{ name: 'outputAmount', type: 'uint256' }] },
  { name: 'quoteExactInput', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'inputToken', type: 'address' }, { name: 'outputToken', type: 'address' }, { name: 'inputAmount', type: 'uint256' },
    ] }], outputs: [{ name: 'outputAmount', type: 'uint256' }] },
] as const;
export const PANCAKE_V2_ROUTER_ABI = [
  { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { name: 'swapExactETHForTokensSupportingFeeOnTransferTokens', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
  { name: 'swapExactTokensForETHSupportingFeeOnTransferTokens', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
  { name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
] as const;

// ── PancakeSwap Infinity CL ──
export type InfPoolKey = {
  currency0: `0x${string}`; currency1: `0x${string}`; hooks: `0x${string}`; poolManager: `0x${string}`;
  fee: number; parameters: `0x${string}`;
};
const INF_POOL_KEY = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'hooks', type: 'address' },
  { name: 'poolManager', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'parameters', type: 'bytes32' },
] } as const;
// PancakeSwap V3 QuoterV2 (Uniswap's shape): exact-in along a packed path; it reverts internally and returns the amounts
export const V3_QUOTER_ABI = [{
  name: 'quoteExactInput', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96AfterList', type: 'uint160[]' }, { name: 'initializedTicksCrossedList', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const;
export const CL_QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', ...INF_POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const;
// PancakeSwap's Universal Router keeps Uniswap's numbering
const Commands = { V3_SWAP_EXACT_IN: 0x00, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, INFI_SWAP: 0x10 } as const;
const Actions = { CL_SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
const OPEN_DELTA = 0n;
const ZERO = '0x0000000000000000000000000000000000000000';
type Encoded = { commands: `0x${string}`; inputs: `0x${string}`[] };
const swapSingle = (poolKey: InfPoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint) => encodeAbiParameters(
  [{ type: 'tuple', components: [{ name: 'poolKey', ...INF_POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }],
);
const infiSwap = (actions: number[], params: `0x${string}`[]) => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
const currencyAmount = (currency: string, amount: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency as `0x${string}`, amount]);
export const infPairCurrency = (k: InfPoolKey, token: string) => (k.currency0.toLowerCase() === token.toLowerCase() ? k.currency1 : k.currency0) as `0x${string}`;

// BNB → token in a pool paired with native BNB
export function encodeInfBuyNative(k: InfPoolKey, token: string, amountIn: bigint, minOut: bigint): Encoded {
  const zeroForOne = k.currency0.toLowerCase() === ZERO;
  return { commands: toHex(new Uint8Array([Commands.INFI_SWAP])), inputs: [infiSwap(
    [Actions.CL_SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL],
    [swapSingle(k, zeroForOne, amountIn, minOut), currencyAmount(ZERO, amountIn), currencyAmount(token, minOut)],
  )] };
}
// BNB → (wrap) → V3 path to the quote asset (GENIUS, NVDAB, USDT…) held by the
// router → settle that balance into the Infinity pool → token to the trader
export function encodeInfBuyViaPath(k: InfPoolKey, token: string, quote: string, path: `0x${string}`, amountIn: bigint, minOut: bigint): Encoded {
  const wrap = currencyAmount(ADDRESS_THIS, amountIn);
  const v3 = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [ADDRESS_THIS, amountIn, 0n, path, false]);
  const zeroForOne = k.currency0.toLowerCase() === quote.toLowerCase();
  const inf = infiSwap(
    [Actions.SETTLE, Actions.CL_SWAP_EXACT_IN_SINGLE, Actions.TAKE_ALL],
    [encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [quote as `0x${string}`, CONTRACT_BALANCE, false]), swapSingle(k, zeroForOne, OPEN_DELTA, minOut), currencyAmount(token, minOut)],
  );
  return { commands: toHex(new Uint8Array([Commands.WRAP_ETH, Commands.V3_SWAP_EXACT_IN, Commands.INFI_SWAP])), inputs: [wrap, v3, inf] };
}
// BNB → (wrap) → settle WBNB into a pool paired with WBNB
export function encodeInfBuyViaWrapped(k: InfPoolKey, token: string, wrapped: string, amountIn: bigint, minOut: bigint): Encoded {
  const wrap = currencyAmount(ADDRESS_THIS, amountIn);
  const zeroForOne = k.currency0.toLowerCase() === wrapped.toLowerCase();
  const inf = infiSwap(
    [Actions.SETTLE, Actions.CL_SWAP_EXACT_IN_SINGLE, Actions.TAKE_ALL],
    [encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [wrapped as `0x${string}`, CONTRACT_BALANCE, false]), swapSingle(k, zeroForOne, OPEN_DELTA, minOut), currencyAmount(token, minOut)],
  );
  return { commands: toHex(new Uint8Array([Commands.WRAP_ETH, Commands.INFI_SWAP])), inputs: [wrap, inf] };
}
// token → its pair currency (the router pulls the token through Permit2)
export function encodeInfSell(k: InfPoolKey, token: string, pairCurrency: string, amountIn: bigint, minOut: bigint): Encoded {
  const zeroForOne = k.currency0.toLowerCase() === token.toLowerCase();
  return { commands: toHex(new Uint8Array([Commands.INFI_SWAP])), inputs: [infiSwap(
    [Actions.CL_SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL],
    [swapSingle(k, zeroForOne, amountIn, minOut), currencyAmount(token, amountIn), currencyAmount(pairCurrency, minOut)],
  )] };
}
// token → quote asset into the router → V3 path back to WBNB → unwrap to the trader
export function encodeInfSellViaPath(k: InfPoolKey, token: string, quote: string, path: `0x${string}`, amountIn: bigint, minBridge: bigint, minOut: bigint, recipient: string): Encoded {
  const zeroForOne = k.currency0.toLowerCase() === token.toLowerCase();
  const inf = infiSwap(
    [Actions.CL_SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL],
    [swapSingle(k, zeroForOne, amountIn, minBridge), currencyAmount(token, amountIn), currencyAmount(quote, minBridge)],
  );
  const v3 = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [ADDRESS_THIS, CONTRACT_BALANCE, minOut, path, false]);
  const unwrap = currencyAmount(recipient, minOut);
  return { commands: toHex(new Uint8Array([Commands.INFI_SWAP, Commands.V3_SWAP_EXACT_IN, Commands.UNWRAP_WETH])), inputs: [inf, v3, unwrap] };
}
