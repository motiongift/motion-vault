import { verifyTerminalEvm, simulateTerminalEvm, exactTerminalApproval } from './terminal-evm/vault-guard.mjs';
import { openEvmClaims } from './terminal-evm/claim-store.mjs';
import { verifyEvmFinality } from './terminal-evm/finality.mjs';
import { TERMINAL_EVM_POLICY, TERMINAL_EVM_BNB_VENUES, TERMINAL_EVM_PONS_V2 } from './terminalEvmConfig';
import { FOUR_SELL_QUANTUM } from './terminal-evm/bnb-venues.mjs';
import { assertLegacyTerminalAllowed } from './terminalFeeGate';
import { solTerminalTrade } from './solEngine';
import { TERMINAL_FEE_POLICY } from './terminalFeePolicyConfig';
import { TERMINAL_SOL_POLICY } from './terminalFeeConfig';
// Fee-policy receipts (default OFF). Null config = this whole feature is dead code and the lanes are unchanged.
const FEE_POLICY_SEEN = TERMINAL_FEE_POLICY ? createSeenNonces() : null;
// In-browser wallet vault + trading engine for the Trenches terminal.
//
// Runs without the extension and without any confirmation step: like a
// device keychain. Keys are generated or imported in the page and encrypted
// with AES-GCM-256 under a NON-EXTRACTABLE CryptoKey that lives only in this
// browser's IndexedDB (it can be used by this origin's scripts but never read
// out, copied or exported). The ciphertext lives in localStorage. Decrypted
// keys exist only inside this module's closure — never on window, never
// logged, never sent anywhere. Trades are simulated and signed here and
// broadcast straight to the RPC; the board server never sees a key or a
// transaction. Export shows a key only on a real click, in the engine's own
// dialog, and the engine signs only routes it has verified on chain itself.
import { createPublicClient, createWalletClient, defineChain, http, fallback, parseEther, parseUnits, parseGwei, formatEther, formatUnits, toFunctionSelector, encodeFunctionData, decodeFunctionResult, multicall3Abi, keccak256, recoverMessageAddress, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey, toAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import { terminalFeeDecision, assertQuoteMatchesDecision, createSeenNonces } from './terminal-fee/fee-policy.mjs';
import { NEAR_ACCT, nearAccountId, nearKeys, nearSecretKey, nearPublicKey, nearFullAccess, nearRoute, nearTradeOne, nearPreviewOne, nearBalancesFor, nearTokenBalancesFor, nearTransfer, nearReceipt, nearPrewarm, nearTokenMeta, setNearRpcs, NEAR_DEFAULT_RPCS, NearSendUnknown } from './nearEngine';
import { solJupWarm } from './solEngine';
import { solKeys, solVenueIxs, solSimulateAccounts, solLimitSend, solErrText, solBlockhashInfo, solAccounts, solSigStatusesBoth, sendPlan as solSendPlan, compileLegacy as solCompile, solBudget, signMessage as solSignMessage } from './solEngine';
import { createSolLimit } from './solLimitEngine';
import { feeLegFor, bpsFor, type FeeChain, type FeeLegConfig, TERMINAL_FEE_LEG } from './terminalFeeLeg';
import { solOrderIdOf, solOrderKeys, solAuthTextProblem } from './solLimitCore';
import { SOL_ADDR, solAddressOf, solSecretKey, solSignText, solBridgeDeposit, RELAY_SOL_CHAIN, solRoute, solTradeOne, solPreviewOne, solBalancesFor, solTokenBalancesFor, solTransfer, solTokenTransfer, solUnwrap, solWsolBalancesFor, toUnits, solReceipt, solTokenMeta, SolSendUnknown, setSolRpcs, setSolApiBase, type SolAcct } from './solEngine';
import { BRIDGE_CHAINS, bridgeBalances, bridgeDeposit, bridgeSend, bridgeReceipt, type BridgeQuoteLite } from './bridgeEngine';
import { setRelayProxyBase, relayQuote, relayStatus, evmStepsProblem, solStepsProblem, independentOut, priceProblem, NATIVE_EVM, NATIVE_SOL } from './relayApi';
import { nativeDonorTxProblem } from './nativeDonor';
import { bindSwap, evmSwapSend, solSwapSend, swapRequestProblem, relayTokenBalances, type SwapBound } from './relaySwap';
import {
  bootVault, resetVault, openWith, lostBlobs, unrecovered, webLocker, KEY_LOCK, LOST_PREFIX, type Boot, type KeyStore, type LostBlob,
  bytesHex, seedOfSignature, fingerprint, subKeyV1, subKeyV2With, MAIN_MSG, type MainMsgVersion,
  openProfile, buildProfile, storageHealth, backupNudge, type Profile, type ProfileEntry, type BackupWallet, type OpenedWallet,
  RECOVERY_MSG, sealRecovery, openRecovery, validRecovery, type RecoveryBlob,
} from './vaultRecovery';
// backup v4: a passkey (WebAuthn PRF of a credential scoped to the vault's own host) as the second factor (src/passkeyBackup.ts)
import {
  normPk, coresOf, checkDk, newCore, addSlot, removeSlot, setCode, dkFromPrf, dkFromCode, newRecoveryCode, parseRecoveryCode,
  stageDigest, canon, createOptions, getOptions, getOptionsRaw, readPrf, readAuthData, providerName, rpIdFor, recoveryPaths,
  upgradeProfile, downgradeProfile, verifyStaged, PASSKEY_POLICY, type PkEnvelope,
} from './passkeyBackup';
// the USD-balance consent that follows the account (sealed + signed in its backup profile; owner 2026-10-28)
import { consentReceive, consentOutgoing, type Own } from './floatConsent';
// legacy phone-access copies (V12 F-28 follow-up, 2026-10-28): the update / adopt migration and its dialogs
import { recoveryBodyVersion, adoptCheck, localOnly, rkLangOf, UPDATE_DIALOG, REMOVE_DIALOG, UNBACKED_SEND, type RkLang } from './rkMigrate';
import { pkT, pkStepHtml, pkWarnKey, PK_DLG_RULES, type PkKey, type PkParams } from './passkeyCopy';
import {
  UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, PERMIT2, PERMIT2_ABI, MAX_UINT160, MAX_UINT48, V4_QUOTER, V4_QUOTER_ABI, NATIVE_CURRENCY,
  encodeV4BuyNative, encodeV4BuyViaPath, encodeV4BuyViaWeth, encodeV4Sell, encodeV4SellViaPath, encodeV3Path, v4PairCurrency, type V4PoolKey, KNOWN_LAUNCHER_HOOKS,
  DYNAMIC_FEE_FLAG, MAX_STATIC_FEE,
} from './evmV4Router';
import { STANDARD, STANDARD_ROUTER_ABI, STANDARD_FACTORY_ABI, STANDARD_CURVE_ABI, V4_QUOTER_PATH_ABI, NO_FEE, standardPath, encodeStandardSwap, sameHop, type StdHop } from './standardRouter';
import {
  BSC, FOUR_MANAGER_ABI, FOUR_HELPER_ABI, FLAP_PORTAL_ABI, PANCAKE_V2_ROUTER_ABI, CL_QUOTER_ABI, V3_QUOTER_ABI,
  encodeInfBuyNative, encodeInfBuyViaPath, encodeInfBuyViaWrapped, encodeInfSell, encodeInfSellViaPath, infPairCurrency, type InfPoolKey,
} from './bnbRouter';
import { readKey, KEY_TEXT, CHAIN_LABEL, type KeyCandidate } from './importKey';
import { nativeChainOf, nativeSlotOf, nativeAddress, nativeSecret, storableKey, NEAR_NAMED } from './nativeKeys';
// perps phase 2 (2026-10-22): Lighter on Robinhood Chain — src/perpsEngine.ts, the signer in src/lighter/signer.ts
import { createPerps, type LtRec, type Pc } from './perpsEngine';
import { loadSigner, SIGNER, LIGHTER_CHAIN_ID } from './lighter/signer';
import { l1TextProblem, ltMerge, apiKeySeed, API_KEY_INDEX } from './lighter/perpsCore';
// V13 hardening (security audit 2026-10-25): the pure decisions, shared with the tests (test/v13-*.mjs)
import {
  MAX_BUY, tradeSizeProblem, ledgerAdd, BUY_WINDOW_MS, SLIP_SILENT, slipCeiling, slipNeedsClick, routeSig, sameRoute, selfCanonical, v2UnknownHops,
  v4Candidates, infCandidates, sameKey, pickPool, BRIDGE_APP_FEE, relayQuoteProblem, needsChallenge, challengeCode, challengeOk, tooSoon,
} from './v13Guards';
// limit orders v1 (2026-10-22): a per-order wallet + a pre-signed swap the keeper broadcasts — src/limitEngine.ts, src/limitCore.ts
import { createLimit, type OrderSigner } from './limitEngine';
import { orderKey, orderIdOf, authTextProblem, LIMIT_CHAIN_ID, BSC_CHAIN_ID } from './limitCore';
// one USD balance (2026-10-25, owner-only, NOT released): src/floatEngine.ts + the pure src/floatCore.ts
import { createFloat, FloatUnknown, type EvmTx, type FloatWallet, type FloatWalletList } from './floatEngine';
// Earn on the USD balance (2026-11-03, phase 1: Robinhood, USDG, Morpho Steakhouse USDG; NOT released)
import { createEarn, type EarnWallet } from './earnEngine';
import { EARN, earnVenueOf, earnTxProblem, type EarnTx } from './earnCore';
import { kaminoIxsProblem, readReserve, kPinnedOracles, KAMINO_SOL, KAMINO_UNITS, KAMINO_MICRO, type KIx, type ReserveRead } from './earnKamino';
import { inClickWindow } from './floatCore';
import { reserveKeyOf, FLOAT_CFG, bucket as floatBucketOf, afterTrade, FLOAT_DLG_RULES, SOL_FWD, SOL_BRIDGE, oraclePrice6 as floatOraclePrice6, solDirectNeedOf, type FloatChain } from './floatCore';
import { solFloatRoute, solFloatPrice6, solFloatQuote, solFloatSwapIxs, solFloatPayIx, solFloatTokenPayIxs, solFloatSend, solRpc as solFloatRpc, ataOf as solFloatAta } from './solEngine';
// motion's own bridge (2026-10-26, owner-only, NOT released): src/bridgeSolver.ts + the pure src/motionBridgeCore.ts.
// The vault only ever signs ONE transfer of the quoted amount to the solver's published deposit address.
import { P as SOL_P, b58e as solB58e } from './solEngine';
// one USD balance: the buy straight from the reserve (owner 2026-10-29; solEngine's appended section, src/floatDirect.ts)
import { solDirectBuy, SolDirectNoGas } from './solEngine';
// …under a pre-send deadline that lets go of the trade guard when the build stalls before anything is sent (owner 2026-11-01)
import { preSendDeadline, PRE_SEND_MS, LATE_TEXT } from './preSendDeadline';
// turbo's gas limit fits the route, picked synchronously from the route shape (owner 2026-11-01: “full go-ahead”)
import { turboGas } from './turboGas';
import { usdBuyArgs } from './floatDirect';
// …and on Robinhood / BNB (owner 2026-10-29 “approved, and ship everything that is left too”; src/usdBuyEvm.ts)
import { evmDirectPlan, probeCall, decodeProbe, evmDirectGuard, evmPriceCheck, routerOut, minOutOf, PROBE_RUNTIME, DirectUnsupported, USD_BUY_ROUTER_ABI, CURVE_BUY_MAX_USD, type EvmChain, type EvmRoute, type EvmPlan } from './usdBuyEvm';
import { erc20TransferData as bridgeTransferData } from './motionBridgeCore';
import { solBridgeTransferIxs, solBridgeNativeIxs } from './bridgeSolver';
import { createSolverBridge, SolverRefused, SolverUnknown } from './bridgeSolver';
import { bridgeCfg as mbCfg, v3Price6 as mbPrice6, NATIVE_TOKEN as MB_NATIVE, NATIVE_SOL_TOKEN as MB_NATIVE_SOL } from './motionBridgeCore';
import { exitCall as elyExitCall, exitProblem as elyExitProblem, EXIT_DAYS as ELY_EXIT_DAYS } from './elysiumExitCore';
// Elysium (trade-core.patch E1; owner's yes needed): the pure decisions of the Elysium trade path (src/elysiumCore.ts)
import * as ELY from './elysiumCore';
// (2026-11-04) a buy on Elysium paid from the USD balance: the Elysium frame's float.ensure { chain: 'elysium' } (src/elysiumUsdEngine.ts)
import { createElyUsd } from './elysiumUsdEngine';
import { createElyHyperFund } from './elysiumHyperFund';   // (release 6) HyperEVM HYPE → Elysium HYPE through motion's bridge, 0.1 %
import { createElyRoute, pickRoute as pickElyRoute, ELY_ROUTE, ELY_ROUTE_SRC, type SrcChain as ElyRouteSrc, type SrcCoin as ElyRouteCoin, type FloatHealth as ElyFloatHealth } from './elysiumRoute';   // (2026-11-04) the official route into Elysium

// The page says which chain it is on (chain.js loads first); the same vault
// keys sign on every EVM chain, so only the endpoints and venues change.
type ChainCfg = {
  id: number; key: string; name: string; symbol: string; rpc: string; rpc2: string; rpcSingle?: string; explorer: string;
  wrapped: `0x${string}`; stable: `0x${string}`; v3Router: `0x${string}`; v2Router?: `0x${string}`;
  universalRouter: `0x${string}`; permit2: `0x${string}`;
  // The venue entry points this chain is allowed to trade through and the
  // assets a bridge leg may pass through. The indexer proposes a route; the
  // engine signs only when the proposal lands on one of these.
  ponsFactory?: `0x${string}`; fourManager?: `0x${string}`; fourHelper?: `0x${string}`; flapPortal?: `0x${string}`; infPoolManager?: `0x${string}`;
  standard?: typeof STANDARD;
  knownHooks: string[]; bridgeTokens: string[];
  // TC-R1 (exec-quality 2026-11-04): send-only roads every signed transaction is ALSO posted to (never a read): the chain's own
  // sequencer endpoint, which accepts only eth_sendRawTransaction(Conditional) — one hop less than a node that forwards to it
  sendOnly?: string[];
  // TC-M1: MEV-protected send roads (private builders / protect RPCs). With MEV protection on for this lane, a signed
  // transaction goes ONLY to these (and the user's own send-only nodes), never to a public-mempool node
  privateSend?: string[];
  // F-73 (V12): hard ceilings so a spoofed node / fee read cannot drain a wallet on fees.
  // maxGasPrice ≈ 20× the observed p99 gas price for the chain (feeFloor throws above it);
  // maxFeeWei caps the absolute gas*price a single transaction may pay. Generous on purpose.
  maxGasPrice?: bigint; maxFeeWei?: bigint;
};
const CHAIN_CFGS: Record<string, ChainCfg> = {
  robinhood: {
    id: 4663, key: 'robinhood', name: 'Robinhood Chain', symbol: 'ETH', rpc: 'https://robinhood-rpc.publicnode.com', rpc2: 'https://rpc.mainnet.chain.robinhood.com',
    rpcSingle: 'https://robinhood.drpc.org',   // single requests only (no batches): the heavy path's second node; the official node's 429 carries a doubled CORS header and is unreadable from a browser
    explorer: 'https://robin.etherscan.io', wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', stable: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    v3Router: '0xcaf681a66d020601342297493863e78c959e5cb2', universalRouter: UNIVERSAL_ROUTER as `0x${string}`, permit2: PERMIT2 as `0x${string}`,
    ponsFactory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    flapPortal: '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',   // Flap's Portal on Robinhood (same contract family as on BNB)
    standard: STANDARD,   // standardreserve.xyz: stock-quoted curves → V4 pools behind its hook (src/standardRouter.ts)
    knownHooks: [...KNOWN_LAUNCHER_HOOKS, '0x745d717620052a97a22deee2e5eba59583f3e0cc'],   // Pons V4, Long (Doppler), DART
    bridgeTokens: ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'],   // WETH, USDG
    maxGasPrice: parseGwei('20'), maxFeeWei: parseEther('0.1'),   // F-73: generous placeholders — confirm against live p99 (this L2's gas is sub-gwei)
    // measured 2026-11-04 from a browser origin (vault.motion.gift): CORS *, 111-113 ms from Spain (publicnode 44-47 ms, which
    // forwards to it); answers only sends. First accept wins, so it costs nothing when a closer node is faster
    sendOnly: ['https://sequencer.mainnet.chain.robinhood.com'],
  },
  bsc: {
    id: BSC.id, key: 'bsc', name: 'BNB Chain', symbol: 'BNB', rpc: BSC.rpc, rpc2: BSC.rpc2, rpcSingle: BSC.rpcSingle, explorer: BSC.explorer, wrapped: BSC.wrapped, stable: BSC.stable,
    v3Router: BSC.v3Router, v2Router: BSC.v2Router, universalRouter: BSC.universalRouter, permit2: BSC.permit2,
    ponsFactory: '0x78eae9537c0ef90dfe9b7ae964682fe8138afe31',   // genius.fun (Pons V2 family)
    fourManager: BSC.fourManager, fourHelper: BSC.fourHelper, flapPortal: BSC.flapPortal, infPoolManager: BSC.clPoolManager,
    knownHooks: ['0xff17f41c5efd6cce944af0912f300097d62df5c9'],   // genius.fun Infinity hook
    // WBNB, USDT, USDC, USD1, BTCB, ETH — what a bridge leg may pass through on the way to a quote asset
    bridgeTokens: [BSC.wrapped, BSC.stable, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8'],
    maxGasPrice: parseGwei('50'), maxFeeWei: parseEther('0.5'),   // F-73: generous placeholders — BSC floor is ~1 gwei, spikes a few gwei; confirm against live p99
    // TC-M1: private builders / protect RPCs, each measured 2026-11-04 from a browser origin: CORS *, eth_chainId 0x38 in
    // 44-62 ms p50 (publicnode 55-61 ms). 48 Club (Puissant) + BlockRazor built ~96 % of BSC blocks May–Nov 2025; bloXroute
    // and PancakeSwap's MEV Guard reach the others. bsc.merkle.io refuses browser preflight (405) and is not listed.
    // MEV v2 (2026-11-04): BlockRazor's /fullprivacy (straight to the builders, nothing shared with searchers; the default
    // endpoint discloses hash, logs and state to searchers for backrun refunds). Same host, same CORS *, 61 ms p50.
    privateSend: ['https://rpc-bsc.48.club', 'https://bsc.blockrazor.xyz/fullprivacy', 'https://bsc.rpc.blxrbdn.com', 'https://bscrpc.pancakeswap.finance'],
  },
  // Elysium (trade-core.patch E2; owner's yes needed): Kinetiq's Orbit L2 on HyperEVM, gas HYPE, one sequencer, no public mempool.
  // It trades ONLY through the ELYSIUM section below (src/elysiumCore.ts: Uniswap's and ElysPump's V3 / V4 pools through the
  // Universal Router bound to each); none of the Robinhood / BNB venue fields is ever read for it (v3Router / stable are 0x0 so
  // a path that reached one by mistake would fail instead of trading somewhere else). Nodes: motion's Elysium relay (the lane's
  // POST /elysium/api/rpc, a keyed provider behind it, trade methods only) — the vault never reads or broadcasts through a
  // third-party launchpad node (a node that sees a signed transaction first could trade ahead of it: there is no mempool to
  // race in). TODO 9 Nov: Kinetiq's official public RPC as rpc2 once published, and the explorer.
  elysium: {
    id: ELY.ELY_CHAIN_ID, key: 'elysium', name: 'Elysium', symbol: 'HYPE', rpc: 'https://motion.gift/elysium/api/rpc', rpc2: 'https://motion.gift/elysium/api/rpc',
    explorer: 'https://elysium.kinetiq.xyz/explorer',
    wrapped: ELY.ELY_WHYPE, stable: ELY.ELY_ZERO, v3Router: ELY.ELY_ZERO,
    universalRouter: ELY.ELY_VENUES['uni-v4'].router, permit2: ELY.ELY_PERMIT2,
    knownHooks: [], bridgeTokens: [ELY.ELY_WHYPE],
    maxGasPrice: ELY.ELY_MAX_GAS_PRICE, maxFeeWei: ELY.ELY_MAX_FEE_WEI,   // F-73: the chain's floor is 0.1 gwei (read 2026-11-03)
  },
};
// Host mode: this module is running inside the vault frame (vault.html on the
// vault origin), not inline in a page. The frame is told its chain in the URL;
// the parent page is the only thing that may talk to it, over postMessage, and
// only from an origin on this list. Everything the page can ask for goes
// through call(); nothing in this module is ever reachable from the parent's
// JavaScript directly, because the browser's same-origin policy keeps the two
// documents apart. That is the whole point of the separate origin.
const HOST = typeof window !== 'undefined' && window.parent !== window && document.documentElement.dataset.vaultHost === '1';
// copytrade.gg is a legacy host: it embeds its frame on its own origin (o === location.origin), never this one.
// A loopback parent is a development build's only (a production frame never answers a page on localhost).
const PARENT_ORIGINS = ['https://motion.gift', 'https://www.motion.gift'];
const DEV_BUILD = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
const parentAllowed = (o: string) => PARENT_ORIGINS.includes(o) || o === location.origin || (DEV_BUILD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
let parentWin: Window | null = null;
let parentOrigin = '';
const post = (msg: Record<string, unknown>) => { if (HOST && parentWin && parentOrigin) parentWin.postMessage(msg, parentOrigin); };
// the Solana engine's /sol/api calls (RPC relay, route, tip floor, price) go to the terminal that framed the vault, like 2FA
setSolApiBase(() => (HOST && parentOrigin ? parentOrigin : location.origin));
const urlChain = typeof location !== 'undefined' ? new URL(location.href).searchParams.get('chain') || '' : '';
const pageChain = String(urlChain || (typeof window !== 'undefined' ? (window as unknown as { TrenchChain?: { key?: string } }).TrenchChain?.key : '') || '');
// (trade-core.patch E3) an EVM chain this engine does not know is refused — it used to run Robinhood's whole config (nodes, WETH,
// routers) under another chain's page; the frames that are not an EVM lane of their own (Solana, NEAR, Arc, an empty chain)
// keep Robinhood's as before
if (pageChain && !CHAIN_CFGS[pageChain] && !['sol', 'near', 'arc'].includes(pageChain)) throw new Error(`the vault does not trade on ${pageChain.slice(0, 24)} yet`);
const CFG = CHAIN_CFGS[pageChain] || CHAIN_CFGS.robinhood;
// the frame opened for the NEAR lane: same wallets, NEAR identities, Rhea DCL swaps (src/nearEngine.ts)
const NEAR_MODE = pageChain === 'near';
// the frame opened for the Solana lane: same wallets, Solana identities, pump.fun / PumpSwap / Meteora DLMM trades (src/solEngine.ts)
const SOL_MODE = pageChain === 'sol';
const RPC = CFG.rpc;
const RPC2 = CFG.rpc2;
const USDG = CFG.stable;
const WETH = CFG.wrapped;
const UNISWAP_V3_ROUTER = CFG.v3Router;     // Uniswap V3 on Robinhood, PancakeSwap SmartRouter on BNB: same exactInput shape
const NATIVE = CFG.symbol;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const MAX_BUY_ETH = 100;

// Multicall3 — one eth_call reads every wallet's native and token balance; a burst of per-wallet
// calls is exactly what publicnode refuses, and a refused read used to look like an empty wallet.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const chain = defineChain({
  id: CFG.id, name: CFG.name, nativeCurrency: { name: CFG.symbol, symbol: CFG.symbol, decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, blockExplorers: { default: { name: 'Explorer', url: CFG.explorer } },
  contracts: { multicall3: { address: MULTICALL3 } },
});
// Batched JSON-RPC keeps the portfolio's per-wallet reads under publicnode's
// per-second limit; the second node takes over when the first answers 429.
// The endpoints come from Settings → RPC (a user's own Alchemy/QuickNode/dRPC
// node in front of the defaults); the clients are rebuilt the moment they change.
const DEFAULT_RPCS = [RPC, RPC2];
const isRpcUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(u);
const rpcPick = (): { primary?: string; secondary?: string; send?: string[] } => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').rpcs?.[CFG.key] || {}; } catch { return {}; } };
function rpcUrlsFromSettings(): string[] {
  const custom = rpcPick();
  const list = [custom.primary, custom.secondary, ...DEFAULT_RPCS].filter(isRpcUrl);
  return [...new Set(list)];
}
// Trades-only nodes: they never see a quote or a balance read, but every signed
// transaction is posted to them too — a paid node close to the sequencer can
// win the race to inclusion without becoming the page's read path.
const sendUrlsFromSettings = (): string[] => [...new Set((rpcPick().send || []).filter(isRpcUrl))].slice(0, 3);
let rpcUrls = rpcUrlsFromSettings();
let sendOnlyUrls = sendUrlsFromSettings();
// TC-M1: with MEV protection on for this lane (and private roads known for it), the public-mempool nodes (the default read nodes
// AND the user's read nodes) never get the signed bytes first: only the private roads do (MEV v2: the rest only as the fallback).
// TC-R1: the chain's send-only roads (Robinhood's sequencer) ride along on every send.
// MEV v2: the user's trades-only nodes are not known to be private (a paid QuickNode / Alchemy node forwards to the public
// mempool): with protection on they get the bytes with the public roads (hedge / refusal / fallback), not before them
const broadcastUrls = () => (mevOn() && CFG.privateSend?.length)
  ? [...new Set(CFG.privateSend)]
  : [...new Set([...sendOnlyUrls, ...readUrls(), ...(CFG.sendOnly || [])])];
// Measured on publicnode (2026-10-13): a JSON-RPC *batch* of 4+ heavy calls
// (quoter eth_call, estimateGas) is refused with a slow 429 (0.2-0.8 s), while
// the same calls as parallel single requests are served in ~100 ms; the
// official node accepts ~5 concurrent requests and answers a batch flood with
// a Cloudflare challenge page. So cheap shared reads stay batched (one HTTP
// request) and every heavy per-wallet call goes out unbatched through `heavy`.
// The fallback retries at most one more round (viem's default is three rounds
// of 150·2^n ms waits with a 10 s timeout each — a click could hang 40 s) and
// a node that does not answer in 6 s hands the call to the next one.
const RPC_TIMEOUT = 6000;
// node order for reads: the user's/primary node, then the single-request node (never batched: it refuses arrays), then the official one
const readUrls = () => { const l = [...rpcUrls]; const one = CFG.rpcSingle; if (isRpcUrl(one) && !l.includes(one)) { const i = l.indexOf(RPC2); l.splice(i > 0 ? i : l.length, 0, one); } return l; };
// V13 (speed, G11): batch window 0 instead of 16 ms — the click's reads are issued in one tick, so they still share one
// HTTP request; every click and every receipt poll stops paying 16 ms of waiting
const mkTransport = (urls: string[], batch: boolean) => fallback(urls.map((u) => http(u, { ...(batch && u !== CFG.rpcSingle ? { batch: { wait: 0 } } : {}), timeout: RPC_TIMEOUT })), { rank: false, retryCount: 1, retryDelay: 200 });
let transport = mkTransport(readUrls(), true);
let publicClient = createPublicClient({ chain, transport });
let heavy = createPublicClient({ chain, transport: mkTransport(readUrls(), false) });
// The per-wallet heavy calls of one click (eth_estimateGas, router simulations)
// are spread three wallets per node, each node keeping the others as fallback:
// publicnode served 6 parallel estimates of one click with 4×429 under load
// (measured 2026-10-14; the fallback then cost +100-300 ms), while 2-3 per node
// never tripped a limit. Only on the default nodes — a user's own paid primary
// takes the whole burst.
// V13 (speed, G17): the official node (RPC2: quoter ~113 ms vs ~60 on publicnode) never heads a ring, it stays every ring's fallback
const mkHeavyRing = () => { const u = readUrls(); const heads = u.filter((x) => x !== RPC2); return (heads.length ? heads : u).map((h) => createPublicClient({ chain, transport: mkTransport([h, ...u.filter((x) => x !== h)], false) })); };
let heavyRing = mkHeavyRing();
const heavyFor = (i: number) => (i < 3 || rpcUrls[0] !== RPC ? heavy : heavyRing[Math.floor(i / 3) % heavyRing.length]);
function rebuildClients() {
  sendOnlyUrls = sendUrlsFromSettings();
  const next = rpcUrlsFromSettings();
  if (next.join('|') === rpcUrls.join('|')) return false;
  rpcUrls = next; transport = mkTransport(readUrls(), true); publicClient = createPublicClient({ chain, transport });
  heavy = createPublicClient({ chain, transport: mkTransport(readUrls(), false) });
  heavyRing = mkHeavyRing();
  return true;
}
// Reads that are the same for every wallet in one click (the quote, the curve
// reserves, the balance sheet) are made once and shared: N wallets used to
// mean N identical quoter simulations in one batch, which is exactly the
// burst the node refuses. Values are unchanged — every wallet would have
// received the same answer a few milliseconds apart.
// The state of a wallet's transaction as the page shows it, one vocabulary for every chain:
// not_started (refused before a transaction existed: the balance guard, the route, the quote),
// preparing, signed (signed; a node's refusal leaves it here — nothing reached the chain),
// submitted (a node accepted it), pending / confirmed / reverted (what the receipt says),
// unknown (every node timed out or dropped the socket: it may still land — never re-sent by itself).
type TxState = 'not_started' | 'preparing' | 'signed' | 'submitted' | 'pending' | 'confirmed' | 'reverted' | 'unknown';
type TxRec = { hash: string; state: TxState };
type WalletLog = { state: TxState; stages: Record<string, number>; txs: TxRec[] };
// the live feed of those states: 'trench:tx' { id (the click), address, state, hash?, error? } — the vault frame forwards it to the page
const txEvent = (detail: { id: string; address: string; state: TxState; hash?: string; error?: string }) => { try { document.dispatchEvent(new CustomEvent('trench:tx', { detail })); } catch {} };
type Shared = { addresses: `0x${string}`[]; once: <T>(key: string, fn: () => Promise<T>) => Promise<T>; t: Record<string, number>; mark: (stage: string, ms: number) => void;
  id: string; w: Record<string, WalletLog>; view: (address: string) => Shared; note: (state: TxState, hash?: string, error?: string) => void };
// `t` is the click's stage clock (ms per stage, the slowest wallet of the click
// wins each stage); it comes back to the page as `timing` so a slow buy says
// where the time went. view(address) is the same click seen by one wallet: its
// own stage clock and transaction states (`w`), which come back per wallet.
const makeShared = (addresses: `0x${string}`[], id = ''): Shared => {
  const m = new Map<string, Promise<unknown>>();
  const t: Record<string, number> = {};
  const w: Record<string, WalletLog> = {};
  const once = <T,>(key: string, fn: () => Promise<T>) => { let p = m.get(key); if (!p) { p = fn(); m.set(key, p); } return p as Promise<T>; };
  const make = (who: string): Shared => {
    const log = who ? (w[lc(who)] ||= { state: 'preparing', stages: {}, txs: [] }) : null;
    return { addresses, t, w, id, once, view: (a) => make(a),
      mark: (stage, ms) => { t[stage] = Math.max(t[stage] ?? 0, Math.round(ms)); if (log) log.stages[stage] = (log.stages[stage] ?? 0) + Math.round(ms); },
      note: (state, hash, error) => {
        if (!log) return;
        log.state = state;
        if (hash) { const x = log.txs.find((r) => r.hash === hash); if (x) x.state = state; else if (state !== 'signed') log.txs.push({ hash, state }); }
        txEvent({ id, address: who, state, ...(hash ? { hash } : {}), ...(error ? { error } : {}) });
      } };
  };
  return make('');
};
// A signed transaction goes to every endpoint at the same time; the first node
// that accepts it wins and the rest just see "already known". One slow or
// hiccuping node no longer decides when a buy lands.
// A refusal that says nothing about the transaction (a 429, a challenge page,
// a dropped socket) from every node at once gets two more rounds, 250 ms and ~0.9 s later —
// the same signed bytes, nothing re-signed; a verdict about the tx itself
// (nonce, funds, revert) is final.
const THROTTLED = /rate limit|too many|limit exceeded|429|unexpected token|not valid json|failed to fetch|timed out|timeout|aborted|network|load failed|no result/i;
// …of those, the ones after which nobody can say whether a node took the transaction (the request may have
// been processed and only the answer lost). A 429 or a challenge page is a refusal: nothing was accepted.
const LOST = /failed to fetch|timed out|timeout|aborted|network|load failed/i;
// review: refusals every node gives alike, from the chain's state (not a node's policy such as its price floor)
const STATE_REFUSAL = /insufficient funds|nonce too low|nonce has already been used|intrinsic gas too low|exceeds block gas limit/i;
type SendError = Error & { txState?: TxState; hash?: `0x${string}`; nonce?: number };
let lastBroadcastNode = '';   // the node that accepted the last signed transaction first (for the timing report)
// MEV v2: how the last signed transaction got out (timing report): 'public' (protection off / no private roads), 'private'
// (a private road accepted it first and nothing public was asked), 'public-slow' (no private answer within MEV_HEDGE_MS),
// 'public-refused' (every private road refused it), 'private+public-slow' (a private road won after the hedge fired)
let lastBroadcastPath = '';
// ── MEV v2 (mev-v2 2026-11-04): BNB private-first, the SAME signed bytes to the public node as the fallback ──
// Measured 2026-11-04 from a browser origin (local mev-v2/report.txt): 48 Club (rpc-bsc / rpc), BlockRazor (default and
// /fullprivacy), bloXroute, PancakeSwap MEV Guard and publicnode all refuse a legacy tx below 0.05 gwei ("minimum needed
// 50000000") and take it from 0.05 gwei (a 0-BNB throwaway key: the price check answers before the funds check). The
// 1 gwei (48 Club) / 0.1 gwei (BlockRazor) their eth_gasPrice says is a suggestion, not the floor. In 1,332 live blocks
// (10 min) both builders included privately sent swaps at 0.05-0.094 gwei (78-80 % of them; p50 0.06), as they do public
// ones. BNB block = 450 ms; a block is visible on the receipt node (bloXroute) 152 ms p50 / 213 ms p90 after its timestamp.
// With protection on, a BNB transaction is never priced under MEV_MIN_GAS = that 0.05 gwei floor: today's prices (Fast
// 0.094, Eco 0.0625) are above it, so nothing costs more; it only stops a node's low eth_gasPrice from making every road
// refuse. Raising it to 0.1 (BlockRazor's quote) would cost +$0.0008 (Fast) / +$0.005 (Eco) per 200k-gas trade at $686.
const MEV_MIN_GAS = 50_000_000n;
// no private road answered in this long → the public roads get the same bytes too (the private roads answer in 55-62 ms
// p50, 61-68 ms p90, cold 58-170 ms): a slow or hung builder never holds a click longer than this
const MEV_HEDGE_MS = 250;
// accepted privately, no receipt seen this long after → the same bytes go to the public node: one block (450 ms) + the
// receipt node's p90 visibility lag (~220 ms) + margin. Same bytes = same hash, same nonce: at most one ever lands.
const MEV_FALLBACK_MS = 700;
// while a privately accepted tx may be unseen by the public node, the wallet's next nonce is never read lower than it + 1
const MEV_HOLD_MS = 30_000;
const mevPrivate = () => !SOL_MODE && !NEAR_MODE && !!CFG.privateSend?.length && mevOn();
// the fallback roads: today's public set (the user's trades-only nodes, the user's read nodes, the default nodes, the chain's
// send-only roads) minus the private roads already asked
const publicSendUrls = () => { const asked = new Set(CFG.privateSend || []); return [...new Set([...sendOnlyUrls, ...readUrls(), ...(CFG.sendOnly || [])])].filter((u) => !asked.has(u)); };
const privHold = new Map<string, { nonce: number; hash: string; at: number; ttl?: number }>();
const holdNonce = (address: string, n: number) => { const h = privHold.get(address.toLowerCase()); return h && Date.now() - h.at < (h.ttl ?? MEV_HOLD_MS) ? Math.max(n, h.nonce + 1) : n; };
const releaseHold = (hash: string) => { const k = hash.toLowerCase(); for (const [a, h] of privHold) if (h.hash === k) { privHold.delete(a); holdBus?.postMessage({ a, n: h.nonce, h: k, drop: true }); } };
// review (mev-v2-review 2026-11-04): the vault frames of one browser (same origin, same chain) share their private holds, so a
// second tab on the same wallet never signs over a nonce only a private road holds (the public node it reads cannot see it).
// A copy lives only through the private-only window (the fallback puts the bytes on the public node by then), never 30 s:
// a copy of a tx that then died can delay the other tab by at most this long, never strand it
const MEV_SHARED_HOLD_MS = MEV_FALLBACK_MS + 1500;
const holdBus = (() => {
  if (typeof BroadcastChannel === 'undefined') return null;
  const b = new BroadcastChannel('motion-mev-hold.' + CFG.key);
  b.onmessage = (e: MessageEvent) => {
    const m = e.data as { a?: unknown; n?: unknown; h?: unknown; drop?: unknown };
    if (!m || typeof m.a !== 'string' || typeof m.h !== 'string' || typeof m.n !== 'number' || !Number.isSafeInteger(m.n) || m.n < 0) return;
    const a = m.a.toLowerCase(), hh = m.h.toLowerCase(), h = privHold.get(a);
    if (m.drop) { if (h && h.hash === hh) privHold.delete(a); return; }
    if (!h || h.nonce <= m.n) privHold.set(a, { nonce: m.n, hash: hh, at: Date.now(), ttl: MEV_SHARED_HOLD_MS });
  };
  (b as { unref?: () => void }).unref?.();   // (Node tests only; browsers have no unref)
  return b;
})();
const includedTx = new Set<string>();   // hashes a receipt was seen for (landed): their fallback is skipped
// one eth_sendRawTransaction to one road; F-41 (V12): the transaction's hash is keccak256(raw) — computed here, never taken
// from the node. A node that reports a DIFFERENT hash is lying about what it accepted (a proxy that re-signed or swapped the
// tx): reject it, never follow or settle a hash we did not compute. Every success returns `local`.
async function postRaw(u: string, raw: `0x${string}`, local: `0x${string}`, errors: string[]): Promise<`0x${string}`> {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }), signal: AbortSignal.timeout(8000) }).then((x) => x.json());
  if (r?.result) { if (String(r.result).toLowerCase() !== local.toLowerCase()) { errors.push('node returned a different transaction hash'); throw new Error('node returned a different transaction hash'); } return local; }
  const msg = String(r?.error?.message || 'no result');
  // a node that already has it (from a faster sibling, or from the first round) holds it: that is a success
  if (/already known|known transaction|already imported/i.test(msg)) return local;
  errors.push(msg); throw new Error(msg);
}
// MEV v2: a privately accepted transaction that no receipt shows MEV_FALLBACK_MS later goes to the public roads, same bytes.
// "accepted but never included", "accepted then dropped" (revert protection), a builder that lost the slot: all end here.
// Its nonce is held for the wallet meanwhile (holdNonce), so a fresh nonce read from the public node — which cannot see a
// privately pending tx — never re-uses it. A definitive public refusal (the tx itself is bad) drops the hold and the cached
// counter, so the next send re-reads the chain and can never queue behind a nonce nobody holds.
function mevFallback(raw: `0x${string}`, hash: `0x${string}`, who?: { from: string; nonce: number }) {
  if (who) { const k = who.from.toLowerCase(), h = privHold.get(k); if (!h || h.nonce <= who.nonce) { privHold.set(k, { nonce: who.nonce, hash: hash.toLowerCase(), at: Date.now() }); holdBus?.postMessage({ a: k, n: who.nonce, h: hash.toLowerCase() }); } }
  const run = async (attempt: number): Promise<void> => {
    if (includedTx.has(hash.toLowerCase())) { releaseHold(hash); return; }
    const seen = await Promise.race([receiptClient().getTransactionReceipt({ hash }).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 400))]);
    if (seen) { includedTx.add(hash.toLowerCase()); releaseHold(hash); return; }
    const errs: string[] = [];
    const outs = await Promise.allSettled(publicSendUrls().map((u) => postRaw(u, raw, hash, errs)));
    // taken (or these very bytes already on chain: "nonce too low") → the hold stays until the receipt or MEV_HOLD_MS
    if (outs.some((o) => o.status === 'fulfilled') || errs.some((e) => /nonce too low|nonce has already been used/i.test(e))) return;
    if (attempt < 2 && errs.length > 0 && errs.every((e) => THROTTLED.test(e))) { setTimeout(() => { run(attempt + 1).catch(() => {}); }, 300 + attempt * 600); return; }
    // review: this nonce is free again, so any later hold of this wallet (a tx signed at nonce + 1 meanwhile) sits behind a gap:
    // drop it too, or the next send is held above the gap and the wallet queues behind a nonce nobody holds (up to MEV_HOLD_MS)
    releaseHold(hash);
    if (who) { const k = who.from.toLowerCase(), h = privHold.get(k); if (h && h.nonce >= who.nonce) { privHold.delete(k); holdBus?.postMessage({ a: k, n: h.nonce, h: h.hash, drop: true }); } nonces.delete(k); }
  };
  setTimeout(() => { run(0).catch(() => {}); }, MEV_FALLBACK_MS);
}
async function broadcast(raw: `0x${string}`, round = 0, lostBefore = false, who?: { from: string; nonce: number }): Promise<`0x${string}`> {
  const errP: string[] = [], errQ: string[] = [];
  const local = keccak256(raw);   // the transaction's own hash: what a node that "already knows" it is holding
  // MEV v2: protection on → the private roads first; the public roads (and the user's trades-only nodes) only on the
  // hedge (no private answer in MEV_HEDGE_MS), on a refusal by every private road, or as the fallback after MEV_FALLBACK_MS
  const priv = mevPrivate();
  const first = broadcastUrls(), second = priv ? publicSendUrls() : [];
  // first fulfilled wins; only when every node refused does the send fail (Promise.any, spelled out for the lib target)
  return new Promise((resolve, reject) => {
    let left = first.length, won = false, pub = false, why = '', pubLeft = 0, done = false;
    const win = (u: string, h: `0x${string}`, isPublic: boolean) => {
      if (!won) {
        won = true; if (hedge) clearTimeout(hedge); lastBroadcastNode = u.replace(/^https:\/\//, '');
        lastBroadcastPath = !priv ? 'public' : isPublic ? 'public-' + why : pub ? 'private+public-' + why : 'private';
        if (priv && !pub) mevFallback(raw, local, who);   // the public roads never saw it: arm the fallback
      }
      resolve(h);
    };
    const lose = (e: Error, isPublic = false) => {
      if (done) return;
      const m = String(e?.message || e); if (!errP.includes(m) && !errQ.includes(m)) (isPublic ? errQ : errP).push(m);
      if (isPublic) pubLeft -= 1;
      // review: every public road refused for a reason of the chain's STATE (no funds, nonce used, gas below intrinsic) — the
      // private roads read the same state, so one that hangs or failed to fetch (CSP, outage) holds nothing: settle now with
      // that verdict, never 8 s later as "unknown"
      const definite = priv && pub && !won && pubLeft === 0 && errQ.length > 0 && errQ.every((x) => STATE_REFUSAL.test(x) && !THROTTLED.test(x) && !LOST.test(x));
      if (--left > 0 && !definite) return;
      if (priv && !pub && second.length) { goPublic('refused'); return; }
      done = true;
      if (hedge) clearTimeout(hedge);
      const errors = [...errQ, ...errP];   // the public verdict first: it is the one the tx would get today
      const verdict = errors.find((x) => !THROTTLED.test(x)) || errors[0] || 'broadcast failed';
      const throttled = errors.length > 0 && errors.every((x) => THROTTLED.test(x));
      const lost = lostBefore || (!definite && errors.some((x) => LOST.test(x)));
      if (round < 2 && throttled) { setTimeout(() => broadcast(raw, round + 1, lost, who).then(resolve, reject), (round === 0 ? 250 : 900) + Math.floor(Math.random() * 250)); return; }
      // An answer lost in flight (a timeout, a dropped socket) in either round means a node may hold the
      // transaction: round 1's 429s say nothing about round 0's lost answers. Unknown, with its hash — never
      // "refused" (which invites the press that would buy twice). A nonce verdict goes to the hash lookup instead.
      if (lost && (throttled || !/nonce|underpriced|known/i.test(verdict))) { reject(Object.assign(new Error(`Broadcast outcome unknown (${verdict.slice(0, 60)}) — check the explorer before trying again`), { txState: 'unknown' as TxState, hash: local })); return; }
      reject(Object.assign(new Error(verdict), { txState: 'signed' as TxState, hash: local }));
    };
    const goPublic = (reason: string) => { if (pub || won || done) return; pub = true; why = reason; left += second.length; pubLeft = second.length; for (const u of second) postRaw(u, raw, local, errQ).then((h) => win(u, h, true), (e: Error) => lose(e, true)); };
    const hedge = priv && second.length ? setTimeout(() => goPublic('slow'), MEV_HEDGE_MS) : null;
    for (const u of first) postRaw(u, raw, local, errP).then((h) => win(u, h, false), (e: Error) => lose(e));
  });
}
// prepare (nonce, gas) → sign locally → broadcast everywhere: what writeContract does, minus the single-node send
// The nonce is kept locally per wallet: read once ('pending'), bumped after each
// accepted send, re-read when a node objects. That is one round trip less on
// every click; with the fee cached too, a Turbo buy is quote → sign → send.
const nonces = new Map<string, { n: number; at: number }>();
const nonceReads = new Map<string, Promise<number>>();   // one read in flight per wallet: the prefetch at click time and the send share it
async function nextNonce(address: `0x${string}`, fresh = false): Promise<number> {
  const k = address.toLowerCase(); const hit = nonces.get(k);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return holdNonce(k, hit.n);   // review: a hold another tab shared counts too
  const inflight = nonceReads.get(k);
  if (inflight && !fresh) return inflight;
  const asked = Date.now();
  const p = publicClient.getTransactionCount({ address, blockTag: 'pending' }).then((n) => {
    // a send accepted while this read was in flight (a prewarm read racing a click) has already moved the
    // counter past what the node counted: keep the higher one, or the next send re-signs after "nonce too low"
    // MEV v2: the public node does not count a tx a private road holds: never below that tx's nonce + 1 (holdNonce)
    const now = nonces.get(k); const v = holdNonce(k, !fresh && now && now.at >= asked ? Math.max(n, now.n) : n);
    nonces.set(k, { n: v, at: Date.now() }); return v;
  }).finally(() => { if (nonceReads.get(k) === p) nonceReads.delete(k); });
  nonceReads.set(k, p);
  return p;
}
async function nonceSheet(addresses: `0x${string}`[]) {
  const urls = readUrls().filter((u) => u !== CFG.rpcSingle); if (!urls.length) return;
  const todo = addresses.filter((a) => { const h = nonces.get(lc(a)); return !(h && Date.now() - h.at < 30_000) && !nonceReads.has(lc(a)); });
  const chunks: (typeof todo)[] = []; for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10));
  await Promise.all(chunks.map(async (c, i) => {
    const asked = Date.now();
    const j = await fetch(urls[i % urls.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getTransactionCount', params: [a, 'pending'] }))), signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
    if (!Array.isArray(j)) return;
    c.forEach((a, k) => {
      const x = j.find((y: any) => y?.id === k); if (!x?.result) return;
      const n = holdNonce(a, Number(BigInt(x.result))); const now = nonces.get(lc(a));
      if (!(now && now.at >= asked)) nonces.set(lc(a), { n, at: Date.now() });   // a send meanwhile moved it: keep that
    });
  }));
}
const noteNonceUsed = (address: `0x${string}`, used: number) => { const k = address.toLowerCase(); const hit = nonces.get(k); nonces.set(k, { n: Math.max(used + 1, hit?.n ?? 0), at: Date.now() }); };
// One send lane per wallet: nonce → sign → broadcast run one at a time per
// wallet (wallets stay parallel). Two sends of one wallet in flight at once — a
// sell next to the background arming of the buy before it, the swap and the
// approval of a stock-curve buy — used to read the same cached nonce; the second
// then waited for every node to refuse it (drpc takes ~600 ms to say "nonce too
// low"), re-read the nonce and signed again: +0.7 s on the first sell after a buy
// (measured). Every engine send goes through here, so the cached counter is the
// only one in use.
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const k = lc(address);
  const run = (lanes.get(k) || Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  lanes.set(k, tail);
  tail.then(() => { if (lanes.get(k) === tail) lanes.delete(k); });
  return run;
}
// F-22 (V12): one wallet's sends serialized ACROSS TABS (the cross-tab Web Lock trench-lane-<addr>) and within this
// frame (inLane), so two drivers can never sign a transaction from the same wallet at the same nonce. Used by the
// move runner's write-ahead signing; falls back to the in-frame lane when Web Locks are unavailable.
function laneLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return lk?.request ? (lk.request('trench-lane-' + lc(address), () => inLane(address, fn)) as Promise<T>) : inLane(address, fn);
}
// prepare (nonce, gas) → sign locally → broadcast everywhere: what writeContract does, minus the single-node send
async function signAndSend(wallet: ReturnType<typeof createWalletClient>, account: ReturnType<typeof privateKeyToAccount>, tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint }, gasPrice: bigint, gas?: bigint, clock?: Shared): Promise<`0x${string}`> {
  const tq = performance.now();
  return inLane(account.address, async () => {
    const go = async (fresh: boolean) => {
      const t0 = performance.now();
      const nonce = await nextNonce(account.address, fresh);
      const prepared = gas
        ? { to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, gasPrice, gas, nonce, type: 'legacy' }       // nothing left to ask the node
        : await wallet.prepareTransactionRequest({ account, chain, to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, gasPrice, nonce, type: 'legacy' } as any);
      const t1 = performance.now();
      // F-73 (V12): last line of defence before signing — refuse a gas price or absolute fee
      // that only a spoofed node / manipulated estimate could produce, so nothing drains on fees.
      const effGas = gas ?? ((prepared as { gas?: bigint }).gas ?? 0n);
      if (CFG.maxGasPrice && gasPrice > CFG.maxGasPrice * 5n) throw new Error('Refusing to sign: gas price is far above normal for this chain');
      if (CFG.maxFeeWei && effGas > 0n && effGas * gasPrice > CFG.maxFeeWei) throw new Error('Refusing to sign: this transaction would spend an abnormal amount on gas');
      // signed by the account itself: wallet.signTransaction asks the node for eth_chainId on every signature
      // just to compare it with the chain this frame pins (one round trip, 60-120 ms, measured) — the chain id
      // signed in is chain.id either way, so a node on another chain still cannot replay it. Same bytes.
      // A Privy wallet signs on the page (remoteSign): this is the stage that shows it.
      const { account: _a, chain: _c, ...body } = prepared as Record<string, unknown>;
      const raw = await account.signTransaction({ ...body, account, chainId: chain.id } as any);
      const t2 = performance.now();
      clock?.note('signed');
      let hash: `0x${string}`;
      try { hash = await broadcast(raw, 0, false, { from: account.address, nonce }); } catch (e) { throw Object.assign(e as SendError, { nonce }); }
      clock?.mark('nonce', t1 - (fresh ? t0 : tq)); clock?.mark('sign', t2 - t1); clock?.mark('broadcast', performance.now() - t2);
      noteNonceUsed(account.address, nonce);
      clock?.note('submitted', hash);
      return hash;
    };
    try { return await go(false); }
    catch (e) {
      const err = e as SendError;
      // A stale counter (a send from another tab, a dropped tx) is the one thing worth a second try — but
      // "nonce too low" is also what a node says when OUR transaction got in through a sibling whose answer
      // was lost: re-signing then would buy twice. The hash is looked up first; when the lookup itself
      // fails nobody knows: unknown, not a second signature.
      // an unknown send may hold its nonce in a mempool: the next send reads the node's pending count, never the cached one
      if (err.txState === 'unknown') nonces.delete(lc(account.address));
      // "replacement transaction underpriced" / "known nonce": a pending transaction already sits at this nonce — ours
      // (a lost first attempt) or an earlier one. Same rule as "nonce too low": look ours up; never re-sign over it
      // at the same nonce (that is a replacement, at a higher price, of a buy that may be pending).
      if (/nonce too low|nonce has already been used|invalid nonce|replacement transaction underpriced|known nonce|already known/i.test(err.message) && err.hash) {
        const seen = await publicClient.getTransaction({ hash: err.hash }).then(() => 'yes', (x: Error) => (/not found|could not be found/i.test(String(x?.message)) ? 'no' : 'error'));
        if (seen === 'yes') { if (err.nonce != null) noteNonceUsed(account.address, err.nonce); clock?.note('submitted', err.hash); return err.hash; }
        if (seen === 'error') { const u = Object.assign(new Error('Broadcast outcome unknown (nonce already used, lookup failed) — check the explorer before trying again'), { txState: 'unknown' as TxState, hash: err.hash }); clock?.note('unknown', err.hash, u.message); throw u; }
        nonces.delete(lc(account.address));
        try { return await go(true); } catch (e2) { const r = e2 as SendError; if (r.txState === 'unknown') nonces.delete(lc(account.address)); clock?.note(r.txState || 'signed', r.txState === 'unknown' ? r.hash : undefined, r.message); throw r; }
      }
      // refused by every node for a counter that ran ahead (a dropped tx): nothing is out there under that nonce
      if (/nonce too high|nonce gap|future/i.test(err.message) && err.txState === 'signed') {
        try { return await go(true); } catch (e2) { const r = e2 as SendError; if (r.txState === 'unknown') nonces.delete(lc(account.address)); clock?.note(r.txState || 'signed', r.txState === 'unknown' ? r.hash : undefined, r.message); throw r; }
      }
      clock?.note(err.txState || 'not_started', err.txState === 'unknown' ? err.hash : undefined, err.message);
      throw err;
    }
  });
}
const sendCall = (wallet: ReturnType<typeof createWalletClient>, account: ReturnType<typeof privateKeyToAccount>, req: any, gasPrice: bigint, gas?: bigint, clock?: Shared): Promise<`0x${string}`> =>
  signAndSend(wallet, account, { to: req.address, data: encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args }), value: req.value ?? 0n }, gasPrice, gas, clock);
// Receipt wait for a step that has to land before the next one (an approval
// before its sell, a bridge leg before its curve buy). viem's
// waitForTransactionReceipt polls the block number every 4 s on a chain that
// declares no block time and fetches the tx itself first; Robinhood seals a
// block every ~100 ms (measured: 50 blocks in 5 s), so asking for the receipt
// directly answers within a block or two of inclusion. Polls of several wallets
// share one batched request. Throws when nothing came back in time.
// V13 (speed, G12): on BNB Chain receipts are asked of bloXroute / 48 Club first — publicnode answers every
// eth_getTransactionReceipt there with -32602 ("Archive requests require a personal token"), and each poll paid that
// refusal (~52 ms) plus the fallback. The user's own nodes keep their place in front.
let receiptCl: { sig: string; c: ReturnType<typeof createPublicClient> } | null = null;
const receiptClient = () => {
  if (CFG.key !== 'bsc') return publicClient;
  const urls = readUrls(); const sig = urls.join('|');
  if (receiptCl?.sig === sig) return receiptCl.c;
  const tail = [...urls.filter((u) => u !== BSC.rpc), ...urls.filter((u) => u === BSC.rpc)];
  receiptCl = { sig, c: createPublicClient({ chain, transport: fallback(tail.map((u) => http(u, { timeout: RPC_TIMEOUT })), { rank: false, retryCount: 1, retryDelay: 200 }) }) };
  return receiptCl.c;
};
async function landed(hash: `0x${string}`, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (let i = 0; ; i += 1) {
    const r = await receiptClient().getTransactionReceipt({ hash }).catch(() => null);
    if (r) { includedTx.add(hash.toLowerCase()); releaseHold(hash); return r; }   // MEV v2: no public fallback for a landed tx
    if (Date.now() - t0 > timeoutMs) throw new Error('Transaction not confirmed in time');
    await new Promise((res) => setTimeout(res, i < 25 ? 120 : i < 60 ? 400 : 1500));
  }
}

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;
// Every balance read goes through Multicall3 (allowFailure: a bad token cannot sink the native balances).
// Returns null when the whole call was refused — the caller keeps what it knew; a per-address fallback
// covers a chain without Multicall3. Values are numbers in the unit's decimals; absent = unknown.
let multicallOk = true;
async function evmBalanceSheet(addresses: `0x${string}`[], tokens: { address: `0x${string}`; decimals: number }[]): Promise<{ eth: Record<string, number>; tokens: Record<string, Record<string, number>> } | null> {
  const eth: Record<string, number> = {}; const tok: Record<string, Record<string, number>> = {};
  if (!addresses.length) return { eth, tokens: tok };
  if (multicallOk) {
    try {
      const contracts = [
        ...addresses.map((a) => ({ address: MULTICALL3, abi: multicall3Abi, functionName: 'getEthBalance' as const, args: [a] })),
        ...tokens.flatMap((t) => addresses.map((a) => ({ address: t.address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [a] }))),
      ];
      const res = await publicClient.multicall({ contracts: contracts as any, allowFailure: true });
      addresses.forEach((a, i) => { const r = res[i]; if (r?.status === 'success') eth[a.toLowerCase()] = Number(formatEther(r.result as bigint)); });
      tokens.forEach((t, ti) => { const m: Record<string, number> = tok[t.address.toLowerCase()] = {}; addresses.forEach((a, i) => { const r = res[addresses.length + ti * addresses.length + i]; if (r?.status === 'success') m[a.toLowerCase()] = Number(formatUnits(r.result as bigint, t.decimals)); }); });
      return { eth, tokens: tok };
    } catch (e: any) {
      // no Multicall3 on this chain → per-address reads from now on; a refused call → unknown this round
      if (/returned no data|not a contract|0x$/i.test(String(e?.shortMessage || e?.message || ''))) multicallOk = false; else return null;
    }
  }
  const es = await Promise.all(addresses.map((a) => publicClient.getBalance({ address: a }).catch(() => null)));
  addresses.forEach((a, i) => { if (es[i] != null) eth[a.toLowerCase()] = Number(formatEther(es[i]!)); });
  for (const t of tokens) {
    const m = tok[t.address.toLowerCase()] = {} as Record<string, number>;
    const rs = await Promise.all(addresses.map((a) => publicClient.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }).catch(() => null)));
    addresses.forEach((a, i) => { if (rs[i] != null) m[a.toLowerCase()] = Number(formatUnits(rs[i] as bigint, t.decimals)); });
  }
  return { eth, tokens: tok };
}

const PONS_CURVE_ABI = [
  { name: 'buy', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { name: 'sell', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'quote', type: 'uint256' }, { name: 'token', type: 'uint256' }] },
] as const;
// multi-hop: path is tokenIn | fee | tokenMid | fee | tokenOut, tightly packed
const EXACT_INPUT_ABI = [{
  name: 'exactInput', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}] as const;
const EXACT_INPUT_SINGLE_ABI = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}] as const;

// ── vault ──
// ext: a wallet whose key is not here — a Privy embedded wallet on the page's side; the frame routes, quotes and broadcasts, the page signs
// main/index: a trading wallet derived from the account's main wallet (its seed comes from one signature of the main), so it is the same on every device
// gen 2: a trading wallet derived under this vault's own salt (see subKeyV2) — not reproducible from the main's signature alone
// kind: how the wallet came in (carried in the account backup so a restore keeps it)
// V12 F-34: `via:'page'` = a key the page handed in through the legacy engine.import. Such a wallet is NOT one of the
// vault's own for transfers (excluded from ownAccounts), so sending to it takes the outside / withdrawal path.
type Account = { id: string; name: string; address: `0x${string}`; key: `0x${string}`; createdAt: number; archived?: boolean; hop?: boolean; ext?: 'privy'; main?: string; index?: number; gen?: 2; kind?: 'created' | 'imported'; via?: 'page'; lt?: LtRec };
// lt (perps phase 2): this wallet's Lighter API key and account (src/perpsEngine.ts) — encrypted at rest with the vault's device AES key like the wallet keys, never
// in a summary, a message or the account backup (a new device registers a new key; the old one is replaced at slot 77)
// account: the last profile the server confirmed (vault-client → mainPublished) and which addresses it covers
// removedAddrs: wallets removed here on a trusted click — a publish does not carry them back into the profile
// mergedBlobs / recoveryDismissed: set-aside vaults already merged back, and missing wallets the user chose to forget
type VaultMeta = { activeAccountId: string | null; selectedAccountIds: string[]; order: string[]; changedAt?: number; backedUpAt?: number; main?: string | null; walletAddedAt?: number; account?: { main: string; at: number; addrs: string[]; digest: string; count?: number } | null; removedAddrs?: string[]; mergedBlobs?: string[]; recoveryDismissed?: string[]; mainMv?: Record<string, 2>; recovery?: Record<string, RecoveryBlob | null>;
  // V12 F-28: where a main's seed came from — 'main' (its own verified signature, full backup) or 'rk1' (an unbound
  // legacy recovery copy; publish only what that account restored and generate new wallets off it). rk1[m] records the
  // addresses restored from that profile and its salts, so mainProfile seals exactly those and nothing else.
  seedSrc?: Record<string, 'main' | 'rk1'>; rk1?: Record<string, { addrs: string[]; salts: string[] }>;
  // backup v4: main → the envelope generation the account's live backup is under (set once this vault opened or confirmed it).
  // A vault that knows an account is v4 never publishes a v3 copy for it (src/passkeyBackup.ts).
  pk4?: Record<string, number> };
type StoredVault = { v: 2; iv: string; ct: string; siv?: string; sct?: string; meta: VaultMeta; addresses: { id: string; name: string; address: string; archived?: boolean; hop?: boolean }[] };
const VAULT_KEY = 'trenches.vault';
const SETTINGS_KEY = 'trenches.engine.settings';
const DB_NAME = 'trenches-vault', DB_STORE = 'keys';

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const enc = new TextEncoder(), dec = new TextDecoder();
const readVault = (): StoredVault | null => { try { const v = JSON.parse(localStorage.getItem(VAULT_KEY) || 'null'); return v && v.v === 2 ? v : null; } catch { return null; } };
const freshMeta = (): VaultMeta => ({ activeAccountId: null, selectedAccountIds: [], order: [] });
// non-extractable AES key persisted as a CryptoKey object in IndexedDB; every connection is closed after its one request
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function idbGet(k: string): Promise<CryptoKey | undefined> { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(DB_STORE).objectStore(DB_STORE).get(k); r.onsuccess = () => { res(r.result); db.close(); }; r.onerror = () => { rej(r.error); db.close(); }; }); }
async function idbPut(k: string, v: CryptoKey): Promise<void> { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(DB_STORE, 'readwrite'); t.objectStore(DB_STORE).put(v, k); t.oncomplete = () => { res(); db.close(); }; t.onerror = () => { rej(t.error); db.close(); }; }); }
// The device key is read, never guessed: a failing key store must not be mistaken for an empty one. And a
// key that is simply gone while a ciphertext waits for it is NOT an empty vault either (the 2026-10-14
// incident): bootVault (src/vaultRecovery.ts) reports "key missing" and writes nothing; a new key comes
// only from a trusted click in this frame, under one Web Lock for all tabs, after the old blob is kept.
const keyStore: KeyStore = {
  get: async () => { try { return await idbGet('vault'); } catch (e) { throw new Error('The vault key store is not available in this browser right now (' + ((e as Error)?.message || 'IndexedDB failed') + '). Reload; nothing was changed.'); } },
  put: (k) => idbPut('vault', k),
};
let vaultFatal = '';

let unlocked: Account[] | null = null;
// Chain-only wallets of ANOTHER lane (nativeKeys.ts: a Solana key on the BNB frame, a NEAR key on the Solana frame …):
// not listed, not traded, not signed with here — but kept, written back on every persist and carried in every backup.
// `unlocked` is what this lane shows; `[...unlocked, ...parked]` is the vault. With no chain-only wallet (every vault
// before 2026-10-19) parked stays empty and nothing below behaves differently.
let parked: Account[] = [];
const hereOk = (a: Account) => { const c = nativeChainOf(a.key); return !c || (c === 'sol' ? SOL_MODE : NEAR_MODE); };
const allAccounts = (): Account[] => [...(unlocked || []), ...parked];
const keyAddress = (key: string) => (nativeSlotOf(key) || privateKeyToAccount(key as `0x${string}`).address) as `0x${string}`;
// V12 F-23: read ONE legacy-import item into the exact key string the vault stores (an EVM 0x-key, or a chain-only
// 'sol:'/'near:' key) and the address to SHOW for it (a chain-only key under its native address). null = unreadable.
// import() parses every item through this up front, so one bad entry fails the whole batch before anything is shown.
const readKeyOrNull = (it: { name?: string; privateKey?: string } | null | undefined): { name: string; key: string; address: string } | null => {
  const key = String(it?.privateKey ?? '').trim();
  const name = String(it?.name ?? '').trim();
  if (!storableKey(key)) return null;
  try { const address = nativeChainOf(key) ? nativeAddress(key) : privateKeyToAccount(key as `0x${string}`).address; return address ? { name, key, address } : null; } catch { return null; }
};
let seeds: Record<string, string> = {};          // main address (lower) → 32-byte seed hex, from one signature of that main
let storagePersisted = false;
let storageEstimate: { quota?: number; usage?: number } | null = null;
// ── keeping this frame's storage across launches (2026-10-20, iPhone home-screen app) ──
// In an iOS home-screen (standalone) app the vault frame started EMPTY on every launch while the page kept its own
// storage (the Privy login survived), so every launch ran the restore and asked for its clicks again. On the trusted OK
// of the account dialogs (AskOpts.keep) the frame asks for storage access — only where document.hasStorageAccess exists
// and said no — and asks to persist its storage. WebKit grants both only inside a user gesture, so keepStorage() runs
// synchronously in the click handler, before anything is awaited. Feature-detected; every failure is silent and changes
// nothing else. The outcome rides in mainStatus / mainAttach / mainSync as `sa` (granted | denied | unasked | na) and
// `persisted` (true | false | na) for the page's restore diag beacon — flags only.
type SaDoc = Document & { hasStorageAccess?: () => Promise<boolean>; requestStorageAccess?: () => Promise<void> };
let storageAccess: 'granted' | 'denied' | 'unasked' | 'na' = 'na';
const saDoc = (): SaDoc | null => (typeof document !== 'undefined' ? document as SaDoc : null);
function readStorageAccess() {
  const d = saDoc();
  if (!d || typeof d.hasStorageAccess !== 'function') { storageAccess = 'na'; return; }
  if (storageAccess === 'na') storageAccess = 'unasked';
  try { d.hasStorageAccess().then((v) => { if (v) storageAccess = 'granted'; else if (storageAccess === 'granted') storageAccess = 'unasked'; }, () => {}); } catch {}
}
function keepStorage() {
  if (!HOST) return;
  const d = saDoc();
  try {
    if (d && typeof d.hasStorageAccess === 'function' && typeof d.requestStorageAccess === 'function' && storageAccess !== 'granted') {
      d.requestStorageAccess().then(() => { storageAccess = 'granted'; }, () => { storageAccess = 'denied'; });
    }
  } catch { storageAccess = 'denied'; }
  try { navigator.storage?.persist?.().then((v) => { storagePersisted = !!v; }, () => {}); } catch {}
}
const storageFlags = () => ({ sa: storageAccess, persisted: typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function' ? storagePersisted : 'na' as const });
let cryptoKey: CryptoKey | null = null;
let meta: VaultMeta = freshMeta();
// the stored vault is here but its device key is not (or a different one is): nothing opens, nothing is written
let keyMissing: { reason: 'nokey' | 'mismatch'; since: number; addresses: { name: string; address: string }[] } | null = null;
const KEY_MISSING_MSG = 'The vault key is missing in this browser — your wallets are stored encrypted and untouched. Open Wallets → Recover to restore them from your account or a backup file.';
const listeners = new Set<() => void>();
const emit = () => { for (const f of listeners) { try { f(); } catch {} } post({ t: 'ev', name: 'trench:vault' }); };
const removedIds = new Set<string>();       // the only accounts a merge is allowed to drop
async function decryptStored(): Promise<{ accounts: Account[]; meta: VaultMeta; seeds: Record<string, string> } | null> {
  const stored = readVault();
  if (!stored || !stored.ct || !cryptoKey) return null;
  const o = await openWith(cryptoKey, stored); if (!o) return null;
  return { accounts: o.accounts as unknown as Account[], meta: Object.assign(freshMeta(), stored.meta || {}), seeds: o.seeds };
}
// union by id: whatever another tab wrote since we last read survives; a wallet is dropped only by remove()
async function mergeFromDisk() {
  if (!unlocked) return;
  const disk = await decryptStored(); if (!disk) return;
  for (const a of disk.accounts) if (!removedIds.has(a.id) && !unlocked.some((x) => x.id === a.id) && !parked.some((x) => x.id === a.id)) (hereOk(a) ? unlocked : parked).push(a);
  // a perps key another tab registered (Account.lt): the newer record wins, so a write here never drops it
  // (M1: on the same time a finished registration, st 'ok', wins over a pending one; the region declaration of either is
  // kept — ltMerge)
  for (const a of disk.accounts) { if (!a.lt) continue; const mine = allAccounts().find((x) => x.id === a.id); if (mine && mine !== a) mine.lt = ltMerge(a.lt, mine.lt); }
  for (const id of disk.meta.order) if (!meta.order.includes(id) && allAccounts().some((x) => x.id === id)) meta.order.push(id);
  for (const [m, sd] of Object.entries(disk.seeds || {})) if (!seeds[m]) { seeds[m] = sd; if (disk.meta.mainMv?.[m] === 2) meta.mainMv = { ...(meta.mainMv || {}), [m]: 2 }; }
}
let persisting: Promise<void> = Promise.resolve();
let replacing = false;                       // the first write of a vault that replaces a set-aside one (inside the key lock)
function persist() { persisting = persisting.then(() => persistNow(), () => persistNow()); return persisting; }
async function persistNow(retry = 0) {
  if (!unlocked || !cryptoKey) throw new Error(keyMissing ? KEY_MISSING_MSG : 'Vault not ready');
  // Never write over a vault this key cannot open. Another tab may have started over (a new key, its own
  // vault): if the key store's key opens what is on disk now, this tab switches to it and its wallets join
  // that vault; otherwise nothing is written.
  // V12 F-25: remember the exact stored value we checked here, so we can tell just before the write whether another
  // tab changed it under us (a reset in another tab writing a new key + empty vault) and redo rather than clobber it.
  const before = localStorage.getItem(VAULT_KEY);
  const disk = readVault();
  if (disk && disk.ct && !replacing && !(await openWith(cryptoKey, disk))) {
    const now = await idbGet('vault').catch(() => undefined);
    if (now && (await openWith(now, disk))) cryptoKey = now;
    else throw new Error('The stored vault is under another key — this tab did not overwrite it. Reload the page.');
  }
  await mergeFromDisk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const all = allAccounts();
  const own = all.filter((a) => !a.ext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, cryptoKey, buf(enc.encode(JSON.stringify(own)))));
  meta.order = [...meta.order.filter((id) => all.some((a) => a.id === id)), ...all.filter((a) => !meta.order.includes(a.id)).map((a) => a.id)];
  const siv = crypto.getRandomValues(new Uint8Array(12));
  const sct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(siv) }, cryptoKey, buf(enc.encode(JSON.stringify(seeds)))));
  const next: StoredVault = { v: 2, iv: b64(iv), ct: b64(ct), siv: b64(siv), sct: b64(sct), meta, addresses: own.map((a) => ({ id: a.id, name: a.name, address: a.address, archived: !!a.archived, hop: !!a.hop })) };
  // V12 F-25: if the stored value changed since the check at the top of this call (another tab reset or rewrote the
  // vault), redo the whole merge + encrypt against the new value instead of overwriting it — up to 3 times. mergeFromDisk
  // above already folds in another tab's wallets; this guards the narrow window between that merge and the write.
  if (!replacing && retry < 3 && localStorage.getItem(VAULT_KEY) !== before) return persistNow(retry + 1);
  localStorage.setItem(VAULT_KEY, JSON.stringify(next));
  // read-after-write: the ciphertext on disk must decrypt to every key we hold
  const check = await decryptStored();
  for (const a of own) if (!check?.accounts.some((x) => x.id === a.id && x.key === a.key)) throw new Error(`vault write did not verify for ${a.name}`);
  emit();
}
// Tabs tell each other about the key: a tab that lost it says so (a tab that still holds it in memory puts it
// back — the key is non-extractable, but a CryptoKey object can be stored again as it is); a tab that restored
// or created one says so (tabs waiting in "key missing" open again).
const keyBus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('trenches-vault-key') : null;
keyBus?.addEventListener('message', (e) => { const t = (e as MessageEvent).data?.t; if (t === 'keymissing') guardKey().catch(() => {}); if (t === 'key' && keyMissing) reboot(); });
// another tab changed the vault: pick up its wallets (never lose any of ours); a tab waiting for its key retries
window.addEventListener('storage', (e) => { if (e.key !== VAULT_KEY) return; if (keyMissing) reboot(); else if (unlocked) mergeFromDisk().then(() => emit()).catch(() => {}); });
// Put the device key back if the browser dropped it while this tab still holds it (every minute, and at once when another tab reports it missing)
async function guardKey() {
  if (!cryptoKey || !unlocked || keyMissing) return;
  let have: CryptoKey | undefined; try { have = await idbGet('vault'); } catch { return; }
  if (have) return;
  if (!(await decryptStored())) return;                 // only the key of the vault actually stored here
  const held = cryptoKey;
  const put = await webLocker(KEY_LOCK, async () => { if (await idbGet('vault').catch(() => undefined)) return false; await idbPut('vault', held); return true; });
  if (put) { console.warn('[vault] the device key had vanished from IndexedDB; this tab still held it and put it back'); post({ t: 'ev', name: 'trench:vaultkeyhealed', detail: {} }); }
  keyBus?.postMessage({ t: 'key' });
}
setInterval(() => { guardKey().catch(() => {}); }, 60_000);
// the first write of a vault (a fresh browser, or the explicit start-over) happens inside the key lock
const commitFresh = async (b: { key: CryptoKey }) => { cryptoKey = b.key; unlocked = []; parked = []; seeds = {}; meta = freshMeta(); keyMissing = null; replacing = true; try { await persistNow(); } finally { replacing = false; } };
async function openBoot(b: Boot) {
  if (b.state === 'keymissing') {
    unlocked = null; parked = []; cryptoKey = null; seeds = {};
    meta = Object.assign(freshMeta(), (b.stored.meta as VaultMeta) || {});   // shown (names, addresses), never written
    keyMissing = { reason: b.reason, since: Date.now(), addresses: (b.stored.addresses || []).filter((a) => !a.hop).map((a) => ({ name: String(a.name || ''), address: String(a.address) })) };
    console.error('[vault] the stored vault has no device key in this browser; nothing was changed. Recover from the account or a backup file.');
    post({ t: 'ev', name: 'trench:vaultkeymissing', detail: { reason: b.reason, wallets: keyMissing.addresses.length } });
    keyBus?.postMessage({ t: 'keymissing' });
    emit(); pushBackupState();
    return;
  }
  const wasMissing = !!keyMissing;
  keyMissing = null; cryptoKey = b.key;
  if (!b.created && !b.aside) { const all = b.accounts as unknown as Account[]; unlocked = all.filter(hereOk); parked = all.filter((a) => !hereOk(a)); seeds = b.seeds; meta = Object.assign(freshMeta(), (b.meta as VaultMeta) || {}); }
  // phone access (review 2026-10-19 H3): a vault no longer keeps its own copy of the account's recovery blob (`rk`) —
  // an old copy was republished on the next wallet change and switched phone access back on after it was turned off
  // elsewhere. The server's copy is the only one; a copy left by an older engine is dropped here, once.
  const strippedRk = !!meta.recovery; if (strippedRk) delete meta.recovery;
  await mergeLostBlobs();
  if (strippedRk && unlocked) await persist().catch(() => {});
  if (wasMissing) { post({ t: 'ev', name: 'trench:vaultkeyhealed', detail: {} }); keyBus?.postMessage({ t: 'key' }); }
  emit(); pushBackupState();
}
let rebooting: Promise<void> | null = null;
function reboot() { if (!rebooting) rebooting = bootVault({ store: localStorage, keys: keyStore, commit: commitFresh }).then(openBoot).catch((e) => console.warn('[vault] reopen', (e as Error).message)).finally(() => { rebooting = null; }); return rebooting; }
// Opens the vault as soon as the page loads — no passphrase, no confirmation: the device key does the
// protecting. A missing key is a state, not an error: `ready` resolves and the page is told.
const ready: Promise<void> = (async () => {
  let b: Boot;
  try { b = await bootVault({ store: localStorage, keys: keyStore, commit: commitFresh }); } catch (e) { vaultFatal = (e as Error).message; post({ t: 'ev', name: 'trench:vaulterror', detail: { error: vaultFatal } }); throw e; }
  await openBoot(b);
  // the browser is asked to keep this origin's storage out of its eviction sweeps, and how much room is left
  try { storagePersisted = !!(await navigator.storage?.persist?.()); } catch {}
  readStorageAccess();
  checkStorage();
})();
// the explicit start-over (a trusted click): the stored vault is copied aside (verified) before an empty one replaces it
async function startFresh() {
  const b = await resetVault({ store: localStorage, keys: keyStore, commit: commitFresh });
  await openBoot(b);
  return { raced: !!b.raced, aside: b.aside };
}
// set-aside vaults that DO open with this key (a transient failure, a key put back): their wallets rejoin once
async function mergeLostBlobs() {
  if (!cryptoKey || !unlocked) return;
  const done = new Set(meta.mergedBlobs || []);
  for (const b of lostBlobs(localStorage)) {
    if (done.has(b.name) || !b.stored) continue;
    const o = await openWith(cryptoKey, b.stored).catch(() => null); if (!o) continue;
    done.add(b.name); meta.mergedBlobs = [...done];
    await adoptAccounts({ accounts: o.accounts as unknown as Account[], seeds: o.seeds });   // persists
  }
}
// wallets a set-aside vault lists that are not in this one: shown until restored or forgotten on a trusted click
let lostCache: { sig: string; v: LostBlob[] } | null = null;
const lostNow = () => { const names: string[] = []; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (k && k.startsWith(LOST_PREFIX)) names.push(k + ':' + (localStorage.getItem(k) || '').length); } const sig = names.sort().join('|'); if (!lostCache || lostCache.sig !== sig) lostCache = { sig, v: lostBlobs(localStorage) }; return lostCache.v; };
const missingWallets = () => (keyMissing || !unlocked ? [] : unrecovered(lostNow(), allAccounts().map((a) => a.address), meta.recoveryDismissed || []));
// how much room the browser says is left (it discards whole origins when the disk fills up)
function checkStorage() { navigator.storage?.estimate?.().then((e) => { storageEstimate = { quota: e.quota, usage: e.usage }; pushBackupState(); }).catch(() => {}); }
setInterval(checkStorage, 10 * 60_000);
const ordered = (list: Account[]) => [...list].sort((a, b) => { const ia = meta.order.indexOf(a.id), ib = meta.order.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
const summary = () => {
  const stored = readVault();
  const list = unlocked ? ordered(unlocked).map((a) => ({ id: a.id, name: a.name, address: SOL_MODE ? (solAddressOf(a) || a.address) : NEAR_MODE ? (nearAccountId(a) || a.address) : a.address, evm: nativeChainOf(a.key) ? '' : a.address, sol: solAddressOf(a), near: nearAccountId(a), ...(nativeChainOf(a.key) ? { only: nativeChainOf(a.key) } : {}), archived: !!a.archived, hop: !!a.hop, ext: a.ext || '', main: a.main || '', index: a.index ?? null })) : (stored?.addresses || []);
  const m = unlocked ? meta : (stored?.meta || meta);
  return { accounts: list.map((a) => ({ ...a, active: a.id === m.activeAccountId, selected: m.selectedAccountIds.includes(a.id) })), activeAccountId: m.activeAccountId, selectedAccountIds: m.selectedAccountIds, main: m.main || null, subCap: SUB_CAP, locked: !unlocked, exists: true, keyMissing: keyMissing ? { reason: keyMissing.reason, wallets: keyMissing.addresses.length } : null, missing: missingWallets().length };
};
const requireUnlocked = () => { if (!unlocked) throw new Error(keyMissing ? KEY_MISSING_MSG : vaultFatal || 'Vault still opening'); return unlocked; };
function lock() { /* device-key vault: nothing to lock; kept for API compatibility */ }
async function unlock() { await ready; }
async function createVault() { await ready; }
// Wallets name themselves: "Created 1", "Imported 3"… The counter continues
// past the highest existing number of that kind, so deleting one never reuses
// a name. Rename from the table's pencil.
function nextName(kind: 'Created' | 'Imported' | 'Wallet') {
  const list = allAccounts();
  const re = new RegExp('^' + kind + ' (\\d+)$');
  let n = 0;
  for (const a of list) { const m = re.exec(a.name); if (m) n = Math.max(n, Number(m[1])); }
  return `${kind} ${n + 1}`;
}
async function addAccount(name: string, key: `0x${string}`, opts: { hop?: boolean; main?: string; index?: number; gen?: 2; kind?: 'created' | 'imported'; createdAt?: number; archived?: boolean; via?: 'page' } = {}) {
  requireUnlocked();
  if (!storableKey(key)) throw new Error('key must be 0x + 64 hex');
  const acct = { address: keyAddress(key) };
  if (allAccounts().some((a) => a.address.toLowerCase() === acct.address.toLowerCase())) throw new Error('Wallet already in the vault');
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const here = !nativeChainOf(key) || (nativeChainOf(key) === 'sol' ? SOL_MODE : NEAR_MODE);
  const list = here ? requireUnlocked() : parked;
  list.push({ id, name: name || nextName('Created'), address: acct.address, key, createdAt: opts.createdAt || Date.now(), ...(opts.hop ? { hop: true } : {}), ...(opts.archived ? { archived: true } : {}), ...(opts.main ? { main: lc(opts.main), index: opts.index } : {}), ...(opts.gen === 2 ? { gen: 2 as const } : {}), ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.via === 'page' ? { via: 'page' as const } : {}) });
  // a hop wallet is plumbing: it never becomes the primary and never joins batch trades
  if (!opts.hop && !opts.archived) {
    if (!meta.activeAccountId && here) meta.activeAccountId = id;
    if (!meta.selectedAccountIds.includes(id)) meta.selectedAccountIds.push(id);
  }
  meta.order.push(id);
  meta.changedAt = Date.now();
  meta.walletAddedAt = Date.now();
  await persist();
  return id;
}
// ── main wallet + trading wallets ──
// The account's main wallet (a Privy embedded wallet, or the external wallet the user logged in with) signs one
// fixed message once; the signature reaches this frame through the page. Its hash is the seed, and every v1
// trading wallet is HMAC(seed, index): the same wallets, the same addresses, on any device where the same main
// signs the same message. Every other wallet of the vault rides in the account profile sealed under a key from
// the same seed (backup v3, src/vaultRecovery.ts) — the server that stores the profile cannot open it.
// Up to SUB_CAP trading wallets per main.
const SUB_CAP = 100;
// The v1 seed is SHA-256 of the main's signature over one fixed message — and the page's Privy island signs
// that message for any script on the page, silently. So a page script can rebuild every v1 trading key (and
// open v1-wrapped imports) without this frame. v2 trading wallets mix the seed with 32 random bytes this frame
// drew for itself (`seeds[SALT]`), so no signature a page can obtain reproduces them — which is also why a
// browser that lost its vault could not get them back from the account. The account backup (v3) therefore
// carries every key AND the salt, sealed under the seed: survival over that last bit of isolation (see
// backupKeyV3 for the trade-off; the backup file stays the only copy no signature opens).
const SALT = 'salt:v2';
const saltsOf = () => Object.entries(seeds).filter(([k]) => k === SALT || k.startsWith(SALT + ':')).map(([, v]) => v);
async function vaultSalt(): Promise<string> {
  if (!seeds[SALT]) { seeds[SALT] = bytesHex(crypto.getRandomValues(new Uint8Array(32))); await persist(); }
  return seeds[SALT];
}
// salts from a backup or the account profile: the first one becomes this vault's own if it has none yet (so new
// v2 wallets continue the same series on every device); the rest are kept for opening older v2 blobs
function adoptSalts(list: string[]) {
  let n = 0;
  for (const s of list) {
    if (!/^0x[0-9a-f]{64}$/.test(String(s)) || saltsOf().includes(s)) continue;
    if (!seeds[SALT]) seeds[SALT] = s; else seeds[`${SALT}:${Object.keys(seeds).length}`] = s;
    n += 1;
  }
  return n;
}
const subKeyV2 = async (seed: string, index: number) => subKeyV2With(seed, await vaultSalt(), index);
// per main: profile entries this vault could not open (another device's blobs) — carried over verbatim on publish
const remoteCarry = new Map<string, ProfileEntry[]>();
// wallets the user just approved in the "Restore your wallets on this device" window (account recovery): the restore
// that follows adds exactly these without asking a second time (same main, same addresses, within two minutes)
let preApproved: { main: string; addrs: Set<string>; at: number } | null = null;
// Phone access turned on or off HERE, in this frame's lifetime, by a trusted click: the only rk this vault ever publishes
// on its own (null = off). Kept in memory until the server confirms it (mainPublished) — never stored, so a device can
// never carry a stale choice into a later publish. Every other publish carries the server's current copy verbatim.
const recoveryChange = new Map<string, { rk: RecoveryBlob | null; at: number }>();
// the page's interface language for the dialogs src/rkMigrate.ts words (engine.uiLang; until then the frame's own language)
let pageLang: RkLang | null = null;
const uiLang = (): RkLang => pageLang || rkLangOf(typeof navigator !== 'undefined' ? navigator.language : '');
// profiles handed to the page to save, by digest: the server's confirmation (mainPublished) names one of them
const pendingPublish = new Map<string, { main: string; addrs: string[]; count?: number; change?: { rk: RecoveryBlob | null; at: number }; pkc?: { pk: PkEnvelope; at: number } }>();
// ── backup v4 (src/passkeyBackup.ts): the passkey as the second factor on the account backup ──
// The data key (DK) of a generation, once this vault unwrapped it with a passkey or the recovery code, is kept next to the
// seed in `seeds` (encrypted at rest under the device key, like the seed: whoever opens this vault has every key anyway).
// With it, a publish seals new wallets under K4 without asking for the passkey again; a vault without it publishes nothing
// for a v4 account (PasskeyLocked) and asks for one passkey touch first.
const PK = (m: string, gen: number) => `pk4:${lc(m)}:${gen}`;
const dkOf = (m: string, gen: number): string => (Object.prototype.hasOwnProperty.call(seeds, PK(m, gen)) ? seeds[PK(m, gen)] : '');
const k4Cache = new Map<string, CryptoKey>();   // `${main}|${gen}|${kc}` → K4 (memory only)
async function k4Of(m: string, core: { gen: number; kc: string; salt: string; slots: unknown[] }): Promise<CryptoKey | null> {
  const ck = `${lc(m)}|${core.gen}|${core.kc}`; const hit = k4Cache.get(ck); if (hit) return hit;
  const seed = seedOf(m), dk = dkOf(m, core.gen); if (!seed || !dk) return null;
  const k = await checkDk(core as never, seed, m, dk); if (k) k4Cache.set(ck, k);
  return k;
}
// every generation this vault can open (current first); the current generation's key, or null when locked here
async function v4KeysOf(m: string, pk: PkEnvelope | null): Promise<{ keys: CryptoKey[]; current: CryptoKey | null }> {
  if (!pk) return { keys: [], current: null };
  const keys: CryptoKey[] = []; let current: CryptoKey | null = null;
  for (const c of coresOf(pk)) { const k = await k4Of(m, c); if (k) { keys.push(k); if (c.gen === pk.gen) current = k; } }
  return { keys, current };
}
// envelope changes made HERE by a trusted click (a passkey added / removed, a new recovery code), published by the next
// mainProfile and dropped once the server confirmed them — like recoveryChange
const pkChange = new Map<string, { pk: PkEnvelope; at: number }>();
const pkError = (name: string, message: string) => Object.assign(new Error(message), { name });
// The vault's own host is the RP ID (passkeyBackup.ts rpIdFor). A frame on another origin (the app's srcdoc vault on
// motion.gift) cannot use that credential, so it is never offered there.
const PK_RP = typeof location !== 'undefined' ? rpIdFor(location.hostname) : '';
// (a development build also accepts http://localhost — a secure context — for the local e2e stand; a release never does)
const pkOriginOk = () => HOST && typeof location !== 'undefined' && (location.protocol === 'https:' || (DEV_BUILD && location.hostname === 'localhost')) && (location.hostname === PK_RP || location.hostname.endsWith('.' + PK_RP));
type Pkc = { publicKey: unknown };
const wa = () => (typeof navigator !== 'undefined' ? (navigator.credentials as unknown as { create?: (o: Pkc) => Promise<unknown>; get?: (o: Pkc) => Promise<unknown> } | undefined) : undefined);
// The passkey dialogs' words in the page's language (src/passkeyCopy.ts): a line as text, or as the dialog kit's html
const pkt = (k: PkKey, p?: PkParams) => pkT(k, uiLang(), p);
const pkSub = (k: PkKey, p?: PkParams) => sub(escHtml(pkt(k, p)));
const pkLine = (k: PkKey, p?: PkParams) => `<p>${escHtml(pkt(k, p))}</p>`;
const pkMuted = (k: PkKey, p?: PkParams) => muted(escHtml(pkt(k, p)));
const pkWho = (m: string) => signedIn(m, pkt('signedInAs'));
// A dialog whose OK starts a WebAuthn ceremony inside the trusted click (o.gesture) and stays open until it settles: a
// cancelled or failed ceremony shows its reason in the dialog ("Nothing was changed.") and the next click starts a new one.
// Resolves to the credential, or null when the dialog was closed.
async function askPasskey(o: Omit<AskOpts, 'gesture' | 'validate'>, start: () => Promise<unknown>): Promise<unknown | null> {
  let run: Promise<unknown> | null = null, cred: unknown = null;
  const ok = await ask({ ...o, gesture: () => { if (!run) run = start(); },
    validate: async () => {
      if (!run) return pkt('errClickAgain');
      try { cred = await run; if (!cred) throw new Error('no answer'); return null; }
      catch (e) {
        run = null; const n = (e as Error)?.name;
        return n === 'NotAllowedError' ? pkt('errNotAllowed')
          : n === 'InvalidStateError' ? pkt('errInvalidState')
          : n === 'SecurityError' ? pkt('errSecurity')
          : pkt('errOther', { detail: String((e as Error)?.message || e).slice(0, 80) });
      }
    } });
  return ok ? cred : null;
}
const pkCreate = (m: string, salt: Uint8Array, exclude: string[]) => () => { const c = wa(); if (!c?.create) return Promise.reject(pkError('NotSupportedError', 'no WebAuthn')); return c.create({ publicKey: createOptions({ rpId: PK_RP, main: m, salt, exclude }) }); };
const pkGet = (opts: ReturnType<typeof getOptionsRaw>) => () => { const c = wa(); if (!c?.get) return Promise.reject(pkError('NotSupportedError', 'no WebAuthn')); return c.get({ publicKey: opts }); };
// a credential that was created but cannot be used (no PRF, enrolment abandoned): ask the provider to forget it where it can
function pkForget(id: string) {
  try { const P = (globalThis as unknown as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } }).PublicKeyCredential; P?.signalUnknownCredential?.({ rpId: PK_RP, credentialId: id })?.catch?.(() => {}); } catch {}
}
// A fresh passkey's PRF: from the create() when the provider gave it there, else from one get() of that credential. The get
// always runs (a second click): it is the fresh read, and with both answers they must agree — a provider that answers
// differently per ceremony would lock the backup.
async function pkEnrolPrf(m: string, salt: Uint8Array, exclude: string[], first: { title: string; html: string; ok: string; step: { n: number; of: number } }): Promise<{ id: string; prf: Uint8Array; name: string; aaguid: string; sync: boolean | null; ms: number }> {
  const cred = await askPasskey({ title: first.title, ok: first.ok, cancelLabel: pkt('btnNotNow'), keep: true, html: first.html, step: first.step }, pkCreate(m, salt, exclude));
  if (!cred) throw new Error('Cancelled');
  const r = readPrf(cred as never), ad = readAuthData(cred as never);
  if (!r.id) throw new Error(pkt('noAnswer'));
  if (r.enabled === false || (r.enabled !== true && !r.prf)) { pkForget(r.id); throw pkError('PasskeyNoPrf', pkt('noPrfCreate')); }
  let t0 = 0;
  // the next step, the confirming touch ('Cancel' draws no extra button: the dialog's × closes it, as before)
  const again = await askPasskey({ title: pkt('confirmTitle'), ok: pkt('btnUse'), cancelLabel: 'Cancel', step: { n: first.step.n + 1, of: first.step.of }, html: `${pkSub('confirmLead')}${pkLine('confirmNeed')}${pkMuted('confirmNote')}` },
    () => { t0 = performance.now(); return pkGet(getOptionsRaw({ rpId: PK_RP, items: [{ id: r.id, salt }] }))(); });
  const ms = performance.now() - t0;
  if (!again) { pkForget(r.id); throw new Error('Cancelled'); }
  const g = readPrf(again as never);
  if (g.id !== r.id || !g.prf) { pkForget(r.id); throw pkError('PasskeyNoPrf', pkt('noPrfSecond')); }
  if (r.prf && canon([...r.prf]) !== canon([...g.prf])) { pkForget(r.id); throw pkError('PasskeyNoPrf', pkt('noPrfDiffer')); }
  return { id: r.id, prf: g.prf, name: providerName(ad.aaguid, ad.sync), aaguid: ad.aaguid, sync: ad.sync, ms };
}
// The recovery code, shown once in this frame (never posted to the page). 'saved' = the user confirmed; 'file' = skipped with a
// current backup file (with PASSKEY_POLICY.requireSaved, allowed only then); null = cancelled.
async function pkShowCode(code: string, fileOk: boolean, o: { step?: { n: number; of: number }; fresh?: boolean } = {}): Promise<'saved' | 'file' | null> {
  const skip = !PASSKEY_POLICY.requireSaved || fileOk;
  const v = await askChoice({ title: pkt(o.fresh ? 'codeNewTitle' : 'codeTitle'), ok: '', cancelLabel: 'Cancel', size: 'md', copy: code, ...(o.step ? { step: o.step } : {}),
    html: `${pkSub('codeLead')}<p class="dk-sub" translate="no"><b>${escHtml(code)}</b> <button class="dlg-btn" data-copy="${escHtml(code)}" data-label="${escHtml(pkt('btnCopy'))}" data-copied="${escHtml(pkt('btnCopied'))}">${escHtml(pkt('btnCopy'))}</button></p>${pkLine('codeNeed')}${pkMuted('codeWarn')}${PASSKEY_POLICY.requireSaved && !fileOk ? pkMuted('codeSkipHint') : ''}${o.fresh ? pkMuted('codeNewNote') : o.step ? pkMuted('codeOnNote') : ''}`,
    choices: [{ id: 'saved', label: pkt('btnSaved'), primary: true }, ...(skip ? [{ id: 'file', label: pkt('btnSkipFile') }] : [])] });
  return v === 'saved' || v === 'file' ? v : null;
}
const fileCurrent = () => { const keyed = allAccounts().filter((a) => !a.ext && !a.hop); const last = Math.max(meta.walletAddedAt || 0, ...keyed.map((a) => a.createdAt || 0), 0); return !!meta.backedUpAt && meta.backedUpAt >= last; };
// what this vault would publish for a main, gathered the way mainProfile does (v1 count and names, the keyed wallets, salts)
function publishInputs(m: string) {
  const subs = subsV1Of(m);
  const count = subs.reduce((n, a) => Math.max(n, (a.index ?? -1) + 1), 0);
  const names: Record<string, string> = {}; for (const a of subs) names[String(a.index)] = a.name;
  return { count, names, wallets: backupWalletsOf(m), salts: saltsOf() };
}
function pkLive(m: string, p: Profile | null | undefined): Profile | null {
  if (!p || typeof p !== 'object') return null;
  if (lc(p.main) !== m) throw new Error('That profile belongs to another main wallet');
  return p;
}
async function pkSeed(m: string, p: Profile | null): Promise<string> {
  const seed = seedOf(m); if (!seed) throw new Error(pkt('seedMissing'));
  // a seed from an unbound legacy phone-access copy is not proven to be the account's: it may not re-seal the backup
  if (meta.seedSrc?.[m] === 'rk1') throw new Error(pkt('seedUnproven'));
  if (p?.fp && p.fp !== await fingerprint(seed)) throw new Error(pkt('fpMismatch'));
  return seed;
}
// unwrap DK with one passkey touch (any slot of any generation), check it against kc, keep it next to the seed
async function pkUnlockWith(m: string, pk: PkEnvelope, d: { title: string; html: string; ok: string; step?: { n: number; of: number } }): Promise<{ gen: number; ms: number }> {
  const opts = getOptions({ rpId: PK_RP, pk });
  if (!opts.allowCredentials.length) throw pkError('PasskeyElsewhere', pkt('elsewhere'));
  let t0 = 0;
  const cred = await askPasskey({ title: d.title, ok: d.ok, cancelLabel: pkt('btnNotNow'), keep: true, html: d.html, ...(d.step ? { step: d.step } : {}) }, () => { t0 = performance.now(); return pkGet(opts)(); });
  const ms = performance.now() - t0;
  if (!cred) throw new Error('Cancelled');
  const r = readPrf(cred as never);
  const got = r.prf ? await dkFromPrf(pk, { main: m, id: r.id, prf: r.prf }) : null;
  if (!got) throw pkError('PasskeyWrong', pkt('wrong'));
  const core = coresOf(pk).find((c) => c.gen === got.gen)!;
  const seed = seedOf(m)!;
  if (!(await checkDk(core, seed, m, got.dk))) throw pkError('PasskeyWrong', pkt('wrong'));
  seeds[PK(m, got.gen)] = got.dk;
  return { gen: got.gen, ms };
}
// the "turn it on / off" in progress (memory): what the page staged on the server, until the server confirms it
const pkPending = new Map<string, { mode: 'up' | 'off'; gen: number; at: number }>();
const PK_OFF_CONFIRM_MS = 30 * 60_000;   // a staged turn-off may be confirmed for this long (the verify touch sits in between)
const subKey = subKeyV1;
const subsOf = (main: string) => (unlocked || []).filter((a) => a.main === lc(main) && a.index != null && a.index >= 0);
// what the account profile can re-derive on another device from the count alone: v1 trading wallets only
const subsV1Of = (main: string) => subsOf(main).filter((a) => a.gen !== 2);
// the fixed text this main's seed was signed over: 2 once attached with the motion text, else 1 (copytrade.gg)
const mvOf = (main: string): MainMsgVersion => (meta.mainMv?.[lc(main)] === 2 ? 2 : 1);
// what rides in the profile sealed (backup v3): every other wallet that has a key here — created, imported, v2, hop
const kindOf = (a: Account): BackupWallet['kind'] => (a.hop ? 'hop' : a.main && a.index != null ? 'derived' : a.kind || (/^Imported \d+$/.test(a.name) ? 'imported' : 'created'));
const backupWalletsOf = (main: string): BackupWallet[] => allAccounts()
  .filter((a) => !a.ext && storableKey(a.key) && !(a.main === lc(main) && a.index != null && a.gen !== 2))
  .sort((x, y) => Number(!!x.hop) - Number(!!y.hop) || Number(!!x.archived) - Number(!!y.archived))
  .map((a) => ({ address: a.address, name: a.name, key: a.key, kind: kindOf(a), ...(a.main && a.index != null ? { main: a.main, index: a.index } : {}), ...(a.gen === 2 ? { gen: 2 as const } : {}), ...(a.archived ? { archived: true } : {}), ...(a.via === 'page' ? { via: 'page' as const } : {}), createdAt: a.createdAt }));
// V12 F-28 follow-up (src/rkMigrate.ts): the wallets of an 'rk1' main (seed from an unbound legacy recovery copy) that the
// account backup does not hold — mainProfile seals only what that main restored (meta.rk1[m].addrs) until the seed is proven
const unboundOf = (main: string): BackupWallet[] => { const m = lc(main); return m && meta.seedSrc?.[m] === 'rk1' ? localOnly(backupWalletsOf(m), meta.rk1?.[m]?.addrs || []) : []; };
// does the account backup hold this wallet? Its sealed entry was in a profile the server confirmed (the server's union never
// drops one), or it is a v1 wallet derived from that account's seed (the count carries it)
const inBackup = (a: { address: string; main?: string; index?: number; gen?: 2 }): boolean => {
  const acc = meta.account; if (!acc) return false;
  if (a.main && a.index != null && a.gen !== 2 && lc(a.main) === lc(acc.main) && (acc.count == null || a.index < acc.count)) return true;
  return (acc.addrs || []).map(lc).includes(lc(a.address));
};
// (audit 2026-11-01, vault-security-backup-coverage) The coverage record (meta.account) comes from the page's confirmation
// (mainPublished); it may only ever SHRINK on what the page shows of the server copy afterwards, never grow:
//   - no server copy for this main (null, another main, or a file-only record: backup 'file') → no coverage at all;
//   - a server copy → only the addresses it really holds stay covered, and v1 wallets only below its count;
//   - an empty copy that is not file-only (the server's new-device cool-down serves the sealed parts out) says nothing → kept.
// `remote === undefined` = the caller passed no server copy → nothing to learn. Returns true when coverage changed.
function narrowCoverage(m: string, remote: unknown): boolean {
  const acc = meta.account; if (!acc || lc(acc.main) !== lc(m) || remote === undefined) return false;
  const r = remote && typeof remote === 'object' ? remote as Partial<Profile> & { backup?: unknown } : null;
  if (!r || lc(String(r.main || '')) !== lc(m) || r.backup === 'file') { meta.account = null; return true; }
  const attached = Array.isArray(r.attached) ? r.attached : [];
  const count = Math.max(0, Math.floor(Number(r.count) || 0));
  if (!attached.length && !count) return false;
  const held = new Set(attached.map((e) => lc(String((e as { address?: unknown })?.address || ''))));
  const addrs = (acc.addrs || []).filter((x) => held.has(lc(x)));
  const nextCount = acc.count == null ? count : Math.min(acc.count, count);
  if (addrs.length === (acc.addrs || []).length && nextCount === acc.count) return false;
  meta.account = { ...acc, addrs, count: nextCount };
  return true;
}
async function deriveSubs(main: string, count: number, names: Record<string, string>) {
  const seed = seeds[lc(main)]; if (!seed) throw new Error('No seed for this main wallet');
  const list = requireUnlocked();
  let added = 0;
  for (let i = 0; i < Math.min(SUB_CAP, Math.max(0, Math.floor(count))); i += 1) {
    const have = subsOf(main).find((a) => a.index === i && a.gen !== 2);
    const wanted = String(names?.[String(i)] || '').trim();
    if (have) { if (wanted && have.name !== wanted) have.name = wanted; continue; }
    const key = await subKey(seed, i);
    const address = privateKeyToAccount(key).address;
    const dup = list.find((a) => same(a.address, address));
    if (dup) { dup.main = lc(main); dup.index = i; delete dup.gen; if (wanted) dup.name = wanted; continue; }   // the same wallet imported by key earlier: it becomes the derived one
    await addAccount(wanted || `Wallet ${i + 1}`, key, { main, index: i });
    added += 1;
  }
  return added;
}

const WETH_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
// A Privy wallet's key lives in Privy's own iframe on the page, never here. The
// frame prepares the complete transaction (nonce, fee, gas, calldata) and hands
// it to the page to sign; the raw signed bytes come back and are broadcast from
// here through the same multi-node path as a local wallet. The page can only
// answer a request the frame made — it cannot make the frame send anything.
const signWaits = new Map<string, { resolve: (raw: `0x${string}`) => void; reject: (e: Error) => void; timer: number }>();
const hexQ = (v: unknown) => (typeof v === 'bigint' || typeof v === 'number' ? '0x' + BigInt(v).toString(16) : v);
async function remoteSign(address: `0x${string}`, tx: Record<string, unknown>): Promise<`0x${string}`> {
  if (!HOST || !parentWin || !parentOrigin) throw new Error('Privy wallets sign from the terminal page');
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const req = { to: tx.to, data: tx.data || '0x', value: hexQ(tx.value ?? 0n), nonce: Number(tx.nonce), gasPrice: hexQ(tx.gasPrice), gasLimit: hexQ(tx.gas), chainId: chain.id, type: 0 };
  const raw = await new Promise<`0x${string}`>((resolve, reject) => {
    const timer = window.setTimeout(() => { signWaits.delete(id); reject(new Error('Privy did not sign in time')); }, 90_000);
    signWaits.set(id, { resolve, reject, timer });
    post({ t: 'sign', id, address, tx: req });
  });
  // the page hands back bytes: they are broadcast only if they are exactly the transaction asked for, signed by that wallet
  let p: ReturnType<typeof parseTransaction>;
  try { p = parseTransaction(raw); } catch { throw new Error('Privy returned something that is not a transaction'); }
  const want = { to: lc(String(req.to)), data: lc(String(req.data || '0x')), value: BigInt(String(req.value ?? 0)), nonce: Number(req.nonce), gasPrice: BigInt(String(req.gasPrice ?? 0)), gas: BigInt(String(req.gasLimit ?? 0)) };
  const got = { to: lc(p.to || ''), data: lc(p.data || '0x'), value: p.value ?? 0n, nonce: Number(p.nonce), gasPrice: (p as { gasPrice?: bigint }).gasPrice ?? (p as { maxFeePerGas?: bigint }).maxFeePerGas ?? 0n, gas: p.gas ?? 0n };
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as never }).catch(() => '');
  if (got.to !== want.to || got.data !== want.data || got.value !== want.value || got.nonce !== want.nonce || got.gas !== want.gas || got.gasPrice !== want.gasPrice || Number(p.chainId) !== chain.id || !same(signer, address)) throw new Error('Privy returned a different transaction than the one asked for — not sent');
  return raw;
}
const unsupported = async () => { throw new Error('Not supported for a Privy wallet here'); };
type Signer = ReturnType<typeof privateKeyToAccount>;
const accountOf = (a: Account): Signer => (a.ext
  ? (toAccount({ address: a.address, signTransaction: (tx) => remoteSign(a.address, tx as unknown as Record<string, unknown>), signMessage: unsupported, signTypedData: unsupported }) as unknown as Signer)
  : privateKeyToAccount(a.key));
const walletFor = (id: string) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); const account = accountOf(a); return { a, account, client: createWalletClient({ account, chain, transport }) }; };
const GAS_RESERVE = parseEther('0.00005');
// Robinhood's eth_gasPrice can sit just under the next block's base fee, so a
// legacy tx priced at it is rejected ("max fee less than base fee"). Price
// from the latest base fee with headroom; the user's boost multiplies on top.
let feeCache: { floor: bigint; at: number } | null = null;
let feeInflight: Promise<bigint> | null = null;
async function feeFloor(): Promise<bigint> {
  if (feeCache && Date.now() - feeCache.at < 2500) return feeCache.floor;
  if (feeInflight) return feeInflight;
  feeInflight = (async () => {
    try {
      const [gp, block] = await Promise.all([publicClient.getGasPrice(), publicClient.getBlock().catch(() => null)]);
      const base = block?.baseFeePerGas ?? gp;
      const floor = (base > gp ? base : gp) * 125n / 100n;
      // F-73 (V12): a spoofed node reporting an absurd gas price would otherwise be multiplied
      // by the boost and signed; refuse above the chain's ceiling instead (and never cache it).
      if (CFG.maxGasPrice && floor > CFG.maxGasPrice) throw new Error('Gas price is far above normal for this chain — refusing to trade (check your network node)');
      feeCache = { floor, at: Date.now() };
      return floor;
    } finally { feeInflight = null; }
  })();
  return feeInflight;
}
async function feeFor(boost = 1): Promise<bigint> {
  const floor = await feeFloor();
  const p = (floor * BigInt(Math.round(Math.max(1, boost) * 100))) / 100n;
  // MEV v2: with BNB protection on, never under MEV_MIN_GAS (0.05 gwei, the floor every road enforces)
  return p < MEV_MIN_GAS && mevPrivate() ? MEV_MIN_GAS : p;
}
// While a trader is on a page (prewarm was called in the last minute) the fee
// stays fresh and every broadcast node gets a cheap ping every 20 s, so the TLS
// session is open and a click never pays a handshake.
let hotUntil = 0;
setInterval(() => {
  if (Date.now() > hotUntil || SOL_MODE || NEAR_MODE) return;   // V13 (G5): a Solana / NEAR frame does not ping Robinhood's nodes
  feeFloor().catch(() => {});
  if (Math.floor(Date.now() / 2500) % 8 === 0) for (const u of broadcastUrls()) fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', keepalive: true, signal: AbortSignal.timeout(4000) }).catch(() => {});
}, 2500);
const keepHot = () => { hotUntil = Date.now() + 60_000; };
async function sendEth(fromId: string, to: `0x${string}`, amountWei: bigint | 'max') {
  if (SOL_MODE) {
    const a = requireUnlocked().find((x) => x.id === fromId); if (!a) throw new Error('Unknown wallet');
    return (await solTransfer(a, String(to), amountWei === 'max' ? 'max' : Number(amountWei) / 1e18)) as `0x${string}`;
  }
  if (NEAR_MODE) {
    const a = requireUnlocked().find((x) => x.id === fromId); if (!a) throw new Error('Unknown wallet');
    // callers hand over wei-scaled amounts (18 decimals) for the gas token; NEAR amounts travel the same way
    return (await nearTransfer(a, String(to).toLowerCase(), amountWei === 'max' ? 'max' : Number(amountWei) / 1e18)) as `0x${string}`;
  }
  const { account, client } = walletFor(fromId);
  const gasPrice = await feeFor(1), gas = await syncEthGas(account.address, to);
  let value = amountWei === 'max' ? (await publicClient.getBalance({ address: account.address })) - gasPrice * gas - GAS_RESERVE : amountWei;
  if (value <= 0n) throw new Error('Nothing to send after gas');
  // through the wallet's send lane: the nonce comes from the shared counter, so a transfer between two trades does not leave the next trade signing a used nonce
  return signAndSend(client, account, { to, value }, gasPrice, gas);
}
async function wrap(id: string, amountWei: bigint) { const { account, client } = walletFor(id); const gasPrice = await feeFor(1); const sim = await publicClient.simulateContract({ account, address: WETH, abi: WETH_ABI, functionName: 'deposit', value: amountWei, gasPrice }); return sendCall(client, account, sim.request, gasPrice); }
async function unwrap(id: string, amountWei: bigint) { const { account, client } = walletFor(id); const gasPrice = await feeFor(1); const sim = await publicClient.simulateContract({ account, address: WETH, abi: WETH_ABI, functionName: 'withdraw', args: [amountWei], gasPrice }); return sendCall(client, account, sim.request, gasPrice); }   // the lane's nonce: an unwrap behind a sell must not poison the next sell's counter

// ── settings ──
type RpcPick = { primary?: string; secondary?: string; send?: string[] };
type Settings = { slippage: number; gasBoost: number; turbo: boolean; rpcs?: Record<string, RpcPick>; solTip?: number; solPriority?: number; sendPool?: number;
  // TC-S1 / TC-S2 / TC-M1 (exec-quality 2026-11-04), each keyed by lane (robinhood / bsc / sol / near / elysium):
  // slipLane = the manual slippage of that lane (absent = the global `slippage`, as before); slipAuto = the page may pass a
  // per-order slippage from the coin's own trades, used only when it is TIGHTER than the manual one (never looser, so a hostile
  // page can only make orders revert, never widen them); mev = MEV protection (bsc: private builders only; sol: Jito bundle only)
  slipLane?: Record<string, number>; slipAuto?: Record<string, boolean>; mev?: Record<string, boolean> };
const loadSettings = (): Settings => { try { return { slippage: 12, gasBoost: 1.5, turbo: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { slippage: 12, gasBoost: 1.5, turbo: false }; } };
const saveSettings = (s: Partial<Settings>) => { const next = { ...loadSettings(), ...s }; next.solTip = Math.min(0.1, Math.max(0, Number(next.solTip) || 0)); next.solPriority = Math.min(10_000_000, Math.max(0, Math.floor(Number(next.solPriority) || 0))); next.slippage = Math.min(100, Math.max(0.1, Number(next.slippage) || 12)); next.gasBoost = Math.min(5, Math.max(1, Number(next.gasBoost) || 1)); { const sp = Math.floor(Number(next.sendPool)); if (sp >= 1) next.sendPool = Math.min(25, sp); else delete next.sendPool; }
  { const lanes = ['robinhood', 'bsc', 'sol', 'near', 'elysium'];
    const bools = (v: unknown) => { const o: Record<string, boolean> = {}; if (v && typeof v === 'object') for (const k of lanes) if (typeof (v as Record<string, unknown>)[k] === 'boolean') o[k] = (v as Record<string, boolean>)[k]; return o; };
    const pcts = (v: unknown) => { const o: Record<string, number> = {}; if (v && typeof v === 'object') for (const k of lanes) { const n = Number((v as Record<string, unknown>)[k]); if (Number.isFinite(n) && n >= 0.1 && n <= 100) o[k] = n; } return o; };
    next.mev = bools(next.mev); next.slipAuto = bools(next.slipAuto); next.slipLane = pcts(next.slipLane); }
  if (next.rpcs && typeof next.rpcs === 'object') for (const k of Object.keys(next.rpcs)) { const v = next.rpcs[k] || {}; next.rpcs[k] = { ...(isRpcUrl(v.primary) ? { primary: v.primary } : {}), ...(isRpcUrl(v.secondary) ? { secondary: v.secondary } : {}), ...(Array.isArray(v.send) && v.send.filter(isRpcUrl).length ? { send: [...new Set(v.send.filter(isRpcUrl))].slice(0, 3) } : {}) }; }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); return next; };
// TC-M1 / TC-M2 (exec-quality 2026-11-04): MEV protection per lane (bsc: private builders only; sol: Jito bundle-only). The private
// roads answer as fast as the public node (send RTT), but inclusion is unproven; the vault's dialog asks once to turn it OFF.
// exec-quality review 2026-11-04: OFF on every lane until the owner's landing A/B (48 Club answers eth_gasPrice 1 gwei, BlockRazor 0.1 gwei,
// the engine signs ~0.094 gwei on BNB: a private-only send may be refused or never included). Not advertised in `features` yet.
// MEV v2 (mev-v2 2026-11-04): BNB ON — private-first with the public fallback of the same bytes after MEV_FALLBACK_MS, the
// hedge after MEV_HEDGE_MS and the nonce hold, so a private road that refuses, stalls or never includes costs at most
// ~0.7 s of landing, never a stuck wallet. Solana stays OFF (TC-M2: Jito bundle-only has no fallback).
// mev-v2-review: shipped OFF and not offered until the owner's real-send GO (report.txt §5); the flip is bsc: true here,
// which also makes the vault advertise the switch on BNB
const MEV_DEFAULT: Record<string, boolean> = { bsc: false, sol: false };
// the per-lane switches this vault has; 'mev' only where it has an effect and a fallback (BNB), and only once it is the default
const vaultFeatures = () => (MEV_DEFAULT.bsc && laneKey() === 'bsc' ? ['slipLane', 'slipAuto', 'mev'] : ['slipLane', 'slipAuto']);
const mevOn = (s: Settings = loadSettings()) => { const v = s.mev?.[laneKey()]; return typeof v === 'boolean' ? v : MEV_DEFAULT[laneKey()] === true; };
// TC-S1: the lane's own manual slippage (absent = the global one, as before); Elysium has its own default (review r2 N5: the
// global 12 % saved by any settings write must not count as the user's choice there)
const LANE_SLIP_DEFAULT: Record<string, number> = { elysium: 5 };
const laneSlip = (s: Settings) => { const v = Number(s.slipLane?.[laneKey()]); return v > 0 ? v : LANE_SLIP_DEFAULT[laneKey()] ?? s.slippage; };
// TC-S2: Auto. The page passes the slippage the coin's own recent trades call for (motion-ios domain/execution.ts autoSlippage,
// the classic token.js the same rule) as opts.slippage; it is used only when Auto is on for the lane, never below the lane's
// floor and never above the manual setting — Auto can only tighten an order, so a hostile page gains nothing by lying.
const AUTO_FLOOR: Record<string, number> = { robinhood: 2, bsc: 1.5, sol: 3, near: 1, elysium: 3 };
const orderSlip = (s: Settings, opts?: unknown) => {
  const manual = laneSlip(s); if (!s.slipAuto?.[laneKey()]) return manual;
  const a = Number(opts && typeof opts === 'object' ? (opts as { slippage?: unknown }).slippage : NaN);
  return Number.isFinite(a) && a > 0 ? Math.min(manual, Math.max(AUTO_FLOOR[laneKey()] ?? 1, a)) : manual;
};
// the order's settings: this lane's slippage (Auto applied) and its effective MEV switch (solEngine reads mev.sol)
const tradeSettings = (opts?: unknown): Settings => { const s = loadSettings(); return { ...s, slippage: orderSlip(s, opts), mev: { ...s.mev, [laneKey()]: mevOn(s) } }; };
// the NEAR frame reads its nodes from Settings → RPC too (rpcs.near): the user's primary / fallback in front of the
// engine's defaults, trades-only nodes for broadcasts (the EVM path's rpcPick reads CFG.key, which is not 'near')
const applyNearRpcs = () => { const p = loadSettings().rpcs?.near || {}; return setNearRpcs([p.primary, p.secondary], p.send || []); };
if (NEAR_MODE) applyNearRpcs();
// …and the Solana frame (rpcs.sol): reads from the user's node first, sends still go to every road (src/solEngine.ts)
const applySolRpcs = () => { const p = loadSettings().rpcs?.sol || {}; return setSolRpcs([p.primary, p.secondary], p.send || []); };
if (SOL_MODE) applySolRpcs();

// ── routes come from the indexer (it already knows every market) ──
type Bridge = { bridgeHops?: string[]; bridgeFees?: number[]; bridgeFee?: number; quoteSymbol?: string; chainId?: number };
type Route =
  | ({ type: 'pons'; curve: `0x${string}`; pairToken: `0x${string}`; feeBps: number; creatorTaxBps: number } & Bridge)
  | ({ type: 'v4'; poolKey: V4PoolKey; pair: 'native' | 'weth' | 'usdg' | 'other'; quoteToken?: `0x${string}` } & Bridge)
  | ({ type: 'v3'; fee: number; quoteToken: `0x${string}` } & Bridge)
  // BNB Chain: the launchpads' own entry points and the PancakeSwap venues after listing
  | ({ type: 'four'; manager: `0x${string}`; helper: `0x${string}`; quoteToken: `0x${string}`; quoteDecimals: number; feeBps: number } & Bridge)
  | ({ type: 'flap'; portal: `0x${string}`; quoteToken: `0x${string}`; quoteDecimals: number; nativeToQuote: boolean; buyTaxBps: number; sellTaxBps: number } & Bridge)
  // Standard: the curve through its router, or (graduated) its V4 pool over ETH → USDG → stock → coin
  | ({ type: 'standard'; stage: 'curve' | 'pool'; router: `0x${string}`; factory: `0x${string}`; curve: `0x${string}`; stock: `0x${string}`; poolKey: V4PoolKey | null; stockPool: StdHop; ethPool: StdHop; feeBps: number; creatorTaxBps: number; snipeTaxBps: number } & Bridge)
  | ({ type: 'v2'; router: `0x${string}`; quoteToken: `0x${string}`; path: `0x${string}`[] } & Bridge)
  | ({ type: 'inf'; poolKey: InfPoolKey; pair: 'native' | 'weth' | 'other'; quoteToken: `0x${string}` } & Bridge)
  // Elysium (trade-core.patch E4): signed only by the ELYSIUM section, only in the Elysium frame
  | (ELY.ElyRoute & Bridge);
// ETH → … → quote, exactly as the indexer resolved it (one hop for most assets,
// two when the stock only pairs with USDG)
const bridgeOf = (r: Bridge, quote: string) => {
  const hops = (r.bridgeHops && r.bridgeHops.length ? r.bridgeHops : (r.bridgeFee ? [WETH, quote] : null));
  const fees = (r.bridgeFees && r.bridgeFees.length ? r.bridgeFees : (r.bridgeFee ? [r.bridgeFee] : null));
  if (!hops || !fees || hops.length !== fees.length + 1) return null;
  return { hops, fees, path: encodeV3Path(hops, fees), reverse: encodeV3Path([...hops].reverse(), [...fees].reverse()) };
};
// ── route trust ──
// The indexer proposes where a token trades; the engine signs only when the
// proposal lands on a venue this chain knows: the launchpad's own registry says
// this curve belongs to this token (one eth_call, cached), the manager / portal /
// router / pool manager equal the hardcoded deployments, and every bridge hop
// passes through a known asset. A compromised or spoofed server therefore cannot
// point a buy — or the unlimited sell approval that follows it — at a contract
// of its choosing. Pools behind the hardcoded routers are bounded by minOut.
const lc = (a?: string) => String(a || '').toLowerCase();
const same = (a?: string, b?: string) => !!a && !!b && lc(a) === lc(b);
const BRIDGE_TOKENS = new Set(CFG.bridgeTokens.map(lc));
const KNOWN_HOOKS = new Set(CFG.knownHooks.map(lc));
const V3_TIERS = new Set([100, 500, 2500, 3000, 10000]);
// F-57 (V12): the tokenised stocks a V3 route is allowed to be quoted in (besides the bridge assets).
const STD_STOCKS = new Set(Object.keys(CFG.standard?.stocks || {}).map(lc));
const PONS_GET_LAUNCHED = toFunctionSelector('function getLaunchedToken(address)');
const FLAP_GET_TOKEN_V8 = '0xf1159a49';
const padAddr = (a: string) => lc(a).slice(2).padStart(64, '0');
const wordAddr = (data: string, i: number) => '0x' + data.slice(2 + 64 * i + 24, 2 + 64 * (i + 1)).toLowerCase();
const wordInt = (data: string, i: number) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const rawCall = async (to: `0x${string}`, data: `0x${string}`) => (await publicClient.call({ to, data })).data || '0x';
const reject = (why: string): never => { throw new Error(`Route rejected: ${why}`); };
async function checkRoute(token: `0x${string}`, route: Route): Promise<void> {
  if (CFG.key === 'elysium' || route.type === 'ely') { const why = CFG.key !== 'elysium' ? 'an Elysium route outside the Elysium frame' : ELY.elyRouteProblem(token, route); if (why) reject(why); return; }   // (trade-core.patch E5)
  const knownQuote = (q?: string) => !q || same(q, ZERO) || BRIDGE_TOKENS.has(lc(q));
  let quote: string | undefined;
  if (route.type === 'pons') {
    if (!CFG.ponsFactory) reject(`no bonding-curve venue on ${CFG.name}`);
    const data = await rawCall(CFG.ponsFactory!, (PONS_GET_LAUNCHED + padAddr(token)) as `0x${string}`);
    if (data.length < 2 + 64 * 15) reject('the launchpad registry does not know this token');
    if (wordInt(data, 14) !== 1n || !same(wordAddr(data, 1), route.curve)) reject('the curve is not the one the launchpad registered for this token');
    if (!same(wordAddr(data, 4), route.pairToken)) reject('the curve pair asset does not match the registry');
    quote = route.pairToken;
  } else if (route.type === 'four') {
    if (!CFG.fourManager || !same(route.manager, CFG.fourManager) || !same(route.helper, CFG.fourHelper)) reject('not the four.meme deployment');
    let q = '';
    try {
      const r = await publicClient.readContract({ address: CFG.fourHelper!, abi: FOUR_HELPER_ABI, functionName: 'tryBuy', args: [token, 0n, 10n ** 15n] });
      if (!same(r[0], route.manager)) reject('four.meme names another manager for this token');
      q = r[1];
    } catch (e) {
      if (String((e as Error).message).startsWith('Route rejected')) throw e;
      try { const r = await publicClient.readContract({ address: CFG.fourHelper!, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, 1n] }); q = r[1]; }
      catch { reject('four.meme does not know this token'); }
    }
    if (!same(q, route.quoteToken)) reject('four.meme quotes this token in another asset');
    quote = route.quoteToken;
  } else if (route.type === 'flap') {
    if (!CFG.flapPortal || !same(route.portal, CFG.flapPortal)) reject('not the Flap portal');
    const data = await rawCall(CFG.flapPortal!, (FLAP_GET_TOKEN_V8 + padAddr(token)) as `0x${string}`);
    if (data.length < 2 + 64 * 18 || wordInt(data, 0) === 0n) reject('Flap does not know this token');
    if (!same(wordAddr(data, 9), route.quoteToken)) reject('Flap quotes this token in another asset');
    quote = route.quoteToken;
  } else if (route.type === 'standard') {
    const S = CFG.standard;
    if (!S) reject(`no Standard venue on ${CFG.name}`);
    if (!same(route.router, S!.router) || !same(route.factory, S!.factory)) reject('not the Standard deployment');
    const curve = await publicClient.readContract({ address: S!.factory, abi: STANDARD_FACTORY_ABI, functionName: 'curveOfToken', args: [token] });
    if (!same(curve, route.curve)) reject('the curve is not the one Standard registered for this token');
    const [stock, graduated, pk] = await Promise.all([
      publicClient.readContract({ address: route.curve, abi: STANDARD_CURVE_ABI, functionName: 'stock' }),
      publicClient.readContract({ address: route.curve, abi: STANDARD_CURVE_ABI, functionName: 'graduated' }),
      publicClient.readContract({ address: route.curve, abi: STANDARD_CURVE_ABI, functionName: 'poolKey' }),
    ]);
    if (!same(stock, route.stock)) reject('the curve is quoted in another stock');
    if (!sameHop(S!.stocks[lc(stock)], route.stockPool)) reject('the stock pool is not the one Standard routes through');
    if (!sameHop(S!.ethPool, route.ethPool)) reject('the ETH pool is not the one Standard routes through');
    if (route.stage === 'pool') {
      if (!graduated) reject('the curve has not graduated');
      const [c0, c1, fee, ts, hooks] = pk as unknown as [string, string, number, number, string];
      const rk = route.poolKey;
      if (!rk || !same(rk.currency0, c0) || !same(rk.currency1, c1) || Number(rk.fee) !== Number(fee) || Number(rk.tickSpacing) !== Number(ts) || !same(rk.hooks, hooks) || !same(hooks, S!.hook)) reject('the pool is not the one the curve graduated into');
    } else if (graduated) reject('the curve has graduated: its pool is the market now');
  } else if (route.type === 'v2') {
    if (!CFG.v2Router || !same(route.router, CFG.v2Router)) reject('not the PancakeSwap V2 router');
    // the router and its factory are fixed; a coin-quoted pair (token/MarsCoin)
    // is a legitimate market, so the path may pass through an unknown asset —
    // it must still start at the gas token, end at this token and name its
    // quote honestly. What an unknown hop can cost is bounded by slippage.
    const path = (route.path || []).map(lc);
    if (path.length) {
      if (path.length < 2 || !same(path[0], WETH) || !same(path[path.length - 1], token)) reject('V2 path must run from the gas token to this token');
      if (route.quoteToken && !same(route.quoteToken, path[path.length - 2])) reject('V2 quote asset is not the last hop of the path');
    } else if (!knownQuote(route.quoteToken)) reject('V2 quote asset is not a known one');
    quote = route.quoteToken;
  } else if (route.type === 'v3') {
    if (!V3_TIERS.has(Number(route.fee))) reject('unknown V3 fee tier');
    // F-57 (V12): a V3 route must be quoted in a known bridge asset or a known Standard
    // stock — not an arbitrary token a spoofed route could point the sell approval at.
    if (!knownQuote(route.quoteToken) && !STD_STOCKS.has(lc(route.quoteToken))) reject('V3 quote asset is not a known one');
    quote = route.quoteToken;
  } else if (route.type === 'v4') {
    const pk = route.poolKey; const cs = [lc(pk.currency0), lc(pk.currency1)];
    if (!cs.includes(lc(token))) reject('V4 pool does not contain this token');
    const other = cs[0] === lc(token) ? cs[1] : cs[0];
    if (route.quoteToken && !same(route.quoteToken, other)) reject('V4 quote asset is not in the pool');
    // F-36 + F-65 (V12): bind the declared pair mode to the pool's real other currency,
    // reject unknown hooks unless the pool is hookless with a known quote, and cap the
    // fee (a dynamic-fee flag is only allowed behind a known hook).
    if (route.pair === 'native' ? !same(other, ZERO) : route.pair === 'weth' ? !same(other, WETH) : route.pair === 'usdg' ? !same(other, USDG) : false) reject('V4 pair mode does not match the pool');
    const knownV4 = KNOWN_HOOKS.has(lc(pk.hooks)), hooklessV4 = same(pk.hooks, ZERO);
    if (!knownV4 && !(hooklessV4 && knownQuote(other))) reject('V4 pool has an unknown hook and an unknown quote asset');
    const feeV4 = Number(pk.fee); if (feeV4 === DYNAMIC_FEE_FLAG ? !knownV4 : feeV4 > MAX_STATIC_FEE) reject('V4 fee is above the ceiling');
    quote = other;
  } else if (route.type === 'inf') {
    const pk = route.poolKey; const cs = [lc(pk.currency0), lc(pk.currency1)];
    if (!CFG.infPoolManager || !same(pk.poolManager, CFG.infPoolManager)) reject('not the PancakeSwap Infinity pool manager');
    if (!cs.includes(lc(token))) reject('Infinity pool does not contain this token');
    const other = cs[0] === lc(token) ? cs[1] : cs[0];
    if (!same(route.quoteToken, other)) reject('Infinity quote asset is not in the pool');
    // F-36 + F-65 (V12): mirror of the V4 branch (Infinity pairs only native/weth/other).
    if (route.pair === 'native' ? !same(other, ZERO) : route.pair === 'weth' ? !same(other, WETH) : false) reject('Infinity pair mode does not match the pool');
    const knownInf = KNOWN_HOOKS.has(lc(pk.hooks)), hooklessInf = same(pk.hooks, ZERO);
    if (!knownInf && !(hooklessInf && knownQuote(other))) reject('Infinity pool has an unknown hook and an unknown quote asset');
    const feeInf = Number(pk.fee); if (feeInf === DYNAMIC_FEE_FLAG ? !knownInf : feeInf > MAX_STATIC_FEE) reject('Infinity fee is above the ceiling');
    quote = other;
  }
  // bridge legs: wrapped gas token → known assets → the verified quote, on known fee tiers
  const hops = (route.bridgeHops || []).map(lc), fees = route.bridgeFees || [];
  if (hops.length) {
    if (!same(hops[0], WETH)) reject('bridge must start from the wrapped gas token');
    if (quote && !same(quote, ZERO) && !same(hops[hops.length - 1], quote)) reject('bridge must end at the verified quote asset');
    for (const h of hops.slice(1, -1)) if (!BRIDGE_TOKENS.has(h)) reject('bridge passes through an unknown asset');
    for (const f of fees) if (!V3_TIERS.has(Number(f))) reject('bridge uses an unknown fee tier');
  } else if (route.bridgeFee && !V3_TIERS.has(Number(route.bridgeFee))) reject('bridge uses an unknown fee tier');   // 0 = no bridge (native pair)
}
// Verification runs the moment a route arrives and is awaited only before the
// first write, so it overlaps the balance read instead of adding a round trip;
// a verdict is remembered per route shape for ten minutes and a hover prewarm
// leaves the click with nothing left to check.
const verifyCache = new Map<string, { at: number; p: Promise<void> }>();
const verifiedRoutes = new WeakMap<object, Promise<void>>();
const VERIFY_TTL = 10 * 60_000;
function verifyRoute(token: `0x${string}`, route: Route): Promise<void> {
  const hit = verifiedRoutes.get(route); if (hit) return hit;
  const sig = lc(token) + JSON.stringify(route);
  let v = verifyCache.get(sig);
  if (!v || Date.now() - v.at > VERIFY_TTL) {
    const p = checkRoute(lc(token) as `0x${string}`, route);
    v = { at: Date.now(), p }; verifyCache.set(sig, v);
    p.catch(() => verifyCache.delete(sig));
    if (verifyCache.size > 500) verifyCache.delete(verifyCache.keys().next().value as string);
  }
  verifiedRoutes.set(route, v.p);
  return v.p;
}
// ── V13 VA-1: the vault reads the route itself ──
// Up to V12 the frame signed the PAGE's route: the venue contracts were verified on chain, but the pool was whatever
// the page named — a script on motion.gift could hand it a hookless V4 / Infinity pool (or a V2 path, a V3 tier, a
// bridge tier) it had just created with dust at an absurd price, and every position sold into it with no dialog. Now
// the frame asks motion's /route itself (the lane's API on the origin that framed it — the frame's CSP has always
// allowed it, the Solana frame reads its routes the same way) and keeps the answer stale-while-revalidate: served up
// to OWN_MAX, re-read in the background once older than OWN_FRESH. The token page's prewarm (every 6 s) keeps it warm,
// so the click finds it in memory: 0 round trips. The page's hint is used only while the vault has no copy yet — it
// starts the click's reads, and the vault's own read (started at the same moment, beside the balance read) is awaited
// before the first write: equal → go on; different → the click re-runs on the vault's route; unreadable → only a
// route whose pool no page can choose is signed (v13Guards.selfCanonical), anything else is refused (fail closed).
const OWN_FRESH = 10_000, OWN_MAX = 60_000, OWN_TIMEOUT = 3_000;
type OwnEntry = { at: number; p: Promise<Route | null>; v?: Route; vAt?: number; err?: string; empty?: boolean };
const ownRoutes = new Map<string, OwnEntry>();
const routeApi = () => (HOST && parentOrigin ? parentOrigin : location.origin) + (CFG.key === 'bsc' ? '/bsc' : CFG.key === 'elysium' ? '/elysium' : '') + '/api';   // (trade-core.patch E6: + '/elysium')
// (fix2 p2-speed-03, 2026-11-01) a FINISHED read that left no usable copy (motion answered "still looking" / "still measuring",
// or nothing) is not served as fresh for OWN_FRESH: it is read again after OWN_RETRY_MS. It used to stand 10 s — the token
// page's prewarm met a cold coin's 202, and the click a few seconds later, holding motion's now-executable proposal, was
// refused ("the vault could not read this market from motion itself") or answered from that empty read. A copy in hand, or a
// read still in flight, is served exactly as before.
const OWN_RETRY_MS = 750;
function refreshOwnRoute(key: string, force = false): Promise<Route | null> {
  const e = ownRoutes.get(key);
  if (e && !force && Date.now() - e.at < (e.empty ? OWN_RETRY_MS : OWN_FRESH)) return e.p;
  const next: OwnEntry = { at: Date.now(), p: Promise.resolve(null), v: e?.v, vAt: e?.vAt };
  next.p = fetch(`${routeApi()}/token/${key}/route`, { cache: 'no-store', signal: AbortSignal.timeout(OWN_TIMEOUT) })
    .then((r) => r.json()).catch(() => null)
    .then((j: { ok?: boolean; route?: Route & { chainId?: number }; error?: string } | null) => {
      if (j?.ok && j.route && typeof j.route === 'object' && !(j.route.chainId && Number(j.route.chainId) !== CFG.id)) {
        // the same object while the answer does not change: verifyRoute's per-object memo keeps hitting
        const v = next.v && sameRoute(next.v, j.route) ? next.v : j.route;
        next.v = v; next.vAt = Date.now(); next.err = ''; return v;
      }
      next.err = String(j?.error || '');
      const kept = next.v && next.vAt && Date.now() - next.vAt < OWN_MAX ? next.v : null;   // a failed re-read keeps the last good copy
      next.empty = !kept;
      return kept;
    });
  ownRoutes.set(key, next);
  if (ownRoutes.size > 300) ownRoutes.delete(ownRoutes.keys().next().value as string);
  return next.p;
}
const ownRouteNow = (key: string): Route | null => { const e = ownRoutes.get(key); return e?.v && e.vAt && Date.now() - e.vAt < OWN_MAX ? e.v : null; };
// the click re-runs on the vault's own route when the page's hint turned out to be another one
class RouteChanged extends Error { route: Route; constructor(route: Route) { super('The market changed while the click was prepared'); this.name = 'RouteChanged'; this.route = route; } }
const vouches = new WeakMap<object, Promise<void>>();
const vouchFor = (route: Route) => vouches.get(route) ?? Promise.resolve();
function vouchHint(key: string, route: Route): Promise<void> {
  const p = (async () => {
    const own = await refreshOwnRoute(key);
    if (own) { if (sameRoute(own, route)) return; throw new RouteChanged(own); }
    if (!selfCanonical(route as never, { hooks: KNOWN_HOOKS, bridgeTokens: BRIDGE_TOKENS }, key)) reject('the vault could not read this market from motion itself, and the page\'s route names a pool only that read can confirm — try again in a moment');
  })();
  p.catch(() => {});
  return p;
}
async function routeFor(token: string, hint?: unknown): Promise<Route> {
  const key = lc(token);
  const own = ownRouteNow(key);
  const fresh = refreshOwnRoute(key);   // re-read in the background once older than OWN_FRESH (no-op otherwise)
  const j = hint && typeof hint === 'object' ? (hint as { ok?: boolean; route?: Route & { chainId?: number }; error?: string }) : null;
  if (own) {
    // the page holds another answer than our copy (a migration, a re-rank): our copy is re-read now, for the next click
    if (j?.ok && j.route && !sameRoute(own, j.route)) refreshOwnRoute(key, true).catch(() => {});
    verifyRoute(key as `0x${string}`, own).catch(() => {}); return own;
  }
  if (!j) {
    const r = await fresh;
    if (!r) throw new Error(ownRoutes.get(key)?.err || 'No executable market for this token');
    verifyRoute(key as `0x${string}`, r).catch(() => {});
    return r;
  }
  if (!j.ok || !j.route) throw new Error(j.error || 'No executable market for this token');
  // a route from another chain's indexer must never be signed here
  if (j.route.chainId && Number(j.route.chainId) !== CFG.id) throw new Error(`This market is on chain ${j.route.chainId}; the terminal is connected to ${CFG.name}`);
  const route = j.route as Route;
  verifyRoute(key as `0x${string}`, route).catch(() => {});   // starts now, awaited before the first write
  vouches.set(route, vouchHint(key, route));                     // likewise: the vault's own read must agree
  return route;
}
// V13 VA-1: a V2 sell through an asset the chain does not know needs the vault's own dialog for that click (once per
// route for two minutes: every wallet of the click shares it)
const hopConfirmed = new Map<string, number>();

// A sell has to let the venue pull the token first: an ERC-20 approve for the
// curve or the V3 router, and for V4 an approve to Permit2 plus a Permit2
// allowance for the Universal Router. Done at sell time that is two extra
// transactions and two receipts — which is exactly why a sell used to take far
// longer than a buy. So the moment a buy lands we arm the sell path in the
// background, for the maximum amount, once per wallet+token+venue.
const MAX_UINT256 = (1n << 256n) - 1n;
const armed = new Set<string>();
async function armSellPath(acct: Account, token: `0x${string}`, route: Route, attempt = 0, idx = 0) {
  if (CFG.key === 'elysium' || route.type === 'ely') return;   // (trade-core.patch E7) Elysium sells approve exactly their amount, at sell time
  const account = accountOf(acct);
  const key = `${account.address}:${token}:${route.type}`.toLowerCase();
  if (armed.has(key)) return;
  armed.add(key);
  try {
    await verifyRoute(token, route);
    const wallet = createWalletClient({ account, chain, transport });
    const gasPrice = await feeFor(1);
    const isP2 = route.type === 'v4' || route.type === 'inf' || (route.type === 'standard' && route.stage === 'pool');
    // V4 (Uniswap's Permit2 + Universal Router) and Infinity (PancakeSwap's own pair)
    const p2 = (route.type === 'inf' ? CFG.permit2 : PERMIT2) as `0x${string}`, ur = (route.type === 'inf' ? CFG.universalRouter : UNIVERSAL_ROUTER) as `0x${string}`;
    const spender = (route.type === 'pons' ? route.curve : route.type === 'v3' ? UNISWAP_V3_ROUTER : route.type === 'four' ? route.manager : route.type === 'flap' ? route.portal : route.type === 'v2' ? route.router : route.type === 'standard' && route.stage === 'curve' ? route.curve : p2) as `0x${string}`;
    // both allowances in one batched round trip
    const [allowance, p2a] = await Promise.all([
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender] }),
      isP2 ? publicClient.readContract({ address: p2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, ur] }) as unknown as Promise<[bigint, number, number]> : Promise.resolve(null),
    ]);
    const calls: any[] = [];
    if (allowance <= MAX_UINT256 / 2n) calls.push({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] });
    if (p2a && !(p2a[0] >= MAX_UINT160 / 2n && BigInt(p2a[1]) > BigInt(Math.floor(Date.now() / 1000) + 86400))) calls.push({ address: p2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, ur, MAX_UINT160, Number(MAX_UINT48)] });
    if (!calls.length) return;
    // Permit2.approve only writes Permit2's own table (it never reads the token's
    // allowance), so the two approvals are proved and priced together and go out
    // back to back with consecutive nonces: armed one block after the buy instead
    // of approve → 4 s receipt poll → read → approve (measured: 5-30 s, and a
    // 429 anywhere left the wallet unarmed until its next buy)
    const gases = await Promise.all(calls.map((c) => heavyFor(idx).estimateGas({ account, to: c.address, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }), gasPrice, prepare: false })));
    for (let i = 0; i < calls.length; i += 1) await sendCall(wallet, account, calls[i], gasPrice, gases[i] + gases[i] / 5n);
  } catch {
    // a refused read or estimate (a 429) is worth two more tries a moment later; after that the next buy retries
    armed.delete(key);
    if (attempt < 2) setTimeout(() => { armSellPath(acct, token, route, attempt + 1, idx).catch(() => {}); }, 1500 * (attempt + 1));
  }
}

// per wallet: ok + hash (the trade's own transaction) or error; state (TxState of that transaction); txs (every
// transaction this wallet sent for the click — an approval or a bridge leg before the trade); stages (ms per stage)
type Result = { name: string; address: string; ok: boolean; hash?: string; error?: string; state?: TxState; txs?: TxRec[]; stages?: Record<string, number> };
// One trade per wallet+token+side at a time in this frame: a second press while the first is still being
// quoted/signed/sent (a double click, the board and the token page at once, a timeout the page gave up on)
// is refused for that wallet instead of buying twice. Cleared the moment the first one is submitted or failed.
const inFlight = new Set<string>();
// A click over many wallets (the vault holds up to 100) runs through a bounded pool per chain instead of every wallet
// at once: 50 wallets used to mean ~50 estimates and ~150 sendRaw posts in the same instant — what public nodes answer
// with 429s. The first POOL wallets start together, in the click's order (a snipe still lands in the first block
// for most of them); the rest take a slot the moment one frees. Settings → sendPool overrides (1–25).
// (measured with 50 intercepted wallets: EVM 10 cut the burst from 54 to 14 requests and all-sent from 1.4 s to 0.8 s;
// Solana's relays took 17 at once without a 429, and 8 made the click 2× slower — 16 there)
const SEND_POOL = { evm: 10, sol: 16, near: 6 } as const;
const poolSize = (kind: keyof typeof SEND_POOL) => { const v = Math.floor(Number(loadSettings().sendPool)); return v >= 1 ? Math.min(25, v) : SEND_POOL[kind]; };
async function pooled<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
// What a router call pays this wallet in the gas token, proven without the wallet holding the asset the
// call passes through: eth_call to the wallet's own address with a 70-byte forwarder as its code (a state
// override, nothing deployed). The forwarder calls the router with the calldata as the wallet — msg.sender
// is the wallet, so its real ERC-20 / Permit2 allowances and balance apply — takes the router's ETH in
// (empty calldata: stop) and returns its own balance change; a revert comes back as the router's revert.
// null: the call reverted or the node has no code override (a user's own RPC).
// (CALLER ≠ 0: a call into the wallet from inside the run — the router's ETH payout, a token's callback — stops there)
const ETH_DELTA_CODE = (target: string) => `0x33151560455747366000600037600060003660003473${target.slice(2).toLowerCase()}5af115603a57470360005260206000f35b3d600060003e3d6000fd5b00` as `0x${string}`;
async function ethDeltaOf(client: ReturnType<typeof createPublicClient>, wallet: `0x${string}`, call: { address: `0x${string}`; abi: any; functionName: string; args: readonly unknown[] }, balance?: bigint): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as any);
    const over = { code: ETH_DELTA_CODE(call.address), ...(balance != null ? { balance: '0x' + balance.toString(16) } : {}) };
    const r = await client.request({ method: 'eth_call', params: [{ to: wallet, data }, 'latest', { [wallet]: over }] } as any) as string;
    return /^0x[0-9a-f]{1,64}$/i.test(r) ? BigInt(r) : null;
  } catch { return null; }
}
// The balances of every wallet in the click, read once: one Multicall3 call for
// N wallets instead of N reads in one batch. Exact wei (a sell sizes itself
// from this), per-wallet reads when the chain has no Multicall3.
const QUOTE_FUNDING = parseEther('1');   // gas headroom on top of the amount for a shared quote's simulation
function tradeBalances(shared: Shared, side: 'buy' | 'sell', token: `0x${string}`): Promise<Record<string, bigint>> {
  return shared.once('balances', async () => {
    const addrs = shared.addresses;
    const one = (a: `0x${string}`) => side === 'buy' ? publicClient.getBalance({ address: a }) : publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] });
    const contracts = addrs.map((a) => side === 'buy' ? { address: MULTICALL3, abi: multicall3Abi, functionName: 'getEthBalance', args: [a] } : { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] });
    // a wallet whose read failed is left out (its trade says "Balance read failed"); the others go on
    const each = () => Promise.all(addrs.map((a) => one(a).catch(() => null)));
    const vals: (bigint | null)[] = addrs.length > 1 && multicallOk
      ? await publicClient.multicall({ contracts: contracts as any, allowFailure: true }).then(async (rs) => { const miss = rs.map((r) => r.status !== 'success'); const again = miss.some(Boolean) ? await Promise.all(addrs.map((a, i) => (miss[i] ? one(a).catch(() => null) : null))) : []; return rs.map((r, i) => (r.status === 'success' ? r.result as bigint : again[i] ?? null)); }).catch(each)
      : await each();
    return Object.fromEntries(addrs.map((a, i) => [a.toLowerCase(), vals[i]]).filter(([, v]) => v != null)) as Record<string, bigint>;
  });
}
async function tradeOne(acct: Account, side: 'buy' | 'sell', token: `0x${string}`, size: number, route: Route, s: Settings, click: Shared = makeShared([acct.address])): Promise<`0x${string}`> {
  if (CFG.key === 'elysium' || route.type === 'ely') return elyTradeOne(acct, side, token, size, route, s, click);   // (trade-core.patch E8)
  const account = accountOf(acct);
  // the click as this wallet sees it: shared reads, plus its own stage clock and transaction states
  const shared = click.view(account.address);
  const wallet = createWalletClient({ account, chain, transport });
  // this wallet's node for its own heavy calls (estimate, per-wallet router simulations): spread, see heavyFor
  const hv = heavyFor(Math.max(0, shared.addresses.findIndex((a) => same(a, account.address))));
  const slippageBps = BigInt(Math.round(s.slippage * 100));
  // F-6 (V12): a non-positive minimum-out is an unbounded swap (any output accepted) —
  // a spoofed/zero quote must stop the trade, never go out with a 0 floor.
  const applySlippage = (q: bigint) => { const floor = (q * (10_000n - slippageBps)) / 10_000n; if (floor <= 0n) throw new Error('Refusing to trade without a minimum-out floor'); return floor; };
  // a buy-side quote is the same number for every wallet: made once per click, shared
  const quoteOnce = <T,>(key: string, fn: () => Promise<T>) => (side === 'buy' ? shared.once(key, fn) : fn());
  // The venue quotes, one definition each, keyed so that every wallet of the
  // click and the prefetch below share one round trip.
  // A quote shared by every wallet of the click is simulated by whichever wallet asked first, carrying the ETH as
  // msg.value: an underfunded first wallet made the node answer "insufficient funds" and that answer was cached for
  // the whole click (6 wallets failed for one empty one). The quoting account's balance is overridden for the
  // simulation: the price does not depend on who asks; each wallet's own funds are checked by its own guard.
  const funded = (amount: bigint) => [{ address: account.address, balance: amount + QUOTE_FUNDING }];
  const bridgeQuote = (quoteToken: `0x${string}`, path: `0x${string}`, amount: bigint) => quoteOnce(`q:bridge:${quoteToken}:${amount}`, () => heavy.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path, recipient: account.address, amountIn: amount, amountOutMinimum: 0n }], value: amount, stateOverride: funded(amount) }));
  // A coarse gas-token value of `amount` of a quote asset, for a node that cannot run ethDeltaOf: the forward
  // rate of a small gas-token → quote probe inverted, 2 % under it. Never used as a quote, only as a floor.
  const ethForQuote = async (q: `0x${string}`, path: `0x${string}`, amount: bigint): Promise<bigint> => {
    const probe = parseEther(CFG.key === 'bsc' ? '0.01' : '0.001');
    const fwd = await bridgeQuote(q, path, probe).then((r) => r.result as bigint, () => 0n);
    if (fwd <= 0n) return 0n;
    const est = (amount * probe) / fwd;
    return est - est / 50n;
  };
  // what `amount` of a quote asset fetches on the V3 walk back to the gas token, priced without the wallet holding
  // it: PancakeSwap's QuoterV2 on BNB, the forward-rate floor where no V3 quoter is known (Robinhood)
  const v3BackOut = async (q: `0x${string}`, reverse: `0x${string}`, forward: `0x${string}`, amount: bigint): Promise<bigint> => {
    if (CFG.key === 'bsc') { const v = await publicClient.simulateContract({ address: BSC.v3Quoter, abi: V3_QUOTER_ABI, functionName: 'quoteExactInput', args: [reverse, amount] }).then((r) => r.result[0], () => 0n); if (v > 0n) return v; }
    return ethForQuote(q, forward, amount);
  };
  const quoteV4Pool = (pk: V4PoolKey, zeroForOne: boolean, exactAmount: bigint) => quoteOnce(`q:v4:${zeroForOne}:${exactAmount}`, async () => {
    const r = await hv.simulateContract({ account, address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount, hookData: '0x' }] });
    return (r.result as readonly [bigint, bigint])[0];
  });
  const quoteInfPool = (pk: InfPoolKey, zeroForOne: boolean, exactAmount: bigint) => quoteOnce(`q:inf:${zeroForOne}:${exactAmount}`, async () => ((await heavy.simulateContract({ account, address: BSC.clQuoter, abi: CL_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount, hookData: '0x' }] })).result as readonly [bigint, bigint])[0]);
  // V13 VA-1: a HOOKLESS V4 / Infinity pool on the gas token (or its wrapped form) — the kind anyone can create with dust
  // at an absurd price — competes with the hookless pools of both at the standard tiers. They are quoted in the SAME
  // multicall as the hinted pool's own quote (the call that used to carry it alone): no extra round trip. The hint
  // stands within 2 % of the best; otherwise the trade goes through the best (v13Guards.pickPool), and the floor comes
  // from that pool's quote. Pools behind a known launcher hook (Pons, Long, DART, genius) are not compared.
  const hookless = (r: Route): boolean => (r.type === 'v4' || r.type === 'inf') && same(r.poolKey.hooks, ZERO) && (r.pair === 'native' || r.pair === 'weth');
  type Picked = { choice: ReturnType<typeof pickPool<any>>; hintOuts: Map<string, bigint | null> };
  const pickFor = (amounts: bigint[], ref: bigint): Promise<Picked> => shared.once(`pick:${side}:${amounts.join(',')}`, async () => {
    const r = route as Extract<Route, { type: 'v4' | 'inf' }>; const inf = r.type === 'inf';
    const cands = (inf ? infCandidates(token, WETH, CFG.infPoolManager || ZERO) : v4Candidates(token, WETH)).filter((c) => !sameKey(c.key, r.poolKey));
    const inputOf = (pair: string) => (side === 'sell' ? token : pair === 'native' ? ZERO : WETH);
    const call = (k: any, pair: string, a: bigint) => ({ address: (inf ? BSC.clQuoter : V4_QUOTER) as `0x${string}`, abi: inf ? CL_QUOTER_ABI : V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: k, zeroForOne: lc(k.currency0) === lc(inputOf(pair)), exactAmount: a, hookData: '0x' }] });
    const calls = [...amounts.map((a) => call(r.poolKey, r.pair, a)), ...cands.map((c) => call(c.key, c.pair, ref))];
    const first = (x: unknown) => (x as readonly [bigint, bigint])[0];
    const single = () => Promise.all(calls.map((c) => heavy.simulateContract(c as any).then((x) => first(x.result), () => null)));
    const outs: (bigint | null)[] = multicallOk
      ? await heavy.multicall({ contracts: calls as any, allowFailure: true }).then((res) => res.map((x) => (x.status === 'success' ? first(x.result) : null)), single)
      : await single();
    const hintOuts = new Map(amounts.map((a, i) => [String(a), outs[i]] as [string, bigint | null]));
    return { choice: pickPool<any>({ key: r.poolKey, out: hintOuts.get(String(ref)) ?? null }, cands.map((c, i) => ({ key: c.key, pair: c.pair, out: outs[amounts.length + i] }))), hintOuts };
  });
  // every wallet's sell amount of the click, sorted (the same list, so the same memo key, in every wallet)
  const sellAmounts = async (mine: bigint) => { const bals = await tradeBalances(shared, 'sell', token); return [...new Set([mine, ...shared.addresses.map((a) => sellAmount(bals[lc(a)] ?? 0n))].filter((x) => x > 0n).map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); };
  const quoteFlap = (portal: `0x${string}`, input: `0x${string}`, output: `0x${string}`, amount: bigint) => quoteOnce(`q:flap:${input}:${output}:${amount}`, async () => (await heavy.simulateContract({ account, address: portal, abi: FLAP_PORTAL_ABI, functionName: 'quoteExactInput', args: [{ inputToken: input, outputToken: output, inputAmount: amount }] })).result as bigint);
  const quoteV2 = (router: `0x${string}`, amount: bigint, path: `0x${string}`[]) => quoteOnce(`q:v2:${amount}`, () => heavy.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amount, path] }));
  const stdPath = (r: Extract<Route, { type: 'standard' }>, sd: 'buy' | 'sell') => standardPath(sd, token, r.stock, r.poolKey!, r.stockPool, r.ethPool, CFG.standard!.usdg);
  const quoteStdBuy = (r: Extract<Route, { type: 'standard' }>, amount: bigint) => quoteOnce(`q:std:${r.stage}:${amount}`, async () => (r.stage === 'pool'
    ? ((await heavy.simulateContract({ account, address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_PATH_ABI, functionName: 'quoteExactInput', args: [{ exactCurrency: ZERO, path: stdPath(r, 'buy'), exactAmount: amount }] })).result as readonly [bigint, bigint])[0]
    : (await heavy.simulateContract({ account, address: r.router, abi: STANDARD_ROUTER_ABI, functionName: 'buyExactIn', args: [r.curve, ZERO, amount, 0n, 0n, account.address, ZERO, NO_FEE], value: amount, stateOverride: funded(amount) })).result as bigint));
  const quoteFour = (helper: `0x${string}`, funds: bigint) => quoteOnce(`q:four:${funds}`, () => heavy.readContract({ address: helper, abi: FOUR_HELPER_ABI, functionName: 'tryBuy', args: [token, 0n, funds] }));
  const quoteV3Path = (path: `0x${string}`, amount: bigint, isBuy: boolean) => quoteOnce(`q:v3:${amount}`, () => hv.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path, recipient: account.address, amountIn: amount, amountOutMinimum: 0n }], value: isBuy ? amount : undefined, ...(isBuy ? { stateOverride: funded(amount) } : {}) }));
  const v3SingleArgs = (tokenIn: `0x${string}`, tokenOut: `0x${string}`, fee: number, amount: bigint) => ({ tokenIn, tokenOut, fee, recipient: account.address, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n });
  const quoteV3Single = (tokenIn: `0x${string}`, tokenOut: `0x${string}`, fee: number, amount: bigint, isBuy: boolean) => quoteOnce(`q:v3s:${amount}`, () => hv.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [v3SingleArgs(tokenIn, tokenOut, fee, amount)], value: isBuy ? amount : undefined, ...(isBuy ? { stateOverride: funded(amount) } : {}) }));
  // ── BNB Chain: what a click can ask before the quote is back ──
  // BSC makes a block every 0.45 s, so every round trip off the click is most
  // of a block. The gas estimate of a venue call does not depend on its minOut
  // (the same code runs; only the last require differs), so a BNB venue call is
  // estimated with minOut 0 next to its quote instead of behind it; the
  // transaction signed still carries the quoted minOut. Turbo estimates nothing.
  const bscEarly = new Map<string, Promise<bigint | null>>();
  const bscEstimate = (key: string, call: any): Promise<bigint | null> => {
    let p = bscEarly.get(key);
    if (!p) {
      p = s.turbo || !call ? Promise.resolve(null) : hv.estimateGas({ account, to: call.address, data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }), value: call.value ?? 0n, prepare: false } as any).catch(() => null);
      bscEarly.set(key, p);
    }
    return p;
  };
  // the allowances a BNB venue needs, for every wallet of the click in one Multicall3 call
  const bscReadAll = <T,>(key: string, contract: (a: `0x${string}`) => any): Promise<T> => shared.once(key, async () => {
    const addrs = shared.addresses;
    const direct = () => Promise.all(addrs.map((a) => publicClient.readContract(contract(a))));
    const vals = addrs.length > 1 && multicallOk ? await publicClient.multicall({ contracts: addrs.map(contract) as any, allowFailure: false }).catch(direct) : await direct();
    return Object.fromEntries(addrs.map((a, i) => [lc(a), vals[i]])) as Record<string, unknown>;
  }).then((m) => m[lc(account.address)] as T);
  const bscAllowance = (tok: `0x${string}`, spender: `0x${string}`) => bscReadAll<bigint>(`bsc:allow:${lc(tok)}:${lc(spender)}`, (a) => ({ address: tok, abi: ERC20_ABI, functionName: 'allowance', args: [a, spender] }));
  const bscPermit2 = (tok: `0x${string}`) => bscReadAll<readonly [bigint, number, number]>(`bsc:p2:${lc(tok)}`, (a) => ({ address: CFG.permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [a, tok, CFG.universalRouter] }));
  const bscApprove = (tok: `0x${string}`, spender: `0x${string}`) => ({ address: tok, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] });
  // A bridged buy (a USD1/USDT-quoted four.meme coin) builds its venue call on the
  // bridge leg's floor before the leg is mined, so that floor is kept tight: 1 %
  // (or the user's slippage when lower). What the leg delivers above it stays in
  // the wallet as the quote asset and goes back to BNB with the coin's next sell.
  const bridgeMin = (q: bigint) => q - (q * (slippageBps < 100n ? slippageBps : 100n)) / 10_000n;
  const quoteV2Bridged = (router: `0x${string}`, quote: `0x${string}`, amount: bigint) => quoteOnce(`q:v2b:${lc(quote)}:${amount}`, () => heavy.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amount, [quote, token]] }));
  // the buy with minOut 0 — the early gas proof; null where the call depends on a quote (bridged buys go through eth_simulateV1)
  const bscBuyProbe = (amount: bigint): any | null => {
    const dl = BigInt(Math.floor(Date.now() / 1000) + 300);
    // V13 (speed, G4): Robinhood's Pons (gas-token pair), V4 (gas token / WETH) and V3 (WETH) buys get the same early proof
    if (route.type === 'pons') return lc(route.pairToken) === ZERO ? { address: route.curve, abi: PONS_CURVE_ABI, functionName: 'buy', args: [amount, 0n, account.address], value: amount } : null;
    if (route.type === 'v4') {
      const pk = route.poolKey;
      const enc = route.pair === 'native' ? encodeV4BuyNative(pk, token, amount, 0n) : route.pair === 'weth' ? encodeV4BuyViaWeth(pk, token, WETH, amount, 0n) : null;
      return enc ? { address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [enc.commands, enc.inputs, dl], value: amount } : null;
    }
    if (route.type === 'v3') return same(route.quoteToken, WETH) ? { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [v3SingleArgs(WETH, token, route.fee, amount)], value: amount } : null;
    if (route.type === 'four') return lc(route.quoteToken) === ZERO ? { address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'buyTokenAMAP', args: [token, amount, 0n], value: amount } : null;
    if (route.type === 'flap') return lc(route.quoteToken) === ZERO || route.nativeToQuote ? { address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'swapExactInput', args: [{ inputToken: ZERO, outputToken: token, inputAmount: amount, minOutputAmount: 0n, permitData: '0x' }], value: amount } : null;
    if (route.type === 'v2') return route.path.length ? { address: route.router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [0n, route.path, account.address, dl], value: amount } : null;
    if (route.type === 'standard') {
      if (route.stage === 'curve') return { address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'buyExactIn', args: [route.curve, ZERO, amount, 0n, 0n, account.address, ZERO, NO_FEE], value: amount };
      const enc = encodeStandardSwap(ZERO, stdPath(route, 'buy'), amount, 0n);
      return { address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [enc.commands, enc.inputs, dl], value: amount };
    }
    if (route.type === 'inf') {
      const pk = route.poolKey; const b = route.pair === 'other' ? bridgeOf(route, route.quoteToken) : null;
      const enc = route.pair === 'native' ? encodeInfBuyNative(pk, token, amount, 0n) : route.pair === 'weth' ? encodeInfBuyViaWrapped(pk, token, WETH, amount, 0n) : b ? encodeInfBuyViaPath(pk, token, route.quoteToken, b.path, amount, 0n) : null;
      return enc ? { address: CFG.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [enc.commands, enc.inputs, dl], value: amount } : null;
    }
    return null;
  };
  // The sell side armed in the same click: an approval does not depend on the
  // buy, so it is read and priced while the buy is quoted and goes out with the
  // next nonce right behind the buy instead of after its receipt (armSellPath
  // then finds nothing to do). A sell a second later is one transaction.
  const armKey = `${account.address}:${token}:${route.type}`.toLowerCase();
  let bscArming: Promise<any[]> | null = null;
  const bscArmCalls = async (): Promise<any[]> => {
    const out: any[] = [];
    if (route.type === 'inf' || (route.type === 'standard' && route.stage === 'pool')) {
      const [a, p] = await Promise.all([bscAllowance(token, CFG.permit2), bscPermit2(token)]);
      if (a <= MAX_UINT256 / 2n) out.push(bscApprove(token, CFG.permit2));
      if (p[0] < MAX_UINT160 / 2n || BigInt(p[1]) <= BigInt(Math.floor(Date.now() / 1000) + 86400)) out.push({ address: CFG.permit2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, CFG.universalRouter, MAX_UINT160, Number(MAX_UINT48)] });
    } else {
      const spender = route.type === 'four' ? route.manager : route.type === 'flap' ? route.portal : route.type === 'v2' ? route.router : route.type === 'standard' ? route.curve : null;
      if (spender && (await bscAllowance(token, spender)) <= MAX_UINT256 / 2n) out.push(bscApprove(token, spender));
    }
    // a coin quoted in USD1/USDT/a stock sells into that asset and walks it back to BNB on PancakeSwap V3: that approval too
    const q = route.type === 'four' || route.type === 'flap' || (route.type === 'v2' && !route.path.length) ? lc((route as { quoteToken: string }).quoteToken) as `0x${string}` : null;
    if (q && q !== ZERO && bridgeOf(route as Bridge, q) && (await bscAllowance(q, UNISWAP_V3_ROUTER)) <= MAX_UINT256 / 2n) out.push(bscApprove(q, UNISWAP_V3_ROUTER));
    return out;
  };
  const bscArmBehindBuy = () => {
    const arming = bscArming;
    if (!arming || armed.has(armKey)) return;
    armed.add(armKey);
    (async () => {
      const calls = await arming;
      for (let i = 0; i < calls.length; i += 1) {
        const g = await bscEstimate(`arm:${i}`, calls[i]);
        if (g == null && !s.turbo) throw new Error('approval estimate failed');   // armSellPath retries it after the receipt
        await sendCall(wallet, account, calls[i], gasPrice, g != null ? g + g / 5n : 120_000n);
      }
    })().catch(() => armed.delete(armKey));
  };
  // buy-time reads of the BNB venues, all at t=0 next to the balance read
  const bscPrefetch = (amount: bigint) => {
    // (Flap's Portal is the same on Robinhood: its early gas proof and sell-side arming run there too)
    if (!(CFG.key === 'bsc' && ['four', 'flap', 'v2', 'inf'].includes(route.type)) && route.type !== 'flap' && route.type !== 'standard') return;
    const probe = bscBuyProbe(amount); if (probe) bscEstimate('buy', probe);
    if (!armed.has(armKey)) { bscArming = bscArmCalls().then((calls) => { calls.forEach((c, i) => { bscEstimate(`arm:${i}`, c); }); return calls; }); bscArming.catch(() => {}); }
    // a bridged buy: the leg's quote, then the venue's own quote at the leg's floor and the quote asset's allowance
    const viaBridge = (q: `0x${string}`, spender: `0x${string}`, then: (floor: bigint) => Promise<unknown>) => {
      const b = bridgeOf(route as Bridge, q); if (!b) return;
      bridgeQuote(q, b.path, amount).then((r) => then(bridgeMin(r.result as bigint))).catch(() => {});
      bscAllowance(q, spender).catch(() => {});
    };
    if (route.type === 'four' && lc(route.quoteToken) !== ZERO) viaBridge(route.quoteToken, route.manager, (f) => quoteFour(route.helper, f));
    if (route.type === 'flap' && lc(route.quoteToken) !== ZERO && !route.nativeToQuote) viaBridge(route.quoteToken, route.portal, (f) => quoteFlap(route.portal, route.quoteToken, token, f));
    if (route.type === 'v2' && !route.path.length) viaBridge(route.quoteToken, route.router, (f) => quoteV2Bridged(route.router, route.quoteToken, f));
  };
  // A buy's size is known before any read comes back, so the venue quote (the
  // first heavy call, and on a USDG pool the bridge leg before it) starts now
  // and overlaps the balance/fee round trip instead of queueing behind it. The
  // answers are memoised under the keys the branches below ask for; a failure
  // here surfaces there, where it is handled.
  const prefetchBuyQuote = (amountIn: bigint) => {
    const kick = (p: Promise<unknown>) => { p.catch(() => {}); };
    const viaBridge = (q: `0x${string}`, then: (bridged: bigint) => Promise<unknown>) => { const b = bridgeOf(route, q); if (b) kick(bridgeQuote(q, b.path, amountIn).then((r) => then(r.result as bigint))); };
    bscPrefetch(amountIn);   // BNB venues: early gas proof, bridged quotes, sell-side arming (no-op on other chains)
    if (CFG.key !== 'bsc' && !s.turbo && (route.type === 'pons' || route.type === 'v4' || route.type === 'v3')) { const pr = bscBuyProbe(amountIn); if (pr) kick(bscEstimate('buy', pr)); }   // V13 (G4)
    if (hookless(route)) { kick(pickFor([amountIn], amountIn)); return; }   // V13 VA-1: the pool pick carries the quote
    if (route.type === 'pons') { if (route.pairToken.toLowerCase() !== ZERO) viaBridge(route.pairToken, async () => null); return; }
    if (route.type === 'v4') {
      const pk = route.poolKey;
      if (route.pair === 'native') kick(quoteV4Pool(pk, pk.currency0.toLowerCase() === NATIVE_CURRENCY, amountIn));
      else if (route.pair === 'weth') kick(quoteV4Pool(pk, pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn));
      else { const q = (route.pair === 'usdg' ? USDG : route.quoteToken || v4PairCurrency(pk, token)) as `0x${string}`; viaBridge(q, (bridged) => quoteV4Pool(pk, pk.currency0.toLowerCase() === q.toLowerCase(), bridged)); }
      return;
    }
    if (route.type === 'inf') {
      const pk = route.poolKey;
      if (route.pair === 'native') kick(quoteInfPool(pk, pk.currency0.toLowerCase() === ZERO, amountIn));
      else if (route.pair === 'weth') kick(quoteInfPool(pk, pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn));
      else viaBridge(route.quoteToken, (bridged) => quoteInfPool(pk, pk.currency0.toLowerCase() === route.quoteToken.toLowerCase(), bridged));
      return;
    }
    if (route.type === 'four') { if (route.quoteToken.toLowerCase() === ZERO) kick(quoteFour(route.helper, amountIn)); return; }
    if (route.type === 'flap') { if (route.quoteToken.toLowerCase() === ZERO || route.nativeToQuote) kick(quoteFlap(route.portal, ZERO, token, amountIn)); return; }
    if (route.type === 'standard') { kick(quoteStdBuy(route, amountIn)); return; }
    if (route.type === 'v2') { if (route.path.length) kick(quoteV2(route.router, amountIn, route.path)); return; }
    if (route.type === 'v3') {
      if (route.quoteToken.toLowerCase() !== WETH.toLowerCase()) { const b = bridgeOf(route, route.quoteToken); if (b) kick(quoteV3Path(encodeV3Path([...b.hops, token], [...b.fees, route.fee]), amountIn, true)); }
      else kick(quoteV3Single(WETH, token, route.fee, amountIn, true));
    }
  };
  if (side === 'buy') {
    if (!(size > 0) || size > MAX_BUY_ETH) throw new Error('Amount out of range');
    prefetchBuyQuote(parseEther(String(size)));
  }
  // a per-wallet view read (allowance, Permit2 allowance, a pair-asset balance) made for every wallet of the click in one Multicall3 call
  const readAll = <T,>(key: string, contract: (a: `0x${string}`) => any): Promise<T> => shared.once(key, async () => {
    const addrs = shared.addresses;
    const direct = () => Promise.all(addrs.map((a) => publicClient.readContract(contract(a))));
    const vals = addrs.length > 1 && multicallOk ? await publicClient.multicall({ contracts: addrs.map(contract) as any, allowFailure: false }).catch(direct) : await direct();
    return Object.fromEntries(addrs.map((a, i) => [a.toLowerCase(), vals[i]])) as Record<string, unknown>;
  }).then((m) => m[account.address.toLowerCase()] as T);
  const allowanceOf = (tok: `0x${string}`, spender: `0x${string}`) => readAll<bigint>(`allow:${tok}:${spender}`, (a) => ({ address: tok, abi: ERC20_ABI, functionName: 'allowance', args: [a, spender] }));
  const permit2Of = () => readAll<readonly [bigint, number, number]>(`p2:${PERMIT2}:${token}:${UNIVERSAL_ROUTER}`, (a) => ({ address: PERMIT2 as `0x${string}`, abi: PERMIT2_ABI, functionName: 'allowance', args: [a, token, UNIVERSAL_ROUTER as `0x${string}`] }));
  const pairBalanceOf = (tok: `0x${string}`) => readAll<bigint>(`bal:${tok}`, (a) => ({ address: tok, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }));
  // The allowances a Robinhood sell checks, and the pair-asset balance + curve
  // allowance of a stock-curve buy, are asked in the same tick as the balance
  // sheet: the batched transport carries them in the same HTTP request — one
  // round trip where a V4 sell used to make three in a row (balances →
  // allowance → Permit2 allowance). Same calls, same values, asked earlier.
  {
    const kick = (p: Promise<unknown>) => { p.catch(() => {}); };
    if (side === 'sell') {
      // V13 (speed, G10 / G8): the pre-sell balance of a pair / quote asset (the walk-back's "before") and the Standard
      // curve's allowance ride in this batch too, instead of a round trip of their own later
      if (route.type === 'pons' && lc(route.pairToken) !== ZERO) kick(pairBalanceOf(route.pairToken));
      if (route.type === 'flap' && lc(route.quoteToken) !== ZERO) kick(pairBalanceOf(route.quoteToken));
      if (route.type === 'standard' && route.stage === 'curve') kick(bscAllowance(token, route.curve));
      if (route.type === 'pons') kick(allowanceOf(token, route.curve));
      else if (route.type === 'v3') kick(allowanceOf(token, UNISWAP_V3_ROUTER));
      else if (route.type === 'v4') { kick(allowanceOf(token, PERMIT2 as `0x${string}`)); kick(permit2Of()); }
    } else if (route.type === 'pons' && lc(route.pairToken) !== ZERO) { kick(pairBalanceOf(route.pairToken)); kick(allowanceOf(route.pairToken, route.curve)); }
  }
  // Everything the node can answer independently is asked at once: the fee,
  // the balance, and (on a curve) the reserves — one round trip instead of three.
  // The nonce goes out in the same window instead of after the gas estimate.
  nextNonce(account.address).catch(() => {});
  const tReads = performance.now();
  const [gasPrice, balances, reservesPre] = await Promise.all([
    feeFor(s.gasBoost),
    tradeBalances(shared, side, token),
    route.type === 'pons' ? shared.once('reserves', () => publicClient.readContract({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'getReserves' }).catch(() => null)) : Promise.resolve(null),
  ]);
  shared.mark('balances', performance.now() - tReads);
  const balanceRaw = balances[account.address.toLowerCase()];
  if (balanceRaw == null) throw new Error('Balance read failed');
  const send = async (req: any) => { shared.mark('quote', performance.now() - tQuote - (shared.t.gas || 0)); return sendCall(wallet, account, req, gasPrice, s.turbo ? turboGas(route, side, size, req.address, { ur: CFG.universalRouter, v3: UNISWAP_V3_ROUTER }) : req.gas, shared); };
  // Fast mode checks the call with ONE round trip: eth_estimateGas both proves the
  // call does not revert and prices its gas, so the send needs no second
  // estimate. Only when it fails is the slower simulateContract run, for the
  // decoded revert reason. Turbo asks nothing and sends with a fixed gas limit.
  // `prepare: false`: viem would otherwise read the wallet's nonce from the node
  // before every estimate (one more round trip on the click) — the nonce plays
  // no part in eth_estimateGas, and the one that is signed comes from nextNonce().
  // Every wallet estimates its own call (that is the per-wallet revert proof);
  // the estimates of one click are spread over the nodes (hv) so they stay one
  // parallel round trip instead of a 429 and a fallback.
  const sim = async (call: any) => {
    if (s.turbo) return { request: { account, ...call } };
    const t0 = performance.now();
    try {
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
      const est = await hv.estimateGas({ account, to: call.address, data, value: call.value ?? 0n, gasPrice, prepare: false });
      shared.mark('gas', performance.now() - t0);
      return { request: { account, ...call, gas: est + est / 5n } };
    } catch (e) {
      const r = await hv.simulateContract({ account, ...call });   // decodes the custom error; throws it
      shared.mark('gas', performance.now() - t0);
      return r;
    }
  };
  // V13 (speed, G4): a venue call whose gas was proved at t=0 (the same call with a zero floor: the gas does not depend on
  // it) goes out on that proof — one round trip fewer; no proof (or it failed) → the full check, which decodes why.
  const simEarly = async (call: any, early: Promise<bigint | null> | null) => {
    if (s.turbo || !early) return sim(call);
    const t0 = performance.now(); const g = await early;
    if (g == null) return sim(call);
    shared.mark('gas', performance.now() - t0);
    return { request: { account, ...call, gas: g + g / 5n } };
  };
  // An approval the sell cannot do without (the wallet was never armed): proved
  // and priced by one estimate (simulate, then a node-side fill and an
  // eth_chainId behind it, used to be three round trips), sent through the
  // wallet's lane, its receipt polled every block instead of every 4 s.
  const approveIfNeeded = async (tok: `0x${string}`, spender: `0x${string}`, amount: bigint) => {
    const allowance = await allowanceOf(tok, spender);
    if (allowance >= amount) return;
    const t0 = performance.now();
    const req = await sim({ address: tok, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] });
    const h = await sendCall(wallet, account, req.request, gasPrice, s.turbo ? 900_000n : (req.request as any).gas, shared);
    const r = await landed(h);
    shared.mark('approve', performance.now() - t0);
    if (r.status !== 'success') throw new Error('Approval reverted');
  };
  // A V4 sell pulls through Permit2: ERC20 → Permit2, then Permit2 → Universal
  // Router. Permit2.approve writes only Permit2's own table (it never reads the
  // token's allowance), so the two are proved together, go out back to back
  // with consecutive nonces and are awaited together — while the quote runs.
  const v4Approvals = async (amount: bigint) => {
    const [allowance, [p2Amount, p2Expiry]] = await Promise.all([allowanceOf(token, PERMIT2 as `0x${string}`), permit2Of()]);
    const calls: any[] = [];
    if (allowance < amount) calls.push({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2 as `0x${string}`, MAX_UINT256] });
    if (p2Amount < amount || BigInt(p2Expiry) <= BigInt(Math.floor(Date.now() / 1000))) calls.push({ address: PERMIT2 as `0x${string}`, abi: PERMIT2_ABI, functionName: 'approve', args: [token, UNIVERSAL_ROUTER as `0x${string}`, MAX_UINT160, Number(MAX_UINT48)] });
    if (!calls.length) return;
    const t0 = performance.now();
    const reqs = await Promise.all(calls.map((c) => sim(c)));
    const hashes: `0x${string}`[] = [];
    for (const r of reqs) hashes.push(await sendCall(wallet, account, r.request, gasPrice, s.turbo ? 900_000n : (r.request as any).gas, shared));
    const rs = await Promise.all(hashes.map((h) => landed(h)));
    shared.mark('approve', performance.now() - t0);
    rs.forEach((r, i) => { if (r.status !== 'success') throw new Error(calls[i].address === token ? 'Approval reverted' : 'Permit2 approval reverted'); });
  };
  let amountIn: bigint;
  // a sell's size per wallet, one definition: the click-wide quote below sizes every wallet with it
  // (V13, found with the VA-8 probe: four.meme's TokenManager2 refuses an amount that is not a whole multiple of 1e9 —
  // "GW" — so a partial four.meme sell is rounded down to it; a full balance already is one)
  const sellAmount = (bal: bigint) => { const a = (bal * BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100))) / 10_000n; return route.type === 'four' ? a - (a % 1_000_000_000n) : a; };
  if (side === 'buy') {
    if (!(size > 0) || size > MAX_BUY_ETH) throw new Error('Amount out of range');
    amountIn = parseEther(String(size));
    const bal = balanceRaw as bigint;
    // the amount is part of the message: "0.2127 available" alone hid that the click asked for more than any wallet held
    if (bal < amountIn) throw new Error(`Insufficient ${NATIVE}: ${Number(formatEther(bal)).toFixed(4)} available, ${size} needed`);
  } else {
    const bal = balanceRaw as bigint;
    amountIn = sellAmount(bal);
    if (amountIn <= 0n) throw new Error('Nothing to sell in this wallet');
  }
  // resolved long ago after a prewarm; overlapped the balance read otherwise. V13 VA-1: the vault's own read of the route
  // (vouchFor) is awaited here too — beside the on-chain check, before the first write, never in front of the reads
  { const t0 = performance.now(); await Promise.all([verifyRoute(token, route), vouchFor(route)]); shared.mark('verify', performance.now() - t0); }
  const tQuote = performance.now();   // from here to the send is quote + gas: `gas` is clocked in sim(), the rest is the quote
  if (route.type === 'pons') {
    const [quoteReserve, tokenReserve] = (reservesPre as readonly [bigint, bigint] | null) || await publicClient.readContract({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'getReserves' });
    const taxBps = BigInt(Math.max(0, route.feeBps + route.creatorTaxBps));
    const afterTax = (x: bigint) => (x * (10_000n - taxBps)) / 10_000n;
    const headroom = (x: bigint) => x - x / 100n;
    const nativePair = route.pairToken.toLowerCase() === ZERO;
    if (side === 'buy') {
      let pairAmount = amountIn;
      if (!nativePair) {
        const bridge = bridgeOf(route, route.pairToken);
        if (!bridge) throw new Error(`No route from ETH to ${route.quoteSymbol || "this curve's pair asset"}`);
        // the pair-asset balance before the leg and the curve's allowance came back with the balance sheet (one multicall for the click)
        const [before, allowance] = await Promise.all([pairBalanceOf(route.pairToken), allowanceOf(route.pairToken, route.curve)]);
        const legArgs = { path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: 0n };
        const q = await bridgeQuote(route.pairToken, bridge.path, amountIn);
        // A stock-quoted curve buy is three transactions: ETH → stock, approve the
        // curve, buy. The approval does not depend on the swap, so both are proved
        // and priced in one round trip (estimateGas each, side by side) and go out
        // back to back through the wallet's lane with consecutive nonces — in the
        // usual case both land in the same block and the buy follows at once.
        const legCall = { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ ...legArgs, amountOutMinimum: applySlippage(q.result) }], value: amountIn };
        const apCall = allowance < MAX_UINT256 / 2n ? { address: route.pairToken, abi: ERC20_ABI, functionName: 'approve', args: [route.curve, MAX_UINT256] } : null;
        const [leg, ap] = await Promise.all([sim(legCall), apCall ? sim(apCall) : Promise.resolve(null)]);
        const lh = await sendCall(wallet, account, leg.request, gasPrice, s.turbo ? turboGas(route, side, size, UNISWAP_V3_ROUTER, { ur: CFG.universalRouter, v3: UNISWAP_V3_ROUTER }) : (leg.request as any).gas, shared);
        const approveHash = ap ? await sendCall(wallet, account, ap.request, gasPrice, s.turbo ? 900_000n : (ap.request as any).gas, shared) : null;
        // the curve buy is sized by what the leg delivered: that one receipt is the wait left (polled every block)
        const lr = await landed(lh);
        if (lr.status !== 'success') throw new Error('Pair-asset swap reverted');
        const after = await publicClient.readContract({ address: route.pairToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
        pairAmount = after - before;
        if (pairAmount <= 0n) throw new Error('Pair-asset swap delivered nothing');
        // usually already mined alongside the swap; if not, this is the one wait left
        if (approveHash) { const ar = await landed(approveHash); if (ar.status !== 'success') throw new Error('Approval reverted'); }
      }
      const net = afterTax(pairAmount);
      const quoted = (tokenReserve * net) / (quoteReserve + net);
      if (quoted <= 0n) throw new Error('Curve quote returned zero');
      const req = await simEarly({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'buy', args: [pairAmount, applySlippage(headroom(quoted)), account.address], value: nativePair ? pairAmount : undefined }, nativePair ? bscEstimate('buy', bscBuyProbe(amountIn)) : null);
      return send(req.request);
    }
    const quoted = afterTax((quoteReserve * amountIn) / (tokenReserve + amountIn));
    if (quoted <= 0n) throw new Error('Curve sell quote returned zero');
    await approveIfNeeded(token, route.curve, amountIn);
    const req = await sim({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'sell', args: [amountIn, applySlippage(headroom(quoted)), account.address] });
    // F-53 (V12): pair-asset balance before the sell, so the walk-back sweeps only this sell's proceeds
    const beforePair = !nativePair ? await pairBalanceOf(route.pairToken) : 0n;   // V13 (G10): read with the balance sheet
    const hash = await send(req.request);
    // the curve pays in its pair asset (NVDA, META…): swap it back to ETH so the
    // trader ends up with something spendable, not a stock they did not ask for
    if (!nativePair) {
      const bridge = bridgeOf(route, route.pairToken);
      // behind the click: the walk back starts a block after the sell lands, not on the next 4 s poll
      if (bridge) landed(hash, 90_000).then(async (r) => {
        if (r.status !== 'success') return;
        const bal = await publicClient.readContract({ address: route.pairToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
        // F-53 (V12): this sell's proceeds (bal − before) plus any recorded engine leftovers, never the user's pre-held pair asset
        const owed = leftoverOwed(account.address, route.pairToken);
        let amount = (bal > beforePair ? bal - beforePair : 0n) + owed;
        if (amount > bal) amount = bal;
        if (amount <= 0n) return;
        await approveIfNeeded(route.pairToken, UNISWAP_V3_ROUTER, amount);
        const back = await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.reverse, recipient: account.address, amountIn: amount, amountOutMinimum: 0n }] });
        // signed with the simulated output as its floor (1 %, or the user's tighter slippage), never 0
        const h2 = await send({ ...back.request, args: [{ ...back.request.args[0], amountOutMinimum: bridgeMin(back.result as bigint) }] });
        const r2 = await landed(h2, 90_000).catch(() => null);
        if (r2?.status === 'success') { if (owed > 0n) leftoverClear(account.address, route.pairToken); await unwrap(acct.id, (back.result as bigint) - (back.result as bigint) / 50n).catch(() => {}); }
      }).catch(() => {});
    }
    return hash;
  }
  if (route.type === 'v4') {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    // V13 VA-1: pool and pair as the engine chose them (pickFor); the hint's own for a pool behind a known hook
    let pk = route.poolKey, pair = route.pair;
    const quoteV4 = (zeroForOne: boolean, exactAmount: bigint) => quoteV4Pool(pk, zeroForOne, exactAmount);
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      let quoted: bigint;
      if (hookless(route)) {
        const { choice, hintOuts } = await pickFor([amountIn], amountIn);
        if (choice.use === 'refuse') reject('no V4 pool of this coin quoted');
        if (choice.use === 'candidate') { pk = choice.key; pair = choice.pair as 'native' | 'weth'; quoted = choice.out; } else quoted = hintOuts.get(String(amountIn)) ?? 0n;
        if (quoted <= 0n) throw new Error('V4 quote returned zero');
        encoded = pair === 'native' ? encodeV4BuyNative(pk, token, amountIn, applySlippage(quoted)) : encodeV4BuyViaWeth(pk, token, WETH, amountIn, applySlippage(quoted));
      } else if (route.pair === 'native') { quoted = await quoteV4(pk.currency0.toLowerCase() === NATIVE_CURRENCY, amountIn); encoded = encodeV4BuyNative(pk, token, amountIn, applySlippage(quoted)); }
      else if (route.pair === 'weth') { quoted = await quoteV4(pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn); encoded = encodeV4BuyViaWeth(pk, token, WETH, amountIn, applySlippage(quoted)); }
      else {
        const quoteToken = (route.pair === 'usdg' ? USDG : route.quoteToken || v4PairCurrency(pk, token)) as `0x${string}`;
        const bridge = bridgeOf(route, quoteToken);
        if (!bridge) throw new Error(`No route from ETH to ${route.quoteSymbol || 'this pool\'s quote asset'}`);
        const bridged = (await bridgeQuote(quoteToken, bridge.path, amountIn)).result;
        quoted = await quoteV4(pk.currency0.toLowerCase() === quoteToken.toLowerCase(), bridged);
        encoded = encodeV4BuyViaPath(pk, token, quoteToken, bridge.path, amountIn, applySlippage(quoted));
      }
      if (quoted <= 0n) throw new Error('V4 quote returned zero');
    } else {
      // Router pulls the token through Permit2: ERC20 → Permit2, then Permit2 → Universal Router.
      // An unarmed wallet's approvals land while the quote and the bridge leg are
      // worked out (neither reads an allowance); the router call is estimated after.
      const approvals = v4Approvals(amountIn); approvals.catch(() => {});
      // V13 (G4): an armed wallet's sell is proved beside the quote (gas-token / WETH pools; a re-picked pool is proved after)
      if ((route.pair === 'native' || route.pair === 'weth') && !s.turbo) bscEstimate('sell', { address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [encodeV4Sell(route.poolKey, token, v4PairCurrency(route.poolKey, token), amountIn, 0n).commands, encodeV4Sell(route.poolKey, token, v4PairCurrency(route.poolKey, token), amountIn, 0n).inputs, deadline] });
      // Every wallet's sell quote of the click in one Multicall3 eth_call: the V4
      // quoter's answer does not depend on who asks (it unlocks the pool manager
      // and reverts with the amount), so N per-wallet quoter simulations — the
      // burst publicnode refuses — become one call with the same numbers. A
      // wallet whose entry failed asks alone, as before (same error text).
      const quoteV4Sell = async (zeroForOne: boolean, exactAmount: bigint) => {
        const all = multicallOk && shared.addresses.length > 1 ? await shared.once(`q:v4sell:${zeroForOne}`, async () => {
          const bals = await tradeBalances(shared, 'sell', token);
          const amounts = [...new Set(shared.addresses.map((a) => sellAmount(bals[lc(a)] ?? 0n)).filter((x) => x > 0n).map(String))].map(BigInt);
          const res = await heavy.multicall({ contracts: amounts.map((a) => ({ address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount: a, hookData: '0x' }] })) as any, allowFailure: true });
          return new Map(amounts.map((a, i) => [String(a), res[i]]));
        }).catch(() => null) : null;
        const hit = all?.get(String(exactAmount));
        if (hit?.status === 'success') return (hit.result as readonly [bigint, bigint])[0];
        return quoteV4(zeroForOne, exactAmount);
      };
      let quoted: bigint;
      if (hookless(route)) {
        const amounts = await sellAmounts(amountIn), ref = amounts[amounts.length - 1];
        const { choice, hintOuts } = await pickFor(amounts, ref);
        if (choice.use === 'refuse') reject('no V4 pool of this coin quoted');
        if (choice.use === 'candidate') { pk = choice.key; pair = choice.pair as 'native' | 'weth'; quoted = amountIn === ref ? choice.out : await quoteV4(lc(pk.currency0) === lc(token), amountIn); }
        else quoted = hintOuts.get(String(amountIn)) ?? 0n;
      } else quoted = await quoteV4Sell(pk.currency0.toLowerCase() === token.toLowerCase(), amountIn);
      quoted -= quoted / 100n;
      if (quoted <= 0n) throw new Error('V4 sell quote returned zero');
      const pairCurrency = v4PairCurrency(pk, token);
      if (pair === 'native' || pair === 'weth') { encoded = encodeV4Sell(pk, token, pairCurrency, amountIn, applySlippage(quoted)); }
      else {
        // the pool pays in USDG or a stock: walk it back to ETH in the same transaction
        const bridge = bridgeOf(route, pairCurrency);
        if (!bridge) throw new Error(`No route from ${route.quoteSymbol || 'this pool\'s quote asset'} back to ETH`);
        const minBridge = applySlippage(quoted);
        // The ETH leg's floor. It used to come from a simulation of the V3 walk back alone, from a wallet that
        // holds no USDG yet — that always reverted and the floor went out as 0. Now the whole router call
        // (V4 leg → V3 walk back → unwrap) runs as this wallet with a zero floor, which is what it really pays
        // in ETH, and the slippage setting sits under that. Its proof (the estimate) runs beside it, and the
        // gas does not depend on the floor, so the sell waits for no extra round trip.
        await approvals;   // the router pulls through both allowances: they are on chain before the call is proved
        const exec = (e: { commands: `0x${string}`; inputs: `0x${string}`[] }) => ({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, deadline] as const });
        const probe = exec(encodeV4SellViaPath(pk, token, pairCurrency, bridge.reverse, amountIn, minBridge, 0n, account.address));
        const [paid, proven] = await Promise.all([ethDeltaOf(hv, account.address, probe), sim(probe)]);
        const ethOut = paid ?? await ethForQuote(pairCurrency, bridge.path, minBridge);
        if (!(ethOut > 0n)) throw new Error(`Could not price the ${route.quoteSymbol || 'USDG'} → ETH leg — not sent without a floor`);
        const final = exec(encodeV4SellViaPath(pk, token, pairCurrency, bridge.reverse, amountIn, minBridge, applySlippage(ethOut), account.address));
        return send({ ...(proven.request as any), args: final.args });
      }
      await approvals;   // the router pulls through both allowances: they are on chain before the call is proved
    }
    const samePool = sameKey(pk, route.poolKey) && pair === route.pair;   // the early proofs were made on the hinted pool
    const req = await simEarly({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [encoded.commands, encoded.inputs, deadline], value: side === 'buy' ? amountIn : undefined }, !samePool ? null : side === 'buy' ? bscEstimate('buy', bscBuyProbe(amountIn)) : bscEarly.get('sell') ?? null);
    return send(req.request);
  }
  // ── BNB Chain venues ──
  // Receipts and eth_simulateV1 go to the other nodes first on BSC: publicnode
  // answers every eth_getTransactionReceipt with -32602 "Archive requests require
  // a personal token" and one eth_simulateV1 chain in five with "global signer not
  // initialized for mining mode"; bloXroute / 48 Club / dataseed served 25 of 25
  // (measured 2026-10-14). The user's own nodes keep their place in front.
  let bscCl: ReturnType<typeof createPublicClient> | null = null;
  const bscTail = () => {
    if (bscCl) return bscCl;
    const urls = readUrls(); const tail = [...urls.filter((u) => u !== BSC.rpc), ...urls.filter((u) => u === BSC.rpc)];
    return (bscCl = createPublicClient({ chain, transport: fallback(tail.map((u) => http(u, { timeout: RPC_TIMEOUT })), { rank: false, retryCount: 1, retryDelay: 200 }) }));
  };
  // A receipt on BSC is there within a block (0.45 s); viem's waitForTransactionReceipt
  // polls every 4 s on a chain without a block time. The waits left on these
  // paths (fallbacks and the background bridge back) ask for the receipt directly.
  const bscReceipt = async (hash: `0x${string}`, timeout = 60_000) => {
    const t0 = Date.now();
    for (let i = 0; ; i += 1) {
      const r = await bscTail().getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
      if (Date.now() - t0 > timeout) throw new Error('Transaction not confirmed in time');
      await new Promise((res) => setTimeout(res, i < 20 ? 200 : 1000));
    }
  };
  // A chain of calls from this wallet proven against the current state in ONE
  // round trip (eth_simulateV1): each call sees the state the one before left, so
  // a venue call that spends what the bridge leg buys, or a sell behind its
  // approval, is checked — and priced — before any of them is signed. null: the
  // node has no eth_simulateV1 (a user's own RPC); the caller takes the receipt path.
  const bscSimulateChain = async (calls: any[], labels: string[]): Promise<{ gas: bigint[]; data: `0x${string}`[] } | null> => {
    const t0 = performance.now();
    let res: any;
    try {
      res = await (bscTail() as any).request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: account.address, to: c.address, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }), value: '0x' + (c.value ?? 0n).toString(16) })) }] }, 'latest'] });
    } catch { return null; }
    shared.mark('gas', performance.now() - t0);
    const out = res?.[0]?.calls;
    if (!Array.isArray(out) || out.length !== calls.length) return null;
    const bad = out.findIndex((c: any) => c?.status !== '0x1');
    if (bad >= 0) throw new Error(`${labels[bad] || 'call'} would revert: ${String(out[bad]?.error?.message || 'execution reverted').slice(0, 160)}`);
    // gasUsed is after refunds and the 63/64 rule: a third on top plus 20k is the limit
    return { gas: out.map((c: any) => { const g = BigInt(c.gasUsed); return g + g / 3n + 20_000n; }), data: out.map((c: any) => c.returnData as `0x${string}`) };
  };
  // a proven chain goes out with consecutive nonces, each signed the moment the one before is accepted — no receipt in between
  const bscSendChain = async (calls: any[], gas: bigint[]): Promise<`0x${string}`> => { let h = '0x' as `0x${string}`; for (let i = 0; i < calls.length; i += 1) h = await send({ ...calls[i], gas: gas[i] }); return h; };
  // A venue call behind the approvals it needs. Armed (the usual case after a
  // buy): one transaction, priced by the early estimate. Not armed: approval(s)
  // and the call proven together and sent back to back.
  const bscSendAfter = async (approvals: any[], call: any, early: Promise<bigint | null> | null, label: string): Promise<`0x${string}`> => {
    if (!approvals.length) {
      const t0 = performance.now();
      const g = s.turbo || !early ? null : await early;
      if (g == null) return send((await sim(call)).request);   // no early proof (or it failed): the full check decodes why
      shared.mark('gas', performance.now() - t0);
      return send({ ...call, gas: g + g / 5n });
    }
    const calls = [...approvals, call];
    if (s.turbo) return bscSendChain(calls, []);
    const proven = await bscSimulateChain(calls, [...approvals.map(() => 'the approval'), label]);
    if (proven) return bscSendChain(calls, proven.gas);
    for (const a of approvals) { const h = await send((await sim(a)).request); if ((await bscReceipt(h)).status !== 'success') throw new Error('Approval reverted'); }
    return send((await sim(call)).request);
  };
  // gas token → quote asset on PancakeSwap V3 for a curve or pair that does not
  // take BNB (a USD1/USDT-quoted four.meme coin): the leg, the venue's approval
  // (first time) and the venue call — built on the leg's floor — are proven in
  // one eth_simulateV1 and go out with consecutive nonces. It used to be: send
  // the leg, wait for its receipt (4 s poll), read the balance, quote, estimate.
  const bridgeBuy = async (quote: `0x${string}`, r: Bridge, spender: `0x${string}`, venueAt: (funds: bigint) => Promise<any>, label: string): Promise<`0x${string}`> => {
    const bridge = bridgeOf(r, quote);
    if (!bridge) throw new Error(`No route from ${NATIVE} to ${r.quoteSymbol || 'this quote asset'}`);
    const q = (await bridgeQuote(quote, bridge.path, amountIn)).result as bigint;
    if (q <= 0n) throw new Error('Quote-asset swap quote returned zero');
    const floor = bridgeMin(q);
    // F-53 (V12): the leg delivers ~q but the venue consumes `floor`; the ~1% left in the wallet
    // as the quote asset is this engine's, recorded so the coin's next sell walks it back too.
    leftoverAdd(account.address, quote, q - floor);
    const leg = { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: floor }], value: amountIn };
    const [venue, allowance] = await Promise.all([venueAt(floor), bscAllowance(quote, spender)]);
    const approve = allowance <= MAX_UINT256 / 2n ? [bscApprove(quote, spender)] : [];
    const calls = [leg, ...approve, venue];
    if (s.turbo) return bscSendChain(calls, []);
    const proven = await bscSimulateChain(calls, [`the ${NATIVE} → ${r.quoteSymbol || 'quote asset'} swap`, ...approve.map(() => 'the approval'), label]);
    if (proven) return bscSendChain(calls, proven.gas);
    // no eth_simulateV1 on this node: leg and approval back to back, their receipts, then the venue call
    const lh = await send((await sim(leg)).request);
    const ah = approve.length ? await send((await sim(approve[0])).request) : null;
    if ((await bscReceipt(lh)).status !== 'success') throw new Error('Quote-asset swap reverted');
    if (ah && (await bscReceipt(ah)).status !== 'success') throw new Error('Approval reverted');
    return send((await sim(venue)).request);
  };
  // …and a sell's proceeds in the quote asset back to the gas token, behind the trade.
  // F-53 (V12): `before` is the quote-asset balance read BEFORE the sell; the walk-back
  // sweeps only this sell's proceeds (bal − before) plus this engine's recorded leftovers,
  // never the user's pre-held balance of the same asset.
  const bridgeBack = (quote: `0x${string}`, r: Bridge, hash: `0x${string}`, before: bigint) => {
    const bridge = bridgeOf(r, quote);
    if (!bridge) return;
    bscReceipt(hash, 90_000).then(async (rc) => {
      if (rc.status !== 'success') return;
      const [bal, allowance] = await Promise.all([
        publicClient.readContract({ address: quote, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        publicClient.readContract({ address: quote, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, UNISWAP_V3_ROUTER] }),
      ]);
      const owed = leftoverOwed(account.address, quote);
      let amount = (bal > before ? bal - before : 0n) + owed;
      if (amount > bal) amount = bal;   // never more than the wallet actually holds
      if (amount <= 0n) return;
      const backCall = { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.reverse, recipient: account.address, amountIn: amount, amountOutMinimum: 0n }] };
      let h2: `0x${string}`, got: bigint;
      // every walk back is signed with the simulated output as its floor (1 %, or the user's tighter slippage): a
      // zero floor on BSC is a free sandwich. Without a simulated output (turbo, no eth_simulateV1) there is no send.
      const floored = (got: bigint) => ({ ...backCall, args: [{ ...backCall.args[0], amountOutMinimum: bridgeMin(got) }] });
      if (allowance >= amount) {
        const back = await publicClient.simulateContract({ account, ...backCall } as any);
        got = back.result as bigint; h2 = await send({ ...back.request, args: floored(got).args });
      } else {
        // not armed: approve + swap proven together (the swap's output read from the same simulation), sent back to back
        const chain = [bscApprove(quote, UNISWAP_V3_ROUTER), backCall];
        const proven = s.turbo ? null : await bscSimulateChain(chain, ['the approval', 'the swap back']);
        if (proven) { got = BigInt(proven.data[1] || '0x0'); if (got <= 0n) return; h2 = await bscSendChain([chain[0], floored(got)], proven.gas); }
        else {
          const ah = await send((await sim(chain[0])).request);
          if ((await bscReceipt(ah)).status !== 'success') return;
          const back = await publicClient.simulateContract({ account, ...backCall } as any);
          got = back.result as bigint; h2 = await send({ ...back.request, args: floored(got).args });
        }
      }
      const r2 = await bscReceipt(h2, 90_000).catch(() => null);
      if (r2?.status === 'success') { if (owed > 0n) leftoverClear(account.address, quote); if (got > 0n) await unwrap(acct.id, got - got / 50n).catch(() => {}); }
    }).catch(() => {});
  };
  // The sell quotes of every wallet in the click in one Multicall3 call (each
  // wallet sells its own share of its own balance, so the amounts differ): one
  // request instead of N heavy singles in a burst. A wallet whose entry is
  // missing or failed asks on its own, where the error is reported.
  const bscSellQuote = <T,>(key: string, contract: (amount: bigint) => any): Promise<T | null> => shared.once(`bsc:sq:${key}`, async () => {
    const bal = await tradeBalances(shared, 'sell', token);
    const rows = shared.addresses.map((a) => ({ a: lc(a), amt: sellAmount(bal[lc(a)] ?? 0n) })).filter((x) => x.amt > 0n);
    if (rows.length < 2 || !multicallOk) return {} as Record<string, { amt: bigint; v: unknown }>;
    const res = await publicClient.multicall({ contracts: rows.map((x) => contract(x.amt)) as any, allowFailure: true });
    return Object.fromEntries(rows.map((x, i) => [x.a, { amt: x.amt, v: res[i]?.status === 'success' ? res[i].result : null }]));
  }).then((m) => { const hit = (m as Record<string, { amt: bigint; v: unknown }>)[lc(account.address)]; return hit && hit.amt === amountIn && hit.v != null ? hit.v as T : null; }).catch(() => null);
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
  // four.meme: the helper prices the exact call (msg.value / approval / funds)
  if (route.type === 'four') {
    const nativeQuote = route.quoteToken.toLowerCase() === ZERO;
    if (side === 'buy') {
      const buyAt = async (funds: bigint) => {
        const est = await quoteFour(route.helper, funds);
        const [, , estimatedAmount, , , amountMsgValue, , amountFunds] = est;
        if (estimatedAmount <= 0n) throw new Error('four.meme quote returned zero');
        return { address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'buyTokenAMAP', args: [token, amountFunds, applySlippage(estimatedAmount)], value: amountMsgValue };
      };
      let hash: `0x${string}`;
      if (nativeQuote) {
        const call = await buyAt(amountIn);
        // the early proof is for (funds, msg.value) = (amountIn, amountIn): what the helper answers for a BNB curve
        hash = await bscSendAfter([], call, call.args[1] === amountIn && call.value === amountIn ? bscEstimate('buy', bscBuyProbe(amountIn)) : null, 'the four.meme buy');
      } else hash = await bridgeBuy(route.quoteToken, route, route.manager, buyAt, 'the four.meme buy');
      bscArmBehindBuy();
      return hash;
    }
    // V13 VA-8: the sell carries a floor (TokenManager2's sellToken(origin, token, amount, minFunds)); the early gas proof
    // is the same call with a zero floor, as on every other BNB venue (the gas does not depend on it)
    const sellAt = (min: bigint) => ({ address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [0n, token, amountIn, min] });
    const early = bscEstimate('sell', sellAt(0n));
    const [sq, allowance, before] = await Promise.all([
      bscSellQuote<readonly [string, string, bigint, bigint]>('four', (amt) => ({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amt] }))
        .then((v) => v ?? publicClient.readContract({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amountIn] })),
      bscAllowance(token, route.manager),
      // F-53 (V12): quote-asset balance before the sell, so the walk-back sweeps only its proceeds
      nativeQuote ? Promise.resolve(0n) : publicClient.readContract({ address: route.quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    ]);
    const [, , funds, fee] = sq;
    if (funds <= 0n) throw new Error('four.meme sell quote returned zero');
    // the floor from what the helper says this sell pays after its fee, 1 % under it, the slippage under that
    const net = funds > fee ? funds - fee : funds;
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, route.manager)], sellAt(applySlippage(net - net / 100n)), early, 'the four.meme sell');
    if (!nativeQuote) bridgeBack(route.quoteToken, route, hash, before as bigint);
    return hash;
  }
  // Flap: one Portal call; address(0) is BNB, and the Portal itself swaps BNB
  // into a USD1-style quote when the quote has nativeToQuoteSwap enabled
  if (route.type === 'flap') {
    const nativeQuote = route.quoteToken.toLowerCase() === ZERO;
    const quoteVia = (input: `0x${string}`, output: `0x${string}`, amount: bigint) => quoteFlap(route.portal, input, output, amount);
    if (side === 'buy') {
      const direct = nativeQuote || route.nativeToQuote;
      const input = (direct ? ZERO : route.quoteToken) as `0x${string}`;
      const buyAt = async (amount: bigint) => {
        const q = await quoteVia(input, token, amount);
        if (q <= 0n) throw new Error('Flap quote returned zero');
        return { address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'swapExactInput', args: [{ inputToken: input, outputToken: token, inputAmount: amount, minOutputAmount: applySlippage(q), permitData: '0x' }], value: direct ? amount : 0n };
      };
      const hash = direct ? await bscSendAfter([], await buyAt(amountIn), bscEstimate('buy', bscBuyProbe(amountIn)), 'the Flap buy') : await bridgeBuy(route.quoteToken, route, route.portal, buyAt, 'the Flap buy');
      bscArmBehindBuy();
      return hash;
    }
    // straight to BNB when the Portal can; else to the quote asset and bridged back
    const sellAt = (out: `0x${string}`, min: bigint) => ({ address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'swapExactInput', args: [{ inputToken: token, outputToken: out, inputAmount: amountIn, minOutputAmount: min, permitData: '0x' }] });
    const early = bscEstimate('sell', sellAt(ZERO, 0n));
    let output = ZERO as `0x${string}`;
    let [q, allowance] = await Promise.all([
      bscSellQuote<bigint>('flap', (amt) => ({ address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'quoteExactInput', args: [{ inputToken: token, outputToken: ZERO, inputAmount: amt }] }))
        .then((v) => v ?? quoteVia(token, output, amountIn)).catch(() => 0n),
      bscAllowance(token, route.portal),
    ]);
    if (q <= 0n && !nativeQuote) { output = route.quoteToken; q = await quoteVia(token, output, amountIn); }
    if (q <= 0n) throw new Error('Flap sell quote returned zero');
    // F-53 (V12): quote-asset balance before a bridged sell, so the walk-back sweeps only its proceeds
    const before = output.toLowerCase() !== ZERO ? await pairBalanceOf(output) : 0n;   // V13 (G10): read with the balance sheet
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, route.portal)], sellAt(output, applySlippage(q - q / 100n)), output === ZERO ? early : null, 'the Flap sell');
    if (output.toLowerCase() !== ZERO) bridgeBack(output, route, hash, before);
    return hash;
  }
  // PancakeSwap V2 pair (fee-on-transfer safe: Flap tax tokens keep taxing after listing)
  if (route.type === 'v2') {
    const router = route.router, dl = deadline();
    const lastOf = (xs: readonly bigint[]) => xs[xs.length - 1];
    if (side === 'buy') {
      let hash: `0x${string}`;
      if (route.path.length) {
        const q = lastOf(await quoteV2(router, amountIn, route.path));
        if (q <= 0n) throw new Error('V2 quote returned zero');
        hash = await bscSendAfter([], { address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [applySlippage(q), route.path, account.address, dl], value: amountIn }, bscEstimate('buy', bscBuyProbe(amountIn)), 'the V2 buy');
      } else {
        // the quote asset has no V2 pair with WBNB: buy it on V3 first, then the pair
        const path = [route.quoteToken, token] as `0x${string}`[];
        hash = await bridgeBuy(route.quoteToken, route, router, async (got) => {
          const q = lastOf(await quoteV2Bridged(router, route.quoteToken, got));
          if (q <= 0n) throw new Error('V2 quote returned zero');
          return { address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', args: [got, applySlippage(q), path, account.address, dl] };
        }, 'the V2 buy');
      }
      bscArmBehindBuy();
      return hash;
    }
    // V13 VA-1: an unknown hop on a sell only behind the click's own vault dialog (tradeInner asks once per route)
    if (v2UnknownHops(route.path || [], BRIDGE_TOKENS, token).length && !((hopConfirmed.get(routeSig(route)) || 0) > Date.now())) reject('this V2 sell passes through an asset the vault does not know');
    const toNative = route.path.length > 0;
    const path = (toNative ? [...route.path].reverse() : [token, route.quoteToken]) as `0x${string}`[];
    const fn = toNative ? 'swapExactTokensForETHSupportingFeeOnTransferTokens' : 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
    const sellAt = (min: bigint) => ({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: fn, args: [amountIn, min, path, account.address, dl] });
    const early = bscEstimate('sell', sellAt(0n));
    const [amounts, allowance, before] = await Promise.all([
      bscSellQuote<readonly bigint[]>('v2', (amt) => ({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amt, path] }))
        .then((v) => v ?? publicClient.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] })),
      bscAllowance(token, router),
      // F-53 (V12): quote-asset balance before a bridged sell, so the walk-back sweeps only its proceeds
      toNative ? Promise.resolve(0n) : publicClient.readContract({ address: route.quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    ]);
    const q = lastOf(amounts);
    if (q <= 0n) throw new Error('V2 sell quote returned zero');
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, router)], sellAt(applySlippage(q - q / 100n)), early, 'the V2 sell');
    if (!toNative) bridgeBack(route.quoteToken, route, hash, before as bigint);
    return hash;
  }
  // PancakeSwap Infinity CL pool (genius.fun after graduation) through PancakeSwap's Universal Router
  // Standard: on the curve, the router (ETH in, ETH out; the curve pulls the coin on a sell); graduated, the Universal
  // Router over ETH → USDG → stock → coin, the coin pulled through Permit2 on a sell
  if (route.type === 'standard') {
    const dl = deadline();
    const exec = (e: { commands: `0x${string}`; inputs: `0x${string}`[] }, value?: bigint) => ({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, dl], value });
    if (side === 'buy') {
      const q = await quoteStdBuy(route, amountIn);
      if (q <= 0n) throw new Error('Standard quote returned zero');
      const call = route.stage === 'curve'
        ? { address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'buyExactIn', args: [route.curve, ZERO, amountIn, 0n, applySlippage(q), account.address, ZERO, NO_FEE], value: amountIn }
        : exec(encodeStandardSwap(ZERO, stdPath(route, 'buy'), amountIn, applySlippage(q)), amountIn);
      const hash = await bscSendAfter([], call, bscEstimate('buy', bscBuyProbe(amountIn)), 'the Standard buy');
      bscArmBehindBuy();
      return hash;
    }
    if (route.stage === 'curve') {
      const sellAt = (min: bigint) => ({ address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'sellExactIn', args: [route.curve, amountIn, ZERO, min, account.address, ZERO, NO_FEE] });
      bscEstimate('sell', sellAt(0n));   // V13 (speed, G8): the gas proof beside the payout simulation, not behind it
      const allowance = await bscAllowance(token, route.curve);
      const approvals = allowance >= amountIn ? [] : [bscApprove(token, route.curve)];
      // the payout, proven as this wallet: the sell alone when the curve may pull the coin, behind its approval otherwise
      let q = 0n;
      if (!approvals.length) q = (await publicClient.simulateContract({ account, ...sellAt(0n) } as any)).result as bigint;
      else { const proven = await bscSimulateChain([...approvals, sellAt(0n)], ['the approval', 'the Standard sell']); q = proven ? BigInt(proven.data[1].slice(0, 66)) : 0n; }
      if (q <= 0n) throw new Error('Standard sell quote returned zero');
      return bscSendAfter(approvals, sellAt(applySlippage(q - q / 100n)), approvals.length ? null : bscEstimate('sell', sellAt(0n)), 'the Standard sell');
    }
    const path = stdPath(route, 'sell'), P2 = CFG.permit2, UR = CFG.universalRouter;
    const early = bscEstimate('sell', exec(encodeStandardSwap(token, path, amountIn, 0n)));
    const [quoted, approvals] = await Promise.all([
      heavy.simulateContract({ account, address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_PATH_ABI, functionName: 'quoteExactInput', args: [{ exactCurrency: token, path, exactAmount: amountIn }] }).then((r) => (r.result as readonly [bigint, bigint])[0]),
      Promise.all([bscAllowance(token, P2), bscPermit2(token)]).then(([a, [p2Amount, p2Expiry]]) => [
        ...(a < amountIn ? [bscApprove(token, P2)] : []),
        ...(p2Amount < amountIn || BigInt(p2Expiry) <= BigInt(Math.floor(Date.now() / 1000)) ? [{ address: P2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, UR, MAX_UINT160, Number(MAX_UINT48)] }] : []),
      ]),
    ]);
    const q = quoted - quoted / 100n;
    if (q <= 0n) throw new Error('Standard sell quote returned zero');
    return bscSendAfter(approvals, exec(encodeStandardSwap(token, path, amountIn, applySlippage(q))), approvals.length ? null : early, 'the Standard sell');
  }
  if (route.type === 'inf') {
    // V13 VA-1: pool and pair as the engine chose them (pickFor), as on V4
    let pk = route.poolKey, pair = route.pair, picked = false;
    const UR = CFG.universalRouter, P2 = CFG.permit2, dl = deadline();
    const quoteInf = (zeroForOne: boolean, exactAmount: bigint) => quoteInfPool(pk, zeroForOne, exactAmount);
    const exec = (e: { commands: `0x${string}`; inputs: `0x${string}`[] }, value?: bigint) => ({ address: UR, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, dl], value });
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      let quoted: bigint;
      if (hookless(route)) {
        const { choice, hintOuts } = await pickFor([amountIn], amountIn);
        if (choice.use === 'refuse') reject('no Infinity pool of this coin quoted');
        if (choice.use === 'candidate') { pk = choice.key; pair = choice.pair as 'native' | 'weth'; quoted = choice.out; picked = true; } else quoted = hintOuts.get(String(amountIn)) ?? 0n;
        if (quoted <= 0n) throw new Error('Infinity quote returned zero');
        encoded = pair === 'native' ? encodeInfBuyNative(pk, token, amountIn, applySlippage(quoted)) : encodeInfBuyViaWrapped(pk, token, WETH, amountIn, applySlippage(quoted));
      } else if (route.pair === 'native') { quoted = await quoteInf(pk.currency0.toLowerCase() === ZERO, amountIn); encoded = encodeInfBuyNative(pk, token, amountIn, applySlippage(quoted)); }
      else if (route.pair === 'weth') { quoted = await quoteInf(pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn); encoded = encodeInfBuyViaWrapped(pk, token, WETH, amountIn, applySlippage(quoted)); }
      else {
        const bridge = bridgeOf(route, route.quoteToken);
        if (!bridge) throw new Error(`No route from ${NATIVE} to ${route.quoteSymbol || "this pool's quote asset"}`);
        const bridged = (await bridgeQuote(route.quoteToken, bridge.path, amountIn)).result;
        quoted = await quoteInf(pk.currency0.toLowerCase() === route.quoteToken.toLowerCase(), bridged);
        encoded = encodeInfBuyViaPath(pk, token, route.quoteToken, bridge.path, amountIn, applySlippage(quoted));
      }
      if (quoted <= 0n) throw new Error('Infinity quote returned zero');
      // the early gas proof was for the hinted pool: another pool is proved by its own estimate
      const hash = await bscSendAfter([], exec(encoded, amountIn), picked ? null : bscEstimate('buy', bscBuyProbe(amountIn)), 'the Infinity buy');
      bscArmBehindBuy();
      return hash;
    }
    // Router pulls the token through Permit2: ERC20 → Permit2, then Permit2 → Universal Router.
    // Both allowances, the quote and the early estimate go out together.
    const pairCurrency = infPairCurrency(pk, token);
    const zeroForOne = pk.currency0.toLowerCase() === token.toLowerCase();
    const direct = route.pair === 'native' || route.pair === 'weth';
    const bridge = direct ? null : bridgeOf(route, pairCurrency);
    if (!direct && !bridge) throw new Error(`No route from ${route.quoteSymbol || "this pool's quote asset"} back to ${NATIVE}`);
    const probe = direct ? encodeInfSell(pk, token, pairCurrency, amountIn, 0n) : encodeInfSellViaPath(pk, token, pairCurrency, bridge!.reverse, amountIn, 0n, 0n, account.address);
    const early = bscEstimate('sell', exec(probe));
    // V13 VA-1: a hookless pool's quote comes from the pool pick (the same multicall the click's quotes used to ride)
    const pickedQuote = async (): Promise<bigint> => {
      const amounts = await sellAmounts(amountIn), ref = amounts[amounts.length - 1];
      const { choice, hintOuts } = await pickFor(amounts, ref);
      if (choice.use === 'refuse') reject('no Infinity pool of this coin quoted');
      if (choice.use === 'candidate') { pk = choice.key; pair = choice.pair as 'native' | 'weth'; picked = true; return amountIn === ref ? choice.out : quoteInf(lc(pk.currency0) === lc(token), amountIn); }
      return hintOuts.get(String(amountIn)) ?? 0n;
    };
    let [quoted, approvals] = await Promise.all([
      hookless(route) ? pickedQuote() : bscSellQuote<readonly [bigint, bigint]>('inf', (amt) => ({ address: BSC.clQuoter, abi: CL_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount: amt, hookData: '0x' }] }))
        .then((v) => (v ? v[0] : quoteInf(zeroForOne, amountIn))),
      Promise.all([bscAllowance(token, P2), bscPermit2(token)]).then(([a, [p2Amount, p2Expiry]]) => [
        ...(a < amountIn ? [bscApprove(token, P2)] : []),
        ...(p2Amount < amountIn || BigInt(p2Expiry) <= BigInt(Math.floor(Date.now() / 1000)) ? [{ address: P2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, UR, MAX_UINT160, Number(MAX_UINT48)] }] : []),
      ]),
    ]);
    quoted -= quoted / 100n;
    if (quoted <= 0n) throw new Error('Infinity sell quote returned zero');
    if (direct) encoded = encodeInfSell(pk, token, infPairCurrency(pk, token), amountIn, applySlippage(quoted));
    else {
      const minBridge = applySlippage(quoted);
      // the BNB leg's floor: the V3 quoter on the walk back (a simulation from this wallet, which holds none of
      // the quote asset yet, always reverted and the floor went out as 0 — on a chain with sandwich bots)
      const out = await v3BackOut(pairCurrency, bridge!.reverse, bridge!.path, minBridge);
      if (!(out > 0n)) throw new Error(`Could not price the ${route.quoteSymbol || 'quote asset'} → ${NATIVE} leg — not sent without a floor`);
      encoded = encodeInfSellViaPath(pk, token, pairCurrency, bridge!.reverse, amountIn, minBridge, applySlippage(out), account.address);
    }
    return bscSendAfter(approvals, exec(encoded), picked ? null : early, 'the Infinity sell');
  }
  // F-57 (V12): a spoofed route can steer a V3 sell to a thin / manipulated fee tier so
  // the pool's own quote — and with it the minOut floor — is low. On BSC (PancakeSwap's
  // QuoterV2 needs no allowance) compare the token → quote hop across every standard tier
  // in one call; if another tier would pay materially more, the chosen tier is suspect.
  // Robinhood ships no V3 quoter, so this guard is BSC-only (see the report).
  const v3TierGuard = async (quoteAsset: `0x${string}`) => {
    if (side !== 'sell' || CFG.key !== 'bsc' || !multicallOk) return;
    const tiers = [...V3_TIERS];
    const res = await publicClient.multicall({ contracts: tiers.map((fee) => ({ address: BSC.v3Quoter, abi: V3_QUOTER_ABI, functionName: 'quoteExactInput', args: [encodeV3Path([token, quoteAsset], [fee]), amountIn] })) as any, allowFailure: true }).catch(() => null);
    // V13 VA-1: fail closed — a sell whose tiers could not be compared is not sent (it used to go out unchecked)
    if (!res) reject('the PancakeSwap V3 fee tiers could not be compared for this sell — try again');
    const out = (i: number) => (res![i]?.status === 'success' ? (res![i].result as readonly [bigint])[0] : 0n);
    const chosen = out(tiers.indexOf(Number(route.fee)));
    if (chosen <= 0n) return;   // the chosen tier did not quote here; the live swap's own quote + slippage floor govern
    let best = 0n; for (let i = 0; i < tiers.length; i += 1) if (tiers[i] !== Number(route.fee) && out(i) > best) best = out(i);
    if (best * 100n > chosen * 102n) reject('a PancakeSwap V3 pool at another fee tier pays materially more for this sell — the route tier looks manipulated');
  };
  // Uniswap V3 (Varo). A pool quoted in a tokenised stock is still reachable
  // from ETH: one exactInput hops ETH → quote → token (and back on a sell), so
  // it stays a single transaction.
  if (route.quoteToken.toLowerCase() !== WETH.toLowerCase()) {
    const bridge = bridgeOf(route, route.quoteToken);
    if (!bridge) throw new Error(`No route from ETH to ${route.quoteSymbol || 'this pool\'s quote asset'}`);
    const path = side === 'buy' ? encodeV3Path([...bridge.hops, token], [...bridge.fees, route.fee])
      : encodeV3Path([token, ...[...bridge.hops].reverse()], [route.fee, ...[...bridge.fees].reverse()]);
    const base = { path, recipient: account.address, amountIn, amountOutMinimum: 0n };
    // F-57 (V12): the wrapped gas token held BEFORE the sell — only what this sell delivers gets unwrapped (overlaps the quote).
    const beforeWethP = side === 'sell' ? publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) : Promise.resolve(0n);
    // V13 (speed): the tier comparison runs beside the quote, not behind it (one round trip fewer on a BSC V3 sell)
    const guard = v3TierGuard(route.quoteToken); guard.catch(() => {});
    const quoted = (await quoteV3Path(path, amountIn, side === 'buy')).result;
    if (quoted <= 0n) throw new Error('V3 quote returned zero');
    if (side === 'sell') { await guard; await approveIfNeeded(token, UNISWAP_V3_ROUTER, amountIn); }
    const beforeWeth = await beforeWethP;
    const bridged = await sim({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ ...base, amountOutMinimum: applySlippage(quoted) }], value: side === 'buy' ? amountIn : undefined });
    const hash = await send(bridged.request);
    // a sell lands in WETH: unwrap what the sell actually delivered (never `quoted`: a
    // fill under quote would make the withdraw revert, or unwrap pre-held WETH)
    if (side === 'sell') landed(hash, 90_000).then(async (r) => {
      if (r.status !== 'success') return;
      const afterWeth = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
      const got = afterWeth - beforeWeth;
      if (got > 0n) await unwrap(acct.id, got).catch(() => {});
    }).catch(() => {});
    return hash;
  }
  const tokenIn = side === 'buy' ? WETH : token, tokenOut = side === 'buy' ? token : route.quoteToken;
  const args = v3SingleArgs(tokenIn, tokenOut, route.fee, amountIn);
  // F-57 (V12): a WETH-quoted sell lands in the wrapped gas token; capture the pre-sell balance (overlaps the quote) so the delta is unwrapped.
  const beforeWethP = side === 'sell' ? publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) : Promise.resolve(0n);
  const guard = v3TierGuard(WETH); guard.catch(() => {});   // V13 (speed): beside the quote
  // V13 (G4): the call with a zero floor, proved beside the quote (a buy's proof started at t=0)
  const early = s.turbo ? null : side === 'buy' ? bscEstimate('buy', bscBuyProbe(amountIn)) : bscEstimate('sell', { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [args] });
  const q = await quoteV3Single(tokenIn, tokenOut, route.fee, amountIn, side === 'buy');
  if (side === 'sell') { await guard; await approveIfNeeded(token, UNISWAP_V3_ROUTER, amountIn); }
  const beforeWeth = await beforeWethP;
  const req = await simEarly({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [{ ...args, amountOutMinimum: applySlippage(q.result) }], value: side === 'buy' ? amountIn : undefined }, early);
  const hash = await send(req.request);
  // the sell's proceeds arrive as WETH: unwrap only what this sell delivered, behind the trade
  if (side === 'sell') landed(hash, 90_000).then(async (r) => {
    if (r.status !== 'success') return;
    const afterWeth = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    const got = afterWeth - beforeWeth;
    if (got > 0n) await unwrap(acct.id, got).catch(() => {});
  }).catch(() => {});
  return hash;
}
// ── preflight ──────────────────────────────────────────────────────────────
// The same route, the same quote, the same calldata as a real trade — but it
// ends in eth_call instead of a broadcast, with the wallet's ETH balance
// overridden so an empty wallet can still prove the path executes on chain
// right now. Nothing is signed, nothing is sent.
const PREVIEW_BALANCE = parseEther('10');
const overrideFor = (address: `0x${string}`) => [{ address, balance: PREVIEW_BALANCE }];
type Preview = {
  name: string; address: string; side: 'buy' | 'sell'; venue: string; contract: `0x${string}`; method: string;
  amountIn: number; amountInLabel: string; expected: number; min: number; pricePerToken: number;
  gas: number; gasPriceGwei: number; gasEth: number; balanceEth: number; funded: boolean;
  simulated: 'ok' | 'failed' | 'skipped'; error?: string; notes: string[];
};
async function previewOne(acct: Account, side: 'buy' | 'sell', token: `0x${string}`, size: number, route: Route, s: Settings): Promise<Preview> {
  if (CFG.key === 'elysium' || route.type === 'ely') return elyPreviewOne(acct, side, token, size, route, s);   // (trade-core.patch E8)
  const account = accountOf(acct);
  const stateOverride = overrideFor(account.address);
  const slippageBps = BigInt(Math.round(s.slippage * 100));
  const applySlippage = (q: bigint) => (q * (10_000n - slippageBps)) / 10_000n;
  const notes: string[] = [];
  const [gasPrice, balance] = await Promise.all([feeFor(s.gasBoost), publicClient.getBalance({ address: account.address }), verifyRoute(token, route)]);
  const out: Preview = {
    name: acct.name, address: account.address, side, venue: route.type, contract: ZERO, method: '',
    amountIn: 0, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0,
    gas: 0, gasPriceGwei: Number(gasPrice) / 1e9, gasEth: 0, balanceEth: Number(formatEther(balance)), funded: false,
    simulated: 'skipped', notes,
  };
  let amountIn: bigint;
  if (side === 'buy') {
    if (!(size > 0) || size > MAX_BUY_ETH) throw new Error('Amount out of range');
    amountIn = parseEther(String(size));
    out.amountIn = size; out.amountInLabel = `${size} ${NATIVE}`;
  } else {
    const bal = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    amountIn = (bal * BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100))) / 10_000n;
    if (route.type === 'four') amountIn -= amountIn % 1_000_000_000n;   // V13: four.meme takes whole multiples of 1e9 ("GW")
    out.amountIn = Number(formatUnits(amountIn, 18)); out.amountInLabel = `${size}% = ${out.amountIn.toFixed(4)} tokens`;
    if (amountIn <= 0n) { out.error = 'Nothing to sell in this wallet'; notes.push('fund the wallet with this token to preflight a sell'); return out; }
  }
  // one shared step: quote, then eth_call the real transaction with the balance override
  const run = async (call: any) => {
    out.contract = call.address; out.method = call.functionName;
    try {
      await publicClient.simulateContract({ account, ...call, gasPrice, stateOverride });
      out.simulated = 'ok';
      out.gas = Number(await publicClient.estimateContractGas({ account, ...call, gasPrice, stateOverride, prepare: false }).catch(() => 0n)) || 400_000;
    } catch (e) {
      out.simulated = 'failed'; out.error = shortError(e);
    }
    out.gasEth = (Number(gasPrice) / 1e18) * (out.gas || 400_000);
    out.funded = side === 'buy' ? Number(formatEther(balance)) >= out.amountIn + out.gasEth : Number(formatEther(balance)) >= out.gasEth;
    if (!out.funded) notes.push(side === 'buy' ? `needs ${(out.amountIn + out.gasEth).toFixed(5)} ${NATIVE} in the wallet` : `needs ${out.gasEth.toFixed(5)} ${NATIVE} for gas`);
    return out;
  };
  const quoted = (q: bigint, decimals = 18) => { out.expected = Number(formatUnits(q, decimals)); out.min = Number(formatUnits(applySlippage(q), decimals)); out.pricePerToken = out.expected > 0 ? out.amountIn / out.expected : 0; };

  if (route.type === 'pons') {
    out.venue = CFG.key === 'bsc' ? 'genius.fun curve' : 'Pons V2 curve';
    const [quoteReserve, tokenReserve] = await publicClient.readContract({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'getReserves' });
    const taxBps = BigInt(Math.max(0, route.feeBps + route.creatorTaxBps));
    const afterTax = (x: bigint) => (x * (10_000n - taxBps)) / 10_000n;
    const headroom = (x: bigint) => x - x / 100n;
    const nativePair = route.pairToken.toLowerCase() === ZERO;
    if (side === 'buy') {
      if (!nativePair) {
        // the curve itself only takes its pair asset, so this is two transactions:
        // simulate the swap that buys the pair asset, then price the curve leg
        const bridge = bridgeOf(route, route.pairToken);
        if (!bridge) { out.simulated = 'skipped'; out.error = `No route from ETH to ${route.quoteSymbol || "the curve's pair asset"}`; return out; }
        out.contract = route.curve; out.method = 'buy';
        try {
          const pairOut = (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: 0n }], value: amountIn, stateOverride })).result;
          const net = afterTax(pairOut);
          quoted((tokenReserve * net) / (quoteReserve + net));
          out.simulated = 'ok';
          out.gas = 400_000;
          notes.push(`two transactions: ETH → ${route.quoteSymbol || 'pair asset'} on V3 (simulated), then the curve buy`);
          notes.push(`curve fee ${(route.feeBps / 100).toFixed(2)}% + creator tax ${(route.creatorTaxBps / 100).toFixed(2)}%`);
        } catch (e) { out.simulated = 'failed'; out.error = shortError(e); }
        out.gasEth = (Number(gasPrice) / 1e18) * (out.gas || 400_000) * 2;
        out.funded = out.balanceEth >= out.amountIn + out.gasEth;
        if (!out.funded) notes.push(`needs ${(out.amountIn + out.gasEth).toFixed(5)} ETH in the wallet`);
        return out;
      }
      const net = afterTax(amountIn);
      const q = (tokenReserve * net) / (quoteReserve + net);
      quoted(q);
      notes.push(`curve fee ${(route.feeBps / 100).toFixed(2)}% + creator tax ${(route.creatorTaxBps / 100).toFixed(2)}%`);
      return run({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'buy', args: [amountIn, applySlippage(headroom(q)), account.address], value: amountIn });
    }
    const q = afterTax((quoteReserve * amountIn) / (tokenReserve + amountIn));
    quoted(q);
    const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, route.curve] });
    if (allowance < amountIn) { notes.push('an approve() transaction runs first'); out.simulated = 'skipped'; out.error = 'approval needed before the sell can be simulated'; out.gasEth = (Number(gasPrice) / 1e18) * 400_000; return out; }
    return run({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'sell', args: [amountIn, applySlippage(headroom(q)), account.address] });
  }
  if (route.type === 'v4') {
    out.venue = `Uniswap V4 · ${route.pair.toUpperCase()} pool`;
    const pk = route.poolKey;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const quoteV4 = async (zeroForOne: boolean, exactAmount: bigint) => {
      const r = await publicClient.simulateContract({ account, address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount, hookData: '0x' }], stateOverride });
      return (r.result as readonly [bigint, bigint])[0];
    };
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      if (route.pair === 'native') { const q = await quoteV4(pk.currency0.toLowerCase() === NATIVE_CURRENCY, amountIn); quoted(q); encoded = encodeV4BuyNative(pk, token, amountIn, applySlippage(q)); }
      else if (route.pair === 'weth') { const q = await quoteV4(pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn); quoted(q); encoded = encodeV4BuyViaWeth(pk, token, WETH, amountIn, applySlippage(q)); }
      else {
        const quoteToken = (route.pair === 'usdg' ? USDG : route.quoteToken || v4PairCurrency(pk, token)) as `0x${string}`;
        const bridge = bridgeOf(route, quoteToken);
        if (!bridge) { out.simulated = 'skipped'; out.error = `No route from ETH to ${route.quoteSymbol || 'the quote asset'}`; return out; }
        const bridged = (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: 0n }], value: amountIn, stateOverride })).result;
        const q = await quoteV4(pk.currency0.toLowerCase() === quoteToken.toLowerCase(), bridged);
        quoted(q);
        notes.push(`one transaction: ETH → ${route.quoteSymbol || 'quote'} on V3 → the V4 pool`);
        encoded = encodeV4BuyViaPath(pk, token, quoteToken, bridge.path, amountIn, applySlippage(q));
      }
    } else {
      const q = await quoteV4(pk.currency0.toLowerCase() === token.toLowerCase(), amountIn);
      quoted(q);
      const [p2Amount] = await publicClient.readContract({ address: PERMIT2 as `0x${string}`, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, UNIVERSAL_ROUTER as `0x${string}`] }) as unknown as [bigint, number, number];
      const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, PERMIT2 as `0x${string}`] });
      if (allowance < amountIn || p2Amount < amountIn) { notes.push('Permit2 arming transactions run first'); out.simulated = 'skipped'; out.error = 'Permit2 allowance not armed yet'; out.gasEth = (Number(gasPrice) / 1e18) * 400_000; return out; }
      const pairCurrency = v4PairCurrency(pk, token);
      if (route.pair === 'native' || route.pair === 'weth') encoded = encodeV4Sell(pk, token, pairCurrency, amountIn, applySlippage(q - q / 100n));
      else {
        // the same shape the sell sends: V4 into the quote asset, V3 back to WETH, unwrap — so the dry run catches what the trade would hit
        const bridge = bridgeOf(route, pairCurrency);
        if (!bridge) { out.simulated = 'skipped'; out.error = `No route from ${route.quoteSymbol || 'the quote asset'} back to ETH`; return out; }
        const minBridge = applySlippage(q - q / 100n);
        // the floor the sell signs: the whole call run as this wallet (ethDeltaOf), the slippage under it
        const probe = encodeV4SellViaPath(pk, token, pairCurrency, bridge.reverse, amountIn, minBridge, 0n, account.address);
        const ethOut = (await ethDeltaOf(publicClient, account.address, { address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [probe.commands, probe.inputs, deadline] }, PREVIEW_BALANCE)) ?? 0n;
        if (ethOut <= 0n) notes.push('the ETH leg could not be priced: the sell would refuse to go out without a floor');
        notes.push(`one transaction: token → ${route.quoteSymbol || 'quote'} on V4 → ETH on V3`);
        encoded = encodeV4SellViaPath(pk, token, pairCurrency, bridge.reverse, amountIn, minBridge, applySlippage(ethOut), account.address);
      }
    }
    return run({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [encoded.commands, encoded.inputs, deadline], value: side === 'buy' ? amountIn : undefined });
  }
  // ── BNB Chain venues: the same quote as the trade, then the real call under eth_call ──
  const bridgedIn = async (quote: `0x${string}`, r: Bridge) => {
    const bridge = bridgeOf(r, quote);
    if (!bridge) throw new Error(`No route from ${NATIVE} to ${r.quoteSymbol || 'the quote asset'}`);
    notes.push(`two transactions: ${NATIVE} → ${r.quoteSymbol || 'quote asset'} on PancakeSwap V3 (simulated), then the venue call`);
    return (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: 0n }], value: amountIn, stateOverride })).result;
  };
  const needsAllowance = async (spender: `0x${string}`) => {
    const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender] });
    if (allowance >= amountIn) return false;
    notes.push('an approve() transaction runs first'); out.simulated = 'skipped'; out.error = 'approval needed before the sell can be simulated'; out.gasEth = (Number(gasPrice) / 1e18) * 400_000;
    return true;
  };
  if (route.type === 'four') {
    out.venue = 'four.meme curve';
    const nativeQuote = route.quoteToken.toLowerCase() === ZERO;
    notes.push(`four.meme fee ${(route.feeBps / 100).toFixed(2)}%`);
    if (side === 'buy') {
      const funds = nativeQuote ? amountIn : await bridgedIn(route.quoteToken, route);
      const [, , estimatedAmount, , , amountMsgValue, , amountFunds] = await publicClient.readContract({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'tryBuy', args: [token, 0n, funds] });
      quoted(estimatedAmount);
      if (!nativeQuote) { out.contract = route.manager; out.method = 'buyTokenAMAP'; out.simulated = 'ok'; out.gas = 300_000; out.gasEth = (Number(gasPrice) / 1e18) * out.gas * 2; out.funded = out.balanceEth >= out.amountIn + out.gasEth; return out; }
      return run({ address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'buyTokenAMAP', args: [token, amountFunds, applySlippage(estimatedAmount)], value: amountMsgValue });
    }
    const [, , funds, fee] = await publicClient.readContract({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amountIn] });
    quoted(funds, route.quoteDecimals || 18);
    if (await needsAllowance(route.manager)) return out;
    const net = funds > fee ? funds - fee : funds;   // V13 VA-8: the preview runs the same floored call as the trade
    return run({ address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [0n, token, amountIn, applySlippage(net - net / 100n)] });
  }
  if (route.type === 'flap') {
    out.venue = 'Flap curve';
    const nativeQuote = route.quoteToken.toLowerCase() === ZERO;
    notes.push(`Flap fee 1% + tax ${(route.buyTaxBps / 100).toFixed(2)}% buy / ${(route.sellTaxBps / 100).toFixed(2)}% sell`);
    const quoteVia = async (input: `0x${string}`, output: `0x${string}`, amount: bigint) => (await publicClient.simulateContract({ account, address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'quoteExactInput', args: [{ inputToken: input, outputToken: output, inputAmount: amount }], stateOverride })).result as bigint;
    if (side === 'buy') {
      const direct = nativeQuote || route.nativeToQuote;
      const input = (direct ? ZERO : route.quoteToken) as `0x${string}`;
      const amount = direct ? amountIn : await bridgedIn(route.quoteToken, route);
      const q = await quoteVia(input, token, amount);
      quoted(q);
      if (!direct) { out.contract = route.portal; out.method = 'swapExactInput'; out.simulated = 'ok'; out.gas = 300_000; out.gasEth = (Number(gasPrice) / 1e18) * out.gas * 2; out.funded = out.balanceEth >= out.amountIn + out.gasEth; return out; }
      return run({ address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'swapExactInput', args: [{ inputToken: input, outputToken: token, inputAmount: amount, minOutputAmount: applySlippage(q), permitData: '0x' }], value: amount });
    }
    let output = ZERO as `0x${string}`;
    let q = 0n;
    try { q = await quoteVia(token, output, amountIn); } catch { q = 0n; }
    if (q <= 0n && !nativeQuote) { output = route.quoteToken; q = await quoteVia(token, output, amountIn); }
    quoted(q, output.toLowerCase() === ZERO ? 18 : route.quoteDecimals || 18);
    if (await needsAllowance(route.portal)) return out;
    return run({ address: route.portal, abi: FLAP_PORTAL_ABI, functionName: 'swapExactInput', args: [{ inputToken: token, outputToken: output, inputAmount: amountIn, minOutputAmount: applySlippage(q - q / 100n), permitData: '0x' }] });
  }
  if (route.type === 'standard') {
    out.venue = route.stage === 'curve' ? `Standard curve · ${route.quoteSymbol || 'stock'}` : `Standard pool · ${route.quoteSymbol || 'stock'} (V4)`;
    notes.push(route.stage === 'curve'
      ? `Standard fee ${(route.feeBps / 100).toFixed(2)}%${route.creatorTaxBps ? ` + creator tax ${(route.creatorTaxBps / 100).toFixed(2)}%` : ''}${route.snipeTaxBps ? ` + anti-snipe ${(route.snipeTaxBps / 100).toFixed(2)}% (decaying)` : ''}; ETH is swapped into ${route.quoteSymbol || 'the stock'} inside the router`
      : `one transaction: ETH → USDG → ${route.quoteSymbol || 'stock'} → token on Uniswap V4`);
    const dl = BigInt(Math.floor(Date.now() / 1000) + 300);
    const exec = (e: { commands: `0x${string}`; inputs: `0x${string}`[] }, value?: bigint) => ({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, dl], value });
    const path = route.poolKey ? standardPath(side, token, route.stock, route.poolKey, route.stockPool, route.ethPool, CFG.standard!.usdg) : [];
    const viaQuoter = async (currency: `0x${string}`, amount: bigint) => ((await publicClient.simulateContract({ address: V4_QUOTER as `0x${string}`, abi: V4_QUOTER_PATH_ABI, functionName: 'quoteExactInput', args: [{ exactCurrency: currency, path, exactAmount: amount }] })).result as readonly [bigint, bigint])[0];
    if (side === 'buy') {
      if (route.stage === 'curve') {
        const q = (await publicClient.simulateContract({ account, address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'buyExactIn', args: [route.curve, ZERO, amountIn, 0n, 0n, account.address, ZERO, NO_FEE], value: amountIn, stateOverride })).result as bigint;
        quoted(q);
        return run({ address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'buyExactIn', args: [route.curve, ZERO, amountIn, 0n, applySlippage(q), account.address, ZERO, NO_FEE], value: amountIn });
      }
      const q = await viaQuoter(ZERO, amountIn); quoted(q);
      return run(exec(encodeStandardSwap(ZERO, path, amountIn, applySlippage(q)), amountIn));
    }
    if (route.stage === 'curve') {
      if (await needsAllowance(route.curve)) return out;
      const q = (await publicClient.simulateContract({ account, address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'sellExactIn', args: [route.curve, amountIn, ZERO, 0n, account.address, ZERO, NO_FEE] })).result as bigint;
      quoted(q);
      return run({ address: route.router, abi: STANDARD_ROUTER_ABI, functionName: 'sellExactIn', args: [route.curve, amountIn, ZERO, applySlippage(q - q / 100n), account.address, ZERO, NO_FEE] });
    }
    const q = await viaQuoter(token, amountIn); quoted(q);
    const [p2Amount] = await publicClient.readContract({ address: PERMIT2 as `0x${string}`, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, UNIVERSAL_ROUTER as `0x${string}`] }) as unknown as [bigint, number, number];
    const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, PERMIT2 as `0x${string}`] });
    if (allowance < amountIn || p2Amount < amountIn) { notes.push('Permit2 arming transactions run first'); out.simulated = 'skipped'; out.error = 'Permit2 allowance not armed yet'; out.gasEth = (Number(gasPrice) / 1e18) * 400_000; return out; }
    return run(exec(encodeStandardSwap(token, path, amountIn, applySlippage(q - q / 100n))));
  }
  if (route.type === 'v2') {
    out.venue = 'PancakeSwap V2 pair';
    const router = route.router, dl = BigInt(Math.floor(Date.now() / 1000) + 300);
    const lastOf = (xs: readonly bigint[]) => xs[xs.length - 1];
    if (side === 'buy') {
      if (!route.path.length) {
        const got = await bridgedIn(route.quoteToken, route);
        const q = lastOf(await publicClient.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [got, [route.quoteToken, token]] }));
        quoted(q); out.contract = router; out.method = 'swapExactTokensForTokensSupportingFeeOnTransferTokens'; out.simulated = 'ok'; out.gas = 250_000; out.gasEth = (Number(gasPrice) / 1e18) * out.gas * 2; out.funded = out.balanceEth >= out.amountIn + out.gasEth; return out;
      }
      const q = lastOf(await publicClient.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, route.path] }));
      quoted(q);
      if (route.path.length > 2) notes.push(`one transaction: ${NATIVE} → ${route.quoteSymbol || 'quote'} → token, two V2 pairs`);
      return run({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [applySlippage(q), route.path, account.address, dl], value: amountIn });
    }
    const path = (route.path.length ? [...route.path].reverse() : [token, route.quoteToken]) as `0x${string}`[];
    const q = lastOf(await publicClient.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] }));
    quoted(q, route.path.length ? 18 : 18);
    if (await needsAllowance(router)) return out;
    return run({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: route.path.length ? 'swapExactTokensForETHSupportingFeeOnTransferTokens' : 'swapExactTokensForTokensSupportingFeeOnTransferTokens', args: [amountIn, applySlippage(q - q / 100n), path, account.address, dl] });
  }
  if (route.type === 'inf') {
    out.venue = `PancakeSwap Infinity · ${route.pair === 'other' ? (route.quoteSymbol || 'quote') : NATIVE} pool`;
    const pk = route.poolKey, UR = CFG.universalRouter, P2 = CFG.permit2, dl = BigInt(Math.floor(Date.now() / 1000) + 300);
    const quoteInf = async (zeroForOne: boolean, exactAmount: bigint) => ((await publicClient.simulateContract({ account, address: BSC.clQuoter, abi: CL_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount, hookData: '0x' }], stateOverride })).result as readonly [bigint, bigint])[0];
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      if (route.pair === 'native') { const q = await quoteInf(pk.currency0.toLowerCase() === ZERO, amountIn); quoted(q); encoded = encodeInfBuyNative(pk, token, amountIn, applySlippage(q)); }
      else if (route.pair === 'weth') { const q = await quoteInf(pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn); quoted(q); encoded = encodeInfBuyViaWrapped(pk, token, WETH, amountIn, applySlippage(q)); }
      else {
        const bridge = bridgeOf(route, route.quoteToken);
        if (!bridge) { out.simulated = 'skipped'; out.error = `No route from ${NATIVE} to ${route.quoteSymbol || 'the quote asset'}`; return out; }
        const bridged = (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.path, recipient: account.address, amountIn, amountOutMinimum: 0n }], value: amountIn, stateOverride })).result;
        const q = await quoteInf(pk.currency0.toLowerCase() === route.quoteToken.toLowerCase(), bridged);
        quoted(q);
        notes.push(`one transaction: ${NATIVE} → ${route.quoteSymbol || 'quote'} on V3 → the Infinity pool`);
        encoded = encodeInfBuyViaPath(pk, token, route.quoteToken, bridge.path, amountIn, applySlippage(q));
      }
    } else {
      const q = await quoteInf(pk.currency0.toLowerCase() === token.toLowerCase(), amountIn);
      quoted(q);
      const [p2Amount] = await publicClient.readContract({ address: P2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, UR] }) as unknown as [bigint, number, number];
      const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, P2] });
      if (allowance < amountIn || p2Amount < amountIn) { notes.push('Permit2 arming transactions run first'); out.simulated = 'skipped'; out.error = 'Permit2 allowance not armed yet'; out.gasEth = (Number(gasPrice) / 1e18) * 400_000; return out; }
      encoded = encodeInfSell(pk, token, infPairCurrency(pk, token), amountIn, applySlippage(q - q / 100n));
    }
    return run({ address: UR, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [encoded.commands, encoded.inputs, dl], value: side === 'buy' ? amountIn : undefined });
  }
  out.venue = route.quoteToken.toLowerCase() === WETH.toLowerCase() ? (CFG.key === 'bsc' ? 'PancakeSwap V3 pool' : 'Uniswap V3 pool') : `${CFG.key === 'bsc' ? 'PancakeSwap' : 'Uniswap'} V3 · ${route.quoteSymbol || 'stock'}-quoted (bridged)`;
  if (route.quoteToken.toLowerCase() !== WETH.toLowerCase()) {
    const bridge = bridgeOf(route, route.quoteToken);
    if (!bridge) { out.simulated = 'skipped'; out.error = `No route from ETH to ${route.quoteSymbol || 'the quote asset'}`; return out; }
    const path = side === 'buy' ? encodeV3Path([...bridge.hops, token], [...bridge.fees, route.fee])
      : encodeV3Path([token, ...[...bridge.hops].reverse()], [route.fee, ...[...bridge.fees].reverse()]);
    const base = { path, recipient: account.address, amountIn, amountOutMinimum: 0n };
    const q3 = (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [base], value: side === 'buy' ? amountIn : undefined, stateOverride })).result;
    quoted(q3);
    notes.push(`one transaction: ${bridge.hops.map((h) => (h.toLowerCase() === WETH.toLowerCase() ? 'ETH' : h.toLowerCase() === USDG.toLowerCase() ? 'USDG' : route.quoteSymbol || 'quote')).join(' → ')} → token, ${bridge.fees.length + 1} V3 pools`);
    if (side === 'sell') {
      const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, UNISWAP_V3_ROUTER] });
      if (allowance < amountIn) { notes.push('an approve() transaction runs first'); out.simulated = 'skipped'; out.error = 'approval needed before the sell can be simulated'; return out; }
    }
    return run({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ ...base, amountOutMinimum: applySlippage(q3) }], value: side === 'buy' ? amountIn : undefined });
  }
  const tokenIn = side === 'buy' ? WETH : token, tokenOut = side === 'buy' ? token : route.quoteToken;
  const args = { tokenIn, tokenOut, fee: route.fee, recipient: account.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  const q = (await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [args], value: side === 'buy' ? amountIn : undefined, stateOverride })).result;
  quoted(q);
  if (side === 'sell') {
    const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, UNISWAP_V3_ROUTER] });
    if (allowance < amountIn) { notes.push('an approve() transaction runs first'); out.simulated = 'skipped'; out.error = 'approval needed before the sell can be simulated'; return out; }
  }
  return run({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [{ ...args, amountOutMinimum: applySlippage(q) }], value: side === 'buy' ? amountIn : undefined });
}
async function preview(side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown) {
  const list = requireUnlocked();
  if (SOL_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = tradeSettings(); const t0 = performance.now();
    const route = await solRoute(token, hint);
    const previews = await Promise.all(targets.map((a) => solPreviewOne(a, side, route, size, s)));
    return { ok: true, ms: Math.round(performance.now() - t0), route: 'sol-' + route.venue, slippage: s.slippage, previews };
  }
  if (NEAR_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = tradeSettings(); const t0 = performance.now();
    const route = await nearRoute(token, hint);
    const previews = await Promise.all(targets.map((a) => nearPreviewOne(a, side, route, size, s.slippage).catch((e) => ({ name: a.name, address: nearAccountId(a) || a.address, side, venue: 'Rhea DCL', contract: ZERO, method: '', amountIn: size, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0, gas: 0, gasPriceGwei: 0, gasEth: 0, balanceEth: 0, funded: false, error: shortError(e) })))) as unknown as Preview[];
    return { ok: true, ms: Math.round(performance.now() - t0), route: 'near-dcl', slippage: s.slippage, previews };
  }
  const addr = token.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('Invalid token address');
  const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
  const targets = list.filter((a) => ids.includes(a.id));
  if (!targets.length) throw new Error('No wallet selected');
  const s = tradeSettings();
  const t0 = performance.now();
  const route = await routeFor(addr, hint);
  const previews = await Promise.all(targets.map(async (a) => {
    try { return await previewOne(a, side, addr, size, route, s); }
    catch (e) { return { name: a.name, address: a.address, side, venue: route.type, contract: ZERO, method: '', amountIn: size, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0, gas: 0, gasPriceGwei: 0, gasEth: 0, balanceEth: 0, funded: false, simulated: 'failed', error: shortError(e), notes: [] } as Preview; }
  }));
  return { ok: true, ms: Math.round(performance.now() - t0), route: route.type, slippage: s.slippage, previews };
}
// F-53 (V12): the engine's own bridged-buy leftovers — the quote asset a bridge leg
// delivered above what the venue consumed — are tracked per wallet+quote so that a later
// sell's walk-back sweeps ONLY this engine's funds (that sell's proceeds plus these
// recorded leftovers), never the user's unrelated holdings of the same asset.
const LEFTOVER_KEY = 'trenches.engine.leftovers';
const leftKey = (wallet: string, quote: string) => `${lc(wallet)}:${lc(quote)}`;
const loadLeftovers = (): Record<string, string> => { try { const v = JSON.parse(localStorage.getItem(LEFTOVER_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const bigOr0 = (v: unknown): bigint => { try { return BigInt(String(v || '0')); } catch { return 0n; } };
const leftoverOwed = (wallet: string, quote: string): bigint => bigOr0(loadLeftovers()[leftKey(wallet, quote)]);
const leftoverAdd = (wallet: string, quote: string, amount: bigint) => { if (amount <= 0n) return; try { const m = loadLeftovers(); const k = leftKey(wallet, quote); m[k] = String(bigOr0(m[k]) + amount); localStorage.setItem(LEFTOVER_KEY, JSON.stringify(m)); } catch {} };
const leftoverClear = (wallet: string, quote: string) => { try { const m = loadLeftovers(); delete m[leftKey(wallet, quote)]; localStorage.setItem(LEFTOVER_KEY, JSON.stringify(m)); } catch {} };
// receipt for a hash the engine broadcast: "sent" is not "landed"
async function receipt(hash: string) {
  if (SOL_MODE) return solReceipt(hash);
  if (NEAR_MODE) return nearReceipt(hash);
  const w = receipts.get(lc(hash));
  if (w?.r) return { ok: true, pending: false, state: w.r.status === 'success' ? 'confirmed' : 'reverted', ...w.r };
  if (w) return { ok: true, pending: true, state: 'pending' };   // the watcher is on it: no second poll of the node
  const r = await receiptClient().getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
  if (!r) return { ok: true, pending: true, state: 'pending' };
  return { ok: true, pending: false, state: r.status === 'success' ? 'confirmed' : 'reverted', status: r.status, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), feeEth: Number(formatEther(r.gasUsed * r.effectiveGasPrice)) };
}
let tradesInFlight = 0;   // a page must not navigate away while a trade is being signed and broadcast here
// ── trade ceilings, decided here ──
// Any script on the page can call buy(): without a ceiling it could buy 100 ETH per wallet at 100 % slippage into its
// own pool. Two limits the frame keeps on its own storage, written only behind a trusted click in its dialogs:
// a buy above the per-wallet cap asks once (that buy), and a slippage setting above 15 % (V13; 22 % before) asks once (then it is
// remembered up to that value). Inside them nothing is asked — normal trading pays no extra step.
const LIMITS_KEY = 'trenches.engine.limits';
const CAP_DEFAULT: Record<string, number> = { robinhood: 1, bsc: 5, sol: 25, near: 1000 };
const laneKey = () => (SOL_MODE ? 'sol' : NEAR_MODE ? 'near' : CFG.key);
const laneUnit = () => (SOL_MODE ? 'SOL' : NEAR_MODE ? 'NEAR' : NATIVE);
type Limits = { cap?: Record<string, number>; slipOk?: number; buys?: Record<string, [number, number][]>; hourOk?: Record<string, { upTo: number; at: number }> };
const loadLimits = (): Limits => { try { const v = JSON.parse(localStorage.getItem(LIMITS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const saveLimits = (l: Limits) => { try { localStorage.setItem(LIMITS_KEY, JSON.stringify(l)); } catch {} };
const buyCap = () => { const v = Number(loadLimits().cap?.[laneKey()]); return v > 0 ? v : CAP_DEFAULT[laneKey()] ?? 1; };
// F-70 (V12): a rolling one-hour ledger of what every buy has spent on this lane (per-wallet size × wallet count),
// so a cluster of individually-under-cap buys from a hostile page cannot drain a wallet set without ever asking.
// Recorded BEFORE the trade goes out; re-read right before the write and the new entry APPENDED (old entries are
// merged, never dropped by a racing tab) and only pruned by age. Returns the last-hour total including this buy.
const walletCount = (ids?: string[]) => (ids?.length ? ids.length : meta.selectedAccountIds.length ? meta.selectedAccountIds.length : meta.activeAccountId ? 1 : 1);
// V13 VA-2: entries clamped to ≥ 0 and pruned by age only; past 500 the oldest fold into one entry that keeps their
// sum (v13Guards.ledgerAdd) — a negative or zero-sized call can no longer lower or flush the hour's total.
const recordBuy = (total: number): number => {
  try {
    const l = loadLimits(); const lane = laneKey();
    const all = l.buys && typeof l.buys === 'object' ? l.buys : {};
    const { entries, sum } = ledgerAdd(all[lane], Date.now(), total);
    saveLimits({ ...l, buys: { ...all, [lane]: entries } });
    return sum;
  } catch { return total; }
};
async function tradeLimits(side: 'buy' | 'sell', size: number, s: Settings, wallets = 1) {
  const slip = Number(s.slippage) || 0;
  // V13 VA-1: the level a page reaches without a click is SLIP_SILENT (15 %), not 22 %; a stored value above it (set
  // before this release, or above what the user confirmed) asks once here
  if (slipNeedsClick(slip, loadLimits().slipOk)) {
    const ok = await ask({ title: 'High slippage', danger: true, ok: `Trade at ${slip}%`, html: `${sub(`Slippage is set to ${escHtml(slip)}%: a trade may fill up to ${escHtml(slip)}% worse than quoted.`)}${muted('Confirm once. Trades at this setting or lower won\'t ask again.')}` });
    if (!ok) throw new Error(`Cancelled: slippage above ${SLIP_SILENT}% needs one confirmation in the vault`);
    saveLimits({ ...loadLimits(), slipOk: slip });
  }
  if (side === 'buy') {
    const total = size * Math.max(1, wallets);
    if (size > buyCap()) {
      const ok = await ask({ title: 'Large buy', danger: true, ok: `Buy ${size} ${laneUnit()}`, html: `${sub(`${escHtml(size)} ${laneUnit()} per wallet is above your cap of ${escHtml(buyCap())} ${laneUnit()}.`)}${muted('The cap is in Settings.')}` });
      if (!ok) throw new Error(`Cancelled: ${size} ${laneUnit()} is above the per-wallet cap`);
      recordBuy(total);
    } else {
      // under the per-wallet cap: no per-click ask, but the hour's running total is watched — above ~5× the cap, ask once
      // (fix1 trade-speed-07, 2026-11-01) "Confirm once" now holds: the confirmation is kept (hourOk) for another 5× the cap of
      // buys within the hour, then asks again — it used to open the dialog in front of EVERY later buy of the rolling hour. A
      // cancelled ask records nothing (the total is worked out first, written only for a buy that goes on). F-70 holds: every
      // buy that proceeds is in the ledger before it goes out, never written over another tab's entries (one read → add → write).
      const lane = laneKey(), l = loadLimits(), all = l.buys && typeof l.buys === 'object' ? l.buys : {};
      const { entries, sum: ahead } = ledgerAdd(all[lane], Date.now(), total);
      const kept = l.hourOk && typeof l.hourOk === 'object' ? l.hourOk[lane] : undefined;
      const covered = !!kept && Date.now() - Number(kept.at) < BUY_WINDOW_MS && ahead <= Number(kept.upTo);
      // no ask: written from this same read (recordBuy's own read → add → write, nothing awaited in between)
      if (!(ahead > buyCap() * 5) || covered) saveLimits({ ...l, buys: { ...all, [lane]: entries } });
      else {
        const ok = await ask({ title: 'Large hourly buy total', danger: true, ok: 'Continue', html: `${sub(`Buys in the last hour total ${escHtml(Number(ahead.toFixed(6)))} ${laneUnit()} across your wallets — above 5× your cap of ${escHtml(buyCap())} ${laneUnit()}.`)}${muted('Confirm once. The cap is in Settings.')}` });
        if (!ok) throw new Error(`Cancelled: the last hour's buys total above 5× the per-wallet cap`);
        const cur = loadLimits();
        saveLimits({ ...cur, hourOk: { ...(cur.hourOk && typeof cur.hourOk === 'object' ? cur.hourOk : {}), [lane]: { upTo: ahead + buyCap() * 5, at: Date.now() } } });
        recordBuy(total);   // after the dialog: appended to a fresh read, never over what another tab wrote meanwhile
      }
    }
  }
}
// F-43/F-22 (V12): one trade per wallet+token+side is in flight at a time, held ACROSS TABS by a Web Lock
// (ifAvailable — a contending press is turned away, never queued) and kept until the receipt lands or 120 s,
// whichever first — NOT released the instant the broadcast returns. Before, the key was freed on 'submitted', so a
// second press (or another tab) in the window between broadcast and receipt signed and spent the wallet again.
const inFlightTimers = new Map<string, ReturnType<typeof setTimeout>>();
const releaseInFlight = (key: string) => { inFlight.delete(key); const t = inFlightTimers.get(key); if (t) { clearTimeout(t); inFlightTimers.delete(key); } };
async function tradeGuard<T>(key: string, busy: () => T, fn: () => Promise<{ ret: T; landed?: Promise<unknown> | null }>): Promise<T> {
  if (inFlight.has(key)) return busy();
  const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lk?.request) {
    // V13 (speed, G3): the answer — and with it the click's pool slot and the page's "submitted" — goes out the moment
    // the transaction is submitted; the lock on this wallet+token+side is still held until the receipt (or 120 s), as
    // F-43 requires. It used to answer only after the receipt: a multi-wallet click started its second wave a whole
    // confirmation later (Solana ~1.4–2.1 s per wave, BNB 0.5–1.5 s) and every click's answer carried the "Chain" time.
    return new Promise<T>((resolve, reject) => {
      lk.request('trench-trade-' + key, { ifAvailable: true }, async (lock) => {
        if (!lock || inFlight.has(key)) { resolve(busy()); return; }
        inFlight.add(key);
        try { const { ret, landed } = await fn(); resolve(ret); await Promise.race([Promise.resolve(landed ?? undefined).catch(() => {}), new Promise((r) => setTimeout(r, 120_000))]); }
        catch (e) { reject(e); }
        finally { releaseInFlight(key); }
      }).catch(reject);
    });
  }
  inFlight.add(key);
  try { const { ret, landed } = await fn(); inFlightTimers.set(key, setTimeout(() => releaseInFlight(key), 120_000)); Promise.resolve(landed ?? undefined).then(() => releaseInFlight(key), () => releaseInFlight(key)); return ret; }
  catch (e) { releaseInFlight(key); throw e; }
}
async function trade(side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown, opts?: unknown) {
  assertLegacyTerminalAllowed(laneKey(), 'trade');
  tradesInFlight += 1; post({ t: 'busy', v: true });
  try {
    // V13 VA-2: the size is checked before anything is recorded or asked (`buy(t, -1e300)` zeroed the hourly ledger)
    const n = typeof size === 'string' ? Number(size) : size;   // a numeric string from an older caller counts as its number
    const bad = tradeSizeProblem(side, n, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);
    await tradeLimits(side, n, tradeSettings(opts), walletCount(accountIds)); return await tradeInner(side, token, n, accountIds, hint, opts);
  } finally { tradesInFlight -= 1; post({ t: 'busy', v: tradesInFlight > 0 }); }
}
async function tradeInner(side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown, opts?: unknown) {
  keepHot();
  const list = requireUnlocked();
  if (SOL_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = tradeSettings(opts); const t0 = performance.now();
    // the same per-wallet states, double-press guard and outcome as the EVM path ('trench:tx' events, keyed by the
    // wallet's Solana address); a send no node acknowledged is 'unknown' with its signature, followed, never re-sent
    const id = clickId(opts); const solOf = (a: Account) => solAddressOf(a) || a.address;
    for (const a of targets) txEvent({ id, address: solOf(a), state: 'preparing' });
    let route: Awaited<ReturnType<typeof solRoute>>;
    try { route = await solRoute(token, hint); }
    catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: solOf(a), state: 'not_started', error }); throw e; }
    // V13 (speed, G14): the first status read at 400 ms and every 400 ms for 10 s (a slot is ~400 ms; it was 700), then
    // every 1.5 s — the same ~2 min in all
    const follow = (hash: string, address: string) => (async () => { for (let i = 0; i < 98; i++) { await new Promise((ok) => setTimeout(ok, i < 25 ? 400 : 1500)); const r = await solReceipt(hash).catch(() => null); if (r && !r.pending) { txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash, ...(r.error ? { error: r.error } : {}) }); return; } } })();
    const results: Result[] = await pooled(targets, poolSize('sol'), async (a) => {
      const address = solOf(a); const key = `${side}:${token}:${address}`;
      const busy = (): Result => { const error = `A ${side} of this token from this wallet is still being sent`; txEvent({ id, address, state: 'not_started', error }); return { name: a.name, address, ok: false, error, state: 'not_started' as TxState }; };
      return tradeGuard<Result>(key, busy, async () => {
        try { const { hash } = await solTradeOne(a, side, route, size, s); txEvent({ id, address, state: 'submitted', hash }); return { ret: { name: a.name, address, ok: true, hash, state: 'submitted' as TxState }, landed: follow(hash, address) }; }
        catch (e) {
          const error = shortError(e); const unknown = e instanceof SolSendUnknown && e.hash ? e.hash : '';
          const state: TxState = unknown ? 'unknown' : 'not_started';
          txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) });
          return { ret: { name: a.name, address, ok: false, error, state, ...(unknown ? { hash: unknown } : {}) }, landed: unknown ? follow(unknown, address) : null };
        }
      });
    });
    scheduleWatch(1500);
    const sent = results.filter((x) => x.ok).length;
    return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'sol-' + route.venue, timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
  }
  if (NEAR_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = tradeSettings(opts); const t0 = performance.now();
    // (native-scenarios 2026-11-04) the same per-wallet states as the EVM and Solana lanes ('trench:tx' { id, address, state }).
    // Without them nothing followed a NEAR order: the app's trade card sat on "Submitted" and the website's card under a
    // "Preparing" strip, although the swap had settled seconds later. Events only — what is signed and sent is unchanged.
    const id = clickId(opts); const nearOf = (a: Account) => nearAccountId(a) || a.address;
    for (const a of targets) txEvent({ id, address: nearOf(a), state: 'preparing' });
    let route: Awaited<ReturnType<typeof nearRoute>>;
    try { route = await nearRoute(token, hint); }
    catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: nearOf(a), state: 'not_started', error }); throw e; }
    // the chain's verdict as an event. nearReceipt answers from the watcher nearTradeOne started (no RPC call while it runs),
    // so it is asked every 400 ms for the first 8 s (a Rhea swap settles in ~2–6 s), then every 1.5 s — 120.5 s in all (it was 80 × 1.5 s = 120 s: the double-press hold is never shorter)
    const nearFollow = (hash: string, address: string) => (async () => { for (let i = 0; i < 95; i++) { await new Promise((r) => setTimeout(r, i < 20 ? 400 : 1500)); const r = (await nearReceipt(hash).catch(() => null)) as { pending?: boolean; status?: string; error?: string } | null; if (r && !r.pending) { txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash, ...(r.error ? { error: String(r.error) } : {}) }); return; } } })();
    const results: Result[] = await pooled(targets, poolSize('near'), async (a) => {
      const address = nearOf(a);
      // one trade per wallet+token+side in flight, held across tabs and until the receipt lands (as on the EVM lanes)
      const key = `near:${side}:${lc(token)}:${address}`;
      const busy = (): Result => { const error = `A ${side} of this token from this wallet is still being sent`; txEvent({ id, address, state: 'not_started', error }); return { name: a.name, address, ok: false, error, state: 'not_started' as TxState }; };
      return tradeGuard<Result>(key, busy, async () => {
        try { const { hash } = await nearTradeOne(a, side, route, size, s.slippage); txEvent({ id, address, state: 'submitted', hash }); return { ret: { name: a.name, address, ok: true, hash, state: 'submitted' as TxState }, landed: nearFollow(hash, address) }; }
        catch (e) {
          const unknown = e instanceof NearSendUnknown && e.hash ? e.hash : '';
          const state: TxState = unknown ? 'unknown' : 'not_started'; const error = shortError(e);
          txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) });
          return { ret: { name: a.name, address, ok: false, error, state, ...(unknown ? { hash: unknown } : {}) }, landed: unknown ? nearFollow(unknown, address) : null };
        }
      });
    });
    scheduleWatch(1200);
    const sent = results.filter((x) => x.ok).length;
    return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'near-dcl', timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
  }
  const addr = token.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('Invalid token address');
  const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
  const targets = list.filter((a) => ids.includes(a.id));
  if (!targets.length) throw new Error('No wallet selected');
  const s = tradeSettings(opts);
  const t0 = performance.now();
  const id = clickId(opts);
  for (const a of targets) txEvent({ id, address: a.address, state: 'preparing' });
  let route: Route;
  try { route = await routeFor(addr, hint); }
  catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: a.address, state: 'not_started', error }); throw e; }
  const shared = makeShared(targets.map((a) => a.address), id);   // one quote, one balance sheet for the whole click
  shared.mark('route', performance.now() - t0);
  // V13 VA-1: a re-run on the vault's own route (RouteChanged) gets a fresh click memo: the quotes are keyed by amount, not pool
  let again: { route: Route; shared: Shared } | null = null;
  const rerun = (r: Route) => (again && sameRoute(again.route, r) ? again : (again = { route: r, shared: makeShared(targets.map((a) => a.address), id) }));
  // V13 VA-1: a sell through a V2 path with an asset this chain does not know asks once, in the vault's own dialog
  if (side === 'sell' && route.type === 'v2') {
    const unknown = v2UnknownHops(route.path || [], BRIDGE_TOKENS, addr);
    if (unknown.length && !((hopConfirmed.get(routeSig(route)) || 0) > Date.now())) {
      const ok = await ask({ title: 'Sell through an unknown asset', danger: true, ok: 'Sell', html: `${sub('This sell goes through a PancakeSwap V2 pair of an asset the vault does not know. Whoever created that pair sets its price.')}${addrRows(unknown.map((h, i) => ({ name: `Asset ${i + 1}`, address: h })), 4)}${muted('Sell only if you know this market.')}` });
      if (!ok) { for (const a of targets) txEvent({ id, address: a.address, state: 'not_started', error: 'Cancelled' }); throw new Error('Cancelled'); }
      hopConfirmed.set(routeSig(route), Date.now() + 120_000); if (hopConfirmed.size > 50) hopConfirmed.delete(hopConfirmed.keys().next().value as string);
    }
  }
  const pool = poolSize('evm');
  // the wallets past the first batch get their nonces in a few JSON-RPC batches of 10 while the first batch works
  // (one getTransactionCount per wallet was a burst of 50: the primary refused the batch, the fallback then took
  // 50 single requests at once — every one a 429, measured); a wallet a batch could not answer reads its own later
  if (targets.length > pool) nonceSheet(targets.slice(pool).map((a) => a.address)).catch(() => {});
  const results: Result[] = await pooled(targets, pool, async (a, idx) => {
    const key = `${side}:${addr}:${lc(a.address)}`;
    let used = route, view = shared;
    const log = () => view.w[lc(a.address)];
    const busy = (): Result => { const error = `A ${side} of this token from this wallet is still being sent`; txEvent({ id, address: a.address, state: 'not_started', error }); return { name: a.name, address: a.address, ok: false, error, state: 'not_started' as TxState }; };
    return tradeGuard<Result>(key, busy, async () => {
      try {
        let hash: `0x${string}`;
        try { hash = await tradeOne(a, side, addr, size, route, s, shared); }
        catch (e) { if (!(e instanceof RouteChanged)) throw e; const r = rerun(e.route); used = r.route; view = r.shared; hash = await tradeOne(a, side, addr, size, used, s, view); }
        const landedP = watchReceipt(hash, id, a.address);
        // the buy is on its way; arm the sell path behind it so selling is one tx
        // polled every block (not viem's 4 s): the wallet is armed ~0.3 s after its buy lands instead of 5-30 s, so a quick sell finds nothing to approve
        // (the same receipt poll that feeds the page's states — one poll per hash, not two)
        if (side === 'buy') landedP.then((r) => { if (r?.status === 'success') armSellPath(a, addr, used, 0, idx); }).catch(() => {});
        return { ret: { name: a.name, address: a.address, ok: true, hash, state: 'submitted' as TxState, txs: log()?.txs || [], stages: log()?.stages || {} }, landed: landedP };
      } catch (e) {
        const err = e as SendError; const error = shortError(e);
        // a failure before any signature is not_started; a refused signature stays signed; unknown keeps its hash so the page can follow it
        const state: TxState = err.txState || 'not_started';
        // keep the guard until the unknown tx's receipt (it may be on chain); a clean pre-sign failure frees it at once
        const landed = state === 'unknown' && err.hash ? watchReceipt(err.hash, id, a.address) : null;
        if (!err.txState) txEvent({ id, address: a.address, state, error });
        return { ret: { name: a.name, address: a.address, ok: false, error, state, ...(state === 'unknown' && err.hash ? { hash: err.hash } : {}), txs: log()?.txs || [], stages: log()?.stages || {} }, landed };
      }
    });
  });
  // Stage clock of the click, in ms, slowest wallet per stage: route (hint -> verified route object),
  // balances (fee + balance + reserves, one batch), verify (route check, 0 after a prewarm), quote
  // (venue quote(s) not hidden behind the balance read), gas (eth_estimateGas), nonce (wait for the
  // nonce, 0 when cached), sign (local key: ms; Privy wallet: the page/Privy round trip), broadcast
  // (first node to accept), approve (an unarmed sell's approvals incl. their receipts, 0 when armed),
  // total; node = the node that accepted first; wallets = count; mode.
  const t = shared.t;
  const timing = { route: t.route ?? 0, balances: t.balances ?? 0, verify: t.verify ?? 0, quote: t.quote ?? 0, gas: t.gas ?? 0, approve: t.approve ?? 0, nonce: t.nonce ?? 0, sign: t.sign ?? 0, broadcast: t.broadcast ?? 0, total: Math.round(performance.now() - t0), wallets: targets.length, node: lastBroadcastNode, path: lastBroadcastPath, mode: s.turbo ? 'turbo' : 'fast', privy: targets.some((a) => !!a.ext) };
  const sent = results.filter((x) => x.ok).length;
  return { ok: true, id, ms: timing.total, results, route: route.type, timing, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
}
// the click's id for its 'trench:tx' events: the page's own (so it can match events that arrive before the answer) or a fresh one
const clickId = (opts?: unknown) => { const v = opts && typeof opts === 'object' ? String((opts as { id?: unknown }).id ?? '') : ''; return /^[\w:-]{1,48}$/.test(v) ? v : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
// Every hash a click submitted is followed to its receipt once, here: the page's receipt() polls read this
// instead of asking the node again, and the outcome goes out as a 'trench:tx' event (confirmed / reverted;
// still nothing after the wait: pending stays pending — the page says so and never re-sends).
const receipts = new Map<string, { at: number; r?: { status: string; block: number; gasUsed: number; feeEth: number } }>();
const receiptWaits = new Map<string, Promise<{ status: string } | null>>();
function watchReceipt(hash: string, id: string, address: string): Promise<{ status: string } | null> {
  const k = lc(hash); const had = receiptWaits.get(k); if (had) return had;
  receipts.set(k, { at: Date.now() });
  if (receipts.size > 300) { const old = receipts.keys().next().value as string; receipts.delete(old); receiptWaits.delete(old); }
  const p = landed(hash as `0x${string}`, 120_000).then((r) => {
    const v = { status: r.status, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), feeEth: Number(formatEther(r.gasUsed * r.effectiveGasPrice)) };
    receipts.set(k, { at: Date.now(), r: v });
    txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash });
    return v;
  }, () => { receipts.delete(k); receiptWaits.delete(k); txEvent({ id, address, state: 'pending', hash }); return null; });
  receiptWaits.set(k, p);
  return p;
}
// ── ELYSIUM (trade-core.patch E9; owner's yes needed; the decisions are src/elysiumCore.ts) ──
// The Elysium frame (chain 99901, gas HYPE) trades ONLY here; Robinhood / BNB never reach this code and this code never runs on
// them (tradeOne / previewOne / checkRoute / armSellPath send an Elysium frame or an 'ely' route here first, nothing else).
// One click, per wallet (r2 = the independent review's fixes, B:\tmp\elysium-review\review.txt):
//   r3: motion's second price reading is /check (every pool of the coin, the fixed 0.002 HYPE round trip, another trusted node,
//         its age counted by the server): a BUY needs it for its pool; a SELL is refused only by a fresh reading of the very pool it
//         sells into that disagrees (N1). The plain-wallet proof runs with validation — real base fee and gas price (N2).
//   buy : t=0 — fee, block (its timestamp dates the deadline and the permit: L-T9), balance, nonce, the route check, motion's
//         second price reading (M-T3), ONE probe eth_call (every
//         canonical pool bought with the click's HYPE, 1 % of it sent to a fresh address (tax test), sold straight back, plus the
//         1/50 reference buy; once per click) and the hinted pool's gas proof, side by side → the best pool (the hint within 2 %)
//         → the probe guards → the price against motion's second reading → floor = simulated coin out − slippage (Elysium's
//         default 5 %: M-T4) → the plain-wallet proof (eth_simulateV1 as the EOA, no code: buy with the floor → exact approvals
//         → sell back: M-T2; once per click) → sign → every node.
//   sell: t=0 — fee, block, balance, nonce, allowances (one multicall), the route check, motion's second reading, this wallet's
//         probe (every pool sold into with the real balance and allowances, plus a 1/50 reference sell) → the best pool → the
//         reference price against motion's (never the sell's own impact) → floor → the EXACT approvals it needs and the sell,
//         proven together as the wallet (eth_simulateV1; the probe's own run on a node without it) → sent back to back,
//         consecutive nonces → an approval this sell gave and did not use is reset to 0, whether the sell reverted, never
//         landed, or never went out (L-T8).
// Never: a standing (max) approval, turbo's unproven fixed gas, a platform fee, a router outside ELY_ROUTERS.
const ELY_PROBE_GAS = ELY.ELY_PROBE_GAS;   // r4: 30 M (every node of the pool serves it)
async function elyProbe(client: ReturnType<typeof createPublicClient>, from: `0x${string}`, cases: ELY.ElyProbeCase[], balance: bigint, gasPrice: bigint): Promise<ELY.ElySeen[]> {
  // the probe's code sits at the wallet's own address for this one call (state override, nothing deployed or signed); the
  // wallet's HYPE balance is set so the call can pay gas at the real price (a hook that hides behind a zero gas price sees the real one)
  const parts = await Promise.all(ELY.elyProbeChunks(cases).map((cs) => client.request({ method: 'eth_call', params: [{ from, to: from, data: ELY.probeData(cs), gas: '0x' + ELY_PROBE_GAS.toString(16), gasPrice: '0x' + gasPrice.toString(16) }, 'latest', ELY.elyProbeState(from, balance)] } as any) as Promise<`0x${string}`>));   // (rel7.1 T1) under 256 KiB per call
  const seen = parts.flatMap((ret) => ELY.probeDecode(ret));   // (rel7.1 T1) the chunks' answers, in case order
  if (seen.length !== cases.length) throw new Error('the node answered the simulation with another number of cases');
  return seen;
}
// calls as the wallet itself in one block (eth_simulateV1; the wallet stays an EOA, only its balance is set); null = no answer
// r3 (N2): `real` = { latestTs } runs it with validation and the next block's time (the real base fee and gas price: a token cannot
// tell it from the transaction); the observer that reads the balances gets a balance too
async function elySimulate(client: ReturnType<typeof createPublicClient>, from: `0x${string}`, calls: ELY.ElySimCall[], balance: bigint | null, gasPrice: bigint, real?: { latestTs: number; baseFee?: bigint; block?: bigint }): Promise<ELY.ElySimResult[] | null> {
  try {
    const hx = (n: bigint) => '0x' + n.toString(16);
    const over = balance != null ? { [from]: { balance: hx(balance) }, ...(real ? { [ELY.ELY_OBSERVER]: { balance: hx(10n ** 18n) } } : {}) } : null;
    const blk = real ? ELY.elySimBlock(real.latestTs, real.baseFee) : null;
    const res = await (client as any).request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ ...(over ? { stateOverrides: over } : {}), ...(blk ? { blockOverrides: blk.blockOverrides } : {}), calls: calls.map((c) => ({ ...c, gasPrice: hx(gasPrice) })) }], ...(blk ? { validation: true } : {}) }, real?.block != null ? hx(real.block) : 'latest'] });   // on the block whose time it extends
    const out = res?.[0]?.calls;
    return Array.isArray(out) && out.length === calls.length ? out as ELY.ElySimResult[] : null;
  } catch { return null; }
}
// motion's second price reading of the coin (r3: the lane's /check — every pool, the fixed 0.002 HYPE round trip, ANOTHER trusted
// node, its age counted by the server; N1 / N4), shared by the click's wallets for a few seconds. The age the vault uses is the
// server's ageMs plus the time since the answer arrived on THIS device's monotonic clock: no wall-clock comparison (L-T9).
// r4 (merged review M1): `fresh` skips this memo and asks the server for a reading at most 2 s old (/check?fresh=1); a sell always asks
// fresh. r4 (preview): the request carries the owner's preview cookie (credentials 'include' — motion's own host, the browser attaches
// it; no page or vault code ever reads it) and the click's wallet addresses (x-ely-wallets); while Elysium trading is in PREVIEW the
// relay accepts signed transactions only from wallets a preview session named this way (the sender is recovered from the signature).
const elyLaneMemo = new Map<string, { t: number; p: Promise<{ v: ELY.ElyLaneReading; t: number }> }>();
// r5 (B7): `sized` asks the other operator for the click's own size too (buy: the HYPE in; sell: the coins in, measured as the first
// wallet named — the selling wallet); such a reading is never memoised. r5 (R3): the answer says whether buys are open to this session.
// r7 (X4): `avoid` = operators the reading must not come from (a THIRD operator's reading of the same sell); never memoised either
async function elyLaneCheck(token: `0x${string}`, fresh = false, wallets: string[] = [], sized: { side: 'buy' | 'sell'; size: bigint } | null = null, avoid: string[] = []): Promise<ELY.ElyLaneReading> {
  const k = lc(token), now = performance.now(), e = elyLaneMemo.get(k);
  let p = !fresh && !sized && !wallets.length && !avoid.length && e && now - e.t < 5_000 ? e.p : null;
  if (!p) {
    const headers: Record<string, string> = wallets.length ? { 'x-ely-wallets': wallets.slice(0, 8).map(lc).join(',') } : {};
    const q = [fresh || sized ? 'fresh=1' : '', sized ? `side=${sized.side}&size=${sized.size.toString()}` : '', avoid.length ? 'avoid=' + avoid.slice(0, 3).map(encodeURIComponent).join(',') : ''].filter(Boolean).join('&');
    p = fetch(`${routeApi()}/token/${k}/check${q ? '?' + q : ''}`, { cache: 'no-store', credentials: 'include', headers, signal: AbortSignal.timeout(OWN_TIMEOUT) }).then((r) => r.json())
      .then((j: { ok?: boolean; checks?: ELY.ElyLaneCheck[]; ageMs?: number; independent?: boolean; sized?: ELY.ElyLaneSized[]; mayBuy?: boolean; ops?: unknown }) => ({ v: j?.ok && Array.isArray(j.checks) ? { checks: j.checks, ageMs: Number(j.ageMs), independent: j.independent === true, ...(Array.isArray(j.sized) ? { sized: j.sized } : {}), ...(typeof j.mayBuy === 'boolean' ? { mayBuy: j.mayBuy } : {}), ...(Array.isArray(j.ops) ? { ops: j.ops.filter((x): x is string => typeof x === 'string').slice(0, 3) } : {}) } : null, t: performance.now() }), () => ({ v: null, t: performance.now() }));
    if (!sized && !avoid.length) elyLaneMemo.set(k, { t: now, p });
    if (elyLaneMemo.size > 200) elyLaneMemo.delete(elyLaneMemo.keys().next().value as string);
  }
  const got = await p;
  return got.v ? { ...got.v, ageMs: got.v.ageMs + (performance.now() - got.t) } : null;
}
// the vault's own reading of a pool at the lane's fixed size: its probe's 0.002 HYPE round-trip case on that candidate
const elyOwnRef = (s?: ELY.ElySeen): ELY.ElyOwnRef => (s && s.ran && s.buyOk && s.sellOk ? { buyOut: s.coinGot, sellIn: s.coinSold, sellOut: s.nativeBack } : null);
// the slippage of this Elysium trade: what the user set IN THIS FRAME (its own key, N5), else Elysium's default 5 % (M-T4)
const elySlip = (s: Settings): bigint => { let v: string | null = null; try { v = localStorage.getItem(ELY.ELY_SLIP_KEY); } catch {} return v != null ? ELY.elySlippageBps(Number(v), true) : ELY.elySlippageBps(s.slippage, false); };
const elySend = async (wallet: ReturnType<typeof createWalletClient>, account: Signer, token: `0x${string}`, tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }, maxValue: bigint, gasPrice: bigint, gas: bigint, clock: Shared) => {
  // the last look before the key: only a known router, this coin's approve to Permit2, or Permit2's approve of it to a known router
  const bad = ELY.elyTxProblem(tx, token, maxValue); if (bad) throw new Error('Refusing to sign: ' + bad);
  if (gasPrice > ELY.ELY_MAX_GAS_PRICE * 5n || gas * gasPrice > ELY.ELY_MAX_FEE_WEI) throw new Error('Refusing to sign: abnormal gas for Elysium');
  return signAndSend(wallet, account, tx, gasPrice, gas, clock);
};
// r8 (review Y1): the sell-priority ticket — the wallet's key signs ELY.elyTicketText (~1 ms, local) and the relay registers it for
// this client; only then do this wallet's probe and simulation use its sell share. Cached ~45 s per wallet. Any failure (a custom RPC
// that does not know the method, a busy relay) costs only the priority: the sell goes on as an ordinary call.
const elyTickets = new Map<string, { exp: number; p: Promise<boolean> }>();
const elyPause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
function elyTicket(client: { request: (a: any) => Promise<unknown> }, account: Signer): Promise<boolean> {
  const k = lc(account.address), nowS = Math.floor(Date.now() / 1000), hit = elyTickets.get(k);
  if (hit && hit.exp - nowS > 15) return hit.p;
  const exp = nowS + 60, nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  let origin = ''; try { origin = new URL(routeApi()).origin; } catch { return Promise.resolve(false); }
  const p = account.signMessage({ message: ELY.elyTicketText({ origin, wallet: k, exp, nonce }) })
    .then((sig) => client.request({ method: 'motion_elySellTicket', params: [{ wallet: k, exp, nonce, origin, sig }] }))
    .then((r) => r === true, () => false);
  elyTickets.set(k, { exp, p }); if (elyTickets.size > 200) elyTickets.delete(elyTickets.keys().next().value as string);
  return p;
}
async function elyTradeOne(acct: Account, side: 'buy' | 'sell', token: `0x${string}`, size: number, route: Route, s: Settings, click: Shared): Promise<`0x${string}`> {
  if (CFG.key !== 'elysium' || chain.id !== ELY.ELY_CHAIN_ID) reject('an Elysium route outside the Elysium frame');
  { const why = ELY.elyRouteProblem(token, route); if (why) reject(why); }
  const account = accountOf(acct);
  const shared = click.view(account.address);
  const wallet = createWalletClient({ account, chain, transport });
  const hv = heavyFor(Math.max(0, shared.addresses.findIndex((a) => same(a, account.address))));
  const slippageBps = elySlip(s);
  const r = route as unknown as ELY.ElyRoute;
  const cands = ELY.elyCandidates(token, r);
  const amountBuy = side === 'buy' ? parseEther(String(size)) : 0n;
  if (side === 'buy' && (!(size > 0) || size > MAX_BUY_ETH)) throw new Error('Amount out of range');
  const refIn = amountBuy / ELY.ELY_REF_DIVISOR > ELY.ELY_REF_MIN ? amountBuy / ELY.ELY_REF_DIVISOR : ELY.ELY_REF_MIN;
  nextNonce(account.address).catch(() => {});
  const tReads = performance.now();
  const feeP = feeFor(s.gasBoost);
  // the chain's own clock dates the deadline and the permit (L-T9): a wrong device clock can neither expire nor stretch them
  const blockP = shared.once('ely:block', () => publicClient.getBlock());
  const laneP = shared.once(`ely:lane:${lc(token)}:${amountBuy}`, () => elyLaneCheck(token, side === 'sell', shared.addresses, side === 'buy' ? { side: 'buy', size: amountBuy } : null));   // r4: a sell reads fresh from the start; the click's wallets ride along (preview). r5 (B7): a buy's reading includes its own size
  const verifyP = Promise.all([verifyRoute(token, route), vouchFor(route)]);
  verifyP.catch(() => {}); blockP.catch(() => {});
  const tNow = async () => Number((await blockP).timestamp);
  if (side === 'buy') {
    // the probe once per click (from the first wallet: the price and the coin's behaviour do not depend on who asks; every
    // wallet's own transaction is proven by its own estimate below), the hinted pool's gas proved beside it (minOut 0: the gas
    // does not depend on the floor)
    const first = shared.addresses[0] || account.address;
    const deadlineP = shared.once('ely:deadline', async () => BigInt(await tNow() + ELY.ELY_DEADLINE_S));
    const probeP = shared.once(`ely:buy:${amountBuy}`, async () => {
      const [gp, deadline] = await Promise.all([feeP, deadlineP]);
      return elyProbe(heavy, first, [...cands.map((c) => ELY.probeCase(c, token, { buy: amountBuy, roundTrip: true, transferBps: ELY.ELY_TAX_TEST_BPS, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: refIn, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: ELY.ELY_LANE_REF_IN, roundTrip: true, deadline }))], amountBuy + refIn + ELY.ELY_LANE_REF_IN + QUOTE_FUNDING, gp);
    });
    probeP.catch(() => {});
    const [gasPrice, balances, deadline] = await Promise.all([feeP, tradeBalances(shared, 'buy', token), deadlineP]);
    shared.mark('balances', performance.now() - tReads);
    const bal = balances[lc(account.address)];
    if (bal == null) throw new Error('Balance read failed');
    if (bal < amountBuy) throw new Error(`Insufficient ${NATIVE}: ${Number(formatEther(bal)).toFixed(4)} available, ${size} needed`);
    { const t0 = performance.now(); await verifyP; shared.mark('verify', performance.now() - t0); }
    const tQuote = performance.now();
    let seen: ELY.ElySeen[];
    try { seen = await probeP; } catch (e) { throw new Error(`Could not simulate this buy on Elysium (${shortError(e).slice(0, 80)}) — nothing was sent`); }
    const full = seen.slice(0, cands.length), refs = seen.slice(cands.length, 2 * cands.length), laneRefs = seen.slice(2 * cands.length);
    const pick = ELY.elyPick(cands, full, 'buy');
    if (!pick) reject('no Elysium pool of this coin would fill this buy');
    const problem = ELY.elyBuyProblem(pick!.s, refs[pick!.i], amountBuy, refIn);
    if (problem) throw new Error(problem);
    // M-T3: the reference price this node gave against motion's second reading (another trusted node)
    // r4 (M1): a refusal is decided on a FRESH reading — a stale one in a fast pump is re-read once (/check?fresh=1) first
    { const own = elyOwnRef(laneRefs[pick!.i]);
      let why = ELY.elyLaneProblem('buy', pick!.c.pool, own, await laneP, slippageBps);
      if (why) why = ELY.elyLaneProblem('buy', pick!.c.pool, own, await shared.once(`ely:fresh:${lc(token)}`, () => elyLaneCheck(token, true)), slippageBps);
      if (why) throw new Error(why); }
    // r5 (R3): buys open to this session only where motion says so (preview); a vault reading Elysium through its own RPC included
    { const lr = await laneP; if (lr && lr.mayBuy === false) throw new Error('Elysium buys are not open to this session on motion (preview) — nothing was sent'); }
    // r5 (B7): the other operator's coin out at THIS size; the floor from the more conservative of the two, a large gap refuses
    const laneSized = ELY.elyLaneSizedOut(await laneP, pick!.c.pool, 'buy', amountBuy);
    // r6 (review Q3): no second reading at this size for this pool = not bought (fail closed, like the 0.002 HYPE reading)
    if (laneSized == null) throw new Error('motion has no second reading of this pool at your size — not bought (try again in a moment)');
    { const why = ELY.elySizedBuyProblem(pick!.s.coinGot, laneSized, slippageBps); if (why) throw new Error(why); }
    const floor = ELY.elySizedFloor('buy', pick!.s.coinGot, laneSized, slippageBps);
    // r4 (M2): the gas this buy is SIGNED with; r5 (B1): its plain-wallet sell-back runs at the CAP (the sell a holder may later sign at)
    const buyGas = ELY.elySwapGas(pick!.s.buyGas), backGas = ELY.ELY_SWAP_GAS_CAP;
    if (!(buyGas > 0n) || !(backGas > 0n)) throw new Error('the simulation gave no gas figure for this buy — nothing was sent');
    const tx = { to: pick!.c.router as `0x${string}`, data: ELY.elyExecute(ELY.elyBuyEnc(pick!.c, token, amountBuy, floor), deadline), value: amountBuy };
    // M-T2: the plain wallet buys with this very floor and sells straight back, in one simulated block (once per click)
    const eoa = await shared.once(`ely:eoa:${amountBuy}:${pick!.c.pool}`, async () => {
      const sellAmt = (pick!.s.coinGot * ELY.ELY_EOA_SELL_BPS) / 10_000n;
      const ts = await tNow(), b0 = await blockP, baseFee = b0.baseFeePerGas ?? undefined;
      const res = await elySimulate(heavy, first, ELY.elyEoaCalls({ wallet: first, c: pick!.c, token, amountIn: amountBuy, floor, sellAmt, deadline, now: ts, buyGas, sellGas: backGas }), amountBuy + QUOTE_FUNDING, gasPrice, { latestTs: ts, baseFee, block: b0.number ?? undefined });
      return ELY.elyEoaProblem(res, { amountIn: amountBuy, floor, sellAmt, gasPrice });
    });
    if (eoa.problem) throw new Error(eoa.problem);
    shared.mark('quote', performance.now() - tQuote);
    // r4 (M2): signed at exactly the gas the plain-wallet proof ran this very call at (no separate estimate)
    shared.mark('gas', 0);
    return elySend(wallet, account, token, tx, amountBuy, gasPrice, buyGas, shared);
  }
  // ── sell ──
  const ticketP = elyTicket(hv as any, account);   // r8 (Y1): proof of control for the sell share, before the probe goes out
  const P2 = ELY.ELY_PERMIT2 as `0x${string}`;
  // r8: + the WHYPE each router already holds (a WHYPE-pool sell's floor is computed from its own part only)
  const allowP = publicClient.multicall({ allowFailure: false, contracts: [
    { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, P2] },
    ...ELY.ELY_ROUTERS.map((ur) => ({ address: P2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, ur as `0x${string}`] })),
    ...ELY.ELY_ROUTERS.map((ur) => ({ address: ELY.ELY_WHYPE as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [ur as `0x${string}`] })),
  ] as any }) as Promise<unknown[]>;
  allowP.catch(() => {});
  const [gasPrice, balances, block] = await Promise.all([feeP, tradeBalances(shared, 'sell', token), blockP]);
  shared.mark('balances', performance.now() - tReads);
  const bal = balances[lc(account.address)];
  if (bal == null) throw new Error('Balance read failed');
  const amountIn = (bal * BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100))) / 10_000n;
  if (amountIn <= 0n) throw new Error('Nothing to sell in this wallet');
  const now = Number(block.timestamp), deadline = BigInt(now + ELY.ELY_DEADLINE_S);
  const tQuote = performance.now();
  // r5 (B7): the other operator measures this very sell (these coins, from this wallet) beside our own probe
  const sizedP = elyLaneCheck(token, true, [account.address], { side: 'sell', size: amountIn }).catch(() => null);
  await Promise.race([ticketP, elyPause(800)]);   // the ticket first (≤ 0.8 s; it is one local signature and one request)
  const probeP = elyProbe(hv, account.address, [...cands.map((c) => ELY.probeCase(c, token, { sell: amountIn, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: ELY.ELY_LANE_REF_IN, roundTrip: true, deadline }))], ELY.ELY_LANE_REF_IN + QUOTE_FUNDING, gasPrice);
  probeP.catch(() => {});
  { const t0 = performance.now(); await verifyP; shared.mark('verify', performance.now() - t0); }
  let seen: ELY.ElySeen[];
  try { seen = await probeP; } catch (e) { throw new Error(`Could not simulate this sell on Elysium (${shortError(e).slice(0, 80)}) — nothing was sent`); }
  const pick = ELY.elyPick(cands, seen.slice(0, cands.length), 'sell');
  if (!pick) reject('no Elysium pool of this coin takes this sell');
  const problem = ELY.elySellProblem(pick!.s, amountIn);
  if (problem) throw new Error(problem);
  // M-T3 / N1: refused only when motion's fresh, independent reading of THIS pool at the fixed size disagrees; a missing, stale or
  // busy reading never stops an exit (the floor is this vault's own simulation, as on every chain)
  // r4 (M1): only a reading ≤ 5 s old counts; one that disagrees is re-read fresh once, and if it still disagrees the user decides with
  // both figures in front of them (one dialog per click) — never a silent refusal.
  // r6 (review Q2): the other operator's reading of THIS sell (these coins, this wallet) is a question too when it beats our own quote
  // by more than the bound — the floor itself is never raised (own quote × (1 − slippage)).
  // r6 (review P1): an UNATTENDED sell (only the auto-sell rules start one: click id "autosell:…") never waits on a dialog; a sell
  // someone clicked waits for their answer, with no timer. r7 (review X4): an unattended sell whose readings disagree measures the same
  // sell on a THIRD operator and takes the floor from the median of the three (none: a bounded floor, ELY.elyAutosellFloor).
  let autoFloor: bigint | null = null;
  // r8: this sell's own HYPE back — the probe's figure less the WHYPE already in a WHYPE-pool's router (unwrapped together with ours)
  const al = await allowP;
  const leftover = (al[1 + ELY.ELY_ROUTERS.length + ELY.ELY_ROUTERS.indexOf(lc(pick!.c.router))] as bigint) ?? 0n;
  const ownBack = ELY.elySellOwnBack(pick!.s.nativeBack, pick!.c.pair, leftover);
  if (ownBack == null) throw new Error('the router holds as much WHYPE as this sell returns — not sent (try again in a moment)');
  const less = pick!.s.nativeBack - ownBack, mine = (x: bigint | null) => (x == null ? null : x > less ? x - less : 0n);
  { const own = elyOwnRef(seen[cands.length + pick!.i]);
    const unattended = String(click.id || '').startsWith('autosell:');
    let why = ELY.elyLaneProblem('sell', pick!.c.pool, own, await laneP, slippageBps);
    if (why) why = ELY.elyLaneProblem('sell', pick!.c.pool, own, await shared.once(`ely:fresh:${lc(token)}`, () => elyLaneCheck(token, true)), slippageBps);
    const sizedGap = ELY.elySizedSellGap(pick!.s.nativeBack, ELY.elyLaneSizedOut(await sizedP, pick!.c.pool, 'sell', amountIn), slippageBps);
    if ((why || sizedGap) && !unattended) {
      const gap = why ? why.replace(/^the node quoted a sell price /, '').replace(/ worse than motion's second reading of this pool$/, '') : sizedGap;
      const minOut = Number(formatEther(ELY.elyFloor(ownBack, slippageBps))).toPrecision(6);
      const go = await shared.once(`ely:sellask:${lc(pick!.c.pool)}`, () => ask({ title: 'Prices disagree', danger: true, ok: 'Sell anyway', cancelLabel: 'Keep the coins',
        html: `${sub(`Your node prices this sell ${escHtml(gap)} worse than motion's second node, measured seconds ago on the same pool${sizedGap && !why ? ' at your size' : ''}.`)}${muted(`Minimum you accept: ${escHtml(minOut)} ${NATIVE} (your slippage). The price may be falling fast, or one node may be wrong.`)}` }));
      if (!go) throw new Error('Sell cancelled — the two price readings disagreed');
    }
    if ((why || sizedGap) && unattended) {
      const r2 = await sizedP, second = ELY.elyLaneSizedOut(r2, pick!.c.pool, 'sell', amountIn);
      const r3 = r2?.ops?.length ? await elyLaneCheck(token, true, [account.address], { side: 'sell', size: amountIn }, r2.ops).catch(() => null) : null;
      const third0 = ELY.elyLaneSizedOut(r3, pick!.c.pool, 'sell', amountIn);
      autoFloor = ELY.elyAutosellFloor(ownBack, mine(second), mine(third0 != null && ELY.elyOpsDisjoint(r2?.ops, r3?.ops) ? third0 : null), slippageBps);
    }
  }
  // r6 (Q2): a sell someone clicked: our own quote × (1 − slippage), never raised by another reading; r7 (X4): an auto-sell whose
  // readings disagreed: the median / bounded floor above
  const floor = autoFloor ?? ELY.elySizedFloor('sell', ownBack, null, slippageBps);
  const router = pick!.c.router as `0x${string}`;
  const p2 = al[1 + ELY.ELY_ROUTERS.indexOf(lc(router))] as readonly [bigint, number, number];
  const approvals = ELY.elyApprovals({ token, router, amount: amountIn, allowance: al[0] as bigint, p2Amount: p2[0], p2Expiry: Number(p2[1]), now });
  const sellTx = { to: router, data: ELY.elyExecute(ELY.elySellEnc(pick!.c, token, amountIn, floor), deadline), value: 0n };
  const txs = [...approvals.map((a) => ({ to: a.to, data: a.data, value: 0n })), sellTx];
  shared.mark('quote', performance.now() - tQuote);
  // the chain proven as this wallet, each call on the state the one before left (one round trip). r4 (M2): every call runs at the gas
  // it is signed with (approvals ELY_APPROVE_GAS, the sell elySwapGas of the probe's figure), with validation and the next block's time
  // (the real base fee and gas price, N2) — a token that lets a sell through only with a high gasleft() fails HERE, not on chain
  const tGas = performance.now();
  const sellGas = ELY.elySwapGas(pick!.s.sellGas);
  if (!(sellGas > 0n)) throw new Error('the simulation gave no gas figure for this sell — nothing was sent');
  let gases: bigint[] = [...approvals.map(() => ELY.ELY_APPROVE_GAS), sellGas];
  const hxg = (n: bigint) => ('0x' + n.toString(16)) as `0x${string}`;
  const simAt = (g: bigint[]) => elySimulate(hv, account.address, txs.map((t, i) => ({ from: account.address, to: t.to, data: t.data, value: '0x0' as `0x${string}`, gas: hxg(g[i]) })), null, gasPrice, { latestTs: now, baseFee: block.baseFeePerGas ?? undefined, block: block.number ?? undefined });
  let res = await simAt(gases);
  // r5 (B1 / R5): a failure at the formula limits is simulated again at the caps; if that passes the chain is SIGNED at the caps
  if (res && res.some((c) => c?.status !== '0x1')) {
    const capped = [...approvals.map(() => ELY.ELY_APPROVE_GAS_CAP), ELY.ELY_SWAP_GAS_CAP];
    const again = await simAt(capped);
    if (again && again.every((c) => c?.status === '0x1')) { gases = capped; res = again; }
  }
  if (res) {
    const bad = res.findIndex((c) => c?.status !== '0x1');
    if (bad >= 0) throw new Error(`${bad < approvals.length ? approvals[bad].label : 'the sell'} would revert: ${String(res[bad]?.error?.message || 'execution reverted').slice(0, 120)}`);
  }
  // a node without eth_simulateV1: the probe ran these approvals and this sell as this wallet (at its own 40 M gas); same limits
  shared.mark('gas', performance.now() - tGas);
  // an approval this sell gave and did not use goes back to 0 — after a sell that reverted, never landed, or never went out (L-T8)
  const resetLeftovers = () => { if (!approvals.length) return; (async () => {
    const [a, p] = await publicClient.multicall({ allowFailure: false, contracts: [
      { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, P2] },
      { address: P2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, router] },
    ] as any }) as [bigint, readonly [bigint, number, number]];
    const resets = ELY.elyResets({ token, router, amount: amountIn, allowance: a, p2Amount: p[0] });
    const gp = await feeFor(1);
    for (const x of resets) await elySend(wallet, account, token, { to: x.to, data: x.data, value: 0n }, 0n, gp, ELY.ELY_APPROVE_GAS, makeShared([account.address]));
  })().catch(() => {}); };
  let hash: `0x${string}`;
  try {
    for (let i = 0; i < approvals.length; i += 1) await elySend(wallet, account, token, txs[i], 0n, gasPrice, gases[i], shared);
    hash = await elySend(wallet, account, token, sellTx, 0n, gasPrice, gases[gases.length - 1], shared);
  } catch (e) {
    // an approval may be out while the sell is not (refused, lost): reset behind the click; a send whose outcome is unknown may
    // still land, so its receipt decides (the reset only ever touches an allowance of exactly this sell's size or less)
    const err = e as SendError;
    if (err.txState === 'unknown' && err.hash) landed(err.hash, 120_000).then((rc) => { if (rc.status !== 'success') resetLeftovers(); }, () => resetLeftovers());
    else resetLeftovers();
    throw e;
  }
  if (approvals.length) landed(hash, 120_000).then((rc) => { if (rc.status !== 'success') resetLeftovers(); }, () => resetLeftovers());
  return hash;
}
// the preflight of the same click: the same probe, the same pick and guards, the same calldata; nothing signed or sent
async function elyPreviewOne(acct: Account, side: 'buy' | 'sell', token: `0x${string}`, size: number, route: Route, s: Settings): Promise<Preview> {
  const account = accountOf(acct);
  const slippageBps = elySlip(s);
  const notes: string[] = [];
  const [gasPrice, balance, block] = await Promise.all([feeFor(s.gasBoost), publicClient.getBalance({ address: account.address }), publicClient.getBlock(), verifyRoute(token, route)]);
  const out: Preview = { name: acct.name, address: account.address, side, venue: 'Elysium', contract: ZERO, method: 'execute', amountIn: 0, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0,
    gas: 0, gasPriceGwei: Number(gasPrice) / 1e9, gasEth: 0, balanceEth: Number(formatEther(balance)), funded: false, simulated: 'skipped', notes };
  const cands = ELY.elyCandidates(token, route as unknown as ELY.ElyRoute);
  const now = Number(block.timestamp), deadline = BigInt(now + ELY.ELY_DEADLINE_S);
  const label = (c: ELY.ElyCandidate) => `${ELY.ELY_VENUES[c.venue].label}${c.poolKey ? ` · ${c.poolKey.hooks === ZERO ? 'hookless' : 'hook ' + c.poolKey.hooks.slice(0, 10) + '…'} · fee ${(Number(c.poolKey.fee) / 10_000).toFixed(2)}%` : ` · fee ${(Number(c.fee) / 10_000).toFixed(2)}%`}`;
  notes.push(`slippage ${(Number(slippageBps) / 100).toFixed(1)}%`);
  try {
    if (side === 'buy') {
      if (!(size > 0) || size > MAX_BUY_ETH) throw new Error('Amount out of range');
      const amountIn = parseEther(String(size)), refIn = amountIn / ELY.ELY_REF_DIVISOR > ELY.ELY_REF_MIN ? amountIn / ELY.ELY_REF_DIVISOR : ELY.ELY_REF_MIN;
      out.amountIn = size; out.amountInLabel = `${size} ${NATIVE}`;
      const seen = await elyProbe(publicClient, account.address, [...cands.map((c) => ELY.probeCase(c, token, { buy: amountIn, roundTrip: true, transferBps: ELY.ELY_TAX_TEST_BPS, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: refIn, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: ELY.ELY_LANE_REF_IN, roundTrip: true, deadline }))], amountIn + refIn + ELY.ELY_LANE_REF_IN + PREVIEW_BALANCE, gasPrice);
      const full = seen.slice(0, cands.length), refs = seen.slice(cands.length, 2 * cands.length), laneRefs = seen.slice(2 * cands.length);
      const pick = ELY.elyPick(cands, full, 'buy');
      if (!pick) { out.simulated = 'failed'; out.error = 'no Elysium pool of this coin would fill this buy'; return out; }
      out.venue = label(pick.c); out.contract = pick.c.router as `0x${string}`;
      const floor = ELY.elyFloor(pick.s.coinGot, slippageBps);
      let problem = ELY.elyBuyProblem(pick.s, refs[pick.i], amountIn, refIn)
        || ELY.elyLaneProblem('buy', pick.c.pool, elyOwnRef(laneRefs[pick.i]), await elyLaneCheck(token), slippageBps);
      if (!problem) { const sellAmt = (pick.s.coinGot * ELY.ELY_EOA_SELL_BPS) / 10_000n; problem = ELY.elyEoaProblem(await elySimulate(publicClient, account.address, ELY.elyEoaCalls({ wallet: account.address, c: pick.c, token, amountIn, floor, sellAmt, deadline, now, buyGas: ELY.elySwapGas(pick.s.buyGas), sellGas: ELY.ELY_SWAP_GAS_CAP }), amountIn + PREVIEW_BALANCE, gasPrice, { latestTs: now, baseFee: block.baseFeePerGas ?? undefined, block: block.number ?? undefined }), { amountIn, floor, sellAmt, gasPrice }).problem; }
      out.expected = Number(formatUnits(pick.s.coinGot, 18)); out.min = Number(formatUnits(floor, 18)); out.pricePerToken = out.expected > 0 ? size / out.expected : 0;
      notes.push(`sold straight back it returns ${(Number((pick.s.nativeBack * 10_000n) / amountIn) / 100).toFixed(2)}% (fees, hook, tax)`, `price impact ${(ELY.elyImpactBps(pick.s, refs[pick.i], amountIn, refIn) / 100).toFixed(2)}%`, '0% platform fees');
      out.simulated = problem ? 'failed' : 'ok'; if (problem) out.error = problem;
      out.gas = Number(ELY.elySwapGas(pick.s.buyGas));
    } else {
      const bal = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
      const amountIn = (bal * BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100))) / 10_000n;
      out.amountIn = Number(formatUnits(amountIn, 18)); out.amountInLabel = `${size}% = ${out.amountIn.toFixed(4)} tokens`;
      if (amountIn <= 0n) { out.error = 'Nothing to sell in this wallet'; notes.push('fund the wallet with this token to preflight a sell'); return out; }
      const seen = await elyProbe(publicClient, account.address, [...cands.map((c) => ELY.probeCase(c, token, { sell: amountIn, deadline })), ...cands.map((c) => ELY.probeCase(c, token, { buy: ELY.ELY_LANE_REF_IN, roundTrip: true, deadline }))], ELY.ELY_LANE_REF_IN + PREVIEW_BALANCE, gasPrice);
      const pick = ELY.elyPick(cands, seen.slice(0, cands.length), 'sell');
      if (!pick) { out.simulated = 'failed'; out.error = 'no Elysium pool of this coin takes this sell'; return out; }
      out.venue = label(pick.c); out.contract = pick.c.router as `0x${string}`;
      const problem = ELY.elySellProblem(pick.s, amountIn) || ELY.elyLaneProblem('sell', pick.c.pool, elyOwnRef(seen[cands.length + pick.i]), await elyLaneCheck(token), slippageBps);
      out.expected = Number(formatEther(pick.s.nativeBack)); out.min = Number(formatEther(ELY.elyFloor(pick.s.nativeBack, slippageBps))); out.pricePerToken = out.amountIn > 0 ? out.expected / out.amountIn : 0;
      const [a, p] = await publicClient.multicall({ allowFailure: false, contracts: [
        { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ELY.ELY_PERMIT2] },
        { address: ELY.ELY_PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, token, pick.c.router] },
      ] as any }) as [bigint, readonly [bigint, number, number]];
      const ap = ELY.elyApprovals({ token, router: pick.c.router, amount: amountIn, allowance: a, p2Amount: p[0], p2Expiry: Number(p[1]), now });
      if (ap.length) notes.push(`${ap.length} exact approval${ap.length > 1 ? 's' : ''} go out first (${ap.map((x) => x.label).join(', ')}); nothing is left approved`);
      notes.push('0% platform fees');
      out.simulated = problem ? 'failed' : 'ok'; if (problem) out.error = problem;
      out.gas = Number(ELY.elySwapGas(pick.s.sellGas) + BigInt(ap.length) * ELY.ELY_APPROVE_GAS);
    }
  } catch (e) { out.simulated = 'failed'; out.error = shortError(e); }
  out.gasEth = (Number(gasPrice) / 1e18) * (out.gas || 400_000);
  out.funded = side === 'buy' ? out.balanceEth >= out.amountIn + out.gasEth : out.balanceEth >= out.gasEth;
  if (!out.funded) notes.push(side === 'buy' ? `needs ${(out.amountIn + out.gasEth).toFixed(5)} ${NATIVE} in the wallet` : `needs ${out.gasEth.toFixed(5)} ${NATIVE} for gas`);
  return out;
}
// ── /ELYSIUM ──
// viem puts the revert reason on the second line ("…reverted with the following reason:\nAS"): keep it, and spell out
// the terse Uniswap V3 codes a trader would otherwise stare at
const REASONS: Record<string, string> = { AS: 'AS — the V3 leg got no input amount', STF: 'STF — token transfer failed (tax or blocked transfer?)', 'Too little received': 'Too little received — slippage', SPL: 'SPL — price limit hit', IIA: 'IIA — insufficient input amount',
  // TC-T1 (exec-quality 2026-11-04): a V2 pool's floor is the pool's quote less the slippage, and that quote does not count the
  // coin's own fee-on-transfer tax — a sell (or buy) whose tax is at or above the slippage ends here
  'PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT': "INSUFFICIENT_OUTPUT_AMOUNT — the coin's tax may be above your slippage",
  'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT': "INSUFFICIENT_OUTPUT_AMOUNT — the coin's tax may be above your slippage",
  'Pancake: K': 'Pancake: K — the pool refused: the coin takes a tax or blocks transfers',
  'UniswapV2: K': 'UniswapV2: K — the pool refused: the coin takes a tax or blocks transfers',
  'TransferHelper: TRANSFER_FROM_FAILED': 'TRANSFER_FROM_FAILED — the coin refused the transfer (blocked, paused, sell limit)' };
const shortError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const lines = m.split('\n').map((x) => x.trim()).filter(Boolean);
  let out = lines[0] || '';
  if (/reason:$/.test(out) && lines[1]) out += ' ' + (REASONS[lines[1]] || lines[1]);
  return out.slice(0, 200);
};

// ── live balances ──────────────────────────────────────────────────────────
// One batched poll every couple of seconds for every wallet in the vault (plus
// any token a page asked to watch). Pages listen to `trench:balances` instead
// of re-fetching, so a deposit shows up within a block or two, no reload.
const WATCH_MS = 2000, WATCH_HIDDEN_MS = 10000;
const ethCache: Record<string, number> = {};
const tokenCache: Record<string, Record<string, number>> = {};
const watchedTokens = new Map<string, number>();     // token -> last requested at
let watchTimer: ReturnType<typeof setTimeout> | null = null, watchBusy = false, watchFirst = true;
async function pollBalances(force = false) {
  if (watchBusy || !unlocked) return; watchBusy = true;
  try {
    const list = unlocked;
    let changed = watchFirst || force;
    if (SOL_MODE) {
      const ids = list.map((a) => solAddressOf(a)).filter(Boolean);
      const bal = await solBalancesFor(ids);
      for (const [k, v] of Object.entries(bal)) if (ethCache[k] !== v) { ethCache[k] = v; ethCache[k.toLowerCase()] = v; changed = true; }
      for (const [token, at] of watchedTokens) {
        if (Date.now() - at > 10 * 60_000) { watchedTokens.delete(token); continue; }
        const rows = await solTokenBalancesFor(token, ids).catch(() => ({} as Record<string, number>));
        const m = tokenCache[token] || (tokenCache[token] = {});
        for (const [k, v] of Object.entries(rows)) if (m[k] !== v) { m[k] = v; m[k.toLowerCase()] = v; changed = true; }
      }
    } else if (NEAR_MODE) {
      const ids = list.map((a) => nearAccountId(a)).filter(Boolean);
      const bal = await nearBalancesFor(ids);
      for (const [k, v] of Object.entries(bal)) if (ethCache[k] !== v) { ethCache[k] = v; changed = true; }
      for (const [token, at] of watchedTokens) {
        if (Date.now() - at > 10 * 60_000) { watchedTokens.delete(token); continue; }
        const rows = await nearTokenBalancesFor(token, ids).catch(() => ({} as Record<string, number>));
        const m = tokenCache[token] || (tokenCache[token] = {});
        for (const [k, v] of Object.entries(rows)) if (m[k] !== v) { m[k] = v; changed = true; }
      }
    } else {
    const live: { address: `0x${string}`; decimals: number }[] = [];
    for (const [token, at] of watchedTokens) {
      if (Date.now() - at > 10 * 60_000) { watchedTokens.delete(token); continue; }
      live.push({ address: token as `0x${string}`, decimals: await tokenDecimals(token as `0x${string}`).catch(() => 18) });
    }
    const sheet = await evmBalanceSheet(list.map((a) => a.address), live);
    if (sheet) {
      for (const [k, v] of Object.entries(sheet.eth)) if (ethCache[k] !== v) { ethCache[k] = v; changed = true; }
      for (const [token, rows] of Object.entries(sheet.tokens)) { const m = tokenCache[token] || (tokenCache[token] = {}); for (const [k, v] of Object.entries(rows)) if (m[k] !== v) { m[k] = v; changed = true; } }
    }
    }
    watchFirst = false;
    if (changed) document.dispatchEvent(new CustomEvent('trench:balances', { detail: { eth: { ...ethCache }, tokens: Object.fromEntries(Object.entries(tokenCache).map(([t, m]) => [t, { ...m }])), at: Date.now() } }));
  } finally { watchBusy = false; }
}
function scheduleWatch(ms = WATCH_MS) { if (watchTimer) clearTimeout(watchTimer); watchTimer = setTimeout(async () => { await pollBalances().catch(() => {}); scheduleWatch(document.hidden ? WATCH_HIDDEN_MS : WATCH_MS); }, ms); }
ready.then(() => scheduleWatch(50));
// the page's backup prompts follow the balances (a funded wallet without a backup) and every vault change
document.addEventListener('trench:balances', () => pushBackupState());
listeners.add(() => pushBackupState());
listeners.add(() => scheduleWatch(50));                        // a created / imported wallet shows a balance at once
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleWatch(50); });
const decimalsCache = new Map<string, number>();
// the symbol a send dialog names: the stablecoins every lane holds by their known names (a coin can call itself
// anything — the dialog shows the contract beside it), else the token's own symbol()
const KNOWN_SYMBOLS: Record<string, string> = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG', '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1' };
async function tokenSymbolOf(token: string): Promise<string> {
  const k = KNOWN_SYMBOLS[token] || KNOWN_SYMBOLS[token.toLowerCase()]; if (k) return k;
  if (SOL_MODE) return String((await solTokenMeta(token)).symbol || '').slice(0, 16);
  return String(await publicClient.readContract({ address: token.toLowerCase() as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' })).replace(/[^\w$.-]/g, '').slice(0, 16);
}
async function tokenDecimals(token: `0x${string}`) {
  const k = token.toLowerCase(); const hit = decimalsCache.get(k); if (hit != null) return hit;
  const d = Number(await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }));
  decimalsCache.set(k, d); return d;
}

// ── moving funds between wallets ──────────────────────────────────────────
// 1→1, N→1 (consolidate), 1→N (distribute), N→N — all the same thing: a job
// made of legs. A leg is one transfer (ETH or an ERC-20). Jobs are written to
// localStorage after every state change, so a closed tab or a reload never
// loses track of money in flight: on the next load a 'sent' leg is resolved
// from its receipt and queued legs carry on. Legs from the same wallet run one
// after another (nonces); legs from different wallets run in parallel.
//
// Stealth routing: with hops > 0 each source→destination pair travels through
// fresh wallets generated for this job (source → hop1 → … → destination),
// with a random pause between legs. The destination is funded by an address
// that has never touched the source. Hop wallets stay in the vault (archived
// once empty) so nothing can strand: `sweepHops` returns any dust.
type Asset = { kind: 'eth' } | { kind: 'erc20'; address: `0x${string}`; symbol: string; decimals: number };
// 'signed' = write-ahead: locally signed and persisted (raw + hash + nonce) but not yet known-broadcast; 'unknown' =
// broadcast attempted, outcome not known (settles by hash, never re-signed). Neither is terminal — both recover.
type LegStatus = 'queued' | 'waiting' | 'signed' | 'sent' | 'unknown' | 'confirmed' | 'failed' | 'skipped';
type Leg = { id: string; from: `0x${string}`; to: `0x${string}`; amount: string | 'max'; asset: Asset; status: LegStatus; hash?: `0x${string}`; raw?: `0x${string}`; rev?: number; error?: string; after?: string; notBefore?: number; hop?: boolean; sentAt?: number; doneAt?: number; human?: number; nonce?: number };
type Job = { id: string; label: string; createdAt: number; status: 'running' | 'done' | 'failed' | 'cancelled'; hops: number; delay: [number, number]; legs: Leg[]; hopIds: string[]; asset: Asset; chain?: string };
type MoveSpec = { fromIds: string[]; toIds?: string[]; toAddresses?: string[]; asset: Asset; amount: { mode: 'fixed' | 'pct'; value: number; per: 'source' | 'dest' }; hops?: number; delay?: [number, number]; label?: string; chain?: string };
// One job store, one runner and one channel PER LANE (2026-10-19). The old shared 'trenches.jobs' + one runner lock let
// a frame of one lane adopt another lane's job and send its legs with its own chain client (a BNB move driven by a
// Robinhood, Solana or NEAR frame went out on Robinhood). A job now records its lane and only that lane's frames see
// or drive it; tabs still on an older engine keep the old key and never see these jobs. The mover itself is EVM:
// Solana and NEAR frames refuse to plan or start (their frames used to plan a Robinhood ETH move under their label).
const MOVE_LANE = SOL_MODE ? 'sol' : NEAR_MODE ? 'near' : CFG.key;
const MOVE_EVM = !SOL_MODE && !NEAR_MODE;
const moveLanePublic = (k: string) => (k === 'bsc' ? 'bnb' : k);   // the name the app and the site pass as spec.chain
// Elysium moves (release #6): the mover's own words name the frame's coin there (HYPE); Robinhood / BNB keep 'ETH' byte for byte
const MOVE_UNIT = CFG.key === 'elysium' ? NATIVE : 'ETH';
const JOBS_KEY = 'trenches.jobs.v2.' + MOVE_LANE;
const RUNNER_LOCK = 'trenches-jobs-runner.v2.' + MOVE_LANE;
let ETH_GAS = 21_000n;
const ERC20_GAS = 80_000n, MAX_HOPS = 4;
// A native send's gas on this lane. 21,000 on BNB; more on Robinhood Chain, an Arbitrum chain where the L1 data fee is
// paid in L2 gas, so a hard 21,000 was refused "The amount of gas (21000) provided for the transaction is too low" on every
// move between wallets (user report 2026-10-19). Estimated against the node from the sending wallet, 40 % headroom when
// above 21,000 (the L1 part follows the L1 base fee), refreshed every 2 min; the last value when the node does not answer.
let ethGasAt = 0;
async function syncEthGas(from: `0x${string}`, to?: `0x${string}`) {
  if (Date.now() - ethGasAt < 120_000) return ETH_GAS;
  try {
    const g = await publicClient.estimateGas({ account: from, to: to || from, value: 1n });
    ETH_GAS = g > 21_000n ? (g * 14n) / 10n : 21_000n; ethGasAt = Date.now();
  } catch { ethGasAt = Date.now() - 90_000; }
  return ETH_GAS;
}
const readJobs = (): Job[] => { try { const all = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); return Array.isArray(all) ? all.filter((j: Job) => j && j.chain === MOVE_LANE) : []; } catch { return []; } };
const jobs: Job[] = readJobs();
let isRunner = false;
// F-35 (V12): a runner is fenced by an epoch. Whoever becomes the runner bumps this counter in storage and keeps the
// value it saw; a new runner (a tab that STOLE the lock from a frozen holder) bumps it again, so the old holder's
// captured epoch no longer matches and it must not sign another leg even if its lock callback has not yet rejected.
const EPOCH_KEY = 'trenches.jobs.epoch.v2.' + MOVE_LANE;
let myEpoch = -1;
const bumpEpoch = () => { try { myEpoch = (Number(localStorage.getItem(EPOCH_KEY)) || 0) + 1; localStorage.setItem(EPOCH_KEY, String(myEpoch)); } catch { myEpoch = Date.now(); } };
const epochOk = () => { try { return (Number(localStorage.getItem(EPOCH_KEY)) || 0) === myEpoch; } catch { return true; } };
// only the current runner, at the current epoch, may write or sign
const mayDrive = () => isRunner && epochOk();
const bumpRev = (l: Leg) => { l.rev = (l.rev || 0) + 1; };
const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('trenches-jobs.v2.' + MOVE_LANE) : null;
const running = new Set<string>();           // leg ids in flight
const emitJobs = () => document.dispatchEvent(new CustomEvent('trench:jobs', { detail: jobs.map((j) => ({ ...j, legs: j.legs.map((l) => ({ ...l })) })) }));
// F-63 (V12): a non-runner NEVER writes the store (it only mirrors + emits); the runner MERGES by per-leg `rev`
// before writing, so a write never clobbers a leg another writer advanced further, and jobs a sibling tab created
// (not yet adopted here) are preserved. Previously saveJobs wrote the whole in-memory array over the disk.
const saveJobs = () => {
  emitJobs();
  if (!mayDrive()) return;                     // non-runners (and a fenced ex-runner) never write
  try {
    const disk = readJobs();
    const byId = new Map(disk.map((j) => [j.id, j]));
    for (const j of jobs) {                     // pull in any higher-rev leg a concurrent write left on disk (belt-and-braces)
      const d = byId.get(j.id); if (!d) continue;
      for (const leg of j.legs) { const dl = d.legs.find((x) => x.id === leg.id); if (dl && (dl.rev || 0) > (leg.rev || 0)) Object.assign(leg, dl); }
    }
    const seen = new Set(jobs.map((j) => j.id));
    const merged = [...jobs, ...disk.filter((d) => !seen.has(d.id))];   // keep sibling-created jobs we have not adopted
    localStorage.setItem(JOBS_KEY, JSON.stringify(merged.slice(-60)));
  } catch {}
};
// a tab that is not the runner mirrors the runner's state from storage
window.addEventListener('storage', (e) => {
  if (e.key !== JOBS_KEY) return;
  const disk = readJobs();
  if (!isRunner) { jobs.splice(0, jobs.length, ...disk); emitJobs(); return; }
  // runner: adopt jobs another tab created, keep our own in-flight state for the rest
  for (const j of disk) if (!jobs.some((x) => x.id === j.id)) { jobs.push(j); tickJob(j); }
});
// commands from other tabs land on the runner
bus?.addEventListener('message', async (e) => {
  if (!isRunner) return;
  const m = e.data || {};
  try {
    if (m.cmd === 'ping') { bus?.postMessage({ reply: m.rid, ok: true, id: 'runner' }); return; }
    // outside the vault frame the channel is the page's: a plan arriving on it may not send outside the vault
    if (m.cmd === 'start') { if (!HOST && (m.plan?.legs || []).some((l: Leg) => /^0x[0-9a-fA-F]{40}$/.test(String(l?.to)) && !isOwn(l.to))) throw new Error('outside legs start only in the tab that confirmed them'); const r = await startMove(m.plan, true); confirmedJobs.add(r.id); bus?.postMessage({ reply: m.rid, ok: true, id: r.id }); return; }
    else if (m.cmd === 'cancel') cancelJob(m.id);
    else if (m.cmd === 'retry') retryJob(m.id);
    bus?.postMessage({ reply: m.rid, ok: true, id: m.id });
  } catch (err) { bus?.postMessage({ reply: m.rid, ok: false, error: shortError(err) }); }
});
let takingOver = false;
async function ensureRunner(): Promise<boolean> {
  if (isRunner) return true;
  const alive = await askRunner({ cmd: 'ping' }).then(() => true).catch(() => false);
  if (alive) return false;
  // nobody answered: whoever holds the lock is frozen, discarded or gone without releasing — take it
  if (typeof navigator !== 'undefined' && navigator.locks && !takingOver) {
    takingOver = true;
    navigator.locks.request(RUNNER_LOCK, { steal: true }, async () => { await becomeRunner(); await new Promise(() => {}); }).catch(() => { takingOver = false; isRunner = false; });
    for (let i = 0; i < 20 && !isRunner; i += 1) await new Promise((r) => setTimeout(r, 100));
  } else if (!navigator?.locks) await becomeRunner();
  return isRunner;
}
// jobs that sit queued with nobody driving them get a driver: every half minute a non-runner tab with running jobs checks
setInterval(() => { if (!isRunner && jobs.some((j) => j.status === 'running' && j.legs.some((l) => l.status === 'queued' || l.status === 'waiting'))) ensureRunner().catch(() => {}); }, 30000);
const askRunner = (msg: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
  if (!bus) return reject(new Error('no channel'));
  const rid = jid('c');
  const timer = setTimeout(() => { bus.removeEventListener('message', on); reject(new Error('the tab running transfers did not answer')); }, 4000);
  const on = (e: MessageEvent) => { if (e.data?.reply !== rid) return; clearTimeout(timer); bus.removeEventListener('message', on); e.data.ok ? resolve(e.data) : reject(new Error(e.data.error)); };
  bus.addEventListener('message', on);
  bus.postMessage({ ...msg, rid });
});
const jid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const gasCostWei = (gasPrice: bigint, asset: Asset) => gasPrice * (asset.kind === 'eth' ? ETH_GAS : ERC20_GAS);
const humanOf = (wei: bigint, asset: Asset) => Number(formatUnits(wei, asset.kind === 'eth' ? 18 : asset.decimals));
const weiOf = (v: number, asset: Asset) => { const d = asset.kind === 'eth' ? 18 : asset.decimals; return BigInt(Math.round(v * 10 ** Math.min(d, 9))) * 10n ** BigInt(Math.max(0, d - 9)); };

function moveLaneCheck(want?: unknown) {
  if (!MOVE_EVM) throw new Error('Moving funds between wallets runs on Robinhood and BNB — not on this network yet');
  if (want != null && want !== '' && String(want) !== MOVE_LANE && String(want) !== moveLanePublic(MOVE_LANE)) throw new Error(`This vault frame runs ${moveLanePublic(MOVE_LANE)}, not ${String(want).slice(0, 16)} — nothing was planned`);
}
async function planMove(spec: MoveSpec) {
  moveLaneCheck(spec?.chain);
  const list = requireUnlocked();
  const sources = spec.fromIds.map((id) => list.find((a) => a.id === id)).filter(Boolean) as Account[];
  if (sources[0]) await syncEthGas(sources[0].address);   // the plan's fees and reserves use this lane's real send gas
  const dests = [
    ...(spec.toIds || []).map((id) => list.find((a) => a.id === id)).filter(Boolean).map((a) => ({ address: a!.address, name: a!.name, id: a!.id })),
    ...(spec.toAddresses || []).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).map((x) => ({ address: x as `0x${string}`, name: 'external', id: '' })),
  ];
  const errors: string[] = [], warnings: string[] = [];
  if (!sources.length) errors.push('Pick at least one source wallet');
  if (!dests.length) errors.push('Pick at least one destination');
  const hops = Math.max(0, Math.min(MAX_HOPS, Math.floor(spec.hops || 0)));
  // (security audit 2026-11-04, SEC-1) the token's decimals and symbol are the CHAIN's, never the page's: the legs send raw
  // units while the outside-send dialog (confirmOutside) prints the total with these decimals, so a page that called a
  // 6-decimal stablecoin 30-decimal made "Send outside your vault" read "0 USDC in total" while the whole balance went out
  let asset: Asset = { kind: 'eth' };
  if (spec?.asset?.kind === 'erc20') {
    const t = lc(String(spec.asset.address || ''));
    if (!/^0x[0-9a-f]{40}$/.test(t)) throw new Error('Invalid token address');
    const [d, sym] = await Promise.all([tokenDecimals(t as `0x${string}`), tokenSymbolOf(t).catch(() => '')]);
    if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('This token does not state its decimals');
    asset = { kind: 'erc20', address: t as `0x${string}`, symbol: sym || 'tokens', decimals: d };
  } else if (spec?.asset?.kind !== 'eth') throw new Error('Unknown asset');
  if (hops && asset.kind !== 'eth') errors.push(`Stealth routing moves ${MOVE_UNIT} only — a token would need every hop funded with gas first`);
  for (const s of sources) if (dests.some((d) => d.address.toLowerCase() === s.address.toLowerCase())) errors.push(`${s.name} is on both sides`);
  const gasPrice = await feeFor(1);
  const legGas = gasCostWei(gasPrice, asset);
  const nDest = Math.max(1, dests.length);
  const legs: Leg[] = [];
  const perSource: { id: string; name: string; address: `0x${string}`; balance: number; ethBalance: number; sends: number; gasEth: number; error?: string }[] = [];
  for (const s of sources) {
    const ethBal = await publicClient.getBalance({ address: s.address });
    const bal = asset.kind === 'eth' ? ethBal : await publicClient.readContract({ address: asset.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [s.address] });
    // every leg out of this wallet costs gas; hop legs are paid out of the amount forwarded
    const legsOut = BigInt(nDest);
    const gasOut = legGas * legsOut;
    const hopGas = hops ? gasPrice * ETH_GAS * BigInt(hops) : 0n;   // per pair: the chain's own gas, carried along
    let total: bigint;
    if (spec.amount.mode === 'pct') {
      const spendable = asset.kind === 'eth' ? bal - gasOut - hopGas * legsOut : bal;
      total = spendable > 0n ? (spendable * BigInt(Math.round(Math.max(0, Math.min(100, spec.amount.value)) * 100))) / 10_000n : 0n;
    } else {
      total = weiOf(spec.amount.value, asset) * (spec.amount.per === 'dest' ? legsOut : 1n);
    }
    const each = total / legsOut;
    const need = asset.kind === 'eth' ? total + gasOut + hopGas * legsOut : total;
    const row = { id: s.id, name: s.name, address: s.address, balance: humanOf(bal, asset), ethBalance: Number(formatEther(ethBal)), sends: humanOf(total, asset), gasEth: Number(formatEther(gasOut + hopGas * legsOut)), error: undefined as string | undefined };
    if (each <= 0n) row.error = 'nothing to send';
    else if (bal < need) row.error = `needs ${humanOf(need, asset).toFixed(asset.kind === 'eth' ? 5 : 2)} ${asset.kind === 'eth' ? MOVE_UNIT : asset.symbol}, has ${row.balance.toFixed(asset.kind === 'eth' ? 5 : 2)}`;
    else if (asset.kind !== 'eth' && ethBal < gasOut) row.error = `needs ${Number(formatEther(gasOut)).toFixed(5)} ${MOVE_UNIT} for gas`;
    perSource.push(row);
    if (row.error) continue;
    for (const d of dests) {
      if (!hops) { legs.push({ id: jid('l'), from: s.address, to: d.address, amount: each.toString(), asset, status: 'queued', human: humanOf(each, asset) }); continue; }
      // source → hop1 carries the amount plus the gas the rest of the chain burns; each hop forwards everything
      let prev: Leg = { id: jid('l'), from: s.address, to: '0x' as `0x${string}`, amount: (each + hopGas).toString(), asset, status: 'queued', hop: true, human: humanOf(each + hopGas, asset) };
      legs.push(prev);
      for (let h = 1; h < hops; h += 1) { const l: Leg = { id: jid('l'), from: '0x', to: '0x', amount: 'max', asset, status: 'queued', after: prev.id, hop: true, human: humanOf(each + hopGas - gasPrice * ETH_GAS * BigInt(h), asset) }; legs.push(l); prev = l; }
      legs.push({ id: jid('l'), from: '0x', to: d.address, amount: 'max', asset, status: 'queued', after: prev.id, human: humanOf(each, asset) });
    }
  }
  if (!legs.length && !errors.length) errors.push(perSource.find((r) => r.error)?.error || 'nothing to send');
  if (hops) warnings.push(`${hops * sources.length * nDest} fresh hop wallet${hops * sources.length * nDest === 1 ? '' : 's'} will be generated; each pair takes ${hops + 1} transactions with a ${Math.round((spec.delay?.[0] ?? 15))}–${Math.round(spec.delay?.[1] ?? 60)} s pause between legs`);
  const kind = sources.length > 1 && dests.length === 1 ? 'Consolidate' : sources.length === 1 && dests.length > 1 ? 'Distribute' : 'Transfer';
  const label = spec.label || `${kind} · ${sources.length} → ${dests.length}`;
  const totalHuman = legs.filter((l) => !l.after).reduce((s, l) => s + (l.amount === 'max' ? 0 : humanOf(BigInt(l.amount), asset)), 0);
  const gasEth = perSource.reduce((s, r) => s + (r.error ? 0 : r.gasEth), 0);
  const planId = jid('p');
  const out = { ok: !errors.length && legs.length > 0, chain: moveLanePublic(MOVE_LANE), planId, kind, label, errors, warnings, sources: perSource, dests, legs, hops, delay: spec.delay || [15, 60], asset, total: totalHuman, gasEth, gasPriceGwei: Number(gasPrice) / 1e9 };
  plans.set(planId, { plan: structuredClone(out), at: Date.now() });
  if (plans.size > 50) plans.delete(plans.keys().next().value as string);
  return out;
}
type Plan = Awaited<ReturnType<typeof planMove>>;
// Plans this frame made, by id: move.start runs the frame's own copy, never the legs, recipients or totals a page
// hands back (it could have edited them after the dialog's numbers were computed). Used once (a 2FA retry of the same start may come back for it), ten minutes.
const plans = new Map<string, { plan: Plan; at: number }>();
const planOf = (p: { planId?: unknown } | null | undefined): Plan => {
  const id = String(p?.planId || ''); const hit = plans.get(id);
  if (!hit || Date.now() - hit.at > 10 * 60_000) throw new Error('This plan is not one the vault made (or it expired) — plan the move again');
  return structuredClone(hit.plan);
};
// jobs started in this tab (their outside legs were confirmed here): outside the vault frame, storage and the
// channel are the page's — a job that arrives through them never sends outside unless it began here
const confirmedJobs = new Set<string>();

async function startMove(plan: Plan, fromBus = false): Promise<{ ok: boolean; id: string }> {
  if (!plan.ok) throw new Error(plan.errors[0] || 'plan is not executable');
  moveLaneCheck((plan as { chain?: unknown }).chain);
  requireUnlocked();
  if (!isRunner && !fromBus) { await ensureRunner().catch(() => {}); }
  if (!isRunner && !fromBus) { const r = await askRunner({ cmd: 'start', plan }).catch(() => null); if (r) return { ok: true, id: r.id }; }
  // F-63 (V12): never create and persist a job as a non-runner (that write would be ignored by saveJobs and the job
  // orphaned). Either this tab is the runner now, or the runner started it above — otherwise ask the user to retry.
  if (!isRunner && !fromBus) throw new Error('Another tab is handling transfers right now — try again in a moment');
  // hop wallets: one chain per source→destination pair, wired into the legs now
  const hopIds: string[] = [];
  if (plan.hops) {
    let n = 0;
    for (let i = 0; i < plan.legs.length; i += 1) {
      const l = plan.legs[i];
      if (!l.hop) continue;
      // a hop leg's `to` is a fresh wallet; the following leg's `from` is that same wallet
      const id = await addAccount(`Hop ${++n} · ${plan.label.replace(/ · .*$/, '')}`, generatePrivateKey(), { hop: true });
      hopIds.push(id);
      const acct = unlocked!.find((a) => a.id === id)!;
      l.to = acct.address;
      const next = plan.legs.find((x) => x.after === l.id); if (next) next.from = acct.address;
    }
    // belt and braces: every hop key must decrypt back from localStorage before anything is sent
    const disk = await decryptStored();
    for (const id of hopIds) {
      const mem = unlocked!.find((a) => a.id === id)!;
      const on = disk?.accounts.find((a) => a.id === id);
      if (!on || on.key !== mem.key || privateKeyToAccount(on.key).address !== mem.address) throw new Error('hop wallet key did not verify on disk — nothing was sent');
    }
  }
  const job: Job = { id: jid('j'), label: plan.label, createdAt: Date.now(), status: 'running', hops: plan.hops, delay: plan.delay, legs: plan.legs, hopIds, asset: plan.asset, chain: MOVE_LANE };
  jobs.push(job); saveJobs();
  if (isRunner) tickJob(job);            // otherwise the runner adopts it from the storage event
  return { ok: true, id: job.id };
}
// F-32 / design(d): a leg goes back to the queue (where it will be SIGNED again) only when that is safe — it failed
// before any signature (no `raw`), or two default nodes proved it dropped. A signed/sent/unknown leg is never
// re-queued (recovery re-broadcasts its SAME bytes). A cancelled job, and any leg cancelled by hand, never resume.
function retryJob(id: string): any {
  const job = jobs.find((j) => j.id === id); if (!job) throw new Error('Unknown job');
  if (job.status === 'cancelled') throw new Error('This move was cancelled — plan it again to send');   // F-32
  if (!isRunner) return ensureRunner().then((mine) => (mine ? retryJob(id) : askRunner({ cmd: 'retry', id })));
  for (const l of job.legs) {
    if (l.error === 'cancelled') continue;                                      // F-32: a hand-cancelled leg never re-queues
    const dropped = l.status === 'failed' && l.error === 'dropped before mining';
    const retryable = (l.status === 'failed' && !l.raw) || dropped || l.status === 'skipped';
    if (retryable) { l.status = 'queued'; delete l.error; delete l.hash; delete l.raw; delete l.notBefore; delete l.nonce; bumpRev(l); }
  }
  job.status = 'running';
  saveJobs();
  tickJob(job);
  return { ok: true };
}
const terminal = (s: LegStatus) => s === 'confirmed' || s === 'failed' || s === 'skipped';
const recovering = (s: LegStatus) => s === 'signed' || s === 'sent' || s === 'unknown';   // persisted, settles by hash, never re-signed
function tickJob(job: Job) {
  if (job.chain !== MOVE_LANE || !MOVE_EVM) return;                 // another lane's job is never driven with this frame's client
  if (job.status === 'done' || job.status === 'failed') return;
  const byId = new Map(job.legs.map((l) => [l.id, l]));
  for (const leg of job.legs) {
    if (leg.status === 'failed' || leg.status === 'skipped') { for (const d of job.legs) if (d.after === leg.id && !terminal(d.status) && !recovering(d.status)) { d.status = 'skipped'; d.error = 'previous hop did not land'; } }
  }
  const inFlightFrom = new Set(job.legs.filter((l) => running.has(l.id)).map((l) => l.from.toLowerCase()));
  for (const leg of job.legs) {
    if (terminal(leg.status) || running.has(leg.id)) continue;
    if (recovering(leg.status) && leg.hash) { running.add(leg.id); recoverLeg(job, leg); continue; }   // re-broadcast same bytes / settle by hash
    if (job.status === 'cancelled') continue;                         // let in-flight legs settle, start nothing new
    if (leg.after && byId.get(leg.after)?.status !== 'confirmed') continue;
    if (inFlightFrom.has(leg.from.toLowerCase())) continue;        // one nonce at a time per wallet
    inFlightFrom.add(leg.from.toLowerCase());
    running.add(leg.id);
    sendLeg(job, leg);
  }
  if (job.legs.every((l) => terminal(l.status))) {
    job.status = job.status === 'cancelled' ? 'cancelled' : job.legs.some((l) => l.status !== 'confirmed') ? 'failed' : 'done';
    saveJobs();
    parkHops(job).catch(() => {});
  }
}
// F-58/F-69/F-22/F-35 (V12): write-ahead signing under the cross-tab lane lock. Sign + PERSIST {signed, raw, hash,
// nonce} BEFORE broadcasting; any error after that is 'unknown' (settles by hash), never a re-signable 'failed'.
async function sendLeg(job: Job, leg: Leg) {
  await laneLock(leg.from, async () => {
    try {
      // hop legs and the final delivery pause a random while, so the chain does not read as one burst
      if (leg.after) {
        if (!leg.notBefore) { const [a, b] = job.delay; leg.notBefore = Date.now() + Math.round((a + Math.random() * Math.max(0, b - a)) * 1000); bumpRev(leg); }
        if (Date.now() < leg.notBefore) { leg.status = 'waiting'; bumpRev(leg); saveJobs(); await new Promise((r) => setTimeout(r, leg.notBefore! - Date.now())); }
      }
      // re-read INSIDE the lock: only a still-queued/waiting leg is signed (a cancel, or another driver, may have moved it)
      if (leg.status !== 'queued' && leg.status !== 'waiting') { running.delete(leg.id); tickJob(job); return; }
      if (!mayDrive()) { running.delete(leg.id); return; }            // F-35: a fenced ex-runner signs nothing
      const acct = unlocked?.find((a) => a.address.toLowerCase() === leg.from.toLowerCase());
      if (!acct) throw new Error('source wallet is not in this vault');
      if (!HOST && !leg.hop && !confirmedJobs.has(job.id) && !isOwn(leg.to)) throw new Error('an outside leg of a job this tab did not confirm — start the move again');
      const account = accountOf(acct);
      const gasPrice = await feeFor(1);
      const nonce = holdNonce(account.address, await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }));   // MEV v2
      let raw: `0x${string}`;
      if (leg.asset.kind === 'eth') {
        await syncEthGas(account.address, leg.to as `0x${string}`);
        const bal = await publicClient.getBalance({ address: account.address });
        const value = leg.amount === 'max' ? bal - gasPrice * ETH_GAS : BigInt(leg.amount);
        if (value <= 0n) throw new Error('nothing left after gas');
        if (bal < value + gasPrice * ETH_GAS) throw new Error(`insufficient ${MOVE_UNIT}: has ${Number(formatEther(bal)).toFixed(5)}, needs ${Number(formatEther(value + gasPrice * ETH_GAS)).toFixed(5)}`);
        leg.human = Number(formatEther(value));
        raw = await account.signTransaction({ to: leg.to, value, gas: ETH_GAS, gasPrice, nonce, account, chainId: chain.id, type: 'legacy' } as any);
      } else {
        const bal = await publicClient.readContract({ address: leg.asset.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
        const value = leg.amount === 'max' ? bal : BigInt(leg.amount);
        if (value <= 0n || bal < value) throw new Error(`insufficient ${leg.asset.symbol}`);
        leg.human = humanOf(value, leg.asset);
        const sim = await publicClient.simulateContract({ account, address: leg.asset.address, abi: ERC20_ABI, functionName: 'transfer', args: [leg.to, value], gasPrice });
        const { account: _a, chain: _c, ...body } = sim.request as Record<string, unknown>;
        raw = await account.signTransaction({ ...body, account, nonce, chainId: chain.id, type: 'legacy' } as any);
      }
      // WRITE-AHEAD: persist the signed bytes + their own hash + the nonce BEFORE broadcasting. If this tab dies now,
      // recovery re-broadcasts this exact `raw` and settles by this hash — it never re-signs, so nothing goes out twice.
      leg.raw = raw; leg.nonce = nonce; leg.hash = keccak256(raw); leg.status = 'signed'; leg.sentAt = Date.now(); bumpRev(leg); saveJobs();
      noteNonceUsed(account.address, nonce);   // the trade lanes' counter steps past this nonce
      try {
        await broadcast(raw, 0, false, { from: account.address, nonce });   // returns the local hash; a node hash != local is an error
        leg.status = 'sent'; bumpRev(leg); saveJobs();
      } catch (e) {
        // Elysium (release #6): the relay's own refusal before any node saw these bytes — a clean, retryable failure (elyNothingSent)
        if (elyNothingSent(e)) { delete leg.raw; delete leg.hash; delete leg.nonce; leg.status = 'failed'; leg.error = shortError(e); leg.doneAt = Date.now(); running.delete(leg.id); nonces.delete(lc(account.address)); bumpRev(leg); saveJobs(); scheduleWatch(50); tickJob(job); return; }
        leg.status = 'unknown'; leg.error = shortError(e); bumpRev(leg); saveJobs();   // F-58/F-69: after persist → unknown, never failed
      }
      await settleLeg(job, leg);
    } catch (e) {
      // reached only BEFORE the bytes were persisted (no `raw`): nothing is on chain — a clean, retryable failure
      if (!leg.raw) { leg.status = 'failed'; leg.error = shortError(e); leg.doneAt = Date.now(); running.delete(leg.id); bumpRev(leg); saveJobs(); scheduleWatch(50); tickJob(job); }
      else { leg.status = 'unknown'; leg.error = shortError(e); bumpRev(leg); saveJobs(); await settleLeg(job, leg); }
    }
  });
}
// recovery of a persisted leg: re-broadcast the SAME bytes once (idempotent — "already known" is success), settle by hash
async function recoverLeg(job: Job, leg: Leg) {
  if (!mayDrive()) { running.delete(leg.id); return; }
  if (leg.raw && (leg.status === 'signed' || leg.status === 'unknown')) {
    await laneLock(leg.from, async () => { try { await broadcast(leg.raw!); } catch {} });
    if (leg.status === 'signed' || leg.status === 'unknown') { leg.status = 'sent'; bumpRev(leg); saveJobs(); }
  }
  await settleLeg(job, leg);
}
// one default node's verdict on a leg: has the wallet's latest nonce passed this leg's, and is the tx definitely gone?
async function nodeSays(url: string, address: `0x${string}`, hash: `0x${string}`, nonce: number): Promise<{ higher: boolean | null; notFound: boolean | null }> {
  try {
    const body = [
      { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: [hash] },
    ];
    const j = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    if (!Array.isArray(j)) return { higher: null, notFound: null };
    const cnt = j.find((x: any) => x?.id === 1); const tx = j.find((x: any) => x?.id === 2);
    if (!cnt || cnt.error || cnt.result == null) return { higher: null, notFound: null };
    const higher = Number(BigInt(cnt.result)) > nonce;
    if (!tx || tx.error) return { higher, notFound: null };   // count known, tx lookup failed: NOT a proof of absence
    return { higher, notFound: tx.result === null };
  } catch { return { higher: null, notFound: null }; }
}
// F-69 / design(c): dropped only when TWO default nodes BOTH show the nonce has passed AND BOTH report not-found.
// A lookup error on either side is not a proof — the leg keeps polling, so a live tx is never declared gone and re-sent.
async function provenDropped(leg: Leg): Promise<boolean> {
  if (leg.nonce == null || !leg.hash) return false;
  if (CFG.key === 'elysium') return elyProvenDropped(leg);
  const urls = DEFAULT_RPCS.filter(isRpcUrl);
  const votes = await Promise.all(urls.map((u) => nodeSays(u, leg.from, leg.hash!, leg.nonce!)));
  return votes.filter((v) => v.higher === true && v.notFound === true).length >= 2;
}
// ── Elysium moves (release #6) ──
// Elysium's two default nodes are ONE road: motion's relay (CFG elysium rpc = rpc2). Two votes of it at the same moment would be
// one answer counted twice (the relay even shares identical reads in flight). The relay itself reads every operator — a nonce only
// when two operators agree, a lookup over every node (null only when none has the tx) — so here a drop is proven by TWO readings
// of it ELY_DROP_RECHECK_MS apart, both "the nonce has passed" AND "no node knows this hash" (a tx in Nitro's delayed inbox is not
// known yet, but then its nonce has not passed either). Anything else keeps the leg polling: never declared gone and re-sent.
const ELY_DROP_RECHECK_MS = 20_000;
async function elyProvenDropped(leg: Leg): Promise<boolean> {
  const url = [...new Set(DEFAULT_RPCS.filter(isRpcUrl))][0]; if (!url) return false;
  const a = await nodeSays(url, leg.from, leg.hash!, leg.nonce!);
  if (!(a.higher === true && a.notFound === true)) return false;
  await new Promise((r) => setTimeout(r, ELY_DROP_RECHECK_MS));
  const b = await nodeSays(url, leg.from, leg.hash!, leg.nonce!);
  return b.higher === true && b.notFound === true;
}
// The relay's refusals BEFORE any node saw the bytes (the trading switch, a nonce only one operator stated, funds two operators agree
// are short: server/elysium-relay.mjs sendOne) end "nothing was sent". When the relay is this frame's only road (no node of the
// user's own in the send list) and every road refused without a lost answer (broadcast's txState 'signed'), those bytes reached no
// node: the leg fails cleanly and may be retried — never an "unknown" that re-broadcasts refused bytes every three minutes.
const elyNothingSent = (e: unknown): boolean => {
  if (CFG.key !== 'elysium') return false;
  const err = e as SendError; const roads = broadcastUrls();
  return err?.txState === 'signed' && /nothing was sent/i.test(String(err?.message || '')) && roads.length === 1 && roads[0] === RPC;
};
async function settleLeg(job: Job, leg: Leg) {
  try {
    const r = await publicClient.waitForTransactionReceipt({ hash: leg.hash!, timeout: 180_000, pollingInterval: 1000 });
    leg.status = r.status === 'success' ? 'confirmed' : 'failed';
    if (r.status !== 'success') leg.error = 'reverted on chain';
  } catch (e) {
    if (await provenDropped(leg)) { leg.status = 'failed'; leg.error = 'dropped before mining'; leg.doneAt = Date.now(); running.delete(leg.id); bumpRev(leg); saveJobs(); tickJob(job); return; }
    running.delete(leg.id); bumpRev(leg); saveJobs();
    setTimeout(() => tickJob(job), 5000);
    return;
  }
  leg.doneAt = Date.now(); running.delete(leg.id); bumpRev(leg); saveJobs();
  scheduleWatch(50);
  tickJob(job);
}
// a hop that ended empty is archived so it stops cluttering the manager; a hop with dust stays visible for sweepHops
async function parkHops(job: Job) {
  if (!job.hopIds.length || !unlocked) return;
  const gasPrice = await feeFor(1);
  for (const id of job.hopIds) {
    const a = unlocked.find((x) => x.id === id); if (!a) continue;
    const bal = await publicClient.getBalance({ address: a.address }).catch(() => 0n);
    if (bal <= gasPrice * ETH_GAS) a.archived = true;
  }
  await persist();
}
async function sweepHops(toId: string, auth?: Auth) {
  const list = requireUnlocked();
  const to = list.find((a) => a.id === toId); if (!to) throw new Error('Unknown target');
  if (!isOwn(to.address)) await outsideOk(to, 'Sweep the hop wallets', auth); else await gate('transfer', auth);
  const gasPrice = await feeFor(1);
  const results: { id: string; address: string; ok: boolean; hash?: string; error?: string; eth?: number }[] = [];
  for (const a of list.filter((x) => x.hop)) {
    const bal = await publicClient.getBalance({ address: a.address }).catch(() => 0n);
    if (bal <= gasPrice * ETH_GAS * 2n) { a.archived = true; continue; }
    try { const h = await sendEth(a.id, to.address, 'max'); results.push({ id: a.id, address: a.address, ok: true, hash: h, eth: Number(formatEther(bal)) }); a.archived = true; }
    catch (e) { results.push({ id: a.id, address: a.address, ok: false, error: shortError(e) }); }
  }
  await persist();
  return { ok: true, results };
}
function cancelJob(id: string): any {
  const job = jobs.find((j) => j.id === id); if (!job) throw new Error('Unknown job');
  if (!isRunner) return ensureRunner().then((mine) => (mine ? cancelJob(id) : askRunner({ cmd: 'cancel', id })));
  for (const l of job.legs) if (l.status === 'queued' || l.status === 'waiting') { l.status = 'skipped'; l.error = 'cancelled'; bumpRev(l); }
  job.status = 'cancelled';
  confirmedJobs.delete(id);        // F-32: a cancelled job's outside legs must not resume on a bus 'start'/retry replay without a fresh confirmOutside
  saveJobs();
  tickJob(job);
  return { ok: true };
}
// Exactly one tab drives the legs. Web Locks hands the role to the next tab
// the moment the holder closes, and that tab resumes every running job from
// storage — money in flight is never orphaned by a closed tab.
async function becomeRunner() {
  isRunner = true;
  bumpEpoch();                                   // F-35: claim a fresh epoch; a later runner that steals the lock bumps past us
  jobs.splice(0, jobs.length, ...readJobs());
  await mergeFromDisk().catch(() => {});
  for (const j of jobs) if (j.status === 'running' || j.status === 'cancelled') tickJob(j);
  emitJobs();
}
ready.then(() => {
  emitJobs();
  if (typeof navigator !== 'undefined' && navigator.locks) navigator.locks.request(RUNNER_LOCK, async () => { await becomeRunner(); await new Promise(() => {}); }).catch(() => { isRunner = false; });   // F-35: lock lost/stolen → stop driving
  else becomeRunner();
});

// ── the human in the loop ──
// A private key leaves the vault, or funds leave it for an address the vault
// does not own, only on a real click — never from a timer, a fetch callback or
// a script that merely runs in this page — and only through a dialog the engine
// draws itself. Buys, sells and moves between the vault's own wallets stay one
// click, and the key is never handed back to whoever called.
// In the vault frame the page's clicks do not count: a cross-origin frame gets
// no user activation from its parent, and no script in the parent can produce
// a trusted click inside it. So every irreversible step (a key on screen, funds
// to an outside address, a wallet removed, a backup written) ends with a button
// in a dialog the frame itself draws, and the dialog accepts only a trusted
// click while it is actually visible on screen (IntersectionObserver v2, where
// the browser has it) — a parent that shrank or covered the frame gets nothing.
const escHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
function copyText(text: string) {
  try { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch {}
  navigator.clipboard?.writeText(text).catch(() => {});
}
let dialogsOpen = 0;
type AskChoice = { id: string; label: string; primary?: boolean; danger?: boolean };
type AskOpts = { title: string; html: string; ok: string; danger?: boolean; guard?: boolean;
  // SEC-5: the dialog hands out a key or sends value out of the vault's control — the typed number in every browser (askChoice);
  // SEC-5b: also the rare identity / node dialogs (Set up this device, A different account signed in, Change network nodes, Start a new vault)
  funds?: boolean; cancel?: boolean; cancelLabel?: string; size?: 'sm' | 'md' | 'lg'; copy?: string; plain?: boolean; foot?: string; choices?: AskChoice[]; validate?: (root: HTMLElement, choice: string) => Promise<string | null> | string | null; stay?: (root: HTMLElement, btn: HTMLButtonElement) => boolean; mount?: (root: HTMLElement) => void; keep?: boolean;
  // run synchronously inside the trusted OK click, before anything is awaited (a WebAuthn ceremony needs the live gesture)
  gesture?: () => void;
  // a numbered flow: "Step 2 of 4" and a thin progress bar above the title (src/passkeyCopy.ts pkStepHtml, in the page's language)
  step?: { n: number; of: number } };
function ask(o: AskOpts): Promise<boolean> { return askChoice(o).then((v) => v === 'ok'); }
// V13 VA-5: IntersectionObserver v2 (`isVisible`) exists in Chromium only. Elsewhere (Safari / the iPhone home-screen app,
// Firefox) a page could make this frame transparent over a decoy button and collect the click; there a danger dialog
// asks for a short number that is drawn only inside the frame (a page cannot read a cross-origin frame, so a decoy has
// nothing to tell the user to type), and every one-click dialog there ignores a click that comes sooner than
// MIN_DWELL_MS after it was drawn. In Chromium the dialog now counts as hidden until the observer's first reading says visible (a
// click in the first ~100 ms used to pass before any reading had arrived).
const IO_V2 = typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;
// (security audit 2026-11-04, SEC-2) where the observer exists, a click counts only once the dialog has been reported visible
// WITHOUT a break for this long. It used to count the moment the dialog turned visible — and a click that came while it was
// still reported hidden was held until a "visible" reading arrived, then taken: a page that kept the frame at opacity 0 over
// a decoy and flipped it to 1 between the two clicks of a double-click (no rect change, so Chrome's own input drop for moved
// frames does not apply) had its "Send everything" clicked. The same 600 ms the other browsers already wait (MIN_DWELL_MS).
const MIN_VISIBLE_MS = 600;
// SEC-5 (security batch 2, 2026-11-04): IntersectionObserver v2 does not see a CSS mask, a clip-path, an overflow:hidden crop or a
// CSS zoom the page puts on this frame (measured in Chrome 156: isVisible stays true). Two answers, neither costs an honest user
// time: (1) the dialogs that hand out a key or send value out of the vault's control ask for the frame-drawn number in Chromium
// too (AskOpts.funds; trade dialogs keep the one click — speed); (2) every dialog checks what the frame CAN see — the observer's
// own intersection (clipped by every ancestor up to the top-level viewport: a clip-path or crop shrinks it, measured), each
// confirm button wholly inside this frame's viewport, the devicePixelRatio (CSS zoom 0.12 on the frame reads 0.12 here), the hit
// target under the click point — over the same 600 ms window. A mask leaves no trace inside the frame: that is what (1) is for.
const GEO_THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1];
const GEO_KEEP = 0.98;      // share of the dialog / button the top-level viewport must show (sub-pixel slack)
const GEO_MIN_DPR = 0.7;    // below it the frame is drawn at < 70 % (CSS zoom, or a browser zoomed far out on a 1x screen)
const GEO_CUT = 'The vault dialog is cut off or partly hidden — show the whole dialog and click again.';
const GEO_OFF = 'The vault\'s button is not fully on screen — bring the whole dialog into view and click again.';
const GEO_SMALL = 'The vault dialog is drawn too small to read — zoom the page back in and click again.';
const GEO_MISS = 'The click did not land on the vault\'s button — click it again.';
type GeoSlot = { read: boolean; bad: string; since: number; io: string; ir: DOMRectReadOnly | null };
const geoSlot = (): GeoSlot => ({ read: false, bad: '', since: -Infinity, io: '', ir: null });
const geoButtons = (dlg: HTMLElement): HTMLElement[] => { try { return [...(dlg.querySelectorAll?.('[data-ok]') || [])] as HTMLElement[]; } catch { return []; } };
const geoView = () => { const w = typeof window !== 'undefined' ? window : null; return { vw: Number(w?.innerWidth), vh: Number(w?.innerHeight), dpr: Number(w?.devicePixelRatio) }; };
// one observer reading of the dialog (button=false) or of a confirm button: '' or why it does not count as shown
function geoEntryProblem(en: IntersectionObserverEntry, button: boolean): string {
  const b = en.boundingClientRect, r = en.intersectionRect, { vw, vh } = geoView();
  if (!b || !r || !(vw > 0) || !(vh > 0) || !(b.width > 0) || !(b.height > 0)) return '';
  const inside = Math.max(0, Math.min(b.right, vw) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0));
  if (button && inside < b.width * b.height * GEO_KEEP) return GEO_OFF;
  return r.width * r.height < inside * GEO_KEEP - 2 ? GEO_CUT : '';
}
// what is looked at every 150 ms (no observer reading comes for these): the zoom, and a button pushed out of this frame's viewport
function geoNow(btn: HTMLElement | null): string {
  const { vw, vh, dpr } = geoView();
  if (dpr > 0 && dpr < GEO_MIN_DPR) return GEO_SMALL;
  const r = btn?.getBoundingClientRect?.();
  if (r && vw > 0 && vh > 0 && r.width > 0 && (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)) return GEO_OFF;
  return '';
}
function geoUpdate(s: GeoSlot, why: string, openedAt: number) {
  if (why && !s.bad) s.since = Infinity;
  if (!why && (s.bad || !s.read)) s.since = s.read ? performance.now() : openedAt;   // a first reading that is fine counts from the opening
  s.bad = why; s.read = true;
}
// the click on a confirm button, against the readings taken BEFORE it: '' or why it does not count
function clickProblem(e: MouseEvent, btn: HTMLElement, slots: GeoSlot[]): string {
  for (const s of slots) { if (!s.read) continue; if (s.bad) return s.bad; if (performance.now() - s.since < MIN_VISIBLE_MS) return 'Read the dialog first, then click again.'; }
  // a pointer click (detail ≥ 1; Enter / Space on the focused button is detail 0): the point is on this button, inside the part of
  // it the top-level viewport shows, and the button is what the frame itself hit-tests there
  if (e.detail > 0 && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    const ir = slots[slots.length - 1]?.ir;
    if (ir && ir.width > 0 && (e.clientX < ir.left - 1 || e.clientX > ir.right + 1 || e.clientY < ir.top - 1 || e.clientY > ir.bottom + 1)) return GEO_MISS;
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(e.clientX, e.clientY) : undefined;
    if (hit !== undefined && !(hit && btn.contains(hit))) return GEO_MISS;
  }
  return '';
}
// the same dialog with several confirm buttons (the recovery screen): each one is a trusted click on a visible dialog; resolves to its id, or null
function askChoice(o: AskOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div'); wrap.className = 'dlg-wrap';
    const code = needsChallenge(HOST, IO_V2, !!(o.danger || o.guard)) ? challengeCode(crypto.getRandomValues(new Uint8Array(2))) : '';
    // SEC-5: a dialog that hands out a key or sends value out of the vault's control asks for the number in EVERY browser — in
    // Chromium too, where the observer cannot see a mask / clip / zoom the page puts on the frame (a decoy has no number to show)
    const fcode = !code && HOST && o.funds ? challengeCode(crypto.getRandomValues(new Uint8Array(2))) : '';
    const shown = code || fcode;
    const challenge = shown ? `<label class="dlg-f-row dk-code">Type <b translate="no">${shown}</b> to confirm<input type="text" id="dk-code" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="6" /></label>` : '';
    const buttons = o.choices?.length
      ? o.choices.map((c) => `<button class="dlg-btn${c.primary ? ' primary' : ''}${c.danger ? ' danger' : ''}" data-ok="${escHtml(c.id)}">${escHtml(c.label)}</button>`).join('')
      : `<button class="dlg-btn primary${o.danger ? ' danger' : ''}" data-ok>${escHtml(o.ok)}</button>`;
    // the width is a class: the frame's CSP (style-src 'self') ignores inline style attributes, an inline width left the dialog full-window
    wrap.innerHTML = `<div class="dlg w-${o.size || 'md'}${o.plain ? ' plain' : ''}${o.choices?.length ? ' multi' : ''}" role="dialog"><div class="dlg-h">${o.step ? `<div class="dk-head">${pkStepHtml(o.step, uiLang())}` : ''}<h3>${escHtml(o.title)}<span class="dk-lock" role="img" aria-label="${SEC_LABEL}" title="${SEC_LABEL}">${LOCK_SVG}</span></h3>${o.step ? '</div>' : ''}<button class="dlg-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="dlg-b">${o.html}${challenge}<div class="dlg-err" hidden></div></div><div class="dlg-f">${buttons}${o.cancel === false || !o.cancelLabel || o.cancelLabel === 'Cancel' ? '' : `<button class="dlg-btn" data-no>${escHtml(o.cancelLabel)}</button>`}${o.foot || ''}</div></div>`;
    const dlg = wrap.querySelector('.dlg') as HTMLElement;
    try { o.mount?.(dlg); } catch {}
    if (o.keep) readStorageAccess();   // known before the click, so the click itself only has to call (no await in the gesture)
    const err = wrap.querySelector('.dlg-err') as HTMLElement;
    let visible = !(HOST && IO_V2), io: IntersectionObserver | null = null;
    let visibleSince = visible ? -Infinity : Infinity;   // SEC-2: when the current unbroken "visible" stretch began
    let openedAt = Infinity;   // set once the dialog is in the document (below)
    // SEC-5 frame-level geometry (no wait for an honest user: the same 600 ms window as SEC-2, from the first reading): what the
    // observer's own intersection says the TOP-LEVEL viewport shows of the dialog and of each confirm button (a clip-path or an
    // overflow:hidden box around the frame shrinks it), the buttons inside this frame's viewport (a frame too small for its
    // dialog), and this frame's devicePixelRatio (a CSS zoom on the frame shows here: zoom 0.12 → 0.12)
    const geoDlg = geoSlot(), geoBtn = new Map<unknown, GeoSlot>();
    let geoTick: ReturnType<typeof setInterval> | undefined;
    const geoRead = (en: IntersectionObserverEntry) => {
      const isBtn = en.target != null && en.target !== dlg;
      const s = isBtn ? (geoBtn.get(en.target) || (geoBtn.set(en.target, geoSlot()), geoBtn.get(en.target)!)) : geoDlg;
      s.io = geoEntryProblem(en, isBtn); s.ir = isBtn ? en.intersectionRect : null;
      geoUpdate(s, s.io || geoNow(isBtn ? en.target as HTMLElement : null), openedAt);
      // the readings come only when a threshold is crossed: zoom and the frame's own size are looked at every 150 ms too (while open)
      if (!geoTick) geoTick = setInterval(geoAgain, 150);
    };
    const geoAgain = () => { if (geoDlg.read) geoUpdate(geoDlg, geoDlg.io || geoNow(null), openedAt); for (const [b, s] of geoBtn) geoUpdate(s, s.io || geoNow(b as HTMLElement), openedAt); };
    dialogsOpen += 1; post({ t: 'dialog', open: true });
    const close = (v: string | null) => {
      wrap.remove(); document.removeEventListener('keydown', onKey); io?.disconnect(); clearInterval(geoTick);
      dialogsOpen -= 1;
      // two dialogs in a row (confirm, then the key) keep the frame on screen: hiding it in between would leave the second one invisible to the observer for a moment
      setTimeout(() => { if (!dialogsOpen) post({ t: 'dialog', open: false }); }, 80);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    const fail = (msg: string) => { err.textContent = msg; err.hidden = false; };
    wrap.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      if (t === wrap || t.closest('[data-x]') || t.closest('[data-no]')) { close(null); return; }
      const okBtn = t.closest('[data-ok]') as HTMLButtonElement | null;
      if (okBtn) {
        const choice = okBtn.dataset.ok || 'ok';
        if (!e.isTrusted) return;                                   // a synthetic click confirms nothing
        // V13 VA-5: where the frame cannot see whether it is covered (no IntersectionObserver v2), a one-click dialog ignores
        // a click in its first 600 ms (one the user types into cannot be confirmed blind anyway; Chromium checks visibility)
        if (HOST && !IO_V2 && !dlg.querySelector('input, textarea') && tooSoon(openedAt, performance.now())) { fail('Read the dialog first, then click again.'); return; }
        if (code && !challengeOk((dlg.querySelector('#dk-code') as HTMLInputElement | null)?.value, code)) { fail(`Type ${code} in the box to confirm.`); return; }
        if (fcode && !challengeOk((dlg.querySelector('#dk-code') as HTMLInputElement | null)?.value, fcode)) { fail(`Type ${fcode} in the box to confirm.`); return; }
        // SEC-5: the click must land on this button (from inside the frame: the hit target at the click point), and the dialog
        // must have been shown whole, unclipped and readable for the same 600 ms (decided on readings before this click)
        if (HOST) { const why = clickProblem(e, okBtn, [geoDlg, geoBtn.get(okBtn) || geoSlot()]); if (why) { fail(why); return; } }
        // SEC-2: decided on what the observer said BEFORE this click (never a reading that arrives after it), before the gesture
        if (HOST && IO_V2 && !visible) { fail('The vault dialog is covered or off screen — bring it into view and click again.'); return; }
        if (HOST && IO_V2 && performance.now() - visibleSince < MIN_VISIBLE_MS) { fail('Read the dialog first, then click again.'); return; }
        // an account dialog (keep): ask to keep this frame's storage — synchronously, while the gesture is live (see keepStorage)
        if (o.keep) keepStorage();
        if (o.gesture) { try { o.gesture(); } catch {} }
        if (HOST && !visible) { fail('The vault dialog is covered or off screen — bring it into view and click again.'); return; }
        if (o.validate) { const m = await o.validate(dlg, choice); if (m) { fail(m); return; } }
        if (o.stay && o.stay(dlg, okBtn)) return;   // e.g. the key was just revealed in place; the same button now closes
        close(choice); return;
      }
      const c = t.closest('[data-copy]') as HTMLElement | null;
      const val = c ? c.dataset.copy || o.copy : '';
      if (c && val && e.isTrusted) {
        copyText(val);
        if (c.classList.contains('pk-cp') && !c.textContent) { c.classList.add('ok'); setTimeout(() => c.classList.remove('ok'), 1200); }
        else { c.textContent = c.dataset.copied || 'Copied'; setTimeout(() => { c.textContent = c.dataset.label || 'Copy'; }, 1200); }
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap); openedAt = performance.now();
    if (HOST && 'IntersectionObserver' in window) {
      try { io = new IntersectionObserver((es) => {
        for (const en of es) {
          // SEC-5: the same readings carry the geometry (v1: every browser with the observer) — the dialog and each confirm button
          if (en?.intersectionRect) geoRead(en);
          if ((en.target == null || en.target === dlg) && 'isVisible' in en) { const v = (en as IntersectionObserverEntry & { isVisible: boolean }).isVisible; if (v && !visible) visibleSince = performance.now(); if (!v) visibleSince = Infinity; visible = v; }
        }
      }, { threshold: GEO_THRESHOLDS, trackVisibility: true, delay: 100 } as IntersectionObserverInit); io.observe(dlg); for (const b of geoButtons(dlg)) io.observe(b); } catch {}
    }
  });
}
const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
// ── the dialog kit (vault.css .dk-*), v2 2026-10-19 after the owner's review: one sheet and nothing boxed inside it ──
// A title (the only large text), one muted line under it, "Signed in as 0x…" for the account, wallets as one plain list
// (name · short mono address, hairline between rows), calm muted text instead of warning boxes, one primary button and
// text buttons. No badges, no uppercase labels, no icons in rows. Tapping a row (or "Signed in as") opens the full address
// inline, grouped by four, with a "Copy" text button (<details>: no script, works under the frame's CSP). An address that
// funds go to outside the vault is always printed in full. The frame's promise ("a script on the page cannot click this
// button") is the label and tooltip of a small lock next to the title — the trusted click and visibility check are unchanged.
const SEC_LABEL = 'A script on the page cannot click this button.';
const shortAddr = (a: string, head = 6, tail = 6) => { const s = String(a || ''); return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`; };
const groupsOf = (a: string) => { const s = String(a || ''); const pre = /^0x/i.test(s) ? s.slice(0, 2) : ''; return (pre ? `<span class="g p">${escHtml(pre)}</span>` : '') + (s.slice(pre.length).match(/.{1,4}/g) || []).map((g) => `<span class="g">${escHtml(g)}</span>`).join(''); };
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>';
const copyBtn = (address: string) => `<button type="button" class="dk-cp" data-copy="${escHtml(address)}" aria-label="Copy the full address">Copy</button>`;
const fullAddr = (address: string) => `<div class="dk-full"><span class="dk-hex" translate="no">${groupsOf(address)}</span>${copyBtn(address)}</div>`;
const addrRow = (name: string, address: string) => `<details class="dk-row"><summary><span class="dk-nm">${escHtml(name || 'Wallet')}</span><span class="dk-sh" translate="no">${escHtml(shortAddr(address))}</span></summary>${fullAddr(address)}</details>`;
const addrRows = (xs: { name: string; address: string }[], max = 12) => `<div class="dk-list">${xs.slice(0, max).map((x) => addrRow(x.name, x.address)).join('')}${xs.length > max ? `<p class="dk-more">and ${xs.length - max} more</p>` : ''}</div>`;
const signedIn = (address: string, label = 'Signed in as') => `<details class="dk-who"><summary>${escHtml(label)} <span class="dk-sh" translate="no">${escHtml(shortAddr(address))}</span></summary>${fullAddr(address)}</details>`;
const destBox = (address: string) => `<div class="dk-dest"><span class="dk-hex big" translate="no">${groupsOf(address)}</span>${copyBtn(address)}</div>`;
const sub = (html: string) => `<p class="dk-sub">${html}</p>`;
const muted = (html: string) => `<p class="dk-muted">${html}</p>`;
// the USD balance dialogs' table and folded consent (floatCore FLOAT_DLG_RULES, the .ub-* classes): the engine brings
// these rules itself, through the CSSOM — a constructed sheet, or vault.css's own sheet where constructed sheets are
// missing — which the frame's style-src 'self' allows (an inline <style> it refuses). The pinned page stays as it is.
function dialogCss() {
  if (typeof document === 'undefined') return;
  try { const s = new CSSStyleSheet(); s.replaceSync(FLOAT_DLG_RULES.join('\n') + '\n' + PK_DLG_RULES.join('\n')); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; return; } catch { /* below */ }
  try {
    const sh = [...document.styleSheets].find((x) => { try { return !!x.cssRules; } catch { return false; } });
    if (sh) for (const r of [...FLOAT_DLG_RULES, ...PK_DLG_RULES]) { try { sh.insertRule(r, sh.cssRules.length); } catch { /* a rule this browser cannot parse */ } }
  } catch { /* no sheet: the dialog still reads, unstyled */ }
}
dialogCss();
const recognizeAll = (n: number) => (n <= 1 ? 'this wallet' : n === 2 ? 'both wallets' : n === 3 ? 'all three wallets' : `all ${n} wallets`);
const RECOVERY_TRADEOFF = 'Your wallets become as safe as your sign-in (email, Google or passkey, plus 2FA). You can turn this off in Wallets.';
const PK_WARN = '<p class="pk-warn">Anyone with this key controls the wallet. Never share it, and store it somewhere only you can open.</p>';
// The key is not even in the document until the button is clicked: what shows
// behind the blur is a row of dots, and the copy icon copies nothing before that.
const pkBox = (value: string, opts: { copy?: string; key?: boolean; title: string }) => `<div class="pk-box"><span class="pk-v${opts.key ? ' pk-key blur' : ''}"${opts.key ? ' data-key' : ''}>${escHtml(value)}</span><button type="button" class="pk-cp"${opts.copy ? ` data-copy="${escHtml(opts.copy)}"` : opts.key ? ' data-copy-key' : ''} aria-label="${escHtml(opts.title)}">Copy</button></div>`;
const reveal = (root: HTMLElement, btn: HTMLButtonElement, secret: string) => {
  if (root.dataset.revealed) return false;
  root.dataset.revealed = '1';
  const el = root.querySelector('[data-key]') as HTMLElement; el.textContent = secret; el.classList.remove('blur');
  const cp = root.querySelector('[data-copy-key]') as HTMLElement | null; if (cp) cp.dataset.copy = secret;
  btn.textContent = 'Close';
  return true;
};
const _secretHtml = (note: string, lines: string[]) => `<p class="dlg-note">${escHtml(note)}</p><div class="dlg-secret"><code>${escHtml(lines.join('\n'))}</code><button class="dlg-btn" data-copy>Copy</button></div>`;
// ── backup & restore: one encrypted file under a passphrase only the user knows ──
// The file carries every key of the vault, AES-GCM-256 under a key derived from
// the passphrase with PBKDF2-SHA-256 (600 000 rounds, random salt). It is
// produced and downloaded inside the vault frame — the passphrase is typed into
// the frame and never reaches the page. The same file restores the wallets in
// any browser, on any device, with the passphrase; nothing else can open it.
const BACKUP_ROUNDS = 600_000;
async function passKey(pass: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
type BackupFile = { v: 1; kind: 'copytrade-vault-backup' | 'motion-vault-backup'; createdAt: number; chain?: string; addresses: { name: string; address: string }[]; kdf: { name: 'PBKDF2'; hash: 'SHA-256'; rounds: number; salt: string }; iv: string; ct: string };
async function makeBackup(pass: string): Promise<BackupFile> {
  // L3: a backup file carries the wallets, never the perps API key (Account.lt): a restored wallet registers a new one
  requireUnlocked(); const list = allAccounts().map(({ lt: _lt, ...a }) => a);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passKey(pass, salt, BACKUP_ROUNDS);
  const body = JSON.stringify({ accounts: list, meta, settings: loadSettings(), seeds });
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(enc.encode(body))));
  return { v: 1, kind: 'copytrade-vault-backup', createdAt: Date.now(), chain: CFG.key, addresses: list.map((a) => ({ name: a.name, address: a.address })), kdf: { name: 'PBKDF2', hash: 'SHA-256', rounds: BACKUP_ROUNDS, salt: b64(salt) }, iv: b64(iv), ct: b64(ct) };
}
async function openBackup(file: BackupFile, pass: string): Promise<{ accounts: Account[]; meta?: VaultMeta; settings?: Partial<Settings>; seeds?: Record<string, string> }> {
  if (!file || (file.kind !== 'copytrade-vault-backup' && file.kind !== 'motion-vault-backup') || file.v !== 1) throw new Error('Not a copytrade vault backup');
  // the rounds come from the file: a tiny count is a file anyone could brute-force, a huge one freezes the frame
  const rounds = Number(file.kdf?.rounds) || BACKUP_ROUNDS;
  if (!(rounds >= 100_000 && rounds <= 5_000_000)) throw new Error('This backup uses an unsupported key-derivation setting');
  const key = await passKey(pass, unb64(file.kdf.salt), rounds);
  let plain: string;
  try { plain = dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64(file.iv)) }, key, buf(unb64(file.ct)))); } catch { throw new Error('Wrong password for this file'); }
  return JSON.parse(plain);
}
// wallets from a backup or from the old in-page vault join this one: by address, never twice, never dropping anything already here
async function adoptAccounts(src: { accounts: Account[]; meta?: VaultMeta; settings?: Partial<Settings>; seeds?: Record<string, string> }) {
  requireUnlocked(); const list = allAccounts();
  let added = 0;
  for (const [m, sd] of Object.entries(src.seeds || {})) if (/^0x[0-9a-f]{40}$/.test(m) && /^0x[0-9a-f]{64}$/.test(String(sd)) && !seeds[m]) seeds[m] = String(sd);
  // V12 F-28: carry the stored main-wallet signatures (ms:<main>) too, so phone access can be re-sealed after a file
  // restore without a second signature. Harmless if stale: mainSigFor re-verifies each against the local seed before use.
  for (const [k, v] of Object.entries(src.seeds || {})) if (/^ms:0x[0-9a-f]{40}$/.test(k) && /^0x[0-9a-fA-F]{130}$/.test(String(v)) && !hasOwn(seeds, k)) seeds[k] = String(v);
  // the salts of the device that wrote the backup: its v2 profile blobs open here too (ours stays ours)
  adoptSalts(Object.entries(src.seeds || {}).filter(([k]) => k === SALT || k.startsWith(SALT + ':')).map(([, sd]) => String(sd)));
  for (const a of src.accounts || []) {
    if (!storableKey(a.key)) continue;
    const acct = { address: keyAddress(a.key) };
    if (allAccounts().some((x) => same(x.address, acct.address))) continue;
    const id = a.id && !allAccounts().some((x) => x.id === a.id) ? a.id : 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    (hereOk(a) ? requireUnlocked() : parked).push({ id, name: String(a.name || '').trim() || nextName('Imported'), address: acct.address, key: a.key, createdAt: Number(a.createdAt) || Date.now(), ...(a.archived ? { archived: true } : {}), ...(a.hop ? { hop: true } : {}), ...(a.main && a.index != null ? { main: lc(a.main), index: Number(a.index) } : {}), ...(a.gen === 2 ? { gen: 2 as const } : {}), ...(a.kind === 'created' || a.kind === 'imported' ? { kind: a.kind } : {}) });
    if (!a.hop) { if (!meta.activeAccountId && hereOk(a)) meta.activeAccountId = id; if (!meta.selectedAccountIds.includes(id) && src.meta?.selectedAccountIds?.includes(a.id)) meta.selectedAccountIds.push(id); }
    meta.order.push(id); added += 1;
  }
  if (src.meta?.activeAccountId && requireUnlocked().some((x) => x.id === src.meta!.activeAccountId) && !requireUnlocked().some((x) => x.id === meta.activeAccountId)) meta.activeAccountId = src.meta.activeAccountId;
  if (src.settings && typeof src.settings === 'object') saveSettings(src.settings);
  if (added) meta.changedAt = Date.now();
  await persist();
  return added;
}
const passField = (id: string, label: string) => `<label class="dlg-f-row">${escHtml(label)}<input type="password" id="${id}" autocomplete="new-password" spellcheck="false" /></label>`;
// a password field with a live strength meter, a character count, caps-lock hint and show/hide — the dialog's copy
// already says "a password, not a seed phrase"; this just makes it feel safe to fill. Pure UI; the gate is validate().
const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const passStrong = (id: string, label: string, min = 12) => `<label class="dlg-f-row pw-row" data-row="${id}">${escHtml(label)}<span class="pw-in"><input type="password" id="${id}" autocomplete="new-password" spellcheck="false" /><button type="button" class="pw-eye" data-eye="${id}" aria-label="Show password" tabindex="-1">${EYE_SVG}</button></span></label><div class="pw-meter" data-meter="${id}"><i></i></div><div class="pw-help" data-help="${id}"><span class="pw-msg">Use at least ${min} characters.</span><span class="pw-cc">0 / ${min}</span></div><div class="pw-caps" data-caps="${id}" hidden>Caps Lock is on</div>`;
const pwScore = (v: string, min: number) => { let n = 0; if (v.length >= min) n += 1; if (v.length >= 16) n += 1; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) n += 1; if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) n += 1; return Math.min(4, n); };
function wirePwDialog(root: HTMLElement, min = 12) {
  const p1 = root.querySelector('#bk-p1') as HTMLInputElement, p2 = root.querySelector('#bk-p2') as HTMLInputElement;
  const get = (sel: string) => root.querySelector(sel) as HTMLElement | null;
  const paintStrength = () => {
    const v = p1.value, n = v.length, meter = get('[data-meter="bk-p1"]'), help = get('[data-help="bk-p1"]');
    const msg = help?.querySelector('.pw-msg') as HTMLElement | null, cc = help?.querySelector('.pw-cc') as HTMLElement | null;
    if (meter) meter.className = 'pw-meter s' + (n ? pwScore(v, min) : 0);
    if (cc) cc.textContent = Math.min(n, min) + ' / ' + min;
    if (help && msg) { if (!n) { help.className = 'pw-help'; msg.textContent = `Use at least ${min} characters.`; } else if (n < min) { help.className = 'pw-help bad'; msg.textContent = `needs ${min - n} more character${min - n === 1 ? '' : 's'}`; } else { const sc = pwScore(v, min); help.className = 'pw-help ok'; msg.textContent = sc >= 4 ? 'Strong password' : sc >= 3 ? 'Good password' : 'Password long enough'; } }
  };
  const paintMatch = () => {
    const help = get('[data-help="bk-p2"]'); if (!help) return;
    const msg = help.querySelector('.pw-msg') as HTMLElement | null, cc = help.querySelector('.pw-cc') as HTMLElement | null;
    const b = p2.value; if (cc) cc.textContent = Math.min(b.length, min) + ' / ' + min;
    if (!b) { help.className = 'pw-help'; if (msg) msg.textContent = 'Repeat the password.'; return; }
    if (p1.value === b) { help.className = 'pw-help ok'; if (msg) msg.textContent = 'Passwords match'; }
    else { help.className = 'pw-help bad'; if (msg) msg.textContent = "Passwords don't match"; const row = get('[data-row="bk-p2"]'); if (row && p1.value.length <= b.length) { row.classList.remove('pw-shake'); void row.offsetWidth; row.classList.add('pw-shake'); } }
  };
  const caps = (id: string) => (e: KeyboardEvent) => { const c = get(`[data-caps="${id}"]`); if (c) c.hidden = !(typeof e.getModifierState === 'function' && e.getModifierState('CapsLock')); };
  p1.addEventListener('input', () => { paintStrength(); paintMatch(); });
  p2.addEventListener('input', paintMatch);
  for (const [inp, id] of [[p1, 'bk-p1'], [p2, 'bk-p2']] as [HTMLInputElement, string][]) { const h = caps(id); inp.addEventListener('keyup', h); inp.addEventListener('keydown', h); inp.addEventListener('blur', () => { const c = get(`[data-caps="${id}"]`); if (c) c.hidden = true; }); }
  root.addEventListener('click', (e) => { const btn = (e.target as HTMLElement).closest('[data-eye]') as HTMLElement | null; if (!btn) return; const inp = root.querySelector('#' + btn.dataset.eye) as HTMLInputElement | null; if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; btn.classList.toggle('on', inp.type === 'text'); } });
  paintStrength();
}
async function backupDialog() {
  requireUnlocked(); const list = allAccounts().filter((a) => !a.ext); if (!list.length) throw new Error('No local wallets to back up (Privy wallets are recovered through your Privy login)');
  let pass = '';
  const ok = await ask({
    title: 'Back up the vault', ok: 'Download backup', size: 'md',
    html: `<p>One encrypted file with the keys of <b>${list.length}</b> wallet${list.length === 1 ? '' : 's'}. It opens only with the password you set here — there is no reset, no recovery and nobody who can help if it is lost. Keep the file and the password apart.</p>${passStrong('bk-p1', 'Create a password for this file — at least 12 characters (not a seed phrase)')}${passStrong('bk-p2', 'Repeat the password')}`,
    mount: (root) => wirePwDialog(root),
    validate: (root) => {
      const p1 = (root.querySelector('#bk-p1') as HTMLInputElement).value, p2 = (root.querySelector('#bk-p2') as HTMLInputElement).value;
      if (p1.length < 12) return 'Use at least 12 characters.';
      if (p1 !== p2) return 'The two passwords differ.';
      pass = p1; return null;
    },
  });
  if (!ok) throw new Error('Cancelled');
  const file = await makeBackup(pass); pass = '';
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `copytrade-vault-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  meta.backedUpAt = Date.now(); await persist();
  return { ok: true, wallets: list.length, backedUpAt: meta.backedUpAt };
}
async function restoreDialog() {
  await ready;
  let parsed: { accounts: Account[]; meta?: VaultMeta; settings?: Partial<Settings> } | null = null;
  let fileAt = 0;
  const ok = await ask({
    title: 'Restore from a backup', ok: 'Restore', size: 'md',
    html: `${keyMissing ? '<p class="dlg-note">The vault this browser holds cannot be opened here (its key is missing). It stays stored, untouched, under a dated name; the wallets from the file go into a new vault.</p>' : ''}<p>Pick a <code>copytrade-vault-*.json</code> file (older <code>motion-vault-*.json</code> files open too) and type the password you set for it when you backed up. Wallets already in this vault are kept; the ones from the file are added.</p><label class="dlg-f-row">Backup file<span class="pick" id="rs-pick"><input type="file" id="rs-f" class="vh" accept=".json,application/json" /><span class="pick-btn">Choose file</span><span class="pick-name">No file chosen</span></span></label>${passField('rs-p', 'Password of this file — the one you set when backing up (not a seed phrase)')}`,
    mount: (root) => {
      const input = root.querySelector('#rs-f') as HTMLInputElement, pick = root.querySelector('#rs-pick') as HTMLElement, name = root.querySelector('#rs-pick .pick-name') as HTMLElement;
      const show = () => { const f = input.files?.[0]; pick.classList.toggle('has', !!f); name.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : 'No file chosen'; };
      input.addEventListener('change', show);
      for (const ev of ['dragenter', 'dragover']) pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.add('drag'); });
      for (const ev of ['dragleave', 'drop']) pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.remove('drag'); if (ev === 'drop' && (e as DragEvent).dataTransfer?.files?.length) { input.files = (e as DragEvent).dataTransfer!.files; show(); } });
    },
    validate: async (root) => {
      const f = (root.querySelector('#rs-f') as HTMLInputElement).files?.[0]; const pass = (root.querySelector('#rs-p') as HTMLInputElement).value;
      if (!f) return 'Choose the backup file.';
      if (!pass) return 'Type the password of this file.';
      let file: BackupFile;
      try { file = JSON.parse(await f.text()); } catch { return 'That file is not a copytrade vault backup.'; }
      try { parsed = await openBackup(file, pass); } catch (e) { return (e as Error).message; }
      fileAt = Number(file.createdAt) || 0;
      return null;
    },
  });
  if (!ok || !parsed) throw new Error('Cancelled');
  // the file opened: only now may a vault without its key make way (copied aside first, inside the key lock)
  if (keyMissing) await startFresh();
  const fromFile = (parsed as { accounts: Account[] }).accounts || [];
  const added = await adoptAccounts(parsed);
  // the user holds this file: it counts as a backup of what it carries (a wallet that is not in it still prompts)
  const have = (a: Account) => { try { return allAccounts().some((x) => same(x.address, keyAddress(a.key))); } catch { return false; } };
  const inFile = new Set(fromFile.map((a) => { try { return lc(keyAddress(a.key)); } catch { return ''; } }));
  if (fileAt && fromFile.every(have) && allAccounts().every((x) => x.ext || inFile.has(lc(x.address)))) { meta.backedUpAt = Math.max(meta.backedUpAt || 0, Math.min(fileAt, Date.now())); await persist(); }
  pushBackupState();
  return { ok: true, added, ...summary() };
}
// ── import a key typed INSIDE the frame (2026-10-19, the mobile app's Add wallet; the classic site's paste field stays) ──
// The page or the app only asks for this dialog and gets the new wallet(s) back (id, name, chain, address) or 'Cancelled':
// the key is pasted here, read here (importKey.ts readKey), stored here and never crosses postMessage. One field, one
// primary button. It recognises an EVM key, a Solana secret key (Phantom base58 / solana-keygen bytes), a NEAR secret key
// (ed25519:…) and a recovery phrase (the first EVM, Solana and NEAR account the common wallets derive — the user keeps
// the ones they use). A Solana or NEAR key becomes a wallet of that chain only (nativeKeys.ts: shown and traded on its
// own lane, parked on the others). A NEAR key of a NAMED account (alice.near) needs that name; the frame asks the NEAR
// network whether the key is a full-access key of it before anything is added. The import is the trusted click on Import
// while the dialog is visible; every wallet joins the account backup like a created one (kind 'imported').
async function importKeyDialog() {
  await ready;
  requireUnlocked();
  let chosen: KeyCandidate[] = [];
  const held = (c: KeyCandidate) => { try { return allAccounts().some((a) => same(a.address, keyAddress(c.key))); } catch { return false; } };
  const what = (c: KeyCandidate) => `${CHAIN_LABEL[c.chain]} · ${shortAddr(c.address)}`;
  const ok = await ask({
    title: 'Import a private key', ok: 'Import wallet', size: 'md',
    html: `${sub('Paste it here, inside the vault. The page and the app never see it.')}<label class="dlg-f-row">Private key or recovery phrase<input type="text" id="ik-k" class="dk-key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" aria-describedby="ik-msg" /></label><p class="dk-muted" id="ik-msg" aria-live="polite">${escHtml(KEY_TEXT.empty)}</p><div class="dk-list" id="ik-out" hidden></div><label class="dlg-f-row" id="ik-near-row" hidden>NEAR account name, if it has one<input type="text" id="ik-near" placeholder="alice.near" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" /></label>${muted('It joins your vault and your account backup. Import only a key you control.')}`,
    mount: (root) => {
      const input = root.querySelector('#ik-k') as HTMLInputElement, out = root.querySelector('#ik-out') as HTMLElement, msg = root.querySelector('#ik-msg') as HTMLElement, nearRow = root.querySelector('#ik-near-row') as HTMLElement;
      const nearShown = () => { const r = readKey(input.value); nearRow.hidden = !r.candidates.some((c, i) => c.chain === 'near' && !held(c) && (r.kind !== 'seed' || (root.querySelector(`[data-ik="${i}"]`) as HTMLInputElement | null)?.checked)); };
      // one message at a time: the live line, or the error the Import click raised (until the field changes)
      const paint = () => {
        const r = readKey(input.value), cs = r.candidates;
        msg.hidden = false; const err = root.querySelector('.dlg-err') as HTMLElement | null; if (err) err.hidden = true;
        msg.textContent = !cs.length ? KEY_TEXT[r.kind] : r.kind === 'seed' ? KEY_TEXT.seed : held(cs[0]) ? 'This wallet is already in your vault.' : `${KEY_TEXT[r.kind]} · ${shortAddr(cs[0].address)}`;
        out.hidden = !cs.length;
        // a phrase: one row per chain it opens, ticked (the ones already here are shown, not ticked); a key: its address
        out.innerHTML = r.kind === 'seed'
          ? cs.map((c, i) => `<label class="dk-pick"><input type="checkbox" data-ik="${i}"${held(c) ? ' disabled' : ' checked'} /><span class="dk-nm">${escHtml(CHAIN_LABEL[c.chain])}${held(c) ? ' · in your vault' : ''}</span><span class="dk-sh" translate="no">${escHtml(shortAddr(c.address))}</span></label>`).join('')
          : cs.map((c) => addrRow(`${CHAIN_LABEL[c.chain]} wallet`, c.address)).join('');
        nearShown();
      };
      input.addEventListener('input', paint);
      out.addEventListener('change', nearShown);
      setTimeout(() => { try { input.focus(); } catch {} }, 60);
    },
    validate: async (root) => {
      const hide = (m: string) => { (root.querySelector('#ik-msg') as HTMLElement).hidden = true; return m; };
      const r = readKey((root.querySelector('#ik-k') as HTMLInputElement).value);
      if (!r.candidates.length) return hide(KEY_TEXT[r.kind]);
      const picked = r.kind === 'seed' ? r.candidates.filter((_, i) => (root.querySelector(`[data-ik="${i}"]`) as HTMLInputElement | null)?.checked) : r.candidates;
      const fresh = picked.filter((c) => !held(c));
      if (!fresh.length) return hide(r.kind === 'seed' && !picked.length ? 'Tick at least one wallet.' : 'This wallet is already in your vault.');
      // a NEAR key of a named account: the name, checked against the network (a full-access key of THAT account)
      const name = String((root.querySelector('#ik-near') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
      const out: KeyCandidate[] = [];
      for (const c of fresh) {
        if (c.chain !== 'near' || !name) { out.push(c); continue; }
        if (!NEAR_NAMED.test(name)) return hide('That is not a NEAR account name (like alice.near).');
        let full = false;
        try { full = await nearFullAccess(name, nearPublicKey(c.key)); } catch { return hide(`Could not check ${name} on the NEAR network. Try again in a moment.`); }
        if (!full) return hide(`This key is not a full-access key of ${name}.`);
        const named = `${c.key}:${name}`;
        if (held({ ...c, key: named })) return hide('This wallet is already in your vault.');
        out.push({ ...c, key: named, address: nativeAddress(named) });
      }
      chosen = out; return null;
    },
  });
  if (!ok || !chosen.length) { chosen = []; throw new Error('Cancelled'); }
  const added: { id: string; name: string; chain: KeyCandidate['chain']; address: string }[] = [];
  try {
    for (const c of chosen) {
      const name = nextName('Imported');
      const id = await addAccount(name, c.key as `0x${string}`, { kind: 'imported' });
      added.push({ id, name, chain: c.chain, address: c.address });
    }
  } finally { chosen = []; }
  const first = added[0];
  const here = requireUnlocked().find((x) => x.id === first.id);
  return { ...summary(), ok: true, id: first.id, name: first.name, chain: first.chain, address: here ? (SOL_MODE ? (solAddressOf(here) || first.address) : NEAR_MODE ? (nearAccountId(here) || first.address) : first.address) : first.address, evm: first.chain === 'evm' ? first.address : '', wallets: added, label: added.map((w) => what({ chain: w.chain, key: '', address: w.address })).join(', ') };
}
// ── recovery: the stored vault has no key in this browser, or wallets of a set-aside vault are not back yet ──
// Drawn by the frame; every way out is a trusted click here. Nothing in this screen deletes anything.
const addrList = (xs: { name: string; address: string }[]) => addrRows(xs);
const stampText = (s: string) => { const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[1]} ${m[2]}:${m[3]} UTC` : s; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
async function recoverDialog() {
  await ready;
  if (keyMissing) {
    const n = keyMissing.addresses.length;
    const choice = await askChoice({
      title: 'Your vault key is missing', ok: '', size: 'lg', cancelLabel: 'Later',
      html: `<p>This browser still holds your vault — <b>${plural(n, 'wallet')}</b>, encrypted and untouched — but the key that opens it is gone from this browser's storage. Browsers drop site storage when the disk is nearly full or site data is cleared. <b>Nothing was changed or deleted.</b></p>${addrList(keyMissing.addresses)}<ul class="dlg-opts"><li><b>Restore from my account</b> — log in with your main wallet and sign once: every wallet your account backed up comes back.</li><li><b>Restore from file</b> — a <code>copytrade-vault-*.json</code> backup and its password.</li><li><b>Start a new vault</b> — the old encrypted vault stays stored here under a dated name (it opens again if its key ever comes back); new wallets go into a new vault.</li></ul><p class="dlg-note">A tab of the terminal still open from before this happened may still hold the key: keep it open — it puts the key back by itself within a minute, and this vault then opens as before.</p>`,
      choices: [{ id: 'fresh', label: 'Start a new vault', danger: true }, { id: 'file', label: 'Restore from file' }, { id: 'account', label: 'Restore from my account', primary: true }],
    });
    if (!choice) return { ok: false, cancelled: true, ...summary() };
    if (choice === 'file') return restoreDialog();
    if (choice === 'account') { await startFresh(); post({ t: 'ev', name: 'trench:vaultrecover', detail: { via: 'account' } }); return { ok: true, via: 'account', ...summary() }; }
    if (!(await ask({ title: 'Start a new empty vault?', danger: true, funds: true, ok: 'Start a new vault', html: `${sub(`The ${plural(n, 'wallet')} above stay stored but unreadable in this browser until you restore them from your account or a backup file.`)}${muted('Nothing is deleted.')}` }))) return { ok: false, cancelled: true, ...summary() };
    const r = await startFresh();
    return { ok: true, via: 'fresh', aside: r.aside, ...summary() };
  }
  const missing = missingWallets();
  if (!missing.length) return { ok: true, nothing: true, ...summary() };
  const choice = await askChoice({
    title: `${plural(missing.length, 'wallet')} not back yet`, ok: '', size: 'lg', cancelLabel: 'Later',
    html: `<p>An earlier vault of this browser (kept, encrypted, since ${escHtml(stampText(missing[0].since))}) lists wallets that are not in this vault:</p>${addrList(missing)}<p>Restore them from your account or a backup file. Only if they are gone for good, forget the list — the stored copy stays either way.</p>`,
    choices: [{ id: 'forget', label: 'Forget this list', danger: true }, { id: 'file', label: 'Restore from file' }, { id: 'account', label: 'Restore from my account', primary: true }],
  });
  if (choice === 'file') return restoreDialog();
  if (choice === 'account') { post({ t: 'ev', name: 'trench:vaultrecover', detail: { via: 'account' } }); return { ok: true, via: 'account', ...summary() }; }
  if (choice === 'forget') { meta.recoveryDismissed = [...new Set([...(meta.recoveryDismissed || []), ...missing.map((m) => lc(m.address))])].slice(-500); await persist(); pushBackupState(); return { ok: true, via: 'forget', ...summary() }; }
  return { ok: false, cancelled: true, ...summary() };
}
// ── where the vault stands, for the page's prompts: key missing, wallets not back, backups, storage room ──
function backupStateNow() {
  const list = unlocked || [];
  const keyed = list.filter((a) => !a.ext && !a.hop && /^0x[0-9a-fA-F]{64}$/.test(a.key));
  const held = (addr: string) => { const k = lc(addr); if ((ethCache[addr] || ethCache[k] || 0) > 0) return true; return Object.values(tokenCache).some((m) => (m[addr] || m[k] || 0) > 0); };
  const storage = storageHealth(storageEstimate, storagePersisted);
  const v1 = meta.main ? subsV1Of(meta.main).map((a) => lc(a.address)) : [];
  const account = meta.account && meta.account.main === meta.main ? { at: meta.account.at, addrs: [...meta.account.addrs, ...v1] } : null;
  const nudge = backupNudge({ wallets: keyed.map((a) => ({ address: a.address, createdAt: a.createdAt })), funded: keyed.filter((a) => held(a.address)).map((a) => a.address), backedUpAt: meta.backedUpAt || 0, walletAddedAt: meta.walletAddedAt || 0, account, storageLow: storage.low });
  const missing = missingWallets();
  // V12 F-28 follow-up: this device's seed came from a legacy phone-access copy ('rk1') — the wallets that exist ONLY here (not
  // in the account backup until the copy is updated on a device with the main, or the main signs here). Hop wallets are
  // counted apart (they are sealed with the rest once the seed is proven).
  const rk1Main = meta.main && meta.seedSrc?.[lc(meta.main)] === 'rk1' ? lc(meta.main) : '';
  const ub = rk1Main ? unboundOf(rk1Main) : [];
  const unbound = rk1Main ? { main: rk1Main, count: ub.filter((w) => w.kind !== 'hop').length, hops: ub.filter((w) => w.kind === 'hop').length,
    wallets: ub.filter((w) => w.kind !== 'hop').slice(0, 50).map((w) => ({ id: list.find((a) => same(a.address, w.address))?.id || '', name: w.name, address: w.address })) } : null;
  return {
    ok: true, wallets: keyed.length, changedAt: meta.changedAt || 0, backedUpAt: meta.backedUpAt || 0, unbound,
    due: keyed.length > 0 && (meta.changedAt || 0) > (meta.backedUpAt || 0), persisted: storagePersisted, origin: location.origin, host: HOST,
    keyMissing: keyMissing ? { reason: keyMissing.reason, wallets: keyMissing.addresses.length, addresses: keyMissing.addresses.slice(0, 20) } : null,
    missing: missing.slice(0, 20), missingCount: missing.length,
    account: meta.account ? { main: meta.account.main, at: meta.account.at, covered: nudge.accountCovered, total: keyed.length, current: nudge.accountCurrent } : null,
    file: { at: meta.backedUpAt || 0, current: nudge.fileCurrent },
    nudge, storage,
    // backup v4: the generation this vault knows the account is under (0 = v3), whether its key is here, a change waiting to publish
    passkey: meta.main ? { gen: meta.pk4?.[lc(meta.main)] || 0, unlocked: !!(meta.pk4?.[lc(meta.main)] && dkOf(lc(meta.main), meta.pk4[lc(meta.main)])), change: pkChange.has(lc(meta.main)), pending: pkPending.get(lc(meta.main))?.mode || null } : null,
  };
}
let lastPushed = '';
let pushTimer = 0;
function pushBackupState() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    try {
      const s = backupStateNow();
      const sig = JSON.stringify([s.keyMissing?.wallets ?? -1, s.missingCount, s.nudge.show, s.nudge.funded, s.account?.current ?? null, s.account?.covered ?? null, s.file.current, s.storage.low, s.storage.critical, s.unbound ? s.unbound.count + s.unbound.hops : -1]) + JSON.stringify(s.passkey ? [s.passkey.gen, s.passkey.unlocked, s.passkey.change, s.passkey.pending] : null);
      if (sig === lastPushed) return;
      lastPushed = sig;
      post({ t: 'ev', name: 'trench:backupstate', detail: s });
    } catch {}
  }, 400);
}

// ── two-factor gate, enforced here ──
// The account's 2FA (server/twofa.mjs) names the actions that need a code:
// withdraw (funds to an address outside the vault), export (a private key on
// screen), transfer (between the vault's own wallets), backup (the key file),
// remove (a wallet with funds erased). The page asks for the code and holds the
// ten-minute step-up token; the ENGINE decides. Before any gated action it
// needs a token the server itself has confirmed (POST /api/2fa/check) — a page
// script, an extension or a tampered build that calls export() or transfer()
// without one gets TwoFactorRequired and nothing leaves. The gate configuration
// comes from the server (read with the page's Privy access token when the vault
// opens and every five minutes, refreshed on every check), is remembered on
// this origin together with the account it belongs to, and what the page pushes
// counts only while no server copy exists. The vault is the browser's, the 2FA
// is an account's: once a server copy is held, a LOOSER policy of ANOTHER
// account (a script logging in with its own, 2FA-less account; a token minted
// for it) lands only on a trusted click in a dialog this frame draws — the same
// rule as for a key on screen. When the server cannot be reached for a gated
// action the action fails — closed.
type GateAction = 'withdraw' | 'export' | 'transfer' | 'backup' | 'remove';
type GatePolicy = { enabled: boolean; gates: Record<string, boolean>; source: 'server' | 'page' | 'none'; at: number; user?: string };
type Auth = { twofa?: string } | string | null | undefined;
type CheckReply = { ok?: boolean; valid?: boolean; exp?: number; enabled?: boolean; gates?: unknown; user?: string; error?: string };
const GATE_ACTIONS: GateAction[] = ['withdraw', 'export', 'transfer', 'backup', 'remove'];
const TWOFA_KEY = 'trenches.engine.twofa';
const TWOFA_REFRESH_MS = 5 * 60_000;
// the API lives on the page's origin; in the vault frame that is the parent that greeted us (an allowed origin), inline it is this origin
const twofaApi = () => (HOST && parentOrigin ? parentOrigin : location.origin) + '/api/2fa';
// (2026-10-29) motion's keyed Relay pass-through, used only when Relay refuses a keyless quote (relayApi.ts): the same origin rule
setRelayProxyBase(() => (HOST && parentOrigin ? parentOrigin : location.origin));
// V13 VA-3: the Relay quote the vault signs is one the vault fetched from api.relay.link ITSELF. Up to V12 it came from
// motion's /api/bridge/quote, and only the deposit contract, the chain and the selector were compared with Relay: the
// recipient lives in Relay's record of the request id, not in the calldata, so a lying server could hand over a real
// quote it had made for the attacker as recipient while the dialog showed the user's own wallet. Now the request id
// comes from Relay's answer to the vault (the app fee passed as explicit parameters, pinned in v13Guards), and that
// answer must name this wallet as depositor, the confirmed recipient, the chains and the amount (relayQuoteProblem).
// api.relay.link is in the frame's connect-src; bridges are off the trade path (no click-to-send latency involved).
async function ownBridgeQuote(a: { address: `0x${string}`; key?: `0x${string}`; ext?: string }, q: BridgeQuoteLite): Promise<BridgeQuoteLite> {
  const origin = Number(q?.originChainId), dest = Number(q?.destinationChainId);
  const user = origin === RELAY_SOL_CHAIN ? solAddressOf(a as never) : a.address;
  if (!user) throw new Error('No address for this wallet on the origin chain');
  if (!/^\d{1,40}$/.test(String(q?.amount || ''))) throw new Error('Bad amount');
  const recipient = String(q.recipient || '');
  const evm = (id: number) => id !== RELAY_SOL_CHAIN;
  if (!(evm(dest) ? /^0x[0-9a-fA-F]{40}$/.test(recipient) : SOL_ADDR.test(recipient))) throw new Error('Bad recipient for the destination chain');
  if (origin === dest || !(BRIDGE_CHAINS[origin] || origin === RELAY_SOL_CHAIN) || !(BRIDGE_CHAINS[dest] || dest === RELAY_SOL_CHAIN)) throw new Error('This route is not bridgeable here');
  const native = (id: number) => (id === RELAY_SOL_CHAIN ? '11111111111111111111111111111111' : ZERO);
  const body = { user, recipient, originChainId: origin, destinationChainId: dest, originCurrency: native(origin), destinationCurrency: native(dest), amount: String(q.amount), tradeType: 'EXACT_INPUT', appFees: BRIDGE_APP_FEE.bps > 0 ? [{ recipient: BRIDGE_APP_FEE.recipient, fee: String(BRIDGE_APP_FEE.bps) }] : [] };
  // (2026-10-29) keyless from api.relay.link first, exactly as before; motion's keyed pass-through only when Relay wants a
  // key (relayApi.ts) — and a quote that came that way must also pass the checks that do not depend on motion's server
  const { j, source } = await relayQuote(body as never);
  const bad = relayQuoteProblem(j, { user, recipient, originChainId: origin, destinationChainId: dest, amount: String(q.amount), evm });
  if (bad) throw new Error(`Relay's quote was refused: ${bad}`);
  const step = j.steps.find((x: { kind?: string }) => x?.kind === 'transaction').items[0].data;
  const co = j.details?.currencyOut || {};
  let sol: BridgeQuoteLite['sol'];
  if (source === 'motion') {
    if (evm(origin)) { const s = evmStepsProblem(j, { user, originChainId: origin, originCurrency: NATIVE_EVM, amount: String(q.amount) }); if ('problem' in s) throw new Error(`The quote motion relayed was refused: ${s.problem}`); }
    else { const s = solStepsProblem(j, user); if ('problem' in s) throw new Error(`The quote motion relayed was refused: ${s.problem}`); sol = s; }
    const decOut = evm(dest) ? 18 : 9, decIn = evm(origin) ? 18 : 9;
    const p = priceProblem(BigInt(String(co.amount ?? '0')), decOut, await independentOut(body as never, decIn));
    if (p) throw new Error(`The quote motion relayed was refused: ${p}`);
  }
  return { requestId: String(j.requestId), originChainId: origin, destinationChainId: dest, amount: String(q.amount), recipient, step, out: /^\d{1,60}$/.test(String(co.amount ?? '')) ? String(co.amount) : '', outFormatted: String(co.amountFormatted ?? '').slice(0, 40), source, ...(sol ? { sol } : {}) };
}
// bind → sign: the bound quote waits here under a single-use ticket (same wallet, 90 s) so the page can file the job
// under the request id the deposit will really carry before anything is signed
const bridgeTickets = new Map<string, { id: string; bound: BridgeQuoteLite; at: number }>();
const swapTickets = new Map<string, { id: string; bound: SwapBound; at: number }>();   // relaySwap's, the same rule
const OFF: GatePolicy = { enabled: false, gates: {}, source: 'none', at: 0 };
const cleanGates = (g: unknown) => Object.fromEntries(GATE_ACTIONS.map((k) => [k, !!(g && typeof g === 'object' && (g as Record<string, unknown>)[k])]));
let serverPolicy: GatePolicy | null = (() => { try { const p = JSON.parse(localStorage.getItem(TWOFA_KEY) || 'null'); return p && p.source === 'server' ? { enabled: !!p.enabled, gates: cleanGates(p.gates), source: 'server', at: Number(p.at) || 0, user: String(p.user || '') } : null; } catch { return null; } })();
let pagePolicy: GatePolicy | null = null;
// (audit 2026-11-01, vault-security-rewards-link) the motion rewards account tag (server/rewards.mjs accountTag:
// sha256('motion/rewards/account\n' + Privy user id)[0..16]) of the account the SERVER bound this vault to; '' = none known
async function rewardsTagOfVault(): Promise<string> {
  const user = serverPolicy && serverPolicy.source === 'server' ? String(serverPolicy.user || '') : '';
  if (!user) return '';
  return bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('motion/rewards/account\n' + user)))).slice(2, 18);
}
let pendingPolicy: GatePolicy | null = null;       // the policy of another account than the bound one, waiting for the click
let access = '';                                   // the page's Privy access token, for reading the account's gates
// the tokens the server confirmed, one per kind of action: a code typed for an export does not also open withdrawals
const stepUps = new Map<GateAction, { token: string; exp: number }>();
let lastCheckAt = 0;
// The account that had 2FA on in this vault, remembered: once it has, a vault that lost its server copy (or never
// reached the server since) does not fall back to "no gates" — it asks for a code on the server's default gates.
const EVER_KEY = TWOFA_KEY + '.ever';
let everOn = (() => { try { return localStorage.getItem(EVER_KEY) || ''; } catch { return ''; } })();
const noteEver = (p: GatePolicy) => { if (p.enabled && p.user) { everOn = p.user; try { localStorage.setItem(EVER_KEY, p.user); } catch {} } };
const FAIL_CLOSED: GatePolicy = { enabled: true, gates: cleanGates({ withdraw: true, export: true, remove: true }), source: 'none', at: 0 };
// The bound account's server copy decides. The page's view and a stricter policy of another account parked for the
// click can only ADD gates (a page that says "2FA off" is ignored; it used to decide while no server copy existed).
const policyNow = (): GatePolicy => {
  const base = serverPolicy || (everOn ? FAIL_CLOSED : OFF);
  const extra = [pagePolicy, pendingPolicy].filter((p): p is GatePolicy => !!p && p.enabled);
  if (!extra.length) return base;
  const gates = { ...base.gates }; for (const p of extra) for (const k of GATE_ACTIONS) if (p.gates[k]) gates[k] = true;
  return { ...base, enabled: true, gates };
};
// the server's word on an account: taken as is for the bound account (or when none is bound yet, or when it only tightens); otherwise parked for the click
const adoptServer = (j: CheckReply) => {
  const next: GatePolicy = { enabled: !!j.enabled, gates: cleanGates(j.gates), source: 'server', at: Date.now(), user: String(j.user || '') };
  // another account than the bound one never takes over by itself — looser OR stricter (a stricter one used to rebind
  // silently, after which its own codes satisfied every gate): it waits for the trusted click in rebind()
  if (serverPolicy?.user && next.user !== serverPolicy.user) { pendingPolicy = next; return false; }
  serverPolicy = next; pendingPolicy = null;
  try { localStorage.setItem(TWOFA_KEY, JSON.stringify(serverPolicy)); } catch {}
  noteEver(serverPolicy);
  if (!serverPolicy.enabled) stepUps.clear();
  return true;
};
// the one way another account's policy (and its codes) gets in: a trusted click inside this frame
async function rebind() {
  const p = pendingPolicy; if (!p) return false;
  const ok = await ask({ title: 'A different account signed in', danger: true, funds: true, ok: 'Use this account', html: `${sub(`The two-factor rules here were set by the account that signed in last. This account ${p.enabled ? 'has its own codes' : 'asks for no codes at all'}; they count here only after this click.`)}${muted('Continue only if you signed in yourself.')}` });
  if (!ok || pendingPolicy !== p) return false;
  serverPolicy = p; pendingPolicy = null;
  try { localStorage.setItem(TWOFA_KEY, JSON.stringify(serverPolicy)); } catch {}
  noteEver(p); stepUps.clear();
  return true;
}
const twofaPost = async (body: Record<string, unknown>): Promise<CheckReply> => {
  // text/plain keeps it a simple request: no preflight on the isolated origin, nothing for a flaky OPTIONS to break
  const r = await fetch(twofaApi() + '/check', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => null) as CheckReply | null;
  if (!j || typeof j !== 'object') throw new Error(`the 2FA service answered ${r.status} without a body`);
  return j;
};
const jwtExp = (t: string) => { try { return Number(JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0) * 1000; } catch { return 0; } };
// the server's copy of the logged-in account's gates, read with the page's access token
async function refreshPolicy() {
  if (!access || jwtExp(access) < Date.now() + 10_000) return policyNow();
  try { const j = await twofaPost({ access }); if (j.ok && j.gates && j.user) adoptServer(j); } catch { /* unreachable: the remembered copy stands */ }
  return policyNow();
}
setInterval(() => { refreshPolicy().catch(() => {}); }, TWOFA_REFRESH_MS);
const twoFactorRequired = (action: GateAction) => Object.assign(new Error(`TwoFactorRequired: ${action} needs a two-factor code`), { name: 'TwoFactorRequired', action });
const twoFactorUnavailable = (action: GateAction, why: string) => Object.assign(new Error(`TwoFactorUnavailable: ${why}; ${action} refused`), { name: 'TwoFactorUnavailable', action });
const tokenOf = (auth: Auth) => (typeof auth === 'string' ? auth : auth && typeof auth === 'object' ? String(auth.twofa || '') : '');
// resolves when the action may proceed; throws TwoFactorRequired (no/invalid/expired token, or one of another account) or TwoFactorUnavailable (server unreachable)
async function gate(action: GateAction, auth?: Auth): Promise<void> {
  if (!serverPolicy && access) await refreshPolicy();   // decide on the server's copy when one can be had
  // Logged in, but the account's gates could not be read (the 2FA store down — it answers 503 rather than "off" — or the
  // network): a vault that never held this account's copy does not guess "no 2FA" for withdrawals, exports and funded
  // removals (review 2026-10-19 M3: a store that failed to load must never switch 2FA off)
  if (!serverPolicy && access && FAIL_CLOSED.gates[action]) throw twoFactorUnavailable(action, 'the account\'s two-factor settings could not be read');
  const pol = policyNow();
  if (!pol.enabled || !pol.gates[action]) return;
  const su = stepUps.get(action);
  const t = tokenOf(auth) || su?.token || '';
  if (su && su.token === t && su.exp > Date.now() + 5000) return;   // one code: this kind of action for ten minutes
  if (!t) { if (pendingPolicy && await rebind()) return gate(action, auth); throw twoFactorRequired(action); }
  let j: CheckReply;
  try { j = await twofaPost({ token: t, action }); } catch (e) { throw twoFactorUnavailable(action, `the 2FA service could not be reached (${shortError(e)})`); }
  if (!j.ok) throw twoFactorUnavailable(action, j.error || 'the 2FA service refused the check');
  lastCheckAt = Date.now();
  if (j.user && j.gates) {
    // a code of another account changes the rules only after the click; a code of the bound account (or the first) carries the server's current rules
    if (!adoptServer(j) && !(await rebind())) throw twoFactorRequired(action);
  }
  if (!j.valid) { if (su?.token === t) stepUps.delete(action); const now = policyNow(); if (now.enabled && now.gates[action]) throw twoFactorRequired(action); return; }   // the server may have said 2FA is off now
  // a valid token of ANOTHER account (a script's own, 2FA-on account) never satisfies a gate of this vault's account
  if (!serverPolicy?.user || j.user !== serverPolicy.user) throw twoFactorRequired(action);
  stepUps.set(action, { token: t, exp: Number(j.exp) || Date.now() + 60_000 });
}
// An outside destination is one whose key this vault does not hold. A Privy wallet is an address the PAGE
// attached (linkExternal): the frame cannot tell the user's main from an address a script named, so funds to
// it take the outside path (the 'withdraw' gate and a trusted click on the address), like any other address.
// V12 F-34: a wallet the page imported (via:'page') is NOT counted among the vault's own for transfers — sending to it
// takes the outside / withdrawal path, so a page cannot plant its own key and then sweep to it as if it were ours.
const ownAccounts = () => requireUnlocked().filter((a) => !a.ext && a.via !== 'page' && /^0x[0-9a-fA-F]{64}$/.test(a.key));
const isOwn = (to: string) => ownAccounts().some((a) => (SOL_MODE ? solAddressOf(a) === to : same(NEAR_MODE ? nearAccountId(a) : a.address, to)));
// V12 F-56: a main address comes from the page — validate it to the EVM shape before it is used as a key into `seeds`
// (so 'constructor' and the like can never be a lookup), and read seeds only through own properties.
const mainAddr = (a: unknown): string => { const m = lc(a as string); if (!/^0x[0-9a-f]{40}$/.test(m)) throw new Error('Bad main address'); return m; };
// own-property lookup (Object.hasOwn semantics; written this way so the current tsconfig lib accepts it): a main address
// taken from the page can never reach an inherited property like 'constructor' on the seeds map.
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const seedOf = (m: string): string | undefined => (hasOwn(seeds, m) ? seeds[m] : undefined);
// V12 F-28: the slot in `seeds` holding a main's own MAIN_MSG signature, stored at mainAttach so a later recovery seal
// can bind to it; and a verified lookup of it.
const MS = (m: string): string => 'ms:' + lc(m);
// This account's own wallets for its USD-balance consent record (src/floatConsent.ts Own): the EVM keys this vault holds and —
// only when a record's signer is none of them — the wallets of the account's backup-v4 (passkey) entries opened with a K4 this
// vault unwrapped ITSELF (its own dk for that generation; security review 2026-11-02 H1). Never a v3 / v2 / v1 entry (they
// open under the seed alone — a phished main signature could have sealed its own key there) and never a seed-derived address
// or the page's `count`. A vault that has no v4 key for this account proves nothing from the backup. A seed from an unbound
// legacy recovery copy ('rk1', V12 F-28) never adopts a grant (a revocation still applies).
function consentOwn(m: string, seed: string, p: Profile | null): Own {
  const vault = new Set(allAccounts().filter((a) => !a.ext && !a.hop && /^0x[0-9a-fA-F]{64}$/.test(a.key)).map((a) => lc(a.address)));
  return {
    vault, grants: meta.seedSrc?.[m] !== 'rk1',
    v4: async () => {
      const out = new Set<string>();
      if (!p || lc(p.main) !== m || (p.fp && p.fp !== await fingerprint(seed)) || !meta.pk4?.[m]) return out;
      const k4 = await v4KeysOf(m, normPk(p.pk)).catch(() => ({ keys: [] as CryptoKey[] }));
      if (!k4.keys.length) return out;
      for (const w of (await openProfile(p, seed, saltsOf(), k4.keys)).wallets) if (w.v === 4) out.add(lc(w.address));
      return out;
    },
  };
}
const mainSigStored = (m: string): string => (hasOwn(seeds, MS(m)) ? seeds[MS(m)] : '');
// V12 F-28: the main's own MAIN_MSG signature to bind a recovery copy to — the one stored when this main was attached
// here, or (for a main attached before this build) one the caller hands in. Verified both ways before use: it must be
// the main's signature over its text AND derive exactly this main's seed, so a recovery copy is only ever bound to the
// real main. Remembered once seen, so turning phone access on later needs no second signature.
async function mainSigFor(m: string, provided?: string): Promise<{ sig: `0x${string}`; mv: MainMsgVersion }> {
  const seed = seedOf(m); if (!seed) throw new Error('Main wallet not attached on this device');
  const mv = mvOf(m);
  const sig = /^0x[0-9a-fA-F]{130}$/.test(String(provided || '')) ? String(provided) : mainSigStored(m);
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('Re-sign with your main wallet to turn phone access on for this device');
  const signer = await recoverMessageAddress({ message: MAIN_MSG(m, mv), signature: sig as `0x${string}` }).catch(() => '');
  if (!same(signer, m)) throw new Error('That is not this main wallet\'s signature');
  if (await seedOfSignature(sig) !== seed) throw new Error('That main-wallet signature does not match this account');
  if (!hasOwn(seeds, MS(m))) seeds[MS(m)] = sig;
  return { sig: sig as `0x${string}`, mv };
}
// V12 F-28 follow-up (src/rkMigrate.ts UNBACKED_SEND): a transfer between own wallets whose destination exists ONLY on this
// device — an 'rk1' seed's own wallet, not in the account backup until phone access is updated — is confirmed once more in this
// frame: what is sent there is lost with this browser's data. Every other destination passes untouched (no extra step).
async function unbackedOk(tos: string[]): Promise<void> {
  const m = meta.main ? lc(meta.main) : ''; if (!m || meta.seedSrc?.[m] !== 'rk1') return;
  const local = unboundOf(m); if (!local.length) return;
  const hit = ownAccounts().find((a) => local.some((w) => same(w.address, a.address)) && tos.some((to) => !!to && (SOL_MODE ? solAddressOf(a) === to : NEAR_MODE ? nearAccountId(a) === String(to).toLowerCase() : same(a.address, to))));
  if (!hit) return;
  const L = UNBACKED_SEND[uiLang()];
  if (!(await ask({ title: L.title, danger: true, ok: L.ok, cancelLabel: L.cancel, html: `${sub(escHtml(L.sub(hit.name)))}<div class="dk-list">${addrRow(hit.name, hit.address)}</div>${muted(escHtml(L.note))}` }))) throw new Error('Cancelled');
}
// SEC-6 (security batch 2): "your login wallet" is said only of the account's MAIN as this vault verified it itself — its own
// signature over MAIN_MSG (a main new to this vault is first attached through the vault's "Set up this device" click), a seed
// that is not an unproven legacy copy ('rk1'). An address the page attached (linkExternal accepts any list a script names) is
// just an address: the outside dialog, its danger and its words. Returns the name to show, or null.
const verifiedLogin = (rcpt: string): { name: string } | null => {
  const m = meta.main ? lc(meta.main) : '';
  if (!m || !/^0x[0-9a-f]{40}$/.test(m) || !same(m, rcpt) || !seedOf(m) || meta.seedSrc?.[m] === 'rk1') return null;
  const row = allAccounts().find((x) => x.ext && same(x.address, m));
  return { name: row?.name || 'Main' };
};
// the outside path for a destination named by wallet id (distribute / consolidate / sweep): gate, then the address in a dialog
// (security batch 2, NEAR-2) `addr` is where the funds really go: the wallet's identity on this frame's lane (laneAddr)
async function outsideOk(to: Account, what: string, auth?: Auth, addr: string = to.address) {
  await gate('withdraw', auth);
  const ok = await ask({ title: 'Send outside your vault', danger: true, funds: true, ok: 'Send', html: `${sub(`${what} to ${escHtml(to.name)}. ${to.ext && verifiedLogin(to.address) ? 'It is your login wallet: its key is held by your login provider, not by this vault.' : to.ext ? 'The page lists it as a login wallet; the vault has not verified that. Its key is not in this vault.' : 'It isn\'t one of your wallets.'}`)}${destBox(addr)}${muted('Check every character. This can\'t be undone.')}` });
  if (!ok) throw new Error('Cancelled');
}
// NEAR-2 (security batch 2, 2026-11-04): a wallet named by id is, on the NEAR and Solana frames, its NEAR account / Solana
// address — distribute and consolidate used to check, show and send to its EVM 0x address (and say "ETH" while NEAR left).
// A wallet without an identity on this lane (a Privy login wallet: EVM only) is refused, never sent to its 0x address.
const laneAddr = (a: Account) => (SOL_MODE ? solAddressOf(a) : NEAR_MODE ? nearAccountId(a) : a.address) || '';
const laneDest = (a: Account) => { const x = laneAddr(a); if (!x) throw new Error(`${a.name || 'That wallet'} has no ${laneUnit()} address on this lane`); return x; };
// a NEAR implicit account's own ed25519 signature over a text (hex), from the same derived key as its transactions
const nearSignText = (evmKeyHex: string, text: string) => Array.from(ed25519.sign(new TextEncoder().encode(text), nearKeys(evmKeyHex).seed), (b) => b.toString(16).padStart(2, '0')).join('');

// ── transfers at most once per idempotency key (review 2026-10-19 M4: a leg that timed out but executed, re-sent) ──
// transfer(from, to, amount, auth, { idempotencyKey }) and transferToken(from, token, to, amount, auth, { idempotencyKey }):
// the caller names ONE logical transfer with a key of its own (8–100 of [A-Za-z0-9_.:-], e.g. a UUID per leg, made when
// the user confirms the transfer and reused for every retry of that leg). Within IDEM_MS on this lane, in this browser's
// vault (the record survives a frame reload):
//   · same key, sent              → the same { ok, hash, … } again, with idempotent: true — nothing is sent twice
//   · same key, still running here → the same pending promise
//   · same key, started but the frame died before the outcome was recorded → throws TransferUnknown
//     (name 'TransferUnknown', unknown: true): it may be on chain — check wallet activity, never auto-resend
//   · same key, ended in an error after the send began → that error again (name kept, idempotent: true), not a resend
//   · same key, another from / to / amount / token → throws (a key names one transfer)
//   · an error BEFORE the send began (Cancelled, TwoFactorRequired, Invalid address, …) records nothing: the same key may
//     be retried, e.g. after the user typed the 2FA code
// A deliberate new transfer takes a new key. No key = as before (every call sends).
type TransferOpts = { idempotencyKey?: string } | undefined;
const IDEM_MS = 15 * 60_000;
const IDEM_STORE = 'trenches.engine.idem.v1.' + MOVE_LANE;
type IdemRec = { f: string; s: 'sending' | 'sent' | 'failed'; at: number; r?: Record<string, unknown>; e?: string; n?: string };
const idemRead = (): Record<string, IdemRec> => { try { const o = JSON.parse(localStorage.getItem(IDEM_STORE) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const idemWrite = (k: string, rec: IdemRec | null) => {
  try {
    const all = idemRead(); const t = Date.now();
    for (const [x, v] of Object.entries(all)) if (!v || t - Number(v.at) > IDEM_MS) delete all[x];
    if (rec) all[k] = rec; else delete all[k];
    const keys = Object.keys(all); if (keys.length > 200) for (const x of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 200)) delete all[x];
    localStorage.setItem(IDEM_STORE, JSON.stringify(all));
  } catch {}
};
const idemLive = new Map<string, { f: string; p: Promise<any> }>();
async function once<T extends Record<string, unknown>>(opts: TransferOpts, what: unknown[], run: (sending: () => void) => Promise<T>): Promise<T> {
  const raw = opts && typeof opts === 'object' ? (opts as { idempotencyKey?: unknown }).idempotencyKey : undefined;
  if (raw == null || raw === '') return run(() => {});
  const k = String(raw);
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(k)) throw new Error('Bad idempotency key (8–100 of A–Z a–z 0–9 _ . : -)');
  const f = JSON.stringify(what);
  // F-61 (V12): the record is read and written under a cross-tab Web Lock keyed by the idempotency key, so the
  // check ("already sent? already sending?") and the first write ('sending') are one atomic step — two tabs (or two
  // presses) sharing a key can never both pass the check and both send. The record is re-read INSIDE the lock.
  const body = async (): Promise<T> => {
    const live = idemLive.get(k);
    if (live) { if (live.f !== f) throw new Error('This idempotency key belongs to another transfer'); return live.p.then((r) => ({ ...r, idempotent: true })); }
    const rec = idemRead()[k];
    if (rec && Date.now() - rec.at < IDEM_MS) {
      if (rec.f !== f) throw new Error('This idempotency key belongs to another transfer');
      if (rec.s === 'sent') return { ...(rec.r || {}), ok: true, idempotent: true } as unknown as T;
      if (rec.s === 'sending') throw Object.assign(new Error('Status unknown — this transfer was started before and its outcome was not recorded; check wallet activity before sending again'), { name: 'TransferUnknown', unknown: true, idempotent: true });
      throw Object.assign(new Error(rec.e || 'This transfer failed'), { name: rec.n || 'Error', idempotent: true });
    }
    let began = false;
    const p = (async () => {
      try {
        const r = await run(() => { began = true; idemWrite(k, { f, s: 'sending', at: Date.now() }); });
        if (began) idemWrite(k, { f, s: 'sent', at: Date.now(), r: JSON.parse(JSON.stringify(r)) });
        return r;
      } catch (e) {
        const err = e as { preSend?: boolean; unknown?: boolean; txState?: string } & Error;
        if (began) {
          // F-42 (V12): a pre-send failure (nothing was executed, flagged {preSend:true} by the caller — e.g. perps'
          // sufficiency check) DELETES the record so the caller may retry the same key. Never a terminal 'failed'.
          if (err?.preSend === true) idemWrite(k, null);
          // A send whose OUTCOME IS UNKNOWN (Sol/NearSendUnknown from the sol/near engines, or an EVM broadcast that
          // came back 'unknown') keeps the record 'sending' — NOT 'failed'. 'failed' would let a retry re-send a
          // transfer that may already be on chain; 'sending' makes the retry report "status unknown, check first".
          else if (err instanceof SolSendUnknown || err instanceof NearSendUnknown || err?.unknown === true || err?.txState === 'unknown') idemWrite(k, { f, s: 'sending', at: Date.now() });
          // a real pre-chain failure: the outcome is this error, kept for the window
          else idemWrite(k, { f, s: 'failed', at: Date.now(), e: String((e as Error)?.message || e).slice(0, 500), n: String((e as Error)?.name || 'Error') });
        }
        throw e;
      }
    })();
    idemLive.set(k, { f, p });
    try { return await p; } finally { idemLive.delete(k); }
  };
  const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return lk?.request ? (lk.request('trench-idem-' + k, body) as Promise<T>) : body();
}
// a page script may only ever report; the gate decides from the server copy
async function twofaPolicy(src: { accessToken?: unknown; enabled?: unknown; gates?: unknown } | null | undefined) {
  if (src && typeof src === 'object') {
    const at = typeof src.accessToken === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(src.accessToken) ? src.accessToken : '';
    if (at) { access = at; await refreshPolicy(); }
    if ('enabled' in src || 'gates' in src) pagePolicy = { enabled: !!src.enabled, gates: cleanGates(src.gates), source: 'page', at: Date.now() };
  }
  return policy();
}
function policy() {
  const pol = policyNow();
  const gated = pol.enabled ? GATE_ACTIONS.filter((k) => pol.gates[k]) : [];
  return {
    ok: true, twofa: pol.enabled ? 'on' as const : 'off' as const, gated, enforcedIn: 'engine' as const, source: pol.source, at: pol.at, lastCheckAt,
    boundTo: pol.user || '', pending: pendingPolicy ? { user: pendingPolicy.user || '', twofa: pendingPolicy.enabled ? 'on' : 'off' } : null,
    stepUp: [...stepUps.values()].some((x) => x.exp > Date.now()), stepUpExp: Math.max(0, ...[...stepUps.values()].map((x) => x.exp)), stepUpFor: [...stepUps.entries()].filter(([, x]) => x.exp > Date.now()).map(([k]) => k),
    // what each sensitive method needs, as enforced in this file (see the comment above `engine`)
    surface: [
      { method: 'export', does: 'shows one private key in the engine dialog', needs: ['click', 'export'] },
      { method: 'exportMany', does: 'shows several private keys in the engine dialog', needs: ['click', 'export'] },
      { method: 'backup', does: 'writes the encrypted key file', needs: ['click', 'backup'] },
      { method: 'transfer', does: 'sends native coin from one wallet', needs: ['transfer'], outside: ['click', 'withdraw'] },
      { method: 'distribute', does: 'sends native coin to the vault\'s own wallets only', needs: ['transfer'] },
      { method: 'consolidate', does: 'sweeps the vault\'s own wallets into one of them', needs: ['transfer'] },
      { method: 'move.start', does: 'runs a planned move (native or ERC-20, hops)', needs: ['transfer'], outside: ['click', 'withdraw'] },
      { method: 'bridgeSend', does: 'sends on another EVM chain', needs: ['transfer'], outside: ['click', 'withdraw'] },
      { method: 'bridgeDeposit', does: 'pays a Relay bridge quote to its recipient', needs: ['click', 'transfer'], outside: ['click', 'withdraw'] },
      { method: 'relaySwap', does: 'pays a Relay swap quote (an exact approve to Relay depository, then the deposit; or one simulated Solana transaction) to its recipient', needs: ['click', 'transfer'], outside: ['click', 'withdraw'] },
      { method: 'remove', does: 'erases a wallet key', needs: ['click', 'remove'] },
      { method: 'importDialog', does: 'adds wallets from a key or recovery phrase typed into the engine dialog (EVM, Solana, NEAR; the key never leaves the frame)', needs: ['click'] },
      { method: 'buy/sell', does: 'signs a verified route for a token trade', needs: [] },
      { method: 'wrap/unwrap', does: 'wraps native coin in the same wallet', needs: [] },
      { method: 'signNote', does: 'signs two fixed note formats only (callout, BGC entry)', needs: [] },
      { method: 'limit.place', does: 'funds an order\'s own wallet (derived from this wallet\'s key) and pre-signs one swap paying back to this wallet', needs: ['click'] },
      { method: 'limit.cancel', does: 'returns everything in an order wallet to its main wallet and burns the swap\'s nonce', needs: ['click'] },
      { method: 'limit.sweep', does: 'returns what is left in an order wallet that can no longer fill to its main wallet', needs: [] },
      { method: 'float.configure', does: 'turns on the USD balance for every wallet of the account in one dialog: a standing permission per wallet to move money between that wallet and its own reserve (caps per wallet: per day, fees, per chain, total, slippage; 30 days); switching it on converts each wallet\'s native above what stays ready into its reserve\'s dollars, at the amounts the dialog states; a wallet added later joins with the same caps and converts by the routine sweep; the switch is also recorded in the account backup (sealed under the seed, signed by one of its wallets) and the account\'s other devices follow it without a dialog', needs: ['click', 'transfer'] },
      { method: 'float.ensure', does: 'tops up / sweeps / rebalances between this wallet and its own reserve, within the permission\'s caps; for a buy click its reserves cannot cover, also from this wallet\'s own native on another chain of the permission (one Relay deposit by this wallet, landing in this wallet on the click\'s chain, at most $100 per move); for an Elysium buy none of this wallet\'s reserves covers, ONE reserve of another wallet of this vault whose USD balance is on for that chain may pay it to this wallet (allowed once per account in the vault\'s dialog); never to any other address', needs: [] },
      { method: 'float.sweep', does: 'moves a float surplus back to the reserve (not while a trade runs or within 10 s of a trade or ticket touch)', needs: [] },
      { method: 'float.off', does: 'converts every wallet\'s reserve dollars back to each chain\'s native in that wallet (one dialog states the amounts per wallet), then withdraws the switch and every wallet\'s permission; nothing to convert = no dialog; the revocation is recorded in the account backup and every other device of the account turns off on its next sync', needs: ['click', 'transfer'] },
      { method: 'float.buy', does: 'buys a coin for the selected wallets straight from each wallet\'s own reserve: the reserve signs ONE transaction that spends its USDC and pays the coin into that wallet (Solana; a Jupiter route checked and simulated like every buy); only while the USD balance is on for that wallet; the same buy limits and double-press guard as a buy', needs: [] },
      { method: 'float.earn', does: 'Earn on the USD balance (Robinhood, USDG): on = one dialog (risks, the liquid buffer, the account cap), after which each wallet\'s reserve keeps a liquid buffer and deposits only the rest into ONE pinned ERC-4626 vault (Morpho Steakhouse USDG), receiver and owner always that reserve; a buy larger than the buffer first withdraws from the vault to the same reserve; off = everything comes back to the reserve; never to any other address', needs: ['click', 'transfer'] },
      { method: 'float.convert', does: 'turns $X of one wallet\'s USD balance on THIS frame\'s chain into that chain\'s own coin (ETH on Robinhood, BNB on BNB, SOL on Solana), paid into that wallet and kept there (out of the dollar figure, never swept back): the existing top-up from the wallet\'s own reserve (one transaction, the float\'s own pool, the oracle price check); only while the USD balance is on for that wallet and chain; the switch\'s day / fee limits, at most the per-chain limit per conversion, one move of that wallet and chain at a time', needs: [] },
      { method: 'float.withdraw', does: 'sends $X (or all) of one wallet\'s USD balance on THIS frame\'s chain as the stablecoin itself (USDG / USDC), in ONE transfer signed by the wallet\'s own reserve, to that wallet or to an address; an address the vault holds no key for takes Send\'s own consent (the withdraw 2FA gate and the vault dialog with the address in full); never more than the reserve holds; a repeat of its idempotency key never sends twice', needs: ['transfer'] },
      { method: 'float.status/jobs', does: 'reads the USD balance (cached): one wallet, or every wallet of the account and their total (scope account)', needs: [] },
    ],
  };
}

// a move whose legs end outside the vault is confirmed on its real destinations
async function confirmOutside(plan: Plan, auth?: Auth) {
  requireUnlocked();
  const outside = [...new Set(plan.legs.filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l.to) && !isOwn(l.to)).map((l) => lc(l.to)))];
  // the 2FA gate first: between own wallets 'transfer', to anyone else 'withdraw' — then the dialog
  await gate(outside.length ? 'withdraw' : 'transfer', auth);
  // V12 F-28 follow-up: a leg that ends in a wallet only this device holds (not in the account backup yet) asks once more
  await unbackedOk(plan.legs.map((l) => String(l.to || '')));
  if (!outside.length) return;
  // the asset and the total shown are read here: the symbol from the token contract, the sum from the legs that leave the vault
  const asset = plan.asset.kind === 'eth' ? NATIVE : String(await publicClient.readContract({ address: plan.asset.address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'tokens'));
  const nextOf = new Map(plan.legs.filter((l) => l.after).map((l) => [String(l.after), l]));
  const finalOf = (l: Leg) => { let x = l; for (let i = 0; i < MAX_HOPS + 1 && nextOf.get(x.id); i += 1) x = nextOf.get(x.id)!; return x; };
  const total = plan.legs.filter((l) => !l.after && outside.includes(lc(finalOf(l).to))).reduce((t, l) => t + (l.amount === 'max' ? 0 : humanOf(BigInt(l.amount), plan.asset)), 0);
  const ok = await ask({
    title: 'Send outside your vault', danger: true, funds: true, ok: `Send ${asset}`,
    html: `${sub(`${escHtml(Number(total.toFixed(8)))} ${escHtml(asset)} in total${plan.hops ? ` through ${plan.hops} hop wallet${plan.hops === 1 ? '' : 's'}` : ''} to ${outside.length === 1 ? 'this address' : `these ${outside.length} addresses`}. ${outside.length === 1 ? 'It isn\'t' : 'They aren\'t'} your wallets.`)}${outside.map((a) => destBox(a)).join('')}${muted('Check every character. This can\'t be undone.')}`,
  });
  if (!ok) throw new Error('Cancelled');
}

// ── the vault's surface ──
// Everything the page can call is on this object (over postMessage in the
// frame, through bridge.js inline). What can move value or reveal a secret, and
// what each needs — "click" is a trusted click in a dialog the engine draws,
// the quoted names are 2FA gates checked by gate() against the server:
//   export(id, auth) / exportMany(ids, auth)  key(s) on screen, never returned   click + 'export'
//   backup(auth)                              encrypted key file                 click + 'backup'
//   transfer(from, to, amt, auth)             native coin; `to` outside the      'transfer' | outside: click + 'withdraw'
//                                             vault only through that gate
//   distribute(from, ids, amt, auth)          native coin to OWN wallets only    'transfer'
//   consolidate(ids, to, auth)                OWN wallets into one of them       'transfer'
//   move.start(plan, auth)                    native/ERC-20 legs, hops           'transfer' | outside legs: click + 'withdraw'
//   bridgeSend(id, chain, to, amt, auth)      native on another EVM chain        'transfer' | outside: click + 'withdraw'
//   bridgeDeposit(id, quote, auth)            Relay quote to its recipient       click + 'transfer' | outside: click + 'withdraw'
//   relaySwap(id, quote, auth)                Relay swap quote to its recipient  click + 'transfer' | outside: click + 'withdraw'
//   remove(id, auth)                          key erased                         click + 'remove'
//   buy / sell / wrap / unwrap                trades on routes verified on chain (minOut, known venues); no gate — see trade()
//   signNote(address, message)                two fixed note formats only; never arbitrary messages, never typed data, never calldata
// Nothing here signs arbitrary calldata or an arbitrary message. restore(),
// import() and importDialog() put keys IN (importDialog: typed in this frame's dialog). policy() tells the page which gates are on and that
// they are enforced here; twofaPolicy() is how the page hands over its Privy
// access token (to read the server's gates) and its own view, which never wins.
// ── perps (phase 2): Lighter on Robinhood Chain, from this vault's own wallets (src/perpsEngine.ts) ──
const perps = createPerps({
  lane: () => !SOL_MODE && !NEAR_MODE && CFG.key === 'robinhood',
  wallet: (id) => {
    const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    if (a.ext) throw new Error('Perps trade from your vault wallets — a Privy wallet cannot sign here');
    if (a.hop || nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) throw new Error('This wallet cannot trade perps');
    return { id: a.id, name: a.name, address: a.address, lt: a.lt ? { ...a.lt } : undefined };
  },
  saveLt: async (id, rec) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); if (rec) a.lt = rec; else delete a.lt; await persist(); },
  // B1: the wallet key signs only a text that PARSES as one of Lighter's two (src/lighter/perpsCore.ts l1TextProblem): a
  // registration for this wallet's own Lighter account (the one stored with its key, which the engine took from Lighter's
  // account read of this wallet's address), or a transfer from that account to the pinned withdrawal pool with this
  // wallet's address in the memo (no pool pinned in this release: every Transfer text is refused)
  l1Sign: async (id, text, account) => {
    if (!/^(Register Lighter Account|Transfer)\n\n/.test(text) || !text.endsWith('\nOnly sign this message for a trusted client!') || text.length > 900) throw new Error('Refused: not a Lighter text');
    const a = requireUnlocked().find((x) => x.id === id); if (!a || a.ext) throw new Error('Unknown wallet');
    if (!Number.isSafeInteger(account) || a.lt?.a !== account) throw new Error('Refused: not this wallet\'s perps account');
    const why = l1TextProblem(text, { account, address: a.address, chainId: LIGHTER_CHAIN_ID });
    if (why) throw new Error('Refused: ' + why);
    return privateKeyToAccount(a.key).signMessage({ message: text });
  },
  // one Lighter API key per wallet, the same on every device (2026-10-22): its seed is HMAC-SHA256(wallet key,
  // "motion/lighter-api-key/v1" + Lighter chain id + this wallet's own Lighter account + slot 77) — perpsCore apiKeySeed.
  // The wallet key never leaves this function; the seed only goes to the signer (Lighter's seed → key derivation), never
  // to the page, a log or a message. Only the vault's own EVM-key wallets (as perps.wallet()).
  apiKeySeed: async (id, account) => {
    const a = requireUnlocked().find((x) => x.id === id); if (!a || a.ext || a.hop || nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) throw new Error('This wallet cannot trade perps');
    if (!Number.isSafeInteger(account) || account < 0) throw new Error('Bad perps account');
    return apiKeySeed(a.key, LIGHTER_CHAIN_ID, account, API_KEY_INDEX);
  },
  idemSeen: (k) => { const rec = idemRead()[k]; return !!rec && Date.now() - Number(rec.at) < IDEM_MS; },
  sendTx: async (id, tx, gas) => { const { account, client } = walletFor(id); return signAndSend(client, account, tx, await feeFor(1), gas); },
  gasPrice: () => feeFor(1),
  receipt: async (hash, ms) => { const r = await landed(hash, ms); return { status: r.status }; },
  pc: {
    readContract: (a) => publicClient.readContract(a as never),
    simulateContract: (a) => publicClient.simulateContract(a as never) as Promise<{ result: unknown }>,
    estimateGas: (a) => publicClient.estimateGas(a as never),
    getBalance: (a) => publicClient.getBalance(a),
  } as Pc,
  ask: (o) => ask(o),
  html: { esc: escHtml, sub, muted, addrRow, destBox },
  once: (opts, what, run) => once(opts, what, run),
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:perps', { detail })),
  fetch: (u, i) => fetch(u, i),
  // the pinned wasm next to the engine on this frame's own origin (vault.motion.gift; motion.gift in the app's native host)
  signer: () => loadSigner(async () => {
    const r = await fetch(new URL('/vendor/' + SIGNER.file, document.baseURI).href, { cache: 'force-cache', credentials: 'omit' });
    if (!r.ok) throw new Error(`The perps signer did not load (${r.status})`);
    return r.arrayBuffer();
  }),
  now: () => Date.now(),
  store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } },
  // one perps lane per wallet across this browser's tabs (a second tab waits), else per tab
  lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn); },
});
// ── limit orders v1 (2026-10-22, owner's variant 1): limit.place / cancel / list / sweep (src/limitEngine.ts) ──
// Robinhood frame, the vault's own EVM-key wallets. Each order gets its OWN wallet whose key is HMAC-SHA256(main key,
// "motion/limit-order/v1\n<chain>\n<orderId>") (limitCore orderKey): derived here, where the main key lives, straight into a
// signer of legacy Robinhood txs — never stored, exported, logged, posted, or in an answer or an event; any device of the
// wallet derives it again. The main key itself signs only the three fixed auth texts for our /api/limit (authTextProblem)
// and its own sends (the funding) through the wallet's send lane.
const limitWallet = (id: string) => {
  const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
  if (a.ext) throw new Error('Limit orders run from your vault wallets — a Privy wallet cannot sign here');
  if (a.hop || nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) throw new Error('This wallet cannot place limit orders');
  return a;
};
const limitChainKey = () => (CFG.key === 'bsc' ? 'bsc' : 'robinhood') as 'bsc' | 'robinhood';
// ── fee-sprint bypass (default off): the terminal fee of one wallet on a chain. feeLegFor is null unless the chain's switch is
// on (src/terminalFeeLeg.ts TERMINAL_FEE_LEG); a holder/membership discount comes from a server entitlement the vault fetches
// read-only and hands to bpsFor — a bad or missing one is the base rate, never zero (fail-closed). On but unconfigured throws.
const feeChainOf = (c: number): FeeChain | null => (c === LIMIT_CHAIN_ID ? 'robinhood' : c === BSC_CHAIN_ID ? 'bsc' : null);
const entitlementCache = new Map<string, { at: number; e: unknown }>();
async function entitlementFor(fc: FeeChain, wallet: string): Promise<unknown> {
  // read-only GET of our own server; any failure = no entitlement = base rate. Never blocks a trade.
  // (review 2026-11-09) a Solana address is case-sensitive: lower-casing it named another (nonexistent) wallet, so no Sol discount ever applied
  const w = fc === 'sol' ? wallet : wallet.toLowerCase();
  const key = fc + ':' + w;
  const hit = entitlementCache.get(key); if (hit && Date.now() - hit.at < 60_000) return hit.e;
  try {
    const base = (HOST && parentOrigin ? parentOrigin : location.origin).replace(/\/+$/, '') + (fc === 'bsc' ? '/bsc' : '');
    const r = await fetch(`${base}/api/terminal-fee/entitlement?wallet=${encodeURIComponent(w)}`, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const e = j && typeof j === 'object' && j.entitlement ? j.entitlement : null;
    entitlementCache.set(key, { at: Date.now(), e }); return e;
  } catch { entitlementCache.set(key, { at: Date.now(), e: null }); return null; }
}
async function terminalFeeLeg(chainId: number, wallet: string, cfg: FeeLegConfig = TERMINAL_FEE_LEG): Promise<{ collector: string; bps: number } | null> {
  const fc = feeChainOf(chainId); if (!fc) return null;
  const leg = feeLegFor(fc, cfg); if (!leg) return null;
  const { bps } = await bpsFor({ leg, wallet, entitlement: await entitlementFor(fc, wallet), nowMs: Date.now() }, cfg);
  return { collector: leg.collector, bps };
}
const limit = createLimit({
  // Robinhood Chain and (2026-10-25) BNB Chain: each its own order wallets (the chain is in the HMAC message), store and venues
  lane: () => !SOL_MODE && !NEAR_MODE && ((CFG.key === 'robinhood' && chain.id === LIMIT_CHAIN_ID) || (CFG.key === 'bsc' && chain.id === BSC_CHAIN_ID)),
  chain: () => (CFG.key === 'bsc' ? 'bsc' : 'robinhood'),
  wallet: (id) => { const a = limitWallet(id); return { id: a.id, name: a.name, address: a.address }; },
  wallets: () => requireUnlocked().filter((a) => !a.ext && !a.hop && !nativeChainOf(a.key) && /^0x[0-9a-fA-F]{64}$/.test(a.key)).map((a) => ({ id: a.id, name: a.name, address: a.address })),
  // review H1: the order id at index i is HMAC(main key, "motion/limit-order-id/v1\n<chain>\n<i>") — recoverable from the key alone
  orderIdAt: (id, index) => orderIdOf(limitWallet(id).key, limitChainKey(), index),
  orderSigner: async (id, orderId): Promise<OrderSigner> => {
    const acct = privateKeyToAccount(await orderKey(limitWallet(id).key, limitChainKey(), orderId));
    return { address: acct.address, sign: (tx) => acct.signTransaction({ to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice, chainId: chain.id, type: 'legacy' } as never) };
  },
  signAuth: async (id, text) => { const a = limitWallet(id); const why = authTextProblem(text, a.address, limitChainKey()); if (why) throw new Error('Refused: ' + why); return privateKeyToAccount(a.key).signMessage({ message: text }); },
  sendTx: async (id, tx, gas) => { const { account, client } = walletFor(id); return signAndSend(client, account, tx, await feeFor(1), gas); },
  broadcast: (raw) => broadcast(raw),
  receipt: async (hash, ms) => { const r = await landed(hash, ms); return { status: r.status }; },
  verifyRoute: (token, route) => verifyRoute(token, route as Route),
  // review L1: the curve's creator tax from the launchpad's own registry (getLaunchedToken word 7), not the page's route
  ponsCreatorTax: async (token) => {
    if (!CFG.ponsFactory) throw new Error('No Pons registry here');
    const data = await rawCall(CFG.ponsFactory, (PONS_GET_LAUNCHED + padAddr(token)) as `0x${string}`);
    if (data.length < 2 + 64 * 15) throw new Error('The launchpad registry does not know this token');
    return Number(wordInt(data, 7));
  },
  gasPrice: () => feeFor(1),
  pc: {
    getBlock: () => publicClient.getBlock(),
    getGasPrice: () => publicClient.getGasPrice(),
    getBalance: (a) => publicClient.getBalance(a),
    getTransactionCount: (a) => publicClient.getTransactionCount(a),
    estimateGas: (a) => publicClient.estimateGas({ account: a.account, to: a.to, data: a.data, value: a.value, prepare: false } as never),
    call: (a) => publicClient.call({ account: a.account, to: a.to, data: a.data, value: a.value }),
    readContract: (a) => publicClient.readContract(a as never),
    getTransactionReceipt: (a) => publicClient.getTransactionReceipt(a).then((r) => ({ status: r.status }), () => null),
    // review M2: the payout probe (limitCore DELTA_PROBE_CODE) as a state override on the order wallet, like ethDeltaOf
    callOverride: (a) => heavy.request({ method: 'eth_call', params: [{ to: a.to, data: a.data }, 'latest', { [a.to]: { code: a.code } }] } as never) as Promise<`0x${string}`>,
  },
  tokenMeta: async (t) => { const [symbol, decimals] = await Promise.all([tokenSymbolOf(t).catch(() => '?'), tokenDecimals(t)]); return { symbol, decimals }; },
  ask: (o) => ask(o),
  html: { esc: escHtml, sub, muted, addrRow },
  once: (opts, what, run) => once(opts, what, run),
  idemSeen: (k) => { const rec = idemRead()[k]; return !!rec && Date.now() - Number(rec.at) < IDEM_MS; },
  lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn); },
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:limit', { detail })),
  fetch: (u, i) => fetch(u, i),
  // our own server only: the terminal that framed the vault (the same origin the 2FA check goes to)
  api: () => (HOST && parentOrigin ? parentOrigin : location.origin),
  store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } },
  now: () => Date.now(),
  feeLeg: async (main) => terminalFeeLeg(chain.id, main) as Promise<{ collector: `0x${string}`; bps: number } | null>,
});
// ── limit orders on Solana (2026-10-25; src/solLimitEngine.ts, trench docs/drafts/LIMIT-ORDERS.md §14) ──
// The Solana frame, the vault's own key wallets. Each order's wallet seed is HMAC-SHA256(main Solana seed,
// "motion/limit-order/v1\nsol\n<orderId>") (solLimitCore solOrderKeys): derived here, straight into a signer, never stored,
// exported, logged, posted, or in an answer or event. The main seed signs the funding transfer and the three fixed auth
// texts for our /sol/api/limit (solAuthTextProblem) — nothing else.
const solLimitWallet = (id: string) => {
  const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
  if (a.ext || !a.key) throw new Error('Limit orders run from your vault wallets — a Privy wallet cannot sign here');
  if (a.hop || nativeChainOf(a.key) === 'near') throw new Error('This wallet cannot place Solana limit orders');
  return { a, k: solKeys(a.key) };
};
const solLimit = createSolLimit({
  lane: () => SOL_MODE,
  wallet: (id) => { const { a, k } = solLimitWallet(id); return { id: a.id, name: a.name, address: k.address }; },
  wallets: () => requireUnlocked().filter((a) => !a.ext && a.key && !a.hop && nativeChainOf(a.key) !== 'near').map((a) => ({ id: a.id, name: a.name, address: solKeys(a.key).address })),
  orderIdAt: (id, index) => solOrderIdOf(solLimitWallet(id).k.seed, index),
  orderSigner: (id, orderId) => { const o = solOrderKeys(solLimitWallet(id).k.seed, orderId); return { address: o.address, sign: (message) => solSignMessage(message, o.seed).sig }; },
  mainSign: (id, message) => solSignMessage(message, solLimitWallet(id).k.seed).sig,
  signAuth: (id, text) => { const { k } = solLimitWallet(id); const why = solAuthTextProblem(text, k.address); if (why) throw new Error('Refused: ' + why); return solSignText(solLimitWallet(id).a.key, text); },
  route: (mint) => solRoute(mint),
  venueIxs: (user, r, venue, side, amount, minOut) => solVenueIxs(user, r as never, venue, side, amount, minOut),
  budget: (units, micro) => solBudget(units, micro),
  compile: (payer, ixs, blockhash) => solCompile(payer, ixs as never, blockhash),
  plan: async () => { const p = await solSendPlan({ ...loadSettings(), turbo: false, gasBoost: 2 } as never); return { micro: p.micro, tipLamports: p.tipLamports }; },
  blockhash: () => solBlockhashInfo(),
  accounts: (addrs) => solAccounts(addrs) as never,
  simulate: (tx, addrs) => solSimulateAccounts(tx, addrs),
  errText: (sim, side, venue) => solErrText(sim, side, venue),
  send: (tx, holdKey, lvh) => solLimitSend(tx, holdKey, lvh),
  statuses: (sigs) => solSigStatusesBoth(sigs),
  ask: (o) => ask(o),
  html: { esc: escHtml, sub, muted, addrRow },
  once: (opts, what, run) => once(opts, what, run),
  lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn); },
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:limit', { detail })),
  fetch: (u, i) => fetch(u, i),
  api: () => (HOST && parentOrigin ? parentOrigin : location.origin),
  store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } },
  now: () => Date.now(),
  feeLeg: (main) => terminalFeeLegSol(main),
});
// (fee-sprint bypass, default off) a Solana leg: feeLegFor('sol') is null unless its switch is on; the discount comes from the
// same read-only entitlement endpoint; an unconfigured 'sol' collector throws rather than trade fee-free.
async function terminalFeeLegSol(wallet: string, cfg: FeeLegConfig = TERMINAL_FEE_LEG): Promise<{ collector: string; bps: number } | null> {
  const leg = feeLegFor('sol', cfg); if (!leg) return null;
  const { bps } = await bpsFor({ leg, wallet, entitlement: await entitlementFor('sol', wallet), nowMs: Date.now() }, cfg);
  return { collector: leg.collector, bps };
}
// one limit.* surface for the page: the Solana frame's orders there, the EVM frame's elsewhere
const limitApi = {
  place: (o: unknown) => (SOL_MODE ? solLimit.place(o) : limit.place(o)),
  cancel: (o: unknown) => (SOL_MODE ? solLimit.cancel(o) : limit.cancel(o)),
  list: (o: unknown) => (SOL_MODE ? solLimit.list(o) : limit.list(o)),
  sweep: (o: unknown) => (SOL_MODE ? solLimit.sweep(o) : limit.sweep(o)),
};
// ── one USD balance (src/floatEngine.ts) ──
// The trade path never reaches this block (I1): the only thing a trade does for it is stamp the click clock below —
// one write, no await, no network. Everything the float reads on EVM goes through ITS OWN client: the trade's nodes minus
// the trade's first one, through a token bucket of 1 request/s (I2). R's key is derived here from W's key on every use and
// lives only in the signer it is handed to; it is never stored, posted, returned or put in an event.
// clicks: the last 8 trade entries' times (2026-10-29: the ready float sees a burst of buys at the click, not a confirmation later)
const floatClock = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null as string | null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false, clicks: [] as number[] };
let clicksRunning = 0;
const clickRun = <T,>(run: () => Promise<T>): Promise<T> => {
  const t = Date.now(); floatClock.clickAt = t; floatClock.lastTradeAt = t; clicksRunning += 1; floatClock.clicks.push(t); if (floatClock.clicks.length > 8) floatClock.clicks.shift();
  const p = run();
  const done = () => { clicksRunning = Math.max(0, clicksRunning - 1); floatClock.clickDoneAt = Date.now(); };
  p.then(done, done);
  return p;
};
const floatLane = (): FloatChain | null => (SOL_MODE ? 'sol' : NEAR_MODE ? null : CFG.key === 'robinhood' || CFG.key === 'bsc' ? CFG.key as FloatChain : null);
const floatUrls = () => { const u = readUrls(); const rest = u.slice(1); return rest.length ? rest : u; };
let floatPcCache: { key: string; pc: ReturnType<typeof createPublicClient> } | null = null;
const floatPc = () => { const urls = floatUrls(); const key = urls.join('|'); if (!floatPcCache || floatPcCache.key !== key) floatPcCache = { key, pc: createPublicClient({ chain, transport: mkTransport(urls, false) }) }; return floatPcCache.pc; };
const floatBucket = floatBucketOf(1, 3, () => Date.now());
const floatWait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
// I3, enforced at the source: while a trade runs (call → broadcast + 2 s) no float request leaves this frame — a float step
// already under way simply waits here (a token page's 10 s focus window is applied per tick by floatEngine, so the one
// urgent top-up a waiting click asked for still runs)
const tradeRunning = () => clicksRunning > 0 || Date.now() - floatClock.clickDoneAt < 2_000;
// while a dialog-confirmed USD conversion runs (floatFast > 0) its steps skip the bucket: the user is watching it
let floatFast = 0;
async function floatFastly<T>(fn: () => Promise<T>): Promise<T> { floatFast++; try { return await fn(); } finally { floatFast--; } }
async function floatRpc<T>(fn: (pc: ReturnType<typeof createPublicClient>) => Promise<T>): Promise<T> {
  while (tradeRunning()) await floatWait(100);
  const w = floatFast > 0 ? 0 : floatBucket.take(); if (w > 0) await floatWait(w);
  while (tradeRunning()) await floatWait(100);
  return fn(floatPc());
}
// the same source gate and bucket for the float steps that have no client of their own: the Solana reads and sends (the
// frame has one set of Solana roads) and W's sends (W's own send lane and nonce counter, shared with its trades)
async function floatQuiet<T>(fn: () => Promise<T>): Promise<T> {
  while (tradeRunning()) await floatWait(100);
  const w = floatFast > 0 ? 0 : floatBucket.take(); if (w > 0) await floatWait(w);
  while (tradeRunning()) await floatWait(100);
  return fn();
}
const reserveOf = (a: Account) => { const key = reserveKeyOf(a.key); return { key, evm: privateKeyToAccount(key).address as `0x${string}`, sol: solAddressOf({ id: a.id + ':r', name: a.name, address: '', key }) }; };
const floatAccount = (id: string) => {
  const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
  if (a.ext) throw new Error('USD balance works with your vault wallets — a Privy wallet cannot sign here');
  if (a.hop || nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) throw new Error('This wallet cannot hold a USD balance');
  return a;
};
// `rpc`: the background bucket (floatRpc), or the click path (floatNow) for a dialog's read
const floatFees = async (rpc: typeof floatRpc = floatRpc) => {
  const [gp, block] = await Promise.all([rpc((pc) => pc.getGasPrice()), rpc((pc) => pc.getBlock()).catch(() => null)]);
  let l1PerByte = 0n;
  // Robinhood (Arbitrum Orbit): ArbGasInfo.getPricesInWei()[1] = wei per L1 calldata byte (0 on 2026-10-25)
  if (CFG.key === 'robinhood') { try { const r = await rpc((pc) => pc.call({ to: '0x000000000000000000000000000000000000006C', data: '0x41b247a8' })); if (r.data && r.data.length >= 130) l1PerByte = BigInt('0x' + r.data.slice(66, 130)); } catch {} }
  return { baseFee: block?.baseFeePerGas ?? gp, gasPrice: gp, l1PerByte };
};
// the legacy price every engine send signs (feeFloor's rule: max(base fee, gas price) × 1.25), read through the float's client
const floatGasPrice = async () => {
  const fees = await floatFees(); const floor = ((fees.baseFee > fees.gasPrice ? fees.baseFee : fees.gasPrice) * 125n) / 100n;
  if (CFG.maxGasPrice && floor > CFG.maxGasPrice) throw new Error('Gas price is far above normal for this chain — refusing');
  return floor;
};
// R signs on its own lane (the cross-tab lock on its address) and its own nonce, read from the float's client; the bytes go
// to the float's nodes only. A send whose answer was lost is UNKNOWN with its hash — the runner reconciles, never re-sends.
async function floatSendR(walletId: string, tx: EvmTx, gas: bigint, signed?: (nonce: number) => void): Promise<`0x${string}`> {
  const r = reserveOf(floatAccount(walletId)); const account = privateKeyToAccount(r.key);
  return laneLock(account.address, async () => {
    const [chainNonce, floor] = await Promise.all([floatRpc((pc) => pc.getTransactionCount({ address: account.address, blockTag: 'pending' })), floatGasPrice()]);
    // a transfer this frame signed for motion's bridge but did NOT broadcast itself holds its nonce for two minutes
    // (bridgeHeldNonce): R's own sends go after it, so the two can never collide at one nonce
    const heldR = bridgeHeldNonce.get(account.address.toLowerCase());
    const nonce = heldR && Date.now() - heldR.at < BRIDGE_HOLD_MS && heldR.nonce >= chainNonce ? heldR.nonce + 1 : chainNonce;
    if (CFG.maxFeeWei && gas * floor > CFG.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
    const raw = await account.signTransaction({ to: tx.to, data: tx.data, value: tx.value, gas, gasPrice: floor, nonce, chainId: chain.id, type: 'legacy' } as never);
    // (Earn r6: the caller may want the exact nonce this transaction carries — earnSendR only; the float's own sends pass nothing)
    try { signed?.(nonce); } catch { /* the caller's bookkeeping never stops a send */ }
    const local = keccak256(raw);
    try { const h = await floatRpc((pc) => pc.request({ method: 'eth_sendRawTransaction', params: [raw] }) as Promise<string>); if (String(h).toLowerCase() !== local.toLowerCase()) throw new Error('node returned a different transaction hash'); return local; }
    catch (e) { const m = String((e as Error)?.message || e); if (/already known|known transaction/i.test(m)) return local; if (LOST.test(m)) throw Object.assign(new FloatUnknown(`Reserve send outcome unknown (${m.slice(0, 60)})`), { hash: local }); throw e; }
  });
}
// W's sends (an idle sweep, R's gas): W's own send lane and nonce counter, like every engine send, so they never collide
// with W's trades at a nonce. The price is read through the float's client (not the trade's fee cache), and the lane is
// entered only through the source gate, with the gas fixed, so nothing is left to ask a node before W's signature.
async function floatSendW(walletId: string, tx: EvmTx, gas: bigint): Promise<`0x${string}`> {
  const { account, client } = walletFor(floatAccount(walletId).id);
  const price = await floatGasPrice();
  return floatQuiet(() => signAndSend(client, account, tx, price, gas));
}
const SOL_ORACLE_POOL = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';   // Meteora DLMM SOL/USDC bin step 4: the price, never the pool swapped through
// the reserve's USDC on Solana (owner 2026-10-26: a stuck Solana swap): read with getMultipleAccounts (8 amount bytes),
// never getTokenAccountBalance — on an account that does not exist yet that call errors, and the Solana roads count the
// error as a node failure, benching publicnode for 30 s and pushing every Solana send (trades too) onto slower roads
const solUsdcOf = async (owner: string) => {
  try {
    const r = await solFloatRpc<any>('getMultipleAccounts', [[solFloatAta(owner, FLOAT_CFG.sol.stable.address)], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 64, length: 8 } }]);
    const a = Array.isArray(r?.value) ? r.value[0] : undefined;
    if (a === null) return 0n;                                            // no USDC account yet = 0
    if (!a || a.owner !== SOL_P.token) return 0n;
    const b = Uint8Array.from(atob(a.data[0]), (ch) => ch.charCodeAt(0)); return b.length === 8 ? new DataView(b.buffer).getBigUint64(0, true) : 0n;
  } catch { return 0n; }
};
const solAcctsOf = (walletId: string) => { const a = floatAccount(walletId); const r = reserveOf(a); return { w: { id: a.id, name: a.name, address: solAddressOf(a), key: a.key }, r: { id: a.id + ':r', name: a.name + ' reserve', address: r.sol, key: r.key } }; };
// the pinned pool's route, kept 3 s (2026-10-28): a click's top-up read it for its price check and again for its swap, one
// round trip apart. Only the route is kept (the pool's sides, its oracle, where its active bin array was): the quote and the
// swap read the pool and its bin arrays fresh every time (floatMarket), and the swap is simulated before it is signed
let solFloatPoolMemo: { at: number; p: Promise<Awaited<ReturnType<typeof solFloatRoute>>> } | null = null;
const solFloatPool = () => {
  if (solFloatPoolMemo && Date.now() - solFloatPoolMemo.at < 3_000) return solFloatPoolMemo.p;
  const m = { at: Date.now(), p: solFloatRoute(FLOAT_CFG.sol.dlmmPool, FLOAT_CFG.sol.stable.address) };
  m.p.catch(() => { if (solFloatPoolMemo === m) solFloatPoolMemo = null; });
  solFloatPoolMemo = m;
  return m.p;
};
// ── motion's own bridge: the two signatures the vault may make for it ──
// The solver's quote-signing PUBLIC key, pinned in this build (docs/drafts/MOTION-BRIDGE.md §4). Empty = the vault does
// not know motion's bridge at all: every cross-chain move takes Relay, exactly as before. The owner pastes the key the
// solver prints when he creates it; nothing here ever holds a private key of motion's.
const MOTION_SOLVER_KEY = 'ad560a15c20fbc687fab7dcac4f5f44f661dcc5356bce4ea5dfd5b3d0ae6725a';   // the quote key's PUBLIC half, printed by the live solver's /health (2026-10-26)
// The ONE float path that does not queue behind the 1 request/s bucket: the two reads of a fill the user is standing
// in front of (a cold top-up through motion's own bridge — nonce and gas price, ~2 requests). It still waits out a
// running trade (I3) and still uses the float's own nodes (I2); the bucket exists to keep BACKGROUND upkeep off the
// nodes, and a bucket wait here would spend the whole second this bridge exists to save.
async function bridgeRpc<T>(fn: (pc: ReturnType<typeof createPublicClient>) => Promise<T>): Promise<T> {
  while (tradeRunning()) await floatWait(100);
  return fn(floatPc());
}
async function bridgeQuiet<T>(fn: () => Promise<T>): Promise<T> {
  while (tradeRunning()) await floatWait(100);
  return fn();
}
const bridgeGasPrice = async () => {
  const [gp, block] = await Promise.all([bridgeRpc((pc) => pc.getGasPrice()), bridgeRpc((pc) => pc.getBlock()).catch(() => null)]);
  const base = block?.baseFeePerGas ?? gp;
  const floor = ((base > gp ? base : gp) * 125n) / 100n;
  if (CFG.maxGasPrice && floor > CFG.maxGasPrice) throw new Error('Gas price is far above normal for this chain — refusing');
  return floor;
};
// a nonce this frame signed for the solver but did NOT broadcast itself: R's next own send goes after it, so the two
// can never collide at one nonce. Forgotten after 2 minutes (by then the fill has landed, failed or been reconciled).
const bridgeHeldNonce = new Map<string, { nonce: number; at: number; hash?: string }>();
const BRIDGE_HOLD_MS = 120_000;
// the solver answered sent:false for these bytes (it broadcast nothing): their nonce is free again. The next transfer of
// that reserve then signs at the SAME nonce, so the old bytes and the new can never both land (2026-10-28: held, the next
// one took nonce + 1 behind a nonce nobody would ever send, and could only land once something else used it)
function bridgeRelease(a: { chain: string; hash: string }): void {
  const h = String(a.hash || '').toLowerCase(); if (!h) return;
  for (const [k, v] of bridgeHeldNonce) if (v.hash && v.hash.toLowerCase() === h) bridgeHeldNonce.delete(k);
}
// ONE ERC-20 transfer from R to the solver's deposit address — signed, never sent from here
async function bridgeSignEvmTransfer(a: { walletId: string; chain: string; token: string; to: string; amount: bigint }): Promise<{ raw: string; hash: string }> {
  // the Solana / NEAR frames have no EVM lane of their own (CFG falls back to Robinhood's): always that chain's own nodes
  if (a.chain !== CFG.key || SOL_MODE || NEAR_MODE) return bridgeSignEvmTransferOn(a);
  const r = reserveOf(floatAccount(a.walletId)); const account = privateKeyToAccount(r.key);
  return laneLock(account.address, async () => {
    const [chainNonce, floor] = await Promise.all([bridgeRpc((pc) => pc.getTransactionCount({ address: account.address, blockTag: 'pending' })), bridgeGasPrice()]);
    const held = bridgeHeldNonce.get(account.address.toLowerCase());
    const nonce = held && Date.now() - held.at < BRIDGE_HOLD_MS && held.nonce >= chainNonce ? held.nonce + 1 : chainNonce;
    const gas = 120_000n;
    if (CFG.maxFeeWei && gas * floor > CFG.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
    const raw = await account.signTransaction({ to: a.token as `0x${string}`, data: bridgeTransferData(a.to, a.amount) as `0x${string}`, value: 0n, gas, gasPrice: floor, nonce, chainId: chain.id, type: 'legacy' } as never);
    const hash = keccak256(raw);
    bridgeHeldNonce.set(account.address.toLowerCase(), { nonce, at: Date.now(), hash });
    return { raw, hash };
  }) as Promise<{ raw: string; hash: string }>;
}
// the same ONE transfer from ANOTHER EVM chain's reserve, signed in this frame for a waiting click (2026-10-27: a BNB buy's
// cold top-up from the Robinhood reserve waited for a Robinhood frame that was not open, and the buy failed). That chain's
// own nodes give its nonce and gas price, its own F-73 ceilings apply, the chain id is its own; signed, never sent from here
const bridgeOtherPcs = new Map<string, ReturnType<typeof createPublicClient>>();
function bridgeOtherPc(oc: ChainCfg): ReturnType<typeof createPublicClient> {
  let pc = bridgeOtherPcs.get(oc.key);
  if (!pc) {
    const ch = defineChain({ id: oc.id, name: oc.name, nativeCurrency: { name: oc.symbol, symbol: oc.symbol, decimals: 18 }, rpcUrls: { default: { http: [oc.rpc] } } });
    pc = createPublicClient({ chain: ch, transport: fallback([http(oc.rpc), http(oc.rpc2)]) }) as ReturnType<typeof createPublicClient>; bridgeOtherPcs.set(oc.key, pc);
  }
  return pc;
}
// another EVM chain's reserve, read for a click's cold top-up (its stable and its native gas), on that chain's own nodes
async function bridgeReserveOn(chainKey: string, token: `0x${string}`, owner: `0x${string}`): Promise<{ stable: bigint; native: bigint }> {
  const oc = CHAIN_CFGS[chainKey]; if (!oc) throw new Error('unknown chain');
  while (tradeRunning()) await floatWait(100);
  const pc = bridgeOtherPc(oc);
  const [stable, native] = await Promise.all([pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>, pc.getBalance({ address: owner })]);
  return { stable, native };
}
// ── the trading wallet's OWN native on another EVM chain, for a waiting click its reserves cannot cover (src/nativeDonor.ts,
// floatEngine nativeDonorRun; 2026-10-30, owner “approved if it helps and makes it faster”) ──
// The read: W's native there, that chain's on-chain oracle (the same pool its own frame prices the USD balance with) and the
// legacy price W would sign at — on that chain's own nodes, side by side, after a running trade (as bridgeReserveOn)
async function nativeDonorRead(chainKey: string, owner: `0x${string}`): Promise<{ native: bigint; price6: bigint; gasPrice: bigint }> {
  const oc = CHAIN_CFGS[chainKey]; const fc = (FLOAT_CFG as Record<string, (typeof FLOAT_CFG)[FloatChain]>)[chainKey];
  if (!oc || !fc || fc.kind !== 'evm') throw new Error('unknown chain');
  while (tradeRunning()) await floatWait(100);
  const pc = bridgeOtherPc(oc);
  const [native, sq, gp, block] = await Promise.all([pc.getBalance({ address: owner }), pc.call({ to: fc.oracle.pool, data: '0x3850c7bd' }), pc.getGasPrice(), pc.getBlock().catch(() => null)]);
  const s0 = sq.data && /^0x[0-9a-fA-F]{64}/.test(sq.data) ? BigInt(sq.data.slice(0, 66)) : 0n;
  if (!(s0 > 0n)) throw new Error('that chain\'s price was not read');
  const base = block?.baseFeePerGas ?? gp; const floor = ((base > gp ? base : gp) * 125n) / 100n;
  if (oc.maxGasPrice && floor > oc.maxGasPrice) throw new Error('Gas price is far above normal for that chain — refusing');
  return { native, price6: floatOraclePrice6(s0, fc.oracle), gasPrice: floor };
}
// The send: W signs ONE Relay depositNative on that chain and broadcasts it on that chain's nodes. Whatever floatEngine checked,
// this refuses anything but Relay's pinned depository with a depositNative(THIS wallet, id) of exactly two words, a gas limit
// within NATIVE_DONOR.gasMax and the chain's F-73 ceilings, and a wallet that cannot pay the value plus the gas. W's nonce on
// that chain comes from that chain's nodes ('pending'); its lane is that chain + address (never this frame's own trade lane).
// A send whose answer was lost is UNKNOWN with its hash: followed through Relay, never re-sent
async function nativeDonorSend(walletId: string, chainKey: string, tx: EvmTx, gas: bigint): Promise<`0x${string}`> {
  const oc = CHAIN_CFGS[chainKey]; if (!oc || !(chainKey === 'robinhood' || chainKey === 'bsc')) throw new Error('unknown chain');
  const a = floatAccount(walletId); const account = privateKeyToAccount(a.key as `0x${string}`);
  const bad = nativeDonorTxProblem(tx, account.address, gas); if (bad) throw new Error('Refusing to sign: ' + bad);
  const pc = bridgeOtherPc(oc);
  return laneLock(oc.key + ':' + account.address.toLowerCase(), async () => {
    while (tradeRunning()) await floatWait(100);
    const [nonce, gp, block, bal] = await Promise.all([pc.getTransactionCount({ address: account.address, blockTag: 'pending' }), pc.getGasPrice(), pc.getBlock().catch(() => null), pc.getBalance({ address: account.address })]);
    const base = block?.baseFeePerGas ?? gp; const floor = ((base > gp ? base : gp) * 125n) / 100n;
    if (oc.maxGasPrice && floor > oc.maxGasPrice) throw new Error('Gas price is far above normal for that chain — refusing');
    if (oc.maxFeeWei && gas * floor > oc.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
    if (bal < tx.value + gas * floor) throw new Error(`Not enough ${oc.symbol} on ${oc.name} for the move and its gas`);
    const raw = await account.signTransaction({ to: tx.to, data: tx.data, value: tx.value, gas, gasPrice: floor, nonce, chainId: oc.id, type: 'legacy' } as never);
    const local = keccak256(raw);
    try { const h = await pc.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) as string; if (String(h).toLowerCase() !== local.toLowerCase()) throw new Error('node returned a different transaction hash'); return local; }
    catch (e) { const m = String((e as Error)?.message || e); if (/already known|known transaction/i.test(m)) return local; if (LOST.test(m)) throw Object.assign(new FloatUnknown(`Deposit send outcome unknown (${m.slice(0, 60)})`), { hash: local }); throw e; }
  }) as Promise<`0x${string}`>;
}
// W's stable sent straight to the trading wallet on ANOTHER EVM chain, forwarded to its own R there (floatEngine
// forwardElsewhere, 2026-11-01). Built here, nothing from the caller but the amount: ONE transfer(R of THIS wallet, amount) of
// that chain's float stable (FLOAT_CFG), gas 90 000 within the chain's F-73 ceilings, W's nonce on that chain ('pending') on
// its own lane (that chain + address; never this frame's own trade lane), after a running trade. Refused when W holds less of
// the stable than the amount or cannot pay the gas. A send whose answer was lost is UNKNOWN with its hash (never re-sent)
async function wForwardSend(walletId: string, chainKey: string, amount: bigint): Promise<`0x${string}`> {
  const oc = CHAIN_CFGS[chainKey]; const fc = (FLOAT_CFG as Record<string, (typeof FLOAT_CFG)[FloatChain]>)[chainKey];
  if (!oc || !fc || fc.kind !== 'evm' || !(chainKey === 'robinhood' || chainKey === 'bsc')) throw new Error('unknown chain');
  if (!(amount > 0n)) throw new Error('Refusing to sign: nothing to forward');
  const a = floatAccount(walletId); const account = privateKeyToAccount(a.key as `0x${string}`); const r = reserveOf(a);
  const pc = bridgeOtherPc(oc); const gas = 90_000n; const token = fc.stable.address as `0x${string}`;
  return laneLock(oc.key + ':' + account.address.toLowerCase(), async () => {
    while (tradeRunning()) await floatWait(100);
    const [nonce, gp, block, bal, held] = await Promise.all([pc.getTransactionCount({ address: account.address, blockTag: 'pending' }), pc.getGasPrice(), pc.getBlock().catch(() => null), pc.getBalance({ address: account.address }),
      pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>]);
    // the node's own price, never above it (2026-11-01, audit pass 2: p2-money-forward-nonce-race): this runs from another
    // chain's frame with W's 'pending' nonce, and the trade core in that chain's own tab signs from its cached nonce without this
    // lock — at 1.25x it could REPLACE a pending buy at the same nonce (a node takes a same-nonce replacement at +10 %). At the
    // node's price it never can (the trade pays at least that); a collision now only costs the forward a retry
    const base = block?.baseFeePerGas ?? gp; const floor = base > gp ? base : gp;
    if (oc.maxGasPrice && floor > oc.maxGasPrice) throw new Error('Gas price is far above normal for that chain — refusing');
    if (oc.maxFeeWei && gas * floor > oc.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
    if (held < amount) throw new Error('Refusing to sign: the wallet holds less than that on ' + oc.name);
    if (bal < gas * floor) throw new Error(`Not enough ${oc.symbol} on ${oc.name} for the transfer's gas`);
    const raw = await account.signTransaction({ to: token, data: bridgeTransferData(r.evm, amount) as `0x${string}`, value: 0n, gas, gasPrice: floor, nonce, chainId: oc.id, type: 'legacy' } as never);
    const local = keccak256(raw);
    try { const h = await pc.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) as string; if (String(h).toLowerCase() !== local.toLowerCase()) throw new Error('node returned a different transaction hash'); return local; }
    catch (e) { const m = String((e as Error)?.message || e); if (/already known|known transaction/i.test(m)) return local; if (LOST.test(m)) throw Object.assign(new FloatUnknown(`Forward send outcome unknown (${m.slice(0, 60)})`), { hash: local }); throw e; }
  }) as Promise<`0x${string}`>;
}
async function nativeDonorReceipt(chainKey: string, hash: `0x${string}`): Promise<'success' | 'reverted' | null> {
  const oc = CHAIN_CFGS[chainKey]; if (!oc) return null;
  const r = await bridgeOtherPc(oc).getTransactionReceipt({ hash }).catch(() => null);
  return r ? r.status : null;
}
async function bridgeSignEvmTransferOn(a: { walletId: string; chain: string; token: string; to: string; amount: bigint }): Promise<{ raw: string; hash: string }> {
  const oc = CHAIN_CFGS[a.chain]; if (!oc) throw new Error('That chain is another frame');
  const pc = bridgeOtherPc(oc);
  const r = reserveOf(floatAccount(a.walletId)); const account = privateKeyToAccount(r.key);
  const hk = oc.key + ':' + account.address.toLowerCase();
  return laneLock(hk, async () => {
    while (tradeRunning()) await floatWait(100);
    const [chainNonce, gp, block] = await Promise.all([pc!.getTransactionCount({ address: account.address, blockTag: 'pending' }), pc!.getGasPrice(), pc!.getBlock().catch(() => null)]);
    const base = block?.baseFeePerGas ?? gp; const floor = ((base > gp ? base : gp) * 125n) / 100n;
    if (oc.maxGasPrice && floor > oc.maxGasPrice) throw new Error('Gas price is far above normal for that chain — refusing');
    const held = bridgeHeldNonce.get(hk);
    const nonce = held && Date.now() - held.at < BRIDGE_HOLD_MS && held.nonce >= chainNonce ? held.nonce + 1 : chainNonce;
    const gas = 120_000n;
    if (oc.maxFeeWei && gas * floor > oc.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
    const raw = await account.signTransaction({ to: a.token as `0x${string}`, data: bridgeTransferData(a.to, a.amount) as `0x${string}`, value: 0n, gas, gasPrice: floor, nonce, chainId: oc.id, type: 'legacy' } as never);
    const hash = keccak256(raw);
    bridgeHeldNonce.set(hk, { nonce, at: Date.now(), hash });
    return { raw, hash };
  }) as Promise<{ raw: string; hash: string }>;
}
// ONE SPL transferChecked from R's token account to the solver's, with the quote id in a memo — signed, never sent. The
// same in every frame: the Solana frame, and an EVM frame whose click takes its top-up from the Solana reserve (2026-10-27)
// — there the blockhash comes from that frame's own Solana roads (publicnode, then motion's /sol/api/rpc; the vault CSP
// lists both for every lane), and nothing of the frame's EVM trade path is touched
async function bridgeSignSolTransfer(a: { walletId: string; mint: string; to: string; amount: bigint; decimals: number; memo: string }): Promise<{ raw: string; sig: string }> {
  return bridgeQuiet(async () => {
    const { r } = solAcctsOf(a.walletId);
    const k = solKeys(r.key as string);
    const ixs = solBridgeTransferIxs({ owner: r.address, src: solFloatAta(r.address, a.mint), dst: solFloatAta(a.to, a.mint), mint: a.mint, amount: a.amount, decimals: a.decimals, memo: a.memo, units: SOL_BRIDGE.units, micro: BigInt(SOL_BRIDGE.micro) });
    const bh = await solBlockhashInfo();
    const { tx, sig } = solSignMessage(solCompile(r.address, ixs, bh.blockhash), k.seed);
    if (tx.length > 1232) throw new Error('Transaction too large');
    return { raw: btoa(String.fromCharCode(...tx)), sig: solB58e(sig) };
  });
}
// the Solana reserve, read from an EVM frame for a click's cold top-up (2026-10-27): R's lamports (its one transfer's fee) and
// R's USDC (8 amount bytes of its token account) in ONE getMultipleAccounts on this frame's Solana roads, after a running
// trade. An absent account is 0; a failed or malformed read throws (the plan then goes on as before)
async function bridgeSolReserveOn(owner: string): Promise<{ stable: bigint; native: bigint }> {
  while (tradeRunning()) await floatWait(100);
  const r = await solFloatRpc<any>('getMultipleAccounts', [[owner, solFloatAta(owner, FLOAT_CFG.sol.stable.address)], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 64, length: 8 } }]);
  const v = Array.isArray(r?.value) && r.value.length === 2 ? r.value as ({ lamports: number; owner: string; data: [string, string] } | null)[] : null;
  if (!v) throw new Error('the Solana reserve was not read');
  const native = v[0] ? BigInt(v[0].lamports) : 0n;
  let stable = 0n;
  if (v[1]) {
    if (v[1].owner !== SOL_P.token) throw new Error('not a token account');
    const b = Uint8Array.from(atob(v[1].data[0]), (ch) => ch.charCodeAt(0)); if (b.length !== 8) throw new Error('bad token account');
    stable = new DataView(b.buffer).getBigUint64(0, true);
  }
  return { stable, native };
}
// ── the USD balance's click path (owner, 2026-10-26: "Turn on" took ~40 s to show its dialog) ──
// The reads a user's click is waiting on — the switch's dialogs and the app's pre-dialog status (float.status `fresh`) —
// skip the 1 request/s bucket, like bridgeRpc, and still wait out a running trade at the source (I3: floatCore
// afterTrade on tradeRunning) on the float's own nodes (I2). They are batched: on EVM ONE Multicall3 aggregate3 eth_call
// reads the oracle pool's slot0 and every wallet's W native, R native and R stable (allowFailure: a failed entry is "not
// read", never a zero); on Solana getMultipleAccounts in slices of 10 (publicnode's limit), side by side. The gas is read
// once per batch. Background ticks, sweeps, receipts and every send stay behind the bucket.
async function floatNow<T>(fn: (pc: ReturnType<typeof createPublicClient>) => Promise<T>): Promise<T> {
  return afterTrade(tradeRunning, floatWait, () => fn(floatPc()));
}
async function floatNowQuiet<T>(fn: () => Promise<T>): Promise<T> {
  return afterTrade(tradeRunning, floatWait, fn);
}
const word0 = (d: string | undefined): bigint | null => (d && /^0x[0-9a-fA-F]{64}/.test(d) ? BigInt(d.slice(0, 66)) : null);
async function floatSheetEvm(pool: `0x${string}`, stable: `0x${string}`, ws: { w: `0x${string}`; r: `0x${string}` }[]) {
  const bal = (a: `0x${string}`) => ({ target: MULTICALL3, allowFailure: true, callData: encodeFunctionData({ abi: multicall3Abi, functionName: 'getEthBalance', args: [a] }) });
  const calls = [
    { target: pool, allowFailure: true, callData: '0x3850c7bd' as `0x${string}` },   // slot0()
    ...ws.flatMap((x) => [bal(x.w), bal(x.r), { target: stable, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [x.r] }) }]),
  ];
  try {
    const ret = await floatNow((pc) => pc.call({ to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }) }));
    const res = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: ret.data || '0x' }) as readonly { success: boolean; returnData: `0x${string}` }[];
    if (res.length !== calls.length) throw new Error('multicall: wrong answer length');
    const v = (i: number) => (res[i].success ? word0(res[i].returnData) : null);
    return { slot0: v(0), w: ws.map((_, i) => v(1 + 3 * i)), r: ws.map((_, i) => v(2 + 3 * i)), stable: ws.map((_, i) => v(3 + 3 * i)) };
  } catch {
    // no Multicall3 / a refused batch: the same reads one by one, side by side (still no bucket, still behind a trade)
    const one = <T,>(p: Promise<T>) => p.then((x) => x as T | null).catch(() => null);
    const [sq, ...rest] = await Promise.all([
      one(floatNow((pc) => pc.call({ to: pool, data: '0x3850c7bd' })).then((r) => word0(r.data))),
      ...ws.flatMap((x) => [one(floatNow((pc) => pc.getBalance({ address: x.w }))), one(floatNow((pc) => pc.getBalance({ address: x.r }))), one(floatNow((pc) => pc.readContract({ address: stable, abi: ERC20_ABI, functionName: 'balanceOf', args: [x.r] })) as Promise<bigint>)]),
    ]);
    return { slot0: sq ?? null, w: ws.map((_, i) => rest[3 * i] ?? null), r: ws.map((_, i) => rest[3 * i + 1] ?? null), stable: ws.map((_, i) => rest[3 * i + 2] ?? null) };
  }
}
async function floatSheetSol(ws: { w: string; r: string }[]) {
  const usdc = FLOAT_CFG.sol.stable.address;
  const keys = ws.flatMap((x) => [x.w, x.r, solFloatAta(x.r, usdc)]);
  const parts: string[][] = []; for (let i = 0; i < keys.length; i += 10) parts.push(keys.slice(i, i + 10));
  // only the 8 bytes of a token account's amount (offset 64); a system account has no data
  const got = await floatNowQuiet(() => Promise.all(parts.map((p) => solFloatRpc<any>('getMultipleAccounts', [p, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 64, length: 8 } }])
    .then((r) => (Array.isArray(r?.value) && r.value.length === p.length ? r.value as ({ lamports: number; owner: string; data: [string, string] } | null)[] : null)).catch(() => null))));
  const vals: (bigint | null)[] = got.flatMap((v, pi) => parts[pi].map((_, j) => {
    if (!v) return null;                                                  // that slice was not read
    const a = v[j]; const k = pi * 10 + j;
    if (k % 3 !== 2) return a ? BigInt(a.lamports) : 0n;                  // W / R lamports (no account = 0)
    if (!a) return 0n;                                                    // no USDC account = 0
    if (a.owner !== SOL_P.token) return null;
    try { const b = Uint8Array.from(atob(a.data[0]), (ch) => ch.charCodeAt(0)); return b.length === 8 ? new DataView(b.buffer).getBigUint64(0, true) : null; } catch { return null; }
  }));
  return { w: ws.map((_, i) => vals[3 * i]), r: ws.map((_, i) => vals[3 * i + 1]), stable: ws.map((_, i) => vals[3 * i + 2]) };
}
// Earn (src/earnEngine.ts): created after the engine object (its block below); the float asks for it only at run time
let earnApi: ReturnType<typeof createEarn> | undefined;
const floatWalletCache = new Map<string, FloatWallet>();
const float = createFloat({
  get earn() { return earnApi; },
  chain: floatLane,
  hurry: floatFastly,
  solver: {
    base: () => (HOST && parentOrigin ? parentOrigin : location.origin),
    pinnedKey: () => MOTION_SOLVER_KEY,
    signEvmTransfer: bridgeSignEvmTransfer as never,
    signSolTransfer: bridgeSignSolTransfer as never,
    release: bridgeRelease as never,
    reserveOn: bridgeReserveOn as never,
    // an EVM frame reads (and signs for) the Solana reserve too, for a click its EVM reserves leave short (2026-10-27)
    ...(SOL_MODE || NEAR_MODE ? {} : { solReserveOn: bridgeSolReserveOn }),
  },
  // a waiting click its reserves cannot cover: the trading wallet's own native on another EVM chain (src/nativeDonor.ts)
  nativeDonor: { read: nativeDonorRead as never, send: nativeDonorSend as never, receipt: nativeDonorReceipt as never },
  // USDG / USDC sent straight to W on another EVM chain: W forwards it to its own R there (floatEngine forwardElsewhere)
  wForward: { send: wForwardSend as never },
  wallet: (id) => { const a = floatAccount(id); const r = reserveOf(a); return { id: a.id, name: a.name, w: { evm: a.address, sol: solAddressOf(a) }, r: { evm: r.evm, sol: r.sol } }; },
  // the account's consent record (src/floatConsent.ts): signed here with the named wallet's own key (EIP-191, a fixed text +
  // the record's digest; it can never be a transaction), then the page is told the vault changed and publishes the profile
  consent: {
    sign: async (address, message) => {
      const a = allAccounts().find((x) => !x.ext && lc(x.address) === lc(address) && /^0x[0-9a-fA-F]{64}$/.test(x.key));
      if (!a) throw new Error('Unknown wallet');
      return privateKeyToAccount(a.key).signMessage({ message });
    },
    changed: () => { emit(); },
    linked: () => !!(meta.main && seedOf(meta.main)),
  },
  // the account's wallets for the ONE USD-balance switch: every unlocked, unarchived wallet of this vault. A Privy wallet (it
  // does not sign here) and a chain-only key are listed as skipped, with why; a bridge hop wallet is not one of the user's
  // wallets and is left out. The reserve addresses are derived once per wallet (no key is kept in the cache).
  wallets: (): FloatWalletList => {
    const list: FloatWallet[] = []; const skipped: FloatWalletList['skipped'] = [];
    for (const a of requireUnlocked()) {
      if (a.archived || a.hop) continue;
      if (a.ext) { skipped.push({ id: a.id, name: a.name, why: 'privy' }); continue; }
      if (nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) { skipped.push({ id: a.id, name: a.name, why: 'other' }); continue; }
      const ck = a.id + '|' + a.address.toLowerCase();
      let fw = floatWalletCache.get(ck);
      if (!fw) { const r = reserveOf(a); fw = { id: a.id, name: a.name, w: { evm: a.address, sol: solAddressOf(a) }, r: { evm: r.evm, sol: r.sol } }; floatWalletCache.set(ck, fw); }
      list.push({ ...fw, name: a.name });
    }
    return { list, skipped };
  },
  evm: {
    call: async (tx) => (await floatRpc((pc) => pc.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }))).data || '0x',
    balance: (a) => floatRpc((pc) => pc.getBalance({ address: a })),
    erc20: (token, owner) => floatRpc((pc) => pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })) as Promise<bigint>,
    allowance: (token, owner, spender) => floatRpc((pc) => pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] })) as Promise<bigint>,
    slot0: async (pool) => { const r = await floatRpc((pc) => pc.call({ to: pool, data: '0x3850c7bd' })); return r.data && r.data.length >= 66 ? BigInt('0x' + r.data.slice(2, 66)) : 0n; },
    fees: floatFees,
    estimate: (tx) => floatRpc((pc) => pc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value })),
    codeHash: async (a) => { const code = await floatRpc((pc) => pc.getCode({ address: a })); return code && code !== '0x' ? keccak256(code) : '0x'; },
    sendR: floatSendR,
    sendW: floatSendW,
    // waits up to `ms` for the receipt (one read per bucket token, paused while a trade runs); `ms` 1 = one look
    receipt: async (hash, ms) => {
      const t0 = Date.now();
      for (;;) {
        const r = await floatRpc((pc) => pc.getTransactionReceipt({ hash })).catch(() => null);
        if (r) return { status: r.status };
        if (Date.now() - t0 >= ms) return null;
        await floatWait(400);
      }
    },
  },
  sol: {
    balance: (a) => floatQuiet(async () => BigInt(String((await solFloatRpc<any>('getBalance', [a, { commitment: 'confirmed' }]))?.value ?? 0))),
    usdc: (owner) => floatQuiet(() => solUsdcOf(owner)),
    oracle6: () => floatQuiet(() => solFloatPrice6(SOL_ORACLE_POOL, FLOAT_CFG.sol.stable.address)),
    fees: async () => { throw new Error('no fee levels in the vault: defaults'); },
    quote: (dir, amountIn) => floatQuiet(async () => solFloatQuote(await solFloatPool(), dir === 'usdc→sol' ? 'sell' : 'buy', amountIn)),
    topup: (walletId, usdcIn, minLamports) => floatQuiet(async () => { const { w, r } = solAcctsOf(walletId); const route = await solFloatPool(); return solFloatSend(r, [...await solFloatSwapIxs(r.address, route, 'sell', usdcIn, minLamports), solFloatPayIx(r.address, w.address, minLamports)]); }),
    sweep: (walletId, lamportsIn, minUsdc) => floatQuiet(async () => { const { w, r } = solAcctsOf(walletId); const route = await solFloatPool(); return solFloatSend(w, [...await solFloatSwapIxs(w.address, route, 'buy', lamportsIn, minUsdc), ...solFloatTokenPayIxs(w.address, FLOAT_CFG.sol.stable.address, r.address, minUsdc, 6)]); }),
    gas: (walletId, lamports) => floatQuiet(() => { const { w, r } = solAcctsOf(walletId); return solFloatSend(w, [solFloatPayIx(w.address, r.address, lamports)], 1_000, 50_000); }),
    // a landed verdict from the first road that has one (2026-10-28: both roads were always waited for, the slower one up to
    // ~0.5 s behind): the quick look asks the usual read road (publicnode first) for a recent signature; only a confirmed /
    // finalized answer there decides. Anything else waits for both roads' answer, with history, exactly as before
    status: (sig) => floatQuiet(() => new Promise<'confirmed' | 'failed' | null>((resolve, reject) => {
      type St = { err?: unknown; confirmationStatus?: string } | null | undefined;
      const verdict = (st: St) => (!st ? null : st.err ? 'failed' as const : st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' as const : null);
      let done = false;
      const end = (v: 'confirmed' | 'failed' | null) => { if (!done) { done = true; resolve(v); } };
      solFloatRpc<any>('getSignatureStatuses', [[sig], { searchTransactionHistory: false }])
        .then((r) => { const st: St = Array.isArray(r?.value) ? r.value[0] : undefined; if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) end(verdict(st)); }, () => {});
      solSigStatusesBoth([sig]).then(([st]) => end(verdict(st)), (e) => { if (!done) { done = true; reject(e); } });
    })),
    // USDC sent straight to W (2026-10-27, Solana too; floatEngine forwardSol): W's USDC of the pinned mint, from W's own account
    // to THIS wallet's own R (derived here, never an argument), in one transferChecked with R's account created if missing; W signs
    // and pays, through the same held-wallet send as the sweep. R pays W only that fee, when W has no SOL, capped at SOL_FWD.fundMax
    forward: (walletId, units) => floatQuiet(() => { const { w, r } = solAcctsOf(walletId); if (units <= 0n) throw new Error('Nothing to forward'); return solFloatSend(w, solFloatTokenPayIxs(w.address, FLOAT_CFG.sol.stable.address, r.address, units, FLOAT_CFG.sol.stable.decimals), SOL_FWD.units, SOL_FWD.micro); }),
    // (release 9) float.withdraw: R's USDC of the pinned mint to `to` — the address floatEngine checked and the user confirmed in
    // Send's own consent (withdrawOk below), in one transferChecked with its account created if missing; R signs and pays
    withdraw: (walletId, to, units) => floatQuiet(() => { const { r } = solAcctsOf(walletId); if (units <= 0n) throw new Error('Nothing to withdraw'); if (!SOL_ADDR.test(String(to))) throw new Error('Invalid address'); return solFloatSend(r, solFloatTokenPayIxs(r.address, FLOAT_CFG.sol.stable.address, String(to), units, FLOAT_CFG.sol.stable.decimals), SOL_FWD.units, SOL_FWD.micro); }),
    fundW: (walletId, lamports) => floatQuiet(() => { const { w, r } = solAcctsOf(walletId); if (lamports <= 0n || lamports > SOL_FWD.fundMax) throw new Error('Refusing: abnormal funding'); return solFloatSend(r, [solFloatPayIx(r.address, w.address, lamports)], SOL_FWD.fundUnits, SOL_FWD.fundMicro); }),
  },
  ask: (o) => ask(o),
  // the switch-on's two confirm buttons (2026-11-01): turning on and converting are separate trusted clicks of the same dialog
  choose: (o) => askChoice(o),
  gate: () => gate('transfer'),
  // (release 9) float.withdraw: Send's own consent (as transferToken): an address this vault holds no key for = the 'withdraw'
  // gate + "Send outside your vault" with the address in full; one of the vault's own wallets = the 'transfer' gate (+ unbacked check)
  withdrawOk: async (o) => {
    const what = `<b>${escHtml(o.amount)} ${escHtml(o.symbol)}</b>`;
    if (!isOwn(o.to)) {
      await gate('withdraw', o.twofa ? { twofa: o.twofa } : undefined);
      const ok = await ask({ title: 'Send outside your vault', danger: true, funds: true, ok: 'Send', html: `${sub(`${what} from ${escHtml(o.walletName)}'s USD balance on ${escHtml(o.chainName)} to this address. It isn't one of your wallets.`)}${destBox(o.to)}<div class="dk-list">${addrRow(`${o.symbol} contract`, o.token)}</div>${muted('Check every character. This can\'t be undone.')}` });
      if (!ok) throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' });
    } else { await gate('transfer', o.twofa ? { twofa: o.twofa } : undefined); await unbackedOk([o.to]); }
  },

  html: { esc: escHtml, sub, muted },
  now: () => Date.now(),
  store: {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
    keys: (prefix) => { try { return Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch { return []; } },
  },
  // one runner per wallet and chain across this browser's tabs: a second tab skips (ifAvailable), it never queues
  // the float's cross-tab lock (one driver per wallet × chain). Background work takes it only when free; a waiting click waits up
  // to waitMs for it. A holder is let go after 45 s, so one stuck tab can never hold every other tab's top-ups for ever (the
  // wallet's own sends stay serialized by laneLock / inLane, a separate lock)
  lock: async <T,>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T | null> => {
    const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; if (!lk?.request) return fn();
    const capped = () => Promise.race([fn(), new Promise<null>((ok) => setTimeout(() => ok(null), 45_000))]) as Promise<T | null>;
    if (!opts?.waitMs) return lk.request(key, { ifAvailable: true }, (l) => (l ? capped() : null)) as Promise<T | null>;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), opts.waitMs);
    try { return await (lk.request(key, { signal: ac.signal }, () => { clearTimeout(t); return capped(); }) as Promise<T | null>); } catch { return null; } finally { clearTimeout(t); }
  },
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:float', { detail })),
  fetch: (u, i) => fetch(u, { ...(i || {}), credentials: 'omit', signal: AbortSignal.timeout(8000) }),
  click: () => ({ ...floatClock, clickAt: clicksRunning > 0 ? Date.now() + 1 : floatClock.clickAt }),
  wait: floatWait,
  // the click path (above): the dialogs' reads and status `fresh` — batched, no bucket, behind a running trade
  fast: {
    evm: { sheet: floatSheetEvm, fees: () => floatFees(floatNow) },
    sol: { sheet: floatSheetSol, oracle6: () => floatNowQuiet(() => solFloatPrice6(SOL_ORACLE_POOL, FLOAT_CFG.sol.stable.address)) },
  },
});
// ── one USD balance: the buy straight from the reserve (owner 2026-10-29 “approved, do all of it”; NOT released — it waits for
// the owner's yes, local float-direct/APPROVAL-REQUEST.md) ──
// A click in USD mode whose trading wallet W cannot cover the buy no longer waits for a top-up: W's own reserve R signs ONE
// transaction that spends its USDC and pays the coin into W (solEngine solDirectBuy, every check of a Jupiter buy from R's
// side). The same per-wallet double-press guard, buy limits (in SOL at the float's price), 'trench:tx' states and follow
// as a buy from W. Solana only: on Robinhood / BNB the stateless router it needs is not deployed (src/floatDirect.ts
// USD_BUY_ROUTER), so the page keeps its hold & fire there.
// (fix1 trade-speed-07, 2026-11-01) a buy straight from the USD balance that sent NOTHING (refused, too late, no route) takes its
// own hourly-ledger entry back out: the app then falls back to hold & fire for the same click, whose trade() records it again
// — the same dollars counted twice brought the "Large hourly buy total" dialog closer. Only an entry this click wrote (newer
// than its start, the same amount) goes, and only when every wallet answered not_started; any send or unknown keeps it.
function unrecordBuy(since: number, total: number) {
  try {
    const l = loadLimits(), lane = laneKey();
    const all = l.buys && typeof l.buys === 'object' ? l.buys : {}, list = all[lane];
    if (!Array.isArray(list) || !(total > 0)) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (Array.isArray(e) && Number(e[0]) >= since && Math.abs(Number(e[1]) - total) <= total * 1e-9) { saveLimits({ ...l, buys: { ...all, [lane]: [...list.slice(0, i), ...list.slice(i + 1)] } }); return; }
    }
  } catch { /* the ledger keeps the entry: a count too high, never too low */ }
}
const nothingSent = (results: Result[]) => results.length > 0 && results.every((x) => !x.ok && x.state === 'not_started');
async function usdBuy(o: unknown) {
  assertLegacyTerminalAllowed(laneKey(), 'float.buy');
  const a = usdBuyArgs(o);
  if (!SOL_MODE && !NEAR_MODE && (CFG.key === 'robinhood' || CFG.key === 'bsc')) return usdBuyEvm(a);
  if (!SOL_MODE) throw new Error('A buy straight from the USD balance is not available on this chain yet');
  tradesInFlight += 1; post({ t: 'busy', v: true });
  try {
    keepHot();
    const list = requireUnlocked();
    const ids = a.walletIds?.length ? a.walletIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((x) => ids.includes(x.id));
    if (!targets.length) throw new Error('No wallet selected');
    // the switch must be on for every wallet of the click, and the float's price stated (before anything is read or asked)
    const ready = targets.map((x) => ({ x, ...float.directFor(x.id) }));
    const s = tradeSettings(); const t0 = performance.now();   // exec-quality review: the lane's slippage, as the page shows it
    const solEq = Number((BigInt(Math.round(a.usd * 1e6)) * 1_000_000_000n) / ready[0].price6) / 1e9;   // per wallet, for the limits
    const bad = tradeSizeProblem('buy', solEq, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);
    const ledgerAt = Date.now();
    await tradeLimits('buy', solEq, s, targets.length);
    const id = clickId({ id: a.id }); const solOf = (x: Account) => solAddressOf(x) || x.address;
    for (const { x } of ready) txEvent({ id, address: solOf(x), state: 'preparing' });
    let route: Awaited<ReturnType<typeof solRoute>>;
    try { route = await solRoute(a.token, a.hint); }
    catch (e) { const error = shortError(e); for (const { x } of ready) txEvent({ id, address: solOf(x), state: 'not_started', error }); unrecordBuy(ledgerAt, solEq * Math.max(1, targets.length)); throw e; }
    const follow = (hash: string, address: string) => (async () => { for (let i = 0; i < 98; i++) { await new Promise((ok) => setTimeout(ok, i < 25 ? 400 : 1500)); const r = await solReceipt(hash).catch(() => null); if (r && !r.pending) { txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash, ...(r.error ? { error: r.error } : {}) }); return; } } })();
    const usdc6 = BigInt(Math.round(a.usd * 1e6));
    const results: Result[] = await pooled(ready, poolSize('sol'), async ({ x }) => {
      const address = solOf(x); const key = `buy:${a.token}:${address}`;   // the SAME guard as a buy from W: one buy of a coin per wallet at a time
      const busy = (): Result => { const error = 'A buy of this token from this wallet is still being sent'; txEvent({ id, address, state: 'not_started', error }); return { name: x.name, address, ok: false, error, state: 'not_started' as TxState }; };
      // the pre-send deadline (src/preSendDeadline.ts): a build that has not reached the send in PRE_SEND_MS is answered "not
      // started … nothing was sent" and the guard let go; solDirectBuy's gate then refuses to send it. Past the gate: as before
      const late = (): { ret: Result; landed?: Promise<unknown> | null } => { const error = LATE_TEXT; txEvent({ id, address, state: 'not_started', error }); return { ret: { name: x.name, address, ok: false, error, state: 'not_started' as TxState }, landed: null }; };
      return tradeGuard<Result>(key, busy, () => preSendDeadline(PRE_SEND_MS, async (ctl) => {
        const { r } = solAcctsOf(x.id);
        const go = () => solDirectBuy(r as SolAcct, address, route, usdc6, s, ctl.gate);
        try {
          // a reserve without the SOL for its fee: motion's gas drop (≤ 5 s), then once more
          const { hash } = await go().catch(async (e) => { if (!(e instanceof SolDirectNoGas) || ctl.late() || !(await float.directGas(x.id, solDirectNeedOf(e)).catch(() => false))) throw e; return go(); });
          txEvent({ id, address, state: 'submitted', hash });
          float.noteBuy(address, solEq);
          return { ret: { name: x.name, address, ok: true, hash, state: 'submitted' as TxState }, landed: follow(hash, address) };
        } catch (e) {
          const error = shortError(e); const unknown = e instanceof SolSendUnknown && e.hash ? e.hash : '';
          const state: TxState = unknown ? 'unknown' : 'not_started';
          // an abandoned build (already answered by the deadline) says nothing more: its click is closed
          if (!ctl.late()) txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) });
          return { ret: { name: x.name, address, ok: false, error, state, ...(unknown ? { hash: unknown } : {}) }, landed: unknown ? follow(unknown, address) : null };
        }
      }, late));
    });
    scheduleWatch(1500);
    const sent = results.filter((x) => x.ok).length;
    if (nothingSent(results)) unrecordBuy(ledgerAt, solEq * Math.max(1, targets.length));
    return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'sol-reserve', via: 'reserve', timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
  } finally { tradesInFlight -= 1; post({ t: 'busy', v: tradesInFlight > 0 }); }
}
// ── the same on Robinhood / BNB (src/usdBuyEvm.ts) ──
// R signs ONE call to a router this build names (the float's own SwapRouter02 / PancakeSwap SmartRouter for V3 and V2, the
// Universal Router for Robinhood's V4 pools): the stable in from R, the coin straight to W. Before signing, the exact call is
// run once as R with the probe's code at R's address (an eth_call state override): R's allowance, R's stable down by exactly
// the amount, W's coin up, nothing else of R's / W's moved, nothing left in the router. The price guard compares what the route
// is EXPECTED to deliver (the quote) with motion's own price; the floor R signs is the quote less the user's slippage. The
// route is the vault's own (routeFor, verifyRoute, as for every buy); the same per-wallet guard as a buy from W. A market this
// build has no single call for (a bonding curve until UsdBuyRouter is deployed, an Infinity / other-quote pool) and a reserve
// without its standing allowance answer "not available": the page keeps its hold & fire, and the background sets the allowance.
const evmChainKey = (): EvmChain => (CFG.key === 'bsc' ? 'bsc' : 'robinhood');
// UsdBuyRouter (curves): used only once the code at its address hashes to the audited runtime and the venue's allow-list entry
// reads back as the vault expects — checked once per session per venue (two reads, beside the click's own)
const curveRouterChecks = new Map<string, Promise<boolean>>();
function curveRouterOk(r: NonNullable<EvmPlan['router']>): Promise<boolean> {
  const key = `${r.address}:${r.venue}:${r.selector}`;
  let p = curveRouterChecks.get(key);
  if (!p) {
    p = Promise.all([publicClient.getCode({ address: r.address }), publicClient.readContract({ address: r.address, abi: USD_BUY_ROUTER_ABI, functionName: 'specOf', args: [r.venue, r.selector] })])
      .then(([code, spec]) => {
        const sp = spec as { venue: string; amountOffset: number; recipientOffset: number; tokenOffset: number; nativeOffset: number; ponsFactory: boolean };
        return !!code && keccak256(code) === r.codeHash && lc(sp.venue) === lc(r.venue) && Number(sp.amountOffset) === r.spec[0] && Number(sp.recipientOffset) === r.spec[1]
          && Number(sp.tokenOffset) === r.spec[2] && Number(sp.nativeOffset) === r.spec[3] && sp.ponsFactory === r.spec[4];
      }, () => false);
    // a failed or negative check is asked again on a later click (the router may be deployed meanwhile)
    p.then((ok) => { if (!ok) setTimeout(() => curveRouterChecks.delete(key), 30_000); });
    curveRouterChecks.set(key, p);
  }
  return p;
}
async function evmMotionPriceUsd(token: string): Promise<number | null> {
  try {
    const q = await fetch(`${routeApi()}/quotes?addrs=${encodeURIComponent(lc(token))}`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json());
    const row = q?.quotes?.[lc(token)]; const usd = Number(row?.price), age = Number(row?.priceAgeMs ?? 0);
    return usd > 0 && age < 120_000 ? usd : null;
  } catch { return null; }
}
async function usdBuyEvm(a: ReturnType<typeof usdBuyArgs>) {
  const addr = lc(a.token) as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('Invalid token address');
  const ck = evmChainKey(); const fc = FLOAT_CFG[ck];
  tradesInFlight += 1; post({ t: 'busy', v: true });
  try {
    keepHot();
    const list = requireUnlocked();
    const ids = a.walletIds?.length ? a.walletIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((x) => ids.includes(x.id));
    if (!targets.length) throw new Error('No wallet selected');
    const ready = targets.map((x) => ({ x, ...float.directFor(x.id) }));
    const s = tradeSettings(); const t0 = performance.now();   // exec-quality review: the lane's slippage, as the page shows it
    const nativeEq = Number((BigInt(Math.round(a.usd * 1e6)) * 10n ** 18n) / ready[0].price6) / 1e18;   // per wallet, for the limits
    const bad = tradeSizeProblem('buy', nativeEq, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);
    const ledgerAt = Date.now();
    await tradeLimits('buy', nativeEq, s, targets.length);
    const id = clickId({ id: a.id });
    for (const { x } of ready) txEvent({ id, address: x.address, state: 'preparing' });
    let route: Route;
    try { route = await routeFor(addr, a.hint); }
    catch (e) { const error = shortError(e); for (const { x } of ready) txEvent({ id, address: x.address, state: 'not_started', error }); unrecordBuy(ledgerAt, nativeEq * Math.max(1, targets.length)); throw e; }
    const verified = verifyRoute(addr, route); verified.catch(() => {});
    const priceP = evmMotionPriceUsd(addr); priceP.catch(() => {});
    const feeP = feeFor(s.gasBoost || 1); feeP.catch(() => {});
    const amountIn = fc.stable.decimals >= 6 ? BigInt(Math.round(a.usd * 1e6)) * 10n ** BigInt(fc.stable.decimals - 6) : BigInt(Math.round(a.usd * 1e6));
    const results: Result[] = await pooled(ready, poolSize('evm'), async ({ x }) => {
      const address = x.address; const key = `buy:${addr}:${lc(address)}`;
      const busy = (): Result => { const error = 'A buy of this token from this wallet is still being sent'; txEvent({ id, address, state: 'not_started', error }); return { name: x.name, address, ok: false, error, state: 'not_started' as TxState }; };
      // the pre-send deadline (src/preSendDeadline.ts), as on Solana: the gate sits right before signAndSend
      const late = (): { ret: Result; landed?: Promise<unknown> | null } => { const error = LATE_TEXT; txEvent({ id, address, state: 'not_started', error }); return { ret: { name: x.name, address, ok: false, error, state: 'not_started' as TxState }, landed: null }; };
      return tradeGuard<Result>(key, busy, () => preSendDeadline(PRE_SEND_MS, async (ctl) => {
        try {
          const r = reserveOf(floatAccount(x.id)); const account = privateKeyToAccount(r.key);
          // a transfer R signed for motion's bridge and has not seen broadcast holds a nonce: never a second one beside it
          const held = bridgeHeldNonce.get(account.address.toLowerCase());
          if (held && Date.now() - held.at < BRIDGE_HOLD_MS) throw new Error('A buy straight from the USD balance is not available right now (the reserve has a transfer in flight)');
          // a curve's stable → native leg: at least 98 % of the float's own price (the router's minNative)
          const minNative = (BigInt(Math.floor(nativeEq * 1e9)) * 10n ** 9n * 98n) / 100n;
          const plan = (() => { try { return evmDirectPlan({ chain: ck, route: route as unknown as EvmRoute, coin: addr, amountIn, recipient: address, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), minNative }); } catch (e) { if (e instanceof DirectUnsupported) throw new Error(e.message); throw e; } })();
          // the curve router's per-buy cap (CURVE_BUY_MAX_USD): above it, the hold (the wallet's own buy after a top-up)
          if (plan.kind === 'curve' && a.usd > CURVE_BUY_MAX_USD) throw new Error(`A buy straight from the USD balance is not available above $${CURVE_BUY_MAX_USD} on a launchpad curve`);
          if (plan.router && !(await curveRouterOk(plan.router))) throw new Error('A buy straight from the USD balance is not available for this market yet');
          const once = async () => {
            // the exact call as R (the probe's code at R's address, one eth_call) and its gas, side by side
            const [probed, gasEst] = await Promise.all([
              publicClient.call({ account: account.address, to: account.address, data: probeCall({ plan, chain: ck, coin: addr, w: address, amountIn }), stateOverride: [{ address: account.address, code: PROBE_RUNTIME }] }),
              publicClient.estimateGas({ account: account.address, to: plan.to, data: plan.build(1n), value: 0n }).catch(() => 0n),
            ]).catch((e) => { throw new Error('A buy straight from the USD balance is not available right now: ' + shortError(e)); });
            return { seen: decodeProbe((probed.data || '0x') as `0x${string}`), gasEst };
          };
          let { seen, gasEst } = await once();
          if (seen.allowance < amountIn) { float.directAllowSoon(x.id); throw new Error('A buy straight from the USD balance is not available yet: the reserve is being approved for this router'); }
          const why = evmDirectGuard(seen, amountIn);
          if (why) throw new Error('Refused: the buy from your reserve does not do what you asked — ' + why + '. Nothing was sent.');
          const quote = routerOut(seen.ret, seen.coinGot);
          const priceWhy = evmPriceCheck({ usdIn: a.usd, expectedOut: seen.coinGot, decimals: seen.decimals, priceUsd: await priceP });
          if (priceWhy) throw new Error('Refused: ' + priceWhy + '. Nothing was sent.');
          await verified;
          const gasPrice = await feeP;
          const gas = gasEst > 0n ? (gasEst * 13n) / 10n : 900_000n;
          // a reserve without the native for its gas: motion's gas drop (≤ 5 s), then the probe once more
          if (seen.rNativeBefore < gas * gasPrice) {
            if (ctl.late() || !(await float.directGas(x.id).catch(() => false))) throw new Error('The reserve needs a little ' + (CFG.key === 'bsc' ? 'BNB' : 'ETH') + ' for the network fee — not available right now');
            ({ seen, gasEst } = await once());
            if (evmDirectGuard(seen, amountIn)) throw new Error('Refused: the buy from your reserve does not do what you asked. Nothing was sent.');
          }
          const minOut = minOutOf(quote, s.slippage);
          const client = createWalletClient({ account, chain, transport });
          // the cut-off: past this gate the deadline is off (signAndSend may broadcast); a build already answered "not started" stops here
          if (!ctl.gate()) throw new Error('The buy from your USD balance took too long to prepare — nothing was sent');
          const hash = await signAndSend(client, account, { to: plan.to, data: plan.build(minOut), value: 0n }, gasPrice, gas);
          txEvent({ id, address, state: 'submitted', hash });
          float.noteBuy(address, nativeEq);
          return { ret: { name: x.name, address, ok: true, hash, state: 'submitted' as TxState }, landed: watchReceipt(hash, id, address) };
        } catch (e) {
          const err = e as { txState?: string; hash?: string };
          const error = shortError(e); const unknown = err.txState === 'unknown' && err.hash ? err.hash : '';
          const state: TxState = unknown ? 'unknown' : 'not_started';
          if (!ctl.late()) txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) });
          return { ret: { name: x.name, address, ok: false, error, state, ...(unknown ? { hash: unknown } : {}) }, landed: unknown ? watchReceipt(unknown, id, address) : null };
        }
      }, late));
    });
    scheduleWatch(1500);
    const sent = results.filter((x) => x.ok).length;
    if (nothingSent(results)) unrecordBuy(ledgerAt, nativeEq * Math.max(1, targets.length));
    return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'evm-reserve', via: 'reserve', timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
  } finally { tradesInFlight -= 1; post({ t: 'busy', v: tradesInFlight > 0 }); }
}
// the ready float after a trade (floatEngine afterTrade): a trade of a wallet that CONFIRMED (its 'trench:tx' event, after
// the fact — no trade function knows of it) refills that wallet's float on the fast path once no trade is being signed. The
// size it refills to follows the buys the page reports (float.ensure 'fill') and the buys from the reserve (noteBuy above)
if (typeof document !== 'undefined') document.addEventListener('trench:tx', (ev) => { const d = (ev as CustomEvent).detail as { state?: string; address?: string } | null; if (d && d.state === 'confirmed' && typeof d.address === 'string') { try { float.afterTrade(d.address); } catch { /* the next tick */ } } });
const engine = {
  version: 2,
  ready,
  exists: () => true,
  locked: () => !unlocked,
  createVault, unlock, lock,
  reorder: async (ids: string[]) => { requireUnlocked(); meta.order = ids.filter((id, i) => ids.indexOf(id) === i); await persist(); return { ok: true, ...summary() }; },
  archive: async (id: string, on = true) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); a.archived = on; if (on) meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => x !== id); await persist(); return { ok: true, ...summary() }; },
  transfer: async (fromId: string, to: string, amountEth: number | 'max', auth?: Auth, opts?: TransferOpts) => once(opts, ['native', fromId, to, amountEth], async (sending) => {
    const list = requireUnlocked(); const from = list.find((x) => x.id === fromId); if (!from) throw new Error('Unknown wallet');
    if (!(SOL_MODE ? SOL_ADDR.test(String(to)) : NEAR_MODE ? NEAR_ACCT.test(String(to).toLowerCase()) : /^0x[0-9a-fA-F]{40}$/.test(to))) throw new Error('Invalid address');
    if (!isOwn(to)) {
      // the only way out of the vault for native coin: the 'withdraw' gate, then a trusted click on the real address
      await gate('withdraw', auth);
      // NEAR-2: the coin of this frame's lane (NATIVE is the EVM config's symbol: 'ETH' on the NEAR frame)
      const ok = await ask({ title: 'Send outside your vault', danger: true, funds: true, ok: amountEth === 'max' ? 'Send everything' : `Send ${amountEth} ${laneUnit()}`, html: `${sub(`${amountEth === 'max' ? 'The whole balance' : escHtml(amountEth) + ' ' + laneUnit()} from ${escHtml(from.name)} to this address. It isn't one of your wallets.`)}${destBox(to)}${muted('Check every character. This can\'t be undone.')}` });
      if (!ok) throw new Error('Cancelled');
    } else { await gate('transfer', auth); await unbackedOk([to]); }
    sending();
    return { ok: true, hash: await sendEth(fromId, to as `0x${string}`, amountEth === 'max' ? 'max' : parseEther(String(amountEth))) };
  }),
  // A token out of a wallet — a stablecoin deposit (USDC / USDG / USDT) or any coin it holds (2026-10-17: a user's 2 USDC
  // showed in the header and could not be moved). The same doors as the native coin: outside the vault = the 'withdraw'
  // gate and a trusted click on the real address, with the token and the amount; between own wallets = 'transfer'.
  transferToken: async (fromId: string, token: string, to: string, amount: number | 'max', auth?: Auth, opts?: TransferOpts) => once(opts, ['token', fromId, token, to, amount], async (sending) => {
    const list = requireUnlocked(); const from = list.find((x) => x.id === fromId); if (!from) throw new Error('Unknown wallet');
    if (NEAR_MODE) throw new Error('Sending tokens on NEAR is not supported yet — export the key to move them');
    if (!(amount === 'max' || (typeof amount === 'number' && amount > 0 && Number.isFinite(amount)))) throw new Error('Invalid amount');
    if (SOL_MODE ? !(SOL_ADDR.test(String(to)) && SOL_ADDR.test(String(token))) : !(/^0x[0-9a-fA-F]{40}$/.test(String(to)) && /^0x[0-9a-fA-F]{40}$/.test(String(token)))) throw new Error('Invalid address');
    const sym = await tokenSymbolOf(token).catch(() => '');
    const what = `${amount === 'max' ? 'all of its' : escHtml(amount)} <b>${escHtml(sym || (String(token).slice(0, 6) + '…' + String(token).slice(-4)))}</b>`;
    if (!isOwn(to)) {
      await gate('withdraw', auth);
      const ok = await ask({ title: 'Send outside your vault', danger: true, funds: true, ok: 'Send', html: `${sub(`${what} from ${escHtml(from.name)} to this address. It isn't one of your wallets.`)}${destBox(to)}<div class="dk-list">${addrRow(`${sym || 'Token'} contract`, token)}</div>${muted('Check every character. This can\'t be undone.')}` });
      if (!ok) throw new Error('Cancelled');
    } else { await gate('transfer', auth); await unbackedOk([to]); }
    if (SOL_MODE) { sending(); const r = await solTokenTransfer(from as unknown as SolAcct, String(token), String(to), amount); return { ok: true, hash: r.hash, units: r.units, decimals: r.decimals }; }
    const { account, client } = walletFor(fromId);
    const t = String(token).toLowerCase() as `0x${string}`;
    const bal = await publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint;
    const dec = await tokenDecimals(t);
    const units = amount === 'max' ? bal : toUnits(amount, dec);
    if (units <= 0n) throw new Error('Nothing to send');
    if (units > bal) throw new Error('More than this wallet holds');
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to as `0x${string}`, units] });
    const gas = await publicClient.estimateGas({ account: account.address, to: t, data }).then((g) => g * 13n / 10n);
    const gasPrice = await feeFor(1);
    const native = await publicClient.getBalance({ address: account.address });
    if (native < gas * gasPrice) throw new Error(`Needs ${formatEther(gas * gasPrice)} ${NATIVE} for gas — this wallet has ${formatEther(native)}`);
    sending();
    return { ok: true, hash: await signAndSend(client, account, { to: t, data }, gasPrice, gas), units: units.toString(), decimals: dec };
  }),
  // destinations are wallet ids resolved here, never addresses: these two cannot send outside the vault
  // NEAR-2: every destination is the wallet's identity on this lane (laneDest), checked, shown and sent to as that, in this lane's coin
  distribute: async (fromId: string, toIds: string[], amountEth: number, auth?: Auth) => { const list = requireUnlocked(); const tgts = toIds.map((id) => list.find((x) => x.id === id)).filter(Boolean) as Account[]; const dest = new Map(tgts.map((t) => [t.id, laneDest(t)])); { const ext = tgts.filter((t) => !isOwn(dest.get(t.id)!)); if (ext.length) { for (const t of ext) await outsideOk(t, `Send <b>${escHtml(amountEth)} ${laneUnit()}</b>`, auth, dest.get(t.id)); } else await gate('transfer', auth); } await unbackedOk(tgts.map((t) => dest.get(t.id)!)); const results = []; for (const id of toIds) { const t = list.find((x) => x.id === id); if (!t) continue; try { results.push({ id, address: t.address, ok: true, hash: await sendEth(fromId, dest.get(t.id)! as `0x${string}`, parseEther(String(amountEth))) }); } catch (e) { results.push({ id, address: t.address, ok: false, error: shortError(e) }); } } return { ok: true, results }; },
  consolidate: async (fromIds: string[], toId: string, auth?: Auth) => { const list = requireUnlocked(); const to = list.find((x) => x.id === toId); if (!to) throw new Error('Unknown target'); const toAddr = laneDest(to); if (!isOwn(toAddr)) await outsideOk(to, `Sweep <b>${fromIds.filter((x) => x !== toId).length}</b> wallet(s)`, auth, toAddr); else { await gate('transfer', auth); await unbackedOk([toAddr]); } const results = []; for (const id of fromIds) { if (id === toId) continue; try { results.push({ id, ok: true, hash: await sendEth(id, toAddr as `0x${string}`, 'max') }); } catch (e) { results.push({ id, ok: false, error: shortError(e) }); } } return { ok: true, results }; },
  // WETH / WBNB on the EVM frames. The Solana and NEAR frames have no wrap here: this used to fall through to the EVM
  // client (a SOL-frame wrap() would have wrapped ETH on Robinhood).
  wrap: async (id: string, amountEth: number) => { if (SOL_MODE || NEAR_MODE) throw new Error(SOL_MODE ? 'Trades on Solana pay in SOL — there is nothing to wrap' : 'Wrapping is not available on NEAR here'); return { ok: true, hash: await wrap(id, parseEther(String(amountEth))) }; },
  // Solana (2026-10-20): unwrap = close this wallet's own wSOL account (src/solEngine.ts solUnwrap) — all its wSOL plus the
  // account rent become SOL in the SAME wallet; no amount, no destination. Like the EVM unwrap, no gate and no dialog:
  // nothing leaves the wallet. A repeat cannot move more (the second close finds no account and fails at preflight).
  unwrap: async (id: string, amountEth?: number | 'max') => {
    if (SOL_MODE) {
      if (amountEth !== undefined && amountEth !== 'max') throw new Error('On Solana the whole wSOL balance unwraps at once — ask for "max"');
      const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
      const r = await solUnwrap(a); return { ok: true, hash: r.hash, units: r.units, decimals: 9, lamports: r.lamports };
    }
    if (NEAR_MODE) throw new Error('Unwrapping is not available on NEAR here');
    return { ok: true, hash: await unwrap(id, parseEther(String(amountEth))) };
  },
  // the wrapped native per wallet, keyed lower-case like every caller reads it (portfolio.js, move.js, the app): on Solana
  // the wSOL account's token balance (an address whose read failed is left out, never shown as 0)
  wethBalances: async (addresses: string[]) => (SOL_MODE ? Object.fromEntries(Object.entries(await solWsolBalancesFor(addresses.map(String))).map(([a, v]) => [a.toLowerCase(), v])) : NEAR_MODE ? Object.fromEntries(addresses.map((a) => [a.toLowerCase(), 0])) : Object.fromEntries(await Promise.all(addresses.map(async (a) => [a.toLowerCase(), Number(formatEther(await publicClient.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [a as `0x${string}`] }).catch(() => 0n)))])))),
  onChange: (f: () => void) => listeners.add(f),
  accounts: async () => summary(),
  // A plain-text attestation from one of the vault's wallets (a callout says
  // "this wallet is mine"). Only text under our own fixed heading is signed:
  // nothing that reads like a login, a permit or a typed-data hash gets past.
  signNote: async (address: string, message: string) => {
    await ready; const list = requireUnlocked(); const m = lc(address);
    const a = list.find((x) => lc(x.address) === m && !x.archived); if (!a) throw new Error('Not one of your wallets');
    const msg = String(message || '');
    // three kinds of notes only: a callout, a BGC competition entry, and (2026-10-30) the Overdrive rewards link / release note
    // in its exact shape, naming this very wallet (proves the wallet is yours; moves nothing)
    const rewardsNote = /^motion rewards\n(Link this wallet to|Release this wallet from) my motion rewards account\.\nwallet: (0x[0-9a-f]{40})\naccount: ([0-9a-f]{16})\nNo transaction, no cost\.$/.exec(msg);
    if (rewardsNote && rewardsNote[2] !== m) throw new Error('Refused: the rewards note names another wallet');
    if ((!rewardsNote && !/^(copytrade\.gg callout|motion BGC entry)\n/.test(msg)) || msg.length > 600 || /[\u0000-\u0008\u000b-\u001f]/.test(msg)) throw new Error('Refused: not a copytrade note');
    if (a.ext) throw new Error('The main wallet signs through Privy');
    // (audit 2026-11-01, vault-security-rewards-link) the rewards account a note names: without a dialog only the account this
    // vault itself is logged in to (the user id the server answered the vault's own /api/2fa read with, rewards.mjs accountTag);
    // any other tag — a page script naming someone else's account to earn on this wallet's volume — asks in the vault's dialog
    if (rewardsNote) {
      const tag = rewardsNote[3];
      if (tag !== await rewardsTagOfVault()) {
        const link = rewardsNote[1].startsWith('Link');
        const ok = await ask({ title: link ? 'Link to a rewards account' : 'Release from a rewards account', ok: link ? 'Link wallet' : 'Release wallet', danger: link,
          html: `${sub(`${link ? 'Link' : 'Release'} ${escHtml(a.name)} ${link ? 'to' : 'from'} motion rewards account ${escHtml(tag)}?`)}<div class="dk-list">${addrRow(a.name, a.address)}</div>${muted(link ? 'This is not the account you are logged in to here. Its owner earns the points, packs and payouts for this wallet\'s trades, and the link cannot be undone from your account. No transaction, no cost.' : 'This is not the account you are logged in to here. No transaction, no cost.')}` });
        if (!ok) throw new Error('Cancelled');
      }
    }
    // a BGC note naming a Solana address is also signed by that address's key, and only if it is this wallet's own
    const solLine = /\nSOL: ([1-9A-HJ-NP-Za-km-z]{32,44})(\n|$)/.exec(msg)?.[1] || '';
    if (solLine && solLine !== solAddressOf(a)) throw new Error('Refused: the SOL line names another wallet');
    // …and a NEAR line by that NEAR implicit account's own ed25519 key (review 2026-10-19 H5: the server accepts a NEAR
    // claim only with it, server/bgc.mjs nearSigOk), only when it is this wallet's own account
    const nearLine = /\nNEAR: ([0-9a-f]{64})(\n|$)/.exec(msg)?.[1] || '';
    if (nearLine && nearLine !== nearAccountId(a)) throw new Error('Refused: the NEAR line names another wallet');
    return { ok: true, address: a.address, signature: await privateKeyToAccount(a.key).signMessage({ message: msg }), ...(solLine ? { sol: solLine, solSignature: solSignText(a.key, msg) } : {}), ...(nearLine ? { near: nearLine, nearSignature: nearSignText(a.key, msg) } : {}) };
  },
  create: async (name?: string, opts?: { recovery?: string; signature?: string; mainSignature?: string }) => {
    await ready; requireUnlocked();
    const main = meta.main && hasOwn(seeds, lc(meta.main)) ? lc(meta.main) : '';   // V12 F-56: own-property lookup
    // Owner decision 2026-10-19: a NEW account whose main is an external wallet (Rabby / MetaMask) gets phone access in the
    // same trusted click that creates its first wallet — one line in this dialog, no second window. The page hands over
    // the account's Privy wallet and its signature over RECOVERY_MSG; nothing is sealed unless the user clicks here.
    let rq: { r: string; sig: string } | null = null;
    if (opts && typeof opts === 'object' && opts.recovery) {
      if (!HOST) throw new Error('vault frame only');
      if (!main) throw new Error('Main wallet not attached on this device');
      const r = lc(opts.recovery);
      if (!/^0x[0-9a-f]{40}$/.test(r) || r === main) throw new Error('Bad recovery wallet');
      const signer = await recoverMessageAddress({ message: RECOVERY_MSG(main, r), signature: String(opts.signature || '') as `0x${string}` }).catch(() => '');
      if (!same(signer, r)) throw new Error('That signature is not from the recovery wallet');
      const label = String(name || '').trim() || `Wallet ${subsOf(main).length + 1}`;
      const first = !subsOf(main).length;
      // V12 F-20: show the full recovery (login) wallet address so the user can check what they are sealing to.
      if (!(await ask({ title: first ? 'Create your first wallet' : 'Create a wallet', ok: 'Create wallet', cancelLabel: 'Not now', html: `${sub(`Create ${escHtml(label)}, back it up to your account and restore it on any device you log into.`)}${signedIn(main)}${addrRows([{ name: 'Recovery wallet', address: r }])}${muted(RECOVERY_TRADEOFF)}` }))) throw new Error('Cancelled');
      rq = { r, sig: String(opts.signature) };
    }
    if (rq && main) {
      // V12 F-28: bind the recovery copy to the main's own signature (stored at attach, or handed in for an older main)
      const { sig, mv } = await mainSigFor(main, opts?.mainSignature);
      const rk = await sealRecovery(main, rq.r, rq.sig, seeds[main], sig, mv);
      recoveryChange.set(main, { rk, at: Date.now() });
    }
    // V12 F-28: on an 'rk1' main (seed from an unbound legacy recovery copy) a new wallet is a standalone generated key —
    // NOT derived from that seed and NOT sealed into the account backup. A seed we cannot vouch for must not mint
    // spendable wallets or draw more keys under it; back these up with a file. A real mainAttach flips it back to derived.
    if (main && meta.seedSrc?.[main] !== 'rk1') {
      const subs = subsOf(main);
      if (subs.length >= SUB_CAP) throw new Error(`Up to ${SUB_CAP} trading wallets per main wallet`);
      let index = subs.reduce((m, a) => Math.max(m, a.index ?? -1), -1) + 1;
      // a wallet restored without its slot may already be the next key of this salt's series: skip past it
      for (let tries = 0; tries < 8; tries += 1, index += 1) {
        const key = await subKeyV2(seeds[main], index);   // v2: under this vault's salt (see SALT)
        if (requireUnlocked().some((a) => same(a.address, privateKeyToAccount(key).address))) continue;
        const id = await addAccount(String(name || '').trim() || `Wallet ${index + 1}`, key, { main, index, gen: 2 });
        return { ok: true, id, ...summary() };
      }
      throw new Error('Could not derive a new trading wallet');
    }
    const id = await addAccount(String(name || '').trim() || nextName('Created'), generatePrivateKey(), { kind: 'created' });
    return { ok: true, id, ...summary() };
  },
  // ── main wallet: attach (one signature), sync with the account profile, publish the profile, detach ──
  // seedSrc (V12 F-28 follow-up): 'main' = the seed came from the main's own signature (or a v2 copy bound to it), 'rk1' = from a
  // legacy phone-access copy (unbound: its own wallets stay out of the backup — `unbound`); ms = the main's signature is held
  // here (an update of a legacy copy then needs only the vault's click, no new signature)
  mainStatus: async (address: string) => { await ready; const m = mainAddr(address); const sd = seedOf(m); return { ok: true, attached: !!sd, current: meta.main === m, subs: subsOf(m).length, cap: SUB_CAP, fp: sd ? await fingerprint(sd) : '', mv: mvOf(m), keyMissing: !!keyMissing, seedSrc: sd ? (meta.seedSrc?.[m] === 'rk1' ? 'rk1' : 'main') : null, ms: !!sd && /^0x[0-9a-fA-F]{130}$/.test(mainSigStored(m)), unbound: sd ? unboundOf(m).filter((w) => w.kind !== 'hop').length : 0, ...storageFlags() }; },
  // the page's interface language (en / ru / zh / id / es / fr) for the dialogs that have their words in six languages
  uiLang: async (lang: string) => { if (typeof lang === 'string' && lang) pageLang = rkLangOf(lang); return { ok: true, lang: uiLang() }; },
  // the main is a Privy embedded wallet or the external wallet the user logged in with (MetaMask & co. sign the same text)
  // mv: which fixed text was signed — 1 (copytrade.gg, every older account) or 2 (motion.gift, accounts created since)
  mainAttach: async (src: { address: string; signature: string; expectFp?: string; mv?: number }) => {
    await ready; if (!HOST) throw new Error('main wallets attach in the vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address);   // V12 F-56
    const mv: MainMsgVersion = src?.mv === 2 ? 2 : 1;
    // a main already attached here keeps the text it was attached with: the other one would derive other wallets
    if (seedOf(m) && mvOf(m) !== mv) throw new Error(`This main wallet is attached here with the v${mvOf(m)} text — sign that one`);
    // the signature must be the main's own, over the fixed text — not any 65 bytes a page hands over
    const signer = await recoverMessageAddress({ message: MAIN_MSG(m, mv), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, m)) throw new Error('That signature is not from this main wallet');
    // a main this vault has not worked with yet becomes the parent of every wallet created from now on: a page
    // script could attach its own (its own signature verifies too) — so the first attach of a main is a trusted click.
    // NOT a substitute for this click (reviewed 2026-10-20, iPhone home-screen launches): "the seed opens an entry of the
    // account backup". The backup reaches this frame through the page, so a page script builds one for ITS OWN main
    // (buildProfile under its own seed: the entry opens, profile.fp matches) and would attach that main with no click —
    // and mainProfile(main) then seals every key of this vault under that seed. Same for expectFp and the profile: page
    // data. An empty frame has no anchor of its own to tell the account's main from a foreign one; only this click does.
    // Owner in chat 2026-11-04: “approved” — no typed code on a FRESH account's first attach (no expectFp from the page, no seed
    // of any kind in this vault, no local wallet other than login / hop rows): the click still decides, but one click. The
    // trade-off SEC-5b took the code for, accepted here: a decoy click through a masked frame (Chromium, IOv2 still says
    // "visible") can attach a page script's own main. On a fresh vault there is nothing for it to take now (no keys, no salt),
    // but the wallets created after it are derived and backed up under that main's seed. A restore (expectFp set, a seed
    // here, or local wallets) keeps the typed code.
    const fresh = !src?.expectFp && !Object.keys(seeds).length && !allAccounts().some((a) => !a.ext && !a.hop);
    if (!seedOf(m) && !(await ask({ title: 'Set up this device', ok: 'Continue', cancelLabel: 'Not now', keep: true, funds: !fresh, html: `${sub(fresh ? 'Your trading wallets are created under your account.' : 'Your trading wallets are restored here, and new ones are created under your account.')}${signedIn(m)}${muted('Continue only with the wallet you signed in with.')}` }))) throw new Error('Cancelled');
    const seed = await seedOfSignature(String(src?.signature || ''));
    const fp = await fingerprint(seed);
    // the account's profile names the fingerprint of the seed it was built with: a different signature is refused before anything is kept
    if (src.expectFp && src.expectFp !== fp) throw new Error('fingerprint mismatch: this signature does not match the one that created the account\'s trading wallets');
    if (seedOf(m) && seedOf(m) !== seed) throw new Error('This main wallet signed differently than before — the signature is not deterministic, trading wallets cannot be re-derived from it');
    seeds[m] = seed; meta.main = m;
    // V12 F-28: this is the main's OWN verified signature (checked just above). Remember it to bind future recovery seals,
    // and mark the seed source 'main' — if it was 'rk1' (restored from an unbound legacy copy), this upgrades it and the
    // full account backup resumes.
    seeds[MS(m)] = String(src.signature);
    meta.seedSrc = { ...(meta.seedSrc || {}), [m]: 'main' };
    if (mv === 2) meta.mainMv = { ...(meta.mainMv || {}), [m]: 2 }; else if (meta.mainMv?.[m]) { const { [m]: _, ...rest } = meta.mainMv; meta.mainMv = rest; }
    await persist();
    return { ok: true, fp, mv, ...storageFlags(), ...summary() };
  },
  // ── account recovery v1 (opt-in): seal this main's seed to the account's Privy embedded wallet ──
  // Only on a device where the main is attached (the seed is here), only after a trusted click in this frame: a page that
  // could turn it on silently would widen who can open the account's wallets (see vaultRecovery.ts RECOVERY_MSG).
  mainRecoverySeal: async (src: { address: string; recovery: string; signature: string; mainSignature?: string }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address), r = lc(src?.recovery);   // V12 F-56
    if (!seedOf(m)) throw new Error('Main wallet not attached on this device');
    if (!/^0x[0-9a-f]{40}$/.test(r) || r === m) throw new Error('Bad recovery wallet');
    const signer = await recoverMessageAddress({ message: RECOVERY_MSG(m, r), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, r)) throw new Error('That signature is not from the recovery wallet');
    // V12 F-28: resolve + verify the main's own signature BEFORE the dialog, so a main attached before this build that
    // can no longer be bound fails loudly here (asking the user to re-sign) rather than sealing an unbound copy.
    const { sig, mv } = await mainSigFor(m, src.mainSignature);
    // V12 F-20: show the full recovery (login) wallet address the seed is being sealed to.
    if (!(await ask({ title: 'Turn on phone access', ok: 'Turn on', cancelLabel: 'Not now', html: `${sub('Sign in on your phone or any browser and your wallets appear there. No file, no login wallet.')}${signedIn(m)}${addrRows([{ name: 'Recovery wallet', address: r }])}${muted(RECOVERY_TRADEOFF)}` }))) throw new Error('Cancelled');
    const rk = await sealRecovery(m, r, String(src.signature), seeds[m], sig, mv);
    recoveryChange.set(m, { rk, at: Date.now() }); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, recovery: r };
  },
  mainRecoveryOff: async (src: { address: string }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); if (!seedOf(m)) throw new Error('Main wallet not attached on this device');   // V12 F-56
    if (!(await ask({ title: 'Turn off phone access', ok: 'Turn off', cancelLabel: 'Keep it on', html: `${sub('New devices will need your login wallet or a backup file to restore your wallets.')}${signedIn(m)}${muted('A device that already restored keeps its wallets, and a copy made while this was on still opens with your sign-in. To fully undo it, move your funds to new wallets.')}` }))) throw new Error('Cancelled');
    recoveryChange.set(m, { rk: null, at: Date.now() }); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true };
  },
  // V12 F-28 follow-up (src/rkMigrate.ts; owner 2026-10-28 "show each of them a prompt to sign / migrate"): re-seal an account's
  // LEGACY phone-access copy (body {v:1}, no main signature, written 19–24 Oct) as v2, bound to the main's own signature, on a
  // device whose seed is the main's. The page offers it ("Update your phone access — sign once to keep every wallet backed
  // up"); the seal waits for THIS frame's trusted click. Same recovery wallet as the copy it replaces; Cancel changes nothing.
  // A phone that restored through the old copy then proves its seed with the new one (mainRecoveryAdopt) and backs up the
  // wallets it made. An 'rk1' device itself can update only with the main's signature handed in (mainSigFor checks it is the
  // main's, over its text, and derives exactly this seed) — and that same proof upgrades its own seed to 'main'.
  mainRecoveryUpdate: async (src: { address: string; recovery: string; signature: string; mainSignature?: string; profile?: Profile | null }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address), r = lc(src?.recovery);
    const seed = seedOf(m); if (!seed) throw new Error('Main wallet not attached on this device');
    if (!/^0x[0-9a-f]{40}$/.test(r) || r === m) throw new Error('Bad recovery wallet');
    const p = src?.profile && typeof src.profile === 'object' ? src.profile : null;
    if (p && lc(p.main) !== m) throw new Error('That profile belongs to another main wallet');
    if (p?.fp && p.fp !== await fingerprint(seed)) throw new Error('fingerprint mismatch: this profile was built with another signature');
    if (p && validRecovery(p.rk)) {
      if (lc(p.rk.addr) !== r) throw new Error('Phone access uses another recovery wallet for this account');
      if (recoveryBodyVersion(p.rk) === 2) return { ok: true, already: true };   // nothing to update
    }
    const signer = await recoverMessageAddress({ message: RECOVERY_MSG(m, r), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, r)) throw new Error('That signature is not from the recovery wallet');
    const rk1 = meta.seedSrc?.[m] === 'rk1';
    if (rk1 && !/^0x[0-9a-fA-F]{130}$/.test(String(src?.mainSignature || ''))) throw new Error('Connect your main wallet and sign once to update phone access');
    const { sig, mv } = await mainSigFor(m, src.mainSignature);   // the main's own signature, deriving exactly this seed
    const L = UPDATE_DIALOG[uiLang()];
    if (!(await ask({ title: L.title, ok: L.ok, cancelLabel: L.cancel, html: `${sub(escHtml(L.sub))}${muted(escHtml(L.why))}${signedIn(m)}${addrRows([{ name: L.wallet, address: r }])}${muted(escHtml(L.note))}` }))) throw new Error('Cancelled');
    const rk = await sealRecovery(m, r, String(src.signature), seed, sig, mv);
    recoveryChange.set(m, { rk, at: Date.now() }); meta.changedAt = Date.now();
    if (rk1) { meta.seedSrc = { ...(meta.seedSrc || {}), [m]: 'main' }; if (meta.rk1?.[m]) { const { [m]: _, ...rest } = meta.rk1; meta.rk1 = rest; } }
    await persist(); pushBackupState();
    return { ok: true, recovery: r, ...(rk1 ? { adopted: true } : {}) };
  },
  // The other half, on a device whose seed came from a legacy copy ('rk1'): the server now holds a v2 copy (a desktop updated
  // it). Opened with the account's recovery wallet's signature, its bound main signature must be the main's own over its
  // text AND derive EXACTLY the seed this device already uses (rkMigrate adoptCheck) — then that seed is proven: it is marked
  // 'main' and the next publish seals every wallet of this device into the account backup, a union with the server copy
  // (nothing dropped, nothing removed, no key changes). No dialog: it only adds this device's own wallets to its own account's
  // backup under a seed the main has now vouched for (the page tells the user). Anything that does not check out changes
  // nothing and says why.
  mainRecoveryAdopt: async (src: { address: string; recovery: string; signature: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address), r = lc(src?.recovery), p = src?.profile;
    const seed = seedOf(m); if (!seed) return { ok: false, why: 'not-attached' };
    if (meta.seedSrc?.[m] !== 'rk1') return { ok: true, already: true };
    if (!p || typeof p !== 'object' || lc(p.main) !== m || !validRecovery(p.rk) || lc(p.rk.addr) !== r) return { ok: false, why: 'no-copy' };
    if (recoveryBodyVersion(p.rk) !== 2) return { ok: false, why: 'legacy' };
    const signer = await recoverMessageAddress({ message: RECOVERY_MSG(m, r), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, r)) throw new Error('That signature is not from the recovery wallet');
    const opened = await openRecovery(p.rk, m, String(src.signature));
    const v = await adoptCheck({ opened, main: m, localSeed: seed, localMv: mvOf(m), fp: String(p.fp || ''), fingerprint, recover: (message, signature) => recoverMessageAddress({ message, signature: signature as `0x${string}` }) });
    if (!v.ok) return { ok: false, why: v.why };
    const joining = unboundOf(m).filter((w) => w.kind !== 'hop').map((w) => ({ name: w.name, address: w.address }));
    seeds[MS(m)] = v.ms;
    meta.seedSrc = { ...(meta.seedSrc || {}), [m]: 'main' };
    if (meta.rk1?.[m]) { const { [m]: _, ...rest } = meta.rk1; meta.rk1 = rest; }
    meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, adopted: true, wallets: joining, ...storageFlags() };
  },
  // A device logged in to the account without the main (an email login of a Rabby account): the account's Privy wallet
  // signs the recovery text, the seed comes out of the profile's `rk`, must match the profile's fingerprint, and the
  // wallets it opens are listed for ONE trusted click (the restore that follows adds exactly those).
  mainAttachRecovery: async (src: { address: string; recovery: string; signature: string; profile: Profile; mv?: number; keepInBackup?: boolean }) => {
    await ready; if (!HOST) throw new Error('main wallets attach in the vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address), r = lc(src?.recovery), p = src?.profile;   // V12 F-56
    if (seedOf(m)) return { ok: true, already: true, ...summary() };
    if (!p || lc(p.main) !== m || !validRecovery(p.rk) || lc(p.rk.addr) !== r) throw new Error('This account has no recovery copy for that wallet');
    const signer = await recoverMessageAddress({ message: RECOVERY_MSG(m, r), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, r)) throw new Error('That signature is not from the recovery wallet');
    const opened = await openRecovery(p.rk, m, String(src.signature));
    if (!opened) throw new Error('The recovery copy does not open with this account');
    const seed = opened.seed;
    if (!p.fp || (await fingerprint(seed)) !== p.fp) throw new Error('fingerprint mismatch: the recovery copy does not match this account');
    // V12 F-28: a v2 recovery copy carries the main's own signature (ms). Verify it is the main's signature over its
    // text AND that it derives exactly this seed — then the seed is as trustworthy as a real mainAttach. A legacy v1
    // copy has no ms: it still opens (existing recovery users keep access), but the seed is marked 'rk1' below and the
    // vault publishes only what this account restored and generates new wallets off it, never sealing other keys here.
    let verified = false;
    if (opened.ms) {
      const mvMs: MainMsgVersion = opened.mv === 2 ? 2 : 1;
      const msSigner = await recoverMessageAddress({ message: MAIN_MSG(m, mvMs), signature: opened.ms as `0x${string}` }).catch(() => '');
      if (!same(msSigner, m)) throw new Error('The recovery copy is not bound to this main wallet');
      if (await seedOfSignature(opened.ms) !== seed) throw new Error('The recovery copy does not match this main wallet');
      verified = true;
    }
    const o = await openProfile(p, seed, saltsOf());
    const have = new Set(allAccounts().map((a) => lc(a.address)));
    const v1: { name: string; address: string }[] = [];
    for (let i = 0; i < Math.min(SUB_CAP, Math.max(0, Math.floor(Number(p.count) || 0))); i += 1) v1.push({ name: String(p.names?.[String(i)] || `Wallet ${i + 1}`), address: privateKeyToAccount(await subKey(seed, i)).address });
    const list = [...v1, ...o.wallets.filter((w) => !have.has(lc(w.address))).map((w) => ({ name: w.name, address: w.address }))];
    // "Create new anyway" (vault-client.js): the account is used here — new wallets join the SAME backup — and the backed-up
    // wallets stay where they are, restorable any time. Still the trusted click: the seed this attaches decides where
    // every new wallet comes from.
    if (src?.keepInBackup) {
      if (!(await ask({ title: 'Use your account here', ok: 'Continue', cancelLabel: 'Not now', keep: true, html: `${sub(`${list.length ? `Your ${plural(list.length, 'wallet')} stay in your encrypted backup.` : 'Your encrypted backup stays as it is.'} New wallets you create here are added to it.`)}${signedIn(m)}${muted('Restore the others any time from Wallets.')}` }))) throw new Error('Cancelled');
    } else if (!(await ask({ title: 'Restore your wallets', ok: list.length ? `Restore ${plural(list.length, 'wallet')}` : 'Restore', cancelLabel: 'Not now', keep: true, html: `${sub(list.length ? `${plural(list.length, 'wallet')} available in your encrypted backup.` : 'Your encrypted backup is ready.')}${signedIn(m)}${list.length ? addrRows(list) : ''}${muted(`Check that you recognize ${recognizeAll(list.length)} before restoring.`)}` }))) throw new Error('Cancelled');
    const mv: MainMsgVersion = verified ? (opened.mv === 2 ? 2 : 1) : (src?.mv === 2 ? 2 : 1);
    seeds[m] = seed; meta.main = m;
    if (mv === 2) meta.mainMv = { ...(meta.mainMv || {}), [m]: 2 }; else if (meta.mainMv?.[m]) { const { [m]: _, ...rest } = meta.mainMv; meta.mainMv = rest; }
    // V12 F-28: record where this seed came from. A verified (v2-bound) copy is 'main' — the main's own signature is kept
    // so recovery can be re-sealed, and the full backup behaves normally. An unbound legacy copy is 'rk1': remember the
    // exact addresses restored from this account's profile plus its salts, so mainProfile seals only those (never this
    // device's other wallets) and create() generates standalone keys instead of deriving off a seed it cannot vouch for.
    if (verified) {
      seeds[MS(m)] = String(opened.ms);
      meta.seedSrc = { ...(meta.seedSrc || {}), [m]: 'main' };
    } else {
      meta.seedSrc = { ...(meta.seedSrc || {}), [m]: 'rk1' };
      meta.rk1 = { ...(meta.rk1 || {}), [m]: { addrs: [...o.wallets.map((w) => lc(w.address)), ...v1.map((x) => lc(x.address))], salts: o.salts } };
    }
    // the recovery copy stays the server's: this vault carries whatever the server holds on its next publish (no own copy)
    if (!src?.keepInBackup) preApproved = { main: m, addrs: new Set(o.wallets.map((w) => lc(w.address))), at: Date.now() };
    await persist();
    return { ok: true, fp: p.fp, mv, ...storageFlags(), ...summary() };
  },
  // Before a new wallet joins while the account backup holds wallets this device has not restored (vault-client.js asks
  // only then): "Restore them first?" — the answer is the page's to act on; nothing changes here. A dialog of the frame
  // so it shows where the page cannot draw (the app's hidden wallet frame).
  restoreFirst: async (n: number, what?: string) => {
    await ready;
    const k = Math.max(1, Math.min(200, Math.floor(Number(n) || 0)));
    const verb = what === 'import' ? 'Import' : 'Create';
    const choice = await askChoice({ title: 'Restore your wallets first?', ok: '', cancel: false, html: sub(`You have ${plural(k, 'wallet')} in your encrypted backup. Your backup keeps ${k === 1 ? 'it' : 'all of them'} either way.`),
      choices: [{ id: 'restore', label: `Restore ${plural(k, 'wallet')}`, primary: true }, { id: 'create', label: what === 'import' ? 'Import the new wallet instead' : 'Create a new wallet instead' }] });
    return { ok: true, choice: choice === 'restore' || choice === 'create' ? choice : null };
  },
  mainDetach: async () => { await ready; requireUnlocked(); meta.main = null; await persist(); return { ok: true, ...summary() }; },
  // The account's USD-balance consent record from a server copy the page just read (vault-client: every 30 s while visible,
  // and right after its own publish): another device's switch on or off is followed here, without a dialog, only when the
  // record opens under this account's seed, carries a valid signature by one of its wallets and is newer than this
  // device's own (src/floatConsent.ts). Nothing else of the profile is read or changed.
  mainConsent: async (src: { address: string; profile: Profile | null }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const seed = seedOf(m);   // V12 F-56
    if (!seed) return { ok: true, action: 'keep', why: 'not-attached' };
    const p = src?.profile && typeof src.profile === 'object' ? src.profile : null;
    if (!p || lc(p.main) !== m || (p.fp && p.fp !== await fingerprint(seed))) return { ok: true, action: 'keep', why: 'none' };
    const v = await consentReceive(float.consent, { main: m, seed, blob: p.uc, own: consentOwn(m, seed, p), now: Date.now() });
    return { ok: true, action: v.action, ...(v.why ? { why: v.why } : {}) };
  },
  // The account's profile from the server, applied: v1 trading wallets re-derived from the count, the vault salts
  // taken back, every sealed wallet (backup v3; older v2/v1 wrapped keys too) opened. Wallets that arrive here
  // and are not in the vault yet are listed in a dialog and join on a trusted click — a page that can obtain the
  // main's signature could have sealed its own key into the profile to slip it in as "ours".
  mainSync: async (src: { address: string; profile: Profile | null; add?: boolean }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const seed = seedOf(m); if (!seed) throw new Error('Main wallet not attached');   // V12 F-56
    meta.main = m;
    const p = src?.profile && typeof src.profile === 'object' ? src.profile : null;
    let derived = 0, unwrapped = 0, mismatch = false, sealed = 0, declined = 0, salts = 0;
    // backup v4: entries open only with a data key this vault unwrapped (passkeyUnlock / passkeyRecover); without it they stay
    // sealed and are carried, and the page is told the backup is locked here
    let passkey: 'open' | 'locked' | undefined;
    if (p) {
      if (p.fp && p.fp !== await fingerprint(seed)) mismatch = true;
      else {
        derived = await deriveSubs(m, Number(p.count) || 0, p.names || {});
        const pk4 = normPk(p.pk); const k4 = await v4KeysOf(m, pk4);
        if (pk4) { passkey = k4.current ? 'open' : 'locked'; if (k4.current && meta.pk4?.[m] !== pk4.gen) meta.pk4 = { ...(meta.pk4 || {}), [m]: pk4.gen }; }
        const o = await openProfile(p, seed, saltsOf(), k4.keys);
        salts = adoptSalts(o.salts);
        remoteCarry.set(m, o.unopened);
        sealed = o.unopened.length;
        const removed = new Set(meta.removedAddrs || []);
        const incoming: OpenedWallet[] = [];
        for (const w of o.wallets) {
          const have = allAccounts().find((a) => same(a.address, w.address));
          if (have) { if (w.name && have.name !== w.name) have.name = w.name; continue; }
          if (removed.has(lc(w.address))) continue;   // removed here on purpose; the profile keeps it until no device publishes it
          incoming.push(w);
        }
        const approved = preApproved && preApproved.main === m && Date.now() - preApproved.at < 120_000 && incoming.every((w) => preApproved!.addrs.has(lc(w.address)));
        // add:false — the page's "Create new anyway": nothing joins, nothing is asked (adding is what needs the click,
        // leaving out never does); the entries stay in the profile and every publish carries them
        if (incoming.length && src?.add === false) declined = incoming.length;
        else if (incoming.length && approved) {
          preApproved = null;
          for (const w of incoming) {
            const slotTaken = w.main && w.index != null && subsOf(w.main).some((a) => a.index === w.index);
            await addAccount(w.name || nextName(w.kind === 'imported' ? 'Imported' : 'Created'), w.key, { ...(w.kind === 'hop' ? { hop: true } : {}), ...(w.main && w.index != null && !slotTaken ? { main: w.main, index: w.index } : {}), ...(w.gen === 2 ? { gen: 2 as const } : {}), ...(w.kind === 'created' || w.kind === 'imported' ? { kind: w.kind } : {}), ...(w.via === 'page' ? { via: 'page' as const } : {}), ...(w.archived ? { archived: true } : {}), ...(w.createdAt ? { createdAt: w.createdAt } : {}) });
            unwrapped += 1;
          }
        } else if (incoming.length) {
          const ok = await ask({ title: 'Restore your wallets', ok: `Restore ${plural(incoming.length, 'wallet')}`, cancelLabel: 'Not now', keep: true, html: `${sub(`${plural(incoming.length, 'wallet')} in your encrypted backup ${incoming.length === 1 ? 'isn\'t' : 'aren\'t'} in this browser yet.`)}${signedIn(m)}${addrRows(incoming)}${muted(`Check that you recognize ${recognizeAll(incoming.length)} before restoring.`)}` });
          if (ok) {
            for (const w of incoming) {
              const slotTaken = w.main && w.index != null && subsOf(w.main).some((a) => a.index === w.index);
              await addAccount(w.name || nextName(w.kind === 'imported' ? 'Imported' : 'Created'), w.key, { ...(w.kind === 'hop' ? { hop: true } : {}), ...(w.main && w.index != null && !slotTaken ? { main: w.main, index: w.index } : {}), ...(w.gen === 2 ? { gen: 2 as const } : {}), ...(w.kind === 'created' || w.kind === 'imported' ? { kind: w.kind } : {}), ...(w.via === 'page' ? { via: 'page' as const } : {}), ...(w.archived ? { archived: true } : {}), ...(w.createdAt ? { createdAt: w.createdAt } : {}) });
              unwrapped += 1;
            }
          } else declined = incoming.length;
        }
      }
    }
    if (derived || unwrapped) meta.changedAt = Date.now();
    // the server copy the page just showed: coverage only shrinks to what it holds (a fingerprint mismatch teaches nothing)
    if (!mismatch) narrowCoverage(m, p);
    await persist();
    pushBackupState();
    // the account's USD-balance consent (src/floatConsent.ts): another device's switch is followed here, without a dialog
    let consent: string | undefined;
    if (p && !mismatch) { const v = await consentReceive(float.consent, { main: m, seed, blob: p.uc, own: consentOwn(m, seed, p), now: Date.now() }).catch(() => null); consent = v ? (v.action === 'keep' ? v.why : v.action) : 'error'; }
    return { ok: true, derived, unwrapped, mismatch, sealed, declined, salts, ...(consent ? { consent } : {}), ...(passkey ? { passkey } : {}), ...storageFlags(), ...summary() };
  },
  // What the server keeps for this account: the v1 count and names, the vault salts and every other keyed wallet
  // sealed under the seed key (backup v3), plus whatever the server copy holds that this vault did not write
  // (another device's wallets, blobs it cannot open) — a publish never drops them. No plain key, ever.
  mainProfile: async (address: string, remote?: Profile | null) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(address); const seed = seedOf(m); if (!seed) throw new Error('Main wallet not attached');   // V12 F-56
    const subs = subsV1Of(m);
    let count = subs.reduce((n, a) => Math.max(n, (a.index ?? -1) + 1), 0);
    const names: Record<string, string> = {}; for (const a of subs) names[String(a.index)] = a.name;
    const fromServer = remote && typeof remote === 'object' && lc(remote.main) === m && Array.isArray(remote.attached) ? remote.attached : [];
    if (narrowCoverage(m, remote)) { await persist(); pushBackupState(); }
    // A publish is a strict union with the server copy (owner 2026-10-19): sealed entries are carried by buildProfile;
    // the v1 count too — a device that declined the restore (or has not derived them yet) must not shrink it. Only a
    // wallet removed here by the remove dialog (removedAddrs) stays out.
    if (remote && typeof remote === 'object' && lc(remote.main) === m && (!remote.fp || remote.fp === await fingerprint(seed))) {
      const removed = new Set(meta.removedAddrs || []);
      const rc = Math.min(SUB_CAP, Math.max(0, Math.floor(Number(remote.count) || 0)));
      for (let i = count; i < rc; i += 1) {
        const addr = lc(privateKeyToAccount(await subKey(seed, i)).address);
        if (removed.has(addr)) continue;
        count = i + 1;
        const nm = remote.names?.[String(i)]; if (nm && !names[String(i)]) names[String(i)] = String(nm).slice(0, 40);
      }
    }
    // V12 F-28: an 'rk1' main's seed came from an unbound legacy recovery copy — not proven to be the real main's. Seal
    // ONLY what was actually restored from that account's profile (those addresses + its own salts), never this device's
    // independently created / imported wallets, so we don't widen who can open the backup under a seed we cannot vouch
    // for. A later mainAttach with the main's real signature flips seedSrc to 'main' and the full backup resumes.
    const rk1 = meta.seedSrc?.[m] === 'rk1';
    const rk1Covered = rk1 ? new Set((meta.rk1?.[m]?.addrs || []).map(lc)) : null;
    const walletsToSeal = rk1 ? backupWalletsOf(m).filter((w) => rk1Covered!.has(lc(w.address))) : backupWalletsOf(m);
    const saltsToSeal = rk1 ? (meta.rk1?.[m]?.salts || []) : saltsOf();
    // backup v4: the envelope is this frame's own change (a passkey added / removed, a new code) or the server's, carried; the
    // entries are sealed under the current generation's K4. A v4 account whose key is not here publishes nothing (PasskeyLocked:
    // the page asks for one passkey touch), and a vault that knows the account is v4 never writes a v3 copy over a server copy
    // that lost its envelope (PasskeyBackupMissing) — the server refuses such a write too.
    const pkc = pkChange.get(m);
    const pkOut = pkc ? pkc.pk : remote && typeof remote === 'object' && lc(remote.main) === m ? normPk(remote.pk) : null;
    // …unless motion's operator put the account's held v3 copy back on a support request (server/account-passkey.mjs cold hold):
    // the live profile then carries pkRestoredAt, which only the server sets (a profile write cannot), and this vault follows it
    if (!pkOut && meta.pk4?.[m] && remote && lc(remote.main) === m && Number.isSafeInteger((remote as { pkRestoredAt?: number }).pkRestoredAt)) { const { [m]: _, ...rest } = meta.pk4; meta.pk4 = rest; await persist(); }
    if (!pkOut && meta.pk4?.[m] && !pkPending.has(m)) throw pkError('PasskeyBackupMissing', pkt('backupMissing'));
    let k4: CryptoKey | null = null;
    if (pkOut) { k4 = (await v4KeysOf(m, pkOut)).current; if (!k4) throw pkError('PasskeyLocked', pkt('lockedPublish')); }
    const r = await buildProfile({ main: m, seed, count, names, wallets: walletsToSeal, salts: saltsToSeal, carry: [...fromServer, ...(remoteCarry.get(m) || [])] as ProfileEntry[], forget: meta.removedAddrs || [], mv: mvOf(m), ...(k4 ? { v4: { key: k4 } } : {}) });
    // account recovery (rk): a change made in this frame by a trusted click (sealed here, or null = turned off here) until
    // the server confirms it; otherwise exactly the server copy's, carried — never a copy this vault kept from before
    const change = recoveryChange.get(m);
    const rk = change ? change.rk : remote && lc(remote.main) === m && validRecovery(remote.rk) ? remote.rk : undefined;
    if (rk !== undefined) { (r.profile as Profile).rk = rk; r.digest = r.digest.slice(0, 24) + (rk ? rk.iv.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : 'off00000'); }
    // the account's USD-balance consent (src/floatConsent.ts): the server's record is taken in first, then this device's newest
    // is sealed under the seed — never one older than the server's authentic copy. The page posts when its counter changes.
    const remoteHere = remote && typeof remote === 'object' && lc(remote.main) === m ? remote : null;
    const uc = await consentOutgoing(float.consent, { main: m, seed, blob: remoteHere?.uc, own: consentOwn(m, seed, remoteHere), now: Date.now() }).catch(() => null);
    // (the digest stays [0-9A-Za-z]{24,40}: the native vault's mainPublished check)
    if (uc?.blob) { (r.profile as Profile).uc = uc.blob; r.digest = r.digest.slice(0, 32) + 'u' + uc.blob.n.toString(36).slice(-5) + uc.blob.o; }
    if (pkOut) {
      (r.profile as Profile).pk = pkOut;
      // any envelope change is a new digest (40 hex: still the native vault's [0-9A-Za-z]{24,40})
      r.digest = bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(r.digest + '|' + canon(pkOut))))).slice(2, 42);
    }
    pendingPublish.set(r.digest, { main: m, addrs: r.covered, count, ...(change ? { change } : {}), ...(pkc ? { pkc } : {}) });
    if (pendingPublish.size > 20) pendingPublish.delete(pendingPublish.keys().next().value as string);
    return { ok: true, profile: r.profile, digest: r.digest, covered: r.covered.length, own: r.covered, dropped: r.dropped };
  },
  // the page saved that profile and the server confirmed it: the account backup now covers exactly those wallets
  mainPublished: async (src: { digest: string; updatedAt?: number }) => {
    await ready; requireUnlocked();
    const p = pendingPublish.get(String(src?.digest || '')); if (!p) return { ok: false };
    // the server holds this frame's phone-access change now: from here on its copy is the one carried
    if (p.change && recoveryChange.get(p.main) === p.change) recoveryChange.delete(p.main);
    // …and its passkey-envelope change
    if (p.pkc && pkChange.get(p.main) === p.pkc) pkChange.delete(p.main);
    meta.account = { main: p.main, at: Math.min(Date.now(), Number(src?.updatedAt) || Date.now()), addrs: p.addrs, digest: String(src.digest), ...(p.count != null ? { count: p.count } : {}) };
    await persist(); pushBackupState();
    return { ok: true };
  },
  // (audit 2026-11-01, vault-security-backup-coverage) the page learned the server keeps no copy for this account any more
  // ("Remove my backup from motion's server", "File only", or a profile read answering backup 'file' on another device): the
  // coverage record goes, so the remove dialog says "not in your encrypted backup" and the backup nudge comes back. It can
  // only take coverage away (never adds any), so it needs no click.
  backupDropped: async (src?: { address?: string }) => {
    await ready; requireUnlocked();
    const acc = meta.account; if (!acc) return { ok: true, dropped: false };
    const want = src && typeof src === 'object' && typeof src.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(src.address) ? lc(src.address) : '';
    if (want && lc(acc.main) !== want) return { ok: true, dropped: false };
    meta.account = null; await persist(); pushBackupState();
    return { ok: true, dropped: true };
  },
  // ── backup v4: a passkey as the second factor on the account backup (src/passkeyBackup.ts) ──
  // What this browser can do. `offer` is the page's cue for "Protect your backup with a passkey": WebAuthn here, the vault on its
  // own https host (the RP ID), PRF not known to be missing, and not the app's native vault unless PASSKEY_POLICY.offerNative.
  passkeySupport: async (o?: { native?: boolean }) => {
    await ready;
    const P = (globalThis as unknown as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>>; isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
    const webauthn = !!P && !!wa()?.create && !!wa()?.get;
    let prf: 'yes' | 'no' | 'unknown' = 'unknown', platform: boolean | null = null;
    try { const caps = await P?.getClientCapabilities?.(); if (caps && 'extension:prf' in caps) prf = caps['extension:prf'] ? 'yes' : 'no'; } catch {}
    try { platform = (await P?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? null; } catch {}
    const origin = pkOriginOk();
    const native = !!o?.native;
    return { ok: true, webauthn, prf, platform, origin, rpId: PK_RP, native, offer: webauthn && origin && prf !== 'no' && (!native || PASSKEY_POLICY.offerNative), policy: { ...PASSKEY_POLICY } };
  },
  // The account's v4 state as this vault sees it: no secret, no credential id in full.
  passkeyStatus: async (src: { address: string; profile?: Profile | null }) => {
    await ready;
    const m = mainAddr(src?.address);
    const p = src?.profile && typeof src.profile === 'object' && lc(src.profile.main) === m ? src.profile : null;
    const pk = pkChange.get(m)?.pk || normPk(p?.pk);
    const k = seedOf(m) && pk ? await v4KeysOf(m, pk) : { keys: [], current: null };
    const rec = recoveryPaths(pk, { dkCached: !!k.current });
    return { ok: true, v4: !!pk, gen: pk?.gen || 0, unlocked: !!k.current, known: meta.pk4?.[m] || 0, pending: pkPending.get(m)?.mode || null,
      passkeys: (pk?.slots || []).map((s) => ({ id: s.id.slice(0, 8), name: s.name, at: s.at, sync: s.sync ?? null, here: s.rp === PK_RP })), code: !!pk?.rc, recovery: rec };
  },
  // Turn it on: one new passkey (create + one confirming touch), the recovery code shown once, and the whole live backup re-sealed
  // as v4. Nothing is written here and nothing is cached: the page stages the result on the server, hands the server's copy to
  // passkeyVerify (a FRESH touch), and only then does the server swap it in and drop the v3 copy.
  passkeyEnrol: async (src: { address: string; profile: Profile | null; native?: boolean }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address);
    if (!pkOriginOk()) throw pkError('PasskeyUnsupported', pkt('unsupportedOrigin'));
    if (src?.native && !PASSKEY_POLICY.offerNative) throw pkError('PasskeyUnsupported', pkt('unsupportedApp'));
    const live = pkLive(m, src?.profile);
    if (normPk(live?.pk)) throw new Error(pkt('alreadyOn'));
    const seed = await pkSeed(m, live);
    const fresh = await newCore({ main: m, seed, gen: 1 });
    const n = live?.attached?.length || 0;
    const got = await pkEnrolPrf(m, new Uint8Array(atob(fresh.core.salt).split('').map((c) => c.charCodeAt(0))), [], {
      title: pkt('on1Title'), ok: pkt('btnCreate'), step: { n: 1, of: 4 },
      html: `${pkSub('on1Lead')}${pkLine('on1Need')}${pkWho(m)}${muted(`${escHtml(pkt('on1Sync'))}${n ? ` ${escHtml(pkt('on1Entries', { n }))}` : ''}`)}${pkMuted('on1Note')}`,
    });
    let core = await addSlot(fresh.core, { main: m, dk: fresh.dk, id: got.id, rp: PK_RP, prf: got.prf, name: got.name, ...(got.aaguid ? { aaguid: got.aaguid } : {}), ...(got.sync !== null ? { sync: got.sync } : {}) });
    let code = false;
    if (PASSKEY_POLICY.codeAtEnrol) {
      const rc = await newRecoveryCode();
      const ans = await pkShowCode(rc.text, fileCurrent(), { step: { n: 3, of: 4 } });
      if (!ans) { pkForget(got.id); throw new Error('Cancelled'); }
      if (ans === 'saved') { core = await setCode(core, { main: m, dk: fresh.dk, code: rc.bytes }); code = true; }
    } else if (PASSKEY_POLICY.requireSaved && !fileCurrent()) {
      pkForget(got.id); throw pkError('PasskeyNeedsFile', pkt('needsFile'));
    }
    const pk = normPk({ v: 4, ...core })!;
    const inp = publishInputs(m);
    const up = await upgradeProfile({ live, main: m, seed, mv: mvOf(m), ...inp, pk, dk: fresh.dk });
    pkPending.set(m, { mode: 'up', gen: pk.gen, at: Date.now() });
    return { ok: true, staged: up.profile, wallets: up.addresses.length, salts: up.salts.length, passkey: { name: got.name, sync: got.sync }, code, timing: { verifyTouchMs: Math.round(got.ms) }, recovery: recoveryPaths(pk, { dkCached: false }) };
  },
  // The server's staged copy (as the server hands it back) is opened with a FRESH passkey touch — not the keys that sealed it —
  // and checked against the live copy (every wallet and salt, same keys, all v4, nothing foreign, records unchanged). Only an
  // ok here lets the page confirm the swap; the DK is kept next to the seed from now on. mode 'off': the staged v3 copy must
  // open with the seed alone and hold every wallet the live v4 copy holds.
  passkeyVerify: async (src: { address: string; mode?: 'up' | 'off'; staged: Profile; live: Profile | null }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address), mode = src?.mode === 'off' ? 'off' : 'up';
    const staged = src?.staged && typeof src.staged === 'object' ? src.staged : null;
    if (!staged || lc(staged.main) !== m) throw new Error('No staged backup for this main wallet');
    const live = pkLive(m, src?.live);
    const seed = await pkSeed(m, live);
    let stagedKeys: CryptoKey[] = [], liveKeys: CryptoKey[] = [], touchMs = 0;
    if (mode === 'up') {
      const pk = normPk(staged.pk); if (!pk) return { ok: false, why: 'envelope' };
      const u = await pkUnlockWith(m, pk, { title: pkt('checkTitle'), ok: pkt('btnUse'), step: { n: 4, of: 4 }, html: `${pkSub('checkLead')}${pkLine('needPasskey')}${pkWho(m)}${pkMuted('checkNote')}` });
      touchMs = u.ms;
      const k = await k4Of(m, pk); if (!k) return { ok: false, why: 'envelope' };
      stagedKeys = [k];
    } else {
      const lpk = normPk(live?.pk); if (!lpk) return { ok: false, why: 'envelope' };
      liveKeys = (await v4KeysOf(m, lpk)).keys;
      if (!liveKeys.length) throw pkError('PasskeyLocked', pkt('lockedFirst'));
    }
    const t0 = performance.now();
    const v = await verifyStaged({ mode, staged, live, main: m, seed, stagedKeys, liveKeys, localSalts: saltsOf() });
    const verifyMs = performance.now() - t0;
    if (!v.ok) return { ok: false, why: v.why, ...(v.detail ? { detail: v.detail } : {}) };
    await persist();
    return { ok: true, digest: await stageDigest(staged), wallets: v.wallets, salts: v.salts, timing: { touchMs: Math.round(touchMs), verifyMs: Math.round(verifyMs) } };
  },
  // the server swapped the staged copy in (POST /api/account/passkey/confirm answered ok): this vault now treats the account as
  // v4 (never publishing a v3 copy for it again) — or, after "off", as v3 again, forgetting its data keys
  passkeyConfirmed: async (src: { address: string; mode?: 'up' | 'off'; gen?: number }) => {
    await ready; requireUnlocked();
    const m = mainAddr(src?.address);
    if (src?.mode === 'off') {
      // (audit 2026-11-01, vault-security-passkey-confirmed) dropping this device's v4 guard and its data keys only finishes a
      // turn-off THIS frame staged (passkeyOff: two dialogs and a fresh touch) in the last PK_OFF_CONFIRM_MS — never a bare
      // page call. ('up' needs no such check: it only records a generation whose data key this vault already holds.)
      const pend = pkPending.get(m);
      if (!pend || pend.mode !== 'off' || Date.now() - pend.at > PK_OFF_CONFIRM_MS) throw new Error('No passkey turn-off is pending here — the passkey keys on this device were left as they are');
      if (meta.pk4?.[m]) { const { [m]: _, ...rest } = meta.pk4; meta.pk4 = rest; }
      for (const k of Object.keys(seeds)) if (k.startsWith(`pk4:${m}:`)) delete seeds[k];
      for (const k of [...k4Cache.keys()]) if (k.startsWith(m + '|')) k4Cache.delete(k);
      pkChange.delete(m);
    } else {
      const gen = Math.max(1, Math.floor(Number(src?.gen) || pkPending.get(m)?.gen || 1));
      if (!dkOf(m, gen)) throw pkError('PasskeyLocked', pkt('lockedConfirm'));
      meta.pk4 = { ...(meta.pk4 || {}), [m]: gen };
    }
    pkPending.delete(m); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true };
  },
  // a v4 account on a device that has not unwrapped its data key yet (a new phone, a vault from before the enrolment): one touch
  passkeyUnlock: async (src: { address: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = normPk(live?.pk); if (!pk) return { ok: true, v4: false };
    await pkSeed(m, live);
    if ((await v4KeysOf(m, pk)).current) return { ok: true, already: true, gen: pk.gen };
    const u = await pkUnlockWith(m, pk, { title: pkt('unlockTitle'), ok: pkt('btnUse'), html: `${pkSub('unlockLead')}${pkLine('needPasskey')}${pkWho(m)}${pkMuted('unlockNote')}` });
    if (u.gen === pk.gen) meta.pk4 = { ...(meta.pk4 || {}), [m]: pk.gen };
    meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, gen: u.gen, current: u.gen === pk.gen, timing: { touchMs: Math.round(u.ms) } };
  },
  // every passkey lost: the recovery code, typed into this frame's own dialog (it never reaches the page)
  passkeyRecover: async (src: { address: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = normPk(live?.pk); if (!pk) return { ok: true, v4: false };
    const seed = await pkSeed(m, live);
    if (!coresOf(pk).some((c) => c.rc)) throw pkError('PasskeyNoCode', pkt('noCode'));
    let got: { dk: string; gen: number } | null = null;
    const ok = await ask({ title: pkt('recTitle'), ok: pkt('btnOpen'), cancelLabel: pkt('btnNotNow'), keep: true,
      html: `${pkSub('recLead')}${pkWho(m)}<label class="dlg-f-row">${escHtml(pkt('recLabel'))}<input type="text" id="pk-code" autocomplete="off" spellcheck="false" maxlength="40" /></label>${pkMuted('recNote')}`,
      validate: async (root) => {
        const parsed = await parseRecoveryCode((root.querySelector('#pk-code') as HTMLInputElement | null)?.value || '');
        if (parsed === null) return pkt('recBad');
        if (parsed === 'check') return pkt('recTypo');
        got = await dkFromCode(pk, { main: m, code: parsed });
        if (!got || !(await checkDk(coresOf(pk).find((c) => c.gen === got!.gen)!, seed, m, got.dk))) { got = null; return pkt('recNoOpen'); }
        return null;
      } });
    if (!ok || !got) throw new Error('Cancelled');
    const g = got as { dk: string; gen: number };
    seeds[PK(m, g.gen)] = g.dk;
    if (g.gen === pk.gen) meta.pk4 = { ...(meta.pk4 || {}), [m]: pk.gen };
    meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, gen: g.gen, current: g.gen === pk.gen, passkeys: pk.slots.length };
  },
  // a second (or replacement) passkey: needs this vault unlocked for the current generation; the change rides in the next publish
  passkeyAdd: async (src: { address: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = pkChange.get(m)?.pk || normPk(live?.pk); if (!pk) throw new Error(pkt('notOn'));
    await pkSeed(m, live);
    if (!pkOriginOk()) throw pkError('PasskeyUnsupported', pkt('unsupportedOrigin'));
    const dk = dkOf(m, pk.gen); if (!dk || !(await k4Of(m, pk))) throw pkError('PasskeyLocked', pkt('lockedFirst'));
    const got = await pkEnrolPrf(m, new Uint8Array(atob(pk.salt).split('').map((c) => c.charCodeAt(0))), pk.slots.map((s) => s.id), {
      title: pkt('add1Title'), ok: pkt('btnCreate'), step: { n: 1, of: 2 },
      html: `${pkSub('add1Lead')}${pkLine('add1Need')}${pkWho(m)}${muted(escHtml(pkt('add1Count', { n: pk.slots.length })))}${pkMuted('add1Note')}`,
    });
    const core = await addSlot(pk, { main: m, dk, id: got.id, rp: PK_RP, prf: got.prf, name: got.name, ...(got.aaguid ? { aaguid: got.aaguid } : {}), ...(got.sync !== null ? { sync: got.sync } : {}) });
    const next = normPk({ ...pk, ...core, v: 4 })!;
    pkChange.set(m, { pk: next, at: Date.now() }); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, passkeys: next.slots.length, passkey: { name: got.name, sync: got.sync }, recovery: recoveryPaths(next, { dkCached: true }) };
  },
  passkeyRemove: async (src: { address: string; profile: Profile; id: string }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = pkChange.get(m)?.pk || normPk(live?.pk); if (!pk) throw new Error(pkt('notOn'));
    await pkSeed(m, live);
    if (!(await k4Of(m, pk))) throw pkError('PasskeyLocked', pkt('lockedFirst'));
    const slot = pk.slots.find((s) => s.id === src?.id || s.id.slice(0, 8) === String(src?.id || '')); if (!slot) throw new Error(pkt('noSuchPasskey'));
    const core = removeSlot(pk, slot.id);
    const next = normPk({ ...pk, ...core, v: 4 })!;
    const left = recoveryPaths(next, { dkCached: true });
    const leftKey: PkKey = left.code ? (left.passkeys ? 'rmLeftCode' : 'rmLeftCodeOnly') : 'rmLeft', warnKey = pkWarnKey(left);
    if (!(await ask({ title: pkt('rmTitle', { name: slot.name }), ok: pkt('btnRemove'), cancelLabel: pkt('btnKeep'), danger: true, html: `${pkSub('rmLead')}${pkWho(m)}${muted(`${escHtml(pkt(leftKey, { n: left.passkeys }))}${warnKey ? ' ' + escHtml(pkt(warnKey)) : ''}`)}${pkMuted('rmNote')}` }))) throw new Error('Cancelled');
    pkChange.set(m, { pk: next, at: Date.now() }); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, passkeys: next.slots.length, recovery: left };
  },
  // a new recovery code (the old one stops working): shown once, here only
  passkeyNewCode: async (src: { address: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = pkChange.get(m)?.pk || normPk(live?.pk); if (!pk) throw new Error(pkt('notOn'));
    await pkSeed(m, live);
    const dk = dkOf(m, pk.gen); if (!dk || !(await k4Of(m, pk))) throw pkError('PasskeyLocked', pkt('lockedFirst'));
    const rc = await newRecoveryCode();
    const ans = await pkShowCode(rc.text, false, { fresh: true });
    if (ans !== 'saved') throw new Error('Cancelled');
    const next = normPk({ ...pk, ...(await setCode(pk, { main: m, dk, code: rc.bytes })), v: 4 })!;
    pkChange.set(m, { pk: next, at: Date.now() }); meta.changedAt = Date.now();
    await persist(); pushBackupState();
    return { ok: true, code: true, recovery: recoveryPaths(next, { dkCached: true }) };
  },
  // Turn passkey protection off: a FRESH passkey touch (not the cached key), then the whole backup re-sealed as v3 (the seed alone
  // opens it again). Staged like the upgrade; the server asks for the 2FA step-up on the stage when 2FA is on.
  passkeyOff: async (src: { address: string; profile: Profile }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = mainAddr(src?.address); const live = pkLive(m, src?.profile);
    const pk = normPk(live?.pk); if (!pk) return { ok: true, v4: false };
    const seed = await pkSeed(m, live);
    if (!(await ask({ title: pkt('off1Title'), ok: pkt('btnContinue'), cancelLabel: pkt('btnKeepOn'), danger: true, step: { n: 1, of: 2 }, html: `${pkSub('off1Lead')}${pkWho(m)}${pkMuted('off1Risk')}${pkLine('off1Next')}` }))) throw new Error('Cancelled');
    await pkUnlockWith(m, pk, { title: pkt('off2Title'), ok: pkt('btnUse'), step: { n: 2, of: 2 }, html: `${pkSub('off2Lead')}${pkLine('needPasskey')}${pkWho(m)}${pkMuted('off2Note')}` });
    const keys = (await v4KeysOf(m, pk)).keys;
    const inp = publishInputs(m);
    const down = await downgradeProfile({ live, main: m, seed, mv: mvOf(m), ...inp, liveKeys: keys });
    pkPending.set(m, { mode: 'off', gen: pk.gen, at: Date.now() });
    await persist();
    return { ok: true, staged: down.profile, wallets: down.addresses.length, salts: down.salts.length };
  },
  import: async (items: { name?: string; privateKey: string }[]) => {
    await ready;
    // V12 F-23: keys from the page. The old path drew the confirm dialog from only the VALID keys among the first 200
    // items, then imported EVERY item — so 200 unreadable lines plus one attacker key joined with no click shown (an
    // empty dialog list skipped the ask entirely) and counted as the user's. Now the batch is parsed ONCE and is
    // all-or-nothing: more than 200 items, or any entry that is not a readable key, fails before anything is shown or
    // added — a batch with one bad line fails as a whole. Every parsed entry is shown (chain-only keys under their
    // native address), and the import loops over the parsed entries only.
    const list = Array.isArray(items) ? items : [];
    if (list.length > 200) throw new Error('Import up to 200 wallets at once');
    const parsed = list.map(readKeyOrNull);
    const bad = parsed.findIndex((e) => !e);
    if (bad >= 0) throw new Error(`Item ${bad + 1} is not a private key`);
    const entries = parsed as NonNullable<(typeof parsed)[number]>[];
    // V12 F-34: a page-supplied key must NOT silently become a trusted internal transfer destination (its own key, then
    // a sweep to it). It joins with via:'page' and is treated as an outside address for transfers until the user moves
    // funds into it themselves.
    const results: { ok: boolean; name?: string; error?: string }[] = [];
    if (entries.length && !(await ask({ title: entries.length === 1 ? 'Import a wallet' : 'Import wallets', ok: `Import ${plural(entries.length, 'wallet')}`, html: `${sub(`${entries.length === 1 ? 'It joins' : 'They join'} your vault. ${entries.length === 1 ? 'It counts' : 'They count'} as ${entries.length === 1 ? 'an outside address' : 'outside addresses'} for transfers until you move funds in yourself.`)}${addrRows(entries.map((e, i) => ({ name: e.name || `Imported ${i + 1}`, address: e.address })), 200)}${muted('Import only keys you pasted yourself.')}` }))) throw new Error('Cancelled');
    for (const e of entries) { const name = e.name || nextName('Imported'); try { await addAccount(name, e.key as `0x${string}`, { kind: 'imported', via: 'page' }); results.push({ ok: true, name }); } catch (err) { results.push({ ok: false, name, error: shortError(err) }); } }
    return { ok: true, results, ...summary() };
  },
  // the same, but the key is typed into the engine's own dialog: nothing secret comes in from, or goes back to, the caller
  importDialog: () => importKeyDialog(),
  rename: async (id: string, name: string) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); a.name = name.trim() || a.name; await persist(); return { ok: true, ...summary() }; },
  remove: async (id: string, auth?: Auth) => { const list = requireUnlocked(); const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Unknown wallet'); if (list[i].ext) throw new Error('Privy wallets belong to your Privy account — log out to detach them');
    // a wallet that still holds anything (native, or a token this frame has seen) is a funds loss when its key goes: the 'remove' gate applies; an empty one only needs the click
    // F-52 (V12): a funded wallet's remove gate must not be skipped by a failed RPC read. A failed balance read
    // (catch → null) counts as held, as does a wallet whose nonce is > 0 (it has transacted, so it has/had funds) —
    // only a wallet proven empty AND never-used skips the gate.
    // (security audit 2026-11-04, SEC-3 = F-9 not fully fixed) the funded test looked the balance up under the EVM address, so
    // on the Solana / NEAR frames (caches keyed by the Solana / NEAR address, no live read) a wallet holding SOL counted as
    // empty, and on an EVM frame only THIS chain counted. The key also controls the other EVM chain, its Solana / NEAR
    // identities, its USD-balance reserve and its limit-order and perps wallets — no frame can prove all of those empty, so
    // erasing a keyed wallet always passes the 'remove' gate (a no-op for an account without 2FA).
    await gate('remove', auth);
    // the words say what really happens to the account backup (2026-10-28): the server's union keeps a removed wallet's
    // sealed entry, so one the backup holds stays restorable; one it does not hold (no account, an 'rk1' device) is gone
    { const R = REMOVE_DIALOG[uiLang()]; const kept = inBackup(list[i]) && !unboundOf(meta.main || '').some((w) => same(w.address, list[i].address));
      if (!(await ask({ title: R.title(list[i].name), danger: true, funds: true, ok: R.ok, cancelLabel: R.cancel, html: `${sub(escHtml(kept ? R.kept : R.lost))}<div class="dk-list">${addrRow(list[i].name, list[i].address)}</div>${muted(escHtml(kept ? R.keptNote : R.lostNote))}` }))) throw new Error('Cancelled'); } if (list[i].hop && (await publicClient.getBalance({ address: list[i].address }).catch(() => 0n)) > 0n) throw new Error('This hop wallet still holds ETH — sweep it first'); removedIds.add(id); meta.removedAddrs = [...(meta.removedAddrs || []).filter((x) => x !== lc(list[i].address)), lc(list[i].address)].slice(-500); perps.forget(list[i].lt?.a).catch(() => {}); list.splice(i, 1); meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => x !== id); if (meta.activeAccountId === id) meta.activeAccountId = list[0]?.id || null; await persist(); return { ok: true, ...summary() }; },
  setActive: async (id: string) => { requireUnlocked(); meta.activeAccountId = id; await persist(); return { ok: true, ...summary() }; },
  setSelected: async (ids: string[]) => { const list = requireUnlocked(); meta.selectedAccountIds = [...ids.filter((id) => list.some((a) => a.id === id)), ...meta.selectedAccountIds.filter((id) => parked.some((a) => a.id === id))]; await persist(); return { ok: true, ...summary() }; },
  // the key is shown in the engine's own dialog and never returned to the caller
  export: async (id: string, auth?: Auth) => {
    const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    if (a.ext) throw new Error('A Privy wallet exports its key from Privy (Wallets → Export)');
    await gate('export', auth);
    // on the NEAR lane the wallet is its NEAR identity: the ed25519 secret in NEAR wallet format
    const shownAddr = SOL_MODE ? solAddressOf(a) || a.address : NEAR_MODE ? nearAccountId(a) || a.address : a.address;
    await ask({
      title: SOL_MODE ? 'Solana private key' : NEAR_MODE ? 'NEAR secret key' : 'Private key', ok: NEAR_MODE ? 'Show secret key' : 'Show private key', funds: true, guard: true, cancel: false, plain: true, size: 'sm', foot: PK_WARN,
      html: `<div class="pk"><label>${SOL_MODE ? 'Solana address' : NEAR_MODE ? 'NEAR account' : 'Wallet address'}</label>${pkBox(shownAddr.slice(0, 26) + '…' + shownAddr.slice(-4), { copy: shownAddr, title: 'Copy address' })}<label>${SOL_MODE ? 'Private key (base58: imports into Phantom, Solflare, Backpack)' : NEAR_MODE ? 'Secret key (ed25519: imports into any NEAR wallet)' : 'Private key'}</label>${pkBox((SOL_MODE ? '' : NEAR_MODE ? 'ed25519:' : '0x') + '•'.repeat(64), { key: true, title: 'Copy private key' })}</div>`,
      stay: (root, btn) => reveal(root, btn, SOL_MODE ? solSecretKey(a.key) : NEAR_MODE ? nearSecretKey(a.key) : a.key),
    });
    return { ok: true, shown: true };
  },
  exportMany: async (ids: string[], auth?: Auth) => {
    const list = requireUnlocked().filter((x) => ids.includes(x.id) && !x.ext); if (!list.length) throw new Error('No local wallets selected');
    await gate('export', auth);
    const lines = list.map((a) => `${a.name},${nativeChainOf(a.key) ? nativeSecret(a.key) : a.key}`).join('\n');
    await ask({
      title: `Private keys (${list.length})`, ok: 'Show private keys', funds: true, guard: true, cancel: false, plain: true, size: 'sm', foot: PK_WARN,
      html: `<div class="pk"><label>Wallets</label>${list.map((a) => pkBox(`${a.name} · ${a.address}`, { copy: a.address, title: 'Copy address' })).join('')}<label>Private keys <small>name,key, one per line: imports back into any motion vault</small></label>${pkBox(list.map((a) => `${a.name},0x` + '•'.repeat(64)).join('\n'), { key: true, title: 'Copy all keys' })}</div>`,
      stay: (root, btn) => reveal(root, btn, lines),
    });
    return { ok: true, shown: true, count: list.length };
  },
  // route discovery + verification ahead of the click, so the buy has nothing left to check
  prewarm: async (token: string, hint?: unknown) => {
    floatClock.focusAt = Date.now(); floatClock.ticketAt = floatClock.focusAt; floatClock.focusChain = floatLane();   // the click window of a focused token page (I3)
    // a Jupiter-routed coin (quoted in another token) also warms its quote connection and lookup tables (solJupWarm)
    if (SOL_MODE) { try { const r = await solRoute(token, hint); solJupWarm(r); return { ok: true, route: 'sol-' + r.venue }; } catch { return { ok: false }; } }
    if (NEAR_MODE) {
      const list = unlocked || []; const ids = meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
      for (const a of list.filter((x) => ids.includes(x.id)).slice(0, 8)) nearPrewarm(a).catch(() => {});
      try { const r = await nearRoute(token, hint); return { ok: true, route: 'near-dcl:' + r.quoteSymbol }; } catch { return { ok: false }; }
    }
    keepHot(); feeFloor().catch(() => {}); { const list = unlocked || []; const ids = meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : []; for (const a of list.filter((x) => ids.includes(x.id)).slice(0, 8)) nextNonce(a.address).catch(() => {}); } const addr = lc(token); if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false }; const r = await routeFor(addr, hint); await verifyRoute(addr as `0x${string}`, r); return { ok: true, route: r.type }; },
  // TC-S1 / TC-M1: `slippage` is THIS lane's manual figure; `features` tells a page which per-lane switches this vault has
  settingsGet: async () => { const st = loadSettings(); return { ok: true, settings: { ...st, slippage: CFG.key === 'elysium' ? Number(elySlip(st)) / 100 : laneSlip(st), mev: { ...st.mev, [laneKey()]: mevOn(st) }, features: vaultFeatures(), buyCap: buyCap(), slipOk: slipCeiling(loadLimits().slipOk) } }; },   // (trade-core.patch E11: r4 L2, on rel3's per-lane settings)
  settingsSet: async (s: Partial<Settings> & { buyCap?: unknown; slipOk?: unknown }) => {
    // the ceilings live apart from the settings a page writes: lowering the cap is free, raising it is a trusted click
    if (s && typeof s === 'object' && 'buyCap' in s) {
      const want = Math.max(0, Number(s.buyCap) || 0);
      if (want > 0 && want !== buyCap() && (want < buyCap() || await ask({ title: 'Raise the buy cap', danger: true, ok: `Raise to ${want} ${laneUnit()}`, html: sub(`Buys up to ${escHtml(want)} ${laneUnit()} per wallet will go out without asking (now ${escHtml(buyCap())}).`) }))) { const l = loadLimits(); saveLimits({ ...l, cap: { ...(l.cap || {}), [laneKey()]: want } }); }
    }
    // F-37 + F-6 + F-8 (V12): the RPC endpoints, a raised gas boost and a raised
    // Solana tip/priority all decide where money is signed and how much it pays —
    // a page may not change them silently. Each needs a trusted click, exactly
    // like the buy cap; a declined change is dropped so the stored value stands.
    if (s && typeof s === 'object') {
      const stored = loadSettings();
      if ('rpcs' in s) {
        const norm = (r: unknown): Record<string, RpcPick> => {
          const out: Record<string, RpcPick> = {};
          if (r && typeof r === 'object') for (const k of Object.keys(r as Record<string, RpcPick>)) {
            const v = (r as Record<string, RpcPick>)[k] || {};
            const e: RpcPick = { ...(isRpcUrl(v.primary) ? { primary: v.primary } : {}), ...(isRpcUrl(v.secondary) ? { secondary: v.secondary } : {}), ...(Array.isArray(v.send) && v.send.filter(isRpcUrl).length ? { send: [...new Set(v.send.filter(isRpcUrl))].slice(0, 3) } : {}) };
            if (Object.keys(e).length) out[k] = e;
          }
          return out;
        };
        const want = norm(s.rpcs), have = norm(stored.rpcs);
        if (JSON.stringify(want) !== JSON.stringify(have)) {
          const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
          const listed = Object.keys(want).flatMap((k) => [want[k].primary, want[k].secondary, ...(want[k].send || [])].filter(isRpcUrl).map(hostOf));
          const ok = await ask({ title: 'Change network nodes', danger: true, funds: true, ok: 'Use these nodes', html: `${sub('Trades will be read and broadcast through custom nodes instead of the built-in ones. A malicious node can misreport balances and front-run a trade — change them only to nodes you trust.')}${listed.length ? muted('Nodes: ' + escHtml(listed.join(', '))) : muted('All custom nodes will be cleared.')}` });
          if (!ok) delete s.rpcs;
        }
      }
      if ('gasBoost' in s) {
        const want = Math.min(5, Math.max(1, Number(s.gasBoost) || 1)), now = Math.min(5, Math.max(1, Number(stored.gasBoost) || 1));
        if (want > now && !(await ask({ title: 'Raise the gas boost', danger: true, ok: `Boost to ${want}x`, html: `${sub(`Every trade will pay ${escHtml(want)}x the going gas price (now ${escHtml(now)}x).`)}${muted('A higher boost spends more on fees to land faster.')}` }))) delete s.gasBoost;
      }
      if ('solTip' in s) {
        const want = Math.min(0.1, Math.max(0, Number(s.solTip) || 0)), now = Math.min(0.1, Math.max(0, Number(stored.solTip) || 0));
        if (want > now && !(await ask({ title: 'Raise the Solana tip', danger: true, ok: `Tip ${want} SOL`, html: `${sub(`Every Solana trade will tip up to ${escHtml(want)} SOL to land faster (now ${escHtml(now)} SOL).`)}${muted('A higher tip spends more per trade.')}` }))) delete s.solTip;
      }
      if ('solPriority' in s) {
        const want = Math.min(10_000_000, Math.max(0, Math.floor(Number(s.solPriority) || 0))), now = Math.min(10_000_000, Math.max(0, Math.floor(Number(stored.solPriority) || 0)));
        if (want > now && !(await ask({ title: 'Raise the Solana priority fee', danger: true, ok: `Set ${want}`, html: `${sub(`Every Solana trade will add a priority fee of up to ${escHtml(want)} micro-lamports per compute unit (now ${escHtml(now)}).`)}${muted('A higher priority fee spends more per trade.')}` }))) delete s.solPriority;
      }
      // V13 VA-1: a page set 22 % slippage with no click, and every canonical-pool sell could then be sandwiched by
      // ~22 %. Up to SLIP_SILENT (15 %) or a level already confirmed here it is free; above it a trusted click, which
      // is remembered as the new confirmed level (tradeLimits then does not ask again).
      if ('slippage' in s) {
        const want = Math.min(100, Math.max(0.1, Number(s.slippage) || 12));
        if (slipNeedsClick(want, loadLimits().slipOk)) {
          if (await ask({ title: 'Raise the slippage', danger: true, ok: `Allow ${want}%`, html: `${sub(`Trades may fill up to ${escHtml(want)}% worse than quoted (now ${escHtml(Number(stored.slippage) || 12)}%).`)}${muted(`Above ${SLIP_SILENT}% a trade can be sandwiched for that much. Settings at this level or lower won't ask again.`)}` })) saveLimits({ ...loadLimits(), slipOk: want });
          else delete s.slippage;
        }
      }
    }
    if (CFG.key === 'elysium' && s && typeof s === 'object' && 'slippage' in s) { try { localStorage.setItem(ELY.ELY_SLIP_KEY, String(Math.min(100, Math.max(0.1, Number(s.slippage) || 5)))); } catch {} delete s.slippage; }   // (trade-core.patch E10: N5, r4 L2)
    // TC-S1 / TC-S2 / TC-M1: per-lane switches, written for THIS frame's lane only and merged into what the other lanes keep.
    // Turning MEV protection OFF sends this lane's trades to public nodes again: a trusted click, like raising the slippage.
    if (s && typeof s === 'object') {
      const lane = laneKey(), stored = loadSettings();
      if ('slippage' in s) s.slipLane = { ...stored.slipLane, [lane]: Math.min(100, Math.max(0.1, Number(s.slippage) || laneSlip(stored))) };
      else if ('slipLane' in s) delete s.slipLane;   // only through `slippage`, which passed its ceiling check above
      if ('slipAuto' in s) { const v = (s.slipAuto as Record<string, unknown> | undefined)?.[lane]; if (typeof v === 'boolean') s.slipAuto = { ...stored.slipAuto, [lane]: v }; else delete s.slipAuto; }
      if ('mev' in s) {
        const v = (s.mev as Record<string, unknown> | undefined)?.[lane];
        if (typeof v !== 'boolean') delete s.mev;
        else if (!v && mevOn(stored) && !(await ask({ title: 'Turn off MEV protection', danger: true, ok: 'Turn off', html: `${sub('Trades on this network will go to public nodes at once: visible to bots before they land, so a front-runner can take up to your slippage.')}${muted('With protection on, a trade goes to private builders first and to public nodes only if it has not landed within about a second. You can turn it back on at any time.')}` }))) delete s.mev;
        else s.mev = { ...stored.mev, [lane]: v };
      }
    }
    if (s && typeof s === 'object') { delete s.buyCap; delete s.slipOk; delete (s as { features?: unknown }).features; }
    const settings = saveSettings(s); const shown = { ...settings, slippage: CFG.key === 'elysium' ? Number(elySlip(settings)) / 100 : laneSlip(settings),   /* (trade-core.patch E11) */ mev: { ...settings.mev, [laneKey()]: mevOn(settings) }, features: vaultFeatures() }; if (NEAR_MODE) { const n = applyNearRpcs(); return { ok: true, settings: shown, rpcs: n.rpcs, send: n.send }; } if (SOL_MODE) { const n = applySolRpcs(); return { ok: true, settings: shown, rpcs: n.rpcs, send: n.send }; } const rebuilt = rebuildClients(); if (rebuilt) verifyCache.clear(); return { ok: true, settings: shown, rpcs: rpcUrls, send: broadcastUrls() }; },
  // which endpoints this frame signs and broadcasts through, right now
  rpcInfo: async () => { if (NEAR_MODE) { const n = applyNearRpcs(); return { ok: true, chain: 'near', urls: n.rpcs, send: n.send, defaults: NEAR_DEFAULT_RPCS }; } if (SOL_MODE) { const n = applySolRpcs(); return { ok: true, chain: 'sol', urls: n.rpcs, send: n.send, defaults: n.rpcs.slice(-2) }; } return { ok: true, chain: CFG.key, urls: rpcUrls, send: broadcastUrls(), ...(mevPrivate() ? { fallback: publicSendUrls(), fallbackMs: MEV_FALLBACK_MS } : {}), defaults: DEFAULT_RPCS }; },
  busy: () => tradesInFlight > 0,
  // backup file out, backup file in, and where the vault stands (for the "back up now" notice)
  backup: async (auth?: Auth) => { requireUnlocked(); await gate('backup', auth); return backupDialog(); },
  restore: () => restoreDialog(),
  // the recovery screen (key missing, or wallets of a set-aside vault not back yet): drawn here, every choice a trusted click
  recover: () => recoverDialog(),
  // the 2FA gate as enforced here: which actions need a code, whether a code is live, what the surface is (read-only)
  policy: async () => policy(),
  // the page's hand-over: its Privy access token (the server's gates are read with it) and its own view of the gates, which never overrides the server's
  twofaPolicy: (src: { accessToken?: unknown; enabled?: unknown; gates?: unknown } | null | undefined) => twofaPolicy(src),
  backupState: async () => { await ready; return backupStateNow(); },
  // the old in-page vault (same browser, the page's origin) hands its wallets over once; accepted only from the parent page
  adopt: async (src: { accounts: Account[]; meta?: VaultMeta; settings?: Partial<Settings>; seeds?: Record<string, string> }) => {
    await ready; if (!HOST) throw new Error('adopt runs in the vault frame only');
    // V13 VA-4: the old in-page vault hands its keys over through the page — exactly the rule import() follows (F-23 /
    // F-34). The dialog used to list only the 0x keys (and was skipped when there were none), every storable key joined
    // (sol: / near: with no click at all), the page's hop flag, names and active / selected ids were kept, and nothing was
    // tagged: one "Move wallets" click made an attacker's key an OWN wallet, and consolidate() then swept every wallet
    // into it with no further dialog. Now: parsed once, all-or-nothing, every key shown under the address it trades
    // as, joined as `via: 'page'` (an outside address for transfers until the user moves funds in), and nothing else the
    // page sent (hop, meta, settings, seeds, main / index) is taken.
    const list = Array.isArray(src?.accounts) ? src.accounts : [];
    if (list.length > 200) throw new Error('Move up to 200 wallets at once');
    const parsed = list.map((a) => readKeyOrNull({ name: String((a as { name?: unknown })?.name ?? '').slice(0, 40), privateKey: String((a as { key?: unknown })?.key ?? '') }));
    const bad = parsed.findIndex((e) => !e);
    if (bad >= 0) throw new Error(`Wallet ${bad + 1} of the old vault is not a readable key`);
    const seen = new Set<string>();
    const entries = (parsed as NonNullable<(typeof parsed)[number]>[]).filter((e) => {
      const at = lc(keyAddress(e.key)); if (seen.has(at) || allAccounts().some((x) => lc(x.address) === at)) return false; seen.add(at); return true;
    });
    if (entries.length && !(await ask({ title: 'Move wallets into the isolated vault', ok: `Move ${plural(entries.length, 'wallet')}`, cancelLabel: 'Not now', html: `${sub(`${plural(entries.length, 'wallet')} from this site's old in-page vault. ${entries.length === 1 ? 'It counts' : 'They count'} as ${entries.length === 1 ? 'an outside address' : 'outside addresses'} for transfers until you move funds in yourself.`)}${addrRows(entries.map((e, i) => ({ name: e.name || `Wallet ${i + 1}`, address: e.address })), 200)}${muted('Move them only if you recognize every one.')}` }))) throw new Error('Cancelled');
    let added = 0;
    for (const e of entries) { try { await addAccount(e.name || nextName('Imported'), e.key as `0x${string}`, { kind: 'imported', via: 'page' }); added += 1; } catch { /* already here (a racing tab): the summary shows it */ } }
    return { ok: true, added, ...summary() };
  },
  // The page's Privy wallets, attached for this session: they trade next to the
  // local ones (same picker, same batch), sign on the page, and vanish from the
  // list on logout. Nothing about them is written into the vault.
  linkExternal: async (src: { provider: 'privy'; accounts: { address: string; name?: string }[] }) => {
    await ready; if (!HOST) throw new Error('external wallets attach in the vault frame only');
    const list = requireUnlocked();
    const want = (src?.accounts || []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a?.address || '')));
    const ids = new Set(want.map((a) => 'privy:' + lc(a.address)));
    let changed = false;
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].ext === 'privy' && !ids.has(list[i].id)) { list.splice(i, 1); changed = true; }
    const fresh = !list.some((a) => !a.hop);
    want.forEach((a, i) => {
      const id = 'privy:' + lc(a.address);
      const name = String(a.name || '').trim() || (i === 0 ? 'Main' : `Privy ${i + 1}`);
      const have = list.find((x) => x.id === id);
      if (have) { if (have.name !== name) { have.name = name; changed = true; } return; }
      if (list.some((x) => same(x.address, a.address))) return;     // the same key was imported locally: one row, the local one
      list.push({ id, name, address: a.address as `0x${string}`, key: '0x' as `0x${string}`, createdAt: Date.now(), ext: 'privy' });
      if (!meta.order.includes(id)) meta.order.push(id);
      // a first wallet is put to work at once, as a created one would be
      if (fresh && !meta.activeAccountId) meta.activeAccountId = id;
      if (fresh && !meta.selectedAccountIds.length) meta.selectedAccountIds.push(id);
      changed = true;
    });
    if (meta.activeAccountId && !list.some((x) => x.id === meta.activeAccountId) && !parked.some((x) => x.id === meta.activeAccountId)) meta.activeAccountId = list.find((a) => !a.hop)?.id || null;
    meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => list.some((a) => a.id === x) || parked.some((a) => a.id === x));
    if (changed) { await persist(); scheduleWatch(50); }
    return { ok: true, ...summary() };
  },
  // perps phase 2: perps.<method>({ … }) — one object each, shapes checked in src/lighter/perpsCore.ts (args)
  perps: { status: perps.status, quote: perps.quote, open: perps.open, close: perps.close, cancel: perps.cancel, cancelAll: perps.cancelAll, deposit: perps.deposit, withdrawQuote: perps.withdrawQuote, withdraw: perps.withdraw, claim: perps.claim, history: perps.history, setup: perps.setup, leverage: perps.leverage, margin: perps.margin, trigger: perps.trigger },
  // limit orders v1: limit.<method>({ … }) — one object each, shapes checked in src/limitCore.ts (limitArgs)
  limit: limitApi,
  // one USD balance: float.<method>({ … }) — one object each, shapes checked in src/floatCore.ts (floatArgs)
  float: { status: float.status, configure: float.configure, ensure: (o: unknown) => floatEnsure(o), sweep: float.sweep, off: float.off, jobs: float.jobs, earn: float.earn, buy: (o: unknown) => clickRun(() => usdBuy(o)), convert: float.convert, withdraw: float.withdraw },
  terminalTrade: (request: unknown) => clickRun(() => terminalTrade(request)),
  terminalTradeEvm: (request: unknown) => clickRun(() => terminalTradeEvm(request)),
  buy: (token: string, amount: number, accountIds?: string[], hint?: unknown, opts?: unknown) => clickRun(() => trade('buy', token, amount, accountIds, hint, opts)),
  sell: (token: string, percent: number, accountIds?: string[], hint?: unknown, opts?: unknown) => clickRun(() => trade('sell', token, percent, accountIds, hint, opts)),
  // dry run of the exact transaction, and the on-chain fate of one that was sent
  preview: (side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown) => preview(side, token, size, accountIds, hint),
  receipt: (hash: string) => receipt(hash),
  // live balances: cached snapshot, force a poll, or watch a token for every wallet
  balancesNow: () => ({ eth: { ...ethCache }, tokens: Object.fromEntries(Object.entries(tokenCache).map(([t, m]) => [t, { ...m }])) }),
  poll: () => pollBalances(true),
  watchToken: (token: string) => { watchedTokens.set(token.toLowerCase(), Date.now()); scheduleWatch(50); },
  tokenInfo: async (token: string) => { if (SOL_MODE) { const m = await solTokenMeta(token); return { ok: true, address: token, symbol: m.symbol, decimals: m.decimals }; } if (NEAR_MODE) { const m = await nearTokenMeta(token.toLowerCase()); return { ok: true, address: token.toLowerCase(), symbol: m.symbol, decimals: m.decimals }; } const t = token as `0x${string}`; const [symbol, decimals] = await Promise.all([publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'), tokenDecimals(t).catch(() => 18)]); return { ok: true, address: token.toLowerCase(), symbol, decimals }; },
  // moving funds: plan (no side effects) → start (hop wallets + persisted job) → jobs / cancel / sweepHops
  move: {
    plan: (spec: MoveSpec) => planMove(spec),
    start: async (plan: Plan, auth?: Auth) => { const own = planOf(plan); await confirmOutside(own, auth); plans.delete(String((plan as { planId?: unknown })?.planId || '')); const r = await startMove(own); confirmedJobs.add(r.id); return r; },
    jobs: () => jobs.map((j) => ({ ...j, legs: j.legs.map((l) => ({ ...l })) })),
    cancel: (id: string) => cancelJob(id),
    // F-32 (V12): a retry that would re-queue any leg leaving the vault re-runs the outside confirmation (gate + the
    // real-address dialog) FIRST — a cancelled/stalled move can never quietly resume an outside transfer. A cancelled
    // job is refused by retryJob; legs cancelled by hand (error 'cancelled') are never re-queued.
    retry: async (id: string, auth?: Auth) => {
      const job = jobs.find((j) => j.id === id); if (!job) throw new Error('Unknown job');
      if (job.status === 'cancelled') throw new Error('This move was cancelled — plan it again to send');
      const requeue = job.legs.filter((l) => l.error !== 'cancelled' && ((l.status === 'failed' && !l.raw) || (l.status === 'failed' && l.error === 'dropped before mining') || l.status === 'skipped'));
      const outside = requeue.filter((l) => /^0x[0-9a-fA-F]{40}$/.test(String(l.to)) && !l.hop && !isOwn(l.to));
      if (outside.length) await confirmOutside({ legs: requeue, asset: job.asset, hops: job.hops } as unknown as Plan, auth);
      confirmedJobs.add(id);
      return retryJob(id);
    },
    isRunner: () => isRunner,
    runner: async () => (isRunner ? 'this tab' : (await askRunner({ cmd: 'ping' }).then(() => 'another tab').catch(() => 'nobody'))),
    takeOver: () => ensureRunner(),
    sweepHops: (toId: string, auth?: Auth) => sweepHops(toId, auth),
    clear: () => { for (let i = jobs.length - 1; i >= 0; i -= 1) if (jobs[i].status !== 'running') jobs.splice(i, 1); saveJobs(); return { ok: true }; },
  },
  // ── cross-chain (Relay): every vault key is the same address on every EVM chain ──
  bridgeChains: async () => ({ ok: true, chains: [...Object.values(BRIDGE_CHAINS).map((c) => ({ id: c.id, key: c.key, name: c.name, symbol: c.symbol, explorer: c.explorer, decimals: 18 })), { id: RELAY_SOL_CHAIN, key: 'solana', name: 'Solana', symbol: 'SOL', explorer: 'https://solscan.io', decimals: 9 }] }),
  // Solana balances are keyed by the base58 address as given (case-sensitive)
  bridgeBalances: async (chainId: number, addresses: string[]) => (Number(chainId) === RELAY_SOL_CHAIN ? solBalancesFor(addresses) : bridgeBalances(Number(chainId), addresses)),
  bridgeDeposit: async (id: string, quote: BridgeQuoteLite, auth?: Auth) => {
    const list = requireUnlocked(); const a = list.find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    // No user-activation test here (2026-10-18): in the vault frame the page's click never reaches this document — a
    // cross-origin frame gets no activation from its parent — so "A bridge needs a real click" refused every bridge of a
    // user who had not clicked inside the frame before. The click that counts is the one on this engine's own dialog,
    // below, for every bridge (own wallet or not): a page script alone still cannot start one.
    // the quote names where the funds land on the other chain: one of this vault's wallets (same key on every EVM chain, or its Solana identity) is a transfer; anywhere else is a withdrawal — gate, then a trusted click on the real address
    // a Solana deposit that came through motion (Relay wanted a key) goes out on the swap's simulated path: the frozen
    // solBridgeDeposit re-asks Relay keyless, which is exactly what Relay refused (2026-10-29)
    const solMotion = (bound: BridgeQuoteLite) => solSwapSend(a as never, { ...bound, originCurrency: NATIVE_SOL, destinationCurrency: '', user: solAddressOf(a as never), sol: bound.sol } as unknown as SwapBound);
    const signBound = async (bound: BridgeQuoteLite) => ({ ok: true, hash: Number(bound.originChainId) === RELAY_SOL_CHAIN ? (bound.source === 'motion' ? await solMotion(bound) : await solBridgeDeposit(a, bound as never)) : await bridgeDeposit(a, bound), requestId: bound.requestId });
    // phase 2: sign exactly what phase 1 gated and quoted — the ticket is single-use, this wallet's, 90 s
    if (quote?.ticket) {
      const k = String(quote.ticket); const t = bridgeTickets.get(k); bridgeTickets.delete(k);
      for (const [x, v] of bridgeTickets) if (Date.now() - v.at > 90_000) bridgeTickets.delete(x);
      if (!t || t.id !== id || Date.now() - t.at > 90_000) throw new Error('This bridge quote expired — press Bridge again');
      return signBound(t.bound);
    }
    const rcpt = String(quote?.recipient || '');
    const dest = BRIDGE_CHAINS[Number(quote?.destinationChainId)]?.name || (Number(quote?.destinationChainId) === RELAY_SOL_CHAIN ? 'Solana' : `chain ${quote?.destinationChainId}`);
    const ownTo = ownAccounts().find((x) => same(x.address, rcpt) || solAddressOf(x) === rcpt);
    // F-12 (V12): the vault quotes the route against Relay ITSELF — through the terminal's own server, for the
    // recipient named in `quote.recipient` — BEFORE the confirmation dialog, so the dialog can show how much leaves
    // (bound.amount) and about how much arrives (bound.outFormatted). A signature-moving step is never confirmed
    // blind. Where Relay pays out is fixed by the request id in THIS bound deposit, not by the page's `quote`.
    const bound = await ownBridgeQuote(a, quote);
    const minOut = /^\d{1,60}$/.test(String(quote?.minOut || '')) ? BigInt(String(quote.minOut)) : 0n;
    const moved = minOut > 0n && !(bound.out && BigInt(bound.out) >= minOut);
    // the route already pays under the floor the page showed: bail before asking the user to confirm a stale amount
    if (moved && quote?.phase === 'bind') return { ok: false, moved: true, out: bound.out, outFormatted: bound.outFormatted };
    if (moved) throw new Error(`The quote moved: ${bound.outFormatted || 'less'} would arrive — press Bridge again`);
    const origin = Number(quote?.originChainId), solOrigin = origin === RELAY_SOL_CHAIN;
    const fromName = BRIDGE_CHAINS[origin]?.name || (solOrigin ? 'Solana' : `chain ${origin}`);
    const sym = BRIDGE_CHAINS[origin]?.symbol || (solOrigin ? 'SOL' : '');
    const amt = /^\d{1,40}$/.test(String(bound.amount || '')) ? formatUnits(BigInt(String(bound.amount)), solOrigin ? 9 : 18) : '?';
    const arriving = bound.outFormatted ? ` and about ${escHtml(bound.outFormatted)} arriving on ${escHtml(dest)}` : '';
    if (!ownTo) {
      await gate('withdraw', auth);
      // the login wallet is the user's own, but its key is not in this vault: say so instead of "not one of your wallets" — only
      // when the vault verified it (SEC-6: a page-attached entry proves nothing), and it stays a danger dialog either way
      const login = verifiedLogin(rcpt);
      const ok = await ask({ title: login ? 'Bridge to your login wallet' : 'Bridge outside your vault', danger: true, funds: true, ok: 'Bridge', html: `${sub(`${escHtml(amt)} ${escHtml(sym)} from ${escHtml(a.name)} on ${escHtml(fromName)} to ${escHtml(dest)}${arriving}, landing at this address.${login ? ` It is your login wallet ${escHtml(login.name)}: yours, but its key is held by the login provider, so this counts as a withdrawal.` : ' It isn\'t one of your wallets.'}`)}${destBox(rcpt)}${muted('Check every character. A bridge can\'t be undone.')}` });
      if (!ok) throw new Error('Cancelled');
    } else {
      // between the vault's own wallets: the 'transfer' gate, then a trusted click on the engine's dialog (the page's click cannot count here)
      await gate('transfer', auth);
      const ok = await ask({ title: 'Bridge between your wallets', ok: 'Bridge', html: `${sub(`${escHtml(amt)} ${escHtml(sym)} from ${escHtml(a.name)} on ${escHtml(fromName)} to ${escHtml(ownTo.name)} on ${escHtml(dest)}${arriving}.`)}<div class="dk-list">${addrRow(ownTo.name, rcpt)}</div>${muted('A bridge can\'t be undone.')}` });
      if (!ok) throw new Error('Cancelled');
    }
    if (quote?.phase === 'bind') {
      const ticket = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      bridgeTickets.set(ticket, { id, bound, at: Date.now() });
      return { ok: true, ticket, requestId: bound.requestId, out: bound.out, outFormatted: bound.outFormatted };
    }
    return signBound(bound);
  },
  // ── cross-chain swap (2026-10-29, src/relaySwap.ts): the bridge's route with a coin on either side. The same two phases,
  // gates and dialogs as bridgeDeposit; what is signed is only Relay's own steps for the request the vault bound itself
  // (EVM: an exact approve to Relay's depository, then the deposit; Solana: one simulated transaction) ──
  relaySwap: async (id: string, q: Partial<SwapBound> & { minOut?: string; phase?: 'bind'; ticket?: string }, auth?: Auth) => {
    const list = requireUnlocked(); const a = list.find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    if (q?.ticket) {
      const k = String(q.ticket); const t = swapTickets.get(k); swapTickets.delete(k);
      for (const [x, v] of swapTickets) if (Date.now() - v.at > 90_000) swapTickets.delete(x);
      if (!t || t.id !== id || Date.now() - t.at > 90_000) throw new Error('This swap quote expired — press Swap again');
      const b = t.bound;
      const hash = Number(b.originChainId) === RELAY_SOL_CHAIN ? await solSwapSend(a as never, b) : (await evmSwapSend(a, b)).hash;
      return { ok: true, hash, requestId: b.requestId };
    }
    const bad = swapRequestProblem(q, (c) => !!BRIDGE_CHAINS[c] || c === RELAY_SOL_CHAIN);
    if (bad) throw new Error(bad);
    const origin = Number(q.originChainId), solOrigin = origin === RELAY_SOL_CHAIN;
    const user = solOrigin ? solAddressOf(a as never) : (/^0x[0-9a-fA-F]{40}$/.test(a.address) && !nativeChainOf(a.key) ? a.address : '');
    if (!user || !a.key || a.ext) throw new Error('This wallet cannot sign on this network');
    const rcpt = String(q.recipient);
    // fee-sprint bypass (default off): if the origin lane's fee leg is on, Relay's quote must carry its app fee at the base rate
    // (src/relaySwap.ts relayAppFeeProblem; the app fee already asks for BRIDGE_APP_FEE). Off = undefined = no extra check.
    const relayFeeChain: FeeChain | null = origin === LIMIT_CHAIN_ID ? 'robinhood' : origin === BSC_CHAIN_ID ? 'bsc' : solOrigin ? 'sol' : null;
    const relayLeg = relayFeeChain ? feeLegFor(relayFeeChain) : null;
    const bound = await bindSwap(user, { originChainId: origin, destinationChainId: Number(q.destinationChainId), originCurrency: String(q.originCurrency), destinationCurrency: String(q.destinationCurrency), amount: String(q.amount), recipient: rcpt }, fetch, relayLeg ? { minAppFeeBps: relayLeg.baseBps } : {});
    const minOut = /^\d{1,60}$/.test(String(q.minOut || '')) ? BigInt(String(q.minOut)) : 0n;
    if (minOut > 0n && BigInt(bound.out) < minOut) {
      if (q.phase === 'bind') return { ok: false, moved: true, out: bound.out, outFormatted: bound.outFormatted };
      throw new Error(`The quote moved: ${bound.outFormatted} ${bound.outSymbol} would arrive — press Swap again`);
    }
    const net = (c: number) => BRIDGE_CHAINS[c]?.name || (c === RELAY_SOL_CHAIN ? 'Solana' : `chain ${c}`);
    const what = `${escHtml(bound.inFormatted)} ${escHtml(bound.inSymbol)} from ${escHtml(a.name)} on ${escHtml(net(origin))} for about ${escHtml(bound.outFormatted)} ${escHtml(bound.outSymbol)} on ${escHtml(net(bound.destinationChainId))}`;
    const steps = `You sign ${escHtml(bound.steps.join(' then '))} on ${escHtml(net(origin))}, nothing else.`;
    const ownTo = ownAccounts().find((x) => same(x.address, rcpt) || solAddressOf(x) === rcpt);
    if (!ownTo) {
      await gate('withdraw', auth);
      const login = verifiedLogin(rcpt);   // SEC-6: as in bridgeDeposit
      const ok = await ask({ title: login ? 'Swap to your login wallet' : 'Swap outside your vault', danger: true, funds: true, ok: 'Swap', html: `${sub(`${what}, landing at this address.${login ? ` It is your login wallet ${escHtml(login.name)}: yours, but its key is held by the login provider, so this counts as a withdrawal.` : ' It isn\'t one of your wallets.'}`)}${destBox(rcpt)}${muted(`${steps} Check every character. A swap can't be undone.`)}` });
      if (!ok) throw new Error('Cancelled');
    } else {
      await gate('transfer', auth);
      const ok = await ask({ title: 'Swap between your wallets', ok: 'Swap', html: `${sub(`${what}, to ${escHtml(ownTo.name)}.`)}<div class="dk-list">${addrRow(ownTo.name, rcpt)}</div>${muted(`${steps} A swap can't be undone.`)}` });
      if (!ok) throw new Error('Cancelled');
    }
    if (q.phase === 'bind') {
      const ticket = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      swapTickets.set(ticket, { id, bound, at: Date.now() });
      return { ok: true, ticket, requestId: bound.requestId, out: bound.out, outFormatted: bound.outFormatted, steps: bound.steps, source: bound.source };
    }
    const hash = solOrigin ? await solSwapSend(a as never, bound) : (await evmSwapSend(a, bound)).hash;
    return { ok: true, hash, requestId: bound.requestId };
  },
  // a coin's balance on any offered chain (the swap's pay side), keyed like bridgeBalances; a failed read is left out
  relayTokenBalances: async (chainId: number, token: string, addresses: string[]) => relayTokenBalances(Number(chainId), String(token), Array.isArray(addresses) ? addresses.map(String).slice(0, 40) : []),
  bridgeSend: async (id: string, chainId: number, to: string, amount: number | 'max', auth?: Auth) => {
    const list = requireUnlocked(); const a = list.find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    const c = BRIDGE_CHAINS[Number(chainId)]; if (!c) throw new Error('Unknown chain');
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('Invalid address');
    if (!isOwn(to)) {
      await gate('withdraw', auth);
      const ok = await ask({ title: 'Send outside your vault', danger: true, funds: true, ok: 'Send', html: `${sub(`${amount === 'max' ? 'The whole balance' : escHtml(amount) + ' ' + c.symbol} on ${c.name} from ${escHtml(a.name)} to this address. It isn't one of your wallets.`)}${destBox(to)}${muted('Check every character. This can\'t be undone.')}` });
      if (!ok) throw new Error('Cancelled');
    } else await gate('transfer', auth);
    return { ok: true, hash: await bridgeSend(a, Number(chainId), to, amount) };
  },
  // (2026-11-03) Add HYPE / USDC on Elysium from this wallet, through motion's bridge (the block above elysiumSignFromW).
  // { walletId, pay: 'native' | 'stable', amount (in the paid coin), asset: 'HYPE' | 'USDC', phase?: 'quote' } — 'quote' only
  // prices it (nothing signed, no dialog); otherwise the vault's own dialog shows what leaves, what arrives where, and the 6-day
  // way back, and only a click there signs. Returns { state, srcHash, dstHash, quoteId, out } or throws (SolverRefused = nothing
  // of yours moved; name 'TransferUnknown' + unknown = the transfer may be out: follow elysiumFundStatus, never resend).
  elysiumFund: async (o: { walletId: string; pay: 'native' | 'stable'; amount: number; asset: 'HYPE' | 'USDC'; phase?: 'quote' }, auth?: Auth) => {
    if ((o as { from?: unknown } | null)?.from === 'hyperevm') return elysiumFundFromHyperEvm(o, auth);   // (release 6) from HyperEVM, any EVM frame
    if (NEAR_MODE || !(SOL_MODE || CFG.key === 'robinhood' || CFG.key === 'bsc')) throw new Error('Elysium funding starts from a Robinhood, BNB or Solana wallet');
    const list = requireUnlocked(); const a = list.find((x) => x.id === o?.walletId); if (!a || a.ext || a.hop) throw new Error('Unknown wallet');
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.key) || nativeChainOf(a.key)) throw new Error('This wallet cannot sign on EVM chains');
    const pay = o.pay === 'native' ? 'native' : o.pay === 'stable' ? 'stable' : null;
    const asset = o.asset === 'USDC' ? 'stable' : o.asset === 'HYPE' ? 'native' : null;
    if (!pay || !asset || !(typeof o.amount === 'number' && o.amount > 0 && Number.isFinite(o.amount))) throw new Error('Invalid amount');
    const src = (SOL_MODE ? 'sol' : CFG.key) as 'robinhood' | 'bsc' | 'sol', sc = mbCfg(src), W = a.address as `0x${string}`;
    // the payer: W on this chain (its Solana address on a Solana frame); the recipient: W's EVM address = its Elysium address
    const payer = SOL_MODE ? solAddressOf(a) : W;
    if (!/^0x[0-9a-fA-F]{40}$/.test(W) || (SOL_MODE && !payer)) throw new Error('This wallet has no EVM address for Elysium');
    const amountIn = pay === 'native' ? (SOL_MODE ? parseUnits(String(o.amount), 9) : parseEther(String(o.amount))) : (SOL_MODE ? parseUnits(String(o.amount), sc.stable.decimals) : toUnits(o.amount, sc.stable.decimals));
    const bridge = createSolverBridge({
      base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, i), now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY,
      signEvmTransfer: async () => { throw new Error('signed in the wallet lane'); }, signSolTransfer: async () => { throw new Error('no Solana source'); },
    });
    const h = await bridge.health();
    if (!h.on || !h.chains.includes(src) || !h.chains.includes('elysium') || !h.deposits[src]) throw new SolverRefused('motion\'s bridge does not serve Elysium right now');
    if (asset === 'stable' && !(h.elysium?.assets || []).includes('stable')) throw new SolverRefused('USDC on Elysium is not offered yet — HYPE is');
    if (h.elysium?.paused) throw new SolverRefused('Elysium funding is paused: ' + String((h.elysium.why || [])[0] || 'the official bridge changed').slice(0, 120) + ' — moving funds back stays open');
    const [bal, stableBal, srcOracle6, oracle6] = await Promise.all([
      SOL_MODE ? solFloatRpc<any>('getBalance', [payer, { commitment: 'confirmed' }]).then((r) => BigInt(r?.value ?? 0)) : publicClient.getBalance({ address: W }),
      pay !== 'stable' ? Promise.resolve(0n) : SOL_MODE
        ? solFloatRpc<any>('getTokenAccountBalance', [solFloatAta(payer, sc.stable.address), { commitment: 'confirmed' }]).then((r) => BigInt(r?.value?.amount ?? 0), () => 0n)
        : publicClient.readContract({ address: sc.stable.address as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [W] }) as Promise<bigint>,
      pay !== 'native' ? Promise.resolve(0n) : SOL_MODE ? solFloatPrice6(sc.oracle.pool, sc.stable.address) : elysiumPrice6(publicClient as never, src as 'robinhood' | 'bsc'),
      asset === 'native' ? elysiumPrice6(elysiumOraclePc(), 'elysium') : Promise.resolve(1_000_000n),
    ]);
    // (review L-F7) the Inbox aliases a refund address that is a contract (or a delegated EOA) on HyperEVM: plain wallets only
    const code = await elysiumOraclePc().getCode({ address: W }).catch(() => null);
    if (code === null) throw new SolverRefused('HyperEVM could not be read — try again in a moment');
    if (code && code !== '0x') throw new SolverRefused('This wallet has code on HyperEVM (a contract or a delegation) — Elysium funding pays plain wallets only');
    if (pay === 'native' ? bal < amountIn : stableBal < amountIn) throw new SolverRefused('More than this wallet holds');
    if (SOL_MODE && bal < (pay === 'native' ? amountIn : 0n) + 1_000_000n) throw new SolverRefused('Leave about 0.001 SOL in this wallet for fees');
    const got = await bridge.quote({ from: src, to: 'elysium', amountIn, depositor: payer, recipient: W, oracle6, maxSlipBps: 150, deposits: h.deposits, pay, asset, srcOracle6 });
    const outText = asset === 'stable' ? `${formatUnits(got.out, 6)} USDC` : `${formatEther(got.out)} HYPE`;
    const inText = pay === 'native' ? `${formatUnits(amountIn, sc.nativeDecimals)} ${sc.native}` : `${formatUnits(amountIn, sc.stable.decimals)} ${sc.stable.symbol}`;
    if (o.phase === 'quote') return { ok: true, phase: 'quote', out: got.out.toString(), outText, inText, usd6: got.usd6.toString(), etaMs: got.etaMs, back: ELYSIUM_BACK, docs: ELYSIUM_DOCS };
    await gate('transfer', auth);
    const ok = await ask({ title: 'Add funds on Elysium', ok: `Pay ${inText}`, html: `${sub(`${escHtml(inText)} from ${escHtml(a.name)} on ${escHtml(SOL_MODE ? 'Solana' : CFG.name)} to motion's bridge. ${escHtml(outText)} arrives at the same address on Elysium, usually within seconds; if it cannot be paid, your ${escHtml(pay === 'native' ? sc.native : sc.stable.symbol)} comes back.`)}${destBox(W)}${muted(escHtml(ELYSIUM_BACK))}${muted(escHtml(ELYSIUM_RISK))}` });
    if (!ok) throw new Error('Cancelled');
    const held: { nonce?: number } = {};
    const fill = createSolverBridge({
      base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, i), now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY,
      signEvmTransfer: (x) => elysiumSignFromW({ walletId: a.id, token: x.token, to: x.to, amount: x.amount }, held),
      signSolTransfer: (x) => elysiumSignSolFromW({ walletId: a.id, mint: x.mint, to: x.to, amount: x.amount, decimals: x.decimals, memo: x.memo }),
    });
    return laneLock(SOL_MODE ? payer : W, async () => {
      try {
        const r = await fill.fill(got.quote, got.sig, a.id, { early: true });
        if (held.nonce !== undefined && !SOL_MODE) noteNonceUsed(W, held.nonce);
        return { ok: r.ok, state: r.state, srcHash: r.srcHash, dstHash: r.dstHash || null, quoteId: got.quote.id, out: got.out.toString(), outText, back: ELYSIUM_BACK, docs: ELYSIUM_DOCS };
      } catch (e) {
        if (e instanceof SolverRefused) throw e;                                     // sent:false — nothing of yours moved
        if (!SOL_MODE) nonces.delete(W.toLowerCase());                              // the bytes may be out: re-read the count
        if (e instanceof SolverUnknown) throw Object.assign(new Error('Status unknown — your transfer to motion\'s bridge may be out; follow it, do not pay again'), { name: 'TransferUnknown', unknown: true, quoteId: got.quote.id, srcHash: e.srcHash });
        throw e;
      }
    });
  },
  // (2026-11-04) the way back: Elysium → the SAME address on HyperEVM. { walletId, asset: 'HYPE' | 'USDC', amount } — the vault asks
  // motion's server for the nonce / price / balances (a read; a wrong answer can only make the transaction fail), builds the ONE
  // call (elysiumExitCore exitCall: withdrawEth(W) / router.outboundTransfer(USDC, W, …)), checks it (exitProblem: it pays the
  // signer only), asks in its own dialog (about 6 days, then motion claims it on HyperEVM for you — or anyone can), and signs it
  // for chain 99901. The server only broadcasts bytes that pass the same check. Returns { hash } or throws.
  elysiumExit: async (o: { walletId: string; asset: 'HYPE' | 'USDC'; amount: number | 'max' }, auth?: Auth) => {
    if (NEAR_MODE) throw new Error('Open an EVM or Solana wallet to move funds back from Elysium');
    const list = requireUnlocked(); const a = list.find((x) => x.id === o?.walletId); if (!a || a.ext || a.hop) throw new Error('Unknown wallet');
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.key) || nativeChainOf(a.key)) throw new Error('This wallet cannot sign on EVM chains');
    const asset = o.asset === 'USDC' ? 'USDC' : o.asset === 'HYPE' ? 'HYPE' : null;
    if (!asset || !(o.amount === 'max' || (typeof o.amount === 'number' && o.amount > 0 && Number.isFinite(o.amount)))) throw new Error('Invalid amount');
    const account = privateKeyToAccount(a.key as `0x${string}`);
    const W = account.address;
    const base = (HOST && parentOrigin ? parentOrigin : location.origin) + '/api/bridge/motion';
    const get = async (path: string) => { const r = await fetch(base + path, { cache: 'no-store' }); const j = await r.json().catch(() => null); if (!r.ok || !j?.ok) throw new Error(String(j?.error || 'motion\'s bridge did not answer').slice(0, 120)); return j; };
    const dec = asset === 'HYPE' ? 18 : 6;
    const first = await get(`/elysium/prep?address=${W}`);
    const have = BigInt(first.balances?.[asset] ?? '0');
    let units = o.amount === 'max' ? have : parseUnits(String(o.amount), dec);
    const prep = await get(`/elysium/prep?address=${W}&asset=${asset}&amount=${units > 0n ? units : 1n}`);
    if (Number(prep.chainId) !== 99901) throw new Error('motion\'s bridge answered for another chain');
    const price0 = BigInt(prep.gasPrice || '0'), price = (price0 > 0n ? price0 : 100_000_000n) * 2n;
    if (price > 5_000_000_000n) throw new Error('Elysium gas is far above normal right now — try again later');
    const gas = (() => { const g = BigInt(prep.gas || '0'); const x = g > 0n ? (g * 13n) / 10n : 300_000n; return x < 100_000n ? 100_000n : x; })();
    if (gas > 1_500_000n) throw new Error('Refusing to sign: abnormal gas for a way back');
    const fee = gas * price;
    const hype = BigInt(prep.balances?.HYPE ?? '0');
    if (asset === 'HYPE' && o.amount === 'max') units = hype - fee;
    if (!(units > 0n)) throw new Error('Nothing to move after gas');
    if (asset === 'HYPE' ? units + fee > hype : units > BigInt(prep.balances?.USDC ?? '0')) throw new Error('More than this wallet holds on Elysium');
    if (hype < fee) throw new Error(`Needs ${formatEther(fee)} HYPE on Elysium for gas`);
    const tx = elyExitCall(asset, W, units);
    const why = elyExitProblem({ ...tx, chainId: 99901 }, W); if (why) throw new Error('Refusing to sign: ' + why);
    await gate('transfer', auth);
    const text = `${asset === 'HYPE' ? formatEther(units) : formatUnits(units, 6)} ${asset}`;
    const ok = await ask({ title: 'Move funds back from Elysium', ok: `Move ${text}`, html: `${sub(`${escHtml(text)} from ${escHtml(a.name)} on Elysium to the same address on HyperEVM, through the official bridge.`)}${destBox(W)}${muted(escHtml(`It can be claimed after about ${ELY_EXIT_DAYS} days (rollup challenge period, per Kinetiq's docs); motion then claims it on HyperEVM for you, and anyone can.`))}${muted(escHtml(ELYSIUM_RISK))}` });
    if (!ok) throw new Error('Cancelled');
    const raw = await account.signTransaction({ ...tx, gas, gasPrice: price, nonce: Number(prep.nonce), chainId: 99901, type: 'legacy' } as never);
    const r = await fetch(base + '/elysium/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });
    const j = await r.json().catch(() => null);
    if (r.status === 400 || r.status === 429 || r.status === 503) throw new Error('Not sent: ' + String(j?.error || r.status).slice(0, 120));
    if (!r.ok || !j?.ok) throw Object.assign(new Error('Status unknown — the way back may be out; check it under "Moving back" before trying again (' + String(j?.error || r.status).slice(0, 80) + ')'), { name: 'TransferUnknown', unknown: true, hash: keccak256(raw) });
    return { ok: true, hash: keccak256(raw), asset, amount: units.toString(), days: ELY_EXIT_DAYS };
  },
  // (2026-11-04) the route choice into Elysium: float (motion's bridge, the fast path within its float) or official (Relay → HyperEVM →
  // W's own Inbox.depositEth, no float limit). src/elysiumRoute.ts; the page contract is local ely-route/notes.txt.
  elysiumRoute: (o: { walletId: string; pay: 'native' | 'stable'; amount: number; route?: 'auto' | 'float' | 'official'; phase?: 'quote' }, auth?: Auth) => elysiumRoute(o, auth),
  elysiumRouteStatus: async (jobId: string) => elyRoute.status(String(jobId)),
  elysiumRouteResume: (jobId: string) => elyRoute.resume(String(jobId)),
  elysiumRouteJobs: async () => elyRoute.jobs().map((j) => elyRoute.status(j.id)),
  elysiumFundStatus: async (quoteId: string) => {
    const bridge = createSolverBridge({ base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, i), now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY, signEvmTransfer: async () => { throw new Error('read only'); }, signSolTransfer: async () => { throw new Error('read only'); } });
    return bridge.status(String(quoteId));
  },
  bridgeReceipt: async (chainId: number, hash: string) => (Number(chainId) === RELAY_SOL_CHAIN ? solReceipt(hash) : bridgeReceipt(Number(chainId), hash)),
  // a fresh hop wallet for a two-leg bridge: funds land here on the destination chain, then move on
  bridgeHop: async () => { await ready; const id = await addAccount(nextName('Wallet').replace('Wallet', 'Hop'), generatePrivateKey(), { hop: true }); const a = (unlocked || []).find((x) => x.id === id); return { ok: true, id, address: a?.address || '' }; },
  // a refused read is left out of the answer (the page keeps what it knew): an empty wallet and a rate-limited node must not look alike
  balances: async (addresses: string[]) => (SOL_MODE ? solBalancesFor(addresses) : NEAR_MODE ? nearBalancesFor(addresses) : (await evmBalanceSheet(addresses as `0x${string}`[], []))?.eth ?? {}),
  tokenBalances: async (token: string, addresses: string[]) => (SOL_MODE ? solTokenBalancesFor(token, addresses) : NEAR_MODE ? nearTokenBalancesFor(token, addresses) : (await evmBalanceSheet(addresses as `0x${string}`[], [{ address: token as `0x${string}`, decimals: await tokenDecimals(token as `0x${string}`).catch(() => 18) }]))?.tokens[token.toLowerCase()] ?? {}),
};
// EXT-1 (security batch 2): the extension's legacy-wallet move used to carry raw private keys side panel → ext-panel.html (a
// motion.gift document) → bridge.js → engine.import: any script served in that document read them. Now the side panel posts them
// STRAIGHT to this frame (window.frames of its ext-panel child, targetOrigin https://vault.motion.gift): the motion.gift document
// between them never holds a key. Accepted only from the TOP-LEVEL window (the side panel itself, not a page or a frame that
// framed this one) at a pinned extension origin (the ids ext-panel.js pins); only the import (its own dialog and trusted click,
// as for any import); the answer only to that window and origin, and never a key in it.
const EXT_IMPORT_ORIGINS = ['chrome-extension://nojealomoobhcodabdhmlajjfejeboec', 'chrome-extension://goofdckiogaipbkbngogffceglocmkpj'];
async function onExtImport(e: MessageEvent, run: (items: { name?: string; privateKey: string }[]) => Promise<{ results?: unknown }>): Promise<boolean> {
  const d = e.data as { t?: unknown; id?: unknown; items?: unknown } | null;
  if (!d || typeof d !== 'object' || d.t !== 'extImport') return false;
  if (!e.source || e.source !== window.top || window.top === window || !EXT_IMPORT_ORIGINS.includes(e.origin)) return false;
  const id = String(d.id ?? '').slice(0, 64);
  const answer = (msg: Record<string, unknown>) => { try { (e.source as Window).postMessage({ t: 'extImportRet', id, ...msg }, e.origin); } catch { /* the panel closed */ } };
  try {
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 100).map((x) => ({ name: typeof (x as { name?: unknown })?.name === 'string' ? String((x as { name: string }).name).slice(0, 60) : undefined, privateKey: String((x as { privateKey?: unknown })?.privateKey ?? '') }));
    if (!items.length) throw new Error('Nothing to import');
    const r = await run(items);
    answer({ ok: true, v: { results: Array.isArray(r?.results) ? (r.results as { ok?: unknown; name?: unknown; error?: unknown }[]).map((x) => ({ ok: !!x?.ok, name: String(x?.name ?? ''), ...(x?.error ? { error: String(x.error).slice(0, 160) } : {}) })) : [] } });
  } catch (err) { answer({ ok: false, e: String((err as Error)?.message || err).slice(0, 200) }); }
  return true;
}
// ── (2026-11-03) "Add HYPE / USDC on Elysium": motion's bridge pays on Elysium (local elysium-funding/plan.txt option c) ──
// The trading wallet W pays motion's solver on THIS frame's chain (Robinhood / BNB: its native coin or its stablecoin, ONE plain
// transfer to the solver's published deposit address, signed here and handed over raw), and the solver pays W's SAME address on
// Elysium with ONE createRetryableTicket (HYPE) or ONE gateway deposit (USDC) on HyperEVM, every refund address = W. The quote is
// checked here against the pinned solver key, the route, the payer, the recipient (W itself — never another address), the amount
// and OUR OWN prices (this chain's native from its own pool, HYPE from the HyperEVM WHYPE/USDC pool) before a byte is signed.
// (2026-11-04, review L-F6) the official HyperEVM node only: no third-party node in the vault's own price path (down = no quote)
const ELYSIUM_HYPEREVM_RPCS = ['https://rpc.hyperliquid.xyz/evm'];
let elysiumPc: ReturnType<typeof createPublicClient> | null = null;
function elysiumOraclePc(): ReturnType<typeof createPublicClient> {
  if (!elysiumPc) {
    const ch = defineChain({ id: 999, name: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [ELYSIUM_HYPEREVM_RPCS[0]] } } });
    elysiumPc = createPublicClient({ chain: ch, transport: fallback(ELYSIUM_HYPEREVM_RPCS.map((u) => http(u))) }) as ReturnType<typeof createPublicClient>;
  }
  return elysiumPc;
}
const SLOT0_ABI = [{ type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }] }] as const;
async function elysiumPrice6(pc: ReturnType<typeof createPublicClient>, key: 'robinhood' | 'bsc' | 'elysium'): Promise<bigint> {
  const c = mbCfg(key);
  const r = await pc.readContract({ address: c.oracle.pool as `0x${string}`, abi: SLOT0_ABI, functionName: 'slot0' }) as readonly unknown[];
  const p = mbPrice6(BigInt(r[0] as bigint), c.oracle, c.nativeDecimals);
  if (!(p > 0n)) throw new Error('no price for ' + key);
  return p;
}
// the one source transfer, from W, signed in W's send lane with a fresh nonce; the solver broadcasts it. Kept here until the
// fill answers so the counter moves only when the bytes are out (sent → counted; refused with sent:false → nothing used;
// no clear answer → the next send of W re-reads the chain's pending count).
async function elysiumSignFromW(a: { walletId: string; token: string; to: string; amount: bigint }, held: { nonce?: number }): Promise<{ raw: string; hash: string }> {
  const { account } = walletFor(a.walletId);
  const native = String(a.token).toLowerCase() === MB_NATIVE;
  const tx = native ? { to: a.to as `0x${string}`, value: a.amount, data: '0x' as `0x${string}` }
    : { to: a.token as `0x${string}`, value: 0n, data: bridgeTransferData(a.to, a.amount) as `0x${string}` };
  const [nonce, gasPrice, est] = await Promise.all([nextNonce(account.address, true), feeFor(1), publicClient.estimateGas({ account: account.address, ...tx }).catch(() => (native ? 60_000n : 150_000n))]);
  const gas = (est * 13n) / 10n;
  if (gas > (native ? 100_000n : 400_000n)) throw new Error('Refusing to sign: abnormal gas for a plain transfer');
  if (CFG.maxFeeWei && gas * gasPrice > CFG.maxFeeWei) throw new Error('Refusing to sign: abnormal gas');
  const raw = await account.signTransaction({ ...tx, gas, gasPrice, nonce, chainId: chain.id, type: 'legacy' } as never);
  held.nonce = nonce;
  return { raw, hash: keccak256(raw) };
}

// (2026-11-04) the Solana side of "Add funds on Elysium": W's own Solana key signs ONE native SOL transfer (System Program) or ONE
// USDC transferChecked to the solver's deposit address, with the quote id as memo and a small compute budget — nothing else
async function elysiumSignSolFromW(a: { walletId: string; mint: string; to: string; amount: bigint; decimals: number; memo: string }): Promise<{ raw: string; sig: string }> {
  const { w } = solAcctsOf(a.walletId);
  const k = solKeys(w.key as string);
  const ixs = a.mint === MB_NATIVE_SOL
    ? solBridgeNativeIxs({ owner: w.address, to: a.to, amount: a.amount, memo: a.memo, units: 1_000, micro: BigInt(SOL_BRIDGE.micro) })
    : solBridgeTransferIxs({ owner: w.address, src: solFloatAta(w.address, a.mint), dst: solFloatAta(a.to, a.mint), mint: a.mint, amount: a.amount, decimals: a.decimals, memo: a.memo, units: SOL_BRIDGE.units, micro: BigInt(SOL_BRIDGE.micro) });
  const bh = await solBlockhashInfo();
  const { tx, sig } = solSignMessage(solCompile(w.address, ixs, bh.blockhash), k.seed);
  if (tx.length > 1232) throw new Error('Transaction too large');
  return { raw: btoa(String.fromCharCode(...tx)), sig: solB58e(sig) };
}
// (release 6) "Move HYPE from HyperEVM to Elysium" (src/elysiumHyperFund.ts): W's OWN key signs ONE plain HYPE transfer on HyperEVM (chain 999)
// to motion's published HyperEVM deposit address, for a quote checked against the pinned solver key, the route, W as payer AND recipient,
// and at most motion's 0.1 % fee at OUR HyperEVM price; the solver pays W's same address on Elysium. Any EVM frame (the key is the same),
// never NEAR / Solana. The reads, the nonce and the gas price come from the official HyperEVM node (elysiumOraclePc); the vault broadcasts
// nothing (the solver does). One HyperEVM move per wallet at a time (the lock); the frame's own send lane is never held.
function elysiumFundFromHyperEvm(o: unknown, auth?: Auth): Promise<Record<string, unknown>> {
  if (NEAR_MODE || SOL_MODE) return Promise.reject(new Error('Open an EVM wallet to move HYPE from HyperEVM to Elysium'));
  const pc = elysiumOraclePc();
  return createElyHyperFund({
    now: () => Date.now(),
    wallet: (id) => {
      const a = requireUnlocked().find((x) => x.id === id); if (!a || a.ext || a.hop) throw new Error('Unknown wallet');
      if (!/^0x[0-9a-fA-F]{64}$/.test(a.key) || nativeChainOf(a.key)) throw new Error('This wallet cannot sign on EVM chains');
      const account = privateKeyToAccount(a.key as `0x${string}`);
      return { id: a.id, name: a.name, w: account.address, sign: (tx) => account.signTransaction(tx as never) as Promise<`0x${string}`> };
    },
    reads: {
      balance: (w) => pc.getBalance({ address: w }),
      code: async (w) => { const c = await pc.getCode({ address: w }); return c && c !== '0x' ? c : '0x'; },
      price6: () => elysiumPrice6(pc, 'elysium'),
      nonce: (w) => pc.getTransactionCount({ address: w, blockTag: 'pending' }),
      gasPrice: () => pc.getGasPrice(),
    },
    bridge: (signEvm) => createSolverBridge({
      base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, { ...(i || {}), credentials: 'omit' }), now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY,
      signEvmTransfer: signEvm, signSolTransfer: async () => { throw new Error('no Solana source here'); },
    }),
    gate: () => gate('transfer', auth),
    ask: (d) => ask(d), esc: escHtml, destBox,
    lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn) as Promise<T>; },
    risk: ELYSIUM_RISK,
  }).fund(o);
}
const ELYSIUM_DOCS = 'https://elysium.kinetiq.xyz/docs/bridging-hyperevm-tokens-to-elysium';
// (2026-11-04, the independent review's disclosure) beside the 6-day line, in the vault's own dialogs
const ELYSIUM_RISK = 'Elysium\'s bridge can be upgraded by Kinetiq\'s 4-of-11 multisig without a delay.';
const ELYSIUM_BACK = 'Moving funds back from Elysium to HyperEVM takes about 6 days (rollup challenge period, per Kinetiq\'s docs).';
// ── (2026-11-04) the route choice into Elysium + the "official" route (src/elysiumRoute.ts; local ely-route/notes.txt) ──
// float = motion's bridge (elysiumFund above, unchanged: the fast path while the float can fill the amount); official = Relay → W's
// OWN address on HyperEVM (native HYPE, motion's 0.1 % as Relay's app fee) → W's OWN Inbox.depositEth() → W on Elysium. No float.
// Robinhood / BNB / Solana frames; nothing here runs on a click (the trade path never reaches it).
const elyRouteSrc = (): ElyRouteSrc => { if (NEAR_MODE || !(SOL_MODE || CFG.key === 'robinhood' || CFG.key === 'bsc')) throw new Error('Elysium funding starts from a Robinhood, BNB or Solana wallet'); return (SOL_MODE ? 'sol' : CFG.key) as ElyRouteSrc; };
const elyRouteAcct = (id: string) => {
  const a = requireUnlocked().find((x) => x.id === id); if (!a || a.ext || a.hop) throw new Error('Unknown wallet');
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.key) || nativeChainOf(a.key)) throw new Error('This wallet cannot sign on EVM chains');
  return a;
};
const elyRoutePc = () => (CFG.key === 'elysium' ? publicClient : bridgeOtherPc(CHAIN_CFGS.elysium));
async function elyRouteInUsd6(coin: ElyRouteCoin, amount: bigint): Promise<bigint> {
  const src = elyRouteSrc(), s = ELY_ROUTE_SRC[src];
  if (coin === 'stable') return s.stableDecimals >= 6 ? amount / 10n ** BigInt(s.stableDecimals - 6) : amount * 10n ** BigInt(6 - s.stableDecimals);
  const p6 = src === 'sol' ? await solFloatPrice6(mbCfg('sol').oracle.pool, mbCfg('sol').stable.address) : await elysiumPrice6(publicClient as never, src);
  return (amount * p6) / 10n ** BigInt(s.nativeDecimals);
}
const elyRoute = createElyRoute({
  now: () => Date.now(), wait: floatWait,
  store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } },
  lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn) as Promise<T>; },
  src: elyRouteSrc,
  wallet: (id) => {
    const a = elyRouteAcct(id), account = privateKeyToAccount(a.key as `0x${string}`);
    const payer = SOL_MODE ? solAddressOf(a) : account.address; if (!payer) throw new Error('This wallet has no address on this network');
    return { id: a.id, name: a.name, w: account.address, payer, signHyper: (tx) => account.signTransaction(tx as never) as Promise<`0x${string}`> };
  },
  reads: {
    srcBalance: async (payer, coin) => {
      const s = ELY_ROUTE_SRC[elyRouteSrc()];
      if (SOL_MODE) return coin === 'native' ? solFloatRpc<any>('getBalance', [payer, { commitment: 'confirmed' }]).then((r) => BigInt(r?.value ?? 0))
        : solFloatRpc<any>('getTokenAccountBalance', [solFloatAta(payer, s.stable), { commitment: 'confirmed' }]).then((r) => BigInt(r?.value?.amount ?? 0), () => 0n);
      return coin === 'native' ? publicClient.getBalance({ address: payer as `0x${string}` }) : publicClient.readContract({ address: s.stable as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [payer as `0x${string}`] }) as Promise<bigint>;
    },
    inUsd6: elyRouteInUsd6,
    hypePrice6: () => elysiumPrice6(elysiumOraclePc(), 'elysium'),
    hyperBalance: (w) => elysiumOraclePc().getBalance({ address: w }),
    hyperCode: async (w) => { const c = await elysiumOraclePc().getCode({ address: w }); return c && c !== '0x' ? c : '0x'; },
    hyperNonce: (w) => elysiumOraclePc().getTransactionCount({ address: w, blockTag: 'pending' }),
    hyperGasPrice: () => elysiumOraclePc().getGasPrice(),
    hyperEstimate: (tx) => elysiumOraclePc().estimateGas({ account: tx.from, to: tx.to, value: tx.value, data: tx.data }),
    hyperReceipt: async (hash) => { const r = await elysiumOraclePc().getTransactionReceipt({ hash }).catch(() => null); return r ? { status: r.status, logs: r.logs as never } : null; },
    elyBalance: (w) => elyRoutePc().getBalance({ address: w }),
    elyTx: async (hash) => { const t = await elyRoutePc().getTransaction({ hash }).catch(() => null); return t ? { blockNumber: t.blockNumber ?? null } : null; },
  },
  relay: {
    quote: async (body) => (await relayQuote(body)).j,                     // keyless from api.relay.link only (a key refusal is a refusal)
    status: async (id) => (await relayStatus(id))?.status ?? null,
  },
  // the source deposit: relaySwap's own senders (the bytes elyRelayProblem checked), the same as a cross-chain swap
  sendRelay: async (walletId, body, b) => {
    const a = elyRouteAcct(walletId);
    const bound = { originChainId: body.originChainId, destinationChainId: body.destinationChainId, originCurrency: body.originCurrency, destinationCurrency: body.destinationCurrency, amount: body.amount, recipient: body.recipient,
      requestId: b.requestId, source: 'relay', user: body.user, out: b.out.toString(), outFormatted: formatEther(b.out), outSymbol: 'HYPE', inSymbol: '', inFormatted: '', inDecimals: 0, steps: [], ...(b.evm ? { evm: b.evm } : {}), ...(b.sol ? { sol: b.sol } : {}) } as SwapBound;
    return SOL_MODE ? solSwapSend(a as never, bound) : (await evmSwapSend(a, bound)).hash;
  },
  sendHyper: async (raw) => { await elysiumOraclePc().sendRawTransaction({ serializedTransaction: raw }); },
  gate: () => gate('transfer'),
  ask: (o) => ask(o), esc: escHtml, destBox,
  back: ELYSIUM_BACK, risk: ELYSIUM_RISK,
  fmtIn: (coin, amount) => { const s = ELY_ROUTE_SRC[elyRouteSrc()]; return coin === 'native' ? `${formatUnits(amount, s.nativeDecimals)} ${s.nativeSymbol}` : `${formatUnits(amount, s.stableDecimals)} ${s.stableSymbol}`; },
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:elysium-route', { detail })),
});
// engine.elysiumRoute { walletId, pay: 'native' | 'stable', amount (a number, in the source coin), route?: 'auto' | 'float' | 'official', phase?: 'quote' }
// quote → { ok, phase: 'quote', route: 'float' | 'official' | null, usd, routes: { float, official } } (each: available, why, out, outText,
// etaMs, fees, feeText); go → the chosen route's answer (float: elysiumFund's own, unchanged, + route: 'float'; official: elysiumRoute.ts view).
async function elysiumRoute(o: { walletId: string; pay: 'native' | 'stable'; amount: number; route?: 'auto' | 'float' | 'official'; phase?: 'quote' }, auth?: Auth): Promise<Record<string, unknown>> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  for (const k of Object.keys(o)) if (!['walletId', 'pay', 'amount', 'route', 'phase', 'lang'].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  const coin: ElyRouteCoin | null = o.pay === 'native' ? 'native' : o.pay === 'stable' ? 'stable' : null;
  if (!coin || !(typeof o.amount === 'number' && o.amount > 0 && Number.isFinite(o.amount))) throw new Error('Invalid amount');
  if (!(o.route == null || o.route === 'auto' || o.route === 'float' || o.route === 'official')) throw new Error('Bad arguments: route');
  if (o.phase != null && o.phase !== 'quote') throw new Error('Bad arguments: phase');
  const force = o.route === 'float' || o.route === 'official' ? o.route : null;
  const src = elyRouteSrc(), s = ELY_ROUTE_SRC[src];
  const amount = parseUnits(String(o.amount), coin === 'native' ? s.nativeDecimals : s.stableDecimals);
  const solver = createSolverBridge({ base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, { ...(i || {}), credentials: 'omit', signal: AbortSignal.timeout(8000) }), now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY, signEvmTransfer: async () => { throw new Error('read only'); }, signSolTransfer: async () => { throw new Error('read only'); } });
  const [h, inUsd6] = await Promise.all([solver.health().catch(() => null), elyRouteInUsd6(coin, amount)]);
  const usd = Number(inUsd6) / 1e6;
  const pick = pickElyRoute({ usd, src, coin, health: h as ElyFloatHealth, force });
  const floatArgs = { walletId: o.walletId, pay: coin, amount: o.amount, asset: 'HYPE' as const };
  const why = (e: unknown) => String((e as Error)?.message || e).slice(0, 160);
  if (o.phase === 'quote') {
    // both quotes in parallel, each only when its route can take this amount; a failed quote = that route unavailable, with why
    const [fq, oq] = await Promise.all([
      pick.float.ok && force !== 'official' ? engine.elysiumFund({ ...floatArgs, phase: 'quote' }, auth).then((r) => ({ ok: true as const, r: r as Record<string, unknown> }), (e) => ({ ok: false as const, why: why(e) })) : Promise.resolve({ ok: false as const, why: pick.float.why || 'not asked' }),
      pick.official.ok && force !== 'float' ? elyRoute.quote({ walletId: o.walletId, coin, amount }).then((r) => ({ ok: true as const, r: r.view }), (e) => ({ ok: false as const, why: why(e) })) : Promise.resolve({ ok: false as const, why: pick.official.why || 'not asked' }),
    ]);
    const floatView = fq.ok ? { available: true, why: '', route: 'float', out: String(fq.r.out), outText: fq.r.outText, etaMs: Number(fq.r.etaMs) || 5_000, fees: { motion: { bps: ELY_ROUTE.fee.bps, usd: Math.max(0.01, usd * 0.001) } }, feeText: 'motion 0.1 %', maxFillUsd: pick.float.maxFillUsd }
      : { available: false, why: fq.why, route: 'float', maxFillUsd: pick.float.maxFillUsd };
    const offView = oq.ok ? { available: true, why: '', ...oq.r } : { available: false, why: oq.why, route: 'official' };
    const route = force ? (force === 'float' ? (fq.ok ? 'float' : null) : (oq.ok ? 'official' : null)) : fq.ok ? 'float' : oq.ok ? 'official' : null;
    return { ok: !!route, phase: 'quote', route, usd, routes: { float: floatView, official: offView }, back: ELYSIUM_BACK, docs: ELYSIUM_DOCS };
  }
  if (!pick.route) throw new SolverRefused(force === 'float' ? pick.float.why : force === 'official' ? pick.official.why : (pick.official.why || pick.float.why || 'No route into Elysium for this amount'));
  if (pick.route === 'float') return { route: 'float', ...(await engine.elysiumFund(floatArgs, auth)) };
  return elyRoute.go({ walletId: o.walletId, coin, amount, gate: () => gate('transfer', auth) });
}
// ── (2026-11-04) a buy on Elysium paid from the USD balance (src/elysiumUsdEngine.ts; local elysium-usd) ──
// The Elysium frame's float.ensure { chain: 'elysium', reason: 'click' | 'notice' | 'jobs', … } lands here (engine.float.ensure
// routes it); every other chain's ensure is float.ensure exactly as before. What may be signed: ONE stablecoin transfer from the
// wallet's OWN reserve R (Robinhood / BNB: bridgeSignEvmTransfer, the same signer every cold top-up uses, on that chain's own
// nodes; Solana: bridgeSignSolTransfer) to motion's published deposit address, for a quote checked against the pinned solver key
// that pays HYPE to W's same address on Elysium. Only while the wallet's USD-balance permission is live (float.liveFor); the first
// move of an account shows the exit-time notice in this frame's own dialog ("I understand", stored per account).
// (release 8) when W's own reserves cannot pay, ONE reserve of another wallet of this vault whose permission is live on that
// chain may (the same signers, walletId = that wallet: its own R signs), still paying HYPE only to W; the account allows that
// once in this frame's dialog. Earn's ready part (earn.status, cached, read only) is only named in a refusal.
const elyUsd = createElyUsd({
  now: () => Date.now(), wait: floatWait,
  store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } },
  // one move per wallet across this browser's tabs (a second tab's click waits for the first, then follows its job)
  lock: <T,>(key: string, fn: () => Promise<T>) => { const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; return lk?.request ? lk.request('trench-' + key, () => fn()) as Promise<T> : inLane(key, fn) as Promise<T>; },
  ask: (o) => ask(o), esc: escHtml,
  account: () => (meta.main && /^0x[0-9a-fA-F]{40}$/.test(meta.main) ? meta.main : null),
  wallet: (id) => { const a = floatAccount(id); const r = reserveOf(a); return { id: a.id, name: a.name, w: a.address as `0x${string}`, r: { evm: r.evm, sol: r.sol } }; },
  permission: (id) => float.liveFor(id),
  // (release 8) the account's wallets that can hold a USD balance (the float switch's own list: no Privy, hop or chain-only key)
  wallets: () => requireUnlocked().filter((a) => !a.archived && !a.hop && !a.ext && !nativeChainOf(a.key) && /^0x[0-9a-fA-F]{64}$/.test(a.key)).map((a) => a.id),
  // (release 8) Earn's ready part on that wallet's reserve there (floatEngine's earnReadyUsd rule), for the refusal's text only
  earnReady: (id, c) => {
    const ew = earnWallets().find((x) => x.id === id); const er = ew ? earn.status(ew, c) : null;
    if (!er || !(er.usd > 0) || er.cls === 'hard' || er.landing || er.verifying || (er as { foreign?: boolean }).foreign) return null;
    const u = Math.min(Number(er.redeemable) || 0, er.usd); return u > 0 ? BigInt(Math.round(u * 1e6)) : null;
  },
  reads: {
    // this frame's own nodes in the Elysium frame; from another lane (the deposit screen there) motion's Elysium relay, a balance read only
    wHype: (w) => (CFG.key === 'elysium' ? publicClient.getBalance({ address: w }) : bridgeOtherPc(CHAIN_CFGS.elysium).getBalance({ address: w })),
    price6: () => elysiumPrice6(elysiumOraclePc(), 'elysium'),
    reserve: (c, owner) => (c === 'sol' ? bridgeSolReserveOn(owner) : bridgeReserveOn(c, FLOAT_CFG[c].stable.address, owner as `0x${string}`)),
    code: async (w) => { const c = await elysiumOraclePc().getCode({ address: w }); return c && c !== '0x' ? c : '0x'; },
  },
  bridge: createSolverBridge({
    base: () => (HOST && parentOrigin ? parentOrigin : location.origin), fetch: (u, i) => fetch(u, { ...(i || {}), credentials: 'omit', signal: AbortSignal.timeout(8000) }),
    now: () => Date.now(), pinnedKey: () => MOTION_SOLVER_KEY,
    signEvmTransfer: bridgeSignEvmTransfer as never, signSolTransfer: bridgeSignSolTransfer as never, release: bridgeRelease as never,
  }),
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:float', { detail })),
});
// a click (a buy's top-up) only in the Elysium frame; the deposit screen, the notice and the job view from any lane but NEAR
function floatEnsure(o: unknown): Promise<unknown> {
  if (!(o && typeof o === 'object' && (o as { chain?: unknown }).chain === 'elysium')) return float.ensure(o);
  if (NEAR_MODE || ((o as { reason?: unknown }).reason === 'click' && (CFG.key !== 'elysium' || SOL_MODE))) return Promise.reject(new Error('Open the Elysium lane for a buy on Elysium'));
  return elyUsd.ensure(o);
}
// ── Earn on the USD balance (src/earnEngine.ts, src/earnCore.ts, src/earnAave.ts, src/earnKamino.ts; 2026-11-03, NOT released) ──
// Every lane's frame runs Earn for its own chain: Robinhood (Morpho), BNB (Aave v3), Solana (Kamino). R signs only what that
// chain's allow-list allows — earnCore.earnTxProblem (EVM) / earnKamino.kaminoIxsProblem (Solana) is asked AGAIN here, right
// before R's signer, whatever earnEngine checked. Reads go through the float's own client (the 1 request/s bucket in the
// background, the click path's floatNow for a waiting click), behind a running trade at the source; EVM reads batched in one
// Multicall3 aggregate3.
async function earnSendR(walletId: string, tx: EarnTx, gas: bigint, signed?: (nonce: number) => void): Promise<`0x${string}`> {
  const v = SOL_MODE || NEAR_MODE ? null : earnVenueOf(CFG.key);
  if (!v || (v.kind !== 'erc4626' && v.kind !== 'aave3')) throw new Error('Refusing to sign: Earn is not on this chain');
  const r = reserveOf(floatAccount(walletId));
  const bad = earnTxProblem(tx, { r: r.evm, chainId: chain.id, cfg: v });
  if (bad) throw new Error('Refusing to sign: ' + bad);
  if (!(gas > 0n) || gas > EARN.gasMax) throw new Error('Refusing to sign: abnormal gas');
  return floatSendR(walletId, tx as EvmTx, gas, signed);
}
async function earnMulti(calls: { to: `0x${string}`; data: `0x${string}` }[], now?: boolean): Promise<(`0x${string}` | null)[]> {
  const run = now ? floatNow : floatRpc;
  const ret = await run((pc) => pc.call({ to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))] }) }));
  const res = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: ret.data || '0x' }) as readonly { success: boolean; returnData: `0x${string}` }[];
  if (res.length !== calls.length) throw new Error('multicall: wrong answer length');
  return res.map((x) => (x.success ? x.returnData : null));
}
// Solana: the instructions in the engine's own shape (keys as metas); R's account for the simulation's copy and the send
const earnIx = (k: KIx) => ({ program: k.program, keys: k.keys.map(([pubkey, signer, writable]) => ({ pubkey, signer, writable })), data: k.data });
// review L2: the oracle accounts of refresh_reserve come from the signer's OWN read of the reserve (kept 60 s), never from the
// instructions it checks; a reserve it cannot parse (a klend layout change) falls back to the set this build pins (KAMINO_SOL)
let earnSolOracleMemo: { at: number; v: ReserveRead['oracles'] } | null = null;
async function earnSolOracles(): Promise<ReserveRead['oracles']> {
  if (earnSolOracleMemo && Date.now() - earnSolOracleMemo.at < 60_000) return earnSolOracleMemo.v;
  const got = (await solAccounts([KAMINO_SOL.reserve]).catch(() => [undefined])) as ({ owner: string; data: Uint8Array } | null | undefined)[];
  const acc = got[0];
  const rr = acc ? readReserve(acc.data ?? null, acc.owner ?? null, KAMINO_SOL) : null;
  if (rr && !('why' in rr)) { earnSolOracleMemo = { at: Date.now(), v: rr.oracles }; return rr.oracles; }
  return kPinnedOracles(KAMINO_SOL);
}
async function earnSolCheck(walletId: string, ixs: KIx[]): Promise<{ r: SolAcct }> {
  if (!SOL_MODE) throw new Error('Refusing to sign: Earn on Solana runs in the Solana frame');
  const { r } = solAcctsOf(walletId);
  const last = ixs[ixs.length - 1];
  // every account is rebuilt here (the reserve's pinned accounts, R's own token accounts, the signer's own oracle read) and
  // compared byte for byte
  const oracles = await earnSolOracles();
  const bad = !last ? 'nothing to sign' : kaminoIxsProblem(ixs, { r: r.address, rUsdc: solFloatAta(r.address, KAMINO_SOL.mint), rCtoken: solFloatAta(r.address, KAMINO_SOL.cMint), oracles, perTxMax6: EARN.perTxMax6 });
  if (bad) throw new Error('Refusing to sign: ' + bad);
  return { r: r as SolAcct };
}
async function earnSolSimulate(walletId: string, ixs: KIx[], watch: string[]): Promise<{ err: unknown; post: (Uint8Array | null)[] }> {
  const { r } = await earnSolCheck(walletId, ixs);
  // unsigned (sigVerify off, the node replaces the blockhash): nothing here can be sent
  const msg = solCompile(r.address, [...solBudget(KAMINO_UNITS, KAMINO_MICRO), ...ixs.map(earnIx)] as never, SOL_P.system);
  const tx = new Uint8Array(1 + 64 + msg.length); tx[0] = 1; tx.set(msg, 65);
  const v = await solSimulateAccounts(tx, watch);
  return { err: v.err, post: v.accounts.map((x) => (x ? x.data : null)) };
}
async function earnSolSend(walletId: string, ixs: KIx[]): Promise<string> {
  const { r } = await earnSolCheck(walletId, ixs);
  return solFloatSend(r, ixs.map(earnIx) as never, KAMINO_UNITS, KAMINO_MICRO);
}
const earnWalletCache = new Map<string, EarnWallet>();
const earnWallets = (): EarnWallet[] => {
  const out: EarnWallet[] = [];
  for (const a of requireUnlocked()) {
    if (a.archived || a.hop || a.ext || nativeChainOf(a.key) || !/^0x[0-9a-fA-F]{64}$/.test(a.key)) continue;
    const ck = a.id + '|' + a.address.toLowerCase();
    let ew = earnWalletCache.get(ck); if (!ew) { const rr = reserveOf(a); ew = { id: a.id, name: a.name, r: { evm: rr.evm, sol: rr.sol } }; earnWalletCache.set(ck, ew); }
    out.push({ ...ew, name: a.name });
  }
  return out;
};
let earnMonitorMemo: { at: number; v: unknown } | null = null;
const earn = createEarn({
  chain: floatLane,
  chainId: () => chain.id,
  wallets: earnWallets,
  ...(SOL_MODE || NEAR_MODE ? {} : { evm: {
    call: async (tx, now) => (await (now ? floatNow : floatRpc)((pc) => pc.call({ account: tx.from, to: tx.to, data: tx.data }))).data || '0x',
    multi: earnMulti,
    codeHash: async (a) => { const code = await floatRpc((pc) => pc.getCode({ address: a })); return code && code !== '0x' ? keccak256(code) : '0x'; },
    storageAt: async (a, slot) => (await floatRpc((pc) => pc.getStorageAt({ address: a, slot }))) || '0x',
    balance: (a, now) => (now ? floatNow : floatRpc)((pc) => pc.getBalance({ address: a })),
    gasPrice: async (now) => { const f = await floatFees(now ? floatNow : floatRpc); const floor = ((f.baseFee > f.gasPrice ? f.baseFee : f.gasPrice) * 125n) / 100n; if (CFG.maxGasPrice && floor > CFG.maxGasPrice) throw new Error('Gas price is far above normal for this chain — refusing'); return floor; },
    estimate: (tx, now) => (now ? floatNow : floatRpc)((pc) => pc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value })),
    send: earnSendR,
    // waits up to `ms` for the receipt with its logs (the outcome checks read the transaction's own events)
    receipt: async (hash, ms, now) => {
      const t0 = Date.now(); const run = now ? floatNow : floatRpc;
      for (;;) {
        const r = await run((pc) => pc.getTransactionReceipt({ hash })).catch(() => null);
        if (r) return { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as readonly string[], data: l.data })), blockHash: r.blockHash, blockNumber: r.blockNumber };
        if (Date.now() - t0 >= ms) return null;
        await floatWait(now ? 250 : 400);
      }
    },
    // r4 (re-review M3-1): one read — the receipt, 'missing' when the node ANSWERED it does not know it, null when no node answered
    // (the float's transport tries its other nodes first); and a block's hash (a reorg is positive only when that block changed)
    receiptCheck: async (hash, now) => {
      try { const r = await (now ? floatNow : floatRpc)((pc) => pc.getTransactionReceipt({ hash })); return { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as readonly string[], data: l.data })), blockHash: r.blockHash, blockNumber: r.blockNumber }; }
      catch (x) { return /TransactionReceiptNotFound/.test(String((x as Error)?.name || '')) ? 'missing' : null; }
    },
    blockHash: async (n) => { const b = await floatRpc((pc) => pc.getBlock({ blockNumber: n })).catch(() => null); return b?.hash ?? null; },
    // r5 (re-review X2): R's confirmed nonce
    nonce: (a) => floatRpc((pc) => pc.getTransactionCount({ address: a, blockTag: 'latest' })),
    // review H2: the venue's events naming R (exact topics) and the head — background only, through the float's bucket
    logs: async (q) => {
      const hx = (n: bigint) => '0x' + n.toString(16);
      const res = (await floatRpc((pc) => pc.request({ method: 'eth_getLogs', params: [{ address: q.address, topics: q.topics, fromBlock: hx(q.fromBlock), toBlock: hx(q.toBlock) }] } as never))) as unknown;
      if (!Array.isArray(res)) throw new Error('eth_getLogs: bad answer');
      return res.map((l: { transactionHash?: unknown; topics?: unknown; data?: unknown }) => { if (typeof l?.transactionHash !== 'string') throw new Error('eth_getLogs: a log without its transaction'); return { tx: l.transactionHash, topics: Array.isArray(l.topics) ? (l.topics as string[]) : [], ...(typeof l.data === 'string' ? { data: l.data } : {}) }; });
    },
    head: () => floatRpc((pc) => pc.getBlockNumber()),
  } }),
  ...(SOL_MODE ? { sol: {
    accounts: (addrs, now) => (now ? floatNowQuiet : floatQuiet)(() => solAccounts(addrs)) as never,
    // the program's last deploy slot: 8 bytes of its ProgramData (never the program's bytes)
    deploySlot: (pd) => floatQuiet(async () => { const r = await solFloatRpc<any>('getAccountInfo', [pd, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }]); const d = r?.value?.data?.[0]; if (!d) return null; const b = Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0)); return b.length === 8 ? new DataView(b.buffer).getBigUint64(0, true) : null; }),
    ata: (owner, mint) => solFloatAta(owner, mint),
    simulate: (walletId, ixs, watch, now) => (now ? floatNowQuiet : floatQuiet)(() => earnSolSimulate(walletId, ixs, watch)),
    send: (walletId, ixs) => floatQuiet(() => earnSolSend(walletId, ixs)),
    status: (sig, now) => (now ? floatNowQuiet : floatQuiet)(async () => { const [st] = await solSigStatusesBoth([sig]); return !st ? null : st.err ? 'failed' : st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : null; }),
    // r3 (re-review N1): who signed a transaction — the first header.numRequiredSignatures account keys (background only)
    signers: (sig) => floatQuiet(async () => {
      const t = await solFloatRpc<any>('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      const m = t?.transaction?.message; const n = Number(m?.header?.numRequiredSignatures);
      if (!m || !Array.isArray(m.accountKeys) || !(n > 0)) return null;
      return m.accountKeys.slice(0, n).map((k: unknown) => String(k));
    }),
    // review H2: what touched R's cToken account, newest first (background only)
    signatures: (addr, until, before) => floatQuiet(async () => {
      const r = await solFloatRpc<any>('getSignaturesForAddress', [addr, { limit: 100, commitment: 'confirmed', ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
      if (!Array.isArray(r)) throw new Error('getSignaturesForAddress: bad answer');
      return r.filter((x: any) => typeof x?.signature === 'string').map((x: any) => ({ sig: String(x.signature), err: x.err != null, at: typeof x.blockTime === 'number' ? x.blockTime : null }));
    }),
  } } : {}),
  // the server's read-only monitor: a chain it flags goes risk-off (it can never turn Earn on); kept 60 s
  monitor: async () => {
    if (earnMonitorMemo && Date.now() - earnMonitorMemo.at < 60_000) return earnMonitorMemo.v as never;
    const base = HOST && parentOrigin ? parentOrigin : location.origin;
    const j = await fetch(base + '/api/earn/status', { credentials: 'omit', signal: AbortSignal.timeout(5000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const chains = j && typeof j === 'object' && j.chains && typeof j.chains === 'object' ? j.chains as Record<string, { pause?: unknown; hold?: unknown; apyBps?: unknown }> : null;
    const v = chains ? Object.fromEntries(['robinhood', 'bsc', 'sol'].filter((c) => chains[c]).map((c) => [c, { ...(typeof chains[c].pause === 'string' && chains[c].pause ? { pause: String(chains[c].pause).slice(0, 120) } : {}), ...(typeof chains[c].hold === 'string' && chains[c].hold ? { hold: String(chains[c].hold).slice(0, 120) } : {}), ...(typeof chains[c].apyBps === 'number' && Number.isFinite(chains[c].apyBps) ? { apyBps: Math.round(chains[c].apyBps as number) } : {}) }])) : null;
    earnMonitorMemo = { at: Date.now(), v };
    return v as never;
  },
  // one Earn step per wallet × chain across this vault's tabs. review H4: held until the step itself settles — never let go
  // early (earnEngine bounds a step: past EARN.stepMs it sends nothing more; its receipt / status waits are bounded). waitMs
  // bounds only the WAIT for the lock; a step's own error is the step's (not "lock not taken")
  lock: async <T,>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T | null> => {
    const lk = typeof navigator !== 'undefined' ? navigator.locks : undefined; if (!lk?.request) return fn();
    if (!opts?.waitMs) return lk.request(key, { ifAvailable: true }, (l) => (l ? fn() : null)) as Promise<T | null>;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), opts.waitMs);
    let got = false;
    try { return await (lk.request(key, { signal: ac.signal }, () => { got = true; clearTimeout(t); return fn(); }) as Promise<T | null>); }
    catch (x) { if (got) throw x; return null; } finally { clearTimeout(t); }
  },
  // the server's geo answer (Earn is off for the United States): anything but { on: true } — an error, a timeout, an older
  // server without the route — is a no
  // (earn-ship, 2026-11-04: the owner gate) this ONE request carries the motion site's cookies (credentials 'include'): while
  // Earn is in the owner's preview the server says on only to a browser holding the owner's preview cookie, and it may add a
  // per-account cap (capUsd, which can only lower the account's own). The server answers it with the vault origin alone in
  // Access-Control-Allow-Origin (+ Allow-Credentials); anything else fails the fetch here = a no. The answer carries no key,
  // nothing is sent but the GET.
  geo: async () => { const base = HOST && parentOrigin ? parentOrigin : location.origin; const j = await fetch(base + '/api/earn/access', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null); return !!j && j.on === true ? { on: true, capUsd: typeof j.capUsd === 'number' && Number.isFinite(j.capUsd) ? j.capUsd : null } : false; },
  ask: (o) => ask(o),
  gate: () => gate('transfer'),
  esc: escHtml,
  now: () => Date.now(),
  store: {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  },
  emit: (detail) => document.dispatchEvent(new CustomEvent('trench:float', { detail })),
  wait: floatWait,
  busy: () => tradeRunning() || inClickWindow({ ...floatClock, clickAt: clicksRunning > 0 ? Date.now() + 1 : floatClock.clickAt }, Date.now()),
  tradeLive: () => tradeRunning(),
});
earnApi = earn;
if (HOST) {
  // Vault frame. The parent page calls methods by name over postMessage; the
  // answer goes back to the same window and origin. Anything from another
  // window or an origin not on the list is dropped without a reply. The frame
  // binds to the first allowed origin that greets it and ignores every other
  // origin for its lifetime. Events the engine raises for the page (vault
  // changed, balances, jobs) are forwarded the same way.
  const NO_CALL = new Set(['ready', 'exists', 'locked', 'onChange', 'createVault', 'unlock', 'lock']);
  const bind = (e: MessageEvent) => { if (!parentWin) { parentWin = e.source as Window; parentOrigin = e.origin; } return e.origin === parentOrigin; };
  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent || !parentAllowed(e.origin) || !e.data || typeof e.data !== 'object') return;
    if (e.data.t === 'hello') { if (bind(e)) ready.then(() => post({ t: 'ready' })).catch(() => {}); return; }
    if (e.data.t === 'signed') {
      if (!bind(e)) return;
      const w = signWaits.get(String(e.data.id)); if (!w) return;
      signWaits.delete(String(e.data.id)); clearTimeout(w.timer);
      const raw = String(e.data.raw || '');
      if (e.data.ok && /^0x[0-9a-fA-F]+$/.test(raw)) w.resolve(raw as `0x${string}`); else w.reject(new Error(String(e.data.e || 'Privy signing failed')));
      return;
    }
    if (e.data.t !== 'call' || !bind(e)) return;
    const { id, m, a } = e.data as { id: string; m: string; a: unknown[] };
    const reply = (msg: Record<string, unknown>) => post({ t: 'ret', id, ...msg });
    try {
      await ready;
      const path = String(m || '').split('.');
      const holder = (path.length === 2 && path[0] === 'move' ? engine.move : path.length === 2 && path[0] === 'perps' ? engine.perps : path.length === 2 && path[0] === 'limit' ? engine.limit : path.length === 2 && path[0] === 'float' ? engine.float : engine) as unknown as Record<string, unknown>;
      const name = path[path.length - 1];
      const fn = holder[name];
      if (path.length > 2 || NO_CALL.has(name) || typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(holder, name)) throw new Error(`no such vault method: ${m}`);
      const v = await (fn as (...x: unknown[]) => unknown).apply(holder, Array.isArray(a) ? a : []);
      reply({ ok: true, v: v === undefined ? null : v });
    } catch (err) {
      // the name and the "outcome unknown" flag travel with the message (TransferUnknown, TwoFactorRequired, …): the page and the
      // app must not have to guess them from the wording
      const x = err as { message?: string; name?: string; unknown?: boolean; idempotent?: boolean };
      reply({ ok: false, e: x?.message || String(err), n: typeof x?.name === 'string' ? x.name.slice(0, 40) : '', ...(x?.unknown ? { u: true } : {}), ...(x?.idempotent ? { i: true } : {}) });
    }
  });
  // EXT-1: the extension side panel's direct, key-carrying import (onExtImport above); every other message is the parent's
  window.addEventListener('message', (e) => { void onExtImport(e, async (items) => { await ready; return engine.import(items); }).catch(() => {}); });
  for (const name of ['trench:balances', 'trench:jobs', 'trench:tx', 'trench:perps', 'trench:float']) document.addEventListener(name, (e) => post({ t: 'ev', name, detail: (e as CustomEvent).detail }));
  // limit orders v1: { key, walletId, orderId?, step: plan | fund | approve | sign | post | cancel | sweep, state, … } — never a key or signed bytes
  document.addEventListener('trench:limit', (e) => post({ t: 'ev', name: 'trench:limit', detail: (e as CustomEvent).detail }));
} else {
  // Inline in a page (the same-origin fallback and the self-test): the engine
  // never sits on window. bridge.js takes it exactly once; a script that merely
  // runs in this page later has no global through which to reach export() or transfer().
  let taken = false;
  Object.defineProperty(window, '__trenchEngineTake', { configurable: true, enumerable: false, writable: false, value: () => {
    if (taken) throw new Error('engine already taken');
    taken = true;
    try { delete (window as unknown as Record<string, unknown>).__trenchEngineTake; } catch {}
    return engine;
  } });
  document.dispatchEvent(new CustomEvent('trench:engine'));
}
export {};

// Separate terminal quote lane. It does not replace or fall through to buy()/sell().
import { TERMINAL_SOL_POLICY } from './terminalFeeConfig';
async function terminalTrade(request: unknown) {
  // Default-OFF flag: with no pinned policy this lane refuses before any busy/txEvent/click-clock/RPC side effect.
  if (!TERMINAL_SOL_POLICY) throw Object.assign(new Error('Terminal fee execution is not configured'), { code: 'TerminalFeeDisabled' });
  if (!SOL_MODE || !request || typeof request !== 'object') throw new Error('SOL terminal trade required');
  const r = request as Record<string, unknown>;
  if (Object.keys(r).some(k => !(TERMINAL_FEE_POLICY ? ['walletId', 'side', 'token', 'size', 'envelope', 'serialized', 'feePolicy'] : ['walletId', 'side', 'token', 'size', 'envelope', 'serialized']).includes(k)) ||
    typeof r.walletId !== 'string' || !['buy', 'sell'].includes(String(r.side)) || typeof r.token !== 'string' ||
    !SOL_ADDR.test(r.token) || typeof r.size !== 'number' || typeof r.serialized !== 'string' || r.serialized.length > 1644) throw new Error('Invalid terminal trade');
  const side = r.side as 'buy' | 'sell', token = r.token, size = r.size;
  const bad = tradeSizeProblem(side, size, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);
  keepHot();
  const account = requireUnlocked().find(a => a.id === r.walletId);
  if (!account || account.archived || account.hop || account.ext || !account.key) throw new Error('Own active wallet required');
  const address = solAddressOf(account), id = clickId(undefined), settings = tradeSettings(undefined);
  if (!address) throw new Error('This wallet has no Solana key');
  if (TERMINAL_FEE_POLICY) {
    // Verify the server's per-trade fee policy BEFORE anything is signed. Unproven = standard rate (fail-closed).
    const p = (r.envelope && typeof r.envelope === 'object' ? (r.envelope as { payload?: Record<string, unknown> }).payload : null) || {};
    const collector = TERMINAL_FEE_POLICY.collectors?.sol;
    if (!collector || TERMINAL_SOL_POLICY?.feeRecipient !== collector || p.feeRecipient !== collector) throw new Error('Terminal fee collector is not configured for this chain');
    const decision = terminalFeeDecision(r.feePolicy, { ed25519, pinned: TERMINAL_FEE_POLICY, chain: 'sol', trader: address, side, token,
      amount: typeof p.amount === 'string' ? p.amount : '', seen: FEE_POLICY_SEEN });
    assertQuoteMatchesDecision(decision, { pinned: TERMINAL_FEE_POLICY, quoteBps: p.feeBps, reservation: p.reservationId, quoteIssuedAtMs: Number(p.issuedAt) });
    if (decision.nonce) FEE_POLICY_SEEN!.add(decision.nonce, decision.expiresAtMs!);
  }
  const follow = (hash: string) => (async () => {
    for (let i = 0; i < 98; i++) {
      await new Promise(ok => setTimeout(ok, i < 25 ? 400 : 1500));
      const receipt = await solReceipt(hash).catch(() => null);
      if (receipt && !receipt.pending) { txEvent({ id, address, state: receipt.status === 'success' ? 'confirmed' : 'reverted', hash }); return; }
    }
  })();
  tradesInFlight++; post({ t: 'busy', v: true }); txEvent({ id, address, state: 'preparing' });
  try {
    return await tradeGuard<Result>(`${side}:${token}:${address}`, () => ({ name: account.name, address, ok: false, error: 'Trade already pending', state: 'not_started' }), async () => {
      try {
        const result = await solTerminalTrade(account, { side, token, size, envelope: r.envelope, serialized: r.serialized as string }, settings,
          () => tradeLimits(side, size, settings, 1));
        txEvent({ id, address, state: 'submitted', hash: result.hash }); scheduleWatch(1500);
        return { ret: { name: account.name, address, ok: true, hash: result.hash, state: 'submitted' }, landed: follow(result.hash) };
      } catch (error) {
        const e = error as { unknown?: boolean; hash?: string; message?: string };
        const hash = e.unknown && e.hash ? e.hash : undefined, state = e.unknown ? 'unknown' as const : 'not_started' as const;
        txEvent({ id, address, state, error: e.message || 'Terminal trade refused', ...(hash ? { hash } : {}) });
        return { ret: { name: account.name, address, ok: false, error: e.message || 'Terminal trade refused', state, ...(hash ? { hash } : {}) }, landed: hash ? follow(hash) : null };
      }
    });
  } finally { tradesInFlight--; post({ t: 'busy', v: tradesInFlight > 0 }); }
}

// Separate policy-authorized EVM lane. No caller-provided raw signing method.
async function terminalTradeEvm(request: unknown) {
  const key = CFG.key;
  const pinned = key === 'robinhood' || key === 'bsc' ? TERMINAL_EVM_POLICY?.[key] : null;
  // PONS-V2: both the engine constant and the reviewed policy must enable Pons; otherwise the venue stays refused.
  const policy = pinned ? (TERMINAL_EVM_PONS_V2 ? pinned : { ...pinned, ponsV2: undefined }) : null;
  if (SOL_MODE || NEAR_MODE || !policy || policy.chainId !== chain.id) throw new Error('Terminal EVM execution is not enabled');
  if (!request || typeof request !== 'object') throw new Error('Invalid terminal EVM request');
  const r = structuredClone(request) as Record<string, unknown>;
  if (Object.keys(r).some(k => !(TERMINAL_FEE_POLICY ? ['walletId', 'side', 'token', 'size', 'transaction', 'route', 'feePolicy'] : ['walletId', 'side', 'token', 'size', 'transaction', 'route']).includes(k)) ||
    typeof r.walletId !== 'string' || !['buy', 'sell'].includes(String(r.side)) || typeof r.token !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(r.token) || typeof r.size !== 'number') throw new Error('Invalid terminal EVM intent');
  const side = r.side as 'buy' | 'sell', token = r.token as `0x${string}`, size = r.size;
  const bad = tradeSizeProblem(side, size, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);
  const s = tradeSettings(undefined);
  if (s.turbo || mevOn(s) || !Number.isFinite(s.gasBoost) || s.gasBoost < 1 || s.gasBoost > 5) throw new Error('Terminal candidate requires ordinary public execution with bounded gas');
  if (!Number.isSafeInteger(policy.finalityBlocks) || policy.finalityBlocks < 1 || BigInt(policy.maxGas) <= 0n || BigInt(policy.maxGasPrice) <= 0n || BigInt(policy.maxGasCost) <= 0n) throw new Error('Invalid terminal execution deployment limits');
  if (TERMINAL_FEE_POLICY) {
    const collector = TERMINAL_FEE_POLICY.collectors?.[key as 'robinhood' | 'bsc'];
    if (!collector || collector !== String(policy.feeRecipient).toLowerCase()) throw new Error('Terminal fee collector is not configured for this chain');
  }
  keepHot();
  const own = requireUnlocked().find(a => a.id === r.walletId);
  if (!own || own.archived || own.hop || own.ext || !own.key) throw new Error('Own active EVM wallet required');
  const account = accountOf(own), address = account.address, id = clickId(undefined);
  // Existing rel12 has no trade 2FA action. This new lane explicitly uses the transfer gate.
  await gate('transfer');
  tradesInFlight++; post({ t: 'busy', v: true }); txEvent({ id, address, state: 'preparing' });
  try {
    return await tradeGuard<Result>(`${side}:${token}:${address}`, () => ({ name: own.name, address, ok: false, error: 'Trade already pending', state: 'not_started' }), async () => {
      return laneLock(address, async () => {
        const journal = await openEvmClaims({ name: `motion-terminal-evm-${chain.id}-${policy.router.toLowerCase()}`,
          verifyFinal: row => verifyEvmFinality({ client: publicClient, chainId: policy.chainId, row, confirmations: policy.finalityBlocks }) });
        let claimId: string | null = null;
        try {
          const held = await journal.pending(address);
          if (held) {
            await journal.reconcile(held.id);
            if ((await journal.get(held.id))?.status === 'idle') await journal.cancelIdle(held.id); // prior approval finalized; old quote stays consumed
            if (await journal.pending(address)) throw new Error('Previous terminal transaction is unresolved; no new signature will be made');
          }
          const balance = side === 'sell' ? await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }) : 0n;
          const rawSell = side === 'buy' ? 0n : balance * BigInt(Math.round(size * 100)) / 10000n;
          // four.meme accepts sells only in 1e9-base-unit multiples; quantize only when that venue is enabled (flag off: unchanged).
          const fourOn = key === 'bsc' && TERMINAL_EVM_BNB_VENUES.includes('four') && (r.route as { type?: unknown } | null)?.type === 'four';
          const amount = side === 'buy' ? parseEther(String(size)) : fourOn ? rawSell / FOUR_SELL_QUANTUM * FOUR_SELL_QUANTUM : rawSell;
          if (amount <= 0n) throw new Error('No positive terminal input');
          const intent = { trader: address, token, side, amount: amount.toString(), slippageBps: Math.round(s.slippage * 100) };
          const check = () => verifyTerminalEvm({ config: policy, client: publicClient, transaction: r.transaction, route: r.route, intent, bnbVenues: TERMINAL_EVM_BNB_VENUES });
          let verified = await check();
          if (TERMINAL_FEE_POLICY) {
            // The router-verified quote must carry exactly the rate of a valid per-trade fee policy (else the standard rate).
            const decision = terminalFeeDecision(r.feePolicy, { ed25519, pinned: TERMINAL_FEE_POLICY, chain: key as 'robinhood' | 'bsc',
              trader: address.toLowerCase(), side, token: token.toLowerCase(), amount: amount.toString(), seen: FEE_POLICY_SEEN });
            assertQuoteMatchesDecision(decision, { pinned: TERMINAL_FEE_POLICY, quoteBps: Number(verified.quote.motionFeeBps),
              reservation: verified.claim.reservation, quoteIssuedAtMs: Number(verified.quote.issuedAt) * 1000 });
            if (decision.nonce) FEE_POLICY_SEEN!.add(decision.nonce, decision.expiresAtMs!);
          }
          await tradeLimits(side, size, s, 1);
          verified = await check(); // dialogs cannot silently extend receipt validity
          if (!await journal.claim(verified.claim)) throw new Error('Terminal receipt, reservation or nonce is already consumed');
          claimId = verified.claim.id;
          const sendExact = async (tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }, phase: 'approve-zero' | 'approve-exact' | 'swap') => {
            await check();
            const [gasPrice, estimate, nonce, funds] = await Promise.all([feeFor(s.gasBoost), publicClient.estimateGas({ account: address, ...tx }), nextNonce(address, true), publicClient.getBalance({ address })]);
            const gas = (estimate * 125n + 99n) / 100n;
            if (gas > BigInt(policy.maxGas) || gasPrice > BigInt(policy.maxGasPrice) || gas * gasPrice > BigInt(policy.maxGasCost) ||
              (CFG.maxGasPrice && gasPrice > CFG.maxGasPrice * 5n) || (CFG.maxFeeWei && gas * gasPrice > CFG.maxFeeWei) || funds < tx.value + gas * gasPrice) throw new Error('Terminal gas or balance guard refused');
            await check();
            if (Math.floor(Date.now() / 1000) >= verified.quote.deadline) throw new Error('Terminal receipt expired before signing');
            const raw = await account.signTransaction({ ...tx, chainId: chain.id, nonce, gas, gasPrice, type: 'legacy' } as any);
            if (Math.floor(Date.now() / 1000) >= verified.quote.deadline) throw new Error('Terminal receipt expired during signing; nothing broadcast');
            const hash = keccak256(raw);
            await journal.signed(claimId!, hash, phase); // durable BEFORE first broadcast
            noteNonceUsed(address, nonce);
            try { const sent = await broadcast(raw, 0, false, { from: address, nonce }); if (sent !== hash) throw new Error('Broadcast hash mismatch'); }
            catch { throw Object.assign(new Error('Terminal send outcome is unknown; do not resubmit'), { name: 'TerminalEvmUnknown', unknown: true, hash }); }
            return hash;
          };
          const approve = async (amount: bigint, phase: 'approve-zero' | 'approve-exact') => {
            const hash = await sendExact(exactTerminalApproval(verified, amount), phase);
            const rc = await publicClient.waitForTransactionReceipt({ hash, confirmations: policy.finalityBlocks, timeout: 30000, pollingInterval: 500 });
            await journal.reconcile(claimId!);
            if (rc.status !== 'success' || (await journal.get(claimId!))?.status !== 'idle') throw new Error('Exact terminal approval did not finalize');
            const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [address, policy.router] });
            if (allowance !== amount) throw new Error('Token did not retain the exact terminal allowance');
          };
          if (verified.approval) {
            const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [address, policy.router] });
            if (allowance !== amount) { if (allowance !== 0n) await approve(0n, 'approve-zero'); await approve(amount, 'approve-exact'); }
          }
          verified = await check();
          await simulateTerminalEvm({ client: publicClient, verified, config: policy });
          const hash = await sendExact(verified.transaction, 'swap');
          txEvent({ id, address, state: 'submitted', hash }); scheduleWatch(1500);
          const landed = watchReceipt(hash, id, address).finally(async () => { try { await journal.reconcile(claimId!); } finally { journal.close(); } });
          return { ret: { name: own.name, address, ok: true, hash, state: 'submitted' as TxState }, landed };
        } catch (error) {
          const saved = claimId ? await journal.get(claimId) : null;
          if (claimId && saved?.status === 'idle') await journal.cancelIdle(claimId);
          const uncertain = saved?.status === 'signed', hash = uncertain ? saved?.hash as `0x${string}` : undefined;
          journal.close();
          const state = uncertain ? 'unknown' as const : 'not_started' as const;
          const message = uncertain && saved?.phase !== 'swap' ? `Approval outcome unknown; the swap was not sent. ${shortError(error)}` : shortError(error);
          txEvent({ id, address, state, error: message, ...(hash ? { hash } : {}) });
          return { ret: { name: own.name, address, ok: false, error: message, state, ...(hash ? { hash } : {}) }, landed: hash && saved?.phase === 'swap' ? watchReceipt(hash, id, address) : null };
        }
      });
    });
  } finally { tradesInFlight--; post({ t: 'busy', v: tradesInFlight > 0 }); }
}
