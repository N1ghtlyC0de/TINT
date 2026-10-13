# analytics

Servicio de **analítica** de TINT (Python 3.11, Redis Streams, PostgreSQL). Ingiere la telemetría que publican los demás servicios en `analytics:events`, la sanitiza (sin texto libre ni datos personales), la guarda 90 días, consolida los **KPIs de cada sala** cuando se cierra y se los entrega a su Host por una **API HTTP de solo lectura**.

Este README explica **cómo funciona por dentro**. Las reglas del dominio, la forma exacta de cada respuesta y las variables están en [AGENTS.md](AGENTS.md); el contrato de eventos (qué publica cada servicio) está en [docs/contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md), del que este dominio es dueño.

## Índice

1. [Propósito y responsabilidades](#1-propósito-y-responsabilidades)
2. [Arquitectura interna](#2-arquitectura-interna)
3. [Cómo funciona, paso a paso](#3-cómo-funciona-paso-a-paso)
4. [Estado y datos](#4-estado-y-datos)
5. [Configuración](#5-configuración)
6. [Ejecutar y probar](#6-ejecutar-y-probar)
7. [Observabilidad y errores](#7-observabilidad-y-errores)
8. [Decisiones de arquitectura](#8-decisiones-de-arquitectura)
9. [Enlaces](#9-enlaces)

---

## 1. Propósito y responsabilidades

| Hace | Dónde |
| :--- | :--- |
| Consumir `analytics:events` con el grupo `analytics-workers` y confirmar (`XACK`) solo tras el commit | `consumer.py` |
| Validar el contrato mínimo de cada evento y quitar texto libre y PII | `sanitize.py` |
| Guardar cada evento sanitizado en `telemetry_events`, sin duplicados por `event_id` | `db.py` (`EventStore`) |
| Consolidar los KPIs de la sala en `room_kpis` al recibir `room_closed` | `db.py` + `kpis.py` |
| Purgar la telemetría con más de 90 días (al arrancar y cada hora) | `consumer.py` (`run_purge_loop`) |
| Servir KPIs, heatmap de reacciones y línea de tiempo al Host de la sala | `api.py` |
| Verificar el `analytics-ticket` HS256 y su revocación, con falla cerrado | `api.py` |
| Aplicar sus propias migraciones SQL al arrancar | `db.py` + `migrations/` |
| Auditar bajo demanda que lo persistido no tiene texto de chat ni PII | `audit.py` |

**Lo que NO hace:**

- No llama de forma síncrona a ningún servicio: solo lee el stream. Si analytics se cae, la reproducción y el chat siguen igual y los eventos esperan en Redis.
- No guarda PII ni contenido de chat (Ley 1581): del chat solo queda `message_length`.
- No ofrece tiempo real (WebSocket, SSE, polling de presencia) ni **eventos crudos**: la API devuelve agregados de una sala a su Host.
- No emite tokens: el `analytics-ticket` lo firma identity-api; aquí solo se verifica.
- No toca las tablas de identity-api: usa la misma base PostgreSQL, pero solo sus tablas `schema_migrations`, `telemetry_events` y `room_kpis`.

## 2. Arquitectura interna

Un único proceso (`python -m analytics`) con tres hilos: el **consumidor**, la **purga** y la **API**.

```mermaid
flowchart LR
    PROD["identity-api · social-core<br/>sync-core · media-worker"] -- "XADD analytics:events" --> RD[("Redis")]
    WEB["apps/web (Host)"] -- "GET /api/v1/rooms/{id}/... <br/>Bearer analytics-ticket" --> API

    subgraph AN["analytics (python -m analytics)"]
        MAIN["__main__.py<br/>migra, arranca hilos, SIGTERM"]
        CFG["config.py<br/>Settings"]
        CONS["consumer.py<br/>StreamConsumer"]
        PURGE["consumer.py<br/>run_purge_loop"]
        SAN["sanitize.py<br/>contrato y PII"]
        KPI["kpis.py<br/>funciones puras"]
        STORE["db.py<br/>EventStore"]
        READ["db.py<br/>ReadRepository"]
        MIG["db.py + migrations/<br/>apply_migrations"]
        API["api.py<br/>AnalyticsApi + ThreadingHTTPServer"]
    end

    MAIN --> CFG
    MAIN --> MIG
    MAIN --> CONS
    MAIN --> PURGE
    MAIN --> API
    CONS --> SAN
    CONS --> STORE
    PURGE --> STORE
    STORE --> KPI
    API --> READ
    API --> KPI

    CONS -- "XREADGROUP · XACK" --> RD
    API -- "EXISTS token:revoked:{jti}" --> RD
    STORE -- "INSERT · UPSERT · DELETE" --> PG[("PostgreSQL")]
    READ -- "SELECT" --> PG
    MIG -- "DDL + schema_migrations" --> PG
```

| Módulo | Responsabilidad | Archivo |
| :--- | :--- | :--- |
| Arranque | Lee la configuración, aplica migraciones, crea dos clientes Redis (consumidor y API, este con timeouts de 2 s), arranca los tres hilos y apaga ordenadamente con SIGTERM/SIGINT | `src/analytics/__main__.py` |
| Configuración | `DATABASE_URL` y `JWT_SECRET` obligatorias (sin ellas no arranca); valida `ANALYTICS_PORT` | `src/analytics/config.py` |
| Consumidor | `XGROUP CREATE ... MKSTREAM`, recupera pendientes, lotes de 50 con `BLOCK 5000`, `XACK` tras persistir, reintento cada 5 s | `src/analytics/consumer.py` |
| Purga | `DELETE` de lo que tenga más de 90 días, al arrancar y cada 3600 s | `src/analytics/consumer.py` |
| Sanitización | Campos obligatorios, fechas RFC 3339, descarte de campos prohibidos, `message_length` | `src/analytics/sanitize.py` |
| KPIs | `compute_room_kpis`, `reaction_heatmap`, `reactions_by_emoji`, `timeline` (sin E/S) | `src/analytics/kpis.py` |
| Escritura | `EventStore`: una conexión larga que se reabre si se pierde; una transacción por evento | `src/analytics/db.py` |
| Lectura | `ReadRepository`: una conexión corta por consulta (seguro entre hilos) | `src/analytics/db.py` |
| Migraciones | Archivos `NNN_*.sql` aplicados en una transacción con `pg_advisory_xact_lock` | `src/analytics/db.py`, `src/analytics/migrations/` |
| API | Enrutamiento, auth, CORS y vistas en `AnalyticsApi.handle` (sin sockets); `create_server` la monta sobre `http.server` de la stdlib | `src/analytics/api.py` |

## 3. Cómo funciona, paso a paso

### 3.1 Arranque

1. `Settings.from_env`: si falta `DATABASE_URL` o `JWT_SECRET`, imprime el error y termina con código **2** (falla cerrado: sin secreto no hay API).
2. `apply_migrations`: en una transacción toma el *advisory lock* `727001` (dos réplicas no migran a la vez), crea `schema_migrations` si no existe y aplica en orden los `migrations/*.sql` que falten. Si PostgreSQL falla, termina con código **1**.
3. Arranca los hilos `consumer`, `purge` y `api` (este último *daemon*).
4. Con SIGTERM/SIGINT: para el servidor HTTP, espera hasta 10 s a cada hilo de trabajo y cierra la conexión de escritura.

### 3.2 Ingesta de `analytics:events`

Cada productor hace `XADD analytics:events MAXLEN ~ 100000 * campo valor ...` con campos planos de texto. El consumidor los procesa así:

```mermaid
sequenceDiagram
    autonumber
    participant P as Productor
    participant R as Redis
    participant C as consumer.py
    participant S as sanitize.py
    participant DB as EventStore (PostgreSQL)

    P->>R: XADD analytics:events * event_id, type, source, ...
    C->>R: XREADGROUP analytics-workers COUNT 50 BLOCK 5000
    R-->>C: lote de mensajes
    loop cada mensaje
        C->>S: sanitize_event(campos)
        alt no cumple el contrato
            S-->>C: InvalidEvent
            C->>C: log de aviso, se descarta
        else válido
            S-->>C: evento sin texto libre ni PII
            C->>DB: BEGIN, INSERT telemetry_events ON CONFLICT (event_id) DO NOTHING
            opt type = room_closed
                DB->>DB: recalcula y UPSERT room_kpis (misma transacción)
            end
            DB-->>C: COMMIT
        end
        C->>R: XACK analytics:events analytics-workers id
    end
    Note over C,DB: si PostgreSQL falla no hay XACK, el mensaje queda pendiente y se reintenta a los 5 s
```

**Grupo de consumidores y reintentos.** Igual que en media-worker: el grupo `analytics-workers` se crea desde el principio del stream (`id="0"`, `mkstream`); al arrancar se reprocesan los pendientes propios (`XREADGROUP ... 0`), por eso `ANALYTICS_CONSUMER` debe ser estable por réplica. Si el almacén lanza (PostgreSQL caído), el mensaje no se confirma, el consumidor espera 5 s y reintenta sus pendientes antes de leer mensajes nuevos. La inserción idempotente por `event_id` hace que reprocesar no cuente doble.

**Validación del contrato** (`sanitize_event`):

| Regla | Si no se cumple |
| :--- | :--- |
| `event_id`, `type`, `source`, `occurred_at` y `received_at` presentes y no vacíos | `InvalidEvent` |
| `room_id` presente, salvo en `user_login` y `media_processed` (los únicos eventos fuera de una sala) | `InvalidEvent` |
| `occurred_at` y `received_at` en RFC 3339 (con `Z` u offset; sin offset se asume UTC) | `InvalidEvent` |
| Ningún valor contiene un byte NUL (PostgreSQL no lo admite en `text`/`jsonb`) | `InvalidEvent` |
| PostgreSQL rechaza un dato (`psycopg.DataError`) | Se trata como `InvalidEvent`: reintentar no serviría |

Un evento inválido se registra y **se confirma igual**: no envenena el stream. Un `type` que no está en el contrato se guarda, pero no entra a ningún KPI.

**Sin PII.** Antes de guardar se eliminan los campos `text`, `message`, `content`, `body`, `nick`, `email`, `name` y `display_name`. En `chat_message` solo queda `message_length`: se calcula del texto si el productor lo hubiera enviado; si no, se respeta el que trae (o `0`). Los productores ya publican sin PII ([contrato](../../docs/contrato-eventos-analitica.md)); esta es la segunda barrera.

### 3.3 Consolidación de KPIs al cerrar una sala

identity-api publica `room_closed` (hoy, cuando el Host borra la sala). En la **misma transacción** en la que se inserta ese evento, `EventStore` lee todos los eventos de la sala de los tipos que alimentan KPIs, los agrega con `compute_room_kpis` y hace `INSERT ... ON CONFLICT (room_id) DO UPDATE` en `room_kpis`, con `closed_at` = `occurred_at` del `room_closed` y `computed_at` = ahora. Si `room_closed` llega repetido, se recalcula y se sobrescribe con el mismo resultado.

| KPI | Cómo se calcula | Eventos |
| :--- | :--- | :--- |
| `peak_users` | Máximo de `connected_users` | `presence` (social-core) |
| `avg_users` | Promedio simple de las muestras de `connected_users` | `presence` |
| `avg_drift_ms` | Promedio de `\|drift_ms\|` | `drift_correction` (sync-core) |
| `trivia_accuracy_pct` | `100 × correctas / respuestas` | `trivia_answer` (social-core) |
| `messages` · `reactions` · `playback_commands` · `buffering_events` | Número de eventos de cada tipo | `chat_message`, `reaction`, `playback_command`, `buffering` |
| `avg_buffering_ms` | Promedio de `duration_ms` | `buffering` (sync-core) |

- Los promedios se redondean a 2 decimales y valen `0.0` si no hay muestras.
- Los valores llegan de Redis como texto: se interpretan con tolerancia (`"3"`, `"3.0"`, `"true"`/`"1"`/`"yes"`). Un valor ilegible o no finito se ignora en esa medida, sin descartar el evento.

### 3.4 Heatmap y línea de tiempo

No se precalculan: se calculan **al vuelo** sobre `telemetry_events` en cada petición (y por tanto solo cubren los últimos 90 días).

- **Heatmap** (`reaction_heatmap`): agrupa las reacciones por tramo de la **posición del vídeo**, `bucket_start_ms = position_ms // bucket_ms × bucket_ms`, y por emoji. Se omiten las reacciones sin emoji o con `position_ms` inválida o negativa. `by_emoji` da el total por emoji, de más a menos usado (empates por emoji).
- **Línea de tiempo** (`timeline`): agrupa por intervalos de `step_s` segundos del **reloj** (`occurred_at`), alineados a la época, desde el primer hasta el último evento e incluyendo los intervalos vacíos. Cada punto trae `messages`, `reactions` y `connected_users`, que es el último `presence` conocido al final del intervalo (se arrastra; `0` antes del primero).

### 3.5 API de solo lectura con `analytics-ticket`

```mermaid
sequenceDiagram
    autonumber
    actor H as Host (web)
    participant ID as identity-api
    participant API as analytics :8084
    participant R as Redis
    participant PG as PostgreSQL

    H->>ID: POST /api/v1/rooms/:id/analytics-ticket (ID token de Firebase, dueño)
    ID-->>H: { token, expiresAt } HS256, role host, room_id, jti, 10 min
    H->>API: GET /api/v1/rooms/:id/kpis (Bearer analytics-ticket)
    API->>API: jwt.decode HS256, iss, aud, exige exp, iss, aud y jti
    API->>R: EXISTS token:revoked:{jti}
    alt Redis no responde
        API-->>H: 503
    else revocado
        API-->>H: 401 token revocado
    end
    API->>API: role == host y room_id == id de la ruta, si no 403
    API->>PG: SELECT room_kpis WHERE room_id
    alt la sala está cerrada (hay fila)
        API-->>H: KPIs consolidados con live false
    else sala abierta
        API->>PG: SELECT payload FROM telemetry_events WHERE room_id AND type = ANY(...)
        API->>API: compute_room_kpis al vuelo
        API-->>H: KPIs con live true y closed_at null
    end
```

| Ruta | Parámetros | Devuelve |
| :--- | :--- | :--- |
| `GET /healthz` | — (sin token) | `{"status":"ok"}` |
| `GET /api/v1/rooms/{id}/kpis` | — | KPIs de §3.3 + `room_id`, `live`, `closed_at`, `computed_at` |
| `GET /api/v1/rooms/{id}/reactions/heatmap` | `bucket_ms` (1000–60000, por defecto 5000) | `{ room_id, bucket_ms, buckets, by_emoji }` |
| `GET /api/v1/rooms/{id}/timeline` | `step_s` (10–3600, por defecto 60) | `{ room_id, step_s, points }` |

Formas exactas de cada respuesta en [AGENTS.md › API](AGENTS.md#api-solo-lectura-puerto-analytics_port-por-defecto-8084).

- **Orden de la autorización:** firma y claims → revocación en Redis → rol → sala. La revocación se consulta antes que el rol, así un ticket revocado siempre da 401.
- **Falla cerrado:** si Redis no responde (timeout de 2 s del cliente de la API) se responde 503; nunca se acepta el token por defecto.
- El analytics-ticket es el mismo ticket de Host que el sync-ticket (`generateHostTicket` en identity-api). identity-api lo entrega también para salas **borradas**, para que el Host vea los KPIs consolidados de una sala cerrada.
- **CORS:** si el `Origin` está en `ANALYTICS_ALLOWED_ORIGINS` se devuelve `Access-Control-Allow-Origin` (también en los errores). El preflight `OPTIONS` responde 204 y permite `GET, OPTIONS` y las cabeceras `Authorization, Content-Type`.
- Todas las respuestas llevan `Cache-Control: no-store`.

## 4. Estado y datos

### 4.1 Tablas (PostgreSQL)

Migración `src/analytics/migrations/001_init.sql`. Viven en la misma base que las tablas de identity-api, sin claves foráneas hacia ellas (`room_id` y `user_id` son `TEXT`).

```mermaid
erDiagram
    telemetry_events }o..o| room_kpis : "room_id (sin FK)"

    schema_migrations {
        text version PK
        timestamptz applied_at
    }
    telemetry_events {
        text event_id PK
        text type
        text room_id "NULL en user_login y media_processed"
        text user_id "NULL sin actor, p. ej. sync-core"
        text source
        timestamptz occurred_at
        timestamptz received_at
        jsonb payload "evento sanitizado completo"
    }
    room_kpis {
        text room_id PK
        integer peak_users
        float avg_users
        float avg_drift_ms
        float trivia_accuracy_pct
        integer messages
        integer reactions
        integer playback_commands
        integer buffering_events
        float avg_buffering_ms
        timestamptz closed_at
        timestamptz computed_at
    }
```

- `telemetry_events` tiene índices `(room_id, type)` (consultas de la API y de los KPIs) y `(occurred_at)` (purga). Se purga a los **90 días**.
- `room_kpis` **no** se purga: los KPIs consolidados de una sala cerrada quedan aunque su telemetría cruda ya se haya borrado.
- `user_id` es el `sub` del token (UID de Firebase o `guest:<uuid>`); un `user_id` vacío se guarda como `NULL`.

### 4.2 Redis

| Clave | Tipo | Escribe | Lee |
| :--- | :--- | :--- | :--- |
| `analytics:events` | Stream (`MAXLEN ~ 100000`) | identity-api, social-core, sync-core, media-worker | analytics (grupo `analytics-workers`) |
| `token:revoked:{jti}` | String con expiración | identity-api | analytics (solo `EXISTS`, en la API) |

Tipos que llegan hoy, por productor: identity-api (`user_login`, `room_created`, `room_closed`, `invitation_claimed`), social-core (`chat_message`, `presence`, `reaction`, `trivia_answer`), sync-core (`playback_command`, `drift_correction`, `buffering`) y media-worker (`media_processed`). Campos de cada uno en el [contrato](../../docs/contrato-eventos-analitica.md#eventos).

## 5. Configuración

| Variable | Por defecto | Notas |
| :--- | :--- | :--- |
| `DATABASE_URL` | — (**obligatoria**) | La misma base `tint` del resto de servicios |
| `JWT_SECRET` | — (**obligatoria**) | **Contrato**: el mismo de identity-api |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `tint-identity` / `tint:room` | **Contrato**: iguales que en identity-api |
| `REDIS_URL` | `redis://localhost:6379` | |
| `ANALYTICS_PORT` | `8084` | Entero de 1 a 65535 |
| `ANALYTICS_ALLOWED_ORIGINS` | `http://localhost:5173` | Lista separada por comas, con esquema |
| `ANALYTICS_CONSUMER` | nombre del host | Estable por réplica para recuperar sus pendientes |

En `docker-compose.yml` el servicio `analytics` (`tint-analytics`) toma `JWT_*` y `ANALYTICS_*` del `.env` raíz ([`.env.example`](../../.env.example)), fija `ANALYTICS_CONSUMER=analytics-1`, publica el puerto `${ANALYTICS_PORT:-8084}` y tiene un *healthcheck* que llama a `/healthz` cada 10 s. Arranca cuando PostgreSQL y Redis están sanos.

## 6. Ejecutar y probar

```bash
# Con docker compose (desde la raíz del monorepo)
cp .env.example .env
docker compose up -d analytics
curl http://localhost:8084/healthz

# En local, fuera de Docker
cd services/analytics
pip install -r requirements-dev.txt
DATABASE_URL=postgresql://tint:tint@localhost:5432/tint \
JWT_SECRET=dev-secret-change-in-prod \
PYTHONPATH=src python -m analytics

# Consultar los KPIs de una sala (el token sale de POST /api/v1/rooms/:id/analytics-ticket)
curl -H "Authorization: Bearer $TICKET" http://localhost:8084/api/v1/rooms/$ROOM_ID/kpis
```

**Gate del dominio:**

```bash
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
# Integración opcional con PostgreSQL real (esquema temporal que se borra al terminar):
ANALYTICS_TEST_DATABASE_URL=postgresql://tint:tint@localhost:5432/tint pytest tests/test_db_integration.py
```

**Auditoría de privacidad (ANA-TEST-02).** `python -m analytics.audit` revisa la base real, solo con `SELECT`, y certifica que:

1. ningún `payload` de `telemetry_events` conserva los campos que quita el sanitizador (`text`, `message`, `content`, `body`, `nick`, `email`, `name`, `display_name`);
2. todo `chat_message` guarda únicamente los campos comunes y un `message_length` numérico;
3. las tablas de analítica no tienen columnas de texto fuera de las conocidas (`ALLOWED_TEXT_COLUMNS`).

Imprime el resumen y termina con `0` si cumple, `1` si hay alguna violación y `2` si falta `DATABASE_URL`.

```bash
docker exec tint-analytics python -m analytics.audit
# auditoría de privacidad: 1286 eventos, 12 de chat revisados
# resultado: CUMPLE
```

Las pruebas unitarias usan dobles (`tests/fakes.py`) para Redis y PostgreSQL. La API se prueba llamando a `AnalyticsApi.handle(method, target, headers)` directamente, sin abrir sockets.

## 7. Observabilidad y errores

**Formato de error de la API.** Siempre `{ "error": "<mensaje>" }` en JSON:

| Código | Cuándo |
| :--- | :--- |
| 400 | `bucket_ms` o `step_s` fuera de rango o no numérico |
| 401 | Sin token, firma inválida, expirado, sin `jti` o revocado |
| 403 | El rol no es `host` o el `room_id` del token no es el de la ruta |
| 404 | Ruta desconocida |
| 405 | Método distinto de `GET` (cabecera `Allow: GET, OPTIONS`) |
| 500 | Error de programación no controlado (`error interno`; el detalle va al log) |
| 503 | Redis (revocación) o PostgreSQL no disponibles |

**Logs.** `logging` a nivel `INFO` con el formato `%(asctime)s %(levelname)s %(name)s %(message)s`. Cada petición HTTP se registra con la IP, el método, la ruta y el estado, **nunca las cabeceras** (el token va en `Authorization`). Mensajes clave: `migraciones aplicadas: ...`, `analytics consumiendo analytics:events; API en :8084`, `reprocesados N eventos pendientes`, `evento X inválido, se descarta: ...`, `KPIs consolidados de la sala X`, `purgados N eventos con más de 90 días` y `fallo procesando un evento; se reintenta en 5 s`.

**Métricas y salud.** No hay endpoint de métricas; `GET /healthz` (sin token) es la sonda de vida que usa el *healthcheck* de Docker. Para ver el atraso de la ingesta: `XPENDING analytics:events analytics-workers` en Redis.

**Códigos de salida.** `2` si falta configuración obligatoria; `1` si no se pudieron aplicar las migraciones; `0` en un apagado limpio.

## 8. Decisiones de arquitectura

- [ADR 0006 · Tickets JWT HS256 emitidos por identity-api](../../docs/adr/0006-tickets-jwt-hs256-emitidos-por-identity-api.md)
- [ADR 0007 · Revocación por clave Redis y cierre 4001](../../docs/adr/0007-revocacion-por-clave-redis-y-cierre-4001.md)
- [ADR 0009 · Procesamiento asíncrono con Redis Streams](../../docs/adr/0009-procesamiento-asincrono-con-redis-streams.md)
- [ADR 0010 · Eventos de analítica sin PII](../../docs/adr/0010-eventos-de-analitica-sin-pii.md)

## 9. Enlaces

- [AGENTS.md](AGENTS.md): reglas del dominio, formas exactas de la API y variables.
- [Contrato de eventos de analítica](../../docs/contrato-eventos-analitica.md): qué publica cada servicio y qué devuelve analytics.
- [Usuarios, identidad y permisos §4](../../docs/usuarios-e-identidad.md#4-esquemas-de-tokens): claims del analytics-ticket.
- [Arquitectura](../../docs/arquitectura.md): [vista de componentes y conectores (§4)](../../docs/arquitectura.md#vista-de-componentes-y-conectores), almacenes (§6) y contratos (§5).
