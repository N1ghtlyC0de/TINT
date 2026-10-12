-- 001_init: telemetría cruda (90 días) y KPIs consolidados por sala.
-- Contrato de eventos: docs/contrato-eventos-analitica.md.

CREATE TABLE IF NOT EXISTS telemetry_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    room_id TEXT NULL,          -- NULL en user_login y media_processed
    user_id TEXT NULL,          -- sub del token; NULL si no hay actor (p. ej. sync-core)
    source TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL      -- evento sanitizado completo (sin texto libre ni PII)
);

CREATE INDEX IF NOT EXISTS telemetry_events_room_type_idx ON telemetry_events (room_id, type);
CREATE INDEX IF NOT EXISTS telemetry_events_occurred_at_idx ON telemetry_events (occurred_at);

CREATE TABLE IF NOT EXISTS room_kpis (
    room_id TEXT PRIMARY KEY,
    peak_users INTEGER NOT NULL DEFAULT 0,
    avg_users DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_drift_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    trivia_accuracy_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    reactions INTEGER NOT NULL DEFAULT 0,
    playback_commands INTEGER NOT NULL DEFAULT 0,
    buffering_events INTEGER NOT NULL DEFAULT 0,
    avg_buffering_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    closed_at TIMESTAMPTZ NULL,
    computed_at TIMESTAMPTZ NOT NULL
);
