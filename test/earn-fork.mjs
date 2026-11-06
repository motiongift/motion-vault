// Earn against the REAL chains, read-only (eth_call / getCode / getStorageAt / getAccountInfo / simulateTransaction with
// sigVerify off — nothing is ever signed or sent). Skipped unless EARN_FORK=1 (network). It checks that every constant this build
// pins still matches the chain, and that the exact calldata / instructions Earn would sign simulate as expected for real holders.
//   EARN_FORK=1 node --test test/earn-fork.mjs        (RH_RPC / BSC_RPC / SOL_RPC override the public nodes)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, keccak256, parseAbiItem } from 'viem';
import { EARN_VAULTS, EARN_ABI, vaultProblem, redeemData, withdrawData } from '../src/earnCore.ts';
import { AAVE_BSC, AAVE_ABI, EIP1967_IMPL, getReserveDataData, reserveFacts, aaveWithdrawData } from '../src/earnAave.ts';
import { KAMINO_SOL, readReserve, kaminoProblem, kDepositIxs, kRedeemIxs, tokenAmount, kaminoSimProblem, kAssets } from '../src/earnKamino.ts';
import { b58d, b58e, ataOf } from '../src/solEngine.ts';

const ON = process.env.EARN_FORK === '1';
const rh = createPublicClient({ transport: http(process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com') });
const bsc = createPublicClient({ transport: http(process.env.BSC_RPC || 'https://bsc-rpc.publicnode.com') });
const SOL = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';
const solRpc = async (method, params) => { const r = await fetch(SOL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(method + ' ' + JSON.stringify(j.error)); return j.result; };
const call = async (pc, to, fn, args = [], from) => { const r = await pc.call({ to, data: encodeFunctionData({ abi: EARN_ABI, functionName: fn, args }), ...(from ? { account: from } : {}) }); return decodeFunctionResult({ abi: EARN_ABI, functionName: fn, data: r.data }); };

test('Robinhood: the pinned Morpho vault — code hash, asset, no gates, fees, a sane share price; a real holder\'s redeem / withdraw simulate', { skip: !ON }, async () => {
  const c = EARN_VAULTS.robinhood;
  assert.equal(await rh.getChainId(), c.chainId);
  const code = await rh.getCode({ address: c.vault });
  const gates = await Promise.all(['receiveSharesGate', 'sendSharesGate', 'receiveAssetsGate', 'sendAssetsGate'].map((g) => call(rh, c.vault, g)));
  const price = await call(rh, c.vault, 'convertToAssets', [10n ** 18n]);
  const why = vaultProblem({ codeHash: keccak256(code), asset: await call(rh, c.vault, 'asset'), gates, performanceFee: await call(rh, c.vault, 'performanceFee'), managementFee: await call(rh, c.vault, 'managementFee'), price6: price }, c, 0n);
  assert.equal(why, null);
  assert.equal(await call(rh, c.vault, 'maxWithdraw', ['0x000000000000000000000000000000000000dEaD']), 0n, 'Morpho Vault V2: max* = 0 by design');
  const head = await rh.getBlockNumber();
  const logs = await rh.getLogs({ address: c.vault, event: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'), fromBlock: head - 50_000n, toBlock: head });
  let checked = 0;
  for (const l of logs.reverse()) {
    const who = l.args.owner; const shares = await call(rh, c.vault, 'balanceOf', [who]); if (shares < 10n ** 18n) continue;
    const r = await rh.call({ account: who, to: c.vault, data: redeemData(10n ** 18n, who) }); assert.ok(BigInt(r.data) > 0n);
    const w = await rh.call({ account: who, to: c.vault, data: withdrawData(1_000_000n, who) }); assert.ok(BigInt(w.data) > 0n);
    await assert.rejects(rh.call({ account: '0x000000000000000000000000000000000000dEaD', to: c.vault, data: redeemData(10n ** 18n, who) }), 'a third party cannot redeem R\'s shares');
    checked += 1; break;
  }
  assert.equal(checked, 1, 'a real holder found');
  // r2 (review L5): USDG's own proxy implementation is the pinned one
  assert.equal('0x' + (await rh.getStorageAt({ address: c.asset, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' })).slice(-40), c.assetImpl);
});

test('BNB: the pinned Aave v3 Pool / aToken implementations, the USDC reserve active, not frozen or paused, its aToken', { skip: !ON }, async () => {
  const c = AAVE_BSC;
  assert.equal(await bsc.getChainId(), 56);
  const pi = await bsc.getStorageAt({ address: c.pool, slot: EIP1967_IMPL }); const ai = await bsc.getStorageAt({ address: c.aToken, slot: EIP1967_IMPL });
  assert.equal('0x' + pi.slice(-40), c.poolImpl.toLowerCase()); assert.equal('0x' + ai.slice(-40), c.aTokenImpl.toLowerCase());
  const rf = reserveFacts((await bsc.call({ to: c.pool, data: getReserveDataData(c.asset) })).data);
  assert.ok(rf && rf.active && !rf.frozen && !rf.paused); assert.equal(rf.aToken.toLowerCase(), c.aToken.toLowerCase()); assert.equal(rf.decimals, 18);
  // r2: USDC's own implementation (L5), the Pool's addresses provider (L5), the Pool's virtual balance (M7) — read as the engine reads them
  assert.equal('0x' + (await bsc.getStorageAt({ address: c.asset, slot: EIP1967_IMPL })).slice(-40), c.assetImpl);
  assert.equal((await bsc.readContract({ address: c.pool, abi: AAVE_ABI, functionName: 'ADDRESSES_PROVIDER' })).toLowerCase(), c.addressesProvider.toLowerCase());
  const virt = await bsc.readContract({ address: c.pool, abi: AAVE_ABI, functionName: 'getVirtualUnderlyingBalance', args: [c.asset] });
  const held = await bsc.readContract({ address: c.asset, abi: AAVE_ABI, functionName: 'balanceOf', args: [c.aToken] });
  assert.ok(virt > 0n && virt <= held, 'the virtual balance (what a withdrawal can take) is at most what the aToken holds: ' + virt + ' / ' + held);
  // someone else's withdrawal to R would revert (Aave burns msg.sender's aTokens)
  const nobody = '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await assert.rejects(bsc.call({ account: nobody, to: c.pool, data: aaveWithdrawData(c, 10n ** 18n, nobody) }), 'an address without aTokens cannot withdraw');
});

test('Solana: the pinned Kamino reserve (owner, layout, market, mint, vaults, oracle, active, no emergency), the program deploy slot; a real holder\'s deposit + redeem simulate', { skip: !ON, timeout: 120_000 }, async () => {
  const c = KAMINO_SOL;
  const acct = async (a) => { const r = await solRpc('getAccountInfo', [a, { encoding: 'base64' }]); return r.value ? { owner: r.value.owner, data: Uint8Array.from(Buffer.from(r.value.data[0], 'base64')) } : null; };
  const res = await acct(c.reserve); const rr = readReserve(res.data, res.owner, c); assert.ok(!('why' in rr), JSON.stringify(rr, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  const market = await acct(c.market);
  const pd = await solRpc('getAccountInfo', [c.programData, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }]);
  const slot = Buffer.from(pd.value.data[0], 'base64').readBigUInt64LE(0);
  const k = kaminoProblem(rr, market.data[122], slot, c);
  assert.ok(!k || k.cls === 'changed', JSON.stringify(k, (_, v) => (typeof v === 'bigint' ? String(v) : v)));   // an upgrade since the pin is "changed" (deposits stop until re-pinned)
  if (k) console.log('Kamino:', k.why, '— deploy slot now', String(slot), 'pinned', String(c.deploySlot));
  const sigs = await solRpc('getSignaturesForAddress', [c.supplyVault, { limit: 30 }]);
  let user = null;
  // a holder seen on 2026-11-03 first (fewer reads on public nodes), then recent depositors
  for (const payer of [process.env.EARN_FORK_SOL_HOLDER || '8oSD5a9EG933qyuL8YdnSy6YPF7peNiXm7PAx19R1phB']) { const ta = await acct(ataOf(payer, c.mint)).catch(() => null); const bal = ta ? tokenAmount(ta.data, c.mint, payer) : null; if (bal != null && bal > 20_000_000n) user = { payer, bal }; }
  for (const x of user ? [] : sigs) {
    const t = await solRpc('getTransaction', [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]).catch(() => null); if (!t) continue;
    const payer = t.transaction.message.accountKeys[0]; const ta = await acct(ataOf(payer, c.mint)).catch(() => null);
    const bal = ta ? tokenAmount(ta.data, c.mint, payer) : null;
    if (bal != null && bal > 20_000_000n) { user = { payer, bal }; break; }
  }
  assert.ok(user, 'a USDC holder found');
  const rU = ataOf(user.payer, c.mint), rC = ataOf(user.payer, c.cMint);
  const ixs = [...kDepositIxs(c, user.payer, rU, rC, rr.oracles, 10_000_000n), ...kRedeemIxs(c, user.payer, rU, rC, rr.oracles, 1n).slice(1)];
  // a legacy message with the payer as the one signer (the shape solEngine compiles), unsigned
  const metas = new Map(); const addm = (kk, sg, w) => { const e = metas.get(kk) || { s: false, w: false }; e.s ||= sg; e.w ||= w; metas.set(kk, e); };
  const dep = ixs.slice(0, 3); addm(user.payer, true, true); for (const ix of dep) { for (const [kk, sg, w] of ix.keys) addm(kk, sg, w); addm(ix.program, false, false); }
  const keys = [...metas.entries()].sort((a, b) => (a[0] === user.payer ? -1 : b[0] === user.payer ? 1 : ((a[1].s ? (a[1].w ? 0 : 1) : a[1].w ? 2 : 3) - (b[1].s ? (b[1].w ? 0 : 1) : b[1].w ? 2 : 3))));
  const idx = new Map(keys.map((x, i) => [x[0], i])); const cu = (n) => { const o = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); if (!n) break; } return o; };
  const bytes = [keys.filter((x) => x[1].s).length, keys.filter((x) => x[1].s && !x[1].w).length, keys.filter((x) => !x[1].s && !x[1].w).length, ...cu(keys.length), ...keys.flatMap((x) => [...b58d(x[0])]), ...new Array(32).fill(0), ...cu(dep.length)];
  for (const ix of dep) bytes.push(idx.get(ix.program), ...cu(ix.keys.length), ...ix.keys.map((x) => idx.get(x[0])), ...cu(ix.data.length), ...ix.data);
  const tx = Buffer.from([1, ...new Array(64).fill(0), ...bytes]).toString('base64');
  const sim = await solRpc('simulateTransaction', [tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [rU, rC] } }]);
  assert.equal(sim.value.err, null, JSON.stringify(sim.value.logs?.slice(-5)));
  const post = sim.value.accounts.map((a) => (a ? Uint8Array.from(Buffer.from(a.data[0], 'base64')) : null));
  const preC = 0n;   // the user's own cToken account may exist: read it
  const cAcc = await acct(rC); const pre = { usdc: user.bal, c: cAcc ? tokenAmount(cAcc.data, c.cMint, user.payer) ?? 0n : preC };
  const after = { usdc: tokenAmount(post[0], c.mint, user.payer), c: tokenAmount(post[1], c.cMint, user.payer) };
  const exp = (10_000_000n * rr.cSupply) / rr.totalLiquidity;
  assert.equal(kaminoSimProblem('deposit', pre, after, 10_000_000n, exp - exp / 1000n), null, JSON.stringify({ pre, after, exp }, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.ok(kAssets(rr, after.c - pre.c) <= 10_000_000n);
});
