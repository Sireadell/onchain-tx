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
