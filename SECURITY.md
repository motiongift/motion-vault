# Security policy

## Reporting

Report privately. Do not open a public issue for anything that could put a user's funds at risk.

- Email: **nick@motion.gift**
- X / Twitter DM: **@motiongift**

Include what you found, how to reproduce it, which build (the engine hash from
`https://vault.motion.gift/releases.json` or `npm run hash` on your checkout) and what an attacker
could do with it. You will get an answer from a person, and a fix before any public write-up.

## Scope

In scope:

- this repository: the vault engine (`src/`), the vault frame (`server/web/vault.html`), the build
  and release scripts — anything that could let a page, an extension, a server or another user
  read a key, sign something the user did not ask for, bypass a gate (2FA, trusted click, route
  verification) or break the reproducible build / hash pinning;
- the live vault at `https://vault.motion.gift` and the terminal at `https://motion.gift` as far as
  they interact with the vault frame (postMessage surface, CSP, SRI).

Out of scope:

- third-party services the engine talks to (public RPC nodes, Jito, Relay, Privy, the venues'
  smart contracts) — report those to their owners;
- denial of service, rate limiting, volumetric attacks;
- anything that needs a compromised browser, operating system or browser extension with host
  permissions on the vault origin (such a setup already owns every web wallet).

## Please

- Test against your own wallets with dust. Never test against other users' funds, never try to
  obtain other users' keys, backups or 2FA secrets, and do not run automated scanners against the
  live service.
- Do not include private keys, seeds, backup files or funded-wallet credentials in a report.

## What a user should do after an incident

If a wallet in your vault did something you did not ask for: stop using that browser profile, move
the remaining funds to a wallet created elsewhere, export and keep the transaction hashes, and write
to nick@motion.gift with them. See https://motion.gift/security-center for what the vault stores
where and how to check the engine your browser runs.
