// Pins the vault frame to the exact engine it ships with and publishes the hashes.
//   node scripts/vault-release.mjs
// - server/web/vault.html gets integrity="sha384-…" of server/web/vendor/engine.js
//   (the browser refuses to run any other bytes under that tag);
// - server/web/releases.json lists the hashes of the engine and of every frame
//   file present in this tree, so anyone can fetch what the server serves and
//   compare — the /security-center page on motion.gift does exactly that in the
//   user's own browser.
// This is the release step motion runs after `npm run build:engine`. In this
// repository only vault.html is part of the frame; the stylesheet and the
// page-side client are not needed to build or verify the engine, so their
// entries are written only when the files exist.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const sha = (algo, buf, enc = 'hex') => createHash(algo).update(buf).digest(enc);

const engine = read('server/web/vendor/engine.js');
const sri = 'sha384-' + sha('sha384', engine, 'base64');
const htmlPath = new URL('server/web/vault.html', root);
let html = readFileSync(htmlPath, 'utf8');
if (!/integrity="sha384-[^"]*"/.test(html)) throw new Error('vault.html has no integrity attribute to pin');
html = html.replace(/integrity="sha384-[^"]*"/, `integrity="${sri}"`);
writeFileSync(htmlPath, html);

const frameFiles = ['vault.css', 'vault-client.js', 'bridge.js'].filter((f) => existsSync(new URL('server/web/' + f, root)));
const files = { 'vault.html': Buffer.from(html), ...Object.fromEntries(frameFiles.map((f) => [f, read('server/web/' + f)])) };
const out = {
  v: 1,
  builtAt: new Date().toISOString(),
  engine: { file: '/vendor/engine.js', bytes: engine.length, sha384: sri, sha256: sha('sha256', engine), source: 'src/webEngine.ts (built with vite.web-engine.config.ts: npm run build:engine)' },
  frame: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, { file: '/' + k, bytes: b.length, sha256: sha('sha256', b) }])),
  note: 'Fetch each file from the vault origin, hash it, compare. The engine hash is also the SRI the frame pins in its script tag.',
};
writeFileSync(new URL('server/web/releases.json', root), JSON.stringify(out, null, 2) + '\n');
console.log(`vault pinned: ${sri} (${engine.length} bytes)`);
