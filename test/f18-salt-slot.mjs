// V12 F-18: isSaltSlot matches ONLY the exact salt-slot shape, so a grindable 0x5a17… wallet is not hidden as a salt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SALT_SLOT, isSaltSlot } from '../src/vaultRecovery.ts';

test('real salt slots match', () => {
  for (const i of [0, 1, 5, 200, 0xffff]) assert.equal(isSaltSlot(SALT_SLOT(i)), true, `slot ${i}`);
});

test('a wallet merely starting 0x5a17 is NOT a salt slot (F-18)', () => {
  // the old /^0x5a17[0-9a-f]{36}$/ matched any of these; the tight pattern rejects them
  assert.equal(isSaltSlot('0x5a17ab8f3c2e1d0045ab67cd89ef012345678901'), false); // real-looking bytes after the prefix
  assert.equal(isSaltSlot('0x5a1700000000000000000000000000000001abcd'.slice(0, 42)), false); // a nonzero digit inside the zero run
  assert.equal(isSaltSlot('0x0000000000000000000000000000000000005a17'), false); // 5a17 at the end, not the prefix
});
