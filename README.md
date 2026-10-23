# motion-vault

The in-browser vault and trading engine of [motion.gift](https://motion.gift), a non-custodial
trading terminal for Robinhood Chain, BNB Chain, Solana and NEAR.

This repository is the exact source of `https://vault.motion.gift/vendor/engine.js` — the one script
that runs inside the isolated vault frame, creates and stores the trading keys, and signs every
trade. It is published so that anyone can build it, get byte-identical output and compare the hash
with what motion.gift serves. Nothing here is needed to *use* motion; it is here to be read and
checked.

Security overview, live checks and the hashes of the current build: <https://motion.gift/security-center>.

## In plain words: is motion.gift running this exact code?

Think of the vault code as a sealed jar with a fingerprint on the lid.

- **The fingerprint is a hash** — a long string like `sha384-m3D8Bv…`. It is computed from every single
  byte of the code. Change one letter anywhere and the fingerprint comes out completely different.
- **Your browser checks the fingerprint every time.** The vault page tells the browser "run this file
  only if its fingerprint is exactly this" (that's called Subresource Integrity). If the file was
  swapped, the browser refuses to run it — the vault simply doesn't open.
- **We publish the fingerprint and the code.** The fingerprint of what motion.gift serves right now
  is at <https://vault.motion.gift/releases.json>. The code is this repository.
- **Anyone can make the jar again.** Download this code, build it, and you get the *same* fingerprint.
  Same fingerprint = the site runs exactly the code you can read here. Nothing hidden, nothing added.

Three ways to check, from easiest:

1. **No code at all (1 minute).** Open <https://motion.gift/security-center> and press **Run checks** —
   your browser fetches the vault the site really serves, hashes it, and compares it with the
   published fingerprint. Then open <https://vault.motion.gift/releases.json> and check that
   `engine` → `sha384` there is the same as the one in the [build output below](#reproducible-build)
   for the release tag you're looking at.
2. **One command (5 minutes, needs Node.js).** Clone, build, and let the script compare with the live
   site for you:
   ```sh
   git clone https://github.com/motiongift/motion-vault && cd motion-vault
   npm ci && npm run build:engine && npm run verify
   ```
   Three `OK` lines = your own build, the file the site serves, and the published fingerprint are
   the same bytes.
3. **Read it.** Everything below explains what the code does and where to look.

If you ever see a mismatch that no release tag explains, that's exactly what this is for — please
report it (see [SECURITY.md](SECURITY.md)) and tell people.

## What is in the box

| path | what |
| --- | --- |
| `src/webEngine.ts` | the engine: key store, EVM trading (Robinhood Chain, BNB Chain), the postMessage surface the terminal talks to, the 2FA gate, dialogs |
| `src/vaultRecovery.ts` | key derivation, the encrypted vault at rest, account backup (v3), survival rules after a lost key store |
| `src/solEngine.ts` | the Solana lane: ed25519 identities, pump.fun / PumpSwap / Meteora DLMM trades, sending through Jito + RPC |
| `src/nearEngine.ts` | the NEAR lane: NEAR identities, Rhea DCL swaps |
| `src/bridgeEngine.ts` | balances and sends on other EVM chains for the Relay bridge leg |
| `src/perpsEngine.ts`, `src/lighter/perpsCore.ts`, `src/lighter/signer.ts`, `src/lighter/wasmExec.js` | perpetuals on Lighter from the vault's own wallets: orders, deposits and withdrawals to the wallet's own address; transactions signed by Lighter's official WebAssembly signer, whose bytes are checked against a pinned sha256 before it runs |
| `src/evmV4Router.ts`, `src/bnbRouter.ts`, `src/standardRouter.ts` | calldata for the venues the engine is allowed to trade through (Uniswap V4 / Universal Router, PancakeSwap Infinity, four.meme, Flap, standardreserve) |
| `server/web/vault.html` | the vault frame document: one `<script>` tag, pinned to the engine by Subresource Integrity |
| `vite.web-engine.config.ts` | the build (`src/webEngine.ts` → one IIFE, `server/web/vendor/engine.js`) |
| `scripts/vault-release.mjs` | the release step: writes the engine's sha384 into `vault.html` and the hashes into `releases.json` |
| `scripts/hash.mjs`, `scripts/verify-live.mjs` | hash your build; compare it with the live vault |
| `package.json`, `package-lock.json` | exact dependency versions (viem, @noble, vite, typescript) |

The frame's stylesheet and the page-side client (`vault-client.js`, `bridge.js`) are part of the
terminal website, not of the engine; their hashes are also published in `releases.json`.

## Trust model, in plain words

- **Keys live and sign only in the vault frame.** The frame is `vault.html` on its own origin,
  `vault.motion.gift`, embedded by the terminal page. Trading keys are generated (or imported) inside
  that frame and encrypted with AES-GCM-256 under a non-extractable `CryptoKey` kept in the vault
  origin's IndexedDB. The ciphertext sits in the vault origin's localStorage. Decrypted keys exist
  only inside the engine's closure — never on `window`, never logged, never posted anywhere.
  The terminal page (motion.gift) cannot read the frame's storage or variables: the browser's
  same-origin policy keeps the two documents apart. It can only *ask* the frame for things over
  `postMessage`, and only the methods on the engine's surface exist (see the comment above
  `const engine` in `src/webEngine.ts`). Nothing signs arbitrary calldata or arbitrary messages.
- **What a trade is.** The terminal proposes a route; the engine checks it on chain itself
  (the launchpad registry says this curve belongs to this token, the routers / pool managers equal
  the hardcoded deployments, every bridge hop passes through a known asset), simulates, signs
  locally and broadcasts the signed transaction to public RPC nodes (and to any nodes you add in
  Settings → RPC). A compromised or spoofed server cannot point a buy or an approval at a contract
  of its choosing.
- **What leaves the vault only through a gate.** A key on screen (export), the encrypted key file
  (backup), native coin to an address that is not one of the vault's wallets (withdraw) and erasing
  a funded wallet need a trusted click in a dialog the engine itself draws — and, when the account
  has 2FA on, a code the server has confirmed. The engine enforces this; the page cannot click for
  you.
- **What the server sees and does not see.** The motion server serves the terminal page and the
  engine (static files), holds your login session (Privy), your settings and your 2FA secret
  (encrypted at rest). It never receives a private key or a signed EVM / NEAR transaction.
  It does store an **encrypted account backup**: every wallet of your vault sealed under a key
  derived from one signature of your main wallet (backup v3, `src/vaultRecovery.ts`). The server
  cannot open it on its own — it holds the ciphertext, not the signature. Anyone holding *both*
  your Privy session and your main wallet's derivation signature could open it; that is the
  deliberate trade-off that lets a fresh browser restore your wallets after login + one signature.
- **The text your main wallet signs.** That signature is the seed, so its text can never change for an
  existing account (another text would derive other wallets). Accounts created before 17 Oct 2026 sign
  the original text, which still names the project's former domain, `copytrade.gg`; accounts created
  since sign `motion.gift — trading wallets …` (`MAIN_MSG(main, 2)`), and their backup records `mv: 2`
  so every device asks for the same text. The engine verifies the signature against the text it was
  told and never re-attaches a main under the other one.
- **Solana is the one lane with a relay in the send path.** Reads go from your browser to a
  public Solana node. For sends, simulations and fee estimates a copy of the **already-signed**
  transaction (and of the unsigned simulation payload) goes through motion's relay (`/sol/api`)
  to a fast RPC provider, in parallel with the public nodes and Jito. The relay sees signed bytes
  it cannot alter without invalidating the signature; it never sees a key. The same transaction is
  posted to public nodes and to any Solana nodes you add in Settings → RPC.
- **The real risk is altered JavaScript** — the risk of every web wallet. Mitigations: the vault
  origin's Content-Security-Policy allows scripts only from itself (`script-src 'self'`, no
  inline, no third party) and connections only to the chain nodes and the terminal; `vault.html`
  pins the engine's bytes with Subresource Integrity; the hashes are published in
  `https://vault.motion.gift/releases.json`; the engine is built from this repository, so you can
  rebuild it and compare. That is what the rest of this README is for.

## Reproducible build

Requirements: Node.js 22.12 or newer (the published build was made with Node 24.15.0, npm 10.7.0),
npm, network access to the npm registry. Any OS: the build has no native step that touches the
output.

```sh
git clone https://github.com/motiongift/motion-vault
cd motion-vault
npm ci                      # exact versions from package-lock.json (36 packages)
npm run build:engine        # vite build → server/web/vendor/engine.js
npm run hash                # sha384 / sha256 of your build, compared with the pin in vault.html
```

`npm run typecheck` (`tsc --noEmit`) is optional and does not affect the output.

The build of this commit produces:

```
bytes   712161
sha384  sha384-TapMv1EgPzruy83h62NvRAkPNoIcS46lgEe1Qrd7RFrXjU5z8Kv90a369UT/dvJ4
sha256  264cea40bd932ba6eab7026c89708e0c0dbe638e64835b2f8c0106bf338cb05e
```

The sha384 is the `integrity` attribute of the script tag in `server/web/vault.html`.

## Compare with what motion.gift serves

```sh
npm run verify              # fetches the live engine, vault.html and releases.json and compares
```

Or by hand:

```sh
curl -s https://vault.motion.gift/vendor/engine.js | openssl dgst -sha384 -binary | base64
curl -s https://vault.motion.gift/vault.html | grep -o 'integrity="[^"]*"'
curl -s https://vault.motion.gift/releases.json
```

All three must show the same sha384 as your build. `releases.json` also carries the sha256 and the
byte count of the engine and the sha256 of every frame file. The
[security center](https://motion.gift/security-center) runs the same comparison in your browser,
against the frame your browser actually loaded.

If your build does not match: first check that `npm ci` installed exactly the lockfile (no
`npm install`, no different Node major that changes nothing here but may in future), then check the
live `releases.json` — motion may have shipped a newer engine than this commit; tags in this
repository follow the engine releases. If the live engine matches no tagged commit, that is a
security report: see [SECURITY.md](SECURITY.md).

## Release step (what motion runs)

```sh
npm run build:engine
npm run release             # scripts/vault-release.mjs: pins vault.html, writes releases.json
```

## License

[Business Source License 1.1](LICENSE). You may inspect, build and verify this code and use it for
personal, non-commercial purposes; production use by a competing service is not allowed. Four
years after publication each version becomes available under the Apache License 2.0.
