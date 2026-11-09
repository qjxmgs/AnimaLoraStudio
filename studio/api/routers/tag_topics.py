from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from typing import Literal

from ...infrastructure import tag_topics as catalog

router = APIRouter(prefix='/api/tag-topics', tags=['tag-topics'])


class Entry(BaseModel):
    tag: str = Field(min_length=1, max_length=300)
    topic: str | None = None
    base: bool = False
    excluded: bool = False
    relation: Literal['base', 'variant', 'related', 'modifier', 'exception'] = 'related'
    note: str = Field(default='', max_length=2000)


class Topic(BaseModel):
    id: str = Field(max_length=100)
    name: str = Field(min_length=1, max_length=100)
    zh: str = Field(min_length=1, max_length=100)
    rank: int = Field(ge=2, le=8)
    parent: str | None = None
    group: str = Field(min_length=1, max_length=100)
    kind: Literal['topic', 'family'] = 'topic'


class Explain(BaseModel):
    tags: list[str] = Field(max_length=10000)


class Transfer(BaseModel):
    format: Literal[1]
    topics: list[Topic] = Field(default_factory=list, max_length=10000)
    entries: list[Entry] = Field(default_factory=list, max_length=50000)


@router.get('/snapshot')
def snapshot(): return catalog.snapshot()


@router.get('/topics')
def topics(): return catalog.snapshot()['topics']


@router.get('/entries')
def entries(q: str = Query('', max_length=300), topic: str = '', rank: int | None = Query(None, ge=0, le=8),
            source: Literal['', 'builtin', 'user', 'rule', 'fallback', 'identity', 'unknown'] = '',
            status: Literal['', 'mapped', 'unmapped'] = '', offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    return catalog.search(q, topic, rank, source, status, offset, limit)


@router.post('/explain')
def explain(body: Explain): return catalog.explain(body.tags)


@router.put('/entries')
def save_entry(body: Entry): return catalog.save_entry(body.model_dump())


@router.delete('/entries')
def restore(tag: str): return catalog.restore(tag)


@router.put('/topics')
def save_topic(body: Topic): return catalog.save_topic(body.model_dump())


@router.get('/export')
def export(): return catalog.export_users()


@router.post('/import')
def import_users(body: Transfer, apply: bool = False, overwrite: bool = False):
    return catalog.import_users(body.model_dump(), overwrite, apply)
