import { readFileSync } from 'fs';

const jwt = readFileSync(new URL('./.pinata-jwt-tmp', import.meta.url), 'utf8').trim();
const wasmPath = new URL(
  '../scoring-module/target/wasm32-unknown-unknown/release/txlens_onchain_tx_lookup_scorer.wasm',
  import.meta.url
);
const wasm = readFileSync(wasmPath);

const form = new FormData();
form.append('file', new Blob([wasm], { type: 'application/wasm' }), 'txlens-onchain-tx-lookup-scorer.wasm');

const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
  body: form,
});

const body = await res.json();
if (!res.ok) {
  console.error('pin failed', res.status, body);
  process.exit(1);
}

console.log('CID:', body.IpfsHash);
console.log('gateway url:', `https://gateway.pinata.cloud/ipfs/${body.IpfsHash}`);
console.log('ipfs url:', `ipfs://${body.IpfsHash}`);
