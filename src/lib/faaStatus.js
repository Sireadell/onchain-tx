// Live US airport disruption status from the FAA's National Airspace System
// status feed (nasstatus.faa.gov, free, no key): ground stops, ground delay
// programs, arrival and departure delays and closures, per airport.
//
// Scored TRAVEL_DISRUPTION questions ask about named flights between named
// airports ("UA870 from San Francisco to London Heathrow"). Without a live
// source they were answered "Unknown" or with a generic risk guess.

const FEED = 'https://nasstatus.faa.gov/api/airport-status-information';
const TIMEOUT_MS = 6_000;

// Common names to IATA codes. US codes are what the FAA feed reports.
const AIRPORT_NAMES = [
  ['san francisco', 'SFO'], ['oakland', 'OAK'], ['san jose', 'SJC'], ['los angeles', 'LAX'], ['san diego', 'SAN'],
  ["o'hare", 'ORD'], ['ohare', 'ORD'], ['chicago midway', 'MDW'], ['chicago', 'ORD'], ['denver', 'DEN'],
  ['newark', 'EWR'], ['jfk', 'JFK'], ['kennedy', 'JFK'], ['laguardia', 'LGA'], ['new york', 'JFK'],
  ['atlanta', 'ATL'], ['dallas', 'DFW'], ['houston', 'IAH'], ['miami', 'MIA'], ['orlando', 'MCO'],
  ['seattle', 'SEA'], ['boston', 'BOS'], ['washington dulles', 'IAD'], ['dulles', 'IAD'], ['reagan', 'DCA'],
  ['philadelphia', 'PHL'], ['phoenix', 'PHX'], ['las vegas', 'LAS'], ['charlotte', 'CLT'], ['detroit', 'DTW'],
  ['minneapolis', 'MSP'], ['salt lake', 'SLC'], ['honolulu', 'HNL'], ['portland', 'PDX'], ['austin', 'AUS'],
  ['heathrow', 'LHR'], ['gatwick', 'LGW'], ['london', 'LHR'], ['paris', 'CDG'], ['frankfurt', 'FRA'],
  ['amsterdam', 'AMS'], ['tokyo', 'HND'], ['toronto', 'YYZ'], ['dubai', 'DXB'],
];

const US_CODES = new Set(['SFO', 'OAK', 'SJC', 'LAX', 'SAN', 'ORD', 'MDW', 'DEN', 'EWR', 'JFK', 'LGA', 'ATL', 'DFW', 'IAH', 'MIA', 'MCO', 'SEA', 'BOS', 'IAD', 'DCA', 'PHL', 'PHX', 'LAS', 'CLT', 'DTW', 'MSP', 'SLC', 'HNL', 'PDX', 'AUS', 'SNA', 'BWI', 'TPA', 'FLL', 'STL', 'BNA', 'RDU', 'MSY', 'SMF', 'PNS', 'ASE']);
const NOT_AIRPORTS = new Set(['THE', 'AND', 'FOR', 'ARE', 'ANY', 'HAS', 'WAS', 'ITS', 'NOT', 'USA', 'UTC', 'GMT', 'FAA', 'ATC', 'ETA', 'ETD', 'NAS']);

export function airportsFromText(text) {
  const t = String(text ?? '');
  const found = [];
  const add = (c) => { if (!found.includes(c)) found.push(c); };
  for (const m of t.matchAll(/\(([A-Z]{3})\)|\b([A-Z]{3})\b/g)) {
    const code = m[1] ?? m[2];
    if (!NOT_AIRPORTS.has(code) && (m[1] || US_CODES.has(code) || ['LHR', 'LGW', 'CDG', 'FRA', 'AMS', 'HND', 'YYZ', 'DXB'].includes(code))) add(code);
  }
  const lower = t.toLowerCase();
  const hits = AIRPORT_NAMES.map(([name, code]) => ({ i: lower.indexOf(name), name, code })).filter((h) => h.i >= 0);
  // "chicago o'hare" should not also add the generic entry for another name at the same spot.
  hits.sort((a, b) => a.i - b.i || b.name.length - a.name.length);
  let lastEnd = -1;
  for (const h of hits) {
    if (h.i < lastEnd) continue;
    add(h.code);
    lastEnd = h.i + h.name.length;
  }
  return found.slice(0, 4);
}

export function flightFromText(text) {
  return /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/.exec(String(text ?? ''))?.slice(1, 3).join('') ?? null;
}

const tag = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim() ?? null;

export function parseFaaFeed(xml) {
  const updated = tag(xml, 'Update_Time');
  const events = [];
  for (const block of String(xml).split('<Delay_type>').slice(1)) {
    const type = tag(block, 'Name');
    for (const part of block.split(/<(?:Airport|Ground_Delay|Program|Delay)>/).slice(1)) {
      const code = tag(part, 'ARPT');
      if (!code) continue;
      events.push({
        airport: code,
        type,
        reason: tag(part, 'Reason'),
        avg_delay: tag(part, 'Avg'),
        max_delay: tag(part, 'Max'),
        end: tag(part, 'End_Time') ?? tag(part, 'Reopen'),
        trend: tag(part, 'Trend'),
      });
    }
  }
  return { updated, events };
}

export async function fetchFaaStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FEED, { signal: controller.signal, headers: { Accept: 'application/xml' } });
    if (!res.ok) return null;
    return parseFaaFeed(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Closures listed only for non-scheduled general aviation (transient GA)
// do not affect airline flights and are not counted as disruption.
const isGaOnly = (e) => /NON SKED TRANSIENT GA|EXC (?:LIFE FLT|HEL)|HEL OPS/i.test(e.reason ?? '');

export async function assessTravel(text) {
  const airports = airportsFromText(text);
  if (!airports.length) return null;
  const feed = await fetchFaaStatus();
  if (!feed) return null;
  const flight = flightFromText(text);
  const us = airports.filter((a) => US_CODES.has(a));
  const foreign = airports.filter((a) => !US_CODES.has(a));
  const per = us.map((code) => {
    const events = feed.events.filter((e) => e.airport === code && !isGaOnly(e));
    return { airport: code, disrupted: events.length > 0, events };
  });
  const disrupted = per.filter((p) => p.disrupted);
  const describe = (e) => `${e.type}${e.reason ? ` (${e.reason})` : ''}${e.avg_delay ? `, average delay ${e.avg_delay}` : ''}${e.max_delay ? `, up to ${e.max_delay}` : ''}${e.end ? `, until ${e.end}` : ''}`;
  const verdict = disrupted.length ? 'Disrupted' : us.length ? 'Normal operations' : 'Not covered';
  const parts = [];
  if (disrupted.length) {
    parts.push(`Disrupted. The FAA reports ${disrupted.map((p) => `${p.airport}: ${p.events.map(describe).join('; ')}`).join('. ')}.`);
  } else if (us.length) {
    parts.push(`Normal operations. No ground stop, ground delay program, arrival or departure delay, or closure is reported for ${us.join(' or ')} in the FAA National Airspace System status.`);
  } else {
    parts.push(`Not covered. ${foreign.join(' and ')} ${foreign.length === 1 ? 'is' : 'are'} outside the FAA National Airspace System status feed, which covers US airports only.`);
  }
  if (us.length && foreign.length) parts.push(`${foreign.join(' and ')} ${foreign.length === 1 ? 'is' : 'are'} outside the US and not covered by this feed.`);
  parts.push(`FAA status updated ${feed.updated ?? 'at request time'}.`);
  if (flight) parts.push(`Airline-level status for ${flight} (its own delay, cancellation or gate change) is not in this feed and is set by the carrier.`);
  return {
    verdict,
    disrupted: disrupted.length > 0,
    summary: parts.join(' '),
    flight,
    airports,
    airport_status: per.map((p) => ({ airport: p.airport, disrupted: p.disrupted, events: p.events })),
    not_covered: foreign,
    delay_minutes: disrupted.length ? null : 0,
    faa_updated: feed.updated,
    source: 'FAA National Airspace System status (nasstatus.faa.gov)',
  };
}
