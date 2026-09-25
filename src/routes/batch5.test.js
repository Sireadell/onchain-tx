import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';
import { __clearEntityRegistryCacheForTesting } from '../lib/entityRegistry.js';
import { resolveChainId, tokenFromText, formatUnits } from './checkTokenTotalSupply.js';
import { companyFromText, jurisdictionCode } from './checkCorporateRegistry.js';
import { parseSpf, parseDmarc, gradeEmail, hasDkimKey, unquoteTxt } from './checkEmailSecurity.js';
import { hashpriceFrom, subsidyAt, parseHeight } from './checkMiningHashprice.js';
import { collectInput, leadingVerdict } from '../lib/llmIntentRoute.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return original(url, init);
    return handler(u, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---- TOKEN_TOTAL_SUPPLY_VERIFY

test('token supply: every chain spelling the grader sent resolves to Ethereum', () => {
  for (const v of ['ethereum', 'eth-mainnet', 'eth_mainnet', '1', 'Ethereum Mainnet', undefined]) {
    assert.equal(resolveChainId(v)?.key, 'eth', String(v));
  }
  assert.equal(resolveChainId('8453').key, 'base');
  assert.equal(resolveChainId('dogechain'), null);
});

test('token supply: symbols and names in a question map to contracts', () => {
  assert.equal(tokenFromText('total supply of USDC on Ethereum', 'eth').symbol, 'USDC');
  assert.equal(tokenFromText('How many Tether tokens exist?', 'eth').symbol, 'USDT');
  assert.equal(tokenFromText('supply of something', 'eth'), null);
  assert.equal(formatUnits(50079201740365570n, 6), '50079201740.36557');
  assert.equal(formatUnits(1000000n, 6), '1');
});

test('token supply: reads totalSupply, decimals and symbol from the chain', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  const seen = [];
  stubFetch(t, async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.params);
    const data = body.params[0].data;
    if (data === '0x18160ddd') return json({ result: `0x${(123456789000000n).toString(16)}` });
    if (data === '0x313ce567') return json({ result: `0x${(6).toString(16).padStart(64, '0')}` });
    const sym = Buffer.from('USDC').toString('hex');
    return json({ result: `0x${'20'.padStart(64, '0')}${'4'.padStart(64, '0')}${sym.padEnd(64, '0')}` });
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-total-supply?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&venue=eth-mainnet&block=23000000`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.total_supply_raw, '123456789000000');
  assert.equal(body.total_supply, '123456789');
  assert.equal(body.symbol, 'USDC');
  assert.equal(body.block, '23000000');
  assert.match(body.answer, /123,456,789 USDC at block 23000000/);
  assert.ok(seen.some((p) => p[1] === '0x' + (23000000).toString(16)));
});

// ---- CORPORATE_REGISTRY_LOOKUP

test('corporate registry: pulls the quoted company and the jurisdiction out of a question', () => {
  const q = "What is the registered address and current directors for 'Globex Corporation' in Delaware, USA?";
  assert.equal(companyFromText(q), 'Globex Corporation');
  assert.equal(jurisdictionCode('Delaware, USA'), 'US-DE');
  assert.equal(jurisdictionCode('somewhere'), null);
});

test('corporate registry: an unknown company is said to be unregistered, not guessed at', async (t) => {
  __clearEntityRegistryCacheForTesting();
  stubFetch(t, async () => json({ data: [] }));
  t.after(() => __clearEntityRegistryCacheForTesting());
  const base = startServer(t);
  const q = encodeURIComponent("What is the registered address and current directors for 'Globex Corporation' in Delaware, USA?");
  const body = await (await fetch(`${base}/corporate-registry?query=${q}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.found, false);
  assert.equal(body.status_active, 0);
  assert.match(body.answer, /No company named "Globex Corporation"/);
  assert.match(body.answer, /Directors and officers are not part of an LEI record/);
});

test('corporate registry: a brand name is looked up by its legal name', async (t) => {
  __clearEntityRegistryCacheForTesting();
  const asked = [];
  stubFetch(t, async (url) => {
    asked.push(decodeURIComponent(url.replace(/\+/g, ' ')));
    return json({ data: [{ id: '549300B9WLO96RQCXP87', attributes: { entity: { legalName: { name: 'SPACE EXPLORATION TECHNOLOGIES CORP.' }, jurisdiction: 'US-TX', status: 'ACTIVE', legalAddress: { addressLines: ['211 E. 7TH STREET'], city: 'AUSTIN', country: 'US' } }, registration: { status: 'ISSUED' } } }] });
  });
  t.after(() => __clearEntityRegistryCacheForTesting());
  const base = startServer(t);
  const body = await (await fetch(`${base}/corporate-registry?name=SpaceX`)).json();
  assert.ok(asked[0].includes('Space Exploration Technologies Corp.'));
  assert.equal(body.status_active, 1);
  assert.match(body.answer, /SPACE EXPLORATION TECHNOLOGIES CORP\. is an active company/);
  assert.match(body.answer, /211 E\. 7TH STREET, AUSTIN, US/);
});

// ---- EMAIL_SECURITY

test('email security: SPF, DMARC and DKIM parsing', () => {
  assert.equal(parseSpf(['v=spf1 include:_spf.google.com ~all']).all, '~');
  assert.equal(parseSpf(['other']).record, null);
  const d = parseDmarc(['v=DMARC1; p=reject; rua=mailto:x@y.com']);
  assert.equal(d.policy, 'reject');
  assert.equal(hasDkimKey('v=DKIM1; p='), false);
  assert.equal(hasDkimKey('v=DKIM1; k=rsa; p=MIGfMA0'), true);
  assert.equal(unquoteTxt('"v=spf1 " "-all"'), 'v=spf1 -all');
  assert.equal(unquoteTxt('v=DMARC1; p=none'), 'v=DMARC1; p=none');
  const strong = gradeEmail({ mxRecords: [{ exchange: 'mx' }], spf: parseSpf(['v=spf1 -all']), dmarc: d, dkim: ['google'] });
  assert.equal(strong.grade, 'Strong');
  assert.deepEqual(strong.issues, []);
  assert.equal(gradeEmail({ mxRecords: [], spf: parseSpf([]), dmarc: parseDmarc([]), dkim: [] }).grade, 'Unprotected');
});

test('email security: grades a domain from its live DNS, following an SPF redirect', async (t) => {
  const records = {
    'gmail.com:TXT': ['v=spf1 redirect=_spf.google.com'],
    '_spf.google.com:TXT': ['"v=spf1 include:_netblocks.google.com ~all"'],
    '_dmarc.gmail.com:TXT': ['v=DMARC1; p=none; sp=quarantine; rua=mailto:a@google.com'],
    'gmail.com:MX': ['5 gmail-smtp-in.l.google.com.'],
    '20230601._domainkey.gmail.com:TXT': ['v=DKIM1; k=rsa; p=MIIBIjAN'],
  };
  stubFetch(t, async (url) => {
    const u = new URL(url);
    const key = `${u.searchParams.get('name')}:${u.searchParams.get('type')}`;
    const code = { TXT: 16, MX: 15 }[u.searchParams.get('type')];
    return json({ Status: 0, Answer: (records[key] ?? []).map((data) => ({ type: code, data })) });
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/email-security?query=${encodeURIComponent('Is email for someone@gmail.com secure?')}`)).json();
  assert.equal(body.domain, 'gmail.com');
  assert.equal(body.spf_all, '~');
  assert.equal(body.dmarc_policy, 'none');
  assert.deepEqual(body.dkim_selectors, ['20230601']);
  assert.equal(body.grade, 'Weak');
  assert.match(body.answer, /through its redirect to _spf\.google\.com/);
});

// ---- MINING_HASHPRICE_VERIFY

test('hashprice: block 800000 figures give about 238,322 sats per PH/s per day', () => {
  const { hashprice } = hashpriceFrom({ difficulty: 53911173001054.586, rewardSats: 638687680 });
  assert.equal(Math.round(hashprice), 238322);
  assert.equal(subsidyAt(800000), 625000000);
  assert.equal(subsidyAt(968591), 312500000);
  assert.equal(parseHeight('latest'), 'latest');
  assert.equal(parseHeight('800,000'), 800000);
  assert.equal(parseHeight(undefined, 'hashprice at block height 850000?'), 850000);
  assert.equal(parseHeight('abc'), null);
});

test('hashprice: height=latest reads the tip instead of crashing', async (t) => {
  stubFetch(t, async (url) => {
    if (url.endsWith('/blocks/tip/height')) return new Response('968591');
    if (url.includes('/block-height/')) return new Response('00abc');
    if (url.endsWith('/txs/0')) return json([{ vin: [{ is_coinbase: true }], vout: [{ value: 318749551 }] }]);
    return json({ timestamp: 1790000000, difficulty: 132757073449488 });
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/mining-hashprice?height=latest`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.height, 968591);
  assert.equal(body.hashprice_sats_per_ph_s_day, 48300);
  assert.equal(body.fees_sats, 318749551 - 312500000);
});

// ---- LLM intents

test('llm intents: every text param is passed on, and the verdict is read from the reply', () => {
  const text = collectInput({ prompt: 'What is 2+2?', output: '5', empty: '' }, ['prompt', 'output']);
  assert.equal(text, 'prompt: What is 2+2?\noutput: 5');
  assert.equal(leadingVerdict('Request changes. The loop is off by one.', ['Approve', 'Request changes']), 'Request changes');
  assert.equal(leadingVerdict('Likely fabricated. x', ['Fabricated', 'Likely fabricated']), 'Likely fabricated');
  assert.equal(leadingVerdict('Something else', ['Approve']), null);
});

function withKey(t) {
  const previous = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'pplx-test';
  t.after(() => { if (previous === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = previous; });
}

function stubModel(t, text) {
  const calls = [];
  stubFetch(t, async (url, init) => {
    calls.push(JSON.parse(init.body));
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  });
  return calls;
}

test('llm intents: a security review leads with its verdict', async (t) => {
  withKey(t);
  const calls = stubModel(t, 'Insecure. The query concatenates req.query.id into SQL (CWE-89).');
  const base = startServer(t);
  const body = await (await fetch(`${base}/security-review?code=${encodeURIComponent("db.query('SELECT * FROM u WHERE id=' + id)")}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Insecure');
  assert.match(calls[0].input[0].content, /code: db\.query/);
  assert.equal(calls[0].tools, undefined);
});

test('llm intents: generated code keeps its line breaks', async (t) => {
  withKey(t);
  stubModel(t, '```python\ndef f(n):\n    return n\n```\nReturns n.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/code-generation?instruction=identity+function`)).json();
  assert.match(body.answer, /def f\(n\):\n {4}return n/);
});

test('llm intents: nothing to work on is answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  for (const path of ['/code-review', '/llm-output-evaluation', '/contract-obligation-audit', '/text-authenticity']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal((await res.json()).status, 'invalid_input', path);
  }
});
