// The pre-send deadline of the buy straight from the USD reserve (owner 2026-11-01: «даю добро делай», answering "Ограничение по
// времени для зависшей прямой покупки из резерва — снятие блокировки внутри хранилища, нужна правка движка").
//
// The reserve's direct buy (webEngine usdBuy / usdBuyEvm) holds the per-wallet trade guard (tradeGuard, `buy:<coin>:<wallet>`,
// across tabs). A build that stalled BEFORE anything was sent (route check, quote, probe / simulation, the gas drop) kept that
// guard until a reload, and every later buy of the coin from the wallet answered "still being sent". Now the build gets
// PRE_SEND_MS to reach the hand-over to broadcast. If it has not by then, the click is answered "not started" with LATE_TEXT
// ("nothing was sent": the app falls back to hold & fire), the guard is released, and the build is abandoned: its gate answers
// false, so it can never sign-and-send afterwards.
//
// The cut-off is the gate: the build calls gate() synchronously right before it hands a transaction to the send path
// (solEngine solDirectBuy before sendSigned; usdBuyEvm before signAndSend). Once gate() answered true the deadline is off for
// good — the click keeps today's submitted / unknown / follow behaviour, however long the send takes. JavaScript runs one
// thing at a time, so the timer and the gate can never both win.

/** Normal reserve build (click → handed to broadcast): Solana ~0.6–1.0 s, Robinhood / BNB ~0.1–0.2 s. The slowest build that
 *  still succeeds waits for motion's gas drop (solver ≤ 4 s + ≤ 5 s for the SOL / ETH to show) and builds again: ~11 s. */
export const PRE_SEND_MS = 20_000;
export const LATE_TEXT = `The buy from your USD balance took too long to prepare (over ${PRE_SEND_MS / 1000} s) — nothing was sent`;

export type PreSendControl = {
  /** call right before handing a transaction to broadcast: true = go on (the deadline is off from now), false = too late, do not send */
  gate: () => boolean;
  /** the deadline already answered this click (the build was abandoned) */
  late: () => boolean;
};

/**
 * Run `build` under the pre-send deadline. Resolves with build's own answer when it reaches the gate in time (or fails / answers
 * before it); with `onLate()` when `ms` pass first and the build has not passed the gate. A build that comes back after the
 * deadline is ignored (its gate said false: it sent nothing).
 */
export function preSendDeadline<T>(ms: number, build: (ctl: PreSendControl) => Promise<T>, onLate: () => T): Promise<T> {
  let phase: 'build' | 'sending' | 'late' = 'build';
  const ctl: PreSendControl = {
    gate: () => { if (phase === 'late') return false; phase = 'sending'; return true; },
    late: () => phase === 'late',
  };
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (phase !== 'build') return;
      phase = 'late';
      try { resolve(onLate()); } catch (e) { reject(e); }
    }, ms);
    let p: Promise<T>;
    try { p = build(ctl); } catch (e) { p = Promise.reject(e); }
    p.then((v) => { clearTimeout(timer); if (phase !== 'late') resolve(v); }, (e) => { clearTimeout(timer); if (phase !== 'late') reject(e); });
  });
}
