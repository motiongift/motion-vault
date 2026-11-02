// USD balance — static guards (USDC-BALANCE.md §4 / §13): the trade path never reaches the float, the float has its own
// read client and budget, and no key ever reaches the float module. Read from the source, so a refactor that breaks a
// rule fails here before any harness run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLOAT_METHODS } from '../src/floatCore.ts';

const src = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const WE = src('webEngine.ts'), SOL = src('solEngine.ts'), FE = src('floatEngine.ts'), FC = src('floatCore.ts');
// a top-level function's text: from its header to the first line that is exactly "}"
const fnText = (text, header) => { const i = text.indexOf(header); assert.ok(i >= 0, header); const j = text.indexOf('\n}\n', i); return text.slice(i, j); };
// the float's own code in webEngine — minus the EVM buy from the reserve (2026-10-29): a CLICK of its own (engine.float.buy →
// clickRun), which signs on the trade's client and send path on purpose, like every buy
const blockAll = WE.slice(WE.indexOf('// ── one USD balance (src/floatEngine.ts) ──'), WE.indexOf('const engine = {\n  version: 2,'));
const EVM_BUY = [blockAll.indexOf('// ── the same on Robinhood / BNB (src/usdBuyEvm.ts) ──'), blockAll.indexOf('// the ready float after a trade (floatEngine afterTrade)')];
const block = EVM_BUY[0] > 0 && EVM_BUY[1] > EVM_BUY[0] ? blockAll.slice(0, EVM_BUY[0]) + blockAll.slice(EVM_BUY[1]) : blockAll;

test('I1: no trade entry point imports, calls or awaits the float', () => {
  for (const h of ['async function trade(', 'async function tradeGuard<T>(', 'async function signAndSend(', 'async function broadcast(', 'async function feeFloor(']) {
    const body = fnText(WE, h);
    assert.ok(!/float|Float/.test(body), `${h} mentions the float`);
  }
  for (const h of ['async function tradeOne(', 'export async function sendPlan(']) assert.ok(!/float|Float/.test(fnText(SOL, h)), h);
  // buy / sell only stamp the click clock: one synchronous wrapper, no await, no network
  const run = WE.slice(WE.indexOf('const clickRun = '), WE.indexOf('const floatLane = '));
  assert.ok(!/await|fetch|float\.|floatRpc|localStorage/.test(run), 'clickRun does more than stamp the clock');
  assert.match(WE, /buy: \(token: string, amount: number, accountIds\?: string\[\], hint\?: unknown, opts\?: unknown\) => clickRun\(\(\) => trade\('buy', token, amount, accountIds, hint, opts\)\),/);
  assert.match(WE, /sell: \(token: string, percent: number, accountIds\?: string\[\], hint\?: unknown, opts\?: unknown\) => clickRun\(\(\) => trade\('sell', token, percent, accountIds, hint, opts\)\),/);
  // the prewarm stamp is plain assignments
  const pw = WE.slice(WE.indexOf('  prewarm: async (token: string, hint?: unknown) => {'), WE.indexOf('  prewarm: async (token: string, hint?: unknown) => {') + 400);
  assert.match(pw, /floatClock\.focusAt = Date\.now\(\); floatClock\.ticketAt = floatClock\.focusAt; floatClock\.focusChain = floatLane\(\);/);
});

test('I2: the float reads through its own client (never the trade\'s first node) behind a 1 request/s bucket', () => {
  assert.ok(block.length > 1000);
  assert.ok(!/publicClient\.|heavy\.|heavyFor\(|nonceSheet|nextNonce\(/.test(block.replace(/sendW: async[^\n]*\n/, '')), 'the float block uses a trade client');
  assert.match(block, /const floatUrls = \(\) => \{ const u = readUrls\(\); const rest = u\.slice\(1\);/);
  assert.match(block, /const floatBucket = floatBucketOf\(1, 3, \(\) => Date\.now\(\)\);/);
  // every EVM read of the float goes through floatRpc
  const evm = block.slice(block.indexOf('  evm: {'), block.indexOf('  sol: {'));
  for (const line of evm.split('\n').filter((l) => /^\s{4}(call|balance|erc20|allowance|slot0|estimate):/.test(l))) assert.match(line, /floatRpc\(/, line);
  assert.match(evm, /const r = await floatRpc\(\(pc\) => pc\.getTransactionReceipt\(\{ hash \}\)\)/);
  // I3 at the source: no float request leaves while a trade runs (call → broadcast + 2 s)
  assert.match(block, /const tradeRunning = \(\) => clicksRunning > 0 \|\| Date\.now\(\) - floatClock\.clickDoneAt < 2_000;/);
  assert.match(fnText(WE, 'async function floatRpc<T>('), /while \(tradeRunning\(\)\) await floatWait\(100\);[\s\S]*floatBucket\.take\(\)[\s\S]*while \(tradeRunning\(\)\) await floatWait\(100\);\n  return fn\(floatPc\(\)\);/);
  // R's sends: its own lane, its own nonce read, the float's nodes
  const sendR = fnText(WE, 'async function floatSendR(');
  assert.match(sendR, /laneLock\(account\.address/); assert.match(sendR, /floatRpc\(\(pc\) => pc\.getTransactionCount/); assert.match(sendR, /floatRpc\(\(pc\) => pc\.request\(\{ method: 'eth_sendRawTransaction'/);
  assert.ok(!/broadcast\(/.test(sendR));
});

test('I3 for the steps without a client of their own: every Solana dep and W\'s sends pass the source gate; the Solana helpers share no trade batch or cache', () => {
  const sol = block.slice(block.indexOf('  sol: {'), block.indexOf('  ask: (o) => ask(o),'));
  const solDeps = sol.split('\n').filter((l) => /^\s{4}(balance|usdc|oracle6|quote|topup|sweep|gas|status|forward|fundW):/.test(l));
  assert.equal(solDeps.length, 10, 'every Solana dep is checked');
  for (const line of solDeps) assert.match(line, /floatQuiet\(/, line);
  assert.match(fnText(WE, 'async function floatQuiet<T>('), /while \(tradeRunning\(\)\) await floatWait\(100\);[\s\S]*floatBucket\.take\(\)[\s\S]*while \(tradeRunning\(\)\) await floatWait\(100\);\n  return fn\(\);/);
  const sendW = fnText(WE, 'async function floatSendW(');
  assert.match(sendW, /return floatQuiet\(\(\) => signAndSend\(client, account, tx, price, gas\)\);/);
  assert.ok(!/feeFor\(|feeFloor\(|publicClient/.test(sendW), 'W\'s float send reads through a trade client');
  // the appended Solana block: beside the trade code, its own reads (no readBatch / market memo), its own blockhash read
  // (up to the USD buy from the reserve, appended after it: a click's own trade, which uses the trade's send path on purpose)
  const direct = SOL.indexOf('// ── USD balance: the buy straight from the reserve');
  const tail = SOL.slice(SOL.indexOf('// ── USD balance (src/floatEngine.ts;'), direct > 0 ? direct : undefined);
  assert.ok(tail.length > 1000 && tail.length < 6000);
  assert.ok(!/readBatch\(|readMarket\(|marketMemo|dlmmPoolsOf\(|blockhash\(|bhCache/.test(tail), 'a float helper shares a trade read path');
  const head = SOL.slice(0, SOL.indexOf('// ── USD balance (src/floatEngine.ts;'));
  assert.ok(!/solFloat|floatLbPair|floatMarket/.test(head), 'trade code reaches a float helper');
});

test('I3/I4: every network step of a move checks the click window; the float only ever adds to W', () => {
  assert.match(FE, /if \(\(refill \? tradeLive\(\) : clickBusy\(\)\) && !\(urgent && urgent\.chain === c\)\) return \{ ok: true, jobId: null, planned: \[\], deferred: 'click' \};/);
  // the after-trade refill (2026-10-29) is a background tick of its own reason only, held back by a trade being signed
  assert.match(FE, /const refill = !urgent && reason === 'refill';/);
  assert.match(FE, /const tradeLive = \(\) => \{ const t = deps\.click\(\); return t\.clickAt > t\.clickDoneAt; \};/);
  for (const fn of ['runEvmSame', 'runSolSame', 'runBridge']) assert.match(fnText(FE.replace(/\n  \}\n/g, '\n}\n'), `  async function ${fn}(`), /stepCheck\(job\)/, fn);
  // a click's own move skips only the focus window and the tail: a trade between its call and its broadcast still holds it
  assert.match(FE, /async function stepCheck\(job\?: FloatJob\) \{ const t = deps\.click\(\); if \(job\?\.click \|\| job\?\.refill \? t\.clickAt > t\.clickDoneAt : clickBusy\(\)\) throw new FloatRefused\('deferred: a trade is running'\); \}/);
  // W sends only the sweep (to R), R's gas (to R) and stable sent to W, forwarded to R (2026-10-27)
  const sends = [...FE.matchAll(/e\.sendW\(w\.id, ([^\n]+)/g)].map((m) => m[1]);
  assert.equal(sends.length, 3);
  assert.ok(sends.some((x) => /to: w\.r\.evm/.test(x)), 'gas goes to R');
  assert.match(FE, /sweepCalldata\(cfg, amountIn, minOut, w\.r\.evm, deadline\)/);
  assert.ok(sends.some((x) => /to: cfg\.stable\.address as `0x\$\{string\}`, data: erc20TransferData\(w\.r\.evm, amount\)/.test(x)), 'the stable forward pays R only');
});

test('motion\'s bridge: the vault signs one transfer and broadcasts nothing; its two reads skip the bucket, never the trade gate', () => {
  const sign = fnText(WE, 'async function bridgeSignEvmTransfer(');
  // one ERC-20 transfer of the asked amount, from R's lane, with the gas and price it checked — and no send
  assert.match(sign, /laneLock\(account\.address/);
  assert.match(sign, /bridgeTransferData\(a\.to, a\.amount\)/);
  assert.match(sign, /bridgeHeldNonce\.set\(account\.address\.toLowerCase\(\), \{ nonce, at: Date\.now\(\), hash \}\);/);
  // 2026-10-28: a transfer the solver says it never broadcast (sent:false) frees its nonce — only that transfer's, by hash
  assert.match(WE, /function bridgeRelease\(a: \{ chain: string; hash: string \}\): void \{\n  const h = String\(a\.hash \|\| ''\)\.toLowerCase\(\); if \(!h\) return;\n  for \(const \[k, v\] of bridgeHeldNonce\) if \(v\.hash && v\.hash\.toLowerCase\(\) === h\) bridgeHeldNonce\.delete\(k\);\n\}/);
  assert.match(WE, /release: bridgeRelease as never,/);
  assert.ok(!/sendRawTransaction|signAndSend\(|broadcast\(|e\.send/.test(sign), 'the vault must not broadcast its bridge transfer');
  assert.ok(!/publicClient|heavyFor\(|nextNonce\(/.test(sign), 'it reads through the float\'s own client');
  const solSign = fnText(WE, 'async function bridgeSignSolTransfer(');
  assert.match(solSign, /bridgeQuiet\(/);
  assert.ok(!/solFloatSend|sendSigned|solSendSigned/.test(solSign), 'the vault must not broadcast its Solana transfer');
  // its instructions come from the one pure builder (bridgeSolver.ts solBridgeTransferIxs): the memo, one transferChecked, a budget
  assert.match(solSign, /solBridgeTransferIxs\(\{ owner: r\.address,/);
  assert.match(src('bridgeSolver.ts'), /ix\(SOL_PROGRAMS\.memo, \[\[a\.owner, true, true\]\]/);
  // the bucket is skipped, the trade window is not
  for (const h of ['async function bridgeRpc<T>(', 'async function bridgeQuiet<T>(']) {
    const body = fnText(WE, h);
    assert.match(body, /while \(tradeRunning\(\)\) await floatWait\(100\);/, h);
    assert.ok(!/floatBucket/.test(body), h + ' must not sit behind the background bucket');
  }
  // R's own next send goes after a nonce the bridge signer is still holding
  const sendR = fnText(WE, 'async function floatSendR(');
  assert.match(sendR, /const heldR = bridgeHeldNonce\.get\(account\.address\.toLowerCase\(\)\);/);
  assert.match(sendR, /heldR\.nonce \+ 1 : chainNonce;/);
  // and the solver client the float gets carries only a PUBLIC key
  assert.match(block, /pinnedKey: \(\) => MOTION_SOLVER_KEY,/);
  assert.ok(!/MOTION_SOLVER_KEY = '0x/.test(WE));
});

test('no key reaches the float module; R is derived in webEngine and never stored', () => {
  assert.ok(!/privateKey|reserveKeyOf|signTransaction|\.key\b/.test(FE), 'floatEngine sees a key');
  assert.ok(!/localStorage|window\.|document\./.test(FE), 'floatEngine touches the page');
  assert.ok(!/fetch\(/.test(FC) && !/localStorage/.test(FC), 'floatCore is not pure');
  const reserve = block.slice(block.indexOf('const reserveOf = '), block.indexOf('const floatAccount = '));
  assert.ok(!/persist|localStorage|post\(|emit/.test(reserve));
  // the wallet handed to the float has addresses only
  assert.match(block, /wallet: \(id\) => \{ const a = floatAccount\(id\); const r = reserveOf\(a\); return \{ id: a\.id, name: a\.name, w: \{ evm: a\.address, sol: solAddressOf\(a\) \}, r: \{ evm: r\.evm, sol: r\.sol \} \}; \},/);
});

test('the frame surface: float.<method> for exactly the documented methods, its event forwarded, its rows in policy()', () => {
  const row = WE.match(/  float: \{ ([^}]+) \},\n/)[1];
  // + buy (2026-10-29): the buy straight from the reserve — a click of its own (clickRun), never a float move
  assert.deepEqual(row.split(', ').map((x) => x.split(':')[0]).sort(), [...FLOAT_METHODS, 'buy'].sort());
  assert.match(row, /buy: \(o: unknown\) => clickRun\(\(\) => usdBuy\(o\)\)$/);
  for (const h of ['async function trade(', 'async function tradeInner(']) assert.ok(!/usdBuy|solDirect/.test(fnText(WE, h)), h + ' reaches the buy from the reserve');
  assert.match(WE, /path\[0\] === 'float' \? engine\.float/);
  assert.match(WE, /'trench:perps', 'trench:float'\]\) document\.addEventListener/);
  for (const m of ['float.configure', 'float.ensure', 'float.sweep', 'float.off', 'float.buy']) assert.ok(WE.includes(`method: '${m}'`), m);
});

test('the click path (2026-10-26): the dialogs\' reads skip the bucket, never the trade gate; only they use it; background reads keep the bucket', () => {
  for (const h of ['async function floatNow<T>(', 'async function floatNowQuiet<T>(']) {
    const body = fnText(WE, h);
    assert.match(body, /return afterTrade\(tradeRunning, floatWait, /, h + ' must wait out a running trade');
    assert.ok(!/floatBucket/.test(body), h + ' must not sit behind the background bucket');
  }
  for (const h of ['async function floatSheetEvm(', 'async function floatSheetSol(']) {
    const body = fnText(WE, h);
    assert.match(body, /floatNow(Quiet)?\(/, h);
    assert.ok(!/floatRpc\(|floatQuiet\(|floatBucket|publicClient|heavyFor\(/.test(body), h + ' reads through the bucket or a trade client');
  }
  // the sheets read only: no signature, no send
  assert.ok(!/sign|sendRaw|broadcast/i.test(fnText(WE, 'async function floatSheetEvm(') + fnText(WE, 'async function floatSheetSol(')));
  const fast = block.slice(block.indexOf('  fast: {'), block.indexOf('});', block.indexOf('  fast: {')));
  assert.match(fast, /evm: \{ sheet: floatSheetEvm, fees: \(\) => floatFees\(floatNow\) \}/);
  assert.match(fast, /sol: \{ sheet: floatSheetSol, oracle6: \(\) => floatNowQuiet\(\(\) => solFloatPrice6\(SOL_ORACLE_POOL, FLOAT_CFG\.sol\.stable\.address\)\) \}/);
  // the gas read defaults to the bucket (every background caller), the click path passes floatNow explicitly
  assert.match(block, /const floatFees = async \(rpc: typeof floatRpc = floatRpc\) => \{/);
  assert.match(block, /const fees = await floatFees\(\); const floor =/);
  // floatEngine: deps.fast only in the click-path read, which only the dialogs and status `fresh` call
  const code = FE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal([...code.matchAll(/deps\.fast/g)].length, 1); assert.match(code, /const cfg = cfgOf\(c\); const f = deps\.fast;/);
  const callers = FE.split('\n').filter((l) => /\breadNow\(/.test(l) && !/function readNow\(/.test(l)).map((l) => l.trim());
  assert.equal(callers.length, 3, callers.join('\n'));
  assert.ok(callers.every((l) => /^await readNow\(list, c, 15_000\)/.test(l) || /a\.fresh === true/.test(l)), callers.join('\n'));
  assert.ok(!/readNow\(/.test(fnText(FE.replace(/\n  \}\n/g, '\n}\n'), '  async function tick(')), 'a tick reads through the click path');
});

test('the USD dialog\'s rules come with the engine through the CSSOM (the pinned page and its style-src \'self\' untouched)', () => {
  const css = fnText(WE, 'function dialogCss(');
  assert.match(css, /new CSSStyleSheet\(\); s\.replaceSync\(FLOAT_DLG_RULES\.join/);
  assert.match(css, /document\.adoptedStyleSheets = \[\.\.\.document\.adoptedStyleSheets, s\]/);
  assert.match(css, /sh\.insertRule\(r, sh\.cssRules\.length\)/);
  assert.ok(!/createElement\(|innerHTML|setAttribute\('style'/.test(css));
  assert.match(WE, /\ndialogCss\(\);\n/);
});

test('Solana forward of W\'s USDC (2026-10-27): only the pinned USDC mint, only to this wallet\'s own R; R pays only W, capped; outside the trade core', async () => {
  const sol = block.slice(block.indexOf('  sol: {'), block.indexOf('  ask: (o) => ask(o),'));
  const fwd = sol.split('\n').find((l) => /^\s{4}forward:/.test(l)), fund = sol.split('\n').find((l) => /^\s{4}fundW:/.test(l));
  // R is derived from the wallet id in webEngine (never an argument); the mint and its decimals are the pinned config's
  assert.match(fwd, /^ {4}forward: \(walletId, units\) => floatQuiet\(\(\) => \{ const \{ w, r \} = solAcctsOf\(walletId\); if \(units <= 0n\) throw new Error\('Nothing to forward'\); return solFloatSend\(w, solFloatTokenPayIxs\(w\.address, FLOAT_CFG\.sol\.stable\.address, r\.address, units, FLOAT_CFG\.sol\.stable\.decimals\), SOL_FWD\.units, SOL_FWD\.micro\); \}\),$/);
  assert.match(fund, /^ {4}fundW: \(walletId, lamports\) => floatQuiet\(\(\) => \{ const \{ w, r \} = solAcctsOf\(walletId\); if \(lamports <= 0n \|\| lamports > SOL_FWD\.fundMax\) throw new Error\('Refusing: abnormal funding'\); return solFloatSend\(r, \[solFloatPayIx\(r\.address, w\.address, lamports\)\], SOL_FWD\.fundUnits, SOL_FWD\.fundMicro\); \}\),$/);
  // the pinned mint is USDC on the classic token program (the instructions below use P.token)
  const { FLOAT_CFG, SOL_FWD } = await import('../src/floatCore.ts');
  assert.equal(FLOAT_CFG.sol.stable.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); assert.equal(FLOAT_CFG.sol.stable.decimals, 6);
  assert.ok(SOL_FWD.fundMax <= 3_000_000n, 'R never pays W more than 0.003 SOL for a forward');
  // the instructions the forward signs (the frozen solEngine helper the sweep already uses, called, not changed): R's account
  // created if missing (idempotent, W pays), then ONE transferChecked of the mint from W's own account to R's, signed by W
  const { solFloatTokenPayIxs, ataOf, P } = await import('../src/solEngine.ts');
  const W = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', R = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', mint = FLOAT_CFG.sol.stable.address;
  const ixs = solFloatTokenPayIxs(W, mint, R, 50_000_000n, 6);
  assert.equal(ixs.length, 2);
  assert.equal(ixs[0].program, P.ata); assert.deepEqual([...ixs[0].data], [1], 'CreateIdempotent');
  assert.deepEqual(ixs[0].keys.map((k) => k.pubkey), [W, ataOf(R, mint, P.token), R, mint, P.system, P.token]);
  assert.equal(ixs[1].program, P.token); assert.equal(ixs[1].data[0], 12, 'transferChecked');
  assert.deepEqual(ixs[1].keys.map((k) => [k.pubkey, k.signer, k.writable]), [[ataOf(W, mint, P.token), false, true], [mint, false, false], [ataOf(R, mint, P.token), false, true], [W, true, false]]);
  assert.equal(new DataView(ixs[1].data.buffer, ixs[1].data.byteOffset + 1, 8).getBigUint64(0, true), 50_000_000n); assert.equal(ixs[1].data[9], 6);
  assert.equal(ixs.flatMap((i) => i.keys).filter((k) => k.signer).every((k) => k.pubkey === W), true, 'W is the only signer');
  // floatEngine never sees a mint, an address to pay or a key for it: units and lamports only
  assert.match(FE, /forward\?: \(walletId: string, units: bigint\) => Promise<string>;/);
  assert.match(FE, /fundW\?: \(walletId: string, lamports: bigint\) => Promise<string>;/);
  // and the frozen Solana engine was not touched for it
  assert.ok(!/forward|fundW|SOL_FWD/.test(SOL), 'solEngine.ts must stay byte-for-byte frozen');
});
