// Resolves "<Coin> Up or Down - <date>, <time range> ET" market questions from
// real minute prices instead of a web search. These questions ask whether a
// coin's price at the end of a short window was at or above its price at the
// start, and no news article answers that, so a search always ended in
// "Not yet resolved". Minute candles from Binance's public data mirror answer
// it exactly, with Coinbase as a second source. Anything that does not look
// like this question shape returns null so the caller keeps its web search.

const BINANCE_BASE = process.env.BINANCE_DATA_BASE || 'https://data-api.binance.vision/api/v3';
const COINBASE_BASE = process.env.COINBASE_EXCHANGE_BASE || 'https://api.exchange.coinbase.com';
const REQUEST_TIMEOUT_MS = Number(process.env.UPDOWN_TIMEOUT_MS) || 6_000;

const ASSETS = [
  { re: /\b(bitcoin|btc)\b/i, name: 'Bitcoin', binance: 'BTCUSDT', coinbase: 'BTC-USD' },
  { re: /\b(ethereum|ether|eth)\b/i, name: 'Ethereum', binance: 'ETHUSDT', coinbase: 'ETH-USD' },
  { re: /\b(solana|sol)\b/i, name: 'Solana', binance: 'SOLUSDT', coinbase: 'SOL-USD' },
  { re: /\b(xrp|ripple)\b/i, name: 'XRP', binance: 'XRPUSDT', coinbase: 'XRP-USD' },
  { re: /\b(dogecoin|doge)\b/i, name: 'Dogecoin', binance: 'DOGEUSDT', coinbase: 'DOGE-USD' },
  { re: /\b(bnb|binance coin)\b/i, name: 'BNB', binance: 'BNBUSDT', coinbase: null },
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const QUESTION_RE = /^(.*?)\bup\s+or\s+down\b\s*[-–—:]?\s*(.*)$/i;
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;

// Wall-clock time in America/New_York to a UTC millisecond timestamp,
// honouring daylight saving for that date.
export function easternToUtcMs(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const shown = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  // Offset between New York wall time and UTC at that moment, applied twice so
  // the hour that straddles a clock change still lands correctly.
  let ms = guess - (shown(guess) - guess);
  ms = guess - (shown(ms) - ms);
  return ms;
}

function to24(hour, minute, meridiem, fallbackMeridiem) {
  const m = (meridiem || fallbackMeridiem || '').toLowerCase();
  let h = hour % 12;
  if (m === 'pm') h += 12;
  else if (!m && hour >= 12) h = hour;
  return { h, minute: minute ?? 0 };
}

// Returns { asset, startMs, endMs, label } or null when the text is not an
// up-or-down question this module can resolve.
export function parseUpDownQuestion(text, now = Date.now()) {
  const q = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = q.match(QUESTION_RE);
  if (!m) return null;
  const asset = ASSETS.find((a) => a.re.test(m[1]));
  if (!asset) return null;

  const when = m[2];
  const dateMatch = when.match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'i'));
  if (!dateMatch) return null;
  const month = MONTHS.indexOf(dateMatch[1].toLowerCase());
  const day = Number(dateMatch[2]);
  const year = dateMatch[3] ? Number(dateMatch[3]) : new Date(now).getUTCFullYear();

  // Time text is whatever follows the date, so "28" in "February 28" is not read as an hour.
  const timeText = when.slice(dateMatch.index + dateMatch[0].length).replace(/E[SD]?T|Eastern/gi, '');
  const parsed = [...timeText.matchAll(TIME_RE)]
    .map((t) => ({ hour: Number(t[1]), minute: t[2] === undefined ? null : Number(t[2]), meridiem: t[3] ?? null }))
    .filter((t) => t.hour >= 1 && t.hour <= 24);
  if (!parsed.length) return null;

  const first = to24(parsed[0].hour, parsed[0].minute, parsed[0].meridiem, parsed[parsed.length - 1].meridiem);
  const second = parsed.length >= 2 ? to24(parsed[1].hour, parsed[1].minute, parsed[1].meridiem, parsed[0].meridiem) : null;
  const windowFor = (y) => {
    const startMs = easternToUtcMs(y, month, day, first.h, first.minute);
    let endMs = second ? easternToUtcMs(y, month, day, second.h, second.minute) : startMs + 3_600_000; // one time names the hour that starts then
    if (endMs <= startMs) endMs += 12 * 3_600_000;
    return { startMs, endMs };
  };

  let { startMs, endMs } = windowFor(year);
  // A date without a year most likely means the latest such date that is not in the future.
  if (!dateMatch[3] && startMs > now + 36 * 3_600_000) ({ startMs, endMs } = windowFor(year - 1));
  if (endMs - startMs > 26 * 3_600_000) return null;
  return { asset, startMs, endMs, label: when.trim() };
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'TxLens-Miner/1.0 (public-data research)' } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Minute candles as [{ t, open, close }] covering [startMs, endMs).
async function minuteCandles(asset, startMs, endMs) {
  const errors = [];
  try {
    const url = `${BINANCE_BASE}/klines?symbol=${asset.binance}&interval=1m&startTime=${startMs}&endTime=${endMs - 1}&limit=1000`;
    const rows = await getJson(url);
    const out = rows.map((r) => ({ t: Number(r[0]), open: Number(r[1]), close: Number(r[4]) })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));
    if (out.length) return { source: 'Binance', candles: out };
  } catch (err) {
    errors.push(`Binance: ${err.message}`);
  }
  if (asset.coinbase) {
    try {
      const url = `${COINBASE_BASE}/products/${asset.coinbase}/candles?granularity=60&start=${new Date(startMs).toISOString()}&end=${new Date(endMs - 1).toISOString()}`;
      const rows = await getJson(url);
      const out = rows.map((r) => ({ t: Number(r[0]) * 1000, open: Number(r[3]), close: Number(r[4]) })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close)).sort((x, y) => x.t - y.t);
      if (out.length) return { source: 'Coinbase', candles: out };
    } catch (err) {
      errors.push(`Coinbase: ${err.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'no price data');
}

const money = (n) => `$${n >= 100 ? n.toFixed(2) : n.toPrecision(5)}`;

const fmtEt = (ms) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(ms)).replace(',', '') + ' ET';

// Returns null when the text is not an up-or-down question or the price data
// cannot be read, so the caller falls back to its web search.
export async function resolveCryptoUpDown(text, now = Date.now()) {
  const parsed = parseUpDownQuestion(text, now);
  if (!parsed) return null;
  const { asset, startMs, endMs } = parsed;
  if (endMs > now) {
    return { outcome: 'unresolved', asset: asset.name, summary: `Not yet resolved, the ${asset.name} window from ${fmtEt(startMs)} to ${fmtEt(endMs)} has not finished.`, confidence: 0.7, provider: 'time check' };
  }
  let data;
  try {
    data = await minuteCandles(asset, startMs, endMs);
  } catch {
    return null;
  }
  const first = data.candles[0];
  const last = data.candles[data.candles.length - 1];
  // The first candle must start at the window start, and the last must end at its end.
  if (Math.abs(first.t - startMs) > 60_000 || Math.abs(last.t + 60_000 - endMs) > 60_000) return null;
  const change = last.close - first.open;
  const pct = (change / first.open) * 100;
  const up = change >= 0;
  const outcome = up ? 'up' : 'down';
  return {
    outcome,
    asset: asset.name,
    open: first.open,
    close: last.close,
    change_percent: Math.round(pct * 1000) / 1000,
    summary: `${up ? 'Up' : 'Down'}, ${asset.name} ${up ? 'rose' : 'fell'} from ${money(first.open)} at ${fmtEt(startMs)} to ${money(last.close)} at ${fmtEt(endMs)}, a change of ${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%. The market resolves ${up ? 'Up' : 'Down'} because the end price is ${up ? 'at or above' : 'below'} the start price.`,
    confidence: 0.95,
    provider: data.source,
  };
}
