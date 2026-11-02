// Limit orders v1 (2026-10-22, owner's variant 1; docs/drafts/LIMIT-ORDERS.md): the pure parts, shared by the vault
// (src/limitEngine.ts, built into vendor/engine.js) and the keeper (server/limit-orders.mjs, which imports this file under
// node --experimental-strip-types — it ships in deploy-push.sh's tar list next to src/evmV4Router.ts).
//
// Robinhood lane only. Per order the vault derives its own ORDER WALLET from the main wallet's key
// (HMAC(main key, "motion/limit-order/v1\n<chain>\n<orderId>"), never exported), funds it from the main wallet and
// pre-signs, from it, ONE swap back to the main wallet (two route variants on the same nonce for a curve that may migrate).
// The keeper holds only those signed bytes: it can broadcast them or not, never change them.
//
// Nothing here touches a key except orderKey(), which the vault calls where the main key lives (src/webEngine.ts).
import { encodeAbiParameters, encodeFunctionData, encodePacked, toHex, sha256, toBytes, parseTransaction, recoverTransactionAddress, keccak256, parseAbi } from 'viem';
import { UNIVERSAL_ROUTER, PERMIT2, ROBINHOOD_LAUNCHER_HOOK, NATIVE_CURRENCY, ADDRESS_THIS, CONTRACT_BALANCE, OPEN_DELTA, Commands, Actions, V4_POOL_MANAGER, DYNAMIC_FEE_FLAG, MAX_STATIC_FEE } from './evmV4Router.ts';
import type { V4PoolKey } from './evmV4Router.ts';

type Hex = `0x${string}`;
export const LIMIT_VERSION = 1;
export const LIMIT_CHAIN = 'robinhood';
export const LIMIT_CHAIN_ID = 4663;
export const WETH_RH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const UR = UNIVERSAL_ROUTER.toLowerCase() as Hex;
export const P2 = PERMIT2.toLowerCase() as Hex;
export const PONS_HOOK = ROBINHOOD_LAUNCHER_HOOK.toLowerCase() as Hex;
// ── limits (v1) ──
export const MAX_OPEN = 10;                               // open orders per main wallet
export const MIN_SIZE_WEI = 500_000_000_000_000n;         // 0.0005 ETH (owner 2026-10-26; was 0.002): a buy's size, a sell's notional at its limit price
export const MIN_EXPIRY_S = 3600;                         // 1 h
export const MAX_EXPIRY_S = 7 * 86400;                    // 7 d
export const SLIP_DEFAULT_BPS = 100;                      // 1 % (review M4: the floor is the limit price minus this; keep it tight)
export const SLIP_MAX_BPS = 2000;                         // 20 % (a custom value; chips 1 / 3 / 5 %)
export const SLIP_MIN_BPS = 10;
export const TAX_CAP_BPS = 500;                           // a curve's fee + creator tax from the route proposal counts at most 5 % into minOut
// ── gas (docs §3): legacy txs at 10× the current base fee (Robinhood charges the base fee, the rest is only a balance
// requirement), gas limit = the estimate × 1.4 (the L1 data fee is paid in L2 gas and moves with L1) ──
export const GAS_PRICE_MULT = 10n;
export const GAS_LIMIT_PCT = 140n;
// a variant whose venue cannot be estimated yet (the V4 pool a curve migrates into does not exist before the migration):
// a send of the same calldata to an EOA (21 000 + calldata + the L1 component) plus the venue's execution allowance
export const V4_EXEC_GAS = 350_000n;
export const CURVE_EXEC_GAS = 220_000n;
export const MAX_FILLERS = 4;                             // zero-value self-sends a cancel may need to burn the swap nonce
// review L10: sane upper bounds — Robinhood's base fee is ~0.02 gwei, so 10× is ~0.2 gwei; anything near these is a broken read
export const MAX_SIGNED_GAS_PRICE = 2_000_000_000n;       // 2 gwei
export const MAX_GAS_LIMIT = 6_000_000n;                  // per transaction (the L1 share included)
export const MAX_RESERVE_WEI = 10_000_000_000_000_000n;   // 0.01 ETH of gas reserve per order
export const MAX_RAW_BYTES = 4096;                        // review H2: a signed tx the server keeps
export const DUST_WEI = 5_000_000_000_000n;               // 0.000005 ETH: below this an order wallet counts as empty
// the Pons V2 platform fee on Robinhood (server/chains.mjs pons.feeBps); the creator tax is read from the registry (word 7)
export const PONS_FEE_BPS = 100;
// V4 pools a limit may trade (review L2): the hooks the engine already trusts, or none
export const LIMIT_HOOKS = [ROBINHOOD_LAUNCHER_HOOK.toLowerCase(), '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544', '0x745d717620052a97a22deee2e5eba59583f3e0cc', '0x0000000000000000000000000000000000000000'];
// ── BNB Chain (2026-10-25, LIMIT-ORDERS.md §13): PancakeSwap V2 (WBNB pairs) and the four.meme curve (BNB-quoted), which
// migrates into its PancakeSwap V2 WBNB pair — so a four.meme order pre-signs both, on one nonce, like a Pons curve ──
export const BSC_CHAIN_ID = 56;
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const PANCAKE_V2 = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
export const FOUR_MANAGER = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
export const FOUR_HELPER = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';   // the engine's route check (checkRoute) requires it
export const FOUR_FEE_BPS = 100;                          // four.meme's trading fee, taken from the funds of a buy
export const PANCAKE_V2_FEE_BPS = 25;                     // the V2 pool fee (the board's price is the spot price)
// ── markets NOT quoted in the native coin (2026-10-25, LIMIT-ORDERS.md §19): one pre-signed transaction with a bridge leg ──
// Robinhood: a Uniswap V4 pool quoted in USDG or a tokenised stock, reached from ETH through a Uniswap V3 path inside the
// same Universal Router call (venue 'v4bridge'). BNB: a PancakeSwap V2 pair quoted in another token, path [WBNB, quote,
// token] through the same V2 router (venue 'v2bridge'). The floor is the LAST leg's minimum; every middle leg's is 0.
export const USDG_RH = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** the assets a Robinhood V3 bridge may pass through between WETH and the pool's quote (the engine's bridge assets) */
export const BRIDGE_MIDS_RH = [USDG_RH];
export const V3_TIERS = [100, 500, 2500, 3000, 10000];
export const BRIDGE_EXEC_GAS = 600_000n;                  // V3 leg + V4 swap (+ unwrap) when the router cannot be asked yet
export const BRIDGE_TAX_CAP_BPS = 1500;                   // both legs' pool fees count into the floor up to 15 %
export const POOL_MANAGER = V4_POOL_MANAGER.toLowerCase() as Hex;
export const EXTSLOAD_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
// ── per-chain figures; Robinhood's are the v1 constants above, unchanged ──
export type LimitChainKey = 'robinhood' | 'bsc';
export type LimitChainProfile = {
  key: LimitChainKey; chainId: number; native: 'ETH' | 'BNB'; name: string;
  minSize: bigint; maxGasPrice: bigint; maxReserve: bigint; dust: bigint;
  /** the gas price every pre-signed tx carries: it must still be includable days later */
  gasPrice(o: { baseFee: bigint | null; nodePrice: bigint }): bigint;
};
export const LIMIT_CHAINS: Record<LimitChainKey, LimitChainProfile> = {
  robinhood: {
    key: 'robinhood', chainId: 4663, native: 'ETH', name: 'Robinhood Chain', minSize: 500_000_000_000_000n, maxGasPrice: 2_000_000_000n, maxReserve: 10_000_000_000_000_000n, dust: 5_000_000_000_000n,
    gasPrice: ({ baseFee, nodePrice }) => (baseFee != null && baseFee > 0n ? baseFee : nodePrice > 0n ? nodePrice : 1n) * 10n,
  },
  // BNB Chain has no base fee (0); validators take ≥ 0.05 gwei. 2× the node's price, at least 0.1 gwei, at most 3 gwei.
  bsc: {
    key: 'bsc', chainId: BSC_CHAIN_ID, native: 'BNB', name: 'BNB Chain', minSize: 5_000_000_000_000_000n, maxGasPrice: 3_000_000_000n, maxReserve: 10_000_000_000_000_000n, dust: 5_000_000_000_000n,
    gasPrice: ({ nodePrice }) => { const g = nodePrice * 2n; return g < 100_000_000n ? 100_000_000n : g; },
  },
};
export const limitChain = (key: unknown): LimitChainProfile => {
  const p = typeof key === 'string' && Object.prototype.hasOwnProperty.call(LIMIT_CHAINS, key) ? LIMIT_CHAINS[key as LimitChainKey] : null;
  if (!p) throw new Error('Limit orders run on Robinhood Chain and BNB Chain only');
  return p;
};
const isLimitChain = (c: string) => Object.prototype.hasOwnProperty.call(LIMIT_CHAINS, c);
// order ids: deterministic from the main key and an index (review H1), so a wiped browser finds every order wallet again
export const ORDER_ID_DERIVATION = 'motion/limit-order-id/v1';
export const SCAN_GAP = 5;                                // unused order wallets in a row that end a recovery scan
// ── server auth (a vault-signed personal_sign text, like the callouts route) ──
export const AUTH_WINDOW_MS = 10 * 60_000;                // place / cancel
export const READ_WINDOW_MS = 24 * 3600_000;              // the read token for GET /api/limit?wallet=
export const DERIVATION = 'motion/limit-order/v1';
export const ORDER_ID = /^[0-9a-f]{32}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = (a: unknown) => String(a ?? '').toLowerCase();
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const hmac32 = async (mainKey: string, message: string): Promise<Uint8Array> => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(mainKey)) throw new Error('Bad wallet key');
  const raw = new Uint8Array(32); for (let i = 0; i < 32; i += 1) raw[i] = parseInt(mainKey.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  } finally { raw.fill(0); }
};
export const orderIdMessage = (chain: string, index: number) => `${ORDER_ID_DERIVATION}\n${chain}\n${index}`;
/** the order id at `index` of a main wallet: the first 16 bytes of HMAC-SHA256(main key, orderIdMessage) as 32 hex. Public
 *  (it is posted and shown); it reveals nothing of the key. index 0, 1, 2 … — the vault takes the first one whose order
 *  wallet is unused, a recovery scan walks them until SCAN_GAP unused ones in a row. */
export async function orderIdOf(mainKey: string, chain: string, index: number): Promise<string> {
  if (!Number.isSafeInteger(index) || index < 0 || !isLimitChain(chain)) throw new Error('Bad order index');
  const mac = await hmac32(mainKey, orderIdMessage(chain, index));
  const id = Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  mac.fill(0);
  return id;
}
/** the HMAC message of an order wallet's key */
export const derivationMessage = (chain: string, orderId: string) => `${DERIVATION}\n${chain}\n${orderId}`;
/** the order wallet's private key = HMAC-SHA256(key = the main wallet's 32-byte EVM key, derivationMessage). Runs where the
 *  main key lives; the result goes straight into a signer and nowhere else (never logged, never in an answer or event). */
export async function orderKey(mainKey: string, chain: string, orderId: string): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(mainKey)) throw new Error('Bad wallet key');
  if (!ORDER_ID.test(orderId) || !isLimitChain(chain)) throw new Error('Bad order id');
  const raw = new Uint8Array(32); for (let i = 0; i < 32; i += 1) raw[i] = parseInt(mainKey.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(derivationMessage(chain, orderId))));
    const hex = ('0x' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
    mac.fill(0);
    const v = BigInt(hex);
    if (v === 0n || v >= SECP_N) throw new Error('Order key out of range — pick another order id');   // p ≈ 2^-128
    return hex;
  } finally { raw.fill(0); }
}

// ── prices and amounts ──
/** a decimal string → exact rational num / den (den = 10^decimals). Up to 20 integer and 24 fraction digits, > 0. */
export function parseDecimal(s: unknown, what = 'price'): { num: bigint; den: bigint } {
  const t = String(s ?? '');
  const m = /^(\d{1,20})(?:\.(\d{1,24}))?$/.exec(t);
  if (!m) throw new Error(`Bad ${what}: a plain decimal string`);
  const frac = m[2] || '';
  const num = BigInt(m[1] + frac), den = 10n ** BigInt(frac.length);
  if (num <= 0n) throw new Error(`Bad ${what}: must be above 0`);
  return { num, den };
}
/** units of a decimal string at `decimals` (refuses more fraction digits than the token has) */
export function toUnits(s: unknown, decimals: number, what = 'amount'): bigint {
  const t = String(s ?? '');
  const m = /^(\d{1,30})(?:\.(\d{1,36}))?$/.exec(t);
  if (!m) throw new Error(`Bad ${what}: a plain decimal string`);
  const frac = m[2] || '';
  if (frac.length > decimals) throw new Error(`Bad ${what}: more than ${decimals} decimals`);
  const v = BigInt(m[1] + frac.padEnd(decimals, '0'));
  if (v <= 0n) throw new Error(`Bad ${what}: must be above 0`);
  return v;
}
export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n; const a = neg ? -v : v; const d = 10n ** BigInt(decimals);
  const i = a / d, f = a % d;
  const fs = decimals ? f.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return (neg ? '-' : '') + i.toString() + (fs ? '.' + fs : '');
}
/**
 * The swap's floor, from the limit price and the slippage. price = ETH per ONE whole token.
 *   buy  (amountIn wei):          tokens ≥ amountIn × (1 − tax) / price × (1 − slippage)
 *   sell (amountIn token units):  wei    ≥ amountIn × price × (1 − tax) × (1 − slippage)
 * tax: the venue's known fee (a Pons curve's fee + creator tax, capped at TAX_CAP_BPS); 0 for a V4 pool; a bridged market's
 * pool fees on both legs (capped at BRIDGE_TAX_CAP_BPS: pass taxCapBps = BRIDGE_TAX_CAP_BPS, variantTaxCap).
 */
export function minOutOf(o: { side: 'buy' | 'sell'; amountIn: bigint; price: string; decimals: number; taxBps?: number; taxCapBps?: number; slippageBps: number }): bigint {
  const { num, den } = parseDecimal(o.price);
  const cap = o.taxCapBps === BRIDGE_TAX_CAP_BPS ? BRIDGE_TAX_CAP_BPS : TAX_CAP_BPS;
  const tax = BigInt(Math.max(0, Math.min(cap, Math.floor(Number(o.taxBps) || 0))));
  const slip = BigInt(o.slippageBps);
  if (slip < BigInt(SLIP_MIN_BPS) || slip > BigInt(SLIP_MAX_BPS)) throw new Error('Slippage out of range');
  if (!(o.amountIn > 0n)) throw new Error('Nothing to swap');
  const keep = (10_000n - tax) * (10_000n - slip);   // / 1e8
  const scale = 10n ** BigInt(o.decimals);
  const out = o.side === 'buy'
    ? (o.amountIn * den * scale * keep) / (num * 10n ** 18n * 100_000_000n)
    : (o.amountIn * num * 10n ** 18n * keep) / (den * scale * 100_000_000n);
  if (out <= 0n) throw new Error('The limit price leaves nothing to receive');
  return out;
}
/** a sell's value at its limit price, in wei (the 0.0005 ETH minimum applies to it) */
export const notionalWei = (amountIn: bigint, price: string, decimals: number) => { const { num, den } = parseDecimal(price); return (amountIn * num * 10n ** 18n) / (den * 10n ** BigInt(decimals)); };
/** the trigger the keeper watches: a limit buy at or below, a take-profit at or above, a stop-loss at or below */
export function triggerHit(kind: string, price: string, markEth: number): boolean {
  const p = Number(price);
  if (!(markEth > 0) || !(p > 0)) return false;
  if (kind === 'limit' || kind === 'sl') return markEth <= p;
  if (kind === 'tp') return markEth >= p;
  return false;
}

// ── gas ──
export const signedGasPrice = (baseFee: bigint) => {
  const g = (baseFee > 0n ? baseFee : 1n) * GAS_PRICE_MULT;
  if (g > MAX_SIGNED_GAS_PRICE) throw new Error(`The network fee is unusually high right now (base fee ${baseFee} wei) — try again later`);
  return g;
};
/** the signed gas price on any limit chain (its profile's policy, its own upper bound) */
export const signedGasPriceFor = (p: LimitChainProfile, o: { baseFee: bigint | null; nodePrice: bigint }) => {
  const g = p.gasPrice(o);
  if (g > p.maxGasPrice) throw new Error(`The network fee is unusually high right now (${g} wei) — try again later`);
  return g;
};
export const gasLimitOf = (estimate: bigint) => {
  const g = (estimate * GAS_LIMIT_PCT + 99n) / 100n;
  if (g > MAX_GAS_LIMIT) throw new Error(`A gas estimate is out of range (${estimate})`);
  return g;
};
/** the order wallet's native reserve: per nonce slot the dearest variant (only one can land), plus the sweeps
 *  (an ETH sweep; for a sell also the token's way back on a cancel), all at the signed gas price */
export function gasReserve(o: { slots: bigint[][]; sweeps: bigint[]; gasPrice: bigint; max?: bigint }): bigint {
  let gas = 0n;
  for (const s of o.slots) { if (!s.length) continue; let m = 0n; for (const g of s) if (g > m) m = g; gas += m; }
  for (const g of o.sweeps) gas += g;
  const wei = gas * o.gasPrice;
  if (wei > (o.max ?? MAX_RESERVE_WEI)) throw new Error(`The gas reserve would be ${wei} wei — out of range, nothing was sent`);
  return wei;
}

// ── venues ──
export type Venue = 'curve' | 'v4' | 'four' | 'v2' | 'v4bridge' | 'v2bridge';
export type Variant =
  | { venue: 'curve'; curve: Hex; taxBps: number }
  | { venue: 'v4'; poolKey: V4PoolKey; pair: 'native' | 'weth'; migrates: boolean; taxBps?: number }
  | { venue: 'four'; manager: Hex; taxBps: number }
  | { venue: 'v2'; router: Hex; path: [Hex, Hex]; taxBps: number; migrates: boolean }
  // ETH → (V3 path hops / fees) → quote → V4 pool → coin, one Universal Router call; a sell walks it back
  | { venue: 'v4bridge'; poolKey: V4PoolKey; quote: Hex; hops: Hex[]; fees: number[]; taxBps: number }
  // BNB → quote → coin through the PancakeSwap V2 router (path [WBNB, quote, token]); a sell walks it back
  | { venue: 'v2bridge'; router: Hex; quote: Hex; taxBps: number };
export type LimitRoute =
  | { type: 'pons'; curve: Hex; pairToken: Hex; feeBps: number; creatorTaxBps: number; chainId?: number }
  | { type: 'v4'; poolKey: V4PoolKey; pair: string; chainId?: number; quoteToken?: Hex; bridgeHops?: Hex[]; bridgeFees?: number[] }
  | { type: 'four'; manager: Hex; helper: Hex; quoteToken: Hex; chainId?: number }
  | { type: 'v2'; router: Hex; path: Hex[]; chainId?: number };
/** what a bridged order posts beside its signed bytes (covered by the digest the main wallet signs): the quote asset, the
 *  path from the wrapped native coin to it, and (Robinhood) the V4 pool. The keeper rebuilds the exact calldata from it. */
export type PostedBridge = { quote: Hex; hops: Hex[]; fees: number[]; poolKey?: V4PoolKey };
/** the venues each chain may post (the keeper refuses any other) and where each swap must go */
export const CHAIN_VENUES: Record<LimitChainKey, Venue[]> = { robinhood: ['curve', 'v4', 'v4bridge'], bsc: ['four', 'v2', 'v2bridge'] };
export const BRIDGE_VENUES: Venue[] = ['v4bridge', 'v2bridge'];
/** a venue's taxBps for the floor: the curve's / four.meme's fee, the V2 pool fee, a bridged market's fees on both legs;
 *  a plain V4 pool here charges none */
export const variantTax = (v: Variant) => (v.venue === 'v4' ? v.taxBps ?? 0 : v.taxBps);
/** the cap minOutOf applies to that tax (a bridged market's two pools may take more than a curve's 5 %) */
export const variantTaxCap = (v: Variant) => (v.venue === 'v4bridge' || v.venue === 'v2bridge' ? BRIDGE_TAX_CAP_BPS : TAX_CAP_BPS);
/** pool fees in pips (1e-6: V3 tiers, a V4 fee) compounded into whole bps, rounded DOWN (a fee counted short only raises
 *  the floor: the order fills a little later, never below the limit) */
export function feesBps(pips: number[]): number {
  let keep = 1_000_000n;
  for (const f of pips) { if (!Number.isInteger(f) || f < 0 || f >= 1_000_000) throw new Error('Bad pool fee'); keep = (keep * BigInt(1_000_000 - f) + 999_999n) / 1_000_000n; }   // kept share rounded up
  return Number((1_000_000n - keep) / 100n);
}
/** the V4 pool's id and the PoolManager storage slot of its Slot0 (StateLibrary: pools mapping at slot 6) — the vault reads
 *  a dynamic-fee pool's current LP fee from it (extsload) */
export const v4PoolId = (k: V4PoolKey): Hex => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
export const v4Slot0Slot = (k: V4PoolKey): Hex => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [v4PoolId(k), 6n]));
/** Slot0 = sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24): the LP fee in pips */
export const lpFeeOfSlot0 = (word: unknown): number => { const s = String(word ?? ''); if (!/^0x[0-9a-fA-F]{1,64}$/.test(s)) return 0; return Number((BigInt(s) >> 208n) & 0xffffffn); };
/** a V3 path, packed: token | fee | token | fee | token … */
export const v3Path = (tokens: string[], fees: number[]): Hex => {
  const types: string[] = []; const values: (string | number)[] = [];
  tokens.forEach((t, i) => { types.push('address'); values.push(lc(t)); if (i < fees.length) { types.push('uint24'); values.push(fees[i]); } });
  return encodePacked(types as never, values as never);
};
/** a Robinhood bridge: WETH → (USDG) → quote on known V3 tiers, quote not ETH / WETH; '' = fine, otherwise why not */
export function bridgeProblem(hops: unknown, fees: unknown, quote: string): string {
  if (!Array.isArray(hops) || !Array.isArray(fees) || hops.length < 2 || hops.length > 3 || fees.length !== hops.length - 1) return 'the bridge from ETH has a bad shape';
  const h = hops.map(lc);
  if (!h.every((a) => ADDR.test(a))) return 'the bridge from ETH has a bad shape';
  if (h[0] !== WETH_RH) return 'the bridge must start from WETH';
  if (h[h.length - 1] !== lc(quote)) return 'the bridge must end at the pool\'s quote asset';
  if (lc(quote) === NATIVE_CURRENCY || lc(quote) === WETH_RH) return 'an ETH / WETH pool needs no bridge';
  for (const m of h.slice(1, -1)) if (!BRIDGE_MIDS_RH.includes(m) || m === lc(quote)) return 'the bridge passes through an unknown asset';
  if (!fees.every((f) => V3_TIERS.includes(Number(f)) && Number.isInteger(f))) return 'the bridge uses an unknown V3 fee tier';
  return '';
}
/** a bridged pool key: sorted, holds exactly the coin and the quote, a hook limit orders trade through, a sane fee */
export function bridgePoolProblem(k: V4PoolKey, token: string, quote: string): string {
  const c0 = lc(k.currency0), c1 = lc(k.currency1);
  if (!ADDR.test(c0) || !ADDR.test(c1) || !ADDR.test(lc(k.hooks)) || !Number.isInteger(k.fee) || !Number.isInteger(k.tickSpacing)) return 'bad pool key';
  if (BigInt(c0) >= BigInt(c1)) return 'the pool key is not sorted';
  const set = [c0, c1].sort().join(), want = [lc(token), lc(quote)].sort().join();
  if (set !== want) return 'the pool is not the coin\'s pool against this quote';
  if (!LIMIT_HOOKS.includes(lc(k.hooks))) return 'This pool has a hook limit orders do not trade through (the Robinhood launcher, Doppler, DART or none)';
  if (k.fee === DYNAMIC_FEE_FLAG ? lc(k.hooks) === NATIVE_CURRENCY : (k.fee < 0 || k.fee > MAX_STATIC_FEE)) return 'the pool fee is above the ceiling';
  if (k.tickSpacing < 1 || k.tickSpacing > 32767) return 'bad tick spacing';
  return '';
}
/** the pool a native Pons curve migrates into (server/pulse-indexer.mjs attachPonsHookPool: fee 0, tick spacing 200, the
 *  Robinhood launcher hook, sorted with native ETH = 0x0 first) */
export const ponsMigrationPool = (token: string): V4PoolKey => ({ currency0: NATIVE_CURRENCY as Hex, currency1: lc(token) as Hex, fee: 0, tickSpacing: 200, hooks: PONS_HOOK });
/** the page's route proposal (GET /api/token/<t>/route → route) copied into the fields v1 uses — nothing else rides along */
export function cleanRoute(r: unknown, chain: LimitChainKey = 'robinhood'): LimitRoute {
  const o = r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : null;
  if (!o) throw new Error('Bad route');
  if (o.chainId != null && Number(o.chainId) !== LIMIT_CHAINS[chain].chainId) throw new Error('This market is on another chain');
  const bps = (v: unknown) => { const n = Number(v ?? 0); if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error('Bad route fee'); return n; };
  if (chain === 'bsc') {
    if (o.type === 'four') {
      // security audit LO-3: the helper rides along — the engine's own route check (webEngine checkRoute) refuses a four.meme route without it
      if (!ADDR.test(String(o.manager)) || !ADDR.test(String(o.helper ?? '')) || !ADDR.test(String(o.quoteToken ?? ''))) throw new Error('Bad route');
      return { type: 'four', manager: lc(o.manager) as Hex, helper: lc(o.helper) as Hex, quoteToken: lc(o.quoteToken) as Hex };
    }
    if (o.type === 'v2') {
      const path = Array.isArray(o.path) ? o.path.map(lc) : [];
      if (!ADDR.test(String(o.router)) || path.length < 2 || path.length > 3 || !path.every((a) => ADDR.test(a))) throw new Error('Bad route');
      return { type: 'v2', router: lc(o.router) as Hex, path: path as Hex[] };
    }
    throw new Error(`Limit orders on BNB Chain trade the four.meme curve and PancakeSwap V2 here (this market: ${String(o.type || '?').slice(0, 12)})`);
  }
  if (o.type === 'pons') {
    if (!ADDR.test(String(o.curve)) || !ADDR.test(String(o.pairToken))) throw new Error('Bad route');
    return { type: 'pons', curve: lc(o.curve) as Hex, pairToken: lc(o.pairToken) as Hex, feeBps: bps(o.feeBps), creatorTaxBps: bps(o.creatorTaxBps) };
  }
  if (o.type === 'v4') {
    const k = o.poolKey && typeof o.poolKey === 'object' ? o.poolKey as Record<string, unknown> : null;
    if (!k || !ADDR.test(String(k.currency0)) || !ADDR.test(String(k.currency1)) || !ADDR.test(String(k.hooks)) || !Number.isInteger(Number(k.fee)) || !Number.isInteger(Number(k.tickSpacing))) throw new Error('Bad route');
    const out: LimitRoute = { type: 'v4', pair: String(o.pair || '').slice(0, 8), poolKey: { currency0: lc(k.currency0) as Hex, currency1: lc(k.currency1) as Hex, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: lc(k.hooks) as Hex } };
    // a pool quoted in USDG or a stock (§19): its bridge from ETH rides along — the engine's route check (verifyRoute) reads
    // these same fields (start at WETH, known middle assets and tiers, end at the pool's quote), and variantsFor checks them again
    const hops = Array.isArray(o.bridgeHops) && o.bridgeHops.length ? o.bridgeHops.map(lc) : (Number(o.bridgeFee) > 0 && ADDR.test(String(o.quoteToken ?? '')) ? [WETH_RH, lc(o.quoteToken)] : []);
    if (hops.length) {
      const fees = Array.isArray(o.bridgeFees) && o.bridgeFees.length ? o.bridgeFees.map(Number) : [Number(o.bridgeFee)];
      if (hops.length > 3 || !hops.every((a) => ADDR.test(a)) || fees.length !== hops.length - 1 || !fees.every((f) => Number.isInteger(f) && f > 0 && f < 1_000_000)) throw new Error('Bad route bridge');
      out.bridgeHops = hops as Hex[]; out.bridgeFees = fees;
      if (o.quoteToken != null && o.quoteToken !== '') { if (!ADDR.test(String(o.quoteToken))) throw new Error('Bad route'); out.quoteToken = lc(o.quoteToken) as Hex; }
    }
    return out;
  }
  throw new Error(`Limit orders trade the Pons curve and Uniswap V4 pools here (this market: ${String(o.type || '?').slice(0, 12)})`);
}
/**
 * Which pre-signed variants an order gets (all on ONE nonce, at most one can ever land):
 *   a Pons curve quoted in ETH → the curve AND the V4 pool it migrates into;
 *   an ETH- or WETH-quoted V4 pool (a migrated coin)  → that pool through the Universal Router;
 *   a V4 pool quoted in USDG or a stock (§19)          → 'v4bridge': the route's V3 bridge from ETH and that pool, one call;
 *   BNB: a V2 pair quoted in another token (§19)       → 'v2bridge': [WBNB, quote, token] through the V2 router.
 * Refused: curves quoted in USDG or a stock (a curve buy is sized by what a separate bridge swap delivered: two transactions).
 */
export function variantsFor(route: LimitRoute, token: string, chainRead: { creatorTaxBps?: number; v4LpFee?: number } = {}): Variant[] {
  const t = lc(token);
  // BNB Chain: the four.meme curve (BNB-quoted) AND the PancakeSwap V2 WBNB pair it lists into; or that V2 pair alone.
  // The addresses are fixed here, never the page's: a route naming another manager or router is refused.
  const migratedV2 = (migrates: boolean): Variant => ({ venue: 'v2', router: PANCAKE_V2 as Hex, path: [WBNB as Hex, t as Hex], taxBps: PANCAKE_V2_FEE_BPS, migrates });
  if (route.type === 'four') {
    if (lc(route.manager) !== FOUR_MANAGER || lc(route.helper) !== FOUR_HELPER) throw new Error('Not the four.meme deployment');
    if (lc(route.quoteToken) !== NATIVE_CURRENCY) throw new Error('This curve is quoted in a token, not BNB — limit orders trade BNB-quoted markets only (v1)');
    return [{ venue: 'four', manager: FOUR_MANAGER as Hex, taxBps: FOUR_FEE_BPS }, migratedV2(true)];
  }
  if (route.type === 'v2') {
    if (lc(route.router) !== PANCAKE_V2) throw new Error('Not the PancakeSwap V2 router');
    // §19: a pair quoted in another token — one V2 swap over [WBNB, quote, token], recipient the main wallet, the floor on the
    // coin (the router's only minimum). Two V2 hops: 2 × 0.25 % into the floor.
    if (route.path.length === 3) {
      const q = lc(route.path[1]);
      if (lc(route.path[0]) !== WBNB || lc(route.path[2]) !== t || q === WBNB || q === t || q === NATIVE_CURRENCY) throw new Error('This V2 path does not run WBNB → its quote → this coin');
      return [{ venue: 'v2bridge', router: PANCAKE_V2 as Hex, quote: q as Hex, taxBps: feesBps([PANCAKE_V2_FEE_BPS * 100, PANCAKE_V2_FEE_BPS * 100]) }];
    }
    if (route.path.length !== 2 || lc(route.path[0]) !== WBNB || lc(route.path[1]) !== t) throw new Error('This pool is not the coin\'s WBNB pair — limit orders trade BNB-quoted markets here');
    return [migratedV2(false)];
  }
  if (route.type === 'pons') {
    if (lc(route.pairToken) !== NATIVE_CURRENCY) throw new Error('This curve is quoted in a stock or USDG — limit orders trade ETH-quoted markets only (v1)');
    // review L1: the vault's own registry read of the creator tax (word 7) and the platform's fixed fee, never the page's numbers
    const creator = chainRead.creatorTaxBps != null ? chainRead.creatorTaxBps : route.creatorTaxBps;
    if (!Number.isInteger(creator) || creator < 0 || creator > 10_000) throw new Error('Bad creator tax');
    return [{ venue: 'curve', curve: route.curve, taxBps: Math.min(TAX_CAP_BPS, PONS_FEE_BPS + creator) }, { venue: 'v4', poolKey: ponsMigrationPool(t), pair: 'native', migrates: true, taxBps: Math.min(TAX_CAP_BPS, PONS_FEE_BPS + creator) }];
  }
  const k = route.poolKey; const cs = [lc(k.currency0), lc(k.currency1)];
  if (!cs.includes(t)) throw new Error('The pool does not contain this token');
  if (!LIMIT_HOOKS.includes(lc(k.hooks))) throw new Error('This pool has a hook limit orders do not trade through (v1: the Robinhood launcher, Doppler, DART or none)');
  const other = cs[0] === t ? cs[1] : cs[0];
  const pair = other === NATIVE_CURRENCY ? 'native' : other === WETH_RH ? 'weth' : null;
  // the Robinhood launcher's hook takes the Pons fee + the coin's creator tax on every swap: it counts into the floor (the
  // vault's own registry read, never the page's figure); another hook or none: no tax
  const hookTax = lc(k.hooks) === LIMIT_HOOKS[0] && chainRead.creatorTaxBps != null && Number.isInteger(chainRead.creatorTaxBps) && chainRead.creatorTaxBps >= 0 && chainRead.creatorTaxBps <= 10_000
    ? { taxBps: Math.min(TAX_CAP_BPS, PONS_FEE_BPS + chainRead.creatorTaxBps) } : {};
  if (pair) return [{ venue: 'v4', poolKey: { ...k }, pair, migrates: false, ...hookTax }];
  // §19: a pool quoted in USDG or a stock — ETH → V3 bridge → quote → this pool, one Universal Router call
  if (route.quoteToken && lc(route.quoteToken) !== other) throw new Error('The route\'s quote asset is not in the pool');
  if (!route.bridgeHops || !route.bridgeHops.length) throw new Error('This pool is quoted in a stock or USDG and the route names no way from ETH to it');
  const why = bridgeProblem(route.bridgeHops, route.bridgeFees, other) || bridgePoolProblem(k, t, other);
  if (why) throw new Error(why.charAt(0).toUpperCase() + why.slice(1));
  // the floor counts both legs' pool fees: each V3 tier and the V4 fee (a dynamic-fee pool: its current LP fee, read on chain)
  const v4Fee = k.fee === DYNAMIC_FEE_FLAG ? Math.max(0, Math.min(MAX_STATIC_FEE, Math.floor(Number(chainRead.v4LpFee) || 0))) : k.fee;
  return [{ venue: 'v4bridge', poolKey: { ...k }, quote: other as Hex, hops: route.bridgeHops.map(lc) as Hex[], fees: [...(route.bridgeFees as number[])], taxBps: feesBps([...(route.bridgeFees as number[]), v4Fee]) }];
}

// ── calldata (recipient = the main wallet wherever the venue lets us name it) ──
export const PONS_ABI = parseAbi(['function buy(uint256 amountIn, uint256 minOut, address to) payable', 'function sell(uint256 amountIn, uint256 minOut, address to)']);
export const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
export const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
export const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const POOL_KEY_T = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;
const swapSingle = (pk: V4PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint) => encodeAbiParameters(
  [{ type: 'tuple', components: [{ name: 'poolKey', ...POOL_KEY_T }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  [{ poolKey: pk, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }]);
const v4Swap = (actions: number[], params: Hex[]) => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
const ca = (currency: string, amount: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency as Hex, amount]);
const take = (currency: string, recipient: string) => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency as Hex, recipient as Hex, OPEN_DELTA]);
/** Universal Router V4 swap paying `recipient` (TAKE, not TAKE_ALL — TAKE_ALL pays msg.sender, the order wallet) */
export function v4Calldata(o: { side: 'buy' | 'sell'; poolKey: V4PoolKey; pair: 'native' | 'weth'; token: string; amountIn: bigint; minOut: bigint; recipient: string; deadline: bigint }): Hex {
  const pk = o.poolKey, t = lc(o.token);
  let commands: number[]; let inputs: Hex[];
  if (o.side === 'buy') {
    if (o.pair === 'native') {
      commands = [Commands.V4_SWAP];
      inputs = [v4Swap([Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE], [swapSingle(pk, lc(pk.currency0) === NATIVE_CURRENCY, o.amountIn, o.minOut), ca(NATIVE_CURRENCY, o.amountIn), take(t, o.recipient)])];
    } else {
      commands = [Commands.WRAP_ETH, Commands.V4_SWAP];
      inputs = [ca(ADDRESS_THIS, o.amountIn), v4Swap([Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE], [
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [WETH_RH as Hex, CONTRACT_BALANCE, false]),
        swapSingle(pk, lc(pk.currency0) === WETH_RH, OPEN_DELTA, o.minOut), take(t, o.recipient)])];
    }
  } else if (o.pair === 'native') {
    commands = [Commands.V4_SWAP];
    inputs = [v4Swap([Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE], [swapSingle(pk, lc(pk.currency0) === t, o.amountIn, o.minOut), ca(t, o.amountIn), take(NATIVE_CURRENCY, o.recipient)])];
  } else {
    commands = [Commands.V4_SWAP, Commands.UNWRAP_WETH];
    inputs = [v4Swap([Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE], [swapSingle(pk, lc(pk.currency0) === t, o.amountIn, o.minOut), ca(t, o.amountIn), take(WETH_RH, ADDRESS_THIS)]), ca(o.recipient, o.minOut)];
  }
  return encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [toHex(new Uint8Array(commands)), inputs, o.deadline] });
}
const v3In = (amountIn: bigint, minOut: bigint, path: Hex) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [ADDRESS_THIS as Hex, amountIn, minOut, path, false]);
/**
 * §19: a V4 pool quoted in USDG or a stock, from / to ETH in ONE Universal Router call — the frozen engine's market shape
 * (evmV4Router encodeV4BuyViaPath / encodeV4SellViaPath) with the payout taken to `recipient` (TAKE / UNWRAP_WETH, never
 * TAKE_ALL, which would pay the order wallet) and the floor on the LAST leg only:
 *   buy : WRAP_ETH(router, amountIn) → V3_SWAP_EXACT_IN(router, amountIn, 0, WETH→…→quote, payerIsUser false)
 *         → V4_SWAP[SETTLE(quote, CONTRACT_BALANCE, false), SWAP_EXACT_IN_SINGLE(OPEN_DELTA, minOut), TAKE(token, recipient)]
 *   sell: V4_SWAP[SWAP_EXACT_IN_SINGLE(amountIn, 0), SETTLE_ALL(token, amountIn), TAKE(quote, router)]
 *         → V3_SWAP_EXACT_IN(router, CONTRACT_BALANCE, minOut, quote→…→WETH, false) → UNWRAP_WETH(recipient, minOut)
 * The keeper rebuilds exactly these bytes from the posted order (checkPosted) and refuses any other.
 */
export function bridgeCalldata(o: { side: 'buy' | 'sell'; poolKey: V4PoolKey; quote: string; hops: string[]; fees: number[]; token: string; amountIn: bigint; minOut: bigint; recipient: string; deadline: bigint }): Hex {
  const pk = o.poolKey, t = lc(o.token), q = lc(o.quote);
  let commands: number[]; let inputs: Hex[];
  if (o.side === 'buy') {
    commands = [Commands.WRAP_ETH, Commands.V3_SWAP_EXACT_IN, Commands.V4_SWAP];
    inputs = [ca(ADDRESS_THIS, o.amountIn), v3In(o.amountIn, 0n, v3Path(o.hops, o.fees)), v4Swap([Actions.SETTLE, Actions.SWAP_EXACT_IN_SINGLE, Actions.TAKE], [
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [q as Hex, CONTRACT_BALANCE, false]),
      swapSingle(pk, lc(pk.currency0) === q, OPEN_DELTA, o.minOut), take(t, o.recipient)])];
  } else {
    commands = [Commands.V4_SWAP, Commands.V3_SWAP_EXACT_IN, Commands.UNWRAP_WETH];
    inputs = [
      v4Swap([Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE], [swapSingle(pk, lc(pk.currency0) === t, o.amountIn, 0n), ca(t, o.amountIn), take(q, ADDRESS_THIS)]),
      v3In(CONTRACT_BALANCE, o.minOut, v3Path([...o.hops].reverse(), [...o.fees].reverse())),
      ca(o.recipient, o.minOut),
    ];
  }
  return encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [toHex(new Uint8Array(commands)), inputs, o.deadline] });
}
/** what a bridged variant posts (PostedBridge), and the variant back from it (the keeper's side) */
export const bridgeOf = (v: Variant): PostedBridge | null =>
  v.venue === 'v4bridge' ? { quote: lc(v.quote) as Hex, hops: v.hops.map(lc) as Hex[], fees: [...v.fees], poolKey: { currency0: lc(v.poolKey.currency0) as Hex, currency1: lc(v.poolKey.currency1) as Hex, fee: v.poolKey.fee, tickSpacing: v.poolKey.tickSpacing, hooks: lc(v.poolKey.hooks) as Hex } }
    : v.venue === 'v2bridge' ? { quote: lc(v.quote) as Hex, hops: [WBNB as Hex, lc(v.quote) as Hex], fees: [] } : null;
// four.meme: the overload that names the recipient (checked on mainnet 2026-10-25: 0x7f79f6df on the manager's implementation)
export const FOUR_ABI = parseAbi(['function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) payable']);
export const PANCAKE_V2_ABI = parseAbi([
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
/** a four.meme coin cannot be moved between wallets before it lists (its token is in transfer-restricted mode), so a sell
 *  order cannot fund its order wallet: refused up front, with the reason */
export const FOUR_SELL_REFUSED = 'Sell orders on a four.meme curve open once the coin lists on PancakeSwap (before that the coin cannot move to the order wallet)';
/** one swap variant as a call from the order wallet */
export function swapCall(v: Variant, o: { side: 'buy' | 'sell'; token: string; amountIn: bigint; minOut: bigint; recipient: string; deadline: bigint }): { to: Hex; data: Hex; value: bigint } {
  if (v.venue === 'four') {
    if (o.side !== 'buy') throw new Error(FOUR_SELL_REFUSED);
    return { to: v.manager, data: encodeFunctionData({ abi: FOUR_ABI, functionName: 'buyTokenAMAP', args: [lc(o.token) as Hex, o.recipient as Hex, o.amountIn, o.minOut] }), value: o.amountIn };
  }
  if (v.venue === 'v2' || v.venue === 'v2bridge') {
    const t = lc(o.token) as Hex;
    const path = (v.venue === 'v2bridge' ? [WBNB, lc(v.quote), t] : [WBNB, t]) as Hex[];
    return o.side === 'buy'
      ? { to: v.router, data: encodeFunctionData({ abi: PANCAKE_V2_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [o.minOut, path, o.recipient as Hex, o.deadline] }), value: o.amountIn }
      : { to: v.router, data: encodeFunctionData({ abi: PANCAKE_V2_ABI, functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens', args: [o.amountIn, o.minOut, [...path].reverse(), o.recipient as Hex, o.deadline] }), value: 0n };
  }
  if (v.venue === 'v4bridge') return { to: UR, data: bridgeCalldata({ side: o.side, poolKey: v.poolKey, quote: v.quote, hops: v.hops, fees: v.fees, token: o.token, amountIn: o.amountIn, minOut: o.minOut, recipient: o.recipient, deadline: o.deadline }), value: o.side === 'buy' ? o.amountIn : 0n };
  if (v.venue === 'curve') return { to: v.curve, data: encodeFunctionData({ abi: PONS_ABI, functionName: o.side, args: [o.amountIn, o.minOut, o.recipient as Hex] }), value: o.side === 'buy' ? o.amountIn : 0n };
  return { to: UR, data: v4Calldata({ side: o.side, poolKey: v.poolKey, pair: v.pair, token: o.token, amountIn: o.amountIn, minOut: o.minOut, recipient: o.recipient, deadline: o.deadline }), value: o.side === 'buy' ? o.amountIn : 0n };
}
/** the approvals a sell needs from the order wallet, exact amounts: the curve pulls the token itself; the Universal Router
 *  pulls through Permit2 (token → Permit2, then Permit2 → router, expiring an hour after the order) */
export function sellApprovals(variants: Variant[], token: string, amountIn: bigint, expirySec: bigint): { to: Hex; data: Hex; value: bigint; what: string }[] {
  const out: { to: Hex; data: Hex; value: bigint; what: string }[] = [];
  const t = lc(token) as Hex;
  if (variants.some((v) => v.venue === 'four')) throw new Error(FOUR_SELL_REFUSED);
  for (const v of variants) if (v.venue === 'curve') out.push({ to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [v.curve, amountIn] }), value: 0n, what: 'approve-curve' });
  for (const v of variants) if (v.venue === 'v2' || v.venue === 'v2bridge') out.push({ to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [v.router, amountIn] }), value: 0n, what: 'approve-v2' });
  if (variants.some((v) => v.venue === 'v4' || v.venue === 'v4bridge')) {
    out.push({ to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [P2, amountIn] }), value: 0n, what: 'approve-permit2' });
    if (amountIn >= 1n << 160n) throw new Error('Amount too large');
    out.push({ to: P2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [t, UR, amountIn, Number(expirySec + 3600n)] }), value: 0n, what: 'approve-router' });
  }
  return out;
}
export const transferData = (to: string, amount: bigint) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to as Hex, amount] });
/**
 * Review M2: the pre-post check proves that the swap PAYS THE MAIN WALLET, not only that it does not revert. eth_call to the
 * order wallet with this code as a state override (nothing is deployed): it reads `who`'s balance (ETH, or `token`'s
 * balanceOf), calls `target` as the order wallet (msg.sender = the order wallet, its real balance and allowances) with
 * `value` from its own balance and the inner calldata, reads the balance again and returns after − before (a revert comes
 * back as the target's revert). Calldata: target (20) | token (20, 0 = ETH) | who (20) | value (32) | inner calldata.
 * Assembled by scripts/limit-orders.test.mjs (the listing is there); executed for real in the fork test.
 */
export const DELTA_PROBE_CODE = '0x60143560601c8015610038576370a0823160e01b60005260283560601c6004526020600060246000845afa156100af5750600051610041565b5060283560601c315b605c360380605c60003760006000826000603c3560003560601c5af1156100af575060143560601c801561009c576370a0823160e01b60005260283560601c6004526020600060246000845afa156100af57506000516100a5565b5060283560601c315b0360005260206000f35b3d600060003e3d6000fd' as Hex;
export const deltaProbeData = (target: string, token: string | null, who: string, value: bigint, inner: Hex): Hex =>
  ('0x' + lc(target).slice(2) + lc(token || NATIVE_CURRENCY).slice(2) + lc(who).slice(2) + value.toString(16).padStart(64, '0') + inner.slice(2)) as Hex;

// ── what the vault posts and the keeper keeps ──
export type SignedTx = { nonce: number; role: 'approve' | 'swap'; venue: Venue | 'approve-curve' | 'approve-permit2' | 'approve-router' | 'approve-v2'; raw: Hex };
export type PostedOrder = {
  v: 1; id: string; chain: string; wallet: Hex; orderWallet: Hex; token: Hex; symbol: string; decimals: number;
  side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; amountIn: string;
  minOut: Record<string, string>; slippageBps: number; expiry: number; createdAt: number; txs: SignedTx[];
  /** §19: a bridged order only (venue v4bridge / v2bridge) */
  bridge?: PostedBridge;
};
/** the digest the auth text names: sha256 of the order in a fixed key order (a bridged order adds its bridge last, so the
 *  digest of every other order is what it always was) */
export function orderDigest(o: PostedOrder): string {
  const c: unknown[] = [o.v, o.id, o.chain, lc(o.wallet), lc(o.orderWallet), lc(o.token), o.symbol, o.decimals, o.side, o.kind, o.price, o.amount, o.amountIn,
    Object.keys(o.minOut).sort().map((k) => [k, o.minOut[k]]), o.slippageBps, o.expiry, o.createdAt, o.txs.map((t) => [t.nonce, t.role, t.venue, lc(t.raw)])];
  if (o.bridge) {
    const b = o.bridge, k = b.poolKey;
    c.push(['bridge', lc(b.quote), (b.hops || []).map(lc), (b.fees || []).map(Number), k ? [lc(k.currency0), lc(k.currency1), Number(k.fee), Number(k.tickSpacing), lc(k.hooks)] : null]);
  }
  return sha256(toBytes(JSON.stringify(c))).slice(2);
}
/** the keeper's reading of a posted bridge: exact keys, the chain's rules (Robinhood: WETH → (USDG) → quote on known V3 tiers
 *  into a sane V4 pool of exactly this coin and this quote; BNB: [WBNB, quote] with no fees and no pool), normalised */
export function cleanBridge(b: unknown, chain: LimitChainKey, token: string): PostedBridge {
  const bad = (why: string): never => { throw Object.assign(new Error('bad bridge: ' + why), { status: 400 }); };
  const r = b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : bad('not an object');
  for (const k of Object.keys(r)) if (!['quote', 'hops', 'fees', 'poolKey'].includes(k)) bad('unknown field ' + k.slice(0, 20));
  if (!ADDR.test(String(r.quote)) || !Array.isArray(r.hops) || !Array.isArray(r.fees)) bad('shape');
  const quote = lc(r.quote) as Hex, hops = (r.hops as unknown[]).map(lc) as Hex[], fees = (r.fees as unknown[]).map((f) => (Number.isInteger(f) ? f as number : -1));
  if (chain === 'bsc') {
    if (r.poolKey !== undefined) bad('a V2 path has no pool key');
    if (hops.length !== 2 || hops[0] !== WBNB || hops[1] !== quote || fees.length) bad('a V2 bridge is [WBNB, quote]');
    if (quote === WBNB || quote === NATIVE_CURRENCY || quote === lc(token)) bad('the quote is not another token');
    return { quote, hops, fees: [] };
  }
  const why = bridgeProblem(hops, fees, quote); if (why) bad(why);
  const k = r.poolKey && typeof r.poolKey === 'object' && !Array.isArray(r.poolKey) ? r.poolKey as Record<string, unknown> : bad('no pool key');
  for (const x of Object.keys(k)) if (!['currency0', 'currency1', 'fee', 'tickSpacing', 'hooks'].includes(x)) bad('pool key field ' + x.slice(0, 20));
  const poolKey: V4PoolKey = { currency0: lc(k.currency0) as Hex, currency1: lc(k.currency1) as Hex, fee: Number.isInteger(k.fee) ? k.fee as number : -1, tickSpacing: Number.isInteger(k.tickSpacing) ? k.tickSpacing as number : 0, hooks: lc(k.hooks) as Hex };
  const pw = bridgePoolProblem(poolKey, token, quote); if (pw) bad(pw);
  return { quote, hops, fees, poolKey };
}
/** the one calldata a bridged variant of this order may carry (rebuilt from the order alone: recipient = the main wallet,
 *  amount = amountIn, floor = minOut[venue] on the last leg, deadline = the expiry) */
export function bridgeCallOf(order: PostedOrder, venue: 'v4bridge' | 'v2bridge'): { to: Hex; data: Hex; value: bigint } {
  const b = order.bridge;
  if (!b) throw new Error('no bridge');
  const v: Variant = venue === 'v4bridge'
    ? { venue, poolKey: b.poolKey as V4PoolKey, quote: b.quote, hops: b.hops, fees: b.fees, taxBps: 0 }
    : { venue, router: PANCAKE_V2 as Hex, quote: b.quote, taxBps: 0 };
  return swapCall(v, { side: order.side, token: order.token, amountIn: BigInt(order.amountIn), minOut: BigInt(order.minOut[venue]), recipient: order.wallet, deadline: BigInt(Math.floor(order.expiry / 1000)) });
}
export const AUTH_HEAD = 'motion limit orders v1';
export type AuthAction = 'place' | 'cancel' | 'read';
/** the one text the main wallet signs for our server (personal_sign); nothing else is ever signed for it */
export function authText(a: { action: AuthAction; chain: string; wallet: string; at: number; id?: string; orderWallet?: string; digest?: string }): string {
  const lines = [AUTH_HEAD, `action: ${a.action}`, `chain: ${a.chain}`, `wallet: ${lc(a.wallet)}`];
  if (a.action !== 'read') lines.push(`order: ${a.id}`);
  if (a.action === 'place') lines.push(`order wallet: ${lc(a.orderWallet)}`, `digest: ${a.digest}`);
  lines.push(`at: ${a.at}`);
  return lines.join('\n');
}
/** why a text is not one of the three auth texts for this wallet (the vault refuses to sign anything else); '' = fine */
export function authTextProblem(text: string, wallet: string, chain?: LimitChainKey): string {
  if (typeof text !== 'string' || text.length > 600) return 'not a limit-order text';
  if (chain && !text.includes(`\nchain: ${chain}\n`)) return 'another chain';
  const m = /^motion limit orders v1\naction: (place|cancel|read)\nchain: (?:robinhood|bsc)\nwallet: (0x[0-9a-f]{40})\n(?:order: ([0-9a-f]{32})\n(?:order wallet: (0x[0-9a-f]{40})\ndigest: ([0-9a-f]{64})\n)?)?at: (\d{13})$/.exec(text);
  if (!m) return 'not a limit-order text';
  if (m[2] !== lc(wallet)) return 'another wallet';
  const action = m[1];
  if (action === 'read' && m[3]) return 'not a limit-order text';
  if (action === 'cancel' && (!m[3] || m[4])) return 'not a limit-order text';
  if (action === 'place' && !(m[3] && m[4] && m[5])) return 'not a limit-order text';
  return '';
}
/** the keeper's check of a posted order (the vault makes them right; this keeps the server from storing junk or another
 *  wallet's bytes): exact fields, every tx a legacy Robinhood tx SIGNED BY THE ORDER WALLET, approvals below one swap nonce
 *  shared by every variant, a buy's value = its size ≥ 0.0005 ETH */
export async function checkPosted(o: unknown, now: number, chain: LimitChainKey = 'robinhood'): Promise<{ order: PostedOrder; swapNonce: number; hashes: Record<string, string>; need: { eth: bigint; token: bigint } }> {
  const bad = (why: string): never => { throw Object.assign(new Error(why), { status: 400 }); };
  const r = o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : bad('bad order');
  const keys = ['v', 'id', 'chain', 'wallet', 'orderWallet', 'token', 'symbol', 'decimals', 'side', 'kind', 'price', 'amount', 'amountIn', 'minOut', 'slippageBps', 'expiry', 'createdAt', 'txs', 'bridge'];
  for (const k of Object.keys(r)) if (!keys.includes(k)) bad('unknown field ' + k.slice(0, 20));
  const P = LIMIT_CHAINS[chain]; const venuesOk = CHAIN_VENUES[chain];
  if (r.v !== 1 || r.chain !== chain || !ORDER_ID.test(String(r.id))) bad('bad order');
  for (const k of ['wallet', 'orderWallet', 'token']) if (!ADDR.test(String(r[k]))) bad('bad ' + k);
  if (lc(r.wallet) === lc(r.orderWallet)) bad('bad order wallet');
  if (typeof r.symbol !== 'string' || r.symbol.length > 24) bad('bad symbol');
  if (!Number.isInteger(r.decimals) || (r.decimals as number) < 0 || (r.decimals as number) > 36) bad('bad decimals');
  if (!((r.side === 'buy' && r.kind === 'limit') || (r.side === 'sell' && (r.kind === 'tp' || r.kind === 'sl')))) bad('bad side / kind');
  try { parseDecimal(r.price); } catch { bad('bad price'); }
  if (typeof r.amount !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(r.amount) || typeof r.amountIn !== 'string' || !/^\d{1,78}$/.test(r.amountIn)) bad('bad amount');
  const amountIn = BigInt(r.amountIn as string);
  if (!Number.isInteger(r.slippageBps) || (r.slippageBps as number) < SLIP_MIN_BPS || (r.slippageBps as number) > SLIP_MAX_BPS) bad('bad slippage');
  const mo = r.minOut && typeof r.minOut === 'object' && !Array.isArray(r.minOut) ? r.minOut as Record<string, unknown> : bad('bad minOut');
  for (const [k, v] of Object.entries(mo)) if (!(venuesOk as string[]).includes(k) || typeof v !== 'string' || !/^\d{1,78}$/.test(v) || BigInt(v) <= 0n) bad('bad minOut');
  if (!Number.isSafeInteger(r.expiry) || !Number.isSafeInteger(r.createdAt)) bad('bad expiry');
  const left = (r.expiry as number) - now;
  if (left < MIN_EXPIRY_S * 1000 - 15 * 60_000 || (r.expiry as number) - (r.createdAt as number) > MAX_EXPIRY_S * 1000 + 60_000 || (r.createdAt as number) > now + 120_000) bad('expiry must be 1 h to 7 d away');
  const txs = Array.isArray(r.txs) ? r.txs : bad('bad txs');
  if (!txs.length || txs.length > 8) bad('bad txs');
  const out: SignedTx[] = []; const hashes: Record<string, string> = {};
  let swapNonce = -1; const venues = new Set<string>(); let needEth = 0n;
  for (const t of txs) {
    const x = t && typeof t === 'object' ? t as Record<string, unknown> : bad('bad tx');
    for (const k of Object.keys(x)) if (!['nonce', 'role', 'venue', 'raw'].includes(k)) bad('bad tx');
    if (!Number.isInteger(x.nonce) || (x.nonce as number) < 0 || (x.nonce as number) > 32) bad('bad nonce');
    if (typeof x.raw !== 'string' || !/^0x[0-9a-fA-F]{2,}$/.test(x.raw) || x.raw.length > 2 + 2 * MAX_RAW_BYTES) bad('bad raw tx (at most 4 KB)');
    const raw = lc(x.raw) as Hex;
    let p: ReturnType<typeof parseTransaction>;
    try { p = parseTransaction(raw); } catch { return bad('unreadable tx'); }
    if (p.type !== 'legacy' || Number(p.chainId) !== P.chainId || Number(p.nonce) !== x.nonce || !p.to) bad(`not a ${P.name} legacy tx`);
    if ((p.gasPrice ?? 0n) > P.maxGasPrice || (p.gas ?? 0n) > MAX_GAS_LIMIT) bad('gas out of range');
    const signer = await recoverTransactionAddress({ serializedTransaction: raw as never }).catch(() => '');
    if (lc(signer) !== lc(r.orderWallet)) bad('a tx is not signed by the order wallet');
    if (x.role === 'swap') {
      if (!(venuesOk as string[]).includes(String(x.venue)) || venues.has(String(x.venue))) bad('bad swap venue');
      venues.add(String(x.venue));
      if (swapNonce < 0) swapNonce = x.nonce as number; else if (swapNonce !== x.nonce) bad('every swap variant must share one nonce');
      if (!(String(x.venue) in mo)) bad('a variant without its minOut');
      if (r.side === 'buy' && (p.value ?? 0n) !== amountIn) bad('the buy does not spend its size');
      if (r.side === 'sell' && (p.value ?? 0n) !== 0n) bad('a sell carries no value');
      if (x.venue === 'v4' && lc(p.to) !== UR) bad('the V4 variant goes through the Universal Router');
      if (x.venue === 'v2' && lc(p.to) !== PANCAKE_V2) bad('the V2 variant goes through the PancakeSwap V2 router');
      if (x.venue === 'four' && (lc(p.to) !== FOUR_MANAGER || r.side !== 'buy')) bad('the four.meme variant is a buy through its manager');
    } else if (x.role === 'approve') {
      const approvesOk = chain === 'bsc' ? ['approve-v2'] : ['approve-curve', 'approve-permit2', 'approve-router'];
      if (!approvesOk.includes(String(x.venue)) || (p.value ?? 0n) !== 0n) bad('bad approval');
    } else bad('bad role');
    hashes[keccak256(raw)] = String(x.venue);
    if (x.role === 'swap') { const c = (p.value ?? 0n) + (p.gas ?? 0n) * (p.gasPrice ?? 0n); if (c > needEth) needEth = c; }
    out.push({ nonce: x.nonce as number, role: x.role as SignedTx['role'], venue: x.venue as SignedTx['venue'], raw });
  }
  if (swapNonce < 0) bad('no swap');
  for (const t of out) if (t.role === 'approve' && t.nonce >= swapNonce) bad('approvals come before the swap');
  const order = { ...(r as unknown as PostedOrder), wallet: lc(r.wallet) as Hex, orderWallet: lc(r.orderWallet) as Hex, token: lc(r.token) as Hex, txs: out };
  // §19: a bridged order — its only swap is the bridged variant, and its calldata must be EXACTLY the one rebuilt from the order
  // (commands, the V3 path WETH → quote, the V4 pool key, amounts, the last leg's floor, recipient = the main wallet, deadline):
  // a wrong quote, another pool, another recipient, an extra or a missing leg, a floor on a middle leg — any other byte — is refused
  const bridged = [...venues].filter((x) => (BRIDGE_VENUES as string[]).includes(x));
  if (r.bridge !== undefined && !bridged.length) bad('a bridge without its variant');
  if (bridged.length) {
    if (venues.size !== 1) bad('a bridged order has one swap variant');
    if (Object.keys(mo).length !== 1) bad('a variant without its minOut');
    order.bridge = cleanBridge(r.bridge, chain, order.token);
    const venue = bridged[0] as 'v4bridge' | 'v2bridge';
    const want = bridgeCallOf(order, venue);
    for (const t of out.filter((x) => x.role === 'swap')) {
      const p = parseTransaction(t.raw);
      if (lc(p.to) !== want.to || lc(p.data || '0x') !== lc(want.data) || (p.value ?? 0n) !== want.value) bad('the bridged swap is not the one this order describes');
    }
    if (order.side === 'sell') for (const t of out.filter((x) => x.role === 'approve')) if (venue === 'v2bridge' ? t.venue !== 'approve-v2' : !['approve-permit2', 'approve-router'].includes(t.venue)) bad('bad approval');
  } else delete (order as { bridge?: unknown }).bridge;
  const size = order.side === 'buy' ? amountIn : notionalWei(amountIn, order.price, order.decimals);
  if (size < P.minSize) bad(`below the ${fromUnits(P.minSize, 18)} ${P.native} minimum`);
  // what the order wallet must hold for its swap to be includable (review H2: checked on chain at POST)
  return { order, swapNonce, hashes, need: { eth: needEth, token: order.side === 'sell' ? amountIn : 0n } };
}

// ── the vault's argument allow-lists (one plain object per method; any other key is refused) ──
const WID = /^[A-Za-z0-9_.:-]{1,80}$/;
const IDEM = /^[A-Za-z0-9_.:-]{8,100}$/;
function shape(o: unknown, allowed: string[], required: string[]) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one object');
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!allowed.includes(k)) throw new Error('Bad arguments: unknown field ' + k.slice(0, 20));
  for (const k of required) if (r[k] == null || r[k] === '') throw new Error('Bad arguments: ' + k + ' is required');
  if (r.walletId != null && !WID.test(String(r.walletId))) throw new Error('Bad arguments: walletId');
  if (r.idempotencyKey != null && !IDEM.test(String(r.idempotencyKey))) throw new Error('Bad arguments: idempotencyKey (8–100 of A–Z a–z 0–9 _ . : -)');
  if (r.orderId != null && !ORDER_ID.test(String(r.orderId))) throw new Error('Bad arguments: orderId');
  if (r.token != null && !ADDR.test(String(r.token))) throw new Error('Bad arguments: token');
  if (r.swapNonce != null && (!Number.isInteger(r.swapNonce) || (r.swapNonce as number) < 0 || (r.swapNonce as number) > 32)) throw new Error('Bad arguments: swapNonce');
  return r;
}
export type PlaceArgs = { walletId: string; token: Hex; side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; slippageBps: number; expiresIn: number; route: LimitRoute; idempotencyKey: string };
export type OrderRefArgs = { walletId: string; orderId: string; token?: Hex; swapNonce?: number; idempotencyKey?: string };
export const limitArgs = {
  place(o: unknown, chain: LimitChainKey = 'robinhood'): PlaceArgs {
    const r = shape(o, ['walletId', 'token', 'side', 'kind', 'price', 'amount', 'slippageBps', 'expiresIn', 'route', 'idempotencyKey'], ['walletId', 'token', 'side', 'kind', 'price', 'amount', 'expiresIn', 'route', 'idempotencyKey']);
    if (!((r.side === 'buy' && r.kind === 'limit') || (r.side === 'sell' && (r.kind === 'tp' || r.kind === 'sl')))) throw new Error('Bad arguments: side / kind (buy + limit, sell + tp | sl)');
    parseDecimal(r.price);
    if (typeof r.amount !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(r.amount)) throw new Error('Bad arguments: amount (a decimal string)');
    const slippageBps = r.slippageBps == null ? SLIP_DEFAULT_BPS : Number(r.slippageBps);
    if (!Number.isInteger(slippageBps) || slippageBps < SLIP_MIN_BPS || slippageBps > SLIP_MAX_BPS) throw new Error(`Bad arguments: slippageBps (${SLIP_MIN_BPS}–${SLIP_MAX_BPS})`);
    if (!Number.isInteger(r.expiresIn) || (r.expiresIn as number) < MIN_EXPIRY_S || (r.expiresIn as number) > MAX_EXPIRY_S) throw new Error('Bad arguments: expiresIn (3600–604800 seconds)');
    return { walletId: String(r.walletId), token: lc(r.token) as Hex, side: r.side as 'buy' | 'sell', kind: r.kind as PlaceArgs['kind'], price: String(r.price), amount: String(r.amount), slippageBps, expiresIn: r.expiresIn as number, route: cleanRoute(r.route, chain), idempotencyKey: String(r.idempotencyKey) };
  },
  cancel(o: unknown): OrderRefArgs { const r = shape(o, ['walletId', 'orderId', 'token', 'swapNonce', 'idempotencyKey'], ['walletId', 'orderId', 'idempotencyKey']); return { walletId: String(r.walletId), orderId: String(r.orderId), ...(r.token ? { token: lc(r.token) as Hex } : {}), ...(r.swapNonce != null ? { swapNonce: r.swapNonce as number } : {}), idempotencyKey: String(r.idempotencyKey) }; },
  sweep(o: unknown): OrderRefArgs { const r = shape(o, ['walletId', 'orderId', 'token', 'swapNonce', 'idempotencyKey'], ['walletId', 'orderId']); return { walletId: String(r.walletId), orderId: String(r.orderId), ...(r.token ? { token: lc(r.token) as Hex } : {}), ...(r.swapNonce != null ? { swapNonce: r.swapNonce as number } : {}), ...(r.idempotencyKey ? { idempotencyKey: String(r.idempotencyKey) } : {}) }; },
  list(o: unknown): { walletId?: string } { const r = shape(o ?? {}, ['walletId'], []); return r.walletId ? { walletId: String(r.walletId) } : {}; },
};
/** the page-facing method names (bridge.js / app-bridge.js) → the engine's limit.<m> */
export const LIMIT_BRIDGE = { limitPlace: 'place', limitCancel: 'cancel', limitList: 'list', limitSweep: 'sweep' } as const;
