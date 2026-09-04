import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetDefiLlamaCache } from '../lib/defiLlamaApi.js';
import { resetCoinPaprikaCache } from '../lib/coinPaprikaApi.js';

function startServer(t) {
  resetCoinPaprikaCache();
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// /crypto-price's chain_token mode only ever calls coins.llama.fi (prices
// live on a different DefiLlama host than TVL) — asserting the exact host
// here would have caught the 2026-08-18 host-mismatch bug (code was
// hardcoded to api.llama.fi, which 404s for /prices/current/*) without
// needing a live deploy to surface it.
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url !== 'string' || !url.includes('llama.fi')) {
      return original(url, ...rest);
    }
    if (!url.startsWith('https://coins.llama.fi/')) {
      throw new Error(`expected /crypto-price to call coins.llama.fi, got ${url}`);
    }
    return handler(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

// coin_id mode races CoinPaprika and DefiLlama (see checkCryptoPrice.js
// header comment) — mocks both hosts so tests stay hermetic instead of
// hitting real APIs. A test that doesn't pass a `coinpaprika` handler gets
// the "no exact match" shape by default (empty search results -> no
// resolution), since CoinPaprika is the preferred source and most
// existing tests are specifically about the other one. `coinpaprika`
// mocks the resolution call (/v1/search/?q=...&c=currencies) CoinPaprika's
// client makes to turn a coin_id into a real asset id — see
// coinPaprikaApi.js's searchExactAsset.
function mockFetchWithCoinGecko(t, { coinpaprika, coinpaprikaTicker, defillama } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/search/')) {
      if (coinpaprika) return coinpaprika(url, ...rest);
      return { status: 200, json: async () => ({ currencies: [] }) };
    }
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/tickers/')) {
      if (!coinpaprikaTicker) throw new Error(`unexpected CoinPaprika ticker call in this test: ${url}`);
      return coinpaprikaTicker(url, ...rest);
    }
    if (typeof url === 'string' && url.startsWith('https://coins.llama.fi/')) {
      if (!defillama) throw new Error('unexpected DefiLlama call in this test');
      return defillama(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const TOKEN = '0x' + 'a'.repeat(40);

test('crypto-price: missing all params rejected before any call', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('crypto-price: coin_id and price_chain/token both supplied answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin&price_chain=ethereum&token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

// "ethereum" used to be the case here. It now resolves as a coin instead,
// see the recovery tests at the end of this file, so this keeps the same
// assertion on a chain name that is not also a coin.
test('crypto-price: price_chain without token answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=base`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('crypto-price: malformed token address answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum&token=not-an-address`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('crypto-price: successful coin_id lookup uses CoinPaprika', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({
        currencies: [
          { id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 },
          { id: 'bitcoin-bitcoin', symbol: 'BITCOIN', is_active: true, rank: 10622 },
        ],
      }),
    }),
    coinpaprikaTicker: async (url) => {
      assert.equal(url, 'https://api.coinpaprika.com/v1/tickers/btc-bitcoin');
      return {
        status: 200,
        json: async () => ({
          symbol: 'BTC',
          last_updated: '2026-08-29T02:01:24Z',
          quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
        }),
      };
    },
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_usd, 77807.55);
  assert.equal(body.symbol, 'BTC');
  assert.equal(body.price_source, 'coinpaprika');
  assert.equal(body.change_24h_pct, -2.68);
  assert.equal(body.market_cap_usd, 1562110242633);
});

test('crypto-price: multi-source summary names the sources that actually answered', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({ currencies: [{ id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 }] }),
    }),
    coinpaprikaTicker: async () => ({
      status: 200,
      json: async () => ({
        symbol: 'BTC',
        last_updated: '2026-08-29T02:01:24Z',
        quotes: { USD: { price: 77801.51, market_cap: 1561989416378, percent_change_24h: -2.7 } },
      }),
    }),
    coingecko: async () => ({ status: 500, statusText: 'Internal Server Error' }),
    defillama: async () => ({
      status: 200,
      json: async () => ({ coins: { 'coingecko:bitcoin': { price: 77776.27, symbol: 'BTC', timestamp: 1787090000 } } }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  const body = await res.json();
  assert.equal(body.price_source, 'coinpaprika');
  assert.match(body.summary, /CoinPaprika and DefiLlama currently report a range/);
  assert.doesNotMatch(body.summary, /CoinGecko/);
});

test('crypto-price: CoinPaprika slug collision resolves to the lower-rank (dominant) asset', async (t) => {
  resetDefiLlamaCache();
  let requestedId = null;
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({
        currencies: [
          { id: 'bitcoin-bitcoin', symbol: 'BITCOIN', is_active: true, rank: 10622 },
          { id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 },
        ],
      }),
    }),
    coinpaprikaTicker: async (url) => {
      requestedId = url;
      return {
        status: 200,
        json: async () => ({
          symbol: 'BTC',
          last_updated: '2026-08-29T02:01:24Z',
          quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
        }),
      };
    },
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  assert.equal(requestedId, 'https://api.coinpaprika.com/v1/tickers/btc-bitcoin');
});

test('crypto-price: CoinPaprika failure falls back to DefiLlama', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    // Default (no `coinpaprika` handler) -> empty search results -> no
    // resolution -> CoinPaprikaNotFoundError, exercising the fallback.
    defillama: async () => ({
      status: 200,
      json: async () => ({
        coins: { 'coingecko:bitcoin': { price: 64100, symbol: 'BTC', timestamp: 1787090000 } },
      }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_usd, 64100);
  assert.equal(body.symbol, 'BTC');
  assert.equal(body.price_source, 'defillama');
});

test('crypto-price: one ether is Ethereum, not the ONE token', async (t) => {
  resetDefiLlamaCache();
  let searchedFor = null;
  mockFetchWithCoinGecko(t, {
    coinpaprika: async (url) => {
      searchedFor = new URL(url).searchParams.get('q');
      return {
        status: 200,
        json: async () => ({ currencies: [{ id: 'eth-ethereum', symbol: 'ETH', is_active: true, rank: 2 }] }),
      };
    },
    coinpaprikaTicker: async () => ({
      status: 200,
      json: async () => ({
        symbol: 'ETH',
        last_updated: '2026-09-02T16:00:00Z',
        quotes: { USD: { price: 2398.18, market_cap: 1, percent_change_24h: 0 } },
      }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=${encodeURIComponent('How much is one ether worth in dollars?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(searchedFor, 'ethereum');
  assert.equal(body.symbol, 'ETH');
  assert.equal(body.price_usd, 2398.18);
});

test('crypto-price: a slow secondary source does not delay a good answer', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => new Promise((resolve) => setTimeout(() => resolve({
      status: 200,
      json: async () => ({ currencies: [] }),
    }), 1_000)),
    defillama: async () => ({
      status: 200,
      json: async () => ({
        coins: { 'coingecko:bitcoin': { price: 64100, symbol: 'BTC', timestamp: 1787090000 } },
      }),
    }),
  });
  const base = startServer(t);
  const startedAt = Date.now();

  const body = await (await fetch(`${base}/crypto-price?coin_id=bitcoin`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_source, 'defillama');
  assert.ok(Date.now() - startedAt < 750, 'a good price should not wait for the slow source');
});

test('crypto-price: successful chain_token lookup', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      coins: { [`ethereum:${TOKEN}`]: { price: 1.0, symbol: 'USDC', timestamp: 1787090150 } },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?price_chain=ethereum&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'chain_token');
  assert.equal(body.price_usd, 1.0);
});

test('crypto-price: unknown coin returns not_found, not an error', async (t) => {
  resetDefiLlamaCache();
  // Default (no `coinpaprika` handler) -> no resolution; DefiLlama also
  // doesn't recognize the id.
  mockFetchWithCoinGecko(t, {
    defillama: async () => ({ status: 200, json: async () => ({ coins: {} }) }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=not-a-real-coin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.price_usd, null);
});


// The exact request live traffic sent twice every two hours through
// 2026-09-02 and 03, refused every time before this. See the
// CHAIN_NAME_COIN_IDS comment in checkCryptoPrice.js for the root cause.
function mockEthPrice(t) {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({ currencies: [{ id: 'eth-ethereum', symbol: 'ETH', is_active: true, rank: 2 }] }),
    }),
    coinpaprikaTicker: async (url) => {
      assert.equal(url, 'https://api.coinpaprika.com/v1/tickers/eth-ethereum');
      return {
        status: 200,
        json: async () => ({
          symbol: 'ETH',
          last_updated: '2026-09-03T09:00:00Z',
          quotes: { USD: { price: 2544.19, market_cap: 306000000000, percent_change_24h: 1.5 } },
        }),
      };
    },
  });
}

test('crypto-price: a bare price_chain=ethereum is priced as the coin, not refused', async (t) => {
  mockEthPrice(t);
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.notEqual(body.status, 'invalid_input');
  assert.equal(body.symbol, 'ETH');
  assert.equal(body.price_usd, 2544.19);
  assert.equal(body.query_type, 'coin_id');
  assert.match(body.summary, /\$2,544\.19 USD/);
});

test('crypto-price: an empty token alongside price_chain=ethereum is treated the same', async (t) => {
  mockEthPrice(t);
  const base = startServer(t);
  const body = await (await fetch(`${base}/crypto-price?price_chain=ethereum&token=`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.symbol, 'ETH');
});

test('crypto-price: a chain that is not a coin still gets the honest refusal', async (t) => {
  const base = startServer(t);
  for (const chain of ['base', 'polygon', 'linea', 'scroll']) {
    const body = await (await fetch(`${base}/crypto-price?price_chain=${chain}`)).json();
    assert.equal(body.status, 'invalid_input', chain);
  }
});

test('crypto-price: a real contract lookup is untouched by the recovery', async (t) => {
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ coins: { [`ethereum:${TOKEN}`]: { price: 1.0005, symbol: 'USDC', timestamp: 1756900000 } } }) }));
  const base = startServer(t);
  const body = await (await fetch(`${base}/crypto-price?price_chain=ethereum&token=${TOKEN}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'chain_token');
  assert.equal(body.symbol, 'USDC');
});

// The live bug this covers: on 2026-09-04 the deployed miner answered
// invalid_input to symbol=BTC and asset=bitcoin at HTTP 200, so the miss was
// never booked as a failure and CRYPTO_PRICE scored near zero across epochs
// 307 and 308 with an empty failure_reason. Every competing CRYPTO_PRICE
// miner accepts at least one of these names.
function mockBitcoin(t) {
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({ currencies: [{ id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 }] }),
    }),
    coinpaprikaTicker: async () => ({
      status: 200,
      json: async () => ({
        symbol: 'BTC',
        last_updated: '2026-09-04T02:01:24Z',
        quotes: { USD: { price: 79694.28, market_cap: 1600243864692, percent_change_24h: -1.88 } },
      }),
    }),
  });
}

test('crypto-price: the asset can arrive under an alias instead of coin_id', async (t) => {
  for (const key of ['symbol', 'asset', 'coin', 'ticker', 'coin_symbol', 'token_symbol', 'crypto']) {
    await t.test(key, async (t2) => {
      resetDefiLlamaCache();
      mockBitcoin(t2);
      const base = startServer(t2);
      const body = await (await fetch(`${base}/crypto-price?${key}=bitcoin`)).json();
      assert.equal(body.status, 'ok', key);
      assert.equal(body.price_usd, 79694.28, key);
      assert.equal(body.symbol, 'BTC', key);
    });
  }
});

test('crypto-price: an alias holding a whole question reduces to the coin', async (t) => {
  resetDefiLlamaCache();
  mockBitcoin(t);
  const base = startServer(t);
  const body = await (await fetch(`${base}/crypto-price?asset=${encodeURIComponent('what is bitcoin worth right now')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.symbol, 'BTC');
});

test('crypto-price: a contract lookup is untouched when an alias is also present', async (t) => {
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ coins: { [`ethereum:${TOKEN}`]: { price: 1.0005, symbol: 'USDC', timestamp: 1756900000 } } }) }));
  const base = startServer(t);
  // price_chain + token is a complete contract lookup. An alias alongside it
  // must not turn this into the two-modes-at-once refusal.
  const body = await (await fetch(`${base}/crypto-price?price_chain=ethereum&token=${TOKEN}&symbol=USDC`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'chain_token');
});

test('crypto-price: currency is not read as the asset', async (t) => {
  const base = startServer(t);
  // `currency` holds the quote currency, not the thing being priced. Reading
  // it as a coin name would answer a question nobody asked.
  const body = await (await fetch(`${base}/crypto-price?currency=usd`)).json();
  assert.equal(body.status, 'invalid_input');
});

test('crypto-price: a refusal no longer claims full confidence', async (t) => {
  const base = startServer(t);
  const body = await (await fetch(`${base}/crypto-price`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.ok(body.confidence < 0.5, `expected a low confidence on a non-answer, got ${body.confidence}`);
});
