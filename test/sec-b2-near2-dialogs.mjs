// SECURITY BATCH 2 (2026-11-04) — NEAR-2: on the NEAR frame there is no CHAIN_CFGS.near, so NATIVE is the EVM config's 'ETH':
// "Send outside your vault" for a NEAR transfer said "Send 5 ETH" while NEAR left. distribute / consolidate checked, showed and
// sent to the target wallet's EVM 0x address: the vault's OWN wallets came up as "Send outside your vault" (withdraw gate,
// the 0x address in the dialog) and the transfer went to the NEAR account "0x…" (an ETH-implicit account, or an error) instead
// of the wallet's NEAR account. Runs the REAL engine.transfer / distribute / consolidate / outsideOk (test/sec-cut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, source } from './sec-cut.mjs';

const fixed = source().includes('const laneDest =');
const W = (id, hex, extra = {}) => ({ id, name: 'Wallet ' + id, address: '0x' + hex.repeat(40), key: '0x' + hex.repeat(64), ...extra });
const nearOf = (a) => (a.ext || !a.key ? '' : a.key.slice(2, 66).replace(/./g, (c) => c));   // a 64-hex implicit account per wallet (stub of nearKeys)
const solOf = (a) => (a.ext || !a.key ? '' : 'So1' + a.key.slice(2, 42));

function world({ near = false, sol = false } = {}) {
  const list = [W('w1', '1'), W('w2', '2'), W('w3', '3'), W('px', '9', { ext: 'privy', key: '' }), W('pg', '7', { via: 'page' })];
  const log = { gates: [], asks: [], sends: [], unbacked: [] };
  const stubs = {
    requireUnlocked: () => list, SOL_MODE: sol, NEAR_MODE: near, NATIVE: 'ETH',
    nearAccountId: nearOf, solAddressOf: solOf,
    SOL_ADDR: /^So1[0-9a-f]{40}$/, NEAR_ACCT: /^[a-z0-9][a-z0-9._-]{1,63}$/,
    gate: async (g) => { log.gates.push(g); }, unbackedOk: async (tos) => { log.unbacked.push(tos); },
    ask: async (o) => { log.asks.push(o); return true; }, sub: (h) => h, muted: (h) => h, escHtml: (v) => String(v), destBox: (a) => `[dest ${a}]`,
    sendEth: async (from, to, amt) => { log.sends.push({ from, to, amt }); return '0xhash'; }, parseEther: (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n,
    shortError: (e) => String(e?.message || e), once: (_o, _k, fn) => fn(() => {}),
  };
  // combined with SEC-6 (batch 2): outsideOk asks verifiedLogin for its words — cut it too where the build has it (no main here)
  const sec6 = /\bconst verifiedLogin\b/.test(source());
  if (sec6) Object.assign(stubs, { meta: { main: null }, seedOf: () => undefined, allAccounts: () => list });
  const names = ['lc', 'same', 'ownAccounts', 'isOwn', 'laneUnit', ...(sec6 ? ['verifiedLogin'] : []), 'outsideOk', ...(fixed ? ['laneAddr', 'laneDest'] : []), 'engine.transfer', 'engine.distribute', 'engine.consolidate'];
  return { f: cut(names, stubs), log, list };
}

test('NEAR-2: transfer outside on the NEAR frame says NEAR, not ETH', async () => {
  const { f, log } = world({ near: true });
  await f.transfer('w1', 'someone.near', 5);
  const d = log.asks[0];
  assert.ok(d && /Send 5 NEAR/.test(d.ok), `button: ${d?.ok}`);
  assert.ok(!/ETH/.test(d.ok + d.html), `the dialog names ETH: ${d.ok} | ${d.html}`);
});

test('NEAR-2: distribute between OWN wallets on the NEAR frame is a transfer to their NEAR accounts — no "outside" dialog, no 0x', async () => {
  const { f, log, list } = world({ near: true });
  await f.distribute('w1', ['w2', 'w3'], 1.5);
  assert.deepEqual(log.gates, ['transfer'], `gates ${JSON.stringify(log.gates)} (an own wallet was treated as outside)`);
  assert.equal(log.asks.length, 0, 'no "Send outside your vault" dialog for the vault\'s own wallets');
  assert.deepEqual(log.sends.map((s) => s.to), [nearOf(list[1]), nearOf(list[2])], 'sent to the wallets\' NEAR accounts');
  assert.ok(log.sends.every((s) => !/^0x/.test(s.to)));
  assert.deepEqual(log.unbacked, [[nearOf(list[1]), nearOf(list[2])]], 'the unbacked-wallet check sees the NEAR accounts');
});

test('NEAR-2: consolidate into an own wallet on the NEAR frame sweeps to its NEAR account', async () => {
  const { f, log, list } = world({ near: true });
  await f.consolidate(['w1', 'w2', 'w3'], 'w3');
  assert.deepEqual(log.gates, ['transfer']); assert.equal(log.asks.length, 0);
  assert.deepEqual(log.sends.map((s) => s.to), [nearOf(list[2]), nearOf(list[2])]);
});

test('NEAR-2: distribute to a page-imported wallet (outside) shows its NEAR account and NEAR as the unit', async () => {
  const { f, log, list } = world({ near: true });
  await f.distribute('w1', ['pg'], 2);
  assert.deepEqual(log.gates, ['withdraw']);
  const d = log.asks[0]; assert.ok(d);
  assert.ok(d.html.includes(`[dest ${nearOf(list[4])}]`), `dialog destination: ${d.html}`);
  assert.ok(/2 NEAR/.test(d.html) && !/ETH/.test(d.html), d.html);
  assert.deepEqual(log.sends.map((s) => s.to), [nearOf(list[4])]);
});

test('NEAR-2: a Privy login wallet (EVM only) as a NEAR destination is refused before any dialog or send', async () => {
  const { f, log } = world({ near: true });
  await assert.rejects(f.distribute('w1', ['px'], 1), /no NEAR address/);
  await assert.rejects(f.consolidate(['w1'], 'px'), /no NEAR address/);
  assert.equal(log.sends.length, 0); assert.equal(log.asks.length, 0);
});

test('NEAR-2 (same flaw on the Solana frame): distribute between own wallets goes to their Solana addresses', async () => {
  const { f, log, list } = world({ sol: true });
  await f.distribute('w1', ['w2'], 0.5);
  assert.deepEqual(log.gates, ['transfer']); assert.equal(log.asks.length, 0);
  assert.deepEqual(log.sends.map((s) => s.to), [solOf(list[1])]);
});

test('control: the EVM frame is unchanged — own wallets by 0x address, outside ones through the dialog in ETH', async () => {
  const { f, log, list } = world();
  await f.distribute('w1', ['w2'], 1);
  assert.deepEqual(log.gates, ['transfer']); assert.deepEqual(log.sends.map((s) => s.to), [list[1].address]);
  await f.distribute('w1', ['px'], 1);
  assert.deepEqual(log.gates, ['transfer', 'withdraw']);
  assert.ok(log.asks[0].html.includes(`[dest ${list[3].address}]`) && /1 ETH/.test(log.asks[0].html));
  await f.consolidate(['w1', 'w2'], 'w2');
  assert.equal(log.sends.at(-1).to, list[1].address);
  await f.transfer('w1', '0x' + 'a'.repeat(40), 3);
  assert.match(log.asks.at(-1).ok, /Send 3 ETH/);
});
