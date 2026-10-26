#!/usr/bin/env python3
"""Compare a structural snapshot (kanel_bookings_snapshot.sql) with an expected pre-release state (S105:
kanel_pre_s106_expected.json; S109: kanel_pre_s110_expected.json).

  --mode rollback (default): after a rollback — restored objects must equal S105 AND the
      release's functions/trigger must be absent.
  --mode drift: read-only PRE-RELEASE check against production — the objects the release
      will rewrite must equal S105 exactly (so the rollback restores what production has),
      and none of the release's objects may exist yet.
Both modes mean the same thing for the release objects (absent); they differ only in
the message. Exits non-zero with a list of every mismatch.

  psql -qAt -f kanel_bookings_snapshot.sql | python3 compare_kanel_expected.py expected.json - [--mode drift]
"""
import json
import sys

exp = json.load(open(sys.argv[1]))
snap = json.load(sys.stdin if sys.argv[2] == "-" else open(sys.argv[2]))
mode = sys.argv[sys.argv.index("--mode") + 1] if "--mode" in sys.argv else "rollback"
problems = []
for key, want in exp["restored_functions"].items():
    got = snap["functions"].get(key)
    if not got:
        problems.append(f"missing function {key}")
        continue
    for field in ("src_md5", "secdef", "config", "acl"):
        if got[field] != want[field]:
            problems.append(f"{key}: {field} differs (expected {want[field]!r}, found {got[field]!r})")
for key in exp["release_functions"]:
    if key in snap["functions"]:
        problems.append(f"release function present: {key}")
for key in exp["release_triggers"]:
    if key in snap["triggers"]:
        problems.append(f"release trigger present: {key}")
for key, want in exp["restored_constraints"].items():
    got = snap["constraints"].get(key, {}).get("def")
    if got != want:
        problems.append(f"constraint {key}: expected {want!r}, found {got!r}")
label = "pre-release drift check" if mode == "drift" else "rollback check"
if problems:
    print(f"{label}: {len(problems)} mismatch(es)")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print(f"{label}: all {len(exp['restored_functions'])} functions, {len(exp['restored_constraints'])} constraints match the expected state; "
      f"{len(exp['release_functions'])} release functions and {len(exp['release_triggers'])} trigger absent")
