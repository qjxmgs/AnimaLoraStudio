"""Face bitmap geometry, provenance replacement, and recoverable write semantics."""
import io
import json
import threading
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from studio.domain.errors import ConflictError
from studio.infrastructure import paths
from studio.services.preprocess import face_contour as face, head_apply, head_mask as hm
from studio.services.preprocess import mask_transaction as tx, masks
from studio.services.models import face_segmenter as model


def test_mask_decode_restores_non_square_crop_and_preserves_holes():
    proto = np.full((1, 1, 160, 160), -8, np.float32)
    proto[0, 0, 60:100, 40:120] = 8
    proto[0, 0, 70:80, 60:80] = -8
    rows = np.array([[[320], [320], [640], [320], [.9], [1]]], np.float32)
    faces = face.decode_masks([rows, proto], (320, 160), confidence=.25, iou_threshold=.7, threshold=.5)
    assert len(faces) == 1
    assert faces[0]['box'] == [0, 0, 320, 160]
    foreground = faces[0]['foreground']
    assert foreground.shape == (160, 320)
    assert foreground[100, 100]
    assert not foreground[65, 140]  # Preserve the occluder / hair gap.
    assert not foreground[0, 0]


def test_zero_invalid_and_duplicate_outputs():
    proto = np.ones((1, 1, 8, 8), np.float32)
    rows = np.array([[[320, 322], [320, 322], [80, 80], [80, 80], [.9, .8], [1, 1]]], np.float32)
    assert len(face.decode_masks([rows, proto], (640, 640), confidence=.25, iou_threshold=.7, threshold=.5)) == 1
    assert face.decode_masks([rows, proto], (640, 640), confidence=.95, iou_threshold=.7, threshold=.5) == []
    with pytest.raises(RuntimeError):
        face.decode_masks([rows], (10, 10), confidence=.25, iou_threshold=.7, threshold=.5)


def test_feather_is_inward_only():
    foreground = np.zeros((20, 30), bool)
    foreground[3:16, 5:24] = True
    foreground[7:9, 9:12] = False
    for radius in (0, 1, 3):
        weights = face.loss_weights(foreground, radius)
        assert (weights[~foreground] == 255).all()
        assert weights[12, 17] == 0
    assert 0 < face.loss_weights(foreground, 2)[3, 10] < 255


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, 'TASKS_DIR', tmp_path / 'tasks')
    train = tmp_path / 'train'
    (train / '1_data').mkdir(parents=True)
    image = train / '1_data/A.png'
    Image.new('RGB', (100, 80), 'white').save(image)
    manual = np.full((80, 100), 255, np.uint8)
    manual[65:70, 80:90] = 0
    Image.fromarray(manual).save(image.with_suffix('.mask'), 'PNG')
    proposal = hm.make_image_proposal('1_data/A.png', image, (100, 80),
        [{'score': .9, 'box': [10, 5, 70, 65]}], padding_ratio=.1, feather_ratio=0)
    hm.write_result(1, hm.new_result(1, confidence=.4, iou_threshold=.7,
        padding_ratio=.1, feather_ratio=0, provider='CPUExecutionProvider', images=[proposal]))
    hm.apply_proposals(1, train, {'1_data/A.png': [proposal['regions'][0]['id']]})
    old = json.loads(hm.apply_state_path(1).read_text())
    foreground = np.zeros((80, 100), bool)
    foreground[15:45, 25:55] = True
    foreground[15:22, 25:35] = False
    bitmap = face.save_bitmap(2, '1_data/A.png', 0, (0, 0), face.loss_weights(foreground))
    region = {'id': bitmap['id'], 'kind': 'bitmap', 'bitmap': bitmap, 'box': [25, 15, 55, 45], 'score': .9}
    new = {**proposal, 'regions': [region]}
    hm.write_result(2, hm.new_result(2, confidence=.4, iou_threshold=.7,
        padding_ratio=0, feather_ratio=0, provider='CPUExecutionProvider', images=[new]))
    return train, image, old, {'1_data/A.png': [bitmap['id']]}, region


def test_safe_replacement_restores_shoulder_and_preserves_manual_and_undo(env):
    train, image, old, selection, _ = env
    before = image.with_suffix('.mask').read_bytes()
    source = {'job_id': 1, 'apply_id': old['apply_id']}
    preview = head_apply.preview(2, train, selection, source)
    assert preview['images'][0]['restored_pixels'] > 0
    hm.apply_proposals(2, train, selection, replace_from=source)
    mask = np.array(Image.open(image.with_suffix('.mask')))
    assert mask[60, 40] == 255  # Shoulder formerly inside the rectangle.
    assert mask[30, 40] == 0
    assert mask[67, 85] == 0  # Manual strokes survived.
    with pytest.raises(ConflictError):
        hm.undo_apply(1, train)
    hm.undo_apply(2, train)
    assert image.with_suffix('.mask').read_bytes() == before
    assert head_apply.replacement_info(1, train)['images'][0]['eligible']


@pytest.mark.parametrize('mutation', ['manual', 'missing_backup', 'corrupt_backup', 'stale', 'wrong_apply', 'escaped_backup'])
def test_replacement_refuses_unsafe_source_without_writes(env, mutation):
    train, image, old, selection, _ = env
    source = {'job_id': 1, 'apply_id': old['apply_id']}
    backup = Path(old['backup_dir']) / old['records'][0]['backup_rel']
    if mutation == 'manual':
        Image.new('L', (100, 80), 180).save(image.with_suffix('.mask'), 'PNG')
    elif mutation == 'missing_backup':
        backup.unlink()
    elif mutation == 'corrupt_backup':
        backup.write_bytes(b'corrupt')
    elif mutation == 'stale':
        Image.new('RGB', (100, 80), 'red').save(image)
    elif mutation == 'escaped_backup':
        old['records'][0]['backup_rel'] = '../outside.before'
        hm.apply_state_path(1).write_text(json.dumps(old), encoding='utf-8')
    else:
        source['apply_id'] = 'wrong'
    before = image.with_suffix('.mask').read_bytes()
    with pytest.raises(ConflictError):
        hm.apply_proposals(2, train, selection, replace_from=source)
    assert image.with_suffix('.mask').read_bytes() == before


def test_empty_selection_and_noop_preserve_undo(env):
    train, image, old, selection, _ = env
    before = image.with_suffix('.mask').read_bytes()
    hm.apply_proposals(2, train, {'1_data/A.png': []}, replace_from={'job_id': 1, 'apply_id': old['apply_id']})
    assert image.with_suffix('.mask').read_bytes() == before
    original = hm.load_result(1)['images'][0]['regions'][0]['id']
    assert hm.apply_proposals(1, train, {'1_data/A.png': [original]})['applied'] == 0
    assert hm.undo_available(1)


def test_bitmap_integrity_and_path_guard(env):
    train, _, _, selection, region = env
    face.bitmap_path(2, region['bitmap']['id']).write_bytes(b'bad')
    with pytest.raises(ConflictError):
        hm.apply_proposals(2, train, selection)
    with pytest.raises(Exception):
        face.bitmap_path(2, '../outside')


def test_crash_between_replaces_recovers_batch(tmp_path, monkeypatch):
    a, b = tmp_path / 'a.mask', tmp_path / 'b.mask'
    a.write_bytes(b'old-a')
    b.write_bytes(b'old-b')
    real_replace = tx.os.replace
    count = 0
    def crash(src, dst):
        nonlocal count
        if str(dst).endswith('.mask'):
            count += 1
            if count == 2:
                raise KeyboardInterrupt('simulated process termination')
        return real_replace(src, dst)
    with tx.lock(tmp_path):
        monkeypatch.setattr(tx.os, 'replace', crash)
        with pytest.raises(KeyboardInterrupt):
            tx.commit(tmp_path, {a: b'new-a', b: b'new-b'})
    monkeypatch.setattr(tx.os, 'replace', real_replace)
    assert (tmp_path / tx.JOURNAL).exists()
    with tx.lock(tmp_path):
        assert a.read_bytes() == b'old-a'
        assert b.read_bytes() == b'old-b'
    assert not (tmp_path / tx.JOURNAL).exists()


def test_manual_save_waits_for_automatic_writer(tmp_path):
    entered, done = threading.Event(), threading.Event()
    output = io.BytesIO()
    Image.new('L', (10, 10), 120).save(output, 'PNG')
    def writer():
        entered.set()
        masks.write_mask(tmp_path, '1_data/A.png', output.getvalue(), expected_size=(10, 10))
        done.set()
    with tx.lock(tmp_path):
        thread = threading.Thread(target=writer)
        thread.start()
        assert entered.wait(2)
        assert not done.wait(.05)
    thread.join(3)
    assert done.is_set()


def test_model_status_checks_pinned_provenance_and_artifact(tmp_path):
    folder = model.model_dir(tmp_path)
    artifact = folder / 'abc123'
    artifact.mkdir(parents=True)
    output = artifact / 'model.onnx'
    output.write_bytes(b'test')
    manifest = {'artifact': 'abc123', 'revision': model.REVISION, 'source_sha256': model.SHA256,
                'export_version': model.EXPORT_VERSION, 'parity_passed': True, 'size': 4, 'sha256': model.digest(output)}
    (folder / 'ready.json').write_text(json.dumps(manifest))
    assert model.status(tmp_path)['valid']
    output.write_bytes(b'changed')
    assert not model.status(tmp_path)['valid']


@pytest.mark.parametrize('fail', [True, False])
def test_failed_or_empty_face_segmentation_never_emits_rectangle(tmp_path, monkeypatch, fail):
    monkeypatch.setattr(paths, 'TASKS_DIR', tmp_path / 'tasks')
    image = tmp_path / 'source.png'
    Image.new('RGB', (100, 100), 'white').save(image)
    segmenter = face.FaceSegmenter.__new__(face.FaceSegmenter)
    def run(_tensor):
        if fail:
            raise RuntimeError('injected inference failure')
        return [np.zeros((1, 6, 1), np.float32), np.zeros((1, 1, 8, 8), np.float32)]
    segmenter.run_outputs = run
    proposal = segmenter.propose(4, '1_data/source.png', image, [{'box': [10, 10, 60, 60], 'score': .9}])
    assert proposal['regions'] == []
    assert proposal['review_status'] == 'needs_review'
    assert proposal['issues'][0]['reason'] == ('segmentation_failed' if fail else 'no_face')


def test_face_cancellation_stops_between_heads(tmp_path):
    image = tmp_path / 'source.png'
    Image.new('RGB', (10, 10)).save(image)
    segmenter = face.FaceSegmenter.__new__(face.FaceSegmenter)
    with pytest.raises(InterruptedError):
        segmenter.propose(3, '1_data/source.png', image, [{'box': [1, 1, 9, 9], 'score': .9}], canceled=lambda: True)


def test_directml_face_inference_falls_back_to_cpu(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    calls = []
    class Session:
        def __init__(self, path, *, providers):
            self.providers = providers
            calls.append(providers)
        def get_inputs(self):
            return [SimpleNamespace(name='images')]
        def get_providers(self):
            return self.providers
        def run(self, outputs, inputs):
            if self.providers[0] == 'DmlExecutionProvider':
                raise RuntimeError('GPU failure')
            return [np.zeros((1, 6, 1)), np.zeros((1, 1, 8, 8))]
    monkeypatch.setitem(sys.modules, 'onnxruntime', SimpleNamespace(
        get_available_providers=lambda: ['DmlExecutionProvider', 'CPUExecutionProvider'], InferenceSession=Session))
    detector = face.FaceSegmenter(tmp_path / 'model.onnx')
    assert len(detector.run_outputs(np.zeros((1, 3, 640, 640), np.float32))) == 2
    assert calls == [['DmlExecutionProvider', 'CPUExecutionProvider'], ['CPUExecutionProvider']]


@pytest.mark.parametrize('download_ok', [True, False])
def test_preparation_failure_retains_ready_pointer_and_never_exports_unverified_source(tmp_path, monkeypatch, download_ok):
    from studio.infrastructure.task_log import NULL_LOG
    folder = model.model_dir(tmp_path)
    folder.mkdir(parents=True)
    pointer = folder / 'ready.json'
    pointer.write_bytes(b'previous manifest retained for recovery')
    called = []
    monkeypatch.setattr(model, '_run', lambda *args, **kwargs: called.append(args))
    def download(repo, filename, path, **kwargs):
        assert repo == model.REPO and kwargs['revision'] == model.REVISION
        path.write_bytes(b'damaged checkpoint')
        return download_ok
    monkeypatch.setattr(model.sources, 'download_flat', download)
    assert not model.prepare(tmp_path, on_log=NULL_LOG)
    assert not called
    assert pointer.read_bytes() == b'previous manifest retained for recovery'
