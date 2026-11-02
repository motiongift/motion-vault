// USD balance — ONE switch for the whole account (owner, 2026-10-26: "so you have to turn USDC on for each wallet? Why
// can't it be done for all at once? It looks strange: changed in one, not in the other").
// The vault module (src/floatEngine.ts) end to end on a mocked Robinhood frame holding several wallets (each its own W
// and its own reserve R), plus the pure dialog texts (src/floatCore.ts) in English and Russian. Throwaway keys only,
// nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const ERC20 = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
const C = F.FLOAT_CFG.robinhood;
const lc = (a) => String(a).toLowerCase();
const ETH_USD = 4000;
const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));
const E18 = 10n ** 18n;
const ETH = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;   // 0.675 → wei

// a wallet of the vault: its own W key, its reserve R = HMAC(W key, …), balances on Robinhood
function mkWallet(id, name, wEth, rUsdg = 0n, rEth = C.reserveGas) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  return { id, name, W_KEY, R_KEY, W: privateKeyToAccount(W_KEY).address, R: privateKeyToAccount(R_KEY).address, wEth, rUsdg, rEth, sol: { W: 'So1W' + id.padEnd(40, '1'), R: 'So1R' + id.padEnd(40, '2') } };
}

function makeWorld(o = {}) {
  const wallets = [...(o.wallets || [])];
  const skipped = o.skipped || [];
  const chain = { eth: new Map(), usdg: new Map(), allow: new Map(), nonces: new Map(), receipts: new Map(), txs: [], skewBps: o.skewBps ?? 0, calls: 0 };
  const fund = (x) => { chain.eth.set(lc(x.W), x.wEth); chain.eth.set(lc(x.R), x.rEth); chain.usdg.set(lc(x.R), x.rUsdg); };
  wallets.forEach(fund);
  const price = () => ETH_USD * (1 - chain.skewBps / 10_000);
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
          out = BigInt(Math.floor(Number(p.amountIn) / 1e6 / price() * 0.9999 * 1e18));
          if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
          if (apply) { chain.allow.set(`${lc(from)}>${lc(C.router)}`, al - p.amountIn); chain.usdg.set(lc(from), chain.usdg.get(lc(from)) - p.amountIn); }
          routerWeth += out;
        } else {
          assert.equal(value, p.amountIn);
          out = BigInt(Math.floor(Number(p.amountIn) / 1e18 * price() * 0.9999 * 1e6));
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
    chain.calls += 1;
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
  const store = new Map(); const events = []; const asks = []; let gates = 0;
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: Date.now(), lastTradeAt: Date.now() - 30_000, limitBusy: false };
  const deps = {
    chain: () => 'robinhood',
    wallet: (id) => { const x = byId(id); if (!x) throw new Error(skipped.some((s) => s.id === id) ? 'USD balance works with your vault wallets — a Privy wallet cannot sign here' : 'Unknown wallet'); return fw(x); },
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
    gate: async () => { gates += 1; },
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
  const add = (x) => { wallets.push(x); fund(x); };
  return { f, chain, store, events, asks, gates: () => gates, click, settle, add, wallets, deps };
}
const quiet = (wd) => { wd.click.lastTradeAt = Date.now() - 120_000; wd.click.ticketAt = Date.now() - 120_000; };
const permOf = (wd, x) => JSON.parse(wd.store.get(`trenches.float.v1.perm.${lc(x.W)}`) || 'null');
const orderOf = (wd, x, kind = 'on', chain = 'robinhood') => JSON.parse(wd.store.get(`trenches.float.v1.order.${kind}.${chain}.${lc(x.W)}`) || 'null');
const ethOf = (wd, a) => wd.chain.eth.get(lc(a));
const usdgOf = (wd, a) => wd.chain.usdg.get(lc(a)) ?? 0n;
const keyScan = (wd, things) => {
  const blob = JSON.stringify(things, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + [...wd.store.values()].join('|') + JSON.stringify(wd.events) + JSON.stringify(wd.asks);
  for (const x of wd.wallets) for (const k of [x.W_KEY, x.R_KEY]) assert.ok(!blob.toLowerCase().includes(k.slice(2).toLowerCase()), 'a key leaked');
};

// ── the texts (pure) ──
const NOW = 1_792_950_000_000;
const st = (over = {}) => ({ price6: 2328n * F.USD, priceAt: NOW - 5_000, float: 0n, reserve: 0n, reserveNative: E18, active: false, presets6: [], buys6: [], inFlight6: 0n, inFlightReserve6: 0n, idle: true, busyBridge: false, ...over });

// the dialogs' html: rows as [name, chips, dollars], the muted skip line, the plain sentence, the folded consent
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const rowsOf = (html) => [...html.matchAll(/<div class="ub-r"><div class="ub-w"><span class="ub-n">(.*?)<\/span><span class="ub-cs">(.*?)<\/span><\/div><b class="ub-u" translate="no">(.*?)<\/b><\/div>/g)]
  .map((m) => [unesc(m[1]), [...m[2].matchAll(/<span class="ub-c" translate="no">(.*?)<\/span>/g)].map((c) => unesc(c[1])), unesc(m[3])]);
const leadOf = (html) => unesc((html.match(/<p class="ub-lead">(.*?)<\/p>/) || [])[1] ?? '');
const skipOf = (html) => unesc((html.match(/<p class="ub-skip">(.*?)<\/p>/) || [])[1] ?? '');
const noteOf = (html) => unesc((html.match(/<p class="ub-note">(.*?)<\/p>/) || [])[1] ?? '');
const ESC = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('texts: the switch-on view — one total, a row per converting wallet with a chip per chain, the skips grouped in one line (en)', () => {
  const plan = (x) => F.planConvert(x, ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, NOW);
  const ws = [
    { name: 'Wallet 1', plan: plan({ robinhood: st({ float: C.gasFloor + ETH(0.675) }), bsc: st({ price6: F.usd6(742.31), float: F.FLOAT_CFG.bsc.gasFloor + 1_560_000_000_000_000_000n }), sol: st({ price6: 100n * F.USD, float: 0n }) }) },
    { name: 'Wallet 3', plan: plan({ robinhood: st({ float: C.gasFloor }), bsc: st({ price6: F.usd6(742.31) }), sol: st({ price6: 100n * F.USD, float: F.FLOAT_CFG.sol.gasFloor }) }) },
    { name: 'Wallet 4', plan: plan({ robinhood: st({ float: C.gasFloor + ETH(0.0568) }), bsc: st({ price6: F.usd6(742.31), priceAt: NOW - 120_000 }), sol: st({ price6: 100n * F.USD, float: F.FLOAT_CFG.sol.gasFloor }) }) },
    { name: 'Wallet 5', plan: plan({ robinhood: st({ float: C.gasFloor + ETH(0.1) }), bsc: st({ price6: F.usd6(742.31) }) }) },
  ];
  const v = F.accountConvertView(ws, [{ name: 'Privy', why: 'privy' }], ['robinhood', 'bsc', 'sol']);
  assert.deepEqual(v, {
    lead: 'Convert $3,094 to dollars',
    rows: [
      { name: 'Wallet 1', usd: '$2,729', chips: ['0.675 ETH → USDG', '1.56 BNB → USDC'] },
      { name: 'Wallet 4', usd: '$132', chips: ['0.0568 ETH → USDG'] },
      { name: 'Wallet 5', usd: '$233', chips: ['0.10 ETH → USDG'] },
    ],
    skip: 'Nothing to convert on Wallet 3 · Small amounts stay ready for gas · BNB and Solana prices not read yet (convert later) · Skipped Privy (Privy signs outside the vault)',
    note: 'A little ETH / BNB / SOL stays on each chain so trades stay instant. Deposits later convert by themselves.',
  });
  // chains without a price: said once; one chain: singular; nothing at all to convert
  const two = F.accountConvertView([{ name: 'W', plan: plan({ robinhood: st({ float: C.gasFloor + ETH(0.1) }) }) }], [], ['robinhood', 'bsc', 'sol']);
  assert.equal(two.skip, 'BNB and Solana prices not read yet (convert later)');
  const sol = F.accountConvertView([{ name: 'W', plan: F.planConvert({ robinhood: st({ float: C.gasFloor + ETH(0.1) }) }, ['robinhood', 'sol'], F.DEFAULT_CAPS, NOW) }], [], ['robinhood', 'sol']);
  assert.equal(sol.skip, 'Solana price not read yet (converts later)');
  // the owner's case: a wallet with nothing on the chains read, and a chain not read yet — each said once
  const p2 = (x) => F.planConvert(x, ['robinhood', 'sol'], F.DEFAULT_CAPS, NOW);
  const ex = F.accountConvertView([{ name: 'Wallet 1', plan: p2({ robinhood: st({ float: C.gasFloor + ETH(0.5) }) }) }, { name: 'Wallet 3', plan: p2({ robinhood: st({ float: C.gasFloor }) }) }], [], ['robinhood', 'sol']);
  assert.equal(ex.skip, 'Nothing to convert on Wallet 3 · Solana price not read yet (converts later)');
  const none = F.accountConvertView([{ name: 'Wallet 2', plan: { lines: [], skips: [{ chain: 'robinhood', why: 'below-min' }] } }], [], ['robinhood']);
  assert.equal(none.lead, 'Nothing to convert now'); assert.deepEqual(none.rows, []); assert.equal(none.skip, 'Nothing to convert on Wallet 2');
  // the consent: the rules that hold today, no volume caps (folded under "How it works" in the dialog)
  assert.deepEqual(F.accountPermissionText(['Wallet 1', 'Wallet 2', 'Wallet 4'], ['robinhood', 'bsc', 'sol'], F.DEFAULT_CAPS, F.usd6(0.08)).split('\n'), [
    'Turn on USD balance for all your wallets (Wallet 1, Wallet 2 and Wallet 4). The vault may move money between each wallet\'s own addresses on Robinhood, BNB and Solana to keep it ready to trade:',
    '- a buy tops up first, to what it needs plus 25 %: from that chain\'s reserve, the rest through motion\'s bridge;',
    '- no daily or volume limits, only what your reserves hold; motion\'s bridge moves any amount from $0.10, up to $1,000 per transfer;',
    '- on Robinhood and BNB, a reserve with dollars but no gas gets a little gas from motion (about $0.20, at most once a day per chain);',
    '- USDG / USDC sent straight to a wallet joins its USD balance (from $1);',
    "- a buy you tap in USD may be paid straight from that wallet's own reserve: the reserve buys the coin and it lands in the wallet, in one transaction, within these limits;",
    '- slippage at most 0.50 %.',
    'Expected upkeep: about $0.08 a week per wallet in network and pool fees.',
    'Wallets you add later join by themselves while this is on: their ETH / BNB / SOL converts once the wallet is quiet, and the app tells you.',
    'Nothing else can leave your wallets this way: only a buy you tap is paid to a pool. Ready-to-trade amounts move with the price of ETH / BNB / SOL. Valid for 30 days.',
    'When the money is on another chain, motion may pay you on this one from its own funds as soon as your transfer is included — and if it cannot, your transfer comes straight back.',
  ]);
});

test('texts: the switch-off view — the total going back, a row per wallet, what stays and what was not read in one line (en)', () => {
  const back = (x) => F.planConvertBack(x);
  const v = F.accountOffView([
    { name: 'Wallet 1', plan: back({ robinhood: { reserve: 1_571_200_000n }, bsc: { reserve: 100n * E18 } }), unread: ['sol'] },
    { name: 'Wallet 4', plan: back({ robinhood: { reserve: 132_000_000n }, sol: { reserve: 400_000n } }), unread: [] },
    { name: 'Wallet 2', plan: back({}), unread: ['sol'] },
  ], 50);
  assert.deepEqual(v, {
    lead: 'Convert $1,803 back to ETH / BNB',
    rows: [
      { name: 'Wallet 1', usd: '$1,671', chips: ['$1,571.20 USDG → ETH', '$100.00 USDC → BNB'] },
      { name: 'Wallet 4', usd: '$132', chips: ['$132.00 USDG → ETH'] },
    ],
    skip: 'Under $1.00 stays as USD on Wallet 4 · Solana not read yet (converts back when you turn off with it open)',
    note: 'Each swap is checked against the on-chain price (slippage at most 0.50 %). A little gas stays in each reserve.',
  });
});

test('texts: the same views in Russian (the app sends its language; the vault refuses an unknown one)', () => {
  const ws = [{ name: 'Wallet 1', plan: F.planConvert({ robinhood: st({ float: C.gasFloor + ETH(0.675) }) }, ['robinhood', 'sol'], F.DEFAULT_CAPS, NOW) }];
  assert.deepEqual(F.accountConvertView(ws, [{ name: 'Privy', why: 'privy' }], ['robinhood', 'sol'], 'ru'), {
    lead: 'Конвертировать $1,571 в доллары',
    rows: [{ name: 'Wallet 1', usd: '$1,571', chips: ['0.675 ETH → USDG'] }],
    skip: 'Цена Solana ещё не прочитана (конвертируется позже) · Пропуск: Privy (Privy подписывает вне хранилища)',
    note: 'Немного ETH / SOL остаётся на каждой сети, чтобы сделки шли мгновенно. Новые пополнения конвертируются сами.',
  });
  assert.deepEqual(F.accountPermissionText(['Wallet 1', 'Wallet 4'], ['robinhood', 'sol'], F.DEFAULT_CAPS, F.usd6(0.08), 'ru').split('\n'), [
    'Включить баланс в USD для всех ваших кошельков (Wallet 1 и Wallet 4). Хранилище может переводить деньги между собственными адресами каждого кошелька на Robinhood и Solana, чтобы он был готов к торговле:',
    '- покупка сначала пополняется — на нужную сумму плюс 25 %: из резерва этой сети, остальное через мост motion;',
    '- без дневных лимитов и лимитов объёма, только то, что есть в ваших резервах; мост motion переводит любую сумму от $0.10 до $1,000 за перевод;',
    '- на Robinhood и BNB резерв с долларами, но без газа, получает немного газа от motion (около $0.20, не чаще раза в день на сеть);',
    '- USDG / USDC, отправленные прямо на кошелёк, добавляются к его балансу в USD (от $1);',
    '- покупку, которую вы нажали в USD, может оплатить напрямую собственный резерв кошелька: резерв покупает монету, и она приходит на кошелёк одной транзакцией, в этих пределах;',
    '- проскальзывание не больше 0.50 %.',
    'Ожидаемое обслуживание: около $0.08 в неделю на кошелёк — комиссии сети и пулов.',
    'Кошельки, которые вы добавите позже, подключатся сами, пока это включено: их ETH / SOL конвертируется, когда кошелёк не занят сделками, и приложение об этом скажет.',
    'Иначе так ничего не может уйти из ваших кошельков: в пул платится только покупка, которую нажали вы. Суммы «готово к торговле» меняются вместе с ценой ETH / SOL. Действует 30 дней.',
    'Если деньги на другой сети, motion может заплатить вам на этой из своих средств, как только ваш перевод попадёт в блок, — а если не сможет, ваш перевод сразу вернётся.',
  ]);
  assert.deepEqual(F.accountOffView([{ name: 'Wallet 1', plan: F.planConvertBack({ robinhood: { reserve: 1_571_200_000n } }), unread: ['bsc'] }], 50, 'ru'), {
    lead: 'Вернуть $1,571 обратно в ETH',
    rows: [{ name: 'Wallet 1', usd: '$1,571', chips: ['$1,571.20 USDG → ETH'] }],
    skip: 'BNB: ещё не прочитано (вернётся, если выключить с открытой сетью)',
    note: 'Каждый обмен сверяется с ценой в сети (проскальзывание не больше 0.50 %). В каждом резерве остаётся немного газа.',
  });
  assert.equal(F.ACCOUNT_MORE.ru, 'Как это работает');
  assert.deepEqual(F.ACCOUNT_DIALOG.ru, { onTitle: 'Включить баланс в USD', onOk: 'Включить', offTitle: 'Выключить баланс в USD', offOk: 'Выключить' });
  assert.doesNotThrow(() => F.floatArgs('configure', { walletId: 'w1', chains: ['sol'], lang: 'ru' }));
  assert.throws(() => F.floatArgs('configure', { walletId: 'w1', chains: ['sol'], lang: 'xx' }), /lang/);
  assert.throws(() => F.floatArgs('status', { walletId: 'w1', scope: 'everyone' }), /scope/);
  assert.throws(() => F.floatArgs('off', { walletId: 'w1', to: '0x1' }), /unknown field to/);
  assert.doesNotThrow(() => F.floatArgs('status', { walletId: 'w1', scope: 'account', fresh: true }));
  assert.throws(() => F.floatArgs('status', { walletId: 'w1', fresh: 'yes' }), /fresh/);
});

test('html: the table rows, the one muted skip line, the plain sentence and the folded consent; every wallet name escaped', () => {
  const evil = '<img src=x onerror=alert(1)> & "Bob\'s"';
  const plan = F.planConvert({ robinhood: st({ float: C.gasFloor + ETH(0.5) }), sol: st({ price6: 100n * F.USD, priceAt: NOW - 120_000 }) }, ['robinhood', 'sol'], F.DEFAULT_CAPS, NOW);
  const v = F.accountConvertView([{ name: evil, plan }, { name: 'W2</span><script>', plan: { lines: [], skips: [{ chain: 'robinhood', why: 'below-min' }] } }], [{ name: '<b>Privy</b>', why: 'privy' }], ['robinhood', 'sol']);
  const html = F.dialogViewHtml(v, ESC) + F.consentHtml(F.accountPermissionText([evil, 'W2</span><script>'], ['robinhood', 'sol'], F.DEFAULT_CAPS, F.usd6(0.08)), ESC, F.ACCOUNT_MORE.en);
  assert.ok(!/<img|<script|<b>Privy/.test(html), 'a wallet name reached the dialog unescaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Bob&#39;s&quot;'));
  assert.equal(leadOf(html), 'Convert $1,164 to dollars');
  assert.deepEqual(rowsOf(html), [[evil, ['0.50 ETH → USDG'], '$1,164']]);
  assert.equal(skipOf(html), 'Nothing to convert on W2</span><script> · Solana price not read yet (converts later) · Skipped <b>Privy</b> (Privy signs outside the vault)');
  assert.equal((html.match(/class="ub-skip"/g) || []).length, 1, 'one skip line');
  assert.equal(noteOf(html), 'A little ETH / SOL stays on each chain so trades stay instant. Deposits later convert by themselves.');
  // the consent stays in the dialog, folded: the rules (no volume caps), the upkeep, the later-wallets rule, the 30 days, the bridge
  const det = html.slice(html.indexOf('<details class="ub-more">'));
  assert.ok(det.startsWith('<details class="ub-more"><summary>How it works</summary><div class="ub-more-b">'), det.slice(0, 120));
  assert.ok(det.endsWith('</div></details>'));
  assert.ok(!/a day per wallet|in fees per wallet|ready per chain|with the same limits/.test(det), 'no volume cap is stated');
  for (const re of [/<li>a buy tops up first, to what it needs plus 25 %/, /<li>no daily or volume limits, only what your reserves hold; motion&#39;s bridge moves any amount from \$0\.10, up to \$1,000 per transfer;<\/li>/, /<li>on Robinhood and BNB, a reserve with dollars but no gas gets a little gas from motion/, /<li>USDG \/ USDC sent straight to a wallet joins its USD balance \(from \$1\);<\/li>/, /<li>slippage at most 0\.50 %\.<\/li>/,
    /Expected upkeep: about \$0\.08 a week/, /Wallets you add later join by themselves/, /Valid for 30 days\./, /motion may pay you on this one from its own funds/]) assert.match(det, re);
  assert.ok(!/<details[^>]* open/.test(det), 'folded by default');
  // laid open when the consent is the whole dialog (a caps raise)
  assert.equal(F.consentHtml('A\n- b\nC', ESC), '<div class="ub-open"><p>A</p><ul class="ub-list"><li>b</li></ul><p>C</p></div>');
  // the rules: the classes the html uses, phone sizes, mono amounts, nothing that hides the sheet from the visibility check
  const css = F.FLOAT_DLG_RULES.join('\n');
  for (const k of ['.ub-lead', '.ub-t', '.ub-r', '.ub-n', '.ub-c', '.ub-u', '.ub-skip', '.ub-note', '.ub-more', '@media (max-width:560px)']) assert.ok(css.includes(k), k);
  assert.match(css, /\.ub-c\{font:12px\/1\.25 var\(--mono\)/); assert.match(css, /\.ub-n\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  assert.ok(!/opacity|filter|transform|transition/.test(css), 'IntersectionObserver v2 would count the dialog as hidden');
});

test('the grant carries its digest: a changed grant (caps, chains, dates, wallet list) is not live', () => {
  const base = { v: 1, chains: ['robinhood'], caps: F.DEFAULT_CAPS, grantedAt: NOW, expiresAt: NOW + 86_400_000, wallets: ['0xab'], ...F.rulesField(F.FLOAT_RULES.current) };
  const g = { ...base, digest: F.accountDigest(base) };
  assert.ok(F.accountLive(g, NOW));
  assert.ok(!F.accountLive({ ...g, caps: { ...g.caps, perDay6: 10_000n * F.USD } }, NOW));
  assert.ok(!F.accountLive({ ...g, expiresAt: g.expiresAt + 1 }, NOW));
  assert.ok(!F.accountLive({ ...g, chains: ['robinhood', 'sol'] }, NOW));
  assert.ok(!F.accountLive(g, g.expiresAt + 1), 'expired');
});

// ── the vault end to end ──
const W1 = () => mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.675));
const W2 = () => mkWallet('w2', 'Wallet 2', C.gasFloor + ETH(0.0005));   // $2 above the floor: below the $5 minimum
const W4 = () => mkWallet('w4', 'Wallet 4', C.gasFloor + ETH(0.0568));
const PRIVY = { id: 'p1', name: 'Privy', why: 'privy' };

test('switch on: ONE dialog and ONE gate for every wallet; each wallet\'s conversion and the skipped wallet / chain are stated; every wallet gets its own permission and order', async () => {
  const a = W1(), b = W2(), d = W4();
  const wd = makeWorld({ wallets: [a, b, d], skipped: [PRIVY] });
  const r = await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  assert.equal(wd.asks.length, 1, 'one dialog'); assert.equal(wd.gates(), 1, 'one 2FA gate');
  assert.equal(wd.asks[0].title, 'Turn on USD balance'); assert.equal(wd.asks[0].ok, 'Turn on');
  const html = wd.asks[0].html;
  assert.equal(leadOf(html), 'Convert $2,927 to dollars');
  assert.deepEqual(rowsOf(html), [['Wallet 1', ['0.675 ETH → USDG'], '$2,700'], ['Wallet 4', ['0.0568 ETH → USDG'], '$227']]);
  assert.equal(skipOf(html), 'Nothing to convert on Wallet 2 · Skipped Privy (Privy signs outside the vault)');
  assert.equal(noteOf(html), 'A little ETH stays on each chain so trades stay instant. Deposits later convert by themselves.');
  assert.match(html, /<details class="ub-more"><summary>How it works<\/summary>/, 'the consent is in the dialog, folded');
  assert.match(html, /Turn on USD balance for all your wallets \(Wallet 1, Wallet 2 and Wallet 4\)\./);
  assert.match(html, /<li>no daily or volume limits, only what your reserves hold;/); assert.ok(!/a day per wallet/.test(html), 'no volume cap is stated');
  assert.match(html, /Wallets you add later join by themselves while this is on/);
  assert.equal(wd.chain.txs.length, 0, 'nothing is signed inside configure');
  // one grant, then each wallet's OWN permission (same caps, chains and dates) and its own order
  const grant = JSON.parse(wd.store.get('trenches.float.v1.account'));
  assert.ok(F.accountLive({ ...grant, caps: { perDay6: BigInt(grant.caps.perDay6), feesPerDay6: BigInt(grant.caps.feesPerDay6), perChain6: BigInt(grant.caps.perChain6), total6: BigInt(grant.caps.total6), maxSlipBps: grant.caps.maxSlipBps } }, Date.now()));
  assert.deepEqual(grant.wallets.sort(), [a, b, d].map((x) => lc(x.W)).sort());
  for (const x of [a, b, d]) { const p = permOf(wd, x); assert.equal(lc(p.wallet), lc(x.W)); assert.equal(lc(p.reserve), lc(x.R)); assert.equal(p.grantedAt, grant.grantedAt); assert.equal(p.caps.perDay6, String(F.DEFAULT_CAPS.perDay6)); }
  assert.equal(orderOf(wd, a).max, String(ETH(0.675))); assert.equal(orderOf(wd, d).max, String(ETH(0.0568))); assert.equal(orderOf(wd, b), null, 'Wallet 2: nothing ordered');
  assert.deepEqual(r.convert.planned.map((p) => [p.walletId, p.amount, p.to]), [['w1', '0.675 ETH', 'USDG'], ['w4', '0.0568 ETH', 'USDG']]);
  assert.deepEqual(r.convert.skipped, [{ walletId: 'w2', name: 'Wallet 2', chain: 'robinhood', why: 'below-min' }]);
  assert.deepEqual(r.skipped, [{ walletId: 'p1', name: 'Privy', why: 'privy' }]);
  keyScan(wd, r);
});

test('switch on: each wallet converts its OWN native into its OWN reserve — the page\'s wallet on its tick, the others right behind it; the oracle floor per wallet; never twice', async () => {
  const a = W1(), b = W2(), d = W4();
  const wd = makeWorld({ wallets: [a, b, d] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const sweeps = wd.chain.txs.filter((t) => lc(t.to) === lc(C.router));
  assert.deepEqual(sweeps.map((t) => lc(t.from)), [lc(a.W), lc(d.W)], 'one sweep each, from each wallet\'s own W (Wallet 2 has nothing above its floor)');
  for (const [x, t] of [[a, sweeps[0]], [d, sweeps[1]]]) {
    const inner = decodeFunctionData({ abi: ROUTER_ABI, data: decodeFunctionData({ abi: ROUTER_ABI, data: t.data }).args[1][0] });
    assert.equal(lc(inner.args[0].recipient), lc(x.R), 'paid to that wallet\'s own reserve');
    const job = (await wd.f.jobs({ walletId: x.id })).jobs.find((j) => j.kind === 'sweep');
    assert.equal(job.confirmed, 'on'); assert.equal(inner.args[0].amountOutMinimum, F.minOutFloor('native→stable', BigInt(job.amountIn), 4000n * F.USD, 'robinhood', 50, BigInt(job.fee6)), 'the oracle floor with maxSlipBps');
    assert.equal(ethOf(wd, x.W), C.gasFloor, 'W keeps its gas floor');
  }
  assert.ok(usdgOf(wd, a.R) > 2_690_000_000n && usdgOf(wd, d.R) > 226_000_000n);
  assert.equal(usdgOf(wd, b.R), 0n); assert.equal(ethOf(wd, b.W), C.gasFloor + ETH(0.0005), 'Wallet 2 untouched');
  // the account's status: every wallet's dollars and the total (the snapshots read again behind a first status)
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.snap.')) wd.store.delete(k);
  await wd.f.status({ walletId: 'w1', scope: 'account' }); await wd.settle();
  const s = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(s.scope, 'account'); assert.equal(s.enabled, true);
  assert.deepEqual(s.wallets.map((x) => [x.walletId, x.name, x.enabled]), [['w1', 'Wallet 1', true], ['w2', 'Wallet 2', true], ['w4', 'Wallet 4', true]]);
  const total = s.wallets.reduce((t, x) => t + x.usd.total, 0);
  assert.ok(Math.abs(s.usd.total - total) < 1e-6, `${s.usd.total} vs ${total}`);
  assert.ok(s.usd.cash > 2_916 && s.usd.cash < 2_927.2, String(s.usd.cash));
  // later ticks: no second conversion anywhere
  quiet(wd);   // even when quiet: the targets are met, nothing to sweep
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.filter((t) => lc(t.to) === lc(C.router)).length, 2, 'never twice');
  keyScan(wd, s);
});

test('switch on: a running trade holds every wallet\'s conversion; the price check binds per wallet', async () => {
  const a = W1(), d = W4();
  const wd = makeWorld({ wallets: [a, d], skewBps: 200 });   // the pool pays 2 % fewer dollars than the oracle
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  wd.click.clickAt = Date.now() + 1;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'no conversion while a trade runs'); assert.ok(orderOf(wd, a) && orderOf(wd, d));
  wd.click.clickAt = Date.now() - 4_000; wd.click.clickDoneAt = Date.now() - 3_000;
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.chain.txs.length, 0, 'the price check refused both');
  assert.equal(orderOf(wd, a).tries, 1); assert.equal(orderOf(wd, d).tries, 1, 'each wallet\'s own order keeps its own tries');
});

test('each wallet tops up from its own reserve; no daily volume cap (owner 2026-10-27: only the reserves and the bridge limit a move)', async () => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor, 500_000_000n), d = mkWallet('w4', 'Wallet 4', C.gasFloor, 500_000_000n);
  const wd = makeWorld({ wallets: [a, d] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'], caps: { perDay: 50 } });
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k);
  const r1 = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 50, reason: 'click' });
  const r4 = await wd.f.ensure({ walletId: 'w4', chain: 'robinhood', usd: 50, reason: 'click' });
  const top = (r) => r.planned.find((m) => m.kind === 'topup');
  assert.ok(top(r1).usd >= 50 && top(r4).usd >= 50, 'each click tops up its need + margin');
  assert.ok(usdgOf(wd, a.R) < 500_000_000n && usdgOf(wd, d.R) < 500_000_000n, 'each reserve paid its own wallet');
  await wd.settle();
  // a second click the same day is not stopped by any volume cap (the old $50 a day would have)
  const again = await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', usd: 100, reason: 'click' });
  assert.ok(again.planned.some((m) => m.kind === 'topup' && m.usd > 0.01), JSON.stringify(again.planned));
});

test('a wallet added later joins on its next tick: its own permission from the grant, NO dialog and NO confirmed order; its ETH converts by the routine sweep once quiet; the app\'s notice says so', async () => {
  const a = W1();
  const wd = makeWorld({ wallets: [a] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const before = wd.chain.txs.length;
  const n = mkWallet('w6', 'Wallet 6', C.gasFloor + ETH(0.05));   // $200 of ETH
  wd.add(n);
  // the app ticks its own wallet; Wallet 6 is ticked right behind it — not quiet yet (a ticket touched just now)
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(wd.asks.length, 1, 'no second dialog'); assert.equal(wd.gates(), 1);
  const grant = JSON.parse(wd.store.get('trenches.float.v1.account'));
  const p = permOf(wd, n);
  assert.ok(p, 'joined'); assert.equal(p.grantedAt, grant.grantedAt); assert.equal(p.expiresAt, grant.expiresAt); assert.deepEqual(p.chains, ['robinhood']); assert.equal(p.caps.perDay6, String(F.DEFAULT_CAPS.perDay6));
  assert.ok(F.permissionLive({ ...p, caps: { perDay6: BigInt(p.caps.perDay6), feesPerDay6: BigInt(p.caps.feesPerDay6), perChain6: BigInt(p.caps.perChain6), total6: BigInt(p.caps.total6), maxSlipBps: p.caps.maxSlipBps } }, Date.now()));
  assert.equal(orderOf(wd, n), null, 'no confirmed conversion: nothing was stated to the user about this wallet');
  assert.equal(wd.chain.txs.length, before, 'not quiet: the routine sweep waits (the 60 s quiet rule)');
  assert.ok(wd.events.some((e) => e.walletId === 'w6' && e.step === 'join'));
  let s = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.deepEqual(s.joined.map((j) => [j.walletId, j.name, j.converted]), [['w6', 'Wallet 6', 0]]);
  // quiet: the routine sweep converts it (not confirmed, under the fee cap, oracle-checked)
  quiet(wd);
  for (const k of ['w1', 'w6']) await wd.f.ensure({ walletId: k, chain: 'robinhood', reason: 'tick' });
  await wd.settle();
  const sw = wd.chain.txs.filter((t) => lc(t.from) === lc(n.W) && lc(t.to) === lc(C.router));
  assert.equal(sw.length, 1, 'one sweep from Wallet 6');
  const job = (await wd.f.jobs({ walletId: 'w6' })).jobs.find((j) => j.kind === 'sweep');
  assert.equal(job.confirmed, undefined, 'a routine sweep'); assert.equal(job.reason, 'above high');
  assert.ok(usdgOf(wd, n.R) > 199_000_000n);
  s = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(s.joined[0].walletId, 'w6'); assert.ok(s.joined[0].converted > 199, String(s.joined[0].converted));
  // switched off: a wallet added afterwards does not join
  await wd.f.off({ walletId: 'w1' });
  const offRows = rowsOf(wd.asks[1].html);
  assert.deepEqual(offRows.map((x) => x[0]), ['Wallet 1', 'Wallet 6']);
  assert.match(offRows[0][1][0], /^\$2,699\.\d\d USDG → ETH$/); assert.match(offRows[1][1][0], /^\$199\.\d\d USDG → ETH$/, 'the sweep sent after Wallet 6\'s snapshot: read again before the dialog');
  const late = mkWallet('w7', 'Wallet 7', C.gasFloor + ETH(0.05)); wd.add(late);
  await wd.f.ensure({ walletId: 'w7', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  assert.equal(permOf(wd, late), null);
  keyScan(wd, s);
});

test('switch off: ONE dialog for every wallet\'s dollars; each wallet converts its own reserve back to its own W; the switch and every permission go', async () => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor + ETH(0.01), 1_571_200_000n);
  const b = mkWallet('w2', 'Wallet 2', C.gasFloor + ETH(0.01), 400_000n);          // $0.40: too small, stays
  const d = mkWallet('w4', 'Wallet 4', C.gasFloor + ETH(0.01), 132_000_000n, 0n);   // R has no gas: W pays it first
  const wd = makeWorld({ wallets: [a, b, d] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.order.')) wd.store.delete(k);
  const r = await wd.f.off({ walletId: 'w1', lang: 'en' });
  assert.equal(wd.asks.length, 2); assert.equal(wd.gates(), 2, 'one gate for the switch-off');
  assert.equal(wd.asks[1].title, 'Turn off USD balance'); assert.equal(wd.asks[1].ok, 'Turn off');
  const oh = wd.asks[1].html;
  assert.equal(leadOf(oh), 'Convert $1,703 back to ETH');
  assert.deepEqual(rowsOf(oh), [['Wallet 1', ['$1,571.20 USDG → ETH'], '$1,571'], ['Wallet 4', ['$132.00 USDG → ETH'], '$132']]);
  assert.equal(skipOf(oh), 'Under $1.00 stays as USD on Wallet 2');
  assert.equal(noteOf(oh), 'Each swap is checked against the on-chain price (slippage at most 0.50 %). A little gas stays in each reserve.');
  assert.equal(usdgOf(wd, a.R), 0n); assert.equal(usdgOf(wd, d.R), 0n); assert.equal(usdgOf(wd, b.R), 400_000n);
  // Wallet 4: W → R gas first, then R's approval and swap, all on that wallet's own addresses
  const dTx = wd.chain.txs.filter((t) => [lc(d.W), lc(d.R)].includes(lc(t.from)));
  assert.deepEqual(dTx.map((t) => lc(t.from)), [lc(d.W), lc(d.R), lc(d.R)]);
  assert.ok(ethOf(wd, a.W) > C.gasFloor + ETH(0.01) + ETH(0.39), 'Wallet 1 got its ETH back');
  assert.deepEqual(r.chains.map((c) => [c.walletId, c.chain, c.state]), [['w1', 'robinhood', 'sent'], ['w4', 'robinhood', 'sent'], ['w2', 'robinhood', 'kept']]);
  assert.equal(wd.store.has('trenches.float.v1.account'), false, 'the switch is gone');
  for (const x of [a, b, d]) assert.equal(permOf(wd, x), null);
  const s = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.equal(s.enabled, false); assert.ok(s.wallets.every((x) => !x.enabled));
  keyScan(wd, [r, s]);
});

test('switch off in Russian; cancel keeps everything on; nothing to convert = no dialog for any wallet', async () => {
  const a = mkWallet('w1', 'Wallet 1', C.gasFloor, 50_000_000n), d = mkWallet('w4', 'Wallet 4', C.gasFloor, 0n);
  const wd = makeWorld({ wallets: [a, d], answer: true });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'], lang: 'ru' });
  // Wallet 1's reserve already holds $50 (2026-11-01): this device is catching up, so the dialog is the confirm that converts
  // nothing by default (RESUME), the whole consent still in it, folded
  assert.equal(wd.asks[0].title, 'Баланс в USD на этом устройстве'); assert.match(wd.asks[0].html, /Включить баланс в USD для всех ваших кошельков \(Wallet 1 и Wallet 4\)/);
  wd.deps.ask = async (x) => { wd.asks.push(x); return false; };
  await assert.rejects(wd.f.off({ walletId: 'w1', lang: 'ru' }), /Cancelled/);
  assert.equal(wd.asks[1].title, 'Выключить баланс в USD');
  assert.equal(leadOf(wd.asks[1].html), 'Вернуть $50.00 обратно в ETH');
  assert.deepEqual(rowsOf(wd.asks[1].html), [['Wallet 1', ['$50.00 USDG → ETH'], '$50.00']]);
  assert.ok(permOf(wd, a) && permOf(wd, d) && wd.store.get('trenches.float.v1.account'), 'cancelled: still on');
  const empty = makeWorld({ wallets: [mkWallet('w1', 'Wallet 1', C.gasFloor, 0n), mkWallet('w2', 'Wallet 2', C.gasFloor, 0n)] });
  await empty.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  const r = await empty.f.off({ walletId: 'w2' });
  assert.equal(empty.asks.length, 1, 'only the switch-on dialog'); assert.ok(r.ok);
  assert.equal(empty.store.get('trenches.float.v1.account') ?? null, null);
});

test('the caller must be a wallet of this vault; a Privy caller may switch the account; no eligible wallet = refused', async () => {
  const wd = makeWorld({ wallets: [W1()], skipped: [PRIVY] });
  await assert.rejects(wd.f.configure({ walletId: 'nobody', chains: ['robinhood'] }), /Unknown wallet/);
  await assert.rejects(wd.f.status({ walletId: 'nobody', scope: 'account' }), /Unknown wallet/);
  const r = await wd.f.configure({ walletId: 'p1', chains: ['robinhood'] });
  assert.equal(r.ok, true); assert.equal(wd.asks.length, 1);
  const none = makeWorld({ wallets: [], skipped: [PRIVY] });
  await assert.rejects(none.f.configure({ walletId: 'p1', chains: ['robinhood'] }), /None of your wallets can hold a USD balance/);
});

test('a caps raise asks once for the whole account (no conversion); lowering asks nothing and keeps the waiting conversions', async () => {
  const a = W1(), d = W4();
  const wd = makeWorld({ wallets: [a, d] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  const g0 = JSON.parse(wd.store.get('trenches.float.v1.account'));
  await wd.f.configure({ walletId: 'w4', chains: ['robinhood'], caps: { perDay: 500 } });
  assert.equal(wd.asks.length, 1, 'lowering: no dialog');
  assert.ok(orderOf(wd, a) && orderOf(wd, d), 'the conversions still wait');
  assert.equal(permOf(wd, d).caps.perDay6, String(500n * F.USD)); assert.equal(permOf(wd, a).grantedAt, g0.grantedAt);
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'], caps: { perDay: 800 } });
  assert.equal(wd.asks.length, 2, 'raising: one dialog for every wallet'); assert.ok(wd.asks[1].html.startsWith('<p class="ub-lead">Your limits change to the ones below. Nothing is converted.</p><div class="ub-open"><p>Turn on USD balance for all your wallets'), wd.asks[1].html); assert.doesNotMatch(wd.asks[1].html, /ub-r/);
  assert.equal(permOf(wd, a).caps.perDay6, String(800n * F.USD)); assert.equal(permOf(wd, d).caps.perDay6, String(800n * F.USD));
});

test('switch on: the other wallets\' confirmed conversions run side by side on the fast path (owner 2026-10-26: 3 minutes for one swap of six)', async () => {
  const a = W1(), b = W2(), d = W4();
  const wd = makeWorld({ wallets: [a, b, d] });
  let inHurry = 0, maxInHurry = 0, hurried = 0;
  wd.deps.hurry = async (fn) => { inHurry++; hurried++; maxInHurry = Math.max(maxInHurry, inHurry); try { await new Promise((r) => setImmediate(r)); return await fn(); } finally { inHurry--; } };
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const sweeps = wd.chain.txs.filter((t) => lc(t.to) === lc(C.router));
  assert.deepEqual(sweeps.map((t) => lc(t.from)).sort(), [lc(a.W), lc(d.W)].sort(), 'both converting wallets swapped');
  assert.ok(hurried >= 2, `every confirmed conversion ran on the fast path (${hurried})`);
  assert.ok(maxInHurry >= 1);
});

test('the shown total keeps every chain at its last known snapshot, whatever its age (owner 2026-10-26: $1,600 fell to $112 on the BNB page)', async () => {
  const a = W1();
  const wd = makeWorld({ wallets: [a] });
  await wd.f.configure({ walletId: 'w1', chains: ['robinhood'] });
  await wd.f.ensure({ walletId: 'w1', chain: 'robinhood', reason: 'tick' }); await wd.settle();
  const before = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.ok(before.usd.total > 1000, String(before.usd.total));
  // the snapshot ages past the planner's 10 minutes (the chain's frame has not read it since)
  for (const k of [...wd.store.keys()]) if (k.startsWith('trenches.float.v1.snap.')) { const s = JSON.parse(wd.store.get(k)); s.at = Date.now() - 3_600_000; wd.store.set(k, JSON.stringify(s)); }
  const after = await wd.f.status({ walletId: 'w1', scope: 'account' });
  assert.ok(Math.abs(after.usd.total - before.usd.total) < 1, `${after.usd.total} vs ${before.usd.total}: the old snapshot still counts`);
});
