// motion's own bridge — the VAULT side (design: trench docs/drafts/MOTION-BRIDGE.md; the pure rules:
// src/motionBridgeCore.ts). It is one more bridge for the float engine, tried before Relay when the amount fits and the
// solver is healthy; everything it does happens in the background, never between a click and its send.
//
// What this module may do: ask motion's solver for a signed quote, check that signature against the key PINNED in the
// engine, check the quote against what we asked for and against OUR OWN on-chain price, sign ONE transfer of the quoted
// amount from the reserve R to the solver's published deposit address, hand those raw bytes over, and follow the fill.
// What it can never do: sign anything else, pay anyone but the solver's published deposit address, accept a payout to
// an address that is not this wallet's own W, or send twice for the same need.
import {
  type BridgeChain, type Quote, bridgeCfg, quoteProblem, stableToUsd6, nativeToUsd6, USD6, USER_STATE, QUOTE_ID, SOL_PROGRAMS,
} from './motionBridgeCore.ts';

export type SolverQuote = { quote: Quote; sig: string };
export type SolverFill = { ok: boolean; state: string; srcHash?: string; dstHash?: string; error?: string; ms?: Record<string, number> };
export type SolverDeps = {
  // the motion origin the vault asks (its parent page's origin — the vault serves no API of its own)
  base: () => string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  // the solver's quote-signing public key, pinned in the engine build (never read from the server)
  pinnedKey: () => string;
  // signs ONE ERC-20 transfer from R and returns the raw bytes (nothing is broadcast by the vault)
  signEvmTransfer: (a: { walletId: string; chain: BridgeChain; token: string; to: string; amount: bigint }) => Promise<{ raw: string; hash: string }>;
  // signs ONE SPL transferChecked + memo from R and returns the raw bytes (base64) and its signature
  signSolTransfer: (a: { walletId: string; mint: string; to: string; amount: bigint; decimals: number; memo: string }) => Promise<{ raw: string; sig: string }>;
  timeoutMs?: number;
  // the solver said it broadcast nothing (sent: false) for bytes signed here: an EVM transfer's nonce is free again, so the
  // reserve's next transfer takes the SAME nonce (one of the two can land, never both) instead of the next one (a gap that
  // holds every later send of that reserve; 2026-10-28). Left out = the nonce stays held for its 2 minutes, as before
  release?: (a: { chain: BridgeChain; hash: string }) => void;
};
export class SolverRefused extends Error { name = 'SolverRefused'; }
// a fill whose outcome we do not know yet: the bytes are out there, so the caller RECONCILES and never signs again
export class SolverUnknown extends Error { name = 'SolverUnknown'; srcHash?: string; quoteId?: string; }

const API = '/api/bridge/motion';

// The ONE Solana transfer the vault signs for motion's solver (webEngine bridgeSignSolTransfer), built here so a test holds
// the exact instructions against the solver's own check (motionBridgeCore solSourceProblem): the compute-unit limit and
// price, the quote id in a memo signed by R, and one SPL transferChecked of the quoted amount from R's token account
// (`src`) to the deposit address's (`dst`), authorised by R. Nothing else, ever.
export type SolBridgeIx = { program: string; keys: { pubkey: string; signer: boolean; writable: boolean }[]; data: Uint8Array };
export function solBridgeTransferIxs(a: { owner: string; src: string; dst: string; mint: string; amount: bigint; decimals: number; memo: string; units: number; micro: bigint }): SolBridgeIx[] {
  const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
  const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
  const ix = (program: string, keys: [string, boolean, boolean][], data: Uint8Array): SolBridgeIx => ({ program, keys: keys.map(([pubkey, signer, writable]) => ({ pubkey, signer, writable })), data });
  return [
    ix(SOL_PROGRAMS.budget, [], cat(Uint8Array.of(2), u32(a.units))),
    ix(SOL_PROGRAMS.budget, [], cat(Uint8Array.of(3), u64(a.micro))),
    ix(SOL_PROGRAMS.memo, [[a.owner, true, true]], new TextEncoder().encode(a.memo)),
    ix(SOL_PROGRAMS.token, [[a.src, false, true], [a.mint, false, false], [a.dst, false, true], [a.owner, true, false]], cat(Uint8Array.of(12), u64(a.amount), Uint8Array.of(a.decimals))),
  ];
}
// (2026-11-04) native SOL towards Elysium: budget, the memo = the quote id, ONE System Program transfer (instruction 2) from the
// owner to the solver's deposit address — what the solver's solNativeSourceProblem accepts, nothing more
export function solBridgeNativeIxs(a: { owner: string; to: string; amount: bigint; memo: string; units: number; micro: bigint }): SolBridgeIx[] {
  const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
  const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
  const ix = (program: string, keys: [string, boolean, boolean][], data: Uint8Array): SolBridgeIx => ({ program, keys: keys.map(([pubkey, signer, writable]) => ({ pubkey, signer, writable })), data });
  return [
    ix(SOL_PROGRAMS.budget, [], cat(Uint8Array.of(2), u32(a.units))),
    ix(SOL_PROGRAMS.budget, [], cat(Uint8Array.of(3), u64(a.micro))),
    ix(SOL_PROGRAMS.memo, [[a.owner, true, true]], new TextEncoder().encode(a.memo)),
    ix(SOL_PROGRAMS.system, [[a.owner, true, true], [a.to, false, true]], cat(u32(2), u64(a.amount))),
  ];
}
export const MOTION_BRIDGE_MAX6 = 1_000n * USD6;   // the vault's own ceiling for this route, whatever the solver offers

export function createSolverBridge(deps: SolverDeps) {
  const ms = () => deps.timeoutMs ?? 6_000;
  const ask = async (path: string, init?: RequestInit): Promise<any> => {
    const r = await deps.fetch(deps.base() + API + path, { ...(init || {}), headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(`motion bridge: ${String(j?.error || r.status).slice(0, 80)}`);
    return j;
  };

  /** the solver's published deposit addresses and whether it is open for business (cached by the caller) */
  async function health(): Promise<{ on: boolean; chains: BridgeChain[]; deposits: Partial<Record<BridgeChain, string>>; maxFillUsd: number; minFillUsd: number; solver: string; elysium?: { paused: boolean; why: string[]; assets: string[]; maxFillUsd?: number; fee?: { bps: number; minUsd: number }; sources?: string[] } }> {
    const j = await ask('/health');
    return { on: !!j.on, chains: Array.isArray(j.chains) ? j.chains : [], deposits: j.deposits || {}, maxFillUsd: Number(j.maxFillUsd) || 0, minFillUsd: Number(j.minFillUsd) || 0, solver: String(j.solver || ''),
      ...(j.elysium && typeof j.elysium === 'object' ? { elysium: { paused: j.elysium.paused !== false, why: Array.isArray(j.elysium.why) ? j.elysium.why.map(String).slice(0, 5) : [], assets: Array.isArray(j.elysium.assets) ? j.elysium.assets.map(String) : ['native'],
        // (2026-11-04, USD-balance buys on Elysium) the solver's own per-fill cap for Elysium, its HYPE headroom included; absent = the route's
        ...(Number(j.elysium.maxFillUsd) > 0 ? { maxFillUsd: Number(j.elysium.maxFillUsd) } : {}),
        // (release 6) motion's fee into Elysium as the solver publishes it (the vault never accepts more than its own ELY_FEE) and the sources
        ...(j.elysium.fee && typeof j.elysium.fee === 'object' ? { fee: { bps: Number(j.elysium.fee.bps), minUsd: Number(j.elysium.fee.minUsd) } } : {}),
        ...(Array.isArray(j.elysium.sources) ? { sources: j.elysium.sources.map(String).slice(0, 8) } : {}) } } : {}) };
  }

  /**
   * A quote, already checked: the signature against the pinned key, the route, the amount, the payer, the recipient
   * (this wallet's own W), the expiry, and the payout against the vault's OWN oracle price. Refusal throws, so the
   * float engine falls through to Relay.
   */
  async function quote(a: {
    from: BridgeChain; to: BridgeChain; amountIn: bigint; depositor: string; recipient: string;
    oracle6: bigint; maxSlipBps: number; deposits?: Partial<Record<BridgeChain, string>>;
    // (2026-11-03, Elysium) pay with the source chain's native coin (srcOracle6 = OUR price of it) and/or receive the
    // destination's stablecoin; both absent = the one shape every other route has (stable in, native out)
    pay?: 'native' | 'stable'; asset?: 'native' | 'stable'; srcOracle6?: bigint;
  }): Promise<SolverQuote & { usd6: bigint; out: bigint; fee6: bigint; etaMs: number }> {
    const in6 = a.pay === 'native' ? nativeToUsd6(a.amountIn, a.srcOracle6 ?? 0n, bridgeCfg(a.from).nativeDecimals) : stableToUsd6(a.amountIn, bridgeCfg(a.from).stable.decimals);
    if (in6 > MOTION_BRIDGE_MAX6) throw new SolverRefused('above what motion\'s own bridge carries');
    const j = await ask('/quote', { method: 'POST', body: JSON.stringify({ from: a.from, to: a.to, amount: String(a.amountIn), depositor: a.depositor, recipient: a.recipient, ...(a.pay === 'native' ? { pay: 'native' } : {}), ...(a.asset === 'stable' ? { asset: 'stable' } : {}) }) });
    if (!j.ok || !j.quote) throw new SolverRefused('motion bridge: ' + String(j.reason || j.error || 'no quote').slice(0, 80));
    const q = j.quote as Quote; const sig = String(j.sig || '');
    const why = quoteProblem(q, sig, {
      pinnedSolver: deps.pinnedKey(), from: a.from, to: a.to, amountIn: a.amountIn, depositor: a.depositor, recipient: a.recipient,
      oracle6: a.oracle6, maxSlipBps: a.maxSlipBps, maxFill6: MOTION_BRIDGE_MAX6, now: deps.now(), deposits: a.deposits,
      pay: a.pay, asset: a.asset, srcOracle6: a.srcOracle6,
    });
    if (why) throw new SolverRefused('motion bridge: ' + why);
    return { quote: q, sig, usd6: BigInt(q.usd6), out: BigInt(q.dst.amount), fee6: BigInt(q.fee6), etaMs: Math.max(600, bridgeCfg(a.from).inclusionMs + bridgeCfg(a.to).inclusionMs + 400) };
  }

  /**
   * Sign the source transfer for a checked quote and hand the raw bytes to the solver. The vault broadcasts nothing:
   * the solver does, and pays the destination on inclusion. A lost answer throws SolverUnknown WITH the source hash —
   * the caller follows that hash and never signs a second transfer for the same need.
   */
  // `early` (2026-11-01 pass 3, A3): ask the solver to answer 'paid' as soon as the payout is broadcast instead of after it saw it
  // land (it keeps confirming on its own side; 'filled' still only on the chain's word). An older solver ignores the field
  async function fill(q: Quote, sig: string, walletId: string, opts: { early?: boolean } = {}): Promise<SolverFill & { srcHash: string }> {
    if (!QUOTE_ID.test(q.id)) throw new SolverRefused('bad quote id');
    const cfg = bridgeCfg(q.src.chain);
    let raw: string, srcHash: string;
    if (cfg.kind === 'evm') {
      const s = await deps.signEvmTransfer({ walletId, chain: q.src.chain, token: q.src.token, to: q.src.deposit, amount: BigInt(q.src.amount) });
      raw = s.raw; srcHash = s.hash;
    } else {
      const s = await deps.signSolTransfer({ walletId, mint: q.src.token, to: q.src.deposit, amount: BigInt(q.src.amount), decimals: cfg.stable.decimals, memo: q.id });
      raw = s.raw; srcHash = s.sig;
    }
    // the fill's own fetch (not `ask`): a refusal body has to be read even on a 4xx, because `sent: false` is the
    // difference between "nothing of yours moved, take another route" and "the bytes are out there, follow them"
    let j: any;
    try {
      const r = await deps.fetch(deps.base() + API + '/fill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: q.id, raw, ...(opts.early ? { early: true } : {}) }) });
      j = await r.json().catch(() => null);
      if (!j) throw new Error('no body (' + r.status + ')');
    } catch (e) {
      const u = new SolverUnknown('motion bridge: no answer to the fill — following the transfer (' + String((e as Error).message).slice(0, 60) + ')');
      u.srcHash = srcHash; u.quoteId = q.id; throw u;
    }
    if (!j.ok && j.sent === false) { if (cfg.kind === 'evm') { try { deps.release?.({ chain: q.src.chain, hash: srcHash }); } catch { /* held as before */ } } throw new SolverRefused('motion bridge: ' + String(j.error || 'refused').slice(0, 100) + ' (nothing was broadcast)'); }
    if (!j.ok && !j.state) throw Object.assign(new SolverUnknown('motion bridge: ' + String(j.error || 'no answer').slice(0, 80)), { srcHash, quoteId: q.id });
    return { ok: !!j.ok, state: String(j.state || ''), srcHash: String(j.srcHash || srcHash), dstHash: j.dstHash ? String(j.dstHash) : undefined, error: j.error ? String(j.error).slice(0, 160) : undefined, ms: j.ms || undefined };
  }

  /** where a fill stands, for the vault's own job record (quoted → source sent → filled | refunded) */
  async function status(id: string): Promise<{ state: string; user: string; srcHash?: string; dstHash?: string; refundHash?: string; error?: string; delayed?: boolean }> {
    if (!QUOTE_ID.test(id)) throw new SolverRefused('bad quote id');
    const j = await ask('/status?id=' + encodeURIComponent(id));
    const state = String(j.state || '');
    return { state, user: USER_STATE[state as keyof typeof USER_STATE] || state, srcHash: j.srcHash, dstHash: j.dstHash, refundHash: j.refundHash, error: j.error ? String(j.error).slice(0, 160) : undefined, ...(j.delayed === true ? { delayed: true } : {}) };
  }

  /** a gas drop for this wallet's reserve: motion pays a little native (about $0.2 on EVM, 0.003 SOL on Solana, once a day)
   *  when the reserve holds dollars but no gas, so a USD balance trades with no native coin anywhere (2026-10-27) */
  async function gas(chain: BridgeChain, address: string): Promise<{ state: string; hash?: string }> {
    const j = await ask('/gas', { method: 'POST', body: JSON.stringify({ chain, address }) });
    if (!j.ok) throw new SolverRefused('motion bridge: ' + String(j.reason || 'no gas').slice(0, 80));
    return { state: String(j.state || ''), hash: j.hash ? String(j.hash) : undefined };
  }

  return { health, quote, fill, status, gas, timeoutMs: ms };
}
export type SolverBridge = ReturnType<typeof createSolverBridge>;
