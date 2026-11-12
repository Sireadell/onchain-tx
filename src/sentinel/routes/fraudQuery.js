import { Router } from 'express';
import { isAddress, getAddress } from 'ethers';
import { answerFraudQuestion } from '../core/fraudKnowledge.js';
import { addResponseEnvelope } from '../core/response/model.js';
import { assessWalletSafely } from './assessWallet.js';

const router = Router();

// Telegraph's dispatcher routes on the miner description, not on the
// shape of the question, so wallet questions phrased as prose land here
// rather than on /assess-wallet. Confirmed against the live explorer
// question feed on 2026-08-28: "Evaluate likelihood
// 0x28C6c06298d514Db089934071355E5743bf21d60 is fraudulent or a
// honeypot" was sent to /fraud-query, where the knowledge path has no
// way to answer it and returned "I'm not aware of any documented fraud
// case or analysis involving the address" -- while /assess-wallet, one
// endpoint over, identifies that address outright.
const EVM_ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{40}/;

/**
 * Pulls an assessable EVM address out of a free-text question, or null
 * if there isn't one. A mixed-case address whose EIP-55 checksum doesn't
 * validate is still accepted, lowercased: inside prose a broken checksum
 * is far more likely to be sloppy quoting than a different address, and
 * every registry and RPC lookup downstream is keyed on the lowercase
 * form anyway.
 */
function extractWalletAddress(query) {
  const match = query.match(EVM_ADDRESS_IN_TEXT)?.[0];
  if (!match) return null;
  if (isAddress(match)) return getAddress(match);
  const lowered = match.toLowerCase();
  return isAddress(lowered) ? getAddress(lowered) : null;
}

// Words that mark a question as being about a scheme or a message rather
// than about the address itself. Live traffic on 2026-09-09 and 2026-09-10
// asked "is this email asking me to transfer my assets to 0xDeaDBeef... a
// phishing scam?" -- a question about the email. The address in it was
// invented for the example, so the on-chain path found nothing and we
// answered with an empty SIGNAL_SKIPPED envelope, no evidence and no
// verdict, on a question the knowledge path answers well. The address rule
// below is still right whenever the analysis actually finds something; it
// is only wrong when it finds nothing and the question was never about the
// address to begin with.
export const SCENARIO_CUES = /\b(?:e-?mail|phishing|scam|message|text|sms|dm|letter|website|site|link|url|domain|claim|refund|invoice|giveaway|airdrop|sweepstake|lottery|prize|support|impersonat\w*|pretend\w*|urgent\w*|verify my|update my|transfer my|send my)\b/i;

// True when the wallet analysis came back with nothing to say: no evidence
// gathered and no signal that actually fired. An envelope like that reads
// as a non-answer, so it is worth trying the knowledge path instead.
export function assessmentFoundNothing(assessment) {
  const evidence = assessment?.evidence;
  if (Array.isArray(evidence) && evidence.length > 0) return false;
  const codes = assessment?.reason_codes;
  if (!Array.isArray(codes)) return true;
  return codes.every((code) => code === 'SIGNAL_SKIPPED' || code === 'OBSERVATION_INCOMPLETE');
}

export async function handleFraudQuery(req, res) {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (query.length < 8 || query.length > 1_000) {
    return res.status(400).json({ error: 'must include a `query` between 8 and 1000 characters' });
  }

  // A question naming a specific address is a wallet question, whatever
  // words surround it. Run the real analysis rather than asking a
  // language model what it remembers about a hex string. If that path
  // can't complete (RPC unavailable or budget exhausted), fall through
  // to the knowledge answer instead of returning the failure.
  const wallet = extractWalletAddress(query);
  if (wallet) {
    try {
      const assessment = await assessWalletSafely(wallet);
      if (!assessment.reason_codes?.includes('ASSESSMENT_UNAVAILABLE')) {
        // An empty result on a question that was really about an email or a
        // scheme is worse than no answer at all, because it looks like a
        // verdict. Only in that pairing do we fall through to the knowledge
        // path; a bare address question keeps the structured envelope even
        // when it is clean, because "nothing found" is the honest answer to
        // "is this address fraudulent".
        if (!(assessmentFoundNothing(assessment) && SCENARIO_CUES.test(query))) {
          return res.json(assessment);
        }
      }
    } catch (err) {
      console.error('[fraud-query] delegated wallet assessment failed:', err?.message ?? err);
    }
  }

  try {
    return res.json(await answerFraudQuestion(query));
  } catch (err) {
    console.error('[fraud-query] answerFraudQuestion failed:', err?.message ?? err);
    const result = {
      answer: 'The fraud knowledge lookup is temporarily unavailable.',
      confidence: 0,
      assessment_status: 'INCONCLUSIVE',
      summary: 'INCONCLUSIVE: fraud knowledge lookup is temporarily unavailable.',
    };
    return res.status(503).json(addResponseEnvelope(result, {
      mode: 'fraud_knowledge',
      label: 'INCONCLUSIVE',
      reason: result.summary,
    }));
  }
}

router.post('/', handleFraudQuery);

export default router;
