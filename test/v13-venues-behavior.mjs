// V13 hardening — venue behaviour that needs no network: the four.meme sell with a floor (VA-8) and the Meteora DLMM pool
// addresses the vault derives itself (VA-9). Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { FOUR_MANAGER_ABI } from '../src/bnbRouter.ts';
import { dlmmCandidateAddrs } from '../src/solEngine.ts';

test('VA-8: four.meme sells encode TokenManager2\'s floored overload sellToken(origin, token, amount, minFunds)', () => {
  const token = '0xedc035e6d319e75e063f48b78de904a84fb0ffff';
  const data = encodeFunctionData({ abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [0n, token, 10n ** 18n, 12345n] });
  // 0x0da74935 = sellToken(uint256,address,uint256,uint256): present in the live implementation behind
  // 0x5c952063…762b (checked 2026-10-25 by eth_call with a state override: a floor above the payout reverts "Slippage")
  assert.equal(data.slice(0, 10), '0x0da74935');
  const d = decodeFunctionData({ abi: FOUR_MANAGER_ABI, data });
  assert.deepEqual(d.args.map((x) => (typeof x === 'string' ? x.toLowerCase() : x)), [0n, token, 10n ** 18n, 12345n]);
  // the two-argument form (no minimum) still encodes to its own selector, so a regression is visible here
  assert.equal(encodeFunctionData({ abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [token, 1n] }).slice(0, 10), '0xf464e7db');
});

test('VA-9: the vault derives a coin\'s permissionless DLMM pools itself (both live pools of S&P500 are among them)', async () => {
  // ABiHPG… (S&P500) trades in two Meteora pools against SOL, presets 14 and 124 (read on chain 2026-10-25)
  const addrs = await dlmmCandidateAddrs('ABiHPGnupPSjeMPyYn7hyeYjdAM6zV3foSnJexxLXhev');
  assert.ok(addrs.includes('8fLSz2R7xuzWtPrNaB54k3v2kTVATTcGYVLYPUCLzFht'));
  assert.ok(addrs.includes('8F2FcqrnJdKb7YBy1RA2BX6ZevB41N2H6qZDpj9CSndV'));
  assert.ok(addrs.length >= 400 && addrs.length < 450);
  assert.equal(new Set(addrs).size, addrs.length);
});
