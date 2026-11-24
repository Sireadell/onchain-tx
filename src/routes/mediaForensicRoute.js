// Media checks: settled cases (Wikimedia Commons files, placeholder
// example.com links) are answered from facts; everything else goes to the
// route's existing LLM judge unchanged.
import { Router } from 'express';
import { lookupMedia } from '../lib/mediaForensic.js';
import { mediaAuthenticityRouter, mediaForensicRouter as forensicJudge } from './newIntents.js';

function withFacts(judgeRouter) {
  const r = Router();
  r.all('/', async (req, res, next) => {
    try {
      const params = (req.method === 'GET' ? req.query : req.body) ?? {};
      const text = Object.values(params).map((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))).join('\n');
      const body = await lookupMedia(text);
      if (body) return res.json(body);
    } catch { /* fall through to the judge */ }
    return judgeRouter(req, res, next);
  });
  return r;
}

// /media-forensic (MEDIA_FORENSIC_VERIFY)
export const mediaForensicRouter = withFacts(forensicJudge);
// /media-authenticity (MEDIA_AUTHENTICITY_CHECK)
export const mediaAuthenticityFactsRouter = withFacts(mediaAuthenticityRouter);
