// Terminal fee leg (fee-sprint "bypass", 2026-11-09). DEFAULT OFF on every chain.
//
// What it closes: the trade entrypoints that had no fee-paying replacement (PREP-1108 ENTRYPOINTS.json: 31 GATED_ONLY and
// 6 UNCOVERED). With the leg switched on for a chain, every terminal trade of that chain pays the terminal fee to the pinned
// collector of that chain, or is refused before anything is signed:
//   · (NOT in this module) market buy / sell: covered only on RH v4 / BNB v2 / SOL jupiter by the TerminalRouter candidate; every
//     other market venue stays GATED_ONLY (refused when the leg is on) until PREP-1108 blocker 2 ships — no market fee here;
//   · server-executed limit / take-profit / stop-loss on Robinhood and BNB (src/limitEngine.ts): the order wallet pre-signs a
//     fee transfer at the nonce right after its swap — it can only land after the swap's nonce is used; the vault burns that
//     nonce itself on every way back of an order that did not fill, and sends the fee itself before it sweeps a filled one;
//   · Solana limit / TP / SL (src/solLimitEngine.ts): the fee transfer is an instruction INSIDE each pre-signed variant —
//     atomic with the swap and its payout;
//   · Relay swaps (src/relaySwap.ts): the quote must carry Relay's app fee of at least the base rate, paid in the origin coin
//     (it already asks for BRIDGE_APP_FEE); a quote without it is refused.
//
// Deployment-pinned like src/terminalFeeGate.ts: no browser request, page argument, account tier or network response may switch
// it on, change a collector or lower the base rate. A discount below the base rate (holder tiers 15/10/5/0, members 0) is
// accepted only as an entitlement signed by the pinned entitlement signer for exactly this chain, wallet and policy, inside its
// validity window; anything else (no signer pinned, no entitlement, a bad signature, another wallet, expired, a rate outside the
// tier list) falls back to the base rate — fail-closed, never to zero. API trades (MotionRouter, 0.1 % API fee) never run
// through this module and an entitlement is only ever read for the terminal purpose.
import { recoverMessageAddress } from 'viem';

export type FeeChain = 'robinhood' | 'bsc' | 'sol';
export const FEE_CHAINS: readonly FeeChain[] = Object.freeze(['robinhood', 'bsc', 'sol'] as FeeChain[]);
export const FEE_TIERS_BPS: readonly number[] = Object.freeze([20, 15, 10, 5, 0]);
export const FEE_PURPOSE = 'motion-terminal-trade-v1';
export type FeeLegConfig = {
  enabled: Readonly<Record<FeeChain, boolean>>;
  baseBps: number;
  collectors: Readonly<Record<FeeChain, string | null>>;
  /** EVM address of the server's dedicated entitlement signer; null = no discount is ever accepted (base rate for all) */
  entitlementSigner: string | null;
  policyId: string;
  /** an entitlement is valid at most this long (s) */
  maxEntitlementTtlS: number;
};
const freeze = <T extends Record<string, unknown>>(o: T): Readonly<T> => { for (const v of Object.values(o)) if (v && typeof v === 'object') Object.freeze(v); return Object.freeze(o); };
// BNB and Solana collectors are owner decisions (PREP-1108 OWNER-DECISIONS п.4–6): null until pinned. A chain whose collector is
// null cannot be switched on (feeLegFor throws TerminalFeeMisconfigured instead of trading fee-free).
export const TERMINAL_FEE_LEG: Readonly<FeeLegConfig> = freeze({
  enabled: { robinhood: false, bsc: false, sol: false },
  baseBps: 20,
  collectors: { robinhood: '0x74f25914dcCE21555188B523748D3B3f557ed297', bsc: null, sol: null },
  entitlementSigner: null,
  policyId: 'motion-terminal-fee-phase1',
  maxEntitlementTtlS: 3600,
});

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, code: name, ...extra });
export const isFeeChain = (c: unknown): c is FeeChain => typeof c === 'string' && (FEE_CHAINS as string[]).includes(c);
const addrOk = (chain: FeeChain, a: unknown) => (chain === 'sol' ? SOL_ADDR.test(String(a ?? '')) : EVM_ADDR.test(String(a ?? '')) && !/^0x0{40}$/i.test(String(a)));

/** why a config cannot be used ('' = fine). Every enabled chain needs a valid collector; the base rate is the top tier. */
export function feeLegConfigProblem(cfg: FeeLegConfig): string {
  if (!cfg || typeof cfg !== 'object') return 'no config';
  if (cfg.baseBps !== FEE_TIERS_BPS[0]) return 'the base rate must be the top tier (20 bps)';
  if (typeof cfg.policyId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(cfg.policyId)) return 'bad policy id';
  if (!Number.isInteger(cfg.maxEntitlementTtlS) || cfg.maxEntitlementTtlS < 60 || cfg.maxEntitlementTtlS > 86400) return 'bad entitlement ttl';
  if (cfg.entitlementSigner !== null && !EVM_ADDR.test(String(cfg.entitlementSigner))) return 'bad entitlement signer';
  for (const c of FEE_CHAINS) {
    if (typeof cfg.enabled?.[c] !== 'boolean') return `enabled.${c} is not a boolean`;
    const col = cfg.collectors?.[c];
    if (col !== null && !addrOk(c, col)) return `bad collector for ${c}`;
    if (cfg.enabled[c] && col === null) return `${c} is enabled without a collector`;
  }
  return '';
}

export type FeeLeg = { chain: FeeChain; collector: string; baseBps: number; policyId: string };
/** the leg of a chain: null = off (the caller runs exactly as before). On but unusable = a refusal, never a fee-free trade. */
export function feeLegFor(chain: unknown, cfg: FeeLegConfig = TERMINAL_FEE_LEG): FeeLeg | null {
  if (!isFeeChain(chain) || cfg?.enabled?.[chain] !== true) return null;
  const why = feeLegConfigProblem(cfg);
  if (why) throw named('TerminalFeeMisconfigured', `Trading is paused on this network: the terminal fee is not configured (${why})`);
  const collector = chain === 'sol' ? String(cfg.collectors[chain]) : String(cfg.collectors[chain]).toLowerCase();
  return Object.freeze({ chain, collector, baseBps: cfg.baseBps, policyId: cfg.policyId });
}
/** floor(basis × bps / 10 000) — never above the basis, 0 for 0 bps */
export function feeOf(basis: bigint, bps: number): bigint {
  if (!(FEE_TIERS_BPS as number[]).includes(bps)) throw named('TerminalFeeMisconfigured', 'bad fee rate');
  if (basis <= 0n) return 0n;
  return (basis * BigInt(bps)) / 10_000n;
}
export const feeLabel = (bps: number) => `${(bps / 100).toFixed(2)} %`;

// ── entitlements (holder tiers / paid membership), attested by the server's dedicated signer ──
export type Entitlement = { chain: FeeChain; wallet: string; bps: number; notBefore: number; expiresAt: number; policyId: string; sig: string };
export const ENTITLEMENT_HEAD = 'motion terminal fee entitlement v1';
/** the one text the entitlement signer signs (EIP-191 personal_sign); times in seconds */
export function entitlementText(e: Omit<Entitlement, 'sig'>): string {
  const wallet = e.chain === 'sol' ? e.wallet : String(e.wallet).toLowerCase();
  return [ENTITLEMENT_HEAD, `purpose: ${FEE_PURPOSE}`, `policy: ${e.policyId}`, `chain: ${e.chain}`, `wallet: ${wallet}`, `bps: ${e.bps}`, `not before: ${e.notBefore}`, `expires: ${e.expiresAt}`].join('\n');
}
export type Recover = (text: string, sig: string) => Promise<string>;
const viemRecover: Recover = (text, sig) => recoverMessageAddress({ message: text, signature: sig as `0x${string}` });
/** the rate of one wallet's trade: the base rate unless a valid entitlement says a lower tier. Never throws. */
export async function bpsFor(o: { leg: FeeLeg; wallet: string; entitlement?: unknown; nowMs: number; recover?: Recover }, cfg: FeeLegConfig = TERMINAL_FEE_LEG): Promise<{ bps: number; source: 'base' | 'entitlement'; reason?: string }> {
  const base = (reason: string) => ({ bps: o.leg.baseBps, source: 'base' as const, reason });
  const e = o.entitlement as Partial<Entitlement> | undefined | null;
  if (e == null) return base('none');
  if (!cfg.entitlementSigner) return base('no signer pinned');
  if (typeof e !== 'object' || Array.isArray(e)) return base('shape');
  for (const k of Object.keys(e)) if (!['chain', 'wallet', 'bps', 'notBefore', 'expiresAt', 'policyId', 'sig'].includes(k)) return base('shape');
  if (e.chain !== o.leg.chain || e.policyId !== o.leg.policyId) return base('another chain or policy');
  const same = o.leg.chain === 'sol' ? e.wallet === o.wallet : String(e.wallet ?? '').toLowerCase() === String(o.wallet).toLowerCase();
  if (!same) return base('another wallet');
  if (!Number.isInteger(e.bps) || !(FEE_TIERS_BPS as number[]).includes(e.bps as number)) return base('rate');
  if (!Number.isSafeInteger(e.notBefore) || !Number.isSafeInteger(e.expiresAt)) return base('window');
  const now = Math.floor(o.nowMs / 1000);
  if ((e.notBefore as number) > now + 30 || (e.expiresAt as number) <= now || (e.expiresAt as number) - (e.notBefore as number) > cfg.maxEntitlementTtlS) return base('window');
  if (typeof e.sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(e.sig)) return base('signature');
  let who = '';
  try { who = await (o.recover ?? viemRecover)(entitlementText(e as Omit<Entitlement, 'sig'>), e.sig); } catch { return base('signature'); }
  if (String(who).toLowerCase() !== String(cfg.entitlementSigner).toLowerCase()) return base('signature');
  return { bps: e.bps as number, source: 'entitlement' };
}

// ── Relay swaps: the quote's own app fee must cover the base rate, in the origin coin ──
const eqAddr = (a: unknown, b: unknown, sol: boolean) => (sol ? String(a ?? '') === String(b ?? '') : String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase());
/** why this Relay quote does not pay the terminal rate ('' = it does). minBps = the base rate (a discount never applies here). */
export function relayAppFeeProblem(j: any, want: { originChainId: number; originCurrency: string; amount: string }, minBps: number, solChainId: number): string {
  const app = j?.fees?.app;
  if (!app || typeof app !== 'object') return 'the quote carries no app fee';
  const sol = Number(want.originChainId) === solChainId;
  if (Number(app.currency?.chainId) !== Number(want.originChainId) || !eqAddr(app.currency?.address, want.originCurrency, sol)) return 'the app fee is not paid in the coin you swap';
  const fee = /^\d{1,60}$/.test(String(app.amount ?? '')) ? BigInt(String(app.amount)) : -1n;
  const amount = /^\d{1,60}$/.test(String(want.amount ?? '')) ? BigInt(String(want.amount)) : 0n;
  if (fee < 0n || amount <= 0n) return 'the app fee cannot be read';
  if (fee * 10_000n < amount * BigInt(minBps)) return `the app fee is under the ${feeLabel(minBps)} terminal fee`;
  return '';
}
