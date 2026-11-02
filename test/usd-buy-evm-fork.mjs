// The EVM buy straight from the reserve on REAL contracts (local hardhat forks of Robinhood Chain and BNB Chain; throwaway keys,
// fork-only balances; nothing reaches either chain). Per market: the vault's plan (src/usdBuyEvm.ts) → the probe's eth_call
// with its code at R (state override) → the guards → the floor from the quote → the ONE transaction R sends → W holds the coin.
// Routes are the indexer's answers for these coins on 2026-10-29.
//   cd B:/tmp/limit-fork && npx hardhat node --port 8547 &  npx hardhat node --config hardhat.bsc.cjs --port 8548 &
//   FORK_RH=http://127.0.0.1:8547 FORK_BSC=http://127.0.0.1:8548 node --experimental-strip-types --test test/usd-buy-evm-fork.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { evmDirectPlan, probeCall, decodeProbe, evmDirectGuard, routerOut, minOutOf, PROBE_RUNTIME, permit2ApproveData } from '../src/usdBuyEvm.ts';
import * as F from '../src/floatCore.ts';

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', USDT = '0x55d398326f99059ff775485246999027b3197955';
const CASES = {
  robinhood: { rpc: process.env.FORK_RH, id: 4663, whale: F.FLOAT_CFG.robinhood.oracle.pool, fund: 50_000_000n, amount: 5_000_000n, coins: [
    { symbol: 'CASHCAT', coin: '0x020bfc650a365f8bb26819deaabf3e21291018b4', route: { type: 'v3', fee: 3000, quoteToken: WETH, bridgeHops: [WETH], bridgeFees: [] } },
    { symbol: 'RAETO', coin: '0x72be1277e198d0c476869253cb4e62807e14533c', route: { type: 'v3', fee: 10000, quoteToken: USDG, bridgeHops: [WETH, USDG], bridgeFees: [100] } },
    { symbol: 'SPCX', coin: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', route: { type: 'v3', fee: 500, quoteToken: USDG, bridgeHops: [WETH, USDG], bridgeFees: [100] } },
    // graduated Pons V2 (V4 pool behind the launcher hook) and a hookless V4 pool, both paired with native ETH
    { symbol: 'NOCTR (Pons V2 → V4 hook)', coin: '0x945805be3bcc95585bb84c52d9406c90e872f1a7', route: { type: 'v4', pair: 'native', poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x945805be3bcc95585bb84c52d9406c90e872f1a7', fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' } } },
    { symbol: 'AIMCAP (Pons V2 → V4 hook)', coin: '0x4ec65c12f4a02cf4a4a4a9843a2e995a42215eae', route: { type: 'v4', pair: 'native', poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x4ec65c12f4a02cf4a4a4a9843a2e995a42215eae', fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' } } },
    { symbol: 'TRDXYZ (V4 hookless)', coin: '0x45c642dae49b4e8c8ff70899b45a1a6d8092b0cf', route: { type: 'v4', pair: 'native', poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x45c642dae49b4e8c8ff70899b45a1a6d8092b0cf', fee: 2500, tickSpacing: 25, hooks: '0x0000000000000000000000000000000000000000' } } },
  ] },
  bsc: { rpc: process.env.FORK_BSC, id: 56, whale: '0xF977814e90dA44bFA03b6295A0616a897441aceC', fund: 50n * 10n ** 18n, amount: 5n * 10n ** 18n, coins: [
    { symbol: 'ARENA (V2, WBNB)', coin: '0x7da17617b7e810a8f1f5188f7601e4536b52b72d', route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', quoteToken: WBNB, path: [WBNB, '0x7da17617b7e810a8f1f5188f7601e4536b52b72d'] } },
    { symbol: 'LUCK (Flap → V2)', coin: '0x11e3ee544418a074679f9aa0dc77824207aa7777', route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', quoteToken: WBNB, path: [WBNB, '0x11e3ee544418a074679f9aa0dc77824207aa7777'] } },
    { symbol: 'JAGENT (V2, USDT pair)', coin: '0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15', route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', quoteToken: USDT, path: [WBNB, USDT, '0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15'] } },
    { symbol: 'UNEMPLOYED (four.meme → V2)', coin: '0xda1826bb31fdbb407b8f8b2a0b295e12700effff', route: { type: 'v2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', quoteToken: WBNB, path: [WBNB, '0xda1826bb31fdbb407b8f8b2a0b295e12700effff'] } },
  ] },
};
for (const [chainKey, k] of Object.entries(CASES)) {
  test(`fork ${chainKey}: R buys for W in ONE transaction, simulated first by the probe at R; W gets ≥ the floor and holds no native`, { skip: !k.rpc, timeout: 300_000 }, async () => {
    const chain = defineChain({ id: k.id, name: chainKey + '-fork', nativeCurrency: { name: 'N', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [k.rpc] } } });
    const pc = createPublicClient({ chain, transport: http(k.rpc) });
    const rpc = (m, p = []) => pc.request({ method: m, params: p });
    const hex = (n) => '0x' + n.toString(16);
    await rpc('evm_mine', []);
    const cfg = F.FLOAT_CFG[chainKey];
    const R = privateKeyToAccount(generatePrivateKey()), W = privateKeyToAccount(generatePrivateKey());
    await rpc('hardhat_setBalance', [R.address, hex(10n ** 17n)]);
    await rpc('hardhat_impersonateAccount', [k.whale]); await rpc('hardhat_setBalance', [k.whale, hex(10n ** 18n)]);
    const whale = createWalletClient({ chain, transport: http(k.rpc), account: k.whale });
    await pc.waitForTransactionReceipt({ hash: await whale.writeContract({ address: cfg.stable.address, abi: ERC20, functionName: 'transfer', args: [R.address, k.fund] }) });
    await rpc('hardhat_stopImpersonatingAccount', [k.whale]);
    const rW = createWalletClient({ chain, transport: http(k.rpc), account: R });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const probe = async (plan, coin) => decodeProbe((await pc.call({ account: R.address, to: R.address, data: probeCall({ plan, chain: chainKey, coin, w: W.address, amountIn: k.amount }), stateOverride: [{ address: R.address, code: PROBE_RUNTIME }] })).data);
    // no allowance yet: the probe calls nothing and says so (the click then keeps the hold; the background approves)
    const first = evmDirectPlan({ chain: chainKey, route: k.coins[0].route, coin: k.coins[0].coin, amountIn: k.amount, recipient: W.address, deadline });
    const none = await probe(first, k.coins[0].coin);
    assert.equal(none.called, false); assert.equal(evmDirectGuard(none, k.amount), 'allowance');
    // the background step: R's standing allowance to the float's own router
    await pc.waitForTransactionReceipt({ hash: await rW.writeContract({ address: cfg.stable.address, abi: ERC20, functionName: 'approve', args: [cfg.router, 2n ** 256n - 1n] }) });
    // …and for the Universal Router (V4): the stable to Permit2, and Permit2's own allowance to the router
    if (k.coins.some((c) => c.route.type === 'v4')) {
      const v4 = evmDirectPlan({ chain: chainKey, route: k.coins.find((c) => c.route.type === 'v4').route, coin: k.coins.find((c) => c.route.type === 'v4').coin, amountIn: k.amount, recipient: W.address, deadline });
      await pc.waitForTransactionReceipt({ hash: await rW.writeContract({ address: cfg.stable.address, abi: ERC20, functionName: 'approve', args: [v4.spender, 2n ** 256n - 1n] }) });
      await pc.waitForTransactionReceipt({ hash: await rW.sendTransaction({ to: v4.spender, data: permit2ApproveData(v4.permit2.token, v4.permit2.spender, Math.floor(Date.now() / 1000)) }) });
    }
    for (const c of k.coins) {
      const plan = evmDirectPlan({ chain: chainKey, route: c.route, coin: c.coin, amountIn: k.amount, recipient: W.address, deadline });
      const t0 = performance.now();
      const seen = await probe(plan, c.coin);
      const probeMs = Math.round(performance.now() - t0);
      assert.equal(evmDirectGuard(seen, k.amount), '', c.symbol);
      const quote = routerOut(seen.ret, seen.coinGot), minOut = minOutOf(quote, 12);
      const r0 = await pc.readContract({ address: cfg.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
      const w0 = await pc.readContract({ address: c.coin, abi: ERC20, functionName: 'balanceOf', args: [W.address] });
      const rc = await pc.waitForTransactionReceipt({ hash: await rW.sendTransaction({ to: plan.to, data: plan.build(minOut), value: 0n, gas: 900_000n }) });
      assert.equal(rc.status, 'success', c.symbol);
      const w1 = await pc.readContract({ address: c.coin, abi: ERC20, functionName: 'balanceOf', args: [W.address] });
      const r1 = await pc.readContract({ address: cfg.stable.address, abi: ERC20, functionName: 'balanceOf', args: [R.address] });
      assert.equal(r0 - r1, k.amount, 'R pays exactly the amount');
      assert.ok(w1 - w0 >= seen.coinGot * 88n / 100n, `${c.symbol}: W got ${w1 - w0}, the probe saw ${seen.coinGot}`);
      assert.equal(await pc.getBalance({ address: W.address }), 0n, 'W needed no native');
      console.log(`  ${chainKey} ${c.symbol}: ${plan.kind} via ${plan.hops.length - 1} hop(s), probe ${probeMs} ms, quote ${quote}, W got ${w1 - w0} (decimals ${seen.decimals}), gas ${rc.gasUsed}`);
    }
    // a floor above what the market pays reverts and moves nothing; a stranger with R's calldata pays from their own balance
    const c = k.coins[0];
    const plan = evmDirectPlan({ chain: chainKey, route: c.route, coin: c.coin, amountIn: k.amount, recipient: W.address, deadline });
    await assert.rejects(pc.call({ account: R.address, to: plan.to, data: plan.build(10n ** 40n) }));
    const X = privateKeyToAccount(generatePrivateKey()); await rpc('hardhat_setBalance', [X.address, hex(10n ** 17n)]);
    await assert.rejects(pc.call({ account: X.address, to: plan.to, data: plan.build(1n) }));
  });
}
