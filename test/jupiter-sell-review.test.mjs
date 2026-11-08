import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Independent additions to the author's entirely offline harness. No engine file is changed.
const originalUrl = new URL('./jupiter-sell-funding.test.mjs', import.meta.url);
let harness = readFileSync(originalUrl, 'utf8').split("test('baseline falsely")[0];
harness = harness.replaceAll('import.meta.url', JSON.stringify(originalUrl.href));
harness = harness.replace('async function run(', `const guardSource = sources.candidate.slice(sources.candidate.indexOf('export function jupBalanceGuard('), sources.candidate.indexOf('// security audit VA-7:')).replace('export ', '');
const realGuard = vm.runInNewContext('(' + stripTypeScriptTypes(guardSource) + ')');
async function run(`);
harness = harness.replace('consumed = 100_000 }', 'consumed = 100_000, branch = "normal", output = 20_000_000n }');
harness = harness.replace('accounts: async () => { log.reads++; return', 'accounts: async addresses => { log.reads++; if (addresses.length === 1) return [{ amount: 77n }]; return');
harness = harness.replace('tokState: x => x ? { amount: x.amount } : null', "tokState: x => x ? { amount: x.amount, owner: 'user', mint: 'coin', delegate: '' } : null");
harness = harness.replace('simulateSeeing: async tx => {', 'simulateSeeing: async (tx, addresses) => {');
harness = harness.replace('innerInstructions: [], accounts:', 'innerInstructions: branch === "no-inner" ? undefined : [], accounts:');
harness = harness.replace('+ 20_000_000n)', '+ output)');
harness = harness.replace('{ amount: 0n }, null] };', '{ amount: 0n }, null, ...addresses.slice(3).map(() => ({ amount: 77n }))] };');
harness = harness.replace("jupInnerGuard: () => '',", "jupInnerGuard: g => { if (branch === 'through') g.through.add('other'); return ''; }, walletTokenAccounts: async () => [{ address: 'other', state: { amount: 77n, owner: 'user', mint: 'coin', delegate: '' } }],");
harness = harness.replace('return guardError; },', 'return guardError || realGuard(g); },');
const { run } = await import('data:text/javascript;base64,' + Buffer.from(harness + '\nexport { run };').toString('base64'));

for (const branch of ['normal', 'through', 'no-inner']) {
  test(`${branch}: actual balance guard accepts exact proceeds and priority is normalized once after final simulation`, async () => {
    const { error, log } = await run('candidate', { branch, micro: 100_003, missing: 1 });
    assert.equal(error, null);
    assert.equal(log.simulations, branch === 'normal' ? 1 : 2);
    const fee = (100_003n * BigInt(log.signed.units) + 999_999n) / 1_000_000n;
    assert.equal(log.balance.solAfter, 4_500_000n - 5_000n - 1_000_000n - 2_100_000n + 20_000_000n - fee);
    assert.equal(log.signs, 1); assert.equal(log.sends, 1);
  });

  test(`${branch}: actual balance guard rejects a materially short output before any signing`, async () => {
    const { error, log } = await run('candidate', { branch, micro: 100_003, output: 1_000_000n });
    assert.match(error, /return less SOL/);
    assert.equal(log.signs, 0); assert.equal(log.sends, 0);
  });
}

test('acceptance boundary: nominal rent tolerance remains even when actual rent is zero', async () => {
  const { error, log } = await run('candidate', { output: 15_000_000n, missing: 0 });
  assert.equal(error, null);
  assert.equal(log.balance.rentMax, 6_300_000n);
  assert.equal(log.signs, 1, 'existing guard permits up to nominal rent allowance; not an actual-only rent check');
});
