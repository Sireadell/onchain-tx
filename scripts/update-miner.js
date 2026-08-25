import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://sepolia.base.org';

// Recovery attempt 2026-08-25: the first updateMiner(182, ...) call using
// a Keccak-256 YAML_HASH deregistered our working registration 182 and
// the replacement (214) was REJECTED by Telegraph's off-chain validator:
// "YAML hash mismatch: registered 23d8aa5b... (our Keccak-256), fetched
// 5e79db0a... — the document at the registered URL is not the one
// committed on chain." The "fetched" value is exactly this file's
// SHA-256, not its Keccak-256 — proof the validator hashes the fetched
// document with SHA-256, contradicting this repo's earlier assumption
// ("the registration contract uses the Keccak-256 hash", which was true
// for the separate scoring-module contract, not this one). OLD_REGISTRATION_ID
// is now 214 (the rejected one) since updateMiner deregisters whatever id
// you pass regardless of its status — same pattern as the earlier
// 125-rejected -> 182-active recovery already in this repo's history.
const OLD_REGISTRATION_ID = 214;
const YAML_URL = 'https://gateway.pinata.cloud/ipfs/Qmf7UBxjrw8JPXTC3rzezt3wenJdBVhRmaQqk5k7Rum4Rz';
const YAML_HASH = '0x5e79db0aab269ac68252e0735d19d5ce77af8a2edc7f4e3bdaa67a28efff29f9';
const FEE_ADDRESS = '0x6f477610A93C5B255C29c489760045272BCeDa99';
const MIN_PRICE_USDC = 10000;
const SUPPORTED_INTENTS = [
  'ONCHAIN_TX_LOOKUP',
  'GAS_PRICE',
  'WALLET_BALANCE_CHECK',
  'TOKEN_HOLDER_COUNT',
  'TVL_LOOKUP',
  'CRYPTO_PRICE',
  'STOCK_PRICE',
  'SSL_VERIFICATION',
];

const abi = [
  'function updateMiner(uint256,string,bytes32,address,uint256,string[]) returns (uint256)',
  'event MinerRegistered(uint256 indexed registrationId, address indexed miner, string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.MINER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(DIAMOND, abi, wallet);

console.log('sending from:', wallet.address);

const tx = await contract.updateMiner(
  OLD_REGISTRATION_ID,
  YAML_URL,
  YAML_HASH,
  FEE_ADDRESS,
  MIN_PRICE_USDC,
  SUPPORTED_INTENTS
);
console.log('tx hash:', tx.hash);

const receipt = await tx.wait();
console.log('status:', receipt.status === 1 ? 'success' : 'FAILED');
console.log('block:', receipt.blockNumber);
console.log('gas used:', receipt.gasUsed.toString());

const iface = new ethers.Interface(abi);
for (const log of receipt.logs) {
  try {
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'MinerRegistered') {
      console.log('new registrationId:', parsed.args.registrationId.toString());
    }
  } catch {}
}
