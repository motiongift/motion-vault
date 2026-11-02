// USD balance — a grant survives every release (2026-10-27; a user: "i turned on usd balance yday and its asking me to do it
// again today"). The grant binds to what the user agreed to (wallets, chains, caps, dates, rules version), never to the words
// the dialog showed, the language, or the engine build. Proven here on the vault module (src/floatEngine.ts) with:
//   - the storage YESTERDAY's engine left behind (test/fixtures/float-grant-9e05781.json, written by motion-vault-rc 9e05781 =
//     live sha384-ANzvjj5c…, whose dialog still named the volume caps) read by this build, in the Robinhood AND Solana frames;
//   - a rules bump (FLOAT_RULES) that does re-ask: only its one new line, no conversion, the dates kept;
//   - the 30-day expiry; and a wallet added since the grant, which joins on its first status read in any frame.
// Throwaway keys only (the fixture's are 0x11…11 and 0x22…22), nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/float-grant-9e05781.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;
const lc = (a) => String(a).toLowerCase();
const fixedWallet = (key, i) => ({ id: 'w' + (i + 1), name: 'Wallet ' + (i + 1), W: privateKeyToAccount(key).address, R: privateKeyToAccount(F.reserveKeyOf(key)).address });
const FIX_WALLETS = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)].map(fixedWallet);
const fresh = (id, name) => { const k = generatePrivateKey(); return { id, name, W: privateKeyToAccount(k).address, R: privateKeyToAccount(F.reserveKeyOf(k)).address }; };

// one vault origin: ONE store shared by every frame (lane) and every build; `chain` is the frame's lane
function frame({ store, wallets, chain = 'robinhood', clock, rules, answer = true }) {
  const asks = [], events = [];
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: 'So1W' + x.id.padEnd(40, '1') }, r: { evm: x.R, sol: 'So1R' + x.id.padEnd(40, '2') } });
  const no = async () => { throw new Error('test: no chain here'); };
  const f = createFloat({
    chain: () => chain,
    wallet: (id) => { const x = wallets.find((y) => y.id === id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped: [] }),
    // nothing to read: every chain read fails (a snapshot-less wallet is "not read yet"); nothing can be sent
    evm: { call: no, balance: no, erc20: no, allowance: no, slot0: no, fees: no, estimate: no, sendR: no, sendW: no, receipt: async () => null },
    sol: { balance: no, usdc: no, oracle6: no, fees: no, quote: no, topup: no, sweep: no, gas: no, status: async () => null, forward: no, fundW: no },
    ask: async (a) => { asks.push(a); return typeof answer === 'function' ? answer(a) : answer; },
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
  });
  return { f, asks, events };
}
const yesterday = () => ({ store: new Map(Object.entries(FIX.store)), clock: { now: FIX.now + DAY } });
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
const ON = { walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] };
// a build on rules 1 (the rules every grant up to 2026-10-29 agreed to): what "survives a release" means when the rules did not
// change. The real build is on rules 2 since 2026-10-29 (the buy from the reserve, owner «да делай давай»): tested below.
const R1 = { current: 1, accepted: 1 };

test('fixture: yesterday\'s engine wrote the grant after a dialog that named the volume caps; the record holds no text, language or build', () => {
  assert.deepEqual(FIX.wallets.map((w) => w.W), FIX_WALLETS.map((w) => w.W), 'the fixture\'s wallets are the fixed test keys');
  assert.ok(FIX.dialog.text.includes('up to $1,000.00 a day per wallet;'), 'yesterday\'s wording');
  const a = JSON.parse(FIX.store['trenches.float.v1.account']);
  assert.deepEqual(Object.keys(a).sort(), ['caps', 'chains', 'digest', 'expiresAt', 'grantedAt', 'joined', 'v', 'wallets']);
  for (const [k, v] of Object.entries(FIX.store)) if (k.startsWith('trenches.float.v1.perm.')) assert.deepEqual(Object.keys(JSON.parse(v)).sort(), ['caps', 'chains', 'digest', 'expiresAt', 'grantedAt', 'reserve', 'v', 'wallet']);
  // today's dialog reads differently (no caps), and that changes nothing below
  assert.ok(!/a day per wallet/.test(F.accountPermissionText(['Wallet 1', 'Wallet 2'], ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, 50_000n)));
});

test('a grant made on yesterday\'s build (the old text) is live in a build on the same rules: on in the Robinhood, BNB AND Solana frames, every wallet on, and switching on again asks nothing', async () => {
  const { store, clock } = yesterday();
  for (const chain of ['robinhood', 'bsc', 'sol']) {
    const { f, asks } = frame({ store, wallets: FIX_WALLETS, chain, clock, rules: R1 });
    const st = await f.status({ walletId: 'w1', scope: 'account' });
    assert.equal(st.enabled, true, chain);
    assert.deepEqual(st.wallets.map((w) => w.enabled), [true, true], chain);
    assert.equal(st.permission.live, true); assert.equal(st.permission.rules, 1); assert.equal(st.permission.outdated, false);
    assert.equal((await f.status({ walletId: 'w2' })).enabled, true, 'a wallet\'s own status too (the classic buy path)');
    const before = store.get('trenches.float.v1.account');
    const r = await f.configure({ ...ON, lang: 'ru' });
    assert.equal(asks.length, 0, `${chain}: no dialog, whatever the language`);
    assert.equal(r.convert, null, 'nothing converts again');
    assert.equal(JSON.parse(store.get('trenches.float.v1.account')).grantedAt, JSON.parse(before).grantedAt, 'the grant keeps its dates');
  }
});

test('the digest binds substance, never wording: the same grant shown in English and in Russian (two different texts) is the same record; a changed substance is not live', async () => {
  const wallets = [fresh('w1', 'Wallet 1'), fresh('w2', 'Wallet 2')];
  const t0 = Date.UTC(2026, 9, 27, 12);
  const rec = {};
  for (const lang of ['en', 'ru']) {
    const store = new Map(); const { f, asks } = frame({ store, wallets, clock: { now: t0 }, rules: R1 });
    await f.configure({ ...ON, lang });
    assert.equal(asks.length, 1);
    rec[lang] = { text: asks[0].html, account: JSON.parse(store.get('trenches.float.v1.account')), perm: JSON.parse(store.get(`trenches.float.v1.perm.${lc(wallets[0].W)}`)) };
  }
  assert.notEqual(rec.en.text, rec.ru.text, 'two different consent texts');
  assert.equal(rec.en.account.digest, rec.ru.account.digest, 'one digest');
  assert.equal(rec.en.perm.digest, rec.ru.perm.digest);
  assert.ok(!('rules' in rec.en.account) && !('rules' in rec.en.perm), 'a rules-1 record has no rules field: every older engine reads it');
  const parse = (a) => ({ ...a, caps: { perDay6: BigInt(a.caps.perDay6), feesPerDay6: BigInt(a.caps.feesPerDay6), perChain6: BigInt(a.caps.perChain6), total6: BigInt(a.caps.total6), maxSlipBps: a.caps.maxSlipBps } });
  const g = parse(rec.en.account);
  assert.equal(F.accountLive(g, t0 + DAY, 1), true);
  assert.equal(F.accountLive(g, t0 + DAY), false, 'a rules-1 grant is not live on this build (rules 2)');
  assert.equal(F.accountLive({ ...g, chains: ['robinhood'] }, t0 + DAY, 1), false, 'chains');
  assert.equal(F.accountLive({ ...g, expiresAt: g.expiresAt + DAY }, t0 + DAY, 1), false, 'dates');
  assert.equal(F.accountLive({ ...g, wallets: [...g.wallets, lc(fresh('w9', 'x').W)] }, t0 + DAY, 1), false, 'wallets');
  assert.equal(F.accountLive({ ...g, rules: 2 }, t0 + DAY, 1), false, 'a rules field the digest did not cover');
});

const BUMP = { current: 2, accepted: 2, delta: { 2: { en: 'New: the vault may also pay network fees for you from motion\'s own funds.', ru: 'Новое: хранилище может также оплачивать комиссии сети из средств motion.', zh: 'x', id: 'x', es: 'x', fr: 'x' } } };

test('a substantive rules bump re-asks: the old grant pauses (off in every frame, nothing moves); the next switch asks ONLY the new line, converts nothing, keeps the dates; then it is live on the new rules', async () => {
  const { store, clock } = yesterday();
  const a0 = JSON.parse(store.get('trenches.float.v1.account'));
  const { f, asks } = frame({ store, wallets: FIX_WALLETS, clock, rules: BUMP });
  const st = await f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st.enabled, false, 'a grant on rules 1 is not live under rules 2');
  assert.equal(st.permission.outdated, true, 'and the status says why: it waits for the new rule');
  assert.deepEqual(st.wallets.map((w) => w.enabled), [false, false]);
  const tick = await f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await settle();
  assert.ok(tick.queued || tick.note === 'off', 'a tick plans nothing');
  assert.equal(store.get(`trenches.float.v1.perm.${lc(FIX_WALLETS[0].W)}`), FIX.store[`trenches.float.v1.perm.${lc(FIX_WALLETS[0].W)}`], 'no join rewrites a paused wallet');
  // the next switch: one dialog, the new rule's ONE line as its lead, the rules folded under it, no conversion rows
  const r = await f.configure({ ...ON, lang: 'en' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].title, F.RULES_DIALOG.en.title); assert.equal(asks[0].ok, F.RULES_DIALOG.en.ok);
  assert.deepEqual([...asks[0].html.matchAll(/<p class="ub-lead">(.*?)<\/p>/g)].map((m) => m[1]), [BUMP.delta[2].en]);
  assert.match(asks[0].html, /<details class="ub-more"><summary>How it works<\/summary>/, 'the rules folded, for reference');
  assert.ok(!/class="ub-r"/.test(asks[0].html), 'no conversion rows'); assert.equal(r.convert, null);
  const a1 = JSON.parse(store.get('trenches.float.v1.account'));
  assert.equal(a1.rules, 2); assert.equal(a1.grantedAt, a0.grantedAt); assert.equal(a1.expiresAt, a0.expiresAt);
  for (const w of FIX_WALLETS) { const p = JSON.parse(store.get(`trenches.float.v1.perm.${lc(w.W)}`)); assert.equal(p.rules, 2); assert.equal(p.expiresAt, a0.expiresAt); }
  const st2 = await f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st2.enabled, true); assert.equal(st2.permission.rules, 2); assert.equal(st2.permission.outdated, false);
  // and once agreed, a later switch asks nothing
  await f.configure({ ...ON, lang: 'en' }); assert.equal(asks.length, 1);
  // in Russian the line is the Russian one; a bump without its own line says that one rule is new
  const ru = frame({ store: new Map(Object.entries(FIX.store)), wallets: FIX_WALLETS, clock, rules: BUMP });
  await ru.f.configure({ ...ON, lang: 'ru' });
  assert.deepEqual([...ru.asks[0].html.matchAll(/<p class="ub-lead">(.*?)<\/p>/g)].map((m) => m[1]), [BUMP.delta[2].ru]);
  assert.equal(ru.asks[0].title, F.RULES_DIALOG.ru.title);
  assert.deepEqual(F.rulesDeltaLines(1, 3, 'fr', {}), [F.RULES_DIALOG.fr.fallback]);
});

test('THIS build (rules 2, owner 2026-10-29 «да делай давай»): yesterday\'s grant pauses; the next switch asks only the buy-from-the-reserve line, in the user\'s language; then the reserve may buy', async () => {
  assert.deepEqual({ ...F.FLOAT_RULES }, { current: 2, accepted: 2 });
  for (const lang of ['en', 'ru', 'zh', 'id', 'es', 'fr']) assert.ok(F.RULES_DELTA[2][lang].length > 40, lang);
  assert.match(F.RULES_DELTA[2].en, /reserve/); assert.match(F.RULES_DELTA[2].en, /within your limits/);
  const { store, clock } = yesterday();
  const a0 = JSON.parse(store.get('trenches.float.v1.account'));
  const { f, asks } = frame({ store, wallets: FIX_WALLETS, clock });
  const st = await f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st.enabled, false); assert.equal(st.permission.outdated, true);
  assert.throws(() => f.directFor('w1'), /off for this wallet/);
  for (const lang of ['en', 'ru']) {
    const x = frame({ store: new Map(Object.entries(FIX.store)), wallets: FIX_WALLETS, clock });
    await x.f.configure({ ...ON, lang });
    assert.equal(x.asks[0].title, F.RULES_DIALOG[lang].title);
    assert.deepEqual([...x.asks[0].html.matchAll(/<p class="ub-lead">(.*?)<\/p>/g)].map((m) => m[1]), [F.RULES_DELTA[2][lang]]);
  }
  const r = await f.configure({ ...ON, lang: 'en' });
  assert.equal(asks.length, 1); assert.equal(r.convert, null, 'nothing converts');
  const a1 = JSON.parse(store.get('trenches.float.v1.account'));
  assert.equal(a1.rules, 2); assert.equal(a1.grantedAt, a0.grantedAt); assert.equal(a1.expiresAt, a0.expiresAt);
  assert.equal((await f.status({ walletId: 'w1', scope: 'account' })).enabled, true);
  // the consent text itself says it, and no longer says nothing can leave
  assert.match(asks[0].html, /paid straight from that wallet's own reserve/);
  assert.ok(!/Nothing can leave your wallets this way\./.test(asks[0].html));
});

test('a rules bump the user declines or closes: nothing is lost — the grant, its dates and every wallet\'s record stay exactly as they were, nothing converts back, and the next switch asks the same one line', async () => {
  const { store, clock } = yesterday();
  const before = new Map(store);
  const { f, asks } = frame({ store, wallets: FIX_WALLETS, clock, rules: BUMP, answer: false });
  await assert.rejects(f.configure({ ...ON, lang: 'en' }), /Cancelled/);
  assert.deepEqual(new Map([...store].filter(([k]) => before.has(k))), before, 'every record untouched');
  assert.ok(![...store.keys()].some((k) => k.startsWith('trenches.float.v1.order.')), 'no conversion either way');
  const again = frame({ store, wallets: FIX_WALLETS, clock, rules: BUMP });
  await again.f.configure({ ...ON, lang: 'en' });
  assert.equal(again.asks[0].title, F.RULES_DIALOG.en.title, 'the same short dialog, not the whole opt-in');
  assert.equal(asks.length, 1);
  // a caps raise on top of a bump shows the whole consent, laid open (it covers the new rule too), and renews the dates
  const both = frame({ store: new Map(Object.entries(FIX.store)), wallets: FIX_WALLETS, clock, rules: BUMP });
  await both.f.configure({ ...ON, lang: 'en', caps: { perDay: 2000 } });
  assert.equal(both.asks[0].title, F.ACCOUNT_DIALOG.en.onTitle); assert.match(both.asks[0].html, /<div class="ub-open">/);
});

test('the 30-day expiry: live until the last millisecond in every frame, then off; the next switch asks the whole consent again and starts a new 30 days', async () => {
  const { store } = yesterday();
  const a = JSON.parse(store.get('trenches.float.v1.account'));
  assert.equal(a.expiresAt - a.grantedAt, F.PERMISSION_DAYS * DAY);
  const clock = { now: a.expiresAt - 1 };
  for (const chain of ['robinhood', 'sol']) assert.equal((await frame({ store, wallets: FIX_WALLETS, chain, clock, rules: R1 }).f.status({ walletId: 'w1', scope: 'account' })).enabled, true, chain);
  clock.now = a.expiresAt;
  const { f, asks } = frame({ store, wallets: FIX_WALLETS, clock, rules: R1 });
  assert.equal((await f.status({ walletId: 'w1', scope: 'account' })).enabled, false);
  await f.configure({ ...ON, lang: 'en' });
  // (2026-11-01) a grant of this device that ran out: the confirm that says so and converts nothing by default, the whole
  // consent folded in it — not a rules line
  assert.equal(asks.length, 1); assert.equal(asks[0].title, F.RESUME.en.title, 'a re-confirm, not a rules line');
  assert.match(asks[0].html, /Your consent for the USD balance ran out on [A-Z][a-z]{2} \d{1,2} \(it lasts 30 days\)/);
  assert.match(asks[0].html, /<details class="ub-more">.*Turn on USD balance for all your wallets/s);
  assert.equal([...store.keys()].filter((k) => k.startsWith('trenches.float.v1.order.')).length, 0, 'nothing ordered');
  const b = JSON.parse(store.get('trenches.float.v1.account'));
  assert.equal(b.grantedAt, clock.now); assert.equal(b.expiresAt, clock.now + F.PERMISSION_DAYS * DAY);
});

test('cross-frame: switched on in the Solana frame, on in the Robinhood frame (and the other way); a wallet added since joins on its first status read in any frame, with the grant\'s dates and no dialog', async () => {
  for (const [first, then] of [['sol', 'robinhood'], ['robinhood', 'sol']]) {
    const store = new Map(); const clock = { now: Date.UTC(2026, 9, 27, 9) };
    const wallets = [fresh('w1', 'Wallet 1')];
    const a = frame({ store, wallets, chain: first, clock });
    await a.f.configure({ ...ON, lang: 'en' });
    assert.equal(a.asks.length, 1);
    clock.now += 20 * 3_600_000;   // the next day
    wallets.push(fresh('w2', 'Wallet 2'));
    const b = frame({ store, wallets, chain: then, clock });
    const one = await b.f.status({ walletId: 'w2' });
    assert.equal(one.enabled, true, `${first} → ${then}: the new wallet is on at its first read`);
    const st = await b.f.status({ walletId: 'w1', scope: 'account' });
    assert.equal(st.enabled, true); assert.deepEqual(st.wallets.map((w) => w.enabled), [true, true]);
    assert.deepEqual(st.joined.map((j) => j.walletId), ['w2'], 'the app\'s notice names it');
    const g = JSON.parse(store.get('trenches.float.v1.account')), p2 = JSON.parse(store.get(`trenches.float.v1.perm.${lc(wallets[1].W)}`));
    assert.equal(p2.expiresAt, g.expiresAt); assert.equal(p2.grantedAt, g.grantedAt);
    assert.ok(b.events.some((e) => e.walletId === 'w2' && e.step === 'join'));
    await b.f.configure({ ...ON, lang: 'en' });
    assert.equal(b.asks.length, 0, 'no dialog in the other frame');
  }
});

test('turned off: no status read brings a wallet back in, and a switch-off waiting in another frame is never undone by a join', async () => {
  const { store, clock } = yesterday();
  const { f } = frame({ store, wallets: FIX_WALLETS, clock });
  await f.off({ walletId: 'w1', lang: 'en' });
  assert.equal(store.get('trenches.float.v1.account'), undefined);
  const st = await f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st.enabled, false); assert.deepEqual(st.wallets.map((w) => w.enabled), [false, false]);
  // the grant still live but a confirmed switch-off waiting for its chain: a status read does not join that wallet
  const s2 = new Map(Object.entries(FIX.store));
  const w2perm = `trenches.float.v1.perm.${lc(FIX_WALLETS[1].W)}`; s2.delete(w2perm);
  s2.set(`trenches.float.v1.order.off.bsc.${lc(FIX_WALLETS[1].W)}`, JSON.stringify({ kind: 'off', chain: 'bsc', max: '1000000', at: clock.now, tries: 0 }));
  await frame({ store: s2, wallets: FIX_WALLETS, clock }).f.status({ walletId: 'w2' });
  assert.equal(s2.get(w2perm), undefined);
});
