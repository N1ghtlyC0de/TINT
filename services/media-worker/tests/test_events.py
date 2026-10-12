import re
import uuid
from datetime import UTC, datetime

from fakes import FakeRedis

from media_worker.events import (
    ANALYTICS_MAXLEN,
    ANALYTICS_STREAM,
    media_processed,
    redis_publisher,
    rfc3339_ms,
)
from media_worker.probe import VideoStatus

VIDEO_ID = "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f"
NOW = datetime(2026, 10, 11, 4, 29, 49, 368123, tzinfo=UTC)


def test_stream_name_and_cap():
    assert (ANALYTICS_STREAM, ANALYTICS_MAXLEN) == ("analytics:events", 100_000)


def test_rfc3339_ms_is_utc_with_milliseconds_and_z():
    assert rfc3339_ms(NOW) == "2026-10-11T04:29:49.368Z"


def test_media_processed_ready_carries_duration_and_uploader():
    event = media_processed(
        VIDEO_ID,
        VideoStatus.READY,
        duration_ms=2500,
        processing_ms=1234,
        user_id="uid-1",
        now=lambda: NOW,
    )
    assert uuid.UUID(event.pop("event_id")).version == 4
    assert event == {
        "type": "media_processed",
        "source": "media-worker",
        "occurred_at": "2026-10-11T04:29:49.368Z",
        "received_at": "2026-10-11T04:29:49.368Z",
        "media_id": VIDEO_ID,
        "status": "ready",
        "duration_ms": "2500",
        "processing_ms": "1234",
        "user_id": "uid-1",
    }


def test_media_processed_failed_has_empty_duration_and_no_room_or_pii():
    event = media_processed(
        VIDEO_ID, VideoStatus.FAILED, duration_ms=None, processing_ms=7, user_id=None
    )
    assert event["status"] == "failed"
    assert event["duration_ms"] == ""
    assert event["user_id"] == ""
    assert "room_id" not in event
    assert all(isinstance(v, str) for v in event.values())
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", event["occurred_at"])


def test_each_event_gets_its_own_id():
    a, b = (media_processed(VIDEO_ID, VideoStatus.FAILED, None, 0, None) for _ in range(2))
    assert a["event_id"] != b["event_id"]


def test_redis_publisher_xadds_to_analytics_events_with_approximate_cap():
    redis = FakeRedis()
    publish = redis_publisher(redis)
    publish({"type": "media_processed"})
    assert redis.entries(ANALYTICS_STREAM) == [{"type": "media_processed"}]
    assert redis.xadd_calls == [(ANALYTICS_STREAM, ANALYTICS_MAXLEN, True)]
