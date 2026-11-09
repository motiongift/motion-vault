// Release 20 (coverage without per-coin tables). A market is fee-covered by its VENUE, proven against pinned immutable
// contracts, instead of by a per-coin market key compiled into the engine. One module, three consumers that must agree:
//   · the vault guard (vault-guard.mjs verifyTerminalEvm): a route whose class is enabled in the deployment's `registry` list
//     needs no market key; verifyRegistryMarket() then proves the venue on chain (code hashes + factory/registry reads);
//   · the engine's fee gate (src/terminalFeeCoverage.ts): the same registryClass() on the vault's own route copy decides
//     whether a legacy (fee-free) buy is refused;
//   · the terminal quote service (server/terminal-quote, vendored byte copy): classifyRoute() uses the same registryClass().
// Pure shape rules (registryClass) + read-only checks (verifyRegistryMarket). No signing, no sends, no request-supplied pins.
//
// Why the rest of the trade stays safe with any coin of a class: the vault still rebuilds the exact call plan itself
// (routes/api-swap-evm-routes.mjs buildEvmCalls) and requires the signed routeHash to equal it, so a call the class does not
// produce (foreign target, transfer, extra hop) is refused; the TerminalRouter charges motionFeeBps on the NATIVE leg
// (buy: of amountIn before any venue call, sell: of the gross native out), so the fee is exact by construction whatever the
// venue; the executor's balance checks and the signed minOut bound what the venue may keep.
//
// Pins: read from Robinhood (block 4663/…) and BNB Chain mainnet 2026-11-09 by B:/tmp/fee-coverage/tools/read-pins.mjs.
// A changed code hash (a redeploy at the same address cannot happen; a proxy's own bytecode is pinned, not its implementation —
// see notes) refuses the venue: the trade is not signed.
import { keccak256, parseAbi } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';
const lc = x => String(x ?? '').toLowerCase();
const same = (a, b) => lc(a) === lc(b);
const isAddr = x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
const refuse = why => { throw Object.assign(Error(`Terminal EVM refused: ${why}`), { name: 'TerminalEvmRefused' }); };

export const REGISTRY_PINS = Object.freeze({
  robinhood: Object.freeze({
    chainId: 4663,
    wrapped: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    poolManager: Object.freeze({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', codeHash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626' }),
    // Universal Router: its immutables (PoolManager, V3 factory, Permit2, WETH) are part of the runtime code, so the hash pins them
    universalRouter: Object.freeze({ address: '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77', codeHash: '0xc6e5eed9a134f8323933352d4b1e4ba44942b524e9dfa0582c656db139dc6e1d' }),
    // the Pons / Robinhood launcher hook (factory() == Pons factory 0x7ed5…7ec7e): every graduated Pons coin's pool
    launcherHook: Object.freeze({ address: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', codeHash: '0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db' }),
    // Doppler (Long.xyz) multicurve hook
    dopplerHook: Object.freeze({ address: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544', codeHash: '0xc41a91106002f15bf70ae266824317f3f3ac638ac72ca5253bae395fa47ee631' }),
    // Uniswap V3 SwapRouter02 (factory() 0x1f7d…2efa is an immutable of this code) + the factory itself
    v3Router: Object.freeze({ address: '0xcaf681a66d020601342297493863e78c959e5cb2', codeHash: '0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc' }),
    v3Factory: Object.freeze({ address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', codeHash: '0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739' }),
    standardFactory: Object.freeze({ address: '0x3d6ea4e97b8ab9e1a1b4943febffe22d8c920091', codeHash: '0xb1f353db8895f633a295bc9b5df318a5d9ae8ae2d2bc2b044706c6657a385f3c' }),
    standardRouter: Object.freeze({ address: '0x190b452d16e12e3beedd76a030ea991fe3856c33', codeHash: '0x2288531ebb0652c67657d8f5f21293ba0d02cf38745aeddccf5882404127da12' }),
    standardHook: Object.freeze({ address: '0x048f2dc8a71a0321b5e119cd577c56d0190920cc', codeHash: '0x22da73ec4428e412ae329b2920cf84c5337bfa89a1b5954c5af7c8225cef0de4' }),
  }),
  bsc: Object.freeze({
    chainId: 56,
    wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    usdt: '0x55d398326f99059ff775485246999027b3197955',
    // PancakeSwap V2 router (factory 0xca14…7c73 and WBNB are immutables of this code) + the factory
    v2Router: Object.freeze({ address: '0x10ed43c718714eb63d5aa57b78b54704e256024e', codeHash: '0x69aef35de7236f9ae83edadff736f01ea40edd8919b2e73d87dea5d3255b8c3e' }),
    v2Factory: Object.freeze({ address: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', codeHash: '0x9e8d17faaee69b053be6ac65b2b2c317741d770cb5fbdd9512536d17e9e076ca' }),
    // PancakeSwap V3 SmartRouter (factory 0x0bfb…1865 / deployer immutables) + the factory
    v3Router: Object.freeze({ address: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', codeHash: '0x25cbde77f2ef6d474c31f738e67ab99e604471170d8a0ab4f544cbaba969d078' }),
    v3Factory: Object.freeze({ address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', codeHash: '0x8191d3ab1d55d3da9822199f28865415c99566b6f1aee4a4b16713f57930678c' }),
    // four.meme TokenManager2 / TokenManagerHelper3 and the Flap Portal are EIP-1967 proxies: their proxy code is pinned here;
    // the implementation is the venue's (the legacy trade path trusts the same addresses). Recorded 2026-11-09 for the notes:
    // four impl 0xa38d…2e72 (0x8da2…5377), helper impl 0x0cc7…43c8 (0xa990…1ff7), flap impl 0x6fc1…9968 (0x90b3…fa75).
    fourManager: Object.freeze({ address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', codeHash: '0xf035b164f546d628163baa4d5428649ad6728453a19e4af6ba602a713b6d9f08' }),
    fourHelper: Object.freeze({ address: '0xf251f83e40a78868fcfa3fa4599dad6494e46034', codeHash: '0x3699eede0afdf6f3bd06fc73cf7ad43b3fcac4847cd6ab2571cbd3cfbb9badb4' }),
    flapPortal: Object.freeze({ address: '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', codeHash: '0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3' }),
  }),
});

/** Every class a deployment may list in `registry`. Order = rollout order in the notes. */
export const REGISTRY_CLASSES = Object.freeze({
  robinhood: Object.freeze(['v4-launcher', 'v3', 'v4-hookless', 'v4-doppler', 'standard-pool', 'standard-curve']),
  bsc: Object.freeze(['v2', 'flap', 'v3', 'four']),
});
/** Deployment-scope validation: `registry` absent = none (the release-19 per-coin scope, unchanged). */
export function registryScope(chain, registry) {
  if (registry === undefined || registry === null) return Object.freeze([]);
  if (!Array.isArray(registry) || registry.some(c => !REGISTRY_CLASSES[chain]?.includes(c)) || new Set(registry).size !== registry.length)
    refuse('registry configuration');
  return Object.freeze([...registry]);
}

const V3_FEES = Object.freeze([100, 500, 3000, 10000]);
const BSC_V3_FEES = Object.freeze([100, 500, 2500, 10000]);
const FEES = Object.freeze({ robinhood: V3_FEES, bsc: BSC_V3_FEES });
const emptyArr = x => x == null || (Array.isArray(x) && x.length === 0);
const noBridge = r => emptyArr(r.bridgeHops) && emptyArr(r.bridgeFees) && !Number(r.bridgeFee || 0);
// ONE V3 pool from the wrapped native to the market's quote coin, of a fee the vault's bridge() encoder accepts. The pool is
// the one the pinned V3 router derives from its own factory (CREATE2), never an address from the route.
const bridge1 = (r, wrapped, quote, fees) => Array.isArray(r.bridgeHops) && r.bridgeHops.length === 2 &&
  same(r.bridgeHops[0], wrapped) && same(r.bridgeHops[1], quote) && Array.isArray(r.bridgeFees) && r.bridgeFees.length === 1 &&
  fees.includes(r.bridgeFees[0]) && (r.bridgeFee === undefined || Number(r.bridgeFee) === r.bridgeFees[0]);
/** the market's quote coin is native/wrapped (no bridge) or reached through one factory V3 pool */
const quoteOk = (r, quote, P, fees) => (same(quote, ZERO) || same(quote, P.wrapped)) ? noBridge(r) : isAddr(quote) && bridge1(r, P.wrapped, quote, fees);
const keysOnly = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const V4_KEYS = ['type', 'chainId', 'poolKey', 'pair', 'quoteToken', 'quoteSymbol', 'quoteDecimals', 'bridgeFee', 'bridgeHops', 'bridgeFees'];
const V3_KEYS = ['type', 'chainId', 'fee', 'quoteToken', 'quoteSymbol', 'quoteDecimals', 'pool', 'bridgeFee', 'bridgeHops', 'bridgeFees'];
const V2_KEYS = ['type', 'chainId', 'router', 'pool', 'quoteToken', 'quoteSymbol', 'quoteDecimals', 'path', 'bridgeFee', 'bridgeHops', 'bridgeFees'];
const FLAP_KEYS = ['type', 'chainId', 'portal', 'quoteToken', 'quoteSymbol', 'quoteDecimals', 'nativeToQuote', 'buyTaxBps', 'sellTaxBps', 'bridgeFee', 'bridgeHops', 'bridgeFees', 'permitData'];
const FOUR_KEYS = ['type', 'chainId', 'manager', 'helper', 'quoteToken', 'quoteSymbol', 'quoteDecimals', 'feeBps', 'bridgeFee', 'bridgeHops', 'bridgeFees'];
const STANDARD_KEYS = ['type', 'chainId', 'stage', 'router', 'factory', 'curve', 'stock', 'poolKey', 'stockPool', 'ethPool', 'feeBps', 'creatorTaxBps', 'snipeTaxBps', 'quoteSymbol'];

function v4Class(r, token, P) {
  const pk = r.poolKey;
  if (!pk || typeof pk !== 'object' || Array.isArray(pk) || !keysOnly(pk, ['currency0', 'currency1', 'fee', 'tickSpacing', 'hooks'])) return null;
  if (![pk.currency0, pk.currency1, pk.hooks].every(isAddr) || !Number.isInteger(pk.fee) || !Number.isInteger(pk.tickSpacing) || pk.tickSpacing < 1 || pk.tickSpacing > 32767) return null;
  const other = same(pk.currency0, token) ? pk.currency1 : same(pk.currency1, token) ? pk.currency0 : null;
  if (other === null || same(other, token) || !quoteOk(r, other, P, V3_FEES)) return null;
  // the Pons / Robinhood launcher's pools: the launcher's own fee word (0) and spacing (200)
  if (same(pk.hooks, P.launcherHook.address)) return pk.fee === 0 && pk.tickSpacing === 200 ? 'v4-launcher' : null;
  // Doppler (Long.xyz) multicurve: the hook sets the fee (dynamic flag) or a static fee <= 10 %
  if (same(pk.hooks, P.dopplerHook.address)) return pk.fee === 0x800000 || (pk.fee >= 0 && pk.fee <= 100000) ? 'v4-doppler' : null;
  // hookless only; a static fee <= 10 % (the dynamic flag means nothing without a hook)
  if (same(pk.hooks, ZERO) && pk.fee >= 0 && pk.fee <= 100000) return 'v4-hookless';
  return null;
}

/** The registry class of a route for this token, or null (= per-coin market key needed, as in release 19). Pure. */
export function registryClass(chain, route, token) {
  const P = REGISTRY_PINS[chain];
  const r = route;
  if (!P || !r || typeof r !== 'object' || Array.isArray(r) || r.chainId !== P.chainId || !isAddr(token) || same(token, ZERO) || same(token, P.wrapped)) return null;
  if (r.type === 'v3') {
    if (!keysOnly(r, V3_KEYS) || !FEES[chain].includes(r.fee) || !isAddr(r.pool) || same(r.pool, ZERO) || !isAddr(r.quoteToken) || same(r.quoteToken, token)) return null;
    // the /route form of a WETH-quoted pool carries bridgeHops [WETH] (one hop, no fee)
    if (same(r.quoteToken, P.wrapped)) return (emptyArr(r.bridgeHops) || (r.bridgeHops.length === 1 && same(r.bridgeHops[0], P.wrapped))) && emptyArr(r.bridgeFees) && !Number(r.bridgeFee || 0) ? 'v3' : null;
    return bridge1(r, P.wrapped, r.quoteToken, FEES[chain]) ? 'v3' : null;
  }
  if (chain === 'robinhood') {
    if (r.type === 'v4') return keysOnly(r, V4_KEYS) ? v4Class(r, token, P) : null;
    if (r.type === 'standard') {
      if (!keysOnly(r, STANDARD_KEYS) || !same(r.router, P.standardRouter.address) || !same(r.factory, P.standardFactory.address) || !isAddr(r.curve) || !isAddr(r.stock)) return null;
      if (r.stage === 'curve') return r.poolKey == null ? 'standard-curve' : null;
      if (r.stage === 'pool') return r.poolKey && same(r.poolKey.hooks, P.standardHook.address) ? 'standard-pool' : null;
      return null;
    }
    return null;
  }
  // bsc
  if (r.type === 'v2') {
    if (!keysOnly(r, V2_KEYS) || !same(r.router, P.v2Router.address) || !Array.isArray(r.path) || r.path.length < 2 || r.path.length > 3 ||
      !r.path.every(isAddr) || !same(r.path[0], P.wrapped) || !same(r.path.at(-1), token) || new Set(r.path.map(lc)).size !== r.path.length ||
      r.path.some(a => same(a, ZERO)) || !isAddr(r.pool) || same(r.pool, ZERO) || !noBridge(r)) return null;
    return 'v2';
  }
  if (r.type === 'flap') {
    if (!keysOnly(r, FLAP_KEYS) || !same(r.portal, P.flapPortal.address) || !isAddr(r.quoteToken) || same(r.quoteToken, token) ||
      (r.permitData !== undefined && r.permitData !== '0x') || (same(r.quoteToken, ZERO) && r.nativeToQuote === true)) return null;
    return quoteOk(r, r.quoteToken, P, BSC_V3_FEES) ? 'flap' : null;
  }
  if (r.type === 'four') {
    if (!keysOnly(r, FOUR_KEYS) || !same(r.manager, P.fourManager.address) || !same(r.helper, P.fourHelper.address) || !isAddr(r.quoteToken) || same(r.quoteToken, token)) return null;
    return quoteOk(r, r.quoteToken, P, BSC_V3_FEES) ? 'four' : null;
  }
  return null;
}

/** The pinned contracts each class trades through (their runtime code hash must match before anything is signed). */
export function classContracts(chain, cls) {
  const P = REGISTRY_PINS[chain];
  if (chain === 'robinhood') {
    if (cls === 'v4-launcher') return [P.universalRouter, P.poolManager, P.launcherHook];
    if (cls === 'v4-hookless') return [P.universalRouter, P.poolManager];
    if (cls === 'v4-doppler') return [P.universalRouter, P.poolManager, P.dopplerHook];
    if (cls === 'v3') return [P.v3Router, P.v3Factory];
    if (cls === 'standard-pool') return [P.universalRouter, P.poolManager, P.standardFactory, P.standardHook];
    if (cls === 'standard-curve') return [P.standardRouter, P.standardFactory];
  } else if (chain === 'bsc') {
    if (cls === 'v2') return [P.v2Router, P.v2Factory];
    if (cls === 'flap') return [P.flapPortal];
    if (cls === 'four') return [P.fourManager, P.fourHelper];
    if (cls === 'v3') return [P.v3Router, P.v3Factory];
  }
  refuse('unknown registry class');
}

const V3_FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const V2_FACTORY_ABI = parseAbi(['function getPair(address,address) view returns(address)']);
// Code is immutable at an address (no SELFDESTRUCT-redeploy after Cancun outside one tx), so a verified (chain, address, hash)
// stays verified for the session. The cache only ever holds positives.
const CODE_OK = new Set();
async function codeHashIs(client, chainId, pin) {
  const k = `${chainId}:${pin.address}:${pin.codeHash}`;
  if (CODE_OK.has(k)) return true;
  const code = await client.getBytecode({ address: pin.address });
  const ok = !!code && code !== '0x' && same(keccak256(code), pin.codeHash);
  if (ok) CODE_OK.add(k);
  return ok;
}
export const _resetRegistryCache = () => CODE_OK.clear();

/** On-chain proof of a registry market. `client` is the vault's pinned-chain client (never request data).
 *  Throws TerminalEvmRefused on any mismatch; RPC errors propagate (nothing is signed either way). */
export async function verifyRegistryMarket({ chain, cls, route: r, token, client }) {
  const P = REGISTRY_PINS[chain];
  if (!P || registryClass(chain, r, token) !== cls) refuse('registry class mismatch');
  const pins = classContracts(chain, cls);
  const checks = await Promise.all(pins.map(p => codeHashIs(client, P.chainId, p)));
  if (checks.some(ok => !ok)) refuse('venue contract code differs from the pinned deployment');
  if (cls === 'v3') {
    const q = r.quoteToken;
    const pool = await client.readContract({ address: P.v3Factory.address, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [token, q, r.fee] });
    if (same(pool, ZERO) || !same(pool, r.pool)) refuse('V3 pool is not the factory pool');
  } else if (cls === 'v2') {
    const pair = await client.readContract({ address: P.v2Factory.address, abi: V2_FACTORY_ABI, functionName: 'getPair', args: [r.path.at(-2), token] });
    if (same(pair, ZERO) || !same(pair, r.pool)) refuse('V2 pair is not the factory pair');
  }
  // v4-*: the pool id is derived from the pool key by the pinned PoolManager inside the pinned Universal Router; an uninitialised
  // pool reverts in the vault's own simulation. Standard / flap / four: verifyEvmRoute already proved the registry entry
  // (curveOfToken + poolKey, Portal token state, helper.trySell manager) on chain.
  return cls;
}
