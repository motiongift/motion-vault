// MEV v2 — THE OWNER'S REAL-SEND CHECK (BNB). Not a unit test: it spends real gas (~$0.0014 per send at 0.094 gwei).
// It runs the REAL v2 send path (signAndSend → broadcast → mevFallback → nonce hold, cut from src/webEngine.ts as the tests do)
// against the REAL roads, with the owner's own small wallet, and answers the go / no-go questions with numbers:
//   did the private road take it, did it land without the public fallback, in how many blocks, built by whom, and did the
//   public mempool (publicnode's pending feed, watched in parallel) ever see it before it landed.
// Each send is a 0-BNB transfer to the wallet itself at the engine's Fast price (nothing moves but the gas).
//
//   1. Fund a NEW wallet with ~$1 of BNB (never the main wallet). Put its private key in an env var, never on the command line:
//        PowerShell 7:  $env:MEV_KEY = Read-Host 'key' -MaskInput     (typed at the prompt: never in the PSReadLine history file)
//        bash:          read -s MEV_KEY; export MEV_KEY
//      and afterwards:  Remove-Item Env:MEV_KEY   /   unset MEV_KEY
//      (review: `$env:MEV_KEY = '0x…'` typed as a command IS saved in ConsoleHost_history.txt — do not)
//   2. node scripts/mev-v2-real-send.mjs --send          → 11 sends: 5 all roads, 3 48 Club only, 3 BlockRazor only
//      node scripts/mev-v2-real-send.mjs                 → (default, review) DRY: no key needed: a 0-BNB throwaway key; every road must refuse it
//                                                       ("insufficient funds"), proving the plumbing without spending
//   3. Read the verdict at the end (and mev-v2-real-send-<time>.json).
// After this passes, the $1 buy in the app (report.txt step B: scripts/mev-v2-watch.mjs) checks the same on a real swap.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { createPublicClient, http, keccak256, parseGwei, defineChain } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { declChunk } from './trade-core.mjs';

// review: dry unless --send is given (a key left in the environment never spends by accident); the key is read once and the
// variable dropped from this process; it is never printed or written (only the address is)
const DRY = !process.argv.includes('--send');
const KEY = DRY ? generatePrivateKey() : process.env.MEV_KEY; delete process.env.MEV_KEY;
const MAX_GAS = 200_000_000n;   // review: 0.2 gwei — above it nothing is signed (11 sends × 21,000 gas ≤ 0.0000462 BNB ≈ $0.03)
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY || '')) { console.error('set MEV_KEY (0x + 64 hex) in the environment for --send'); process.exit(2); }
const PLAN = DRY ? [['all', 1]] : [['all', 5], ['48club', 3], ['blockrazor', 3]];

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const NAMES = ['THROTTLED', 'LOST', 'lastBroadcastNode', 'lastBroadcastPath', 'MEV_MIN_GAS', 'MEV_HEDGE_MS', 'MEV_FALLBACK_MS', 'MEV_HOLD_MS',
  'STATE_REFUSAL', 'mevPrivate', 'publicSendUrls', 'privHold', 'holdNonce', 'releaseHold', 'MEV_SHARED_HOLD_MS', 'holdBus', 'includedTx', 'postRaw', 'mevFallback', 'broadcast',
  'nonces', 'nonceReads', 'nextNonce', 'noteNonceUsed', 'lanes', 'inLane', 'signAndSend', 'landed', 'feeFloor', 'feeFor', 'broadcastUrls'];
const CODE = ts.transpileModule(['let feeCache = null;', 'let feeInflight = null;', ...NAMES.map((n) => declChunk(WE, n))].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const PRIV_ALL = (/privateSend: (\[[^\]]+\])/.exec(declChunk(WE, 'CHAIN_CFGS').split('bsc: {')[1]) || [])[1];
const PRIVATE = JSON.parse(PRIV_ALL.replace(/'/g, '"'));
const PUB = 'https://bsc-rpc.publicnode.com', BLOX = 'https://bsc.rpc.blxrbdn.com', C48 = 'https://rpc-bsc.48.club';
const bsc = defineChain({ id: 56, name: 'BNB Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [PUB] } } });
const publicClient = createPublicClient({ chain: bsc, transport: http(PUB, { timeout: 6000 }) });
const receiptCl = createPublicClient({ chain: bsc, transport: http(BLOX, { timeout: 6000 }) });
const NAME = { '0x487e5dfe70119c1b320b8219b190a6fa95a5bb48': '48club', '0x48a5ed9abc1a8fbe86cec4900483f43a7f2dbb48': '48club', '0x5532cdb3c0c4278f9848fc4560b495b70ba67455': 'blockrazor', '0x539e24781f616f0d912b60813ab75b7b80b75c53': 'blockrazor', '0xba4233f6e478db76698b0a5000972af0196b7be1': 'blockrazor', '0x50061047b9c7150f0dc105f79588d1b07d2be250': 'blockrazor', '0x2873fc7ad9122933becb384f5856f0e87918388d': 'bloxroute', '0x2b217a4158933aade6d6494e3791d454b4d13ae7': 'bloxroute' };
const builderOf = (blk) => { const txs = blk.transactions; let i = txs.length - 1; while (i >= 0 && txs[i].to === '0x0000000000000000000000000000000000001000') i--; for (let j = i; j >= Math.max(0, i - 6); j--) { const q = txs[j]; if (BigInt(q.gasPrice) !== 0n) break; if (BigInt(q.value) === 0n && q.input === '0x') return NAME[q.to.toLowerCase()] || q.to.slice(0, 10); } return 'none'; };

// the public mempool, watched for the whole run: hash → first seen (local ms)
const seen = new Map(); const ws = new WebSocket('wss://bsc-rpc.publicnode.com');
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions'] }));
ws.onmessage = (m) => { try { const h = JSON.parse(m.data)?.params?.result; if (typeof h === 'string' && !seen.has(h.toLowerCase())) seen.set(h.toLowerCase(), Date.now()); } catch {} };
const posts = [];   // every eth_sendRawTransaction the engine code makes: road, time, answer
const realFetch = globalThis.fetch;
const loggedFetch = async (u, init) => { const t = Date.now(); const r = await realFetch(u, init); const txt = await r.clone().text().catch(() => ''); posts.push({ u: String(u), at: t, ms: Date.now() - t, answer: txt.slice(0, 160) }); return r; };

function frameFor(privateSend) {
  const S = { fetch: loggedFetch, AbortSignal, performance, setTimeout, clearTimeout, keccak256, SOL_MODE: false, NEAR_MODE: false, lc: (s) => String(s || '').toLowerCase(),
    CFG: { key: 'bsc', privateSend, maxGasPrice: parseGwei('50'), maxFeeWei: 10n ** 17n, rpcSingle: BLOX }, sendOnlyUrls: [], readUrls: () => [PUB, BLOX, C48], mevOn: () => true,
    receiptClient: () => receiptCl, publicClient, chain: bsc };
  return new Function('S', `with (S) { ${CODE}\n return { signAndSend, landed, feeFor, path: () => lastBroadcastPath, node: () => lastBroadcastNode }; }`)(S);
}
const account = privateKeyToAccount(KEY);
const bal = await publicClient.getBalance({ address: account.address });
console.log(`wallet ${account.address}  balance ${Number(bal) / 1e18} BNB${DRY ? '  (dry: throwaway key, 0 BNB)' : ''}`);
if (!DRY && bal < 40_000_000_000_000n) { console.error('fund the wallet with at least 0.00004 BNB (~$0.03); ~$1 is plenty'); process.exit(2); }
const nonceStart = DRY ? null : await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });   // review: to prove nothing stuck
await new Promise((r) => setTimeout(r, 3000));   // the mempool watch runs first
const rows = [];
for (const [only, n] of PLAN) {
  const roads = only === 'all' ? PRIVATE : PRIVATE.filter((u) => (only === '48club' ? /48\.club/ : /blockrazor/).test(u));
  const f = frameFor(roads);
  for (let i = 0; i < n; i++) {
    // warm every road like the vault's keepHot does while a trader is on a page (TLS open: a click never pays a handshake)
    await Promise.all([...PRIVATE, PUB].map((u) => realFetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.text()).catch(() => {})));
    await f.feeFor(1.5); if (i === 0) await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const gasPrice = await f.feeFor(1.5);   // the engine's Fast price, protection on (never under MEV_MIN_GAS)
    if (gasPrice > MAX_GAS) { console.error(`gas ${Number(gasPrice) / 1e9} gwei is above the 0.2 gwei cap of this test — stopped, nothing signed`); process.exit(2); }
    // review: inclusion counted in BLOCKS after the last block visible at the send (clock-free: the local clock is never compared
    // with the chain's timestamps)
    const head = await receiptCl.getBlockNumber().catch(() => null);
    const p0 = posts.length; const t0 = Date.now(); const c0 = performance.now();
    let hash, error;
    try { hash = await f.signAndSend({}, account, { to: account.address, value: 0n, data: '0x' }, gasPrice, 21000n); } catch (e) { error = String(e?.message || e).slice(0, 160); hash = e?.hash; }
    const sendMs = Math.round(performance.now() - c0); const path = f.path();
    let r = null; if (hash && !error) r = await f.landed(hash, 30_000).catch(() => null);
    await new Promise((res) => setTimeout(res, 1200));   // let a fallback (700 ms) show in the post log
    const mine = posts.slice(p0);
    const fallback = mine.some((p) => p.u === PUB && p.at - t0 >= 600);
    let blockInfo = {};
    if (r) { const blk = await publicClient.request({ method: 'eth_getBlockByNumber', params: ['0x' + r.blockNumber.toString(16), true] }); const ts = blk.milliTimestamp ? Number(blk.milliTimestamp) : Number(blk.timestamp) * 1000; blockInfo = { block: Number(r.blockNumber), builder: builderOf(blk), msToBlock: ts - t0, status: r.status }; }
    const pubSeen = hash ? seen.get(hash.toLowerCase()) : undefined;
    const row = { roads: only, i, hash, error, gasGwei: Number(gasPrice) / 1e9, sendMs, path, node: f.node(), fallback, ...blockInfo,
      blocks: r && head != null ? Number(r.blockNumber - head) : null,   // 1 = the next block after the last visible one (2 when one was sealed but not yet visible)
      // review: a tx that went only to the private roads and that the public pending feed EVER showed was leaked (a sealed tx is
      // never announced as pending) — clock-free, no comparison of local and chain time
      publicBeforeBlock: pubSeen != null,
      posts: mine.map((p) => `${p.u.replace('https://', '')} +${p.at - t0}ms ${p.ms}ms ${p.answer.replace(/\s+/g, ' ').slice(0, 70)}`) };
    rows.push(row); console.log(JSON.stringify(row));
    await new Promise((res) => setTimeout(res, 1500));
  }
}
ws.close();
// ── go / no-go ──
const sent = rows.filter((x) => !x.error), landedRows = sent.filter((x) => x.status === 'success');
const privNoFb = landedRows.filter((x) => x.path === 'private' && !x.fallback);
const blocks = landedRows.map((x) => x.blocks).sort((a, b) => a - b);
const leaks = landedRows.filter((x) => x.path === 'private' && !x.fallback && x.publicBeforeBlock);
const nonceEnd = DRY ? null : await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
const noncePending = DRY ? null : await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
const v = {
  sends: rows.length, landed: landedRows.length, privateWithoutFallback: privNoFb.length, fallbacks: sent.filter((x) => x.fallback).length,
  blocksP50: blocks.length ? blocks[Math.floor(blocks.length / 2)] : null, blocksMax: blocks.length ? blocks[blocks.length - 1] : null,
  leaksBeforeBlock: leaks.length, sendMsP50: sent.length ? sent.map((x) => x.sendMs).sort((a, b) => a - b)[Math.floor(sent.length / 2)] : null,
  perRoad: Object.fromEntries(PLAN.map(([k]) => [k, { landedPrivate: privNoFb.filter((x) => x.roads === k).length, of: rows.filter((x) => x.roads === k).length, builders: [...new Set(landedRows.filter((x) => x.roads === k).map((x) => x.builder))] }])),
  nonceStart, nonceAfter: nonceEnd, noncePending, nonceAdvancedBy: DRY ? null : nonceEnd - nonceStart,
};
const go = !DRY && v.landed === v.sends && v.privateWithoutFallback >= v.sends - 1 && v.blocksP50 <= 1 && v.blocksMax <= 4 && v.leaksBeforeBlock === 0 && v.sendMsP50 <= 120 && v.nonceAdvancedBy === v.sends && v.noncePending === v.nonceAfter;
v.verdict = DRY ? (rows.every((x) => /insufficient funds/.test(x.error || '')) ? 'DRY OK: every road answered the 0-BNB tx with "insufficient funds" (price accepted, plumbing works)' : 'DRY: unexpected answer — read the posts') : go ? 'GO' : 'NO-GO';
console.log('\n' + JSON.stringify(v, null, 1));
writeFileSync(new URL(`../mev-v2-real-send-${Date.now()}.json`, import.meta.url), JSON.stringify({ at: new Date().toISOString(), wallet: account.address, rows, verdict: v }, null, 1));
process.exit(0);
