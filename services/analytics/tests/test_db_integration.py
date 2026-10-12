"""Integración con PostgreSQL real (opcional).

Se ejecuta solo si `ANALYTICS_TEST_DATABASE_URL` apunta a una base; trabaja en un esquema
temporal que se borra al terminar, así que no toca las tablas reales.
"""

import os
import uuid
from datetime import UTC, datetime

import psycopg
import pytest

from analytics.db import EventStore, ReadRepository, apply_migrations
from analytics.kpis import HEATMAP_TYPES, KPI_TYPES

DSN = os.environ.get("ANALYTICS_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="ANALYTICS_TEST_DATABASE_URL no definida")
NOW = datetime(2026, 10, 11, 12, tzinfo=UTC)


@pytest.fixture
def connect():
    schema = f"analytics_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(DSN, autocommit=True) as admin:
        admin.execute(f"CREATE SCHEMA {schema}")
        try:
            yield lambda: psycopg.connect(DSN, autocommit=True, options=f"-c search_path={schema}")
        finally:
            admin.execute(f"DROP SCHEMA {schema} CASCADE")


def ev(event_id, kind, occurred_at="2026-10-11T10:00:00.000Z", **extra):
    return {
        "event_id": event_id,
        "type": kind,
        "source": "social-core",
        "room_id": "r1",
        "occurred_at": occurred_at,
        "received_at": occurred_at,
        **extra,
    }


def test_migrations_ingest_kpis_reads_and_purge(connect):
    with connect() as conn:
        assert apply_migrations(conn) == ["001_init"]
        assert apply_migrations(conn) == [], "aplicar dos veces no repite nada"

    store = EventStore(connect, clock=lambda: NOW)
    assert store.save(ev("a", "presence", connected_users="3")) is True
    assert store.save(ev("a", "presence", connected_users="3")) is False
    store.save(ev("b", "reaction", emoji="👏", position_ms="1500"))
    store.save(ev("c", "user_login", source="identity-api", room_id="", user_id="uid"))
    store.save(ev("old", "chat_message", occurred_at="2026-01-01T00:00:00.000Z"))
    store.save(ev("z", "room_closed", source="identity-api", reason="deleted"))

    repo = ReadRepository(connect)
    kpis = repo.room_kpis("r1")
    assert kpis["peak_users"] == 3
    assert kpis["reactions"] == 1
    assert kpis["messages"] == 1
    assert kpis["closed_at"] == datetime(2026, 10, 11, 10, tzinfo=UTC)
    assert kpis["computed_at"] == NOW
    assert repo.room_events("r1", HEATMAP_TYPES) == [
        ev("b", "reaction", emoji="👏", position_ms="1500")
    ]
    assert len(repo.room_events("r1", KPI_TYPES)) == 3

    assert store.purge_expired() == 1
    assert repo.room_events("r1", ("chat_message",)) == []
    store.close()
