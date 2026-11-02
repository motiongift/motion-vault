// Regression tests from the security review of usd-consent-follow (2026-11-02, B:\tmp\foreman\usd-ux-1102-engine-review.md;
// probes B:\tmp\usd-ux-1102\review\{head,base}\test\hostile*.mjs). Each case below FAILED on the reviewed head (and H2 on the
// live base 35d4aea) and passes with F1–F4:
//   H1  a seed holder (one phished main signature) seals its own key into the backup the page hands over and signs a grant:
//       never followed — a signer counts only as a key this vault holds, a co-signer it holds, or a backup-v4 entry opened
//       with this vault's own K4 (the page's `more` / v3 entries / seed-derived addresses prove nothing);
//   H2  a record with slippage 100 %, caps outside CAP_BOUNDS or a ten-year expiry: never followed (why 'terms'), and such a
//       grant already stored is not live;
//   M1  the owner's real old grant replayed to a device that missed the revocation, signer only in the (v3) backup: kept;
//   M2  a record naming none of this vault's wallets turns none of them on;
//   L1  `click` never relabels a caps raise, and a click with caps above the defaults is not "Confirm and buy".
// Throwaway keys only; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';
import * as C from '../src/floatConsent.ts';

const DAY = 86_400_000;
const lc = (a) => String(a).toLowerCase();
const mk = (i, key = generatePrivateKey()) => ({ id: 'w' + i, name: 'Wallet ' + i, key, W: privateKeyToAccount(key).address, R: privateKeyToAccount(F.reserveKeyOf(key)).address });
const MAIN = '0x' + 'ab'.repeat(20);
const SEED = '0x' + '5e'.repeat(32);
const ALL = ['robinhood', 'bsc', 'sol'];
const DEC = F.FLOAT_CFG.robinhood.stable.decimals;

function device({ wallets, backup = [], clock, gateCalls = { n: 0 }, askAnswer = true }) {
  const store = new Map(); const asks = [], picks = [];
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: 'So1W' + x.id.padEnd(40, '1') }, r: { evm: x.R, sol: 'So1R' + x.id.padEnd(40, '2') } });
  const no = async () => { throw new Error('test: no chain here'); };
  const f = createFloat({
    chain: () => 'robinhood',
    wallet: (id) => { const x = wallets.find((y) => y.id === id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped: [] }),
    evm: { call: no, balance: no, erc20: no, allowance: no, slot0: no, fees: no, estimate: no, sendR: no, sendW: no, receipt: async () => null },
    sol: { balance: no, usdc: no, oracle6: no, fees: no, quote: no, topup: no, sweep: no, gas: no, status: async () => null },
    ask: async (a) => { asks.push(a); return askAnswer; },
    choose: async (a) => { picks.push(a); return askAnswer ? 'ok' : null; },
    gate: async () => { gateCalls.n += 1; },
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => clock.now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {},
    fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
    click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }),
    wait: async () => {},
    consent: { sign: async (address, message) => { const x = wallets.find((y) => lc(y.W) === lc(address)); if (!x) throw new Error('Unknown wallet'); return privateKeyToAccount(x.key).signMessage({ message }); }, changed: () => {}, linked: () => true },
  });
  // the page-supplied backup (`more`, the reviewed head's proof) — exactly what a hostile page or server controls
  const own = (extra) => ({ vault: new Set(wallets.map((w) => lc(w.W))), more: async () => new Set([...backup, ...(extra || [])].map((w) => lc(w.W))) });
  return {
    f, store, asks, picks, gateCalls,
    sync: (blob, extra) => C.consentReceive(f.consent, { main: MAIN, seed: SEED, blob, own: own(extra), now: clock.now }),
    status: () => f.status({ walletId: wallets[0].id, scope: 'account' }),
    perm: (w) => JSON.parse(store.get('trenches.float.v1.perm.' + lc(w.W)) || 'null'),
  };
}
const caps = { perDay6: '1000000000', feesPerDay6: '2000000', perChain6: '250000000', total6: '500000000', maxSlipBps: 50 };
const bodyOf = (clock, o = {}) => ({ v: 1, n: 5, on: true, at: clock.now, chains: ['robinhood'], caps, grantedAt: clock.now, expiresAt: clock.now + 30 * DAY, ...F.rulesField(F.FLOAT_RULES.current), ...o });
const signed = async (b, x) => ({ body: b, signer: lc(x.W), sig: await privateKeyToAccount(x.key).signMessage({ message: C.consentMessage(b) }) });
const forge = async (b, x, seed = SEED) => C.sealConsent(MAIN, seed, await signed(b, x));
const permOn = (d, w) => { const p = d.perm(w); return !!p && F.permissionLive(p, Date.now() + 0); };

test('H1 (P1): a seed holder\'s own key sealed into the handed backup signs a grant — never followed, nothing turns on', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const atk = mk(66);
  const d = device({ wallets: [w1], backup: [w1], clock });
  const evil = await forge(bodyOf(clock, { wallets: [lc(atk.W)] }), atk);
  assert.equal((await d.sync(evil)).why, 'signer');
  const v = await d.sync(evil, [atk]);
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'signer', 'a key in the page\'s backup proves nothing');
  assert.equal((await d.status()).enabled, false);
  await d.f.status({ walletId: 'w1' });
  assert.equal(d.perm(w1), null, 'w1 got no permission');
  // the same with the reviewed probe's out-of-bounds terms: refused for its terms before anything else
  const evil2 = await forge(bodyOf(clock, { n: 6, wallets: [lc(atk.W)], caps: { ...caps, maxSlipBps: 10000, perDay6: '9'.repeat(24), total6: '9'.repeat(24), perChain6: '9'.repeat(24) } }), atk);
  assert.equal((await d.sync(evil2, [atk])).why, 'terms');
  assert.equal((await d.status()).enabled, false);
});

test('H2 (hostile2): an AUTHENTIC record (signer held here) with slippage 100 %, unbounded caps or a 10-year expiry is never followed; such a stored grant is not live', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const d = device({ wallets: [w1], clock });
  const wide = { perDay6: '9'.repeat(24), feesPerDay6: '9'.repeat(24), perChain6: '9'.repeat(24), total6: '9'.repeat(24), maxSlipBps: 10000 };
  const cases = [
    bodyOf(clock, { n: 3, chains: ['robinhood', 'bsc'], caps: wide, expiresAt: clock.now + 3650 * DAY, wallets: [lc(w1.W)] }),
    bodyOf(clock, { n: 4, caps: { ...caps, maxSlipBps: 101 }, wallets: [lc(w1.W)] }),
    bodyOf(clock, { n: 5, caps: { ...caps, perChain6: '600000000' }, wallets: [lc(w1.W)] }),            // per chain above the total
    bodyOf(clock, { n: 6, expiresAt: clock.now + 31 * DAY, wallets: [lc(w1.W)] }),
    bodyOf(clock, { n: 7, grantedAt: clock.now + DAY, expiresAt: clock.now + 20 * DAY, wallets: [lc(w1.W)] }),   // dated in the future
  ];
  for (const b of cases) {
    const v = await d.sync(await forge(b, w1));
    assert.equal(v.why, 'terms', JSON.stringify(b.caps) + ' ' + (b.expiresAt - b.grantedAt));
  }
  assert.equal(d.perm(w1), null); assert.equal((await d.status()).enabled, false);
  // a grant with such terms already in storage (adopted by an older build) is not live
  const p = { v: 1, wallet: w1.W, reserve: w1.R, chains: ['robinhood'], caps: { perDay6: 10n ** 24n, feesPerDay6: 10n ** 24n, perChain6: 10n ** 24n, total6: 10n ** 24n, maxSlipBps: 10000 }, grantedAt: clock.now, expiresAt: clock.now + 3650 * DAY };
  assert.equal(F.permissionLive({ ...p, digest: F.permissionDigest(p) }, clock.now), false);
  const a = { v: 1, chains: ['robinhood'], caps: p.caps, grantedAt: p.grantedAt, expiresAt: p.expiresAt, wallets: [lc(w1.W)] };
  assert.equal(F.accountLive({ ...a, digest: F.accountDigest(a) }, clock.now), false);
  // the ones configure writes still are
  const ok = { ...a, caps: F.DEFAULT_CAPS, expiresAt: clock.now + 30 * DAY, ...F.rulesField(F.FLOAT_RULES.current) };
  assert.equal(F.accountLive({ ...ok, digest: F.accountDigest(ok) }, clock.now), true);
  assert.equal(F.termsOk({ caps: F.capsFrom({ perDay: 10000, feesPerDay: 10, perChain: 2500, total: 5000, maxSlipBps: 100 }), grantedAt: 1, expiresAt: 1 + 30 * DAY }), true, 'the largest caps configure allows');
});

test('M1 (P2a): the owner\'s real old grant replayed to a device that missed the revocation, signer only in the backup — kept', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1), w3 = mk(3);
  const old = await forge(bodyOf(clock, { n: 5, wallets: [lc(w1.W), lc(w3.W)].sort() }), w3);
  const fresh = device({ wallets: [w1], backup: [w1, w3], clock });
  const v = await fresh.sync(old);
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'signer');
  assert.equal((await fresh.status()).enabled, false);
  // a device that saw the n=6 revocation refuses it as older (unchanged)
  const seen = device({ wallets: [w1], backup: [w1, w3], clock });
  await seen.sync(await C.sealConsent(MAIN, SEED, await signed({ v: 1, n: 6, on: false, at: clock.now }, w1)));
  assert.equal((await seen.sync(old)).why, 'older');
});

test('M2 (P4): a record naming only a backup wallet and a foreign one turns none of this vault\'s wallets on', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1), w2 = mk(2), w3 = mk(3), z = mk(9);
  const d = device({ wallets: [w1, w2], backup: [w3], clock });
  const v = await d.sync(await forge(bodyOf(clock, { n: 11, wallets: [lc(w3.W), lc(z.W)].sort() }), w3));
  assert.equal(v.action, 'keep');
  const st = await d.status();
  assert.equal(st.enabled, false); assert.deepEqual(st.wallets.map((w) => w.enabled), [false, false]);
  // even when the signer is proven (a backup-v4 entry): 'foreign', nothing on
  const v4 = await C.consentReceive(d.f.consent, { main: MAIN, seed: SEED, blob: await forge(bodyOf(clock, { n: 12, wallets: [lc(w3.W), lc(z.W)].sort() }), w3), own: { vault: new Set([lc(w1.W), lc(w2.W)]), v4: async () => new Set([lc(w3.W)]) }, now: clock.now });
  assert.equal(v4.why, 'foreign');
  assert.equal((await d.status()).enabled, false);
});

test('L1 (P5): `click` never relabels a caps raise / new chain; declining writes nothing; lowering asks nothing', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const g = { n: 0 };
  const d = device({ wallets: [w1], clock, gateCalls: g, askAnswer: false });
  await assert.rejects(d.f.configure({ walletId: 'w1', chains: ALL, click: true }));
  assert.equal(g.n, 1); assert.equal(d.store.has('trenches.float.v1.account'), false); assert.equal(d.store.has('trenches.float.v1.consent'), false);
  const g2 = { n: 0 }; const e = device({ wallets: [mk(2)], clock, gateCalls: g2 });
  await e.f.configure({ walletId: 'w2', chains: ['robinhood'] });
  const before = e.asks.length + e.picks.length;
  await e.f.configure({ walletId: 'w2', chains: ALL, caps: { perDay: 10000, total: 5000, perChain: 2500, maxSlipBps: 100 }, click: true });
  const last = e.asks[e.asks.length - 1];
  assert.equal(e.asks.length + e.picks.length - before, 1, 'the raise asks');
  assert.notEqual(last.ok, 'Confirm and buy', 'a caps raise keeps its own button');
  assert.doesNotMatch(last.html, /<details/, 'laid open');
  const n0 = e.asks.length;
  await e.f.configure({ walletId: 'w2', chains: ALL, caps: { perDay: 50, total: 10, perChain: 10, maxSlipBps: 10 }, click: true });
  assert.equal(e.asks.length - n0, 0);
});

test('L1 (hostile3): a catching-up click with caps above the defaults is not "Confirm and buy" (click ignored: the usual catching-up dialog)', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const d = device({ wallets: [w1], clock });
  d.store.set('trenches.float.v1.snap.robinhood.' + lc(w1.W), JSON.stringify({ at: clock.now, chain: 'robinhood', price6: '4000000000', priceAt: clock.now, float: '0', reserve: '87' + '0'.repeat(DEC), reserveNative: '0', inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }));
  await d.f.configure({ walletId: 'w1', chains: ALL, caps: { perDay: 10000, feesPerDay: 10, perChain: 2500, total: 5000, maxSlipBps: 100 }, click: true });
  const dlg = d.asks[0] || d.picks[0];
  assert.ok(dlg);
  assert.notEqual(dlg.ok, 'Confirm and buy');
  assert.doesNotMatch(dlg.html, new RegExp(F.RESUME.en.buyNext));
});
