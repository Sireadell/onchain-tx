// Whether Apple still sells a given iPhone model or Mac chip new on
// apple.com, read from Apple's own store pages (the buy-iphone page links
// every model on sale; a MacBook buy page names the chips on sale). Apple
// publishes no unit counts, and the reply says so.

const STORE = 'https://www.apple.com/shop';
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

async function getText(url, ms = 8000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; txlens-miner)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const value = await res.text();
  cache.set(url, { at: Date.now(), value });
  return value;
}

const nice = (slug) => slug.replace(/^iphone-/, 'iPhone ').replace(/-pro$/, ' Pro').replace(/-air$/, ' Air').replace(/^iPhone air$/, 'iPhone Air').replace(/^iPhone duo$/, 'iPhone Duo');

export function readAppleProduct(text) {
  const t = String(text ?? '');
  if (!/\bapple\b|apple\.com|\biphone\b|\bmacbook\b/i.test(t)) return null;
  const ip = t.match(/\biphone\s+(\d{1,2})(e)?(?:\s+(pro\s+max|pro|plus|mini))?/i);
  if (ip) {
    const tier = (ip[3] ?? '').toLowerCase().replace(/\s+/g, ' ');
    const slug = `iphone-${ip[1]}${ip[2] ? 'e' : ''}${tier.startsWith('pro') ? '-pro' : ''}`;
    const name = `iPhone ${ip[1]}${ip[2] ? 'e' : ''}${ip[3] ? ` ${ip[3].replace(/\b\w/g, (c) => c.toUpperCase())}` : ''}`;
    return { kind: 'iphone', slug, name };
  }
  const mac = t.match(/\bmacbook\s+(pro|air)\b[^.?]*?\b(m\d)(?:\s+(pro|max|ultra))?\b/i);
  if (mac) {
    const line = `macbook-${mac[1].toLowerCase()}`;
    const chip = `${mac[2].toUpperCase()}${mac[3] ? ` ${mac[3][0].toUpperCase()}${mac[3].slice(1).toLowerCase()}` : ''}`;
    return { kind: 'mac', line, chip, name: `MacBook ${mac[1][0].toUpperCase()}${mac[1].slice(1).toLowerCase()} with ${chip}` };
  }
  return null;
}

export async function checkAppleStore(text, { fetchText = getText, now = new Date() } = {}) {
  const p = readAppleProduct(text);
  if (!p) return null;
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const retailer = String(text).match(/\b(best ?buy|amazon(?: india)?|walmart|target|costco)\b/i)?.[1];
  const elsewhere = retailer ? ` ${retailer.replace(/\b\w/g, (c) => c.toUpperCase())} may only have leftover, open-box or refurbished units of a discontinued model, and it publishes no unit count.` : '';
  const noCount = /\bhow many|units|quantity|stock level|maximum\b/i.test(text) ? ' Apple does not publish unit counts, so no quantity is given.' : '';
  if (p.kind === 'iphone') {
    const html = await fetchText(`${STORE}/buy-iphone`);
    const onSale = [...new Set([...html.matchAll(/buy-iphone\/(iphone-[a-z0-9-]+)/g)].map((m) => m[1]))];
    if (!onSale.length) return null;
    const sold = onSale.includes(p.slug);
    const list = onSale.map(nice).join(', ');
    const answer = sold
      ? `Available to order. Apple's online store sells the ${p.name} new right now (it is listed at apple.com/shop/buy-iphone/${p.slug}); colour and storage stock shows at checkout or for store pickup.${noCount} Source: apple.com/shop/buy-iphone, read ${stamp}.`
      : `Discontinued. Apple no longer sells the ${p.name} new on apple.com: its online iPhone store lists only ${list} today, so there are no units to buy there (refurbished or third-party sellers may still have it).${elsewhere}${noCount} Source: apple.com/shop/buy-iphone, read ${stamp}.`;
    return { verdict: sold ? 'In stock' : 'Discontinued', answer, product: p.name, sold_new_by_apple: sold, models_on_sale: onSale.map(nice), source: `${STORE}/buy-iphone`, checked_at: stamp };
  }
  const html = await fetchText(`${STORE}/buy-mac/${p.line}`);
  const text2 = html.replace(/<[^>]+>/g, ' ').replace(/(?:&nbsp;| |\s)+/g, ' ');
  const chips = [...new Set([...text2.matchAll(/\bM\d(?:\s(?:Pro|Max|Ultra))?\b/g)].map((m) => m[0]))];
  if (!chips.length) return null;
  const sold = chips.includes(p.chip);
  const answer = sold
    ? `Available to order. Apple's online store sells the ${p.name} new right now; configuration and delivery dates show at checkout.${noCount} Source: apple.com/shop/buy-mac/${p.line}, read ${stamp}.`
    : `Discontinued. Apple no longer sells the ${p.name} new on apple.com: its ${p.line.replace('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace('Macbook', 'MacBook')} page offers ${chips.join(', ')} today, so there are no new units to buy or deliver from Apple (refurbished or other sellers may still have it).${elsewhere}${noCount} Source: apple.com/shop/buy-mac/${p.line}, read ${stamp}.`;
  return { verdict: sold ? 'In stock' : 'Discontinued', answer, product: p.name, sold_new_by_apple: sold, chips_on_sale: chips, source: `${STORE}/buy-mac/${p.line}`, checked_at: stamp };
}
