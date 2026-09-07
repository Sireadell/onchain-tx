// Reads a "what was the price on <date>" request out of the query params.
//
// Root cause, found 2026-09-07 in Render request logs: the dispatcher has
// been sending historical price questions to both price endpoints with the
// day in a `date` parameter — GET /stock-price?date=2024-01-15&ticker=NVDA,
// GET /crypto-price?coin_id=bitcoin&date=2023-01-01, and several more over
// 2026-09-04 to 09-07. Neither route read that parameter, so both answered
// with today's price to a question about a past day. That is a confidently
// wrong answer rather than a refusal, which is exactly the "miners were not
// able to answer the prices asked for" the Telegraph team reported, and it
// matches STOCK_PRICE sitting on a flat score of 0.
//
// Deliberately conservative. A date that is today or later, or that cannot
// be read, returns null and the caller keeps its existing current-price
// behaviour, so this can only ever add answers, never replace a working one.

const DATE_KEYS = [
  'date', 'as_of', 'as_of_date', 'asof', 'on', 'on_date', 'day',
  'historical_date', 'price_date', 'timestamp', 'time',
];

// Only shapes with an explicit year are accepted. A bare "15" or "January"
// could mean anything, and guessing a year would invent an answer.
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseValue(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // A unix timestamp, in seconds or milliseconds.
    const ms = raw > 1e11 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  if (/^\d{9,13}$/.test(text)) return parseValue(Number(text));

  const isoDay = text.match(ISO_DAY_RE);
  if (isoDay) {
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Full ISO instants ("2023-01-01T00:00:00Z") and the common written
  // forms ("January 1, 2023", "1 Jan 2023") both parse here. Anything
  // without a four-digit year is rejected above by the guard below.
  if (!/\d{4}/.test(text)) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  // "January 5, 2024" carries no time zone, so it parses as local midnight
  // and lands on the 4th once read back as UTC. A day with no clock time in
  // it means that calendar day everywhere, so rebuild it as UTC midnight.
  if (!/[T:]/.test(text)) {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  }
  return date;
}

// Returns { unixSeconds, isoDay } for a past day, or null when the caller
// is asking about right now.
export function historicalDateParam(params) {
  if (!params || typeof params !== 'object') return null;
  for (const key of DATE_KEYS) {
    if (!(key in params)) continue;
    const date = parseValue(params[key]);
    if (!date) continue;

    const isoDay = date.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // Today and anything ahead of it is the current price, which the
    // existing live-source path already answers better than a historical
    // snapshot would.
    if (isoDay >= today) return null;
    // Nothing priced exists before Bitcoin did, and a stray year like 0001
    // from a mis-parsed string should not become a lookup.
    if (isoDay < '2009-01-01') return null;

    return { unixSeconds: Math.floor(date.getTime() / 1000), isoDay };
  }
  return null;
}
