# Account backup v4: a passkey as the second factor (2026-10-30)

Owner's go: “approved, let the agents build all of it” (2026-10-30). Status: **built and tested on branch `passkey-backup`. Not released,
not deployed.** The trench side (server module, routes, nginx, the opt-in "Protect your backup" UI in both designs, the public
explainer at `/security/backup`) is applied in the trench main tree; release plan and checklist: trench `docs/PROTECT-BACKUP.md`.

## Why

In backup v3, every sealed wallet and the gen-2 salts open with a key derived from the main wallet's signature alone. For an email or
Google account, that signature comes silently from the account's Privy wallet. So a stolen login, a hijacked e-mail or a script on
motion.gift gets the signature, reads `GET /api/account/profile` and opens every wallet (ACCOUNT-TAKEOVER.md §0, audit SV-1).

v4 adds a factor none of those hold: the WebAuthn PRF output of a passkey **scoped to the vault's own host**.

## Key schedule (`src/passkeyBackup.ts`)

All derivations are HKDF-SHA-256. All sealing is AES-256-GCM. `main` is lower-case. `salt` is 32 random bytes per generation and is public (`pk.salt`).

| Name | Value |
|---|---|
| DK | 32 random bytes per generation (`pk.gen`): the backup's data key |
| K4 | HKDF(seed ‖ DK, salt, `motion/backup/v4/key/<main>`). Seals every entry (AAD `motion/backup/v4/wallet/<addr>`, `…/salt`) |
| kc | HMAC(K4, `motion/backup/v4/check`)[0..8]. Tells the right DK from a wrong one |
| PRF_i | WebAuthn `prf.eval.first = salt` of passkey i (UV required) |
| slot_i | AES-GCM(HKDF(PRF_i, salt, `motion/backup/v4/kek/<main>/<credId>`), DK). AAD `…/slot/<main>/<credId>/<gen>` |
| rc | AES-GCM(HKDF(code, salt, `…/kek/rc/<main>`), DK). Code = 120 random bits + 20 check bits, shown once |

Opening the backup needs **the seed AND (a passkey's PRF, or the recovery code, or a device that already unwrapped DK)**:
- DK alone opens nothing.
- The server holds `salt`, `kc`, the wrapped slots and the sealed entries. None of it opens anything.
- A device keeps DK next to the seed in its own encrypted vault, so publishing a new wallet never asks for the passkey again.

The data-key design allows several passkeys (up to 10) and a code without ever re-sealing entries.

A "start over" mints gen+1 and keeps up to 2 previous envelopes in `pk.prev`. The engine supports this; there is no UI for it yet.

MAIN_MSG, seeds, wallet derivations, `rk`, `uc`, `fp` and `mv` are unchanged. v3 readers carry v4 entries verbatim and never drop them.

## RP ID: `vault.motion.gift`

- The page origin (motion.gift) **cannot** use a credential scoped to `vault.motion.gift`, so a script there cannot reach the PRF.
- The ceremony runs inside the vault frame's own dialog. It starts synchronously in the trusted click (`AskOpts.gesture`), after the
  `isTrusted` check and before any await. The PRF, DK and recovery code never leave the frame (pinned by `test/passkey-wiring.mjs`).
- The vault iframe needs `allow="publickey-credentials-get; publickey-credentials-create"`. With no allowlist, that means the frame's
  own origin (patch to `vault-client.js`). `app-bridge.js` already delegates both. nginx's `Permissions-Policy` leaves them at the
  browser default.
- **Future vault domains** keep this RP ID through Related Origin Requests (`https://vault.motion.gift/.well-known/webauthn` listing
  the new vault origin; Chrome 128+ and Safari 18+). Each slot records its `rp`.
- **Native app:** today its vault is a srcdoc frame on motion.gift, which can't use this RP ID, so v4 is not offered there.
  - Native support needs ASAuthorization or Credential Manager with RP ID `vault.motion.gift`: `webcredentials:vault.motion.gift` in
    the entitlements, AASA and assetlinks files on the vault host, and iOS 18+ for PRF.
  - The PRF bytes would then go to the engine over the WebView↔app bridge, which is that host's isolation boundary.

## Policy flags (owner's defaults, `PASSKEY_POLICY` in `src/passkeyBackup.ts`)

| Flag | Default | Effect |
|---|---|---|
| `codeAtEnrol` | true | a recovery code is drawn and shown once in the vault's own dialog during enrolment |
| `requireSaved` | true | enrolment completes only after "I saved it", or after skipping the code with a backup file written since the last wallet |
| `offerNative` | false | the app's native vault is not offered v4; it keeps v3 and the file-only mode |

Server flags (the pulse-indexer patch):
- `TRENCH_PASSKEY_HOLD_DAYS`: default 30.
- `TRENCH_PASSKEY_HOLD_INDEFINITE=1`: keeps held copies with no end date during the rollout.
- `TRENCH_PASSKEY_FILE`: where the hold store lives.

## Flows

1. **Enrol** (`passkeyEnrol`), 3 clicks:
   - "Create passkey" (`create()` with PRF eval).
   - "Use passkey" (`get()` of that credential; it must return a PRF, and if `create()` gave one too, the same one).
   - "Save your recovery code".

   A passkey that returns no PRF is refused (and `signalUnknownCredential` is sent where available), and nothing is staged. The
   engine re-seals **everything the live v3 copy holds**, not just this device's wallets.
2. **Stage** (`POST /api/account/passkey/stage`): the copy is kept next to the live v3. Every reader still gets v3.
3. **Verify** (`passkeyVerify`, 1 click): the server's staged copy is opened with a **fresh** touch and checked against the live copy
   (`verifyStaged`). It must hold every wallet and salt with the same keys, everything in v4 format, nothing foreign, and unchanged
   `rk`/`uc`/count. The digest is computed by the vault.
4. **Confirm** (`/confirm` with that digest; refused 409 if anything was written since the stage), in this order:
   1. The replaced v3 copy and account-guard's snapshots of it go into the **cold hold**, fsync'd first.
   2. The live profile is swapped.
   3. The snapshots leave account-guard.
   4. The account store saves twice, so `.prev` rolls past v3.
5. **Unlock on a new device** (`passkeyUnlock`, 1 click): `mainSync` reports `passkey: 'locked'`, and a locked vault publishes nothing
   (`PasskeyLocked`). After the touch, the normal "Restore your wallets" dialog follows.
6. **Recovery code** (`passkeyRecover`): typed into the vault's dialog, with typos caught by the check characters.
7. **Add / remove a passkey, or a new code** (`passkeyAdd` / `passkeyRemove` / `passkeyNewCode`): the change rides in the next
   publish. The server accepts envelope moves forward only.
8. **Turn off** (`passkeyOff`):
   - A danger dialog, then a fresh touch.
   - The whole backup is re-sealed as v3 and staged with a **fresh 2FA step-up** (gate kind `remove`).
   - It is verified to open with the seed, then confirmed. The replaced v4 copy is held too.
9. **Profile writes after v4:** a write without `pk` is refused with 409 (an older engine would seal under the seed alone). A vault
   that knows the account is v4 never writes v3 over a copy that lost its envelope (`PasskeyBackupMissing`).

## Dialogs: steps and languages (owner 2026-10-30: "everything careful, public and clear step by step")

Every word of the passkey dialogs and errors lives in `src/passkeyCopy.ts`, in en, ru, zh, id, es and fr. The engine picks the
page's language (`uiLang`, as for the rkMigrate dialogs) through `pkT(key, lang, params)`; plurals go through `Intl.PluralRules`.

- **Numbered flows.** A dialog with `AskOpts.step` shows "Step 2 of 4" and a thin bar above its title (`pkStepHtml`). The rules
  (`PK_DLG_RULES`) ride in the engine's own constructed sheet with the USD dialogs' rules, so vault.css is unchanged.
  - Turn on: 1/4 create the passkey, 2/4 confirm it (second touch), 3/4 save the recovery code, 4/4 check the new backup
    (`passkeyVerify`'s fresh touch on the staged copy).
  - Turn off: 1/2 confirm turning off, 2/2 touch the passkey. The server's fresh 2FA code and `passkeyVerify` 'off' follow
    without a dialog of the vault.
  - Add a passkey: 1/2 create, 2/2 confirm. Unlock, the recovery code, remove and a new code are single dialogs.
- **Each step says** what happens now, what the user needs for it (Face ID, a fingerprint or the device PIN), and that nothing
  changes until the last step.
- **Every failure** (a ceremony that did not finish, `PasskeyNoPrf`, `PasskeyWrong`, `PasskeyElsewhere`, `PasskeyNeedsFile`,
  `PasskeyLocked`, `PasskeyUnsupported`, …) says "Nothing was changed." and what to do next. Error names are unchanged.
- **A cancel** still throws `new Error('Cancelled')` (the page matches `/^cancel/i`). The page can show `pkT('cancelled')`.
- The English button labels the e2e stand clicks are unchanged ("Create passkey", "Use passkey", "I saved it", "Remove passkey",
  "Continue"). Behaviour, the key schedule, method names, return shapes and the order of awaits are unchanged.

## Cold hold (owner 2026-10-30: keep v3 as a safety net without reopening the hole)

- **Where:** `server/account-passkey.mjs`, in its own 0600 file on the main unit, keyed by account, with the hold date and an end date.
- **Not reachable:** no HTTP route serves a held copy. Not `/api/account/profile`, not `/api/account/history`, not
  `/api/account/passkey`, which tells the account only `coldHold: { since, until }`.
- **Operator restore:** the box-only route `/api/account/passkey-hold` (loopback + local secret; nginx 404, deploy.sh patch) is driven
  by `scripts/passkey-hold.mjs list|restore|sweep`. It answers metadata and acts; it never answers a copy.
  - Restore puts ONE held v3 copy back live for one account, logged with the reason.
  - Wallets that exist only in v4 stay alongside, sealed, and the v4 copy itself is held.
  - The live profile gets `pkRestoredAt`. Only the server sets it; client writes cannot, because `validProfile` drops it. The
    account's vaults then publish v3 again.
- **Retention:** 30 days by default (`sweep` on load and hourly), indefinite while the rollout flag is on. Also purged on account
  deletion and on "remove my backup from the server".
- **Honest limit:** during the hold window, motion's operator (anyone with root on the box) could put the weaker v3 copy of an account
  back. Nobody can **open** it without the account's main-wallet signature, which is the same as every v3 backup today.

## Recovery matrix

| Lost | Way back |
|---|---|
| one passkey (another one exists) | another passkey; then add a new one and remove the lost one |
| every passkey, a device still unlocked | that device adds a new passkey (it holds DK) |
| every passkey and every device | recovery code + sign-in → add a new passkey |
| every passkey, no device, no code | the backup file restores the wallets (the server copy stays sealed); a v4 bug or a support case: the operator's cold-hold restore within the retention |
| the sign-in (main wallet) | unchanged from v3: without the seed nothing opens (Rabby accounts: `rk` phone access, below) |

## `rk` (phone access): format unchanged

`rk` still carries only the seed. Under v4, a phone that restores through it still needs the passkey to open the sealed wallets.

Residual risk (stated in the docs): **v1 wallets** (derived from the seed alone, from accounts before gen-2) stay exposed to whoever
holds the login, with or without v4. This is true for every email account and for Rabby accounts with `rk` on. The remedy is to move
funds into new (gen-2) wallets, which are sealed under v4.

## Tests

- **Engine:** `node --test test/*.mjs`: 459 tests, 453 pass, 6 fork tests skipped (they need network), 0 fail. That includes:
  - `test/passkey-backup.mjs` (13): schedule, wrong/missing PRF, multi-passkey, code, generations, v4 entries, upgrade, verify
    refusals, turn-off, digest, WebAuthn readers, matrix.
  - `test/passkey-wiring.mjs` (6): the click gesture, no secret to the page, publish rules, the trade path untouched.
  - `test/passkey-copy.mjs` (10): every key in all six languages, no empty line, the same placeholders, the step head, "Nothing
    was changed." on every failure, the English the dialogs show, the steps of each flow, the error names.
  - `test/trade-core-pin.mjs`: unchanged and passing.
- **Server:** `scripts/account-passkey.test.mjs` (12):
  - envelope parity with the engine;
  - write rules;
  - stage → confirm → cold hold;
  - the hold is reachable through no route;
  - operator restore opens with the signature only;
  - retention / indefinite / deletion;
  - stale stage;
  - refusals;
  - turn-off with a fresh 2FA step-up;
  - crash safety;
  - fail-closed store;
  - the box script.
- **e2e:** `scripts/passkey-e2e.mjs` (52 checks), real Chrome with CDP virtual authenticators (`hasPrf`). The stand is the page on
  `http://localhost:PA` and the vault on `http://localhost:PB` (a development build accepts http://localhost; a release never does).
  - It covers every flow above: a no-PRF passkey refused, enrol, fresh verify, a wiped browser, the second passkey after the first is
    lost, the code after every passkey is lost, removal, turn-off, and the operator restore followed by a new device restoring with
    the signature only.
  - Note (resolved 2026-10-30): what looked like a renderer crash right after the frame's first load was Chrome dropping input to a
    cross-origin frame whose rect is under ~500 ms old (clickjacking protection). The page keeps the hidden frame at full-window
    geometry and shows a dialog only once the frame is 650 ms old (trench `vault-client.js` FRAME_SETTLE_MS); this harness waits the
    same 650 ms after inserting its frame (52/52) and has a watchdog on every vault call. The opt-in UI is driven end to end through
    the real classic pages by trench `scripts/protect-backup-e2e.mjs`.

## Timings

- **Crypto** (node, median of 9):
  - unlock (PRF → DK → kc) 0.4 ms;
  - open 150 wallets: v3 37.2 ms, v4 37.6 ms;
  - publish 150 wallets: v3 5.8 ms, v4 5.6 ms;
  - upgrade 44 ms; verify 74 ms.
- **In the browser** (virtual authenticator; wall clock includes the harness's 150 ms dwell before each click):
  - enrol 0.52 s, verify 0.17 s, unlock 0.18 s, restore after unlock 0.19 s, turn off 0.35 s.
- **For a user:** one more biometric prompt per new device (unlock), and 3 prompts once at enrolment.
- **The trading path is untouched:** `trade-core-pin` passes, and nothing of v4 sits between `verifyCache` and `REASONS`.

## Rollout

1. Owner decisions (below). Review the patches against the then-current trench files: the other agent's edits move them.
2. Server first:
   - apply `pulse-indexer.mjs.patch` and `deploy.sh.patch`, add `server/account-passkey.mjs`;
   - set `TRENCH_PASSKEY_HOLD_INDEFINITE=1`.

   Inert until an engine offers v4: the write rule only bites on accounts with `pk`.
3. Engine release from `passkey-backup`, the usual way: `build:engine`, `vault-release.mjs`, SRI pin, then the motion-vault mirror and
   tag. Before release, measure the pre-send A/B per TRADE-CORE §2 (the trade path is unchanged).
4. Client: apply `vault-client.js.patch` and `edition.mjs.patch`, add `server/web/passkey-backup.js`. The UI entries ("Protect your
   backup with a passkey" in the save step and settings, "Unlock backup", the passkey list) call `window.TrenchPasskey`.
5. Opt-in to the owner and testers first. Watch `/api/health/feeds → accountAccess.passkey`. Then everyone. Lift the indefinite hold
   once no v4 bug has been seen for N weeks.
6. Later: ACCOUNT-TAKEOVER §3.2 (v3 seeds) for the v1 wallets; native passkeys.

## Owner decisions

- The defaults above: code at enrolment, saving it required, no native offer, `rk` unchanged, 30-day hold (indefinite during rollout).
- Whether v4 becomes the default for new accounts once proven, or stays opt-in.
- Whether the UI should show the cold-hold date ("A copy of your old backup is kept on motion's server until …"). The server already
  answers it; recommended: yes.
