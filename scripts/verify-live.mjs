// Compares the engine you built with what vault.motion.gift serves right now.
//   node scripts/verify-live.mjs [origin]      (default https://vault.motion.gift)
// Fetches /releases.json, /vault.html and the manifest-named engine from the live origin,
// hashes the live bytes itself (it does not trust the numbers in releases.json),
// and checks all three against the local build. Nothing is sent but the GETs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const engineFile = (value) => {
  if (typeof value !== 'string' || value !== value.trim() || !/^\/vendor\/engine(?:-[a-f0-9]{64})?\.js$/.test(value)) throw new Error('Invalid release engine file');
  return value;
};
const enginePin = (html, file) => {
  const tags = html.match(/<script\b[^>]*>/g) || [];
  const matches = tags.filter(t => (t.match(/\ssrc="([^"]+)"/) || [])[1] === file);
  return matches.length === 1 ? matches[0].match(/\sintegrity="(sha384-[^"]+)"/)?.[1] || '' : '';
};
const origin = (process.argv[2] || 'https://vault.motion.gift').replace(/\/$/, '');
const sha384 = (b) => 'sha384-' + createHash('sha384').update(b).digest('base64');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const get = async (p) => { const r = await fetch(origin + p, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

const local = readFileSync(new URL('../server/web/vendor/engine.js', import.meta.url));
const localSri = sha384(local);
console.log(`local build      ${localSri}  (${local.length} bytes)`);

const [html, rel] = await Promise.all([get('/vault.html'), get('/releases.json')]);
const listed = JSON.parse(String(rel)).engine || {};
const file = engineFile(listed.file);
const live = await get(file);
const liveSri = sha384(live);
const pinned = enginePin(String(html), file) || '(no matching engine script)';
console.log(`live ${file}   ${liveSri}  (${live.length} bytes)`);
console.log(`live vault.html  pins ${pinned}`);
console.log(`live releases    ${listed.sha384}  sha256 ${listed.sha256}`);

const rows = [
  ['local build == live engine.js', localSri === liveSri],
  ['local build == vault.html pin', localSri === pinned],
  ['local build == releases.json', localSri === listed.sha384 && sha256(local) === listed.sha256],
];
for (const [what, ok] of rows) console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}`);
process.exitCode = rows.every(([, ok]) => ok) ? 0 : 1;
