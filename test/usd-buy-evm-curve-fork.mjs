// The curve path end to end on MAINNET FORKS: UsdBuyRouter deployed (fork only) by the real deployer address at its nonce 0 —
// so at the address the vault names (CURVE_ROUTER) — then the vault's plan for a live four.meme / Flap / Pons coin, the probe at
// R, the guards, the ONE transaction R sends, W holding the coin. Also proves the vault's pinned code hash is the code a
// deployment of the audited artifact leaves on each chain. Throwaway R / W keys; nothing reaches either chain.
//   FORK_BSC=http://127.0.0.1:8548 FORK_RH=http://127.0.0.1:8547 node --experimental-strip-types --test test/usd-buy-evm-curve-fork.mjs
// Needs the contract artifacts (FLOAT_DIRECT_DIR = a local float-direct checkout; contracts: node build.mjs); skipped without them or the forks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { evmDirectPlan, probeCall, decodeProbe, evmDirectGuard, routerOut, minOutOf, PROBE_RUNTIME, CURVE_ROUTER } from '../src/usdBuyEvm.ts';
import * as F from '../src/floatCore.ts';

const FD = process.env.FLOAT_DIRECT_DIR || '../float-direct'; // a local checkout of the float-direct contracts
const ART = FD + '/contracts/artifacts/UsdBuyRouter.json', CFG = pathToFileURL(FD + '/contracts/deploy/venues.mjs').href;
const DEPLOYER = '0xf0e0Aa5adB4D501D8d2E9a8f2F6De8744B2c5c2e';
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const WHALES = { bsc: '0xF977814e90dA44bFA03b6295A0616a897441aceC', robinhood: F.FLOAT_CFG.robinhood.oracle.pool };
const BASE = { bsc: 'https://motion.gift/bsc', robinhood: 'https://motion.gift' };
for (const chainKey of ['bsc', 'robinhood']) {
  const rpc = chainKey === 'bsc' ? process.env.FORK_BSC : process.env.FORK_RH;
  test(`fork ${chainKey}: a curve coin bought in ONE transaction from R through UsdBuyRouter at the vault's address`, { skip: !rpc || !existsSync(ART), timeout: 900_000 }, async (t) => {
    const { DEPLOY, TUPLE } = await import(CFG); void TUPLE;
    const D = DEPLOY[chainKey]; const art = JSON.parse(readFileSync(ART, 'utf8'));
    const chain = defineChain({ id: D.chainId, name: chainKey, nativeCurrency: { name: 'N', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const pc = createPublicClient({ chain, transport: http(rpc) });
    const call = (m, p = []) => pc.request({ method: m, params: p });
    const hex = (n) => '0x' + n.toString(16);
    await call('evm_mine', []);
    const cr = CURVE_ROUTER[chainKey];
    if ((await pc.getCode({ address: cr.address })) === undefined) {
      assert.equal(await pc.getTransactionCount({ address: DEPLOYER }), 0, 'the deployer\'s first transaction makes the router');
      await call('hardhat_impersonateAccount', [DEPLOYER]); await call('hardhat_setBalance', [DEPLOYER, hex(10n ** 18n)]);
      const dw = createWalletClient({ chain, transport: http(rpc), account: DEPLOYER });
      const h = await dw.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [D.stable, D.wrapped, D.swapRouter, D.swapFee, D.rescue, D.venues] });
      const rc = await pc.waitForTransactionReceipt({ hash: h });
      assert.equal(rc.contractAddress.toLowerCase(), cr.address, 'deployed where the vault looks');
      await call('hardhat_stopImpersonatingAccount', [DEPLOYER]);
    }
    assert.equal(keccak256(await pc.getCode({ address: cr.address })), cr.codeHash, 'the vault\'s pinned code hash = the deployed audited runtime');
    const cfg = F.FLOAT_CFG[chainKey];
    const R = privateKeyToAccount(generatePrivateKey()), W = privateKeyToAccount(generatePrivateKey());
    await call('hardhat_setBalance', [R.address, hex(10n ** 17n)]);
    await call('hardhat_impersonateAccount', [WHALES[chainKey]]); await call('hardhat_setBalance', [WHALES[chainKey], hex(10n ** 18n)]);
    const whale = createWalletClient({ chain, transport: http(rpc), account: WHALES[chainKey] });
    const amount = 3n * 10n ** BigInt(cfg.stable.decimals);
    await pc.waitForTransactionReceipt({ hash: await whale.writeContract({ address: cfg.stable.address, abi: ERC20, functionName: 'transfer', args: [R.address, amount * 3n] }) });
    const rW = createWalletClient({ chain, transport: http(rpc), account: R });
    await pc.waitForTransactionReceipt({ hash: await rW.writeContract({ address: cfg.stable.address, abi: ERC20, functionName: 'approve', args: [cr.address, 2n ** 256n - 1n] }) });
    // live curve coins that exist on the fork
    const j = await (await fetch(`${BASE[chainKey]}/api/board/lanes`)).json();
    const routes = [];
    for (const tk of (j.lanes || []).flatMap((l) => l.tokens || [])) {
      if (routes.length >= 3) break;
      if ((await pc.getCode({ address: tk.address })) === undefined) continue;
      const r = await (await fetch(`${BASE[chainKey]}/api/token/${tk.address}/route`)).json().catch(() => null);
      if (!r?.route || !['four', 'flap', 'pons'].includes(r.route.type)) continue;
      try { evmDirectPlan({ chain: chainKey, route: r.route, coin: tk.address, amountIn: amount, recipient: W.address, deadline: 1n }); } catch { continue; }
      routes.push({ symbol: tk.symbol, coin: tk.address, route: r.route });
    }
    t.diagnostic(`${chainKey}: ${routes.map((r) => `${r.route.type} ${r.symbol}`).join(', ')}`);
    let done = 0;
    for (const c of routes) {
      const plan = evmDirectPlan({ chain: chainKey, route: c.route, coin: c.coin, amountIn: amount, recipient: W.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), minNative: 1n });
      let seen;
      try { seen = decodeProbe((await pc.call({ account: R.address, to: R.address, data: probeCall({ plan, chain: chainKey, coin: c.coin, w: W.address, amountIn: amount }), stateOverride: [{ address: R.address, code: PROBE_RUNTIME }] })).data); }
      catch (e) { t.diagnostic(`${c.symbol}: the curve refused in the probe (${String(e.shortMessage || e.message).slice(0, 60)})`); continue; }
      assert.equal(evmDirectGuard(seen, amount), '', c.symbol);
      const quote = routerOut(seen.ret, seen.coinGot);
      const w0 = await pc.readContract({ address: c.coin, abi: ERC20, functionName: 'balanceOf', args: [W.address] });
      const rc = await pc.waitForTransactionReceipt({ hash: await rW.sendTransaction({ to: plan.to, data: plan.build(minOutOf(quote, 12)), gas: 1_500_000n }) });
      assert.equal(rc.status, 'success', c.symbol);
      const got = (await pc.readContract({ address: c.coin, abi: ERC20, functionName: 'balanceOf', args: [W.address] })) - w0;
      assert.ok(got >= minOutOf(quote, 12), c.symbol);
      t.diagnostic(`${chainKey} ${c.route.type} ${c.symbol}: W got ${got} in one tx from R, gas ${rc.gasUsed}`);
      done += 1;
    }
    assert.ok(done >= 1, `${chainKey}: at least one curve buy`);
  });
}
