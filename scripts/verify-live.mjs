// Compares the engine you built with what vault.motion.gift serves right now.
//   node scripts/verify-live.mjs [origin]      (default https://vault.motion.gift)
// Fetches /releases.json, /vault.html and /vendor/engine.js from the live origin,
// hashes the live bytes itself (it does not trust the numbers in releases.json),
// and checks all three against the local build. Nothing is sent but the GETs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const origin = (process.argv[2] || 'https://vault.motion.gift').replace(/\/$/, '');
const sha384 = (b) => 'sha384-' + createHash('sha384').update(b).digest('base64');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const get = async (p) => { const r = await fetch(origin + p, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

const local = readFileSync(new URL('../server/web/vendor/engine.js', import.meta.url));
const localSri = sha384(local);
console.log(`local build      ${localSri}  (${local.length} bytes)`);

const [live, html, rel] = await Promise.all([get('/vendor/engine.js'), get('/vault.html'), get('/releases.json')]);
const liveSri = sha384(live);
const pinned = String(html).match(/integrity="(sha384-[^"]*)"/)?.[1] || '(no integrity attribute)';
const listed = JSON.parse(String(rel)).engine || {};
console.log(`live engine.js   ${liveSri}  (${live.length} bytes)`);
console.log(`live vault.html  pins ${pinned}`);
console.log(`live releases    ${listed.sha384}  sha256 ${listed.sha256}`);

const rows = [
  ['local build == live engine.js', localSri === liveSri],
  ['local build == vault.html pin', localSri === pinned],
  ['local build == releases.json', localSri === listed.sha384 && sha256(local) === listed.sha256],
];
for (const [what, ok] of rows) console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}`);
process.exitCode = rows.every(([, ok]) => ok) ? 0 : 1;
