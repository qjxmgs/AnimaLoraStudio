import hashlib
import json
import logging

import numpy as np
import pytest
from PIL import Image

from studio import secrets
from studio.infrastructure.task_log import TaskLog
from studio.services.models import pixai as assets
from studio.services.tagging.pixai import PixAITagger, SPLITS


def test_corrupt_download_retry(tmp_path, monkeypatch):
    payload = {key: key.encode() for key in assets.FILES}
    monkeypatch.setattr(assets, "FILES", {
        name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in payload.items()
    })
    calls = []
    damaged = assets.GRAPH + ".data"

    def download(repo, name, target, *, revision, on_log):
        assert repo == assets.REPO and revision == assets.REVISION
        calls.append(name)
        target.write_bytes(b"x" * len(payload[name]) if name == damaged else payload[name])
        return True

    monkeypatch.setattr(assets.sources, "download_flat", download)
    log = TaskLog(logging.getLogger(__name__))
    assert not assets.download(tmp_path, on_log=log)
    assert assets.status(tmp_path)["missing"] == [damaged, "config.json"]
    damaged = ""
    assert assets.download(tmp_path, on_log=log)
    assert assets.status(tmp_path)["valid"]
    assert calls.count(assets.GRAPH) == 1


def test_invalid_vocabulary_fails_before_session(tmp_path, monkeypatch):
    tagger = PixAITagger()
    monkeypatch.setattr(tagger, "is_available", lambda: (True, "ok"))
    monkeypatch.setattr(assets, "model_dir", lambda: tmp_path)
    (tmp_path / "config.json").write_text(json.dumps({
        "tags": ["one"], "num_classes": 30877, "tags_split": SPLITS[::-1],
    }))
    with pytest.raises(ValueError, match="vocabulary"):
        tagger.prepare()


def test_alpha_padding_and_logits(monkeypatch):
    monkeypatch.setattr(secrets, "load", secrets.Secrets)
    tagger = PixAITagger({"threshold_general": 0.5, "blacklist_tags": ["A B"]})
    tensor = tagger._preprocess(Image.new("RGBA", (8, 4), (0, 0, 0, 0)))
    assert tensor.shape == (3, 1008, 1008)
    assert (tensor[:, :252] == -1).all() and (tensor[:, 252:756] == 1).all()
    tagger.labels = [str(i) for i in range(30877)]
    tagger.labels[1] = "a_b"
    logits = np.full(30877, -30, dtype=np.float32)
    starts = np.cumsum([0] + [count for _, count in SPLITS[:-1]])
    logits[starts] = 0
    logits[1] = 2
    tags, raw = tagger._postprocess_one(logits)
    assert tags == [str(i) for i in starts[:4]]
    assert set(raw.values()) == {0.5}
    logits[0] = np.nan
    with pytest.raises(ValueError, match="logits"):
        tagger._postprocess_one(logits)


def test_unknown_graph_cannot_be_patched(tmp_path):
    graph = tmp_path / assets.GRAPH
    graph.write_bytes(b"other model")
    with pytest.raises(ValueError, match="Unexpected"):
        assets.directml_graph(graph)
    assert list(tmp_path.iterdir()) == [graph]
