"""Background geometry, all seven combinations, partial outcomes and model integrity."""
import itertools
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from studio.infrastructure import paths
from studio.services.models import background_segmenter as model
from studio.services.preprocess import auto_mask, background_mask as bg, face_contour as face, head_mask as hm
from studio.services.preprocess import head_apply


def test_letterbox_restoration_preserves_non_square_coordinates():
    image = Image.new("RGB", (200, 100), (255, 128, 0))
    tensor, content = bg.prepare_input(image)
    assert tensor.shape == (1, 3, 1024, 1024)
    assert content == (0, 256, 1024, 512)
    assert np.all(tensor[0, :, 0] == 0)
    np.testing.assert_allclose(tensor[0, :, 500, 500], [1, 128 / 255, 0])
    output = np.zeros((1, 1, 1024, 1024), np.float32)
    output[:, :, 256:768, 256:768] = 1
    restored = bg.restore_probability(output, image.size, content)
    assert restored.shape == (100, 200)
    assert restored[:, 55:145].min() == 1
    assert restored[:, :45].max() == 0
    # Tall inputs and one-pixel dimensions use the same reversible mapping.
    for size in ((100, 200), (1, 200), (200, 1)):
        _, rectangle = bg.prepare_input(Image.new("RGB", size))
        assert bg.restore_probability(np.ones_like(output), size, rectangle).shape == (size[1], size[0])
    with pytest.raises(RuntimeError):
        bg.restore_probability(np.full_like(output, np.nan), image.size, content)


def test_background_preserves_multiple_figures_holes_and_foreground_edges():
    p = np.zeros((40, 60), np.float32)
    p[5:35, 5:25] = 1
    p[10:30, 40:55] = 1
    p[15:20, 12:17] = 0  # Hole between limbs remains background.
    plain, _ = bg.background_weights(p)
    assert plain[8, 8] == plain[15, 45] == 255
    assert plain[17, 14] == plain[0, 0] == 0
    protected, _ = bg.background_weights(p, protect_px=2)
    assert protected[5, 3] == 255 and protected[5, 2] == 0
    feathered, _ = bg.background_weights(p, feather_px=3)
    assert (feathered[p == 1] == 255).all()
    assert 0 < feathered[5, 4] < 255 and feathered[0, 0] == 0
    assert bg.background_weights(np.zeros_like(p)) == (None, "no_foreground")
    assert bg.background_weights(np.ones_like(p)) == (None, "no_background")
    p[0, 0] = .4
    assert bg.background_weights(p, threshold=.3)[0][0, 0] == 255


@pytest.fixture
def detector_env(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "TASKS_DIR", tmp_path / "tasks")
    image = tmp_path / "train" / "1_data" / "A.png"
    image.parent.mkdir(parents=True)
    Image.new("RGB", (60, 40), "white").save(image)
    model_file = tmp_path / "model.onnx"
    model_file.write_bytes(b"model")
    calls = {"head": 0, "background": 0}

    class Head:
        provider = "CPUExecutionProvider"

        def __init__(self, _path):
            pass

        def detect(self, path, **kwargs):
            calls["head"] += 1
            return (60, 40), [{"score": .9, "box": [20, 5, 40, 20]}]

    class Face(Head):
        def propose(self, job_id, name, path, heads, **kwargs):
            weights = np.full((40, 60), 255, np.uint8)
            weights[8:17, 23:37] = 0
            bitmap = face.save_bitmap(job_id, name, 0, (0, 0), weights)
            return {"regions": [{"id": bitmap["id"], "kind": "bitmap", "bitmap": bitmap, "score": .9}], "issues": []}

    class Background(Head):
        def propose(self, job_id, name, path, **kwargs):
            calls["background"] += 1
            weights = np.zeros((40, 60), np.uint8)
            weights[3:38, 18:42] = 255
            bitmap = face.save_bitmap(job_id, name, 0, (0, 0), weights, target="background")
            return [{"id": bitmap["id"], "kind": "bitmap", "bitmap": bitmap, "coverage": .65}], "ready"

    monkeypatch.setattr(auto_mask.models, "resolve_head_detector", lambda *_: ("builtin", model_file, True))
    monkeypatch.setattr(auto_mask.models, "head_detector_status", lambda: {"valid": True})
    monkeypatch.setattr(hm, "HeadDetector", Head)
    monkeypatch.setattr(auto_mask, "FaceSegmenter", Face)
    monkeypatch.setattr(auto_mask, "BackgroundSegmenter", Background)
    for module in (auto_mask.face_segmenter, model):
        monkeypatch.setattr(module, "target", lambda: model_file)
        monkeypatch.setattr(module, "status", lambda: {"valid": True, "sha256": "test"})
    return image, calls


TARGETS = ("face_contour", "head_box", "background")
COMBINATIONS = [list(c) for n in range(1, 4) for c in itertools.combinations(TARGETS, n)]


def params(targets):
    return {"mask_targets": targets, "model": "builtin", "confidence": .413,
            "iou_threshold": .7, "padding_ratio": .1, "feather_ratio": .03}


@pytest.mark.parametrize("targets", COMBINATIONS)
def test_all_combinations_share_heads_and_merge_order_independently(detector_env, targets):
    image, calls = detector_env
    detector = auto_mask.MultiTargetDetector(params(targets))
    result = detector.propose(1, image.name, image, lambda: False)
    assert calls["head"] == int(any(t != "background" for t in targets))
    assert calls["background"] == int("background" in targets)
    assert {r["target"] for r in result["regions"]} == set(targets)
    assert len({r["id"] for r in result["regions"]}) == len(targets)
    assert result["review_status"] == "ready"
    weights = hm.render_auto_mask((60, 40), result["regions"], job_id=1)
    np.testing.assert_array_equal(weights, hm.render_auto_mask((60, 40), reversed(result["regions"]), job_id=1))
    if "background" in targets:
        assert weights[0, 0] == 0 and weights[30, 30] == 255
    if "face_contour" in targets:
        assert weights[10, 30] == 0


def test_failed_head_does_not_block_background(detector_env, monkeypatch):
    image, calls = detector_env
    def fail(*args, **kwargs):
        raise RuntimeError("head unavailable")
    monkeypatch.setattr(auto_mask.models, "resolve_head_detector", fail)
    detector = auto_mask.MultiTargetDetector(params(list(TARGETS)))
    proposal = detector.propose(1, image.name, image, lambda: False)
    assert [r["target"] for r in proposal["regions"]] == ["background"]
    assert proposal["target_statuses"]["face_contour"]["status"] == "failed"
    assert proposal["review_status"] == "needs_review" and proposal["status"] == "done"
    assert calls["background"] == 1


def test_failed_background_preserves_face(detector_env, monkeypatch):
    image, _ = detector_env
    def fail(*args):
        raise RuntimeError("background unavailable")
    monkeypatch.setattr(auto_mask, "BackgroundSegmenter", fail)
    proposal = auto_mask.MultiTargetDetector(params(["face_contour", "background"])).propose(1, image.name, image, lambda: False)
    assert [r["target"] for r in proposal["regions"]] == ["face_contour"]
    assert proposal["target_statuses"]["background"]["status"] == "failed"


def test_apply_replace_undo_combination_preserves_manual_mask(detector_env):
    image, _ = detector_env
    name = "1_data/A.png"
    train_dir = image.parent.parent
    manual = np.full((40, 60), 255, np.uint8)
    manual[25, 30] = 0
    Image.fromarray(manual).save(image.with_suffix('.mask'), 'PNG')
    for job_id, targets in [(1, ["head_box"]), (2, ["face_contour", "background"])]:
        proposal = auto_mask.MultiTargetDetector(params(targets)).propose(job_id, name, image, lambda: False)
        hm.write_result(job_id, {"schema_version": 3, "images": [proposal], "parameters": params(targets)})
        selection = {name: [r['id'] for r in proposal['regions']]}
        if job_id == 1:
            hm.apply_proposals(job_id, train_dir, selection)
            import json
            old = json.loads(hm.apply_state_path(1).read_text())
            before = image.with_suffix('.mask').read_bytes()
        else:
            source = {"job_id": 1, "apply_id": old['apply_id']}
            preview = head_apply.preview(job_id, train_dir, selection, source)
            assert preview['images'][0]['restored_pixels'] > 0
            hm.apply_proposals(job_id, train_dir, selection, replace_from=source)
    final = np.array(Image.open(image.with_suffix('.mask')))
    assert final[25, 30] == 0 and final[0, 0] == 0 and final[10, 30] == 0
    assert final[20, 30] == 255
    hm.undo_apply(2, train_dir)
    assert image.with_suffix('.mask').read_bytes() == before


def test_background_model_integrity_download_and_cache(tmp_path, monkeypatch):
    import hashlib
    from studio.services.models.downloader import _DEFAULT_LOG
    monkeypatch.setattr(model, 'SIZE', 4)
    monkeypatch.setattr(model, 'SHA256', hashlib.sha256(b'good').hexdigest())
    received = []
    def download(repo, filename, target, **kwargs):
        received.append(kwargs['revision'])
        assert target.parent != model.model_path(tmp_path).parent
        target.write_bytes(b'bad!')
        return True
    monkeypatch.setattr(model.sources, 'download_flat', download)
    assert not model.download(tmp_path, on_log=_DEFAULT_LOG)
    assert not model.model_path(tmp_path).exists()
    path = model.model_path(tmp_path)
    path.write_bytes(b'good')
    assert model.status(tmp_path)['valid']
    path.write_bytes(b'evil')
    assert not model.status(tmp_path, force_verify=True)['valid']
    with pytest.raises(RuntimeError):
        model.target(tmp_path)
    assert received == [model.REVISION]

    def good_download(repo, filename, target, **kwargs):
        target.write_bytes(b'good')
        assert path.read_bytes() == b'evil'  # Publication happens only after validation.
        return True
    monkeypatch.setattr(model.sources, 'download_flat', good_download)
    assert model.download(tmp_path, on_log=_DEFAULT_LOG)
    assert model.target(tmp_path).read_bytes() == b'good'
    assert list(path.parent.iterdir()) == [path]
