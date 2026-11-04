"""Exact training-file selection and local-only desktop boundary."""
from __future__ import annotations

import ctypes
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from studio import db, server
from studio.api.routers.projects import training
from studio.services.projects import projects, versions
from studio.services.runtime import file_manager


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    dbfile = tmp_path / "studio.db"
    db.init_db(dbfile)
    monkeypatch.setattr(db, "STUDIO_DB", dbfile)
    monkeypatch.setattr(projects, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(training, "sys", SimpleNamespace(platform="win32"))
    reveal = Mock()
    monkeypatch.setattr(file_manager, "reveal_file", reveal)
    client = TestClient(server.app, client=("127.0.0.1", 12345))
    project = client.post("/api/projects", json={"title": "Reveal"}).json()
    pid, vid = project["id"], project["versions"][0]["id"]
    root = versions.version_dir(pid, project["slug"], project["versions"][0]["label"]) / "train"
    return client, f"/api/projects/{pid}/versions/{vid}/train/reveal", root, reveal


def test_reveals_exact_train_file_not_download_or_same_name_in_other_folder(env):
    client, url, root, reveal = env
    for folder in ("1_data", "2_other"):
        image = root / folder / "中文 图片 (1), test.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"image")
    response = client.post(url, json={"path": "2_other/中文 图片 (1), test.png"})
    assert response.status_code == 200
    assert response.json() == {"revealed": True}
    reveal.assert_called_once_with((root / "2_other/中文 图片 (1), test.png").resolve())
    assert (root / "1_data/中文 图片 (1), test.png").read_bytes() == b"image"


@pytest.mark.parametrize("path", [
    "", "a.png", "../download/a.png", "1_data/../../a.png", "1_data/../a.png",
    "/1_data/a.png", "C:/1_data/a.png", "C:1_data/a.png", "1_data//a.png",
    "1_data/./a.png", "1_data/a.png:stream", "1_data/a\x00.png", "\\\\server\\a.png",
])
def test_rejects_unsafe_paths_without_opening_explorer(env, path):
    client, url, _, reveal = env
    assert client.post(url, json={"path": path}).status_code == 400
    reveal.assert_not_called()


@pytest.mark.parametrize("path", ["1_data/missing.png", "1_data/caption.txt", "1_data/directory.png"])
def test_missing_files_non_images_and_directories_are_not_revealed(env, path):
    client, url, root, reveal = env
    (root / "1_data/caption.txt").write_text("tags", encoding="utf-8")
    (root / "1_data/directory.png").mkdir()
    response = client.post(url, json={"path": path})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "image.not_found"
    reveal.assert_not_called()


def test_rejects_version_from_another_project(env):
    client, url, _, reveal = env
    other = client.post("/api/projects", json={"title": "Other"}).json()
    url = url.replace("/projects/1/", f"/projects/{other['id']}/")
    assert client.post(url, json={"path": "1_data/a.png"}).status_code == 404
    reveal.assert_not_called()


@pytest.mark.parametrize("host", ["192.168.1.8", "testclient"])
def test_non_local_requests_cannot_open_server_desktop(env, host):
    _, url, _, reveal = env
    remote = TestClient(server.app, client=(host, 12345))
    response = remote.post(url, json={"path": "1_data/a.png"}, headers={"X-Forwarded-For": "127.0.0.1"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "system.reveal_local_only"
    reveal.assert_not_called()


def test_non_windows_is_explicitly_unsupported(env, monkeypatch):
    client, url, _, reveal = env
    monkeypatch.setattr(training, "sys", SimpleNamespace(platform="linux"))
    response = client.post(url, json={"path": "1_data/a.png"})
    assert response.status_code == 501
    assert response.json()["error"]["code"] == "system.reveal_windows_only"
    reveal.assert_not_called()


def test_shell_failure_is_reported(env):
    client, url, root, reveal = env
    (root / "1_data/a.png").write_bytes(b"image")
    reveal.side_effect = OSError("Shell unavailable")
    response = client.post(url, json={"path": "1_data/a.png"})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "system.reveal_failed"


@pytest.mark.parametrize("initialized, parse_result, open_result", [
    (0, 0, 0), (1, 0, 0), (-2147417850, 0, 0),
    (0, -2147467259, 0), (0, 0, -2147467259), (-2147467259, 0, 0),
])
def test_native_shell_selection_balances_com_and_pidl(monkeypatch, initialized, parse_result, open_result):
    # Run the adapter without opening real windows; exercise native error/ownership paths.
    ole = SimpleNamespace(CoInitializeEx=Mock(return_value=initialized), CoUninitialize=Mock(), CoTaskMemFree=Mock())

    def parse(_path, _context, pidl, _attributes, _result):
        pidl._obj.value = 1234
        return parse_result

    shell = SimpleNamespace(SHParseDisplayName=Mock(side_effect=parse), SHOpenFolderAndSelectItems=Mock(return_value=open_result))
    monkeypatch.setattr(ctypes, "WinDLL", lambda name: {"ole32": ole, "shell32": shell}[name], raising=False)
    failed = initialized == -2147467259 or parse_result < 0 or open_result < 0
    if failed:
        with pytest.raises(OSError, match="HRESULT"):
            file_manager.reveal_file(Path("train/中文 图片.png"))
    else:
        file_manager.reveal_file(Path("train/中文 图片.png"))
        args = shell.SHOpenFolderAndSelectItems.call_args.args
        assert args[0].value == 1234
        assert args[1:] == (0, None, 0)
    assert ole.CoUninitialize.call_count == int(initialized >= 0)
    assert ole.CoTaskMemFree.call_count == int(initialized != -2147467259)
