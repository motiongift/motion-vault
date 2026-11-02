// 2026-11-01, audit pass 2 (money): p2-money-forward-nonce-race. W's forward on another EVM chain signs with W's 'pending'
// nonce from another frame; the trade core in that chain's own tab signs from its cached nonce without the forward's lock.
// Priced above the node's gas price, the forward could replace a pending buy at the same nonce. node --test test/money-fix2.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('p2 forward-nonce-race: the W forward pays the node\'s own gas price (max of base fee and gas price), never a premium over it', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function wForwardSend('), src.indexOf('async function nativeDonorReceipt('));
  assert.ok(fn.length > 200);
  assert.match(fn, /const floor = base > gp \? base : gp;/);
  assert.doesNotMatch(fn, /\* 125n|\* 12\dn|\* 11\dn/, 'no premium over the node price');
  // the F-73 ceilings and the balance checks stay
  assert.match(fn, /oc\.maxGasPrice && floor > oc\.maxGasPrice/);
  assert.match(fn, /if \(bal < gas \* floor\) throw/);
});
