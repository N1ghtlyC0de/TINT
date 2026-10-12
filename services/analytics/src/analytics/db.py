"""PostgreSQL de analítica: migraciones versionadas, escritura de eventos y lecturas de la API.

Las conexiones se piden a una fábrica (`connect`) en modo autocommit; cada escritura va en su
propia transacción explícita (`conn.transaction()`), así el consumidor solo hace `XACK` cuando el
evento ya está confirmado en la base.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NamedTuple

import psycopg
from psycopg.types.json import Jsonb

from analytics.kpis import KPI_TYPES, compute_room_kpis
from analytics.sanitize import RETENTION, InvalidEvent, parse_timestamp

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).with_name("migrations")
# Clave fija del advisory lock: dos réplicas no aplican migraciones a la vez.
MIGRATIONS_LOCK_ID = 727_001

KPI_COLUMNS = (
    "peak_users",
    "avg_users",
    "avg_drift_ms",
    "trivia_accuracy_pct",
    "messages",
    "reactions",
    "playback_commands",
    "buffering_events",
    "avg_buffering_ms",
    "closed_at",
    "computed_at",
)

CREATE_MIGRATIONS_TABLE_SQL = (
    "CREATE TABLE IF NOT EXISTS schema_migrations "
    "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
)
INSERT_EVENT_SQL = (
    "INSERT INTO telemetry_events "
    "(event_id, type, room_id, user_id, source, occurred_at, received_at, payload) "
    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
    "ON CONFLICT (event_id) DO NOTHING RETURNING event_id"
)
SELECT_ROOM_EVENTS_SQL = (
    "SELECT payload FROM telemetry_events WHERE room_id = %s AND type = ANY(%s) "
    "ORDER BY occurred_at, event_id"
)
UPSERT_KPIS_SQL = (
    f"INSERT INTO room_kpis (room_id, {', '.join(KPI_COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * (len(KPI_COLUMNS) + 1))}) "
    "ON CONFLICT (room_id) DO UPDATE SET "
    + ", ".join(f"{column} = EXCLUDED.{column}" for column in KPI_COLUMNS)
)
SELECT_KPIS_SQL = f"SELECT room_id, {', '.join(KPI_COLUMNS)} FROM room_kpis WHERE room_id = %s"
PURGE_SQL = "DELETE FROM telemetry_events WHERE occurred_at < %s"

Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


class Migration(NamedTuple):
    version: str
    sql: str


def load_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Archivos `NNN_nombre.sql` del directorio, en orden de versión."""
    return [Migration(path.stem, path.read_text()) for path in sorted(directory.glob("*.sql"))]


def apply_migrations(conn, migrations: Iterable[Migration] | None = None) -> list[str]:
    """Aplica en una transacción las migraciones pendientes y devuelve sus versiones."""
    migrations = load_migrations() if migrations is None else list(migrations)
    applied_now = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATIONS_LOCK_ID,))
        conn.execute(CREATE_MIGRATIONS_TABLE_SQL)
        done = {row[0] for row in conn.execute("SELECT version FROM schema_migrations").fetchall()}
        for migration in migrations:
            if migration.version in done:
                continue
            conn.execute(migration.sql)
            conn.execute(
                "INSERT INTO schema_migrations (version) VALUES (%s)", (migration.version,)
            )
            applied_now.append(migration.version)
    return applied_now


class EventStore:
    """Escritura del consumidor: una conexión larga que se reabre si se pierde."""

    def __init__(self, connect: Callable[[], Any], clock: Clock = utc_now) -> None:
        self._connect = connect
        self._clock = clock
        self._conn = None

    def _connection(self):
        if self._conn is None:
            self._conn = self._connect()
        return self._conn

    def save(self, event: dict[str, Any]) -> bool:
        """Inserta el evento sanitizado (idempotente por `event_id`); True si era nuevo.

        Un `room_closed` además recalcula y guarda los `room_kpis` de la sala en la misma
        transacción. Un dato que PostgreSQL rechaza se reporta como `InvalidEvent` (reintentarlo
        no serviría); cualquier otro error descarta la conexión y se propaga para reintentar.
        """
        try:
            conn = self._connection()
            with conn.transaction():
                row = conn.execute(
                    INSERT_EVENT_SQL,
                    (
                        event["event_id"],
                        event["type"],
                        event.get("room_id") or None,
                        event.get("user_id") or None,
                        event["source"],
                        parse_timestamp(event["occurred_at"]),
                        parse_timestamp(event["received_at"]),
                        Jsonb(event),
                    ),
                ).fetchone()
                if event["type"] == "room_closed":
                    self._refresh_room_kpis(conn, event["room_id"], event["occurred_at"])
        except psycopg.DataError as exc:
            raise InvalidEvent(f"PostgreSQL rechazó el evento: {exc}") from exc
        except Exception:
            self.close()
            raise
        return row is not None

    def _refresh_room_kpis(self, conn, room_id: str, closed_at: str) -> None:
        rows = conn.execute(SELECT_ROOM_EVENTS_SQL, (room_id, list(KPI_TYPES))).fetchall()
        kpis = compute_room_kpis(room_id, (row[0] for row in rows)).as_dict()
        kpis["closed_at"] = parse_timestamp(closed_at)
        kpis["computed_at"] = self._clock()
        conn.execute(UPSERT_KPIS_SQL, (room_id, *(kpis[column] for column in KPI_COLUMNS)))
        logger.info("KPIs consolidados de la sala %s", room_id)

    def purge_expired(self) -> int:
        """Borra la telemetría con más de 90 días; devuelve cuántas filas eliminó."""
        try:
            conn = self._connection()
            with conn.transaction():
                cursor = conn.execute(PURGE_SQL, (self._clock() - RETENTION,))
        except Exception:
            self.close()
            raise
        return cursor.rowcount

    def close(self) -> None:
        if self._conn is not None:
            conn, self._conn = self._conn, None
            try:
                conn.close()
            except Exception:  # pragma: no cover - cerrar una conexión rota no debe fallar
                logger.debug("error cerrando la conexión", exc_info=True)


class ReadRepository:
    """Lecturas de la API: una conexión corta por consulta (es seguro entre hilos)."""

    def __init__(self, connect: Callable[[], Any]) -> None:
        self._connect = connect

    def room_kpis(self, room_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(SELECT_KPIS_SQL, (room_id,)).fetchone()
        return None if row is None else dict(zip(("room_id", *KPI_COLUMNS), row, strict=True))

    def room_events(self, room_id: str, types: Iterable[str]) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(SELECT_ROOM_EVENTS_SQL, (room_id, list(types))).fetchall()
        return [row[0] for row in rows]
