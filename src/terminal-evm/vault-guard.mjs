// Browser-safe vault boundary. Request data can select neither deployment nor signer.
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, hashTypedData, keccak256, parseAbi, stringToHex, verifyTypedData } from 'viem';
import { ZERO, ZERO_HASH, TERMINAL_EXECUTE_ABI, TERMINAL_TYPES, TERMINAL_PURPOSE, terminalRouteHash } from './quote-authorization.mjs';
import { buildEvmCalls, verifyEvmRoute } from './routes/api-swap-evm-routes.mjs';
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
/** `client` is the vault's pinned-chain client, never supplied by the caller.
 * Initial supported matrix is deliberately V2 BNB and V4 RH, own native wallet.
 * The EIP712 quote is the server policy receipt; exact calldata must reproduce it.
 */
export async function verifyTerminalEvm({ config, client, transaction, route, intent, now = Date.now() }) {
    if (!config || ![56, 4663].includes(config.chainId))
        refuse('disabled deployment');
    if (!transaction || Object.keys(transaction).some(k => !['chainId', 'to', 'value', 'data'].includes(k)) ||
        transaction.chainId !== config.chainId || !same(transaction.to, config.router) ||
        typeof transaction.data !== 'string' || transaction.data.length > 131074)
        refuse('transaction destination or shape');
    const chain = config.chainId === 56 ? 'bsc' : 'robinhood';
    if (route?.chainId !== config.chainId || route.type !== (chain === 'bsc' ? 'v2' : 'v4'))
        refuse('venue not enabled in this candidate');
    if (!config.marketKeys?.includes(terminalMarketKey(intent.token, route)))
        refuse('market is not deployment-approved');
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
    await verifyEvmRoute({ chain, route, token: intent.token, client });
    const executor = await read('executorFor', [q.trader, q.nonce]);
    const plan = buildEvmCalls({ chain, route, token: intent.token, side: intent.side, amount: buy ? amount - amount * BigInt(q.motionFeeBps) / 10000n : amount, executor, deadline: q.deadline });
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
