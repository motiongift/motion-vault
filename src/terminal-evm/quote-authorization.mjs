// Server-only terminal authorization. No key loading, RPC selection or broadcasting.
import { encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, isAddress, keccak256, stringToHex, verifyTypedData } from 'viem';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const ZERO_HASH = `0x${'0'.repeat(64)}`;
export const TERMINAL_PURPOSE = keccak256(stringToHex('motion-terminal-trade-v1'));
export const CALL_COMPONENTS = Object.freeze([
  ['target', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['approvalToken', 'address'],
  ['approvalSpender', 'address'], ['approvalAmount', 'uint256'], ['usePermit2', 'bool'], ['amountOffset', 'uint32'],
].map(([name, type]) => Object.freeze({ name, type })));
export const QUOTE_COMPONENTS = Object.freeze([
  ['trader', 'address'], ['recipient', 'address'], ['tokenIn', 'address'], ['tokenOut', 'address'],
  ['amountIn', 'uint256'], ['minOut', 'uint256'], ['routeHash', 'bytes32'], ['builderId', 'bytes32'],
  ['builderRecipient', 'address'], ['motionFeeBps', 'uint16'], ['builderFeeBps', 'uint16'],
  ['issuedAt', 'uint48'], ['deadline', 'uint48'], ['nonce', 'uint256'],
  ['purpose', 'bytes32'], ['policyId', 'bytes32'], ['entitlementId', 'bytes32'],
].map(([name, type]) => Object.freeze({ name, type })));
export const TERMINAL_TYPES = Object.freeze({ Quote: QUOTE_COMPONENTS });
export const TERMINAL_EXECUTE_ABI = Object.freeze([{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'q', type: 'tuple', components: QUOTE_COMPONENTS },
    { name: 'calls', type: 'tuple[]', components: CALL_COMPONENTS },
    { name: 'tokens', type: 'address[]' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}]);

function fail(message) { throw new Error(`Terminal authorization: ${message}`); }
function address(value, name, allowZero = false) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) fail(`invalid ${name}`);
  const result = getAddress(value.toLowerCase());
  if (!allowZero && result === ZERO) fail(`zero ${name}`);
  return result;
}
function uint(value, name, positive = false) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) fail(`invalid ${name}`);
  const n = BigInt(value);
  if (n < (positive ? 1n : 0n) || n >= (1n << 256n)) fail(`invalid ${name}`);
  return n;
}
function bytes32(value, name, allowZero = false) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || (!allowZero && value.toLowerCase() === ZERO_HASH)) fail(`invalid ${name}`);
  return value.toLowerCase();
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));

export function nativeFeeAccounting(grossNative, feeBps, nativeRefund = 0n) {
  if (![0, 5, 10, 15, 20].includes(feeBps)) fail('fee must be a terminal policy tier');
  const gross = uint(grossNative, 'gross native'), refund = uint(nativeRefund, 'native refund');
  const fee = gross * BigInt(feeBps) / 10000n, net = gross - fee;
  if (refund > net) fail('refund exceeds net budget');
  return freeze({ grossNative: gross, nativeFee: fee, netNative: net, nativeRefund: refund,
    spentNative: net - refund, feeRemainderNumerator: gross * BigInt(feeBps) % 10000n });
}

export function terminalRouteHash(plan) {
  return keccak256(encodeAbiParameters([{ type: 'tuple[]', components: CALL_COMPONENTS }, { type: 'address[]' }], [plan.calls, plan.tokens]));
}

/** All callbacks are constructor DI from trusted server code, never request data.
 * verifyExecution MUST validate venue/token/spender/recipient allowlists and simulate
 * these exact calls with the selected fee. It returns netAmountOut, grossNative,
 * nativeRefund, calls, tokens, verified:true. Funded overrides do not prove balance.
 * claimAuthorization MUST atomically bind nonceKey AND (if present) reservationId
 * to digest in durable storage; same digest is idempotent, any different one fails.
 */
export function createTerminalQuoteAuthorizer({ config, signerAccount, resolveFeeDecision, reserveFeeDecision,
  verifyDeployment, verifyExecution, claimAuthorization, now = () => Date.now() }) {
  if (![resolveFeeDecision, reserveFeeDecision, verifyDeployment, verifyExecution, claimAuthorization].every(f => typeof f === 'function')) fail('trusted verifier/claim callbacks required');
  if (!signerAccount || typeof signerAccount.signTypedData !== 'function') fail('dedicated signer required');
  const pinned = freeze({ chainId: config.chainId, router: address(config.router, 'router'),
    signer: address(config.signer, 'signer'), feeRecipient: address(config.feeRecipient, 'fee recipient'),
    wrappedNative: address(config.wrappedNative, 'wrapped native'), permit2: address(config.permit2, 'permit2', true),
    maxNativeAmount: uint(config.maxNativeAmount, 'cap', true), policyId: bytes32(config.policyId, 'policy'),
    runtimeCodeHash: bytes32(config.runtimeCodeHash, 'runtime code hash') });
  if (![4663, 56].includes(pinned.chainId) || !same(signerAccount.address, pinned.signer)) fail('chain or signer mismatch');
  const domain = freeze({ name: 'TerminalRouter', version: '1', chainId: pinned.chainId, verifyingContract: pinned.router });

  return Object.freeze({ config: pinned, async authorize(raw) {
    const allowed = new Set(['trader', 'recipient', 'tokenIn', 'tokenOut', 'amountIn', 'slippageBps', 'nonce', 'quoteId']);
    if (!raw || Object.keys(raw).some(k => !allowed.has(k))) fail('unexpected request field');
    const request = freeze({ trader: address(raw.trader, 'trader'), recipient: address(raw.recipient ?? raw.trader, 'recipient'),
      tokenIn: address(raw.tokenIn, 'input token', true), tokenOut: address(raw.tokenOut, 'output token', true),
      amountIn: uint(raw.amountIn, 'input amount', true), nonce: uint(raw.nonce, 'nonce'),
      slippageBps: raw.slippageBps, quoteId: raw.quoteId });
    if ((request.tokenIn === ZERO) === (request.tokenOut === ZERO) || request.recipient === pinned.router) fail('unsupported pair or recipient');
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > 3000) fail('slippage');
    if (typeof request.quoteId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.quoteId)) fail('quote ID');
    const buy = request.tokenIn === ZERO;
    if (buy && request.amountIn > pinned.maxNativeAmount) fail('native cap');
    const deployment = await verifyDeployment(pinned);
    if (!deployment || deployment.paused !== false || deployment.chainId !== pinned.chainId ||
      !['router', 'signer', 'feeRecipient', 'wrappedNative', 'permit2', 'policyId', 'runtimeCodeHash'].every(k => same(deployment[k], pinned[k])) ||
      uint(deployment.maxNativeAmount, 'deployed cap') !== pinned.maxNativeAmount) fail('deployment does not match pinned configuration');
    const wall = Math.floor(now() / 1000), block = Number(deployment.blockTimestamp);
    if (!Number.isSafeInteger(block) || Math.abs(wall - block) > 15) fail('stale chain clock');
    const issuedAt = Math.min(wall, block);
    const decision = await resolveFeeDecision(request, pinned);
    if (!decision || !['0', '5', '10', '15', '20'].includes(decision.platformFeeBps)) fail('invalid server fee decision');
    const feeBps = Number(decision.platformFeeBps);
    const deadline = Math.min(issuedAt + 30, Number(decision.deadlineSeconds ?? issuedAt + 30));
    if (!Number.isSafeInteger(deadline) || deadline <= wall) fail('expired decision');
    const verified = await verifyExecution(freeze({ request, config: pinned, feeBps, issuedAt, deadline }));
    if (!verified || verified.verified !== true) fail('execution not verified');
    const plan = freeze(structuredClone({ calls: verified.calls, tokens: verified.tokens }));
    if (!Array.isArray(plan.calls) || plan.calls.length < 1 || plan.calls.length > 12 || !Array.isArray(plan.tokens) || plan.tokens.length < 1 || plan.tokens.length > 8) fail('invalid route bounds');
    const netOut = uint(verified.netAmountOut, 'net output', true);
    const accounting = nativeFeeAccounting(verified.grossNative, feeBps, verified.nativeRefund ?? 0n);
    if (accounting.grossNative > pinned.maxNativeAmount || (buy && accounting.grossNative !== request.amountIn) ||
      (!buy && (accounting.nativeRefund !== 0n || accounting.netNative !== netOut))) fail('fee accounting differs from verified output');
    const minOut = netOut * BigInt(10000 - request.slippageBps) / 10000n;
    if (minOut === 0n) fail('minimum below precision');
    const routeHash = terminalRouteHash(plan);
    // Reserve only after the exact fee-adjusted plan and net minimum are known.
    const reserved = await reserveFeeDecision(freeze({ request, config: pinned, feeBps,
      routeHash, minOut, deadline, accounting }));
    if (!reserved || reserved.platformFeeBps !== String(feeBps) ||
      (reserved.deadlineSeconds != null && Number(reserved.deadlineSeconds) !== deadline)) fail('fee changed; requote required');
    const reservationId = reserved.reservationId;
    const entitlementId = feeBps < 20 ? bytes32(typeof reservationId === 'string' && /^[0-9a-fA-F]{64}$/.test(reservationId) ? `0x${reservationId}` : reservationId, 'reservation') : ZERO_HASH;
    if (feeBps === 20 && reservationId != null) fail('paid decision cannot consume an entitlement');
    const message = freeze({ trader: request.trader, recipient: request.recipient, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
      amountIn: request.amountIn, minOut, routeHash, builderId: ZERO_HASH, builderRecipient: ZERO,
      motionFeeBps: feeBps, builderFeeBps: 0, issuedAt, deadline, nonce: request.nonce,
      purpose: TERMINAL_PURPOSE, policyId: pinned.policyId, entitlementId });
    const typedData = freeze({ domain, types: TERMINAL_TYPES, primaryType: 'Quote', message });
    const digest = hashTypedData(typedData);
    if (Math.floor(now() / 1000) >= deadline) fail('verification exhausted quote deadline');
    const claim = freeze({ nonceKey: `${pinned.chainId}:${pinned.router.toLowerCase()}:${request.trader.toLowerCase()}:${request.nonce}`,
      reservationId: feeBps < 20 ? entitlementId.slice(2) : null, digest, deadline });
    if (await claimAuthorization(claim) !== true) fail('nonce or reservation already bound');
    const signature = await signerAccount.signTypedData(typedData);
    if (!await verifyTypedData({ ...typedData, address: pinned.signer, signature })) fail('signer returned invalid signature');
    if (Math.floor(now() / 1000) >= deadline) fail('signature exhausted quote deadline');
    const data = encodeFunctionData({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', args: [message, plan.calls, plan.tokens, signature] });
    return freeze(jsonSafe({ quote: message, calls: plan.calls, tokens: plan.tokens, signature, digest,
      transaction: { chainId: pinned.chainId, to: pinned.router, value: buy ? request.amountIn : 0n, data },
      accounting, feeRecipient: pinned.feeRecipient, expiresAt: deadline * 1000,
      requiresWalletSignature: true, broadcast: false }));
  } });
}
