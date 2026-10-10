"""Acceso al Blob Storage (MinIO/S3): descarga del original y publicación de artefactos."""

from __future__ import annotations

import json
from pathlib import Path

from botocore.exceptions import ClientError

NOT_FOUND_CODES = {"404", "NoSuchKey", "NotFound"}


class BlobNotFoundError(Exception):
    """La clave pedida no existe en el bucket."""


def ambilight_key(video_id: str) -> str:
    """Clave determinista del artefacto: reprocesar sobrescribe en vez de duplicar."""
    return f"{video_id}/ambilight.json"


class S3BlobStore:
    def __init__(self, client, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def download(self, key: str, dest: Path) -> None:
        try:
            self.client.download_file(self.bucket, key, str(dest))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in NOT_FOUND_CODES:
                raise BlobNotFoundError(f"no existe {self.bucket}/{key}") from exc
            raise

    def put_json(self, key: str, data: object) -> None:
        body = json.dumps(data, separators=(",", ":")).encode()
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=body, ContentType="application/json"
        )
