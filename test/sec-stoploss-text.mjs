// LIM-1 (security audit 2026-11-04, pass 1; LO-1 follow-up): the stop-loss dialog said motion's server "sends it when the price is
// reached". The vault cannot promise that: a stop-loss's floor sits under the market, so whoever holds the signed bytes can send it
// at any moment and it fills at its floor (SCOPE.md known issue 2). The dialog now says so, on both lanes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const f of ['limitEngine.ts', 'solLimitEngine.ts']) {
  test(`LIM-1: ${f} tells a stop-loss user that the server can send it at any moment`, () => {
    const src = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    const i = src.indexOf("a.kind === 'sl' ? ' A stop-loss fills at the minimum or not at all");
    assert.ok(i > 0, 'the stop-loss line of the dialog');
    assert.ok(src.slice(i, i + 400).includes('can send it at any moment, not only when the price is reached'), 'the dialog states it');
  });
}
