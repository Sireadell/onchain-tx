import { readFileSync } from 'fs';

const jwt = readFileSync(new URL('./.pinata-jwt-tmp', import.meta.url), 'utf8').trim();
const yaml = readFileSync(new URL('../miner.yaml', import.meta.url), 'utf8');

const form = new FormData();
form.append('file', new Blob([yaml], { type: 'text/yaml' }), 'miner.yaml');

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
