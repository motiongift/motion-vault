// One USD balance — the buy straight from the reserve on EVM (owner 2026-10-29: «давай делай и все что там осталось выкатывай
// тоже тогда»). Pure: which ONE call the reserve R signs for a market (the float's own router, recipient W), the simulation
// probe the vault runs on that exact call before it signs (an eth_call with the probe's code at R's address), and the
// checks on what the probe saw. webEngine usdBuyEvm runs them; nothing here holds a key or touches the network.
//   V3 pools (Uniswap V3 / Pons graduates on Robinhood, PancakeSwap V3 on BNB): multicall(deadline, [exactInput]) along
//     stable → (wrapped → bridge hops) → coin;
//   V2 pairs (PancakeSwap V2 on BNB: four.meme / Flap after listing): multicall(deadline, [exactInputSingle stable → wrapped
//     kept in the router, swapExactTokensForTokens(contract balance, path, W)]);
//   V4 pools on Robinhood (graduated Pons V2 behind its launcher hook, hookless pools): the Universal Router — USDG pulled
//     from R through Permit2, USDG → WETH on V3 into the router, unwrapped when the pool pairs native, settled into V4, the
//     coin taken straight to W (R's ERC-20 allowance to Permit2 and Permit2's to the router: background, never on a click);
//   bonding curves (four.meme, Flap, genius, Pons): the UsdBuyRouter contract once deployed (USD_BUY_ROUTER), else not yet.
// The router pulls only from msg.sender (R): R's standing allowance to it is set in the background (floatEngine), never on a
// click. Anything else (V4 / Infinity pools, other quote tokens, a router this build does not name) is "not available yet":
// the page keeps its hold & fire for it.
import { encodeFunctionData, decodeFunctionResult, decodeAbiParameters, encodeAbiParameters, toHex, type Hex } from 'viem';
import { FLOAT_CFG, type EvmFloatCfg } from './floatCore.ts';
import { V3_FEES } from './floatDirect.ts';
// read-only imports of the V4 module's constants (the module itself is untouched)
import { UNIVERSAL_ROUTER, PERMIT2, NATIVE_CURRENCY, CONTRACT_BALANCE, OPEN_DELTA, Commands, Actions, UNIVERSAL_ROUTER_ABI, KNOWN_LAUNCHER_HOOKS, MAX_UINT160 } from './evmV4Router.ts';

export type EvmChain = 'robinhood' | 'bsc';
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;
// the V2 routers the indexer may name, per chain, and the float router that runs the V2 leg (it is bound to the same V2 factory)
export const V2_ROUTERS: Record<EvmChain, string[]> = { robinhood: [], bsc: ['0x10ed43c718714eb63d5aa57b78b54704e256024e'] };
export class DirectUnsupported extends Error { name = 'DirectUnsupported'; }
const NOT_YET = 'A buy straight from the USD balance is not available for this market yet';
const lc = (a: string) => String(a || '').toLowerCase();
const isAddr = (a: unknown): a is Hex => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInput', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
] as const;

/** The market as the vault's own route names it (webEngine Route, the fields used here). */
export type V4Key = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
export type EvmRoute = { type: string; fee?: number; quoteToken?: string; bridgeHops?: string[]; bridgeFees?: number[]; router?: string; path?: string[]; poolKey?: V4Key; pair?: string;
  manager?: string; portal?: string; nativeToQuote?: boolean; curve?: string; pairToken?: string };
// spender: who R's stable allowance must name (the router itself, or Permit2 for the Universal Router); permit2: the Universal
// Router also needs Permit2's own allowance (owner R, token the stable, spender the router)
// router: a contract this plan relies on that the vault checks once per session before it signs (code hash + allow-list entry)
export type EvmPlan = { kind: 'v3' | 'v2' | 'v4' | 'curve'; to: Hex; spender: Hex; permit2?: { token: Hex; spender: Hex }; build: (minOut: bigint) => Hex; hops: string[];
  router?: { address: Hex; codeHash: Hex; venue: Hex; selector: Hex; spec: readonly [number, number, number, number, boolean] } };

// ── bonding curves: UsdBuyRouter (B:\tmp\float-direct\contracts, AUDIT.md) ──
// Its address on each chain is the deployer's first creation (0xf0e0…5c2e, nonce 0): the vault uses it only once the code there
// hashes to the runtime the audited source compiles to with that chain's immutables (stable, wrapped, swap router, fee) and the
// venue's allow-list entry reads back as below — until then (not deployed) a curve buy is "not available" and keeps the hold.
// The entries are deploy/venues.mjs, byte for byte: [amountOffset, recipientOffset, tokenOffset, nativeOffset, ponsFactory].
// The code hashes include the immutable RESCUE (the owner's 0x390c4a6181de917776cd62dbab69ea2b1b28260d, 2026-10-29): stray funds in
// the router can go there only. A new RESCUE = a new runtime = new hashes here (contracts/deploy/expected-hash.mjs prints them).
export const CURVE_RESCUE = '0x390c4a6181de917776cd62dbab69ea2b1b28260d';
// the most one buy may spend through the curve router, in dollars per wallet (owner 2026-10-29): above it the page keeps the hold
// (top-up, then the wallet's own buy). Raised here, in the vault, without touching the contract.
export const CURVE_BUY_MAX_USD = 100;
export const CURVE_ROUTER: Record<EvmChain, { address: Hex; codeHash: Hex; four?: Hex; flap?: Hex; pons?: Hex }> = {
  bsc: { address: '0xa8acf7f8cd54ae6bf695d8e08d17a4b752c27ba7', codeHash: '0x968baa2ae212c0e00a2b9c38bb267006d44276e37bc92ecf85808f4629ed91d7',
    four: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', flap: '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', pons: '0x78eae9537c0ef90dfe9b7ae964682fe8138afe31' },
  robinhood: { address: '0xa8acf7f8cd54ae6bf695d8e08d17a4b752c27ba7', codeHash: '0x58f949c860227eeb6efb804e5eea9219ff5b6373a21e9e471d1a5413bfa4245d',
    pons: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' },
};
export const CURVE_SEL = { four: '0x7f79f6df', flap: '0xef7ec2e7', pons: '0x59a87bc1' } as const;
export const CURVE_SPEC = { four: [68, 36, 4, 0, false], flap: [100, 0, 68, 36, false], pons: [4, 68, 0, 0, true] } as const;
export const USD_BUY_ROUTER_ABI = [
  { name: 'buy', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'tuple', components: [
    { name: 'token', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'stableIn', type: 'uint256' }, { name: 'minNative', type: 'uint256' },
    { name: 'venue', type: 'address' }, { name: 'venueData', type: 'bytes' }, { name: 'minTokens', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }], outputs: [{ name: 'got', type: 'uint256' }] },
  { name: 'specOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'venue', type: 'address' }, { name: 'selector', type: 'bytes4' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'venue', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'amountOffset', type: 'uint16' }, { name: 'recipientOffset', type: 'uint16' }, { name: 'tokenOffset', type: 'uint16' }, { name: 'nativeOffset', type: 'uint16' }, { name: 'ponsFactory', type: 'bool' }] }] },
] as const;
const CURVE_ABI = [
  { name: 'buyTokenAMAP', type: 'function', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'to', type: 'address' }, { name: 'funds', type: 'uint256' }, { name: 'minAmount', type: 'uint256' }], outputs: [] },
  { name: 'swapExactInput', type: 'function', stateMutability: 'payable', inputs: [{ name: 'p', type: 'tuple', components: [{ name: 'inputToken', type: 'address' }, { name: 'outputToken', type: 'address' }, { name: 'inputAmount', type: 'uint256' }, { name: 'minOutputAmount', type: 'uint256' }, { name: 'permitData', type: 'bytes' }] }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'buy', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
] as const;

/** stable → … → coin on V3, as tokens and fees (the stable first, the coin last), or null when this build has no path. */
export function v3PathFor(route: EvmRoute, cfg: EvmFloatCfg, coin: string): { tokens: Hex[]; fees: number[] } | null {
  const stable = lc(cfg.stable.address), wrapped = lc(cfg.wrapped), quote = lc(route.quoteToken || ''), fee = Number(route.fee);
  if (!(V3_FEES as readonly number[]).includes(fee) || !isAddr(coin)) return null;
  if (quote === stable) return { tokens: [stable, lc(coin)] as Hex[], fees: [fee] };
  if (quote === wrapped) return { tokens: [stable, wrapped, lc(coin)] as Hex[], fees: [cfg.swapFee, fee] };
  const hops = (route.bridgeHops || []).map(lc), fees = (route.bridgeFees || []).map(Number);
  if (hops.length < 2 || hops[0] !== wrapped || hops[hops.length - 1] !== quote || fees.length !== hops.length - 1 || fees.some((f) => !(V3_FEES as readonly number[]).includes(f))) return null;
  const k = hops.indexOf(stable);
  const tokens = k >= 0 ? [...hops.slice(k), lc(coin)] : [stable, ...hops, lc(coin)];
  const path = k >= 0 ? [...fees.slice(k), fee] : [cfg.swapFee, ...fees, fee];
  if (tokens.length > 5 || new Set(tokens).size !== tokens.length || !tokens.every(isAddr)) return null;
  return { tokens: tokens as Hex[], fees: path };
}
const packPath = (tokens: string[], fees: number[]) => { let p = '0x'; tokens.forEach((t, i) => { p += t.slice(2).toLowerCase(); if (i < fees.length) p += fees[i].toString(16).padStart(6, '0'); }); return p as Hex; };

/** The ONE call R signs for this market, or DirectUnsupported. `minOut` is filled in after the quote. */
export function evmDirectPlan(o: { chain: EvmChain; route: EvmRoute; coin: string; amountIn: bigint; recipient: string; deadline: bigint; minNative?: bigint }): EvmPlan {
  const cfg = FLOAT_CFG[o.chain];
  if (!(o.amountIn > 0n) || !isAddr(o.recipient) || /^0x0{40}$/.test(o.recipient) || !isAddr(o.coin)) throw new DirectUnsupported('Bad USD buy');
  const coin = lc(o.coin), stable = lc(cfg.stable.address), wrapped = lc(cfg.wrapped), router = lc(cfg.router) as Hex, recipient = lc(o.recipient) as Hex;
  void NATIVE_CURRENCY;
  if (coin === stable || coin === wrapped) throw new DirectUnsupported(NOT_YET);
  const r = o.route;
  if (r.type === 'v3') {
    const p = v3PathFor(r, cfg, coin); if (!p) throw new DirectUnsupported(NOT_YET);
    const path = packPath(p.tokens, p.fees);
    return { kind: 'v3', to: router, spender: router, hops: p.tokens, build: (minOut) => encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [o.deadline, [
      encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInput', args: [{ path, recipient, amountIn: o.amountIn, amountOutMinimum: minOut }] })]] }) };
  }
  if (r.type === 'v2') {
    const path = (r.path || []).map(lc);
    if (!V2_ROUTERS[o.chain].includes(lc(r.router || '')) || path.length < 2 || path.length > 4 || path[path.length - 1] !== coin || !path.every(isAddr) || new Set(path).size !== path.length) throw new DirectUnsupported(NOT_YET);
    if (path[0] === stable) {
      return { kind: 'v2', to: router, spender: router, hops: path, build: (minOut) => encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [o.deadline, [
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [o.amountIn, minOut, path as Hex[], recipient] })]] }) };
    }
    if (path[0] !== wrapped || (path as string[]).includes(stable)) throw new DirectUnsupported(NOT_YET);
    // the stable → wrapped leg on the float's own V3 pool, kept in the router (ADDRESS_THIS); the V2 leg spends the router's
    // balance (amountIn 0 = CONTRACT_BALANCE) and pays W; the floor is on the coin (the intermediate leg has none of its own)
    return { kind: 'v2', to: router, spender: router, hops: [stable, ...path], build: (minOut) => encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [o.deadline, [
      encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: stable as Hex, tokenOut: wrapped as Hex, fee: cfg.swapFee, recipient: ADDRESS_THIS, amountIn: o.amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [0n, minOut, path as Hex[], recipient] })]] }) };
  }
  // a bonding curve through UsdBuyRouter: four.meme / Flap (BNB-quoted only) and the Pons family (native pairs only)
  if (r.type === 'four' || r.type === 'flap' || r.type === 'pons') {
    const cr = CURVE_ROUTER[o.chain]; const ZERO = '0x0000000000000000000000000000000000000000';
    let fam: 'four' | 'flap' | 'pons'; let venue: string | undefined; let data: Hex;
    if (r.type === 'four') { fam = 'four'; venue = cr.four; if (lc(r.manager || '') !== venue || lc(r.quoteToken || '') !== ZERO) throw new DirectUnsupported(NOT_YET); data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'buyTokenAMAP', args: [coin as Hex, recipient, 0n, 0n] }); }
    else if (r.type === 'flap') { fam = 'flap'; venue = cr.flap; if (lc(r.portal || '') !== venue || lc(r.quoteToken || '') !== ZERO || r.nativeToQuote) throw new DirectUnsupported(NOT_YET); data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'swapExactInput', args: [{ inputToken: ZERO, outputToken: coin as Hex, inputAmount: 0n, minOutputAmount: 0n, permitData: '0x' }] }); }
    else { fam = 'pons'; venue = cr.pons; if (!venue || lc(r.pairToken || ZERO) !== ZERO) throw new DirectUnsupported(NOT_YET); data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'buy', args: [0n, 0n, recipient] }); }
    if (!venue) throw new DirectUnsupported(NOT_YET);
    const minNative = o.minNative && o.minNative > 0n ? o.minNative : 1n;
    return { kind: 'curve', to: cr.address, spender: cr.address, hops: [stable, wrapped, NATIVE_CURRENCY, coin],
      router: { address: cr.address, codeHash: cr.codeHash, venue: venue as Hex, selector: CURVE_SEL[fam], spec: CURVE_SPEC[fam] },
      build: (minOut) => encodeFunctionData({ abi: USD_BUY_ROUTER_ABI, functionName: 'buy', args: [{ token: coin as Hex, recipient, stableIn: o.amountIn, minNative, venue: venue as Hex, venueData: data, minTokens: minOut, deadline: o.deadline }] }) };
  }
  if (r.type === 'v4' && o.chain === 'robinhood') {
    const k = r.poolKey; const pair = r.pair;
    if (!k || !isAddr(k.currency0) || !isAddr(k.currency1) || !isAddr(k.hooks)) throw new DirectUnsupported(NOT_YET);
    const c0 = lc(k.currency0), c1 = lc(k.currency1), hooks = lc(k.hooks);
    if (hooks !== NATIVE_CURRENCY && !KNOWN_LAUNCHER_HOOKS.map(lc).includes(hooks)) throw new DirectUnsupported(NOT_YET);
    const quote = pair === 'native' ? NATIVE_CURRENCY : pair === 'weth' ? wrapped : pair === 'usdg' ? stable : '';
    if (!quote || !((c0 === quote && c1 === coin) || (c1 === quote && c0 === coin))) throw new DirectUnsupported(NOT_YET);
    const poolKey = { currency0: c0 as Hex, currency1: c1 as Hex, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: hooks as Hex };
    const zeroForOne = c0 === quote;
    const take = encodeCurrencyAmount3(coin, recipient, OPEN_DELTA);
    const build = (minOut: bigint): Hex => {
      let cmds: number[], inputs: Hex[];
      if (pair === 'usdg') {
        // one V4 hop paid in USDG: the swap, the router pays the pool its USDG from R through Permit2, the coin to W
        cmds = [Commands.V4_SWAP];
        inputs = [encodeV4Swap([Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE], [encodeSwapExactInSingle(poolKey, zeroForOne, o.amountIn, minOut), encodeCurrencyAmount(stable, o.amountIn), take])];
      } else {
        // USDG → WETH on the float's V3 pool into the router (payer R through Permit2), unwrapped when the pool pairs native,
        // settled from the router's balance, swapped from the open credit, the coin taken to W
        const v3 = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [ADDRESS_THIS, o.amountIn, 0n, packPath([stable, wrapped], [cfg.swapFee]), true]);
        const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [quote as Hex, CONTRACT_BALANCE, false]);
        const v4 = encodeV4Swap([Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE], [settle, encodeSwapExactInSingle(poolKey, zeroForOne, OPEN_DELTA, minOut), take]);
        cmds = pair === 'native' ? [Commands.V3_SWAP_EXACT_IN, Commands.UNWRAP_WETH, Commands.V4_SWAP] : [Commands.V3_SWAP_EXACT_IN, Commands.V4_SWAP];
        inputs = pair === 'native' ? [v3, encodeCurrencyAmount(ADDRESS_THIS, 0n), v4] : [v3, v4];
      }
      return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [toHex(new Uint8Array(cmds)), inputs, o.deadline] });
    };
    return { kind: 'v4', to: lc(UNIVERSAL_ROUTER) as Hex, spender: lc(PERMIT2) as Hex, permit2: { token: stable as Hex, spender: lc(UNIVERSAL_ROUTER) as Hex }, hops: pair === 'usdg' ? [stable, coin] : [stable, wrapped, ...(pair === 'native' ? [NATIVE_CURRENCY] : []), coin], build };
  }
  throw new DirectUnsupported(NOT_YET);
}
// V4 action encodings (the same as src/evmV4Router.ts, which keeps them private)
const POOL_KEY = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] as const;
const encodeSwapExactInSingle = (poolKey: { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex }, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint): Hex =>
  encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }]);
const encodeV4Swap = (actions: number[], params: Hex[]): Hex => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
const encodeCurrencyAmount = (currency: string, amount: bigint): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency as Hex, amount]);
const encodeCurrencyAmount3 = (currency: string, to: string, amount: bigint): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency as Hex, to as Hex, amount]);
/** Permit2's allowance call R signs in the background for the Universal Router (the whole uint160, ~1 year). */
export const PERMIT2_APPROVE_ABI = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] }] as const;
export const PERMIT2_ALLOWANCE_ABI = [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }] as const;
export const permit2ApproveData = (token: Hex, spender: Hex, nowSec: number): Hex => encodeFunctionData({ abi: PERMIT2_APPROVE_ABI, functionName: 'approve', args: [token, spender, MAX_UINT160, nowSec + 365 * 86_400] });
/** The amount out: a multicall's last answer (V3 / V2), or for the Universal Router (no answer) the coin W received. */
export function routerOut(ret: Hex, coinGot?: bigint): bigint {
  if (!ret || ret === '0x') return coinGot ?? 0n;
  if (ret.length === 66) return BigInt(ret);   // UsdBuyRouter.buy returns what W got
  const outs = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', data: ret }) as readonly Hex[];
  const last = outs[outs.length - 1]; return last && last.length >= 66 ? BigInt(last.slice(0, 66)) : 0n;
}
/** The floor R signs: the quote less the user's slippage (never the price guard's business). */
export const minOutOf = (quote: bigint, slippagePct: number): bigint => { const bps = BigInt(Math.max(1, Math.min(5000, Math.round(slippagePct * 100)))); const m = (quote * (10_000n - bps)) / 10_000n; return m > 0n ? m : 1n; };

// ── the probe (contracts/UsdBuyProbe.sol, solc 0.8.30, viaIR, runs 200, paris, no metadata hash; NEVER deployed) ──
export const PROBE_RUNTIME: Hex = '0x6080604052600436101561001257600080fd5b60003560e01c6319f04fd41461002757600080fd5b346100cf576101003660031901126100cf576100416100d4565b6100496100ea565b60443567ffffffffffffffff81116100cf57366023820112156100cf5780600401359167ffffffffffffffff83116100cf5736602484840101116100cf576100cb936100bf93610097610100565b61009f610116565b916100a861012c565b936100b1610142565b95602460e4359801916103db565b60405191829182610199565b0390f35b600080fd5b600435906001600160a01b03821682036100cf57565b602435906001600160a01b03821682036100cf57565b606435906001600160a01b03821682036100cf57565b608435906001600160a01b03821682036100cf57565b60a435906001600160a01b03821682036100cf57565b60c435906001600160a01b03821682036100cf57565b919082519283825260005b848110610184575050826000602080949584010152601f8019910116010190565b80602080928401015182828601015201610163565b6102206101e0610264936020845280516020850152602081015160408501526040810151606085015260608101516080850152608081015160a085015260a081015160c085015260c081015160e085015260e08101516101008501526101008101516101208501526101208101516101408501526101408101516101608501526101608101516101808501526101808101516101a08501526102476101a08201516101c086019060ff169052565b6101c0810151151584830152015191610200808201520190610158565b90565b634e487b7160e01b600052604160045260246000fd5b90601f8019910116810190811067ffffffffffffffff82111761029f57604052565b610267565b604051906102b46102008361027d565b565b6102be6102a4565b906000825260006020830152600060408301526000606083015260006080830152600060a0830152600060c0830152600060e08301526000610100830152600061012083015260006101408301526000610160830152600061018083015260006101a083015260006101c083015260606101e0830152565b908160209103126100cf575190565b6040513d6000823e3d90fd5b908160209103126100cf575160ff811681036100cf5790565b908092918237016000815290565b3d156103b3573d9067ffffffffffffffff821161029f57604051916103a7601f8201601f19166020018461027d565b82523d6000602084013e565b606090565b919082039182116103c557565b634e487b7160e01b600052601160045260246000fd5b91959897939896949661042660206103f16102b6565b604051636eb1769f60e11b81523060048201526001600160a01b039586166024820152909c9094169391829081906044820190565b0381865afa90811561078957600091610910575b508a5260405163313ce56760e01b81526001600160a01b03919091169490602081600481895afa600091816108df575b506108d1575060126101a08b01525b8951106108c8576040516370a0823160e01b815230600482015295602087602481855afa968715610789576000976108a7575b506040516370a0823160e01b81526001600160a01b038716600482015297602089602481895afa98891561078957600099610886575b504760608c0152863160a08c01526040516370a0823160e01b81526001600160a01b0385166004820152602081602481875afa90811561078957600091610867575b5060e08c01526040516370a0823160e01b81526001600160a01b038581166004830152919091169490602081602481895afa90811561078957600091610848575b506101208c01526040516370a0823160e01b81526001600160a01b0385166004820152906020826024818a5afa928315610789576000938d85948592610823575b5061016001526105bb6040518093819361036a565b039082865af16105c9610378565b901561081b5760016101c08b01526101e08a01526040516370a0823160e01b815230600482015294602086602481855afa958615610789576000966107fa575b506040516370a0823160e01b81526001600160a01b0382166004820152602081602481895afa908115610789576000916107db575b50868811156107d35761065187896103b8565b985b60208c01998a52808211156107ca5761066b916103b8565b60408b8101919091524760808c0152903160c08b0152516370a0823160e01b81526001600160a01b038316600482015290602090829060249082905afa908115610789576000916107ab575b506101008901526040516370a0823160e01b81526001600160a01b038216600482015291602090839060249082905afa928315610789576107319360209360009161078e575b506101408a01526040516370a0823160e01b81526001600160a01b0390921660048301529092839190829081906024820190565b03915afa9081156107895760009161075a575b50610180860152116107535750565b6000199052565b61077c915060203d602011610782575b610774818361027d565b810190610336565b38610744565b503d61076a565b610345565b6107a59150843d861161078257610774818361027d565b386106fd565b6107c4915060203d60201161078257610774818361027d565b386106b7565b5050600061066b565b600098610653565b6107f4915060203d60201161078257610774818361027d565b3861063e565b61081491965060203d60201161078257610774818361027d565b9438610609565b602081519101fd5b6101609192506108419060203d60201161078257610774818361027d565b91906105a6565b610861915060203d60201161078257610774818361027d565b38610565565b610880915060203d60201161078257610774818361027d565b38610524565b6108a091995060203d60201161078257610774818361027d565b97386104e2565b6108c191975060203d60201161078257610774818361027d565b95386104ac565b50505050505050565b60ff166101a08b0152610479565b61090291925060203d602011610909575b6108fa818361027d565b810190610351565b903861046a565b503d6108f0565b610929915060203d60201161078257610774818361027d565b3861043a56fea164736f6c634300081e000a';
const SEEN = { type: 'tuple', components: [
  { name: 'allowance', type: 'uint256' }, { name: 'stableSpent', type: 'uint256' }, { name: 'coinGot', type: 'uint256' },
  { name: 'rNativeBefore', type: 'uint256' }, { name: 'rNativeAfter', type: 'uint256' }, { name: 'wNativeBefore', type: 'uint256' }, { name: 'wNativeAfter', type: 'uint256' },
  { name: 'routerStableBefore', type: 'uint256' }, { name: 'routerStableAfter', type: 'uint256' }, { name: 'routerWrappedBefore', type: 'uint256' }, { name: 'routerWrappedAfter', type: 'uint256' },
  { name: 'routerCoinBefore', type: 'uint256' }, { name: 'routerCoinAfter', type: 'uint256' }, { name: 'decimals', type: 'uint8' }, { name: 'called', type: 'bool' }, { name: 'ret', type: 'bytes' }] } as const;
export const PROBE_ABI = [{ name: 'probe', type: 'function', stateMutability: 'nonpayable', inputs: [
  { name: 'router', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'stable', type: 'address' }, { name: 'wrapped', type: 'address' },
  { name: 'coin', type: 'address' }, { name: 'w', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ name: 's', ...SEEN }] }] as const;
export type Seen = { allowance: bigint; stableSpent: bigint; coinGot: bigint; rNativeBefore: bigint; rNativeAfter: bigint; wNativeBefore: bigint; wNativeAfter: bigint;
  routerStableBefore: bigint; routerStableAfter: bigint; routerWrappedBefore: bigint; routerWrappedAfter: bigint; routerCoinBefore: bigint; routerCoinAfter: bigint; decimals: number; called: boolean; ret: Hex };
export function probeCall(o: { plan: EvmPlan; chain: EvmChain; coin: string; w: string; amountIn: bigint }): Hex {
  const cfg = FLOAT_CFG[o.chain];
  return encodeFunctionData({ abi: PROBE_ABI, functionName: 'probe', args: [o.plan.to, o.plan.spender, o.plan.build(1n), cfg.stable.address as Hex, cfg.wrapped as Hex, lc(o.coin) as Hex, lc(o.w) as Hex, o.amountIn] });
}
export const decodeProbe = (ret: Hex): Seen => (decodeAbiParameters([SEEN], ret)[0] as unknown) as Seen;

/**
 * What the probe saw must be exactly this buy: R's allowance covers it; R's stable down by EXACTLY the amount; W's coin up;
 * R's and W's native untouched; nothing left in the router (its stable, wrapped native and coin balances as they were).
 * '' = fine, else why not.
 */
export function evmDirectGuard(s: Seen, amountIn: bigint): string {
  if (s.allowance < amountIn || !s.called) return 'allowance';
  if (s.stableSpent !== amountIn) return 'it would take another amount of the stable than the buy';
  if (!(s.coinGot > 0n)) return 'it would not deliver the coin to the trading wallet';
  if (s.rNativeAfter !== s.rNativeBefore) return 'it would move the reserve\'s native coin';
  if (s.wNativeAfter < s.wNativeBefore) return 'it would take the trading wallet\'s native coin';   // a curve's refund may ADD to W
  if (s.routerStableAfter !== s.routerStableBefore || s.routerWrappedAfter !== s.routerWrappedBefore || s.routerCoinAfter > s.routerCoinBefore) return 'it would leave funds in the router';
  if (!(routerOut(s.ret, s.coinGot) > 0n)) return 'the router returned nothing';
  return '';
}
/**
 * motion's own market price (USD per whole coin) against what the route is EXPECTED to deliver (the quote, never the floor
 * after the user's slippage: a 30 % slippage setting must not trip it): under 70 % of fair is refused; no price = the buy goes
 * (bounded by the amount), as for every buy.
 */
export function evmPriceCheck(o: { usdIn: number; expectedOut: bigint; decimals: number; priceUsd: number | null }): string {
  if (o.priceUsd == null || !(o.priceUsd > 0) || !(o.usdIn > 0)) return '';
  const fair = (o.usdIn / o.priceUsd) * 10 ** o.decimals;
  return Number(o.expectedOut) < fair * 0.7 ? 'the route pays far less than the market price' : '';
}
