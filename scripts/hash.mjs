// Prints the hashes of the engine you just built, in the two forms motion publishes:
//   sha384 (base64, the Subresource Integrity value pinned in server/web/vault.html)
//   sha256 (hex, as listed in https://vault.motion.gift/releases.json)
//   node scripts/hash.mjs [path-to-engine.js]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path = process.argv[2] || new URL('../server/web/vendor/engine.js', import.meta.url);
const engine = readFileSync(path);
const sri = 'sha384-' + createHash('sha384').update(engine).digest('base64');
const sha256 = createHash('sha256').update(engine).digest('hex');
console.log(`bytes   ${engine.length}`);
console.log(`sha384  ${sri}`);
console.log(`sha256  ${sha256}`);
const html = readFileSync(new URL('../server/web/vault.html', import.meta.url), 'utf8');
const pinned = html.match(/integrity="(sha384-[^"]*)"/)?.[1];
console.log(`vault.html pins ${pinned}`);
console.log(pinned === sri ? 'MATCH: this build is the engine vault.html pins' : 'MISMATCH: this build is not the engine vault.html pins');
process.exitCode = pinned === sri ? 0 : 1;
