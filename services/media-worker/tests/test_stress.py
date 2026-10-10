"""MED-TEST-01: pruebas de estrés del procesamiento (sin FFmpeg, Redis, S3 ni SQL reales)."""

import json
import time
import tracemalloc

import pytest
from fakes import FakeBlobStore, FakePopen, FakeRedis, FakeRepository, fake_run, solid_frame

from media_worker.ambilight import FRAME_HEIGHT, FRAME_WIDTH, extract_ambilight
from media_worker.consumer import STREAM_KEY, StreamConsumer
from media_worker.pipeline import process_video
from media_worker.storage import ambilight_key

pytestmark = pytest.mark.stress

FRAME_SIZE = FRAME_WIDTH * FRAME_HEIGHT * 3
THREE_HOURS_S = 3 * 60 * 60


class SyntheticFrames:
    """Stdout de ffmpeg que genera fotogramas bajo demanda (nunca materializa el vídeo entero)."""

    def __init__(self, count):
        self.remaining = count
        self.index = 0
        self.max_read = 0

    def read(self, n=-1):
        if self.remaining == 0:
            return b""
        if n < 0:
            n = self.remaining * FRAME_SIZE
        frames = min(self.remaining, max(1, n // FRAME_SIZE))
        self.max_read = max(self.max_read, frames * FRAME_SIZE)
        out = b"".join(self._frame() for _ in range(frames))
        self.remaining -= frames
        return out

    def close(self):
        pass

    def _frame(self):
        self.index += 1
        return solid_frame((self.index % 256, (self.index * 7) % 256, 128))


def test_three_hour_video_is_streamed_one_frame_at_a_time():
    stdout = SyntheticFrames(THREE_HOURS_S)
    started = time.perf_counter()
    entries = extract_ambilight("long.mp4", THREE_HOURS_S * 1000, FakePopen(stdout=stdout))
    elapsed = time.perf_counter() - started

    assert len(entries) == THREE_HOURS_S
    assert entries[-1]["t_ms"] == (THREE_HOURS_S - 1) * 1000
    # Leer todo el stdout de golpe ocuparía ~466 MB; nunca se pide más de un fotograma.
    assert stdout.max_read == FRAME_SIZE
    # Margen amplio para CI: en local son ~6 s (FFmpeg real domina el tiempo total).
    assert elapsed < 60, f"{THREE_HOURS_S} fotogramas en {elapsed:.1f} s"


def test_peak_memory_does_not_grow_with_buffered_frames():
    frames = 600  # 10 min: tracemalloc ralentiza mucho, basta para medir el pico
    popen = FakePopen(stdout=SyntheticFrames(frames))
    tracemalloc.start()
    try:
        entries = extract_ambilight("long.mp4", frames * 1000, popen)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert len(entries) == frames
    buffered = frames * FRAME_SIZE  # ~26 MB si se acumulara todo el stdout
    assert peak < buffered / 4, f"pico de memoria {peak / 1e6:.1f} MB"


def test_burst_of_duplicate_events_produces_one_artifact_per_video():
    videos = [f"video-{i:04d}" for i in range(300)]
    redis = FakeRedis()
    for _ in range(2):  # cada subida se encola dos veces (reintento del productor)
        for video_id in videos:
            redis.xadd(STREAM_KEY, {"video_id": video_id})
    repo = FakeRepository({v: f"{v}/source.mp4" for v in videos})
    blobs = FakeBlobStore({f"{v}/source.mp4": b"bytes" for v in videos})

    def handler(video_id):
        popen = FakePopen(stdout=solid_frame((len(video_id), 0, 0)) * 3)
        process_video(video_id, repo, blobs, fake_run(stdout='{"format":{"duration":"3"}}'), popen)

    consumer = StreamConsumer(redis, handler, consumer="w1", count=50)
    while consumer.poll():
        pass

    assert len(redis.acks) == len(set(redis.acks)) == 2 * len(videos)
    assert redis.pending == {}
    assert all(repo.statuses[v] == "ready" for v in videos)
    artifacts = [key for key in blobs.objects if key.endswith("ambilight.json")]
    assert sorted(artifacts) == sorted(ambilight_key(v) for v in videos)
    assert len(json.loads(blobs.objects[ambilight_key(videos[0])])) == 3


def test_mixed_burst_isolates_failures():
    videos = [f"v{i}" for i in range(200)]
    redis = FakeRedis()
    for video_id in videos:
        redis.xadd(STREAM_KEY, {"video_id": video_id})
    redis.xadd(STREAM_KEY, {"video_id": "../evil"})
    repo = FakeRepository({v: f"{v}/source.mp4" for v in videos})
    blobs = FakeBlobStore({f"{v}/source.mp4": b"bytes" for v in videos})

    def handler(video_id):
        corrupt = int(video_id[1:]) % 3 == 0
        runner = (
            fake_run(returncode=1) if corrupt else fake_run(stdout='{"format":{"duration":"1"}}')
        )
        process_video(video_id, repo, blobs, runner, FakePopen(stdout=solid_frame((9, 9, 9))))

    consumer = StreamConsumer(redis, handler, consumer="w1", count=25)
    while consumer.poll():
        pass

    failed = {v for v, status in repo.statuses.items() if status == "failed"}
    assert failed == {v for v in videos if int(v[1:]) % 3 == 0}
    assert len(redis.acks) == len(videos) + 1
    assert not any(key.startswith("..") for key in blobs.objects)
