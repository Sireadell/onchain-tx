import { readFileSync } from 'fs';
import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://base-sepolia-rpc.publicnode.com';

const WASM_URL = 'https://gateway.pinata.cloud/ipfs/QmWeYgohKYDt9Mtu3arnCkZWUz7R49j9EMLDbHHTQjs61P';
const INTENT = 'ONCHAIN_TX_LOOKUP';
const wasmPath = new URL(
  '../scoring-module/target/wasm32-unknown-unknown/release/txlens_onchain_tx_lookup_scorer.wasm',
  import.meta.url
);

// wasmHash is keccak256 of the exact bytes hosted at WASM_URL — the node
// re-downloads and re-hashes the file, so this must match what
// pin-scoring-wasm.js actually uploaded, not a re-encoded copy.
const wasmBytes = readFileSync(wasmPath);
const WASM_HASH = ethers.keccak256(wasmBytes);
console.log('wasm bytes:', wasmBytes.length);
console.log('wasmHash:', WASM_HASH);

const abi = [
  'function registerWasm(bytes32,string,string) returns (uint256)',
  'function getCanonicalIntents() view returns (string[])',
  'event WasmRegistered(uint256 indexed registrationId, address indexed author, bytes32 wasmHash, string wasmUrl, string intent)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.MINER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(DIAMOND, abi, wallet);

console.log('sending from:', wallet.address);

const intents = await contract.getCanonicalIntents();
if (!intents.includes(INTENT)) {
  console.error(`intent '${INTENT}' not in canonical list:`, intents);
  process.exit(1);
}

const predictedId = await contract.registerWasm.staticCall(WASM_HASH, WASM_URL, INTENT);
console.log('predicted registrationId:', predictedId.toString());

const tx = await contract.registerWasm(WASM_HASH, WASM_URL, INTENT);
console.log('tx hash:', tx.hash);

const receipt = await tx.wait();
console.log('status:', receipt.status === 1 ? 'success' : 'FAILED');
console.log('block:', receipt.blockNumber);
console.log('gas used:', receipt.gasUsed.toString());

const iface = new ethers.Interface(abi);
for (const log of receipt.logs) {
  try {
    const parsed = iface.parseLog(log);
    if (parsed) {
      console.log(parsed.name, parsed.args);
    }
  } catch {}
}
