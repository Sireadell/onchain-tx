import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from './ankrRpc.js';
import { resetBlockscoutCache } from './blockscoutApi.js';
import { detectHandoff, requestText } from './misrouteHandoff.js';

const ADDRESS = `0x${'a'.repeat(40)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => handler(original, url, ...rest);
  t.after(() => { globalThis.fetch = original; });
}

test('handoff: an ETH-held question sent to transaction lookup returns the wallet balance response', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      const { method } = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x1' }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?question=${encodeURIComponent(`How much ETH is held by ${ADDRESS}?`)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.address, ADDRESS);
  assert.equal(body.balance_wei, '1000000000000000000');
  assert.equal(body.tx_hash, undefined);
  assert.equal(body.answer, body.summary);
});

test('handoff: POST transaction lookup preserves the ETH-held wallet handoff', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      const { method } = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x1' }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const response = await fetch(`${base}/check-tx`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: `How much ETH is held by ${ADDRESS}?` }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.address, ADDRESS);
  assert.equal(body.balance_wei, '1000000000000000000');
});

test('handoff: an explicit wallets-hold-contract question sent to transaction lookup returns the holder count response', async (t) => {
  resetBlockscoutCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.includes('.blockscout.com')) {
      return { status: 200, json: async () => ({ holders_count: '1234', symbol: 'TST', name: 'Test Token' }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?question=${encodeURIComponent(`How many wallets hold contract ${ADDRESS}?`)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.token, ADDRESS);
  assert.equal(body.holders_count, 1234);
  assert.equal(body.tx_hash, undefined);
  assert.equal(body.answer, body.summary);
});

test('handoff: a transaction confirmation sent to fraud returns the transaction response', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      const { method } = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: method === 'eth_blockNumber' ? '0x1' : null }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const response = await fetch(`${base}/fraud-query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: `Is transaction ${TX_HASH} confirmed?` }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'not_found');
  assert.equal(body.tx_hash, TX_HASH);
  assert.equal(body.assessment_status, undefined);
  assert.equal(body.answer, body.summary);
});

test('handoff: an IP location question sent to SSL returns the geolocation response', async (t) => {
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://ipinfo.io/')) {
      return { ok: true, json: async () => ({ ip: '8.8.8.8', country: 'US', region: 'California', city: 'Mountain View', loc: '37.4056,-122.0775', timezone: 'America/Los_Angeles', org: 'AS15169 Google LLC' }) };
    }
    if (typeof url === 'string' && url.startsWith('http://ip-api.com/')) {
      return { ok: true, json: async () => ({ status: 'success', query: '8.8.8.8', country: 'United States', countryCode: 'US', regionName: 'California', city: 'Mountain View', isp: 'Google LLC', mobile: false, proxy: false, hosting: true }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/ssl-check?domain=${encodeURIComponent('Where is 8.8.8.8 located?')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.ip, '8.8.8.8');
  assert.match(body.summary, /located in Mountain View/);
  assert.equal(body.valid, undefined);
  assert.equal(body.answer, body.summary);
});

test('handoff: POST SSL lookup and a trailing slash both preserve the IP handoff', async (t) => {
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://ipinfo.io/')) {
      return { ok: true, json: async () => ({ ip: '8.8.8.8', country: 'US', region: 'California', city: 'Mountain View', loc: '37.4056,-122.0775', timezone: 'America/Los_Angeles', org: 'AS15169 Google LLC' }) };
    }
    if (typeof url === 'string' && url.startsWith('http://ip-api.com/')) {
      return { ok: true, json: async () => ({ status: 'success', query: '8.8.8.8', country: 'United States', countryCode: 'US', regionName: 'California', city: 'Mountain View', isp: 'Google LLC', mobile: false, proxy: false, hosting: true }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const response = await fetch(`${base}/ssl-check/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'Where is 8.8.8.8?' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.ip, '8.8.8.8');
  assert.equal(body.valid, undefined);
});

test('handoff: GET assess-wallet preserves the transaction-confirmation handoff', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      const { method } = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: method === 'eth_blockNumber' ? '0x1' : null }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/assess-wallet?question=${encodeURIComponent(`Is transaction ${TX_HASH} confirmed?`)}`)).json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.tx_hash, TX_HASH);
  assert.equal(body.assessment_status, undefined);
});

test('handoff: an address without balance or holder wording stays on transaction lookup', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  let rpcCalled = false;
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      rpcCalled = true;
      throw new Error('should not call RPC');
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?question=${encodeURIComponent(`Tell me about ${ADDRESS}`)}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(rpcCalled, false);
});

test('handoff: an explicit chain stays with the rerouted wallet balance lookup', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (original, url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      assert.match(url, /\/base\//);
      const { method } = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: method === 'eth_getBalance' ? '0x0' : '0x1' }) };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?chain=base&question=${encodeURIComponent(`What balance does ${ADDRESS} hold?`)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.chain, 'base');
  assert.equal(body.answer, body.summary);
});

test('handoff: strict guards reject ambiguous or independently structured requests', () => {
  const addressQuestion = `What balance and holder count does ${ADDRESS} have?`;
  assert.equal(detectHandoff('/check-tx', addressQuestion, { question: addressQuestion }), null);
  assert.equal(detectHandoff('/check-tx', `How many wallets use ${ADDRESS}?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `How many wallets use token ${ADDRESS}?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `How many addresses interacted with contract ${ADDRESS}?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `How many wallets hold ${ADDRESS}?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `How many wallets hold contract ${ADDRESS}?`, {}), 'holders');
  assert.equal(detectHandoff('/check-tx', `How much ETH is held by ${ADDRESS}?`, {}), 'wallet');
  assert.equal(detectHandoff('/check-tx', `Is ${ADDRESS} held by a multisig?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `Was ${ADDRESS} held as collateral?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `Who held ${ADDRESS} before the transfer?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `Is transaction ${TX_HASH} confirmed for ${ADDRESS} balance?`, {}), null);
  assert.equal(detectHandoff('/ssl-check', 'Where should I look up 8.8.8.8?', {}), null);
  assert.equal(detectHandoff('/ssl-check', 'Where is 8.8.8.8?', {}), 'ip');
  assert.equal(detectHandoff('/ssl-check', 'What country is 8.8.8.8 in?', {}), 'ip');
  assert.equal(detectHandoff('/check-tx', `What balance does ${ADDRESS} hold?`, { tx_hash: TX_HASH }), null);
  assert.equal(detectHandoff('/ssl-check', 'Where is 8.8.8.8?', { domain: 'example.com' }), null);
  assert.equal(detectHandoff('/assess-wallet', `Is transaction ${TX_HASH} confirmed?`, { wallet: ADDRESS }), null);
});

// The four cases below are the real routed questions the misroute watcher
// recorded in production on 2026-08-31, not invented examples. USDC is the
// address the dispatcher used in every one of them.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

test('handoff: a balance question routed to the holder count moves to wallet', () => {
  const text = `What is the wallet balance of ${USDC} on Ethereum?`;
  assert.equal(detectHandoff('/token-holders', text, { q: text }), 'wallet');
});

test('handoff: a holder question routed to the balance moves to holders', () => {
  const text = `How many holders does ${USDC} have?`;
  assert.equal(detectHandoff('/wallet-balance', text, { q: text }), 'holders');
});

test('handoff: "how many wallets hold X" stays on the holder count', () => {
  // Reads like a balance question because of "hold", but it is asking how
  // many addresses hold the token, which is where it already is.
  const text = `How many wallets hold ${USDC} on Ethereum?`;
  assert.equal(detectHandoff('/token-holders', text, { q: text }), null);
});

test('handoff: a unique-address holder question misrouted to balance moves to holders', () => {
  const text = `How many unique addresses currently hold any USDC at ${USDC}?`;
  assert.equal(detectHandoff('/wallet-balance', text, { q: text }), 'holders');
});

test('handoff: unique-address wording without a token cue does not force a holder lookup', () => {
  const text = `How many unique addresses currently hold funds at ${USDC}?`;
  assert.equal(detectHandoff('/wallet-balance', text, { q: text }), null);
});

test('handoff: generic uppercase finance and web3 terms are not treated as token tickers', () => {
  for (const term of ['USD', 'NFT', 'NFTs', 'DEX']) {
    const text = `How many unique addresses currently hold ${term} at ${USDC}?`;
    assert.equal(detectHandoff('/wallet-balance', text, { q: text }), null, term);
  }
});

test('handoff: an ordinary capitalized prose word elsewhere is not a token cue', () => {
  const text = `How many unique addresses hold funds at ${USDC}? Link the evidence.`;
  assert.equal(detectHandoff('/wallet-balance', text, { q: text }), null);
});

test('handoff: a confidently routed call with its own structured field is left alone', () => {
  // The dispatcher sends token or address when it knows the intent. Only the
  // free-text calls are ambiguous enough to be worth moving.
  const text = `What is the wallet balance of ${USDC} on Ethereum?`;
  assert.equal(detectHandoff('/token-holders', text, { token: USDC, q: text }), null);
  const holders = `How many holders does ${USDC} have?`;
  assert.equal(detectHandoff('/wallet-balance', holders, { address: USDC, q: holders }), null);
});

test('handoff: an adverb between "is" and "held by" still reads as a balance question', () => {
  // The live router run on 2026-09-02 sent this exact wording to the holder
  // count. "is currently held by" missed the cue that "is held by" matched,
  // so the question stayed on the wrong endpoint.
  for (const phrasing of ['is currently held by', 'is presently held by', 'is right now held by']) {
    const text = `Without estimating from past transfers, how much ETH ${phrasing} ${ADDRESS}?`;
    assert.equal(detectHandoff('/token-holders', text, { token: text }), 'wallet', phrasing);
  }
});

test('handoff: an adverb does not turn an ambiguous "held" question into a balance lookup', () => {
  assert.equal(detectHandoff('/check-tx', `Is ${ADDRESS} currently held by a multisig?`, {}), null);
  assert.equal(detectHandoff('/check-tx', `Who previously held ${ADDRESS} before the transfer?`, {}), null);
});

test('handoff: a wallet question misrouted to a price intent moves to the balance', () => {
  const text = `Return both human-readable ETH and exact wei for ${ADDRESS} on Ethereum. What is its balance?`;
  assert.equal(detectHandoff('/crypto-price', text, { symbol: text }), 'wallet');
  assert.equal(detectHandoff('/stock-price', text, { symbol: text }), 'wallet');
});

test('handoff: a genuine price question stays on the price intent', () => {
  for (const path of ['/crypto-price', '/stock-price']) {
    for (const text of ['Quote one whole bitcoin in US dollars now.', 'How much does one AAPL share cost now?']) {
      assert.equal(detectHandoff(path, text, { symbol: text }), null, `${path} ${text}`);
    }
  }
});

// The exact request the dispatcher sent to /check-tx twice on 2026-09-03,
// address and all. It was refused for having no transaction hash both times.
const LIVE_FRAUD_QUESTION = 'Intent: FRAUD_DETECTION. Assess fraud, abuse, malicious-contract, and counterparty risk for the proposed payment destination. Provide an explicit verdict/label and numeric confidence when the routed Miner supports them. For contract destinations, assess privileged upgrade, admin, owner, pause, or similar control risk when supported. Exact EVM subject: 0xb38d0405df1b15961aef29c7c45f2ed285822c14. Exact chainId: 84532. Network: Base Sepolia testnet. Do not substitute Base mainnet for Base Sepolia chainId 84532. Return verifiable intelligence explicitly bound to this exact subject and chain. Prefer live on-chain measurements over generic LLM-only speculation when a capable Miner is available. Explicitly repeat the exact subject address and exact chainId in structured output or in a schema-declared signal field so the evidence can be machine-bound without relying on request metadata. Do not assess a different address or chain. 0xb38d0405df1b15961aef29c7c45f2ed285822c14 base 84532';

test('handoff: the fraud question that live traffic sent to transaction lookup moves to the fraud assessment', () => {
  const params = {
    address: '0xb38d0405df1b15961aef29c7c45f2ed285822c14',
    chain: 'base',
    chainId: '84532',
    query: LIVE_FRAUD_QUESTION,
  };
  assert.equal(detectHandoff('/check-tx', requestText({ method: 'GET', query: params }), params), 'fraud');
});

test('handoff: shorter fraud phrasings on transaction lookup also move', () => {
  for (const text of [
    `Is ${ADDRESS} a known scam address?`,
    `Assess the counterparty risk of paying ${ADDRESS}.`,
    `Has ${ADDRESS} been sanctioned or blacklisted?`,
    `Is it safe to send funds to ${ADDRESS}?`,
    `Is ${ADDRESS} a malicious contract?`,
  ]) {
    assert.equal(detectHandoff('/check-tx', text, { query: text }), 'fraud', text);
  }
});

test('handoff: an ordinary transaction question never becomes a fraud assessment', () => {
  for (const text of [
    `Is transaction ${TX_HASH} confirmed?`,
    `Did the transfer from ${ADDRESS} go through?`,
    `What block was ${TX_HASH} included in?`,
    `Is there any risk this transaction from ${ADDRESS} is still pending?`,
    `What method did ${ADDRESS} call in transaction ${TX_HASH}?`,
  ]) {
    assert.equal(detectHandoff('/check-tx', text, { query: text }), null, text);
  }
});

test('handoff: a fraud question carrying its own transaction hash stays on transaction lookup', () => {
  const text = `Was transaction ${TX_HASH} from ${ADDRESS} a scam?`;
  assert.equal(detectHandoff('/check-tx', text, { query: text }), null);
  assert.equal(detectHandoff('/check-tx', LIVE_FRAUD_QUESTION, { tx_hash: TX_HASH, query: LIVE_FRAUD_QUESTION }), null);
});

test('handoff: a balance or holder cue still wins over a fraud cue on the same question', () => {
  const balance = `Is ${ADDRESS} a scam, and what is its balance?`;
  assert.equal(detectHandoff('/check-tx', balance, { query: balance }), 'wallet');
});

test('handoff: fraud is not a destination from the endpoints with no live evidence for it', () => {
  for (const path of ['/wallet-balance', '/token-holders', '/crypto-price', '/stock-price', '/ssl-check']) {
    const text = `Is ${ADDRESS} a known scam address?`;
    assert.notEqual(detectHandoff(path, text, { query: text }), 'fraud', path);
  }
});

test('handoff: the live fraud question sent to transaction lookup reaches Sentinel and returns its verdict', async (t) => {
  let seen = null;
  mockFetch(t, async (original, url, options) => {
    if (typeof url !== 'string' && url?.href) url = url.href;
    if (typeof url === 'string' && url.includes('/assess-wallet')) {
      seen = new URL(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          label: 'HIGH',
          reason: '0xb38d0405df1b15961aef29c7c45f2ed285822c14 on chainId 84532 shows high counterparty risk.',
          confidence: 0.91,
        }),
      };
    }
    return original(url, options);
  });
  const base = startServer(t);
  const query = new URLSearchParams({
    address: '0xb38d0405df1b15961aef29c7c45f2ed285822c14',
    chain: 'base',
    chainId: '84532',
    query: LIVE_FRAUD_QUESTION,
  });
  const response = await fetch(`${base}/check-tx?${query}`);
  const body = await response.json();

  // It went to Sentinel bound to the exact subject and chain the question named.
  assert.ok(seen, 'expected the request to reach Sentinel');
  assert.equal(seen.searchParams.get('wallet'), '0xb38d0405df1b15961aef29c7c45f2ed285822c14');
  assert.equal(seen.searchParams.get('chainId'), '84532');
  assert.equal(seen.searchParams.get('chain'), 'base');
  assert.equal(seen.searchParams.get('query'), LIVE_FRAUD_QUESTION);

  // And the caller got a verdict instead of the "no transaction hash" refusal.
  assert.equal(response.status, 200);
  assert.equal(body.status, 'HIGH');
  assert.notEqual(body.status, 'invalid_input');
  assert.match(body.summary, /counterparty risk/);
});
