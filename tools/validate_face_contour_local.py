"""Opt-in real-model acceptance on isolated copies. Never starts training.

python -m tools.validate_face_contour_local setup --project 2 --version 2 --output tmp/face-contour-acceptance
python -m tools.validate_face_contour_local run --output tmp/face-contour-acceptance
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw

from studio import db
from studio.infrastructure import paths
from studio.infrastructure.task_log import TaskLog
from studio.services.projects import projects, versions, jobs
from studio.services.preprocess import core, head_mask as hm, head_apply, masks
from studio.services.models.paths import models_root

log = logging.getLogger(__name__)


def inventory(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def setup(output: Path, pid: int, vid: int) -> None:
    with db.connection_for() as conn:
        project = projects.get_project(conn, pid)
        version = versions.get_version(conn, vid)
        if not project or not version or version['project_id'] != pid:
            raise ValueError('Project/version mismatch')
        source = core.version_train_dir(project, version['label']).resolve()
        if output == source or output.is_relative_to(source) or source.is_relative_to(output):
            raise ValueError('Acceptance directory must be separate from source data')
        output.mkdir(parents=True, exist_ok=False)
        data = output / 'studio_data'
        data.mkdir()
        with db.connection_for(data / 'studio.db') as target:
            conn.backup(target)
        prior_jobs = jobs.list_jobs(conn, project_id=pid, version_id=vid, kind='preprocess')
    train_rel = source.relative_to(paths.STUDIO_DATA)
    train = data / train_rel
    shutil.copytree(source, train)
    original = inventory(source)
    # Fixture DB cannot run any copied active task when opened by the real server.
    with db.connection_for(data / 'studio.db') as conn:
        conn.execute("UPDATE tasks SET status='canceled' WHERE status IN ('pending','running','paused')")
        conn.commit()
    for job in prior_jobs:
        old_root = paths.task_dir(job['id']) / 'head-mask'
        if not old_root.is_dir():
            continue
        new_root = data / 'tasks' / str(job['id']) / 'head-mask'
        shutil.copytree(old_root, new_root)
        state_path = new_root / 'apply.json'
        if state_path.is_file():
            state = json.loads(state_path.read_text(encoding='utf-8'))
            state['backup_dir'] = str(new_root / 'undo' / state['apply_id'])
            state_path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    (data / 'secrets.json').write_text(json.dumps({'models': {'root': str(models_root())}}), encoding='utf-8')
    (output / 'fixture.json').write_text(json.dumps({'source': str(source), 'train_rel': str(train_rel),
        'project': project, 'version': version, 'before': original}, ensure_ascii=False, indent=2), encoding='utf-8')
    log.info('Created isolated acceptance fixture: %s', data)


def run(output: Path) -> None:
    from studio.workers import preprocess_worker
    fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
    data = output / 'studio_data'
    train = data / fixture['train_rel']
    assert train.resolve().is_relative_to(output.resolve())
    paths.TASKS_DIR = data / 'tasks'
    projects.PROJECTS_DIR = data / 'projects'
    db.STUDIO_DB = data / 'studio.db'
    project, version = fixture['project'], fixture['version']
    with db.connection_for() as conn:
        job = core.start_head_mask_job_train(conn, project_id=project['id'], version_id=version['id'],
            confidence=.413, iou_threshold=.7, padding_ratio=0, feather_ratio=0, mask_mode='face_contour')
    rc = preprocess_worker._run_head_mask_train(job['id'], project, version, job['params_decoded'],
                                               TaskLog(log), lambda *args, **kwargs: None)
    with db.connection_for() as conn:
        if rc:
            jobs.mark_failed(conn, job['id'], 'Local acceptance detection failed')
            raise RuntimeError('Real face detection failed')
        jobs.mark_done(conn, job['id'])
    result = hm.load_result(job['id'])
    from studio.services.preprocess.face_contour import FaceSegmenter, decode_masks
    segmenter = FaceSegmenter()
    probe = next(i for i in result['images'] if i['regions'])
    region = probe['regions'][0]['mask_region']
    with Image.open(train / probe['name']) as raw:
        crop = raw.convert('RGB').crop((region['x1'], region['y1'], region['x2'], region['y2']))
    tensor, _, _, _ = hm._letterbox(crop)
    provider = segmenter.provider
    accelerated = segmenter.run_outputs(tensor)
    segmenter._create_session(cpu_only=True)
    cpu = segmenter.run_outputs(tensor)
    for actual, reference in zip(accelerated, cpu, strict=True):
        np.testing.assert_allclose(actual, reference, rtol=2e-3, atol=2e-3)
    decoded = [decode_masks(outputs, crop.size, confidence=.25, iou_threshold=.7, threshold=.5)
               for outputs in (accelerated, cpu)]
    assert len(decoded[0]) == len(decoded[1])
    mask_agreement = [float(np.mean(a['foreground'] == b['foreground']))
                      for a, b in zip(*decoded, strict=True)]
    source = Path(fixture['source'])
    summaries = []
    # Contact sheets show head crops only, with old rectangle and new face mask.
    panels = []
    for index, item in enumerate(result['images']):
        if item.get('error'):
            summaries.append({'name': item['name'], 'error': item['error']})
            continue
        new = hm.render_auto_mask(tuple(item['size']), item['regions'], job_id=job['id'])
        old = hm._load_existing_mask(masks.mask_path_for(train, item['name']), tuple(item['size']))
        summaries.append({'name': item['name'], 'faces': len(item['regions']), 'review_status': item['review_status'],
                          'old_ignored_pixels': int(np.count_nonzero(old < 255)),
                          'new_ignored_pixels': int(np.count_nonzero(new < 255)), 'issues': item['issues']})
        with Image.open(train / item['name']) as raw:
            rgb = np.array(raw.convert('RGB'))
        if not item['regions']:
            continue
        # Use the first face's head crop; multi-face counts are kept in the report.
        region = item['regions'][0]['mask_region']
        bounds = (region['x1'], region['y1'], region['x2'], region['y2'])
        tile = Image.new('RGB', (400, 224), '#20242b')
        draw = ImageDraw.Draw(tile)
        draw.text((4, 4), f"{index+1}: old / face ({len(item['regions'])})", fill='white')
        for column, weights in enumerate((old, new)):
            alpha = (1-weights[..., None]/255) * .55
            tinted = (rgb * (1-alpha) + np.array([255, 160, 0]) * alpha).astype(np.uint8)
            preview = Image.fromarray(tinted).crop(bounds)
            preview.thumbnail((198, 198))
            tile.paste(preview, (column*200, 24))
        panels.append(tile)
    for page in range((len(panels)+7)//8):
        sheet = Image.new('RGB', (800, 896), '#20242b')
        for i, tile in enumerate(panels[page*8:(page+1)*8]):
            sheet.paste(tile, ((i%2)*400, (i//2)*224))
        sheet.save(output / f'comparison-{page+1}.png')
    with db.connection_for() as conn:
        candidates = [j for j in jobs.list_jobs(conn, project_id=project['id'], version_id=version['id'], kind='preprocess')
                      if j['id'] != job['id']]
    prior = next((info for j in candidates if (info := head_apply.replacement_info(j['id'], train))
                  and any(i['eligible'] for i in info['images'])), None)
    if not prior:
        raise RuntimeError('No verifiable previous automatic application in the fixture')
    eligible = {i['name'] for i in prior['images'] if i['eligible']}
    selection = {i['name']: [r['id'] for r in i['regions']] for i in result['images'] if i['name'] in eligible and i['regions']}
    replacement = {'job_id': prior['job_id'], 'apply_id': prior['apply_id']}
    first = next(iter(selection))
    canceled = {name: list(ids) for name, ids in selection.items()}
    canceled[first] = canceled[first][1:]
    first_path = masks.mask_path_for(train, first)
    before_cancel = first_path.read_bytes()
    applied = hm.apply_proposals(job['id'], train, canceled, replace_from=replacement)
    if not canceled[first]:
        assert first_path.read_bytes() == before_cancel
    hm.undo_apply(job['id'], train)
    final = hm.apply_proposals(job['id'], train, selection, replace_from=replacement)
    manual = Image.open(first_path).copy()
    manual.putpixel((0, manual.height-1), 255 - manual.getpixel((0, manual.height-1)))
    buf = io.BytesIO()
    manual.save(buf, 'PNG')
    masks.write_mask(train, first, buf.getvalue(), expected_size=manual.size)
    from studio.domain.errors import ConflictError
    try:
        hm.undo_apply(job['id'], train)
    except ConflictError:
        guarded = True
    else:
        raise AssertionError('Undo overwrote a manual edit')
    from runtime.training.dataset import ImageDataset, BucketManager
    dataset = ImageDataset(train, 256, BucketManager(256, min_reso=256, max_reso=256, step=64), load_masks=True)
    loaded_masks = 0
    for index in range(len(dataset)):
        sample = dataset.get_with_flip(index, flip=False)
        expected = dataset._mask_path_for(dataset.samples[index]['image']).is_file()
        assert (sample['mask'] is not None) == expected
        if expected:
            assert sample['mask'].min() >= 0 and sample['mask'].max() <= 1
            loaded_masks += 1
    unchanged = inventory(source) == fixture['before']
    assert unchanged, 'Original dataset changed during acceptance'
    report = {'job_id': job['id'], 'original_unchanged': unchanged, 'images': summaries,
              'canceled_apply_count': applied['applied'], 'replacement_count': final['applied'],
              'manual_undo_guard': guarded, 'training_loader_samples': len(dataset),
              'training_loader_masks': loaded_masks, 'inference_provider': provider,
              'cpu_provider_output_parity': True, 'cpu_provider_mask_agreement': mask_agreement}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    log.info('Acceptance complete: %d images; %d replacements; source unchanged', len(summaries), final['applied'])


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['setup', 'run'])
    parser.add_argument('--project', type=int)
    parser.add_argument('--version', type=int)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'setup':
        if not args.project or not args.version:
            parser.error('setup requires --project and --version')
        setup(args.output.resolve(), args.project, args.version)
    else:
        run(args.output.resolve())
