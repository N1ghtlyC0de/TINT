"""Inspección de archivos de vídeo mediante ffprobe."""

from __future__ import annotations

import json
import logging
import math
import subprocess
from enum import StrEnum

logger = logging.getLogger(__name__)


class VideoStatus(StrEnum):
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class ProbeError(Exception):
    """El archivo no pudo inspeccionarse (corrupto o ilegible)."""


DEFAULT_TIMEOUT_S = 30

FFPROBE_CMD = (
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=duration:stream=height",
    "-of",
    "json",
)


def parse_duration_ms(ffprobe_output: str) -> int:
    """Extrae la duración en milisegundos de la salida JSON de ffprobe."""
    try:
        duration = float(json.loads(ffprobe_output)["format"]["duration"])
    except (ValueError, KeyError, TypeError) as exc:
        raise ProbeError("salida de ffprobe inválida") from exc
    if not math.isfinite(duration):
        raise ProbeError("duración no finita")
    if duration <= 0:
        raise ProbeError("duración no positiva")
    return round(duration * 1000)


def parse_height(ffprobe_output: str) -> int | None:
    """Altura en píxeles del primer stream de vídeo, o None si no se conoce.

    La altura solo decide qué calidades reducidas se generan: si falta o es ilegible no se
    invalida el vídeo, simplemente no se generan calidades.
    """
    try:
        height = json.loads(ffprobe_output)["streams"][0]["height"]
    except (ValueError, KeyError, TypeError, IndexError):
        return None
    if type(height) is not int or height <= 0:
        return None
    return height


def probe_media(
    path: str, runner=subprocess.run, timeout: float = DEFAULT_TIMEOUT_S
) -> tuple[int, int | None]:
    """Ejecuta ffprobe una sola vez sobre `path`: `(duración en ms, altura o None)`."""
    output = _run_ffprobe(path, runner, timeout)
    return parse_duration_ms(output), parse_height(output)


def probe_duration_ms(path: str, runner=subprocess.run, timeout: float = DEFAULT_TIMEOUT_S) -> int:
    """Ejecuta ffprobe sobre `path` y devuelve la duración en ms."""
    return parse_duration_ms(_run_ffprobe(path, runner, timeout))


def _run_ffprobe(path: str, runner, timeout: float) -> str:
    try:
        result = runner(
            [*FFPROBE_CMD, path],
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe excedió el tiempo límite ({timeout} s)") from exc
    if result.returncode != 0:
        raise ProbeError(result.stderr.strip() or "ffprobe falló")
    return result.stdout


def inspect_media(path: str, runner=subprocess.run) -> tuple[VideoStatus, int | None, int | None]:
    """Estado a persistir en SQL, duración y altura (ambas None si el archivo no es válido)."""
    try:
        duration_ms, height = probe_media(path, runner)
    except ProbeError as exc:
        logger.warning("vídeo %s marcado como failed: %s", path, exc)
        return VideoStatus.FAILED, None, None
    except OSError as exc:
        logger.error("no se pudo ejecutar ffprobe sobre %s: %s", path, exc)
        return VideoStatus.FAILED, None, None
    return VideoStatus.READY, duration_ms, height


def inspect_status(path: str, runner=subprocess.run) -> tuple[VideoStatus, int | None]:
    """Devuelve el estado a persistir en SQL y la duración si fue válida."""
    status, duration_ms, _ = inspect_media(path, runner)
    return status, duration_ms
