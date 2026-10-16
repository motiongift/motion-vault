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
import { createPublicClient, createWalletClient, defineChain, http, fallback, parseEther, formatEther, formatUnits, toFunctionSelector, encodeFunctionData, multicall3Abi, keccak256, recoverMessageAddress, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey, toAccount } from 'viem/accounts';
import { NEAR_ACCT, nearAccountId, nearSecretKey, nearRoute, nearTradeOne, nearPreviewOne, nearBalancesFor, nearTokenBalancesFor, nearTransfer, nearReceipt, nearPrewarm, nearTokenMeta, setNearRpcs, NEAR_DEFAULT_RPCS } from './nearEngine';
import { SOL_ADDR, solAddressOf, solSecretKey, solSignText, solBridgeDeposit, RELAY_SOL_CHAIN, solRoute, solTradeOne, solPreviewOne, solBalancesFor, solTokenBalancesFor, solTransfer, solReceipt, solTokenMeta, SolSendUnknown, setSolRpcs, setSolApiBase } from './solEngine';
import { BRIDGE_CHAINS, bridgeBalances, bridgeDeposit, bridgeSend, bridgeReceipt, type BridgeQuoteLite } from './bridgeEngine';
import {
  bootVault, resetVault, openWith, lostBlobs, unrecovered, webLocker, KEY_LOCK, LOST_PREFIX, type Boot, type KeyStore, type LostBlob,
  bytesHex, seedOfSignature, fingerprint, subKeyV1, subKeyV2With, MAIN_MSG,
  openProfile, buildProfile, storageHealth, backupNudge, type Profile, type ProfileEntry, type BackupWallet, type OpenedWallet,
} from './vaultRecovery';
import {
  UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, PERMIT2, PERMIT2_ABI, MAX_UINT160, MAX_UINT48, V4_QUOTER, V4_QUOTER_ABI, NATIVE_CURRENCY,
  encodeV4BuyNative, encodeV4BuyViaPath, encodeV4BuyViaWeth, encodeV4Sell, encodeV4SellViaPath, encodeV3Path, v4PairCurrency, type V4PoolKey, KNOWN_LAUNCHER_HOOKS,
} from './evmV4Router';
import { STANDARD, STANDARD_ROUTER_ABI, STANDARD_FACTORY_ABI, STANDARD_CURVE_ABI, V4_QUOTER_PATH_ABI, NO_FEE, standardPath, encodeStandardSwap, sameHop, type StdHop } from './standardRouter';
import {
  BSC, FOUR_MANAGER_ABI, FOUR_HELPER_ABI, FLAP_PORTAL_ABI, PANCAKE_V2_ROUTER_ABI, CL_QUOTER_ABI, V3_QUOTER_ABI,
  encodeInfBuyNative, encodeInfBuyViaPath, encodeInfBuyViaWrapped, encodeInfSell, encodeInfSellViaPath, infPairCurrency, type InfPoolKey,
} from './bnbRouter';

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
  },
  bsc: {
    id: BSC.id, key: 'bsc', name: 'BNB Chain', symbol: 'BNB', rpc: BSC.rpc, rpc2: BSC.rpc2, rpcSingle: BSC.rpcSingle, explorer: BSC.explorer, wrapped: BSC.wrapped, stable: BSC.stable,
    v3Router: BSC.v3Router, v2Router: BSC.v2Router, universalRouter: BSC.universalRouter, permit2: BSC.permit2,
    ponsFactory: '0x78eae9537c0ef90dfe9b7ae964682fe8138afe31',   // genius.fun (Pons V2 family)
    fourManager: BSC.fourManager, fourHelper: BSC.fourHelper, flapPortal: BSC.flapPortal, infPoolManager: BSC.clPoolManager,
    knownHooks: ['0xff17f41c5efd6cce944af0912f300097d62df5c9'],   // genius.fun Infinity hook
    // WBNB, USDT, USDC, USD1, BTCB, ETH — what a bridge leg may pass through on the way to a quote asset
    bridgeTokens: [BSC.wrapped, BSC.stable, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8'],
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
const broadcastUrls = () => [...new Set([...sendOnlyUrls, ...readUrls()])];
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
const mkTransport = (urls: string[], batch: boolean) => fallback(urls.map((u) => http(u, { ...(batch && u !== CFG.rpcSingle ? { batch: { wait: 16 } } : {}), timeout: RPC_TIMEOUT })), { rank: false, retryCount: 1, retryDelay: 200 });
let transport = mkTransport(readUrls(), true);
let publicClient = createPublicClient({ chain, transport });
let heavy = createPublicClient({ chain, transport: mkTransport(readUrls(), false) });
// The per-wallet heavy calls of one click (eth_estimateGas, router simulations)
// are spread three wallets per node, each node keeping the others as fallback:
// publicnode served 6 parallel estimates of one click with 4×429 under load
// (measured 2026-10-14; the fallback then cost +100-300 ms), while 2-3 per node
// never tripped a limit. Only on the default nodes — a user's own paid primary
// takes the whole burst.
const mkHeavyRing = () => { const u = readUrls(); return u.map((_, i) => createPublicClient({ chain, transport: mkTransport([...u.slice(i), ...u.slice(0, i)], false) })); };
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
type SendError = Error & { txState?: TxState; hash?: `0x${string}`; nonce?: number };
let lastBroadcastNode = '';   // the node that accepted the last signed transaction first (for the timing report)
async function broadcast(raw: `0x${string}`, round = 0, lostBefore = false): Promise<`0x${string}`> {
  const errors: string[] = [];
  const local = keccak256(raw);   // the transaction's own hash: what a node that "already knows" it is holding
  const attempts = broadcastUrls().map((u) => ({ u, p: (async () => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }), signal: AbortSignal.timeout(8000) }).then((x) => x.json());
    if (r?.result) return r.result as `0x${string}`;
    const msg = String(r?.error?.message || 'no result');
    // a node that already has it (from a faster sibling, or from the first round) holds it: that is a success
    if (/already known|known transaction|already imported/i.test(msg)) return local;
    errors.push(msg); throw new Error(msg);
  })() }));
  // first fulfilled wins; only when every node refused does the send fail (Promise.any, spelled out for the lib target)
  return new Promise((resolve, reject) => {
    let left = attempts.length, won = false;
    for (const { u, p } of attempts) p.then((h) => { if (!won) { won = true; lastBroadcastNode = u.replace(/^https:\/\//, ''); } resolve(h); }, (e: Error) => { if (!errors.includes(e?.message)) errors.push(String(e?.message || e)); if (--left === 0) {
      const verdict = errors.find((x) => !THROTTLED.test(x)) || errors[0] || 'broadcast failed';
      const throttled = errors.length > 0 && errors.every((x) => THROTTLED.test(x));
      const lost = lostBefore || errors.some((x) => LOST.test(x));
      if (round < 2 && throttled) { setTimeout(() => broadcast(raw, round + 1, lost).then(resolve, reject), (round === 0 ? 250 : 900) + Math.floor(Math.random() * 250)); return; }
      // An answer lost in flight (a timeout, a dropped socket) in either round means a node may hold the
      // transaction: round 1's 429s say nothing about round 0's lost answers. Unknown, with its hash — never
      // "refused" (which invites the press that would buy twice). A nonce verdict goes to the hash lookup instead.
      if (lost && (throttled || !/nonce|underpriced|known/i.test(verdict))) { reject(Object.assign(new Error(`Broadcast outcome unknown (${verdict.slice(0, 60)}) — check the explorer before trying again`), { txState: 'unknown' as TxState, hash: local })); return; }
      reject(Object.assign(new Error(verdict), { txState: 'signed' as TxState, hash: local }));
    } });
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
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.n;
  const inflight = nonceReads.get(k);
  if (inflight && !fresh) return inflight;
  const asked = Date.now();
  const p = publicClient.getTransactionCount({ address, blockTag: 'pending' }).then((n) => {
    // a send accepted while this read was in flight (a prewarm read racing a click) has already moved the
    // counter past what the node counted: keep the higher one, or the next send re-signs after "nonce too low"
    const now = nonces.get(k); const v = !fresh && now && now.at >= asked ? Math.max(n, now.n) : n;
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
      const n = Number(BigInt(x.result)); const now = nonces.get(lc(a));
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
      // signed by the account itself: wallet.signTransaction asks the node for eth_chainId on every signature
      // just to compare it with the chain this frame pins (one round trip, 60-120 ms, measured) — the chain id
      // signed in is chain.id either way, so a node on another chain still cannot replay it. Same bytes.
      // A Privy wallet signs on the page (remoteSign): this is the stage that shows it.
      const { account: _a, chain: _c, ...body } = prepared as Record<string, unknown>;
      const raw = await account.signTransaction({ ...body, account, chainId: chain.id } as any);
      const t2 = performance.now();
      clock?.note('signed');
      let hash: `0x${string}`;
      try { hash = await broadcast(raw); } catch (e) { throw Object.assign(e as SendError, { nonce }); }
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
async function landed(hash: `0x${string}`, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (let i = 0; ; i += 1) {
    const r = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (r) return r;
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
type Account = { id: string; name: string; address: `0x${string}`; key: `0x${string}`; createdAt: number; archived?: boolean; hop?: boolean; ext?: 'privy'; main?: string; index?: number; gen?: 2; kind?: 'created' | 'imported' };
// account: the last profile the server confirmed (vault-client → mainPublished) and which addresses it covers
// removedAddrs: wallets removed here on a trusted click — a publish does not carry them back into the profile
// mergedBlobs / recoveryDismissed: set-aside vaults already merged back, and missing wallets the user chose to forget
type VaultMeta = { activeAccountId: string | null; selectedAccountIds: string[]; order: string[]; changedAt?: number; backedUpAt?: number; main?: string | null; walletAddedAt?: number; account?: { main: string; at: number; addrs: string[]; digest: string } | null; removedAddrs?: string[]; mergedBlobs?: string[]; recoveryDismissed?: string[] };
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
let seeds: Record<string, string> = {};          // main address (lower) → 32-byte seed hex, from one signature of that main
let storagePersisted = false;
let storageEstimate: { quota?: number; usage?: number } | null = null;
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
  for (const a of disk.accounts) if (!removedIds.has(a.id) && !unlocked.some((x) => x.id === a.id)) unlocked.push(a);
  for (const id of disk.meta.order) if (!meta.order.includes(id) && unlocked.some((x) => x.id === id)) meta.order.push(id);
  for (const [m, sd] of Object.entries(disk.seeds || {})) if (!seeds[m]) seeds[m] = sd;
}
let persisting: Promise<void> = Promise.resolve();
let replacing = false;                       // the first write of a vault that replaces a set-aside one (inside the key lock)
function persist() { persisting = persisting.then(persistNow, persistNow); return persisting; }
async function persistNow() {
  if (!unlocked || !cryptoKey) throw new Error(keyMissing ? KEY_MISSING_MSG : 'Vault not ready');
  // Never write over a vault this key cannot open. Another tab may have started over (a new key, its own
  // vault): if the key store's key opens what is on disk now, this tab switches to it and its wallets join
  // that vault; otherwise nothing is written.
  const disk = readVault();
  if (disk && disk.ct && !replacing && !(await openWith(cryptoKey, disk))) {
    const now = await idbGet('vault').catch(() => undefined);
    if (now && (await openWith(now, disk))) cryptoKey = now;
    else throw new Error('The stored vault is under another key — this tab did not overwrite it. Reload the page.');
  }
  await mergeFromDisk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const own = unlocked.filter((a) => !a.ext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, cryptoKey, buf(enc.encode(JSON.stringify(own)))));
  meta.order = [...meta.order.filter((id) => unlocked!.some((a) => a.id === id)), ...unlocked.filter((a) => !meta.order.includes(a.id)).map((a) => a.id)];
  const siv = crypto.getRandomValues(new Uint8Array(12));
  const sct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(siv) }, cryptoKey, buf(enc.encode(JSON.stringify(seeds)))));
  const next: StoredVault = { v: 2, iv: b64(iv), ct: b64(ct), siv: b64(siv), sct: b64(sct), meta, addresses: own.map((a) => ({ id: a.id, name: a.name, address: a.address, archived: !!a.archived, hop: !!a.hop })) };
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
const commitFresh = async (b: { key: CryptoKey }) => { cryptoKey = b.key; unlocked = []; seeds = {}; meta = freshMeta(); keyMissing = null; replacing = true; try { await persistNow(); } finally { replacing = false; } };
async function openBoot(b: Boot) {
  if (b.state === 'keymissing') {
    unlocked = null; cryptoKey = null; seeds = {};
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
  if (!b.created && !b.aside) { unlocked = b.accounts as unknown as Account[]; seeds = b.seeds; meta = Object.assign(freshMeta(), (b.meta as VaultMeta) || {}); }
  await mergeLostBlobs();
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
const missingWallets = () => (keyMissing || !unlocked ? [] : unrecovered(lostNow(), unlocked.map((a) => a.address), meta.recoveryDismissed || []));
// how much room the browser says is left (it discards whole origins when the disk fills up)
function checkStorage() { navigator.storage?.estimate?.().then((e) => { storageEstimate = { quota: e.quota, usage: e.usage }; pushBackupState(); }).catch(() => {}); }
setInterval(checkStorage, 10 * 60_000);
const ordered = (list: Account[]) => [...list].sort((a, b) => { const ia = meta.order.indexOf(a.id), ib = meta.order.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
const summary = () => {
  const stored = readVault();
  const list = unlocked ? ordered(unlocked).map((a) => ({ id: a.id, name: a.name, address: SOL_MODE ? (solAddressOf(a) || a.address) : NEAR_MODE ? (nearAccountId(a) || a.address) : a.address, evm: a.address, sol: solAddressOf(a), near: nearAccountId(a), archived: !!a.archived, hop: !!a.hop, ext: a.ext || '', main: a.main || '', index: a.index ?? null })) : (stored?.addresses || []);
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
  const list = unlocked || [];
  const re = new RegExp('^' + kind + ' (\\d+)$');
  let n = 0;
  for (const a of list) { const m = re.exec(a.name); if (m) n = Math.max(n, Number(m[1])); }
  return `${kind} ${n + 1}`;
}
async function addAccount(name: string, key: `0x${string}`, opts: { hop?: boolean; main?: string; index?: number; gen?: 2; kind?: 'created' | 'imported'; createdAt?: number; archived?: boolean } = {}) {
  const list = requireUnlocked();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('key must be 0x + 64 hex');
  const acct = privateKeyToAccount(key);
  if (list.some((a) => a.address.toLowerCase() === acct.address.toLowerCase())) throw new Error('Wallet already in the vault');
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  list.push({ id, name: name || nextName('Created'), address: acct.address, key, createdAt: opts.createdAt || Date.now(), ...(opts.hop ? { hop: true } : {}), ...(opts.archived ? { archived: true } : {}), ...(opts.main ? { main: lc(opts.main), index: opts.index } : {}), ...(opts.gen === 2 ? { gen: 2 as const } : {}), ...(opts.kind ? { kind: opts.kind } : {}) });
  // a hop wallet is plumbing: it never becomes the primary and never joins batch trades
  if (!opts.hop && !opts.archived) {
    if (!meta.activeAccountId) meta.activeAccountId = id;
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
// profiles handed to the page to save, by digest: the server's confirmation (mainPublished) names one of them
const pendingPublish = new Map<string, { main: string; addrs: string[] }>();
const subKey = subKeyV1;
const subsOf = (main: string) => (unlocked || []).filter((a) => a.main === lc(main) && a.index != null && a.index >= 0);
// what the account profile can re-derive on another device from the count alone: v1 trading wallets only
const subsV1Of = (main: string) => subsOf(main).filter((a) => a.gen !== 2);
// what rides in the profile sealed (backup v3): every other wallet that has a key here — created, imported, v2, hop
const kindOf = (a: Account): BackupWallet['kind'] => (a.hop ? 'hop' : a.main && a.index != null ? 'derived' : a.kind || (/^Imported \d+$/.test(a.name) ? 'imported' : 'created'));
const backupWalletsOf = (main: string): BackupWallet[] => (unlocked || [])
  .filter((a) => !a.ext && /^0x[0-9a-fA-F]{64}$/.test(a.key) && !(a.main === lc(main) && a.index != null && a.gen !== 2))
  .sort((x, y) => Number(!!x.hop) - Number(!!y.hop) || Number(!!x.archived) - Number(!!y.archived))
  .map((a) => ({ address: a.address, name: a.name, key: a.key, kind: kindOf(a), ...(a.main && a.index != null ? { main: a.main, index: a.index } : {}), ...(a.gen === 2 ? { gen: 2 as const } : {}), ...(a.archived ? { archived: true } : {}), createdAt: a.createdAt }));
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
      feeCache = { floor, at: Date.now() };
      return floor;
    } finally { feeInflight = null; }
  })();
  return feeInflight;
}
async function feeFor(boost = 1): Promise<bigint> {
  const floor = await feeFloor();
  return (floor * BigInt(Math.round(Math.max(1, boost) * 100))) / 100n;
}
// While a trader is on a page (prewarm was called in the last minute) the fee
// stays fresh and every broadcast node gets a cheap ping every 20 s, so the TLS
// session is open and a click never pays a handshake.
let hotUntil = 0;
setInterval(() => {
  if (Date.now() > hotUntil) return;
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
  const gasPrice = await feeFor(1);
  let value = amountWei === 'max' ? (await publicClient.getBalance({ address: account.address })) - gasPrice * 21_000n - GAS_RESERVE : amountWei;
  if (value <= 0n) throw new Error('Nothing to send after gas');
  // through the wallet's send lane: the nonce comes from the shared counter, so a transfer between two trades does not leave the next trade signing a used nonce
  return signAndSend(client, account, { to, value }, gasPrice, 21_000n);
}
async function wrap(id: string, amountWei: bigint) { const { account, client } = walletFor(id); const gasPrice = await feeFor(1); const sim = await publicClient.simulateContract({ account, address: WETH, abi: WETH_ABI, functionName: 'deposit', value: amountWei, gasPrice }); return sendCall(client, account, sim.request, gasPrice); }
async function unwrap(id: string, amountWei: bigint) { const { account, client } = walletFor(id); const gasPrice = await feeFor(1); const sim = await publicClient.simulateContract({ account, address: WETH, abi: WETH_ABI, functionName: 'withdraw', args: [amountWei], gasPrice }); return sendCall(client, account, sim.request, gasPrice); }   // the lane's nonce: an unwrap behind a sell must not poison the next sell's counter

// ── settings ──
type RpcPick = { primary?: string; secondary?: string; send?: string[] };
type Settings = { slippage: number; gasBoost: number; turbo: boolean; rpcs?: Record<string, RpcPick>; solTip?: number; solPriority?: number; sendPool?: number };
const loadSettings = (): Settings => { try { return { slippage: 12, gasBoost: 1.5, turbo: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { slippage: 12, gasBoost: 1.5, turbo: false }; } };
const saveSettings = (s: Partial<Settings>) => { const next = { ...loadSettings(), ...s }; next.solTip = Math.min(0.1, Math.max(0, Number(next.solTip) || 0)); next.solPriority = Math.min(10_000_000, Math.max(0, Math.floor(Number(next.solPriority) || 0))); next.slippage = Math.min(100, Math.max(0.1, Number(next.slippage) || 12)); next.gasBoost = Math.min(5, Math.max(1, Number(next.gasBoost) || 1)); { const sp = Math.floor(Number(next.sendPool)); if (sp >= 1) next.sendPool = Math.min(25, sp); else delete next.sendPool; }
  if (next.rpcs && typeof next.rpcs === 'object') for (const k of Object.keys(next.rpcs)) { const v = next.rpcs[k] || {}; next.rpcs[k] = { ...(isRpcUrl(v.primary) ? { primary: v.primary } : {}), ...(isRpcUrl(v.secondary) ? { secondary: v.secondary } : {}), ...(Array.isArray(v.send) && v.send.filter(isRpcUrl).length ? { send: [...new Set(v.send.filter(isRpcUrl))].slice(0, 3) } : {}) }; }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); return next; };
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
  | ({ type: 'inf'; poolKey: InfPoolKey; pair: 'native' | 'weth' | 'other'; quoteToken: `0x${string}` } & Bridge);
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
const PONS_GET_LAUNCHED = toFunctionSelector('function getLaunchedToken(address)');
const FLAP_GET_TOKEN_V8 = '0xf1159a49';
const padAddr = (a: string) => lc(a).slice(2).padStart(64, '0');
const wordAddr = (data: string, i: number) => '0x' + data.slice(2 + 64 * i + 24, 2 + 64 * (i + 1)).toLowerCase();
const wordInt = (data: string, i: number) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const rawCall = async (to: `0x${string}`, data: `0x${string}`) => (await publicClient.call({ to, data })).data || '0x';
const reject = (why: string): never => { throw new Error(`Route rejected: ${why}`); };
async function checkRoute(token: `0x${string}`, route: Route): Promise<void> {
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
    quote = route.quoteToken;
  } else if (route.type === 'v4') {
    const pk = route.poolKey; const cs = [lc(pk.currency0), lc(pk.currency1)];
    if (!cs.includes(lc(token))) reject('V4 pool does not contain this token');
    const other = cs[0] === lc(token) ? cs[1] : cs[0];
    if (route.quoteToken && !same(route.quoteToken, other)) reject('V4 quote asset is not in the pool');
    if (!KNOWN_HOOKS.has(lc(pk.hooks)) && !same(pk.hooks, ZERO) && !knownQuote(other)) reject('V4 pool has an unknown hook and an unknown quote asset');
    quote = other;
  } else if (route.type === 'inf') {
    const pk = route.poolKey; const cs = [lc(pk.currency0), lc(pk.currency1)];
    if (!CFG.infPoolManager || !same(pk.poolManager, CFG.infPoolManager)) reject('not the PancakeSwap Infinity pool manager');
    if (!cs.includes(lc(token))) reject('Infinity pool does not contain this token');
    const other = cs[0] === lc(token) ? cs[1] : cs[0];
    if (!same(route.quoteToken, other)) reject('Infinity quote asset is not in the pool');
    if (!KNOWN_HOOKS.has(lc(pk.hooks)) && !same(pk.hooks, ZERO) && !knownQuote(other)) reject('Infinity pool has an unknown hook and an unknown quote asset');
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
const routeCache = new Map<string, { at: number; p: Promise<Route> }>();
const ROUTE_TTL = 8_000;
async function routeFor(token: string, hint?: unknown): Promise<Route> {
  const key = lc(token);
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_TTL && !hint) return hit.p;
  const p = (async () => {
    // In the vault frame the indexer is not reachable at all (its CSP allows
    // the RPC nodes and nothing else): the page passes the proposal in, and
    // verifyRoute() below checks every contract on chain before anything is signed.
    const j = hint && typeof hint === 'object' ? (hint as { ok?: boolean; route?: unknown; error?: string }) : HOST ? null
      : await fetch(`/api/token/${key}/route`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (!j?.ok || !j.route) throw new Error(j?.error || 'No executable market for this token');
    // a route from another chain's indexer must never be signed here
    if (j.route.chainId && Number(j.route.chainId) !== CFG.id) throw new Error(`This market is on chain ${j.route.chainId}; the terminal is connected to ${CFG.name}`);
    const route = j.route as Route;
    verifyRoute(key as `0x${string}`, route).catch(() => {});   // starts now, awaited before the first write
    return route;
  })();
  routeCache.set(key, { at: Date.now(), p });
  p.catch(() => routeCache.delete(key));
  return p;
}

// A sell has to let the venue pull the token first: an ERC-20 approve for the
// curve or the V3 router, and for V4 an approve to Permit2 plus a Permit2
// allowance for the Universal Router. Done at sell time that is two extra
// transactions and two receipts — which is exactly why a sell used to take far
// longer than a buy. So the moment a buy lands we arm the sell path in the
// background, for the maximum amount, once per wallet+token+venue.
const MAX_UINT256 = (1n << 256n) - 1n;
const armed = new Set<string>();
async function armSellPath(acct: Account, token: `0x${string}`, route: Route, attempt = 0, idx = 0) {
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
  const account = accountOf(acct);
  // the click as this wallet sees it: shared reads, plus its own stage clock and transaction states
  const shared = click.view(account.address);
  const wallet = createWalletClient({ account, chain, transport });
  // this wallet's node for its own heavy calls (estimate, per-wallet router simulations): spread, see heavyFor
  const hv = heavyFor(Math.max(0, shared.addresses.findIndex((a) => same(a, account.address))));
  const slippageBps = BigInt(Math.round(s.slippage * 100));
  const applySlippage = (q: bigint) => (q * (10_000n - slippageBps)) / 10_000n;
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
  const send = async (req: any) => { shared.mark('quote', performance.now() - tQuote - (shared.t.gas || 0)); return sendCall(wallet, account, req, gasPrice, s.turbo ? 900_000n : req.gas, shared); };
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
  const sellAmount = (bal: bigint) => (bal * BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100))) / 10_000n;
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
  { const t0 = performance.now(); await verifyRoute(token, route); shared.mark('verify', performance.now() - t0); }   // resolved long ago after a prewarm; overlapped the balance read otherwise
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
        const lh = await sendCall(wallet, account, leg.request, gasPrice, s.turbo ? 900_000n : (leg.request as any).gas, shared);
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
      const req = await sim({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'buy', args: [pairAmount, applySlippage(headroom(quoted)), account.address], value: nativePair ? pairAmount : undefined });
      return send(req.request);
    }
    const quoted = afterTax((quoteReserve * amountIn) / (tokenReserve + amountIn));
    if (quoted <= 0n) throw new Error('Curve sell quote returned zero');
    await approveIfNeeded(token, route.curve, amountIn);
    const req = await sim({ address: route.curve, abi: PONS_CURVE_ABI, functionName: 'sell', args: [amountIn, applySlippage(headroom(quoted)), account.address] });
    const hash = await send(req.request);
    // the curve pays in its pair asset (NVDA, META…): swap it back to ETH so the
    // trader ends up with something spendable, not a stock they did not ask for
    if (!nativePair) {
      const bridge = bridgeOf(route, route.pairToken);
      // behind the click: the walk back starts a block after the sell lands, not on the next 4 s poll
      if (bridge) landed(hash, 90_000).then(async (r) => {
        if (r.status !== 'success') return;
        const bal = await publicClient.readContract({ address: route.pairToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
        if (bal <= 0n) return;
        await approveIfNeeded(route.pairToken, UNISWAP_V3_ROUTER, bal);
        const back = await publicClient.simulateContract({ account, address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.reverse, recipient: account.address, amountIn: bal, amountOutMinimum: 0n }] });
        // signed with the simulated output as its floor (1 %, or the user's tighter slippage), never 0
        const h2 = await send({ ...back.request, args: [{ ...back.request.args[0], amountOutMinimum: bridgeMin(back.result as bigint) }] });
        const r2 = await landed(h2, 90_000).catch(() => null);
        if (r2?.status === 'success') await unwrap(acct.id, (back.result as bigint) - (back.result as bigint) / 50n).catch(() => {});
      }).catch(() => {});
    }
    return hash;
  }
  if (route.type === 'v4') {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const pk = route.poolKey;
    const quoteV4 = (zeroForOne: boolean, exactAmount: bigint) => quoteV4Pool(pk, zeroForOne, exactAmount);
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      let quoted: bigint;
      if (route.pair === 'native') { quoted = await quoteV4(pk.currency0.toLowerCase() === NATIVE_CURRENCY, amountIn); encoded = encodeV4BuyNative(pk, token, amountIn, applySlippage(quoted)); }
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
      let quoted = await quoteV4Sell(pk.currency0.toLowerCase() === token.toLowerCase(), amountIn);
      quoted -= quoted / 100n;
      if (quoted <= 0n) throw new Error('V4 sell quote returned zero');
      const pairCurrency = v4PairCurrency(pk, token);
      if (route.pair === 'native' || route.pair === 'weth') { encoded = encodeV4Sell(pk, token, pairCurrency, amountIn, applySlippage(quoted)); }
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
    const req = await sim({ address: UNIVERSAL_ROUTER as `0x${string}`, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [encoded.commands, encoded.inputs, deadline], value: side === 'buy' ? amountIn : undefined });
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
  // …and a sell's proceeds in the quote asset back to the gas token, behind the trade
  const bridgeBack = (quote: `0x${string}`, r: Bridge, hash: `0x${string}`) => {
    const bridge = bridgeOf(r, quote);
    if (!bridge) return;
    bscReceipt(hash, 90_000).then(async (rc) => {
      if (rc.status !== 'success') return;
      const [bal, allowance] = await Promise.all([
        publicClient.readContract({ address: quote, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        publicClient.readContract({ address: quote, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, UNISWAP_V3_ROUTER] }),
      ]);
      if (bal <= 0n) return;
      const backCall = { address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ path: bridge.reverse, recipient: account.address, amountIn: bal, amountOutMinimum: 0n }] };
      let h2: `0x${string}`, got: bigint;
      // every walk back is signed with the simulated output as its floor (1 %, or the user's tighter slippage): a
      // zero floor on BSC is a free sandwich. Without a simulated output (turbo, no eth_simulateV1) there is no send.
      const floored = (got: bigint) => ({ ...backCall, args: [{ ...backCall.args[0], amountOutMinimum: bridgeMin(got) }] });
      if (allowance >= bal) {
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
      if (r2?.status === 'success' && got > 0n) await unwrap(acct.id, got - got / 50n).catch(() => {});
    }).catch(() => {});
  };
  // The sell quotes of every wallet in the click in one Multicall3 call (each
  // wallet sells its own share of its own balance, so the amounts differ): one
  // request instead of N heavy singles in a burst. A wallet whose entry is
  // missing or failed asks on its own, where the error is reported.
  const bscSellQuote = <T,>(key: string, contract: (amount: bigint) => any): Promise<T | null> => shared.once(`bsc:sq:${key}`, async () => {
    const bal = await tradeBalances(shared, 'sell', token);
    const pct = BigInt(Math.round(Math.min(100, Math.max(0.01, size)) * 100));
    const rows = shared.addresses.map((a) => ({ a: lc(a), amt: ((bal[lc(a)] ?? 0n) * pct) / 10_000n })).filter((x) => x.amt > 0n);
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
    const sellCall = { address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [token, amountIn] };
    const early = bscEstimate('sell', sellCall);   // sellToken carries no minimum: the early estimate IS the final call
    const [sq, allowance] = await Promise.all([
      bscSellQuote<readonly [string, string, bigint, bigint]>('four', (amt) => ({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amt] }))
        .then((v) => v ?? publicClient.readContract({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amountIn] })),
      bscAllowance(token, route.manager),
    ]);
    const [, , funds] = sq;
    if (funds <= 0n) throw new Error('four.meme sell quote returned zero');
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, route.manager)], sellCall, early, 'the four.meme sell');
    if (!nativeQuote) bridgeBack(route.quoteToken, route, hash);
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
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, route.portal)], sellAt(output, applySlippage(q - q / 100n)), output === ZERO ? early : null, 'the Flap sell');
    if (output.toLowerCase() !== ZERO) bridgeBack(output, route, hash);
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
    const toNative = route.path.length > 0;
    const path = (toNative ? [...route.path].reverse() : [token, route.quoteToken]) as `0x${string}`[];
    const fn = toNative ? 'swapExactTokensForETHSupportingFeeOnTransferTokens' : 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
    const sellAt = (min: bigint) => ({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: fn, args: [amountIn, min, path, account.address, dl] });
    const early = bscEstimate('sell', sellAt(0n));
    const [amounts, allowance] = await Promise.all([
      bscSellQuote<readonly bigint[]>('v2', (amt) => ({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amt, path] }))
        .then((v) => v ?? publicClient.readContract({ address: router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] })),
      bscAllowance(token, router),
    ]);
    const q = lastOf(amounts);
    if (q <= 0n) throw new Error('V2 sell quote returned zero');
    const hash = await bscSendAfter(allowance >= amountIn ? [] : [bscApprove(token, router)], sellAt(applySlippage(q - q / 100n)), early, 'the V2 sell');
    if (!toNative) bridgeBack(route.quoteToken, route, hash);
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
    const pk = route.poolKey, UR = CFG.universalRouter, P2 = CFG.permit2, dl = deadline();
    const quoteInf = (zeroForOne: boolean, exactAmount: bigint) => quoteInfPool(pk, zeroForOne, exactAmount);
    const exec = (e: { commands: `0x${string}`; inputs: `0x${string}`[] }, value?: bigint) => ({ address: UR, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, dl], value });
    let encoded: { commands: `0x${string}`; inputs: `0x${string}`[] };
    if (side === 'buy') {
      let quoted: bigint;
      if (route.pair === 'native') { quoted = await quoteInf(pk.currency0.toLowerCase() === ZERO, amountIn); encoded = encodeInfBuyNative(pk, token, amountIn, applySlippage(quoted)); }
      else if (route.pair === 'weth') { quoted = await quoteInf(pk.currency0.toLowerCase() === WETH.toLowerCase(), amountIn); encoded = encodeInfBuyViaWrapped(pk, token, WETH, amountIn, applySlippage(quoted)); }
      else {
        const bridge = bridgeOf(route, route.quoteToken);
        if (!bridge) throw new Error(`No route from ${NATIVE} to ${route.quoteSymbol || "this pool's quote asset"}`);
        const bridged = (await bridgeQuote(route.quoteToken, bridge.path, amountIn)).result;
        quoted = await quoteInf(pk.currency0.toLowerCase() === route.quoteToken.toLowerCase(), bridged);
        encoded = encodeInfBuyViaPath(pk, token, route.quoteToken, bridge.path, amountIn, applySlippage(quoted));
      }
      if (quoted <= 0n) throw new Error('Infinity quote returned zero');
      const hash = await bscSendAfter([], exec(encoded, amountIn), bscEstimate('buy', bscBuyProbe(amountIn)), 'the Infinity buy');
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
    let [quoted, approvals] = await Promise.all([
      bscSellQuote<readonly [bigint, bigint]>('inf', (amt) => ({ address: BSC.clQuoter, abi: CL_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: pk, zeroForOne, exactAmount: amt, hookData: '0x' }] }))
        .then((v) => (v ? v[0] : quoteInf(zeroForOne, amountIn))),
      Promise.all([bscAllowance(token, P2), bscPermit2(token)]).then(([a, [p2Amount, p2Expiry]]) => [
        ...(a < amountIn ? [bscApprove(token, P2)] : []),
        ...(p2Amount < amountIn || BigInt(p2Expiry) <= BigInt(Math.floor(Date.now() / 1000)) ? [{ address: P2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, UR, MAX_UINT160, Number(MAX_UINT48)] }] : []),
      ]),
    ]);
    quoted -= quoted / 100n;
    if (quoted <= 0n) throw new Error('Infinity sell quote returned zero');
    if (direct) encoded = encodeInfSell(pk, token, pairCurrency, amountIn, applySlippage(quoted));
    else {
      const minBridge = applySlippage(quoted);
      // the BNB leg's floor: the V3 quoter on the walk back (a simulation from this wallet, which holds none of
      // the quote asset yet, always reverted and the floor went out as 0 — on a chain with sandwich bots)
      const out = await v3BackOut(pairCurrency, bridge!.reverse, bridge!.path, minBridge);
      if (!(out > 0n)) throw new Error(`Could not price the ${route.quoteSymbol || 'quote asset'} → ${NATIVE} leg — not sent without a floor`);
      encoded = encodeInfSellViaPath(pk, token, pairCurrency, bridge!.reverse, amountIn, minBridge, applySlippage(out), account.address);
    }
    return bscSendAfter(approvals, exec(encoded), early, 'the Infinity sell');
  }
  // Uniswap V3 (Varo). A pool quoted in a tokenised stock is still reachable
  // from ETH: one exactInput hops ETH → quote → token (and back on a sell), so
  // it stays a single transaction.
  if (route.quoteToken.toLowerCase() !== WETH.toLowerCase()) {
    const bridge = bridgeOf(route, route.quoteToken);
    if (!bridge) throw new Error(`No route from ETH to ${route.quoteSymbol || 'this pool\'s quote asset'}`);
    const path = side === 'buy' ? encodeV3Path([...bridge.hops, token], [...bridge.fees, route.fee])
      : encodeV3Path([token, ...[...bridge.hops].reverse()], [route.fee, ...[...bridge.fees].reverse()]);
    const base = { path, recipient: account.address, amountIn, amountOutMinimum: 0n };
    const quoted = (await quoteV3Path(path, amountIn, side === 'buy')).result;
    if (quoted <= 0n) throw new Error('V3 quote returned zero');
    if (side === 'sell') await approveIfNeeded(token, UNISWAP_V3_ROUTER, amountIn);
    const bridged = await sim({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: [{ ...base, amountOutMinimum: applySlippage(quoted) }], value: side === 'buy' ? amountIn : undefined });
    const hash = await send(bridged.request);
    // a sell lands in WETH: unwrap it behind the trade so the wallet holds ETH
    if (side === 'sell') landed(hash, 90_000).then((r) => { if (r.status === 'success') unwrap(acct.id, quoted).catch(() => {}); }).catch(() => {});
    return hash;
  }
  const tokenIn = side === 'buy' ? WETH : token, tokenOut = side === 'buy' ? token : route.quoteToken;
  const args = v3SingleArgs(tokenIn, tokenOut, route.fee, amountIn);
  const q = await quoteV3Single(tokenIn, tokenOut, route.fee, amountIn, side === 'buy');
  if (side === 'sell') await approveIfNeeded(token, UNISWAP_V3_ROUTER, amountIn);
  const req = await sim({ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [{ ...args, amountOutMinimum: applySlippage(q.result) }], value: side === 'buy' ? amountIn : undefined });
  return send(req.request);
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
    const [, , funds] = await publicClient.readContract({ address: route.helper, abi: FOUR_HELPER_ABI, functionName: 'trySell', args: [token, amountIn] });
    quoted(funds, route.quoteDecimals || 18);
    if (await needsAllowance(route.manager)) return out;
    return run({ address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [token, amountIn] });
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
    const s = loadSettings(); const t0 = performance.now();
    const route = await solRoute(token, hint);
    const previews = await Promise.all(targets.map((a) => solPreviewOne(a, side, route, size, s)));
    return { ok: true, ms: Math.round(performance.now() - t0), route: 'sol-' + route.venue, slippage: s.slippage, previews };
  }
  if (NEAR_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = loadSettings(); const t0 = performance.now();
    const route = await nearRoute(token, hint);
    const previews = await Promise.all(targets.map((a) => nearPreviewOne(a, side, route, size, s.slippage).catch((e) => ({ name: a.name, address: nearAccountId(a) || a.address, side, venue: 'Rhea DCL', contract: ZERO, method: '', amountIn: size, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0, gas: 0, gasPriceGwei: 0, gasEth: 0, balanceEth: 0, funded: false, error: shortError(e) })))) as unknown as Preview[];
    return { ok: true, ms: Math.round(performance.now() - t0), route: 'near-dcl', slippage: s.slippage, previews };
  }
  const addr = token.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('Invalid token address');
  const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
  const targets = list.filter((a) => ids.includes(a.id));
  if (!targets.length) throw new Error('No wallet selected');
  const s = loadSettings();
  const t0 = performance.now();
  const route = await routeFor(addr, hint);
  const previews = await Promise.all(targets.map(async (a) => {
    try { return await previewOne(a, side, addr, size, route, s); }
    catch (e) { return { name: a.name, address: a.address, side, venue: route.type, contract: ZERO, method: '', amountIn: size, amountInLabel: '', expected: 0, min: 0, pricePerToken: 0, gas: 0, gasPriceGwei: 0, gasEth: 0, balanceEth: 0, funded: false, simulated: 'failed', error: shortError(e), notes: [] } as Preview; }
  }));
  return { ok: true, ms: Math.round(performance.now() - t0), route: route.type, slippage: s.slippage, previews };
}
// receipt for a hash the engine broadcast: "sent" is not "landed"
async function receipt(hash: string) {
  if (SOL_MODE) return solReceipt(hash);
  if (NEAR_MODE) return nearReceipt(hash);
  const w = receipts.get(lc(hash));
  if (w?.r) return { ok: true, pending: false, state: w.r.status === 'success' ? 'confirmed' : 'reverted', ...w.r };
  if (w) return { ok: true, pending: true, state: 'pending' };   // the watcher is on it: no second poll of the node
  const r = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
  if (!r) return { ok: true, pending: true, state: 'pending' };
  return { ok: true, pending: false, state: r.status === 'success' ? 'confirmed' : 'reverted', status: r.status, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), feeEth: Number(formatEther(r.gasUsed * r.effectiveGasPrice)) };
}
let tradesInFlight = 0;   // a page must not navigate away while a trade is being signed and broadcast here
// ── trade ceilings, decided here ──
// Any script on the page can call buy(): without a ceiling it could buy 100 ETH per wallet at 100 % slippage into its
// own pool. Two limits the frame keeps on its own storage, written only behind a trusted click in its dialogs:
// a buy above the per-wallet cap asks once (that buy), and a slippage setting above 22 % asks once (then it is
// remembered up to that value). Inside them nothing is asked — normal trading pays no extra step.
const LIMITS_KEY = 'trenches.engine.limits';
const CAP_DEFAULT: Record<string, number> = { robinhood: 1, bsc: 5, sol: 25, near: 1000 };
const SLIP_FREE = 22;
const laneKey = () => (SOL_MODE ? 'sol' : NEAR_MODE ? 'near' : CFG.key);
const laneUnit = () => (SOL_MODE ? 'SOL' : NEAR_MODE ? 'NEAR' : NATIVE);
type Limits = { cap?: Record<string, number>; slipOk?: number };
const loadLimits = (): Limits => { try { const v = JSON.parse(localStorage.getItem(LIMITS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const saveLimits = (l: Limits) => { try { localStorage.setItem(LIMITS_KEY, JSON.stringify(l)); } catch {} };
const buyCap = () => { const v = Number(loadLimits().cap?.[laneKey()]); return v > 0 ? v : CAP_DEFAULT[laneKey()] ?? 1; };
async function tradeLimits(side: 'buy' | 'sell', size: number, s: Settings) {
  const slip = Number(s.slippage) || 0;
  if (slip > SLIP_FREE && slip > (Number(loadLimits().slipOk) || SLIP_FREE)) {
    const ok = await ask({ title: 'High slippage', danger: true, ok: `Trade at ${slip}%`, html: `<p>Slippage is set to <b>${escHtml(slip)}%</b>: a trade may fill at up to ${escHtml(slip)}% worse than quoted.</p><p class="dlg-note">Confirm once; trades at this setting or lower will not ask again. A script on the page cannot click this button.</p>` });
    if (!ok) throw new Error('Cancelled: slippage above 22% needs one confirmation in the vault');
    saveLimits({ ...loadLimits(), slipOk: slip });
  }
  if (side === 'buy' && size > buyCap()) {
    const ok = await ask({ title: 'Large buy', danger: true, ok: `Buy ${size} ${laneUnit()}`, html: `<p>Buy <b>${escHtml(size)} ${laneUnit()}</b> per wallet — above your per-wallet cap of ${escHtml(buyCap())} ${laneUnit()}.</p><p class="dlg-note">The cap is in Settings (raising it asks here too). A script on the page cannot click this button.</p>` });
    if (!ok) throw new Error(`Cancelled: ${size} ${laneUnit()} is above the per-wallet cap`);
  }
}
async function trade(side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown, opts?: unknown) {
  tradesInFlight += 1; post({ t: 'busy', v: true });
  try { await tradeLimits(side, Number(size), loadSettings()); return await tradeInner(side, token, size, accountIds, hint, opts); } finally { tradesInFlight -= 1; post({ t: 'busy', v: tradesInFlight > 0 }); }
}
async function tradeInner(side: 'buy' | 'sell', token: string, size: number, accountIds?: string[], hint?: unknown, opts?: unknown) {
  keepHot();
  const list = requireUnlocked();
  if (SOL_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = loadSettings(); const t0 = performance.now();
    // the same per-wallet states, double-press guard and outcome as the EVM path ('trench:tx' events, keyed by the
    // wallet's Solana address); a send no node acknowledged is 'unknown' with its signature, followed, never re-sent
    const id = clickId(opts); const solOf = (a: Account) => solAddressOf(a) || a.address;
    for (const a of targets) txEvent({ id, address: solOf(a), state: 'preparing' });
    let route: Awaited<ReturnType<typeof solRoute>>;
    try { route = await solRoute(token, hint); }
    catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: solOf(a), state: 'not_started', error }); throw e; }
    const follow = (hash: string, address: string) => { (async () => { for (let i = 0; i < 90; i++) { await new Promise((ok) => setTimeout(ok, i < 20 ? 700 : 1500)); const r = await solReceipt(hash).catch(() => null); if (r && !r.pending) { txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash, ...(r.error ? { error: r.error } : {}) }); return; } } })(); };
    const results: Result[] = await pooled(targets, poolSize('sol'), async (a) => {
      const address = solOf(a); const key = `${side}:${token}:${address}`;
      if (inFlight.has(key)) { const error = `A ${side} of this token from this wallet is still being sent`; txEvent({ id, address, state: 'not_started', error }); return { name: a.name, address, ok: false, error, state: 'not_started' as TxState }; }
      inFlight.add(key);
      try { const { hash } = await solTradeOne(a, side, route, size, s); txEvent({ id, address, state: 'submitted', hash }); follow(hash, address); return { name: a.name, address, ok: true, hash, state: 'submitted' as TxState }; }
      catch (e) {
        const error = shortError(e); const unknown = e instanceof SolSendUnknown && e.hash ? e.hash : '';
        const state: TxState = unknown ? 'unknown' : 'not_started';
        txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) }); if (unknown) follow(unknown, address);
        return { name: a.name, address, ok: false, error, state, ...(unknown ? { hash: unknown } : {}) };
      } finally { inFlight.delete(key); }
    });
    scheduleWatch(1500);
    const sent = results.filter((x) => x.ok).length;
    return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'sol-' + route.venue, timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };
  }
  if (NEAR_MODE) {
    const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
    const targets = list.filter((a) => ids.includes(a.id));
    if (!targets.length) throw new Error('No wallet selected');
    const s = loadSettings(); const t0 = performance.now();
    const route = await nearRoute(token, hint);
    const results: Result[] = await pooled(targets, poolSize('near'), async (a) => {
      const address = nearAccountId(a) || a.address;
      // one trade per wallet+token+side in flight, as on the EVM lanes (a double press used to send twice here)
      const key = `near:${side}:${lc(token)}:${address}`;
      if (inFlight.has(key)) return { name: a.name, address, ok: false, error: `A ${side} of this token from this wallet is still being sent`, state: 'not_started' as TxState };
      inFlight.add(key);
      try { const { hash } = await nearTradeOne(a, side, route, size, s.slippage); return { name: a.name, address, ok: true, hash, state: 'submitted' as TxState }; }
      catch (e) { return { name: a.name, address, ok: false, error: shortError(e), state: 'not_started' as TxState }; }
      finally { inFlight.delete(key); }
    });
    scheduleWatch(1200);
    return { ok: true, ms: Math.round(performance.now() - t0), results, route: 'near-dcl', timing: null };
  }
  const addr = token.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('Invalid token address');
  const ids = accountIds?.length ? accountIds : meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
  const targets = list.filter((a) => ids.includes(a.id));
  if (!targets.length) throw new Error('No wallet selected');
  const s = loadSettings();
  const t0 = performance.now();
  const id = clickId(opts);
  for (const a of targets) txEvent({ id, address: a.address, state: 'preparing' });
  let route: Route;
  try { route = await routeFor(addr, hint); }
  catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: a.address, state: 'not_started', error }); throw e; }
  const shared = makeShared(targets.map((a) => a.address), id);   // one quote, one balance sheet for the whole click
  shared.mark('route', performance.now() - t0);
  const pool = poolSize('evm');
  // the wallets past the first batch get their nonces in a few JSON-RPC batches of 10 while the first batch works
  // (one getTransactionCount per wallet was a burst of 50: the primary refused the batch, the fallback then took
  // 50 single requests at once — every one a 429, measured); a wallet a batch could not answer reads its own later
  if (targets.length > pool) nonceSheet(targets.slice(pool).map((a) => a.address)).catch(() => {});
  const results: Result[] = await pooled(targets, pool, async (a, idx) => {
    const key = `${side}:${addr}:${lc(a.address)}`;
    if (inFlight.has(key)) { const error = `A ${side} of this token from this wallet is still being sent`; txEvent({ id, address: a.address, state: 'not_started', error }); return { name: a.name, address: a.address, ok: false, error, state: 'not_started' as TxState }; }
    inFlight.add(key);
    const log = () => shared.w[lc(a.address)];
    try {
      const hash = await tradeOne(a, side, addr, size, route, s, shared);
      const landedP = watchReceipt(hash, id, a.address);
      // the buy is on its way; arm the sell path behind it so selling is one tx
      // polled every block (not viem's 4 s): the wallet is armed ~0.3 s after its buy lands instead of 5-30 s, so a quick sell finds nothing to approve
      // (the same receipt poll that feeds the page's states — one poll per hash, not two)
      if (side === 'buy') landedP.then((r) => { if (r?.status === 'success') armSellPath(a, addr, route, 0, idx); }).catch(() => {});
      return { name: a.name, address: a.address, ok: true, hash, state: 'submitted' as TxState, txs: log()?.txs || [], stages: log()?.stages || {} };
    } catch (e) {
      const err = e as SendError; const error = shortError(e);
      // a failure before any signature is not_started; a refused signature stays signed; unknown keeps its hash so the page can follow it
      const state: TxState = err.txState || 'not_started';
      if (state === 'unknown' && err.hash) watchReceipt(err.hash, id, a.address);
      if (!err.txState) txEvent({ id, address: a.address, state, error });
      return { name: a.name, address: a.address, ok: false, error, state, ...(state === 'unknown' && err.hash ? { hash: err.hash } : {}), txs: log()?.txs || [], stages: log()?.stages || {} };
    } finally { inFlight.delete(key); }
  });
  // Stage clock of the click, in ms, slowest wallet per stage: route (hint -> verified route object),
  // balances (fee + balance + reserves, one batch), verify (route check, 0 after a prewarm), quote
  // (venue quote(s) not hidden behind the balance read), gas (eth_estimateGas), nonce (wait for the
  // nonce, 0 when cached), sign (local key: ms; Privy wallet: the page/Privy round trip), broadcast
  // (first node to accept), approve (an unarmed sell's approvals incl. their receipts, 0 when armed),
  // total; node = the node that accepted first; wallets = count; mode.
  const t = shared.t;
  const timing = { route: t.route ?? 0, balances: t.balances ?? 0, verify: t.verify ?? 0, quote: t.quote ?? 0, gas: t.gas ?? 0, approve: t.approve ?? 0, nonce: t.nonce ?? 0, sign: t.sign ?? 0, broadcast: t.broadcast ?? 0, total: Math.round(performance.now() - t0), wallets: targets.length, node: lastBroadcastNode, mode: s.turbo ? 'turbo' : 'fast', privy: targets.some((a) => !!a.ext) };
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
// viem puts the revert reason on the second line ("…reverted with the following reason:\nAS"): keep it, and spell out
// the terse Uniswap V3 codes a trader would otherwise stare at
const REASONS: Record<string, string> = { AS: 'AS — the V3 leg got no input amount', STF: 'STF — token transfer failed (tax or blocked transfer?)', 'Too little received': 'Too little received — slippage', SPL: 'SPL — price limit hit', IIA: 'IIA — insufficient input amount' };
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
type LegStatus = 'queued' | 'waiting' | 'sent' | 'confirmed' | 'failed' | 'skipped';
type Leg = { id: string; from: `0x${string}`; to: `0x${string}`; amount: string | 'max'; asset: Asset; status: LegStatus; hash?: `0x${string}`; error?: string; after?: string; notBefore?: number; hop?: boolean; sentAt?: number; doneAt?: number; human?: number; nonce?: number };
type Job = { id: string; label: string; createdAt: number; status: 'running' | 'done' | 'failed' | 'cancelled'; hops: number; delay: [number, number]; legs: Leg[]; hopIds: string[]; asset: Asset };
type MoveSpec = { fromIds: string[]; toIds?: string[]; toAddresses?: string[]; asset: Asset; amount: { mode: 'fixed' | 'pct'; value: number; per: 'source' | 'dest' }; hops?: number; delay?: [number, number]; label?: string };
const JOBS_KEY = 'trenches.jobs';
const ETH_GAS = 21_000n, ERC20_GAS = 80_000n, MAX_HOPS = 4;
const readJobs = (): Job[] => { try { return JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch { return []; } };
const jobs: Job[] = readJobs();
let isRunner = false;
const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('trenches-jobs') : null;
const running = new Set<string>();           // leg ids in flight
const emitJobs = () => document.dispatchEvent(new CustomEvent('trench:jobs', { detail: jobs.map((j) => ({ ...j, legs: j.legs.map((l) => ({ ...l })) })) }));
const saveJobs = () => { try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(-60))); } catch {} emitJobs(); };
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
    navigator.locks.request('trenches-jobs-runner', { steal: true }, async () => { await becomeRunner(); await new Promise(() => {}); }).catch(() => { takingOver = false; });
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

async function planMove(spec: MoveSpec) {
  const list = requireUnlocked();
  const sources = spec.fromIds.map((id) => list.find((a) => a.id === id)).filter(Boolean) as Account[];
  const dests = [
    ...(spec.toIds || []).map((id) => list.find((a) => a.id === id)).filter(Boolean).map((a) => ({ address: a!.address, name: a!.name, id: a!.id })),
    ...(spec.toAddresses || []).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).map((x) => ({ address: x as `0x${string}`, name: 'external', id: '' })),
  ];
  const errors: string[] = [], warnings: string[] = [];
  if (!sources.length) errors.push('Pick at least one source wallet');
  if (!dests.length) errors.push('Pick at least one destination');
  const hops = Math.max(0, Math.min(MAX_HOPS, Math.floor(spec.hops || 0)));
  if (hops && spec.asset.kind !== 'eth') errors.push('Stealth routing moves ETH only — a token would need every hop funded with gas first');
  for (const s of sources) if (dests.some((d) => d.address.toLowerCase() === s.address.toLowerCase())) errors.push(`${s.name} is on both sides`);
  const gasPrice = await feeFor(1);
  const legGas = gasCostWei(gasPrice, spec.asset);
  const asset = spec.asset;
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
    else if (bal < need) row.error = `needs ${humanOf(need, asset).toFixed(asset.kind === 'eth' ? 5 : 2)} ${asset.kind === 'eth' ? 'ETH' : asset.symbol}, has ${row.balance.toFixed(asset.kind === 'eth' ? 5 : 2)}`;
    else if (asset.kind !== 'eth' && ethBal < gasOut) row.error = `needs ${Number(formatEther(gasOut)).toFixed(5)} ETH for gas`;
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
  const out = { ok: !errors.length && legs.length > 0, planId, kind, label, errors, warnings, sources: perSource, dests, legs, hops, delay: spec.delay || [15, 60], asset, total: totalHuman, gasEth, gasPriceGwei: Number(gasPrice) / 1e9 };
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
  requireUnlocked();
  if (!isRunner && !fromBus) { await ensureRunner().catch(() => {}); }
  if (!isRunner && !fromBus) { const r = await askRunner({ cmd: 'start', plan }).catch(() => null); if (r) return { ok: true, id: r.id }; }
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
  const job: Job = { id: jid('j'), label: plan.label, createdAt: Date.now(), status: 'running', hops: plan.hops, delay: plan.delay, legs: plan.legs, hopIds, asset: plan.asset };
  jobs.push(job); saveJobs();
  if (isRunner) tickJob(job);            // otherwise the runner adopts it from the storage event
  return { ok: true, id: job.id };
}
// failed and skipped legs go back to the queue; a leg that was broadcast is never sent twice
function retryJob(id: string): any {
  const job = jobs.find((j) => j.id === id); if (!job) throw new Error('Unknown job');
  if (!isRunner) return ensureRunner().then((mine) => (mine ? retryJob(id) : askRunner({ cmd: 'retry', id })));
  for (const l of job.legs) if ((l.status === 'failed' && !(l.hash && l.error !== 'dropped before mining')) || l.status === 'skipped') { l.status = 'queued'; delete l.error; delete l.hash; delete l.notBefore; }
  job.status = 'running';
  saveJobs();
  tickJob(job);
  return { ok: true };
}
const terminal = (s: LegStatus) => s === 'confirmed' || s === 'failed' || s === 'skipped';
function tickJob(job: Job) {
  if (job.status === 'done' || job.status === 'failed') return;
  const byId = new Map(job.legs.map((l) => [l.id, l]));
  for (const leg of job.legs) {
    if (leg.status === 'failed' || leg.status === 'skipped') { for (const d of job.legs) if (d.after === leg.id && !terminal(d.status)) { d.status = 'skipped'; d.error = 'previous hop did not land'; } }
  }
  const inFlightFrom = new Set(job.legs.filter((l) => running.has(l.id)).map((l) => l.from.toLowerCase()));
  for (const leg of job.legs) {
    if (terminal(leg.status) || running.has(leg.id)) continue;
    if (leg.status === 'sent' && leg.hash) { running.add(leg.id); settleLeg(job, leg); continue; }
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
async function sendLeg(job: Job, leg: Leg) {
  try {
    // hop legs and the final delivery pause a random while, so the chain does not read as one burst
    if (leg.after) {
      if (!leg.notBefore) { const [a, b] = job.delay; leg.notBefore = Date.now() + Math.round((a + Math.random() * Math.max(0, b - a)) * 1000); }
      if (Date.now() < leg.notBefore) { leg.status = 'waiting'; saveJobs(); await new Promise((r) => setTimeout(r, leg.notBefore! - Date.now())); }
      if (leg.status !== 'waiting' && leg.status !== 'queued') { running.delete(leg.id); tickJob(job); return; }   // cancelled while pausing
    }
    const acct = unlocked?.find((a) => a.address.toLowerCase() === leg.from.toLowerCase());
    if (!acct) throw new Error('source wallet is not in this vault');
    if (!HOST && !leg.hop && !confirmedJobs.has(job.id) && !isOwn(leg.to)) throw new Error('an outside leg of a job this tab did not confirm — start the move again');
    const account = accountOf(acct);
    const client = createWalletClient({ account, chain, transport });
    const gasPrice = await feeFor(1);
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    leg.nonce = nonce;
    let hash: `0x${string}`;
    if (leg.asset.kind === 'eth') {
      const bal = await publicClient.getBalance({ address: account.address });
      const value = leg.amount === 'max' ? bal - gasPrice * ETH_GAS : BigInt(leg.amount);
      if (value <= 0n) throw new Error('nothing left after gas');
      if (bal < value + gasPrice * ETH_GAS) throw new Error(`insufficient ETH: has ${Number(formatEther(bal)).toFixed(5)}, needs ${Number(formatEther(value + gasPrice * ETH_GAS)).toFixed(5)}`);
      leg.human = Number(formatEther(value));
      hash = await client.sendTransaction({ to: leg.to, value, gas: ETH_GAS, gasPrice, nonce });
    } else {
      const bal = await publicClient.readContract({ address: leg.asset.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
      const value = leg.amount === 'max' ? bal : BigInt(leg.amount);
      if (value <= 0n || bal < value) throw new Error(`insufficient ${leg.asset.symbol}`);
      leg.human = humanOf(value, leg.asset);
      const sim = await publicClient.simulateContract({ account, address: leg.asset.address, abi: ERC20_ABI, functionName: 'transfer', args: [leg.to, value], gasPrice });
      hash = await client.writeContract({ ...sim.request, nonce });
    }
    noteNonceUsed(account.address, nonce);   // a move signs with the node's nonce: the trade lanes' counter steps past it, or the next trade from this wallet re-signs after "nonce too low"
    leg.hash = hash; leg.status = 'sent'; leg.sentAt = Date.now(); saveJobs();
    await settleLeg(job, leg);
  } catch (e) {
    leg.status = 'failed'; leg.error = shortError(e); leg.doneAt = Date.now(); running.delete(leg.id); saveJobs();
    scheduleWatch(50);
    tickJob(job);
  }
}
async function settleLeg(job: Job, leg: Leg) {
  try {
    const r = await publicClient.waitForTransactionReceipt({ hash: leg.hash!, timeout: 180_000, pollingInterval: 1000 });
    leg.status = r.status === 'success' ? 'confirmed' : 'failed';
    if (r.status !== 'success') leg.error = 'reverted on chain';
  } catch (e) {
    // no receipt. If the wallet's nonce moved past this transaction it will never mine
    // (dropped / replaced): the funds never left, so the leg fails and can be retried.
    const mined = await publicClient.getTransactionCount({ address: leg.from, blockTag: 'latest' }).catch(() => -1);
    const gone = leg.nonce != null && mined > leg.nonce && !(await publicClient.getTransactionReceipt({ hash: leg.hash! }).catch(() => null));
    if (gone) { leg.status = 'failed'; leg.error = 'dropped before mining'; leg.doneAt = Date.now(); running.delete(leg.id); saveJobs(); tickJob(job); return; }
    running.delete(leg.id); saveJobs();
    setTimeout(() => tickJob(job), 5000);
    return;
  }
  leg.doneAt = Date.now(); running.delete(leg.id); saveJobs();
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
  for (const l of job.legs) if (l.status === 'queued' || l.status === 'waiting') { l.status = 'skipped'; l.error = 'cancelled'; }
  job.status = 'cancelled';
  saveJobs();
  tickJob(job);
  return { ok: true };
}
// Exactly one tab drives the legs. Web Locks hands the role to the next tab
// the moment the holder closes, and that tab resumes every running job from
// storage — money in flight is never orphaned by a closed tab.
async function becomeRunner() {
  isRunner = true;
  jobs.splice(0, jobs.length, ...readJobs());
  await mergeFromDisk().catch(() => {});
  for (const j of jobs) if (j.status === 'running' || j.status === 'cancelled') tickJob(j);
  emitJobs();
}
ready.then(() => {
  emitJobs();
  if (typeof navigator !== 'undefined' && navigator.locks) navigator.locks.request('trenches-jobs-runner', async () => { await becomeRunner(); await new Promise(() => {}); });
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
type AskOpts = { title: string; html: string; ok: string; danger?: boolean; cancel?: boolean; cancelLabel?: string; size?: 'sm' | 'md' | 'lg'; copy?: string; plain?: boolean; foot?: string; choices?: AskChoice[]; validate?: (root: HTMLElement, choice: string) => Promise<string | null> | string | null; stay?: (root: HTMLElement, btn: HTMLButtonElement) => boolean; mount?: (root: HTMLElement) => void };
function ask(o: AskOpts): Promise<boolean> { return askChoice(o).then((v) => v === 'ok'); }
// the same dialog with several confirm buttons (the recovery screen): each one is a trusted click on a visible dialog; resolves to its id, or null
function askChoice(o: AskOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div'); wrap.className = 'dlg-wrap';
    const buttons = o.choices?.length
      ? o.choices.map((c) => `<button class="dlg-btn${c.primary ? ' primary' : ''}${c.danger ? ' danger' : ''}" data-ok="${escHtml(c.id)}">${escHtml(c.label)}</button>`).join('')
      : `<button class="dlg-btn primary${o.danger ? ' danger' : ''}" data-ok>${escHtml(o.ok)}</button>`;
    // the width is a class: the frame's CSP (style-src 'self') ignores inline style attributes, an inline width left the dialog full-window
    wrap.innerHTML = `<div class="dlg w-${o.size || 'md'}${o.plain ? ' plain' : ''}${o.choices?.length ? ' multi' : ''}" role="dialog"><div class="dlg-h"><h3>${escHtml(o.title)}</h3><button class="dlg-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="dlg-b">${o.html}<div class="dlg-err" hidden></div></div><div class="dlg-f">${o.cancel === false ? '' : `<button class="dlg-btn" data-no>${escHtml(o.cancelLabel || 'Cancel')}</button>`}${buttons}${o.foot || ''}</div></div>`;
    const dlg = wrap.querySelector('.dlg') as HTMLElement;
    try { o.mount?.(dlg); } catch {}
    const err = wrap.querySelector('.dlg-err') as HTMLElement;
    let visible = true, io: IntersectionObserver | null = null;
    dialogsOpen += 1; post({ t: 'dialog', open: true });
    const close = (v: string | null) => {
      wrap.remove(); document.removeEventListener('keydown', onKey); io?.disconnect();
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
        for (let i = 0; HOST && !visible && i < 8; i += 1) await new Promise((r) => setTimeout(r, 100));   // the observer reports with a delay: give it a reading or two
        if (HOST && !visible) { fail('The vault dialog is covered or off screen — bring it into view and click again.'); return; }
        if (o.validate) { const m = await o.validate(dlg, choice); if (m) { fail(m); return; } }
        if (o.stay && o.stay(dlg, okBtn)) return;   // e.g. the key was just revealed in place; the same button now closes
        close(choice); return;
      }
      const c = t.closest('[data-copy]') as HTMLElement | null;
      const val = c ? c.dataset.copy || o.copy : '';
      if (c && val && e.isTrusted) {
        copyText(val);
        if (c.classList.contains('pk-cp')) { c.classList.add('ok'); setTimeout(() => c.classList.remove('ok'), 1200); }
        else { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); }
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    if (HOST && 'IntersectionObserver' in window) {
      try { io = new IntersectionObserver((es) => { for (const en of es) if ('isVisible' in en) visible = (en as IntersectionObserverEntry & { isVisible: boolean }).isVisible; }, { threshold: [0, 0.5, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit); io.observe(dlg); } catch {}
    }
  });
}
const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const PK_WARN = '<div class="pk-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg><span>WARNING: Your private key grants complete control over this wallet. NEVER SHARE IT WITH ANYONE. Store it securely.</span></div>';
// The key is not even in the document until the button is clicked: what shows
// behind the blur is a row of dots, and the copy icon copies nothing before that.
const pkBox = (value: string, opts: { copy?: string; key?: boolean; title: string }) => `<div class="pk-box"><span class="pk-v${opts.key ? ' pk-key blur' : ''}"${opts.key ? ' data-key' : ''}>${escHtml(value)}</span><button class="pk-cp"${opts.copy ? ` data-copy="${escHtml(opts.copy)}"` : opts.key ? ' data-copy-key' : ''} title="${escHtml(opts.title)}">${COPY_SVG}</button></div>`;
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
  const list = requireUnlocked();
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
  const list = requireUnlocked();
  let added = 0;
  for (const [m, sd] of Object.entries(src.seeds || {})) if (/^0x[0-9a-f]{40}$/.test(m) && /^0x[0-9a-f]{64}$/.test(String(sd)) && !seeds[m]) seeds[m] = String(sd);
  // the salts of the device that wrote the backup: its v2 profile blobs open here too (ours stays ours)
  adoptSalts(Object.entries(src.seeds || {}).filter(([k]) => k === SALT || k.startsWith(SALT + ':')).map(([, sd]) => String(sd)));
  for (const a of src.accounts || []) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(a.key || ''))) continue;
    const acct = privateKeyToAccount(a.key);
    if (list.some((x) => same(x.address, acct.address))) continue;
    const id = a.id && !list.some((x) => x.id === a.id) ? a.id : 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.push({ id, name: String(a.name || '').trim() || nextName('Imported'), address: acct.address, key: a.key, createdAt: Number(a.createdAt) || Date.now(), ...(a.archived ? { archived: true } : {}), ...(a.hop ? { hop: true } : {}), ...(a.main && a.index != null ? { main: lc(a.main), index: Number(a.index) } : {}), ...(a.gen === 2 ? { gen: 2 as const } : {}), ...(a.kind === 'created' || a.kind === 'imported' ? { kind: a.kind } : {}) });
    if (!a.hop) { if (!meta.activeAccountId) meta.activeAccountId = id; if (!meta.selectedAccountIds.includes(id) && src.meta?.selectedAccountIds?.includes(a.id)) meta.selectedAccountIds.push(id); }
    meta.order.push(id); added += 1;
  }
  if (src.meta?.activeAccountId && list.some((x) => x.id === src.meta!.activeAccountId) && !list.some((x) => x.id === meta.activeAccountId)) meta.activeAccountId = src.meta.activeAccountId;
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
  const list = requireUnlocked().filter((a) => !a.ext); if (!list.length) throw new Error('No local wallets to back up (Privy wallets are recovered through your Privy login)');
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
  const have = (a: Account) => { try { return requireUnlocked().some((x) => same(x.address, privateKeyToAccount(a.key).address)); } catch { return false; } };
  const inFile = new Set(fromFile.map((a) => { try { return lc(privateKeyToAccount(a.key).address); } catch { return ''; } }));
  if (fileAt && fromFile.every(have) && requireUnlocked().every((x) => x.ext || inFile.has(lc(x.address)))) { meta.backedUpAt = Math.max(meta.backedUpAt || 0, Math.min(fileAt, Date.now())); await persist(); }
  pushBackupState();
  return { ok: true, added, ...summary() };
}
// ── recovery: the stored vault has no key in this browser, or wallets of a set-aside vault are not back yet ──
// Drawn by the frame; every way out is a trusted click here. Nothing in this screen deletes anything.
const addrList = (xs: { name: string; address: string }[]) => `<div class="dlg-list">${xs.slice(0, 12).map((x) => `<div><span>${escHtml(x.name || 'Wallet')}</span><code>${escHtml(x.address)}</code></div>`).join('')}${xs.length > 12 ? `<div class="more">and ${xs.length - 12} more</div>` : ''}</div>`;
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
    if (!(await ask({ title: 'Start a new empty vault?', danger: true, ok: 'Start a new vault', html: `<p>The ${plural(n, 'wallet')} above stay stored but unreadable in this browser until you restore them from your account or a backup file.</p><p class="dlg-note">Nothing is deleted. A script on the page cannot click this button.</p>` }))) return { ok: false, cancelled: true, ...summary() };
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
  return {
    ok: true, wallets: keyed.length, changedAt: meta.changedAt || 0, backedUpAt: meta.backedUpAt || 0,
    due: keyed.length > 0 && (meta.changedAt || 0) > (meta.backedUpAt || 0), persisted: storagePersisted, origin: location.origin, host: HOST,
    keyMissing: keyMissing ? { reason: keyMissing.reason, wallets: keyMissing.addresses.length, addresses: keyMissing.addresses.slice(0, 20) } : null,
    missing: missing.slice(0, 20), missingCount: missing.length,
    account: meta.account ? { main: meta.account.main, at: meta.account.at, covered: nudge.accountCovered, total: keyed.length, current: nudge.accountCurrent } : null,
    file: { at: meta.backedUpAt || 0, current: nudge.fileCurrent },
    nudge, storage,
  };
}
let lastPushed = '';
let pushTimer = 0;
function pushBackupState() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    try {
      const s = backupStateNow();
      const sig = JSON.stringify([s.keyMissing?.wallets ?? -1, s.missingCount, s.nudge.show, s.nudge.funded, s.account?.current ?? null, s.account?.covered ?? null, s.file.current, s.storage.low, s.storage.critical]);
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
// a Relay quote fetched by the vault itself for the recipient it gated (see bridgeDeposit). text/plain: no preflight;
// the terminal's origins are in this frame's connect-src for exactly these bare-JSON calls (no credential rides along)
async function ownBridgeQuote(a: { address: `0x${string}`; key?: `0x${string}`; ext?: string }, q: BridgeQuoteLite): Promise<BridgeQuoteLite> {
  const origin = Number(q?.originChainId), dest = Number(q?.destinationChainId);
  const user = origin === RELAY_SOL_CHAIN ? solAddressOf(a as never) : a.address;
  if (!user) throw new Error('No address for this wallet on the origin chain');
  if (!/^\d{1,40}$/.test(String(q?.amount || ''))) throw new Error('Bad amount');
  const base = (HOST && parentOrigin ? parentOrigin : location.origin);
  const r = await fetch(base + '/api/bridge/quote', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ user, recipient: String(q.recipient || ''), originChainId: origin, destinationChainId: dest, amount: String(q.amount) }), cache: 'no-store', signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => null);
  if (!j?.ok || !j.step || !/^0x[0-9a-fA-F]{64}$/.test(String(j.requestId || ''))) throw new Error('Relay: ' + (j?.error || 'no quote for this route'));
  const co = j.details?.currencyOut || {};
  return { requestId: String(j.requestId), originChainId: origin, destinationChainId: dest, amount: String(q.amount), recipient: String(q.recipient || ''), step: j.step, out: /^\d{1,60}$/.test(String(co.amount ?? '')) ? String(co.amount) : '', outFormatted: String(co.amountFormatted ?? '').slice(0, 40) };
}
// bind → sign: the bound quote waits here under a single-use ticket (same wallet, 90 s) so the page can file the job
// under the request id the deposit will really carry before anything is signed
const bridgeTickets = new Map<string, { id: string; bound: BridgeQuoteLite; at: number }>();
const OFF: GatePolicy = { enabled: false, gates: {}, source: 'none', at: 0 };
const cleanGates = (g: unknown) => Object.fromEntries(GATE_ACTIONS.map((k) => [k, !!(g && typeof g === 'object' && (g as Record<string, unknown>)[k])]));
let serverPolicy: GatePolicy | null = (() => { try { const p = JSON.parse(localStorage.getItem(TWOFA_KEY) || 'null'); return p && p.source === 'server' ? { enabled: !!p.enabled, gates: cleanGates(p.gates), source: 'server', at: Number(p.at) || 0, user: String(p.user || '') } : null; } catch { return null; } })();
let pagePolicy: GatePolicy | null = null;
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
  const ok = await ask({ title: 'Two-factor: a different account', danger: true, ok: 'Use this account', html: `<p>The two-factor rules this vault follows were set by the account that last logged in here. The account logged in now is a different one and ${p.enabled ? 'has its own codes' : 'asks for no codes at all'}; its codes count here only after this click.</p><p class="dlg-note">Continue only if you logged in yourself. A script on the page cannot click this button.</p>` });
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
const ownAccounts = () => requireUnlocked().filter((a) => !a.ext && /^0x[0-9a-fA-F]{64}$/.test(a.key));
const isOwn = (to: string) => ownAccounts().some((a) => (SOL_MODE ? solAddressOf(a) === to : same(NEAR_MODE ? nearAccountId(a) : a.address, to)));
// the outside path for a destination named by wallet id (distribute / consolidate / sweep): gate, then the address in a dialog
async function outsideOk(to: Account, what: string, auth?: Auth) {
  await gate('withdraw', auth);
  const ok = await ask({ title: 'Send outside the vault', danger: true, ok: 'Send', html: `<p>${what} to <b>${escHtml(to.name)}</b></p><p class="addr">${escHtml(to.address)}</p><p class="dlg-note">${to.ext ? 'A Privy wallet: its key is not in this vault.' : 'This address is not one of the vault\'s keys.'} The transfer cannot be undone.</p>` });
  if (!ok) throw new Error('Cancelled');
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
      { method: 'bridgeDeposit', does: 'pays a Relay bridge quote to its recipient', needs: ['activation', 'transfer'], outside: ['click', 'withdraw'] },
      { method: 'remove', does: 'erases a wallet key', needs: ['click'], funded: ['remove'] },
      { method: 'buy/sell', does: 'signs a verified route for a token trade', needs: [] },
      { method: 'wrap/unwrap', does: 'wraps native coin in the same wallet', needs: [] },
      { method: 'signNote', does: 'signs two fixed note formats only (callout, BGC entry)', needs: [] },
    ],
  };
}

// a move whose legs end outside the vault is confirmed on its real destinations
async function confirmOutside(plan: Plan, auth?: Auth) {
  requireUnlocked();
  const outside = [...new Set(plan.legs.filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l.to) && !isOwn(l.to)).map((l) => lc(l.to)))];
  // the 2FA gate first: between own wallets 'transfer', to anyone else 'withdraw' — then the dialog
  await gate(outside.length ? 'withdraw' : 'transfer', auth);
  if (!outside.length) return;
  // the asset and the total shown are read here: the symbol from the token contract, the sum from the legs that leave the vault
  const asset = plan.asset.kind === 'eth' ? NATIVE : String(await publicClient.readContract({ address: plan.asset.address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'tokens'));
  const nextOf = new Map(plan.legs.filter((l) => l.after).map((l) => [String(l.after), l]));
  const finalOf = (l: Leg) => { let x = l; for (let i = 0; i < MAX_HOPS + 1 && nextOf.get(x.id); i += 1) x = nextOf.get(x.id)!; return x; };
  const total = plan.legs.filter((l) => !l.after && outside.includes(lc(finalOf(l).to))).reduce((t, l) => t + (l.amount === 'max' ? 0 : humanOf(BigInt(l.amount), plan.asset)), 0);
  const ok = await ask({
    title: 'Send outside the vault', danger: true, ok: `Send ${asset}`,
    html: `<p><b>${escHtml(Number(total.toFixed(8)))} ${escHtml(asset)}</b> total${plan.hops ? ` through ${plan.hops} hop wallet${plan.hops === 1 ? '' : 's'}` : ''} to ${outside.length === 1 ? 'an address' : outside.length + ' addresses'} not in this vault:</p><div class="addr">${outside.map(escHtml).join('<br>')}</div><p class="dlg-note">Check every character. Transfers cannot be undone.</p>`,
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
//   bridgeDeposit(id, quote, auth)            Relay quote to its recipient       activation + 'transfer' | outside: click + 'withdraw'
//   remove(id, auth)                          key erased                         click | funded: + 'remove'
//   buy / sell / wrap / unwrap                trades on routes verified on chain (minOut, known venues); no gate — see trade()
//   signNote(address, message)                two fixed note formats only; never arbitrary messages, never typed data, never calldata
// Nothing here signs arbitrary calldata or an arbitrary message. restore() and
// import() put keys IN. policy() tells the page which gates are on and that
// they are enforced here; twofaPolicy() is how the page hands over its Privy
// access token (to read the server's gates) and its own view, which never wins.
const engine = {
  version: 2,
  ready,
  exists: () => true,
  locked: () => !unlocked,
  createVault, unlock, lock,
  reorder: async (ids: string[]) => { requireUnlocked(); meta.order = ids.filter((id, i) => ids.indexOf(id) === i); await persist(); return { ok: true, ...summary() }; },
  archive: async (id: string, on = true) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); a.archived = on; if (on) meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => x !== id); await persist(); return { ok: true, ...summary() }; },
  transfer: async (fromId: string, to: string, amountEth: number | 'max', auth?: Auth) => {
    const list = requireUnlocked(); const from = list.find((x) => x.id === fromId); if (!from) throw new Error('Unknown wallet');
    if (!(SOL_MODE ? SOL_ADDR.test(String(to)) : NEAR_MODE ? NEAR_ACCT.test(String(to).toLowerCase()) : /^0x[0-9a-fA-F]{40}$/.test(to))) throw new Error('Invalid address');
    if (!isOwn(to)) {
      // the only way out of the vault for native coin: the 'withdraw' gate, then a trusted click on the real address
      await gate('withdraw', auth);
      const ok = await ask({ title: 'Send outside the vault', danger: true, ok: 'Send', html: `<p>Send <b>${amountEth === 'max' ? 'the whole balance' : escHtml(amountEth) + ' ' + NATIVE}</b> from <b>${escHtml(from.name)}</b> to</p><p class="addr">${escHtml(to)}</p><p class="dlg-note">This address is not one of your wallets. The transfer cannot be undone.</p>` });
      if (!ok) throw new Error('Cancelled');
    } else await gate('transfer', auth);
    return { ok: true, hash: await sendEth(fromId, to as `0x${string}`, amountEth === 'max' ? 'max' : parseEther(String(amountEth))) };
  },
  // destinations are wallet ids resolved here, never addresses: these two cannot send outside the vault
  distribute: async (fromId: string, toIds: string[], amountEth: number, auth?: Auth) => { const list = requireUnlocked(); { const ext = toIds.map((id) => list.find((x) => x.id === id)).filter((t) => t && !isOwn(t.address)) as Account[]; if (ext.length) { for (const t of ext) await outsideOk(t, `Send <b>${escHtml(amountEth)} ${NATIVE}</b>`, auth); } else await gate('transfer', auth); } const results = []; for (const id of toIds) { const t = list.find((x) => x.id === id); if (!t) continue; try { results.push({ id, address: t.address, ok: true, hash: await sendEth(fromId, t.address, parseEther(String(amountEth))) }); } catch (e) { results.push({ id, address: t.address, ok: false, error: shortError(e) }); } } return { ok: true, results }; },
  consolidate: async (fromIds: string[], toId: string, auth?: Auth) => { const list = requireUnlocked(); const to = list.find((x) => x.id === toId); if (!to) throw new Error('Unknown target'); if (!isOwn(to.address)) await outsideOk(to, `Sweep <b>${fromIds.filter((x) => x !== toId).length}</b> wallet(s)`, auth); else await gate('transfer', auth); const results = []; for (const id of fromIds) { if (id === toId) continue; try { results.push({ id, ok: true, hash: await sendEth(id, to.address, 'max') }); } catch (e) { results.push({ id, ok: false, error: shortError(e) }); } } return { ok: true, results }; },
  wrap: async (id: string, amountEth: number) => ({ ok: true, hash: await wrap(id, parseEther(String(amountEth))) }),
  unwrap: async (id: string, amountEth: number) => ({ ok: true, hash: await unwrap(id, parseEther(String(amountEth))) }),
  wethBalances: async (addresses: string[]) => (NEAR_MODE || SOL_MODE ? Object.fromEntries(addresses.map((a) => [a.toLowerCase(), 0])) : Object.fromEntries(await Promise.all(addresses.map(async (a) => [a.toLowerCase(), Number(formatEther(await publicClient.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [a as `0x${string}`] }).catch(() => 0n)))])))),
  onChange: (f: () => void) => listeners.add(f),
  accounts: async () => summary(),
  // A plain-text attestation from one of the vault's wallets (a callout says
  // "this wallet is mine"). Only text under our own fixed heading is signed:
  // nothing that reads like a login, a permit or a typed-data hash gets past.
  signNote: async (address: string, message: string) => {
    await ready; const list = requireUnlocked(); const m = lc(address);
    const a = list.find((x) => lc(x.address) === m && !x.archived); if (!a) throw new Error('Not one of your wallets');
    const msg = String(message || '');
    // two kinds of notes only: a callout, and a BGC competition entry (proves the wallet is yours; moves nothing)
    if (!/^(copytrade\.gg callout|motion BGC entry)\n/.test(msg) || msg.length > 600 || /[\u0000-\u0008\u000b-\u001f]/.test(msg)) throw new Error('Refused: not a copytrade note');
    if (a.ext) throw new Error('The main wallet signs through Privy');
    // a BGC note naming a Solana address is also signed by that address's key, and only if it is this wallet's own
    const solLine = /\nSOL: ([1-9A-HJ-NP-Za-km-z]{32,44})(\n|$)/.exec(msg)?.[1] || '';
    if (solLine && solLine !== solAddressOf(a)) throw new Error('Refused: the SOL line names another wallet');
    return { ok: true, address: a.address, signature: await privateKeyToAccount(a.key).signMessage({ message: msg }), ...(solLine ? { sol: solLine, solSignature: solSignText(a.key, msg) } : {}) };
  },
  create: async (name?: string) => {
    await ready; requireUnlocked();
    const main = meta.main && seeds[lc(meta.main)] ? lc(meta.main) : '';
    if (main) {
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
  mainStatus: async (address: string) => { await ready; const m = lc(address); return { ok: true, attached: !!seeds[m], current: meta.main === m, subs: subsOf(m).length, cap: SUB_CAP, fp: seeds[m] ? await fingerprint(seeds[m]) : '', keyMissing: !!keyMissing }; },
  // the main is a Privy embedded wallet or the external wallet the user logged in with (MetaMask & co. sign the same text)
  mainAttach: async (src: { address: string; signature: string; expectFp?: string }) => {
    await ready; if (!HOST) throw new Error('main wallets attach in the vault frame only');
    requireUnlocked();
    const m = lc(src?.address); if (!/^0x[0-9a-f]{40}$/.test(m)) throw new Error('Bad main address');
    // the signature must be the main's own, over the fixed text — not any 65 bytes a page hands over
    const signer = await recoverMessageAddress({ message: MAIN_MSG(m), signature: String(src?.signature || '') as `0x${string}` }).catch(() => '');
    if (!same(signer, m)) throw new Error('That signature is not from this main wallet');
    // a main this vault has not worked with yet becomes the parent of every wallet created from now on: a page
    // script could attach its own (its own signature verifies too) — so the first attach of a main is a trusted click
    if (!seeds[m] && !(await ask({ title: 'Attach your main wallet', ok: 'Attach', html: `<p>Trading wallets of the main wallet</p><p class="addr">${escHtml(m)}</p><p>will be restored and new ones created under it in this browser.</p><p class="dlg-note">Attach only the wallet you logged in with. A script on the page cannot click this button.</p>` }))) throw new Error('Cancelled');
    const seed = await seedOfSignature(String(src?.signature || ''));
    const fp = await fingerprint(seed);
    // the account's profile names the fingerprint of the seed it was built with: a different signature is refused before anything is kept
    if (src.expectFp && src.expectFp !== fp) throw new Error('fingerprint mismatch: this signature does not match the one that created the account\'s trading wallets');
    if (seeds[m] && seeds[m] !== seed) throw new Error('This main wallet signed differently than before — the signature is not deterministic, trading wallets cannot be re-derived from it');
    seeds[m] = seed; meta.main = m;
    await persist();
    return { ok: true, fp, ...summary() };
  },
  mainDetach: async () => { await ready; requireUnlocked(); meta.main = null; await persist(); return { ok: true, ...summary() }; },
  // The account's profile from the server, applied: v1 trading wallets re-derived from the count, the vault salts
  // taken back, every sealed wallet (backup v3; older v2/v1 wrapped keys too) opened. Wallets that arrive here
  // and are not in the vault yet are listed in a dialog and join on a trusted click — a page that can obtain the
  // main's signature could have sealed its own key into the profile to slip it in as "ours".
  mainSync: async (src: { address: string; profile: Profile | null }) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = lc(src?.address); const seed = seeds[m]; if (!seed) throw new Error('Main wallet not attached');
    meta.main = m;
    const p = src?.profile && typeof src.profile === 'object' ? src.profile : null;
    let derived = 0, unwrapped = 0, mismatch = false, sealed = 0, declined = 0, salts = 0;
    if (p) {
      if (p.fp && p.fp !== await fingerprint(seed)) mismatch = true;
      else {
        derived = await deriveSubs(m, Number(p.count) || 0, p.names || {});
        const o = await openProfile(p, seed, saltsOf());
        salts = adoptSalts(o.salts);
        remoteCarry.set(m, o.unopened);
        sealed = o.unopened.length;
        const removed = new Set(meta.removedAddrs || []);
        const incoming: OpenedWallet[] = [];
        for (const w of o.wallets) {
          const have = requireUnlocked().find((a) => same(a.address, w.address));
          if (have) { if (w.name && have.name !== w.name) have.name = w.name; continue; }
          if (removed.has(lc(w.address))) continue;   // removed here on purpose; the profile keeps it until no device publishes it
          incoming.push(w);
        }
        if (incoming.length) {
          const ok = await ask({ title: 'Restore wallets from your account', ok: `Add ${incoming.length}`, size: 'lg', html: `<p>Your account lists ${plural(incoming.length, 'wallet')} this browser does not hold yet:</p>${addrList(incoming)}<p class="dlg-note">Add them only if you recognise every address. A script on the page cannot click this button.</p>` });
          if (ok) {
            for (const w of incoming) {
              const slotTaken = w.main && w.index != null && subsOf(w.main).some((a) => a.index === w.index);
              await addAccount(w.name || nextName(w.kind === 'imported' ? 'Imported' : 'Created'), w.key, { ...(w.kind === 'hop' ? { hop: true } : {}), ...(w.main && w.index != null && !slotTaken ? { main: w.main, index: w.index } : {}), ...(w.gen === 2 ? { gen: 2 as const } : {}), ...(w.kind === 'created' || w.kind === 'imported' ? { kind: w.kind } : {}), ...(w.archived ? { archived: true } : {}), ...(w.createdAt ? { createdAt: w.createdAt } : {}) });
              unwrapped += 1;
            }
          } else declined = incoming.length;
        }
      }
    }
    if (derived || unwrapped) meta.changedAt = Date.now();
    await persist();
    pushBackupState();
    return { ok: true, derived, unwrapped, mismatch, sealed, declined, salts, ...summary() };
  },
  // What the server keeps for this account: the v1 count and names, the vault salts and every other keyed wallet
  // sealed under the seed key (backup v3), plus whatever the server copy holds that this vault did not write
  // (another device's wallets, blobs it cannot open) — a publish never drops them. No plain key, ever.
  mainProfile: async (address: string, remote?: Profile | null) => {
    await ready; if (!HOST) throw new Error('vault frame only');
    requireUnlocked();
    const m = lc(address); const seed = seeds[m]; if (!seed) throw new Error('Main wallet not attached');
    const subs = subsV1Of(m);
    const count = subs.reduce((n, a) => Math.max(n, (a.index ?? -1) + 1), 0);
    const names: Record<string, string> = {}; for (const a of subs) names[String(a.index)] = a.name;
    const fromServer = remote && typeof remote === 'object' && lc(remote.main) === m && Array.isArray(remote.attached) ? remote.attached : [];
    const r = await buildProfile({ main: m, seed, count, names, wallets: backupWalletsOf(m), salts: saltsOf(), carry: [...fromServer, ...(remoteCarry.get(m) || [])] as ProfileEntry[], forget: meta.removedAddrs || [] });
    pendingPublish.set(r.digest, { main: m, addrs: r.covered });
    if (pendingPublish.size > 20) pendingPublish.delete(pendingPublish.keys().next().value as string);
    return { ok: true, profile: r.profile, digest: r.digest, covered: r.covered.length, dropped: r.dropped };
  },
  // the page saved that profile and the server confirmed it: the account backup now covers exactly those wallets
  mainPublished: async (src: { digest: string; updatedAt?: number }) => {
    await ready; requireUnlocked();
    const p = pendingPublish.get(String(src?.digest || '')); if (!p) return { ok: false };
    meta.account = { main: p.main, at: Math.min(Date.now(), Number(src?.updatedAt) || Date.now()), addrs: p.addrs, digest: String(src.digest) };
    await persist(); pushBackupState();
    return { ok: true };
  },
  import: async (items: { name?: string; privateKey: string }[]) => {
    const results: { ok: boolean; name?: string; error?: string }[] = [];
    await ready;
    // keys from the page: a wallet in here is "ours" for every transfer, so a script must not be able to plant one
    // (its own key, then a sweep to it). The addresses are shown in the frame and join on a trusted click.
    const shown = (Array.isArray(items) ? items : []).slice(0, 200).map((it) => { try { return { name: String(it.name || '').trim(), address: privateKeyToAccount(String(it.privateKey).trim() as `0x${string}`).address }; } catch { return null; } }).filter(Boolean) as { name: string; address: string }[];
    if (shown.length && !(await ask({ title: `Import ${shown.length} wallet${shown.length === 1 ? '' : 's'}`, ok: 'Import', html: `<p>These wallets join the vault and count as yours for transfers:</p><div class="addr">${shown.map((x) => escHtml((x.name ? x.name + ' · ' : '') + x.address)).join('<br>')}</div><p class="dlg-note">Import only keys you pasted yourself. A script on the page cannot click this button.</p>` }))) throw new Error('Cancelled');
    for (const it of items) { const name = String(it.name || '').trim() || nextName('Imported'); try { await addAccount(name, String(it.privateKey).trim() as `0x${string}`, { kind: 'imported' }); results.push({ ok: true, name }); } catch (e) { results.push({ ok: false, name, error: shortError(e) }); } }
    return { ok: true, results, ...summary() };
  },
  rename: async (id: string, name: string) => { const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet'); a.name = name.trim() || a.name; await persist(); return { ok: true, ...summary() }; },
  remove: async (id: string, auth?: Auth) => { const list = requireUnlocked(); const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Unknown wallet'); if (list[i].ext) throw new Error('Privy wallets belong to your Privy account — log out to detach them');
    // a wallet that still holds anything (native, or a token this frame has seen) is a funds loss when its key goes: the 'remove' gate applies; an empty one only needs the click
    { const addr = lc(list[i].address); const held = (ethCache[addr] || 0) > 0 || Object.values(tokenCache).some((m) => (m[addr] || 0) > 0) || (!SOL_MODE && !NEAR_MODE && (await publicClient.getBalance({ address: list[i].address }).catch(() => 0n)) > 0n); if (held) await gate('remove', auth); }
    if (!(await ask({ title: 'Remove wallet', danger: true, ok: 'Remove', html: `<p>Remove <b>${escHtml(list[i].name)}</b> (${escHtml(list[i].address)}) from the vault?</p><p class="dlg-note">Its key is erased here. Export or back it up first if it holds funds — this cannot be undone.</p>` }))) throw new Error('Cancelled'); if (list[i].hop && (await publicClient.getBalance({ address: list[i].address }).catch(() => 0n)) > 0n) throw new Error('This hop wallet still holds ETH — sweep it first'); removedIds.add(id); meta.removedAddrs = [...(meta.removedAddrs || []).filter((x) => x !== lc(list[i].address)), lc(list[i].address)].slice(-500); list.splice(i, 1); meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => x !== id); if (meta.activeAccountId === id) meta.activeAccountId = list[0]?.id || null; await persist(); return { ok: true, ...summary() }; },
  setActive: async (id: string) => { requireUnlocked(); meta.activeAccountId = id; await persist(); return { ok: true, ...summary() }; },
  setSelected: async (ids: string[]) => { const list = requireUnlocked(); meta.selectedAccountIds = ids.filter((id) => list.some((a) => a.id === id)); await persist(); return { ok: true, ...summary() }; },
  // the key is shown in the engine's own dialog and never returned to the caller
  export: async (id: string, auth?: Auth) => {
    const a = requireUnlocked().find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    if (a.ext) throw new Error('A Privy wallet exports its key from Privy (Wallets → Export)');
    await gate('export', auth);
    // on the NEAR lane the wallet is its NEAR identity: the ed25519 secret in NEAR wallet format
    const shownAddr = SOL_MODE ? solAddressOf(a) || a.address : NEAR_MODE ? nearAccountId(a) || a.address : a.address;
    await ask({
      title: SOL_MODE ? 'Solana Private Key' : NEAR_MODE ? 'NEAR Secret Key' : 'Private Key', ok: NEAR_MODE ? 'Show Secret Key' : 'Show Private Key', cancel: false, plain: true, size: 'sm', foot: PK_WARN,
      html: `<div class="pk"><label>${SOL_MODE ? 'Solana Address' : NEAR_MODE ? 'NEAR Account' : 'Wallet Address'}</label>${pkBox(shownAddr.slice(0, 26) + '…' + shownAddr.slice(-4), { copy: shownAddr, title: 'Copy address' })}<label>${SOL_MODE ? 'Private Key (base58, imports into Phantom, Solflare, Backpack)' : NEAR_MODE ? 'Secret Key (ed25519, importable into any NEAR wallet)' : 'Private Key'}</label>${pkBox((SOL_MODE ? '' : NEAR_MODE ? 'ed25519:' : '0x') + '•'.repeat(64), { key: true, title: 'Copy private key' })}</div>`,
      stay: (root, btn) => reveal(root, btn, SOL_MODE ? solSecretKey(a.key) : NEAR_MODE ? nearSecretKey(a.key) : a.key),
    });
    return { ok: true, shown: true };
  },
  exportMany: async (ids: string[], auth?: Auth) => {
    const list = requireUnlocked().filter((x) => ids.includes(x.id) && !x.ext); if (!list.length) throw new Error('No local wallets selected');
    await gate('export', auth);
    const lines = list.map((a) => `${a.name},${a.key}`).join('\n');
    await ask({
      title: `Private Keys (${list.length})`, ok: 'Show Private Keys', cancel: false, plain: true, size: 'sm', foot: PK_WARN,
      html: `<div class="pk"><label>Wallets</label>${list.map((a) => pkBox(`${a.name} · ${a.address}`, { copy: a.address, title: 'Copy address' })).join('')}<label>Private keys <small>name,key — one per line, importable back into any copytrade vault</small></label>${pkBox(list.map((a) => `${a.name},0x` + '•'.repeat(64)).join('\n'), { key: true, title: 'Copy all keys' })}</div>`,
      stay: (root, btn) => reveal(root, btn, lines),
    });
    return { ok: true, shown: true, count: list.length };
  },
  // route discovery + verification ahead of the click, so the buy has nothing left to check
  prewarm: async (token: string, hint?: unknown) => {
    if (SOL_MODE) { try { const r = await solRoute(token, hint); return { ok: true, route: 'sol-' + r.venue }; } catch { return { ok: false }; } }
    if (NEAR_MODE) {
      const list = unlocked || []; const ids = meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : [];
      for (const a of list.filter((x) => ids.includes(x.id)).slice(0, 8)) nearPrewarm(a).catch(() => {});
      try { const r = await nearRoute(token, hint); return { ok: true, route: 'near-dcl:' + r.quoteSymbol }; } catch { return { ok: false }; }
    }
    keepHot(); feeFloor().catch(() => {}); { const list = unlocked || []; const ids = meta.selectedAccountIds.length ? meta.selectedAccountIds : meta.activeAccountId ? [meta.activeAccountId] : []; for (const a of list.filter((x) => ids.includes(x.id)).slice(0, 8)) nextNonce(a.address).catch(() => {}); } const addr = lc(token); if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false }; const r = await routeFor(addr, hint); await verifyRoute(addr as `0x${string}`, r); return { ok: true, route: r.type }; },
  settingsGet: async () => ({ ok: true, settings: { ...loadSettings(), buyCap: buyCap(), slipOk: Number(loadLimits().slipOk) || SLIP_FREE } }),
  settingsSet: async (s: Partial<Settings> & { buyCap?: unknown; slipOk?: unknown }) => {
    // the ceilings live apart from the settings a page writes: lowering the cap is free, raising it is a trusted click
    if (s && typeof s === 'object' && 'buyCap' in s) {
      const want = Math.max(0, Number(s.buyCap) || 0);
      if (want > 0 && want !== buyCap() && (want < buyCap() || await ask({ title: 'Raise the buy cap', danger: true, ok: `Raise to ${want} ${laneUnit()}`, html: `<p>Buys up to <b>${escHtml(want)} ${laneUnit()}</b> per wallet will go out without asking (now: ${escHtml(buyCap())}).</p><p class="dlg-note">A script on the page cannot click this button.</p>` }))) { const l = loadLimits(); saveLimits({ ...l, cap: { ...(l.cap || {}), [laneKey()]: want } }); }
    }
    if (s && typeof s === 'object') { delete s.buyCap; delete s.slipOk; }
    const settings = saveSettings(s); if (NEAR_MODE) { const n = applyNearRpcs(); return { ok: true, settings, rpcs: n.rpcs, send: n.send }; } if (SOL_MODE) { const n = applySolRpcs(); return { ok: true, settings, rpcs: n.rpcs, send: n.send }; } const rebuilt = rebuildClients(); if (rebuilt) { routeCache.clear(); verifyCache.clear(); } return { ok: true, settings, rpcs: rpcUrls, send: broadcastUrls() }; },
  // which endpoints this frame signs and broadcasts through, right now
  rpcInfo: async () => { if (NEAR_MODE) { const n = applyNearRpcs(); return { ok: true, chain: 'near', urls: n.rpcs, send: n.send, defaults: NEAR_DEFAULT_RPCS }; } if (SOL_MODE) { const n = applySolRpcs(); return { ok: true, chain: 'sol', urls: n.rpcs, send: n.send, defaults: n.rpcs.slice(-2) }; } return { ok: true, chain: CFG.key, urls: rpcUrls, send: broadcastUrls(), defaults: DEFAULT_RPCS }; },
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
    // the old in-page vault hands its keys over through the page: same rule as import — shown, then a trusted click
    const fresh = (src?.accounts || []).filter((a) => /^0x[0-9a-fA-F]{64}$/.test(String(a?.key || ''))).map((a) => privateKeyToAccount(a.key).address).filter((ad) => !requireUnlocked().some((x) => same(x.address, ad)));
    if (fresh.length && !(await ask({ title: 'Move wallets into the isolated vault', ok: `Move ${fresh.length}`, html: `<p>${fresh.length} wallet${fresh.length === 1 ? '' : 's'} from this site's old in-page vault:</p><div class="addr">${fresh.map(escHtml).join('<br>')}</div><p class="dlg-note">Move them only if you recognise them. A script on the page cannot click this button.</p>` }))) throw new Error('Cancelled');
    const added = await adoptAccounts({ ...src, seeds: {}, settings: undefined }); return { ok: true, added, ...summary() };
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
    if (meta.activeAccountId && !list.some((x) => x.id === meta.activeAccountId)) meta.activeAccountId = list.find((a) => !a.hop)?.id || null;
    meta.selectedAccountIds = meta.selectedAccountIds.filter((x) => list.some((a) => a.id === x));
    if (changed) { await persist(); scheduleWatch(50); }
    return { ok: true, ...summary() };
  },
  buy: (token: string, amount: number, accountIds?: string[], hint?: unknown, opts?: unknown) => trade('buy', token, amount, accountIds, hint, opts),
  sell: (token: string, percent: number, accountIds?: string[], hint?: unknown, opts?: unknown) => trade('sell', token, percent, accountIds, hint, opts),
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
    retry: (id: string) => retryJob(id),
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
    if (!navigator.userActivation?.isActive && !navigator.userActivation?.hasBeenActive) throw new Error('A bridge needs a real click');
    // the quote names where the funds land on the other chain: one of this vault's wallets (same key on every EVM chain, or its Solana identity) is a transfer; anywhere else is a withdrawal — gate, then a trusted click on the real address
    const signBound = async (bound: BridgeQuoteLite) => ({ ok: true, hash: Number(bound.originChainId) === RELAY_SOL_CHAIN ? await solBridgeDeposit(a, bound as never) : await bridgeDeposit(a, bound), requestId: bound.requestId });
    // phase 2: sign exactly what phase 1 gated and quoted — the ticket is single-use, this wallet's, 90 s
    if (quote?.ticket) {
      const k = String(quote.ticket); const t = bridgeTickets.get(k); bridgeTickets.delete(k);
      for (const [x, v] of bridgeTickets) if (Date.now() - v.at > 90_000) bridgeTickets.delete(x);
      if (!t || t.id !== id || Date.now() - t.at > 90_000) throw new Error('This bridge quote expired — press Bridge again');
      return signBound(t.bound);
    }
    const rcpt = String(quote?.recipient || '');
    if (!ownAccounts().some((x) => same(x.address, rcpt) || solAddressOf(x) === rcpt)) {
      await gate('withdraw', auth);
      const dest = BRIDGE_CHAINS[Number(quote?.destinationChainId)]?.name || (Number(quote?.destinationChainId) === RELAY_SOL_CHAIN ? 'Solana' : `chain ${quote?.destinationChainId}`);
      // the login wallet (Privy) is the user's own, but its key is not in this vault: say so instead of "not one of your wallets"
      const login = list.find((x) => x.ext && same(x.address, rcpt));
      const ok = await ask({ title: login ? 'Bridge to your login wallet' : 'Bridge outside the vault', danger: !login, ok: 'Bridge', html: `<p>Bridge from <b>${escHtml(a.name)}</b> to <b>${escHtml(dest)}</b>, landing at</p><p class="addr">${escHtml(rcpt)}</p><p class="dlg-note">${login ? `This is your login wallet <b>${escHtml(login.name)}</b>. It is yours, but its key is held by the login provider, not by this vault — so a bridge there counts as a withdrawal and needs this confirmation.` : 'This address is not one of your wallets.'} A bridge cannot be undone.</p>` });
      if (!ok) throw new Error('Cancelled');
    } else await gate('transfer', auth);
    // Where Relay pays out is fixed by the request id inside the deposit, and the id by the recipient it was quoted
    // for — not by `quote.recipient`. A page could hand over a step whose id was quoted for another address while
    // `recipient` names one of ours: every check below passes (Relay's contract, this depositor, the exact value),
    // the gate above asks for 'transfer' only, and Relay pays the other address. So the vault quotes the route
    // itself, for the recipient it just gated, through the terminal's own server (which adds the app fee), and signs
    // that step — never the page's. The page tracks the request id that comes back.
    const bound = await ownBridgeQuote(a, quote);
    // the page showed an amount: a route that now pays less than the floor it sends is not signed
    const minOut = /^\d{1,60}$/.test(String(quote?.minOut || '')) ? BigInt(String(quote.minOut)) : 0n;
    const moved = minOut > 0n && !(bound.out && BigInt(bound.out) >= minOut);
    if (quote?.phase === 'bind') {
      if (moved) return { ok: false, moved: true, out: bound.out, outFormatted: bound.outFormatted };
      const ticket = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      bridgeTickets.set(ticket, { id, bound, at: Date.now() });
      return { ok: true, ticket, requestId: bound.requestId, out: bound.out, outFormatted: bound.outFormatted };
    }
    if (moved) throw new Error(`The quote moved: ${bound.outFormatted || 'less'} would arrive — press Bridge again`);
    return signBound(bound);
  },
  bridgeSend: async (id: string, chainId: number, to: string, amount: number | 'max', auth?: Auth) => {
    const list = requireUnlocked(); const a = list.find((x) => x.id === id); if (!a) throw new Error('Unknown wallet');
    const c = BRIDGE_CHAINS[Number(chainId)]; if (!c) throw new Error('Unknown chain');
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('Invalid address');
    if (!isOwn(to)) {
      await gate('withdraw', auth);
      const ok = await ask({ title: 'Send outside the vault', danger: true, ok: 'Send', html: `<p>Send <b>${amount === 'max' ? 'the whole balance' : escHtml(amount) + ' ' + c.symbol}</b> on <b>${c.name}</b> from <b>${escHtml(a.name)}</b> to</p><p class="addr">${escHtml(to)}</p>` });
      if (!ok) throw new Error('Cancelled');
    } else await gate('transfer', auth);
    return { ok: true, hash: await bridgeSend(a, Number(chainId), to, amount) };
  },
  bridgeReceipt: async (chainId: number, hash: string) => (Number(chainId) === RELAY_SOL_CHAIN ? solReceipt(hash) : bridgeReceipt(Number(chainId), hash)),
  // a fresh hop wallet for a two-leg bridge: funds land here on the destination chain, then move on
  bridgeHop: async () => { await ready; const id = await addAccount(nextName('Wallet').replace('Wallet', 'Hop'), generatePrivateKey(), { hop: true }); const a = (unlocked || []).find((x) => x.id === id); return { ok: true, id, address: a?.address || '' }; },
  // a refused read is left out of the answer (the page keeps what it knew): an empty wallet and a rate-limited node must not look alike
  balances: async (addresses: string[]) => (SOL_MODE ? solBalancesFor(addresses) : NEAR_MODE ? nearBalancesFor(addresses) : (await evmBalanceSheet(addresses as `0x${string}`[], []))?.eth ?? {}),
  tokenBalances: async (token: string, addresses: string[]) => (SOL_MODE ? solTokenBalancesFor(token, addresses) : NEAR_MODE ? nearTokenBalancesFor(token, addresses) : (await evmBalanceSheet(addresses as `0x${string}`[], [{ address: token as `0x${string}`, decimals: await tokenDecimals(token as `0x${string}`).catch(() => 18) }]))?.tokens[token.toLowerCase()] ?? {}),
};
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
      const holder = (path.length === 2 && path[0] === 'move' ? engine.move : engine) as unknown as Record<string, unknown>;
      const name = path[path.length - 1];
      const fn = holder[name];
      if (path.length > 2 || NO_CALL.has(name) || typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(holder, name)) throw new Error(`no such vault method: ${m}`);
      const v = await (fn as (...x: unknown[]) => unknown).apply(holder, Array.isArray(a) ? a : []);
      reply({ ok: true, v: v === undefined ? null : v });
    } catch (err) { reply({ ok: false, e: (err as Error)?.message || String(err) }); }
  });
  for (const name of ['trench:balances', 'trench:jobs', 'trench:tx']) document.addEventListener(name, (e) => post({ t: 'ev', name, detail: (e as CustomEvent).detail }));
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
