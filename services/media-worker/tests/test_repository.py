from unittest.mock import Mock

from media_worker.probe import VideoStatus
from media_worker.repository import VideoRepository


def conn_returning(row):
    conn = Mock()
    conn.execute.return_value.fetchone.return_value = row
    return conn


def test_start_processing_marks_processing_and_confirms_the_row_exists():
    conn = conn_returning(("v1",))
    assert VideoRepository(conn).start_processing("v1") is True
    sql, params = conn.execute.call_args.args
    assert sql.startswith("UPDATE videos SET status = %s")
    assert "RETURNING id" in sql
    assert params == (VideoStatus.PROCESSING.value, "v1")


def test_start_processing_returns_false_when_video_does_not_exist():
    assert VideoRepository(conn_returning(None)).start_processing("nope") is False


def test_mark_ready_sets_status_duration_and_storage_key():
    conn = Mock()
    VideoRepository(conn).mark_ready("v1", 2500, "v1/source.mp4")
    sql, params = conn.execute.call_args.args
    assert "duration_ms = %s" in sql
    assert "storage_key = %s" in sql
    assert "updated_at = now()" in sql
    assert params == (VideoStatus.READY.value, 2500, "v1/source.mp4", "v1")


def test_mark_failed_only_touches_status():
    conn = Mock()
    VideoRepository(conn).mark_failed("v1")
    sql, params = conn.execute.call_args.args
    assert "duration_ms" not in sql
    assert "storage_key" not in sql
    assert params == (VideoStatus.FAILED.value, "v1")
