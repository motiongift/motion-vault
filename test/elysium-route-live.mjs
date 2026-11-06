// (2026-11-04) dry-run sims of each leg of the official route into Elysium, against the LIVE networks, read-only: nothing is signed or
// sent, no key is read. Skipped unless ELY_LIVE=1 (network). Legs:
//   1. Relay: the vault's own body (elyRelayBody) for a FRESH address → api.relay.link POST /quote/v2 → every check (elyRelayProblem)
//      with OUR HYPE price (the HyperEVM WHYPE/USDC pool's slot0) — Robinhood ETH, BNB USDC, Solana SOL;
//   2. HyperEVM: eth_estimateGas + eth_call of W's Inbox.depositEth() from a funded plain EOA, checked by inboxDepositProblem;
//   3. arrival: a real past deposit's L2 hash from its message number (elyDepositHash) is found on Elysium as a 0x64 deposit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ELY_ROUTE, elyRelayBody, elyRelayProblem, inboxDepositTx, inboxDepositProblem, elyDepositHash, l1ToL2Alias } from '../src/elysiumRoute.ts';
import { bridgeCfg, v3Price6 } from '../src/motionBridgeCore.ts';

const LIVE = process.env.ELY_LIVE === '1';
const HYPEREVM = 'https://rpc.hyperliquid.xyz/evm', ELYSIUM = 'https://rpc-live.elysp.com';
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error)); return j.result; };
const hypePrice6 = async () => { const p = bridgeCfg('elysium').oracle; const r = await rpc(HYPEREVM, 'eth_call', [{ to: p.pool, data: '0x3850c7bd' }, 'latest']); return v3Price6(BigInt('0x' + r.slice(2, 66)), p); };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (u8) => { let n = BigInt('0x' + Buffer.from(u8).toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const relay = async (body) => { const t = Date.now(); const r = await fetch('https://api.relay.link/quote/v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }); return { j: await r.json(), ms: Date.now() - t, status: r.status }; };

const CASES = [
  { name: 'Robinhood ETH 0.2', src: 'robinhood', coin: 'native', amount: 2n * 10n ** 17n },
  { name: 'BNB USDC 500', src: 'bsc', coin: 'stable', amount: 500n * 10n ** 18n },
  { name: 'Solana SOL 5', src: 'sol', coin: 'native', amount: 5n * 10n ** 9n },
];
for (const c of CASES) {
  test(`live leg 1 — Relay quote ${c.name} → native HYPE on 999 for a fresh address passes every vault check`, { skip: !LIVE }, async () => {
    const w = '0x' + randomBytes(20).toString('hex');
    const payer = c.src === 'sol' ? b58(randomBytes(32)) : w;
    const body = elyRelayBody({ src: c.src, coin: c.coin, payer, w, amount: c.amount });
    const [{ j, ms, status }, p6] = await Promise.all([relay(body), hypePrice6()]);
    assert.equal(status, 200, JSON.stringify(j).slice(0, 200));
    const inUsd6 = BigInt(Math.round(Number(j.details.currencyIn.amountUsd) * 1e6));   // the source's price: Relay's own figure (sim only)
    const b = elyRelayProblem(j, body, { inUsd6, hypePrice6: p6 });
    assert.equal(b.problem, undefined);
    assert.equal(b.appFee, (c.amount * 10n) / 10_000n);
    console.log(`  ${c.name}: ${ms} ms, out ${Number(b.out) / 1e18} HYPE (min ${Number(b.minOut) / 1e18}), app fee ${b.appFee} (10 bps), Relay fee $${b.relayFeeUsd}, ETA ${b.etaS} s, our HYPE $${Number(p6) / 1e6}`);
  });
}

test('live leg 2 — W\'s Inbox.depositEth() from a funded plain EOA: eth_estimateGas + eth_call succeed, the bounded tx passes the check', { skip: !LIVE }, async () => {
  const from = '0x0894ed6c7cb37565464becf358e475231e86fa57';                 // a real depositor (code 0x), read-only
  const [code, bal, gp] = await Promise.all([rpc(HYPEREVM, 'eth_getCode', [from, 'latest']), rpc(HYPEREVM, 'eth_getBalance', [from, 'latest']).then(BigInt), rpc(HYPEREVM, 'eth_gasPrice', []).then(BigInt)]);
  assert.equal(code, '0x');
  const value = bal > 2n * 10n ** 15n ? 10n ** 15n : bal / 4n;
  assert.ok(value > 0n, 'the sample EOA is empty now — pick another plain depositor');
  const tx = inboxDepositTx(value);
  const call = { from, to: tx.to, data: tx.data, value: '0x' + value.toString(16) };
  const [est, ret] = await Promise.all([rpc(HYPEREVM, 'eth_estimateGas', [call]).then(BigInt), rpc(HYPEREVM, 'eth_call', [call, 'latest'])]);
  const gas = (est * 13n) / 10n, gasPrice = (gp * 5n) / 4n;
  assert.ok(est > 80_000n && est < 120_000n, String(est));
  assert.equal(inboxDepositProblem({ ...tx, gas: gas > ELY_ROUTE.depositGas ? ELY_ROUTE.depositGas : gas, gasPrice, chainId: 999 }, value), '');
  console.log(`  depositEth: estimateGas ${est}, eth_call → message number ${BigInt(ret)}, gas price ${Number(gp) / 1e9} gwei, cost ≈ ${Number(gas * gasPrice) / 1e18} HYPE`);
});

test('live leg 3 — arrival: a real deposit\'s L2 hash from its message number is a 0x64 deposit on Elysium paying the depositor', { skip: !LIVE }, async () => {
  const from = '0x0894ed6c7cb37565464becf358e475231e86fa57', value = 230000000000000000n;
  const h = elyDepositHash(423768n, from, value);
  const t = await rpc(ELYSIUM, 'eth_getTransactionByHash', [h]);
  assert.ok(t && t.blockNumber, 'not found on Elysium');
  assert.equal(t.type, '0x64'); assert.equal(t.to.toLowerCase(), from); assert.equal(t.from.toLowerCase(), l1ToL2Alias(from)); assert.equal(BigInt(t.value), value);
  console.log(`  L2 deposit ${h} in Elysium block ${BigInt(t.blockNumber)}`);
});
