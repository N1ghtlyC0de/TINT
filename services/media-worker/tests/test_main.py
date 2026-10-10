from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from media_worker.__main__ import DEFAULT_VIDEOS_DIR, main, resolve_video


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
