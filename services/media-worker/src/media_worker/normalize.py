"""Normalización del vídeo a MP4 H.264 + AAC con FFmpeg."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

# Una película de 2-3 h tarda en re-codificarse; el timeout mata FFmpeg si se cuelga.
DEFAULT_TIMEOUT_S = 4 * 3600


PROBE_TIMEOUT_S = 30


class NormalizeError(Exception):
    """No se pudo normalizar el vídeo."""


def is_normalized(src: Path, runner=subprocess.run, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """True si `src` ya es MP4 con primer vídeo H.264 `yuv420p` y primer audio AAC (si hay).

    Cualquier duda (ffprobe falla, salida ilegible) devuelve False: se normaliza como siempre.
    """
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt:format=format_name",
        "-of",
        "json",
        str(src),
    ]
    try:
        result = runner(cmd, capture_output=True, text=True, check=False, timeout=timeout)
        if result.returncode != 0:
            return False
        info = json.loads(result.stdout)
        containers = info["format"]["format_name"].split(",")
        streams = info["streams"]
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError, TypeError, AttributeError):
        return False
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return (
        "mp4" in containers
        and video is not None
        and video.get("codec_name") == "h264"
        and video.get("pix_fmt") == "yuv420p"
        and (audio is None or audio.get("codec_name") == "aac")
    )


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
