// Browser-safe vault boundary. Request data can select neither deployment nor signer.
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, hashTypedData, keccak256, parseAbi, stringToHex, verifyTypedData } from 'viem';
import { ZERO, ZERO_HASH, TERMINAL_EXECUTE_ABI, TERMINAL_TYPES, TERMINAL_PURPOSE, terminalRouteHash } from './quote-authorization.mjs';
import { buildEvmCalls, verifyEvmRoute, EVM_CHAINS } from './routes/api-swap-evm-routes.mjs';
import { STANDARD, sameHop } from './routes/api-swap-evm-standardRouter.mjs';
import { enabledTerminalVenueTypes, verifyBnbVenue, BNB_EXTRA_VENUES } from './bnb-venues.mjs';
import { registryClass, registryScope, verifyRegistryMarket } from './venue-registry.mjs';
export const ROUTER_READ_ABI = parseAbi([
    'function owner() view returns(address)', 'function signer() view returns(address)',
    'function feeRecipient() view returns(address)', 'function wrappedNative() view returns(address)',
    'function permit2() view returns(address)', 'function policyId() view returns(bytes32)',
    'function PURPOSE() view returns(bytes32)', 'function maxNativeAmount() view returns(uint256)',
    'function paused() view returns(bool)', 'function usedNonces(address,uint256) view returns(bool)',
    'function usedEntitlements(bytes32) view returns(bool)',
    'function executorFor(address,uint256) view returns(address)',
]);
export const TOKEN_READ_ABI = parseAbi(['function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)']);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const refuse = why => { throw Object.assign(Error(`Terminal EVM refused: ${why}`), { name: 'TerminalEvmRefused' }); };
const uint = x => { if (typeof x !== 'bigint' && (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x)))
    refuse('amount encoding'); const n = BigInt(x); if (n < 0n || n >= 1n << 256n)
    refuse('amount bounds'); return n; };
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : typeof x === 'string' ? x.toLowerCase() : x;
export const terminalMarketKey = (token, route) => keccak256(stringToHex(JSON.stringify(sorted({ token, route }))));
// Venues each chain may enable. 'standard-pool' = Standard (standardreserve.xyz) coin AFTER graduation, traded through
// the Universal Router V4 path ETH -> USDG -> stock -> coin. The Standard bonding curve ('standard-curve') stays refused.
export const SUPPORTED_VENUES = Object.freeze({ bsc: Object.freeze(['v2']), robinhood: Object.freeze(['v4', 'standard-pool']) });
const DEFAULT_VENUES = Object.freeze({ bsc: Object.freeze(['v2']), robinhood: Object.freeze(['v4']) });
export const terminalVenue = route => route?.type === 'standard' ? (route.stage === 'pool' ? 'standard-pool' : 'standard-curve') : route?.type;
const STANDARD_POOL_KEYS = ['type', 'chainId', 'stage', 'router', 'factory', 'curve', 'stock', 'poolKey', 'stockPool', 'ethPool', 'feeBps', 'creatorTaxBps', 'snipeTaxBps', 'quoteSymbol'];
const isAddr = x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
// Shape and pinned-constant checks before any RPC read. On-chain registry equality is verifyEvmRoute's job.
function standardPoolShape(r, token) {
    const pk = r.poolKey;
    if (Object.keys(r).some(k => !STANDARD_POOL_KEYS.includes(k)) || r.stage !== 'pool' || !same(r.router, STANDARD.router) || !same(r.factory, STANDARD.factory) ||
        !isAddr(r.curve) || !isAddr(r.stock) || !STANDARD.stocks[String(r.stock).toLowerCase()] ||
        !sameHop(STANDARD.stocks[String(r.stock).toLowerCase()], r.stockPool) || !sameHop(STANDARD.ethPool, r.ethPool) ||
        !pk || typeof pk !== 'object' || Object.keys(pk).some(k => !['currency0', 'currency1', 'fee', 'tickSpacing', 'hooks'].includes(k)) ||
        !isAddr(pk.currency0) || !isAddr(pk.currency1) || !same(pk.hooks, STANDARD.hook) ||
        !((same(pk.currency0, r.stock) && same(pk.currency1, token)) || (same(pk.currency1, r.stock) && same(pk.currency0, token))) ||
        !Number.isInteger(pk.fee) || pk.fee < 0 || pk.fee > 100000 || !Number.isInteger(pk.tickSpacing) || pk.tickSpacing < 1 || pk.tickSpacing > 32767)
        refuse('standard pool route');
}
// PONS-V2 (default OFF). Robinhood Pons V2 bonding curves, native-ETH pair only. Enabled ONLY when the reviewed
// deployment config carries ponsV2.enabled === true (the engine additionally ANDs its own TERMINAL_EVM_PONS_V2 constant).
// Pons coins are created continuously, so a per-token marketKeys list cannot cover them: the trust root is the pinned
// Pons factory (address fixed in the vendored registry, runtime code hash pinned in config) whose getLaunchedToken()
// must name this exact curve, the native pair and registry status 1. NOTE: status stays 1 after graduation (fork
// 2026-11-09: 0xcf47… curve reverts CurveGraduated() 0x025ac17e); a graduated curve fails the independent
// simulation (simulateTerminalEvm), so nothing is signed. Graduated coins are routed as V4, not pons.
export const PONS_CURVE_ABI = parseAbi(['function buy(uint256 amountIn,uint256 minOut,address to) payable', 'function sell(uint256 amountIn,uint256 minOut,address to)']);
const PONS_ROUTE_KEYS = ['type', 'chainId', 'curve', 'pairToken', 'feeBps', 'creatorTaxBps', 'bridgeFee', 'bridgeHops', 'bridgeFees', 'quoteSymbol'];
export function ponsV2Enabled(config, chain) {
    return chain === 'robinhood' && config?.chainId === 4663 && config.ponsV2?.enabled === true;
}
/** Exact structural check of the ONLY call plan a Pons V2 terminal trade may carry. Independent of the route hash. */
export function ponsV2CallsProblem({ calls, tokens, route, token, side, amount, executor, wrapped }) {
    const buy = side === 'buy';
    if (!Array.isArray(calls) || calls.length !== 1) return 'pons plan must be exactly one curve call';
    if (!Array.isArray(tokens) || tokens.length !== 2 || !same(tokens[0], token) || !same(tokens[1], wrapped)) return 'pons tracked tokens must be [token, wrapped]';
    const c = calls[0];
    if (!same(c.target, route.curve) || same(c.target, token) || same(c.target, wrapped)) return 'pons call target is not the registered curve';
    let d;
    try { d = decodeFunctionData({ abi: PONS_CURVE_ABI, data: c.data }); } catch { return 'pons calldata does not decode'; }
    if (d.functionName !== (buy ? 'buy' : 'sell')) return 'pons function does not match side';
    if (!same(encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: d.functionName, args: d.args }), c.data)) return 'pons calldata is not canonical';
    const [amountIn, minOut, to] = d.args;
    if (amountIn !== amount || minOut !== 0n || !same(to, executor)) return 'pons amount, inner minimum or recipient';
    if (c.usePermit2 || Number(c.amountOffset) !== 0) return 'pons call must not use Permit2 or amount patching';
    if (buy) {
        if (c.value !== amount || !same(c.approvalToken, ZERO) || !same(c.approvalSpender, ZERO) || c.approvalAmount !== 0n) return 'pons buy value or approval';
    } else if (c.value !== 0n || !same(c.approvalToken, token) || !same(c.approvalSpender, route.curve) || c.approvalAmount !== amount) return 'pons sell approval must be the exact input to the curve';
    return null;
}
/** `client` is the vault's pinned-chain client, never supplied by the caller.
 * Default matrix is V2 BNB and V4 RH, own native wallet; RH Standard graduated pools only when config.venues lists them;
 * BNB v3/inf/four/flap only when the engine's TERMINAL_EVM_BNB_VENUES lists them; RH Pons V2 only when ponsV2 is enabled.
 * The EIP712 quote is the server policy receipt; exact calldata must reproduce it.
 */
export async function verifyTerminalEvm({ config, client, transaction, route, intent, now = Date.now(), bnbVenues }) {
    if (!config || ![56, 4663].includes(config.chainId))
        refuse('disabled deployment');
    if (!transaction || Object.keys(transaction).some(k => !['chainId', 'to', 'value', 'data'].includes(k)) ||
        transaction.chainId !== config.chainId || !same(transaction.to, config.router) ||
        typeof transaction.data !== 'string' || transaction.data.length > 131074)
        refuse('transaction destination or shape');
    const chain = config.chainId === 56 ? 'bsc' : 'robinhood';
    // Venue scope is deployment configuration. Absent `venues` == the original candidate (BNB v2 / RH v4) exactly.
    const venues = config.venues === undefined ? DEFAULT_VENUES[chain] : config.venues;
    if (!Array.isArray(venues) || venues.length < 1 || venues.some(v => !SUPPORTED_VENUES[chain].includes(v)) ||
        (config.standardPoolRegistry !== undefined && config.standardPoolRegistry !== true && config.standardPoolRegistry !== false))
        refuse('venue configuration');
    const venue = terminalVenue(route);
    // TERMINAL_EVM_BNB_VENUES (default empty) may add v3/inf/four/flap on BNB only; empty = original v2 (bsc venues can only be ['v2']).
    const allowed = chain === 'bsc' ? enabledTerminalVenueTypes('bsc', bnbVenues) : venues;
    const pons = route?.type === 'pons' && ponsV2Enabled(config, chain);
    // Release 20: a venue class the deployment lists in `registry` (venue-registry.mjs) needs no per-coin market key; it is proven
    // on chain below (pinned code hashes + factory / registry reads). Absent `registry` = release-19 scope exactly.
    const registry = registryScope(chain, config.registry);
    const cls = !pons && registry.length ? registryClass(chain, route, intent?.token) : null;
    const registryOn = cls !== null && registry.includes(cls);
    if (route?.chainId !== config.chainId || (!allowed.includes(venue) && !pons && !registryOn))
        refuse('venue not enabled in this candidate');
    if (pons) {
        if (!same(config.ponsV2.factory, EVM_CHAINS.robinhood.ponsFactory) || typeof config.ponsV2.factoryCodeHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(config.ponsV2.factoryCodeHash))
            refuse('pons factory pin');
        // REVIEW 2026-11-09: typed fields only (viem isAddress/String() coerce ['0x..'] to an address string).
        if (Object.keys(route).some(k => !PONS_ROUTE_KEYS.includes(k)) || typeof route.curve !== 'string' || typeof route.pairToken !== 'string' ||
            !Array.isArray(route.bridgeHops ?? []) || !Array.isArray(route.bridgeFees ?? []))
            refuse('pons route shape');
        if (!same(route.pairToken, ZERO) || (route.bridgeHops?.length ?? 0) !== 0 || (route.bridgeFees?.length ?? 0) !== 0 || Number(route.bridgeFee || 0) !== 0)
            refuse('only native-pair Pons V2 curves are enabled');
    }
    else {
        if (venue === 'standard-pool')
            standardPoolShape(route, intent.token);
        // A Standard graduated pool is fully derived from the pinned Standard factory/curve registry (checked on chain
        // by verifyEvmRoute below), so the deployment may accept it without a per-coin key. Every other market needs a key.
        const registryMarket = (venue === 'standard-pool' && config.standardPoolRegistry === true) || registryOn;
        if (!registryMarket && !config.marketKeys?.includes(terminalMarketKey(intent.token, route)))
            refuse('market is not deployment-approved');
    }
    if (!['buy', 'sell'].includes(intent.side) || !Number.isInteger(intent.slippageBps) || intent.slippageBps < 1 || intent.slippageBps > 3000)
        refuse('intent');
    const decoded = decodeFunctionData({ abi: TERMINAL_EXECUTE_ABI, data: transaction.data });
    if (decoded.functionName !== 'execute')
        refuse('not terminal execute');
    const [q, calls, tokens, signature] = decoded.args;
    const canonical = encodeFunctionData({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', args: [q, calls, tokens, signature] });
    if (!same(canonical, transaction.data) || calls.length < 1 || calls.length > 12 || tokens.length < 1 || tokens.length > 8)
        refuse('noncanonical or oversized route');
    const buy = intent.side === 'buy', amount = uint(intent.amount);
    if (amount <= 0n || !same(q.trader, intent.trader) || !same(q.recipient, intent.trader) ||
        !same(q.tokenIn, buy ? ZERO : intent.token) || !same(q.tokenOut, buy ? intent.token : ZERO) ||
        q.amountIn !== amount || q.minOut <= 0n || uint(transaction.value) !== (buy ? amount : 0n))
        refuse('wallet, pair, amount or minimum');
    if (![0, 5, 10, 15, 20].includes(q.motionFeeBps) || q.builderFeeBps !== 0 || !same(q.builderId, ZERO_HASH) || !same(q.builderRecipient, ZERO) ||
        !same(q.purpose, TERMINAL_PURPOSE) || !same(q.policyId, config.policyId) ||
        (q.motionFeeBps < 20 ? same(q.entitlementId, ZERO_HASH) : !same(q.entitlementId, ZERO_HASH)))
        refuse('fee policy or reservation');
    const [chainId, code, head] = await Promise.all([client.getChainId(), client.getBytecode({ address: config.router }), client.getBlock()]);
    if (chainId !== config.chainId || !code || !same(keccak256(code), config.runtimeCodeHash))
        refuse('chain or router bytecode');
    const wall = Math.floor(now / 1000), block = Number(head.timestamp);
    if (Math.abs(wall - block) > 15 || q.issuedAt > wall || q.issuedAt > block || q.deadline <= wall || q.deadline <= block || q.deadline - q.issuedAt > 30)
        refuse('expired or stale receipt');
    const read = (functionName, args = []) => client.readContract({ address: config.router, abi: ROUTER_READ_ABI, functionName, args });
    const names = ['owner', 'signer', 'feeRecipient', 'wrappedNative', 'permit2', 'policyId', 'PURPOSE', 'maxNativeAmount', 'paused'];
    const values = await Promise.all(names.map(n => read(n)));
    const expected = [config.owner, config.signer, config.feeRecipient, config.wrappedNative, config.permit2, config.policyId, TERMINAL_PURPOSE, uint(config.maxNativeAmount), false];
    if (values.some((v, i) => !same(v, expected[i])) || (buy && amount > uint(config.maxNativeAmount)))
        refuse('deployment configuration');
    if (await read('usedNonces', [q.trader, q.nonce]) || (q.motionFeeBps < 20 && await read('usedEntitlements', [q.entitlementId])))
        refuse('consumed authorization');
    const domain = { name: 'TerminalRouter', version: '1', chainId: config.chainId, verifyingContract: config.router };
    const typed = { domain, types: TERMINAL_TYPES, primaryType: 'Quote', message: q };
    if (!await verifyTypedData({ ...typed, address: config.signer, signature }))
        refuse('server signature');
    if (pons) {
        const [factoryCode, curveCode] = await Promise.all([client.getBytecode({ address: EVM_CHAINS.robinhood.ponsFactory }), client.getBytecode({ address: route.curve })]);
        if (!factoryCode || !same(keccak256(factoryCode), config.ponsV2.factoryCodeHash))
            refuse('pons factory bytecode');
        if (!curveCode || curveCode.length < 4)
            refuse('pons curve has no code');
    }
    await verifyEvmRoute({ chain, route, token: intent.token, client });
    if (chain === 'bsc' && BNB_EXTRA_VENUES.includes(route.type))
        await verifyBnbVenue({ route, token: intent.token, side: intent.side, amount, client });
    if (registryOn)
        await verifyRegistryMarket({ chain, cls, route, token: intent.token, client });
    const executor = await read('executorFor', [q.trader, q.nonce]);
    const plan = buildEvmCalls({ chain, route, token: intent.token, side: intent.side, amount: buy ? amount - amount * BigInt(q.motionFeeBps) / 10000n : amount, executor, deadline: q.deadline });
    if (pons) {
        const why = ponsV2CallsProblem({ calls, tokens, route, token: intent.token, side: intent.side, amount: buy ? amount - amount * BigInt(q.motionFeeBps) / 10000n : amount, executor, wrapped: config.wrappedNative });
        if (why)
            refuse(why);
    }
    if (!same(terminalRouteHash(plan), q.routeHash) || !same(terminalRouteHash({ calls, tokens }), q.routeHash))
        refuse('route differs from independently rebuilt calls');
    const digest = hashTypedData(typed);
    return Object.freeze({ quote: q, digest, transaction: Object.freeze({ to: config.router, data: canonical, value: buy ? amount : 0n }),
        claim: Object.freeze({ id: digest.slice(2), trader: q.trader.toLowerCase(), nonce: q.nonce.toString(), reservation: q.motionFeeBps < 20 ? q.entitlementId.toLowerCase() : null }),
        approval: buy ? null : Object.freeze({ token: intent.token, spender: config.router, amount }), intent: Object.freeze({ ...intent }) });
}
export function exactTerminalApproval(verified, amount) {
    const a = verified.approval;
    if (!a || (amount !== 0n && amount !== a.amount))
        refuse('approval must be exact input or zero');
    return Object.freeze({ to: a.token, value: 0n, data: encodeFunctionData({ abi: TOKEN_READ_ABI, functionName: 'approve', args: [a.spender, amount] }) });
}
export async function simulateTerminalEvm({ client, verified, config, now = Date.now() }) {
    if (Math.floor(now / 1000) >= verified.quote.deadline)
        refuse('receipt expired before simulation');
    const { data } = await client.call({ account: verified.quote.trader, ...verified.transaction });
    const output = decodeFunctionResult({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', data });
    const floor = output * BigInt(10000 - verified.intent.slippageBps) / 10000n;
    if (output < verified.quote.minOut || verified.quote.minOut < floor || (verified.intent.side === 'sell' && output > uint(config.maxNativeAmount)))
        refuse('independent simulation output or slippage floor');
    return output;
}
