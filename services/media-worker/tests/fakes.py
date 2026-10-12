"""Dobles de prueba compartidos: nunca se ejecutan FFmpeg, S3 ni PostgreSQL reales."""

import io
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from redis.exceptions import ResponseError


def fake_run(returncode=0, stdout="", stderr=""):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def solid_frame(rgb, width=160, height=90):
    return bytes(rgb) * (width * height)


class Pipe(io.BytesIO):
    """Pipe en memoria que recuerda cuántos bytes quedaban sin leer al cerrarse."""

    unread = None

    def close(self):
        if not self.closed:
            self.unread = len(self.getbuffer()) - self.tell()
        super().close()


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout = stdout if hasattr(stdout, "read") else Pipe(stdout)
        self.stderr = Pipe(stderr)
        self.returncode = returncode
        self.killed = threading.Event()

    def wait(self):
        return self.returncode

    def kill(self):
        self.killed.set()


class FakePopen:
    def __init__(self, **process_kwargs):
        self.process = FakeProcess(**process_kwargs)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        return self.process


class FakeRepository:
    def __init__(self, video_ids):
        self.video_ids = set(video_ids)
        self.statuses = {}
        self.durations = {}
        self.storage_keys = {}
        self.renditions = {}
        self.history = []

    def start_processing(self, video_id):
        if video_id not in self.video_ids:
            return False
        self._set(video_id, "processing")
        return True

    def mark_ready(self, video_id, duration_ms, storage_key, renditions=()):
        self.durations[video_id] = duration_ms
        self.storage_keys[video_id] = storage_key
        self.renditions[video_id] = list(renditions)
        self._set(video_id, "ready")

    def mark_failed(self, video_id):
        self._set(video_id, "failed")

    def _set(self, video_id, status):
        self.statuses[video_id] = status
        self.history.append((video_id, status))


class FakeBlobStore:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.puts = []

    def upload_file(self, path, key):
        self.objects[key] = path.read_bytes()
        self.puts.append(key)

    def put_json(self, key, data):
        self.objects[key] = json.dumps(data, separators=(",", ":"))
        self.puts.append(key)


class FakeRedis:
    """Subconjunto de Redis Streams con un solo stream y grupo de consumidores."""

    def __init__(self):
        self.groups = set()
        self.entries = []
        self.delivered = 0
        self.pending = {}
        self.acks = []

    def xgroup_create(self, name, groupname, id="$", mkstream=False):
        if (name, groupname) in self.groups:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        self.groups.add((name, groupname))

    def xadd(self, name, fields):
        message_id = f"{len(self.entries) + 1}-0"
        self.entries.append((message_id, fields))
        return message_id

    def xreadgroup(self, groupname, consumername, streams, count=None, block=None):
        ((stream, last_id),) = streams.items()
        if last_id == "0":
            batch = [(mid, fields) for mid, (_c, fields) in self.pending.items()][:count]
        else:
            batch = self.entries[self.delivered : self.delivered + count]
            self.delivered += len(batch)
            for mid, fields in batch:
                self.pending[mid] = (consumername, fields)
        return [[stream, batch]] if batch else []

    def xack(self, name, groupname, *ids):
        for mid in ids:
            self.pending.pop(mid, None)
            self.acks.append(mid)
        return len(ids)
