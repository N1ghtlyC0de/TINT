"""Sanitización de eventos de telemetría (Privacy by Design, Ley 1581).

El contrato de cada evento está en `docs/contrato-eventos-analitica.md`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

STREAM_KEY = "analytics:events"
CONSUMER_GROUP = "analytics-workers"
RETENTION = timedelta(days=90)

# Campos que pueden contener texto libre o datos personales y nunca deben persistirse.
TEXT_FIELDS = ("text", "message", "content", "body")
FORBIDDEN_FIELDS = frozenset({*TEXT_FIELDS, "nick", "email", "name", "display_name"})
REQUIRED_FIELDS = ("event_id", "type", "source", "occurred_at", "received_at")
TIMESTAMP_FIELDS = ("occurred_at", "received_at")
# Únicos tipos que no ocurren dentro de una sala.
ROOMLESS_TYPES = frozenset({"user_login", "media_processed"})


class InvalidEvent(ValueError):
    """El evento no cumple el contrato mínimo de telemetría."""


def parse_timestamp(value: Any) -> datetime:
    """Convierte un RFC 3339 (`...Z` u offset) a `datetime` en UTC; sin offset se asume UTC."""
    if not isinstance(value, str):
        raise ValueError(f"fecha inválida: {value!r}")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def sanitize_event(raw: dict[str, Any]) -> dict[str, Any]:
    """Valida el contrato mínimo y devuelve una copia del evento sin texto libre ni PII.

    Para eventos de chat se conserva únicamente `message_length`: se deriva del texto solo si
    el productor lo envió; si no, se respeta el `message_length` que ya trae el evento.
    """
    required = REQUIRED_FIELDS
    if raw.get("type") not in ROOMLESS_TYPES:
        required = (*REQUIRED_FIELDS, "room_id")
    missing = [f for f in required if not raw.get(f)]
    if missing:
        raise InvalidEvent(f"faltan campos obligatorios: {', '.join(missing)}")

    for field in TIMESTAMP_FIELDS:
        try:
            parse_timestamp(raw[field])
        except ValueError as exc:
            raise InvalidEvent(f"{field} no es RFC 3339: {raw[field]!r}") from exc

    clean = {k: v for k, v in raw.items() if k not in FORBIDDEN_FIELDS}
    for key, value in clean.items():
        # PostgreSQL no admite NUL en text/jsonb: el evento nunca podría persistirse.
        if isinstance(value, str) and "\x00" in value:
            raise InvalidEvent(f"{key} contiene un byte NUL")

    if raw["type"] == "chat_message":
        text = next((raw[f] for f in TEXT_FIELDS if isinstance(raw.get(f), str)), None)
        if text is not None:
            clean["message_length"] = len(text)
        else:
            clean.setdefault("message_length", 0)
    return clean


def is_expired(occurred_at: datetime, now: datetime | None = None) -> bool:
    """Indica si un evento superó la ventana de retención de 90 días."""
    now = now or datetime.now(UTC)
    return now - occurred_at > RETENTION
