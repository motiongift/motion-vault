// Elysium (Kinetiq's Arbitrum Orbit L2, chain 99901, gas = HYPE) — the pure half of the vault's Elysium trade path
// (trade-core.patch E1, 2026-11-03; NOT released: the owner approves it line by line after an independent review).
//
// Everything the vault decides before it signs an Elysium trade lives here, without a browser or a network, so the tests in
// test/elysium-*.mjs exercise exactly these functions. webEngine.ts (its ELYSIUM section) only reads the chain and signs.
//
// What the vault trusts on Elysium, and why (checked read-only on chain 2026-11-03, B:\tmp\elysium-trade\logs\probe*.txt):
//   - Uniswap's own stack: PoolManager 0xE2e1…23F1 and V4Quoter 0x379f…14f5 are byte-for-byte the code motion already trusts
//     on Robinhood Chain (only their own-address immutables differ); Permit2 / Multicall3 are the canonical contracts;
//     Universal Router 0x1b34…3c1a is bound (immutables) to that PoolManager, to the V3 factory 0x1707…7a9f with the
//     canonical V3 pool init code hash e34f…8b54, to WHYPE 0xbA87…5E81 and to Permit2.
//   - ElysPump's stack is the SAME code: its PoolManager 0x5fb0…9600 and V3 factory 0x367F…Fc3e are Uniswap's bytecode with
//     only their own address different; its Universal Router 0x751C…b430 is byte-identical to Uniswap's 0x1b34… except the
//     immutables (its PoolManager, its V3 factory, its position managers, its V2 factory); same pool init code hash.
//   - NOT trusted, never called: Kleos' and BOXA's own routers (KleosV4Router 6.4 KB, KleosV5Router 16.5 KB, BoxaV4Router 2.9 KB) —
//     unaudited custom code (both sites were on MetaMask's phishing list). Release 6: their PoolManagers / V3 factories (Uniswap
//     code) are traded through motion-deployed copies of Uniswap's own router 0x1b34 (only immutables changed), each trusted for
//     its exact code (ELY_ROUTER_PINS, checked in every probe), and only behind hooks reviewed and pinned below.
// What a trade can cost when something here is wrong is bounded on purpose: no standing approval is ever given on Elysium
// (every sell approves EXACTLY its amount, to Permit2 and from Permit2 to the router, for 15 minutes; leftovers are reset),
// a buy sends exactly its HYPE, and every swap carries a floor computed from a simulation of the exact call on the live
// chain. No platform fee: the calldata has no fee leg (0% platform fees).
import { encodeAbiParameters, encodeFunctionData, decodeFunctionResult, encodePacked, keccak256, getCreate2Address, toHex, type Hex } from 'viem';
import { encodeV4BuyNative, encodeV4BuyViaWeth, encodeV4Sell, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, MAX_STATIC_FEE, DYNAMIC_FEE_FLAG, type V4PoolKey } from './evmV4Router.ts';

const lc = (a?: string) => String(a || '').toLowerCase();
export const ELY_CHAIN_ID = 99901;
export const ELY_ZERO = '0x0000000000000000000000000000000000000000' as const;
export const ELY_WHYPE = '0xba876237b0f021a6c6d852d6c26e107997cc5e81' as const;
export const ELY_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
export const ELY_MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as const;
// Uniswap V3's canonical pool init code hash (every factory below deploys exactly this pool code)
export const ELY_V3_INIT_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' as const;

// The four venues the vault signs for on Elysium: a PoolManager or a V3 factory, and the ONE router bound to it.
// Release 6 (owner, 2026-11-04: «поключи ансаппортед чтобы тоже можно было ими всеми торговать … делай нормально»; B:\tmp\elysium-hooks):
// the launchpads' own PoolManagers (Kleos 0xb308, BOXA 0x06c6, Eleos 0x5c54) and V3 factories (Kleos 0x809f, BOXA 0xd5a7, RonsPad
// 0x24e2) are Uniswap's V4 PoolManager / V3Factory byte for byte (only their own-address immutable differs; same pool init code hash).
// Each gets a Universal Router that is Uniswap's Elysium router 0x1b34 with only its immutables changed (PoolManager, V3 factory, own
// address, permissions adapter 0 as in ElysPump's 0x751c), deployed by the owner through the CREATE2 deployer 0x4e59 at a fixed address
// (B:\tmp\elysium-hooks\deploy). Every router is trusted for its CODE (ELY_ROUTER_PINS): until a router is deployed with exactly the
// pinned code, the probe's guard answers "no pool" for every case through it, so nothing is ever signed for it.
// Release 7 proposal (B:\tmp\elysium-venues): PHASE A = four more stock Uniswap V3Factory copies (0x75dc, 0x7266, 0x6260, 0xf460) and two
// stock V4 PoolManager copies (0xe5bd, 0x9fc4), each with a router derived exactly like the four above (immutables only).
// PHASE B (opt-in, owner's explicit yes): two routers that are NOT immutables-only:
//   'sk-v3'  Stockium's V3 fork 0x4f66: Uniswap's V3Factory with the 3 pool callbacks renamed (swap 0x57ec3e25), so pool init hash
//            0xab731c88…bec4; its router = 0x1b34's code + the swap-callback PUSH4 operand (byte 184) + that init hash (byte 7514).
//   'klw-v3' Kleos V3 0x809f pools quoted in Kleos' own WHYPE 0x0269…9eef (WETH9 interface, no admin, fully backed), e.g. KLEOS
//            itself (1 % tier); its router = the Kleos router with the weth9 immutable (3 sites) set to 0x0269.
export type ElyVenue = 'uni-v4' | 'ep-v4' | 'uni-v3' | 'ep-v3' | 'kl-v4' | 'kl-v3' | 'bx-v4' | 'bx-v3' | 'el-v4' | 'rp-v3'
  | 'x75-v3' | 'x72-v3' | 'x62-v3' | 'xf4-v3' | 'xe5-v4' | 'x9f-v4' | 'sk-v3' | 'klw-v3';
export const ELY_VENUES = {
  'uni-v4': { kind: 'v4', label: 'Uniswap V4', manager: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', router: '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a' },
  'ep-v4': { kind: 'v4', label: 'ElysPump V4', manager: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', router: '0x751cefb96ac88db5327d39e0fbdd5d882d80b430' },
  'uni-v3': { kind: 'v3', label: 'Uniswap V3', factory: '0x1707327f626496a7b5b3872e7e4d2879df7d7a9f', router: '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a' },
  'ep-v3': { kind: 'v3', label: 'ElysPump V3', factory: '0x367f85886af509e364c8190862bc714555fefc3e', router: '0x751cefb96ac88db5327d39e0fbdd5d882d80b430' },
  'kl-v4': { kind: 'v4', label: 'Kleos V4', manager: '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', router: '0xa226f04cececc3b1ee0ac6f18132db96987cea37' },
  'kl-v3': { kind: 'v3', label: 'Kleos V3', factory: '0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1', router: '0xa226f04cececc3b1ee0ac6f18132db96987cea37' },
  'bx-v4': { kind: 'v4', label: 'BOXA V4', manager: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', router: '0xeff2423d2b7fb97cbc41994b01c7a8177990394f' },
  'bx-v3': { kind: 'v3', label: 'BOXA V3', factory: '0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3', router: '0xeff2423d2b7fb97cbc41994b01c7a8177990394f' },
  'el-v4': { kind: 'v4', label: 'Eleos V4', manager: '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', router: '0x93a5d9271ac5dbe68a2b96ef7a23576eaad15a11' },
  'rp-v3': { kind: 'v3', label: 'RonsPad V3', factory: '0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f', router: '0x90d63fd4ab5bc0b9815cda273cfd5b918afb9168' },
  // phase A (stock, immutables only)
  'x75-v3': { kind: 'v3', label: 'V3 0x75dc', factory: '0x75dc4e1ac45d332e96821c62dc72039f428b2225', router: '0x72f0b62115788a3e73c2e64130a181588f266f98' },
  'x72-v3': { kind: 'v3', label: 'V3 0x7266', factory: '0x7266c0ecff2a687b4ad0ead7b24840929540b697', router: '0x45a7f90f3cfd605c71cc2abf3ef50e67707d8384' },
  'x62-v3': { kind: 'v3', label: 'V3 0x6260', factory: '0x626005ca43f45568ad5f084087e5ae7cbba04e06', router: '0xf2ee65cab8a036b2f344a3b52ed13327de5e8092' },
  'xf4-v3': { kind: 'v3', label: 'V3 0xf460', factory: '0xf460854da9a40ad833c27996c749c1b8baaf3b86', router: '0xe8bd48bf9485d0a3304448175de9738c7d550f2b' },
  'xe5-v4': { kind: 'v4', label: 'V4 0xe5bd', manager: '0xe5bdc9a87b54ac1624cb51095dc86636378c4fb6', router: '0x53b1d0dc90912bbdb16f30edd8c9b4f0e30d0093' },
  'x9f-v4': { kind: 'v4', label: 'V4 0x9fc4', manager: '0x9fc48776883a89b9611979069ce25be1e82a536d', router: '0x6914053b2bdcd1c30bb5476fed6018a2ae0c3449' },
  // phase B (opt-in): per-venue pool init hash / wrapped HYPE
  'sk-v3': { kind: 'v3', label: 'Stockium V3', factory: '0x4f66184a9ffabb7f7071d590c2c48dedf41676f4', router: '0x78088ead4aea127d9134d992b29b40cfb6542964', initHash: '0xab731c888a784cd72dd98028619d80deda496aa32aefca8b3c9062312c62bec4' },
  'klw-v3': { kind: 'v3', label: 'Kleos V3 (Kleos WHYPE)', factory: '0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1', router: '0x49854cdc529f76dcf3b90b2ec04e6cfa94fd4b3f', wrapped: '0x0269031ace34a7821e9d9980d087c35ce7c19eef' },
} as const satisfies Record<ElyVenue, { kind: 'v4'; label: string; manager: string; router: string } | { kind: 'v3'; label: string; factory: string; router: string; initHash?: string; wrapped?: string }>;
// the V3 pool init code hash and the wrapped HYPE a venue's pools use (every venue but 'sk-v3' / 'klw-v3': Uniswap's / canonical WHYPE)
export const elyV3InitHashOf = (venue: string): Hex => ((ELY_VENUES as Record<string, { initHash?: string }>)[venue]?.initHash || ELY_V3_INIT_HASH) as Hex;
export const elyWrappedOf = (venue: string): Hex => ((ELY_VENUES as Record<string, { wrapped?: string }>)[venue]?.wrapped || ELY_WHYPE) as Hex;
// Every router the vault may ever call or approve on Elysium (the sell's Permit2 allowance goes to one of these only)
export const ELY_ROUTERS: readonly string[] = [...new Set(Object.values(ELY_VENUES).map((v) => v.router))];
// release 7: the wrapped HYPE a router wraps / unwraps (its weth9 immutable): Kleos WHYPE for 'klw-v3', canonical WHYPE for every other one
export const elyRouterWrapped = (router: string): Hex => {
  const v = Object.entries(ELY_VENUES).find(([, x]) => x.router === lc(router));
  return v ? elyWrappedOf(v[0]) : (ELY_WHYPE as Hex);
};
// Release 6: keccak256 of each router's runtime code (its EXTCODEHASH). 0x1b34 / 0x751c read on chain 2026-11-04 (block 417360);
// the four new ones = the runtime B:\tmp\elysium-hooks\deploy\kit.mjs derives from 0x1b34's code for each fixed CREATE2 address
// (eth_simulateV1 of the deployment: the code at the predicted address hashes to these). Checked in every probe by ELY_GUARD.
export const ELY_ROUTER_PINS: Readonly<Record<string, Hex>> = {
  '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a': '0xa3b1ff66d689e45ddfb2f0ba861e5e681a476be3ced9c7376f1952c478dc9f53',   // Uniswap
  '0x751cefb96ac88db5327d39e0fbdd5d882d80b430': '0x6bbdf8bdcb1336bc11b6014cf9632ad922e7466a4902abded04dd24d9de06999',   // ElysPump
  '0xa226f04cececc3b1ee0ac6f18132db96987cea37': '0xe15f85a796df9e204082c594e27a4ef335485cd91c52f78654f4daa5454c2e6a',   // Kleos (V4 + V3)
  '0xeff2423d2b7fb97cbc41994b01c7a8177990394f': '0x5688072bb686278f17ac1f6ce29e756aaa3cd4c2937f89a3bf50bceef392588c',   // BOXA (V4 + V3)
  '0x93a5d9271ac5dbe68a2b96ef7a23576eaad15a11': '0xd7a30e8e5513e151186b98c5fc26e671a896f4b2936c67736d585b98a2b54548',   // Eleos (V4)
  '0x90d63fd4ab5bc0b9815cda273cfd5b918afb9168': '0x864430ad14bc9df3312c83b69e54038b6ff53bf0cdc803bb3c83684a933215b4',   // RonsPad (V3)
  // release 7 proposal: B:\tmp\elysium-venues\kit\kit.mjs runtime for each CREATE2 address (eth_simulateV1 of the deployment: == these)
  '0x72f0b62115788a3e73c2e64130a181588f266f98': '0x7d37712b904d2866d276abddf614845e47cf472131db04a8720dd56a641727bd',   // V3 0x75dc
  '0x45a7f90f3cfd605c71cc2abf3ef50e67707d8384': '0x9932a405c19cee9aeaddb046b6b16342cc46b0ac6cc1e933dd706dc7c415d7be',   // V3 0x7266
  '0xf2ee65cab8a036b2f344a3b52ed13327de5e8092': '0x5efa1616c9d465f599d707ca5477fbbf631ac18796befcdfa3e2fd6128375c7f',   // V3 0x6260
  '0xe8bd48bf9485d0a3304448175de9738c7d550f2b': '0x58586042025eb2d69f38da69246a190c603c9b439be33f7ebb7a98895305ee23',   // V3 0xf460
  '0x53b1d0dc90912bbdb16f30edd8c9b4f0e30d0093': '0xedd95cc60bd7f0a445271883afd682ba4a51fe500e53f3a08e1b8a17592795fb',   // V4 0xe5bd
  '0x6914053b2bdcd1c30bb5476fed6018a2ae0c3449': '0x332506ee6e0aa6735ed45e1a027df013e5ddc5a89d3f1fa1c7a6437f848bb766',   // V4 0x9fc4
  '0x78088ead4aea127d9134d992b29b40cfb6542964': '0xde5ddd916696fd2975fe127ebc8d71dd4e7cb19b18fed70adffae20167d3fa46',   // Stockium (phase B)
  '0x49854cdc529f76dcf3b90b2ec04e6cfa94fd4b3f': '0x99471b4edde5884290c99a1167ab3c2c336f8ef1d75aec1e833b58f1c1286bab',   // Kleos WHYPE (phase B)
};
export const elyRouterPin = (router: string): Hex | '' => (Object.prototype.hasOwnProperty.call(ELY_ROUTER_PINS, lc(router)) ? ELY_ROUTER_PINS[lc(router)] : '');

// ── V4 hooks ──
// A hook's permissions are the low 14 bits of its address. The four that touch a swap: beforeSwap (1<<7), afterSwap (1<<6),
// beforeSwapReturnDelta (1<<3), afterSwapReturnDelta (1<<2). A hook with none of them is never called on a swap (only at
// initialize / liquidity), so its pools swap like hookless ones; with a STATIC fee (a dynamic fee is the hook's to change)
// at most MAX_STATIC_FEE (10 %). A hook that does touch swaps is signed for only when it is on this list, per PoolManager;
// what it takes is bounded by the floor (every swap's minimum comes from a simulation of that very call) and a launch whose
// round trip loses more than ELY_ROUNDTRIP_MAX_BPS is refused before the buy.
export const ELY_SWAP_HOOK_FLAGS = 0xcc;
// Stage 3 (owner, 2026-11-04): a hook is trusted for its CODE, not only its address. Each entry pins the keccak256 of the hook's
// runtime code (its EXTCODEHASH, read on chain 2026-11-04); every probe checks it on the live state in the same call that measures
// the pool (elyProbeState's guard, below). A hook whose code is not exactly the reviewed one = its pools do not exist for the vault.
export const ELY_SWAP_HOOKS: Record<string, Readonly<Record<string, Hex>>> = {
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': {
    // ElysPump's launch hook (beforeInitialize, before/afterSwap, both return deltas; 22,083 bytes): every ElysPump V4 launch
    '0xe11cafa5901b0aab51eb78251488400f9e4320cc': '0xe092fe7f04001d4a23e8a3d50b1afbde84ea3abfc2d48da2e96d3cd4f947fee3',
    // "HomerPoolHook" (2,084 bytes; permissions 0x2044 = beforeInitialize, afterSwap, afterSwapReturnDelta), reviewed from its
    // bytecode 2026-11-04 (B:	mpelysium-tradestage3hook-0x1295bd9d.txt):
    //   - bound to THIS PoolManager (immutable; every hook call checks the caller); beforeInitialize refuses a dynamic fee, a zero
    //     fee and any fee above 90,000 (9 %), so the pool's fee is static and fixed for the pool's life;
    //   - afterSwap takes |unspecified amount| × pool fee / 9,000,000 (= 1/9 of the pool fee, ≤ 1 %) through the PoolManager's own
    //     delta (PoolManager.take to its recipient) — never a transfer from the swapper, never more than that; total ≤ 10 %;
    //   - owner powers: setRecipient (non-zero) and Ownable2Step only; no fee setter, no pause, no blacklist, no delegatecall, no
    //     selfdestruct.
    // Release 7: REFUSED (ELY_REFUSED_HOOKS). Its afterSwap pays the cut with PoolManager.take(currency, recipient, cut); on a sell of its
    // native-quoted pools that sends HYPE to the owner-set recipient, so the owner (EOA 0x206e…75f4) can setRecipient(a contract that
    // refuses HYPE) and every later sell reverts (simulated on QUOTED: 94.11 % back, then revert 0x90bfb865). A freeze lever, like ELYSIAN.
  },
  // Release 6 (B:\tmp\elysium-hooks\reviews\review-<hook>.txt; every pin read on chain 2026-11-04, block 417360). Each one is bound to
  // its PoolManager (caller check), works through any router with empty hookData, is no proxy, has no pause / blacklist / sender check
  // on the swap path; what it takes is its own fee as a return delta (PoolKey.fee is 0), bounded by ELY_HOOK_RULES at every buy.
  // NOT trusted, refused like every hook not listed: BOXA's graduated-pool hook 0xf38d…eaec (the fee treasury's admin can freeze
  // every sell with one role revoke, simulated) and Kleos' 0x4d5f…68c0 (its owner holds the LP and pulled APOGEE's, block 404612).
  '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1': {
    // Flaunch-type PositionManager (21,966 B, flags 0x25dc): per-pool fee fixed at launch (base ≤ 5 %; anti-snipe ≤ 30 % for ≤ 900 s);
    // the owner can add notifier subscribers (gas griefing only, failures ignored). VOLTA, VCAT, VOLT…
    '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': '0x5087d2c7278b95cc4b8db5013740d556b37a26e8798c3b4f9a2325cbec4c9c66',
    // HIPS' hook (10,309 B, flags 0x20cc): feeBps fixed at registerPool (factory only, ≤ 1000), re-registering reverts
    '0xe6b9d1636b0a7529bb93295bc41707439263a0cc': '0x0c2cc553af57e37c95b72b787778d052c43333474ce7bd9688bb4ec04a1f1311',
  },
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490': {
    // Kleos (23,642 B): tax 100–1000 bps per side fixed at registration (re-registering refused; the creator can only lower it)
    '0xd5068e7f4e2d70d5efbac6fd28a8407252e1eacc': '0x8e43719af855137925a6e23aa7de68e5088043482d96c4e671b84a692fca3874',
    // Kleos (13,791 B): the same tax math, but the launcher (an EOA's) can re-register a live coin up to 1000 bps: read at every buy
    '0x0c835e6a51717a514144d95c7f0a1c640179e0cc': '0xaf16a01031be47d7e640b63afd04fd8e6d5bc28d9711e83aca70734cc65b1633',
  },
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4': {
    // BOXA (~10 KB each; no owner; liquidity locked forever; buy / sell fee fixed at registration, ≤ 10 %; 60 s anti-snipe)
    '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc': '0x210aad55bc3dee165cb7855e5e08c4466e66640d9f73ad25a758d430929954c2',
    '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc': '0x8241dd658e717e009a89c23d6365a209f3e23d46dc64ef2ad32f6edb6b8ad7c3',
    '0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc': '0x254a009a9d1cfba2d31faa5e46b4dfbc3322fda0d593658e9cd87da31c1c15f8',   // = 0xb3e2's code but its launcher() immutable
    // BOXA (14,993 B): feeBps = tax + creator + protocol ≤ 1000; setPaused does not gate swaps (simulated); a sniper surcharge window
    '0xa07345953c6efaf223676dabfe05421583a0e8cc': '0x125509302c3939efc28fec672c677ff368834a3a9a37c33ee7a5e32097650f07',
  },
  '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da': {
    // Eleos (23,182 B): tax ≤ 1000 bps fixed at registration (creator can only lower); 50 % snipe surcharge decaying over ≤ 600 s
    '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc': '0x32738acdbbfb485c66475a975598df41427bd050071ceb9f4e9ceaded2428044',
  },
};
// Release 6: the hook's tax is NOT the pool fee (PoolKey.fee = 0; the hook takes it as a return delta), so v4KeyProblem's 10 % ceiling
// never sees it. Every BUY through one of these hooks runs these reads in the probe's own eth_call (ELY_GUARD: no extra round trip) and
// is "no pool" unless all hold: each side's tax ≤ 10 %, the hook's own record of the coin's pool = this pool (its key's hash = the pool
// id), and no buy inside a launch / anti-snipe window. Word layouts read on chain 2026-11-04 (block 417360; D:\tmp\agent-tmp\rel6\hooks\
// hookreads.json). A SELL runs only the code pins: the exit is never refused for a tax (its floor comes from the simulation of the
// exact sell, tax included).
export type ElyRule = { target: Hex; data: Hex; op: number; i: number; j: number; k: number; value: bigint };
export const ELY_RULE = { LE: 1, HASH: 2, AFTER: 3, WINDOW_LE: 4 } as const;
const callOf = (sel: string, arg: string): Hex => (sel + lc(arg).replace(/^0x/, '').padStart(64, '0')) as Hex;
const rule = (target: string, data: Hex, op: number, i: number, value: bigint, j = 0, k = 0): ElyRule => ({ target: lc(target) as Hex, data, op, i, j, k, value });
export const ELY_HOOK_MAX_BPS = 1000n;        // 10 % per side, as MAX_STATIC_FEE and the hooks' own code caps
export const ELY_HOOK_MAX_PIPS = 100_000n;    // the same 10 % in pips (BOXA)
const kleosRules = (h: string, token: Hex, poolId: Hex): ElyRule[] => {
  const t = callOf('0xbbb356a6', token);
  return [rule(h, t, ELY_RULE.LE, 2, ELY_HOOK_MAX_BPS), rule(h, t, ELY_RULE.LE, 3, ELY_HOOK_MAX_BPS), rule(h, callOf('0x8652edf9', token), ELY_RULE.HASH, 0, BigInt(poolId))];
};
const boxaRules = (h: string, poolId: Hex, at: number): ElyRule[] => {
  const d = callOf('0xb5217bb4', poolId);
  return [rule(h, d, ELY_RULE.LE, at + 1, ELY_HOOK_MAX_PIPS), rule(h, d, ELY_RULE.LE, at + 2, ELY_HOOK_MAX_PIPS), rule(h, d, ELY_RULE.AFTER, at, 60n)];
};
export const ELY_HOOK_RULES: Readonly<Record<string, (x: { token: Hex; poolId: Hex }) => ElyRule[]>> = {
  // poolFees(poolId) 0x2cb79b72: [baseFeeBps, antiSnipeFeeBps, antiSnipeSecs, launchedAt, …]: base ≤ 500; inside the window the fee ≤ 10 %
  '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': ({ poolId }) => { const h = '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc', d = callOf('0x2cb79b72', poolId);
    return [rule(h, d, ELY_RULE.LE, 0, 500n), rule(h, d, ELY_RULE.WINDOW_LE, 3, ELY_HOOK_MAX_BPS, 2, 1)]; },
  // poolConfig(poolId) 0x0885f732: word 3 = feeBps (HIPS 100)
  '0xe6b9d1636b0a7529bb93295bc41707439263a0cc': ({ poolId }) => [rule('0xe6b9d1636b0a7529bb93295bc41707439263a0cc', callOf('0x0885f732', poolId), ELY_RULE.LE, 3, ELY_HOOK_MAX_BPS)],
  // taxOf(coin) 0xbbb356a6: words 2, 3 = buy / sell bps; poolKeyOf(coin) 0x8652edf9 = exactly this pool
  '0xd5068e7f4e2d70d5efbac6fd28a8407252e1eacc': ({ token, poolId }) => kleosRules('0xd5068e7f4e2d70d5efbac6fd28a8407252e1eacc', token, poolId),
  '0x0c835e6a51717a514144d95c7f0a1c640179e0cc': ({ token, poolId }) => kleosRules('0x0c835e6a51717a514144d95c7f0a1c640179e0cc', token, poolId),
  // pools(poolId) 0xb5217bb4: words 7 / 8 / 9 = launchedAt / buyFee / sellFee (pips); no buy before launchedAt + 60 s
  '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc': ({ poolId }) => boxaRules('0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc', poolId, 7),
  // the same at words 8 / 9 / 10
  '0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc': ({ poolId }) => boxaRules('0xb3e25cdf4a2f42e7f37ab3ae43bfb90ee8052acc', poolId, 8),
  '0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc': ({ poolId }) => boxaRules('0xd2f8e16ba85e9d160724e893b3ebce53d00e6acc', poolId, 8),
  // feeBps(coin) 0x0eb1b8aa: buy, sell bps; currentSniperBps(coin) 0x1daf62d6 = 0; poolKey(coin) 0x55d1cb60 = exactly this pool
  '0xa07345953c6efaf223676dabfe05421583a0e8cc': ({ token, poolId }) => { const h = '0xa07345953c6efaf223676dabfe05421583a0e8cc', f = callOf('0x0eb1b8aa', token);
    return [rule(h, f, ELY_RULE.LE, 0, ELY_HOOK_MAX_BPS), rule(h, f, ELY_RULE.LE, 1, ELY_HOOK_MAX_BPS), rule(h, callOf('0x1daf62d6', token), ELY_RULE.LE, 0, 0n), rule(h, callOf('0x55d1cb60', token), ELY_RULE.HASH, 0, BigInt(poolId))]; },
  // config(coin) 0x0e68ec95: words 1, 2 = buy / sell bps; keyFor(coin) 0x2a9c5cb1 = exactly this pool; book(coin) 0x7ca81460 word 0 =
  // the launch time: no buy in the first 600 s (the decaying 50 % snipe surcharge)
  '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc': ({ token, poolId }) => { const h = '0x8680965555dcea2a4c0ed3a29e59a8aa424e6acc', c = callOf('0x0e68ec95', token);
    return [rule(h, c, ELY_RULE.LE, 1, ELY_HOOK_MAX_BPS), rule(h, c, ELY_RULE.LE, 2, ELY_HOOK_MAX_BPS), rule(h, callOf('0x2a9c5cb1', token), ELY_RULE.HASH, 0, BigInt(poolId)), rule(h, callOf('0x7ca81460', token), ELY_RULE.AFTER, 0, 600n)]; },
};
// the buy-time rules of a trusted hook (none for a hookless pool or a hook without rules: ElysPump's two)
export const elyHookRules = (hooks: string, token: string, poolId: Hex): ElyRule[] => {
  const f = Object.prototype.hasOwnProperty.call(ELY_HOOK_RULES, lc(hooks)) ? ELY_HOOK_RULES[lc(hooks)] : null;
  return f ? f({ token: lc(token) as Hex, poolId }) : [];
};
// the pinned code hash of a swap hook trusted on that PoolManager, or '' (own properties only: '__proto__' / 'constructor' are not hooks)
export const elyHookPin = (manager: string, hooks: string): Hex | '' => {
  const m = ELY_SWAP_HOOKS[lc(manager)];
  return m && Object.prototype.hasOwnProperty.call(m, lc(hooks)) ? m[lc(hooks)] : '';
};
export const hookSwapFlags = (hooks: string): number => Number(BigInt(lc(hooks) || '0x0') & 0x3fffn) & ELY_SWAP_HOOK_FLAGS;

// ── release 7: hook tiers (owner in chat 2026-11-04: «поключи ансаппортед чтобы тоже можно было ими всеми торговать … делай нормально»;
// «Да, автохуки»; «выводи и также пиши что не проверено, лучше так блять, главное чтобы они под лаучпадом были тогда на доске выводи вот
// как у них; через поиск любую можно найти и купить; на доске не должно быть монет которые нельзя купить») ──
//   'reviewed'    Tier 1: the hook's CODE HASH is one a human reviewed (ELY_HOOK_CODES, per PoolManager). Any address with exactly that
//                 runtime is the same contract: its immutables (PoolManager, launcher, treasury …) are bytes of the runtime, so the same
//                 hash means the same immutables (test/elysium-rel7-immutables.mjs). Constructor STORAGE may differ; the review of each
//                 family (rel7 family-storage check) found no stored value that lets a fresh deployment block a sell or lift a fee past
//                 its code cap, and the buy-time rules read the per-pool values that matter.
//   'auto'        Tier 2: not reviewed, not refused, and the lane's watcher passed its automatic checks (static + live sims). The vault
//                 takes this from the lane as a label: the same guards as 'unverified', without the per-buy cap.
//   'unverified'  Tier 3: any other hook with swap flags on a stock V4 PoolManager (ELY_OPEN_MANAGERS) whose code is not refused, with a
//                 STATIC pool fee ≤ 10 % (a dynamic fee behind an unreviewed hook cannot be bounded: refused).
// Every tier keeps every guard of every buy: the probe's buy + sell-back + 1 % transfer (honeypot / tax), the plain-wallet buy-then-sell
// simulation, the impact guard, motion's second reading. 'auto' / 'unverified' add: the 0.002 HYPE buy-and-sell-back must return ≥ 80 %
// (≈ the 10 %/side cap a reviewed hook's rules enforce) and, for 'unverified', ELY_UNVERIFIED_MAX_BUY per buy.
// The lane names the hook's code hash (route.hook.codeHash, read from ≥ 2 nodes). The vault never takes it on trust: ELY_GUARD answers
// "no pool" unless EXTCODEHASH(hook) is exactly that hash on the live state of the probe call, so a wrong claim can only refuse a trade,
// and a refused code at a fresh address stays refused (ELY_REFUSED_HOOK_CODES).
export type ElyHookTier = 'reviewed' | 'auto' | 'unverified';
// stock V4 PoolManagers (Uniswap's code byte for byte but their own-address immutable; read 2026-11-04) where unreviewed hooks may trade
export const ELY_OPEN_MANAGERS: readonly string[] = [
  '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1',   // Uniswap
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600',   // ElysPump
  '0xb308b5df891c300a5f5a5b8fdbc30108ba842490',   // Kleos
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4',   // BOXA
  '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da',   // Eleos
  '0xe5bdc9a87b54ac1624cb51095dc86636378c4fb6',   // V4 0xe5bd
  '0x9fc48776883a89b9611979069ce25be1e82a536d',   // V4 0x9fc4
];
// Release 7's four new reviews (bytecode, read-only sims 2026-11-04), all on Uniswap's PM:
const R7_ASC = '0x190f4d572cbca47e96519434e6c6dfd537ffd13ce9e5a657fa5fa120a4bad6f1';    // 0xe0de…a8ec ASC / EACC / ELYCAT: one fee per pool, 1–10 % fixed at launch (code cap), no window, no lever
const R7_BOXA2 = '0x1d27e76e5d5d09ce30d09b9ee4eed615751ed29f45de3b0fe2e78aeb402a69fd';  // 0x00c0…2acc BOXA (+Ownable2Step): 1 % + creator ≤ 9 %, fixed at registration; LP locked; 60 s anti-snipe
const R7_KLEOS = '0x5953588a651a4f7832020a4cc69be9db52ad0589713358b2413ed127ad6d0459';  // 0x0fa7…2acc = Kleos 0xd506's code with its own immutables (Kleos' stack on Uniswap's PM)
const R7_BOZO = '0x5f3291975395008efee3c304ce7cfe003942e0302f8683cf668f212537722518';   // 0x050a…eaec BOZO: buy / sell bps fixed at init (≤ 1000, code cap); LP locked
// Tier 1 by code hash, per PoolManager (rel6's address pins are folded in: their hashes are reviewed code wherever they sit on that PM)
export const ELY_HOOK_CODES: Readonly<Record<string, Readonly<Record<string, string>>>> = (() => {
  const out: Record<string, Record<string, string>> = {};
  for (const [pm, hs] of Object.entries(ELY_SWAP_HOOKS)) for (const [h, pin] of Object.entries(hs)) (out[pm] ||= {})[pin] = 'rel6 ' + h;
  Object.assign(out['0xe2e105d3f7209a9da11f83ccf3e7398a753823f1'], { [R7_ASC]: 'ASC 0xe0de', [R7_BOXA2]: 'BOXA 0x00c0', [R7_KLEOS]: 'Kleos 0x0fa7', [R7_BOZO]: 'BOZO 0x050a' });
  return out;
})();
// refused whatever the lane says, by address AND by code hash: freeze levers / confiscation proven by simulation
export const ELY_REFUSED_HOOKS: Readonly<Record<string, string>> = {
  '0xf38d13c56eafa1143a6ee99a56d2f1234540eaec': 'ELYSIAN: the fee treasury admin can freeze every sell (one role revoke, simulated)',
  '0x4d5f470c2c59202f646c26e4de807ed75ecc68c0': 'its owner holds the liquidity and pulled it (APOGEE, block 404612)',
  '0x6441fabd29d541f5c74a302685ca2354703d84cc': 'an admin can set the fee to 100 % between a buy and a sell (setTotalFee, simulated: the sell pays 0)',
  '0xa129c69d439f30e6ffacc435a1627b7f4f9d30c4': 'its dynamic fee follows the flow up to 99 % (MAX_FEE 990,000 pips)',
  '0x1295bd9d641185f361016a898a61a801c0d3e044': 'its owner can make every sell revert (setRecipient to a contract that refuses HYPE, simulated)',
};
export const ELY_REFUSED_HOOK_CODES: Readonly<Record<string, string>> = {
  '0x0458549495d84b58e89640603a4137c3c90d336572aea8b4829156a7afc47957': ELY_REFUSED_HOOKS['0xf38d13c56eafa1143a6ee99a56d2f1234540eaec'],
  '0xd381bbdeeb78b26e06d9aacd8165322651364039adb946e954f7b6efc8045497': ELY_REFUSED_HOOKS['0x4d5f470c2c59202f646c26e4de807ed75ecc68c0'],
  '0xfe4a1e6e2cbffbe314fdeb28824292a83494d8c87f74c9bd91f128fbc15dc55a': ELY_REFUSED_HOOKS['0x6441fabd29d541f5c74a302685ca2354703d84cc'],
  '0xce1f76ba2c7609b7a8abd9d4b6e502e151fdee3024d2187358a22de2d9ae2311': ELY_REFUSED_HOOKS['0xa129c69d439f30e6ffacc435a1627b7f4f9d30c4'],
  '0xd350af6a60352c50a365717fa9c2cfd34e27d274a7893fa5a530d1b76f1e3047': ELY_REFUSED_HOOKS['0x1295bd9d641185f361016a898a61a801c0d3e044'],
};
const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isHash = (h: unknown): h is string => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) && !/^0x0{64}$/.test(h);
// buy-time rules by code family; the target is the hook at hand, so a fresh deployment of the same code is read at its own address
const ascRules = (h: string, poolId: Hex): ElyRule[] => [rule(h, callOf('0xcaa93ee8', poolId), ELY_RULE.LE, 0, ELY_HOOK_MAX_PIPS)];
const boxa2Rules = (h: string, token: Hex, poolId: Hex): ElyRule[] => {
  const f = callOf('0x04d4d864', poolId);
  return [rule(h, f, ELY_RULE.LE, 0, ELY_HOOK_MAX_PIPS), rule(h, f, ELY_RULE.LE, 1, ELY_HOOK_MAX_PIPS), rule(h, callOf('0xb5217bb4', poolId), ELY_RULE.AFTER, 10, 60n),
    rule(h, callOf('0x988b1fa7', token), ELY_RULE.HASH, 0, BigInt(keccak256(poolId)))];
};
const bozoRules = (h: string, poolId: Hex): ElyRule[] => {
  const d = callOf('0xb5217bb4', poolId);
  return [rule(h, d, ELY_RULE.LE, 4, ELY_HOOK_MAX_BPS), rule(h, d, ELY_RULE.LE, 5, ELY_HOOK_MAX_BPS), rule(h, d, ELY_RULE.AFTER, 3, 60n)];
};
export const ELY_HOOK_CODE_RULES: Readonly<Record<string, (hook: string, x: { token: Hex; poolId: Hex }) => ElyRule[]>> = (() => {
  const out: Record<string, (hook: string, x: { token: Hex; poolId: Hex }) => ElyRule[]> = {};
  // rel6's rules were written for one address: re-targeted at the hook at hand (same code = same selectors and word layout)
  for (const hs of Object.values(ELY_SWAP_HOOKS)) for (const [h, pin] of Object.entries(hs)) {
    const f = own(ELY_HOOK_RULES, h); if (!f) continue;
    out[pin] = (hook, x) => f(x).map((r) => (lc(r.target) === h ? { ...r, target: lc(hook) as Hex } : r));
  }
  out[R7_ASC] = (h, { poolId }) => ascRules(h, poolId);
  out[R7_BOXA2] = (h, { token, poolId }) => boxa2Rules(h, token, poolId);
  out[R7_KLEOS] = (h, { token, poolId }) => kleosRules(h, token, poolId);
  out[R7_BOZO] = (h, { poolId }) => bozoRules(h, poolId);
  return out;
})();
// the buy-time rules of the hook at hand, by its (pinned or claimed) code hash
export const elyHookCodeRules = (hooks: string, codeHash: string, token: string, poolId: Hex): ElyRule[] => {
  const f = own(ELY_HOOK_CODE_RULES, lc(codeHash));
  return f ? f(lc(hooks), { token: lc(token) as Hex, poolId }) : [];
};
// whether the vault trades behind this hook, and its tier. fee = the PoolKey's fee field (0x800000 = dynamic); claim = the lane's route.hook
export function elyHookVerdict(manager: string, hooks: string, fee: number, claim?: { codeHash?: string; tier?: string } | null): { ok: boolean; tier: ElyHookTier | 'none'; codeHash: Hex | ''; problem: string } {
  const pm = lc(manager), h = lc(hooks), no = (problem: string) => ({ ok: false, tier: 'none' as const, codeHash: '' as const, problem });
  if (h === ELY_ZERO || hookSwapFlags(h) === 0) return { ok: true, tier: 'none', codeHash: '', problem: '' };
  if (own(ELY_REFUSED_HOOKS, h)) return no('the pool sits behind a hook this vault refuses: ' + ELY_REFUSED_HOOKS[h]);
  const pinned = elyHookPin(pm, h);
  const claimed = claim && isHash(claim.codeHash) ? lc(claim.codeHash) : '';
  // a reviewed ADDRESS keeps its own pin whatever is claimed (a wrong claim cannot widen anything: the guard checks the pin)
  const codeHash = (pinned || claimed) as Hex | '';
  if (!codeHash) return no(ELY_OPEN_MANAGERS.includes(pm) ? 'the hook code of this pool has not been read yet' : 'the pool sits behind a swap hook this vault does not trust');
  if (own(ELY_REFUSED_HOOK_CODES, codeHash)) return no('the pool sits behind a hook this vault refuses: ' + ELY_REFUSED_HOOK_CODES[codeHash]);
  if (own(ELY_HOOK_CODES[pm], codeHash)) return { ok: true, tier: 'reviewed', codeHash, problem: '' };
  if (!ELY_OPEN_MANAGERS.includes(pm)) return no('the pool sits behind a swap hook this vault does not trust');
  if (fee === DYNAMIC_FEE_FLAG) return no('a dynamic fee behind a hook that is not reviewed');
  if (!(Number.isInteger(fee) && fee >= 0 && fee <= MAX_STATIC_FEE)) return no('the pool fee is above 10 %');
  return { ok: true, tier: claim?.tier === 'auto' ? 'auto' : 'unverified', codeHash, problem: '' };
}
export const ELY_UNVERIFIED_MAX_BUY = 3n * 10n ** 18n;      // 3 HYPE (≈ $250) per buy behind an 'unverified' hook
export const ELY_UNREVIEWED_ROUNDTRIP_MIN_BPS = 8000n;     // 'auto' / 'unverified': the 0.002 HYPE buy-and-sell-back returns ≥ 80 %
export const elyTierLabel = (tier?: string): string => (tier === 'reviewed' ? 'Reviewed' : tier === 'auto' ? 'Auto-checked' : tier === 'unverified' ? 'Unverified' : '');
// '' when a BUY of amountIn through this candidate may go on. rt = a measured buy-and-sell-back of this candidate (the click's own case
// in elyPick, the lane's 0.002 HYPE case on the board): what came back against what the buy spent.
export function elyTierBuyProblem(c: ElyCandidate, amountIn: bigint, rt: ElySeen | null): string {
  if (c.tier !== 'auto' && c.tier !== 'unverified') return '';
  if (c.tier === 'unverified' && amountIn > ELY_UNVERIFIED_MAX_BUY) return `this coin's hook is not reviewed (Unverified): at most ${ELY_UNVERIFIED_MAX_BUY / 10n ** 18n} HYPE per buy — buy less`;
  const spent = rt && rt.nativeSpent > 0n ? rt.nativeSpent : 0n;
  if (!rt || !rt.ran || !rt.buyOk || !rt.sellOk || !(rt.nativeBack > 0n) || !(spent > 0n)) return 'the hook of this coin is not reviewed and its sell-back could not be measured — not bought';
  if (rt.nativeBack * 10_000n < spent * ELY_UNREVIEWED_ROUNDTRIP_MIN_BPS) return `the hook of this coin is not reviewed and a buy sold straight back returns only ${(Number((rt.nativeBack * 10_000n) / spent) / 100).toFixed(1)}% (fees above the 10 % cap, or price impact) — not bought`;
  return '';
}
export const V3_FEES = [100, 500, 3000, 10000] as const;
const V4_STD = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const;

// ── the route ──
// What motion's Elysium lane answers on /elysium/api/token/<coin>/route, and the only shape this path signs. A route is a
// hint: the vault also enumerates the coin's canonical pools itself (elyCandidates) and trades the best one it measured.
export type ElyRoute = {
  type: 'ely'; chainId: number; venue: ElyVenue; pair: 'native' | 'weth';
  poolKey?: V4PoolKey;   // v4
  fee?: number;          // v3
  pool?: string;         // v3 pool address / v4 pool id (informative; the vault computes its own)
  quoteSymbol?: string;
  hook?: { codeHash?: string; tier?: string };   // release 7: the hook's runtime keccak as the lane read it (a CLAIM: ELY_GUARD checks it on chain)
};
// release 6: routerPin = the router's pinned code hash (every case goes through ELY_GUARD); rules = the hook's buy-time reads
export type ElyCandidate = { venue: ElyVenue; pair: 'native' | 'weth'; router: Hex; routerPin: Hex; poolKey?: V4PoolKey; fee?: number; pool: Hex; check: { target: Hex; data: Hex }; hinted?: boolean; pin?: { manager: Hex; slot: Hex; hook: Hex; codeHash: Hex }; rules?: ElyRule[]; tier?: ElyHookTier };

// '' when the route is one this path signs for, otherwise why not. Pure; no chain read (the probe proves the pool exists).
export function elyRouteProblem(token: string, r: unknown): string {
  const t = lc(token);
  if (!/^0x[0-9a-f]{40}$/.test(t)) return 'not a token address';
  if (t === ELY_WHYPE || t === ELY_ZERO) return 'that is the gas token';
  const route = r as Partial<ElyRoute> | null;
  if (!route || typeof route !== 'object' || route.type !== 'ely') return 'not an Elysium route';
  if (Number(route.chainId) !== ELY_CHAIN_ID) return 'the route is for another chain';
  const v = (ELY_VENUES as Record<string, (typeof ELY_VENUES)[ElyVenue]>)[String(route.venue)];
  if (!v) return 'the route names a venue this vault does not trade through on Elysium';
  if (route.pair !== 'native' && route.pair !== 'weth') return 'unknown pair';
  if (v.kind === 'v3') {
    if (route.pair !== 'weth') return 'a V3 pool is always quoted in WHYPE';
    // release 7: launchpad factories enable 2 %, 3 %, 4 %, 5 % … tiers (ILLUSIONIST 2 %, Stockium 2-5 %). A V3 pool's fee is fixed for life
    // and part of its CREATE2 address, so any integer tier <= MAX_STATIC_FEE (10 %) is a fixed, bounded fee.
    const fee = Number(route.fee);
    if (!Number.isInteger(fee) || fee <= 0 || fee > MAX_STATIC_FEE) return fee > MAX_STATIC_FEE ? 'the pool fee is above 10 %' : 'unknown V3 fee tier';
    return '';
  }
  const pk = route.poolKey;
  if (!pk || typeof pk !== 'object') return 'no pool key';
  return v4KeyProblem(t, pk, v.manager, route.pair, route.hook);
}
export function v4KeyProblem(token: string, pk: V4PoolKey, manager: string, pair: 'native' | 'weth', claim?: { codeHash?: string; tier?: string } | null): string {
  const c0 = lc(pk.currency0), c1 = lc(pk.currency1), t = lc(token);
  if (!/^0x[0-9a-f]{40}$/.test(c0) || !/^0x[0-9a-f]{40}$/.test(c1) || !/^0x[0-9a-f]{40}$/.test(lc(pk.hooks))) return 'bad pool key';
  if (!(c0 < c1)) return 'pool key currencies are not sorted';
  if (c0 !== t && c1 !== t) return 'the pool does not contain this token';
  const other = c0 === t ? c1 : c0;
  if (pair === 'native' ? other !== ELY_ZERO : other !== ELY_WHYPE) return 'the pool is not quoted in HYPE';
  const fee = Number(pk.fee), ts = Number(pk.tickSpacing);
  if (!Number.isInteger(fee) || !Number.isInteger(ts) || ts < 1 || ts > 32767) return 'bad pool key';
  const hooks = lc(pk.hooks);
  if (hooks === ELY_ZERO) return fee <= MAX_STATIC_FEE ? '' : 'the pool fee is above 10 %';
  if (hookSwapFlags(hooks) === 0) return fee === DYNAMIC_FEE_FLAG ? 'a dynamic fee behind a hook that is not reviewed' : fee <= MAX_STATIC_FEE ? '' : 'the pool fee is above 10 %';
  // release 7: reviewed by code hash, or (on a stock PoolManager, static fee ≤ 10 %) auto-checked / unverified; refused lists first
  const verdict = elyHookVerdict(manager, hooks, fee, claim);
  if (!verdict.ok) return verdict.problem;
  return fee === DYNAMIC_FEE_FLAG || fee <= MAX_STATIC_FEE ? '' : 'the pool fee is above 10 %';
}

// ── addresses the vault computes itself ──
export function v3PoolOf(factory: string, a: string, b: string, fee: number, initHash: Hex = ELY_V3_INIT_HASH): Hex {
  const [t0, t1] = lc(a) < lc(b) ? [lc(a), lc(b)] : [lc(b), lc(a)];
  const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [t0 as Hex, t1 as Hex, fee]));
  return lc(getCreate2Address({ from: factory as Hex, salt, bytecodeHash: initHash })) as Hex;
}
export const v4PoolId = (pk: V4PoolKey): Hex => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [pk.currency0, pk.currency1, Number(pk.fee), Number(pk.tickSpacing), pk.hooks]));
// PoolManager's pools mapping sits at slot 6 (StateLibrary.POOLS_SLOT): slot0 of a pool = keccak(poolId, 6); 0 = not initialised
export const v4StateSlot = (pk: V4PoolKey): Hex => keccak256(encodePacked(['bytes32', 'uint256'], [v4PoolId(pk), 6n]));
const EXTSLOAD = [{ name: 'extsload', type: 'function', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }] as const;
const SLOT0_V3 = '0x3850c7bd' as Hex;   // slot0(): sqrtPriceX96 first; no code there = no answer = no pool

// The candidates for one coin: Uniswap's and ElysPump's V3 pools at every standard tier, Uniswap's hookless V4 pools (native
// and WHYPE) at the standard fee / tick-spacing pairs, and the hinted pool when it is a valid one these did not already
// cover (a launch pool behind a trusted hook, a non-standard tier, release 6: a launchpad venue's pool). The page cannot add a pool
// the rules refuse.
export function elyCandidates(token: string, hint?: ElyRoute | null): ElyCandidate[] {
  const t = lc(token) as Hex, out: ElyCandidate[] = [];
  const v4 = (venue: ElyVenue, pk: V4PoolKey, pair: 'native' | 'weth', hinted = false, claim?: ElyRoute['hook']): ElyCandidate => {
    const v = ELY_VENUES[venue] as { manager: string; router: string }, slot = v4StateSlot(pk), id = v4PoolId(pk);
    const vd = hookSwapFlags(pk.hooks) ? elyHookVerdict(v.manager, pk.hooks, Number(pk.fee), claim) : null;
    const codeHash = vd && vd.ok ? vd.codeHash : '', rules = codeHash && vd!.tier === 'reviewed' ? elyHookCodeRules(pk.hooks, codeHash, t, id) : [];
    return { venue, pair, router: v.router as Hex, routerPin: elyRouterPin(v.router) as Hex, poolKey: pk, pool: id, check: { target: v.manager as Hex, data: encodeFunctionData({ abi: EXTSLOAD, functionName: 'extsload', args: [slot] }) }, hinted,
      ...(codeHash ? { pin: { manager: v.manager as Hex, slot, hook: lc(pk.hooks) as Hex, codeHash }, tier: vd!.tier as ElyHookTier } : {}), ...(rules.length ? { rules } : {}) };
  };
  const v3 = (venue: ElyVenue, fee: number, hinted = false): ElyCandidate => {
    const v = ELY_VENUES[venue] as { factory: string; router: string }; const pool = v3PoolOf(v.factory, t, elyWrappedOf(venue), fee, elyV3InitHashOf(venue));
    return { venue, pair: 'weth', router: v.router as Hex, routerPin: elyRouterPin(v.router) as Hex, fee, pool, check: { target: pool, data: SLOT0_V3 }, hinted };
  };
  for (const fee of V3_FEES) { out.push(v3('uni-v3', fee)); out.push(v3('ep-v3', fee)); }
  for (const [fee, ts] of V4_STD) for (const pair of ['native', 'weth'] as const) {
    const other = pair === 'native' ? ELY_ZERO : ELY_WHYPE;
    const [c0, c1] = lc(other) < t ? [other, t] : [t, other];
    out.push(v4('uni-v4', { currency0: c0 as Hex, currency1: c1 as Hex, fee, tickSpacing: ts, hooks: ELY_ZERO }, pair));
  }
  if (hint && !elyRouteProblem(t, hint)) {
    const v = ELY_VENUES[hint.venue];
    if (v.kind === 'v3') { const c = out.find((x) => x.venue === hint.venue && x.fee === Number(hint.fee)); if (c) c.hinted = true; else out.push(v3(hint.venue, Number(hint.fee), true)); }
    else {
      const pk = { currency0: lc(hint.poolKey!.currency0) as Hex, currency1: lc(hint.poolKey!.currency1) as Hex, fee: Number(hint.poolKey!.fee), tickSpacing: Number(hint.poolKey!.tickSpacing), hooks: lc(hint.poolKey!.hooks) as Hex };
      const id = v4PoolId(pk); const c = out.find((x) => x.venue === hint.venue && x.pool === id);
      if (c) c.hinted = true; else out.push(v4(hint.venue, pk, hint.pair, true, hint.hook));
    }
  }
  return out;
}

// ── calldata (Universal Router execute) ──
// Commands / actions as in evmV4Router.ts; MSG_SENDER (address 1) = the wallet that calls, ADDRESS_THIS (address 2) = the router.
const MSG_SENDER = '0x0000000000000000000000000000000000000001' as const, ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;
const CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;
type Enc = { commands: Hex; inputs: Hex[] };
const ca = (cur: string, n: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cur as Hex, n]);
// V3_SWAP_EXACT_IN on Elysium's Universal Routers (the v2.1 line, 23,233 bytes) takes a 6th field, maxHopSlippage (uint256[]; empty =
// no per-hop check): the 5-field shape of Robinhood's router reverts there with SliceOutOfBounds (0x3b99b53d) — read on chain 2026-11-03
const v3In = (recipient: string, amountIn: bigint, min: bigint, path: Hex, payerIsUser: boolean) => encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], [recipient as Hex, amountIn, min, path, payerIsUser, []]);
const POOL_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;
// Release 6 (B:	mpelysium-hooks TRUST-CHANGES §E): Elysium's Universal Routers (the v2.1 line: 0x1b34, 0x751c and the four new ones)
// decode SWAP_EXACT_IN_SINGLE's ExactInputSingleParams with a 6th field before hookData: (poolKey, zeroForOne, amountIn,
// amountOutMinimum, uint256 minHopPriceX36, bytes hookData). The 5-field shape of Robinhood's router made them read hookData's offset
// word (0x120 = 288) as minHopPriceX36: a per-hop price floor of 288 X36 by accident (tiny outputs reverted with
// V4TooLittleReceivedPerHopSingle). minHopPriceX36 = 0 (no per-hop check; the swap's own amountOutMinimum and the floors hold) and
// hookData empty. Elysium's own encoder: Robinhood's (src/evmV4Router.ts encodeV4Sell, trade core) is not touched.
const swapSingle = (pk: V4PoolKey, zeroForOne: boolean, amountIn: bigint, min: bigint) => encodeAbiParameters(
  [{ type: 'tuple', components: [{ name: 'poolKey', ...POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
  [{ poolKey: pk, zeroForOne, amountIn, amountOutMinimum: min, minHopPriceX36: 0n, hookData: '0x' }]);
const v4Actions = (actions: number[], params: Hex[]) => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
// buy: HYPE → coin, the coin straight to the wallet; the floor is on what the pool pays out.
// r8 (review r7b + the exact-amounts decision): every buy moves EXACTLY its own HYPE and nothing that sits in the router.
//   native V4:  V4_SWAP[SWAP_EXACT_IN_SINGLE(amountIn, min), SETTLE(native, amountIn, from the router = this msg.value), TAKE(coin → wallet,
//               the open delta)]. No SWEEP: the swap takes exactly amountIn or the PoolManager's delta check reverts the whole call (a
//               hook that takes less leaves a credit = CurrencyNotSettled), so none of our HYPE can stay behind and none of anyone
//               else's comes back (r2 L-T7's refund is not needed any more; the old SWEEP paid the wallet the router's whole balance).
//   WHYPE V4:   WRAP_ETH(router, amountIn), V4_SWAP[SWAP_EXACT_IN_SINGLE(amountIn, min), SETTLE(WHYPE, amountIn, router), TAKE(coin)] —
//               was SETTLE(CONTRACT_BALANCE) + a swap of the open delta: it spent ALL the router's WHYPE, strangers' leftovers too.
//   V3:         WRAP_ETH(router, amountIn), V3_SWAP_EXACT_IN(wallet, amountIn, min, WHYPE→coin, router pays) — exact-in pays exactly
//               amountIn; the old final UNWRAP_WETH(wallet, 0) unwrapped the router's whole WHYPE balance to the wallet.
const settleOf = (cur: string, n: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [cur as Hex, n, false]);
const takeOf = (cur: string, to: string) => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [cur as Hex, to as Hex, 0n]);
export function elyBuyEnc(c: ElyCandidate, token: string, amountIn: bigint, min: bigint): Enc {
  const t = lc(token);
  if (c.poolKey) {
    const pay = c.pair === 'native' ? ELY_ZERO : ELY_WHYPE;
    const v4 = v4Actions([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE, ACT.TAKE], [swapSingle(c.poolKey, lc(c.poolKey.currency0) === pay, amountIn, min), settleOf(pay, amountIn), takeOf(t, MSG_SENDER)]);
    return c.pair === 'native' ? { commands: toHex(new Uint8Array([CMD.V4_SWAP])), inputs: [v4] } : { commands: toHex(new Uint8Array([CMD.WRAP_ETH, CMD.V4_SWAP])), inputs: [ca(ADDRESS_THIS, amountIn), v4] };
  }
  const path = encodePacked(['address', 'uint24', 'address'], [elyWrappedOf(c.venue), Number(c.fee), t as Hex]);
  return { commands: toHex(new Uint8Array([CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN])), inputs: [ca(ADDRESS_THIS, amountIn), v3In(MSG_SENDER, amountIn, min, path, false)] };
}
// r8: the old plans, kept ONLY for the tests that prove the new ones move the same amounts on honest state (never signed)
export function elyBuyEncR7(c: ElyCandidate, token: string, amountIn: bigint, min: bigint): Enc {
  const withRefund = (e: Enc, native: boolean): Enc => ({ commands: (e.commands + (native ? CMD.SWEEP : CMD.UNWRAP_WETH).toString(16).padStart(2, '0')) as Hex, inputs: [...e.inputs, native ? encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [ELY_ZERO, MSG_SENDER, 0n]) : ca(MSG_SENDER, 0n)] });
  if (c.poolKey) return c.pair === 'native' ? withRefund(encodeV4BuyNative(c.poolKey, token, amountIn, min), true) : withRefund(encodeV4BuyViaWeth(c.poolKey, token, ELY_WHYPE, amountIn, min), false);
  const path = encodePacked(['address', 'uint24', 'address'], [ELY_WHYPE, Number(c.fee), lc(token) as Hex]);
  return withRefund({ commands: toHex(new Uint8Array([CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN])), inputs: [ca(ADDRESS_THIS, amountIn), v3In(MSG_SENDER, amountIn, min, path, false)] }, false);
}
// r8: a WHYPE-pool sell still ends with UNWRAP_WETH(wallet, min) — the Universal Router has no "unwrap exactly N": it unwraps its
// whole WHYPE balance. The vault therefore reads the router's WHYPE before the sell and computes the floor from ITS OWN part only
// (elySellOwnBack), and the swap step carries that floor too: a stranger's leftover can no longer raise the minimum (no revert when
// someone sweeps it first). If a leftover is there when the sell lands, the unwrap still pays it out with ours.
// sell: coin → HYPE, the coin pulled through Permit2 (exact allowance), native HYPE to the wallet; the floor is on what the
// wallet gets (V4 native: TAKE_ALL's minimum; WHYPE pools: the swap's and the unwrap's minimum)
export function elySellEnc(c: ElyCandidate, token: string, amountIn: bigint, min: bigint): Enc {
  const t = lc(token);
  if (c.poolKey) {
    // release 6: = encodeV4Sell's actions (SWAP_EXACT_IN_SINGLE, SETTLE_ALL coin, TAKE_ALL native ≥ min) with the 6-field swap
    if (c.pair === 'native') return { commands: toHex(new Uint8Array([CMD.V4_SWAP])), inputs: [v4Actions([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL], [swapSingle(c.poolKey, lc(c.poolKey.currency0) === t, amountIn, min), ca(t, amountIn), ca(ELY_ZERO, min)])] };
    const zeroForOne = lc(c.poolKey.currency0) === t;
    const v4 = v4Actions([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE], [swapSingle(c.poolKey, zeroForOne, amountIn, min), ca(t, amountIn), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [ELY_WHYPE, ADDRESS_THIS, 0n])]);
    return { commands: toHex(new Uint8Array([CMD.V4_SWAP, CMD.UNWRAP_WETH])), inputs: [v4, ca(MSG_SENDER, min)] };
  }
  const path = encodePacked(['address', 'uint24', 'address'], [t as Hex, Number(c.fee), elyWrappedOf(c.venue)]);
  return { commands: toHex(new Uint8Array([CMD.V3_SWAP_EXACT_IN, CMD.UNWRAP_WETH])), inputs: [v3In(ADDRESS_THIS, amountIn, min, path, true), ca(MSG_SENDER, min)] };
}
export const elyExecute = (e: Enc, deadline: bigint): Hex => encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [e.commands, e.inputs, deadline] });

// ── the probe (contracts/ElysiumProbe.sol; scripts/elysium-probe-build.mjs rebuilds these bytes with solc 0.8.26) ──
export const ELYSIUM_PROBE_RUNTIME: Hex = '0x60806040526004361061002d5760003560e01c8063133c1d921461003957806326fff2b81461006f57600080fd5b3661003457005b600080fd5b34801561004557600080fd5b50610059610054366004610efe565b610091565b6040516100669190611084565b60405180910390f35b34801561007b57600080fd5b5061008f61008a3660046110e9565b61025b565b005b6060816001600160401b038111156100ab576100ab611124565b6040519080825280602002602001820160405280156100e457816020015b6100d1610e8e565b8152602001906001900390816100c95790505b50905060005b8281101561025457600030806326fff2b887878681811061010d5761010d61113a565b905060200281019061011f9190611150565b60405160240161012f9190611288565b60408051601f198184030181529181526020820180516001600160e01b031660e09490941b93909317909252905161016792506113f2565b6000604051808303816000865af19150503d80600081146101a4576040519150601f19603f3d011682016040523d82523d6000602084013e6101a9565b606091505b509150506101a48151101580156101d75750623f0faf60e91b6101cb82611404565b6001600160e01b031916145b1561021f578051600319810160048301908152916101fd918101602001906024016114fc565b83838151811061020f5761020f61113a565b602002602001018190525061024b565b6102288161070c565b83838151811061023a5761023a61113a565b602002602001015161018001819052505b506001016100ea565b5092915050565b33301461026757600080fd5b61026f610e8e565b600061028160a0840160808501611607565b6001600160a01b031614610346576000806102a260a0850160808601611607565b6001600160a01b03166102b860a0860186611624565b6040516102c692919061166a565b600060405180830381855afa9150503d8060008114610301576040519150601f19603f3d011682016040523d82523d6000602084013e610306565b606091505b5091509150811580610319575060208151105b80610335575080806020019051810190610333919061167a565b155b15610343576103438361079b565b50505b6001815260006103596020840184611607565b6001600160a01b0316319050600061038c61037a6060860160408701611607565b6103876020870187611607565b6107ed565b905060006103b06103a36040870160208801611607565b6103876020880188611607565b905061014085013560c0860135156104f05760006103dd6103d76040890160208a01611607565b306107ed565b90504760005a90506000806103f560208c018c611607565b6001600160a01b031660c08c013561041060e08e018e611624565b60405161041e92919061166a565b60006040518083038185875af1925050503d806000811461045b576040519150601f19603f3d011682016040523d82523d6000602084013e610460565b606091505b50915091505a61047090846116a9565b60808b0152816104a6576104838161070c565b6101808b01526104958b8a8a8a6108d1565b15156101608b01526104a68a61079b565b60016020808c01919091526104cf906104c9906103d79060408f01908f01611607565b8661093a565b60408b01526104de844761093a565b60608b01525050506040870151925050505b60008087610160013511801561050d575061271087610160013511155b610518576000610534565b61271061052a610160890135846116bc565b61053491906116d3565b905080156106a857604080513060208201528082019190915260146060820152736d6f74696f6e2d656c797369756d2d70726f626560601b608082015260009060a0016040516020818303038152906040528051906020012060001c905060006105b08960200160208101906105aa9190611607565b836107ed565b905060006105c460408b0160208c01611607565b6040516001600160a01b03858116602483015260448201879052919091169060640160408051601f198184030181529181526020820180516001600160e01b031663a9059cbb60e01b1790525161061b91906113f2565b6000604051808303816000865af19150503d8060008114610658576040519150601f19603f3d011682016040523d82523d6000602084013e61065d565b606091505b50506101208a01859052905080156106a45761069161068b61068560408d0160208e01611607565b856107ed565b8361093a565b6101408a01526106a184866116a9565b94505b5050505b60006106b8610100890189611624565b90501180156106c75750600082115b80156106d65750600160a01b82105b156106e6576106e687838861095b565b6106f2878686866108d1565b15156101608701526107038661079b565b50505050505050565b606061010082511161071c575090565b60408051610100808252610120820190925260009160208201818036833701905050905060005b6101008110156102545783818151811061075f5761075f61113a565b602001015160f81c60f81b82828151811061077c5761077c61113a565b60200101906001600160f81b031916908160001a905350600101610743565b6000637e1f5e0060e01b826040516020016107b691906116f5565b60408051601f19818403018152908290526107d49291602001611708565b6040516020818303038152906040529050805160208201fd5b60006001600160a01b038316610805575060006108cb565b6040516001600160a01b038381166024830152600091829186169060440160408051601f198184030181529181526020820180516001600160e01b03166370a0823160e01b1790525161085891906113f2565b600060405180830381855afa9150503d8060008114610893576040519150601f19603f3d011682016040523d82523d6000602084013e610898565b606091505b50915091508180156108ac57506020815110155b156108c857808060200190518101906108c5919061167a565b92505b50505b92915050565b6000836108e16020870187611607565b6001600160a01b03163111806109155750826109136109066060880160408901611607565b6103876020890189611607565b115b8061093157508161092f6109066040880160208901611607565b115b95945050505050565b600081831161094a576000610954565b61095482846116a9565b9392505050565b600061096b610100850185611624565b8080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201829052509394505050505b6109b0610120860186611739565b9050811015610a0c5760006109c9610120870187611739565b838181106109d9576109d961113a565b90506020020135905082518160206109f19190611782565b11156109fc57600080fd5b82016020018490526001016109a2565b50610a178484610b0f565b6000610a2c6103d76040870160208801611607565b90504760005a9050600080610a4460208a018a611607565b6001600160a01b031686604051610a5b91906113f2565b6000604051808303816000865af19150503d8060008114610a98576040519150601f19603f3d011682016040523d82523d6000602084013e610a9d565b606091505b50915091505a610aad90846116a9565b61010088015281610acc57610ac18161070c565b610180880152610b04565b600160a0880152610aef85610aea6103d760408d0160208e01611607565b61093a565b60c0880152610afe478561093a565b60e08801525b505050505050505050565b6000610b39610b246040850160208601611607565b610b346080860160608701611607565b610dce565b905081811015610bfe578015610bb957610bb9610b5c6040850160208601611607565b610b6c6080860160608701611607565b6040516001600160a01b039091166024820152600060448201526064015b60408051601f198184030181529190526020810180516001600160e01b031663095ea7b360e01b179052610e2a565b610bfe610bcc6040850160208601611607565b610bdc6080860160608701611607565b6040516001600160a01b03909116602482015260448101859052606401610b8a565b600080610c116080860160608701611607565b6001600160a01b031630610c2b6040880160208901611607565b610c386020890189611607565b6040516001600160a01b0393841660248201529183166044830152909116606482015260840160408051601f198184030181529181526020820180516001600160e01b031663927da10560e01b17905251610c9391906113f2565b600060405180830381855afa9150503d8060008114610cce576040519150601f19603f3d011682016040523d82523d6000602084013e610cd3565b606091505b5091509150600080838015610cea57506060835110155b15610d0a5782806020019051810190610d0391906117ab565b5090925090505b85826001600160a01b03161080610d295750428165ffffffffffff1611155b1561070357610703610d416080890160608a01611607565b610d5160408a0160208b01611607565b610d5e60208b018b611607565b89610d6b42610384611782565b6040516001600160a01b03948516602482015292841660448401529216606482015265ffffffffffff909116608482015260a40160408051601f198184030181529190526020810180516001600160e01b03166387517c4560e01b179052610e2a565b6040513060248201526001600160a01b038281166044830152600091829182919086169060640160408051601f198184030181529181526020820180516001600160e01b0316636eb1769f60e11b1790525161085891906113f2565b6000826001600160a01b031682604051610e4491906113f2565b6000604051808303816000865af19150503d8060008114610e81576040519150601f19603f3d011682016040523d82523d6000602084013e610e86565b606091505b505050505050565b604051806101a001604052806000151581526020016000151581526020016000815260200160008152602001600081526020016000151581526020016000815260200160008152602001600081526020016000815260200160008152602001600015158152602001606081525090565b60008060208385031215610f1157600080fd5b82356001600160401b03811115610f2757600080fd5b8301601f81018513610f3857600080fd5b80356001600160401b03811115610f4e57600080fd5b8560208260051b8401011115610f6357600080fd5b6020919091019590945092505050565b60005b83811015610f8e578181015183820152602001610f76565b50506000910152565b60008151808452610faf816020860160208601610f73565b601f01601f19169290920160200192915050565b80511515825260006020820151610fde602085018215159052565b5060408201516040840152606082015160608401526080820151608084015260a082015161101060a085018215159052565b5060c082015160c084015260e082015160e084015261010082015161010084015261012082015161012084015261014082015161014084015261016082015161105e61016085018215159052565b506101808201516101a061018085015261107c6101a0850182610f97565b949350505050565b6000602082016020835280845180835260408501915060408160051b86010192506020860160005b828110156110dd57603f198786030184526110c8858351610fc3565b945060209384019391909101906001016110ac565b50929695505050505050565b6000602082840312156110fb57600080fd5b81356001600160401b0381111561111157600080fd5b8201610180818503121561095457600080fd5b634e487b7160e01b600052604160045260246000fd5b634e487b7160e01b600052603260045260246000fd5b6000823561017e1983360301811261116757600080fd5b9190910192915050565b6001600160a01b038116811461118657600080fd5b50565b803561119481611171565b919050565b6000808335601e198436030181126111b057600080fd5b83016020810192503590506001600160401b038111156111cf57600080fd5b8036038213156111de57600080fd5b9250929050565b81835281816020850137506000828201602090810191909152601f909101601f19169091010190565b6000808335601e1984360301811261122557600080fd5b83016020810192503590506001600160401b0381111561124457600080fd5b8060051b36038213156111de57600080fd5b81835260006001600160fb1b0383111561126f57600080fd5b8260051b80836020870137939093016020019392505050565b602081526112a96020820161129c84611189565b6001600160a01b03169052565b60006112b760208401611189565b6001600160a01b0381166040840152506112d360408401611189565b6001600160a01b0381166060840152506112ef60608401611189565b6001600160a01b03811660808401525061130b60808401611189565b6001600160a01b03811660a08401525061132860a0840184611199565b61018060c085015261133f6101a0850182846111e5565b915050600060c085013590508060e08501525061135f60e0850185611199565b848303601f19016101008601526113778382846111e5565b92505050611389610100850185611199565b848303601f19016101208601526113a18382846111e5565b925050506113b361012085018561120e565b848303601f19016101408601526113cb838284611256565b61014087013561016087810191909152909601356101809095019490945250929392505050565b60008251611167818460208701610f73565b805160208201516001600160e01b031981169190600482101561143b576001600160e01b0319600483900360031b81901b82161692505b5050919050565b6040516101a081016001600160401b038111828210171561146557611465611124565b60405290565b8051801515811461119457600080fd5b600082601f83011261148c57600080fd5b81516001600160401b038111156114a5576114a5611124565b604051601f8201601f19908116603f011681016001600160401b03811182821017156114d3576114d3611124565b6040528181528382016020018510156114eb57600080fd5b61107c826020830160208701610f73565b60006020828403121561150e57600080fd5b81516001600160401b0381111561152457600080fd5b82016101a0818503121561153757600080fd5b61153f611442565b6115488261146b565b81526115566020830161146b565b602082015260408281015190820152606080830151908201526080808301519082015261158560a0830161146b565b60a082015260c0828101519082015260e080830151908201526101008083015190820152610120808301519082015261014080830151908201526115cc610160830161146b565b6101608201526101808201516001600160401b038111156115ec57600080fd5b6115f88682850161147b565b61018083015250949350505050565b60006020828403121561161957600080fd5b813561095481611171565b6000808335601e1984360301811261163b57600080fd5b8301803591506001600160401b0382111561165557600080fd5b6020019150368190038213156111de57600080fd5b8183823760009101908152919050565b60006020828403121561168c57600080fd5b5051919050565b634e487b7160e01b600052601160045260246000fd5b818103818111156108cb576108cb611693565b80820281158282048414176108cb576108cb611693565b6000826116f057634e487b7160e01b600052601260045260246000fd5b500490565b6020815260006109546020830184610fc3565b6001600160e01b031983168152815160009061172b816004850160208701610f73565b919091016004019392505050565b6000808335601e1984360301811261175057600080fd5b8301803591506001600160401b0382111561176a57600080fd5b6020019150600581901b36038213156111de57600080fd5b808201808211156108cb576108cb611693565b805165ffffffffffff8116811461119457600080fd5b6000806000606084860312156117c057600080fd5b83516117cb81611171565b92506117d960208501611795565b91506117e760408501611795565b9050925092509256';
export const ELY_PROBE_ABI = [{ name: 'run', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'cs', type: 'tuple[]', components: [
  { name: 'router', type: 'address' }, { name: 'coin', type: 'address' }, { name: 'wrapped', type: 'address' }, { name: 'permit2', type: 'address' },
  { name: 'check', type: 'address' }, { name: 'checkData', type: 'bytes' }, { name: 'buyValue', type: 'uint256' }, { name: 'buyData', type: 'bytes' },
  { name: 'sellData', type: 'bytes' }, { name: 'sellAt', type: 'uint256[]' }, { name: 'sellAmount', type: 'uint256' }, { name: 'transferBps', type: 'uint256' }] }],
  outputs: [{ name: 'out', type: 'tuple[]', components: [
    { name: 'ran', type: 'bool' }, { name: 'buyOk', type: 'bool' }, { name: 'coinGot', type: 'uint256' }, { name: 'nativeSpent', type: 'uint256' }, { name: 'buyGas', type: 'uint256' },
    { name: 'sellOk', type: 'bool' }, { name: 'coinSold', type: 'uint256' }, { name: 'nativeBack', type: 'uint256' }, { name: 'sellGas', type: 'uint256' },
    { name: 'taxSent', type: 'uint256' }, { name: 'taxGot', type: 'uint256' }, { name: 'routerKept', type: 'bool' }, { name: 'err', type: 'bytes' }] }] }] as const;
export type ElySeen = { tierProblem?: string; ran: boolean; buyOk: boolean; coinGot: bigint; nativeSpent: bigint; buyGas: bigint; sellOk: boolean; coinSold: bigint; nativeBack: bigint; sellGas: bigint; taxSent: bigint; taxGot: bigint; routerKept: boolean; err: Hex };
// the 32-byte amount word(s) of a sell's calldata: encoded once with a marker amount, the marker found again
const MARK = 0x7e1f5e00a11ce5e11ab1e0000000c0den;
export function sellTemplate(c: ElyCandidate, token: string, deadline: bigint): { data: Hex; at: bigint[] } {
  const data = elyExecute(elySellEnc(c, token, MARK, 0n), deadline);
  const word = MARK.toString(16).padStart(64, '0'), hex = data.slice(2), at: bigint[] = [];
  for (let i = hex.indexOf(word); i >= 0; i = hex.indexOf(word, i + 2)) if (i % 2 === 0) at.push(BigInt(i / 2));
  return { data, at };
}
export type ElyProbeCase = { router: Hex; coin: Hex; wrapped: Hex; permit2: Hex; check: Hex; checkData: Hex; buyValue: bigint; buyData: Hex; sellData: Hex; sellAt: bigint[]; sellAmount: bigint; transferBps: bigint };
// a buy case (with the round trip back) or a sell case (sellAmount the wallet holds), for one candidate
export function probeCase(c: ElyCandidate, token: string, o: { buy?: bigint; sell?: bigint; roundTrip?: boolean; transferBps?: bigint; deadline: bigint }): ElyProbeCase {
  const t = lc(token) as Hex;
  const tpl = o.roundTrip || o.sell ? sellTemplate(c, t, o.deadline) : { data: '0x' as Hex, at: [] };
  return {
    router: c.router, coin: t, wrapped: elyWrappedOf(c.venue), permit2: ELY_PERMIT2, ...elyProbeCheck(c, o.buy ? 'buy' : 'sell'),
    buyValue: o.buy ?? 0n, buyData: o.buy ? elyExecute(elyBuyEnc(c, t, o.buy, 0n), o.deadline) : '0x',
    sellData: tpl.data, sellAt: tpl.at, sellAmount: o.sell ?? 0n, transferBps: o.transferBps ?? 0n,
  };
}
// Stage 3: the probe's existence check of a pool behind a trusted swap hook goes through ELY_HOOK_GUARD, a 50-byte contract that sits
// at a fixed empty address for the probe call only (state override, like the probe itself; nothing deployed). Called with
// (manager, slot, hook, codeHash) it answers PoolManager.extsload(slot) — the pool's slot0, 0 = no pool — ONLY when EXTCODEHASH(hook)
// equals the pinned hash, and nothing otherwise (the probe then treats the case as "no pool": never picked, never signed).
//   0x00 PUSH1 0x40 CALLDATALOAD EXTCODEHASH PUSH1 0x60 CALLDATALOAD EQ PUSH1 0x0c JUMPI STOP
//   0x0c JUMPDEST mstore(0, extsload selector 0x1e2eaeaf << 224) mstore(4, slot) STATICCALL(gas, manager, 0, 0x24, 0x40, 0x20)
//        PUSH1 0x2c JUMPI STOP · 0x2c JUMPDEST RETURN(0x40, 0x20)   (the answer lands in untouched zero memory: an empty answer = 0)
export const ELY_HOOK_GUARD = '0x00000000000000000000000000000000e1e06a7d' as const;
export const ELY_HOOK_GUARD_CODE: Hex = '0x6040353f60603514600c57005b631e2eaeaf60e01b5f526020356004526020604060245f5f355afa602c57005b60206040f3';
// (stage 3's 50-byte guard above: superseded in release 6 by ELY_GUARD, which does its job and more; kept for the record and its tests)
// Release 6: EVERY case's existence check goes through ELY_GUARD (contracts/ElysiumGuard.sol, solc 0.8.26, 1,846 bytes; rebuilt by
// scripts/elysium-probe-build.mjs --check), at a fixed empty address for the probe call only (state override; nothing deployed).
// check(router, routerPin, hook, hookPin, target, data, rules) answers target's state word (V3 slot0 / V4 extsload of the pool's
// slot0; 0 = no pool) ONLY when the router's EXTCODEHASH is its pin (a router not deployed yet, or with other code = no pool), a hooked
// pool's hook has its pinned code, and — for a BUY — every rule of the hook holds (ELY_HOOK_RULES: tax ≤ 10 % each side, the hook's
// record of the pool, no launch / anti-snipe window). Otherwise 0 (or a revert): never picked, never signed.
export const ELY_GUARD = '0x00000000000000000000000000000000e1e06a7e' as const;
export const ELY_GUARD_CODE: Hex = '0x608060405234801561001057600080fd5b506004361061002b5760003560e01c8063b6f969e114610030575b600080fd5b61004361003e3660046104f3565b610055565b60405190815260200160405180910390f35b600088158061006e5750888a6001600160a01b03163f14155b1561007b57506000610199565b6001600160a01b038816158015906100a557508615806100a5575086886001600160a01b03163f14155b156100b257506000610199565b60005b828110156100ff576100e98484838181106100d2576100d26105e1565b90506020028101906100e491906105f7565b6101a6565b6100f7576000915050610199565b6001016100b5565b50600080876001600160a01b0316878760405161011d929190610617565b600060405180830381855afa9150503d8060008114610158576040519150601f19603f3d011682016040523d82523d6000602084013e61015d565b606091505b5091509150811580610170575060208151105b1561018057600092505050610199565b808060200190518101906101949190610627565b925050505b9998505050505050505050565b600080806101b76020850185610640565b6001600160a01b03166101cd6020860186610662565b6040516101db929190610617565b600060405180830381855afa9150503d8060008114610216576040519150601f19603f3d011682016040523d82523d6000602084013e61021b565b606091505b50915091508161022f575060009392505050565b600261024160608601604087016106a9565b60ff160361026157805160209091012060c0909301359290921492915050565b600161027360608601604087016106a9565b60ff16036102e65761028b60808501606086016106cc565b61029a9061ffff166001610706565b6102a590602061071f565b8151101580156102de575060c08401356102db826102c960808801606089016106cc565b61ffff16602090810291909101015190565b11155b949350505050565b60036102f860608601604087016106a9565b60ff16036103595761031060808501606086016106cc565b61031f9061ffff166001610706565b61032a90602061071f565b8151101580156102de57504260c085013561034f836102c96080890160608a016106cc565b6102db9190610706565b600461036b60608601604087016106a9565b60ff16036104455760006103ad61038860808701606088016106cc565b61039860a08801608089016106cc565b6103a860c0890160a08a016106cc565b61044f565b6103bc9061ffff166001610706565b6103c790602061071f565b905080825110156103dd57506000949350505050565b426103f2836102c960a0890160808a016106cc565b610406846102c960808a0160608b016106cc565b6104109190610706565b1161042057506001949350505050565b60c0850180359061043a9084906102c99060a08a016106cc565b111595945050505050565b5060009392505050565b6000808361ffff168561ffff16116104675783610469565b845b90508261ffff168161ffff16116104805782610482565b805b95945050505050565b80356001600160a01b03811681146104a257600080fd5b919050565b60008083601f8401126104b957600080fd5b50813567ffffffffffffffff8111156104d157600080fd5b6020830191508360208260051b85010111156104ec57600080fd5b9250929050565b600080600080600080600080600060e08a8c03121561051157600080fd5b61051a8a61048b565b985060208a0135975061052f60408b0161048b565b965060608a0135955061054460808b0161048b565b945060a08a013567ffffffffffffffff81111561056057600080fd5b8a01601f81018c1361057157600080fd5b803567ffffffffffffffff81111561058857600080fd5b8c602082840101111561059a57600080fd5b6020919091019450925060c08a013567ffffffffffffffff8111156105be57600080fd5b6105ca8c828d016104a7565b915080935050809150509295985092959850929598565b634e487b7160e01b600052603260045260246000fd5b6000823560de1983360301811261060d57600080fd5b9190910192915050565b8183823760009101908152919050565b60006020828403121561063957600080fd5b5051919050565b60006020828403121561065257600080fd5b61065b8261048b565b9392505050565b6000808335601e1984360301811261067957600080fd5b83018035915067ffffffffffffffff82111561069457600080fd5b6020019150368190038213156104ec57600080fd5b6000602082840312156106bb57600080fd5b813560ff8116811461065b57600080fd5b6000602082840312156106de57600080fd5b813561ffff8116811461065b57600080fd5b634e487b7160e01b600052601160045260246000fd5b80820180821115610719576107196106f0565b92915050565b8082028115828204841417610719576107196106f056';
const GUARD_ABI = [{ name: 'check', type: 'function', stateMutability: 'view', inputs: [
  { name: 'router', type: 'address' }, { name: 'routerHash', type: 'bytes32' }, { name: 'hook', type: 'address' }, { name: 'hookHash', type: 'bytes32' },
  { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
  { name: 'rules', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'op', type: 'uint8' }, { name: 'i', type: 'uint16' }, { name: 'j', type: 'uint16' }, { name: 'k', type: 'uint16' }, { name: 'value', type: 'uint256' }] }],
  outputs: [{ type: 'uint256' }] }] as const;
const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;
export function elyProbeCheck(c: ElyCandidate, side: 'buy' | 'sell' = 'buy'): { check: Hex; checkData: Hex } {
  const hook = c.pin ? c.pin.hook : ELY_ZERO, hookHash = c.pin ? c.pin.codeHash : ZERO32;
  const rules = side === 'buy' && c.rules ? c.rules : [];
  return { check: ELY_GUARD, checkData: encodeFunctionData({ abi: GUARD_ABI, functionName: 'check', args: [c.router, (c.routerPin || ZERO32) as Hex, hook as Hex, hookHash, c.check.target, c.check.data, rules.map((r) => ({ ...r }))] }) };
}
// the state the probe call runs on: the probe's code at the wallet's own address (with the balance it needs) and the guard
export const elyProbeState = (from: string, balance: bigint): Record<string, { code: Hex; balance?: Hex }> => ({
  [from]: { code: ELYSIUM_PROBE_RUNTIME, balance: ('0x' + balance.toString(16)) as Hex },
  [ELY_GUARD]: { code: ELY_GUARD_CODE },
});
export const probeData = (cases: ElyProbeCase[]): Hex => encodeFunctionData({ abi: ELY_PROBE_ABI, functionName: 'run', args: [cases as never] });
// Release 7.1 (live 2026-11-04: BOXA's node answers HTTP 413 "Request exceeds 256 KiB"; a 17-pool buy probe is 267-293 KB of JSON):
// the cases go out in as few eth_calls as keep each call's calldata under ELY_PROBE_MAX_DATA bytes (hex: 2 characters a byte, plus the
// state override and the JSON around it, well under 256 KiB). The same cases in the same order: the answers are joined back in order.
export const ELY_PROBE_MAX_DATA = 90_000;   // bytes of calldata per call (≈ 180 KB of hex)
export function elyProbeChunks(cases: ElyProbeCase[], maxData = ELY_PROBE_MAX_DATA): ElyProbeCase[][] {
  const out: ElyProbeCase[][] = []; let cur: ElyProbeCase[] = [], size = 0;
  for (const c of cases) {
    const n = (probeData([c]).length - 2) / 2;   // one case's own encoding (the shared head is counted in each: a safe overestimate)
    if (cur.length && size + n > maxData) { out.push(cur); cur = []; size = 0; }
    cur.push(c); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
export const probeDecode = (ret: Hex): ElySeen[] => decodeFunctionResult({ abi: ELY_PROBE_ABI, functionName: 'run', data: ret }) as unknown as ElySeen[];

// ── the decisions ──
export const ELY_HINT_TOLERANCE_BPS = 200n;       // the route's own pool stands within 2 % of the best measured one (as VA-1)
export const ELY_IMPACT_MAX_BPS = 3000n;          // a BUY that loses ≥ 30 % to price impact is refused (owner rule, impact guard); sells never
export const ELY_ROUNDTRIP_MAX_BPS = 3000n;       // a buy whose own sell-back would return < 70 % of it is refused (tax / hook / honeypot)
export const ELY_TAX_MAX_BPS = 1000n;             // a coin that keeps > 10 % of a plain transfer (or refuses it) is refused
export const ELY_TAX_TEST_BPS = 100n;             // r2: the buy case sends 1 % of what it bought to a fresh address (the tax test runs)
export const ELY_REF_DIVISOR = 50n;               // the impact reference: 1/50 of the buy (at least ELY_REF_MIN)
export const ELY_REF_MIN = 10n ** 14n;            // 0.0001 HYPE
// r4: the probe's gas limit. BOXA's node refuses any call above 30 M ("Invalid RPC quantity"); a 17-pool buy probe uses ~2.6 M
// (eth_estimateGas on Kleos' node, 4 Nov), so 30 M leaves >10× headroom and every node of the pool can serve it
export const ELY_PROBE_GAS = 30_000_000n;
export const ELY_DEADLINE_S = 300;                // a signed Elysium trade is valid for 5 minutes (as every EVM path of this engine)
// (release 9, owner in chat 2026-11-05: «Да, фикс Permit2») a live sell (block 829998, EINU) reverted AllowanceExpired: the router's
// Permit2 allowance was set 15 min before, the refresh rule was "expires within 30 s of the read's block time", and Elysium includes
// a transaction 10-20 s (more under load) after it is sent, with block timestamps copied from HyperEVM, so it landed 19 s late.
// Now: the allowance lives 30 minutes, it is renewed whenever it expires within 10 minutes, and both are measured against the
// later of the node's block time and this device's own clock (a lagging node never makes an allowance look younger than it is).
export const ELY_PERMIT_S = 1800;                 // Permit2's allowance to the router lives 30 minutes
export const ELY_PERMIT_REFRESH_S = 600;          // …and is renewed when it expires within 10 minutes (an inclusion takes ≤ ~1 min)
/** The time a Permit2 expiry is measured from: the later of the chain's block time `now` and the wall clock (seconds). */
export const elyPermitNow = (now: number, wall: number = Math.floor(Date.now() / 1000)): number => (wall > now ? wall : now);
/** The expiry a new Permit2 allowance is given. */
export const elyPermitExpiry = (now: number, wall?: number): number => elyPermitNow(now, wall) + ELY_PERMIT_S;
export const ELY_MAX_GAS_PRICE = 5_000_000_000n;  // 5 gwei: 50× the chain's 0.1 gwei floor (feeFloor refuses above)
export const ELY_MAX_FEE_WEI = 50_000_000_000_000_000n;   // 0.05 HYPE for one transaction at most

// r2 (review M-T4): Elysium's DEFAULT slippage is 5 %, not the engine's 12 %. It applies when the user never set one (Settings
// stores no slippage). A slippage the user chose is respected, and the vault's own dialog still guards anything above 15 %. The data
// is in simslippage-data.json: price moves on the busiest HYPE pools come in bursts (a swap right behind another). Out of a burst
// the price stands still for seconds, so 5 % fills normal clicks; inside a burst a trade past 5 % reverts and costs gas only.
// With no public mempool a click is not seen before it lands, but at 12 % a node or an inbox watcher could take up to 12 %.
export const ELY_SLIPPAGE_DEFAULT_BPS = 500n;
export const elySlippageBps = (userPct: number, explicit: boolean): bigint => {
  if (!explicit) return ELY_SLIPPAGE_DEFAULT_BPS;
  const u = BigInt(Math.round(Math.min(100, Math.max(0, Number(userPct) || 0)) * 100));
  return u > 0n ? u : ELY_SLIPPAGE_DEFAULT_BPS;
};

// r2 (review M-T3), r3 (re-review N1 / N4 / N6): the vault's own figure against motion's lane, which measured the SAME pool at the
// SAME fixed size through ANOTHER trusted node (server/elysium-trade.mjs measureChecks, /elysium/api/token/<coin>/check): buy
// ELY_LANE_REF_IN (0.002 HYPE) and sell it straight back. The vault's probe runs exactly that case on every candidate, so both
// sides compare one pool at one size — never a position's own price impact.
//   BUY : fail closed — refused when there is no reading for the pool the vault picked, when the reading is not independent (it
//         came from the vault's own node: N4), older than ELY_LANE_MAX_AGE_MS by the SERVER's own count (ageMs: no device clock),
//         unreadable, or when the vault's coin out is worse by more than max(slippage, ELY_LANE_BOUND_BPS).
//   SELL: a holder must always be able to exit (owner, 2026-11-02). Refused ONLY when a fresh, independent reading for the very pool
//         being sold into exists AND the vault's HYPE back at that size is worse by more than the bound. Missing / stale / busy /
//         not independent / another pool → the sell goes (its floor is the vault's own simulation, as on every other chain).
export const ELY_LANE_REF_IN = 2_000_000_000_000_000n;   // 0.002 HYPE: the fixed size both sides measure
export const ELY_LANE_BOUND_BPS = 1000n;
export const ELY_LANE_MAX_AGE_MS = 60_000;
// r4 (merged review M1): a SELL is judged only by a reading at most ELY_LANE_SELL_MAX_AGE_MS old (the server's count). In a dump every
// older reading is "better" than now. When a fresh reading still disagrees, the vault ASKS (both figures, "sell anyway"); it never
// refuses a sell on its own, so no single provider can block an exit.
export const ELY_LANE_SELL_MAX_AGE_MS = 5_000;
export type ElyLaneCheck = { pool: string; buyIn: string; buyOut: string; sellIn: string; sellOut: string };
// r5 (review B7 / R3): `sized` = the same pools measured at the CLICK's own size by the other operator (buy: coin out for the HYPE in;
// sell: HYPE back for the coins in, run as the selling wallet); `mayBuy` = whether motion opens buys to this session at all (preview).
export type ElyLaneSized = { pool: string; side: 'buy' | 'sell'; size: string; out: string };
export type ElyLaneReading = { checks: ElyLaneCheck[]; ageMs: number; independent: boolean; sized?: ElyLaneSized[]; mayBuy?: boolean; ops?: string[] } | null;
// the other operator's output for this pool at exactly this size, or null (missing, not independent, stale, unreadable, another size)
export function elyLaneSizedOut(r: ElyLaneReading, pool: string, side: 'buy' | 'sell', size: bigint): bigint | null {
  if (!r || r.independent !== true || !(Number(r.ageMs) >= 0) || Number(r.ageMs) > ELY_LANE_MAX_AGE_MS || !Array.isArray(r.sized)) return null;
  const x = r.sized.find((e) => lc(e?.pool) === lc(pool) && e.side === side && String(e.size) === size.toString());
  if (!x) return null;
  try { const v = BigInt(x.out); return v > 0n ? v : null; } catch { return null; }
}
// r5 (B7): the floor from the MORE conservative of the two readings at the click's own size. A node that under-reports the real
// size to widen the floor is overruled by the other operator. Buy: the higher floor (a wrong high reading can only make the buy
// revert: gas). r6 (review Q2): a SELL's floor is never raised — it stays own quote × (1 − slippage), so no second reading can take
// an exit's slippage room away; a sized reading that beats our own quote by more than the bound is a QUESTION instead (elySizedSellGap).
export function elySizedFloor(side: 'buy' | 'sell', ownOut: bigint, laneOut: bigint | null, slippageBps: bigint): bigint {
  const own = elyFloor(ownOut, slippageBps);
  if (side === 'sell' || !laneOut || !(laneOut > 0n)) return own;
  const lane = elyFloor(laneOut, slippageBps);
  return lane > own ? lane : own;
}
// r6 (Q2): a sell whose own HYPE back at its real size is worse than the other operator's reading of this very sell by more than the
// bound → the gap ("12.5%") to show the user; '' = no question
export function elySizedSellGap(ownOut: bigint, laneOut: bigint | null, slippageBps: bigint): string {
  if (!laneOut || !(ownOut > 0n)) return '';
  const bound = slippageBps > ELY_LANE_BOUND_BPS ? slippageBps : ELY_LANE_BOUND_BPS;
  if (ownOut * 10_000n < laneOut * (10_000n - bound)) return `${Number(((laneOut - ownOut) * 10_000n) / laneOut) / 100}%`;
  return '';
}
// r8 (review Y1): the sell-priority ticket the vault signs with a wallet's key (EIP-191 personal message). It names its purpose,
// the lane origin, the wallet, an expiry and a one-time nonce; a personal message can be neither a transaction nor an EIP-712 permit,
// and this text is not a sign-in message either. The relay (server/elysium-relay.mjs) rebuilds exactly this text to verify it.
export const ELY_TICKET_PURPOSE = 'elysium-sell-share';
export const elyTicketText = (o: { origin: string; wallet: string; exp: number; nonce: string }): string =>
  `motion · Elysium sell priority — not a transaction, not a permit\npurpose: ${ELY_TICKET_PURPOSE}\norigin: ${o.origin}\nwallet: ${lc(o.wallet)}\nexpires: ${o.exp}\nnonce: ${o.nonce}`;
// r8: a WHYPE-pool sell's own HYPE back = the probe's figure less the WHYPE already in that router (it would be unwrapped with ours);
// null = the leftover is as large as the sell itself (refused)
export function elySellOwnBack(nativeBack: bigint, pair: 'native' | 'weth' | undefined, routerWhype: bigint): bigint | null {
  if (pair === 'native' || !(routerWhype > 0n)) return nativeBack;
  return nativeBack > routerWhype ? nativeBack - routerWhype : null;
}
// r7 (review X4): the floor of an UNATTENDED sell (auto-sell) whose readings disagree. With a third operator's reading of the same sell:
// the median of the three × (1 − slippage) — one lying node, the vault's own included, cannot move it. Without one: the higher of
// own × (1 − s) and the other reading × (1 − 2 · max(s, 10 %)) — a lying vault node can take at most ~20 % + s, and a lying high
// second reading must exceed ~19 % to make the sell revert (gas only; the auto-sell tries again on its next tick and says so).
export function elyAutosellFloor(ownOut: bigint, second: bigint | null, third: bigint | null, slippageBps: bigint): bigint {
  const own = elyFloor(ownOut, slippageBps);
  const a = second != null && second > 0n ? second : third != null && third > 0n ? third : null;
  const b = a === second ? (third != null && third > 0n ? third : null) : null;
  if (a == null) return own;
  if (b != null) { const m = [ownOut, a, b].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[1]; return elyFloor(m, slippageBps); }
  const wide = 2n * (slippageBps > ELY_LANE_BOUND_BPS ? slippageBps : ELY_LANE_BOUND_BPS);
  const bounded = (a * (10_000n - (wide < 10_000n ? wide : 10_000n))) / 10_000n;
  return bounded > own ? bounded : own;
}
// r7 (X4): two readings came from different operators (both named; none in common)
export const elyOpsDisjoint = (a?: string[], b?: string[]): boolean => Array.isArray(a) && Array.isArray(b) && a.length > 0 && b.length > 0 && !a.some((x) => b.includes(x));
// r5 (B7): a BUY whose own quote at its real size is worse than the other operator's by more than the bound is refused (fail closed)
export function elySizedBuyProblem(ownOut: bigint, laneOut: bigint | null, slippageBps: bigint): string {
  if (!laneOut) return '';
  const bound = slippageBps > ELY_LANE_BOUND_BPS ? slippageBps : ELY_LANE_BOUND_BPS;
  if (ownOut * 10_000n < laneOut * (10_000n - bound)) return `the node quoted this buy ${Number(((laneOut - ownOut) * 10_000n) / laneOut) / 100}% worse than motion's second reading at your size — not sent`;
  return '';
}
export const elyLaneFor = (r: ElyLaneReading, pool: string): ElyLaneCheck | null => (r && Array.isArray(r.checks) ? r.checks.find((c) => lc(c?.pool) === lc(pool)) || null : null);
// the vault's own reading of a pool at the fixed size: its probe's ELY_LANE_REF_IN round-trip case on that candidate
export type ElyOwnRef = { buyOut: bigint; sellIn: bigint; sellOut: bigint } | null;
export function elyLaneProblem(side: 'buy' | 'sell', pool: string, own: ElyOwnRef, reading: ElyLaneReading, slippageBps: bigint): string {
  const lane = elyLaneFor(reading, pool);
  const usable = !!(reading && reading.independent === true && Number.isFinite(Number(reading.ageMs)) && Number(reading.ageMs) >= 0 && Number(reading.ageMs) <= ELY_LANE_MAX_AGE_MS && lane);
  let li = 0n, lo = 0n, si = 0n, so = 0n;
  if (usable) { try { li = BigInt(lane!.buyIn); lo = BigInt(lane!.buyOut); si = BigInt(lane!.sellIn); so = BigInt(lane!.sellOut); } catch { li = 0n; } }
  const readable = usable && li === ELY_LANE_REF_IN && lo > 0n && si > 0n && so > 0n;
  const bound = slippageBps > ELY_LANE_BOUND_BPS ? slippageBps : ELY_LANE_BOUND_BPS;
  const pct = (worse: bigint, base: bigint) => Number((worse * 10_000n) / base) / 100;
  if (side === 'buy') {
    if (!reading) return 'motion could not confirm this price from a second node — try again in a moment';
    if (reading.independent !== true) return 'motion\'s second price reading came from the same node — not bought (try again in a moment)';
    if (!usable) return lane ? 'motion\'s second price reading is too old — try again in a moment' : 'motion has no second price reading for this pool yet — try again in a moment';
    if (!readable) return 'motion\'s second price reading is unreadable';
    if (!own || !(own.buyOut > 0n)) return 'the node gave no price at the reference size — not bought';
    if (own.buyOut * 10_000n < lo * (10_000n - bound)) return `the node quoted a price ${pct(lo - own.buyOut, lo)}% worse than motion's second reading — not sent`;
    return '';
  }
  // sell: only a FRESH (≤ 5 s), independent, readable reading of this very pool can question it (r4 M1) — and the engine then asks
  if (!readable || !own || !(own.sellIn > 0n) || Number(reading!.ageMs) > ELY_LANE_SELL_MAX_AGE_MS) return '';
  // HYPE per coin at the fixed size: own.sellOut / own.sellIn vs so / si
  if (own.sellOut * si * 10_000n < so * own.sellIn * (10_000n - bound)) return `the node quoted a sell price ${pct(so * own.sellIn - own.sellOut * si, so * own.sellIn)}% worse than motion's second reading of this pool`;
  return '';
}
// r3 (re-review N5): the slippage the user set IN THE ELYSIUM FRAME (its own key; a settings save on another chain or a backup
// restore never writes it); absent → ELY_SLIPPAGE_DEFAULT_BPS
export const ELY_SLIP_KEY = 'trenches.engine.elysium.slippage';

// r2 (review M-T2): the honeypot proof as the PLAIN wallet. The probe runs as code at the wallet's address, so tx.origin has code
// there; a token can tell. This is one eth_simulateV1 call AS THE EOA (no code override, its balance set), in one block, of
// exactly what a holder would do next: the real buy with its floor, then approve 0 → approve exactly → Permit2 exactly → the sell of
// 99 % of what the probe said the buy delivers (a coin that gives an EOA less fails here), with the wallet's balances read
// between. A refusal or a bad number = not bought.
export const ELY_EOA_SELL_BPS = 9900n;
// r4 (merged review M2): a token can let a swap through only when gasleft() is high. Every simulation of a call therefore runs at the
// gas limit that call will be SIGNED with, from one formula: the probe's measured gas + 50 % + 60 k (at most ELY_SWAP_GAS_CAP), and
// ELY_APPROVE_GAS for an approval. The probe itself (40 M) only measures; nothing is signed from an estimate any more.
export const ELY_APPROVE_GAS = 120_000n;
export const ELY_SWAP_GAS_CAP = 3_000_000n;
// r5 (review B1 / R5): the formula is a first try, never a refusal on its own. The buy's plain-wallet proof runs its sell-back at the
// cap (a cold sell needs far more than the probe's warm in-call measurement: ElysPump V4 ~196 k vs ~74 k measured), and a sell whose
// simulation fails at the formula limits is simulated again at the caps and, if that passes, signed at the caps — so a sell is
// always signed at a limit its own simulation passed at, and the proof never runs above what a sell may be signed with.
export const ELY_APPROVE_GAS_CAP = 500_000n;
export const elySwapGas = (measured: bigint): bigint => { if (!(measured > 0n)) return 0n; const g = measured + measured / 2n + 60_000n; return g > ELY_SWAP_GAS_CAP ? ELY_SWAP_GAS_CAP : g; };
// r3 (re-review N2): eth_simulateV1 runs with gasprice 0 and basefee 0 unless validation is on (measured on 99901). The proof runs
// with validation (the real base fee, the real gas price of the call, nonce and balance checked) and the block time of the next
// block, so a token cannot tell the simulation from the real transaction by tx.gasprice / block.basefee / block.timestamp.
export const elySimBlock = (latestTs: number, baseFee?: bigint) => ({ validation: true, blockOverrides: { time: '0x' + (latestTs + 1).toString(16), ...(baseFee && baseFee > 0n ? { baseFeePerGas: '0x' + baseFee.toString(16) } : {}) } });
const MC3_BAL = [{ name: 'getEthBalance', type: 'function', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const BAL_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
export type ElySimCall = { from: Hex; to: Hex; data: Hex; value: Hex; gas?: Hex };
// the address that reads the wallet's balances inside the proof (any address works; its balance is set in the same override)
export const ELY_OBSERVER = '0x00000000000000000000000000000000e1e0b5e7' as const;
export function elyEoaCalls(o: { wallet: string; c: ElyCandidate; token: string; amountIn: bigint; floor: bigint; sellAmt: bigint; deadline: bigint; now: number; buyGas: bigint; sellGas: bigint; wall?: number }): ElySimCall[] {
  const w = lc(o.wallet) as Hex, t = lc(o.token) as Hex, hx = (n: bigint) => ('0x' + n.toString(16)) as Hex;
  // validation needs explicit limits; r4 (M2): the buy and the sell at the limits they are signed with (elySwapGas), approvals at ELY_APPROVE_GAS
  const G_READ = '0x30d40' as Hex, G_APPROVE = hx(ELY_APPROVE_GAS), G_BUY = hx(o.buyGas), G_SELL = hx(o.sellGas);
  const eth = { from: ELY_OBSERVER as Hex, to: ELY_MULTICALL3 as Hex, data: encodeFunctionData({ abi: MC3_BAL, functionName: 'getEthBalance', args: [w] }), value: '0x0' as Hex, gas: G_READ };
  const coin = { from: ELY_OBSERVER as Hex, to: t, data: encodeFunctionData({ abi: BAL_ABI, functionName: 'balanceOf', args: [w] }), value: '0x0' as Hex, gas: G_READ };
  const ap = (n: bigint) => ({ from: w, to: t, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [ELY_PERMIT2, n] }), value: '0x0' as Hex, gas: G_APPROVE });
  return [
    eth, coin,                                                                                                          // 0 1  (the observer reads)
    { from: w, to: o.c.router, data: elyExecute(elyBuyEnc(o.c, t, o.amountIn, o.floor), o.deadline), value: hx(o.amountIn), gas: G_BUY },   // 2 the buy
    eth, coin,                                                                                                          // 3 4
    ap(0n), ap(o.sellAmt),                                                                                              // 5 6
    { from: w, to: ELY_PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [t, o.c.router, o.sellAmt, elyPermitExpiry(o.now, o.wall)] }), value: '0x0', gas: G_APPROVE }, // 7
    { from: w, to: o.c.router, data: elyExecute(elySellEnc(o.c, t, o.sellAmt, 0n), o.deadline), value: '0x0', gas: G_SELL },        // 8 the sell
    eth, coin,                                                                                                          // 9 10
  ];
}
export type ElySimResult = { status: string; returnData: Hex; gasUsed: string; error?: { message?: string } };
export function elyEoaProblem(res: ElySimResult[] | null | undefined, o: { amountIn: bigint; floor: bigint; sellAmt: bigint; gasPrice?: bigint }): { problem: string; buyGas: bigint } {
  const no = (problem: string) => ({ problem, buyGas: 0n });
  if (!Array.isArray(res) || res.length !== 11) return no('the plain-wallet simulation did not answer — not bought');
  const ok = (i: number) => res[i]?.status === '0x1';
  const w = (i: number) => { try { return BigInt(String(res[i].returnData).slice(0, 66)); } catch { return -1n; } };
  if (![0, 1, 3, 4, 9, 10].every(ok)) return no('the plain-wallet simulation did not answer — not bought');
  if (!ok(2)) return no('the buy would not go through as a plain wallet — not bought');
  if ([0, 1, 3, 4, 9, 10].some((i) => w(i) < 0n)) return no('the plain-wallet simulation did not answer — not bought');
  // r7b: what the buy TAKES from the wallet. A buy may also RETURN HYPE: the plan's final SWEEP (native V4) hands the wallet whatever
  // native HYPE sits in the Universal Router — other traders' leftovers (their V4_SWAP-only transactions overpay and never sweep). On
  // 4 Nov 0.98 HYPE sat in Uniswap's router 0x1b34…3c1a and every uni-v4 buy read as "spent −0.97": refused as an overspend. A gain is
  // not an overspend; the bound below stays the one that matters (never more than the amount + its gas).
  const got = w(4) - w(1), spent = w(0) > w(3) ? w(0) - w(3) : 0n, back = w(9) - w(3), sold = w(4) - w(10);
  // under validation the wallet pays its own gas: the buy may take its amount plus at most its gas at the call's price; the sell-back
  // figure keeps the four calls' fees as a loss (conservative: ~0.3 % of a 0.01 HYPE buy)
  let buyGasUsed = 0n; try { buyGasUsed = BigInt(res[2].gasUsed); } catch { /* no figure: no allowance */ }
  const feeRoom = buyGasUsed * (o.gasPrice ?? 0n);
  if (got < o.floor) return no('the coin gives a plain wallet less than the floor — not bought');
  if (spent > o.amountIn + feeRoom) return no('the buy would take more HYPE than its amount — not bought');
  if (![5, 6, 7, 8].every(ok)) return no('this coin could not be sold back by a plain wallet right after the buy (honeypot check) — not bought');
  if (sold !== o.sellAmt) return no('the sell-back took another amount of the coin — not bought');
  if (!(back > 0n) || back * 10_000n < o.amountIn * (ELY_EOA_SELL_BPS - ELY_ROUNDTRIP_MAX_BPS)) return no(`selling it straight back as a plain wallet would return only ${back > 0n ? (Number((back * 10_000n) / o.amountIn) / 100).toFixed(1) : '0'}% — not bought`);
  let g = 0n; try { g = BigInt(res[2].gasUsed); } catch { /* no gas figure: the estimate decides */ }
  return { problem: '', buyGas: g };
}

export type ElyPick = { i: number; c: ElyCandidate; s: ElySeen } | null;
// The buy's pool: among the candidates that exist and whose buy went through, the one paying the most coin; the hinted pool
// wins within ELY_HINT_TOLERANCE_BPS (so the vault and motion agree unless the hint is materially worse). For a sell, the
// most HYPE back.
export function elyPick(cands: ElyCandidate[], seen: ElySeen[], side: 'buy' | 'sell'): ElyPick {
  const val = (s: ElySeen) => (side === 'buy' ? (s.ran && s.buyOk && !s.routerKept ? s.coinGot : 0n) : (s.ran && s.sellOk && !s.routerKept ? s.nativeBack : 0n));
  let best = -1, hint = -1;
  // release 7: a BUY never picks a pool behind an unreviewed hook ('auto' / 'unverified') that fails elyTierBuyProblem on the click's own
  // buy-and-sell-back (Unverified: ≤ ELY_UNVERIFIED_MAX_BUY; both: ≥ 80 % back). When nothing else fills, the failing pick is returned
  // with its reason (s.tierProblem), which elyBuyProblem reports first — so the caller's buy is refused, with the reason.
  const tierWhy = (i: number) => (side === 'buy' && seen[i] ? elyTierBuyProblem(cands[i], seen[i].nativeSpent, seen[i]) : '');
  let failed = -1;
  cands.forEach((c, i) => {
    const v = seen[i] ? val(seen[i]) : 0n; if (!(v > 0n)) return;
    if (tierWhy(i)) { if (failed < 0 || v > val(seen[failed])) failed = i; return; }
    if (best < 0 || v > val(seen[best])) best = i; if (c.hinted) hint = i;
  });
  if (best < 0) return failed >= 0 ? { i: failed, c: cands[failed], s: { ...seen[failed], tierProblem: tierWhy(failed) } } : null;
  const i = hint >= 0 && val(seen[hint]) * 10_000n >= val(seen[best]) * (10_000n - ELY_HINT_TOLERANCE_BPS) ? hint : best;
  return { i, c: cands[i], s: seen[i] };
}
// '' = the buy may go; else why not. `ref` is the same pool's case at the reference size (null: unknown → refused).
export function elyBuyProblem(s: ElySeen, ref: ElySeen | null, amountIn: bigint, refIn: bigint): string {
  if (s.tierProblem) return s.tierProblem;   // release 7 (elyPick): an unreviewed hook's buy-and-sell-back or size failed its tier
  if (!s.ran) return 'the pool does not exist';
  if (!s.buyOk || s.coinGot <= 0n) return 'the buy would not go through';
  if (s.routerKept) return 'the router would keep part of the trade';
  if (s.nativeSpent > amountIn) return 'the buy would take more HYPE than its amount';
  if (!s.sellOk || s.nativeBack <= 0n) return 'this coin could not be sold back right after the buy (honeypot check) — not bought';
  if (s.nativeBack * 10_000n < amountIn * (10_000n - ELY_ROUNDTRIP_MAX_BPS)) return `selling it straight back would return only ${(Number((s.nativeBack * 10_000n) / amountIn) / 100).toFixed(1)}% (tax or hook fees) — not bought`;
  if (s.taxSent > 0n && s.taxGot * 10_000n < s.taxSent * (10_000n - ELY_TAX_MAX_BPS)) return 'this coin keeps more than 10% of a plain transfer, or refuses it — not bought';
  if (!ref || !ref.ran || !ref.buyOk || ref.coinGot <= 0n) return 'the price impact could not be measured — not bought';
  // price per coin at the reference size vs at the buy's size: impact = 1 − (got/in) / (refGot/refIn)
  const lhs = s.coinGot * refIn * 10_000n, rhs = ref.coinGot * amountIn * (10_000n - ELY_IMPACT_MAX_BPS);
  if (lhs <= rhs) return 'this buy would lose 30% or more to price impact — buy less';
  return '';
}
export const elyImpactBps = (s: ElySeen, ref: ElySeen, amountIn: bigint, refIn: bigint): number => {
  if (!(ref.coinGot > 0n) || !(amountIn > 0n)) return 10_000;
  const r = (s.coinGot * refIn * 10_000n) / (ref.coinGot * amountIn);
  return Math.max(0, 10_000 - Number(r > 10_000n ? 10_000n : r));
};
// '' = the sell may go (sells are never refused for price impact: a holder must always be able to exit — owner, 2026-11-02)
export function elySellProblem(s: ElySeen, amountIn: bigint): string {
  if (!s.ran) return 'the pool does not exist';
  if (s.routerKept) return 'the router would keep part of the trade';
  if (!s.sellOk) return 'the sell would not go through';
  if (s.coinSold !== amountIn) return 'the sell would take another amount of the coin than asked';
  if (s.nativeBack <= 0n) return 'the sell would return nothing';
  return '';
}
// the floor the transaction signs: the simulated output minus the slippage setting; never 0
export function elyFloor(q: bigint, slippageBps: bigint): bigint {
  if (!(q > 0n)) throw new Error('Refusing to trade without a minimum-out floor');
  const bps = slippageBps < 0n ? 0n : slippageBps > 10_000n ? 10_000n : slippageBps;
  const f = (q * (10_000n - bps)) / 10_000n;
  if (f <= 0n) throw new Error('Refusing to trade without a minimum-out floor');
  return f;
}

// ── exact approvals (and their reset) ──
export const ERC20_APPROVE_ABI = [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
export type ElyCall = { to: Hex; data: Hex; label: string };
// The transactions a sell of `amount` needs before the router can pull the coin: the coin's allowance to Permit2 (exactly
// `amount`; 0 first over an older, smaller one — some tokens refuse a non-zero → non-zero change) and Permit2's allowance to
// THIS router (exactly `amount`, expiring in ELY_PERMIT_S from the later of the block time and the wall clock). A standing allowance
// that already covers it and lives at least ELY_PERMIT_REFRESH_S more is left as it is. `wall` (seconds) is for tests only.
export function elyApprovals(o: { token: string; router: string; amount: bigint; allowance: bigint; p2Amount: bigint; p2Expiry: number; now: number; wall?: number }): ElyCall[] {
  if (!ELY_ROUTERS.includes(lc(o.router))) throw new Error('Refusing to approve a router this vault does not know');
  if (!(o.amount > 0n) || o.amount >= 1n << 160n) throw new Error('Refusing an approval of this size');
  const t = lc(o.token) as Hex, out: ElyCall[] = [];
  if (o.allowance < o.amount) {
    if (o.allowance > 0n) out.push({ to: t, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [ELY_PERMIT2, 0n] }), label: 'reset the coin allowance' });
    out.push({ to: t, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [ELY_PERMIT2, o.amount] }), label: 'approve the coin to Permit2' });
  }
  if (o.p2Amount < o.amount || o.p2Expiry <= elyPermitNow(o.now, o.wall) + ELY_PERMIT_REFRESH_S) out.push({ to: ELY_PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [t, lc(o.router) as Hex, o.amount, elyPermitExpiry(o.now, o.wall)] }), label: 'allow the router through Permit2' });
  return out;
}
// after a sell that did not use its approvals (reverted, dropped): what is left goes back to 0 — only an allowance this
// path gave (exactly the sell's amount) is reset; somebody else's larger one is not ours to touch
export function elyResets(o: { token: string; router: string; amount: bigint; allowance: bigint; p2Amount: bigint }): ElyCall[] {
  const t = lc(o.token) as Hex, out: ElyCall[] = [];
  if (o.allowance > 0n && o.allowance <= o.amount) out.push({ to: t, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [ELY_PERMIT2, 0n] }), label: 'reset the coin allowance' });
  if (o.p2Amount > 0n && o.p2Amount <= o.amount && ELY_ROUTERS.includes(lc(o.router))) out.push({ to: ELY_PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [t, lc(o.router) as Hex, 0n, 0] }), label: 'reset the Permit2 allowance' });
  return out;
}
// What the vault is ever asked to sign on Elysium, checked once more right before the key: a router of ELY_ROUTERS (value =
// the buy's HYPE, or 0 on a sell), the coin itself (an approve to Permit2 only), or Permit2 (an approve of this coin to a
// known router only). Anything else is refused. '' = fine.
export function elyTxProblem(tx: { to: string; data: string; value?: bigint }, token: string, maxValue: bigint): string {
  const to = lc(tx.to), d = lc(tx.data), v = tx.value ?? 0n, t = lc(token);
  if (ELY_ROUTERS.includes(to)) return d.startsWith('0x3593564c') ? (v <= maxValue ? '' : 'more HYPE than the trade') : 'not a router execute';
  if (v !== 0n) return 'value on an approval';
  if (to === t) return d.startsWith('0x095ea7b3') && d.slice(10, 74) === ELY_PERMIT2.slice(2).padStart(64, '0') ? '' : 'a coin call other than an approve to Permit2';
  if (to === ELY_PERMIT2) return d.startsWith('0x87517c45') && d.slice(10, 74) === t.slice(2).padStart(64, '0') && ELY_ROUTERS.includes('0x' + d.slice(98, 138)) ? '' : 'a Permit2 call other than this coin to a known router';
  return 'an address this path never calls';
}
