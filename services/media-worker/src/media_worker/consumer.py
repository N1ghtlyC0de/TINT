"""Disparador del pipeline: consume `media:uploads` de Redis Streams (`XREADGROUP` + `XACK`).

identity-api hace `XADD media:uploads * video_id <id>` al confirmar una subida directa del
navegador al bucket. Este adaptador es quien llama a `pipeline.process_video` (ver `jobs.py`);
el núcleo del worker (pipeline, repositorio, almacenamiento y `Settings`) no conoce Redis.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from redis.exceptions import ResponseError

from media_worker.pipeline import VIDEO_ID_PATTERN

logger = logging.getLogger(__name__)

STREAM_KEY = "media:uploads"
CONSUMER_GROUP = "media-workers"
DEFAULT_BLOCK_MS = 5000
DEFAULT_COUNT = 10
# Espera tras un fallo de infraestructura antes de reintentar los pendientes.
RETRY_DELAY_S = 5.0


def parse_video_id(fields: dict | None) -> str | None:
    """Extrae y valida `video_id` del evento; None si falta o es inválido."""
    value = (fields or {}).get("video_id")
    if isinstance(value, str) and VIDEO_ID_PATTERN.fullmatch(value):
        return value
    return None


class StreamConsumer:
    """Lee `media:uploads` con un grupo de consumidores y confirma cada evento tras procesarlo.

    Si el handler lanza una excepción (p. ej. SQL o S3 caídos) el evento no se confirma: queda
    pendiente, `run` espera `RETRY_DELAY_S` y lo reintenta (`recover_pending`) sin tumbar el
    worker. Al reiniciar también se reprocesan los pendientes.
    """

    def __init__(
        self,
        redis,
        handler: Callable[[str], object],
        consumer: str,
        stream: str = STREAM_KEY,
        group: str = CONSUMER_GROUP,
        block_ms: int = DEFAULT_BLOCK_MS,
        count: int = DEFAULT_COUNT,
        sleep: Callable[[float], object] = time.sleep,
    ) -> None:
        self.redis = redis
        self.handler = handler
        self.consumer = consumer
        self.stream = stream
        self.group = group
        self.block_ms = block_ms
        self.count = count
        self.sleep = sleep

    def ensure_group(self) -> None:
        """Crea el grupo (y el stream) desde el inicio; ignora `BUSYGROUP` si ya existe."""
        try:
            self.redis.xgroup_create(self.stream, self.group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def poll(self, last_id: str = ">") -> int:
        """Lee un lote (`>` = nuevos, `0` = pendientes propios) y devuelve cuántos procesó."""
        block = None if last_id == "0" else self.block_ms
        response = self.redis.xreadgroup(
            self.group, self.consumer, {self.stream: last_id}, count=self.count, block=block
        )
        handled = 0
        for _stream, messages in response or []:
            for message_id, fields in messages:
                self._handle(message_id, fields)
                handled += 1
        return handled

    def recover_pending(self) -> int:
        """Reprocesa los eventos entregados a este consumidor que nunca se confirmaron."""
        total = 0
        while handled := self.poll("0"):
            total += handled
        return total

    def run(self, stop: threading.Event) -> None:
        self.ensure_group()
        if stop.is_set():
            return
        recovered = self.recover_pending()
        if recovered:
            logger.info("reprocesados %d eventos pendientes", recovered)
        retry = False
        while not stop.is_set():
            try:
                if retry:
                    # Hasta que los pendientes salgan bien no se avanza a eventos nuevos.
                    self.sleep(RETRY_DELAY_S)
                    self.recover_pending()
                    retry = False
                else:
                    self.poll()
            except Exception:
                logger.exception(
                    "fallo procesando un evento; se reintenta en %.0f s", RETRY_DELAY_S
                )
                retry = True

    def _handle(self, message_id: str, fields: dict | None) -> None:
        video_id = parse_video_id(fields)
        if video_id is None:
            logger.warning("evento %s inválido, se descarta: %r", message_id, fields)
        else:
            self.handler(video_id)
        self.redis.xack(self.stream, self.group, message_id)
