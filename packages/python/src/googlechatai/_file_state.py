"""Single-runtime coordination for local file-backed SDK helpers.

The file stores remain development and single-host conveniences. These helpers
prevent lost updates among concurrent callers in one Python runtime and ensure
readers only observe complete replacement files; they are not a distributed or
cross-process locking protocol.
"""

from __future__ import annotations

import os
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


_locks_guard = threading.Lock()
_locks: dict[str, "_LockState"] = {}


class _LockState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users = 0


def _lock_for(path: Path) -> tuple[str, _LockState]:
    key = str(path.expanduser().resolve())
    with _locks_guard:
        state = _locks.setdefault(key, _LockState())
        state.users += 1
        return key, state


@contextmanager
def file_state_lock(path: str | Path) -> Iterator[None]:
    """Serialize a local file's read-modify-write operation in this runtime."""

    key, state = _lock_for(Path(path))
    state.lock.acquire()
    try:
        yield
    finally:
        state.lock.release()
        with _locks_guard:
            state.users -= 1
            if state.users == 0 and _locks.get(key) is state:
                del _locks[key]


def atomic_write_text(
    path: str | Path,
    content: str,
    *,
    encoding: str = "utf-8",
    mode: int = 0o600,
) -> None:
    """Replace ``path`` atomically using an unpredictable sibling temporary."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        # `Path.open()` observes the process umask and can momentarily create
        # a world-readable file before the post-replace chmod below. Local
        # token/cache stores may contain credentials, so set restrictive mode
        # at creation time as well as on the final replacement.
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode,
        )
        with os.fdopen(descriptor, "w", encoding=encoding) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    try:
        os.chmod(destination, mode)
    except OSError:
        # Some platforms reject POSIX mode bits; best-effort only.
        pass


def atomic_write_bytes(
    path: str | Path,
    content: bytes,
    *,
    mode: int = 0o600,
) -> None:
    """Byte counterpart to :func:`atomic_write_text`."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    try:
        os.chmod(destination, mode)
    except OSError:
        pass
