"""Offline semantic catalog. Builtins are versioned; user overrides are independent."""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

from . import paths, tag_dictionary
from ..domain.errors import ValidationError

SEED = Path(__file__).resolve().parents[1] / 'data' / 'tag_topics.json'
_lock = RLock()


def normalize(value: str) -> str:
    return ' '.join(value.strip().lower().replace('_', ' ').split())


def invalid(message: str):
    raise ValidationError(message, code='tag_topics.invalid')


def validate_topics(topics: list[dict]):
    by_id = {t['id']: t for t in topics}
    if len(by_id) != len(topics): invalid('Duplicate topic ID')
    for topic in topics:
        if not re.fullmatch(r'[a-z0-9:-]{1,100}', topic['id']): invalid('Invalid topic ID')
        if topic.get('rank') not in range(2, 9): invalid('Invalid category')
        if topic.get('kind') not in ('topic', 'family'): invalid('Invalid topic kind')
        if not topic.get('name') or not topic.get('zh') or not topic.get('group'): invalid('Missing topic names or group')
        visited = {topic['id']}
        parent = topic.get('parent')
        while parent:
            if parent in visited or parent not in by_id: invalid('Invalid or cyclic parent')
            visited.add(parent)
            ancestor = by_id[parent]
            if ancestor['rank'] != topic['rank']: invalid('Parent category mismatch')
            parent = ancestor.get('parent')
    groups = {}
    for topic in topics:
        rank = groups.setdefault(topic['group'], topic['rank'])
        if rank != topic['rank']: invalid('Group crosses category boundaries')


def validate_entry(entry: dict, topics: dict):
    tag = entry.get('tag')
    if not isinstance(tag, str) or not normalize(tag) or len(tag) > 300: invalid('Invalid tag')
    if entry.get('excluded'):
        return
    if entry.get('topic') not in topics or topics[entry['topic']]['kind'] != 'topic': invalid('Unknown topic')
    if entry.get('relation') not in ('base', 'variant', 'related', 'modifier', 'exception'): invalid('Invalid relation')


@contextmanager
def database():
    path = paths.STUDIO_DATA / 'tag_dictionary' / 'semantic.sqlite'
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS builtin_topics(id TEXT PRIMARY KEY,data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS builtin_entries(tag TEXT PRIMARY KEY,data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS user_topics(id TEXT PRIMARY KEY,data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS overrides(tag TEXT PRIMARY KEY,data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS candidates(tag TEXT PRIMARY KEY,display TEXT NOT NULL,zh TEXT NOT NULL);
            ''')
            seed = json.loads(SEED.read_text(encoding='utf8'))
            current = conn.execute("SELECT value FROM meta WHERE key='seed_version'").fetchone()
            if current is None or current[0] != str(seed['version']):
                validate_topics(seed['topics'])
                topics = {t['id']: t for t in seed['topics']}
                seen = set()
                for entry in seed['entries']:
                    validate_entry(entry, topics)
                    key = normalize(entry['tag'])
                    if key in seen: invalid('Duplicate normalized seed tag')
                    seen.add(key)
                rule_ids = set()
                for rule in seed['rules']:
                    if rule['id'] in rule_ids or rule['topic'] not in topics or rule['kind'] != 'modifier':
                        invalid('Invalid builtin rule')
                    rule_ids.add(rule['id'])
                    for field in ('heads', 'modifiers', 'positive', 'negative'):
                        if not rule.get(field) or not all(isinstance(v, str) and v.strip() for v in rule[field]):
                            invalid('Missing rule vocabulary or examples')
                for rule in seed['fallback']:
                    re.compile(rule['pattern'], re.ASCII)
                # Validate the merged taxonomy before replacing builtin rows.
                users = [json.loads(r[0]) for r in conn.execute('SELECT data FROM user_topics')]
                validate_topics(seed['topics'] + users)
                merged = {**topics, **{t['id']: t for t in users}}
                for row in conn.execute('SELECT data FROM overrides'):
                    validate_entry(json.loads(row[0]), merged)
                with conn:
                    conn.execute('DELETE FROM builtin_topics')
                    conn.execute('DELETE FROM builtin_entries')
                    conn.executemany('INSERT INTO builtin_topics VALUES (?,?)', [(t['id'], json.dumps(t)) for t in seed['topics']])
                    conn.executemany('INSERT INTO builtin_entries VALUES (?,?)', [(normalize(e['tag']), json.dumps(e)) for e in seed['entries']])
                    for key, value in [('schema_version', '1'), ('seed_version', str(seed['version'])), ('rules', json.dumps(seed['rules'])), ('fallback', json.dumps(seed['fallback']))]:
                        conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, value))
                    bump(conn)
            yield conn
        finally:
            conn.close()


def bump(conn):
    conn.execute("INSERT INTO meta VALUES ('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1")


def snapshot_from(conn):
    topics = [dict(json.loads(row[0]), source=source) for table, source in [('builtin_topics', 'builtin'), ('user_topics', 'user')] for row in conn.execute(f'SELECT data FROM {table}')]
    entries = {}
    for table, source in [('builtin_entries', 'builtin'), ('overrides', 'user')]:
        for row in conn.execute(f'SELECT tag,data FROM {table}'):
            entries[row[0]] = dict(json.loads(row[1]), source=source)
    meta = dict(conn.execute('SELECT key,value FROM meta'))
    return {'revision': int(meta['revision']), 'version': int(meta['seed_version']), 'topics': topics,
            'entries': entries, 'rules': json.loads(meta['rules']), 'fallback': json.loads(meta['fallback'])}


def snapshot():
    with database() as conn:
        return snapshot_from(conn)


def prepare(snap):
    return {
        'topics': {topic['id']: topic for topic in snap['topics']},
        'rules': {f'{modifier} {head}': rule for rule in reversed(snap['rules'])
                  for head in rule['heads'] for modifier in rule['modifiers']},
        'fallback': [(rule['rank'], re.compile(rule['pattern'], re.ASCII)) for rule in snap['fallback']],
    }


def match(tag: str, snap: dict, identities=None, index=None):
    index = index or prepare(snap)
    key = normalize(tag)
    category = (identities or {}).get(key)
    if category in (3, 4):
        return dict(tag=tag, rank=category-3, group=key, base=True, source='identity', reason='identity')
    entry = snap['entries'].get(key)
    if entry and entry.get('excluded'):
        return dict(tag=tag, source='user', reason='excluded')
    topic_id = entry.get('topic') if entry else None
    rule_id = None
    if not entry:
        rule = index['rules'].get(key)
        if rule:
            topic_id, rule_id = rule['topic'], rule['id']
    if topic_id:
        topic = index['topics'][topic_id]
        return dict(tag=tag, topic=topic_id, rank=topic['rank'], group=topic['group'], base=bool(entry and entry.get('base')),
                    source=entry['source'] if entry else 'rule', reason=entry.get('relation', 'related') if entry else rule_id)
    for rank, pattern in index['fallback']:
        if not pattern.search(key): continue
        group = key
        if rank == 3 and re.search(r'\b(?:hair|bangs|ahoge|ponytail|twintails|braids?|buns?)\b', key): group = 'hair'
        elif rank == 3 and (re.search(r'\b(?:eyes|pupils|eyelashes|eyebrows|heterochromia)\b', key) or key == 'ring light reflection'): group = 'eyes'
        elif rank == 4 and re.search(r'\b(?:hair (?:flower|ornament|ribbon|bow|clip|scrunchie|band)|hairclip|hairband|hairpin)\b', key): group = 'hair accessories'
        elif rank in (3, 4, 7): group = list(pattern.finditer(key))[-1].group()
        return dict(tag=tag, rank=rank, group=group, base=key == group, source='fallback', reason='legacy')
    return dict(tag=tag, source='unknown', reason='unknown')


def dictionary_context():
    loaded = tag_dictionary.load_active()
    if not loaded: return {}, {}
    entries, meta = loaded
    return entries, {normalize(k): v for k, v in tag_dictionary.get_identity_categories(entries, meta).items()}


def explain(tags):
    snap = snapshot()
    _, identities = dictionary_context()
    index = prepare(snap)
    return {'revision': snap['revision'], 'items': [match(tag, snap, identities, index) for tag in tags]}


def search(q='', topic='', rank=None, source='', status='', offset=0, limit=50):
    # The installed dictionary is candidate material only. Never download here.
    with database() as conn:
        snap = snapshot_from(conn)
        index = prepare(snap)
        dictionary, identities = dictionary_context()
        stamp = str(tag_dictionary.ACTIVE_JSON.stat().st_mtime_ns) if tag_dictionary.ACTIVE_JSON.exists() else 'none'
        old = conn.execute("SELECT value FROM meta WHERE key='dictionary_stamp'").fetchone()
        if not old or old[0] != stamp:
            with conn:
                conn.execute('DELETE FROM candidates')
                conn.executemany('INSERT OR REPLACE INTO candidates VALUES (?,?,?)', [(normalize(k), k, ' '.join(v)) for k, v in dictionary.items()])
                conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('dictionary_stamp', stamp))
        topic_map = {t['id']: t for t in snap['topics']}
        allowed = {topic} if topic else set(topic_map)
        if topic:
            for _ in range(len(topic_map)):
                children = {t['id'] for t in snap['topics'] if t.get('parent') in allowed}
                if children <= allowed: break
                allowed |= children
        query = normalize(q)
        topic_hits = {t['id'] for t in snap['topics'] if query and (query in t['name'].lower() or query in t['zh'])}
        exact = snap['entries'].get(query)
        if exact and not exact.get('excluded') and exact.get('topic'):
            topic_hits.add(exact['topic'])
        for _ in range(len(topic_map)):
            children = {t['id'] for t in snap['topics'] if t.get('parent') in topic_hits}
            if children <= topic_hits: break
            topic_hits |= children
        records = {r['tag']: {'tag': r['display'], 'zh': r['zh']} for r in conn.execute('SELECT * FROM candidates')}
        for key, entry in snap['entries'].items():
            records.setdefault(key, {'tag': entry['tag'], 'zh': ''})
        results = []
        for key, record in records.items():
            entry = snap['entries'].get(key)
            text_hit = not query or query in key or query in record['zh']
            if not text_hit and not topic_hits: continue
            result = match(record['tag'], snap, identities, index)
            if not text_hit and result.get('topic') not in topic_hits: continue
            mapped = result.get('topic') is not None
            if topic and result.get('topic') not in allowed: continue
            if rank is not None and result.get('rank') != rank: continue
            if source and result['source'] != source: continue
            if status == 'mapped' and not mapped: continue
            if status == 'unmapped' and mapped: continue
            results.append({**record, **result, 'entry': entry})
        results.sort(key=lambda r: (normalize(r['tag']) != query, normalize(r['tag'])))
        return {'items': results[offset:offset+limit], 'total': len(results), 'revision': snap['revision']}


def save_entry(entry):
    with database() as conn:
        snap = snapshot_from(conn)
        validate_entry(entry, {t['id']: t for t in snap['topics']})
        with conn:
            conn.execute('INSERT OR REPLACE INTO overrides VALUES (?,?)', (normalize(entry['tag']), json.dumps(entry)))
            bump(conn)
    return snapshot()


def restore(tag):
    with database() as conn, conn:
        conn.execute('DELETE FROM overrides WHERE tag=?', (normalize(tag),))
        bump(conn)
    return snapshot()


def save_topic(topic):
    with database() as conn:
        snap = snapshot_from(conn)
        if any(t['id'] == topic['id'] and t['source'] == 'builtin' for t in snap['topics']): invalid('Builtin topics cannot be replaced')
        if not re.fullmatch(r'user:[a-z0-9][a-z0-9:-]*', topic['id']): invalid('Custom topic IDs must start with user: followed by a name')
        validate_topics([t for t in snap['topics'] if t['id'] != topic['id']] + [topic])
        with conn:
            conn.execute('INSERT OR REPLACE INTO user_topics VALUES (?,?)', (topic['id'], json.dumps(topic)))
            bump(conn)
    return snapshot()


def export_users():
    with database() as conn:
        return {'format': 1, 'topics': [json.loads(r[0]) for r in conn.execute('SELECT data FROM user_topics')],
                'entries': [json.loads(r[0]) for r in conn.execute('SELECT data FROM overrides')]}


def import_users(data, overwrite=False, apply=False):
    if data.get('format') != 1 or not isinstance(data.get('topics'), list) or not isinstance(data.get('entries'), list): invalid('Invalid import format')
    with database() as conn:
        snap = snapshot_from(conn)
        current_topics = {t['id']: t for t in snap['topics']}
        current_entries = {r[0]: json.loads(r[1]) for r in conn.execute('SELECT tag,data FROM overrides')}
        conflicts, changes, topic_updates, entry_updates = [], [], {}, {}
        for topic in data['topics']:
            id = topic.get('id', '')
            if not re.fullmatch(r'user:[a-z0-9][a-z0-9:-]*', id) or id in topic_updates: invalid('Invalid or duplicate custom topic')
            if id in current_topics:
                conflicts.append({'type': 'topic', 'key': id, 'local': current_topics[id], 'incoming': topic})
            else: changes.append({'type': 'topic', 'key': id})
            topic_updates[id] = topic
        effective = {**current_topics, **{k: v for k, v in topic_updates.items() if overwrite or k not in current_topics}}
        validate_topics(list(effective.values()))
        for entry in data['entries']:
            validate_entry(entry, effective)
            key = normalize(entry['tag'])
            if key in entry_updates: invalid('Duplicate import tag')
            if key in current_entries:
                conflicts.append({'type': 'tag', 'key': key, 'local': current_entries[key], 'incoming': entry})
            else: changes.append({'type': 'tag', 'key': key})
            entry_updates[key] = entry
        if apply:
            with conn:
                for key, value in topic_updates.items():
                    if overwrite or key not in current_topics: conn.execute('INSERT OR REPLACE INTO user_topics VALUES (?,?)', (key, json.dumps(value)))
                for key, value in entry_updates.items():
                    if overwrite or key not in current_entries: conn.execute('INSERT OR REPLACE INTO overrides VALUES (?,?)', (key, json.dumps(value)))
                bump(conn)
        return {'conflicts': conflicts, 'changes': changes, 'applied': apply}
