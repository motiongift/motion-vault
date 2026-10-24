// V12 batch-1 source pins. These assert the engines in this clone still carry each fix, so a later edit that
// silently drops one fails CI. Refs = motion-vault 2673f23 (the live engine). Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sol = readFileSync(join(here, '..', 'src', 'solEngine.ts'), 'utf8');
const near = readFileSync(join(here, '..', 'src', 'nearEngine.ts'), 'utf8');

test('F-54: DLMM candidates come from the indexer, never the page hint', () => {
  // the branch that used the page hint's dlmm list is gone
  assert.ok(!/if \(!Array\.isArray\(h\?\.dlmm\)\)/.test(sol), 'page-hint dlmm fallback still present');
  // candidates are kept (up to 3) and the trade picks the best out, not the reserve order
  assert.match(sol, /dlmmAlts = found\.slice\(0, 3\)/);
  assert.match(sol, /F-54 V12[\s\S]*quote every verified candidate at the real amount and take the pool with the best/);
  assert.match(sol, /q\.out > 0n && \(!best \|\| q\.out > best\.q\.out\)/);
});

test('F-8: applied tip + priority are clamped to ~0.005 SOL per tx', () => {
  assert.match(sol, /F-8 V12/);
  assert.match(sol, /const FEE_CEIL = 5_000_000n;/);
  assert.match(sol, /const CU_CEIL = 400_000n;/);
  assert.match(sol, /if \(tipLamports > FEE_CEIL\) tipLamports = FEE_CEIL;/);
  assert.match(sol, /if \(BigInt\(micro\) > prioCeilMicro\) micro = Number\(prioCeilMicro\);/);
});

test('F-38: solRpc validates read response shape and falls through', () => {
  assert.match(sol, /F-38 V12/);
  assert.match(sol, /const validRead = \(method: string, r: any\): boolean =>/);
  // the shape check guards all three roads
  assert.equal((sol.match(/if \(!validRead\(method, r\)\) throw new RpcError\('malformed RPC response', 0\)/g) || []).length, 3);
});

test('F-21: nearRoute ignores hint.bridgePool, 60s TTL, no stale overwrite', () => {
  assert.ok(!/hint\.bridgePool/.test(near), 'hint.bridgePool is still read');
  assert.ok(!/bridgeOk/.test(near), 'bridgeOk helper should be removed with its only caller');
  assert.match(near, /if \(quote !== NEAR\.wnear\) bridgePool = await findBridgePool\(quote\);/);
  assert.match(near, /Date\.now\(\) - c\.at < 60_000/);
  assert.ok(!/10 \* 60000/.test(near), '10-minute TTL still present');
  assert.match(near, /if \(!cur \|\| cur\.at < startedAt\) routeCache\.set\(t, \{ r, at: startedAt \}\);/);
});

test('F-21: no hint-price minOut fallback — throws No quote from Rhea', () => {
  // the trade-path fallback variables are gone (preview keeps a display-only price estimate, which is fine)
  assert.ok(!/const exp = /.test(near), 'buy trade still computes minOut from hint price');
  assert.ok(!/const expNear = /.test(near), 'sell trade still computes minOut from hint price');
  // both signed-minOut branches now throw instead of falling back
  assert.ok((near.match(/else throw new Error\('No quote from Rhea'\);/g) || []).length >= 2);
});

test('F-39: nearRpc snapshots the start index so every node is tried once', () => {
  assert.match(near, /F-39 V12/);
  assert.match(near, /const n = NEAR_RPCS\.length, s = rpcIdx;/);
  assert.match(near, /const url = NEAR_RPCS\[\(s \+ i\) % n\];/);
  assert.match(near, /rpcIdx = \(s \+ i \+ 1\) % n;/);
});

test('F-10: access key shape validated before signing', () => {
  assert.match(near, /F-10 V12/);
  assert.match(near, /export function validAccessKey/);
  assert.match(near, /\/\^\\d\{1,20\}\$\/\.test\(String\(r\.nonce\)\)/);
  assert.match(near, /r\.permission !== 'FullAccess'/);
  assert.match(near, /bh\.length !== 32/);
});

test('F-11: sweepOnce un-marks on failure; balance read throws', () => {
  assert.match(near, /F-11 V12/);
  assert.match(near, /unwrapLeftover\(a, me\)\.catch\(\(\) => swept\.delete\(me\)\)/);
  // the sweep's wNEAR balance read no longer swallows errors into "0" (it now throws, so the catch above retries)
  assert.match(near, /const bal = BigInt\(await nearView<string>\(NEAR\.wnear, 'ft_balance_of', \{ account_id: me \}\)\);/);
});
