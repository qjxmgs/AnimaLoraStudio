"""qjxmgs distribution guard and manual-upstream-sync regression tests."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from studio import db, server
from studio.services.projects import projects
from studio.services.runtime import updater
from tools import check_distribution_features


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=check,
        capture_output=True,
        text=True,
    )


def test_checked_out_distribution_markers_match_manifest() -> None:
    """Runs in the repository's existing Tests/backend CI job."""
    assert check_distribution_features.main() == 0


def _write_manifest(repo: Path, *, distribution_id: str = "qjxmgs", level: int = 1) -> None:
    (repo / ".anima-distribution.json").write_text(
        json.dumps(
            {
                "distribution_id": distribution_id,
                "origin_url": "https://github.com/qjxmgs/AnimaLoraStudio.git",
                "stable_ref": "origin/master",
                "dev_ref": "origin/dev",
                "required_features": {"auto_head_mask": level},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", message)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


@pytest.fixture
def distribution_repo(tmp_path: Path) -> dict[str, Any]:
    repo = tmp_path / "distribution-repo"
    repo.mkdir()
    _git(repo, "init", "-b", "master")
    _git(repo, "config", "user.email", "tests@example.invalid")
    _git(repo, "config", "user.name", "Anima Tests")

    head_mask = repo / "studio" / "services" / "preprocess" / "head_mask.py"
    runtime_updater = repo / "studio" / "services" / "runtime" / "updater.py"
    head_mask.parent.mkdir(parents=True)
    runtime_updater.parent.mkdir(parents=True)
    head_mask.write_text("AUTO_HEAD_MASK_FEATURE_LEVEL = 1\n", encoding="utf-8")
    runtime_updater.write_text(
        'DISTRIBUTION_UPDATE_GUARD_MARKER = "ANIMA_DISTRIBUTION_UPDATE_GUARD_V1"\n',
        encoding="utf-8",
    )
    _write_manifest(repo)
    base = _commit(repo, "valid distribution")
    _git(repo, "tag", "valid-base")

    _write_manifest(repo, level=2)
    head_mask.write_text("AUTO_HEAD_MASK_FEATURE_LEVEL = 2\n", encoding="utf-8")
    valid_upgrade = _commit(repo, "valid feature superset")
    _git(repo, "tag", "valid-upgrade")

    _git(repo, "switch", "-c", "bad-missing-manifest", "valid-base")
    (repo / ".anima-distribution.json").unlink()
    missing_manifest = _commit(repo, "remove manifest")

    _git(repo, "switch", "-c", "bad-missing-feature", "valid-base")
    head_mask.write_text("# marker removed\n", encoding="utf-8")
    missing_feature = _commit(repo, "remove feature marker")

    _git(repo, "switch", "-c", "bad-missing-guard", "valid-base")
    runtime_updater.write_text("# guard removed\n", encoding="utf-8")
    missing_guard = _commit(repo, "remove updater guard")

    _git(repo, "switch", "-c", "bad-wrong-distribution", "valid-base")
    _write_manifest(repo, distribution_id="official")
    wrong_distribution = _commit(repo, "change distribution")

    _git(repo, "switch", "--detach", "valid-base")
    return {
        "repo": repo,
        "base": base,
        "valid_upgrade": valid_upgrade,
        "missing_manifest": missing_manifest,
        "missing_feature": missing_feature,
        "missing_guard": missing_guard,
        "wrong_distribution": wrong_distribution,
    }


@pytest.fixture
def use_distribution_repo(
    distribution_repo: dict[str, Any], monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    repo = distribution_repo["repo"]
    monkeypatch.setattr(updater, "REPO_ROOT", repo)
    monkeypatch.setattr(updater, "DISTRIBUTION_MANIFEST_PATH", repo / ".anima-distribution.json")
    return distribution_repo


@pytest.fixture
def isolated_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    database = tmp_path / "studio.db"
    db.init_db(database)
    monkeypatch.setattr(db, "STUDIO_DB", database)
    monkeypatch.setattr(server.db, "STUDIO_DB", database)
    monkeypatch.setattr(projects, "PROJECTS_DIR", tmp_path / "projects")
    return {"db": database}


@pytest.fixture
def client(isolated_paths: dict[str, Path]) -> TestClient:
    return TestClient(server.app)


def _clean_version(commit: str, *, dirty: bool = False) -> updater.VersionInfo:
    return updater.VersionInfo(
        version="test",
        commit=commit,
        commit_short=commit[:8],
        commit_time_iso="",
        branch="detached",
        tag=None,
        is_dirty=dirty,
    )


def _patch_update_flags(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    monkeypatch.setattr(updater, "UPDATE_PENDING", root / ".update_pending")
    monkeypatch.setattr(updater, "UPDATE_FORCE", root / ".update_force")
    monkeypatch.setattr(updater, "UPDATE_CACHE", root / ".update_cache")
    monkeypatch.setattr(updater, "LAST_VERSION", root / ".last_version")
    monkeypatch.setattr(updater, "UPDATE_LOG", root / ".update_log")
    monkeypatch.setattr(updater, "UPDATE_STATUS", root / ".update_status")
    monkeypatch.setattr(updater, "RESTART_FLAG", root / "tmp" / "restart")
    monkeypatch.setattr(updater, "PRESERVE_HOLDING", root / ".update_preserve")


def test_distribution_contract_accepts_superset_and_rejects_removed_parts(
    use_distribution_repo: dict[str, Any],
) -> None:
    valid = updater.check_distribution_compatibility(
        use_distribution_repo["valid_upgrade"],
    )
    assert valid.compatible is True
    assert valid.target_features == {"auto_head_mask": 2}

    expected_reasons = {
        "missing_manifest": ".anima-distribution.json",
        "missing_feature": "implementation marker",
        "missing_guard": "self-update guard",
        "wrong_distribution": "distribution_id",
    }
    for key, reason in expected_reasons.items():
        result = updater.check_distribution_compatibility(use_distribution_repo[key])
        assert result.compatible is False
        assert reason in result.reason


def test_emergency_environment_variable_is_the_only_compatibility_bypass(
    use_distribution_repo: dict[str, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(updater.ALLOW_INCOMPATIBLE_UPDATE_ENV, "1")
    result = updater.check_distribution_compatibility(
        use_distribution_repo["missing_manifest"],
    )
    assert result.compatible is True
    assert result.bypassed is True
    assert updater.ALLOW_INCOMPATIBLE_UPDATE_ENV in result.reason


@pytest.mark.parametrize("target_key", ["missing_manifest", "missing_feature"])
def test_preflight_blocks_incomplete_distribution_target(
    client: TestClient,
    isolated_paths: dict[str, Path],
    use_distribution_repo: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    target_key: str,
) -> None:
    monkeypatch.setattr(
        updater, "current_version", lambda: _clean_version(use_distribution_repo["base"]),
    )
    monkeypatch.setattr(updater, "requirements_diff", lambda _ref: updater.RequirementsDiff())
    monkeypatch.setattr(updater, "target_has_self_update", lambda _ref: True)

    body = client.get(
        f"/api/system/preflight?target={use_distribution_repo[target_key]}"
    ).json()
    assert body["blocking"] is True
    check = next(c for c in body["checks"] if c["key"] == "distribution_compat")
    assert check["level"] == "err"
    assert "已阻止更新" in check["label"]


@pytest.mark.parametrize("target_key", ["missing_manifest", "missing_feature"])
def test_update_post_force_cannot_bypass_distribution_guard(
    client: TestClient,
    isolated_paths: dict[str, Path],
    use_distribution_repo: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    target_key: str,
) -> None:
    _patch_update_flags(monkeypatch, tmp_path / "flags")
    monkeypatch.setattr(
        updater,
        "current_version",
        lambda: _clean_version(use_distribution_repo["base"], dirty=True),
    )

    response = client.post(
        "/api/system/update",
        json={"target": use_distribution_repo[target_key], "force": True},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "system.incompatible_distribution_update"
    assert not updater.UPDATE_PENDING.exists()
    assert not updater.RESTART_FLAG.exists()


@pytest.mark.parametrize("target_key", ["missing_manifest", "missing_feature"])
def test_apply_pending_rechecks_after_fetch_and_never_resets_incompatible_target(
    use_distribution_repo: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    target_key: str,
) -> None:
    flags = tmp_path / "flags"
    _patch_update_flags(monkeypatch, flags)
    updater.UPDATE_PENDING.parent.mkdir(parents=True)
    updater.UPDATE_PENDING.write_text(use_distribution_repo[target_key], encoding="utf-8")
    updater.UPDATE_FORCE.touch()
    monkeypatch.setattr(
        updater,
        "current_version",
        lambda: _clean_version(use_distribution_repo["base"], dirty=True),
    )

    real_git = updater._git
    calls: list[tuple[str, ...]] = []

    def guarded_git(*args: str, **kwargs: Any) -> tuple[int, str, str]:
        calls.append(args)
        if args[:2] == ("fetch", "origin"):
            return 0, "", ""
        return real_git(*args, **kwargs)

    monkeypatch.setattr(updater, "_git", guarded_git)
    assert updater.apply_pending(emit=lambda _message: None) is True
    assert not any(call and call[0] == "reset" for call in calls)
    status = updater.last_status()
    assert status is not None and status.status == "aborted"
    assert "incompatible distribution" in status.reason
    assert _git(use_distribution_repo["repo"], "rev-parse", "HEAD").stdout.strip() == use_distribution_repo["base"]


def test_valid_fork_update_and_rollback_are_schedulable(
    client: TestClient,
    isolated_paths: dict[str, Path],
    use_distribution_repo: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _patch_update_flags(monkeypatch, tmp_path / "flags")
    monkeypatch.setattr(
        updater, "current_version", lambda: _clean_version(use_distribution_repo["base"]),
    )
    monkeypatch.setattr("studio.api.routers.system._raise_sigint_after_response", lambda: None)

    response = client.post(
        "/api/system/update", json={"target": use_distribution_repo["valid_upgrade"]},
    )
    assert response.status_code == 200
    assert updater.UPDATE_PENDING.read_text(encoding="utf-8") == use_distribution_repo["valid_upgrade"]

    updater.UPDATE_PENDING.unlink()
    updater.LAST_VERSION.write_text(use_distribution_repo["base"], encoding="utf-8")
    assert updater.request_rollback() == use_distribution_repo["base"]
    assert updater.UPDATE_PENDING.read_text(encoding="utf-8") == use_distribution_repo["base"]


@pytest.mark.parametrize('target_key', [
    'base', 'missing_manifest', 'missing_feature', 'missing_guard', 'wrong_distribution', 'understated_marker',
])
def test_contour_level_two_is_enforced_at_all_three_layers(
    client, use_distribution_repo, monkeypatch, tmp_path, target_key,
):
    repo = use_distribution_repo['repo']
    current = use_distribution_repo['valid_upgrade']
    _git(repo, 'switch', '--detach', current)
    if target_key == 'understated_marker':
        marker = repo / 'studio/services/preprocess/head_mask.py'
        marker.write_text('AUTO_HEAD_MASK_FEATURE_LEVEL = 1\n', encoding='utf-8')
        target = _commit(repo, 'claims level two without its implementation')
        _git(repo, 'switch', '--detach', current)
    else:
        target = use_distribution_repo[target_key]
    _patch_update_flags(monkeypatch, tmp_path / 'contour-flags')
    monkeypatch.setattr(updater, 'current_version', lambda: _clean_version(current, dirty=True))
    monkeypatch.setattr(updater, 'requirements_diff', lambda _ref: updater.RequirementsDiff())
    monkeypatch.setattr(updater, 'target_has_self_update', lambda _ref: True)
    body = client.get('/api/system/preflight', params={'target': target}).json()
    assert body['blocking']
    assert next(c for c in body['checks'] if c['key'] == 'distribution_compat')['level'] == 'err'
    response = client.post('/api/system/update', json={'target': target, 'force': True})
    assert response.status_code == 422
    assert not updater.UPDATE_PENDING.exists()
    assert not updater.RESTART_FLAG.exists()

    updater.UPDATE_PENDING.parent.mkdir(parents=True, exist_ok=True)
    updater.UPDATE_PENDING.write_text(target, encoding='utf-8')
    updater.UPDATE_FORCE.touch()
    real_git = updater._git
    calls = []
    def offline_git(*args, **kwargs):
        calls.append(args)
        if args[:2] == ('fetch', 'origin'):
            return 0, '', ''
        return real_git(*args, **kwargs)
    monkeypatch.setattr(updater, '_git', offline_git)
    assert updater.apply_pending(emit=lambda _message: None)
    assert updater.last_status().status == 'aborted'
    assert not any(call and call[0] == 'reset' for call in calls)
    assert _git(repo, 'rev-parse', 'HEAD').stdout.strip() == current


def test_contour_level_two_allows_only_level_two_or_higher_rollback(
    client, use_distribution_repo, monkeypatch, tmp_path,
):
    repo = use_distribution_repo['repo']
    level_two = use_distribution_repo['valid_upgrade']
    _git(repo, 'switch', '--detach', level_two)
    (repo / 'compatible-update.txt').write_text('retains face contours', encoding='utf-8')
    next_level_two = _commit(repo, 'compatible local update')
    _git(repo, 'switch', '--detach', level_two)
    _patch_update_flags(monkeypatch, tmp_path / 'contour-flags')
    monkeypatch.setattr(updater, 'current_version', lambda: _clean_version(level_two))
    monkeypatch.setattr('studio.api.routers.system._raise_sigint_after_response', lambda: None)
    assert client.post('/api/system/update', json={'target': next_level_two}).status_code == 200
    updater.UPDATE_PENDING.unlink()
    updater.LAST_VERSION.write_text(level_two, encoding='utf-8')
    assert updater.request_rollback() == level_two
    updater.UPDATE_PENDING.unlink()
    updater.LAST_VERSION.write_text(use_distribution_repo['base'], encoding='utf-8')
    with pytest.raises(updater.IncompatibleDistributionUpdate):
        updater.request_rollback()
    assert not updater.UPDATE_PENDING.exists()


def _init_sync_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "sync-repo"
    repo.mkdir()
    _git(repo, "init", "-b", "master")
    _git(repo, "config", "user.email", "tests@example.invalid")
    _git(repo, "config", "user.name", "Anima Tests")
    (repo / "shared.txt").write_text("base\n", encoding="utf-8")
    _commit(repo, "base")
    return repo


def test_manual_upstream_non_fast_forward_merge_preserves_custom_feature(tmp_path: Path) -> None:
    repo = _init_sync_repo(tmp_path)
    _git(repo, "switch", "-c", "fork-master")
    (repo / ".anima-distribution.json").write_text("{}\n", encoding="utf-8")
    _commit(repo, "fork feature")

    _git(repo, "switch", "-c", "upstream-master", "master")
    (repo / "upstream.txt").write_text("official update\n", encoding="utf-8")
    _commit(repo, "official update")

    _git(repo, "switch", "fork-master")
    _git(repo, "merge", "--no-ff", "upstream-master", "-m", "sync upstream")
    assert (repo / ".anima-distribution.json").is_file()
    assert (repo / "upstream.txt").read_text(encoding="utf-8") == "official update\n"
    assert len(_git(repo, "rev-list", "--parents", "-n", "1", "HEAD").stdout.split()) == 3


def test_manual_upstream_conflict_does_not_publish_a_merge_commit(tmp_path: Path) -> None:
    repo = _init_sync_repo(tmp_path)
    file = repo / "shared.txt"

    _git(repo, "switch", "-c", "fork-master")
    file.write_text("fork guard\n", encoding="utf-8")
    _commit(repo, "fork guard")

    _git(repo, "switch", "-c", "upstream-master", "master")
    file.write_text("official updater\n", encoding="utf-8")
    _commit(repo, "official updater")

    _git(repo, "switch", "fork-master")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()
    merge = _git(repo, "merge", "--no-ff", "upstream-master", check=False)
    assert merge.returncode != 0
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before
    assert "UU shared.txt" in _git(repo, "status", "--short").stdout
    _git(repo, "merge", "--abort")
