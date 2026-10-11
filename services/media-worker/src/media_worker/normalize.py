"""Normalización del vídeo a MP4 H.264 + AAC con FFmpeg."""

from __future__ import annotations

import subprocess
from pathlib import Path

# Una película de 2-3 h tarda en re-codificarse; el timeout mata FFmpeg si se cuelga.
DEFAULT_TIMEOUT_S = 4 * 3600


class NormalizeError(Exception):
    """No se pudo normalizar el vídeo."""


def ffmpeg_normalize_cmd(src: str, dest: str) -> list[str]:
    """Comando FFmpeg que re-codifica a MP4 H.264 (yuv420p) + AAC listo para streaming."""
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


def normalize_video(
    src: Path, dest: Path, runner=subprocess.run, timeout: float = DEFAULT_TIMEOUT_S
) -> None:
    """Escribe en `dest` la versión MP4 H.264 + AAC de `src`; trabaja de archivo a archivo."""
    try:
        result = runner(
            ffmpeg_normalize_cmd(str(src), str(dest)),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise NormalizeError(f"ffmpeg excedió el tiempo límite ({timeout} s)") from exc
    except OSError as exc:
        raise NormalizeError(f"no se pudo ejecutar ffmpeg: {exc}") from exc
    if result.returncode != 0:
        raise NormalizeError((result.stderr or "").strip() or "ffmpeg falló")
