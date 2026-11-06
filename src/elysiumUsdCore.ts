// A buy on Elysium paid from the USD balance (2026-11-04; owner: "a user with a USD balance who opens an Elysium coin must be
// able to buy it straight from the USD balance, like on Robinhood / BNB / Solana"). PURE rules — no key, no clock, no network.
// The runner is src/elysiumUsdEngine.ts; the bridge it uses is motion's own (src/bridgeSolver.ts + src/motionBridgeCore.ts).
//
// What a click does when W (the trading wallet) holds too little HYPE on Elysium for the buy:
//   1. the deficit = the buy + W's gas on Elysium − W's HYPE there, priced at OUR HyperEVM WHYPE/USDC oracle, + a small margin;
//   2. ONE reserve R (USDG on Robinhood, USDC on BNB, USDC on Solana) that alone covers it pays motion's solver ONE stablecoin
//      transfer — this wallet's own reserves first; (release 8) when none of them can, a reserve of another wallet of the same
//      vault account whose USD-balance permission is live on that chain (the donor: R is the DONOR's reserve, W stays the
//      clicking wallet; the account allows that once, in the vault's own dialog — xwKeyOf). The solver pays W's SAME address on Elysium in HYPE (one Inbox.createRetryableTicket on HyperEVM,
//      every refund address = W). All or nothing: if no single reserve covers it within the per-fill cap, nothing moves;
//   3. the buy fires once the HYPE is in W (the solver's 'filled' = the Elysium credit, or W's balance read on Elysium).
// Money never parks on Elysium for its own sake: only this click's deficit (+ margin) moves, because the way back out through
// the canonical bridge takes ~6 days. The first such move of an account shows a one-time notice in the vault (ELY_NOTICE).
// (release 6, owner 2026-11-04) motion's fee on every move into Elysium: 0.1 % of the amount, at least $0.01 (ELY_FEE). The user receives
// the amount less the fee; a click moves its deficit + margin + the fee, so the HYPE that arrives still covers the buy.
import { bridgeCfg, stableToUsd6, usd6ToStable, USD6, feeOf6, type BridgeChain } from './motionBridgeCore.ts';

export type ElySource = 'robinhood' | 'bsc' | 'sol';
export const ELY_SOURCES: readonly ElySource[] = ['robinhood', 'bsc', 'sol'];

export const ELY_USD = Object.freeze({
  // over the HYPE the buy needs: the solver's payout may be 1.5 % under OUR price (maxSlipBps below) and HYPE may move between
  // the quote and the buy; whatever is left over stays in W on Elysium as HYPE (the user's own address)
  marginBps: 300,
  // what W keeps on Elysium for the buy's own gas (and a later sell's approve + permit + sell): 0.002 HYPE ≈ $0.2 at $90.
  // The engine refuses any Elysium transaction above 0.05 HYPE of gas (elysiumCore ELY_MAX_FEE_WEI); a swap costs ~0.00004
  gasWei: 2_000_000_000_000_000n,
  minMove6: USD6,                    // below $1 a move is not worth a bridge fill; it is rounded up to $1
  maxFill6: 250n * USD6,             // the vault's own ceiling for ONE Elysium fill, whatever the solver offers
  maxSlipBps: 150,                   // the payout vs OUR HyperEVM price (the same bound as "Add funds on Elysium")
  waitMs: 25_000,                    // how long a click waits for the HYPE before it answers 'moving' (the move goes on)
  pollMs: 600,
  noticeVersion: 1,
});

// ── (release 6) motion's fee into Elysium: 0.1 %, at least $0.01 — the MOST the vault accepts (server: elysiumFeeFromEnv) ──
export type ElyFee = { bps: number; min6: bigint };
export const ELY_FEE: Readonly<ElyFee> = Object.freeze({ bps: 10, min6: USD6 / 100n });
/** the fee the solver publishes (/health elysium.fee), never above ELY_FEE on either term; absent or unreadable = ELY_FEE */
export function elyFeeOf(h: { bps?: unknown; minUsd?: unknown } | null | undefined): ElyFee {
  const b = Number(h?.bps), m = Number(h?.minUsd);
  if (!h || !Number.isInteger(b) || b < 0 || !Number.isFinite(m) || m < 0) return { ...ELY_FEE };
  const min6 = BigInt(Math.round(m * 1e6));
  return { bps: Math.min(b, ELY_FEE.bps), min6: min6 < ELY_FEE.min6 ? min6 : ELY_FEE.min6 };
}
/** the fee on `usd6` dollars that leave (feeOf6: bps of it, at least min6, never more than it) */
export const elyFee6 = (usd6: bigint, fee: ElyFee = ELY_FEE): bigint => feeOf6(usd6, fee.bps, fee.min6);
/** the dollars that must leave so that at least `net6` arrives after the fee */
export function grossForNet6(net6: bigint, fee: ElyFee = ELY_FEE): bigint {
  if (!(net6 > 0n) || fee.bps <= 0) return net6 > 0n ? net6 : 0n;
  const bps = BigInt(fee.bps);
  const prop = (net6 * bps + (10_000n - bps) - 1n) / (10_000n - bps);   // ceil(net × bps / (10 000 − bps)): the fee on the whole
  let g = net6 + (prop > fee.min6 ? prop : fee.min6);
  while (g - elyFee6(g, fee) < net6) g += 1n;
  while (g > net6 && g - 1n - elyFee6(g - 1n, fee) >= net6) g -= 1n;   // the smallest such amount (the fee rounds down)
  return g;
}
/** a quote charging more than the vault's own bound (ELY_FEE on the amount that leaves) signs nothing */
export const elyFeeTooHigh = (fee6: bigint, usd6: bigint): boolean => fee6 > elyFee6(usd6, ELY_FEE);
/** "0.1 %" — what every screen says, and nothing else */
export const elyFeeText = (fee: ElyFee = ELY_FEE): string => `${(fee.bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`;

// ── the exit time the one-time notice states (read on chain, read-only, 2026-11-04 11:38 UTC) ──
// Rollup 0x508c…d217 on HyperEVM: confirmPeriodBlocks() = 483,840; chainId() = 99901; minimumAssertionPeriod() = 75 blocks.
// HyperEVM block time over the last 200,000 blocks = 0.9836 s → the challenge period = 132.2 h = 5.51 days. Assertions are
// posted about every 12 h (research.txt: 38 assertions, 06:04 / 18:04 UTC), so a withdrawal waits for the next assertion and
// then its 5.51 days: 5.5–6.0 days, plus the claim (motion claims it). 155 real exits were paid 5.96–6.56 days after they were
// sent (elysiumExitCore EXIT_READY_MS = 6.6 days). Kinetiq's docs and Arbitrum's: "about 6 days" / one challenge period.
export const ELY_EXIT_TIME = Object.freeze({
  confirmPeriodBlocks: 483_840,
  parentBlockMs: 984,                // HyperEVM, measured
  assertionEveryMs: 12 * 3_600_000,
  readyMaxMs: Math.round(6.6 * 86_400_000),
  docs: 'https://elysium.kinetiq.xyz/docs/bridging-hyperevm-tokens-to-elysium',
});
export const challengeMs = (): number => ELY_EXIT_TIME.confirmPeriodBlocks * ELY_EXIT_TIME.parentBlockMs;   // 476,098,560 ms = 5.51 d
/** a withdrawal started at `now`: the earliest it can be claimed, and the date by which it normally is */
export function exitWindow(now: number): { earliest: number; latest: number } {
  return { earliest: now + challengeMs(), latest: now + Math.max(challengeMs() + ELY_EXIT_TIME.assertionEveryMs, ELY_EXIT_TIME.readyMaxMs) };
}

export const ELY_LANGS = ['en', 'ru', 'zh', 'id', 'es', 'fr'] as const;
export type ElyLang = typeof ELY_LANGS[number];
export const elyLangOf = (v: unknown): ElyLang => ((ELY_LANGS as readonly unknown[]).includes(v) ? v as ElyLang : 'en');
const LOCALE: Record<ElyLang, string> = { en: 'en-GB', ru: 'ru-RU', zh: 'zh-CN', id: 'id-ID', es: 'es-ES', fr: 'fr-FR' };
/** "Tue 10 Nov" in the user's language, UTC (the same day everywhere a user might read it within a few hours) */
export function fmtExitDay(ms: number, lang: ElyLang): string {
  try { return new Date(ms).toLocaleDateString(LOCALE[lang], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

/** (release 6) the one line every Elysium funding screen shows: the way out is the official bridge, about 6 days (no fast exit) */
export const ELY_LEAVE_LINE: Record<ElyLang, string> = {
  en: 'Leaving Elysium goes through the official bridge and takes about 6 days.',
  ru: 'Вывод из Elysium идёт через официальный мост и занимает около 6 дней.',
  zh: '离开 Elysium 需通过官方跨链桥，约需 6 天。',
  id: 'Keluar dari Elysium melalui jembatan resmi dan memakan waktu sekitar 6 hari.',
  es: 'Salir de Elysium se hace por el puente oficial y tarda unos 6 días.',
  fr: 'Quitter Elysium passe par le pont officiel et prend environ 6 jours.',
};
/** (release 6) "Fee 0.1 %" in the six languages */
export const ELY_FEE_LINE: Record<ElyLang, (pct: string) => string> = {
  en: (p) => `Fee ${p}`, ru: (p) => `Комиссия ${p}`, zh: (p) => `手续费 ${p}`, id: (p) => `Biaya ${p}`, es: (p) => `Comisión ${p}`, fr: (p) => `Frais ${p}`,
};
export type ElyNotice = { title: string; ok: string; lines: string[] };
/**
 * The one-time notice (vault dialog; "I understand" stored per account). States: in = seconds, out = ~6 days with the dates of a
 * withdrawal started now, that only the buy's own HYPE moves, and that the bridge can be upgraded without a delay.
 */
export function noticeOf(now: number, lang: ElyLang = 'en'): ElyNotice {
  const w = exitWindow(now), a = fmtExitDay(w.earliest, lang), b = fmtExitDay(w.latest, lang);
  const T: Record<ElyLang, ElyNotice> = {
    en: { title: 'Buying on Elysium with your USD balance', ok: 'I understand', lines: [
      'motion moves the dollars this buy needs from your USD balance to HYPE in this same wallet on Elysium, for a fee of 0.1 % (at least $0.01). That takes seconds, sometimes a minute or two.',
      `Moving money back OUT of Elysium through the official Elysium → HyperEVM bridge takes about 6 days: the rollup's challenge period (483,840 HyperEVM blocks ≈ 5.5 days, per Kinetiq's and Arbitrum's docs) plus up to 12 hours until the next assertion. Started now, a withdrawal is ready between ${a} and ${b}; motion claims it for you.`,
      'Only what each buy needs moves (plus about 3 % and a little HYPE for gas); a coin you sell on Elysium pays HYPE that stays on Elysium.',
      'Elysium\'s bridge can be upgraded by Kinetiq\'s 4-of-11 multisig without a delay.',
    ] },
    ru: { title: 'Покупки на Elysium с USD-баланса', ok: 'Понятно', lines: [
      'motion переводит нужные этой покупке доллары с USD-баланса в HYPE на этом же кошельке в Elysium, комиссия 0,1 % (не меньше $0,01). Это занимает секунды, иногда минуту-две.',
      `Вывести деньги ОБРАТНО из Elysium через официальный мост Elysium → HyperEVM — около 6 дней: challenge period роллапа (483 840 блоков HyperEVM ≈ 5,5 дня, по документации Kinetiq и Arbitrum) плюс до 12 часов до следующего assertion. Вывод, начатый сейчас, будет готов между ${a} и ${b}; motion заберёт его за вас.`,
      'Переводится только то, что нужно каждой покупке (плюс около 3 % и немного HYPE на газ); продажа монеты на Elysium приносит HYPE, который остаётся в Elysium.',
      'Мост Elysium может обновить мультисиг Kinetiq 4-из-11 без задержки.',
    ] },
    zh: { title: '用 USD 余额在 Elysium 上购买', ok: '我明白了', lines: [
      'motion 会把本次购买所需的美元从你的 USD 余额换成 HYPE，转入你在 Elysium 上的同一钱包，手续费 0.1%（至少 $0.01）。通常几秒，有时一两分钟。',
      `通过官方 Elysium → HyperEVM 桥把资金转出 Elysium 约需 6 天：rollup 挑战期（483,840 个 HyperEVM 区块 ≈ 5.5 天，见 Kinetiq 与 Arbitrum 文档）加上最多 12 小时等待下一个 assertion。现在发起的提现将在 ${a} 至 ${b} 之间可领取；motion 会替你领取。`,
      '每次只转本次购买所需（约多 3% 和少量 HYPE 作为 gas）；在 Elysium 卖出代币得到的 HYPE 仍留在 Elysium。',
      'Elysium 的桥可由 Kinetiq 的 4/11 多签无延迟升级。',
    ] },
    id: { title: 'Membeli di Elysium dengan saldo USD', ok: 'Saya mengerti', lines: [
      'motion memindahkan dolar yang dibutuhkan pembelian ini dari saldo USD Anda menjadi HYPE di dompet yang sama di Elysium, dengan biaya 0,1 % (minimal $0,01). Butuh beberapa detik, kadang satu-dua menit.',
      `Menarik dana KELUAR dari Elysium lewat jembatan resmi Elysium → HyperEVM butuh sekitar 6 hari: masa tantangan rollup (483.840 blok HyperEVM ≈ 5,5 hari, menurut dokumen Kinetiq dan Arbitrum) ditambah hingga 12 jam menunggu assertion berikutnya. Dimulai sekarang, penarikan siap antara ${a} dan ${b}; motion mengklaimnya untuk Anda.`,
      'Hanya yang dibutuhkan tiap pembelian yang dipindahkan (plus sekitar 3 % dan sedikit HYPE untuk gas); koin yang Anda jual di Elysium menghasilkan HYPE yang tetap di Elysium.',
      'Jembatan Elysium dapat diperbarui oleh multisig 4-dari-11 Kinetiq tanpa jeda.',
    ] },
    es: { title: 'Comprar en Elysium con tu saldo en USD', ok: 'Entendido', lines: [
      'motion mueve los dólares que necesita esta compra de tu saldo en USD a HYPE en esta misma cartera en Elysium, con una comisión del 0,1 % (mínimo 0,01 $). Tarda segundos, a veces uno o dos minutos.',
      `Sacar dinero de Elysium por el puente oficial Elysium → HyperEVM tarda unos 6 días: el periodo de impugnación del rollup (483.840 bloques de HyperEVM ≈ 5,5 días, según la documentación de Kinetiq y Arbitrum) más hasta 12 horas hasta la siguiente aserción. Iniciado ahora, un retiro estará listo entre el ${a} y el ${b}; motion lo reclama por ti.`,
      'Solo se mueve lo que necesita cada compra (más un 3 % y un poco de HYPE para gas); una moneda que vendas en Elysium paga HYPE que se queda en Elysium.',
      'El puente de Elysium puede actualizarlo la multifirma 4 de 11 de Kinetiq sin demora.',
    ] },
    fr: { title: 'Acheter sur Elysium avec votre solde USD', ok: 'J’ai compris', lines: [
      'motion convertit les dollars nécessaires à cet achat depuis votre solde USD en HYPE, dans ce même portefeuille sur Elysium, avec des frais de 0,1 % (au moins 0,01 $). Cela prend quelques secondes, parfois une ou deux minutes.',
      `Retirer de l’argent d’Elysium par le pont officiel Elysium → HyperEVM prend environ 6 jours : la période de contestation du rollup (483 840 blocs HyperEVM ≈ 5,5 jours, selon la documentation de Kinetiq et d’Arbitrum) plus jusqu’à 12 heures avant la prochaine assertion. Lancé maintenant, un retrait est prêt entre le ${a} et le ${b} ; motion le réclame pour vous.`,
      'Seul ce dont chaque achat a besoin est déplacé (plus environ 3 % et un peu de HYPE pour le gaz) ; une pièce vendue sur Elysium rapporte des HYPE qui restent sur Elysium.',
      'Le pont d’Elysium peut être mis à jour par le multisig 4-sur-11 de Kinetiq sans délai.',
    ] },
  };
  return T[lang];
}
/** the record "I understand" leaves in the vault, per account (the account's main address, or this device without one) */
export type ElyAck = { v: 1; notice: number; at: number; account: string };
export const ACK_PREFIX = 'trenches.ely-usd.ack.v1.';
export const ackKeyOf = (account: string | null | undefined): string => ACK_PREFIX + (account && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : 'device');
export function ackOk(raw: string | null | undefined, account: string | null | undefined, version: number = ELY_USD.noticeVersion): boolean {
  try {
    const a = JSON.parse(String(raw || 'null')) as ElyAck | null;
    if (!a || a.v !== 1 || a.notice !== version || !Number.isFinite(a.at) || a.at <= 0) return false;
    const want = account && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : 'device';
    return String(a.account) === want;
  } catch { return false; }
}

// ── (release 8) a buy funded from ANOTHER wallet of the account: the vault's own dialog, once per account ──
// The USD-balance permission (float.configure) is "a standing permission per wallet to move money between that wallet and its
// own reserve". A reserve paying a DIFFERENT wallet of the same account is not in that text, so the first such move asks once in
// the vault's dialog, naming the paying wallet and the amount; "Allow" is stored per account (like the notice). Declined =
// nothing moved. It allows nothing else: the payout still goes only to the clicking wallet W, from a reserve whose own
// permission is live on that chain.
export type ElyXwAck = { v: 1; at: number; account: string };
export const XW_PREFIX = 'trenches.ely-usd.xw.v1.';
export const xwKeyOf = (account: string | null | undefined): string => XW_PREFIX + (account && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : 'device');
export function xwOk(raw: string | null | undefined, account: string | null | undefined): boolean {
  try {
    const a = JSON.parse(String(raw || 'null')) as ElyXwAck | null;
    if (!a || a.v !== 1 || !Number.isFinite(a.at) || a.at <= 0) return false;
    const want = account && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : 'device';
    return String(a.account) === want;
  } catch { return false; }
}

// ── the plan ──
export type ElyReserve = {
  chain: ElySource; stable: bigint | null; native: bigint | null; address: string;
  // (release 8) whose reserve this is. Absent / own !== false = the clicking wallet's own (the only kind before release 8; its
  // chains are the input's `chains`). Another wallet's reserve (own: false) names that wallet and carries the chains of THAT
  // wallet's live USD-balance permission: it is a donor only on those, and never without a walletId
  walletId?: string; name?: string; own?: boolean; chains?: readonly string[];
  // (release 8) Earn's ready part on this reserve, micro-dollars (cached, read only): never moved by an Elysium click — a refusal
  // says how much to take out of Earn first
  earnReady6?: bigint | null;
};
/** (release 8) where the money of a refused click could come from: the largest single reserve of the account */
export type ElyBest = { walletId: string; name: string; chain: ElySource; usd6: bigint };
export type ElyHealth = { on: boolean; chains: string[]; maxFill6: bigint; minFill6: bigint; paused: boolean; why?: string; hasDeposit: (c: ElySource) => boolean; fee?: ElyFee };
export type ElyPlanInput = {
  buyWei: bigint;                    // the HYPE this buy spends (the ticket's size)
  wHype: bigint | null;              // W's HYPE on Elysium (null = not read)
  price6: bigint;                    // OUR HYPE price (HyperEVM WHYPE/USDC pool), micro-dollars per HYPE
  reserves: ElyReserve[];            // this wallet's reserves (null = that read failed); (release 8) + the account's other wallets'
  chains: readonly string[];         // the chains of THIS wallet's USD-balance permission (a reserve outside it is never a donor)
  self?: { walletId: string; name: string };   // (release 8) the clicking wallet: the refusal's "best" when it is its own reserve
  health: ElyHealth;
};
export type ElyRefusal = 'not-read' | 'no-price' | 'bridge-off' | 'paused' | 'over-cap' | 'short' | 'split';
export type ElyPlan =
  | { kind: 'covered' }
  | { kind: 'move'; from: ElySource; usd6: bigint; amountIn: bigint; deficitWei: bigint; gasOk: boolean; donor?: { walletId: string; name: string; chain: ElySource } }
  | { kind: 'refused'; code: ElyRefusal; why: string; canUsd6?: bigint; usd6?: bigint; best?: ElyBest | null; account6?: bigint; earn?: ElyBest | null };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** dollars (micro) of `wei` HYPE at price6, rounded UP */
export const hypeToUsd6Up = (wei: bigint, price6: bigint): bigint => ceilDiv(wei * price6, 10n ** 18n);
/** the gas a reserve needs for its ONE transfer to the solver (an EVM ERC-20 transfer ~120k gas; a Solana SPL transfer + memo) */
export const RESERVE_GAS_MIN: Record<ElySource, bigint> = { robinhood: 20_000_000_000_000n, bsc: 100_000_000_000_000n, sol: 1_000_000n };

export function planElyClick(x: ElyPlanInput): ElyPlan {
  if (x.wHype === null) return { kind: 'refused', code: 'not-read', why: 'This wallet\'s HYPE on Elysium could not be read — nothing was moved' };
  const needWei = x.buyWei + ELY_USD.gasWei;
  if (x.wHype >= needWei) return { kind: 'covered' };
  if (!(x.price6 > 0n)) return { kind: 'refused', code: 'no-price', why: 'No fresh HYPE price — nothing was moved' };
  if (!x.health.on || !x.health.chains.includes('elysium')) return { kind: 'refused', code: 'bridge-off', why: 'motion\'s bridge does not serve Elysium right now — nothing was moved' };
  if (x.health.paused) return { kind: 'refused', code: 'paused', why: 'Elysium funding is paused: ' + String(x.health.why || 'the official bridge changed').slice(0, 120) + ' — nothing was moved' };
  const deficitWei = needWei - x.wHype;
  // the deficit + the margin, then motion's fee on the whole (release 6: what arrives after the fee still covers the buy)
  let usd6 = grossForNet6((hypeToUsd6Up(deficitWei, x.price6) * BigInt(10_000 + ELY_USD.marginBps)) / 10_000n, x.health.fee ?? ELY_FEE);
  usd6 = ceilDiv(usd6, 10_000n) * 10_000n;                                   // whole cents
  const floor6 = x.health.minFill6 > ELY_USD.minMove6 ? x.health.minFill6 : ELY_USD.minMove6;
  if (usd6 < floor6) usd6 = floor6;
  const cap6 = x.health.maxFill6 > 0n && x.health.maxFill6 < ELY_USD.maxFill6 ? x.health.maxFill6 : ELY_USD.maxFill6;
  if (usd6 > cap6) return { kind: 'refused', code: 'over-cap', why: `A buy on Elysium from the USD balance moves at most ${fmt6(cap6)} at a time — this one needs ${fmt6(usd6)}. Nothing was moved`, usd6, canUsd6: cap6 };
  // donors: a reserve of a live permission on its chain, read, served by the solver, holding the whole amount (one fill, all or
  // nothing). (release 8) This wallet's own reserves first, exactly as before; only when none of them can pay, the reserves of
  // the account's OTHER wallets (each on the chains of ITS OWN live permission), ranked the same way, then by the larger balance
  type Cand = { r: ElyReserve; usd: bigint; gasOk: boolean };
  const own: Cand[] = [], other: Cand[] = [];
  let best: { r: ElyReserve; usd: bigint } | null = null, earn: { r: ElyReserve; usd: bigint } | null = null, sum6 = 0n;
  for (const r of x.reserves) {
    const mine = r.own !== false;
    const chains = mine ? x.chains : r.chains;
    if (!mine && (!r.walletId || r.walletId === x.self?.walletId)) continue;
    if (!chains || !chains.includes(r.chain) || r.stable === null || !x.health.chains.includes(r.chain) || !x.health.hasDeposit(r.chain)) continue;
    const have6 = stableToUsd6(r.stable, bridgeCfg(r.chain as BridgeChain).stable.decimals);
    sum6 += have6; if (have6 > 0n && (!best || have6 > best.usd)) best = { r, usd: have6 };
    if (have6 >= usd6) (mine ? own : other).push({ r, usd: have6, gasOk: r.native !== null && r.native >= RESERVE_GAS_MIN[r.chain] });
    // Earn's ready part would make this reserve whole: the refusal names the smallest such top-up out of Earn
    else if (r.earnReady6 && r.earnReady6 > 0n && have6 + r.earnReady6 >= usd6 && (!earn || usd6 - have6 < earn.usd)) earn = { r, usd: usd6 - have6 };
  }
  // a reserve that can pay its own gas first; then the cheapest, fastest source: Robinhood, BNB, Solana (ELY_SOURCES order)
  const order = (a: Cand, b: Cand) => (a.gasOk === b.gasOk ? ELY_SOURCES.indexOf(a.r.chain) - ELY_SOURCES.indexOf(b.r.chain) : a.gasOk ? -1 : 1);
  own.sort(order);
  other.sort((a, b) => order(a, b) || (b.usd > a.usd ? 1 : b.usd < a.usd ? -1 : 0));
  const pick = own[0] ?? other[0];
  if (!pick) {
    // (release 8) never a dead end: the largest single reserve of the account (the app offers "Buy from <that wallet>"), the
    // account's total, and Earn's part when taking it out would make one reserve whole
    const who = (o: { r: ElyReserve; usd: bigint } | null): ElyBest | null => (!o ? null : o.r.own !== false
      ? { walletId: x.self?.walletId ?? '', name: x.self?.name ?? 'this wallet', chain: o.r.chain, usd6: o.usd }
      : { walletId: o.r.walletId!, name: o.r.name || 'another wallet', chain: o.r.chain, usd6: o.usd });
    const b = who(best), e = who(earn);
    const bestText = b ? ` (best: ${b.name}, ${fmt6(b.usd6)} on ${NET_NAME[b.chain]})` : '';
    const earnText = e ? `; ${fmt6(ceilDiv(e.usd6, 10_000n) * 10_000n)} more is in Earn on ${NET_NAME[e.chain]} (${e.name}) — take it out first` : '';
    const tail = { usd6, canUsd6: b ? b.usd6 : 0n, best: b, account6: sum6, earn: e };
    if (sum6 >= usd6) return { kind: 'refused', code: 'split', why: `Your wallets' USD balance holds ${fmt6(sum6)}, but no single wallet holds the ${fmt6(usd6)} this buy needs on Elysium on one network${bestText}${earnText} — nothing was moved`, ...tail };
    return { kind: 'refused', code: 'short', why: `This buy needs ${fmt6(usd6)} on Elysium; none of your wallets' USD balance holds that on one network${bestText}${earnText} — nothing was moved`, ...tail };
  }
  const plan: Extract<ElyPlan, { kind: 'move' }> = { kind: 'move', from: pick.r.chain, usd6, amountIn: usd6ToStable(usd6, bridgeCfg(pick.r.chain as BridgeChain).stable.decimals), deficitWei, gasOk: pick.gasOk };
  // (release 8) another wallet pays: the plan names it (the runner derives that wallet's reserve itself and re-checks its permission)
  if (pick.r.own === false) plan.donor = { walletId: pick.r.walletId!, name: pick.r.name || 'another wallet', chain: pick.r.chain };
  return plan;
}
export const NET_NAME: Record<ElySource, string> = { robinhood: 'Robinhood', bsc: 'BNB', sol: 'Solana' };
export function fmt6(u: bigint): string {
  const c = (u + 5_000n) / 10_000n;          // cents, rounded
  return '$' + (c / 100n).toLocaleString('en-US') + '.' + String(c % 100n).padStart(2, '0');
}

// ── the job: one per wallet at a time, kept in the vault's storage before the transfer is signed ──
// planned (quote in hand) → signing → sent (the solver has the bytes) → arriving (paid on HyperEVM / landed) → done (credited)
// | refunded | refused (nothing of the user's moved) | unknown (bytes may be out: FOLLOWED, never signed again).
export type ElyJobState = 'planned' | 'signing' | 'sent' | 'arriving' | 'unknown' | 'done' | 'refunded' | 'refused' | 'failed';
export const ELY_JOB_OPEN: readonly ElyJobState[] = ['planned', 'signing', 'sent', 'arriving', 'unknown'];
export const ELY_JOB_KEY = 'trenches.ely-usd.job.v1.';
export type ElyJob = {
  v: 1; id: string; walletId: string; w: string; from: ElySource; usd6: string; amountIn: string; outWei: string;
  state: ElyJobState; at: number; updatedAt: number; srcHash?: string; dstHash?: string; refundHash?: string; error?: string;
  // (release 8) another wallet's reserve paid: R = that wallet's (payer), and a refund goes back there (the solver refunds the depositor)
  donorId?: string; donorName?: string; payer?: string;
};
export const jobOpen = (j: ElyJob | null | undefined): boolean => !!j && (ELY_JOB_OPEN as readonly string[]).includes(j.state);
/** the solver's fill state → the job's (motionBridgeCore FillState). 'filled' only on the Elysium credit (H-F1). */
export function jobStateOf(solverState: string, prev: ElyJobState): ElyJobState {
  switch (solverState) {
    case 'filled': return 'done';
    case 'refunded': return 'refunded';
    case 'expired': return prev === 'planned' || prev === 'signing' ? 'refused' : prev;   // an unused quote; a sent one is followed
    case 'failed': return 'failed';
    case 'landed': case 'paid': case 'paying': return 'arriving';
    case 'refunding': case 'source-sent': case 'source-late': case 'source-included': case 'bound': return prev === 'unknown' ? 'unknown' : 'sent';
    case 'quoted': return prev;
    default: return prev;
  }
}
/** a job read back from storage, checked field by field (a malformed one counts as none — never as "nothing is open" when it is) */
export function jobFrom(raw: string | null | undefined): ElyJob | null {
  try {
    const j = JSON.parse(String(raw || 'null')) as ElyJob | null;
    if (!j || j.v !== 1 || !/^[0-9a-f]{32}$/.test(String(j.id)) || !ELY_SOURCES.includes(j.from)) return null;
    if (!['planned', 'signing', 'sent', 'arriving', 'unknown', 'done', 'refunded', 'refused', 'failed'].includes(j.state)) return null;
    return j;
  } catch { return null; }
}
/** a job stuck open this long is shown as "delayed — nothing is lost" (the solver redeems / refunds on its side) */
export const ELY_DELAYED_MS = 10 * 60_000;

// (release 9, owner in chat 2026-11-05: «убрать лимиты, тогда текст останется верным») the paying wallet's permission caps that
// release 8 enforced here (perDay / feesPerDay / perChain / total, and their per-wallet day ledger) are gone: the consent says
// "no daily or volume limits", and the code says the same. What bounds a move is what the paying reserve holds, the live grant
// of that wallet and chain, one move per reserve at a time (its lock), the quote's checks and the vault's own per-move ceiling.

// ── "Add HYPE on Elysium" from the USD balance (the deposit screen): an explicit dollar amount, the same one-fill move ──
// (release 8: still this wallet's OWN reserves only — another wallet's reserve is a donor for a buy's deficit, never for a deposit)
export type ElyDepositInput = { usd6: bigint; from: ElySource | null; reserves: ElyReserve[]; chains: readonly string[]; health: ElyHealth };
export function planElyDeposit(x: ElyDepositInput): ElyPlan {
  if (!x.health.on || !x.health.chains.includes('elysium')) return { kind: 'refused', code: 'bridge-off', why: 'motion\'s bridge does not serve Elysium right now — nothing was moved' };
  if (x.health.paused) return { kind: 'refused', code: 'paused', why: 'Elysium funding is paused: ' + String(x.health.why || 'the official bridge changed').slice(0, 120) + ' — nothing was moved' };
  const usd6 = (x.usd6 / 10_000n) * 10_000n;                                   // whole cents
  const floor6 = x.health.minFill6 > ELY_USD.minMove6 ? x.health.minFill6 : ELY_USD.minMove6;
  if (usd6 < floor6) return { kind: 'refused', code: 'short', why: `The smallest move to Elysium is ${fmt6(floor6)}`, usd6, canUsd6: floor6 };
  const cap6 = x.health.maxFill6 > 0n && x.health.maxFill6 < ELY_USD.maxFill6 ? x.health.maxFill6 : ELY_USD.maxFill6;
  if (usd6 > cap6) return { kind: 'refused', code: 'over-cap', why: `At most ${fmt6(cap6)} moves to Elysium at a time`, usd6, canUsd6: cap6 };
  let best6 = 0n;
  const ok = x.reserves.filter((r) => {
    if (r.own === false || (x.from && r.chain !== x.from) || !x.chains.includes(r.chain) || r.stable === null || !x.health.chains.includes(r.chain) || !x.health.hasDeposit(r.chain)) return false;
    const have6 = stableToUsd6(r.stable, bridgeCfg(r.chain as BridgeChain).stable.decimals); if (have6 > best6) best6 = have6;
    return have6 >= usd6;
  }).map((r) => ({ r, gasOk: r.native !== null && r.native >= RESERVE_GAS_MIN[r.chain] }))
    .sort((a, b) => (a.gasOk === b.gasOk ? ELY_SOURCES.indexOf(a.r.chain) - ELY_SOURCES.indexOf(b.r.chain) : a.gasOk ? -1 : 1));
  if (!ok.length) return { kind: 'refused', code: 'short', why: `${x.from ? 'That network of your USD balance' : 'No network of your USD balance'} holds ${fmt6(usd6)} — ${fmt6(best6)} can go`, usd6, canUsd6: best6 };
  return { kind: 'move', from: ok[0].r.chain, usd6, amountIn: usd6ToStable(usd6, bridgeCfg(ok[0].r.chain as BridgeChain).stable.decimals), deficitWei: 0n, gasOk: ok[0].gasOk };
}
