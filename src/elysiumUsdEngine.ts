// A buy on Elysium paid from the USD balance — the VAULT side (the pure rules: src/elysiumUsdCore.ts). It runs in the Elysium
// frame only (webEngine routes float.ensure { chain: 'elysium' } here) and only BEFORE a buy: it never runs between a click's
// buy and its send, and no trade entry point reaches it. It never sees a key: webEngine hands it the reserve's two signers
// through motion's bridge client (src/bridgeSolver.ts), which signs ONE stablecoin transfer from the wallet's OWN reserve to the
// solver's published deposit address, for a quote checked against the pinned solver key, the route, the payer (R), the
// recipient (W itself — no parameter can name another address) and OUR HyperEVM HYPE price.
//
// Two entries, one move:
//   reason 'click'   — a buy the wallet's HYPE on Elysium cannot pay: the deficit (+ margin) moves, then the app fires the buy;
//   reason 'deposit' — "Add HYPE on Elysium" from the USD balance: an explicit dollar amount ('quote' prices it, nothing signed;
//                      'go' asks in the vault's own dialog, then moves).
// Money safety:
//   - one move per wallet at a time: a lock per wallet, and a job record written BEFORE anything is signed; while it is open a
//     click follows it and never signs again (a lost answer = 'unknown' with the transfer's hash: followed, never re-sent);
//   - all or nothing: one reserve that alone covers the amount within the per-fill cap, or nothing moves (no dollars park on
//     Elysium for a buy that cannot go);
//   - only the deficit (+ ELY_USD.marginBps) moves for a click; a refund ('refunded') puts the stablecoin back into the same reserve;
//   - the first move of an account shows the exit-time notice in the vault; "I understand" is stored per account;
//   - (release 6) motion's fee: 0.1 %, at least $0.01 (ELY_FEE) — a click adds it on top of its deficit + margin, a deposit takes it
//     from its amount; a quote charging more than that bound signs nothing.
//   - (release 8) a click whose own reserves cannot pay may be paid by ONE reserve of another wallet of the same vault account
//     (the donor), only while THAT wallet's USD-balance permission is live on that chain. The donor's reserve signs (its own
//     signer, through bridge.fill's walletId), the payout still goes to W (recipient w.w, no parameter names another address), a
//     refund goes back to the donor's reserve (the solver refunds the depositor). Locks: W's, plus the paying reserve's (every
//     move, own or donor: no two moves sign from one reserve at once; its balance is read again inside that lock). The account
//     allows cross-wallet funding once, in the vault's own dialog (xwKeyOf). Deposits stay own-reserve only.
import { SolverRefused, SolverUnknown, type SolverBridge } from './bridgeSolver.ts';
import {
  ELY_USD, ELY_SOURCES, ELY_JOB_KEY, ELY_DELAYED_MS, planElyClick, planElyDeposit, noticeOf, ackKeyOf, ackOk, jobFrom, jobOpen, jobStateOf, fmt6, elyLangOf,
  elyFeeOf, elyFee6, elyFeeTooHigh, elyFeeText, ELY_LEAVE_LINE, ELY_FEE_LINE, xwKeyOf, xwOk,
  type ElySource, type ElyJob, type ElyReserve, type ElyLang, type ElyPlan, type ElyHealth, type ElyBest,
} from './elysiumUsdCore.ts';

export type ElyPermission = { chains: readonly string[] };
export type ElyUsdWallet = { id: string; name: string; w: `0x${string}`; r: { evm: `0x${string}`; sol: string } };
export type ElyUsdDeps = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  store: { get: (k: string) => string | null; set: (k: string, v: string) => void };
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  ask: (o: { title: string; html: string; ok: string }) => Promise<boolean>;
  esc: (v: unknown) => string;
  account: () => string | null;                                  // the account's main address (null: this device only)
  wallet: (id: string) => ElyUsdWallet;                           // throws for Privy / hop / chain-only wallets
  permission: (id: string) => ElyPermission | null;   // the wallet's LIVE USD-balance permission, else null
  // (release 9) no permission caps on Elysium (owner 2026-11-05: “remove the limits, then the text stays true”): the live grant decides
  // (release 8) the ids of this vault account's wallets that can hold a USD balance, in the vault's order (left out = no donors)
  wallets?: () => string[];
  // (release 8) Earn's ready part on a wallet's reserve on that chain, micro-dollars (cached, read only; left out = none)
  earnReady?: (walletId: string, chain: ElySource) => bigint | null;
  reads: {
    wHype: (w: `0x${string}`) => Promise<bigint>;                 // W's HYPE on Elysium (this frame's own nodes)
    price6: () => Promise<bigint>;                                // OUR HYPE price: the HyperEVM WHYPE/USDC pool
    reserve: (chain: ElySource, owner: string) => Promise<{ stable: bigint; native: bigint }>;
    code: (w: `0x${string}`) => Promise<string | null>;           // W's code on HyperEVM (the ticket's refund address)
  };
  bridge: Pick<SolverBridge, 'health' | 'quote' | 'fill' | 'status' | 'gas'>;
  emit: (detail: Record<string, unknown>) => void;
  waitMs?: number;                                                // how long a click waits for the HYPE (tests); default ELY_USD.waitMs
};
export type ElyClickAnswer =
  | { ok: true; state: 'covered' }
  | { ok: true; state: 'ready'; jobId: string; ms: number; outWei: string }
  | { ok: true; state: 'moving'; jobId: string; retryMs: number; delayed?: boolean }
  | { ok: true; state: 'quote'; from: ElySource; usd: number; outWei: string; feeUsd: number; fee: string; back: string; etaS: [number, number]; notice: string[] }
  | { ok: false; state: 'off' | 'cancelled' | 'failed'; code?: string; why?: string; short?: ElyShort; jobId?: string; refundHash?: string };
// (release 8) on 'short' / 'split': the largest single reserve of the account (the app can offer "Buy from <that wallet>"), the
// account's total, and Earn's part that would make one reserve whole (take it out first)
export type ElyShortWallet = { walletId: string; name: string; chain: ElySource; usd: number };
export type ElyShort = { usd: number; canUsd: number; best?: ElyShortWallet | null; accountUsd?: number; earn?: ElyShortWallet | null };
const shortWallet = (b: ElyBest | null | undefined): ElyShortWallet | null => (b ? { walletId: b.walletId, name: b.name, chain: b.chain, usd: Number(b.usd6) / 1e6 } : null);
/** (release 8) the most other wallets a click reads as donors (each only on its permission's chains) */
export const ELY_DONOR_WALLETS = 24;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
type Args = { walletId: string; reason: 'click' | 'deposit' | 'notice' | 'jobs'; hype: bigint | null; usd: number | null; lang: ElyLang; from: ElySource | null; phase: 'quote' | 'go' };
export function elyUsdArgs(o: unknown): Args {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['walletId', 'chain', 'reason', 'hype', 'usd', 'lang', 'from', 'phase'].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  if (r.chain !== 'elysium') throw new Error('Bad arguments: chain');
  if (typeof r.walletId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(r.walletId)) throw new Error('Bad arguments: walletId');
  const reason = r.reason === 'notice' || r.reason === 'jobs' || r.reason === 'deposit' || r.reason === 'click' ? r.reason : null;
  if (!reason) throw new Error('Bad arguments: reason');
  let hype: bigint | null = null;
  if (r.hype != null) { if (typeof r.hype !== 'string' || !/^[0-9]{1,30}$/.test(r.hype)) throw new Error('Bad arguments: hype'); hype = BigInt(r.hype); if (!(hype > 0n)) throw new Error('Bad arguments: hype'); }
  let usd: number | null = null;
  if (r.usd != null) { if (typeof r.usd !== 'number' || !Number.isFinite(r.usd) || r.usd <= 0 || r.usd > 10_000) throw new Error('Bad arguments: usd'); usd = r.usd; }
  if (reason === 'click' && hype === null && usd === null) throw new Error('Bad arguments: hype or usd');
  if (reason === 'deposit' && usd === null) throw new Error('Bad arguments: usd');
  const from = r.from == null ? null : (ELY_SOURCES as readonly unknown[]).includes(r.from) ? r.from as ElySource : undefined;
  if (from === undefined) throw new Error('Bad arguments: from');
  const phase = r.phase == null || r.phase === 'go' ? 'go' : r.phase === 'quote' ? 'quote' : null;
  if (!phase) throw new Error('Bad arguments: phase');
  return { walletId: r.walletId, reason, hype, usd, lang: elyLangOf(r.lang), from, phase };
}
const SRC_NAME: Record<ElySource, string> = { robinhood: 'USDG on Robinhood', bsc: 'USDC on BNB Chain', sol: 'USDC on Solana' };
const fmtHype = (wei: bigint): string => { const m = (wei + 50_000_000_000_000n) / 100_000_000_000_000n; return `${m / 10_000n}.${String(m % 10_000n).padStart(4, '0')} HYPE`; };

export function createElyUsd(deps: ElyUsdDeps) {
  const jobKey = (w: ElyUsdWallet) => ELY_JOB_KEY + w.w.toLowerCase();
  const readJob = (w: ElyUsdWallet): { job: ElyJob | null; bad: boolean } => { const raw = deps.store.get(jobKey(w)); const job = jobFrom(raw); return { job, bad: !!raw && raw !== 'null' && !job }; };
  const saveJob = (w: ElyUsdWallet, j: ElyJob) => { j.updatedAt = deps.now(); deps.store.set(jobKey(w), JSON.stringify(j)); deps.emit({ kind: 'elysium-usd', walletId: w.id, job: publicJob(j) }); };
  const publicJob = (j: ElyJob) => ({ id: j.id, from: j.from, usd: Number(BigInt(j.usd6)) / 1e6, outWei: j.outWei, state: j.state, at: j.at, updatedAt: j.updatedAt, srcHash: j.srcHash || null, dstHash: j.dstHash || null, refundHash: j.refundHash || null, error: j.error || null, delayed: jobOpen(j) && deps.now() - j.at > ELY_DELAYED_MS, ...(j.donorId ? { donorId: j.donorId, donorName: j.donorName || null } : {}) });
  // (release 8) the wallet that paid, on a click's answer, only when it was another wallet
  const paidBy = (j: ElyJob) => (j.donorId ? { paidBy: { walletId: j.donorId, name: j.donorName || '' } } : {});
  const xwAcked = () => xwOk(deps.store.get(xwKeyOf(deps.account())), deps.account());
  const xwAck = () => deps.store.set(xwKeyOf(deps.account()), JSON.stringify({ v: 1, at: deps.now(), account: (deps.account() || 'device').toLowerCase() }));
  const acked = () => ackOk(deps.store.get(ackKeyOf(deps.account())), deps.account());
  const ack = () => deps.store.set(ackKeyOf(deps.account()), JSON.stringify({ v: 1, notice: ELY_USD.noticeVersion, at: deps.now(), account: (deps.account() || 'device').toLowerCase() }));
  const lines = (lead: string[], lang: ElyLang, withNotice: boolean) => [...lead.map((l) => `<p class="dk-sub">${deps.esc(l)}</p>`), ...(withNotice ? noticeOf(deps.now(), lang).lines.map((l, i) => `<p class="${i === 0 ? 'dk-sub' : 'dk-muted'}">${deps.esc(l)}</p>`) : [])].join('');

  /** follow an open job until the HYPE is in W (or the wait ends): never signs anything */
  async function follow(w: ElyUsdWallet, job: ElyJob, needWei: bigint | null, t0: number): Promise<ElyClickAnswer> {
    let n = 0;
    for (;;) {
      if (job.state === 'done') return { ok: true, state: 'ready', jobId: job.id, ms: deps.now() - t0, outWei: job.outWei, ...paidBy(job) };
      if (job.state === 'refunded' || job.state === 'refused' || job.state === 'failed') {
        return { ok: false, state: 'failed', code: job.state, why: job.state === 'refunded' ? `motion could not pay HYPE on Elysium: your ${fmt6(BigInt(job.usd6))} went back to ${job.donorId ? `${job.donorName || 'the paying wallet'}'s` : 'your'} USD balance` : job.state === 'refused' ? 'motion\'s bridge refused this move — nothing of yours moved' : 'The move to Elysium failed: ' + String(job.error || 'no reason given').slice(0, 120), jobId: job.id, ...(job.refundHash ? { refundHash: job.refundHash } : {}) };
      }
      if (deps.now() - t0 >= (deps.waitMs ?? ELY_USD.waitMs)) return { ok: true, state: 'moving', jobId: job.id, retryMs: 1_500, ...(deps.now() - job.at > ELY_DELAYED_MS ? { delayed: true } : {}), ...paidBy(job) };
      await deps.wait(ELY_USD.pollMs);
      n += 1;
      const [st, bal] = await Promise.all([
        deps.bridge.status(job.id).catch(() => null),
        needWei !== null && n % 2 === 0 ? deps.reads.wHype(w.w).catch(() => null) : Promise.resolve(null),
      ]);
      const prev = job.state;
      if (st) {
        const next = jobStateOf(st.state, job.state);
        if (st.dstHash) job.dstHash = String(st.dstHash);
        if (st.refundHash) job.refundHash = String(st.refundHash);
        if (st.error) job.error = String(st.error).slice(0, 160);
        job.state = next;
      }
      // the solver says 'filled' only once it saw the Elysium credit; W's own balance reaching the mark is the same proof here
      if (job.state !== 'done' && job.state !== 'refunded' && needWei !== null && bal !== null && bal >= needWei && (job.state === 'arriving' || job.state === 'sent' || job.state === 'unknown')) job.state = 'done';
      if (job.state !== prev || st?.dstHash) saveJob(w, job);
    }
  }

  type Reads = { wHype: bigint | null; price6: bigint; health: Awaited<ReturnType<ElyUsdDeps['bridge']['health']>> | null; code: string | null; reserves: ElyReserve[]; view: ElyHealth };
  async function readAll(w: ElyUsdWallet): Promise<Reads> {
    const [wHype, price6, health, code, ...res] = await Promise.all([
      deps.reads.wHype(w.w).catch(() => null), deps.reads.price6().catch(() => 0n), deps.bridge.health().catch(() => null), deps.reads.code(w.w).catch(() => null),
      ...ELY_SOURCES.map((c) => deps.reads.reserve(c, c === 'sol' ? w.r.sol : w.r.evm).catch(() => null)),
    ]);
    const reserves: ElyReserve[] = ELY_SOURCES.map((c, i) => { const r = res[i] as { stable: bigint; native: bigint } | null; return { chain: c, stable: r ? r.stable : null, native: r ? r.native : null, address: c === 'sol' ? w.r.sol : w.r.evm }; });
    const deposits = (health?.deposits || {}) as Partial<Record<string, string>>;
    const view: ElyHealth = { on: !!health?.on, chains: health?.chains || [], maxFill6: BigInt(Math.round(Math.max(0, Number(health?.elysium?.maxFillUsd ?? health?.maxFillUsd ?? 0) || 0) * 1e6)), minFill6: BigInt(Math.round(Math.max(0, Number(health?.minFillUsd ?? 0) || 0) * 1e6)), paused: !!health?.elysium?.paused, why: health?.elysium?.why?.[0], hasDeposit: (c) => !!deposits[c],
      fee: elyFeeOf(health?.elysium?.fee) };
    return { wHype, price6, health, code, reserves, view };
  }
  /**
   * (release 8) the account's OTHER wallets' reserves, read only when W's own cannot pay: each wallet whose USD-balance permission
   * is LIVE (deps.permission = float.liveFor), only on the chains of THAT permission, at most ELY_DONOR_WALLETS wallets. A wallet
   * that cannot hold a USD balance (deps.wallet throws), shares W's address or has no address for that chain is left out.
   */
  async function readOthers(w: ElyUsdWallet): Promise<ElyReserve[]> {
    const want: { d: ElyUsdWallet; c: ElySource; chains: string[]; owner: string }[] = [];
    let n = 0;
    for (const id of deps.wallets ? deps.wallets() : []) {
      if (id === w.id || n >= ELY_DONOR_WALLETS) continue;
      let d: ElyUsdWallet; try { d = deps.wallet(id); } catch { continue; }
      if (d.id !== id || !ADDR.test(d.w) || d.w.toLowerCase() === w.w.toLowerCase()) continue;
      const p = deps.permission(d.id); if (!p) continue;
      n += 1;
      for (const c of ELY_SOURCES) {
        const owner = c === 'sol' ? d.r.sol : d.r.evm;
        if (p.chains.includes(c) && owner && (c === 'sol' || ADDR.test(owner))) want.push({ d, c, chains: [...p.chains], owner });
      }
    }
    if (!want.length) return [];
    const res = await Promise.all(want.map((x) => deps.reads.reserve(x.c, x.owner).catch(() => null)));
    return want.map((x, i) => ({ chain: x.c, stable: res[i] ? res[i]!.stable : null, native: res[i] ? res[i]!.native : null, address: x.owner,
      walletId: x.d.id, name: x.d.name, own: false, chains: x.chains, earnReady6: earnOf(x.d.id, x.c) }));
  }
  const earnOf = (walletId: string, c: ElySource): bigint | null => { try { return deps.earnReady ? deps.earnReady(walletId, c) : null; } catch { return null; } };
  const refusedOf = (plan: Extract<ElyPlan, { kind: 'refused' }>): ElyClickAnswer => ({ ok: false, state: 'failed', code: plan.code, why: plan.why, ...(plan.usd6 !== undefined ? { short: { usd: Number(plan.usd6) / 1e6, canUsd: Number(plan.canUsd6 ?? 0n) / 1e6,
    ...(plan.best !== undefined ? { best: shortWallet(plan.best), accountUsd: Number(plan.account6 ?? 0n) / 1e6, earn: shortWallet(plan.earn) } : {}) } } : {}) });
  const codeProblem = (code: string | null): ElyClickAnswer | null => (code === null ? { ok: false, state: 'failed', code: 'not-read', why: 'HyperEVM could not be read — nothing was moved' }
    : code !== '0x' ? { ok: false, state: 'failed', code: 'contract', why: 'This wallet has code on HyperEVM (a contract or a delegation) — Elysium is paid to plain wallets only. Nothing was moved' } : null);

  /** gas for the reserve → the quote → the job (written before the signature) → ONE signed transfer → follow */
  async function move(w: ElyUsdWallet, plan: Extract<ElyPlan, { kind: 'move' }>, rd: Reads, t0: number, needOf: (outWei: bigint) => bigint | null, confirm?: (outWei: bigint) => Promise<boolean>): Promise<ElyClickAnswer> {
    // (release 8) the paying wallet: W itself, or the donor the plan names — its reserve derived HERE from the vault's own wallet
    // (never from the plan's data), its permission asked AGAIN (still live, still on this chain)
    let pw: ElyUsdWallet = w;
    if (plan.donor) {
      try { pw = deps.wallet(plan.donor.walletId); } catch { return { ok: false, state: 'failed', code: 'donor-off', why: `${plan.donor.name} cannot pay from its USD balance — nothing was moved` }; }
      const dp = pw.id === plan.donor.walletId && pw.id !== w.id && ADDR.test(pw.w) && pw.w.toLowerCase() !== w.w.toLowerCase() ? deps.permission(pw.id) : null;
      if (!dp || !dp.chains.includes(plan.from)) return { ok: false, state: 'failed', code: 'donor-off', why: `${plan.donor.name}'s USD balance is off on that network — nothing was moved` };
    }
    const payer = plan.from === 'sol' ? pw.r.sol : pw.r.evm;
    // one move per RESERVE at a time (W's lock is already held): two wallets' clicks never sign from the same reserve at once
    type Signed = { job: ElyJob; out: bigint } | { answer: ElyClickAnswer };
    const signed: Signed = await deps.lock('ely-usd-r:' + plan.from + ':' + payer.toLowerCase(), async (): Promise<Signed> => {
      // the reserve's own gas for its one transfer: motion's gas drop when it has none (the same drop every USD-balance chain uses)
      if (!plan.gasOk) {
        await deps.bridge.gas(plan.from, payer).catch(() => null);
        let ok = false;
        for (let i = 0; i < 10 && !ok; i += 1) { await deps.wait(800); const r = await deps.reads.reserve(plan.from, payer).catch(() => null); ok = !!r && r.native > 0n; }
        if (!ok) return { answer: { ok: false, state: 'failed', code: 'no-gas', why: 'Your USD balance on that network has no gas for its transfer yet — nothing was moved' } };
      }
      // the quote and, beside it (no added wait), the reserve read again inside its lock: a move of another wallet may have just
      // spent it. A donor that cannot be read again pays nothing; W's own reserve keeps the plan's read (as before release 8)
      const [q, again] = await Promise.all([
        deps.bridge.quote({ from: plan.from, to: 'elysium', amountIn: plan.amountIn, depositor: payer, recipient: w.w, oracle6: rd.price6, maxSlipBps: ELY_USD.maxSlipBps, deposits: rd.health!.deposits, pay: 'stable' })
          .then((v) => ({ v }), (e) => ({ e })),
        deps.reads.reserve(plan.from, payer).catch(() => null),
      ]);
      if ('e' in q) return { answer: { ok: false, state: 'failed', code: 'quote', why: String((q.e as Error)?.message || q.e).slice(0, 160) + ' — nothing was moved' } };
      const got = q.v;
      if (again ? again.stable < plan.amountIn : !!plan.donor) return { answer: { ok: false, state: 'failed', code: 'short', why: 'That USD balance changed a moment ago and no longer covers this buy — nothing was moved' } };
      // a click's payout must cover its deficit (the margin absorbs the slippage bound; a quote under it signs nothing)
      if (got.out < plan.deficitWei) return { answer: { ok: false, state: 'failed', code: 'quote', why: 'motion\'s quote pays less HYPE than this buy needs — nothing was moved' } };
      // (release 6) motion's fee is 0.1 %, at least $0.01: a quote that names more signs nothing
      if (elyFeeTooHigh(got.fee6, got.usd6)) return { answer: { ok: false, state: 'failed', code: 'quote', why: 'motion\'s quote charges more than its 0.1 % fee — nothing was moved' } };
      // the PAYING wallet's grant, asked again inside its reserve's lock (it may have been switched off since the plan): live and on
      // that network, or nothing moves. (release 9: no caps — owner in chat 2026-11-05: “remove the limits, then the text stays true”)
      { const pp = deps.permission(pw.id);
        if (!pp || !pp.chains.includes(plan.from)) return { answer: { ok: false, state: 'failed', code: 'donor-off', why: `${pw.id === w.id ? 'This wallet' : pw.name}'s USD balance is off on that network — nothing was moved` } }; }
      if (confirm && !(await confirm(got.out))) return { answer: { ok: false, state: 'cancelled', why: 'Not confirmed — nothing was moved' } };
      const job: ElyJob = { v: 1, id: got.quote.id, walletId: w.id, w: w.w.toLowerCase(), from: plan.from, usd6: String(plan.usd6), amountIn: String(plan.amountIn), outWei: String(got.out), state: 'signing', at: deps.now(), updatedAt: deps.now(),
        ...(plan.donor ? { donorId: pw.id, donorName: pw.name, payer: payer.toLowerCase() } : {}) };
      saveJob(w, job);   // BEFORE the signature: a crash from here on leaves a record that blocks a second move
      try {
        // the reserve that signs is the PAYING wallet's (webEngine's signers derive R from this walletId)
        const r = await deps.bridge.fill(got.quote, got.sig, pw.id, { early: true });
        job.srcHash = r.srcHash; if (r.dstHash) job.dstHash = r.dstHash;
        job.state = r.ok ? jobStateOf(r.state || 'paid', 'sent') : jobStateOf(r.state || 'failed', 'sent');
        if (!r.ok && r.error) job.error = r.error;
      } catch (e) {
        if (e instanceof SolverRefused) { job.state = 'refused'; job.error = String(e.message).slice(0, 160); saveJob(w, job); return { answer: { ok: false, state: 'failed', code: 'refused', why: job.error + ' — nothing of yours moved', jobId: job.id } }; }
        job.state = 'unknown'; job.srcHash = (e as SolverUnknown)?.srcHash || job.srcHash; job.error = String((e as Error)?.message || e).slice(0, 160);
      }
      saveJob(w, job);
      return { job, out: got.out };
    });
    if ('answer' in signed) return signed.answer;
    return follow(w, signed.job, needOf(signed.out), t0);
  }

  /** the wallet, its live permission, the lock, and an open job (followed, never a second move) */
  async function withWallet(a: Args, fn: (w: ElyUsdWallet, perm: { chains: readonly string[] }, t0: number) => Promise<ElyClickAnswer>, openFollow: (w: ElyUsdWallet, open: ElyJob, t0: number) => Promise<ElyClickAnswer>): Promise<ElyClickAnswer> {
    const t0 = deps.now();
    const w = deps.wallet(a.walletId);
    if (!ADDR.test(w.w)) return { ok: false, state: 'failed', code: 'wallet', why: 'This wallet has no EVM address for Elysium' };
    const perm = deps.permission(w.id);
    if (!perm) return { ok: false, state: 'off', why: 'The USD balance is off for this wallet' };
    return deps.lock('ely-usd:' + w.w.toLowerCase(), async () => {
      const { job: open, bad } = readJob(w);
      if (bad) return { ok: false, state: 'failed', code: 'job-unreadable', why: 'A previous move of this wallet to Elysium cannot be read — nothing new was moved' };
      if (jobOpen(open)) {
        if (deps.now() - open!.at > ELY_DELAYED_MS) return { ok: false, state: 'failed', code: 'delayed', jobId: open!.id, why: 'Your previous move to Elysium is delayed — nothing is lost (motion redeems or refunds it). No new move until it settles' };
        return openFollow(w, open!, t0);
      }
      return fn(w, perm, t0);
    });
  }

  function click(a: Args): Promise<ElyClickAnswer> {
    return withWallet(a, async (w, perm, t0) => {
      const rd = await readAll(w);
      const buyWei = a.hype ?? (a.usd !== null && rd.price6 > 0n ? (BigInt(Math.round(a.usd * 1e6)) * 10n ** 18n) / rd.price6 : 0n);
      const needWei = buyWei + ELY_USD.gasWei;
      const input = { buyWei, wHype: rd.wHype, price6: rd.price6, reserves: rd.reserves, chains: perm.chains, health: rd.view, self: { walletId: w.id, name: w.name } };
      let plan = planElyClick(input);
      // (release 8) W's own reserves cannot pay it in one fill: the account's other wallets (live permissions only) and Earn's
      // ready part (named in the refusal, never moved here) — read only now, so a click its own reserve covers reads nothing more
      if (plan.kind === 'refused' && (plan.code === 'short' || plan.code === 'split')) {
        const others = await readOthers(w);
        plan = planElyClick({ ...input, reserves: [...rd.reserves.map((r) => ({ ...r, earnReady6: earnOf(w.id, r.chain) })), ...others] });
      }
      if (plan.kind === 'covered') return { ok: true, state: 'covered' };
      if (plan.kind === 'refused') return refusedOf(plan);
      const bad = codeProblem(rd.code); if (bad) return bad;
      const donor = plan.donor;
      const fee = `Fee ${elyFeeText(rd.view.fee)} (${fmt6(elyFee6(plan.usd6, rd.view.fee))}), included.`;
      // (release 8) the cross-wallet permission (once per account): the paying wallet and the amount, in the vault's own dialog
      const xwLead = donor ? [`${w.name} cannot pay this buy on Elysium from its own USD balance. ${donor.name} can: ${fmt6(plan.usd6)} from ${donor.name}'s USD balance (${SRC_NAME[plan.from]}) → HYPE in ${w.name} on Elysium (its own address). ${fee}`,
        `Your USD balance moves money between each wallet and its own reserve. Allowing this once lets a buy that its own wallet cannot pay on Elysium be paid from another of your wallets whose USD balance is on — always to the buying wallet itself, never to anyone else.`] : [];
      const xwNeeded = !!donor && !xwAcked();
      // the one-time notice (per account): before anything is asked of the solver
      if (!acked()) {
        const n = noticeOf(deps.now(), a.lang);
        const html = lines(donor ? xwLead : [`This buy: ${fmt6(plan.usd6)} from your USD balance (${SRC_NAME[plan.from]}) → HYPE in this wallet on Elysium. ${fee}`], a.lang, true);
        if (!(await deps.ask({ title: n.title, ok: n.ok, html }))) return { ok: false, state: 'cancelled', why: 'Not confirmed — nothing was moved' };
        ack(); if (xwNeeded) xwAck();
      } else if (xwNeeded) {
        if (!(await deps.ask({ title: 'Pay from another of your wallets', ok: `Pay from ${donor!.name}`, html: lines(xwLead, a.lang, false) }))) return { ok: false, state: 'cancelled', why: 'Not confirmed — nothing was moved' };
        xwAck();
      }
      return move(w, plan, rd, t0, () => needWei);
    }, async (w, open, t0) => {
      // a move of this wallet is still open: follow it. Covered already (its HYPE is in) = the job is done
      const [wHype, price6] = await Promise.all([deps.reads.wHype(w.w).catch(() => null), deps.reads.price6().catch(() => 0n)]);
      const buyWei = a.hype ?? (a.usd !== null && price6 > 0n ? (BigInt(Math.round(a.usd * 1e6)) * 10n ** 18n) / price6 : 0n);
      const needWei = buyWei + ELY_USD.gasWei;
      if (wHype !== null && wHype >= needWei && open.state === 'arriving') { open.state = 'done'; saveJob(w, open); return { ok: true, state: 'covered' }; }
      return follow(w, open, needWei, t0);
    });
  }

  function deposit(a: Args): Promise<ElyClickAnswer> {
    return withWallet(a, async (w, perm, t0) => {
      const rd = await readAll(w);
      const plan = planElyDeposit({ usd6: BigInt(Math.round(a.usd! * 1e6)), from: a.from, reserves: rd.reserves, chains: perm.chains, health: rd.view });
      if (plan.kind !== 'move') return refusedOf(plan as Extract<ElyPlan, { kind: 'refused' }>);
      const bad = codeProblem(rd.code); if (bad) return bad;
      if (!(rd.price6 > 0n)) return { ok: false, state: 'failed', code: 'no-price', why: 'No fresh HYPE price — nothing was moved' };
      const outOf = (usd6: bigint) => (usd6 * 10n ** 18n) / rd.price6;
      const etaS: [number, number] = [5, 20];
      // (release 6) the fee comes out of the amount: what arrives is the amount less 0.1 % (at least $0.01)
      const fee6 = elyFee6(plan.usd6, rd.view.fee);
      if (a.phase === 'quote') {
        // a price read: nothing signed, no dialog, no quote asked of the solver (it would hold a slot of the wallet's caps)
        return { ok: true, state: 'quote', from: plan.from, usd: Number(plan.usd6) / 1e6, outWei: String(outOf(plan.usd6 - fee6)), feeUsd: Number(fee6) / 1e6, fee: elyFeeText(rd.view.fee), back: ELY_LEAVE_LINE[a.lang], etaS, notice: noticeOf(deps.now(), a.lang).lines };
      }
      const before = rd.wHype ?? 0n;
      return move(w, plan, rd, t0, (out) => before + (out * 99n) / 100n, async (out) => {
        // the vault's own dialog: what leaves, what arrives where, the fee, the time — and the way back, every time on a deposit
        const html = lines([`${fmt6(plan.usd6)} from your USD balance (${SRC_NAME[plan.from]}) → ${fmtHype(out)} in ${w.name} on Elysium (the same address).`, `${ELY_FEE_LINE.en(elyFeeText(rd.view.fee))} (${fmt6(fee6)}). Usually arrives in 5–20 seconds; if motion cannot pay it, the dollars come back to your USD balance.`, ELY_LEAVE_LINE.en], a.lang, true);
        const ok = await deps.ask({ title: 'Add HYPE on Elysium', ok: `Add ${fmt6(plan.usd6)}`, html });
        if (ok && !acked()) ack();
        return ok;
      });
    }, (w, open, t0) => follow(w, open, null, t0));
  }

  return {
    /** float.ensure { chain: 'elysium', reason: 'click' | 'deposit' | 'notice' | 'jobs', walletId, hype?, usd?, from?, phase?, lang? } */
    ensure: async (o: unknown): Promise<unknown> => {
      const a = elyUsdArgs(o);
      if (a.reason === 'notice') return { ok: true, notice: noticeOf(deps.now(), a.lang), acked: acked() };
      if (a.reason === 'jobs') { const w = deps.wallet(a.walletId); const { job } = readJob(w); return { ok: true, on: !!deps.permission(w.id), job: job ? publicJob(job) : null, acked: acked() }; }
      if (a.reason === 'deposit') return deposit(a);
      return click(a);
    },
  };
}
export type ElyUsdApi = ReturnType<typeof createElyUsd>;
