import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpgradeQuestion, breakingSection, breakingItems, npmUpgradeAnswer } from './npmUpgradeNotes.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('the upgraded package and both versions are read from the question', () => {
  assert.deepEqual(parseUpgradeQuestion('We run unit tests with vitest 1.6.0. Which defaults and APIs changed incompatibly in vitest 2.0.0?'), { name: 'vitest', from: '1.6.0', to: '2.0.0' });
  assert.deepEqual(parseUpgradeQuestion('Data fetching is on @tanstack/react-query 4.36.1. List the breaking changes we must address for @tanstack/react-query 5.0.0.'), { name: '@tanstack/react-query', from: '4.36.1', to: '5.0.0' });
  assert.equal(parseUpgradeQuestion('Who wrote the novel Things Fall Apart?'), null);
});

test('release-note bullets lose credits and links, and group labels keep their sub-items', () => {
  const md = '### Breaking Changes\n\n- Remove watchExclude - by @x in https://github.com/a/b/issues/1 [<samp>(d7)</samp>](https://x)\n- **api:**\n  - Do not call `process.exit` - by @y\n### Features\n- New thing';
  assert.deepEqual(breakingItems(breakingSection(md)), ['Remove watchExclude', 'api: Do not call `process.exit`']);
});

test('a migration guide section is read by its sub-headings, ignoring code samples', () => {
  const md = '## Breaking Changes\n### Rename `cacheTime` to `gcTime`\n```tsx\n- cacheTime: 1, // [!code --]\n```\n### Removed `keepPreviousData`\n## New Features\n### combine';
  assert.deepEqual(breakingItems(breakingSection(md)), ['Rename `cacheTime` to `gcTime`', 'Removed `keepPreviousData`']);
});

test('breaking changes come from the official release for the target version', async () => {
  const fetchImpl = async (u) => {
    const url = String(u);
    if (url.startsWith('https://registry.npmjs.org/vitest')) return json({ version: '2.0.0', repository: { url: 'git+https://github.com/vitest-dev/vitest.git' } });
    if (url.endsWith('/releases/tags/v2.0.0')) return json({ html_url: 'https://github.com/vitest-dev/vitest/releases/tag/v2.0.0', published_at: '2024-07-08T00:00:00Z', body: "### Breaking Changes\n- Change default `pool` to `'forks'` - by @a\n- Remove watchExclude - by @b\n### Features\n- x" });
    return json({}, 404);
  };
  const hit = await npmUpgradeAnswer('We run vitest 1.6.0. Which defaults and APIs changed incompatibly in vitest 2.0.0?', { fetchImpl });
  assert.match(hit.summary, /^Upgrading vitest from 1\.6\.0 to 2\.0\.0 brings 2 breaking changes listed in the official vitest 2\.0\.0 release notes: 1\) Change default `pool` to `'forks'`; 2\) Remove watchExclude\./);
  assert.match(hit.summary, /Source: https:\/\/github\.com\/vitest-dev\/vitest\/releases\/tag\/v2\.0\.0/);
});

test('no release notes means no answer, so the caller falls back', async () => {
  const hit = await npmUpgradeAnswer('Breaking changes in leftpadx 9.0.0?', { fetchImpl: async () => json({}, 404) });
  assert.equal(hit, null);
});
