import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { resolveZone } from './checkGridPowerPrice.js';
import { parseWhen } from '../lib/whenParse.js';
import { isCaisoQuestion, caisoNode, unzipFirst, parseOasisCsv } from '../lib/caisoOasis.js';

test('zone codes and names resolve without catching ordinary words', () => {
  assert.equal(resolveZone(null, 'What was the real-time electricity price in the Elering FI zone yesterday?').bzn, 'FI');
  assert.equal(resolveZone(null, 'current grid electricity price for the BELPEX Belgium region').bzn, 'BE');
  assert.equal(resolveZone('DE-LU', null).bzn, 'DE-LU');
  assert.equal(resolveZone(null, 'What is the price in Estonia now?').bzn, 'EE');
  assert.equal(resolveZone(null, 'is it a good time to run the dishwasher'), null);
});

test('CAISO questions and nodes are recognised', () => {
  assert.ok(isCaisoQuestion('What is the real-time LMP at TH_SP15_GEN-APND right now?'));
  assert.ok(isCaisoQuestion('real-time price at the NP15 node in California'));
  assert.ok(!isCaisoQuestion('ERCOT Houston hub day-ahead'));
  assert.equal(caisoNode('SP-15 hub in CAISO').node, 'TH_SP15_GEN-APND');
  assert.equal(caisoNode('CAISO day-ahead LMP').named, false);
});

test('times are read in the zone the question names', () => {
  assert.equal(parseWhen('settlement interval 2026-09-13T14:00:00Z').at.toISOString(), '2026-09-13T14:00:00.000Z');
  assert.equal(parseWhen('hour ending 15:00 UTC on October 26, 2023').at.toISOString(), '2023-10-26T14:00:00.000Z');
  assert.equal(parseWhen('November 15th, 2023, at 10 AM Pacific Time').at.toISOString(), '2023-11-15T18:00:00.000Z');
  assert.equal(parseWhen('delivery date 2026-10-15 hour-ending 19:00 PPT').at.toISOString(), '2026-10-16T01:00:00.000Z');
  const now = Date.parse('2026-11-24T02:30:00Z');
  assert.equal(parseWhen('the 10 AM PST interval today', now).at.toISOString(), '2026-11-23T18:00:00.000Z');
  assert.equal(parseWhen('yesterday at 3 PM UTC', now).at.toISOString(), '2026-11-23T15:00:00.000Z');
  assert.equal(parseWhen('what is the price', now), null);
});

test('OASIS zip and CSV are read into priced intervals', () => {
  const csv = 'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,LMP_TYPE,MW\n2026-09-13T14:00:00-00:00,2026-09-13T15:00:00-00:00,LMP,38.09\n2026-09-13T14:00:00-00:00,2026-09-13T15:00:00-00:00,MCC,-0.27\n';
  const data = zlib.deflateRawSync(Buffer.from(csv));
  const name = Buffer.from('x.csv');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, cd, name, eocd]);
  const file = unzipFirst(zip);
  assert.equal(file.name, 'x.csv');
  const rows = parseOasisCsv(file.text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].LMP, 38.09);
  assert.equal(rows[0].MCC, -0.27);
});
