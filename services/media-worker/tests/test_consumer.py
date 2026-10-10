import logging
import threading
from unittest.mock import Mock

import pytest
from fakes import FakeRedis
from redis.exceptions import ResponseError

from media_worker.consumer import CONSUMER_GROUP, STREAM_KEY, StreamConsumer, parse_video_id


def make_consumer(redis, handler=None, **kwargs):
    return StreamConsumer(redis, handler or Mock(), consumer="w1", **kwargs)


def test_stream_and_group_names():
    assert (STREAM_KEY, CONSUMER_GROUP) == ("media:uploads", "media-workers")


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        (
            {"video_id": "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f"},
            "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f",
        ),
        ({"video_id": "abc_123"}, "abc_123"),
        ({"video_id": "../etc"}, None),
        ({"video_id": "a/b"}, None),
        ({"video_id": ""}, None),
        ({"video_id": "x" * 129}, None),
        ({"other": "1"}, None),
        ({}, None),
        (None, None),
    ],
)
def test_parse_video_id(fields, expected):
    assert parse_video_id(fields) == expected


def test_ensure_group_creates_group_and_stream_once():
    redis = FakeRedis()
    consumer = make_consumer(redis)
    consumer.ensure_group()
    consumer.ensure_group()
    assert redis.groups == {(STREAM_KEY, CONSUMER_GROUP)}


def test_ensure_group_propagates_other_errors():
    redis = Mock()
    redis.xgroup_create.side_effect = ResponseError("NOPERM")
    with pytest.raises(ResponseError):
        make_consumer(redis).ensure_group()


def test_poll_handles_and_acks_each_message():
    redis = FakeRedis()
    ids = [redis.xadd(STREAM_KEY, {"video_id": v}) for v in ("a", "b")]
    handler = Mock()
    assert make_consumer(redis, handler).poll() == 2
    assert [call.args[0] for call in handler.call_args_list] == ["a", "b"]
    assert redis.acks == ids
    assert redis.pending == {}


def test_poll_passes_block_and_count_to_redis():
    redis = Mock()
    redis.xreadgroup.return_value = None
    assert make_consumer(redis, block_ms=1234, count=7).poll() == 0
    redis.xreadgroup.assert_called_once_with(
        CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=7, block=1234
    )


def test_invalid_event_is_acked_and_discarded(caplog):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "../../x"})
    handler = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.consumer"):
        make_consumer(redis, handler).poll()
    handler.assert_not_called()
    assert redis.acks == [message_id]
    assert message_id in caplog.text


def test_handler_error_leaves_message_pending():
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a"})
    handler = Mock(side_effect=ConnectionError("postgres caído"))
    with pytest.raises(ConnectionError):
        make_consumer(redis, handler).poll()
    assert redis.acks == []
    assert message_id in redis.pending


def test_recover_pending_retries_unacked_messages_after_restart():
    redis = FakeRedis()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    with pytest.raises(ConnectionError):
        make_consumer(redis, Mock(side_effect=ConnectionError())).poll()
    handler = Mock()
    assert make_consumer(redis, handler).recover_pending() == 1
    handler.assert_called_once_with("a")
    assert redis.pending == {}


def test_run_recovers_pending_then_consumes_until_stopped():
    redis = FakeRedis()
    stop = threading.Event()
    seen = []

    def handler(video_id):
        seen.append(video_id)
        if video_id == "new":
            stop.set()

    redis.xadd(STREAM_KEY, {"video_id": "old"})
    redis.xreadgroup(CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=1)  # entregado y sin ACK
    redis.xadd(STREAM_KEY, {"video_id": "new"})
    make_consumer(redis, handler).run(stop)
    assert seen == ["old", "new"]
    assert redis.pending == {}


def test_run_without_pending_goes_straight_to_new_events(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    with caplog.at_level(logging.INFO, logger="media_worker.consumer"):
        make_consumer(redis, lambda _video_id: stop.set()).run(stop)
    assert redis.pending == {}
    assert "pendientes" not in caplog.text


def test_run_logs_recovered_events(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    redis.xreadgroup(CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=1)
    redis.xadd(STREAM_KEY, {"video_id": "b"})
    handler = Mock(side_effect=lambda video_id: video_id == "b" and stop.set())
    with caplog.at_level(logging.INFO, logger="media_worker.consumer"):
        make_consumer(redis, handler).run(stop)
    assert "reprocesados 1 eventos pendientes" in caplog.text


def test_run_returns_immediately_when_already_stopped():
    redis = FakeRedis()
    stop = threading.Event()
    stop.set()
    handler = Mock()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    make_consumer(redis, handler).run(stop)
    handler.assert_not_called()
    assert redis.groups == {(STREAM_KEY, CONSUMER_GROUP)}
