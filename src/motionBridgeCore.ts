// motion's own instant cross-chain bridge — the PURE core, shared byte for byte by the vault (src/bridgeSolver.ts) and
// the solver (trench server/motion-bridge.mjs). Design: trench docs/drafts/MOTION-BRIDGE.md.
//
// The model in one paragraph: the user's money never leaves their own key's wallets except by their own signature, for
// exactly the amount a signed quote names. The vault asks the solver for a quote (source chain + stablecoin + amount →
// destination chain + native amount, recipient = the SAME key's trading wallet W on the destination chain, expiry,
// nonce), checks the quote's ed25519 signature against a public key pinned in the engine, pre-signs the source transfer
// (R → the solver's published deposit address, exactly the quoted amount) and hands the solver the RAW SIGNED bytes.
// The solver re-checks those bytes against its own quote, broadcasts them, and pays the destination native to W as soon
// as the source transaction is INCLUDED. If it cannot pay, it refunds the source amount to R. Nothing here keeps a key,
// reads a clock or touches the network: both sides run the same functions, so what the tests prove is what runs.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

// ── chains ──
export type BridgeChain = 'robinhood' | 'bsc' | 'sol' | 'elysium' | 'hyperevm';
export const BRIDGE_CHAINS: BridgeChain[] = ['robinhood', 'bsc', 'sol', 'elysium', 'hyperevm'];
// (2026-11-03, Elysium) Elysium is a DESTINATION only — a user pays from a stablecoin on one of these, motion
// pays HYPE on Elysium. Nothing is ever taken from a wallet on Elysium, and the rebalancer never moves money there.
export const SOURCE_CHAINS: BridgeChain[] = ['robinhood', 'bsc', 'sol'];
// (2026-11-04, release 6, 0.1 % fee) HyperEVM (chain 999) is a source TOWARDS ELYSIUM ONLY, paid in native HYPE only: W's plain HYPE
// transfer on HyperEVM to the solver's HyperEVM wallet (the same wallet the Elysium payout is signed from), and the solver pays W's
// same address on Elysium. Never a destination, never a stablecoin source, never in the rebalancer (SOURCE_CHAINS above).
export const INBOX_ONLY_SOURCES: BridgeChain[] = ['hyperevm'];
/** may `src` pay towards `dst` at all (before the coin is looked at) */
export const sourceOk = (src: BridgeChain, dst: BridgeChain): boolean => SOURCE_CHAINS.includes(src) || (INBOX_ONLY_SOURCES.includes(src) && BRIDGE_CFG[dst]?.payout?.via === 'inbox');
/** may `src` pay with its stablecoin (HyperEVM: never — HYPE only) */
export const stableSourceOk = (src: BridgeChain): boolean => SOURCE_CHAINS.includes(src);
export type BridgeChainCfg = {
  key: BridgeChain; kind: 'evm' | 'sol'; chainId: number; native: string; nativeDecimals: number;
  stable: { address: string; symbol: string; decimals: number };
  // the pool the USD price of the native coin is read from (never swapped through): a V3 pool on EVM (slot0), a
  // Meteora DLMM pool on Solana (active bin). The same pools floatCore.ts uses, so the vault and the solver agree.
  oracle: { pool: string; nativeIsToken0: boolean; stableDecimals: number; kind: 'v3' | 'dlmm' };
  // how long inclusion normally takes, and the longest we wait before the fill is given up and refunded
  inclusionMs: number; inclusionTimeoutMs: number;
  // (2026-11-03, Elysium) where the solver's payout transaction is signed and sent, when it is not the destination chain itself. Elysium's
  // payout is ONE Inbox.createRetryableTicket on HyperEVM (chain 999), which the Elysium sequencer turns into a plain HYPE
  // credit to the recipient within seconds (research.txt: 0–11 s over 21 deposits) — and, should the automatic redeem not
  // happen, the ticket's call value is refunded to the RECIPIENT on expiry: every refund address is the recipient.
  payout?: {
    via: 'inbox'; signChainId: number; inbox: string; gasLimit: bigint; maxFeePerGas: bigint;
    // USDC on Elysium = the canonical-bridge copy of Circle's HyperEVM USDC: delivered by ONE
    // L1GatewayRouter.outboundTransferCustomRefund on HyperEVM (refundTo = to = the recipient). The solver approves the
    // standard gateway (router.getGateway(l1Token)) once; l2Token is what arrives on Elysium.
    stable?: { router: string; gateway: string; l1Token: string; l2Token: string; maxGas: bigint; gasPriceBid: bigint; dataLen: number };
  };
};
export const BRIDGE_CFG: Record<BridgeChain, BridgeChainCfg> = {
  robinhood: {
    key: 'robinhood', kind: 'evm', chainId: 4663, native: 'ETH', nativeDecimals: 18,
    stable: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
    oracle: { pool: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', nativeIsToken0: true, stableDecimals: 6, kind: 'v3' },
    inclusionMs: 250, inclusionTimeoutMs: 8_000,
  },
  bsc: {
    key: 'bsc', kind: 'evm', chainId: 56, native: 'BNB', nativeDecimals: 18,
    stable: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
    oracle: { pool: '0x36696169c63e42cd08ce11f5deebbcebae652050', nativeIsToken0: false, stableDecimals: 18, kind: 'v3' },
    inclusionMs: 750, inclusionTimeoutMs: 12_000,
  },
  sol: {
    key: 'sol', kind: 'sol', chainId: 0, native: 'SOL', nativeDecimals: 9,
    stable: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    oracle: { pool: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y', nativeIsToken0: true, stableDecimals: 6, kind: 'dlmm' },
    inclusionMs: 400, inclusionTimeoutMs: 15_000,
  },
  // (2026-11-03, Elysium) chainId = the network the user is paid ON (Elysium); every read and the payout signature happen on HyperEVM
  // (payout.signChainId), where the solver keeps its HYPE. stable = Circle USDC on HyperEVM (inventory only: never a source).
  // oracle = the deepest WHYPE/USDC V3 pool on HyperEVM (0.05 %, factory 0xff7b3e8c…b072; 92.6 k WHYPE + 6.1 M USDC, slot0
  // 85.66 USD on 3 Nov = Hyperliquid's mid 85.61). Elysium's own WHYPE/USDC pool holds ~$200: never an oracle.
  elysium: {
    key: 'elysium', kind: 'evm', chainId: 99901, native: 'HYPE', nativeDecimals: 18,
    stable: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', symbol: 'USDC', decimals: 6 },
    oracle: { pool: '0x6c9a33e3b592c0d65b3ba59355d5be0d38259285', nativeIsToken0: true, stableDecimals: 6, kind: 'v3' },
    inclusionMs: 1_500, inclusionTimeoutMs: 20_000,
    payout: {
      via: 'inbox', signChainId: 999, inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff', gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n,
      // read on chain 2026-11-03: router.getGateway(USDC) = 0xd97b…122c; router.calculateL2TokenAddress(USDC) = 0xb47c…0b65 on both
      // routers; real USDC deposits carried 740 bytes of L2 calldata (we price 1,024) and used ≤ 300 k L2 gas
      stable: {
        router: '0x5d24f760dd7664b4214bdd4b04a3f62b9edd68c0', gateway: '0xd97b30de0ba0c2eaee942afce77530e06c5f122c',
        l1Token: '0xb88339cb7199b77e23db6e890353e22632ba630f', l2Token: '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65',
        maxGas: 300_000n, gasPriceBid: 2_000_000_000n, dataLen: 1_024,
      },
    },
  },
  // (2026-11-04, release 6) HyperEVM as a SOURCE towards Elysium (INBOX_ONLY_SOURCES): W pays native HYPE on chain 999 to the solver's
  // HyperEVM wallet (the Elysium payout key's own address). stable / oracle = Elysium's (the same HyperEVM USDC and WHYPE/USDC pool; the
  // stablecoin is never a source here: stableSourceOk). HyperEVM's small blocks come about every second.
  hyperevm: {
    key: 'hyperevm', kind: 'evm', chainId: 999, native: 'HYPE', nativeDecimals: 18,
    stable: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', symbol: 'USDC', decimals: 6 },
    oracle: { pool: '0x6c9a33e3b592c0d65b3ba59355d5be0d38259285', nativeIsToken0: true, stableDecimals: 6, kind: 'v3' },
    inclusionMs: 1_200, inclusionTimeoutMs: 20_000,
  },
};
/** the source and the destination pay out the SAME coin (HyperEVM HYPE → Elysium HYPE): the amount moves 1:1 minus the fee, no price in between */
export const sameCoin = (src: BridgeChain, dst: BridgeChain): boolean => INBOX_ONLY_SOURCES.includes(src) && bridgeCfg(src).native === bridgeCfg(dst).native && bridgeCfg(dst).payout?.via === 'inbox';
/** the native coin as a quote's source token (only towards a chain paid through an inbox: Elysium) */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
/** (2026-11-04) native SOL as a quote's source token: the System Program id (a lamport transfer, never a mint) */
export const NATIVE_SOL_TOKEN = '11111111111111111111111111111111';
/** is `token` the source chain's native coin (ETH / BNB / SOL)? */
export const isNativeToken = (src: BridgeChain, token: string): boolean => (bridgeCfg(src).kind === 'sol' ? String(token) === NATIVE_SOL_TOKEN : String(token).toLowerCase() === NATIVE_TOKEN);
/** may a quote to `dst` be paid with the source chain's native coin? (Robinhood / BNB / Solana / HyperEVM, inbox destinations only) */
export const nativeSourceOk = (src: BridgeChain, dst: BridgeChain): boolean => sourceOk(src, dst) && bridgeCfg(dst).payout?.via === 'inbox';
/** the chain id a transaction of the solver for `c` is signed for (HyperEVM for Elysium payouts) */
export const signChainIdOf = (c: BridgeChain): number => bridgeCfg(c).payout?.signChainId ?? bridgeCfg(c).chainId;
export const bridgeCfg = (c: BridgeChain): BridgeChainCfg => {
  const cfg = BRIDGE_CFG[c]; if (!cfg) throw new Error('motion bridge: unknown chain ' + String(c).slice(0, 20));
  return cfg;
};

// ── money ──
export const USD6 = 1_000_000n;
const pow10 = (n: number) => 10n ** BigInt(n);
export const stableToUsd6 = (raw: bigint, decimals: number): bigint => (decimals >= 6 ? raw / pow10(decimals - 6) : raw * pow10(6 - decimals));
export const usd6ToStable = (u: bigint, decimals: number): bigint => (decimals >= 6 ? u * pow10(decimals - 6) : u / pow10(6 - decimals));
export const nativeToUsd6 = (raw: bigint, price6: bigint, decimals: number): bigint => (raw * price6) / pow10(decimals);
export const usd6ToNative = (u: bigint, price6: bigint, decimals: number): bigint => (price6 > 0n ? (u * pow10(decimals)) / price6 : 0n);
// a Uniswap-V3-style pool's slot0 → micro-dollars for one whole native coin
export function v3Price6(sqrtPriceX96: bigint, o: { nativeIsToken0: boolean; stableDecimals: number }, nativeDecimals = 18): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const Q192 = 1n << 192n; const sq = sqrtPriceX96 * sqrtPriceX96;
  const stableRaw = o.nativeIsToken0 ? (pow10(nativeDecimals) * sq) / Q192 : (pow10(nativeDecimals) * Q192) / sq;
  return stableToUsd6(stableRaw, o.stableDecimals);
}
// a Meteora DLMM pool's active bin → micro-dollars for one whole SOL (the same maths as src/solEngine.ts dlmmPrice)
const U128 = (1n << 128n) - 1n, Q64 = 1n << 64n;
export function dlmmPow(base: bigint, exp: number): bigint | null {
  let invert = exp < 0; if (exp === 0) return Q64;
  const e = Math.abs(exp); if (e >= 0x80000) return null;
  let sq = base, result = Q64;
  if (sq >= result) { sq = U128 / sq; invert = !invert; }
  for (let bit = 1; bit <= 0x40000; bit <<= 1) {
    if (bit > 1) { const s2 = sq * sq; if (s2 > U128) return null; sq = s2 >> 64n; }
    if (e & bit) { const r = result * sq; if (r > U128) return null; result = r >> 64n; }
  }
  if (result === 0n) return null;
  return invert ? U128 / result : result;
}
export const dlmmPrice = (binId: number, binStep: number) => dlmmPow(Q64 + ((BigInt(binStep) << 64n) / 10_000n), binId);
/** the SOL price in micro-dollars from the pinned DLMM pool's account bytes (solIsX: SOL is token X) */
export function dlmmPrice6(data: Uint8Array, solIsX: boolean): bigint {
  if (!data || data.length < 904) return 0n;
  const dv = new DataView(data.buffer, data.byteOffset);
  const activeId = dv.getInt32(76, true), binStep = dv.getUint16(80, true);
  const p = dlmmPrice(activeId, binStep); if (p === null || p <= 0n) return 0n;
  return solIsX ? (p * 1_000_000_000n) >> 64n : (1_000_000_000n << 64n) / p;
}

// ── the quote ──
export const QUOTE_DOMAIN = 'motion-bridge/quote/v1';
export const QUOTE_ID = /^[0-9a-f]{32}$/;
export const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const SOL_ADDR58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type Quote = {
  v: 1; id: string;
  src: { chain: BridgeChain; token: string; amount: string; depositor: string; deposit: string };
  // asset 'stable' = the destination's stablecoin (USDC on Elysium) instead of its native coin; absent = native (every
  // quote before 2026-11-03 — their signed bytes are unchanged, the field is signed only when present)
  dst: { chain: BridgeChain; recipient: string; amount: string; asset?: 'stable' };
  price6: string;        // the destination native's USD price the solver quoted at
  fee6: string;          // what motion keeps on this fill, micro-dollars (release 6: 0.1 % into Elysium, at least $0.01; 0 elsewhere)
  usd6: string;          // the source amount in micro-dollars
  issuedAt: number; expiresAt: number;
  solver: string;        // the quote-signing public key (hex ed25519), pinned in the vault
};
const te = new TextEncoder();
export const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
/** the exact bytes that are signed: a fixed order, never JSON key order, never a field the other side cannot see */
export function quoteMessage(q: Quote): Uint8Array {
  const parts = [
    QUOTE_DOMAIN, String(q.v), q.id,
    q.src.chain, String(q.src.token).toLowerCase(), q.src.amount, String(q.src.depositor).toLowerCase(), String(q.src.deposit).toLowerCase(),
    q.dst.chain, String(q.dst.recipient).toLowerCase(), q.dst.amount,
    q.price6, q.fee6, q.usd6, String(q.issuedAt), String(q.expiresAt), q.solver.toLowerCase(),
    ...(q.dst.asset !== undefined ? ['asset:' + String(q.dst.asset)] : []),
  ];
  return te.encode(parts.join('\n'));
}
export const signQuote = (q: Quote, seed: Uint8Array): string => hexOf(ed25519.sign(quoteMessage(q), seed));
export function verifyQuoteSig(q: Quote, sigHex: string, pubHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(String(sigHex)) || !/^[0-9a-f]{64}$/i.test(String(pubHex))) return false;
    if (String(q.solver).toLowerCase() !== String(pubHex).toLowerCase()) return false;
    return ed25519.verify(unhex(sigHex), quoteMessage(q), unhex(pubHex));
  } catch { return false; }
}
/** a quote's shape, before anything else looks at it (both sides run this on what the other sent) */
export function quoteShapeProblem(o: unknown): string {
  const q = o as Quote;
  if (!q || typeof q !== 'object' || Array.isArray(q)) return 'not a quote';
  if (q.v !== 1 || !QUOTE_ID.test(String(q.id))) return 'not a quote';
  const keys = ['v', 'id', 'src', 'dst', 'price6', 'fee6', 'usd6', 'issuedAt', 'expiresAt', 'solver'];
  for (const k of Object.keys(q)) if (!keys.includes(k)) return 'unknown field ' + k.slice(0, 20);
  if (!q.src || !q.dst || typeof q.src !== 'object' || typeof q.dst !== 'object') return 'not a quote';
  for (const k of Object.keys(q.src)) if (!['chain', 'token', 'amount', 'depositor', 'deposit'].includes(k)) return 'unknown src field ' + k.slice(0, 20);
  for (const k of Object.keys(q.dst)) if (!['chain', 'recipient', 'amount', 'asset'].includes(k)) return 'unknown dst field ' + k.slice(0, 20);
  if (!BRIDGE_CHAINS.includes(q.src.chain) || !BRIDGE_CHAINS.includes(q.dst.chain)) return 'unknown chain';
  if (q.src.chain === q.dst.chain) return 'same chain is not a bridge';
  if (!sourceOk(q.src.chain, q.dst.chain)) return 'not a source chain';
  const addrOk = (c: BridgeChain, a: string) => (bridgeCfg(c).kind === 'evm' ? EVM_ADDR.test(String(a)) : SOL_ADDR58.test(String(a)));
  if (!addrOk(q.src.chain, q.src.depositor) || !addrOk(q.src.chain, q.src.deposit)) return 'bad source address';
  if (!addrOk(q.dst.chain, q.dst.recipient)) return 'bad recipient';
  const nativeSrc = isNativeToken(q.src.chain, String(q.src.token));
  if (nativeSrc ? !nativeSourceOk(q.src.chain, q.dst.chain) : (!stableSourceOk(q.src.chain) || String(q.src.token).toLowerCase() !== String(bridgeCfg(q.src.chain).stable.address).toLowerCase())) return 'not the chain\'s stablecoin';
  // (release 6) the same coin on both sides (HyperEVM HYPE → Elysium HYPE) is delivered as that coin, never as a stablecoin
  if (sameCoin(q.src.chain, q.dst.chain) && (!nativeSrc || q.dst.asset !== undefined)) return 'HyperEVM pays HYPE for HYPE only';
  if (q.dst.asset !== undefined && (q.dst.asset !== 'stable' || !bridgeCfg(q.dst.chain).payout?.stable)) return 'bad destination asset';
  for (const n of [q.src.amount, q.dst.amount, q.price6, q.fee6, q.usd6]) if (!/^[0-9]{1,40}$/.test(String(n))) return 'bad amount';
  if (!(BigInt(q.src.amount) > 0n) || !(BigInt(q.dst.amount) > 0n)) return 'bad amount';
  if (!Number.isInteger(q.issuedAt) || !Number.isInteger(q.expiresAt) || q.expiresAt <= q.issuedAt) return 'bad expiry';
  if (!/^[0-9a-f]{64}$/i.test(String(q.solver))) return 'bad solver key';
  return '';
}

// ── motion's risk bounds (the solver's own money) ──
export type BridgeCaps = {
  perFill6: bigint;        // the most one fill may carry
  minFill6: bigint;        // below this the public bridges are cheap enough
  perUserDay6: bigint;     // per user (their W address on the destination chain), rolling 24 h
  globalHour6: bigint;     // everyone together, rolling 60 min
  floor6: Record<BridgeChain, bigint>;   // inventory floor per chain: below it the quote is refused
  quoteTtlMs: number;      // how long a quote may be used
  maxOpenPerUser: number;  // quotes in flight per user
  feeBps: number;          // motion's fee on a fill (0 = the platform-fee-0 % promise)
};
export const DEFAULT_CAPS: BridgeCaps = {
  // owner 2026-10-27: "from 10 cents, let everyone trade through the bridge fast" — the only real limit is the inventory
  perFill6: 1_000n * USD6, minFill6: USD6 / 10n, perUserDay6: 50_000n * USD6, globalHour6: 250_000n * USD6,
  floor6: { robinhood: 10n * USD6, bsc: 10n * USD6, sol: 10n * USD6, elysium: 10n * USD6, hyperevm: 10n * USD6 },
  quoteTtlMs: 45_000, maxOpenPerUser: 2, feeBps: 0,
};
export const CAP_BOUNDS = {
  perFill6: [USD6, 5_000n * USD6], perUserDay6: [USD6, 50_000n * USD6], globalHour6: [USD6, 250_000n * USD6], feeBps: [0, 100],
} as const;
export function capsFromEnv(env: Record<string, string | undefined>, base: BridgeCaps = DEFAULT_CAPS): BridgeCaps {
  const num = (v: string | undefined, dflt: bigint, lo: bigint, hi: bigint): bigint => {
    if (v == null || v === '') return dflt;
    const n = Number(v); if (!Number.isFinite(n) || n <= 0) return dflt;
    const u = BigInt(Math.round(n * 1e6)); return u < lo ? lo : u > hi ? hi : u;
  };
  const caps: BridgeCaps = {
    ...base,
    perFill6: num(env.MOTION_BRIDGE_MAX_FILL_USD, base.perFill6, ...CAP_BOUNDS.perFill6),
    minFill6: num(env.MOTION_BRIDGE_MIN_FILL_USD, base.minFill6, USD6 / 100n, 100n * USD6),
    perUserDay6: num(env.MOTION_BRIDGE_USER_DAY_USD, base.perUserDay6, ...CAP_BOUNDS.perUserDay6),
    globalHour6: num(env.MOTION_BRIDGE_HOUR_USD, base.globalHour6, ...CAP_BOUNDS.globalHour6),
    floor6: { ...base.floor6 },
    feeBps: Math.max(CAP_BOUNDS.feeBps[0], Math.min(CAP_BOUNDS.feeBps[1], Math.round(Number(env.MOTION_BRIDGE_FEE_BPS ?? base.feeBps) || 0))),
  };
  for (const c of BRIDGE_CHAINS) {
    const v = env[`MOTION_BRIDGE_FLOOR_${c.toUpperCase()}_USD`];
    caps.floor6[c] = num(v, base.floor6[c], 0n, 100_000n * USD6);
  }
  if (caps.perFill6 > caps.perUserDay6) caps.perFill6 = caps.perUserDay6;
  return caps;
}
export type LedgerUse = { userDay6: bigint; globalHour6: bigint; openForUser: number };
/** why motion refuses to quote ('' = it will): the caps, the inventory floor and the kill switch, in that order */
export function quoteRefusal(a: {
  on: boolean; from: BridgeChain; to: BridgeChain; usd6: bigint; caps: BridgeCaps; use: LedgerUse;
  dstInventory6: bigint; dstPrice6: bigint; srcPrice6?: bigint; dstReserved6?: bigint;
}): string {
  if (!a.on) return 'off';
  if (a.from === a.to) return 'same chain';
  if (!BRIDGE_CHAINS.includes(a.from) || !BRIDGE_CHAINS.includes(a.to)) return 'unknown chain';
  if (!sourceOk(a.from, a.to)) return 'not a source chain';
  if (!(a.dstPrice6 > 0n)) return 'no price for the destination chain';
  if (a.usd6 < a.caps.minFill6) return 'below the minimum fill';
  if (a.usd6 > a.caps.perFill6) return 'above the per-fill cap';
  if (a.use.userDay6 + a.usd6 > a.caps.perUserDay6) return 'above this wallet\'s daily cap';
  if (a.use.globalHour6 + a.usd6 > a.caps.globalHour6) return 'above the hourly cap';
  if (a.use.openForUser >= a.caps.maxOpenPerUser) return 'a fill of this wallet is already in flight';
  const left = a.dstInventory6 - (a.dstReserved6 ?? 0n) - a.usd6;
  if (left < a.caps.floor6[a.to]) return 'inventory floor on the destination chain';
  return '';
}
/**
 * motion's fee on `usd6`: `feeBps` of it (rounded down), at least `minFee6` once there is a fee at all, never more than the amount.
 * (release 6) Elysium: 10 bps, at least $0.01 (server/motion-bridge.mjs elysiumFeeFromEnv); every other route: caps.feeBps (0).
 */
export function feeOf6(usd6: bigint, feeBps: number, minFee6: bigint = 0n): bigint {
  const bps = BigInt(Math.max(0, Math.round(feeBps)));
  if (bps === 0n || !(usd6 > 0n)) return 0n;
  let fee6 = (usd6 * bps) / 10_000n;
  if (fee6 < minFee6) fee6 = minFee6;
  return fee6 > usd6 ? usd6 : fee6;
}
/** the destination native a quote pays: the source dollars, less motion's fee, at the solver's price */
export function quoteOut(usd6: bigint, price6: bigint, dst: BridgeChain, feeBps: number, asset?: 'stable', minFee6: bigint = 0n): { out: bigint; fee6: bigint } {
  const fee6 = feeOf6(usd6, feeBps, minFee6);
  const net6 = usd6 - fee6 > 0n ? usd6 - fee6 : 0n;
  // a stablecoin out is paid dollar for dollar (USDC = USD; no price read)
  if (asset === 'stable') return { out: usd6ToStable(net6, bridgeCfg(dst).stable.decimals), fee6 };
  return { out: usd6ToNative(net6, price6, bridgeCfg(dst).nativeDecimals), fee6 };
}
/**
 * (release 6) the same coin on both sides (sameCoin: HyperEVM HYPE → Elysium HYPE): `amountIn` less the fee IN THAT COIN — `feeBps` of
 * it, at least `minFee6` dollars at `price6` (rounded up to the wei) — with no price round trip: 1 HYPE at 10 bps pays exactly 0.999 HYPE.
 * fee6 = the fee in dollars at `price6` (what the quote signs as fee6).
 */
export function sameCoinOut(amountIn: bigint, price6: bigint, decimals: number, feeBps: number, minFee6: bigint = 0n): { out: bigint; fee: bigint; fee6: bigint } {
  const bps = BigInt(Math.max(0, Math.round(feeBps)));
  if (bps === 0n || !(amountIn > 0n)) return { out: amountIn > 0n ? amountIn : 0n, fee: 0n, fee6: 0n };
  let fee = (amountIn * bps) / 10_000n;
  const minFee = minFee6 > 0n && price6 > 0n ? (minFee6 * pow10(decimals) + price6 - 1n) / price6 : 0n;
  if (fee < minFee) fee = minFee;
  if (fee > amountIn) fee = amountIn;
  return { out: amountIn - fee, fee, fee6: nativeToUsd6(fee, price6, decimals) };
}
/** what of a fill's source amount is motion's fee, in the SOURCE token's units (what stays in the solver's inventory until it is swept) */
export const feeInSource = (amountIn: bigint, usd6: bigint, fee6: bigint): bigint => (usd6 > 0n && fee6 > 0n ? (amountIn * fee6) / usd6 : 0n);
/** the source amount in micro-dollars: a stablecoin at par, the native coin at `srcPrice6` (the reader's OWN price) */
export const sourceUsd6 = (q: Quote, srcPrice6: bigint): bigint => (isNativeToken(q.src.chain, String(q.src.token))
  ? nativeToUsd6(BigInt(q.src.amount), srcPrice6, bridgeCfg(q.src.chain).nativeDecimals)
  : stableToUsd6(BigInt(q.src.amount), bridgeCfg(q.src.chain).stable.decimals));
/**
 * The vault's own check of a quote, against what IT asked for and ITS own oracle price — the solver's numbers are never
 * trusted. Everything here is refusable before a single byte of the user's money is signed.
 */
export function quoteProblem(q: Quote, sig: string, want: {
  pinnedSolver: string; from: BridgeChain; to: BridgeChain; amountIn: bigint; depositor: string; recipient: string;
  oracle6: bigint; maxSlipBps: number; maxFill6: bigint; now: number; deposits?: Partial<Record<BridgeChain, string>>;
  // (2026-11-03) what the vault asked to receive and pay with; a native source needs the vault's own SOURCE price
  asset?: 'native' | 'stable'; pay?: 'native' | 'stable'; srcOracle6?: bigint;
}): string {
  const shape = quoteShapeProblem(q); if (shape) return shape;
  if (!verifyQuoteSig(q, sig, want.pinnedSolver)) return 'the quote is not signed by motion\'s solver key';
  if (q.src.chain !== want.from || q.dst.chain !== want.to) return 'the quote is for another route';
  if (BigInt(q.src.amount) !== want.amountIn) return 'the quote is for another amount';
  if (String(q.src.depositor).toLowerCase() !== String(want.depositor).toLowerCase()) return 'the quote names another payer';
  if (String(q.dst.recipient).toLowerCase() !== String(want.recipient).toLowerCase()) return 'the quote pays someone else';
  if (want.deposits && want.deposits[q.src.chain] && String(q.src.deposit).toLowerCase() !== String(want.deposits[q.src.chain]).toLowerCase()) return 'the quote names an unpublished deposit address';
  if (q.expiresAt <= want.now) return 'the quote has expired';
  if (q.expiresAt - want.now > 120_000) return 'the quote lives too long';
  if (q.issuedAt > want.now + 30_000) return 'the quote is from the future';
  const nativeSrc = isNativeToken(q.src.chain, String(q.src.token));
  if (nativeSrc !== (want.pay === 'native')) return 'the quote is paid with another coin';
  if ((q.dst.asset === 'stable') !== (want.asset === 'stable')) return 'the quote delivers another coin';
  if (nativeSrc && !((want.srcOracle6 ?? 0n) > 0n)) return 'no price of our own for the source coin';
  const in6 = sourceUsd6(q, want.srcOracle6 ?? 0n);
  if (in6 > want.maxFill6) return 'above the amount motion\'s bridge may carry';
  const slip = BigInt(10_000 - Math.max(0, Math.min(1_000, want.maxSlipBps)));
  if (q.dst.asset === 'stable') {
    if (BigInt(q.dst.amount) < (usd6ToStable(in6, bridgeCfg(q.dst.chain).stable.decimals) * slip) / 10_000n) return 'the quote pays less than the amount minus slippage';
    return '';
  }
  if (!(want.oracle6 > 0n)) return 'no price of our own for the destination chain';
  const floor = (usd6ToNative(in6, want.oracle6, bridgeCfg(q.dst.chain).nativeDecimals) * slip) / 10_000n;
  if (BigInt(q.dst.amount) < floor) return 'the quote pays less than the oracle price minus slippage';
  return '';
}

// ── the source transfer the vault pre-signs ──
export const ERC20_TRANSFER = '0xa9059cbb';
export const SPL_TRANSFER_CHECKED = 12;
export type EvmTransfer = { to: string; amount: bigint };
/** `transfer(address,uint256)` and nothing else; any other shape is refused */
export function decodeErc20Transfer(data: string): EvmTransfer | null {
  const d = String(data || '').toLowerCase();
  if (!/^0x[0-9a-f]{136}$/.test(d) || d.slice(0, 10) !== ERC20_TRANSFER) return null;
  if (!/^0{24}/.test(d.slice(10, 74))) return null;
  return { to: '0x' + d.slice(34, 74), amount: BigInt('0x' + d.slice(74, 138)) };
}
export const erc20TransferData = (to: string, amount: bigint): string =>
  ERC20_TRANSFER + String(to).toLowerCase().replace(/^0x/, '').padStart(64, '0') + amount.toString(16).padStart(64, '0');
/**
 * The solver's check of the raw EVM transfer the vault signed: exactly this quote's token, amount, deposit address and
 * payer, on this chain, with no value and a sane gas limit. `from` is what the signature recovers to — never what the
 * caller claims.
 */
export function evmSourceProblem(tx: { chainId: number; to?: string | null; data?: string; value?: bigint; gas?: bigint; nonce?: number; type?: string }, from: string, q: Quote): string {
  const cfg = bridgeCfg(q.src.chain);
  if (cfg.kind !== 'evm') return 'not an EVM source';
  if (Number(tx.chainId) !== cfg.chainId) return 'the transaction is for another chain';
  // (2026-11-03) a native source: one plain value transfer of exactly the amount to the deposit address, no calldata
  if (String(q.src.token).toLowerCase() === NATIVE_TOKEN) {
    if (!nativeSourceOk(q.src.chain, q.dst.chain)) return 'a native source is not offered on this route';
    if (String(tx.to || '').toLowerCase() !== String(q.src.deposit).toLowerCase()) return 'the transfer pays another address';
    if (String(tx.data || '0x').toLowerCase() !== '0x') return 'the transfer carries calldata';
    if ((tx.value ?? 0n) !== BigInt(q.src.amount)) return 'the transfer is for another amount';
    if (String(from).toLowerCase() !== String(q.src.depositor).toLowerCase()) return 'the transaction is signed by another wallet';
    if ((tx.gas ?? 0n) > 100_000n) return 'the gas limit is unreasonable';
    return '';
  }
  if (String(tx.to || '').toLowerCase() !== String(q.src.token).toLowerCase()) return 'the transaction does not call the stablecoin';
  if ((tx.value ?? 0n) !== 0n) return 'the transaction sends native value';
  const t = decodeErc20Transfer(String(tx.data || ''));
  if (!t) return 'not a plain ERC-20 transfer';
  if (t.to.toLowerCase() !== String(q.src.deposit).toLowerCase()) return 'the transfer pays another address';
  if (t.amount !== BigInt(q.src.amount)) return 'the transfer is for another amount';
  if (String(from).toLowerCase() !== String(q.src.depositor).toLowerCase()) return 'the transaction is signed by another wallet';
  if ((tx.gas ?? 0n) > 400_000n) return 'the gas limit is unreasonable';
  return '';
}
/**
 * The solver's check of the raw Solana transfer: fee payer = the quote's depositor, exactly one SPL transferChecked of
 * the quoted mint, amount and destination token account, an optional compute budget, a memo carrying the quote id, and
 * nothing else. `tx` is the parsed legacy transaction (src/solLimitCore.ts parseLegacyTx shape).
 */
export type ParsedSolIx = { program: string; accounts: string[]; data: Uint8Array };
export type ParsedSolTx = { sigs: Uint8Array[]; message: Uint8Array; header: [number, number, number]; keys: string[]; blockhash: string; ixs: ParsedSolIx[] };
export const SOL_PROGRAMS = {
  system: '11111111111111111111111111111111', token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', budget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};
export function solSourceProblem(tx: ParsedSolTx, q: Quote, ata: (owner: string, mint: string) => string): string {
  if (bridgeCfg(q.src.chain).kind !== 'sol') return 'not a Solana source';
  if (!tx || !Array.isArray(tx.ixs) || !tx.keys?.length) return 'not a transaction';
  if (tx.sigs.length !== 1) return 'the transaction has more than one signature';
  if (tx.keys[0] !== q.src.depositor) return 'the transaction is signed by another wallet';
  if (String(q.src.token) === NATIVE_SOL_TOKEN) return solNativeSourceProblem(tx, q);
  const mint = q.src.token;
  const src = ata(q.src.depositor, mint), dst = ata(q.src.deposit, mint);
  let transfers = 0, memos = 0, budget = 0;
  for (const ix of tx.ixs) {
    if (ix.program === SOL_PROGRAMS.budget) { budget += 1; if (budget > 2) return 'too many compute-budget instructions'; continue; }
    if (ix.program === SOL_PROGRAMS.memo) {
      memos += 1; if (memos > 1) return 'more than one memo';
      if (new TextDecoder().decode(ix.data) !== q.id) return 'the memo does not carry this quote id';
      continue;
    }
    if (ix.program === SOL_PROGRAMS.token) {
      transfers += 1; if (transfers > 1) return 'more than one transfer';
      if (ix.data.length !== 10 || ix.data[0] !== SPL_TRANSFER_CHECKED) return 'not an SPL transferChecked';
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset);
      const amount = dv.getBigUint64(1, true); const decimals = ix.data[9];
      if (amount !== BigInt(q.src.amount)) return 'the transfer is for another amount';
      if (decimals !== bridgeCfg(q.src.chain).stable.decimals) return 'wrong token decimals';
      if (ix.accounts.length !== 4) return 'unexpected transfer accounts';
      if (ix.accounts[0] !== src) return 'the transfer comes from another account';
      if (ix.accounts[1] !== mint) return 'the transfer is of another token';
      if (ix.accounts[2] !== dst) return 'the transfer pays another account';
      if (ix.accounts[3] !== q.src.depositor) return 'the transfer is authorised by someone else';
      continue;
    }
    return 'unexpected instruction (' + ix.program.slice(0, 8) + ')';
  }
  if (transfers !== 1) return 'the transaction carries no transfer';
  if (memos !== 1) return 'the transaction carries no quote memo';
  return '';
}

// ── the fill's state machine (the ledger's only transitions) ──
// 2026-11-01 (audit: a source that landed after the inclusion timeout was written 'failed' and never looked at again; a
// payout was written 'filled' the moment it was broadcast):
//   · 'source-late' — the user's transfer was broadcast but not seen included in time. It may still land, so it is NOT
//     terminal: the solver follows it and pays (or refunds) once it lands, and writes 'failed' only once it provably can
//     never land (EVM: the payer's nonce was used by another transaction; Solana: its blockhash expired, no status).
//   · 'paid' — the payout's bytes are out; 'filled' only once it is seen on chain. A payout that provably can never land
//     (or reverted) is refunded; one that may still land is never refunded.
//   · once the source is included there is no terminal but 'filled' or 'refunded' (no 'failed' with the user's money held).
//   · (2026-11-04, review H-F1 / M-F2) 'landed' — an Elysium payout landed on HyperEVM, its retryable ticket not yet seen redeemed
//     on Elysium: never refunded (the payout is out), followed and redeemed by the solver; 'filled' only on the Elysium credit.
export type FillState = 'quoted' | 'bound' | 'source-sent' | 'source-late' | 'source-included' | 'paying' | 'paid' | 'landed' | 'filled' | 'refunding' | 'refunded' | 'failed' | 'expired';
export const FILL_TERMINAL: FillState[] = ['filled', 'refunded', 'failed', 'expired'];
export const FILL_NEXT: Record<FillState, FillState[]> = {
  quoted: ['bound', 'expired', 'failed'],
  bound: ['source-sent', 'source-late', 'source-included', 'failed'],
  'source-sent': ['source-included', 'source-late', 'failed', 'refunding'],
  'source-late': ['source-included', 'failed', 'refunding'],
  'source-included': ['paying', 'refunding'],
  paying: ['paid', 'landed', 'filled', 'refunding'],
  paid: ['landed', 'filled', 'refunding'],
  landed: ['filled'],
  refunding: ['refunded'],
  filled: [], refunded: [], failed: [], expired: [],
};
export const canStep = (from: FillState, to: FillState): boolean => (FILL_NEXT[from] || []).includes(to);
/** what the vault shows the user */
export const USER_STATE: Record<FillState, string> = {
  quoted: 'quoted', bound: 'quoted', 'source-sent': 'source sent', 'source-late': 'source sent', 'source-included': 'source sent', paying: 'source sent', paid: 'source sent', landed: 'arriving',
  filled: 'filled', refunding: 'refunding', refunded: 'refunded', failed: 'failed', expired: 'expired',
};
export const DIALOG_LINE = 'motion pays you on the other chain from its own funds the moment your transfer is included; if it cannot, your transfer is sent back.';

// ── the ledger (append-only, hash-chained; the solver's crash safety) ──
// quote / srcNonce / srcBlockhash (at 'bound'): what a restart needs to pay or refund, and to tell whether the user's
// transfer can still land. Our own payout (dstRaw) and refund (refundRaw) carry that in their bytes (EVM nonce, Solana
// blockhash); dstAt / refundAt are when they were signed. Older ledgers kept a refund's bytes in dstRaw: they are only re-sent
// when they hash to refundHash.
export type LedgerRecord = {
  at: number; id: string; state: FillState; usd6?: string; user?: string; from?: BridgeChain; to?: BridgeChain; srcHash?: string; dstHash?: string; dstRaw?: string; refundHash?: string; note?: string;
  quote?: Quote; boundAt?: number; srcNonce?: number; srcBlockhash?: string; dstAt?: number; refundRaw?: string; refundAt?: number;
  // (release 6) motion's fee of this fill, in the SOURCE token (written with 'quoted'; earned once the payout is out: 'landed' / 'filled')
  fee?: { chain: BridgeChain; token: string; amount: string; usd6: string };
};
export const ledgerLine = (rec: LedgerRecord, prev: string): string => {
  const body = JSON.stringify(rec);
  return JSON.stringify({ p: prev.slice(0, 32), r: rec, h: hexOf(sha256(te.encode(prev.slice(0, 32) + body))) });
};
export function ledgerReplay(lines: string[]): { fills: Map<string, LedgerRecord & { history: FillState[] }>; broken: number; last: string } {
  const fills = new Map<string, LedgerRecord & { history: FillState[] }>();
  let prev = '', broken = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let x: { p: string; r: LedgerRecord; h: string };
    try { x = JSON.parse(line); } catch { broken += 1; continue; }
    const want = hexOf(sha256(te.encode(String(x.p ?? '') + JSON.stringify(x.r))));
    if (want !== x.h || String(x.p ?? '') !== prev.slice(0, 32)) { broken += 1; continue; }
    prev = x.h;
    const cur = fills.get(x.r.id);
    fills.set(x.r.id, { ...(cur || { history: [] }), ...x.r, history: [...(cur?.history || []), x.r.state] });
  }
  return { fills, broken, last: prev };
}
/**
 * Rolling use of the caps, from the ledger's own records (never a counter that a restart could lose).
 *
 * A quote that was never used costs motion NOTHING, so it must not eat a cap: anyone can ask for quotes, and if
 * `quoted` counted, a stranger could spend the hour's cap for free and keep everyone else off the fast path. Spending
 * starts at `bound` — the moment a signed transfer of the user's is in our hands. A quote still in flight does hold a
 * slot (one wallet, two fills at a time) and reserves inventory, but only until it expires.
 */
export function useOf(fills: Iterable<LedgerRecord>, user: string, now: number, quoteTtlMs = DEFAULT_CAPS.quoteTtlMs): LedgerUse {
  let userDay6 = 0n, globalHour6 = 0n, openForUser = 0;
  const u = String(user).toLowerCase();
  for (const f of fills) {
    const spent = f.state !== 'failed' && f.state !== 'expired' && f.state !== 'refunded' && f.state !== 'quoted';
    const usd = BigInt(f.usd6 || '0');
    if (spent && now - f.at < 86_400_000 && String(f.user || '').toLowerCase() === u) userDay6 += usd;
    if (spent && now - f.at < 3_600_000) globalHour6 += usd;
    const live = !FILL_TERMINAL.includes(f.state) && f.state !== 'landed' && (f.state !== 'quoted' || now - f.at < quoteTtlMs + 5_000);
    if (live && String(f.user || '').toLowerCase() === u) openForUser += 1;
  }
  return { userDay6, globalHour6, openForUser };
}

// ── inventory and the background rebalancer (§5 of the design) ──
export type Inventory = Record<BridgeChain, { native: bigint; stable: bigint; price6: bigint }>;
export const inventoryUsd6 = (inv: Inventory, c: BridgeChain): bigint =>
  nativeToUsd6(inv[c].native, inv[c].price6, bridgeCfg(c).nativeDecimals) + stableToUsd6(inv[c].stable, bridgeCfg(c).stable.decimals);
export type RebalanceMove = { from: BridgeChain; to: BridgeChain; usd6: bigint; why: string };
/**
 * One move at a time: the poorest chain under its floor is topped up from the richest chain above its own floor, in
 * chunks of at least `min6`. Pure, so the plan can be shown on the status route without moving anything.
 */
export function planRebalance(inv: Inventory, caps: BridgeCaps, opts: { min6?: bigint; target6?: bigint; inFlight?: Partial<Record<BridgeChain, bigint>> } = {}): RebalanceMove | null {
  const min6 = opts.min6 ?? 100n * USD6;
  const target6 = opts.target6 ?? 0n;
  const level = (c: BridgeChain) => inventoryUsd6(inv, c) + (opts.inFlight?.[c] ?? 0n);
  // each chain aims at its floor + $500 (two of the old $250 fills): the $1,000 fill cap (2026-10-27) would make every chain look short
  const want = (c: BridgeChain) => (target6 > 0n ? target6 : caps.floor6[c] + 500n * USD6);
  const needy = SOURCE_CHAINS.filter((c) => level(c) < want(c)).sort((a, b) => Number(level(a) - want(a) - (level(b) - want(b))))[0];
  if (!needy) return null;
  const need = want(needy) - level(needy);
  const donors = SOURCE_CHAINS.filter((c) => c !== needy && level(c) - want(c) >= min6).sort((a, b) => Number(level(b) - want(b) - (level(a) - want(a))));
  if (!donors.length) return null;
  const spare = level(donors[0]) - want(donors[0]);
  const usd6 = need > spare ? spare : need < min6 ? min6 : need;
  if (usd6 < min6 || usd6 > spare) return null;
  return { from: donors[0], to: needy, usd6, why: `${needy} is ${Number(need) / 1e6} USD under target` };
}

// ── (2026-11-03) the Elysium HYPE payout = one Inbox.createRetryableTicket on HyperEVM ──
// createRetryableTicket(to, l2CallValue, maxSubmissionCost, excessFeeRefundAddress, callValueRefundAddress, gasLimit,
// maxFeePerGas, data) — selector 0x679b6ded. to = W; BOTH refund addresses = W (whatever happens to the ticket, the HYPE can
// only ever end at W); data empty (a plain value transfer); msg.value = l2CallValue + maxSubmissionCost + gasLimit ×
// maxFeePerGas exactly (Nitro refuses less; the unused part is refunded to W on Elysium). Never depositEth: from the
// solver's key it would credit the SOLVER's own address on Elysium.
// The submission fee is Nitro's (1400 + 6 × dataLength) × parent base fee; we pay 3× the base fee read (refund = W).
export const INBOX_CREATE_RETRYABLE = '0x679b6ded';
const w32 = (v: bigint) => v.toString(16).padStart(64, '0');
const a32 = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const inboxSubmissionCost = (parentBaseFee: bigint): bigint => 1_400n * (parentBaseFee > 0n ? parentBaseFee : 1n) * 3n;
export function inboxPayoutCall(dst: BridgeChain, recipient: string, amount: bigint, parentBaseFee: bigint): { to: string; value: bigint; data: string; maxSubmissionCost: bigint } {
  const p = bridgeCfg(dst).payout;
  if (!p || p.via !== 'inbox') throw new Error('motion bridge: ' + dst + ' is not paid through an inbox');
  if (!EVM_ADDR.test(recipient) || !(amount > 0n)) throw new Error('motion bridge: bad inbox payout');
  const maxSubmissionCost = inboxSubmissionCost(parentBaseFee);
  const data = INBOX_CREATE_RETRYABLE + a32(recipient) + w32(amount) + w32(maxSubmissionCost) + a32(recipient) + a32(recipient)
    + w32(p.gasLimit) + w32(p.maxFeePerGas) + w32(0x100n) + w32(0n);
  return { to: p.inbox, value: amount + maxSubmissionCost + p.gasLimit * p.maxFeePerGas, data, maxSubmissionCost };
}
/** the solver's own last check of the payout bytes it is about to sign ('' = they pay exactly the quote, to W, through the inbox) */
export function inboxPayoutProblem(tx: { to?: string | null; value?: bigint; data?: string; chainId?: number }, q: Quote): string {
  const cfg = bridgeCfg(q.dst.chain), p = cfg.payout;
  if (!p || p.via !== 'inbox' || q.dst.asset !== undefined) return 'not an inbox payout';
  if (tx.chainId !== undefined && tx.chainId !== p.signChainId) return 'signed for another chain';
  if (String(tx.to || '').toLowerCase() !== p.inbox.toLowerCase()) return 'not the pinned inbox';
  const d = String(tx.data || '').toLowerCase();
  if (!d.startsWith(INBOX_CREATE_RETRYABLE) || d.length !== 10 + 64 * 9) return 'not a plain createRetryableTicket';
  const word = (i: number) => d.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i: number) => '0x' + word(i).slice(24);
  const r = String(q.dst.recipient).toLowerCase();
  for (const i of [0, 3, 4]) if (word(i).slice(0, 24) !== '0'.repeat(24)) return 'not an address';
  if (addr(0) !== r) return 'pays someone else';
  if (BigInt('0x' + word(1)) !== BigInt(q.dst.amount)) return 'another amount';
  if (addr(3) !== r || addr(4) !== r) return 'a refund address is not the recipient';
  if (BigInt('0x' + word(5)) !== p.gasLimit || BigInt('0x' + word(6)) !== p.maxFeePerGas) return 'other gas terms';
  if (BigInt('0x' + word(7)) !== 0x100n || BigInt('0x' + word(8)) !== 0n) return 'carries calldata';
  if (BigInt('0x' + word(2)) > 1_000_000_000_000_000n) return 'submission cost out of bounds';
  const want = BigInt(q.dst.amount) + BigInt('0x' + word(2)) + p.gasLimit * p.maxFeePerGas;
  if (tx.value !== want) return 'value does not match the ticket';
  return '';
}

// ── (2026-11-03) USDC on Elysium: one L1GatewayRouter.outboundTransferCustomRefund on HyperEVM ──
// outboundTransferCustomRefund(token, refundTo, to, amount, maxGas, gasPriceBid, data) — selector 0x4fb1a07b; token = Circle
// USDC on HyperEVM, refundTo = to = W, data = abi.encode(maxSubmissionCost, bytes("")); msg.value = maxSubmissionCost + maxGas ×
// gasPriceBid exactly. The gateway pulls the USDC from the solver (approved once) into its escrow; Elysium mints the same amount
// of 0xb47c…0b65 to W when the ticket runs (seconds); its unused L2 fee goes to W too.
export const GATEWAY_CUSTOM_REFUND = '0x4fb1a07b';
export const ERC20_APPROVE = '0x095ea7b3';
export const gatewaySubmissionCost = (parentBaseFee: bigint, dataLen: number): bigint => BigInt(1_400 + 6 * dataLen) * (parentBaseFee > 0n ? parentBaseFee : 1n) * 3n;
export function gatewayPayoutCall(dst: BridgeChain, recipient: string, amount: bigint, parentBaseFee: bigint): { to: string; value: bigint; data: string; maxSubmissionCost: bigint } {
  const p = bridgeCfg(dst).payout?.stable;
  if (!p) throw new Error('motion bridge: ' + dst + ' has no stablecoin delivery');
  if (!EVM_ADDR.test(recipient) || !(amount > 0n)) throw new Error('motion bridge: bad gateway payout');
  const maxSubmissionCost = gatewaySubmissionCost(parentBaseFee, p.dataLen);
  const data = GATEWAY_CUSTOM_REFUND + a32(p.l1Token) + a32(recipient) + a32(recipient) + w32(amount) + w32(p.maxGas) + w32(p.gasPriceBid)
    + w32(0xe0n) + w32(0x60n) + w32(maxSubmissionCost) + w32(0x40n) + w32(0n);
  return { to: p.router, value: maxSubmissionCost + p.maxGas * p.gasPriceBid, data, maxSubmissionCost };
}
export function gatewayPayoutProblem(tx: { to?: string | null; value?: bigint; data?: string; chainId?: number }, q: Quote): string {
  const cfg = bridgeCfg(q.dst.chain), pay = cfg.payout, p = pay?.stable;
  if (!pay || !p || q.dst.asset !== 'stable') return 'not a gateway payout';
  if (tx.chainId !== undefined && tx.chainId !== pay.signChainId) return 'signed for another chain';
  if (String(tx.to || '').toLowerCase() !== p.router.toLowerCase()) return 'not the pinned gateway router';
  const d = String(tx.data || '').toLowerCase();
  if (!d.startsWith(GATEWAY_CUSTOM_REFUND) || d.length !== 10 + 64 * 11) return 'not a plain outboundTransferCustomRefund';
  const word = (i: number) => d.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i: number) => '0x' + word(i).slice(24);
  const r = String(q.dst.recipient).toLowerCase();
  for (const i of [0, 1, 2]) if (word(i).slice(0, 24) !== '0'.repeat(24)) return 'not an address';
  if (addr(0) !== p.l1Token.toLowerCase()) return 'another token';
  if (addr(1) !== r) return 'the refund address is not the recipient';
  if (addr(2) !== r) return 'pays someone else';
  if (BigInt('0x' + word(3)) !== BigInt(q.dst.amount)) return 'another amount';
  if (BigInt('0x' + word(4)) !== p.maxGas || BigInt('0x' + word(5)) !== p.gasPriceBid) return 'other gas terms';
  if (BigInt('0x' + word(6)) !== 0xe0n || BigInt('0x' + word(7)) !== 0x60n || BigInt('0x' + word(9)) !== 0x40n || BigInt('0x' + word(10)) !== 0n) return 'carries extra data';
  const maxSub = BigInt('0x' + word(8));
  if (maxSub > 1_000_000_000_000_000n) return 'submission cost out of bounds';
  if (tx.value !== maxSub + p.maxGas * p.gasPriceBid) return 'value does not match the ticket';
  return '';
}
/** the solver's approval of the standard gateway for its USDC (spender pinned, nothing else). (2026-11-04, review M-F3) CAPPED:
 *  never above ELY_APPROVE_MAX6 — the gateway is upgradeable by Kinetiq's multisig with no delay, so it may only ever reach
 *  the float the owner chose, re-set (not added to) when it runs low */
export const ELY_APPROVE_MAX6 = 5_000n * USD6;
export function gatewayApproveCall(dst: BridgeChain, amount: bigint): { to: string; value: bigint; data: string } {
  const p = bridgeCfg(dst).payout?.stable;
  if (!p || !(amount > 0n)) throw new Error('motion bridge: no gateway to approve');
  if (amount > ELY_APPROVE_MAX6) throw new Error('motion bridge: gateway approval above the cap');
  return { to: p.l1Token, value: 0n, data: ERC20_APPROVE + a32(p.gateway) + w32(amount) };
}
export function gatewayApproveProblem(tx: { to?: string | null; value?: bigint; data?: string }, dst: BridgeChain): string {
  const p = bridgeCfg(dst).payout?.stable;
  if (!p) return 'no gateway';
  if (String(tx.to || '').toLowerCase() !== p.l1Token.toLowerCase()) return 'not the stablecoin';
  if ((tx.value ?? 0n) !== 0n) return 'sends value';
  const d = String(tx.data || '').toLowerCase();
  if (!d.startsWith(ERC20_APPROVE) || d.length !== 10 + 128 || d.slice(10, 34) !== '0'.repeat(24) || '0x' + d.slice(34, 74) !== p.gateway.toLowerCase()) return 'approves another spender';
  if (BigInt('0x' + d.slice(74, 138)) > ELY_APPROVE_MAX6) return 'approves more than the cap';
  return '';
}
/** the payout call of a quote paid through an inbox (native → ticket, stable → gateway), and its check */
export function payoutCall(q: Quote, parentBaseFee: bigint): { to: string; value: bigint; data: string } {
  return q.dst.asset === 'stable'
    ? gatewayPayoutCall(q.dst.chain, q.dst.recipient, BigInt(q.dst.amount), parentBaseFee)
    : inboxPayoutCall(q.dst.chain, q.dst.recipient, BigInt(q.dst.amount), parentBaseFee);
}
export const payoutProblem = (tx: { to?: string | null; value?: bigint; data?: string; chainId?: number }, q: Quote): string =>
  (q.dst.asset === 'stable' ? gatewayPayoutProblem(tx, q) : inboxPayoutProblem(tx, q));

// ── (2026-11-04) native SOL towards Elysium: budget ≤ 2, ONE memo = the quote id, ONE System Program transfer (instruction 2) of
// exactly the quoted lamports from the depositor (signer) to the solver's deposit address, nothing else ──
export function solNativeSourceProblem(tx: ParsedSolTx, q: Quote): string {
  if (!nativeSourceOk(q.src.chain, q.dst.chain)) return 'a native source is not offered on this route';
  let transfers = 0, memos = 0, budget = 0;
  for (const ix of tx.ixs) {
    if (ix.program === SOL_PROGRAMS.budget) { budget += 1; if (budget > 2) return 'too many compute-budget instructions'; continue; }
    if (ix.program === SOL_PROGRAMS.memo) {
      memos += 1; if (memos > 1) return 'more than one memo';
      if (new TextDecoder().decode(ix.data) !== q.id) return 'the memo does not carry this quote id';
      continue;
    }
    if (ix.program === SOL_PROGRAMS.system) {
      transfers += 1; if (transfers > 1) return 'more than one transfer';
      if (ix.data.length !== 12) return 'not a plain SOL transfer';
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset);
      if (dv.getUint32(0, true) !== 2) return 'not a plain SOL transfer';
      if (dv.getBigUint64(4, true) !== BigInt(q.src.amount)) return 'the transfer is for another amount';
      if (ix.accounts.length !== 2) return 'unexpected transfer accounts';
      if (ix.accounts[0] !== q.src.depositor) return 'the transfer comes from another account';
      if (ix.accounts[1] !== q.src.deposit) return 'the transfer pays another account';
      continue;
    }
    return 'unexpected instruction (' + ix.program.slice(0, 8) + ')';
  }
  if (transfers !== 1) return 'the transaction carries no transfer';
  if (memos !== 1) return 'the transaction carries no quote memo';
  return '';
}
