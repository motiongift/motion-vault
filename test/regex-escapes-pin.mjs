// A patch script once ate the backslashes of two bridge-quote checks (/^\d{1,40}$/ became /^d{1,40}$/): every own bridge
// quote then threw "Bad amount" and every bridge failed. Pin: no regex literal in the engine sources starts a class-less
// d / w / s quantifier right after ^, ( or |, and the bridge quote keeps its digit checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = new URL('../src/', import.meta.url);
const files = readdirSync(src).filter((f) => f.endsWith('.ts'));

test('no regex literal lost its escape before d / w / s', () => {
  const bad = [];
  for (const f of files) {
    readFileSync(new URL(f, src), 'utf8').split('\n').forEach((l, i) => {
      if (/\/\^(d|w|s)[{+*]/.test(l) || /[(|](d|w|s)\{\d/.test(l) && /\/[^/\n]*[(|](d|w|s)\{\d[^/\n]*\//.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('the own bridge quote checks digits', () => {
  const s = readFileSync(new URL('webEngine.ts', src), 'utf8');
  assert.ok(s.includes("if (!/^\\d{1,40}$/.test(String(q?.amount || ''))) throw new Error('Bad amount');"));
  assert.ok(s.includes("out: /^\\d{1,60}$/.test(String(co.amount ?? ''))"));
  const re = /^\d{1,40}$/;
  assert.ok(re.test('1000000') && !re.test('d'));
});
