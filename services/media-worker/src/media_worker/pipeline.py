"""Preprocesamiento completo de un vídeo antes de publicarlo: processing -> ready | failed."""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
from pathlib import Path

from media_worker.ambilight import AmbilightError, extract_ambilight
from media_worker.normalize import NormalizeError, is_normalized, normalize_video
from media_worker.probe import VideoStatus, inspect_status
from media_worker.storage import ambilight_key, source_key

logger = logging.getLogger(__name__)

# El id forma parte de las claves del bucket: se rechaza cualquier cosa que no sea un id plano.
VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


class InvalidVideoIdError(ValueError):
    """El `video_id` recibido no es un id plano válido."""


class VideoNotFoundError(LookupError):
    """El vídeo no existe en la tabla `videos` (el worker no crea filas)."""


def validate_video_id(video_id: object) -> str:
    """Devuelve `video_id` si es un id plano; si no, lanza `InvalidVideoIdError`."""
    if isinstance(video_id, str) and VIDEO_ID_PATTERN.fullmatch(video_id):
        return video_id
    raise InvalidVideoIdError(f"video_id inválido: {video_id!r}")


def process_video(
    video_id: str,
    source: Path,
    repo,
    blobs,
    runner=subprocess.run,
    popen=subprocess.Popen,
) -> VideoStatus:
    """Normaliza a MP4 y extrae el Ambilight de `source`; solo entonces publica en el bucket.

    Si `source` ya es MP4 H.264 + AAC no se re-codifica: se publica tal cual.

    El vídeo recibido nunca se sube sin preprocesar: si es inválido o falla la normalización
    o la extracción Ambilight queda en `failed` y no se publica nada. `source` pertenece a quien
    llama (la API), que lo borra cuando quiera.

    Los errores de entrada se lanzan antes de tocar SQL o el bucket: `InvalidVideoIdError` si el
    id no es válido y `VideoNotFoundError` si la fila no existe. Los errores de infraestructura
    (SQL, S3) se propagan sin marcar `failed` para que quien llama pueda reintentar.
    """
    validate_video_id(video_id)
    if not repo.start_processing(video_id):
        raise VideoNotFoundError(f"vídeo {video_id} no existe en la tabla videos")

    status, duration_ms = inspect_status(str(source), runner)
    if status is VideoStatus.FAILED:
        repo.mark_failed(video_id)
        return VideoStatus.FAILED

    with tempfile.TemporaryDirectory(prefix="media-worker-") as workdir:
        normalized = Path(workdir) / "source.mp4"
        try:
            if is_normalized(source, runner):
                logger.info("vídeo %s ya está normalizado: se omite la re-codificación", video_id)
                normalized = source
            else:
                normalize_video(source, normalized, runner)
            palette = extract_ambilight(str(normalized), duration_ms, popen)
        except NormalizeError as exc:
            return _fail(repo, video_id, f"normalización: {exc}")
        except AmbilightError as exc:
            return _fail(repo, video_id, f"extracción ambilight: {exc}")

        # Se publica todo antes de marcar `ready`: `ready` implica que existen vídeo y ambilight.
        storage_key = source_key(video_id)
        blobs.upload_file(normalized, storage_key)
        blobs.put_json(ambilight_key(video_id), palette)
    repo.mark_ready(video_id, duration_ms, storage_key)
    logger.info("vídeo %s listo (%d ms, %d muestras)", video_id, duration_ms, len(palette))
    return VideoStatus.READY


def _fail(repo, video_id: str, reason: str) -> VideoStatus:
    logger.warning("vídeo %s marcado como failed: %s", video_id, reason)
    repo.mark_failed(video_id)
    return VideoStatus.FAILED
