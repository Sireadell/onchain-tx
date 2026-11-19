// Every case below is a real question from the scorer feed (request logs of
// 2026-11-17 to 2026-11-19), unless marked "made up" where a counter case was
// needed to pin down a boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBlock, readBlockRange, readBlockValue, parseIntegerText,
  readCount, readDurations, readRanges, readDateRange, stripQualifiers,
  readTicker, readTokenSymbol, readChain, readChainMention, readChains,
  cleanSubject, splitInstructions, stripChainFalseFriends, aiExtract,
} from './questionRead.js';

/* ---------- readBlock ---------- */

const BLOCK_CASES = [
  ['Can you verify if the block header for block #18000000 on the Ethereum mainnet is valid on the Sepolia testnet?', '18000000'],
  ['Can you verify that the Arbitrum state root from block 170,000,000 is correctly represented in the latest block header on Optimism?', '170000000'],
  ['Can you verify that the Arbitrum state root on block 123456789 matches the state root committed on the Base chain?', '123456789'],
  ['Can you verify that the block header for block #18,500,000 on the Ethereum mainnet is valid and correctly represents the state transition to the Sepolia testnet?', '18500000'],
  ['Can you verify that the state root on Arbitrum One, as of block 150000000, matches the state root committed on Optimism Mainnet for the same block height?', '150000000'],
  ['For a reconciliation sheet I need details of 0x8158d3e87a086e645fbbd103e99725edd5fe741d3ce02da5377d0b9f283656de, a Polygon transaction. How many confirmations does it have? Reference block: 60,000,000 (the including block is confirmation one).', '60000000'],
  ['How old is 0x4ab382632cfd92e1aa90ac6cebe055ed74a64e07195a81791ffa83d2d930f10c on Base as of block 24,000,000? I want confirmations and elapsed time between the blocks\' timestamps.', '24000000'],
  ['At bitcoin block #540698, what was hashprice? Give the number in satoshis, not BTC or dollars.', '540698'],
  ['For the treasury report, what was the Bitcoin hashprice at block height 967,764? Sats please.', '967764'],
  ['Hi, using the block reward at 947,955, estimate miner revenue per unit of hashrate.', '947955'],
  ['At Ethereum block 20000000, verify the native ETH balance of the public address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 in Gwei.', '20000000'],
  ['For a DAO review, call delay() in seconds on 0x6d903f6003cca6255D85CcA4D3B5E5146dC33925 (Ethereum) with the state of block 19,000,000. What number comes back?', '19000000'],
  ['How much ETH did 0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b hold at block 11642021, in Gwei?', '11642021'],
  ['Provenance check for BAYC id 100. Which wallet held it when block 20,900,000 was current?', '20900000'],
  ['Reconciliation: What was the cbBTC balance held by contract 0x4e962bb3889bf030368f56810a9c96b83cb3e778 on Base at block 52,569,168?', '52569168'],
  ['What was the native Gwei balance of the Coinbase wallet 0x503828976D22510aad0201ac7ec88293211D23Da on Ethereum height 20500000?', '20500000'],
  ['What was the native coin balance of the address 0x1aD4926499557376359866335065130482B4e645 on the Arbitrum network at block number 110,500,000?', '110500000'],
  ['value of totalSupply() of the LP token at 0x397FF1542f962076d0BFE58eA045FfA2d347ACa0, Ethereum, block number 20,200,000', '20200000'],
  ['What is the total circulating supply of ETH on the Ethereum mainnet as of block 18000000?', '18000000'],
  ['What was the total supply of MKR on Ethereum at block 26,248,731?', '26248731'],
  ['How many WETH tokens does 0xf52cb3c47ebe35925906725fe849f2d6ad62fffe hold at block 26344263?', '26344263'],
  ['Look up the WETH balance of wallet 0x0d0707963952f2fba59dd06f2b425ace40b492fe as of block 26344263.', '26344263'],
  ['S=sqrtPriceX96; L=active liquidity. As_of 2026-01-09T22:05:47Z, Ethereum block 24200000, hash 0x2c3d22aa', '24200000'],
];

const NO_BLOCK_CASES = [
  'What is the attested reserve for WBTC at its pinned block? WBTC',
  'Find 0x29242e5766e0bd7ba0685dac13b470411bd78e6667b28c8cc6e3a23a2f32a59d on Polygon PoS and report its status, block and timestamp.',
  'Hashprice on 2026-05-02: network 897.6 EH/s, price $78,196, subsidy-only revenue of 144 blocks x 3.125 BTC. Give USD per TH/s per day.',
  'What is the current hashprice for 1 TH/s on the Bitcoin network, considering today\'s block reward and transaction fees?',
  'Classify wash-trading vs organic flow for Base pair 0xcc2bg2 (batch_v2_11): block_0_buyers=6, shared_funder_ratio=0.08, round_trip_volume_pct=0.06, weibull_arrival_k=1.07.',
  'For the AAVE/DAI pair on a sidechain, the top two traders always alternate buy and sell orders within the same block.',
  'Is 1.10.16.1 on any blocklists?',
  'Find peer-reviewed academic research papers about blockchain state management.',
  'Verify the status and block number for Ethereum transaction 0x3b1c6762ff054a3a60a7e0d37e6f8b1db6bb7887e47cf1a95a898b92b67f185f.',
];

test('readBlock reads every logged block phrasing, including commas, "#", "height N" and "block reward at N"', () => {
  for (const [q, want] of BLOCK_CASES) assert.equal(readBlock(q), want, q);
});

test('readBlock returns null when no block number is named, and never reads a hash, a count of blocks or a field name', () => {
  for (const q of NO_BLOCK_CASES) assert.equal(readBlock(q), null, q);
});

test('readBlockRange reads a logged block range in order', () => {
  assert.deepEqual(
    readBlockRange('Look at ERC-20 Transfer events emitted by USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359) on Polygon between blocks 55,000,000 and 55,000,002.'),
    { from: '55000000', to: '55000002' },
  );
  assert.equal(readBlockRange('What was the total supply of MKR on Ethereum at block 26,248,731?'), null);
});

test('readBlockValue and parseIntegerText read structured block params in every form the builder sends', () => {
  assert.equal(readBlockValue('19,000,000'), '19000000');
  assert.equal(readBlockValue('1.8e+07'), '18000000');
  assert.equal(readBlockValue('0x1060a3a'), String(0x1060a3a));
  assert.equal(readBlockValue('latest'), 'latest');
  assert.equal(readBlockValue('soon'), null);
  assert.equal(readBlockValue(''), null);
  assert.equal(parseIntegerText('19_000_000'), '19000000');
});

/* ---------- readCount ---------- */

const HEADLINE_NOUNS = ['headlines', 'headline', 'stories', 'articles'];

test('readCount reads the count asked for and leaves the topic without it', () => {
  const cases = [
    ['What are the top 5 news headlines regarding the ongoing semiconductor shortage in Asia today? 5', 5],
    ['What are the top 5 news headlines in London today regarding the housing market? 5', 5],
    ['What are the top 5 news headlines regarding the upcoming G7 summit in Italy? 5', 5],
    ['What are the top 5 news headlines today regarding the ongoing drought in California?', 5],
    ['What are the top 5 news headlines today regarding the upcoming Mars rover mission? 5', 5],
  ];
  for (const [q, n] of cases) {
    const r = readCount(q, { nouns: HEADLINE_NOUNS });
    assert.equal(r.count, n, q);
    assert.doesNotMatch(r.rest, /top 5/, q);
    assert.match(r.rest, /top news headlines/, q);
  }
  assert.equal(readCount('For a research search interface, extract 4 topic keywords from the supplied body text.', { nouns: ['keywords'] }).count, 4);
  assert.equal(readCount('Please summarize the key findings from the Q3 2023 earnings call for NVIDIA (NVDA) into three main bullet points.', { nouns: ['bullet points', 'points'] }).count, 3);
  // made up: number words and a trailing lead word
  assert.equal(readCount('Give me the ten latest headlines about Nvidia').count, 10);
});

test('readCount does not read durations, money or a described count as the count asked for', () => {
  assert.equal(readCount('What are the latest headlines regarding the ongoing drought in California?', { nouns: HEADLINE_NOUNS }), null);
  assert.equal(readCount('Did GitHub\'s Pull Requests component maintain 99.95% uptime over the last 60 days, based on component status?'), null);
  assert.equal(readCount('What is the chargeback probability for a $150 purchase at a restaurant, made by a cardholder who has had 2 chargebacks in the last 6 months?'), null);
  // The wash-trading question describes "the top 20 trading wallets"; asked
  // with the nouns a list route uses, it is not a request for 20 headlines.
  assert.equal(readCount('The on-chain data reveals that the top 20 trading wallets all have their first transaction as a transfer from a common creator address.', { nouns: HEADLINE_NOUNS }), null);
});

/* ---------- durations, ranges, date spans ---------- */

test('readDurations classifies ages and look-back windows instead of leaving them to be read as the value', () => {
  const sensor = readDurations('Is the water level sensor at the Oberkassel station reporting data that is less than 30 days old, within the range of 1.0 to 5.0 meters, and has a valid HMAC signature?');
  assert.deepEqual(sensor.map(({ kind, value, unit }) => ({ kind, value, unit })), [{ kind: 'max_age', value: 30, unit: 'day' }]);

  const seconds = readDurations('Is the temperature sensor on the "LivingRoom" device reporting data that is less than 30 seconds old and within the range of 15 to 25 degrees Celsius?');
  assert.equal(seconds[0].kind, 'max_age');
  assert.equal(seconds[0].unit, 'second');

  const sla = readDurations('Did GitHub\'s \'Actions\' component maintain at least 99.95% uptime during the last 30 days, based on component status?');
  assert.deepEqual(sla.map(({ kind, value, unit }) => ({ kind, value, unit })), [{ kind: 'lookback', value: 30, unit: 'day' }]);

  const risk = readDurations('What is the chargeback probability for a $150 purchase at a restaurant, made by a cardholder who has had 2 chargebacks in the last 6 months and made 3 transactions in the past hour?');
  assert.deepEqual(risk.map(({ kind, value, unit }) => [kind, value, unit]), [['lookback', 6, 'month'], ['lookback', 1, 'hour']]);

  const within = readDurations('What is the probability of a chargeback for a $500 purchase at a clothing store (MCC 5651) made on a card with the current transaction occurring within 5 minutes of the previous one?');
  assert.deepEqual(within.map(({ kind, value, unit }) => [kind, value, unit]), [['within', 5, 'minute']]);

  const window = readDurations('Did the authentication service maintain 99.95% uptime throughout Q3 2023 and resolve critical incidents within the 2-hour SLA?');
  assert.deepEqual(window.map(({ kind, value, unit }) => [kind, value, unit]), [['window', 2, 'hour']]);

  const lastFive = readDurations('What is the average CPU utilization for the container running the \'web-server\' application on host \'192.168.1.100\' over the last 5 minutes?');
  assert.deepEqual(lastFive.map(({ kind, value, unit }) => [kind, value, unit]), [['lookback', 5, 'minute']]);

  assert.deepEqual(readDurations('What is the current gas price on Ethereum in gwei?'), []);
});

test('readRanges reads expected ranges as bounds, with units', () => {
  const cases = [
    ['Is the water level sensor at the Oberkassel station reporting data that is less than 30 days old, within the range of 1.0 to 5.0 meters, and has a valid HMAC signature?', 1, 5, 'meters'],
    ['Is the \'river_level_sensor_7B\' reporting live data, within the expected range of 0.5 to 2.5 meters, and is its data integrity confirmed?', 0.5, 2.5, 'meters'],
    ['Can you confirm if the \'living_room_temp\' sensor is currently sending data, if the temperature readings are within the expected range of 18-25°C?', 18, 25, '°C'],
    ['Can you confirm if the temperature sensor at Station Alpha is currently reporting, if its readings are within the expected -10°C to 40°C range?', -10, 40, '°C'],
    ['Is the temperature sensor on the Raspberry Pi at 192.168.1.100 still reporting data, and are the readings within the expected range of -10°C to 50°C?', -10, 50, '°C'],
    ['Can you verify that the sensor readings for station UUID \'a1b2c3d4-e5f6-7890-1234-567890abcdef\' are fresh, within the range of 1.5 to 3.0 meters?', 1.5, 3, 'meters'],
  ];
  for (const [q, min, max, unit] of cases) {
    const [r] = readRanges(q);
    assert.ok(r, q);
    assert.equal(r.min, min, q);
    assert.equal(r.max, max, q);
    assert.equal(r.unit, unit, q);
  }
  assert.deepEqual(readRanges('What is the current water temperature reading at NOAA buoy 46026?'), []);
});

test('readDateRange reads year spans and leaves single dates alone', () => {
  assert.deepEqual(
    readDateRange('recent academic articles discussing the impact of climate change on Arctic sea ice extent, focusing on research published between 2022 and 2023.'),
    { from: '2022', to: '2023', phrase: 'between 2022 and 2023' },
  );
  assert.equal(readDateRange('What was the EUR/USD exchange rate on 2026-10-30?'), null);
  assert.equal(readDateRange('Hashprice on 2026-05-02: network 897.6 EH/s, price $78,196'), null);
});

test('stripQualifiers removes ages, ranges and windows so the value read from the rest is the real one', () => {
  assert.equal(
    stripQualifiers('Is the water level sensor at the Oberkassel station reporting data that is less than 30 days old, within the range of 1.0 to 5.0 meters, and has a valid HMAC signature?'),
    'Is the water level sensor at the Oberkassel station reporting data that is, and has a valid HMAC signature?',
  );
  assert.equal(
    stripQualifiers('What was the average response time for Google Cloud services in the last 30 days?'),
    'What was the average response time for Google Cloud services?',
  );
});

/* ---------- tickers and token symbols ---------- */

test('readTicker reads bracketed, bare and dollar tickers and skips common abbreviations', () => {
  const cases = [
    ['What is the current share price of Apple (AAPL)?', 'AAPL'],
    ['What is the current trading price for Microsoft Corporation (MSFT) in USD?', 'MSFT'],
    ['What is the current trading price for NVIDIA Corporation (NVDA)?', 'NVDA'],
    ['What is the current share price of NVDA?', 'NVDA'],
    ['What is the current price of BNB in US dollars?', 'BNB'],
    ['What is the price of XMR in USD?', 'XMR'],
    ['What is the price of OP in USD?', 'OP'],
    ['How many unique wallets currently hold the $PEPE token on the Ethereum mainnet?', 'PEPE'],
    ['Are the reserves backing Tether (USDT) on the Ethereum mainnet sufficient to cover its circulating supply according to the latest attestation report?', 'USDT'],
    ['What is the live APY for Aave V3 USDC on Ethereum?', 'USDC'],
  ];
  for (const [q, want] of cases) assert.equal(readTicker(q), want, q);
  assert.equal(readTicker('What is the Total Value Locked (TVL) of Uniswap v3 on Arbitrum on Arbitrum?'), null);
  assert.equal(readTicker('Will Unichem Labs Ltd. stock rise?'), null);
  assert.equal(readTicker('What is the price of BTC in USD?', { exclude: ['BTC'] }), null);
});

test('readTokenSymbol reads mixed-case symbols in their logged phrasings and never a filler word', () => {
  const cases = [
    ['Reconciliation: What was the cbBTC balance held by contract 0x4e962bb3889bf030368f56810a9c96b83cb3e778 on Base at block 52,569,168?', 'cbBTC'],
    ['How many unique addresses currently hold the SHIB token on the Ethereum mainnet?', 'SHIB'],
    ['How many unique wallets currently hold the $PEPE token on the Ethereum mainnet?', 'PEPE'],
    ['Look up the WETH balance of wallet 0x0d0707963952f2fba59dd06f2b425ace40b492fe as of block 26344263.', 'WETH'],
    ['How many WETH tokens does 0xf52cb3c47ebe35925906725fe849f2d6ad62fffe hold at block 26344263?', 'WETH'],
    ['What was the total supply of MKR on Ethereum at block 26,248,731?', 'MKR'],
    ['Verify the token count for 0x4200000000000000000000000000000000000042: how many OP exist on optimism?', 'OP'],
    ['What is the current staking APY and reward structure for Backed IBTA (bIBTA) on Ethereum?', 'bIBTA'],
    ['Current yield for SDOLA on inverse-finance-firm, Ethereum?', 'SDOLA'],
    ['What is the current trading price for NVIDIA Corporation (NVDA)?', 'NVDA'],
    ['Ops: What is the USDC balance of 0x6788f8c9fd926be09d870d438251ab34c35c64ac on OP Mainnet? Mention when you read it.', 'USDC'],
  ];
  for (const [q, want] of cases) assert.equal(readTokenSymbol(q), want, q);
  assert.equal(readTokenSymbol('How many holders does the token at 0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce on base have?'), null);
  assert.equal(readTokenSymbol('How many unique wallet addresses currently hold the token with contract address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on the Base network?'), null);
});

test('readTokenSymbol with a known list matches the earliest known symbol, without regard to case', () => {
  const known = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'USDbC'];
  assert.equal(readTokenSymbol('What is the usdc balance of 0xa5fdb69F410fF432b2033B01c45C794e1F5949D8 on base?', { known }), 'USDC');
  assert.equal(readTokenSymbol('What is the ETH balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 on ethereum?', { known }), null);
});

/* ---------- chains ---------- */

test('readChain prefers the chain after "on" and skips "base fee", "base versus incentive" and coin tickers', () => {
  const cases = [
    ['What is the ETH balance of 0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8 on base?', 'base'],
    ['What is the current ETH balance of the ENS name \'vitalik.eth\' on the Ethereum mainnet?', 'eth'],
    ['Ops: What is the USDC balance of 0x6788f8c9fd926be09d870d438251ab34c35c64ac on OP Mainnet? Mention when you read it.', 'optimism'],
    ['Find 0x29242e5766e0bd7ba0685dac13b470411bd78e6667b28c8cc6e3a23a2f32a59d on Polygon PoS and report its status, block and timestamp.', 'polygon'],
    ['Auditing Base history: tx 0x93f241c2db70a213a2f4164fbebe4fcd8ad003b73cfdeb018ded2a116c05b860. Was it recorded as a success or did it bounce?', 'base'],
    ['Check base tx 0xd04021aba95a35ad24ac8a87db13587dbda2849a5b5c4e1eac7268f46810e7a5: who paid, who received, and how much?', 'base'],
    ['Is the ETH-USDC vault on gmx-evm (Arbitrum) still paying a good rate? Give the APY.', 'arbitrum'],
    ['What was the native coin balance of the address 0x742d35Cc6634C0532925a3b844Bc454e4438f44e at block 18000000 on the Polygon network?', 'polygon'],
    ['current Avalanche C-Chain gas in gwei', 'avalanche'],
    ['What is the current gas price on Arbitrum One, in gwei?', 'arbitrum'],
    ['Polygon fees felt high yesterday, what are they at now?', 'polygon'],
  ];
  for (const [q, want] of cases) assert.equal(readChain(q)?.key, want, q);
  // A covered chain is never read from a ticker or a "base" that is not one.
  for (const q of [
    'Base fee and priority fee on Scroll right now?',
    'Desk question: Compare base versus incentive yield for STEAKETH on morpho-blue (Monad). Mention when you read it.',
    'What is the price of ETH in USD?',
    'What is the price of AVAX in USD?',
    'What is the total USD liquidity of pool ETH-WETH-USDC-005?',
  ]) assert.equal(readChain(q), null, q);
});

test('readChainMention names a chain this miner does not cover, so the answer can say so', () => {
  assert.deepEqual(
    (({ name, chain }) => ({ name, chain }))(readChainMention('Base fee and priority fee on Scroll right now?')),
    { name: 'Scroll', chain: null },
  );
  assert.equal(readChainMention('What is the current gas price on BNB Smart Chain in gwei?').name, 'BNB Smart Chain');
  assert.equal(readChainMention('Celo gas price now (gwei)?').name, 'Celo');
  assert.equal(readChainMention('Look up transaction 0xe6a8f1dfe8b8db282637acfda533ebbb292c9ee7217c02bc2be48c0e2aff0396 on Base Sepolia. What is its status?').chain.key, 'base-sepolia');
});

test('readChains lists every chain named, in order', () => {
  const keys = readChains('Can you verify that the Arbitrum state root from block 170,000,000 is correctly represented in the latest block header on Optimism?').map((c) => c.chain?.key);
  assert.deepEqual(keys, ['arbitrum', 'optimism']);
});

test('stripChainFalseFriends blanks "base" words that are not the Base chain and keeps real chain names', () => {
  const out = stripChainFalseFriends('Desk question: Compare base versus incentive yield for STEAKETH on morpho-blue (Monad).');
  assert.doesNotMatch(out, /\bbase\b/i);
  assert.match(out, /Monad/);
  assert.match(stripChainFalseFriends('What is the ETH balance of 0x5a23 on base?'), /on base\?/);
  assert.equal(stripChainFalseFriends('Before we list it, current yield for BTCB on venus-core-pool on BSC: base and reward APY?').length,
    'Before we list it, current yield for BTCB on venus-core-pool on BSC: base and reward APY?'.length);
});

/* ---------- cleanSubject ---------- */

test('cleanSubject strips question words, filler, time words and trailing instructions from the logged TVL questions', () => {
  const cases = [
    ['How big is Meteora DLMM in deposits right now? Keep it brief.', 'Meteora DLMM'],
    ['How much capital sits in ether.fi Liquid contracts at the moment? Round sensibly.', 'ether.fi Liquid'],
    ['What is the Total Value Locked in PancakeSwap across all supported chains?', 'PancakeSwap'],
    ['What is the Total Value Locked (TVL) of Uniswap v3 on Arbitrum on Arbitrum?', 'Uniswap v3'],
    ['What is the Total Value Locked in Morpho lending vaults?', 'Morpho'],
    ['What is the current Total Value Locked (TVL) for the Curve Finance protocol on the Ethereum mainnet?', 'Curve Finance'],
    ['What is the total value locked in the Aave protocol on the Ethereum mainnet?', 'Aave'],
  ];
  for (const [q, want] of cases) assert.equal(cleanSubject(q, { stripChain: true }), want, q);
});

test('cleanSubject reads price, holder, gas, sports and yield subjects from logged questions', () => {
  const cases = [
    ['What is the current price of BNB in US dollars?', 'BNB'],
    ['What is the price of ATOM in USD?', 'ATOM'],
    ['What\'s the price of QWZX token?', 'QWZX'],
    ['What is the price of DOT?', 'DOT'],
    ['What is the current trading price for Microsoft Corporation (MSFT) in USD?', 'Microsoft Corporation (MSFT)'],
    ['What is the current share price of Apple (AAPL)?', 'Apple (AAPL)'],
    ['How many unique addresses currently hold the SHIB token on the Ethereum mainnet?', 'SHIB'],
    ['How many unique wallets currently hold the $PEPE token on the Ethereum mainnet?', '$PEPE'],
    ['How much is gas on Gnosis Chain right now?', 'Gnosis Chain'],
    ['What\'s the gas price on Linea at the moment?', 'Linea'],
    ['What is the current gas price on Arbitrum One, in gwei?', 'Arbitrum One'],
    ['What is the current score for the Manchester United vs. Liverpool match?', 'Manchester United vs. Liverpool'],
    ['What\'s the score of the Yankees vs. Red Sox game right now?', 'Yankees vs. Red Sox'],
    ['What is the live APY for Aave V3 USDC on Ethereum?', 'Aave V3 USDC'],
    ['What is the current staking APY and reward structure for Morpho Steakhouse USDC Vault on Ethereum?', 'Morpho Steakhouse USDC Vault'],
    ['What is the current staking APY and reward structure for Backed IBTA (bIBTA) on Ethereum?', 'Backed IBTA (bIBTA)'],
    ['Give me the annualised yield and TVL of kamino-lend\'s PYUSD pool on Solana.', 'kamino-lend\'s PYUSD pool'],
  ];
  for (const [q, want] of cases) assert.equal(cleanSubject(q, { stripChain: true }), want, q);
});

test('cleanSubject reads news and research topics without the count, the kind of item or the echo after "?"', () => {
  const cases = [
    ['What are the latest headlines regarding the ongoing drought in California?', 'drought in California'],
    ['What are the latest headlines regarding the upcoming G7 summit in Italy?', 'G7 summit in Italy'],
    ['What are the top 5 news headlines regarding the ongoing semiconductor shortage in Asia today? 5', 'semiconductor shortage in Asia'],
    ['What are the top 5 news headlines today regarding the upcoming Mars rover mission? 5', 'Mars rover mission'],
    ['Search for the latest news and developments about Avalanche subnets enterprise adoption.', 'Avalanche subnets enterprise adoption'],
    ['What are the latest news articles about the impact of AI on the job market in the UK?', 'impact of AI on the job market in the UK'],
    ['Find peer-reviewed academic research papers about prediction markets blockchain.', 'prediction markets blockchain'],
    ['Find peer-reviewed academic research papers about cross-chain interoperability.', 'cross-chain interoperability'],
    ['What is the attested reserve for WBTC at its pinned block? WBTC', 'WBTC at its pinned block'],
  ];
  for (const [q, want] of cases) assert.equal(cleanSubject(q), want, q);
});

test('cleanSubject keeps the chain unless asked to strip it, and returns null for nothing', () => {
  assert.equal(cleanSubject('What is the total value locked in the Aave protocol on the Ethereum mainnet?'), 'Aave protocol on the Ethereum mainnet');
  assert.equal(cleanSubject(''), null);
  assert.equal(cleanSubject(null), null);
  assert.equal(cleanSubject('bitcoin'), 'bitcoin');
  assert.equal(cleanSubject('USDC'), 'USDC');
});

test('splitInstructions drops instruction and context sentences and keeps the question', () => {
  const r = splitInstructions('Need this for an audit. Balance check on Ethereum: 0xf58e79a7bd26532ff525db5b78456eb2e79076ec, asset ETH. Round sensibly.');
  assert.equal(r.core, 'Balance check on Ethereum: 0xf58e79a7bd26532ff525db5b78456eb2e79076ec, asset ETH.');
  assert.deepEqual(r.instructions, ['Need this for an audit.', 'Round sensibly.']);
  const y = splitInstructions('For the weekly report, is the SPARKUSDTBC vault on morpho-blue (Ethereum) still paying a good rate? Give the APY. Mention when you read it.');
  assert.equal(y.core, 'For the weekly report, is the SPARKUSDTBC vault on morpho-blue (Ethereum) still paying a good rate?');
  assert.equal(y.instructions.length, 2);
  assert.equal(splitInstructions('Will Unichem Labs Ltd. stock rise?').core, 'Will Unichem Labs Ltd. stock rise?');
});

/* ---------- AI fallback ---------- */

test('aiExtract returns null without a language model key and never throws', async () => {
  const saved = { p: process.env.PERPLEXITY_API_KEY, g: process.env.GROQ_API_KEY, m: process.env.GEMINI_API_KEY };
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(await aiExtract('How big is Meteora DLMM in deposits right now?', ['protocol']), null);
    assert.equal(await aiExtract('', ['protocol']), null);
  } finally {
    if (saved.p !== undefined) process.env.PERPLEXITY_API_KEY = saved.p;
    if (saved.g !== undefined) process.env.GROQ_API_KEY = saved.g;
    if (saved.m !== undefined) process.env.GEMINI_API_KEY = saved.m;
  }
});
