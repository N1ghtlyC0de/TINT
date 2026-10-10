"""Procesamiento completo de un vídeo: processing -> ready | failed."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from media_worker.ambilight import AmbilightError, extract_ambilight
from media_worker.probe import VideoStatus, inspect_status
from media_worker.storage import BlobNotFoundError, ambilight_key

logger = logging.getLogger(__name__)


def process_video(
    video_id: str,
    repo,
    blobs,
    runner=subprocess.run,
    popen=subprocess.Popen,
    workdir: str | None = None,
) -> VideoStatus | None:
    """Inspecciona el original, publica `ambilight.json` y deja el vídeo en `ready` o `failed`.

    Devuelve None si la fila no existe (el worker no crea filas en `videos`). Los errores de
    infraestructura (SQL, S3) se propagan para que el evento no se confirme y se reintente.
    """
    storage_key = repo.start_processing(video_id)
    if storage_key is None:
        logger.warning("vídeo %s no existe en la tabla videos; se ignora el evento", video_id)
        return None
    if not storage_key:
        return _fail(repo, video_id, "sin storage_key")

    with tempfile.TemporaryDirectory(prefix="media-worker-", dir=workdir) as tmp:
        source = Path(tmp) / f"source{Path(storage_key).suffix}"
        try:
            blobs.download(storage_key, source)
        except BlobNotFoundError as exc:
            return _fail(repo, video_id, str(exc))

        status, duration_ms = inspect_status(str(source), runner)
        if status is VideoStatus.FAILED:
            repo.mark_failed(video_id)
            return VideoStatus.FAILED

        try:
            palette = extract_ambilight(str(source), duration_ms, popen)
        except AmbilightError as exc:
            return _fail(repo, video_id, f"extracción ambilight: {exc}")

    # El artefacto se publica antes de marcar `ready`: `ready` implica que ambilight.json existe.
    blobs.put_json(ambilight_key(video_id), palette)
    repo.mark_ready(video_id, duration_ms)
    logger.info("vídeo %s listo (%d ms, %d muestras)", video_id, duration_ms, len(palette))
    return VideoStatus.READY


def _fail(repo, video_id: str, reason: str) -> VideoStatus:
    logger.warning("vídeo %s marcado como failed: %s", video_id, reason)
    repo.mark_failed(video_id)
    return VideoStatus.FAILED
