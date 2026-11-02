// USD balance consent follows the ACCOUNT (2026-11-02, the owner on his iPhone: a buy with the account's $87 USD balance opened
// "Reading your wallets… Read / Confirm / Convert" instead of buying, and the wallet sheet said "Confirm here — this device has
// not confirmed it yet": "it's either on or off"). Root causes reproduced here, then fixed:
//   1. the account's record was signed by the wallet the OTHER device traded from — one created there and not restored on the
//      phone (the restore window's "Not now") — and a device adopted a grant only when THIS vault held the signer's key
//      ('signer'); the account's backup holding that key under the seed did not count;
//   2. one wallet named in the record that is not this account's (another account's wallet in that device's vault) refused the
//      whole record ('foreign');
//   3. a buy click's confirm was the switch-on wizard (all chains read, a conversion offered).
// Now a signer the account's backup holds counts (the same proof the named wallets get), a foreign named wallet is left out,
// a rules bump / an expired grant asks ONCE per account (the device that confirms publishes, the others follow), and a buy
// click asks for a one-button "Confirm and buy" that converts nothing. Throwaway keys only; nothing leaves the process.
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

// one device of the account: its own vault storage, the wallets it holds, the account backup's wallets (`backup`: what
// webEngine consentOwn's `more` opens under the seed), the vault's dialogs recorded
// `backup`: wallets the account backup holds under the seed (v3: NO proof of authorship since review H1, ignored as a signer);
// `v4`: wallets opened from backup-v4 entries with this vault's own K4 (webEngine consentOwn v4) — the only backup proof
function device({ wallets, backup = [], v4 = [], clock, rules, linked = true }) {
  const store = new Map(); const asks = [], picks = []; let changed = 0;
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: 'So1W' + x.id.padEnd(40, '1') }, r: { evm: x.R, sol: 'So1R' + x.id.padEnd(40, '2') } });
  const no = async () => { throw new Error('test: no chain here'); };
  const f = createFloat({
    chain: () => 'robinhood',
    wallet: (id) => { const x = wallets.find((y) => y.id === id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped: [] }),
    evm: { call: no, balance: no, erc20: no, allowance: no, slot0: no, fees: no, estimate: no, sendR: no, sendW: no, receipt: async () => null },
    sol: { balance: no, usdc: no, oracle6: no, fees: no, quote: no, topup: no, sweep: no, gas: no, status: async () => null },
    ask: async (a) => { asks.push(a); return true; },
    choose: async (a) => { picks.push(a); return 'ok'; },
    gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => clock.now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(),
    emit: () => {},
    fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
    click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }),
    wait: async () => {},
    ...(rules ? { rules } : {}),
    consent: { sign: async (address, message) => { const x = wallets.find((y) => lc(y.W) === lc(address)); if (!x) throw new Error('Unknown wallet'); return privateKeyToAccount(x.key).signMessage({ message }); }, changed: () => { changed += 1; }, linked: () => linked },
  });
  const own = () => ({ vault: new Set(wallets.map((w) => lc(w.W))), more: async () => new Set(backup.map((w) => lc(w.W))), v4: async () => new Set(v4.map((w) => lc(w.W))) });
  // a reserve holding `usd` dollars on Robinhood (the snapshot that chain's frame writes): the account's USD balance as this device reads it
  const reserve = (x, usd, wEth = '0') => store.set('trenches.float.v1.snap.robinhood.' + lc(x.W), JSON.stringify({ at: clock.now, chain: 'robinhood', price6: '4000000000', priceAt: clock.now, float: wEth, reserve: String(BigInt(Math.round(usd * 100)) * 10n ** BigInt(DEC - 2)), reserveNative: '0', inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }));
  return {
    f, store, asks, picks, wallets, changed: () => changed, reserve,
    publish: async (srv) => { const r = await C.consentOutgoing(f.consent, { main: MAIN, seed: SEED, blob: srv.uc, own: own(), now: clock.now }); if (r.blob) srv.put(r.blob); return r; },
    sync: (srv) => C.consentReceive(f.consent, { main: MAIN, seed: SEED, blob: srv.uc, own: own(), now: clock.now }),
    status: () => f.status({ walletId: wallets[0].id, scope: 'account' }),
  };
}
function server() {
  const s = { uc: undefined, put(b) { const p = s.uc; if (p && (b.n < p.n || (b.n === p.n && b.o === 1 && p.o === 0))) return; s.uc = b; } };
  return s;
}
const notesOf = (html) => [...html.matchAll(/<p class="ub-note">(.*?)<\/p>/g)].map((m) => m[1]);

test('the owner\'s case: the desktop signed with a wallet the phone never restored — the phone follows through a co-signature of a wallet it holds (no dialog, no conversion)', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1), w3 = mk(3);   // Wallet 1: on both devices; Wallet 3: created on the desktop, never restored on the phone
  const desk = device({ wallets: [w1, w3], backup: [w1, w3], clock });
  const phone = device({ wallets: [{ ...w1 }], backup: [w1, w3], clock });
  const srv = server();
  // the desktop turns the USD balance on while trading from Wallet 3: signed by Wallet 3, co-signed by Wallet 1
  await desk.f.configure({ walletId: 'w3', chains: ALL });
  await desk.publish(srv);
  const rec = desk.f.consent.local();
  assert.equal(rec.signer, lc(w3.W)); assert.deepEqual(rec.co.map((x) => x.signer), [lc(w1.W)]);
  // the same record WITHOUT the co-signature (as the 35d4aea build wrote it): kept for 'signer' — the phone asked for ever.
  // The v3 backup holding Wallet 3 is no proof (review H1): a phished main signature could have sealed any key there
  const bare = server(); bare.uc = await C.sealConsent(MAIN, SEED, { body: rec.body, signer: rec.signer, sig: rec.sig });
  const phoneOld = device({ wallets: [{ ...w1 }], backup: [w1, w3], clock });
  assert.equal((await phoneOld.sync(bare)).why, 'signer');
  assert.equal((await phoneOld.status()).follow?.why, 'signer', 'the reason is in the status (the app and telemetry can say it)');
  // with it: Wallet 1's key is in this vault and its signature over this exact record checks → adopted
  const v = await phone.sync(srv);
  assert.equal(v.action, 'adopt');
  const st = await phone.status();
  assert.equal(st.enabled, true); assert.equal(st.devices, 'all'); assert.equal(st.follow, undefined);
  assert.equal(phone.asks.length + phone.picks.length, 0, 'no dialog on the phone');
  assert.deepEqual([...phone.store.keys()].filter((k) => k.startsWith('trenches.float.v1.order.')), [], 'nothing converts on the phone');
  assert.equal((await phone.f.status({ walletId: 'w1' })).enabled, true);
  // a signer this vault does not hold counts through the backup only when a backup-v4 entry (this vault's own K4) proves it
  const v4phone = device({ wallets: [{ ...w1 }], v4: [w3], clock });
  assert.equal((await v4phone.sync(bare)).action, 'adopt');
});

test('co-signatures: a forged co-signer, one not named, or one this vault does not hold proves nothing', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1), w3 = mk(3), z = mk(9);
  const desk = device({ wallets: [w1, w3], clock });
  await desk.f.configure({ walletId: 'w3', chains: ALL });
  const rec = desk.f.consent.local();
  const phone = () => device({ wallets: [{ ...w1 }], clock });
  const sealed = async (co) => { const s = server(); s.uc = await C.sealConsent(MAIN, SEED, { body: rec.body, signer: rec.signer, sig: rec.sig, co }); return s; };
  // Wallet 1's slot carrying Wallet 3's signature (not Wallet 1's)
  assert.equal((await phone().sync(await sealed([{ signer: lc(w1.W), sig: rec.sig }]))).why, 'signer');
  // a co-signer the record does not name, even with its own valid signature
  const zs = await privateKeyToAccount(z.key).signMessage({ message: C.consentMessage(rec.body) });
  const pz = device({ wallets: [{ ...w1 }, z], clock });
  assert.equal((await pz.sync(await sealed([{ signer: lc(z.W), sig: zs }]))).why, 'signer');
  // more than CO_MAX entries are cut, malformed ones dropped: the record still opens
  const many = Array.from({ length: 20 }, () => ({ signer: lc(z.W), sig: zs }));
  assert.ok((await C.openConsent(MAIN, SEED, (await sealed(many)).uc)).co.length <= C.CO_MAX);
});

test('a rules bump asks ONCE per account: the first device to confirm publishes, every other device follows without a dialog', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1), w2 = mk(2);
  const R1 = { current: 1, accepted: 1 };
  // the account's record was written on rules 1 (an older build)
  const old = device({ wallets: [w1, w2], backup: [w1, w2], clock, rules: R1 });
  const srv = server();
  await old.f.configure({ walletId: 'w1', chains: ALL }); await old.publish(srv);
  // two devices on today's build (rules 2): neither can adopt a rules-1 grant
  const phone = device({ wallets: [{ ...w1 }, { ...w2 }], backup: [w1, w2], clock });
  const laptop = device({ wallets: [{ ...w1 }, { ...w2 }], backup: [w1, w2], clock });
  assert.equal((await phone.sync(srv)).why, 'rules');
  assert.equal((await laptop.sync(srv)).why, 'rules');
  phone.reserve(w1, 87);
  // the phone confirms once — from a buy click: ONE button, the rule line, nothing converted
  const r = await phone.f.configure({ walletId: 'w1', chains: ALL, click: true });
  assert.equal(phone.picks.length, 0, 'no several-button dialog on a click'); assert.equal(phone.asks.length, 1);
  assert.equal(phone.asks[0].ok, 'Confirm and buy');
  assert.match(phone.asks[0].html, /new rule/);
  assert.ok(notesOf(phone.asks[0].html).includes(F.RESUME.en.buyNext));
  assert.deepEqual(r.convert.planned, []);
  await phone.publish(srv);
  // the laptop and the old device's successor follow on their next sync: no dialog
  assert.equal((await laptop.sync(srv)).action, 'adopt');
  assert.equal((await laptop.status()).enabled, true); assert.equal(laptop.asks.length + laptop.picks.length, 0);
  const upgraded = device({ wallets: [w1, w2], backup: [w1, w2], clock });
  for (const [k, v2] of old.store) upgraded.store.set(k, v2);   // the old device, same storage, today's build
  assert.equal((await upgraded.status()).enabled, false, 'its own rules-1 grant is outdated');
  assert.equal((await upgraded.sync(srv)).action, 'adopt');
  assert.equal((await upgraded.status()).enabled, true); assert.equal(upgraded.asks.length + upgraded.picks.length, 0);
});

test('an expired grant asks once per account too; the renewed record is followed elsewhere', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1);
  const a = device({ wallets: [w1], backup: [w1], clock }); const srv = server();
  await a.f.configure({ walletId: 'w1', chains: ALL }); await a.publish(srv);
  clock.now += 31 * DAY;
  const b = device({ wallets: [{ ...w1 }], backup: [w1], clock });
  assert.equal((await b.sync(srv)).why, 'expired');
  b.reserve(w1, 40);
  await b.f.configure({ walletId: 'w1', chains: ALL, click: true });
  assert.equal(b.asks.length, 1); assert.equal(b.asks[0].ok, 'Confirm and buy');
  await b.publish(srv);
  assert.equal((await a.sync(srv)).action, 'adopt', 'the device whose own grant ran out follows the renewal');
  assert.equal((await a.status()).enabled, true);
  assert.ok((await a.status()).permission.expiresAt > clock.now + 29 * DAY);
});

test('a buy click\'s confirm on a device catching up that cannot prove the account\'s terms: ONE "Confirm and buy" for the DEFAULT terms, the consent laid open, NO conversion', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1);
  const d = device({ wallets: [w1], clock });
  // $87 in the reserve, and 0.05 ETH in the wallet above its floor (the switch-on would have offered to convert it)
  d.reserve(w1, 87, String(F.FLOAT_CFG.robinhood.gasFloor + 50_000_000_000_000_000n));
  const r = await d.f.configure({ walletId: 'w1', chains: ALL, click: true, lang: 'en' });
  assert.equal(d.picks.length, 0); assert.equal(d.asks.length, 1);
  const dlg = d.asks[0];
  assert.equal(dlg.title, 'USD balance on this device'); assert.equal(dlg.ok, 'Confirm and buy');
  assert.match(dlg.html, /You already have \$87\.00 in your USD balance/);
  assert.doesNotMatch(dlg.html, /Optional: you can also convert/);
  assert.doesNotMatch(dlg.html, /<details class="ub-more">/, 'no proven terms here: the whole consent is laid open (review F4)');
  assert.match(dlg.html, /Turn on USD balance for/);
  assert.deepEqual([...d.store.keys()].filter((k) => k.startsWith('trenches.float.v1.order.')), [], 'nothing ordered');
  assert.equal(r.convert.kept, true); assert.deepEqual(r.convert.planned, []);
  assert.equal((await d.status()).enabled, true);
  // the same call without `click` (the switch in the wallet sheet): the two-button catching-up dialog, as before
  const e = device({ wallets: [mk(2)], clock });
  e.reserve(e.wallets[0], 87, String(F.FLOAT_CFG.robinhood.gasFloor + 50_000_000_000_000_000n));
  await e.f.configure({ walletId: 'w2', chains: ALL });
  assert.equal(e.picks.length, 1); assert.equal(e.picks[0].choices.length, 2);
  // an engine argument check: `click` must be a boolean
  await assert.rejects(d.f.configure({ walletId: 'w1', chains: ALL, click: 'yes' }), /Bad arguments: click/);
});

test('the account\'s FIRST grant, asked from a click: `click` is ignored — the first switch-on\'s own dialog (review F4)', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const d = device({ wallets: [w1], clock });
  await d.f.configure({ walletId: 'w1', chains: ALL, click: true, lang: 'en' });
  const dlg = d.asks[0] || d.picks[0];
  assert.ok(dlg); assert.equal(dlg.title, F.ACCOUNT_DIALOG.en.onTitle); assert.notEqual(dlg.ok, 'Confirm and buy');
  assert.doesNotMatch(dlg.html, new RegExp(F.RESUME.en.buyNext));
});

test('every language has the click words; the status shows the stablecoin sitting in the trading wallet apart from the balance', async () => {
  for (const l of F.FLOAT_LANGS) assert.ok(F.RESUME[l].okBuy && F.RESUME[l].buyNext, l);
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1); const d = device({ wallets: [w1], clock });
  d.store.set('trenches.float.v1.snap.robinhood.' + lc(w1.W), JSON.stringify({ at: clock.now, chain: 'robinhood', price6: '4000000000', priceAt: clock.now, float: '0', reserve: '25' + '0'.repeat(DEC), reserveNative: '0', wStable: '12300000' + '0'.repeat(DEC - 6), inFlight6: '0', inFlightReserve6: '0', active: false, presets6: [], buys6: [] }));
  const st = await d.status();
  const ch = st.wallets[0].chains.robinhood;
  assert.equal(ch.stable.usd, 25); assert.equal(ch.wallet.symbol, F.FLOAT_CFG.robinhood.stable.symbol); assert.equal(ch.wallet.usd, 12.3);
  assert.equal(st.usd.cash, 25, 'what sits in the wallet is not in the balance yet');
});

test('the status says the account\'s switch as this device knows it (record on / off) and why it does not follow (follow.why)', async () => {
  const clock = { now: Date.UTC(2026, 10, 2, 9) };
  const w1 = mk(1);
  const a = device({ wallets: [w1], backup: [w1], clock }); const srv = server();
  assert.equal((await a.status()).record, undefined, 'no record seen yet');
  await a.f.configure({ walletId: 'w1', chains: ALL }); await a.publish(srv);
  let st = await a.status();
  assert.equal(st.enabled, true); assert.equal(st.record, 'on'); assert.equal(st.follow, undefined, 'on here: nothing to explain');
  // its own grant runs out: off here, the account was on, and why
  clock.now += 31 * DAY;
  st = await a.status();
  assert.equal(st.enabled, false); assert.equal(st.record, 'on'); assert.equal(st.follow.why, 'expired');
  // another device turns it off for the account: this one follows, and says off
  clock.now -= 31 * DAY;
  const b = device({ wallets: [{ ...w1 }], backup: [w1], clock });
  await b.sync(srv); await b.f.off({ walletId: 'w1' }); await b.publish(srv);
  await a.sync(srv);
  st = await a.status();
  assert.equal(st.enabled, false); assert.equal(st.record, 'off'); assert.equal(st.follow, undefined);
});
