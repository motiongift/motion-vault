// trade-core-proposal NEAR-1 (native-scenarios 2026-11-04): the NEAR lane reports the same per-wallet states as the EVM and
// Solana lanes ('trench:tx' { id, address, state }) and its receipt answer carries `state`. Before it, nothing followed a NEAR
// order: the app's trade card sat on "Submitted" and the website's card under a "Preparing" strip after the swap had settled.
// Events only: what nearTradeOne signs and sends, the trade guard and its hold are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const web = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
const near = readFileSync(new URL('../src/nearEngine.ts', import.meta.url), 'utf8').replace(/\r/g, '');
// the trade branch (the preview has a NEAR branch of its own, earlier in the file)
const at = web.indexOf('await nearTradeOne(a, side, route, size, s.slippage)');
const a = web.lastIndexOf('  if (NEAR_MODE) {', at), b = web.indexOf("route: 'near-dcl'", at);
const branch = web.slice(a, b + 200);

test('the NEAR branch of tradeInner exists where the pins expect it', () => { assert.ok(a > 0 && b > a, 'NEAR branch found'); });
test('NEAR: preparing for every target, not_started when the route fails, with the click id', () => {
  assert.ok(branch.includes("const id = clickId(opts); const nearOf = (a: Account) => nearAccountId(a) || a.address;"));
  assert.ok(branch.includes("for (const a of targets) txEvent({ id, address: nearOf(a), state: 'preparing' });"));
  assert.ok(branch.includes("catch (e) { const error = shortError(e); for (const a of targets) txEvent({ id, address: nearOf(a), state: 'not_started', error }); throw e; }"));
});
test('NEAR: submitted with the hash, refused / unknown with the reason, the guard\'s busy answer too', () => {
  assert.ok(branch.includes("txEvent({ id, address, state: 'submitted', hash });"));
  assert.ok(branch.includes("txEvent({ id, address, state, error, ...(unknown ? { hash: unknown } : {}) });"));
  assert.ok(branch.includes("txEvent({ id, address, state: 'not_started', error }); return { name: a.name, address, ok: false, error, state: 'not_started' as TxState };"));
});
test('NEAR: the chain\'s verdict as confirmed / reverted, polled from the watcher (400 ms, then 1.5 s, >= 120 s like before)', () => {
  assert.match(branch, /for \(let i = 0; i < 95; i\+\+\) \{ await new Promise\(\(r\) => setTimeout\(r, i < 20 \? 400 : 1500\)\);/);
  assert.ok(branch.includes("txEvent({ id, address, state: r.status === 'success' ? 'confirmed' : 'reverted', hash,"));
  assert.ok(branch.includes('landed: nearFollow(hash, address)') && branch.includes('landed: unknown ? nearFollow(unknown, address) : null'), 'the guard still holds until the verdict');
});
test('NEAR: the answer carries id and outcome like the other lanes; nothing about the trade itself changed', () => {
  assert.ok(branch.includes("return { ok: true, id, ms: Math.round(performance.now() - t0), results, route: 'near-dcl', timing: null, outcome: sent === results.length ? 'all' : sent ? 'partial' : 'none' };"));
  assert.ok(branch.includes('const { hash } = await nearTradeOne(a, side, route, size, s.slippage);'));
  assert.ok(branch.includes("const key = `near:${side}:${lc(token)}:${address}`;"));
});
test('nearReceipt answers state (confirmed / reverted / pending) beside status', () => {
  assert.ok(near.includes("status: v.status, state: v.status === 'success' ? 'confirmed' : 'reverted',"));
  assert.ok(near.includes("status: f ? 'reverted' : 'success', state: f ? 'reverted' : 'confirmed',"));
  assert.ok(near.includes("if (watching.has(hash)) return { ok: true, pending: true, state: 'pending' };"));
});
