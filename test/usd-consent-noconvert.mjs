// USD balance — a device that is catching up never bundles a conversion into its consent (2026-11-01). The owner, holding about
// $800 as USD balance, got "Turn on USD balance · Convert $179 to dollars · Wallet 1 0.0789 ETH → USDG · …" and asked "why does
// it ask me to convert when I already have $800 USDC?" (owner «я даю добро на все», «мы не можем проебать бабки юзеров никак
// строго»). The grant is per device; a device whose own grant is not live got the FIRST switch-on dialog, whose one button
// both granted and converted. Now:
//   - dollars already in the reserves / a grant here that ran out / the account's newer record this device could not adopt
//     → a one-tap confirm that converts NOTHING, says why it shows; converting is a second, separately labelled button that
//     states its exact amounts, and only that button orders them;
//   - a first switch-on keeps converting as its primary button, with "Turn on without converting" beside it;
//   - whatever is not converted is kept as native: the routine sweep leaves it alone, only what arrives later converts.
// The vault module (src/floatEngine.ts) end to end on a mocked Robinhood frame, the account consent (src/floatConsent.ts)
// between two devices, the planner (src/floatCore.ts). Throwaway keys only, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFloat } from '../src/floatEngine.ts';
import * as F from '../src/floatCore.ts';
import * as CS from '../src/floatConsent.ts';

const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'unwrapWETH9', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
];
const ERC20 = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
const C = F.FLOAT_CFG.robinhood;
const lc = (a) => String(a).toLowerCase();
const ETH_USD = 4000;
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const ETH = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const DAY = 86_400_000;

function mkWallet(id, name, wEth, rUsdg = 0n, rEth = C.reserveGas) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  return { id, name, W_KEY, R_KEY, W: privateKeyToAccount(W_KEY).address, R: privateKeyToAccount(R_KEY).address, wEth, rUsdg, rEth, sol: { W: 'So1W' + id.padEnd(40, '1'), R: 'So1R' + id.padEnd(40, '2') } };
}
// the mocked Robinhood frame of test/float-account.mjs, plus the vault's several-button dialog (`choose`: webEngine askChoice)
function makeWorld(o = {}) {
  const wallets = [...(o.wallets || [])];
  const skipped = o.skipped || [];
  const chain = { eth: new Map(), usdg: new Map(), allow: new Map(), nonces: new Map(), receipts: new Map(), txs: [] };
  const fund = (x) => { chain.eth.set(lc(x.W), x.wEth); chain.eth.set(lc(x.R), x.rEth); chain.usdg.set(lc(x.R), x.rUsdg); };
  wallets.forEach(fund);
  const swap = (from, value, data, apply) => {
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data });
    const outs = []; let routerWeth = 0n;
    for (const inner of args[1]) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data: inner });
      if (d.functionName === 'exactInputSingle') {
        const p = d.args[0]; let out;
        if (lc(p.tokenIn) === lc(C.stable.address)) {
          const al = chain.allow.get(`${lc(from)}>${lc(C.router)}`) ?? 0n;
          if (al < p.amountIn || (chain.usdg.get(lc(from)) ?? 0n) < p.amountIn) throw new Error('execution reverted: STF');
          out = BigInt(Math.floor(Number(p.amountIn) / 1e6 / ETH_USD * 0.9999 * 1e18));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply) { chain.allow.set(`${lc(from)}>${lc(C.router)}`, al - p.amountIn); chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - p.amountIn); }
          routerWeth += out;
        } else {
          assert.equal(value, p.amountIn);
          out = BigInt(Math.floor(Number(p.amountIn) / 1e18 * ETH_USD * 0.9999 * 1e6));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - value); chain.usdg.set(lc(p.recipient), (chain.usdg.get(lc(p.recipient)) ?? 0n) + out); }
        }
        outs.push(encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', result: out }));
      } else {
        if (apply) chain.eth.set(lc(d.args[1]), (chain.eth.get(lc(d.args[1])) ?? 0n) + routerWeth);
        routerWeth = 0n; outs.push('0x');
      }
    }
    return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', result: outs });
  };
  const exec = (from, tx, apply) => {
    if (lc(tx.to) === lc(C.router)) return swap(from, tx.value, tx.data, apply);
    if (lc(tx.to) === lc(C.stable.address)) { const d = decodeFunctionData({ abi: ERC20, data: tx.data }); if (apply) chain.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]); return '0x' + '1'.padStart(64, '0'); }
    if (tx.data === '0x') { if (apply) { chain.eth.set(lc(from), chain.eth.get(lc(from)) - tx.value); chain.eth.set(lc(tx.to), (chain.eth.get(lc(tx.to)) ?? 0n) + tx.value); } return '0x'; }
    throw new Error('test: unexpected call to ' + tx.to);
  };
  const send = (from, tx, gas) => {
    const nonce = chain.nonces.get(lc(from)) ?? 0; const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}:${tx.value}`));
    let status = 'success'; try { exec(from, tx, true); } catch { status = 'reverted'; }
    chain.nonces.set(lc(from), nonce + 1); chain.txs.push({ from, ...tx, gas, hash }); chain.receipts.set(hash, status);
    return hash;
  };
  const byId = (id) => wallets.find((x) => x.id === id);
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: x.sol.W }, r: { evm: x.R, sol: x.sol.R } });
  const store = new Map(); const events = []; const asks = []; const picks = [];
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const deps = {
    chain: () => 'robinhood',
    wallet: (id) => { const x = byId(id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped }),
    evm: {
      call: async (tx) => exec(tx.from, tx, false),
      balance: async (a) => chain.eth.get(lc(a)) ?? 0n,
      erc20: async (t, a) => chain.usdg.get(lc(a)) ?? 0n,
      allowance: async (t, owner, spender) => chain.allow.get(`${lc(owner)}>${lc(spender)}`) ?? 0n,
      slot0: async () => sqrtFor(ETH_USD),
      fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }),
      estimate: async (tx) => { exec(tx.from, tx, false); return 150_000n; },
      sendR: async (walletId, tx, gas) => send(byId(walletId).R, tx, gas),
      sendW: async (walletId, tx, gas) => send(byId(walletId).W, tx, gas),
      receipt: async (h) => (chain.receipts.has(h) ? { status: chain.receipts.get(h) } : null),
    },
    ask: async (a) => { asks.push(a); return o.answer ?? true; },
    ...(o.pick !== undefined ? { choose: async (a) => { picks.push(a); return typeof o.pick === 'function' ? o.pick(a) : o.pick; } } : {}),
    gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => Date.now(),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(),
    emit: (d) => events.push(d),
    fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
    click: () => click,
    wait: async () => {},
  };
  const f = createFloat(deps);
  const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
  return { f, chain, store, events, asks, picks, click, settle, wallets, deps };
}
const quiet = (wd) => { wd.click.lastTradeAt = Date.now() - 120_000; wd.click.ticketAt = Date.now() - 120_000; };
const orderOf = (wd, x, chain = 'robinhood') => JSON.parse(wd.store.get(`trenches.float.v1.order.on.${chain}.${lc(x.W)}`) || 'null');
const keepOf = (wd, x, chain = 'robinhood') => JSON.parse(wd.store.get(`trenches.float.v1.keep.${chain}.${lc(x.W)}`) || 'null');
const orders = (wd) => [...wd.store.keys()].filter((k) => k.startsWith('trenches.float.v1.order.'));
const sweeps = (wd) => wd.chain.txs.filter((t) => lc(t.to) === lc(C.router));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const rowsOf = (html) => [...html.matchAll(/<div class="ub-r"><div class="ub-w"><span class="ub-n">(.*?)<\/span><span class="ub-cs">(.*?)<\/span><\/div><b class="ub-u" translate="no">(.*?)<\/b><\/div>/g)]
  .map((m) => [unesc(m[1]), [...m[2].matchAll(/<span class="ub-c" translate="no">(.*?)<\/span>/g)].map((c) => unesc(c[1])), unesc(m[3])]);
const leadOf = (html) => unesc((html.match(/<p class="ub-lead">(.*?)<\/p>/) || [])[1] ?? '');
const notesOf = (html) => [...html.matchAll(/<p class="ub-note">(.*?)<\/p>/g)].map((m) => unesc(m[1]));
const keyScan = (wd, things) => {
  const blob = JSON.stringify(things, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + [...wd.store.values()].join('|') + JSON.stringify(wd.events) + JSON.stringify(wd.asks) + JSON.stringify(wd.picks);
  for (const x of wd.wallets) for (const k of [x.W_KEY, x.R_KEY]) assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked');
};
// the owner's account: Wallet 1 holds 0.0789 ETH above its gas floor and $800 in its reserve; Wallet 2 nothing; Imported 2 skipped
const owner = (o = {}) => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.0789), 800_000_000n), b = mkWallet('w2', 'Wallet 2', C.gasFloor);
  return { a, b, wd: makeWorld({ wallets: [a, b], skipped: [{ id: 'i2', name: 'Imported 2', why: 'other' }], ...o }) };
};

test('the owner\'s case: $800 already in the USD balance, this device not on — ONE confirm that converts nothing; the conversion is a second button with its exact amounts', async () => {
  const { a, wd } = owner({ pick: 'ok' });
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.equal(wd.asks.length, 0); assert.equal(wd.picks.length, 1);
  const d = wd.picks[0];
  assert.equal(d.title, 'USD balance on this device');
  assert.deepEqual(d.choices, [{ id: 'ok', label: 'Confirm', primary: true }, { id: 'convert', label: 'Confirm and convert $316' }], 'confirm first and primary; converting is its own, labelled button');
  assert.equal(leadOf(d.html), 'You already have $800.00 in your USD balance, but this device has not confirmed it yet. One tap and it works here too.', 'why it shows');
  assert.ok(notesOf(d.html).includes('Nothing is converted: the ETH your wallets hold now stays as it is (only what arrives later converts by itself).'));
  assert.match(d.html, /<p class="ub-skip">Optional: you can also convert \$316 of ETH to dollars now:<\/p>/);
  assert.deepEqual(rowsOf(d.html), [['Wallet 1', ['0.0789 ETH → USDG'], '$316']], 'the second button\'s exact amounts, stated');
  assert.match(d.html, /<details class="ub-more">.*Turn on USD balance for all your wallets \(Wallet 1 and Wallet 2\)/s, 'the whole consent, folded');
  // confirmed without converting: on, nothing ordered, Wallet 1's ETH kept as native
  assert.equal(r.ok, true);
  assert.deepEqual(orders(wd), [], 'no conversion ordered');
  assert.equal(keepOf(wd, a).raw, String(ETH(0.0789)), 'the line the dialog stated is kept as native');
  assert.equal(r.convert.kept, true); assert.equal(r.convert.why, 'device'); assert.deepEqual(r.convert.planned, []);
  assert.deepEqual(r.convert.skipped.filter((s) => s.why === 'kept').map((s) => [s.walletId, s.chain, s.amount]), [['w1', 'robinhood', '0.0789 ETH']]);
  const st = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(st.enabled, true, 'the USD balance is on on this device');
  // the routine sweep (quiet, idle) leaves the kept ETH alone
  quiet(wd);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(sweeps(wd).length, 0, 'nothing swept');
  assert.equal(wd.chain.eth.get(lc(a.W)), C.gasFloor + ETH(0.0789), 'W untouched');
  // what arrives later converts by itself (as the consent says) — only that, never the kept part
  wd.chain.eth.set(lc(a.W), wd.chain.eth.get(lc(a.W)) + ETH(0.5));
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(sweeps(wd).length, 1, 'the deposit is swept');
  assert.ok(sweeps(wd)[0].value <= ETH(0.5), 'never more than what arrived: ' + sweeps(wd)[0].value);
  assert.ok(wd.chain.eth.get(lc(a.W)) >= C.gasFloor + ETH(0.0789), 'the kept ETH is still there');
  keyScan(wd, [r, st]);
});

test('the same dialog, second button: exactly the stated amounts are ordered and converted (the vault\'s rule: shown = converted)', async () => {
  const { a, wd } = owner({ pick: 'convert' });
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  const stated = rowsOf(wd.picks[0].html);
  assert.deepEqual(stated, [['Wallet 1', ['0.0789 ETH → USDG'], '$316']]);
  assert.equal(orderOf(wd, a).max, String(ETH(0.0789)), 'the order carries the stated native amount');
  assert.equal(keepOf(wd, a), null, 'nothing kept');
  assert.equal(r.convert.kept, undefined); assert.deepEqual(r.convert.planned.map((p) => [p.walletId, p.amount]), [['w1', '0.0789 ETH']]);
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(sweeps(wd).length, 1);
  assert.ok(sweeps(wd)[0].value <= ETH(0.0789), 'never above what the dialog stated');
  assert.equal(orderOf(wd, a), null, 'done, never twice');
});

test('an older host without the several-button dialog: the catching-up dialog is a plain confirm, shows no conversion, converts nothing', async () => {
  const { a, wd } = owner();
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.equal(wd.asks.length, 1);
  assert.equal(wd.asks[0].title, 'USD balance on this device'); assert.equal(wd.asks[0].ok, 'Confirm');
  assert.deepEqual(rowsOf(wd.asks[0].html), [], 'no conversion rows: there is no button for them');
  assert.doesNotMatch(wd.asks[0].html, /Optional: you can also convert/);
  assert.deepEqual(orders(wd), []); assert.equal(keepOf(wd, a).raw, String(ETH(0.0789))); assert.equal(r.convert.kept, true);
});

test('closing the dialog changes nothing: no grant, no order, nothing kept', async () => {
  const { wd } = owner({ pick: null });
  await assert.rejects(wd.f.configure({ walletId: 'w1', chains: ['robinhood'] }), /Cancelled/);
  assert.equal(wd.store.get('trenches.float.v1.account') ?? null, null);
  assert.deepEqual([...wd.store.keys()].filter((k) => /\.(perm|order|keep)\./.test(k)), []);
});

test('a first switch-on (no dollars anywhere): converting stays the primary button, and "Turn on without converting" is its own button', async () => {
  for (const pick of ['convert', 'ok']) {
    const a = mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.5));
    const wd = makeWorld({ wallets: [a], pick });
    const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
    const d = wd.picks[0];
    assert.equal(d.title, F.ACCOUNT_DIALOG.en.onTitle);
    assert.deepEqual(d.choices, [{ id: 'convert', label: 'Turn on and convert $2,000', primary: true }, { id: 'ok', label: 'Turn on without converting' }]);
    assert.equal(leadOf(d.html), 'Convert $2,000 to dollars');
    assert.deepEqual(rowsOf(d.html), [['Wallet 1', ['0.50 ETH → USDG'], '$2,000']]);
    if (pick === 'convert') { assert.equal(orderOf(wd, a).max, String(ETH(0.5))); assert.equal(keepOf(wd, a), null); assert.equal(r.convert.why, 'first'); }
    else { assert.deepEqual(orders(wd), []); assert.equal(keepOf(wd, a).raw, String(ETH(0.5))); assert.equal(r.convert.kept, true); }
  }
});

test('a grant of this device that ran out (30 days): the confirm says so, converts nothing by default, starts a new 30 days', async () => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.5));
  const wd = makeWorld({ wallets: [a], pick: 'ok' });
  const t0 = Date.now() - 31 * DAY;
  const caps = F.DEFAULT_CAPS; const ab = { v: 1, chains: ['robinhood'], caps, grantedAt: t0, expiresAt: t0 + 30 * DAY, wallets: [lc(a.W)], rules: F.FLOAT_RULES.current };
  wd.store.set('trenches.float.v1.account', JSON.stringify({ ...ab, digest: F.accountDigest(ab), joined: {} }, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  const d = wd.picks[0];
  assert.equal(d.title, 'USD balance on this device');
  assert.equal(leadOf(d.html), `Your consent for the USD balance ran out on ${F.fmtDay(t0 + 30 * DAY, 'en')} (it lasts 30 days). Confirm to keep it on.`);
  assert.equal(d.choices[0].id, 'ok'); assert.equal(d.choices[0].primary, true);
  assert.deepEqual(orders(wd), []); assert.equal(r.convert.why, 'expired');
  const g = JSON.parse(wd.store.get('trenches.float.v1.account'));
  assert.ok(g.grantedAt >= Date.now() - 5_000 && g.expiresAt === g.grantedAt + 30 * DAY);
});

test('the dialog names why in every language; every word set is complete', () => {
  const keys = Object.keys(F.RESUME.en).sort();
  for (const lang of F.FLOAT_LANGS) {
    const W = F.RESUME[lang];
    assert.deepEqual(Object.keys(W).sort(), keys, lang);
    for (const k of keys) {
      const v = typeof W[k] === 'function' ? W[k]('$316', 'ETH') : W[k];
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.${k}`);
      if (typeof W[k] === 'function' && k !== 'chain1' && k !== 'chainN' && k !== 'keep' && k !== 'expired') assert.ok(v.includes('$316'), `${lang}.${k} states the amount`);
    }
    assert.ok(F.onWhyLines({ kind: 'device', cash6: 800n * F.USD }, lang)[0].includes('$800.00'), lang);
    assert.ok(F.onWhyLines({ kind: 'expired', at: Date.UTC(2026, 9, 31) }, lang)[0].length > 10, lang);
    assert.ok(F.widenLine(['robinhood'], lang).includes('Robinhood'), lang);
  }
  assert.equal(F.widenLine(['robinhood'], 'en'), 'Robinhood is not on yet for this account: this turns it on there too. Nothing is converted.');
  assert.equal(F.onWhyLines({ kind: 'device', cash6: 0n }, 'en')[0], F.RESUME.en.deviceOn);
});

test('a new chain on a live grant: the dialog says which chain is not on yet, and converts nothing (as before)', async () => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.5));
  const wd = makeWorld({ wallets: [a], pick: 'convert' });
  await wd.f.configure({ walletId: 'w1', chains: ['bsc'] });
  for (const k of orders(wd)) wd.store.delete(k);
  await wd.f.configure({ walletId: 'w1', chains: ['bsc', 'robinhood'] });
  // (the first switch-on had nothing it could state for BNB from this Robinhood frame: its plain dialog)
  assert.equal(wd.asks.length, 2, 'the plain consent dialog');
  assert.equal(leadOf(wd.asks[1].html), 'Robinhood is not on yet for this account: this turns it on there too. Nothing is converted.');
  assert.deepEqual(orders(wd), []);
});

test('switching off drops what was kept; a planner state with `keep` sweeps only what is above it', async () => {
  const { a, wd } = owner({ pick: 'ok' });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.ok(keepOf(wd, a));
  wd.deps.ask = async (x) => { wd.asks.push(x); return true; };
  await wd.f.off({ walletId: 'w1' });
  assert.equal(keepOf(wd, a), null);
  // pure planner: W holds $1,000 of trading ETH; the user kept $900 of it
  const st = (over) => ({ price6: 4000n * F.USD, priceAt: Date.now() - 1_000, float: C.gasFloor + ETH(0.25), reserve: 0n, reserveNative: 10n ** 18n, active: false, presets6: [], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: true, busyBridge: false, ...over });
  const plan = (x) => F.planMoves({ now: Date.now(), caps: F.DEFAULT_CAPS, chains: { robinhood: x }, enabled: ['robinhood'], walletUsd6: 1000n * F.USD, movedToday6: 0n, feesToday6: 0n, estFee6: () => 10_000n });
  const sw = (p) => p.moves.filter((m) => m.kind === 'sweep');
  assert.equal(sw(plan(st({}))).length, 1, 'no keep: swept');
  assert.equal(sw(plan(st({ keep: ETH(0.25) }))).length, 0, 'all of it kept: nothing swept');
  const part = sw(plan(st({ keep: ETH(0.225) })));
  assert.equal(part.length, 1); assert.ok(part[0].usd6 <= 100n * F.USD, 'only the $100 above what was kept: ' + part[0].usd6);
});

test('what was kept only shrinks: a spend below it lowers it for good, so a later deposit converts as usual', async () => {
  const { a, wd } = owner({ pick: 'ok' });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  quiet(wd);
  wd.chain.eth.set(lc(a.W), C.gasFloor + ETH(0.03));                     // a buy spent most of it
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.ok(BigInt(keepOf(wd, a)?.raw ?? '0') <= ETH(0.03), 'shrunk to what W still holds above what stays: ' + keepOf(wd, a)?.raw);
  wd.chain.eth.set(lc(a.W), wd.chain.eth.get(lc(a.W)) + ETH(0.3));
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(sweeps(wd).length, 1, 'the deposit converts');
});

// ── the consent that follows the account: the device that could not adopt says why ──
const MAIN = '0x' + 'ab'.repeat(20);
const SEED = '0x' + '5e'.repeat(32);
function device({ wallets, clock, rules }) {
  const store = new Map(); const asks = [];
  const fw = (x) => ({ id: x.id, name: x.name, w: { evm: x.W, sol: 'So1W' + x.id.padEnd(40, '1') }, r: { evm: x.R, sol: 'So1R' + x.id.padEnd(40, '2') } });
  const no = async () => { throw new Error('test: no chain here'); };
  const f = createFloat({
    chain: () => 'robinhood',
    wallet: (id) => { const x = wallets.find((y) => y.id === id); if (!x) throw new Error('Unknown wallet'); return fw(x); },
    wallets: () => ({ list: wallets.map(fw), skipped: [] }),
    evm: { call: no, balance: no, erc20: no, allowance: no, slot0: no, fees: no, estimate: no, sendR: no, sendW: no, receipt: async () => null },
    sol: { balance: no, usdc: no, oracle6: no, fees: no, quote: no, topup: no, sweep: no, gas: no, status: async () => null },
    ask: async (a) => { asks.push(a); return true; },
    choose: async (a) => { asks.push(a); return 'ok'; },
    gate: async () => {},
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now: () => clock.now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    lock: async (k, fn) => fn(), emit: () => {}, fetch: async (u) => { throw new Error('test: unexpected fetch ' + u); },
    click: () => ({ clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: 0, lastTradeAt: 0, limitBusy: false }),
    wait: async () => {},
    ...(rules ? { rules } : {}),
    consent: { sign: async (address, message) => privateKeyToAccount(wallets.find((y) => lc(y.W) === lc(address)).key).signMessage({ message }), changed: () => {}, linked: () => true },
  });
  const own = () => ({ vault: new Set(wallets.map((w) => lc(w.W))) });
  return { f, store, asks, publish: async (srv) => { const r = await CS.consentOutgoing(f.consent, { main: MAIN, seed: SEED, blob: srv.uc, own: own(), now: clock.now }); if (r.blob) srv.uc = r.blob; return r; }, sync: (srv) => CS.consentReceive(f.consent, { main: MAIN, seed: SEED, blob: srv.uc, own: own(), now: clock.now }) };
}
const mk = (i, key = generatePrivateKey()) => ({ id: 'w' + i, name: 'Wallet ' + i, key, W: privateKeyToAccount(key).address, R: privateKeyToAccount(F.reserveKeyOf(key)).address });

test('another device switched on under the older rules: this device cannot adopt it (rules), remembers why, and its dialog is the one-rule confirm — never the first switch-on', async () => {
  const keys = [generatePrivateKey(), generatePrivateKey()];
  const clock = { now: Date.UTC(2026, 9, 28, 9) };
  const srv = { uc: undefined };
  const A = device({ wallets: keys.map((k, i) => mk(i + 1, k)), clock, rules: { current: 1, accepted: 1 } });   // a phone on yesterday's build
  await A.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] });
  await A.publish(srv);
  clock.now += DAY;
  const B = device({ wallets: keys.map((k, i) => mk(i + 1, k)), clock });                                           // the desktop on rules 2
  const v = await B.sync(srv);
  assert.equal(v.action, 'keep'); assert.equal(v.why, 'rules');
  assert.deepEqual(JSON.parse(B.store.get('trenches.float.v1.consent')).kept, { n: 1, why: 'rules', rules: 1 }, 'the device remembers why');
  assert.equal((await B.f.status({ walletId: 'w1', scope: 'account' })).enabled, false);
  const r = await B.f.configure({ walletId: 'w1', chains: ['robinhood', 'bsc', 'sol'] });
  assert.equal(B.asks.length, 1); const d = B.asks[0];
  assert.equal(d.title, 'USD balance on this device');
  assert.equal(leadOf(d.html), F.RESUME.en.rules);
  assert.ok(notesOf(d.html).includes(F.RULES_DELTA[2].en), 'the new rule, word for word');
  assert.match(d.html, /Nothing is converted/);
  assert.equal(r.convert.why, 'rules'); assert.deepEqual(r.convert.planned, []);
  assert.equal((await B.f.status({ walletId: 'w1', scope: 'account' })).enabled, true);
  assert.equal(JSON.parse(B.store.get('trenches.float.v1.consent')).kept, undefined, 'its own yes supersedes what it kept');
});

test('floatConsent: a newer authentic grant that is not adopted reaches host.kept with its reason; an adopted one, a revocation or an older record never does', async () => {
  const k = generatePrivateKey(); const acct = privateKeyToAccount(k); const T = Date.UTC(2026, 9, 30);
  const caps = { perDay6: '1000000000', feesPerDay6: '2000000', perChain6: '250000000', total6: '500000000', maxSlipBps: 50 };
  const rec = async (body) => ({ body, signer: lc(acct.address), sig: await acct.signMessage({ message: CS.consentMessage(body) }) });
  const host = (accepted, local = null) => { const h = { kepts: [], applied: 0, local: () => local, seen() {}, seenMax: () => 0, apply() { h.applied += 1; }, synced() {}, fromLive: async () => null, accepted, kept: (x) => h.kepts.push(x) }; return h; };
  const grant = { v: 1, n: 3, on: true, at: T, chains: ['robinhood'], caps, grantedAt: T, expiresAt: T + 30 * DAY, wallets: [lc(acct.address)] };
  const blob = await CS.sealConsent(MAIN, SEED, await rec(grant));
  const own = { vault: new Set([lc(acct.address)]) };
  const h1 = host(2); const v1 = await CS.consentReceive(h1, { main: MAIN, seed: SEED, blob, own, now: T + 1 });
  assert.equal(v1.why, 'rules'); assert.deepEqual(h1.kepts, [{ n: 3, why: 'rules', rules: 1 }]);
  const h2 = host(1); await CS.consentReceive(h2, { main: MAIN, seed: SEED, blob, own, now: T + 1 });
  assert.equal(h2.applied, 1); assert.deepEqual(h2.kepts, [], 'adopted');
  const h3 = host(1); await CS.consentReceive(h3, { main: MAIN, seed: SEED, blob, own: { vault: new Set() }, now: T + 1 });
  assert.deepEqual(h3.kepts.map((x) => x.why), ['signer'], 'a signer whose key this vault does not hold');
  const h4 = host(1); await CS.consentReceive(h4, { main: MAIN, seed: SEED, blob, own, now: T + 31 * DAY });
  assert.deepEqual(h4.kepts.map((x) => x.why), ['expired']);
  const off = await CS.sealConsent(MAIN, SEED, await rec({ v: 1, n: 4, on: false, at: T }));
  const h5 = host(2); await CS.consentReceive(h5, { main: MAIN, seed: SEED, blob: off, own, now: T + 1 });
  assert.deepEqual(h5.kepts, [], 'a revocation is never "kept"');
  const h6 = host(2, await rec({ ...grant, n: 9 })); await CS.consentReceive(h6, { main: MAIN, seed: SEED, blob, own, now: T + 1 });
  assert.deepEqual(h6.kepts, [], 'an older record is not news');
});

test('wiring: the vault frame hands the float its several-button dialog (askChoice: each button a trusted click on the visible dialog)', () => {
  const WE = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
  const deps = WE.slice(WE.indexOf('const float = createFloat({'), WE.indexOf('const float = createFloat({') + 20_000);
  assert.match(deps, /\n  ask: \(o\) => ask\(o\),\n(?:  \/\/[^\n]*\n)*  choose: \(o\) => askChoice\(o\),\n/);
  // askChoice keeps the trusted-click, visibility and dwell rules for every button it draws
  const ac = WE.slice(WE.indexOf('function askChoice(o: AskOpts)'), WE.indexOf('const COPY_SVG'));
  assert.match(ac, /if \(!e\.isTrusted\) return;/); assert.match(ac, /tooSoon\(openedAt, performance\.now\(\)\)/); assert.match(ac, /The vault dialog is covered or off screen/);
});
