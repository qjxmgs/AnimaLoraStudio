import json
import time

import pytest
from fastapi.testclient import TestClient

from studio.infrastructure import tag_topics as catalog
from studio.domain.errors import ValidationError
from studio.server import app


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog.paths, 'STUDIO_DATA', tmp_path)
    monkeypatch.setattr(catalog, 'dictionary_context', lambda: ({}, {}))
    monkeypatch.setattr(catalog.tag_dictionary, 'ACTIVE_JSON', tmp_path / 'active.json')


def test_seed_integrity_and_examples():
    snap = catalog.snapshot()
    assert sum(t['kind'] == 'topic' for t in snap['topics']) >= 100
    assert len(snap['entries']) >= 600
    catalog.validate_topics(snap['topics'])
    for rule in snap['rules']:
        for tag in rule['positive']:
            assert catalog.match(tag, snap)['topic'] == rule['topic']
        for tag in rule['negative']:
            assert catalog.match(tag, snap).get('topic') != rule['topic']
    for tag in ('breast', 'breasts', 'chest', 'large_breasts', 'FLAT CHEST'):
        assert catalog.match(tag, snap)['group'] == 'chest'
    assert catalog.match('chest tattoo', snap)['topic'] == 'tattoos'
    assert catalog.match('chest harness', snap)['topic'] == 'harness'
    assert catalog.match('hand on chest', snap)['rank'] == 5
    assert catalog.match('chestnut', snap)['source'] == 'unknown'
    assert catalog.match('chest', snap, {'chest': 4})['rank'] == 1


def test_overrides_restore_and_seed_upgrade(tmp_path, monkeypatch):
    catalog.save_entry({'tag': 'breast', 'excluded': True})
    assert catalog.match('breast', catalog.snapshot())['reason'] == 'excluded'
    original = json.loads(catalog.SEED.read_text(encoding='utf8'))
    original['version'] += 1
    seed = tmp_path / 'next.json'; seed.write_text(json.dumps(original), encoding='utf8')
    monkeypatch.setattr(catalog, 'SEED', seed)
    assert catalog.snapshot()['version'] == original['version']
    assert catalog.match('breast', catalog.snapshot())['reason'] == 'excluded'
    catalog.restore('BREAST')
    assert catalog.match('breast', catalog.snapshot())['topic'] == 'chest'


def test_custom_topics_validation_and_import_atomicity():
    topic = {'id': 'user:example', 'name': 'example', 'zh': '示例', 'rank': 3, 'parent': 'family:body', 'group': 'user:example', 'kind': 'topic'}
    catalog.save_topic(topic)
    entry = {'tag': 'new tag', 'topic': topic['id'], 'relation': 'related', 'note': 'user'}
    catalog.save_entry(entry)
    exported = catalog.export_users()
    assert len(exported['topics']) == 1 and len(exported['entries']) == 1
    exported['entries'][0]['topic'] = 'chest'
    preview = catalog.import_users(exported)
    assert len(preview['conflicts']) == 2
    assert catalog.match('new tag', catalog.snapshot())['topic'] == topic['id']
    catalog.import_users(exported, apply=True)
    assert catalog.match('new tag', catalog.snapshot())['topic'] == topic['id']
    catalog.import_users(exported, overwrite=True, apply=True)
    assert catalog.match('new tag', catalog.snapshot())['topic'] == 'chest'
    revision = catalog.snapshot()['revision']
    exported['entries'].append({'tag': 'invalid', 'topic': 'missing', 'relation': 'related'})
    with pytest.raises(ValidationError): catalog.import_users(exported, overwrite=True, apply=True)
    assert catalog.snapshot()['revision'] == revision
    with pytest.raises(ValidationError): catalog.save_topic({**topic, 'parent': topic['id']})
    with pytest.raises(ValidationError): catalog.save_topic({**topic, 'rank': 7})


def test_search_chinese_candidates_and_pagination(monkeypatch):
    dictionary = {f'candidate {i:05d}': ['待归类示例'] for i in range(10000)}
    dictionary['breasts'] = ['胸部']
    monkeypatch.setattr(catalog, 'dictionary_context', lambda: (dictionary, {}))
    started = time.perf_counter()
    first = catalog.search(q='待归类', status='unmapped', limit=20)
    elapsed = time.perf_counter() - started
    assert first['total'] == 10000
    assert len(first['items']) == 20
    second = catalog.search(q='待归类', offset=20, limit=20)
    assert not set(i['tag'] for i in first['items']) & set(i['tag'] for i in second['items'])
    assert any(i['tag'] == 'breasts' for i in catalog.search(q='胸部')['items'])
    assert any(i['tag'] == 'chest' for i in catalog.search(q='breast')['items'])
    assert catalog.search(topic='family:body')['total'] > 10
    assert catalog.search(q='身体体态')['total'] > 10
    print(f'10k Chinese candidate query: {elapsed:.3f}s')


def test_api_validation_and_persistence():
    client = TestClient(app)
    assert client.get('/api/tag-topics/snapshot').status_code == 200
    assert client.put('/api/tag-topics/entries', json={'tag': 'custom', 'topic': 'missing'}).status_code == 422
    assert client.put('/api/tag-topics/entries', json={'tag': 'custom', 'topic': 'chest'}).status_code == 200
    assert client.post('/api/tag-topics/explain', json={'tags': ['custom']}).json()['items'][0]['topic'] == 'chest'
    # A fresh connection reads the same on-disk data.
    assert catalog.snapshot()['entries']['custom']['source'] == 'user'
    assert client.get('/api/tag-topics/entries?limit=999').status_code == 422
    assert client.post('/api/tag-topics/import', json={'format': 9, 'topics': [], 'entries': []}).status_code == 422
    assert client.delete('/api/tag-topics/entries?tag=custom').status_code == 200


def test_seed_upgrade_failure_keeps_previous_database(tmp_path, monkeypatch):
    catalog.save_entry({'tag': 'custom', 'topic': 'chest', 'relation': 'related'})
    old = catalog.snapshot()
    data = json.loads(catalog.SEED.read_text(encoding='utf8')); data['version'] += 1
    data['topics'][0]['parent'] = 'missing'
    seed = tmp_path / 'invalid.json'; seed.write_text(json.dumps(data), encoding='utf8')
    with monkeypatch.context() as patch:
        patch.setattr(catalog, 'SEED', seed)
        with pytest.raises(ValidationError): catalog.snapshot()
    assert catalog.snapshot() == old
