"""Procesa una subida directa del navegador: descarga el original y llama al pipeline.

identity-api firma un PUT a `incoming/{video_id}/original.<ext>` (zona de staging, nunca la clave
publicada) y guarda esa clave en `videos.storage_key`. Aquí se descarga a un archivo temporal y se
pasa a `pipeline.process_video` sin modificarlo: solo si el vídeo es válido se publica en
`{video_id}/source.mp4` (ya normalizado) y `mark_ready` actualiza `storage_key`. El staging lo
limpia la regla de ciclo de vida del bucket (`minio-init`), así no se corta a quien ya lo está
reproduciendo.
"""

from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path, PurePosixPath

from media_worker.pipeline import (
    InvalidVideoIdError,
    UnsupportedFormatError,
    VideoNotFoundError,
    process_video,
    validate_extension,
)
from media_worker.probe import VideoStatus
from media_worker.storage import BlobNotFoundError

logger = logging.getLogger(__name__)

INCOMING_PREFIX = "incoming/"


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def handle_upload(video_id: str, repo, blobs, process=None) -> VideoStatus | None:
    """Procesa el vídeo; None si el evento no corresponde a un vídeo procesable.

    Los fallos de infraestructura (SQL, S3) se propagan para que el evento quede pendiente.
    """
    if not _is_uuid(video_id):
        # videos.id es uuid: PostgreSQL rechazaría el id en cada reintento (evento venenoso).
        logger.warning("video_id %r no es un UUID; se descarta", video_id)
        return None
    row = repo.get_video(video_id)
    if row is None:
        logger.warning("vídeo %s no existe en la tabla videos; se descarta", video_id)
        return None
    status, key = row
    if status == VideoStatus.READY.value and not key.startswith(INCOMING_PREFIX):
        logger.info("vídeo %s ya publicado en %s; evento duplicado", video_id, key)
        return VideoStatus.READY

    try:
        validate_extension(key)
    except UnsupportedFormatError as exc:
        # Reintentar no cambia la extensión: se marca failed sin descargar el archivo.
        logger.warning("vídeo %s rechazado: %s", video_id, exc)
        repo.mark_failed(video_id)
        return VideoStatus.FAILED

    process = process or process_video
    with tempfile.TemporaryDirectory(prefix="tint-media-") as workdir:
        local = Path(workdir) / f"original{PurePosixPath(key).suffix}"
        try:
            blobs.download(key, local)
        except BlobNotFoundError:
            logger.warning("vídeo %s: no está %s en el bucket; se marca failed", video_id, key)
            repo.mark_failed(video_id)
            return VideoStatus.FAILED
        try:
            return process(video_id, local, repo, blobs)
        except (InvalidVideoIdError, VideoNotFoundError) as exc:
            logger.warning("vídeo %s descartado: %s", video_id, exc)
            return None
