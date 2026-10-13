"""PostgreSQL de analítica: migraciones versionadas, escritura de eventos y lecturas de la API.

Las conexiones se piden a una fábrica (`connect`) en modo autocommit; cada escritura va en su
propia transacción explícita (`conn.transaction()`), así el consumidor solo hace `XACK` cuando el
evento ya está confirmado en la base.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NamedTuple

import psycopg
from psycopg.types.json import Jsonb

from analytics.kpis import KPI_TYPES, compute_room_kpis, heatmap_density
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
    "avg_rtt_ms",
    "p95_drift_ms",
    "total_buffering_ms",
    "close_reason",
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
# Un cierre por periodo de gracia deja de valer si la sala volvió a tener actividad: la API la
# trata otra vez como abierta hasta que `close_idle_rooms` la consolide de nuevo.
STALE_GRACE_CLOSE_SQL = (
    "k.close_reason IS NOT DISTINCT FROM 'grace_expired' AND EXISTS "
    "(SELECT 1 FROM telemetry_events e "
    "WHERE e.room_id = k.room_id AND e.occurred_at > k.closed_at)"
)
SELECT_KPIS_SQL = (
    f"SELECT k.room_id, {', '.join(f'k.{column}' for column in KPI_COLUMNS)} "
    f"FROM room_kpis k WHERE k.room_id = %s AND NOT ({STALE_GRACE_CLOSE_SQL})"
)
PURGE_SQL = "DELETE FROM telemetry_events WHERE occurred_at < %s"
DELETE_HEATMAP_SQL = "DELETE FROM room_heatmap WHERE room_id = %s"
INSERT_HEATMAP_SQL = (
    "INSERT INTO room_heatmap (room_id, bucket_start_ms, reactions, density) "
    "SELECT %s::text, * FROM unnest(%s::bigint[], %s::integer[], %s::double precision[])"
)
# Salas sin actividad desde antes del corte que nunca se consolidaron, o cuyo cierre por gracia
# quedó viejo. Un cierre explícito (`room_closed`) no se pisa.
SELECT_IDLE_ROOMS_SQL = (
    "SELECT e.room_id, max(e.occurred_at) FROM telemetry_events e "
    "LEFT JOIN room_kpis k ON k.room_id = e.room_id "
    "WHERE e.room_id IS NOT NULL "
    "GROUP BY e.room_id, k.room_id, k.close_reason, k.closed_at "
    "HAVING max(e.occurred_at) < %s AND (k.room_id IS NULL OR "
    "(k.close_reason = 'grace_expired' AND max(e.occurred_at) > k.closed_at)) "
    "ORDER BY e.room_id"
)
# DAU = usuarios distintos con `user_login` ese día local; MAU = en los 30 días que terminan ahí.
LOGINS_SQL = (
    "SELECT count(DISTINCT user_id) FROM telemetry_events "
    "WHERE type = 'user_login' AND user_id IS NOT NULL "
    "AND (occurred_at AT TIME ZONE %(tz)s::text)::date"
)
UPSERT_DAILY_ACTIVE_USERS_SQL = (
    "INSERT INTO daily_active_users (day, dau, mau, computed_at) "
    f"SELECT d.day, ({LOGINS_SQL} = d.day), ({LOGINS_SQL} BETWEEN d.day - 29 AND d.day), "
    "%(now)s::timestamptz "
    "FROM (SELECT (%(now)s::timestamptz AT TIME ZONE %(tz)s::text)::date - n AS day "
    "FROM generate_series(0, %(days)s::integer - 1) AS n) d "
    "ON CONFLICT (day) DO UPDATE SET dau = EXCLUDED.dau, mau = EXCLUDED.mau, "
    "computed_at = EXCLUDED.computed_at"
)
GRACE_EXPIRED = "grace_expired"
HEATMAP_BUCKET_MS = 5000

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
                    self._refresh_room_kpis(
                        conn,
                        event["room_id"],
                        parse_timestamp(event["occurred_at"]),
                        event.get("reason") or None,
                    )
        except psycopg.DataError as exc:
            raise InvalidEvent(f"PostgreSQL rechazó el evento: {exc}") from exc
        except Exception:
            self.close()
            raise
        return row is not None

    def _refresh_room_kpis(
        self, conn, room_id: str, closed_at: datetime, reason: str | None
    ) -> None:
        """Consolida `room_kpis` y el heatmap normalizado de la sala (dentro de la transacción)."""
        rows = conn.execute(SELECT_ROOM_EVENTS_SQL, (room_id, list(KPI_TYPES))).fetchall()
        events = [row[0] for row in rows]
        kpis = compute_room_kpis(room_id, events).as_dict()
        kpis["close_reason"] = reason
        kpis["closed_at"] = closed_at
        kpis["computed_at"] = self._clock()
        conn.execute(UPSERT_KPIS_SQL, (room_id, *(kpis[column] for column in KPI_COLUMNS)))
        buckets = heatmap_density(events, HEATMAP_BUCKET_MS)
        conn.execute(DELETE_HEATMAP_SQL, (room_id,))
        if buckets:
            conn.execute(
                INSERT_HEATMAP_SQL,
                (
                    room_id,
                    [bucket["bucket_start_ms"] for bucket in buckets],
                    [bucket["count"] for bucket in buckets],
                    [bucket["density"] for bucket in buckets],
                ),
            )
        logger.info("KPIs consolidados de la sala %s (%s)", room_id, reason or "sin razón")

    def close_idle_rooms(self, grace: timedelta) -> int:
        """Consolida las salas que agotaron el periodo de gracia sin un `room_closed`.

        Cada sala va en su propia transacción, con `closed_at` = su último evento y
        `close_reason = grace_expired`. Devuelve cuántas salas consolidó.
        """
        try:
            conn = self._connection()
            idle = conn.execute(SELECT_IDLE_ROOMS_SQL, (self._clock() - grace,)).fetchall()
            for room_id, last_event_at in idle:
                with conn.transaction():
                    self._refresh_room_kpis(conn, room_id, last_event_at, GRACE_EXPIRED)
        except Exception:
            self.close()
            raise
        return len(idle)

    def refresh_daily_active_users(self, timezone: str, days: int) -> int:
        """Recalcula DAU/MAU de los últimos `days` días locales (hoy incluido)."""
        try:
            conn = self._connection()
            with conn.transaction():
                conn.execute(
                    UPSERT_DAILY_ACTIVE_USERS_SQL,
                    {"tz": timezone, "now": self._clock(), "days": days},
                )
        except Exception:
            self.close()
            raise
        return days

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
