# Owner approval — 8 November 2026

The owner explicitly approved correcting jupiterTradeOne sell rent preflight and releasing after verification: “Да, исправляй ядро и выпускай после проверок”.

Scope: stop reserving nominal ATA rent on sells when accounts may already exist; the existing unsigned simulation includes trial priority fees and verifies actual affordability before signing. No extra RPC, await or automatic retry. This does not fund genuinely insufficient SOL. See CHANGES-2026-11-08.md for validation and limitations.
