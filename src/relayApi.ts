// Relay's quote for the vault, with or without Relay's API key in reach (2026-10-29; owner: “approved”).
//
// Up to now every Relay quote the vault signs is one it fetched from api.relay.link ITSELF, keyless (V13 VA-3). Relay's
// docs say every quote/v2 request needs an API key "starting October 2, 2026"; keyless quotes still answered on
// 2026-10-29, but when Relay enforces it every bridge breaks. The key is a server secret (Relay: "never expose it in
// client-side or frontend code"; there is no browser-safe key type), and the vault runs in users' browsers, so the key
// never comes here. Instead:
//   1. keyless first, exactly as before (source 'relay': the vault's own, server-independent quote);
//   2. (OFF since 2026-11-01, see MOTION_QUOTE_REFUSED below: a key refusal is now a refusal) only when Relay refuses for
//      want of a key (401 / UNAUTHORIZED_QUOTE / "api key"), the same body goes to
//      motion's own pass-through (`POST <page origin>/api/bridge/vault-quote`, which adds the key) — source 'motion'.
// A 'motion' quote is treated as coming from a party that may lie, and is held to checks that do not depend on it:
// the deposit goes only to Relay's pinned depository (EVM) / pinned programs (Solana), exact amounts, this wallet as the
// depositor, the chains and coins asked for, and what it pays must stand against Relay's own keyless price (or Relay's
// keyless token prices). See local relay-swap/VAULT-PROPOSAL.md (threat model) for what that does and does not cover.
import { BRIDGE_APP_FEE } from './v13Guards.ts';

export const RELAY_API = 'https://api.relay.link';
export const RELAY_SOL = 792703809;
export const NATIVE_EVM = '0x0000000000000000000000000000000000000000';
export const NATIVE_SOL = '11111111111111111111111111111111';
// Relay Depository v2 — the same address on every EVM chain the vault bridges (api.relay.link/chains → protocol.v2.depository,
// read 2026-10-29 for 1, 10, 56, 137, 4663, 5042, 8453, 42161, 43114). Native deposits call depositNative(depositor, id)
// 0x49290c1c, ERC-20 deposits depositErc20(depositor, token, amount, id) 0xe8017952 after an exact approve to it.
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const SEL_DEPOSIT_NATIVE = '0x49290c1c', SEL_DEPOSIT_ERC20 = '0xe8017952', SEL_APPROVE = '0x095ea7b3';
// Solana programs a Relay deposit may use (Relay's quotes, 2026-10-29): its depository (99vQ…, vault 7uTT…) for SOL, its
// deposit program (DPArt…) after a Jupiter leg for a token, the token / associated-account / memo / budget programs.
export const RELAY_SOL_DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const RELAY_SOL_DEPOSIT_PROGRAM = 'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr';
export const RELAY_SOL_VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
export const SOL_PROGRAMS = new Set([
  RELAY_SOL_DEPOSITORY, RELAY_SOL_DEPOSIT_PROGRAM,
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',          // Jupiter v6
  '11111111111111111111111111111111',                     // System
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);
export type QuoteSource = 'relay' | 'motion';
export type RelayBody = { user: string; recipient: string; originChainId: number; destinationChainId: number; originCurrency: string; destinationCurrency: string; amount: string; tradeType: 'EXACT_INPUT'; appFees: { recipient: string; fee: string }[]; slippageTolerance?: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;   // a string URL each time (the float hands its own deps.fetch)

// the page's origin (the vault frame's parent that greeted it): where motion's pass-through lives; '' = none (no fallback)
let proxyBase: () => string = () => '';
export function setRelayProxyBase(fn: () => string) { proxyBase = fn; }
export const appFees = () => (BRIDGE_APP_FEE.bps > 0 ? [{ recipient: BRIDGE_APP_FEE.recipient, fee: String(BRIDGE_APP_FEE.bps) }] : []);
export const relayBody = (b: Omit<RelayBody, 'tradeType' | 'appFees'>): RelayBody => ({ ...b, tradeType: 'EXACT_INPUT', appFees: appFees() });
// Relay refused because no key came with the request (its 401 UNAUTHORIZED_QUOTE, or a message naming the key). A bare 403
// (a Cloudflare / WAF page with no Relay error) is NOT a key refusal (audit 2026-11-01 vault-security-relay-recipient).
export const keyRefused = (status: number, j: any) => status === 401 || /UNAUTHORIZED|API[_ ]?KEY|x-api-key/i.test(`${j?.errorCode || ''} ${j?.message || ''}`);

// (audit 2026-11-01, vault-security-relay-recipient; owner's rule “we can never lose users' money, strictly”) A Relay
// deposit pays out to the recipient in Relay's record for the request id; the calldata carries only the depositor and the
// id. Relay has no keyless read of that record before the deposit (requests/v2?id= is empty until a deposit, intents/status
// says only 'waiting', requests/v3 wants the key — checked 2026-11-01). So for a quote that came through motion's keyed
// pass-through, every recipient check reads the server's own JSON: a lying server could hand over a real quote it made with
// its own address as recipient. The vault therefore signs ONLY its own keyless quotes: when Relay wants a key, the quote is
// refused (the USD balance falls over to deBridge / motion's signed bridge; a user bridge / swap says why). The pass-through
// stays reachable only through `viaMotion: true`, which no caller sets; turn it back on only when Relay offers a keyless,
// pre-deposit read of the request's recipient that the vault checks itself.
export const MOTION_QUOTE_REFUSED = "Relay now wants its API key for this quote, and a quote relayed by motion's server cannot be checked for where it pays out — nothing was sent";
export async function relayQuote(body: RelayBody, f: Fetch = fetch, opts: { viaMotion?: boolean } = {}): Promise<{ j: any; source: QuoteSource }> {
  const r = await f(`${RELAY_API}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => null);
  if (r.ok && j?.steps) return { j, source: 'relay' };
  const base = proxyBase();
  if (keyRefused(r.status, j) && opts.viaMotion !== true) throw new Error('Relay: ' + MOTION_QUOTE_REFUSED);
  if (!keyRefused(r.status, j) || !/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) throw new Error('Relay: ' + (j?.message || 'no quote for this route'));
  // text/plain keeps it a simple request (no preflight), like the 2FA check; the server answers Relay's JSON as is
  const p = await f(`${base}/api/bridge/vault-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(25000) });
  const pj = await p.json().catch(() => null);
  if (!p.ok || !pj?.steps) throw new Error('Relay (through motion): ' + (pj?.message || pj?.error || 'no quote for this route'));
  return { j: pj, source: 'motion' };
}

// ── reads the USD balance makes (2026-10-29, owner: “USD balance: move its Relay requests to the keyed scheme … do that too”) ──
// A request's status: intents/status/v3 takes the key as OPTIONAL (Relay's docs: "Optional API key for authentication and
// higher rate limits"), so it stays keyless and direct — what says a move landed never comes through motion. v2 is the
// fallback while it answers.
export async function relayStatus(requestId: string, f: Fetch = fetch): Promise<{ status: string } | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) return null;
  for (const v of ['v3', 'v2']) {
    try {
      const r = await f(`${RELAY_API}/intents/status/${v}?requestId=${requestId}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j.status === 'string') return { status: j.status };
    } catch { /* the other version */ }
  }
  return null;
}
// A wallet's recent Relay requests (the "another device started this move" check): keyless requests/v2 while Relay keeps it
// (it retires 2026-11-24; v3 needs the key), else motion's keyed read-only pass-through `GET <page origin>/api/bridge/
// vault-requests` (requests/v3). Only rows that name this wallet as `user` count — a lying pass-through can at worst defer a
// move (a row it invents for this wallet) or hide one; it can never move funds or mark anything as landed.
export async function relayRequestsOf(user: string, f: Fetch = fetch): Promise<{ requests: any[]; source: QuoteSource }> {
  const mine = (j: any) => (Array.isArray(j?.requests) ? j.requests.filter((q: any) => String(q?.user || '').toLowerCase() === user.toLowerCase()) : null);
  let status = 0, j: any = null;
  try {
    const r = await f(`${RELAY_API}/requests/v2?user=${user}&limit=5`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    status = r.status; j = await r.json().catch(() => null);
    const list = mine(j); if (r.ok && list) return { requests: list, source: 'relay' };
  } catch { /* the pass-through */ }
  const base = proxyBase();
  if (!(status === 0 || status >= 400 || keyRefused(status, j)) || !/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) throw new Error('Relay: no request list');
  const p = await f(`${base}/api/bridge/vault-requests?user=${user}&limit=5`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  const pj = await p.json().catch(() => null), list = mine(pj);
  if (!p.ok || !list) throw new Error('Relay (through motion): no request list');
  return { requests: list, source: 'motion' };
}

// ── independent price for a quote that came through motion ──
// Relay's keyless /price (an indicative quote: no steps, no request id) for the same body; if Relay keys that too, its
// keyless per-token USD prices. null = nothing independent to compare with → the caller refuses.
export async function independentOut(body: RelayBody, inDecimals: number, f: Fetch = fetch): Promise<{ out: bigint } | { usdIn: number; pOut: number } | null> {
  try {
    const r = await f(`${RELAY_API}/price`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => null);
    const raw = String(j?.details?.currencyOut?.amount ?? '');
    if (r.ok && /^\d{1,60}$/.test(raw)) return { out: BigInt(raw) };
  } catch { /* next source */ }
  try {
    const price = async (chainId: number, address: string) => { const r = await f(`${RELAY_API}/currencies/token/price?address=${encodeURIComponent(address)}&chainId=${chainId}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) }); const j = await r.json().catch(() => null); const p = Number(j?.price); return r.ok && p > 0 && isFinite(p) ? p : 0; };
    const [pIn, pOut] = await Promise.all([price(body.originChainId, body.originCurrency), price(body.destinationChainId, body.destinationCurrency)]);
    if (pIn && pOut) return { usdIn: (Number(body.amount) / 10 ** inDecimals) * pIn, pOut };
  } catch { /* nothing independent */ }
  return null;
}
// what a 'motion' quote pays must stand against the independent reading: ≥ 97 % of Relay's own keyless price for the same
// route, or (USD fallback) ≥ 85 % of the input's value (fees + price impact; a memecoin can cost that much — the dialog
// shows the amount either way)
export const PRICE_FLOOR_PCT = 97n, USD_FLOOR = 0.85;
export function priceProblem(out: bigint, outDecimals: number, ref: Awaited<ReturnType<typeof independentOut>>): string | null {
  if (!ref) return 'no independent Relay price to check the quote against — try again';
  if ('out' in ref) return out * 100n < ref.out * PRICE_FLOOR_PCT ? 'it pays less than Relay\'s own price for this route' : null;
  const usdOut = (Number(out) / 10 ** outDecimals) * ref.pOut;
  return usdOut < ref.usdIn * USD_FLOOR ? 'it pays far less than the coins are worth' : null;
}

// ── the quote's own claims (details), the same for every source ──
const eqAddr = (a: unknown, b: string, chainId: number) => (chainId === RELAY_SOL ? String(a ?? '') === b : String(a ?? '').toLowerCase() === b.toLowerCase());
export function detailsProblem(j: any, want: { user: string; recipient: string; originChainId: number; destinationChainId: number; originCurrency: string; destinationCurrency: string; amount: string }): string | null {
  if (!j || typeof j !== 'object') return 'no quote';
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(j.requestId || ''))) return 'no request id';
  const d = j.details || {}, ci = d.currencyIn || {}, co = d.currencyOut || {};
  if (!eqAddr(d.sender, want.user, want.originChainId)) return 'the quote names another depositor';
  if (!eqAddr(d.recipient, want.recipient, want.destinationChainId)) return 'the quote pays another recipient';
  if (String(ci.amount ?? '') !== String(want.amount)) return 'the quote moves another amount';
  if (Number(ci.currency?.chainId) !== Number(want.originChainId) || Number(co.currency?.chainId) !== Number(want.destinationChainId)) return 'the quote is for other chains';
  if (!eqAddr(ci.currency?.address, want.originCurrency, want.originChainId)) return 'the quote spends another coin';
  if (!eqAddr(co.currency?.address, want.destinationCurrency, want.destinationChainId)) return 'the quote pays another coin';
  if (!/^\d{1,60}$/.test(String(co.amount ?? '')) || BigInt(String(co.amount)) <= 0n) return 'the quote pays nothing';
  return null;
}

// ── the steps the vault will sign ──
const hex = (s: unknown) => String(s ?? '').toLowerCase();
const word = (data: string, i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
const wordAddr = (data: string, i: number) => '0x' + word(data, i).slice(24);
const wordInt = (data: string, i: number) => { const w = word(data, i); return /^[0-9a-f]{64}$/.test(w) ? BigInt('0x' + w) : -1n; };
export type EvmStep = { to: string; data: string; value: string; chainId: number; gas?: string };
// EVM: an optional exact approve of the origin token to Relay's depository, then one deposit into that depository naming
// this wallet; nothing else (a native POL / AVAX bridge through Relay's router stays possible only on the keyless path, where
// bridgeEngine compares it with Relay's own second quote).
export function evmStepsProblem(j: any, want: { user: string; originChainId: number; originCurrency: string; amount: string }): { problem: string } | { approve: EvmStep | null; deposit: EvmStep } {
  const steps = (Array.isArray(j?.steps) ? j.steps : []).filter((s: any) => Array.isArray(s?.items) && s.items.length);
  const ids = steps.map((s: any) => String(s.id || ''));
  const native = want.originCurrency.toLowerCase() === NATIVE_EVM;
  if (!(native ? ids.join() === 'deposit' : ids.join() === 'approve,deposit' || ids.join() === 'deposit')) return { problem: `unexpected steps (${ids.join(', ') || 'none'})` };
  if (steps.some((s: any) => s.kind !== 'transaction' || s.items.length !== 1)) return { problem: 'a step is not one transaction' };
  const data = (s: any): EvmStep => s.items[0].data || {};
  const dep = data(steps[steps.length - 1]), ap = ids[0] === 'approve' ? data(steps[0]) : null;
  const me = want.user.toLowerCase().slice(2);
  for (const t of [dep, ap]) if (t && Number(t.chainId) !== Number(want.originChainId)) return { problem: 'a step is on another chain' };
  if (hex(dep.to) !== RELAY_DEPOSITORY) return { problem: 'the deposit does not go to Relay\'s depository' };
  const dd = hex(dep.data);
  if (native) {
    if (!dd.startsWith(SEL_DEPOSIT_NATIVE) || wordAddr(dd, 0) !== '0x' + me) return { problem: 'the deposit does not name this wallet' };
    if (BigInt(String(dep.value ?? '-1')) !== BigInt(want.amount)) return { problem: 'the deposit value is not the amount' };
  } else {
    if (!dd.startsWith(SEL_DEPOSIT_ERC20) || wordAddr(dd, 0) !== '0x' + me) return { problem: 'the deposit does not name this wallet' };
    if (wordAddr(dd, 1) !== want.originCurrency.toLowerCase()) return { problem: 'the deposit names another coin' };
    if (wordInt(dd, 2) !== BigInt(want.amount)) return { problem: 'the deposit is not the amount' };
    if (BigInt(String(dep.value ?? '0')) !== 0n) return { problem: 'the deposit carries native coin' };
    if (ap) {
      const ad = hex(ap.data);
      if (hex(ap.to) !== want.originCurrency.toLowerCase()) return { problem: 'the approval is for another coin' };
      if (!ad.startsWith(SEL_APPROVE) || ad.length !== 10 + 128) return { problem: 'the approval is not a plain approve' };
      if (wordAddr(ad, 0) !== RELAY_DEPOSITORY) return { problem: 'the approval is not to Relay\'s depository' };
      if (wordInt(ad, 1) !== BigInt(want.amount)) return { problem: 'the approval is not exactly the amount' };
      if (BigInt(String(ap.value ?? '0')) !== 0n) return { problem: 'the approval carries native coin' };
    }
  }
  return { approve: ap, deposit: dep };
}
export type SolIxJ = { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
// Solana: one deposit transaction; every program allow-listed; this wallet the only signer; Relay's depository vault in it
export function solStepsProblem(j: any, user: string): { problem: string } | { ixs: SolIxJ[]; tables: string[] } {
  const steps = (Array.isArray(j?.steps) ? j.steps : []).filter((s: any) => Array.isArray(s?.items) && s.items.length);
  if (steps.length !== 1 || steps[0].id !== 'deposit' || steps[0].kind !== 'transaction' || steps[0].items.length !== 1) return { problem: 'unexpected steps' };
  const d = steps[0].items[0].data || {};
  const ixs: SolIxJ[] = Array.isArray(d.instructions) ? d.instructions : [];
  const tables: string[] = Array.isArray(d.addressLookupTableAddresses) ? d.addressLookupTableAddresses.map(String) : [];
  if (!ixs.length || ixs.length > 12 || tables.length > 6) return { problem: 'no deposit, or too many instructions' };
  for (const ix of ixs) {
    if (!SOL_PROGRAMS.has(String(ix?.programId))) return { problem: `an instruction calls a program that is not Relay's or a standard one (${String(ix?.programId).slice(0, 8)}…)` };
    if (!Array.isArray(ix.keys) || typeof ix.data !== 'string') return { problem: 'a malformed instruction' };
    if (ix.keys.some((k) => k?.isSigner && k.pubkey !== user)) return { problem: 'a signer other than this wallet' };
  }
  if (!ixs.some((ix) => ix.programId === RELAY_SOL_DEPOSITORY || ix.programId === RELAY_SOL_DEPOSIT_PROGRAM)) return { problem: 'no deposit into Relay\'s depository' };
  if (!ixs.some((ix) => ix.keys.some((k) => k.pubkey === RELAY_SOL_VAULT))) return { problem: 'the deposit does not reach Relay\'s depository vault' };
  return { ixs, tables };
}
