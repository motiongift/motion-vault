// The Lighter signer inside the vault (perps phase 2, 2026-10-22).
//
// Lighter transactions are signed with an API key: Schnorr over ECgFp5 with Poseidon2 hashing. There is no maintained JS
// implementation, so the vault runs Lighter's OWN signer: lighter-go v1.0.12 `web-wasm` (Apache-2.0), the release asset
// `lighter-signer-web.wasm`, byte-identical to web-wasm/main.wasm at tag v1.0.12 (commit 324c93b0) AND to our own build
// of that tag (Go 1.25.5, `go mod vendor`, GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w"):
// sha256 95c9dd38…c5ae. It is served next to the engine as /vendor/lighter-signer-95c9dd38.wasm and loaded ONLY when a
// perps method first needs a signature. The bytes are hashed here before they are compiled; any other bytes are
// refused. Compiling WebAssembly needs 'wasm-unsafe-eval' in the vault origin's script-src (server/deploy.sh): that
// allows compiling wasm modules only — no eval of JS strings — and the only module this engine compiles is this one.
//
// The Go runtime keeps the API key's private scalar in its own memory (one client per Lighter account index). Nothing
// here posts anything: the engine sends the signed JSON itself (src/perpsEngine.ts).
import { installGo } from './wasmExec.js';

export const SIGNER = Object.freeze({
  file: 'lighter-signer-95c9dd38.wasm',
  bytes: 7584174,
  sha256: '95c9dd38373405691498c52c0feb72338e6bb00e90362227efe59fb12523c5ae',
  source: 'github.com/elliottech/lighter-go v1.0.12 web-wasm (release asset lighter-signer-web.wasm), Go 1.25.5',
});
/** Lighter's chain id for the Robinhood Chain instance (the "lighterChainId" every tx hash binds to). */
export const LIGHTER_CHAIN_ID = 466324;

export type SignedTx = { txType: number; txInfo: string; txHash: string };
export type OrderArgs = {
  market: number; clientOrderIndex: number; baseAmount: bigint; price: bigint; isAsk: 0 | 1; type: number; timeInForce: number;
  reduceOnly: 0 | 1; triggerPrice: bigint; orderExpiry: number;
};
type GoFn = (...a: unknown[]) => () => Promise<Record<string, unknown>>;
type Exports = Record<string, GoFn>;
const NAMES = ['_createClient', '_createClientByPrv', '_signChangePubKey', '_getChangePubKeyTransaction', '_signCreateOrder', '_signCancelOrder', '_signCancelAllOrders', '_signWithdraw',
  '_signUpdateLeverage', '_signUpdateMargin', '_signCreateGroupedOrders', '_getTransferTransaction', '_signTransfer', '_createAuthToken'] as const;

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(bytes: ArrayBuffer): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }
const isUint = (v: bigint, bits: number) => v >= 0n && v < (1n << BigInt(bits));
// the signer reads a transfer memo as a JS Array of 32 byte values
const memoBytes = (memoHex: string) => Array.from({ length: 32 }, (_, i) => parseInt(memoHex.slice(i * 2, i * 2 + 2), 16));

export interface LighterSigner {
  /** A fresh API key from 32 random bytes (Lighter's own seed → scalar derivation) for this account / key index. Tests only:
   *  the engine's keys come from fromSeed (one key per wallet, the same on every device — 2026-10-22). */
  newKey(accountIndex: number, apiKeyIndex: number, nonce: number): Promise<{ privateKey: string; publicKey: string; l1Body: string }>;
  /**
   * The API key of a 32-byte seed, by Lighter's OWN derivation (lighter-go signer.NewSeedKeyManager → GetScalarFromSeed:
   * SHA-256(0x01‖seed) ‖ SHA-256(0x02‖seed)[0..8] reduced to an ECgFp5 scalar; web-wasm `_createClient(seed, …)`), loaded as
   * this account's client. `l1Body` is the registration text for `nonce`. The same seed gives the same key, on any device.
   */
  fromSeed(seedHex: string, accountIndex: number, apiKeyIndex: number, nonce: number): Promise<{ privateKey: string; publicKey: string; l1Body: string }>;
  /** Load a stored key for an account (the signer keeps one client per account index). */
  use(privateKey: string, accountIndex: number, apiKeyIndex: number): Promise<{ publicKey: string }>;
  changePubKeyBody(accountIndex: number, apiKeyIndex: number, nonce: number): Promise<string>;
  changePubKey(accountIndex: number, l1Sig: string, nonce: number, apiKeyIndex: number): Promise<SignedTx>;
  createOrder(accountIndex: number, o: OrderArgs, nonce: number): Promise<SignedTx>;
  grouped(accountIndex: number, groupingType: number, orders: OrderArgs[], nonce: number): Promise<SignedTx>;
  cancelOrder(accountIndex: number, market: number, orderIndex: bigint, nonce: number): Promise<SignedTx>;
  cancelAll(accountIndex: number, timeInForce: number, time: number, nonce: number, market?: number): Promise<SignedTx>;
  updateLeverage(accountIndex: number, market: number, imf: number, marginMode: 0 | 1, nonce: number): Promise<SignedTx>;
  updateMargin(accountIndex: number, market: number, usdg: bigint, direction: 0 | 1, nonce: number): Promise<SignedTx>;
  withdraw(accountIndex: number, assetIndex: number, routeType: number, amount: bigint, nonce: number): Promise<SignedTx>;
  transferBody(accountIndex: number, nonce: number, apiKeyIndex: number, to: number, asset: number, fromRoute: number, toRoute: number, amount: bigint, fee: bigint, memoHex: string): Promise<string>;
  transfer(accountIndex: number, l1Sig: string, nonce: number, apiKeyIndex: number, to: number, asset: number, fromRoute: number, toRoute: number, amount: bigint, fee: bigint, memoHex: string): Promise<SignedTx>;
  authToken(accountIndex: number, apiKeyIndex: number): Promise<{ token: string; deadline: number }>;
  /** a wallet left the vault: replace that account's client with one of a random throwaway key (the Go side has no delete) */
  forget(accountIndex: number): Promise<void>;
}

// tx types (lighter-go types/txtypes/constants.go)
export const TX = Object.freeze({ changePubKey: 8, transfer: 12, withdraw: 13, createOrder: 14, cancelOrder: 15, cancelAll: 16, updateLeverage: 20, grouped: 28, updateMargin: 29 });

function wrap(g: Exports): LighterSigner {
  const run = async (name: string, ...args: unknown[]) => {
    const fn = g[name]; if (typeof fn !== 'function') throw new Error(`Lighter signer: ${name} missing`);
    const r = await fn(...args)();
    if (!r || typeof r !== 'object') throw new Error(`Lighter signer: ${name} gave no answer`);
    if (typeof r.error === 'string' && r.error) throw new Error(`Lighter signer: ${r.error}`);
    return r;
  };
  const tx = (txType: number) => (r: Record<string, unknown>): SignedTx => {
    const txInfo = String(r.txInfo || ''), txHash = String(r.txHash || '');
    if (!txInfo.startsWith('{') || !/^[0-9a-f]{80}$/.test(txHash)) throw new Error('Lighter signer: malformed transaction');
    return { txType, txInfo, txHash };
  };
  const int = (v: number, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(v) || v < -1 || v > max) throw new Error('Lighter signer: bad integer'); return v; };
  const orderArgs = (o: OrderArgs) => {
    if (!isUint(o.baseAmount, 48) || !isUint(o.price, 32) || !isUint(o.triggerPrice, 32)) throw new Error('Lighter signer: amount out of range');
    return [int(o.market, 4095), int(o.clientOrderIndex), o.baseAmount.toString(), o.price.toString(), o.isAsk, int(o.type, 6), int(o.timeInForce, 2), o.reduceOnly, o.triggerPrice.toString(), int(o.orderExpiry)];
  };
  const loaded = new Map<number, string>();   // account index → public key of the client the Go side holds
  const fromSeed = async (seedHex: string, accountIndex: number, apiKeyIndex: number, nonce: number) => {
    // exactly 32 bytes of hex: Go's GetScalarFromSeed panics on a short seed (it would take the runtime down)
    const seed = String(seedHex).replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('Lighter signer: bad key seed');
    const r = await run('_createClient', seed, LIGHTER_CHAIN_ID, int(accountIndex), int(nonce), int(apiKeyIndex, 254));
    const publicKey = String(r.pk || ''), privateKey = String(r.prv || '');
    if (!/^[0-9a-f]{80}$/.test(publicKey) || !/^[0-9a-f]{80}$/.test(privateKey) || r.pubKeySuccess !== true) throw new Error('Lighter signer: key generation failed');
    loaded.set(accountIndex, publicKey);
    return { privateKey, publicKey, l1Body: String(r.body || '') };
  };
  return {
    newKey: (accountIndex, apiKeyIndex, nonce) => fromSeed(hex(crypto.getRandomValues(new Uint8Array(32))), accountIndex, apiKeyIndex, nonce),
    fromSeed,
    async use(privateKey, accountIndex, apiKeyIndex) {
      const prv = String(privateKey).replace(/^0x/, '');
      if (!/^[0-9a-f]{80}$/.test(prv)) throw new Error('Lighter signer: bad stored key');
      const r = await run('_createClientByPrv', prv, LIGHTER_CHAIN_ID, int(accountIndex), 0, int(apiKeyIndex, 254));
      const publicKey = String(r.pk || '');
      if (!/^[0-9a-f]{80}$/.test(publicKey)) throw new Error('Lighter signer: key did not load');
      loaded.set(accountIndex, publicKey);
      return { publicKey };
    },
    async changePubKeyBody(accountIndex, apiKeyIndex, nonce) { const r = await run('_getChangePubKeyTransaction', int(accountIndex), int(nonce), int(apiKeyIndex, 254)); return String(r.body || ''); },
    async changePubKey(accountIndex, l1Sig, nonce, apiKeyIndex) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(l1Sig)) throw new Error('Lighter signer: bad L1 signature');
      return tx(TX.changePubKey)(await run('_signChangePubKey', int(accountIndex), l1Sig, int(nonce), int(apiKeyIndex, 254)));
    },
    async createOrder(accountIndex, o, nonce) { return tx(TX.createOrder)(await run('_signCreateOrder', int(accountIndex), ...orderArgs(o), int(nonce))); },
    async grouped(accountIndex, groupingType, orders, nonce) {
      if (!orders.length || orders.length > 3) throw new Error('Lighter signer: 1–3 orders per group');
      return tx(TX.grouped)(await run('_signCreateGroupedOrders', int(accountIndex), int(groupingType, 3), orders.length, ...orders.flatMap(orderArgs), int(nonce)));
    },
    async cancelOrder(accountIndex, market, orderIndex, nonce) {
      if (!isUint(orderIndex, 56)) throw new Error('Lighter signer: bad order index');
      return tx(TX.cancelOrder)(await run('_signCancelOrder', int(accountIndex), int(market, 4095), orderIndex.toString(), int(nonce)));
    },
    async cancelAll(accountIndex, timeInForce, time, nonce, market) {
      return tx(TX.cancelAll)(await run('_signCancelAllOrders', int(accountIndex), int(timeInForce, 2), int(time), int(nonce), ...(market == null ? [] : [int(market, 4095)])));
    },
    async updateLeverage(accountIndex, market, imf, marginMode, nonce) {
      if (!Number.isInteger(imf) || imf < 1 || imf > 10000) throw new Error('Lighter signer: bad margin fraction');
      return tx(TX.updateLeverage)(await run('_signUpdateLeverage', int(accountIndex), int(market, 4095), imf, marginMode, int(nonce)));
    },
    async updateMargin(accountIndex, market, usdg, direction, nonce) {
      if (!isUint(usdg, 52) || usdg === 0n) throw new Error('Lighter signer: bad margin amount');
      return tx(TX.updateMargin)(await run('_signUpdateMargin', int(accountIndex), int(market, 4095), Number(usdg), direction, int(nonce)));
    },
    async withdraw(accountIndex, assetIndex, routeType, amount, nonce) {
      if (!isUint(amount, 60) || amount === 0n) throw new Error('Lighter signer: bad amount');
      return tx(TX.withdraw)(await run('_signWithdraw', int(accountIndex), int(assetIndex, 64), int(routeType, 1), amount.toString(), int(nonce)));
    },
    async transferBody(accountIndex, nonce, apiKeyIndex, to, asset, fromRoute, toRoute, amount, fee, memoHex) {
      if (!isUint(amount, 52) || !isUint(fee, 52) || !/^[0-9a-f]{64}$/.test(memoHex)) throw new Error('Lighter signer: bad transfer');
      const r = await run('_getTransferTransaction', int(accountIndex), int(nonce), int(apiKeyIndex, 254), int(to), int(asset, 64), int(fromRoute, 1), int(toRoute, 1), Number(amount), Number(fee), memoBytes(memoHex));
      if (r.pubKeySuccess !== true) throw new Error('Lighter signer: transfer body failed');
      return String(r.body || '');
    },
    async transfer(accountIndex, l1Sig, nonce, apiKeyIndex, to, asset, fromRoute, toRoute, amount, fee, memoHex) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(l1Sig) || !isUint(amount, 52) || !isUint(fee, 52) || !/^[0-9a-f]{64}$/.test(memoHex)) throw new Error('Lighter signer: bad transfer');
      return tx(TX.transfer)(await run('_signTransfer', int(accountIndex), l1Sig, int(nonce), int(apiKeyIndex, 254), int(to), int(asset, 64), int(fromRoute, 1), int(toRoute, 1), Number(amount), Number(fee), memoBytes(memoHex)));
    },
    async forget(accountIndex) {
      if (!loaded.has(accountIndex)) return;
      await run('_createClient', hex(crypto.getRandomValues(new Uint8Array(32))), LIGHTER_CHAIN_ID, int(accountIndex), 0, 0);
      loaded.delete(accountIndex);
    },
    async authToken(accountIndex, apiKeyIndex) {
      const r = await run('_createAuthToken', int(accountIndex), int(apiKeyIndex, 254));
      const token = String(r.token || ''), deadline = Number(r.deadline) || 0;
      if (!/^\d+:\d+:\d+:[0-9a-f]+$/.test(token)) throw new Error('Lighter signer: bad auth token');
      return { token, deadline };
    },
  };
}

let loading: Promise<LighterSigner> | null = null;
let loadedSigner: LighterSigner | null = null;
/** the signer if it was loaded in this frame, without loading it */
export const peekSigner = (): LighterSigner | null => loadedSigner;
/**
 * The signer, loaded once per frame. `fetchBytes` returns the wasm file's bytes (the engine fetches /vendor/<file> from
 * its own origin); anything whose SHA-256 is not SIGNER.sha256 is refused before it is compiled.
 */
export function loadSigner(fetchBytes: () => Promise<ArrayBuffer>): Promise<LighterSigner> {
  if (!loading) {
    loading = (async () => {
      const bytes = await fetchBytes();
      if (bytes.byteLength !== SIGNER.bytes || (await sha256Hex(bytes)) !== SIGNER.sha256) throw new Error('The perps signer file does not match its pinned hash — refused');
      installGo();
      const G = (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go;
      const go = new G();
      const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(instance).catch(() => {});   // runs until the frame closes (main blocks on a channel)
      const g = globalThis as unknown as Exports;
      for (let i = 0; i < 200 && !NAMES.every((n) => typeof g[n] === 'function'); i += 1) await new Promise((r) => setTimeout(r, 10));
      if (!NAMES.every((n) => typeof g[n] === 'function')) throw new Error('The perps signer did not start');
      // the Go side published its functions as globals: keep our own references and take them off globalThis, so nothing
      // else in this frame can call the signer (the Go runtime keeps its own handles; it never reads these names back)
      const own: Exports = {};
      for (const n of NAMES) { own[n] = g[n]; try { delete (globalThis as Record<string, unknown>)[n]; } catch { /* non-configurable: kept */ } }
      loadedSigner = wrap(own);
      return loadedSigner;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}
