// release 7.1: the probe is split into eth_calls under the nodes' 256 KiB body limit (BOXA: HTTP 413 "Request exceeds 256 KiB")
//   node --experimental-strip-types --test test/elysium-rel71-chunks.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as E from '../src/elysiumCore.ts';
import { CORE_REGIONS, regionChunk } from '../scripts/trade-core.mjs';

const JANK = '0xc6c7d849cad199ab5140c34fca08d55c9f68e7a3';
const ASC = '0xe0def4221b9840a610d4e7d55812a79a6431a8ec';
const ROUTE = { type: 'ely', chainId: 99901, venue: 'uni-v4', pair: 'weth', poolKey: { currency0: E.ELY_WHYPE, currency1: JANK, fee: 0x800000, tickSpacing: 200, hooks: ASC }, hook: { codeHash: '0x190f4d572cbca47e96519434e6c6dfd537ffd13ce9e5a657fa5fa120a4bad6f1', tier: 'reviewed' } };
const FROM = '0x00000000000000000000000000000000f00dbabe';
const buyCases = (amt) => {
  const cands = E.elyCandidates(JANK, ROUTE), d = 9999999999n, refIn = amt / E.ELY_REF_DIVISOR;
  return [...cands.map((c) => E.probeCase(c, JANK, { buy: amt, roundTrip: true, transferBps: E.ELY_TAX_TEST_BPS, deadline: d })), ...cands.map((c) => E.probeCase(c, JANK, { buy: refIn, deadline: d })), ...cands.map((c) => E.probeCase(c, JANK, { buy: E.ELY_LANE_REF_IN, roundTrip: true, deadline: d }))];
};
const bodyBytes = (cs) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: FROM, to: FROM, data: E.probeData(cs), gas: '0x1c9c380', gasPrice: '0x5f5e100' }, 'latest', E.elyProbeState(FROM, 10n ** 18n)] }).length;

test('a full 17-pool buy probe (the one that hit 413 live) is over 256 KiB as one call, and every chunk is well under it', () => {
  const cases = buyCases(58_700_000_000_000_000n);
  assert.equal(cases.length, 51);
  assert.ok(bodyBytes(cases) > 262_144, 'one call: over the limit (' + bodyBytes(cases) + ' B)');
  const chunks = E.elyProbeChunks(cases);
  assert.ok(chunks.length >= 2);
  for (const ch of chunks) assert.ok(bodyBytes(ch) < 230_000, 'chunk body ' + bodyBytes(ch) + ' B');
  assert.deepEqual(chunks.flat(), cases, 'the same cases, in the same order');
});

test('a small probe stays one call; an empty one is no call; one case bigger than the cap still goes alone', () => {
  const cases = buyCases(10n ** 16n).slice(0, 3);
  assert.equal(E.elyProbeChunks(cases).length, 1);
  assert.deepEqual(E.elyProbeChunks([]), []);
  const one = E.elyProbeChunks(cases, 10);
  assert.equal(one.length, 3); assert.ok(one.every((c) => c.length === 1));
});

test('the joined answers decode in case order (run() answers one ElySeen per case: chunk answers concatenate)', async () => {
  const { encodeFunctionResult } = await import('viem');
  const cases = buyCases(10n ** 16n), chunks = E.elyProbeChunks(cases, 20_000);
  assert.ok(chunks.length >= 3);
  let k = 0;
  const answer = (cs) => encodeFunctionResult({ abi: E.ELY_PROBE_ABI, functionName: 'run', result: cs.map(() => { k += 1; return { ran: true, buyOk: true, coinGot: BigInt(k), nativeSpent: 1n, buyGas: 1n, sellOk: true, coinSold: 1n, nativeBack: 1n, sellGas: 1n, taxSent: 0n, taxGot: 0n, routerKept: false, err: '0x' }; }) });
  const seen = chunks.map(answer).flatMap((ret) => E.probeDecode(ret));
  assert.equal(seen.length, cases.length);
  assert.deepEqual(seen.map((s) => Number(s.coinGot)), cases.map((_, i) => i + 1));
});

test('the pinned webEngine region moved by exactly the two rel7.1 lines (restoring them gives the approved region back)', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
  const pinned = JSON.parse(readFileSync(new URL('./fixtures/trade-core.json', import.meta.url), 'utf8'));
  const NEW1 = src.split('\n').find((l) => l.includes('(rel7.1 T1) under 256 KiB per call'));
  const NEW2 = src.split('\n').find((l) => l.includes('(rel7.1 T1) the chunks'));
  assert.ok(NEW1 && NEW2, 'the two tagged lines');
  const OLD1 = "  const ret = await client.request({ method: 'eth_call', params: [{ from, to: from, data: ELY.probeData(cases), gas: '0x' + ELY_PROBE_GAS.toString(16), gasPrice: '0x' + gasPrice.toString(16) }, 'latest', ELY.elyProbeState(from, balance)] } as any) as `0x${string}`;";
  const OLD2 = '  const seen = ELY.probeDecode(ret);';
  const back = src.replace(NEW1, OLD1).replace(NEW2, OLD2);
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  for (const [f, regions] of Object.entries(CORE_REGIONS)) for (const [a, b] of regions) assert.equal(sha(regionChunk(back, a, b)), pinned.decls[`${f}#${a}…${b}`], `${f} ${a}…${b}`);
});
