// BNB Chain terminal-fee venue extension for the vault boundary. Pure + read-only; no signing, no sends.
// Default OFF: an empty/absent venue flag reproduces the original candidate exactly (BNB = Pancake V2 only).
// Each venue listed here is additionally subject to the deployment's finite marketKeys registry.
import { encodeAbiParameters, keccak256, parseAbi } from 'viem';
export const BNB_EXTRA_VENUES = Object.freeze(['v3', 'inf', 'four', 'flap']);
export const FOUR_SELL_QUANTUM = 1000000000n;
const ZERO = '0x0000000000000000000000000000000000000000';
// Pinned BNB deployments (independently read on a BSC mainnet-state fork 2026-11-09: SmartRouter.factory()).
export const BNB_PINS = Object.freeze({
    v3Factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    clPoolManager: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',
    wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
});
const V3_FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const V3_POOL_ABI = parseAbi(['function liquidity() view returns(uint128)', 'function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)']);
const CL_ABI = parseAbi(['function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32) view returns(uint128)']);
const lc = x => String(x || '').toLowerCase();
const same = (a, b) => lc(a) === lc(b);
const refuse = why => { throw Object.assign(Error(`Terminal EVM refused: ${why}`), { name: 'TerminalEvmRefused' }); };
/** Validates the compile-time flag. Anything other than a subset of BNB_EXTRA_VENUES is a configuration error. */
export function bnbTerminalVenues(flag) {
    if (flag === undefined || flag === null) return Object.freeze([]);
    if (!Array.isArray(flag) || flag.some(v => !BNB_EXTRA_VENUES.includes(v)) || new Set(flag).size !== flag.length)
        refuse('invalid BNB venue flag');
    return Object.freeze([...flag]);
}
/** Venue types the vault may execute on a chain. Flag off => exactly the original matrix. */
export function enabledTerminalVenueTypes(chain, flag) {
    if (chain === 'bsc') return Object.freeze(['v2', ...bnbTerminalVenues(flag)]);
    if (chain === 'robinhood') return Object.freeze(['v4']);
    return Object.freeze([]);
}
export const infPoolId = pk => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'bytes32' }], [pk.currency0, pk.currency1, pk.hooks, pk.poolManager, pk.fee, pk.parameters]));
/** Exact sell input both the vault and the quote server must derive. four.meme only accepts multiples of 1e9 base units. */
export function terminalSellAmount({ balance, pctBps, route }) {
    if (typeof balance !== 'bigint' || balance < 0n || !Number.isInteger(pctBps) || pctBps < 1 || pctBps > 10000) refuse('sell amount');
    const raw = balance * BigInt(pctBps) / 10000n;
    return route?.type === 'four' ? raw / FOUR_SELL_QUANTUM * FOUR_SELL_QUANTUM : raw;
}
/** Extra fail-closed checks for the BNB venues added by this candidate, on top of the existing verifyEvmRoute.
 *  `client` is the vault's pinned-chain client. Never called for v2/RH v4 (original behaviour untouched). */
export async function verifyBnbVenue({ route: r, token, side, amount, client }) {
    if (r.type === 'inf') {
        const pk = r.poolKey;
        // No hooks: hook address zero AND no registered hook permission bits (low 16 bits of `parameters`).
        if (!pk || !same(pk.hooks, ZERO) || (BigInt(pk.parameters) & 0xffffn) !== 0n) refuse('Infinity pools with hooks are not enabled');
        if (!same(pk.poolManager, BNB_PINS.clPoolManager) || pk.fee === 0x800000) refuse('Infinity pool manager or dynamic fee');
        const id = infPoolId(pk);
        const [slot0, liquidity] = await Promise.all([
            client.readContract({ address: BNB_PINS.clPoolManager, abi: CL_ABI, functionName: 'getSlot0', args: [id] }),
            client.readContract({ address: BNB_PINS.clPoolManager, abi: CL_ABI, functionName: 'getLiquidity', args: [id] }),
        ]);
        if (!(slot0?.[0] > 0n) || !(liquidity > 0n)) refuse('Infinity pool is not initialized or has no liquidity');
    } else if (r.type === 'v3') {
        if (!Number.isInteger(r.fee)) refuse('V3 fee');
        const pool = await client.readContract({ address: BNB_PINS.v3Factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [token, r.quoteToken, r.fee] });
        if (same(pool, ZERO) || (r.pool && !same(pool, r.pool))) refuse('V3 pool is not the factory pool');
        const liquidity = await client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity' });
        if (!(liquidity > 0n)) refuse('V3 pool has no active liquidity');
    } else if (r.type === 'four') {
        if (side === 'sell' && (typeof amount !== 'bigint' || amount % FOUR_SELL_QUANTUM !== 0n)) refuse('four.meme sell amount quantum');
    } else if (r.type === 'flap') {
        // Flap taxes are charged inside the Portal; plain wallet transfers are measured by the router's exact-input check.
        if (r.permitData && r.permitData !== '0x') refuse('Flap permit data');
    } else refuse('venue not enabled in this candidate');
}
