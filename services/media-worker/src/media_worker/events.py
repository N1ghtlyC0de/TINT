"""Evento `media_processed` para `analytics:events` (adaptador; el núcleo no lo conoce).

Contrato: `docs/contrato-eventos-analitica.md`. Campos planos de texto, sin `room_id` ni datos
personales; `user_id` es el `users.provider_sub` de quien subió el vídeo. Este módulo no importa
`redis`: recibe el cliente ya creado por `__main__`.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from datetime import UTC, datetime

from media_worker.probe import VideoStatus

ANALYTICS_STREAM = "analytics:events"
# MAXLEN ~ 100000: Redis recorta de forma aproximada (barato) y el stream no crece sin límite.
ANALYTICS_MAXLEN = 100_000
SOURCE = "media-worker"

Publisher = Callable[[Mapping[str, str]], object]


def rfc3339_ms(moment: datetime) -> str:
    """`2026-10-11T04:29:49.368Z`: RFC 3339 en UTC con milisegundos."""
    moment = moment.astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def media_processed(
    video_id: str,
    status: VideoStatus,
    duration_ms: int | None,
    processing_ms: int,
    user_id: str | None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, str]:
    """Campos del evento; `duration_ms` y `user_id` van vacíos si no se conocen."""
    stamp = rfc3339_ms(now())
    return {
        "event_id": str(uuid.uuid4()),
        "type": "media_processed",
        "source": SOURCE,
        # El worker es quien origina y publica el evento: ambos sellos son el reloj del servidor.
        "occurred_at": stamp,
        "received_at": stamp,
        "media_id": video_id,
        "status": status.value,
        "duration_ms": "" if duration_ms is None else str(duration_ms),
        "processing_ms": str(processing_ms),
        "user_id": user_id or "",
    }


def redis_publisher(client) -> Publisher:
    """`XADD analytics:events MAXLEN ~ 100000 * ...` sobre un cliente Redis ya conectado."""

    def publish(fields: Mapping[str, str]) -> object:
        return client.xadd(ANALYTICS_STREAM, fields, maxlen=ANALYTICS_MAXLEN, approximate=True)

    return publish
