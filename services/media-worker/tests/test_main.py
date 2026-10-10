import json
import signal
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fakes import FakePopen, solid_frame

import media_worker.__main__ as entrypoint
from media_worker.__main__ import DEFAULT_VIDEOS_DIR, build_consumer, main, resolve_video
from media_worker.config import Settings
from media_worker.pipeline import process_video


def fake_run(returncode=0, stdout="", stderr=""):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def test_main_without_path_reports_supported_states(capsys):
    message = main([])
    assert message == "media-worker listo (estados soportados: processing, ready, failed)"
    assert capsys.readouterr().out.strip() == message


def test_main_reports_ready_with_duration(capsys):
    runner = fake_run(stdout='{"format": {"duration": "2.5"}}')
    message = main(["/abs/ok.mp4"], runner=runner)
    assert message == "/abs/ok.mp4: ready (2500 ms)"
    assert capsys.readouterr().out.strip() == message


def test_main_reports_failed_without_duration(capsys):
    message = main(["/abs/bad.mp4"], runner=fake_run(returncode=1, stderr="corrupt"))
    assert message == "/abs/bad.mp4: failed"
    assert capsys.readouterr().out.strip() == message


def test_default_videos_dir_is_videos_outside_src():
    assert DEFAULT_VIDEOS_DIR.name == "videos"
    assert (DEFAULT_VIDEOS_DIR.parent / "pyproject.toml").is_file()


def test_resolve_video_bare_name_uses_videos_dir(tmp_path):
    assert resolve_video("clip.mp4", tmp_path) == str(tmp_path / "clip.mp4")


def test_resolve_video_keeps_paths_with_directories(tmp_path):
    assert resolve_video("sub/clip.mp4", tmp_path) == "sub/clip.mp4"
    assert resolve_video("/abs/clip.mp4", tmp_path) == "/abs/clip.mp4"


def test_main_bare_name_is_looked_up_in_videos_dir(tmp_path):
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    message = main(["clip.mp4", "--videos-dir", str(tmp_path)], runner=runner)
    assert message == f"{tmp_path / 'clip.mp4'}: ready (1000 ms)"
    assert runner.call_args.args[0][-1] == str(tmp_path / "clip.mp4")


def test_main_default_videos_dir_when_no_option():
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    main(["clip.mp4"], runner=runner)
    assert runner.call_args.args[0][-1] == str(DEFAULT_VIDEOS_DIR / "clip.mp4")


def test_main_rejects_unknown_arguments():
    with pytest.raises(SystemExit) as exc:
        main(["--nope"])
    assert exc.value.code == 2


def test_main_writes_ambilight_json(tmp_path):
    out = tmp_path / "ambilight.json"
    runner = fake_run(stdout='{"format": {"duration": "1.5"}}')
    popen = FakePopen(stdout=solid_frame((0, 0, 255)) * 2)
    message = main(["/abs/ok.mp4", "--ambilight", str(out)], runner=runner, popen=popen)
    assert message == f"/abs/ok.mp4: ready (1500 ms); ambilight: {out} (2 muestras)"
    palette = json.loads(out.read_text())
    assert [entry["t_ms"] for entry in palette] == [0, 1000]
    assert palette[1]["left"] == "#0000ff"


def test_main_ambilight_failure_reports_failed(tmp_path):
    out = tmp_path / "ambilight.json"
    runner = fake_run(stdout='{"format": {"duration": "1"}}')
    popen = FakePopen(returncode=1, stderr=b"decode error")
    message = main(["/abs/ok.mp4", "--ambilight", str(out)], runner=runner, popen=popen)
    assert message == "/abs/ok.mp4: failed (ambilight: decode error)"
    assert not out.exists()


def test_main_skips_ambilight_for_corrupt_video(tmp_path):
    popen = FakePopen()
    message = main(
        ["/abs/bad.mp4", "--ambilight", str(tmp_path / "a.json")],
        runner=fake_run(returncode=1),
        popen=popen,
    )
    assert message == "/abs/bad.mp4: failed"
    assert popen.calls == []


@pytest.mark.parametrize(
    "argv",
    [["--ambilight", "a.json"], ["--consume", "clip.mp4"], ["--consume", "--ambilight", "a"]],
)
def test_main_rejects_incompatible_options(argv):
    with pytest.raises(SystemExit) as exc:
        main(argv)
    assert exc.value.code == 2


def test_main_consume_runs_consumer(monkeypatch, capsys):
    run_consumer = Mock()
    monkeypatch.setattr(entrypoint, "run_consumer", run_consumer)
    assert main(["--consume"]) == "media-worker detenido"
    run_consumer.assert_called_once_with()


def test_main_consume_without_config_exits_with_clear_error(monkeypatch, capsys):
    for name in (
        "DATABASE_URL",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
        "MINIO_ROOT_USER",
        "MINIO_ROOT_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(SystemExit) as exc:
        main(["--consume"])
    assert exc.value.code == 1
    assert "faltan variables de entorno: DATABASE_URL" in capsys.readouterr().err


SETTINGS = Settings(
    database_url="postgresql://db/tint",
    s3_access_key="key",
    s3_secret_key="secret",
    redis_url="redis://redis:6379/0",
    s3_endpoint_url="http://minio:9000",
    bucket="tint-media",
    consumer_name="worker-a",
)


@pytest.fixture
def clients(monkeypatch):
    fakes = SimpleNamespace(redis=Mock(), s3=Mock(), conn=Mock())
    from_url = Mock(return_value=fakes.redis)
    boto_client = Mock(return_value=fakes.s3)
    connect = Mock(return_value=fakes.conn)
    monkeypatch.setattr(entrypoint.redis.Redis, "from_url", from_url)
    monkeypatch.setattr(entrypoint.boto3, "client", boto_client)
    monkeypatch.setattr(entrypoint.psycopg, "connect", connect)
    fakes.from_url, fakes.boto_client, fakes.connect = from_url, boto_client, connect
    return fakes


def test_build_consumer_wires_clients_from_settings(clients):
    consumer = build_consumer(SETTINGS)
    clients.from_url.assert_called_once_with("redis://redis:6379/0", decode_responses=True)
    clients.boto_client.assert_called_once_with(
        "s3",
        endpoint_url="http://minio:9000",
        aws_access_key_id="key",
        aws_secret_access_key="secret",
    )
    clients.connect.assert_called_once_with("postgresql://db/tint", autocommit=True)
    assert consumer.redis is clients.redis
    assert consumer.consumer == "worker-a"
    handler = consumer.handler
    assert handler.func is process_video
    assert handler.keywords["repo"].conn is clients.conn
    assert handler.keywords["blobs"].client is clients.s3
    assert handler.keywords["blobs"].bucket == "tint-media"


def test_run_consumer_installs_stop_handlers_and_runs(clients, monkeypatch):
    installed = {}
    monkeypatch.setattr(entrypoint.signal, "signal", lambda sig, fn: installed.setdefault(sig, fn))
    run = Mock()
    monkeypatch.setattr(entrypoint.StreamConsumer, "run", run)
    entrypoint.run_consumer(SETTINGS)
    stop = run.call_args.args[0]
    assert set(installed) == {signal.SIGTERM, signal.SIGINT}
    assert not stop.is_set()
    installed[signal.SIGTERM](signal.SIGTERM, None)
    assert stop.is_set()


def test_run_consumer_reads_settings_from_env(clients, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://env/tint")
    monkeypatch.setenv("S3_ACCESS_KEY", "k")
    monkeypatch.setenv("S3_SECRET_KEY", "s")
    monkeypatch.setattr(entrypoint, "install_stop_handlers", Mock())
    monkeypatch.setattr(entrypoint.StreamConsumer, "run", Mock())
    entrypoint.run_consumer()
    clients.connect.assert_called_once_with("postgresql://env/tint", autocommit=True)
