// Earn on the USD balance — the vault side (pure rules: src/earnCore.ts, src/earnAave.ts, src/earnKamino.ts; design and the
// reviewer's checklist: local earn-mvp/notes.txt).
//
// `createEarn(deps)` runs in every lane's vault frame and moves money on THAT frame's chain only, between ONE place and ONE
// place: the wallet's own reserve R and that chain's one allow-listed venue —
//   Robinhood  USDG → Morpho "Steakhouse USDG" (ERC-4626; receiver = owner = R)
//   BNB        USDC → Aave v3 Pool (supply onBehalfOf R, withdraw to R)
//   Solana     USDC → Kamino main market (deposit_reserve_liquidity / redeem_reserve_collateral; R's own token accounts)
// It never sees a key: webEngine hands it signers that check every transaction against the same allow-list again before R
// signs. floatEngine calls it:
//   tick(w, …)          from the float's background tick (its lock held, never in a click window, never while a trade runs);
//   clickNeeds(w, …)    synchronous, no read: does a waiting click need anything out of Earn at all;
//   beforeClick(w, …)   only then: the missing part comes out first;
//   status / account    cached snapshots only (the USD balance's answer carries them);
//   configure / exitAll / history   the user's switch (its own vault dialog, the 2FA gate), the USD balance's switch-off, the export.
// Every step: read → check the venue → simulate exactly what R will sign → sign → receipt / status → check the step's own
// events (EVM) or R's balances (Solana) and R's position before / after.
//
// What stops what (notes.txt "risk classes"):
//   hard     a step that did not add up (reverted, other amounts, never landed), another contract / asset at a pinned address:
//            nothing automatic any more — the funds stay where they are; only the user's own switch-off takes them out.
//   riskOff  the venue looks unsafe (the server's monitor says so, its share price dropped, a gate / freeze / pause / emergency,
//            a fee raised): nothing new goes in, and what is in comes out by itself (every withdrawal fully checked).
//   changed  the venue's code was upgraded (Aave proxy implementation, Kamino program): nothing new goes in; withdrawals go on.
//
// r2 (the independent review, local earn-review/review.txt): a hard stop holds the switch-off's withdrawals too (H1 / M8: only
// the user's own action moves money after it), the switch-off has its own day budget and backs off; one step per wallet × chain
// is held until it ends (H4: the lock is never let go early, a step past EARN.stepMs sends nothing more, no step starts while
// another one's transaction is open); the principal is booked from the transaction's own events and a lagging position read is
// re-checked, not a stop (M2); another device's Earn moves for the same reserve make this device passive (H2: Earn is one
// device's); the server monitor's pause needs two answers in a row and clears with it (M1); Kamino's switch-off works without
// parsing the Reserve (H3); Aave's liquidity is the Pool's virtual balance (M7); the stablecoins' proxies are pinned (L5).
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { fmtUsd6, USD, type FloatLang } from './floatCore.ts';
import {
  EARN, EARN_ABI, EARN_RULES, EARN_WORDS, EARN_CHAINS, earnVenueOf, bufferOf6, earnPlan, clickWithdraw6, earnTxProblem, approveData, depositData, withdrawData, redeemData,
  vaultProblem, depositOutcome, withdrawOutcome, principalAfter, bps, earnDigest, earnLive, earnOnHtml, earnOffHtml, earnSessionHtml, dayOf, apyFromSamples, earnCsv,
  EARN_ATTEST, EARN_ATTEST_V, earnAttestHtml,
  TOPIC, CHAIN_NAME,
  type EarnVaultCfg, type EarnGrant, type EarnTx, type Log, type EarnStep, type EarnChain, type EarnCfg, type HistRow,
} from './earnCore.ts';
import { AAVE_ABI, AAVE_TOPIC, EIP1967_IMPL, MAX_UINT, aaveApproveData, aaveSupplyData, aaveWithdrawData, getReserveDataData, reserveFacts, aaveApyBps, aaveSupplyOutcome, aaveWithdrawOutcome, aaveDeltaOk, type AaveCfg } from './earnAave.ts';
import { readReserve, kaminoProblem, kPrice6, kAssets, kCollateralFor, kDepositIxs, kRedeemIxs, kaminoIxsProblem, kaminoSimProblem, tokenAmount, kPinnedOracles, kRedeemFloor, MARKET_EMERGENCY, KAMINO_SLIP_BPS, KAMINO_ATA_RENT, KAMINO_FEE, type KaminoCfg, type KIx, type ReserveRead } from './earnKamino.ts';

export type EarnWallet = { id: string; name: string; r: { evm: `0x${string}`; sol?: string } };
type Call = { to: `0x${string}`; data: Hex };
type SolAcc = { owner: string; data: Uint8Array; lamports: number } | null | undefined;
export type EarnDeps = {
  chain: () => string | null;
  chainId: () => number;
  wallets: () => EarnWallet[];
  evm?: {
    // `now` = the click path (no background bucket; still behind a running trade at the source)
    call: (tx: Call & { from: `0x${string}` }, now?: boolean) => Promise<Hex>;
    multi: (calls: Call[], now?: boolean) => Promise<(Hex | null)[]>;   // one batched read; null = that entry failed
    codeHash: (a: `0x${string}`) => Promise<string>;
    storageAt?: (a: `0x${string}`, slot: Hex) => Promise<Hex>;
    balance: (a: `0x${string}`, now?: boolean) => Promise<bigint>;
    gasPrice: (now?: boolean) => Promise<bigint>;
    estimate: (tx: EarnTx & { from: `0x${string}` }, now?: boolean) => Promise<bigint>;
    // R signs on its own lane; the signer re-checks the allow-list. r6 (L5-1): `signed` is told the exact nonce it signed with
    send: (walletId: string, tx: EarnTx, gas: bigint, signed?: (nonce: number) => void) => Promise<Hex>;
    receipt: (hash: Hex, ms: number, now?: boolean) => Promise<{ status: 'success' | 'reverted'; logs: Log[]; blockHash?: string; blockNumber?: bigint } | null>;
    // r4 (re-review M3-1): one read of a receipt — the receipt, 'missing' (a node ANSWERED it does not know it), or null (no answer:
    // silence, never a stop); and a block's hash (a reorg is positive only when the block the receipt was seen in was replaced)
    receiptCheck?: (hash: Hex, now?: boolean) => Promise<{ status: 'success' | 'reverted'; logs: Log[]; blockHash?: string; blockNumber?: bigint } | 'missing' | null>;
    blockHash?: (n: bigint) => Promise<string | null>;
    // r5 (re-review X2): R's confirmed nonce (eth_getTransactionCount latest) — a silent step is dropped once it moved past it
    nonce?: (a: `0x${string}`) => Promise<number>;
    // review H2: the venue's events naming R (eth_getLogs, one address, exact topics; a null topic = any) and the chain's head —
    // another device's Earn moves for the same R are seen from them. Left out (older hosts) = no scan
    logs?: (q: { address: `0x${string}`; topics: (string | null)[]; fromBlock: bigint; toBlock: bigint }) => Promise<{ tx: string; topics: readonly string[]; data?: string }[]>;
    head?: () => Promise<bigint>;
  };
  sol?: {
    accounts: (addrs: string[], now?: boolean) => Promise<SolAcc[]>;
    deploySlot: (programData: string) => Promise<bigint | null>;
    ata: (owner: string, mint: string) => string;
    // R signs a copy for the simulation only (sigVerify off): the post-state of `watch`
    simulate: (walletId: string, ixs: KIx[], watch: string[], now?: boolean) => Promise<{ err: unknown; post: (Uint8Array | null)[] }>;
    send: (walletId: string, ixs: KIx[]) => Promise<string>;            // the signer re-checks kaminoIxsProblem, simulates again, sends
    status: (sig: string, now?: boolean) => Promise<'confirmed' | 'failed' | null>;
    // review H2: the signatures that touched an account, newest first, down to `until` (getSignaturesForAddress)
    signatures?: (addr: string, until: string | null, before?: string | null) => Promise<{ sig: string; err: boolean; at: number | null }[]>;   // (r4: paged with before)
    // r3 (re-review N1): the signers of a transaction (getTransaction: the first header.numRequiredSignatures account keys)
    signers?: (sig: string) => Promise<string[] | null>;
  };
  // the server's read-only monitor (server/earn-monitor.mjs): a chain it flags goes risk-off here; it can never turn Earn on
  // (r3: `hold` = no new deposits — the engine's 'changed'; a curator's cap raised on a market in use, under review)
  monitor?: () => Promise<Partial<Record<EarnChain, { pause?: string; hold?: string; apyBps?: number }>> | null>;
  // the browser's cross-tab lock (navigator.locks): one Earn step per wallet × chain across this vault's tabs
  lock?: <T>(key: string, fn: () => Promise<T>, opts?: { waitMs?: number }) => Promise<T | null>;
  // true / { on: true } = Earn may be offered where this user is (the server's geo answer); anything else = no.
  // (earn-ship, 2026-11-04: the owner gate) { on, capUsd }: the server may LOWER what one account keeps in Earn (never raise it
  // past EARN.capMax6, never below EARN.capMin6); left out = the account's own cap, as before
  geo: () => Promise<boolean | { on: boolean; capUsd?: number | null }>;
  ask: (o: { title: string; html: string; ok: string; danger?: boolean; validate?: (root: HTMLElement, choice: string) => string | null }) => Promise<boolean>;
  gate: () => Promise<void>;
  esc: (v: unknown) => string;
  now: () => number;
  store: { get: (k: string) => string | null; set: (k: string, v: string) => void; del: (k: string) => void };
  emit: (detail: Record<string, unknown>) => void;
  wait: (ms: number) => Promise<void>;
  busy: () => boolean;             // the click window (a trade, a ticket touch, a token page's focus): no background send
  tradeLive: () => boolean;        // a trade is between its call and its broadcast: not even a click's withdrawal is sent
};
export class EarnRefused extends Error { name = 'EarnRefused'; }
class Deferred extends Error { name = 'EarnDeferred'; }
class Anomaly extends Error { name = 'EarnAnomaly'; }
type Cls = 'hard' | 'riskOff' | 'changed';
// upd: this build cannot read / pin the venue any more (another contract, another layout): only a new build lifts it (M6 copy)
type Risk = { cls: Cls; why: string; upd?: boolean };
/** A step's answer from Earn's own reads that this build no longer understands (a hard stop that needs an app update). */
class Unreadable extends Anomaly { name = 'EarnUnreadable'; }

const K = { attest: 'trenches.earn.v2.attest', session: 'trenches.earn.v2.session', acct: 'trenches.earn.v2.account', exit: 'trenches.earn.v2.exit', vault: 'trenches.earn.v2.vault.', geo: 'trenches.earn.v2.geo', w: 'trenches.earn.v2.w.', snap: 'trenches.earn.v2.snap.', hist: 'trenches.earn.v2.hist.', daily: 'trenches.earn.v2.daily.', samples: 'trenches.earn.v2.px.' };
// booked: the transaction landed and its own events were checked and booked (M2); expect: R's position the venue must show
// (verify re-reads it until verifyFrom + EARN.verifyMs); got: what a withdrawal paid (from its events / the simulation)
type Open = { kind: 'approve' | 'deposit' | 'withdraw' | 'reset'; hash: string; at: number; amount: string; minOut: string; maxIn: string; before: string; all?: boolean; preLiquid?: string; booked?: boolean; expect?: string; verifyFrom?: number; got?: string;
  // r4: the block the receipt was seen in (a reorg signal is that block replaced); since when nodes answer "not found" (unbooked)
  blockHash?: string; blockNumber?: string; missingSince?: number;
  // r6 (L5-1): the exact nonce this step's transaction was signed with (reported by the signer)
  nonce?: number };
type WState = {
  principal6: string | null; realized6: string; day: string; dayIn6: string; txDay: number; clickDay: number; lastDepositAt: number; lastWithdrawAt: number; backoffUntil: number; fails: number; open?: Open; paused?: { why: string; at: number; upd?: boolean };
  // r2: the switch-off's sends today (H1); failures in a row (the backoff doubles, H1 / M8); a reset that failed (L6)
  exitDay?: number; streak?: number; resetDue?: boolean;
  // r2 (H2): this device's own transactions (hashes / signatures), the scan cursor of the venue's events for R, the moment Earn
  // was turned on here (a first scan starts there), and another device's moves seen (this device is passive: nothing automatic)
  own?: string[]; scan?: { block?: string; sig?: string }; scanFrom?: number; foreign?: { at: number; why: string };
  // r3: a send of this device that failed WITHOUT a hash (it may have gone out: L-d); a Kamino exit under the last rate the user
  // was told about (L-a: his next withdraw within 10 min accepts it)
  sendErrAt?: number; lossOk?: { at: number; paid: string };
  // r4 (L3-3): a click's withdrawals, re-read later for the books (the click itself never waits for it)
  recheck?: { hash: string; blockHash?: string; blockNumber?: string; at: number }[];
  // r4 (L3-1): the Solana scan window still being read (pages down to the cursor)
  scanSol?: { until: string | null; before: string | null; newest: string | null; theirs: string[] };
  // r2 (M6): what came out of Earn while the USD balance was off (it sits in R as the stablecoin; the app shows it)
  residue6?: string;
};
type Snap = { at: number; position: string; assets6: string; redeemable6: string; redeemableAt: number; liquid6: string; price6: string; buffer6: string; apyBps: number | null };
// pause.src 'monitor': it came from the server monitor and clears with it (M1); mon: the monitor's flags in a row; implAt: the
// proxies' implementations (stablecoin + venue) last read (L5)
type VaultState = { codeOk?: boolean; codeAt?: number; implOk?: boolean; implAt?: number; hwm6?: string; pause?: { cls: Cls; why: string; at: number; src?: 'monitor'; upd?: boolean }; mon?: { n: number; at: number } };
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };
const lc = (a: string) => String(a || '').toLowerCase();
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function createEarn(deps: EarnDeps) {
  const chainHere = (): EarnChain | null => { const c = deps.chain(); return c === 'robinhood' || c === 'bsc' || c === 'sol' ? c : null; };
  const venueHere = (): EarnCfg | null => earnVenueOf(chainHere());
  const read = <T,>(k: string, d: T): T => { try { const v = JSON.parse(deps.store.get(k) || 'null'); return v == null ? d : v as T; } catch { return d; } };
  const rOf = (w: EarnWallet, c: EarnChain): string => (c === 'sol' ? String(w.r.sol || '') : lc(w.r.evm));
  // ── the account's switch: which chains, the cap, the dates (one record for every wallet) ──
  const grant = (): EarnGrant | null => read<EarnGrant | null>(K.acct, null);
  // release #5: the account's self-attestation (not a US person / resident, not in a restricted country) — no deposit without it
  const attested = (): boolean => { const a = read<{ v: number; at: number } | null>(K.attest, null); return !!a && a.v >= EARN_ATTEST_V && typeof a.at === 'number' && a.at > 0; };
  const grantLive = () => { const g = grant(); return earnLive(g, deps.now()) ? g : null; };
  // r3 (owner): a timed session. No record = the r2 behaviour (on until turned off); until null = until turned off; else it ends at
  // `until` (wall time), or when the clock jumps back past its start, or past 24 h — then its chains exit (sessionEnded)
  // r4 (S2): `ended` is written the first time the end is seen — no clock step revives a session; only a new switch-on clears it
  type Session = { v: 1; until: number | null; at: number; chains: EarnChain[]; ended?: true };
  const session = (): Session | null => { const s = read<Session | null>(K.session, null); return s && s.v === 1 && Array.isArray(s.chains) ? s : null; };
  const sessionOver = (s: Session) => {
    if (s.ended) return true;
    const over = s.until != null && (deps.now() >= s.until || deps.now() < s.at - EARN.sessionBackMs || s.until > s.at + EARN.sessionMaxH * 3_600_000 + 60_000);
    if (over) { const cur = session(); if (cur && cur.at === s.at && !cur.ended) deps.store.set(K.session, json({ ...cur, ended: true })); }
    return over;
  };
  const sessionLive = (c: EarnChain) => { const s = session(); return !s || (s.chains.includes(c) && !sessionOver(s)); };
  const sessionEnded = (c: EarnChain) => { const s = session(); return !!s && s.chains.includes(c) && sessionOver(s); };
  const onFor = (c: EarnChain) => { const g = grantLive(); return !!g && g.chains.includes(c) && sessionLive(c); };
  const exits = (): Partial<Record<EarnChain, true>> => read<Partial<Record<EarnChain, true>>>(K.exit, {});
  const lapsed = () => { const g = grant(); return !!g && !earnLive(g, deps.now()); };
  const exiting = (c: EarnChain) => exits()[c] === true || lapsed() || sessionEnded(c);
  const setExit = (cs: readonly EarnChain[], on: boolean) => { const e = { ...exits() }; for (const c of cs) { if (on) e[c] = true; else delete e[c]; } if (Object.keys(e).length) deps.store.set(K.exit, json(e)); else deps.store.del(K.exit); };
  const vstate = (c: EarnChain): VaultState => read<VaultState>(K.vault + c, {});
  const saveV = (c: EarnChain, v: VaultState) => deps.store.set(K.vault + c, json(v));
  const wkey = (w: EarnWallet, c: EarnChain) => `${K.w}${c}.${rOf(w, c)}`;
  const fresh = (): WState => ({ principal6: '0', realized6: '0', day: dayOf(deps.now()), dayIn6: '0', txDay: 0, clickDay: 0, lastDepositAt: 0, lastWithdrawAt: 0, backoffUntil: 0, fails: 0, exitDay: 0, streak: 0 });
  /** this device keeps a record of this wallet × chain (it was here before) */
  const known = (w: EarnWallet, c: EarnChain) => deps.store.get(wkey(w, c)) != null;
  const wstate = (w: EarnWallet, c: EarnChain): WState => {
    const s = read<WState | null>(wkey(w, c), null);
    if (!s) return { ...fresh(), principal6: null };   // never seen here: what went in is unknown on this device ("Earned" shows —)
    const n = { ...fresh(), ...s };
    if (n.day !== dayOf(deps.now())) return { ...n, day: dayOf(deps.now()), dayIn6: '0', txDay: 0, clickDay: 0, exitDay: 0 };
    return n;
  };
  const saveW = (w: EarnWallet, c: EarnChain, s: WState) => deps.store.set(wkey(w, c), json(s));
  const snapOf = (w: EarnWallet, c: EarnChain): Snap | null => read<Snap | null>(`${K.snap}${c}.${rOf(w, c)}`, null);
  const saveSnap = (w: EarnWallet, c: EarnChain, s: Snap) => deps.store.set(`${K.snap}${c}.${rOf(w, c)}`, json(s));
  const emit = (w: EarnWallet | null, c: EarnChain | null, step: string, state: string, extra: Record<string, unknown> = {}) => deps.emit({ ...(w ? { walletId: w.id } : {}), ...(c ? { chain: c } : {}), step: 'earn', earn: step, state, ...extra });
  const hardPause = (w: EarnWallet | null, c: EarnChain, why: string, upd = false) => {
    const t = why.slice(0, 160);
    if (w) { const s = wstate(w, c); saveW(w, c, { ...s, paused: { why: t, at: deps.now(), ...(upd ? { upd: true } : {}) } }); }
    else saveV(c, { ...vstate(c), pause: { cls: 'hard', why: t, at: deps.now(), ...(upd ? { upd: true } : {}) } });
    emit(w, c, 'paused', 'failed', { cls: 'hard', why: t, ...(upd ? { update: true } : {}) });
  };
  const rank = { changed: 1, riskOff: 2, hard: 3 } as const;
  /** A venue-wide stop. A harder class is never replaced by a softer one; the engine's own finding replaces the monitor's of the
   *  same class (the engine's own findings stay until the user's next "on"; the monitor's clear with it — review M1). */
  const venuePause = (c: EarnChain, risk: Risk, src?: 'monitor') => {
    const v = vstate(c);
    if (v.pause) { const r0 = rank[v.pause.cls], r1 = rank[risk.cls]; if (r0 > r1 || (r0 === r1 && (src === 'monitor' || !v.pause.src))) return; }
    saveV(c, { ...v, pause: { cls: risk.cls, why: risk.why.slice(0, 160), at: deps.now(), ...(src ? { src } : {}), ...(risk.upd ? { upd: true } : {}) } });
    emit(null, c, 'paused', risk.cls === 'riskOff' ? 'withdrawing' : 'failed', { cls: risk.cls, why: risk.why.slice(0, 160), ...(src ? { src } : {}) });
  };
  const hardWhy = (w: EarnWallet, c: EarnChain): string | null => (vstate(c).pause?.cls === 'hard' ? vstate(c).pause!.why : null) ?? wstate(w, c).paused?.why ?? null;
  const hardUpd = (w: EarnWallet, c: EarnChain): boolean => (vstate(c).pause?.cls === 'hard' && !!vstate(c).pause!.upd) || !!wstate(w, c).paused?.upd;

  // ── one Earn step per wallet × chain at a time: in this tab (a promise) and across the vault's tabs (the browser's lock) ──
  // review H4: the lock is held until the step's own function settles (webEngine's lock has no cap any more); a step past
  // EARN.stepMs sends nothing new (late()) but still follows what it already sent; `running` tracks the step itself
  const running = new Map<string, Promise<unknown>>();
  const deadline = new Map<string, number>();
  const mode = new Map<string, 'auto' | 'exit' | 'user' | 'click'>();
  const stepKey = (w: EarnWallet, c: EarnChain) => `${c}|${w.id}`;
  // a waiting click simulates once (review M3); the background and the user's switch-off halve down to EARN.probes
  const oneSim = (w: EarnWallet, c: EarnChain) => mode.get(stepKey(w, c)) === 'click';
  const late = (w: EarnWallet, c: EarnChain) => { const d = deadline.get(stepKey(w, c)); return d != null && deps.now() > d; };
  async function exclusive<T>(w: EarnWallet, c: EarnChain, fn: () => Promise<T>, waitMs = 0, m: 'auto' | 'exit' | 'user' | 'click' = 'auto'): Promise<T | null> {
    const key = stepKey(w, c); const t0 = deps.now();
    while (running.has(key)) {
      if (deps.now() - t0 >= waitMs) return null;
      await Promise.race([running.get(key)!.catch(() => {}), deps.wait(Math.max(1, waitMs - (deps.now() - t0)))]);
    }
    const inner = async () => { deadline.set(key, deps.now() + EARN.stepMs); mode.set(key, m); try { return await fn(); } finally { deadline.delete(key); mode.delete(key); } };
    const p = deps.lock ? deps.lock(`trench-earn-${c}-${rOf(w, c)}`, inner, waitMs ? { waitMs: Math.max(1, waitMs - (deps.now() - t0)) } : undefined) : inner();
    running.set(key, p);
    try { return await p; } finally { if (running.get(key) === p) running.delete(key); }
  }

  // ── shared state helpers ──
  /** a send went out (or may have): the day's counters, the switch-off's own budget (H1) and this device's own list (H2) */
  const bump = (w: EarnWallet, c: EarnChain, click: boolean, hash: string) => {
    const s = wstate(w, c); const m = mode.get(stepKey(w, c));
    const own = [...(s.own ?? []).filter((x) => x !== lc(hash)), lc(hash)].slice(-120);
    saveW(w, c, { ...s, own, ...(click && m === 'click' ? { clickDay: s.clickDay + 1 } : { txDay: s.txDay + 1 }), ...(m === 'exit' || m === 'user' ? { exitDay: (s.exitDay ?? 0) + 1 } : {}) });
  };
  const setOpen = (w: EarnWallet, c: EarnChain, open: Open | undefined) => { const s = wstate(w, c); const n = { ...s }; if (open) n.open = open; else delete n.open; saveW(w, c, n); };
  /** a step that did not add up on chain: what went in is no longer known on this device ("Earned" shows —; review M2 / R3) */
  const unknownPrincipal = (w: EarnWallet, c: EarnChain) => { const s = wstate(w, c); const n = { ...s, principal6: null }; delete n.open; saveW(w, c, n); };
  const histKey = (w: EarnWallet, c: EarnChain) => `${K.hist}${c}.${rOf(w, c)}`;
  const note = (w: EarnWallet, c: EarnChain, row: Omit<HistRow, 'chain' | 'wallet'>) => {
    const list = read<HistRow[]>(histKey(w, c), []);
    deps.store.set(histKey(w, c), json([...list, { ...row, chain: c, wallet: w.name }].slice(-300)));
  };
  /** the cached snapshot follows a booked step at once (the click path reads nothing more; the next background read replaces it) */
  const shift = (w: EarnWallet, c: EarnChain, in6: bigint, position: bigint | null) => {
    const sn = snapOf(w, c); if (!sn) return;
    const a = big(sn.assets6) + in6, l = big(sn.liquid6) - in6;
    saveSnap(w, c, { ...sn, assets6: String(a > 0n ? a : 0n), liquid6: String(l > 0n ? l : 0n), ...(position != null ? { position: String(position) } : {}), redeemable6: in6 < 0n ? String(big(sn.redeemable6) + in6 > 0n ? big(sn.redeemable6) + in6 : 0n) : sn.redeemable6 });
  };
  /** what came in, booked from the transaction's own events (M2): the principal grows; dayIn counts towards the day's budget. The
   *  step stays open (booked) until R's position read shows `expect` (confirm / followOpen) */
  const booked = (w: EarnWallet, c: EarnChain, amount6: bigint, o: Open, expect: bigint) => {
    const s = wstate(w, c);
    const n: WState = { ...s, principal6: s.principal6 != null ? String(big(s.principal6) + amount6) : null, dayIn6: String(big(s.dayIn6) + amount6), lastDepositAt: deps.now(), fails: 0, streak: 0,
      open: { ...o, booked: true, expect: String(expect), verifyFrom: deps.now() } };
    saveW(w, c, n);
    note(w, c, { at: deps.now(), kind: 'deposit', usd6: String(amount6), hash: o.hash });
    shift(w, c, amount6, expect);
    emit(w, c, 'deposit', 'done', { usd: Number(amount6) / 1e6 });
  };
  /** what went out, from the transaction's own events: the principal shrinks pro rata; the part above it is realized yield (the
   *  tax export's line). Open (booked) until the position read shows `expect` */
  const paidOut = (w: EarnWallet, c: EarnChain, out6: bigint, burnt: bigint, before: bigint, o: Open, expect: bigint, gotRaw: bigint, click: boolean) => {
    const s = wstate(w, c);
    const p0 = s.principal6 != null ? big(s.principal6) : null;
    const p1 = p0 != null ? principalAfter(p0, before, burnt) : null;
    const yield6 = p0 != null && p1 != null ? out6 - (p0 - p1) : null;
    const n: WState = { ...s, principal6: p1 != null ? String(p1) : null, realized6: String(big(s.realized6) + (yield6 ?? 0n)), lastWithdrawAt: deps.now(), streak: 0,
      open: { ...o, booked: true, expect: String(expect), verifyFrom: deps.now(), got: String(gotRaw) } };
    saveW(w, c, n);
    note(w, c, { at: deps.now(), kind: 'withdraw', usd6: String(out6), hash: o.hash, ...(yield6 != null ? { yield6: String(yield6) } : {}), ...(click ? { why: 'buy' } : {}) });
    shift(w, c, -out6, expect);
    emit(w, c, 'withdraw', 'done', { usd: Number(out6) / 1e6, ...(click ? { click: true } : {}) });
  };

  // ══ the venues ══
  type VState = 'ok' | 'lag' | 'reorg' | 'silent';
  type Pos = { position: bigint; assets: bigint; liquid: bigint; allowance: bigint; price6: bigint | null; available: bigint | null; apyBps: number | null; risk: Risk | null; gas: bigint; k?: { reserve: ReserveRead | null; rUsdc: string; rCtoken: string } };
  type Venue = {
    chain: EarnChain; cfg: EarnCfg;
    to6: (raw: bigint) => bigint; raw: (u6: bigint) => bigint;
    facts: (w: EarnWallet, now?: boolean) => Promise<Pos>;
    redeemable: (w: EarnWallet, p: Pos, now?: boolean) => Promise<bigint>;
    deposit: (w: EarnWallet, p: Pos, amount: bigint, yieldNow: () => boolean) => Promise<void>;
    withdraw: (w: EarnWallet, p: Pos, usd6: bigint, all: boolean, click: boolean, yieldNow: () => boolean) => Promise<bigint>;
    // r4: 'missing' = a node answered it does not know the transaction; 'waiting' = no answer yet / silence
    follow: (w: EarnWallet, o: Open) => Promise<'waiting' | 'missing' | 'settled'>;
    // M2: does R's position show the booked step now (null = not read)
    // r4: 'ok' (R's position and the receipt show it), 'lag' (R's position not there yet), 'reorg' (a POSITIVE signal: reverted, failed,
    // or gone with its block replaced), 'silent' (no answer)
    verify: (w: EarnWallet, o: Open, now?: boolean) => Promise<VState>;
    // H2: the venue's events naming R between two blocks (EVM), their transactions
    scanLogs?: (w: EarnWallet, from: bigint, to: bigint) => Promise<string[]>;
    // H3: R's own position read without the venue's state (a venue this build can no longer parse): the user's switch-off only
    exitFacts?: (w: EarnWallet) => Promise<Pos>;
    // L6: the allowance back to 0
    reset?: (w: EarnWallet, yieldNow: () => boolean) => Promise<void>;
  };
  const scale = (d: number) => ({ to6: (raw: bigint) => (d >= 6 ? raw / 10n ** BigInt(d - 6) : raw * 10n ** BigInt(6 - d)), raw: (u: bigint) => (d >= 6 ? u * 10n ** BigInt(d - 6) : u / 10n ** BigInt(6 - d)) });
  const pad32 = (a: string) => '0x' + lc(a).replace(/^0x/, '').padStart(64, '0');

  // ── EVM: shared pieces ──
  const encA = (abi: readonly unknown[], fn: string, args: readonly unknown[] = []): Hex => (encodeFunctionData as unknown as (x: unknown) => Hex)({ abi, functionName: fn, args });
  const decA = (abi: readonly unknown[], fn: string, data: Hex | null): unknown => { if (!data || data === '0x') return null; try { return (decodeFunctionResult as unknown as (x: unknown) => unknown)({ abi, functionName: fn, data }); } catch { return null; } };
  const enc = (fn: string, args: readonly unknown[] = []) => encA(EARN_ABI, fn, args);
  const dec = (fn: string, data: Hex | null) => decA(EARN_ABI, fn, data);
  const evm = () => { if (!deps.evm) throw new Deferred('this frame has no EVM client'); return deps.evm; };
  const implOf = (slot: Hex | null | undefined) => (slot && /^0x[0-9a-fA-F]{1,64}$/.test(String(slot)) ? '0x' + String(slot).replace(/^0x/, '').padStart(64, '0').slice(-40).toLowerCase() : null);
  // (M3: the estimate and the fee reads in one round trip)
  async function gasFor(w: EarnWallet, tx: EarnTx, now = false): Promise<bigint> {
    const e = evm();
    const [est, price, native] = await Promise.all([e.estimate({ ...tx, from: w.r.evm }, now), e.gasPrice(now), e.balance(w.r.evm, now)]);
    const gas = (est * 13n) / 10n;
    if (!(gas > 0n) || gas > EARN.gasMax) throw new Anomaly('abnormal gas for an Earn transaction');
    if (gas * price > (chainHere() === 'bsc' ? EARN.gasWeiMaxBsc : EARN.gasWeiMax)) throw new Deferred('gas is far above normal: Earn waits');
    if (native < (gas * price * 12n) / 10n) throw new Deferred('the reserve needs a little gas');
    return gas;
  }
  // the allow-list, the click window, the step's own deadline (H4) and the one-open-step rule, then R's signer; the step is
  // recorded as open (followed by its receipt, never re-sent) with its hash — also when the send's answer was lost but its bytes
  // may be out there (an error carrying the hash)
  async function sendEvm(w: EarnWallet, c: EarnChain, tx: EarnTx, gas: bigint, yieldNow: () => boolean, open0: Omit<Open, 'hash' | 'at'>, click = false): Promise<Hex> {
    let open = open0;
    const bad = earnTxProblem(tx, { r: w.r.evm, chainId: deps.chainId(), cfg: venueHere() });
    if (bad) throw new Anomaly('Refusing to sign: ' + bad);
    if (wstate(w, c).open) throw new Deferred('an earlier Earn transaction is still open: followed first, nothing new is sent');
    if (late(w, c)) throw new Deferred('deferred: the step ran out of time (nothing more is sent in it)');
    if ((click ? deps.tradeLive() : deps.busy()) || yieldNow()) throw new Deferred('deferred: a trade is running');
    // r6 (re-review L5-1): the exact nonce the signer signed with (every Earn send, a click's withdrawal too; no extra read)
    let h: Hex;
    try { h = await evm().send(w.id, tx, gas, (n) => { if (Number.isSafeInteger(n) && n >= 0) open = { ...open, nonce: n }; }); }
    catch (x) {
      const lost = (x as { hash?: string }).hash;
      if (lost && /^0x[0-9a-fA-F]{64}$/.test(lost)) { bump(w, c, click, lost); setOpen(w, c, { ...open, hash: lost, at: deps.now() }); throw new Deferred('the answer of the send was lost: followed by its receipt, never sent again'); }
      // r3 L-d: no hash — it may still have gone out; an R-signed move seen soon after is this device's own, not another device's
      saveW(w, c, { ...wstate(w, c), sendErrAt: deps.now() });
      throw x;
    }
    bump(w, c, click, h); setOpen(w, c, { ...open, hash: h, at: deps.now() });
    return h;
  }
  /** The receipt: success, or a revert — then nothing moved but gas: the open step is closed at once and Earn stops (hard). */
  async function landed(w: EarnWallet, c: EarnChain, hash: Hex, ms: number, now = false) {
    const r = await evm().receipt(hash, ms, now).catch(() => null);
    if (!r) throw new Deferred('the transaction has not landed yet: followed by the next tick');
    if (r.status !== 'success') { setOpen(w, c, undefined); throw new Anomaly('an Earn transaction reverted on chain'); }
    return r;
  }
  async function resetAllowance(w: EarnWallet, c: EarnChain, token: `0x${string}`, spender: `0x${string}`, data: Hex, yieldNow: () => boolean) {
    const tx = { to: token, data, value: 0n };
    const gas = await gasFor(w, tx);
    const h = await sendEvm(w, c, tx, gas, yieldNow, { kind: 'reset', amount: '0', minOut: '0', maxIn: '0', before: '0' });
    await landed(w, c, h, EARN.receiptMs);
    setOpen(w, c, undefined);
    const [al] = await evm().multi([{ to: token, data: enc('allowance', [w.r.evm, spender]) }]);
    if (dec('allowance', al) !== 0n) throw new Anomaly('the allowance did not go back to 0');
    const s = wstate(w, c); if (s.resetDue) { const n = { ...s }; delete n.resetDue; saveW(w, c, n); }
  }
  /** L6: a reset that could not run now is due (the next tick runs it first) — never swallowed */
  const resetLater = (w: EarnWallet, c: EarnChain) => { const s = wstate(w, c); saveW(w, c, { ...s, resetDue: true }); };
  /** M2: after a booked step, R's position must show it; a read that lags is read again (background: 3 reads over ~3 s; a click:
   *  one), then the open step stays and the next ticks read it again until EARN.verifyMs — only then a hard stop. */
  async function confirm(w: EarnWallet, v: Venue, click: boolean): Promise<VState> {
    const c = v.chain; let st: VState = 'silent';
    for (let i = 0; i < (click ? 1 : 3); i++) {
      if (i) await deps.wait(1_000 * i);
      const o = wstate(w, c).open; if (!o || !o.booked) return 'ok';
      st = await v.verify(w, o, click).catch((): VState => 'silent');
      if (st === 'ok') {
        // r4 (L3-3): a click does not wait for the receipt's re-read; the next background tick does it, for the books
        if (click && o.kind === 'withdraw' && c !== 'sol') { const s = wstate(w, c); saveW(w, c, { ...s, recheck: [...(s.recheck ?? []), { hash: o.hash, ...(o.blockHash ? { blockHash: o.blockHash, blockNumber: o.blockNumber } : {}), at: deps.now() }].slice(-10) }); }
        setOpen(w, c, undefined); return 'ok';
      }
      if (st === 'reorg') return st;
    }
    return st;
  }
  /** M3: the simulation of the exact call from R and its gas. A click runs both side by side (one round trip); the background in
   *  sequence (no estimate for a call that does not simulate). ret null = it did not simulate; gas an Error = why it cannot go. */
  async function simGas(w: EarnWallet, tx: EarnTx, click: boolean): Promise<{ ret: Hex | null; gas: bigint | Error }> {
    const sim = () => evm().call({ ...tx, from: w.r.evm }, click).catch(() => null);
    if (click) { const [ret, gas] = await Promise.all([sim(), gasFor(w, tx, true).catch((x: unknown) => (x instanceof Error ? x : new Error(String(x))))]); return { ret, gas }; }
    const ret = await sim(); if (ret == null) return { ret, gas: new Error('the call did not simulate') };
    return { ret, gas: await gasFor(w, tx, false) };
  }
  const gasOf = (g: bigint | Error): bigint => { if (g instanceof Error) throw g; return g; };
  /** r4 (M3-1): one receipt read — the receipt, 'missing' (answered: not known), or null (no answer). An older host's receipt() cannot
   *  tell the two apart: there it is silence */
  async function rcpt(hash: string, now = false) {
    const e = evm();
    if (e.receiptCheck) return e.receiptCheck(hash as Hex, now).catch(() => null);
    return (await e.receipt(hash as Hex, 1, now).catch(() => null)) ?? null;
  }
  /** r4: still in the chain ('ok'), a POSITIVE reorg signal ('reorg': reverted, or not found while the block it was seen in now has
   *  another hash), or 'silent' (no answer, or "not found" with no proof the block changed) — silence is never a stop */
  async function receiptState(o: { hash: string; blockHash?: string; blockNumber?: string }): Promise<'ok' | 'reorg' | 'silent'> {
    const r = await rcpt(o.hash);
    if (r && r !== 'missing') return r.status === 'success' ? 'ok' : 'reorg';
    if (r === 'missing' && o.blockHash && o.blockNumber && evm().blockHash) {
      const h = await evm().blockHash!(BigInt(o.blockNumber)).catch(() => null);
      if (h && lc(h) !== lc(o.blockHash)) return 'reorg';
    }
    return 'silent';
  }
  const seenAt = (r: { blockHash?: string; blockNumber?: bigint }) => (r.blockHash && r.blockNumber != null ? { blockHash: r.blockHash, blockNumber: String(r.blockNumber) } : {});
  /** Morpho / Aave verify: R's position (a lower bound for a deposit), then — outside a click — the receipt again */
  const verifyEvm = async (o: Open, pos: bigint | null, posOk: (v: bigint) => boolean, now: boolean): Promise<VState> => {
    if (pos == null) return 'silent';
    if (!posOk(pos)) { if (now) return 'lag'; const rs = await receiptState(o); return rs === 'reorg' ? 'reorg' : 'lag'; }
    if (now) return 'ok';
    const rs = await receiptState(o); return rs === 'ok' ? 'ok' : rs;
  };
  let codeSeen = new Set<EarnChain>();
  /** the periodic code / implementation reads: every vaultCheckMs / implCheckMs and on the first background read of a session;
   *  a click never waits for them (it uses what the last read found) */
  const due = (c: EarnChain, at: number | undefined, every: number, now: boolean) => (now ? !at : !at || deps.now() - at > every || !codeSeen.has(c));

  // ── Robinhood: Morpho Vault V2 (ERC-4626) ──
  function morphoVenue(cfg: EarnVaultCfg): Venue {
    const c: EarnChain = 'robinhood'; const sc = scale(cfg.assetDecimals);
    let self: Venue;
    const facts = async (w: EarnWallet, now = false): Promise<Pos> => {
      const e = evm(); const V = cfg.vault, A = cfg.asset, R = w.r.evm;
      const one = 10n ** BigInt(cfg.shareDecimals);
      const res = await e.multi([
        { to: V, data: enc('balanceOf', [R]) }, { to: A, data: enc('balanceOf', [R]) }, { to: A, data: enc('allowance', [R, V]) },
        { to: V, data: enc('convertToAssets', [one]) }, { to: V, data: enc('asset') },
        { to: V, data: enc('receiveSharesGate') }, { to: V, data: enc('sendSharesGate') }, { to: V, data: enc('receiveAssetsGate') }, { to: V, data: enc('sendAssetsGate') },
        { to: V, data: enc('performanceFee') }, { to: V, data: enc('managementFee') }, { to: V, data: enc('maxWithdraw', [R]) },
      ], now);
      const n = (i: number, fn: string) => { const v = dec(fn, res[i]); return typeof v === 'bigint' ? v : null; };
      const s = (i: number, fn: string) => { const v = dec(fn, res[i]); return typeof v === 'string' ? v : null; };
      const shares = n(0, 'balanceOf'), liquid = n(1, 'balanceOf'), allowance = n(2, 'allowance');
      if (shares == null || liquid == null || allowance == null) throw new Deferred('the reserve was not read');
      const price = n(3, 'convertToAssets');
      let assets = 0n;
      if (shares > 0n) {
        const [a] = await e.multi([{ to: V, data: enc('convertToAssets', [shares]) }], now);
        const v = dec('convertToAssets', a); if (typeof v !== 'bigint') throw new Deferred('the reserve\'s shares were not valued');
        assets = v;
      }
      let codeHash: string | null = null; const vs = vstate(c);
      if (due(c, vs.codeAt, EARN.vaultCheckMs, now)) {
        codeHash = await e.codeHash(V).catch(() => null);
        if (codeHash == null) throw new Deferred('the vault code was not read');
        codeSeen.add(c); saveV(c, { ...vstate(c), codeOk: lc(codeHash) === lc(cfg.codeHash), codeAt: deps.now() });
      } else if (vs.codeOk === false) codeHash = 'mismatch';
      // L5: USDG is an upgradeable proxy — its implementation pinned (another one: nothing new goes in, withdrawals go on)
      if (due(c, vstate(c).implAt, EARN.implCheckMs, now)) {
        if (!e.storageAt) throw new Deferred('this frame cannot read the stablecoin implementation');
        const impl = implOf(await e.storageAt(A, EIP1967_IMPL as Hex).catch(() => null));
        if (impl == null) throw new Deferred('the stablecoin implementation was not read');
        saveV(c, { ...vstate(c), implOk: impl === lc(cfg.assetImpl), implAt: deps.now() });
      }
      const price6 = price != null ? sc.to6(price) : null;
      const why = vaultProblem({ codeHash, asset: s(4, 'asset'), gates: [s(5, 'receiveSharesGate'), s(6, 'sendSharesGate'), s(7, 'receiveAssetsGate'), s(8, 'sendAssetsGate')], performanceFee: n(9, 'performanceFee'), managementFee: n(10, 'managementFee'), price6 }, cfg, big(vstate(c).hwm6));
      const risk: Risk | null = why ? (/contract|another asset/.test(why) ? { cls: 'hard', why, upd: true } : { cls: 'riskOff', why })
        : vstate(c).implOk === false ? { cls: 'changed', why: 'USDG\'s token contract was upgraded' } : null;
      const gas = now ? 0n : await e.balance(R, now).catch(() => 0n);   // (a click: gasFor reads it, in its own round trip)
      const mw = n(11, 'maxWithdraw');
      return { position: shares, assets, liquid, allowance, price6, available: cfg.maxZero ? null : mw, apyBps: null, risk, gas };
    };
    // Morpho Vault V2 answers maxWithdraw with 0 by design: what the vault can pay now is the exact call R would sign, simulated
    // (all shares, then halving: at most EARN.probes calls)
    const redeemable = async (w: EarnWallet, p: Pos, now = false): Promise<bigint> => {
      if (p.position === 0n) return 0n;
      if (!cfg.maxZero) return p.available != null ? min(p.available, p.assets) : 0n;
      const R = w.r.evm;
      try { const ret = await evm().call({ to: cfg.vault, data: redeemData(p.position, R), from: R }, now); const v = dec('redeem', ret); if (typeof v === 'bigint') return v; } catch { /* short: probe smaller */ }
      let amt = p.assets / 2n;
      for (let i = 1; i < EARN.probes && amt > 0n; i++) { try { await evm().call({ to: cfg.vault, data: withdrawData(amt, R), from: R }, now); return amt; } catch { amt /= 2n; } }
      return 0n;
    };
    const sharesOf = async (w: EarnWallet, now = false) => { const [sh] = await evm().multi([{ to: cfg.vault, data: enc('balanceOf', [w.r.evm]) }], now); const v = dec('balanceOf', sh); return typeof v === 'bigint' ? v : null; };
    // r3 (re-review N1): R's shares at least what the step left (anyone may deposit FOR R: a gift never stops Earn); outside a
    // click, the receipt read again (a reorg drops it: never confirmed → the stop after verifyMs)
    const verify = async (w: EarnWallet, o: Open, now = false): Promise<VState> => verifyEvm(o, await sharesOf(w, now), (v) => v >= big(o.expect), now);
    // M2: the receipt's own events decide and are booked at once; R's share balance is then read (again if it lags)
    const settleDeposit = async (w: EarnWallet, logs: Log[], o: Open) => {
      const R = w.r.evm; const amount = big(o.amount), before = big(o.before);
      const out = depositOutcome(logs, cfg, R, amount, big(o.minOut));
      if ('why' in out) { unknownPrincipal(w, c); throw new Anomaly(out.why); }
      booked(w, c, sc.to6(amount), o, before + out.shares);
      if ((await confirm(w, self, false)) !== 'ok') { resetLater(w, c); return; }
      const [al] = await evm().multi([{ to: cfg.asset, data: enc('allowance', [R, cfg.vault]) }]);
      if (dec('allowance', al) !== 0n) await resetAllowance(w, c, cfg.asset, cfg.vault, approveData(cfg, 0n), () => false).catch(() => resetLater(w, c));
    };
    const deposit = async (w: EarnWallet, p: Pos, amount: bigint, yieldNow: () => boolean) => {
      const R = w.r.evm; const e = evm();
      if (p.liquid < amount) throw new Deferred('the reserve no longer holds that much');
      // a left-over allowance (a deposit stopped between its two transactions): used if it fits this deposit, else set back to 0
      let allowance = p.allowance;
      if (allowance > 0n) {
        if (allowance <= amount && sc.to6(allowance) >= EARN.depositMin6) amount = allowance;
        else { await resetAllowance(w, c, cfg.asset, cfg.vault, approveData(cfg, 0n), yieldNow); allowance = 0n; }
      }
      const [pv] = await e.multi([{ to: cfg.vault, data: enc('previewDeposit', [amount]) }]);
      const exp = dec('previewDeposit', pv); if (typeof exp !== 'bigint' || exp === 0n) throw new Deferred('the vault did not preview the deposit');
      const minShares = exp - bps(exp, EARN.depositSlipBps);
      if (allowance === 0n) {
        const tx = { to: cfg.asset, data: approveData(cfg, amount), value: 0n };
        if (dec('approve', await e.call({ ...tx, from: R }).catch(() => null)) !== true) throw new Deferred('the approval did not simulate');
        const gas = await gasFor(w, tx);
        const h = await sendEvm(w, c, tx, gas, yieldNow, { kind: 'approve', amount: String(amount), minOut: '0', maxIn: '0', before: String(p.position) });
        await landed(w, c, h, EARN.receiptMs);
        setOpen(w, c, undefined);
        const [al] = await e.multi([{ to: cfg.asset, data: enc('allowance', [R, cfg.vault]) }]);
        if (dec('allowance', al) !== amount) throw new Anomaly('the allowance is not the exact amount after the approval');
      }
      const tx = { to: cfg.vault, data: depositData(amount, R), value: 0n };
      let sim: unknown = null; try { sim = dec('deposit', await e.call({ ...tx, from: R })); } catch { sim = null; }
      if (typeof sim !== 'bigint' || sim < minShares) {
        // L6: the exact approval is set back to 0 now, or the next tick does it (never swallowed)
        await resetAllowance(w, c, cfg.asset, cfg.vault, approveData(cfg, 0n), yieldNow).catch(() => resetLater(w, c));
        throw new Deferred(typeof sim !== 'bigint' ? 'the deposit did not simulate' : 'the vault would mint fewer shares than it previews');
      }
      const gas = await gasFor(w, tx);
      const open = { kind: 'deposit' as const, amount: String(amount), minOut: String(minShares), maxIn: String(amount), before: String(p.position) };
      const h = await sendEvm(w, c, tx, gas, yieldNow, open);
      const r = await landed(w, c, h, EARN.receiptMs);
      await settleDeposit(w, r.logs, { ...open, hash: h, at: deps.now(), ...seenAt(r) });
    };
    const settleWithdraw = async (w: EarnWallet, logs: Log[], o: Open, click: boolean): Promise<bigint> => {
      const R = w.r.evm; const before = big(o.before);
      const out = withdrawOutcome(logs, cfg, R, big(o.minOut), big(o.maxIn));
      if ('why' in out) { unknownPrincipal(w, c); throw new Anomaly(out.why); }
      paidOut(w, c, sc.to6(out.assets), out.shares, before, o, before - out.shares, out.assets, click);
      await confirm(w, self, click);
      return out.assets;
    };
    const finish = async (w: EarnWallet, tx: EarnTx, minAssets: bigint, maxShares: bigint, before: bigint, click: boolean, yieldNow: () => boolean, gas: bigint) => {
      const open = { kind: 'withdraw' as const, amount: '0', minOut: String(minAssets), maxIn: String(maxShares), before: String(before) };
      const h = await sendEvm(w, c, tx, gas, yieldNow, open, click);
      const r = await landed(w, c, h, click ? EARN.clickReceiptMs : EARN.receiptMs, click);
      return settleWithdraw(w, r.logs, { ...open, hash: h, at: deps.now(), ...seenAt(r) }, click);
    };
    // a click simulates once (review M3); the background halves down to EARN.probes simulations
    const part = async (w: EarnWallet, p: Pos, assets: bigint, click: boolean, yieldNow: () => boolean) => {
      const R = w.r.evm;
      for (let i = 0; i < (oneSim(w, c) ? 1 : EARN.probes) && assets > 0n; i++, assets /= 2n) {
        const tx = { to: cfg.vault, data: withdrawData(assets, R), value: 0n };
        // (M3: a click reads the preview, simulates and estimates at once)
        const [[pv], sg] = await Promise.all([evm().multi([{ to: cfg.vault, data: enc('previewWithdraw', [assets]) }], click), simGas(w, tx, oneSim(w, c))]);
        const exp = dec('previewWithdraw', pv); if (typeof exp !== 'bigint' || exp === 0n) throw new Deferred('the vault did not preview the withdrawal');
        const maxShares = exp + bps(exp, EARN.withdrawSlipBps) + 1n;
        const sim = dec('withdraw', sg.ret);
        if (typeof sim !== 'bigint') continue;   // the vault cannot pay that much now: try half
        if (sim > maxShares || sim > p.position) throw new Anomaly('the vault would burn more shares than it previews');
        return finish(w, tx, assets, maxShares, p.position, click, yieldNow, gasOf(sg.gas));
      }
      throw new Deferred('the vault cannot pay that out right now (its liquidity is short)');
    };
    const withdraw = async (w: EarnWallet, p: Pos, usd6: bigint, all: boolean, click: boolean, yieldNow: () => boolean): Promise<bigint> => {
      const R = w.r.evm;
      if (p.position === 0n) throw new Deferred('nothing in Earn');
      const assets = min(sc.raw(usd6), p.assets);
      if (!(all || assets >= p.assets)) return part(w, p, assets, click, yieldNow);
      const tx = { to: cfg.vault, data: redeemData(p.position, R), value: 0n };
      const sg = await simGas(w, tx, oneSim(w, c)); const sim = dec('redeem', sg.ret);
      if (typeof sim !== 'bigint') { if (oneSim(w, c)) throw new Deferred('the vault cannot pay that out right now (its liquidity is short)'); return part(w, p, p.assets / 2n, click, yieldNow); }
      const minAssets = p.assets - bps(p.assets, EARN.withdrawSlipBps);
      if (sim < minAssets) throw new Anomaly('the vault would pay less than the shares are worth');
      return finish(w, tx, minAssets, p.position, p.position, click, yieldNow, gasOf(sg.gas));
    };
    const follow = async (w: EarnWallet, o: Open): Promise<'waiting' | 'missing' | 'settled'> => {
      const r = await rcpt(o.hash);
      if (r === 'missing') return 'missing'; if (!r) return 'waiting';
      if (r.status !== 'success') { setOpen(w, c, undefined); throw new Anomaly('an Earn transaction reverted on chain'); }
      const o2 = { ...o, ...seenAt(r) };
      if (o.kind === 'deposit') await settleDeposit(w, r.logs, o2);
      else if (o.kind === 'withdraw') await settleWithdraw(w, r.logs, o2, false);
      else setOpen(w, c, undefined);
      return 'settled';
    };
    // H2: the vault's Deposit (owner = R) and Withdraw (owner = R) events
    const scanLogs = async (w: EarnWallet, from: bigint, to: bigint) => {
      const e = evm(); const R = pad32(w.r.evm);
      // r3 (re-review N1): only moves R itself SIGNED — Deposit / Withdraw with sender (topic 1) = R. Anyone may deposit FOR R
      // (receiver = R): a stranger's gift is never "another device"
      const [a, b] = await Promise.all([e.logs!({ address: cfg.vault, topics: [TOPIC.deposit, R], fromBlock: from, toBlock: to }), e.logs!({ address: cfg.vault, topics: [TOPIC.withdraw, R], fromBlock: from, toBlock: to })]);
      return [...a, ...b].map((l) => lc(l.tx));
    };
    const reset = (w: EarnWallet, yieldNow: () => boolean) => resetAllowance(w, c, cfg.asset, cfg.vault, approveData(cfg, 0n), yieldNow);
    self = { chain: c, cfg, ...sc, facts, redeemable, deposit, withdraw, follow, verify, scanLogs, reset };
    return self;
  }

  // ── BNB: Aave v3 ──
  function aaveVenue(cfg: AaveCfg): Venue {
    const c: EarnChain = 'bsc'; const sc = scale(cfg.assetDecimals);
    let self: Venue;
    const enc2 = (fn: string, args: readonly unknown[] = []) => encA(AAVE_ABI, fn, args);
    const dec2 = (fn: string, data: Hex | null) => decA(AAVE_ABI, fn, data);
    const facts = async (w: EarnWallet, now = false): Promise<Pos> => {
      const e = evm(); const R = w.r.evm;
      const res = await e.multi([
        { to: cfg.aToken, data: enc2('balanceOf', [R]) }, { to: cfg.asset, data: enc2('balanceOf', [R]) }, { to: cfg.asset, data: enc2('allowance', [R, cfg.pool]) },
        { to: cfg.pool, data: getReserveDataData(cfg.asset) }, { to: cfg.pool, data: enc2('getVirtualUnderlyingBalance', [cfg.asset]) },
        { to: cfg.aToken, data: enc2('UNDERLYING_ASSET_ADDRESS') }, { to: cfg.aToken, data: enc2('POOL') }, { to: cfg.pool, data: enc2('ADDRESSES_PROVIDER') },
      ], now);
      const n = (i: number, fn: string) => { const v = dec2(fn, res[i]); return typeof v === 'bigint' ? v : null; };
      const aBal = n(0, 'balanceOf'), liquid = n(1, 'balanceOf'), allowance = n(2, 'allowance');
      if (aBal == null || liquid == null || allowance == null) throw new Deferred('the reserve was not read');
      // M7: what the Pool can pay is its virtual balance (v3.1+), not USDC.balanceOf(aToken)
      const rf = reserveFacts(res[3]); const avail = n(4, 'getVirtualUnderlyingBalance');
      const und = dec2('UNDERLYING_ASSET_ADDRESS', res[5]), apool = dec2('POOL', res[6]), prov = dec2('ADDRESSES_PROVIDER', res[7]);
      // the proxies' implementations (EIP-1967 slots): the Pool, the aToken (vaultCheckMs) and USDC itself (implCheckMs, L5)
      const vs = vstate(c);
      if (due(c, vs.codeAt, EARN.vaultCheckMs, now) || due(c, vs.implAt, EARN.implCheckMs, now)) {
        if (!e.storageAt) throw new Deferred('this frame cannot read the Aave implementation');
        const [pi, ai, ui] = await Promise.all([e.storageAt(cfg.pool, EIP1967_IMPL as Hex), e.storageAt(cfg.aToken, EIP1967_IMPL as Hex), e.storageAt(cfg.asset, EIP1967_IMPL as Hex)]).catch(() => [null, null, null]);
        const [p1, a1, u1] = [implOf(pi), implOf(ai), implOf(ui)];
        if (!p1 || !a1 || !u1) throw new Deferred('the Aave implementation was not read');
        codeSeen.add(c); saveV(c, { ...vstate(c), codeOk: p1 === lc(cfg.poolImpl) && a1 === lc(cfg.aTokenImpl), codeAt: deps.now(), implOk: u1 === lc(cfg.assetImpl), implAt: deps.now() });
      }
      const codeOk = vstate(c).codeOk !== false, implOk = vstate(c).implOk !== false;
      const price6 = rf ? rf.index / 1_000_000_000_000_000_000_000n : null;   // liquidityIndex (ray) → 1e6
      let risk: Risk | null = null;
      if (!rf || lc(rf.aToken) !== lc(cfg.aToken) || typeof und !== 'string' || lc(und) !== lc(cfg.asset) || typeof apool !== 'string' || lc(apool) !== lc(cfg.pool)) risk = { cls: 'hard', why: 'the Aave reserve names other contracts', upd: true };
      else if (typeof prov !== 'string' || lc(prov) !== lc(cfg.addressesProvider)) risk = { cls: 'hard', why: 'the Aave pool names another addresses provider', upd: true };
      else if (!rf.active || rf.paused) risk = { cls: 'riskOff', why: 'Aave paused this reserve' };
      else if (rf.frozen) risk = { cls: 'riskOff', why: 'Aave froze this reserve' };
      else if (price6 != null && big(vstate(c).hwm6) > 0n && price6 < big(vstate(c).hwm6)) risk = { cls: 'riskOff', why: 'Aave\'s liquidity index went down' };
      else if (!codeOk) risk = { cls: 'changed', why: 'Aave upgraded its contracts' };
      else if (!implOk) risk = { cls: 'changed', why: 'USDC\'s token contract on BNB Chain was upgraded' };
      const gas = now ? 0n : await e.balance(R, now).catch(() => 0n);
      return { position: aBal, assets: aBal, liquid, allowance, price6, available: avail, apyBps: rf ? aaveApyBps(rf.rateRay) : null, risk, gas };
    };
    const redeemable = async (_w: EarnWallet, p: Pos) => (p.available != null ? min(p.available, p.assets) : 0n);
    const aOf = async (w: EarnWallet, now = false) => { const [ab] = await evm().multi([{ to: cfg.aToken, data: enc2('balanceOf', [w.r.evm]) }], now); const v = dec2('balanceOf', ab); return typeof v === 'bigint' ? v : null; };
    // r3 (re-review N1): lower bounds only (anyone may supply FOR R: a gift never stops Earn), the receipt read again outside a click
    const verify = async (w: EarnWallet, o: Open, now = false): Promise<VState> => verifyEvm(o, await aOf(w, now), (after) => o.kind !== 'deposit' || after + 2n >= big(o.before) + big(o.amount), now);
    const deposit = async (w: EarnWallet, p: Pos, amount: bigint, yieldNow: () => boolean) => {
      const R = w.r.evm; const e = evm();
      if (p.liquid < amount) throw new Deferred('the reserve no longer holds that much');
      let allowance = p.allowance;
      if (allowance > 0n) {
        if (allowance <= amount && sc.to6(allowance) >= EARN.depositMin6) amount = allowance;
        else { await resetAllowance(w, c, cfg.asset, cfg.pool, aaveApproveData(cfg, 0n), yieldNow); allowance = 0n; }
      }
      if (allowance === 0n) {
        const tx = { to: cfg.asset, data: aaveApproveData(cfg, amount), value: 0n };
        if (dec2('approve', await e.call({ ...tx, from: R }).catch(() => null)) !== true) throw new Deferred('the approval did not simulate');
        const gas = await gasFor(w, tx);
        const h = await sendEvm(w, c, tx, gas, yieldNow, { kind: 'approve', amount: String(amount), minOut: '0', maxIn: '0', before: String(p.position) });
        await landed(w, c, h, EARN.receiptMs);
        setOpen(w, c, undefined);
        const [al] = await e.multi([{ to: cfg.asset, data: enc2('allowance', [R, cfg.pool]) }]);
        if (dec2('allowance', al) !== amount) throw new Anomaly('the allowance is not the exact amount after the approval');
      }
      const tx = { to: cfg.pool, data: aaveSupplyData(cfg, amount, R), value: 0n };
      let ok = false; try { await e.call({ ...tx, from: R }); ok = true; } catch { ok = false; }
      if (!ok) { await resetAllowance(w, c, cfg.asset, cfg.pool, aaveApproveData(cfg, 0n), yieldNow).catch(() => resetLater(w, c)); throw new Deferred('the supply did not simulate'); }
      const gas = await gasFor(w, tx);
      const open = { kind: 'deposit' as const, amount: String(amount), minOut: '0', maxIn: String(amount), before: String(p.position) };
      const h = await sendEvm(w, c, tx, gas, yieldNow, open);
      const r = await landed(w, c, h, EARN.receiptMs);
      await settleDeposit(w, r.logs, { ...open, hash: h, at: deps.now(), ...seenAt(r) });
    };
    const settleDeposit = async (w: EarnWallet, logs: Log[], o: Open) => {
      const R = w.r.evm; const amount = big(o.amount);
      const out = aaveSupplyOutcome(logs, cfg, R, amount); if ('why' in out) { unknownPrincipal(w, c); throw new Anomaly(out.why); }
      booked(w, c, sc.to6(amount), o, big(o.before) + amount);
      if ((await confirm(w, self, false)) !== 'ok') { resetLater(w, c); return; }
      const [al] = await evm().multi([{ to: cfg.asset, data: enc2('allowance', [R, cfg.pool]) }]);
      if (dec2('allowance', al) !== 0n) await resetAllowance(w, c, cfg.asset, cfg.pool, aaveApproveData(cfg, 0n), () => false).catch(() => resetLater(w, c));
    };
    const settleWithdraw = async (w: EarnWallet, logs: Log[], o: Open, click: boolean): Promise<bigint> => {
      const R = w.r.evm; const before = big(o.before);
      const out = aaveWithdrawOutcome(logs, cfg, R, big(o.minOut)); if ('why' in out) { unknownPrincipal(w, c); throw new Anomaly(out.why); }
      // an aToken is its own value: what went out is "burnt" 1:1 (the principal shrinks by its share of the balance)
      const burnt = out.amount > before ? before : out.amount;
      paidOut(w, c, sc.to6(out.amount), burnt, before, o, before - burnt, out.amount, click);
      await confirm(w, self, click);
      return out.amount;
    };
    // M7: what the Pool's virtual balance allows, simulated; a refused simulation halves (a click: one simulation, M3)
    const withdraw = async (w: EarnWallet, p: Pos, usd6: bigint, all: boolean, click: boolean, yieldNow: () => boolean): Promise<bigint> => {
      const R = w.r.evm;
      if (p.position === 0n) throw new Deferred('nothing in Earn');
      let want = all || sc.raw(usd6) >= p.assets ? p.assets : sc.raw(usd6);
      if (p.available != null && want > p.available) want = p.available;
      for (let i = 0; i < (oneSim(w, c) ? 1 : EARN.probes) && want > 0n; i++, want /= 2n) {
        const amount = want >= p.assets ? MAX_UINT : want;
        const tx = { to: cfg.pool, data: aaveWithdrawData(cfg, amount, R), value: 0n };
        const sg = await simGas(w, tx, oneSim(w, c)); const sim = decA(AAVE_ABI, 'withdraw', sg.ret);
        if (typeof sim !== 'bigint' || sim === 0n) continue;
        const exp = amount === MAX_UINT ? p.assets : amount;
        if (sim + 2n < exp) throw new Anomaly('Aave would pay less than asked');
        const gas = gasOf(sg.gas);
        const open = { kind: 'withdraw' as const, amount: String(exp), minOut: String(exp - 2n), maxIn: String(exp), before: String(p.position) };
        const h = await sendEvm(w, c, tx, gas, yieldNow, open, click);
        const r = await landed(w, c, h, click ? EARN.clickReceiptMs : EARN.receiptMs, click);
        return settleWithdraw(w, r.logs, { ...open, hash: h, at: deps.now(), ...seenAt(r) }, click);
      }
      throw new Deferred('Aave cannot pay that out right now (its liquidity is short)');
    };
    const follow = async (w: EarnWallet, o: Open): Promise<'waiting' | 'missing' | 'settled'> => {
      const r = await rcpt(o.hash);
      if (r === 'missing') return 'missing'; if (!r) return 'waiting';
      if (r.status !== 'success') { setOpen(w, c, undefined); throw new Anomaly('an Earn transaction reverted on chain'); }
      const o2 = { ...o, ...seenAt(r) };
      if (o.kind === 'deposit') await settleDeposit(w, r.logs, o2);
      else if (o.kind === 'withdraw') await settleWithdraw(w, r.logs, o2, false);
      else setOpen(w, c, undefined);
      return 'settled';
    };
    // H2: the Pool's Supply (reserve = USDC, onBehalfOf = R) and Withdraw (reserve = USDC, user = R) events
    const scanLogs = async (w: EarnWallet, from: bigint, to: bigint) => {
      const e = evm(); const R = pad32(w.r.evm), A = pad32(cfg.asset);
      const [a, b] = await Promise.all([e.logs!({ address: cfg.pool, topics: [AAVE_TOPIC.supply, A, R], fromBlock: from, toBlock: to }), e.logs!({ address: cfg.pool, topics: [AAVE_TOPIC.withdraw, A, R], fromBlock: from, toBlock: to })]);
      // r3 (re-review N1): a Supply counts only when its caller (data word 0, msg.sender) is R — anyone may supply on behalf of R;
      // Withdraw's user (topic 2) is already msg.sender. A log without its data is not R's (never "another device")
      const mine = (l: { data?: string }) => typeof l.data === 'string' && l.data.length >= 66 && lc('0x' + l.data.slice(26, 66)) === lc(w.r.evm);
      return [...a.filter(mine), ...b].map((l) => lc(l.tx));
    };
    const reset = (w: EarnWallet, yieldNow: () => boolean) => resetAllowance(w, c, cfg.asset, cfg.pool, aaveApproveData(cfg, 0n), yieldNow);
    self = { chain: c, cfg, ...sc, facts, redeemable, deposit, withdraw, follow, verify, scanLogs, reset };
    return self;
  }

  // ── Solana: Kamino main market ──
  function kaminoVenue(cfg: KaminoCfg): Venue {
    const c: EarnChain = 'sol'; const sc = scale(cfg.assetDecimals);
    let self: Venue;
    const sol = () => { if (!deps.sol) throw new Deferred('this frame has no Solana client'); return deps.sol; };
    const atas = (w: EarnWallet) => { const R = String(w.r.sol || ''); if (!R) throw new Deferred('no Solana reserve'); return { R, rUsdc: sol().ata(R, cfg.mint), rCtoken: sol().ata(R, cfg.cMint) }; };
    const facts = async (w: EarnWallet, now = false): Promise<Pos> => {
      const { R, rUsdc, rCtoken } = atas(w);
      const got = await sol().accounts([cfg.reserve, cfg.market, rUsdc, rCtoken, R], now);
      if (got.length !== 5 || got.some((x) => x === undefined)) throw new Deferred('the reserve was not read');
      const rr = readReserve(got[0]?.data ?? null, got[0]?.owner ?? null, cfg);
      // H3: a Reserve this build cannot parse stops everything automatic (needs an app update); the user's switch-off still exits
      // through exitFacts (R's own token accounts, the pinned accounts, the simulation decides)
      if ('why' in rr) throw new Unreadable(rr.why);
      const usdc = tokenAmount(got[2]?.data ?? null, cfg.mint, R), cTok = tokenAmount(got[3]?.data ?? null, cfg.cMint, R);
      if (usdc === undefined || cTok === undefined) throw new Anomaly('a reserve token account is not R\'s');
      const marketEmergency = got[1] && got[1].owner === cfg.program && got[1].data.length > MARKET_EMERGENCY ? got[1].data[MARKET_EMERGENCY] : null;
      // the program's deploy slot, every vaultCheckMs and on the first read of a session (a sliced read of its ProgramData)
      const vs = vstate(c);
      if (due(c, vs.codeAt, EARN.vaultCheckMs, now)) {
        const slot = await sol().deploySlot(cfg.programData).catch(() => null);
        if (slot == null) throw new Deferred('the Kamino program was not read');
        codeSeen.add(c); saveV(c, { ...vstate(c), codeOk: slot === cfg.deploySlot, codeAt: deps.now() });
      }
      const k = kaminoProblem(rr, marketEmergency, vstate(c).codeOk === false ? -1n : cfg.deploySlot, cfg);
      const price6 = kPrice6(rr);
      const risk: Risk | null = k ? k : big(vstate(c).hwm6) > 0n && price6 * 10_000n < big(vstate(c).hwm6) * (10_000n - EARN.priceDropBps) ? { cls: 'riskOff', why: 'Kamino\'s exchange rate dropped' } : null;
      const position = cTok ?? 0n;
      return { position, assets: kAssets(rr, position), liquid: usdc ?? 0n, allowance: 0n, price6, available: rr.available, apyBps: null, risk, gas: BigInt(got[4]?.lamports ?? 0), k: { reserve: rr, rUsdc, rCtoken } };
    };
    // H3: R's own accounts only (no Reserve parse); the value from the last exchange rate this device read (it only grows)
    const exitFacts = async (w: EarnWallet): Promise<Pos> => {
      const { R, rUsdc, rCtoken } = atas(w);
      const got = await sol().accounts([rUsdc, rCtoken, R], true);
      if (got.length !== 3 || got.some((x) => x === undefined)) throw new Deferred('the reserve was not read');
      const usdc = tokenAmount(got[0]?.data ?? null, cfg.mint, R), cTok = tokenAmount(got[1]?.data ?? null, cfg.cMint, R);
      if (usdc === undefined || cTok === undefined) throw new Anomaly('a reserve token account is not R\'s');
      const price6 = big(vstate(c).hwm6) > big(snapOf(w, c)?.price6) ? big(vstate(c).hwm6) : big(snapOf(w, c)?.price6);
      const position = cTok ?? 0n;
      return { position, assets: price6 > 0n ? (position * price6) / 1_000_000n : 0n, liquid: usdc ?? 0n, allowance: 0n, price6: price6 || null, available: null, apyBps: null, risk: null, gas: BigInt(got[2]?.lamports ?? 0), k: { reserve: null, rUsdc, rCtoken } };
    };
    const redeemable = async (_w: EarnWallet, p: Pos) => (p.available != null ? min(p.available, p.assets) : 0n);
    const fee = (p: Pos, ataMissing: boolean) => { if (p.gas < KAMINO_FEE + (ataMissing ? KAMINO_ATA_RENT : 0n) + 890_880n) throw new Deferred('the reserve needs a little SOL'); };
    const cOf = async (w: EarnWallet, now = false) => { const { R, rCtoken } = atas(w); const [a] = await sol().accounts([rCtoken], now); if (a === undefined) return null; const v = tokenAmount(a?.data ?? null, cfg.cMint, R); return v === undefined ? null : v ?? 0n; };
    // r3 (re-review N1): R's cTokens at least what the step left (anyone may send kUSDC to R's account: a gift never stops Earn);
    // outside a click, the signature confirmed again
    const verify = async (w: EarnWallet, o: Open, now = false): Promise<VState> => {
      const cAfter = await cOf(w, now).catch(() => null); if (cAfter == null) return 'silent';
      const before = big(o.before);
      const posOk = o.kind === 'deposit' ? cAfter - before >= big(o.minOut) && cAfter > before : cAfter >= before - big(o.amount);
      // r4: a failed signature is the only positive signal here (an unknown one is silence: a node a few slots behind looks the same)
      const st = now && posOk ? 'confirmed' : await sol().status(o.hash).catch(() => undefined);
      if (st === 'failed') return 'reorg';
      if (!posOk) return 'lag';
      return st === 'confirmed' ? 'ok' : 'silent';
    };
    // simulate (R's two token accounts after it), check, send, follow: the step is open from the send on, never sent twice
    const step = async (w: EarnWallet, p: Pos, kind: 'deposit' | 'redeem', ixs: KIx[], amount: bigint, minOut: bigint, click: boolean, yieldNow: () => boolean): Promise<bigint> => {
      const { R, rUsdc, rCtoken } = { R: String(w.r.sol), rUsdc: p.k!.rUsdc, rCtoken: p.k!.rCtoken };
      const oracles = p.k!.reserve?.oracles ?? kPinnedOracles(cfg);
      const bad = kaminoIxsProblem(ixs, { r: R, rUsdc, rCtoken, oracles, perTxMax6: EARN.perTxMax6, cfg });
      if (bad) throw new Anomaly('Refusing to sign: ' + bad);
      if (wstate(w, c).open) throw new Deferred('an earlier Earn transaction is still open: followed first, nothing new is sent');
      const pre = { usdc: p.liquid, c: p.position };
      const sim = await sol().simulate(w.id, ixs, [rUsdc, rCtoken], click);
      if (sim.err) throw new Deferred(kind === 'deposit' ? 'the deposit did not simulate' : 'the vault cannot pay that out right now');
      const su = tokenAmount(sim.post[0] ?? null, cfg.mint, R), sct = tokenAmount(sim.post[1] ?? null, cfg.cMint, R);
      if (su == null || sct == null) throw new Anomaly('the simulation did not show the reserve\'s token accounts');
      // r6 (re-review M5-1): tolerant deltas, and a mismatch only in the simulation is retried next tick — nothing was sent, so
      // nothing "did not add up on chain" (a deposit's refusals still count towards failsToPause)
      const why = kaminoSimProblem(kind, pre, { usdc: su, c: sct }, amount, minOut);
      if (why) throw new Deferred('simulated: ' + why + ' (retried next tick)');
      if (late(w, c)) throw new Deferred('deferred: the step ran out of time (nothing more is sent in it)');
      if ((click ? deps.tradeLive() : deps.busy()) || yieldNow()) throw new Deferred('deferred: a trade is running');
      // what a redeem pays is the simulation's (Kamino has no events; the landed one pays at least that — the rate only grows)
      const open: Omit<Open, 'hash' | 'at'> = { kind: kind === 'deposit' ? 'deposit' : 'withdraw', amount: String(amount), minOut: String(kind === 'deposit' ? minOut : su - pre.usdc), maxIn: String(amount), before: String(pre.c), preLiquid: String(pre.usdc) };
      let sig: string;
      try { sig = await sol().send(w.id, ixs); }
      catch (x) { const lost = (x as { hash?: string }).hash; if (lost && typeof lost === 'string') { bump(w, c, click, lost); setOpen(w, c, { ...open, hash: lost, at: deps.now() }); throw new Deferred('the answer of the send was lost: followed by its signature, never sent again'); } saveW(w, c, { ...wstate(w, c), sendErrAt: deps.now() }); throw x; }
      bump(w, c, click, sig); setOpen(w, c, { ...open, hash: sig, at: deps.now() });
      const t0 = deps.now(); const ms = click ? EARN.clickReceiptMs : EARN.receiptMs;
      for (;;) {
        const st = await sol().status(sig, click).catch(() => null);
        if (st === 'failed') { setOpen(w, c, undefined); throw new Anomaly('an Earn transaction failed on chain'); }
        if (st === 'confirmed') break;
        if (deps.now() - t0 >= ms) throw new Deferred('the transaction has not landed yet: followed by the next tick');
        await deps.wait(click ? 250 : 400);
      }
      return settle(w, { ...open, hash: sig, at: deps.now() }, click);
    };
    // M2: booked at once from the step itself (a deposit's exact amount; a redeem's simulated payout); R's cTokens are then read —
    // again when the read lags (another node a few slots behind) — and only a lasting mismatch stops (followOpen)
    const settle = async (w: EarnWallet, o: Open, click: boolean): Promise<bigint> => {
      const before = big(o.before);
      if (o.kind === 'deposit') { booked(w, c, sc.to6(big(o.amount)), o, before + big(o.minOut)); await confirm(w, self, click); return big(o.amount); }
      const burnt = big(o.amount);
      // r4 (re-review L3-2): Kamino emits no events — the USDC that LANDED in R is booked when it can be read (the simulation's
      // figure otherwise); a payout under the simulation (the rate fell between the two) is booked as it landed, and said
      let paid = big(o.minOut);
      const R = String(w.r.sol);
      const [ua] = await sol().accounts([sol().ata(R, cfg.mint)], click).catch(() => [undefined]);
      const uAfter = ua === undefined ? null : tokenAmount(ua?.data ?? null, cfg.mint, R);
      if (uAfter != null && o.preLiquid != null) { const landedRaw = uAfter - big(o.preLiquid); if (landedRaw > 0n) { if (landedRaw < paid) emit(w, c, 'withdraw', 'short', { simulated: Number(sc.to6(paid)) / 1e6, landed: Number(sc.to6(landedRaw)) / 1e6 }); paid = landedRaw; } }
      paidOut(w, c, sc.to6(paid), burnt, before, o, before - burnt, paid, click);
      await confirm(w, self, click);
      return paid;
    };
    const deposit = async (w: EarnWallet, p: Pos, amount: bigint, yieldNow: () => boolean) => {
      if (!p.k?.reserve) throw new Deferred('the reserve was not read');
      if (p.liquid < amount) throw new Deferred('the reserve no longer holds that much');
      fee(p, true);
      const exp = p.k.reserve.totalLiquidity > 0n ? (amount * p.k.reserve.cSupply) / p.k.reserve.totalLiquidity : 0n;
      if (!(exp > 0n)) throw new Deferred('Kamino did not value the deposit');
      const minC = exp - (exp * KAMINO_SLIP_BPS) / 10_000n;
      await step(w, p, 'deposit', kDepositIxs(cfg, String(w.r.sol), p.k.rUsdc, p.k.rCtoken, p.k.reserve.oracles, amount), amount, minC, false, yieldNow);
    };
    const withdraw = async (w: EarnWallet, p: Pos, usd6: bigint, all: boolean, click: boolean, yieldNow: () => boolean): Promise<bigint> => {
      if (!p.k) throw new Deferred('the reserve was not read');
      if (p.position === 0n) throw new Deferred('nothing in Earn');
      fee(p, true);
      const rr = p.k.reserve;
      if (!rr) {
        // H3: every cToken, the pinned accounts and oracles, the floor from the last rate this device read: klend's simulation decides
        let floor = kRedeemFloor(p.position, p.price6 ?? 0n);
        if (!(floor > 0n)) throw new Deferred('this device never read Kamino\'s rate: the withdrawal needs an app update');
        const ixs = kRedeemIxs(cfg, String(w.r.sol), p.k.rUsdc, p.k.rCtoken, kPinnedOracles(cfg), p.position);
        // r3 (re-review L-a): klend can socialize a loss (its rate goes DOWN): what it pays now is what the simulation shows. Under
        // the floor, the user is told the figure; his own withdraw again within 10 min accepts it (never automatically)
        const pre = await sol().simulate(w.id, ixs, [p.k.rUsdc, p.k.rCtoken], click);
        const su = pre.err ? null : tokenAmount(pre.post[0] ?? null, cfg.mint, String(w.r.sol));
        const paid = su != null ? su - p.liquid : 0n;
        if (paid > 0n && paid < floor) {
          const s = wstate(w, c);
          if (mode.get(stepKey(w, c)) !== 'user' || !s.lossOk || deps.now() - s.lossOk.at > 600_000) {
            saveW(w, c, { ...s, lossOk: { at: deps.now(), paid: String(paid) } });
            throw new Deferred(`Kamino would pay ${fmtUsd6(sc.to6(paid))} for what was worth ${fmtUsd6(sc.to6(floor))} at the last rate this device read (a loss on Kamino's side). Withdraw again within 10 minutes to accept it`);
          }
          const n = { ...s }; delete n.lossOk; saveW(w, c, n);
          floor = paid - (paid * KAMINO_SLIP_BPS) / 10_000n - 1n;
        }
        return step(w, p, 'redeem', ixs, p.position, floor > 0n ? floor : 1n, click, yieldNow);
      }
      let cTok = all || sc.raw(usd6) >= p.assets ? p.position : min(kCollateralFor(rr, sc.raw(usd6)), p.position);
      // the reserve's liquidity is short: only what it holds now
      if (kAssets(rr, cTok) > rr.available) cTok = min(kCollateralFor(rr, rr.available) - 1n, p.position);
      if (!(cTok > 0n)) throw new Deferred('Kamino cannot pay that out right now (its liquidity is short)');
      const exp = kAssets(rr, cTok); const minU = exp - (exp * KAMINO_SLIP_BPS) / 10_000n - 1n;
      return step(w, p, 'redeem', kRedeemIxs(cfg, String(w.r.sol), p.k.rUsdc, p.k.rCtoken, rr.oracles, cTok), cTok, minU > 0n ? minU : 1n, click, yieldNow);
    };
    const follow = async (w: EarnWallet, o: Open): Promise<'waiting' | 'missing' | 'settled'> => {
      const st = await sol().status(o.hash).catch(() => undefined);
      if (st === undefined) return 'waiting'; if (st == null) return 'missing';
      if (st === 'failed') { setOpen(w, c, undefined); throw new Anomaly('an Earn transaction failed on chain'); }
      await settle(w, o, false);
      return 'settled';
    };
    self = { chain: c, cfg, ...sc, facts, redeemable, deposit, withdraw, follow, verify, exitFacts };
    return self;
  }

  const venues = new Map<EarnChain, Venue>();
  const venue = (): Venue | null => {
    const c = chainHere(); const v = c ? earnVenueOf(c) : null; if (!c || !v) return null;
    let x = venues.get(c);
    if (!x) { x = v.kind === 'erc4626' ? morphoVenue(v) : v.kind === 'aave3' ? aaveVenue(v) : kaminoVenue(v); venues.set(c, x); }
    return x;
  };

  // ── the venue's read: snapshot, share-price samples (the live rate), the day's "Earned" mark ──
  function writeSnap(w: EarnWallet, v: Venue, p: Pos, red: bigint | null, buffer6: bigint) {
    const c = v.chain; const old = snapOf(w, c);
    saveSnap(w, c, { at: deps.now(), position: String(p.position), assets6: String(v.to6(p.assets)),
      redeemable6: red != null ? String(v.to6(red)) : old && old.position === String(p.position) ? old.redeemable6 : '0', redeemableAt: red != null ? deps.now() : old?.redeemableAt ?? 0,
      liquid6: String(v.to6(p.liquid)), price6: String(p.price6 ?? 0n), buffer6: String(buffer6), apyBps: p.apyBps });
    if (p.price6 != null && p.price6 > 0n) sample(c, p.price6);
    mark(w, c);
  }
  const sampleKey = (c: EarnChain) => K.samples + c;
  function sample(c: EarnChain, p6: bigint) {
    const list = read<{ at: number; p: string }[]>(sampleKey(c), []);
    const last = list[list.length - 1];
    if (last && deps.now() - last.at < 3_600_000) return;
    deps.store.set(sampleKey(c), json([...list.filter((x) => deps.now() - x.at < 45 * 86_400_000), { at: deps.now(), p: String(p6) }].slice(-1200)));
  }
  const dailyKey = (w: EarnWallet, c: EarnChain) => `${K.daily}${c}.${rOf(w, c)}`;
  /** lifetime "Earned" = the value now less what is still in + what came out above what went in (realized); unknown (null) while
   *  a deposit / withdrawal is sent but not booked yet (review M2) */
  function lifetime6(w: EarnWallet, c: EarnChain): bigint | null {
    const s = read<WState | null>(wkey(w, c), null); const sn = snapOf(w, c);
    if (!s || s.principal6 == null) return null;
    if (s.open && !s.open.booked && (s.open.kind === 'deposit' || s.open.kind === 'withdraw')) return null;
    return (sn ? big(sn.assets6) : 0n) - big(s.principal6) + big(s.realized6);
  }
  function mark(w: EarnWallet, c: EarnChain) {
    const life = lifetime6(w, c); if (life == null) return;
    const day = dayOf(deps.now()); const list = read<{ day: string; life6: string }[]>(dailyKey(w, c), []);
    const next = list.length && list[list.length - 1].day === day ? [...list.slice(0, -1), { day, life6: String(life) }] : [...list, { day, life6: String(life) }];
    deps.store.set(dailyKey(w, c), json(next.slice(-45)));
  }
  function earned30(w: EarnWallet, c: EarnChain): bigint | null {
    const life = lifetime6(w, c); if (life == null) return null;
    const list = read<{ day: string; life6: string }[]>(dailyKey(w, c), []);
    const cut = dayOf(deps.now() - 30 * 86_400_000);
    const base = [...list].reverse().find((x) => x.day <= cut) ?? null;
    return base ? life - big(base.life6) : life;   // younger than 30 days: since it started
  }
  // ── the server's monitor (read-only, risk-off only) ──
  let monitorMemo: { at: number; v: Awaited<ReturnType<NonNullable<EarnDeps['monitor']>>> } | null = null;
  async function monitorOf(c: EarnChain): Promise<{ pause?: string; hold?: string; apyBps?: number; at: number } | null> {
    if (!deps.monitor) return null;
    if (!monitorMemo || deps.now() - monitorMemo.at > 60_000) monitorMemo = { at: deps.now(), v: await deps.monitor().catch(() => null) };
    if (!monitorMemo.v) return null;   // no answer: nothing changes
    return { ...(monitorMemo.v[c] ?? {}), at: monitorMemo.at };
  }
  /** review M1: the monitor's pause acts only once it is in EARN.monitorTicks answers in a row (one node's bad answer is not
   *  enough), and a clean answer clears the pause it raised (the engine's own findings stay until the user's next "on"). */
  function monitorStep(c: EarnChain, mon: { pause?: string; hold?: string; at: number } | null) {
    if (!mon) return;
    const vs = vstate(c);
    const flag: Risk | null = mon.pause ? { cls: 'riskOff', why: 'motion\'s monitor: ' + mon.pause } : mon.hold ? { cls: 'changed', why: 'motion\'s monitor: ' + mon.hold } : null;
    if (flag) {
      if (vs.mon?.at !== mon.at) saveV(c, { ...vs, mon: { n: (vs.mon?.n ?? 0) + 1, at: mon.at } });
      if ((vstate(c).mon?.n ?? 0) >= EARN.monitorTicks) {
        // the monitor's own earlier flag of another class is replaced (a pause that became a hold, and back)
        const v2 = vstate(c); if (v2.pause?.src === 'monitor' && v2.pause.cls !== flag.cls) { const n = { ...v2 }; delete n.pause; saveV(c, n); }
        venuePause(c, flag, 'monitor');
      }
      return;
    }
    if (!vs.mon?.n && vs.pause?.src !== 'monitor') return;
    const n: VaultState = { ...vs, mon: { n: 0, at: mon.at } };
    if (n.pause?.src === 'monitor') { delete n.pause; emit(null, c, 'resumed', 'done', { src: 'monitor' }); }
    saveV(c, n);
  }
  const apyOf = (c: EarnChain, sn: Snap | null): { bps: number; basis: 'now' | '7d' | '30d' } | null => {
    const s = read<{ at: number; p: string }[]>(sampleKey(c), []).map((x) => ({ at: x.at, p: big(x.p) }));
    const a30 = apyFromSamples(s, 30 * 86_400_000, deps.now()); if (a30 != null) return { bps: a30, basis: '30d' };
    const a7 = apyFromSamples(s, 7 * 86_400_000, deps.now()); if (a7 != null) return { bps: a7, basis: '7d' };
    if (sn?.apyBps != null) return { bps: sn.apyBps, basis: 'now' };
    return null;
  };

  let geoMemo: { at: number; ok: boolean; cap6?: string | null } | null = null;
  async function geoOk(): Promise<boolean> {
    const g = geoMemo ?? read<{ at: number; ok: boolean; cap6?: string | null } | null>(K.geo, null);
    if (g && deps.now() - g.at < EARN.geoMs) return g.ok === true;
    let ok = false, cap6: string | null = null;
    try {
      const r = await deps.geo();
      ok = r === true || (!!r && typeof r === 'object' && r.on === true);
      // earn-ship (owner gate): the server's cap per account, clamped to [capMin6, capMax6]; anything else = none
      const u = r && typeof r === 'object' && typeof r.capUsd === 'number' ? r.capUsd : NaN;
      if (ok && Number.isFinite(u) && u > 0) { const c6 = BigInt(Math.floor(u)) * USD; cap6 = String(c6 < EARN.capMin6 ? EARN.capMin6 : c6 > EARN.capMax6 ? EARN.capMax6 : c6); }
    } catch { ok = false; cap6 = null; }
    geoMemo = { at: deps.now(), ok, cap6 }; deps.store.set(K.geo, json(geoMemo));
    return ok;
  }
  /** earn-ship (owner gate): the server's per-account cap from the last geo answer (null = none: the account's own cap stands). */
  const serverCap6 = (): bigint | null => { const g = geoMemo ?? read<{ at: number; ok: boolean; cap6?: string | null } | null>(K.geo, null); return g && g.ok === true && g.cap6 ? big(g.cap6) : null; };
  /** What the account may keep in Earn now: its own cap, lowered to the server's when the server says less. */
  const capNow6 = (own: bigint): bigint => { const s = serverCap6(); return s != null && s < own ? s : own; };
  /** The account's dollars in Earn as this vault's snapshots last read them (every wallet, every chain). */
  const accountAssets6 = () => deps.wallets().reduce((t, w) => t + EARN_CHAINS.reduce((u, c) => u + big(snapOf(w, c)?.assets6), 0n), 0n);
  const holdsOn = (w: EarnWallet, c: EarnChain) => big(snapOf(w, c)?.position) > 0n || !!wstate(w, c).open;

  /** A step sent earlier whose answer was lost, whose receipt did not come in time, or whose booked position read lagged (M2):
   *  settled from its receipt / re-read, never re-sent. true = nothing open any more. */
  async function followOpen(w: EarnWallet, v: Venue): Promise<boolean> {
    const o = wstate(w, v.chain).open; if (!o) return true;
    try {
      if (!o.booked) {
        const r = await v.follow(w, o);
        // r4 (M3-1): only nodes ANSWERING "not found" for openMs count; silence (no answer) never stops anything
        if (r === 'missing') { const since = o.missingSince ?? deps.now(); if (!o.missingSince) setOpen(w, v.chain, { ...o, missingSince: since }); if (deps.now() - since > EARN.openMs) { setOpen(w, v.chain, undefined); hardPause(w, v.chain, 'an Earn transaction never showed up on chain'); } return false; }
        if (r === 'waiting') {
          // r5 (re-review X2): silence is bounded. Past openMs, a step whose nonce R has moved past with no receipt shown is dropped
          // (Solana: its blockhash expired long before) — closed, what went in unknown (if it did land, the next read shows it);
          // while R's nonce has not moved it may still be pending: followed up to an hour, then closed the same way
          const age = deps.now() - o.at;
          if (age <= EARN.openMs) return false;
          let moved: boolean | null = null;
          // r6 (L5-1): "moved" = R's confirmed nonce is past the step's OWN nonce (a transaction with that nonce is in the chain, and no
          // node shows ours: dropped or replaced); unknown nonce: only the hour closes it
          if (v.chain !== 'sol' && o.nonce != null && deps.evm?.nonce) { const n = await deps.evm.nonce(w.r.evm).catch(() => null); moved = n == null ? null : n > o.nonce; }
          if (v.chain === 'sol' || moved === true || age > 6 * EARN.openMs) { closeUnconfirmed(w, v.chain, o); return true; }
          return false;
        }
        if (!wstate(w, v.chain).open) return true;
      }
      const st = await confirm(w, v, false);
      if (st === 'ok') return true;
      const o2 = wstate(w, v.chain).open;
      // r4 (M3-1): a POSITIVE reorg signal (reverted / failed, or gone with its block replaced): what went in is unknown, a hard stop
      if (st === 'reorg') { unknownPrincipal(w, v.chain); hardPause(w, v.chain, 'a landed Earn transaction is gone from the chain (a reorg)'); return false; }
      // silence past verifyMs while R's position agrees: the receipt was seen with success and its own events booked — accepted
      if (o2?.booked && st === 'silent' && deps.now() - (o2.verifyFrom ?? o2.at) > EARN.verifyMs) { setOpen(w, v.chain, undefined); emit(w, v.chain, 'verify', 'done', { why: 'accepted: the receipt was seen and booked; its re-read went unanswered' }); return true; }
      // r5 (re-review X3): R's position still short of what the step must have left after verifyMs (another device moved it, a node
      // that never catches up): the step is closed against the fresh read — what went in becomes unknown ("Earned" —), no stop;
      // the next read is the new baseline
      if (o2?.booked && st === 'lag' && deps.now() - (o2.verifyFrom ?? o2.at) > EARN.verifyMs) { unknownPrincipal(w, v.chain); emit(w, v.chain, 'verify', 'rebaselined', { why: 'R\'s position never showed the booked step: closed against a fresh read; "Earned" unknown' }); return true; }
      return false;
    } catch (x) {
      if (x instanceof Deferred) return false;
      setOpen(w, v.chain, undefined); hardPause(w, v.chain, String((x as Error).message), x instanceof Unreadable); return false;
    }
  }
  /** r4 (re-review L3-3): a click's withdrawal re-read after 30 s for the books — still there: done; a positive reorg: what went in is
   *  unknown ("Earned" —; the next read shows what R holds); silence: again later, dropped after an hour */
  async function recheckClicks(w: EarnWallet, c: EarnChain) {
    const list = wstate(w, c).recheck ?? []; if (!list.length || !deps.evm) return;
    const keep: typeof list = [];
    for (const x of list) {
      if (deps.now() - x.at < 30_000) { keep.push(x); continue; }
      const rs = await receiptState(x).catch(() => 'silent' as const);
      if (rs === 'reorg') { unknownPrincipal(w, c); emit(w, c, 'withdraw', 'reorged', { hash: x.hash }); }
      else if (rs === 'silent' && deps.now() - x.at < 3_600_000) keep.push(x);
    }
    saveW(w, c, { ...wstate(w, c), recheck: keep });
  }
  /** r5 (X2): a sent step no node ever confirmed — closed; what went in is unknown (never a stop: nothing proved it went wrong) */
  function closeUnconfirmed(w: EarnWallet, c: EarnChain, o: Open) {
    unknownPrincipal(w, c);
    emit(w, c, o.kind, 'unconfirmed', { hash: o.hash, why: 'no node confirmed this transaction: closed; "Earned" unknown until the next read' });
  }
  /** What a thrown step means: an anomaly stops everything automatic (funds stay), anything else backs off — 10 min, doubling
   *  with each failure in a row up to 16× (review H1: the switch-off's withdrawals too). */
  function failed(w: EarnWallet, c: EarnChain, x: unknown, kind: string) {
    const m = String((x as Error)?.message || x).slice(0, 160);
    if (x instanceof Anomaly) { hardPause(w, c, m, x instanceof Unreadable); return { ok: false, step: kind, paused: m, cls: 'hard' }; }
    if (/^deferred:/.test(m)) return { ok: true, step: 'none', why: 'click' };
    const s = wstate(w, c); const streak = (s.streak ?? 0) + 1;
    const fails = kind === 'deposit' && /simulate|preview|fewer shares|value the deposit/.test(m) ? s.fails + 1 : s.fails;
    saveW(w, c, { ...s, backoffUntil: deps.now() + EARN.backoffMs * 2 ** Math.min(streak - 1, 4), fails, streak });
    if (fails >= EARN.failsToPause) venuePause(c, { cls: 'changed', why: 'the venue refused deposits ' + fails + ' times in a row' });
    emit(w, c, kind, 'deferred', { why: m });
    return { ok: false, step: kind, why: m };
  }
  // after a step (background / the user's switch-off): R read again, with what the vault can pay now (a click never re-reads, M3)
  const resnap = (w: EarnWallet, v: Venue, buffer6: bigint, now = false) => v.facts(w, now).then(async (p) => writeSnap(w, v, p, p.position > 0n && p.risk?.cls !== 'hard' ? await v.redeemable(w, p, now).catch(() => null) : null, buffer6), () => {});

  // ── review H2: another device's Earn moves for the same reserve ──
  const markForeign = (w: EarnWallet, c: EarnChain, why: string) => {
    const s = wstate(w, c); if (s.foreign) return;
    saveW(w, c, { ...s, foreign: { at: deps.now(), why: why.slice(0, 160) }, principal6: null });
    emit(w, c, 'passive', 'failed', { why: why.slice(0, 160) });
  };
  /** Did another device move this wallet's money into or out of Earn here since the last look? r3 (re-review N1): only moves R
   *  ITSELF signed count — Morpho Deposit / Withdraw with sender = R, Aave Supply by caller R / Withdraw by user R, Solana
   *  transactions R signed (its signers read) — that this device did not send. A stranger's deposit FOR R, or a transaction that
   *  merely lists R's account, is never "another device". r3 L-d: an R-signed move soon after this device's own send that failed
   *  without a hash is taken as that send (its principal becomes unknown), not another device's. 'ok', 'behind' (not caught up:
   *  a deposit waits), or why this device goes passive. A host without the reads (older shells, tests) answers 'ok'. */
  const chunkNow = new Map<EarnChain, bigint>();
  async function scanForeign(w: EarnWallet, v: Venue): Promise<'ok' | 'behind' | string> {
    const c = v.chain; const s = wstate(w, c);
    const own = new Set([...(s.own ?? []), ...read<HistRow[]>(histKey(w, c), []).map((r) => lc(r.hash)), ...(s.open ? [lc(s.open.hash)] : [])]);
    const why = 'another device moved this wallet\'s money in Earn on ' + CHAIN_NAME[c];
    // L-d: the moves found are this device's own unknown send when one failed without a hash just before
    const theirsOrAdopted = (list: string[]): 'ok' | string => {
      if (!list.length) return 'ok';
      const s1 = wstate(w, c);
      if (s1.sendErrAt && deps.now() - s1.sendErrAt < EARN.adoptMs) {
        const n: WState = { ...s1, own: [...(s1.own ?? []), ...list.map(lc)].slice(-120), principal6: null }; delete n.sendErrAt; saveW(w, c, n);
        emit(w, c, 'adopted', 'done', { why: 'a send of this device that failed without its hash landed' });
        return 'ok';
      }
      return why;
    };
    if (c === 'sol') {
      const so = deps.sol; if (!so?.signatures || !w.r.sol) return 'ok';
      const R = String(w.r.sol);
      const rC = so.ata(R, (v.cfg as KaminoCfg).cMint);
      // r4 (re-review L3-1, a flood of transactions listing R's cToken account): pages of 100 signatures down to the cursor, at most
      // 3 pages and 5 signer reads a tick; the window being read is kept between ticks (nothing is skipped), a flood only delays a
      // deposit — refills and the switch-off never wait for this scan
      const pend = s.scanSol ?? null;
      const until = pend ? pend.until : (s.scan?.sig ?? null);
      const since = until ? 0 : (s.scanFrom ?? deps.now() - 3_600_000);
      let before = pend?.before ?? null, newest = pend?.newest ?? null;
      const theirs = [...(pend?.theirs ?? [])];
      const keep = () => saveW(w, c, { ...wstate(w, c), scanSol: { until, before, newest, theirs: theirs.slice(-20) } });
      for (let pages = 0, reads = 0; ;) {
        if (pages >= 3) { keep(); const r0 = theirsOrAdopted(theirs); return r0 === 'ok' ? 'behind' : r0; }
        const list = await so.signatures(rC, until, before).catch(() => null); pages += 1;
        if (!list) { keep(); return 'behind'; }
        if (!newest && list[0]) newest = list[0].sig;
        let old = false;
        for (const x of list) {
          if (since && x.at != null && x.at * 1000 + 1_000 <= since) { old = true; break; }   // a first look ends where Earn was turned on
          if (!x.err && !own.has(lc(x.sig))) {
            if (!so.signers) theirs.push(x.sig);
            else {
              if (reads >= 5) { keep(); const r0 = theirsOrAdopted(theirs); return r0 === 'ok' ? 'behind' : r0; }
              reads += 1;
              const sg = await so.signers(x.sig).catch(() => null);
              if (!sg) { keep(); return 'behind'; }
              if (sg.includes(R)) theirs.push(x.sig);
            }
          }
          before = x.sig;
        }
        if (old || list.length < 100) break;
      }
      const n: WState = { ...wstate(w, c), scan: newest ? { sig: newest } : until ? { sig: until } : {} }; delete n.scanSol; saveW(w, c, n);
      return theirsOrAdopted(theirs);
    }
    const e = deps.evm; if (!e?.logs || !e.head || !v.scanLogs) return 'ok';
    const head = await e.head().catch(() => null); if (head == null) return 'behind';
    const hour = EARN.scanBlocks[c] ?? 10_000n;
    let from: bigint;
    if (s.scan?.block != null) from = big(s.scan.block) + 1n;
    else {
      // a first look: from the moment Earn was turned on here (block pace), at most a day back; else the last hour
      const back = s.scanFrom ? BigInt(Math.ceil(Math.max(0, deps.now() - s.scanFrom) / (EARN.msPerBlock[c] ?? 1_000))) : hour;
      const b = back > hour * 24n ? hour * 24n : back;
      from = head > b ? head - b : 0n;
    }
    // r3 (M-a): away for more than a day — the look starts at the last hour (the nodes cap log ranges; a day of BNB is 190k blocks)
    if (head - from > hour * 24n) from = head - hour;
    let chunk = chunkNow.get(c) ?? (EARN.scanChunk[c] ?? 2_000n);
    for (let i = 0; i < EARN.scanMax && from <= head; i++) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head;
      const txs = await v.scanLogs(w, from, to).catch(() => null);
      // r3 (M-a): a refused range (48 Club caps at 5,000 blocks; others "limit exceeded") halves the chunk, down to 250 blocks
      if (!txs) { if (chunk > 250n) { chunk = chunk / 2n; chunkNow.set(c, chunk); continue; } return 'behind'; }
      saveW(w, c, { ...wstate(w, c), scan: { block: String(to) } });
      const r0 = theirsOrAdopted(txs.filter((t) => !own.has(lc(t))));
      if (r0 !== 'ok') return r0;
      from = to + 1n;
    }
    return from > head ? 'ok' : 'behind';
  }

  /**
   * The background step of one wallet on this frame's chain (floatEngine's tick, its lock held; floatEngine calls it only when
   * wants(w) — review M4). `sizes6`: the buy presets and recent buys of this chain (the buffer follows them). `yieldNow`: a click
   * wants the lock / a trade started — checked again right before a send.
   */
  async function tick(w: EarnWallet, ctx: { sizes6: readonly bigint[]; yieldNow: () => boolean; floatOn?: boolean }): Promise<Record<string, unknown>> {
    const v = venue(); if (!v) return { ok: true, step: 'none', why: 'lane' };
    const c = v.chain; const g = grantLive(); const on = onFor(c) && ctx.floatOn !== false; const exit = exiting(c); const sn = snapOf(w, c); const s00 = wstate(w, c);
    const involved = on || exit || (!!sn && big(sn.position) > 0n) || !!s00.open || big(s00.residue6) > 0n;
    if (!involved && sn && deps.now() - sn.at < 600_000) return { ok: true, step: 'none', why: 'off' };
    if (deps.busy() || ctx.yieldNow()) return { ok: true, step: 'none', why: 'click' };
    const r = await exclusive(w, c, async () => {
      if (!(await followOpen(w, v))) return { ok: true, step: 'none', why: 'following' };
      await recheckClicks(w, c);
      // a read that failed (RPC down, a node answering garbage) changes nothing: the next tick reads again
      let p: Pos;
      try { p = await v.facts(w); } catch (x) {
        const m = String((x as Error)?.message || x).slice(0, 120);
        // a venue this build cannot read the way it pins it: a hard stop (nothing automatic); a read that failed: try again next tick
        if (x instanceof Anomaly) { venuePause(c, { cls: 'hard', why: m, upd: x instanceof Unreadable }); return { ok: false, step: 'none', paused: m, cls: 'hard' }; }
        return { ok: false, step: 'none', why: 'read: ' + m };
      }
      const buffer6 = bufferOf6(ctx.sizes6, v.to6(p.liquid + p.assets));
      // the server's monitor (risk-off only, two answers in a row; review M1) and the venue's own read (sticky)
      monitorStep(c, await monitorOf(c));
      if (p.risk) venuePause(c, p.risk);
      else if (p.price6 != null && p.price6 > big(vstate(c).hwm6)) saveV(c, { ...vstate(c), hwm6: String(p.price6) });
      {
        const s0 = wstate(w, c);
        // H2: never here before, and money is already in Earn for this reserve: another device (or this app's data was reset) —
        // this device is passive for this wallet × chain until the user turns Earn on here again
        if (!known(w, c) && p.position > 0n && !s0.open) markForeign(w, c, 'money is in Earn on ' + CHAIN_NAME[c] + ' that this device did not put there');
        // nothing in Earn: what went in is known from now on (0)
        else if (s0.principal6 == null && p.position === 0n && !s0.open) saveW(w, c, { ...s0, principal6: '0' });
        // M6: what came out while the USD balance was off is shown until the USD balance holds it again or it was converted
        const s1 = wstate(w, c);
        if (big(s1.residue6) > 0n && (ctx.floatOn !== false || v.to6(p.liquid) < USD)) { const n = { ...s1 }; delete n.residue6; saveW(w, c, n); }
      }
      // (Aave / Kamino: what the venue holds now, from the read itself — no probe; Morpho: a simulation)
      const probeMs = v.cfg.kind !== 'erc4626' ? 0 : sn && big(sn.redeemable6) === 0n && (sn.redeemableAt || 0) > 0 ? 300_000 : 30_000;
      const red = p.position > 0n && (!sn || deps.now() - (sn.redeemableAt || 0) >= probeMs || sn.position !== String(p.position)) && !(p.risk?.cls === 'hard') ? await v.redeemable(w, p).catch(() => 0n) : null;
      writeSnap(w, v, p, red, buffer6);
      const mon = monitorMemo?.v?.[c];
      if (mon?.apyBps != null && snapOf(w, c)?.apyBps == null) saveSnap(w, c, { ...snapOf(w, c)!, apyBps: mon.apyBps });
      const snap = snapOf(w, c)!;
      if (exit && p.position === 0n && !wstate(w, c).open && deps.wallets().every((x) => x.id === w.id || big(snapOf(x, c)?.position) === 0n)) setExit([c], false);
      const vp = vstate(c).pause; let s = wstate(w, c);
      const hard = !!hardWhy(w, c);
      // L6: an allowance left behind (a reset that failed, or Earn is off) goes back to 0 first — this tick's step
      if (!hard && v.reset && (s.resetDue || (p.allowance > 0n && !on))) {
        if (p.allowance === 0n) { const n = { ...s }; delete n.resetDue; saveW(w, c, n); s = wstate(w, c); }
        else if (s.txDay < EARN.txPerDay) {
          if (deps.busy() || ctx.yieldNow()) return { ok: true, step: 'none', why: 'click' };
          try { await v.reset(w, ctx.yieldNow); return { ok: true, step: 'reset' }; } catch (x) { return failed(w, c, x, 'reset'); }
        }
      }
      const riskOff = vp?.cls === 'riskOff' && p.position > 0n;
      // earn-ship: the geo answer is read BEFORE the cap room (it carries the server's per-account cap)
      // release #5: no deposit before the account's self-attestation (withdrawals and the switch-off never need it)
      const geoNow = on && attested() ? await geoOk() : false;
      const step: EarnStep = earnPlan({
        // a hard stop holds everything automatic, the switch-off too (H1 / M8); the switch-off has its own day budget and backs off
        on, exit: exit || riskOff, paused: hard, passive: !!s.foreign, noDeposit: !!vp, exitToday: s.exitDay ?? 0,
        liquid6: v.to6(p.liquid), assets6: v.to6(p.assets), redeemable6: big(snap.redeemable6), buffer6,
        capRoom6: (g ? capNow6(big(g.cap6)) : 0n) - accountAssets6(), dayIn6: big(s.dayIn6), txToday: s.txDay, lastDepositAt: s.lastDepositAt, lastWithdrawAt: s.lastWithdrawAt, backoffUntil: s.backoffUntil,
        gasOk: true, geoOk: geoNow, now: deps.now(),
      });
      if (step.kind === 'none') return { ok: true, step: 'none', why: step.why, ...(vp ? { paused: vp.why, cls: vp.cls } : {}) };
      // H2: a deposit first looks for another device's moves and waits until caught up; r3 (M-a): a refill or the switch-off never
      // waits for the scan (they only bring R's own money back to R)
      const isExit = step.kind === 'withdraw' && step.why === 'exit';
      if (step.kind === 'deposit') {
        const sf = await scanForeign(w, v);
        if (sf === 'behind') return { ok: true, step: 'none', why: 'scan' };
        if (sf !== 'ok') { markForeign(w, c, sf); return { ok: true, step: 'none', why: 'another-device' }; }
      }
      if (deps.busy() || ctx.yieldNow()) return { ok: true, step: 'none', why: 'click' };
      mode.set(stepKey(w, c), isExit ? 'exit' : 'auto');
      try {
        if (step.kind === 'deposit') { await v.deposit(w, p, v.raw(step.usd6), ctx.yieldNow); await resnap(w, v, buffer6); return { ok: true, step: 'deposit', usd: Number(step.usd6) / 1e6 }; }
        const got = await v.withdraw(w, p, step.usd6, !!step.all, false, ctx.yieldNow);
        if (ctx.floatOn === false) { const s2 = wstate(w, c); saveW(w, c, { ...s2, residue6: String(big(s2.residue6) + v.to6(got)) }); }
        await resnap(w, v, buffer6);
        if (exit && deps.wallets().every((x) => big(snapOf(x, c)?.position) === 0n && !wstate(x, c).open)) setExit([c], false);
        return { ok: true, step: 'withdraw', why: riskOff && !exit ? 'risk-off' : step.why, usd: Number(v.to6(got)) / 1e6 };
      } catch (x) { await resnap(w, v, buffer6); return failed(w, c, x, step.kind); }
    });
    return r ?? { ok: true, step: 'none', why: 'busy' };
  }

  /** Synchronous, no read: does this click need anything out of Earn at all (the cached snapshot says R holds a position here and
   *  the liquid part plus W cannot pay what the top-up will want)? floatEngine asks this first, so a click without Earn — or one
   *  the buffer covers — never awaits anything of Earn's. */
  function clickNeeds(w: EarnWallet, x: { need6: bigint; liquidRaw: bigint; wReady6: bigint }): boolean {
    const v = venue(); if (!v) return false;
    const sn = snapOf(w, v.chain); if (!sn || big(sn.position) === 0n) return false;
    return clickWithdraw6(x.need6, v.to6(x.liquidRaw), x.wReady6, big(sn.assets6), big(sn.assets6)) > 0n;
  }
  /**
   * A waiting click on this chain (floatEngine's tick with `urgent`, before its plan, inside the click path's fast reads — M3),
   * only when clickNeeds said so: the missing part comes out of Earn first. Never after a hard stop nor beside an open step; one
   * simulation; waits at most EARN.clickLockMs for a background step of the same wallet. No re-read after it (the snapshot
   * follows the booked step; the plan reads R anyway). The answer: { usd } taken out, or { why } (the click goes on as before).
   */
  async function beforeClick(w: EarnWallet, x: { need6: bigint; liquidRaw: bigint; wReady6: bigint; yieldNow?: () => boolean }): Promise<{ usd: number } | { why: string } | null> {
    const v = venue(); if (!v) return null;
    if (!clickNeeds(w, x)) return null;
    const c = v.chain;
    const why0 = hardWhy(w, c); if (why0) return { why: 'Earn is paused: ' + why0 };
    // r3 (re-review L-e): another device runs Earn here: this one never withdraws for a click (that would make the other one passive)
    if (wstate(w, c).foreign) return { why: 'Earn runs on another device for this wallet' };
    if (wstate(w, c).clickDay >= EARN.clickTxPerDay) return { why: 'Earn: the day\'s withdrawals for buys are used up' };
    if (wstate(w, c).open) return { why: 'Earn: an earlier transaction is still landing' };
    const r = await exclusive(w, c, async () => {
      if (wstate(w, c).open) return { why: 'Earn: an earlier transaction is still landing' };
      try {
        const p = await v.facts(w, true);
        if (p.risk?.cls === 'hard') { venuePause(c, p.risk); return { why: 'Earn is paused: ' + p.risk.why }; }
        if (p.risk) venuePause(c, p.risk);
        const amt = clickWithdraw6(x.need6, v.to6(p.liquid), x.wReady6, v.to6(p.assets), v.to6(p.assets));
        if (amt === 0n) return { usd: 0 };
        const got = await v.withdraw(w, p, amt, amt >= v.to6(p.assets), true, () => false);
        return { usd: Number(v.to6(got)) / 1e6 };
      } catch (e) {
        const m = String((e as Error)?.message || e).slice(0, 160);
        if (e instanceof Unreadable) venuePause(c, { cls: 'hard', why: m, upd: true });
        else if (e instanceof Anomaly) hardPause(w, c, m);
        return { why: 'Earn: ' + m };
      }
    }, EARN.clickLockMs, 'click');
    return r ?? { why: 'Earn: a background step is still running' };
  }

  // ── what the USD balance's status carries (cached only) ──
  function status(w: EarnWallet, chain?: string | null) {
    const c = (chain ?? chainHere()) as EarnChain; const cfg = earnVenueOf(c);
    if (!cfg) return null;
    const sn = snapOf(w, c); const life = lifetime6(w, c); const e30 = earned30(w, c); const s = wstate(w, c);
    const assets6 = big(sn?.assets6); const apy = apyOf(c, sn); const vp = vstate(c).pause; const hw = hardWhy(w, c);
    const redeemable6 = big(sn?.redeemable6);
    return {
      chain: c, protocol: cfg.protocol, vault: cfg.name, asset: cfg.assetSymbol,
      usd: Number(assets6) / 1e6, redeemable: Number(redeemable6) / 1e6, liquid: Number(big(sn?.liquid6)) / 1e6, buffer: Number(big(sn?.buffer6)) / 1e6,
      earned: life != null && sn ? Number(life) / 1e6 : null, earned30: e30 != null && sn ? Number(e30) / 1e6 : null,
      ...(apy ? { apyBps: apy.bps, apyBasis: apy.basis } : {}),
      at: sn?.at ?? 0, ...(s.open && !s.open.booked ? { landing: true } : {}), ...(s.open?.booked ? { verifying: true } : {}),
      // (rel-12) the last deposit / withdrawal here (the USD balance's planner holds cross-chain moves around it)
      ...(Math.max(s.lastDepositAt || 0, s.lastWithdrawAt || 0) > 0 ? { stepAt: Math.max(s.lastDepositAt || 0, s.lastWithdrawAt || 0) } : {}),
      ...(hw ? { paused: hw, cls: 'hard' as const } : vp ? { paused: vp.why, cls: vp.cls } : {}),
      // M6 / H3: a stop only a new app build lifts; the venue cannot pay anything right now; another device runs Earn (H2); what
      // came out while the USD balance was off
      ...(hw && hardUpd(w, c) ? { update: true } : {}), ...(assets6 > 0n && redeemable6 === 0n && (sn?.redeemableAt ?? 0) > 0 ? { blocked: true } : {}),
      ...(s.foreign ? { foreign: true } : {}), ...(big(s.residue6) > 0n ? { residue: Number(big(s.residue6)) / 1e6 } : {}),
    };
  }
  function account() {
    const g = grant(); const live = earnLive(g, deps.now()); const ws = deps.wallets();
    const chains = Object.fromEntries(EARN_CHAINS.map((c) => {
      const rows = ws.map((w) => status(w, c)!);
      const known = rows.filter((x) => x.earned != null);
      const vp = vstate(c).pause; const hard = rows.find((x) => x.cls === 'hard');
      const apy = rows.find((x) => x.apyBps != null);
      const residue = rows.reduce((t, x) => t + (x.residue ?? 0), 0);
      return [c, { on: live && g!.chains.includes(c), exit: exiting(c), protocol: earnVenueOf(c)!.protocol, vault: earnVenueOf(c)!.name, asset: earnVenueOf(c)!.assetSymbol,
        usd: rows.reduce((t, x) => t + x.usd, 0), buffer: rows.reduce((t, x) => t + x.buffer, 0), redeemable: rows.reduce((t, x) => t + x.redeemable, 0),
        earned: known.length === rows.length ? known.reduce((t, x) => t + (x.earned ?? 0), 0) : null,
        earned30: rows.every((x) => x.earned30 != null) ? rows.reduce((t, x) => t + (x.earned30 ?? 0), 0) : null,
        ...(apy ? { apyBps: apy.apyBps, apyBasis: apy.apyBasis } : {}),
        ...(hard ? { paused: hard.paused, cls: 'hard' } : vp ? { paused: vp.why, cls: vp.cls } : {}),
        ...(rows.some((x) => x.update) ? { update: true } : {}), ...(rows.some((x) => x.blocked) ? { blocked: true } : {}),
        ...(rows.some((x) => x.foreign) ? { foreign: true } : {}), ...(residue > 0 ? { residue } : {}) }];
    })) as unknown as Record<EarnChain, { on: boolean; exit: boolean; usd: number; earned: number | null; earned30: number | null; paused?: string; cls?: Cls; residue?: number; foreign?: boolean }>;
    const all = EARN_CHAINS.map((c) => chains[c]);
    const paused = all.find((x) => x.paused);
    const residue = all.reduce((t, x) => t + (x.residue ?? 0), 0);
    return {
      available: true, here: !!venueHere(), on: live, chainsOn: live ? [...g!.chains] : [], exit: all.some((x) => x.exit), rules: EARN_RULES,
      cap: live ? Number(capNow6(big(g!.cap6))) / 1e6 : null, expiresAt: live ? g!.expiresAt : null,
      // r3: the session (until null = until turned off; ended: its chains are coming back)
      // (held: a hard stop holds the end's exit on one of its networks — the app then says the stop, not "coming back")
      ...((): Record<string, unknown> => { const s = session(); return s ? { session: { until: s.until, at: s.at, chains: [...s.chains], ended: sessionOver(s), held: s.chains.some((c) => deps.wallets().some((w) => !!hardWhy(w, c))) } } : {}; })(),
      usd: all.reduce((t, x) => t + x.usd, 0), earned: all.every((x) => x.earned != null || x.usd === 0) ? all.reduce((t, x) => t + (x.earned ?? 0), 0) : null,
      earned30: all.every((x) => x.earned30 != null || x.usd === 0) ? all.reduce((t, x) => t + (x.earned30 ?? 0), 0) : null,
      ...(paused ? { paused: paused.paused } : {}), ...(all.some((x) => x.foreign) ? { foreign: true } : {}), ...(residue > 0 ? { residue } : {}),
      // every stop the next "on" clears (review L4)
      stops: stopsOf(EARN_CHAINS),
      vault: earnVenueOf('robinhood')!.name, chain: 'robinhood', chains,
    };
  }
  /** Every stop on these chains, one line each: the venue's, each wallet's own, another device (review L4: the "on" dialog lists them all). */
  function stopsOf(chains: readonly EarnChain[]): string[] {
    const ws = deps.wallets(); const out: string[] = [];
    for (const c of chains) {
      const vp = vstate(c).pause; if (vp) out.push(`${CHAIN_NAME[c]}: ${vp.why}`);
      for (const w of ws) { const s = wstate(w, c); if (s.paused) out.push(`${CHAIN_NAME[c]} · ${w.name}: ${s.paused.why}`); if (s.foreign) out.push(`${CHAIN_NAME[c]} · ${w.name}: ${s.foreign.why}`); }
    }
    return out;
  }
  /** Every deposit, withdrawal and realized yield of the account (this device's record), newest last, and the tax export. */
  function history() {
    const rows = deps.wallets().flatMap((w) => EARN_CHAINS.flatMap((c) => read<HistRow[]>(histKey(w, c), [])));
    rows.sort((a, b) => a.at - b.at);
    const unrealized = deps.wallets().flatMap((w) => EARN_CHAINS.map((c) => { const s = read<WState | null>(wkey(w, c), null); const sn = snapOf(w, c); return s && s.principal6 != null && sn ? { chain: c, wallet: w.name, usd6: big(sn.assets6) - big(s.principal6) } : null; }).filter(Boolean)) as { chain: EarnChain; wallet: string; usd6: bigint }[];
    return { ok: true, rows: rows.slice(-1000), csv: earnCsv(rows, unrealized, deps.now()), unrealized: unrealized.map((u) => ({ chain: u.chain, wallet: u.wallet, usd: Number(u.usd6) / 1e6 })) };
  }

  /**
   * The user's switch (float.earn). On: the USD balance must be on, the server's geo answer says yes, and — when this frame's
   * chain is one of them — its venue reads as this build pins it; then the 2FA gate and the vault's own dialog (risks, buffer,
   * cap, the chains, one device, EVERY stop it clears — L4); nothing is moved by it (each chain's next background tick deposits
   * its surplus). This device takes Earn over for these chains (H2: the others go passive once they see its moves). Off (all
   * chains or the ones named): one dialog stating what comes back, then those chains' positions come out (this frame now, the
   * others on their next ticks), and nothing new goes in there.
   */
  /** r3: a new session; the chains the previous one ran and this one does not are switched off (they exit) */
  function startSession(chains: readonly EarnChain[], hours: number | null) {
    const now = deps.now(); const prev = session();
    const dropped = prev ? prev.chains.filter((c) => !chains.includes(c)) : [];
    deps.store.set(K.session, json({ v: 1, until: hours != null ? now + Math.round(hours * 3_600_000) : null, at: now, chains: [...chains].sort() } satisfies Session));
    if (dropped.length) setExit(dropped, true);
  }
  // r4: the end with its date (a 24 h session's "07:30" is ambiguous)
  const timeOf = (ms: number) => { try { return new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } };
  const dateOf = (ms: number) => { try { return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return new Date(ms).toISOString().slice(0, 10); } };
  async function configure(a: { action: 'on' | 'off'; lang: FloatLang; cap6: bigint | null; chains?: EarnChain[] | null; floatOn: boolean; hours?: number | null }) {
    const W = EARN_WORDS[a.lang] ?? EARN_WORDS.en; const here = chainHere();
    if (a.action === 'on') {
      if (!a.floatOn) throw new EarnRefused('Turn on the USD balance first');
      const prev = grantLive();
      const chains = [...new Set(a.chains?.length ? a.chains : prev?.chains?.length ? prev.chains : EARN_CHAINS)].filter((c): c is EarnChain => EARN_CHAINS.includes(c));
      if (!chains.length) throw new EarnRefused('Pick at least one network');
      if (!(await geoOk().catch(() => false))) { geoMemo = null; deps.store.del(K.geo); if (!(await geoOk())) throw new EarnRefused('Earn is not available where you are'); }
      const ws = deps.wallets(); if (!ws.length) throw new EarnRefused('None of your wallets can hold a USD balance');
      const v = venue();
      if (v && here && chains.includes(here)) {
        const p = await v.facts(ws[0], true);
        if (p.risk && p.risk.cls !== 'changed') throw new EarnRefused('Earn is not available right now: ' + p.risk.why);
      }
      // earn-ship (owner gate): never more than the server's per-account cap (the dialog states the cap that applies)
      const cap6 = capNow6(a.cap6 ?? (prev ? big(prev.cap6) : EARN.capDefault6));
      const hours = a.hours ?? null;
      // r3 (owner): a timed session on a live permission for the same networks and cap, with no stop pending, starts without a
      // dialog (the permission was given in it; nothing is locked). Anything else — new networks, a new cap, a stop — is the full one
      // release #5: an account without the self-attestation always gets the full dialog (it carries the line to tick)
      const same = attested() && hours != null && !!prev && chains.every((c) => prev.chains.includes(c)) && big(prev.cap6) === cap6 && !stopsOf(chains).length;
      if (same) {
        // r4 (S1): a LIVE session (not ended, the same networks) is extended / shortened without a dialog; any START — also right
        // after a session ended — is confirmed here in the vault (no 2FA: the 90-day permission is valid and unchanged)
        const cur = session();
        const live = !!cur && !sessionOver(cur) && cur.chains.length === chains.length && chains.every((c) => cur.chains.includes(c));
        // r5 (re-review X1): without a dialog a live session can only be SHORTENED (its end confirmed in the vault never moves later
        // silently); any extension is the short confirmation too
        const shorter = live && cur!.until != null && deps.now() + Math.round(hours! * 3_600_000) <= cur!.until;
        if (!shorter) {
          const end = deps.now() + Math.round(hours! * 3_600_000);
          const html = earnSessionHtml(a.lang, fmtUsd6(cap6), fmtUsd6(accountAssets6()), timeOf(end), dateOf(prev!.expiresAt), deps.esc, chains);
          if (!(await deps.ask({ title: W.sessionTitle, ok: W.sessionOk, html }))) throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' });
        }
        startSession(chains, hours); setExit(chains, false);
        emit(null, here, 'session', 'done', { chains, until: session()?.until, ...(shorter ? { shortened: true } : {}) });
        return { ok: true, earn: account() };
      }
      await deps.gate();
      const stops = stopsOf(chains);
      const needAttest = !attested();
      const html = (stops.length ? `<p class="ub-skip">${deps.esc(W.stops(stops))}</p>` : '') + earnOnHtml(a.lang, cap6, deps.esc, chains, hours != null ? timeOf(deps.now() + Math.round(hours * 3_600_000)) : null, dateOf(deps.now() + EARN.grantDays * 86_400_000))
        + (needAttest ? earnAttestHtml(a.lang, deps.esc) : '');
      const attestNeed = (EARN_ATTEST[a.lang] ?? EARN_ATTEST.en).need;
      if (!(await deps.ask({ title: W.onTitle, ok: W.onOk, html, ...(needAttest ? { validate: (root: HTMLElement) => ((root.querySelector('[data-earn-attest]') as HTMLInputElement | null)?.checked ? null : attestNeed) } : {}) }))) throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' });
      const now = deps.now();
      // the self-attestation, once per account, with its time (the dialog's validate refused OK without the tick)
      if (needAttest) deps.store.set(K.attest, json({ v: EARN_ATTEST_V, at: now }));
      const body = { v: 1 as const, on: true as const, cap6: String(cap6), chains: [...chains].sort() as EarnChain[], grantedAt: now, expiresAt: now + EARN.grantDays * 86_400_000, rules: EARN_RULES };
      deps.store.set(K.acct, json({ ...body, digest: earnDigest(body) }));
      startSession(chains, hours);
      setExit(chains, false);
      // a fresh yes clears what stopped Earn on these chains (the dialog listed every one); a venue that is still off pauses again.
      // This device takes over (H2): its record of each wallet exists from now, another device's earlier moves are not looked for
      const head = here && chains.includes(here) && deps.evm?.head ? await deps.evm.head().catch(() => null) : null;
      for (const c of chains) {
        const vs = vstate(c); if (vs.pause) { const n = { ...vs }; delete n.pause; delete n.mon; saveV(c, n); }
        for (const w of ws) {
          const s = wstate(w, c); const n: WState = { ...s, fails: 0, streak: 0, backoffUntil: 0, scanFrom: now };
          delete n.paused; delete n.foreign; delete n.scan; if (c === here && head != null) n.scan = { block: String(head) };
          saveW(w, c, n);
        }
      }
      emit(null, here, 'on', 'done', { cap: Number(cap6) / 1e6, chains });
      return { ok: true, earn: account() };
    }
    const prev = grant();
    const off = [...new Set(a.chains?.length ? a.chains : EARN_CHAINS)].filter((c): c is EarnChain => EARN_CHAINS.includes(c));
    const total6 = deps.wallets().reduce((t, w) => t + off.reduce((u, c) => u + big(snapOf(w, c)?.assets6), 0n), 0n);
    // the switch-off already confirmed in another frame (its exit is set for every network named): no second dialog here
    const confirmed = off.every((c) => exiting(c));
    if (total6 >= 10_000n && !confirmed) {
      await deps.gate();
      if (!(await deps.ask({ title: W.offTitle, ok: W.offOk, html: earnOffHtml(a.lang, total6, deps.esc) }))) throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' });
    }
    // the switch for the chains that stay on; none left = off
    if (prev && earnLive(prev, deps.now())) {
      const keep = prev.chains.filter((c) => !off.includes(c));
      if (keep.length) { const body = { v: 1 as const, on: true as const, cap6: prev.cap6, chains: keep, grantedAt: prev.grantedAt, expiresAt: prev.expiresAt, rules: prev.rules }; deps.store.set(K.acct, json({ ...body, digest: earnDigest(body) })); }
      else deps.store.del(K.acct);
    } else deps.store.del(K.acct);
    // the session: those chains leave it (none left: no session)
    { const s = session(); if (s) { const keep = s.chains.filter((c) => !off.includes(c)); if (keep.length) deps.store.set(K.session, json({ ...s, chains: keep })); else deps.store.del(K.session); } }
    const left = await exitAll(off);
    emit(null, here, 'off', 'done', { left: left.usd, chains: off });
    return { ok: true, earn: account(), left: left.usd, ...(left.why.length ? { why: left.why } : {}) };
  }
  /** Nothing new goes in on `chains`; every wallet's position on this frame's chain comes out now (one step each, fully checked —
   *  even after a stop: it is the user's own decision, within the switch-off's day budget, H1), the other chains' on their next
   *  ticks. A Kamino Reserve this build cannot parse still exits from R's own accounts (H3). */
  async function exitAll(chains: readonly EarnChain[] = EARN_CHAINS): Promise<{ usd: number; why: string[] }> {
    setExit(chains, true);
    if (chains.length === EARN_CHAINS.length) deps.store.del(K.acct);
    const v = venue(); const why: string[] = [];
    if (v && chains.includes(v.chain)) for (const w of deps.wallets()) {
      const c = v.chain; const sn = snapOf(w, c); if (sn && big(sn.position) === 0n && !wstate(w, c).open) continue;
      if ((wstate(w, c).exitDay ?? 0) >= EARN.exitPerDay) { why.push(`${w.name}: today's withdrawals are used up (it tries again tomorrow)`); continue; }
      const done = await exclusive(w, c, async () => {
        try {
          // r4: a step already booked from its receipt that is still being re-read does not hold the user's own withdraw
          // r5 (X2): nor does a sent step past openMs that no node confirms — closed (what went in unknown); the fresh read decides
          if (!(await followOpen(w, v))) { const o = wstate(w, c).open; if (o?.booked) setOpen(w, c, undefined); else if (o && deps.now() - o.at > EARN.openMs) closeUnconfirmed(w, c, o); else { why.push(`${w.name}: an earlier transaction is still landing`); return true; } }
          let p: Pos;
          try { p = await v.facts(w, true); }
          catch (x) { if (x instanceof Unreadable && v.exitFacts) { venuePause(c, { cls: 'hard', why: String(x.message), upd: true }); p = await v.exitFacts(w); } else throw x; }
          if (p.k?.reserve !== null) writeSnap(w, v, p, null, big(snapOf(w, c)?.buffer6));
          if (p.position === 0n) return true;
          if (p.risk) why.push(`${w.name}: ${p.risk.why}`);
          await v.withdraw(w, p, v.to6(p.assets), true, true, () => false);
          await resnap(w, v, big(snapOf(w, c)?.buffer6), true);
        } catch (x) { const m = String((x as Error)?.message || x).slice(0, 160); if (x instanceof Anomaly) hardPause(w, c, m, x instanceof Unreadable); why.push(`${w.name}: ${m}`); }
        return true;
      }, 10_000, 'user');
      // r3 (re-review L-b): the lock was not free in 10 s (a step still running, or one stuck on a read): said, never silent
      if (done == null) why.push(`${w.name}: an Earn step is still running — try again in a minute`);
    }
    for (const c of chains) if (deps.wallets().every((w) => big(snapOf(w, c)?.position) === 0n && !wstate(w, c).open)) setExit([c], false);
    const left6 = deps.wallets().reduce((t, w) => t + chains.reduce((u, c) => u + big(snapOf(w, c)?.assets6), 0n), 0n);
    return { usd: Number(left6) / 1e6, why };
  }
  /** floatEngine asks this before it reads for its switch-off dialog: is there anything of this wallet in Earn on this chain. */
  const holds = (w: EarnWallet) => { const c = chainHere(); return !!c && !!earnVenueOf(c) && holdsOn(w, c); };
  /** review M4: floatEngine runs Earn's tick only when this says so (the switch on, an exit, a position, an open step, or money
   *  that came out while the USD balance was off): a user without Earn reads nothing. Local state only. */
  const wants = (w: EarnWallet) => { const c = chainHere(); return !!c && !!earnVenueOf(c) && (onFor(c) || holdsOn(w, c) || big(wstate(w, c).residue6) > 0n); };
  /** The USD balance went off on another device (its revocation reached this one): nothing new goes in, the rest comes out. */
  const stop = () => { deps.store.del(K.acct); setExit(EARN_CHAINS, true); };
  const assets6Of = (w: EarnWallet, c?: EarnChain) => big(snapOf(w, c ?? (chainHere() as EarnChain))?.assets6);

  return { tick, clickNeeds, beforeClick, status, account, history, configure, exitAll, holds, wants, stop, assets6Of, fmt: fmtUsd6, USD };
}
export type EarnApi = ReturnType<typeof createEarn>;
