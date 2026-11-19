import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRevisionQuestion, wikiRevisionAnswer, extractDoi, doiRecordAnswer, exactSourceAnswer } from './exactSources.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const REV = { query: { pages: [{ title: 'Silicon', revisions: [{ revid: 1382843447, parentid: 1382842852, user: 'Kapicapybara', timestamp: '2026-10-30T16:25:24Z', size: 88460, comment: 'Reverting to rev. 1 by [[User:Doc James|Doc James]]' }] }] } };
const OC = [{ id: 'doi:10.1159/000050176 omid:br/061303722066', title: 'The Corrugated Esophagus.', author: "V H Low [omid:ra/1]; J B O'Connor [omid:ra/2]", pub_date: '2001', venue: 'Digestive Surgery [issn:0253-4886]', volume: '', issue: '', page: '', type: 'journal article', publisher: 'S. Karger Ag [omid:ra/3]' }];

test('revision questions are parsed into article, id and field', () => {
  assert.deepEqual(parseRevisionQuestion('Silicon, revision 1382843447, field revision text size in bytes.'), { revid: '1382843447', title: 'Silicon', field: 'size' });
  assert.equal(parseRevisionQuestion('Iron, revision 1382197641, field revision editing timestamp in UTC.').field, 'timestamp');
  assert.equal(parseRevisionQuestion('Who wrote Things Fall Apart?'), null);
});

test('a revision size question is answered from that exact revision', async () => {
  let asked = '';
  const hit = await wikiRevisionAnswer('Silicon, revision 1382843447, field revision text size in bytes.', { fetchImpl: async (u) => { asked = String(u); return json(REV); } });
  assert.match(asked, /revids=1382843447/);
  assert.match(hit.summary, /^The revision text size of Silicon, revision 1382843447 \(English Wikipedia\), is 88460 bytes\./);
  assert.match(hit.summary, /edit summary "Reverting to rev\. 1 by Doc James"/);
  assert.equal(hit.value, 88460);
});

test('a revision id that does not exist gives no answer', async () => {
  const hit = await wikiRevisionAnswer('Silicon, revision 999999999, size', { fetchImpl: async () => json({ query: { badrevids: {} } }) });
  assert.equal(hit, null);
});

test('DOIs are pulled out without trailing punctuation', () => {
  assert.equal(extractDoi('Disambiguate the paper using DOI 10.1159/000050176. Thanks'), '10.1159/000050176');
  assert.equal(extractDoi('The DOI is 10.1385/abab:130:1:382.'), '10.1385/abab:130:1:382');
});

test('an author count question is answered from OpenCitations Meta', async () => {
  const q = 'The Corrugated Esophagus: how many semicolon-separated author entries does that release list? The source edition is OpenCitations Meta dated 2024-04-06. Disambiguate the paper using DOI 10.1159/000050176.';
  const hit = await doiRecordAnswer(q, { fetchImpl: async (u) => (String(u).includes('opencitations') ? json(OC) : json({}, 404)) });
  assert.match(hit.summary, /^OpenCitations Meta lists 2 semicolon-separated author entries/);
  assert.equal(hit.record.author_count, 2);
});

test('a first author question names the entry before its identifiers', async () => {
  const q = 'The DOI is 10.1159/000050176. Per OpenCitations Meta, what author name is written before the bracketed identifiers in the first author entry?';
  const hit = await doiRecordAnswer(q, { fetchImpl: async () => json(OC) });
  assert.match(hit.summary, /first author entry OpenCitations Meta lists .* is "V H Low"/);
});

test('Crossref answers when OpenCitations does not', async () => {
  const q = 'How many authors does DOI 10.1159/000050176 list in OpenCitations Meta?';
  const hit = await doiRecordAnswer(q, { fetchImpl: async (u) => (String(u).includes('crossref')
    ? json({ message: { title: ['T'], author: [{ family: 'Low', given: 'V H' }], issued: { 'date-parts': [[2001]] } } })
    : json({}, 500)) });
  assert.equal(hit.source, 'Crossref');
  assert.equal(hit.record.author_count, 1);
});

test('ordinary questions are left to the normal search', async () => {
  assert.equal(await exactSourceAnswer('Who wrote the novel Things Fall Apart?', { fetchImpl: async () => { throw new Error('no call expected'); } }), null);
});
