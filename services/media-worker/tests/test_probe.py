import logging
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from media_worker.probe import (
    DEFAULT_TIMEOUT_S,
    FFPROBE_CMD,
    ProbeError,
    VideoStatus,
    inspect_status,
    parse_duration_ms,
    probe_duration_ms,
)


def fake_run(returncode=0, stdout="", stderr=""):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def test_parse_duration_ms_rounds_to_milliseconds():
    assert parse_duration_ms('{"format": {"duration": "12.3456"}}') == 12346


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "{}",
        '{"format": {}}',
        '{"format": {"duration": "abc"}}',
        '{"format": {"duration": "0"}}',
        '{"format": {"duration": "nan"}}',
        '{"format": {"duration": "inf"}}',
        '{"format": {"duration": "-inf"}}',
        '{"format": {"duration": "-3"}}',
    ],
)
def test_parse_duration_ms_rejects_invalid_output(payload):
    with pytest.raises(ProbeError):
        parse_duration_ms(payload)


def test_probe_duration_ms_invokes_ffprobe():
    runner = fake_run(stdout='{"format": {"duration": "2.5"}}')
    assert probe_duration_ms("movie.mp4", runner) == 2500
    args, kwargs = runner.call_args
    assert args[0] == [*FFPROBE_CMD, "movie.mp4"]
    assert kwargs["capture_output"] is True


def test_probe_duration_ms_passes_default_timeout_to_runner():
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    probe_duration_ms("movie.mp4", runner)
    assert runner.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT_S


def test_probe_duration_ms_passes_custom_timeout_to_runner():
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    probe_duration_ms("movie.mp4", runner, timeout=5)
    assert runner.call_args.kwargs["timeout"] == 5


def test_probe_duration_ms_raises_probe_error_on_timeout():
    runner = Mock(side_effect=subprocess.TimeoutExpired(cmd="ffprobe", timeout=30))
    with pytest.raises(ProbeError, match="tiempo"):
        probe_duration_ms("hang.mp4", runner)


def test_inspect_status_failed_on_timeout(caplog):
    runner = Mock(side_effect=subprocess.TimeoutExpired(cmd="ffprobe", timeout=30))
    with caplog.at_level(logging.WARNING, logger="media_worker.probe"):
        assert inspect_status("hang.mp4", runner) == (VideoStatus.FAILED, None)
    assert "hang.mp4" in caplog.text


def test_probe_duration_ms_raises_on_ffprobe_failure():
    with pytest.raises(ProbeError, match="moov atom not found"):
        probe_duration_ms("broken.mp4", fake_run(returncode=1, stderr="moov atom not found\n"))


def test_probe_duration_ms_default_error_message():
    with pytest.raises(ProbeError, match="ffprobe falló"):
        probe_duration_ms("broken.mp4", fake_run(returncode=1))


def test_inspect_status_ready():
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    assert inspect_status("ok.mp4", runner) == (VideoStatus.READY, 1000)


def test_inspect_status_failed_on_corrupt_file():
    assert inspect_status("bad.mp4", fake_run(returncode=1)) == (VideoStatus.FAILED, None)


def test_video_status_flow_is_processing_ready_failed():
    assert [s.value for s in VideoStatus] == ["processing", "ready", "failed"]


def test_inspect_status_failed_when_ffprobe_missing(caplog):
    runner = Mock(side_effect=FileNotFoundError("ffprobe"))
    with caplog.at_level(logging.ERROR, logger="media_worker.probe"):
        assert inspect_status("ok.mp4", runner) == (VideoStatus.FAILED, None)
    assert "ffprobe" in caplog.text
    assert "ok.mp4" in caplog.text


def test_inspect_status_logs_probe_error_reason(caplog):
    runner = fake_run(returncode=1, stderr="moov atom not found")
    with caplog.at_level(logging.WARNING, logger="media_worker.probe"):
        assert inspect_status("bad.mp4", runner) == (VideoStatus.FAILED, None)
    assert "moov atom not found" in caplog.text
    assert "bad.mp4" in caplog.text
