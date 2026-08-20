#![no_std]
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const HEAP_SIZE: usize = 1 * 1024 * 1024;
static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];
static mut HEAP_OFFSET: usize = 0;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn alloc(size: i32) -> i32 {
    let size = size.max(0) as usize;
    unsafe {
        let aligned = (HEAP_OFFSET + 3) & !3;
        if aligned + size > HEAP_SIZE {
            HEAP_OFFSET = 0;
        } else {
            HEAP_OFFSET = aligned;
        }
        let ptr = core::ptr::addr_of_mut!(HEAP).cast::<u8>().add(HEAP_OFFSET);
        HEAP_OFFSET += size;
        ptr as i32
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(_ptr: i32, _size: i32) {}

// Zero/negative length must not touch the pointer at all: the host (see
// tester/main.go's writeStr) passes ptr=0 for an empty string, and building
// a slice from a null pointer is UB even at length 0.
unsafe fn read_str<'a>(ptr: i32, len: i32) -> &'a str {
    if len <= 0 {
        return "";
    }
    unsafe {
        let slice = core::slice::from_raw_parts(ptr as *const u8, len as usize);
        core::str::from_utf8_unchecked(slice)
    }
}

fn contains_ci_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return needle.is_empty();
    }
    'outer: for start in 0..=(haystack.len() - needle.len()) {
        for i in 0..needle.len() {
            if !haystack[start + i].eq_ignore_ascii_case(&needle[i]) {
                continue 'outer;
            }
        }
        return true;
    }
    false
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    contains_ci_bytes(haystack.as_bytes(), needle.as_bytes())
}

fn find_positions_bytes(haystack: &[u8], needle: &[u8], out: &mut [usize]) -> usize {
    let mut count = 0usize;
    if needle.is_empty() || needle.len() > haystack.len() || out.is_empty() {
        return 0;
    }
    let mut start = 0usize;
    while start <= haystack.len() - needle.len() {
        let mut matched = true;
        for i in 0..needle.len() {
            if !haystack[start + i].eq_ignore_ascii_case(&needle[i]) {
                matched = false;
                break;
            }
        }
        if matched {
            out[count] = start;
            count += 1;
            if count == out.len() {
                break;
            }
            start += needle.len();
        } else {
            start += 1;
        }
    }
    count
}

// Rejects matches that are just substrings of a longer word, e.g. "found"
// inside "confounded", "error" inside "terrorize" (unlikely here, but the
// same class of bug as Sentinel's "low" inside "below").
fn has_word_boundary(bytes: &[u8], start: usize, len: usize) -> bool {
    let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
    let end = start + len;
    let after_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
    before_ok && after_ok
}

// A short lookback window for a negating word right before a match, so
// "not confirmed" / "not yet mined" don't get read as their un-negated
// opposite. Deliberately short and literal (not full NLP) to keep this a
// no_std, allocation-free WASM binary.
fn is_negated_before(bytes: &[u8], start: usize) -> bool {
    let win_start = start.saturating_sub(20);
    let window = &bytes[win_start..start];
    contains_ci_bytes(window, b"not ")
        || contains_ci_bytes(window, b"n't ")
        || contains_ci_bytes(window, b"never ")
        || contains_ci_bytes(window, b"without being ")
}

#[derive(PartialEq, Clone, Copy)]
enum TxStatus {
    Confirmed,
    Reverted,
    Pending,
    NotFound,
    Error,
    Unknown,
}

// Multi-word phrases checked first since they're unambiguous and some are
// themselves negations of a shorter status word below (e.g. "not found" vs
// "found" is not a status word we scan for standalone, but "not yet mined"
// would otherwise partially match "mined"-adjacent confirmed language).
fn phrase_status(s: &str) -> Option<TxStatus> {
    const NOT_FOUND_PHRASES: [&str; 14] = [
        "not found",
        "not_found",
        "no such transaction",
        "does not exist",
        "doesn't exist",
        "could not locate",
        "couldn't locate",
        "no record",
        "no matching transaction",
        "unable to find",
        "unable to locate",
        "invalid or unknown transaction",
        "doesn't appear to exist",
        "does not appear on",
    ];
    for p in NOT_FOUND_PHRASES {
        if contains_ci(s, p) {
            return Some(TxStatus::NotFound);
        }
    }
    const PENDING_PHRASES: [&str; 9] = [
        "not yet mined",
        "unconfirmed",
        "still pending",
        "in the mempool",
        "sitting in mempool",
        "still processing",
        "hasn't been included",
        "has not been included",
        "not yet been mined",
    ];
    for p in PENDING_PHRASES {
        if contains_ci(s, p) {
            return Some(TxStatus::Pending);
        }
    }
    const REVERTED_PHRASES: [&str; 4] = [
        "out of gas",
        "execution reverted",
        "transaction failed",
        "ran out of gas",
    ];
    for p in REVERTED_PHRASES {
        if contains_ci(s, p) {
            return Some(TxStatus::Reverted);
        }
    }
    const CONFIRMED_PHRASES: [&str; 5] = [
        "went through",
        "was successful",
        "included in block",
        "finalized in block",
        "successfully mined",
    ];
    for p in CONFIRMED_PHRASES {
        if contains_ci(s, p) {
            return Some(TxStatus::Confirmed);
        }
    }
    None
}

// Single status words, boundary- and negation-checked so "confirmed" inside
// "unconfirmed", or a negated "not confirmed", don't get misread as their
// opposite. Order matters: more specific/rarer words first so a text
// containing several status words (e.g. a question echoing "confirmed OR
// reverted?") resolves to the first genuine, non-negated hit.
const STATUS_WORDS: [(&str, TxStatus); 13] = [
    ("reverted", TxStatus::Reverted),
    ("revert", TxStatus::Reverted),
    ("failed", TxStatus::Reverted),
    ("failure", TxStatus::Reverted),
    ("pending", TxStatus::Pending),
    ("queued", TxStatus::Pending),
    ("unmined", TxStatus::Pending),
    ("confirmed", TxStatus::Confirmed),
    ("success", TxStatus::Confirmed),
    ("successful", TxStatus::Confirmed),
    ("mined", TxStatus::Confirmed),
    ("landed", TxStatus::Confirmed),
    ("error", TxStatus::Error),
];

fn word_status(s: &str) -> TxStatus {
    let bytes = s.as_bytes();
    for (word, status) in STATUS_WORDS {
        let wbytes = word.as_bytes();
        let mut positions = [0usize; 4];
        let n = find_positions_bytes(bytes, wbytes, &mut positions);
        for &pos in &positions[..n] {
            if has_word_boundary(bytes, pos, wbytes.len()) && !is_negated_before(bytes, pos) {
                return status;
            }
        }
    }
    TxStatus::Unknown
}

fn extract_status(s: &str) -> TxStatus {
    if let Some(st) = phrase_status(s) {
        return st;
    }
    word_status(s)
}

// Pure-digit tokens (commas/one decimal point allowed) are never filler,
// regardless of length: "0 wei", "12 confirmations", a tx type "2" are
// short but concrete checkable facts. Without this exemption, is_salient's
// address/number detection never even runs on them because content_overlap
// skips stopwords first — a short numeric ground-truth fact was silently
// invisible to scoring in either direction, right or wrong.
fn is_numeric_token(word: &str) -> bool {
    let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ',');
    if trimmed.is_empty() {
        return false;
    }
    let mut dots = 0u32;
    let mut digits = 0u32;
    for b in trimmed.bytes() {
        if b == b',' {
            continue;
        } else if b == b'.' {
            dots += 1;
            if dots > 1 {
                return false;
            }
        } else if b.is_ascii_digit() {
            digits += 1;
        } else {
            return false;
        }
    }
    digits > 0
}

fn is_stopword(word: &str) -> bool {
    const STOPWORDS: [&str; 40] = [
        "the", "a", "an", "is", "was", "are", "were", "to", "of", "and", "or",
        "with", "this", "that", "its", "it", "in", "on", "for", "by", "as",
        "at", "from", "sending", "sent", "no", "not",
        // Scaffolding: words every tx-lookup answer repeats regardless of
        // whether the facts are right, so raw overlap on them proves
        // nothing about correctness (same bug Sentinel hit on
        // registrationId 92 — see its lib.rs comment on STOPWORDS).
        "transaction", "status", "included", "wei", "eth", "value",
        "block", "hash", "chain", "tx", "eth.", "was", "amount",
    ];
    if is_numeric_token(word) {
        return false;
    }
    let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.len() < 3 {
        return true;
    }
    STOPWORDS.iter().any(|s| s.eq_ignore_ascii_case(trimmed))
}

// Strips comma thousands-separators so "20,123,456" and "20123456" compare
// equal as the same block number — a real formatting difference between a
// raw API integer and prose written by a human or an LLM, not a fact
// mismatch. Buffer must be >= the longest token this is used to compare:
// a tx hash is "0x" + 64 hex chars = 66 bytes, the longest realistic
// salient token, so 80 leaves headroom without a silent truncation that
// would let two different long hex strings compare equal on a shared
// prefix (a real bug this replaced — the old 32-byte buffer truncated a
// 42-char address before the comparison ever saw its last 10 hex digits).
fn strip_commas(word: &str) -> ([u8; 80], usize) {
    let mut buf = [0u8; 80];
    let mut n = 0usize;
    for &b in word.as_bytes() {
        if b != b',' && n < buf.len() {
            buf[n] = b;
            n += 1;
        }
    }
    (buf, n)
}

fn tokens_eq_ignoring_commas(a: &str, b: &str) -> bool {
    let (abuf, an) = strip_commas(a);
    let (bbuf, bn) = strip_commas(b);
    an == bn && abuf[..an].eq_ignore_ascii_case(&bbuf[..bn])
}

// Tolerates a comma anywhere in the hex portion (most commonly a trailing
// one from prose punctuation, e.g. "from 0xAB...12, to 0xCD...34") rather
// than rejecting outright — this was a real bug in the shipped scorer: the
// trim closures that feed this function deliberately leave a boundary
// comma attached (so tokens_eq_ignoring_commas can normalize it during the
// actual comparison), but the plain `all(is_ascii_hexdigit)` check here
// didn't skip that comma, so any address followed directly by a comma
// silently failed the hex check and lost its salient (2x) weight and its
// match entirely. Every ground-truth address in a "from X, to Y" sentence
// has exactly this shape, so this wasn't a rare edge case.
fn is_hex_address(trimmed: &str) -> bool {
    if !(trimmed.starts_with("0x") || trimmed.starts_with("0X")) {
        return false;
    }
    let mut hex_count = 0u32;
    for &b in &trimmed.as_bytes()[2..] {
        if b == b',' {
            continue;
        }
        if !b.is_ascii_hexdigit() {
            return false;
        }
        hex_count += 1;
    }
    hex_count >= 4
}

// A hex address/tx-hash or a number (block height, wei/token amount,
// confirmation count): the concrete, checkable facts that separate a
// genuinely correct answer from one that merely guessed the right status
// word. Weighted higher in content_overlap below, and any digit count
// counts — a 1-digit "0 wei" or a 3-digit confirmation count is just as
// checkable a fact as a 9-digit block number, so there's no reason to
// require >=4 digits before it counts as salient.
fn is_salient(word: &str) -> bool {
    let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ',');
    if is_hex_address(trimmed) {
        return true;
    }
    is_numeric_token(trimmed)
}

// Status-word synonym groups so a real hidden-benchmark answer phrased
// differently from our own fixtures ("succeeded", "went through", "mined")
// still gets credit for saying the same thing. This mirrors the technique
// Sentinel's champion analysis found: the current champion's WASM is ~99%
// embedded static data, most plausibly a synonym/semantic lookup table,
// not smarter control flow.
const SYNONYM_GROUPS: [&[&str]; 6] = [
    &["confirmed", "success", "succeeded", "mined", "included", "completed", "landed", "finalized", "successful"],
    &["reverted", "failed", "failure", "unsuccessful", "revert"],
    &["pending", "unconfirmed", "queued", "mempool", "unmined", "processing"],
    &["notfound", "nonexistent", "unknown", "unrecorded", "missing", "invalid"],
    &["sender", "from", "originator"],
    &["recipient", "receiver", "destination"],
];

fn synonym_match(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    for group in SYNONYM_GROUPS.iter() {
        let a_in = group.iter().any(|w| w.eq_ignore_ascii_case(a));
        let b_in = group.iter().any(|w| w.eq_ignore_ascii_case(b));
        if a_in && b_in {
            return true;
        }
    }
    false
}

// Recall-oriented: what fraction of ground_truth's real content (by weight)
// shows up in the answer, exact or synonym match. Salient facts (hex
// addresses, block numbers) count double and must match exactly (a
// synonym for a block number doesn't exist); everything else can match by
// synonym so paraphrasing isn't punished as a miss.
fn content_overlap_parts(answer: &str, ground_truth: &str) -> (f32, f32) {
    let mut total_weight = 0.0f32;
    let mut matched_weight = 0.0f32;
    for word in ground_truth.split_whitespace() {
        if is_stopword(word) {
            continue;
        }
        let salient = is_salient(word);
        let weight = if salient { 2.0 } else { 1.0 };
        total_weight += weight;
        let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ',');
        let hit = if salient {
            answer
                .split_whitespace()
                .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ','))
                .any(|w| tokens_eq_ignoring_commas(w, trimmed))
        } else {
            answer
                .split_whitespace()
                .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric()))
                .any(|w| synonym_match(w, trimmed))
        };
        if hit {
            matched_weight += weight;
        }
    }
    (total_weight, matched_weight)
}

fn content_overlap(answer: &str, ground_truth: &str) -> f32 {
    let (total_weight, matched_weight) = content_overlap_parts(answer, ground_truth);
    if total_weight == 0.0 {
        0.0
    } else {
        matched_weight / total_weight
    }
}

fn word_overlap(answer: &str, ground_truth: &str) -> f32 {
    let mut total = 0u32;
    let mut matched = 0u32;
    for word in answer.split_whitespace() {
        total += 1;
        if ground_truth
            .split_whitespace()
            .any(|w| w.eq_ignore_ascii_case(word))
        {
            matched += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        matched as f32 / total as f32
    }
}

// content_overlap is recall-only: it never penalizes an answer for citing
// a salient fact (address/number) that ISN'T in ground_truth. That means a
// dishonest answer could pad itself with fabricated-but-plausible-looking
// extra facts alongside the real ones and score identically to a clean
// correct answer — precision is unchecked. `question` is the exemption
// list: the miner_answer legitimately echoes the queried tx_hash (and any
// other salient token from the question) without that being a fabrication,
// so only salient tokens absent from BOTH ground_truth and question count
// against the answer.
fn hallucination_ratio(answer: &str, ground_truth: &str, question: &str) -> f32 {
    let mut total = 0u32;
    let mut extra = 0u32;
    for word in answer.split_whitespace() {
        let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ',');
        if !is_salient(trimmed) {
            continue;
        }
        total += 1;
        let in_gt = ground_truth
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ','))
            .any(|w| tokens_eq_ignoring_commas(w, trimmed));
        let in_q = question
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ','))
            .any(|w| tokens_eq_ignoring_commas(w, trimmed));
        if !in_gt && !in_q {
            extra += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        extra as f32 / total as f32
    }
}

const SENDER_WORDS: [&str; 3] = ["from", "sender", "originator"];
const RECIPIENT_WORDS: [&str; 4] = ["to", "recipient", "receiver", "destination"];

fn role_of(word: &str) -> Option<u8> {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if SENDER_WORDS.iter().any(|s| s.eq_ignore_ascii_case(w)) {
        Some(0)
    } else if RECIPIENT_WORDS.iter().any(|s| s.eq_ignore_ascii_case(w)) {
        Some(1)
    } else {
        None
    }
}

// Finds (role, address) pairs: a sender/recipient word followed within a
// few tokens by a hex address. Deliberately conservative — only pairs that
// are unambiguous in both texts get compared, so this never penalizes
// phrasing content_overlap can't parse, only a genuine swap where the
// SAME address is bound to the OPPOSITE role in the answer.
fn find_role_pairs<'a>(text: &'a str, out: &mut [(u8, &'a str)]) -> usize {
    let mut tokens: [&str; 96] = [""; 96];
    let mut tn = 0usize;
    for w in text.split_whitespace() {
        if tn >= tokens.len() {
            break;
        }
        tokens[tn] = w;
        tn += 1;
    }
    let mut n = 0usize;
    for i in 0..tn {
        if n >= out.len() {
            break;
        }
        if let Some(role) = role_of(tokens[i]) {
            let end = (i + 4).min(tn);
            for tok in tokens.iter().take(end).skip(i + 1) {
                let trimmed = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ',');
                if is_hex_address(trimmed) {
                    out[n] = (role, trimmed);
                    n += 1;
                    break;
                }
            }
        }
    }
    n
}

// Fraction of ground_truth's unambiguous role-bound addresses that appear
// in the answer bound to the OPPOSITE role — catches a from/to swap that
// content_overlap structurally cannot see (it only checks whether each
// address appears anywhere in the answer, not which role it's attached
// to, so "sent from A to B" and "sent from B to A" score identically
// without this check despite being factually reversed).
fn role_violation_ratio(answer: &str, ground_truth: &str) -> f32 {
    let mut gt_pairs: [(u8, &str); 8] = [(0, ""); 8];
    let gt_n = find_role_pairs(ground_truth, &mut gt_pairs);
    if gt_n == 0 {
        return 0.0;
    }
    let mut ma_pairs: [(u8, &str); 8] = [(0, ""); 8];
    let ma_n = find_role_pairs(answer, &mut ma_pairs);

    let mut checked = 0u32;
    let mut violations = 0u32;
    for &(grole, gaddr) in gt_pairs.iter().take(gt_n) {
        for &(mrole, maddr) in ma_pairs.iter().take(ma_n) {
            if tokens_eq_ignoring_commas(gaddr, maddr) {
                checked += 1;
                if mrole != grole {
                    violations += 1;
                }
                break;
            }
        }
    }
    if checked == 0 {
        0.0
    } else {
        violations as f32 / checked as f32
    }
}

fn score(question: &str, ground_truth: &str, miner_answer: &str) -> f32 {
    if miner_answer == ground_truth {
        return 1.0;
    }

    let gt_status = extract_status(ground_truth);
    let ma_status = extract_status(miner_answer);
    let content = content_overlap(miner_answer, ground_truth);

    // The status verdict is still the single worst thing to get wrong (a
    // "confirmed" answer for a reverted tx is wrong no matter how many
    // correct details it cites), so a mismatch stays heavily penalized.
    // But a *correct* verdict is necessary, not sufficient: two answers can
    // both say "confirmed" while one names the real block/addresses and
    // the other doesn't, so once the verdict matches, the score is
    // dominated by content_overlap rather than a flat bonus for the right
    // word. A flat bonus is what caused the previous rejection (eval
    // margin 0.0219): near-identical status-word answers scored almost
    // identically regardless of whether the underlying facts were right.
    let mut base = if ma_status == TxStatus::Unknown {
        0.10 + content * 0.10
    } else if ma_status == gt_status {
        0.30 + content * 0.65
    } else {
        0.05 + content * 0.10
    };

    // Small secondary signal for close paraphrasing beyond salient facts.
    base += word_overlap(miner_answer, ground_truth) * 0.10;

    // Precision penalties content_overlap structurally can't apply, since
    // it only ever measures recall (ground_truth -> answer). A right
    // status word plus fabricated or swapped facts is still a wrong
    // answer.
    base -= hallucination_ratio(miner_answer, ground_truth, question) * 0.40;
    base -= role_violation_ratio(miner_answer, ground_truth) * 0.45;

    if base < 0.0 {
        0.0
    } else if base > 1.0 {
        1.0
    } else {
        base
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rank_answer(
    q_ptr: i32,
    q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> f32 {
    unsafe {
        let question = read_str(q_ptr, q_len);
        let ground_truth = read_str(gt_ptr, gt_len);
        let miner_answer = read_str(ma_ptr, ma_len);
        if miner_answer.trim().is_empty() {
            return 0.0;
        }
        score(question, ground_truth, miner_answer)
    }
}
