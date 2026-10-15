// Standard (standardreserve.xyz) on Robinhood Chain: what a trade signs.
//
//   on the curve : the Standard router — buyExactIn(curve, ETH, amountIn, 0, minTokensOut, me, no referrer, no fee) with
//                  the ETH as msg.value (the router swaps it into the curve's stock), sellExactIn(curve, tokens, ETH,
//                  minPayout, me, …) behind an approve of the coin to the CURVE (the curve pulls it, not the router)
//   graduated    : the Universal Router, one V4 multi-hop ETH → USDG → stock → coin (and back), actions SWAP_EXACT_IN,
//                  SETTLE_ALL, TAKE_ALL; the stock's pool and the ETH/USDG pool are the ones the app routes through
// Verified 2026-10-14 by eth_call / eth_simulateV1 on mainnet (nothing sent): GOLD 0x46ee…ad69 on its curve — 0.002 ETH
// buys 464,540 GOLD, a quarter of a holder's 6.4M sells for 0.00668 ETH; SHOUSE 0x77a1…373d graduated — the router refuses
// it (CurveGraduated), the Universal Router path buys 167,216 SHOUSE for 0.002 ETH and sells them back for 0.001944 ETH
// (the V4 quoter agrees), on this Universal Router with the classic ExactInputParams (no maxHopSlippage). Pure.
import { encodeAbiParameters } from 'viem';
import type { V4PoolKey } from './evmV4Router';

export type StdHop = { fee: number; tickSpacing: number; hooks: `0x${string}` };
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const lc = (a: string) => a.toLowerCase();
const SPCX_POOL: StdHop = { fee: 8388608, tickSpacing: 60, hooks: '0xc15b155a3094934171a15625d1a80aba267b6080' };
export const STANDARD = {
  factory: '0x3d6ea4e97b8ab9e1a1b4943febffe22d8c920091' as `0x${string}`,
  router: '0x190b452d16e12e3beedd76a030ea991fe3856c33' as `0x${string}`,
  hook: '0x048f2dc8a71a0321b5e119cd577c56d0190920cc' as `0x${string}`,
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as `0x${string}`,
  // the stocks a Standard coin can be quoted in, each with its USDG pool (the app's own config)
  stocks: {
    '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': SPCX_POOL,   // SPCX
    '0xad25ac6c84d497db898fa1e8387bf6af3532a1c4': SPCX_POOL,   // BABA (same fee / spacing / hook)
    '0x84cab63bc87912e71ad199ff14a0ba45de68fef8': SPCX_POOL,   // SKHY
  } as Record<string, StdHop>,
  ethPool: { fee: 500, tickSpacing: 10, hooks: ZERO } as StdHop,   // ETH / USDG
};
export const NO_FEE = { recipient: ZERO as `0x${string}`, bps: 0 };
export const STANDARD_ROUTER_ABI = [
  { name: 'buyExactIn', type: 'function', stateMutability: 'payable', inputs: [{ name: 'curve', type: 'address' }, { name: 'payAsset', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minStockOut', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'referrer', type: 'address' }, { name: 'fee', type: 'tuple', components: [{ name: 'recipient', type: 'address' }, { name: 'bps', type: 'uint16' }] }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { name: 'sellExactIn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'curve', type: 'address' }, { name: 'tokensIn', type: 'uint256' }, { name: 'payoutAsset', type: 'address' }, { name: 'minPayout', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'referrer', type: 'address' }, { name: 'fee', type: 'tuple', components: [{ name: 'recipient', type: 'address' }, { name: 'bps', type: 'uint16' }] }], outputs: [{ name: 'payout', type: 'uint256' }] },
] as const;
export const STANDARD_FACTORY_ABI = [
  { name: 'curveOfToken', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'address' }] },
] as const;
export const STANDARD_CURVE_ABI = [
  { name: 'graduated', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'stock', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'poolKey', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
] as const;
const PATH_KEY = [{ name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }] as const;
export const V4_QUOTER_PATH_ABI = [{
  name: 'quoteExactInput', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'exactCurrency', type: 'address' }, { name: 'path', type: 'tuple[]', components: PATH_KEY }, { name: 'exactAmount', type: 'uint128' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const;

export type PathKey = { intermediateCurrency: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}`; hookData: `0x${string}` };
const hop = (currency: string, k: StdHop): PathKey => ({ intermediateCurrency: lc(currency) as `0x${string}`, fee: k.fee, tickSpacing: k.tickSpacing, hooks: lc(k.hooks) as `0x${string}`, hookData: '0x' });
const poolHop = (currency: string, pk: V4PoolKey): PathKey => hop(currency, { fee: pk.fee, tickSpacing: pk.tickSpacing, hooks: pk.hooks });
// the graduated coin's path from ETH (buy) or to ETH (sell), every hop a known pool
export function standardPath(side: 'buy' | 'sell', token: string, stock: string, poolKey: V4PoolKey, stockPool: StdHop, ethPool: StdHop, usdg: string = STANDARD.usdg): PathKey[] {
  return side === 'buy'
    ? [hop(usdg, ethPool), hop(stock, stockPool), poolHop(token, poolKey)]
    : [poolHop(stock, poolKey), hop(usdg, stockPool), hop(ZERO, ethPool)];
}
const EXACT_IN_PARAMS = [{ type: 'tuple', components: [{ name: 'currencyIn', type: 'address' }, { name: 'path', type: 'tuple[]', components: PATH_KEY }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }] }] as const;
const V4_SWAP = 0x10, SWAP_EXACT_IN = 0x07, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f;
const ADDR_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const;
// Universal Router V4_SWAP: SWAP_EXACT_IN over the path, SETTLE_ALL what goes in (ETH as msg.value, or the coin through
// Permit2), TAKE_ALL what comes out — to the caller
export function encodeStandardSwap(currencyIn: string, path: PathKey[], amountIn: bigint, amountOutMinimum: bigint): { commands: `0x${string}`; inputs: `0x${string}`[] } {
  const out = path[path.length - 1].intermediateCurrency;
  const actions = ('0x' + [SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
  const params = [
    encodeAbiParameters(EXACT_IN_PARAMS, [{ currencyIn: lc(currencyIn) as `0x${string}`, path, amountIn, amountOutMinimum }]),
    encodeAbiParameters(ADDR_AMOUNT, [lc(currencyIn) as `0x${string}`, amountIn]),
    encodeAbiParameters(ADDR_AMOUNT, [out, amountOutMinimum]),
  ];
  return { commands: ('0x' + V4_SWAP.toString(16)) as `0x${string}`, inputs: [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])] };
}
export const sameHop = (a: StdHop | undefined, b: StdHop | undefined) => !!a && !!b && Number(a.fee) === Number(b.fee) && Number(a.tickSpacing) === Number(b.tickSpacing) && lc(a.hooks) === lc(b.hooks);
