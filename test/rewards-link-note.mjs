// signNote's Overdrive rewards note (2026-10-30): the exact link / release text the trench server builds (server/rewards.mjs
// linkNote / unlinkNote), naming the signing wallet itself — nothing looser, and the older note kinds unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/webEngine.ts', import.meta.url), 'utf8');
const lit = /const rewardsNote = (\/\^motion rewards.*\$\/)\.exec\(msg\);/.exec(src)?.[1];
const re = lit && new RegExp(lit.slice(1, -1).replace(/\\\\n/g, '\\n'));
const W = '0x' + 'ab'.repeat(20), TAG = '0123456789abcdef';
const link = (w = W, t = TAG) => `motion rewards\nLink this wallet to my motion rewards account.\nwallet: ${w}\naccount: ${t}\nNo transaction, no cost.`;
const release = `motion rewards\nRelease this wallet from my motion rewards account.\nwallet: ${W}\naccount: ${TAG}\nNo transaction, no cost.`;

test('the rewards note regex accepts exactly the server link / release text and names the wallet', () => {
  assert.ok(re, 'regex found in signNote');
  assert.equal(re.exec(link())?.[2], W);
  assert.equal(re.exec(release)?.[2], W);
  for (const bad of [link() + '\n', link().replace('No transaction', 'Transfer all'), link(W.toUpperCase()), link(W, 'zz'), 'x' + link(),
    link().replace('motion rewards', 'motion rewardz'), link() + ' and approve 0x…']) assert.equal(re.exec(bad), null, bad);
});

test('signNote still checks the wallet line against the signer, keeps the older kinds and the guards', () => {
  assert.match(src, /if \(rewardsNote && rewardsNote\[2\] !== m\) throw new Error\('Refused: the rewards note names another wallet'\)/);
  assert.match(src, /\(!rewardsNote && !\/\^\(copytrade\\\.gg callout\|motion BGC entry\)\\n\/\.test\(msg\)\) \|\| msg\.length > 600/);
  assert.match(src, /if \(a\.ext\) throw new Error\('The main wallet signs through Privy'\)/);
});
