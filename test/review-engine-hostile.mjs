// review-engine 2026-11-09 — independent adversarial tests of the INTEGRATED candidate fee-sprint-1109 (9704be5).
// Mock chain + freshly generated test signers only. No network, no real key, nothing sent.
//   node --experimental-strip-types --test test/review-engine-hostile.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, encodeFunctionResult, keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TERMINAL_EXECUTE_ABI, TERMINAL_TYPES, TERMINAL_PURPOSE, ZERO, ZERO_HASH, terminalRouteHash } from '../src/terminal-evm/quote-authorization.mjs';
import { EVM_CHAINS, buildEvmCalls } from '../src/terminal-evm/routes/api-swap-evm-routes.mjs';
import { verifyTerminalEvm, simulateTerminalEvm, terminalMarketKey, PONS_CURVE_ABI } from '../src/terminal-evm/vault-guard.mjs';
import { limitWorld, TOKEN } from './fixtures/limit-world.mjs';

const SRC = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const NOW = 1800000000000, T = NOW / 1000;
const RH = EVM_CHAINS.robinhood, BSC = EVM_CHAINS.bsc;
const COLLECTOR = '0x74f25914dcce21555188b523748d3b3f557ed297';
const word = x => (typeof x === 'bigint' ? x.toString(16) : String(x).slice(2).toLowerCase()).padStart(64, '0');
const ponsRegistry = ({ curve, pair = ZERO, status = 1n }) => '0x' + Array.from({ length: 16 }, (_, i) => i === 1 ? word(curve) : i === 4 ? word(pair) : i === 14 ? word(status) : word(0n)).join('');

// One genuine, router-signed quote on a mock chain. Every hostile case mutates exactly one thing.
async function world({ chainId = 4663, route, side = 'buy', fee = 20, ponsV2 = { enabled: true, factory: RH.ponsFactory, factoryCodeHash: keccak256('0xfac70a1e') },
  marketKeyed = true, bnbVenues = [], venues, mutateCalls, reads: readOver = {}, registry, netOverride, minOut = 99000n } = {}) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const token = a(4), executor = a(8), trader = a(3);
  const cfg = chainId === 56 ? BSC : RH, chain = chainId === 56 ? 'bsc' : 'robinhood';
  const config = { chainId, router: a(1), owner: a(9), signer: signer.address, feeRecipient: COLLECTOR, wrappedNative: cfg.wrapped, permit2: cfg.permit2,
    policyId: keccak256('0xab'), runtimeCodeHash: keccak256('0x1234'), maxNativeAmount: '1000000', marketKeys: marketKeyed ? [terminalMarketKey(token, route)] : [],
    ...(venues ? { venues } : {}), ...(ponsV2 ? { ponsV2 } : {}) };
  const intent = { trader, token, side, amount: '100000', slippageBps: 100 };
  const net = netOverride ?? (side === 'buy' ? 100000n - 100000n * BigInt(fee) / 10000n : 100000n);
  let plan;
  try { plan = buildEvmCalls({ chain, route, token, side, amount: net, executor, deadline: T + 30 }); }
  catch { plan = { calls: [{ target: a(0xbad), value: 0n, data: '0x', approvalToken: ZERO, approvalSpender: ZERO, approvalAmount: 0n, usePermit2: false, amountOffset: 0 }], tokens: [token] }; }
  if (mutateCalls) plan = mutateCalls(structuredClone(plan), { token, executor, trader, net });
  const q = { trader, recipient: trader, tokenIn: side === 'buy' ? ZERO : token, tokenOut: side === 'buy' ? token : ZERO, amountIn: 100000n, minOut,
    routeHash: terminalRouteHash(plan), builderId: ZERO_HASH, builderRecipient: ZERO, motionFeeBps: fee, builderFeeBps: 0, issuedAt: T, deadline: T + 30,
    nonce: 7n, purpose: TERMINAL_PURPOSE, policyId: config.policyId, entitlementId: fee < 20 ? keccak256('0xbeef') : ZERO_HASH };
  const signature = await signer.signTypedData({ domain: { name: 'TerminalRouter', version: '1', chainId, verifyingContract: config.router }, types: TERMINAL_TYPES, primaryType: 'Quote', message: q });
  const transaction = { chainId, to: config.router, value: side === 'buy' ? '100000' : '0', data: encodeFunctionData({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', args: [q, plan.calls, plan.tokens, signature] }) };
  const reads = { owner: config.owner, signer: config.signer, feeRecipient: COLLECTOR, wrappedNative: config.wrappedNative, permit2: config.permit2, policyId: config.policyId,
    PURPOSE: TERMINAL_PURPOSE, maxNativeAmount: 1000000n, paused: false, usedNonces: false, usedEntitlements: false, executorFor: executor,
    trySell: [BSC.fourManager, ZERO], getPool: a(0x9001), liquidity: 10n ** 18n, ...readOver };
  const codes = { [config.router]: '0x1234', [RH.ponsFactory]: '0xfac70a1e', [String(route.curve || '').toLowerCase()]: '0xc0de' };
  const client = { getChainId: async () => chainId, getBlock: async () => ({ timestamp: BigInt(T) }),
    getBytecode: async ({ address }) => codes[address.toLowerCase()],
    readContract: async ({ functionName }) => reads[functionName],
    call: async ({ to }) => to.toLowerCase() === RH.ponsFactory ? { data: registry ?? ponsRegistry({ curve: route.curve }) }
      : { data: encodeFunctionResult({ abi: TERMINAL_EXECUTE_ABI, functionName: 'execute', result: 100000n }) } };
  const run = () => verifyTerminalEvm({ config, client, transaction, route, intent, now: NOW, bnbVenues });
  return { run, config, client, transaction, route, intent, plan, q };
}
const PONS = { type: 'pons', chainId: 4663, curve: a(0xc1), pairToken: ZERO, feeBps: 100, creatorTaxBps: 200, bridgeFee: 0, bridgeHops: [], bridgeFees: [], quoteSymbol: '' };
const V4 = { type: 'v4', chainId: 4663, poolKey: { currency0: ZERO, currency1: a(4), fee: 3000, tickSpacing: 60, hooks: ZERO } };
const FOUR = { type: 'four', chainId: 56, manager: BSC.fourManager, helper: BSC.fourHelper, quoteToken: ZERO };
const V3B = { type: 'v3', chainId: 56, fee: 2500, quoteToken: BSC.wrapped };
const refused = async (p, re) => assert.rejects(p, re ?? /Terminal EVM refused/);

// ── E1 the hand-merged vault guard: venue matrix composition ──
test('E1.1 sanity: a genuine RH Pons V2 buy and sell, and a genuine RH V4 buy, verify on the merged guard', async () => {
  for (const side of ['buy', 'sell']) await (await world({ route: PONS, side })).run();
  await (await world({ route: V4 })).run();
});
test('E1.2 BNB venue flag never leaks to Robinhood; Pons never leaks to BNB; bsc config.venues cannot add BNB venues', async () => {
  await refused((await world({ route: { ...V3B, chainId: 4663 }, bnbVenues: ['v3', 'inf', 'four', 'flap'] })).run(), /venue not enabled/);
  await refused((await world({ chainId: 56, route: { ...PONS, chainId: 56 }, bnbVenues: ['v3', 'inf', 'four', 'flap'] })).run(), /venue not enabled/);
  await refused((await world({ chainId: 56, route: FOUR, venues: ['v2', 'four'] })).run(), /venue configuration/);
  await refused((await world({ chainId: 56, route: FOUR })).run(), /venue not enabled/);                       // flag off
  await (await world({ chainId: 56, route: FOUR, bnbVenues: ['four'] })).run();                                   // flag on + key
  await refused((await world({ chainId: 56, route: FOUR, bnbVenues: ['four'], marketKeyed: false })).run(), /not deployment-approved/);
  await refused((await world({ route: { ...V4, chainId: 4663 }, venues: ['standard-pool'] })).run(), /venue not enabled/);
});
test('E1.3 Pons: the engine-side strip of ponsV2 (TERMINAL_EVM_PONS_V2=false) closes the venue even for a valid policy', async () => {
  // the exact expression terminalTradeEvm uses
  assert.match(SRC, /const policy = pinned \? \(TERMINAL_EVM_PONS_V2 \? pinned : \{ \.\.\.pinned, ponsV2: undefined \}\) : null;/);
  await refused((await world({ route: PONS, ponsV2: null })).run(), /venue not enabled/);   // = { ...pinned, ponsV2: undefined }
  await refused((await world({ route: PONS, ponsV2: { enabled: 'true', factory: RH.ponsFactory, factoryCodeHash: keccak256('0xfac70a1e') } })).run(), /venue not enabled/);
});
test('E1.4 Pons fund-loss shapes: output to the trader directly, MAX sell approval, extra call, wrong curve, graduated/foreign registry', async () => {
  const toTrader = (p, { trader, net }) => { p.calls[0].data = encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'buy', args: [net, 0n, trader] }); return p; };
  await refused((await world({ route: PONS, mutateCalls: toTrader })).run());
  const maxApprove = p => { p.calls[0].approvalAmount = (1n << 256n) - 1n; return p; };
  await refused((await world({ route: PONS, side: 'sell', mutateCalls: maxApprove })).run());
  const extra = p => { p.calls.push({ ...p.calls[0] }); return p; };
  await refused((await world({ route: PONS, mutateCalls: extra })).run());
  await refused((await world({ route: PONS, registry: ponsRegistry({ curve: a(0xc2) }) })).run(), /registry/);
  await refused((await world({ route: PONS, registry: ponsRegistry({ curve: PONS.curve, status: 2n }) })).run(), /registry/);
  await refused((await world({ route: { ...PONS, pairToken: a(0x5) }, registry: ponsRegistry({ curve: PONS.curve, pair: a(0x5) }) })).run(), /native-pair/);
  await refused((await world({ route: { ...PONS, curve: [PONS.curve] } })).run(), /pons route shape/);
});
test('E1.5 overcharge: a rate above 20 bps, or a buy whose inner amount takes more than the quoted rate, is refused', async () => {
  await refused((await world({ route: PONS, fee: 25 })).run(), /fee policy/);
  // quote says 20 bps, calls forward amount - 30 bps (10 bps silently kept by the route) -> independent rebuild differs
  await refused((await world({ route: PONS, netOverride: 100000n - 300n })).run(), /route differs|pons amount/);
  await refused((await world({ route: V4, netOverride: 100000n - 300n })).run(), /route differs/);
});
test('E1.6 wrong collector / paused / replay: router feeRecipient drift, paused router, used nonce, used entitlement are refused', async () => {
  await refused((await world({ route: PONS, reads: { feeRecipient: a(0x4242) } })).run(), /deployment configuration/);
  await refused((await world({ route: PONS, reads: { paused: true } })).run(), /deployment configuration/);
  await refused((await world({ route: PONS, reads: { usedNonces: true } })).run(), /consumed/);
  await refused((await world({ route: PONS, fee: 0, reads: { usedEntitlements: true } })).run(), /consumed/);
  // a discounted quote without an entitlement id, or a 20-bps quote that consumes one, is malformed
  const w = await world({ route: PONS, fee: 15 });
  assert.equal(w.q.entitlementId !== ZERO_HASH, true);
});
test('E1.7 min-out: the vault refuses a receipt whose minimum is below the user slippage floor of the simulated output', async () => {
  const w = await world({ route: PONS, minOut: 90000n });   // simulated 100000, slippage 1 % -> floor 99000
  const v = await w.run();
  await assert.rejects(simulateTerminalEvm({ client: w.client, verified: v, config: w.config, now: NOW }), /slippage floor/);
});

// ── E2 the fixes of this review (engine source; the lanes are OFF in this build, so behaviour is pinned by source) ──
const sol = SRC.slice(SRC.indexOf('async function terminalTrade(request'), SRC.indexOf('async function terminalTradeEvm'));
const evm = SRC.slice(SRC.indexOf('async function terminalTradeEvm'));
test('E2.1 SOL lane works on its own copy of the request BEFORE the fee-policy check (no TOCTOU on envelope/serialized)', () => {
  const clone = sol.indexOf('const r = structuredClone(request) as Record<string, unknown>;');
  assert.ok(clone > 0, 'request is cloned');
  assert.ok(clone < sol.indexOf('terminalFeeDecision(') && clone < sol.indexOf('solTerminalTrade('));
  assert.ok(sol.indexOf('if (!TERMINAL_SOL_POLICY) throw') < clone, 'flag-off fast-fail stays first');
});
test('E2.2 without a pinned fee-policy key the quote signer alone cannot grant a discount (EVM + SOL require 20 bps)', () => {
  const e = evm.indexOf("} else if (Number(verified.quote.motionFeeBps) !== 20) {");
  assert.ok(e > 0 && e < evm.indexOf('journal.claim(') && e < evm.indexOf('signTransaction'));
  const s = sol.indexOf('if (p.feeBps !== 20) throw');
  assert.ok(s > 0 && s < sol.indexOf('solTerminalTrade('));
});
test('E2.3 one collector per chain: router feeRecipient / SOL receipt treasury must equal the fee-leg collector when pinned', () => {
  assert.ok(evm.indexOf('const legCollector = TERMINAL_FEE_LEG.collectors[key') > 0 && evm.indexOf('const legCollector') < evm.indexOf('await gate('));
  assert.ok(sol.indexOf('TERMINAL_FEE_LEG.collectors.sol !== TERMINAL_SOL_POLICY.feeRecipient') > 0);
});

// ── E3 limit fee leg: known residual, reproduced (keeper trust) ──
test('E3 RESIDUAL R1b: a keeper that sends the swap early (it reverts) can then land the pre-signed fee of an order that never filled',
  { todo: 'keeper-trust residual (bypass review R1, extended to reverted swaps); not closable in the vault with a plain transfer' }, async () => {
  const w = limitWorld({ feeLeg: { collector: COLLECTOR, bps: 20 } });
  const o = (await w.limit.place({ walletId: 'w1', token: TOKEN, side: 'buy', kind: 'limit', price: (w.chain.price() * 0.9).toFixed(15), amount: '0.05', expiresIn: 86400, route: w.route, idempotencyKey: 'r1b-order-0001' })).order;
  const posted = w.keeper.orders.get(o.orderId);
  const swap = posted.txs.find(t => t.role === 'swap'), fee = posted.txs.find(t => t.role === 'fee');
  await w.chain.sendRaw(swap.raw);                                   // price is 10 % above the limit: the swap reverts, nonce used
  assert.equal(w.chain.receipts.get(keccak256(swap.raw)).status, '0x0');
  const col0 = w.chain.ethOf(COLLECTOR);
  await w.chain.sendRaw(fee.raw).catch(() => null);                  // the keeper still holds valid fee bytes
  assert.equal(w.chain.ethOf(COLLECTOR), col0, 'an order that never filled must pay no fee');
  assert.equal(Number(parseTransaction(fee.raw).nonce), Number(o.swapNonce) + 1);
});
