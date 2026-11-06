// MEV v2 — step B of the owner's real-send check: watch the public mempool while you make ONE $1 BNB buy in the app, then paste
// its hash. Read-only, no key. It says whether the public mempool saw the buy before its block, which builder built that block,
// and how many 450 ms blocks after the click it landed.
//   1. node scripts/mev-v2-watch.mjs        (leave it running: it prints "watching" once subscribed)
//   2. in the app (BNB, protection on = default): buy $1 of a liquid coin; note the time of the click
//   3. paste the transaction hash (from the app's activity / explorer link) here and press Enter
import readline from 'node:readline/promises';
const PUB = 'https://bsc-rpc.publicnode.com';
const NAME = { '0x487e5dfe70119c1b320b8219b190a6fa95a5bb48': '48club', '0x48a5ed9abc1a8fbe86cec4900483f43a7f2dbb48': '48club', '0x5532cdb3c0c4278f9848fc4560b495b70ba67455': 'blockrazor', '0x539e24781f616f0d912b60813ab75b7b80b75c53': 'blockrazor', '0xba4233f6e478db76698b0a5000972af0196b7be1': 'blockrazor', '0x50061047b9c7150f0dc105f79588d1b07d2be250': 'blockrazor', '0x2873fc7ad9122933becb384f5856f0e87918388d': 'bloxroute', '0x2b217a4158933aade6d6494e3791d454b4d13ae7': 'bloxroute' };
const rpc = (method, params) => fetch(PUB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()).then((j) => j.result);
const seen = new Map(); let n = 0;
const ws = new WebSocket('wss://bsc-rpc.publicnode.com');
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions'] }));
ws.onmessage = (m) => { try { const h = JSON.parse(m.data)?.params?.result; if (typeof h === 'string') { n++; if (!seen.has(h.toLowerCase())) seen.set(h.toLowerCase(), Date.now()); } } catch {} };
await new Promise((r) => setTimeout(r, 3000)); console.log(`watching the public mempool (${n} pending hashes in 3 s). Make the $1 buy now.`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const hash = (await rl.question('trade hash: ')).trim().toLowerCase(); rl.close();
let r = null; for (let i = 0; i < 60 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (!r) await new Promise((x) => setTimeout(x, 1000)); }
ws.close();
if (!r) { console.log('no receipt in 60 s: pending or dropped — check the explorer'); process.exit(1); }
const blk = await rpc('eth_getBlockByNumber', [r.blockNumber, true]); const ts = blk.milliTimestamp ? Number(blk.milliTimestamp) : Number(blk.timestamp) * 1000;
const txs = blk.transactions; let i = txs.length - 1; while (i >= 0 && txs[i].to === '0x0000000000000000000000000000000000001000') i--;
let builder = 'none'; for (let j = i; j >= Math.max(0, i - 6); j--) { const q = txs[j]; if (BigInt(q.gasPrice) !== 0n) break; if (BigInt(q.value) === 0n && q.input === '0x') { builder = NAME[q.to.toLowerCase()] || q.to; break; } }
const tx = txs.find((t) => t.hash.toLowerCase() === hash); const f = seen.get(hash);
const out = { hash, status: r.status === '0x1' ? 'success' : 'reverted', block: Number(r.blockNumber), builder, gasGwei: tx ? Number(BigInt(tx.gasPrice)) / 1e9 : null, position: tx ? Number(tx.transactionIndex) : null,
  publicMempoolSawIt: f != null, publicBeforeBlock: f != null && f <= ts, msPublicBeforeBlock: f != null ? ts - f : null,
  verdict: f != null && f <= ts ? 'LEAK or FALLBACK: the public mempool saw it before its block (check the app timing: path = private means a leak by a private road)' : 'PRIVATE: not seen in the public mempool before its block' };
console.log(JSON.stringify(out, null, 1)); process.exit(0);
