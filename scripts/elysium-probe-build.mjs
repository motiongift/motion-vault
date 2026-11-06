// Builds contracts/ElysiumProbe.sol and contracts/ElysiumGuard.sol (release 6) with solc 0.8.26 (soljson, the npm `solc` package)
// and prints the runtime bytecode that src/elysiumCore.ts carries as ELYSIUM_PROBE_RUNTIME / ELY_GUARD_CODE. Reproducible: same
// compiler, same settings, same bytes (no metadata hash).
//   SOLC_DIR=<path to node_modules/solc> node scripts/elysium-probe-build.mjs [--check]
// --check: exit 1 unless both builds equal the constants in src/elysiumCore.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const dir = process.env.SOLC_DIR;
if (!dir) { console.error('set SOLC_DIR to a solc 0.8.26 npm package'); process.exit(2); }
const solc = createRequire(import.meta.url)(dir);
if (!String(solc.version()).startsWith('0.8.26')) { console.error('solc 0.8.26 needed, got', solc.version()); process.exit(2); }
const core = process.argv.includes('--check') ? readFileSync(new URL('../src/elysiumCore.ts', import.meta.url), 'utf8') : '';
let bad = 0;
for (const [name, constant] of [['ElysiumProbe', 'ELYSIUM_PROBE_RUNTIME'], ['ElysiumGuard', 'ELY_GUARD_CODE']]) {
  const src = readFileSync(new URL(`../contracts/${name}.sol`, import.meta.url), 'utf8');
  const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', metadata: { bytecodeHash: 'none', appendCBOR: false }, outputSelection: { '*': { [name]: ['evm.deployedBytecode.object'] } } };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [`${name}.sol`]: { content: src } }, settings: SETTINGS })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
  const code = '0x' + out.contracts[`${name}.sol`][name].evm.deployedBytecode.object;
  console.log(name, 'solc', solc.version(), 'source sha256', createHash('sha256').update(src.replace(/\r/g, '')).digest('hex'), 'runtime bytes', (code.length - 2) / 2, 'sha256', createHash('sha256').update(code).digest('hex'));
  if (core) {
    const m = core.match(new RegExp(constant + "[^']*'(0x[0-9a-f]+)'"));
    if (!m || m[1] !== code) { console.error(`MISMATCH: src/elysiumCore.ts ${constant} is not this build`); bad = 1; }
    else console.log(`MATCH: src/elysiumCore.ts ${constant} carries exactly this build`);
  } else console.log(code);
}
process.exit(bad);
