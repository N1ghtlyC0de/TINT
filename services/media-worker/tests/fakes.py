"""Dobles de prueba compartidos: nunca se ejecutan FFmpeg, S3 ni PostgreSQL reales."""

import io
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock


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
        self.history = []

    def start_processing(self, video_id):
        if video_id not in self.video_ids:
            return False
        self._set(video_id, "processing")
        return True

    def mark_ready(self, video_id, duration_ms, storage_key):
        self.durations[video_id] = duration_ms
        self.storage_keys[video_id] = storage_key
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
