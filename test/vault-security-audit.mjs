// Audit fix pass 2026-11-01, area vault-security (owner: “full go-ahead … what matters most is speed and stability”,
// “we can never lose users' money, strictly”). One test per finding, run against the shipped code: the pure modules are
// imported, and the webEngine.ts pieces (which need browser globals) are cut out of the source byte for byte
// (scripts/trade-core.mjs declChunk, or the `name: async` method body), transpiled, and run against stubs.
//   vault-security-relay-recipient   — a quote motion's server relays is never signed (its recipient is unverifiable)
//   vault-security-backup-coverage   — the "stays in your encrypted backup" record only shrinks to the server copy; dropped on file-only
//   vault-security-rewards-link      — signNote: a rewards note for another account asks in the vault's dialog
//   vault-security-consent-replay    — a device with no record of its own still refuses a grant under its high-water counter
//   vault-security-bridge-gas-ceiling — bridge / swap sends sign the node's fee only under the chain's F-73 ceiling
//   vault-security-passkey-confirmed — passkeyConfirmed('off') only finishes a turn-off this frame staged
//   node --experimental-strip-types --test test/vault-security-audit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { declChunk } from '../scripts/trade-core.mjs';
import { relayQuote, relayBody, setRelayProxyBase, keyRefused, MOTION_QUOTE_REFUSED, NATIVE_EVM } from '../src/relayApi.ts';
import * as C from '../src/floatConsent.ts';
import { cappedFees, BRIDGE_GAS_CAPS, BRIDGE_CHAINS, bridgeSend, bridgeDeposit } from '../src/bridgeEngine.ts';
import { evmSwapSend, SWAP_DEPOSIT_GAS_MAX, SWAP_APPROVE_GAS_MAX } from '../src/relaySwap.ts';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const FE = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const lc = (s) => String(s ?? '').toLowerCase();
const tsjs = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const method = (name) => { const i = WE.indexOf(`\n  ${name}: async`); assert.ok(i > 0, name); const j = WE.indexOf('\n  },\n', i); return WE.slice(i + 1, j + 5); };
// webEngine pieces in one scope: top-level declarations + engine methods (as an object), with stubs S
const cut = (decls, methods, S) => {
  const code = tsjs(decls.map((n) => declChunk(WE, n)).join('\n') + '\nconst __m = {\n' + methods.map(method).join('\n') + '\n};');
  return new Function('S', `with (S) { ${code}\n return { ${[...decls.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)), '__m'].join(', ')} }; }`)(S);
};
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const A1 = '0x' + 'a1'.repeat(20), A2 = '0x' + 'a2'.repeat(20), A3 = '0x' + 'a3'.repeat(20), MAIN = '0x' + 'ab'.repeat(20);

// ── vault-security-relay-recipient ──
test('relay-recipient: Relay wanting a key is a refusal — motion\'s pass-through is never asked, so no server-made quote is ever signed', async () => {
  setRelayProxyBase(() => 'https://motion.gift');
  const body = relayBody({ user: A1, recipient: A1, originChainId: 56, destinationChainId: 4663, originCurrency: NATIVE_EVM, destinationCurrency: NATIVE_EVM, amount: '1000' });
  // the attack: an honest-looking quote whose details name the user while Relay's own record names the server's address
  const forged = { requestId: '0x' + 'e2'.repeat(32), steps: [{ id: 'deposit', kind: 'transaction', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x49290c1c' + A1.slice(2).padStart(64, '0') + 'e2'.repeat(32), value: '1000', chainId: 56 } }] }], details: { sender: A1, recipient: A1 } };
  for (const refusal of [reply(401, { errorCode: 'UNAUTHORIZED_QUOTE' }), reply(400, { message: 'missing x-api-key header' }), reply(403, { errorCode: 'UNAUTHORIZED_QUOTE', message: 'API key required' })]) {
    const asked = [];
    const f = async (u) => { asked.push(String(u)); return String(u).endsWith('/vault-quote') ? reply(200, forged) : refusal; };
    await assert.rejects(relayQuote(body, f), (e) => e.message === 'Relay: ' + MOTION_QUOTE_REFUSED);
    assert.deepEqual(asked, ['https://api.relay.link/quote/v2'], 'only Relay itself was asked');
  }
  // a bare 403 (WAF / Cloudflare page) is not a key refusal at all
  assert.equal(keyRefused(403, null), false); assert.equal(keyRefused(403, { message: 'Forbidden' }), false);
  setRelayProxyBase(() => '');
});
test('relay-recipient: no caller in the engine opts into the pass-through (bridge, swap, USD-balance moves, native donor)', () => {
  for (const f of ['webEngine.ts', 'relaySwap.ts', 'floatEngine.ts', 'nativeDonor.ts', 'bridgeEngine.ts']) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /viaMotion/, f);
  }
});

// ── vault-security-backup-coverage ──
function coverageWorld() {
  const S = { meta: { account: null }, lc, persisted: 0, pushed: 0, ready: Promise.resolve(), requireUnlocked: () => [],
    persist: async () => { S.persisted += 1; }, pushBackupState: () => { S.pushed += 1; },
    pendingPublish: new Map(), recoveryChange: new Map(), pkChange: new Map() };
  const x = cut(['inBackup', 'narrowCoverage'], ['mainPublished', 'backupDropped'], S);
  return { S, ...x };
}
test('backup-coverage: a confirmed publish covers its wallets and v1 wallets below its count only', async () => {
  const w = coverageWorld();
  w.S.pendingPublish.set('d'.repeat(24), { main: MAIN, addrs: [lc(A1), lc(A2)], count: 3 });
  assert.deepEqual(await w.__m.mainPublished({ digest: 'd'.repeat(24), updatedAt: 5 }), { ok: true });
  assert.equal(w.S.meta.account.count, 3);
  assert.equal(w.inBackup({ address: A1 }), true); assert.equal(w.inBackup({ address: A3 }), false);
  assert.equal(w.inBackup({ address: A3, main: MAIN, index: 2 }), true, 'v1 index 2 < count 3');
  assert.equal(w.inBackup({ address: A3, main: MAIN, index: 3 }), false, 'v1 index 3 is beyond what the backup counts');
  assert.equal(w.inBackup({ address: A3, main: MAIN, index: 0, gen: 2 }), false, 'a v2 wallet needs its sealed entry');
});
test('backup-coverage: the server copy the page shows afterwards only ever SHRINKS coverage (gone / file-only / missing entries)', async () => {
  const fresh = async () => { const w = coverageWorld(); w.S.pendingPublish.set('d'.repeat(24), { main: MAIN, addrs: [lc(A1), lc(A2)], count: 3 }); await w.__m.mainPublished({ digest: 'd'.repeat(24) }); return w; };
  let w = await fresh();
  assert.equal(w.narrowCoverage(MAIN, null), true, 'no server copy'); assert.equal(w.S.meta.account, null); assert.equal(w.inBackup({ address: A1 }), false);
  w = await fresh();
  assert.equal(w.narrowCoverage(MAIN, { v: 1, main: MAIN, count: 0, names: {}, attached: [], backup: 'file', fileOnlyAt: 9 }), true, 'file-only (removed on another device)');
  assert.equal(w.S.meta.account, null);
  w = await fresh();
  assert.equal(w.narrowCoverage(MAIN, { v: 1, main: '0x' + 'cd'.repeat(20), count: 9, attached: [{ address: A1 }] }), true, 'another account\'s copy'); assert.equal(w.S.meta.account, null);
  w = await fresh();
  assert.equal(w.narrowCoverage(MAIN, { v: 1, main: MAIN, count: 1, attached: [{ address: A2 }, { address: A3 }] }), true);
  assert.deepEqual(w.S.meta.account.addrs, [lc(A2)], 'A1 is not in the server copy any more; A3 is never added');
  assert.equal(w.inBackup({ address: A1 }), false); assert.equal(w.inBackup({ address: A3 }), false);
  assert.equal(w.inBackup({ address: A3, main: MAIN, index: 1 }), false, 'count shrank to 1');
  assert.equal(w.narrowCoverage(MAIN, { v: 1, main: MAIN, count: 9, attached: [{ address: A1 }, { address: A2 }, { address: A3 }] }), false, 'never grows back from page data');
  assert.deepEqual(w.S.meta.account.addrs, [lc(A2)]); assert.equal(w.S.meta.account.count, 1);
  w = await fresh();
  assert.equal(w.narrowCoverage(MAIN, undefined), false, 'no server copy handed = nothing learned');
  assert.equal(w.narrowCoverage(MAIN, { v: 1, main: MAIN, count: 0, names: {}, attached: [] }), false, 'the new-device cool-down serves the sealed parts out: says nothing');
  assert.deepEqual(w.S.meta.account.addrs, [lc(A1), lc(A2)]);
});
test('backup-coverage: backupDropped (the page learned the server keeps no copy) clears this main\'s coverage, never another\'s', async () => {
  const w = coverageWorld();
  w.S.meta.account = { main: lc(MAIN), at: 1, addrs: [lc(A1)], digest: 'x' };
  assert.deepEqual(await w.__m.backupDropped({ address: '0x' + 'cd'.repeat(20) }), { ok: true, dropped: false });
  assert.ok(w.S.meta.account);
  assert.deepEqual(await w.__m.backupDropped({ address: MAIN }), { ok: true, dropped: true });
  assert.equal(w.S.meta.account, null); assert.equal(w.inBackup({ address: A1 }), false);
  assert.ok(w.S.persisted >= 1 && w.S.pushed >= 1, 'stored and the backup state pushed (the nudge comes back)');
  assert.deepEqual(await w.__m.backupDropped({}), { ok: true, dropped: false });
});
test('backup-coverage: mainSync and mainProfile narrow on the server copy they are handed; the page tells the vault on file-only', () => {
  const sync = method('mainSync'), prof = method('mainProfile');
  assert.ok(sync.includes('if (!mismatch) narrowCoverage(m, p);') && sync.indexOf('narrowCoverage(m, p)') < sync.indexOf('await persist();'));
  assert.ok(prof.includes('if (narrowCoverage(m, remote)) { await persist(); pushBackupState(); }') && prof.indexOf('narrowCoverage(m, remote)') < prof.indexOf('buildProfile('));
  assert.match(prof, /pendingPublish\.set\(r\.digest, \{ main: m, addrs: r\.covered, count,/);
  const vc = (process.env.TRENCH_DIR || '../trench') + '/server/web/vault-client.js'; // the page copy, when a trench checkout is next to this one
  const na = (process.env.MOTION_IOS_DIR || '../motion-ios') + '/src/security/nativeVault/account.ts';
  for (const [f, call] of [[vc, "call('backupDropped', lastMain ? { address: lastMain } : {}).catch(() => {});"], [na, "callV('backupDropped', lastMain ? { address: lastMain } : {}).catch(() => {});"]]) {
    let s = ''; try { s = readFileSync(f, 'utf8'); } catch { continue; }
    const nm = s.indexOf('const noteMode'); const file = s.indexOf("if (next === 'file') {", nm); const back = s.indexOf('} else if (fileOnly) {', file);
    const at = s.indexOf(call, file);
    assert.ok(nm > 0 && at > file && at < back, f + ': backupDropped in noteMode\'s file-only branch');
  }
});

// ── vault-security-rewards-link ──
const tagOf = (user) => createHash('sha256').update('motion/rewards/account\n' + user).digest('hex').slice(0, 16);
const linkNote = (w, tag) => `motion rewards\nLink this wallet to my motion rewards account.\nwallet: ${lc(w)}\naccount: ${tag}\nNo transaction, no cost.`;
const releaseNote = (w, tag) => `motion rewards\nRelease this wallet from my motion rewards account.\nwallet: ${lc(w)}\naccount: ${tag}\nNo transaction, no cost.`;
function signWorld({ policy, answer = true }) {
  const key = generatePrivateKey(); const W = { id: 'w1', name: 'Main', address: privateKeyToAccount(key).address, key };
  const asks = [];
  const S = { ready: Promise.resolve(), requireUnlocked: () => [W], lc, privateKeyToAccount, serverPolicy: policy, enc: new TextEncoder(), crypto: globalThis.crypto,
    bytesHex: (u) => '0x' + [...u].map((b) => b.toString(16).padStart(2, '0')).join(''),
    ask: async (o) => { asks.push(o); return answer; }, escHtml: (s) => String(s), sub: (h) => h, muted: (h) => h, addrRow: (n, a) => `${n} ${a}`,
    solAddressOf: () => '', nearAccountId: () => '', solSignText: () => '', nearSignText: () => '' };
  const x = cut(['rewardsTagOfVault'], ['signNote'], S);
  return { W, asks, sign: (m) => x.__m.signNote(W.address, m) };
}
test('rewards-link: a note for the account the server bound this vault to signs without a dialog; any other account asks first', async () => {
  const me = 'did:privy:me', them = 'did:privy:attacker';
  const w = signWorld({ policy: { source: 'server', user: me, enabled: false, gates: {}, at: 1 } });
  const r = await w.sign(linkNote(w.W.address, tagOf(me)));
  assert.equal(w.asks.length, 0, 'own account: no dialog (as before)');
  assert.equal(r.signature.length, 132);
  await w.sign(releaseNote(w.W.address, tagOf(me))); assert.equal(w.asks.length, 0);
  await w.sign(linkNote(w.W.address, tagOf(them)));
  assert.equal(w.asks.length, 1, 'another account: the vault\'s own dialog');
  assert.match(w.asks[0].html, new RegExp(tagOf(them))); assert.equal(w.asks[0].danger, true);
  const no = signWorld({ policy: { source: 'server', user: me }, answer: false });
  await assert.rejects(no.sign(linkNote(no.W.address, tagOf(them))), /Cancelled/);
  // no server-bound account (logged out, or only the page's word): every rewards note asks
  for (const policy of [null, { source: 'page', user: me }, { source: 'server', user: '' }]) {
    const x = signWorld({ policy });
    await x.sign(linkNote(x.W.address, tagOf(me)));
    assert.equal(x.asks.length, 1, JSON.stringify(policy));
  }
  // the other note kinds are unchanged
  const c = signWorld({ policy: null });
  await c.sign('copytrade.gg callout\nhello'); assert.equal(c.asks.length, 0);
  await assert.rejects(c.sign(linkNote('0x' + '99'.repeat(20), tagOf(me))), /names another wallet/);
});

// ── vault-security-consent-replay ──
const DAY = 86_400_000, SEED = '0x' + '5e'.repeat(32);
async function record(key, n, on, now) {
  const a = privateKeyToAccount(key);
  const body = on ? { v: 1, n, on: true, at: now, chains: ['robinhood'], caps: { perDay6: '50000000', feesPerDay6: '500000', perChain6: '10000000', total6: '10000000', maxSlipBps: 100 } /* 2026-11-02: inside CAP_BOUNDS (floatCore termsOk) */, grantedAt: now, expiresAt: now + 30 * DAY, rules: 2, wallets: [lc(a.address)] } : { v: 1, n, on: false, at: now };
  const rec = { body, signer: lc(a.address), sig: await a.signMessage({ message: C.consentMessage(body) }) };
  return C.sealConsent(MAIN, SEED, rec);
}
function host(seen) {
  const st = { local: null, seen, applied: [] };
  return { st, h: { accepted: 0, local: () => st.local, seen: (n) => { if (n > st.seen) st.seen = n; }, seenMax: () => st.seen, apply: (v) => { st.applied.push(v.action); st.local = v.rec; }, synced: () => {}, fromLive: async () => null } };
}
test('consent-replay: with no record of its own, a device refuses a grant older than a counter it has already seen; a fresh one still adopts', async () => {
  const key = generatePrivateKey(), now = Date.now(); const own = { vault: new Set([lc(privateKeyToAccount(key).address)]) };
  const old5 = await record(key, 5, true, now);
  const a = host(6);   // this device saw counter 6 (e.g. a grant whose signer it did not hold yet) and keeps no record
  const v = await C.consentReceive(a.h, { main: MAIN, seed: SEED, blob: old5, own, now });
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'older'); assert.deepEqual(a.st.applied, []);
  const b = host(0);
  assert.equal((await C.consentReceive(b.h, { main: MAIN, seed: SEED, blob: old5, own, now })).action, 'adopt', 'a device that saw nothing newer follows the account as before');
  const c = host(6);
  assert.equal((await C.consentReceive(c.h, { main: MAIN, seed: SEED, blob: await record(key, 6, true, now), own, now })).action, 'adopt', 'the very counter it saw');
  const d = host(9);
  assert.equal((await C.consentReceive(d.h, { main: MAIN, seed: SEED, blob: await record(key, 5, false, now), own, now })).action, 'revoke', 'turning off is always followed');
  const legacy = { ...host(9).h }; delete legacy.seenMax;
  assert.equal((await C.consentReceive(legacy, { main: MAIN, seed: SEED, blob: old5, own, now })).action, 'adopt', 'an older host without seenMax behaves as before');
  assert.equal(C.judgeConsent({ local: null, remote: (await C.openConsent(MAIN, SEED, old5)), vault: () => true, own: () => true, now, accepted: 0, floor: 6 }).why, 'older');
});
test('consent-replay: the float host hands its stored high-water counter to the judge', () => {
  assert.ok(FE.includes('    seenMax: () => consentState().seen,'), 'floatEngine consent host exposes seenMax');
});

// ── vault-security-bridge-gas-ceiling ──
test('bridge-gas-ceiling: every bridgeable chain has a ceiling; fees above it, gas × fee above the cap, or no estimate are refused; the tip is clamped', () => {
  assert.deepEqual(Object.keys(BRIDGE_GAS_CAPS).sort(), Object.keys(BRIDGE_CHAINS).sort());
  const g = 1_000_000_000n;
  assert.deepEqual(cappedFees(4663, { maxFeePerGas: g / 10n, maxPriorityFeePerGas: g / 100n }, [150_000n]), { maxFeePerGas: g / 10n, maxPriorityFeePerGas: g / 100n });
  assert.deepEqual(cappedFees(56, { maxFeePerGas: g, maxPriorityFeePerGas: 5n * g }, [21_000n]), { maxFeePerGas: g, maxPriorityFeePerGas: g }, 'tip ≤ fee cap');
  assert.throws(() => cappedFees(56, { maxFeePerGas: 10_000n * g, maxPriorityFeePerGas: 10_000n * g }, [150_000n]), /far above normal/, 'the finding: 10,000 gwei');
  assert.throws(() => cappedFees(4663, { maxFeePerGas: 19n * g }, [10_000_000n]), /abnormal gas/, '10M gas × 19 gwei > 0.1 ETH');
  assert.throws(() => cappedFees(56, null, [21_000n]), /Could not read the network fee/);
  assert.throws(() => cappedFees(56, {}, [21_000n]), /Could not read the network fee/);
  assert.throws(() => cappedFees(999, { maxFeePerGas: 1n }, [1n]), /not bridgeable/);
  // today's live fees (2026-11-01) pass with room: Polygon 266 gwei for a 300k-gas deposit, Arc 25 gwei
  assert.doesNotThrow(() => cappedFees(137, { maxFeePerGas: 266n * g * 3n }, [300_000n]));
  assert.doesNotThrow(() => cappedFees(5042, { maxFeePerGas: 25n * g * 3n }, [300_000n]));
  assert.equal(SWAP_DEPOSIT_GAS_MAX, 1_000_000n); assert.equal(SWAP_APPROVE_GAS_MAX, 200_000n);
});
// a JSON-RPC node behind global fetch (viem's http transport) that quotes a lying priority fee; it records every method
function lyingNode({ tipGwei, baseGwei = 1n }) {
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.relay.link/quote/v2')) return new Response(JSON.stringify({ steps: [{ kind: 'transaction', items: [{ data: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', chainId: 56, data: '0x49290c1c' } }] }] }), { status: 200 });
    const one = (r) => { calls.push(r.method); const g = 1_000_000_000n; const hex = (v) => '0x' + v.toString(16);
      const res = r.method === 'eth_chainId' ? '0x38' : r.method === 'eth_getBlockByNumber' ? { number: '0x1', baseFeePerGas: hex(baseGwei * g), hash: '0x' + '00'.repeat(32), timestamp: '0x1', transactions: [] }
        : r.method === 'eth_maxPriorityFeePerGas' ? hex(tipGwei * g) : r.method === 'eth_gasPrice' ? hex((baseGwei + tipGwei) * g) : r.method === 'eth_getBalance' ? hex(10n ** 20n)
        : r.method === 'eth_getTransactionCount' ? '0x0' : r.method === 'eth_estimateGas' ? '0x5208' : r.method === 'eth_call' ? '0x' + 'ff'.repeat(32) : r.method === 'eth_sendRawTransaction' ? '0x' + '11'.repeat(32) : null;
      return { jsonrpc: '2.0', id: r.id, result: res }; };
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
test('bridge-gas-ceiling: a node quoting a 10,000-gwei tip makes bridgeSend / bridgeDeposit / evmSwapSend refuse before anything is signed', async () => {
  const key = generatePrivateKey(); const a = { id: 'w1', name: 'Main', address: privateKeyToAccount(key).address, key };
  const me = lc(a.address).slice(2).padStart(64, '0');
  const node = lyingNode({ tipGwei: 10_000n });
  try {
    await assert.rejects(bridgeSend(a, 56, A2, 0.01), /far above normal/);
    await assert.rejects(bridgeDeposit(a, { requestId: '0x' + 'e2'.repeat(32), originChainId: 56, destinationChainId: 4663, amount: '1000', recipient: a.address, step: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x49290c1c' + me + 'e2'.repeat(32), value: '1000', chainId: 56, gas: '60000' }, source: 'relay' }), /far above normal/);
    await assert.rejects(evmSwapSend(a, { originChainId: 56, destinationChainId: 4663, originCurrency: NATIVE_EVM, destinationCurrency: NATIVE_EVM, amount: '1000', recipient: a.address, requestId: '0x' + 'e2'.repeat(32), source: 'relay', user: a.address, out: '1', outFormatted: '1', outSymbol: 'ETH', inSymbol: 'BNB', inFormatted: '1', inDecimals: 18, steps: ['deposit'], evm: { approve: null, deposit: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x49290c1c' + me + 'e2'.repeat(32), value: '1000', chainId: 56, gas: '60000' } } }), /far above normal/);
    assert.ok(!node.calls.includes('eth_sendRawTransaction'), 'nothing was broadcast');
  } finally { node.restore(); }
  // an honest node: the same send goes out with the node's fee (tip under the cap)
  const ok = lyingNode({ tipGwei: 1n });
  try {
    const h = await bridgeSend(a, 56, A2, 0.01);
    assert.match(h, /^0x[0-9a-f]{64}$/); assert.ok(ok.calls.includes('eth_sendRawTransaction'));
  } finally { ok.restore(); }
});

// ── vault-security-passkey-confirmed ──
function pkWorld() {
  const m = lc(MAIN);
  const S = { ready: Promise.resolve(), requireUnlocked: () => [], mainAddr: lc, lc, meta: { pk4: { [m]: 3 } }, seeds: { [`pk4:${m}:3`]: 'dk' }, k4Cache: new Map([[m + '|3', {}]]),
    pkChange: new Map(), pkPending: new Map(), PK_OFF_CONFIRM_MS: 30 * 60_000, dkOf: (mm, g) => S.seeds[`pk4:${mm}:${g}`],
    pkError: (n, t) => Object.assign(new Error(t), { name: n }), pkt: (k) => k, persist: async () => {}, pushBackupState: () => {}, Date };
  const x = cut([], ['passkeyConfirmed'], S);
  return { S, m, confirm: x.__m.passkeyConfirmed };
}
test('passkey-confirmed: a bare page call cannot drop this device\'s v4 guard; a turn-off this frame staged still finishes', async () => {
  let w = pkWorld();
  await assert.rejects(w.confirm({ address: MAIN, mode: 'off' }), /No passkey turn-off is pending here/);
  assert.equal(w.S.meta.pk4[w.m], 3); assert.equal(w.S.seeds[`pk4:${w.m}:3`], 'dk'); assert.equal(w.S.k4Cache.size, 1, 'nothing wiped');
  w.S.pkPending.set(w.m, { mode: 'up', gen: 4, at: Date.now() });
  await assert.rejects(w.confirm({ address: MAIN, mode: 'off' }), /No passkey turn-off/, 'a staged enrolment is not a turn-off');
  w.S.pkPending.set(w.m, { mode: 'off', gen: 3, at: Date.now() - 31 * 60_000 });
  await assert.rejects(w.confirm({ address: MAIN, mode: 'off' }), /No passkey turn-off/, 'stale');
  w = pkWorld();
  w.S.pkPending.set(w.m, { mode: 'off', gen: 3, at: Date.now() });
  assert.deepEqual(await w.confirm({ address: MAIN, mode: 'off' }), { ok: true });
  assert.equal(w.S.meta.pk4[w.m], undefined); assert.equal(w.S.seeds[`pk4:${w.m}:3`], undefined); assert.equal(w.S.k4Cache.size, 0); assert.equal(w.S.pkPending.size, 0);
  // 'up' unchanged: it records a generation whose data key this vault holds
  w = pkWorld(); w.S.meta.pk4 = {};
  assert.deepEqual(await w.confirm({ address: MAIN, mode: 'up', gen: 3 }), { ok: true }); assert.equal(w.S.meta.pk4[w.m], 3);
  await assert.rejects(w.confirm({ address: MAIN, mode: 'up', gen: 7 }), /lockedConfirm/);
});
