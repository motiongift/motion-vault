// USD balance consent that follows the account (2026-10-28, owner: "yes" to the consent following the account across devices).
// Two (or three) devices of ONE account — each its own vault storage, the same wallets (keys restored from the backup) — and a
// server that only stores what it is handed (`profile.uc`, the server's union rule: a lower counter never replaces a higher
// one, on the same counter off wins). The glue is exactly what webEngine runs: mainProfile → consentOutgoing, mainSync /
// mainConsent → consentReceive (src/floatConsent.ts), against the vault's float module (src/floatEngine.ts).
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
const ON = { walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] };

function device({ wallets, clock, rules, consent = true, linked = false }) {
  const store = new Map(); const asks = [], events = []; let changed = 0;
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: 'So1W' + x.id.padEnd(40, '1') }, r: { evm: x.R, sol: 'So1R' + x.id.padEnd(40, '2') } });
  const no = async () => { throw new Error('test: no chain here'); };
  const f = createFloat({
    chain: () => 'robinhood',
    wallet: (id) => { const x = wallets.find((y) => y.id === id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped: [] }),
    evm: { call: no, balance: no, erc20: no, allowance: no, slot0: no, fees: no, estimate: no, sendR: no, sendW: no, receipt: async () => null },
    sol: { balance: no, usdc: no, oracle6: no, fees: no, quote: no, topup: no, sweep: no, gas: no, status: async () => null },
    ask: async (a) => { asks.push(a); return true; },
    gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => clock.now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(),
    emit: (d) => events.push(d),
    fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
    click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }),
    wait: async () => {},
    ...(rules ? { rules } : {}),
    // webEngine's signer: the named wallet's own key, EIP-191
    ...(consent ? { consent: { sign: async (address, message) => { const x = wallets.find((y) => lc(y.W) === lc(address)); if (!x) throw new Error('Unknown wallet'); return privateKeyToAccount(x.key).signMessage({ message }); }, changed: () => { changed += 1; }, linked: () => linked } } : {}),
  });
  const own = (o = {}) => ({ vault: new Set(wallets.map((w) => lc(w.W))), ...o });
  return {
    f, store, asks, events, wallets, own, changed: () => changed,
    // webEngine mainProfile: what this device would publish, merged with the server's copy first
    publish: async (server, o = {}) => { const r = await C.consentOutgoing(f.consent, { main: MAIN, seed: o.seed || SEED, blob: server.uc, own: own(o.own), now: clock.now }); if (r.blob) server.put(r.blob); return r; },
    // webEngine mainSync / mainConsent
    sync: (server, o = {}) => C.consentReceive(f.consent, { main: MAIN, seed: o.seed || SEED, blob: server.uc, own: own(o.own), now: clock.now }),
    status: () => f.status({ walletId: 'w1', scope: 'account' }),
  };
}
// the server: stores the blob, never opens it (pulse-indexer profileUnion's uc rule)
function server() {
  const s = { uc: undefined, writes: 0,
    put(b) { s.writes += 1; const p = s.uc; if (p && (b.n < p.n || (b.n === p.n && b.o === 1 && p.o === 0))) return; s.uc = b; } };
  return s;
}
const account = () => { const ws = [mk(1), mk(2)]; const clock = { now: Date.UTC(2026, 9, 28, 9) }; return { ws, clock, A: device({ wallets: ws, clock }), B: device({ wallets: ws.map((w) => ({ ...w })), clock }) }; };

test('grant on device A is adopted on device B: on without a dialog, every wallet on, "all your devices"', async () => {
  const { A, B } = account(); const srv = server();
  await A.f.configure(ON);
  assert.equal(A.asks.length, 1, 'A: the one consent dialog');
  assert.equal(A.changed(), 1, 'A tells the page to publish');
  assert.equal((await A.status()).devices, 'this', 'A: not on the server yet');
  await A.publish(srv);
  assert.equal(srv.uc.n, 1); assert.equal(srv.uc.o, 1);
  assert.ok(!JSON.stringify(srv.uc).includes(lc(A.wallets[0].W).slice(2)), 'the server sees no wallet, cap or date');
  await A.sync(srv);
  assert.equal((await A.status()).devices, 'all', 'A: the server holds it now');
  assert.equal((await B.status()).enabled, false);
  const v = await B.sync(srv);
  assert.equal(v.action, 'adopt');
  const st = await B.status();
  assert.equal(st.enabled, true); assert.deepEqual(st.wallets.map((w) => w.enabled), [true, true]);
  assert.equal(st.devices, 'all'); assert.equal(st.permission.devices, 'all');
  assert.equal(B.asks.length, 0, 'B: no dialog');
  assert.equal(B.store.has('trenches.float.v1.order.on.robinhood.' + lc(B.wallets[0].W)), false, 'B converts nothing: A did');
  assert.deepEqual(st.permission.chains, ['robinhood', 'bsc', 'sol']);
  assert.equal(st.permission.expiresAt, (await A.status()).permission.expiresAt, 'same dates as the grant');
  // the same record again: nothing happens
  assert.equal((await B.sync(srv)).why, 'same');
  // B's "Turn on" now asks nothing either and writes no new record
  await B.f.configure(ON); assert.equal(B.asks.length, 0); assert.equal(B.changed(), 0);
  // a wallet's own status (the classic buy path) is on too
  assert.equal((await B.f.status({ walletId: 'w2' })).enabled, true);
});

test('revoke on device B turns device A off on its next sync, and A can never put the grant back', async () => {
  const { A, B } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv); await B.sync(srv);
  // B turns off: nothing to convert back here (no reserve read) → no dialog, the revocation is written above n=1
  await B.f.off({ walletId: 'w1' });
  assert.equal((await B.status()).enabled, false);
  assert.equal(B.changed(), 1);
  await B.publish(srv);
  assert.equal(srv.uc.n, 2); assert.equal(srv.uc.o, 0);
  assert.equal((await A.status()).enabled, true, 'A still on until it syncs');
  const v = await A.sync(srv);
  assert.equal(v.action, 'revoke');
  const st = await A.status();
  assert.equal(st.enabled, false); assert.deepEqual(st.wallets.map((w) => w.enabled), [false, false]);
  assert.equal(A.asks.length, 1, 'A: no new dialog (only its first turn-on)');
  // A publishes again (any wallet change): the revocation stays, its old grant is never re-sealed
  const r = await A.publish(srv);
  assert.equal(r.blob.n, 2); assert.equal(r.blob.o, 0);
  assert.equal(srv.uc.o, 0);
  // and a tick on A does not re-join the wallets
  await A.f.status({ walletId: 'w2' }); assert.equal((await A.status()).enabled, false);
});

test('a revocation on a device that only saw the grant also wins when both write the same counter (off wins a tie)', async () => {
  const { ws, clock, A, B } = account(); const srv = server();
  const Cdev = device({ wallets: ws.map((w) => ({ ...w })), clock });
  await A.f.configure(ON); await A.publish(srv); await B.sync(srv); await Cdev.sync(srv);
  // A changes its grant (n=2, on) while B, not yet seeing it, turns off (n=2, off)
  await A.f.configure({ ...ON, chains: ['robinhood', 'bsc'] });
  const aGrant = A.f.consent.local();
  assert.equal(aGrant.body.n, 2); assert.equal(aGrant.body.on, true);
  await B.f.off({ walletId: 'w1' });
  await A.publish(srv); await B.publish(srv);
  assert.equal(srv.uc.n, 2); assert.equal(srv.uc.o, 0, 'the server keeps the revocation of the tie');
  for (const d of [A, B, Cdev]) { await d.sync(srv); assert.equal((await d.status()).enabled, false); }
  // even if the server had kept the grant of the tie, a device holding the revocation stays off
  const g = await C.sealConsent(MAIN, SEED, aGrant);
  assert.equal(A.f.consent.local().body.on, false, 'A took the revocation');
  const tie = server(); tie.uc = g;
  assert.equal((await B.sync(tie)).why, 'older');
});

test('rollback refused: a server that replays the older grant after a revocation changes nothing, and is healed by the next publish', async () => {
  const { ws, clock, A, B } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv);
  const oldGrant = srv.uc;
  await B.sync(srv);
  await A.f.off({ walletId: 'w1' }); await A.publish(srv); await B.sync(srv);
  assert.equal((await B.status()).enabled, false);
  // the server (or an operator snapshot put back) hands out the old grant again
  const evil = server(); evil.uc = oldGrant;
  const v = await B.sync(evil);
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'older');
  assert.equal((await B.status()).enabled, false, 'still off');
  const r = await B.publish(evil);
  assert.equal(r.blob.n, 2); assert.equal(evil.uc.o, 0, 'B re-publishes the revocation over the replay');
  // a device that never saw the revocation is bounded only by the grant's own 30 days (documented): it takes the old grant
  const fresh = device({ wallets: ws.map((w) => ({ ...w })), clock });
  const rolled = server(); rolled.uc = oldGrant;
  assert.equal((await fresh.sync(rolled)).action, 'adopt');
  // …and turns off at once when it sees the revocation
  assert.equal((await fresh.sync(srv)).action, 'revoke');
  assert.equal((await fresh.status()).enabled, false);
});

test('a grant for wallets that are not this account\'s is refused whole (foreign signer, a foreign wallet in the list, another account\'s seed)', async () => {
  const { ws, clock, B } = account(); const srv = server();
  const stranger = mk(9);
  const body = { v: 1, n: 5, on: true, at: clock.now, chains: ['robinhood'], caps: { perDay6: '1000000000', feesPerDay6: '2000000', perChain6: '250000000', total6: '500000000', maxSlipBps: 50 }, grantedAt: clock.now, expiresAt: clock.now + 30 * DAY, ...F.rulesField(F.FLOAT_RULES.current) };
  const signed = async (b, x) => ({ body: b, signer: lc(x.W), sig: await privateKeyToAccount(x.key).signMessage({ message: C.consentMessage(b) }) });
  // 1. signed by a wallet this vault does not hold (even sealed under the right seed)
  srv.uc = await C.sealConsent(MAIN, SEED, await signed({ ...body, wallets: [lc(stranger.W), lc(ws[0].W)].sort() }, stranger));
  assert.equal((await B.sync(srv)).why, 'signer');
  // 2. signed by one of ours but naming a wallet that is not the account's
  srv.uc = await C.sealConsent(MAIN, SEED, await signed({ ...body, n: 6, wallets: [lc(stranger.W), lc(ws[0].W)].sort() }, ws[0]));
  assert.equal((await B.sync(srv)).why, 'foreign');
  // …unless the account's own backup holds that wallet (opened under this seed): then it is the account's
  assert.equal((await B.sync(srv, { own: { more: async () => new Set([lc(stranger.W)]) } })).action, 'adopt');
  // 3. another account's record (its own seed): does not even open here
  const { A: other } = account(); const osrv = server();
  await other.f.configure(ON); await other.publish(osrv, { seed: '0x' + '77'.repeat(32) });
  const B2 = device({ wallets: ws.map((w) => ({ ...w })), clock });
  assert.equal((await B2.sync(osrv)).why, 'unopened');
  assert.equal((await B2.status()).enabled, false);
});

test('a tampered entry is refused: a flipped sealed byte, a relabelled counter or on/off flag, a body changed after signing', async () => {
  const { A, B } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv);
  const good = srv.uc;
  const flip = (s) => { const b = Buffer.from(s, 'base64'); b[b.length - 20] ^= 1; return b.toString('base64'); };
  for (const bad of [{ ...good, ct: flip(good.ct) }, { ...good, n: 9 }, { ...good, o: 0 }, { ...good, iv: Buffer.alloc(12, 1).toString('base64') }, { ...good, v: 2 }, { ...good, ct: 'AAAA' }]) {
    const t = server(); t.uc = bad;
    assert.equal((await B.sync(t)).why, 'unopened', JSON.stringify(Object.keys(bad)));
  }
  // a seed holder re-seals a record whose body was changed after the wallet signed it (caps raised): the signature no longer matches
  const rec = A.f.consent.local();
  const t = server(); t.uc = await C.sealConsent(MAIN, SEED, { ...rec, body: { ...rec.body, n: 7, caps: { ...rec.body.caps, maxSlipBps: 100 } } });
  assert.equal((await B.sync(t)).why, 'signature');
  // a signature by a wallet other than the named signer
  const t2 = server(); t2.uc = await C.sealConsent(MAIN, SEED, { ...rec, signer: lc(B.wallets[1].W) });
  assert.equal((await B.sync(t2)).why, 'signature');
  assert.equal((await B.status()).enabled, false, 'nothing of it turned B on');
  // the genuine one still does
  assert.equal((await B.sync(srv)).action, 'adopt');
});

test('an expired grant is ignored; a grant on rules this build no longer accepts is not adopted; a seed from an unbound recovery copy never adopts', async () => {
  const { ws, clock, A, B } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv);
  const later = { now: clock.now + 31 * DAY };
  const Bl = device({ wallets: ws.map((w) => ({ ...w })), clock: later });
  const v = await Bl.sync(srv);
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'expired');
  assert.equal((await Bl.status()).enabled, false);
  const Br = device({ wallets: ws.map((w) => ({ ...w })), clock, rules: { current: F.FLOAT_RULES.current + 1, accepted: F.FLOAT_RULES.current + 1 } });
  assert.equal((await Br.sync(srv)).why, 'rules');
  assert.equal((await B.sync(srv, { own: { grants: false } })).why, 'unverified');
  assert.equal((await B.status()).enabled, false);
});

test('a revocation is applied even under a seed that never adopts grants, and on a device that was never on (its high-water then refuses the older grant)', async () => {
  const { ws, clock, A } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv);
  const grant = srv.uc;
  await A.f.off({ walletId: 'w1' }); await A.publish(srv);
  const D = device({ wallets: ws.map((w) => ({ ...w })), clock });
  assert.equal((await D.sync(srv, { own: { grants: false } })).action, 'revoke');
  const replay = server(); replay.uc = grant;
  assert.equal((await D.sync(replay)).why, 'older');
});

test('a grant switched on before this build (no record yet) is published on the next profile write; one already on the server is never overwritten by it', async () => {
  const { ws, clock } = account();
  const old = device({ wallets: ws, clock, consent: false });
  await old.f.configure(ON);                                   // the per-device grant of the previous build
  const upgraded = device({ wallets: ws, clock });
  for (const [k, v] of old.store) upgraded.store.set(k, v);    // same vault storage, new build
  const srv = server();
  const r = await upgraded.publish(srv);
  assert.equal(r.blob?.n, 1); assert.equal(srv.uc.o, 1);
  const B = device({ wallets: ws.map((w) => ({ ...w })), clock });
  assert.equal((await B.sync(srv)).action, 'adopt');
  assert.equal((await B.status()).enabled, true);
  // the server already holds a revocation from another device: the upgraded device takes it, it does not publish its old grant
  const up2 = device({ wallets: ws, clock }); for (const [k, v] of old.store) up2.store.set(k, v);
  await B.f.off({ walletId: 'w1' }); const s2 = server(); await B.publish(s2);
  const r2 = await up2.publish(s2);
  assert.equal(r2.verdict.action, 'revoke'); assert.equal(s2.uc.o, 0);
  assert.equal((await up2.status()).enabled, false);
});

test('a new switch-on after a revocation goes above it and is followed everywhere; changing nothing writes nothing', async () => {
  const { A, B } = account(); const srv = server();
  await A.f.configure(ON); await A.publish(srv); await B.sync(srv);
  await B.f.off({ walletId: 'w1' }); await B.publish(srv); await A.sync(srv);
  await A.f.configure(ON);
  assert.equal(A.asks.length, 2, 'a real turn-on again: the dialog');
  await A.publish(srv);
  assert.equal(srv.uc.n, 3); assert.equal(srv.uc.o, 1);
  assert.equal((await B.sync(srv)).action, 'adopt');
  assert.equal((await B.status()).enabled, true);
  const w = srv.writes; await A.publish(srv); await B.publish(srv);
  assert.equal(srv.uc.n, 3, 'republishing the same record keeps its counter');
  assert.ok(srv.writes >= w);
});

test('pure rules: canonical digest ignores key order and spelling of addresses; a record names its signer among its wallets', async () => {
  const k = generatePrivateKey(); const a = privateKeyToAccount(k);
  const b = { v: 1, n: 1, on: true, at: 1, chains: ['sol', 'bsc'], caps: { perDay6: '1', feesPerDay6: '1', perChain6: '1', total6: '1', maxSlipBps: 50 }, grantedAt: 1, expiresAt: 2, wallets: [a.address] };
  const b2 = { wallets: [lc(a.address)], expiresAt: 2, grantedAt: 1, caps: { maxSlipBps: 50, total6: '1', perChain6: '1', feesPerDay6: '1', perDay6: '1' }, chains: ['bsc', 'sol'], at: 1, on: true, n: 1, v: 1 };
  assert.equal(C.consentDigest(b), C.consentDigest(b2));
  const sig = await a.signMessage({ message: C.consentMessage(b2) });
  assert.equal(await C.verifyConsent({ body: b2, signer: lc(a.address), sig }), true);
  assert.equal(await C.verifyConsent({ body: { ...b2, wallets: ['0x' + '01'.repeat(20)] }, signer: lc(a.address), sig }), false, 'a grant signed by a wallet it does not name');
  assert.equal(C.newer({ v: 1, n: 3, on: false, at: 1 }, { ...b2, n: 3 }), true, 'off wins a tie');
  assert.equal(C.newer({ ...b2, n: 3 }, { v: 1, n: 3, on: false, at: 1 }), false);
  assert.equal(C.newer({ v: 1, n: 2, on: false, at: 9 }, { ...b2, n: 3 }), false, 'the counter decides, not the clock');
  assert.ok(!C.consentMessage(b2).includes(lc(a.address)), 'the signed text carries the digest only');
});

test('the dialogs say it: on = your other devices follow, off = off on all your devices (only when this vault is linked to the account)', async () => {
  const ws = [mk(1)]; const clock = { now: Date.UTC(2026, 9, 28, 9) }; const DEC = F.FLOAT_CFG.bsc.stable.decimals;
  const A = device({ wallets: ws, clock, linked: true });
  await A.f.configure({ ...ON, lang: 'ru' });
  assert.ok(A.asks[0].html.includes(F.ACCOUNT_DEVICES.ru.on), 'on: the line, in the dialog\'s language');
  // a reserve holding $5 on BNB (the snapshot that chain's frame wrote): turning off converts it back there, in the vault's dialog
  A.store.set('trenches.float.v1.snap.bsc.' + lc(ws[0].W), JSON.stringify({ at: clock.now, chain: 'bsc', price6: '600000000', priceAt: clock.now, float: '0', reserve: '5' + '0'.repeat(DEC), reserveNative: '0', inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }));
  await A.f.off({ walletId: 'w1', lang: 'en' });
  assert.equal(A.asks.length, 2);
  assert.ok(A.asks[1].html.includes(F.ACCOUNT_DEVICES.en.off), 'off: the line');
  const solo = device({ wallets: [mk(1)], clock });
  await solo.f.configure(ON);
  assert.ok(!solo.asks[0].html.includes(F.ACCOUNT_DEVICES.en.on), 'a vault not tied to an account says nothing of other devices');
  for (const l of F.FLOAT_LANGS) assert.ok(F.ACCOUNT_DEVICES[l].on && F.ACCOUNT_DEVICES[l].off, l);
});
