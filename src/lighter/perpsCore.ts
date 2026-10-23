// Perps on Lighter (Robinhood Chain instance): the pure parts the vault engine uses (src/perpsEngine.ts) — no DOM, no
// network, no keys. Units, order building, the confirmation rules, the nonce keeper, the L1 texts and the shape checks
// of every bridge argument. Unit-tested in scripts/perps-engine.test.mjs.

export const LIGHTER_API = 'https://api.rh.lighter.xyz';
/** ZkLighter proxy on Robinhood Chain (GET /info → contract_address, read 2026-10-22). */
export const ZK_LIGHTER = '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d' as const;
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;
/** Uniswap V3 SwapRouter on Robinhood (the engine's v3Router) and the WETH/USDG pools behind it (read 2026-10-22:
 *  0.01 % 0x52e6…71Ca ≈ 5 215 WETH + 6.4 M USDG; 0.05 % 0x69Bf…8d9a ≈ 1 078 WETH + 2.8 M USDG). */
export const V3_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2' as const;
export const SWAP_FEES = [100, 500] as const;
export const USDG_ASSET = 3;
export const ROUTE_PERP = 0;
export const USDG_DECIMALS = 6;
/** motion's API key slot on every account (0–3 and 157 are Lighter's / Robinhood's apps; registering replaces a slot). */
export const API_KEY_INDEX = 77;
/**
 * One Lighter API key per WALLET, the same on every device (2026-10-22, owner's live bug: the desktop's random key replaced
 * the phone's at slot 77, and the phone's close came back "invalid signature"). The key's 32-byte seed is
 *   HMAC-SHA256(key = the wallet's 32-byte EVM private key, message = apiKeySeedMessage(chain, account, slot))
 * and the key itself is Lighter's own seed → key derivation in the pinned signer (signer.ts fromSeed). The wallet key
 * never leaves the vault engine (src/webEngine.ts computes the HMAC); the seed and the key are never logged or sent.
 * Bump the version only together with a migration: every device of a wallet must derive the same key.
 */
export const KEY_DERIVATION = 'motion/lighter-api-key/v1';
export const apiKeySeedMessage = (chainId: number, account: number, slot: number) => {
  for (const [n, v] of [['chain', chainId], ['account', account], ['slot', slot]] as const) if (!Number.isSafeInteger(v) || v < 0) throw new Error('Bad key derivation input: ' + n);
  return `${KEY_DERIVATION}\nlighter chain id: ${chainId}\naccount index: ${account}\napi key index: ${slot}`;
};
/** The seed (64 hex) of this wallet's Lighter API key for one account + slot. WebCrypto only; `walletKey` = 0x + 64 hex. */
export async function apiKeySeed(walletKey: string, chainId: number, account: number, slot: number): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletKey)) throw new Error('Bad wallet key');
  const raw = new Uint8Array(32); for (let i = 0; i < 32; i += 1) raw[i] = parseInt(walletKey.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(apiKeySeedMessage(chainId, account, slot))));
    return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  } finally { raw.fill(0); }
}
export const MIN_DEPOSIT = 1_000_000n;    // 1 USDG (Lighter's minimum per deposit)
export const MIN_WITHDRAW = 1_000_000n;   // 1 USDG
export const LEVERAGE_CONFIRM = 20;       // an order at 20x or more asks in the vault's dialog
/** L7: the open notional of one wallet in the last hour above which an order asks too (rapid small orders add up) */
export const HOURLY_CAP = 5000;
/** B1 (review 2026-10-22): the ONLY Lighter account a fast withdrawal may transfer to. Lighter's API names the pool, and
 *  an API-chosen destination is not acceptable for a transfer the wallet key signs; until the RH pool account is
 *  verified out of band and pinned here, instant withdrawals are OFF (args.withdraw refuses speed 'fast', the quote
 *  offers none, the vault refuses to sign any Transfer text). */
export const FAST_WITHDRAW_POOL: number | null = null;
export const CAP_DEFAULT = 1000;          // USDG notional per order per wallet that goes out without a dialog
export const SLIP_MAX_BPS = 500;          // the widest slippage the engine signs
export const LIMIT_BAND = 0.05;           // an aggressive limit price at most 5 % through the mark
/** Lighter's terms (lighter.xyz/terms, 2025-12-29): not available to persons in these places. */
export const RESTRICTED = ['US', 'CA', 'GB', 'CN', 'KP', 'RU', 'UA', 'CU', 'IR', 'VE', 'SD', 'BY', 'MM', 'SY'] as const;
export const RESTRICTED_NAMES = 'the United States, Canada, the United Kingdom, China, North Korea, Russia, Ukraine, Cuba, Iran, Venezuela, Sudan, Belarus, Myanmar or Syria';
export const ORDER_TYPE = Object.freeze({ limit: 0, market: 1, stopLoss: 2, stopLossLimit: 3, takeProfit: 4, takeProfitLimit: 5 });
export const TIF = Object.freeze({ ioc: 0, gtt: 1, postOnly: 2 });
export const GROUP = Object.freeze({ oto: 1, oco: 2, otoco: 3 });
export const DAY_MS = 86_400_000;

// ── units ──
const DEC = /^\d{1,15}(\.\d{1,18})?$/;
/** "12.34" with `decimals` → integer units; refuses more decimals than the unit has, signs, exponents. */
export function units(v: string, decimals: number): bigint {
  const s = String(v).trim();
  if (!DEC.test(s)) throw new Error(`Bad amount: ${s.slice(0, 24)}`);
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) { if (/[^0]/.test(f.slice(decimals))) throw new Error(`Too many decimals: ${s}`); }
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f.slice(0, decimals) || '').padEnd(decimals, '0') || '0');
}
export function decimal(u: bigint, decimals: number): string {
  const neg = u < 0n; const a = neg ? -u : u;
  const s = a.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals), f = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + i + (f ? '.' + f : '');
}
/** a float price → integer ticks, rounded towards the side that keeps the guard (up for a buy cap, down for a sell floor) */
export function ticks(price: number, decimals: number, up: boolean): bigint {
  const x = price * 10 ** decimals;
  if (!Number.isFinite(x) || x <= 0) throw new Error('Bad price');
  const r = Math.round(x);
  return BigInt(Math.abs(x - r) < 1e-7 ? r : up ? Math.ceil(x) : Math.floor(x));
}

// ── the L1 texts the wallet key signs (lighter-go types/txtypes/utils.go; the engine builds them itself and refuses to
// sign when the signer's text differs by one byte) ──
export const hex10 = (n: number | bigint) => '0x' + BigInt(n).toString(16).padStart(16, '0');
export function changePubKeyBody(pubHex: string, nonce: number, account: number, apiKey: number): string {
  return `Register Lighter Account\n\npubkey: 0x${pubHex}\nnonce: ${hex10(nonce)}\naccount index: ${hex10(account)}\napi key index: ${hex10(apiKey)}\nOnly sign this message for a trusted client!`;
}
export function transferBody(t: { nonce: number; from: number; fromRoute: number; apiKey: number; to: number; toRoute: number; asset: number; amount: bigint; fee: bigint; chainId: number; memoHex: string }): string {
  return `Transfer\n\nnonce: ${hex10(t.nonce)}\nfrom: ${hex10(t.from)} (route ${hex10(t.fromRoute)})\napi key: ${hex10(t.apiKey)}\nto: ${hex10(t.to)} (route ${hex10(t.toRoute)})\nasset: ${hex10(t.asset)}\namount: ${hex10(t.amount)}\nfee: ${hex10(t.fee)}\nchainId: ${hex10(t.chainId)}\nmemo: ${t.memoHex}\nOnly sign this message for a trusted client!`;
}
/**
 * B1 (review 2026-10-22): what the wallet key may sign, parsed field by field — not a prefix check.
 * · Registration: exactly Lighter's template, account index = THIS wallet's account (the one Lighter's account read lists
 *   under this wallet's own address), API key index = ours (77).
 * · Transfer (fast withdrawal): to = FAST_WITHDRAW_POOL (null → always refused), from = this wallet's account, route perps,
 *   asset USDG, memo = this wallet's address + 12 zero bytes, Lighter chain id 466324.
 * Returns null when the text may be signed, otherwise why not.
 */
/** M1: which of two Lighter records of one wallet to keep across tabs (src/webEngine.ts mergeFromDisk): the later one; on the
 *  same time a confirmed registration (st 'ok') over a pending one */
export function ltNewer(disk: { at?: number; st?: string }, mine: { at?: number; st?: string }): boolean {
  const a = Number(disk.at) || 0, b = Number(mine.at) || 0;
  return a > b || (a === b && disk.st === 'ok' && mine.st !== 'ok');
}
/** The record to keep when another tab wrote one (src/webEngine.ts mergeFromDisk): the newer one (ltNewer), carrying the
 *  region declaration of either — it is per WALLET, not per key, so once given it never goes away in a merge (2026-10-22). */
export function ltMerge<T extends { at?: number; st?: string; region?: number }>(disk: T, mine: T | undefined): T {
  if (!mine) return disk;
  const keep = ltNewer(disk, mine) ? disk : mine;
  const region = keep.region || disk.region || mine.region;
  return region && !keep.region ? { ...keep, region } : keep;
}
/** ctx.pool is for tests only; the vault always uses FAST_WITHDRAW_POOL */
export function l1TextProblem(text: string, ctx: { account: number | null | undefined; address: string; chainId: number; pool?: number | null }): string | null {
  const pool = ctx.pool === undefined ? FAST_WITHDRAW_POOL : ctx.pool;
  if (typeof text !== 'string' || text.length > 900) return 'not a Lighter text';
  const H = '0x([0-9a-f]{16})';
  const reg = new RegExp(`^Register Lighter Account\\n\\npubkey: 0x[0-9a-f]{80}\\nnonce: ${H}\\naccount index: ${H}\\napi key index: ${H}\\nOnly sign this message for a trusted client!$`).exec(text);
  if (reg) {
    if (ctx.account == null || BigInt('0x' + reg[2]) !== BigInt(ctx.account)) return 'the registration names another account';
    if (BigInt('0x' + reg[3]) !== BigInt(API_KEY_INDEX)) return 'the registration names another key slot';
    return null;
  }
  const tr = new RegExp(`^Transfer\\n\\nnonce: ${H}\\nfrom: ${H} \\(route ${H}\\)\\napi key: ${H}\\nto: ${H} \\(route ${H}\\)\\nasset: ${H}\\namount: ${H}\\nfee: ${H}\\nchainId: ${H}\\nmemo: ([0-9a-f]{64})\\nOnly sign this message for a trusted client!$`).exec(text);
  if (tr) {
    const n = (i: number) => BigInt('0x' + tr[i]);
    if (pool == null || n(5) !== BigInt(pool)) return 'the transfer goes to an account that is not Lighter\'s pinned withdrawal pool';
    if (ctx.account == null || n(2) !== BigInt(ctx.account)) return 'the transfer is from another account';
    if (n(3) !== BigInt(ROUTE_PERP) || n(6) !== BigInt(ROUTE_PERP) || n(7) !== BigInt(USDG_ASSET)) return 'not a USDG perps transfer';
    if (n(10) !== BigInt(ctx.chainId)) return 'another Lighter chain';
    let memo = ''; try { memo = withdrawMemo(ctx.address); } catch { return 'bad address'; }
    if (tr[11] !== memo) return 'the transfer memo names another destination';
    return null;
  }
  return 'not a Lighter text';
}
/** A fast withdrawal's memo: the destination address, then 12 zero bytes (lighter-python examples/transfers/withdraw_fast.py). */
export function withdrawMemo(address: string): string {
  const a = String(address).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('Bad address');
  return a + '0'.repeat(24);
}

// ── markets ──
export type Market = {
  id: number; symbol: string; sizeDecimals: number; priceDecimals: number; minBase: bigint; minQuote: bigint;
  imfMin: number; imfDefault: number; mmf: number; mark: number; index: number; last: number; maxLeverage: number; active: boolean;
};
/** One entry of GET /api/v1/orderBookDetails → order_book_details[]. */
export function marketOf(d: Record<string, unknown>): Market {
  const n = (k: string) => Number(d[k]);
  const sizeDecimals = n('size_decimals'), priceDecimals = n('price_decimals'), imfMin = n('min_initial_margin_fraction');
  if (![sizeDecimals, priceDecimals].every((x) => Number.isInteger(x) && x >= 0 && x <= 10) || !(imfMin > 0 && imfMin <= 10000)) throw new Error('Unexpected market data from Lighter');
  return {
    id: n('market_id'), symbol: String(d.symbol || ''), sizeDecimals, priceDecimals,
    minBase: units(String(d.min_base_amount || '0'), sizeDecimals), minQuote: units(String(d.min_quote_amount || '0'), USDG_DECIMALS),
    imfMin, imfDefault: n('default_initial_margin_fraction') || imfMin, mmf: n('maintenance_margin_fraction') || 0,
    mark: Number(d.mark_price) || 0, index: Number(d.index_price) || 0, last: Number(d.last_trade_price) || 0,
    maxLeverage: Math.floor(10000 / imfMin), active: d.status === 'active' && d.is_frozen !== true && d.market_type === 'perp',
  };
}
/** leverage → Lighter's initial margin fraction (10 000 = 100 %) */
export const imfOf = (leverage: number) => Math.floor(10000 / leverage);
export const leverageOf = (imf: number) => (imf > 0 ? Math.round(10000 / imf) : 0);

// ── orders ──
export type Side = 'long' | 'short';
export type OrderReq = {
  market: number; side: Side; type: 'market' | 'limit'; sizeUsdg: string; price?: string; slippageBps: number; leverage: number;
  marginMode: 'cross' | 'isolated'; tp?: { trigger: string }; sl?: { trigger: string };
};
export type Built = {
  isAsk: 0 | 1; base: bigint; priceTicks: bigint; worst: number; ref: number; notional: number; margin: number; imf: number;
  orders: { market: number; clientOrderIndex: number; baseAmount: bigint; price: bigint; isAsk: 0 | 1; type: number; timeInForce: number; reduceOnly: 0 | 1; triggerPrice: bigint; orderExpiry: number }[];
  group: number; liq: number; errors: string[];
};
/** Lighter's client_order_index: unique per account, < 2^48. Random, never 0. */
export function clientOrderIndex(rand: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32): number {
  return 1 + Math.floor(rand() * (2 ** 47 - 2));
}
/** Liquidation estimate of an isolated position (phase 1 formula): entry × (1 ∓ (1/lev − mmf)). The real figure, once open, is Lighter's. */
export function liqEstimate(side: Side, entry: number, leverage: number, mmf: number): number {
  const m = mmf / 10000; const d = 1 / leverage - m;
  return Math.max(0, side === 'long' ? entry * (1 - d) : entry * (1 + d));
}
/**
 * The order(s) for one ticket, from the vault's OWN market read (book top + mark). `ref` = the price it expects to fill
 * at (best ask for a long, best bid for a short; the mark when the book is empty); the market order's cap is ref ± the
 * slippage. A limit price may not be more than LIMIT_BAND through the mark on the aggressive side (a resting order far
 * through the market fills at once against whoever sits there — a page must not be able to give money away that way).
 * TP / SL go with the entry as one group (OTO / OTOCO), reduce-only, triggered on the mark.
 */
export function buildOrder(r: OrderReq, m: Market, book: { bid: number; ask: number }, now: number, coi: () => number = clientOrderIndex): Built {
  const errors: string[] = [];
  const isAsk: 0 | 1 = r.side === 'short' ? 1 : 0;
  const mark = m.mark || m.last;
  const ref = r.side === 'long' ? (book.ask || mark) : (book.bid || mark);
  if (!(mark > 0) || !(ref > 0)) throw new Error('No price for this market right now');
  const slip = r.slippageBps / 10000;
  const notional = Number(r.sizeUsdg);
  if (!m.active) errors.push(`${m.symbol} is not open for trading right now`);
  if (r.leverage > m.maxLeverage) errors.push(`${m.symbol} allows up to ${m.maxLeverage}x`);
  let price: number, worst: number;
  if (r.type === 'limit') {
    price = Number(r.price);
    if (!(price > 0)) throw new Error('A limit order needs a price');
    if (r.side === 'long' && price > mark * (1 + LIMIT_BAND)) errors.push(`A buy limit above ${(LIMIT_BAND * 100).toFixed(0)} % over the mark is refused — use a market order`);
    if (r.side === 'short' && price < mark * (1 - LIMIT_BAND)) errors.push(`A sell limit more than ${(LIMIT_BAND * 100).toFixed(0)} % under the mark is refused — use a market order`);
    worst = price;
  } else {
    price = ref;
    worst = r.side === 'long' ? ref * (1 + slip) : ref * (1 - slip);
  }
  const priceTicks = ticks(worst, m.priceDecimals, r.side === 'long');
  const base = BigInt(Math.floor((notional / price) * 10 ** m.sizeDecimals + 1e-9));
  if (base <= 0n || base < m.minBase) errors.push(`The smallest ${m.symbol} order is ${decimal(m.minBase, m.sizeDecimals)} ${m.symbol} (about $${(Number(decimal(m.minBase, m.sizeDecimals)) * price).toFixed(2)})`);
  const quoteUnits = units(notional.toFixed(6), USDG_DECIMALS);
  if (quoteUnits < m.minQuote) errors.push(`The smallest order is $${decimal(m.minQuote, USDG_DECIMALS)}`);
  const imf = imfOf(r.leverage);
  const margin = notional / r.leverage;
  const exp28 = now + 28 * DAY_MS;
  const entry: Built['orders'][number] = r.type === 'limit'
    ? { market: m.id, clientOrderIndex: coi(), baseAmount: base, price: priceTicks, isAsk, type: ORDER_TYPE.limit, timeInForce: TIF.gtt, reduceOnly: 0 as const, triggerPrice: 0n, orderExpiry: exp28 }
    : { market: m.id, clientOrderIndex: coi(), baseAmount: base, price: priceTicks, isAsk, type: ORDER_TYPE.market, timeInForce: TIF.ioc, reduceOnly: 0 as const, triggerPrice: 0n, orderExpiry: 0 };
  const orders: Built['orders'] = [entry];
  const exitAsk: 0 | 1 = isAsk ? 0 : 1;
  const child = (kind: 'tp' | 'sl', trig: number): Built['orders'][number] => {
    const t = ticks(trig, m.priceDecimals, r.side === 'short');
    // the limit behind the trigger: through it by the slippage, so the close fills when the mark gets there
    const lim = r.side === 'long' ? trig * (1 - slip) : trig * (1 + slip);
    return { market: m.id, clientOrderIndex: coi(), baseAmount: 0n, price: ticks(lim, m.priceDecimals, r.side === 'short'), isAsk: exitAsk, type: kind === 'tp' ? ORDER_TYPE.takeProfitLimit : ORDER_TYPE.stopLossLimit, timeInForce: TIF.gtt, reduceOnly: 1 as const, triggerPrice: t, orderExpiry: exp28 };
  };
  const tp = r.tp ? Number(r.tp.trigger) : 0, sl = r.sl ? Number(r.sl.trigger) : 0;
  if (r.tp) { if (!(tp > 0) || (r.side === 'long' ? tp <= price : tp >= price)) errors.push('Take profit must be ' + (r.side === 'long' ? 'above' : 'below') + ' the entry'); else orders.push(child('tp', tp)); }
  if (r.sl) { if (!(sl > 0) || (r.side === 'long' ? sl >= price : sl <= price)) errors.push('Stop loss must be ' + (r.side === 'long' ? 'below' : 'above') + ' the entry'); else orders.push(child('sl', sl)); }
  // inside a group the entry is a LIMIT IOC at the cap (Lighter's own grouped pattern); alone a market order is MARKET IOC
  if (orders.length > 1 && r.type === 'market') { entry.type = ORDER_TYPE.limit; entry.timeInForce = TIF.ioc; entry.orderExpiry = 0; }
  const group = orders.length === 3 ? GROUP.otoco : orders.length === 2 ? GROUP.oto : 0;
  return { isAsk, base, priceTicks, worst, ref: price, notional, margin, imf, orders, group, liq: liqEstimate(r.side, price, r.leverage, m.mmf), errors };
}
/** A reduce-only market close of `fraction` of a position (size in base units, from Lighter's account read). */
export function buildClose(m: Market, pos: { size: bigint; side: Side }, fraction: number, slippageBps: number, book: { bid: number; ask: number }, coi: () => number = clientOrderIndex) {
  const isAsk: 0 | 1 = pos.side === 'long' ? 1 : 0;
  const ref = pos.side === 'long' ? (book.bid || m.mark) : (book.ask || m.mark);
  if (!(ref > 0)) throw new Error('No price for this market right now');
  const slip = slippageBps / 10000;
  const worst = pos.side === 'long' ? ref * (1 - slip) : ref * (1 + slip);
  const base = fraction >= 1 ? pos.size : BigInt(Math.floor(Number(pos.size) * fraction));
  if (base <= 0n) throw new Error('Nothing to close');
  return { ref, worst, order: { market: m.id, clientOrderIndex: coi(), baseAmount: base, price: ticks(worst, m.priceDecimals, pos.side === 'short'), isAsk, type: ORDER_TYPE.market, timeInForce: TIF.ioc, reduceOnly: 1 as const, triggerPrice: 0n, orderExpiry: 0 } };
}

/** SL / TP set on an OPEN position (perps.trigger, 2026-10-22): the limit behind the trigger sits this far through it, so
 *  the close fills when the mark gets there (the same TP_LIMIT / SL_LIMIT pattern as open()'s children). Engine-fixed. */
export const TRIGGER_SLIP_BPS = 100;
/** A trigger more than this factor away from the mark (either way) is refused as a typo, not a strategy. */
export const TRIGGER_BAND = 10;
export type TriggerKind = 'sl' | 'tp';
/**
 * A reduce-only SL / TP for an open position, from the vault's OWN reads (Lighter's account read for the position and its
 * side, the market's mark). The side is the position's, never the page's: a long closes with a sell (isAsk 1), a short
 * with a buy. The trigger must be on the right side of the mark — SL below it for a long / above for a short, TP the
 * opposite — and within TRIGGER_BAND of it. `sizeShare` 100 = the whole position (base 0: Lighter's position-tied
 * trigger, which follows the position as it grows or shrinks and is cancelled when it closes or flips); less = that share
 * of today's size (at least Lighter's minimum order). Types and time in force are open()'s TP / SL children: TP_LIMIT /
 * SL_LIMIT, GTT 28 days, triggered on the mark, limit TRIGGER_SLIP_BPS through the trigger.
 */
export function buildTrigger(m: Market, pos: { size: bigint; side: Side }, kind: TriggerKind, trigger: number, sizeShare: number, now: number, coi: () => number = clientOrderIndex) {
  const errors: string[] = [];
  const mark = m.mark || m.last;
  if (!(mark > 0)) throw new Error('No price for this market right now');
  if (!m.active) errors.push(`${m.symbol} is not open for trading right now`);
  if (!(trigger > 0) || !Number.isFinite(trigger)) throw new Error('Bad trigger price');
  const long = pos.side === 'long';
  const t = ticks(trigger, m.priceDecimals, !long);
  const at = Number(decimal(t, m.priceDecimals));
  const markText = `$${Number(mark.toFixed(m.priceDecimals)).toLocaleString('en-US', { maximumFractionDigits: m.priceDecimals })}`;
  const name = kind === 'sl' ? 'A stop loss' : 'A take profit';
  // below the mark: a long's SL and a short's TP; above: a long's TP and a short's SL
  const below = (kind === 'sl') === long;
  if (below ? !(at < mark) : !(at > mark)) errors.push(`${name} for a ${pos.side} must be ${below ? 'below' : 'above'} the mark price (${markText}) — this one would trigger at once`);
  if (at < mark / TRIGGER_BAND || at > mark * TRIGGER_BAND) errors.push(`${name} more than ${TRIGGER_BAND}× away from the mark price (${markText}) is refused`);
  if (!(Number.isInteger(sizeShare) && sizeShare >= 1 && sizeShare <= 100)) throw new Error('Bad size share');
  if (pos.size <= 0n) throw new Error('No open position in this market');
  const base = sizeShare >= 100 ? 0n : (pos.size * BigInt(sizeShare)) / 100n;
  if (sizeShare < 100 && (base <= 0n || base < m.minBase)) errors.push(`${sizeShare} % of this position is under the smallest ${m.symbol} order (${decimal(m.minBase, m.sizeDecimals)} ${m.symbol}) — use a larger share`);
  const slip = TRIGGER_SLIP_BPS / 10000;
  const lim = long ? at * (1 - slip) : at * (1 + slip);
  const order = {
    market: m.id, clientOrderIndex: coi(), baseAmount: base, price: ticks(lim, m.priceDecimals, !long), isAsk: (long ? 1 : 0) as 0 | 1,
    type: kind === 'tp' ? ORDER_TYPE.takeProfitLimit : ORDER_TYPE.stopLossLimit, timeInForce: TIF.gtt, reduceOnly: 1 as const, triggerPrice: t, orderExpiry: now + 28 * DAY_MS,
  };
  return { order, trigger: at, limit: Number(decimal(order.price, m.priceDecimals)), base, mark, errors };
}
/** Lighter's order `type` text (accountActiveOrders) → which trigger kind it is (null: not a TP / SL). */
export function triggerKindOf(type: unknown): TriggerKind | null {
  const s = String(type || '').toLowerCase();
  return /^stop[-_ ]?loss/.test(s) ? 'sl' : /^take[-_ ]?profit/.test(s) ? 'tp' : null;
}

// ── when the vault asks ──
export type ConfirmReason = 'setup' | 'deposit' | 'leverage' | 'cap';
/** Owner rules (2026-10-22): the first-time setup, every deposit and withdrawal, an order at ≥ 20x or above the
 *  per-wallet notional cap ask in the vault's own dialog; a normal order is one tap, like a spot trade. */
export function confirmReasons(o: { setup: boolean; deposit: boolean; leverage: number; notional: number; cap: number; hourly?: number }): ConfirmReason[] {
  const r: ConfirmReason[] = [];
  if (o.setup) r.push('setup');
  if (o.deposit) r.push('deposit');
  if (o.leverage >= LEVERAGE_CONFIRM) r.push('leverage');
  // one order above the cap, or this wallet's orders of the last hour adding up past HOURLY_CAP
  if (o.notional > o.cap || (o.hourly ?? 0) + o.notional > HOURLY_CAP) r.push('cap');
  return r;
}
/** What the perps balance needs before an order: its initial margin plus a cushion for the price moving while the money
 *  arrives (the slippage, at least 1 %) and a few cents; rounded up to whole cents; Lighter's 1 USDG minimum. */
export function marginNeed(notional: number, leverage: number, slippageBps: number, available: number): { need: number; deposit: bigint } {
  const need = notional / leverage + notional * Math.max(0.01, slippageBps / 10000) + 0.05;
  const short = need - Math.max(0, available);
  if (short <= 0) return { need, deposit: 0n };
  const cents = BigInt(Math.ceil(short * 100));
  const dep = cents * 10_000n;
  return { need, deposit: dep < MIN_DEPOSIT ? MIN_DEPOSIT : dep };
}

// ── Lighter's answers ──
export type SendVerdict = { kind: 'ok'; hash: string } | { kind: 'nonce'; message: string } | { kind: 'key'; code: number; message: string } | { kind: 'region'; message: string } | { kind: 'refused'; code: number; message: string };
/** Lighter's refusals that mean "the key this tx was signed with is not the one at its slot" (apidocs "Data Structures,
 *  Constants and Errors"): 21120 AppErrInvalidSignature "invalid signature", 21108 AppErrInvalidPublicKey "invalid
 *  PublicKey,please run changePubKey", 21109 AppErrApiKeyNotFound "api key not found". An API-level refusal: nothing was
 *  executed and the nonce was not used. The engine then reads the slot (perpsEngine.ts withKey) — it never resends blindly. */
export const KEY_REFUSALS = Object.freeze([21120, 21108, 21109]);
/** POST /api/v1/sendTx → verdict. code 200 = accepted (NOT executed). An "invalid nonce" answer is a refusal that did not
 *  use the nonce (lighter-python hard-refreshes the nonce on it); anything else Lighter refuses is final for this tx. */
export function sendVerdict(j: unknown): SendVerdict {
  const o = (j && typeof j === 'object' ? j : {}) as { code?: unknown; message?: unknown; tx_hash?: unknown };
  const code = Number(o.code), message = String(o.message || '').slice(0, 300);
  // a tx hash goes into URLs later: only Lighter's 40-byte hex form is kept (else the signer's own hash is used)
  if (code === 200 && typeof o.tx_hash === 'string') { const h = o.tx_hash.replace(/^0x/, '').toLowerCase(); return { kind: 'ok', hash: /^[0-9a-f]{80}$/.test(h) ? h : '' }; }
  // L4: only Lighter's own "invalid nonce" (code 21104 / that text) — any other mention of a nonce is a plain refusal
  if (code === 21104 || /invalid nonce/i.test(message)) return { kind: 'nonce', message };
  if (KEY_REFUSALS.includes(code) || /^(invalid signature|invalid PublicKey,please run changePubKey|api key not found)$/i.test(message.trim())) return { kind: 'key', code: Number.isFinite(code) ? code : 0, message: message || 'invalid signature' };
  if (/restrict|region|country|jurisdiction|geo|not available in your/i.test(message) || code === 403) return { kind: 'region', message };
  return { kind: 'refused', code: Number.isFinite(code) ? code : 0, message: message || 'refused' };
}
export type Position = { market: number; symbol: string; side: Side; size: string; sizeUnits?: bigint; entry: string; value: string; pnl: string; liq: string; leverage: number; marginMode: 'cross' | 'isolated'; margin: string; funding: string; openOrders: number };
/** GET /api/v1/account?by=l1_address → our view (public data: collateral, positions, liquidation prices). */
export function accountView(j: unknown) {
  const a = ((j as { accounts?: unknown[] })?.accounts || [])[0] as Record<string, unknown> | undefined;
  if (!a) return null;
  const positions: Position[] = [];
  // the margin setting Lighter keeps per market once it was set (also for a market with no position now): an open at the
  // same leverage / mode skips its UpdateLeverage
  const settings: Record<number, { leverage: number; marginMode: 'cross' | 'isolated' }> = {};
  for (const p of (Array.isArray(a.positions) ? a.positions : []) as Record<string, unknown>[]) {
    const size = String(p.position || '0');
    const imf = Number(p.initial_margin_fraction);
    if (Number.isFinite(Number(p.market_id)) && imf > 0) settings[Number(p.market_id)] = { leverage: leverageOf(imf * 100), marginMode: Number(p.margin_mode) === 1 ? 'isolated' : 'cross' };
    if (!(Number(size) > 0)) continue;
    positions.push({
      market: Number(p.market_id), symbol: String(p.symbol || ''), side: Number(p.sign) < 0 ? 'short' : 'long', size, entry: String(p.avg_entry_price || '0'),
      value: String(p.position_value || '0'), pnl: String(p.unrealized_pnl || '0'), liq: String(p.liquidation_price || '0'),
      leverage: leverageOf(Number(p.initial_margin_fraction) * 100), marginMode: Number(p.margin_mode) === 1 ? 'isolated' : 'cross',
      margin: String(p.allocated_margin || '0'), funding: String(p.total_funding_paid_out || '0'), openOrders: Number(p.open_order_count) || 0,
    });
  }
  const collateral = Number(a.collateral) || 0, available = Number(a.available_balance) || 0;
  const total = Number(a.total_asset_value ?? a.collateral) || collateral;
  return { index: Number(a.index ?? a.account_index), l1: String(a.l1_address || ''), collateral, available, total, used: Math.max(0, total - available), positions, settings };
}
/**
 * GET /api/v1/tx?by=hash → 'executed' | 'pending' | 'failed' (+ what the order did, from event_info).
 * Lighter's tx status (apidocs "Transaction Status Mapping"): 0 failed, 1 pending, 2 EXECUTED, 3 pending – final state
 * (packed into a batch). 2 is the outcome; 3 comes seconds later (measured 2026-10-22 on RH: status 2 at the first read,
 * 3 often > 12 s later). Waiting for 3 was the 5–6 s "silent wait" after an order (owner's live test).
 */
export function txOutcome(j: unknown): { state: 'executed' | 'pending' | 'failed'; error?: string; filled?: bigint; size?: bigint; price?: number; orderIndex?: string } {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  if (Number(o.code) === 21500 || o.code == null) return { state: 'pending' };
  if (Number(o.code) !== 200) return { state: 'pending' };
  let ev: Record<string, unknown> = {};
  try { ev = JSON.parse(String(o.event_info || '{}')); } catch {}
  const err = typeof ev.ae === 'string' && ev.ae ? ev.ae : '';
  if (err) return { state: 'failed', error: err.slice(0, 200) };
  const st = Number(o.status);
  if (st === 0 && o.status != null && o.status !== '') return { state: 'failed', error: 'Lighter did not execute it' };
  if (st !== 2 && st !== 3) return { state: 'pending' };
  const to = (ev.to || null) as Record<string, unknown> | null;
  if (to && typeof to === 'object') {
    const size = BigInt(Math.max(0, Math.floor(Number(to.is) || 0))), rest = BigInt(Math.max(0, Math.floor(Number(to.rs) || 0)));
    const t = (ev.t || null) as Record<string, unknown> | null;
    return { state: 'executed', size, filled: size - rest, price: t ? Number(t.p) || 0 : 0, orderIndex: to.i != null ? String(to.i) : undefined };
  }
  return { state: 'executed' };
}

// ── nonces ──
/**
 * One counter per (account, API key): Lighter wants new = last + 1. Read once from GET /nextNonce, then counted here.
 * A transaction Lighter accepted moves it on; an "invalid nonce" refusal re-reads it (the refusal did not use the nonce);
 * a send whose answer was lost (unknown) drops the counter — the next transaction re-reads it, so if the lost one did
 * land its nonce is not reused, and if it did not, the next one takes its place (it can never land twice).
 */
export class NonceKeeper {
  private next = new Map<string, number>();
  private read: (account: number, apiKey: number) => Promise<number>;
  constructor(read: (account: number, apiKey: number) => Promise<number>) { this.read = read; }
  private k(a: number, i: number) { return a + ':' + i; }
  async take(account: number, apiKey: number): Promise<number> {
    const k = this.k(account, apiKey);
    if (!this.next.has(k)) { const n = await this.read(account, apiKey); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Bad nonce from Lighter'); this.next.set(k, n); }
    return this.next.get(k)!;
  }
  accepted(account: number, apiKey: number, used: number) { const k = this.k(account, apiKey); this.next.set(k, Math.max(used + 1, this.next.get(k) ?? 0)); }
  forget(account: number, apiKey: number) { this.next.delete(this.k(account, apiKey)); }
}

// ── the bridge arguments, checked here before anything runs (the same shapes as the app's native allow-list) ──
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const bad = (why: string): never => { throw new Error('Bad perps request: ' + why); };
// the same closed shapes as the app's native allow-list (motion-ios src/security/perpsContract.ts)
const WALLET = /^[\w:.-]{1,80}$/, IDEM = /^[A-Za-z0-9_.:-]{8,100}$/, AMOUNT = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/, PRICE = /^(0|[1-9]\d{0,14})(\.\d{1,10})?$/, FEE = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
function shape(v: unknown, allowed: string[], required: string[]): Obj {
  if (!isObj(v)) bad('expected one object');
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad('unknown field ' + k.slice(0, 20));
  for (const k of required) if (o[k] === undefined) bad('missing ' + k);
  if (typeof o.walletId !== 'string' || !WALLET.test(o.walletId)) bad('walletId');
  return o;
}
const int = (v: unknown, lo: number, hi: number, name: string) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(name));
const oneOf = <T extends string>(v: unknown, list: readonly T[], name: string): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : bad(name));
const amount = (v: unknown, name: string) => (typeof v === 'string' && AMOUNT.test(v) && Number(v) > 0 ? v : bad(name));
const trigger = (v: unknown, name: string) => (v === undefined ? undefined : isObj(v) && Object.keys(v).length === 1 && typeof v.trigger === 'string' && PRICE.test(v.trigger) && Number(v.trigger) > 0 ? { trigger: v.trigger } : bad(name));
const idem = (v: unknown) => (typeof v === 'string' && IDEM.test(v) ? v : bad('idempotencyKey'));
const ORDER_KEYS = ['walletId', 'market', 'side', 'type', 'sizeUsdg', 'price', 'slippageBps', 'leverage', 'marginMode', 'tp', 'sl'];
function orderArgs(o: Obj): OrderReq & { walletId: string } {
  const type = oneOf(o.type, ['market', 'limit'] as const, 'type');
  if (type === 'limit' ? !(typeof o.price === 'string' && PRICE.test(o.price) && Number(o.price) > 0) : o.price !== undefined) bad('price');
  return {
    walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), side: oneOf(o.side, ['long', 'short'] as const, 'side'), type,
    sizeUsdg: amount(o.sizeUsdg, 'sizeUsdg'), ...(type === 'limit' ? { price: o.price as string } : {}), slippageBps: int(o.slippageBps, 5, SLIP_MAX_BPS, 'slippageBps'),
    leverage: int(o.leverage, 1, 50, 'leverage'), marginMode: oneOf(o.marginMode, ['cross', 'isolated'] as const, 'marginMode'),
    ...(o.tp !== undefined ? { tp: trigger(o.tp, 'tp') } : {}), ...(o.sl !== undefined ? { sl: trigger(o.sl, 'sl') } : {}),
  };
}
export const args = {
  status: (v: unknown) => ({ walletId: shape(v, ['walletId'], ['walletId']).walletId as string }),
  setup: (v: unknown) => ({ walletId: shape(v, ['walletId'], ['walletId']).walletId as string }),
  claim: (v: unknown) => { const o = shape(v, ['walletId', 'idempotencyKey'], ['walletId']); return { walletId: o.walletId as string, ...(o.idempotencyKey !== undefined ? { idempotencyKey: idem(o.idempotencyKey) } : {}) }; },
  quote: (v: unknown) => orderArgs(shape(v, ORDER_KEYS, ['walletId', 'market', 'side', 'type', 'sizeUsdg', 'slippageBps', 'leverage', 'marginMode'])),
  open: (v: unknown) => { const o = shape(v, [...ORDER_KEYS, 'idempotencyKey'], ['walletId', 'market', 'side', 'type', 'sizeUsdg', 'slippageBps', 'leverage', 'marginMode', 'idempotencyKey']); return { ...orderArgs(o), idempotencyKey: idem(o.idempotencyKey) }; },
  close: (v: unknown) => {
    const o = shape(v, ['walletId', 'market', 'fraction', 'slippageBps', 'idempotencyKey'], ['walletId', 'market', 'fraction', 'slippageBps', 'idempotencyKey']);
    const f = o.fraction; if (!(typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 1)) bad('fraction');
    return { walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), fraction: f as number, slippageBps: int(o.slippageBps, 5, SLIP_MAX_BPS, 'slippageBps'), idempotencyKey: idem(o.idempotencyKey) };
  },
  cancel: (v: unknown) => {
    const o = shape(v, ['walletId', 'market', 'orderIndex'], ['walletId', 'market', 'orderIndex']);
    if (!(typeof o.orderIndex === 'string' && /^\d{1,20}$/.test(o.orderIndex))) bad('orderIndex');
    return { walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), orderIndex: o.orderIndex as string };
  },
  cancelAll: (v: unknown) => { const o = shape(v, ['walletId', 'market'], ['walletId', 'market']); return { walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market') }; },
  deposit: (v: unknown) => {
    const o = shape(v, ['walletId', 'amountUsdg', 'pay', 'idempotencyKey'], ['walletId', 'amountUsdg', 'pay', 'idempotencyKey']);
    return { walletId: o.walletId as string, amountUsdg: amount(o.amountUsdg, 'amountUsdg'), pay: oneOf(o.pay, ['auto', 'usdg', 'eth'] as const, 'pay'), idempotencyKey: idem(o.idempotencyKey) };
  },
  withdrawQuote: (v: unknown) => { const o = shape(v, ['walletId', 'amountUsdg'], ['walletId', 'amountUsdg']); return { walletId: o.walletId as string, amountUsdg: o.amountUsdg === 'max' ? 'max' as const : amount(o.amountUsdg, 'amountUsdg') }; },
  withdraw: (v: unknown) => {
    const o = shape(v, ['walletId', 'amountUsdg', 'speed', 'maxFeeUsdg', 'idempotencyKey'], ['walletId', 'amountUsdg', 'speed', 'idempotencyKey']);
    // B1: instant (fast) withdrawals are off until FAST_WITHDRAW_POOL is pinned
    const speed = oneOf(o.speed, (FAST_WITHDRAW_POOL == null ? ['standard'] : ['standard', 'fast']) as readonly ('standard' | 'fast')[], 'speed');
    // fast: the fee the user saw is the ceiling (required); standard is free (a fee given there is ignored)
    if (o.maxFeeUsdg !== undefined ? !(typeof o.maxFeeUsdg === 'string' && FEE.test(o.maxFeeUsdg)) : speed === 'fast') bad('maxFeeUsdg');
    return { walletId: o.walletId as string, amountUsdg: o.amountUsdg === 'max' ? 'max' as const : amount(o.amountUsdg, 'amountUsdg'), speed, ...(speed === 'fast' ? { maxFeeUsdg: o.maxFeeUsdg as string } : {}), idempotencyKey: idem(o.idempotencyKey) };
  },
  history: (v: unknown) => { const o = shape(v, ['walletId', 'kind', 'limit'], ['walletId', 'kind', 'limit']); return { walletId: o.walletId as string, kind: oneOf(o.kind, ['fills', 'funding'] as const, 'kind'), limit: int(o.limit, 1, 100, 'limit') }; },
  leverage: (v: unknown) => {
    const o = shape(v, ['walletId', 'market', 'leverage', 'marginMode', 'idempotencyKey'], ['walletId', 'market', 'leverage', 'marginMode']);
    return { walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), leverage: int(o.leverage, 1, 50, 'leverage'), marginMode: oneOf(o.marginMode, ['cross', 'isolated'] as const, 'marginMode'), ...(o.idempotencyKey !== undefined ? { idempotencyKey: idem(o.idempotencyKey) } : {}) };
  },
  margin: (v: unknown) => {
    const o = shape(v, ['walletId', 'market', 'direction', 'amountUsdg', 'idempotencyKey'], ['walletId', 'market', 'direction', 'amountUsdg']);
    return { walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), direction: oneOf(o.direction, ['add', 'remove'] as const, 'direction'), amountUsdg: amount(o.amountUsdg, 'amountUsdg'), ...(o.idempotencyKey !== undefined ? { idempotencyKey: idem(o.idempotencyKey) } : {}) };
  },
  /** SL / TP on an open position: no side (the position's), no size in units (a share of it), no destination */
  trigger: (v: unknown) => {
    const o = shape(v, ['walletId', 'market', 'kind', 'triggerPrice', 'sizeShare', 'replace', 'idempotencyKey'], ['walletId', 'market', 'kind', 'triggerPrice', 'idempotencyKey']);
    if (!(typeof o.triggerPrice === 'string' && PRICE.test(o.triggerPrice) && Number(o.triggerPrice) > 0)) bad('triggerPrice');
    if (o.replace !== undefined && !(typeof o.replace === 'string' && /^\d{1,20}$/.test(o.replace))) bad('replace');
    return {
      walletId: o.walletId as string, market: int(o.market, 0, 4095, 'market'), kind: oneOf(o.kind, ['sl', 'tp'] as const, 'kind'), triggerPrice: o.triggerPrice as string,
      sizeShare: o.sizeShare === undefined ? 100 : int(o.sizeShare, 1, 100, 'sizeShare'), ...(o.replace !== undefined ? { replace: o.replace as string } : {}), idempotencyKey: idem(o.idempotencyKey),
    };
  },
};
/** TrenchBridge method name → engine method (perps.<x>) — also the list bridge.js, app-bridge.js and the app's native lanes open. */
export const BRIDGE_METHODS = Object.freeze({
  perpsStatus: 'status', perpsQuote: 'quote', perpsOpen: 'open', perpsClose: 'close', perpsCancel: 'cancel', perpsCancelAll: 'cancelAll', perpsDeposit: 'deposit',
  perpsWithdrawQuote: 'withdrawQuote', perpsWithdraw: 'withdraw', perpsClaim: 'claim', perpsHistory: 'history', perpsSetup: 'setup', perpsLeverage: 'leverage', perpsMargin: 'margin',
  perpsTrigger: 'trigger',
} as const);
