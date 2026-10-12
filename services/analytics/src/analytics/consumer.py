"""Ingesta: consume `analytics:events` (`XREADGROUP` + `XACK`) y lo persiste en PostgreSQL.

Adaptado del consumidor de `services/media-worker` (mismo manejo de pendientes). Por mensaje:
`sanitize_event` → `EventStore.save` (INSERT idempotente; `room_closed` consolida KPIs) → `XACK`.
Un evento inválido se registra y se confirma para no envenenar el stream; un fallo de
infraestructura lo deja pendiente y se reintenta.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from redis.exceptions import ResponseError

from analytics.sanitize import CONSUMER_GROUP, STREAM_KEY, InvalidEvent, sanitize_event

logger = logging.getLogger(__name__)

DEFAULT_BLOCK_MS = 5000
DEFAULT_COUNT = 50
# Espera tras un fallo de infraestructura antes de reintentar los pendientes.
RETRY_DELAY_S = 5.0
# Cada cuánto se purga la telemetría con más de 90 días.
PURGE_INTERVAL_S = 3600.0


class StreamConsumer:
    """Lee `analytics:events` con el grupo `analytics-workers` y confirma tras persistir.

    Si el almacén lanza (p. ej. PostgreSQL caído) el evento no se confirma: queda pendiente,
    `run` espera `RETRY_DELAY_S` y lo reintenta (`recover_pending`) sin tumbar el servicio. Al
    reiniciar también se reprocesan los pendientes; la inserción idempotente evita duplicados.
    """

    def __init__(
        self,
        redis,
        store,
        consumer: str,
        stream: str = STREAM_KEY,
        group: str = CONSUMER_GROUP,
        block_ms: int = DEFAULT_BLOCK_MS,
        count: int = DEFAULT_COUNT,
        sleep: Callable[[float], object] = time.sleep,
    ) -> None:
        self.redis = redis
        self.store = store
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
        try:
            self.store.save(sanitize_event(dict(fields or {})))
        except InvalidEvent as exc:
            logger.warning("evento %s inválido, se descarta: %s", message_id, exc)
        self.redis.xack(self.stream, self.group, message_id)


def run_purge_loop(store, stop: threading.Event, interval_s: float = PURGE_INTERVAL_S) -> None:
    """Purga la telemetría vencida al arrancar y luego cada `interval_s` hasta `stop`."""
    while True:
        try:
            purged = store.purge_expired()
            logger.info("purgados %d eventos con más de 90 días", purged)
        except Exception:
            logger.exception("fallo purgando la telemetría vencida")
        if stop.wait(interval_s):
            return
