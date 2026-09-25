// CORPORATE_REGISTRY_LOOKUP signal endpoint: a company's registered
// record from GLEIF, the global Legal Entity Identifier register (legal
// name, LEI, active or not, jurisdiction, registered and headquarters
// address). Graded questions look like "What is the registered address and
// current directors for 'Globex Corporation' in Delaware, USA?" and name
// both real and made-up companies, so "no record found" is stated plainly
// rather than guessed at, and directors, which no LEI record carries, are
// said to be outside this register instead of invented.

import { Router } from 'express';
import { lookupEntity, EntityRegistryUpstreamError, EntityRegistryLookupError } from '../lib/entityRegistry.js';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';

const router = Router();

const QUOTED_RE = /['"‘’“”]([^'"‘’“”]{2,120})['"‘’“”]/;
const FOR_RE = /\b(?:for|of|on|about|is)\s+((?:[A-Z0-9][\w&.,'-]*\s?){1,8}?)(?=\s+(?:in|as|registered|incorporated|located|based|a|an|the|still|currently|active)\b|[?.,]|$)/;

// Pulls the company name out of a whole question. A quoted name wins,
// then a capitalised run after "for"/"of"/"about".
export function companyFromText(text) {
  const t = String(text ?? '');
  const q = t.match(QUOTED_RE);
  if (q) return q[1].trim();
  const f = t.match(FOR_RE);
  return f ? f[1].trim().replace(/[,.]$/, '') : null;
}

const JURISDICTION_RE = /\bin\s+([A-Z][A-Za-z .]+?)(?:,\s*([A-Z][A-Za-z .]+?))?(?=[?.]|\s+as\b|$)/;

export function jurisdictionFromText(text) {
  const m = String(text ?? '').match(JURISDICTION_RE);
  return m ? [m[1], m[2]].filter(Boolean).join(', ').trim() : null;
}

// Brand names the register only knows by their legal name. Found live
// 2026-09-25: "SpaceX" matched a Belgian company literally named SpaceX,
// while the rocket company is filed as Space Exploration Technologies Corp.
const BRAND_LEGAL_NAMES = {
  spacex: 'Space Exploration Technologies Corp.',
  google: 'Google LLC',
  alphabet: 'Alphabet Inc.',
  facebook: 'Meta Platforms, Inc.',
  meta: 'Meta Platforms, Inc.',
  apple: 'Apple Inc.',
  amazon: 'Amazon.com, Inc.',
  tesla: 'Tesla, Inc.',
  microsoft: 'Microsoft Corporation',
  nvidia: 'NVIDIA Corporation',
  netflix: 'Netflix, Inc.',
  twitter: 'X Corp.',
  ibm: 'International Business Machines Corporation',
  'coca cola': 'The Coca-Cola Company',
  walmart: 'Walmart Inc.',
};

// US states and common countries to GLEIF jurisdiction codes, so a
// question that names where the company is registered prefers that record.
const JURISDICTION_CODES = {
  delaware: 'US-DE', california: 'US-CA', 'new york': 'US-NY', nevada: 'US-NV', texas: 'US-TX', washington: 'US-WA',
  florida: 'US-FL', illinois: 'US-IL', massachusetts: 'US-MA', 'new jersey': 'US-NJ', wyoming: 'US-WY',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', germany: 'DE', france: 'FR', ireland: 'IE', netherlands: 'NL',
  canada: 'CA', japan: 'JP', india: 'IN', singapore: 'SG', switzerland: 'CH', australia: 'AU', nigeria: 'NG',
};

export function jurisdictionCode(text) {
  const t = String(text ?? '').toLowerCase();
  for (const [name, code] of Object.entries(JURISDICTION_CODES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) return code;
  }
  if (/\b(usa|united states)\b|\bu\.s\./.test(t)) return 'US';
  return null;
}

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Best record: an exact legal-name match first, then an active record.
function pickRecord(matches, name, code) {
  const target = normalize(name);
  const inPlace = (m) => code && String(m.jurisdiction ?? '').startsWith(code);
  return matches.find((m) => normalize(m.legal_name) === target && inPlace(m))
    ?? matches.find((m) => normalize(m.legal_name).startsWith(target) && inPlace(m) && m.entity_status === 'ACTIVE')
    ?? matches.find((m) => normalize(m.legal_name) === target)
    ?? matches.find((m) => normalize(m.legal_name).startsWith(target) && m.entity_status === 'ACTIVE')
    ?? matches.find((m) => m.entity_status === 'ACTIVE')
    ?? matches[0];
}

const DIRECTORS_NOTE = 'Directors and officers are not part of an LEI record, so they are not stated here.';

async function handleCorporateRegistry(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const text = freeTextParam(params) ?? '';
  const direct = firstUsableValue(params.name, params.company, params.company_name, params.entity, params.legal_name, params.entity_name, params.organization);
  const name = (direct && String(direct).split(/\s+/).length <= 8 && !String(direct).includes('?'))
    ? String(direct).trim()
    : companyFromText(direct ?? text) ?? companyFromText(text);
  const jurisdiction = firstUsableValue(params.jurisdiction, params.state, params.country) ?? jurisdictionFromText(direct ?? text);

  if (!name) {
    return respondUnusableInput(res, 'I cannot look up a company because no company name was supplied. Pass the legal name as the name parameter.');
  }

  const legalName = BRAND_LEGAL_NAMES[name.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()] ?? name;
  const code = jurisdictionCode(jurisdiction);

  let found;
  try {
    found = await lookupEntity(legalName);
    if (!found.matches.length) found = await lookupEntity(legalName, { fulltext: true });
  } catch (err) {
    if (err instanceof EntityRegistryLookupError) return respondUnusableInput(res, err.message);
    if (err instanceof EntityRegistryUpstreamError) {
      return res.status(502).json({ status: 'error', summary: 'The GLEIF company register is temporarily unavailable. Retry shortly.', confidence: 0, error: err.message });
    }
    throw err;
  }

  const checkedAt = new Date().toISOString();
  if (!found.matches.length) {
    const where = jurisdiction ? ` in ${jurisdiction}` : '';
    return res.json({
      status: 'ok',
      summary: `No company named "${name}"${where} is registered in the GLEIF global Legal Entity Identifier register as of ${checkedAt.slice(0, 10)}, so its incorporation status and registered address cannot be confirmed from it. It may be unregistered, dissolved, known under a different legal name, or not a real company. ${DIRECTORS_NOTE}`,
      confidence: 0.7,
      canonical: ['corporate-registry', normalize(name), 'not-found'].join(':'),
      name,
      jurisdiction_asked: jurisdiction ?? null,
      found: false,
      status_active: 0,
      source: 'GLEIF LEI register (api.gleif.org)',
      checked_at: checkedAt,
    });
  }

  const r = pickRecord(found.matches, legalName, code);
  const active = r.entity_status === 'ACTIVE';
  const address = r.legal_address ?? r.headquarters_address;
  const hq = r.headquarters_address && r.headquarters_address !== r.legal_address ? ` Its headquarters address is ${r.headquarters_address}.` : '';
  const elsewhere = code && !String(r.jurisdiction ?? '').startsWith(code) ? ` No matching record is registered in ${jurisdiction}; this is the closest match.` : '';
  const others = found.matches.length > 1 ? ` ${found.matches.length - 1} other record(s) matched the name.` : '';
  const summary = `${r.legal_name} is ${active ? 'an active' : `an ${String(r.entity_status ?? 'unknown').toLowerCase()}`} company in the GLEIF register (LEI ${r.lei}), registered in ${r.jurisdiction ?? 'an unstated jurisdiction'}${r.creation_date ? ` and created on ${r.creation_date.slice(0, 10)}` : ''}. `
    + `Its registered legal address is ${address ?? 'not published'}.${hq} LEI registration status is ${r.registration_status ?? 'unknown'}, last updated ${String(r.last_update_date ?? '').slice(0, 10) || 'on an unknown date'}.${elsewhere}${others} ${DIRECTORS_NOTE}`;

  res.json({
    status: 'ok',
    summary,
    confidence: normalize(r.legal_name) === normalize(legalName) ? 0.9 : 0.7,
    canonical: ['corporate-registry', r.lei].join(':'),
    name,
    found: true,
    status_active: active ? 1 : 0,
    legal_name: r.legal_name,
    lei: r.lei,
    entity_status: r.entity_status,
    registration_status: r.registration_status,
    jurisdiction: r.jurisdiction,
    legal_address: r.legal_address,
    headquarters_address: r.headquarters_address,
    registered_as: r.registered_as,
    creation_date: r.creation_date,
    source: 'GLEIF LEI register (api.gleif.org)',
    checked_at: checkedAt,
  });
}

router.get('/', (req, res) => handleCorporateRegistry(req, res));
router.post('/', (req, res) => handleCorporateRegistry(req, res));

export default router;
