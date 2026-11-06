// MEV v2 fake BNB network + a vault frame built from the REAL webEngine.ts declarations (shared by test/mev-v2.mjs and the bench).
// MEV_WEBENGINE=<path> runs the same code cut from another webEngine.ts (the review-ship "v1" control).
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { keccak256, parseTransaction, recoverTransactionAddress, parseGwei } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { declChunk } from '../scripts/trade-core.mjs';

export const SRC = process.env.MEV_WEBENGINE || new URL('../src/webEngine.ts', import.meta.url);
const WE = readFileSync(SRC, 'utf8').replace(/\r/g, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = ['THROTTLED', 'LOST', 'lastBroadcastNode', 'lastBroadcastPath', 'MEV_MIN_GAS', 'MEV_HEDGE_MS', 'MEV_FALLBACK_MS', 'MEV_HOLD_MS',
  'STATE_REFUSAL', 'mevPrivate', 'publicSendUrls', 'privHold', 'holdNonce', 'releaseHold', 'MEV_SHARED_HOLD_MS', 'holdBus', 'includedTx', 'postRaw', 'mevFallback', 'broadcast',
  'nonces', 'nonceReads', 'nextNonce', 'noteNonceUsed', 'lanes', 'inLane', 'signAndSend', 'landed', 'feeFor', 'broadcastUrls'];
const has = (n) => { try { declChunk(WE, n); return true; } catch { return false; } };
export const V1 = !has('mevFallback');   // the review-ship engine: private-only, no fallback
const NAMES = ALL.filter(has);
const CODE = ts.transpileModule(NAMES.map((n) => declChunk(WE, n)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

export const PUB = 'https://bsc-rpc.publicnode.com', BLOX = 'https://bsc.rpc.blxrbdn.com', C48 = 'https://rpc-bsc.48.club';
export const BR = 'https://bsc.blockrazor.xyz/fullprivacy', CAKE = 'https://bscrpc.pancakeswap.finance';
export const PRIVATE = [C48, BR, BLOX, CAKE];
const FLOOR = 50_000_000n;   // 0.05 gwei, what every road enforces (measured)

/** a simulated BNB chain + its roads. behaviour[url] = 'ok' | 'reject' | 'slow' | 'hang' | 'blackhole' */
export function network({ behaviour = {}, rtt = 55, lat = null, slowMs = 2000, blockMs = 450, builders = { [C48]: 0.55, [BR]: 0.45 }, balance = () => true } = {}) {
  const confirmed = new Map();          // address → next nonce on chain
  const mined = new Map();              // hash → { block, from, nonce }
  const pub = new Map();                // hash → tx (the public mempool)
  const priv = new Map();               // builder url → Map(hash → tx)   (bloXroute / PancakeSwap forward to both builders)
  for (const u of PRIVATE) priv.set(u, new Map());
  const log = []; let block = 0; let stop = false;
  const seenPublic = new Set();         // every hash the public mempool ever saw (= sandwich exposure)
  const decode = async (raw) => { const t = parseTransaction(raw); const from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(); return { raw, hash: keccak256(raw), from, nonce: t.nonce, gasPrice: t.gasPrice }; };
  const nextOf = (a) => confirmed.get(a) ?? 0;
  const pendingCount = (a) => { let n = nextOf(a); const pool = [...pub.values()].filter((t) => t.from === a); while (pool.some((t) => t.nonce === n)) n++; return n; };
  const geth = (pool, tx) => {
    if (mined.has(tx.hash)) return { error: 'already known' };
    if (tx.gasPrice < FLOOR) return { error: `transaction underpriced: gas tip cap ${tx.gasPrice}, minimum needed ${FLOOR}` };
    if (tx.nonce < nextOf(tx.from)) return { error: 'nonce too low' };
    if (!balance(tx)) return { error: 'insufficient funds for gas * price + value' };
    if (pool.has(tx.hash)) return { error: 'already known' };
    if ([...pool.values()].some((t) => t.from === tx.from && t.nonce === tx.nonce)) return { error: 'replacement transaction underpriced' };
    pool.set(tx.hash, tx); return { result: tx.hash };
  };
  const seal = () => {
    block++;
    const r = Math.random(); let acc = 0, by = Object.keys(builders)[0];
    for (const [u, p] of Object.entries(builders)) { acc += p; if (r <= acc) { by = u; break; } }
    const cands = [...pub.values(), ...priv.get(by).values(), ...priv.get(BLOX).values(), ...priv.get(CAKE).values()];
    for (let progress = true; progress;) {
      progress = false;
      for (const t of cands) if (!mined.has(t.hash) && t.nonce === nextOf(t.from) && t.gasPrice >= FLOOR) { mined.set(t.hash, { block, from: t.from, nonce: t.nonce, by, at: Date.now() }); confirmed.set(t.from, t.nonce + 1); progress = true; }
    }
    for (const pool of [pub, ...priv.values()]) for (const [h, t] of pool) if (mined.has(h) || t.nonce < nextOf(t.from)) pool.delete(h);
  };
  const ticker = (async () => { while (!stop) { await new Promise((r) => setTimeout(r, blockMs).unref()); if (!stop) seal(); } })();
  const answer = (j) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...j }), { headers: { 'content-type': 'application/json' } });
  const fetchFake = async (url, init) => {
    const body = JSON.parse(init.body); const u = String(url);
    const mode = PRIVATE.includes(u) ? (behaviour[u] || 'ok') : 'ok';
    const wait = (ms) => new Promise((res, rej) => { const t = setTimeout(res, ms); init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('The operation was aborted due to timeout')); }); });
    // lat[url] = [p50, p90] measured from a browser (lognormal draw); else rtt ±15 %
    const L = lat?.[u]; const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    await wait(L ? L[0] * Math.exp(z * Math.log(L[1] / L[0]) / 1.2816) : rtt * (0.85 + Math.random() * 0.3));
    if (body.method !== 'eth_sendRawTransaction') return answer({ error: { message: 'unsupported' } });
    const tx = await decode(body.params[0]);
    log.push({ at: Date.now(), u, from: tx.from, nonce: tx.nonce, hash: tx.hash, mode });
    if (u === PUB) { const r = geth(pub, tx); if (r.result || /already known/.test(r.error || '')) seenPublic.add(tx.hash); return answer(r.result ? { result: r.result } : { error: { message: r.error } }); }
    if (mode === 'reject') return answer({ error: { message: `transaction underpriced: gas tip cap ${tx.gasPrice}, minimum needed 1000000000` } });
    if (mode === 'hang') { await wait(60_000); }
    if (mode === 'slow') await wait(slowMs);
    const r = geth(mode === 'blackhole' ? new Map() : priv.get(u), tx);   // a blackhole answers like a pool, keeps nothing
    return answer(r.result ? { result: r.result } : { error: { message: r.error } });
  };
  return {
    fetch: fetchFake, log, seenPublic, mined, pub, priv, confirmed, pendingCount, stop: async () => { stop = true; void ticker; },
    receipt: (hash) => { const m = mined.get(hash.toLowerCase()); if (!m) throw new Error('Transaction receipt could not be found'); return { status: 'success', blockNumber: BigInt(m.block), gasUsed: 21000n, effectiveGasPrice: 1n }; },
    waitMined: async (hash, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (mined.has(hash.toLowerCase())) return mined.get(hash.toLowerCase()); await sleep(20); } return null; },
  };
}

/** one vault frame on the BNB lane wired to a network, with MEV protection on or off */
export function frame(net, { mev = true, floor = 62_500_000n, sendOnly = [] } = {}) {
  const S = {
    fetch: net.fetch, AbortSignal, performance, Promise, Math, Date, Number, String, BigInt, Error, Object, JSON, Map, Set,
    setTimeout: (fn, ms, ...x) => { const t = setTimeout(fn, ms, ...x); t.unref?.(); return t; }, clearTimeout,
    keccak256, SOL_MODE: false, NEAR_MODE: false, lc: (s) => String(s || '').toLowerCase(),
    CFG: { key: 'bsc', privateSend: PRIVATE, maxGasPrice: parseGwei('50'), maxFeeWei: 10n ** 18n / 2n, rpcSingle: BLOX },
    sendOnlyUrls: sendOnly, readUrls: () => [PUB, BLOX, C48], mevOn: () => mev,
    receiptClient: () => ({ getTransactionReceipt: async ({ hash }) => net.receipt(hash) }),
    publicClient: { getTransactionCount: async ({ address }) => { await sleep(20); return net.pendingCount(address.toLowerCase()); }, getTransaction: async ({ hash }) => { await sleep(20); if (net.pub.has(hash.toLowerCase()) || net.mined.has(hash.toLowerCase())) return {}; throw new Error('Transaction could not be found'); } },
    chain: { id: 56 }, feeFloor: async () => floor,   // default 0.05 gwei × 1.25 (the engine's floor today)
  };
  const mk = new Function('S', `with (S) { ${CODE}\n const o = { broadcast, nextNonce, signAndSend, landed, feeFor, nonces, broadcastUrls, ...(typeof mevFallback === 'function' ? { holdNonce, privHold, publicSendUrls, MEV_FALLBACK_MS, MEV_HEDGE_MS } : { privHold: new Map(), MEV_FALLBACK_MS: 700, MEV_HEDGE_MS: 250 }) }; return Object.defineProperty(o, 'path', { get: () => (typeof mevFallback === 'function' ? lastBroadcastPath : 'v1') }); }`);
  return mk(S);
}
export const wallet = () => { const account = privateKeyToAccount(generatePrivateKey()); return { account, client: {} }; };
export const send = (f, w, gasPrice = 93_750_000n) => f.signAndSend(w.client, w.account, { to: w.account.address, value: 0n, data: '0x' }, gasPrice, 21000n);

