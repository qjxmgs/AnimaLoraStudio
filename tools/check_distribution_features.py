"""Fail CI when a qjxmgs release drops required distribution features."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / ".anima-distribution.json"
EXPECTED_ID = "qjxmgs"
EXPECTED_ORIGIN = "https://github.com/qjxmgs/AnimaLoraStudio.git"
HEAD_MASK = ROOT / "studio" / "services" / "preprocess" / "head_mask.py"
UPDATER = ROOT / "studio" / "services" / "runtime" / "updater.py"


def fail(message: str) -> None:
    raise SystemExit(f"distribution check failed: {message}")


def main() -> int:
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {MANIFEST.name}: {exc}")

    if data.get("distribution_id") != EXPECTED_ID:
        fail(f"distribution_id must be {EXPECTED_ID!r}")
    if data.get("origin_url") != EXPECTED_ORIGIN:
        fail(f"origin_url must be {EXPECTED_ORIGIN!r}")
    if data.get("stable_ref") != "origin/master" or data.get("dev_ref") != "origin/dev":
        fail("stable_ref/dev_ref must stay on the qjxmgs origin remote")

    required = data.get("required_features")
    expected_level = required.get("auto_head_mask") if isinstance(required, dict) else None
    if isinstance(expected_level, bool) or not isinstance(expected_level, int) or expected_level < 1:
        fail("required_features.auto_head_mask must be a positive integer")

    try:
        feature_text = HEAD_MASK.read_text(encoding="utf-8-sig")
        updater_text = UPDATER.read_text(encoding="utf-8-sig")
    except OSError as exc:
        fail(f"required implementation file is missing: {exc}")

    match = re.search(r"^AUTO_HEAD_MASK_FEATURE_LEVEL\s*=\s*(\d+)\s*$", feature_text, re.MULTILINE)
    if match is None or int(match.group(1)) < expected_level:
        fail("auto-head-mask implementation marker is missing or too old")
    if "ANIMA_DISTRIBUTION_UPDATE_GUARD_V1" not in updater_text:
        fail("distribution-aware self-update guard marker is missing")

    print(
        f"distribution {EXPECTED_ID}: auto_head_mask={expected_level}, update guard present"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
