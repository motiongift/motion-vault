// V13 hardening (security audit 2026-10-25, VA-1 … VA-9): the decisions the engine makes before it signs, as pure
// functions. No browser globals and no network: the tests in test/v13-*.mjs import this file and exercise exactly the
// predicates webEngine.ts / solEngine.ts call. Nothing here adds a round trip; the callers keep their reads parallel.

// ── VA-2: trade sizes ──
// A size from the page is checked BEFORE anything is recorded or asked: finite, positive, not above the lane's ceiling.
// `buy(t, -1e300)` used to write a hugely negative entry into the hourly ledger and zero it for an hour.
export const MAX_BUY: Record<string, number> = { robinhood: 100, bsc: 100, sol: 10_000, near: 1_000_000 };
export function tradeSizeProblem(side: 'buy' | 'sell', size: unknown, maxBuy: number): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 'Amount out of range';
  if (side === 'buy') return size > 0 && size <= maxBuy ? null : 'Amount out of range';
  return size > 0 && size <= 100 ? null : 'Sell percent out of range';
}

// ── VA-2: the rolling one-hour buy ledger ──
// Entries are clamped to ≥ 0 (a stored negative or non-finite amount counts as 0) and pruned by AGE only. Above
// LEDGER_MAX entries the oldest are folded into one entry that keeps their sum and the newest of their timestamps, so
// 500 calls of `buy(t, 0)` (or of any size) can no longer push real spending out of the window: the total only grows.
export const BUY_WINDOW_MS = 60 * 60_000;
export const LEDGER_MAX = 500;
const amt = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
export function ledgerAdd(prev: unknown, now: number, total: number): { entries: [number, number][]; sum: number } {
  const list: [number, number][] = (Array.isArray(prev) ? prev : [])
    .filter((e): e is [unknown, unknown] => Array.isArray(e) && e.length >= 2)
    .map((e) => [Number(e[0]), amt(e[1])] as [number, number])
    .filter(([t]) => Number.isFinite(t) && now - t < BUY_WINDOW_MS && t <= now + 60_000);
  list.push([now, amt(total)]);
  let entries = list;
  if (entries.length > LEDGER_MAX) {
    const fold = entries.slice(0, entries.length - LEDGER_MAX + 1);
    const folded: [number, number] = [Math.max(...fold.map(([t]) => t)), fold.reduce((s, [, a]) => s + a, 0)];
    entries = [folded, ...entries.slice(entries.length - LEDGER_MAX + 1)];
  }
  return { entries, sum: entries.reduce((s, [, a]) => s + a, 0) };
}

// ── VA-1 (small variant): slippage a page may set without a click ──
// Lowering is always free; raising is free up to SLIP_SILENT (or a level the user already confirmed in the vault).
// Above that, settingsSet asks in the vault's own dialog, and a stored value above it asks once at trade time.
export const SLIP_SILENT = 15;
export const slipCeiling = (confirmed: unknown) => Math.max(SLIP_SILENT, Number(confirmed) || 0);
export const slipNeedsClick = (want: number, confirmed: unknown) => Number.isFinite(want) && want > slipCeiling(confirmed);

// ── VA-1: the route the vault fetched itself vs the page's hint ──
// One canonical form of a route object: keys sorted, strings lower-cased (every route field the engine reads is an
// address, a hex word, a venue name or a number), so the page's copy of the same /route answer compares equal.
export function routeSig(route: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return typeof v === 'string' ? v.toLowerCase() : v;
  };
  return JSON.stringify(norm(route));
}
export const sameRoute = (a: unknown, b: unknown) => !!a && !!b && routeSig(a) === routeSig(b);

// What the engine may sign when the vault could NOT read the route itself (motion's server unreachable from the
// frame): only a hint whose pool no page can choose. A launchpad curve or Standard is fixed by its registry; a V4 /
// Infinity pool on the gas token or its wrapped form is compared on chain against the standard tiers (pickPool); a
// V2 path through known assets names canonical pairs. Bridge legs (fee tiers the page names), V3 tiers and V4 / V2
// routes through other assets are refused until the vault's own read agrees.
type RouteLike = { type: string; pair?: string; path?: string[]; bridgeHops?: string[]; bridgeFee?: number; poolKey?: { hooks?: string } | null };
export function selfCanonical(route: RouteLike, known: { hooks: Set<string>; bridgeTokens: Set<string> }, token: string): boolean {
  const bridged = !!(route.bridgeHops && route.bridgeHops.length) || !!route.bridgeFee;
  if (bridged) return false;
  switch (route.type) {
    case 'pons': case 'four': case 'flap': case 'standard': return true;
    case 'v4': case 'inf': return route.pair === 'native' || route.pair === 'weth';
    case 'v2': return !!route.path?.length && v2UnknownHops(route.path, known.bridgeTokens, token).length === 0;
    default: return false;
  }
}

// ── VA-1: V2 hops ──
// The intermediate assets of a V2 path that are not on the chain's bridge list (the path's ends are the gas token and
// the coin). A sell through an unknown asset is refused without a vault dialog: an attacker's WBNB/X and X/coin pairs
// are a pool of its choosing.
export function v2UnknownHops(path: string[], bridgeTokens: Set<string>, token: string): string[] {
  const mid = path.slice(1, -1).map((h) => String(h).toLowerCase());
  return mid.filter((h) => h !== token.toLowerCase() && !bridgeTokens.has(h));
}

// ── VA-1: hookless V4 / Infinity pools are compared against the standard tiers ──
// Anyone can initialise a hookless pool of any coin against the gas token at any fee, with dust at an absurd price.
// The candidates are the hookless pools of the same coin against the gas token AND its wrapped form at the standard
// fee / tick-spacing pairs; they are quoted in the SAME multicall as the hinted pool (one round trip, as before).
export const V4_TIERS: [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
export const INF_TIERS: [number, number][] = [[100, 1], [500, 10], [2500, 50], [10000, 200]];
const ZERO = '0x0000000000000000000000000000000000000000';
const sortPair = (a: string, b: string): [string, string] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
export type V4Key = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
export type InfKey = { currency0: string; currency1: string; hooks: string; poolManager: string; fee: number; parameters: string };
export const infParameters = (tickSpacing: number) => ('0x' + (BigInt(tickSpacing) << 16n).toString(16).padStart(64, '0')) as `0x${string}`;
export const infTickSpacing = (parameters: string) => Number((BigInt(parameters) >> 16n) & 0xffffffn);
export function v4Candidates(token: string, wrapped: string): { key: V4Key; pair: 'native' | 'weth' }[] {
  const out: { key: V4Key; pair: 'native' | 'weth' }[] = [];
  for (const [quote, pair] of [[ZERO, 'native'], [wrapped.toLowerCase(), 'weth']] as const) {
    const [c0, c1] = sortPair(quote, token.toLowerCase());
    for (const [fee, tickSpacing] of V4_TIERS) out.push({ key: { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ZERO }, pair });
  }
  return out;
}
export function infCandidates(token: string, wrapped: string, poolManager: string): { key: InfKey; pair: 'native' | 'weth' }[] {
  const out: { key: InfKey; pair: 'native' | 'weth' }[] = [];
  for (const [quote, pair] of [[ZERO, 'native'], [wrapped.toLowerCase(), 'weth']] as const) {
    const [c0, c1] = sortPair(quote, token.toLowerCase());
    for (const [fee, ts] of INF_TIERS) out.push({ key: { currency0: c0, currency1: c1, hooks: ZERO, poolManager: poolManager.toLowerCase(), fee, parameters: infParameters(ts) }, pair });
  }
  return out;
}
export const sameKey = (a: object, b: object) => routeSig(a) === routeSig(b);
// The engine's choice among the hinted pool and the candidates, all quoted for this exact amount. The hint stands when
// it pays at least 98 % of the best candidate; otherwise the trade goes through the best candidate (the engine chooses
// the pool, the page's hint was only a candidate). `null` outputs are pools that do not exist or did not quote. When
// nothing could be compared at all (the hint itself did not quote), the caller refuses: fail closed.
export const POOL_TOLERANCE_BPS = 200n;
export function pickPool<K>(hint: { key: K; out: bigint | null }, cands: { key: K; pair: string; out: bigint | null }[]): { use: 'hint' } | { use: 'candidate'; key: K; pair: string; out: bigint } | { use: 'refuse' } {
  let best: { key: K; pair: string; out: bigint } | null = null;
  for (const c of cands) if (c.out != null && c.out > 0n && (!best || c.out > best.out)) best = { key: c.key, pair: c.pair, out: c.out };
  if (hint.out == null || hint.out <= 0n) return best ? { use: 'candidate', ...best } : { use: 'refuse' };
  if (!best || hint.out * 10_000n >= best.out * (10_000n - POOL_TOLERANCE_BPS)) return { use: 'hint' };
  return { use: 'candidate', ...best };
}

// ── VA-3: the Relay quote the vault signs ──
// The vault asks api.relay.link itself (the app fee passed as explicit parameters) and signs only that request id;
// the answer must name the depositor, the recipient, the chains and the amount the user confirmed.
export const BRIDGE_APP_FEE = { recipient: '0xaBA747718975a4d0a25EcB0Ac5Ebe609A6c340ad', bps: 50 } as const;
export function relayQuoteProblem(j: any, want: { user: string; recipient: string; originChainId: number; destinationChainId: number; amount: string; evm: (chainId: number) => boolean }): string | null {
  if (!j || typeof j !== 'object') return 'no quote';
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(j.requestId || ''))) return 'no request id';
  const item = Array.isArray(j.steps) ? j.steps.find((s: any) => s?.kind === 'transaction')?.items?.[0] : null;
  const step = item?.data;
  const evmOrigin = want.evm(want.originChainId);
  if (!step || (evmOrigin ? !step.to : !Array.isArray(step.instructions))) return 'no deposit step';
  if (evmOrigin && Number(step.chainId) !== Number(want.originChainId)) return 'the deposit is on another chain';
  const d = j.details || {};
  const eq = (a: unknown, b: string, chainId: number) => (want.evm(chainId) ? String(a || '').toLowerCase() === b.toLowerCase() : String(a || '') === b);
  if (!eq(d.sender, want.user, want.originChainId)) return 'the quote names another depositor';
  if (!eq(d.recipient, want.recipient, want.destinationChainId)) return 'the quote pays another recipient';
  if (String(d.currencyIn?.amount ?? '') !== String(want.amount)) return 'the quote moves another amount';
  if (Number(d.currencyIn?.currency?.chainId) !== Number(want.originChainId) || Number(d.currencyOut?.currency?.chainId) !== Number(want.destinationChainId)) return 'the quote is for other chains';
  if (evmOrigin && step.value != null && BigInt(String(step.value)) !== BigInt(String(want.amount))) return 'the deposit value is not the amount';
  return null;
}

// ── VA-5: trusted clicks outside Chromium ──
// Where IntersectionObserver v2 (`isVisible`) is missing (Safari / iPhone, Firefox) the frame cannot tell that a page
// made it transparent over a decoy. A danger dialog there asks for a short code that is drawn only inside the frame
// (a page cannot read a cross-origin frame, so a decoy cannot tell the user what to type), and every dialog refuses a
// click that comes sooner than MIN_DWELL_MS after it was drawn.
export const MIN_DWELL_MS = 600;
export const needsChallenge = (host: boolean, ioV2: boolean, danger: boolean) => host && !ioV2 && danger;
export const challengeCode = (rand: Uint8Array) => String(((rand[0] << 8) | rand[1]) % 900 + 100);
export const challengeOk = (typed: unknown, code: string) => String(typed ?? '').replace(/\s+/g, '') === code;
export const tooSoon = (openedAt: number, now: number) => now - openedAt < MIN_DWELL_MS;
