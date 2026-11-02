// USD balance on Robinhood Chain's REAL contracts (a local hardhat fork; USDC-BALANCE.md §14.1 float-fork): the vault
// module (src/floatEngine.ts) unchanged, its deps over the fork node, throwaway keys, fork-only balances.
//   cd B:/tmp/limit-fork && npx hardhat node --port 8547                         (background)
//   FORK_RPC=http://127.0.0.1:8547 node --experimental-strip-types --test test/float-fork.mjs
// Skipped without FORK_RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const RPC = process.env.FORK_RPC;
const C = F.FLOAT_CFG.robinhood;
const chain = defineChain({ id: 4663, name: 'rh-fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC || 'http://127.0.0.1:1'] } } });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);

test('fork: R tops W up USDG → ETH on the real WETH/USDG pool through the real router; W sweeps back to R while idle', { skip: !RPC }, async () => {
  const pc = createPublicClient({ chain, transport: http(RPC) });
  const rpc = (method, params = []) => pc.request({ method, params });
  await rpc('evm_mine', []);
  const W_KEY = generatePrivateKey(), R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  const hex = (n) => '0x' + n.toString(16);
  await rpc('hardhat_setBalance', [W.address, hex(C.gasFloor + 5_000_000_000_000_000n)]);   // floor + ~$20
  // the fork's own gas price is ~1 gwei (mainnet 0.02): R gets fork-only gas beyond its 0.0001 ETH floor
  await rpc('hardhat_setBalance', [R.address, hex(10n ** 16n)]);
  // 500 USDG for R, from the pool's own balance (impersonated, fork only)
  const POOL = C.oracle.pool;
  await rpc('hardhat_impersonateAccount', [POOL]); await rpc('hardhat_setBalance', [POOL, hex(10n ** 18n)]);
  const poolW = createWalletClient({ chain, transport: http(RPC), account: POOL });
  await pc.waitForTransactionReceipt({ hash: await poolW.writeContract({ address: C.stable.address, abi: ERC20, functionName: 'transfer', args: [R.address, 500_000_000n] }) });
  await rpc('hardhat_stopImpersonatingAccount', [POOL]);
  const send = (acct) => async (_id, tx, gas) => { const wc = createWalletClient({ chain, transport: http(RPC), account: acct }); return wc.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas, gasPrice: (await pc.getGasPrice()) * 2n, type: 'legacy' }); };
  const store = new Map(); const asks = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now() - 30_000, lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const f = createFloat({
    chain: () => 'robinhood',
    wallet: () => ({ id: 'w1', name: 'Wallet 1', w: { evm: W.address, sol: '' }, r: { evm: R.address, sol: '' } }),
    evm: {
      call: async (tx) => (await pc.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value })).data || '0x',
      balance: (a) => pc.getBalance({ address: a }),
      erc20: (t, a) => pc.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] }),
      allowance: (t, o, s) => pc.readContract({ address: t, abi: ERC20, functionName: 'allowance', args: [o, s] }),
      slot0: async (pool) => BigInt((await pc.call({ to: pool, data: '0x3850c7bd' })).data.slice(0, 66)),
      fees: async () => { const gp = await pc.getGasPrice(); const b = await pc.getBlock(); return { baseFee: b.baseFeePerGas ?? gp, gasPrice: gp, l1PerByte: 0n }; },
      estimate: (tx) => pc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }),
      sendR: send(R), sendW: send(W),
      receipt: async (h, ms) => { try { const r = await pc.waitForTransactionReceipt({ hash: h, timeout: Math.max(1000, ms) }); return { status: r.status }; } catch { return null; } },
    },
    ask: async (a) => { asks.push(a); return true; }, gate: async () => {}, html: { esc: String, sub: (h) => h, muted: (h) => h },
    now: () => Date.now(), store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: () => [] },
    lock: async (k, fn) => fn(), emit: () => {}, fetch: async () => { throw new Error('no bridges on the fork'); }, click: () => click, wait: async () => {},
  });
  await f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.equal(asks.length, 1);
  const w0 = await pc.getBalance({ address: W.address });
  const t0 = Date.now();
  const r = await f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  const topMs = Date.now() - t0;
  if (!r.jobId) console.log('  jobs:', JSON.stringify((await f.jobs({ walletId: 'w1' })).jobs));
  assert.ok(r.jobId, JSON.stringify(r));
  const job = (await f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'topup');
  assert.equal(job.state, 'sent', JSON.stringify(job));
  const w1 = await pc.getBalance({ address: W.address });
  assert.ok(w1 - w0 >= BigInt(job.minOut), `W got ${w1 - w0} < floor ${job.minOut}`);
  assert.equal(await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'allowance', args: [R.address, C.router] }), 0n, 'the exact approval is used up');
  assert.equal(await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] }), 500_000_000n - BigInt(job.amountIn));
  console.log(`  top-up $${Number(BigInt(job.usd6)) / 1e6}: W +${Number(w1 - w0) / 1e18} ETH (floor ${Number(BigInt(job.minOut)) / 1e18}), ${job.hashes.length} txs from R, ${topMs} ms on the fork`);
  // the sweep: W far above high, idle → one router call from W pays R in USDG
  await rpc('hardhat_setBalance', [W.address, hex(C.gasFloor + 100_000_000_000_000_000n)]);   // ≈ $400 ready on an inactive... active chain
  click.lastTradeAt = Date.now() - 120_000; click.ticketAt = Date.now() - 120_000;
  const usdgBefore = await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
  const s = await f.sweep({ walletId: 'w1', chain: 'robinhood' });
  const sw = (await f.jobs({ walletId: 'w1' })).jobs.find((j) => j.kind === 'sweep');
  assert.ok(sw && sw.state === 'sent', JSON.stringify(s));
  const usdgAfter = await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
  assert.ok(usdgAfter - usdgBefore >= BigInt(sw.minOut), `R got ${usdgAfter - usdgBefore} < floor ${sw.minOut}`);
  console.log(`  sweep $${Number(BigInt(sw.usd6)) / 1e6}: R +${Number(usdgAfter - usdgBefore) / 1e6} USDG (floor ${Number(BigInt(sw.minOut)) / 1e6})`);
});
