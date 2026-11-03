import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const BANK = 'pragma solidity ^0.7.0; contract Bank { mapping(address=>uint256) balances; function withdraw(uint256 a) public { (bool ok,) = msg.sender.call{value: a}(""); require(ok); balances[msg.sender] -= a; } }';

test('smart-contract-audit: pasted source is reviewed without any network', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/smart-contract-audit?source=${encodeURIComponent(BANK)}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.risk, 'high');
  assert.ok(body.findings.some((f) => f.category === 'reentrancy'));
  assert.ok(body.summary.length > 0 && body.confidence > 0);
});

test('smart-contract-audit: a question with no address or code is refused politely', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/smart-contract-audit?question=${encodeURIComponent('is this safe?')}`);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /contract address/);
});

test('smart-contract-audit: an unsupported chain is refused', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/smart-contract-audit?contract=0x${'ab'.repeat(20)}&chain=solana`);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
});
