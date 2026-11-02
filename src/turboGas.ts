// Turbo mode's gas limit (owner 2026-11-01, via the coordinator: «я даю добро на все»). Part of the TRADE CORE
// (docs/TRADE-CORE.md, pinned by test/trade-core-pin.mjs): no change without the owner's yes.
//
// Turbo asks the node nothing before it signs: no estimate, no simulation. Until 2026-11-01 every turbo send carried one fixed
// limit, 900,000 gas. That covers the plain venues with room to spare (a V4 / V3 / V2 / Infinity swap, a Pons curve:
// 100k-420k gas), but not the heavy ones. A Long.xyz launch bridged through another token (WETH → DJT on V3 → SAVE on V4,
// Doppler hook) needs 1.0-1.4M; Flap's BNB → quote → coin swap needs up to 0.9M; a curve buy that graduates the coin needs
// 0.85-1.6M. Those turbo buys ran out of gas, and an out-of-gas transaction burns its whole limit.
//
// The limit is now picked from the route shape, synchronously, from data already in hand (no request, no await), so the turbo
// click is exactly as fast as before. Every value is the most gas measured for that shape on the live chain
// (eth_estimateGas / eth_simulateV1, read-only, 2026-11-01, B:\tmp\foreman\turbo-gas.md), with about 1.5× headroom on top. It
// is never below 900,000 (a route that worked keeps at least what it had) and never above TURBO_GAS_MAX. The fee paid is the
// gas USED, not the limit: a higher limit costs nothing on a transaction that succeeds. It only raises the balance the node
// wants to see (limit × gas price: 5M gas ≈ 0.0002 ETH on Robinhood, ≈ 0.0005 BNB on BNB Chain at today's prices).
//
// Only the venue call itself gets the raised limit, i.e. a send to the route's own venue contract. Approvals and the V3
// bridge legs (≤ 0.4M measured) keep 900,000, except on a big buy (below), where the legs swap the big amount too.

export const TURBO_GAS = 900_000n;
export const TURBO_GAS_MAX = 5_000_000n;
// A buy of 1 ETH / BNB or more can walk through many initialised ticks of a thin pool. Measured on the live chains:
// up to 1.76M at 3 BNB on a V3 pool and 3.9M at 1 ETH on a thin stock pool. Those buys get TURBO_GAS_MAX. (Below 1, the
// heaviest plain swap measured was 0.52M.)
export const TURBO_BIG_BUY = 1;

// [measured max on the live chain → limit]
const DOPPLER_V4 = 2_000_000n;      // Long.xyz / DART hooked V4 pool: 1.40M (SAVE first buys 1.31-1.36M, up to 10 ETH 1.40M), sells ≈ 1.2M
const STANDARD_CURVE = 2_000_000n;  // standardreserve.xyz curve: 0.52M; the buy that graduates it 1.35M
const FLAP = 1_300_000n;            // Flap Portal, BNB in / quote-asset in: 0.48M; the buy that graduates the coin 0.85M
const FLAP_NATIVE_TO_QUOTE = 2_000_000n;   // Flap Portal swapping BNB → quote first: 0.90M at 0.5 BNB; ≈ 1.2M when it also graduates
const FOUR = 2_400_000n;            // four.meme TokenManager: 0.56M (0.63M behind a bridge leg); the buy that graduates it 1.56M

// launcher hooks whose pools fit the plain limit (Pons on Robinhood: 154k-166k direct, 320k behind the USDG bridge)
const LIGHT_HOOKS = new Set(['0x0000000000000000000000000000000000000000', '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044']);

export type TurboRoute = {
  type: string; stage?: string; nativeToQuote?: boolean;
  poolKey?: { hooks?: string } | null;
  curve?: string; router?: string; portal?: string; manager?: string;
};
const lc = (a?: string) => String(a || '').toLowerCase();

/** The gas limit of one turbo send. `to` is the contract the transaction calls; `at` the chain's Universal Router and V3
 *  router; `size` the click's buy size in ETH / BNB (ignored on a sell). */
export function turboGas(route: TurboRoute, side: 'buy' | 'sell', size: number, to: string, at: { ur: string; v3: string }): bigint {
  const t = lc(to), ur = lc(at.ur);
  let g = TURBO_GAS;
  if (route.type === 'v4') {
    if (t === ur && !LIGHT_HOOKS.has(lc(route.poolKey?.hooks))) g = DOPPLER_V4;
  } else if (route.type === 'standard') {
    if (route.stage === 'curve' && t === lc(route.router)) g = STANDARD_CURVE;
  } else if (route.type === 'flap') {
    if (t === lc(route.portal)) g = route.nativeToQuote ? FLAP_NATIVE_TO_QUOTE : FLAP;
  } else if (route.type === 'four') {
    if (t === lc(route.manager)) g = FOUR;
  }
  // a big buy: every swap of it (the venue call and a bridge leg in front of it), never an approval
  if (side === 'buy' && size >= TURBO_BIG_BUY && (t === lc(at.v3) || isVenue(route, t, ur))) g = TURBO_GAS_MAX;
  return g < TURBO_GAS ? TURBO_GAS : g > TURBO_GAS_MAX ? TURBO_GAS_MAX : g;
}
// the contract a route's own swap goes to (approvals go to a token or to Permit2)
function isVenue(route: TurboRoute, t: string, ur: string): boolean {
  switch (route.type) {
    case 'v4': case 'inf': return t === ur;
    case 'pons': return t === lc(route.curve);
    case 'standard': return route.stage === 'curve' ? t === lc(route.router) : t === ur;
    case 'flap': return t === lc(route.portal);
    case 'four': return t === lc(route.manager);
    case 'v2': return t === lc(route.router);
    default: return false;   // v3: its swap goes to the V3 router (above)
  }
}
