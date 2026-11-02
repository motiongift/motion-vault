// The USD-balance dialogs in the app's six languages (owner 2026-10-26: "translate it into every language, not only ru")
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/floatCore.ts';

const LANGS = ['en', 'ru', 'zh', 'id', 'es', 'fr'];
const caps = F.DEFAULT_CAPS;

test('langOf keeps every app language and falls back to English', () => {
  for (const l of LANGS) assert.equal(F.langOf(l), l);
  assert.equal(F.langOf('de'), 'en'); assert.equal(F.langOf(undefined), 'en');
});

test('every language has its own titles, consent, table words and details label — none falls back to English', () => {
  const ws = [{ name: 'Wallet 1', plan: { lines: [{ chain: 'robinhood', nativeIn: 674_300_000_000_000_000n, usd6: 1_563_000_000n }], skips: [{ chain: 'sol', why: 'stale-price' }] } },
    { name: 'Wallet 3', plan: { lines: [], skips: [{ chain: 'robinhood', why: 'below-min' }] } }];
  const back = [{ name: 'Wallet 1', plan: { lines: [{ chain: 'robinhood', usd6: 1_563_000_000n, stableIn: 1_563_000_000n }], skips: [] }, unread: ['sol'] }];
  const en = { t: F.ACCOUNT_DIALOG.en, p: F.accountPermissionText(['Wallet 1', 'Wallet 3'], ['robinhood', 'bsc', 'sol'], caps, 80_000n, 'en'), v: F.accountConvertView(ws, [{ name: 'Privy', why: 'privy' }], ['robinhood', 'bsc', 'sol'], 'en'), o: F.accountOffView(back, 50, 'en') };
  for (const l of LANGS) {
    const t = F.ACCOUNT_DIALOG[l]; assert.ok(t && t.onTitle && t.onOk && t.offTitle && t.offOk, l);
    assert.ok(F.ACCOUNT_MORE[l], l);
    const p = F.accountPermissionText(['Wallet 1', 'Wallet 3'], ['robinhood', 'bsc', 'sol'], caps, 80_000n, l);
    const v = F.accountConvertView(ws, [{ name: 'Privy', why: 'privy' }], ['robinhood', 'bsc', 'sol'], l);
    const o = F.accountOffView(back, 50, l);
    assert.ok(p.includes('$0.10') && p.includes('$1,000') && p.includes('25 %') && p.includes('$0.20') && p.includes('Wallet 1'), `${l}: the rules and the names are in the consent`);
    assert.ok(!p.includes('$1,000.00') && !p.includes('$250.00') && !p.includes('$2.00'), `${l}: no volume cap is stated`);
    assert.ok(v.lead.includes('$1,563'), `${l}: the total`); assert.equal(v.rows.length, 1); assert.ok(v.skip.includes('Wallet 3') && v.skip.includes('Privy'), `${l}: the skips`);
    assert.ok(o.lead.includes('$1,563'), `${l}: the off total`);
    if (l !== 'en') {
      assert.notEqual(t.onTitle, en.t.onTitle, `${l}: own title`); assert.notEqual(p, en.p, `${l}: own consent`);
      assert.notEqual(v.lead, en.v.lead, `${l}: own lead`); assert.notEqual(v.note, en.v.note, `${l}: own note`); assert.notEqual(o.note, en.o.note, `${l}: own off note`);
    }
  }
});
