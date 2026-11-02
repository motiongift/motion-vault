// One USD balance — the buy straight from the reserve (owner 2026-10-29: «давай делай это все»; design: B:\tmp\float-direct).
//
// Before: a USD-balance buy the trading wallet W could not cover waited for a top-up — the reserve R swapped its stable to
// native and paid W (one transaction), the page watched for it to land, then W bought (a second transaction): two
// confirmations in front of the buy, seconds of latency and buys refused when the top-up was late.
// Now: R itself buys, in ONE transaction it signs, spending its own stable and delivering the coin straight to W:
//   Solana  a Jupiter route USDC → coin with destinationTokenAccount = W's coin account (Jupiter hops USDC → SOL → coin by
//           itself, so pump.fun curves and coins without a USDC pool work); R pays the fee and the rent of W's account.
//   EVM     the stateless UsdBuyRouter (B:\tmp\float-direct\contracts, NOT deployed): R's stable → native → the venue's own
//           native-in buy, the coin delivered to W, reverted below the minimum.
// R is the user's own wallet (derived from W's key); nothing here is motion's money. This module is pure: the checks the
// vault runs on what R is asked to sign and on what the simulation shows (src/solEngine.ts solDirectBuild calls them), and
// the router call's encoding.
import { encodeFunctionData } from 'viem';

// ── Solana: what R may sign ──
export const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const REFUSE = 'Jupiter\'s transaction holds an instruction the reserve does not sign — refused';
export type DirectIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/**
 * Jupiter's instruction list for R's buy (setup + the swap + cleanup), checked before anything is compiled:
 *  - every signer is R;
 *  - exactly one Jupiter swap, and W's coin account (`wCoinAta`) is one of its writable accounts (the destination);
 *  - an associated-account create paid by R for R itself (R's wSOL / intermediate / coin account of the route);
 *  - on R's wSOL account only: sync_native, and close_account back to R.
 * No SOL transfer (the input is USDC: nothing is wrapped), no approval, no other token instruction.
 */
export function directIxsChecked(list: DirectIx[], o: { r: string; wCoinAta: string; rWsolAta: string }): { opens: number } {
  let swaps = 0, opens = 0;
  for (const x of list) {
    if (!x || typeof x.programId !== 'string' || !Array.isArray(x.accounts) || typeof x.data !== 'string') throw new Error(REFUSE);
    if (x.accounts.some((a) => a.isSigner && a.pubkey !== o.r)) throw new Error('Jupiter asked for a signer that is not the reserve — refused');
    const data = b64(x.data), keys = x.accounts.map((a) => a.pubkey);
    let ok = false;
    if (x.programId === JUP_PROGRAM) {
      swaps += 1;
      ok = x.accounts.some((a) => a.pubkey === o.wCoinAta && a.isWritable);
      if (!ok) throw new Error('Jupiter\'s swap does not pay the trading wallet\'s coin account — refused');
    } else if (x.programId === ATA) { ok = (data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1))) && keys[0] === o.r && keys[2] === o.r; if (ok) opens += 1; }
    else if (x.programId === TOKEN && data.length === 1) {
      if (data[0] === 17) ok = keys.length === 1 && keys[0] === o.rWsolAta;
      else if (data[0] === 9) ok = keys.length === 3 && keys[0] === o.rWsolAta && keys[1] === o.r && keys[2] === o.r;
    }
    if (!ok) throw new Error(REFUSE);
  }
  if (swaps !== 1) throw new Error('Jupiter\'s transaction must hold exactly one swap — refused');
  return { opens };
}
/**
 * Every move of R's funds INSIDE the simulated transaction (the node's parsed inner instructions). Allowed for R: rent for an
 * account the transaction creates (each ≤ rentMax), SOL only into such an account, token transfers R signs from its USDC
 * account (≤ the amount in total) or from an account this transaction created, closing such an account (or its wSOL account)
 * back to R, sync_native. A transfer R signs from another of its token accounts is collected in `through` (the caller reads
 * those before and in the simulation; directBalanceGuard refuses any that ends lower). Anything else R signs is refused.
 * W's coin account may be created (by the vault's own instruction, paid by R). '' = fine, 'no inner instructions' = the node
 * did not return them (the caller refuses then: the reserve signs nothing it has not seen move).
 */
export function directInnerGuard(g: { inner: unknown; r: string; w: string; usdcAta: string; rWsolAta: string; wCoinAta: string; amount: bigint; rentMax: bigint; through?: Set<string> }): string {
  const groups = Array.isArray(g.inner) ? g.inner : null;
  if (!groups) return 'no inner instructions';
  const big = (v: unknown) => { try { return BigInt(String(v ?? '0')); } catch { return -1n; } };
  const created = new Set<string>();
  for (const grp of groups) for (const x of (grp as any)?.instructions || []) {
    const t = x?.parsed?.type, i = x?.parsed?.info || {};
    if (x?.program === 'system' && (t === 'createAccount' || t === 'createAccountWithSeed') && i.source === g.r) { if (big(i.lamports) > g.rentMax || big(i.lamports) < 0n) return 'it pays more rent than the accounts it opens need'; created.add(String(i.newAccount)); }
    else if (x?.program === 'spl-associated-token-account' && (t === 'create' || t === 'createIdempotent') && (i.wallet === g.r || (i.wallet === g.w && i.account === g.wCoinAta))) created.add(String(i.account));
  }
  let spent = 0n;
  for (const grp of groups) for (const x of (grp as any)?.instructions || []) {
    const prog = x?.program, t = x?.parsed?.type, i = x?.parsed?.info || {};
    if (!x?.parsed) { if (x?.programId === TOKEN || x?.programId === TOKEN22 || x?.programId === SYSTEM) return 'it holds an instruction the node could not read'; continue; }
    if (prog === 'system' && (t === 'transfer' || t === 'transferWithSeed') && (i.source === g.r || i.from === g.r)) {
      if (created.has(String(i.destination))) continue;
      return 'it sends SOL from the reserve somewhere else';
    }
    if (prog === 'system' && i.source === g.r && t !== 'createAccount' && t !== 'createAccountWithSeed') return `it signs a system ${t || 'instruction'} for the reserve`;
    if (prog === 'spl-token' || prog === 'spl-token-2022') {
      if ((t === 'initializeAccount' || t === 'initializeAccount2' || t === 'initializeAccount3' || t === 'initializeImmutableOwner') && created.has(String(i.account))) continue;
      if (t === 'getAccountDataSize') continue;
      const auth = i.authority ?? i.owner ?? i.multisigAuthority ?? i.multisigOwner;
      if (auth !== g.r) continue;
      if (t === 'transfer' || t === 'transferChecked') {
        const src = String(i.source), amt = big(i.amount ?? i.tokenAmount?.amount);
        if (src === g.usdcAta) { if (amt < 0n) return 'it moves an unreadable amount'; spent += amt; continue; }
        if (created.has(src)) continue;
        if (g.through) { g.through.add(src); continue; }
        return `it moves tokens out of ${src.slice(0, 6)}…`;
      }
      if (t === 'closeAccount' && i.destination === g.r && (i.account === g.rWsolAta || created.has(String(i.account)))) continue;
      if (t === 'syncNative') continue;
      return `it signs a token ${t || 'instruction'} for the reserve`;
    }
  }
  if (spent > g.amount) return 'it spends more USDC than the amount';
  return '';
}
export type TokSnap = { mint: string; owner: string; amount: bigint; delegate: string };
/**
 * The simulated outcome must be exactly this buy: R's USDC down by at most the amount; W's coin up by at least the minimum
 * (into W's own account); R's SOL (with its wSOL) down by at most the fees and the rent of the accounts it opens; every other
 * account the route passes through not lower, not closed, not handed over, not delegated. '' = fine.
 */
export function directBalanceGuard(g: {
  amount: bigint; minOut: bigint; feesMax: bigint; rentMax: bigint; r: string; w: string;
  usdcBefore: bigint; usdcAfter: bigint | null;
  coinBefore: bigint; coinAfter: TokSnap | null;
  solBefore: bigint; solAfter: bigint;
  others: { address: string; before: TokSnap; after: TokSnap | null }[];
}): string {
  if (g.usdcAfter === null) return 'it would close the reserve\'s USDC account';
  if (g.usdcBefore - g.usdcAfter > g.amount) return 'it would take more USDC than the amount';
  if (!g.coinAfter || g.coinAfter.owner !== g.w) return 'it would not deliver the coin to the trading wallet';
  if (g.coinAfter.delegate) return 'it would let someone spend the trading wallet\'s coin';
  if (g.coinAfter.amount - g.coinBefore < g.minOut) return 'it would deliver less of the coin than Jupiter\'s minimum';
  if (g.solBefore - g.solAfter > g.feesMax + g.rentMax) return 'it would take more SOL than its fees and account rent';
  for (const o of g.others) {
    if (!o.after) return `it would close the token account ${o.address.slice(0, 6)}…`;
    if (o.after.owner !== o.before.owner) return `it would hand the token account ${o.address.slice(0, 6)}… to someone else`;
    if (o.after.amount < o.before.amount) return `it would take ${o.before.mint.slice(0, 6)}… tokens the reserve holds`;
    if (o.after.delegate !== o.before.delegate) return `it would let someone spend ${o.before.mint.slice(0, 6)}… tokens`;
  }
  return '';
}
/** motion's own market price (USD per whole coin) against the route: a minimum under 70 % of fair is refused; no price = the
 *  buy goes (bounded by the amount), as for every Jupiter buy. */
// (token2022-fee) `feeBps`: a transfer-fee coin reaches W less its fee, so the fair figure is that much lower
export function directPriceCheck(o: { usdcIn: bigint; minOut: bigint; decimals: number; priceUsd: number | null; feeBps?: number }): string {
  if (o.priceUsd == null || !(o.priceUsd > 0)) return '';
  const fair = (Number(o.usdcIn) / 1e6) / o.priceUsd * 10 ** o.decimals;
  const net = o.feeBps && o.feeBps > 0 ? 1 - Math.min(o.feeBps, 10000) / 10000 : 1;
  return Number(o.minOut) < fair * net * 0.7 ? 'the route pays far less than the market price' : '';
}
/** Jupiter's answer must be this buy: USDC in, the coin out, the exact amount, ExactIn, our slippage, and a minimum that is
 *  the quote less that slippage (a looser minimum would let a bad fill through the balance check). */
export function directQuoteCheck(j: { inputMint?: unknown; outputMint?: unknown; inAmount?: unknown; outAmount?: unknown; otherAmountThreshold?: unknown; swapMode?: unknown; slippageBps?: unknown }, want: { usdc: string; mint: string; amount: bigint; bps: number }): { out: bigint; min: bigint } {
  if (typeof j.outAmount !== 'string' || typeof j.otherAmountThreshold !== 'string') throw new Error('Jupiter found no route for this coin right now — nothing was sent; try again');
  if (j.inputMint !== want.usdc || j.outputMint !== want.mint || j.inAmount !== String(want.amount) || j.swapMode !== 'ExactIn' || Number(j.slippageBps) !== want.bps) throw new Error('Jupiter answered for a different trade — refused');
  const out = BigInt(j.outAmount), min = BigInt(j.otherAmountThreshold);
  if (!(min > 0n) || min > out || min * 10000n < out * BigInt(10000 - want.bps) - 10000n) throw new Error('Jupiter\'s minimum does not match your slippage — refused');
  return { out, min };
}
// ── EVM: UsdBuyRouter.buy (contract: B:\tmp\float-direct\contracts\UsdBuyRouter.sol — NOT deployed) ──
// One call R signs: the router pulls `stableIn` from msg.sender (R) only, swaps it to native on the float's own stable/native
// pool (SwapRouter02 exactInputSingle, ≥ minNative), calls ONE allow-listed venue with that native and the venue's own
// native-in buy calldata (recipient = W where the venue takes one), forwards whatever coin landed on the router to W, refunds
// unspent native to W, and reverts unless W's coin balance rose by ≥ minTokens. Empty router address = this path is off.
export const USD_BUY_ROUTER: Record<'robinhood' | 'bsc', `0x${string}` | ''> = { robinhood: '', bsc: '' };
export const USD_BUY_ABI = [{ name: 'buy', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'tuple', components: [
  { name: 'token', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'stableIn', type: 'uint256' }, { name: 'minNative', type: 'uint256' },
  { name: 'venue', type: 'address' }, { name: 'venueData', type: 'bytes' }, { name: 'minTokens', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }],
  outputs: [{ name: 'got', type: 'uint256' }] }] as const;
export type UsdBuy = { token: `0x${string}`; recipient: `0x${string}`; stableIn: bigint; minNative: bigint; venue: `0x${string}`; venueData: `0x${string}`; minTokens: bigint; deadline: bigint };
export function usdBuyCalldata(b: UsdBuy): `0x${string}` {
  if (b.stableIn <= 0n || b.minNative <= 0n || b.minTokens <= 0n) throw new Error('A USD buy needs an amount and two floors');
  return encodeFunctionData({ abi: USD_BUY_ABI, functionName: 'buy', args: [b] });
}
// The after-trade refill of the ready float (owner 2026-10-29, «да добавляй тоже делай») lives with the sizing rules:
// src/floatCore.ts REFILL, readySize6, burstOf, sweepAllowed; src/floatEngine.ts afterTrade / noteBuy.

// ── the frame call: float.buy (the app's `floatBuy`) ──
// ONE plain object, every field checked, anything else refused before anything is read or asked. `usd` is per wallet.
export type UsdBuyArgs = { token: string; usd: number; walletIds?: string[]; hint?: unknown; id?: string };
export function usdBuyArgs(o: unknown): UsdBuyArgs {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  const a = o as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!['token', 'usd', 'walletIds', 'hint', 'id'].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  const token = String(a.token ?? '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) && !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('Bad arguments: token');
  const usd = a.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || !(usd >= 0.1 && usd <= 10_000)) throw new Error('Bad arguments: usd');
  let walletIds: string[] | undefined;
  if (a.walletIds != null) {
    if (!Array.isArray(a.walletIds) || !a.walletIds.length || a.walletIds.length > 25 || a.walletIds.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(x))) throw new Error('Bad arguments: walletIds');
    walletIds = [...new Set(a.walletIds as string[])];
  }
  if (a.id != null && (typeof a.id !== 'string' || !/^[\w:-]{1,48}$/.test(a.id))) throw new Error('Bad arguments: id');
  if (a.hint != null && (typeof a.hint !== 'object' || Array.isArray(a.hint))) throw new Error('Bad arguments: hint');
  return { token, usd, ...(walletIds ? { walletIds } : {}), ...(a.hint != null ? { hint: a.hint } : {}), ...(a.id != null ? { id: a.id as string } : {}) };
}

// ── EVM, a coin listed on a V3 pool (Uniswap V3 / Pons V2 graduates on Robinhood, PancakeSwap V3 on BNB): no new contract ──
// ONE call R signs to the float's OWN router (FLOAT_CFG[chain].router: SwapRouter02 on Robinhood, PancakeSwap's SmartRouter on
// BNB — the router R already swaps through for top-ups): multicall(deadline, [exactInput]) along stable → (wrapped native)
// → coin, the coin paid straight to W. The router pulls only from msg.sender (R); R's allowance to it is set in the background
// (never on the click), so the click is one transaction.
const V3_ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInput', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
] as const;
export const V3_FEES = [100, 500, 2500, 3000, 10000] as const;
export function usdBuyV3Calldata(o: { stable: `0x${string}`; tokens: `0x${string}`[]; fees: number[]; amountIn: bigint; minOut: bigint; recipient: `0x${string}`; deadline: bigint }): `0x${string}` {
  const t = o.tokens;
  if (t.length < 2 || t.length > 4 || o.fees.length !== t.length - 1) throw new Error('A USD buy path is the stable, at most two hops, then the coin');
  if (t[0].toLowerCase() !== o.stable.toLowerCase()) throw new Error('A USD buy starts from the reserve\'s stable');
  if (new Set(t.map((x) => x.toLowerCase())).size !== t.length || t.some((x) => !/^0x[0-9a-fA-F]{40}$/.test(x))) throw new Error('Bad path');
  if (o.fees.some((f) => !(V3_FEES as readonly number[]).includes(f))) throw new Error('Bad pool fee');
  if (o.amountIn <= 0n || o.minOut <= 0n || !/^0x[0-9a-fA-F]{40}$/.test(o.recipient) || /^0x0{40}$/.test(o.recipient)) throw new Error('A USD buy needs an amount, a floor and the trading wallet');
  let path = '0x';
  t.forEach((x, i) => { path += x.slice(2).toLowerCase(); if (i < o.fees.length) path += o.fees[i].toString(16).padStart(6, '0'); });
  const swap = encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: 'exactInput', args: [{ path: path as `0x${string}`, recipient: o.recipient, amountIn: o.amountIn, amountOutMinimum: o.minOut }] });
  return encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: 'multicall', args: [o.deadline, [swap]] });
}
