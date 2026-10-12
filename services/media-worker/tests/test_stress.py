"""MED-TEST-01: pruebas de estrés de la extracción Ambilight (sin FFmpeg real)."""

import time
import tracemalloc

import pytest
from fakes import FakePopen, solid_frame

from media_worker.ambilight import FRAME_HEIGHT, FRAME_WIDTH, extract_ambilight

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
    # Margen amplio para CI: en local son ~3 s (FFmpeg real domina el tiempo total).
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
