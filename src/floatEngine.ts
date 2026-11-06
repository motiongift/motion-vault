// One USD balance — the vault side (design: trench docs/drafts/USDC-BALANCE.md; the pure rules: src/floatCore.ts).
//
// `createFloat(deps)` runs in every lane's vault frame and works on THAT frame's chain only: it reads its chain (W's
// float, R's stablecoin and gas, the on-chain oracle, the gas price) through the float's OWN read client (other
// endpoints than a trade's first node, ≤ 1 request/s in the background; the reads a user's click waits on — the switch's
// dialogs, the app's pre-dialog status — skip that bucket: batched, every wallet at once), writes a snapshot that the other frames of this vault origin
// read, plans for the whole wallet from those snapshots, and executes only the moves that START on its chain:
//   topup / sweep / gas   on this chain;
//   rebalance / cold      when this chain's reserve is the donor (a bridge deposit from R here).
// It never sees a key: webEngine hands it signers for W and R. Nothing here runs between a click and its send — every
// network step first checks the click window (floatCore.inClickWindow), and no trade entry point reaches this module.
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { createSolverBridge, SolverRefused, SolverUnknown, MOTION_BRIDGE_MAX6, type SolverDeps } from './bridgeSolver.ts';
import { erc20TransferData, type BridgeChain } from './motionBridgeCore.ts';
import {
  FLOAT_CFG, FLOAT_CHAIN_KEYS, cfgOf, type FloatChain, type EvmFloatCfg, type Caps, type Permission, type FloatJob, type Move, type MoveKind, type ChainState,
  type FeeInputs, type BridgeId, type BridgeQuote, type BridgeOutcome, type RouteKey,
  capsFrom, capsRaise, termsOk, permissionDigest, plannedCaps, UNCAPPED, permissionLive, PERMISSION_DAYS, floatArgs, planMoves, withinCaps, minOutFloor, quoteOk, verifyBridgeTxs,
  oraclePrice6, stableToUsd6, usd6ToStable, nativeToUsd6, nativeToUsd6Up, usd6ToNative, tradingUsd6, targetOf, sizeOf, priceState, fmtUsd6, usd6, USD,
  jobIdOf, freeJobId, BRIDGE_SETTLE_MS, canRun, isOpen, ledgerOf, inClickWindow, moveFee6, bridgeHealth, bridgeOrder, verifyBridgeQuote, BRIDGE_ETA_MS, QUOTE_TIMEOUT_MS, RULES,
  quietFor, planConvert, planConvertBack, fmtNative, keepOf, DEFAULT_CAPS, CONVERT_ORDER_MS, CONVERT_TRIES, CONVERT_BACK_MIN6, SOL_FWD, solForwardPlan, solBridgeFeeOk, SOL_GAS, solFwdFee, SOL_BRIDGE,
  accountDigest, accountLive, accountPermissionText, accountConvertView, accountOffView, dialogViewHtml, consentHtml, langOf, ACCOUNT_DIALOG, ACCOUNT_MORE, ACCOUNT_DEVICES, type AccountGrant, type WalletSkipWhy, type FloatLang,
} from './floatCore.ts';
// the rules version a grant agreed to (floatCore FLOAT_RULES): liveness is judged against this build's accepted rules
import { accountLive as liveAccount, permissionLive as livePermission, accountOutdated, rulesOf, rulesField, rulesDeltaLines, FLOAT_RULES, RULES_DELTA, RULES_DIALOG, type RulesCfg } from './floatCore.ts';
// the consent that follows the account to its other devices (sealed + signed in the account's backup profile)
import { consentMessage, sameTerms, CO_MAX, type CapsWire, type ConsentBody, type ConsentHost, type ConsentRecord, type ConsentWhy } from './floatConsent.ts';
// a switch-on for an account that already holds dollars: a confirm that converts nothing by default (2026-11-01)
import { RESUME, accountResumeHtml, convertTotalText, widenLine, type OnWhy } from './floatCore.ts';
// the ready float after a trade (owner 2026-10-29): the refill tick, the buys it is sized from, the sweep hold in a burst
import { REFILL, readySize6, readyMultTenths, burstOf, sweepAllowed, DIRECT_BUY_RULES } from './floatCore.ts';
// a click's cross-chain top-up in parts under motion's per-fill cap, the settle wait's proof, the refusal codes (2026-11-01 pass 2)
import { partMaxOf, xchainClickMax6, payoutSeen, clickCodeOf, clickUsd6 } from './floatCore.ts';
// ready dollars on every chain the user trades (A1) and motion's 'paid' at the payout's broadcast (A3), 2026-11-01 pass 3
import { READY, readyFeeMax6, readyFeesOf } from './floatCore.ts';
// float.convert (release 9): the USD balance into the chain's own coin, kept in the wallet
import { CONVERT_MIN6, convertCheck, convKept, convertWhy, type ConvertCode, type ConvItem } from './floatCore.ts';
// float.withdraw (release 9): the reserve's stablecoin out, as the stablecoin
import { WITHDRAW_MIN6, withdrawWhy, decimalOf, type WithdrawCode } from './floatCore.ts';
// the EVM buy from the reserve's standing allowances (src/usdBuyEvm.ts; owner 2026-10-29)
import { PERMIT2_ALLOWANCE_ABI, permit2ApproveData, CURVE_ROUTER } from './usdBuyEvm.ts';
import { PERMIT2, UNIVERSAL_ROUTER } from './evmV4Router.ts';
import { relayQuote, relayStatus, relayRequestsOf, detailsProblem, evmStepsProblem, independentOut, priceProblem, type QuoteSource } from './relayApi.ts';
// the trading wallet's own native on another chain as a waiting click's donor (src/nativeDonor.ts; 2026-10-30)
// Earn on the USD balance (src/earnEngine.ts, 2026-11-03): the reserve's surplus over a liquid buffer in ONE allow-listed vault
import { earnArgs } from './earnCore.ts';
import type { EarnApi } from './earnEngine.ts';
import { NATIVE_DONOR, nativeDonorNeed, nativeDonorSpare, nativeDonorMaxIn, nativeDonorBody, nativeDonorQuoteProblem, nativeDonorPriceProblem, nativeDonorRank, nativeDonorCap6, nativeDonorSplit } from './nativeDonor.ts';

export type FloatWallet = { id: string; name: string; w: { evm: `0x${string}`; sol: string }; r: { evm: `0x${string}`; sol: string } };
// every wallet of the account the vault holds: the ones a USD balance runs for, and the ones it skips (and why)
export type FloatWalletList = { list: FloatWallet[]; skipped: { id: string; name: string; why: WalletSkipWhy }[] };
export type EvmTx = { to: `0x${string}`; data: `0x${string}`; value: bigint };
export type ClickState = { clickAt: number; clickDoneAt: number; focusAt: number; focusChain: string | null; hidden: boolean; ticketAt: number; lastTradeAt: number; limitBusy: boolean; clicks?: number[] };
export type FloatDeps = {
  // the rules version this build writes and the oldest it accepts, with their delta lines (tests; default floatCore FLOAT_RULES)
  rules?: RulesCfg & { delta?: typeof RULES_DELTA };
  chain: () => FloatChain | null;                       // this frame's chain; null on NEAR (no float there)
  wallet: (id: string) => FloatWallet;                  // throws for Privy / hop / chain-only wallets
  wallets?: () => FloatWalletList;                      // the account's wallets (one switch for all); left out = the caller's wallet only
  evm?: {
    call: (tx: EvmTx & { from: `0x${string}` }) => Promise<`0x${string}`>;
    balance: (a: `0x${string}`) => Promise<bigint>;
    erc20: (token: `0x${string}`, owner: `0x${string}`) => Promise<bigint>;
    allowance: (token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`) => Promise<bigint>;
    slot0: (pool: `0x${string}`) => Promise<bigint>;
    fees: () => Promise<{ baseFee: bigint; gasPrice: bigint; l1PerByte: bigint }>;
    estimate: (tx: EvmTx & { from: `0x${string}` }) => Promise<bigint>;
    // the keccak256 of the code at an address ('0x' hash of nothing when none): UsdBuyRouter is approved only once deployed as audited
    codeHash?: (a: `0x${string}`) => Promise<string>;
    sendR: (walletId: string, tx: EvmTx, gas: bigint) => Promise<`0x${string}`>;   // R's own nonce lane
    sendW: (walletId: string, tx: EvmTx, gas: bigint) => Promise<`0x${string}`>;   // W's send lane (sweeps, R's gas): idle only
    receipt: (hash: `0x${string}`, ms: number) => Promise<{ status: 'success' | 'reverted' } | null>;
  };
  sol?: {
    balance: (a: string) => Promise<bigint>;
    usdc: (owner: string) => Promise<bigint>;
    oracle6: () => Promise<bigint>;                                                  // SOL in micro-dollars, from a SECOND DLMM pool
    fees: () => Promise<{ microMedium: number; microHigh: number; microVeryHigh: number; tipP75: number; tipP95: number }>;
    topup: (walletId: string, usdcIn: bigint, minLamports: bigint) => Promise<string>;   // R: sell USDC on the pinned pool, pay W minOut (one tx)
    sweep: (walletId: string, lamportsIn: bigint, minUsdc: bigint) => Promise<string>;   // W: buy USDC, pay R minOut (one tx)
    gas: (walletId: string, lamports: bigint) => Promise<string>;                       // W → R
    quote: (dir: 'usdc→sol' | 'sol→usdc', amountIn: bigint) => Promise<bigint>;
    status: (sig: string) => Promise<'confirmed' | 'failed' | null>;
    // USDC sent straight to W (forwardSol). Left out = no forward on Solana (older hosts): W's USDC is not even read
    forward?: (walletId: string, units: bigint) => Promise<string>;                  // W: its USDC to its own R (one transferChecked; R's account created if missing)
    // (release 9) float.withdraw: R's USDC of the pinned mint to `to` (one transferChecked, its account created if missing, R pays). Left out = no withdraw on Solana
    withdraw?: (walletId: string, to: string, units: bigint) => Promise<string>;
    fundW?: (walletId: string, lamports: bigint) => Promise<string>;                 // R → W lamports: the fee of that forward when W has no SOL
  };
  // motion's own bridge (docs/drafts/MOTION-BRIDGE.md): the origin to ask, the pinned quote key and the two signers.
  // Left out (or `solverKey` empty) = the motion bridge does not exist for this frame and every move takes Relay.
  solver?: {
    base: () => string; pinnedKey: () => string;
    signEvmTransfer: SolverDeps['signEvmTransfer'];
    signSolTransfer: SolverDeps['signSolTransfer'];
    release?: SolverDeps['release'];
    // another EVM chain's reserve read from this frame (its stable and its native gas), for a click's cold top-up: the
    // snapshot that chain's frame wrote may be old or missing (2026-10-27: 'sol no-reserve' with $1,700 on Robinhood)
    reserveOn?: (chain: FloatChain, token: `0x${string}`, owner: `0x${string}`) => Promise<{ stable: bigint; native: bigint }>;
    // the Solana reserve read from an EVM frame (its USDC and its lamports; a failed read throws, an absent account is 0).
    // Given = this frame also signs that reserve's one SPL transfer for motion's solver (signSolTransfer works here);
    // left out (the Solana and NEAR frames, older hosts) = a Solana reserve is never a donor of this frame's clicks
    solReserveOn?: (owner: string) => Promise<{ stable: bigint; native: bigint }>;
  };
  // the trading wallet W on ANOTHER EVM chain, for a waiting click whose reserves cannot cover it (src/nativeDonor.ts,
  // 2026-10-30): `read` = W's native there, that chain's on-chain oracle price (the same pool its own frame reads) and the gas
  // price W would sign at, on that chain's own nodes, after a running trade; `send` = W signs ONE Relay depositNative on that
  // chain and broadcasts it there (webEngine refuses anything but Relay's pinned depository naming W); `receipt` = that
  // deposit's receipt (null = not yet). Left out (older hosts, tests) = a click asks the reserves only, as before.
  nativeDonor?: {
    read: (chain: FloatChain, owner: `0x${string}`) => Promise<{ native: bigint; price6: bigint; gasPrice: bigint }>;
    send: (walletId: string, chain: FloatChain, tx: EvmTx, gas: bigint) => Promise<`0x${string}`>;
    receipt?: (chain: FloatChain, hash: `0x${string}`) => Promise<'success' | 'reverted' | null>;
  };
  // stable sent straight to the trading wallet on ANOTHER EVM chain (2026-11-01, "deposit on one chain, trade on any"): a
  // deposit to W there was converted only by that chain's own frame, so on the phone (no frames of other chains) or with that
  // chain never opened it could fund nothing. `send` = W signs ONE transfer of THAT chain's float stable (FLOAT_CFG) to its
  // own R there, built by the host itself (no caller-supplied bytes), broadcast on that chain's nodes; its receipt through
  // nativeDonor.receipt, its reads through solver.reserveOn + nativeDonor.read. Left out = only this frame's chain forwards
  wForward?: { send: (walletId: string, chain: FloatChain, amount: bigint) => Promise<`0x${string}`> };
  // the reads a user's click is waiting on — the switch's dialogs and the app's pre-dialog status (`fresh`): no background
  // bucket, every wallet in one batched read where the chain allows it (Multicall3 on EVM, getMultipleAccounts on
  // Solana), the price and the gas once. They still wait out a running trade (I3, at the source) and read through the
  // float's own nodes (I2). A null entry = that address was not read. Left out = the background reads (older hosts).
  fast?: {
    evm?: {
      sheet: (pool: `0x${string}`, stable: `0x${string}`, wallets: { w: `0x${string}`; r: `0x${string}` }[]) => Promise<{ slot0: bigint | null; w: (bigint | null)[]; r: (bigint | null)[]; stable: (bigint | null)[] }>;
      fees: () => Promise<{ baseFee: bigint; gasPrice: bigint; l1PerByte: bigint }>;
    };
    sol?: {
      sheet: (wallets: { w: string; r: string }[]) => Promise<{ w: (bigint | null)[]; r: (bigint | null)[]; stable: (bigint | null)[] }>;
      oracle6: () => Promise<bigint>;
    };
  };
  ask: (o: { title: string; html: string; ok: string; danger?: boolean }) => Promise<boolean>;
  // the same vault dialog with several confirm buttons (webEngine askChoice: each a trusted click on the visible dialog);
  // resolves to the id of the button pressed, or null (closed). The switch-on uses it to keep the conversion a SEPARATE
  // choice (2026-11-01). Left out (older hosts, tests) = `ask`: a device that already holds dollars then converts nothing
  choose?: (o: { title: string; html: string; ok: string; choices: { id: string; label: string; primary?: boolean }[] }) => Promise<string | null>;
  gate: () => Promise<void>;                            // the 'transfer' 2FA gate
  html: { esc: (v: unknown) => string; sub: (h: string) => string; muted: (h: string) => string };
  now: () => number;
  store: { get: (k: string) => string | null; set: (k: string, v: string) => void; del: (k: string) => void; keys: (prefix: string) => string[] };
  lock: <T>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }) => Promise<T | null>;   // null: another tab holds it (waitMs: how long a waiting click may wait for it)
  emit: (detail: Record<string, unknown>) => void;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  click: () => ClickState;
  wait: (ms: number) => Promise<void>;
  // the frame runs fn on its click path: no 1 request/s bucket while a CONFIRMED conversion runs (a running trade still goes
  // first, at the source). Optional: without it, conversions keep the bucket.
  hurry?: <T>(fn: () => Promise<T>) => Promise<T>;
  // the account consent (src/floatConsent.ts, owner 2026-10-28): signs each switch record with one of the account's own
  // wallets (EIP-191, a key this vault holds) and tells the page the vault changed, so it publishes the account profile that
  // carries the record, sealed. Left out (older hosts, tests) = the consent stays on this device only, as before.
  // linked: this vault is tied to the account (its main is attached), so a record reaches the account's other devices
  consent?: { sign: (address: string, message: string) => Promise<string>; changed: () => void; linked?: () => boolean };
  // Earn (src/earnEngine.ts): left out (older hosts, tests) = no Earn at all, every path below exactly as before
  earn?: EarnApi;
  // (release 9) float.withdraw's consent, the vault's own Send consent (webEngine): an address this vault holds no key for = the
  // 'withdraw' 2FA gate and the "Send outside your vault" dialog (a trusted click; closed = throws Cancelled); one of the vault's
  // own wallets = the 'transfer' gate. Throws TwoFactorRequired when 2FA is on and no code came. Left out = no withdraw at all
  withdrawOk?: (o: { walletName: string; chainName: string; symbol: string; token: string; amount: string; to: string; twofa?: string }) => Promise<void>;
  // (usd-mode 2026-11-05) a routine cross-chain rebalance only into a chain the user bought on in the last 7 days (floatCore
  // crossNeedsTrade). Left out = on; false = the rule of before (the older engine tests' worlds, which never bought there)
  crossNeedsTrade?: boolean;
  // (usd-mode2 2026-11-05) true = W keeps a ready-native buffer even where the reserve pays the buys (the rule of before; the
  // older engine tests' worlds). Left out = no buffer on a chain whose permission allows the buy from the reserve (floatCore directPays)
  readyFloat?: boolean;
  // (usd-mode2) true = a routine plan may refill R's gas from W (the rule of before). Left out = with motion's bridge present R's gas
  // comes from motion's gas drop in the background, and from W only in front of a waiting click (floatCore gasFromWClickOnly)
  gasFromW?: boolean;
};

const SNAP = 'trenches.float.v1.snap.', PERM = 'trenches.float.v1.perm.', JOBS = 'trenches.float.v1.jobs.', HEALTH = 'trenches.float.v1.health', PREFS = 'trenches.float.v1.prefs.';
// a conversion the user confirmed in the vault's dialog, waiting for its chain's frame: 'on' = switch-on (W native → R
// stable, at most `max` native raw), 'off' = switch-off (R stable → W native, at most `max` stable raw). Written only by
// configure / off after the trusted click, in the vault origin's own storage (no page can write it).
const ORDER = 'trenches.float.v1.order.';
// a Solana forward of W's USDC (or R's funding of its fee) that was sent and is followed until it lands or cannot any more:
// { sig, at, failedAt? } per wallet. A second tick (any tab) never sends while one is followed (forwardSol)
const FWD = 'trenches.float.v1.fwd.';
// a forward of W's stable on ANOTHER EVM chain (forwardElsewhere), per chain and wallet: { at, hash? } — looked at once per
// FWDX_MS; a sent one is followed until its receipt (any tab), never sent twice while it may still land
const FWDX = 'trenches.float.v1.fwdx.';
const FWDX_MS = 300_000, FWDX_SETTLE_MS = 600_000;
// the last Solana gas drop a background tick asked for, per reserve: { at, ok } — asked again after a day once it was sent,
// after 10 minutes when it was refused or the answer was lost (the solver answers a repeat with the same signature)
const GASASK = 'trenches.float.v1.gasask.';
// the account's one switch (floatCore AccountGrant): written only by configure after the trusted click, dropped by off
const ACCOUNT = 'trenches.float.v1.account';
// a wallet that joined a live grant without a dialog: when (the app states it in a notice), per wallet address
// src 'account': adopted from the account's consent record (another device's switch), not confirmed in this vault's dialog
type StoredAccount = AccountGrant & { joined?: Record<string, number>; src?: 'account' };
// this device's consent high-water mark (floatConsent): the newest record it agreed to or adopted, the highest counter it
// has seen in any authentic record, the counter the server was seen holding (= on every device's way), and whether the
// record came from another device
const CONSENT = 'trenches.float.v1.consent';
// kept: the newest authentic grant this device could NOT adopt and why (floatConsent ConsentHost.kept), for the switch's dialog
// kept.terms (2026-11-02): the chains + caps of a newer grant whose authorship this device proved but could not follow (out of
// date / older rules) — the baseline a buy click's one-button confirm may re-grant, never more (configure `click`, review F4)
type KeptTerms = { chains: FloatChain[]; caps: CapsWire };
type ConsentState = { rec: ConsentRecord | null; seen: number; synced: number; adopted?: boolean; kept?: { n: number; why: ConsentWhy; rules: number; terms?: KeptTerms } };
// W's native the user chose to keep as native when the switch went on without converting (floatCore ChainState.keep): the raw
// amount per chain and wallet, never swept by the routine plan; it only shrinks (to what W still holds above what stays)
const KEEP = 'trenches.float.v1.keep.';
// (release 9) the coin float.convert delivered to W, per chain and wallet: [{ raw, at, job }] — the user's coin, not USD balance
// (floatCore convKept): the snapshot's float leaves it out, so no plan sweeps it back or counts it as ready dollars
const CONV = 'trenches.float.v1.conv.';
// (release 9) float.withdraw by idempotencyKey: { walletId, at, pending? | answer } — a repeat returns the first answer, never sends twice
const WD = 'trenches.float.v1.wd.';
// the other wallets of the account tick in the background at most this often (the app ticks its own wallet every 60 s)
export const OTHERS_MS = 55_000;
// how long a joined wallet's notice lasts
export const JOINED_NOTICE_MS = 86_400_000;
// a click-path read (readNow) reuses a snapshot younger than this
export const NOW_REUSE_MS = 3_000;
// …except while a click's own top-up is landing (sent or arrived in the last 20 s): every click-path read is a new read
export const CLICK_FOLLOW_MS = 20_000;
type Order = { kind: 'on' | 'off'; chain: FloatChain; max: string; at: number; grantedAt?: number; tries: number };
export type BackResult = { chain: FloatChain; state: 'sent' | 'unknown' | 'kept' | 'pending' | 'nothing'; usd: number; jobId?: string; why?: string };
type Snap = { at: number; chain: FloatChain; price6: string; priceAt: number; float: string; reserve: string; reserveNative: string; wStable?: string; inFlight6: string; inFlightReserve6: string; fee?: FeeInputs; active: boolean; presets6: string[]; buys6: string[];
  // (release 9) W's whole native and the converted coin in it (float.convert); `float` is then wNative − kept. Absent = nothing kept
  wNative?: string; kept?: string };
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };
const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'unwrapWETH9', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
] as const;
const APPROVE_ABI = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] as const;
// SwapRouter02 (and PancakeSwap's SmartRouter, its fork): recipient address(2) = "the router keeps it" for the unwrap that follows
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;

// the swap calls, built here and nowhere else (the recipient is always W or R of this wallet, set by the vault)
export function topupCalldata(c: EvmFloatCfg, amountIn: bigint, minOut: bigint, w: `0x${string}`, deadline: bigint): `0x${string}` {
  const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: c.stable.address, tokenOut: c.wrapped, fee: c.swapFee, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  const unwrap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [minOut, w] });
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [deadline, [swap, unwrap]] });
}
export function sweepCalldata(c: EvmFloatCfg, amountIn: bigint, minOut: bigint, r: `0x${string}`, deadline: bigint): `0x${string}` {
  const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: c.wrapped, tokenOut: c.stable.address, fee: c.swapFee, recipient: r, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [deadline, [swap]] });
}
const firstOut = (ret: `0x${string}`): bigint => {
  const outs = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', data: ret }) as readonly `0x${string}`[];
  return decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', data: outs[0] }) as bigint;
};

export class FloatRefused extends Error { name = 'FloatRefused'; }
// what a plan counts for a cross-chain move's bridge fee before any quote (the quote's stated fee replaces it on the job)
const BRIDGE_FEE_EST6 = 400_000n;
export class FloatUnknown extends Error { name = 'FloatUnknown'; unknown = true; }

export function createFloat(deps: FloatDeps) {
  const here = () => deps.chain();
  // a grant is live when whole, in date and on rules this build accepts (never: on the text it was shown, or the build)
  const RU = deps.rules ?? FLOAT_RULES;
  const accountLive = (a: AccountGrant | null | undefined, now: number): a is AccountGrant => liveAccount(a, now, RU.accepted);
  const permissionLive = (p: Permission | null | undefined, now: number): p is Permission => livePermission(p, now, RU.accepted);
  // motion's own solver, when this build has a quote key pinned and the frame can sign for it
  const solver = deps.solver && deps.solver.pinnedKey() ? createSolverBridge({
    base: deps.solver.base, fetch: deps.fetch, now: deps.now, pinnedKey: deps.solver.pinnedKey,
    signEvmTransfer: deps.solver.signEvmTransfer, signSolTransfer: deps.solver.signSolTransfer,
    ...(deps.solver.release ? { release: deps.solver.release } : {}),
  }) : null;
  let solverHealth: { at: number; on: boolean; deposits: Partial<Record<BridgeChain, string>>; max6: bigint } | null = null;
  // what this frame's reads saw of each wallet's W native per chain, the last 30 s (saveSnap): proof for the settle wait
  const wReads = new Map<string, { at: number; float: bigint }[]>();
  const readsOf = (w: FloatWallet, c: FloatChain) => wReads.get(w.id + '|' + c) || [];
  const perms = (w: FloatWallet): Permission | null => { try { const p = JSON.parse(deps.store.get(PERM + w.w.evm.toLowerCase()) || 'null'); if (!p) return null; p.caps = { perDay6: big(p.caps.perDay6), feesPerDay6: big(p.caps.feesPerDay6), perChain6: big(p.caps.perChain6), total6: big(p.caps.total6), maxSlipBps: Number(p.caps.maxSlipBps) }; return p; } catch { return null; } };
  const savePerm = (w: FloatWallet, p: Permission | null) => { if (!p) deps.store.del(PERM + w.w.evm.toLowerCase()); else deps.store.set(PERM + w.w.evm.toLowerCase(), JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? String(v) : v))); };
  const jobsKey = (w: FloatWallet, c: FloatChain) => `${JOBS}${c}.${w.w.evm.toLowerCase()}`;
  const loadJobs = (w: FloatWallet, c: FloatChain): FloatJob[] => { try { const j = JSON.parse(deps.store.get(jobsKey(w, c)) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
  const saveJobs = (w: FloatWallet, c: FloatChain, jobs: FloatJob[]) => { const now = deps.now(); deps.store.set(jobsKey(w, c), JSON.stringify(jobs.filter((j) => isOpen(j) || now - j.updatedAt < 14 * 86_400_000).slice(-200))); };
  const allJobs = (w: FloatWallet) => FLOAT_CHAIN_KEYS.flatMap((c) => loadJobs(w, c));
  const snapKey = (w: FloatWallet, c: FloatChain) => `${SNAP}${c}.${w.w.evm.toLowerCase()}`;
  const readSnap = (w: FloatWallet, c: FloatChain): Snap | null => { try { const s = JSON.parse(deps.store.get(snapKey(w, c)) || 'null'); return s && deps.now() - s.at < 600_000 ? s : null; } catch { return null; } };
  // for display only: the last known snapshot of a chain at any age (its price state says how old) — the account's total never
  // drops a chain just because that chain's frame has not read it in the last 10 minutes
  const readSnapShown = (w: FloatWallet, c: FloatChain): Snap | null => { try { const s = JSON.parse(deps.store.get(snapKey(w, c)) || 'null'); return s && typeof s.at === 'number' ? s : null; } catch { return null; } };
  const prefsOf = (w: FloatWallet, c: FloatChain): { presets6: bigint[]; buys6: bigint[]; buysAt: number[]; activeAt: number } => {
    try { const p = JSON.parse(deps.store.get(`${PREFS}${c}.${w.w.evm.toLowerCase()}`) || '{}'); return { presets6: (p.presets6 || []).map(big), buys6: (p.buys6 || []).map(big), buysAt: Array.isArray(p.buysAt) ? p.buysAt.map(Number) : [], activeAt: Number(p.activeAt) || 0 }; } catch { return { presets6: [], buys6: [], buysAt: [], activeAt: 0 }; }
  };
  // the user buys on chain c in a burst (REFILL): the buys of the last minute (an entry without a time is long ago)
  // …or this frame's own trade clicks (deps.click().clicks, this chain's lane): seen at the click, before any buy is reported
  const burstAt = (w: FloatWallet, c: FloatChain): boolean => {
    const p = prefsOf(w, c); const n = p.buys6.length;
    if (burstOf(p.buys6.map((usd6, i) => ({ usd6, at: p.buysAt[i - (n - p.buysAt.length)] ?? 0 })), deps.now())) return true;
    return c === here() && burstOf((deps.click().clicks || []).map((at) => ({ usd6: 0n, at })), deps.now());
  };
  // one buy (or fill) of this wallet on chain c, in dollars: the size the ready float follows, and when (the burst)
  const recordBuy = (w: FloatWallet, c: FloatChain, usd6v: bigint) => {
    const k = `${PREFS}${c}.${w.w.evm.toLowerCase()}`; let p: { presets6?: string[]; buys6?: string[]; buysAt?: number[]; activeAt?: number } = {}; try { p = JSON.parse(deps.store.get(k) || '{}'); } catch {}
    const n = (p.buys6 || []).length; const at = Array.isArray(p.buysAt) ? p.buysAt.slice(-n) : [];
    while (at.length < n) at.unshift(0);
    p.buys6 = [...(p.buys6 || []), String(usd6v)].slice(-20); p.buysAt = [...at, deps.now()].slice(-20); p.activeAt = deps.now();
    deps.store.set(k, JSON.stringify(p));
  };
  const health = (): BridgeOutcome[] => { try { const h = JSON.parse(deps.store.get(HEALTH) || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } };
  const noteOutcome = (o: BridgeOutcome) => deps.store.set(HEALTH, JSON.stringify([...health(), o].slice(-200)));
  const emit = (w: FloatWallet, jobId: string | null, step: string, state: string, extra: Record<string, unknown> = {}) => deps.emit({ walletId: w.id, ...(jobId ? { jobId } : {}), step, state, ...extra });
  const orderKey = (w: FloatWallet, kind: 'on' | 'off', c: FloatChain) => `${ORDER}${kind}.${c}.${w.w.evm.toLowerCase()}`;
  const readOrder = (w: FloatWallet, kind: 'on' | 'off', c: FloatChain): Order | null => {
    try { const o = JSON.parse(deps.store.get(orderKey(w, kind, c)) || 'null'); if (!o || o.kind !== kind || o.chain !== c) return null; if (deps.now() - Number(o.at) > CONVERT_ORDER_MS) { deps.store.del(orderKey(w, kind, c)); return null; } return o; } catch { return null; }
  };
  const saveOrder = (w: FloatWallet, o: Order) => deps.store.set(orderKey(w, o.kind, o.chain), JSON.stringify(o));
  const delOrder = (w: FloatWallet, kind: 'on' | 'off', c: FloatChain) => deps.store.del(orderKey(w, kind, c));
  // ── the native kept at switch-on (KEEP, 2026-11-01): written only by configure after the trusted click ──
  const keepKey = (w: FloatWallet, c: FloatChain) => `${KEEP}${c}.${w.w.evm.toLowerCase()}`;
  const saveKeep = (w: FloatWallet, c: FloatChain, raw: bigint) => { if (raw > 0n) deps.store.set(keepKey(w, c), JSON.stringify({ raw: String(raw), at: deps.now() })); else deps.store.del(keepKey(w, c)); };
  const delKeeps = (w: FloatWallet) => { for (const k of FLOAT_CHAIN_KEYS) deps.store.del(keepKey(w, k)); };
  /** What is still kept on this chain: never more than W holds above what stays (a spend shrinks it, for good). */
  function keptNative(w: FloatWallet, c: FloatChain, sn: Snap, caps: Caps): bigint {
    let raw = 0n; try { raw = big(JSON.parse(deps.store.get(keepKey(w, c)) || 'null')?.raw); } catch { return 0n; }
    if (raw <= 0n) return 0n;
    const x = stateOf(sn, c, true, false); const stay = keepOf(c, x, caps);
    const above = x.float > stay ? x.float - stay : 0n;
    if (above < raw) { saveKeep(w, c, above); return above; }
    return raw;
  }
  // ── the converted coin (CONV, release 9): written only by float.convert after its swap was sent ──
  const convKey = (w: FloatWallet, c: FloatChain) => `${CONV}${c}.${w.w.evm.toLowerCase()}`;
  const convRead = (w: FloatWallet, c: FloatChain): ConvItem[] => { try { const x = JSON.parse(deps.store.get(convKey(w, c)) || '[]'); return Array.isArray(x) ? x.map((i) => ({ raw: big(i?.raw), at: Number(i?.at) || 0, ...(typeof i?.job === 'string' ? { job: i.job as string } : {}) })).filter((i) => i.raw > 0n) : []; } catch { return []; } };
  const convSave = (w: FloatWallet, c: FloatChain, items: ConvItem[]) => { if (items.length) deps.store.set(convKey(w, c), JSON.stringify(items.map((i) => ({ raw: String(i.raw), at: i.at, ...(i.job ? { job: i.job } : {}) })))); else deps.store.del(convKey(w, c)); };
  const delConvs = (w: FloatWallet) => { for (const k of FLOAT_CHAIN_KEYS) deps.store.del(convKey(w, k)); };
  /** What of W's native `wNative` on chain c is the converted coin now (convKept: a failed swap counts nothing, a spend shrinks it). */
  function convOf(w: FloatWallet, c: FloatChain, wNative: bigint): bigint {
    const items = convRead(w, c); if (!items.length) return 0n;
    const jobs = loadJobs(w, c);
    const r = convKept(items.map((i) => ({ ...i, state: i.job ? (jobs.find((j) => j.id === i.job)?.state ?? null) : null })), wNative, cfgOf(c).gasFloor, deps.now());
    if (r.changed) convSave(w, c, r.items);
    return r.kept;
  }
  const CLICK_WANT = 'trenches.float.v1.clickwant.';
  const lockKey = (w: FloatWallet, c: FloatChain) => `trench-float-${w.w.evm.toLowerCase()}-${c}`;
  // ── the account (one switch for every wallet) ──
  const lc = (a: string) => a.toLowerCase();
  const account = (): StoredAccount | null => {
    try {
      const a = JSON.parse(deps.store.get(ACCOUNT) || 'null'); if (!a) return null;
      a.caps = { perDay6: big(a.caps.perDay6), feesPerDay6: big(a.caps.feesPerDay6), perChain6: big(a.caps.perChain6), total6: big(a.caps.total6), maxSlipBps: Number(a.caps.maxSlipBps) };
      return a;
    } catch { return null; }
  };
  const saveAccount = (a: StoredAccount | null) => { if (!a) deps.store.del(ACCOUNT); else deps.store.set(ACCOUNT, JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? String(v) : v))); };
  const accountOn = (): StoredAccount | null => { const a = account(); return accountLive(a, deps.now()) ? a : null; };
  // the account's wallets; without the dep (an older host) only the caller's own wallet
  const listWallets = (callerId?: string): FloatWalletList => {
    if (deps.wallets) return deps.wallets();
    return { list: callerId ? [deps.wallet(callerId)] : [], skipped: [] };
  };
  /**
   * A wallet without a live permission while the account's grant is live joins it: its own Permission record with the
   * grant's chains, caps and dates (the grant's text named this rule), and nothing else. No conversion order is written —
   * its native is converted by the routine sweep (quiet rule, fee cap, oracle check), and the app states it afterwards.
   */
  function join(w: FloatWallet): Permission | null {
    const a = accountOn(); if (!a) return null;
    const base = { v: 1 as const, wallet: w.w.evm, reserve: w.r.evm, chains: a.chains, caps: a.caps, grantedAt: a.grantedAt, expiresAt: a.expiresAt, ...rulesField(rulesOf(a)) };
    const p: Permission = { ...base, digest: permissionDigest(base) };
    savePerm(w, p);
    saveAccount({ ...a, joined: { ...(a.joined || {}), [lc(w.w.evm)]: deps.now() } });
    emit(w, null, 'join', 'done', { chains: a.chains });
    return p;
  }

  // ── the consent that follows the account (src/floatConsent.ts) ──
  // Every switch change on this device (configure / off) writes one signed record; the page publishes it inside the account
  // profile (webEngine mainProfile seals it under the account's seed). A record found in the profile is applied through
  // `consent.apply` only after floatConsent opened it, checked its signature and found it newer than this device's own.
  const consentState = (): ConsentState => {
    try { const x = JSON.parse(deps.store.get(CONSENT) || 'null'); if (x && typeof x === 'object') return { rec: x.rec && x.rec.body && typeof x.rec.sig === 'string' ? x.rec : null, seen: Number(x.seen) || 0, synced: Number(x.synced) || 0, ...(x.adopted ? { adopted: true } : {}), ...(x.kept && Number.isSafeInteger(x.kept.n) && typeof x.kept.why === 'string' ? { kept: { n: x.kept.n, why: x.kept.why, rules: Number(x.kept.rules) || 1, ...(x.kept.terms && Array.isArray(x.kept.terms.chains) && x.kept.terms.caps ? { terms: x.kept.terms } : {}) } } : {}) }; } catch {}
    return { rec: null, seen: 0, synced: 0 };
  };
  const saveConsent = (x: ConsentState) => deps.store.set(CONSENT, JSON.stringify(x));
  const capsWire = (c: Caps): CapsWire => ({ perDay6: String(c.perDay6), feesPerDay6: String(c.feesPerDay6), perChain6: String(c.perChain6), total6: String(c.total6), maxSlipBps: c.maxSlipBps });
  const capsOfWire = (c: CapsWire): Caps => ({ perDay6: big(c.perDay6), feesPerDay6: big(c.feesPerDay6), perChain6: big(c.perChain6), total6: big(c.total6), maxSlipBps: Number(c.maxSlipBps) });
  type GrantTerms = Pick<AccountGrant, 'chains' | 'caps' | 'grantedAt' | 'expiresAt' | 'wallets' | 'rules'>;
  const grantBody = (a: GrantTerms): Omit<ConsentBody, 'n' | 'at'> => ({ v: 1, on: true, chains: [...a.chains].sort(), caps: capsWire(a.caps), grantedAt: a.grantedAt, expiresAt: a.expiresAt, ...rulesField(rulesOf(a)), wallets: [...new Set(a.wallets.map(lc))].sort() });
  // the record states this grant (its wallets aside: an adopting device covers the ones it holds)
  const recordCovers = (r: ConsentBody | undefined, a: AccountGrant): boolean => !!r && r.on && sameTerms({ ...r, wallets: [] }, { ...(grantBody(a) as ConsentBody), n: r.n, at: r.at, wallets: [] });
  /** A new record above every counter this device has seen; nothing when the terms did not change. True = written. */
  async function writeConsent(body: Omit<ConsentBody, 'n' | 'at'>, signer: string): Promise<boolean> {
    if (!deps.consent || !signer) return false;
    const st = consentState();
    const n = Math.max(st.seen, st.rec?.body.n || 0) + 1;
    const full = { ...body, n, at: deps.now() } as ConsentBody;
    if (st.rec && sameTerms(st.rec.body, full)) return false;
    let sig = '';
    try { sig = String(await deps.consent.sign(signer, consentMessage(full))); } catch { return false; }
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
    // (2026-11-02) a grant is also signed by up to CO_MAX of the other wallets it names, in this vault's order (the oldest, most
    // often on every device, first): another device that holds any of them can vouch for the record (floatConsent co)
    const co: { signer: string; sig: string }[] = [];
    if (full.on) {
      let list: FloatWallet[] = []; try { list = listWallets().list; } catch { list = []; }
      const named = new Set((full.wallets || []).map(lc));
      for (const w of list) {
        if (co.length >= CO_MAX) break;
        const a = lc(w.w.evm); if (a === lc(signer) || !named.has(a) || co.some((x) => x.signer === a)) continue;
        try { const g = String(await deps.consent.sign(a, consentMessage(full))); if (/^0x[0-9a-fA-F]{130}$/.test(g)) co.push({ signer: a, sig: g }); } catch { /* that one does not co-sign */ }
      }
    }
    saveConsent({ rec: { body: full, signer: lc(signer), sig, ...(co.length ? { co } : {}) }, seen: n, synced: st.synced });
    return true;
  }
  /** Where a grant is on: 'all' = the account's record states it and the server holds it (or it came from there), 'this' =
   *  this device only (no account, an older server, not published yet), null = off. */
  const devicesOf = (a: StoredAccount | null): 'all' | 'this' | null => {
    if (!a || !accountLive(a, deps.now())) return null;
    const st = consentState();
    return st.rec && recordCovers(st.rec.body, a) && (st.adopted || st.synced >= st.rec.body.n) ? 'all' : 'this';
  };
  const consent: ConsentHost = {
    accepted: RU.accepted,
    local: () => consentState().rec,
    seen: (n) => { const x = consentState(); if (n > x.seen) saveConsent({ ...x, seen: n }); },
    seenMax: () => consentState().seen,
    // a newer authentic grant this device did not adopt: remembered (the newest one) so the switch's dialog can say why
    kept: (k) => { const x = consentState(); if (!x.kept || k.n >= x.kept.n) saveConsent({ ...x, kept: k }); },
    synced: (n) => { const x = consentState(); if (x.rec && x.rec.body.n === n && n > x.synced) saveConsent({ ...x, synced: n }); },
    // another device's switch, already opened, verified and judged newer (floatConsent.consentReceive): this device follows it
    apply: (v) => {
      const b = v.rec.body; const x = consentState();
      let list: FloatWallet[] = []; try { list = listWallets().list; } catch { list = []; }
      const next: ConsentState = { rec: v.rec, seen: Math.max(x.seen, b.n), synced: b.n, adopted: true };
      if (v.action === 'revoke') {
        // off here too: the switch and every wallet's permission go, no switch-on conversion is left; nothing converts back
        // HERE — the device that turned it off converts the reserves (they are the same on-chain addresses everywhere)
        saveAccount(null);
        for (const w of list) { savePerm(w, null); delKeeps(w); for (const k of FLOAT_CHAIN_KEYS) delOrder(w, 'on', k); }
        deps.earn?.stop();
        saveConsent(next);
        deps.emit({ step: 'consent', state: 'off', scope: 'account', n: b.n });
        return;
      }
      // on here: the grant's terms, for the wallets of the record this vault holds (a wallet it holds that the record does not
      // name joins by the grant's own rule, join()); no conversion (the device that switched on converts), no dialog
      const ws = new Set((b.wallets || []).map(lc));
      const mine = list.filter((w) => ws.has(lc(w.w.evm)));
      // (2026-11-02, review H2 / M2) never stored: terms configure could not have written, or a grant for none of this vault's
      // wallets (it would turn every wallet here on through join())
      if (!mine.length || !termsOk({ caps: b.caps, grantedAt: b.grantedAt, expiresAt: b.expiresAt }, deps.now())) return;
      const caps = capsOfWire(b.caps!); const rules = rulesField(rulesOf(b));
      const ab = { v: 1 as const, chains: FLOAT_CHAIN_KEYS.filter((k) => b.chains!.includes(k)), caps, grantedAt: b.grantedAt!, expiresAt: b.expiresAt!, wallets: mine.map((w) => lc(w.w.evm)), ...rules };
      saveAccount({ ...ab, digest: accountDigest(ab), joined: {}, src: 'account' });
      for (const w of mine) {
        const pb = { v: 1 as const, wallet: w.w.evm, reserve: w.r.evm, chains: ab.chains, caps, grantedAt: ab.grantedAt, expiresAt: ab.expiresAt, ...rules };
        savePerm(w, { ...pb, digest: permissionDigest(pb) });
        for (const k of FLOAT_CHAIN_KEYS) delOrder(w, 'off', k);
      }
      saveConsent(next);
      deps.emit({ step: 'consent', state: 'on', scope: 'account', n: b.n, wallets: mine.length });
    },
    // a grant switched on before this build (no record yet) gets its first record when the profile is next published
    fromLive: async () => {
      const a = accountOn(); if (!a || !deps.consent) return null;
      let list: FloatWallet[] = []; try { list = listWallets().list; } catch { return null; }
      const signer = list.map((w) => lc(w.w.evm)).find((x) => a.wallets.map(lc).includes(x)) || '';
      if (!signer) return null;
      await writeConsent(grantBody(a), signer);
      const r = consentState().rec;
      return r && recordCovers(r.body, a) ? r : null;
    },
  };

  // ── reads (the float's own client; nothing here in a click window) ──
  // The price and gas of a chain are the same for every wallet: a background read of the account (status, the dialogs'
  // amounts) reuses them for 5 s, so N wallets cost 2 + 3N requests instead of 5N. A tick that is about to move money
  // never reuses them: it reads its own price right before it plans (`share` false).
  let shared: { c: FloatChain; at: number; price6: bigint; evmFees?: { baseFee: bigint; gasPrice: bigint; l1PerByte: bigint }; solFees?: { microMedium: number; microHigh: number; microVeryHigh: number; tipP75: number; tipP95: number } | null } | null = null;
  type EvmFees = { baseFee: bigint; gasPrice: bigint; l1PerByte: bigint };
  type SolFees = { microMedium: number; microHigh: number; microVeryHigh: number; tipP75: number; tipP95: number };
  const SOL_FEES_DEFAULT: SolFees = { microMedium: 1000, microHigh: 50_000, microVeryHigh: 200_000, tipP75: 0.00005, tipP95: 0.0015 };
  // one wallet's snapshot of chain c from what was just read (the background read and the click-path read write the same
  // record): its moves in flight are counted from the jobs as they stand now
  function saveSnap(w: FloatWallet, c: FloatChain, now: number, r: { price6: bigint; priceAt: number; float: bigint; reserve: bigint; reserveNative: bigint; wStable?: bigint; evmFees?: EvmFees; solFees?: SolFees | null }): Snap {
    const pre = prefsOf(w, c);
    const active = now - pre.activeAt < RULES.activeMs;
    const jobs = loadJobs(w, c).filter(isOpen);
    const inFlight6 = jobs.filter((j) => (j.kind === 'topup' || j.kind === 'cold') && j.chain === c).reduce((s, j) => s + big(j.usd6), 0n);
    // a rebalance INTO this chain is recorded by its donor's frame: count those too
    const inbound = FLOAT_CHAIN_KEYS.filter((d) => d !== c).flatMap((d) => loadJobs(w, d)).filter((j) => isOpen(j) && j.chain === c && (j.kind === 'rebalance' || j.kind === 'cold'));
    const inFlightReserve6 = inbound.filter((j) => j.kind === 'rebalance').reduce((s, j) => s + big(j.usd6), 0n);
    const coldIn6 = inbound.filter((j) => j.kind === 'cold').reduce((s, j) => s + big(j.usd6), 0n);
    const at = r.priceAt;
    const fee: FeeInputs = cfgOf(c).kind === 'evm'
      ? { at, nativeUsd: Number(r.price6) / 1e6, evm: { baseFee: String(r.evmFees!.baseFee), gasPrice: String(r.evmFees!.gasPrice), l1PerByte: String(r.evmFees!.l1PerByte) } }
      : { at, nativeUsd: Number(r.price6) / 1e6, sol: r.solFees || SOL_FEES_DEFAULT };
    // (release 9) the converted coin (float.convert) is the user's, not USD balance: the float is W's native without it
    const conv = convOf(w, c, r.float); const fl = r.float - conv;
    const s: Snap = { at: now, chain: c, price6: String(r.price6), priceAt: at, float: String(fl), ...(conv > 0n ? { wNative: String(r.float), kept: String(conv) } : {}), reserve: String(r.reserve), reserveNative: String(r.reserveNative), ...(r.wStable != null ? { wStable: String(r.wStable) } : {}), inFlight6: String(inFlight6 + coldIn6), inFlightReserve6: String(inFlightReserve6),
      fee, active, presets6: pre.presets6.map(String), buys6: pre.buys6.map(String) };
    deps.store.set(snapKey(w, c), JSON.stringify(s));
    // W's native as this frame read it (wReads, the last 30 s): the settle wait's proof that a payout shows here (payoutSeen)
    const rk = w.id + '|' + c; wReads.set(rk, [...(wReads.get(rk) || []).filter((x) => now - x.at < 30_000), { at: now, float: fl }].slice(-40));
    return s;
  }
  async function readChain(w: FloatWallet, c: FloatChain, share = false): Promise<Snap> {
    const now = deps.now();
    const sh = share && shared && shared.c === c && now - shared.at < 5_000 ? shared : null;
    const cfg = cfgOf(c);
    if (cfg.kind === 'evm') {
      const e = deps.evm!; const ec = cfg as EvmFloatCfg;
      // + W's own stable: USDG / USDC sent straight to the trading wallet joins the USD balance (forwardStable)
      const [price6, float, reserve, reserveNative, fees, wStable] = await Promise.all([sh ? sh.price6 : e.slot0(ec.oracle.pool).then((sq) => oraclePrice6(sq, ec.oracle)), e.balance(w.w.evm), e.erc20(ec.stable.address, w.r.evm), e.balance(w.r.evm), sh?.evmFees ? sh.evmFees : e.fees(), e.erc20(ec.stable.address, w.w.evm).catch(() => null)]);
      if (!sh) shared = { c, at: now, price6, evmFees: fees };
      return saveSnap(w, c, now, { price6, priceAt: sh ? sh.at : now, float, reserve, reserveNative, ...(wStable != null ? { wStable } : {}), evmFees: fees });
    }
    const sl = deps.sol!;
    // + W's own USDC when this host can forward it (forwardSol)
    const [price6, float, reserve, reserveNative, fees, wStable] = await Promise.all([sh ? sh.price6 : sl.oracle6(), sl.balance(w.w.sol), sl.usdc(w.r.sol), sl.balance(w.r.sol), sh ? sh.solFees ?? null : sl.fees().catch(() => null), sl.forward ? sl.usdc(w.w.sol).catch(() => null) : Promise.resolve(null)]);
    if (!sh) shared = { c, at: now, price6, solFees: fees };
    return saveSnap(w, c, now, { price6, priceAt: sh ? sh.at : now, float, reserve, reserveNative, ...(wStable != null ? { wStable } : {}), solFees: fees });
  }
  // the same snapshot written again from its own reads (float.convert: the kept coin changed, nothing was read)
  const resnap = (w: FloatWallet, c: FloatChain, s: Snap): Snap => { const f = s.fee; return saveSnap(w, c, s.at, { price6: big(s.price6), priceAt: s.priceAt, float: big(s.wNative ?? s.float), reserve: big(s.reserve), reserveNative: big(s.reserveNative), ...(s.wStable != null ? { wStable: big(s.wStable) } : {}),
    ...(f?.evm ? { evmFees: { baseFee: big(f.evm.baseFee), gasPrice: big(f.evm.gasPrice), l1PerByte: big(f.evm.l1PerByte) } } : { solFees: f?.sol ?? null }) }); };
  /**
   * The click path's read of this frame's chain for several wallets at once (the switch's dialogs, the app's pre-dialog
   * status `fresh`): the price and the gas once, every wallet's W native, R stable and R native in one batched read
   * (deps.fast: Multicall3 / getMultipleAccounts, no background bucket, still behind a running trade), written as the
   * same snapshots. A wallet whose read failed keeps its old snapshot (never a zero). Without deps.fast (an older host),
   * the background reads: the first wallet alone (it fills the shared price and gas), the others side by side.
   * One read at a time per frame: a second caller waits for the read under way, then reads only the wallets whose
   * snapshot is still older than `maxAge` (or older than their last move on this chain) — a page that asks again and
   * again costs at most one batched read per 3 s.
   */
  let nowRun: Promise<void> | null = null;
  async function readNow(list: FloatWallet[], c: FloatChain, maxAge = NOW_REUSE_MS): Promise<void> {
    while (nowRun) await nowRun.catch(() => {});
    // a click's own top-up on this chain sent in the last CLICK_FOLLOW_MS: the app's hold & fire asks every ~0.5 s and fires
    // on the first read that shows it landed, so no snapshot is reused then (2026-10-28: the 3 s reuse held a landed top-up
    // back by up to 3 s); one read at a time per frame still (nowRun), so a page that asks in a loop gets one batched read per answer
    const following = (w: FloatWallet) => loadJobs(w, c).some((j) => j.click && j.chain === c && deps.now() - j.updatedAt < CLICK_FOLLOW_MS && (isOpen(j) || j.state === 'arrived'));
    const need = list.filter((w) => { const s = readSnap(w, c); return !s || deps.now() - s.at > maxAge || following(w) || loadJobs(w, c).some((j) => j.at >= s.at || j.updatedAt >= s.at); });
    if (!need.length) return;
    const p = readNowRun(need, c); nowRun = p;
    try { await p; } finally { if (nowRun === p) nowRun = null; }
  }
  async function readNowRun(list: FloatWallet[], c: FloatChain): Promise<void> {
    if (!list.length) return;
    const cfg = cfgOf(c); const f = deps.fast;
    if (cfg.kind === 'evm' && f?.evm) {
      const ec = cfg as EvmFloatCfg; const now = deps.now();
      const [sh, fees] = await Promise.all([f.evm.sheet(ec.oracle.pool, ec.stable.address, list.map((w) => ({ w: w.w.evm, r: w.r.evm }))), f.evm.fees()]);
      if (sh.slot0 == null || !(sh.slot0 > 0n)) throw new Error('the price was not read');
      const price6 = oraclePrice6(sh.slot0, ec.oracle);
      shared = { c, at: now, price6, evmFees: fees };
      list.forEach((w, i) => { const float = sh.w[i], reserve = sh.stable[i], reserveNative = sh.r[i]; if (float != null && reserve != null && reserveNative != null) saveSnap(w, c, now, { price6, priceAt: now, float, reserve, reserveNative, evmFees: fees }); });
      return;
    }
    if (cfg.kind === 'sol' && f?.sol) {
      const now = deps.now();
      const [price6, sh] = await Promise.all([f.sol.oracle6(), f.sol.sheet(list.map((w) => ({ w: w.w.sol, r: w.r.sol })))]);
      if (!(price6 > 0n)) throw new Error('the price was not read');
      shared = { c, at: now, price6, solFees: null };
      list.forEach((w, i) => { const float = sh.w[i], reserve = sh.stable[i], reserveNative = sh.r[i]; if (float != null && reserve != null && reserveNative != null) saveSnap(w, c, now, { price6, priceAt: now, float, reserve, reserveNative, solFees: null }); });
      return;
    }
    const [first, ...rest] = list;
    await readChain(first, c, true).catch(() => null);
    await Promise.all(rest.map((w) => readChain(w, c, true).catch(() => null)));
  }
  const stateOf = (s: Snap, c: FloatChain, idle: boolean, busyBridge: boolean): ChainState => ({
    price6: big(s.price6), priceAt: s.priceAt, float: big(s.float), reserve: big(s.reserve), reserveNative: big(s.reserveNative), active: s.active,
    presets6: s.presets6.map(big), buys6: s.buys6.map(big), inFlight6: big(s.inFlight6), inFlightReserve6: big(s.inFlightReserve6), idle, busyBridge,
  });
  // W may send (a sweep, R's gas): the quiet rule (floatCore.quietFor), which replaced the 60 s idle rule on 2026-10-26
  const quietOn = (c: FloatChain) => { const k = deps.click(); return quietFor(k, deps.now()) && k.focusChain !== c; };   // + never the chain whose token page is open (the old idle rule kept that)
  const clickBusy = () => inClickWindow(deps.click(), deps.now());

  // the whole wallet as the snapshots of every frame say
  function view(w: FloatWallet) {
    const snaps = Object.fromEntries(FLOAT_CHAIN_KEYS.map((c) => [c, readSnapShown(w, c)])) as Record<FloatChain, Snap | null>;
    const jobs = allJobs(w); const led = ledgerOf(jobs, deps.now());
    // what the ready-dollar moves (READY) cost and moved this week: stated apart (they are inside upkeepWeek too)
    const rf = readyFeesOf(jobs, deps.now());
    let cash6 = 0n, ready6 = 0n, transit6 = 0n, earnSum6 = 0n, earned6 = 0n, earnedKnown = true;
    const chains: Record<string, unknown> = {};
    const p = perms(w);
    for (const c of FLOAT_CHAIN_KEYS) {
      const s = snaps[c]; if (!s) continue; const cfg = cfgOf(c);
      const price6 = big(s.price6); const st = priceState(s.priceAt, deps.now());
      const liq6 = stableToUsd6(big(s.reserve), cfg.stable.decimals);
      // Earn (src/earnEngine.ts): R's dollars in the vault are R's dollars — liquid + the venue's value — so the total and the
      // breakdown count them (stable.usd, as before); but only R's LIQUID part (liquidUsd) pays a click anywhere (review M5), and a
      // click on THIS chain may take out first what the vault can pay now (earnReadyUsd: never after a hard stop, never beside an
      // open Earn step) — the app's funding checks use those two, never stable.usd
      const er = deps.earn ? deps.earn.status(w, c) : null;
      const earn6 = er && er.usd > 0 ? usd6(er.usd) : 0n;
      const earnReady6 = er && earn6 > 0n && er.cls !== 'hard' && !er.landing && !er.verifying && !er.foreign ? (usd6(er.redeemable) < earn6 ? usd6(er.redeemable) : earn6) : 0n;
      const res6 = liq6 + earn6; earnSum6 += earn6; if (er && er.earned != null) earned6 += usd6(Math.abs(er.earned)) * (er.earned < 0 ? -1n : 1n); else if (er && earn6 > 0n) earnedKnown = false;
      const float6 = nativeToUsd6(big(s.float), price6, cfg.nativeDecimals);
      const tgt = targetOf(c, readySize6(s.presets6.map(big), s.buys6.map(big)), s.active, p?.caps.perChain6 ?? 250n * USD, readyMultTenths(burstAt(w, c)));
      cash6 += res6; ready6 += float6; transit6 += big(s.inFlightReserve6);
      chains[c] = {
        stable: { symbol: cfg.stable.symbol, raw: s.reserve, usd: Number(res6) / 1e6, ...(earn6 > 0n ? { liquidUsd: Number(liq6) / 1e6, earnUsd: Number(earn6) / 1e6, earnReadyUsd: Number(earnReady6) / 1e6 } : {}) }, ...(er && (earn6 > 0n || er.paused || er.residue || er.foreign) ? { earn: er } : {}), native: { symbol: cfg.native, raw: s.float, usd: Number(float6) / 1e6, ...(s.kept && big(s.kept) > 0n ? { kept: { raw: s.kept, usd: Number(nativeToUsd6(big(s.kept), price6, cfg.nativeDecimals)) / 1e6 } } : {}) },
        // (2026-11-02, a tester sent USDG to his trading wallet and could not find it) the stablecoin sitting in W itself, not yet
        // forwarded into R: shown by the app as "moving to USD balance"; it is NOT in usd.cash / usd.total
        ...(s.wStable != null ? { wallet: { symbol: cfg.stable.symbol, raw: s.wStable, usd: Number(stableToUsd6(big(s.wStable), cfg.stable.decimals)) / 1e6 } } : {}),
        // (release 9) what float.withdraw can pay out of R on this chain right now (its liquid stable): the form's Max
        withdrawUsd: Number(liq6) / 1e6,
        price: Number(price6) / 1e6, priceState: st, target: Number(tgt.trading6) / 1e6, low: Number(tgt.low6) / 1e6, high: Number(tgt.high6) / 1e6,
        ready: Number(tradingUsd6(c, big(s.float), price6)) / 1e6, inFlight: Number(big(s.inFlight6)) / 1e6, reserveGas: s.reserveNative, at: s.at, fee: s.fee || null,
      };
    }
    return { snaps, jobs, ledger: led, usd: { cash: Number(cash6) / 1e6, ready: Number(ready6) / 1e6, transit: Number(transit6) / 1e6, total: Number(cash6 + ready6 + transit6) / 1e6, upkeepWeek: Number(led.upkeepWeek6) / 1e6, readyFeesWeek: Number(rf.week6) / 1e6, readyMovedWeek: Number(rf.movedWeek6) / 1e6, ...(earnSum6 > 0n ? { earn: Number(earnSum6) / 1e6, earned: earnedKnown ? Number(earned6) / 1e6 : null } : {}) }, chains };
  }

  // ── execution, one move at a time per wallet and chain (the runner lock) ──
  // a move a waiting click asked for (job.click) defers only while a trade is really between its call and its broadcast: the
  // token page's focus window and the 2 s tail are for background moves (2026-10-27: prewarm stamps focus on the ⚡ hover,
  // so every click top-up was deferred for 10 s, the hold ran out and the buy went with an empty wallet)
  async function stepCheck(job?: FloatJob) { const t = deps.click(); if (job?.click || job?.refill ? t.clickAt > t.clickDoneAt : clickBusy()) throw new FloatRefused('deferred: a trade is running'); }
  // a trade is between its call and its broadcast (the after-trade refill waits for exactly this, not for the page's windows)
  const tradeLive = () => { const t = deps.click(); return t.clickAt > t.clickDoneAt; };
  async function runEvmSame(w: FloatWallet, job: FloatJob, slipBps: number, s: Snap): Promise<void> {
    const c = job.chain as 'robinhood' | 'bsc'; const cfg = FLOAT_CFG[c]; const e = deps.evm!;
    const oracle6 = big(s.price6); const deadline = BigInt(Math.floor(deps.now() / 1000) + 300);
    const gasFee6 = big(job.fee6);
    if (job.kind === 'topup') {
      // a confirmed switch-off conversion carries the exact stable amount the dialog stated
      const amountIn = job.confirmed && job.amountIn ? big(job.amountIn) : usd6ToStable(big(job.usd6), cfg.stable.decimals);
      if (big(s.reserve) < amountIn) throw new FloatRefused('The reserve no longer holds that much');
      const minOut = minOutFloor('stable→native', amountIn, oracle6, c, slipBps, gasFee6);
      job.amountIn = String(amountIn); job.minOut = String(minOut);
      const allowance = await e.allowance(cfg.stable.address, w.r.evm, cfg.router);
      if (allowance < amountIn) {
        await stepCheck(job);
        const data = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [cfg.router, amountIn] });   // exact amount only
        const tx = { to: cfg.stable.address, data, value: 0n };
        const gas = ((await e.estimate({ ...tx, from: w.r.evm })) * 13n) / 10n;
        const h = await e.sendR(w.id, tx, gas); job.hashes.push(h);
        const r = await e.receipt(h, 60_000); if (!r || r.status !== 'success') throw new FloatRefused('The approval did not land');
      }
      const data = topupCalldata(cfg, amountIn, minOut, w.w.evm, deadline);
      const tx = { to: cfg.router, data, value: 0n };
      const out = firstOut(await e.call({ ...tx, from: w.r.evm }));   // the swap simulated from R: reverts below minOut
      const why = quoteOk('stable→native', amountIn, out, oracle6, c, slipBps, gasFee6); if (why) throw new FloatRefused(why);
      await stepCheck(job);
      const gas = ((await e.estimate({ ...tx, from: w.r.evm })) * 13n) / 10n;
      job.state = 'signing';
      const h = await e.sendR(w.id, tx, gas); job.hashes.push(h); job.state = 'sent'; job.out = String(out);
      return;
    }
    if (job.kind === 'sweep') {
      // the quiet rule for W's sends; a confirmed switch-on conversion waits only for a running trade (stepCheck)
      if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      const amountIn = job.confirmed && job.amountIn ? big(job.amountIn) : usd6ToNative(big(job.usd6), oracle6, 18);
      if (big(s.float) - cfg.gasFloor < amountIn) throw new FloatRefused('The float no longer holds that much');
      const minOut = minOutFloor('native→stable', amountIn, oracle6, c, slipBps, gasFee6);
      const tx = { to: cfg.router, data: sweepCalldata(cfg, amountIn, minOut, w.r.evm, deadline), value: amountIn };
      const out = firstOut(await e.call({ ...tx, from: w.w.evm }));
      const why = quoteOk('native→stable', amountIn, out, oracle6, c, slipBps, gasFee6); if (why) throw new FloatRefused(why);
      job.amountIn = String(amountIn); job.minOut = String(minOut);
      const gas = ((await e.estimate({ ...tx, from: w.w.evm })) * 13n) / 10n;
      // a click cancels a sweep that is not sent yet: the last check right before W signs
      await stepCheck(job); if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      job.state = 'signing';
      const h = await e.sendW(w.id, tx, gas); job.hashes.push(h); job.state = 'sent'; job.out = String(out);
      return;
    }
    if (job.kind === 'gas') {
      if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      const want = cfg.reserveGas - big(s.reserveNative); if (want <= 0n) { job.state = 'arrived'; return; }
      await stepCheck(job);
      job.state = 'signing';
      const h = await e.sendW(w.id, { to: w.r.evm, data: '0x', value: want }, 30_000n); job.hashes.push(h); job.state = 'sent'; job.amountIn = String(want);
      return;
    }
    throw new FloatRefused('Not a same-chain move');
  }
  async function runSolSame(w: FloatWallet, job: FloatJob, slipBps: number, s: Snap): Promise<void> {
    const sl = deps.sol!; const cfg = FLOAT_CFG.sol; const oracle6 = big(s.price6); const gasFee6 = big(job.fee6);
    if (job.kind === 'topup') {
      const amountIn = job.confirmed && job.amountIn ? big(job.amountIn) : usd6ToStable(big(job.usd6), 6);
      if (big(s.reserve) < amountIn) throw new FloatRefused('The reserve no longer holds that much');
      const minOut = minOutFloor('stable→native', amountIn, oracle6, 'sol', slipBps, gasFee6);
      const out = await sl.quote('usdc→sol', amountIn);
      const why = quoteOk('stable→native', amountIn, out, oracle6, 'sol', slipBps, gasFee6); if (why) throw new FloatRefused(why);
      await stepCheck(job); job.state = 'signing'; job.amountIn = String(amountIn); job.minOut = String(minOut);
      const sig = await sl.topup(w.id, amountIn, minOut); job.hashes.push(sig); job.state = 'sent'; job.out = String(out);
      return;
    }
    if (job.kind === 'sweep') {
      if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      const amountIn = job.confirmed && job.amountIn ? big(job.amountIn) : usd6ToNative(big(job.usd6), oracle6, 9);
      if (big(s.float) - cfg.gasFloor < amountIn) throw new FloatRefused('The float no longer holds that much');
      const minOut = minOutFloor('native→stable', amountIn, oracle6, 'sol', slipBps, gasFee6);
      const out = await sl.quote('sol→usdc', amountIn);
      const why = quoteOk('native→stable', amountIn, out, oracle6, 'sol', slipBps, gasFee6); if (why) throw new FloatRefused(why);
      await stepCheck(job); if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      job.state = 'signing'; job.amountIn = String(amountIn); job.minOut = String(minOut);
      const sig = await sl.sweep(w.id, amountIn, minOut); job.hashes.push(sig); job.state = 'sent'; job.out = String(out);
      return;
    }
    if (job.kind === 'gas') {
      if (!job.confirmed && !job.click && !quietOn(job.chain)) throw new FloatRefused('deferred: not quiet');
      const want = cfg.reserveGas - big(s.reserveNative); if (want <= 0n) { job.state = 'arrived'; return; }
      await stepCheck(job); job.state = 'signing';
      const sig = await sl.gas(w.id, want); job.hashes.push(sig); job.state = 'sent'; job.amountIn = String(want);
      return;
    }
    throw new FloatRefused('Not a same-chain move');
  }
  const runSame = (w: FloatWallet, job: FloatJob, slipBps: number, s: Snap) => (cfgOf(job.chain).kind === 'evm' ? runEvmSame(w, job, slipBps, s) : runSolSame(w, job, slipBps, s));
  // what a thrown step means for its job (the same rules as the tick's runner): deferred = not started, nothing kept;
  // unknown = the bytes may be out there, followed by hash and never re-sent; anything else = failed (30 s back-off)
  function failOf(job: FloatJob, x: unknown): 'deferred' | 'unknown' | 'failed' {
    const err = x as Error & { txState?: string; unknown?: boolean; hash?: string };
    if (err.hash && !job.hashes.includes(err.hash)) job.hashes.push(err.hash);
    if (/^deferred:/.test(String(err.message))) { job.state = 'planned'; return 'deferred'; }
    if (err.unknown || err.txState === 'unknown' || err.name === 'SolSendUnknown') { job.state = err.hash ? 'sent' : 'unknown'; job.error = String(err.message).slice(0, 200); return 'unknown'; }
    job.state = 'failed'; job.error = String(err.message).slice(0, 200); return 'failed';
  }

  // ── bridges: quote from the vault itself (no app fee), verify, then sign; failover only before the origin send ──
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('quote timed out')), ms))]);
  const relayCurrency = (c: FloatChain, native: boolean) => (native ? (c === 'sol' ? '11111111111111111111111111111111' : '0x0000000000000000000000000000000000000000') : cfgOf(c).stable.address);
  async function quoteBridge(b: BridgeId, route: RouteKey, w: FloatWallet, job: FloatJob, amountIn: bigint): Promise<BridgeQuote> {
    const from = job.from!, to = job.chain; const fc = cfgOf(from), tc = cfgOf(to); const toNative = job.kind === 'cold';
    const signer = fc.kind === 'evm' ? w.r.evm : w.r.sol;
    const recipient = toNative ? (tc.kind === 'evm' ? w.w.evm : w.w.sol) : (tc.kind === 'evm' ? w.r.evm : w.r.sol);
    const outDecimals = toNative ? tc.nativeDecimals : tc.stable.decimals;
    if (b === 'relay') {
      // (2026-10-29, owner «USD-баланс: перевести его запросы к Relay на схему с ключом … делай тоже») keyless from Relay first,
      // as before; motion's keyed pass-through only when Relay refuses for want of a key (relayApi.relayQuote). A quote that
      // came through motion must also pass what does not trust motion: the exact claims, Relay's pinned depository with an
      // exact approve, and Relay's own keyless price. The checks below (recipient, oracle floor, pinned contracts, the
      // simulation from R) run for every quote as before.
      const body = { user: signer, recipient, originChainId: fc.relayChainId, destinationChainId: tc.relayChainId, originCurrency: relayCurrency(from, false), destinationCurrency: relayCurrency(to, toNative), amount: String(amountIn), tradeType: 'EXACT_INPUT' as const, appFees: [], slippageTolerance: String(Math.max(10, Math.floor(job.reason === 'click' ? 100 : 50))) };
      let got: { j: any; source: QuoteSource };
      try { got = await relayQuote(body, deps.fetch); } catch (x) { throw new Error(String((x as Error)?.message || x).slice(0, 90)); }
      const j = got.j;
      if (got.source === 'motion') {
        const bad = detailsProblem(j, body); if (bad) throw new Error('Relay (through motion): ' + bad);
        const st = evmStepsProblem(j, { user: signer, originChainId: fc.relayChainId, originCurrency: body.originCurrency, amount: body.amount }); if ('problem' in st) throw new Error('Relay (through motion): ' + st.problem);
        const p = priceProblem(big(j.details?.currencyOut?.amount), outDecimals, await independentOut(body, fc.stable.decimals, deps.fetch)); if (p) throw new Error('Relay (through motion): ' + p);
      }
      const txs = fc.kind === 'evm' ? j.steps.flatMap((s: any) => (s.kind === 'transaction' ? s.items.map((i: any) => ({ to: String(i.data.to), data: String(i.data.data || '0x'), value: big(i.data.value || '0') })) : [])) : undefined;
      const fees6 = usd6(Number(j.fees?.relayer?.amountUsd || 0) + Number(j.fees?.gas?.amountUsd || 0) + Number(j.fees?.app?.amountUsd || 0));
      return { bridge: b, route, amountIn, out: big(j.details?.currencyOut?.amount), minOut: big(j.details?.currencyOut?.minimumAmount), fees6, etaMs: Math.max(BRIDGE_ETA_MS.relay, Number(j.details?.timeEstimate || 0) * 1000), recipient: String(j.details?.recipient || ''), requestId: String(j.steps[j.steps.length - 1]?.requestId || ''), txs, outDecimals };
    }
    if (b === 'debridge') {
      const p = new URLSearchParams({ srcChainId: String(fc.debridgeChainId), srcChainTokenIn: fc.stable.address, srcChainTokenInAmount: String(amountIn), dstChainId: String(tc.debridgeChainId), dstChainTokenOut: relayCurrency(to, toNative), dstChainTokenOutAmount: 'auto', dstChainTokenOutRecipient: recipient, srcChainOrderAuthorityAddress: signer, dstChainOrderAuthorityAddress: tc.kind === 'evm' ? w.r.evm : w.r.sol, prependOperatingExpenses: 'false' });
      const r = await deps.fetch('https://dln.debridge.finance/v1.0/dln/order/create-tx?' + p);
      const j = await r.json().catch(() => null) as any;
      if (!r.ok || !j?.tx) throw new Error('deBridge: ' + String(j?.errorMessage || r.status).slice(0, 80));
      const out = big(j.estimation?.dstChainTokenOut?.amount); const fix = big(j.fixFee);
      const snap = readSnap(w, from); const fix6 = snap ? nativeToUsd6Up(fix, big(snap.price6), 18) : USD * 5n;
      const in6 = stableToUsd6(amountIn, fc.stable.decimals); const out6 = toNative ? 0n : stableToUsd6(out, outDecimals);
      const txs = fc.kind === 'evm' ? [{ to: fc.stable.address, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [String(j.tx.to) as `0x${string}`, amountIn] }), value: 0n }, { to: String(j.tx.to), data: String(j.tx.data), value: big(j.tx.value) }] : undefined;
      return { bridge: b, route, amountIn, out, minOut: out, fees6: (toNative ? 0n : in6 - out6) + fix6, etaMs: Math.max(BRIDGE_ETA_MS.debridge, Number(j.order?.approximateFulfillmentDelay || 0) * 1000), recipient, requestId: String(j.orderId || ''), txs, outDecimals };
    }
    if (b === 'mayan') {
      // quote-only (no execution until its review): proves the route is up, for the health score and the status line
      const r = await deps.fetch(`https://price-api.mayan.finance/v3/quote?amountIn64=${amountIn}&fromToken=${fc.stable.address}&fromChain=${from === 'sol' ? 'solana' : 'bsc'}&toToken=${relayCurrency(to, toNative)}&toChain=${to === 'sol' ? 'solana' : 'bsc'}&slippageBps=50&swift=true&sdkVersion=13_0_0`);
      if (!r.ok) throw new Error('Mayan: ' + r.status);
      throw new Error('Mayan: quote only (not reviewed for signing yet)');
    }
    throw new Error(`${b}: not available`);
  }
  /**
   * motion's own bridge for one cold top-up. It signs at most ONE transfer, of exactly the quoted amount, to the
   * deposit address the solver publishes, and never a second one for the same job. The answer says what to do next:
   *   done  — the destination native is in W, or the fill is out there and is being followed;
   *   stop  — the solver took the transfer and gave it back (refunded) or it never left (failed): the user's money is
   *           where it was, and we do NOT start a second move for the same need in the same breath;
   *   why   — nothing of ours was signed: the caller falls through to the public bridges.
   */
  type MotionTry = { done?: boolean; stop?: boolean; why?: string };
  /** what a followed motion fill that is still open tells the user (undefined: in transit, nothing to add) */
  const motionPendingLine = (state: string): string | undefined =>
    state === 'source-late' ? 'Your transfer has not landed yet — motion pays you as soon as it lands, or sends it back'
    : state === 'refunding' ? 'motion could not pay on the other chain — your funds are on their way back'
    : undefined;
  async function tryMotionBridge(w: FloatWallet, job: FloatJob, perm: Permission, amountIn: bigint): Promise<MotionTry> {
    if (!solver) return { why: 'not configured' };
    const from = job.from!, to = job.chain; const fc = cfgOf(from), tc = cfgOf(to);
    const in6 = stableToUsd6(amountIn, fc.stable.decimals);
    if (in6 > MOTION_BRIDGE_MAX6) return { why: 'above what motion carries' };
    const ds = readSnap(w, to);
    if (!ds || priceState(ds.priceAt, deps.now()) !== 'fresh') return { why: 'no fresh price of our own for the destination chain' };
    try {
      if (!solverHealth || deps.now() - solverHealth.at > 60_000) {
        const h = await withTimeout(solver.health(), QUOTE_TIMEOUT_MS);
        solverHealth = { at: deps.now(), on: h.on && h.chains.includes(from as BridgeChain) && h.chains.includes(to as BridgeChain), deposits: h.deposits, max6: usd6(h.maxFillUsd || 0) };
      }
      if (!solverHealth.on) return { why: 'the solver is off' };
      if (solverHealth.max6 > 0n && in6 > solverHealth.max6) return { why: 'above the solver per-fill cap' };
      await stepCheck(job);
      const q = await withTimeout(solver.quote({
        from: from as BridgeChain, to: to as BridgeChain, amountIn,
        depositor: fc.kind === 'evm' ? w.r.evm : w.r.sol, recipient: tc.kind === 'evm' ? w.w.evm : w.w.sol,
        oracle6: big(ds.price6), maxSlipBps: perm.caps.maxSlipBps, deposits: solverHealth.deposits,
      }), QUOTE_TIMEOUT_MS);
      // no daily fee cap (owner 2026-10-27): the bridge's own quote and inventory are the limits
      job.bridge = 'motion'; job.requestId = q.quote.id; job.amountIn = String(amountIn); job.minOut = String(q.out); job.fee6 = String(q.fee6 + big(job.fee6));
      emit(w, job.id, 'quote', 'done', { bridge: 'motion', fee: Number(q.fee6) / 1e6, eta: q.etaMs });
      await stepCheck(job);
      job.state = 'signing';
      // A3 (2026-11-01 pass 3): the solver answers 'paid' the moment the payout is broadcast (it keeps confirming it on its own
      // side); an older solver ignores the flag and answers as before
      const sent = await solver.fill(q.quote, q.sig, w.id, { early: true });
      job.hashes.push(sent.srcHash);
      job.at = deps.now();
      if (sent.state === 'filled') {
        job.state = 'arrived'; job.out = String(q.out);
        noteOutcome({ bridge: 'motion', route: `${from}>${to}` as RouteKey, ok: true, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion });
        emit(w, job.id, job.kind, 'done', { chain: to, bridge: 'motion', usd: Number(job.usd6) / 1e6 });
        return { done: true };
      }
      if (sent.state === 'refunded' || sent.state === 'failed') {
        // nothing of the user's is gone: either it never left, or the solver sent it back
        job.state = sent.state === 'refunded' ? 'refunded' : 'failed';
        job.error = sent.error || 'motion did not fill';
        noteOutcome({ bridge: 'motion', route: `${from}>${to}` as RouteKey, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion });
        emit(w, job.id, job.kind, 'failed', { chain: to, bridge: 'motion', error: job.error });
        return { stop: true };
      }
      // anything else is still moving and is followed through the solver's status, never signed again (2026-11-01): a source
      // not seen included in time ('source-late': it may still land — motion pays then, or sends it back), a payout out but
      // not seen yet ('paid'), a refund on its way ('refunding'). None of these is "nothing was taken".
      job.state = 'relaying';
      job.error = motionPendingLine(sent.state);
      // 'paid' (A3): the payout's own hash, which this vault looks up on the destination chain itself (followBridge): arrived only
      // once that chain shows it landed (or the solver says filled, from its own look at the chain)
      if (sent.state === 'paid' && sent.dstHash) { job.dstHash = sent.dstHash; job.out = String(q.out); emit(w, job.id, job.kind, 'paid', { chain: to, bridge: 'motion' }); }
      return { done: true };
    } catch (x) {
      if (x instanceof SolverUnknown) {
        // the bytes are out there: follow them, never sign again for this need
        if (x.srcHash) job.hashes.push(x.srcHash);
        job.bridge = 'motion'; job.requestId = x.quoteId || job.requestId; job.state = 'relaying'; job.at = deps.now();
        job.error = x.message;
        return { done: true };
      }
      if (x instanceof FloatRefused) throw x;
      const why = String((x as Error)?.message || x).replace(/^motion bridge: /, '').slice(0, 120);
      if (!(x instanceof SolverRefused)) noteOutcome({ bridge: 'motion', route: `${from}>${to}` as RouteKey, ok: false, sentAt: deps.now(), doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion });
      return { why };
    }
  }
  async function runBridge(w: FloatWallet, job: FloatJob, perm: Permission): Promise<void> {
    const from = job.from!; const route = `${from}>${job.chain}` as RouteKey; const fc = cfgOf(from);
    if (fc.kind !== 'evm') {
      // Relay hands back raw Solana instructions the vault does not sign yet; motion's own bridge is ONE transfer of
      // ours, so a Solana origin is allowed through it alone.
      if (job.kind === 'cold' && solver) {
        const m = await tryMotionBridge(w, job, perm, usd6ToStable(big(job.usd6), cfgOf(from).stable.decimals));
        if (m.done || m.stop) return;
        throw new FloatRefused('motion: ' + m.why + ' - and a cross-chain move from Solana is not signed through a public bridge yet');
      }
      throw new FloatRefused('A cross-chain move from Solana is not signed by the vault yet (Relay\'s Solana instructions are reviewed in phase 4)');
    }
    const e = deps.evm!; const amountIn = usd6ToStable(big(job.usd6), fc.stable.decimals);
    // the source frame checks its own snapshot; from another frame the solver checks the payer holds the amount before anything moves
    if (from === here()) { const snap = readSnap(w, from); if (!snap || big(snap.reserve) < amountIn) throw new FloatRefused('The reserve no longer holds that much'); }
    const reasonsMotion: string[] = [];
    // motion's own bridge first, for the move a user actually waits for (a cold top-up: stable here -> native on the
    // chain the click is on). It is one transfer of ours and the solver itself refuses a second fill for this wallet,
    // so it runs before the Relay cross-device check below — that check is a round trip the user would wait for.
    if (job.kind === 'cold' && solver) {
      const m = await tryMotionBridge(w, job, perm, amountIn);
      if (m.done || m.stop) return;
      if (m.why) reasonsMotion.push('motion: ' + m.why);
    }
    // signed from another chain's frame (a click's cold top-up): motion's bridge only — the public bridges send from R on
    // that chain, which only that chain's own frame does
    if (from !== here()) throw new FloatRefused((reasonsMotion[0] || 'motion: not available') + ' (the public bridges run from the source chain frame)');
    // another device may have started the same move: Relay's own list of this reserve's requests, last 2 minutes
    try {
      // keyless requests/v2 while Relay keeps it, else motion's keyed read-only pass-through (relayApi.relayRequestsOf): only
      // rows naming this reserve count; a lying answer can only defer this move or hide one, never move or land anything
      const j = await withTimeout(relayRequestsOf(w.r.evm, deps.fetch), QUOTE_TIMEOUT_MS);
      const recent = (j?.requests || []).some((q: any) => deps.now() - Date.parse(q.createdAt || 0) < 120_000 && Number(q.data?.outTxs?.[0]?.chainId || q.data?.destinationChainId || 0) === cfgOf(job.chain).relayChainId);
      if (recent) throw new FloatRefused('deferred: a move to that chain started in the last 2 minutes (another device?)');
    } catch (x) { if (x instanceof FloatRefused) throw x; }
    // no daily fee cap (owner 2026-10-27) — except a ready-dollar move (READY, 2026-11-01 pass 3): its stated bridge fee at most
    // $0.10 + 0.5 % of it, so a pre-position never costs more than it is worth (deBridge's fixed fee never passes at these sizes)
    const feeRoom6 = job.ready ? readyFeeMax6(stableToUsd6(amountIn, fc.stable.decimals)) : UNCAPPED.feesPerDay6;
    const order = bridgeOrder(route, bridgeHealth(health(), deps.now()), deps.now(), fc.kind).filter((b) => b !== 'motion');
    const tried: BridgeId[] = reasonsMotion.length ? ['motion' as BridgeId] : []; const reasons: string[] = [...reasonsMotion];
    let q: BridgeQuote | null = null;
    for (const b of order) {
      await stepCheck(job); tried.push(b);
      try {
        const cand = await withTimeout(quoteBridge(b, route, w, job, amountIn), QUOTE_TIMEOUT_MS);
        const tc = cfgOf(job.chain);
        let why: string | null;
        if (job.kind === 'cold') {
          // stable → the destination's native: priced with the destination frame's on-chain oracle (fresh only)
          const ds = readSnap(w, job.chain);
          if (!ds || priceState(ds.priceAt, deps.now()) !== 'fresh') why = 'No fresh price for the destination chain';
          else {
            const in6 = stableToUsd6(amountIn, fc.stable.decimals) - cand.fees6;
            const floor = (usd6ToNative(in6 > 0n ? in6 : 0n, big(ds.price6), tc.nativeDecimals) * BigInt(10_000 - perm.caps.maxSlipBps)) / 10_000n;
            why = cand.recipient.toLowerCase() !== (tc.kind === 'evm' ? w.w.evm : w.w.sol).toLowerCase() ? 'Quote pays someone else' : cand.fees6 > feeRoom6 ? 'Over the daily fee cap' : cand.minOut < floor ? 'The quote is below the oracle price minus slippage' : null;
            if (!why) why = verifyBridgeTxs(cand, { from, signer: w.r.evm, stableIn: fc.stable.address });
          }
        } else why = verifyBridgeQuote(cand, { from, to: job.chain, signer: w.r.evm, recipient: tc.kind === 'evm' ? w.r.evm : w.r.sol, amountIn, stableIn: fc.stable.address, maxSlipBps: perm.caps.maxSlipBps, feeRoom6 });
        if (why) { reasons.push(`${b}: ${why}`); continue; }
        q = cand; break;
      } catch (x) { if (x instanceof FloatRefused) throw x; reasons.push(String((x as Error).message || x).slice(0, 100)); }
    }
    job.tried = tried;
    if (!q || !q.txs) throw new FloatRefused('Every bridge refused: ' + reasons.join(' · '));
    // (a ready-dollar move's ledger line: the bridge's stated fee + the gas estimate, without the plan's $0.40 bridge placeholder,
    // which the stated fee replaces — its day budget counts what the move really costs)
    const est6 = big(job.fee6); const gas6 = job.ready && est6 > BRIDGE_FEE_EST6 ? est6 - BRIDGE_FEE_EST6 : est6;
    job.bridge = q.bridge; job.requestId = q.requestId; job.amountIn = String(amountIn); job.minOut = String(q.minOut); job.fee6 = String(q.fees6 + gas6);
    emit(w, job.id, 'quote', 'done', { bridge: q.bridge, fee: Number(q.fees6) / 1e6, eta: q.etaMs, ...(job.ready ? { ready: true, reason: job.reason, usd: Number(job.usd6) / 1e6, from: job.from, chain: job.chain } : {}) });
    // approvals first (exact amount, to the bridge's own contract), each landed before the deposit is simulated and sent
    for (const t of q.txs) {
      await stepCheck(job);
      const tx = { to: t.to as `0x${string}`, data: t.data as `0x${string}`, value: t.value };
      const isApprove = t.to.toLowerCase() === fc.stable.address.toLowerCase();
      if (!isApprove) await e.call({ ...tx, from: w.r.evm });   // the deposit simulated from R after its approval landed: a revert stops here, nothing sent
      const gas = ((await e.estimate({ ...tx, from: w.r.evm })) * 13n) / 10n;
      if (!isApprove) job.state = 'signing';
      const h = await e.sendR(w.id, tx, gas); job.hashes.push(h);
      if (isApprove) { const r = await e.receipt(h, 60_000); if (!r || r.status !== 'success') throw new FloatRefused('The approval did not land'); }
      else { job.state = 'relaying'; job.at = deps.now(); }
    }
  }
  async function followBridge(w: FloatWallet, job: FloatJob): Promise<void> {
    if (job.bridge === 'motion' && job.requestId && solver) {
      const st = await withTimeout(solver.status(job.requestId), QUOTE_TIMEOUT_MS).catch(() => null);
      const mroute = `${job.from}>${job.chain}` as RouteKey;
      if (st?.state === 'filled') { job.state = 'arrived'; if (st.dstHash && !job.hashes.includes(st.dstHash)) job.hashes.push(st.dstHash); noteOutcome({ bridge: 'motion', route: mroute, ok: true, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion }); }
      else if (st?.state === 'refunded') { job.state = 'refunded'; job.error = 'motion could not pay on the other chain; your funds came back'; noteOutcome({ bridge: 'motion', route: mroute, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion }); }
      else if (st?.state === 'failed' || st?.state === 'expired') { job.state = 'failed'; job.error = st.error || 'motion did not fill - nothing was paid'; noteOutcome({ bridge: 'motion', route: mroute, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion }); }
      // still open on the solver (a late source, a payout not seen yet, a refund on its way): followed, never re-signed
      else if (st?.state) {
        const line = motionPendingLine(st.state); if (line) job.error = line;
        // A3: a payout the solver broadcast ('paid' / 'paying') is looked up on the destination chain by this frame itself when it
        // is that chain's frame: arrived once its receipt (EVM, status success) or its signature (Solana, confirmed) shows it
        // landed. A reverted or missing payout changes nothing here: the solver refunds it, and its status says so
        const dst = (st.state === 'paid' || st.state === 'paying') ? (job.dstHash || st.dstHash) : undefined;
        if (dst && !job.dstHash) job.dstHash = dst;
        if (dst && await payoutLanded(job.chain, dst)) { job.state = 'arrived'; if (!job.hashes.includes(dst)) job.hashes.push(dst); noteOutcome({ bridge: 'motion', route: mroute, ok: true, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.motion }); }
      }
    } else if (job.bridge === 'relay' && job.requestId) {
      // keyless and direct (status/v3 takes the key as optional, v2 as the fallback): "landed" never comes through motion
      const j = await withTimeout(relayStatus(job.requestId, deps.fetch), QUOTE_TIMEOUT_MS);
      const st = String(j?.status || '');
      if (st === 'success') { job.state = 'arrived'; noteOutcome({ bridge: 'relay', route: `${job.from}>${job.chain}` as RouteKey, ok: true, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.relay }); }
      else if (st === 'refund' || st === 'refunded') { job.state = 'refunded'; noteOutcome({ bridge: 'relay', route: `${job.from}>${job.chain}` as RouteKey, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.relay }); }
      else if (st === 'failure') { job.state = 'unknown'; job.error = 'Relay reports a failure — waiting for its refund'; noteOutcome({ bridge: 'relay', route: `${job.from}>${job.chain}` as RouteKey, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.relay }); }
      // W's own native deposit (nativeDonorRun) that Relay has not seen land: a deposit that reverted on its chain is over (only
      // its gas was spent; nothing reached Relay). Looked at once the move is past Relay's ETA, never in front of a fresh one
      else if (job.src === 'w' && job.from && deps.nativeDonor?.receipt && job.hashes[0] && deps.now() - job.at > 2 * BRIDGE_ETA_MS.relay) {
        const rc = await withTimeout(deps.nativeDonor.receipt(job.from, job.hashes[0] as `0x${string}`), QUOTE_TIMEOUT_MS).catch(() => null);
        if (rc === 'reverted') { job.state = 'failed'; job.error = `The deposit reverted on ${job.from === 'bsc' ? 'BNB' : 'Robinhood'}: only its gas was spent`; }
      }
    } else if (job.bridge === 'debridge' && job.requestId) {
      const r = await withTimeout(deps.fetch(`https://dln-api.debridge.finance/api/Orders/${job.requestId}`), QUOTE_TIMEOUT_MS); const j = await r.json().catch(() => null) as any;
      const st = String(j?.status || j?.state || '');
      if (/Fulfilled|ClaimedUnlock|SentUnlock/i.test(st)) { job.state = 'arrived'; noteOutcome({ bridge: 'debridge', route: `${job.from}>${job.chain}` as RouteKey, ok: true, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.debridge }); }
      else if (/Cancel/i.test(st)) { job.state = 'refunded'; noteOutcome({ bridge: 'debridge', route: `${job.from}>${job.chain}` as RouteKey, ok: false, sentAt: job.at, doneAt: deps.now(), etaMs: BRIDGE_ETA_MS.debridge }); }
    }
    // "In transit (slow)" past 10× ETA (≥ 30 s): still counted, never a second move to that chain; stuck > 30 min is shown with its id
    const eta = BRIDGE_ETA_MS[job.bridge || 'relay'];
    if (job.state === 'relaying' && deps.now() - job.at > Math.max(30_000, 10 * eta)) job.error = deps.now() - job.at > 1_800_000 ? `Stuck: contact ${job.bridge} support with request ${job.requestId}` : 'In transit (slow)';
  }
  // A3: motion's payout on THIS frame's chain, from the chain itself (the float's own read client): true only on a landed
  // receipt / a confirmed signature; anything else (not yet, reverted, failed, a read error, another frame's chain) is false
  async function payoutLanded(chain: FloatChain, hash: string): Promise<boolean> {
    if (chain !== here()) return false;
    try {
      if (cfgOf(chain).kind === 'evm') { if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return false; const r = await deps.evm!.receipt(hash as `0x${string}`, 1); return r?.status === 'success'; }
      return (await deps.sol!.status(hash)) === 'confirmed';
    } catch { return false; }
  }
  // A3: the next part of a click's cross-chain top-up runs only once the part before it FILLED (XCHAIN). With 'paid' at the
  // payout's broadcast that part is still 'relaying' when its fill answers: it is followed right here (the solver's status, then
  // this chain's own look at the payout) until it arrived, at most PART_WAIT_MS — about what the solver's own wait used to be.
  // Not arrived by then = held, exactly as before
  const PART_WAIT_MS = 6_000, PART_LOOK_MS = 150;
  async function partFilled(w: FloatWallet, job: FloatJob): Promise<boolean> {
    if (job.bridge !== 'motion' || job.state !== 'relaying' || !job.dstHash || !solver) return job.state === 'arrived';
    const until = deps.now() + PART_WAIT_MS;
    for (;;) {
      try { await followBridge(w, job); } catch { /* the next look */ }
      if (job.state !== 'relaying') return job.state === 'arrived';
      if (deps.now() >= until) return false;
      await deps.wait(PART_LOOK_MS);
    }
  }
  // a sent same-chain move: its receipt decides; an unknown broadcast is never re-sent, only looked up
  async function followSame(job: FloatJob): Promise<void> {
    const h = job.hashes[job.hashes.length - 1]; if (!h) return;
    if (cfgOf(job.chain).kind === 'evm') {
      const r = await deps.evm!.receipt(h as `0x${string}`, 1).catch(() => null);
      if (r) job.state = r.status === 'success' ? 'arrived' : 'failed';
      if (r?.status === 'reverted') job.error = 'The swap reverted on chain (price moved past the floor): only its gas was spent';
    } else {
      const st = await deps.sol!.status(h).catch(() => null);
      if (st === 'confirmed') job.state = 'arrived'; else if (st === 'failed') { job.state = 'failed'; job.error = 'The swap failed on chain: only its fee was spent'; }
    }
    if (job.state === 'sent' && deps.now() - job.updatedAt > 120_000) job.state = 'unknown';
  }

  /**
   * A waiting click on chain c that the reserves could not cover, paid from the trading wallet's OWN native on another EVM
   * chain of the permission (src/nativeDonor.ts; 2026-10-30, owner «если считаешь что поможет и ускорит то делай»). Every
   * donor chain at once: W's native there, that chain's oracle and gas price (deps.nativeDonor.read) beside Relay's
   * EXACT_OUTPUT quote for exactly what c still lacks. A donor is one whose spare (above its gas floor and the deposit's gas —
   * since 2026-11-01 a click may take the chain's kept trading float too, see nativeDonorSpare) pays the quote and whose quote
   * passes every check; one that leaves its kept float alone, then the cheapest at the two oracles, then the fastest, is signed
   * — ONE depositNative by W on that chain. When no chain can pay it alone (2026-11-01: $2.45 on Robinhood + $2.45 on BNB and a
   * $1 buy on Solana), the chains pay it together (nativeDonorSplit): one EXACT_OUTPUT part per chain, each with every check of
   * a single move, and nothing is signed until every part has passed. Each part is a 'cold' move with src 'w' in this frame's
   * list, followed like any Relay move; the native lands in W on c and the app's hold & fire sees it (a fresh read) and fires.
   *   null    — nothing to move, or no wallet of this account holds anything to spare there: the click's answer is as before;
   *   { why } — a donor exists but every quote was refused (nothing signed): the click is told why;
   *   jobs    — sent (relaying), refused at the send (failed, with why), or unknown with its hash (followed, never re-sent).
   */
  // `preReads` (PROPOSAL TC-1): the donors' reads this tick already made (tick readExtra) — reused, never read twice
  async function nativeDonorRun(w: FloatWallet, c: FloatChain, perm: Permission, s: Snap, need6: bigint, started6: bigint, jobs: FloatJob[], own: readonly string[] = [], preReads?: Map<FloatChain, Promise<{ native: bigint; price6: bigint; gasPrice: bigint }>>): Promise<FloatJob[] | { why: string } | null> {
    const nd = deps.nativeDonor; if (!nd) return null;
    const donors = perm.chains.filter((k) => k !== c && cfgOf(k).kind === 'evm');
    if (!donors.length || priceState(s.priceAt, deps.now()) !== 'fresh') return null;
    // one native move per lane at a time: one still open is already counted on its way (s.inFlight6)
    if (jobs.some((j) => isOpen(j) && j.src === 'w' && j.chain === c)) return null;
    const need = nativeDonorNeed({ chain: c, float: big(s.float), price6: big(s.price6), inFlight6: big(s.inFlight6), need6, started6 });
    if (!need) return null;
    const tc = cfgOf(c); const recipient = tc.kind === 'evm' ? w.w.evm : w.w.sol;
    const out = 'refuse' in need ? 0n : need.out;
    const slip = perm.caps.maxSlipBps;
    const nameOf = (d: FloatChain) => (d === 'robinhood' ? 'Robinhood' : 'BNB');
    type Ok = Exclude<ReturnType<typeof nativeDonorQuoteProblem>, { problem: string }>;
    type Read = { d: FloatChain; r: { native: bigint; price6: bigint; gasPrice: bigint }; spare: bigint; kept: bigint; quoteP: ReturnType<typeof relayQuote> | null };
    type Cand = { d: FloatChain; spare: bigint; q?: Ok; why?: string; lost6: bigint; etaMs: number; drains?: boolean; out: bigint };
    // every donor read side by side; the whole move's quote goes out beside each read (it depends only on what c needs)
    const reads = (await Promise.all(donors.map(async (d): Promise<Read | null> => {
      const quoteP = out > 0n ? withTimeout(relayQuote(nativeDonorBody({ from: d, to: c, user: w.w.evm, recipient, out, slipBps: slip }) as never, deps.fetch), QUOTE_TIMEOUT_MS) : null;
      quoteP?.catch(() => {});
      let r: Read['r'];
      try { r = await (preReads?.get(d) ?? withTimeout(nd.read(d, w.w.evm), 2_500)); } catch { return null; }
      const gasCost = NATIVE_DONOR.gasMax * r.gasPrice;
      // a click: everything above the gas floor and the deposit's gas (2026-11-01); `kept` = what it spares above its kept float
      const spare = nativeDonorSpare({ chain: d, float: r.native, price6: r.price6, keep6: 0n, gasCost });
      if (spare <= 0n) return null;
      const pre = prefsOf(w, d); const active = deps.now() - pre.activeAt < RULES.activeMs;
      const keep6 = targetOf(d, readySize6(pre.presets6, pre.buys6), active, perm.caps.perChain6, readyMultTenths(burstAt(w, d))).trading6;
      return { d, r, spare, kept: nativeDonorSpare({ chain: d, float: r.native, price6: r.price6, keep6, gasCost }), quoteP };
    }))).filter((x): x is Read => !!x);
    if (!reads.length) return null;   // no wallet of this account holds anything to spare on another chain: as before
    if ('refuse' in need) {
      // over the per-buy cap: said only when this wallet could have carried such a move (as before), else the answer is as before
      const could = reads.some((x) => x.spare >= usd6ToNative(NATIVE_DONOR.max6, x.r.price6, cfgOf(x.d).nativeDecimals));
      return could ? { why: need.refuse } : null;
    }
    // one part's quote, held to every check of a single move against THIS donor's spare
    const check = async (x: Read, partOut: bigint, quoteP: ReturnType<typeof relayQuote>): Promise<Cand> => {
      const cand: Cand = { d: x.d, spare: x.spare, lost6: 0n, etaMs: 0, out: partOut };
      const name = nameOf(x.d);
      try {
        const got = await quoteP;
        const maxIn = nativeDonorMaxIn({ from: x.d, out6: nativeToUsd6Up(partOut, big(s.price6), tc.nativeDecimals), price6: x.r.price6, spare: x.spare, maxSlipBps: slip });
        const q = nativeDonorQuoteProblem(got.j, { from: x.d, to: c, user: w.w.evm, recipient, out: partOut, maxIn });
        if ('problem' in q) return { ...cand, why: `${name}: ${q.problem}` };
        // a quote that came through motion's keyed pass-through also stands against Relay's own keyless price for that input
        if (got.source === 'motion') {
          const body = nativeDonorBody({ from: x.d, to: c, user: w.w.evm, recipient, out: partOut, slipBps: slip });
          const ref = await independentOut({ ...body, tradeType: 'EXACT_INPUT', amount: String(q.amountIn) } as never, cfgOf(x.d).nativeDecimals, deps.fetch);
          const p = priceProblem(q.out, tc.nativeDecimals, ref); if (p) return { ...cand, why: `${name} (through motion): ${p}` };
        }
        const pp = nativeDonorPriceProblem({ from: x.d, to: c, amountIn: q.amountIn, inPrice6: x.r.price6, out: q.out, outPrice6: big(s.price6), fees6: q.fees6, maxSlipBps: slip });
        if (pp) return { ...cand, why: `${name}: ${pp}` };
        const lost6 = nativeToUsd6Up(q.amountIn, x.r.price6, cfgOf(x.d).nativeDecimals) - nativeToUsd6(q.out, big(s.price6), tc.nativeDecimals);
        return { ...cand, q, lost6, etaMs: q.etaMs, drains: q.amountIn > x.kept };
      } catch (e) { return { ...cand, why: `${name}: ${String((e as Error)?.message || e).slice(0, 90)}` }; }
    };
    const whyOf = (xs: Cand[], head = '') => (head + xs.map((x) => x.why).filter(Boolean).join(' · ')).slice(0, 160) || 'no quote';
    let pick: (Cand & { q: Ok })[] | null = null;
    const quoteFor = (d: FloatChain, amount: bigint) => { const p = withTimeout(relayQuote(nativeDonorBody({ from: d, to: c, user: w.w.evm, recipient, out: amount, slipBps: slip }) as never, deps.fetch), QUOTE_TIMEOUT_MS); p.catch(() => {}); return p; };
    const caps = reads.map((x) => ({ d: x.d, cap6: nativeDonorCap6({ from: x.d, spare: x.spare, price6: x.r.price6, maxSlipBps: slip }) }));
    // the need with its 25 % margin first; when no chain, alone or together, can carry that, the bare need (2026-11-01: small
    // balances — Relay's EXACT_OUTPUT lands exactly what W lacks for the click, its gas floor included)
    for (const amount of need.bare > 0n && need.bare < out ? [out, need.bare] : [out]) {
      const amount6 = nativeToUsd6Up(amount, big(s.price6), tc.nativeDecimals);
      // a donor that can carry the whole move at all (its dollars at its chain's oracle, before Relay's fee)
      const whole = reads.filter((x) => x.spare >= usd6ToNative(amount6, x.r.price6, cfgOf(x.d).nativeDecimals));
      if (whole.length) {
        const found = await Promise.all(whole.map((x) => check(x, amount, amount === out ? x.quoteP! : quoteFor(x.d, amount))));
        const ok = nativeDonorRank(found.filter((x): x is Cand & { q: Ok } => !!x.q));
        if (!ok.length) return { why: whyOf(found) };
        pick = [ok[0]]; break;
      }
      // no chain carries it alone: together (2026-11-01). Each part asks Relay for exactly its share (EXACT_OUTPUT)
      const parts = nativeDonorSplit({ to: c, out: amount, price6: big(s.price6), donors: caps });
      if (!parts) continue;   // together they cannot carry it either
      const found = await Promise.all(parts.map((p) => check(reads.find((y) => y.d === p.d)!, p.out, quoteFor(p.d, p.out))));
      // every part or none: a part alone would not make the click payable
      if (found.some((x) => !x.q)) return { why: whyOf(found.filter((x) => !x.q), 'together: ') };
      pick = found as (Cand & { q: Ok })[]; break;
    }
    if (!pick) return null;   // no chain, alone or together, can carry even the bare need: the click's answer is as before
    const now = deps.now();
    // each part's id: the next free one of its lane this minute (freeJobId: a move that arrived keeps its own)
    const ids = pick.map((p) => freeJobId(jobs, w.id + ':w', 'cold', c, p.d, now));
    if (ids.some((x) => !canRun(x.existing, now))) return null;
    // ANY cross-chain move into this chain that arrived under BRIDGE_SETTLE_MS ago — from any chain, W- or R-sourced, run from
    // any frame: its payout may not show in this read yet (2026-11-01, audit pass 2: p2-money-settle-only-same-from — only the
    // same donor was held, so a second click could bridge the same need again from another chain) — unless a read here already
    // showed its payout (payoutSeen, usd-fix2: the double tap after a cross-chain-funded buy)
    // (`own`: this click's own moves above, already counted in started6 — they never hold their own click's remainder)
    if ([...jobs, ...allJobs(w)].some((j) => (j.kind === 'cold' || j.kind === 'rebalance') && j.chain === c && j.state === 'arrived' && now - j.updatedAt < BRIDGE_SETTLE_MS && !own.includes(j.id) && !payoutSeen(j, jobs, readsOf(w, c)))) return null;
    // the parts are signed side by side: each on its own chain (W's own nonce there), none waits for another
    const sent = await Promise.all(pick.map(async (best, i): Promise<FloatJob | null> => {
      const q = best.q; const d = best.d;
      const id = ids[i].id;
      const usd = nativeToUsd6(q.out, big(s.price6), tc.nativeDecimals);
      const job: FloatJob = { id, walletId: w.id, kind: 'cold', src: 'w', chain: c, from: d, usd6: String(usd), fee6: String(best.lost6 > 0n ? best.lost6 : q.fees6), state: 'planned', at: now, updatedAt: now,
        click: true, hashes: [], reason: 'click, from this wallet on ' + d + (pick.length > 1 ? ` (part ${i + 1} of ${pick.length})` : ''), bridge: 'relay', requestId: q.requestId, amountIn: String(q.amountIn), minOut: String(best.out), out: String(q.out), base: String(s.float), baseAt: s.at };
      emit(w, id, 'cold', 'active', { chain: c, from: d, src: 'w', usd: Number(usd) / 1e6, bridge: 'relay', eta: q.etaMs });
      const gasQ = /^\d{1,12}$/.test(String(q.deposit.gas ?? '')) ? BigInt(String(q.deposit.gas)) : 0n;
      const g = (gasQ * 3n) / 2n; const gas = g < NATIVE_DONOR.gasMin ? NATIVE_DONOR.gasMin : g > NATIVE_DONOR.gasMax ? NATIVE_DONOR.gasMax : g;
      try {
        await stepCheck(job);
        job.state = 'signing';
        const h = await nd.send(w.id, d, { to: q.deposit.to as `0x${string}`, data: q.deposit.data as `0x${string}`, value: q.amountIn }, gas);
        job.hashes.push(h); job.state = 'relaying'; job.at = deps.now();
      } catch (x) {
        if (failOf(job, x) === 'deferred') return null;
        // bytes that may be out there are followed through Relay's request (its own chain's receipt is not this frame's)
        if (job.state === 'sent') { job.state = 'relaying'; job.at = deps.now(); }
        emit(w, id, 'cold', job.state === 'failed' ? 'failed' : 'active', { chain: c, from: d, src: 'w', error: job.error });
      }
      return job;
    }));
    const got = sent.filter((j): j is FloatJob => !!j);
    return got.length ? got : null;
  }

  // ── the tick: reconcile → read → plan → run what starts here ──
  const debounce = new Map<string, Promise<unknown>>();
  function reconcile(w: FloatWallet, c: FloatChain) {
    const jobs = loadJobs(w, c);
    return (async () => {
      // every open job's lookup at once (2026-10-28: one after another, each a status read of both Solana roads, in front of a
      // waiting click); each lookup touches only its own job
      await Promise.all(jobs.filter(isOpen).map(async (j) => {
        try { if (j.state === 'sent') await followSame(j); else if (j.state === 'relaying' || (j.state === 'unknown' && j.bridge)) await followBridge(w, j); } catch { /* next tick */ }
        j.updatedAt = deps.now();
        if (!isOpen(j)) emit(w, j.id, j.kind, j.state === 'arrived' ? 'done' : 'failed', { chain: j.chain, ...(j.error ? { error: j.error } : {}) });
      }));
      saveJobs(w, c, jobs);
      return jobs;
    })();
  }
  const anyOffOrder = (w: FloatWallet) => FLOAT_CHAIN_KEYS.some((k) => readOrder(w, 'off', k));
  const moveView = (j: FloatJob) => ({ kind: j.kind, chain: j.chain, usd: Number(j.usd6) / 1e6, fee: Number(j.fee6) / 1e6, runsOn: j.chain, confirmed: j.confirmed });

  /**
   * The switch-on conversion of this frame's chain (the order configure wrote after the dialog): ONE sweep W → R of the
   * native above what stays (keepOf: the trading target + the gas floor), re-sized at run time and never above the amount
   * the dialog stated. Exempt from the day / fee caps and from the quiet rule; it still waits for a running trade (the
   * tick's click check and stepCheck before W signs), still uses the oracle price check with maxSlipBps, and still waits
   * while something lands on this chain or a sweep of this chain is open.
   */
  async function runConvert(w: FloatWallet, c: FloatChain, perm: Permission, s: Snap, jobs: FloatJob[]): Promise<{ jobId: string | null; state: string; move?: ReturnType<typeof moveView> }> {
    const order = readOrder(w, 'on', c)!; const now = deps.now(); const cfg = cfgOf(c);
    if (order.grantedAt !== perm.grantedAt) { delOrder(w, 'on', c); return { jobId: null, state: 'dropped' }; }
    const x = stateOf(s, c, true, false);
    if (x.inFlight6 > 0n || jobs.some((j) => isOpen(j) && j.chain === c && (j.kind === 'sweep' || j.kind === 'topup'))) return { jobId: null, state: 'waiting' };
    const p = planConvert({ [c]: x }, [c], perm.caps, now);
    if (!p.lines.length) {
      if (p.skips[0]?.why === 'below-min') { delOrder(w, 'on', c); return { jobId: null, state: 'nothing' }; }
      return { jobId: null, state: 'waiting' };   // no fresh price: the next tick tries again
    }
    const nativeIn = p.lines[0].nativeIn < big(order.max) ? p.lines[0].nativeIn : big(order.max);
    const u = nativeToUsd6(nativeIn, x.price6, cfg.nativeDecimals);
    if (u < RULES.sameChainMin6) { delOrder(w, 'on', c); return { jobId: null, state: 'nothing' }; }
    const id = jobIdOf(w.id, 'sweep', c, undefined, now);
    if (!canRun(jobs.find((j) => j.id === id), now)) return { jobId: null, state: 'waiting' };
    const job: FloatJob = { id, walletId: w.id, kind: 'sweep', chain: c, usd6: String(u), fee6: String(moveFee6(c, 'sweep', s.fee || null, now)), state: 'planned', at: now, updatedAt: now, hashes: [], reason: 'switch on', confirmed: 'on', amountIn: String(nativeIn) };
    emit(w, id, 'sweep', 'active', { chain: c, usd: Number(u) / 1e6, confirmed: 'on', amount: fmtNative(nativeIn, cfg.nativeDecimals, cfg.native) });
    let out: 'started' | 'deferred' | 'unknown' | 'failed' = 'started';
    try { await runSame(w, job, perm.caps.maxSlipBps, s); } catch (e) { out = failOf(job, e); }
    if (out === 'deferred') return { jobId: null, state: 'deferred', move: moveView(job) };
    job.updatedAt = deps.now();
    saveJobs(w, c, [...jobs.filter((j) => j.id !== id), job]);
    if (out === 'failed') {
      const tries = (Number(order.tries) || 0) + 1;
      if (tries >= CONVERT_TRIES) delOrder(w, 'on', c); else saveOrder(w, { ...order, tries });
      emit(w, id, 'sweep', 'failed', { chain: c, confirmed: 'on', error: job.error, ...(tries >= CONVERT_TRIES ? { gaveUp: true } : {}) });
    } else delOrder(w, 'on', c);   // sent (or unknown with its hash): followed, never sent twice
    return { jobId: id, state: job.state, move: moveView(job) };
  }

  /**
   * The switch-off conversion of this frame's chain (the order `off` wrote after its dialog): R's stable → W's native,
   * the existing top-up (exact approval, router simulated from R, oracle price check), never above the stated amount, and
   * exempt from the float caps (confirmed). R's own gas native is left alone; when R has none, W first sends R its gas
   * (the allowed W → R 'gas' move) and it lands before R signs. A refusal ends this chain's order (reported, never retried
   * behind the user's back: turning off again retries); an unknown send is followed by hash, never re-sent.
   */
  async function runBack(w: FloatWallet, c: FloatChain, slipBps: number): Promise<BackResult> {
    const r = await deps.lock(lockKey(w, c), async (): Promise<BackResult> => {
      const order = readOrder(w, 'off', c); if (!order) return { chain: c, state: 'nothing', usd: 0 };
      let jobs = await reconcile(w, c);
      let s = await readChain(w, c); const cfg = cfgOf(c); const now = deps.now();
      const reserve = big(s.reserve); const stableIn = reserve < big(order.max) ? reserve : big(order.max);
      const u = stableToUsd6(stableIn, cfg.stable.decimals);
      if (u < CONVERT_BACK_MIN6) { delOrder(w, 'off', c); return { chain: c, state: 'nothing', usd: Number(u) / 1e6 }; }
      const kept = (why: string): BackResult => { delOrder(w, 'off', c); emit(w, null, 'off', 'failed', { chain: c, error: why }); return { chain: c, state: 'kept', usd: Number(u) / 1e6, why }; };
      if (priceState(s.priceAt, now) !== 'fresh' || !(big(s.price6) > 0n)) return kept('No fresh price on this chain');
      const save = (j: FloatJob) => { j.updatedAt = deps.now(); jobs = [...jobs.filter((x) => x.id !== j.id), j]; saveJobs(w, c, jobs); };
      // R's own gas first (left alone afterwards: it stays in R)
      // (release 9, a tester's 99.74 USDC on BNB with no BNB anywhere: "has none to spare") a reserve with dollars but no gas asks
      // motion's gas drop first, exactly as a click's top-up does (askGas: ≤ 5 s, once a day per reserve); only then W's spare native
      if (big(s.reserveNative) < cfg.reserveGas / 2n && await askGas(w, c, cfgOf(c).kind === 'evm' ? () => deps.evm!.balance(w.r.evm) : () => deps.sol!.balance(w.r.sol))) s = await readChain(w, c);
      if (big(s.reserveNative) < cfg.reserveGas / 2n) {
        const want = cfg.reserveGas - big(s.reserveNative);
        if (big(s.float) - cfg.gasFloor < want) return kept(`The reserve has no ${cfg.native} for its own fee, and this wallet has none to spare`);
        const g: FloatJob = { id: jobIdOf(w.id, 'gas', c, undefined, now), walletId: w.id, kind: 'gas', chain: c, usd6: String(nativeToUsd6Up(want, big(s.price6), cfg.nativeDecimals)), fee6: String(moveFee6(c, 'gas', s.fee || null, now)), state: 'planned', at: now, updatedAt: now, hashes: [], reason: 'switch off: reserve gas', confirmed: 'off' };
        try { await runSame(w, g, slipBps, s); } catch (e) { const o = failOf(g, e); if (o === 'deferred') return { chain: c, state: 'pending', usd: Number(u) / 1e6, why: 'a trade is running' }; save(g); return kept(g.error || 'The reserve gas was not sent'); }
        save(g);
        const landed = await gasLanded(c, g.hashes[g.hashes.length - 1]);
        if (!landed) return kept('The reserve gas did not land in time');
        g.state = 'arrived'; save(g);
      }
      const job: FloatJob = { id: jobIdOf(w.id, 'topup', c, undefined, now), walletId: w.id, kind: 'topup', chain: c, usd6: String(u), fee6: String(moveFee6(c, 'topup', s.fee || null, now)), state: 'planned', at: now, updatedAt: now, hashes: [], reason: 'switch off', confirmed: 'off', amountIn: String(stableIn) };
      emit(w, job.id, 'topup', 'active', { chain: c, usd: Number(u) / 1e6, confirmed: 'off' });
      try { await runSame(w, job, slipBps, s); } catch (e) {
        const o = failOf(job, e);
        if (o === 'deferred') return { chain: c, state: 'pending', usd: Number(u) / 1e6, why: 'a trade is running' };
        save(job);
        if (o === 'unknown') { delOrder(w, 'off', c); return { chain: c, state: 'unknown', usd: Number(u) / 1e6, jobId: job.id, why: job.error }; }
        return kept(job.error || 'The swap was refused');
      }
      save(job); delOrder(w, 'off', c);
      return { chain: c, state: 'sent', usd: Number(u) / 1e6, jobId: job.id };
    });
    return r || { chain: c, state: 'pending', usd: 0, why: 'another tab is converting it' };
  }
  // W → R gas: wait (≤ 30 s) until it is on chain before R signs anything that spends it. A waiting click looks every 300 ms
  // (a Solana slot is ~400 ms; 2026-10-28: looking once a second cost a click up to a second after the gas had landed)
  async function gasLanded(c: FloatChain, h: string | undefined, click = false): Promise<boolean> {
    if (!h) return false;
    if (cfgOf(c).kind === 'evm') { const r = await deps.evm!.receipt(h as `0x${string}`, 30_000).catch(() => null); return r?.status === 'success'; }
    const every = click ? 300 : 1_000, looks = click ? 100 : 30;
    for (let i = 0; i < looks; i++) { const st = await deps.sol!.status(h).catch(() => null); if (st === 'confirmed') return true; if (st === 'failed') return false; await deps.wait(every); }
    return false;
  }
  // R holds dollars ($2+) but too little native for its own moves — on EVM under half its gas, on Solana under SOL_GAS.enough
  // (2026-10-27: a Solana reserve under ~0.0009 SOL could not pay fees or donate) — and W's float there cannot spare R's gas
  // (`float` 0 = W is not this frame's to use): only motion's gas drop gets it moving
  const needsGas = (k: FloatChain, reserveNative: bigint, reserveStable: bigint, float: bigint): boolean => {
    const cfg = cfgOf(k);
    if (reserveNative >= (cfg.kind === 'sol' ? SOL_GAS.enough : cfg.reserveGas / 2n) || stableToUsd6(reserveStable, cfg.stable.decimals) < 2n * USD) return false;
    return float - cfg.gasFloor / 4n <= cfg.reserveGas - reserveNative;
  };
  // motion's solver drops a little native into R (about $0.2 on EVM, 0.003 SOL on Solana, once a day per reserve and chain);
  // waits up to 5 s for it to land. False when there is no solver, it refuses, or nothing arrives: the plan then goes on as before
  // `landedIsAll` (the direct buy's ask): once the drop has landed (the balance rose) and it is still short, nothing more is coming
  async function askGas(w: FloatWallet, k: FloatChain, native: () => Promise<bigint>, address: string = cfgOf(k).kind === 'sol' ? w.r.sol : w.r.evm, enough: bigint = cfgOf(k).kind === 'sol' ? SOL_GAS.enough : cfgOf(k).reserveGas / 2n, landedIsAll = false): Promise<boolean> {
    if (!solver) return false;
    try {
      // the balance before the drop, read beside the ask (a drop is never confirmed before the solver has answered)
      const [before, r] = await Promise.all([landedIsAll ? native().catch(() => null) : Promise.resolve(null), withTimeout(solver.gas(k as BridgeChain, address), 4_000)]);
      if (cfgOf(k).kind === 'sol') deps.store.set(GASASK + 'sol.' + address, JSON.stringify({ at: deps.now(), ok: true }));
      if (r.state === 'has-gas') return true;
      const until = deps.now() + 5_000;   // ≤ 5 s, looked at every 250 ms (was 500 ms)
      for (let i = 0; i < 20 && deps.now() < until; i++) {
        await deps.wait(250); const n = await native().catch(() => 0n);
        if (n >= enough) return true;
        if (before != null && n > before) return false;
      }
    } catch { /* refused or slow: as before */ }
    return false;
  }
  // the same for a background tick on Solana, never waited for: a reserve with dollars and no SOL is asked a drop once (a day
  // once it was sent; 10 minutes after a refusal or a lost answer) and this tick goes on as before — the next one has gas
  function askSolGasSoon(w: FloatWallet): void { askGasSoon(w, 'sol'); }
  function askGasSoon(w: FloatWallet, c: FloatChain): void {
    if (!solver) return;
    const address = cfgOf(c).kind === 'sol' ? w.r.sol : w.r.evm;
    const key = GASASK + c + '.' + address;
    let prev: { at: number; ok: boolean | null } | null = null;
    try { prev = JSON.parse(deps.store.get(key) || 'null'); } catch { prev = null; }
    if (prev && Number.isFinite(prev.at) && deps.now() - prev.at < (prev.ok === true ? 86_400_000 : 600_000)) return;
    deps.store.set(key, JSON.stringify({ at: deps.now(), ok: null }));
    withTimeout(solver.gas(c as BridgeChain, address), 4_000)
      .then(() => deps.store.set(key, JSON.stringify({ at: deps.now(), ok: true })))
      .catch(() => deps.store.set(key, JSON.stringify({ at: deps.now(), ok: false })));
  }
  // USDG / USDC sent straight to the trading wallet (2026-10-27 feedback: the deposit dialog said it "is not used for buys")
  // joins the USD balance: W sends it to its own R in ONE plain ERC-20 transfer — whenever W may send (the quiet rule), or
  // right away for a waiting click, which then waits for it to land. W without the gas for it gets motion's gas drop first.
  // True when the transfer landed (the caller reads the chain again).
  async function forwardStable(w: FloatWallet, c: FloatChain, s: Snap, urgent: boolean, need6?: bigint): Promise<boolean> {
    const cfg = cfgOf(c); if (cfg.kind === 'sol') return forwardSol(w, s, urgent, need6);
    if (cfg.kind !== 'evm' || !deps.evm) return false;
    const amount = big(s.wStable ?? '0');
    if (stableToUsd6(amount, cfg.stable.decimals) < USD) return false;
    if (!urgent && (!quietOn(c) || clickBusy())) return false;
    // a click R alone already covers with its 25 % margin is never held up by the forward (one confirmation, up to 8 s, plus a
    // gas drop when W has none): it waits for the next quiet tick, as on Solana (forwardSol)
    if (urgent && need6 != null && stableToUsd6(big(s.reserve), cfg.stable.decimals) * 100n >= need6 * RULES.clickMarginPct) return false;
    const e = deps.evm; const gas = 90_000n;
    const price = big(s.fee?.evm?.gasPrice ?? '0'); const cost = gas * (price > 0n ? price : 1_000_000_000n) * 2n;
    if (big(s.float) < cost && !(await askGas(w, c, () => e.balance(w.w.evm), w.w.evm, cost))) return false;
    try {
      await stepCheck(urgent ? ({ click: true } as FloatJob) : undefined);
      const h = await e.sendW(w.id, { to: cfg.stable.address as `0x${string}`, data: erc20TransferData(w.r.evm, amount) as `0x${string}`, value: 0n }, gas);
      emit(w, null, 'deposit', 'active', { chain: c, usd: Number(stableToUsd6(amount, cfg.stable.decimals)) / 1e6 });
      const r = await e.receipt(h, urgent ? 8_000 : 30_000);
      emit(w, null, 'deposit', r?.status === 'success' ? 'done' : 'active', { chain: c });
      return r?.status === 'success';
    } catch { return false; }
  }
  // The same on Solana (2026-10-27: it worked on EVM only). W's USDC of the pinned mint goes to its own R in ONE transferChecked
  // (R's token account created if missing, idempotent) — whenever W may send (the quiet rule), or for a waiting click whose
  // chain reserve alone cannot cover its need + 25 % (a click R can serve already is never held up by it). The fee: W pays it
  // if it stays rent-exempt; else R first pays W exactly what W lacks (R → W lamports only, ≤ SOL_FWD.fundMax); else nothing
  // moves. Whatever is sent is remembered (FWD) and followed: no second send while it may still land (any tab), a forward that
  // landed and failed waits SOL_FWD.retryMs, one whose blockhash is dead is forgotten. Repeated or partial deposits: every tick
  // forwards what W holds then ($1 or more); less stays until more arrives. True when a forward landed (the caller reads again).
  async function forwardSol(w: FloatWallet, s: Snap, urgent: boolean, need6?: bigint): Promise<boolean> {
    const sl = deps.sol; if (!sl?.forward) return false;
    const key = FWD + 'sol.' + lc(w.w.evm);
    const read = (): { sig: string; at: number; failedAt?: number } | null => { try { const v = JSON.parse(deps.store.get(key) || 'null'); return v && typeof v.sig === 'string' && Number.isFinite(v.at) ? v : null; } catch { return null; } };
    const remember = (sig: string) => deps.store.set(key, JSON.stringify({ sig, at: deps.now() }));
    const failed = (sig: string) => deps.store.set(key, JSON.stringify({ sig, at: deps.now(), failedAt: deps.now() }));
    const prev = read();
    if (prev) {
      if (prev.failedAt) { if (deps.now() - prev.failedAt < SOL_FWD.retryMs) return false; deps.store.del(key); }
      else {
        const st = await sl.status(prev.sig).catch(() => null);
        if (st === 'confirmed') { deps.store.del(key); return true; }          // it landed since: read again, the rest goes next tick
        if (st === 'failed') { failed(prev.sig); return false; }
        if (deps.now() - prev.at < SOL_FWD.settleMs) return false;              // may still land: never a second send
        deps.store.del(key);                                                     // its blockhash is dead: it can no longer land
      }
    }
    const cfg = FLOAT_CFG.sol; const amount = big(s.wStable ?? '0');
    if (stableToUsd6(amount, cfg.stable.decimals) < USD) return false;
    if (!urgent && (!quietOn('sol') || clickBusy())) return false;
    if (urgent && need6 != null && stableToUsd6(big(s.reserve), cfg.stable.decimals) * 100n >= need6 * RULES.clickMarginPct) return false;
    const plan = solForwardPlan({ wLamports: big(s.float), rLamports: big(s.reserveNative), rStable: big(s.reserve) });
    if (plan.pay === 'none') return false;
    if (plan.pay === 'r' && !sl.fundW) return false;
    const job = urgent ? ({ click: true } as FloatJob) : undefined;
    // null = not settled within `tries` looks (still followed through FWD)
    const settled = async (sig: string, tries: number): Promise<boolean | null> => {
      for (let i = 0; i < tries; i++) { const st = await sl.status(sig).catch(() => null); if (st === 'confirmed') return true; if (st === 'failed') return false; await deps.wait(1_000); }
      return null;
    };
    // a click waits ≤ 8 s per step; a background tick ≤ 20 s per step, so funding + forward stay inside the 45 s cross-tab lock
    const tries = urgent ? 8 : 20;
    try {
      if (plan.pay === 'r') {
        await stepCheck(job);
        const f = await sl.fundW!(w.id, plan.lamports); remember(f);
        const ok = await settled(f, tries);
        if (ok !== true) { if (ok === false) failed(f); return false; }
        deps.store.del(key);
      }
      await stepCheck(job);
      emit(w, null, 'deposit', 'active', { chain: 'sol', usd: Number(stableToUsd6(amount, cfg.stable.decimals)) / 1e6 });
      const sig = await sl.forward(w.id, amount); remember(sig);
      const ok = await settled(sig, tries);
      if (ok === true) deps.store.del(key); else if (ok === false) failed(sig);
      emit(w, null, 'deposit', ok === true ? 'done' : 'active', { chain: 'sol' });
      return ok === true;
    } catch (x) {
      // an unknown send (every road went silent) carries its signature: followed like a sent one, never re-sent blind
      const h = (x as { hash?: string })?.hash; if (typeof h === 'string' && h) remember(h);
      return false;
    }
  }
  // USDG / USDC sent straight to W on ANOTHER EVM chain of the permission (2026-11-01): a quiet background tick of any frame
  // (the phone's too) looks at each such chain at most once per FWDX_MS (W's stable + native there, two reads on that chain's
  // own nodes) and has W send what it holds there ($1 or more) to its own R there in one transfer, under that chain's own
  // cross-tab lock (its frame, if open, is not forwarding the same dollars). W without the gas for it gets motion's gas drop
  // first. R there is then a donor of any chain's click (motion's bridge). Never in a click window, never for a click
  async function forwardElsewhere(w: FloatWallet, c: FloatChain, perm: Permission): Promise<void> {
    const wf = deps.wForward, ro = deps.solver?.reserveOn, nd = deps.nativeDonor;
    if (!wf || !ro || !nd) return;
    for (const k of perm.chains) {
      if (k === c || cfgOf(k).kind !== 'evm') continue;
      if (!quietOn(c) || clickBusy()) return;
      const key = FWDX + k + '.' + lc(w.w.evm);
      let prev: { at: number; hash?: string } | null = null;
      try { const v = JSON.parse(deps.store.get(key) || 'null'); prev = v && Number.isFinite(v.at) ? v : null; } catch { prev = null; }
      if (prev?.hash) {
        const st = nd.receipt ? await nd.receipt(k, prev.hash as `0x${string}`).catch(() => null) : null;
        if (st == null && deps.now() - prev.at < FWDX_SETTLE_MS) continue;   // may still land: never a second send
        deps.store.set(key, JSON.stringify({ at: prev.at }));
        if (st === 'success') emit(w, null, 'deposit', 'done', { chain: k });
      }
      if (prev && deps.now() - prev.at < FWDX_MS) continue;
      const cfg = cfgOf(k) as EvmFloatCfg;
      await deps.lock(lockKey(w, k), async () => {
        deps.store.set(key, JSON.stringify({ at: deps.now() }));   // the reads are paced too, sent or not
        try {
          const [{ stable }, { native, gasPrice }] = await Promise.all([ro(k, cfg.stable.address as `0x${string}`, w.w.evm as `0x${string}`), nd.read(k, w.w.evm as `0x${string}`)]);
          const usd = stableToUsd6(stable, cfg.stable.decimals);
          if (usd < USD) return true;
          const cost = 90_000n * (gasPrice > 0n ? gasPrice : 1_000_000_000n) * 2n;
          if (native < cost && !(await askGas(w, k, async () => (await nd.read(k, w.w.evm as `0x${string}`)).native, w.w.evm, cost))) return true;
          if (!quietOn(c) || clickBusy()) return true;
          emit(w, null, 'deposit', 'active', { chain: k, usd: Number(usd) / 1e6 });
          const h = await wf.send(w.id, k, stable);
          deps.store.set(key, JSON.stringify({ at: deps.now(), hash: h }));
        } catch (x) {
          // an unknown send (its answer lost) carries its hash: followed like a sent one, never re-sent blind
          const h = (x as { hash?: string })?.hash; if (typeof h === 'string' && h) deps.store.set(key, JSON.stringify({ at: deps.now(), hash: h }));
        }
        return true;
      }, { waitMs: 0 });
    }
  }
  async function tick(w: FloatWallet, reason: string, urgent?: { chain: FloatChain; usd6: bigint }) {
    const c = here(); if (!c) return { ok: true, jobId: null, planned: [], note: 'no USD balance on this lane' };
    // the after-trade refill (REFILL, afterTrade): fast path, held back only by a trade being signed
    const refill = !urgent && reason === 'refill';
    lastTick.set(w.id, deps.now());
    let perm = perms(w); let live = permissionLive(perm, deps.now());
    // a switch-off the user confirmed (in any frame) whose conversion starts on this chain: run it, whatever the permission
    if (readOrder(w, 'off', c)) {
      if (clickBusy()) return { ok: true, jobId: null, planned: [], deferred: 'click' };
      const back = await fastly(() => runBack(w, c, perm?.caps.maxSlipBps ?? DEFAULT_CAPS.maxSlipBps));
      return { ok: true, jobId: back.jobId ?? null, planned: [], back, reason };
    }
    // the account's switch is on and this wallet is new to it: it joins (its own permission from the grant, no dialog)
    let joined = false;
    if (!live && !anyOffOrder(w)) { const j = join(w); if (j) { perm = j; live = true; joined = true; } }
    if (!live || !perm) {
      // Earn: with the USD balance off nothing goes in; what is still in the vault comes out (the switch-off's exit), in the
      // background, under this wallet's lock, quiet only
      // (review M6: what came out is read into R's snapshot at once — the card's convert-back offer then shows it, never out of view)
      if (deps.earn && c && deps.earn.wants(w) && !urgent && !clickBusy() && quietOn(c)) {
        const er = await deps.lock(lockKey(w, c), () => deps.earn!.tick(w, { sizes6: [], floatOn: false, yieldNow: () => clickBusy() })).catch(() => null) as Record<string, unknown> | null;
        if (er && er.step === 'withdraw') await readChain(w, c).catch(() => null);
      }
      // off: nothing new is planned, but what was already sent is still followed to its end
      if (!loadJobs(w, c).some(isOpen) || clickBusy()) return { ok: true, jobId: null, planned: [], note: 'off' };
      await deps.lock(lockKey(w, c), () => reconcile(w, c));
      return { ok: true, jobId: null, planned: [], note: 'off' };
    }
    if (!perm.chains.includes(c)) return { ok: true, jobId: null, planned: [], note: 'this chain is not part of the permission' };
    if ((refill ? tradeLive() : clickBusy()) && !(urgent && urgent.chain === c)) return { ok: true, jobId: null, planned: [], deferred: 'click' };
    // a waiting click preempts (owner 2026-10-27: 'another tab is running the USD balance', the buy went without its top-up):
    // it marks this wallet x chain in the vault origin's storage, which every tab shares; a background tick checks the mark
    // between its steps and lets the lock go. If the lock is still not free after 2 s the click's top-up runs anyway: every
    // move is between this wallet's own W and R, so the worst case is a second top-up the next sweep returns
    const wantKey = CLICK_WANT + lockKey(w, c);
    const clickWants = () => { if (urgent) return false; const t = Number(deps.store.get(wantKey) || 0); return t > 0 && deps.now() - t < 20_000; };
    const yieldNote = { ok: true, jobId: null, planned: [], deferred: 'click' };
    if (urgent) deps.store.set(wantKey, String(deps.now()));
    const body = async () => {
      if (clickWants()) return yieldNote;
      // a waiting click reads on the fast path too (no bucket): its top-up must land inside the 10 s hold
      const jobs = await (urgent || refill ? fastly(() => reconcile(w, c)) : reconcile(w, c));
      // a switch-off is converting on another chain: no new move anywhere until it is done
      // a switch-off converting on another chain holds back routine moves — never a waiting click's top-up (owner 2026-10-27)
      if (anyOffOrder(w) && !urgent) return { ok: true, jobId: null, planned: [], note: 'turning off' };
      if (clickWants()) return yieldNote;
      let s = await (urgent || refill ? fastly(() => readChain(w, c)) : readChain(w, c));
      // a click whose chain reserve holds dollars but no gas, with nothing W can spare: motion drops it a little native first
      // (2026-10-27: "the USD balance doesn't let you buy unless you have some of the native token of that chain"; the same on
      // Solana since the owner's "do it too")
      if (urgent && needsGas(c, big(s.reserveNative), big(s.reserve), big(s.float))) {
        const rNative = cfgOf(c).kind === 'evm' ? () => deps.evm!.balance(w.r.evm) : () => deps.sol!.balance(w.r.sol);
        if (await askGas(w, c, () => fastly(rNative))) s = await fastly(() => readChain(w, c));
      }
      // a background tick on Solana with such a reserve asks for the drop without waiting for it (the next tick has gas)
      else if (!urgent && cfgOf(c).kind === 'sol' && quietOn(c) && !clickBusy() && needsGas(c, big(s.reserveNative), big(s.reserve), big(s.float))) askSolGasSoon(w);
      // (usd-mode2) an EVM reserve with dollars and under half its gas: motion's drop, asked in the background (never waited for),
      // instead of a W -> R gas send — whatever W holds (gasFromWClickOnly). Once a day once sent, 10 minutes after a refusal
      else if (!urgent && cfgOf(c).kind === 'evm' && deps.gasFromW !== true && quietOn(c) && !clickBusy() && big(s.reserveNative) < cfgOf(c).reserveGas / 2n && stableToUsd6(big(s.reserve), cfgOf(c).stable.decimals) >= 2n * USD) askGasSoon(w, c);
      // the standing allowances of the buy from the reserve (EVM): one approval per tick, background only
      if (!urgent && !refill && !clickBusy()) await directAllowance(w, c, s).catch(() => false);
      // stable sent straight to W joins R first (forwardStable)
      if (await (urgent ? fastly(() => forwardStable(w, c, s, true, urgent.usd6)) : forwardStable(w, c, s, false))) s = await (urgent ? fastly(() => readChain(w, c)) : readChain(w, c));
      // Earn (src/earnEngine.ts): a waiting click whose top-up R's liquid part and W cannot pay takes the missing part out of
      // the vault first (one withdraw from R to R, simulated and checked), then plans as before. beforeClick returns null at
      // once — no read, no await on the network — when nothing of this wallet is in Earn or the liquid part covers the click
      let earnClick: Record<string, unknown> | null = null;
      const earnAsk = urgent && deps.earn && urgent.chain === c ? { need6: urgent.usd6, liquidRaw: big(s.reserve), wReady6: clickUsd6(c, big(s.float), big(s.price6)) + big(s.inFlight6) } : null;
      if (urgent && deps.earn && urgent.chain === c && !clickWants() && earnAsk && deps.earn.clickNeeds(w, earnAsk)) {
        // review M3: inside fastly (the click path's reads and R's send skip the background bucket); no re-read in Earn — R is read here
        const e = await fastly(() => deps.earn!.beforeClick(w, earnAsk)).catch((x) => ({ why: 'Earn: ' + String((x as Error)?.message || x).slice(0, 120) }));
        if (e) { earnClick = e; if ('usd' in e && e.usd > 0) s = await fastly(() => readChain(w, c)); }
      }
      // ... and stable sent straight to W on another EVM chain joins R there (background only, paced per chain)
      if (!urgent && !refill && !clickBusy()) await forwardElsewhere(w, c, perm).catch(() => {});
      // the switch-on conversion of this chain runs before any plan (and the plan waits for it) — except for a waiting
      // click's own top-up, which always comes first
      if (clickWants()) return yieldNote;
      if (!urgent && readOrder(w, 'on', c)) {
        const conv = await fastly(() => runConvert(w, c, perm, s, jobs));
        return { ok: true, jobId: conv.jobId, planned: conv.move ? [conv.move] : [], converting: conv.state, reason };
      }
      // a waiting click sees the other reserves as they are now: an EVM reserve whose snapshot is over a minute old (or missing)
      // is read from that chain's own nodes here (stable + gas, 2.5 s at most); any other chain's last snapshot at any age.
      // Only when they matter (2026-10-28): a click this chain's own reserve covers plans no move from another reserve, so it
      // reads none of them (they were read on every click, up to 2.5 s in front of the top-up) — see `plan` below
      const donorSnaps: Partial<Record<FloatChain, Snap>> = {};
      const readDonors = async () => {
        await Promise.all(FLOAT_CHAIN_KEYS.filter((k) => k !== c && perm.chains.includes(k) && cfgOf(k).kind === 'evm').map(async (k) => {
          const old = readSnapShown(w, k);
          const cfg = cfgOf(k) as EvmFloatCfg;
          const read = () => Promise.race([deps.solver!.reserveOn!(k, cfg.stable.address as `0x${string}`, w.r.evm), new Promise<never>((_, no) => setTimeout(() => no(new Error('slow')), 2_500))]);
          try {
            let now = old && deps.now() - old.at < 60_000 ? { stable: big(old.reserve), native: big(old.reserveNative) } : await read();
            // a donor with dollars but no gas for its one transfer: motion drops it a little native, then it is read again
            if (needsGas(k, now.native, now.stable, 0n) && await askGas(w, k, async () => (await read()).native)) now = await read();
            if (old && deps.now() - old.at < 60_000 && big(old.reserveNative) === now.native) return;
            donorSnaps[k] = { ...(old || { at: deps.now(), chain: k, price6: '0', priceAt: 0, float: '0', inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }), reserve: String(now.stable), reserveNative: String(now.native) } as Snap;
          } catch { /* the last snapshot, if any */ }
        }));
      };
      // READY (A1): a routine background tick (never a click's, never the after-trade refill) may pre-position the reserves of the
      // chains the user traded in the last 7 days, from the EVM reserves (a public bridge signs from those only), within the day's
      // fee budget. Per chain: traded = a buy there in the last 7 days; readyOk = its snapshot is under READY.snapMs old, newer
      // than every cross-chain move into it that is over (arrived / refunded), and nothing cross-chain into it is open
      const readyIn = !urgent && !refill ? { feesDay6: readyFeesOf(allJobs(w), deps.now()).day6, from: perm.chains.filter((k) => cfgOf(k).kind === 'evm') } : null;
      // (usd-mode 2026-11-05) `traded` on every tick, not only a READY one: a cross-chain rebalance goes only into a chain the user
      // bought on in the last 7 days (floatCore crossNeedsTrade); readyOk stays READY's own
      const tradedOf = (k: FloatChain): { traded?: boolean } => (deps.now() - Math.max(0, ...prefsOf(w, k).buysAt.filter((t) => Number.isFinite(t))) < READY.tradedMs ? { traded: true } : {});
      const readyOf = (k: FloatChain, sn: Snap): { traded?: boolean; readyOk?: boolean } => {
        const tradedAt = Math.max(0, ...prefsOf(w, k).buysAt.filter((t) => Number.isFinite(t)));
        if (!(deps.now() - tradedAt < READY.tradedMs)) return {};
        const into = allJobs(w).filter((j) => j.chain === k && (j.kind === 'rebalance' || j.kind === 'cold') && j.state !== 'planned' && !(j.state === 'failed' && !j.hashes.length));
        const ok = deps.now() - sn.at < READY.snapMs && !into.some(isOpen) && into.every((j) => sn.at > j.updatedAt);
        return { traded: true, ...(ok ? { readyOk: true } : {}) };
      };
      // PROPOSAL TC-1 (2026-11-04, B:/tmp/usd-scenarios): what the wallet's own native on the other EVM chains could bring this click
      // through Relay — read LIVE (the same reads nativeDonorRun makes, side by side, 2.5 s at most) and only for a click the
      // reserves alone cannot pay (below); nativeDonorRun's own spare / cap rules, at most its per-buy cap. A click those and the
      // reserves pay TOGETHER is then not called infeasible
      let urgentExtra6 = 0n, signSol = false;
      let extraReads: Map<FloatChain, Promise<{ native: bigint; price6: bigint; gasPrice: bigint }>> | undefined, extraAt = 0;
      const readExtra = async (): Promise<bigint> => {
        const nd = deps.nativeDonor; if (!urgent || !nd) return 0n;
        extraReads = new Map(); extraAt = deps.now();
        const got = await Promise.all(perm.chains.filter((k) => k !== c && cfgOf(k).kind === 'evm').map(async (k) => {
          const p = withTimeout(nd.read(k, w.w.evm), 2_500); p.catch(() => {}); extraReads!.set(k, p);
          try {
            const r = await p;
            const spare = nativeDonorSpare({ chain: k, float: r.native, price6: r.price6, keep6: 0n, gasCost: NATIVE_DONOR.gasMax * r.gasPrice });
            return { one: nativeToUsd6(spare, r.price6, cfgOf(k).nativeDecimals), cap: nativeDonorCap6({ from: k, spare, price6: r.price6, maxSlipBps: perm.caps.maxSlipBps }) };
          } catch { return { one: 0n, cap: 0n }; }
        }));
        // one chain alone may carry almost all its spare (Relay's fee is cents); two together each less their part's cost
        const one6 = got.reduce((m, x) => (x.one > m ? x.one : m), 0n), two6 = got.reduce((t, x) => t + x.cap, 0n);
        const e6 = one6 > two6 ? one6 : two6;
        return e6 > NATIVE_DONOR.max6 ? NATIVE_DONOR.max6 : e6;
      };
      // TC-1 is never applied while a move into this chain is still on its way or settling (review F1, B:/tmp/usd-buy-timeout): an
      // open top-up / cross-chain move into it, or one that ARRIVED under BRIDGE_SETTLE_MS ago whose payout no read here shows yet —
      // those dollars are in no read this plan is made from, so a click they pay would be called unpayable and refused. The plan of
      // before then runs (held behind that move: 'moving' + retryMs), and click.short stays silent while a move is held
      const pendingIn = !!urgent && [...jobs, ...allJobs(w)].some((j) => j.chain === c && (j.kind === 'topup' || j.kind === 'cold' || j.kind === 'rebalance')
        && (isOpen(j) || (j.state === 'arrived' && j.kind !== 'topup' && deps.now() - j.updatedAt < BRIDGE_SETTLE_MS && !payoutSeen(j, jobs, readsOf(w, c)))));
      const planFor = (over: Partial<Record<FloatChain, Snap>>, later?: FloatChain[], here: Snap = s) => {
        const snaps = Object.fromEntries(FLOAT_CHAIN_KEYS.map((k) => [k, k === c ? here : over[k] ?? donorSnaps[k] ?? (urgent ? readSnapShown(w, k) : readSnap(w, k))])) as Record<FloatChain, Snap | null>;
        const chains: Partial<Record<FloatChain, ChainState>> = {};
        // the burst (REFILL): the float holds 4 buys and the sweep waits 5 minutes after the last trade; this chain's after-trade
        // refill tops W up to its target from $1
        for (const k of perm.chains) { const sn = snaps[k]; if (!sn) continue; const burst = burstAt(w, k);
          const kept = keptNative(w, k, sn, perm.caps);
          chains[k] = { ...stateOf(sn, k, sweepAllowed({ quiet: quietOn(k), burst, lastTradeAt: deps.click().lastTradeAt, now: deps.now() }), allJobs(w).some((j) => isOpen(j) && j.chain === k && (j.kind === 'rebalance' || j.kind === 'cold') && deps.now() - j.at < 120_000)), ...(burst ? { burst } : {}), ...(refill && k === c ? { refill: true } : {}), ...(readyIn ? readyOf(k, sn) : tradedOf(k)), ...(deps.readyFloat !== true && rulesOf(perm) >= DIRECT_BUY_RULES ? { directPays: true } : {}), ...(kept > 0n ? { keep: kept } : {}) }; }
        const led = ledgerOf(allJobs(w), deps.now());
        // the wallet as the vault sees it: every chain's reserve and float (coins at mark are not known here, so the 30 % rule
        // is applied to the USD-mode holdings only — the stricter reading)
        const walletUsd6 = FLOAT_CHAIN_KEYS.reduce((t, k) => { const sn = snaps[k]; if (!sn) return t; const cfg = cfgOf(k); return t + stableToUsd6(big(sn.reserve), cfg.stable.decimals) + nativeToUsd6(big(sn.float), big(sn.price6), cfg.nativeDecimals); }, 0n);
        return planMoves({ now: deps.now(), caps: plannedCaps(perm.caps), chains, enabled: perm.chains, walletUsd6, movedToday6: led.movedToday6, feesToday6: led.feesToday6, crossNeedsTrade: deps.crossNeedsTrade !== false, ...(solver && deps.gasFromW !== true ? { gasFromWClickOnly: true } : {}),
          estFee6: (kind, chain, from) => moveFee6(from || chain, kind, (snaps[from || chain]?.fee) || null, deps.now(), 0n, kind === 'rebalance' || kind === 'cold' ? BRIDGE_FEE_EST6 : 0n), urgent,
          // TC-1: a click is planned all or nothing (floatCore planMoves urgentAtomic)
          ...(urgent && !pendingIn ? { urgentAtomic: true, urgentExtra6, urgentSign: FLOAT_CHAIN_KEYS.filter((k) => k !== urgent.chain && (k === c || (!!solver && (cfgOf(k).kind === 'evm' || (k === 'sol' && signSol))))) } : {}),
          // a click's cold top-up comes first from a reserve this frame can sign for itself (an EVM chain: motion's bridge)
          urgentFrom: urgent && solver ? FLOAT_CHAIN_KEYS.filter((k) => k !== c && cfgOf(k).kind === 'evm') : undefined,
          ...(later ? { urgentLater: later } : {}),
          // a click's cross-chain parts under motion's per-fill cap (XCHAIN; the solver's own when its health named a lower one)
          partMax6: partMaxOf(solverHealth?.max6),
          // ready dollars (READY): a routine background tick only
          ...(readyIn ? { ready: readyIn } : {}) });
      };
      let plan = planFor({});
      // the other reserves are read only when the plan from what is known leaves the click short or takes a cold top-up from
      // one of them; then the click plans again on what they hold now (exactly the old plan in that case)
      if (urgent && solver && deps.solver?.reserveOn && (plan.short?.chain === c || plan.moves.some((m) => m.kind === 'cold' && m.chain === c))) {
        await readDonors();
        if (Object.keys(donorSnaps).length) plan = planFor({});
      }
      // the Solana reserve as a donor of an EVM click (2026-10-27: "a Solana reserve cannot yet be a cross-frame bridge donor"):
      // looked at ONLY when the plan above leaves the click short or leans on that reserve — a click the EVM reserves cover
      // reads nothing more and plans exactly as before. Its snapshot is used when under a minute old, else R is read here
      // (lamports + USDC, one getMultipleAccounts, 2.5 s at most). It is signed for here only when R can pay its one
      // transfer's fee (solBridgeFeeOk), and tried after the EVM reserves unless it alone covers what they cannot
      let solHere = false, solSn: Snap | null = null, solAsked = false;
      // (2026-11-01 pass 2: also asked by the retry below, when a refused part's share would come from the Solana reserve)
      const solWanted = (p: typeof plan) => !solAsked && !!urgent && !!solver && !!deps.solver?.solReserveOn && cfgOf(c).kind === 'evm' && perm.chains.includes('sol')
        && (p.short?.chain === c || p.moves.some((m) => m.kind === 'cold' && m.chain === c && m.from === 'sol'));
      const askSol = async (): Promise<Snap | null> => {
        solAsked = true;
        const old = readSnapShown(w, 'sol');
        const solOn = deps.solver!.solReserveOn!;
        const readSol = () => Promise.race([solOn(w.r.sol), new Promise<never>((_, no) => setTimeout(() => no(new Error('slow')), 2_500))]);
        try {
          let now = old && deps.now() - old.at < 60_000 ? { stable: big(old.reserve), native: big(old.reserveNative) } : await readSol();
          solHere = solBridgeFeeOk(now.native);
          // R holds dollars but not its one transfer's fee: motion's gas drop (2026-10-27, "do it too"). Only a click the EVM
          // reserves leave short gets here, so it may wait for the drop like an EVM donor's; refused or not landed in 5 s, the
          // plan goes on as before (and the next tick finds the gas)
          if (!solHere && needsGas('sol', now.native, now.stable, 0n)
            && await askGas(w, 'sol', async () => (await readSol()).native, w.r.sol, solFwdFee(SOL_BRIDGE.units, SOL_BRIDGE.micro) + SOL_FWD.rentMin)) {
            now = await readSol(); solHere = solBridgeFeeOk(now.native);
          }
          solSn = { ...(old || { at: deps.now(), chain: 'sol', price6: '0', priceAt: 0, float: '0', inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }), reserve: String(now.stable), reserveNative: String(now.native) } as Snap;
          return solSn;
        } catch { return null; /* not read: the plan above, as before */ }
      };
      let lastOver: Partial<Record<FloatChain, Snap>> = {}, lastLater: FloatChain[] | undefined;
      if (solWanted(plan)) { const sn = await askSol(); signSol = solHere; if (sn) { lastOver = { sol: sn }; lastLater = solHere ? ['sol'] : undefined; plan = planFor(lastOver, lastLater); } }
      // TC-1: a click the reserves alone cannot pay asks the wallet's own native elsewhere (live) before it is called infeasible
      if (urgent && plan.short?.chain === c && plan.short.infeasible && deps.nativeDonor && !clickWants()) {
        urgentExtra6 = await fastly(readExtra);
        if (urgentExtra6 > 0n) plan = planFor(lastOver, lastLater);
      }
      // a waiting click's cold top-up from another EVM reserve runs right here, through motion's bridge only (its one transfer
      // is signed for that chain in this frame): no frame of the donor chain may be open (2026-10-27: 'bridging via motion' for
      // 15 s, nothing sent, the buy failed). From an EVM frame the Solana reserve too, when solHere (its one SPL transfer)
      const crossHere = (m: { kind: MoveKind; chain: FloatChain; from?: FloatChain }) => !!urgent && m.kind === 'cold' && m.chain === c && !!m.from && m.from !== c && !!solver && (cfgOf(m.from).kind === 'evm' || (m.from === 'sol' && solHere));
      const mineOf = (p: typeof plan) => p.moves.filter((m) => crossHere(m) || ((m.kind === 'rebalance' || m.kind === 'cold') ? m.from === c : m.chain === c));
      let started: string | null = null;
      const ran: FloatJob[] = [];
      // the planned moves that did NOT run here (2026-11-01): `held` = a move of that lane is still open (it is the one landing),
      // `backoff` = the same move failed under 30 s ago (its error is the click's answer). The answer flags them, so the page
      // never waits 15 s for a move that was not sent
      const notRun = new Map<Move, { why: 'held' | 'backoff'; job: FloatJob }>();
      // a click's parts that were refused for the solver's per-fill cap and planned again smaller (below): not siblings any more
      const superseded = new Set<FloatJob>();
      const runOne = async (m: Move): Promise<void> => {
        // the earlier parts of this click's top-up from the same reserve (XCHAIN, 2026-11-01 pass 2): the next part runs only once
        // every one before it FILLED; one that failed ends that reserve's parts here (the next would meet the same refusal)
        if (urgent && m.kind === 'cold') {
          const sibs = ran.filter((j) => j.click && !j.src && j.kind === 'cold' && j.chain === m.chain && j.from === m.from && !superseded.has(j));
          const bad = sibs.find((j) => j.state === 'failed'); if (bad) { notRun.set(m, { why: 'backoff', job: bad }); return; }
          // (A3) a part whose payout was broadcast is followed to its landing first (partFilled), then judged as before
          for (const j of sibs) if (j.state === 'relaying' && j.dstHash && !clickWants()) { await fastly(() => partFilled(w, j)); j.updatedAt = deps.now(); saveJobs(w, c, jobs); }
          const wait1 = sibs.find((j) => j.state !== 'arrived'); if (wait1) { notRun.set(m, { why: 'held', job: wait1 }); return; }
        }
        const { id, existing } = freeJobId(jobs, w.id, m.kind, m.chain, m.from, deps.now());
        const open = jobs.find((j) => isOpen(j) && j.kind === m.kind && j.chain === m.chain && j.from === m.from);
        if (!canRun(existing, deps.now())) { const j = open ?? existing!; notRun.set(m, { why: isOpen(j) ? 'held' : 'backoff', job: j }); return; }
        if (open) { notRun.set(m, { why: 'held', job: open }); return; }   // one open move of a kind per lane
        // a cross-chain move INTO that chain (any source, any frame) that arrived under BRIDGE_SETTLE_MS ago and was not started
        // by this run: its payout may not show in the read this plan was made from (2026-11-01, audit pass 2: only the same lane
        // was held; usd-fix2: unless a read here already showed its payout, payoutSeen). The parts of this run's own plan (two donors for one need) never hold each other
        const settling = (m.kind === 'cold' || m.kind === 'rebalance') ? [...jobs, ...allJobs(w)].find((j) => j.state === 'arrived' && (j.kind === 'cold' || j.kind === 'rebalance') && j.chain === m.chain && deps.now() - j.updatedAt < BRIDGE_SETTLE_MS && !ran.some((r) => r.id === j.id) && !(j.chain === c && payoutSeen(j, jobs, readsOf(w, c)))) : undefined;
        if (settling) { notRun.set(m, { why: 'held', job: settling }); return; }
        // a click's cross-chain move into W here records the read it was planned from (payoutSeen)
        const baseOf = urgent && m.kind === 'cold' && m.chain === c ? { base: String(s.float), baseAt: s.at } : {};
        const job: FloatJob = { id, walletId: w.id, kind: m.kind, chain: m.chain, ...(m.from ? { from: m.from } : {}), usd6: String(m.usd6), fee6: String(m.fee6), state: 'planned', at: deps.now(), updatedAt: deps.now(), ...(urgent && urgent.chain === m.chain ? { click: true } : {}), ...(refill && m.kind === 'topup' && m.chain === c ? { refill: true } : {}), ...(m.ready ? { ready: true } : {}), hashes: [], reason: m.reason, ...baseOf };
        // (TC-6) the job list is taken again AFTER the move: a lane running beside this one may have added its own job meanwhile
        let deferred = false;
        emit(w, id, m.kind, 'active', { chain: m.chain, usd: Number(m.usd6) / 1e6, ...(m.from ? { from: m.from } : {}) });
        try {
          // a waiting click's moves (hold & fire) run on the fast path: no 1 request/s bucket (owner 2026-10-27: the top-up of a
          // $5 BNB buy needed ~15 reads through the bucket and missed the 10 s window); a running trade still goes first
          const step = async () => {
            if (m.kind === 'rebalance' || m.kind === 'cold') await runBridge(w, job, perm);
            else await runSame(w, job, perm.caps.maxSlipBps, s);
            if (m.kind === 'gas' && job.state === 'sent') await gasLanded(m.chain, job.hashes[job.hashes.length - 1], !!job.click);
          };
          if (job.click || job.refill) await fastly(step); else await step();
          started = started || id;
        } catch (x) {
          // a lost answer still names its bytes (followed, never re-sent); a deferred move leaves no job behind
          const out = failOf(job, x);
          if (out === 'deferred') deferred = true;
          else emit(w, id, m.kind, job.state === 'failed' ? 'failed' : 'active', { chain: m.chain, error: job.error });
        }
        job.updatedAt = deps.now();
        const keep = jobs.filter((j) => j.id !== id);
        jobs.splice(0, jobs.length, ...keep, ...(deferred ? [] : [job]));
        saveJobs(w, c, jobs);
        ran.push(job);
      };
      // PROPOSAL TC-6 (2026-11-04, B:/tmp/usd-scenarios): a waiting click's moves that are signed on DIFFERENT chains run side by side
      // — this chain's own swap (R here) beside the cross-chain parts from each other reserve (R there, its own nonce): before, one
      // after another, so a click paid from two places waited for the first move's quote, signature and fill before the second
      // even started (~1.2–1.5 s each). Moves signed on the SAME chain (W's gas to R, then R's swap; a reserve's parts) stay in
      // order in their lane, and a reserve's next part still waits for the one before it to FILL. motion's solver allows two
      // fills of a wallet at once: with three chains a click has at most two donor lanes. A background tick: one after another.
      const runMoves = async (mine: Move[]) => {
        if (!urgent) { for (const m of mine) { if (clickWants()) break; await runOne(m); } return; }
        const lanes = new Map<FloatChain, Move[]>();
        for (const m of mine) { const k = (m.kind === 'cold' || m.kind === 'rebalance') && m.from ? m.from : m.chain; const l = lanes.get(k); if (l) l.push(m); else lanes.set(k, [m]); }
        await Promise.all([...lanes.values()].map(async (ms) => { for (const m of ms) { if (clickWants()) break; await runOne(m); } }));
      };
      await runMoves(mineOf(plan));
      // a waiting click whose cold top-up motion's bridge refused before anything was signed or broadcast (2026-10-28, the
      // MIT buy: the solver's nodes were throttled; a refusal says sent:false): the next reserve that can cover it is tried
      // at once, in the same click — once, never for a move whose transfer may be out there (hashes), never for a refund
      if (urgent) {
        const refused = ran.filter((j) => j.click && j.kind === 'cold' && j.chain === c && j.from && j.state === 'failed' && !j.hashes.length);
        // 2026-11-01 pass 2: the click's moves that did go (sent, landing, arrived) count as on their way into W, so the next plan
        // asks only for what the refused part was to bring (before, any move that went stopped the retry: a refused second part
        // left the buy short for its whole 15 s)
        const went6 = ran.filter((j) => j.click && j.chain === c && j.state !== 'failed' && j.state !== 'planned').reduce((t, j) => t + big(j.usd6), 0n);
        if (refused.length && !clickWants()) {
          // refused for the solver's per-fill cap, which its health (read for that very part) now names lower than the parts
          // were: the same reserves again in smaller parts — nothing was signed for the refused ones, so they leave the list
          const used6 = refused.reduce((t, j) => (big(j.usd6) > t ? big(j.usd6) : t), 0n);
          const capOnly = refused.every((j) => /per-fill cap/.test(j.error || '')) && partMaxOf(solverHealth?.max6) < used6;
          const over: Partial<Record<FloatChain, Snap>> = {};
          if (capOnly) { for (const j of refused) superseded.add(j); jobs.splice(0, jobs.length, ...jobs.filter((j) => !superseded.has(j))); saveJobs(w, c, jobs); }
          else for (const j of refused) { const d = j.from as FloatChain; const sn = donorSnaps[d] ?? readSnapShown(w, d); if (sn) over[d] = { ...sn, reserve: '0' }; }
          // (this chain's own reserve went into its top-up already when one ran: a cold part is planned only past what it held)
          const toppedHere = ran.some((j) => j.click && j.kind === 'topup' && j.chain === c && j.state !== 'failed' && j.state !== 'planned');
          const hereNow = went6 > 0n ? { ...s, inFlight6: String(big(s.inFlight6) + went6), ...(toppedHere ? { reserve: '0' } : {}) } : s;
          if (solSn && !over.sol) over.sol = solSn;
          let next = planFor(over, solHere ? ['sol'] : undefined, hereNow);
          // the refused share would come from the Solana reserve, not looked at yet: read it now (as the first plan would have)
          if (!over.sol && solWanted(next)) { const sn = await askSol(); if (sn) { over.sol = sn; next = planFor(over, solHere ? ['sol'] : undefined, hereNow); } }
          const again = mineOf(next).filter((m) => m.kind === 'cold' && m.chain === c && !!m.from && (capOnly || !refused.some((j) => j.from === m.from)));
          if (again.length) { plan = { ...plan, moves: [...plan.moves, ...again], skips: [...plan.skips, ...next.skips.filter((k) => !plan.skips.some((x) => x.chain === k.chain && x.why === k.why))] }; await runMoves(again); }
        }
      }
      // the trading wallet's own native on another chain (nativeDonorRun, 2026-10-30): what the click still lacks after every
      // reserve move above that was not refused. Looked at only for a click its reserves leave short; no wallet of the account
      // with anything to spare elsewhere = nothing here changes (the answer is exactly as before)
      let nativeWhy = '';
      const extra: { kind: MoveKind; chain: FloatChain; from: FloatChain; usd: number; fee: number; runsOn: FloatChain; src: 'w'; bridge: 'relay' }[] = [];
      // TC-1: a click the plan found infeasible moves nothing at all — not the wallet's own native elsewhere either
      const infeasible = !!urgent && plan.short?.chain === c && !!plan.short.infeasible;
      if (urgent && deps.nativeDonor && !clickWants() && !infeasible) {
        const started6 = ran.filter((j) => j.click && j.chain === c && j.state !== 'failed' && j.state !== 'planned' && (j.kind === 'topup' || j.kind === 'cold')).reduce((t, j) => t + big(j.usd6), 0n);
        const r = await fastly(() => nativeDonorRun(w, c, perm, s, urgent.usd6, started6, jobs, ran.map((j) => j.id), deps.now() - extraAt < 2_000 ? extraReads : undefined)).catch((x) => ({ why: String((x as Error)?.message || x).slice(0, 120) }));
        if (r && 'why' in r) nativeWhy = r.why;
        else if (r) {
          // one move, or one per chain when two chains pay the click together (2026-11-01)
          const ids = new Set(r.map((j) => j.id)); const t = deps.now();
          for (const j of r) j.updatedAt = t;
          jobs.splice(0, jobs.length, ...jobs.filter((j) => !ids.has(j.id)), ...r); saveJobs(w, c, jobs); ran.push(...r);
          for (const j of r) {
            started = started || (j.state !== 'failed' ? j.id : null);
            extra.push({ kind: 'cold', chain: c, from: j.from!, usd: Number(j.usd6) / 1e6, fee: Number(j.fee6) / 1e6, runsOn: c, src: 'w', bridge: 'relay' });
          }
        }
      }
      // Earn: one background step (the surplus over the buffer in, a buffer refill out, the user's switch-off out), only on a
      // routine tick that started no move of its own, quiet, no click waiting, no trade running (checked again before it sends)
      let earnStep: Record<string, unknown> | null = null;
      // (and never beside a float move still landing on this chain: R's dollars it pays from are R's until it lands)
      // (review M4: only when Earn wants this wallet — the switch on, an exit, a position or an open step: a user without Earn reads nothing)
      if (deps.earn && deps.earn.wants(w) && !urgent && !refill && !started && reason !== 'convert' && !clickWants() && !clickBusy() && quietOn(c) && !loadJobs(w, c).some(isOpen)) {
        const pre = prefsOf(w, c);
        earnStep = await deps.earn.tick(w, { sizes6: [...pre.presets6, ...pre.buys6.slice(-5)], floatOn: true, yieldNow: () => clickWants() || clickBusy() }).catch((x) => ({ ok: false, why: String((x as Error)?.message || x).slice(0, 120) }));
        // R's liquid part moved: this chain's snapshot is read again (the total never counts a dollar twice)
        if (earnStep && (earnStep.step === 'deposit' || earnStep.step === 'withdraw')) s = await readChain(w, c).catch(() => s);
      }
      // (E1, 2026-11-04, the owner's $540 Robinhood buy, B:/tmp/usd-buy-final) what W can pay here once every move of this click
      // lands, when the moves that DID go leave it short — TC-1 above refuses a click that could never be paid before anything
      // moves; this is what is left: a part refused on the way, a donor that brought less than the plan counted, a plan made while
      // TC-1 was off. Before, no answer carried it and the page waited its 15 s for a figure W could never reach, then "didn't
      // arrive in time — try again". The answer says it (`click.short`: what is still missing and what W can pay), so the page
      // stops at once. Never while a move of this chain is held (`held` in notRun: an earlier move that arrived but no read here
      // shows yet — the settle wait, retryMs — or a part behind an unlanded part): those dollars are on their way and not in reach6,
      // so the old wait stands (review F1). Additive: nothing moves differently; a covered click answers exactly as before
      let shortOf: { usd: number; canUsd: number } | undefined;
      if (urgent) {
        const went6 = ran.filter((j) => j.click && j.chain === c && j.state !== 'failed' && j.state !== 'planned' && (j.kind === 'topup' || j.kind === 'cold')).reduce((t, j) => t + big(j.usd6), 0n);
        const reach6 = clickUsd6(c, big(s.float), big(s.price6)) + big(s.inFlight6) + went6;
        const heldIn = [...notRun].some(([m, x]) => m.chain === c && x.why === 'held');
        if (!heldIn && reach6 < urgent.usd6 && (plan.short?.chain === c || !!nativeWhy)) shortOf = { usd: Number(urgent.usd6 - reach6) / 1e6, canUsd: Number(reach6) / 1e6 };
      }
      // what this click's top-up came to, for the page's hold & fire: moving (a move was sent or is landing), failed (every
      // move it tried was refused or failed — with why — so the page stops waiting at once), or none (nothing to move)
      const clickJobs = urgent ? ran.filter((j) => j.click && j.chain === c) : [];
      // a move of this chain that did not run because the same lane's move is still open (an earlier click's top-up, the
      // after-trade refill): that one is landing, so the click waits for it
      const tNow = deps.now();
      const heldBy = urgent ? [...notRun].filter(([m, x]) => m.chain === c && x.why === 'held' && tNow - x.job.updatedAt < CLICK_FOLLOW_MS).map(([, x]) => x.job) : [];
      const openOld = urgent ? loadJobs(w, c).filter((j) => j.click && j.chain === c && isOpen(j) && tNow - j.updatedAt < CLICK_FOLLOW_MS && !ran.some((r) => r.id === j.id)) : [];
      const heldHere = heldBy.length > 0;
      const openClick = urgent ? heldHere || openOld.length > 0 || ran.some((j) => j.click && j.chain === c && isOpen(j)) : false;
      // 2026-11-01 pass 2: what the click would wait for when nothing of its own ran. Only a cross-chain move that ARRIVED under
      // BRIDGE_SETTLE_MS ago and whose payout no read here showed yet (settling): the answer names when to ask again (retryMs),
      // so the page plans once more right after the wait instead of waiting 15 s for nothing. Only moves of EARLIER clicks still
      // open after CLICK_FOLLOW_MS (a late source, a refund on its way: up to 30 min on motion's side): the answer is at once —
      // "still settling, try again in a minute" — instead of a 15 s hang on every press (the one-open-move rule stays)
      const ranHere = clickJobs.some((j) => j.state !== 'failed' && j.state !== 'planned');
      const waitOn = [...heldBy, ...openOld.filter((j) => !heldBy.includes(j))];
      const settleOnly = urgent && !ranHere && waitOn.length > 0 && waitOn.every((j) => j.state === 'arrived');
      const retryMs = settleOnly ? Math.max(250, ...waitOn.map((j) => BRIDGE_SETTLE_MS - (tNow - j.updatedAt) + 250)) : 0;
      const staleOnly = urgent && !ranHere && waitOn.length > 0 && waitOn.every((j) => isOpen(j) && tNow - j.at > CLICK_FOLLOW_MS);
      // nothing ran and nothing is landing, but the click's move failed under 30 s ago: that failure is the answer (no wait)
      const backoff = urgent ? [...notRun].filter(([m, x]) => m.chain === c && x.why === 'backoff').map(([, x]) => x.job).pop() : undefined;
      // a move from this wallet's own native elsewhere names its source chain and amount ("Moving $12 from Robinhood…")
      const own = clickJobs.find((j) => j.src === 'w' && j.state !== 'failed');
      const ownUsd6 = clickJobs.filter((j) => j.src === 'w' && j.state !== 'failed').reduce((t, j) => t + big(j.usd6), 0n);
      const lastFailed = clickJobs.filter((j) => j.state === 'failed').pop();
      // a refusal's code (floatCore clickCodeOf): the page words it in the user's language; the vault's own why stays beside it
      const codeOf = (j: FloatJob) => (j.kind === 'cold' && !j.src ? { code: clickCodeOf(j.error || '') } : {});
      const click = !urgent ? undefined
        // TC-1: nothing was moved for a click it could not pay — said at once, with what it can pay here (the page words it)
        : infeasible && !ranHere ? { state: 'failed' as const, why: `this wallet can pay up to ${fmtUsd6(plan.short!.can6 ?? 0n)} for a buy here — nothing was moved`, code: 'short' as const, short: { usd: Number(urgent.usd6) / 1e6, canUsd: Number(plan.short!.can6 ?? 0n) / 1e6 } }
        : staleOnly ? { state: 'failed' as const, why: 'a transfer to this wallet from an earlier buy is still settling — try again in a minute', code: 'settling' as const }
        : ranHere || openClick ? { state: 'moving' as const, via: clickJobs.some((j) => j.kind === 'cold' && j.state !== 'failed') || waitOn.some((j) => j.kind === 'cold') ? 'bridge' : 'same chain', ...(own ? { from: own.from, src: 'w' as const, usd: Number(ownUsd6) / 1e6 } : {}), ...(settleOnly ? { retryMs } : {}), ...(shortOf ? { short: shortOf } : {}) }
        : lastFailed ? { state: 'failed' as const, why: String(lastFailed.error || 'the top-up was refused').slice(0, 160), ...(lastFailed.src === 'w' ? { src: 'w' as const } : codeOf(lastFailed)) }
        : nativeWhy ? { state: 'failed' as const, why: nativeWhy.slice(0, 160), src: 'w' as const }
        : backoff ? { state: 'failed' as const, why: String(backoff.error || 'the top-up failed a moment ago').slice(0, 160), ...codeOf(backoff) }
        : { state: 'none' as const };
      return { ok: true, jobId: started, planned: [...plan.moves.map((m) => ({ kind: m.kind, chain: m.chain, ...(m.from ? { from: m.from } : {}), usd: Number(m.usd6) / 1e6, fee: Number(m.fee6) / 1e6, runsOn: m.kind === 'rebalance' || m.kind === 'cold' ? m.from : m.chain, ...(m.trimmed ? { trimmed: true } : {}), ...(notRun.has(m) ? { skipped: notRun.get(m)!.why } : {}) })), ...extra], skipped: plan.skips, reason, ...(joined ? { joinedAccount: true } : {}), ...(click ? { click } : {}), ...(earnClick ? { earn: earnClick } : earnStep ? { earn: earnStep } : {}) };
    };
    let res = await deps.lock(lockKey(w, c), body, urgent || refill ? { waitMs: 2_000 } : undefined);
    if (!res && urgent) res = await body();
    if (urgent) deps.store.del(wantKey);
    return res || { ok: true, jobId: null, planned: [], note: 'another tab is running the USD balance' };
  }

  function walletOf(id: string) { return deps.wallet(id); }
  const capsOut = (c: Caps) => ({ perDay: Number(c.perDay6) / 1e6, feesPerDay: Number(c.feesPerDay6) / 1e6, perChain: Number(c.perChain6) / 1e6, total: Number(c.total6) / 1e6, maxSlipBps: c.maxSlipBps });
  const publicPerm = (p: Permission | null) => (p ? { chains: p.chains, caps: capsOut(p.caps), grantedAt: p.grantedAt, expiresAt: p.expiresAt, rules: rulesOf(p), live: permissionLive(p, deps.now()) } : null);
  // devices: 'all' = on for the whole account (its record is in the account profile), 'this' = this device only
  const publicAccount = (a: StoredAccount | null) => (a ? { chains: a.chains, caps: capsOut(a.caps), grantedAt: a.grantedAt, expiresAt: a.expiresAt, rules: rulesOf(a), live: accountLive(a, deps.now()), outdated: accountOutdated(a, deps.now(), RU.accepted), scope: 'account' as const, devices: devicesOf(a) } : null);
  // the caller's walletId must be a wallet of this vault (a Privy wallet is fine: the switch is the account's)
  function checkCaller(id: string, l: FloatWalletList) { if (deps.wallets && !l.list.some((w) => w.id === id) && !l.skipped.some((s) => s.id === id)) throw new Error('Unknown wallet'); }
  const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'Cancelled' });

  // one wallet's status from the cached snapshots; `refresh` starts a read of this frame's chain behind it when old
  function walletStatus(w: FloatWallet, refresh: boolean) {
    if (!permissionLive(perms(w), deps.now()) && !anyOffOrder(w)) join(w);
    const c = here(); const v = view(w); const p = perms(w);
    const mine = c ? v.snaps[c] : null;
    // on: every 10 s; off: every 30 s, so the switch-on / switch-off dialogs can state every chain's amounts from fresh
    // snapshots (the app asks each chain's frame for its status before it opens the dialog)
    const live = permissionLive(p, deps.now());
    if (refresh && c && (!mine || deps.now() - mine.at > (live ? 10_000 : 30_000)) && !clickBusy()) readChain(w, c).catch(() => {});
    // the conversions confirmed in a dialog and still waiting for their chain's frame (shown as "Converting …")
    const orders = FLOAT_CHAIN_KEYS.flatMap((k) => (['on', 'off'] as const).map((kind) => readOrder(w, kind, k))).filter((x): x is Order => !!x).map((x) => {
      const cfg = cfgOf(x.chain); const sn = v.snaps[x.chain];
      const usd = x.kind === 'on' ? (sn ? nativeToUsd6(big(x.max), big(sn.price6), cfg.nativeDecimals) : 0n) : stableToUsd6(big(x.max), cfg.stable.decimals);
      return { kind: x.kind, chain: x.chain, amount: x.kind === 'on' ? fmtNative(big(x.max), cfg.nativeDecimals, cfg.native) : `${fmtUsd6(usd)} ${cfg.stable.symbol}`, usd: Number(usd) / 1e6, to: x.kind === 'on' ? cfg.stable.symbol : cfg.native };
    });
    const shown = (j: FloatJob) => ({ ...j, ...(j.confirmed === 'on' && j.amountIn ? { amount: fmtNative(big(j.amountIn), cfgOf(j.chain).nativeDecimals, cfgOf(j.chain).native) } : {}) });
    // what one click may carry across chains through motion's bridge (XCHAIN parts; 2026-11-01 pass 2): the app's ticket never
    // promises "Paid from …" above it (an older engine has no such field: the app assumes one $1,000 fill)
    const xchainUsd = Number(xchainClickMax6(partMaxOf(solverHealth?.max6))) / 1e6;
    return { enabled: live, permission: publicPerm(p), reserve: { evm: w.r.evm, sol: w.r.sol }, chains: v.chains, usd: v.usd, limits: { xchainUsd, partUsd: Number(partMaxOf(solverHealth?.max6)) / 1e6, atomic: true },   // TC-1: a click is planned all or nothing
      jobs: v.jobs.filter((j) => isOpen(j) || deps.now() - j.updatedAt < 86_400_000).map(shown).slice(-30), orders };
  }
  // the account status's reads of this frame's chain: one wallet after another (the 1 request/s bucket paces them, the
  // price and gas are shared for 5 s), one run at a time, never in a click window
  let refreshing: Promise<void> | null = null;
  function refreshAccount(list: FloatWallet[], on: boolean) {
    const c = here(); if (!c || refreshing || clickBusy()) return;
    const old = list.filter((w) => { const s = readSnap(w, c); return !s || deps.now() - s.at > (on ? 10_000 : 30_000); });
    if (!old.length) return;
    refreshing = (async () => { for (const w of old) { if (clickBusy()) break; await readChain(w, c, true).catch(() => null); } })().finally(() => { refreshing = null; });
  }
  // before a dialog states its amounts: every wallet whose snapshot of this chain is older than 15 s, or older than its
  // last move on this chain (a sweep sent after the snapshot was taken), is read again — all of them at once, on the click
  // path (readNow: no bucket; a running trade still goes first, at the source). A failed read leaves the old snapshot: a
  // chain without a fresh price is skipped by the dialog ("converts later"), never sized from a stale one.
  async function readForDialog(list: FloatWallet[]) {
    const c = here(); if (!c) return;
    await readNow(list, c, 15_000).catch(() => null);
  }
  // the other wallets of the account, after a routine tick of the page's wallet: one at a time, each at most every 55 s,
  // only when there is something to do (the switch is on, a conversion waits, or a move is open), never in a click window
  const lastTick = new Map<string, number>();
  let othersRun: Promise<void> | null = null;
  function tickOthers(exceptId: string) {
    const c = here(); if (!c || othersRun || !deps.wallets) return;
    othersRun = (async () => {
      let list: FloatWallet[] = []; try { list = listWallets().list; } catch { return; }
      // a conversion the user confirmed in a dialog (on or off) does not wait its turn: every such wallet runs now, side by
      // side (owner 2026-10-26: 3 minutes for one swap of six) — they are different wallets, so different nonces and locks
      const confirmed = list.filter((o) => o.id !== exceptId && (readOrder(o, 'on', c) || readOrder(o, 'off', c)));
      if (confirmed.length && !clickBusy()) await Promise.all(confirmed.map((o) => tick(o, 'convert').catch(() => null)));
      for (const o of list) {
        if (confirmed.includes(o)) continue;
        if (o.id === exceptId || deps.now() - (lastTick.get(o.id) || 0) < OTHERS_MS) continue;
        const busy = !!accountOn() || permissionLive(perms(o), deps.now()) || FLOAT_CHAIN_KEYS.some((k) => readOrder(o, 'on', k) || readOrder(o, 'off', k)) || loadJobs(o, c).some(isOpen);
        if (!busy) continue;
        if (clickBusy()) break;
        try { await tick(o, 'account'); } catch { /* its next turn */ }
      }
    })().finally(() => { othersRun = null; });
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  // the wallets' Earn figures together: "Earned" only when every wallet's is known on this device (else null: shown as —)
  const earnSums = (ws: { usd: { earn?: number; earned?: number | null } }[]) => {
    const inv = ws.filter((x) => (x.usd.earn ?? 0) > 0); if (!inv.length) return {};
    return { earn: r6(inv.reduce((t, x) => t + (x.usd.earn ?? 0), 0)), earned: inv.every((x) => x.usd.earned != null) ? r6(inv.reduce((t, x) => t + (x.usd.earned ?? 0), 0)) : null };
  };
  const fastly = <T,>(fn: () => Promise<T>): Promise<T> => (deps.hurry ? deps.hurry(fn) : fn());
  /**
   * The account: every wallet's status (the same shape as a wallet's own) and the total of their dollars, the wallets the
   * switch skips and why, and the wallets that joined a live switch without a dialog in the last day (with what their
   * routine sweeps converted since), for the app's notice. Cached snapshots only; reads start behind it.
   */
  function accountStatus(callerId: string) {
    const l = listWallets(callerId); checkCaller(callerId, l);
    const a = account(); const on = accountLive(a, deps.now());
    refreshAccount(l.list, on);
    const wallets = l.list.map((w) => ({ walletId: w.id, name: w.name, ...walletStatus(w, false) }));
    const sum = (k: 'cash' | 'ready' | 'transit' | 'total' | 'upkeepWeek' | 'readyFeesWeek' | 'readyMovedWeek') => r6(wallets.reduce((t, x) => t + x.usd[k], 0));
    const joined = a && on ? Object.entries(a.joined || {}).filter(([, at]) => deps.now() - at < JOINED_NOTICE_MS).flatMap(([addr, at]) => {
      const w = l.list.find((x) => lc(x.w.evm) === addr); if (!w) return [];
      const sweeps = allJobs(w).filter((j) => j.kind === 'sweep' && !j.confirmed && j.at >= at);
      return [{ walletId: w.id, name: w.name, at, converted: Number(sweeps.filter((j) => j.state === 'sent' || j.state === 'arrived').reduce((t, j) => t + big(j.usd6), 0n)) / 1e6, converting: sweeps.some(isOpen) }];
    }) : [];
    // (2026-11-02, the owner: "it's either on or off") while this device is not on: why it does not follow the account
    // (`follow.why`: 'rules' | 'expired' — the account's newer grant, or this device's own one, is on older rules / out of date —
    // or 'signer' | 'foreign' | 'unverified' — a record this device cannot vouch for), and the account's switch as this device
    // last saw it in an authentic record (`record`: 'on' | 'off'; none = it has seen no record). The app shows "On for your
    // account" only on 'on', and its telemetry counts the reasons.
    const cs = consentState();
    const keptNewer = !!cs.kept && (!cs.rec || cs.kept.n > cs.rec.body.n);
    const own = a as StoredAccount | null;
    const followWhy = on ? null : keptNewer ? cs.kept!.why : own && own.v === 1 && accountDigest(own) === own.digest ? (own.expiresAt <= deps.now() ? 'expired' : accountOutdated(own, deps.now(), RU.accepted) ? 'rules' : null) : null;
    const record = keptNewer ? 'on' : cs.rec ? (cs.rec.body.on ? 'on' : 'off') : null;
    return { ok: true, scope: 'account', enabled: on, devices: devicesOf(a), ...(followWhy ? { follow: { why: followWhy, rules: keptNewer ? cs.kept!.rules : rulesOf(own) } } : {}), ...(record ? { record } : {}), permission: publicAccount(a), lane: here(), wallets, skipped: l.skipped.map((s) => ({ walletId: s.id, name: s.name, why: s.why })),
      usd: { cash: sum('cash'), ready: sum('ready'), transit: sum('transit'), total: sum('total'), upkeepWeek: sum('upkeepWeek'), readyFeesWeek: sum('readyFeesWeek'), readyMovedWeek: sum('readyMovedWeek'), ...earnSums(wallets) }, joined,
      // Earn (src/earnEngine.ts): the account's switch, cap, what is in the vault, "Earned", a pause and why (cached only)
      ...(deps.earn ? { earn: deps.earn.account() } : {}) };
  }

  // ── the ready float after a trade (REFILL; owner 2026-10-29) ──
  // webEngine calls these from the vault frame itself (never the page): noteBuy when a buy of this frame was sent (its size in
  // native, per wallet), afterTrade when a trade of W CONFIRMED. One refill per wallet at a time; a trade that confirms while
  // one runs makes it run once more right after (its read may predate that trade).
  const walletByAddress = (address: string): FloatWallet | null => {
    let list: FloatWallet[] = []; try { list = listWallets().list; } catch { return null; }
    const a = String(address || ''); return list.find((x) => lc(x.w.evm) === lc(a) || (!!x.w.sol && x.w.sol === a)) || null;
  };
  const refilling = new Map<string, { again: boolean }>();
  // (usd-mode 2026-11-05, B:/tmp/usd-mode-1105) a buy paid straight from the reserve (noteBuy, called by webEngine only for those)
  // spends R's dollars, not W's float: its confirmation does not refill W. Before, each such buy raised the ready size to the buy
  // and the refill swapped R's USDG into ETH for W (a tester: $100.77 → 0.0416 ETH 4 s after a $500 buy that never touched W).
  // One mark per reserve buy sent, per wallet × chain, consumed by that wallet's next confirmed trade there; a mark older than
  // DIRECT_MARK_MS (a buy that never confirmed) is dropped, and a buy W signed later refills as before.
  const DIRECT_MARK_MS = 600_000;
  const directMarks = new Map<string, number[]>();
  const directTake = (k: string): boolean => {
    const now = deps.now(); const list = (directMarks.get(k) || []).filter((t) => now - t < DIRECT_MARK_MS);
    const hit = list.length > 0; if (hit) list.shift();
    if (list.length) directMarks.set(k, list); else directMarks.delete(k);
    return hit;
  };
  function noteBuy(address: string, native: number): void {
    const c = here(); if (!c || !(native > 0)) return;
    const w = walletByAddress(address); if (!w) return;
    const sn = readSnapShown(w, c); const price6 = big(sn?.price6); if (!(price6 > 0n)) return;
    const raw = BigInt(Math.floor(native * 10 ** Math.min(9, cfgOf(c).nativeDecimals))) * 10n ** BigInt(Math.max(0, cfgOf(c).nativeDecimals - 9));
    const u = nativeToUsd6(raw, price6, cfgOf(c).nativeDecimals); if (u > 0n) recordBuy(w, c, u);
    const mk = w.id + '|' + c; directMarks.set(mk, [...(directMarks.get(mk) || []), deps.now()]);
  }
  function afterTrade(address: string): void {
    const c = here(); if (!c) return;
    const w = walletByAddress(address); if (!w) return;
    const p = perms(w); if (!permissionLive(p, deps.now()) || !p!.chains.includes(c) || anyOffOrder(w)) return;
    if (directTake(w.id + '|' + c)) return;   // a buy from the reserve: W's float was not spent (usd-mode)
    const run = refilling.get(w.id); if (run) { run.again = true; return; }
    const me = { again: false }; refilling.set(w.id, me);
    (async () => {
      do {
        me.again = false;
        await deps.wait(REFILL.delayMs);
        const until = deps.now() + REFILL.waitMs;
        while (tradeLive() && deps.now() < until) await deps.wait(100);
        if (tradeLive()) break;
        await tick(w, 'refill').catch(() => null);
      } while (me.again);
    })().finally(() => refilling.delete(w.id));
  }

  // ── the buy straight from the reserve (src/floatDirect.ts; owner 2026-10-29) ──
  // The vault frame asks here before R signs a buy for W: the account's switch must be on for this wallet and chain (R is
  // the float's reserve: it never buys while the USD balance is off or turning off). The price is the float's own snapshot
  // (the oracle pool), only to state the buy in native units for the buy limits. A reserve without the SOL for its fee gets
  // motion's gas drop (≤ 5 s), exactly as a click's top-up does.
  // (2026-11-04) a buy on Elysium paid from the USD balance (src/elysiumUsdEngine.ts, the Elysium frame): this wallet's LIVE
  // permission and its chains (the reserves that may pay), or null; a switch-off still converting counts as off. Vault frame only
  // (webEngine), never in engine.float: the page cannot call it
  // (release 9, owner 2026-11-05: «убрать лимиты, тогда текст останется верным») the chains only: no caps on the Elysium funding path
  function liveFor(walletId: string): { chains: FloatChain[] } | null {
    const w = walletOf(walletId);
    if (!permissionLive(perms(w), deps.now()) && !anyOffOrder(w)) join(w);
    const p = perms(w);
    return permissionLive(p, deps.now()) && !anyOffOrder(w) ? { chains: [...p!.chains] } : null;
  }
  function directFor(walletId: string): { w: FloatWallet; price6: bigint } {
    const c = here(); const w = walletOf(walletId);
    if (!permissionLive(perms(w), deps.now()) && !anyOffOrder(w)) join(w);
    const p = perms(w);
    if (!c || !permissionLive(p, deps.now()) || !p!.chains.includes(c) || anyOffOrder(w)) throw new FloatRefused('The USD balance is off for this wallet on this chain');
    // the buy from the reserve is rules 2: a grant on older rules never reaches it, whatever this build accepts
    if (rulesOf(p) < DIRECT_BUY_RULES) throw new FloatRefused('The USD balance is off for this wallet on this chain: confirm the new rule first');
    const sn = readSnapShown(w, c); const price6 = big(sn?.price6);
    if (!sn || !(price6 > 0n) || priceState(sn.priceAt, deps.now()) === 'dead') throw new FloatRefused('No fresh price for the USD balance yet — try again in a second');
    return { w, price6 };
  }
  // ── the standing allowances of the EVM buy from the reserve (src/usdBuyEvm.ts) ──
  // R's one-call buy needs R's stable allowance to the float's own router (SwapRouter02 / PancakeSwap SmartRouter: V3 and V2),
  // and on Robinhood its allowance to Permit2 plus Permit2's to the Universal Router (V4). These routers pull only from
  // msg.sender (R itself), so the allowance is standing (the whole amount; Permit2's for a year). R signs one approval per tick,
  // in the background (never in a click window, never while a trade runs), paying its gas from its own reserve gas, only while
  // the switch is on for this wallet on rules 2. A click that finds one missing asks for it (directAllowSoon) and keeps its hold.
  const ALLOW = 'trenches.float.v1.allow.';
  const MAX256 = (1n << 256n) - 1n, ENOUGH = 1n << 128n;
  async function directAllowance(w: FloatWallet, c: FloatChain, s: Snap, soon = false): Promise<boolean> {
    const cfg = cfgOf(c); if (cfg.kind !== 'evm' || !deps.evm) return false;
    const p = perms(w); if (!permissionLive(p, deps.now()) || rulesOf(p) < DIRECT_BUY_RULES || !p!.chains.includes(c)) return false;
    const ec = cfg as EvmFloatCfg; const e = deps.evm; const stable = ec.stable.address as `0x${string}`;
    // only for a chain the user trades on (a page or a trade in the last 7 days) and a reserve with dollars and its gas
    if ((!s.active && !soon) || big(s.reserve) === 0n || big(s.reserveNative) < ec.reserveGas / 4n) return false;
    const key = `${ALLOW}${c}.${lc(w.r.evm)}`;
    try { const prev = JSON.parse(deps.store.get(key) || 'null'); if (prev && deps.now() - Number(prev.at) < (soon ? 20_000 : 120_000)) return false; } catch { /* none */ }
    const approve = (spender: string) => ({ to: stable, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [spender as `0x${string}`, MAX256] }), value: 0n });
    const steps: { need: () => Promise<boolean>; tx: () => EvmTx; what: string }[] = [
      { what: 'router', need: async () => (await e.allowance(stable, w.r.evm, ec.router as `0x${string}`)) < ENOUGH, tx: () => approve(ec.router) },
    ];
    // the curve router (UsdBuyRouter), once the code at its address is the audited runtime
    const cr = CURVE_ROUTER[c as 'robinhood' | 'bsc'];
    if (cr && e.codeHash) steps.push({ what: 'curve router', need: async () => (await e.codeHash!(cr.address)) === cr.codeHash && (await e.allowance(stable, w.r.evm, cr.address)) < ENOUGH, tx: () => approve(cr.address) });
    if (c === 'robinhood') {
      steps.push({ what: 'permit2', need: async () => (await e.allowance(stable, w.r.evm, PERMIT2 as `0x${string}`)) < ENOUGH, tx: () => approve(PERMIT2) });
      steps.push({ what: 'universal router', need: async () => {
        const ret = await e.call({ to: PERMIT2 as `0x${string}`, data: encodeFunctionData({ abi: PERMIT2_ALLOWANCE_ABI, functionName: 'allowance', args: [w.r.evm, stable, UNIVERSAL_ROUTER as `0x${string}`] }), value: 0n, from: w.r.evm });
        const [amount, expiration] = decodeFunctionResult({ abi: PERMIT2_ALLOWANCE_ABI, functionName: 'allowance', data: ret }) as readonly [bigint, number, number];
        return amount < (1n << 120n) || Number(expiration) < deps.now() / 1000 + 30 * 86_400;
      }, tx: () => ({ to: PERMIT2 as `0x${string}`, data: permit2ApproveData(stable, UNIVERSAL_ROUTER as `0x${string}`, Math.floor(deps.now() / 1000)), value: 0n }) });
    }
    for (const st of steps) {
      if (!(await st.need())) continue;
      await stepCheck();
      const tx = st.tx();
      const gas = ((await e.estimate({ ...tx, from: w.r.evm })) * 13n) / 10n;
      await stepCheck();
      const h = await e.sendR(w.id, tx, gas);
      deps.store.set(key, JSON.stringify({ at: deps.now(), h, what: st.what }));
      emit(w, null, 'allow', 'active', { chain: c, what: st.what });
      return true;
    }
    return false;
  }
  // a click found an allowance missing: the approval goes out as soon as no trade is being signed (its own read, R's lane)
  const allowing = new Set<string>();
  function directAllowSoon(walletId: string): void {
    const c = here(); if (!c || cfgOf(c).kind !== 'evm' || allowing.has(walletId)) return;
    let w: FloatWallet; try { w = walletOf(walletId); } catch { return; }
    allowing.add(walletId);
    (async () => {
      const until = deps.now() + 30_000;
      while (tradeLive() && deps.now() < until) await deps.wait(250);
      if (tradeLive()) return;
      await deps.lock(lockKey(w, c), async () => { const s = await fastly(() => readChain(w, c)); return directAllowance(w, c, s, true); }, { waitMs: 5_000 });
    })().catch(() => {}).finally(() => allowing.delete(walletId));
  }
  // `need` (Solana, 2026-11-01): what the refused build said the reserve needs (fees + the coin accounts' rent + R's own rent,
  // about 3.1M lamports, 5.2M+ when the route opens an account). The ask then waits for THAT, not for SOL_GAS.enough (2.1M,
  // what the reserve's own top-up costs), and a reserve that still lacks it after the solver's answer (has-gas at its own
  // threshold, or a drop that landed short) is answered false at once: the buy falls back to hold & fire without a second
  // build that can only be refused again, nor the rest of a 5 s wait for gas that is not coming
  async function directGas(walletId: string, need?: bigint): Promise<boolean> {
    const c = here(); if (!c) return false; const w = walletOf(walletId);
    const rNative = cfgOf(c).kind === 'evm' ? () => deps.evm!.balance(w.r.evm) : () => deps.sol!.balance(w.r.sol);
    if (cfgOf(c).kind !== 'sol' || need == null || need <= SOL_GAS.enough) return askGas(w, c, () => fastly(rNative));
    if (!(await askGas(w, c, () => fastly(rNative), w.r.sol, need, true))) return false;
    return (await fastly(rNative).catch(() => 0n)) >= need;
  }

  /**
   * (release 9) R needs its own fee for a move it signs on THIS chain (float.convert, float.withdraw): motion's gas drop first (as
   * for a click's top-up), else W's spare ready native (the allowed W → R gas move, landed before R signs). The fresh snapshot, or
   * why not: 'gas' (none could be had) / 'trade' (a trade is being signed).
   */
  async function reserveGas(w: FloatWallet, c: FloatChain, s0: Snap, jobs: FloatJob[], slipBps: number, reason: string): Promise<{ s: Snap } | { code: 'gas' | 'trade' }> {
    const cfg = cfgOf(c); let s = s0;
    const enough = cfg.kind === 'sol' ? SOL_GAS.enough : cfg.reserveGas / 2n;
    if (big(s.reserveNative) >= enough) return { s };
    const rNative = cfg.kind === 'evm' ? () => deps.evm!.balance(w.r.evm) : () => deps.sol!.balance(w.r.sol);
    if (await askGas(w, c, rNative)) s = await readChain(w, c);
    if (big(s.reserveNative) >= enough) return { s };
    const want = cfg.reserveGas - big(s.reserveNative); const now = deps.now();
    if (big(s.float) - cfg.gasFloor < want) return { code: 'gas' };
    const g: FloatJob = { id: freeJobId(jobs, w.id, 'gas', c, undefined, now).id, walletId: w.id, kind: 'gas', chain: c, usd6: String(nativeToUsd6Up(want, big(s.price6), cfg.nativeDecimals)), fee6: String(moveFee6(c, 'gas', s.fee || null, now)), state: 'planned', at: now, updatedAt: now, hashes: [], reason, click: true };
    try { await runSame(w, g, slipBps, s); } catch (e) { if (failOf(g, e) === 'deferred') return { code: 'trade' }; g.updatedAt = deps.now(); jobs.push(g); saveJobs(w, c, jobs); return { code: 'gas' }; }
    g.updatedAt = deps.now(); jobs.push(g); saveJobs(w, c, jobs);
    if (!(await gasLanded(c, g.hashes[g.hashes.length - 1], true))) return { code: 'gas' };
    g.state = 'arrived'; g.updatedAt = deps.now(); saveJobs(w, c, jobs);
    return { s: await readChain(w, c) };
  }
  return {
    // cached only (I6): never awaits a chain read; a refresh starts behind it when the snapshot is old and no click runs.
    // `fresh: true` (the app's read right before it opens a switch dialog, a user's click waiting on it): this frame's
    // chain is read now for every wallet asked about (readNow: batched, no bucket, behind a running trade), then answered
    status: async (o: unknown) => {
      const a = floatArgs('status', o); const c = here();
      if (a.scope === 'account') {
        if (a.fresh === true && c) { const l = listWallets(String(a.walletId)); checkCaller(String(a.walletId), l); await readNow(l.list, c).catch(() => null); }
        return accountStatus(String(a.walletId));
      }
      const w = walletOf(String(a.walletId));
      if (a.fresh === true && c) await readNow([w], c).catch(() => null);
      return { ok: true, lane: here(), ...walletStatus(w, true), account: !!accountOn(), devices: devicesOf(accountOn()) };
    },
    /**
     * Switch on = ONE switch for every wallet of the account (owner, 2026-10-26). One dialog (one trusted click, and the 2FA
     * gate when it is on) states each wallet's conversion, the wallets / chains skipped and why, the caps PER WALLET and
     * the rule for wallets added later. Then every wallet gets its own Permission (same caps, chains, dates) and its own
     * conversion orders; each chain's frame runs its orders on its next tick (the page's wallet first, the others right
     * behind it). A later caps raise or a new chain asks again (one dialog, no conversion); lowering needs none.
     */
    configure: async (o: unknown) => {
      const a = floatArgs('configure', o); const lang: FloatLang = langOf(a.lang);
      const l = listWallets(String(a.walletId)); checkCaller(String(a.walletId), l);
      const { list, skipped } = l;
      if (!list.length) throw new FloatRefused('None of your wallets can hold a USD balance');
      let chains = (a.chains as FloatChain[]).filter((x) => FLOAT_CHAIN_KEYS.includes(x));
      let caps: Caps = capsFrom(a.caps as never);
      const prev = account(); const now = deps.now();
      // (2026-11-02, review F4) a buy click's one-button "Confirm and buy" (`click`) re-grants the terms the ACCOUNT already
      // agreed to and nothing more: the baseline is this device's own whole grant (ran out / older rules) or the account's newer
      // record whose authorship this device proved (kept 'rules' / 'expired'). Without caps from the page the click takes the
      // baseline's chains and caps; caps or chains above the baseline — or no baseline at all (the account's first grant) — and
      // `click` is ignored: the usual dialogs, laid out as before.
      const keptT = consentState().kept?.terms;
      const baseline: { chains: FloatChain[]; caps: Caps } | null = prev && prev.v === 1 && accountDigest(prev) === prev.digest && termsOk(prev) ? { chains: [...prev.chains], caps: prev.caps }
        : keptT && termsOk({ caps: keptT.caps, grantedAt: 1, expiresAt: 2 }) ? { chains: FLOAT_CHAIN_KEYS.filter((k) => keptT.chains.includes(k)), caps: capsOfWire(keptT.caps) } : null;
      if (a.click === true && baseline && a.caps == null) { chains = [...baseline.chains]; caps = baseline.caps; }
      const clickProven = a.click === true && !!baseline && !capsRaise(baseline.caps, caps) && chains.every((x) => baseline.chains.includes(x));
      // no terms this device can prove (the account holds dollars, but its record's signer is none of this vault's keys, or no
      // record reached it): the click may grant the DEFAULT terms only (what the app's own switch grants), and its dialog then
      // lays the whole consent open — anything above the defaults and `click` is ignored
      const clickDefault = a.click === true && !baseline && !capsRaise(DEFAULT_CAPS, caps);
      // a grant of this device that is whole but ran out (its 30 days): said in the dialog, nothing converts by default
      const ranOut = !!prev && prev.v === 1 && prev.expiresAt <= now && accountDigest(prev) === prev.digest;
      // a grant on older rules (FLOAT_RULES) is not a switch-on: the dialog asks only for what is new, nothing converts and
      // the grant keeps its dates; a caps raise / new chain on top of it shows the whole consent, laid open, as before
      const outdated = accountOutdated(prev, now, RU.accepted);
      // switching ON (not a later caps change): this device has no live grant
      const switchOn = !accountLive(prev, now) && !outdated;
      const widened = switchOn || capsRaise(prev!.caps, caps) || chains.some((x) => !prev!.chains.includes(x));
      const raising = widened || outdated;
      let convs: { w: FloatWallet; plan: ReturnType<typeof planConvert> }[] | null = null;
      // what the user chose in the dialog: convert the stated amounts now, or keep every wallet's native as it is
      let convertNow = false;
      // why a switch-on dialog shows (2026-11-01, the owner with ~$800 already in his USD balance was asked to "Turn on" and
      // "Convert $179"): 'first' = a first switch-on (no grant here, no dollars, no record this device knows of): converting is
      // the point, so it is the primary button. Anything else (dollars already in the reserves, a grant here that ran out, the
      // account's newer record this device could not adopt) = this device is catching up: a one-tap confirm that converts
      // NOTHING by default; converting is a second, separately labelled button with its exact amounts
      let why: OnWhy | null = null;
      if (raising) {
        // the amounts are read at dialog time: this frame's chain now (each wallet whose snapshot is older than 15 s, all
        // wallets in one batched read), the others from their frames' snapshots (a price older than 60 s sizes nothing:
        // that wallet's chain is skipped and the dialog says so; its later sweeps still convert it). The read is a read
        // only, so it runs while the 2FA gate is open; nothing is sized before both are done.
        const here0 = here();
        const reading = switchOn && here0 && chains.includes(here0) ? readForDialog(list) : null;
        reading?.catch(() => {});
        await deps.gate();
        if (switchOn) {
          if (reading) await reading;
          convs = list.map((w) => {
            const states: Partial<Record<FloatChain, ChainState>> = {};
            for (const k of chains) { const sn = readSnap(w, k); if (sn) states[k] = stateOf(sn, k, true, false); }
            return { w, plan: planConvert(states, chains, caps, deps.now()) };
          });
          // the dollars the account's reserves already hold, as this vault's snapshots last read them (every chain, every wallet,
          // at any age: the same figure the app's "on on another device" state is drawn from)
          const cash6 = list.reduce((t, w) => t + FLOAT_CHAIN_KEYS.reduce((u, k) => { const sn = readSnapShown(w, k); return sn ? u + stableToUsd6(big(sn.reserve), cfgOf(k).stable.decimals) : u; }, 0n), 0n);
          const kept = consentState().kept;
          why = ranOut ? { kind: 'expired', at: (prev as StoredAccount).expiresAt }
            : kept && kept.why === 'rules' && kept.rules < RU.current ? { kind: 'rules', from: kept.rules }
            : (kept && kept.why !== 'expired') || cash6 >= USD ? { kind: 'device', cash6 }
            : { kind: 'first' };
        }
        // (owner 2026-11-05) no "Expected upkeep: about $X a week per wallet …" plate in the consent: the estimate is left out
        // (accountPermissionText omits the line when upkeepWeek6 is undefined); the fees themselves are unchanged
        const text = accountPermissionText(list.map((w) => w.name), chains, caps, undefined, lang);
        // only newer rules: their one line, the consent folded under it
        const delta = widened ? null : rulesDeltaLines(rulesOf(prev), RU.current, lang, deps.rules?.delta);
        // the account's other devices follow this switch (floatConsent): said in the dialog that grants it
        const everywhere = deps.consent?.linked?.() ? `<p class="ub-note">${deps.html.esc(ACCOUNT_DEVICES[lang].on)}</p>` : '';
        const W = RESUME[lang];
        const offer = !!convs && convs.some((x) => x.plan.lines.length);
        const wc = convs ? convs.map((x) => ({ name: x.w.name, plan: x.plan })) : [];
        const sk = skipped.map((x) => ({ name: x.name, why: x.why }));
        const folded = consentHtml(text, deps.html.esc, ACCOUNT_MORE[lang]);
        // (2026-11-02, the owner on his iPhone: a buy with the account's $87 USD balance opened "Read / Confirm / Convert" instead of
        // buying) a BUY CLICK's confirm (`click`): ONE button, "Confirm and buy", nothing converted (no conversion offered at all:
        // the native stays KEPT), and the line that the buy goes on after it. The consent itself is the same as below — folded
        // for a device catching up, laid open for the account's first-ever grant — and the same trusted click / 2FA gate grant it.
        // never on the account's first grant (its own dialog) and never on a caps raise / new chain of a live grant (review F4)
        const click = clickProven || (clickDefault && !!convs && !!why && why.kind !== 'first');
        const buyLine = click ? `<p class="ub-note">${deps.html.esc(W.buyNext)}</p>` : '';
        if (click && convs && why && why.kind !== 'first') {
          const rulesLines = why.kind === 'rules' ? rulesDeltaLines(why.from, RU.current, lang, deps.rules?.delta) : [];
          // the consent is laid open whenever these caps are above the defaults or this device cannot prove the account's terms
          // (review F4); folded only when it re-grants terms the account already agreed to, at or under the defaults
          const consent = !clickProven || capsRaise(DEFAULT_CAPS, caps) ? consentHtml(text, deps.html.esc) : folded;
          const html = accountResumeHtml({ why, delta: rulesLines, convs: wc, skipped: sk, enabled: chains, offer: false, lang, esc: deps.html.esc }) + buyLine + consent + everywhere;
          if (!(await deps.ask({ title: W.title, ok: W.okBuy, html }))) throw cancelled();
          convertNow = false;
        } else if (convs && why && why.kind !== 'first') {
          // catching up: confirm = nothing converts; the conversion only as the second button, its rows stated above it
          const canChoose = !!deps.choose && offer;
          const rulesLines = why.kind === 'rules' ? rulesDeltaLines(why.from, RU.current, lang, deps.rules?.delta) : [];
          const html = accountResumeHtml({ why, delta: rulesLines, convs: wc, skipped: sk, enabled: chains, offer: canChoose, lang, esc: deps.html.esc }) + folded + everywhere;
          if (canChoose) {
            const pick = await deps.choose!({ title: W.title, ok: W.ok, html, choices: [{ id: 'ok', label: W.ok, primary: true }, { id: 'convert', label: W.okConvert(convertTotalText(wc)) }] });
            if (pick !== 'ok' && pick !== 'convert') throw cancelled();
            convertNow = pick === 'convert';
          } else if (!(await deps.ask({ title: W.title, ok: W.ok, html }))) throw cancelled();
        } else if (convs) {
          // a first switch-on: its conversion stated as before, and turning on WITHOUT it is a button of its own
          const html = `${dialogViewHtml(accountConvertView(wc, sk, chains, lang), deps.html.esc)}${folded}${everywhere}`;
          if (deps.choose && offer) {
            const pick = await deps.choose({ title: ACCOUNT_DIALOG[lang].onTitle, ok: W.firstConvert(convertTotalText(wc)), html, choices: [{ id: 'convert', label: W.firstConvert(convertTotalText(wc)), primary: true }, { id: 'ok', label: W.firstKeep }] });
            if (pick !== 'ok' && pick !== 'convert') throw cancelled();
            convertNow = pick === 'convert';
          } else {
            if (!(await deps.ask({ title: ACCOUNT_DIALOG[lang].onTitle, ok: ACCOUNT_DIALOG[lang].onOk, html }))) throw cancelled();
            convertNow = true;   // an older host's one button: the dialog stated the conversion (as before this change)
          }
        } else {
          // a caps raise / new chain (no conversion, as before): what it changes, then the consent laid open; newer rules: their line
          const added = chains.filter((x) => !prev!.chains.includes(x));
          const html = delta ? `${delta.map((l) => `<p class="ub-lead">${deps.html.esc(l)}</p>`).join('')}${folded}`
            : `<p class="ub-lead">${deps.html.esc(widenLine(added, lang))}</p>${consentHtml(text, deps.html.esc)}`;
          const ok = await deps.ask(delta ? { title: RULES_DIALOG[lang].title, ok: click ? W.okBuy : RULES_DIALOG[lang].ok, html: html + buyLine + everywhere } : { title: ACCOUNT_DIALOG[lang].onTitle, ok: click ? W.okBuy : ACCOUNT_DIALOG[lang].onOk, html: html + buyLine + everywhere });
          if (!ok) throw cancelled();
        }
      }
      const grantedAt = widened ? now : prev!.grantedAt, expiresAt = widened ? now + PERMISSION_DAYS * 86_400_000 : prev!.expiresAt;
      // the rules the user said yes to in THIS dialog; no dialog = the rules the live grant already carries
      const rules = rulesField(raising ? RU.current : rulesOf(prev));
      const ab = { v: 1 as const, chains, caps, grantedAt, expiresAt, wallets: list.map((w) => lc(w.w.evm)), ...rules };
      saveAccount({ ...ab, digest: accountDigest(ab), joined: widened ? {} : prev?.joined || {} });
      // every wallet's own permission: the same caps, chains, dates and rules — the caps and the ledger stay per wallet
      for (const w of list) { const pb = { v: 1 as const, wallet: w.w.evm, reserve: w.r.evm, chains, caps, grantedAt, expiresAt, ...rules }; savePerm(w, { ...pb, digest: permissionDigest(pb) }); }
      // the account's record of this switch (floatConsent): signed by the caller's wallet (or the first), published by the
      // page inside the account profile, adopted by the account's other devices without a dialog
      { const me = list.find((w) => w.id === a.walletId) || list[0];
        if (await writeConsent(grantBody(ab), lc(me.w.evm))) deps.consent?.changed(); }
      if (convs) {
        // a new switch-on supersedes any switch-off still waiting; each chain's frame runs each wallet's order on its tick.
        // Converting: exactly the lines the dialog stated (KEEP cleared). Not converting: nothing is ordered, and each line's
        // native is KEPT as native (the routine sweep leaves it alone; only what arrives above it converts later)
        for (const { w, plan } of convs) {
          for (const k of FLOAT_CHAIN_KEYS) { delOrder(w, 'off', k); delOrder(w, 'on', k); }
          delKeeps(w);
          for (const l2 of plan.lines) { if (convertNow) saveOrder(w, { kind: 'on', chain: l2.chain, max: String(l2.nativeIn), at: now, grantedAt, tries: 0 }); else saveKeep(w, l2.chain, l2.nativeIn); }
        }
      }
      const convert = convs ? {
        planned: convertNow ? convs.flatMap(({ w, plan }) => plan.lines.map((x) => { const cfg = cfgOf(x.chain); return { walletId: w.id, name: w.name, chain: x.chain, amount: fmtNative(x.nativeIn, cfg.nativeDecimals, cfg.native), usd: Number(x.usd6) / 1e6, to: cfg.stable.symbol, runsOn: x.chain }; })) : [],
        skipped: [
          ...convs.flatMap(({ w, plan }) => plan.skips.map((s) => ({ walletId: w.id, name: w.name, chain: s.chain, why: s.why as string }))),
          // the lines the user chose to keep as native: named, with their amount, so the progress sheet says "stays as ETH"
          ...(convertNow ? [] : convs.flatMap(({ w, plan }) => plan.lines.map((x) => { const cfg = cfgOf(x.chain); return { walletId: w.id, name: w.name, chain: x.chain, why: 'kept', amount: fmtNative(x.nativeIn, cfg.nativeDecimals, cfg.native), usd: Number(x.usd6) / 1e6 }; }))),
        ],
        ...(why ? { why: why.kind } : {}),
        ...(convertNow ? {} : { kept: true }),
      } : null;
      const caller = list.find((w) => w.id === a.walletId) || list[0];
      emit(caller, null, 'configure', 'done', { scope: 'account', chains, wallets: list.length, ...(convert ? { convert } : {}) });
      return { ok: true, scope: 'account', permission: publicAccount(accountOn()), wallets: list.map((w) => ({ walletId: w.id, name: w.name })), skipped: skipped.map((s) => ({ walletId: s.id, name: s.name, why: s.why })), convert };
    },
    ensure: async (o: unknown) => {
      const a = floatArgs('ensure', o); const w = walletOf(String(a.walletId)); const chain = a.chain as FloatChain;
      const urgent = a.reason === 'click' && typeof a.usd === 'number' ? { chain, usd6: usd6(a.usd) } : undefined;
      // prediction inputs (sizing, §3): an opened lane / page / click marks the chain active for 7 days; the page reports its
      // presets and its own fills in dollars (the trade path never calls this module — I1)
      {
        const k = `${PREFS}${chain}.${w.w.evm.toLowerCase()}`; let p: { presets6?: string[]; buys6?: string[]; activeAt?: number } = {}; try { p = JSON.parse(deps.store.get(k) || '{}'); } catch {}
        if (a.reason === 'lane' || a.reason === 'page' || a.reason === 'click') p.activeAt = deps.now();
        if (Array.isArray(a.presets)) p.presets6 = (a.presets as number[]).map((x) => String(usd6(x)));
        deps.store.set(k, JSON.stringify(p));
        if (a.reason === 'fill' && typeof a.usd === 'number') recordBuy(w, chain, usd6(a.usd));
      }
      // 300 ms debounce per wallet: a burst of triggers is one tick; the answer comes back at once
      const key = w.id;
      const pending = debounce.get(key);
      if (pending && !urgent) return { ok: true, jobId: null, planned: [], joined: true };
      // the other wallets of the account follow in the background after a routine tick (never after a click's own top-up):
      // their conversions, later deposits and joins run without the app asking for each wallet
      const p = deps.wait(urgent ? 0 : 300).then(() => tick(w, String(a.reason), urgent)).then((r) => { if (!urgent) tickOthers(w.id); return r; }).finally(() => debounce.delete(key));
      debounce.set(key, p);
      if (urgent) return p;
      p.catch(() => {});
      return { ok: true, jobId: null, planned: [], queued: true };
    },
    sweep: async (o: unknown) => {
      const a = floatArgs('sweep', o); const w = walletOf(String(a.walletId));
      if (a.chain !== here()) throw new FloatRefused('Ask the frame of that chain');
      if (!quietOn(a.chain as FloatChain)) throw new FloatRefused('Not now: a sweep waits 60 s after a trade or a ticket touch, and never runs on the chain whose token page is open');
      return tick(w, 'sweep');
    },
    /**
     * Switch off = convert back, for every wallet of the account (owner, 2026-10-26). ONE vault dialog states each wallet's
     * dollars going back (read now on this chain, from the other frames' snapshots), then this frame converts its own chain
     * for each wallet, one after another, and only then are the switch and every wallet's permission dropped. The other
     * chains' conversions run in their own frames (the app calls `off` there too, no second dialog; their next tick does it
     * otherwise). A wallet / chain that fails still turns off and the answer says which kept its USD and why. Nothing to
     * convert back = one tap, no dialog, as before.
     */
    off: async (o: unknown) => {
      const a = floatArgs('off', o); const lang: FloatLang = langOf(a.lang); const c = here();
      const l = listWallets(String(a.walletId)); checkCaller(String(a.walletId), l);
      const { list } = l;
      const acct = account();
      const slipOf = (w: FloatWallet) => perms(w)?.caps.maxSlipBps ?? acct?.caps.maxSlipBps ?? DEFAULT_CAPS.maxSlipBps;
      type Out = BackResult & { walletId: string; name: string };
      const tag = (w: FloatWallet, r: BackResult): Out => ({ ...r, walletId: w.id, name: w.name });
      const kept: Out[] = [];
      // Earn (src/earnEngine.ts): nothing new goes in; on this frame's chain every wallet's position comes out to R first (fully checked),
      // R is read again, and the dialog below converts what is liquid. What the vault cannot pay now stays there (still the
      // user's, still earning) and keeps coming out on the next ticks; the answer names it (earn.left)
      let earnOut: { usd: number; why: string[] } | null = null;
      if (deps.earn) {
        if (c && list.some((w) => deps.earn!.holds(w))) {
          earnOut = await deps.earn.exitAll().catch((x) => ({ usd: -1, why: [String((x as Error)?.message || x).slice(0, 120)] }));
          for (const w of list) await fastly(() => readChain(w, c)).catch(() => null);
        } else deps.earn.stop();
      }
      if (!(c && list.some((w) => readOrder(w, 'off', c)))) {
        await readForDialog(list);
        const chainsOf = (w: FloatWallet) => perms(w)?.chains ?? acct?.chains ?? [];
        const ws = list.map((w) => {
          const states: Partial<Record<FloatChain, { reserve: bigint }>> = {}; const unread: FloatChain[] = [];
          for (const k of FLOAT_CHAIN_KEYS) { const sn = readSnap(w, k); if (sn) states[k] = { reserve: big(sn.reserve) }; else if (chainsOf(w).includes(k)) unread.push(k); }
          return { w, plan: planConvertBack(states), unread };
        });
        for (const x of ws) {
          for (const s of x.plan.skips) kept.push(tag(x.w, { chain: s.chain, state: 'kept', usd: Number(s.usd6) / 1e6, why: 'too small to convert' }));
          for (const k of x.unread) kept.push(tag(x.w, { chain: k, state: 'kept', usd: 0, why: 'not read yet: turn off again with that chain open' }));
        }
        if (ws.some((x) => x.plan.lines.length)) {
          await deps.gate();
          const view = accountOffView(ws.map((x) => ({ name: x.w.name, plan: x.plan, unread: x.unread })), acct?.caps.maxSlipBps ?? Math.max(...list.map(slipOf)), lang);
          const everywhere = deps.consent?.linked?.() ? `<p class="ub-note">${deps.html.esc(ACCOUNT_DEVICES[lang].off)}</p>` : '';
          const ok = await deps.ask({ title: ACCOUNT_DIALOG[lang].offTitle, ok: ACCOUNT_DIALOG[lang].offOk, html: dialogViewHtml(view, deps.html.esc) + everywhere });
          if (!ok) throw cancelled();
          const now = deps.now();
          for (const x of ws) {
            for (const k of FLOAT_CHAIN_KEYS) { delOrder(x.w, 'on', k); delOrder(x.w, 'off', k); }
            for (const b of x.plan.lines) saveOrder(x.w, { kind: 'off', chain: b.chain, max: String(b.stableIn), at: now, tries: 0 });
          }
        }
      }
      // (release 9) the converted coin is the wallet's plain native once the switch goes: never held out of the conversion back
      for (const w of list) delConvs(w);
      const results: Out[] = [];
      // every wallet's conversion back on this chain at once (different wallets: different addresses and nonces)
      if (c) results.push(...await Promise.all(list.filter((w) => readOrder(w, 'off', c)).map(async (w) => tag(w, await fastly(() => runBack(w, c, slipOf(w)))))));
      // only then: the switch goes for every wallet, and no switch-on conversion is left behind
      saveAccount(null);
      for (const w of list) { savePerm(w, null); delKeeps(w); for (const k of FLOAT_CHAIN_KEYS) delOrder(w, 'on', k); }
      // the revocation for every device of the account (floatConsent): above every counter seen here, so it ends any grant
      // this device knows of; the others turn off on their next sync
      { const me = list.find((w) => w.id === a.walletId) || list[0];
        if (me && await writeConsent({ v: 1, on: false }, lc(me.w.evm))) deps.consent?.changed(); }
      const pendingPairs = list.flatMap((w) => FLOAT_CHAIN_KEYS.filter((k) => k !== c).flatMap((k) => { const od = readOrder(w, 'off', k); return od ? [{ w, k, usd: Number(stableToUsd6(big(od.max), cfgOf(k).stable.decimals)) / 1e6 }] : []; }));
      const same = (x: Out, y: Out) => x.walletId === y.walletId && x.chain === y.chain;
      const chainsOut: Out[] = [...results, ...kept.filter((k) => !results.some((r) => same(r, k))), ...pendingPairs.map(({ w, k, usd }) => tag(w, { chain: k, state: 'pending', usd, why: 'converts in that chain\'s frame' }))];
      const pending = [...new Set(pendingPairs.map((x) => x.k))];
      const caller = list.find((w) => w.id === a.walletId) || list[0];
      if (caller) emit(caller, null, 'off', 'done', { scope: 'account', chains: chainsOut });
      return { ok: true, scope: 'account', chains: chainsOut, pending, ...(earnOut ? { earn: { left: earnOut.usd, ...(earnOut.why.length ? { why: earnOut.why } : {}) } } : {}) };
    },
    jobs: async (o: unknown) => { const a = floatArgs('jobs', o); const w = walletOf(String(a.walletId)); return { ok: true, jobs: allJobs(w) }; },
    /**
     * (release 9, owner 2026-11-05) float.convert { walletId, chain, usd, lang? } — `usd` of this wallet's USD balance on `chain`
     * becomes that chain's own coin (ETH on Robinhood, BNB on BNB, SOL on Solana), delivered to the wallet itself and kept there:
     * out of the dollar figure and never swept back (CONV). The move is the existing top-up (R → W, stable → native, the float's
     * own pinned pool and router, the oracle check at the permission's slippage), run under this wallet × chain's lock, by THIS
     * frame's chain only. Needs the live switch for that wallet and chain on rules >= 2 (the line "the reserve buys the coin and it
     * lands in the wallet, in one transaction" covers it: no new dialog). No day / fee / per-conversion limits (the consent says
     * none): floatCore convertCheck = the $1 minimum and what the reserve holds. A refusal is an answer
     * ({ ok: false, state: 'refused', code, why }), never a throw; only bad arguments throw.
     */
    convert: async (o: unknown) => {
      const a = floatArgs('convert', o); const lang: FloatLang = langOf(a.lang); const c = a.chain as FloatChain;
      const w = walletOf(String(a.walletId)); const cfg = cfgOf(c);
      const want6 = usd6(Number(a.usd));
      type Answer = Record<string, unknown>;
      const no = (code: ConvertCode, v: Record<string, string> = {}, extra: Record<string, unknown> = {}): Answer => ({ ok: false, state: 'refused', code, why: convertWhy(code, lang, v), walletId: w.id, chain: c, ...extra });
      if (c !== here()) return no('lane');
      if (!permissionLive(perms(w), deps.now()) && !anyOffOrder(w)) join(w);
      const p = perms(w);
      if (anyOffOrder(w) || !permissionLive(p, deps.now()) || !p!.chains.includes(c)) return no('off');
      if (rulesOf(p) < DIRECT_BUY_RULES) return no('rules');
      if (want6 < CONVERT_MIN6) return no('min', { min: fmtUsd6(CONVERT_MIN6) });
      if (tradeLive()) return no('trade');
      const run = async (): Promise<Answer> => {
        const jobs = await reconcile(w, c);
        // one move of this lane at a time: a switch-on conversion waiting, or a top-up / sweep / gas move still open
        if (readOrder(w, 'on', c) || jobs.some((j) => isOpen(j) && j.chain === c && (j.kind === 'topup' || j.kind === 'sweep' || j.kind === 'gas'))) return no('busy');
        let s = await readChain(w, c);
        if (priceState(s.priceAt, deps.now()) !== 'fresh' || !(big(s.price6) > 0n)) return no('price');
        // R pays its own fee (reserveGas: motion's gas drop, else W's spare ready native)
        { const g = await reserveGas(w, c, s, jobs, p!.caps.maxSlipBps, 'convert: reserve gas'); if ('code' in g) return no(g.code); s = g.s; }
        const now = deps.now();
        const fee6 = moveFee6(c, 'topup', s.fee || null, now);
        const lim = convertCheck({ usd6: want6, reserve6: stableToUsd6(big(s.reserve), cfg.stable.decimals) });
        if (lim) return no(lim.code, lim.vars, { maxUsd: Number(lim.max6) / 1e6 });
        const { id } = freeJobId(jobs, w.id, 'topup', c, undefined, now);
        const job: FloatJob = { id, walletId: w.id, kind: 'topup', chain: c, usd6: String(want6), fee6: String(fee6), state: 'planned', at: now, updatedAt: now, hashes: [], reason: 'convert', click: true };
        emit(w, id, 'convert', 'active', { chain: c, usd: Number(want6) / 1e6 });
        const saveJob = () => { job.updatedAt = deps.now(); saveJobs(w, c, [...jobs.filter((j) => j.id !== id), job]); };
        // what lands is kept as the coin from the moment its bytes may be out (sent or unknown): the amount the swap simulated from R
        // at signing (never below its floor); a swap that fails on chain drops it again and a smaller fill is trimmed to what W holds
        // (convKept), so nothing of the USD balance is ever held out by a conversion that did not happen
        const keep = () => { const q = big(job.out), m = big(job.minOut); const got = q > m ? q : m; if (got > 0n) convSave(w, c, [...convRead(w, c), { raw: got, at: deps.now(), job: id }]); resnap(w, c, s); return got; };
        const coin = (raw: bigint) => ({ symbol: cfg.native, raw: String(raw), text: fmtNative(raw, cfg.nativeDecimals, cfg.native) });
        try { await runSame(w, job, p!.caps.maxSlipBps, s); }
        catch (e) {
          const out = failOf(job, e);
          if (out === 'deferred') return no('trade');
          saveJob();
          if (out === 'unknown') {
            const got = keep();
            emit(w, id, 'convert', 'unknown', { chain: c, error: job.error });
            return { ok: false, state: 'unknown', walletId: w.id, chain: c, jobId: id, ...(job.hashes.length ? { hash: job.hashes[job.hashes.length - 1] } : {}), usd: Number(want6) / 1e6, coin: { ...coin(got), min: coin(big(job.minOut)) }, why: String(job.error || 'The answer was lost: followed by its hash, never sent again') };
          }
          emit(w, id, 'convert', 'failed', { chain: c, error: job.error });
          const msg = String(job.error || '').slice(0, 120);
          return no(/oracle|quote|fees would eat|minimum/i.test(msg) ? 'quote' : 'failed', { why: msg });
        }
        saveJob();
        const got = keep();
        emit(w, id, 'convert', 'sent', { chain: c, usd: Number(want6) / 1e6, amount: fmtNative(got, cfg.nativeDecimals, cfg.native) });
        return {
          ok: true, state: job.state, walletId: w.id, chain: c, jobId: id, hash: job.hashes[job.hashes.length - 1], usd: Number(want6) / 1e6,
          spent: { symbol: cfg.stable.symbol, raw: String(job.amountIn) }, coin: { ...coin(got), min: coin(big(job.minOut)) }, fee: Number(fee6) / 1e6,
        };
      };
      const r = await deps.lock(lockKey(w, c), () => fastly(run), { waitMs: 3_000 });
      return r ?? no('busy');
    },
    /**
     * (release 9, 2026-11-05) float.withdraw { walletId, chain, usd: number | 'max', to: 'wallet' | 'address', address?, idempotencyKey,
     * lang?, twofa? } — floatCore WITHDRAW_*. ONE transfer of THIS frame's chain's pinned stablecoin out of the wallet's own reserve R,
     * as the stablecoin, to the wallet itself or to an address, with Send's own consent (deps.withdrawOk: outside = the 'withdraw'
     * gate + the vault dialog; own = the 'transfer' gate). The dialog runs BEFORE the lock (the user may take their time); under the
     * lock R is read again and never pays more than the dialog stated or than it holds. No limits. Does not need the switch on
     * (dollars left after a switch-off can come out too), but never beside a switch-on / switch-off conversion or an open move of
     * this wallet × chain. Never to a reserve of the account (no loops). Refusals are answers; Cancelled / TwoFactorRequired throw.
     * The same idempotencyKey again returns the first answer (or 'busy' while it runs) and never sends twice.
     */
    withdraw: async (o: unknown) => {
      const a = floatArgs('withdraw', o); const lang: FloatLang = langOf(a.lang); const c = a.chain as FloatChain;
      const l = listWallets(String(a.walletId)); checkCaller(String(a.walletId), l);
      const w = walletOf(String(a.walletId)); const cfg = cfgOf(c); const sol = cfg.kind === 'sol';
      type Answer = Record<string, unknown>;
      const no = (code: WithdrawCode, v: Record<string, string> = {}, extra: Record<string, unknown> = {}): Answer => ({ ok: false, state: 'refused', code, why: withdrawWhy(code, lang, v), walletId: w.id, chain: c, ...extra });
      const key = WD + String(a.idempotencyKey);
      let prior: { walletId?: string; pending?: boolean; answer?: Answer } | null = null;
      try { prior = JSON.parse(deps.store.get(key) || 'null'); } catch { prior = null; }
      if (prior) {
        if (prior.walletId !== w.id) throw new Error('Bad arguments: idempotencyKey belongs to another withdrawal');
        return prior.answer ? { ...prior.answer, repeat: true } : no('busy');
      }
      if (c !== here()) return no('lane');
      if (!deps.withdrawOk || (sol ? !deps.sol?.withdraw : !deps.evm)) return no('unsupported');
      const to = a.to === 'wallet' ? (sol ? w.w.sol : w.w.evm) : String(a.address);
      if (!to) return no('unsupported');
      const same = (x: string, y: string) => (sol ? x === y : lc(x) === lc(y));
      if (l.list.some((x) => same(sol ? x.r.sol : x.r.evm, to)) || same(sol ? w.r.sol : w.r.evm, to)) return no('address');
      if (anyOffOrder(w) || readOrder(w, 'on', c)) return no('busy');
      if (tradeLive()) return no('trade');
      // what can go: R's liquid stable, read now (the dialog states the exact amount)
      const s0 = await fastly(() => readChain(w, c));
      const liquid0 = big(s0.reserve); const dec = cfg.stable.decimals;
      const have = (raw: bigint) => ({ have: fmtUsd6(stableToUsd6(raw, dec)) });
      const units = a.usd === 'max' ? liquid0 : usd6ToStable(usd6(Number(a.usd)), dec);
      if (units <= 0n || stableToUsd6(units, dec) < WITHDRAW_MIN6 || units > liquid0) return no('amount', have(liquid0), { maxUsd: Number(stableToUsd6(liquid0, dec)) / 1e6 });
      const amount = decimalOf(units, dec);
      const chainName = c === 'robinhood' ? 'Robinhood' : c === 'bsc' ? 'BNB' : 'Solana';
      await deps.withdrawOk({ walletName: w.name, chainName, symbol: cfg.stable.symbol, token: cfg.stable.address, amount, to, ...(typeof a.twofa === 'string' ? { twofa: a.twofa } : {}) });
      const run = async (): Promise<Answer> => {
        // a repeat that raced this one through the dialog: the first one sends, this one does not
        if (deps.store.get(key)) return no('busy');
        const jobs = await reconcile(w, c);
        if (anyOffOrder(w) || readOrder(w, 'on', c) || jobs.some((j) => isOpen(j) && j.chain === c && (j.kind === 'topup' || j.kind === 'sweep' || j.kind === 'gas'))) return no('busy');
        let s = await readChain(w, c);
        if (big(s.reserve) < units) return no('amount', have(big(s.reserve)), { maxUsd: Number(stableToUsd6(big(s.reserve), dec)) / 1e6 });
        { const g = await reserveGas(w, c, s, jobs, perms(w)?.caps.maxSlipBps ?? DEFAULT_CAPS.maxSlipBps, 'withdraw: reserve gas'); if ('code' in g) return no(g.code); s = g.s; }
        const now = deps.now(); const usdOut = Number(stableToUsd6(units, dec)) / 1e6;
        const feeUsd = s.fee ? Number(moveFee6(c, 'gas', s.fee, now)) / 1e6 : null;
        const base: Answer = { walletId: w.id, chain: c, to: a.to, address: sol ? to : lc(to), symbol: cfg.stable.symbol, amount, usd: usdOut, feeUsd };
        deps.store.set(key, JSON.stringify({ walletId: w.id, at: now, pending: true }));   // BEFORE the signature: never twice
        const id = 'wd:' + String(a.idempotencyKey);
        emit(w, id, 'withdraw', 'active', { chain: c, usd: usdOut, to: a.to });
        let hash: string;
        try {
          if (sol) hash = await deps.sol!.withdraw!(w.id, to, units);
          else {
            const e = deps.evm!; const tx = { to: cfg.stable.address as `0x${string}`, data: erc20TransferData(to, units) as `0x${string}`, value: 0n };
            const gas = ((await e.estimate({ ...tx, from: w.r.evm })) * 13n) / 10n;
            hash = await e.sendR(w.id, tx, gas);
          }
        } catch (x) {
          const err = x as Error & { unknown?: boolean; hash?: string; txState?: string };
          if (err.unknown || err.txState === 'unknown' || err.name === 'SolSendUnknown' || err.name === 'FloatUnknown') {
            const ans: Answer = { ok: false, state: 'unknown', ...base, ...(err.hash ? { hash: err.hash } : {}), why: String(err.message || 'The answer was lost').slice(0, 160) };
            deps.store.set(key, JSON.stringify({ walletId: w.id, at: now, answer: ans }));
            emit(w, id, 'withdraw', 'failed', { chain: c, error: ans.why, unknown: true });
            return ans;
          }
          deps.store.del(key);   // nothing was signed or nothing left the vault: the same press may try again
          emit(w, id, 'withdraw', 'failed', { chain: c, error: String(err.message || err).slice(0, 160) });
          return no('failed', { why: String(err.message || err).slice(0, 120) });
        }
        // followed to its landing (≤ 30 s, under the lock: the next move of this lane reads the reserve after it)
        let state: 'sent' | 'confirmed' | 'failed' = 'sent';
        if (sol) { for (let i = 0; i < 30 && state === 'sent'; i++) { const st = await deps.sol!.status(hash).catch(() => null); if (st === 'confirmed') state = 'confirmed'; else if (st === 'failed') state = 'failed'; else await deps.wait(1_000); } }
        else { const r = await deps.evm!.receipt(hash as `0x${string}`, 30_000).catch(() => null); if (r) state = r.status === 'success' ? 'confirmed' : 'failed'; }
        const ans: Answer = state === 'failed'
          ? { ok: false, state: 'failed', ...base, hash, why: 'The transfer failed on chain: only its network fee was spent' }
          : { ok: true, state, ...base, hash };
        deps.store.set(key, JSON.stringify({ walletId: w.id, at: now, answer: ans }));
        emit(w, id, 'withdraw', state === 'failed' ? 'failed' : 'done', { chain: c, usd: usdOut, to: a.to, hash });
        await readChain(w, c).catch(() => null);
        return ans;
      };
      const r = await deps.lock(lockKey(w, c), () => fastly(run), { waitMs: 5_000 });
      return r ?? no('busy');
    },
    /**
     * Earn on the USD balance (src/earnEngine.ts; 2026-11-03, phase 1: Robinhood, USDG, Morpho Steakhouse USDG). { walletId,
     * action: 'on' | 'off', lang?, cap? } — the switch is the account's (every wallet). On: the USD balance must be on, the
     * server's geo answer must allow it, then the 2FA gate and the vault's own dialog; nothing moves at that moment. Off: one
     * dialog, then every wallet's shares come back to its reserve (this frame now, the rest on the next ticks).
     */
    earn: async (o: unknown) => {
      const a = earnArgs(o);
      const l = listWallets(a.walletId); checkCaller(a.walletId, l);
      if (!deps.earn) throw new FloatRefused('Earn arrives with the next wallet update');
      // the history and its tax / PnL export: a read of this device's record, no dialog
      if (a.action === 'history') return deps.earn.history();
      const r = await deps.earn.configure({ action: a.action, lang: a.lang, cap6: a.cap6, chains: a.chains, floatOn: !!accountOn(), hours: a.hours });
      const c = here();
      if (a.action === 'off' && c) for (const w of l.list) await fastly(() => readChain(w, c)).catch(() => null);
      return r;
    },
    // for the vault frame only (webEngine mainSync / mainProfile / mainConsent): never in engine.float, the page cannot call it
    consent,
    // for the vault frame only (webEngine: its own trades' sends and confirmations, the buy from the reserve): never in engine.float
    noteBuy, afterTrade, directFor, directGas, directAllowSoon,
    // for the vault frame only (webEngine, the Elysium USD click): never in engine.float
    liveFor,
    _withinCaps: withinCaps,
  };
}
export type FloatApi = ReturnType<typeof createFloat>;
