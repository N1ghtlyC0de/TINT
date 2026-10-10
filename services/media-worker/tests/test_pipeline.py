import json
import logging
from pathlib import Path

import pytest
from fakes import FakeBlobStore, FakePopen, FakeRepository, fake_run, solid_frame

from media_worker.pipeline import process_video
from media_worker.probe import VideoStatus
from media_worker.storage import ambilight_key

PROBE_2S = '{"format": {"duration": "2.0"}}'


def two_red_frames():
    return FakePopen(stdout=solid_frame((255, 0, 0)) * 2)


def setup(storage_key="v1/source.mp4", objects=None):
    repo = FakeRepository({"v1": storage_key})
    blobs = FakeBlobStore({"v1/source.mp4": b"video-bytes"} if objects is None else objects)
    return repo, blobs


def test_process_video_publishes_ambilight_and_marks_ready():
    repo, blobs = setup()
    status = process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), two_red_frames())
    assert status is VideoStatus.READY
    assert repo.history == [("v1", "processing"), ("v1", "ready")]
    assert repo.durations["v1"] == 2000
    palette = json.loads(blobs.objects[ambilight_key("v1")])
    assert [entry["t_ms"] for entry in palette] == [0, 1000]
    assert palette[0]["top"] == "#ff0000"


def test_process_video_inspects_downloaded_copy_and_cleans_it_up():
    repo, blobs = setup()
    runner = fake_run(stdout=PROBE_2S)
    popen = two_red_frames()
    process_video("v1", repo, blobs, runner, popen)
    probed = Path(runner.call_args.args[0][-1])
    assert probed.name == "source.mp4"
    assert popen.calls[0][0][popen.calls[0][0].index("-i") + 1] == str(probed)
    assert not probed.parent.exists()


def test_process_video_does_not_mark_ready_if_upload_fails():
    repo, blobs = setup()

    def broken_put(key, data):
        raise ConnectionError("minio caído")

    blobs.put_json = broken_put
    with pytest.raises(ConnectionError):
        process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), two_red_frames())
    assert repo.statuses["v1"] == "processing"


def test_process_video_skips_unknown_video(caplog):
    repo, blobs = setup()
    with caplog.at_level(logging.WARNING, logger="media_worker.pipeline"):
        assert process_video("ghost", repo, blobs, fake_run(), FakePopen()) is None
    assert "ghost" in caplog.text
    assert blobs.puts == []
    assert repo.history == []


@pytest.mark.parametrize(
    ("storage_key", "objects"),
    [("", None), ("v1/source.mp4", {})],
    ids=["sin-storage-key", "original-inexistente"],
)
def test_process_video_fails_when_source_is_missing(storage_key, objects, caplog):
    repo, blobs = setup(storage_key, objects)
    runner = fake_run(stdout=PROBE_2S)
    with caplog.at_level(logging.WARNING, logger="media_worker.pipeline"):
        assert process_video("v1", repo, blobs, runner, FakePopen()) is VideoStatus.FAILED
    assert repo.statuses["v1"] == "failed"
    assert blobs.puts == []
    runner.assert_not_called()
    assert "v1" in caplog.text


def test_process_video_fails_on_corrupt_file():
    repo, blobs = setup()
    popen = FakePopen()
    status = process_video("v1", repo, blobs, fake_run(returncode=1, stderr="moov"), popen)
    assert status is VideoStatus.FAILED
    assert repo.history == [("v1", "processing"), ("v1", "failed")]
    assert popen.calls == []
    assert blobs.puts == []


def test_process_video_fails_when_frames_cannot_be_extracted(caplog):
    repo, blobs = setup()
    popen = FakePopen(returncode=1, stderr=b"decode error")
    with caplog.at_level(logging.WARNING, logger="media_worker.pipeline"):
        status = process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), popen)
    assert status is VideoStatus.FAILED
    assert repo.statuses["v1"] == "failed"
    assert blobs.puts == []
    assert "decode error" in caplog.text


def test_reprocessing_overwrites_the_same_artifact():
    repo, blobs = setup()
    process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), two_red_frames())
    first = blobs.objects[ambilight_key("v1")]
    process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), two_red_frames())
    assert blobs.objects[ambilight_key("v1")] == first
    assert set(blobs.puts) == {ambilight_key("v1")}
    assert sorted(blobs.objects) == ["v1/ambilight.json", "v1/source.mp4"]
    assert repo.statuses["v1"] == "ready"


def test_failed_video_is_reprocessed_when_requeued():
    repo, blobs = setup()
    process_video("v1", repo, blobs, fake_run(returncode=1), FakePopen())
    process_video("v1", repo, blobs, fake_run(stdout=PROBE_2S), two_red_frames())
    assert [status for _, status in repo.history] == ["processing", "failed", "processing", "ready"]
