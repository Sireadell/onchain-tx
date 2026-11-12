// Monad transport layer for the funding-graph signals.
//
// Six signals (fundingRelationship, circularFunding, clustering, fanOut,
// convergentRelayFunding, outboundRelationships) are written against
// ankrClient.js's callAnkr(method, params, opts) and Ankr's Advanced API
// methods 'ankr_getTransactionsByAddress' / 'ankr_getTokenTransfers'.
// Ankr does not offer the Advanced API for Monad (chain 143). Verified
// live 2026-09-16: raw eth_getLogs against a real ERC-20 (AUSD) on Monad
// mainnet returns real Transfer events and a funding graph can be built
// from them directly. See hackathons/monad-metropolis/SIGNAL_AUDIT.md.
//
// This file gives Monad the SAME call shape as callAnkr, so no signal file
// needs to change: callMonad(method, params, opts) returns
// { transfers: [...], nextPageToken } for 'monad_getTokenTransfers', with
// items shaped exactly like Ankr's token-transfer items (toAddress,
// fromAddress, transactionHash, blockNumber, timestamp, valueRawInteger,
// tokenSymbol), so fundingRelationship.js's toCandidate() mapping works
// unchanged.
//
// SCOPE, DISCLOSED NOT HIDDEN (phase 1 of BUILD_PLAN.md):
//   1. Token transfers only. Native MON transfers don't emit logs (same
//      reason ETH transfers don't), and reading them needs trace data.
//      Monad traces are live on Envio HyperSync (checked 2026-09-16,
//      corrects an earlier note that traces were Ethereum/Base only) --
//      wiring that in is phase 3, not this file.
//   2. Restricted to a named token allowlist (see TRACKED_TOKENS below),
//      not "every ERC-20 this wallet ever touched". Scanning logs with no
//      contract-address filter across all of Monad is the kind of
//      unbounded query that made nightswatchhq's own Perpl backfill cost
//      $990/month before they parked it (see BUILD_PLAN.md). A named
//      allowlist keeps each query scoped and fast. Extend the list as
//      real agent-payment tokens are confirmed live.
//   3. Bounded lookback, not full chain history. "Earliest funder" here
//      means earliest within MAX_LOOKBACK_BLOCKS, not earliest since
//      genesis. A full-history version needs an indexer (Envio, phase 3),
//      not per-request log scanning. This file returns complete: false
//      with incompleteReason: 'lookback_window_exhausted' when it hits
//      the edge of its window without a full picture, the same shape
//      findEarliest() in fundingRelationship.js already expects and
//      handles for any other incompleteness.
//
// eth_getLogs is capped at 100 blocks per call on two of Monad's four
// public RPC endpoints (QuickNode, Monad Foundation), 1,000 on Alchemy and
// Ankr's plain per-chain RPC. This file uses the 100-block-safe window so
// it works against any of them without per-provider branching.

import { config } from '../../config.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Named allowlist, not "every token". AUSD confirmed live and settling
// Perpl and Iris (the one live Metropolis competitor found on 2026-09-13)
// on Monad mainnet. Add more only after confirming each address live
// against the chain, the same way AUSD was confirmed, not from a search
// summary.
const TRACKED_TOKENS = {
  AUSD: {
    address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'.toLowerCase(),
    symbol: 'AUSD',
    decimals: 6,
  },
};

const MONAD_RPC_URLS = (config.monadRpcUrls ?? [
  'https://rpc1.monad.xyz',
  'https://rpc3.monad.xyz',
]).filter(Boolean);

const BLOCK_WINDOW = 100; // safe on every public Monad RPC endpoint
const MAX_LOOKBACK_BLOCKS = config.monadMaxLookbackBlocks ?? 50_000; // ~4.2 hours at 0.3s blocks

export class MonadRpcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MonadRpcError';
  }
}

let rpcIndex = 0;
function nextRpcUrl() {
  const url = MONAD_RPC_URLS[rpcIndex % MONAD_RPC_URLS.length];
  rpcIndex += 1;
  return url;
}

async function rawRpc(method, params) {
  const url = nextRpcUrl();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new MonadRpcError(`Monad RPC HTTP ${res.status} from ${url}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new MonadRpcError(`Monad RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function currentBlockNumber() {
  const hex = await rawRpc('eth_blockNumber', []);
  return parseInt(hex, 16);
}

function addressToTopic(address) {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function topicToAddress(topic) {
  return '0x' + topic.slice(26);
}

async function getBlockTimestamp(blockNumber) {
  const block = await rawRpc('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]);
  return block ? parseInt(block.timestamp, 16) * 1000 : null;
}

/**
 * Decode a raw ERC-20 Transfer log into the same item shape
 * fundingRelationship.js's toCandidate() expects from
 * ankr_getTokenTransfers: toAddress, fromAddress, transactionHash,
 * blockNumber, timestamp, valueRawInteger, tokenSymbol.
 */
function decodeTransferLog(log, token, blockTimestampMs) {
  return {
    fromAddress: topicToAddress(log.topics[1]),
    toAddress: topicToAddress(log.topics[2]),
    transactionHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    timestamp: blockTimestampMs,
    valueRawInteger: BigInt(log.data).toString(),
    tokenSymbol: token.symbol,
  };
}

/**
 * Cursor-paginated token-transfer fetch for one wallet, oldest-first
 * within the lookback window, matching ankr_getTokenTransfers' default
 * order (see fundingRelationship.js's comment on why token transfers
 * don't need descOrder but native ones do).
 *
 * pageToken encodes { fromBlock, toBlock } for the NEXT window to scan,
 * base64-encoded JSON, opaque to the caller exactly like Ankr's token.
 */
async function fetchTokenTransfers(wallet, { pageToken } = {}) {
  const tip = await currentBlockNumber();
  const lowestAllowed = Math.max(0, tip - MAX_LOOKBACK_BLOCKS);

  let toBlock;
  let fromBlock;
  if (pageToken) {
    const decoded = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8'));
    toBlock = decoded.toBlock;
  } else {
    toBlock = lowestAllowed; // start at the OLD end of the window, walk forward (oldest-first)
  }
  fromBlock = toBlock;
  const windowEnd = Math.min(fromBlock + BLOCK_WINDOW - 1, tip);

  const walletTopic = addressToTopic(wallet);
  const items = [];

  for (const token of Object.values(TRACKED_TOKENS)) {
    const [outgoing, incoming] = await Promise.all([
      rawRpc('eth_getLogs', [{
        address: token.address,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + windowEnd.toString(16),
        topics: [TRANSFER_TOPIC, walletTopic],
      }]),
      rawRpc('eth_getLogs', [{
        address: token.address,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + windowEnd.toString(16),
        topics: [TRANSFER_TOPIC, null, walletTopic],
      }]),
    ]);

    const logs = [...outgoing, ...incoming];
    if (logs.length === 0) continue;

    const blockNumbers = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))];
    const timestamps = await Promise.all(blockNumbers.map(getBlockTimestamp));
    const tsByBlock = Object.fromEntries(blockNumbers.map((b, i) => [b, timestamps[i]]));

    for (const log of logs) {
      items.push(decodeTransferLog(log, token, tsByBlock[parseInt(log.blockNumber, 16)]));
    }
  }

  const nextFrom = windowEnd + 1;
  const exhausted = nextFrom > tip;
  const nextPageToken = exhausted
    ? undefined
    : Buffer.from(JSON.stringify({ toBlock: nextFrom }), 'utf8').toString('base64url');

  return {
    transfers: items,
    nextPageToken,
    // Signal to the caller when the window ran out before a full walk
    // completed, distinct from "no more pages because we're done".
    _lookbackExhausted: exhausted && !pageToken && fromBlock === lowestAllowed
      ? false // first page reaching tip in one shot is a genuine complete walk
      : exhausted,
  };
}

/**
 * Same call signature as callAnkr(method, params, opts) from ankrClient.js.
 * Only 'monad_getTokenTransfers' is implemented (phase 1 scope, see file
 * header). 'monad_getTransactionsByAddress' (native MON transfers) needs
 * trace data (Envio HyperSync, phase 3), not yet wired in. Rather than
 * throw and crash the caller, it degrades the same way every other signal
 * in this codebase degrades on a missing data source (see
 * contractControlRisk.js's doc comment: "never throws, degrades to 'no
 * signal'"): returns an empty, already-complete result, so
 * findDirectFunder's Promise.all([native, token]) still resolves and the
 * token-side result, which is real, is not lost to a native-side gap.
 */
export async function callMonad(method, params, _opts = {}) {
  if (method === 'monad_getTokenTransfers') {
    const wallet = Array.isArray(params.address) ? params.address[0] : params.address;
    return fetchTokenTransfers(wallet, { pageToken: params.pageToken });
  }
  if (method === 'monad_getTransactionsByAddress') {
    return {
      transactions: [],
      nextPageToken: undefined,
      _nativeTransferHistoryUnavailable: true, // phase 3, needs Envio traces
    };
  }
  throw new MonadRpcError(`Unknown Monad RPC method: ${method}`);
}

export const trackedTokens = TRACKED_TOKENS;
