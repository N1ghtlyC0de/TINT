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
    "-show_entries",
    "format=duration",
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


def probe_duration_ms(path: str, runner=subprocess.run, timeout: float = DEFAULT_TIMEOUT_S) -> int:
    """Ejecuta ffprobe sobre `path` y devuelve la duración en ms."""
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
    return parse_duration_ms(result.stdout)


def inspect_status(path: str, runner=subprocess.run) -> tuple[VideoStatus, int | None]:
    """Devuelve el estado a persistir en SQL y la duración si fue válida."""
    try:
        return VideoStatus.READY, probe_duration_ms(path, runner)
    except ProbeError as exc:
        logger.warning("vídeo %s marcado como failed: %s", path, exc)
        return VideoStatus.FAILED, None
    except OSError as exc:
        logger.error("no se pudo ejecutar ffprobe sobre %s: %s", path, exc)
        return VideoStatus.FAILED, None
