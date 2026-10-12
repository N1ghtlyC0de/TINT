# 🤖 AGENT Guidelines — Domain: Analytics & Insights (`services/analytics`)

## Contexto & Responsabilidad
Eres el cerebro de inteligencia de negocio de **TINT**. Ingieres eventos desde Redis Streams (`XADD analytics:events`), procesas datos mediante `XREADGROUP` en Python, los persistes en PostgreSQL y entregas al host una **lectura diferida** de los KPIs de su sala.

El contrato de eventos (qué publica cada servicio) está en [docs/contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md); este dominio es su dueño.

## Stack Técnico
| Pieza | Versión | Por qué |
| :--- | :--- | :--- |
| Python | 3.11 | Igual que media-worker. |
| `psycopg[binary]` | `==3.2.13` | Driver PostgreSQL; la misma versión que media-worker. |
| `redis` | `==5.2.1` | `XREADGROUP`/`XACK` de `analytics:events` y consulta de `token:revoked:{jti}`; la misma versión que media-worker. |
| `PyJWT` | `==2.9.0` | Verificar el `analytics-ticket` HS256 (`iss`, `aud`, `exp`, `jti`) en la API. Es la única dependencia nueva respecto a media-worker. |
| HTTP | stdlib (`http.server.ThreadingHTTPServer`) | La API son tres GET de solo lectura: no justifica un framework. |
| SQL | Plano y versionado (`src/analytics/migrations/NNN_*.sql`) | Se aplica al arrancar; la tabla `schema_migrations` registra lo aplicado. |
| Pruebas | pytest 8.3.3, pytest-cov 5.0.0, ruff 0.6.9 | Dobles en `tests/fakes.py`; integración opcional con PostgreSQL real. |

## Estructura
| Módulo | Qué hace |
| :--- | :--- |
| `sanitize.py` | Contrato mínimo del evento y Privacy by Design (descarta texto libre y PII). |
| `kpis.py` | Funciones puras: `compute_room_kpis`, `reaction_heatmap`, `reactions_by_emoji`, `timeline`. |
| `db.py` + `migrations/` | Migraciones, `EventStore` (escritura del consumidor) y `ReadRepository` (lecturas de la API). |
| `consumer.py` | `XREADGROUP` → `sanitize` → `INSERT … ON CONFLICT DO NOTHING` → `XACK`; purga de 90 días. |
| `api.py` | API HTTP de solo lectura (`AnalyticsApi.handle` sin sockets + `create_server`). |
| `config.py`, `__main__.py` | Variables de entorno; migra y arranca consumidor, purga y API en hilos; apagado con SIGTERM. |

## Responsabilidades
- Consumo asíncrono y sanitización de eventos (`sanitize.py`, `consumer.py`).
- Cálculo de KPIs consolidados por sala al recibir `room_closed` (`kpis.py`, `db.py`).
- Políticas de retención (90 días) y purga periódica (cada hora).
- API de lectura diferida de KPIs, heatmap de reacciones y línea de tiempo para el host de la sala.

## Límites de Dominio
- ❌ No bloquees ni llames de forma síncrona a `sync-core` o `social-core`: solo consumes el stream.
- ❌ No almacenes PII ni contenido de chat (Ley 1581 de 2012 — Habeas Data, Colombia).
- ❌ Solo lectura diferida de KPIs: **nunca** endpoints de tiempo real (WebSocket, SSE, polling de presencia) **ni de eventos crudos**. La API devuelve agregados de una sala a su host.
- ❌ No emites tokens: el `analytics-ticket` lo firma identity-api; aquí solo se verifica.

## Modelo de Datos Involucrado
| Entidad | Almacén | Campos clave |
| :--- | :--- | :--- |
| `analytics:events` | Redis Stream (grupo `analytics-workers`) | Campos planos del [contrato](../../docs/contrato-eventos-analitica.md) |
| `schema_migrations` | PostgreSQL | `version` (PK), `applied_at` |
| `telemetry_events` | PostgreSQL | `event_id` (PK), `type`, `room_id` (NULL en `user_login`/`media_processed`), `user_id` (NULL sin actor), `source`, `occurred_at`, `received_at` (`timestamptz`), `payload` JSONB (evento sanitizado). Índices `(room_id, type)` y `(occurred_at)`. Retención 90 días. |
| `room_kpis` | PostgreSQL | `room_id` (PK), `peak_users`, `avg_users`, `avg_drift_ms`, `trivia_accuracy_pct`, `messages`, `reactions`, `playback_commands`, `buffering_events`, `avg_buffering_ms`, `closed_at`, `computed_at` |
| `token:revoked:{jti}` | Redis (escribe identity-api) | Solo lectura: revoca el `analytics-ticket` |

KPIs: `peak_users`/`avg_users` salen de `connected_users` de `presence` (promedio simple de las muestras); `avg_drift_ms` es el promedio de `|drift_ms|` de `drift_correction`; `trivia_accuracy_pct` de `trivia_answer.correct`; los conteos, del número de eventos de cada tipo; `avg_buffering_ms`, de `buffering.duration_ms`. Los valores llegan de Redis como texto y se interpretan con tolerancia (`"3"`, `"true"`).

## API (solo lectura, puerto `ANALYTICS_PORT`, por defecto 8084)
Auth: `Authorization: Bearer <analytics-ticket>` (lo emite identity-api en `POST /api/v1/rooms/:id/analytics-ticket`). HS256 con `JWT_SECRET`, `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`; `exp` y `jti` obligatorios. `role` debe ser `host` y `room_id` igual al `{id}` de la ruta. Si existe `token:revoked:{jti}` → 401; si Redis no responde → 503 (**falla cerrado**).

Errores: `{ "error": "<mensaje>" }` con 400 (parámetro fuera de rango), 401 (sin token, firma inválida, expirado o revocado), 403 (rol o sala distintos), 404, 405 y 503 (Redis o PostgreSQL caídos). CORS según `ANALYTICS_ALLOWED_ORIGINS` (también en errores), con preflight `OPTIONS` que permite `Authorization`.

| Ruta | Respuesta |
| :--- | :--- |
| `GET /healthz` | `{"status":"ok"}` (sin token) |
| `GET /api/v1/rooms/{id}/kpis` | `{room_id, live, peak_users, avg_users, avg_drift_ms, trivia_accuracy_pct, messages, reactions, playback_commands, buffering_events, avg_buffering_ms, closed_at, computed_at}`. `live: false` = fila de `room_kpis` (sala cerrada); `live: true` = calculado al vuelo sobre `telemetry_events` (`closed_at: null`). |
| `GET /api/v1/rooms/{id}/reactions/heatmap?bucket_ms=5000` | `{room_id, bucket_ms, buckets: [{bucket_start_ms, emoji, count}], by_emoji: [{emoji, count}]}`. Tramos por `position_ms` del vídeo; `bucket_ms` entre 1000 y 60000. `buckets` ordenado por `bucket_start_ms` y `emoji`; `by_emoji` por `count` descendente. |
| `GET /api/v1/rooms/{id}/timeline?step_s=60` | `{room_id, step_s, points: [{t, connected_users, messages, reactions}]}`. Intervalos por `occurred_at` alineados a la época; `t` es el inicio del intervalo (RFC 3339 UTC con ms); `connected_users` es el último `presence` conocido al final del intervalo (se arrastra); `step_s` entre 10 y 3600. |

## Variables de entorno
| Variable | Defecto | Notas |
| :--- | :--- | :--- |
| `DATABASE_URL` | — (**obligatoria**) | Igual que media-worker. |
| `JWT_SECRET` | — (**obligatoria**) | El mismo de identity-api. Sin él no arranca. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `tint-identity` / `tint:room` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `ANALYTICS_PORT` | `8084` | |
| `ANALYTICS_ALLOWED_ORIGINS` | `http://localhost:5173` | Lista separada por comas, con esquema. |
| `ANALYTICS_CONSUMER` | hostname | Nombre estable por réplica para recuperar sus pendientes. |

## Reglas de Dominio
1. **Privacy by Design (Ley 1581):** NUNCA analices o almacenes el texto plano de las conversaciones de chat. Registra únicamente `message_length` (se respeta el que envía el productor; solo se deriva si llegara texto). Se descartan también `nick`, `email` y nombres.
2. **Desacoplamiento:** Ingesta eventos asíncronamente para evitar que la telemetría bloquee la reproducción.
3. **Retención & KPIs:** Mantén la telemetría por 90 días (purga cada hora). Al recibir `room_closed`, calcula y guarda (upsert) en `room_kpis` los KPIs consolidados en la misma transacción del evento.
4. **Idempotencia:** Inserciones por `event_id` (`ON CONFLICT DO NOTHING`) y `XACK` solo tras el commit. Un evento inválido se registra y se confirma (no envenena el stream); un fallo de infraestructura lo deja pendiente y se reintenta.
5. **Falla cerrado** en la API: sin `JWT_SECRET` no arranca; sin Redis no se sirve nada autenticado (503).
6. **TDD:** Pruebas unitarias (prueba primero) de sanitización, KPIs, consumidor, SQL y API con `pytest-cov` **≥ 85 %**.

## Comandos
```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
# Integración opcional con PostgreSQL real (usa un esquema temporal que se borra al terminar):
ANALYTICS_TEST_DATABASE_URL=postgresql://tint:tint@localhost:5432/tint pytest tests/test_db_integration.py
```
