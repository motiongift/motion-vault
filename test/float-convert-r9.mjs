// Release 9 (owner 2026-11-05): float.convert — the USD balance into the chain's own coin, kept in the wallet — and the switch-on
// consent without the "Expected upkeep" line. Pure parts (floatCore: floatArgs, convertCheck, convKept, CONVERT_TEXT) and the vault
// side end to end on a mocked Robinhood / Solana chain (the existing top-up move R → W, its lock, its refusals, the kept coin
// staying out of the dollar figure and every sweep, a failed swap holding nothing back, switch-off releasing it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';

const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'unwrapWETH9', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
];
const ERC20 = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
const C = F.FLOAT_CFG.robinhood, SOLC = F.FLOAT_CFG.sol;
const lc = (a) => String(a).toLowerCase();
const ETH_USD = 4000;
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const D = (n) => F.usd6(n);
const E18 = 10n ** 18n;

// a small Robinhood (W, R, USDG, the float's SwapRouter02) and a Solana reserve, both mocked
function world(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const sol = { W: 'So1W' + '1'.repeat(40), R: 'So1R' + '2'.repeat(40) };
  const chain = { eth: new Map([[lc(W), o.wEth ?? (C.gasFloor + 5_000_000_000_000_000n)], [lc(R), o.rEth ?? C.reserveGas]]), usdg: new Map([[lc(R), o.rUsdg ?? 500_000_000n]]),
    allow: new Map(o.noAllowance ? [] : [[`${lc(R)}>${lc(C.router)}`, 2n ** 255n]]), nonces: new Map(), receipts: new Map(), txs: [] };
  const swap = (from, value, data, apply) => {
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data });
    const outs = []; let routerWeth = 0n;
    for (const inner of args[1]) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data: inner });
      if (d.functionName === 'exactInputSingle') {
        const p = d.args[0];
        if (lc(p.tokenIn) === lc(C.stable.address)) {
          const al = chain.allow.get(`${lc(from)}>${lc(C.router)}`) ?? 0n;
          if (al < p.amountIn) throw new Error('execution reverted: STF');
          if ((chain.usdg.get(lc(from)) ?? 0n) < p.amountIn) throw new Error('execution reverted: STF balance');
          const out = BigInt(Math.floor(Number(p.amountIn) / 1e6 / ETH_USD * 0.9999 * 1e18));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply && o.revertOnChain) throw new Error('execution reverted: Too little received (on chain)');
          if (apply) { chain.allow.set(`${lc(from)}>${lc(C.router)}`, al - p.amountIn); chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - p.amountIn); }
          assert.equal(lc(p.recipient), '0x0000000000000000000000000000000000000002', 'the top-up keeps the WETH in the router');
          routerWeth += out; outs.push(encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', result: out }));
        } else {
          const out = BigInt(Math.floor(Number(p.amountIn) / 1e18 * ETH_USD * 0.9999 * 1e6));
          if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - value); chain.usdg.set(lc(p.recipient), (chain.usdg.get(lc(p.recipient)) ?? 0n) + out); }
          outs.push(encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', result: out }));
        }
      } else if (d.functionName === 'unwrapWETH9') {
        if (routerWeth < d.args[0]) throw new Error('execution reverted: Insufficient WETH9');
        if (apply) chain.eth.set(lc(d.args[1]), (chain.eth.get(lc(d.args[1])) ?? 0n) + routerWeth);
        routerWeth = 0n; outs.push('0x');
      }
    }
    return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', result: outs });
  };
  const exec = (from, tx, apply) => {
    const to = lc(tx.to);
    if (to === lc(C.router)) return swap(from, tx.value, tx.data, apply);
    if (to === lc(C.stable.address)) {
      const d = decodeFunctionData({ abi: ERC20, data: tx.data });
      if (d.functionName === 'transfer') { const have = chain.usdg.get(lc(from)) ?? 0n; if (have < d.args[1]) throw new Error('execution reverted: balance'); if (apply) { chain.usdg.set(lc(from), have - d.args[1]); chain.usdg.set(lc(d.args[0]), (chain.usdg.get(lc(d.args[0])) ?? 0n) + d.args[1]); } return '0x' + '1'.padStart(64, '0'); }
      if (apply) chain.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]); return '0x' + '1'.padStart(64, '0');
    }
    if (tx.data === '0x') { if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - tx.value); chain.eth.set(lc(tx.to), (chain.eth.get(lc(tx.to)) ?? 0n) + tx.value); } return '0x'; }
    throw new Error('test: unexpected call to ' + tx.to);
  };
  const send = (from, tx, gas) => {
    const nonce = chain.nonces.get(lc(from)) ?? 0; const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}`));
    if (o.lose) { chain.txs.push({ from, ...tx, hash, lost: true }); throw Object.assign(new Error('Reserve send outcome unknown (timed out)'), { name: 'FloatUnknown', unknown: true, hash }); }
    let status = 'success'; try { exec(from, tx, true); } catch { status = 'reverted'; }
    chain.nonces.set(lc(from), nonce + 1); chain.txs.push({ from, ...tx, gas, hash }); chain.receipts.set(hash, status);
    return hash;
  };
  const store = new Map(); const events = []; const asks = []; let gates = 0; const solCalls = []; const consents = []; const gasAsks = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const deps = {
    ...(o.rules ? { rules: o.rules } : {}),
    chain: () => o.lane || 'robinhood',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return { id, name: 'Wallet 1', w: { evm: W, sol: sol.W }, r: { evm: R, sol: sol.R } }; },
    evm: {
      call: async (tx) => exec(tx.from, tx, false), balance: async (a) => chain.eth.get(lc(a)) ?? 0n, erc20: async (t, a) => chain.usdg.get(lc(a)) ?? 0n,
      allowance: async (t, owner, spender) => chain.allow.get(`${lc(owner)}>${lc(spender)}`) ?? 0n, slot0: async () => sqrtFor(ETH_USD),
      fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }), estimate: async (tx) => { exec(tx.from, tx, false); return 150_000n; },
      sendR: async (walletId, tx, gas) => send(R, tx, gas), sendW: async (walletId, tx, gas) => send(W, tx, gas),
      receipt: async (h) => (chain.receipts.has(h) ? { status: chain.receipts.get(h) } : null),
    },
    sol: {
      balance: async (a) => (a === sol.W ? (o.solW ?? 20_000_000n) : 10_000_000n), usdc: async () => o.solUsdc ?? 100_000_000n, oracle6: async () => 100n * F.USD,
      fees: async () => { throw new Error('defaults'); },
      quote: async (dir, amountIn) => (dir === 'usdc→sol' ? amountIn * 10n * 9990n / 10_000n : amountIn / 10n),
      topup: async (id, usdcIn, minLamports) => { solCalls.push({ kind: 'topup', id, usdcIn, minLamports }); return 'sig' + solCalls.length; },
      sweep: async (id, l, m) => { solCalls.push({ kind: 'sweep', l, m }); return 'sigs'; },
      gas: async (id, l) => { solCalls.push({ kind: 'gas', l }); return 'sigg'; },
      status: async (sig) => (o.solFail ? 'failed' : 'confirmed'),
      ...(o.noSolWithdraw ? {} : { withdraw: async (id, to, units) => { solCalls.push({ kind: 'withdraw', id, to, units }); return 'sigw' + solCalls.length; } }),
    },
    // Send's own consent, as webEngine gives it: the outside path asks (o.consent: 'no' = closed, '2fa' = TwoFactorRequired)
    withdrawOk: async (x) => { consents.push(x); if (o.consent === '2fa') throw Object.assign(new Error('Two-factor code required'), { name: 'TwoFactorRequired' }); if (o.consent === 'no') throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' }); },
    ...(o.solver ? { solver: { base: () => 'https://motion.test', pinnedKey: () => 'ab'.repeat(32), signEvmTransfer: async () => { throw new Error('test: no bridge'); }, signSolTransfer: async () => { throw new Error('test: no bridge'); } } } : {}),
    ask: async (a) => { asks.push(a); return true; },
    gate: async () => { gates += 1; },
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: o.lock || (async (k, fn) => fn()),
    emit: (d) => events.push(d), fetch: async (u, init) => {
      if (o.solver && String(u).includes('/gas')) { gasAsks.push(JSON.parse(init?.body || '{}')); if (o.solver.gasRefuse) return { ok: true, status: 200, json: async () => ({ ok: false, reason: 'no' }) }; chain.eth.set(lc(R), (chain.eth.get(lc(R)) ?? 0n) + C.reserveGas); return { ok: true, status: 200, json: async () => ({ ok: true, state: 'sent', hash: '0xgas' }) }; }
      throw new Error('test: no network ' + u);
    }, click: () => click, wait: async () => {},
  };
  return { f: createFloat(deps), chain, W, R, W_KEY, R_KEY, sol, store, events, asks, gates: () => gates, click, solCalls, consents, gasAsks };
}
const idle = (wd) => { wd.click.lastTradeAt = Date.now() - 120_000; wd.click.ticketAt = Date.now() - 120_000; };
async function on(wd, chains = ['robinhood', 'bsc', 'sol']) {
  const r = await wd.f.configure({ walletId: 'w1', chains });
  assert.equal(r.ok, true);
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.') || k.startsWith('trenches.float.v1.keep.')) wd.store.delete(k);
  return r;
}
const convKey = (wd, c = 'robinhood') => `trenches.float.v1.conv.${c}.${lc(wd.W)}`;
const keyScan = (wd, things) => {
  const blob = JSON.stringify(things, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + [...wd.store.values()].join('|') + JSON.stringify(wd.events) + JSON.stringify(wd.asks);
  for (const k of [wd.W_KEY, wd.R_KEY]) assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked');
};

// ── change 1: the consent without the upkeep line ──
test('consent (r9): the switch-on dialog no longer says "Expected upkeep …"; the rest of the consent is unchanged', async () => {
  const wd = world();
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] });
  assert.equal(wd.asks.length, 1);
  const html = wd.asks[0].html;
  assert.ok(!/Expected upkeep|a week per wallet in network and pool fees/.test(html), 'no upkeep line');
  for (const re of [/a buy tops up first/, /slippage at most 0\.50 %/, /Wallets you add later join by themselves/, /Valid for 30 days\./, /the reserve buys the coin and it lands in the wallet, in one transaction/]) assert.match(html, re);
  // every language: the configure path passes no upkeep, and the pure text omits it exactly then
  for (const lang of F.FLOAT_LANGS) {
    const t = F.accountPermissionText(['Wallet 1'], ['robinhood'], F.DEFAULT_CAPS, undefined, lang);
    const withIt = F.accountPermissionText(['Wallet 1'], ['robinhood'], F.DEFAULT_CAPS, D(0.06), lang);
    assert.equal(withIt.split('\n').length, t.split('\n').length + 1, lang);
  }
  const src = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8');
  assert.ok(/accountPermissionText\(list\.map\(\(w\) => w\.name\), chains, caps, undefined, lang\)/.test(src), 'configure passes no upkeep');
});

// ── pure parts ──
test('float.convert arguments: one plain object, walletId / chain / usd required, lang optional, nothing else', () => {
  assert.ok(F.FLOAT_METHODS.includes('convert'));
  assert.deepEqual(F.floatArgs('convert', { walletId: 'w1', chain: 'robinhood', usd: 25, lang: 'ru' }), { walletId: 'w1', chain: 'robinhood', usd: 25, lang: 'ru' });
  for (const [o, re] of [
    [{ walletId: 'w1', chain: 'robinhood' }, /usd missing/], [{ walletId: 'w1', usd: 5 }, /chain missing/], [{ chain: 'bsc', usd: 5 }, /walletId missing/],
    [{ walletId: 'w1', chain: 'eth', usd: 5 }, /chain/], [{ walletId: 'w1', chain: 'bsc', usd: -1 }, /usd/], [{ walletId: 'w1', chain: 'bsc', usd: 10_001 }, /usd/], [{ walletId: 'w1', chain: 'bsc', usd: '5' }, /usd/],
    [{ walletId: 'w1', chain: 'bsc', usd: 5, to: '0x' + '11'.repeat(20) }, /unknown field to/], [{ walletId: 'w1', chain: 'bsc', usd: 5, lang: 'de' }, /lang/],
  ]) assert.throws(() => F.floatArgs('convert', o), re, JSON.stringify(o));
});

test('convertCheck (owner 2026-11-05: “remove the limits, then the text stays true”): only the $1 minimum and what the reserve holds — no day / fee / per-conversion limit', () => {
  assert.equal(F.convertCheck({ usd6: D(25), reserve6: D(500) }), null);
  assert.equal(F.convertCheck({ usd6: D(500), reserve6: D(500) }), null, 'the whole reserve may go');
  assert.equal(F.convertCheck({ usd6: D(5_000), reserve6: D(9_000) }), null, 'no per-conversion cap');
  assert.deepEqual(F.convertCheck({ usd6: D(0.5), reserve6: D(500) }), { code: 'min', vars: { min: '$1.00' }, max6: D(500) });
  assert.deepEqual(F.convertCheck({ usd6: D(600), reserve6: D(500) }), { code: 'short', vars: { have: '$500.00' }, max6: D(500) });
  const src = readFileSync(new URL('../src/floatEngine.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('    convert: async (o: unknown) => {'), src.indexOf('      const r = await deps.lock(lockKey(w, c), () => fastly(run)'));
  assert.ok(!/perDay6|feesPerDay6|perChain6|total6|ledgerOf|withinCaps/.test(body), 'float.convert reads no cap');
});

test('convKept: a failed swap counts nothing; a spend shrinks the coin after the ready float; a landing conversion is never shrunk', () => {
  const now = 1_800_000_000_000; const floor = C.gasFloor;
  // two conversions, one failed on chain
  let r = F.convKept([{ raw: 10n, at: now - 1, job: 'a', state: 'arrived' }, { raw: 7n, at: now - 1, job: 'b', state: 'failed' }], floor + 100n, floor, now);
  assert.equal(r.kept, 10n); assert.deepEqual(r.items, [{ raw: 10n, at: now - 1, job: 'a' }]); assert.equal(r.changed, true);
  // W spent native below gas floor + kept, long after: folded to what is there
  r = F.convKept([{ raw: 100n, at: now - 600_000, job: 'a', state: 'arrived' }], floor + 40n, floor, now);
  assert.equal(r.kept, 40n); assert.deepEqual(r.items, [{ raw: 40n, at: now - 600_000 }]);
  // still landing (W's read predates it): not shrunk, only bounded by what W holds
  r = F.convKept([{ raw: 100n, at: now - 5_000, job: 'a', state: 'sent' }], floor + 40n, floor, now);
  assert.equal(r.kept, 100n); assert.equal(r.changed, false);
  r = F.convKept([{ raw: 100n, at: now - 5_000, job: 'a', state: 'sent' }], 30n, floor, now);
  assert.equal(r.kept, 30n);
  // nothing left: gone
  r = F.convKept([{ raw: 100n, at: now - 600_000, state: null }], floor, floor, now);
  assert.deepEqual(r, { kept: 0n, items: [], changed: true });
});

test('refusal texts: every code in all six languages, each saying nothing was moved, the numbers filled in', () => {
  const codes = Object.keys(F.CONVERT_TEXT.en);
  assert.equal(codes.length, 11);
  for (const gone of ['over-day', 'over-fees', 'over-chain']) assert.ok(!codes.includes(gone), gone);
  const tail = { en: 'nothing was moved', ru: 'ничего не перемещено', zh: '未移动任何资金', id: 'tidak ada yang dipindahkan', es: 'no se movió nada', fr: 'rien n’a été déplacé' };
  for (const lang of F.FLOAT_LANGS) {
    assert.deepEqual(Object.keys(F.CONVERT_TEXT[lang]).sort(), [...codes].sort(), lang);
    for (const c of codes) { const t = F.convertWhy(c, lang, { min: '$1.00', have: '$3.00', cap: '$250.00', left: '$5.00', why: 'x' }); assert.ok(t.endsWith(tail[lang]), `${lang} ${c}: ${t}`); assert.ok(!/undefined/.test(t), `${lang} ${c}`); }
  }
  assert.equal(F.convertWhy('short', 'en', { have: '$20.00' }), 'Your USD balance on this network holds $20.00 — nothing was moved');
});

// ── the vault side ──
test('convert on Robinhood: ONE transaction from R to the float\'s own router, the coin to W, no dialog, no 2FA; kept out of the dollar figure', async () => {
  const wd = world(); await on(wd);
  const asks0 = wd.asks.length, gates0 = wd.gates();
  const w0 = wd.chain.eth.get(lc(wd.W)), r0 = wd.chain.usdg.get(lc(wd.R));
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.state, 'sent'); assert.equal(a.chain, 'robinhood'); assert.equal(a.usd, 25);
  assert.equal(wd.asks.length, asks0, 'no dialog: the rules-2 line of the live grant covers it'); assert.equal(wd.gates(), gates0, 'no 2FA');
  assert.equal(wd.chain.txs.length, 1, 'one transaction'); const tx = wd.chain.txs[0];
  assert.equal(lc(tx.from), lc(wd.R), 'R signs'); assert.equal(lc(tx.to), lc(C.router), 'the float\'s own router'); assert.equal(tx.value, 0n);
  const d = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data }); const inner = d.args[1].map((x) => decodeFunctionData({ abi: ROUTER_ABI, data: x }));
  assert.deepEqual(inner.map((x) => x.functionName), ['exactInputSingle', 'unwrapWETH9']);
  assert.equal(lc(inner[1].args[1]), lc(wd.W), 'the coin is paid to W itself, never anywhere else');
  assert.equal(r0 - wd.chain.usdg.get(lc(wd.R)), 25_000_000n, 'exactly $25 of USDG left R');
  const got = wd.chain.eth.get(lc(wd.W)) - w0;
  assert.ok(got >= BigInt(a.coin.min.raw) && BigInt(a.coin.min.raw) > 0n, 'W received at least the floor the answer names');
  assert.equal(got, BigInt(a.coin.raw), 'the kept coin is what the swap delivered (simulated from R at signing)');
  assert.equal(a.spent.symbol, 'USDG'); assert.equal(a.coin.symbol, 'ETH'); assert.match(a.coin.min.text, /ETH$/); assert.match(a.coin.text, /ETH$/);
  // the job: an ordinary top-up of the ledger, reason 'convert'
  const jobs = (await wd.f.jobs({ walletId: 'w1' })).jobs; const j = jobs.find((x) => x.id === a.jobId);
  assert.equal(j.kind, 'topup'); assert.equal(j.reason, 'convert'); assert.equal(j.usd6, String(D(25)));
  // status: the kept coin is stated and not in the dollar figure
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await new Promise((r) => setTimeout(r, 10));
  const st = await wd.f.status({ walletId: 'w1', fresh: true });
  const ch = st.chains.robinhood;
  assert.equal(ch.native.kept.raw, a.coin.raw);
  assert.ok(Math.abs(ch.native.kept.usd - 25 * 0.995) < 0.5, String(ch.native.kept.usd));
  assert.ok(Math.abs(ch.native.usd - 20.8) < 0.05, `the ready float (incl. its gas floor) is W's native without the kept coin: ${ch.native.usd}`);
  assert.ok(Math.abs(st.usd.total - (475 + 20.8)) < 0.05, `USD balance dropped by the $25 converted: ${st.usd.total}`);
  keyScan(wd, [a, st]);
});

test('the kept coin is never swept back; the ready float around it still is', async () => {
  const wd = world({ wEth: C.gasFloor + 25_000_000_000_000_000n }); await on(wd, ['robinhood']);   // W: floor + $100 ready
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 50 });
  assert.equal(a.ok, true);
  // the top-up landed; the user goes quiet; a routine tick plans the sweep of an inactive chain (target 0)
  idle(wd);
  const n0 = wd.chain.txs.length;
  const t = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await new Promise((r) => setTimeout(r, 20));
  const sweeps = wd.chain.txs.slice(n0).filter((x) => lc(x.from) === lc(wd.W) && x.value > 0n);
  const kept = BigInt(a.coin.raw);
  for (const s of sweeps) assert.ok(wd.chain.eth.get(lc(wd.W)) >= kept + C.gasFloor - 1n, 'W still holds the kept coin above its gas floor');
  assert.ok(sweeps.every((s) => s.value <= 25_010_000_000_000_000n), 'at most the ready $100 is swept, never the converted coin');
  assert.ok(t, 'ticked');
});

test('refusals are answers with a code and a clear text, nothing signed: lane, off, min, short, a running trade, the lock held', async () => {
  const wd = world();
  let a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.deepEqual([a.ok, a.state, a.code], [false, 'refused', 'off']); assert.equal(a.why, 'The USD balance is off for this wallet on this network — nothing was moved');
  await on(wd, ['robinhood', 'sol']);
  a = await wd.f.convert({ walletId: 'w1', chain: 'sol', usd: 25 }); assert.equal(a.code, 'lane', 'only that chain\'s frame converts');
  a = await wd.f.convert({ walletId: 'w1', chain: 'bsc', usd: 25 }); assert.equal(a.code, 'lane');
  a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 0.5 }); assert.equal(a.code, 'min');
  a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 600, lang: 'ru' }); assert.equal(a.code, 'short'); assert.equal(a.maxUsd, 500); assert.equal(a.why, 'Ваш баланс в USD в этой сети: $500.00 — ничего не перемещено');
  const wd2 = world({ rUsdg: 20_000_000n }); await on(wd2, ['robinhood']);
  a = await wd2.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 }); assert.equal(a.code, 'short'); assert.equal(a.maxUsd, 20); assert.match(a.why, /holds \$20\.00/);
  wd.click.clickAt = Date.now(); wd.click.clickDoneAt = 0;
  a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 }); assert.equal(a.code, 'trade');
  wd.click.clickDoneAt = Date.now() + 1;
  const wd3 = world({ lock: async () => null }); await on(wd3, ['robinhood']);
  a = await wd3.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 }); assert.equal(a.code, 'busy');
  assert.equal(wd.chain.txs.length + wd2.chain.txs.length + wd3.chain.txs.length, 0, 'nothing was signed');
  // no limit in the user's sense: $300 — over release 9's first draft's $250 per conversion — goes, and so does the rest of the reserve
  const big = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 300 }); assert.equal(big.ok, true, JSON.stringify(big));
  const rest = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 200 }); assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.equal(wd.chain.usdg.get(lc(wd.R)), 0n, 'the whole $500 reserve became ETH in two conversions, no day / fee cap');
  await assert.rejects(() => wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25, to: '0x' + '22'.repeat(20) }), /unknown field to/);
  await assert.rejects(() => wd.f.convert({ walletId: 'w9', chain: 'robinhood', usd: 25 }), /Unknown wallet/);
});

test('one move of a lane at a time: a second convert while the first is still landing is refused (busy)', async () => {
  const wd = world({ lose: true }); await on(wd, ['robinhood']);
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.equal(a.ok, false); assert.equal(a.state, 'unknown'); assert.ok(a.hash, 'followed by its hash');
  assert.ok(wd.store.get(convKey(wd)), 'a send that may be out holds its coin as kept (dropped again if it fails)');
  const b = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.equal(b.code, 'busy'); assert.equal(wd.chain.txs.length, 1, 'never sent twice');
});

test('a swap that reverts on chain holds nothing back: the kept record is dropped once the job reads failed', async () => {
  const wd = world({ revertOnChain: true }); await on(wd, ['robinhood']);
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.equal(a.ok, true, 'sent (the simulation passed)');
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await new Promise((r) => setTimeout(r, 20));
  const st = await wd.f.status({ walletId: 'w1', fresh: true });
  assert.equal(st.chains.robinhood.native.kept, undefined, 'nothing kept');
  assert.equal(wd.store.get(convKey(wd)), undefined);
  assert.equal(wd.chain.usdg.get(lc(wd.R)), 500_000_000n, 'the reserve still holds every dollar');
});

test('rules: a grant on older rules that this build still accepts cannot convert (rules 2 is the yes for "the reserve buys the coin")', async () => {
  const wd = world({ rules: { current: 1, accepted: 1 } }); await on(wd, ['robinhood']);
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 });
  assert.equal(a.code, 'rules'); assert.equal(wd.chain.txs.length, 0);
});

test('convert on Solana: the same pattern — the float\'s own sol.topup (R sells USDC, pays W the floor), kept as SOL', async () => {
  const wd = world({ lane: 'sol' }); await on(wd, ['sol']);
  const a = await wd.f.convert({ walletId: 'w1', chain: 'sol', usd: 10 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(wd.solCalls.map((x) => x.kind), ['topup']);
  assert.equal(wd.solCalls[0].usdcIn, 10_000_000n); assert.ok(wd.solCalls[0].minLamports > 0n);
  assert.equal(a.coin.symbol, 'SOL'); assert.equal(a.coin.min.raw, String(wd.solCalls[0].minLamports)); assert.equal(a.coin.raw, String(10_000_000n * 10n * 9990n / 10_000n), 'the quoted SOL'); assert.equal(a.spent.symbol, 'USDC');
  const items = JSON.parse(wd.store.get(convKey(wd, 'sol')));
  assert.equal(items.length, 1); assert.equal(items[0].raw, a.coin.raw); assert.equal(items[0].job, a.jobId);
});

test('switch-off: the converted coin is the wallet\'s plain native again (no record left behind)', async () => {
  const wd = world(); await on(wd, ['robinhood']);
  const a = await wd.f.convert({ walletId: 'w1', chain: 'robinhood', usd: 25 }); assert.equal(a.ok, true);
  assert.ok(wd.store.get(convKey(wd)));
  await wd.f.off({ walletId: 'w1' });
  assert.equal(wd.store.get(convKey(wd)), undefined);
});

test('wiring: engine.float.convert is the float\'s own method (not a click: no clickRun), listed in the vault\'s method list', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /jobs: float\.jobs, earn: float\.earn, buy: \(o: unknown\) => clickRun\(\(\) => usdBuy\(o\)\), convert: float\.convert, withdraw: float\.withdraw \}/);
  assert.match(src, /\{ method: 'float\.convert', does: '[^']*(\\'[^']*)*', needs: \[\] \}/);
});

// ── float.withdraw (release 9, 2026-11-05: a tester "USD withdrawal is not available") ──
const OUT = '0x' + '7e'.repeat(20);
const wdArgs = (x = {}) => ({ walletId: 'w1', chain: 'robinhood', usd: 25, to: 'address', address: OUT, idempotencyKey: 'press-0001', ...x });

test('float.withdraw arguments: usd number or "max", to wallet | address, the address only with to address, a key per press, a 2FA code', () => {
  assert.ok(F.FLOAT_METHODS.includes('withdraw'));
  assert.deepEqual(F.floatArgs('withdraw', wdArgs()), wdArgs());
  assert.deepEqual(F.floatArgs('withdraw', { walletId: 'w1', chain: 'bsc', usd: 'max', to: 'wallet', idempotencyKey: 'press-0002', lang: 'fr', twofa: 'tok' }).usd, 'max');
  for (const [o, re] of [
    [wdArgs({ usd: 0.05 }), /usd/], [wdArgs({ usd: 100_001 }), /usd/], [wdArgs({ usd: 'all' }), /usd/], [wdArgs({ to: 'friend' }), /to/],
    [wdArgs({ address: '0x' + '0'.repeat(40) }), /address/], [wdArgs({ address: 'So1' }), /address/], [wdArgs({ chain: 'sol' }), /address/],
    [{ ...wdArgs({ to: 'wallet' }) }, /address goes with to 'address' only/], [wdArgs({ idempotencyKey: 'x' }), /idempotencyKey/], [wdArgs({ twofa: 5 }), /twofa/],
    [wdArgs({ memo: 'hi' }), /unknown field memo/],
  ]) assert.throws(() => F.floatArgs('withdraw', o), re, JSON.stringify(o));
  assert.equal(F.decimalOf(12_500_000n, 6), '12.5'); assert.equal(F.decimalOf(25_000_000n, 6), '25'); assert.equal(F.decimalOf(1n, 18), '0.000000000000000001');
  for (const lang of F.FLOAT_LANGS) for (const c of Object.keys(F.WITHDRAW_TEXT.en)) assert.ok(!/undefined/.test(F.withdrawWhy(c, lang, { have: '$1.00', why: 'x' })), `${lang} ${c}`);
});

test('withdraw to an outside address (Robinhood): Send\'s consent first, then ONE USDG transfer signed by R to exactly that address', async () => {
  const wd = world(); await on(wd, ['robinhood']);
  const a = await wd.f.withdraw(wdArgs({ twofa: 'tok' }));
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.state, 'confirmed'); assert.equal(a.symbol, 'USDG'); assert.equal(a.amount, '25'); assert.equal(a.usd, 25); assert.equal(a.address, OUT); assert.equal(a.to, 'address');
  assert.equal(wd.consents.length, 1); assert.deepEqual({ ...wd.consents[0] }, { walletName: 'Wallet 1', chainName: 'Robinhood', symbol: 'USDG', token: C.stable.address, amount: '25', to: OUT, twofa: 'tok' });
  assert.equal(wd.chain.txs.length, 1); const tx = wd.chain.txs[0];
  assert.equal(lc(tx.from), lc(wd.R)); assert.equal(lc(tx.to), lc(C.stable.address)); assert.equal(tx.value, 0n);
  const d = decodeFunctionData({ abi: ERC20, data: tx.data }); assert.equal(d.functionName, 'transfer'); assert.equal(lc(d.args[0]), OUT); assert.equal(d.args[1], 25_000_000n);
  assert.equal(wd.chain.usdg.get(lc(OUT)), 25_000_000n); assert.equal(wd.chain.usdg.get(lc(wd.R)), 475_000_000n);
  // the same press again: the first answer, nothing sent twice, no second dialog
  const b = await wd.f.withdraw(wdArgs({ twofa: 'tok' }));
  assert.equal(b.repeat, true); assert.equal(b.hash, a.hash); assert.equal(wd.chain.txs.length, 1); assert.equal(wd.consents.length, 1);
  // status: the form's Max is the reserve's liquid stable
  const st = await wd.f.status({ walletId: 'w1', fresh: true });
  assert.equal(st.chains.robinhood.withdrawUsd, 475);
  keyScan(wd, [a, b, st]);
});

test('withdraw to the wallet itself, and "max": the whole liquid reserve, recipient = W (no address argument)', async () => {
  const wd = world(); await on(wd, ['robinhood']);
  const a = await wd.f.withdraw({ walletId: 'w1', chain: 'robinhood', usd: 'max', to: 'wallet', idempotencyKey: 'press-max-1' });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.amount, '500'); assert.equal(a.address, lc(wd.W));
  assert.equal(wd.consents[0].to, wd.W, 'the consent is asked for W (webEngine: own wallet = the transfer gate)');
  assert.equal(wd.chain.usdg.get(lc(wd.W)), 500_000_000n); assert.equal(wd.chain.usdg.get(lc(wd.R)), 0n);
});

test('withdraw: no limit — $400 in one go (above every switch cap of release 8), never more than the reserve holds', async () => {
  const wd = world(); await on(wd, ['robinhood']);
  const a = await wd.f.withdraw(wdArgs({ usd: 400, idempotencyKey: 'press-big-1' }));
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await wd.f.withdraw(wdArgs({ usd: 150, idempotencyKey: 'press-big-2' }));
  assert.equal(b.code, 'amount'); assert.equal(b.maxUsd, 100); assert.match(b.why, /Only \$100\.00 can be withdrawn now/);
  assert.equal(wd.chain.txs.length, 1);
});

test('withdraw refusals and throws: lane, a reserve as recipient, busy (switch-off / lock), a running trade, closed dialog, 2FA — nothing sent', async () => {
  const wd = world(); await on(wd, ['robinhood', 'sol']);
  assert.equal((await wd.f.withdraw(wdArgs({ chain: 'bsc', idempotencyKey: 'k-lane-1' }))).code, 'lane');
  assert.equal((await wd.f.withdraw(wdArgs({ address: wd.R, idempotencyKey: 'k-loop-1' }))).code, 'address', 'never to its own reserve');
  wd.click.clickAt = Date.now(); wd.click.clickDoneAt = 0;
  assert.equal((await wd.f.withdraw(wdArgs({ idempotencyKey: 'k-trade-1' }))).code, 'trade');
  wd.click.clickDoneAt = Date.now() + 1;
  const no = world({ consent: 'no' }); await on(no, ['robinhood']);
  await assert.rejects(() => no.f.withdraw(wdArgs()), /Cancelled/);
  const tfa = world({ consent: '2fa' }); await on(tfa, ['robinhood']);
  await assert.rejects(() => tfa.f.withdraw(wdArgs()), (e) => e.name === 'TwoFactorRequired');
  const busy = world({ lock: async () => null }); await on(busy, ['robinhood']);
  assert.equal((await busy.f.withdraw(wdArgs())).code, 'busy');
  assert.equal(wd.chain.txs.length + no.chain.txs.length + tfa.chain.txs.length + busy.chain.txs.length, 0, 'nothing signed');
  // a cancelled press leaves no record: the same key may be pressed again
  assert.equal(no.store.get('trenches.float.v1.wd.press-0001') ?? null, null);
  // a key of another wallet's withdrawal is refused
  wd.store.set('trenches.float.v1.wd.k-other-1', JSON.stringify({ walletId: 'w9', at: 1, answer: { ok: true } }));
  await assert.rejects(() => wd.f.withdraw(wdArgs({ idempotencyKey: 'k-other-1' })), /another withdrawal/);
});

test('withdraw needs no switch: dollars left after a switch-off come out too (the consent of Send is the yes)', async () => {
  const wd = world();
  const a = await wd.f.withdraw(wdArgs({ idempotencyKey: 'press-off-1' }));
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(wd.chain.usdg.get(lc(OUT)), 25_000_000n);
});

test('withdraw on Solana: the host\'s one transferChecked from R to the address; a host without it says "unsupported"', async () => {
  const wd = world({ lane: 'sol' }); await on(wd, ['sol']);
  const to = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const a = await wd.f.withdraw({ walletId: 'w1', chain: 'sol', usd: 10, to: 'address', address: to, idempotencyKey: 'sol-press-1' });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.symbol, 'USDC'); assert.equal(a.state, 'confirmed');
  assert.deepEqual(wd.solCalls.map((x) => [x.kind, x.to, x.units]), [['withdraw', to, 10_000_000n]]);
  const old = world({ lane: 'sol', noSolWithdraw: true }); await on(old, ['sol']);
  assert.equal((await old.f.withdraw({ walletId: 'w1', chain: 'sol', usd: 10, to: 'wallet', idempotencyKey: 'sol-press-2' })).code, 'unsupported');
});

test('withdraw: a lost answer is "unknown" with its hash, kept under the key — the same press never sends again', async () => {
  const wd = world({ lose: true }); await on(wd, ['robinhood']);
  const a = await wd.f.withdraw(wdArgs({ idempotencyKey: 'press-lost-1' }));
  assert.equal(a.ok, false); assert.equal(a.state, 'unknown'); assert.ok(a.hash);
  const b = await wd.f.withdraw(wdArgs({ idempotencyKey: 'press-lost-1' }));
  assert.equal(b.repeat, true); assert.equal(b.state, 'unknown'); assert.equal(wd.chain.txs.length, 1);
});

test('wiring: engine.float.withdraw, its method-list line, the Solana host and Send\'s consent in webEngine', () => {
  const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  assert.match(src, /convert: float\.convert, withdraw: float\.withdraw \}/);
  assert.match(src, /\{ method: 'float\.withdraw', does: '[^']*(\\'[^']*)*', needs: \['transfer'\] \}/);
  assert.match(src, /withdraw: \(walletId, to, units\) => floatQuiet\(\(\) => \{ const \{ r \} = solAcctsOf\(walletId\);/);
  const ok = src.slice(src.indexOf('  withdrawOk: async (o) => {'), src.indexOf('  html: { esc: escHtml, sub, muted },'));
  assert.match(ok, /if \(!isOwn\(o\.to\)\) \{\n\s+await gate\('withdraw', /, 'an outside address: the withdraw gate');
  assert.match(ok, /title: 'Send outside your vault', danger: true, funds: true, ok: 'Send'/, 'Send\'s own dialog');
  assert.match(ok, /destBox\(o\.to\)/, 'the address in full');
  assert.match(ok, /else \{ await gate\('transfer', [^;]+; await unbackedOk\(\[o\.to\]\); \}/, 'own wallets: the transfer gate');
});

// ── switch-off: a reserve with dollars but no gas asks motion's gas drop first (release 9; a tester's 99.74 USDC on BNB) ──
test('switch-off: a reserve with dollars and no gas (W none to spare) gets motion\'s gas drop, then converts; refused drop = kept, as before', async () => {
  const wd = world({ solver: {}, rEth: 0n, wEth: C.gasFloor }); await on(wd, ['robinhood']);
  const r = await wd.f.off({ walletId: 'w1' });
  const rh = r.chains.find((x) => x.chain === 'robinhood');
  assert.equal(wd.gasAsks.length, 1, 'one gas drop asked'); assert.equal(wd.gasAsks[0].chain, 'robinhood'); assert.equal(lc(wd.gasAsks[0].address), lc(wd.R));
  assert.equal(rh.state, 'sent', JSON.stringify(rh));
  const no = world({ solver: { gasRefuse: true }, rEth: 0n, wEth: C.gasFloor }); await on(no, ['robinhood']);
  const r2 = await no.f.off({ walletId: 'w1' });
  const rh2 = r2.chains.find((x) => x.chain === 'robinhood');
  assert.equal(rh2.state, 'kept'); assert.match(rh2.why, /has none to spare/);
});
