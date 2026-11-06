// click → first accept (the REAL signAndSend + broadcast, nonce cached) on the fake network with each road's latency drawn
// from what was measured from a browser origin on 2026-11-04 (p50 / p90 ms, keep-alive). Interleaved A/B/C, alternating order:
//   A = protection OFF (today's roads), B = protection ON (private-first), C = OFF again (noise control)
//   node scripts/mev-v2-bench.mjs [clicks per arm] [runs]
import { network, frame, wallet, send, sleep } from '../test/mev-v2-sim.mjs';
const LAT = {
  'https://bsc-rpc.publicnode.com': [60.2, 80.7], 'https://rpc-bsc.48.club': [60.1, 63.7], 'https://bsc.rpc.blxrbdn.com': [54.3, 60.7],
  'https://bscrpc.pancakeswap.finance': [57.5, 62.5], 'https://bsc.blockrazor.xyz/fullprivacy': [61.3, 67.9],
};
const N = Number(process.argv[2] || 150), RUNS = Number(process.argv[3] || 2);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
for (let run = 1; run <= RUNS; run++) {
  const net = network({ lat: LAT });
  const arms = { A: { f: frame(net, { mev: false }), ms: [] }, B: { f: frame(net, { mev: true }), ms: [] }, C: { f: frame(net, { mev: false }), ms: [] } };
  const paths = {};
  for (const k of Object.keys(arms)) { arms[k].w = wallet(); await send(arms[k].f, arms[k].w); }   // warm: nonce read once
  await sleep(1200);
  for (let i = 0; i < N; i++) {
    const order = i % 2 ? ['C', 'B', 'A'] : ['A', 'B', 'C'];
    for (const k of order) { const a = arms[k]; const t0 = performance.now(); await send(a.f, a.w); a.ms.push(performance.now() - t0); if (k === 'B') paths[a.f.path] = (paths[a.f.path] || 0) + 1; await sleep(5); }
  }
  for (const [k, a] of Object.entries(arms)) console.log(`run ${run} ${k} ${k === 'B' ? 'ON ' : 'OFF'} p50 ${pct(a.ms, 0.5)} p90 ${pct(a.ms, 0.9)} p99 ${pct(a.ms, 0.99)} ms (n=${a.ms.length})`);
  console.log(`run ${run} B paths ${JSON.stringify(paths)}; public mempool saw ${[...net.seenPublic].length} distinct txs in total (A + C are public by design)`);
  await net.stop();
}
process.exit(0);
