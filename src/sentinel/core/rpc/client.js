// Chain-aware transport entrypoint. The six funding-graph signals
// (fundingRelationship, circularFunding, clustering, fanOut,
// convergentRelayFunding, outboundRelationships) import `callAnkr` from
// here instead of from ankrClient.js directly. Their own detection logic
// does not change at all -- only where the data comes from does.
//
// On any chain Ankr's Advanced API covers, this is a passthrough to the
// real callAnkr. On Monad (chain 143), which Ankr does not offer the
// Advanced API for, it transparently redirects to monadClient.js's
// callMonad, translating the Ankr method name to the Monad equivalent.
// monadClient.js's 'monad_getTokenTransfers' returns the exact same
// response shape as Ankr's 'ankr_getTokenTransfers'
// (transfers[]/nextPageToken, items with toAddress/fromAddress/
// transactionHash/blockNumber/timestamp/valueRawInteger/tokenSymbol), so
// no signal file needs to know which chain it is running against.
//
// See hackathons/monad-metropolis/SIGNAL_AUDIT.md and BUILD_PLAN.md
// phase 1 for why this exists and what it does and does not cover yet.

import { callAnkr as callAnkrReal } from './ankrClient.js';
import { callMonad } from './monadClient.js';
import { config } from '../../config.js';

const ANKR_TO_MONAD_METHOD = {
  ankr_getTokenTransfers: 'monad_getTokenTransfers',
  ankr_getTransactionsByAddress: 'monad_getTransactionsByAddress',
};

export async function callAnkr(method, params, opts = {}) {
  const chain = params?.blockchain ?? config.chain;
  if (chain === 'monad') {
    const monadMethod = ANKR_TO_MONAD_METHOD[method];
    if (!monadMethod) {
      throw new Error(`No Monad equivalent wired for Ankr method: ${method}`);
    }
    return callMonad(monadMethod, params, opts);
  }
  return callAnkrReal(method, params, opts);
}
