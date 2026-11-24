// Live stock for a product on a store that runs on Shopify (Allbirds,
// Everlast, Gymshark and many others), read from the store's own public
// product feed: search the catalogue, pick the product, then read whether the
// asked size or variant can be bought right now. Shopify stores publish
// "available" per variant but usually not a unit count, and the reply says so.

const KNOWN = [
  { match: /\ballbirds\b/i, host: 'allbirds.com', name: 'Allbirds' },
  { match: /\beverlast\b/i, host: 'everlast.com', name: 'Everlast' },
  { match: /\bgymshark\b/i, host: 'gymshark.com', name: 'Gymshark' },
  { match: /\bkylie cosmetics\b/i, host: 'kyliecosmetics.com', name: 'Kylie Cosmetics' },
  { match: /\bfashion ?nova\b/i, host: 'fashionnova.com', name: 'Fashion Nova' },
  { match: /\bbrooklinen\b/i, host: 'brooklinen.com', name: 'Brooklinen' },
  { match: /\bbombas\b/i, host: 'bombas.com', name: 'Bombas' },
  { match: /\bmvmt\b/i, host: 'mvmt.com', name: 'MVMT' },
];

const COLOURS = ['black', 'white', 'grey', 'gray', 'natural', 'navy', 'blue', 'red', 'green', 'pink', 'beige', 'brown', 'charcoal', 'cream', 'tan', 'olive', 'purple', 'yellow', 'orange'];

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

async function fetchOnce(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'txlens-miner/1.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Shopify rate limits per caller, so a short cache, one retry, and the www
// host (limited separately) as the second try.
async function getJson(url, ms = 7000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value;
  try { value = await fetchOnce(url, ms); } catch (err) {
    if (!/HTTP (429|5)/.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 1200));
    value = await fetchOnce(url.replace(/^https:\/\/(?!www\.)/, 'https://www.'), ms).catch(() => fetchOnce(url, ms));
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(url, { at: Date.now(), value });
  return value;
}

export function findStore(text) {
  return KNOWN.find((s) => s.match.test(text)) ?? null;
}

export function readAsk(text, store) {
  const t = String(text ?? '');
  const quoted = t.match(/["“'']((?:(?!["”]).){3,80}?)["”'']\s/)?.[1] ?? t.match(/"([^"]{3,80})"/)?.[1];
  let product = quoted ?? t.replace(/^.*?\b(?:is|are|does|can i (?:still )?buy|do you have)\s+(?:the\s+)?/i, '').split(/\b(?:in size|size|available|in stock|on|at|from)\b/i)[0];
  product = product.replace(store?.match ?? /^$/, '').replace(/\s+in\s+[A-Z][\w ]*[,.]?\s*$/, '').replace(/[,.;:]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const size = t.match(/\bsize\s*(?:us\s*)?(\d{1,2}(?:\.5)?|x{0,3}[sml]|xx?l)\b/i)?.[1] ?? t.match(/\bin\s+(?:a\s+)?(\d{1,2}(?:\.5)?)\b(?=[^$]*\b(?:size|shoe|runner|sneaker))/i)?.[1] ?? null;
  const gender = /\bwomen'?s\b/i.test(t) ? 'women' : /\bmen'?s\b/i.test(t) ? 'men' : null;
  const colours = COLOURS.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(t.replace(product, ' ')) || new RegExp(`\\b${c}\\b`, 'i').test(product));
  return { product, size: size ? size.toUpperCase() : null, gender, colours };
}

function pickProduct(results, ask) {
  const score = (p) => {
    const title = String(p.title).toLowerCase();
    let s = 0;
    if (ask.gender === 'men' && /\bmen'?s\b/.test(title) && !/women/.test(title)) s += 3;
    if (ask.gender === 'women' && /women/.test(title)) s += 3;
    if (ask.gender === 'men' && /women/.test(title)) s -= 5;
    for (const c of ask.colours) if (title.includes(c)) s += 2;
    for (const w of ask.product.toLowerCase().split(/\W+/).filter((x) => x.length > 2)) if (title.includes(w.replace(/s$/, ''))) s += 1;
    return s;
  };
  return [...results].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export async function checkShopifyStock(text, { fetchJson = getJson, now = new Date() } = {}) {
  const store = findStore(text);
  if (!store) return null;
  const ask = readAsk(text, store);
  if (!ask.product) return null;
  const q = encodeURIComponent(ask.product.replace(/'/g, ''));
  const search = await fetchJson(`https://${store.host}/search/suggest.json?q=${q}&resources%5Btype%5D=product&resources%5Blimit%5D=8`);
  const results = search?.resources?.results?.products ?? [];
  const hit = pickProduct(results, ask);
  // Every distinctive word of the asked name must be in the title, or it is
  // a different product.
  const need = ask.product.toLowerCase().replace(/'s\b/g, '').split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !['men', 'women', 'mens', 'womens', 'the', 'shoe', 'shoes', 'pair'].includes(w))
    .map((w) => w.replace(/s$/, ''));
  const title = String(hit?.title ?? '').toLowerCase();
  if (!hit || !need.every((w) => title.includes(w))) {
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const answer = `Not found. ${store.name}${store.name.endsWith('s') ? "'" : "'s"} own store search lists no product matching "${ask.product}" right now, so it cannot be bought there at the moment (it may be discontinued or renamed).${results.length ? ` Closest listings: ${results.slice(0, 3).map((p) => `${p.title} (${p.available ? 'available' : 'sold out'})`).join('; ')}.` : ''} Source: ${store.host} store search, read ${stamp}.`;
    return { found: false, verdict: 'Not found', answer, in_stock: false, product: ask.product, store: store.name, checked_at: stamp };
  }
  const prod =await fetchJson(`https://${store.host}/products/${hit.handle}.js`).catch(() => null);
  if (!prod) {
    // The product page feed was not reachable; the search result still says
    // whether the product can be bought at all.
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const url = `https://${store.host}/products/${hit.handle}`;
    const verdict = hit.available ? 'In stock' : 'Out of stock';
    const sizeNote = ask.size ? ` The per-size feed did not answer at request time, so size ${ask.size} on its own could not be confirmed.` : '';
    const answer = `${verdict}. ${store.name} lists the ${hit.title} as ${hit.available ? 'available to buy now' : 'sold out right now'}${hit.price ? ` at $${Number(hit.price).toFixed(2)}` : ''}.${sizeNote} Source: ${store.host} store search (${url}), read ${stamp}.`;
    return { found: true, verdict, answer, in_stock: Boolean(hit.available), product: hit.title, size: ask.size, size_confirmed: false, store: store.name, url, checked_at: stamp };
  }
  const variants = prod?.variants ?? [];
  const sizeIdx = (prod?.options ?? []).findIndex((o) => /size/i.test(typeof o === 'string' ? o : o?.name));
  const valueOf = (v) => (sizeIdx >= 0 ? v.options?.[sizeIdx] ?? v[`option${sizeIdx + 1}`] : v.title);
  const sized = ask.size ? variants.filter((v) => String(valueOf(v)).toUpperCase() === ask.size) : [];
  const availableSizes = [...new Set(variants.filter((v) => v.available).map(valueOf))];
  const price = (sized[0] ?? variants[0])?.price;
  const priceText = price != null ? ` at $${(Number(price) / (String(price).includes('.') ? 1 : 100)).toFixed(2)}` : '';
  const url = `https://${store.host}/products/${hit.handle}`;
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');

  let verdict; let answer;
  if (ask.size && sized.length) {
    const inStock = sized.some((v) => v.available);
    verdict = inStock ? 'In stock' : 'Out of stock';
    answer = inStock
      ? `In stock. ${store.name} lists the ${prod.title} in size ${ask.size} as available to buy now${priceText}.`
      : `Out of stock. ${store.name} lists the ${prod.title} in size ${ask.size} as sold out right now.${availableSizes.length ? ` Sizes it shows as available: ${availableSizes.slice(0, 12).join(', ')}.` : ' No size is available at the moment.'}`;
  } else if (ask.size && !sized.length) {
    verdict = 'Not offered';
    answer = `Not offered. ${store.name}'s ${prod.title} does not come in size ${ask.size}; it is sold in ${variants.map(valueOf).slice(0, 14).join(', ')}${availableSizes.length ? `, of which ${availableSizes.slice(0, 12).join(', ')} are available now` : ''}.`;
  } else {
    const any = Boolean(prod.available ?? variants.some((v) => v.available));
    verdict = any ? 'In stock' : 'Out of stock';
    answer = any
      ? `In stock. ${store.name} lists the ${prod.title} as available to buy now${priceText}${availableSizes.length > 1 ? `, in ${availableSizes.slice(0, 12).join(', ')}` : ''}.`
      : `Out of stock. ${store.name} lists the ${prod.title} as sold out right now.`;
  }
  if (/\bhow many|quantity|units|stock level|maximum\b/i.test(text)) answer += ' The store\'s feed shows whether each variant can be bought, not a unit count, so no quantity is given.';
  answer += ` Source: ${store.host} product feed (${url}), read ${stamp}.`;
  return {
    found: true,
    verdict,
    answer,
    in_stock: verdict === 'In stock',
    product: prod.title,
    size: ask.size,
    available_sizes: availableSizes,
    price: priceText ? priceText.replace(' at ', '') : null,
    store: store.name,
    url,
    checked_at: stamp,
  };
}
