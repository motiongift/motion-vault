// Limit orders v1 inside the vault (2026-10-22, owner's variant 1; docs/drafts/LIMIT-ORDERS.md): limit.place / cancel /
// list / sweep. src/webEngine.ts wires the dependencies in (the main key never reaches this file: it gets the order ids,
// a signer for each order wallet and a signer of the three fixed auth texts); scripts/limit-orders*.test.mjs run it
// against a mocked chain and the real keeper module.
//
// Rules (the same as every vault money path):
// · one plain object per method, exact shape (src/limitCore.ts limitArgs); once() per idempotency key; one limit lane per
//   main wallet across this browser's tabs (Web Lock) with the "a key already used elsewhere" re-check inside it;
// · main-wallet sends go through the engine's own send lane (its nonce counter); the order wallet's nonces are read fresh;
// · a vault dialog (trusted click) before an order is funded and before an order that may still fill is emptied; a sweep
//   of an order this vault KNOWS can no longer fill returns everything to the same main wallet and asks nothing;
// · order ids are derived from the main key and an index (review H1): a wiped browser finds every order wallet again
//   (recovery scan in limit.list); a local record is never dropped while its order wallet holds anything;
// · the order wallet's key is derived from the main key per order and lives only inside the signer the engine hands
//   over: never stored, exported, logged, posted, or put in an answer or an event;
// · the server gets signed bytes and one signed auth text per request (/api/limit on our own server only; reads carry
//   the read token in headers, never in the URL).
import { keccak256, parseAbi } from 'viem';
import {
  LIMIT_CHAIN, MAX_OPEN, MAX_FILLERS, MAX_GAS_LIMIT, V4_EXEC_GAS, CURVE_EXEC_GAS, BRIDGE_EXEC_GAS, ERC20_ABI, SCAN_GAP, DELTA_PROBE_CODE, FOUR_SELL_REFUSED, POOL_MANAGER, EXTSLOAD_ABI,
  limitArgs, limitChain, variantsFor, LIMIT_HOOKS, variantTax, variantTaxCap, minOutOf, notionalWei, toUnits, fromUnits, signedGasPriceFor, gasLimitOf, gasReserve, swapCall, sellApprovals, transferData, orderDigest, authText, deltaProbeData,
  bridgeOf, v4Slot0Slot, lpFeeOfSlot0,
  type Variant, type SignedTx, type PostedOrder, type PostedBridge, type Venue, type LimitChainKey, type LimitChainProfile, type LimitRoute,
} from './limitCore.ts';

type Hex = `0x${string}`;
type Wallet = { id: string; name: string; address: Hex };
type Ask = { title: string; html: string; ok: string; danger?: boolean };
export type LimitTx = { to: Hex; data?: Hex; value?: bigint; nonce: number; gas: bigint; gasPrice: bigint };
export type OrderSigner = { address: Hex; sign(tx: LimitTx): Promise<Hex> };
export type LimitPc = {
  getBlock(): Promise<{ baseFeePerGas?: bigint | null }>;
  getGasPrice(): Promise<bigint>;
  getBalance(a: { address: Hex }): Promise<bigint>;
  getTransactionCount(a: { address: Hex; blockTag: 'pending' | 'latest' }): Promise<number>;
  estimateGas(a: { account: Hex; to: Hex; data?: Hex; value?: bigint }): Promise<bigint>;
  call(a: { account: Hex; to: Hex; data?: Hex; value?: bigint }): Promise<unknown>;
  /** eth_call to `to` with `code` put at `to` as a state override (nothing deployed); resolves with the return data */
  callOverride?(a: { to: Hex; data: Hex; code: Hex }): Promise<Hex>;
  readContract(a: Record<string, unknown>): Promise<unknown>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: string } | null>;
};
export interface LimitDeps {
  /** true on a limit chain's EVM frame (Robinhood Chain, BNB Chain) */
  lane(): boolean;
  /** which limit chain this frame trades (default robinhood): its order wallets, store, gas and venues */
  chain?(): LimitChainKey;
  /** one of this vault's own EVM-key wallets (no Privy / hop / chain-only wallet) */
  wallet(id: string): Wallet;
  wallets(): Wallet[];
  /** the order id at `index` of this main wallet (limitCore orderIdOf over the main key) */
  orderIdAt(id: string, index: number): Promise<string>;
  /** the order wallet of (main wallet, orderId): limitCore orderKey over the main key, inside a signer of legacy Robinhood txs */
  orderSigner(id: string, orderId: string): Promise<OrderSigner>;
  /** personal_sign by the main wallet of one of the three auth texts (the vault parses the text first) */
  signAuth(id: string, text: string): Promise<Hex>;
  /** a send from the main wallet through the engine's own lane (its nonce counter, its broadcast) */
  sendTx(id: string, tx: { to: Hex; data?: Hex; value?: bigint }, gas?: bigint): Promise<Hex>;
  /** the engine's broadcast of signed bytes to every node (resolves with the hash; "already known" = success) */
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex, timeoutMs?: number): Promise<{ status: string }>;
  /** the engine's own on-chain check of the page's route proposal (registry, curve, pool, hooks) */
  verifyRoute(token: Hex, route: unknown): Promise<void>;
  /** the Pons registry's creator tax of this token (getLaunchedToken word 7), read on chain by the vault (Robinhood only) */
  ponsCreatorTax(token: Hex): Promise<number>;
  /** the gas price of a send now (the engine's fee floor) */
  gasPrice(): Promise<bigint>;
  pc: LimitPc;
  tokenMeta(token: Hex): Promise<{ symbol: string; decimals: number }>;
  ask(o: Ask): Promise<boolean>;
  html: { esc(v: unknown): string; sub(h: string): string; muted(h: string): string; addrRow(name: string, address: string): string };
  once<T extends Record<string, unknown>>(opts: { idempotencyKey?: string }, what: unknown[], run: (sending: () => void) => Promise<T>): Promise<T>;
  idemSeen?(key: string): boolean;
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  emit(detail: Record<string, unknown>): void;
  fetch: typeof fetch;
  /** our own server's origin (the terminal that framed the vault) — /api/limit lives there */
  api(): string;
  store: { get(k: string): string | null; set(k: string, v: string): void };
  now(): number;
}

/** what this browser's vault keeps about an order (no key; the signed bytes are the same ones the server holds).
 *  recovered: found by a recovery scan, its fields (if any) from the server — hints only, never trusted for liveness.
 *  emptyAt: when its order wallet was last seen empty after it closed — only then may the record be dropped. */
export type LocalOrder = {
  v: 1; id: string; index?: number; walletId: string; wallet: Hex; orderWallet: Hex; token: Hex | ''; symbol: string; decimals: number;
  side: 'buy' | 'sell'; kind: 'limit' | 'tp' | 'sl'; price: string; amount: string; amountIn: string; minOut: Record<string, string>;
  slippageBps: number; expiry: number; createdAt: number; venues: Venue[]; swapNonce: number | null; txs: SignedTx[];
  fund: string[]; approve: string[]; swap: Record<string, string>; reserve: string; gasPrice: string;
  stage: 'funding' | 'signing' | 'open'; stored: boolean; closed?: 'filled' | 'reverted' | 'cancelled' | 'expired' | 'failed'; sweptAt?: number; error?: string;
  recovered?: boolean; emptyAt?: number;
  /** §19: a bridged order's quote, path and pool (posted with it, under the digest) */
  bridge?: PostedBridge;
};
export const limitStore = (chain: string) => 'trenches.limit.v1.' + chain;
export const LIMIT_STORE = limitStore(LIMIT_CHAIN);
const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
const lc = (a: unknown) => String(a ?? '').toLowerCase();
const same = (a: unknown, b: unknown) => !!a && lc(a) === lc(b);
const amt = (wei: bigint) => { const s = fromUnits(wei, 18); const [i, f = ''] = s.split('.'); return f ? `${i}.${f.slice(0, 6).replace(/0+$/, '') || '0'}` : i; };
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const NONCE_TAKEN = /nonce too low|nonce has already been used|replacement transaction underpriced|known nonce|invalid nonce/i;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
// ── security audit LO-9: the L1 share of a Robinhood tx (Arbitrum Orbit) is computed at inclusion and moves with L1 over the
//    order's 7 days; the estimate × 1.4 alone can fall short ("intrinsic gas too low": the order would silently never fill) ──
export const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8' as Hex;
export const NODE_INTERFACE_ABI = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) view returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
export const L1_HEADROOM = 4n;              // the L1 part gets 4× more on top of the estimate × 1.4 (≈ 5.4× in all)
export const L1_FALLBACK_GAS = 50_000n;     // when the node cannot say what the L1 part is
/** the gas limit a pre-signed tx carries: the estimate × 1.4 (gasLimitOf) plus L1_HEADROOM × its L1 part (null = unknown:
 *  L1_FALLBACK_GAS; 0 on BNB Chain), never above MAX_GAS_LIMIT (the keeper's and the vault's ceiling) */
export function l1Headroom(limit: bigint, l1: bigint | null): bigint {
  const extra = l1 == null ? L1_FALLBACK_GAS : l1 > 0n ? l1 * L1_HEADROOM : 0n;
  const g = limit + extra;
  return g > MAX_GAS_LIMIT ? (limit > MAX_GAS_LIMIT ? limit : MAX_GAS_LIMIT) : g;
}

export function createLimit(d: LimitDeps) {
  const pc = d.pc;
  // the chain of this frame, read per call (one engine, one lane at a time); Robinhood keeps its v1 store key
  const P = (): LimitChainProfile => limitChain(d.chain ? d.chain() : LIMIT_CHAIN);
  const STORE = () => limitStore(P().key); const SCAN_STORE = () => STORE() + '.scan';
  const eth = (wei: bigint) => amt(wei);
  const unit = () => P().native;
  // a native send of the order wallet (the way back, a nonce filler): on BNB Chain (no L1 component in gas) exactly the node's
  // estimate, so the sweep leaves nothing behind; on Robinhood the L1 share moves with L1 between estimate and send: the buffer stays
  const plainGas = (estimate: bigint) => (P().key === 'bsc' ? estimate : gasLimitOf(estimate));
  // security audit LO-9: the L1 gas a call's calldata costs on Robinhood (Arbitrum NodeInterface, eth_call only), × L1_HEADROOM;
  // BNB Chain has no L1 share; a failed read adds L1_FALLBACK_GAS instead (never blocks a placement)
  const l1Extra = async (call: { to: Hex; data?: Hex }): Promise<bigint | null> => {
    if (P().key !== 'robinhood') return 0n;
    try { const r = await pc.readContract({ address: NODE_INTERFACE, abi: NODE_INTERFACE_ABI, functionName: 'gasEstimateL1Component', args: [call.to, false, call.data || '0x'] }) as readonly [bigint, bigint, bigint]; return BigInt(r[0]); }
    catch { return null; }
  };
  const laneOk = () => { if (!d.lane()) throw named('LimitRefused', 'Limit orders run on Robinhood Chain and BNB Chain — open one of those lanes'); };
  // ── this browser's order records ──
  const readAll = (): Record<string, LocalOrder> => { try { const o = JSON.parse(d.store.get(STORE()) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
  const put = (rec: LocalOrder) => {
    const all = readAll(); all[rec.id] = rec;
    // 200 records at most — but only records whose order wallet was SEEN EMPTY after they closed may go (review H1)
    const ids = Object.keys(all);
    if (ids.length > 200) for (const id of ids.filter((x) => all[x].closed && all[x].emptyAt).sort((a, b) => all[a].createdAt - all[b].createdAt).slice(0, ids.length - 200)) delete all[id];
    d.store.set(STORE(), JSON.stringify(all));
  };
  const get = (id: string): LocalOrder | null => readAll()[id] || null;
  // a change to the record as it is NOW in the store (a list running beside a cancel must not write back an older copy)
  const patch = (id: string, change: Partial<LocalOrder>) => { const cur = get(id); if (cur) put({ ...cur, ...change }); };
  const liveCount = (wallet: string) => Object.values(readAll()).filter((r) => same(r.wallet, wallet) && !r.closed && !r.recovered && r.expiry > d.now()).length;
  const scanRead = (): Record<string, { full?: boolean; at?: number }> => { try { const o = JSON.parse(d.store.get(SCAN_STORE()) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const scanMark = (wallet: string) => { const s = scanRead(); s[lc(wallet)] = { full: true, at: d.now() }; d.store.set(SCAN_STORE(), JSON.stringify(s)); };

  const balanceOf = async (token: Hex, who: Hex) => BigInt(await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] }) as bigint);
  const receiptOf = (hash: string) => pc.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  // a signed send of the order wallet: the engine's broadcast; a nonce another tx took first (the keeper's swap landing
  // while we cancel) is not an error here — null, and the caller re-reads the chain
  const sendRaw = async (raw: Hex): Promise<Hex | null> => {
    try { return await d.broadcast(raw); }
    catch (e) {
      if (NONCE_TAKEN.test(String((e as Error)?.message))) { const h = keccak256(raw); return (await receiptOf(h)) ? h : null; }
      throw e;
    }
  };
  const landed = async (hash: Hex, what: string) => {
    let r: { status: string };
    try { r = await d.receipt(hash, 90_000); } catch { throw named('LimitUnknown', `Status unknown — ${what} was sent but not confirmed in time; check the order wallet before trying again`, { unknown: true, hash }); }
    if (r.status !== 'success') throw named('LimitRefused', `${what} reverted`, { hash });
  };

  // ── the way back: every token and the native left, from the order wallet to its main wallet, and the swap's nonce burnt ──
  async function returnAll(w: Wallet, signer: OrderSigner, token: Hex | null, swapNonce: number | null, ev: (step: string, state: string, x?: Record<string, unknown>) => void) {
    const ow = signer.address, main = w.address;
    const out: { hashes: string[]; eth: bigint; token: bigint; tokenError?: string } = { hashes: [], eth: 0n, token: 0n };
    const fee = await d.gasPrice();
    let n = await pc.getTransactionCount({ address: ow, blockTag: 'pending' });
    if (token) {
      const bal = await balanceOf(token, ow).catch(() => 0n);
      if (bal > 0n) {
        const data = transferData(main, bal);
        // a token that refuses the way back (a blocklist, a paused token) must not keep the native and the nonce hostage
        const gas = await pc.estimateGas({ account: ow, to: token, data }).then(gasLimitOf, (e: Error) => { out.tokenError = `The token refused the transfer back (${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 80)}) — it stays in the order wallet`; return null; });
        if (gas) {
          const h = await sendRaw(await signer.sign({ to: token, data, value: 0n, nonce: n, gas, gasPrice: fee }));
          if (h) { await landed(h, 'Returning the tokens'); out.hashes.push(h); out.token = bal; }
          n = await pc.getTransactionCount({ address: ow, blockTag: 'pending' });
        }
      }
    }
    // zero-value sends to itself until the swap's nonce is behind (only when approvals never landed: rare)
    for (let i = 0; swapNonce != null && n < swapNonce && i < MAX_FILLERS; i += 1) {
      const gas = plainGas(await pc.estimateGas({ account: ow, to: ow, value: 0n }));
      if ((await pc.getBalance({ address: ow })) < gas * fee) break;
      const h = await sendRaw(await signer.sign({ to: ow, value: 0n, nonce: n, gas, gasPrice: fee }));
      if (h) { await landed(h, 'Closing the order'); out.hashes.push(h); }
      n = await pc.getTransactionCount({ address: ow, blockTag: 'pending' });
    }
    // the native last: everything but its own fee
    const bal = await pc.getBalance({ address: ow });
    if (bal > 0n) {
      const gas = plainGas(await pc.estimateGas({ account: ow, to: main, value: 1n }));
      if (bal > gas * fee) {
        const value = bal - gas * fee;
        const h = await sendRaw(await signer.sign({ to: main, value, nonce: n, gas, gasPrice: fee }));
        if (h) { await landed(h, `Returning the ${unit()}`); out.hashes.push(h); out.eth = value; }
        else {
          // the nonce went to the swap meanwhile: the order filled; what is left now goes back once more
          const left = await pc.getBalance({ address: ow }); const n2 = await pc.getTransactionCount({ address: ow, blockTag: 'pending' });
          if (left > gas * fee) { const h2 = await sendRaw(await signer.sign({ to: main, value: left - gas * fee, nonce: n2, gas, gasPrice: fee })); if (h2) { await landed(h2, `Returning the ${unit()}`); out.hashes.push(h2); out.eth = left - gas * fee; } }
        }
      }
    }
    const after = await pc.getTransactionCount({ address: ow, blockTag: 'latest' });
    const left = await chainOf(ow, token).catch(() => null);
    ev('sweep', 'done', { hashes: out.hashes });
    return { ...out, invalidated: swapNonce == null ? null : after > swapNonce, empty: !!left && left.eth <= P().dust && left.token === 0n };
  }
  // what the chain says about an order wallet
  async function chainOf(ow: Hex, token: Hex | '' | null) {
    const [nonce, ethBal, tok] = await Promise.all([pc.getTransactionCount({ address: ow, blockTag: 'latest' }), pc.getBalance({ address: ow }), token ? balanceOf(token as Hex, ow).catch(() => 0n) : Promise.resolve(0n)]);
    return { nonce, eth: ethBal, token: tok };
  }
  // filled / reverted / cancelled once the swap's nonce is used: whichever of our swap hashes landed decides
  async function outcomeOf(rec: LocalOrder): Promise<'filled' | 'reverted' | 'cancelled'> {
    for (const h of Object.values(rec.swap || {})) { const r = await receiptOf(h); if (r) return r.status === 'success' ? 'filled' : 'reverted'; }
    return 'cancelled';
  }
  // trusted = placed by this vault (its record holds the signed bytes); a recovered record's fields are hints
  const trusted = (rec: LocalOrder | null): rec is LocalOrder => !!rec && !rec.recovered;
  const stateOf = async (rec: LocalOrder, st: { nonce: number } | null) => {
    if (rec.closed) return rec.closed;
    if (rec.recovered) return 'recovered';
    if (rec.stage !== 'open' || rec.swapNonce == null) return 'placing';
    if (st && st.nonce > rec.swapNonce) return outcomeOf(rec);
    if (d.now() > rec.expiry) return 'expired';
    return 'open';
  };
  const isEmpty = (st: { eth: bigint; token: bigint }) => st.eth <= P().dust && st.token === 0n;
  const view = (rec: LocalOrder, state: string, st: { nonce: number; eth: bigint; token: bigint } | null) => ({
    orderId: rec.id, index: rec.index ?? null, walletId: rec.walletId, wallet: rec.wallet, orderWallet: rec.orderWallet, chain: P().key, native: unit(), token: rec.token || null, symbol: rec.symbol, decimals: rec.decimals,
    side: rec.side, kind: rec.kind, price: rec.price, amount: rec.amount, amountIn: rec.amountIn, minOut: { ...rec.minOut }, slippageBps: rec.slippageBps,
    expiry: rec.expiry, createdAt: rec.createdAt, venues: [...rec.venues], swapNonce: rec.swapNonce, stored: rec.stored, state, recovered: !!rec.recovered,
    txs: { fund: [...rec.fund], approve: [...rec.approve], swap: { ...rec.swap } }, reserve: rec.reserve,
    ...(st ? { balance: { eth: eth(st.eth), token: fromUnits(st.token, rec.decimals), nonce: st.nonce } } : {}),
    // a sweep with no dialog: only what this vault knows can no longer fill (a recovered order is cancelled instead: it asks)
    sweepable: !!st && !isEmpty(st) && state !== 'open' && state !== 'recovered',
    cancelable: !!st && (state === 'open' || (state === 'recovered' && !isEmpty(st))),
    ...(rec.error ? { error: rec.error } : {}),
  });

  // ── our server: POST / DELETE /api/limit, each with one auth text signed by the main wallet; reads with the read token in headers ──
  // security audit LO-3: each lane's keeper under its own path (nginx serves the Robinhood lane at the root, BNB's under /bsc)
  const api = () => d.api().replace(/\/+$/, '') + (P().key === 'bsc' ? '/bsc' : '') + '/api/limit';
  async function postOrder(w: Wallet, order: PostedOrder): Promise<{ ok: boolean; status: number; error?: string }> {
    const at = d.now();
    const text = authText({ action: 'place', chain: P().key, wallet: w.address, id: order.id, orderWallet: order.orderWallet, digest: orderDigest(order), at });
    const sig = await d.signAuth(w.id, text);
    try {
      const r = await d.fetch(api(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order, auth: { at, sig } }), credentials: 'omit', signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      return { ok: r.ok && !!j?.ok, status: r.status, error: j?.error ? String(j.error).slice(0, 160) : undefined };
    } catch (e) { return { ok: false, status: 0, error: String((e as Error)?.message || e).slice(0, 120) }; }
  }
  async function deleteOrder(w: Wallet, id: string) {
    const at = d.now();
    const sig = await d.signAuth(w.id, authText({ action: 'cancel', chain: P().key, wallet: w.address, id, at }));
    try { const r = await d.fetch(api(), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, wallet: lc(w.address), auth: { at, sig } }), credentials: 'omit', signal: AbortSignal.timeout(10_000) }); return r.ok; } catch { return false; }
  }
  const posted = (rec: LocalOrder): PostedOrder => ({ v: 1, id: rec.id, chain: P().key, wallet: lc(rec.wallet) as Hex, orderWallet: lc(rec.orderWallet) as Hex, token: rec.token as Hex, symbol: rec.symbol, decimals: rec.decimals,
    side: rec.side, kind: rec.kind, price: rec.price, amount: rec.amount, amountIn: rec.amountIn, minOut: { ...rec.minOut }, slippageBps: rec.slippageBps, expiry: rec.expiry, createdAt: rec.createdAt, txs: rec.txs.map((t) => ({ ...t })),
    ...(rec.bridge ? { bridge: rec.bridge } : {}) });
  // read tokens for GET /api/limit (x-limit-wallet / x-limit-at / x-limit-sig): one per wallet per 12 h
  const reads = new Map<string, { at: number; sig: Hex }>();
  async function readToken(w: Wallet) {
    const hit = reads.get(lc(w.address)); if (hit && d.now() - hit.at < 12 * 3600_000) return { wallet: lc(w.address), ...hit };
    const at = d.now(); const sig = await d.signAuth(w.id, authText({ action: 'read', chain: P().key, wallet: w.address, at }));
    reads.set(lc(w.address), { at, sig }); return { wallet: lc(w.address), at, sig };
  }
  async function serverOrders(w: Wallet): Promise<Record<string, Record<string, unknown>>> {
    try {
      const t = await readToken(w);
      const r = await d.fetch(api(), { method: 'GET', headers: { 'x-limit-wallet': t.wallet, 'x-limit-at': String(t.at), 'x-limit-sig': t.sig }, credentials: 'omit', signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => null) as { orders?: Record<string, unknown>[] } | null;
      return Object.fromEntries((Array.isArray(j?.orders) ? j!.orders : []).filter((o) => typeof o?.id === 'string').map((o) => [String(o.id), o]));
    } catch { return {}; }
  }

  // ── order ids (review H1): index 0, 1, 2 … of HMAC(main key, …); a used order wallet (nonce or balance) is never reused ──
  const indexOfWallet = (w: Wallet) => Math.max(-1, ...Object.values(readAll()).filter((r) => same(r.wallet, w.address) && r.index != null).map((r) => r.index as number));
  const usedOnChain = async (ow: Hex) => { const [n, b] = await Promise.all([pc.getTransactionCount({ address: ow, blockTag: 'pending' }), pc.getBalance({ address: ow })]); return n > 0 || b > 0n; };
  // a found order wallet this browser has no record of: a stub (fields from the server when it has them — hints)
  const adopt = (w: Wallet, id: string, index: number, ow: Hex, s?: Record<string, unknown>) => {
    const str = (v: unknown, dflt = '') => (typeof v === 'string' ? v : dflt);
    const tok = str(s?.token); const sn = Number(s?.swapNonce);
    const rec: LocalOrder = {
      v: 1, id, index, walletId: w.id, wallet: lc(w.address) as Hex, orderWallet: lc(ow) as Hex, token: ADDR.test(tok) ? lc(tok) as Hex : '', symbol: str(s?.symbol, '?').slice(0, 24),
      decimals: Number.isInteger(s?.decimals) ? s!.decimals as number : 18, side: s?.side === 'sell' ? 'sell' : 'buy', kind: s?.kind === 'tp' || s?.kind === 'sl' ? s.kind : 'limit',
      price: str(s?.price), amount: str(s?.amount), amountIn: str(s?.amountIn), minOut: {}, slippageBps: Number(s?.slippageBps) || 0, expiry: Number(s?.expiry) || 0, createdAt: Number(s?.createdAt) || d.now(),
      venues: [], swapNonce: Number.isInteger(sn) && sn >= 0 && sn <= 32 ? sn : null, txs: [], fund: [], approve: [], swap: {}, reserve: '0', gasPrice: '0', stage: 'open', stored: !!s, recovered: true,
    };
    put(rec); return rec;
  };
  async function scan(w: Wallet) {
    const full = scanRead()[lc(w.address)]?.full;
    let i = full ? indexOfWallet(w) + 1 : 0; let miss = 0; const stop = i + 500; let server: Record<string, Record<string, unknown>> | null = null; let found = 0;
    while (miss < SCAN_GAP && i < stop) {
      const id = await d.orderIdAt(w.id, i);
      if (get(id)) { miss = 0; i += 1; continue; }
      const ow = lc((await d.orderSigner(w.id, id)).address) as Hex;
      if (await usedOnChain(ow)) { server ??= await serverOrders(w); adopt(w, id, i, ow, server[id]); found += 1; miss = 0; }
      else miss += 1;
      i += 1;
    }
    scanMark(w.address);
    return found;
  }
  // the next order: the first index after this browser's last whose order wallet is unused on chain (a used one is adopted)
  async function nextOrder(w: Wallet) {
    for (let i = indexOfWallet(w) + 1, n = 0; n < 200; i += 1, n += 1) {
      const id = await d.orderIdAt(w.id, i);
      if (get(id)) continue;
      const signer = await d.orderSigner(w.id, id);
      if (await usedOnChain(lc(signer.address) as Hex)) { adopt(w, id, i, lc(signer.address) as Hex); continue; }
      return { id, index: i, signer };
    }
    throw named('LimitRefused', 'No free order slot found — list your orders first');
  }
  // ── security audit LO-11: a pool only the page names. verifyRoute accepts any hookless V4 pool of the pair (and on BNB any
  //    quote token of a V2 bridge) — a pool anyone can create with dust liquidity, where a stop-loss's floor is all that
  //    protects the order. For those routes the vault asks motion's /limit-route itself (the same ranking the page used) and
  //    refuses when the server names ANOTHER market (another pool / quote, or a live curve). An unanswered read changes
  //    nothing (as before): a compromised page cannot make the vault's own request fail, and a server outage blocks no order. ──
  async function serverNamesThisPool(token: Hex, route: LimitRoute) {
    const ZERO = '0x0000000000000000000000000000000000000000';
    const hookless = route.type === 'v4' && lc(route.poolKey.hooks) === ZERO;
    const v2bridge = route.type === 'v2' && route.path.length > 2;
    if (!hookless && !v2bridge) return;
    type Answer = { ok?: boolean; curve?: boolean; route?: Record<string, unknown> };
    let j = null as Answer | null;
    try {
      const r = await d.fetch(d.api().replace(/\/+$/, '') + (P().key === 'bsc' ? '/bsc' : '') + `/api/token/${lc(token)}/limit-route`, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
      j = r.ok ? await r.json().catch(() => null) as Answer | null : null;
    } catch { return; }
    if (!j || j.ok !== true) return;
    const refuse = (): never => { throw named('LimitRefused', 'motion ranks another market for this coin — this pool is one only the page named (anyone can create such a pool). Refresh the page and try again'); };
    if (j.curve === true) refuse();
    const sv = j.route && typeof j.route === 'object' ? j.route : null;
    if (!sv) return;
    if (route.type === 'v4') {
      const k = sv.poolKey && typeof sv.poolKey === 'object' ? sv.poolKey as Record<string, unknown> : null;
      const pk = route.poolKey;
      if (sv.type !== 'v4' || !k || lc(k.currency0) !== lc(pk.currency0) || lc(k.currency1) !== lc(pk.currency1) || Number(k.fee) !== Number(pk.fee) || Number(k.tickSpacing) !== Number(pk.tickSpacing) || lc(k.hooks) !== lc(pk.hooks)) refuse();
    } else if (route.type === 'v2') {
      const path: string[] = Array.isArray(sv.path) ? (sv.path as unknown[]).map(lc) : [];
      if (sv.type !== 'v2' || path.length !== route.path.length || path.some((x, i) => x !== lc(route.path[i]))) refuse();
    }
  }
  // review M2: the swap must PAY the main wallet, not only not revert (DELTA_PROBE_CODE as a state override on the order wallet)
  async function paysMain(ow: Hex, call: { to: Hex; data: Hex; value: bigint }, token: Hex | null, main: Hex): Promise<{ check: 'paid' | 'unchecked'; out: bigint }> {
    await pc.call({ account: ow, to: call.to, data: call.data, value: call.value });   // a revert throws here, with its reason
    if (!pc.callOverride) return { check: 'unchecked', out: 0n };
    let ret: Hex;
    try { ret = await pc.callOverride({ to: ow, data: deltaProbeData(call.to, token, main, call.value, call.data), code: DELTA_PROBE_CODE }); }
    catch { return { check: 'unchecked', out: 0n }; }   // a node without state overrides (a user's own RPC): the plain call above is the check
    const delta = /^0x[0-9a-fA-F]{1,64}$/.test(ret || '') ? BigInt(ret) : 0n;
    if (!(delta > 0n) || delta >= 1n << 255n) throw new Error('the swap does not pay the main wallet');
    return { check: 'paid', out: delta };
  }

  // ── limit.place ──
  async function place(o: unknown) {
    laneOk();
    const C = P();
    const a = limitArgs.place(o, C.key);
    const w = d.wallet(a.walletId);
    return d.once({ idempotencyKey: a.idempotencyKey }, ['limit.place', w.id, a.token, a.side, a.kind, a.price, a.amount, a.slippageBps, a.expiresIn], (sending) => d.lock('limit:' + lc(w.address), async () => {
      if (d.idemSeen?.(a.idempotencyKey)) throw named('LimitUnknown', 'Status unknown — this order was started in another tab; check your orders before placing it again', { unknown: true });
      const key = a.idempotencyKey;
      const ev = (step: string, state: string, x: Record<string, unknown> = {}) => d.emit({ key, walletId: w.id, step, state, ...x });
      const main = lc(w.address) as Hex, token = a.token;
      if (liveCount(main) >= MAX_OPEN) throw named('LimitRefused', `This wallet already has ${MAX_OPEN} open orders — cancel one first`);
      ev('plan', 'active');
      // the page's route proposal, checked on chain by the engine (the launchpad's registry / the pool's hook), then the variants;
      // a curve's tax is the vault's own registry read (review L1), never the page's figure
      await d.verifyRoute(token, a.route);
      await serverNamesThisPool(token, a.route);
      // a bridged pool with a dynamic fee (§19): its current LP fee from the PoolManager's own storage counts into the floor
      // (a read that fails counts 0: the floor only rises — the order fills a little later, never under the limit)
      const dynFee = async () => {
        if (a.route.type !== 'v4' || !a.route.bridgeHops?.length || a.route.poolKey.fee !== 0x800000) return {};
        const w0 = await pc.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [v4Slot0Slot(a.route.poolKey)] }).catch(() => null);
        return { v4LpFee: lpFeeOfSlot0(w0) };
      };
      // a Robinhood-launcher V4 pool: the coin's creator tax from the registry counts into the floor (a failed read counts none)
      const launcher = a.route.type === 'v4' && lc(a.route.poolKey.hooks) === LIMIT_HOOKS[0];
      const variants: Variant[] = variantsFor(a.route, token, a.route.type === 'pons' ? { creatorTaxBps: await d.ponsCreatorTax(token) } : launcher ? { ...(await dynFee()), creatorTaxBps: await d.ponsCreatorTax(token).catch(() => undefined as unknown as number) } : await dynFee());
      if (a.side === 'sell' && variants.some((v) => v.venue === 'four')) throw named('LimitRefused', FOUR_SELL_REFUSED);
      const meta = await d.tokenMeta(token);
      const decimals = meta.decimals; const symbol = String(meta.symbol || '?').slice(0, 24);
      let amountIn = a.side === 'buy' ? toUnits(a.amount, 18) : toUnits(a.amount, decimals);
      const size = a.side === 'buy' ? amountIn : notionalWei(amountIn, a.price, decimals);
      if (size < C.minSize) throw named('LimitRefused', `The minimum order is ${eth(C.minSize)} ${C.native}${a.side === 'sell' ? ' at the limit price' : ''}`);
      const createdAt = d.now(); const expiry = createdAt + a.expiresIn * 1000; const deadline = BigInt(Math.floor(expiry / 1000));
      const { id: orderId, index, signer } = await nextOrder(w); const ow = lc(signer.address) as Hex;
      const [block, mainEth, mainTok, sendFee] = await Promise.all([pc.getBlock().catch(() => null), pc.getBalance({ address: main }), a.side === 'sell' ? balanceOf(token, main) : Promise.resolve(0n), d.gasPrice()]);
      if (a.side === 'sell' && mainTok < amountIn) throw named('LimitRefused', `Not enough ${symbol}: ${fromUnits(mainTok, decimals)} in this wallet`);
      let G: bigint;
      try { G = signedGasPriceFor(C, { baseFee: block?.baseFeePerGas ?? null, nodePrice: C.key === 'robinhood' && block?.baseFeePerGas ? 0n : await pc.getGasPrice() }); } catch (e) { throw named('LimitRefused', String((e as Error).message)); }
      const minOut = (amt: bigint) => Object.fromEntries(variants.map((v) => [v.venue, minOutOf({ side: a.side, amountIn: amt, price: a.price, decimals, taxBps: variantTax(v), taxCapBps: variantTaxCap(v), slippageBps: a.slippageBps }).toString()]));
      let mins = minOut(amountIn);
      const callOf = (v: Variant, amt: bigint, floor: bigint) => swapCall(v, { side: a.side, token, amountIn: amt, minOut: floor, recipient: main, deadline });
      // gas: each call estimated from the main wallet (it holds the funds now); a venue that cannot be asked yet (the V4 pool
      // a curve migrates into, an allowance the main wallet never gave) = the same calldata sent to an EOA + its execution allowance
      const est = async (call: { to: Hex; data?: Hex; value?: bigint }, exec: bigint | null) => {
        try { return await pc.estimateGas({ account: main, ...call }); }
        catch (e) { if (exec == null) throw e; return (await pc.estimateGas({ account: main, to: ow, data: call.data, value: 0n })) + exec; }
      };
      let swapGas: Record<string, bigint> = {}, approveGas: bigint[] = [], ethSweepGas = 0n, tokSweepGas = 0n, fundTokGas = 0n, reserve = 0n;
      let approvals = a.side === 'sell' ? sellApprovals(variants, token, amountIn, deadline) : [];
      try {
        // security audit LO-9: a pre-signed tx may wait 7 days, and on Robinhood its L1 share is charged at inclusion: the L1
        // part gets L1_HEADROOM× on top of the estimate × 1.4 (l1Headroom; the reserve comes back with the sweep)
        await Promise.all(variants.map(async (v) => { const c = callOf(v, amountIn, 0n); const [g, x] = await Promise.all([est(c, v.venue === 'curve' || v.venue === 'four' ? CURVE_EXEC_GAS : v.venue === 'v4bridge' ? BRIDGE_EXEC_GAS : V4_EXEC_GAS), l1Extra(c)]); swapGas[v.venue] = l1Headroom(gasLimitOf(g), x); }));
        approveGas = await Promise.all(approvals.map(async (c) => { const [g, x] = await Promise.all([est(c, null), l1Extra(c)]); return l1Headroom(gasLimitOf(g), x); }));
        ethSweepGas = gasLimitOf(await pc.estimateGas({ account: main, to: ow, value: 1n }));
        // review M3: the funding transfer as it will be sent (main → order wallet), and the way back as the order wallet's own transfer
        fundTokGas = a.side === 'sell' ? gasLimitOf(await pc.estimateGas({ account: main, to: token, data: transferData(ow, amountIn) })) : 0n;
        tokSweepGas = fundTokGas;
        reserve = gasReserve({ slots: [...approveGas.map((g) => [g]), variants.map((v) => swapGas[v.venue])], sweeps: a.side === 'sell' ? [ethSweepGas, tokSweepGas] : [ethSweepGas], gasPrice: G, max: C.maxReserve });
      } catch (e) { if ((e as Error)?.name === 'LimitRefused') throw e; throw named('LimitRefused', `Could not price the order: ${String((e as Error)?.message || e).replace(/\s+/g, ' ').slice(0, 120)}`); }
      const fundValue = (a.side === 'buy' ? amountIn : 0n) + reserve;
      const fundCost = (ethSweepGas + fundTokGas) * sendFee;
      if (mainEth < fundValue + fundCost) throw named('LimitRefused', `Not enough ${C.native}: the order needs ${eth(fundValue + fundCost)} ${C.native} (incl. ${eth(reserve)} gas reserve), the wallet has ${eth(mainEth)}`);
      ev('plan', 'done', { reserve: eth(reserve), venues: variants.map((v) => v.venue) });
      // ── the dialog ──
      const { esc, sub, muted, addrRow } = d.html;
      const kv = (k: string, v: string) => `<div class="dk-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
      const what = a.side === 'buy' ? `Buy ${symbol} with ${a.amount} ${C.native}` : `Sell ${a.amount} ${symbol}`;
      const when = a.kind === 'tp' ? 'at or above' : 'at or below';
      const title = a.kind === 'limit' ? 'Place limit order' : a.kind === 'tp' ? 'Set take-profit' : 'Set stop-loss';
      const best = Object.values(mins).map(BigInt).reduce((m, x) => (x < m ? x : m));   // the floor whichever variant fills
      const receive = a.side === 'buy' ? `${fromUnits(best, decimals)} ${symbol}` : `${eth(best)} ${C.native}`;
      const v0 = variants[0];
      const venue = v0.venue === 'four' ? 'four.meme curve (its PancakeSwap V2 pool once it lists)' : v0.venue === 'v2' ? 'PancakeSwap V2 pool'
        : v0.venue === 'v2bridge' ? `PancakeSwap V2 pool quoted in ${v0.quote} (${C.native} → it → ${symbol} in one swap)`
        : v0.venue === 'v4bridge' ? `Uniswap V4 pool quoted in ${v0.quote} (${C.native} → it on Uniswap V3, then the pool, in one transaction; both pools' fees are in the floor)`
        : variants.length > 1 ? 'Pons curve (its V4 pool once it migrates)' : 'Uniswap V4 pool';
      const ok = await d.ask({
        title, ok: a.kind === 'limit' ? 'Place order' : a.kind === 'tp' ? 'Set take-profit' : 'Set stop-loss',
        html: `${sub(`${esc(what)} when the price is ${when} <b>${esc(a.price)} ${C.native}</b> per ${esc(symbol)}. Paid to ${esc(w.name)}.`)}<div class="dk-list">${[
          addrRow(`Token ${symbol}`, token),
          kv('Venue', esc(venue)),
          kv('You receive at least', esc(receive)),
          kv('Slippage', `${a.slippageBps / 100} %`),
          kv('Expires', esc(utc(expiry))),
          kv('Moves now', esc(a.side === 'buy' ? `${eth(fundValue)} ${C.native} (${eth(reserve)} gas reserve)` : `${a.amount} ${symbol} + ${eth(reserve)} ${C.native} gas reserve`)),
          addrRow('Order wallet', ow),
        ].join('')}</div>${muted(`The order wallet is this order's own; only this vault can sign for it. motion's server keeps the signed swap and sends it when the price is reached — it cannot change the amount, price, venue or recipient. The floor is your limit price minus the slippage: a better price at that moment may not reach you in full. Cancel any time: everything comes back to ${esc(w.name)}.${a.kind === 'sl' ? ' A stop-loss fills at the minimum or not at all: in a fast drop it may not fill.' : ''} Network fees apply.`)}`,
      });
      if (!ok) throw named('Cancelled', 'Cancelled');
      // ── funding (the point after which this key's outcome is recorded) ──
      sending();
      const rec: LocalOrder = {
        v: 1, id: orderId, index, walletId: w.id, wallet: main, orderWallet: ow, token, symbol, decimals, side: a.side, kind: a.kind, price: a.price, amount: a.amount, amountIn: amountIn.toString(),
        minOut: mins, slippageBps: a.slippageBps, expiry, createdAt, venues: variants.map((v) => v.venue), swapNonce: null, txs: [], fund: [], approve: [], swap: {},
        reserve: reserve.toString(), gasPrice: G.toString(), stage: 'funding', stored: false,
        ...(bridgeOf(v0) ? { bridge: bridgeOf(v0) as PostedBridge } : {}),
      };
      put(rec);
      const fail = (e: unknown) => { rec.error = String((e as Error)?.message || e).slice(0, 200); put(rec); ev('fund', 'failed', { orderId, error: rec.error }); return e; };
      ev('fund', 'active', { orderId, orderWallet: ow });
      try {
        const h1 = await d.sendTx(w.id, { to: ow, value: fundValue }, ethSweepGas);
        rec.fund.push(h1); put(rec);
        const h2 = a.side === 'sell' ? await d.sendTx(w.id, { to: token, data: transferData(ow, amountIn) }, fundTokGas) : null;
        if (h2) { rec.fund.push(h2); put(rec); }
        await landed(h1 as Hex, 'Funding the order wallet');
        if (h2) await landed(h2 as Hex, 'Moving the tokens to the order wallet');
      } catch (e) { throw fail(e); }
      ev('fund', 'done', { orderId, hashes: [...rec.fund] });
      rec.stage = 'signing'; put(rec);
      const ret = async (why: string) => {
        // the order cannot go live: everything goes back to the main wallet at once, no dialog (the user already agreed to the order)
        rec.error = why.slice(0, 200); put(rec);
        const r = await returnAll(w, signer, token, rec.swapNonce, ev).catch(() => null);
        rec.closed = 'failed'; if (r) { rec.sweptAt = d.now(); if (r.empty) rec.emptyAt = d.now(); } put(rec);
        return named('LimitRefused', `${why} — ${r ? `the funds went back to ${w.name}` : 'return them with limit.sweep'}`, { orderId });
      };
      try {
        // ── approvals of a sell (exact amounts), signed and sent from the order wallet, nonce 0 … k−1 ──
        const n0 = await pc.getTransactionCount({ address: ow, blockTag: 'pending' });
        if (n0 !== 0) throw await ret('The order wallet is not new');
        if (a.side === 'sell') {
          const got = await balanceOf(token, ow);
          if (got < amountIn) {   // a token that takes a fee on transfer: the order sells what arrived
            if (got <= 0n) throw await ret('No tokens arrived in the order wallet');
            amountIn = got; mins = minOut(amountIn); rec.amountIn = amountIn.toString(); rec.minOut = mins; approvals = sellApprovals(variants, token, amountIn, deadline);
            if (notionalWei(amountIn, a.price, decimals) < C.minSize) throw await ret(`What arrived is below the ${eth(C.minSize)} ${C.native} minimum`);
          }
          ev('approve', 'active', { orderId });
          const hs: Hex[] = [];
          for (let i = 0; i < approvals.length; i += 1) {
            const c = approvals[i];
            const raw = await signer.sign({ to: c.to, data: c.data, value: 0n, nonce: n0 + i, gas: approveGas[i], gasPrice: G });
            rec.txs.push({ nonce: n0 + i, role: 'approve', venue: c.what as SignedTx['venue'], raw });
            const h = await d.broadcast(raw); hs.push(h); rec.approve.push(h); put(rec);
          }
          for (const h of hs) await landed(h, 'An approval of the order wallet');
          ev('approve', 'done', { orderId, hashes: hs });
        }
        // ── the swap: every variant on ONE nonce (at most one can ever land), recipient = the main wallet ──
        const swapNonce = n0 + approvals.length;
        ev('sign', 'active', { orderId });
        for (const v of variants) {
          const c = callOf(v, amountIn, BigInt(mins[v.venue]));
          const raw = await signer.sign({ to: c.to, data: c.data, value: c.value, nonce: swapNonce, gas: swapGas[v.venue], gasPrice: G });
          rec.txs.push({ nonce: swapNonce, role: 'swap', venue: v.venue, raw }); rec.swap[v.venue] = keccak256(raw);
        }
        rec.swapNonce = swapNonce; put(rec);
        // the venue that exists now must take the call from the order wallet AND pay the main wallet (minOut 0: the route, the
        // approvals and the recipient, not the price)
        const checks: Record<string, string> = {};
        for (const v of variants) {
          if ((v.venue === 'v4' || v.venue === 'v2') && v.migrates) continue;   // the pool a curve lists into may not exist yet
          const c = callOf(v, amountIn, 0n);
          let probe: { check: 'paid' | 'unchecked'; out: bigint };
          try { probe = await paysMain(ow, c, a.side === 'buy' ? token : null, main); }
          catch (e) { throw await ret(`The swap would not go through from the order wallet (${String((e as Error)?.message || e).replace(/\s+/g, ' ').slice(0, 80)})`); }
          checks[v.venue] = probe.check;
          // security audit LO-2: the market pays `out` right now; a limit buy / take-profit whose floor is far under it would
          // fill at once at that floor (a price far from the market — a mistake, or a page that picked it). A stop-loss is meant
          // to sit under the market; one above it can never fill (the floor exceeds what the venue pays).
          const floor = BigInt(mins[v.venue]);
          if (a.kind !== 'sl' && probe.out > 0n && probe.out * 4n > floor * 5n) {
            const gap = Number(((probe.out - floor) * 100n) / probe.out);
            throw await ret(`Your price is far from the market: the order would fill right away with a floor ${gap}% under what the market pays now — use a market trade, or set a price near the market`);
          }
        }
        ev('sign', 'done', { orderId, checks });
      } catch (e) { if ((e as Error)?.name !== 'LimitRefused') fail(e); throw e; }
      // ── to the keeper ──
      ev('post', 'active', { orderId });
      const r = await postOrder(w, posted(rec));
      rec.stage = 'open'; rec.stored = r.ok; put(rec);
      if (!r.ok && r.status >= 400 && r.status < 500) throw await ret(`motion's server refused the order: ${r.error || r.status}`);
      ev('post', r.ok ? 'done' : 'failed', { orderId, ...(r.ok ? {} : { note: 'Not stored yet — the next order list sends it again' }) });
      const st = await chainOf(ow, token).catch(() => null);
      return { ok: true, order: view(rec, 'open', st) };
    }));
  }

  // ── limit.cancel (a dialog unless this vault knows the order can no longer fill) and limit.sweep (no dialog: only those) ──
  async function close(o: unknown, mode: 'cancel' | 'sweep', auto = false) {
    const a = mode === 'cancel' ? limitArgs.cancel(o) : limitArgs.sweep(o);
    laneOk();
    const w = d.wallet(a.walletId);
    const run = (sending: () => void) => d.lock('limit:' + lc(w.address), async () => {
      if (a.idempotencyKey && d.idemSeen?.(a.idempotencyKey)) throw named('LimitUnknown', 'Status unknown — this was started in another tab; check the order before trying again', { unknown: true });
      const ev = (step: string, state: string, x: Record<string, unknown> = {}) => d.emit({ key: a.idempotencyKey || '', walletId: w.id, orderId: a.orderId, step, state, ...(auto ? { auto: true } : {}), ...x });
      const rec = get(a.orderId);
      if (rec && !same(rec.wallet, w.address)) throw named('LimitRefused', 'This order belongs to another wallet');
      // review M2: the token goes back for a buy too (anything may have been sent there); the page's token / swapNonce only
      // matter for an order this browser did not place — hints that decide what is swept and which nonce is burnt, never
      // where anything goes (always back to this main wallet)
      const token = (rec?.token || a.token || null) as Hex | null;
      const swapNonce = trusted(rec) ? rec.swapNonce : (a.swapNonce ?? (rec as LocalOrder | null)?.swapNonce ?? null);
      const signer = await d.orderSigner(w.id, a.orderId); const ow = lc(signer.address) as Hex;
      if (rec && !same(rec.orderWallet, ow)) throw named('LimitRefused', 'The order wallet does not match this order');
      const st = await chainOf(ow, token);
      const empty = isEmpty(st);
      // can it still fill? Known only for an order this vault placed (review M1); anything else counts as "maybe"
      const live = trusted(rec) ? (rec.stage === 'open' && rec.swapNonce != null && st.nonce <= rec.swapNonce && !rec.closed) : true;
      const expired = trusted(rec) ? d.now() > rec.expiry : false;
      if (empty && (!live || !trusted(rec))) {
        if (rec && !rec.closed) { rec.closed = trusted(rec) ? await outcomeOf(rec) : 'cancelled'; }
        if (rec) { rec.emptyAt = d.now(); put(rec); }
        return { ok: true, orderId: a.orderId, state: rec?.closed || 'empty', invalidated: swapNonce == null ? null : st.nonce > swapNonce, returned: { eth: '0', token: '0' }, hashes: [] as string[] };
      }
      if (mode === 'sweep' && live && !expired) throw named('LimitRefused', trusted(rec) ? 'This order can still fill — cancel it instead (limit.cancel asks first)' : 'This vault cannot tell whether this order can still fill — cancel it instead (limit.cancel asks first)');
      if (mode === 'cancel' && live) {
        const { esc, sub, muted, addrRow } = d.html;
        const kv = (k: string, v: string) => `<div class="dk-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
        const ok = await d.ask({
          // no typed code (owner 2026-10-26: "an ugly captcha"): a cancel only returns the order wallet's funds to the user's own wallet
          title: 'Cancel order', ok: 'Cancel order',
          html: `${sub(trusted(rec) ? `${esc(rec.side === 'buy' ? `Buy ${rec.symbol} with ${rec.amount} ${unit()}` : `Sell ${rec.amount} ${rec.symbol}`)} at ${esc(rec.price)} ${unit()}. Everything in its order wallet goes back to ${esc(w.name)}.` : `An order this device did not place. Everything in its order wallet goes back to ${esc(w.name)}.`)}<div class="dk-list">${[
            kv('Returns', esc(`${eth(st.eth)} ${unit()}${st.token > 0n ? ` + ${fromUnits(st.token, rec?.decimals ?? 18)} ${rec?.symbol || 'tokens'}` : ''}`)),
            ...(token ? [addrRow('Token', token)] : []),
            addrRow('Order wallet', ow), addrRow(w.name, w.address),
          ].join('')}</div>${muted('The return uses the order\'s own nonce, so its signed swap can never go through afterwards. If the price was reached a moment ago, the swap may land first: then the order is filled and only what is left comes back.')}`,
        });
        if (!ok) throw named('Cancelled', 'Cancelled');
      }
      sending();
      ev(mode, 'active');
      const r = await returnAll(w, signer, token, swapNonce, ev);
      let state: string = 'swept';
      if (r.invalidated === false && trusted(rec)) {
        // review L8: the swap's nonce is still ahead (a return could not take it) — the order stays as it is, on the server too
        state = rec.stage === 'open' ? 'open' : 'placing';
        if (r.empty) rec.error = 'Returned, but the signed swap could not be invalidated yet — cancel again';
        put(rec);
      } else if (rec) {
        rec.closed = trusted(rec) ? (rec.stage === 'open' ? await outcomeOf(rec) : 'failed') : 'cancelled';
        if (rec.closed === 'cancelled' && expired) rec.closed = 'expired';   // the return after expiry burnt the nonce: it expired
        rec.sweptAt = d.now(); if (r.empty) rec.emptyAt = d.now(); put(rec); state = rec.closed;
      } else state = 'cancelled';
      if (mode === 'cancel' && r.invalidated !== false && (live || !trusted(rec))) await deleteOrder(w, a.orderId);
      ev(mode, 'done', { state });
      return { ok: true, orderId: a.orderId, state, invalidated: r.invalidated, returned: { eth: eth(r.eth), token: rec ? fromUnits(r.token, rec.decimals) : r.token.toString() }, hashes: r.hashes, ...(r.tokenError ? { tokenError: r.tokenError } : {}) };
    });
    if (mode === 'cancel') return d.once({ idempotencyKey: a.idempotencyKey }, ['limit.cancel', w.id, a.orderId], run);
    return a.idempotencyKey ? d.once({ idempotencyKey: a.idempotencyKey }, ['limit.sweep', w.id, a.orderId], run) : run(() => {});
  }

  // ── review L4: the first list after an order expired returns its funds by itself (this vault's own orders only) ──
  const autoRunning = new Set<string>();
  const autoSweep = (rec: LocalOrder) => {
    if (autoRunning.has(rec.id)) return; autoRunning.add(rec.id);
    void close({ walletId: rec.walletId, orderId: rec.id }, 'sweep', true).catch((e) => d.emit({ key: '', walletId: rec.walletId, orderId: rec.id, step: 'sweep', state: 'failed', auto: true, error: String((e as Error)?.message || e).slice(0, 160) })).finally(() => autoRunning.delete(rec.id));
  };

  // ── limit.list: this browser's orders with what the chain says now (every one that still holds anything); with a wallet it
  //    also scans the wallet's order ids for order wallets this browser has no record of (a wiped browser, another device) ──
  async function list(o: unknown) {
    const a = limitArgs.list(o);
    laneOk();
    const ws = a.walletId ? [d.wallet(a.walletId)] : d.wallets();
    const found = a.walletId ? await scan(ws[0]).catch(() => 0) : 0;
    const mine = Object.values(readAll()).filter((r) => ws.some((w) => same(w.address, r.wallet))).sort((x, y) => y.createdAt - x.createdAt);
    // every record whose wallet was not seen empty; of the emptied ones the 40 newest of the last 3 days
    const show = [...mine.filter((r) => !r.emptyAt), ...mine.filter((r) => r.emptyAt && d.now() - r.emptyAt < 3 * 86400_000).slice(0, 40)];
    const orders = await Promise.all(show.map(async (rec) => {
      const st = await chainOf(rec.orderWallet, rec.token || null).catch(() => null);
      const state = await stateOf(rec, st);
      if (['filled', 'reverted', 'cancelled'].includes(state) && !rec.closed) patch(rec.id, { closed: state as LocalOrder['closed'] });
      if (st && isEmpty(st) && !rec.emptyAt && state !== 'open' && state !== 'placing' && state !== 'recovered') patch(rec.id, { emptyAt: d.now() });
      if (st && isEmpty(st) && state === 'recovered' && !rec.emptyAt && st.nonce > 0) patch(rec.id, { emptyAt: d.now(), closed: 'cancelled' });
      if (state === 'open' && !rec.stored && rec.txs.length) {
        const w = ws.find((x) => same(x.address, rec.wallet));
        if (w) { const r = await postOrder(w, posted(rec)).catch(() => null); if (r?.ok) patch(rec.id, { stored: true }); }
      }
      if (state === 'expired' && st && !isEmpty(st)) autoSweep(rec);
      return { ...view(rec, state, st), ...(state === 'expired' && st && !isEmpty(st) ? { autoSweep: true } : {}) };
    }));
    // security audit LO-8: the wallet's 24 h read token stays inside the vault (the scan above uses it for our server). Any
    // script on the page could take it and read the wallet's stop-loss levels for a day; the page polls the keeper by ids.
    return { ok: true, chain: P().key, chainId: P().chainId, native: unit(), orders, recovered: found };
  }

  return {
    place, list,
    cancel: (o: unknown) => close(o, 'cancel'),
    sweep: (o: unknown) => close(o, 'sweep'),
  };
}
