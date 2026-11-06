// The "official" route into Elysium (2026-11-04, owner: «unlimited route into Elysium, not capped by motion's own HYPE float»).
//
// Two routes reach HYPE on Elysium from a wallet W:
//   float    motion's own bridge (src/bridgeSolver.ts + trench server/motion-bridge.mjs): the solver pays W on Elysium from its HYPE
//            float (one Inbox.createRetryableTicket on HyperEVM). Seconds, 0.1 % fee, but each fill is capped by the float
//            (health.elysium.maxFillUsd, ~$1.1K on 4 Nov). Unchanged here: it stays the fast path for amounts it can fill.
//   official Relay → W's OWN address on HyperEVM (chain 999, native HYPE) → W's OWN Inbox.depositEth() → W's same address on Elysium.
//            No float anywhere: Relay's solvers fill the first leg (quoted up to ~$975K per request on 4 Nov), the second leg is the
//            rollup's own canonical deposit. motion's 0.1 % is a Relay app fee on the same quote (fees.app, taken from the input
//            by Relay at fill, paid to motion's fee address): one signature on the source chain, no extra transfer, nothing
//            charged if Relay refunds.
//
// What W signs on this route, and nothing else:
//   1. Relay's deposit on the source chain (Robinhood ETH / USDG, BNB BNB / USDC, Solana SOL / USDC): the quote the vault fetched
//      from api.relay.link itself, checked by relayApi (depositor = W, recipient = W's EVM address on chain 999, the exact amount,
//      Relay's pinned depository / programs) and here (native HYPE out, the app fee = motion's 10 bps and no more, what arrives
//      against OUR prices).
//   2. On HyperEVM, once Relay's HYPE has arrived at W: ONE call Inbox(0xce59…2cff).depositEth() — selector 0x439370b1, no
//      arguments, value = what arrived (never more than the quote paid) less HyperEVM gas, gas ≤ 150 000, ≤ 50 gwei. Nitro credits
//      msg.sender itself on Elysium when msg.sender is a plain wallet (tx.origin == msg.sender, no code); a wallet WITH code (a
//      contract or an EIP-7702 delegation) would be credited at its alias — so W must have no code on HyperEVM, read before the
//      quote AND again right before this signature. The deposit is a plain balance credit on Elysium (an ArbitrumDepositTx,
//      type 0x64): nothing to redeem, nothing that can expire.
// Arrival on Elysium: the deposit's L2 hash is known in advance from the Inbox's message number (keccak256(0x64 ‖ rlp([99901,
// msgNum, alias(W), W, value]))); the vault waits for it (or for W's Elysium balance to rise by the value).
//
// A lost answer is followed, never re-signed: the job is written before each signature; the HyperEVM deposit's signed bytes are
// kept with the job, so a resume re-broadcasts the SAME bytes (same nonce) instead of signing again.
import { keccak256, toRlp, concat, toHex, pad } from 'viem';
import { detailsProblem, evmStepsProblem, solStepsProblem, NATIVE_EVM, NATIVE_SOL, RELAY_SOL, type RelayBody, type EvmStep, type SolIxJ } from './relayApi.ts';

export const ELY_ROUTE = Object.freeze({
  hyperChainId: 999,
  elysiumChainId: 99901,
  inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff',
  depositEth: '0x439370b1',                    // keccak256("depositEth()")[0:4]
  inboxMessageDelivered: '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b',   // InboxMessageDelivered(uint256 indexed, bytes)
  // motion's 0.1 % (owner 2026-11-04), as a Relay app fee on the quote: Relay takes it from the input at fill
  fee: { recipient: '0x9646BC34af009358873dC1B94e5B4C737E915380', bps: 10 },
  depositGas: 150_000n,                        // eth_estimateGas 92 957 (4 Nov, 0.01 HYPE from a plain EOA); real receipts 91 067
  maxGasPriceWei: 50_000_000_000n,             // 50 gwei (HyperEVM 0.15–0.83 gwei on 4 Nov), the same ceiling as HYPER_FUND
  maxLossBps: 300,                             // Relay's estimate vs OUR prices: fee + Relay's spread (≤ 0.86 % at $20K measured)
  maxMinLossBps: 500,                          // Relay's guaranteed minimum (its default 2 % slippage below the estimate) vs OUR prices
  minUsd: 1,                                   // below that Relay's own fee is most of it
  maxUsd: 1_000_000,                           // a bound on the request; Relay refuses above ~$975K itself (AMOUNT_TOO_HIGH)
  relayWaitMs: 15 * 60_000,                    // then the job stays 'relay' (resumable), never marked failed by time alone
  elysiumWaitMs: 10 * 60_000,
  pollMs: 1_500,
  // what the bridge page shows (measured 4 Nov): Relay ≈ 2 s quote ETA (fills seen in seconds), depositEth → Elysium 11–29 s wall clock
  etaMs: { relay: 15_000, inbox: 3_000, elysium: 20_000 },
});

export type RouteKind = 'float' | 'official';
export type SrcChain = 'robinhood' | 'bsc' | 'sol';
export type SrcCoin = 'native' | 'stable';
// Relay's ids and coins for each source (the same coins the float takes, src/motionBridgeCore.ts BRIDGE_CFG)
export const ELY_ROUTE_SRC: Record<SrcChain, { relayChainId: number; native: string; stable: string; nativeDecimals: number; stableDecimals: number; nativeSymbol: string; stableSymbol: string }> = {
  robinhood: { relayChainId: 4663, native: NATIVE_EVM, stable: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', nativeDecimals: 18, stableDecimals: 6, nativeSymbol: 'ETH', stableSymbol: 'USDG' },
  bsc: { relayChainId: 56, native: NATIVE_EVM, stable: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', nativeDecimals: 18, stableDecimals: 18, nativeSymbol: 'BNB', stableSymbol: 'USDC' },
  sol: { relayChainId: RELAY_SOL, native: NATIVE_SOL, stable: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', nativeDecimals: 9, stableDecimals: 6, nativeSymbol: 'SOL', stableSymbol: 'USDC' },
};
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

// ── the route choice (pure) ──
export type FloatHealth = { on: boolean; chains: string[]; maxFillUsd: number; minFillUsd: number; elysium?: { paused: boolean; why?: string[]; assets: string[]; maxFillUsd?: number; sources?: string[] } } | null;
export type RouteChoice = { route: RouteKind | null; float: { ok: boolean; why: string; maxFillUsd: number }; official: { ok: boolean; why: string } };
/** float when it can fill this amount from this source, else the official route; `force` picks one (and says why it cannot) */
export function pickRoute(o: { usd: number; src: SrcChain; coin: SrcCoin; health: FloatHealth; force?: RouteKind | null }): RouteChoice {
  const h = o.health, e = h?.elysium;
  const maxFillUsd = Number(e?.maxFillUsd ?? h?.maxFillUsd ?? 0) || 0;
  const floatWhy = !h || !h.on ? 'motion\'s bridge is off'
    : !h.chains.includes(o.src) || !h.chains.includes('elysium') ? 'motion\'s bridge does not take this network into Elysium'
      : !e || e.paused ? 'motion\'s Elysium funding is paused'
        : e.sources && !e.sources.includes(o.src) ? 'motion\'s bridge does not take this network into Elysium'
          : !(o.usd <= maxFillUsd) ? `above motion's float ($${Math.floor(maxFillUsd).toLocaleString('en-US')} per move)`
            : o.usd < (h.minFillUsd || 0) ? `below motion's minimum ($${h.minFillUsd})` : '';
  const officialWhy = !(o.usd >= ELY_ROUTE.minUsd) ? `at least $${ELY_ROUTE.minUsd}` : o.usd > ELY_ROUTE.maxUsd ? 'above the largest single move' : '';
  const float = { ok: !floatWhy, why: floatWhy, maxFillUsd }, official = { ok: !officialWhy, why: officialWhy };
  const route: RouteKind | null = o.force === 'float' ? (float.ok ? 'float' : null) : o.force === 'official' ? (official.ok ? 'official' : null)
    : float.ok ? 'float' : official.ok ? 'official' : null;
  return { route, float, official };
}

// ── Relay leg (pure) ──
export const elyAppFees = () => [{ recipient: ELY_ROUTE.fee.recipient, fee: String(ELY_ROUTE.fee.bps) }];
/** the request the vault sends to api.relay.link: payer on the source chain → W on HyperEVM, native HYPE, motion's 10 bps */
export function elyRelayBody(o: { src: SrcChain; coin: SrcCoin; payer: string; w: string; amount: bigint }): RelayBody {
  const s = ELY_ROUTE_SRC[o.src]; if (!s) throw new Error('This network cannot fund Elysium');
  if (!EVM_ADDR.test(o.w)) throw new Error('This wallet has no EVM address for Elysium');
  if (!(o.amount > 0n)) throw new Error('Invalid amount');
  return { user: o.payer, recipient: o.w, originChainId: s.relayChainId, destinationChainId: ELY_ROUTE.hyperChainId, originCurrency: o.coin === 'native' ? s.native : s.stable,
    destinationCurrency: NATIVE_EVM, amount: o.amount.toString(), tradeType: 'EXACT_INPUT', appFees: elyAppFees() };
}
export type ElyRelayBound = { requestId: string; out: bigint; minOut: bigint; appFee: bigint; relayFeeUsd: number; gasUsd: number; etaS: number; evm?: { approve: EvmStep | null; deposit: EvmStep }; sol?: { ixs: SolIxJ[]; tables: string[] } };
/** every check of Relay's answer for this body ('problem' = refuse); inUsd6 / outPrice6 are OUR prices (the input's USD value, HYPE's) */
export function elyRelayProblem(j: any, body: RelayBody, ours: { inUsd6: bigint; hypePrice6: bigint }): { problem: string } | ElyRelayBound {
  const bad = detailsProblem(j, body); if (bad) return { problem: bad };
  const d = j.details, co = d.currencyOut;
  if (Number(co.currency?.chainId) !== ELY_ROUTE.hyperChainId || String(co.currency?.address).toLowerCase() !== NATIVE_EVM || Number(co.currency?.decimals) !== 18) return { problem: 'the quote does not pay native HYPE on HyperEVM' };
  const out = BigInt(String(co.amount));
  const minRaw = String(co.minimumAmount ?? co.amount);
  const minOut = /^\d{1,60}$/.test(minRaw) ? BigInt(minRaw) : -1n;
  if (!(minOut > 0n) || minOut > out) return { problem: 'the quote has no sane minimum' };
  // motion's fee: what Relay says it takes for the app, in the INPUT coin, at most 10 bps of the amount (+1 unit of rounding)
  const fa = j.fees?.app, amount = BigInt(body.amount);
  const appRaw = String(fa?.amount ?? '0'), appFee = /^\d{1,60}$/.test(appRaw) ? BigInt(appRaw) : -1n;
  if (appFee < 0n) return { problem: 'the quote has no readable app fee' };
  if (appFee > (amount * BigInt(ELY_ROUTE.fee.bps)) / 10_000n + 1n) return { problem: 'the quote charges more than motion\'s 0.1 % fee' };
  if (appFee > 0n && String(fa?.currency?.address ?? '').toLowerCase() !== String(body.originCurrency).toLowerCase()) return { problem: 'the app fee is in another coin' };
  // what reaches HyperEVM against OUR prices: the estimate within 3 %, Relay's guaranteed minimum within 5 %
  if (!(ours.hypePrice6 > 0n) || !(ours.inUsd6 > 0n)) return { problem: 'no fresh price to check the quote against' };
  const usdOf = (wei: bigint) => (wei * ours.hypePrice6) / 10n ** 18n;
  if (usdOf(out) * 10_000n < ours.inUsd6 * BigInt(10_000 - ELY_ROUTE.maxLossBps)) return { problem: 'it pays far less HYPE than the coins are worth' };
  if (usdOf(minOut) * 10_000n < ours.inUsd6 * BigInt(10_000 - ELY_ROUTE.maxMinLossBps)) return { problem: 'its guaranteed minimum is far below what the coins are worth' };
  let steps: Pick<ElyRelayBound, 'evm' | 'sol'>;
  if (body.originChainId === RELAY_SOL) { const s = solStepsProblem(j, body.user); if ('problem' in s) return s; steps = { sol: s }; }
  else { const s = evmStepsProblem(j, { user: body.user, originChainId: body.originChainId, originCurrency: body.originCurrency, amount: body.amount }); if ('problem' in s) return s; steps = { evm: s }; }
  const usd = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : 0; };
  return { requestId: String(j.requestId), out, minOut, appFee, relayFeeUsd: usd(j.fees?.relayer?.amountUsd), gasUsd: usd(j.fees?.gas?.amountUsd), etaS: usd(d.timeEstimate), ...steps };
}

// ── HyperEVM leg (pure) ──
export function inboxDepositTx(amount: bigint): { to: `0x${string}`; value: bigint; data: `0x${string}` } {
  if (!(amount > 0n)) throw new Error('Refusing to sign: nothing to deposit');
  return { to: ELY_ROUTE.inbox as `0x${string}`, value: amount, data: ELY_ROUTE.depositEth as `0x${string}` };
}
/** '' = exactly W's own depositEth on HyperEVM: chain 999, the pinned Inbox, no argument, a value, bounded gas */
export function inboxDepositProblem(tx: { chainId?: number; to?: string; value?: bigint; data?: string; gas?: bigint; gasPrice?: bigint }, max: bigint): string {
  if (tx.chainId !== ELY_ROUTE.hyperChainId) return 'not HyperEVM';
  if (String(tx.to || '').toLowerCase() !== ELY_ROUTE.inbox) return 'not the Elysium Inbox';
  if (String(tx.data || '').toLowerCase() !== ELY_ROUTE.depositEth) return 'not a plain depositEth()';
  if (!((tx.value ?? 0n) > 0n) || (tx.value ?? 0n) > max) return 'another amount';
  if (!((tx.gas ?? 0n) > 0n) || (tx.gas ?? 0n) > ELY_ROUTE.depositGas) return 'abnormal gas';
  if (!((tx.gasPrice ?? 0n) > 0n) || (tx.gasPrice ?? 0n) > ELY_ROUTE.maxGasPriceWei) return 'abnormal gas price';
  return '';
}
/** has Relay's HYPE arrived at W on HyperEVM? arrived = W's balance rise since the job began */
export function relayArrival(o: { before: bigint; now: bigint; minOut: bigint; status: string | null }): 'arrived' | 'refunded' | 'waiting' {
  if (o.status === 'refund' || o.status === 'refunded' || o.status === 'failure') return 'refunded';
  const arrived = o.now - o.before;
  if (arrived >= o.minOut) return 'arrived';
  if (o.status === 'success' && arrived > 0n) return 'arrived';
  return 'waiting';
}
/** what W deposits: what arrived (never more than the quote paid), less this deposit's gas, within W's balance */
export function depositAmount(o: { before: bigint; now: bigint; out: bigint; gasCost: bigint }): bigint {
  let v = o.now - o.before; if (v > o.out) v = o.out;
  if (v > o.now - o.gasCost) v = o.now - o.gasCost;
  v -= o.gasCost;
  return v > 0n ? v : 0n;
}
// ── Elysium arrival (pure) ──
export const l1ToL2Alias = (a: string): `0x${string}` => ('0x' + ((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0')) as `0x${string}`;
const rlpInt = (v: bigint): `0x${string}` => (v === 0n ? '0x' : toHex(v));
/** the hash of the ArbitrumDepositTx (type 0x64) Elysium makes from W's depositEth: keccak256(0x64 ‖ rlp([chainId, msgNum, alias(W), W, value])) */
export function elyDepositHash(msgNum: bigint, w: string, value: bigint): `0x${string}` {
  return keccak256(concat(['0x64', toRlp([rlpInt(BigInt(ELY_ROUTE.elysiumChainId)), pad(toHex(msgNum), { size: 32 }), l1ToL2Alias(w), w.toLowerCase() as `0x${string}`, rlpInt(value)])]));
}
/** the Inbox's message number from W's depositEth receipt (InboxMessageDelivered topic1), or null */
export function inboxMessageNum(logs: { address?: string; topics?: readonly string[] }[]): bigint | null {
  for (const l of logs || []) if (String(l.address || '').toLowerCase() === ELY_ROUTE.inbox && String(l.topics?.[0] || '').toLowerCase() === ELY_ROUTE.inboxMessageDelivered && l.topics?.[1]) return BigInt(l.topics[1]);
  return null;
}

// ── the runner ──
// planned → relay (Relay's deposit signed and sent) → hyper (HYPE at W on HyperEVM) → inbox (depositEth sent) → done (on Elysium);
// refunded (Relay refunded on the source: nothing more happens) | failed (nothing of W's moved, or a refusal before a signature)
export type ElyRouteState = 'planned' | 'relay' | 'hyper' | 'inbox' | 'done' | 'refunded' | 'failed';
export type ElyRouteJob = {
  id: string; v: 1; walletId: string; w: string; payer: string; src: SrcChain; coin: SrcCoin; amountIn: string; requestId: string; out: string; minOut: string;
  hyperBefore: string; elyBefore: string; state: ElyRouteState; at: number; srcHash?: string; depositRaw?: string; depositHash?: string; depositValue?: string;
  msgNum?: string; elyHash?: string; why?: string;
};
export type ElyRouteDeps = {
  now: () => number; wait: (ms: number) => Promise<void>;
  store: { get: (k: string) => string | null; set: (k: string, v: string) => void };
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  src: () => SrcChain;                                                     // this frame's chain (Robinhood / BNB / Solana)
  wallet: (id: string) => { id: string; name: string; w: `0x${string}`; payer: string; signHyper: (tx: { to: `0x${string}`; value: bigint; data: `0x${string}`; gas: bigint; gasPrice: bigint; nonce: number; chainId: number; type: 'legacy' }) => Promise<`0x${string}`> };
  reads: {
    srcBalance: (payer: string, coin: SrcCoin) => Promise<bigint>;
    inUsd6: (coin: SrcCoin, amount: bigint) => Promise<bigint>;           // OUR price of the input (the float's pools)
    hypePrice6: () => Promise<bigint>;                                    // OUR HYPE price: the HyperEVM WHYPE/USDC pool
    hyperBalance: (w: `0x${string}`) => Promise<bigint>;
    hyperCode: (w: `0x${string}`) => Promise<string | null>;
    hyperNonce: (w: `0x${string}`) => Promise<number>;
    hyperGasPrice: () => Promise<bigint>;
    hyperEstimate: (tx: { from: `0x${string}`; to: `0x${string}`; value: bigint; data: `0x${string}` }) => Promise<bigint>;
    hyperReceipt: (hash: `0x${string}`) => Promise<{ status: 'success' | 'reverted'; logs: { address?: string; topics?: readonly string[] }[] } | null>;
    elyBalance: (w: `0x${string}`) => Promise<bigint>;
    elyTx: (hash: `0x${string}`) => Promise<{ blockNumber: bigint | null } | null>;
  };
  relay: { quote: (body: RelayBody) => Promise<any>; status: (requestId: string) => Promise<string | null> };
  sendRelay: (walletId: string, body: RelayBody, bound: ElyRelayBound) => Promise<string>;   // the source deposit (relaySwap's EVM / Solana send)
  sendHyper: (raw: `0x${string}`) => Promise<void>;                       // broadcast on the official HyperEVM node
  gate: () => Promise<void>;
  ask: (o: { title: string; html: string; ok: string }) => Promise<boolean>;
  esc: (v: unknown) => string; destBox: (address: string) => string;
  back: string; risk: string;
  fmtIn: (coin: SrcCoin, amount: bigint) => string;                       // '0.5 ETH', '500 USDG'
  emit?: (detail: Record<string, unknown>) => void;
};
const JOBS_KEY = 'trenches.elyRoute.jobs';
export const fmtHype = (wei: bigint): string => { const m = (wei + 50_000_000_000_000n) / 100_000_000_000_000n; return `${m / 10_000n}.${String(m % 10_000n).padStart(4, '0')} HYPE`; };
const usdText = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

export function createElyRoute(deps: ElyRouteDeps) {
  const load = (): Record<string, ElyRouteJob> => { try { const j = JSON.parse(deps.store.get(JOBS_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const save = (job: ElyRouteJob) => {
    const all = load(); all[job.id] = { ...job, at: deps.now() };
    const keep = Object.values(all).sort((a, b) => b.at - a.at).slice(0, 30);
    deps.store.set(JOBS_KEY, JSON.stringify(Object.fromEntries(keep.map((x) => [x.id, x]))));
    deps.emit?.({ kind: 'elysium-route', id: job.id, state: job.state, srcHash: job.srcHash || null, depositHash: job.depositHash || null, elyHash: job.elyHash || null, why: job.why || null });
  };
  const view = (j: ElyRouteJob) => ({ ok: j.state !== 'failed' && j.state !== 'refunded', route: 'official' as const, jobId: j.id, state: j.state, requestId: j.requestId, srcHash: j.srcHash || null,
    depositHash: j.depositHash || null, elyHash: j.elyHash || null, out: j.out, deposit: j.depositValue || null, why: j.why || null });

  /** quote (no signature, no dialog): Relay's checked quote + what the page shows */
  async function quote(a: { walletId: string; coin: SrcCoin; amount: bigint }) {
    const src = deps.src(), w = deps.wallet(a.walletId);
    const [code, bal] = await Promise.all([deps.reads.hyperCode(w.w).catch(() => null), deps.reads.srcBalance(w.payer, a.coin)]);
    if (code === null) throw new Error('HyperEVM could not be read — try again in a moment');
    if (code !== '0x') throw new Error('This wallet has code on HyperEVM (a contract or a delegation) — Elysium deposits credit plain wallets only');
    if (bal < a.amount) throw new Error('More than this wallet holds');
    const body = elyRelayBody({ src, coin: a.coin, payer: w.payer, w: w.w, amount: a.amount });
    const [j, inUsd6, hypePrice6] = await Promise.all([deps.relay.quote(body), deps.reads.inUsd6(a.coin, a.amount), deps.reads.hypePrice6()]);
    const b = elyRelayProblem(j, body, { inUsd6, hypePrice6 });
    if ('problem' in b) throw new Error('Relay\'s quote was refused: ' + b.problem);
    const gasWei = ELY_ROUTE.depositGas * 2n * 1_000_000_000n;   // the deposit's HyperEVM gas, priced high (2 gwei) for the page
    const outEly = b.out > gasWei ? b.out - gasWei : 0n;
    const feeUsd = Number(inUsd6) / 1e6 * ELY_ROUTE.fee.bps / 10_000;
    const etaMs = Math.max(b.etaS * 1000, ELY_ROUTE.etaMs.relay) + ELY_ROUTE.etaMs.inbox + ELY_ROUTE.etaMs.elysium;
    return { body, bound: b, src, w, inUsd6, hypePrice6, view: {
      route: 'official' as const, out: outEly.toString(), outText: fmtHype(outEly), outMin: b.minOut.toString(), etaMs,
      fees: { motion: { bps: ELY_ROUTE.fee.bps, amount: b.appFee.toString(), usd: feeUsd }, relay: { usd: b.relayFeeUsd }, gas: { usd: b.gasUsd } },
      feeText: `motion 0.1 % (${usdText(feeUsd)}) + Relay ${usdText(b.relayFeeUsd)}`, steps: ['relay', 'hyperevm', 'inbox', 'elysium'], requestId: b.requestId,
    } };
  }

  async function go(a: { walletId: string; coin: SrcCoin; amount: bigint; gate?: () => Promise<void> }) {
    const q = await quote(a);
    await (a.gate ?? deps.gate)();
    const inText = deps.fmtIn(a.coin, a.amount);
    const p = (s: string, cls = 'dk-sub') => `<p class="${cls}">${deps.esc(s)}</p>`;
    const ok = await deps.ask({
      title: 'Add funds on Elysium (official route)', ok: `Pay ${inText}`,
      html: p(`${inText} from ${q.w.name} through Relay to the same address on HyperEVM, then your wallet deposits it through Elysium's official Inbox to the same address on Elysium. About ${q.view.outText} arrives, usually within a minute.`)
        + deps.destBox(q.w.w)
        + p(`Two signatures, both from this wallet: Relay's deposit now, and Inbox.depositEth() on HyperEVM once the HYPE is there (no other dialog). If Relay cannot fill, it refunds you on the source network.`, 'dk-muted')
        + p(`Fees: ${q.view.feeText}, plus network gas.`, 'dk-muted') + p(deps.back, 'dk-muted') + p(deps.risk, 'dk-muted'),
    });
    if (!ok) throw new Error('Cancelled');
    return deps.lock('elyroute:' + q.w.w.toLowerCase(), async () => {
      const [hyperBefore, elyBefore] = await Promise.all([deps.reads.hyperBalance(q.w.w), deps.reads.elyBalance(q.w.w).catch(() => 0n)]);
      const job: ElyRouteJob = { id: q.bound.requestId, v: 1, walletId: q.w.id, w: q.w.w, payer: q.w.payer, src: q.src, coin: a.coin, amountIn: a.amount.toString(), requestId: q.bound.requestId,
        out: q.bound.out.toString(), minOut: q.bound.minOut.toString(), hyperBefore: hyperBefore.toString(), elyBefore: elyBefore.toString(), state: 'planned', at: deps.now() };
      save(job);                                                                    // before the first signature
      try { job.srcHash = await deps.sendRelay(q.w.id, q.body, q.bound); }
      catch (e) { job.state = 'failed'; job.why = String((e as Error)?.message || e).slice(0, 200); save(job); throw e; }
      job.state = 'relay'; save(job);
      return follow(job);
    });
  }

  /** the rest of a job: wait for Relay's HYPE on HyperEVM → W's depositEth → wait for Elysium. Safe to call again (resume). */
  async function follow(job: ElyRouteJob, opts: { askFirst?: boolean } = {}) {
    const w = deps.wallet(job.walletId);
    if (w.w.toLowerCase() !== job.w.toLowerCase()) throw new Error('This job is for another wallet');
    if (job.state === 'relay') {
      const until = deps.now() + ELY_ROUTE.relayWaitMs;
      for (;;) {
        const [now, status] = await Promise.all([deps.reads.hyperBalance(w.w), deps.relay.status(job.requestId).catch(() => null)]);
        const r = relayArrival({ before: BigInt(job.hyperBefore), now, minOut: BigInt(job.minOut), status });
        if (r === 'refunded') { job.state = 'refunded'; job.why = 'Relay refunded the deposit on the source network'; save(job); return view(job); }
        if (r === 'arrived') { job.state = 'hyper'; save(job); break; }
        if (deps.now() > until) return { ...view(job), waiting: true };           // still 'relay': resume later
        await deps.wait(ELY_ROUTE.pollMs);
      }
    }
    if (job.state === 'hyper' && !job.depositRaw) {
      const [now, code, nonce, gp0] = await Promise.all([deps.reads.hyperBalance(w.w), deps.reads.hyperCode(w.w).catch(() => null), deps.reads.hyperNonce(w.w), deps.reads.hyperGasPrice()]);
      if (code !== '0x') { job.why = code === null ? 'HyperEVM could not be read' : 'This wallet has code on HyperEVM now — a deposit would be credited elsewhere; the HYPE stays at your HyperEVM address'; save(job); throw new Error(job.why); }
      const gasPrice = (gp0 * 5n) / 4n;
      if (gasPrice > ELY_ROUTE.maxGasPriceWei) throw new Error('HyperEVM gas is far above normal right now — your HYPE waits at your HyperEVM address; resume later');
      const gasCost = ELY_ROUTE.depositGas * gasPrice;
      const value = depositAmount({ before: BigInt(job.hyperBefore), now, out: BigInt(job.out), gasCost });
      if (!(value > 0n)) { job.why = 'Nothing arrived to deposit'; save(job); throw new Error(job.why); }
      const base = inboxDepositTx(value);
      const est = await deps.reads.hyperEstimate({ from: w.w, ...base }).catch(() => ELY_ROUTE.depositGas);
      const gas = (() => { const g = (est * 13n) / 10n; return g > ELY_ROUTE.depositGas ? ELY_ROUTE.depositGas : g < 100_000n ? 100_000n : g; })();
      const tx = { ...base, gas, gasPrice, nonce, chainId: ELY_ROUTE.hyperChainId, type: 'legacy' as const };
      const why = inboxDepositProblem(tx, BigInt(job.out)); if (why) throw new Error('Refusing to sign: ' + why);
      if (opts.askFirst) {
        const ok = await deps.ask({ title: 'Finish moving to Elysium', ok: `Deposit ${fmtHype(value)}`, html: `<p class="dk-sub">${deps.esc(`${fmtHype(value)} from Relay is at ${w.name}'s HyperEVM address. Deposit it through Elysium's official Inbox to the same address on Elysium.`)}</p>${deps.destBox(w.w)}` });
        if (!ok) throw new Error('Cancelled');
      }
      const raw = await w.signHyper(tx);
      job.depositRaw = raw; job.depositHash = keccak256(raw); job.depositValue = value.toString(); save(job);   // before the broadcast
    }
    if (job.state === 'hyper' && job.depositRaw) {
      await deps.sendHyper(job.depositRaw as `0x${string}`).catch(() => {});      // same bytes on every resume; the receipt decides
      const until = deps.now() + 60_000;
      for (;;) {
        const rc = await deps.reads.hyperReceipt(job.depositHash as `0x${string}`).catch(() => null);
        if (rc) {
          if (rc.status !== 'success') { job.state = 'failed'; job.why = 'The Inbox deposit reverted — your HYPE stays at your HyperEVM address'; save(job); return view(job); }
          const n = inboxMessageNum(rc.logs);
          job.msgNum = n === null ? undefined : n.toString();
          job.elyHash = n === null ? undefined : elyDepositHash(n, w.w, BigInt(job.depositValue!));
          job.state = 'inbox'; save(job); break;
        }
        if (deps.now() > until) return { ...view(job), waiting: true };
        await deps.wait(ELY_ROUTE.pollMs);
        await deps.sendHyper(job.depositRaw as `0x${string}`).catch(() => {});
      }
    }
    if (job.state === 'inbox') {
      const until = deps.now() + ELY_ROUTE.elysiumWaitMs;
      for (;;) {
        const t = job.elyHash ? await deps.reads.elyTx(job.elyHash as `0x${string}`).catch(() => null) : null;
        if (t && t.blockNumber !== null) { job.state = 'done'; save(job); break; }
        const bal = await deps.reads.elyBalance(w.w).catch(() => -1n);
        if (bal >= BigInt(job.elyBefore) + BigInt(job.depositValue || '0')) { job.state = 'done'; save(job); break; }
        if (deps.now() > until) return { ...view(job), waiting: true };
        await deps.wait(ELY_ROUTE.pollMs);
      }
    }
    return view(job);
  }
  const jobs = () => Object.values(load()).sort((a, b) => b.at - a.at);
  const status = (id: string) => { const j = load()[String(id)]; return j ? view(j) : null; };
  const resume = (id: string) => {
    const j = load()[String(id)]; if (!j) return Promise.reject(new Error('Unknown move'));
    if (j.state === 'done' || j.state === 'failed' || j.state === 'refunded') return Promise.resolve(view(j));
    return deps.lock('elyroute:' + j.w.toLowerCase(), () => follow(load()[j.id] || j, { askFirst: j.state === 'hyper' && !j.depositRaw }));
  };
  return { quote, go, follow, status, resume, jobs };
}
