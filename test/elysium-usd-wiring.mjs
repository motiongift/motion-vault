// The wiring of USD-balance buys on Elysium in webEngine.ts (src/elysiumUsdEngine.ts): what reaches it, what it may sign, and that
// every other chain's float.ensure — and every byte of the trade core — is exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const between = (a, b) => { const i = WE.indexOf(a); assert.ok(i >= 0, a); const j = WE.indexOf(b, i); assert.ok(j > i, b); return WE.slice(i, j); };
const block = between('const elyUsd = createElyUsd({', '\n}\n');
const router = between('function floatEnsure(o: unknown): Promise<unknown> {', '\n}\n');
const ENG = readFileSync(new URL('../src/elysiumUsdEngine.ts', import.meta.url), 'utf8');

test('only { chain: "elysium" } reaches it (a click only in the Elysium frame); every other ensure is float.ensure as before', () => {
  assert.match(WE, /ensure: \(o: unknown\) => floatEnsure\(o\), sweep: float\.sweep,/);
  assert.match(router, /if \(!\(o && typeof o === 'object' && \(o as \{ chain\?: unknown \}\)\.chain === 'elysium'\)\) return float\.ensure\(o\);/);
  assert.ok(router.includes("if (NEAR_MODE || ((o as { reason?: unknown }).reason === 'click' && (CFG.key !== 'elysium' || SOL_MODE))) return Promise.reject("), 'a click only in the Elysium frame; never NEAR');
  assert.ok(router.indexOf('return float.ensure(o)') < router.indexOf('elyUsd.ensure(o)'), 'the other chains first, untouched');
});

test('what it may sign: the reserve\'s ONE transfer to the solver through the same signers every cold top-up uses; the solver key pinned', () => {
  assert.match(block, /signEvmTransfer: bridgeSignEvmTransfer as never, signSolTransfer: bridgeSignSolTransfer as never, release: bridgeRelease as never/);
  assert.match(block, /pinnedKey: \(\) => MOTION_SOLVER_KEY/);
  assert.doesNotMatch(block, /signAndSend|broadcast\(|sendRawTransaction|walletFor\(/, 'never W\'s trade lane, never a broadcast from the vault');
  assert.match(block, /permission: \(id\) => float\.liveFor\(id\)/, 'only while the USD-balance permission is live');
  assert.match(block, /wallet: \(id\) => \{ const a = floatAccount\(id\); const r = reserveOf\(a\);/, 'the vault\'s own wallets only (no Privy / hop / chain-only key)');
  assert.match(block, /price6: \(\) => elysiumPrice6\(elysiumOraclePc\(\), 'elysium'\)/, 'OUR price: the official HyperEVM node, the WHYPE\/USDC pool');
  assert.match(ENG, /recipient: w\.w, oracle6: rd\.price6, maxSlipBps: ELY_USD\.maxSlipBps/, 'the recipient is W itself');
  assert.doesNotMatch(ENG, /recipient: (?!w\.w)/, 'no other recipient');
  assert.ok(ENG.indexOf('saveJob(w, job);   // BEFORE the signature') < ENG.indexOf('deps.bridge.fill('), 'the job is written before the signature');
});

test('(rel-8) donors: the account\'s own vault wallets only, each behind its LIVE permission; the same signers; Earn read only', () => {
  // the list: this vault's unlocked wallets that can hold a USD balance (the float switch's own filter), ids only
  assert.match(block, /wallets: \(\) => requireUnlocked\(\)\.filter\(\(a\) => !a\.archived && !a\.hop && !a\.ext && !nativeChainOf\(a\.key\) && \/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(a\.key\)\)\.map\(\(a\) => a\.id\),/);
  // every donor goes through the same wallet() (floatAccount + reserveOf: its reserve derived from its own key) and permission()
  assert.equal(block.split('permission: (id) => float.liveFor(id)').length - 1, 1);
  assert.match(ENG, /const p = deps\.permission\(d\.id\); if \(!p\) continue;/, 'a donor only with a live permission');
  assert.match(ENG, /if \(p\.chains\.includes\(c\) && owner/, '... and only on that permission\'s chains');
  assert.match(ENG, /const dp = .*deps\.permission\(pw\.id\)/, 'asked again right before the move');
  // the signers are the ones every cold top-up uses: they derive R from the walletId handed to bridge.fill (the donor's)
  const evmSigner = between('async function bridgeSignEvmTransfer(a: { walletId: string;', 'return laneLock(');
  assert.match(evmSigner, /const r = reserveOf\(floatAccount\(a\.walletId\)\); const account = privateKeyToAccount\(r\.key\);/);
  assert.match(evmSigner, /return bridgeSignEvmTransferOn\(a\);/);
  assert.match(between('async function bridgeSignEvmTransferOn(a: { walletId: string;', 'return laneLock('), /const r = reserveOf\(floatAccount\(a\.walletId\)\); const account = privateKeyToAccount\(r\.key\);/);
  assert.match(WE, /async function bridgeSignSolTransfer\(a: \{ walletId: string;[^]*?const \{ r \} = solAcctsOf\(a\.walletId\);/);
  // Earn: a cached read for the refusal's text; nothing of Earn is called that signs
  const earnPart = between('  earnReady: (id, c) => {', '\n  },\n');
  assert.match(earnPart, /earn\.status\(ew, c\)/); assert.doesNotMatch(earnPart, /beforeClick|withdraw|send|sign/);
  // locks: W's (withWallet) and the paying reserve's (move)
  assert.match(ENG, /deps\.lock\('ely-usd:' \+ w\.w\.toLowerCase\(\)/); assert.match(ENG, /deps\.lock\('ely-usd-r:' \+ plan\.from \+ ':' \+ payer\.toLowerCase\(\)/);
});
