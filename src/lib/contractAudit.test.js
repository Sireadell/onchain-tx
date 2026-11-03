import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudit, scanBytecode, stripCommentsAndStrings, filesFromSourcify, filesFromBlockscout,
} from './contractAudit.js';

const VULNERABLE = `
pragma solidity ^0.7.0;
contract Bank {
  mapping(address => uint256) public balances;
  address public owner;
  function deposit() public payable { balances[msg.sender] += msg.value; }
  function withdraw(uint256 amount) public {
    require(balances[msg.sender] >= amount);
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok);
    balances[msg.sender] -= amount;
  }
  function setOwner(address next) public { owner = next; }
  function kill() public { selfdestruct(payable(msg.sender)); }
  function isAdmin() public view returns (bool) { return tx.origin == owner; }
}`;

const SAFE = `
pragma solidity 0.8.20;
contract Vault {
  mapping(address => uint256) public balances;
  address public owner;
  bool private locked;
  modifier onlyOwner() { require(msg.sender == owner); _; }
  modifier nonReentrant() { require(!locked); locked = true; _; locked = false; }
  function withdraw(uint256 amount) external nonReentrant {
    balances[msg.sender] -= amount;
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok);
  }
  function setOwner(address next) external onlyOwner { owner = next; }
}`;

const audit = (src) => buildAudit({ target: '0xabc', chainLabel: 'Ethereum', source: { files: [{ path: 'a.sol', content: src }], compiler: 'v0', name: 'X', via: 'Sourcify' }, bytecode: null });
const categories = (a) => new Set(a.findings.map((f) => f.category));

test('a vulnerable contract is rated high with reentrancy, access control and overflow findings', () => {
  const a = audit(VULNERABLE);
  assert.equal(a.risk, 'high');
  for (const c of ['reentrancy', 'access-control', 'integer-overflow']) assert.ok(categories(a).has(c), `missing ${c}`);
  assert.ok(a.findings.some((f) => /setOwner/.test(f.title)));
  assert.ok(a.findings.some((f) => /tx\.origin/.test(f.title)));
  assert.match(a.summary, /Reentrancy: /);
  assert.match(a.summary, /not a full manual audit/);
});

test('a guarded 0.8 contract has no high findings', () => {
  const a = audit(SAFE);
  assert.notEqual(a.risk, 'high');
  assert.equal(a.findings.filter((f) => f.severity === 'high').length, 0);
  assert.match(a.summary, /Solidity 0\.8 or later/);
});

test('comments and strings cannot trigger findings', () => {
  const a = audit(`pragma solidity 0.8.20;\ncontract C {\n // tx.origin selfdestruct( delegatecall\n string s = "selfdestruct(x)";\n}`);
  assert.equal(a.findings.filter((f) => f.severity !== 'info').length, 0);
  assert.equal(stripCommentsAndStrings('a // b\nc').split('\n').length, 2);
});

test('bytecode scan ignores bytes inside PUSH data and finds real opcodes', () => {
  assert.equal(scanBytecode('0x60ff00').selfdestruct, false);
  assert.equal(scanBytecode('0x6000ff').selfdestruct, true);
  assert.equal(scanBytecode('0x6000f4').delegatecall, true);
  assert.equal(scanBytecode('0x363d3d373d3d3d363d73' + 'ab'.repeat(20) + '5af43d82803e903d91602b57fd5bf3').minimalProxy, true);
});

test('unverified contracts are flagged and bytecode-only confidence is lower', () => {
  const a = buildAudit({ target: '0xabc', chainLabel: 'Base', source: null, bytecode: scanBytecode('0x6000f4'), unverified: true });
  assert.equal(a.source_verified, false);
  assert.ok(a.findings.some((f) => f.category === 'transparency'));
  assert.ok(a.confidence < 0.8);
  assert.match(a.summary, /not assessed without source code/);
});

test('source responses from Sourcify and Blockscout are read', () => {
  assert.equal(filesFromSourcify({ sources: { 'A.sol': { content: 'x' } }, compilation: { compilerVersion: '0.8.0', name: 'A' } }).name, 'A');
  assert.equal(filesFromSourcify({}), null);
  assert.equal(filesFromBlockscout({ source_code: 'x', name: 'B', file_path: 'B.sol', additional_sources: [{ file_path: 'C.sol', source_code: 'y' }] }).files.length, 2);
  assert.equal(filesFromBlockscout({ is_verified: false }), null);
});
