// Solana answers for the balance, supply, holder and transaction routes. Each
// function takes the request params and the express response, and answers in
// the same shape as the EVM route it sits beside: summary, status, verdict,
// confidence, a stable canonical string and an as_of time.

import { RpcBudgetExceededError } from './ankrRpc.js';
import { respondUnusableInput } from './unusableInput.js';
import { freeTextParam, firstUsableValue } from './entityExtract.js';
import { getCoinPrice } from './defiLlamaApi.js';
import {
  extractSolanaAddresses,
  extractSolanaSignature,
  isSolanaAddress,
  isSolanaSignature,
  knownSolanaTokenByMint,
  knownSolanaTokenFromText,
  formatTokenAmount,
  solanaGetBalance,
  solanaGetTokenBalance,
  solanaGetTokenSupply,
  solanaGetTokenLargest,
  solanaGetSupply,
  solanaGetSignatureStatus,
  solanaGetTransaction,
} from './solanaRpc.js';

const CHAIN = 'solana';
const LABEL = 'Solana';
const EXPLORER = 'https://solscan.io';

function failure(res, err, what) {
  if (err instanceof RpcBudgetExceededError) {
    return res.status(503).json({ status: 'error', summary: `${what} could not complete within budget`, confidence: 1.0, error: err.message });
  }
  return res.status(502).json({ status: 'error', summary: `upstream Solana RPC call failed`, confidence: 1.0, error: err.message });
}

const textOf = (params, ...keys) => keys.map((k) => params?.[k]).filter((v) => typeof v === 'string').join(' ');

function numberWithCommas(decimalString) {
  const [whole, frac] = decimalString.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

// 6-decimal rounding of an exact decimal string, trailing zeros trimmed.
function roundDecimal(exact, places = 6) {
  const [whole, frac = ''] = exact.split('.');
  if (frac.length <= places) return exact;
  const kept = frac.slice(0, places).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

// ---------------------------------------------------------------- balance

export async function answerSolanaBalance(params, res) {
  const question = freeTextParam(params) ?? '';
  const tokenParam = firstUsableValue(params?.token, params?.mint, params?.token_address);
  const walletParam = firstUsableValue(params?.address, params?.wallet, params?.owner);
  const all = [walletParam, tokenParam, question].filter((v) => typeof v === 'string');

  let wallet = typeof walletParam === 'string' ? extractSolanaAddresses(walletParam)[0] ?? null : null;
  let mint = typeof tokenParam === 'string' ? extractSolanaAddresses(tokenParam)[0] ?? null : null;
  let known = mint ? knownSolanaTokenByMint(mint) : null;
  if (!mint) {
    // A symbol in the token parameter or the question names a known mint.
    known = knownSolanaTokenFromText(typeof tokenParam === 'string' ? tokenParam : '') ?? knownSolanaTokenFromText(question);
    if (known) mint = known.mint;
  }
  const found = all.flatMap((t) => extractSolanaAddresses(t));
  if (!wallet) wallet = found.find((a) => a !== mint) ?? null;
  // A second address in the question, after the wallet, is the token mint.
  if (!mint) {
    const second = found.find((a) => a !== wallet);
    if (second) { mint = second; known = knownSolanaTokenByMint(mint); }
  }
  // The wallet and the mint can arrive in either order; a known mint in the
  // wallet slot is never the wallet.
  if (wallet && knownSolanaTokenByMint(wallet) && !mint) { mint = wallet; known = knownSolanaTokenByMint(mint); wallet = found.find((a) => a !== mint) ?? null; }

  if (!wallet) {
    return respondUnusableInput(res, 'I cannot read a Solana balance because no Solana wallet address was supplied. A Solana address is 32 to 44 characters of letters and digits (base58). Pass one as the address parameter and I will return its SOL balance, or its balance of a token such as USDC when you name the token.');
  }
  const as_of = new Date().toISOString();

  try {
    if (!mint) {
      const lamports = BigInt(await solanaGetBalance(wallet));
      const exact = formatTokenAmount(lamports, 9);
      const rounded = roundDecimal(exact);
      let usd = null;
      try { usd = (await getCoinPrice('coingecko:solana'))?.priceUsd ?? null; } catch { usd = null; }
      const balance_usd = usd != null && Number.isFinite(usd) ? Number((Number(exact) * usd).toFixed(2)) : null;
      let summary = rounded === exact
        ? `${wallet} holds ${exact} SOL on ${LABEL}.`
        : `${wallet} holds ${rounded} SOL on ${LABEL} (exactly ${exact} SOL).`;
      if (balance_usd !== null && lamports > 0n) summary += ` At the current price of ${usd} USD per SOL that balance is worth about ${balance_usd} USD.`;
      summary += ` Raw balance ${lamports} lamports. Explorer: ${EXPLORER}/account/${wallet}.`;
      return res.json({
        summary,
        status: 'ok',
        verdict: lamports > 0n ? 'funded' : 'empty',
        balance_usd,
        chain: CHAIN,
        address: wallet,
        found: true,
        balance_lamports: lamports.toString(),
        balance_native: Number(exact),
        funded: lamports > 0n,
        explorer_url: `${EXPLORER}/account/${wallet}`,
        confidence: 1.0,
        canonical: [CHAIN, wallet, lamports.toString()].join(':'),
        as_of,
      });
    }

    const bal = await solanaGetTokenBalance(wallet, mint);
    let decimals = bal.decimals ?? known?.decimals ?? null;
    if (decimals === null) {
      // No token account for this mint: ask the mint itself for its decimals.
      try { decimals = (await solanaGetTokenSupply(mint)).decimals; } catch { decimals = null; }
    }
    const symbol = known?.symbol ?? null;
    const label = symbol ?? mint;
    if (decimals === null) {
      return res.json({
        summary: `${mint} is not a token mint on ${LABEL} that I can read, so no ${label} balance is stated for ${wallet}.`,
        status: 'ok', verdict: 'not_found', found: false, chain: CHAIN, address: wallet, token: mint,
        confidence: 0.5, canonical: [CHAIN, wallet, mint, '-'].join(':'), as_of,
      });
    }
    const exact = formatTokenAmount(bal.raw, decimals);
    const summary = bal.accounts === 0
      ? `${wallet} holds 0 ${label} on ${LABEL}: it has no token account for ${mint}.`
      : `${wallet} holds ${exact} ${label} on ${LABEL} (raw ${bal.raw} with ${decimals} decimals, across ${bal.accounts} token account${bal.accounts === 1 ? '' : 's'}).`;
    return res.json({
      summary,
      status: 'ok',
      verdict: bal.raw > 0n ? 'funded' : 'empty',
      chain: CHAIN,
      address: wallet,
      token: mint,
      token_symbol: symbol,
      found: true,
      balance_raw: bal.raw.toString(),
      balance_token: exact,
      balance_native: Number(exact),
      decimals,
      token_accounts: bal.accounts,
      funded: bal.raw > 0n,
      explorer_url: `${EXPLORER}/account/${wallet}`,
      confidence: 1.0,
      canonical: [CHAIN, wallet, mint, bal.raw.toString()].join(':'),
      as_of,
    });
  } catch (err) {
    if (err.rpcError) {
      return respondUnusableInput(res, `The Solana network rejected the request for ${wallet}: ${err.message}. Check that the address is a valid Solana wallet.`);
    }
    return failure(res, err, 'wallet balance lookup');
  }
}

// ----------------------------------------------------------------- supply

function pickMint(params) {
  const tokenRaw = firstUsableValue(params?.token, params?.mint, params?.contract, params?.token_address, params?.address, params?.contract_address, params?.symbol);
  const text = freeTextParam(params) ?? '';
  const direct = [tokenRaw, text].filter((v) => typeof v === 'string').flatMap((t) => extractSolanaAddresses(t))[0] ?? null;
  if (direct) return { mint: direct, known: knownSolanaTokenByMint(direct) };
  const known = knownSolanaTokenFromText(typeof tokenRaw === 'string' ? tokenRaw : '') ?? knownSolanaTokenFromText(text);
  return known ? { mint: known.mint, known } : { mint: null, known: null };
}

export async function answerSolanaSupply(params, res) {
  const { mint, known } = pickMint(params);
  const text = `${textOf(params, 'token', 'symbol', 'asset')} ${freeTextParam(params) ?? ''}`;
  const as_of = new Date().toISOString();

  try {
    if (!mint) {
      if (/\b(?:sol|solana)\b/i.test(text) && !/\b(?:wrapped|spl|mint|token)\b/i.test(text.replace(/solana token/i, ''))) {
        const s = await solanaGetSupply();
        const total = formatTokenAmount(s.total, 9);
        const circ = formatTokenAmount(s.circulating, 9);
        const summary = `The total supply of SOL, the native coin of ${LABEL}, is ${roundDecimal(total, 0)} SOL, of which ${roundDecimal(circ, 0)} SOL is circulating (exactly ${total} SOL total, raw ${s.total} lamports). SOL has no token mint, so this is read from the network's getSupply call.`;
        return res.json({
          status: 'ok', answer: summary, summary, verdict: 'found', found: true,
          confidence: 0.95,
          canonical: ['token-total-supply', CHAIN, 'sol', 'native', roundDecimal(total, 0)].join(':'),
          chain: CHAIN, token: 'SOL', symbol: 'SOL', native: true, decimals: 9,
          total_supply: total, total_supply_raw: String(s.total), circulating_supply: circ,
          source: 'Solana RPC getSupply', checked_at: as_of, as_of,
        });
      }
      return respondUnusableInput(res, 'I cannot read a Solana token supply because no token mint address was supplied. A mint address is 32 to 44 characters of letters and digits (base58). Pass it as the token parameter, or name USDC, USDT or wSOL, and I will return the total supply read from the chain.');
    }
    const s = await solanaGetTokenSupply(mint);
    const supply = s.uiAmountString ?? formatTokenAmount(s.amount, s.decimals);
    const symbol = known?.symbol ?? 'tokens';
    const summary = `The total supply of ${symbol} (${mint}) on ${LABEL} is ${numberWithCommas(supply)} ${symbol} at the latest confirmed slot (raw ${s.amount} with ${s.decimals} decimals), read on-chain with getTokenSupply.`;
    return res.json({
      status: 'ok', answer: summary, summary, verdict: 'found', found: true,
      reason: `Read on-chain from ${LABEL}${known ? ' (token matched by known table)' : ''}.`,
      confidence: 0.95,
      canonical: ['token-total-supply', CHAIN, mint, s.amount].join(':'),
      chain: CHAIN, token: mint, symbol, decimals: s.decimals,
      total_supply: supply, total_supply_raw: s.amount, block: 'latest',
      source: 'Solana RPC getTokenSupply', checked_at: as_of, as_of,
    });
  } catch (err) {
    if (err.rpcError) {
      const why = `${mint} is not a token mint on ${LABEL}, so it has no token supply to read (${err.message}).`;
      return res.json({
        status: 'ok', answer: why, summary: why, verdict: 'not_found', found: false, reason: why,
        confidence: 0.5, chain: CHAIN, token: mint, total_supply: null, checked_at: as_of, as_of,
      });
    }
    return failure(res, err, 'token supply lookup');
  }
}

// ---------------------------------------------------------------- holders

// The Solana node can only list the 20 largest token accounts, and a full
// holder count needs an indexer. Without one, no count is stated: the answer
// says so plainly and offers what the node can prove (supply, and how much the
// largest accounts hold), never a number dressed up as a count.
export async function answerSolanaHolders(params, res) {
  const { mint, known } = pickMint(params);
  const as_of = new Date().toISOString();
  if (!mint) {
    return respondUnusableInput(res, 'I cannot look up holders because no Solana token mint address was supplied. A mint address is 32 to 44 characters of letters and digits (base58). Name USDC, USDT or wSOL, or pass the mint as the token parameter.');
  }
  try {
    const supply = await solanaGetTokenSupply(mint);
    let top = null;
    try { top = await solanaGetTokenLargest(mint); } catch { top = null; }
    const symbol = known?.symbol ?? null;
    const label = symbol ?? mint;
    let concentration = null;
    let concentrationText = '';
    if (Array.isArray(top) && top.length && BigInt(supply.amount) > 0n) {
      const sum = top.reduce((a, r) => a + BigInt(r.amount), 0n);
      const pct = Number((sum * 10_000n) / BigInt(supply.amount)) / 100;
      concentration = { accounts_listed: top.length, share_of_supply_percent: pct, largest_account: top[0].address, largest_account_amount: top[0].uiAmountString ?? null };
      concentrationText = ` What the node can show is that the ${top.length} largest token accounts together hold ${pct}% of the ${numberWithCommas(supply.uiAmountString ?? formatTokenAmount(supply.amount, supply.decimals))} ${symbol ?? 'tokens'} supply; that is a concentration figure, not a holder count.`;
    }
    const summary = `The number of holders of ${label} (${mint}) on ${LABEL} is not available from a source I can verify, so no holder count is stated. A Solana node lists only the 20 largest token accounts and cannot count all of them, and a full count needs an indexer that this service does not have.${concentrationText}`;
    return res.json({
      chain: CHAIN,
      token: mint,
      status: 'ok',
      verdict: 'unavailable',
      found: false,
      summary,
      confidence: 1.0,
      canonical: [CHAIN, mint, '-'].join(':'),
      holders_count: null,
      token_symbol: symbol,
      decimals: supply.decimals,
      total_supply: supply.uiAmountString ?? formatTokenAmount(supply.amount, supply.decimals),
      ...(concentration ? { top_accounts: concentration } : {}),
      as_of,
    });
  } catch (err) {
    if (err.rpcError) {
      const why = `no SPL token mint found at ${mint} on ${LABEL}, so there are no holders to count`;
      return res.json({
        chain: CHAIN, token: mint, status: 'not_found', summary: why, confidence: 1.0,
        canonical: [CHAIN, mint, 'not_found'].join(':'), holders_count: null, as_of,
      });
    }
    return failure(res, err, 'token holder lookup');
  }
}

// ------------------------------------------------------------ transaction

export async function answerSolanaTx(params, res) {
  const question = freeTextParam(params) ?? '';
  const raw = firstUsableValue(params?.tx_hash, params?.signature, params?.tx, params?.hash, question);
  const sig = typeof raw === 'string' ? (isSolanaSignature(raw.trim()) ? raw.trim() : extractSolanaSignature(raw)) : null;
  if (!sig) {
    return respondUnusableInput(res, 'I cannot look up this Solana transaction because no transaction signature was supplied. A Solana signature is about 88 characters of letters and digits (base58). Pass it as the tx_hash parameter and I will report whether it confirmed or failed, its slot, block time and fee.');
  }
  const as_of = new Date().toISOString();
  try {
    const [status, tx] = await Promise.all([
      solanaGetSignatureStatus(sig),
      solanaGetTransaction(sig).catch((err) => { if (err.rpcError) return null; throw err; }),
    ]);
    if (!status && !tx) {
      const summary = `No transaction with signature ${sig} was found on ${LABEL} as of ${as_of}. It was never sent, was dropped before landing, is too old for the node's history, or is mistyped.`;
      return res.json({
        tx_hash: sig, chain: CHAIN, status: 'not_found', verdict: 'not_found', found: false, summary,
        confidence: 0.9, canonical: [CHAIN, sig, 'not_found', '-', '-', '-'].join(':'),
        slot: null, block_number: null, block_time: null, fee_lamports: null, as_of,
      });
    }
    const err = tx?.meta?.err ?? status?.err ?? null;
    const confirmation = status?.confirmationStatus ?? (tx ? 'confirmed' : null);
    const state = err ? 'failed' : confirmation === 'processed' ? 'pending' : 'confirmed';
    const slot = tx?.slot ?? status?.slot ?? null;
    const blockTime = tx?.blockTime ?? null;
    const blockTimeIso = blockTime ? new Date(blockTime * 1000).toISOString() : null;
    const fee = tx?.meta?.fee ?? null;
    const feeSol = fee !== null ? formatTokenAmount(fee, 9) : null;
    const keys = tx?.transaction?.message?.accountKeys ?? [];
    const first = keys[0];
    const signer = first ? (typeof first === 'string' ? first : first.pubkey) : null;
    const units = tx?.meta?.computeUnitsConsumed ?? null;
    const receipt_status = err ? 'failed' : state === 'pending' ? null : 'success';

    let summary = err
      ? `The transaction ${sig} on ${LABEL} failed (it landed on-chain, ${confirmation})`
      : `The transaction ${sig} on ${LABEL} is ${state}${state === 'confirmed' ? ` (${confirmation})` : ''}`;
    summary += slot !== null ? `, in slot ${slot}` : '';
    summary += blockTimeIso ? ` at ${blockTimeIso}` : '';
    summary += '.';
    if (err) summary += ` The error was ${JSON.stringify(err)}; the fee was still charged.`;
    else if (state === 'confirmed') summary += ' It executed successfully.';
    if (feeSol !== null) summary += ` The fee was ${feeSol} SOL (${fee} lamports).`;
    if (signer) summary += ` It was signed by ${signer}.`;
    if (units !== null) summary += ` It used ${units} compute units.`;
    summary += ` Explorer: ${EXPLORER}/tx/${sig}.`;

    return res.json({
      tx_hash: sig,
      chain: CHAIN,
      status: state,
      verdict: state,
      found: true,
      summary,
      confidence: confirmation === 'finalized' ? 1.0 : 0.9,
      canonical: [CHAIN, sig, state, slot ?? '-', blockTime ?? '-', receipt_status ?? '-'].join(':'),
      slot,
      block_number: slot,
      block_time: blockTime,
      block_time_iso: blockTimeIso,
      confirmation_status: confirmation,
      receipt_status,
      from: signer,
      fee_lamports: fee,
      fee_native: feeSol,
      compute_units: units,
      transaction_error: err,
      explorer_url: `${EXPLORER}/tx/${sig}`,
      as_of,
    });
  } catch (err) {
    if (err.rpcError) {
      return respondUnusableInput(res, `The Solana network rejected the signature ${sig}: ${err.message}.`);
    }
    return failure(res, err, 'transaction lookup');
  }
}
