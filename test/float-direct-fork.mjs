// The buy straight from the reserve on Robinhood Chain's REAL contracts (a local hardhat fork, throwaway keys, fork-only
// balances; nothing is sent to the chain): R signs ONE call to the float's own SwapRouter02 — stable → WETH → coin, or stable →
// coin — and the coin lands in W. Coins from motion's board on 2026-10-29: CASHCAT (WETH, Uniswap V3 0.3 %), SPCX (USDG 0.05 %).
//   cd <limit-fork> && npx hardhat node --port 8547                         (background)
//   FORK_RPC=http://127.0.0.1:8547 node --experimental-strip-types --test test/float-direct-fork.mjs
// Skipped without FORK_RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { usdBuyV3Calldata } from '../src/floatDirect.ts';
import * as F from '../src/floatCore.ts';

const RPC = process.env.FORK_RPC;
const C = F.FLOAT_CFG.robinhood;
const chain = defineChain({ id: 4663, name: 'rh-fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC || 'http://127.0.0.1:1'] } } });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const COINS = [
  { symbol: 'CASHCAT', address: '0x020bfc650a365f8bb26819deaabf3e21291018b4', tokens: [C.stable.address, C.wrapped, '0x020bfc650a365f8bb26819deaabf3e21291018b4'], fees: [C.swapFee, 3000] },
  { symbol: 'SPCX', address: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', tokens: [C.stable.address, '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea'], fees: [500] },
];

test('fork: R buys for W in ONE call to the float\'s own router — stable → WETH → coin and stable → coin; W gets ≥ the floor, R pays exactly the amount', { skip: !RPC }, async () => {
  const pc = createPublicClient({ chain, transport: http(RPC) });
  const rpc = (method, params = []) => pc.request({ method, params });
  const hex = (n) => '0x' + n.toString(16);
  const W_KEY = generatePrivateKey(), R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY), R = privateKeyToAccount(R_KEY);
  await rpc('hardhat_setBalance', [R.address, hex(10n ** 16n)]);
  const POOL = C.oracle.pool;
  await rpc('hardhat_impersonateAccount', [POOL]); await rpc('hardhat_setBalance', [POOL, hex(10n ** 18n)]);
  const poolW = createWalletClient({ chain, transport: http(RPC), account: POOL });
  await pc.waitForTransactionReceipt({ hash: await poolW.writeContract({ address: C.stable.address, abi: ERC20, functionName: 'transfer', args: [R.address, 100_000_000n] }) });
  await rpc('hardhat_stopImpersonatingAccount', [POOL]);
  const rW = createWalletClient({ chain, transport: http(RPC), account: R });
  // the background step (never on a click): R's standing allowance to the router — only R's own calls can spend it
  await pc.waitForTransactionReceipt({ hash: await rW.writeContract({ address: C.stable.address, abi: ERC20, functionName: 'approve', args: [C.router, 2n ** 256n - 1n] }) });
  for (const coin of COINS) {
    const amountIn = 5_000_000n;   // $5
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    // the quote: the same call simulated from R (minOut 1), then the floor at 88 % of it (12 % slippage, the engine default)
    const quoteData = usdBuyV3Calldata({ stable: C.stable.address, tokens: coin.tokens, fees: coin.fees, amountIn, minOut: 1n, recipient: W.address, deadline });
    const ret = await pc.call({ account: R.address, to: C.router, data: quoteData });
    const quoted = BigInt('0x' + ret.data.slice(2 + 64 * 4, 2 + 64 * 5));   // multicall's bytes[] → the one result word
    assert.ok(quoted > 0n, coin.symbol + ' quoted nothing');
    const minOut = quoted * 88n / 100n;
    const data = usdBuyV3Calldata({ stable: C.stable.address, tokens: coin.tokens, fees: coin.fees, amountIn, minOut, recipient: W.address, deadline });
    const r0 = await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
    const w0 = await pc.readContract({ address: coin.address, abi: ERC20, functionName: 'balanceOf', args: [W.address] });
    const t0 = Date.now();
    const h = await rW.sendTransaction({ to: C.router, data, value: 0n, gas: 600_000n });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    assert.equal(rc.status, 'success');
    const w1 = await pc.readContract({ address: coin.address, abi: ERC20, functionName: 'balanceOf', args: [W.address] });
    const r1 = await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
    assert.equal(r0 - r1, amountIn, 'R pays exactly the amount');
    assert.ok(w1 - w0 >= minOut, `${coin.symbol}: W got ${w1 - w0} < floor ${minOut}`);
    assert.equal(await pc.getBalance({ address: W.address }), 0n, 'W needed no native at all');
    console.log(`  ${coin.symbol}: $5 of USDG → ${w1 - w0} units to W in one tx from R, gas ${rc.gasUsed}, ${Date.now() - t0} ms on the fork`);
  }
  // a floor above what the pool pays reverts and moves nothing
  const coin = COINS[0];
  const r0 = await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
  const bad = usdBuyV3Calldata({ stable: C.stable.address, tokens: coin.tokens, fees: coin.fees, amountIn: 5_000_000n, minOut: 10n ** 40n, recipient: W.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
  await assert.rejects(pc.call({ account: R.address, to: C.router, data: bad }));
  assert.equal(await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] }), r0);
  // anyone else calling the router with R's allowance pays from THEIR balance (the router pulls from msg.sender only)
  const X = privateKeyToAccount(generatePrivateKey());
  await rpc('hardhat_setBalance', [X.address, hex(10n ** 16n)]);
  const any = usdBuyV3Calldata({ stable: C.stable.address, tokens: coin.tokens, fees: coin.fees, amountIn: 5_000_000n, minOut: 1n, recipient: X.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
  await assert.rejects(pc.call({ account: X.address, to: C.router, data: any }));
  assert.equal(await pc.readContract({ address: C.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] }), r0);
});

test('the path encoder refuses what is not a USD buy', () => {
  const base = { stable: C.stable.address, tokens: COINS[0].tokens, fees: COINS[0].fees, amountIn: 1n, minOut: 1n, recipient: '0x00000000000000000000000000000000000000a1', deadline: 1n };
  assert.match(usdBuyV3Calldata(base), /^0x5ae401dc/);   // multicall(uint256,bytes[]) — SwapRouter02's, with the deadline
  assert.throws(() => usdBuyV3Calldata({ ...base, tokens: [C.wrapped, COINS[0].address], fees: [3000] }), /starts from the reserve/);
  assert.throws(() => usdBuyV3Calldata({ ...base, fees: [100] }), /at most two hops/);
  assert.throws(() => usdBuyV3Calldata({ ...base, fees: [100, 1234] }), /Bad pool fee/);
  assert.throws(() => usdBuyV3Calldata({ ...base, minOut: 0n }), /a floor/);
  assert.throws(() => usdBuyV3Calldata({ ...base, recipient: '0x0000000000000000000000000000000000000000' }), /trading wallet/);
  assert.throws(() => usdBuyV3Calldata({ ...base, tokens: [C.stable.address, C.stable.address], fees: [100] }), /Bad path/);
});
