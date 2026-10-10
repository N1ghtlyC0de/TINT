"""Extracción de la paleta Ambilight: franjas de borde y colores a 1 FPS con FFmpeg."""

from __future__ import annotations

import subprocess
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from typing import IO

EDGE_RATIO = 0.10
SAMPLE_FPS = 1
MAX_FPS = 1000

FRAME_WIDTH = 160
FRAME_HEIGHT = 90
DEFAULT_EXTRACT_TIMEOUT_S = 3600


class AmbilightError(Exception):
    """No se pudieron extraer los fotogramas del vídeo."""


@dataclass(frozen=True)
class Region:
    """Rectángulo en píxeles (x, y, ancho, alto)."""

    x: int
    y: int
    width: int
    height: int


def edge_regions(width: int, height: int, ratio: float = EDGE_RATIO) -> dict[str, Region]:
    """Devuelve las franjas top/bottom/left/right del `ratio` de cada borde."""
    if width <= 0 or height <= 0:
        raise ValueError("las dimensiones deben ser positivas")
    if not 0 < ratio <= 0.5:
        raise ValueError("ratio debe estar en (0, 0.5]")
    band_h = max(1, round(height * ratio))
    band_w = max(1, round(width * ratio))
    return {
        "top": Region(0, 0, width, band_h),
        "bottom": Region(0, height - band_h, width, band_h),
        "left": Region(0, 0, band_w, height),
        "right": Region(width - band_w, 0, band_w, height),
    }


def average_color(pixels: list[tuple[int, int, int]]) -> str:
    """Promedia una lista de píxeles RGB y devuelve un color hex `#rrggbb`."""
    if not pixels:
        raise ValueError("se requiere al menos un píxel")
    return _hex(*(sum(p[i] for p in pixels) for i in range(3)), len(pixels))


def _hex(r_sum: int, g_sum: int, b_sum: int, n: int) -> str:
    r, g, b = (round(total / n) for total in (r_sum, g_sum, b_sum))
    return f"#{r:02x}{g:02x}{b:02x}"


def sample_timestamps_ms(duration_ms: int, fps: int = SAMPLE_FPS) -> list[int]:
    """Instantes (ms) a muestrear para generar ambilight.json."""
    if duration_ms < 0:
        raise ValueError("la duración no puede ser negativa")
    if not 0 < fps <= MAX_FPS:
        raise ValueError(f"fps debe estar en (0, {MAX_FPS}], recibido {fps}")
    step = 1000 // fps
    return list(range(0, duration_ms, step))


def ffmpeg_frames_cmd(path: str, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT) -> list[str]:
    """Comando FFmpeg que emite por stdout un fotograma `rgb24` reducido por segundo."""
    return [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-vf",
        f"fps={SAMPLE_FPS},scale={width}:{height}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]


def region_color(frame: bytes, width: int, region: Region) -> str:
    """Color promedio hex de `region` dentro de un fotograma `rgb24` de ancho `width`."""
    r_sum = g_sum = b_sum = 0
    row_bytes = width * 3
    for y in range(region.y, region.y + region.height):
        start = y * row_bytes + region.x * 3
        row = frame[start : start + region.width * 3]
        r_sum += sum(row[0::3])
        g_sum += sum(row[1::3])
        b_sum += sum(row[2::3])
    return _hex(r_sum, g_sum, b_sum, region.width * region.height)


def frame_colors(frame: bytes, width: int, height: int) -> dict[str, str]:
    """Colores hex de las cuatro franjas de borde de un fotograma `rgb24`."""
    if len(frame) != width * height * 3:
        raise AmbilightError("tamaño de fotograma inesperado")
    return {
        edge: region_color(frame, width, region)
        for edge, region in edge_regions(width, height).items()
    }


def read_frames(stream: IO[bytes], frame_size: int) -> Iterator[bytes]:
    """Lee fotogramas completos de `frame_size` bytes hasta EOF (admite lecturas cortas)."""
    while frame := stream.read(frame_size):
        while len(frame) < frame_size:
            chunk = stream.read(frame_size - len(frame))
            if not chunk:
                raise AmbilightError("fotograma truncado en la salida de ffmpeg")
            frame += chunk
        yield frame


def extract_ambilight(
    path: str,
    duration_ms: int,
    popen=subprocess.Popen,
    timeout: float = DEFAULT_EXTRACT_TIMEOUT_S,
    width: int = FRAME_WIDTH,
    height: int = FRAME_HEIGHT,
) -> list[dict[str, int | str]]:
    """Genera las entradas de `ambilight.json` leyendo los fotogramas de FFmpeg en streaming.

    Se procesa fotograma a fotograma, así que la memoria no crece con la duración del vídeo.
    """
    timestamps = sample_timestamps_ms(duration_ms)
    try:
        proc = popen(
            ffmpeg_frames_cmd(path, width, height),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise AmbilightError(f"no se pudo ejecutar ffmpeg: {exc}") from exc

    timed_out = threading.Event()

    def kill_on_timeout() -> None:
        timed_out.set()
        proc.kill()

    # stderr se drena en paralelo para que ffmpeg no se bloquee si escribe mucho.
    stderr_chunks: list[bytes] = []
    stderr_reader = threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()))
    timer = threading.Timer(timeout, kill_on_timeout)
    stderr_reader.start()
    timer.start()
    try:
        entries: list[dict[str, int | str]] = []
        frames = read_frames(proc.stdout, width * height * 3)
        # strict=False: ffmpeg puede emitir un fotograma más que la duración; se ignora.
        for t_ms, frame in zip(timestamps, frames, strict=False):
            entries.append({"t_ms": t_ms, **frame_colors(frame, width, height)})
        proc.stdout.read()  # descarta fotogramas sobrantes para que ffmpeg pueda terminar
        returncode = proc.wait()
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        timer.cancel()
        stderr_reader.join()
        proc.stdout.close()
        proc.stderr.close()

    if timed_out.is_set():
        raise AmbilightError(f"ffmpeg excedió el tiempo límite ({timeout} s)")
    if returncode != 0:
        stderr = b"".join(stderr_chunks).decode(errors="replace").strip()
        raise AmbilightError(stderr or "ffmpeg falló")
    if not entries:
        raise AmbilightError("ffmpeg no produjo fotogramas")
    return entries
