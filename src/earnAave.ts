// Earn on the USD balance — BNB Chain: USDC in Aave v3 (pure rules; the engine side is src/earnEngine.ts, adapter 'aave3').
// Every address and fact below was read on chain on 2026-11-03 (bsc-rpc.publicnode.com, eth_call / getCode / getStorageAt only;
// local earn-mvp/logs/bnb-aave-readonly-probe.log). Aave v3 is the lower-risk choice on BNB (Venus Core: a documented
// alternative only, notes.txt). R signs exactly three kinds of call here: approve(Pool, exact) on USDC; Pool.supply(USDC, amount,
// onBehalfOf = R, referral 0); Pool.withdraw(USDC, amount, to = R). The aToken (aBnbUSDC) is R's receipt; it accrues by itself.
import { decodeFunctionData, encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { USD } from './floatCore.ts';

export type AaveCfg = {
  kind: 'aave3'; chain: 'bsc'; chainId: 56; name: string; protocol: 'Aave';
  pool: `0x${string}`; asset: `0x${string}`; aToken: `0x${string}`; assetSymbol: string; assetDecimals: number;
  // the Pool and the aToken are upgradeable proxies (Aave governance): their EIP-1967 implementation slots as read on 2026-11-03.
  // Another implementation = new code: nothing new goes in until a build pins it again (withdrawals go on, simulated first)
  poolImpl: string; aTokenImpl: string;
  // read every vault check: Pool.ADDRESSES_PROVIDER() must name it (review L5)
  addressesProvider: `0x${string}`;
  // BSC USDC (Binance-Peg) is itself an upgradeable proxy: its EIP-1967 implementation as read on 2026-11-03 (review L5)
  assetImpl: string;
};
export const AAVE_BSC: AaveCfg = {
  kind: 'aave3', chain: 'bsc', chainId: 56, name: 'Aave v3 USDC', protocol: 'Aave',
  pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', aToken: '0x00901a076785e0906d1028c7d6372d247bec7d61', assetSymbol: 'USDC', assetDecimals: 18,
  poolImpl: '0x5e2b0fcc5b9734c7ec0a03401ee9e6805f783b6d', aTokenImpl: '0x7e199fc666368d95b9eaefa7d2d8081acab74134',
  addressesProvider: '0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D',
  assetImpl: '0xba5fe23f8a3a24bed3236f05f2fcf35fd0bf0b5c',
};
export const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const AAVE_SELECTORS = { approve: '0x095ea7b3', supply: '0x617ba037', withdraw: '0x69328dec' } as const;
export const AAVE_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'scaledBalanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'UNDERLYING_ASSET_ADDRESS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'POOL', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'supply', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  // what the Pool can pay out now (v3.1+ virtual accounting; read 2026-11-03: 1,102,142 USDC vs USDC.balanceOf(aToken) 1,103,486 —
  // the Pool pays out of the virtual balance, so it is the liquidity a withdrawal sees; review M7). Selector 0x6fb07f96
  { name: 'getVirtualUnderlyingBalance', type: 'function', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'uint128' }] },
  { name: 'ADDRESSES_PROVIDER', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'getReserveNormalizedIncome', type: 'function', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
// getReserveData(address) — decoded by word (the v3 ReserveDataLegacy layout, 15 words, read 2026-11-03): 0 configuration bitmap,
// 1 liquidityIndex (ray), 2 currentLiquidityRate (ray, APR), …, 8 aTokenAddress
export const getReserveDataData = (asset: string) => ('0x35ea6a75' + asset.toLowerCase().replace(/^0x/, '').padStart(64, '0')) as Hex;
export const AAVE_TOPIC = {
  supply: keccak256(toHex('Supply(address,address,address,uint256,uint16)')),
  withdraw: keccak256(toHex('Withdraw(address,address,address,uint256)')),
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const;
export const MAX_UINT = (1n << 256n) - 1n;
export type ReserveFacts = { active: boolean; frozen: boolean; paused: boolean; index: bigint; rateRay: bigint; aToken: string; decimals: number };
const word = (hex: string, i: number): bigint => BigInt('0x' + (hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));
const lc = (a: string) => String(a || '').toLowerCase();
const addrOf = (topic: string | undefined): string => (topic && topic.length === 66 ? '0x' + topic.slice(26).toLowerCase() : '');
export function reserveFacts(ret: Hex | null): ReserveFacts | null {
  if (!ret || ret.length < 2 + 64 * 15) return null;
  const cfg = word(ret, 0); const bit = (n: number) => ((cfg >> BigInt(n)) & 1n) === 1n;
  return { active: bit(56), frozen: bit(57), paused: bit(60), index: word(ret, 1), rateRay: word(ret, 2), aToken: '0x' + word(ret, 8).toString(16).padStart(40, '0'), decimals: Number((cfg >> 48n) & 255n) };
}
/** The reserve's supply APR (ray) as an APY, compounding per second, in basis points — a read, never a promise. */
export function aaveApyBps(rateRay: bigint): number {
  const apr = Number(rateRay) / 1e27; if (!(apr >= 0) || apr > 5) return 0;
  return Math.round((Math.pow(1 + apr / 31_536_000, 31_536_000) - 1) * 10_000);
}

export const aaveApproveData = (c: AaveCfg, amount: bigint) => encodeFunctionData({ abi: AAVE_ABI, functionName: 'approve', args: [c.pool, amount] });
export const aaveSupplyData = (c: AaveCfg, amount: bigint, r: `0x${string}`) => encodeFunctionData({ abi: AAVE_ABI, functionName: 'supply', args: [c.asset, amount, r, 0] });
export const aaveWithdrawData = (c: AaveCfg, amount: bigint, r: `0x${string}`) => encodeFunctionData({ abi: AAVE_ABI, functionName: 'withdraw', args: [c.asset, amount, r] });

/**
 * null = one of the three calls this R may sign on BNB; else why not. approve(Pool, ≤ one deposit) on USDC; supply(USDC,
 * 0 < amount ≤ one deposit, onBehalfOf = R, referral 0) / withdraw(USDC, 0 < amount ≤ one withdrawal or everything (max), to = R)
 * on the Pool; value 0; exact calldata lengths; chain 56.
 */
export function aaveTxProblem(tx: { to: string; data: string; value: bigint }, ctx: { r: string; chainId: number; cfg: AaveCfg; perTxMax6: bigint; withdrawMax6: bigint }): string | null {
  const c = ctx.cfg;
  if (ctx.chainId !== c.chainId) return 'wrong chain';
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(ctx.r))) return 'no reserve';
  if (typeof tx.value !== 'bigint' || tx.value !== 0n) return 'value must be 0';
  const data = String(tx.data || ''); if (!/^0x[0-9a-fA-F]*$/.test(data)) return 'bad calldata';
  const sel = data.slice(0, 10).toLowerCase(); const to = lc(tx.to); const r = lc(ctx.r);
  const scale = 10n ** BigInt(Math.max(0, c.assetDecimals - 6));
  if (to === lc(c.asset)) {
    if (sel !== AAVE_SELECTORS.approve || data.length !== 10 + 128) return 'only approve on the asset';
    const [spender, amount] = decodeFunctionData({ abi: AAVE_ABI, data: data as Hex }).args as readonly [string, bigint];
    if (lc(spender) !== lc(c.pool)) return 'approve names another spender';
    if (amount > ctx.perTxMax6 * scale) return 'approve above one deposit';
    return null;
  }
  if (to !== lc(c.pool)) return 'not the Aave pool';
  if (sel === AAVE_SELECTORS.supply) {
    if (data.length !== 10 + 256) return 'bad supply';
    const [asset, amount, onBehalfOf, ref] = decodeFunctionData({ abi: AAVE_ABI, data: data as Hex }).args as readonly [string, bigint, string, number];
    if (lc(asset) !== lc(c.asset)) return 'supply of another asset';
    if (!(amount > 0n) || amount > ctx.perTxMax6 * scale) return 'supply amount out of bounds';
    if (lc(onBehalfOf) !== r) return 'supply on behalf of someone else';
    if (Number(ref) !== 0) return 'referral code';
    return null;
  }
  if (sel === AAVE_SELECTORS.withdraw) {
    if (data.length !== 10 + 192) return 'bad withdraw';
    const [asset, amount, to2] = decodeFunctionData({ abi: AAVE_ABI, data: data as Hex }).args as readonly [string, bigint, string];
    if (lc(asset) !== lc(c.asset)) return 'withdraw of another asset';
    if (!(amount > 0n) || (amount !== MAX_UINT && amount > ctx.withdrawMax6 * scale)) return 'withdraw amount out of bounds';
    if (lc(to2) !== r) return 'withdraw to someone else';
    return null;
  }
  return 'selector not allowed';
}

export type Log = { address: string; topics: readonly string[]; data: string };
/** supply's receipt: USDC from R to the aToken, exactly `amount`; the Pool's Supply event for USDC, onBehalfOf R, that amount. */
export function aaveSupplyOutcome(logs: readonly Log[], c: AaveCfg, r: string, amount: bigint): { ok: true } | { why: string } {
  const R = lc(r);
  const outs = logs.filter((l) => lc(l.address) === lc(c.asset) && l.topics[0] === AAVE_TOPIC.transfer && addrOf(l.topics[1]) === R);
  if (outs.length !== 1 || addrOf(outs[0].topics[2]) !== lc(c.aToken) || word(outs[0].data, 0) !== amount) return { why: 'the supply did not move exactly the amount from the reserve to Aave' };
  const ev = logs.filter((l) => lc(l.address) === lc(c.pool) && l.topics[0] === AAVE_TOPIC.supply);
  if (ev.length !== 1 || addrOf(ev[0].topics[1]) !== lc(c.asset) || addrOf(ev[0].topics[2]) !== R) return { why: 'Aave did not record the supply for the reserve' };
  // data: user (the caller: R itself), amount — the event shape read with eth_getLogs on 2026-11-03 (4 topics, 64 data bytes)
  if ('0x' + word(ev[0].data, 0).toString(16).padStart(40, '0') !== R) return { why: 'Aave recorded another caller' };
  if (word(ev[0].data, 1) !== amount) return { why: 'Aave recorded another amount' };
  return { ok: true };
}
/** withdraw's receipt: the Pool's Withdraw event for USDC, user R, to R; USDC from the aToken to R equal to it (≥ minAmount). */
export function aaveWithdrawOutcome(logs: readonly Log[], c: AaveCfg, r: string, minAmount: bigint): { amount: bigint } | { why: string } {
  const R = lc(r);
  const ev = logs.filter((l) => lc(l.address) === lc(c.pool) && l.topics[0] === AAVE_TOPIC.withdraw);
  if (ev.length !== 1 || addrOf(ev[0].topics[1]) !== lc(c.asset) || addrOf(ev[0].topics[2]) !== R || addrOf(ev[0].topics[3]) !== R) return { why: 'Aave did not record a withdrawal to the reserve' };
  const amount = word(ev[0].data, 0);
  const ins = logs.filter((l) => lc(l.address) === lc(c.asset) && l.topics[0] === AAVE_TOPIC.transfer && addrOf(l.topics[2]) === R);
  const paid = ins.reduce((t, l) => t + word(l.data, 0), 0n);
  if (paid !== amount) return { why: 'the reserve did not receive what Aave recorded' };
  if (amount < minAmount) return { why: 'Aave paid less than simulated' };
  return { amount };
}
/** aToken balances are balance = scaled × index: within 2 wei of the amount a supply / withdrawal moved (plus the interest
 *  of the seconds — up to EARN.verifyMs when a read lagged — between the two reads, bounded here by 1 bp of the larger balance;
 *  r2: a first supply's slack was 2 wei, so any interest between the receipt and the read looked like a mismatch). */
export function aaveDeltaOk(before: bigint, after: bigint, amount: bigint, dir: 'in' | 'out'): boolean {
  const slack = 2n + (dir === 'in' ? before + amount : before) / 10_000n;
  return dir === 'in' ? after + 2n >= before + amount && after <= before + amount + slack : after + amount + 2n >= before && after + amount <= before + slack;
}
export const AAVE_MIN_LIQUIDITY6 = 1_000n * USD;
