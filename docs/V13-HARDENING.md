# V13 hardening — the live-vault findings of the 2026-10-25 audit, and the engine speed items

Branch `v13-hardening`, based on `main` 389fe5b (V12, the live engine `iwpFL7OJ`). **Not released, not pushed, not
pinned in trench.** The release is the owner's command (`scripts/vault-release.mjs` from trench, per `docs/PROJECT.md` §5/§6).

Sources: trench `docs/drafts/SECURITY-AUDIT-2026-10-25.md` §3 (VA-1 … VA-13), `docs/drafts/SPEED-AUDIT-2026-10.md` (rows marked
ENGINE), `B:\tmp\speed-audit\engine-trade-path.md` (gaps G1–G17).

**Owner's rule: no fix may slow trading.** Every row below gives the sequential round trips (RT) on the click before → after.
"Beside X" = issued in the same tick as X, so it costs no RT of its own.

The pure decisions live in `src/v13Guards.ts` (no browser globals), so the tests run the same predicates the engine runs.

Tests: `node --experimental-strip-types --test test/*.mjs` → **137 / 137** in 16 files (V12: 106 in 13). `npx tsc --noEmit`
→ only the known `src/lighter/wasmExec.js` baseline. `npm run build:engine` → `server/web/vendor/engine.js` 745 592 bytes
(gzip 241 kB; V12 730 910), `sha384-z2w04P6Z/mSVLF3PBFnqYmH+tcHtOerKPD0O3bKQqyz5t3eYPQaoYvpr/XpMibMY` at the commit
(gitignored, not pinned).

---

## 1. Findings

### VA-1 (Critical) — a compromised page sold every position into its own pool

**What changed.**

1. **The engine reads the route itself.** The frame fetches `/route` from the lane's own API on the origin that framed it
   (`/api/token/<a>/route` on Robinhood, `/bsc/api/…` on BNB). The frame CSP already allows this (`$ANCESTORS` in
   `connect-src`; the Solana frame already reads its routes this way), and CORS on `/api` is `*` (checked). The copy is
   stale-while-revalidate: it is served for up to 60 s and re-read in the background once it is 10 s old. The token
   page's prewarm (every 6 s) keeps it warm (`refreshOwnRoute`, `ownRouteNow`).
   - When the vault has a copy, **the page's hint is ignored** (a differing hint only triggers a re-read for the next click).
   - When it has none yet, the hint starts the click's reads, and the vault's own read (started at the same moment) is
     awaited before the first write, beside the on-chain `verifyRoute` (`vouchHint` / `vouchFor`):
     - equal: the click goes on;
     - different: that wallet re-runs on the vault's route (`RouteChanged`, a fresh click memo);
     - unreadable (motion's server down for the frame): only a route whose pool no page can choose is signed
       (`selfCanonical`): a launchpad curve or Standard (fixed by its registry), a V4 / Infinity pool on the gas token or
       its wrapped form (compared on chain, item 2), or a V2 path through known assets only. Bridge legs (a page-named fee
       tier), V3 tiers and USDG / stock pools are refused: fail closed.
2. **Hookless V4 / Infinity pools are compared on chain.** A hookless pool on the gas token or WETH/WBNB is the kind
   anyone can create with dust. It is quoted in the same multicall as the hookless pools of the same coin against both
   the gas token and its wrapped form, at the standard tiers:
   - V4: (100, 1), (500, 10), (3000, 60), (10000, 200);
   - Infinity: (100, 1), (500, 10), (2500, 50), (10000, 200).

   The hint stands within 2 % of the best. Otherwise the trade goes through the best pool, and the floor is that pool's
   quote (`pickFor` → `pickPool`). If the hinted pool does not quote and nothing else does, the trade is refused. Pools
   behind a known launcher hook (Pons, Long, DART, genius) are not compared. This holds even against a lying server.
3. **V2 sells through an asset the chain does not know** (a `[WBNB, X, coin]` path) need a danger dialog in the vault for
   that click. `tradeOne` refuses them without it.
4. **The BSC V3 tier guard fails closed.** A read failure used to let the sell through. It now runs beside the quote.
5. **Slippage a page may set without a click** is capped at 15 % (it was 22 %), or the level the user last confirmed in
   the vault. A raise above that is a danger dialog in `settingsSet`, and a stored value above it asks once at trade time.

**Tests.**
- `v13-guards-behavior.mjs`:
  - the page's copy of a route equals the server's; an attacker pool does not;
  - `selfCanonical` per venue;
  - the unknown-hop list;
  - the candidate keys;
  - `pickPool`: the attacker's dust pool loses to a real tier, a hint within 2 % stands, nothing quoted → refuse;
  - the slippage ceiling.
- `v13-source-pin.mjs`: the own-route fetch and its order, the vouch before the first write, the RouteChanged re-run, all
  four `pickFor` sites, the V2 dialog, the fail-closed guard, the `settingsSet` gate before `saveSettings`.

**Latency.**

| Case | Sequential RT |
|---|---|
| Warm vault copy (normal: prewarm keeps it) | **0 added**: the hint is not even needed |
| Cold copy | the own `/route` read (~50 ms warm on the server, memoised 3 s, and the page fetched it a moment earlier) runs **beside** the balance batch (57–74 ms): **0 added** in the measured case; it is bounded at 3 s |
| Hookless pool pick | **0 added**: the 8 candidates ride in the eth_call that carried the hint's own quote (a buy's starts at t=0) |
| Pick chose another pool | **+1 RT** (its own estimate) |
| Multi-wallet sell, wallets whose amount is not the largest, when another pool won | +1 RT |
| BSC V3 sell | **−1 RT** (the tier guard runs beside the quote) |

**Residual.**
- A lying server can still choose among canonical venues (the old threat (b)). It can no longer choose a hookless
  native / wrapped pool, since the comparison above runs regardless of who proposed the pool.
- Known-hook pools are trusted as in V12.
- The default 12 % slippage still bounds a sandwich of any canonical-pool sell at 12 %; lowering the default is the owner's
  product call.

### VA-2 (High) — the hourly buy limit could be zeroed

**What changed.**
- `trade()` validates the size before `tradeLimits` records or asks anything (`tradeSizeProblem`):
  - finite and positive;
  - a buy not above the lane maximum (100 ETH / BNB, 10 000 SOL, 1 000 000 NEAR);
  - a sell between 0 and 100 %;
  - a numeric string counts as its number.
- The ledger (`ledgerAdd`):
  - an entry is clamped to ≥ 0;
  - entries are pruned by age only;
  - past 500 entries the oldest fold into one entry that keeps their sum (500 × `buy(t, 0)` used to push the real entries
    out of `slice(-500)`).

**Tests.** `v13-guards-behavior.mjs`: `-1e300`, NaN, ±Infinity, 0, strings and oversize are refused; a stored negative counts
as 0; 600 zero buys keep the real total; age-only pruning. `v13-source-pin.mjs`: the order in `trade()`; no `slice(-500)` in
`recordBuy`.

**Latency.** 0 (local).

### VA-3 (High) — a lying server could redirect a bridge

**What changed.**
- `ownBridgeQuote` asks **api.relay.link itself** (`POST /quote/v2`; already in the frame's `connect-src`) for the user's
  depositor, the recipient the dialog confirms, the chains and the amount. The app fee is passed as explicit parameters
  pinned in the engine: `BRIDGE_APP_FEE` = `0xaBA7…40ad`, 50 bps, the server's defaults.
- Only that request id is signed, after `relayQuoteProblem` checks the answer: sender, recipient, `currencyIn.amount`,
  both chain ids, the deposit's chain and value (EVM), and the instruction list (Solana origin).
- motion's `/api/bridge/quote` is no longer used by the vault. `bridgeDeposit` / `solBridgeDeposit` still compare the step
  with a second keyless Relay quote, as before.
- Checked live on 2026-10-25: a keyless quote with `appFees` is accepted and charges the fee (`fees.app` = 50 bps).

**Tests.** `v13-guards-behavior.mjs` (another recipient, depositor, amount, chain or value is refused; a Solana origin is
checked case-sensitively); `v13-source-pin.mjs` (`ownBridgeQuote` calls Relay, never `/api/bridge/quote`, and runs before the
gate and the dialog).

**Latency.** Bridges are not on the trade path. The vault now calls Relay directly instead of motion → Relay: one hop fewer.

**Release checks.**
- **Confirm `BRIDGE_FEE_TO` / `BRIDGE_FEE_BPS` on prod equal the pinned values** (otherwise the fee goes to the pinned address).
- The keyless quote loses the `referrer: copytrade.gg` attribution, which needs Relay's API key.
- Relay's docs announce an API key for every `/quote/v2` from 2026-10-02. It was not enforced on 2026-10-25. Once it is,
  this quote and the existing `relayQuoteDirect` check fail closed, and bridges stop until Relay allows keyless quotes or a
  server-signed design replaces this.

### VA-4 (High) — `adopt()` treated page-supplied keys as the user's own

**What changed.** `adopt` follows the `import()` rule (F-23 / F-34):
- at most 200 items, parsed once by `readKeyOrNull`, all-or-nothing;
- every key is shown under the address it trades as (`sol:` / `near:` too), duplicates and already-present ones dropped;
- each key joins through `addAccount(…, { kind: 'imported', via: 'page' })`, so it is an outside address for transfers,
  and `consolidate()` into it needs the withdraw gate and a danger dialog;
- nothing else the page sent is taken (hop flag, meta / active / selected ids, settings, seeds, main / index).

trench `vault-client.js`'s legacy migration still works: it only checks that `summary().accounts` lists every address.

**Tests.** `v13-source-pin.mjs` (readKeyOrNull, the all-or-nothing error, `via: 'page'`, no `adoptAccounts`, no 0x-only
filter).

**Latency.** 0 (not on the trade path).

### VA-5 (High) — trusted-click dialogs could be clickjacked outside Chromium

**What changed.**
- IntersectionObserver v2 is detected (`IO_V2`). Where it is missing (Safari / iPhone, Firefox), a danger dialog shows a
  3-digit code drawn only inside the frame and accepts the click only when that code was typed (`needsChallenge`,
  `challengeCode`, `challengeOk`). A page cannot read a cross-origin frame, so a decoy cannot tell the user what to type.
  The two key-export dialogs get the same guard (`guard: true`) without the red button.
- There (no IntersectionObserver v2), a one-click dialog also ignores a click that comes less than 600 ms after it was
  drawn (`tooSoon`). A dialog the user types into is exempt: it cannot be confirmed blind anyway, and Chromium already
  checks visibility.
- In Chromium the dialog now counts as hidden until the observer's first reading. It started as "visible", so a click in
  the first ~100 ms passed before any reading arrived.

**Tests.** `v13-guards-behavior.mjs` (when the code is needed, its shape and check, the 600 ms dwell); `v13-source-pin.mjs`
(the wiring in `askChoice`, the two guarded exports).

**Latency.** Not on the trade path: buys under the cap and sells open no dialog. Outside Chromium a one-click dialog
cannot be confirmed in its first 600 ms.

### VA-6 / VA-7 (Medium) — Jupiter wSOL double count, Jupiter's price trusted

**Not applicable to this branch.** The Jupiter venue is only on `jupiter-quote-pairs` 9537cf8, which was rolled back on
2026-10-25. The live engine is `main`, which has no Jupiter code. `v13-source-pin.mjs` pins that `solEngine.ts` has none.

If Jupiter is re-released, it needs both fixes on its branch before it ships:
- VA-6: compare SOL + wSOL as one total;
- VA-7: cross-check `outAmount` against the curve / indexer price.

### VA-8 (Medium) — four.meme sells had no minimum

**What changed.**
- Sells call TokenManager2's floored overload `sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)`
  (selector `0x0da74935`) with `origin` 0. The floor is the helper's payout after its fee, 1 % under it, the slippage
  under that. The early gas proof is the same call with a zero floor, as on every other BNB venue; the preview runs the
  same floored call.
- Verified on 2026-10-25 by `eth_call` against the live implementation, with a state-override allowance (nothing signed):
  - a floor up to the helper's `funds` passes;
  - `2 × funds` reverts `Slippage`.
- **Found on the way:** TokenManager2 refuses an amount that is not a whole multiple of 1e9 (`GW`). V12's partial-percent
  four.meme sells (e.g. 10 %) therefore reverted. V13 rounds a four.meme sell amount down to a multiple of 1e9 (a full
  balance already is one).

**Tests.** `v13-venues-behavior.mjs` (the selector and the arguments); `v13-source-pin.mjs` (the ABI entry, the floored call,
no `sellToken(token, amount)` left, the 1e9 rounding).

**Latency.** 0 added: the sell is still `batch → [quote ‖ allowance ‖ early estimate] → send`, 3 RT.

### VA-9 (Medium) — Solana DLMM pools came only from the indexer

**What changed.** The vault finds a coin's Meteora pools against SOL on chain (`dlmmDiscover`):
- Permissionless pairs are PDAs `[preset_parameter2 PDA(index), min(mint, SOL), max(mint, SOL)]`. This was verified on
  2026-10-25 against both live pools of S&P500 (presets 14 and 124); 392 presets exist, and 400 are scanned.
- Plus the customizable pair `[ILM base, min, max]` and the oldest kind `[min, max, bin step]`.
- The ~420 candidate addresses are hashed in slices that yield the thread (~80 ms per coin, once per 10 min) and checked
  for existence in four `getMultipleAccounts` of 100 through the relay, with no account data. The pools that exist are
  read and verified by `dlmmPoolsOf` as before.

How the results are used:
- they join the server's list;
- a coin the server names nothing for waits for the search (it is the only list there is);
- otherwise it finishes in the background, a **sell waits for it** and a buy takes it once it is there;
- a failed search leaves the server's list (as V12).

**Tests.** `v13-venues-behavior.mjs` (the derived addresses include both live pools, no network); `v13-source-pin.mjs`.

**Latency.**
- Route load: 0 added (the search runs beside it).
- A sell right after a cold route waits for the search (~relay RTT 340–480 ms + ~80 ms); after a prewarm, 0.
- G7 below removes (k−1) RT from every DLMM click.

**Residual.** The trade still keeps the 3 deepest verified pools by SOL reserve (now up to 6 candidates with the
on-chain ones) and takes the best quote. An attacker who funds pools deeper than the real ones can still crowd that list.

### Low items touched

- VA-13: the hookless fee ceiling is unchanged. A dust pool at any fee now loses to the standard tiers (VA-1 item 2).
- VA-10 / 11 / 12 are unchanged (Jupiter not on this branch; fee bleed and the in-memory Solana hold are design choices).

---

## 2. Engine speed items (rows marked ENGINE in the speed audit)

| Gap | What changed | RT before → after (Fast, warm) |
|---|---|---|
| G1 | Solana tips / fee levels: a value < 60 s is served at once, refreshed in the background once > 5 s old. Blockhash re-read at 5 s on the hover. Route served < 60 s, re-read behind the click after 20 s | the ~420 ms expired-cache wait on 13–30 % of clicks → 0; route −58 ms pump / −220 ms DLMM on ~17 % |
| G3 | `tradeGuard` answers at submit; the per-wallet lock is kept until the receipt (F-43 unchanged) | the click's answer no longer waits for the receipt (RH −~100 ms "Chain"); a multi-wallet wave starts a confirmation earlier (SOL ~1.4–2.1 s, BNB 0.5–1.5 s per wave) |
| G4 | Robinhood Pons (gas-token pair) / V4 (gas token, WETH) / V3 (WETH) buys prove gas at t=0 with a zero floor; V4 / V3 sells prove it beside the quote; `simEarly` signs on that proof | Pons / V4 / V3 buy **3 → 2**; V4 / V3 sell **4 → 3** (armed wallet) |
| G5 | Jito: the first warm-up times 4 regions, afterwards the 2 fastest are pinged every 25 s while the lane is used; sends take regions fastest first; the EVM keep-hot loop does not run in SOL / NEAR frames | ~100 ms on the tipped Jito road; ~60 ms on the second road (no `ny` from Europe) |
| G7 | DLMM candidates quoted in parallel | DLMM 3 + (k−1) → **3** |
| G8 | Standard curve sell: allowance read in the first batch, gas proof beside the payout simulation | **5 → 3** |
| G10 | Pons stock-pair / Flap bridged sells: the pre-sell quote-asset balance in the first batch | −1 RT on those sells |
| G11 | viem batch window 16 ms → 0 | −16 ms per click and per receipt poll |
| G12 | BNB receipts asked of bloXroute / 48 Club first (publicnode refuses them) | −50–70 ms to "confirmed" on BNB |
| G14 | Solana confirm poll at 400 ms (was 700) for the first 10 s | ~200–300 ms earlier "confirmed" |
| G17 | The official Robinhood node never heads a heavy ring | ~55 ms for wallets 4–9 of a click |
| (VA-1) | BSC V3 sell: the tier guard beside the quote | **−1 RT** |

Expected (warm, 1 wallet), from the speed audit's measured RTs:
- Robinhood Fast Pons / V4 buy ≈ **160–250 ms** to submitted (was 230–330).
- BNB unchanged ≈ 150–170 ms.
- Solana Fast pump ≈ 190–205 ms with no 420 ms tail (G6 not done).

**Not measured on chain**: no real send was made (owner's rule). See §4.

**Not done, on purpose:**
- **G6** (Solana Fast without the simulation): a bad trade then costs fees instead of failing early. That is medium risk
  and a product decision for the owner.
- **G9** (sells sized from the polled balance before the fresh read): needs exact-wei balances in the poll and a
  mismatch path. It is a larger change, left for a measured pass.
- **G13 / G15 / G16 / G19** (parallel-signed BNB chains, builder roads, a Robinhood sequencer road): each needs real
  sends to verify, which only the owner makes.
- **G2** is server-only.

---

## 3. Tests

| File | Covers |
|---|---|
| `test/v13-guards-behavior.mjs` | VA-1 (route equality, selfCanonical, V2 hops, candidates, pickPool, slippage), VA-2, VA-3, VA-5 — behaviour of `src/v13Guards.ts` |
| `test/v13-venues-behavior.mjs` | VA-8 (four.meme floored overload encoding), VA-9 (on-chain DLMM pool derivation, offline) |
| `test/v13-source-pin.mjs` | the wiring of every fix and speed item in `webEngine.ts`, `solEngine.ts`, `bnbRouter.ts` |
| V12 pins updated (intent kept) | `evm-moves-v12-source-pin` F-70 (the window moved to v13Guards), `webengine-v12-source-pin` F-57 (the guard is started beside the quote), `solnear-source-pin` F-54 (parallel candidate quotes) |

**Real-browser runs of this build with trench's harnesses** (Chrome; the vault's production CSP; mocked nodes;
nothing signed against a chain). Logs are in `B:\motion-backups\v13-hardening\`.
- `E2E_ENGINE=<dev build of this branch> node scripts/vault-dialog-shots.mjs` → **340 PASS, 0 FAIL**: every vault dialog
  at 390 / 1280, import / export / restore / remove / phone access, backup across lanes.
  - A first run failed 2 checks and hung: the 600 ms dwell then applied in Chromium too, and the harness confirms dialogs
    instantly.
  - The dwell is now limited to non-Chromium one-click dialogs, as the audit's fix sketch says.
- `ENGINE_JS=<production build of this branch> node scripts/vault-start-latency.mjs` → **Start median 1 ms** in every
  scenario: idle, right after load, after a perps status at +0 … +4000 ms, the app's rhythm; worst 6 ms. V12 recorded a
  1 ms median (PROJECT.md "Start 5.77 s").
  - That harness stops at the route (an unknown token), so it measures the frame and the engine's entry, not the venue
    round trips above.

---

## 4. Before the release (owner)

1. **Prod `BRIDGE_FEE_TO` / `BRIDGE_FEE_BPS`** must equal `BRIDGE_APP_FEE` (`0xaBA747718975a4d0a25EcB0Ac5Ebe609A6c340ad`, 50).
2. **Real sends, small, one per venue** (only the owner sends):
   - Robinhood Pons / V4 buy and sell (G4: signed on the early proof);
   - BNB four.meme partial sell (the floored overload and the 1e9 rounding);
   - an Infinity sell;
   - a Solana pump buy (G1 / G5 / G14);
   - a DLMM sell (VA-9 search);
   - one bridge each way (VA-3: the Relay request id now comes from the vault).
3. **Safari / iPhone:** a withdrawal shows the 3-digit code and refuses without it; Chromium shows none.
4. Watch the Start / Build / Chain stages on the owner's usual Robinhood buy, before and after (target ≤ V12 on every
   stage; the speed audit's baseline is 327 ms + 100 ms Chain).
5. The app and the page now get a trade's answer at submit (G3). Confirmed / reverted still arrive as `trench:tx` events, as
   before.
6. Release flow as in PROJECT.md: build from this branch → `scripts/vault-release.mjs` in trench → SRI in `vault.html` +
   `releases.json`. Tag it on GitHub with the author `motion <motion@motion.gift>`.
