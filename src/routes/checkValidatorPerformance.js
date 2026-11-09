// VALIDATOR_PERFORMANCE_VERIFY: Ethereum consensus-layer validator status
// from a public beacon node (no key). Reports status, balance, slashing
// and activation/exit epochs for a validator index or 0x pubkey. Staking
// APR is not computed because it needs reward history the public node does
// not serve, and it is left out rather than guessed.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();
const BASE = 'https://ethereum-beacon-api.publicnode.com/eth/v1/beacon';
const FAR = '18446744073709551615';

export function parseValidatorId(value, text) {
  const raw = String(firstUsableValue(value) ?? '').trim();
  if (/^\d{1,9}$/.test(raw)) return raw;
  if (/^0x[0-9a-fA-F]{96}$/.test(raw)) return raw.toLowerCase();
  const m = String(text ?? '').match(/\b(0x[0-9a-fA-F]{96})\b|\bvalidator\s*(?:index\s*)?#?\s*(\d{1,9})\b/i);
  return m ? (m[1] ? m[1].toLowerCase() : m[2]) : null;
}

export const gwei = (s) => Number(s) / 1e9;

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.validator, params.validator_index, params.index, params.pubkey, params.id);
  const id = parseValidatorId(raw, freeTextParam(params));
  if (!id) return respondUnusableInput(res, `${quoteParam(raw)} is not a validator. Pass a validator index such as 1 or a 0x public key (96 hex characters).`);
  let v;
  try {
    v = (await getJson(`${BASE}/states/head/validators/${id}`)).data;
  } catch (err) {
    if (err.status === 404) return respondUnusableInput(res, `No Ethereum validator found for ${quoteParam(id)}.`);
    return upstreamDown(res, 'The Ethereum beacon node', err);
  }
  const bal = gwei(v.balance);
  const eff = gwei(v.validator.effective_balance);
  const slashed = Boolean(v.validator.slashed);
  const exit = v.validator.exit_epoch === FAR ? null : Number(v.validator.exit_epoch);
  const active = String(v.status).startsWith('active') && !slashed;
  res.json({
    status: 'ok',
    summary: `Ethereum validator ${v.index} is ${v.status}${slashed ? ' and has been SLASHED' : ' and has not been slashed'}, balance ${bal.toFixed(9)} ETH (effective ${eff} ETH), active since epoch ${v.validator.activation_epoch}${exit === null ? ', no exit scheduled' : `, exit epoch ${exit}`}.`,
    confidence: 0.9,
    canonical: `validator-performance:${v.index}`,
    validator_index: Number(v.index),
    pubkey: v.validator.pubkey,
    validator_status: v.status,
    active,
    slashed,
    balance_eth: Number(bal.toFixed(9)),
    effective_balance_eth: eff,
    activation_epoch: Number(v.validator.activation_epoch),
    exit_epoch: exit,
    source: 'Ethereum beacon node (publicnode)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
