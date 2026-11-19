// PAYMENT_METHOD_VERIFY signal endpoint. Given a payment method description
// (a card network name, a card number's leading digits/BIN, or a payment
// app name), verifies what can honestly be verified and says plainly what
// cannot be confirmed without live processor access.
//
// Card-network identification from a BIN (Bank Identification Number, the
// first 6-8 digits of a card number) is genuinely public knowledge: the
// IIN/BIN prefix ranges that identify Visa, Mastercard, Amex, Discover,
// Diners Club, JCB, and UnionPay are published by ISO/IEC 7812 and are the
// same ranges every BIN checker on the internet uses. That table is
// hardcoded below rather than fetched, since it almost never changes and
// answering instantly beats a network round trip for something this static.
//
// Checked live 2026-09-18 for a free enrichment source beyond the network
// name: binlist.net (`https://lookup.binlist.net/<bin>`) answers
// unauthenticated with issuing bank, country, and card type for a real BIN
// (confirmed live: a Visa test BIN returned scheme, type, brand, bank name,
// and country with no key or header beyond an optional Accept-Version). It
// is rate-limited (documented ~40-50 requests/min per IP) and occasionally
// has no record for a given BIN, so it is used as a best-effort enrichment
// on top of the static table, never as the only source: if it fails or is
// rate-limited, the static network identification still answers.
//
// Full card number validation (a live processor check of whether a card is
// active, has funds, or will authorize) is explicitly out of scope: this
// miner has no processor access, and the response says so rather than
// fabricating a "verified" claim. A payment app name (PayPal, Venmo, Cash
// App) is not a card network at all, so it is confirmed as a known payment
// method by name only, with the same honest limit stated.

import { Router } from 'express';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const MAX_INPUT_CHARS = 500;
const BINLIST_TIMEOUT_MS = 4_000;

// ISO/IEC 7812 IIN prefix ranges, ordered so a more specific/longer prefix
// is checked before a shorter one that would otherwise shadow it (e.g.
// Discover's 6011 is checked ahead of the bare "6" UnionPay-adjacent ranges
// would never actually collide with here, but the ordering is kept
// deliberate for the same reason).
const NETWORK_RULES = [
  { name: 'American Express', test: (d) => /^3[47]/.test(d) },
  { name: 'Diners Club', test: (d) => /^36/.test(d) || /^30[0-5]/.test(d) || /^3[89]/.test(d) },
  { name: 'JCB', test: (d) => /^35(2[89]|[3-8][0-9])/.test(d) },
  { name: 'Discover', test: (d) => /^6011/.test(d) || /^65/.test(d) || /^64[4-9]/.test(d) || /^622(1[2-9][6-9]|[2-8][0-9]{2}|9[01][0-9]|92[0-5])/.test(d) },
  { name: 'UnionPay', test: (d) => /^62/.test(d) },
  { name: 'Mastercard', test: (d) => /^5[1-5]/.test(d) || /^2(2[2-9][1-9]|[3-6][0-9]{2}|7[01][0-9]|720)/.test(d) },
  { name: 'Visa', test: (d) => /^4/.test(d) },
  { name: 'Maestro', test: (d) => /^(5018|5020|5038|5893|6304|6759|676[1-3])/.test(d) },
];

const PAYMENT_APPS = ['paypal', 'venmo', 'cash app', 'cashapp', 'zelle', 'apple pay', 'google pay', 'samsung pay', 'stripe', 'square', 'alipay', 'wechat pay', 'klarna', 'afterpay'];

const BIN_RE = /\b(\d{6,16})\b/;
const ROUTING_RE = /\b(?:routing|aba|rtn|ach)\b[^0-9]{0,40}?(\d{9})\b/i;
const CARD_DIGITS_RE = /\b\d(?:[ -]?\d){5,18}\b/g;
const LAST4_RE = /\b(?:ending|ends)\s+(?:in|with)\s+(\d{4})\b|\blast\s+(?:4|four)(?:\s+digits)?\s*(?:of\s+)?(?:is|are|:)?\s*(\d{4})\b/i;
const TOKEN_RE = /\b(tok|pm|card|src|ba|btok|seti|pi)_[A-Za-z0-9]{4,}\b/;
const LOOKUP_TIMEOUT_MS = 5_000;

// Issuer names people write, mapped to a word that appears in the issuer
// name the BIN and routing directories return.
const ISSUERS = [
  ['chase', 'chase'], ['jpmorgan', 'chase'], ['bank of america', 'bank of america'], ['wells fargo', 'wells fargo'],
  ['citibank', 'citi'], ['citi', 'citi'], ['capital one', 'capital one'], ['us bank', 'u.s. bank'], ['u.s. bank', 'u.s. bank'],
  ['pnc', 'pnc'], ['truist', 'truist'], ['td bank', 'td bank'],
  ['barclays', 'barclays'], ['hsbc', 'hsbc'], ['goldman sachs', 'goldman'], ['synchrony', 'synchrony'],
  ['navy federal', 'navy federal'], ['usaa', 'usaa'], ['santander', 'santander'], ['citizens', 'citizens'],
];

export function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

// ABA routing check digit: weights 3, 7, 1 over the nine digits, and the
// first two digits must be a real Federal Reserve prefix (00 to 32, or
// 61 to 72 for electronic and thrift numbers).
export function abaValid(rn) {
  if (!/^\d{9}$/.test(rn)) return false;
  const d = rn.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  const prefix = Number(rn.slice(0, 2));
  return sum % 10 === 0 && (prefix <= 32 || (prefix >= 61 && prefix <= 72) || prefix === 80);
}

function claimedIssuer(text) {
  const lower = text.toLowerCase();
  const hit = ISSUERS.find(([name]) => new RegExp(`\\b${name.replace(/[.]/g, '\\.')}\\b`).test(lower));
  if (hit) {
    const at = lower.indexOf(hit[0]);
    return { label: text.slice(at, at + hit[0].length), key: hit[1] };
  }
  const m = text.match(/\bissued by\s+(?:the\s+)?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
  if (m) return { label: m[1], key: m[1].toLowerCase().replace(/\s+bank$/, '') };
  return null;
}

function claimedNetwork(text) {
  const lower = text.toLowerCase();
  return NETWORK_RULES.map((r) => r.name).find((n) => lower.includes(n.toLowerCase())) ?? null;
}

async function getJsonQuiet(url, headers = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// BIN directory: HandyAPI first (no key), binlist.net second.
async function lookupBin(bin) {
  const h = await getJsonQuiet(`https://data.handyapi.com/bin/${bin}`);
  if (h && h.Status === 'SUCCESS' && h.Scheme) {
    return { scheme: h.Scheme, issuer: h.Issuer || null, type: h.Type || null, country: h.Country?.Name || null, source: 'HandyAPI BIN directory' };
  }
  const b = await getJsonQuiet(`https://lookup.binlist.net/${bin}`, { 'Accept-Version': '3' });
  if (b && (b.scheme || b.bank?.name)) {
    return { scheme: b.scheme || null, issuer: b.bank?.name || null, type: b.type || null, country: b.country?.name || null, source: 'binlist.net' };
  }
  return null;
}

async function lookupRouting(rn) {
  const j = await getJsonQuiet(`https://bankrouting.io/api/v1/aba/${rn}`);
  if (j?.status === 'success' && j.data?.bank_name) return { bank: j.data.bank_name, city: j.data.city || null, state: j.data.state || null };
  return null;
}

const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bN\.a\b/g, 'N.A');

// Answers a free-text verification question in one pass: card digits
// (network, directory issuer, Luhn for full numbers), a routing number
// (check digit and bank), last four digits, or a processor token, and
// checks each claim the question makes (network, issuing bank) against
// what was found. Returns null when the text holds none of these.
export async function verifyFromQuestion(text) {
  const routingMatch = text.match(ROUTING_RE);
  const routing = routingMatch ? routingMatch[1] : null;
  const cardDigits = [...text.matchAll(CARD_DIGITS_RE)]
    .map((m) => m[0].replace(/[ -]/g, ''))
    .filter((d) => d !== routing && d.length >= 6);
  const card = cardDigits[0] ?? null;
  const last4m = text.match(LAST4_RE);
  const last4 = last4m ? (last4m[1] || last4m[2]) : null;
  const token = text.match(TOKEN_RE)?.[0] ?? null;
  if (!card && !routing && !last4 && !token) return null;

  const issuerClaim = claimedIssuer(text);
  const networkClaim = claimedNetwork(text);
  const problemsList = [];
  const facts = [];
  const out = {
    network: null, issuing_bank: null, issuing_country: null, card_type: null, luhn_valid: null,
    routing_number: routing, routing_valid: null, routing_bank: null, sources: [],
  };

  if (card) {
    const network = identifyNetwork(card);
    const info = (card.length >= 8 ? await lookupBin(card.slice(0, 8)) : null) ?? await lookupBin(card.slice(0, 6));
    const scheme = network || (info?.scheme ? titleCase(info.scheme) : null);
    out.network = scheme;
    out.issuing_bank = info?.issuer ?? null;
    out.issuing_country = info?.country ?? null;
    out.card_type = info?.type ?? null;
    out.sources.push('ISO/IEC 7812 BIN prefix table');
    if (info) out.sources.push(info.source);
    const label = card.length >= 12 ? `Card number ${card.slice(0, 6)}...${card.slice(-4)}` : `BIN ${card}`;
    if (!scheme) {
      problemsList.push(`${label} does not fall in any published card network range`);
    } else {
      const issuerText = info?.issuer ? ` issued by ${titleCase(info.issuer)}${info.country ? ` (${info.country})` : ''}` : '';
      const typeText = info?.type ? `, a ${String(info.type).toLowerCase()} card` : '';
      facts.push(`${label} is a ${scheme} number${issuerText}${typeText}${info ? `, per the ${info.source}` : ''}.`);
      if (networkClaim && networkClaim !== scheme) problemsList.push(`${label} is a ${scheme} number, not ${networkClaim}`);
    }
    if (issuerClaim) {
      if (!info?.issuer) {
        facts.push(`No BIN directory record names the issuer, so the claim that ${issuerClaim.label} issued it cannot be confirmed.`);
      } else if (!info.issuer.toLowerCase().includes(issuerClaim.key)) {
        problemsList.push(`the BIN directory lists ${titleCase(info.issuer)} as the issuer, not ${issuerClaim.label}`);
      } else {
        facts.push(`That matches the issuer named in the question (${issuerClaim.label}).`);
      }
    }
    if (card.length >= 12) {
      out.luhn_valid = luhnValid(card);
      if (!out.luhn_valid) problemsList.push('the full card number fails the Luhn check digit, so it is not a valid card number');
      else facts.push('The full number passes the Luhn check digit.');
    }
  }

  if (routing) {
    out.routing_valid = abaValid(routing);
    out.sources.push('ABA check digit rule');
    if (!out.routing_valid) {
      problemsList.push(`routing number ${routing} fails the ABA check digit, so it is not a valid ACH routing number`);
    } else {
      const bank = await lookupRouting(routing);
      if (bank) {
        out.routing_bank = bank.bank;
        out.sources.push('bankrouting.io ABA directory');
      }
      const where = bank ? ` and belongs to ${titleCase(bank.bank)}${bank.city ? ` (${titleCase(bank.city)}, ${bank.state})` : ''}` : '';
      facts.push(`Routing number ${routing} passes the ABA check digit${where}, so it is a well-formed ACH routing number.`);
    }
  }

  if (!card && last4) {
    facts.push(`Millions of cards end in ${last4}; the network and issuer are encoded in the first 6 to 8 digits (the BIN), not the last four${issuerClaim ? `, so nothing here ties the card to ${issuerClaim.label}` : ''}.`);
  }
  if (!card && token) {
    const placeholder = /^tok_/.test(token) && token.length < 20;
    facts.push(`${token} is in Stripe's token format${placeholder ? ', though real Stripe tokens are about 24 random characters after "tok_", so this looks like a placeholder' : ''}. A token can only be looked up by the merchant account that created it, and it does not reveal the issuing bank.`);
  }

  const live = 'Whether it is active and funded can only be confirmed by the issuer or a payment processor.';
  let verdict;
  let lead;
  if (problemsList.length) {
    verdict = 'invalid';
    lead = `No, it does not check out: ${problemsList.join('; ')}.`;
  } else if (card || routing) {
    verdict = 'valid_format';
    lead = 'Partly verified: the numbers given are real and well-formed.';
  } else {
    verdict = 'unverifiable';
    const what = last4 && !token ? `a card ending in ${last4}` : `the token ${token}`;
    lead = `Cannot be verified from what was given: ${what} carries no checkable network, issuer or status information.`;
  }
  const next = !card && (last4 || token) ? ' Send the first 6 to 8 card digits (the BIN) to check network and issuer.' : '';
  const summary = `${lead} ${facts.join(' ')} ${live}${next}`.replace(/\s+/g, ' ').trim();
  return {
    verdict, summary, sources: out.sources, ...out,
    last4, token, claimed_issuer: issuerClaim?.label ?? null, claimed_network: networkClaim,
  };
}

function identifyNetwork(digits) {
  const rule = NETWORK_RULES.find((r) => r.test(digits));
  return rule ? rule.name : null;
}

function detectApp(text) {
  const lower = text.toLowerCase();
  return PAYMENT_APPS.find((app) => lower.includes(app)) ?? null;
}

async function fetchBinlist(bin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BINLIST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://lookup.binlist.net/${bin}`, {
      signal: controller.signal,
      headers: { 'Accept-Version': '3' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handlePaymentMethodVerify(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawInput = firstUsableValue(
    params?.card_number, params?.bin, params?.card, params?.payment_method,
    params?.query, params?.q, params?.question, params?.text, params?.input,
  );

  if (!rawInput) {
    return respondUnusableInput(
      res,
      'I cannot verify a payment method because none was supplied. Pass a card network name, the leading 6-8 digits of a card number (BIN), or a payment app name as the payment_method parameter.',
    );
  }

  const text = String(rawInput).trim().slice(0, MAX_INPUT_CHARS);
  if (!/[a-z0-9]/i.test(text)) {
    return respondUnusableInput(res, `No usable payment method description was found in ${quoteParam(rawInput)}. Pass a card network name, a BIN, or a payment app name.`);
  }

  // Whole questions (several words) go through the claim checker, which
  // also handles routing numbers, last four digits and tokens.
  if (text.split(/\s+/).length > 3 || ROUTING_RE.test(text) || LAST4_RE.test(text) || TOKEN_RE.test(text)) {
    const r = await verifyFromQuestion(text);
    if (r) {
      const { summary, verdict, sources, ...fields } = r;
      return res.json({
        status: 'ok',
        summary,
        answer: summary,
        verdict,
        valid: verdict === 'invalid' ? false : verdict === 'valid_format' ? true : null,
        ...fields,
        confidence: verdict === 'unverifiable' ? 0.7 : 0.85,
        canonical: ['payment-method-verify', verdict, fields.network ? fields.network.toLowerCase().replace(/\s+/g, '-') : 'none'].join(':'),
        source: [...new Set(sources)].join(' + '),
        can_verify_live_status: false,
        checked_at: new Date().toISOString(),
      });
    }
  }

  const digitsMatch = text.match(BIN_RE);
  const app = detectApp(text);

  if (digitsMatch) {
    const digits = digitsMatch[1];
    const network = identifyNetwork(digits);
    if (!network) {
      return res.json({
        query: text,
        status: 'ok',
        summary: `The digits "${digits}" do not match any known card network's published BIN (Bank Identification Number, the first 6-8 digits of a card) prefix range, so no card network can be identified from this. Full card validity cannot be confirmed without live processor access.`,
        confidence: 0.3,
        canonical: ['payment-method-verify', 'unknown', digits].join(':'),
        network: null,
        source: 'ISO/IEC 7812 BIN prefix table',
        can_verify_live_status: false,
        checked_at: new Date().toISOString(),
      });
    }

    const bin = digits.slice(0, 8);
    const enrichment = digits.length >= 6 ? await fetchBinlist(bin.slice(0, 6)) : null;
    const bankNote = enrichment?.bank?.name ? ` The issuing bank on record for this BIN is ${enrichment.bank.name}${enrichment.country?.name ? ` (${enrichment.country.name})` : ''}.` : '';

    return res.json({
      query: text,
      status: 'ok',
      summary: `The digits "${digits}" match ${network}'s published BIN prefix range, so this is identifiable as a ${network} card.${bankNote} `
        + 'This confirms the card network only. Whether the card itself is active, valid, or has funds cannot be confirmed without live payment-processor access, which this endpoint does not have.',
      confidence: 0.8,
      canonical: ['payment-method-verify', network.toLowerCase().replace(/\s+/g, '-'), digits].join(':'),
      network,
      issuing_bank: enrichment?.bank?.name ?? null,
      issuing_country: enrichment?.country?.name ?? null,
      card_type: enrichment?.type ?? null,
      source: enrichment ? 'ISO/IEC 7812 BIN prefix table + binlist.net' : 'ISO/IEC 7812 BIN prefix table',
      can_verify_live_status: false,
      checked_at: new Date().toISOString(),
    });
  }

  const networkNameMatch = NETWORK_RULES.map((r) => r.name).find((name) => text.toLowerCase().includes(name.toLowerCase()));
  if (networkNameMatch) {
    return res.json({
      query: text,
      status: 'ok',
      summary: `${networkNameMatch} is a recognized card network. Confirming a specific card as a ${networkNameMatch} card, or its live validity, requires either the card's BIN (leading digits) or live processor access, which this endpoint does not have.`,
      confidence: 0.6,
      canonical: ['payment-method-verify', networkNameMatch.toLowerCase().replace(/\s+/g, '-'), 'name-only'].join(':'),
      network: networkNameMatch,
      source: 'known card network names',
      can_verify_live_status: false,
      checked_at: new Date().toISOString(),
    });
  }

  if (app) {
    return res.json({
      query: text,
      status: 'ok',
      summary: `${app} is a recognized payment method/app. This confirms it as a known payment method by name only; whether a specific account or transaction on it is valid, active, or funded cannot be confirmed without live access to that provider's systems, which this endpoint does not have.`,
      confidence: 0.55,
      canonical: ['payment-method-verify', app.replace(/\s+/g, '-'), 'app'].join(':'),
      network: null,
      payment_app: app,
      source: 'known payment app names',
      can_verify_live_status: false,
      checked_at: new Date().toISOString(),
    });
  }

  return respondUnusableInput(res, `No recognizable card network, BIN, or payment app name was found in ${quoteParam(rawInput)}. Pass a card network name, the leading 6-8 digits of a card number, or a payment app name.`);
}

router.get('/', handlePaymentMethodVerify);
router.post('/', handlePaymentMethodVerify);

export default router;
