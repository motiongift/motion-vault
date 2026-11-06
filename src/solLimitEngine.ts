// Limit orders on Solana inside the vault (2026-10-25; trench docs/drafts/LIMIT-ORDERS.md §14): limit.place / cancel /
// list / sweep on the Solana frame. The design (src/solLimitCore.ts): per order an order wallet derived from the main
// Solana seed, a durable nonce it owns, one or two pre-signed swap variants on that nonce (the pump.fun curve and the
// PumpSwap pool it lists into), each paying the main wallet its floor inside the same transaction. The keeper holds only
// those bytes. A cancel / sweep closes the nonce account in the order wallet's way back: every pre-signed byte is dead.
//
// Rules (as every vault money path): one plain object per method, exact shape; once() per idempotency key; one lane per main
// wallet (lock); a vault dialog before an order is funded and before an order that may still fill is emptied; a sweep of an
// order that can no longer fill asks nothing; the order wallet's seed lives only inside the signer this file is handed.
import {
  SOL_MAX_OPEN, SOL_MIN_SIZE, SOL_NONCE_RENT, SOL_MAX_UNITS, SOL_MAX_MICRO, SOL_MAX_TIP, SOL_MAX_TX_BYTES, SOL_DUST, SP, JITO_TIP_ACCOUNTS,
  solLimitArgs, solMinOut, solNotional, toUnits, fromUnits, nonceAddressOf, nonceCreateIxs, nonceAdvanceIx, nonceWithdrawIx, nonceValueOf, payoutIxs,
  ataAddress, ataCreateIdem, tokenTransferChecked, tokenClose, sysTransfer, solOrderDigest, solAuthText, toB64, b58e,
  type SolIx, type SolVenue, type PostedSolOrder,
} from './solLimitCore.ts';

type Wallet = { id: string; name: string; address: string };
type Route = { mint: string; venue: 'pump' | 'pumpswap' | 'dlmm' | 'jupiter' | 'pumphop'; tokenProgram: string; decimals: number; symbol: string; isCashback: boolean };
type Acc = { owner: string; data: Uint8Array; lamports: number } | null | undefined;
export type SolOrderSigner = { address: string; sign(message: Uint8Array): Uint8Array };
export interface SolLimitDeps {
  lane(): boolean;
  wallet(id: string): Wallet;
  wallets(): Wallet[];
  orderIdAt(id: string, index: number): string;
  orderSigner(id: string, orderId: string): SolOrderSigner;
  /** the main wallet's signature of a transaction message (funding the order wallet) */
  mainSign(id: string, message: Uint8Array): Uint8Array;
  /** the main wallet's ed25519 signature (hex) of one of the three auth texts (the vault parses the text first) */
  signAuth(id: string, text: string): string;
  route(mint: string): Promise<Route>;
  venueIxs(user: string, r: Route, venue: SolVenue, side: 'buy' | 'sell', amount: bigint, minOut: bigint): SolIx[];
  budget(units: number, micro: number): SolIx[];
  compile(payer: string, ixs: SolIx[], blockhash: string): Uint8Array;
  plan(): Promise<{ micro: number; tipLamports: bigint }>;
  blockhash(): Promise<{ blockhash: string; lvh: number }>;
  accounts(addrs: string[]): Promise<Acc[]>;
  simulate(tx: Uint8Array, addrs: string[]): Promise<{ err: unknown; logs: string[]; accounts: ({ lamports: number; data: Uint8Array } | null)[] }>;
  errText(sim: unknown, side: 'buy' | 'sell', venue: string): string;
  send(tx: Uint8Array, holdKey: string, lvh: number): Promise<string>;
  statuses(sigs: string[]): Promise<(any | null | undefined)[]>;
  ask(o: { title: string; html: string; ok: string; danger?: boolean }): Promise<boolean>;
  html: { esc(v: unknown): string; sub(h: string): string; muted(h: string): string; addrRow(name: string, address: string): string };
  once<T extends Record<string, unknown>>(opts: { idempotencyKey?: string }, what: unknown[], run: (sending: () => void) => Promise<T>): Promise<T>;
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  emit(detail: Record<string, unknown>): void;
  fetch: typeof fetch;
  api(): string;
  store: { get(k: string): string | null; set(k: string, v: string): void };
  now(): number;
  sleep?(ms: number): Promise<void>;
}
export type SolLocalOrder = {
  v: 1; id: string; index: number; walletId: string; wallet: string; orderWallet: string; nonce: string; nonceValue: string; token: string; tokenProgram: string; symbol: string; decimals: number;
  side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; amountIn: string; minOut: Partial<Record<SolVenue, string>>; slippageBps: number; expiry: number; createdAt: number;
  venues: SolVenue[]; txs: { venue: SolVenue; raw: string; sig: string }[]; fund: string[]; setup: string[]; reserve: string;
  stage: 'funding' | 'setup' | 'signing' | 'open'; stored: boolean; recovered?: boolean; closed?: 'filled' | 'reverted' | 'cancelled' | 'expired' | 'failed'; sweptAt?: number; emptyAt?: number; error?: string;
};
export const SOL_LIMIT_STORE = 'trenches.limit.v1.sol';
const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
const sol = (l: bigint) => { const s = fromUnits(l < 0n ? 0n : l, 9); const [i, f = ''] = s.split('.'); return f ? `${i}.${f.slice(0, 6).replace(/0+$/, '') || '0'}` : i; };
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const rdU64 = (d: Uint8Array, o: number) => (d.length >= o + 8 ? new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true) : 0n);
const tokenOf = (a: Acc) => (a && a.data.length >= 72 ? rdU64(a.data, 64) : 0n);
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const signed = (message: Uint8Array, sig: Uint8Array) => cat(Uint8Array.of(1), sig, message);
// rent the order wallet puts down besides its swap (most of it comes back with the sweep): the nonce account, its own coin
// account and the venue's volume accumulator (pump / PumpSwap, kept by the venue), PumpSwap's temporary wSOL account
// (refunded inside the swap), the main wallet's coin account the payout may have to open, and its own rent-exempt floor
const RENT_ATA = 2_039_280n, RENT_ATA22 = 2_100_000n, RENT_UVA = 1_700_000n, RENT_WALLET = 890_880n, SIG = 5_000n;
const SETUP_UNITS = 30_000, SWEEP_UNITS = 80_000, SMALL_MICRO = 50_000, SWAP_UNITS = 250_000;
const SOL_MIN_TIP = 100_000n;                 // 0.0001 SOL: the smallest Jito tip a variant carries
const COIN_RETURN_RESERVE = 3_000_000n;       // what one later coin return costs (fee + the main wallet's token account)
const smallFee = (units: number) => SIG + (BigInt(units) * BigInt(SMALL_MICRO)) / 1_000_000n;

export function createSolLimit(d: SolLimitDeps) {
  const laneOk = () => { if (!d.lane()) throw named('LimitRefused', 'Solana limit orders run on the Solana lane'); };
  const sleep = d.sleep || ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  const readAll = (): Record<string, SolLocalOrder> => { try { const o = JSON.parse(d.store.get(SOL_LIMIT_STORE) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
  const put = (rec: SolLocalOrder) => {
    const all = readAll(); all[rec.id] = rec; const ids = Object.keys(all);
    if (ids.length > 200) for (const id of ids.filter((x) => all[x].closed && all[x].emptyAt).sort((a, b) => all[a].createdAt - all[b].createdAt).slice(0, ids.length - 200)) delete all[id];
    d.store.set(SOL_LIMIT_STORE, JSON.stringify(all));
  };
  const get = (id: string): SolLocalOrder | null => readAll()[id] || null;
  // security audit LO-10: a change made after an await goes onto the record as it is NOW (a close may have run meanwhile), as
  // the EVM side does — never a write-back of a copy read before the await
  const patch = (id: string, change: Partial<SolLocalOrder>) => { const cur = get(id); if (cur) put({ ...cur, ...change }); };
  const liveCount = (wallet: string) => Object.values(readAll()).filter((r) => r.wallet === wallet && !r.closed && r.expiry > d.now()).length;
  const indexOf = (w: Wallet) => Math.max(-1, ...Object.values(readAll()).filter((r) => r.wallet === w.address).map((r) => r.index));

  // a send of ours, then its confirmation (≤ 60 s): a dropped send is an error the caller handles; an unknown one throws
  async function sendAndConfirm(tx: Uint8Array, holdKey: string, lvh: number, what: string): Promise<string> {
    const sig = await d.send(tx, holdKey, lvh);
    for (let i = 0; i < 60; i++) {
      const [st] = await d.statuses([sig]).catch(() => [undefined]);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { if (st.err) throw named('LimitRefused', `${what} failed on chain`, { sig }); return sig; }
      await sleep(1000);
    }
    throw named('LimitUnknown', `Status unknown — ${what} was sent but not confirmed in time; check the order before trying again`, { unknown: true, sig });
  }
  // what the chain says about an order: its nonce (live / used / gone), the order wallet's SOL, its coin balance
  async function chainOf(rec: Pick<SolLocalOrder, 'orderWallet' | 'nonce' | 'nonceValue' | 'token' | 'tokenProgram'>) {
    const coin = !!rec.token && !!rec.tokenProgram;
    const [n, w, t] = await d.accounts([rec.nonce, rec.orderWallet, ...(coin ? [ataAddress(rec.orderWallet, rec.token, rec.tokenProgram)] : [])]);
    if (n === undefined || w === undefined || (coin && t === undefined)) throw new Error('Could not read the order from the Solana nodes');
    const value = n ? nonceValueOf(n.data, n.owner, rec.orderWallet) : null;
    return { nonce: !n ? 'gone' as const : value === rec.nonceValue ? 'live' as const : 'used' as const, nonceLamports: BigInt(n?.lamports || 0), lamports: BigInt(w?.lamports || 0), token: tokenOf(t), tokenAccount: !!t, tokenRent: BigInt(t?.lamports || 0) };
  }
  async function outcomeOf(rec: SolLocalOrder): Promise<'filled' | 'reverted' | 'cancelled'> {
    const sts = await d.statuses(rec.txs.map((t) => t.sig)).catch(() => []);
    for (const st of sts) if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st.err ? 'reverted' : 'filled';
    return 'cancelled';
  }
  const isEmpty = (st: { lamports: bigint; token: bigint; nonce: string }) => st.lamports <= SOL_DUST && st.token === 0n && st.nonce === 'gone';

  // ── the way back: the coin, the nonce account (closed: every pre-signed variant dies), the token accounts and the SOL,
  //    all to the main wallet in ONE transaction signed by the order wallet ──
  async function returnAll(w: Wallet, rec: SolLocalOrder, signer: SolOrderSigner) {
    const st = await chainOf(rec);
    const ow = signer.address, main = w.address;
    const ixs: SolIx[] = [...d.budget(SWEEP_UNITS, SMALL_MICRO)];
    if (st.token > 0n && rec.token) ixs.push(ataCreateIdem(ow, main, rec.token, rec.tokenProgram), tokenTransferChecked(ow, rec.token, main, st.token, rec.decimals, rec.tokenProgram));
    if (st.tokenAccount && rec.token) ixs.push(tokenClose(ataAddress(ow, rec.token, rec.tokenProgram), main, ow, rec.tokenProgram));
    const [wsol] = await d.accounts([ataAddress(ow, SP.wsol, SP.token)]);
    if (wsol) ixs.push(tokenClose(ataAddress(ow, SP.wsol, SP.token), main, ow, SP.token));
    if (st.nonce !== 'gone') ixs.push(nonceWithdrawIx(ow, main, st.nonceLamports));
    // the order wallet's own SOL last, all of it but this transaction's fee (a main-wallet coin account opened above is paid
    // from it first: its rent is set aside)
    const openMain = st.token > 0n ? ((await d.accounts([ataAddress(main, rec.token, rec.tokenProgram)]))[0] ? 0n : (rec.tokenProgram === SP.token22 ? RENT_ATA22 : RENT_ATA)) : 0n;
    // security audit LO-5: a recovered order whose coin nobody named keeps the SOL a later return of that coin needs
    const keep = smallFee(SWEEP_UNITS) + openMain + (rec.recovered && !rec.token ? COIN_RETURN_RESERVE : 0n);
    if (st.lamports > keep) ixs.push(sysTransfer(ow, main, st.lamports - keep));
    if (ixs.length <= 2) return { sig: '', st, invalidated: st.nonce === 'gone' };
    const bh = await d.blockhash();
    const message = d.compile(ow, ixs, bh.blockhash);
    const sig = await sendAndConfirm(signed(message, signer.sign(message)), ow, bh.lvh, 'Returning the order\'s funds');
    const after = await chainOf(rec).catch(() => null);
    return { sig, st: after || st, invalidated: !after || after.nonce === 'gone' };
  }

  const view = (rec: SolLocalOrder, state: string, st: Awaited<ReturnType<typeof chainOf>> | null) => ({
    orderId: rec.id, index: rec.index, walletId: rec.walletId, wallet: rec.wallet, orderWallet: rec.orderWallet, nonce: rec.nonce, chain: 'sol', native: 'SOL', token: rec.token, symbol: rec.symbol, decimals: rec.decimals,
    side: rec.side, kind: rec.kind, price: rec.price, amount: rec.amount, amountIn: rec.amountIn, minOut: { ...rec.minOut }, slippageBps: rec.slippageBps, expiry: rec.expiry, createdAt: rec.createdAt,
    venues: [...rec.venues], stored: rec.stored, state, txs: { fund: [...rec.fund], setup: [...rec.setup], swap: Object.fromEntries(rec.txs.map((t) => [t.venue, t.sig])) }, reserve: rec.reserve,
    ...(st ? { balance: { sol: sol(st.lamports), token: fromUnits(st.token, rec.decimals), nonce: st.nonce } } : {}),
    sweepable: !!st && !isEmpty(st) && state !== 'open' && state !== 'placing' && state !== 'recovered',
    cancelable: !!st && (state === 'open' || (state === 'recovered' && !isEmpty(st))), recovered: !!rec.recovered,
    ...(rec.error ? { error: rec.error } : {}),
  });

  // ── our server ──
  const api = () => d.api().replace(/\/+$/, '') + '/sol/api/limit';
  async function postOrder(w: Wallet, order: PostedSolOrder) {
    const at = d.now();
    const sig = d.signAuth(w.id, solAuthText({ action: 'place', wallet: w.address, id: order.id, orderWallet: order.orderWallet, digest: solOrderDigest(order), at }));
    try {
      const r = await d.fetch(api(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order, auth: { at, sig } }), credentials: 'omit', signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      return { ok: r.ok && !!j?.ok, status: r.status, error: j?.error ? String(j.error).slice(0, 160) : undefined };
    } catch (e) { return { ok: false, status: 0, error: String((e as Error)?.message || e).slice(0, 120) }; }
  }
  async function deleteOrder(w: Wallet, id: string) {
    const at = d.now(); const sig = d.signAuth(w.id, solAuthText({ action: 'cancel', wallet: w.address, id, at }));
    try { const r = await d.fetch(api(), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, wallet: w.address, auth: { at, sig } }), credentials: 'omit', signal: AbortSignal.timeout(10_000) }); return r.ok; } catch { return false; }
  }
  const posted = (rec: SolLocalOrder): PostedSolOrder => ({ v: 1, id: rec.id, chain: 'sol', wallet: rec.wallet, orderWallet: rec.orderWallet, nonce: rec.nonce, nonceValue: rec.nonceValue, token: rec.token, tokenProgram: rec.tokenProgram, symbol: rec.symbol, decimals: rec.decimals,
    side: rec.side, kind: rec.kind, price: rec.price, amount: rec.amount, amountIn: rec.amountIn, minOut: { ...rec.minOut }, slippageBps: rec.slippageBps, expiry: rec.expiry, createdAt: rec.createdAt, txs: rec.txs.map((t) => ({ venue: t.venue, raw: t.raw })) });
  const reads = new Map<string, { at: number; sig: string }>();
  function readToken(w: Wallet) {
    const hit = reads.get(w.address); if (hit && d.now() - hit.at < 12 * 3600_000) return { wallet: w.address, ...hit };
    const at = d.now(); const sig = d.signAuth(w.id, solAuthText({ action: 'read', wallet: w.address, at })); reads.set(w.address, { at, sig }); return { wallet: w.address, at, sig };
  }

  // the next order: the first index after this browser's last whose order wallet and nonce are unused on chain
  async function nextOrder(w: Wallet) {
    for (let i = indexOf(w) + 1, n = 0; n < 50; i += 1, n += 1) {
      const id = d.orderIdAt(w.id, i); if (get(id)) continue;
      const signer = d.orderSigner(w.id, id);
      const [a, nn] = await d.accounts([signer.address, nonceAddressOf(signer.address)]);
      if (a === undefined || nn === undefined) throw named('LimitRefused', 'Could not read the Solana nodes — nothing was sent; try again');
      if (a || nn) continue;   // used (a wiped browser's order): its funds come back through list's recovery, never reused
      return { id, index: i, signer };
    }
    throw named('LimitRefused', 'No free order slot found — list your orders first');
  }

  // ── limit.place ──
  async function place(o: unknown) {
    laneOk();
    const a = solLimitArgs.place(o);
    const w = d.wallet(a.walletId);
    return d.once({ idempotencyKey: a.idempotencyKey }, ['sol.limit.place', w.id, a.token, a.side, a.kind, a.price, a.amount, a.slippageBps, a.expiresIn], (sending) => d.lock('sol-limit:' + w.address, async () => {
      const key = a.idempotencyKey;
      const ev = (step: string, state: string, x: Record<string, unknown> = {}) => d.emit({ key, walletId: w.id, step, state, ...x });
      const main = w.address, mint = a.token;
      if (liveCount(main) >= SOL_MAX_OPEN) throw named('LimitRefused', `This wallet already has ${SOL_MAX_OPEN} open orders — cancel one first`);
      ev('plan', 'active');
      // the vault reads the coin's market itself (never the page's route): the curve while it trades, else its PumpSwap pool
      const r = await d.route(mint);
      if (r.isCashback) throw named('LimitRefused', 'Cashback coins are not supported yet');
      // (pumphop, 2026-11-01) a coin quoted in another pump coin trades from SOL in one multi_hop_swap — not a limit-order venue (v1)
      if (r.venue === 'dlmm' || r.venue === 'jupiter' || r.venue === 'pumphop') throw named('LimitRefused', r.venue === 'jupiter' || r.venue === 'pumphop' ? 'This coin is quoted in another token — limit orders trade SOL-quoted pump.fun curves and PumpSwap pools (v1)' : 'This coin trades on Meteora against SOL — limit orders trade pump.fun curves and PumpSwap pools (v1)');
      const venues: SolVenue[] = r.venue === 'pump' ? ['pump', 'pumpswap'] : ['pumpswap'];
      const decimals = r.decimals, symbol = String(r.symbol || '?').slice(0, 24), tp = r.tokenProgram;
      const amountIn = a.side === 'buy' ? toUnits(a.amount, 9) : toUnits(a.amount, decimals);
      const size = a.side === 'buy' ? amountIn : solNotional(amountIn, a.price, decimals);
      if (size < SOL_MIN_SIZE) throw named('LimitRefused', `The minimum order is ${sol(SOL_MIN_SIZE)} SOL${a.side === 'sell' ? ' at the limit price' : ''}`);
      const mins = Object.fromEntries(venues.map((v) => [v, solMinOut({ side: a.side, amountIn, price: a.price, decimals, slippageBps: a.slippageBps })])) as Record<SolVenue, bigint>;
      const createdAt = d.now(), expiry = createdAt + a.expiresIn * 1000;
      const { id: orderId, index, signer } = await nextOrder(w); const ow = signer.address; const nonce = nonceAddressOf(ow);
      const [mainAcc, mainTok, mainCoinAta] = await d.accounts([main, ataAddress(main, mint, tp), ataAddress(main, mint, tp)]);
      if (mainAcc === undefined || mainTok === undefined) throw named('LimitRefused', 'Could not read this wallet from the Solana nodes — nothing was sent; try again');
      const have = BigInt(mainAcc?.lamports || 0), haveTok = tokenOf(mainTok);
      if (a.side === 'sell' && haveTok < amountIn) throw named('LimitRefused', `Not enough ${symbol}: ${fromUnits(haveTok, decimals)} in this wallet`);
      // the priority and tip each variant carries (fixed at signing: the order must still land days from now), within bounds
      const plan = await d.plan().catch(() => ({ micro: 100_000, tipLamports: 0n }));
      // security audit LO-6: every variant carries a Jito tip, so the keeper can send it through the block engines only
      const micro = Math.min(SOL_MAX_MICRO, Math.max(10_000, plan.micro)); const tip = plan.tipLamports > SOL_MAX_TIP ? SOL_MAX_TIP : plan.tipLamports < SOL_MIN_TIP ? SOL_MIN_TIP : plan.tipLamports;
      const swapFee = SIG + (BigInt(SWAP_UNITS) * BigInt(micro)) / 1_000_000n + tip;
      const ataRent = tp === SP.token22 ? RENT_ATA22 : RENT_ATA;
      const reserve = SOL_NONCE_RENT + smallFee(SETUP_UNITS) + swapFee + smallFee(SWEEP_UNITS) + RENT_WALLET + RENT_UVA + RENT_ATA /* PumpSwap's wSOL */ +
        (a.side === 'buy' ? ataRent /* its coin account */ + (mainCoinAta ? 0n : ataRent) /* the main wallet's, opened by the payout */ : 0n);
      const fundValue = (a.side === 'buy' ? amountIn : 0n) + reserve;
      const fundCost = smallFee(SETUP_UNITS) + (a.side === 'sell' ? ataRent : 0n);
      if (have < fundValue + fundCost + RENT_WALLET) throw named('LimitRefused', `Not enough SOL: the order needs ${sol(fundValue + fundCost)} SOL (incl. ${sol(reserve)} reserve, most of it comes back), the wallet has ${sol(have)}`);
      ev('plan', 'done', { reserve: sol(reserve), venues });
      // ── the dialog ──
      const { esc, sub, muted, addrRow } = d.html;
      const kv = (k: string, v: string) => `<div class="dk-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
      const what = a.side === 'buy' ? `Buy ${symbol} with ${a.amount} SOL` : `Sell ${a.amount} ${symbol}`;
      const best = venues.map((v) => mins[v]).reduce((m, x) => (x < m ? x : m));
      const ok = await d.ask({
        title: a.kind === 'limit' ? 'Place limit order' : a.kind === 'tp' ? 'Set take-profit' : 'Set stop-loss', ok: a.kind === 'limit' ? 'Place order' : a.kind === 'tp' ? 'Set take-profit' : 'Set stop-loss',
        html: `${sub(`${esc(what)} when the price is ${a.kind === 'tp' ? 'at or above' : 'at or below'} <b>${esc(a.price)} SOL</b> per ${esc(symbol)}. Paid to ${esc(w.name)}.`)}<div class="dk-list">${[
          addrRow(`Token ${symbol}`, mint),
          kv('Venue', esc(venues.length > 1 ? 'pump.fun curve (its PumpSwap pool once it lists)' : 'PumpSwap pool')),
          kv('You receive at least', esc(a.side === 'buy' ? `${fromUnits(best, decimals)} ${symbol}` : `${sol(best)} SOL`)),
          kv('Slippage', `${a.slippageBps / 100} %`), kv('Expires', esc(utc(expiry))),
          kv('Moves now', esc(a.side === 'buy' ? `${sol(fundValue)} SOL (${sol(reserve)} reserve)` : `${a.amount} ${symbol} + ${sol(reserve)} SOL reserve`)),
          addrRow('Order wallet', ow),
        ].join('')}</div>${muted(`The order wallet is this order's own; only this vault can sign for it. motion's server keeps the signed swap and sends it when the price is reached — it cannot change the amount, price, venue or recipient. The floor is paid to ${esc(w.name)} in the same transaction. Anything the fill makes above the floor stays in the order wallet until this vault is open again (motion.gift in any tab); the vault then returns it to ${esc(w.name)} by itself. Cancel any time: everything comes back. The reserve (the order's nonce and token-account rent, network fees) mostly returns too.${a.kind === 'sl' ? ' A stop-loss fills at the minimum or not at all: in a fast drop it may not fill. Its floor sits under today\'s price, so whoever holds the signed swap (motion\'s server) can send it at any moment, not only when the price is reached — it then fills at that floor.' : ''}`)}`,
      });
      if (!ok) throw named('Cancelled', 'Cancelled');
      sending();
      const rec: SolLocalOrder = {
        v: 1, id: orderId, index, walletId: w.id, wallet: main, orderWallet: ow, nonce, nonceValue: '', token: mint, tokenProgram: tp, symbol, decimals, side: a.side, kind: a.kind, price: a.price, amount: a.amount, amountIn: amountIn.toString(),
        minOut: Object.fromEntries(venues.map((v) => [v, mins[v].toString()])), slippageBps: a.slippageBps, expiry, createdAt, venues, txs: [], fund: [], setup: [], reserve: reserve.toString(), stage: 'funding', stored: false,
      };
      put(rec);
      const fail = (e: unknown) => { rec.error = String((e as Error)?.message || e).slice(0, 200); put(rec); return e; };
      const back = async (why: string) => {
        rec.error = why.slice(0, 200); put(rec);
        const r2 = await returnAll(w, rec, signer).catch(() => null);
        rec.closed = 'failed'; if (r2) { rec.sweptAt = d.now(); if (isEmpty(r2.st)) rec.emptyAt = d.now(); } put(rec);
        return named('LimitRefused', `${why} — ${r2 ? `the funds went back to ${w.name}` : 'return them with limit.sweep'}`, { orderId });
      };
      // ── funding: the main wallet → the order wallet (SOL; a sell also its coins) ──
      ev('fund', 'active', { orderId, orderWallet: ow });
      try {
        const bh = await d.blockhash();
        const ixs: SolIx[] = [...d.budget(SETUP_UNITS, SMALL_MICRO), sysTransfer(main, ow, fundValue)];
        if (a.side === 'sell') ixs.push(ataCreateIdem(main, ow, mint, tp), tokenTransferChecked(main, mint, ow, amountIn, decimals, tp));
        const msg = d.compile(main, ixs, bh.blockhash);
        rec.fund.push(await sendAndConfirm(signed(msg, d.mainSign(w.id, msg)), main, bh.lvh, 'Funding the order wallet')); put(rec);
      } catch (e) { throw fail(e); }
      ev('fund', 'done', { orderId, sigs: [...rec.fund] });
      try {
        // ── the nonce: created from the order wallet, which is its authority ──
        rec.stage = 'setup'; put(rec);
        ev('setup', 'active', { orderId });
        const bh = await d.blockhash();
        const msg = d.compile(ow, [...d.budget(SETUP_UNITS, SMALL_MICRO), ...nonceCreateIxs(ow)], bh.blockhash);
        rec.setup.push(await sendAndConfirm(signed(msg, signer.sign(msg)), ow, bh.lvh, 'Creating the order\'s nonce')); put(rec);
        let value: string | null = null;
        for (let i = 0; i < 10 && !value; i++) { const [n] = await d.accounts([nonce]); value = n ? nonceValueOf(n.data, n.owner, ow) : null; if (!value) await sleep(800); }
        if (!value) throw await back('The order\'s nonce did not appear on chain');
        rec.nonceValue = value; rec.stage = 'signing'; put(rec);
        ev('setup', 'done', { orderId });
        // ── the variants: one nonce, the floor to the main wallet inside each ──
        ev('sign', 'active', { orderId });
        const variant = (v: SolVenue, floor: bigint, blockhash: string) => d.compile(ow, [
          nonceAdvanceIx(ow), ...d.budget(SWAP_UNITS, micro), ...d.venueIxs(ow, r, v, a.side, amountIn, floor),
          ...payoutIxs({ side: a.side, orderWallet: ow, main, mint, tokenProgram: tp, decimals, minOut: floor }),
          ...(tip > 0n ? [sysTransfer(ow, JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)], tip)] : []),
        ], blockhash);
        for (const v of venues) {
          const msg = variant(v, mins[v], value);
          const sig = signer.sign(msg); const tx = signed(msg, sig);
          if (tx.length > SOL_MAX_TX_BYTES) throw await back('The order\'s transaction is too large');
          rec.txs.push({ venue: v, raw: toB64(tx), sig: b58e(sig) });
        }
        put(rec);
        // the venue that trades now must take the swap FROM the order wallet and pay the MAIN wallet: the same instructions
        // with a floor of one unit, simulated (unsigned, nothing could land) with the main wallet's account read after it
        const checks: Record<string, string> = {};
        const now = r.venue === 'pump' ? 'pump' : 'pumpswap';
        const probe = variant(now, 1n, value);
        const target = a.side === 'buy' ? ataAddress(main, mint, tp) : main;
        const own = a.side === 'buy' ? ataAddress(ow, mint, tp) : ow;
        const [pre, preOwn] = await d.accounts([target, own]);
        if (pre === undefined || preOwn === undefined) throw await back('Could not read the main wallet to check the payout');
        const before = a.side === 'buy' ? tokenOf(pre) : BigInt(pre?.lamports || 0);
        const beforeOwn = a.side === 'buy' ? tokenOf(preOwn) : BigInt(preOwn?.lamports || 0);
        const sim = await d.simulate(cat(Uint8Array.of(1), new Uint8Array(64), probe), [target, own]);
        if (sim.err) throw await back(`The swap would not go through from the order wallet (${d.errText(sim, a.side, now)})`);
        const after = sim.accounts[0] ? (a.side === 'buy' ? tokenOf({ owner: '', lamports: 0, data: sim.accounts[0].data }) : BigInt(sim.accounts[0].lamports)) : 0n;
        if (!(after > before)) throw await back('The swap does not pay the main wallet');
        checks[now] = 'paid';
        // security audit LO-2: what the market pays now (the probe's whole output: 1 unit to the main wallet, the rest to the order
        // wallet); a limit buy / take-profit whose floor is far under it would fill at once at that floor
        const ownAfter = sim.accounts[1] ? (a.side === 'buy' ? tokenOf({ owner: '', lamports: 0, data: sim.accounts[1].data }) : BigInt(sim.accounts[1].lamports)) : beforeOwn;
        const out = (after - before) + (ownAfter > beforeOwn ? ownAfter - beforeOwn : 0n);
        const floor = mins[now];
        if (a.kind !== 'sl' && out * 4n > floor * 5n) {
          const gap = Number(((out - floor) * 100n) / out);
          throw await back(`Your price is far from the market: the order would fill right away with a floor ${gap}% under what the market pays now — use a market trade, or set a price near the market`);
        }
        ev('sign', 'done', { orderId, checks });
      } catch (e) { if ((e as Error)?.name !== 'LimitRefused') fail(e); throw e; }
      // ── to the keeper ──
      ev('post', 'active', { orderId });
      const res = await postOrder(w, posted(rec));
      rec.stage = 'open'; rec.stored = res.ok; put(rec);
      if (!res.ok && res.status >= 400 && res.status < 500) throw await back(`motion's server refused the order: ${res.error || res.status}`);
      ev('post', res.ok ? 'done' : 'failed', { orderId, ...(res.ok ? {} : { note: 'Not stored yet — the next order list sends it again' }) });
      const st = await chainOf(rec).catch(() => null);
      return { ok: true, order: view(rec, 'open', st) };
    }));
  }

  const stateOf = async (rec: SolLocalOrder, st: Awaited<ReturnType<typeof chainOf>> | null) => {
    if (rec.closed) return rec.closed;
    if (rec.recovered) return st && isEmpty(st) ? 'cancelled' : 'recovered';
    if (rec.stage !== 'open') return 'placing';
    if (st && st.nonce === 'used') return outcomeOf(rec);
    if (st && st.nonce === 'gone') return 'cancelled';
    if (d.now() > rec.expiry) return 'expired';
    return 'open';
  };

  // ── limit.cancel (a dialog while it can fill) and limit.sweep (no dialog: only what can no longer fill) ──
  async function close(o: unknown, mode: 'cancel' | 'sweep', auto = false) {
    laneOk();
    const a = mode === 'cancel' ? solLimitArgs.cancel(o) : solLimitArgs.sweep(o);
    const w = d.wallet(a.walletId);
    const run = (sending: () => void) => d.lock('sol-limit:' + w.address, async () => {
      const ev = (step: string, state: string, x: Record<string, unknown> = {}) => d.emit({ key: a.idempotencyKey || '', walletId: w.id, orderId: a.orderId, step, state, ...(auto ? { auto: true } : {}), ...x });
      const rec = get(a.orderId);
      if (!rec) throw named('LimitRefused', 'This vault has no record of that order — list your orders first');
      if (rec.recovered && !rec.token && 'token' in a && a.token) {
        // security audit LO-5: the coin the user named (never where anything goes: always back to this main wallet)
        const [m] = await d.accounts([a.token]);
        if (m && (m.owner === SP.token || m.owner === SP.token22) && m.data.length >= 45) { rec.token = a.token; rec.tokenProgram = m.owner; rec.decimals = m.data[44]; put(rec); }
      }
      if (rec.wallet !== w.address) throw named('LimitRefused', 'This order belongs to another wallet');
      const signer = d.orderSigner(w.id, rec.id);
      if (signer.address !== rec.orderWallet) throw named('LimitRefused', 'The order wallet does not match this order');
      const st = await chainOf(rec);
      const live = (rec.stage === 'open' && st.nonce === 'live' && !rec.closed) || (!!rec.recovered && st.nonce === 'live');
      const expired = d.now() > rec.expiry;
      if (isEmpty(st)) { if (!rec.closed) rec.closed = st.nonce === 'gone' && rec.stage === 'open' ? await outcomeOf(rec) : 'cancelled'; rec.emptyAt = d.now(); put(rec); return { ok: true, orderId: rec.id, state: rec.closed, invalidated: true, returned: { sol: '0', token: '0' }, sigs: [] as string[] }; }
      if (mode === 'sweep' && live && !expired) throw named('LimitRefused', 'This order can still fill — cancel it instead (limit.cancel asks first)');
      if (mode === 'cancel' && live) {
        const { esc, sub, muted, addrRow } = d.html;
        const kv = (k: string, v: string) => `<div class="dk-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
        const ok = await d.ask({
          // no typed code (owner 2026-10-26: "an ugly captcha"): a cancel only returns the order wallet's funds to the user's own wallet
          title: 'Cancel order', ok: 'Cancel order',
          html: `${sub(rec.recovered ? `An order this device did not place. Everything in its order wallet goes back to ${esc(w.name)}.` : `${esc(rec.side === 'buy' ? `Buy ${rec.symbol} with ${rec.amount} SOL` : `Sell ${rec.amount} ${rec.symbol}`)} at ${esc(rec.price)} SOL. Everything in its order wallet goes back to ${esc(w.name)}.`)}<div class="dk-list">${[
            kv('Returns', esc(`${sol(st.lamports + st.nonceLamports)} SOL${st.token > 0n ? ` + ${fromUnits(st.token, rec.decimals)} ${rec.symbol}` : ''}`)), addrRow('Order wallet', rec.orderWallet), addrRow(w.name, w.address),
          ].join('')}</div>${muted('The return closes the order\'s nonce, so its signed swap can never go through afterwards. If the price was reached a moment ago, the swap may land first: then the order is filled and only what is left comes back.')}`,
        });
        if (!ok) throw named('Cancelled', 'Cancelled');
      }
      sending();
      ev(mode, 'active');
      const was = st.nonce;
      const r = await returnAll(w, rec, signer);
      rec.closed = rec.recovered ? 'cancelled' : rec.stage !== 'open' ? 'failed' : was === 'used' ? await outcomeOf(rec) : expired ? 'expired' : 'cancelled';
      if (!rec.recovered && (rec.closed === 'cancelled' || rec.closed === 'expired')) { const o2 = await outcomeOf(rec); if (o2 !== 'cancelled') rec.closed = o2; }   // the swap landed first
      rec.sweptAt = d.now(); if (isEmpty(r.st)) rec.emptyAt = d.now(); put(rec);
      if (mode === 'cancel' && (live || rec.recovered)) await deleteOrder(w, rec.id);
      ev(mode, 'done', { state: rec.closed });
      return { ok: true, orderId: rec.id, state: rec.closed, invalidated: r.invalidated, returned: { sol: sol(st.lamports + st.nonceLamports), token: fromUnits(st.token, rec.decimals) }, sigs: r.sig ? [r.sig] : [] };
    });
    if (mode === 'cancel') return d.once({ idempotencyKey: a.idempotencyKey }, ['sol.limit.cancel', w.id, a.orderId], run);
    return a.idempotencyKey ? d.once({ idempotencyKey: a.idempotencyKey }, ['sol.limit.sweep', w.id, a.orderId], run) : run(() => {});
  }
  const autoRunning = new Set<string>();
  const autoSweep = (rec: SolLocalOrder) => {
    if (autoRunning.has(rec.id)) return; autoRunning.add(rec.id);
    void close({ walletId: rec.walletId, orderId: rec.id }, 'sweep', true).catch((e) => d.emit({ key: '', walletId: rec.walletId, orderId: rec.id, step: 'sweep', state: 'failed', auto: true, error: String((e as Error)?.message || e).slice(0, 160) })).finally(() => autoRunning.delete(rec.id));
  };

  // ── recovery (as the EVM orders, review H1): the order ids come from the main seed and an index, so a wiped browser finds
  //    every order wallet again — a used order wallet or nonce with no record here is adopted (fields from our server when it
  //    knows the order: hints only, never trusted for liveness: a recovered order is cancelled with a dialog, never swept) ──
  async function serverOrders(w: Wallet): Promise<Record<string, Record<string, unknown>>> {
    try {
      const t = readToken(w);
      const r = await d.fetch(api(), { method: 'GET', headers: { 'x-limit-wallet': t.wallet, 'x-limit-at': String(t.at), 'x-limit-sig': t.sig }, credentials: 'omit', signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => null) as { orders?: Record<string, unknown>[] } | null;
      return Object.fromEntries((Array.isArray(j?.orders) ? j!.orders : []).filter((x) => typeof x?.id === 'string').map((x) => [String(x.id), x]));
    } catch { return {}; }
  }
  async function scan(w: Wallet) {
    let found = 0, miss = 0; let server: Record<string, Record<string, unknown>> | null = null;
    for (let i = 0; miss < 5 && i < 300; i += 1) {
      const id = d.orderIdAt(w.id, i);
      if (get(id)) { miss = 0; continue; }
      const signer = d.orderSigner(w.id, id);
      const [acc, n] = await d.accounts([signer.address, nonceAddressOf(signer.address)]);
      if (acc === undefined || n === undefined) break;
      if (!acc && !n) { miss += 1; continue; }
      miss = 0; server ??= await serverOrders(w);
      const sv = server[id] || {};
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      const token = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str(sv.token)) ? str(sv.token) : '';
      let tokenProgram = '';
      if (token) { const [m] = await d.accounts([token]); tokenProgram = m && (m.owner === SP.token || m.owner === SP.token22) ? m.owner : ''; }
      put({ v: 1, id, index: i, walletId: w.id, wallet: w.address, orderWallet: signer.address, nonce: nonceAddressOf(signer.address), nonceValue: '', token: tokenProgram ? token : '', tokenProgram,
        symbol: str(sv.symbol).slice(0, 24) || '?', decimals: Number.isInteger(sv.decimals) ? sv.decimals as number : 6, side: sv.side === 'sell' ? 'sell' : 'buy', kind: sv.kind === 'tp' || sv.kind === 'sl' ? sv.kind : 'limit',
        price: str(sv.price), amount: str(sv.amount), amountIn: str(sv.amountIn), minOut: {}, slippageBps: Number(sv.slippageBps) || 0, expiry: Number(sv.expiry) || 0, createdAt: Number(sv.createdAt) || d.now(),
        venues: [], txs: [], fund: [], setup: [], reserve: '0', stage: 'open', stored: !!server[id], recovered: true } as SolLocalOrder);
      found += 1;
    }
    return found;
  }

  // ── limit.list: this browser's orders with the chain's word; an order that filled, expired or was swept elsewhere and still
  //    holds anything returns it by itself (the floor already reached the main wallet; this is what came above it) ──
  async function list(o: unknown) {
    laneOk();
    const a = solLimitArgs.list(o);
    const ws = a.walletId ? [d.wallet(a.walletId)] : d.wallets();
    const found = a.walletId ? await scan(ws[0]).catch(() => 0) : 0;
    const mine = Object.values(readAll()).filter((r) => ws.some((w) => w.address === r.wallet)).sort((x, y) => y.createdAt - x.createdAt);
    const show = [...mine.filter((r) => !r.emptyAt), ...mine.filter((r) => r.emptyAt && d.now() - r.emptyAt < 3 * 86400_000).slice(0, 40)];
    const orders = await Promise.all(show.map(async (rec) => {
      const st = await chainOf(rec).catch(() => null);
      const state = await stateOf(rec, st);
      const set = (change: Partial<SolLocalOrder>) => { Object.assign(rec, change); patch(rec.id, change); };
      if (['filled', 'reverted', 'cancelled'].includes(state) && !rec.closed) set({ closed: state as SolLocalOrder['closed'] });
      if (st && isEmpty(st) && !rec.emptyAt && state !== 'open' && state !== 'placing' && !(rec.recovered && !rec.token)) set({ emptyAt: d.now() });
      if (state === 'open' && !rec.stored && rec.txs.length) { const w = ws.find((x) => x.address === rec.wallet); if (w) { const r2 = await postOrder(w, posted(rec)).catch(() => null); if (r2?.ok) set({ stored: true }); } }
      const auto = st && !isEmpty(st) && ['filled', 'reverted', 'expired'].includes(state);
      if (auto) autoSweep(rec);
      return { ...view(rec, state, st), ...(auto ? { autoSweep: true } : {}) };
    }));
    // security audit LO-8: the 24 h read token stays inside the vault (serverOrders uses it); the page polls the keeper by ids
    return { ok: true, chain: 'sol', native: 'SOL', orders, recovered: found };
  }

  return { place, list, cancel: (o: unknown) => close(o, 'cancel'), sweep: (o: unknown) => close(o, 'sweep') };
}
