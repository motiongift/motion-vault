async function jupiterTradeOne(a: SolAcct, side: 'buy' | 'sell', r: SolRoute, size: number, s: SolSettings): Promise<{ hash: string }> {
  const k = solKeys(a.key!); const user = k.address;
  await solHoldGate(user);
  const click = joinClick();
  const planP = sendPlan(s); const bhP = blockhash(10_000); planP.catch(() => {}); bhP.catch(() => {});
  const coinAta = ataOf(user, r.mint, r.tokenProgram), wsolAta = ataOf(user, P.wsol, P.token);
  // speed: a buy's quote starts with the wallet read, not after it (a sell needs the balance first: its amount is a share of it)
  const buyAmount = side === 'buy' ? BigInt(Math.floor(size * 1e9)) : 0n;
  if (side === 'buy' && buyAmount <= 0n) throw new Error('Enter an amount');
  const bEarly = side === 'buy' ? jupBuild(r, side, buyAmount, s.slippage, user) : null; bEarly?.catch(() => {});
  const priceP = motionPriceSol(r.mint);
  const [uAcc, cAcc, wAcc] = await accounts([user, coinAta, wsolAta]);
  if (uAcc === undefined || cAcc === undefined || wAcc === undefined) throw new Error('Could not read this wallet from the Solana nodes — nothing was sent; try again');
  const coinBefore = tokState(cAcc)?.amount ?? 0n, wsolBefore = tokState(wAcc);
  let amount = buyAmount;
  if (side === 'sell') { if (coinBefore <= 0n) throw new Error('Nothing to sell in this wallet'); amount = (coinBefore * BigInt(Math.round(Math.min(100, Math.max(0, size)) * 100))) / 10000n; if (amount <= 0n) throw new Error('Nothing to sell'); }
  const built0 = await (bEarly ?? jupBuild(r, side, amount, s.slippage, user));
  const minOut = BigInt(built0.quote.otherAmountThreshold);
  const { list, tables: tableKeys } = built0;
  const priceWhy = jupPriceCheck({ side, amount, minOut, decimals: r.decimals, priceSol: await priceP, feeBps: r.fee?.lowBps });
  if (priceWhy) throw new Error('Refused: ' + priceWhy + '. Nothing was sent.');
  const { ixs, opens } = jupIxsChecked(list, user, side, amount);
  const tables = await jupTables(tableKeys);
  // Jupiter's copy of each table must be what the chain holds (a forged map would point the signed indexes at other accounts)
  for (const t of tables) { const claimed = built0.claimed[t.key] || []; if (claimed.length > t.addresses.length || claimed.some((a, i) => a !== t.addresses[i])) throw new Error('Jupiter\'s lookup table does not match the chain — refused'); }
  const plan = await planP;
  const tip = plan.tipLamports > 0n ? [plan.protect ? tipIxGuarded(user, pick(JITO_TIP), plan.tipLamports) : transferIx(user, pick(JITO_TIP), plan.tipLamports)] : [];
  // the F-8 ceiling at this route's compute limit: tip + priority never past ~0.005 SOL
  const microAt = (units: number) => Math.min(plan.micro, Number(((JUP_FEE_CEIL - (plan.tipLamports > JUP_FEE_CEIL ? JUP_FEE_CEIL : plan.tipLamports)) * 1_000_000n) / BigInt(units)));
  const feesAt = (units: number) => plan.tipLamports + (BigInt(microAt(units)) * BigInt(units)) / 1_000_000n + SIG_FEE + 10_000n;
  const rentMax = BigInt(opens) * RENT_ATA22;
  const have = BigInt(uAcc?.lamports || 0), need = (side === 'buy' ? amount + RENT_WALLET : 0n) + feesAt(JUP_UNITS_MAX) + rentMax;
  if (have < need) throw new Error(have === 0n ? 'This wallet has no SOL yet — fund it first' : `Not enough SOL: ${solTxt(have)} available, about ${solTxt(need)} needed (amount + fees + account rent)`);
  // simulate once (no priority in the trial: the fee is counted separately), with the inner instructions — every move of this
  // wallet's funds is checked from them; the slow list of all its token accounts only when the node does not return them
  const trial = unsignedTx(compileV0(user, [...budget(JUP_UNITS_MAX, 0), ...ixs, ...tip], P.system, tables));
  let sim = await simulateSeeing(trial, [user, coinAta, wsolAta]);
  if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
  let others: { address: string; state: TokState }[] = [];
  let post = (sim.accounts as any[]).map(simAcc);
  const through = new Set<string>();
  const innerWhy = Array.isArray(sim.innerInstructions) ? jupInnerGuard({ inner: sim.innerInstructions, user, side, amount, wsolAta, coinAta, rentMax: RENT_ATA22, through }) : 'no inner instructions';
  if (innerWhy && innerWhy !== 'no inner instructions') throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + innerWhy + '. Nothing was sent.');
  let rentSeen = rentMax;
  if (!innerWhy) {
    const opened = jupInnerRent(sim.innerInstructions, user);
    if (opened.opens > JUP_OPENS_MAX) throw new Error('Refused: Jupiter\'s transaction opens more accounts than a swap needs. Nothing was sent.');
    if (opened.rent > rentSeen) rentSeen = opened.rent;
  }
  if (!innerWhy && through.size) {
    // the route passes through token accounts this wallet already held: each is read now and again in the simulation, and the
    // balance check below refuses any that ends lower, closed, handed over or delegated (net zero is all a route may do there)
    const via = [...through].filter((t) => t !== coinAta && t !== wsolAta);
    if (via.length > 8) throw new Error('Refused: the Jupiter transaction passes through more token accounts of this wallet than a swap needs. Nothing was sent.');
    const pre = await accounts(via);
    if (pre.some((x) => x === undefined)) throw new Error('Could not read this wallet from the Solana nodes — nothing was sent; try again');
    const states = pre.map((x) => tokState(x));
    const bad = via.find((_, i) => !states[i] || states[i]!.owner !== user);
    if (bad) throw new Error(`Refused: Jupiter's transaction does not do what you asked — it moves tokens out of ${bad.slice(0, 6)}…. Nothing was sent.`);
    others = via.map((address, i) => ({ address, state: states[i]! }));
    sim = await simulateSeeing(trial, [user, coinAta, wsolAta, ...via]);
    if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
    post = (sim.accounts as any[]).map(simAcc);
  }
  if (innerWhy === 'no inner instructions') {
    others = (await walletTokenAccounts(user)).filter((t) => t.address !== coinAta && t.address !== wsolAta);
    sim = await simulateSeeing(trial, [user, coinAta, wsolAta, ...others.map((t) => t.address)]);
    if (sim.err) throw new Error(errText(sim, side, 'jupiter'));
    post = (sim.accounts as any[]).map(simAcc);
  }
  // the compute it really used (+25 %), and the priority price at THAT limit (it was clamped at a 700k ceiling before)
  const units = Math.min(JUP_UNITS_MAX, Math.ceil(Number(sim.unitsConsumed || JUP_UNITS_MAX) * 1.25) + 5_000);
  const why = jupBalanceGuard({
    side, amount, minOut, feesMax: feesAt(units), rentMax: rentSeen, user,
    solBefore: have, solAfter: BigInt(post[0]?.lamports ?? 0) - (BigInt(microAt(units)) * BigInt(units)) / 1_000_000n, coinBefore, coinAfter: post[1] ? tokState(post[1])?.amount ?? null : (side === 'sell' ? 0n : null),
    wsolBefore, wsolAfter: tokState(post[2]),
    others: others.map((t, i) => ({ address: t.address, before: t.state, after: tokState(post[3 + i]) })),
    wsolLamportsBefore: BigInt(wAcc?.lamports || 0), wsolLamportsAfter: BigInt(post[2]?.lamports || 0),
  });
  if (why) throw new Error('Refused: Jupiter\'s transaction does not do what you asked — ' + why + '. Nothing was sent.');
  let bhi = await bhP; if (Date.now() - bhi.at > 20_000) bhi = await blockhash(0);
  let bh = bhi.v, lvh = bhi.lvh;
  const build = (b: string) => signMessage(compileV0(user, [...budget(units, microAt(units)), ...ixs, ...tip], b, tables), k.seed);
  let built = build(bh);
  for (let i = 0; i < 3 && sentSigs.has(b58e(built.sig)); i++) { const nb = await newerBlockhash(bh); bh = nb.v; lvh = nb.lvh; built = build(bh); }
  const { tx, sig } = built;
  if (tx.length > 1232) throw new Error('Jupiter\'s route does not fit one transaction — nothing was sent; try a different amount');
  const hash = b58e(sig);
  const now = Date.now(); for (const [x, at] of sentSigs) if (now - at > 120_000) sentSigs.delete(x);
  sentSigs.set(hash, now);
  // F-1/F-55 V12: the same single send path as every other outflow
  try { await sendSigned(tx, hash, lvh, user, { mode: plan.mode, click, venue: 'jupiter', protect: plan.protect }); }
  catch (e) { if (!(e instanceof SolSendUnknown)) sentSigs.delete(hash); throw e; }
  return { hash };
}

// the preview of a Jupiter route:
