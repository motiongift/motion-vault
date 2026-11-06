// (2026-11-03) "Add HYPE / USDC on Elysium" from a trading wallet, through motion's bridge (trench docs: B:\tmp\elysium-funding).
// What the vault may do on this path, pinned at the source: the recipient is the paying wallet's OWN address (no parameter can
// name another), the quote is checked against the pinned solver key and OUR prices before the dialog, the dialog says what leaves,
// what arrives where and the 6-day way back, and the only bytes signed are ONE plain transfer (native or the chain's stablecoin)
// to the solver's published deposit address, in the wallet's send lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quoteProblem, bridgeCfg, NATIVE_TOKEN, NATIVE_SOL_TOKEN, evmSourceProblem, solSourceProblem, USD6 } from '../src/motionBridgeCore.ts';
import { exitCall, exitProblem, ELY_EXIT, EXIT_DAYS } from '../src/elysiumExitCore.ts';
import { ed25519 } from '@noble/curves/ed25519';

const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const between = (a, b) => { const i = WE.indexOf(a); assert.ok(i >= 0, a); const j = WE.indexOf(b, i); assert.ok(j > i, b); return WE.slice(i, j); };
const action = between('  elysiumFund: async (o:', '  elysiumExit: async');
const exitAction = between('  elysiumExit: async (o:', '  elysiumFundStatus: async');
const solSigner = between('async function elysiumSignSolFromW(', '\n}\n');
const signer = between('async function elysiumSignFromW(', '\n}\n');

test('the payout goes to the paying wallet itself: depositor = recipient = W, from the unlocked vault, never a hop / Privy / chain-only key', () => {
  assert.match(action, /const src = \(SOL_MODE \? 'sol' : CFG\.key\) as 'robinhood' \| 'bsc' \| 'sol', sc = mbCfg\(src\), W = a\.address as/);
  assert.match(action, /const payer = SOL_MODE \? solAddressOf\(a\) : W;/);
  assert.match(action, /bridge\.quote\(\{ from: src, to: 'elysium', amountIn, depositor: payer, recipient: W, oracle6, maxSlipBps: 150, deposits: h\.deposits, pay, asset, srcOracle6 \}\)/);
  assert.doesNotMatch(action, /recipient: (?!W)/, 'no other recipient');
  assert.match(action, /if \(!a \|\| a\.ext \|\| a\.hop\) throw new Error\('Unknown wallet'\)/);
  assert.match(action, /nativeChainOf\(a\.key\)\) throw/);
  assert.match(action, /if \(NEAR_MODE \|\| !\(SOL_MODE \|\| CFG\.key === 'robinhood' \|\| CFG\.key === 'bsc'\)\) throw/);
});

test('our own prices: the source native from this chain\'s pool, HYPE from the HyperEVM pool; USDC at par; quote checked before the dialog', () => {
  assert.match(action, /pay !== 'native' \? Promise\.resolve\(0n\) : SOL_MODE \? solFloatPrice6\(sc\.oracle\.pool, sc\.stable\.address\) : elysiumPrice6\(publicClient as never, src as 'robinhood' \| 'bsc'\)/);
  assert.match(action, /asset === 'native' \? elysiumPrice6\(elysiumOraclePc\(\), 'elysium'\) : Promise\.resolve\(1_000_000n\)/);
  assert.ok(action.indexOf('bridge.quote(') < action.indexOf('await gate(\'transfer\', auth)'), 'quote + checks first');
  assert.ok(action.indexOf('await gate(\'transfer\', auth)') < action.indexOf('const ok = await ask('), 'gate, then the trusted dialog');
  assert.ok(action.indexOf("if (!ok) throw new Error('Cancelled')") < action.indexOf('laneLock(SOL_MODE ? payer : W'), 'nothing signed before the click');
  assert.match(action, /muted\(escHtml\(ELYSIUM_BACK\)\)/);
  assert.match(WE, /const ELYSIUM_BACK = 'Moving funds back from Elysium to HyperEVM takes about 6 days \(rollup challenge period, per Kinetiq\\'s docs\)\.';/);
  assert.match(action, /if \(o\.phase === 'quote'\) return \{ ok: true, phase: 'quote'/);
  assert.ok(action.indexOf("if (o.phase === 'quote')") < action.indexOf('await gate('), 'a price read never asks or signs');
});

test('the one signature: a plain native or stablecoin transfer, fresh nonce in W\'s lane, gas capped; the counter moves only when the bytes are out', () => {
  assert.match(signer, /const tx = native \? \{ to: a\.to as `0x\$\{string\}`, value: a\.amount, data: '0x' as `0x\$\{string\}` \}\n    : \{ to: a\.token as `0x\$\{string\}`, value: 0n, data: bridgeTransferData\(a\.to, a\.amount\) as `0x\$\{string\}` \};/);
  assert.match(signer, /nextNonce\(account\.address, true\)/);
  assert.match(signer, /if \(gas > \(native \? 100_000n : 400_000n\)\) throw/);
  assert.match(signer, /chainId: chain\.id, type: 'legacy'/);
  assert.doesNotMatch(signer, /broadcast\(|sendRawTransaction|signAndSend/, 'signed, never sent from here');
  assert.match(action, /return laneLock\(SOL_MODE \? payer : W, async \(\) => \{/);
  assert.match(action, /if \(held\.nonce !== undefined && !SOL_MODE\) noteNonceUsed\(W, held\.nonce\);/);
  assert.match(action, /if \(e instanceof SolverRefused\) throw e;/);
  assert.match(action, /if \(!SOL_MODE\) nonces\.delete\(W\.toLowerCase\(\)\);/);
  assert.match(action, /name: 'TransferUnknown', unknown: true/);
});

test('the solver checks those exact bytes (shared core): a native source to the deposit address, nothing else', () => {
  const q = { v: 1, id: 'a'.repeat(32), src: { chain: 'robinhood', token: NATIVE_TOKEN, amount: String(10n ** 16n), depositor: '0x' + '1'.repeat(40), deposit: '0x' + '2'.repeat(40) },
    dst: { chain: 'elysium', recipient: '0x' + '1'.repeat(40), amount: '1' }, price6: '1', fee6: '0', usd6: '1', issuedAt: 1, expiresAt: 2, solver: 'b'.repeat(64) };
  const tx = { chainId: 4663, to: q.src.deposit, value: 10n ** 16n, data: '0x', gas: 30_000n };
  assert.equal(evmSourceProblem(tx, q.src.depositor, q), '');
  assert.notEqual(evmSourceProblem({ ...tx, gas: 200_000n }, q.src.depositor, q), '');
  assert.equal(bridgeCfg('elysium').payout.inbox, '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff');
  // the vault's quote check requires its own source price for a native payment
  assert.equal(quoteProblem(q, '', { pinnedSolver: 'b'.repeat(64), from: 'robinhood', to: 'elysium', amountIn: 1n, depositor: q.src.depositor, recipient: q.dst.recipient, oracle6: USD6, maxSlipBps: 100, maxFill6: USD6, now: 1 }), 'the quote is not signed by motion\'s solver key');
});

// ── v3 (2026-11-04): Solana as a source; the guard's pause; the way back ──
const b58 = (b) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };
const rnd = () => Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));

test('Solana frames: W\'s own Solana key pays, W\'s EVM address receives; a paused route is refused before any price is read', () => {
  assert.match(solSigner, /const \{ w \} = solAcctsOf\(a\.walletId\);\n  const k = solKeys\(w\.key as string\);/);
  assert.match(solSigner, /a\.mint === MB_NATIVE_SOL\n    \? solBridgeNativeIxs\(\{ owner: w\.address, to: a\.to, amount: a\.amount, memo: a\.memo,/);
  assert.match(solSigner, /: solBridgeTransferIxs\(\{ owner: w\.address, src: solFloatAta\(w\.address, a\.mint\), dst: solFloatAta\(a\.to, a\.mint\)/);
  assert.doesNotMatch(solSigner, /sendTransaction|solFloatSend|broadcast/, 'signed, never sent from here');
  assert.match(action, /signSolTransfer: \(x\) => elysiumSignSolFromW\(\{ walletId: a\.id, mint: x\.mint, to: x\.to, amount: x\.amount, decimals: x\.decimals, memo: x\.memo \}\)/);
  assert.match(action, /if \(SOL_MODE && bal < \(pay === 'native' \? amountIn : 0n\) \+ 1_000_000n\) throw new SolverRefused/);
  assert.match(action, /if \(h\.elysium\?\.paused\) throw new SolverRefused\('Elysium funding is paused: '/);
  assert.ok(action.indexOf('h.elysium?.paused') < action.indexOf('const [bal, stableBal'), 'paused: refused before any read');
});

test('the native SOL bytes the vault signs (solBridgeNativeIxs, compiled + signed as webEngine does) pass the solver\'s check; tampered ones do not', async () => {
  const S = await import('../src/solEngine.ts');
  const L = await import('../src/solLimitCore.ts');
  const { solBridgeNativeIxs } = await import('../src/bridgeSolver.ts');
  const seed = rnd(), owner = S.b58e(ed25519.getPublicKey(seed)), deposit = b58(ed25519.getPublicKey(rnd()));
  const q = { v: 1, id: 'cd'.repeat(16), src: { chain: 'sol', token: NATIVE_SOL_TOKEN, amount: '500000000', depositor: owner, deposit }, dst: { chain: 'elysium', recipient: '0x' + '11'.repeat(20), amount: '1', asset: 'native' } };
  const bh = b58(rnd());
  const sign = (over = {}) => L.parseLegacyTx(S.signMessage(S.compileLegacy(owner, solBridgeNativeIxs({ owner, to: deposit, amount: 500_000_000n, memo: q.id, units: 1_000, micro: 50_000n, ...over }), bh), seed).tx);
  const ata = (o, m) => L.ataAddress(o, m, L.SP.token);
  const ok = sign();
  assert.equal(solSourceProblem(ok, q, ata), '');
  assert.ok(ed25519.verify(ok.sigs[0], ok.message, L.b58d(owner)), 'signed by W');
  assert.match(solSourceProblem(sign({ amount: 500_000_001n }), q, ata), /another amount/);
  assert.match(solSourceProblem(sign({ to: b58(ed25519.getPublicKey(rnd())) }), q, ata), /pays another account/);
  assert.match(solSourceProblem(sign({ memo: 'ef'.repeat(16) }), q, ata), /memo/);
  // a native SOL source is offered only towards Elysium (the inbox route); elsewhere the core refuses it
  assert.match(solSourceProblem(ok, { ...q, dst: { ...q.dst, chain: 'bsc' } }, ata), /not offered/);
});

test('the way back: ONE call that pays W itself on HyperEVM, checked, gated, asked, signed for Elysium, sent only through motion\'s checked relay', () => {
  assert.match(exitAction, /if \(!a \|\| a\.ext \|\| a\.hop\) throw new Error\('Unknown wallet'\)/);
  assert.match(exitAction, /const account = privateKeyToAccount\(a\.key as/);
  assert.match(exitAction, /const W = account\.address;/);
  assert.match(exitAction, /const tx = elyExitCall\(asset, W, units\);/);
  assert.doesNotMatch(exitAction, /elyExitCall\(asset, (?!W,)/, 'no other recipient');
  assert.match(exitAction, /const why = elyExitProblem\(\{ \.\.\.tx, chainId: 99901 \}, W\); if \(why\) throw/);
  assert.match(exitAction, /if \(Number\(prep\.chainId\) !== 99901\) throw/);
  assert.match(exitAction, /if \(price > 5_000_000_000n\) throw/);
  assert.match(exitAction, /if \(gas > 1_500_000n\) throw/);
  const order = ['elyExitProblem(', "await gate('transfer', auth)", 'const ok = await ask(', "if (!ok) throw new Error('Cancelled')", 'account.signTransaction(', "'/elysium/send'"];
  for (let i = 1; i < order.length; i++) assert.ok(exitAction.indexOf(order[i - 1]) < exitAction.indexOf(order[i]), order[i - 1] + ' before ' + order[i]);
  assert.match(exitAction, /chainId: 99901, type: 'legacy'/);
  assert.match(exitAction, /It can be claimed after about \$\{ELY_EXIT_DAYS\} days \(rollup challenge period, per Kinetiq's docs\); motion then claims it on HyperEVM for you, and anyone can\./);
  assert.match(exitAction, /name: 'TransferUnknown', unknown: true, hash: keccak256\(raw\)/);
  assert.doesNotMatch(exitAction, /sendRawTransaction|walletClient|broadcast\(/);
});

test('the way-back bytes (shared core): withdrawEth(W) / the gateway router to W; anything paying someone else is refused', () => {
  const W = '0x' + '1a'.repeat(20), X = '0x' + '2b'.repeat(20);
  const h = exitCall('HYPE', W, 10n ** 17n);
  assert.equal(h.to.toLowerCase(), ELY_EXIT.arbSys.toLowerCase()); assert.equal(h.value, 10n ** 17n);
  assert.equal(exitProblem({ ...h, chainId: 99901 }, W), '');
  assert.notEqual(exitProblem({ ...exitCall('HYPE', X, 10n ** 17n), chainId: 99901 }, W), '');
  assert.notEqual(exitProblem({ ...h, chainId: 999 }, W), '');
  const u = exitCall('USDC', W, 5_000_000n);
  assert.equal(u.to.toLowerCase(), ELY_EXIT.l2Router.toLowerCase()); assert.equal(u.value, 0n);
  assert.equal(exitProblem({ ...u, chainId: 99901 }, W), '');
  assert.notEqual(exitProblem({ ...exitCall('USDC', X, 5_000_000n), chainId: 99901 }, W), '');
  assert.equal(EXIT_DAYS, 6);
});

test('review fixes in the vault: USDC only when motion offers it, plain wallets only, the official HyperEVM node only, the upgrade risk stated', () => {
  assert.match(action, /if \(asset === 'stable' && !\(h\.elysium\?\.assets \|\| \[\]\)\.includes\('stable'\)\) throw new SolverRefused/);
  assert.match(action, /const code = await elysiumOraclePc\(\)\.getCode\(\{ address: W \}\)\.catch\(\(\) => null\);/);
  assert.match(action, /if \(code && code !== '0x'\) throw new SolverRefused/);
  assert.ok(action.indexOf('getCode({ address: W })') < action.indexOf('bridge.quote('), 'checked before the quote');
  assert.match(WE, /const ELYSIUM_HYPEREVM_RPCS = \['https:\/\/rpc\.hyperliquid\.xyz\/evm'\];/);
  assert.doesNotMatch(WE, /purroofgroup/);
  assert.match(action, /\$\{muted\(escHtml\(ELYSIUM_BACK\)\)\}\$\{muted\(escHtml\(ELYSIUM_RISK\)\)\}/);
  assert.match(exitAction, /\$\{muted\(escHtml\(ELYSIUM_RISK\)\)\}/);
  assert.match(WE, /const ELYSIUM_RISK = 'Elysium\\'s bridge can be upgraded by Kinetiq\\'s 4-of-11 multisig without a delay\.';/);
});
