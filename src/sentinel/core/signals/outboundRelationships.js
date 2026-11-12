import { callAnkr } from '../rpc/client.js';
import { config } from '../../config.js';

export const OUTBOUND_PAGE_SIZE = 100;
export const OUTBOUND_MAX_PAGES = 5;

function parseNativeTimestamp(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseTokenTimestamp(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseOptionalNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeMaxPages(value) {
  if (value === undefined) return OUTBOUND_MAX_PAGES;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('maxPages must be a positive integer');
  }
  return Math.min(value, OUTBOUND_MAX_PAGES);
}

async function walkSource(address, { method, listField, source, toRecord, client, maxPages, chain }) {
  const records = [];
  let pageToken;
  let pagesWalked = 0;

  do {
    const params = {
      blockchain: chain ?? config.chain,
      address: [address],
      pageSize: OUTBOUND_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    };
    const data = await client(method, params, {
      cacheKey: `${chain ?? config.chain}:${address.toLowerCase()}:${OUTBOUND_PAGE_SIZE}:${pageToken ?? ''}`,
      trace: {
        phase: 'outbound',
        signal: 'funder_fan_out+funding_cluster',
        address,
        source,
        page: pagesWalked + 1,
        cursor: pageToken ?? null,
        pageCap: maxPages,
      },
    });
    pagesWalked += 1;
    if (!data || !Array.isArray(data[listField])) {
      return { records, complete: false, pagesWalked, incompleteReason: 'malformed_rpc_result' };
    }
    for (const item of data[listField]) {
      const record = toRecord(item);
      if (record) records.push(record);
    }
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : undefined;
    if (!pageToken) return { records, complete: true, pagesWalked };
  } while (pagesWalked < maxPages);

  return { records, complete: false, pagesWalked, incompleteReason: 'page_cap_reached' };
}

/**
 * One bounded direct-outbound observation shared by fan-out and clustering.
 */
export async function observeDirectOutbound(address, opts = {}) {
  if (!address) {
    return { records: [], complete: true, pagesWalked: { native: 0, token: 0 } };
  }
  const key = address.toLowerCase();
  const client = opts.callAnkr ?? callAnkr;
  const maxPages = normalizeMaxPages(opts.maxPages);
  const [native, token] = await Promise.all([
    walkSource(address, {
      chain: opts.chain,
      method: 'ankr_getTransactionsByAddress',
      listField: 'transactions',
      source: 'native',
      toRecord: (tx) => tx?.from?.toLowerCase() === key && tx?.to
        ? {
            source: 'native',
            from: tx.from,
            to: tx.to,
            txHash: tx.hash,
            blockNumber: parseOptionalNumber(tx.blockNumber),
            ...(tx.blockHash ? { blockHash: tx.blockHash } : {}),
            valueRaw: tx.value !== undefined ? String(tx.value) : undefined,
            timestamp: parseNativeTimestamp(tx.timestamp),
            rpcMethod: 'ankr_getTransactionsByAddress',
          }
        : null,
      client,
      maxPages,
    }),
    walkSource(address, {
      chain: opts.chain,
      method: 'ankr_getTokenTransfers',
      listField: 'transfers',
      source: 'token',
      toRecord: (transfer) => transfer?.fromAddress?.toLowerCase() === key && transfer?.toAddress
        ? {
            source: 'token',
            from: transfer.fromAddress,
            to: transfer.toAddress,
            txHash: transfer.transactionHash,
            blockNumber: parseOptionalNumber(transfer.blockNumber),
            ...(transfer.blockHash ? { blockHash: transfer.blockHash } : {}),
            ...(parseOptionalNumber(transfer.logIndex) !== undefined
              ? { logIndex: parseOptionalNumber(transfer.logIndex) }
              : {}),
            valueRaw: transfer.valueRawInteger !== undefined
              ? String(transfer.valueRawInteger)
              : undefined,
            ...(transfer.tokenSymbol ? { symbol: transfer.tokenSymbol } : {}),
            ...(transfer.tokenAddress || transfer.contractAddress
              ? { assetAddress: transfer.tokenAddress ?? transfer.contractAddress }
              : {}),
            timestamp: parseTokenTimestamp(transfer.timestamp),
            rpcMethod: 'ankr_getTokenTransfers',
          }
        : null,
      client,
      maxPages,
    }),
  ]);
  const complete = native.complete && token.complete;
  return {
    records: [...native.records, ...token.records],
    complete,
    pagesWalked: { native: native.pagesWalked, token: token.pagesWalked },
    ...(complete ? {} : { incompleteReason: native.incompleteReason ?? token.incompleteReason }),
  };
}

export function directEdgeKey(record) {
  const hash = record.txHash?.toLowerCase();
  if (hash && record.logIndex !== undefined) return `${hash}:${record.logIndex}`;
  if (hash) return `${hash}:${record.from?.toLowerCase()}:${record.to?.toLowerCase()}`;
  return [
    record.from?.toLowerCase(),
    record.to?.toLowerCase(),
    record.assetAddress?.toLowerCase() ?? record.symbol ?? record.source,
    record.valueRaw ?? '',
    record.blockNumber ?? '',
    record.timestamp ?? '',
  ].join(':');
}

export function deduplicateDirectEdges(records) {
  const edges = new Map();
  for (const record of records) {
    const key = directEdgeKey(record);
    if (!edges.has(key)) edges.set(key, record);
  }
  return [...edges.values()];
}
