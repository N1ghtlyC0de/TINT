"""Configuración del worker a partir de variables de entorno (sin credenciales por defecto)."""

from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field

OPTIONAL_VARS = {
    "REDIS_URL": "redis_url",
    "S3_ENDPOINT_URL": "s3_endpoint_url",
    "MINIO_BUCKET": "bucket",
    "MEDIA_WORKER_CONSUMER": "consumer_name",
}


class ConfigError(Exception):
    """Faltan variables de entorno obligatorias."""


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_access_key: str
    s3_secret_key: str = field(repr=False)
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint_url: str = "http://localhost:9000"
    bucket: str = "tint-media"
    consumer_name: str = field(default_factory=socket.gethostname)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Lee la configuración; las credenciales S3 caen a las de MinIO del `.env` local."""
        env = os.environ if env is None else env
        required = {
            "DATABASE_URL": env.get("DATABASE_URL"),
            "S3_ACCESS_KEY": env.get("S3_ACCESS_KEY") or env.get("MINIO_ROOT_USER"),
            "S3_SECRET_KEY": env.get("S3_SECRET_KEY") or env.get("MINIO_ROOT_PASSWORD"),
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ConfigError(f"faltan variables de entorno: {', '.join(missing)}")
        optional = {attr: env[var] for var, attr in OPTIONAL_VARS.items() if env.get(var)}
        return cls(
            database_url=required["DATABASE_URL"],
            s3_access_key=required["S3_ACCESS_KEY"],
            s3_secret_key=required["S3_SECRET_KEY"],
            **optional,
        )
