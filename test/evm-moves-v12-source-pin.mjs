// V12 EVM moves / duplicate-send source pins for src/webEngine.ts and src/bridgeEngine.ts.
// These assert each fix is present so a later edit that silently drops one fails CI. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const eng = readFileSync(join(here, '..', 'src', 'webEngine.ts'), 'utf8');
const bridge = readFileSync(join(here, '..', 'src', 'bridgeEngine.ts'), 'utf8');
const has = (s, t) => assert.ok(s.includes(t), `missing: ${t}`);

test('F-41: broadcast returns the local keccak hash and rejects a node that reports a different one', () => {
  has(eng, 'node returned a different transaction hash');
  has(eng, 'if (r?.result) { if (String(r.result).toLowerCase() !== local.toLowerCase())');
});

test('F-58/F-69: write-ahead signing — persist signed+raw+hash+nonce BEFORE broadcast', () => {
  has(eng, "leg.raw = raw; leg.nonce = nonce; leg.hash = keccak256(raw); leg.status = 'signed'");
  // an error after persist is unknown, never a re-signable failed
  has(eng, "leg.status = 'unknown'; leg.error = shortError(e); bumpRev(leg); saveJobs();   // F-58/F-69");
  // recovery re-broadcasts the SAME bytes, never re-signs
  has(eng, 'async function recoverLeg(job: Job, leg: Leg)');
  has(eng, 'try { await broadcast(leg.raw!); } catch {}');
});

test('F-69/settleLeg: dropped only when two default nodes both prove nonce-passed AND not-found', () => {
  has(eng, 'async function provenDropped(leg: Leg)');
  has(eng, 'votes.filter((v) => v.higher === true && v.notFound === true).length >= 2');
  has(eng, 'const urls = DEFAULT_RPCS.filter(isRpcUrl);');
  has(eng, 'if (await provenDropped(leg)) { leg.status = ');
});

test('F-22: write-ahead signing runs under a cross-tab lane Web Lock', () => {
  has(eng, "'trench-lane-' + lc(address)");
  has(eng, 'await laneLock(leg.from, async () => {');
});

test('F-35: runner fencing — epoch + isRunner cleared on lock loss, signing gated on mayDrive', () => {
  has(eng, 'const mayDrive = () => isRunner && epochOk();');
  has(eng, 'bumpEpoch();');
  has(eng, 'if (!mayDrive()) { running.delete(leg.id); return; }');
  has(eng, '.catch(() => { takingOver = false; isRunner = false; });');
  has(eng, '.catch(() => { isRunner = false; });   // F-35: lock lost/stolen → stop driving');
});

test('F-63: per-leg rev, non-runners never write, saveJobs merges by rev', () => {
  has(eng, 'const bumpRev = (l: Leg) => { l.rev = (l.rev || 0) + 1; };');
  has(eng, 'if (!mayDrive()) return;                     // non-runners (and a fenced ex-runner) never write');
  has(eng, 'if (dl && (dl.rev || 0) > (leg.rev || 0)) Object.assign(leg, dl);');
  has(eng, 'Another tab is handling transfers right now — try again in a moment');
});

test('F-32: cancelled moves never resume an outside transfer without reconfirmation', () => {
  has(eng, 'This move was cancelled — plan it again to send');
  has(eng, "if (l.error === 'cancelled') continue;");                 // retryJob skips hand-cancelled legs
  has(eng, 'confirmedJobs.delete(id);');                              // cancelJob drops the confirmation
  has(eng, 'if (outside.length) await confirmOutside({ legs: requeue, asset: job.asset, hops: job.hops }');  // move.retry re-confirms
});

test('F-61/F-42: once() runs under a cross-tab idem Web Lock; unknown→sending, preSend→delete', () => {
  has(eng, "lk.request('trench-idem-' + k, body)");
  has(eng, 'if (err?.preSend === true) idemWrite(k, null);');
  has(eng, "err instanceof SolSendUnknown || err instanceof NearSendUnknown || err?.unknown === true || err?.txState === 'unknown') idemWrite(k, { f, s: 'sending'");
  has(eng, 'import { NEAR_ACCT,');
  assert.ok(eng.includes('NearSendUnknown } from \'./nearEngine\';'), 'NearSendUnknown must be imported');
});

test('F-43/F-22: trades held across tabs until receipt or 120s via a Web Lock', () => {
  has(eng, "lk.request('trench-trade-' + key, { ifAvailable: true }");
  has(eng, 'async function tradeGuard<T>(key: string');
  has(eng, 'new Promise((r) => setTimeout(r, 120_000))');
});

test('F-70: rolling one-hour buy ledger per lane, 5× cap asks', () => {
  has(eng, 'const sum = recordBuy(total);');
  has(eng, 'if (sum > buyCap() * 5)');
  has(eng, 'const BUY_WINDOW_MS = 60 * 60_000;');
});

test('F-52: a failed RPC read or nonce>0 counts as held → remove gate not bypassed', () => {
  has(eng, 'if (bal === null || bal > 0n || nonce === null || nonce > 0) held = true;');
});

test('F-12: the bridge confirmation computes the quote before the dialog and shows the amount', () => {
  has(eng, 'const bound = await ownBridgeQuote(a, quote);');
  has(eng, 'arriving on ${escHtml(dest)}');
  has(eng, '.test(String(bound.amount || ');
  // the quote is computed before the gate/dialog (F-12), not after
  assert.ok(eng.indexOf('const bound = await ownBridgeQuote(a, quote);') < eng.indexOf("await gate('withdraw', auth);\n      // the login wallet"), 'ownBridgeQuote must precede the outside dialog');
});

test('bridgeEngine F-67/F-44/F-29', () => {
  has(bridge, "throw new Error('Nothing to send');   // F-67");       // value<=0 refused before signing
  has(bridge, 'const OP_STACK = new Set([10, 8453]);');              // OP-stack L1 fee reserved for max
  has(bridge, 'functionName: \'getL1Fee\'');
  has(bridge, 'value = bal - gasCost - gasCost / 5n - l1 - l1 / 5n;');
  has(bridge, 'catch { /* omit */ }');                                // F-29: failed read omitted, not 0
});
