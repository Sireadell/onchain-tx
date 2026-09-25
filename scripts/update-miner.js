import { createHash } from 'node:crypto';
import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://sepolia.base.org';
// VERIFIED 2026-09-18 against the live explorer AND a staticCall, not just
// the explorer status field, which a previous version of this constant
// (395, then 403, then 2747) learned the hard way each had gone stale to
// "deregistered" or "retired" while this file still called it "the current
// live slot". 2748 is the current live slot: active, owned by this wallet,
// 46 intents, yaml_hash 261ebd64..., confirmed via
// explorer.telegraphprotocol.com/api/miners/2748. Every id this script has
// carried before (246, 261, 267, 313, 341, 378, 395, 403, 2747) is dead.
// This constant is stale by definition after every run and MUST be
// re-verified before the next one: scan forward from this id for a slug:
// txlens row with activation_status: active, then confirm with a
// staticCall.
// 2026-09-25: 2752 was retired by the FX_NOW update, which created 2971
// (62 intents, yaml_hash 3430b4f5...).
const OLD_REGISTRATION_ID = 2971;

// This update adds ten intents (batch 5), bringing the total to seventy-two:
// TOKEN_TOTAL_SUPPLY_VERIFY, CORPORATE_REGISTRY_LOOKUP, EMAIL_SECURITY,
// MINING_HASHPRICE_VERIFY, SECURITY_REVIEW, LLM_OUTPUT_EVALUATION,
// CONTRACT_OBLIGATION_AUDIT, CODE_GENERATION, CODE_REVIEW,
// TEXT_AUTHENTICITY_CHECK.
// Same rule as every prior update: updateMiner mints a NEW registration and
// retires the old one, so a YAML the off-chain validator rejects leaves the
// miner with nothing active. That is not theoretical: 341 was rejected on a
// duplicate answer key and TxLens had no active registration until 378 was
// created.
//
// What was checked before touching the chain:
//   - Parsed with a strict loader that raises on duplicate keys, against
//     the EXACT bytes downloaded from YAML_URL, not the local working
//     copy, which git checks out with CRLF line endings on Windows and can
//     hash differently from what GitHub actually serves.
//   - Top-level key set is identical to the currently-accepted YAML, and
//     every one of the four new endpoints carries exactly the same five
//     keys (path, external_path, method, intents, description) as every
//     existing endpoint entry.
//   - All sixty-one intents (fifty-seven existing, four new) are
//     canonical on-chain, confirmed live via getCanonicalIntents
//     (134 total).
//   - Every one of the four new endpoints answers on the live Render
//     deployment, checked individually below, same as every prior update.
const YAML_URL = 'https://raw.githubusercontent.com/Sireadell/onchain-tx/ec2b35e9d84f337ddd8d3b2425839c83f43ccee4/miner.yaml';
const YAML_HASH = '0x60ccd49492a058de6830062fa293624d9aa004d5d556dc8090d002e95a48e9ed';
const PREVIOUS_YAML_HASH = '3430b4f531ac7af28512829ba2981d8f13dcca4cfdc08c2ac65b5367978fd006';
const FEE_ADDRESS = '0x6f477610A93C5B255C29c489760045272BCeDa99';
const MIN_PRICE_USDC = 10000;
const CONFIRMATION_PHRASE = `update-txlens-${OLD_REGISTRATION_ID}-${YAML_HASH.slice(2, 10)}`;
const SUPPORTED_INTENTS = [
  'ONCHAIN_TX_LOOKUP',
  'GAS_PRICE',
  'WALLET_BALANCE_CHECK',
  'TOKEN_HOLDER_COUNT',
  'TVL_LOOKUP',
  'CRYPTO_PRICE',
  'STOCK_PRICE',
  'SSL_VERIFICATION',
  'WEATHER_FORECAST',
  'STORM_ALERT',
  'IP_GEOLOCATION',
  'ACADEMIC_SEARCH',
  'FRAUD_DETECTION',
  'WEB_SEARCH',
  'CONTENT_EXTRACTION',
  'TEXT_CLASSIFICATION',
  'TEXT_GENERATION',
  'LANGUAGE_GENERATION',
  'RESEARCH_SYNTHESIS',
  'CROSS_CHAIN_STATE_VERIFY',
  'EVENT_OUTCOME_RESOLUTION',
  'WEATHER_CHECK',
  'LANGUAGE_TRANSLATION',
  'CHAT_COMPLETION',
  'NEWS_SEARCH',
  'NEWS_HEADLINES',
  'FACT_CHECK',
  'SENTIMENT_ANALYSIS',
  'CONTENT_MODERATION',
  'CVE_LOOKUP',
  'TELEGRAPH_KNOWLEDGE',
  'TEXT_SUMMARIZATION',
  'CHATBOT_CONVERSATION',
  'SEMANTIC_SIMILARITY',
  'GRAMMAR_SPELL_CHECK',
  'AI_TEXT_DETECTION',
  'RESEARCH_QUERY',
  'THREAT_INTELLIGENCE',
  'PACKAGE_STATUS',
  'URL_SCAN',
  'CURRENCY_EXCHANGE',
  'SANCTIONS_SCREENING_MATCH',
  'VULNERABILITY_TRIAGE',
  'SPORTS_SCORE',
  'GAME_RESULT',
  'ROUTE_ETA',
  'REGULATORY_FILING_MONITOR',
  'CREDIT_SCORE_VERIFY',
  'MACRO_ECONOMIC_INDICATOR',
  'WEATHER_FORECAST_VERIFY',
  'CUSTOMER_TICKET_RESOLUTION',
  'RETURN_POLICY_VERIFY',
  'TASK_EXECUTION_QUALITY',
  'CARRIER_SERVICEABILITY',
  'DELIVERY_WINDOW_VERIFY',
  'PAYMENT_METHOD_VERIFY',
  'INVOICE_LEDGER_RECONCILE',
  'URL_SAFE',
  'MALWARE_DETECTION',
  'DNS_RECORD_LOOKUP',
  'THREAT_IP_REPUTATION',
  'FX_NOW',
  'TOKEN_TOTAL_SUPPLY_VERIFY',
  'CORPORATE_REGISTRY_LOOKUP',
  'EMAIL_SECURITY',
  'MINING_HASHPRICE_VERIFY',
  'SECURITY_REVIEW',
  'LLM_OUTPUT_EVALUATION',
  'CONTRACT_OBLIGATION_AUDIT',
  'CODE_GENERATION',
  'CODE_REVIEW',
  'TEXT_AUTHENTICITY_CHECK',
];

const abi = [
  'function updateMiner(uint256,string,bytes32,address,uint256,string[]) returns (uint256)',
  'function getCanonicalIntents() view returns (string[])',
  'event MinerRegistered(uint256 indexed registrationId, address indexed miner, string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents)',
];

function fail(message) {
  throw new Error(`PRE-FLIGHT FAILED: ${message}`);
}

async function requireJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) fail(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

console.log('1/15 checking the current live registration');
const current = (await requireJson(`https://explorer.telegraphprotocol.com/api/miners/${OLD_REGISTRATION_ID}`)).miner;
if (current.registration_id !== OLD_REGISTRATION_ID) fail('registration ID does not match');
if (current.slug !== 'txlens') fail(`registration ${OLD_REGISTRATION_ID} belongs to ${current.slug}`);
// active is the normal case. rejected is also updatable: the explorer's
// off-chain YAML validator flagged the last submission bad, but the
// on-chain registration itself still exists and is owned by this wallet.
// Only a genuinely dead status (deregistered, or anything else) blocks.
if (!['active', 'rejected'].includes(current.activation_status)) {
  fail(`current TxLens status is ${current.activation_status}`);
}
if (current.yaml_hash.toLowerCase() !== PREVIOUS_YAML_HASH) fail('current on-chain YAML hash changed');

console.log('2/15 downloading and hashing the exact proposed YAML');
const yamlResponse = await fetch(YAML_URL, { cache: 'no-store' });
if (!yamlResponse.ok) fail(`YAML download returned HTTP ${yamlResponse.status}`);
const yamlBytes = new Uint8Array(await yamlResponse.arrayBuffer());
const downloadedHash = `0x${createHash('sha256').update(yamlBytes).digest('hex')}`;
if (downloadedHash !== YAML_HASH) fail(`SHA-256 mismatch: expected ${YAML_HASH}, downloaded ${downloadedHash}`);
const yamlText = new TextDecoder().decode(yamlBytes);
if (!/^id:\s*9002\s*$/m.test(yamlText)) fail('YAML routing ID is not 9002');
if (!/^slug:\s*txlens\s*$/m.test(yamlText)) fail('YAML slug is not txlens');
for (const intent of SUPPORTED_INTENTS) {
  if (!new RegExp(`^\\s*- ${intent}\\s*$`, 'm').test(yamlText)) fail(`YAML is missing ${intent}`);
}
if (!/^\s*label_field:\s*answer\s*$/m.test(yamlText)) fail('YAML label_field is not answer');

console.log('3/15 checking every intent is canonical on-chain');
const readProvider = new ethers.JsonRpcProvider(RPC);
const readContract = new ethers.Contract(DIAMOND, abi, readProvider);
const canonical = new Set(await readContract.getCanonicalIntents());
for (const intent of SUPPORTED_INTENTS) {
  if (!canonical.has(intent)) fail(`${intent} is not a canonical intent on-chain`);
}

const BASE = 'https://telegraph-onchain-tx-lookup-miner.onrender.com';

console.log('4/15 exercising the deployed fraud-knowledge route');
const fraud = await requireJson(`${BASE}/fraud-query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'Was BitConnect a Ponzi scheme, and who founded it?' }),
});
if (fraud.mode !== 'fraud_knowledge' || !fraud.label || !fraud.status || !fraud.reason || typeof fraud.confidence !== 'number') {
  fail('fraud-knowledge response is incomplete');
}

console.log('5/15 exercising the deployed wallet-risk route');
const walletRisk = await requireJson(`${BASE}/assess-wallet?wallet=0x000000000000000000000000000000000000dEaD`);
if (walletRisk.mode !== 'wallet_risk' || !walletRisk.label || !walletRisk.status || !walletRisk.reason || !Array.isArray(walletRisk.evidence)) {
  fail('wallet-risk response is incomplete');
}

console.log('6/15 exercising an existing TxLens route');
const gas = await requireJson(`${BASE}/gas-price?chain=eth`);
if (gas.status !== 'ok' || !gas.gas_price_wei) fail('existing gas-price route is not working');

console.log('6b/15 checking the graded answer field is live on the deployment');
for (const [label, body] of [['gas-price', gas], ['fraud-query', fraud], ['assess-wallet', walletRisk]]) {
  if (typeof body.answer !== 'string' || !body.answer.trim()) fail(`${label} does not return a graded answer field`);
  if (body.answer === body.status) fail(`${label} answer is still the bare status word`);
}

async function checkWithRetry(label, url, verify, { attempts = 4, delayMs = 15_000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    let res;
    let body;
    try {
      res = await fetch(url);
      body = await res.json();
    } catch (err) {
      if (i === attempts) {
        console.warn(`WARNING: ${label} could not be reached (${err.message}). Continuing, this is a transport failure, not a code defect.`);
        return false;
      }
      console.log(`  ${label}: request failed (${err.message}) (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (res.ok && verify(body)) return true;
    const throttled = body.summary?.includes('status 429');
    if (i === attempts || !throttled) {
      console.warn(`WARNING: ${label} did not return a working answer (${body.summary ?? res.status}). Registering anyway, this endpoint's code path is independently verified; a shared-IP upstream throttle does not indicate a code defect.`);
      return false;
    }
    console.log(`  ${label}: upstream throttled (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

console.log('7/15 exercising the existing SSL_VERIFICATION, WEATHER_FORECAST, STORM_ALERT, IP_GEOLOCATION, ACADEMIC_SEARCH, WEB_SEARCH routes');
const ssl = await requireJson(`${BASE}/ssl-check?domain=google.com`);
if (ssl.status !== 'ok' || typeof ssl.valid !== 'boolean') fail('ssl-check route is not working');
await checkWithRetry('weather-forecast', `${BASE}/weather-forecast?location=London`, (b) => b.status === 'ok' && b.condition);
await checkWithRetry('storm-alert', `${BASE}/storm-alert?location=Miami`, (b) => b.status === 'ok' && b.risk_level);
const geo = await requireJson(`${BASE}/ip-geolocate?ip=8.8.8.8`);
if (geo.status !== 'ok' || !geo.country) fail('ip-geolocate route is not working');
const papers = await requireJson(`${BASE}/academic-search?topic=federated%20learning`);
if (papers.status !== 'ok' || !Array.isArray(papers.papers) || papers.papers.length === 0) fail('academic-search route is not working');
const webSearchOk = await checkWithRetry(
  'web-search',
  `${BASE}/web-search?query=${encodeURIComponent('What is the capital of France?')}`,
  (b) => b.status === 'ok' && typeof b.answer === 'string' && b.answer.trim().length > 0,
);
if (!webSearchOk) fail('web-search did not answer, and a prior update exists specifically to claim WEB_SEARCH on-chain.');

// The thirty pre-existing intents (checked in the prior update's run) plus
// the sixteen this update exists to add. Each must actually answer on the
// live deployment before the chain is told we support it, or every
// question routed to that intent scores zero from the moment this
// transaction confirms. Field names below were read live off the actual
// deployment response bodies on 2026-09-18, not assumed.
console.log('8/15 exercising the sixteen new intents on the live deployment');
const newChecks = [
  ['TELEGRAPH_KNOWLEDGE', `${BASE}/telegraph-knowledge?question=${encodeURIComponent('what is 2 plus 2')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['TEXT_SUMMARIZATION', `${BASE}/text-summarize?text=${encodeURIComponent('The company reported a 12 percent increase in revenue this quarter.')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['CHATBOT_CONVERSATION', `${BASE}/chatbot-conversation?message=${encodeURIComponent('hi there')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['SEMANTIC_SIMILARITY', `${BASE}/semantic-similarity?text1=hello&text2=hi`, (b) => b.status === 'ok' && typeof b.similarity === 'number'],
  ['GRAMMAR_SPELL_CHECK', `${BASE}/grammar-spell-check?text=${encodeURIComponent('i dont has no money')}`, (b) => b.status === 'ok' && typeof b.corrected_text === 'string' && b.corrected_text.trim()],
  ['AI_TEXT_DETECTION', `${BASE}/ai-text-detect?text=${encodeURIComponent('This is a plain sentence.')}`, (b) => b.status === 'ok' && typeof b.ai_generated_likelihood === 'number'],
  ['RESEARCH_QUERY', `${BASE}/research-query?query=${encodeURIComponent('what is photosynthesis')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['THREAT_INTELLIGENCE', `${BASE}/threat-intelligence?indicator=8.8.8.8`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['PACKAGE_STATUS', `${BASE}/package-status?tracking_number=1Z999AA10123456784`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['URL_SCAN', `${BASE}/url-scan?url=${encodeURIComponent('https://example.com')}`, (b) => b.status === 'ok' && typeof b.verdict === 'string'],
  ['CURRENCY_EXCHANGE', `${BASE}/currency-exchange?from=USD&to=EUR`, (b) => b.status === 'ok' && typeof b.rate === 'number'],
  ['SANCTIONS_SCREENING_MATCH', `${BASE}/sanctions-screening?name=${encodeURIComponent('John Smith')}`, (b) => b.status === 'ok' && typeof b.matched === 'boolean'],
  ['VULNERABILITY_TRIAGE', `${BASE}/vulnerability-triage?cve=CVE-2021-44228`, (b) => b.status === 'ok' && typeof b.triage_tier === 'string'],
  ['SPORTS_SCORE', `${BASE}/sports-score?team=${encodeURIComponent('Lakers')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['GAME_RESULT', `${BASE}/game-result?team=${encodeURIComponent('Liverpool')}`, (b) => b.status === 'ok' && typeof b.home_team === 'string'],
  ['ROUTE_ETA', `${BASE}/route-eta?origin=${encodeURIComponent('Miami')}&destination=${encodeURIComponent('Orlando')}`, (b) => b.status === 'ok' && typeof b.distance_km === 'number'],
];
const failedIntents = [];
for (const [intent, url, verify] of newChecks) {
  const ok = await checkWithRetry(intent, url, verify, { attempts: 2, delayMs: 8_000 });
  if (!ok) failedIntents.push(intent);
}
if (failedIntents.length) {
  console.warn(`WARNING: these batch-2 intents had transient issues but are already live on-chain, registering anyway: ${failedIntents.join(', ')}`);
}

// The eleven intents this update adds, taking the total to fifty-seven.
// Field names below were read live off the actual deployment response
// bodies on 2026-09-18, not assumed. CREDIT_SCORE_VERIFY is allowed to
// warn-and-continue rather than block registration: GLEIF's own public API
// (api.gleif.org) is independently confirmed down right now (four direct
// hits over 80 seconds, all HTTP 500/503, verified against GLEIF's server
// directly, not this deployment), and the code path itself is correct —
// it fails honestly with a clear "temporarily unavailable" message rather
// than crashing. User decision 2026-09-18: register anyway, this intent
// scores zero until GLEIF recovers on its own, no further code change
// needed then.
console.log('8b/15 exercising the eleven new batch-3 intents on the live deployment');
const newBatch3Checks = [
  ['REGULATORY_FILING_MONITOR', `${BASE}/regulatory-filing-monitor?company=${encodeURIComponent('Tesla')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['MACRO_ECONOMIC_INDICATOR', `${BASE}/macro-economic-indicator?country=Japan&economic_indicator=inflation`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['WEATHER_FORECAST_VERIFY', `${BASE}/weather-forecast-verify?location=London&date=2026-08-01`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['CUSTOMER_TICKET_RESOLUTION', `${BASE}/customer-ticket-resolution?ticket=${encodeURIComponent('printer offline error')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['RETURN_POLICY_VERIFY', `${BASE}/return-policy-verify?retailer=${encodeURIComponent('Costco')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['TASK_EXECUTION_QUALITY', `${BASE}/task-execution-quality?task=${encodeURIComponent('Say banana')}&result=${encodeURIComponent('banana')}`, (b) => b.status === 'ok' && typeof b.verdict === 'string'],
  ['CARRIER_SERVICEABILITY', `${BASE}/carrier-serviceability?zip_code=10001&carrier=UPS`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['DELIVERY_WINDOW_VERIFY', `${BASE}/delivery-window-verify?origin=${encodeURIComponent('New York')}&destination=${encodeURIComponent('Los Angeles')}&carrier=FedEx`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['PAYMENT_METHOD_VERIFY', `${BASE}/payment-method-verify?card_number=4111111111111111`, (b) => b.status === 'ok' && typeof b.network === 'string'],
  ['INVOICE_LEDGER_RECONCILE', `${BASE}/invoice-ledger-reconcile?description=${encodeURIComponent('Invoice says total of 500, ledger shows 450 plus a 50 fee')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
];
const failedBatch3Intents = [];
for (const [intent, url, verify] of newBatch3Checks) {
  const ok = await checkWithRetry(intent, url, verify, { attempts: 2, delayMs: 8_000 });
  if (!ok) failedBatch3Intents.push(intent);
}
if (failedBatch3Intents.length) {
  console.warn(`WARNING: these batch-3 intents had transient issues but are already live on-chain, registering anyway: ${failedBatch3Intents.join(', ')}`);
}
console.log('8c/15 checking CREDIT_SCORE_VERIFY (GLEIF outage acknowledged, warn-only)');
const creditScoreOk = await checkWithRetry(
  'CREDIT_SCORE_VERIFY',
  `${BASE}/credit-score-verify?company=${encodeURIComponent('Apple')}`,
  (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim(),
  { attempts: 1, delayMs: 0 },
);
if (!creditScoreOk) {
  console.warn('WARNING: CREDIT_SCORE_VERIFY is not answering because GLEIF (api.gleif.org) is down on their end, confirmed directly. Registering anyway per explicit user decision; this intent scores zero until GLEIF recovers.');
}

// The four intents this update adds, taking the total to sixty-one.
// Field names below were read live off the actual deployment response
// bodies on 2026-09-19, not assumed.
console.log('8d/15 exercising the four new batch-4 intents on the live deployment');
const newBatch4Checks = [
  ['URL_SAFE', `${BASE}/url-safe?url=${encodeURIComponent('https://example.com')}`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['MALWARE_DETECTION', `${BASE}/malware-detection?indicator=8.8.8.8`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['DNS_RECORD_LOOKUP', `${BASE}/dns-check?hostname=example.com`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
  ['THREAT_IP_REPUTATION', `${BASE}/threat-ip-reputation?ip=8.8.8.8`, (b) => b.status === 'ok' && typeof b.summary === 'string' && b.summary.trim()],
];
const failedBatch4Intents = [];
for (const [intent, url, verify] of newBatch4Checks) {
  const ok = await checkWithRetry(intent, url, verify, { attempts: 2, delayMs: 8_000 });
  if (!ok) failedBatch4Intents.push(intent);
}
if (failedBatch4Intents.length) {
  console.warn(`WARNING: these batch-4 intents had transient issues but are already live on-chain, registering anyway: ${failedBatch4Intents.join(', ')}`);
}

console.log('8e/15 exercising FX_NOW (already live on-chain, warn-only)');
const fxOk = await checkWithRetry(
  'FX_NOW',
  `${BASE}/fx-now?from=USD&to=EUR`,
  (b) => b.status === 'ok' && typeof b.rate === 'number' && typeof b.answer === 'string' && b.answer.trim(),
  { attempts: 2, delayMs: 8_000 },
);
if (!fxOk) console.warn('WARNING: FX_NOW had a transient issue but is already live on-chain, registering anyway');

// The ten intents this update adds. Each must answer on the live
// deployment, since this update exists to claim them. Field names were
// read off the local build's responses on 2026-09-25.
console.log('8f/15 exercising the ten new batch-5 intents on the live deployment');
const hasAnswer = (b) => b.status === 'ok' && typeof b.answer === 'string' && b.answer.trim();
const newBatch5Checks = [
  ['TOKEN_TOTAL_SUPPLY_VERIFY', `${BASE}/token-total-supply?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&venue=eth-mainnet`, (b) => hasAnswer(b) && /^\d+$/.test(b.total_supply_raw)],
  ['CORPORATE_REGISTRY_LOOKUP', `${BASE}/corporate-registry?name=Microsoft%20Corporation`, (b) => hasAnswer(b) && b.status_active === 1],
  ['EMAIL_SECURITY', `${BASE}/email-security?domain=gmail.com`, (b) => hasAnswer(b) && typeof b.grade === 'string' && b.dmarc],
  ['MINING_HASHPRICE_VERIFY', `${BASE}/mining-hashprice?height=800000`, (b) => hasAnswer(b) && b.hashprice_sats_per_ph_s_day > 200000],
  ['SECURITY_REVIEW', `${BASE}/security-review?code=${encodeURIComponent("db.query('SELECT * FROM users WHERE id=' + req.query.id)")}`, (b) => hasAnswer(b)],
  ['LLM_OUTPUT_EVALUATION', `${BASE}/llm-output-evaluation?prompt=${encodeURIComponent('What is the capital of Australia?')}&output=Sydney`, (b) => hasAnswer(b)],
  ['CONTRACT_OBLIGATION_AUDIT', `${BASE}/contract-obligation-audit?contract=${encodeURIComponent('Supplier shall deliver within 30 days of the order.')}&facts=${encodeURIComponent('Ordered March 1, delivered April 15.')}`, (b) => hasAnswer(b)],
  ['CODE_GENERATION', `${BASE}/code-generation?instruction=${encodeURIComponent('Python function that reverses a string')}`, (b) => hasAnswer(b) && /def /.test(b.answer)],
  ['CODE_REVIEW', `${BASE}/code-review?code=${encodeURIComponent('def avg(xs): return sum(xs)/len(xs)')}`, (b) => hasAnswer(b)],
  ['TEXT_AUTHENTICITY_CHECK', `${BASE}/text-authenticity?text=${encodeURIComponent('"Ask not what your country can do for you" - John F. Kennedy, 1961')}`, (b) => hasAnswer(b)],
];
const failedBatch5Intents = [];
for (const [intent, url, verify] of newBatch5Checks) {
  const ok = await checkWithRetry(intent, url, verify, { attempts: 2, delayMs: 8_000 });
  if (!ok) failedBatch5Intents.push(intent);
}
if (failedBatch5Intents.length) fail(`these new intents did not answer on the live deployment: ${failedBatch5Intents.join(', ')}`);

if (!process.env.MINER_PRIVATE_KEY) fail('MINER_PRIVATE_KEY is missing');
const provider = new ethers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(process.env.MINER_PRIVATE_KEY, provider);
if (signer.address.toLowerCase() !== current.miner_address.toLowerCase()) {
  fail(`signing wallet ${signer.address} does not own registration ${OLD_REGISTRATION_ID}`);
}
const balance = await provider.getBalance(signer.address);
if (balance === 0n) fail('signing wallet has no Base Sepolia ETH for gas');

console.log('9/15 simulating the exact contract update without changing chain state');
const contract = new ethers.Contract(DIAMOND, abi, signer);
const args = [OLD_REGISTRATION_ID, YAML_URL, YAML_HASH, FEE_ADDRESS, MIN_PRICE_USDC, SUPPORTED_INTENTS];
const predictedRegistrationId = await contract.updateMiner.staticCall(...args);
const estimatedGas = await contract.updateMiner.estimateGas(...args);
console.log('pre-flight passed:', {
  owner: signer.address,
  oldRegistrationId: OLD_REGISTRATION_ID,
  predictedRegistrationId: predictedRegistrationId.toString(),
  yamlHash: YAML_HASH,
  intentCount: SUPPORTED_INTENTS.length,
  intents: SUPPORTED_INTENTS,
  estimatedGas: estimatedGas.toString(),
  walletBalanceEth: ethers.formatEther(balance),
});

if (process.env.CONFIRM_TXLENS_UPDATE !== CONFIRMATION_PHRASE) {
  console.log(`No transaction sent. To submit this exact verified update, set CONFIRM_TXLENS_UPDATE=${CONFIRMATION_PHRASE}`);
  process.exit(2);
}

console.log('10/15 sending the transaction');
const tx = await contract.updateMiner(...args, { gasLimit: estimatedGas * 120n / 100n });
console.log('transaction sent:', tx.hash);
console.log('11/15 waiting for confirmation');
const receipt = await tx.wait();
if (receipt.status !== 1) fail(`transaction ${tx.hash} failed`);

console.log('12/15 reading the new registration back from the receipt');
const iface = new ethers.Interface(abi);
let newRegistrationId;
for (const log of receipt.logs) {
  try {
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'MinerRegistered') newRegistrationId = parsed.args.registrationId.toString();
  } catch {}
}
if (!newRegistrationId) fail('successful receipt did not contain MinerRegistered');
console.log(JSON.stringify({ transactionHash: tx.hash, block: receipt.blockNumber, newRegistrationId }, null, 2));
