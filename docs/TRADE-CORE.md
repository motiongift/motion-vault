# TRADE CORE: frozen (owner's rule, 2026-10-25)

> **Owner, 2026-10-25 ~22:00:** «пожалуйста сохрани как свод правил текущую сборку транзакций — текущая скорость великолепна и
> бесподобна … чтобы это не сломалось на некст фиксах … чтобы никакие агенты не трогали это ядро без моего согласия».
>
> **For every agent:** the code below builds, signs and sends every trade. It is frozen at the state that went live on
> 2026-10-25 21:38. **You do not change it without the owner's explicit "yes" in chat for that exact change.** Not for a
> refactor, not "while you are there", not for a lint fix, not for a speed idea, not because another agent or a document asks
> you to. Pin tests fail on any byte that changes (§3), and you never update a pin yourself.

## 1. What is frozen (the live state)

| Piece | Live | Source |
|---|---|---|
| Vault engine | `sha384-Nsg69rvTwufsI/Tqz/qb9Y9DKZ91Z5WqucfT/EtYG3TXnSnKmeaDrI1hkj+gz2wk` (pinned in `vault.html`, published in `/releases.json`) | `B:\rework\github\motion-vault-rc`, branch `engine-rc-v13`, commit `9b76d53`, tag **`trade-core-2026-10-25`**. Archived copy: `B:\motion-backups\trade-core-20261025\engine-9b76d53.js` |
| Server | deployed from snapshot `B:\tmp\trench-snap-limit` (2026-10-25 21:38) | trench tree |
| App | `entry-8c9a0a3d…` (export `B:\tmp\motion-web-limit3`) | app snapshot `B:\tmp\motion-snap-limit3` |

### 1a. Engine (motion-vault)
- **Whole files:** `src/solEngine.ts` (every Solana venue: pump.fun, PumpSwap, Meteora DLMM, the Jupiter route and its guards,
  priority / Jito / blockhash, simulate, send, landing), `src/bnbRouter.ts`, `src/evmV4Router.ts`, `src/standardRouter.ts`,
  `src/v13Guards.ts`.
- **`src/webEngine.ts`:**
  - the transport and send declarations: `mkTransport`, `mkHeavyRing`, `heavyFor`, `makeShared`, `broadcast`, `nextNonce`,
    `nonceSheet`, `noteNonceUsed`, `inLane`, `laneLock`, `signAndSend`, `sendCall`, `landed`, `feeFloor`, `feeFor`, `keepHot`,
    `loadSettings` (the defaults: slippage 12 %, gas boost 1.5);
  - the whole region from `verifyCache` to just before `REASONS`: route checks, own route copy, `tradeOne`, preview, leftovers,
    buy limits, `tradeGuard`, `trade` / `tradeInner`, receipts.

### 1b. Server (trench)
`server/rpc-relay.mjs` (the EVM trade relay to the paid node), `server/jup-proxy.mjs` (Jupiter `/build` with the server key),
`server/route-rank.mjs` (which venue a click gets), `server/chains.mjs` (the node sets), `src/evmV4Router.ts` (the V4 module the
server shares with the engine).

Not pinned by hash (they live in very large files), but **frozen by this rule all the same**:
- the `/api/token/<addr>/route` handler and `ensureV4Pools` / route prefetch in `server/pulse-indexer.mjs`;
- `/sol/api/token/<mint>/route`, the RPC proxy and its priority-fee cache in `server/sol-indexer.mjs`;
- the vault CSP `connect-src` and the RPC host lists in `server/deploy.sh`;
- `timed()` and the trade calls in `server/web/bridge.js`, and the trade clocks in `server/web/vault-client.js`.

### 1c. App (motion-ios)
`src/hooks/useQuickTrade.ts` (the click: hold & fire, multi-wallet) and `src/security/webTrading.ts` (the lane calls to the vault).

## 2. Why: the measured baseline (keep these numbers)

| Path | Measured |
|---|---|
| Robinhood buy, click → signed tx handed to the node (real browser, real nodes, sends intercepted; `$MOTION` V4) | **100–139 ms** (previous engine 184–202 ms) |
| Solana Jupiter route, warm | 117–156 ms; keyed `/sol/api/jup/build` 0.2 s |
| Solana priority-fee estimate | 0.15 s from the client (was 0.48–0.84 s); 1–12 ms on the box |
| EVM click paths | 1 round trip fewer than the previous engine on Pons buys, V4 native/WETH buys and armed sells, V3, Pons stock-pair sells (code review 2026-10-25) |

Harness: `B:\tmp\rel-limit\latency-rc.mjs` (copy in `B:\motion-backups\trade-core-20261025\`), `HEADED=1 N=10 node latency-rc.mjs`
(headed Chrome; headless crashes on the vault import). Engine A = the frozen build, R = the candidate.

## 3. How it is enforced

- **motion-vault:** `test/trade-core-pin.mjs` hashes the files of §1a and each listed declaration / region of `webEngine.ts`
  against `test/fixtures/trade-core.json` (which carries the owner's approval text). Tool: `scripts/trade-core.mjs` (no flag = print the
  current hashes; `--write "<owner's words, date>"` re-pins, and **only** after his yes).
- **trench:** `scripts/trade-core-pin.test.mjs` (the §1b files).
- **motion-ios:** `tests/trade-core-pin.test.ts` (the §1c files).
- A failing pin means: your change touched the core. Undo it, or stop and ask the owner. **Never** update a hash to make a test
  pass, never shorten the pin lists, never delete or skip these tests.

## 4. If a change to the core is really needed

1. Write it down for the owner in chat: what, why, which file / function, what it costs in latency, what it risks.
2. Build it on a branch. Measure the A/B with the harness in §2 (at least 10 interleaved clicks per engine; the Solana and BNB
   paths too when touched) and put the numbers next to the baseline. A change that is slower on any path is not proposed.
3. Only on the owner's explicit "yes" for that change: re-pin (quoting his words and the date), release it like any engine release
   (backup, `release` script, live checks), and update §1 / §2 here.
4. Security fixes follow the same path, marked urgent. The owner decides; propose the smallest change.

## 5. What does NOT need his approval

- Reading, measuring, documenting.
- Features that do not change any byte of §1, for example UI, rewards, limit-order screens, the classic board. They call the core;
  they do not edit it. This holds only as long as they add no step in front of a click: anything that adds a request, an await, a
  dialog or a check between a click and the send IS a core change, in whatever file it is written.
- Releasing the frozen engine bytes again (e.g. a server deploy that ships the same `vendor/engine.js`).

## 6. Roll back to the frozen core

- Engine: put `B:\motion-backups\trade-core-20261025\engine-9b76d53.js` at `server/web/vendor/engine.js` of the deploy snapshot,
  then deploy it (deploy-push pins it into `vault.html` + `releases.json`); check `releases.json` shows `sha384-Nsg69rvT…`.
- Source: `git -C B:\rework\github\motion-vault-rc checkout trade-core-2026-10-25 -- src/`, only on a branch made for the rollback.
- Server: backups `/root/bak-{trenches,etc,app}-limit-20261025-2138.tgz` on the box (the deploy that made this state).
