import logging
from pathlib import Path
from unittest.mock import Mock

import pytest
from fakes import FakeBlobStore

from media_worker.jobs import INCOMING_PREFIX, handle_upload
from media_worker.pipeline import VideoNotFoundError
from media_worker.probe import VideoStatus
from media_worker.storage import BlobNotFoundError

VIDEO_ID = "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f"
STAGED = f"{INCOMING_PREFIX}{VIDEO_ID}/original.MP4"


class Blobs(FakeBlobStore):
    """Añade `download` al FakeBlobStore compartido."""

    def download(self, key, dest):
        if key not in self.objects:
            raise BlobNotFoundError(key)
        Path(dest).write_bytes(self.objects[key])


def repo_with(row):
    repo = Mock()
    repo.get_video.return_value = row
    return repo


def test_incoming_prefix_is_the_staging_area():
    assert INCOMING_PREFIX == "incoming/"


def test_downloads_the_staged_upload_and_runs_the_pipeline_with_its_original_name():
    blobs = Blobs({STAGED: b"bytes del navegador"})
    repo = repo_with(("processing", STAGED))
    seen = {}

    def process(video_id, source, repo_, blobs_):
        seen.update(video_id=video_id, name=source.name, data=source.read_bytes(), exists=True)
        assert repo_ is repo and blobs_ is blobs
        return VideoStatus.READY

    assert handle_upload(VIDEO_ID, repo, blobs, process=process) is VideoStatus.READY
    assert seen == {
        "video_id": VIDEO_ID,
        "name": "original.MP4",
        "data": b"bytes del navegador",
        "exists": True,
    }


def test_temporary_file_is_removed_after_processing():
    blobs = Blobs({STAGED: b"x"})
    paths = []
    handle_upload(
        VIDEO_ID,
        repo_with(("processing", STAGED)),
        blobs,
        process=lambda v, s, r, b: paths.append(s),
    )
    assert paths and not paths[0].exists()


def test_already_published_video_is_not_reprocessed(caplog):
    process = Mock()
    repo = repo_with(("ready", f"{VIDEO_ID}/source.mp4"))
    with caplog.at_level(logging.INFO, logger="media_worker.jobs"):
        assert handle_upload(VIDEO_ID, repo, Blobs(), process=process) is VideoStatus.READY
    process.assert_not_called()
    assert "ya publicado" in caplog.text


@pytest.mark.parametrize("video_id", ["abc", "abc_123", "x" * 36])
def test_non_uuid_ids_are_skipped_before_touching_sql(video_id, caplog):
    repo = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        assert handle_upload(video_id, repo, Blobs(), process=Mock()) is None
    repo.get_video.assert_not_called()
    assert "no es un UUID" in caplog.text


def test_unknown_video_is_skipped(caplog):
    process = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        assert handle_upload(VIDEO_ID, repo_with(None), Blobs(), process=process) is None
    process.assert_not_called()
    assert "no existe" in caplog.text


def test_missing_upload_marks_failed():
    repo = repo_with(("processing", STAGED))
    assert handle_upload(VIDEO_ID, repo, Blobs(), process=Mock()) is VideoStatus.FAILED
    repo.mark_failed.assert_called_once_with(VIDEO_ID)


def test_row_deleted_while_processing_is_skipped():
    blobs = Blobs({STAGED: b"x"})
    process = Mock(side_effect=VideoNotFoundError("borrado"))
    assert (
        handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs, process=process) is None
    )


def test_infrastructure_errors_propagate_so_the_event_is_retried():
    blobs = Blobs({STAGED: b"x"})
    process = Mock(side_effect=ConnectionError("S3 caído"))
    with pytest.raises(ConnectionError):
        handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs, process=process)


def test_default_process_is_the_pipeline(monkeypatch):
    import media_worker.jobs as jobs

    called = Mock(return_value=VideoStatus.FAILED)
    monkeypatch.setattr(jobs, "process_video", called)
    blobs = Blobs({STAGED: b"x"})
    assert handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs) is VideoStatus.FAILED
    called.assert_called_once()
