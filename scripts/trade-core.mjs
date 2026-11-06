// TRADE CORE pin (owner, 2026-10-25: "сохрани как свод правил текущую сборку транзакций — текущая скорость великолепна;
// чтобы никакие агенты не трогали это ядро без моего согласия"). See docs/TRADE-CORE.md.
//
// The trade core = every byte that runs between a click and a signed transaction leaving the browser: whole files
// (solEngine.ts, bnbRouter.ts, evmV4Router.ts, standardRouter.ts, v13Guards.ts) and the trade-path declarations of webEngine.ts.
// test/trade-core-pin.mjs fails when any of them changes. Re-pinning is the OWNER's decision:
//   node scripts/trade-core.mjs --write "<the owner's approval, quoted, with the date>"
// writes test/fixtures/trade-core.json. An agent never runs --write without that approval in chat.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
export const CORE_FILES = ['src/solEngine.ts', 'src/bnbRouter.ts', 'src/evmV4Router.ts', 'src/standardRouter.ts', 'src/v13Guards.ts', 'src/turboGas.ts'];
// webEngine.ts: the EVM click → send path (transport, nonces, lanes, signing, broadcast, receipts, fees, route checks, the trade)
export const CORE_DECLS = {
  'src/webEngine.ts': ['mkTransport', 'mkHeavyRing', 'heavyFor', 'makeShared', 'broadcast', 'nextNonce', 'nonceSheet', 'noteNonceUsed',
    'inLane', 'laneLock', 'signAndSend', 'sendCall', 'landed', 'feeFloor', 'feeFor', 'keepHot', 'loadSettings',
    // release #3 (2026-11-04): the per-lane slippage / road choice of an order (exec-quality TC-S1/S2, TC-M1 switch) and the
    // BNB private send (mev-v2, OFF by default: flipping MEV_DEFAULT must trip this pin)
    'MEV_DEFAULT', 'vaultFeatures', 'mevOn', 'laneSlip', 'orderSlip', 'tradeSettings',
    'broadcastUrls', 'postRaw', 'mevFallback', 'mevPrivate', 'publicSendUrls', 'holdNonce', 'releaseHold', 'privHold', 'includedTx',
    'holdBus', 'STATE_REFUSAL', 'MEV_MIN_GAS', 'MEV_HEDGE_MS', 'MEV_FALLBACK_MS', 'MEV_HOLD_MS', 'MEV_SHARED_HOLD_MS'],
};
// …and one contiguous region of webEngine.ts: route checks → tradeOne → preview → leftovers → limits → tradeGuard → trade /
// tradeInner → receipts (from the first declaration to the line before the second)
export const CORE_REGIONS = { 'src/webEngine.ts': [['verifyCache', 'REASONS']] };
export function regionChunk(src, from, to) {
  const a = declChunk(src, from), lines = src.replace(/\r/g, '').split('\n');
  const i = lines.indexOf(a.split('\n')[0]);
  const re = new RegExp(`^(export )?(async )?(function\\*? ${to}\\b|const ${to}\\b|let ${to}\\b)`);
  const j = lines.findIndex((l, k) => k > i && re.test(l));
  if (i < 0 || j < 0) throw new Error(`trade core: region ${from}…${to} not found`);
  return lines.slice(i, j).join('\n');
}
const sha = (s) => createHash('sha256').update(s.replace(/\r/g, '')).digest('hex');
const START = /^(export |async |function |const |let |var |class |type |interface |enum |import |\/\/|\/\*)/;
// one top-level declaration: from its line to the line before the next top-level statement or comment
export function declChunk(src, name) {
  const lines = src.replace(/\r/g, '').split('\n');
  const re = new RegExp(`^(export )?(async )?(function\\*? ${name}\\b|const ${name}\\b|let ${name}\\b)`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`trade core: declaration ${name} not found`);
  let j = i + 1;
  while (j < lines.length && !START.test(lines[j])) j += 1;
  let end = j; while (end > i + 1 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(i, end).join('\n');
}
export function currentPins() {
  const files = Object.fromEntries(CORE_FILES.map((f) => [f, sha(readFileSync(new URL(f, root), 'utf8'))]));
  const decls = {};
  for (const [f, names] of Object.entries(CORE_DECLS)) {
    const src = readFileSync(new URL(f, root), 'utf8');
    for (const n of names) decls[`${f}#${n}`] = sha(declChunk(src, n));
  }
  for (const [f, regions] of Object.entries(CORE_REGIONS)) {
    const src = readFileSync(new URL(f, root), 'utf8');
    for (const [a, b] of regions) decls[`${f}#${a}…${b}`] = sha(regionChunk(src, a, b));
  }
  return { files, decls };
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const i = process.argv.indexOf('--write');
  const pins = currentPins();
  if (i < 0) { console.log(JSON.stringify(pins, null, 1)); process.exit(0); }
  const approval = String(process.argv[i + 1] || '').trim();
  if (approval.length < 10) { console.error('--write needs the owner\'s approval text (quoted, with the date)'); process.exit(1); }
  const out = { note: 'TRADE CORE pins — docs/TRADE-CORE.md. Change only with the owner\'s explicit approval.', approval, pinnedAt: new Date().toISOString(), ...pins };
  writeFileSync(new URL('test/fixtures/trade-core.json', root), JSON.stringify(out, null, 1) + '\n');
  console.log('trade core re-pinned:', Object.keys(pins.files).length, 'files,', Object.keys(pins.decls).length, 'declarations');
}
