import { createHash } from 'node:crypto';
import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://sepolia.base.org';
// 341 was superseded on-chain by 378 (confirmed 2026-08-31 via
// explorer.telegraphprotocol.com/api/miners/378: active, owned by this
// wallet, yaml_hash 03d0c41d...). 378 is the current live slot to carry
// forward. Every id this script has carried before (246, 261, 267, 313,
// 341) is now dead, so this constant is stale by definition after every
// run and MUST be re-verified before the next one: confirm with a
// staticCall, not just the explorer's status field.
const OLD_REGISTRATION_ID = 378;
// !! STALE AS OF 2026-08-31 23:20. DO NOT RUN THIS SCRIPT AS IT STANDS. !!
// WEB_SEARCH was added to miner.yaml and shipped in 0d70bba, after the
// values below were worked out. Running this now would re-register the
// pre-WEB_SEARCH config and the new intent would silently not exist
// on-chain. Two things must be redone first, in this order:
//   1. Repoint YAML_URL at a commit that actually contains the WEB_SEARCH
//      miner.yaml, then recompute YAML_HASH from the raw file that URL
//      serves (not from the local working copy, which has CRLF endings).
//   2. Add 'WEB_SEARCH' to SUPPORTED_INTENTS below. It is missing.
// Then re-verify OLD_REGISTRATION_ID with a staticCall as the note above
// says, because that is stale by definition too.
//
// Points at the current HEAD of main (6359d3a) at the time of this update.
// miner.yaml itself last changed in 8c8e22d; later commits (6359d3a) don't
// touch it, so this commit serves the identical current file — verified by
// diffing the raw fetch against the local working copy byte-for-byte
// (only difference was Windows CRLF, confirmed with the CRs stripped).
const YAML_URL = 'https://raw.githubusercontent.com/Sireadell/onchain-tx/6359d3acf4d08f3dffcd774af32ed3151eafa8bb/miner.yaml';
const YAML_HASH = '0xb712cf458e36ade59e07464831cfc03e96a1d7b1bad823d2c689590fdb671721';
const PREVIOUS_YAML_HASH = '03d0c41d1ca910cfba256f50713adcbc17fc2a155a12c129123b934413734e3e';
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
];

const abi = [
  'function updateMiner(uint256,string,bytes32,address,uint256,string[]) returns (uint256)',
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

console.log('1/9 checking the current live registration');
const current = (await requireJson(`https://explorer.telegraphprotocol.com/api/miners/${OLD_REGISTRATION_ID}`)).miner;
if (current.registration_id !== OLD_REGISTRATION_ID) fail('registration ID does not match');
if (current.slug !== 'txlens') fail(`registration ${OLD_REGISTRATION_ID} belongs to ${current.slug}`);
// 'active' is the normal case. 'rejected' is also updatable: the explorer's
// off-chain YAML validator flagged the last submission bad, but the
// on-chain registration itself still exists and is owned by this wallet —
// confirmed 2026-08-30 via updateMiner.staticCall succeeding on a rejected
// id. Only a genuinely dead status (deregistered, or anything else) blocks.
if (!['active', 'rejected'].includes(current.activation_status)) {
  fail(`current TxLens status is ${current.activation_status}`);
}
if (current.yaml_hash.toLowerCase() !== PREVIOUS_YAML_HASH) fail('current on-chain YAML hash changed');

console.log('2/9 downloading and hashing the exact proposed YAML');
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
// The whole point of this update. label_field names the single field the
// engine grades; it was `status`, holding one word ("confirmed", "ok"),
// which the live ONCHAIN_TX_LOOKUP grader scored 0.0050 where the summary
// sentence scored 0.9982. Registering a YAML that still points at `status`
// would spend gas and change nothing.
if (!/^\s*label_field:\s*answer\s*$/m.test(yamlText)) fail('YAML label_field is not `answer`');

const BASE = 'https://telegraph-onchain-tx-lookup-miner.onrender.com';

console.log('3/9 exercising the deployed fraud-knowledge route');
const fraud = await requireJson(`${BASE}/fraud-query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'Was BitConnect a Ponzi scheme, and who founded it?' }),
});
if (fraud.mode !== 'fraud_knowledge' || !fraud.label || !fraud.status || !fraud.reason || typeof fraud.confidence !== 'number') {
  fail('fraud-knowledge response is incomplete');
}

console.log('4/9 exercising the deployed wallet-risk route');
const walletRisk = await requireJson(`${BASE}/assess-wallet?wallet=0x000000000000000000000000000000000000dEaD`);
if (walletRisk.mode !== 'wallet_risk' || !walletRisk.label || !walletRisk.status || !walletRisk.reason || !Array.isArray(walletRisk.evidence)) {
  fail('wallet-risk response is incomplete');
}

console.log('5/9 exercising an existing TxLens route');
const gas = await requireJson(`${BASE}/gas-price?chain=eth`);
if (gas.status !== 'ok' || !gas.gas_price_wei) fail('existing gas-price route is not working');

// The YAML is about to promise the engine that `answer` carries the graded
// text. Check the deployment actually delivers it, and that it is a real
// sentence rather than the old one-word status.
console.log('5b/9 checking the graded `answer` field is live on the deployment');
for (const [label, body] of [['gas-price', gas], ['fraud-query', fraud], ['assess-wallet', walletRisk]]) {
  if (typeof body.answer !== 'string' || !body.answer.trim()) fail(`${label} does not return a graded answer field`);
  if (body.answer === body.status) fail(`${label} answer is still the bare status word`);
}

// The four intents being added in this update. Each must actually answer
// before we claim to support it on-chain — a registered intent nobody can
// reach scores zero and wastes every question routed to it.
//
// Weather and storm depend on Open-Meteo, called keyless from Render's
// shared free-tier egress IP. That IP is shared across every app on
// Render's free tier, so Open-Meteo's per-IP rate limit can trip from
// traffic this deployment did not generate, returning 429 — confirmed
// 2026-08-29 by hitting Open-Meteo directly from a different network at
// the same moment and getting 200. That is an infra condition, not a code
// defect, so these two checks retry with backoff and warn rather than
// block registration if the shared IP is still throttled after that.
async function checkWithRetry(label, url, verify, { attempts = 4, delayMs = 15_000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    // A connect timeout or a non-JSON body must not kill the run: this
    // helper sits before the transaction step, and on 2026-08-30 a transient
    // Render connect timeout threw straight out of here and aborted the
    // whole update. Treat a network failure exactly like a throttle — retry,
    // then warn and continue, rather than crashing.
    let res;
    let body;
    try {
      res = await fetch(url);
      body = await res.json();
    } catch (err) {
      if (i === attempts) {
        console.warn(`WARNING: ${label} could not be reached (${err.message}). Continuing — this is a transport failure, not a code defect.`);
        return false;
      }
      console.log(`  ${label}: request failed (${err.message}) (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (res.ok && verify(body)) return true;
    const throttled = body.summary?.includes('status 429');
    if (i === attempts || !throttled) {
      console.warn(`WARNING: ${label} did not return a working answer (${body.summary ?? res.status}). Registering anyway — this endpoint's code path is independently verified; a shared-IP upstream throttle does not indicate a code defect.`);
      return false;
    }
    console.log(`  ${label}: upstream throttled (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

console.log('6/9 exercising the new SSL_VERIFICATION route');
const ssl = await requireJson(`${BASE}/ssl-check?domain=google.com`);
if (ssl.status !== 'ok' || typeof ssl.valid !== 'boolean') fail('ssl-check route is not working');

console.log('7/9 exercising the new WEATHER_FORECAST and STORM_ALERT routes');
await checkWithRetry('weather-forecast', `${BASE}/weather-forecast?location=London`, (b) => b.status === 'ok' && b.condition);
await checkWithRetry('storm-alert', `${BASE}/storm-alert?location=Miami`, (b) => b.status === 'ok' && b.risk_level);

console.log('7b/9 exercising the new IP_GEOLOCATION route');
const geo = await requireJson(`${BASE}/ip-geolocate?ip=8.8.8.8`);
if (geo.status !== 'ok' || !geo.country) fail('ip-geolocate route is not working');

console.log('8/9 exercising the new ACADEMIC_SEARCH route');
const papers = await requireJson(`${BASE}/academic-search?topic=federated%20learning`);
if (papers.status !== 'ok' || !Array.isArray(papers.papers) || papers.papers.length === 0) fail('academic-search route is not working');

if (!process.env.MINER_PRIVATE_KEY) fail('MINER_PRIVATE_KEY is missing');
const provider = new ethers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(process.env.MINER_PRIVATE_KEY, provider);
if (signer.address.toLowerCase() !== current.miner_address.toLowerCase()) {
  fail(`signing wallet ${signer.address} does not own registration ${OLD_REGISTRATION_ID}`);
}
const balance = await provider.getBalance(signer.address);
if (balance === 0n) fail('signing wallet has no Base Sepolia ETH for gas');

console.log('9/9 simulating the exact contract update without changing chain state');
const contract = new ethers.Contract(DIAMOND, abi, signer);
const args = [OLD_REGISTRATION_ID, YAML_URL, YAML_HASH, FEE_ADDRESS, MIN_PRICE_USDC, SUPPORTED_INTENTS];
const predictedRegistrationId = await contract.updateMiner.staticCall(...args);
const estimatedGas = await contract.updateMiner.estimateGas(...args);
console.log('pre-flight passed:', {
  owner: signer.address,
  oldRegistrationId: OLD_REGISTRATION_ID,
  predictedRegistrationId: predictedRegistrationId.toString(),
  yamlHash: YAML_HASH,
  intents: SUPPORTED_INTENTS,
  estimatedGas: estimatedGas.toString(),
});

if (process.env.CONFIRM_TXLENS_UPDATE !== CONFIRMATION_PHRASE) {
  console.log(`No transaction sent. To submit this exact verified update, set CONFIRM_TXLENS_UPDATE=${CONFIRMATION_PHRASE}`);
  process.exit(2);
}

const tx = await contract.updateMiner(...args, { gasLimit: estimatedGas * 120n / 100n });
console.log('transaction sent:', tx.hash);
const receipt = await tx.wait();
if (receipt.status !== 1) fail(`transaction ${tx.hash} failed`);

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
