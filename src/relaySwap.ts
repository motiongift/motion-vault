// Cross-chain swaps on Relay (2026-10-29; owner: “approved”). The bridge's route with a coin on either side: a coin the
// wallet holds on the origin chain (memecoins included) → the native coin, a stable or any coin on another chain. Relay
// routes it and fills it from its own solvers; the vault signs Relay's own steps from the user's wallet and nothing else.
// motion never holds the funds and never pays anything out of its own reserves on this path.
//
// New file on purpose: nothing of the frozen trade core (docs/TRADE-CORE.md) changes. Solana uses only exported pieces of
// solEngine (compileV0, signMessage, solLimitSend — the engine's single held send path — solRpc, tokState, …).
//
// What is checked before anything is signed (each a refusal, never a warning):
//   quote    from api.relay.link itself (keyless), or — only when Relay wants a key — through motion's pass-through, which
//            then also has to stand against Relay's own keyless price (relayApi.ts)
//   details  this wallet as depositor, the confirmed recipient, both chains, both coins, the exact amount
//   EVM      [approve] → deposit: the approve is the origin coin's plain approve of EXACTLY the amount to Relay's pinned
//            depository; the deposit goes to that depository, names this wallet, the coin and the amount; no other step
//   Solana   one transaction; every program allow-listed; this wallet the only signer; Relay's depository vault in it; a
//            simulation in which this wallet loses nothing but the amount of the origin coin and at most SOL_COST_CAP of SOL
//            (fees, new token accounts), no token account handed over or delegated
//   floor    what arrives ≥ 97 % of what the page showed (minOut)
import { createWalletClient, defineChain, http, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BRIDGE_CHAINS, publicFor, cappedFees } from './bridgeEngine.ts';
import {
  RELAY_SOL, NATIVE_EVM, NATIVE_SOL, relayBody, relayQuote, detailsProblem, evmStepsProblem, solStepsProblem, independentOut, priceProblem,
  type QuoteSource, type SolIxJ, type EvmStep,
} from './relayApi.ts';
import { solKeys, compileV0, signMessage, solLimitSend, solRpc, solBudget, solBlockhashInfo, sendPlan, tokState, b58e, solTokenBalancesFor, SOL_ADDR, P, type SolAcct } from './solEngine.ts';
// the most gas a Relay swap's deposit / approve may be signed with (audit 2026-11-01, vault-security-bridge-gas-ceiling)
export const SWAP_DEPOSIT_GAS_MAX = 1_000_000n, SWAP_APPROVE_GAS_MAX = 200_000n;

export type SwapReq = { originChainId: number; destinationChainId: number; originCurrency: string; destinationCurrency: string; amount: string; recipient: string };
export type SwapBound = SwapReq & { requestId: string; source: QuoteSource; user: string; out: string; outFormatted: string; outSymbol: string; inSymbol: string; inFormatted: string; inDecimals: number; steps: string[]; evm?: { approve: EvmStep | null; deposit: EvmStep }; sol?: { ixs: SolIxJ[]; tables: string[] } };
type Acct = { id: string; name: string; address: `0x${string}`; key?: `0x${string}`; ext?: string };

const isSol = (id: number) => Number(id) === RELAY_SOL;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const SOL_COST_CAP = 20_000_000n;   // 0.02 SOL: fees + a few new token accounts' rent; anything above is refused

// the request the page asks for, shaped and bounded before anything goes out
export function swapRequestProblem(q: Partial<SwapReq>, chainOk: (id: number) => boolean): string | null {
  const o = Number(q?.originChainId), d = Number(q?.destinationChainId);
  if (!Number.isInteger(o) || !Number.isInteger(d) || o === d) return 'Pick two different networks';
  if (!chainOk(o) || !chainOk(d)) return 'This network is not offered here';
  const cur = (id: number, v: unknown) => (isSol(id) ? SOL_ADDR.test(String(v ?? '')) : EVM_ADDR.test(String(v ?? '')));
  if (!cur(o, q.originCurrency) || !cur(d, q.destinationCurrency)) return 'Bad coin address';
  if (!/^\d{1,40}$/.test(String(q?.amount ?? '')) || BigInt(String(q.amount)) <= 0n) return 'Bad amount';
  if (!(isSol(d) ? SOL_ADDR.test(String(q.recipient ?? '')) : EVM_ADDR.test(String(q.recipient ?? '')))) return 'Bad recipient for the destination chain';
  return null;
}

// bind: the vault's own quote for exactly this request, every check above, nothing signed
export async function bindSwap(user: string, q: SwapReq, f: typeof fetch = fetch): Promise<SwapBound> {
  const body = relayBody({ user, recipient: q.recipient, originChainId: Number(q.originChainId), destinationChainId: Number(q.destinationChainId), originCurrency: q.originCurrency, destinationCurrency: q.destinationCurrency, amount: String(q.amount) });
  const { j, source } = await relayQuote(body, f);
  const bad = detailsProblem(j, { ...body });
  if (bad) throw new Error(`Relay's quote was refused: ${bad}`);
  const co = j.details.currencyOut, ci = j.details.currencyIn;
  const outDec = Number(co.currency?.decimals), inDec = Number(ci.currency?.decimals);
  if (!Number.isInteger(outDec) || !Number.isInteger(inDec)) throw new Error('Relay\'s quote was refused: no decimals for a coin');
  const bound: SwapBound = { ...q, originChainId: body.originChainId, destinationChainId: body.destinationChainId, amount: body.amount, requestId: String(j.requestId), source, user,
    out: String(co.amount), outFormatted: String(co.amountFormatted ?? formatUnits(BigInt(co.amount), outDec)).slice(0, 40), outSymbol: String(co.currency?.symbol || '').slice(0, 20),
    inSymbol: String(ci.currency?.symbol || '').slice(0, 20), inFormatted: formatUnits(BigInt(body.amount), inDec), inDecimals: inDec,
    steps: (j.steps || []).filter((s: any) => s?.items?.length).map((s: any) => String(s.id)) };
  if (isSol(body.originChainId)) {
    const s = solStepsProblem(j, user); if ('problem' in s) throw new Error(`Relay's quote was refused: ${s.problem}`);
    bound.sol = s;
  } else {
    const s = evmStepsProblem(j, { user, originChainId: body.originChainId, originCurrency: body.originCurrency, amount: body.amount }); if ('problem' in s) throw new Error(`Relay's quote was refused: ${s.problem}`);
    bound.evm = s;
  }
  if (source === 'motion') {
    const p = priceProblem(BigInt(bound.out), outDec, await independentOut(body, inDec, f));
    if (p) throw new Error(`The quote motion relayed was refused: ${p}`);
  }
  return bound;
}

// ── EVM: [approve] → deposit, one wallet, its own nonce order ──
function walletFor(a: Acct, chainId: number) {
  const c = BRIDGE_CHAINS[chainId]; if (!c) throw new Error(`Chain ${chainId} is not offered here`);
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 }, rpcUrls: { default: { http: c.rpcs } } });
  return createWalletClient({ account: privateKeyToAccount(a.key as `0x${string}`), chain, transport: http(c.rpcs[0], { timeout: 20000 }) });
}
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;
export async function evmSwapSend(a: Acct, b: SwapBound): Promise<{ hash: `0x${string}`; approveHash?: `0x${string}` }> {
  if (!a.key || a.ext) throw new Error('This wallet cannot sign here (Privy wallets sign through Privy)');
  if (!b.evm) throw new Error('No EVM deposit for this swap');
  const chainId = Number(b.originChainId), pc = publicFor(chainId), wc = walletFor(a, chainId), me = a.address;
  const amount = BigInt(b.amount), native = b.originCurrency.toLowerCase() === NATIVE_EVM;
  // (audit 2026-11-01, vault-security-bridge-gas-ceiling) Relay's gas limits are bounded (a depository deposit uses ~60–100k,
  // an approve ~50k) and the node's fee is signed only under the chain's F-73 ceiling (bridgeEngine.cappedFees)
  const lim = (g: string | undefined, dflt: bigint, max: bigint) => { const v = g && /^\d{1,12}$/.test(String(g)) ? (BigInt(String(g)) * 13n) / 10n : dflt; return v > max ? max : v; };
  const depGas = lim(b.evm.deposit.gas, 150_000n, SWAP_DEPOSIT_GAS_MAX), apGas = lim(b.evm.approve?.gas, 80_000n, SWAP_APPROVE_GAS_MAX);
  const feeArgs = cappedFees(chainId, await pc.estimateFeesPerGas().catch(() => null), [depGas, apGas]);
  const bal = await pc.getBalance({ address: me });
  const gasCost = (depGas + (b.evm.approve ? apGas : 0n)) * feeArgs.maxFeePerGas;
  if (native ? bal < amount + gasCost : bal < gasCost) throw new Error(`Not enough ${BRIDGE_CHAINS[chainId].symbol} for ${native ? 'the amount plus ' : ''}gas on ${BRIDGE_CHAINS[chainId].name}`);
  let approveHash: `0x${string}` | undefined;
  if (!native) {
    const token = b.originCurrency as `0x${string}`;
    const held = await pc.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [me] }) as bigint;
    if (held < amount) throw new Error(`Not enough ${b.inSymbol || 'tokens'} in this wallet`);
    const allowed = await pc.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [me, b.evm.deposit.to as `0x${string}`] }) as bigint;
    if (allowed < amount) {
      // Relay's quote may skip the approve when an allowance exists; when it is short, the vault's own exact approve (the same bytes it checked)
      const data = b.evm.approve ? b.evm.approve.data as `0x${string}` : encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'approve', args: [b.evm.deposit.to as `0x${string}`, amount] });
      approveHash = await wc.sendTransaction({ to: token, data, value: 0n, gas: apGas, ...feeArgs } as never);
      const rc = await pc.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 }).catch(() => null);
      if (!rc) throw Object.assign(new Error('The approval did not confirm in time — nothing was deposited; press Swap again once it lands'), { approveHash });
      if (rc.status !== 'success') throw new Error('The approval reverted — nothing was deposited');
    }
  }
  const hash = await wc.sendTransaction({ to: b.evm.deposit.to as `0x${string}`, data: b.evm.deposit.data as `0x${string}`, value: native ? amount : 0n, gas: depGas, ...feeArgs } as never);
  return { hash, ...(approveHash ? { approveHash } : {}) };
}

// ── Solana: one transaction, simulated first; the wallet may lose only the amount of the origin coin and a little SOL ──
type AccState = { owner: string; lamports: bigint; data: Uint8Array } | null;
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ixData = (d: string) => (/^[0-9a-f]*$/i.test(d) && d.length % 2 === 0 ? Uint8Array.from((d.match(/../g) || []).map((h) => parseInt(h, 16))) : fromB64(d));
// pure: compare the wallet's accounts before / after the simulation (exported for the tests)
export function solSimProblem(o: { user: string; originCurrency: string; amount: bigint; addrs: string[]; pre: AccState[]; post: AccState[] }): string | null {
  const nativeOrigin = o.originCurrency === NATIVE_SOL;
  for (let i = 0; i < o.addrs.length; i++) {
    const pre = o.pre[i], post = o.post[i], addr = o.addrs[i];
    if (addr === o.user) {
      const lost = (pre?.lamports ?? 0n) - (post?.lamports ?? 0n);
      if (lost > (nativeOrigin ? o.amount : 0n) + SOL_COST_CAP) return 'it would take more SOL from this wallet than the swap and its fees';
      continue;
    }
    const a = pre ? tokState({ owner: pre.owner, data: pre.data }) : null, b = post ? tokState({ owner: post.owner, data: post.data }) : null;
    const mine = (a && a.owner === o.user) || (b && b.owner === o.user);
    if (!mine) continue;
    if (a && a.owner === o.user && !b) { if (a.amount !== 0n) return 'it would close one of this wallet\'s token accounts that holds coins'; continue; }
    if (a && b && b.owner !== o.user) return 'it would hand one of this wallet\'s token accounts to someone else';
    if (b && b.delegate && b.delegate !== (a?.delegate || '')) return 'it would let someone else spend one of this wallet\'s coins';
    const drop = (a?.amount ?? 0n) - (b?.amount ?? 0n);
    if (drop > 0n && !(b?.mint === o.originCurrency || a?.mint === o.originCurrency)) return 'it would take a coin this swap does not spend';
    if (drop > o.amount) return 'it would take more of the coin than the amount';
  }
  return null;
}
async function rawAccounts(addrs: string[]): Promise<AccState[]> {
  const out: AccState[] = [];
  for (let i = 0; i < addrs.length; i += 50) {
    const r = await solRpc<any>('getMultipleAccounts', [addrs.slice(i, i + 50), { encoding: 'base64', commitment: 'processed' }]);
    for (const v of r?.value || []) out.push(v ? { owner: v.owner, lamports: BigInt(v.lamports), data: fromB64(v.data[0]) } : null);
  }
  if (out.length !== addrs.length) throw new Error('Could not read this wallet\'s accounts');
  return out;
}
export async function solSwapSend(a: SolAcct, b: SwapBound): Promise<string> {
  if (!a.key || a.ext) throw new Error('No Solana key for this wallet');
  if (!b.sol) throw new Error('No Solana deposit for this swap');
  const k = solKeys(a.key), me = k.address;
  if (me !== b.user) throw new Error('This quote is for another wallet');
  // Relay's own budget instructions (if any) give way to the vault's: one limit, sized from the simulation
  const relayIxs = b.sol.ixs.filter((x) => x.programId !== P.budget);
  const ixs = relayIxs.map((x) => ({ program: x.programId, keys: x.keys.map((y) => ({ pubkey: y.pubkey, signer: y.isSigner, writable: y.isWritable })), data: ixData(x.data) }));
  const tableRows = await rawAccounts(b.sol.tables);
  const tables = b.sol.tables.flatMap((key, i) => { const d = tableRows[i]?.data; if (!d) return []; const addresses: string[] = []; for (let o = 56; o + 32 <= d.length; o += 32) addresses.push(b58e(d.subarray(o, o + 32))); return [{ key, addresses }]; });
  const watch = [...new Set([me, ...relayIxs.flatMap((x) => x.keys.filter((y) => y.isWritable).map((y) => y.pubkey))])].slice(0, 64);
  const plan = await sendPlan({ slippage: 1, gasBoost: 1.5, turbo: false });
  const bh = await solBlockhashInfo();
  const build = (units: number) => compileV0(me, [...solBudget(units, plan.micro), ...ixs as never[]], bh.blockhash, tables);
  const pre = await rawAccounts(watch);
  const simMsg = build(1_400_000);
  const simTx = new Uint8Array(1 + 64 + simMsg.length); simTx[0] = 1; simTx.set(simMsg, 65);
  const sim = await solRpc<any>('simulateTransaction', [btoa(String.fromCharCode(...simTx)), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: watch } }]);
  const v = sim?.value || {};
  if (v.err) throw new Error('The swap failed its simulation: ' + (Array.isArray(v.logs) ? String(v.logs.filter((l: string) => /Error|failed|insufficient/i.test(l)).slice(-1)[0] || JSON.stringify(v.err)) : JSON.stringify(v.err)).slice(0, 160));
  const post: AccState[] = (Array.isArray(v.accounts) ? v.accounts : []).map((x: any) => (x ? { owner: x.owner, lamports: BigInt(x.lamports), data: fromB64(x.data?.[0] || '') } : null));
  if (post.length !== watch.length) throw new Error('The simulation did not show this wallet\'s accounts');
  const bad = solSimProblem({ user: me, originCurrency: b.originCurrency, amount: BigInt(b.amount), addrs: watch, pre, post });
  if (bad) throw new Error(`Refused: ${bad}`);
  const used = Number(v.unitsConsumed) || 400_000;
  const units = Math.min(1_400_000, Math.ceil(used * 1.25) + 20_000);
  const { tx } = signMessage(build(units), k.seed);
  return solLimitSend(tx, me, bh.lvh);
}

// ── an engine-wide token balance read (any offered chain), keyed like bridgeBalances; a failed read is left out ──
export async function relayTokenBalances(chainId: number, token: string, addresses: string[]): Promise<Record<string, number>> {
  if (isSol(chainId)) return token === NATIVE_SOL ? {} : solTokenBalancesFor(token, addresses);
  if (!BRIDGE_CHAINS[chainId] || !EVM_ADDR.test(token)) return {};
  const pc = publicFor(chainId), t = token as `0x${string}`;
  const dec = Number(await pc.readContract({ address: t, abi: ERC20, functionName: 'decimals' }).catch(() => NaN));
  if (!Number.isInteger(dec)) return {};
  const out: Record<string, number> = {};
  await Promise.all([...new Set(addresses.filter((x) => EVM_ADDR.test(x)).map((x) => x.toLowerCase()))].slice(0, 40).map(async (x) => {
    try { out[x] = Number(formatUnits(await pc.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [x as `0x${string}`] }) as bigint, dec)); } catch { /* omitted, never 0 */ }
  }));
  return out;
}
