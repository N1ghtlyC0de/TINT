import io
import random
import subprocess
import threading

import pytest
from fakes import FakePopen, FakeProcess, solid_frame

from media_worker.ambilight import (
    FRAME_HEIGHT,
    FRAME_WIDTH,
    AmbilightError,
    Region,
    average_color,
    edge_regions,
    extract_ambilight,
    ffmpeg_frames_cmd,
    frame_colors,
    read_frames,
    region_color,
    sample_timestamps_ms,
)


def test_edge_regions_are_ten_percent_bands():
    regions = edge_regions(1920, 1080)
    assert regions["top"] == Region(0, 0, 1920, 108)
    assert regions["bottom"] == Region(0, 972, 1920, 108)
    assert regions["left"] == Region(0, 0, 192, 1080)
    assert regions["right"] == Region(1728, 0, 192, 1080)


def test_edge_regions_minimum_one_pixel():
    assert edge_regions(4, 4)["top"].height == 1


@pytest.mark.parametrize(
    ("width", "height", "ratio"), [(0, 10, 0.1), (10, -1, 0.1), (10, 10, 0), (10, 10, 0.6)]
)
def test_edge_regions_rejects_invalid_input(width, height, ratio):
    with pytest.raises(ValueError):
        edge_regions(width, height, ratio)


def test_average_color():
    assert average_color([(255, 0, 0), (0, 0, 255)]) == "#800080"


def test_average_color_requires_pixels():
    with pytest.raises(ValueError):
        average_color([])


def test_sample_timestamps_one_fps():
    assert sample_timestamps_ms(3500) == [0, 1000, 2000, 3000]


@pytest.mark.parametrize(("duration", "fps"), [(-1, 1), (1000, 0), (1000, -1), (1000, 1001)])
def test_sample_timestamps_rejects_invalid_input(duration, fps):
    with pytest.raises(ValueError):
        sample_timestamps_ms(duration, fps)


def test_sample_timestamps_accepts_max_fps():
    assert sample_timestamps_ms(3, 1000) == [0, 1, 2]


@pytest.mark.parametrize("fps", [0, -5, 1001])
def test_sample_timestamps_fps_error_message(fps):
    with pytest.raises(ValueError, match="fps debe estar en"):
        sample_timestamps_ms(1000, fps)


def test_ffmpeg_frames_cmd_streams_reduced_rgb_frames_at_one_fps():
    cmd = ffmpeg_frames_cmd("in.mp4")
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == "in.mp4"
    assert cmd[cmd.index("-vf") + 1] == f"fps=1,scale={FRAME_WIDTH}:{FRAME_HEIGHT}"
    assert cmd[cmd.index("-pix_fmt") + 1] == "rgb24"
    assert cmd[-1] == "pipe:1"


def test_region_color_matches_average_color_of_region_pixels():
    rng = random.Random(7)
    width, height = 12, 8
    frame = bytes(rng.randrange(256) for _ in range(width * height * 3))
    region = Region(2, 3, 5, 4)
    pixels = [
        tuple(frame[(y * width + x) * 3 : (y * width + x) * 3 + 3])
        for y in range(region.y, region.y + region.height)
        for x in range(region.x, region.x + region.width)
    ]
    assert region_color(frame, width, region) == average_color(pixels)


def test_frame_colors_reads_each_edge_band():
    width, height = 10, 10
    red, blue = bytes((255, 0, 0)), bytes((0, 0, 255))
    frame = red * (width * height // 2) + blue * (width * height // 2)
    assert frame_colors(frame, width, height) == {
        "top": "#ff0000",
        "bottom": "#0000ff",
        "left": "#800080",
        "right": "#800080",
    }


def naive_frame_colors(frame, width, height):
    """Referencia píxel a píxel: lo que deben dar las sumas optimizadas, byte a byte."""

    def pixel(x, y):
        offset = (y * width + x) * 3
        return tuple(frame[offset : offset + 3])

    return {
        edge: average_color(
            [
                pixel(x, y)
                for y in range(region.y, region.y + region.height)
                for x in range(region.x, region.x + region.width)
            ]
        )
        for edge, region in edge_regions(width, height).items()
    }


@pytest.mark.parametrize(
    ("width", "height"), [(FRAME_WIDTH, FRAME_HEIGHT), (7, 5), (1, 1), (33, 2)]
)
def test_frame_colors_matches_pixel_by_pixel_reference(width, height):
    rng = random.Random(width * 1000 + height)
    for _ in range(5):
        frame = rng.randbytes(width * height * 3)
        assert frame_colors(frame, width, height) == naive_frame_colors(frame, width, height)


def test_frame_colors_accepts_bytearray_and_memoryview():
    frame = random.Random(3).randbytes(FRAME_WIDTH * FRAME_HEIGHT * 3)
    expected = frame_colors(frame, FRAME_WIDTH, FRAME_HEIGHT)
    assert frame_colors(bytearray(frame), FRAME_WIDTH, FRAME_HEIGHT) == expected
    assert frame_colors(memoryview(frame), FRAME_WIDTH, FRAME_HEIGHT) == expected


def test_frame_colors_rejects_wrong_frame_size():
    with pytest.raises(AmbilightError, match="tamaño"):
        frame_colors(b"\x00" * 10, 10, 10)


class ChunkedStream:
    """Simula un pipe que devuelve lecturas cortas."""

    def __init__(self, data, chunk):
        self.data, self.chunk = io.BytesIO(data), chunk

    def read(self, n=-1):
        return self.data.read(min(n, self.chunk) if n >= 0 else -1)


def test_read_frames_reassembles_short_reads():
    stream = ChunkedStream(b"abcdefghijkl", chunk=5)
    assert list(read_frames(stream, 6)) == [b"abcdef", b"ghijkl"]


def test_read_frames_rejects_truncated_frame():
    with pytest.raises(AmbilightError, match="truncado"):
        list(read_frames(io.BytesIO(b"abcdefgh"), 6))


def test_extract_ambilight_builds_one_entry_per_second():
    frames = solid_frame((255, 0, 0)) + solid_frame((0, 255, 0))
    popen = FakePopen(stdout=frames)
    entries = extract_ambilight("in.mp4", 2000, popen)
    assert entries == [
        {"t_ms": 0, "top": "#ff0000", "bottom": "#ff0000", "left": "#ff0000", "right": "#ff0000"},
        {
            "t_ms": 1000,
            "top": "#00ff00",
            "bottom": "#00ff00",
            "left": "#00ff00",
            "right": "#00ff00",
        },
    ]
    cmd, kwargs = popen.calls[0]
    assert cmd == ffmpeg_frames_cmd("in.mp4")
    assert kwargs["stdout"] is subprocess.PIPE
    assert kwargs["stdin"] is subprocess.DEVNULL


def test_extract_ambilight_ignores_frames_beyond_duration():
    popen = FakePopen(stdout=solid_frame((1, 2, 3)) * 3)
    entries = extract_ambilight("in.mp4", 1500, popen)
    assert [e["t_ms"] for e in entries] == [0, 1000]
    assert popen.process.stdout.unread == 0
    assert popen.process.stdout.closed and popen.process.stderr.closed


def test_extract_ambilight_is_deterministic():
    frames = random.Random(1).randbytes(FRAME_WIDTH * FRAME_HEIGHT * 3)
    first = extract_ambilight("in.mp4", 1000, FakePopen(stdout=frames))
    second = extract_ambilight("in.mp4", 1000, FakePopen(stdout=frames))
    assert first == second


def test_extract_ambilight_reports_ffmpeg_failure():
    popen = FakePopen(stdout=b"", stderr=b"Invalid data found\n", returncode=1)
    with pytest.raises(AmbilightError, match="Invalid data found"):
        extract_ambilight("bad.mp4", 1000, popen)


def test_extract_ambilight_default_failure_message():
    with pytest.raises(AmbilightError, match="ffmpeg falló"):
        extract_ambilight("bad.mp4", 1000, FakePopen(returncode=1))


def test_extract_ambilight_requires_at_least_one_frame():
    with pytest.raises(AmbilightError, match="no produjo fotogramas"):
        extract_ambilight("empty.mp4", 1000, FakePopen(stdout=b""))


def test_extract_ambilight_wraps_missing_ffmpeg():
    def popen(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    with pytest.raises(AmbilightError, match="no se pudo ejecutar ffmpeg"):
        extract_ambilight("in.mp4", 1000, popen)


def test_extract_ambilight_kills_ffmpeg_on_truncated_output():
    popen = FakePopen(stdout=b"\x00" * 100)
    with pytest.raises(AmbilightError, match="truncado"):
        extract_ambilight("in.mp4", 1000, popen)
    assert popen.process.killed.is_set()


class HangingStream:
    """Bloquea la lectura hasta que el proceso se mata (simula ffmpeg colgado)."""

    def __init__(self, killed: threading.Event):
        self.killed = killed

    def read(self, n=-1):
        self.killed.wait(5)
        return b""

    def close(self):
        pass


def test_extract_ambilight_kills_ffmpeg_on_timeout():
    process = FakeProcess(returncode=-9)
    process.stdout = HangingStream(process.killed)
    popen = FakePopen()
    popen.process = process
    with pytest.raises(AmbilightError, match="tiempo límite"):
        extract_ambilight("hang.mp4", 1000, popen, timeout=0.01)
    assert process.killed.is_set()
