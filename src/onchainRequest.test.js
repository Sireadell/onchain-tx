import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// An ERC-8183 job only reaches the right endpoint when miner.yaml's
// on_chain.request lists it. A missing entry sends the job to the first
// endpoint in the file with no parameters, which is how the Amanat storm
// contract's jobs ended up at /check-tx (Sireadell/onchain-tx pull request 1).
// So every endpoint added later needs an entry here too.
// Git on Windows may check the file out with CRLF line endings.
const yamlText = readFileSync(new URL('../miner.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Telegraph V2 no longer reads on_chain, and the block was dropped to keep the file small, so
// these checks only apply while a legacy block is present.
const hasOnChain = yamlText.includes('\non_chain:');
const onChain = hasOnChain ? yamlText.slice(yamlText.indexOf('\non_chain:')) : '';

const endpointPaths = [...new Set(
  [...(hasOnChain ? yamlText.slice(0, yamlText.indexOf('\non_chain:')) : yamlText).matchAll(/^ {2}- path: \/(\S+)/gm)].map((m) => m[1]),
)];
const requestEndpoints = [...onChain.matchAll(/^ {4}- endpoint: (\S+)/gm)].map((m) => m[1]);

test('every endpoint can be reached by an on-chain job', { skip: !hasOnChain }, () => {
  assert.ok(endpointPaths.length > 60, 'expected the full endpoint list');
  const missing = endpointPaths.filter((p) => !requestEndpoints.includes(p));
  assert.deepEqual(missing, []);
});

test('no on-chain request entry points at an endpoint that does not exist', { skip: !hasOnChain }, () => {
  const unknown = requestEndpoints.filter((e) => !endpointPaths.includes(e));
  assert.deepEqual(unknown, []);
  assert.equal(new Set(requestEndpoints).size, requestEndpoints.length, 'an endpoint is listed twice');
});

test('the fraud endpoint takes its question in the POST body, the rest in the query', { skip: !hasOnChain }, () => {
  assert.match(onChain, /- endpoint: fraud-query\n {6}method: POST\n {6}content_type: application\/json\n {6}body:\n {8}query: \{ source: strings\.0 \}/);
  assert.match(onChain, /- endpoint: check-tx\n {6}method: GET\n {6}query_params:\n {8}tx_hash: \{ source: strings\.0 \}/);
  assert.match(onChain, /- endpoint: storm-alert\n {6}method: GET\n {6}query_params:\n {8}location: \{ source: strings\.0 \}/);
});
