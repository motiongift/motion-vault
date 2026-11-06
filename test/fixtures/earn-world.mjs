// A mocked Robinhood frame for Earn (fork-style: the vault's real ABI, encoded calls decoded and executed against a stateful
// model of USDG + a Morpho-Vault-V2-like ERC-4626, receipts with the real event topics). Throwaway keys only, nothing leaves the
// process. Knobs: liquidity (partial), gates (paused), revertOnChain (a send that simulated fine reverts on chain), loss (the
// share price drops), evil (the vault mints / pays other amounts than it says), codeHash, lose (a lost send answer).
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData, decodeFunctionResult, keccak256, toHex, multicall3Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { EARN_ABI, EARN_VAULTS, TOPIC, earnTxProblem } from '../../src/earnCore.ts';
import * as F from '../../src/floatCore.ts';

export const CFG = EARN_VAULTS.robinhood;
export const C = F.FLOAT_CFG.robinhood;
export const lc = (a) => String(a).toLowerCase();
const pad = (a) => '0x' + lc(a).replace(/^0x/, '').padStart(64, '0');
const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';
export const ROUTER_ABI = [
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'unwrapWETH9', type: 'function', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
];
export const ETH_USD = 4000;
export const sqrtFor = (usd) => BigInt(Math.floor(Math.sqrt(usd * 1e6 / 1e18) * 2 ** 96));

export function makeEarnWorld(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const V = lc(CFG.vault), A = lc(CFG.asset);
  const st = {
    eth: new Map([[lc(W), o.wEth ?? C.gasFloor], [lc(R), o.rEth ?? C.reserveGas]]),
    usdg: new Map([[lc(R), o.rUsdg ?? 500_000_000n], [V, 1_000_000_000_000n]]),
    allow: new Map(),
    shares: new Map(),
    // the vault: 1,000,000 USDG of assets, 987,901 shares ×1e18 → share price ≈ 1.012246 (the real one on 2026-11-03)
    ta: 1_000_000_000_000n, ts: 987_901_327_358_324_701_000_000n,
    liquidity: o.liquidity ?? 10n ** 15n,   // what the vault can pay out now (USDG raw)
    gates: { receiveSharesGate: ZERO, sendSharesGate: ZERO, receiveAssetsGate: ZERO, sendAssetsGate: ZERO },
    performanceFee: 0n, managementFee: 0n,
    codeHash: o.codeHash ?? CFG.codeHash,
    assetImpl: o.assetImpl ?? CFG.assetImpl,   // USDG's EIP-1967 implementation (r2, L5)
    revertOnChain: o.revertOnChain ?? null,   // 'withdraw' | 'deposit' | 'approve': simulation passes, the mined transaction reverts
    evil: o.evil ?? null,                     // 'mintLess' | 'payLess' | 'noEvent'
    txs: [], receipts: new Map(), nonces: new Map(), calls: 0, reads: 0, sims: 0,
  };
  const convToAssets = (s) => (s * st.ta) / st.ts;
  const convToShares = (a) => (a * st.ts) / st.ta;
  const sharesUp = (a) => (a * st.ts + st.ta - 1n) / st.ta;
  const balOf = (m, a) => m.get(lc(a)) ?? 0n;
  const add = (m, a, d) => m.set(lc(a), balOf(m, a) + d);
  const log = (address, topics, data) => ({ address, topics, data });
  const transferLog = (token, from, to, amount) => log(token, [TOPIC.transfer, pad(from), pad(to)], '0x' + w32(amount));
  // the float's USDG → ETH top-up router (SwapRouter02 multicall: exactInputSingle → unwrapWETH9), as in test/float-engine.mjs
  const swap = (from, value, data, apply) => {
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data });
    const outs = []; let routerWeth = 0n;
    for (const inner of args[1]) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data: inner });
      if (d.functionName === 'exactInputSingle') {
        const p = d.args[0];
        if (lc(p.tokenIn) !== A) throw new Error('test: only the top-up direction here');
        const al = st.allow.get(`${lc(from)}>${lc(C.router)}`) ?? 0n;
        if (al < p.amountIn) throw new Error('execution reverted: STF');
        if (balOf(st.usdg, from) < p.amountIn) throw new Error('execution reverted: STF balance');
        const out = BigInt(Math.floor(Number(p.amountIn) / 1e6 / ETH_USD * 0.9999 * 1e18));
        if (out < p.amountOutMinimum) throw new Error('execution reverted: Too little received');
        if (apply) { st.allow.set(`${lc(from)}>${lc(C.router)}`, al - p.amountIn); add(st.usdg, from, -p.amountIn); }
        routerWeth += out;
        outs.push(encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', result: out }));
      } else { if (apply) add(st.eth, d.args[1], routerWeth); routerWeth = 0n; outs.push('0x'); }
    }
    return { ret: encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', result: outs }), logs: [] };
  };
  // one call: { ret, logs } or throws "execution reverted"
  const exec = (from, tx, apply) => {
    st.calls += 1;
    const to = lc(tx.to); const v = (fn, r) => ({ ret: encodeFunctionResult({ abi: EARN_ABI, functionName: fn, result: r }), logs: [] });
    if (to === lc(C.router)) return swap(from, tx.value, tx.data, apply);
    if (to === A) {
      const d = decodeFunctionData({ abi: EARN_ABI, data: tx.data });
      if (d.functionName === 'balanceOf') return v('balanceOf', balOf(st.usdg, d.args[0]));
      if (d.functionName === 'allowance') return v('allowance', st.allow.get(`${lc(d.args[0])}>${lc(d.args[1])}`) ?? 0n);
      if (d.functionName === 'approve') {
        if (apply) st.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]);
        return { ret: encodeFunctionResult({ abi: EARN_ABI, functionName: 'approve', result: true }), logs: [log(A, ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', pad(from), pad(d.args[0])], '0x' + w32(d.args[1]))] };
      }
      throw new Error('test: unexpected USDG call ' + d.functionName);
    }
    if (to === V) {
      const d = decodeFunctionData({ abi: EARN_ABI, data: tx.data });
      const fn = d.functionName;
      if (fn === 'balanceOf') return v(fn, balOf(st.shares, d.args[0]));
      if (fn === 'convertToAssets') return v(fn, convToAssets(d.args[0]));
      if (fn === 'previewDeposit') return v(fn, convToShares(d.args[0]));
      if (fn === 'previewWithdraw') return v(fn, sharesUp(d.args[0]));
      if (fn === 'asset') return v(fn, CFG.asset);
      if (fn in st.gates) return v(fn, st.gates[fn]);
      if (fn === 'performanceFee' || fn === 'managementFee') return v(fn, st[fn]);
      if (fn === 'maxWithdraw' || fn === 'maxRedeem') return v(fn, 0n);   // Morpho Vault V2: always 0
      if (fn === 'deposit') {
        const [assets, receiver] = d.args;
        if (st.gates.receiveAssetsGate !== ZERO) throw new Error('execution reverted: CannotReceiveAssets');
        const al = st.allow.get(`${lc(from)}>${V}`) ?? 0n;
        if (al < assets) throw new Error('execution reverted: TRANSFER_FROM_FAILED (allowance)');
        if (balOf(st.usdg, from) < assets) throw new Error('execution reverted: TRANSFER_FROM_FAILED (balance)');
        let shares = convToShares(assets); if (shares === 0n) throw new Error('execution reverted: ZeroShares');
        if (apply && st.revertOnChain === 'deposit') throw new Error('execution reverted: on chain');
        const minted = apply && st.evil === 'mintLess' ? shares / 2n : shares;
        if (apply) { st.allow.set(`${lc(from)}>${V}`, al - assets); add(st.usdg, from, -assets); add(st.usdg, V, assets); add(st.shares, receiver, minted); st.ta += assets; st.ts += minted; }
        const logs = [transferLog(A, from, V, assets), transferLog(V, ZERO, receiver, minted), ...(st.evil === 'noEvent' ? [] : [log(V, [TOPIC.deposit, pad(from), pad(receiver)], '0x' + w32(assets) + w32(minted))])];
        return { ret: encodeFunctionResult({ abi: EARN_ABI, functionName: 'deposit', result: shares }), logs };
      }
      if (fn === 'withdraw' || fn === 'redeem') {
        const [amount, receiver, owner] = d.args;
        if (lc(owner) !== lc(from)) throw new Error('execution reverted: arithmetic underflow or overflow');   // no share allowance (the real vault's answer)
        if (st.gates.sendAssetsGate !== ZERO) throw new Error('execution reverted: CannotSendAssets');
        const shares = fn === 'withdraw' ? sharesUp(amount) : amount;
        const assets = fn === 'withdraw' ? amount : convToAssets(amount);
        if (balOf(st.shares, owner) < shares) throw new Error('execution reverted: arithmetic underflow or overflow');
        if (assets > st.liquidity) throw new Error('execution reverted: liquidity');
        if (apply && st.revertOnChain === 'withdraw') throw new Error('execution reverted: on chain');
        const paid = apply && st.evil === 'payLess' ? assets / 2n : assets;
        if (apply) { add(st.shares, owner, -shares); st.ts -= shares; st.ta -= assets; add(st.usdg, V, -paid); add(st.usdg, receiver, paid); st.liquidity -= assets; }
        const logs = [transferLog(V, owner, ZERO, shares), transferLog(A, V, receiver, paid), log(V, [TOPIC.withdraw, pad(from), pad(receiver), pad(owner)], '0x' + w32(assets) + w32(shares))];
        return { ret: encodeFunctionResult({ abi: EARN_ABI, functionName: fn, result: fn === 'withdraw' ? shares : assets }), logs };
      }
      throw new Error('test: unexpected vault call ' + fn);
    }
    if (to === '0xca11bde05977b3631167028862be2a173976ca11') throw new Error('test: multicall goes through multi()');
    throw new Error('test: unexpected call to ' + tx.to);
  };
  // R's signer as webEngine's earnSendR: the allow-list again, then the chain (a reverted transaction still mines)
  const signerChecks = [];
  const send = (from, tx, gas, earn, signed) => {
    if (earn) { const bad = earnTxProblem(tx, { r: R, chainId: 4663, cfg: CFG }); signerChecks.push(bad); if (bad) throw new Error('Refusing to sign: ' + bad); }
    const nonce = st.nonces.get(lc(from)) ?? 0; st.nonces.set(lc(from), nonce + 1); signed?.(nonce);
    const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}`));
    let status = 'success', logs = [];
    const sel = String(tx.data).slice(0, 10);
    try { if (st.revertOnChain === 'approve' && sel === '0x095ea7b3' && lc(tx.to) === A) throw new Error('reverted'); logs = exec(from, tx, true).logs; } catch { status = 'reverted'; logs = []; }
    st.txs.push({ from, ...tx, gas, hash, status, block: BigInt(st.txs.length + 1) });
    st.receipts.set(hash, { status, logs });
    if (o.lose && st.txs.length === o.lose) { const e = Object.assign(new Error('Reserve send outcome unknown (timed out)'), { name: 'FloatUnknown', unknown: true, hash }); throw e; }
    return hash;
  };
  const store = new Map(); const events = []; const asks = []; let gates = 0; let geo = o.geo ?? true;
  const clock = { t: o.now ?? Date.now() };
  const now = () => clock.t;
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: now() - 120_000, lastTradeAt: now() - 120_000, limitBusy: false };
  const wallet = { id: 'w1', name: 'Wallet 1', w: { evm: W, sol: '' }, r: { evm: R, sol: '' } };
  const earnDeps = {
    chain: () => o.lane || 'robinhood',
    chainId: () => 4663,
    wallets: () => [wallet],
    evm: {
      call: async (tx) => { st.sims += 1; return exec(tx.from, tx, false).ret; },
      multi: async (calls) => { st.reads += 1; return calls.map((c) => { try { return exec(ZERO, c, false).ret; } catch { return null; } }); },
      codeHash: async () => st.codeHash,
      storageAt: async (a, slot) => { if (slot !== '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') throw new Error('test: slot'); return lc(a) === A ? pad(st.assetImpl) : pad(ZERO); },
      // r2 (H2): one block per mined transaction; the logs of the successful ones, by exact topics (null = any)
      head: async () => BigInt(st.txs.length),
      logs: async (q) => st.txs.filter((t) => t.status === 'success' && t.block >= q.fromBlock && t.block <= q.toBlock).flatMap((t) => st.receipts.get(t.hash).logs.filter((l) => lc(l.address) === lc(q.address) && q.topics.every((x, i) => x == null || lc(l.topics[i] ?? '') === lc(x))).map((l) => ({ tx: t.hash, topics: l.topics, data: l.data }))),
      balance: async (a) => balOf(st.eth, a),
      gasPrice: async () => 25_000_000n,
      estimate: async (tx) => { exec(tx.from, tx, false); return 200_000n; },
      send: async (walletId, tx, gas, signed) => send(R, tx, gas, true, signed),
      // r4: receipts carry their block; receiptCheck tells 'missing' (answered: not known) from null (st.silent: no answer);
      // a block's hash changes with st.reorgSalt (a reorg)
      receipt: async (h) => { const r = st.receipts.get(h); if (!r) return null; const t = st.txs.find((x) => x.hash === h); return { ...r, ...(t ? { blockNumber: t.block, blockHash: keccak256(toHex('block:' + t.block)) } : {}) }; },
      receiptCheck: async (h) => { if (st.silent) return null; const r = st.receipts.get(h); if (!r) return 'missing'; const t = st.txs.find((x) => x.hash === h); return { ...r, ...(t ? { blockNumber: t.block, blockHash: keccak256(toHex('block:' + t.block)) } : {}) }; },
      blockHash: async (n) => (st.silent ? null : keccak256(toHex('block:' + n + (st.reorgSalt ?? '')))),
      // r5: R's confirmed nonce (its mined transactions); st.nonceStuck: a node that keeps answering the old one
      nonce: async (a) => (st.nonceStuck != null ? st.nonceStuck : st.txs.filter((t) => lc(t.from) === lc(a)).length),
    },
    geo: async () => geo,
    ask: async (a) => { asks.push(a); return o.answer ?? true; },
    gate: async () => { gates += 1; },
    esc: (v) => String(v),
    now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), del: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) },
    emit: (d) => events.push(d),
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    busy: () => F.inClickWindow(click, now()),
    tradeLive: () => click.clickAt > click.clickDoneAt,
  };
  // the USD balance's deps on the same chain (createFloat), sharing the store, the clock and the chain
  const floatDeps = {
    chain: () => o.lane || 'robinhood',
    wallet: (id) => { if (id !== 'w1') throw new Error('Unknown wallet'); return wallet; },
    wallets: () => ({ list: [wallet], skipped: [] }),
    evm: {
      call: async (tx) => exec(tx.from, tx, false).ret,
      balance: async (a) => balOf(st.eth, a),
      erc20: async (t, a) => balOf(st.usdg, a),
      allowance: async (t, owner, spender) => st.allow.get(`${lc(owner)}>${lc(spender)}`) ?? 0n,
      slot0: async () => sqrtFor(ETH_USD),
      fees: async () => ({ baseFee: 20_000_000n, gasPrice: 20_000_000n, l1PerByte: 0n }),
      estimate: async (tx) => { exec(tx.from, tx, false); return 150_000n; },
      codeHash: async () => '0x',
      sendR: async (walletId, tx, gas) => send(R, tx, gas, false),
      sendW: async (walletId, tx, gas) => send(W, tx, gas, false),
      receipt: async (h) => (st.receipts.has(h) ? { status: st.receipts.get(h).status } : null),
    },
    ask: async (a) => { asks.push(a); return o.answer ?? true; },
    gate: async () => { gates += 1; },
    html: { esc: (v) => String(v), sub: (h) => `<p>${h}</p>`, muted: (h) => `<i>${h}</i>` },
    now,
    store: earnDeps.store,
    lock: async (k, fn) => fn(),
    emit: (d) => events.push(d),
    fetch: async (u) => { throw new Error('test: no fetch expected: ' + u); },
    click: () => click,
    wait: async () => {},
  };
  return { st, W, R, W_KEY, R_KEY, wallet, store, events, asks, gates: () => gates, click, clock, earnDeps, floatDeps, exec, signerChecks, setGeo: (g) => { geo = g; } };
}
// what the vault holds for R, in USDG raw, by the model
export const assetsOfR = (wd) => ((wd.st.shares.get(lc(wd.R)) ?? 0n) * wd.st.ta) / wd.st.ts;
export const decodeEarnTx = (tx) => { try { return decodeFunctionData({ abi: EARN_ABI, data: tx.data }); } catch { return null; } };
export { encodeFunctionData, decodeFunctionResult, multicall3Abi };
