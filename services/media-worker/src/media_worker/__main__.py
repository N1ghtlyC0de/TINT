"""Punto de entrada del worker: consumidor de `media:uploads` o inspección local de un vídeo."""

import argparse
import functools
import json
import logging
import signal
import subprocess
import threading
from pathlib import Path

import boto3
import psycopg
import redis

from media_worker.ambilight import AmbilightError, extract_ambilight
from media_worker.config import ConfigError, Settings
from media_worker.consumer import StreamConsumer
from media_worker.pipeline import process_video
from media_worker.probe import VideoStatus, inspect_status
from media_worker.repository import VideoRepository
from media_worker.storage import S3BlobStore

DEFAULT_VIDEOS_DIR = Path(__file__).resolve().parents[2] / "videos"

logger = logging.getLogger("media_worker")


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
        help="carpeta de vídeos para nombres sueltos (por defecto: videos/)",
    )
    parser.add_argument(
        "--ambilight",
        type=Path,
        metavar="SALIDA",
        help="además de inspeccionar, genera la paleta Ambilight en el JSON SALIDA",
    )
    parser.add_argument(
        "--consume",
        action="store_true",
        help="consume eventos de Redis (media:uploads) y procesa los vídeos del bucket",
    )
    return parser


def build_consumer(
    settings: Settings, runner=subprocess.run, popen=subprocess.Popen
) -> StreamConsumer:
    """Conecta Redis, MinIO/S3 y PostgreSQL y devuelve el consumidor listo para `run`."""
    redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    s3_client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )
    conn = psycopg.connect(settings.database_url, autocommit=True)
    handler = functools.partial(
        process_video,
        repo=VideoRepository(conn),
        blobs=S3BlobStore(s3_client, settings.bucket),
        runner=runner,
        popen=popen,
    )
    return StreamConsumer(redis_client, handler, consumer=settings.consumer_name)


def install_stop_handlers(stop: threading.Event) -> None:
    """SIGTERM/SIGINT terminan el vídeo en curso y detienen el bucle sin perder eventos."""
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())


def run_consumer(settings: Settings | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = settings or Settings.from_env()
    consumer = build_consumer(settings)
    stop = threading.Event()
    install_stop_handlers(stop)
    logger.info(
        "consumiendo %s (grupo %s, consumidor %s)",
        consumer.stream,
        consumer.group,
        consumer.consumer,
    )
    consumer.run(stop)


def inspect_local(path: str, ambilight_out: Path | None, runner, popen) -> str:
    status, duration_ms = inspect_status(path, runner)
    if status is VideoStatus.FAILED:
        return f"{path}: {status}"
    message = f"{path}: {status} ({duration_ms} ms)"
    if ambilight_out is None:
        return message
    try:
        palette = extract_ambilight(path, duration_ms, popen)
    except AmbilightError as exc:
        return f"{path}: {VideoStatus.FAILED} (ambilight: {exc})"
    ambilight_out.write_text(json.dumps(palette, indent=2) + "\n")
    return f"{message}; ambilight: {ambilight_out} ({len(palette)} muestras)"


def main(argv: list[str] | None = None, runner=subprocess.run, popen=subprocess.Popen) -> str:
    """Sin `video` informa de los estados soportados; con `video` inspecciona y reporta."""
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.consume:
        if args.video is not None or args.ambilight is not None:
            parser.error("--consume no admite vídeo ni --ambilight")
        try:
            run_consumer()
        except ConfigError as exc:
            parser.exit(1, f"{parser.prog}: {exc}\n")
        message = "media-worker detenido"
    elif args.video is None:
        if args.ambilight is not None:
            parser.error("--ambilight requiere un vídeo")
        message = f"media-worker listo (estados soportados: {', '.join(VideoStatus)})"
    else:
        path = resolve_video(args.video, args.videos_dir)
        message = inspect_local(path, args.ambilight, runner, popen)
    print(message)
    return message


if __name__ == "__main__":  # pragma: no cover
    main()
