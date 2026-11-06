// Earn on the USD balance — the pure rules. Robinhood: USDG in Morpho "Steakhouse USDG" (this file); BNB: USDC in Aave v3
// (src/earnAave.ts); Solana: USDC in Kamino Lend's main market (src/earnKamino.ts).
// Design: the Earn research report (local copy, §6 / §8); notes: local earn-mvp/notes.txt.
//
// The USD balance's reserve R holds USDG. With Earn on, R keeps a liquid buffer B and puts only the rest, E, into ONE
// ERC-4626 vault this build names (allow-listed here: chain, vault, asset, the four selectors, receiver = owner = R). The
// balance is liquid + convertToAssets(shares); "Earned" is that value minus what went in. Nothing in this file reads a chain,
// signs, or keeps state: earnEngine.ts does, and asks these functions before every step.
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { USD, fmtUsd6, type FloatLang } from './floatCore.ts';
import { AAVE_BSC, aaveTxProblem, type AaveCfg } from './earnAave.ts';
import { KAMINO_SOL, type KaminoCfg } from './earnKamino.ts';

export const EARN_RULES = 1;
export type EarnChain = 'robinhood' | 'bsc' | 'sol';
export const EARN_CHAINS: readonly EarnChain[] = ['robinhood', 'bsc', 'sol'];
export type EarnVaultCfg = {
  kind: 'erc4626'; protocol: 'Morpho';
  chain: 'robinhood'; chainId: number; name: string; curatorName: string;
  vault: `0x${string}`; asset: `0x${string}`; assetSymbol: string; assetDecimals: number; shareDecimals: number;
  // keccak256 of the vault's runtime code, read 2026-11-03 (eth_getCode on rpc.mainnet.chain.robinhood.com). Morpho Vault V2
  // is not upgradeable: a different hash = a different contract at that address, and Earn stops
  codeHash: string;
  // Morpho Vault V2 answers maxDeposit / maxWithdraw / maxRedeem with 0 by design (read 2026-11-03: 0 for every address), so the
  // vault's instant liquidity is what an exact redeem simulated from R returns; a vault where they are not 0 is capped by them
  maxZero: boolean;
  // the curator can raise the performance fee without a timelock (REPORT §4): above these, nothing new goes in
  maxPerformanceFeeWad: bigint; maxManagementFeeWad: bigint;
  // USDG is itself an upgradeable proxy: its EIP-1967 implementation as read on 2026-11-03 (review L5). Another one = new token
  // code: nothing new goes in ('changed'), withdrawals go on
  assetImpl: string;
};
export type EarnCfg = EarnVaultCfg | AaveCfg | KaminoCfg;
export const EARN_VAULTS: { robinhood: EarnVaultCfg; bsc: AaveCfg; sol: KaminoCfg } = {
  robinhood: {
    kind: 'erc4626', protocol: 'Morpho', chain: 'robinhood', chainId: 4663, name: 'Steakhouse USDG', curatorName: 'Steakhouse (Morpho)',
    vault: '0xBeEff033F34C046626B8D0A041844C5d1A5409dd',
    asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', assetSymbol: 'USDG', assetDecimals: 6, shareDecimals: 18,
    codeHash: '0x3492098028b641c5949beebf8c56898f1ed846f42b59978ed7c75249603c1f6e',
    maxZero: true,
    maxPerformanceFeeWad: 100_000_000_000_000_000n,   // 10 % (0 on 2026-11-03)
    maxManagementFeeWad: 0n,                          // 0 on 2026-11-03
    assetImpl: '0x68184c449e1a8f34fa18d289737129fd27b66f8f',
  },
  bsc: AAVE_BSC,
  sol: KAMINO_SOL,
};
/** The Morpho vault (Robinhood) — the phase-1 helpers below take it. */
export const earnCfgOf = (c: string | null | undefined): EarnVaultCfg | null => (c === 'robinhood' ? EARN_VAULTS.robinhood : null);
/** Any chain's Earn venue (Morpho on Robinhood, Aave v3 on BNB, Kamino on Solana); null = no Earn on that chain. */
export const earnVenueOf = (c: string | null | undefined): EarnCfg | null => (c === 'robinhood' || c === 'bsc' || c === 'sol' ? EARN_VAULTS[c] : null);
export const isEarnChain = (c: unknown): c is EarnChain => c === 'robinhood' || c === 'bsc' || c === 'sol';

// the ONLY state-changing calls Earn ever signs (approve on the asset; deposit / withdraw / redeem on the vault)
export const EARN_SELECTORS = { approve: '0x095ea7b3', deposit: '0x6e553f65', withdraw: '0xb460af94', redeem: '0xba087652' } as const;
export const EARN_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { name: 'redeem', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'shares', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }], outputs: [{ name: 'assets', type: 'uint256' }] },
  { name: 'asset', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'convertToAssets', type: 'function', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'previewDeposit', type: 'function', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'previewWithdraw', type: 'function', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'maxWithdraw', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'maxRedeem', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'receiveSharesGate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'sendSharesGate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'receiveAssetsGate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'sendAssetsGate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'performanceFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint96' }] },
  { name: 'managementFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint96' }] },
] as const;
// the receipt events the outcome checks read (ERC-20 Transfer; ERC-4626 Deposit / Withdraw — the topics the vault emits,
// read with eth_getLogs on 2026-11-03: Deposit 3 topics + 64 data bytes, Withdraw 4 topics + 64 data bytes)
export const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  deposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  withdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
} as const;

export const EARN = {
  // the buffer B that never goes in: max(2 × the largest buy preset or recent buy, 15 % of R, $25)
  bufferMin6: 25n * USD, bufferPct: 15n, bufferPresetMult: 2n,
  // a background refill runs when the liquid part is under 60 % of B, and refills to B
  refillPct: 60n,
  // a background deposit only when the liquid part is at least $25 above B (a deposit + its approval cost cents)
  depositMin6: 25n * USD,
  perTxMax6: 1_000n * USD,       // one deposit
  dayIn6: 2_500n * USD,          // deposits per wallet per UTC day
  withdrawMax6: 5_000n * USD,    // one withdraw (by assets); a whole exit redeems every share in at most this much per step
  txPerDay: 8,                   // background Earn transactions per wallet per UTC day (approvals included)
  clickTxPerDay: 24,             // a waiting click's withdrawals per wallet per UTC day
  gapMs: 15 * 60_000,            // between two background deposits of one wallet
  refillGapMs: 2 * 60_000,       // between two background withdrawals of one wallet
  backoffMs: 10 * 60_000,        // after a refused / failed step (not an anomaly); doubles with each failure in a row, up to 16×
  exitPerDay: 6,                 // switch-off withdrawals per wallet × chain per UTC day — automatic AND the user's own (review H1)
  stepMs: 120_000,               // one Earn step: no send after this (cooperative abort; the lock is held until the step ends — H4)
  verifyMs: 10 * 60_000,         // a landed step whose position read does not match yet: re-read for this long, then a hard stop (M2)
  scanBlocks: { robinhood: 36_000n, bsc: 8_000n } as Record<string, bigint>,   // ~1 h back on a first scan for another device's moves (H2; r3: Robinhood ~9.8 blocks/s)
  // blocks per log read (r3, M-a: BNB nodes cap eth_getLogs at 5,000 blocks — 48 Club — so 2,000 there; halved on a refusal);
  // only a DEPOSIT waits until the scan has caught up (refills and the switch-off never wait for it)
  scanChunk: { robinhood: 10_000n, bsc: 2_000n } as Record<string, bigint>,
  adoptMs: 15 * 60_000,          // r3 L-d: an R-signed move this soon after this device's own send that failed without a hash = its own
  monitorTicks: 2,               // the server monitor's pause must be seen on 2 ticks in a row before it acts (M1)
  implCheckMs: 15 * 60_000,      // the proxies' implementations (venue + stablecoin) are read again before a deposit when older (L5)
  msPerBlock: { robinhood: 102, bsc: 450 } as Record<string, number>,   // (r3: Robinhood measured 102 ms on chain)   // to start a first scan where Earn was turned on (H2)
  scanMax: 5,                    // log reads per tick (scanChunk blocks each); a gap over a day jumps to the last hour (M-a)
  failsToPause: 3,               // refused simulations in a row (deposits) before deposits pause
  capDefault6: 1_000n * USD, capMin6: 25n * USD, capMax6: 5_000n * USD,   // what the account may keep in Earn
  grantDays: 90,                 // the permission's validity (NOT a lock: the app says "permission valid 90 days")
  sessionMinH: 1, sessionMaxH: 24,   // r3 (owner): a timed session, 1–24 h (presets 8 h / 11 h in the app), or until turned off
  sessionBackMs: 10 * 60_000,    // the wall clock jumping back more than this ends a session (the money comes back)
  priceDropBps: 50n,             // the share price 0.5 % under its high-water mark = anomaly, Earn stops
  priceMin6: 500_000n, priceMax6: 2_000_000n,   // assets of 1e18 shares (USDG raw): outside = anomaly
  depositSlipBps: 10n,           // the simulated shares at least the preview less 0.1 %
  withdrawSlipBps: 10n,          // the simulated shares burnt at most the preview plus 0.1 %; a redeem's assets the value less 0.1 %
  clickMarginPct: 125n, clickExtra6: 1n * USD,   // a click's withdrawal: what its top-up will want (floatCore clickMarginPct) + $1
  clickMin6: 1n * USD,
  clickLockMs: 3_000,            // how long a click waits for a background Earn step of the same wallet to finish
  clickReceiptMs: 8_000,         // how long a click waits for its withdrawal's receipt (Robinhood blocks are ~250 ms)
  receiptMs: 60_000,
  gasMax: 1_500_000n,            // per Earn transaction; estimate × 1.3 under it
  gasWeiMax: 30_000_000_000_000n,   // Robinhood: 0.00003 ETH per Earn transaction at most (≈ $0.07)
  gasWeiMaxBsc: 200_000_000_000_000n,   // BNB: 0.0002 BNB per Earn transaction at most (≈ $0.14)
  vaultCheckMs: 30 * 60_000,     // the vault's code hash / proxy implementations are re-read this often (every tick reads gates and fees; L5: was 6 h)
  geoMs: 6 * 3_600_000,
  probes: 4,                     // a short vault: the redeemable part is found by halving, at most this many simulations
  openMs: 10 * 60_000,           // a sent transaction without a receipt is followed this long before it counts as failed
} as const;

const lc = (a: string) => String(a || '').toLowerCase();
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const word = (hex: string, i: number): bigint => BigInt('0x' + (hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));
const addrOf = (topic: string | undefined): string => (topic && topic.length === 66 ? '0x' + topic.slice(26).toLowerCase() : '');
export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** B = max(2 × the largest buy preset or recent buy, 15 % of R, $25), in micro-dollars. R = liquid + what is in Earn. */
export function bufferOf6(sizes6: readonly bigint[], total6: bigint): bigint {
  const top = sizes6.reduce((m, x) => (x > m ? x : m), 0n);
  return max(max(top * EARN.bufferPresetMult, (total6 * EARN.bufferPct) / 100n), EARN.bufferMin6);
}

export type EarnPlanIn = {
  on: boolean; exit: boolean; paused: boolean;
  // review H2: another device runs Earn for this wallet × chain — this one does nothing automatic but the switch-off
  passive?: boolean;
  // the switch-off's own budget (review H1): its sends today (automatic and the user's)
  exitToday?: number;
  // the venue is risk-off or changed (its code was upgraded): nothing new goes in (exit carries the risk-off withdrawal)
  noDeposit?: boolean;
  liquid6: bigint; assets6: bigint; redeemable6: bigint; buffer6: bigint;
  capRoom6: bigint; dayIn6: bigint; txToday: number; lastDepositAt: number; lastWithdrawAt: number; backoffUntil: number;
  gasOk: boolean; geoOk: boolean; now: number;
};
export type EarnStep = { kind: 'deposit' | 'withdraw'; usd6: bigint; all?: boolean; why: string } | { kind: 'none'; why: string };
/**
 * One background step for one wallet. Never both; never while paused (an anomaly keeps the funds where they are). A refill
 * (liquid under 60 % of B) comes before any deposit; the user's switch-off ('exit') takes everything out that the vault can
 * pay now. A withdrawal needs no consent (it brings the user's own money back to R); a deposit needs it, the geo check, the
 * caps, the day budget and the gap.
 */
export function earnPlan(x: EarnPlanIn): EarnStep {
  // a hard stop holds EVERYTHING automatic, the switch-off's withdrawals too (review H1 / M8): only the user's own action moves money
  if (x.paused) return { kind: 'none', why: 'paused' };
  if (!x.gasOk) return { kind: 'none', why: 'gas' };
  if (x.now < x.backoffUntil) return { kind: 'none', why: 'backoff' };
  // the switch-off: its own day budget (each step is also bounded by the gap and by what R holds there)
  if (x.exit && x.assets6 > 0n) {
    if ((x.exitToday ?? 0) >= EARN.exitPerDay) return { kind: 'none', why: 'limit-exit' };
    if (x.redeemable6 <= 0n) return { kind: 'none', why: 'liquidity' };
    if (x.now - x.lastWithdrawAt < EARN.refillGapMs / 4) return { kind: 'none', why: 'gap' };
    const all = x.redeemable6 >= x.assets6 && x.assets6 <= EARN.withdrawMax6;
    return { kind: 'withdraw', usd6: min(min(x.redeemable6, x.assets6), EARN.withdrawMax6), ...(all ? { all: true } : {}), why: 'exit' };
  }
  if (x.passive) return { kind: 'none', why: 'another-device' };
  if (x.txToday >= EARN.txPerDay) return { kind: 'none', why: 'limit-day' };
  if (x.assets6 > 0n && x.liquid6 * 100n < x.buffer6 * EARN.refillPct) {
    if (x.now - x.lastWithdrawAt < EARN.refillGapMs) return { kind: 'none', why: 'gap' };
    const want = min(min(x.buffer6 - x.liquid6, x.assets6), EARN.withdrawMax6);
    const amt = min(want, x.redeemable6);
    if (amt < EARN.clickMin6) return { kind: 'none', why: x.redeemable6 <= 0n ? 'liquidity' : 'below-min' };
    return { kind: 'withdraw', usd6: amt, ...(amt >= x.assets6 ? { all: true } : {}), why: 'refill' };
  }
  if (!x.on || x.exit) return { kind: 'none', why: 'off' };
  if (x.noDeposit) return { kind: 'none', why: 'paused' };
  if (!x.geoOk) return { kind: 'none', why: 'geo' };
  const surplus = x.liquid6 - x.buffer6;
  if (surplus < EARN.depositMin6) return { kind: 'none', why: 'nothing' };
  if (x.now - x.lastDepositAt < EARN.gapMs) return { kind: 'none', why: 'gap' };
  const dayRoom = EARN.dayIn6 - x.dayIn6;
  const amt = min(min(min(surplus, EARN.perTxMax6), dayRoom), x.capRoom6);
  if (amt < EARN.depositMin6) return { kind: 'none', why: x.capRoom6 < EARN.depositMin6 ? 'cap' : 'limit-day' };
  return { kind: 'deposit', usd6: amt, why: 'surplus' };
}

/** What a waiting click takes out first: what its top-up will want (need + 25 % + $1) less what R and W already hold. 0 = none. */
export function clickWithdraw6(need6: bigint, liquid6: bigint, wReady6: bigint, assets6: bigint, redeemable6: bigint): bigint {
  const want = (need6 * EARN.clickMarginPct) / 100n + EARN.clickExtra6;
  const short = want - liquid6 - wReady6;
  if (short <= 0n) return 0n;
  // whole cents up, never more than the vault holds for R nor more than it can pay now
  const up = ((short + 9_999n) / 10_000n) * 10_000n;
  const amt = min(min(max(up, EARN.clickMin6), assets6), min(redeemable6, EARN.withdrawMax6));
  return amt < EARN.clickMin6 && amt < assets6 ? 0n : amt;
}

// ── the allow-list every Earn transaction passes, in earnEngine before it asks the signer, and AGAIN in the signer ──
export type EarnTx = { to: `0x${string}`; data: `0x${string}`; value: bigint };
/**
 * null = this is one of the four calls Earn may sign for this R; else why not. Only: approve(vault, amount ≤ one deposit's cap)
 * on the asset, or deposit(assets ≤ cap, R) / withdraw(assets, R, R) / redeem(shares, R, R) on the vault; value 0; exact
 * calldata lengths; the chain this vault lives on.
 */
export function earnTxProblem(tx: EarnTx, ctx: { r: string; chainId: number; cfg?: EarnVaultCfg | AaveCfg | KaminoCfg | null }): string | null {
  const any = ctx.cfg ?? null;
  if (!any) return 'Earn is not available on this chain';
  if (any.kind === 'aave3') return aaveTxProblem(tx, { r: ctx.r, chainId: ctx.chainId, cfg: any, perTxMax6: EARN.perTxMax6, withdrawMax6: EARN.withdrawMax6 });
  if (any.kind !== 'erc4626') return 'not an EVM Earn venue';
  const cfg = any;
  if (ctx.chainId !== cfg.chainId) return 'wrong chain';
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(ctx.r))) return 'no reserve';
  if (typeof tx.value !== 'bigint' || tx.value !== 0n) return 'value must be 0';
  const data = String(tx.data || ''); if (!/^0x[0-9a-fA-F]*$/.test(data)) return 'bad calldata';
  const sel = data.slice(0, 10).toLowerCase(); const to = lc(tx.to); const r = lc(ctx.r);
  const capRaw = EARN.perTxMax6 * 10n ** BigInt(Math.max(0, cfg.assetDecimals - 6));
  if (to === lc(cfg.asset)) {
    if (sel !== EARN_SELECTORS.approve || data.length !== 10 + 128) return 'only approve on the asset';
    const d = decodeFunctionData({ abi: EARN_ABI, data: data as Hex });
    const [spender, amount] = d.args as readonly [string, bigint];
    if (lc(spender) !== lc(cfg.vault)) return 'approve names another spender';
    if (amount > capRaw) return 'approve above one deposit';
    return null;
  }
  if (to !== lc(cfg.vault)) return 'not the vault';
  if (sel === EARN_SELECTORS.deposit) {
    if (data.length !== 10 + 128) return 'bad deposit';
    const [assets, receiver] = decodeFunctionData({ abi: EARN_ABI, data: data as Hex }).args as readonly [bigint, string];
    if (!(assets > 0n) || assets > capRaw) return 'deposit amount out of bounds';
    if (lc(receiver) !== r) return 'deposit receiver is not the reserve';
    return null;
  }
  if (sel === EARN_SELECTORS.withdraw || sel === EARN_SELECTORS.redeem) {
    if (data.length !== 10 + 192) return 'bad withdraw';
    const [amount, receiver, owner] = decodeFunctionData({ abi: EARN_ABI, data: data as Hex }).args as readonly [bigint, string, string];
    if (!(amount > 0n)) return 'withdraw amount out of bounds';
    if (sel === EARN_SELECTORS.withdraw && amount > EARN.withdrawMax6 * 10n ** BigInt(Math.max(0, cfg.assetDecimals - 6))) return 'withdraw amount out of bounds';
    if (lc(receiver) !== r || lc(owner) !== r) return 'withdraw receiver / owner is not the reserve';
    return null;
  }
  return 'selector not allowed';
}
// the calls, built here and nowhere else (receiver = owner = R)
export const approveData = (cfg: EarnVaultCfg, amount: bigint) => encodeFunctionData({ abi: EARN_ABI, functionName: 'approve', args: [cfg.vault, amount] });
export const depositData = (assets: bigint, r: `0x${string}`) => encodeFunctionData({ abi: EARN_ABI, functionName: 'deposit', args: [assets, r] });
export const withdrawData = (assets: bigint, r: `0x${string}`) => encodeFunctionData({ abi: EARN_ABI, functionName: 'withdraw', args: [assets, r, r] });
export const redeemData = (shares: bigint, r: `0x${string}`) => encodeFunctionData({ abi: EARN_ABI, functionName: 'redeem', args: [shares, r, r] });

// ── the vault itself, read every tick: anything off = anomaly (Earn stops, the funds stay where they are) ──
export type VaultFacts = { codeHash?: string | null; asset: string | null; gates: (string | null)[]; performanceFee: bigint | null; managementFee: bigint | null; price6: bigint | null };
export function vaultProblem(f: VaultFacts, cfg: EarnVaultCfg, hwm6: bigint): string | null {
  if (f.codeHash != null && lc(f.codeHash) !== lc(cfg.codeHash)) return 'the vault contract is not the one this build knows';
  if (!f.asset || lc(f.asset) !== lc(cfg.asset)) return 'the vault holds another asset';
  if (f.gates.length !== 4 || f.gates.some((g) => g == null || !/^0x0{40}$/i.test(g))) return 'the vault has a gate set';
  if (f.performanceFee == null || f.performanceFee > cfg.maxPerformanceFeeWad) return 'the vault raised its performance fee';
  if (f.managementFee == null || f.managementFee > cfg.maxManagementFeeWad) return 'the vault set a management fee';
  if (f.price6 == null || f.price6 < EARN.priceMin6 || f.price6 > EARN.priceMax6) return 'the vault\'s share price is out of bounds';
  if (hwm6 > 0n && f.price6 * 10_000n < hwm6 * (10_000n - EARN.priceDropBps)) return 'the vault\'s share price dropped';
  return null;
}

// ── outcomes, from the transaction's own receipt (exact per transaction, whatever else moved meanwhile) ──
export type Log = { address: string; topics: readonly string[]; data: string };
/** A deposit's receipt: R paid the vault exactly `amount` of the asset, the vault minted `shares` ≥ minShares to R, nothing else of R's asset left. */
export function depositOutcome(logs: readonly Log[], cfg: EarnVaultCfg, r: string, amount: bigint, minShares: bigint): { shares: bigint } | { why: string } {
  const R = lc(r);
  const outs = logs.filter((l) => lc(l.address) === lc(cfg.asset) && l.topics[0] === TOPIC.transfer && addrOf(l.topics[1]) === R);
  if (outs.length !== 1 || addrOf(outs[0].topics[2]) !== lc(cfg.vault) || word(outs[0].data, 0) !== amount) return { why: 'the deposit did not move exactly the amount from the reserve to the vault' };
  const dep = logs.filter((l) => lc(l.address) === lc(cfg.vault) && l.topics[0] === TOPIC.deposit);
  if (dep.length !== 1 || addrOf(dep[0].topics[1]) !== R || addrOf(dep[0].topics[2]) !== R) return { why: 'the vault did not record the deposit for the reserve' };
  const assets = word(dep[0].data, 0), shares = word(dep[0].data, 1);
  if (assets !== amount) return { why: 'the vault recorded another amount' };
  if (shares < minShares || shares === 0n) return { why: 'the vault minted fewer shares than simulated' };
  return { shares };
}
/** A withdraw / redeem receipt: the vault paid R `assets` of the asset (≥ minAssets) for `shares` (≤ maxShares) burnt from R. */
export function withdrawOutcome(logs: readonly Log[], cfg: EarnVaultCfg, r: string, minAssets: bigint, maxShares: bigint): { assets: bigint; shares: bigint } | { why: string } {
  const R = lc(r);
  const wd = logs.filter((l) => lc(l.address) === lc(cfg.vault) && l.topics[0] === TOPIC.withdraw);
  if (wd.length !== 1 || addrOf(wd[0].topics[1]) !== R || addrOf(wd[0].topics[2]) !== R || addrOf(wd[0].topics[3]) !== R) return { why: 'the vault did not record a withdrawal to the reserve' };
  const assets = word(wd[0].data, 0), shares = word(wd[0].data, 1);
  const ins = logs.filter((l) => lc(l.address) === lc(cfg.asset) && l.topics[0] === TOPIC.transfer && addrOf(l.topics[2]) === R);
  const paid = ins.reduce((t, l) => t + word(l.data, 0), 0n);
  if (paid !== assets) return { why: 'the reserve did not receive what the vault recorded' };
  if (assets < minAssets) return { why: 'the vault paid less than simulated' };
  if (shares > maxShares || shares === 0n) return { why: 'the vault burnt more shares than simulated' };
  return { assets, shares };
}
/** What stays "in" after a withdrawal of `shares` out of `before`: the principal shrinks pro rata. */
export const principalAfter = (principal6: bigint, before: bigint, shares: bigint): bigint => (before <= 0n || shares >= before ? 0n : (principal6 * (before - shares)) / before);
export const assetsOf6 = (raw: bigint, cfg: EarnVaultCfg) => (cfg.assetDecimals >= 6 ? raw / 10n ** BigInt(cfg.assetDecimals - 6) : raw * 10n ** BigInt(6 - cfg.assetDecimals));
export const rawOf = (usd6: bigint, cfg: EarnVaultCfg) => (cfg.assetDecimals >= 6 ? usd6 * 10n ** BigInt(cfg.assetDecimals - 6) : usd6 / 10n ** BigInt(6 - cfg.assetDecimals));
export const bps = (x: bigint, b: bigint) => (x * b) / 10_000n;

// ── the live rate: from the venue's own share price / index over time (a read, never a promise) ──
/** APY in basis points from (time, price) samples spanning at least `span` (the oldest sample at or before now − span); null = not enough. */
export function apyFromSamples(samples: readonly { at: number; p: bigint }[], span: number, now: number): number | null {
  const last = samples[samples.length - 1]; if (!last || !(last.p > 0n)) return null;
  const base = [...samples].reverse().find((x) => x.at <= now - span && x.p > 0n); if (!base) return null;
  const dt = (last.at - base.at) / 31_536_000_000; if (!(dt > 0)) return null;
  const g = Number(last.p) / Number(base.p); if (!(g > 0)) return null;
  const apy = Math.pow(g, 1 / dt) - 1;
  return Number.isFinite(apy) && apy > -1 && apy < 5 ? Math.round(apy * 10_000) : null;
}
// ── the history and its tax / PnL export ──
export type HistRow = { at: number; chain: EarnChain; wallet: string; kind: 'deposit' | 'withdraw'; usd6: string; hash: string; yield6?: string; why?: string };
const csvCell = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
/** One line per deposit / withdrawal, a "yield" line for the part of a withdrawal above what went in (realized), and one
 *  "unrealized" line per wallet × network at the export's time. Amounts in dollars, 6 decimals. */
export function earnCsv(rows: readonly HistRow[], unrealized: readonly { chain: EarnChain; wallet: string; usd6: bigint }[], now: number): string {
  const d = (u: bigint) => { const neg = u < 0n; const a = neg ? -u : u; return (neg ? '-' : '') + (a / 1_000_000n).toString() + '.' + (a % 1_000_000n).toString().padStart(6, '0'); };
  const out = ['date,network,wallet,kind,usd,tx'];
  for (const r of rows) {
    const date = new Date(r.at).toISOString(); const net = CHAIN_NAME[r.chain] ?? r.chain;
    out.push([date, net, r.wallet, r.kind, d(BigInt(r.usd6)), r.hash].map((x) => csvCell(String(x))).join(','));
    if (r.kind === 'withdraw' && r.yield6 != null) out.push([date, net, r.wallet, 'yield (realized)', d(BigInt(r.yield6)), r.hash].map((x) => csvCell(String(x))).join(','));
  }
  for (const u of unrealized) out.push([new Date(now).toISOString(), CHAIN_NAME[u.chain] ?? u.chain, u.wallet, 'yield (unrealized)', d(u.usd6), ''].map((x) => csvCell(String(x))).join(','));
  return out.join('\n') + '\n';
}

// ── the account's switch ──
export type EarnGrant = { v: 1; on: true; cap6: string; chains: EarnChain[]; grantedAt: number; expiresAt: number; rules: number; digest: string };
// a CHECKSUM of the grant's fields (catches a malformed / half-written record), not tamper protection: only the vault origin can
// write its own storage — that is the protection (review L3)
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
export const earnDigest = (g: Omit<EarnGrant, 'digest'>) => fnv(`earn|${g.v}|${g.on}|${g.cap6}|${[...(g.chains || [])].sort().join(',')}|${g.grantedAt}|${g.expiresAt}|${g.rules}`);
export const earnLive = (g: EarnGrant | null | undefined, now: number): g is EarnGrant => !!g && g.v === 1 && g.on === true && g.rules >= EARN_RULES && g.expiresAt > now && g.grantedAt <= now + EARN.sessionBackMs   /* r3: a clock a few minutes behind is not a lapse */
  && Array.isArray(g.chains) && g.chains.length > 0 && g.chains.every((c) => EARN_CHAINS.includes(c))
  && big(g.cap6) >= EARN.capMin6 && big(g.cap6) <= EARN.capMax6 && earnDigest(g) === g.digest;

// ── float.earn arguments (one plain object; any other key refused) ──
export function earnArgs(o: unknown): { walletId: string; action: 'on' | 'off' | 'history'; lang: FloatLang; cap6: bigint | null; chains: EarnChain[] | null; hours: number | null } {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!['walletId', 'action', 'lang', 'cap', 'chains', 'hours'].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  if (typeof rec.walletId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(rec.walletId)) throw new Error('Bad arguments: walletId');
  if (rec.action !== 'on' && rec.action !== 'off' && rec.action !== 'history') throw new Error('Bad arguments: action');
  let chains: EarnChain[] | null = null;
  if (rec.chains != null) {
    const cs = rec.chains;
    if (!Array.isArray(cs) || !cs.length || cs.length > EARN_CHAINS.length || cs.some((c) => !EARN_CHAINS.includes(c as EarnChain)) || new Set(cs).size !== cs.length) throw new Error('Bad arguments: chains');
    chains = cs as EarnChain[];
  }
  const lang = (['en', 'ru', 'zh', 'id', 'es', 'fr'] as const).find((l) => l === rec.lang) ?? 'en';
  if (rec.lang != null && lang !== rec.lang) throw new Error('Bad arguments: lang');
  let cap6: bigint | null = null;
  if (rec.cap != null) {
    if (typeof rec.cap !== 'number' || !Number.isFinite(rec.cap)) throw new Error('Bad arguments: cap');
    cap6 = BigInt(Math.round(rec.cap)) * USD;
    if (cap6 < EARN.capMin6 || cap6 > EARN.capMax6) throw new Error('Bad arguments: cap');
  }
  // r3 (owner): a timed session — 1 to 24 hours, to the minute; left out = until turned off ('on' only)
  let hours: number | null = null;
  if (rec.hours != null) {
    if (rec.action !== 'on' || typeof rec.hours !== 'number' || !Number.isFinite(rec.hours) || rec.hours < EARN.sessionMinH || rec.hours > EARN.sessionMaxH) throw new Error('Bad arguments: hours');
    hours = Math.round(rec.hours * 60) / 60;
  }
  return { walletId: rec.walletId, action: rec.action, lang, cap6, chains, hours };
}

// ── the vault's own dialogs, in the app's six languages ──
type EarnWords = { onTitle: string; onOk: string; offTitle: string; offOk: string; where: string; lines: (cap: string, vault: string) => string[]; risk: string; us: string; off: (usd: string) => string[]; paused: (why: string) => string;
  // review H2: Earn is one device's (stated); review L4: every stop the "on" clears, listed
  device: string; stops: (rows: string[]) => string;
  // r3: a timed session's end, said in the dialog (nothing is locked)
  session: (time: string) => string;
  // r4 (S1): the short confirmation of a session start on a valid permission, and the 90-day reuse in the full dialog
  sessionTitle: string; sessionOk: string; sessionLines: (cap: string, inEarn: string, end: string, until: string) => string[]; reuse: (until: string) => string };
export const EARN_WORDS: Record<FloatLang, EarnWords> = {
  en: {
    sessionTitle: 'Start an Earn session', sessionOk: 'Start',
    sessionLines: (cap, inEarn, end, until) => [`Up to ${cap} of your USD balance goes into the venues below (in Earn now: ${inEarn}).`, `It comes back to your USD balance by itself on ${end}. Nothing is locked: you can withdraw or buy with it any time before.`, `Your Earn permission is valid until ${until} (90 days). Within it each new session asks only this confirmation, without 2FA.`],
    reuse: (until) => `This permission is valid for 90 days (until ${until}). Within it, a new session asks only a short confirmation here, without 2FA.`,
    where: 'Where it goes',
    onTitle: 'Earn on your USD balance', onOk: 'Turn on Earn', offTitle: 'Turn off Earn', offOk: 'Withdraw and turn off',
    lines: (cap, vault) => [
      `Part of your USD balance goes into one lending venue per network (below), where it earns a variable rate, read from each venue — never promised. The rate changes every day and can fall to zero.`,
      `Always kept ready: twice your largest buy, 15 % of the balance, and never less than $25 stay in your USD balance. Only the rest goes in, at most ${cap} for your account.`,
      'A buy larger than what is ready first takes the money it needs out of the vault (one more transaction, about a second).',
      'Only between your own reserve and that vault: nothing else can leave your wallets. Turn it off any time: what the vault can pay out now comes back to your USD balance at once, the rest as soon as the vault allows it (it keeps earning meanwhile).',
    ],
    risk: 'Risks: smart-contract risk and the credit risk of the vault’s loans. There is no insurance. Withdrawals can be delayed if the vault’s liquidity is short. You can lose money.',
    us: 'Not available to persons in the United States.',
    off: (usd) => [`${usd} goes back from the vault to your USD balance.`, 'If the vault’s liquidity is short, part of it may come back later: it keeps earning until it can be withdrawn.'],
    paused: (why) => `Earn is paused: ${why}. Your money stays where it is until you withdraw it.`,
    device: 'Earn runs on one device. Turning it on here stops it on your other devices as soon as they see this one’s moves; turn it off on the device where it runs.',
    stops: (rows) => `Earn stopped earlier. Turning it on again clears every one of these stops: ${rows.join('; ')}.`,
    session: (time) => `This session ends at ${time}: then what the vault can pay comes back to your USD balance by itself. Nothing is locked — you can withdraw or buy with it any time before.`,
  },
  ru: {
    sessionTitle: 'Начать сессию дохода', sessionOk: 'Начать',
    sessionLines: (cap, inEarn, end, until) => [`До ${cap} вашего баланса в USD уходит на площадки ниже (сейчас в доходе: ${inEarn}).`, `Деньги сами вернутся в баланс в USD ${end}. Ничего не заблокировано: до этого можно вывести или покупать в любой момент.`, `Ваше разрешение на доход действует до ${until} (90 дней). В эти дни каждая новая сессия спрашивает только это подтверждение, без 2FA.`],
    reuse: (until) => `Это разрешение действует 90 дней (до ${until}). В эти дни новая сессия спрашивает здесь только короткое подтверждение, без 2FA.`,
    where: 'Куда уходят деньги',
    onTitle: 'Доход на долларовый баланс', onOk: 'Включить доход', offTitle: 'Выключить доход', offOk: 'Вывести и выключить',
    lines: (cap, vault) => [
      `Часть вашего долларового баланса уходит в одну площадку кредитования на каждой сети (ниже) и приносит плавающий доход по ставке, которую показывает сама площадка, — без гарантий. Ставка меняется каждый день и может упасть до нуля.`,
      `Всегда наготове: двойная сумма вашей самой крупной покупки, 15 % баланса и не меньше $25 остаются в долларовом балансе. В хранилище уходит только остальное, не больше ${cap} на аккаунт.`,
      'Покупка больше готовой суммы сначала забирает нужные деньги из хранилища (ещё одна транзакция, около секунды).',
      'Только между вашим резервом и этим хранилищем: больше ничего не может покинуть ваши кошельки. Выключить можно в любой момент: то, что хранилище может выплатить сейчас, сразу вернётся в долларовый баланс, остальное — как только хранилище позволит (пока что оно продолжает приносить доход).',
    ],
    risk: 'Риски: риск смарт-контракта и кредитный риск займов хранилища. Страховки нет. Вывод может задержаться, если в хранилище не хватает ликвидности. Вы можете потерять деньги.',
    us: 'Недоступно для лиц в США.',
    off: (usd) => [`${usd} вернётся из хранилища в долларовый баланс.`, 'Если в хранилище не хватает ликвидности, часть может вернуться позже: она продолжит приносить доход, пока её нельзя вывести.'],
    paused: (why) => `Доход приостановлен: ${why}. Деньги остаются на месте, пока вы их не выведете.`,
    device: 'Доход работает на одном устройстве. Если включить его здесь, на других устройствах он остановится, как только они увидят действия этого; выключайте его на том устройстве, где он работает.',
    stops: (rows) => `Доход ранее останавливался. Повторное включение снимает все эти остановки: ${rows.join('; ')}.`,
    session: (time) => `Сессия заканчивается в ${time}: тогда то, что хранилище может выплатить, само вернётся в долларовый баланс. Ничего не заблокировано — до этого можно вывести или покупать в любой момент.`,
  },
  zh: {
    sessionTitle: '开始一次收益', sessionOk: '开始',
    sessionLines: (cap, inEarn, end, until) => [`您的美元余额中最多 ${cap} 将存入下列平台（当前收益中：${inEarn}）。`, `资金将于 ${end} 自动回到您的美元余额。不会锁定：在此之前您随时可以取出或用于买入。`, `您的收益授权有效期至 ${until}（90 天）。在此期间，每次新的收益只需此确认，无需 2FA。`],
    reuse: (until) => `此授权有效期为 90 天（至 ${until}）。在此期间，新的收益只需在此做简短确认，无需 2FA。`,
    where: '资金去向',
    onTitle: '美元余额赚取收益', onOk: '开启收益', offTitle: '关闭收益', offOk: '取出并关闭',
    lines: (cap, vault) => [
      `您的部分美元余额将存入每条网络上的一个借贷平台（见下），获得浮动收益，利率读取自各平台本身 — 不作承诺。利率每天变化，可能降至零。`,
      `始终保留可用资金：您最大单笔买入的两倍、余额的 15%，且不少于 $25 留在美元余额中。只有其余部分存入，整个账户最多 ${cap}。`,
      '超过可用资金的买入会先从金库取出所需资金（多一笔交易，约一秒）。',
      '资金只在您自己的储备钱包和该金库之间流动：其他任何资金都不会离开您的钱包。随时可以关闭：金库现在能支付的部分立即回到美元余额，其余部分在金库允许时返回（期间继续产生收益）。',
    ],
    risk: '风险：智能合约风险以及金库贷款的信用风险。没有保险。如果金库流动性不足，取款可能延迟。您可能会亏损。',
    us: '不向美国境内人士提供。',
    off: (usd) => [`${usd} 将从金库回到您的美元余额。`, '如果金库流动性不足，部分资金可能稍后才回来：在可以取出之前它会继续产生收益。'],
    paused: (why) => `收益已暂停：${why}。在您取出之前，资金保持原位。`,
    device: '收益只在一台设备上运行。在这里开启后，其他设备一旦看到本设备的操作就会停止；请在正在运行的设备上关闭它。',
    stops: (rows) => `收益此前已停止。再次开启将解除以下所有停止：${rows.join('；')}。`,
    session: (time) => `本次收益在 ${time} 结束：届时金库能支付的部分会自动回到您的美元余额。资金不会被锁定——在此之前您随时可以取出或用于买入。`,
  },
  id: {
    sessionTitle: 'Mulai sesi Earn', sessionOk: 'Mulai',
    sessionLines: (cap, inEarn, end, until) => [`Hingga ${cap} dari saldo USD Anda masuk ke tempat di bawah (di Earn sekarang: ${inEarn}).`, `Dana kembali sendiri ke saldo USD Anda pada ${end}. Tidak ada yang dikunci: sebelum itu Anda bisa menarik atau membeli kapan saja.`, `Izin Earn Anda berlaku sampai ${until} (90 hari). Selama itu setiap sesi baru hanya meminta konfirmasi ini, tanpa 2FA.`],
    reuse: (until) => `Izin ini berlaku 90 hari (sampai ${until}). Selama itu, sesi baru hanya meminta konfirmasi singkat di sini, tanpa 2FA.`,
    where: 'Ke mana dana pergi',
    onTitle: 'Earn di saldo USD Anda', onOk: 'Aktifkan Earn', offTitle: 'Matikan Earn', offOk: 'Tarik dan matikan',
    lines: (cap, vault) => [
      `Sebagian saldo USD Anda masuk ke satu tempat pinjaman per jaringan (di bawah) dan mendapat imbal hasil mengambang, dibaca dari tiap tempat itu sendiri — tidak dijanjikan. Tingkatnya berubah setiap hari dan bisa turun ke nol.`,
      `Selalu siap pakai: dua kali pembelian terbesar Anda, 15 % saldo, dan tidak kurang dari $25 tetap di saldo USD. Hanya sisanya yang masuk, paling banyak ${cap} untuk akun Anda.`,
      'Pembelian yang lebih besar dari dana siap pakai lebih dulu menarik dana yang dibutuhkan dari vault (satu transaksi lagi, sekitar satu detik).',
      'Hanya antara cadangan Anda sendiri dan vault itu: tidak ada hal lain yang bisa keluar dari dompet Anda. Matikan kapan saja: yang bisa dibayar vault sekarang langsung kembali ke saldo USD, sisanya begitu vault mengizinkan (sementara itu tetap menghasilkan).',
    ],
    risk: 'Risiko: risiko kontrak pintar dan risiko kredit pinjaman vault. Tidak ada asuransi. Penarikan bisa tertunda jika likuiditas vault kurang. Anda bisa kehilangan uang.',
    us: 'Tidak tersedia bagi orang di Amerika Serikat.',
    off: (usd) => [`${usd} kembali dari vault ke saldo USD Anda.`, 'Jika likuiditas vault kurang, sebagian bisa kembali nanti: dana itu tetap menghasilkan sampai bisa ditarik.'],
    paused: (why) => `Earn dijeda: ${why}. Dana Anda tetap di tempatnya sampai Anda menariknya.`,
    device: 'Earn berjalan di satu perangkat. Mengaktifkannya di sini menghentikannya di perangkat lain begitu perangkat itu melihat transaksi perangkat ini; matikan di perangkat tempat Earn berjalan.',
    stops: (rows) => `Earn sebelumnya berhenti. Mengaktifkannya lagi menghapus semua penghentian ini: ${rows.join('; ')}.`,
    session: (time) => `Sesi ini berakhir pukul ${time}: lalu yang bisa dibayar vault kembali sendiri ke saldo USD Anda. Tidak ada yang dikunci — sebelum itu Anda bisa menarik atau membeli kapan saja.`,
  },
  es: {
    sessionTitle: 'Empezar una sesión de rendimiento', sessionOk: 'Empezar',
    sessionLines: (cap, inEarn, end, until) => [`Hasta ${cap} de tu saldo en USD va a los protocolos de abajo (ahora en rendimiento: ${inEarn}).`, `Vuelve sola a tu saldo en USD el ${end}. Nada queda bloqueado: antes puedes retirar o comprar cuando quieras.`, `Tu permiso de rendimiento es válido hasta el ${until} (90 días). Mientras tanto, cada sesión nueva solo pide esta confirmación, sin 2FA.`],
    reuse: (until) => `Este permiso es válido 90 días (hasta el ${until}). Mientras tanto, una sesión nueva solo pide aquí una confirmación breve, sin 2FA.`,
    where: 'A dónde va',
    onTitle: 'Rendimiento en tu saldo en USD', onOk: 'Activar rendimiento', offTitle: 'Desactivar rendimiento', offOk: 'Retirar y desactivar',
    lines: (cap, vault) => [
      `Una parte de tu saldo en USD va a un solo protocolo de préstamos por red (abajo), donde obtiene un rendimiento variable, leído de cada protocolo — nunca garantizado. La tasa cambia cada día y puede bajar a cero.`,
      `Siempre disponible: el doble de tu compra más grande, el 15 % del saldo y nunca menos de $25 se quedan en tu saldo en USD. Solo entra el resto, como máximo ${cap} para tu cuenta.`,
      'Una compra mayor que lo disponible primero saca de la bóveda el dinero que necesita (una transacción más, alrededor de un segundo).',
      'Solo entre tu propia reserva y esa bóveda: nada más puede salir de tus monederos. Desactívalo cuando quieras: lo que la bóveda pueda pagar ahora vuelve de inmediato a tu saldo en USD, el resto en cuanto la bóveda lo permita (mientras tanto sigue generando rendimiento).',
    ],
    risk: 'Riesgos: riesgo de contrato inteligente y riesgo de crédito de los préstamos de la bóveda. No hay seguro. Los retiros pueden retrasarse si la bóveda no tiene liquidez suficiente. Puedes perder dinero.',
    us: 'No disponible para personas en los Estados Unidos.',
    off: (usd) => [`${usd} vuelve de la bóveda a tu saldo en USD.`, 'Si la bóveda no tiene liquidez suficiente, una parte puede volver más tarde: sigue generando rendimiento hasta que se pueda retirar.'],
    paused: (why) => `El rendimiento está en pausa: ${why}. Tu dinero se queda donde está hasta que lo retires.`,
    device: 'El rendimiento funciona en un solo dispositivo. Activarlo aquí lo detiene en tus otros dispositivos en cuanto vean los movimientos de este; desactívalo en el dispositivo donde funciona.',
    stops: (rows) => `El rendimiento se detuvo antes. Activarlo de nuevo levanta todas estas paradas: ${rows.join('; ')}.`,
    session: (time) => `Esta sesión termina a las ${time}: entonces lo que la bóveda pueda pagar vuelve solo a tu saldo en USD. Nada queda bloqueado: antes puedes retirar o comprar cuando quieras.`,
  },
  fr: {
    sessionTitle: 'Démarrer une session de rendement', sessionOk: 'Démarrer',
    sessionLines: (cap, inEarn, end, until) => [`Jusqu’à ${cap} de votre solde en USD va dans les protocoles ci-dessous (en rendement maintenant : ${inEarn}).`, `Il revient tout seul dans votre solde en USD le ${end}. Rien n’est bloqué : avant, vous pouvez retirer ou acheter à tout moment.`, `Votre autorisation de rendement est valable jusqu’au ${until} (90 jours). Pendant ce temps, chaque nouvelle session ne demande que cette confirmation, sans 2FA.`],
    reuse: (until) => `Cette autorisation est valable 90 jours (jusqu’au ${until}). Pendant ce temps, une nouvelle session ne demande ici qu’une brève confirmation, sans 2FA.`,
    where: 'Où va l’argent',
    onTitle: 'Rendement sur votre solde en USD', onOk: 'Activer le rendement', offTitle: 'Désactiver le rendement', offOk: 'Retirer et désactiver',
    lines: (cap, vault) => [
      `Une partie de votre solde en USD va dans un seul protocole de prêt par réseau (ci-dessous), où elle rapporte un taux variable, lu auprès de chaque protocole — jamais garanti. Le taux change chaque jour et peut tomber à zéro.`,
      `Toujours disponible : le double de votre plus gros achat, 15 % du solde et jamais moins de $25 restent dans votre solde en USD. Seul le reste y va, au plus ${cap} pour votre compte.`,
      'Un achat plus grand que ce qui est disponible retire d’abord du coffre l’argent nécessaire (une transaction de plus, environ une seconde).',
      'Uniquement entre votre propre réserve et ce coffre : rien d’autre ne peut quitter vos portefeuilles. Désactivez-le quand vous voulez : ce que le coffre peut payer maintenant revient aussitôt dans votre solde en USD, le reste dès que le coffre le permet (il continue de rapporter entre-temps).',
    ],
    risk: 'Risques : risque de contrat intelligent et risque de crédit des prêts du coffre. Pas d’assurance. Les retraits peuvent être retardés si la liquidité du coffre est insuffisante. Vous pouvez perdre de l’argent.',
    us: 'Non disponible pour les personnes aux États-Unis.',
    off: (usd) => [`${usd} revient du coffre dans votre solde en USD.`, 'Si la liquidité du coffre est insuffisante, une partie peut revenir plus tard : elle continue de rapporter jusqu’à ce qu’elle puisse être retirée.'],
    paused: (why) => `Le rendement est en pause : ${why}. Votre argent reste où il est jusqu’à ce que vous le retiriez.`,
    device: 'Le rendement fonctionne sur un seul appareil. L’activer ici l’arrête sur vos autres appareils dès qu’ils voient les opérations de celui-ci ; désactivez-le sur l’appareil où il fonctionne.',
    stops: (rows) => `Le rendement s’était arrêté. Le réactiver lève tous ces arrêts : ${rows.join(' ; ')}.`,
    session: (time) => `Cette session se termine à ${time} : ce que le coffre peut payer revient alors tout seul dans votre solde en USD. Rien n’est bloqué — avant, vous pouvez retirer ou acheter à tout moment.`,
  },
};
// release #5 (2026-11-04, owner: Earn for everyone): the one-time self-attestation, ticked in the turn-on dialog before the first
// deposit and kept per account with its time (trenches.earn.v2.attest). Asked of every account — the server's country check
// (a local IP file) cannot see a VPN or a US person abroad, and an unknown country is let through only because of this line.
export const EARN_ATTEST_V = 1;
export const EARN_ATTEST: Record<FloatLang, { line: string; need: string }> = {
  en: { line: 'I am not a US person or resident, I am not in the United States, and I am not a resident of, or located in, a country or region under comprehensive sanctions (Cuba, Iran, North Korea, Syria, Russia, Belarus, Crimea, Donetsk, Luhansk, Kherson, Zaporizhzhia and similar) or the United Kingdom. I am not a sanctioned person.', need: 'Tick the line about where you are to continue.' },
  ru: { line: 'Я не являюсь гражданином или резидентом США, не нахожусь в США, не проживаю и не нахожусь в стране или регионе под всеобъемлющими санкциями (Куба, Иран, КНДР, Сирия, Россия, Беларусь, Крым, Донецк, Луганск, Херсон, Запорожье и подобные) или в Великобритании. Я не нахожусь под санкциями.', need: 'Отметьте строку о том, где вы находитесь, чтобы продолжить.' },
  zh: { line: '我不是美国人士或美国居民，不在美国境内，也不居住或身处受全面制裁的国家或地区（古巴、伊朗、朝鲜、叙利亚、俄罗斯、白俄罗斯、克里米亚、顿涅茨克、卢甘斯克、赫尔松、扎波罗热等）或英国。我不是受制裁人士。', need: '请勾选关于您所在地的声明以继续。' },
  id: { line: 'Saya bukan warga atau penduduk Amerika Serikat, tidak berada di Amerika Serikat, dan tidak tinggal atau berada di negara atau wilayah yang terkena sanksi menyeluruh (Kuba, Iran, Korea Utara, Suriah, Rusia, Belarus, Krimea, Donetsk, Luhansk, Kherson, Zaporizhzhia, dan sejenisnya) atau di Inggris. Saya bukan orang yang terkena sanksi.', need: 'Centang pernyataan tentang lokasi Anda untuk melanjutkan.' },
  es: { line: 'No soy una persona ni residente de EE. UU., no estoy en Estados Unidos y no resido ni me encuentro en un país o región bajo sanciones integrales (Cuba, Irán, Corea del Norte, Siria, Rusia, Bielorrusia, Crimea, Donetsk, Lugansk, Jersón, Zaporiyia y similares) ni en el Reino Unido. No soy una persona sancionada.', need: 'Marca la línea sobre dónde estás para continuar.' },
  fr: { line: 'Je ne suis ni une personne ni un résident des États-Unis, je ne suis pas aux États-Unis, et je ne réside pas ni ne me trouve dans un pays ou une région sous sanctions globales (Cuba, Iran, Corée du Nord, Syrie, Russie, Biélorussie, Crimée, Donetsk, Louhansk, Kherson, Zaporijjia et similaires) ni au Royaume-Uni. Je ne suis pas une personne sanctionnée.', need: 'Cochez la ligne sur l’endroit où vous êtes pour continuer.' },
};
export function earnAttestHtml(lang: FloatLang, esc: (v: unknown) => string): string {
  const A = EARN_ATTEST[lang] ?? EARN_ATTEST.en;
  return `<label class="dk-pick"><input type="checkbox" data-earn-attest><span class="dk-nm dk-decl">${esc(A.line)}</span></label>`;
}
export const CHAIN_NAME: Record<EarnChain, string> = { robinhood: 'Robinhood Chain', bsc: 'BNB Chain', sol: 'Solana' };
/** The venue of each chain switched on, one row each ("Robinhood Chain · Morpho · Steakhouse USDG (USDG)"). */
export const venueRows = (chains: readonly EarnChain[]) => chains.map((c) => { const v = EARN_VAULTS[c]; return `${CHAIN_NAME[c]} · ${v.protocol} · ${v.name} (${v.assetSymbol})`; });
export function earnOnHtml(lang: FloatLang, cap6: bigint, esc: (v: unknown) => string, chains: readonly EarnChain[] = ['robinhood'], sessionEnd: string | null = null, permUntil: string | null = null): string {
  const W = EARN_WORDS[lang] ?? EARN_WORDS.en;
  const lines = W.lines(fmtUsd6(cap6), EARN_VAULTS.robinhood.name);
  const rows = venueRows(chains).map((r) => `<div class="ub-r"><span class="ub-n" translate="no">${esc(r)}</span></div>`).join('');
  return `<p class="ub-lead">${esc(lines[0])}</p><p class="ub-note">${esc(W.where)}</p>${rows}${lines.slice(1).map((l) => `<p class="ub-note">${esc(l)}</p>`).join('')}<p class="ub-note">${esc(W.device)}</p>${sessionEnd ? `<p class="ub-note">${esc(W.session(sessionEnd))}</p>` : ''}${permUntil ? `<p class="ub-note">${esc(W.reuse(permUntil))}</p>` : ''}<p class="ub-skip">${esc(W.risk)}</p><p class="ub-note">${esc(W.us)}</p>`;
}
export function earnOffHtml(lang: FloatLang, usd6: bigint, esc: (v: unknown) => string): string {
  const W = EARN_WORDS[lang] ?? EARN_WORDS.en;
  const [a, b] = W.off(fmtUsd6(usd6));
  return `<p class="ub-lead">${esc(a)}</p><p class="ub-note">${esc(b)}</p>`;
}

/** r4 (S1): a session start on a valid, unchanged 90-day permission — the short vault confirmation (no 2FA) */
export function earnSessionHtml(lang: FloatLang, cap: string, inEarn: string, end: string, until: string, esc: (v: unknown) => string, chains: readonly EarnChain[]): string {
  const W = EARN_WORDS[lang] ?? EARN_WORDS.en; const [a, b, c] = W.sessionLines(cap, inEarn, end, until);
  const rows = venueRows(chains).map((r) => `<div class="ub-r"><span class="ub-n" translate="no">${esc(r)}</span></div>`).join('');
  return `<p class="ub-lead">${esc(a)}</p>${rows}<p class="ub-note">${esc(b)}</p><p class="ub-note">${esc(c)}</p><p class="ub-skip">${esc(W.risk)}</p>`;
}
