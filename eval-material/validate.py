#!/usr/bin/env python3
"""Check evaluation-data files against the documented upload format.

Usage: python3 validate.py [file.jsonl ...]
With no arguments it checks every *.jsonl file next to this script.
The intent name is taken from the file name (INTENT_NAME.jsonl).
Exit code is 0 only if every file passes.
"""
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path

LABELS = {"preference_pair", "ground_truth", "graded_exemplar", "truth_source"}
PROMPT_MIN, PROMPT_MAX = 16, 16000
ANS_MIN, ANS_MAX = 8, 32000
ROW_MAX_BYTES = 64 * 1024
BODY_MAX_BYTES = 32 * 1024 * 1024
NEAR_DUP = 0.85
MIN_ROWS = 60
CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon"]


def norm(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


def has_control(text):
    return any(ord(c) < 32 and c not in "\t\n\r" or ord(c) == 127 for c in text)


def check_file(path):
    intent = path.stem
    errors, warnings = [], []
    data = path.read_bytes()
    if len(data) > BODY_MAX_BYTES:
        errors.append("file is over 32 MB")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return [f"{path.name}: invalid_utf8"], [], {}
    if "\r" in text:
        warnings.append("file has Windows line endings; use plain newlines")
    lines = [ln for ln in text.split("\n") if ln != ""]
    seen_prompts, rows, kinds, chain_hits = {}, [], {}, {}
    for n, line in enumerate(lines, 1):
        def bad(code, msg=""):
            errors.append(f"line {n}: {code} {msg}".strip())
        if len(line.encode("utf-8")) > ROW_MAX_BYTES:
            bad("too_long", "row is over 64 KiB")
        if "\x00" in line:
            bad("nul_character"); continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            bad("invalid_json"); continue
        if not isinstance(row, dict):
            bad("invalid_json", "row is not an object"); continue
        kind = row.get("label_kind", "preference_pair")
        if kind not in LABELS:
            bad("unknown_label_kind", repr(kind)); continue
        kinds[kind] = kinds.get(kind, 0) + 1
        if "intent_id" in row and row["intent_id"] != intent:
            bad("intent_mismatch", f"{row['intent_id']} vs file {intent}")
        if kind == "truth_source":
            warnings.append(f"line {n}: truth_source rows are not checked by this script")
            continue
        prompt, chosen, rejected = row.get("prompt"), row.get("chosen"), row.get("rejected")
        if not isinstance(prompt, str) or not norm(prompt):
            bad("missing_field", "prompt"); continue
        for name, val in (("prompt", prompt), ("chosen", chosen), ("rejected", rejected)):
            if isinstance(val, str) and has_control(val):
                bad("control_chars", name)
        p = norm(prompt)
        if len(p) < PROMPT_MIN:
            bad("too_short", "prompt")
        if len(p) > PROMPT_MAX:
            bad("too_long", "prompt")
        if not isinstance(chosen, str) or not chosen.strip():
            bad("missing_field", "chosen"); continue
        if len(chosen) < ANS_MIN:
            bad("too_short", "chosen")
        if len(chosen) > ANS_MAX:
            bad("too_long", "chosen")
        if kind == "preference_pair":
            if not isinstance(rejected, str) or not rejected.strip():
                bad("missing_field", "rejected"); continue
        if isinstance(rejected, str) and rejected.strip():
            if len(rejected) < ANS_MIN:
                bad("too_short", "rejected")
            if len(rejected) > ANS_MAX:
                bad("too_long", "rejected")
            if rejected == chosen:
                bad("identical_answers")
            ratio = len(rejected) / max(len(chosen), 1)
            if not 0.7 <= ratio <= 1.4:
                warnings.append(f"line {n}: rejected/chosen length ratio {ratio:.2f} (keep them similar)")
        if not re.search(r"\d", chosen):
            bad("schema_mismatch", "chosen states no number")
        prov = row.get("provenance")
        if prov is not None:
            if not isinstance(prov, dict) or set(prov) - {"source_kind", "source_url"}:
                bad("schema_mismatch", "provenance must only hold source_kind and source_url")
            elif not str(prov.get("source_url", "")).startswith(("http://", "https://")):
                warnings.append(f"line {n}: no http(s) source_url, row will count as unverified")
        else:
            warnings.append(f"line {n}: no provenance")
        if p in seen_prompts:
            bad("duplicate_case", f"same prompt as line {seen_prompts[p]}")
        seen_prompts[p] = n
        for c in CHAINS:
            pat = r"\bbase\b(?! fee| units)" if c == "base" else c
            if re.search(pat, p.lower()):
                chain_hits[c] = chain_hits.get(c, 0) + 1
        rows.append((n, p, chosen, rejected))
    # near duplicates among prompts
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            r = difflib.SequenceMatcher(None, rows[i][1], rows[j][1]).ratio()
            if r >= NEAR_DUP:
                errors.append(f"line {rows[j][0]}: near_duplicate of line {rows[i][0]} ({r:.2f})")
    # repeated stock answers
    for idx, label in ((2, "chosen"), (3, "rejected")):
        seen = {}
        for r in rows:
            if r[idx]:
                key = norm(r[idx])
                if key in seen:
                    warnings.append(f"line {r[0]}: {label} text repeats line {seen[key]}")
                seen[key] = r[0]
    if len(lines) < MIN_ROWS:
        errors.append(f"only {len(lines)} rows, need at least {MIN_ROWS}")
    missing = [c for c in CHAINS if c not in chain_hits]
    if missing:
        warnings.append("no prompts mention: " + ", ".join(missing))
    stats = {"rows": len(lines), "kinds": kinds, "chains": chain_hits}
    return errors, warnings, stats


def main():
    here = Path(__file__).resolve().parent
    files = [Path(a) for a in sys.argv[1:]] or sorted(here.glob("*.jsonl"))
    if not files:
        print("no .jsonl files found")
        return 1
    failed = False
    for f in files:
        errors, warnings, stats = check_file(f)
        status = "PASS" if not errors else "FAIL"
        failed |= bool(errors)
        print(f"{status}  {f.name}  rows={stats.get('rows', 0)}  kinds={stats.get('kinds', {})}  chains={stats.get('chains', {})}")
        for e in errors[:25]:
            print("   error:", e)
        if len(errors) > 25:
            print(f"   ... and {len(errors) - 25} more errors")
        for w in warnings[:10]:
            print("   note:", w)
        if len(warnings) > 10:
            print(f"   ... and {len(warnings) - 10} more notes")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
