"""Punto de entrada del worker (el consumo de la cola se implementará en próximas HU)."""

import subprocess

from media_worker.probe import VideoStatus, inspect_status


def main(path: str | None = None, runner=subprocess.run) -> str:
    """Sin `path` informa de los estados soportados; con `path` inspecciona y reporta el estado."""
    if path is None:
        message = f"media-worker listo (estados soportados: {', '.join(VideoStatus)})"
    else:
        status, duration_ms = inspect_status(path, runner)
        suffix = f" ({duration_ms} ms)" if duration_ms is not None else ""
        message = f"{path}: {status}{suffix}"
    print(message)
    return message


if __name__ == "__main__":  # pragma: no cover
    main()
