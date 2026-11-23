import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightCandidates, IATA_TO_ICAO } from './flightLookup.js';

test('flight numbers are found in every form the scorer uses', () => {
  assert.equal(flightCandidates('UA1')[0], 'UA1');
  assert.equal(flightCandidates('BA75 2026-11-20 LHR-LOS')[0], 'BA75');
  assert.equal(flightCandidates('United Airlines flight UA934 from LHR to EWR')[0], 'UA934');
  assert.equal(flightCandidates('Delta 123 right now')[0], 'DL123');
  assert.equal(flightCandidates('AA1234 on 2025-07-12')[0], 'AA1234');
  assert.equal(flightCandidates('flight UAL934')[0], 'UAL934');
  assert.ok(flightCandidates('Emirates EK 203 status').includes('EK203'));
});

test('non-flight codes are ignored and airline codes map to radio codes', () => {
  assert.deepEqual(flightCandidates('check the SHA256 of the file'), []);
  assert.equal(IATA_TO_ICAO.UA, 'UAL');
});
