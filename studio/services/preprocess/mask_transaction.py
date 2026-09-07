"""Cross-process mask write lock and recoverable multi-file replacement journal."""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
import time
import uuid

from studio.domain.errors import ConflictError

_registry_lock = threading.Lock()
_locks: dict[str, threading.RLock] = {}
_local = threading.local()
JOURNAL = ".mask-transaction.json"


def sha(path: Path) -> str | None:
    if not path.is_file():
        return None
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def durable_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def recover(train_dir: Path) -> None:
    journal = train_dir / JOURNAL
    if not journal.is_file():
        return
    state = json.loads(journal.read_text(encoding="utf-8"))
    records = state["records"]
    if state.get("committed"):
        journal.unlink()
        return
    # Validate ALL backups and current files before restoring any one of them.
    for record in records:
        before = Path(record["before"])
        from studio.infrastructure.paths import TASKS_DIR
        target = Path(record["target"]).resolve()
        valid_target = (target.is_relative_to(train_dir.resolve()) and target.suffix == '.mask') or (
            target.is_relative_to(TASKS_DIR.resolve()) and target.name == 'apply.json'
            and target.parent.name == 'head-mask' and target.parent.parent.name.isdigit()
        )
        if not valid_target or not before.resolve().is_relative_to((train_dir / '.mask-staging').resolve()):
            raise ConflictError("Invalid mask recovery journal paths", code="preprocess.mask_recovery_conflict")
        if (sha(Path(record["target"])) not in (record["before_sha"], record["after_sha"])
                or sha(before) != record["before_sha"]):
            raise ConflictError("Interrupted mask transaction has changed files; manual recovery required",
                                code="preprocess.mask_recovery_conflict")
    for record in reversed(records):
        target = Path(record["target"])
        if record["before_sha"] is None:
            target.unlink(missing_ok=True)
        else:
            temp = target.with_name(target.name + ".rollback")
            durable_write(temp, Path(record["before"]).read_bytes())
            os.replace(temp, target)
    journal.unlink()


@contextmanager
def lock(train_dir: Path):
    train_dir = train_dir.resolve()
    key = os.path.normcase(str(train_dir))
    with _registry_lock:
        mutex = _locks.setdefault(key, threading.RLock())
    with mutex:
        held = getattr(_local, "held", set())
        if key in held:
            yield
            return
        train_dir.mkdir(parents=True, exist_ok=True)
        with (train_dir / ".mask-write.lock").open("a+b") as stream:
            stream.seek(0, 2)
            if not stream.tell():
                stream.write(b"0")
                stream.flush()
            deadline = time.monotonic() + 30
            while True:
                try:
                    stream.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise ConflictError("Mask files are busy; retry after the other operation",
                                            code="preprocess.mask_busy") from None
                    time.sleep(0.05)
            _local.held = held | {key}
            try:
                recover(train_dir)
                yield
            finally:
                _local.held = held
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def locked(function):
    @wraps(function)
    def wrapped(train_dir, *args, **kwargs):
        with lock(train_dir):
            return function(train_dir, *args, **kwargs)
    return wrapped


def commit(train_dir: Path, changes: dict[Path, bytes | None]) -> None:
    """Caller holds lock; stage everything before durable journal and replaces."""
    staging = train_dir / ".mask-staging" / uuid.uuid4().hex
    staging.mkdir(parents=True)
    records = []
    journal = train_dir / JOURNAL
    try:
        for index, (target, data) in enumerate(changes.items()):
            before, after = staging / f"{index}.before", staging / f"{index}.after"
            before_sha = sha(target)
            if before_sha is not None:
                durable_write(before, target.read_bytes())
            if data is not None:
                durable_write(after, data)
            records.append({"target": str(target.resolve()), "before": str(before.resolve()),
                            "after": str(after.resolve()), "before_sha": before_sha, "after_sha": sha(after)})
        state = {"records": records, "committed": False}
        pending = journal.with_suffix(".tmp")
        durable_write(pending, json.dumps(state).encode())
        os.replace(pending, journal)
        for record in records:
            target = Path(record["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            if record["after_sha"] is None:
                target.unlink(missing_ok=True)
            else:
                os.replace(record["after"], target)
        state["committed"] = True
        durable_write(pending, json.dumps(state).encode())
        os.replace(pending, journal)
        journal.unlink()
    except Exception:
        recover(train_dir)
        raise
    finally:
        # Keep backups when recovery itself fails; never discard the journal's data.
        if not journal.exists():
            shutil.rmtree(staging, ignore_errors=True)


def recover_all() -> None:
    from studio.infrastructure.paths import STUDIO_DATA
    for journal in (STUDIO_DATA / "projects").rglob(JOURNAL):
        with lock(journal.parent):
            pass
