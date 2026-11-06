// Mocked BNB (Aave v3) and Solana (Kamino) frames for Earn — fork-style: the real ABIs / instruction layouts decoded and executed
// against stateful models (USDC + Pool + aToken with a growing liquidity index and the real event topics; klend's Reserve
// account bytes in the IDL 1.27.0 layout + SPL token accounts, deposits / redeems at the reserve's exchange rate). Throwaway keys
// only; nothing leaves the process. Knobs: liquidity (partial), paused / frozen, impl (an upgrade), revertOnChain / failOnChain,
// evil (another amount than recorded), loss (index / exchange rate down), status (Kamino reserve status), emergency.
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { AAVE_BSC, AAVE_ABI, AAVE_TOPIC, AAVE_SELECTORS, aaveTxProblem, EIP1967_IMPL } from '../../src/earnAave.ts';
import { KAMINO_SOL, KAMINO_DISC, RESERVE_DISC, RESERVE_SIZE, OFF, MARKET_EMERGENCY, kaminoIxsProblem } from '../../src/earnKamino.ts';
import { EARN } from '../../src/earnCore.ts';
import { b58d, b58e, ataOf } from '../../src/solEngine.ts';
import * as F from '../../src/floatCore.ts';

export const lc = (a) => String(a).toLowerCase();
const pad = (a) => '0x' + lc(a).replace(/^0x/, '').padStart(64, '0');
const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';
const RAY = 10n ** 27n;

// ── BNB: Aave v3 ──
export function makeAaveWorld(o = {}) {
  const W_KEY = generatePrivateKey(); const R_KEY = F.reserveKeyOf(W_KEY);
  const W = privateKeyToAccount(W_KEY).address, R = privateKeyToAccount(R_KEY).address;
  const C = AAVE_BSC; const P = lc(C.pool), A = lc(C.asset), AT = lc(C.aToken);
  const st = {
    usdc: new Map([[lc(R), o.rUsdc ?? 500n * 10n ** 18n], [AT, o.liquidity ?? 1_000_000n * 10n ** 18n]]),
    allow: new Map(), scaled: new Map(), index: RAY + RAY / 8n, rate: 51_534_128_611_494_068_248_343_088n,
    active: true, frozen: false, paused: false, poolImpl: C.poolImpl, aTokenImpl: C.aTokenImpl, assetImpl: o.assetImpl ?? C.assetImpl, provider: C.addressesProvider,
    // r2 (M7): the Pool's virtual balance (what it pays out of); null = USDC.balanceOf(aToken)
    virtual: o.virtual ?? null,
    revertOnChain: o.revertOnChain ?? null, evil: o.evil ?? null, txs: [], receipts: new Map(), nonces: new Map(), reads: 0, sims: 0, rEth: o.rEth ?? 10n ** 16n,
  };
  const balOf = (m, a) => m.get(lc(a)) ?? 0n; const add = (m, a, d) => m.set(lc(a), balOf(m, a) + d);
  const aBal = (a) => (balOf(st.scaled, a) * st.index) / RAY;
  const cfgWord = () => { let c = 0n; if (st.active) c |= 1n << 56n; if (st.frozen) c |= 1n << 57n; if (st.paused) c |= 1n << 60n; c |= 18n << 48n; return c; };
  const reserveData = () => '0x' + [cfgWord(), st.index, st.rate, 0n, 0n, 0n, 0n, 0n, BigInt(AT), 0n, 0n, 0n, 0n, 0n, 0n].map(w32).join('');
  const v = (fn, r) => ({ ret: encodeFunctionResult({ abi: AAVE_ABI, functionName: fn, result: r }), logs: [] });
  const exec = (from, tx, apply) => {
    const to = lc(tx.to);
    if (to === A) {
      const d = decodeFunctionData({ abi: AAVE_ABI, data: tx.data });
      if (d.functionName === 'balanceOf') return v('balanceOf', balOf(st.usdc, d.args[0]));
      if (d.functionName === 'allowance') return v('allowance', st.allow.get(`${lc(d.args[0])}>${lc(d.args[1])}`) ?? 0n);
      if (d.functionName === 'approve') { if (apply) st.allow.set(`${lc(from)}>${lc(d.args[0])}`, d.args[1]); return v('approve', true); }
      throw new Error('test: USDC ' + d.functionName);
    }
    if (to === AT) {
      const d = decodeFunctionData({ abi: AAVE_ABI, data: tx.data });
      if (d.functionName === 'balanceOf') return v('balanceOf', aBal(d.args[0]));
      if (d.functionName === 'UNDERLYING_ASSET_ADDRESS') return v('UNDERLYING_ASSET_ADDRESS', C.asset);
      if (d.functionName === 'POOL') return v('POOL', C.pool);
      throw new Error('test: aToken ' + d.functionName);
    }
    if (to === P) {
      if (tx.data.startsWith('0x35ea6a75')) return { ret: reserveData(), logs: [] };
      const d = decodeFunctionData({ abi: AAVE_ABI, data: tx.data });
      if (d.functionName === 'getVirtualUnderlyingBalance') return v('getVirtualUnderlyingBalance', st.virtualRead ?? st.virtual ?? balOf(st.usdc, AT));   // virtualRead: a read that says more than the Pool pays (the halving test)
      if (d.functionName === 'ADDRESSES_PROVIDER') return v('ADDRESSES_PROVIDER', st.provider);
      if (d.functionName === 'supply') {
        const [asset, amount, onBehalfOf] = d.args;
        if (lc(asset) !== A) throw new Error('execution reverted: asset');
        if (!st.active || st.paused || st.frozen) throw new Error('execution reverted: RESERVE_FROZEN/PAUSED');
        const al = st.allow.get(`${lc(from)}>${P}`) ?? 0n; if (al < amount) throw new Error('execution reverted: allowance');
        if (balOf(st.usdc, from) < amount) throw new Error('execution reverted: balance');
        if (apply && st.revertOnChain === 'supply') throw new Error('reverted');
        if (apply) { st.allow.set(`${lc(from)}>${P}`, al - amount); add(st.usdc, from, -amount); add(st.usdc, AT, amount); add(st.scaled, onBehalfOf, (amount * RAY) / st.index); }
        const recorded = st.evil === 'supplyLess' ? amount - 1n : amount;
        return { ret: '0x', logs: [{ address: C.asset, topics: [AAVE_TOPIC.transfer, pad(from), pad(AT)], data: '0x' + w32(amount) }, { address: C.pool, topics: [AAVE_TOPIC.supply, pad(A), pad(onBehalfOf), pad('0x0')], data: '0x' + w32(BigInt(from)) + w32(recorded) }] };
      }
      if (d.functionName === 'withdraw') {
        const [asset, amt, to2] = d.args;
        if (lc(asset) !== A) throw new Error('execution reverted: asset');
        if (!st.active || st.paused) throw new Error('execution reverted: RESERVE_PAUSED');
        const have = aBal(from); const amount = amt === (1n << 256n) - 1n ? have : amt;
        if (amount > have) throw new Error('execution reverted: NOT_ENOUGH_AVAILABLE_USER_BALANCE');
        if (amount > (st.virtual ?? balOf(st.usdc, AT))) throw new Error('execution reverted: liquidity');
        if (apply && st.revertOnChain === 'withdraw') throw new Error('reverted');
        const paid = st.evil === 'payLess' && apply ? amount / 2n : amount;
        if (apply) { add(st.scaled, from, -((amount * RAY + st.index - 1n) / st.index)); if (balOf(st.scaled, from) < 0n) st.scaled.set(lc(from), 0n); add(st.usdc, AT, -paid); add(st.usdc, to2, paid); if (st.virtual != null) st.virtual -= amount; }
        return { ret: encodeFunctionResult({ abi: AAVE_ABI, functionName: 'withdraw', result: amount }), logs: [{ address: C.pool, topics: [AAVE_TOPIC.withdraw, pad(A), pad(from), pad(to2)], data: '0x' + w32(amount) }, { address: C.asset, topics: [AAVE_TOPIC.transfer, pad(AT), pad(to2)], data: '0x' + w32(paid) }] };
      }
      throw new Error('test: Pool ' + d.functionName);
    }
    throw new Error('test: unexpected call ' + tx.to);
  };
  const signerChecks = [];
  const send = (from, tx, gas, signed) => {
    const bad = aaveTxProblem(tx, { r: R, chainId: 56, cfg: C, perTxMax6: EARN.perTxMax6, withdrawMax6: EARN.withdrawMax6 }); signerChecks.push(bad); if (bad) throw new Error('Refusing to sign: ' + bad);
    const nonce = st.nonces.get(lc(from)) ?? 0; st.nonces.set(lc(from), nonce + 1); signed?.(nonce);
    const hash = keccak256(toHex(`${from}:${nonce}:${tx.data}`));
    let status = 'success', logs = [];
    try { logs = exec(from, tx, true).logs; } catch { status = 'reverted'; }
    st.txs.push({ from, ...tx, gas, hash, status, block: BigInt(st.txs.length + 1) }); st.receipts.set(hash, { status, logs });
    return hash;
  };
  const store = new Map(); const events = []; const asks = []; let gates = 0;
  const clock = { t: o.now ?? Date.now() }; const now = () => clock.t;
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: now() - 120_000, lastTradeAt: now() - 120_000, limitBusy: false };
  const wallet = { id: 'w1', name: 'Wallet 1', w: { evm: W, sol: '' }, r: { evm: R, sol: 'So1R' + '2'.repeat(40) } };
  const earnDeps = {
    chain: () => 'bsc', chainId: () => 56, wallets: () => [wallet],
    evm: {
      call: async (tx) => { st.sims += 1; return exec(tx.from, tx, false).ret; },
      multi: async (calls) => { st.reads += 1; return calls.map((c) => { try { return exec(ZERO, c, false).ret; } catch { return null; } }); },
      codeHash: async () => '0x',
      storageAt: async (a, slot) => { if (slot !== EIP1967_IMPL) throw new Error('slot'); return pad(lc(a) === P ? st.poolImpl : lc(a) === AT ? st.aTokenImpl : lc(a) === A ? st.assetImpl : ZERO); },
      head: async () => BigInt(st.txs.length),
      logs: async (q) => st.txs.filter((t) => t.status === 'success' && t.block >= q.fromBlock && t.block <= q.toBlock).flatMap((t) => st.receipts.get(t.hash).logs.filter((l) => lc(l.address) === lc(q.address) && q.topics.every((x, i) => x == null || lc(l.topics[i] ?? '') === lc(x))).map((l) => ({ tx: t.hash, topics: l.topics, data: l.data }))),
      balance: async () => st.rEth, gasPrice: async () => 100_000_000n,
      estimate: async (tx) => { exec(tx.from, tx, false); return 250_000n; },
      send: async (walletId, tx, gas, signed) => send(R, tx, gas, signed),
      // r4: receipts carry their block; receiptCheck tells 'missing' (answered: not known) from null (st.silent: no answer);
      // a block's hash changes with st.reorgSalt (a reorg)
      receipt: async (h) => { const r = st.receipts.get(h); if (!r) return null; const t = st.txs.find((x) => x.hash === h); return { ...r, ...(t ? { blockNumber: t.block, blockHash: keccak256(toHex('block:' + t.block)) } : {}) }; },
      receiptCheck: async (h) => { if (st.silent) return null; const r = st.receipts.get(h); if (!r) return 'missing'; const t = st.txs.find((x) => x.hash === h); return { ...r, ...(t ? { blockNumber: t.block, blockHash: keccak256(toHex('block:' + t.block)) } : {}) }; },
      blockHash: async (n) => (st.silent ? null : keccak256(toHex('block:' + n + (st.reorgSalt ?? '')))),
      // r5: R's confirmed nonce (its mined transactions); st.nonceStuck: a node that keeps answering the old one
      nonce: async (a) => (st.nonceStuck != null ? st.nonceStuck : st.txs.filter((t) => lc(t.from) === lc(a)).length),
    },
    monitor: o.monitor, geo: async () => true,
    ask: async (a) => { asks.push(a); return true; }, gate: async () => { gates += 1; },
    esc: (x) => String(x), now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v2) => store.set(k, v2), del: (k) => store.delete(k) },
    emit: (d) => events.push(d), wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    busy: () => F.inClickWindow(click, now()), tradeLive: () => click.clickAt > click.clickDoneAt,
  };
  return { st, W, R, wallet, store, events, asks, click, clock, earnDeps, signerChecks, exec, aBal: () => aBal(R), gates: () => gates };
}

// ── Solana: Kamino ──
const putPk = (d, o, pk) => d.set(b58d(pk).length === 32 ? b58d(pk) : (() => { const b = new Uint8Array(32); const x = b58d(pk); b.set(x, 32 - x.length); return b; })(), o);
const putU64 = (d, o, v) => new DataView(d.buffer).setBigUint64(o, BigInt(v), true);
const putU128 = (d, o, v) => { putU64(d, o, BigInt(v) & ((1n << 64n) - 1n)); putU64(d, o + 8, BigInt(v) >> 64n); };
const getU64 = (d, o) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
export function makeKaminoWorld(o = {}) {
  const C = KAMINO_SOL;
  // R's Solana address: any valid base58 32-byte key (a throwaway)
  const R = b58e(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255));
  const W = b58e(Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 255));
  const rUsdc = ataOf(R, C.mint), rC = ataOf(R, C.cMint);
  const st = { available: o.available ?? 41_680_960_928_856n, borrowed: 120_214_612_314_470n, cSupply: 133_885_335_077_031n, usdc: o.rUsdc ?? 500_000_000n, c: 0n, cExists: false, usdcExists: true,
    status: 0, emergency: 0, marketEmergency: 0, scope: C.scope, deploySlot: C.deploySlot, lamports: o.lamports ?? 10_000_000n, failOnChain: o.failOnChain ?? null, evil: o.evil ?? null, sigs: new Map(), sent: [], reads: 0, sims: 0, simErr: null };
  const total = () => st.available + st.borrowed;
  const reserveBytes = () => {
    const d = new Uint8Array(RESERVE_SIZE); d.set(RESERVE_DISC, 0);
    putPk(d, OFF.lendingMarket, C.market); putPk(d, OFF.mint, C.mint); putPk(d, OFF.supplyVault, C.supplyVault); putPk(d, OFF.cMint, C.cMint); putPk(d, OFF.tokenProgram, C.tokenProgram);
    putU64(d, OFF.available, st.available); putU128(d, OFF.borrowedSf, st.borrowed << 60n); putU64(d, OFF.mintDecimals, 6n); putU64(d, OFF.cSupply, st.cSupply);
    d[OFF.status] = st.status; d[OFF.emergency] = st.emergency; putU64(d, OFF.depositLimit, 10n ** 15n);
    putPk(d, OFF.scope, st.scope); putPk(d, OFF.sbPrice, C.systemProgram); putPk(d, OFF.sbTwap, C.systemProgram); putPk(d, OFF.pyth, C.systemProgram);
    return d;
  };
  const tokenBytes = (mint, owner, amount) => { const d = new Uint8Array(165); putPk(d, 0, mint); putPk(d, 32, owner); putU64(d, 64, amount); return d; };
  const marketBytes = () => { const d = new Uint8Array(4664); d[MARKET_EMERGENCY] = st.marketEmergency; return d; };
  const accountOf = (a) => {
    if (a === C.reserve) return { owner: C.program, data: reserveBytes(), lamports: 1 };
    if (a === C.market) return { owner: C.program, data: marketBytes(), lamports: 1 };
    if (a === rUsdc) return st.usdcExists ? { owner: C.tokenProgram, data: tokenBytes(C.mint, R, st.usdc), lamports: 2_039_280 } : null;
    if (a === rC) return st.cExists ? { owner: C.tokenProgram, data: tokenBytes(C.cMint, R, st.c), lamports: 2_039_280 } : null;
    if (a === R) return { owner: C.systemProgram, data: new Uint8Array(0), lamports: Number(st.lamports) };
    return null;
  };
  // run the step against the model: { usdc, c, available, cSupply } after it, or an error
  const run = (ixs) => {
    const s = { usdc: st.usdc, c: st.c, available: st.available, cSupply: st.cSupply, cExists: st.cExists, usdcExists: st.usdcExists };
    for (const ix of ixs) {
      if (ix.program === C.ataProgram) { if (ix.keys[1][0] === rC) s.cExists = true; if (ix.keys[1][0] === rUsdc) s.usdcExists = true; continue; }
      if (ix.program !== C.program) return { err: 'program' };
      const disc = Array.from(ix.data.subarray(0, 8));
      if (disc.every((x, i) => x === KAMINO_DISC.refresh[i])) { if (ix.keys[5][0] !== st.scope) return { err: { Custom: 6009 } }; continue; }
      if (st.status !== 0 || st.emergency || st.marketEmergency) return { err: { Custom: 6036 } };
      const amount = getU64(ix.data, 8); const tot = s.available + st.borrowed;
      if (disc.every((x, i) => x === KAMINO_DISC.deposit[i])) {
        if (ix.keys[5][0] !== C.supplyVault) return { err: { Custom: 2012 } };
        if (s.usdc < amount) return { err: { Custom: 1 } };
        const minted = (amount * s.cSupply) / tot;
        s.usdc -= amount; s.available += amount; s.c += st.evil === 'mintLess' ? minted / 2n : minted; s.cSupply += minted;
        continue;
      }
      if (disc.every((x, i) => x === KAMINO_DISC.redeem[i])) {
        if (s.c < amount) return { err: { Custom: 1 } };
        const out = (amount * tot) / s.cSupply;
        if (out > s.available) return { err: { Custom: 6015 } };
        s.c -= amount; s.cSupply -= amount; s.available -= out; s.usdc += st.evil === 'payLess' ? out / 2n : out;
        continue;
      }
      return { err: 'ix' };
    }
    return { s };
  };
  const ctxOf = (ixs) => { const k = ixs[1]?.keys; return { r: R, rUsdc, rCtoken: rC, oracles: { pyth: null, sbPrice: null, sbTwap: null, scope: k ? k[5][0] : null }, perTxMax6: EARN.perTxMax6 }; };
  const store = new Map(); const events = []; const asks = [];
  const clock = { t: o.now ?? Date.now() }; const now = () => clock.t;
  const click = { clickAt: 0, clickDoneAt: 0, focusAt: 0, focusChain: null, hidden: false, ticketAt: now() - 120_000, lastTradeAt: now() - 120_000, limitBusy: false };
  const wallet = { id: 'w1', name: 'Wallet 1', w: { evm: '0x' + '11'.repeat(20), sol: W }, r: { evm: '0x' + '22'.repeat(20), sol: R } };
  let n = 0;
  const earnDeps = {
    chain: () => 'sol', chainId: () => 0, wallets: () => [wallet],
    sol: {
      accounts: async (addrs) => { st.reads += 1; if (o.readFails && o.readFails()) throw new Error('rpc down'); return addrs.map(accountOf); },
      deploySlot: async () => st.deploySlot,
      ata: (owner, mint) => ataOf(owner, mint),
      simulate: async (walletId, ixs, watch) => {
        st.sims += 1;
        const bad = kaminoIxsProblem(ixs, ctxOf(ixs)); if (bad) throw new Error('Refusing to sign: ' + bad);
        if (st.simErr) return { err: st.simErr, post: [] };
        const r = run(ixs); if (r.err) return { err: r.err, post: [] };
        return { err: null, post: watch.map((a) => (a === rUsdc ? (r.s.usdcExists ? tokenBytes(C.mint, R, r.s.usdc) : null) : a === rC ? (r.s.cExists ? tokenBytes(C.cMint, R, r.s.c) : null) : null)) };
      },
      send: async (walletId, ixs) => {
        const bad = kaminoIxsProblem(ixs, ctxOf(ixs)); if (bad) throw new Error('Refusing to sign: ' + bad);
        const sig = 'sig' + ++n + 'x'.repeat(80);
        st.sent.push({ ixs, sig, at: now(), signer: R });   // R signs its own (r3: a stranger's entry has no signer)
        if (st.failOnChain) { st.sigs.set(sig, 'failed'); return sig; }
        const r = run(ixs); if (r.err) throw new Error('Simulation failed: ' + JSON.stringify(r.err));
        Object.assign(st, { usdc: r.s.usdc, c: r.s.c, available: r.s.available, cSupply: r.s.cSupply, cExists: r.s.cExists, usdcExists: r.s.usdcExists });
        st.sigs.set(sig, o.lostStatus ? null : 'confirmed');
        if (o.loseSend && st.sent.length === o.loseSend) throw Object.assign(new Error('Solana send outcome unknown'), { name: 'SolSendUnknown', hash: sig });
        return sig;
      },
      status: async (sig) => st.sigs.get(sig) ?? null,
      signers: async (sig) => { st.signerReads = (st.signerReads ?? 0) + 1; const x = st.sent.find((y) => y.sig === sig); return x ? [x.signer ?? 'Stranger1111111111111111111111111111111111'] : null; },
      signatures: async (addr, until, before) => { st.sigPages = (st.sigPages ?? 0) + 1; if (addr !== rC) return []; let all = st.sent.filter((x) => st.sigs.get(x.sig) != null).map((x) => ({ sig: x.sig, err: st.sigs.get(x.sig) === 'failed', at: Math.floor(x.at / 1000) })).reverse(); const i = until ? all.findIndex((x) => x.sig === until) : -1; if (i >= 0) all = all.slice(0, i); const j = before ? all.findIndex((x) => x.sig === before) : -1; if (before) all = j >= 0 ? all.slice(j + 1) : []; return all.slice(0, 100); },
    },
    monitor: o.monitor, geo: async () => true,
    ask: async (a) => { asks.push(a); return true; }, gate: async () => {},
    esc: (x) => String(x), now,
    store: { get: (k) => store.get(k) ?? null, set: (k, v2) => store.set(k, v2), del: (k) => store.delete(k) },
    emit: (d) => events.push(d), wait: async () => { clock.t += 400; },
    busy: () => F.inClickWindow(click, now()), tradeLive: () => click.clickAt > click.clickDoneAt,
  };
  return { st, R, W, rUsdc, rC, wallet, store, events, asks, click, clock, earnDeps, total };
}
