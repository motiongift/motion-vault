// Perps phase 2 inside the vault (2026-10-22, owner's go): trading on Lighter's Robinhood Chain instance from the
// vault's own wallets. Everything that signs is here, behind the engine's `perps.*` methods (src/webEngine.ts wires the
// dependencies in; scripts/perps-engine.test.mjs runs this file against a mocked Lighter and a mocked chain).
//
// Trust rules (docs/PERPS-LIGHTER.md "as built"):
// · One Lighter API key per wallet, slot 77, the SAME on every device of the wallet (2026-10-22): its seed is an HMAC of
//   the wallet key (perpsCore KEY_DERIVATION, computed by src/webEngine.ts — the wallet key never reaches this file), the
//   key itself Lighter's own seed derivation in the pinned signer (src/lighter/signer.ts fromSeed). Cached in the wallet's
//   encrypted record (Account.lt, d: 1), registered with ONE personal_sign of Lighter's fixed registration text by the
//   wallet key. A second device derives the same key: nothing is replaced at slot 77, nothing has to be registered again.
//   The engine rebuilds that text itself and signs nothing else with the wallet key here (the fast
//   withdrawal's transfer text names this wallet as the only destination).
// · Money only moves between this wallet and its own Lighter account: deposits credit `_to = this wallet`, withdrawals go
//   to the account's own L1 address (Lighter enforces it for the secure path; the fast path's memo is checked here).
// · Dialogs (the frame's trusted click): first-time setup (with the self-declared region line), every deposit, every
//   withdrawal, an order at ≥ 20x or above the per-wallet cap — and ONE dialog for an open that needs any of them.
//   Close, cancel and SL / TP on an open position (perps.trigger) do not ask: they only reduce or close this wallet's own position.
// · Prices: the vault reads the market itself (Lighter's book + mark); market orders carry a slippage cap, limit orders a
//   band through the mark; a price that moved past the cap while the money arrived stops the order (PerpsPriceMoved).
// · Nonces: one counter per account+key (NonceKeeper), one perps lane per wallet across tabs (Web Locks). A send whose
//   answer is lost is reported unknown (PerpsUnknown) and never sent again.
import { encodeFunctionData, parseAbi, encodePacked, formatEther, formatUnits } from 'viem';
import type { LighterSigner, OrderArgs, SignedTx } from './lighter/signer.ts';
import {
  LIGHTER_API, ZK_LIGHTER, USDG, WETH, V3_ROUTER, SWAP_FEES, USDG_ASSET, ROUTE_PERP, USDG_DECIMALS, API_KEY_INDEX, MIN_WITHDRAW, CAP_DEFAULT, LEVERAGE_CONFIRM,
  RESTRICTED_NAMES, units, decimal, marketOf, buildOrder, buildClose, buildTrigger, triggerKindOf, confirmReasons, marginNeed, sendVerdict, accountView, txOutcome, NonceKeeper,
  changePubKeyBody, transferBody, withdrawMemo, imfOf, leverageOf, args, l1TextProblem, FAST_WITHDRAW_POOL, HOURLY_CAP, type Market, type OrderReq,
} from './lighter/perpsCore.ts';
import { LIGHTER_CHAIN_ID, peekSigner } from './lighter/signer.ts';

/** The wallet's Lighter record, inside the wallet's Account (src/webEngine.ts Account.lt) — encrypted at rest with the vault's
 *  device AES key exactly like the wallet keys; never in a summary, a message to the page, the account backup or a backup file. */
/** region: when this wallet's region declaration was given (once per wallet); rby: how it is known — 'tick' (the line was
 *  ticked in this vault; also every record without rby) or 'lighter' (this wallet's own Lighter account already holds a key at
 *  our slot 77: only this flow registers there, and its first registration always carries the ticked line). */
/** d: 1 = k / p are this wallet's DERIVED key (perpsCore KEY_DERIVATION v1) for account a; a record without d holds an older
 *  engine's random key, which is never signed with again (Lighter's slot decides: see keyState / adopt / withKey). */
export type LtRec = { v: 1; i: number; at: number; k?: string; p?: string; a?: number; st?: 'pending' | 'ok'; region?: number; rby?: 'tick' | 'lighter'; d?: 1 };
type Hex = `0x${string}`;
type Wallet = { id: string; name: string; address: Hex; lt?: LtRec };
type Ask = { title: string; html: string; ok: string; danger?: boolean; validate?: (root: HTMLElement, choice: string) => string | null };
export type Pc = {
  readContract(a: Record<string, unknown>): Promise<unknown>;
  simulateContract(a: Record<string, unknown>): Promise<{ result: unknown }>;
  estimateGas(a: Record<string, unknown>): Promise<bigint>;
  getBalance(a: { address: Hex }): Promise<bigint>;
};
export interface PerpsDeps {
  /** true on the Robinhood frame only (USDG and ZkLighter live there) */
  lane(): boolean;
  wallet(id: string): Wallet;
  saveLt(id: string, rec: LtRec | null): Promise<void>;
  /** personal_sign with the wallet key. `account` = this wallet's Lighter account as Lighter's account read lists it under
   *  the wallet's own address; both the engine and the vault parse the text against it (l1TextProblem) before signing. */
  l1Sign(id: string, text: string, account: number): Promise<Hex>;
  /** the 32-byte seed (64 hex) of this wallet's Lighter API key for `account` at slot 77: perpsCore apiKeySeed over the
   *  wallet key, computed where the wallet key lives. The same on every device of the wallet. Never logged. */
  apiKeySeed(id: string, account: number): Promise<string>;
  /** L6: whether an idempotency record already exists for this key (another tab may have run it while this one waited) */
  idemSeen?(key: string): boolean;
  sendTx(id: string, tx: { to: Hex; data: Hex; value?: bigint }, gas: bigint): Promise<Hex>;
  gasPrice(): Promise<bigint>;
  receipt(hash: Hex, timeoutMs?: number): Promise<{ status: string }>;
  pc: Pc;
  ask(o: Ask): Promise<boolean>;
  html: { esc(v: unknown): string; sub(h: string): string; muted(h: string): string; addrRow(name: string, address: string): string; destBox(address: string): string };
  once<T extends Record<string, unknown>>(opts: { idempotencyKey?: string }, what: unknown[], run: (sending: () => void) => Promise<T>): Promise<T>;
  emit(detail: Record<string, unknown>): void;
  fetch: typeof fetch;
  signer(): Promise<LighterSigner>;
  now(): number;
  store: { get(k: string): string | null; set(k: string, v: string): void };
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  sleep?(ms: number): Promise<void>;
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const ZK = parseAbi(['function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) payable', 'function addressToAccountIndex(address) view returns (uint48)', 'function getPendingBalance(address,uint16) view returns (uint128)', 'function withdrawPendingBalance(address _owner, uint16 _assetIndex, uint128 _amount)']);
const ROUTER = parseAbi(['function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)']);
const QUOTE_FROM = '0x000000000000000000000000000000000000bEEF' as Hex;   // a funded-by-override address for swap quotes
const GAS = { swap: 220_000n, approve: 70_000n, deposit: 220_000n, claim: 160_000n };
const GAS_RESERVE = 50_000_000_000_000n;   // 0.00005 ETH stays for the next transactions (as the engine's GAS_RESERVE)
const USUAL_MS: Record<string, number> = { swap: 1500, approve: 1000, deposit: 1000, credit: 1500, setup: 2000, leverage: 600, order: 600, trigger: 600, replace: 600 };   // scripts/perps-vault-timing.mjs (2026-10-22) with headroom; 3× = "stalled"
const CAP_KEY = 'trenches.perps.cap.v1', WD_KEY = 'trenches.perps.wd.v1', HOUR_KEY = 'trenches.perps.hour.v1';
/** M2: an open stops before its next Lighter step once this much time has passed since it started (the app's clock is 300 s) */
export const OPEN_DEADLINE_MS = 240_000;

const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
const unknownErr = (what: string) => named('PerpsUnknown', `Status unknown — ${what}; check your perps positions and history before trying again`, { unknown: true });
const usd = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const px = (n: number) => (n >= 1000 ? usd(n, 2) : n >= 1 ? usd(n, 4) : n.toPrecision(4));

export function createPerps(d: PerpsDeps) {
  const sleep = d.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // L1: perps exist on the Robinhood frame only — every method resolves its wallet through here
  const wallet = (id: string): Wallet => { if (!d.lane()) throw new Error('Perps run on the Robinhood Chain wallet frame'); return d.wallet(id); };
  // L6: inside the per-wallet lock, a key that another tab already used is not run a second time
  const fresh = (key?: string) => { if (key && d.idemSeen?.(key)) throw named('PerpsUnknown', 'Status unknown — this request already ran (another tab or an earlier try); check your perps positions and history', { unknown: true }); };
  // B1: the wallet key signs only a text that parses as Lighter's, for THIS wallet's account (and, for a transfer, the pinned pool)
  const signL1 = (w: Wallet, text: string, account: number) => { const why = l1TextProblem(text, { account, address: w.address, chainId: LIGHTER_CHAIN_ID }); if (why) throw new Error('Refused to sign: ' + why); return d.l1Sign(w.id, text, account); };
  const HEX80 = /^[0-9a-f]{80}$/, EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
  const { esc, sub, muted, addrRow } = d.html;

  // ── Lighter REST (browser-direct: CORS *, per-user IP rate limits; the motion server never sees these calls) ──
  async function get(path: string, auth?: string): Promise<Record<string, unknown>> {
    let r: Response;
    try { r = await d.fetch(LIGHTER_API + path, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: auth ? { Authorization: auth } : undefined, signal: AbortSignal.timeout(12_000) }); }
    catch { throw new Error('Lighter did not answer — check the connection and try again'); }
    if (r.status === 429) throw new Error('Lighter is rate-limiting this connection — try again in a minute');
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (!j) throw new Error(`Lighter answered ${r.status}`);
    return j;
  }
  /** POST a signed tx. A network failure AFTER the request may have reached Lighter: unknown, never resent. */
  async function post(path: string, form: Record<string, string>, auth?: string): Promise<unknown> {
    let r: Response;
    try {
      r = await d.fetch(LIGHTER_API + path, { method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth ? { Authorization: auth } : {}) }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
    } catch { return { lost: true }; }
    if (r.status === 429) return { code: 429, message: 'Lighter is rate-limiting this connection — try again in a minute' };
    const j = await r.json().catch(() => null);
    return j ?? { lost: true };
  }
  const memo = new Map<string, { at: number; v: Promise<unknown> }>();
  function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
    const hit = memo.get(key); if (hit && d.now() - hit.at < ms) return hit.v as Promise<T>;
    const v = fn(); memo.set(key, { at: d.now(), v }); v.catch(() => { if (memo.get(key)?.v === v) memo.delete(key); });
    if (memo.size > 300) memo.delete(memo.keys().next().value as string);
    return v;
  }
  const drop = (prefix: string) => { for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k); };

  const accountOf = (addr: Hex) => cached('acct:' + addr.toLowerCase(), 2500, async () => {
    const j = await get(`/api/v1/account?by=l1_address&value=${addr}`);
    if (Number(j.code) === 21100 || /not found/i.test(String(j.message || ''))) return null;
    const v = accountView(j);
    if (!v || v.l1.toLowerCase() !== addr.toLowerCase()) return null;   // only the master account of this very address
    return v;
  });
  /** the market's details; `maxAge` ms: 0 = read now, else a read at most that old is reused (an open reuses the quote's) */
  const marketRead = (id: number, maxAge = 15_000) => {
    const hit = memo.get('mkt:' + id + ':');
    if (hit && d.now() - hit.at > maxAge) memo.delete('mkt:' + id + ':');
    return cached('mkt:' + id + ':', 15_000, async () => {
      const j = await get(`/api/v1/orderBookDetails?market_id=${id}`);
      const row = ((j.order_book_details as Record<string, unknown>[]) || []).find((x) => Number(x.market_id) === id);
      if (!row) throw new Error('Unknown perps market');
      return marketOf(row);
    });
  };
  const bookTop = async (id: number) => {
    const j = await get(`/api/v1/orderBookOrders?market_id=${id}&limit=1`);
    const p = (side: unknown) => Number(((side as { price?: string }[] | undefined) || [])[0]?.price) || 0;
    return { ask: p(j.asks), bid: p(j.bids) };
  };
  const nonces = new NonceKeeper(async (account, key) => { const j = await get(`/api/v1/nextNonce?account_index=${account}&api_key_index=${key}`); if (Number(j.code) !== 200) throw new Error('Lighter did not give a nonce'); return Number(j.nonce); });
  const tokens = new Map<number, { token: string; exp: number }>();
  async function auth(w: Wallet, s?: LighterSigner, account: number | null | undefined = w.lt?.a): Promise<string> {
    if (account == null) throw new Error('Perps is not set up for this wallet');
    const t = tokens.get(account); if (t && t.exp - d.now() > 5 * 60_000) return t.token;
    const sg = s || await ready(w, account);
    const r = await sg.authToken(account, API_KEY_INDEX);
    tokens.set(account, { token: r.token, exp: r.deadline * 1000 });
    return r.token;
  }
  // ── this wallet's API key: derived, the same on every device (perpsCore KEY_DERIVATION) ──
  const derivedMemo = new Map<string, { k: string; p: string }>();
  /** The wallet's API key for `account`: Lighter's seed derivation (signer fromSeed) of deps.apiKeySeed. A derived record of
   *  this account (d: 1) is its cache. The private half stays in this frame (the Go runtime and the encrypted record). */
  async function derivedKey(w: Wallet, account: number): Promise<{ k: string; p: string }> {
    const lt = w.lt;
    if (lt?.d === 1 && lt.a === account && lt.i === API_KEY_INDEX && lt.k && lt.p) return { k: lt.k, p: String(lt.p).toLowerCase() };
    const id = w.id + ':' + account;
    const hit = derivedMemo.get(id); if (hit) return hit;
    const s = await d.signer();
    const r = await s.fromSeed(await d.apiKeySeed(w.id, account), account, API_KEY_INDEX, 0);
    const v = { k: r.privateKey, p: r.publicKey.toLowerCase() };
    derivedMemo.set(id, v);
    return v;
  }
  /** the signer, holding this wallet's (derived) key for its Lighter account */
  async function ready(w: Wallet, account: number | null | undefined = w.lt?.a): Promise<LighterSigner> {
    if (account == null) throw new Error('Perps is not set up for this wallet');
    const { k, p } = await derivedKey(w, account);
    const s = await d.signer();
    const { publicKey } = await s.use(k, account, API_KEY_INDEX);
    if (publicKey.toLowerCase() !== p) throw new Error('The perps key did not load — try again');
    return s;
  }
  /** the public key Lighter lists at our slot (77) of this wallet's own account ('' = the slot is empty); `maxAge` ms: a
   *  read at most that old is reused (an open: 4 s — another device may have registered its key at the slot meanwhile) */
  const slotKey = (account: number, maxAge = 60_000) => {
    const hit = memo.get(`key:${account}`);
    if (hit && d.now() - hit.at > maxAge) memo.delete(`key:${account}`);
    return slotRead(account);
  };
  const slotRead = (account: number) => cached(`key:${account}`, 60_000, async () => {
    const j = await get(`/api/v1/apikeys?account_index=${account}&api_key_index=${API_KEY_INDEX}`);
    const k = ((j.api_keys as { api_key_index?: number; public_key?: string }[]) || []).find((x) => Number(x.api_key_index) === API_KEY_INDEX);
    return k?.public_key ? String(k.public_key).toLowerCase() : '';
  });
  /**
   * Lighter's word on slot 77 of this wallet's own account, against this wallet's DERIVED key (whatever this vault stored):
   * · 'registered' — the wallet's key is there (registered from this device or from any other device of the wallet);
   * · 'mismatch'  — another key is there (an older engine's random key, from this device or another one);
   * · 'none'      — the slot is empty, or the wallet has no Lighter account.
   */
  const keyState = async (w: Wallet, account: number | null, maxAge?: number): Promise<'none' | 'registered' | 'mismatch'> => {
    if (account == null) return 'none';
    const pub = await slotKey(account, maxAge);
    if (!pub) return 'none';
    return (await derivedKey(w, account)).p === pub ? 'registered' : 'mismatch';
  };
  /** the region line is asked once per wallet: known when this vault has the declaration, or when slot 77 of the wallet's
   *  own Lighter account holds any key (only this flow registers there, and its first registration needs the ticked line) */
  const regionKnown = (w: Wallet, key: 'none' | 'registered' | 'mismatch') => !!w.lt?.region || key !== 'none';
  /** the declaration, remembered in the wallet's record (written after the dialog, inside the wallet's perps lock) */
  async function rememberRegion(w: Wallet, by: 'tick' | 'lighter') {
    if (w.lt?.region) return;
    const rec: LtRec = { ...(w.lt || { v: 1, i: API_KEY_INDEX }), v: 1, i: w.lt?.i ?? API_KEY_INDEX, region: d.now(), rby: by, at: d.now() };
    await d.saveLt(w.id, rec); w.lt = rec;
  }
  /**
   * Lighter lists this wallet's (derived) key at slot 77 of its own account: this vault keeps a confirmed record of it.
   * Nothing is signed or sent. It covers a new device or vault (no record), a lost record, a 'pending' or older-shaped
   * record whose key landed, and a device whose older random key was replaced by the wallet's key from another device.
   */
  async function adopt(w: Wallet, account: number | null | undefined, key: 'none' | 'registered' | 'mismatch') {
    const lt = w.lt;
    if (key !== 'registered' || account == null || (lt?.d === 1 && lt.a === account && lt.st === 'ok' && lt.region)) return;
    const { k, p } = await derivedKey(w, account);
    const region = lt?.region ? { region: lt.region, ...(lt.rby ? { rby: lt.rby } : {}) } : { region: d.now(), rby: 'lighter' as const };
    const rec: LtRec = { v: 1, i: API_KEY_INDEX, k, p, a: account, st: 'ok', d: 1, ...region, at: d.now() };
    await d.saveLt(w.id, rec); w.lt = rec;
  }

  // ── chain reads ──
  const ethOf = (a: Hex) => d.pc.getBalance({ address: a });
  const usdgOf = (a: Hex) => d.pc.readContract({ address: USDG, abi: ERC20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  const pendingOf = (a: Hex) => d.pc.readContract({ address: ZK_LIGHTER, abi: ZK, functionName: 'getPendingBalance', args: [a, USDG_ASSET] }) as Promise<bigint>;
  const pathOf = (fee: number) => encodePacked(['address', 'uint24', 'address'], [WETH, fee, USDG]);
  async function swapOut(fee: number, amountIn: bigint): Promise<bigint> {
    const r = await d.pc.simulateContract({ account: QUOTE_FROM, address: V3_ROUTER, abi: ROUTER, functionName: 'exactInput', args: [{ path: pathOf(fee), recipient: QUOTE_FROM, amountIn, amountOutMinimum: 0n }], value: amountIn, stateOverride: [{ address: QUOTE_FROM, balance: amountIn + 10n ** 18n }] }).catch(() => null);
    return r ? BigInt(r.result as bigint) : 0n;
  }
  /** ETH in for at least `want` USDG out, on the better of the two deep WETH/USDG pools (+0.4 % so the floor holds) */
  async function swapPlan(want: bigint): Promise<{ fee: number; ethIn: bigint; out: bigint }> {
    const probe = 10n ** 16n;   // 0.01 ETH
    // which pool pays more barely changes second to second: the probe is shared for 20 s (the ticket's quotes keep it
    // warm), so an open prices its swap with ONE simulation (the exact amount) instead of three
    const rates = await cached('swaprate', 20_000, () => Promise.all(SWAP_FEES.map(async (fee) => ({ fee, out: await swapOut(fee, probe) })))).then((x) => x.slice());
    const best = rates.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
    if (!best || best.out <= 0n) throw new Error('No ETH → USDG price on Robinhood Chain right now');
    let ethIn = (want * probe * 1004n) / (best.out * 1000n) + 1n;
    for (let i = 0; i < 3; i += 1) {
      const out = await swapOut(best.fee, ethIn);
      if (out >= want) return { fee: best.fee, ethIn, out };
      ethIn = ethIn * 1005n / 1000n + 1n;
    }
    throw new Error('The ETH → USDG pool moved while pricing — try again');
  }

  // ── progress (trench:perps) with the stall clock ──
  /** `extra`: fields every event of this step carries (the SL / TP step names its kind, market and price for the pills) */
  async function step<T>(key: string, walletId: string, id: string, fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
    const usual = USUAL_MS[id] || 2000; const t0 = d.now();
    d.emit({ ...extra, key, walletId, step: id, state: 'active', at: t0, eta: Math.round(usual / 1000) });
    const stall = setTimeout(() => d.emit({ ...extra, key, walletId, step: id, state: 'stalled', at: d.now(), note: 'taking longer than usual' }), usual * 3);
    try { const v = await fn(); d.emit({ ...extra, key, walletId, step: id, state: 'done', at: d.now(), ms: d.now() - t0 }); return v; }
    catch (e) { d.emit({ ...extra, key, walletId, step: id, state: 'failed', at: d.now(), note: String((e as Error)?.message || e).slice(0, 160) }); throw e; }
    finally { clearTimeout(stall); }
  }
  const evmSend = async (w: Wallet, to: Hex, data: Hex, value: bigint, fallbackGas: bigint) => {
    const est = await d.pc.estimateGas({ account: w.address, to, data, value }).catch(() => 0n);
    const gas = est > 0n ? est * 13n / 10n : fallbackGas;
    const hash = await d.sendTx(w.id, { to, data, value }, gas).catch((e) => { if ((e as { txState?: string })?.txState === 'unknown') throw unknownErr('a Robinhood Chain transaction may have been sent'); throw e; });
    const rc = await d.receipt(hash, 90_000).catch(() => { throw unknownErr(`transaction ${hash} was sent and has not confirmed yet`); });
    if (rc.status !== 'success') throw new Error(`Transaction ${hash.slice(0, 10)}… reverted on chain`);
    return hash;
  };

  // ── sending Lighter transactions ──
  /** sign with a fresh nonce, send, and on an "invalid nonce" refusal (nothing used) re-read the nonce and sign again */
  async function sendSigned(w: Wallet, sign: (nonce: number) => Promise<SignedTx>, form: (t: SignedTx) => { path: string; body: Record<string, string>; auth?: string } = (t) => ({ path: '/api/v1/sendTx', body: { tx_type: String(t.txType), tx_info: t.txInfo, price_protection: 'true' } })): Promise<{ hash: string; tx: SignedTx }> {
    const lt = w.lt!; const account = lt.a!;
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await nonces.take(account, lt.i);
      const tx = await sign(nonce);
      const f = form(tx);
      const raw = await post(f.path, f.body, f.auth);
      if ((raw as { lost?: boolean }).lost) { nonces.forget(account, lt.i); throw unknownErr('Lighter did not answer after the transaction was sent'); }
      const v = sendVerdict(raw);
      if (v.kind === 'ok') { nonces.accepted(account, lt.i, nonce); return { hash: v.hash || tx.txHash, tx }; }
      // L4: only Lighter's invalid-nonce answer (sendVerdict) re-signs, at most twice
      if (v.kind === 'nonce' && attempt < 2) { nonces.forget(account, lt.i); continue; }
      if (v.kind === 'nonce') nonces.forget(account, lt.i);
      if (v.kind === 'region') throw named('PerpsRegion', `Lighter refused this request from your region: ${v.message}`);
      // the key this tx was signed with is not the one at slot 77 (21120 / 21108 / 21109): nothing executed, nothing used.
      // Never resent here: withKey (or open's order step) reads the slot and decides (reconnect once, or a plain refusal)
      drop('key:');
      if (v.kind === 'key') { nonces.forget(account, lt.i); throw named('PerpsKey', `Lighter refused it: ${v.message}`, { code: v.code }); }
      throw named('PerpsRefused', `Lighter refused it: ${v.kind === 'refused' ? v.message : 'nonce'}`);
    }
  }
  /** accepted ≠ executed: read the tx until Lighter executed it (status 2) or `ms` passed (then: still pending) */
  async function outcome(hash: string, ms = 8000): Promise<ReturnType<typeof txOutcome>> {
    if (!HEX80.test(hash)) return { state: 'pending' as const };
    const t0 = d.now();
    for (let i = 0; d.now() - t0 < ms; i += 1) {
      const j = await get(`/api/v1/tx?by=hash&value=${hash}`).catch(() => null);
      const o = txOutcome(j);
      if (o.state !== 'pending') return o;
      await sleep(i < 8 ? 120 : i < 20 ? 300 : 800);
    }
    return { state: 'pending' as const };
  }
  /** how long an open / close waits in the call for Lighter's execution before it answers "accepted" and keeps watching */
  const FILL_WAIT_MS = 1500, FILL_WATCH_MS = 25_000;
  const fillOf = (o: ReturnType<typeof txOutcome>, type: 'market' | 'limit', m: Market) => {
    const filledBase = o.state === 'executed' && o.filled != null ? o.filled : 0n;
    // accepted = Lighter took it, not yet executed; unfilled = a market order that found nothing inside its cap (IOC: nothing left open)
    const state = o.state !== 'executed' ? 'accepted' : filledBase === 0n ? (type === 'limit' ? 'open' : 'unfilled') : o.size && filledBase < o.size ? 'partial' : 'filled';
    return { state, filledBase: decimal(filledBase, m.sizeDecimals), avgPrice: o.price ? decimal(BigInt(o.price), m.priceDecimals) : '' };
  };
  /**
   * The order is accepted: the call answers as soon as Lighter executed it (usually well under a second) or after
   * FILL_WAIT_MS with state 'accepted'; then this keeps reading and tells the page by a `trench:perps` event
   * `{ step: 'fill', state: 'done' | 'failed' | 'stalled', fill }` — the page never waits silently. Reads only.
   */
  async function settle(key: string, walletId: string, hash: string, type: 'market' | 'limit', m: Market) {
    const o = await outcome(hash, FILL_WAIT_MS);
    if (o.state !== 'pending') { d.emit({ key, walletId, step: 'fill', state: o.state === 'failed' ? 'failed' : 'done', at: d.now(), fill: o.state === 'failed' ? { state: 'failed', error: o.error } : fillOf(o, type, m) }); return o; }
    d.emit({ key, walletId, step: 'fill', state: 'active', at: d.now(), eta: 1 });
    void (async () => {
      const late = await outcome(hash, FILL_WATCH_MS).catch(() => ({ state: 'pending' as const }));
      drop('acct:'); drop('ord:');
      if (late.state === 'pending') d.emit({ key, walletId, step: 'fill', state: 'stalled', at: d.now(), note: 'Lighter has not confirmed the fill yet' });
      else d.emit({ key, walletId, step: 'fill', state: late.state === 'failed' ? 'failed' : 'done', at: d.now(), fill: late.state === 'failed' ? { state: 'failed', error: late.error } : fillOf(late, type, m) });
    })();
    return o;
  }

  // ── reads for the app ──
  const wdRead = (): Record<string, { hash: string; amount: string; at: number; readyAt: number; speed: string }[]> => { try { return JSON.parse(d.store.get(WD_KEY) || '{}') || {}; } catch { return {}; } };
  const wdNote = (addr: string, rec: { hash: string; amount: string; at: number; readyAt: number; speed: string }) => {
    const all = wdRead(); const k = addr.toLowerCase(); all[k] = [rec, ...(all[k] || [])].filter((x) => d.now() - x.at < 3 * 86_400_000).slice(0, 20);
    d.store.set(WD_KEY, JSON.stringify(all));
  };
  const cap = () => { const v = Number(d.store.get(CAP_KEY)); return v > 0 ? v : CAP_DEFAULT; };
  // L7: the notional this wallet opened in the last hour (orders Lighter accepted), kept on this device
  const hourRead = (): Record<string, { at: number; n: number }[]> => { try { return JSON.parse(d.store.get(HOUR_KEY) || '{}') || {}; } catch { return {}; } };
  const hourOf = (addr: string) => (hourRead()[addr.toLowerCase()] || []).filter((x) => d.now() - x.at < 3_600_000).reduce((a, x) => a + (Number(x.n) || 0), 0);
  // F-72 (V12): evict only by age (older than 1h). Above 200 kept entries, MERGE the oldest into a single bucket
  // (n = sum of notionals, at = newest of the merged) instead of dropping them, so a burst of 200 tiny orders can
  // never push a large order's notional out of the rolling-hour total that hourOf() enforces.
  const hourNote = (addr: string, n: number) => {
    const all = hourRead(); const k = addr.toLowerCase();
    let kept = [...(all[k] || []).filter((x) => d.now() - x.at < 3_600_000), { at: d.now(), n }];
    if (kept.length > 200) {
      kept.sort((a, b) => a.at - b.at);
      const over = kept.length - 200;
      const old = kept.slice(0, over + 1);
      const merged = { at: Math.max(...old.map((x) => x.at)), n: old.reduce((s, x) => s + (Number(x.n) || 0), 0) };
      kept = [merged, ...kept.slice(over + 1)];
    }
    all[k] = kept; d.store.set(HOUR_KEY, JSON.stringify(all));
  };
  const delaySec = () => cached('wdelay', 10 * 60_000, async () => { const j = await get('/api/v1/withdrawalDelay'); const s = Number(j.seconds); return s > 0 && s < 7 * 86_400 ? s : 400; });

  /**
   * Speed (owner's live test, 2026-10-22): the 7.6 MB signer was fetched and compiled at the first signature, in the
   * middle of the open. Any perps read on this frame (status while the perps page is open, the ticket's quote) now loads
   * it in the background (same pinned file, same origin, same hash check) and loads this wallet's key into it, so the
   * open finds it ready. Errors here are ignored: the open loads it again and reports a real failure.
   */
  let warming: Promise<unknown> | null = null;
  const warm = (w: Wallet) => {
    if (!warming) { const p: Promise<unknown> = d.signer().catch(() => { if (warming === p) warming = null; }); warming = p; }
    const lt = w.lt;
    if (lt?.a != null) void warming.then(() => ready(w)).catch(() => {});
  };
  async function status(walletId: string) {
    const w = wallet(walletId);
    warm(w);
    const [acct, eth, usdg, pending] = await Promise.all([accountOf(w.address), ethOf(w.address).catch(() => null), usdgOf(w.address).catch(() => null), pendingOf(w.address).catch(() => 0n)]);
    const account = acct ? acct.index : null;
    const key = await keyState(w, account).catch(() => 'none' as const);
    let orders: Record<string, unknown>[] | null = null;
    let withdrawals: { id: string; amount: string; status: string; at: number; readyAt: number }[] = [];
    if (key === 'registered' && account != null) {
      try {
        const tok = await auth(w, undefined, account);
        const [o, h] = await Promise.all([
          cached('ord:' + account, 4000, () => get(`/api/v1/accountActiveOrders?account_index=${account}&market_type=perp`, tok)),
          cached('wdh:' + account, 20_000, () => get(`/api/v1/withdraw/history?account_index=${account}&filter=all`, tok)).catch(() => null),
        ]);
        orders = ((o.orders as Record<string, unknown>[]) || []).map((x) => ({
          market: Number(x.market_index), symbol: String(x.market_symbol || ''), orderIndex: String(x.order_index), side: x.is_ask ? 'short' : 'long',
          kind: String(x.type || ''), price: String(x.price || '0'), trigger: String(x.trigger_price || '0'), size: String(x.initial_base_amount || x.base_size || '0'),
          filled: String(x.filled_base_amount || '0'), reduceOnly: !!x.reduce_only, createdAt: Number(x.created_at || x.timestamp) || 0,
        }));
        if (h && Array.isArray(h.withdraws)) withdrawals = (h.withdraws as Record<string, unknown>[]).slice(0, 20).map((x) => ({ id: String(x.id || ''), amount: String(x.amount || '0'), status: String(x.status || 'pending'), at: Number(x.timestamp) * (Number(x.timestamp) < 1e12 ? 1000 : 1) || 0, readyAt: 0 }));
      } catch { /* the public part still answers */ }
    }
    // the ones this vault sent, until Lighter's history has them (or 3 days)
    const mine = (wdRead()[w.address.toLowerCase()] || []).filter((x) => !withdrawals.some((y) => Math.abs(y.at - x.at) < 120_000 && Number(y.amount) === Number(x.amount)));
    withdrawals = [...mine.map((x) => ({ id: x.hash, amount: x.amount, status: x.readyAt > d.now() ? 'pending' : 'claimable', at: x.at, readyAt: x.readyAt })), ...withdrawals];
    // ready: this vault's key is the one Lighter lists (that implies the region declaration, see regionKnown)
    const ready = !!acct && key === 'registered';
    return {
      ok: true, walletId, address: w.address, account, key, ready, region: regionKnown(w, key),
      balance: acct ? { total: acct.total.toFixed(6), available: acct.available.toFixed(6), used: acct.used.toFixed(6) } : null,
      wallet: { eth: eth == null ? null : formatEther(eth), usdg: usdg == null ? null : formatUnits(usdg, USDG_DECIMALS) },
      positions: (acct?.positions || []).map((p) => ({ ...p, mark: '' })),
      orders, withdrawals, claimable: formatUnits(pending, USDG_DECIMALS), limits: { cap: cap(), leverageConfirm: LEVERAGE_CONFIRM }, at: d.now(),
    };
  }

  // ── the plan behind a ticket: read everything, change nothing ──
  async function plan(r: OrderReq & { walletId: string }, forOpen = false) {
    if (!d.lane()) throw new Error('Perps run on the Robinhood Chain wallet frame');
    const w = wallet(r.walletId);
    if (!forOpen) warm(w);
    const t0 = d.now();
    // every read at once (the key read follows the account read without waiting for the rest); an open reuses the
    // market details its quote read in the last 4 s (the book is always read now)
    const acctP = accountOf(w.address);
    const keyP = acctP.then((a) => keyState(w, a ? a.index : null, forOpen ? 4000 : 15_000)).catch(() => 'none' as const);
    // F-27 (V12): a failed USDG read is null (not 0n) — a 0 would plan a swap of ETH for USDG the wallet may already hold.
    const [m, book, acct, eth, usdg, gasPrice, allowance, key] = await Promise.all([marketRead(r.market, forOpen ? 4000 : 0), bookTop(r.market), acctP, ethOf(w.address), usdgOf(w.address).catch(() => null), d.gasPrice(),
      (d.pc.readContract({ address: USDG, abi: ERC20, functionName: 'allowance', args: [w.address, ZK_LIGHTER] }) as Promise<bigint>).catch(() => null), keyP]);
    const built = buildOrder(r, m, book, d.now());
    const account = acct ? acct.index : null;
    // M1: unless Lighter lists THIS record's key at slot 77 of this wallet's own account (keyState 'registered': same
    // device, same key — a 'pending' or older-shaped record whose key landed is confirmed by open(), nothing is signed),
    // the open registers a key, and that goes through the dialog. The region line is part of it only for a wallet that
    // never declared it (regionKnown); a known wallet on a new device / vault gets the light "Enable perps on this device".
    const setup = !acct || key !== 'registered';
    const known = regionKnown(w, key);
    const need = marginNeed(built.notional, r.leverage, r.slippageBps, acct ? acct.available : 0);
    let funding: null | { need: string; fromUsdg: string; swapEth: string; swapUsdg: string; deposit: string; gasEth: string; swap?: { fee: number; ethIn: bigint; out: bigint }; depositUnits: bigint; fromUnits: bigint; allowance?: bigint | null; usdg?: bigint } = null;
    const errors = [...built.errors];
    const steps: string[] = [];
    if (need.deposit > 0n) {
      // F-27 (V12): with the USDG balance unknown, surface the read failure instead of planning funding as if it were 0.
      if (usdg == null) {
        errors.push('USDG balance read failed — could not plan funding; try again');
      } else {
        const fromUnits = usdg >= need.deposit ? need.deposit : usdg;
        const rest = need.deposit - fromUnits;
        let swap: { fee: number; ethIn: bigint; out: bigint } | undefined;
        if (rest > 0n) swap = await swapPlan(rest).catch((e) => { errors.push(String((e as Error).message)); return undefined; });
        const gas = (swap ? GAS.swap : 0n) + GAS.approve + GAS.deposit;
        const gasEth = gas * gasPrice;
        if ((swap?.ethIn || 0n) + gasEth + GAS_RESERVE > eth) errors.push(`Not enough ETH: this needs about ${Number(formatEther((swap?.ethIn || 0n) + gasEth)).toFixed(6)} ETH, the wallet has ${Number(formatEther(eth)).toFixed(6)}`);
        funding = { need: need.need.toFixed(2), fromUsdg: decimal(fromUnits, 6), swapEth: swap ? formatEther(swap.ethIn) : '0', swapUsdg: swap ? decimal(rest, 6) : '0', deposit: decimal(need.deposit, 6), gasEth: formatEther(gasEth), swap, depositUnits: need.deposit, fromUnits, allowance, usdg };
        if (swap) steps.push('swap');
        steps.push('approve', 'deposit', 'credit');
      }
    }
    if (setup) steps.push('setup');
    steps.push('leverage', 'order');
    const hourly = hourOf(w.address);
    const confirm = confirmReasons({ setup, deposit: !!funding, leverage: r.leverage, notional: built.notional, cap: cap(), hourly });
    return { w, m, book, built, acct, key, setup, known, funding, confirm, steps, errors, hourly, at: d.now(), ms: d.now() - t0 };
  }
  const quoteOut = (p: Awaited<ReturnType<typeof plan>>, r: OrderReq) => ({
    ok: true, market: { id: p.m.id, symbol: p.m.symbol, mark: String(p.m.mark), maxLeverage: p.m.maxLeverage, minQuote: decimal(p.m.minQuote, 6), minBase: decimal(p.m.minBase, p.m.sizeDecimals) },
    side: r.side, type: r.type, notional: p.built.notional.toFixed(2), base: decimal(p.built.base, p.m.sizeDecimals), price: String(p.built.ref), worstPrice: String(p.built.worst),
    margin: p.built.margin.toFixed(2), fee: '0', liq: p.built.liq.toFixed(p.m.priceDecimals), leverage: r.leverage, marginMode: r.marginMode,
    funding: p.funding ? { need: p.funding.need, fromUsdg: p.funding.fromUsdg, swapEth: p.funding.swapEth, swapUsdg: p.funding.swapUsdg, deposit: p.funding.deposit, gasEth: p.funding.gasEth } : null,
    setup: p.setup, setupKind: p.setup ? (p.known ? 'device' : 'first') : null, confirm: p.confirm, steps: p.steps, etaSec: Math.ceil(p.steps.reduce((n, s) => n + (USUAL_MS[s] || 1000), 0) / 1000), errors: p.errors,
  });

  // ── the vault dialog (one for the whole open) ──
  const kv = (k: string, v: string) => `<div class="dk-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  const regionLine = () => `<label class="dk-pick"><input type="checkbox" data-region><span class="dk-nm dk-decl">I am not a resident of, or located in, ${esc(RESTRICTED_NAMES)}, and I am not a sanctioned person.</span></label>`;
  const regionCheck = (root: HTMLElement) => ((root.querySelector('[data-region]') as HTMLInputElement | null)?.checked ? null : 'Tick the line about where you are to continue.');
  const regText = (account: number) => `<details class="dk-row"><summary><span class="dk-nm">Registration text</span><span class="dk-sh">Lighter</span></summary><pre class="dk-pre">${esc(changePubKeyBody('…new key…', 0, account, API_KEY_INDEX).replace(/account index: 0x0+/, 'account index: (your account)'))}</pre></details>`;
  /** a wallet that already trades perps, but Lighter lists another key at slot 77 (an older engine's random key, from this
   *  device or another one): one line, one button, no checkbox (the key registration still goes through the vault's own
   *  dialog — review M1). After it every device of the wallet uses the same key. */
  const deviceLine = (name: string, then: string) => sub(`Perps is already confirmed for ${esc(name)}. Lighter has an older trading key for it, so this device registers the wallet's own key — the same on every device from now on${then}.`);
  function openDialog(p: Awaited<ReturnType<typeof plan>>, r: OrderReq) {
    const side = r.side === 'long' ? 'Long' : 'Short';
    const f = p.funding;
    const needRegion = p.setup && !p.known;
    if (p.setup && p.known && p.confirm.length === 1) {
      return d.ask({ title: 'Enable perps on this device', ok: `${side} ${p.m.symbol}`, html: `${deviceLine(p.w.name, `, then opens ${side} ${esc(p.m.symbol)} ${r.leverage}x for $${usd(p.built.notional)}`)}${regText(p.acct?.index ?? 0)}` });
    }
    const rows = [
      kv('Position', `${side} ${esc(p.m.symbol)} · ${r.leverage}x ${r.marginMode}`),
      kv('Size', `$${usd(p.built.notional)} <small>(${esc(decimal(p.built.base, p.m.sizeDecimals))} ${esc(p.m.symbol)})</small>`),
      kv('Margin', `$${usd(p.built.margin)}`),
      kv(r.type === 'market' ? 'Worst price' : 'Limit price', `$${esc(Number(decimal(p.built.priceTicks, p.m.priceDecimals)).toLocaleString('en-US', { maximumFractionDigits: p.m.priceDecimals }))}${r.type === 'market' ? ` <small>(${(r.slippageBps / 100).toFixed(2)} % max)</small>` : ''}`),
      kv('Est. liquidation', `$${px(p.built.liq)}`),
      kv('Trading fee', '0 %'),
      ...(f ? [
        ...(Number(f.fromUsdg) > 0 ? [kv('From your USDG', `${esc(f.fromUsdg)} USDG`)] : []),
        ...(f.swap ? [kv('Swap ETH → USDG', `${Number(f.swapEth).toFixed(6)} ETH → ${esc(f.swapUsdg)} USDG`)] : []),
        kv('Into your perps balance', `${esc(f.deposit)} USDG`),
        kv('Network fees', `≈ ${Number(f.gasEth).toFixed(7)} ETH`),
      ] : []),
      ...(r.tp ? [kv('Take profit', `$${esc(r.tp.trigger)}`)] : []),
      ...(r.sl ? [kv('Stop loss', `$${esc(r.sl.trigger)}`)] : []),
    ];
    const why = [
      ...(p.setup ? [p.known ? 'this device registers the wallet\'s trading key on Lighter again (the same on every device)' : 'first perps trade from this wallet (it registers a trading key on Lighter)'] : []),
      ...(f ? ['money moves into this wallet\'s own perps balance'] : []),
      ...(r.leverage >= LEVERAGE_CONFIRM ? [`${r.leverage}x leverage: a ${(100 / r.leverage).toFixed(1)} % move against you can liquidate the margin`] : []),
      ...(p.built.notional > cap() ? [`above the $${usd(cap(), 0)} size that goes out without asking`] : []),
      ...(p.built.notional <= cap() && p.hourly + p.built.notional > HOURLY_CAP ? [`with this order the wallet opens more than $${usd(HOURLY_CAP, 0)} within an hour`] : []),
    ];
    const html = `${sub(`${esc(side)} ${esc(p.m.symbol)} from ${esc(p.w.name)}. Executed on Lighter (Robinhood Chain).`)}<div class="dk-list">${rows.join('')}</div>${muted('Why this asks: ' + why.map(esc).join('; ') + '.')}${p.setup ? regText(p.acct?.index ?? 0) : ''}${needRegion ? regionLine() : ''}${muted('Leverage can lose the whole margin. Funding is paid every hour. Prices can gap.')}`;
    return d.ask({ title: needRegion ? 'Start trading perps' : f ? 'Fund and open' : p.setup ? 'Enable perps on this device' : `${side} ${p.m.symbol} ${r.leverage}x`, ok: `${side} ${p.m.symbol}`, danger: r.leverage >= LEVERAGE_CONFIRM, html, ...(needRegion ? { validate: (root: HTMLElement) => regionCheck(root) } : {}) });
  }

  // ── setup: the API key ──
  async function setupKey(w: Wallet, account: number, key: string): Promise<void> {
    await step(key, w.id, 'setup', async () => {
      const s = await d.signer();
      // the slot's nonce is read fresh: another device may have used slot 77 since this frame counted it
      nonces.forget(account, API_KEY_INDEX);
      const nonce = await nonces.take(account, API_KEY_INDEX);
      // the wallet's own key (derived: the same on every device), never a random one — a later device finds it and keeps it
      const k = await s.fromSeed(await d.apiKeySeed(w.id, account), account, API_KEY_INDEX, nonce);
      const pub = k.publicKey.toLowerCase();
      const known = derivedMemo.get(w.id + ':' + account);
      if (known && known.p !== pub) throw new Error('The perps key did not derive the same way twice — refused');
      derivedMemo.set(w.id + ':' + account, { k: k.privateKey, p: pub });
      // the text the wallet key signs is rebuilt here; one byte off and nothing is signed
      if (k.l1Body !== changePubKeyBody(k.publicKey, nonce, account, API_KEY_INDEX)) throw new Error('The registration text from the signer is not Lighter\'s template — refused');
      const rec: LtRec = { ...(w.lt || { v: 1, i: API_KEY_INDEX, at: d.now() }), v: 1, i: API_KEY_INDEX, k: k.privateKey, p: pub, a: account, st: 'pending', d: 1, at: d.now() };
      await d.saveLt(w.id, rec); w.lt = rec;   // stored before it is sent (and derivable again on any device in any case)
      const l1 = await signL1(w, k.l1Body, account);
      const raw = await post('/api/v1/sendTx', { tx_type: '8', tx_info: (await s.changePubKey(account, l1, nonce, API_KEY_INDEX)).txInfo, price_protection: 'true' });
      if ((raw as { lost?: boolean }).lost) { nonces.forget(account, API_KEY_INDEX); throw unknownErr('the perps key registration was sent but Lighter did not answer'); }
      const v = sendVerdict(raw);
      if (v.kind !== 'ok') { nonces.forget(account, API_KEY_INDEX); if (v.kind === 'region') throw named('PerpsRegion', `Lighter refused this request from your region: ${v.message}`); throw named('PerpsRefused', `Lighter refused the key registration: ${'message' in v ? v.message : 'refused'}`); }
      nonces.accepted(account, API_KEY_INDEX, nonce);
      drop('key:'); tokens.delete(account);
      for (let i = 0, t0 = d.now(); i < 80 && d.now() - t0 < 20_000; i += 1) {
        if ((await keyState(w, account).catch(() => 'none')) === 'registered') break;
        drop('key:'); await sleep(i < 10 ? 150 : 500);
      }
      const done: LtRec = { ...rec, st: 'ok', at: d.now() }; await d.saveLt(w.id, done); w.lt = done;
    });
  }

  // ── another key at slot 77: reconnect this device (one dialog), never a blind resend ──
  /** what the user sees after a reconnect: the `reconnect` event's note and the answer's `reconnected: true` */
  const RECONNECTED = 'This device was reconnected to Lighter';
  const isKeyRefusal = (e: unknown) => (e as { name?: string } | null)?.name === 'PerpsKey';
  /** a key refusal that is not fixed by a reconnect (Lighter lists this wallet's key, or a reconnect already ran): plain */
  const keyRefused = (e: unknown) => (isKeyRefusal(e) ? named('PerpsRefused', `${(e as Error).message} — nothing was executed`, { code: (e as { code?: number }).code }) : e);
  /** the account Lighter lists under this wallet's own address — the only one this wallet's key signs for */
  async function ownAccount(w: Wallet): Promise<number> {
    const a = await accountOf(w.address);
    if (!a) throw new Error('Perps is not set up for this wallet');
    return a.index;
  }
  /**
   * Lighter lists another key at slot 77 of this wallet's account (or none): register the wallet's own key again. Always
   * through the vault's dialog (review M1): the light one ("Enable perps on this device", no checkbox) for a wallet that
   * declared its region — any key at our slot means it did — else the first-time one with the region line.
   */
  async function reconnect(w: Wallet, account: number, key: string, state: 'none' | 'registered' | 'mismatch', then: string, sending?: () => void): Promise<boolean> {
    const known = regionKnown(w, state);
    const ok = known
      ? await d.ask({ title: 'Enable perps on this device', ok: 'Continue', html: `${deviceLine(w.name, then)}${regText(account)}` })
      : await d.ask({ title: 'Start trading perps', ok: 'Continue', html: `${sub(`${esc(w.name)} registers a trading key on Lighter (Robinhood Chain)${then}. It can trade and send money back to this wallet only; it stays in this vault.`)}<pre class="dk-pre">${esc(changePubKeyBody('…new key…', 0, account, API_KEY_INDEX))}</pre>${regionLine()}`, validate: (root: HTMLElement) => regionCheck(root) });
    if (!ok) throw new Error('Cancelled');
    await rememberRegion(w, known ? 'lighter' : 'tick');
    sending?.();
    await setupKey(w, account, key);
    // a wallet that already traded: "This device was reconnected to Lighter" (a first-ever registration is no reconnect)
    if (known) d.emit({ key, walletId: w.id, step: 'reconnect', state: 'done', at: d.now(), note: RECONNECTED });
    return known;
  }
  /**
   * Every Lighter transaction of a wallet that already trades (close, cancel, cancel-all, SL / TP, leverage, margin,
   * withdraw) runs here:
   * 1. Before: slot 77 of the wallet's own account must list the wallet's key (a read ≤ 15 s old). Another key there (an
   *    older engine's random key, e.g. a desktop that set perps up after the phone) → reconnect first (one dialog).
   * 2. `run` reads what it needs, signs with a fresh nonce and sends.
   * 3. Lighter refused the signature (21120 / 21108 / 21109 — API-level: nothing executed, no nonce used): the slot is read
   *    NOW. The wallet's key is there → a plain PerpsRefused (never resent blindly). Another key → reconnect (one dialog)
   *    and `run` once more from the start (fresh reads, fresh nonce). At most ONE reconnect per call; a lost answer
   *    (PerpsUnknown) is never retried.
   */
  async function withKey<T extends Record<string, unknown>>(w: Wallet, key: string, then: string, run: (s: LighterSigner, account: number) => Promise<T>, sending?: () => void): Promise<T & { reconnected?: true }> {
    const account = await ownAccount(w);
    const st = await keyState(w, account, 15_000);
    // `tried`: a registration already ran in this call (at most one); `told`: it was a reconnect of a wallet that traded
    let tried = false, told = false;
    if (st === 'registered') await adopt(w, account, st);
    else { told = await reconnect(w, account, key, st, then, sending); tried = true; }
    const once = async () => { const v = await run(await ready(w, account), account); return (told ? { ...v, reconnected: true as const } : v) as T & { reconnected?: true }; };
    try { return await once(); }
    catch (e) {
      if (!isKeyRefusal(e) || tried) throw keyRefused(e);
      drop('key:');
      const now = await keyState(w, account, 0);
      if (now === 'registered') throw keyRefused(e);
      told = await reconnect(w, account, key, now, then, sending); tried = true;
      try { return await once(); } catch (e2) { throw keyRefused(e2); }
    }
  }

  // ── funding: wallet USDG first, then ETH → USDG, approve, deposit, wait for the credit ──
  async function fund(w: Wallet, f: NonNullable<Awaited<ReturnType<typeof plan>>['funding']>, key: string, sending: () => void, before: number | null) {
    let swapHash: Hex | undefined;
    if (f.swap) {
      const s = f.swap;
      swapHash = await step(key, w.id, 'swap', async () => { sending(); return evmSend(w, V3_ROUTER, encodeFunctionData({ abi: ROUTER, functionName: 'exactInput', args: [{ path: pathOf(s.fee), recipient: w.address, amountIn: s.ethIn, amountOutMinimum: f.depositUnits - f.fromUnits }] }), s.ethIn, GAS.swap); });
    }
    // the balance check before the deposit runs alongside the approval (an approval does not move USDG); without a swap
    // the plan's read of a moment ago is the balance
    const haveP = swapHash || f.usdg == null ? usdgOf(w.address) : Promise.resolve(f.usdg);
    haveP.catch(() => {});
    await step(key, w.id, 'approve', async () => {
      const allow = f.allowance != null ? f.allowance : await d.pc.readContract({ address: USDG, abi: ERC20, functionName: 'allowance', args: [w.address, ZK_LIGHTER] }) as bigint;
      if (allow >= f.depositUnits) return;
      sending();
      // exactly this deposit, never an unlimited allowance
      await evmSend(w, USDG, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [ZK_LIGHTER, f.depositUnits] }), 0n, GAS.approve);
    });
    const have = await haveP;
    // F-42 (V12): this sufficiency check runs after sending() but before the deposit is signed, so nothing was executed.
    // Mark it preSend so once() drops the record (caller may retry) instead of storing a terminal 'failed'. The once()
    // deletion side is a webEngine change owned by another agent — this side only carries the flag.
    if (have < f.depositUnits) throw Object.assign(new Error(`The wallet holds ${decimal(have, 6)} USDG, the deposit needs ${decimal(f.depositUnits, 6)} — nothing was deposited`), { preSend: true });
    const depositHash = await step(key, w.id, 'deposit', async () => { sending(); return evmSend(w, ZK_LIGHTER, encodeFunctionData({ abi: ZK, functionName: 'deposit', args: [w.address, USDG_ASSET, ROUTE_PERP, f.depositUnits] }), 0n, GAS.deposit); });
    if (!EVM_HASH.test(depositHash)) throw unknownErr('the deposit transaction hash is malformed');
    const account = await step(key, w.id, 'credit', async () => {
      // Lighter credits 0.6-1.1 s after the block: ask every 150 ms at first, then back off. Status 2 = executed (credited),
      // 3 = the same, final: either one means the money is there
      const t0 = d.now();
      for (let i = 0; d.now() - t0 < 120_000 && i < 400; i += 1) {
        const j = await get(`/api/v1/txFromL1TxHash?hash=${depositHash}`).catch(() => null);
        if (j && Number(j.code) === 200 && (Number(j.status) === 2 || Number(j.status) === 3)) {
          drop('acct:');
          // L2: the account is the one Lighter lists under THIS wallet's own address — never the tx answer's account_index
          const a = await accountOf(w.address).catch(() => null);
          if (a) return a.index;
        }
        await sleep(i < 20 ? 150 : i < 40 ? 400 : 1500);
      }
      throw unknownErr(`the deposit ${depositHash.slice(0, 10)}… is on chain and Lighter has not credited it yet (it will appear in your perps balance)`);
    });
    if (before != null && before !== account) throw new Error('Lighter credited another account than this wallet\'s');
    return { account, swapHash, depositHash, deposit: f.deposit };
  }

  async function leverageTx(w: Wallet, m: Market, leverage: number, mode: 'cross' | 'isolated', key: string) {
    const s = await ready(w);
    const lt = w.lt!;
    // already set on this market? (the account read lists a market's margin settings once it was traded)
    const acct = await accountOf(w.address).catch(() => null);
    const pos = (acct?.positions || []).find((p) => p.market === m.id);
    const set = acct?.settings?.[m.id];
    if ((pos && pos.leverage === leverage && pos.marginMode === mode) || (set && set.leverage === leverage && set.marginMode === mode)) return null;
    return step(key, w.id, 'leverage', () => sendSigned(w, (n) => s.updateLeverage(lt.a!, m.id, imfOf(leverage), mode === 'isolated' ? 1 : 0, n)));
  }

  async function open(raw: unknown) {
    const r = args.open(raw);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.open', r.walletId, r.market, r.side, r.type, r.sizeUsdg, r.price || '', r.slippageBps, r.leverage, r.marginMode, r.tp?.trigger || '', r.sl?.trigger || ''], async (sending) => {
      const w0 = wallet(r.walletId);
      return d.lock('perps:' + w0.address.toLowerCase(), async () => {
        fresh(r.idempotencyKey);
        const started = d.now();
        // M2: past the deadline nothing more goes to Lighter (the app would already call it unknown)
        const inTime = (funded: boolean) => { if (d.now() - started > OPEN_DEADLINE_MS) throw named('PerpsTimeout', `This took too long — no order was sent${funded ? '; the money is in your perps balance' : ''}. Check your perps balance and try again.`); };
        const p = await plan(r, true);
        // timing trace for the page (not a timeline step; the app ignores unknown steps): plan + dialog
        d.emit({ key: r.idempotencyKey, walletId: r.walletId, step: 'plan', state: 'done', at: d.now(), ms: p.ms });
        if (p.errors.length) throw new Error(p.errors[0]);
        if (p.confirm.length) {
          const a0 = d.now();
          if (!(await openDialog(p, r))) throw new Error('Cancelled');
          d.emit({ key: r.idempotencyKey, walletId: r.walletId, step: 'dialog', state: 'done', at: d.now(), ms: d.now() - a0 });
        }
        const w = p.w;
        // Lighter lists the wallet's (derived) key: this vault keeps it — a new device, a lost / pending / older record (nothing signed)
        await adopt(w, p.acct ? p.acct.index : null, p.key);
        // the region declaration: ticked in this dialog (first time), or known from this wallet's Lighter account
        if (p.setup) await rememberRegion(w, p.known ? 'lighter' : 'tick');
        const key = r.idempotencyKey;
        const t0 = d.now();
        let funded: null | { deposit: string; swapHash?: Hex; depositHash: Hex } = null;
        let account = p.acct ? p.acct.index : null;
        let reconnected = false, keyed = false;   // keyed: this open registered the key already (at most once per call)
        if (p.funding) { const f = await fund(w, p.funding, key, sending, account); funded = { deposit: f.deposit, swapHash: f.swapHash, depositHash: f.depositHash }; account = f.account; }
        if (account == null) throw new Error('This wallet has no perps account yet');
        if (p.key !== 'registered' || w.lt?.a !== account || w.lt?.st !== 'ok' || w.lt?.d !== 1) {
          // M1: a key is never (re-)registered without the dialog that says so
          if (!p.confirm.includes('setup')) throw new Error('This wallet\'s perps key needs setting up again — open the trade again to confirm it');
          inTime(!!funded);
          sending(); await setupKey(w, account, key); keyed = true;
          // a wallet that already traded (another key was at slot 77): the page says "This device was reconnected to Lighter"
          if (p.known) { reconnected = true; d.emit({ key, walletId: w.id, step: 'reconnect', state: 'done', at: d.now(), note: RECONNECTED }); }
        }
        sending();
        inTime(!!funded);
        // the price may have moved while the money arrived / the key registered: the cap the user confirmed is the limit.
        // The book is re-read alongside the leverage step (not after it); with no funding, no setup and no dialog the plan's
        // read of a moment ago is current.
        const place = async (again: boolean) => {
          const bookP = again || funded || p.setup || d.now() - p.at > 1500 ? bookTop(r.market) : Promise.resolve(p.book);
          bookP.catch(() => {});
          await leverageTx(w, p.m, r.leverage, r.marginMode, key);
          const book = await bookP;
          const now = r.side === 'long' ? (book.ask || p.m.mark) : (book.bid || p.m.mark);
          if (r.type === 'market' && (r.side === 'long' ? now > p.built.worst : now < p.built.worst)) {
            throw named('PerpsPriceMoved', `The price moved to $${px(now)}, past your limit of $${px(p.built.worst)} — the order was not sent${funded ? '; the money is in your perps balance' : ''}`);
          }
          const s = await ready(w);
          const lt = w.lt!;
          inTime(!!funded);
          return step(key, w.id, 'order', () => sendSigned(w, (n) => (p.built.orders.length > 1 ? s.grouped(lt.a!, p.built.group, p.built.orders as OrderArgs[], n) : s.createOrder(lt.a!, p.built.orders[0] as OrderArgs, n))));
        };
        let sent: Awaited<ReturnType<typeof place>>;
        try { sent = await place(false); }
        catch (e) {
          // Lighter refused the signature (another key reached slot 77 since the plan read it): read the slot now; the
          // wallet's key there → a plain refusal; another key → reconnect (one dialog) and place the order ONCE more,
          // re-reading the book against the confirmed cap. Nothing executed before (an API-level refusal).
          if (!isKeyRefusal(e)) throw e;
          if (keyed) throw keyRefused(e);
          drop('key:');
          const st = await keyState(w, account, 0);
          if (st === 'registered') throw keyRefused(e);
          inTime(!!funded);
          reconnected = (await reconnect(w, account, key, st, `, then opens ${r.side === 'long' ? 'Long' : 'Short'} ${esc(p.m.symbol)} ${r.leverage}x for $${usd(p.built.notional)}`)) || reconnected;
          sent = await place(true).catch((e2) => { throw keyRefused(e2); });
        }
        hourNote(w.address, p.built.notional);
        drop('acct:'); drop('ord:');
        const o = await settle(key, w.id, sent.hash, r.type, p.m);
        if (o.state === 'failed') throw named('PerpsRefused', `Lighter did not execute the order: ${o.error}`);
        const f = fillOf(o, r.type, p.m);
        return { ok: true, state: f.state, confirming: f.state === 'accepted', txHash: sent.hash, market: p.m.id, symbol: p.m.symbol, side: r.side, base: decimal(p.built.base, p.m.sizeDecimals), filledBase: f.filledBase, avgPrice: f.avgPrice, liq: p.built.liq.toFixed(p.m.priceDecimals), notional: p.built.notional.toFixed(2), funded, ms: d.now() - t0, ...(reconnected ? { reconnected: true } : {}) };
      });
    });
  }

  async function close(raw: unknown) {
    const r = args.close(raw);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.close', r.walletId, r.market, r.fraction, r.slippageBps], async (sending) => {
      const w = wallet(r.walletId);
      return d.lock('perps:' + w.address.toLowerCase(), async () => {
        fresh(r.idempotencyKey);
        drop('acct:');
        // the position is read inside the attempt: after a reconnect (another device's key was at slot 77) the close is
        // rebuilt from fresh reads — that device may have changed the position meanwhile
        return withKey(w, r.idempotencyKey, ', then closes the position', async (s, account) => {
          drop('acct:');
          const [m, book, acct] = await Promise.all([marketRead(r.market, 0), bookTop(r.market), accountOf(w.address)]);
          const pos = acct?.positions.find((x) => x.market === r.market);
          if (!pos) throw new Error('No open position in this market');
          const c = buildClose(m, { size: units(pos.size, m.sizeDecimals), side: pos.side }, r.fraction, r.slippageBps, book);
          sending();
          const sent = await step(r.idempotencyKey, w.id, 'order', () => sendSigned(w, (n) => s.createOrder(account, c.order as OrderArgs, n)));
          drop('acct:'); drop('ord:');
          const o = await settle(r.idempotencyKey, w.id, sent.hash, 'market', m);
          if (o.state === 'failed') throw named('PerpsRefused', `Lighter did not execute the close: ${o.error}`);
          const f = fillOf(o, 'market', m);
          return { ok: true, state: f.state, confirming: f.state === 'accepted', txHash: sent.hash, market: m.id, symbol: m.symbol, side: pos.side, base: decimal(c.order.baseAmount, m.sizeDecimals), filledBase: f.filledBase, avgPrice: f.avgPrice, funded: null };
        }, sending);
      });
    });
  }

  // F-48 (V12): cancel/cancelAll now run under once() keyed by r.idempotencyKey (was a fresh 'cancel:'+now / 'cancelall:'+now,
  // so every retry was a replayable op). once() + fresh() block a duplicate from re-signing; the key is also the withKey id.
  async function cancel(raw: unknown) {
    const r = args.cancel(raw); const w = wallet(r.walletId);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.cancel', r.walletId, r.market, r.orderIndex], (sending) => d.lock('perps:' + w.address.toLowerCase(), async () => {
      fresh(r.idempotencyKey);
      return withKey(w, r.idempotencyKey, ', then cancels the order', async (s, account) => { sending(); const sent = await sendSigned(w, (n) => s.cancelOrder(account, r.market, BigInt(r.orderIndex), n)); drop('ord:'); return { ok: true, txHash: sent.hash }; }, sending);
    }));
  }
  async function cancelAll(raw: unknown) {
    const r = args.cancelAll(raw); const w = wallet(r.walletId);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.cancelAll', r.walletId, r.market], (sending) => d.lock('perps:' + w.address.toLowerCase(), async () => {
      fresh(r.idempotencyKey);
      return withKey(w, r.idempotencyKey, ', then cancels the orders', async (s, account) => { sending(); const sent = await sendSigned(w, (n) => s.cancelAll(account, 0, 0, n, r.market)); drop('ord:'); return { ok: true, txHash: sent.hash }; }, sending);
    }));
  }

  async function deposit(raw: unknown) {
    const r = args.deposit(raw);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.deposit', r.walletId, r.amountUsdg, r.pay], async (sending) => {
      if (!d.lane()) throw new Error('Perps run on the Robinhood Chain wallet frame');
      const w = wallet(r.walletId);
      return d.lock('perps:' + w.address.toLowerCase(), async () => {
        fresh(r.idempotencyKey);
        const want = units(r.amountUsdg, 6);
        if (want < 1_000_000n) throw new Error('Lighter takes at least 1 USDG per deposit');
        const [usdg, eth, gasPrice, acct] = await Promise.all([usdgOf(w.address), ethOf(w.address), d.gasPrice(), accountOf(w.address)]);
        const fromUnits = r.pay === 'eth' ? 0n : usdg >= want ? want : usdg;
        if (r.pay === 'usdg' && fromUnits < want) throw new Error(`The wallet holds ${decimal(usdg, 6)} USDG`);
        const swap = want - fromUnits > 0n ? await swapPlan(want - fromUnits) : undefined;
        const gasEth = ((swap ? GAS.swap : 0n) + GAS.approve + GAS.deposit) * gasPrice;
        if ((swap?.ethIn || 0n) + gasEth + GAS_RESERVE > eth) throw new Error('Not enough ETH for this deposit and its network fees');
        const f = { need: decimal(want, 6), fromUsdg: decimal(fromUnits, 6), swapEth: swap ? formatEther(swap.ethIn) : '0', swapUsdg: decimal(want - fromUnits, 6), deposit: decimal(want, 6), gasEth: formatEther(gasEth), swap, depositUnits: want, fromUnits };
        const ok = await d.ask({ title: 'Add to your perps balance', ok: `Add ${decimal(want, 6)} USDG`, html: `${sub(`From ${esc(w.name)} into its own perps balance on Lighter (Robinhood Chain).`)}<div class="dk-list">${[
          ...(fromUnits > 0n ? [kv('From your USDG', `${esc(f.fromUsdg)} USDG`)] : []), ...(swap ? [kv('Swap ETH → USDG', `${Number(f.swapEth).toFixed(6)} ETH → ${esc(f.swapUsdg)} USDG`)] : []),
          kv('Into your perps balance', `${esc(f.deposit)} USDG`), kv('Network fees', `≈ ${Number(f.gasEth).toFixed(7)} ETH`)].join('')}</div>${muted('It stays yours: send it back to this wallet any time (free, a few minutes).')}` });
        if (!ok) throw new Error('Cancelled');
        const res = await fund(w, f, r.idempotencyKey, sending, acct ? acct.index : null);
        drop('acct:');
        return { ok: true, state: 'filled', txHash: res.depositHash, funded: { deposit: res.deposit, swapHash: res.swapHash, depositHash: res.depositHash }, account: res.account };
      });
    });
  }

  async function fastInfo(w: Wallet) {
    if (FAST_WITHDRAW_POOL == null) return null;   // B1: instant withdrawals are off until the pool account is pinned
    const lt = w.lt; if (!lt?.k || lt.a == null) return null;
    const tok = await auth(w).catch(() => '');
    if (!tok) return null;
    const j = await get(`/api/v1/fastwithdraw/info?account_index=${lt.a}`, tok).catch(() => null);
    if (!j || Number(j.code) !== 200 || !(Number(j.to_account_index) > 0)) return null;
    const to = Number(j.to_account_index);
    if (to !== FAST_WITHDRAW_POOL) return null;   // an API-chosen destination is never used
    const fee = await get(`/api/v1/transferFeeInfo?account_index=${lt.a}&to_account_index=${to}`, tok).catch(() => null);
    if (!fee || Number(fee.code) !== 200 || !(Number(fee.transfer_fee_usdc) >= 0)) return null;
    return { to, fee: BigInt(Math.floor(Number(fee.transfer_fee_usdc))), limit: String(j.withdraw_limit || ''), max: String(j.max_withdrawal_amount || ''), tok };
  }
  async function amountOf(w: Wallet, amount: string | 'max') {
    drop('acct:');
    const acct = await accountOf(w.address); if (!acct) throw new Error('This wallet has no perps balance');
    const avail = units(acct.available.toFixed(6), 6);
    const want = amount === 'max' ? avail : units(amount, 6);
    return { acct, avail, want };
  }
  async function withdrawQuote(raw: unknown) {
    const r = args.withdrawQuote(raw); const w = wallet(r.walletId);
    const { avail, want } = await amountOf(w, r.amountUsdg);
    const fast = await fastInfo(w).catch(() => null);
    const fee = fast ? fast.fee : 0n;
    return {
      ok: true, amount: decimal(want, 6), available: decimal(avail, 6), standard: { fee: '0', seconds: await delaySec() },
      fast: fast && want >= MIN_WITHDRAW && want + fee <= avail && (!fast.max || Number(fast.max) <= 0 || Number(decimal(want, 6)) <= Number(fast.max)) ? { fee: decimal(fee, 6), limit: fast.limit, max: fast.max } : null,
    };
  }
  async function withdraw(raw: unknown) {
    const r = args.withdraw(raw);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.withdraw', r.walletId, r.amountUsdg, r.speed, r.maxFeeUsdg || ''], async (sending) => {
      const w = wallet(r.walletId);
      return d.lock('perps:' + w.address.toLowerCase(), async () => {
        fresh(r.idempotencyKey);
        return withKey(w, r.idempotencyKey, ', then asks about the withdrawal', async (s) => {
          const { avail, want } = await amountOf(w, r.amountUsdg);
          if (want < MIN_WITHDRAW) throw new Error('Lighter sends back at least 1 USDG at a time');
          if (want > avail) throw new Error(`Only ${decimal(avail, 6)} USDG is free (the rest holds open positions or orders)`);
          const lt = w.lt!;
          if (r.speed === 'standard') {
            const sec = await delaySec();
            const ok = await d.ask({ title: 'Send back to your wallet', ok: `Send ${decimal(want, 6)} USDG`, html: `${sub(`${esc(decimal(want, 6))} USDG from your perps balance back to ${esc(w.name)}. Free; it arrives in about ${Math.ceil(sec / 60)} minutes.`)}<div class="dk-list">${addrRow(w.name, w.address)}</div>${muted('Lighter sends it only to this wallet\'s own address. Until it arrives it shows as "on the way".')}` });
            if (!ok) throw new Error('Cancelled');
            sending();
            const sent = await sendSigned(w, (n) => s.withdraw(lt.a!, USDG_ASSET, ROUTE_PERP, want, n));
            const at = d.now();
            wdNote(w.address, { hash: sent.hash, amount: decimal(want, 6), at, readyAt: at + sec * 1000, speed: 'standard' });
            drop('acct:'); drop('wdh:');
            return { ok: true, txHash: sent.hash, speed: 'standard', amount: decimal(want, 6), fee: '0', etaSec: sec, readyAt: at + sec * 1000 };
          }
          const fast = await fastInfo(w);
          if (!fast) throw new Error('Instant withdrawal is not available right now — use the free one');
          const maxFee = units(r.maxFeeUsdg!, 6);
          if (fast.fee > maxFee) throw new Error(`The instant fee went up to ${decimal(fast.fee, 6)} USDG — check the new fee`);
          if (want + fast.fee > avail) throw new Error(`The amount plus the ${decimal(fast.fee, 6)} USDG fee is more than the free ${decimal(avail, 6)} USDG`);
          const ok = await d.ask({ title: 'Send back instantly', ok: `Send ${decimal(want, 6)} USDG`, html: `${sub(`${esc(decimal(want, 6))} USDG to ${esc(w.name)} within a minute. Lighter's instant fee: ${esc(decimal(fast.fee, 6))} USDG, taken from your perps balance.`)}<div class="dk-list">${addrRow(w.name, w.address)}${kv('You receive', `${esc(decimal(want, 6))} USDG`)}${kv('Fee', `${esc(decimal(fast.fee, 6))} USDG`)}</div>${muted('This wallet signs Lighter\'s transfer text naming this address as the destination.')}` });
          if (!ok) throw new Error('Cancelled');
          sending();
          const memoHex = withdrawMemo(w.address);
          const sent = await sendSigned(w, async (n) => {
            const body = await s.transferBody(lt.a!, n, lt.i, fast.to, USDG_ASSET, ROUTE_PERP, ROUTE_PERP, want, fast.fee, memoHex);
            if (body !== transferBody({ nonce: n, from: lt.a!, fromRoute: ROUTE_PERP, apiKey: lt.i, to: fast.to, toRoute: ROUTE_PERP, asset: USDG_ASSET, amount: want, fee: fast.fee, chainId: LIGHTER_CHAIN_ID, memoHex })) throw new Error('The transfer text from the signer is not Lighter\'s template — refused');
            const l1 = await signL1(w, body, lt.a!);
            return s.transfer(lt.a!, l1, n, lt.i, fast.to, USDG_ASSET, ROUTE_PERP, ROUTE_PERP, want, fast.fee, memoHex);
          }, (t) => ({ path: '/api/v1/fastwithdraw', body: { tx_info: t.txInfo, to_address: w.address }, auth: fast.tok }));
          drop('acct:'); drop('wdh:');
          return { ok: true, txHash: sent.hash, speed: 'fast', amount: decimal(want, 6), fee: decimal(fast.fee, 6), etaSec: 60, readyAt: d.now() + 60_000 };
        }, sending);
      });
    });
  }
  async function claim(raw: unknown) {
    const r = args.claim(raw); const w = wallet(r.walletId);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.claim', r.walletId], (sending) => d.lock('perps:' + w.address.toLowerCase(), async () => {
      fresh(r.idempotencyKey);
      const amount = await pendingOf(w.address);
      if (amount <= 0n) return { ok: true, hash: '', amount: '0' };
      const data = encodeFunctionData({ abi: ZK, functionName: 'withdrawPendingBalance', args: [w.address, USDG_ASSET, amount] });
      await d.pc.simulateContract({ account: w.address, address: ZK_LIGHTER, abi: ZK, functionName: 'withdrawPendingBalance', args: [w.address, USDG_ASSET, amount] });
      sending();
      const hash = await evmSend(w, ZK_LIGHTER, data, 0n, GAS.claim);
      return { ok: true, hash, amount: formatUnits(amount, 6) };
    }));
  }
  async function history(raw: unknown) {
    const r = args.history(raw); const w = wallet(r.walletId);
    const lt = w.lt; if (lt?.d !== 1 || lt.a == null) return { ok: true, items: [] };
    const tok = await auth(w);
    if (r.kind === 'fills') {
      const j = await get(`/api/v1/trades?account_index=${lt.a}&sort_by=timestamp&sort_dir=desc&limit=${r.limit}&market_type=perp`, tok);
      return { ok: true, items: ((j.trades as Record<string, unknown>[]) || []).map((t) => ({ market: Number(t.market_id), symbol: String(t.market_symbol || ''), side: Number(t.bid_account_id) === lt.a ? 'buy' : 'sell', size: String(t.size), price: String(t.price), usd: String(t.usd_amount), at: Number(t.timestamp), txHash: String(t.tx_hash || '') })) };
    }
    const j = await get(`/api/v1/positionFunding?account_index=${lt.a}&limit=${r.limit}`, tok);
    return { ok: true, items: ((j.position_fundings as Record<string, unknown>[]) || []).map((f) => ({ market: Number(f.market_id), change: String(f.change), rate: String(f.rate), size: String(f.position_size), side: String(f.position_side), at: Number(f.timestamp) })) };
  }
  async function setup(raw: unknown) {
    const r = args.setup(raw);
    if (!d.lane()) throw new Error('Perps run on the Robinhood Chain wallet frame');
    const w = wallet(r.walletId);
    return d.lock('perps:' + w.address.toLowerCase(), async () => {
      const acct = await accountOf(w.address);
      if (!acct) throw new Error('Add money to the perps balance first (the first deposit opens the account)');
      const key = await keyState(w, acct.index, 4000);
      // the wallet's key is at slot 77 (from this device or any other): nothing to register, this vault keeps the record
      if (key === 'registered') { await adopt(w, acct.index, key); return { ok: true, account: acct.index, key: 'registered' }; }
      // another key or none: the light dialog (a wallet that declared its region) or the first-time one, then the registration
      const told = await reconnect(w, acct.index, 'setup:' + d.now(), key, '');
      return { ok: true, account: acct.index, key: 'registered', ...(told ? { reconnected: true } : {}) };
    });
  }
  async function leverage(raw: unknown) {
    const r = args.leverage(raw); const w = wallet(r.walletId);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.leverage', r.walletId, r.market, r.leverage, r.marginMode], (sending) => d.lock('perps:' + w.address.toLowerCase(), async () => {
      fresh(r.idempotencyKey);
      const m = await marketRead(r.market, 0);
      if (r.leverage > m.maxLeverage) throw new Error(`${m.symbol} allows up to ${m.maxLeverage}x`);
      if (r.leverage >= LEVERAGE_CONFIRM && !(await d.ask({ title: `${r.leverage}x on ${m.symbol}`, danger: true, ok: `Set ${r.leverage}x`, html: sub(`A ${(100 / r.leverage).toFixed(1)} % move against a position can liquidate its margin.`) }))) throw new Error('Cancelled');
      // F-48 (V12): key is required now — no 'leverage:'+now fallback that would let a retry re-run under a fresh key.
      return withKey(w, r.idempotencyKey, `, then sets ${r.leverage}x on ${esc(m.symbol)}`, async (s, account) => {
        sending();
        const sent = await sendSigned(w, (n) => s.updateLeverage(account, m.id, imfOf(r.leverage), r.marginMode === 'isolated' ? 1 : 0, n));
        drop('acct:');
        return { ok: true, txHash: sent.hash };
      }, sending);
    }));
  }
  async function margin(raw: unknown) {
    const r = args.margin(raw); const w = wallet(r.walletId);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.margin', r.walletId, r.market, r.direction, r.amountUsdg], (sending) => d.lock('perps:' + w.address.toLowerCase(), async () => {
      fresh(r.idempotencyKey);
      await ownAccount(w);   // no Lighter account: refused before any dialog
      // F-15 (V12): r.market is parent-controlled, so the removal dialog reads the market and this wallet's own account,
      // refuses unless there is an ISOLATED position in that exact market, and shows the market, side, size, current
      // margin and the estimated liquidation price before and after — the parent can no longer hide which position shrinks.
      if (r.direction === 'remove') {
        const [mk, acct] = await Promise.all([marketRead(r.market, 0), accountOf(w.address)]);
        const pos = acct?.positions.find((x) => x.market === r.market);
        if (!pos) throw new Error(`No open position in ${mk.symbol} to take margin out of`);
        if (pos.marginMode !== 'isolated') throw new Error(`${mk.symbol} is on cross margin — margin can only be removed from an isolated position`);
        const sz = Number(pos.size) || 0, liqNow = Number(pos.liq) || 0, amt = Number(r.amountUsdg) || 0;
        // est. isolated liq after removal: it moves toward the mark by amount/size (a long's rises, a short's falls); the exact figure is Lighter's
        const newLiq = sz > 0 ? (pos.side === 'long' ? liqNow + amt / sz : Math.max(0, liqNow - amt / sz)) : liqNow;
        const ok = await d.ask({ title: 'Take margin out', danger: true, ok: `Remove ${r.amountUsdg} USDG`, html: `${sub(`${esc(r.amountUsdg)} USDG out of the isolated ${esc(pos.side)} ${esc(mk.symbol)} position's margin, back to the perps balance of ${esc(w.name)}.`)}<div class="dk-list">${[
          kv('Market', esc(mk.symbol)),
          kv('Side', esc(pos.side === 'long' ? 'Long' : 'Short')),
          kv('Size', `${esc(pos.size)} ${esc(mk.symbol)}`),
          kv('Current margin', `${esc(usd(Number(pos.margin), 2))} USDG`),
          kv('Est. liquidation now', `$${px(liqNow)}`),
          kv('Est. liquidation after', `$${px(newLiq)}`),
        ].join('')}</div>${muted('Less margin moves the liquidation price closer to the market. The exact figure is Lighter\'s once it executes.')}` });
        if (!ok) throw new Error('Cancelled');
      }
      // F-48 (V12): key is required now — no 'margin:'+now fallback that would let a retry re-run under a fresh key.
      return withKey(w, r.idempotencyKey, ', then moves the margin', async (s, account) => {
        sending();
        const sent = await sendSigned(w, (n) => s.updateMargin(account, r.market, units(r.amountUsdg, 6), r.direction === 'add' ? 1 : 0, n));
        drop('acct:');
        return { ok: true, txHash: sent.hash };
      }, sending);
    }));
  }
  /**
   * SL / TP on an OPEN position (2026-10-22): `{ walletId, market, kind: 'sl' | 'tp', triggerPrice, sizeShare?, replace?,
   * idempotencyKey }`. No dialog, like close(): a reduce-only trigger can only shrink or close this wallet's own position.
   * · The position, its side and size are read fresh from this wallet's own Lighter account; the mark from the market read
   *   (buildTrigger refuses a trigger on the wrong side of the mark or more than TRIGGER_BAND away).
   * · `replace` names this account's existing trigger of the SAME kind on the same market (checked against Lighter's active
   *   orders; anything else is refused before anything is sent). The new trigger is placed FIRST and the old one cancelled
   *   after it, so the position is never left without its stop: if the placement fails, the old one stays; if the cancel
   *   fails, both are open (both reduce-only) and the answer says `replaced: false`.
   * · Nonces as every Lighter tx (sendSigned); a lost answer is PerpsUnknown and never resent; once() per idempotency key,
   *   the per-wallet Web Lock, and the L6 re-check inside it.
   * · Events: `trench:perps { key, walletId, step: 'trigger' | 'replace', state, kind, market, symbol, triggerPrice }`.
   */
  async function trigger(raw: unknown) {
    const r = args.trigger(raw);
    return d.once({ idempotencyKey: r.idempotencyKey }, ['perps.trigger', r.walletId, r.market, r.kind, r.triggerPrice, r.sizeShare, r.replace || ''], (sending) => {
      const w = wallet(r.walletId);
      return d.lock('perps:' + w.address.toLowerCase(), async () => {
        fresh(r.idempotencyKey);
        return withKey(w, r.idempotencyKey, `, then sets the ${r.kind === 'sl' ? 'stop loss' : 'take profit'}`, async (s, account) => {
          const what = r.kind === 'sl' ? 'stop loss' : 'take profit';
          drop('acct:'); drop('ord:');
          const [m, acct, tok] = await Promise.all([marketRead(r.market, 0), accountOf(w.address), auth(w, s, account)]);
          // the side and the size are Lighter's, from this wallet's own account — never the page's
          const pos = acct?.positions.find((x) => x.market === r.market);
          if (!pos) throw new Error('No open position in this market');
          const t = buildTrigger(m, { size: units(pos.size, m.sizeDecimals), side: pos.side }, r.kind, Number(r.triggerPrice), r.sizeShare, d.now());
          if (t.errors.length) throw new Error(t.errors[0]);
          if (r.replace) {
            const j = await get(`/api/v1/accountActiveOrders?account_index=${account}&market_type=perp`, tok);
            const old = ((j.orders as Record<string, unknown>[]) || []).find((x) => String(x.order_index) === r.replace);
            if (!old || Number(old.market_index) !== r.market || triggerKindOf(old.type) !== r.kind || !old.reduce_only) throw new Error(`The ${what} to replace is no longer open on this market — nothing was changed`);
          }
          const triggerPrice = decimal(t.order.triggerPrice, m.priceDecimals);
          const extra = { kind: r.kind, market: m.id, symbol: m.symbol, triggerPrice };
          sending();
          const sent = await step(r.idempotencyKey, w.id, 'trigger', () => sendSigned(w, (n) => s.createOrder(account, t.order as OrderArgs, n)), extra);
          drop('acct:'); drop('ord:');
          const o = await outcome(sent.hash, FILL_WAIT_MS);
          if (o.state === 'failed') throw named('PerpsRefused', `Lighter did not place the ${what}: ${o.error}${r.replace ? '; the old one is still open' : ''}`);
          let replaced: boolean | null = null, cancelTxHash = '', replaceError = '', replaceUnknown = false, replacePending = false;
          if (r.replace) {
            // F-4 (V12): NEVER cancel the old trigger until the new one is actually on the book. Only cancel once the
            // create tx executed AND the new order shows up in accountActiveOrders; otherwise leave the old stop in place
            // and report replaced:false, replacePending:true — the position is never left without a stop.
            let live = false;
            if (o.state === 'executed') {
              const j = await get(`/api/v1/accountActiveOrders?account_index=${account}&market_type=perp`, tok).catch(() => null);
              const orders = (j?.orders as Record<string, unknown>[]) || [];
              live = orders.some((x) => (o.orderIndex && String(x.order_index) === o.orderIndex)
                || (Number(x.market_index) === r.market && triggerKindOf(x.type) === r.kind && !!x.reduce_only && String(x.order_index) !== r.replace));
            }
            if (!live) { replaced = false; replacePending = true; }
            else {
              try {
                cancelTxHash = (await step(r.idempotencyKey, w.id, 'replace', () => sendSigned(w, (n) => s.cancelOrder(account, r.market, BigInt(r.replace!), n)), extra)).hash;
                // F-51 (V12): replaced:true only once the cancel's own tx executed; false if it failed; null + replacePending while unconfirmed.
                const co = await outcome(cancelTxHash, 8000);
                replaced = co.state === 'executed' ? true : co.state === 'failed' ? false : null;
                if (replaced === null) replacePending = true;
              } catch (e) { replaced = false; replaceError = String((e as Error)?.message || e).slice(0, 200); replaceUnknown = !!(e as { unknown?: boolean })?.unknown; }
              drop('ord:');
            }
          }
          return {
            ok: true, state: o.state === 'executed' ? 'placed' : 'accepted', txHash: sent.hash, market: m.id, symbol: m.symbol, kind: r.kind, side: pos.side,
            triggerPrice, limitPrice: decimal(t.order.price, m.priceDecimals), sizeShare: r.sizeShare, base: r.sizeShare >= 100 ? '' : decimal(t.base, m.sizeDecimals), orderIndex: o.orderIndex || '',
            replaced, ...(replacePending ? { replacePending: true } : {}), ...(cancelTxHash ? { cancelTxHash } : {}), ...(replaceError ? { replaceError } : {}), ...(replaceUnknown ? { replaceUnknown: true } : {}),
          };
        }, sending);
      });
    });
  }
  async function quote(raw: unknown) { const r = args.quote(raw); return quoteOut(await plan(r), r); }

  return {
    status: (raw: unknown) => status(args.status(raw).walletId), quote, open, close, cancel, cancelAll, deposit, withdrawQuote, withdraw, claim, history, setup, leverage, margin, trigger,
    /** a wallet left the vault: its Lighter key leaves the signer's memory (only if the signer was ever loaded) */
    forget: async (account: number | undefined) => { if (account == null) return; tokens.delete(account); for (const k of [...derivedMemo.keys()]) if (k.endsWith(':' + account)) derivedMemo.delete(k); const s = peekSigner(); if (s) await s.forget(account).catch(() => {}); },
    /** test hook: the nonce counter (scripts/perps-engine.test.mjs) */
    _nonces: nonces, _leverageOf: leverageOf,
  };
}
