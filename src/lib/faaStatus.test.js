import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airportsFromText, flightFromText, parseFaaFeed } from './faaStatus.js';

test('faa status: airports and flight are read from a question', () => {
  assert.deepEqual(airportsFromText('United Airlines flight UA870 from San Francisco to London Heathrow'), ['SFO', 'LHR']);
  assert.deepEqual(airportsFromText("flight UA123 from Chicago O'Hare to Denver"), ['ORD', 'DEN']);
  assert.deepEqual(airportsFromText('United flight UA870 from San Francisco (SFO) to London Heathrow (LHR)'), ['SFO', 'LHR']);
  assert.equal(flightFromText('status of United Airlines flight UA870'), 'UA870');
});

test('faa status: the feed is parsed into per-airport events', () => {
  const xml = '<AIRPORT_STATUS_INFORMATION><Update_Time>Thu Nov 12 09:59:20 2026 GMT</Update_Time><Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT><Reason>low ceilings</Reason><Avg>45 minutes</Avg><Max>1 hour</Max></Ground_Delay></Ground_Delay_List></Delay_type></AIRPORT_STATUS_INFORMATION>';
  const feed = parseFaaFeed(xml);
  assert.equal(feed.updated, 'Thu Nov 12 09:59:20 2026 GMT');
  assert.equal(feed.events[0].airport, 'SFO');
  assert.equal(feed.events[0].avg_delay, '45 minutes');
});
