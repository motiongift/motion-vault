// The trading wallet's OWN native on another chain as a waiting click's donor (2026-10-30; a user: "I have eth on rh and can't
// do anything on solana still"; owner: «если считаешь что поможет и ускорит то делай»). Pure: no network, no clock, no key.
//
// Before: a click on chain X whose W had no native asked the reserves only (planMoves). A user whose money sat as ETH in the
// Robinhood trading wallet (or BNB in the BNB one) had no reserve anywhere until a background conversion ran (only while
// Robinhood is quiet, only above the kept float), so the plan answered "no-reserve" and the buy failed with "This wallet has
// no SOL yet — fund it first".
// Now (floatEngine tick, a waiting click only, after every reserve move it could start): what the click still lacks is asked
// of W's own native on the other EVM chains of the permission, above what that chain keeps (W's gas floor + the deposit's own
// gas; since 2026-11-01 a click may also take that chain's kept trading float, which its reserve refills later, and two chains
// may pay one click together — nativeDonorSplit). Relay carries it, signed by W on the source chain inside the vault,
// EXACT_OUTPUT: exactly the native the click needs lands in W on X. The vault checks, before W signs:
//   recipient   W on the click's chain (this wallet's own address), and Relay's details name W on the source as the sender;
//   currencies  native on both sides, the two chains asked for;
//   amounts     what lands >= what was asked (and its minimum too); what leaves <= the spare above the kept float and gas,
//               and <= what lands + Relay's fee cap + the slippage bound at the source chain's oracle (nativeDonorMaxIn); the
//               dollars for the buy are at most NATIVE_DONOR.max6 (the $100 per-buy cap), W's gas floor on top;
//   steps       exactly one transaction: depositNative(W, id) into Relay's pinned depository (relayApi RELAY_DEPOSITORY), value
//               = the quoted input, 2 words of calldata, on the source chain (relayApi.evmStepsProblem + the length);
//   price       what lands, at the click chain's oracle, >= (what leaves at the source chain's oracle − Relay's stated fees)
//               × (1 − 2 × maxSlip) — two oracles, one per chain, each within the bound; Relay's fees at most max($0.25, 1 %).
// A quote that came through motion's keyed pass-through must also stand against Relay's own keyless price (relayApi).
import { FLOAT_CFG, RULES, USD, nativeToUsd6, nativeToUsd6Up, usd6ToNative, fmtUsd6, clickFloorOf, clickUsd6, type FloatChain } from './floatCore.ts';
import { NATIVE_EVM, NATIVE_SOL, RELAY_SOL, RELAY_DEPOSITORY, SEL_DEPOSIT_NATIVE, evmStepsProblem, type EvmStep } from './relayApi.ts';

export const NATIVE_DONOR = {
  max6: 100n * USD,          // the per-buy cap of the buys from the reserve (usdBuyEvm CURVE_BUY_MAX_USD): no single move above it
  feeMin6: USD / 4n,         // Relay's stated fees may be up to max($0.25, 1 % of the move) — measured 2026-10-30: $0.045–0.051 on $12–15
  feePct: 1n,
  gasMin: 50_000n,           // the deposit's gas limit: Relay's estimate × 1.5 (measured 32 969 on Robinhood, 32 463 on BNB), within these
  gasMax: 150_000n,
  partFee6: USD / 10n,       // what one Relay part is sized to cost at most beside 1 % of it (nativeDonorCap6; measured ~$0.05)
  parts: 2,                  // a click no single chain can pay: at most this many chains together (nativeDonorSplit; 2026-11-01)
} as const;
const relayId = (c: FloatChain) => FLOAT_CFG[c].relayChainId;
export const nativeOf = (c: FloatChain) => (FLOAT_CFG[c].kind === 'sol' ? NATIVE_SOL : NATIVE_EVM);

/**
 * What the click's chain still needs landed in W, raw native: W up to its gas floor (the native a trade's own fees and a new
 * coin account's rent need), plus the click's need + RULES.clickMarginPct that the float, the moves on their way and the moves
 * this click already started do not cover. The dollars for the buy are at most NATIVE_DONOR.max6: trimmed to it while that
 * still covers the need without the margin, else refused (the gas floor's few cents come on top). null = nothing to move.
 */
export function nativeDonorNeed(o: { chain: FloatChain; float: bigint; price6: bigint; inFlight6: bigint; need6: bigint; started6: bigint }): { out: bigint; usd6: bigint; trimmed: boolean; bare: bigint } | { refuse: string } | null {
  const cfg = FLOAT_CFG[o.chain];
  if (!(o.price6 > 0n) || !(o.need6 > 0n)) return null;
  // the click's floor (floatCore clickFloorOf, 2026-11-01): 0.009 SOL on Solana — this buy and its later sell — not the 0.02 background floor
  const floor = clickFloorOf(o.chain);
  let deficit = o.float < floor ? floor - o.float : 0n;
  // what is already on its way to W (moves in flight, the reserve moves this click started) fills W's gas floor FIRST, then the
  // buy (2026-11-01): the reserves' click top-up carries W's floor too now (planMoves), so counting those dollars as the buy's
  // as well asked the donor for too little — W landed below the click and hold & fire waited its whole 15 s
  let extra6 = o.inFlight6 + o.started6;
  if (deficit > 0n && extra6 > 0n) {
    const deficit6 = nativeToUsd6Up(deficit, o.price6, cfg.nativeDecimals);
    if (extra6 >= deficit6) { extra6 -= deficit6; deficit = 0n; }
    else { const got = usd6ToNative(extra6, o.price6, cfg.nativeDecimals); deficit = deficit > got ? deficit - got : 0n; extra6 = 0n; }
  }
  const have6 = clickUsd6(o.chain, o.float, o.price6) + extra6;
  const want6 = (o.need6 * RULES.clickMarginPct) / 100n;
  if (have6 >= want6 && deficit === 0n) return null;
  let rest6 = have6 >= want6 ? 0n : want6 - have6; let trimmed = false;
  if (rest6 + nativeToUsd6Up(deficit, o.price6, cfg.nativeDecimals) < RULES.clickMin6) return null;
  if (rest6 > NATIVE_DONOR.max6) {
    const bare6 = o.need6 > have6 ? o.need6 - have6 : 0n;
    if (bare6 > NATIVE_DONOR.max6) return { refuse: `the buy needs more than the ${fmtUsd6(NATIVE_DONOR.max6)} one move from another chain may carry` };
    rest6 = NATIVE_DONOR.max6; trimmed = true;
  }
  const out = deficit + usd6ToNative(rest6, o.price6, cfg.nativeDecimals);
  // the same without the 25 % margin (2026-11-01): what makes W's ready reach the click exactly, asked only when the donors
  // cannot carry the margin too (small balances: a $1 buy from $2.45 + $2.45 elsewhere). Relay's EXACT_OUTPUT lands it exactly
  const bareRest6 = o.need6 > have6 ? o.need6 - have6 : 0n;
  const bare = deficit + usd6ToNative(bareRest6 < rest6 ? bareRest6 : rest6, o.price6, cfg.nativeDecimals);
  return { out, usd6: nativeToUsd6Up(out, o.price6, cfg.nativeDecimals), trimmed, bare };
}

/** Relay's fees a move may carry: max($0.25, 1 % of it). */
export const nativeDonorFeeCap6 = (u6: bigint): bigint => ((u6 * NATIVE_DONOR.feePct) / 100n > NATIVE_DONOR.feeMin6 ? (u6 * NATIVE_DONOR.feePct) / 100n : NATIVE_DONOR.feeMin6);
/**
 * The most W may send on the donor chain for `out6` dollars landing: that value + Relay's fee cap + the two-oracle bound, at the
 * donor chain's oracle — and never above what it can spare. "Never more than the buy needs plus fees", in native.
 */
export function nativeDonorMaxIn(o: { from: FloatChain; out6: bigint; price6: bigint; spare: bigint; maxSlipBps: number }): bigint {
  if (!(o.price6 > 0n)) return 0n;
  const top6 = ((o.out6 + nativeDonorFeeCap6(o.out6)) * BigInt(10_000 + Math.min(2 * o.maxSlipBps, 200))) / 10_000n;
  const most = usd6ToNative(top6, o.price6, FLOAT_CFG[o.from].nativeDecimals);
  return most < o.spare ? most : o.spare;
}

/**
 * What W may give on its chain: its native above the gas floor, the kept trading float (`keep6` at `price6`) and the gas of the
 * deposit itself. A waiting click passes keep6 = 0 (2026-11-01, owner «доводи до уровня фомо … я даю добро на все»: deposit on one
 * chain, trade on any): the chain's ready float is the user's money as well, and a click elsewhere may take all of it above the
 * gas floor; that chain's reserve refills it in the background. The gas floor and the deposit's own gas always stay.
 */
export function nativeDonorSpare(o: { chain: FloatChain; float: bigint; price6: bigint; keep6: bigint; gasCost: bigint }): bigint {
  const cfg = FLOAT_CFG[o.chain];
  if (!(o.price6 > 0n)) return 0n;
  const keep = cfg.gasFloor + (o.keep6 > 0n ? usd6ToNative(o.keep6, o.price6, cfg.nativeDecimals) + 1n : 0n) + o.gasCost;
  return o.float > keep ? o.float - keep : 0n;
}

/** The Relay request a native donor asks for: EXACT_OUTPUT of `out` native on the click's chain, W → W. */
export function nativeDonorBody(o: { from: FloatChain; to: FloatChain; user: string; recipient: string; out: bigint; slipBps: number }) {
  return { user: o.user, recipient: o.recipient, originChainId: relayId(o.from), destinationChainId: relayId(o.to), originCurrency: nativeOf(o.from), destinationCurrency: nativeOf(o.to), amount: String(o.out), tradeType: 'EXACT_OUTPUT' as const, appFees: [] as { recipient: string; fee: string }[], slippageTolerance: String(Math.max(10, o.slipBps)) };
}

export type NativeDonorQuote = { amountIn: bigint; out: bigint; deposit: EvmStep; requestId: string; etaMs: number; fees6: bigint };
const eq = (a: unknown, b: string, sol: boolean) => (sol ? String(a ?? '') === b : String(a ?? '').toLowerCase() === b.toLowerCase());
const digits = (v: unknown) => /^\d{1,60}$/.test(String(v ?? ''));
/** Everything a quote must say before W signs its one deposit (see the file head). */
export function nativeDonorQuoteProblem(j: any, want: { from: FloatChain; to: FloatChain; user: string; recipient: string; out: bigint; maxIn: bigint }): { problem: string } | NativeDonorQuote {
  if (FLOAT_CFG[want.from].kind !== 'evm') return { problem: 'a native move is signed from an EVM chain only' };
  if (!j || typeof j !== 'object') return { problem: 'no quote' };
  const requestId = String(j.requestId || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) return { problem: 'no request id' };
  const d = j.details || {}, ci = d.currencyIn || {}, co = d.currencyOut || {};
  const toSol = relayId(want.to) === RELAY_SOL;
  if (!eq(d.sender, want.user, false)) return { problem: 'the quote names another sender' };
  if (!eq(d.recipient, want.recipient, toSol)) return { problem: 'the quote pays someone else' };
  if (Number(ci.currency?.chainId) !== relayId(want.from) || Number(co.currency?.chainId) !== relayId(want.to)) return { problem: 'the quote is for other chains' };
  if (!eq(ci.currency?.address, NATIVE_EVM, false)) return { problem: 'the quote spends another coin' };
  if (!eq(co.currency?.address, nativeOf(want.to), toSol)) return { problem: 'the quote pays another coin' };
  if (!digits(co.amount) || !digits(co.minimumAmount)) return { problem: 'the quote states no amount out' };
  const out = BigInt(String(co.amount)), min = BigInt(String(co.minimumAmount));
  if (out < want.out || min < want.out) return { problem: 'the quote lands less than the click needs' };
  if (!digits(ci.amount) || BigInt(String(ci.amount)) <= 0n) return { problem: 'the quote states no amount in' };
  const amountIn = BigInt(String(ci.amount));
  if (amountIn > want.maxIn) return { problem: 'the quote takes more than the wallet can spare there' };
  const st = evmStepsProblem(j, { user: want.user, originChainId: relayId(want.from), originCurrency: NATIVE_EVM, amount: String(amountIn) });
  if ('problem' in st) return st;
  if (String(st.deposit.data).length !== 10 + 128) return { problem: 'the deposit carries more than its two words' };
  const stepId = (j.steps || []).find((s: any) => s?.id === 'deposit')?.requestId;
  if (stepId && String(stepId) !== requestId) return { problem: 'the deposit names another request' };
  const usd = (k: string) => { const n = Number(j.fees?.[k]?.amountUsd || 0); return Number.isFinite(n) && n > 0 ? n : 0; };
  const fees6 = BigInt(Math.round((usd('relayer') + usd('gas') + usd('app')) * 1e6));
  return { amountIn, out, deposit: st.deposit, requestId, etaMs: Math.max(1_000, Number(d.timeEstimate || 0) * 1000), fees6 };
}

/** The price check across the two chains' own on-chain oracles. */
export function nativeDonorPriceProblem(o: { from: FloatChain; to: FloatChain; amountIn: bigint; inPrice6: bigint; out: bigint; outPrice6: bigint; fees6: bigint; maxSlipBps: number }): string | null {
  if (!(o.inPrice6 > 0n) || !(o.outPrice6 > 0n)) return 'no oracle price for one of the two chains';
  const in6 = nativeToUsd6Up(o.amountIn, o.inPrice6, FLOAT_CFG[o.from].nativeDecimals);
  const out6 = nativeToUsd6(o.out, o.outPrice6, FLOAT_CFG[o.to].nativeDecimals);
  if (o.fees6 > nativeDonorFeeCap6(in6)) return "Relay's fee is too high for this move";
  // two independent oracles, one per chain, each held to the slippage bound: measured 2026-10-30 (B:/tmp/native-donor/live-run.txt),
  // a $14.50 move lost 76 bps (Robinhood) / 86–90 bps (BNB) between the pools the vault prices with, Relay's $0.05 fee included
  const slip = Math.min(2 * o.maxSlipBps, 200);
  const floor = ((in6 - o.fees6) * BigInt(10_000 - slip)) / 10_000n;
  return out6 < floor ? "the quote pays below the two chains' prices minus fees and slippage" : null;
}

/** The one transaction the vault frame signs for a native donor, checked again where the key is: Relay's pinned depository,
 *  depositNative(THIS wallet, id) of exactly two words, a value, a gas limit within NATIVE_DONOR.gasMax. */
export function nativeDonorTxProblem(tx: { to: string; data: string; value: bigint }, wallet: string, gas: bigint): string | null {
  const d = String(tx.data).toLowerCase();
  if (String(tx.to).toLowerCase() !== RELAY_DEPOSITORY) return "not Relay's depository";
  if (!d.startsWith(SEL_DEPOSIT_NATIVE) || d.length !== 10 + 128) return 'not a native deposit';
  if ('0x' + d.slice(34, 74) !== wallet.toLowerCase()) return 'the deposit names another wallet';
  if (!(tx.value > 0n)) return 'no value';
  if (!(gas > 0n) || gas > NATIVE_DONOR.gasMax) return 'abnormal gas';
  return null;
}

/** The order donors are tried in: one that leaves its chain's kept ready float alone first (`drains` false), then the cheapest
 *  (dollars lost at the oracles), then the fastest. */
export function nativeDonorRank<T extends { lost6: bigint; etaMs: number; drains?: boolean }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => (Number(!!a.drains) - Number(!!b.drains)) || (a.lost6 < b.lost6 ? -1 : a.lost6 > b.lost6 ? 1 : a.etaMs - b.etaMs));
}

// ── two chains together (2026-11-01): a click no single chain can pay alone, paid by both ──
// Before, a donor had to carry the whole move: $2.45 on Robinhood + $2.45 on BNB never paid a $3 buy on Solana. Now each chain
// carries a part, every part is ONE depositNative of its own (EXACT_OUTPUT, every check of a single move, its own maxIn), and
// nothing is signed until every part's quote has passed. Parts land in W on the click's chain; they add up to what it needs.
/**
 * The most a donor of `spare` (raw, at its chain's `price6`) is asked to land for a click, in dollars: its spare less what a
 * Relay move really costs — up to 1 % of it and NATIVE_DONOR.partFee6 (measured 2026-10-30: ~0.4 % and $0.045–0.051). That
 * only sizes the part; the quote is then held to every check of a single move (what leaves <= the spare and <= what lands +
 * the fee cap + the slippage bound), so a dearer Relay answer is refused — nothing signed. Rounded DOWN.
 */
export function nativeDonorCap6(o: { from: FloatChain; spare: bigint; price6: bigint; maxSlipBps: number }): bigint {
  if (!(o.price6 > 0n) || !(o.spare > 0n)) return 0n;
  const spare6 = nativeToUsd6(o.spare, o.price6, FLOAT_CFG[o.from].nativeDecimals);
  const cap = ((spare6 - NATIVE_DONOR.partFee6) * 100n) / (100n + NATIVE_DONOR.feePct);
  return cap > 0n ? cap : 0n;
}
/**
 * How `out` (raw native on the click's chain, priced at `price6`) is split across donors that cannot carry it alone: the
 * largest first, each up to its cap, at most NATIVE_DONOR.parts of them, none below RULES.clickMin6. null = together they
 * cannot carry it (nothing is moved: a part alone would not make the click payable).
 */
export function nativeDonorSplit(o: { to: FloatChain; out: bigint; price6: bigint; donors: { d: FloatChain; cap6: bigint }[] }): { d: FloatChain; out: bigint }[] | null {
  if (!(o.price6 > 0n) || !(o.out > 0n)) return null;
  const dec = FLOAT_CFG[o.to].nativeDecimals;
  const live = o.donors.filter((x) => x.cap6 >= RULES.clickMin6).sort((a, b) => (a.cap6 > b.cap6 ? -1 : a.cap6 < b.cap6 ? 1 : 0)).slice(0, NATIVE_DONOR.parts);
  const parts: { d: FloatChain; out: bigint }[] = [];
  let rest = o.out;
  for (const x of live) {
    if (rest <= 0n) break;
    const capRaw = usd6ToNative(x.cap6, o.price6, dec);
    let part = capRaw < rest ? capRaw : rest;
    // never leave a remainder too small to move on its own for the next chain: this chain takes less, the next one more
    const after = rest - part;
    if (after > 0n && nativeToUsd6(after, o.price6, dec) < RULES.clickMin6) part = rest - usd6ToNative(RULES.clickMin6, o.price6, dec) - 1n;
    if (part <= 0n || nativeToUsd6(part, o.price6, dec) < RULES.clickMin6) continue;
    parts.push({ d: x.d, out: part }); rest -= part;
  }
  return rest > 0n || parts.length < 2 ? null : parts;
}
