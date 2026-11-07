// Copied from trench scripts/limit-mock-chain.mjs (2026-11-06, snapshot: local trench-snap-limit) for the rel-12 limit tests; only the import path differs.
// A small in-process Robinhood Chain for the limit-order tests (no anvil on this machine; nothing real is sent, no real key):
// native ETH, one ERC-20 (the coin), a Pons-style curve (buy / sell(amountIn, minOut, to), fee taken from the ETH side),
// the V4 pool the curve migrates into behind the Universal Router (V4_SWAP: SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE), and
// Permit2's approve / allowance. Legacy txs only: chain id, signer, nonce, base fee, balance for value + gas × gasPrice are
// checked like a node does; a revert consumes the nonce and the gas. Every block is mined at once.
import { parseTransaction, recoverTransactionAddress, keccak256, decodeFunctionData, decodeAbiParameters, parseAbi, encodeAbiParameters, hexToBytes } from 'viem';
import { DELTA_PROBE_CODE } from '../../src/limitCore.ts';

export const CHAIN_ID = 4663;
export const UR = '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77';
export const P2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
export const NATIVE = '0x0000000000000000000000000000000000000000';
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const PONS = parseAbi(['function buy(uint256 amountIn, uint256 minOut, address to) payable', 'function sell(uint256 amountIn, uint256 minOut, address to)', 'function getReserves() view returns (uint256, uint256)']);
const PERMIT2 = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)', 'function allowance(address user, address token, address spender) view returns (uint160, uint48, uint48)']);
const URA = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const lc = (a) => String(a || '').toLowerCase();
const hx = (v) => '0x' + BigInt(v).toString(16);
const revert = (why) => { throw Object.assign(new Error('execution reverted: ' + why), { revert: true }); };

export function createChain({ token, curve, now = () => Date.now(), baseFee = 20_000_000n, taxBps = 200n } = {}) {
  const T = lc(token), C = lc(curve);
  let s = {
    eth: new Map(), nonce: new Map(), bal: new Map(), allow: new Map(), p2: new Map(),
    curve: { eth: 10n * 10n ** 18n, tok: 10_000_000n * 10n ** 18n, graduated: false },   // 1e-6 ETH per token
    pool: null,   // { eth, tok } after migrate()
  };
  s.eth.set(C, s.curve.eth); s.bal.set(C, s.curve.tok);   // the curve holds what its reserves say
  const txs = new Map(), receipts = new Map(), raws = new Map();
  const log = [];   // every accepted tx: { hash, from, to, nonce, status, kind }
  let block = 1n;
  let drop = false;   // accept sends without mining them (a tx a node "lost")
  let skim = false;
  const clone = () => ({ ...s, eth: new Map(s.eth), nonce: new Map(s.nonce), bal: new Map(s.bal), allow: new Map(s.allow), p2: new Map(s.p2), curve: { ...s.curve }, pool: s.pool ? { ...s.pool } : null });
  const ethOf = (st, a) => st.eth.get(lc(a)) || 0n;
  const addEth = (st, a, v) => { const x = ethOf(st, a) + v; if (x < 0n) revert('eth balance'); st.eth.set(lc(a), x); };
  const balOf = (st, a) => st.bal.get(lc(a)) || 0n;
  const addBal = (st, a, v) => { const x = balOf(st, a) + v; if (x < 0n) revert('ERC20: transfer amount exceeds balance'); st.bal.set(lc(a), x); };
  const allowOf = (st, o, sp) => st.allow.get(lc(o) + ':' + lc(sp)) || 0n;
  const pull = (st, owner, spender, amount) => { const a = allowOf(st, owner, spender); if (a < amount) revert('ERC20: insufficient allowance'); st.allow.set(lc(owner) + ':' + lc(spender), a - amount); addBal(st, owner, -amount); };
  const ts = () => BigInt(Math.floor(now() / 1000));
  const poolKeyOk = (pk) => !!s && lc(pk.currency0) === NATIVE && lc(pk.currency1) === T && Number(pk.fee) === 0 && Number(pk.tickSpacing) === 200 && lc(pk.hooks) === HOOK;

  // one call against state `st` (mutated); returns { gas, ret }
  function exec(st, from, to, data, value) {
    from = lc(from); to = lc(to); data = data || '0x';
    if (ethOf(st, from) < value) revert('insufficient funds for value');
    addEth(st, from, -value);
    if (to === T) {
      addEth(st, to, value);
      const { functionName: fn, args } = decodeFunctionData({ abi: ERC20, data });
      if (fn === 'approve') { st.allow.set(from + ':' + lc(args[0]), args[1]); return { gas: 46_000n }; }
      if (fn === 'transfer') { addBal(st, from, -args[1]); addBal(st, args[0], args[1]); return { gas: 52_000n }; }
      if (fn === 'balanceOf') return { gas: 3000n, ret: encodeAbiParameters([{ type: 'uint256' }], [balOf(st, args[0])]) };
      if (fn === 'allowance') return { gas: 3000n, ret: encodeAbiParameters([{ type: 'uint256' }], [allowOf(st, args[0], args[1])]) };
      if (fn === 'decimals') return { gas: 3000n, ret: encodeAbiParameters([{ type: 'uint8' }], [18]) };
      if (fn === 'symbol') return { gas: 3000n, ret: encodeAbiParameters([{ type: 'string' }], ['MOCK']) };
      revert('token fn');
    }
    if (to === C) {
      const { functionName: fn, args } = decodeFunctionData({ abi: PONS, data });
      if (fn === 'getReserves') return { gas: 3000n, ret: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [st.curve.eth, st.curve.tok]) };
      if (st.curve.graduated) revert('graduated');
      if (fn === 'buy') {
        const [amountIn, minOut, to] = args; const rcpt = skim ? '0x000000000000000000000000000000000000dead' : to;   // skim: a curve that pays someone else
        if (value !== amountIn) revert('value');
        const net = amountIn * (10_000n - taxBps) / 10_000n;
        const out = st.curve.tok * net / (st.curve.eth + net);
        if (out < minOut) revert('minOut');
        st.curve.eth += net; st.curve.tok -= out; addEth(st, C, amountIn); addBal(st, C, -out); addBal(st, rcpt, out);
        return { gas: 120_000n };
      }
      if (fn === 'sell') {
        const [amountIn, minOut, rcpt] = args;
        if (value) revert('value');
        pull(st, from, C, amountIn); addBal(st, C, amountIn);
        const gross = st.curve.eth * amountIn / (st.curve.tok + amountIn);
        const out = gross * (10_000n - taxBps) / 10_000n;
        if (out < minOut) revert('minOut');
        st.curve.eth -= gross; st.curve.tok += amountIn; addEth(st, C, -out); addEth(st, rcpt, out);
        return { gas: 125_000n };
      }
      revert('curve fn');
    }
    if (to === P2) {
      const { functionName: fn, args } = decodeFunctionData({ abi: PERMIT2, data });
      if (fn === 'approve') { st.p2.set(from + ':' + lc(args[0]) + ':' + lc(args[1]), { amount: args[2], exp: BigInt(args[3]) }); return { gas: 48_000n }; }
      const p = st.p2.get(lc(args[0]) + ':' + lc(args[1]) + ':' + lc(args[2])) || { amount: 0n, exp: 0n };
      return { gas: 3000n, ret: encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [p.amount, Number(p.exp), 0]) };
    }
    if (to === UR) {
      const { args: [commands, inputs, deadline] } = decodeFunctionData({ abi: URA, data });
      if (deadline < ts()) revert('TransactionDeadlinePassed');
      const cmds = hexToBytes(commands);
      if (cmds.length !== 1 || cmds[0] !== 0x10) revert('mock UR: V4_SWAP only');
      const [actionsHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]);
      const actions = [...hexToBytes(actionsHex)];
      if (actions.join() !== [0x06, 0x0c, 0x0e].join()) revert('mock UR: SWAP + SETTLE_ALL + TAKE only');
      const [sw] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], params[0]);
      const [settleCur, settleMax] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]);
      const [takeCur, takeTo, takeAmt] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2]);
      if (!st.pool || !poolKeyOk(sw.poolKey)) revert('PoolNotInitialized');
      if (takeAmt !== 0n) revert('mock UR: TAKE of the open delta only');
      const rcpt = lc(takeTo) === '0x0000000000000000000000000000000000000001' ? from : lc(takeTo) === '0x0000000000000000000000000000000000000002' ? UR : lc(takeTo);
      const amt = sw.amountIn;
      if (sw.zeroForOne) {
        if (lc(settleCur) !== NATIVE || settleMax < amt || value < amt || lc(takeCur) !== T) revert('mock UR: buy shape');
        const out = st.pool.tok * amt / (st.pool.eth + amt);
        if (out < sw.amountOutMinimum) revert('V4TooLittleReceived');
        st.pool.eth += amt; st.pool.tok -= out; addEth(st, UR, value); addEth(st, UR, -value); addBal(st, rcpt, out);
        return { gas: 260_000n };
      }
      if (lc(settleCur) !== T || settleMax < amt || value !== 0n || lc(takeCur) !== NATIVE) revert('mock UR: sell shape');
      const p = st.p2.get(from + ':' + T + ':' + UR) || { amount: 0n, exp: 0n };
      if (p.amount < amt) revert('Permit2: AllowanceExpired / insufficient');
      if (p.exp < ts()) revert('Permit2: AllowanceExpired');
      st.p2.set(from + ':' + T + ':' + UR, { ...p, amount: p.amount - amt });
      pull(st, from, P2, amt);
      const out = st.pool.eth * amt / (st.pool.tok + amt);
      if (out < sw.amountOutMinimum) revert('V4TooLittleReceived');
      st.pool.eth -= out; st.pool.tok += amt; addEth(st, rcpt, out);
      return { gas: 270_000n };
    }
    // a plain send to an account (an EOA; data is allowed and does nothing)
    addEth(st, to, value);
    return { gas: 0n };
  }
  const calldataGas = (data) => { let g = 0n; const b = hexToBytes(data || '0x'); for (const x of b) g += x ? 16n : 4n; return g + BigInt(b.length) * 40n; };   // + an "L1" share per byte
  const intrinsic = (data) => 21_000n + calldataGas(data);

  async function sendRaw(raw) {
    raw = lc(raw);
    const hash = keccak256(raw);
    if (raws.has(hash)) throw new Error('already known');
    const p = parseTransaction(raw);
    if (p.type !== 'legacy' || Number(p.chainId) !== CHAIN_ID) throw new Error('invalid chain id');
    return recoverTransactionAddress({ serializedTransaction: raw }).then((signer) => {
      const from = lc(signer);
      const n = s.nonce.get(from) || 0;
      if (p.nonce < n) throw new Error('nonce too low');
      if (p.nonce > n) throw new Error('nonce too high');
      if (p.gasPrice < baseFee) throw new Error('max fee per gas less than block base fee');
      const value = p.value ?? 0n;
      if (ethOf(s, from) < value + p.gas * p.gasPrice) throw new Error('insufficient funds for gas * price + value');
      if (p.gas < intrinsic(p.data)) throw new Error('intrinsic gas too low');
      raws.set(hash, raw);
      if (drop) { txs.set(hash, { hash, from, p, pending: true }); return hash; }
      mine(hash, from, p);
      return hash;
    });
  }
  function mine(hash, from, p) {
    block += 1n;
    const st = clone();
    st.nonce.set(from, (st.nonce.get(from) || 0) + 1);
    let status = '0x1', used;
    const value = p.value ?? 0n;
    try { const r = exec(st, from, p.to, p.data, value); used = intrinsic(p.data) + r.gas; if (used > p.gas) revert('out of gas'); s = st; }
    catch (e) { if (!e.revert) throw e; status = '0x0'; used = p.gas; s.nonce.set(from, (s.nonce.get(from) || 0) + 1); }
    addEth(s, from, -(used * baseFee));   // the base fee is what is paid, not the signed price
    txs.set(hash, { hash, from, p, pending: false });
    receipts.set(hash, { transactionHash: hash, status, blockNumber: hx(block), gasUsed: hx(used), from, to: lc(p.to) });
    log.push({ hash, from, to: lc(p.to), nonce: p.nonce, status, data: p.data || '0x', value });
  }
  const callOn = (st, a) => exec(st, a.from || NATIVE, a.to, a.data || a.input || '0x', BigInt(a.value || 0));
  async function rpc(method, params = []) {
    switch (method) {
      case 'eth_chainId': return hx(CHAIN_ID);
      case 'eth_blockNumber': return hx(block);
      case 'eth_gasPrice': return hx(baseFee);
      case 'eth_getBlockByNumber': return { number: hx(block), baseFeePerGas: hx(baseFee), timestamp: hx(ts()), hash: '0x' + '11'.repeat(32), transactions: [] };
      case 'eth_getBalance': return hx(ethOf(s, params[0]));
      case 'eth_getTransactionCount': {
        const a = lc(params[0]); let n = s.nonce.get(a) || 0;
        if (params[1] === 'pending') for (const t of txs.values()) if (t.pending && t.from === a && t.p.nonce === n) n += 1;
        return hx(n);
      }
      case 'eth_call': {
        const a = params[0]; const st = clone();
        // the vault's payout probe (limitCore DELTA_PROBE_CODE) as a state override: emulated here, executed for real in the fork test
        const ov = params[2] && params[2][lc(a.to)];
        if (ov && ov.code) {
          if (lc(ov.code) !== lc(DELTA_PROBE_CODE)) throw new Error('mock chain: unknown override code');
          const dd = String(a.data).slice(2); const target = '0x' + dd.slice(0, 40), tok = '0x' + dd.slice(40, 80), who = '0x' + dd.slice(80, 120), val = BigInt('0x' + dd.slice(120, 184)), inner = '0x' + dd.slice(184);
          const read = () => (tok === NATIVE ? ethOf(st, who) : (lc(tok) === T ? balOf(st, who) : revert('balanceOf')));
          const b0 = read(); exec(st, a.to, target, inner, val); const b1 = read();
          return '0x' + BigInt.asUintN(256, b1 - b0).toString(16).padStart(64, '0');
        }
        if (a.gasPrice && a.gas && ethOf(st, a.from) < BigInt(a.value || 0) + BigInt(a.gas) * BigInt(a.gasPrice)) throw new Error('insufficient funds for gas * price + value');
        const r = callOn(st, a); return r.ret || '0x';
      }
      case 'eth_estimateGas': { const a = params[0]; const r = callOn(clone(), a); return hx(intrinsic(a.data || a.input) + r.gas); }
      case 'eth_sendRawTransaction': return sendRaw(params[0]);
      case 'eth_getTransactionReceipt': return receipts.get(lc(params[0])) || null;
      case 'eth_getTransactionByHash': { const t = txs.get(lc(params[0])); return t ? { hash: t.hash, from: t.from, nonce: hx(t.p.nonce), blockNumber: t.pending ? null : hx(block) } : null; }
      default: throw new Error('mock chain: ' + method);
    }
  }
  return {
    rpc, sendRaw, log, receipts,
    // test levers
    fund: (a, wei) => addEth(s, a, wei),
    give: (a, units) => addBal(s, a, units),
    ethOf: (a) => ethOf(s, a), balOf: (a) => balOf(s, a), nonceOf: (a) => s.nonce.get(lc(a)) || 0,
    allowance: (o, sp) => allowOf(s, o, sp),
    price: () => (s.pool ? Number(s.pool.eth) / Number(s.pool.tok) : Number(s.curve.eth) / Number(s.curve.tok)),
    // someone else trades: move the price by swapping `wei` of ETH in (> 0) or `units` of the coin in (< 0 → a sell)
    pushPrice: (factor) => { const m = s.pool || s.curve; const k = m.eth * m.tok; const eth2 = BigInt(Math.floor(Number(m.eth) * Math.sqrt(factor))); m.eth = eth2; m.tok = k / eth2; },
    migrate: () => { s.curve.graduated = true; s.pool = { eth: s.curve.eth, tok: s.curve.tok }; },
    setDrop: (v) => { drop = !!v; },
    setSkim: (v) => { skim = !!v; },
    mineDropped: () => { for (const t of [...txs.values()]) if (t.pending) mine(t.hash, t.from, t.p); },
    state: () => s,
  };
}
