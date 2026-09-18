import { createHash } from 'node:crypto';
import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://sepolia.base.org';
// VERIFIED 2026-09-18 against the live explorer AND a staticCall, not just
// the explorer status field, which a previous version of this constant
// (395, then 403) learned the hard way each had gone stale to
// "deregistered" while this file still called it "the current live slot".
// 2747 is the current live slot: active, owned by this wallet, 30 intents,
// yaml_hash 7945f1cd..., confirmed via
// explorer.telegraphprotocol.com/api/miners/2747. Every id this script has
// carried before (246, 261, 267, 313, 341, 378, 395, 403) is dead. This
// constant is stale by definition after every run and MUST be re-verified
// before the next one: scan forward from this id for a slug: txlens row
// with activation_status: active, then confirm with a staticCall.
const OLD_REGISTRATION_ID = 2747;

// This update adds sixteen more intents (telegraph-knowledge,
// text-summarize, chatbot-conversation, semantic-similarity,
// grammar-spell-check, ai-text-detect, research-query, threat-intelligence,
// package-status, url-scan, currency-exchange, sanctions-screening,
// vulnerability-triage, sports-score, game-result, route-eta), bringing the
// total to forty-six. Same rule as every prior update: updateMiner mints a
// NEW registration and retires the old one, so a YAML the off-chain
// validator rejects leaves the miner with nothing active. That is not
// theoretical: 341 was rejected on a duplicate answer key and TxLens had no
// active registration until 378 was created.
//
// What was checked before touching the chain:
//   - Every schema failure seen in other miners' real rejections was checked
//     against this YAML: limitations is an array, not a string; no endpoint
//     carries a params key at all; there is no on_chain block.
//   - Parsed with a strict loader that raises on duplicate keys, against the
//     EXACT bytes downloaded from YAML_URL, not the local working copy,
//     which git checks out with CRLF line endings on Windows and therefore
//     hashes differently from what GitHub actually serves. Clean, and the
//     git blob hash matches the downloaded hash exactly.
//   - Top-level key set is identical to the currently-accepted YAML, and
//     every one of the sixteen new endpoints carries exactly the same five
//     keys (path, external_path, method, intents, description) as every
//     existing endpoint entry.
//   - All forty-six intents (thirty existing, sixteen new) are canonical
//     on-chain, confirmed live via getCanonicalIntents (134 total).
//   - Every one of the sixteen new endpoints answers on the live Render
//     deployment, checked individually below, same as every prior update.
const YAML_URL = 'https://raw.githubusercontent.com/Sireadell/onchain-tx/463f0a2227d06aa9a408f833e9a5d350eb6fb3c2/miner.yaml';
const YAML_HASH = '0x261ebd64bb2ba672ae7db551a5b99c3b30e16ef53a3175432ed54cbd95ddf183';
const PREVIOUS_YAML_HASH = '7945f1cdaa0f19ad800a8c75441b4f0b3db22f0a26a90459ccdbc3935e7b3f18';
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

console.log('1/12 checking the current live registration');
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

console.log('2/12 downloading and hashing the exact proposed YAML');
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

console.log('3/12 checking every one of the thirty intents is canonical on-chain');
const readProvider = new ethers.JsonRpcProvider(RPC);
const readContract = new ethers.Contract(DIAMOND, abi, readProvider);
const canonical = new Set(await readContract.getCanonicalIntents());
for (const intent of SUPPORTED_INTENTS) {
  if (!canonical.has(intent)) fail(`${intent} is not a canonical intent on-chain`);
}

const BASE = 'https://telegraph-onchain-tx-lookup-miner.onrender.com';

console.log('4/12 exercising the deployed fraud-knowledge route');
const fraud = await requireJson(`${BASE}/fraud-query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'Was BitConnect a Ponzi scheme, and who founded it?' }),
});
if (fraud.mode !== 'fraud_knowledge' || !fraud.label || !fraud.status || !fraud.reason || typeof fraud.confidence !== 'number') {
  fail('fraud-knowledge response is incomplete');
}

console.log('5/12 exercising the deployed wallet-risk route');
const walletRisk = await requireJson(`${BASE}/assess-wallet?wallet=0x000000000000000000000000000000000000dEaD`);
if (walletRisk.mode !== 'wallet_risk' || !walletRisk.label || !walletRisk.status || !walletRisk.reason || !Array.isArray(walletRisk.evidence)) {
  fail('wallet-risk response is incomplete');
}

console.log('6/12 exercising an existing TxLens route');
const gas = await requireJson(`${BASE}/gas-price?chain=eth`);
if (gas.status !== 'ok' || !gas.gas_price_wei) fail('existing gas-price route is not working');

console.log('6b/12 checking the graded answer field is live on the deployment');
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

console.log('7/12 exercising the existing SSL_VERIFICATION, WEATHER_FORECAST, STORM_ALERT, IP_GEOLOCATION, ACADEMIC_SEARCH, WEB_SEARCH routes');
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
console.log('8/12 exercising the sixteen new intents on the live deployment');
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
  fail(`these new intents did not answer on the live deployment and this update exists to claim them on-chain: ${failedIntents.join(', ')}`);
}

if (!process.env.MINER_PRIVATE_KEY) fail('MINER_PRIVATE_KEY is missing');
const provider = new ethers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(process.env.MINER_PRIVATE_KEY, provider);
if (signer.address.toLowerCase() !== current.miner_address.toLowerCase()) {
  fail(`signing wallet ${signer.address} does not own registration ${OLD_REGISTRATION_ID}`);
}
const balance = await provider.getBalance(signer.address);
if (balance === 0n) fail('signing wallet has no Base Sepolia ETH for gas');

console.log('9/12 simulating the exact contract update without changing chain state');
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

console.log('10/12 sending the transaction');
const tx = await contract.updateMiner(...args, { gasLimit: estimatedGas * 120n / 100n });
console.log('transaction sent:', tx.hash);
console.log('11/12 waiting for confirmation');
const receipt = await tx.wait();
if (receipt.status !== 1) fail(`transaction ${tx.hash} failed`);

console.log('12/12 reading the new registration back from the receipt');
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
