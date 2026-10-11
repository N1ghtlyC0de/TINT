import json
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from media_worker.storage import BlobNotFoundError, S3BlobStore, ambilight_key, source_key


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "GetObject")


def test_ambilight_key_is_deterministic_per_video():
    assert ambilight_key("abc") == "abc/ambilight.json"


def test_source_key_is_always_mp4():
    assert source_key("abc") == "abc/source.mp4"


def test_upload_file_puts_local_file_under_key(tmp_path):
    client = Mock()
    path = tmp_path / "clip.mp4"
    S3BlobStore(client, "tint-media").upload_file(path, "v1/source.mp4")
    client.upload_file.assert_called_once_with(str(path), "tint-media", "v1/source.mp4")


def test_download_fetches_object_to_destination(tmp_path):
    client = Mock()
    S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "source.mp4")
    client.download_file.assert_called_once_with(
        "tint-media", "v1/source.mp4", str(tmp_path / "source.mp4")
    )


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_download_missing_object_raises_blob_not_found(tmp_path, code):
    client = Mock()
    client.download_file.side_effect = client_error(code)
    with pytest.raises(BlobNotFoundError, match="v1/source.mp4"):
        S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "s.mp4")


def test_download_propagates_other_errors(tmp_path):
    client = Mock()
    client.download_file.side_effect = client_error("AccessDenied")
    with pytest.raises(ClientError):
        S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "s.mp4")


def test_put_json_overwrites_key_with_compact_json():
    client = Mock()
    data = [
        {"t_ms": 0, "top": "#000000", "bottom": "#000000", "left": "#000000", "right": "#000000"}
    ]
    S3BlobStore(client, "tint-media").put_json("v1/ambilight.json", data)
    kwargs = client.put_object.call_args.kwargs
    assert kwargs["Bucket"] == "tint-media"
    assert kwargs["Key"] == "v1/ambilight.json"
    assert kwargs["ContentType"] == "application/json"
    assert json.loads(kwargs["Body"]) == data
    assert b" " not in kwargs["Body"]
