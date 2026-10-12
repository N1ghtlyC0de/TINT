from datetime import UTC, datetime, timedelta

import pytest

from analytics.sanitize import InvalidEvent, is_expired, parse_timestamp, sanitize_event

BASE = {
    "event_id": "e1",
    "room_id": "r1",
    "source": "social-core",
    "occurred_at": "2026-10-08T12:00:00.000Z",
    "received_at": "2026-10-08T12:00:00.120Z",
}


def test_chat_message_keeps_only_length():
    event = {**BASE, "type": "chat_message", "user_id": "u1", "text": "hola mundo"}
    clean = sanitize_event(event)
    assert "text" not in clean
    assert clean["message_length"] == 10
    assert clean["user_id"] == "u1"
    assert event["text"] == "hola mundo", "el evento original no debe mutarse"


def test_chat_message_keeps_producer_length_when_no_text_is_present():
    # social-core publica solo message_length (desde Redis llega como texto): no debe pisarse.
    clean = sanitize_event({**BASE, "type": "chat_message", "message_length": "17"})
    assert clean["message_length"] == "17"


def test_chat_message_text_wins_over_producer_length():
    clean = sanitize_event({**BASE, "type": "chat_message", "message_length": "99", "body": "abc"})
    assert clean["message_length"] == 3
    assert "body" not in clean


def test_chat_message_without_text_nor_length_has_zero_length():
    assert sanitize_event({**BASE, "type": "chat_message"})["message_length"] == 0


def test_non_chat_event_strips_free_text_and_personal_data_without_length():
    clean = sanitize_event(
        {**BASE, "type": "reaction", "emoji": "👏", "content": "x", "nick": "Ana", "email": "a@b"}
    )
    assert clean == {**BASE, "type": "reaction", "emoji": "👏"}


@pytest.mark.parametrize("field", ["event_id", "type", "source", "occurred_at", "received_at"])
def test_missing_required_fields(field):
    event = {**BASE, "type": "reaction"}
    del event[field]
    with pytest.raises(InvalidEvent, match=field):
        sanitize_event(event)


def test_room_id_is_required_for_room_events():
    event = {**BASE, "type": "presence"}
    del event["room_id"]
    with pytest.raises(InvalidEvent, match="room_id"):
        sanitize_event(event)


@pytest.mark.parametrize("kind", ["user_login", "media_processed"])
def test_room_id_is_optional_for_events_outside_a_room(kind):
    event = {**BASE, "type": kind, "source": "identity-api"}
    del event["room_id"]
    assert sanitize_event(event)["type"] == kind


@pytest.mark.parametrize("field", ["occurred_at", "received_at"])
def test_rejects_unparseable_timestamps(field):
    with pytest.raises(InvalidEvent, match=field):
        sanitize_event({**BASE, "type": "reaction", field: "ayer"})


def test_rejects_nul_bytes_that_postgres_cannot_store():
    with pytest.raises(InvalidEvent, match="emoji"):
        sanitize_event({**BASE, "type": "reaction", "emoji": "a\x00b"})


def test_parse_timestamp_accepts_rfc3339_with_z_and_offsets():
    assert parse_timestamp("2026-10-11T04:29:49.368Z") == datetime(
        2026, 10, 11, 4, 29, 49, 368000, tzinfo=UTC
    )
    assert parse_timestamp("2026-10-11T00:00:00-05:00") == datetime(2026, 10, 11, 5, tzinfo=UTC)


def test_parse_timestamp_assumes_utc_without_offset():
    assert parse_timestamp("2026-10-11T04:29:49") == datetime(2026, 10, 11, 4, 29, 49, tzinfo=UTC)


def test_parse_timestamp_rejects_garbage():
    with pytest.raises(ValueError):
        parse_timestamp("nope")
    with pytest.raises(ValueError):
        parse_timestamp(None)


def test_is_expired():
    now = datetime(2026, 10, 8, tzinfo=UTC)
    assert is_expired(now - timedelta(days=91), now)
    assert not is_expired(now - timedelta(days=89), now)


def test_is_expired_defaults_to_current_time():
    assert not is_expired(datetime.now(UTC))
