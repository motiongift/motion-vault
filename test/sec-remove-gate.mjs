// SEC-3 (security audit 2026-11-04, pass 1) = V12 F-9, never fully fixed: remove(id) applies the account's 2FA 'remove' gate
// only when it believes the wallet is funded, and it looks the balance up under the wallet's EVM address. On the Solana and
// NEAR frames the caches are keyed by the Solana / NEAR address and the live read is skipped, so a wallet holding SOL is
// "empty" there; on an EVM frame only THIS chain counts (funds on the other EVM chain, on Solana, in the USD-balance reserve R
// or in limit-order / perps wallets — all derived from the same key — are invisible). Whoever holds the unlocked browser can
// erase a funded wallet with one click, past the 2FA the user turned on for exactly that. Runs the REAL engine.remove.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cut } from './sec-cut.mjs';

const EVM = '0x1111111111111111111111111111111111111111';
const SOLA = 'So1aNaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx';

function world({ sol = false, ethCache = {}, bal = 0n, nonce = 0 } = {}) {
  const gates = [];
  const list = [{ id: 'w1', name: 'Wallet 1', address: EVM, key: '0x' + '11'.repeat(32) }, { id: 'w2', name: 'Wallet 2', address: '0x2222222222222222222222222222222222222222', key: '0x' + '22'.repeat(32) }];
  const meta = { main: null, removedAddrs: [], selectedAccountIds: [], activeAccountId: 'w1' };
  const R = { title: (n) => 'Remove ' + n, ok: 'Remove', cancel: 'Keep', kept: 'k', lost: 'l', keptNote: 'k', lostNote: 'l' };
  const stubs = {
    requireUnlocked: () => list, ethCache, tokenCache: {}, SOL_MODE: sol, NEAR_MODE: false,
    publicClient: { getBalance: async () => bal, getTransactionCount: async () => nonce },
    gate: async (action) => { gates.push(action); }, REMOVE_DIALOG: { en: R }, uiLang: () => 'en', inBackup: () => true, unboundOf: () => [], meta,
    ask: async () => true, sub: (h) => h, muted: (h) => h, escHtml: (v) => String(v), addrRow: () => '', removedIds: new Set(), perps: { forget: async () => {} },
    persist: async () => {}, summary: () => ({}), solAddressOf: () => SOLA, nearAccountId: () => '',
  };
  const f = cut(['lc', 'engine.remove'], stubs);
  return { f, gates };
}

test('SEC-3: removing a wallet that holds SOL, from the Solana frame, passes the 2FA remove gate', async () => {
  const { f, gates } = world({ sol: true, ethCache: { [SOLA]: 2.5, [SOLA.toLowerCase()]: 2.5 } });
  await f.remove('w1');
  assert.deepEqual(gates, ['remove'], 'a funded wallet must hit the remove gate');
});

test('SEC-3: removing from an EVM frame a wallet empty on THIS chain (funds elsewhere: other chain, reserve, orders) still passes the gate', async () => {
  const { f, gates } = world({ sol: false, bal: 0n, nonce: 0 });
  await f.remove('w1');
  assert.deepEqual(gates, ['remove']);
});
