from types import SimpleNamespace
from unittest.mock import Mock

from media_worker.__main__ import main


def fake_run(returncode=0, stdout="", stderr=""):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def test_main_without_path_reports_supported_states(capsys):
    message = main()
    assert message == "media-worker listo (estados soportados: processing, ready, failed)"
    assert capsys.readouterr().out.strip() == message


def test_main_reports_ready_with_duration(capsys):
    runner = fake_run(stdout='{"format": {"duration": "2.5"}}')
    message = main("ok.mp4", runner=runner)
    assert message == "ok.mp4: ready (2500 ms)"
    assert capsys.readouterr().out.strip() == message


def test_main_reports_failed_without_duration(capsys):
    message = main("bad.mp4", runner=fake_run(returncode=1, stderr="corrupt"))
    assert message == "bad.mp4: failed"
    assert capsys.readouterr().out.strip() == message
