import { ethers } from 'ethers';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const RPC = 'https://sepolia.base.org';

const OLD_REGISTRATION_ID = 112;
const YAML_URL = 'https://lavender-acceptable-goldfish-613.mypinata.cloud/ipfs/QmWLz9PuGU88AnGz7wDtyWDDym6jvyjDGPNpsgVyKyHvry';
const YAML_HASH = '0x752807b35d41bfed77edd8026a971a9989748ed50f2cab13df85136e9e25f760';
const FEE_ADDRESS = '0x6f477610A93C5B255C29c489760045272BCeDa99';
const MIN_PRICE_USDC = 10000;
const SUPPORTED_INTENTS = ['ONCHAIN_TX_LOOKUP'];

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
