// (2026-11-09, owner «ну так делай все», replying to «да 2») a BRIDGED V3 sell — a coin quoted in USDG or in a stock token, one
// exactInput along the path back to WETH (Robinhood SwapRouter02; BNB PancakeSwap SmartRouter) — swaps and unwraps in ONE
// transaction: multicall(bytes[]) [exactInput(path, recipient = the router, address 2, amountOutMinimum = floor),
// unwrapWETH9(floor, wallet)]. Before, the WETH landed in the wallet and a SEPARATE WETH.withdraw went out behind the receipt
// (landed(hash, 90_000), errors swallowed) — it could be lost. The REAL helper is cut out of webEngine.ts (declChunk), transpiled, run.
// Fork proof (one tx ends in native, 0 WETH added, same fill as the old path): B:\tmp\engine-unwrap2\fork\fork-unwrap-path.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { encodeFunctionData, decodeFunctionData, encodeAbiParameters, encodePacked, toFunctionSelector, concatHex } from 'viem';
import { declChunk } from '../scripts/trade-core.mjs';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const names = ['EXACT_INPUT_ABI', 'V3_ROUTER_SELF', 'V3_SELL_UNWRAP_ABI', 'v3SellUnwrapPathCall'];
const CODE = ts.transpileModule(names.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const E = new Function('encodeFunctionData', `${CODE}\nreturn { EXACT_INPUT_ABI, V3_ROUTER_SELF, V3_SELL_UNWRAP_ABI, v3SellUnwrapPathCall };`)(encodeFunctionData);
const sendCallData = (req) => encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });   // = sendCall

const RH_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2', BSC_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', SPCX = '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa';
const WALLET = '0x7c1b83a16bb2af079cf2d5a9749edbbe6f53a8d3';
// the fork's USDG-paired coin (route v3 fee 10000, bridgeHops [WETH, USDG], bridgeFees [100]): coin → USDG → WETH
const COIN = '0x000DE658153f47f23e92973C8EB1e89762703676';
const PATH = encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [COIN, 10000, USDG, 100, WETH]);
const AMOUNT = 13968721361402408792728n, MIN = 43118057007955275n;
const GOLDEN = '0xac9650d800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000124b858183f0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000002f53ef374bce180f29800000000000000000000000000000000000000000000000000992fa4f75d3d4b0000000000000000000000000000000000000000000000000000000000000042000de658153f47f23e92973c8eb1e897627036760027105fc5360d0400a0fd4f2af552add042d716f1d1680000640bd7d308f8e1639fab988df18a8011f41eacad7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c00000000000000000000000000000000000000000000000000992fa4f75d3d4b0000000000000000000000007c1b83a16bb2af079cf2d5a9749edbbe6f53a8d300000000000000000000000000000000000000000000000000000000';

const independent = (path, amountIn, min, to) => {
  const swap = concatHex([toFunctionSelector('exactInput((bytes,address,uint256,uint256))'), encodeAbiParameters([{ type: 'tuple', components: [{ type: 'bytes' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }], [[path, '0x0000000000000000000000000000000000000002', amountIn, min]])]);
  const unwrap = concatHex([toFunctionSelector('unwrapWETH9(uint256,address)'), encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [min, to])]);
  return concatHex([toFunctionSelector('multicall(bytes[])'), encodeAbiParameters([{ type: 'bytes[]' }], [[swap, unwrap]])]);
};

test('unwrap-path-1tx: the bridged sell calldata is byte-exact (golden) — multicall(bytes[]) [exactInput → router, unwrapWETH9(floor, wallet)]', () => {
  const call = E.v3SellUnwrapPathCall(RH_ROUTER, PATH, AMOUNT, MIN, WALLET);
  assert.equal(call.address, RH_ROUTER);
  assert.equal(call.functionName, 'multicall');
  assert.equal(call.value, undefined, 'no value: sendCall sends 0');
  const data = sendCallData(call);
  assert.equal(data, GOLDEN);
  assert.equal(data, independent(PATH, AMOUNT, MIN, WALLET));
  assert.equal(data.slice(0, 10), '0xac9650d8', 'multicall(bytes[]) — no deadline variant, like the plain exactInput it replaces');
});

test('unwrap-path-1tx: both legs carry the SAME floor; the swap pays the router (address 2), the native goes to the wallet; the path is passed through', () => {
  const paths = [
    [RH_ROUTER, PATH],
    [RH_ROUTER, encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], ['0xc1A095F322059d42E1586d3c2F138e0AA7035be4', 10000, SPCX, 500, WETH])],   // stock-paired
    [RH_ROUTER, encodePacked(['address', 'uint24', 'address', 'uint24', 'address', 'uint24', 'address'], [COIN, 3000, SPCX, 3000, USDG, 100, WETH])],   // stock via USDG (three pools)
    [BSC_ROUTER, encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [COIN, 2500, '0x55d398326f99059fF775485246999027B3197955', 500, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'])],
  ];
  for (const [router, path] of paths) {
    for (const min of [1n, MIN, 10n ** 30n]) {
      const call = E.v3SellUnwrapPathCall(router, path, AMOUNT, min, WALLET);
      const [legs] = call.args;
      assert.equal(legs.length, 2);
      const s = decodeFunctionData({ abi: E.EXACT_INPUT_ABI, data: legs[0] });
      assert.equal(s.functionName, 'exactInput');
      assert.deepEqual({ ...s.args[0], path: s.args[0].path.toLowerCase(), recipient: s.args[0].recipient.toLowerCase() }, { path: path.toLowerCase(), recipient: '0x0000000000000000000000000000000000000002', amountIn: AMOUNT, amountOutMinimum: min });
      const u = decodeFunctionData({ abi: E.V3_SELL_UNWRAP_ABI, data: legs[1] });
      assert.equal(u.functionName, 'unwrapWETH9');
      assert.deepEqual([u.args[0], u.args[1].toLowerCase()], [min, WALLET]);
      assert.equal(sendCallData(call), independent(path, AMOUNT, min, WALLET));
    }
  }
});

test('unwrap-path-1tx: the early gas proof is the same call at floor 0 (gas does not depend on the floor)', () => {
  const early = sendCallData(E.v3SellUnwrapPathCall(RH_ROUTER, PATH, AMOUNT, 0n, WALLET)), real = sendCallData(E.v3SellUnwrapPathCall(RH_ROUTER, PATH, AMOUNT, MIN, WALLET));
  assert.equal(early.length, real.length);
  assert.equal(early, independent(PATH, AMOUNT, 0n, WALLET));
  let diff = 0; for (let i = 2; i < real.length; i += 64) if (early.slice(i, i + 64) !== real.slice(i, i + 64)) diff += 1;
  assert.ok(diff <= 4, `only the floor words differ (${diff})`);
});

// the bridged branch of tradeOne's V3 path (from its quoteToken check to the WETH-quoted tokenIn line)
const tradeOneSrc = declChunk(WE, 'tradeOne');
const to = tradeOneSrc.indexOf("  const tokenIn = side === 'buy' ? WETH : token, tokenOut = side === 'buy' ? token : route.quoteToken;");
const from = tradeOneSrc.lastIndexOf('  if (route.quoteToken.toLowerCase() !== WETH.toLowerCase()) {', to);
const branch = tradeOneSrc.slice(from, to);

test('unwrap-path-1tx: tradeOne sends the one-tx bridged sell at the unchanged floor; no follow-up unwrap; no new await between click and send', () => {
  assert.ok(from > 0 && branch.length > 400 && branch.length < 4000, 'found the bridged branch');
  // the path is built as before (token → reversed bridge hops); the buy path too
  assert.match(branch, /: encodeV3Path\(\[token, \.\.\.\[\.\.\.bridge\.hops\]\.reverse\(\)\], \[route\.fee, \.\.\.\[\.\.\.bridge\.fees\]\.reverse\(\)\]\);/);
  // the signed sell: v3SellUnwrapPathCall at applySlippage(quoted) — the floor expression the plain exactInput had — on its early proof
  assert.match(branch, /side === 'sell' \? simEarly\(v3SellUnwrapPathCall\(UNISWAP_V3_ROUTER, path, amountIn, applySlippage\(quoted\), account\.address\), early\)/);
  // its early proof: the same call at floor 0, beside the quote; none in turbo, none for a buy
  assert.match(branch, /const early = side === 'sell' && !s\.turbo \? bscEstimate\('sell', v3SellUnwrapPathCall\(UNISWAP_V3_ROUTER, path, amountIn, 0n, account\.address\)\) : null;/);
  assert.ok(branch.indexOf('const early =') < branch.indexOf('await quoteV3Path'), 'the proof starts before the quote is awaited');
  // the buy is the call it was (exactInput, value = amountIn, sim)
  assert.match(branch, /: sim\(\{ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: \[\{ \.\.\.base, amountOutMinimum: applySlippage\(quoted\) \}\], value: amountIn \}\)\);/);
  // no WETH read, no receipt wait, no second transaction behind the sell
  assert.doesNotMatch(branch, /landed\(|unwrap\(acct|beforeWeth|afterWeth|balanceOf/);
  // awaits on the way to the send: the old ones minus the pre-sell WETH read
  assert.deepEqual([...branch.matchAll(/await \(?([A-Za-z0-9]+)/g)].map((m) => m[1]), ['quoteV3Path', 'guard', 'approveIfNeeded', 'side']);
  assert.match(branch, /return send\(bridged\.request\);\n  \}\n$/);
});

test('unwrap-path-1tx: the preview simulates the same one-tx call the bridged sell sends', () => {
  const pv = declChunk(WE, 'previewOne');
  assert.match(pv, /return run\(v3SellUnwrapPathCall\(UNISWAP_V3_ROUTER, path, amountIn, applySlippage\(q3\), account\.address\)\);/);
  // the bridged buy preview is unchanged
  assert.match(pv, /return run\(\{ address: UNISWAP_V3_ROUTER, abi: EXACT_INPUT_ABI, functionName: 'exactInput', args: \[\{ \.\.\.base, amountOutMinimum: applySlippage\(q3\) \}\], value: side === 'buy' \? amountIn : undefined \}\);/);
});
