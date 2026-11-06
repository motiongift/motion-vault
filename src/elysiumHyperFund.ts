// HyperEVM HYPE → Elysium HYPE through motion's own bridge (release 6, owner 2026-11-04: "our own bridge into Elysium, 0.1 % fee").
// The VAULT side; the solver is trench server/motion-bridge.mjs (MOTION_BRIDGE_ELYSIUM_FROM_HYPEREVM=1), the shared rules are
// src/motionBridgeCore.ts (sameCoin / sameCoinOut / evmSourceProblem). webEngine.ts reaches it through elysiumFund { from: 'hyperevm' }.
//
// What the wallet W signs: ONE plain HYPE transfer on HyperEVM (chain 999, no calldata, 21 000 gas) of exactly the quoted amount to the
// solver's PUBLISHED HyperEVM deposit address (/health deposits.hyperevm = the Elysium payout key's own address). The solver broadcasts it,
// and once it is included pays W's SAME address on Elysium: one Inbox.createRetryableTicket on HyperEVM, every refund address = W. If it
// cannot pay, the HYPE goes back to W on HyperEVM. The vault checks before a byte is signed: the quote's signature (pinned key), the
// route, the payer and the recipient (W itself — no parameter can name another address), and that it pays the amount less at most
// motion's 0.1 % fee (at least $0.01, at OUR HyperEVM price). Leaving Elysium is the official bridge only (about 6 days; no fast exit).
import { keccak256 } from 'viem';
import { NATIVE_TOKEN, type Quote } from './motionBridgeCore.ts';
import { ELY_FEE, ELY_LEAVE_LINE, elyFeeText, elyLangOf, type ElyLang } from './elysiumUsdCore.ts';
import { SolverRefused, SolverUnknown, type SolverBridge } from './bridgeSolver.ts';

export const HYPER_FUND = Object.freeze({
  chainId: 999,
  gas: 21_000n,                        // a plain transfer from an EOA to an EOA (the solver's deposit address is a hot wallet)
  maxGas: 60_000n,                     // the solver refuses a native source above 100 000; the vault never signs above this
  maxGasPriceWei: 50_000_000_000n,     // 50 gwei (HyperEVM's base fee sat at ~0.1 gwei on 3 Nov; 0.6 gwei seen)
  maxSlipBps: 150,                     // quoteProblem's bound against OUR price (HYPE → HYPE: the exact check is hyperQuoteProblem)
  minWei: 10n ** 15n,                  // 0.001 HYPE: below that the $0.01 minimum fee is most of it
  feePriceTolerancePct: 150n,          // the $0.01 minimum converted at the solver's price, which may sit a little off ours
});

export type HyperFundArgs = { walletId: string; amount: bigint | 'max'; phase: 'quote' | 'go'; lang: ElyLang };
/** elysiumFund { walletId, from: 'hyperevm', pay: 'native', asset: 'HYPE', amount (HYPE, a number or 'max'), phase?: 'quote', lang? } */
export function hyperFundArgs(o: unknown): HyperFundArgs {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Bad arguments: one plain object');
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['walletId', 'from', 'pay', 'asset', 'amount', 'phase', 'lang'].includes(k)) throw new Error(`Bad arguments: unknown field ${k}`);
  if (r.from !== 'hyperevm') throw new Error('Bad arguments: from');
  if (r.pay !== undefined && r.pay !== 'native') throw new Error('HyperEVM pays HYPE only');
  if (r.asset !== undefined && r.asset !== 'HYPE') throw new Error('HyperEVM pays HYPE for HYPE only');
  if (typeof r.walletId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(r.walletId)) throw new Error('Bad arguments: walletId');
  let amount: bigint | 'max';
  if (r.amount === 'max') amount = 'max';
  else if (typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0 && r.amount <= 1_000_000) amount = weiOf(r.amount);
  else throw new Error('Invalid amount');
  const phase = r.phase == null || r.phase === 'go' ? 'go' : r.phase === 'quote' ? 'quote' : null;
  if (!phase) throw new Error('Bad arguments: phase');
  return { walletId: r.walletId, amount, phase, lang: elyLangOf(r.lang) };
}
/** HYPE (a JS number, up to 18 decimals as written) → wei, exactly as its shortest decimal reads (0.1 → 10^17, never 10^17 + 6) */
export function weiOf(n: number): bigint {
  const s = (/e/i.test(String(n)) ? n.toFixed(18) : String(n)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export const fmtHypeWei = (wei: bigint): string => {
  const m = (wei + 50_000_000_000_000n) / 100_000_000_000_000n;   // 4 decimals, rounded
  return `${m / 10_000n}.${String(m % 10_000n).padStart(4, '0')} HYPE`;
};

/** the most the fee may take of `amountIn` at OUR price: 10 bps, or the $0.01 minimum (with a little room for the solver's own price) */
export function hyperMaxFeeWei(amountIn: bigint, price6: bigint): bigint {
  const prop = (amountIn * BigInt(ELY_FEE.bps)) / 10_000n;
  // the $0.01 minimum in wei at OUR price (rounded up), with room for the solver's own price read
  const min = price6 > 0n ? (((ELY_FEE.min6 * 10n ** 18n + price6 - 1n) / price6) * HYPER_FUND.feePriceTolerancePct) / 100n : prop;
  const bound = prop > min ? prop : min;
  return bound > amountIn ? amountIn : bound;
}
/** the vault's own check of a HyperEVM quote, on top of quoteProblem ('' = sign): HYPE in, HYPE out, the amount less at most the fee */
export function hyperQuoteProblem(q: Quote, amountIn: bigint, price6: bigint, deposit: string): string {
  if (q.src.chain !== 'hyperevm' || q.dst.chain !== 'elysium') return 'the quote is for another route';
  if (String(q.src.token).toLowerCase() !== NATIVE_TOKEN || q.dst.asset !== undefined) return 'the quote is not HYPE for HYPE';
  if (BigInt(q.src.amount) !== amountIn) return 'the quote is for another amount';
  if (!/^0x[0-9a-fA-F]{40}$/.test(deposit) || String(q.src.deposit).toLowerCase() !== deposit.toLowerCase()) return 'the quote names an unpublished deposit address';
  const out = BigInt(q.dst.amount);
  if (out > amountIn) return 'the quote pays more than it receives';
  if (amountIn - out > hyperMaxFeeWei(amountIn, price6)) return 'the quote takes more than motion\'s 0.1 % fee';
  return '';
}
/** the ONE transaction W signs */
export function hyperTransfer(to: string, amount: bigint): { to: `0x${string}`; value: bigint; data: '0x' } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !(amount > 0n)) throw new Error('Refusing to sign: not a plain HYPE transfer');
  return { to: to as `0x${string}`, value: amount, data: '0x' };
}
/** '' = these are exactly the quote's transfer: chain 999, the deposit address, the amount, no calldata, bounded gas */
export function hyperTxProblem(tx: { chainId?: number; to?: string; value?: bigint; data?: string; gas?: bigint; gasPrice?: bigint }, q: Quote): string {
  if (tx.chainId !== HYPER_FUND.chainId) return 'not HyperEVM';
  if (String(tx.to || '').toLowerCase() !== String(q.src.deposit).toLowerCase()) return 'pays another address';
  if ((tx.value ?? 0n) !== BigInt(q.src.amount)) return 'another amount';
  if (String(tx.data || '0x') !== '0x') return 'carries calldata';
  if (!((tx.gas ?? 0n) > 0n) || (tx.gas ?? 0n) > HYPER_FUND.maxGas) return 'abnormal gas';
  if (!((tx.gasPrice ?? 0n) > 0n) || (tx.gasPrice ?? 0n) > HYPER_FUND.maxGasPriceWei) return 'abnormal gas price';
  return '';
}

export type HyperFundDeps = {
  now: () => number;
  wallet: (id: string) => { id: string; name: string; w: `0x${string}`; sign: (tx: { to: `0x${string}`; value: bigint; data: '0x'; gas: bigint; gasPrice: bigint; nonce: number; chainId: number; type: 'legacy' }) => Promise<`0x${string}`> };
  reads: {
    balance: (w: `0x${string}`) => Promise<bigint>;          // W's HYPE on HyperEVM (the official node)
    code: (w: `0x${string}`) => Promise<string | null>;      // W's code on HyperEVM ('0x' = a plain wallet)
    price6: () => Promise<bigint>;                          // OUR HYPE price: the HyperEVM WHYPE/USDC pool
    nonce: (w: `0x${string}`) => Promise<number>;           // W's pending transaction count on HyperEVM
    gasPrice: () => Promise<bigint>;
  };
  // motion's bridge client whose ONE EVM signer is the function given here (webEngine: createSolverBridge with it as signEvmTransfer)
  bridge: (signEvm: (a: { walletId: string; chain: string; token: string; to: string; amount: bigint }) => Promise<{ raw: string; hash: string }>) => Pick<SolverBridge, 'health' | 'quote' | 'fill'>;
  gate: () => Promise<void>;                                // the vault's transfer gate (2FA / passkey), before the dialog
  ask: (o: { title: string; html: string; ok: string }) => Promise<boolean>;
  esc: (v: unknown) => string;
  destBox: (address: string) => string;
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  risk: string;                                             // the bridge-upgrade disclosure the other Elysium dialogs carry
};

export function createElyHyperFund(deps: HyperFundDeps) {
  async function fund(o: unknown): Promise<Record<string, unknown>> {
    const a = hyperFundArgs(o);
    const w = deps.wallet(a.walletId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(w.w)) throw new Error('This wallet has no EVM address');
    const signed: { hash?: string } = {};
    // the ONE signer the bridge client may use here: exactly this quote's transfer, nothing else (set once the quote is checked)
    let allowed: Quote | null = null;
    const signEvm = async (x: { walletId: string; chain: string; token: string; to: string; amount: bigint }) => {
      const q = allowed;
      if (!q || x.walletId !== w.id || x.chain !== 'hyperevm' || String(x.token).toLowerCase() !== NATIVE_TOKEN || String(x.to).toLowerCase() !== String(q.src.deposit).toLowerCase() || x.amount !== BigInt(q.src.amount)) throw new Error('Refusing to sign: not this quote\'s HYPE transfer');
      const [nonce, gp] = await Promise.all([deps.reads.nonce(w.w), deps.reads.gasPrice()]);
      const gasPrice = (gp * 5n) / 4n;
      const tx = { ...hyperTransfer(x.to, x.amount), gas: HYPER_FUND.gas, gasPrice, nonce, chainId: HYPER_FUND.chainId, type: 'legacy' as const };
      const why = hyperTxProblem(tx, q); if (why) throw new Error('Refusing to sign: ' + why);
      const raw = await w.sign(tx);
      signed.hash = keccak256(raw);
      return { raw, hash: signed.hash };
    };
    const bridge = deps.bridge(signEvm);
    const h = await bridge.health();
    if (!h.on || !h.chains.includes('hyperevm') || !h.chains.includes('elysium') || !h.deposits.hyperevm) throw new SolverRefused('motion\'s bridge does not take HYPE from HyperEVM right now');
    if (h.elysium?.paused) throw new SolverRefused('Elysium funding is paused: ' + String((h.elysium.why || [])[0] || 'the official bridge changed').slice(0, 120) + ' — moving funds back stays open');
    const [bal, price6, code, gp] = await Promise.all([deps.reads.balance(w.w), deps.reads.price6(), deps.reads.code(w.w).catch(() => null), deps.reads.gasPrice()]);
    if (code === null) throw new SolverRefused('HyperEVM could not be read — try again in a moment');
    if (code !== '0x') throw new SolverRefused('This wallet has code on HyperEVM (a contract or a delegation) — Elysium funding pays plain wallets only');
    if (!(price6 > 0n)) throw new SolverRefused('No fresh HYPE price — nothing was moved');
    const gasCost = HYPER_FUND.gas * ((gp * 5n) / 4n);
    if ((gp * 5n) / 4n > HYPER_FUND.maxGasPriceWei) throw new SolverRefused('HyperEVM gas is far above normal right now — try again later');
    const amountIn = a.amount === 'max' ? bal - 2n * gasCost : a.amount;
    if (!(amountIn >= HYPER_FUND.minWei)) throw new SolverRefused(a.amount === 'max' ? 'Nothing to move after HyperEVM gas' : 'At least 0.001 HYPE');
    if (amountIn + gasCost > bal) throw new SolverRefused('More than this wallet holds on HyperEVM (leave a little HYPE for gas)');
    const got = await bridge.quote({ from: 'hyperevm', to: 'elysium', amountIn, depositor: w.w, recipient: w.w, oracle6: price6, srcOracle6: price6, pay: 'native', maxSlipBps: HYPER_FUND.maxSlipBps, deposits: h.deposits });
    const bad = hyperQuoteProblem(got.quote, amountIn, price6, String(h.deposits.hyperevm)); if (bad) throw new SolverRefused('motion bridge: ' + bad);
    const feeWei = amountIn - got.out;
    const inText = fmtHypeWei(amountIn), outText = fmtHypeWei(got.out), feeText = elyFeeText(), back = ELY_LEAVE_LINE[a.lang];
    if (a.phase === 'quote') return { ok: true, phase: 'quote', from: 'hyperevm', in: amountIn.toString(), out: got.out.toString(), fee: feeWei.toString(), inText, outText, feeText, back, etaMs: got.etaMs };
    await deps.gate();
    const p = (s: string, cls = 'dk-sub') => `<p class="${cls}">${deps.esc(s)}</p>`;
    const ok = await deps.ask({
      title: 'Move HYPE from HyperEVM to Elysium', ok: `Move ${inText}`,
      html: p(`${inText} from ${w.name} on HyperEVM to motion's bridge. ${outText} arrives at the same address on Elysium, usually within seconds; if it cannot be paid, your HYPE comes back on HyperEVM.`)
        + deps.destBox(w.w) + p(`Fee ${feeText} (${fmtHypeWei(feeWei)}).`, 'dk-muted') + p(back, 'dk-muted') + p(deps.risk, 'dk-muted'),
    });
    if (!ok) throw new Error('Cancelled');
    allowed = got.quote;
    return deps.lock('hyperevm:' + w.w.toLowerCase(), async () => {
      try {
        const r = await bridge.fill(got.quote, got.sig, w.id, { early: true });
        return { ok: r.ok, state: r.state, srcHash: r.srcHash, dstHash: r.dstHash || null, quoteId: got.quote.id, out: got.out.toString(), fee: feeWei.toString(), outText, feeText, back };
      } catch (e) {
        if (e instanceof SolverRefused) throw e;                                     // sent:false — nothing of yours moved
        if (e instanceof SolverUnknown) throw Object.assign(new Error('Status unknown — your HYPE transfer to motion\'s bridge may be out; follow it, do not pay again'), { name: 'TransferUnknown', unknown: true, quoteId: got.quote.id, srcHash: e.srcHash || signed.hash });
        throw e;
      } finally { allowed = null; }
    });
  }
  return { fund };
}
