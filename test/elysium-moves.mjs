// Release #6 — Elysium MOVES (send to an address, between wallets, collect, distribute, wrap / unwrap HYPE↔WHYPE).
// The vault's mover is the same EVM code on every EVM frame (MOVE_EVM: Robinhood, BNB and now the Elysium frame, chain 99901, gas
// HYPE, motion's relay as its one road). The delta is three declarations of src/webEngine.ts, outside the frozen trade core:
//   planMove      the mover's own words name the frame's coin (MOVE_UNIT: HYPE on Elysium, 'ETH' everywhere else, as before)
//   sendLeg       the relay's refusal BEFORE any node saw the bytes ("… nothing was sent") fails the leg cleanly (elyNothingSent)
//   provenDropped Elysium's two default nodes are ONE road: a drop needs two readings of it 20 s apart (elyProvenDropped)
// This file proves (1) that minus exactly those hunks the three declarations are byte-identical to e676b7d + stage 3, (2) that
// Robinhood / BNB plans are byte-identical at run time, (3) the Elysium behaviour, hostile and consent cases included.
// The REAL declarations are cut out of src/webEngine.ts (test/sec-cut.mjs) and run with stubs.
//   node --experimental-strip-types --test test/elysium-moves.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { formatEther, formatUnits, parseEther, keccak256 } from 'viem';
import { cut, source } from './sec-cut.mjs';
import { declChunk } from '../scripts/trade-core.mjs';
import * as ELY from '../src/elysiumCore.ts';

const SRC = source().replace(/\r/g, '');
const sha = (s) => createHash('sha256').update(s.replace(/\r/g, '')).digest('hex');

// ── (1) the delta, mechanically taken back out ──
// sha256 of each declaration in e676b7d + stage 3 (engine-stage3.patch: sha384-MJjs8wR8…, the base of this delta)
const BASE = {
  planMove: '07260869714598f2987e6e54d9746feca5d7e4750c4bf93e80702ca4f2da040e',
  sendLeg: '245d5f2adf44902fd44d0f4884c445349f3fda8749e54c19580ef978dcca1c8a',
  provenDropped: '3aea44e9a13e58fd52b6dfa54d9e0bc7e8a1b48bf32a5497a967adf635302c14',
};
// …and of the mover's other declarations, which this delta does not touch at all
const UNTOUCHED = {
  nodeSays: '6bd913508ed3d66713c779ebec8bb00147d687d456987ad9ac50352a6326df10', settleLeg: '3a76203b059bc1799bdeb130d5f4518db04ce53b47af5fd273fe29b0bab3629e',
  recoverLeg: '29e25f20d658203898e8b9fdecfb402ee07ee5531ad21a98448824f6846375ce', retryJob: 'a33013c83531a78d03c854c434589ba511aa41dffad2dd51db72ce76464c41e9',
  startMove: 'bbd4c920b5a891c74d7bc1607a9bd8100ce92b492fe25642ada2f877b9ae39a4', tickJob: 'cf4857af5046bcb48587cc7ebb0bb90a64e2e65f70945050bf4389a1eac7ba3c',
  confirmOutside: '41a1b6fde0a35e10d622bf71827f350b912e435e9b70f67c7ce7c28d59364415', sendEth: 'f16dba66aefa471bc579f222218b7b3e8d1ece4132a0bd30a468e5c94d892770',
  syncEthGas: '5407c9f0a65df055d5a4c85c13c5729cf41405c10a7cddff0b716ddd374bc25e', wrap: '44b032fda2dd9990321e50802764bb6457aef9a84d49da2e53eca41d095babd8',
  unwrap: '74a3b1bf3b8dfb7f35ffa92ba43470e9b0cfbb835ba1319f6088b062f3b27c07', outsideOk: '1c0eba648b4d87612fb86605eb78121a27ea67b798520beb8580249f856d4631',
  moveLaneCheck: '900e790a69fd7c8c5a37420e131daddf734ae9f86d24886e0f31011b972f49c9', MOVE_LANE: 'bae3ca5889bf64aa4f427ff4746bbd5f61607410f429be8ae318d4a294ad8410',
  moveLanePublic: 'e4f5e667d93aa7cda3372da35446a24e43e6d76441cec849438687c9012c76b1',
};
const UNDO = [
  ['errors.push(`Stealth routing moves ${MOVE_UNIT} only — a token would need every hop funded with gas first`);', "errors.push('Stealth routing moves ETH only — a token would need every hop funded with gas first');"],
  ["${asset.kind === 'eth' ? MOVE_UNIT : asset.symbol}, has", "${asset.kind === 'eth' ? 'ETH' : asset.symbol}, has"],
  ['toFixed(5)} ${MOVE_UNIT} for gas`;', 'toFixed(5)} ETH for gas`;'],
  ['throw new Error(`insufficient ${MOVE_UNIT}: has', 'throw new Error(`insufficient ETH: has'],
];
const UNDO_LINES = [/^ {8}\/\/ Elysium \(release #6\): the relay's own refusal before any node saw these bytes.*\n/m, /^ {8}if \(elyNothingSent\(e\)\) \{.*\n/m, /^ {2}if \(CFG\.key === 'elysium'\) return elyProvenDropped\(leg\);\n/m];
export function withoutMoves(s) {
  let out = s;
  for (const [a, b] of UNDO) { assert.equal(out.split(a).length - 1, 1, 'once: ' + a.slice(0, 50)); out = out.replace(a, b); }
  for (const re of UNDO_LINES) { assert.match(out, re); out = out.replace(re, ''); }
  // the new declarations (MOVE_UNIT, ELY_DROP_RECHECK_MS, elyProvenDropped, elyNothingSent) sit between the mover's, never inside one
  return out;
}
test('moves delta: planMove / sendLeg / provenDropped minus exactly the tagged Elysium hunks = e676b7d + stage 3, byte for byte', () => {
  const back = withoutMoves(SRC);
  for (const [n, h] of Object.entries(BASE)) assert.equal(sha(declChunk(back, n)), h, n);
  for (const [n, h] of Object.entries(BASE)) assert.notEqual(sha(declChunk(SRC, n)), h, n + ' did change');
});
test('moves delta: every other declaration of the mover is untouched (send, wrap, consent, recovery, runner)', () => {
  for (const [n, h] of Object.entries(UNTOUCHED)) assert.equal(sha(declChunk(SRC, n)), h, n);
});
test('moves delta: the Elysium branches fire only on the Elysium frame', () => {
  assert.match(SRC, /\nconst MOVE_UNIT = CFG\.key === 'elysium' \? NATIVE : 'ETH';\n/);
  assert.match(SRC, /\nconst elyNothingSent = \(e: unknown\): boolean => \{\n {2}if \(CFG\.key !== 'elysium'\) return false;/);
  assert.match(declChunk(SRC, 'provenDropped'), /\n {2}if \(CFG\.key === 'elysium'\) return elyProvenDropped\(leg\);\n/);
  assert.equal(declChunk(SRC, 'MOVE_EVM'), 'const MOVE_EVM = !SOL_MODE && !NEAR_MODE;', 'the mover runs on every EVM frame (Elysium included), never on Solana / NEAR');
});

// ── (2) plans: Robinhood / BNB byte-identical at run time; Elysium in HYPE ──
const W1 = '0x1111111111111111111111111111111111111111', W2 = '0x2222222222222222222222222222222222222222', W3 = '0x3333333333333333333333333333333333333333';
const OUT = '0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5', TOKEN = '0x4444444444444444444444444444444444444444';
const accounts = [{ id: 'w1', name: 'Wallet 1', address: W1, key: '0x' + '11'.repeat(32) }, { id: 'w2', name: 'Wallet 2', address: W2, key: '0x' + '22'.repeat(32) }, { id: 'w3', name: 'Wallet 3', address: W3, key: '0x' + '33'.repeat(32) }];
function planner(text, { key = 'robinhood', native = key === 'elysium' ? 'HYPE' : key === 'bsc' ? 'BNB' : 'ETH', balances = {}, ethGas = 21_000n } = {}) {
  let n = 0;
  const stubs = {
    CFG: { key }, NATIVE: native, moveLaneCheck: () => {}, requireUnlocked: () => accounts, syncEthGas: async () => ethGas, feeFor: async () => 125_000_000n,
    publicClient: { getBalance: async ({ address }) => balances[address] ?? 10n ** 17n, readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 5_000_000n : functionName === 'decimals' ? 6 : 'USDC') },
    tokenDecimals: async () => 6, tokenSymbolOf: async () => 'USDC', formatEther, formatUnits, structuredClone, plans: new Map(), jid: (p) => p + String(++n).padStart(4, '0'),
    MOVE_LANE: key, moveLanePublic: (k) => (k === 'bsc' ? 'bnb' : k), ERC20_ABI: [], ETH_GAS: ethGas, ERC20_GAS: 80_000n, MAX_HOPS: 4, lc: (a) => String(a || '').toLowerCase(),
  };
  return cut(['MOVE_UNIT', 'gasCostWei', 'humanOf', 'weiOf', 'planMove'], stubs, text).planMove;
}
const SPECS = [
  { fromIds: ['w1'], toIds: ['w2'], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 0.01, per: 'source' } },
  { fromIds: ['w1'], toIds: ['w2', 'w3'], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 0.004, per: 'dest' } },
  { fromIds: ['w2', 'w3'], toIds: ['w1'], asset: { kind: 'eth' }, amount: { mode: 'pct', value: 100, per: 'source' } },
  { fromIds: ['w1'], toAddresses: [OUT], asset: { kind: 'eth' }, amount: { mode: 'pct', value: 50, per: 'source' } },
  { fromIds: ['w1'], toAddresses: [OUT], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 5, per: 'source' } },            // more than it holds
  { fromIds: ['w1'], toIds: ['w2'], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 0.01, per: 'source' }, hops: 2, delay: [1, 2] },
  { fromIds: ['w1'], toIds: ['w2'], asset: { kind: 'erc20', address: TOKEN }, amount: { mode: 'pct', value: 100, per: 'source' }, hops: 1 },   // tokens never hop
  { fromIds: ['w1'], toIds: ['w2'], asset: { kind: 'erc20', address: TOKEN }, amount: { mode: 'fixed', value: 1, per: 'source' } },
  { fromIds: ['w1'], toIds: ['w1'], asset: { kind: 'eth' }, amount: { mode: 'fixed', value: 0.01, per: 'source' } },             // both sides
  { fromIds: [], toIds: [], asset: { kind: 'eth' }, amount: { mode: 'pct', value: 0, per: 'source' } },                           // the app's probe
];
const stripId = (p) => ({ ...p, planId: 'p' });
test('plans: Robinhood and BNB plans are byte-identical to the base engine (every shape: fixed, pct, many → one, one → many, outside, short, hops, tokens, errors)', async () => {
  const base = withoutMoves(SRC);
  for (const key of ['robinhood', 'bsc']) {
    for (const balances of [{}, { [W1]: 10n ** 14n }, { [W1]: 0n }]) {
      for (const spec of SPECS) {
        const a = JSON.stringify(await planner(SRC, { key, balances })(structuredClone(spec)));
        const b = JSON.stringify(await planner(base, { key, balances })(structuredClone(spec)));
        assert.equal(a, b, `${key} ${JSON.stringify(spec).slice(0, 80)}`);
      }
    }
  }
});
test('plans: on the Elysium frame the plan is chain "elysium" and every word of it says HYPE (never ETH)', async () => {
  const plan = planner(SRC, { key: 'elysium', balances: { [W1]: 10n ** 14n }, ethGas: 30_206n });
  const ok = await plan(structuredClone(SPECS[0]));
  assert.equal(ok.chain, 'elysium'); assert.equal(ok.kind, 'Transfer'); assert.equal(ok.errors.length, 1);
  assert.match(ok.sources[0].error, /^needs 0\.01000 HYPE, has 0\.00010$/);
  const tok = await plan(structuredClone(SPECS[6]));
  assert.match(tok.errors.join(' | '), /Stealth routing moves HYPE only/);
  const gasShort = await planner(SRC, { key: 'elysium', balances: { [W1]: 0n } })(structuredClone(SPECS[7]));
  assert.match(gasShort.sources[0].error, /HYPE for gas$/);
  for (const spec of SPECS) assert.doesNotMatch(JSON.stringify(await plan(structuredClone(spec))), /\bETH\b/, JSON.stringify(spec).slice(0, 60));
  // the Orbit L1 part rides in the plan's fee: a plain HYPE send measured 21,576 gas on 99901 → 30,206 with the 40 % headroom
  const fee = await planner(SRC, { key: 'elysium', ethGas: 30_206n })(structuredClone(SPECS[0]));
  assert.equal(fee.ok, true); assert.equal(fee.gasEth, Number(formatEther(125_000_000n * 30_206n)));
});
test('plans: the Orbit L1 component is estimated, not assumed — syncEthGas keeps 40 % headroom above 21,000 (as on Robinhood)', async () => {
  const run = (g) => cut(['syncEthGas'], { ETH_GAS: 21_000n, ethGasAt: 0, publicClient: { estimateGas: async () => g } }).syncEthGas('0x' + '1'.repeat(40));
  assert.equal(await run(21_576n), 30_206n);
  assert.equal(await run(21_000n), 21_000n);
});

// ── (3) a drop on Elysium: two readings of the one road, 20 s apart ──
function dropper(key, votes) {
  const asked = [], waits = [];
  const f = cut(['isRpcUrl', 'ELY_DROP_RECHECK_MS', 'elyProvenDropped', 'provenDropped'], {
    CFG: { key }, DEFAULT_RPCS: key === 'elysium' ? ['https://motion.gift/elysium/api/rpc', 'https://motion.gift/elysium/api/rpc'] : ['https://a.example/rpc', 'https://b.example/rpc'],
    nodeSays: async (url) => { asked.push(url); return votes.shift() ?? { higher: null, notFound: null }; },
    setTimeout: (fn, ms) => { waits.push(ms); fn(); },
  });
  return { f, asked, waits };
}
const leg = { from: W1, hash: '0x' + 'ab'.repeat(32), nonce: 3 };
const GONE = { higher: true, notFound: true };
test('drop proof (Elysium): one relay answer is never counted twice — two readings ≥ 20 s apart must BOTH prove it', async () => {
  let d = dropper('elysium', [GONE, GONE]);
  assert.equal(await d.f.provenDropped(leg), true); assert.equal(d.asked.length, 2); assert.deepEqual(d.waits, [20_000]);
  d = dropper('elysium', [GONE, { higher: true, notFound: false }]);   // the second reading finds it (a node had lagged): not dropped
  assert.equal(await d.f.provenDropped(leg), false);
  d = dropper('elysium', [GONE, { higher: true, notFound: null }]);    // the second lookup failed: not a proof
  assert.equal(await d.f.provenDropped(leg), false);
  d = dropper('elysium', [{ higher: false, notFound: true }]);           // still in the delayed inbox: the nonce has not passed
  assert.equal(await d.f.provenDropped(leg), false); assert.equal(d.asked.length, 1, 'no second reading without a first proof'); assert.deepEqual(d.waits, []);
  assert.equal(await dropper('elysium', []).f.provenDropped({ ...leg, nonce: undefined }), false);
});
test('drop proof (Robinhood / BNB): unchanged — the two default nodes at once, both certain', async () => {
  let d = dropper('robinhood', [GONE, GONE]);
  assert.equal(await d.f.provenDropped(leg), true); assert.deepEqual(d.asked, ['https://a.example/rpc', 'https://b.example/rpc']); assert.deepEqual(d.waits, []);
  d = dropper('bsc', [GONE, { higher: true, notFound: null }]);
  assert.equal(await d.f.provenDropped(leg), false);
});

// ── (4) the relay's "nothing was sent" — a clean, retryable failure only where it is conclusive ──
const RELAY = 'https://motion.gift/elysium/api/rpc';
const nothingSent = (key, roads = [RELAY]) => cut(['elyNothingSent'], { CFG: { key }, RPC: key === 'elysium' ? RELAY : 'https://robinhood-rpc.publicnode.com', broadcastUrls: () => roads }).elyNothingSent;
const refusal = (msg, txState = 'signed') => Object.assign(new Error(msg), { txState, hash: '0x' + 'cd'.repeat(32) });
const RELAY_TEXTS = ['Elysium trading is paused on motion right now — nothing was sent', 'Elysium buys are paused on motion right now (sells still work) — nothing was sent',
  'Elysium buys on motion are in preview — this wallet is not in a preview session (sells still work); nothing was sent',
  'only one Elysium node answers for this wallet right now — buys need two to agree (sells still work); nothing was sent', 'insufficient funds for gas * price + value — nothing was sent'];
test('nothing sent: every pre-broadcast refusal of the relay, on the Elysium frame with the relay as the only road, is conclusive', () => {
  const f = nothingSent('elysium');
  for (const t of RELAY_TEXTS) assert.equal(f(refusal(t)), true, t);
});
test('nothing sent (hostile / doubtful): an unknown outcome, another road, another frame, a node refusal → never "nothing was sent"', () => {
  assert.equal(nothingSent('elysium')(refusal(RELAY_TEXTS[0], 'unknown')), false, 'an answer lost in flight may hold it');
  assert.equal(nothingSent('elysium')(refusal('nonce too low')), false);
  assert.equal(nothingSent('elysium')(refusal('rate limited')), false);
  assert.equal(nothingSent('elysium', [RELAY, 'https://my-own-node.example/rpc'])(refusal(RELAY_TEXTS[0])), false, 'a node of the user\'s own may have taken it');
  assert.equal(nothingSent('robinhood', ['https://robinhood-rpc.publicnode.com'])(refusal(RELAY_TEXTS[0])), false, 'Robinhood / BNB: unchanged');
  assert.equal(nothingSent('elysium')(null), false);
});

// sendLeg, the real one, through write-ahead signing
function legRunner({ key = 'elysium', fail = null, roads = [RELAY] } = {}) {
  const events = [], nonces = new Map([[W1.toLowerCase(), { n: 5, at: Date.now() }]]), running = new Set();
  const job = { id: 'j1', legs: [], delay: [0, 0] };
  const lg = { id: 'l1', from: W1, to: W2, amount: String(10n ** 16n), asset: { kind: 'eth' }, status: 'queued' };
  job.legs.push(lg); running.add(lg.id);
  const account = { address: W1, signTransaction: async (tx) => { events.push(['sign', tx.nonce, tx.value, tx.gas]); return '0x' + 'f8'.repeat(40); } };
  const stubs = {
    CFG: { key }, RPC: key === 'elysium' ? RELAY : 'https://robinhood-rpc.publicnode.com', broadcastUrls: () => roads, laneLock: (_a, fn) => fn(), mayDrive: () => true,
    unlocked: [{ address: W1 }], HOST: true, confirmedJobs: new Set(['j1']), isOwn: () => true, accountOf: () => account, feeFor: async () => 125_000_000n,
    holdNonce: (_a, n) => n, publicClient: { getTransactionCount: async () => 5, getBalance: async () => 10n ** 18n }, syncEthGas: async () => 30_206n, ETH_GAS: 30_206n,
    formatEther, keccak256, chain: { id: 99901 }, MOVE_UNIT: key === 'elysium' ? 'HYPE' : 'ETH', bumpRev: (l) => { l.rev = (l.rev || 0) + 1; }, saveJobs: () => events.push(['save', lg.status]),
    noteNonceUsed: (_a, n) => { nonces.set(W1.toLowerCase(), { n: n + 1, at: Date.now() }); events.push(['nonceUsed', n]); },
    broadcast: async () => { events.push(['broadcast']); if (fail) throw fail; return '0x' + 'aa'.repeat(32); }, settleLeg: async () => events.push(['settle', lg.status]),
    running, nonces, lc: (a) => String(a).toLowerCase(), scheduleWatch: () => events.push(['watch']), tickJob: () => events.push(['tick']),
    shortError: (e) => String(e?.message || e), humanOf: (w) => Number(formatEther(w)), ERC20_ABI: [],
  };
  const f = cut(['elyNothingSent', 'sendLeg'], stubs);
  return { run: () => f.sendLeg(job, lg), lg, events, nonces, running };
}
test('sendLeg (Elysium): the relay refused before any node saw it → failed, the signed bytes dropped, the nonce re-read — retry may sign again', async () => {
  const r = legRunner({ fail: refusal(RELAY_TEXTS[2]) });
  await r.run();
  assert.equal(r.lg.status, 'failed'); assert.match(r.lg.error, /preview/);
  assert.equal(r.lg.raw, undefined); assert.equal(r.lg.hash, undefined); assert.equal(r.lg.nonce, undefined);
  assert.equal(r.nonces.has(W1.toLowerCase()), false, 'the counter that stepped past this nonce is dropped: the next send reads the chain');
  assert.equal(r.running.has('l1'), false);
  assert.ok(!r.events.some((e) => e[0] === 'settle'), 'nothing to follow on chain');
  assert.deepEqual(r.events.filter((e) => e[0] === 'save').map((e) => e[1]), ['signed', 'failed'], 'written ahead (signed) before the broadcast, as always');
  // the existing retry rule now re-queues it (a failure without bytes); the cut is the real retryJob
  const job = { id: 'j1', status: 'failed', legs: [r.lg] };
  const rj = cut(['retryJob'], { jobs: [job], isRunner: true, saveJobs: () => {}, tickJob: () => {}, bumpRev: () => {}, ensureRunner: async () => true, askRunner: async () => ({}) });
  rj.retryJob('j1'); assert.equal(r.lg.status, 'queued');
});
test('sendLeg (Elysium, hostile / doubtful): lost answers, node refusals and a second road stay "unknown" (settled by hash, never re-signed)', async () => {
  for (const [fail, roads] of [[refusal(RELAY_TEXTS[0], 'unknown'), [RELAY]], [refusal('nonce too low'), [RELAY]], [refusal(RELAY_TEXTS[4]), [RELAY, 'https://mine.example/rpc']]]) {
    const r = legRunner({ fail, roads });
    await r.run();
    assert.equal(r.lg.status, 'unknown', fail.message); assert.ok(r.lg.raw && r.lg.hash, 'the bytes stay for recovery');
    assert.ok(r.events.some((e) => e[0] === 'settle'));
  }
});
test('sendLeg (Robinhood): byte-for-byte as before — any broadcast error after write-ahead is "unknown"', async () => {
  const r = legRunner({ key: 'robinhood', fail: refusal(RELAY_TEXTS[0]), roads: ['https://robinhood-rpc.publicnode.com'] });
  await r.run();
  assert.equal(r.lg.status, 'unknown'); assert.ok(r.lg.raw);
  const ok = legRunner({ key: 'robinhood' }); await ok.run();
  assert.equal(ok.lg.status, 'sent'); assert.deepEqual(ok.events.find((e) => e[0] === 'sign'), ['sign', 5, 10n ** 16n, 30_206n]);
});
test('sendLeg (Elysium): a good send signs at the relay\'s nonce with the estimated HYPE gas and is followed to its receipt', async () => {
  const r = legRunner(); await r.run();
  assert.equal(r.lg.status, 'sent'); assert.deepEqual(r.events.find((e) => e[0] === 'sign'), ['sign', 5, 10n ** 16n, 30_206n]);
  assert.deepEqual(r.events.filter((e) => e[0] === 'nonceUsed'), [['nonceUsed', 5]]);
});

// ── (5) consent: the same doors as every chain — gate, then the vault's own dialog with the typed code (SEC-5: funds) ──
function consent({ outside = true } = {}) {
  const asks = [], gates = [], sent = [];
  const own = [accounts[0], accounts[1], { id: 'pg', name: 'Planted', address: W3, key: '0x' + '33'.repeat(32), via: 'page' }];
  const stubs = {
    requireUnlocked: () => own, SOL_MODE: false, NEAR_MODE: false, NATIVE: 'HYPE', SOL_ADDR: /^$/, NEAR_ACCT: /^$/,
    isOwn: (a) => outside ? [W1, W2].includes(String(a).toLowerCase()) : true, gate: async (g) => gates.push(g), unbackedOk: async () => {},
    ask: async (o) => { asks.push(o); return true; }, sendEth: async (from, to, amt) => { sent.push([from, to, amt]); return '0x' + 'ee'.repeat(32); },
    once: (_o, _w, run) => run(() => {}), parseEther, publicClient: { readContract: async () => 'WHYPE' }, MAX_HOPS: 4, humanOf: (w) => Number(formatEther(w)), lc: (a) => String(a).toLowerCase(),
    escHtml: (v) => String(v), groupsOf: (a) => a, verifiedLogin: () => null, shortError: (e) => String(e?.message || e),
  };
  return { f: cut(['laneUnit', 'laneAddr', 'laneDest', 'copyBtn', 'destBox', 'sub', 'muted', 'outsideOk', 'confirmOutside', 'engine.transfer', 'engine.distribute', 'engine.consolidate'], { ...stubs, solAddressOf: () => '', nearAccountId: () => '' }), asks, gates, sent };
}
test('consent (Elysium): Send to an outside address = the "withdraw" gate, then "Send outside your vault" in HYPE with the typed code', async () => {
  const c = consent();
  await c.f.transfer('w1', OUT, 0.5);
  assert.deepEqual(c.gates, ['withdraw']); assert.equal(c.asks.length, 1);
  assert.equal(c.asks[0].title, 'Send outside your vault'); assert.equal(c.asks[0].funds, true, 'SEC-5: the frame-drawn number is typed');
  assert.equal(c.asks[0].danger, true); assert.equal(c.asks[0].ok, 'Send 0.5 HYPE'); assert.match(c.asks[0].html, new RegExp(OUT));
  assert.equal(c.sent.length, 1);
});
test('consent (Elysium): between own wallets = the "transfer" gate, no dialog; a wallet the PAGE imported is outside (V12 F-34)', async () => {
  const c = consent();
  await c.f.transfer('w1', W2, 0.1);
  assert.deepEqual(c.gates, ['transfer']); assert.equal(c.asks.length, 0);
  await c.f.distribute('w1', ['w2', 'pg'], 0.01);
  assert.deepEqual(c.gates, ['transfer', 'withdraw']); assert.equal(c.asks.length, 1); assert.equal(c.asks[0].funds, true); assert.match(c.asks[0].html, /0\.01 HYPE/);
  await c.f.consolidate(['w1', 'w2'], 'pg');
  assert.equal(c.asks.length, 2); assert.equal(c.asks[1].funds, true); assert.match(c.asks[1].html, /Sweep/);
});
test('consent (Elysium): a planned move with outside legs — the total in HYPE, every address shown, typed code; cancel = nothing starts', async () => {
  const c = consent();
  const plan = { legs: [{ id: 'a', to: OUT, amount: String(parseEther('0.25')) }, { id: 'b', to: W2, amount: String(parseEther('1')) }], asset: { kind: 'eth' }, hops: 0 };
  await c.f.confirmOutside(plan);
  assert.deepEqual(c.gates, ['withdraw']); assert.equal(c.asks[0].funds, true); assert.equal(c.asks[0].ok, 'Send HYPE'); assert.match(c.asks[0].html, /0\.25 HYPE in total/);
  const refuse = cut(['copyBtn', 'destBox', 'sub', 'muted', 'confirmOutside'], { requireUnlocked: () => accounts, isOwn: () => false, gate: async () => {}, unbackedOk: async () => {}, ask: async () => false, NATIVE: 'HYPE', publicClient: {}, MAX_HOPS: 4, humanOf: (w) => Number(formatEther(w)), lc: (a) => String(a).toLowerCase(), escHtml: String, groupsOf: (a) => a });
  await assert.rejects(refuse.confirmOutside(plan), /Cancelled/);
});
test('consent: every money-out dialog of the mover carries funds: true (SEC-5) — the same on every EVM frame, Elysium included', () => {
  for (const n of ['outsideOk', 'confirmOutside']) assert.match(declChunk(SRC, n), /title: 'Send outside your vault', danger: true, funds: true/, n);
  const eng = SRC.slice(SRC.indexOf('  transfer: async (fromId: string, to: string'), SRC.indexOf('  wrap: async (id: string, amountEth: number)'));
  assert.equal(eng.split("title: 'Send outside your vault', danger: true, funds: true").length - 1, 2, 'transfer + transferToken');
  assert.doesNotMatch(eng, /elysium/i, 'no Elysium exception in the doors');
});

// ── (6) wrap / unwrap: WHYPE on the Elysium frame, through the same simulate → sign path ──
test('wrap (Elysium): the frame\'s wrapped coin is WHYPE (deposit / withdraw, the chain\'s 18-decimal WETH9-style token)', async () => {
  assert.match(SRC, /\n {2}elysium: \{\n[^}]*wrapped: ELY\.ELY_WHYPE,/);
  assert.equal(ELY.ELY_WHYPE, '0xba876237b0f021a6c6d852d6c26e107997cc5e81');
  const calls = [];
  const f = cut(['wrap', 'unwrap'], { WETH: ELY.ELY_WHYPE, WETH_ABI: [], walletFor: () => ({ account: { address: W1 }, client: {} }), feeFor: async () => 125_000_000n,
    publicClient: { simulateContract: async (o) => { calls.push(o); return { request: o }; } }, sendCall: async (_c, _a, req) => { calls.push(['send', req.functionName]); return '0x' + '12'.repeat(32); } });
  await f.wrap('w1', parseEther('0.01'));
  await f.unwrap('w1', parseEther('0.01'));
  assert.equal(calls[0].address, ELY.ELY_WHYPE); assert.equal(calls[0].functionName, 'deposit'); assert.equal(calls[0].value, parseEther('0.01'));
  assert.equal(calls[2].functionName, 'withdraw'); assert.deepEqual(calls[2].args, [parseEther('0.01')]);
  assert.deepEqual(calls.filter((x) => Array.isArray(x)), [['send', 'deposit'], ['send', 'withdraw']]);
});
