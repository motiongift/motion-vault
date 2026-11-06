// V13 hardening — source pins: each fix of the 2026-10-25 audit (VA-1 … VA-9) and each engine speed item is wired where
// it must be, so a later edit that silently drops one fails here. The decisions themselves are tested in
// test/v13-guards-behavior.mjs and test/v13-venues-behavior.mjs. Run:
//   node --experimental-strip-types --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8');
const eng = src('webEngine.ts'), sol = src('solEngine.ts'), bnb = src('bnbRouter.ts');
const has = (s, t) => assert.ok(s.includes(t), `missing: ${t}`);
const before = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); assert.ok(i >= 0 && j >= 0 && i < j, `${a.slice(0, 50)} must come before ${b.slice(0, 50)}`); };
const body = (s, start, end) => { const i = s.indexOf(start); assert.ok(i >= 0, `missing: ${start}`); const j = s.indexOf(end, i + start.length); return s.slice(i, j < 0 ? undefined : j); };

test('VA-1: the frame reads the route from the lane\'s own /route (not the page) and keeps it stale-while-revalidate', () => {
  // (trade-core.patch E6) + the Elysium lane's prefix; Robinhood ('') and BNB ('/bsc') read exactly the same path as before
  has(eng, "const routeApi = () => (HOST && parentOrigin ? parentOrigin : location.origin) + (CFG.key === 'bsc' ? '/bsc' : CFG.key === 'elysium' ? '/elysium' : '') + '/api';");
  has(eng, 'fetch(`${routeApi()}/token/${key}/route`');
  has(eng, 'const OWN_FRESH = 10_000, OWN_MAX = 60_000, OWN_TIMEOUT = 3_000;');
  const rf = body(eng, 'async function routeFor(token: string, hint?: unknown): Promise<Route> {', '\n}\n');
  // the vault's own copy wins over any hint; a hint is only vouched for
  before(rf, 'if (own) {', 'if (!j) {');
  before(rf, 'if (own) {', 'vouches.set(route, vouchHint(key, route));');
  has(rf, 'vouches.set(route, vouchHint(key, route));');
  // a different own route re-runs the click on it; an unreadable one only lets self-canonical routes through
  const vh = body(eng, 'function vouchHint(', '\n}\n');
  has(vh, 'if (sameRoute(own, route)) return; throw new RouteChanged(own);');
  has(vh, 'if (!selfCanonical(route as never');
});

test('VA-1: the vouch is awaited beside the on-chain check, before the first write — and a RouteChanged re-runs the wallet', () => {
  has(eng, "await Promise.all([verifyRoute(token, route), vouchFor(route)]); shared.mark('verify'");
  has(eng, 'catch (e) { if (!(e instanceof RouteChanged)) throw e; const r = rerun(e.route); used = r.route; view = r.shared; hash = await tradeOne(a, side, addr, size, used, s, view); }');
  has(eng, 'armSellPath(a, addr, used, 0, idx)');
});

test('VA-1: hookless V4 / Infinity pools are compared with the standard tiers in the quote\'s own multicall', () => {
  has(eng, "const hookless = (r: Route): boolean => (r.type === 'v4' || r.type === 'inf') && same(r.poolKey.hooks, ZERO) && (r.pair === 'native' || r.pair === 'weth');");
  has(eng, 'const cands = (inf ? infCandidates(token, WETH, CFG.infPoolManager || ZERO) : v4Candidates(token, WETH)).filter((c) => !sameKey(c.key, r.poolKey));');
  has(eng, 'await heavy.multicall({ contracts: calls as any, allowFailure: true })');
  has(eng, 'pickPool<any>({ key: r.poolKey, out: hintOuts.get(String(ref)) ?? null }');
  // V4 + Infinity, buy + sell all go through the pick; a refuse is a refusal
  assert.equal((eng.match(/await pickFor\(/g) || []).length, 4);
  assert.equal((eng.match(/if \(choice\.use === 'refuse'\) reject\(/g) || []).length, 4);
  // the buy prefetch carries the pick (the quote rides in it: no extra round trip)
  has(eng, 'if (hookless(route)) { kick(pickFor([amountIn], amountIn)); return; }');
  // a re-picked pool is never sent on the hinted pool's early gas proof
  has(eng, "picked ? null : bscEstimate('buy', bscBuyProbe(amountIn))");
  has(eng, "bscSendAfter(approvals, exec(encoded), picked ? null : early, 'the Infinity sell')");
  has(eng, 'const samePool = sameKey(pk, route.poolKey) && pair === route.pair;');
});

test('VA-1: V2 sells through unknown hops need the vault dialog; the BSC V3 tier guard fails closed', () => {
  has(eng, "title: 'Sell through an unknown asset', danger: true");
  has(eng, "reject('this V2 sell passes through an asset the vault does not know')");
  before(eng, 'const toNative = route.path.length > 0;', 'swapExactTokensForETHSupportingFeeOnTransferTokens');
  has(eng, "if (!res) reject('the PancakeSwap V3 fee tiers could not be compared for this sell — try again');");
});

test('VA-1: a click-less slippage raise above 15 % (or above the confirmed level) needs the vault dialog', () => {
  const ss = body(eng, 'settingsSet: async', 'rpcInfo: async');
  has(ss, "if ('slippage' in s) {");
  has(ss, 'if (slipNeedsClick(want, loadLimits().slipOk)) {');
  has(ss, "title: 'Raise the slippage', danger: true");
  has(ss, 'else delete s.slippage;');
  before(ss, "title: 'Raise the slippage'", 'const settings = saveSettings(s);');
  has(eng, 'if (slipNeedsClick(slip, loadLimits().slipOk)) {');
  assert.ok(!/SLIP_FREE/.test(eng), 'the old 22 % constant is gone');
});

test('VA-2: the size is validated before tradeLimits records anything, and the ledger goes through ledgerAdd', () => {
  const tr = body(eng, 'async function trade(side', '\n}\n');
  before(tr, 'const bad = tradeSizeProblem(side, n, MAX_BUY[laneKey()] ?? MAX_BUY_ETH); if (bad) throw new Error(bad);', 'await tradeLimits(side, n,');
  has(eng, 'const { entries, sum } = ledgerAdd(all[lane], Date.now(), total);');
  assert.ok(!body(eng, 'const recordBuy = (total: number): number => {', '\n};').includes('slice(-500)'), 'the slice(-500) that dropped real entries is gone');
});

test('VA-3: the bridge quote the vault signs comes from api.relay.link itself and is checked before the dialog', () => {
  const ob = body(eng, 'async function ownBridgeQuote(', '\n}\n');
  // (2026-10-29, owner “approved” to the Relay-key fix) the quote goes through relayApi.relayQuote: api.relay.link
  // keyless FIRST (unchanged), motion's keyed pass-through only when Relay refuses for want of a key, and then only with the
  // server-independent checks (pinned depository / programs, Relay's own keyless price) — test/relay-swap.mjs
  has(ob, 'const { j, source } = await relayQuote(body as never);');
  const api = readFileSync(new URL('../src/relayApi.ts', import.meta.url), 'utf8');
  const rq = api.slice(api.indexOf('export async function relayQuote('), api.indexOf('// ── independent price'));
  assert.ok(rq.indexOf("f(`${RELAY_API}/quote/v2`") >= 0 && rq.indexOf("f(`${RELAY_API}/quote/v2`") < rq.indexOf('/api/bridge/vault-quote'), 'keyless Relay first');
  assert.ok(rq.includes('if (!keyRefused(r.status, j)'), 'motion only when Relay wants a key');
  has(ob, "if (source === 'motion') {");
  assert.ok(!ob.includes('/api/bridge/quote'), 'no quote from motion\'s server any more');
  has(ob, 'appFees: BRIDGE_APP_FEE.bps > 0 ? [{ recipient: BRIDGE_APP_FEE.recipient, fee: String(BRIDGE_APP_FEE.bps) }] : []');
  has(ob, 'const bad = relayQuoteProblem(j, { user, recipient, originChainId: origin, destinationChainId: dest, amount: String(q.amount), evm });');
  // the bound quote (the one signed) is made before the gate and the dialog, as F-12 required
  before(eng, 'const bound = await ownBridgeQuote(a, quote);', "await gate('withdraw', auth);\n      // the login wallet");
});

test('VA-4: adopt() follows the import rule — all-or-nothing, every key shown, via:\'page\', nothing else from the page', () => {
  const ad = body(eng, '  adopt: async (src:', '  // The page\'s Privy wallets');
  has(ad, 'const parsed = list.map((a) => readKeyOrNull(');
  has(ad, "if (bad >= 0) throw new Error(`Wallet ${bad + 1} of the old vault is not a readable key`);");
  has(ad, "await addAccount(e.name || nextName('Imported'), e.key as `0x${string}`, { kind: 'imported', via: 'page' });");
  assert.ok(!ad.includes('adoptAccounts('), 'adopt no longer takes the page\'s hop flag / meta / settings / seeds');
  assert.ok(!ad.includes('/^0x[0-9a-fA-F]{64}$/'), 'the dialog lists every key, not only 0x ones');
});

test('VA-5: off Chromium a danger dialog asks for the frame-drawn code and a one-click dialog ignores a click under 600 ms', () => {
  has(eng, "const IO_V2 = typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;");
  has(eng, 'const code = needsChallenge(HOST, IO_V2, !!(o.danger || o.guard)) ? challengeCode(crypto.getRandomValues(new Uint8Array(2))) : \'\';');
  has(eng, "if (HOST && !IO_V2 && !dlg.querySelector('input, textarea') && tooSoon(openedAt, performance.now())) { fail('Read the dialog first, then click again.'); return; }");
  has(eng, "if (code && !challengeOk((dlg.querySelector('#dk-code') as HTMLInputElement | null)?.value, code))");
  // Chromium: hidden until the observer's first reading (no race in the first ~100 ms)
  has(eng, 'let visible = !(HOST && IO_V2), io: IntersectionObserver | null = null;');
  has(eng, 'document.body.appendChild(wrap); openedAt = performance.now();');
  // the key exports are guarded the same way
  assert.equal((eng.match(/guard: true, cancel: false, plain: true/g) || []).length, 2);
});

// the release candidate carries the fast Jupiter route (branch sol-quote-pairs) with VA-6 / VA-7 fixed there (test/jupiter-fast.mjs)
test('VA-6 / VA-7: SOL + wSOL one total; the route checked against the motion price', () => {
  assert.ok(sol.includes('const nativeBefore = g.solBefore + (g.wsolLamportsBefore ?? 0n), nativeAfter = g.solAfter + (g.wsolLamportsAfter ?? 0n);'), 'VA-6');
  // (token2022-fee, 2026-11-01) the same check, told the coin's transfer fee (undefined for every coin without one: the old answer)
  assert.ok(sol.includes('const priceWhy = jupPriceCheck({ side, amount, minOut, decimals: r.decimals, priceSol: await priceP, feeBps: r.fee?.lowBps });'), 'VA-7');
});

test('VA-8: four.meme sells carry a floor (the floored overload), the early estimate is the zero-floor call', () => {
  has(bnb, "{ name: 'sellToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'origin', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'minFunds', type: 'uint256' }], outputs: [] },");
  has(eng, "const sellAt = (min: bigint) => ({ address: route.manager, abi: FOUR_MANAGER_ABI, functionName: 'sellToken', args: [0n, token, amountIn, min] });");
  has(eng, "sellAt(applySlippage(net - net / 100n)), early, 'the four.meme sell')");
  assert.ok(!/functionName: 'sellToken', args: \[token, amountIn\]/.test(eng), 'no four.meme sell without a minimum');
  // TokenManager2 takes whole multiples of 1e9 ("GW")
  has(eng, "return route.type === 'four' ? a - (a % 1_000_000_000n) : a;");
});

test('VA-9: DLMM pools found on chain join the server\'s list; a sell waits for that search', () => {
  has(sol, 'export function dlmmDiscover(mint: string): Promise<string[]> {');
  has(sol, "rpcAt<any>(RPC_URL(), 'getMultipleAccounts', [c, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], 6000)");
  has(sol, "const more = r.dlmmMore ? (side === 'sell' ? await r.dlmmMore.p.catch(() => []) : r.dlmmMore.v || []) : [];");
  has(sol, 'const disc = dlmmDiscover(mint);');
});

test('speed: G1 stale-while-revalidate (tips, fee levels, blockhash, route), G5 Jito warm + RTT order, G7 parallel DLMM quotes', () => {
  has(sol, 'const SWR_FRESH = 5_000, SWR_MAX = 60_000;');
  has(sol, 'if (feeLv && age < SWR_MAX) { if (age > SWR_FRESH) loadFeeLevels().catch(() => {}); return Promise.resolve(feeLv); }');
  has(sol, 'if (tipFloor && age < SWR_MAX) { if (age > SWR_FRESH) loadTips().catch(() => {}); return Promise.resolve(tipFloor); }');
  has(sol, 'if (hit && Date.now() - hit.at < 60000) { load().catch(() => {}); return Promise.resolve(hit.r); }');
  has(sol, 'blockhash(SWR_FRESH).catch(() => {});\n  jitoWarm();');
  has(sol, 'const order = [...JITO_ENDPOINTS].sort((a, b) => (jitoRtt.get(a) ?? 1e9) - (jitoRtt.get(b) ?? 1e9));');
  has(sol, 'const quotes = await Promise.all(cands.map(async (c) => {');
});

test('speed: G3 answer at submit (lock kept to the receipt), G4 early estimate on Robinhood, G10/G8 reads in the first batch', () => {
  const tg = body(eng, 'async function tradeGuard<T>(', '\n}\n');
  before(tg, 'const { ret, landed } = await fn(); resolve(ret);', 'finally { releaseInFlight(key); }');
  has(eng, "if (CFG.key !== 'bsc' && !s.turbo && (route.type === 'pons' || route.type === 'v4' || route.type === 'v3')) { const pr = bscBuyProbe(amountIn); if (pr) kick(bscEstimate('buy', pr)); }");
  has(eng, 'const simEarly = async (call: any, early: Promise<bigint | null> | null) => {');
  has(eng, "const beforePair = !nativePair ? await pairBalanceOf(route.pairToken) : 0n;");
  has(eng, "if (route.type === 'standard' && route.stage === 'curve') kick(bscAllowance(token, route.curve));");
});

test('speed: G11 batch window 0, G12 BSC receipts via bloXroute / 48 Club, G14 Solana confirm poll 400 ms, G17 ring heads, G5 no EVM pings in SOL/NEAR frames', () => {
  has(eng, '{ batch: { wait: 0 } }');
  assert.ok(!/batch: \{ wait: 16 \}/.test(eng));
  has(eng, 'const r = await receiptClient().getTransactionReceipt({ hash }).catch(() => null);');
  has(eng, 'setTimeout(ok, i < 25 ? 400 : 1500)');
  has(eng, 'const heads = u.filter((x) => x !== RPC2);');
  has(eng, 'if (Date.now() > hotUntil || SOL_MODE || NEAR_MODE) return;');
});
