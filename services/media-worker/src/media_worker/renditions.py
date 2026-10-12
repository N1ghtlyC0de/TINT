"""Calidades reducidas (720p, 360p) del vídeo normalizado, publicadas junto a `source.mp4`."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from media_worker.normalize import DEFAULT_TIMEOUT_S
from media_worker.storage import rendition_key

logger = logging.getLogger(__name__)

# Alturas objetivo en orden descendente; solo se generan las menores que la del original.
RENDITION_HEIGHTS = (720, 360)

__all__ = [
    "DEFAULT_TIMEOUT_S",
    "RENDITION_HEIGHTS",
    "ffmpeg_rendition_cmd",
    "generate_renditions",
    "plan_renditions",
]


def plan_renditions(source_height: int | None) -> list[int]:
    """Alturas de `RENDITION_HEIGHTS` estrictamente menores que `source_height` (desc.)."""
    if not source_height:
        return []
    return [height for height in RENDITION_HEIGHTS if height < source_height]


def ffmpeg_rendition_cmd(src: str, dest: str, height: int) -> list[str]:
    """Comando FFmpeg que reescala a `height` (ancho par proporcional) en MP4 H.264 + AAC."""
    return [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        src,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        f"scale=-2:{height}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dest,
    ]


def _transcode(src: Path, dest: Path, height: int, runner, timeout: float) -> str | None:
    """Ejecuta FFmpeg; devuelve el motivo del fallo o None si terminó bien."""
    try:
        result = runner(
            ffmpeg_rendition_cmd(str(src), str(dest), height),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"ffmpeg excedió el tiempo límite ({timeout} s)"
    except OSError as exc:
        return f"no se pudo ejecutar ffmpeg: {exc}"
    if result.returncode != 0:
        return (result.stderr or "").strip() or "ffmpeg falló"
    return None


def generate_renditions(
    video_id: str,
    source_path: Path,
    source_height: int | None,
    blobs,
    runner=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> list[int]:
    """Re-codifica y publica en `rendition_key` cada calidad planificada.

    Una calidad que FFmpeg no logra generar se omite con un aviso: no invalida el vídeo. Los
    errores del bucket se propagan, como en el resto del pipeline, para poder reintentar.
    Devuelve las alturas publicadas, en orden descendente.
    """
    published = []
    for height in plan_renditions(source_height):
        with tempfile.TemporaryDirectory(prefix="media-worker-rendition-") as workdir:
            dest = Path(workdir) / f"{height}p.mp4"
            error = _transcode(source_path, dest, height, runner, timeout)
            if error is not None:
                logger.warning("vídeo %s: se omite la calidad %dp: %s", video_id, height, error)
                continue
            blobs.upload_file(dest, rendition_key(video_id, height))
        published.append(height)
    return published
