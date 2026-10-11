import pytest

from media_worker.config import ConfigError, Settings

BASE_ENV = {
    "DATABASE_URL": "postgresql://tint:tint@db:5432/tint",
    "S3_ACCESS_KEY": "key",
    "S3_SECRET_KEY": "secret",
}


def test_from_env_uses_local_defaults():
    settings = Settings.from_env(BASE_ENV)
    assert settings.database_url == BASE_ENV["DATABASE_URL"]
    assert settings.s3_endpoint_url == "http://localhost:9000"
    assert settings.bucket == "tint-media"


def test_from_env_reads_overrides():
    env = {**BASE_ENV, "S3_ENDPOINT_URL": "http://minio:9000", "MINIO_BUCKET": "otro"}
    settings = Settings.from_env(env)
    assert (settings.s3_endpoint_url, settings.bucket) == ("http://minio:9000", "otro")


def test_settings_have_no_redis_configuration():
    env = {**BASE_ENV, "REDIS_URL": "redis://redis:6379/1", "MEDIA_WORKER_CONSUMER": "worker-a"}
    settings = Settings.from_env(env)
    assert not hasattr(settings, "redis_url")
    assert not hasattr(settings, "consumer_name")


def test_from_env_falls_back_to_minio_root_credentials():
    env = {
        "DATABASE_URL": "postgresql://x",
        "MINIO_ROOT_USER": "u",
        "MINIO_ROOT_PASSWORD": "p",
    }
    settings = Settings.from_env(env)
    assert (settings.s3_access_key, settings.s3_secret_key) == ("u", "p")


def test_from_env_reports_all_missing_variables():
    with pytest.raises(ConfigError, match="DATABASE_URL, S3_ACCESS_KEY, S3_SECRET_KEY"):
        Settings.from_env({})


def test_from_env_reads_process_environment(monkeypatch):
    for name, value in BASE_ENV.items():
        monkeypatch.setenv(name, value)
    assert Settings.from_env().s3_access_key == "key"


def test_secret_is_not_in_repr():
    assert "secret" not in repr(Settings.from_env(BASE_ENV))
