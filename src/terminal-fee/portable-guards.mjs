// Portable copies of independently checked terminal instruction/balance guards.
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer/index.js';
import { SOL, associatedTokenAddress, tokenState, accountBytes } from './portable-wire.mjs';
const MAX_RENT = 30_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const discriminator = (name) => Buffer.from(sha256(new TextEncoder().encode('global:' + name))).subarray(0, 8).toString('hex');
const ROUTE = discriminator('route'), SHARED = discriminator('shared_accounts_route'), ROUTE_V2 = discriminator('route_v2'), SHARED_V2 = discriminator('shared_accounts_route_v2');
// Jupiter v6 event-authority PDA (seed "__event_authority"), constant for the program; pinned from recorded builds.
const JUP_EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
export class SolanaSwapError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'SolanaSwapError'; this.code = code; this.status = status; this.statusCode = status; }
}
const refuse = (message, code = 'unsafe_route', status = 502) => { throw new SolanaSwapError(code, message, status); };
function uint(value, label) { if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) refuse(`${label} must be a positive base-unit integer`, 'bad_request', 400); const n = BigInt(value); if (n > U64_MAX) refuse(`${label} exceeds u64`, 'bad_request', 400); return n; }
function key(value, label) { try { return publicKey(value); } catch { refuse(`invalid ${label}`, 'bad_request', 400); } }
const sameToken = (a, b) => a && b && a.mint === b.mint && a.owner === b.owner && a.program === b.program && a.invariant === b.invariant;

// Explicitly decoded instruction ABI, not trust in the HTTP fee / minimum labels.
// V1 public IDL: jup-ag/jupiter-amm-implementation/idls/jupiter_aggregator_v6.json.
// V2 uses a fixed header before route_plan; pinned real /build fixture in tests.
export function verifySolanaSwapInstruction(ix, { trader, inputMint, outputMint, inputAta, outputAta, feeAccount, amount, outAmount, slippageBps, feeBps }) {
  if (![0, 5, 10, 15, 20].includes(feeBps)) refuse('terminal fee policy tier is invalid');
  if (ix.programId !== SOL.jupiter) refuse('unexpected swap program');
  const d = ix.data, k = ix.accounts, disc = d.subarray(0, 8).toString('hex');
  let a, out, slip, fee, authority, source, destination, feeIndex;
  if (disc === ROUTE_V2 || disc === SHARED_V2) {
    // Recorded real /swap/v2/build layouts (tests/recorded):
    //   route_v2:                 0 authority(S) 1 source 2 destination 3 srcMint 4 dstMint 5 srcProgram 6 dstProgram
    //                             7 alternate destination (Jupiter sentinel = none) 8 event authority 9 Jupiter
    //   shared_accounts_route_v2: 0 program authority 1 authority(S) 2 source 3 program source 4 program destination
    //                             5 destination 6 srcMint 7 dstMint 8 srcProgram 9 dstProgram 10 event authority 11 Jupiter
    // Platform fee account = first account after the fixed list, present ONLY when platform_fee_bps > 0.
    // Args: [u8 id (shared only)] u64 in, u64 quoted out, u16 slippage, u16 platform fee, u16 positive-slippage fee, vec route.
    const shared = disc === SHARED_V2, h = shared ? 9 : 8, m = shared ? 6 : 3, fixed = shared ? 12 : 10;
    if (d.length < h + 26 || k.length < fixed + (feeBps > 0 ? 1 : 0)) refuse('short route_v2');
    a = d.readBigUInt64LE(h); out = d.readBigUInt64LE(h + 8); slip = d.readUInt16LE(h + 16); fee = d.readUInt16LE(h + 18);
    if (d.readUInt16LE(h + 20) !== 0) refuse('positive-slippage fee is not permitted');
    authority = shared ? 1 : 0; source = shared ? 2 : 1; destination = shared ? 5 : 2; feeIndex = fixed;
    if (k[m].pubkey !== inputMint || k[m + 1].pubkey !== outputMint || ![SOL.token, SOL.token22].includes(k[m + 2].pubkey) || ![SOL.token, SOL.token22].includes(k[m + 3].pubkey)) refuse('swap mint/program mismatch');
    if (k[fixed - 2].pubkey !== JUP_EVENT_AUTHORITY || k[fixed - 1].pubkey !== SOL.jupiter) refuse('unexpected Jupiter event authority');
    if (!shared && k[7].pubkey !== SOL.jupiter) refuse('alternate destination is not permitted');
    if (shared && (k[0].isSigner || [trader, inputAta, outputAta, feeAccount].includes(k[0].pubkey) || k[3].pubkey === k[4].pubkey || [k[3].pubkey, k[4].pubkey].some(x => [trader, inputAta, outputAta, feeAccount].includes(x)))) refuse('shared route program accounts mismatch');
  } else if (disc === ROUTE || disc === SHARED) {
    if (d.length < 32) refuse('short legacy route');
    const off = d.length - 19;
    a = d.readBigUInt64LE(off); out = d.readBigUInt64LE(off + 8); slip = d.readUInt16LE(off + 16); fee = d[off + 18];
    if (disc === ROUTE) { authority = 1; source = 2; destination = 3; feeIndex = 6; if (k[5]?.pubkey !== outputMint || k[4]?.pubkey !== SOL.jupiter) refuse('legacy destination mismatch'); }
    else { authority = 2; source = 3; destination = 6; feeIndex = 9; if (k[7]?.pubkey !== inputMint || k[8]?.pubkey !== outputMint) refuse('shared mint mismatch'); }
  } else refuse('unsupported Jupiter instruction version');
  if (a !== amount || out !== outAmount || slip !== slippageBps || fee !== feeBps) refuse('encoded amount, minimum or terminal fee differs from the request');
  if (k[authority]?.pubkey !== trader || !k[authority]?.isSigner || k[source]?.pubkey !== inputAta || k[destination]?.pubkey !== outputAta || !(feeBps === 0 ? (disc === ROUTE_V2 || disc === SHARED_V2 || k[feeIndex]?.pubkey === SOL.jupiter || k[feeIndex]?.pubkey === feeAccount) : (k[feeIndex]?.pubkey === feeAccount && k[feeIndex]?.isWritable))) refuse('encoded trader, destination or fee recipient differs');
  if (k.some((a) => a.isSigner && a.pubkey !== trader)) refuse('unexpected transaction signer');
}

export function validateOuter(instructions, { trader, side, amount, wsolAta, swap }) {
  let wrapped = 0n, budgetLimit = false, budgetPrice = false, opens = 0;
  const setupAccounts = new Map();
  for (const ix of instructions) {
    const k = ix.accounts.map((a) => a.pubkey), d = ix.data;
    if (ix.accounts.some((a) => a.isSigner && a.pubkey !== trader)) refuse('unexpected signer');
    if (ix === swap) continue;
    if (ix.programId === SOL.budget && !k.length) {
      if (d.length === 5 && d[0] === 2 && !budgetLimit && d.readUInt32LE(1) > 0 && d.readUInt32LE(1) <= 1_400_000) { budgetLimit = true; continue; }
      if (d.length === 9 && d[0] === 3 && !budgetPrice && d.readBigUInt64LE(1) <= 3_000_000n) { budgetPrice = true; continue; }
      refuse('unsafe compute budget');
    }
    if (ix.programId === SOL.ata && (d.length === 0 || (d.length === 1 && d[0] <= 1)) && k.length >= 6 && k[0] === trader && k[2] === trader && k[4] === SOL.system && [SOL.token, SOL.token22].includes(k[5]) && k[1] === associatedTokenAddress(trader, k[3], k[5])) { if (++opens > 6) refuse('too many account creations'); setupAccounts.set(k[1], { address: k[1], mint: k[3], program: k[5] }); continue; }
    if (ix.programId === SOL.system && side === 'buy' && d.length === 12 && d.readUInt32LE(0) === 2 && k.length === 2 && k[0] === trader && k[1] === wsolAta) { wrapped += d.readBigUInt64LE(4); if (wrapped > amount) refuse('SOL wrapping exceeds input'); continue; }
    if (ix.programId === SOL.token && d.length === 1 && ((d[0] === 17 && k.length === 1 && k[0] === wsolAta) || (d[0] === 9 && k.length === 3 && k[0] === wsolAta && k[1] === trader && k[2] === trader))) continue;
    refuse('unsupported top-level instruction');
  }
  return [...setupAccounts.values()];
}

// A simulation cannot authorize a different transaction: its exact message is the returned message.
// All existing token accounts are protected, including zero-balance accounts and authorities.
export function verifySolanaSimulation({ simulation, addresses, before, trader, coinAta, wsolAta, feeAccount, side, amount, minOut, networkFee, maxNative, feeBps, setupAccounts = [] }) {
  if (![0, 5, 10, 15, 20].includes(feeBps)) refuse('terminal fee policy tier is invalid');
  if (!simulation || simulation.err) refuse('Solana swap simulation failed', 'simulation_failed', 422);
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== addresses.length || !Array.isArray(simulation.innerInstructions)) refuse('RPC omitted simulation balances or inner instructions');
  const after = new Map(addresses.map((a, i) => [a, simulation.accounts[i]]));
  // A route may retain an intermediate ATA as well as the output ATA. Include
  // every validated setup account in both snapshots before accounting for rent.
  for (const expected of setupAccounts) {
    if (!before.has(expected.address) || !after.has(expected.address)) refuse('setup account snapshot missing');
    const prior = before.get(expected.address), next = after.get(expected.address);
    const old = tokenState(prior), current = tokenState(next);
    if (prior && (!old || old.owner !== trader || old.mint !== expected.mint || old.program !== expected.program)) refuse('existing setup account mismatch');
    // Live RPCs may return a closed account as an empty, zero-lamport system
    // account instead of null. No funded, executable or data-bearing account
    // qualifies as closed.
    const closed = !next || (next.owner === SOL.system && next.lamports === 0 && next.executable === false && accountBytes(next)?.length === 0);
    if (closed) {
      if (!prior || (expected.address === wsolAta && old?.amount === 0n)) continue;
      refuse('existing setup account was closed');
    }
    if (!current || current.owner !== trader || current.mint !== expected.mint || current.program !== expected.program || current.state !== 1) refuse('setup token account changed');
    if (!prior && (!/^0+$/.test(current.delegate) || !/^0+$/.test(current.closeAuthority))) refuse('new setup account has unexpected authority');
  }
  const created = new Set(); let rent = 0n, wrapped = 0n, coinSpent = 0n;
  for (const group of simulation.innerInstructions) for (const ix of group.instructions || []) {
    const p = ix.parsed, info = p?.info || {};
    if (ix.program === 'system' && ['createAccount', 'createAccountWithSeed'].includes(p?.type) && info.source === trader) {
      const n = BigInt(info.lamports ?? -1); if (n < 0n || n > 5_000_000n) refuse('unexpected account rent'); rent += n; created.add(info.newAccount);
    }
    if (ix.program === 'spl-associated-token-account' && ['create', 'createIdempotent'].includes(p?.type) && info.wallet === trader) created.add(info.account);
  }
  if (rent > MAX_RENT || created.size > 12) refuse('account rent exceeds bound');
  for (const group of simulation.innerInstructions) for (const ix of group.instructions || []) {
    const p = ix.parsed, info = p?.info || {}, type = p?.type;
    if (!p) { if ([SOL.system, SOL.token, SOL.token22].includes(ix.programId)) refuse('unparsed sensitive inner instruction'); continue; }
    if (ix.program === 'system' && type === 'transfer' && info.source === trader) {
      if (side === 'buy' && info.destination === wsolAta) { wrapped += BigInt(info.lamports); continue; }
      if (created.has(info.destination)) continue;
      refuse('unexpected inner SOL transfer');
    }
    if (ix.program === 'system' && info.source === trader && !['transfer', 'createAccount', 'createAccountWithSeed'].includes(type)) refuse('unexpected system authority operation');
    if (['spl-token', 'spl-token-2022'].includes(ix.program)) {
      const authority = info.authority ?? info.owner ?? info.multisigAuthority ?? info.multisigOwner;
      if (created.has(info.account) && ['initializeAccount', 'initializeAccount2', 'initializeAccount3', 'initializeImmutableOwner'].includes(type)) continue;
      if (authority !== trader) continue;
      if (['transfer', 'transferChecked'].includes(type)) {
        const n = BigInt(info.amount ?? info.tokenAmount?.amount ?? -1); if (n < 0n) refuse('invalid transfer amount');
        if (info.source === coinAta && side === 'sell') { coinSpent += n; continue; }
        if (info.source === wsolAta || created.has(info.source)) continue;
        // Existing route-through accounts must retain all balances and authorities below.
        if (before.has(info.source) && tokenState(before.get(info.source))?.owner === trader) continue;
        refuse('unexpected token debit');
      }
      if (type === 'syncNative') continue;
      if (type === 'closeAccount' && info.destination === trader && (info.account === wsolAta || created.has(info.account))) continue;
      refuse('unexpected token authority operation');
    }
  }
  if (wrapped > amount || coinSpent > (side === 'sell' ? amount : 0n)) refuse('inner debit exceeds input');
  const user0 = before.get(trader), user1 = after.get(trader);
  if (!user0 || !user1 || user0.owner !== SOL.system || user1.owner !== SOL.system || accountBytes(user1)?.length) refuse('wallet account changed');
  if (![user0.lamports, user1.lamports].every(Number.isSafeInteger)) refuse('wallet balance exceeds safe RPC precision');
  const nativeDelta = BigInt(user1.lamports) - BigInt(user0.lamports);
  const coin0 = tokenState(before.get(coinAta)), coin1 = tokenState(after.get(coinAta));
  if (!coin1 || coin1.owner !== trader || (coin0 && !sameToken(coin0, coin1))) refuse('trade token account changed');
  const coinDelta = coin1.amount - (coin0?.amount ?? 0n);
  for (const [address, account] of before) {
    const old = tokenState(account); if (!old || old.owner !== trader || address === coinAta || address === wsolAta) continue;
    const next = tokenState(after.get(address)); if (!sameToken(old, next) || next.amount < old.amount) refuse('another wallet token account was changed');
  }
  const w0 = tokenState(before.get(wsolAta)), w1 = tokenState(after.get(wsolAta));
  if (w0?.amount > 0n || (w1 && (w1.owner !== trader || w1.amount !== 0n))) refuse('nonzero wrapped SOL must be unwrapped before this route');
  if (w0 && w1 && !sameToken(w0, w1)) refuse('wrapped SOL account changed');
  // Measure retained rent, not creation instructions: a temporary WSOL account is
  // closed in this same transaction, and an existing empty WSOL account refunds
  // its old rent. Neither refund is swap proceeds. All observed trader token
  // accounts have zero native principal (WSOL checked above).
  rent = 0n;
  for (const address of addresses) {
    const prior = before.get(address), next = after.get(address);
    const oldToken = tokenState(prior), nextToken = tokenState(next);
    if (oldToken?.owner !== trader && nextToken?.owner !== trader) continue;
    if ((prior && !Number.isSafeInteger(prior.lamports)) || (next && !Number.isSafeInteger(next.lamports))) refuse('account rent exceeds safe RPC precision');
    rent += BigInt(next?.lamports ?? 0) - BigInt(prior?.lamports ?? 0);
  }
  if (rent > MAX_RENT || rent < -MAX_RENT) refuse('net account rent exceeds bound');
  const nativeOutput = nativeDelta + networkFee + rent;
  if (side === 'buy' && (coinDelta < minOut || nativeOutput < -amount)) refuse('simulated buy violates input/minimum');
  if (side === 'sell' && (coinDelta !== -amount || nativeOutput < minOut)) refuse('simulated sell violates input/minimum');
  const fee0 = tokenState(before.get(feeAccount)), fee1 = tokenState(after.get(feeAccount));
  if (!sameToken(fee0, fee1)) refuse('fee account changed');
  const fee = fee1.amount - fee0.amount;
  if (fee < 0n || fee !== (side === 'buy' ? amount : nativeOutput + fee) * BigInt(feeBps) / 10000n) refuse('simulated Motion fee differs from terminal policy');
  if (side === 'sell' && nativeOutput + fee > maxNative) refuse('sell exceeds native size cap');
  return { fee: fee.toString(), networkFee: networkFee.toString(), rent: rent.toString(), output: (side === 'buy' ? coinDelta : nativeOutput).toString(), unitsConsumed: simulation.unitsConsumed ?? null };
}

