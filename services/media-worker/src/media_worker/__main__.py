"""Punto de entrada del worker (el consumo de la cola se implementará en próximas HU)."""

import argparse
import subprocess
from pathlib import Path

from media_worker.probe import VideoStatus, inspect_status

DEFAULT_VIDEOS_DIR = Path(__file__).resolve().parents[1] / "test-videos"


def resolve_video(video: str, videos_dir: Path) -> str:
    """Un nombre suelto se busca en `videos_dir`; una ruta con directorios se respeta tal cual."""
    if Path(video).name == video:
        return str(videos_dir / video)
    return video


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="media_worker", description="Worker de media de TINT")
    parser.add_argument(
        "video",
        nargs="?",
        help="vídeo a procesar: nombre (en --videos-dir) o ruta; sin él solo informa el estado",
    )
    parser.add_argument(
        "--videos-dir",
        type=Path,
        default=DEFAULT_VIDEOS_DIR,
        help="carpeta de vídeos para nombres sueltos (por defecto: src/test-videos)",
    )
    return parser


def main(argv: list[str] | None = None, runner=subprocess.run) -> str:
    """Sin `video` informa de los estados soportados; con `video` inspecciona y reporta."""
    args = build_parser().parse_args(argv)
    if args.video is None:
        message = f"media-worker listo (estados soportados: {', '.join(VideoStatus)})"
    else:
        path = resolve_video(args.video, args.videos_dir)
        status, duration_ms = inspect_status(path, runner)
        suffix = f" ({duration_ms} ms)" if duration_ms is not None else ""
        message = f"{path}: {status}{suffix}"
    print(message)
    return message


if __name__ == "__main__":  # pragma: no cover
    main()
