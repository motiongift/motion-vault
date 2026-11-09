// (2026-11-09, owner «ну так сделай») a V3 sell into the wrapped gas token (Robinhood: SwapRouter02 + WETH; BNB: PancakeSwap
// SmartRouter + WBNB) swaps and unwraps in ONE transaction: multicall(bytes[]) [exactInputSingle(recipient = the router,
// address 2, amountOutMinimum = floor), unwrapWETH9(floor, wallet)]. Before, the sell landed WETH in the wallet and a SEPARATE
// WETH.withdraw went out behind the receipt (landed(hash, 90_000), errors swallowed) — it could be lost (ticket 0x7c1b…a8d3,
// B:\tmp\usdg-trace\REPORT-RU.txt). The REAL helper is cut out of webEngine.ts (declChunk), transpiled and run.
// Fork proof (one tx ends in native, 0 WETH added, same fill as the old path): B:\tmp\engine-unwrap\fork\fork-unwrap.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { encodeFunctionData, decodeFunctionData, encodeAbiParameters, toFunctionSelector, concatHex } from 'viem';
import { declChunk } from '../scripts/trade-core.mjs';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const names = ['EXACT_INPUT_SINGLE_ABI', 'V3_ROUTER_SELF', 'V3_SELL_UNWRAP_ABI', 'v3SellUnwrapCall'];
const CODE = ts.transpileModule(names.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const E = new Function('encodeFunctionData', `${CODE}\nreturn { EXACT_INPUT_SINGLE_ABI, V3_ROUTER_SELF, V3_SELL_UNWRAP_ABI, v3SellUnwrapCall };`)(encodeFunctionData);
const sendCallData = (req) => encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });   // = sendCall

const RH_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2', BSC_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const WALLET = '0x7c1b83a16bb2af079cf2d5a9749edbbe6f53a8d3';
// = v3SingleArgs(USDG, WETH, 100, amountIn): recipient the wallet, floor 0 (the helper must replace both)
const ARGS = { tokenIn: USDG, tokenOut: WETH, fee: 100, recipient: WALLET, amountIn: 490422260n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
const MIN = 202335815088073742n;
const GOLDEN = '0xac9650d8000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000e404e45aaf0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d1680000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad7300000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000001d3b3ff400000000000000000000000000000000000000000000000002ced75a0fa9ec0e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c00000000000000000000000000000000000000000000000002ced75a0fa9ec0e0000000000000000000000007c1b83a16bb2af079cf2d5a9749edbbe6f53a8d300000000000000000000000000000000000000000000000000000000';

const independent = (a, min, to) => {
  const swap = concatHex([toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'), encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint160' }] }], [[a.tokenIn, a.tokenOut, a.fee, '0x0000000000000000000000000000000000000002', a.amountIn, min, a.sqrtPriceLimitX96]])]);
  const unwrap = concatHex([toFunctionSelector('unwrapWETH9(uint256,address)'), encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [min, to])]);
  return concatHex([toFunctionSelector('multicall(bytes[])'), encodeAbiParameters([{ type: 'bytes[]' }], [[swap, unwrap]])]);
};

test('unwrap-1tx: the sell calldata is byte-exact (golden) — multicall(bytes[]) [exactInputSingle → router, unwrapWETH9(floor, wallet)]', () => {
  const call = E.v3SellUnwrapCall(RH_ROUTER, ARGS, MIN, WALLET);
  assert.equal(call.address, RH_ROUTER);
  assert.equal(call.functionName, 'multicall');
  assert.equal(call.value, undefined, 'no value: sendCall sends 0');
  const data = sendCallData(call);
  assert.equal(data, GOLDEN);
  assert.equal(data, independent(ARGS, MIN, WALLET));
  assert.equal(data.slice(0, 10), '0xac9650d8', 'multicall(bytes[]) — no deadline variant, like the plain exactInputSingle it replaces');
});

test('unwrap-1tx: both legs carry the SAME floor; recipient of the swap is the router (address 2), the native goes to the wallet', () => {
  for (const [router, a] of [[RH_ROUTER, ARGS], [BSC_ROUTER, { ...ARGS, tokenIn: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', tokenOut: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', fee: 2500 }]]) {
    for (const min of [1n, MIN, 10n ** 30n]) {
      const call = E.v3SellUnwrapCall(router, a, min, WALLET);
      const [legs] = call.args;
      assert.equal(legs.length, 2);
      const s = decodeFunctionData({ abi: E.EXACT_INPUT_SINGLE_ABI, data: legs[0] });
      assert.equal(s.functionName, 'exactInputSingle');
      const lo = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : v]));
      assert.deepEqual(lo(s.args[0]), lo({ tokenIn: a.tokenIn, tokenOut: a.tokenOut, fee: a.fee, recipient: '0x0000000000000000000000000000000000000002', amountIn: a.amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n }));
      const u = decodeFunctionData({ abi: E.V3_SELL_UNWRAP_ABI, data: legs[1] });
      assert.equal(u.functionName, 'unwrapWETH9');
      assert.deepEqual([u.args[0], u.args[1].toLowerCase()], [min, WALLET]);
      assert.equal(sendCallData(call), independent(a, min, WALLET));
    }
  }
});

test('unwrap-1tx: the early gas proof is the same call at floor 0 (gas does not depend on the floor)', () => {
  const early = sendCallData(E.v3SellUnwrapCall(RH_ROUTER, ARGS, 0n, WALLET)), real = sendCallData(E.v3SellUnwrapCall(RH_ROUTER, ARGS, MIN, WALLET));
  assert.equal(early.length, real.length);
  assert.equal(early, independent(ARGS, 0n, WALLET));
  // only the two floor words differ
  let diff = 0; for (let i = 2; i < real.length; i += 64) if (early.slice(i, i + 64) !== real.slice(i, i + 64)) diff += 1;
  assert.ok(diff <= 4, `only the floor words differ (${diff})`);
});

// the tail of tradeOne's WETH-quoted V3 path (from its tokenIn line to the end of tradeOne)
const tradeOneSrc = declChunk(WE, 'tradeOne');
const tail = tradeOneSrc.slice(tradeOneSrc.indexOf("  const tokenIn = side === 'buy' ? WETH : token, tokenOut = side === 'buy' ? token : route.quoteToken;"));

test('unwrap-1tx: tradeOne sends the one-tx sell at the unchanged floor; no follow-up unwrap; no new await between click and send', () => {
  assert.ok(tail.length > 200 && tail.length < 3000, 'found the V3 single tail');
  // the signed sell: v3SellUnwrapCall at applySlippage(q.result) — the floor expression the plain exactInputSingle had
  assert.match(tail, /simEarly\(side === 'sell' \? v3SellUnwrapCall\(UNISWAP_V3_ROUTER, args, applySlippage\(q\.result\), account\.address\)/);
  // its early proof: the same call at floor 0
  assert.match(tail, /bscEstimate\('sell', v3SellUnwrapCall\(UNISWAP_V3_ROUTER, args, 0n, account\.address\)\)/);
  // the buy is the call it was (exactInputSingle, value = amountIn)
  assert.match(tail, /: \{ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: \[\{ \.\.\.args, amountOutMinimum: applySlippage\(q\.result\) \}\], value: amountIn \}, early\);/);
  // no WETH read, no receipt wait, no second transaction behind the sell
  assert.doesNotMatch(tail, /landed\(|unwrap\(acct|beforeWeth|afterWeth/);
  // awaits on the way to the send: exactly the ones the old path had (it also awaited beforeWethP — gone)
  assert.deepEqual([...tail.matchAll(/await ([A-Za-z0-9]+)/g)].map((m) => m[1]), ['quoteV3Single', 'guard', 'approveIfNeeded', 'simEarly']);
  assert.match(tail, /return send\(req\.request\);\n\}$/);
});

test('unwrap-1tx: the preview simulates the same one-tx call the sell sends', () => {
  const pv = declChunk(WE, 'previewOne');
  assert.match(pv, /return run\(v3SellUnwrapCall\(UNISWAP_V3_ROUTER, args, applySlippage\(q\), account\.address\)\);/);
});
