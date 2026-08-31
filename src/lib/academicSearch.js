// ACADEMIC_SEARCH signal — peer-reviewed papers on a topic, primarily via
// OpenAlex's free /works endpoint, with Crossref as a live fallback when
// OpenAlex temporarily throttles the shared deployment address. What separates
// this from the two dedicated OpenAlex/Semantic Scholar competitors on the
// intent: results are restricted to actual peer-reviewed articles
// (type:article, so preprints, theses and datasets are excluded), and each
// result carries its journal and a real reconstructed abstract excerpt.
//
// Results are returned in OpenAlex's own relevance order. An earlier
// version sorted by citation count, on the theory that the most-cited work
// should lead. An adversarial review on 2026-08-29 found that this was
// actively wrong: sorting the whole match set by citations surfaces
// enormously-cited papers that only loosely match the words. Asking for
// "federated learning" returned "Exploiting Generative AI to Scale up
// Intelligent Tutoring Systems" (79,071 citations, not a federated
// learning paper), and "CRISPR since 2020" returned a paper on protein
// degraders. Relevance has to decide which papers these are; citation
// count is reported per paper, and summarised across them, as evidence of
// standing rather than as the ordering.

const WORKS_URL = 'https://api.openalex.org/works';
const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const CALL_TIMEOUT_MS = Number(process.env.ACADEMIC_SEARCH_TIMEOUT_MS) || 4_000;
const SELECT_FIELDS = 'id,doi,title,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index';

export class AcademicSearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcademicSearchError';
  }
}

function yearFromCrossref(work) {
  const dates = [work.published_print, work.published_online, work.issued, work.created];
  for (const date of dates) {
    const year = date?.['date-parts']?.[0]?.[0];
    if (Number.isInteger(year)) return year;
  }
  return null;
}

function crossrefAuthors(work) {
  return (work.author ?? []).map((author) =>
    [author.given, author.family].filter(Boolean).join(' ') || author.name
  ).filter(Boolean);
}

async function searchCrossref(topic, { limit, fromYear, toYear }) {
  const filters = ['type:journal-article'];
  if (fromYear) filters.push(`from-pub-date:${fromYear}-01-01`);
  if (toYear) filters.push(`until-pub-date:${toYear}-12-31`);
  const params = new URLSearchParams({
    'query.bibliographic': topic,
    filter: filters.join(','),
    rows: String(Math.min(Math.max(limit, 1), 25)),
    select: 'DOI,title,author,container-title,published-print,published-online,issued,created,is-referenced-by-count,type',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${CROSSREF_WORKS_URL}?${params}`, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new AcademicSearchError(`fallback search for '${topic}' timed out after ${CALL_TIMEOUT_MS}ms`);
    throw new AcademicSearchError(`fallback search for '${topic}' failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new AcademicSearchError(`fallback search for '${topic}' failed with status ${res.status}`);
  const body = await res.json();
  const results = (body.message?.items ?? []).map((work) => ({
    title: work.title?.[0] ?? null,
    year: yearFromCrossref(work),
    citation_count: work['is-referenced-by-count'] ?? 0,
    authors: crossrefAuthors(work),
    venue: work['container-title']?.[0] ?? null,
    doi: work.DOI ? `https://doi.org/${work.DOI}` : null,
    abstract_snippet: null,
  })).filter((work) => work.title);
  const mostCited = results.reduce((best, paper) =>
    best && best.citation_count >= paper.citation_count ? best : paper, null);
  return { total_matches: body.message?.['total-results'] ?? results.length, results, most_cited: mostCited };
}

// OpenAlex stores the abstract as a word -> [positions] inverted index
// (to sidestep publisher copyright on full abstract text), not plain
// text. Reconstruct the first `maxWords` words in reading order for a
// short, real snippet instead of omitting the abstract entirely.
function reconstructAbstractSnippet(invertedIndex, maxWords = 40) {
  if (!invertedIndex) return null;
  const positioned = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) positioned.push([pos, word]);
  }
  positioned.sort((a, b) => a[0] - b[0]);
  const words = positioned.slice(0, maxWords).map(([, w]) => w);
  return words.length ? words.join(' ') + (positioned.length > maxWords ? '…' : '') : null;
}

// Returns up to `limit` peer-reviewed works matching `topic` in relevance
// order, optionally restricted to [fromYear, toYear] publication years.
export async function searchPapers(topic, { limit = 5, fromYear, toYear } = {}) {
  const filters = ['type:article'];
  if (fromYear || toYear) {
    filters.push(`publication_year:${fromYear ?? ''}-${toYear ?? ''}`);
  }
  const params = new URLSearchParams({
    search: topic,
    filter: filters.join(','),
    per_page: String(Math.min(Math.max(limit, 1), 25)),
    select: SELECT_FIELDS,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${WORKS_URL}?${params}`, { signal: controller.signal });
  } catch (err) {
    return searchCrossref(topic, { limit, fromYear, toYear });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return searchCrossref(topic, { limit, fromYear, toYear });

  const body = await res.json();
  const results = (body.results ?? []).map((w) => ({
    title: w.title,
    year: w.publication_year,
    citation_count: w.cited_by_count,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    venue: w.primary_location?.source?.display_name ?? null,
    doi: w.doi,
    abstract_snippet: reconstructAbstractSnippet(w.abstract_inverted_index),
  }));

  // Reported separately from the ordering: which of these papers carries
  // the most citations is worth saying, but it must not decide which
  // papers get returned. See the note at the top of this file.
  const mostCited = results.reduce((best, p) => (best && best.citation_count >= p.citation_count ? best : p), null);

  return { total_matches: body.meta?.count ?? results.length, results, most_cited: mostCited };
}
