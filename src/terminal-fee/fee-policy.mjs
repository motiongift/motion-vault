// Motion fee policy receipt v1 (shared, browser-safe; byte-identical copy lives in the economics server).
// The economics server signs ONE receipt per trade: the terminal rate it decided (holder tier with the 7-day minimum,
// paid membership, or the standard rate), the collector, a short expiry and a single-use nonce. The vault verifies it
// with a deployment-pinned Ed25519 key BEFORE signing and requires the signed quote to carry exactly that rate.
// Fail-closed: a missing, malformed, expired, replayed, foreign or mis-signed receipt never lowers the rate; the
// decision is the standard rate (20 bps). API-channel receipts never authorize a terminal rate.
// This key is separate from the quote signer: a compromised quote signer alone cannot grant an exemption.
// No imports on purpose: the Ed25519 implementation (@noble/curves, already pinned in both builds) is injected, so
// with the engine flag OFF this module is fully tree-shaken and the engine bundle stays byte-identical.

export const FEE_POLICY_PURPOSE = 'motion-fee-policy-v1';
export const TERMINAL_TIERS = /* @__PURE__ */ Object.freeze([0, 5, 10, 15, 20]);
export const TERMINAL_BASE_BPS = 20;
export const API_FEE_BPS = 10;
export const MAX_POLICY_TTL_MS = 60000;
export const QUOTE_CLOCK_LAG_MS = 16000;
const FIELDS = /* @__PURE__ */ Object.freeze(['version', 'purpose', 'policyId', 'channel', 'chain', 'trader', 'side', 'token', 'amount',
  'rateBps', 'baseBps', 'basis', 'tierId', 'collector', 'issuedAt', 'expiresAt', 'nonce', 'account']);
const TERMINAL_BASES = /* @__PURE__ */ Object.freeze(['standard', 'holder', 'member', 'checking', 'unbound_wallet', 'fail_closed']);
const CHAINS = /* @__PURE__ */ Object.freeze(['robinhood', 'bsc', 'sol']);
const EVM = /^0x[0-9a-f]{40}$/, SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, TIER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v) && !/^0+$/.test(v);
const ms = v => {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,15}$/.test(v)) throw policyError('time');
  const n = Number(v); if (!Number.isSafeInteger(n)) throw policyError('time'); return n;
};
function policyError(why) { return Object.assign(new Error(`Fee policy rejected: ${why}`), { name: 'FeePolicyRejected', code: why }); }
const hexToBytes = h => Uint8Array.from(h.match(/../g), b => parseInt(b, 16));
const addr = (chain, v) => (chain === 'sol' ? SOL : EVM).test(v ?? '');

/** Strict canonical form. Unknown/missing fields, wrong types or inconsistent rate/basis/tier all throw. */
export function canonicalFeePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw policyError('shape');
  const keys = Object.keys(raw);
  if (keys.length !== FIELDS.length || keys.some(k => !FIELDS.includes(k))) throw policyError('fields');
  const p = Object.fromEntries(FIELDS.map(k => [k, raw[k]]));
  if (p.version !== 1 || p.purpose !== FEE_POLICY_PURPOSE || !hex(p.policyId, 64) || !hex(p.nonce, 64) || !hex(p.account, 64)) throw policyError('identity');
  if (!CHAINS.includes(p.chain) || !['buy', 'sell'].includes(p.side) || !addr(p.chain, p.trader) || !addr(p.chain, p.token) ||
    !addr(p.chain, p.collector) || p.collector === p.trader) throw policyError('accounts');
  if (typeof p.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(p.amount)) throw policyError('amount');
  if (!Number.isInteger(p.rateBps) || !Number.isInteger(p.baseBps)) throw policyError('rate');
  if (p.channel === 'api') {
    // API trades: separate 0.1 % API fee, never a membership/holder exemption.
    if (p.rateBps !== API_FEE_BPS || p.baseBps !== API_FEE_BPS || p.basis !== 'api' || p.tierId !== null) throw policyError('api rate');
  } else if (p.channel === 'terminal') {
    if (p.baseBps !== TERMINAL_BASE_BPS || !TERMINAL_TIERS.includes(p.rateBps) || !TERMINAL_BASES.includes(p.basis)) throw policyError('terminal rate');
    if (p.basis === 'member' ? (p.rateBps !== 0 || p.tierId !== null)
      : p.basis === 'holder' ? (p.rateBps >= p.baseBps || typeof p.tierId !== 'string' || !TIER_ID.test(p.tierId))
        : (p.rateBps !== p.baseBps || p.tierId !== null)) throw policyError('basis');
  } else throw policyError('channel');
  const issued = ms(p.issuedAt), expires = ms(p.expiresAt);
  if (expires <= issued || expires - issued > MAX_POLICY_TTL_MS) throw policyError('ttl');
  return Object.freeze(p);
}

export const feePolicyBytes = payload => new TextEncoder().encode(`${FEE_POLICY_PURPOSE}\n${JSON.stringify(canonicalFeePolicy(payload))}`);

/** Validates the deployment-pinned verifier config. Throws on anything not explicitly configured. */
export function validatePinnedFeePolicy(pinned) {
  if (!pinned || typeof pinned !== 'object' || !hex(pinned.signerPublicKey, 64) || !hex(pinned.policyId, 64) ||
    pinned.baseBps !== TERMINAL_BASE_BPS || !Number.isSafeInteger(pinned.maxSkewMs) || pinned.maxSkewMs < 0 || pinned.maxSkewMs > 30000 ||
    !pinned.collectors || typeof pinned.collectors !== 'object') throw policyError('pinned config');
  for (const [chain, c] of Object.entries(pinned.collectors)) if (!CHAINS.includes(chain) || (c !== null && !addr(chain, c))) throw policyError('pinned collector');
  return pinned;
}

/** Signature + pinned identity + exact trade binding. Throws FeePolicyRejected. */
export function verifyFeePolicy(envelope, { ed25519, pinned, channel, chain, trader, side, token, amount, now = Date.now() }) {
  validatePinnedFeePolicy(pinned);
  if (typeof ed25519?.verify !== 'function') throw policyError('verifier');
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'payload,signature' || !hex(envelope.signature, 128)) throw policyError('envelope');
  const p = canonicalFeePolicy(envelope.payload), bytes = feePolicyBytes(p);
  let ok = false;
  try { ok = ed25519.verify(hexToBytes(envelope.signature), bytes, hexToBytes(pinned.signerPublicKey), { zip215: false }); } catch { ok = false; }
  if (!ok) throw policyError('signature');
  const collector = pinned.collectors[chain];
  if (p.policyId !== pinned.policyId) throw policyError('policy id');
  if (p.channel !== channel) throw policyError('channel mismatch');
  if (!collector || p.collector !== collector) throw policyError('collector');
  if (p.chain !== chain || p.trader !== trader || p.side !== side || p.token !== token || p.amount !== amount) throw policyError('trade binding');
  const issued = Number(p.issuedAt), expires = Number(p.expiresAt);
  if (!Number.isSafeInteger(now) || now < issued - pinned.maxSkewMs || now >= expires) throw policyError('expired');
  return Object.freeze({ payload: p });
}

/** In-memory single-use set (defense in depth; durable replay protection is the quote reservation + on-chain entitlement). */
export function createSeenNonces(limit = 512) {
  const seen = new Map();
  return Object.freeze({
    has: nonce => seen.has(nonce),
    add(nonce, expiresAtMs, now = Date.now()) {
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
      while (seen.size >= limit) seen.delete(seen.keys().next().value);
      seen.set(nonce, expiresAtMs);
    },
  });
}

/** Terminal decision. NEVER throws for a bad receipt: anything unproven decides the standard rate. */
export function terminalFeeDecision(envelope, { ed25519, pinned, chain, trader, side, token, amount, seen = null, now = Date.now() }) {
  validatePinnedFeePolicy(pinned);
  const standard = reason => Object.freeze({ rateBps: pinned.baseBps, failClosed: true, reason, nonce: null, basis: 'fail_closed', expiresAtMs: null, issuedAtMs: null });
  if (envelope == null) return standard('missing');
  let v;
  try { v = verifyFeePolicy(envelope, { ed25519, pinned, channel: 'terminal', chain, trader, side, token, amount, now }); } catch (e) { return standard(e?.code || 'invalid'); }
  if (seen?.has(v.payload.nonce)) return standard('replayed');
  return Object.freeze({ rateBps: v.payload.rateBps, failClosed: false, reason: v.payload.basis, nonce: v.payload.nonce, basis: v.payload.basis,
    expiresAtMs: Number(v.payload.expiresAt), issuedAtMs: Number(v.payload.issuedAt) });
}

/** The signed quote must carry exactly the decided rate; a discount must consume THIS receipt's nonce as its reservation. */
export function assertQuoteMatchesDecision(decision, { pinned, quoteBps, reservation, quoteIssuedAtMs }) {
  const norm = typeof reservation === 'string' ? reservation.toLowerCase().replace(/^0x/, '') : reservation;
  if (quoteBps !== decision.rateBps) throw Object.assign(new Error(decision.failClosed
    ? 'Fee discount could not be verified; request a new quote at the standard rate'
    : 'Quote fee differs from your fee policy; request a new quote'), { name: 'FeePolicyMismatch', code: 'rate' });
  if (decision.rateBps < pinned.baseBps && norm !== decision.nonce) throw Object.assign(new Error('Discounted quote is not bound to this fee policy'), { name: 'FeePolicyMismatch', code: 'reservation' });
  // Window only matters for a discount (a standard-rate quote grants nothing). Lower bound tolerates the quote
  // authorizer's chain clock: EVM issuedAt = min(wall, block) in whole seconds with |wall - block| <= 15 s. A discounted
  // quote cannot predate its receipt anyway: it must reserve the receipt's random nonce (checked above).
  if (!decision.failClosed && decision.rateBps < pinned.baseBps && (!Number.isSafeInteger(quoteIssuedAtMs) ||
    quoteIssuedAtMs < decision.issuedAtMs - pinned.maxSkewMs - QUOTE_CLOCK_LAG_MS || quoteIssuedAtMs > decision.expiresAtMs))
    throw Object.assign(new Error('Quote was issued outside the fee policy window'), { name: 'FeePolicyMismatch', code: 'window' });
  return true;
}
