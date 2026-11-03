// SMART_CONTRACT_AUDIT: an automated first-pass review of a contract's source
// code or, when no source is published, its deployed bytecode. It looks for
// the three problems the intent names (reentrancy, missing access control and
// integer overflow) plus a few well-known red flags (tx.origin checks,
// delegatecall, selfdestruct, unchecked low-level calls). It is pattern
// matching, not a formal audit, and every answer says so.
//
// Source comes from Sourcify (keyless), then Blockscout. Bytecode comes from
// the same RPC the other on-chain routes use.

import { getCode } from './ankrRpc.js';

const FETCH_TIMEOUT_MS = Number(process.env.CONTRACT_AUDIT_TIMEOUT_MS) || 8_000;
const MAX_SOURCE_CHARS = 400_000;

export const CHAIN_IDS = { eth: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, avalanche: 43114 };

export class ContractAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractAuditError';
  }
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'TxLens-Miner/1.0 (public-data research)', Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ContractAuditError(`${new URL(url).host} answered with status ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof ContractAuditError) throw err;
    throw new ContractAuditError(err.name === 'AbortError' ? `${new URL(url).host} did not respond in time` : `${new URL(url).host}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Fetching verified source ----------------------------------------------

export function filesFromSourcify(body) {
  const sources = body?.sources;
  if (!sources || typeof sources !== 'object') return null;
  const files = Object.entries(sources).map(([path, v]) => ({ path, content: String(v?.content ?? '') })).filter((f) => f.content);
  if (!files.length) return null;
  return { files, compiler: body?.compilation?.compilerVersion ?? null, name: body?.compilation?.name ?? null, via: 'Sourcify' };
}

export function filesFromBlockscout(body) {
  if (!body?.source_code) return null;
  const files = [{ path: body.file_path || `${body.name || 'Contract'}.sol`, content: String(body.source_code) }];
  for (const extra of body.additional_sources ?? []) {
    if (extra?.source_code) files.push({ path: extra.file_path || 'extra.sol', content: String(extra.source_code) });
  }
  return { files, compiler: body.compiler_version ?? null, name: body.name ?? null, via: 'Blockscout' };
}

// Returns { files, compiler, name, via } or null when no verified source exists.
export async function fetchVerifiedSource(chainKey, blockscoutHost, address) {
  const id = CHAIN_IDS[chainKey];
  const errors = [];
  if (id) {
    try {
      const found = filesFromSourcify(await getJson(`https://sourcify.dev/server/v2/contract/${id}/${address}?fields=sources,compilation`));
      if (found) return found;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (blockscoutHost) {
    try {
      const found = filesFromBlockscout(await getJson(`https://${blockscoutHost}/api/v2/smart-contracts/${address}`));
      if (found) return found;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw new ContractAuditError(errors.join('; '));
  return null;
}

// ---- Source scan ------------------------------------------------------------

// Blanks out comments and string contents but keeps every character position
// and line break, so findings still point at the right line.
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
    } else if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  ';
      i += 2;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      out += q;
      i += 1;
      while (i < src.length && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' ';
        i += 1;
      }
      out += q;
      i += 1;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function extractFunctions(clean) {
  const fns = [];
  const re = /\bfunction\s+([A-Za-z_]\w*)\s*\(([^)]*)\)([^{;]*)([{;])/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const [, name, , header, end] = m;
    if (end === ';') continue;
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth += 1;
      else if (clean[j] === '}') depth -= 1;
      j += 1;
    }
    fns.push({ name, header: header.trim(), body: clean.slice(m.index + m[0].length, j - 1), start: m.index, line: lineOf(clean, m.index) });
    re.lastIndex = m.index + m[0].length;
  }
  return fns;
}

const GUARD_RE = /\b(onlyOwner|onlyRole|onlyAdmin|onlyGovernance|onlyGov|onlyAuthorized|onlyMinter|onlyOperator|onlyController|onlyManager|onlyProxy|onlyDelegateCall|auth|requiresAuth|authorized|restricted|initializer|reinitializer|onlyInitializing)\b/;
const BODY_GUARD_RE = /\b(_checkOwner|_checkRole|_requireOwner|_authorizeUpgrade|hasRole|isOwner|isAuthorized)\s*\(|msg\.sender\s*==|==\s*msg\.sender|_msgSender\(\)\s*==|==\s*_msgSender\(\)|require\s*\(\s*(owner|admin|governance)\b|if\s*\(\s*msg\.sender\s*!=/;
const SENSITIVE_NAME_RE = /^(mint|burn|burnFrom|withdraw\w*|drain\w*|sweep\w*|rescue\w*|emergency\w*|setOwner|transferOwnership|renounceOwnership|changeOwner|setAdmin|upgrade\w*|setImplementation|pause|unpause|set[A-Z]\w*|update[A-Z]\w*|initialize|init|kill|destroy|selfdestruct\w*|addMinter|grantRole|revokeRole)$/;

const SELF_SERVICE_RE = /\[\s*(msg\.sender|_msgSender\(\))\s*\]/;

function sourceFindings(files) {
  const findings = [];
  const add = (f) => findings.push(f);
  const first = files.map((f) => f.content).join('\n');
  const pragma = first.match(/pragma\s+solidity\s+([^;]+);/);
  const pragmaText = pragma ? pragma[1].trim() : null;
  const versionMatch = pragmaText?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  const minor = versionMatch ? Number(versionMatch[2]) : null;
  const preChecked = minor !== null && Number(versionMatch[1]) === 0 && minor < 8;
  const usesSafeMath = /\bSafeMath\b/.test(first);

  for (const file of files) {
    const clean = stripCommentsAndStrings(file.content);
    const where = (index) => `${file.path}:${lineOf(clean, index)}`;

    // Reentrancy and access control are judged per function.
    for (const fn of extractFunctions(clean)) {
      const view = /\b(view|pure)\b/.test(fn.header);
      const external = /\b(external|public)\b/.test(fn.header) || !/\b(internal|private)\b/.test(fn.header);

      const call = fn.body.match(/\.\s*call\s*(\{[^}]*\}|\.value\s*\([^)]*\))?\s*\(/);
      if (call && !view && !/\bnonReentrant\b|\block\b|\bnoReentrancy\b/.test(fn.header)) {
        const after = fn.body.slice(call.index + call[0].length);
        const write = after.match(/\b[A-Za-z_]\w*(?:\s*\[[^\]]*\])+\s*(?:-=|\+=|=(?!=))|\b(?:balance|balances|deposits?|owed|pending\w*|total\w*|credit\w*|shares|staked)\w*\s*(?:-=|\+=|=(?!=))/);
        if (write) {
          add({ severity: 'high', category: 'reentrancy', title: 'State changes after an external call', detail: `${fn.name}() sends value or calls out with .call, then updates contract state afterwards. A malicious receiver can call back in before the update and repeat the action (the classic reentrancy pattern). Update state first, or use a reentrancy guard.`, location: where(fn.start) });
        }
      }

      // withdraw and burn that only touch the caller's own balance are self-service, not admin actions.
      const selfService = /^(withdraw|burn)/.test(fn.name) && SELF_SERVICE_RE.test(fn.body);
      if (external && !view && !selfService && SENSITIVE_NAME_RE.test(fn.name) && !GUARD_RE.test(fn.header) && !BODY_GUARD_RE.test(fn.body)) {
        add({ severity: 'high', category: 'access-control', title: `${fn.name}() has no visible access check`, detail: `${fn.name}() is publicly callable and changes sensitive state, but has no owner or role modifier and no msg.sender check in its body. Anyone may be able to call it.`, location: where(fn.start) });
      }

      // tx.origin compared with anything but msg.sender is an authorisation check; comparing it
      // with msg.sender is the common "caller is not a contract" test and is left alone.
      if (/\btx\.origin\s*[!=]=(?!\s*(msg\.sender|_msgSender\(\)))|(?<!msg\.sender\s*)[!=]=\s*tx\.origin\b/.test(fn.body)) {
        add({ severity: 'high', category: 'access-control', title: 'Authorisation uses tx.origin', detail: `${fn.name}() checks tx.origin instead of msg.sender, so a phishing contract can act with the victim's authority.`, location: where(fn.start) });
      }
    }

    for (const m of clean.matchAll(/\bdelegatecall\b/g)) {
      add({ severity: 'medium', category: 'dangerous-call', title: 'Uses delegatecall', detail: 'delegatecall runs another contract\'s code with this contract\'s storage. If the target can be influenced by a caller, it can take over the contract.', location: where(m.index) });
      break;
    }
    for (const m of clean.matchAll(/\b(selfdestruct|suicide)\s*\(/g)) {
      add({ severity: 'medium', category: 'dangerous-call', title: 'Can self-destruct', detail: 'The contract contains selfdestruct, which can permanently remove it and send out its balance.', location: where(m.index) });
      break;
    }
    for (const m of clean.matchAll(/(^|[;{}])\s*[\w.\[\]()]+\.\s*(call|send)\s*(\{[^}]*\})?\s*\([^;]*\)\s*;/gm)) {
      add({ severity: 'medium', category: 'unchecked-call', title: 'Result of a low-level call is ignored', detail: 'A .call or .send is made without reading whether it succeeded, so a failed payment goes unnoticed.', location: where(m.index) });
      break;
    }
    for (const m of clean.matchAll(/\bunchecked\s*\{/g)) {
      add({ severity: 'low', category: 'integer-overflow', title: 'unchecked arithmetic block', detail: 'Solidity 0.8 normally reverts on overflow, but code inside an unchecked block wraps silently. Confirm each unchecked block cannot overflow.', location: where(m.index) });
      break;
    }
    for (const m of clean.matchAll(/\bblock\.(timestamp|number)\b[^;]*%|%[^;]*\bblock\.(timestamp|number)\b|\bblockhash\s*\(/g)) {
      add({ severity: 'low', category: 'randomness', title: 'Block data used as randomness', detail: 'Block timestamps and hashes can be influenced by validators, so they are weak sources of randomness.', location: where(m.index) });
      break;
    }
  }

  if (preChecked && !usesSafeMath) {
    add({ severity: 'medium', category: 'integer-overflow', title: `Solidity ${pragmaText} without SafeMath`, detail: 'Before Solidity 0.8, arithmetic wraps around silently on overflow and underflow, and this code does not use SafeMath, so any arithmetic without its own range check can be pushed past its limits.', location: 'pragma' });
  } else if (preChecked && usesSafeMath) {
    add({ severity: 'info', category: 'integer-overflow', title: 'Pre-0.8 Solidity with SafeMath', detail: 'Overflow is handled by SafeMath, but any arithmetic written without it would still wrap.', location: 'pragma' });
  }
  if (pragmaText && pragmaText.startsWith('^')) {
    add({ severity: 'info', category: 'best-practice', title: 'Floating pragma', detail: `The compiler version is not pinned (${pragmaText}), so the code can be built with different compilers.`, location: 'pragma' });
  }
  return { findings, pragma: pragmaText, safeMath: usesSafeMath, solidity08: minor !== null && !preChecked };
}

// ---- Bytecode scan ----------------------------------------------------------

// Walks opcodes properly so bytes inside PUSH data are not read as opcodes.
export function scanBytecode(hex) {
  const code = String(hex ?? '').replace(/^0x/, '');
  let bytes = code.match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
  // Solidity appends a CBOR metadata blob (compiler hash) to the code; its bytes are data, not opcodes.
  if (bytes.length > 4) {
    const metaLen = bytes[bytes.length - 2] * 256 + bytes[bytes.length - 1];
    const cut = bytes.length - 2 - metaLen;
    if (metaLen > 0 && cut > 0 && bytes[cut] >= 0xa1 && bytes[cut] <= 0xa5) bytes = bytes.slice(0, cut);
  }
  const seen = { delegatecall: false, selfdestruct: false, callvalue: false, create2: false };
  let calls = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const op = bytes[i];
    if (op >= 0x60 && op <= 0x7f) { i += op - 0x5f; continue; }
    if (op === 0xf4) seen.delegatecall = true;
    else if (op === 0xff) seen.selfdestruct = true;
    else if (op === 0xf5) seen.create2 = true;
    else if (op === 0xf1) calls += 1;
  }
  const minimalProxy = /^363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3/.test(code);
  return { size: bytes.length, ...seen, externalCalls: calls, minimalProxy };
}

function bytecodeFindings(scan) {
  const findings = [];
  if (scan.minimalProxy) {
    findings.push({ severity: 'info', category: 'proxy', title: 'Minimal proxy (EIP-1167 clone)', detail: 'This address only forwards every call to another contract, so the real logic and its risks live at the implementation address.', location: 'bytecode' });
    return findings;
  }
  if (scan.delegatecall) findings.push({ severity: 'medium', category: 'dangerous-call', title: 'Bytecode contains DELEGATECALL', detail: 'The contract can run other contracts\' code against its own storage, which is how proxies and upgrades work and also how takeovers happen.', location: 'bytecode' });
  if (scan.selfdestruct) findings.push({ severity: 'medium', category: 'dangerous-call', title: 'Bytecode contains SELFDESTRUCT', detail: 'The contract can remove itself and send out its balance.', location: 'bytecode' });
  return findings;
}

// ---- Putting it together -----------------------------------------------------

const ORDER = { high: 0, medium: 1, low: 2, info: 3 };

function riskOf(findings) {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  if (findings.some((f) => f.severity === 'low')) return 'low';
  return 'none-found';
}

const CATEGORY_LABEL = { reentrancy: 'Reentrancy', 'access-control': 'Access control', 'integer-overflow': 'Integer overflow' };

function categoryLine(findings, label, category, sourceChecked, cleanText) {
  const hits = findings.filter((f) => f.category === category && f.severity !== 'info');
  if (hits.length) return `${label}: ${hits.length === 1 ? hits[0].title : `${hits.length} issues, first: ${hits[0].title}`}.`;
  return `${label}: ${sourceChecked ? cleanText : 'not assessed without source code'}.`;
}

// source: { files, compiler, name, via } | null; bytecode: scanBytecode() result | null
export function buildAudit({ target, chainLabel, source, bytecode, unverified }) {
  let findings = [];
  let meta = {};
  if (source) {
    const scanned = sourceFindings(source.files);
    findings = scanned.findings;
    meta = { pragma: scanned.pragma, uses_safemath: scanned.safeMath, solidity_0_8_or_later: scanned.solidity08 };
  }
  // Verified source is the better evidence; the raw opcode scan only fills in when there is none.
  if (bytecode && !source) findings = findings.concat(bytecodeFindings(bytecode));
  if (!source && unverified) {
    findings.push({ severity: 'medium', category: 'transparency', title: 'Source code is not verified', detail: 'No published, verified source code was found, so the logic cannot be reviewed line by line. Only the raw bytecode could be checked.', location: 'n/a' });
  }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const risk = riskOf(findings);
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  const checked = Boolean(source);
  const lines = [
    categoryLine(findings, 'Reentrancy', 'reentrancy', checked, 'no external call followed by a state change was found'),
    categoryLine(findings, 'Access control', 'access-control', checked, 'every sensitive function has an owner, role or sender check'),
    categoryLine(findings, 'Integer overflow', 'integer-overflow', checked, meta.solidity_0_8_or_later ? 'Solidity 0.8 or later checks arithmetic automatically' : 'no unprotected arithmetic pattern was found'),
  ];
  const headline = risk === 'none-found'
    ? `Automated review of ${target}${chainLabel ? ` on ${chainLabel}` : ''} found no known vulnerability patterns${checked ? ` in the verified source (${source.name ?? 'contract'}, via ${source.via})` : ' in the bytecode'}.`
    : `Automated review of ${target}${chainLabel ? ` on ${chainLabel}` : ''} rates it ${risk} risk: ${counts.high} high, ${counts.medium} medium, ${counts.low} low severity finding${counts.high + counts.medium + counts.low === 1 ? '' : 's'}${checked ? ` in the verified source (${source.name ?? 'contract'}, via ${source.via})` : ' from the bytecode'}.`;
  const top = findings.filter((f) => f.severity !== 'info').slice(0, 3).map((f) => `${f.title} (${f.location})`);
  const summary = [headline, ...lines, top.length ? `Main findings: ${top.join('; ')}.` : null, 'This is an automated pattern check, not a full manual audit.'].filter(Boolean).join(' ');

  return {
    summary,
    risk,
    counts,
    findings,
    source_verified: checked,
    compiler: source?.compiler ?? null,
    contract_name: source?.name ?? null,
    source_provider: source?.via ?? null,
    bytecode_size: bytecode?.size ?? null,
    ...meta,
    confidence: checked ? 0.8 : (bytecode ? 0.5 : 0.3),
  };
}

export async function fetchBytecode(chainSegment, address) {
  const code = await getCode(chainSegment, address);
  return typeof code === 'string' && code !== '0x' ? code : null;
}

export function capSource(text) {
  return String(text ?? '').slice(0, MAX_SOURCE_CHARS);
}
