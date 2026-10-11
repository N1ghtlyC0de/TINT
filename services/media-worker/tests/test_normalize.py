import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from fakes import fake_run

from media_worker.normalize import (
    DEFAULT_TIMEOUT_S,
    NormalizeError,
    ffmpeg_normalize_cmd,
    is_normalized,
    normalize_video,
)


def test_normalize_cmd_targets_mp4_h264_aac_with_faststart():
    cmd = ffmpeg_normalize_cmd("in.mkv", "out.mp4")
    assert cmd[cmd.index("-i") + 1] == "in.mkv"
    assert cmd[-1] == "out.mp4"
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-movflags") + 1] == "+faststart"
    assert "0:a:0?" in cmd  # el audio es opcional


def test_normalize_runs_ffmpeg_with_timeout():
    runner = fake_run()
    normalize_video(Path("in.mp4"), Path("out.mp4"), runner)
    assert runner.call_args.args[0] == ffmpeg_normalize_cmd("in.mp4", "out.mp4")
    assert runner.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT_S


def test_normalize_raises_with_ffmpeg_stderr_on_failure():
    with pytest.raises(NormalizeError, match="codec roto"):
        normalize_video(
            Path("in.mp4"), Path("out.mp4"), fake_run(returncode=1, stderr="codec roto")
        )


def test_normalize_raises_on_timeout():
    runner = fake_run()
    runner.side_effect = subprocess.TimeoutExpired("ffmpeg", 5)
    with pytest.raises(NormalizeError, match="tiempo límite"):
        normalize_video(Path("in.mp4"), Path("out.mp4"), runner, timeout=5)


def test_normalize_raises_if_ffmpeg_cannot_start():
    runner = fake_run()
    runner.side_effect = FileNotFoundError("ffmpeg")
    with pytest.raises(NormalizeError, match="no se pudo ejecutar"):
        normalize_video(Path("in.mp4"), Path("out.mp4"), runner)


def probe_json(container="mov,mp4,m4a,3gp,3g2,mj2", video="h264", audio="aac", pix_fmt="yuv420p"):
    streams = []
    if video:
        streams.append({"codec_type": "video", "codec_name": video, "pix_fmt": pix_fmt})
    if audio:
        streams.append({"codec_type": "audio", "codec_name": audio})
    return json.dumps({"streams": streams, "format": {"format_name": container}})


def test_is_normalized_for_mp4_h264_aac():
    runner = fake_run(stdout=probe_json())
    assert is_normalized(Path("in.mp4"), runner) is True
    assert runner.call_args.args[0][0] == "ffprobe"
    assert runner.call_args.args[0][-1] == "in.mp4"


def test_is_normalized_accepts_video_without_audio():
    assert is_normalized(Path("in.mp4"), fake_run(stdout=probe_json(audio=None))) is True


@pytest.mark.parametrize(
    "output",
    [
        probe_json(container="matroska,webm"),
        probe_json(video="hevc"),
        probe_json(audio="ac3"),
        probe_json(pix_fmt="yuv444p"),
        probe_json(video=None),
        "no es json",
        "{}",
    ],
)
def test_is_normalized_false_when_something_differs(output):
    assert is_normalized(Path("in.mp4"), fake_run(stdout=output)) is False


@pytest.mark.parametrize(
    "runner",
    [
        fake_run(returncode=1, stderr="corrupto"),
        Mock(side_effect=subprocess.TimeoutExpired("ffprobe", 1)),
        Mock(side_effect=FileNotFoundError("ffprobe")),
    ],
)
def test_is_normalized_false_when_probe_fails(runner):
    assert is_normalized(Path("in.mp4"), runner) is False
