import test from 'node:test';
import assert from 'node:assert/strict';
import { commonsFileName, findUrls, classifyRecord, lookupMedia, isPlaceholderHost } from './mediaForensic.js';

const record = (over = {}) => ({
  missing: false, name: 'X.jpg', sha1: 'abc', size: 10, mime: 'image/jpeg', uploader: 'U', uploaded: '2020-01-02T00:00:00Z',
  categories: [], camera: null, artist: '', license: 'CC BY 4.0', description: '', credit: 'Own work', objectName: '', date: '', ...over,
});

const fakeFetch = (page) => async () => ({ ok: true, json: async () => ({ query: { pages: { 1: page } } }) });
const apiPage = (over = {}) => ({
  title: 'File:T_' + Math.random().toString(36).slice(2) + '.jpg',
  imageinfo: [{ sha1: 'deadbeef', size: 99, mime: 'image/jpeg', user: 'Bob', timestamp: '2021-05-06T00:00:00Z', extmetadata: {}, commonmetadata: [] }],
  categories: [], ...over,
});

test('file name from thumb, original and Commons page links', () => {
  assert.equal(commonsFileName('https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png'), 'PNG transparency demonstration 1.png');
  assert.equal(commonsFileName('https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png'), 'PNG transparency demonstration 1.png');
  assert.equal(commonsFileName('https://commons.wikimedia.org/wiki/File:Pug_wearing_a_hat.JPG'), 'Pug wearing a hat.JPG');
  assert.equal(commonsFileName('https://example.com/a.jpg'), null);
});

test('urls are found and trailing punctuation dropped', () => {
  assert.deepEqual(findUrls('Is https://example.com/a.jpg, real?'), ['https://example.com/a.jpg']);
  assert.ok(isPlaceholderHost('www.example.com'));
  assert.ok(!isPlaceholderHost('notexample.com'));
});

test('classification rules', () => {
  assert.equal(classifyRecord(record({ categories: ['AI-generated images'] })).verdict, 'Fake');
  assert.equal(classifyRecord(record({ camera: 'Canon X' })).verdict, 'Authentic');
  assert.equal(classifyRecord(record({ categories: ['Featured pictures from the Google Art Project'], artist: 'Van Gogh' })).verdict, 'Authentic');
  assert.equal(classifyRecord(record({ mime: 'image/svg+xml' })).verdict, 'Fake');
  assert.equal(classifyRecord(record({ mime: 'image/png', categories: ['Created with Persistence of Vision'] })).verdict, 'Fake');
  assert.equal(classifyRecord(record({ mime: 'image/png' })).verdict, 'Inconclusive');
});

test('placeholder domain gives Inconclusive without any network call', async () => {
  const r = await lookupMedia('Is this real? https://example.com/cat_piano.mp4', { fetchImpl: () => { throw new Error('no network'); } });
  assert.equal(r.verdict, 'Inconclusive');
  assert.equal(r.confidence, 0.2);
  assert.match(r.answer, /^Inconclusive\. /);
  assert.match(r.answer, /RFC 2606/);
});

test('Commons lookup builds the full shape and is repeatable', async () => {
  const page = apiPage({ imageinfo: [{ sha1: 'deadbeef', size: 99, mime: 'image/png', user: 'Bob', timestamp: '2021-05-06T00:00:00Z', extmetadata: { LicenseShortName: { value: 'CC0' } }, commonmetadata: [] }], categories: [{ title: 'Category:Created with Blender' }] });
  const q = 'real? https://commons.wikimedia.org/wiki/File:Blender_test_a.png';
  const a = await lookupMedia(q, { fetchImpl: fakeFetch(page) });
  const b = await lookupMedia(q, { fetchImpl: fakeFetch(page) });
  assert.equal(a.verdict, 'Fake');
  assert.match(a.answer, /^Fake\. Not a real photograph/);
  assert.equal(a.sha1, 'deadbeef');
  assert.equal(a.size_bytes, 99);
  assert.equal(a.license, 'CC0');
  assert.match(a.source, /commons\.wikimedia\.org\/wiki\/File:/);
  assert.equal(a.answer, b.answer);
});

test('API failure falls through (null) so the judge answers', async () => {
  const r = await lookupMedia('https://commons.wikimedia.org/wiki/File:Fail_case.jpg', { fetchImpl: async () => ({ ok: false }) });
  assert.equal(r, null);
  const r2 = await lookupMedia('https://commons.wikimedia.org/wiki/File:Throw_case.jpg', { fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(r2, null);
});

test('other links and plain text fall through', async () => {
  assert.equal(await lookupMedia('is this photo real? https://news.site/pic.jpg'), null);
  assert.equal(await lookupMedia('no link here'), null);
});

test('missing Commons file is Inconclusive', async () => {
  const r = await lookupMedia('https://commons.wikimedia.org/wiki/File:Nope_missing_one.jpg', { fetchImpl: fakeFetch({ title: 'File:Nope', missing: '' }) });
  assert.equal(r.verdict, 'Inconclusive');
});
