import json
import logging
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fakes import FakeBlobStore, FakePopen, FakeRepository, fake_run, solid_frame

from media_worker.pipeline import (
    SUPPORTED_EXTENSIONS,
    InvalidVideoIdError,
    UnsupportedFormatError,
    VideoNotFoundError,
    process_video,
    validate_extension,
    validate_video_id,
)
from media_worker.probe import VideoStatus
from media_worker.storage import ambilight_key

PROBE_2S = '{"format": {"duration": "2.0"}}'


def two_red_frames():
    return FakePopen(stdout=solid_frame((255, 0, 0)) * 2)


@pytest.fixture
def upload(tmp_path):
    """Archivo que la API recibió y guardó en local antes de invocar al worker."""
    path = tmp_path / "upload.mp4"
    path.write_bytes(b"video-bytes")
    return path


PROBE_STREAMS_NORMALIZED = json.dumps(
    {
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p"},
            {"codec_type": "audio", "codec_name": "aac"},
        ],
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "2.0"},
    }
)


def pipeline_runner(ffmpeg_returncode=0, ffmpeg_error=None, already_normalized=False):
    """Runner que atiende ffprobe (duración y códecs) y ffmpeg (escribe el MP4 normalizado)."""
    seen = []

    def run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            if any(arg.startswith("stream=") for arg in cmd):
                out = PROBE_STREAMS_NORMALIZED if already_normalized else "{}"
                return SimpleNamespace(returncode=0, stdout=out, stderr="")
            return SimpleNamespace(returncode=0, stdout=PROBE_2S, stderr="")
        if ffmpeg_error:
            raise ffmpeg_error
        dest = Path(cmd[-1])
        seen.append((Path(cmd[cmd.index("-i") + 1]), dest))
        dest.write_bytes(b"normalized-bytes")
        return SimpleNamespace(returncode=ffmpeg_returncode, stdout="", stderr="boom")

    runner = Mock(side_effect=run)
    runner.seen = seen
    return runner


def setup():
    return FakeRepository({"v1"}), FakeBlobStore()


def test_process_video_uploads_normalized_video_and_ambilight_then_marks_ready(upload):
    repo, blobs = setup()
    runner = pipeline_runner()
    status = process_video("v1", upload, repo, blobs, runner, two_red_frames())
    assert status is VideoStatus.READY
    assert repo.history == [("v1", "processing"), ("v1", "ready")]
    assert repo.durations["v1"] == 2000
    assert repo.storage_keys["v1"] == "v1/source.mp4"
    assert blobs.objects["v1/source.mp4"] == b"normalized-bytes"
    palette = json.loads(blobs.objects[ambilight_key("v1")])
    assert [entry["t_ms"] for entry in palette] == [0, 1000]
    assert palette[0]["top"] == "#ff0000"


def test_process_video_validates_then_normalizes_then_extracts_ambilight_from_the_normalized(
    upload,
):
    repo, blobs = setup()
    runner = pipeline_runner()
    popen = two_red_frames()
    process_video("v1", upload, repo, blobs, runner, popen)
    assert [call.args[0][0] for call in runner.call_args_list] == ["ffprobe", "ffprobe", "ffmpeg"]
    assert runner.call_args_list[0].args[0][-1] == str(upload)
    ((src, normalized),) = runner.seen
    assert src == upload
    cmd = popen.calls[0][0]
    assert cmd[cmd.index("-i") + 1] == str(normalized) != str(upload)


def test_process_video_leaves_the_local_file_to_the_caller(upload):
    repo, blobs = setup()
    process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    assert upload.read_bytes() == b"video-bytes"


def test_process_video_publishes_source_mp4_whatever_the_input_extension(tmp_path):
    upload = tmp_path / "clip.MP4"
    upload.write_bytes(b"x")
    repo, blobs = setup()
    process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    assert repo.storage_keys["v1"] == "v1/source.mp4"


def test_normalized_temp_file_is_removed_on_success_and_on_failure(upload):
    for runner in (pipeline_runner(), pipeline_runner(ffmpeg_returncode=1)):
        repo, blobs = setup()
        process_video("v1", upload, repo, blobs, runner, two_red_frames())
        ((_, normalized),) = runner.seen
        assert not normalized.exists() and not normalized.parent.exists()


@pytest.mark.parametrize(
    "runner",
    [
        pipeline_runner(ffmpeg_returncode=1),
        pipeline_runner(ffmpeg_error=subprocess.TimeoutExpired("ffmpeg", 1)),
    ],
)
def test_video_is_not_uploaded_when_normalization_fails(upload, runner):
    repo, blobs = setup()
    popen = FakePopen()
    status = process_video("v1", upload, repo, blobs, runner, popen)
    assert status is VideoStatus.FAILED
    assert repo.history == [("v1", "processing"), ("v1", "failed")]
    assert popen.calls == []
    assert blobs.objects == {}


def test_process_video_does_not_mark_ready_if_upload_fails(upload):
    repo, blobs = setup()

    def broken_put(key, data):
        raise ConnectionError("minio caído")

    blobs.put_json = broken_put
    with pytest.raises(ConnectionError):
        process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    assert repo.statuses["v1"] == "processing"


def test_process_video_raises_for_unknown_video(upload):
    repo, blobs = setup()
    runner = fake_run()
    with pytest.raises(VideoNotFoundError, match="ghost"):
        process_video("ghost", upload, repo, blobs, runner, FakePopen())
    runner.assert_not_called()
    assert blobs.puts == []
    assert repo.history == []


@pytest.mark.parametrize(
    "video_id",
    ["0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f", "abc_123", "x" * 128],
)
def test_validate_video_id_accepts_plain_ids(video_id):
    assert validate_video_id(video_id) == video_id


@pytest.mark.parametrize("video_id", ["../etc", "a/b", "", "-abc", "x" * 129, None, 123])
def test_validate_video_id_rejects_unsafe_ids(video_id):
    with pytest.raises(InvalidVideoIdError):
        validate_video_id(video_id)


def test_process_video_rejects_invalid_id_before_touching_sql_or_bucket(upload):
    repo, blobs = setup()
    with pytest.raises(InvalidVideoIdError):
        process_video("../v1", upload, repo, blobs, fake_run(), FakePopen())
    assert repo.history == []
    assert blobs.puts == []


def test_corrupt_video_is_never_uploaded(upload):
    repo, blobs = setup()
    popen = FakePopen()
    status = process_video("v1", upload, repo, blobs, fake_run(returncode=1, stderr="moov"), popen)
    assert status is VideoStatus.FAILED
    assert repo.history == [("v1", "processing"), ("v1", "failed")]
    assert popen.calls == []
    assert blobs.objects == {}


def test_missing_local_file_marks_failed_without_uploading(tmp_path):
    repo, blobs = setup()
    missing = tmp_path / "missing.mp4"
    runner = fake_run(returncode=1, stderr="No such file or directory")
    assert process_video("v1", missing, repo, blobs, runner, FakePopen()) is VideoStatus.FAILED
    assert repo.statuses["v1"] == "failed"
    assert blobs.objects == {}


def test_video_is_not_uploaded_when_ambilight_fails(upload, caplog):
    repo, blobs = setup()
    popen = FakePopen(returncode=1, stderr=b"decode error")
    with caplog.at_level(logging.WARNING, logger="media_worker.pipeline"):
        status = process_video("v1", upload, repo, blobs, pipeline_runner(), popen)
    assert status is VideoStatus.FAILED
    assert repo.statuses["v1"] == "failed"
    assert blobs.objects == {}
    assert "decode error" in caplog.text


def test_reprocessing_overwrites_the_same_artifacts(upload):
    repo, blobs = setup()
    process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    first = dict(blobs.objects)
    process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    assert blobs.objects == first
    assert sorted(blobs.objects) == ["v1/ambilight.json", "v1/source.mp4"]
    assert repo.statuses["v1"] == "ready"


def test_failed_video_is_reprocessed_when_requested_again(upload):
    repo, blobs = setup()
    process_video("v1", upload, repo, blobs, fake_run(returncode=1), FakePopen())
    process_video("v1", upload, repo, blobs, pipeline_runner(), two_red_frames())
    assert [status for _, status in repo.history] == ["processing", "failed", "processing", "ready"]


def test_already_normalized_video_is_published_without_running_ffmpeg(upload):
    repo, blobs = setup()
    runner = pipeline_runner(already_normalized=True)
    popen = two_red_frames()
    status = process_video("v1", upload, repo, blobs, runner, popen)
    assert status is VideoStatus.READY
    assert runner.seen == []
    assert "ffmpeg" not in [call.args[0][0] for call in runner.call_args_list]
    assert blobs.objects["v1/source.mp4"] == b"video-bytes"
    assert repo.storage_keys["v1"] == "v1/source.mp4"
    cmd = popen.calls[0][0]
    assert cmd[cmd.index("-i") + 1] == str(upload)
    assert upload.read_bytes() == b"video-bytes"


def test_supported_extensions_are_mp4_mov_mkv_webm():
    assert SUPPORTED_EXTENSIONS == frozenset({".mp4", ".mov", ".mkv", ".webm"})


@pytest.mark.parametrize("name", ["a.mp4", "a.MOV", "a.Mkv", "a.webm", "incoming/x/original.MP4"])
def test_validate_extension_accepts_supported_formats(name):
    assert validate_extension(name) == name


@pytest.mark.parametrize("name", ["a.avi", "a.gif", "a.mp3", "a.m4v", "a", "a.mp4.exe", "a."])
def test_validate_extension_rejects_everything_else(name):
    with pytest.raises(UnsupportedFormatError):
        validate_extension(name)


def test_unsupported_format_is_an_error_before_touching_sql_or_bucket(tmp_path):
    upload = tmp_path / "clip.avi"
    upload.write_bytes(b"x")
    repo, blobs = setup()
    runner = pipeline_runner()
    with pytest.raises(UnsupportedFormatError, match=r"\.avi"):
        process_video("v1", upload, repo, blobs, runner, FakePopen())
    assert repo.history == [] and blobs.objects == {} and runner.call_args_list == []
