// Release 19 (fee enforcement): which markets charge the terminal fee, as the ENGINE decides it. Deployment-pinned like
// src/terminalFeeGate.ts: no request, page argument, account tier or network answer can add or remove a market.
//
// EVM (Robinhood, BNB): a TOKEN is covered when the terminal quote's reviewed route table lists it. The table route's market key
// is in TERMINAL_EVM_POLICY.marketKeys (test/fee-enforce-coverage.mjs re-derives both lists from the table copies in
// test/fixtures/fee-enforce and checks every key). Coverage is per token, not per pool: motion's /route may rank another pool for
// the same coin (measured 2026-11-09: 0x0617…e60f, table = native V4 pool, /route = USDG V4 pool), and the fee path quotes the
// table's market for it. Robinhood also covers every native-pair Pons V2 curve (factory-wide in the policy, like the quote host's
// ponsV2:true): those are decided on the route the vault itself trades (its own /route read).
// Solana: a market is covered when the vault's own route for the coin is Jupiter (the venue the Solana quote builds); pump.fun
// curve, PumpSwap, pumphop and Meteora DLMM routes have no fee path in the legacy trade and stay fee-free here.
// Everything else is UNCOVERED and trades fee-free on the legacy path: BNB four.meme / Pancake V3 / Infinity, Robinhood V3 /
// other V4 / Long / Standard curve, a Pons curve paired with a non-native coin, every coin that was not in the table when it
// was built (a new table = a new engine build).
//   routes-robinhood.json sha256 dc02d813e0246019240682c67caac39f23a201b13cd184e9f5f99f4b5252decc (= /etc/motion-terminal-quote on the box, 2026-11-09)
//   routes-bsc.json       sha256 300f4f925e7f050f5b0f70f1e20e26df23b9e41caba39870f4aa17a6c07f3988
// Release 20: route-based coverage by venue class (src/terminal-evm/venue-registry.mjs), see evmCovered / solCovered below.
import { registryClass } from './terminal-evm/venue-registry.mjs';
export const COVERED_TOKENS: Readonly<Record<'robinhood' | 'bsc', ReadonlySet<string>>> = Object.freeze({
  robinhood: new Set<string>([
  '0x0203d6032fd529c888c9d79cbdf2e169611f091f',
  '0x061732dc141e0a2d37f5fa91cf5343f24064e60f',
  '0x085b263746faa370d6915245be0a2faf8a707e61',
  '0x0926eb7a097b71e27d18a26cbe6ce29a82e6a37a',
  '0x1959c782e156a0c0aa2c288d7ae4cd3f01abfcde',
  '0x3cedeb9e2b73ae92c61aa4bb5fa27d1cbab75d65',
  '0x4a3e1c523efbfbda311d4724487e21aadeb8f7ed',
  '0x5452fcb54894027801cf8852e6acbca2890cb5f7',
  '0x693a9bb5b955ec0433d181553a9b896d2781b37b',
  '0x77a1d1bbaaed989faf5ed10e623aebee6853373d',
  '0x7c0495053f47ec52eb4b678c4ad8f572df745bfe',
  '0x91595ef6fc5ca3039845de6ceec2755cb7b332bf',
  '0x92de9d3888953f3c6a55840f189c409976d9bba1',
  '0x9353ac4dcf13630169e22188894deb20abf40e3a',
  '0x947ac56bb8e722ddef0d58303b1113847781e240',
  '0x9994bfa979179af4bb0fbcd7f2df0d20a86637de',
  '0xa952bf4f94a962fa8f82357e4d647a9f96dfb4c1',
  '0xbf9b33ed15069775e799c7af7ccb0637f8eeb9bf',
  '0xd21166922242d3cb6c35702ccd2b9771e80e15df',
  '0xee1c78ad44f862430fd125c5201f4fd21b878637',
  '0xf36834a6f6453baf1a1be347a00b30071947f2d5',
  '0xf840e45ad7f6ed08cea13c8af8795e5c796ce98a',
  '0xf913b7961bf1a1f16835d69f9b0bdaf9528a740d',
  ]),
  bsc: new Set<string>([
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
  '0x03d65edab34360e1098bfd379255ddf910bb7777',
  '0x064baa08999abf0a917f000dd4782196a1037777',
  '0x0829d99edaf4b94d1a1f79c826976d9501a17777',
  '0x0b35285fe783dd3441573b84be4fbdb743457777',
  '0x0c6302401aa5325c2e36f170f52c00b1d220b405',
  '0x0cee7a04355b2e2d7248d9566db8889cf44f7777',
  '0x0d991bbb5a470b8cd6398a21f2afb9f28a0e7777',
  '0x0fe805ae8ca0ff9971ddfacdbfd837d41c597777',
  '0x10ee65bd5c7f0395f6a7e0e8fcdf9604482b7777',
  '0x113d68c8cca4fe5ba25f49c00784079d168e7777',
  '0x1235baa9ddf30f590e7db70fdad74fb508587777',
  '0x14f6a94909c407854390aa2d2462a3095d317777',
  '0x15c33670ceadf3ff6de984647abb37a39ff77777',
  '0x1a72fd7d075acea148f7ec63e24a21baa5cbffff',
  '0x1d628e104a110e02bdd91ea34e124278874f7777',
  '0x1dc82baca62c0ba85f09dbfb8033814f64207777',
  '0x211f9bb97d5069af0891902957fe537550d37777',
  '0x22cd94d51cd4a8947c337af2e3868ed47aee7777',
  '0x26a77b49f80b11a72fa89452fbe9073d776b7777',
  '0x275b22c5ea15970428c8248cc047b3cdf1a07777',
  '0x276681605b6a85894ef4d9a580050047e36a7777',
  '0x28ef2256fe6fbdcb1f0f2dbdee0a082ff7017777',
  '0x29b2b7cb9d09e0c85de42db1061a18473dbf7777',
  '0x2b1d6b8475d542d3e1c826d0ff22ea5c2cb57777',
  '0x2db74b911d3d17eeaed82f3cdd0836e9edcf7777',
  '0x30b446c5b023129fcba3f12661042ba700867777',
  '0x3116a5e304b13c5a65881cfd829b196d83047777',
  '0x324dab89dbeccad2413317c3c2c792a1dc227777',
  '0x3254a72d2907a68cb4eecf9a5c2420ce52c97777',
  '0x36551d9a26f2dcbd901c7b7ad04673ccf23e7777',
  '0x367f70fd5d7962b6f5ba8973ffd3e7d891f17777',
  '0x3c8250f320a6ac4bd632991ee493c889ce937777',
  '0x3e6f7cf11a7a2a7d3b3b0370bdb1917863377777',
  '0x3ee49b3e4cf289bf2d5b06b1a1fef37ae5137777',
  '0x3f15b50f4631ca33ebf06bef7b6f9ad2448d7777',
  '0x46e4b82d338b7db8eca173b973f20476602d7777',
  '0x480b4cfa02e69e66263c93f14bea0e1e69587777',
  '0x48acf8b8d1a4bce3e7d76d15b178c5e5960f7777',
  '0x48d70bd972505a02033fbc0bfe1a0e7686ee7777',
  '0x4902c5ebc598265ed2212b559b042de8a5eeec3f',
  '0x49f0ce0c1e6c2000626884cab87889ebc8c67777',
  '0x4c465c06573e821e44c1dec00d3c3d57ebf87777',
  '0x4d3bec623ab04e6f8c79691f8dcb872a4740ffff',
  '0x507dfbb4c49af0dfd00283aa2f012f8a4a267777',
  '0x5389a2caf8253bf768712ff7eecaef6bd77e7777',
  '0x547e81ff918e34e15a1adb795edb3f654fcc7777',
  '0x552aee338af26567534e632bf8ec4eb802627777',
  '0x55b191611c2c282cc735c29c3b2ff7c2cae57777',
  '0x569e98a75eb37dd464b086b83790ecc00b1d7777',
  '0x579de142402e670ccb4c63cc250dfe5b68d27777',
  '0x5ac9886b8629d38094a6cae7cf9879b40ceb7777',
  '0x5b1910eaad6450e50f816082aa078c41f10c292f',
  '0x5dd2b276d2f66de4a3c70c7b0f94d55a7e7d7777',
  '0x5f8c29604581af48ae25598c24e8eac3e50a7777',
  '0x61a0787ca30557d38026c646cf2d950776547777',
  '0x6809e7082b9e9877bd89f26bc079419cb87c7777',
  '0x6bb7acac10f3d69de136579641bf4d467a397777',
  '0x6bdf0406283413f14da6619ada0d23d055727777',
  '0x6e2a4ecb5081ec392258438b4bb42615da2a7777',
  '0x6f34ad5f19a3baa7d5e2b8282ff0d75a774e7777',
  '0x6f6e44925c17e7290c2032fd2d0731ac861e7777',
  '0x6f9f4a0e4702f4f16cb80b8b6d922771af6e7777',
  '0x6fc4162002f3b106c3bce28954d952916b367777',
  '0x72c6411071c28c622c0d7d12c331640845167777',
  '0x731987ef4be608b8c27f70f2540f770d46ae7777',
  '0x733c00f60adcee876d928d8766274203084b7777',
  '0x758e238272c2f78f632480ae25cdcfdea2287777',
  '0x77113f1cd4bdef9a2d2c86c0b3fa1844c9787777',
  '0x78cd05cf0d0b2a8022fdda8c97baad31f2c07777',
  '0x78fd41e3c3fecbbfc04c399672ad37a16b99ffff',
  '0x7c4d42f2081179023e2adec970e1814313347777',
  '0x7c5f09baf2733eb0fa4c674235f4c49cd9417777',
  '0x7de1606230aa70802caecf1a3e90039a6265b1c4',
  '0x806321269b9d1e7a90fd859bc07fca250e257777',
  '0x8474d67585d93275b9c7a2d0f1c9ed2141777777',
  '0x8a117e7d9993b37ffab0996b80b6fd9789b27777',
  '0x8d73dbd6a89e38a3cd5a7050c7f3d98e38667777',
  '0x8d77ebd032e6647f2d278578775063bd65977777',
  '0x90ff4a1883805b322ab4861e4a1c32b72b187777',
  '0x9184566749a78aef757ad3b2ce1d1cce47997777',
  '0x923bdda3aa42a74c2e9b6afdce14c2b4c0e57777',
  '0x9244708f469199c2e1bc613d31e615e33bf87777',
  '0x9453f47b2c17798a32ffdd3b15cfa01613e97777',
  '0x94c4a633309f5e7e521d1b2d2cba67950dedffff',
  '0x94e34d6ada75b2898ab71b79d10d843a733b7777',
  '0x95494df02dc2c30e74cdda3cdb912debf2e97777',
  '0x95578773e3b4fbcb7c88d9e2cf9aa682c86bffff',
  '0x95d722dcd7ecdf8f5306f75411e4ec1c11bd7777',
  '0x975faed559b45feb8a5c5ceb940e614302947777',
  '0x97ce06a6f1b5a170c003dc6d0c242f5b6e907777',
  '0x9862d6478cb8098645815ff27f91efbc659f7777',
  '0x9b5a213e7f26516e0ec11cda9ba06ff8a1017777',
  '0x9c913dbbfd5feaa2e5c4585ebb4ee1a71a237777',
  '0x9ce238f22bbf13c4b4fe0b774e32bec7c82a7777',
  '0x9d6718a01147f272a518d6da60abe095c0f37777',
  '0x9d88980d66d6af042411a3ba39994b51abde7777',
  '0x9dff1b05243e79dd4f6d5549d50815dd9db57777',
  '0x9fa8ce7c115f5cea678ac9b5b3b638ec6d957777',
  '0xa12da721fa95efff4cbc995483ffdafec0607777',
  '0xa507b706e69ecfefda1861c999e7adb52fc97777',
  '0xa5b4f745634e0f354d7ae05f9a4a2fa47d017777',
  '0xa6bc45fd21b06a82a82917c2f4f99e2b7a7b7777',
  '0xa88ebd7644837294011650b3a13d274001ef7777',
  '0xa990ea580eb94f2bfc8f5b4f8e91430819f97777',
  '0xabb96baf967e54b2b9c748362c965566f21d7777',
  '0xac21f150d7b98770d7344ee751cc954d7e2e7777',
  '0xb0c2ab5af4028461ace3f6e1c33a4ee1404e7777',
  '0xb47574a489945cd8086c80658d17ea4a794c7777',
  '0xb6f2da751b3b7e09a4b8ddb38b04dec608ab7777',
  '0xb84a69219443d278bbab801ba19380eee6cc7777',
  '0xb879b7873aa7c3bd2fe9ed2992b2d3bbf9487777',
  '0xbae277745ff987446af743d50c2bd529112d7777',
  '0xbb5cc95ac222f36a68ace7380c5439e3fcb47777',
  '0xbca41e58dc9282964c43c9a5b565e280e4c1ffff',
  '0xbe7ad219d06e46ff9574c428601808dadec47777',
  '0xc022fdb61b5dfbd3b167f74fcba7d0381b937777',
  '0xc0a7c16e54ad236b7f07fd3dd6187780a4db7777',
  '0xc85bf38c8d0b7e5c59911bcb536f76750b937777',
  '0xc96dff1a903417c9964cc367dbe2039d4d7f7777',
  '0xcda15bfbb4c9427c76fd5de17172ef3febdc7777',
  '0xce29d3ffacfd35c364dba6eac1bd105aa8f97777',
  '0xce3b2809eb55e8abf2c4da61df166f1c2ad57777',
  '0xcfd5f0f51eba4151f9a593279d77cefedd187777',
  '0xd738b729b2a51100d01e4302de08c11fa4427777',
  '0xd8045117422c4ec16a739113beeadf7f19987777',
  '0xdafc92ec27417f0951ecc3159a39a669dae07777',
  '0xdb4828a709bb2888a796cc774f5e50ae6acc7777',
  '0xdd49812292afa160a2baea09fa12089c65cb7777',
  '0xdf96a1498f336035d004a380dfeb0b4aff357777',
  '0xe36a062176dc86cd8c5a2ddc743108bab27e7777',
  '0xe4f1e59e3bd8345a2cb1200c2634c280edf97777',
  '0xe6abc844653c20482a0c45c3cd6e203d62267777',
  '0xe92ba1c76f1c37904883e09afb3656c526e47777',
  '0xe9320db4ddfc689470d09c768a4cb9b05cf97777',
  '0xedd39f442fb734f4dde543f52f3c16eaa6147777',
  '0xef13106ea7218a426090ed648a62f0c70b137777',
  '0xf1a91ff1ebff7fbf4219f2706f88fbd164fe7777',
  '0xf1b3ed8c96c505e38ce746512bb2234fd3f07777',
  '0xf3bf87dbceb6d0fdd1820dc84a82c31be49c7777',
  '0xf49725118cb0707b8706ffffe895f3ab16da7777',
  '0xf83c938c018310ecb60981f5b1a855fcec0e7777',
  '0xf897f943924799d295066d51085b08397d627777',
  '0xfc404df1c1201b23c6335d54d468ca2c2e167777',
  '0xfe869d3372ae7a293b583c0af2ac1465510a7777',
  ]),
});
const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (x: unknown) => String(x ?? '').toLowerCase();
/** a Robinhood Pons V2 curve paired with the native coin, no bridge leg: the only Pons market the TerminalRouter policy trades */
export function nativePonsRoute(route: unknown): boolean {
  const r = route as { type?: unknown; pairToken?: unknown; bridgeHops?: unknown; bridgeFee?: unknown } | null;
  return !!r && typeof r === 'object' && r.type === 'pons' && lower(r.pairToken) === ZERO &&
    (r.bridgeHops == null || (Array.isArray(r.bridgeHops) && r.bridgeHops.length === 0)) && !Number(r.bridgeFee || 0);
}
// Release 20 (coverage by venue, src/terminal-evm/venue-registry.mjs): `registry` = the venue classes the deployment lists in
// TERMINAL_EVM_POLICY[chain].registry. A coin outside the table is covered when the route the vault itself would trade (its own
// /route copy) is of an enabled class — the same registryClass() the vault guard and the quote service use, so a coin launched
// after the build is covered without a new table. Absent / empty registry = the release-19 decision exactly.
export type CoverageSwitches = {
  ponsV2: boolean;
  tokens?: Readonly<Record<'robinhood' | 'bsc', ReadonlySet<string>>>;
  registry?: Readonly<Partial<Record<'robinhood' | 'bsc', readonly string[]>>>;
};
/** EVM: the token alone decides when it is in the table; otherwise the vault's own route decides (native Pons curve on Robinhood
 *  with ponsV2 on, or an enabled registry class). route === undefined: the route is not known yet (the caller reads it and asks
 *  again); with no route-based coverage switched on for the chain the answer is false at once (no read). */
export function evmCovered(chain: string, token: unknown, route: unknown, sw: CoverageSwitches): boolean | undefined {
  if (chain !== 'robinhood' && chain !== 'bsc') return false;
  if (typeof token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(token)) return false;
  if ((sw.tokens ?? COVERED_TOKENS)[chain].has(token.toLowerCase())) return true;
  const reg = sw.registry?.[chain] ?? [];
  const pons = chain === 'robinhood' && sw.ponsV2;
  if (!pons && reg.length === 0) return false;
  if (route === undefined) return undefined;
  if (pons && nativePonsRoute(route)) return true;
  const cls = reg.length ? registryClass(chain, route, token) : null;
  return cls !== null && reg.includes(cls);
}
// Solana: the terminal quote is a Jupiter swap with motion's platform fee (one Jupiter instruction, the vault's receipt path).
// Release 20: Jupiter also routes pump.fun curves ("Pump.fun") and PumpSwap pools ("Pump.fun Amm") — measured 2026-11-09 on the
// coins motion traded (B:/tmp/fee-coverage/measure/jupiter-sol.json) — so those venues can take the fee path too. Which of the
// vault's own venues count as covered is deployment-pinned here. 'dlmm' and 'pumphop' stay fee-free (not measured enough).
export const SOL_COVERED_VENUES: readonly string[] = Object.freeze(['jupiter', 'pump', 'pumpswap']);
/** Solana: covered iff the vault's own route venue is one the terminal Jupiter quote takes */
export function solCovered(route: unknown, venues: readonly string[] = SOL_COVERED_VENUES): boolean {
  const v = !!route && typeof route === 'object' ? (route as { venue?: unknown }).venue : undefined;
  return typeof v === 'string' && venues.includes(v);
}
