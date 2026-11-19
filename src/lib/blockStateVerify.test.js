import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeHeaderHash, pairChainsWithBlocks, verifyBlockState, wantsBlockState } from './blockStateVerify.js';

// Real headers, copied from public RPCs on 2026-11-19.
const ETH_18_5M = {"baseFeePerGas":"0x508de9016","difficulty":"0x0","extraData":"0x7273796e632d6275696c6465722e78797a","gasLimit":"0x1c9c380","gasUsed":"0xfa1306","hash":"0x80ce6bb0e244fbdf66cf0a1108273fe1ca58788efb7fb8d3a0d783d2b06d433d","logsBloom":"0xb569cf0345e0a3615489733aaf2419e944384c2318978d8dc9df073b6a7f8e232bfb11c901c08b3152de3b6c1804214c969128e88a5a3dc25bb4852c152d7a04e581d1a94d305be87927f63c9c2216eb95ad44c92864ecc155343605d8315e695aca2d5d12de221c2c9654065a596c4dbe3220e0811ca675dcde1dd5560e3c040cdf36df2ea8f90904fd06548b3705aa4566946b0b49511b4565b0422eb89ea0ff98ed3e0d8b6cefdb1358e8be131c940f4ef601d1215b46684f5ce2d6a2cd463dd63713300b632042016a918538d82505608b979f69bd7956effbbbf865e3ca0b77ffbdbea6b9d8dab7808b681ddcd3c5f5f864492ee4414c58b21729075449","miner":"0x1f9090aae28b8a3dceadf281b0f12828e676c326","mixHash":"0x2101f46ed50eb2f076bcf6947caf6fb6b4a41d2b0194829fa88449672fe7dc9a","nonce":"0x0000000000000000","number":"0x11a49a0","parentHash":"0x38e2aa07d0d1e3c9e5d0dd74d87dfd6a2f3981c6caa44c098eb0b55f3e04d99f","receiptsRoot":"0xbf8b722b10a328442a19941c649c67564b9d72d6183d7e310da0fe26645314ca","sha3Uncles":"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347","stateRoot":"0x70e98f0026572bee6fff2aa30bc3a9a773d89c9d87b43d98bdc5b25fc9235250","timestamp":"0x6546779f","transactionsRoot":"0x766a487b906d0a480b73ecee2ab939136ac8fd14eac0947bd67d0a98a8c722ec","withdrawalsRoot":"0xd20830c71f79d83c40523f747f9e4594a19c930be1fb7b529a22d2a9eec770b1"};
const ARB_150M = {"baseFeePerGas":"0x5f5e100","difficulty":"0x1","extraData":"0x4cb7dd12349a993663fbdb2ff9a9dd458df4a0a0087c5946f29f26df0086b587","gasLimit":"0x4000000000000","gasUsed":"0x677148","hash":"0xc43cd2d95e40b5b672100e462a86b3f67259bd7398cf1c68b0e0e89cc2993ecf","l1BlockNumber":"0x11b3fb3","logsBloom":"0x0000000000000100400040000000000000000000002002000000000100080000000002800000800000200000040000000000400100002000000000000022000000001001402408080000000808000000000008000000000000000000000000000001000002000000000000040000080000000001000140000000001008080000800000000000000000040000000001000000000000800020000000040000000002008000000000000000000000000400000000000000840000000000000000000000a002000000000000000000000000000001000000000000000080080020000010000000800000000408040040200010081000000000000000000000000404","miner":"0xa4b000000000000000000073657175656e636572","mixHash":"0x0000000000017a2700000000011b3fb3000000000000000a0000000000000000","nonce":"0x000000000011ff22","number":"0x8f0d180","parentHash":"0xb7d74848aceb6b0dcf9d99c9059964853ddae880c9b0d735b420e5dc4b53e9aa","receiptsRoot":"0x19e46d0682b576bda9e3f82ab6ad8600607469238ff1c92911f8764f936fa043","sendCount":"0x17a27","sendRoot":"0x4cb7dd12349a993663fbdb2ff9a9dd458df4a0a0087c5946f29f26df0086b587","sha3Uncles":"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347","stateRoot":"0x2d8eda6d04a39349cfcce5608835f9720e96e0624454723e7b084148b69c2ac4","timestamp":"0x65521717","transactionsRoot":"0x30cebc28d457f75cb692afec8a9a9e3b414444137e788a748f6b54258ffdd2a8"};

test('block header hash is recomputed exactly for Ethereum and Arbitrum blocks', () => {
  assert.equal(recomputeHeaderHash(ETH_18_5M), ETH_18_5M.hash);
  assert.equal(recomputeHeaderHash(ARB_150M), ARB_150M.hash);
  assert.notEqual(recomputeHeaderHash({ ...ETH_18_5M, stateRoot: ARB_150M.stateRoot }), ETH_18_5M.hash);
});

test('chains are paired with the block named next to them', () => {
  const pairs = (q) => pairChainsWithBlocks(q).map((p) => `${p.chain}@${p.block}`).join(' ');
  assert.equal(pairs('Can you verify that the Arbitrum state root from block 170,000,000 is correctly represented in the latest block header on Optimism?'), 'arbitrum@170000000 optimism@latest');
  assert.equal(pairs('Can you verify that the state root on Arbitrum One, as of block 150000000, matches the state root committed on Optimism Mainnet for the same block height?'), 'arbitrum@150000000 optimism@150000000');
  assert.equal(pairs('Can you verify that the block header for block #18,500,000 on the Ethereum mainnet is valid and correctly represents the state transition to the Sepolia testnet?'), 'eth@18500000 sepolia@18500000');
  assert.equal(pairs('Can you verify that the Arbitrum state root on block 123456789 matches the state root committed on the Base chain?'), 'arbitrum@123456789 base@latest');
  assert.ok(wantsBlockState('verify the state root on Arbitrum'));
  assert.ok(!wantsBlockState('is this wallet active on Base'));
});

function stubRpc(t, blocks) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (!str.includes('publicnode.com')) return original(url, init);
    const host = new URL(str).host;
    const { method, params } = JSON.parse(init.body);
    const result = method === 'eth_blockNumber' ? '0xb9a8f0' : (blocks[`${host} ${params[0]}`] ?? null);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
}

test('two rollups: the premise is corrected first, both blocks are read', async (t) => {
  stubRpc(t, {
    'arbitrum-one-rpc.publicnode.com 0x8f0d180': ARB_150M,
    'optimism-rpc.publicnode.com 0x8f0d180': { ...ETH_18_5M, number: '0x8f0d180' },
  });
  const r = await verifyBlockState('Does the state root on Arbitrum One at block 150000000 match the one on Optimism for the same block height?');
  assert.equal(r.verdict, 'unverifiable');
  assert.match(r.summary, /^Cannot be verified as asked: OP Mainnet does not hold Arbitrum One's state roots/);
  assert.match(r.summary, /post their state commitments to Ethereum, not to each other/);
  assert.doesNotMatch(r.summary, /0x[0-9a-f]{64}/);
  assert.equal(r.blocks[0].header_hash_matches, true);
});

test('mainnet block asked about on Sepolia: valid on mainnet, absent on Sepolia', async (t) => {
  stubRpc(t, { 'ethereum-rpc.publicnode.com 0x11a49a0': ETH_18_5M });
  const r = await verifyBlockState('Is the block header for block #18,500,000 on the Ethereum mainnet valid on the Sepolia testnet?');
  assert.match(r.summary, /^Cannot be verified as asked: Sepolia is a separate test chain/);
  assert.match(r.summary, /block 18,500,000 header is valid/);
  assert.match(r.summary, /Sepolia has not reached block 18,500,000/);
  assert.equal(r.blocks[0].header_hash_matches, true);
});

test('LayerZero nonce question explains what identifies a message', async (t) => {
  stubRpc(t, {});
  const r = await verifyBlockState('Can you verify that the LayerZero message with nonce 12345 sent from Arbitrum to Base was successfully executed on Base, and confirm that the state root committed matches?');
  assert.equal(r.verdict, 'unverifiable');
  assert.match(r.summary, /^Not verifiable as asked\. A LayerZero message is identified by its GUID or its source transaction hash/);
  assert.match(r.summary, /never holds an Arbitrum One state root/);
});
