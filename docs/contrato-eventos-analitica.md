# Contrato de eventos de analítica (`analytics:events`)

Qué debe publicar cada servicio para que Analítica pueda calcular los KPIs del proyecto
(REQ-03, REQ-28 a REQ-32). Dueño del contrato: dominio de Analítica (`services/analytics`).

## Cómo se publica

Cada servicio hace `XADD analytics:events * campo valor ...` en el Redis compartido.
Analítica lee con `XREADGROUP` (grupo `analytics-workers`) y persiste en PostgreSQL.

Reglas:

1. **No bloquear.** El `XADD` va después de atender al usuario y su error solo se registra en el log;
   nunca debe tumbar ni retrasar un play, un mensaje o un login.
2. **Campos planos.** Un stream de Redis guarda pares campo/valor de texto: nada de JSON anidado.
3. **Sin texto libre ni datos personales.** Nada de `text`, `nick`, `email` ni nombres. Del chat solo
   viaja `message_length` (Ley 1581).
4. **Mismo `event_id` que el evento original.** Si el mensaje, comando o reacción ya trae un
   `event_id`, se reutiliza; así un reintento no cuenta doble.
5. **Fechas en RFC 3339, UTC, con milisegundos:** `2026-10-11T04:29:49.368Z`.
6. **Nombres en `snake_case`**, tanto en `type` como en los campos.

## Campos comunes

| Campo | Obligatorio | Valor |
| :--- | :--- | :--- |
| `event_id` | Siempre | UUID del evento |
| `type` | Siempre | Uno de los tipos de la tabla de abajo |
| `occurred_at` | Siempre | Cuándo pasó. Reloj del cliente si el evento nace en el navegador; si no, reloj del servidor |
| `received_at` | Siempre | Cuándo lo recibió el servidor que publica (reloj del servidor) |
| `source` | Siempre | Servicio que publica: `identity-api`, `social-core`, `sync-core`, `media-worker` |
| `room_id` | En todo evento de sala | UUID de `rooms.id` |
| `user_id` | Cuando hay un actor | El `sub` del token: UID de Firebase para hosts, `guest:<uuid>` para invitados |

`user_id` debe ser el mismo valor en todos los servicios. `social-core` ya usa el `sub` del token
como `UserID`; `identity-api` debe publicar ese mismo `sub` (`users.provider_sub`), no `users.id`.

**Excepción: `sync-core` no envía `user_id`.** Sus eventos llevan `role` (`host` o `guest`) en su lugar:
el Canal Sync no necesita identificar a la persona y así se publica lo mínimo. Analítica guarda
`user_id` como `NULL` en esos eventos.

## Eventos

`position_ms` es siempre la posición del video en milisegundos, igual que en `/ws/sync` y en las reacciones.

### `identity-api`

| `type` | Cuándo | Campos propios | Sirve para |
| :--- | :--- | :--- | :--- |
| `user_login` | Login validado (`POST /auth/verify`) | `method` (`google`) | DAU/MAU (REQ-03) |
| `room_created` | Se crea una sala | — | Salas por día |
| `room_closed` | La sala deja de estar activa (hoy: borrado lógico) | `reason` (`deleted`, `host_closed`, `grace_expired`) | Dispara los KPIs de sesión (REQ-32) |
| `invitation_claimed` | Un invitado canjea un código | — | Invitados por sala |

`user_login` no lleva `room_id`. En `invitation_claimed`, `user_id` es el `guest:<uuid>` emitido.

### `social-core`

| `type` | Cuándo | Campos propios | Sirve para |
| :--- | :--- | :--- | :--- |
| `chat_message` | Se acepta un mensaje de chat | `message_length` | Engagement. **Ya se publica; le faltan `user_id`, `received_at` y `source`** |
| `presence` | Alguien entra o sale de la sala (los mismos avisos `joined`/`left`) | `kind` (`joined`, `left`), `connected_users` (conectados después del cambio) | Pico y promedio de espectadores |
| `reaction` | Se acepta una reacción (después del límite de 5/s) | `emoji`, `position_ms` | Heatmap (REQ-21 a REQ-23) |
| `trivia_answer` | Se evalúa una respuesta de trivia | `question_id`, `correct` (`true`/`false`), `response_ms` | % de aciertos (REQ-32) |

### `sync-core`

| `type` | Cuándo | Campos propios | Sirve para |
| :--- | :--- | :--- | :--- |
| `playback_command` | Se acepta un comando de reproducción (no duplicado) | `role`, `command` (`PLAY`, `PAUSE`, `SEEK`, `RATE`, `LOAD`), `position_ms` | Cómo se conduce la sesión |
| `drift_correction` | Se detecta un desfase mayor a 500 ms | `role`, `drift_ms`, `position_ms` (+ `rtt_ms`, `strategy`) | Calidad de sincronización (REQ-28) |
| `buffering` | Un cliente termina de recargar el video | `role`, `duration_ms`, `position_ms` | QoE |

`drift_correction` **reemplaza a `sync_drift`**, el nombre que usaba antes la telemetría de sync-core.

Origen de `buffering`: el navegador mide el atasco (evento `waiting` del `<video>` hasta el siguiente
`playing`) y, si dura al menos 100 ms, envía por el Canal Sync v2 el mensaje
`BUFFERING {event_id, room_id, position_ms, duration_ms, occurred_at}`. sync-core sella
`received_at`, valida `0 <= duration_ms <= 120000` y `position_ms >= 0`, limita a 1 por segundo por
conexión y solo publica el evento: no responde `ACK` ni hace broadcast.

Los latidos (`HEARTBEAT`) no se publican: son demasiados y no aportan a ningún KPI.

### `media-worker`

| `type` | Cuándo | Campos propios | Sirve para |
| :--- | :--- | :--- | :--- |
| `media_processed` | Termina de procesar un video, bien o mal | `media_id`, `status` (`ready`, `failed`), `duration_ms` (vacío o `0` si `failed`), `processing_ms` | Tasa de fallo y tiempo del worker |

No lleva `room_id`. `user_id` es quien subió el video (`users.provider_sub` de `uploaded_by`; vacío si es nulo).

## Ejemplo

Lo que `social-core` debería publicar por cada mensaje de chat:

```text
XADD analytics:events *
  event_id       405d5bef-33ef-463d-b151-1ee9a8f4ffe8
  type           chat_message
  source         social-core
  room_id        3d97d007-29c0-4cec-bb61-cb37683c3256
  user_id        guest:1f0c7a52-8a55-4a27-9f0e-0d1c2b3a4e5f
  message_length 17
  occurred_at    2026-10-11T04:29:49.368Z
  received_at    2026-10-11T04:29:49.411Z
```

## Qué entrega Analítica a cambio

- `telemetry_events` en PostgreSQL: todos los eventos sanitizados, 90 días, sin duplicados por `event_id`.
- `room_kpis`: al recibir `room_closed`, pico y promedio de espectadores, drift promedio, % de aciertos,
  conteos de mensajes, reacciones, comandos y buffering, y duración media del buffering de esa sala.
- Usuarios activos por día (DAU/MAU) a partir de `user_login` (consultable en SQL).
- **API de solo lectura** (`analytics`, puerto `ANALYTICS_PORT` = 8084) para el host de la sala, con el
  `analytics-ticket` que emite identity-api en `POST /api/v1/rooms/:id/analytics-ticket`:

| Ruta | Devuelve |
| :--- | :--- |
| `GET /healthz` | `{"status":"ok"}` |
| `GET /api/v1/rooms/{id}/kpis` | Los KPIs de arriba más `live` (`false` = `room_kpis` de una sala cerrada; `true` = calculados al vuelo), `closed_at` y `computed_at` |
| `GET /api/v1/rooms/{id}/reactions/heatmap?bucket_ms=5000` | `buckets` `[{bucket_start_ms, emoji, count}]` por posición del vídeo y `by_emoji` `[{emoji, count}]` |
| `GET /api/v1/rooms/{id}/timeline?step_s=60` | `points` `[{t, connected_users, messages, reactions}]` por intervalo |

Formas exactas, auth (HS256, `role` `host`, sala del token, revocación con falla cerrado) y errores:
[services/analytics/AGENTS.md](../services/analytics/AGENTS.md#api-solo-lectura-puerto-analytics_port-por-defecto-8084).
Nunca hay endpoints de tiempo real ni de eventos crudos.

Un evento con un `type` que no está en este documento se guarda igual, pero no entra a ningún KPI.
Para agregar un tipo o un campo: PR a este archivo.

## Estado al 2026-10-11

| Servicio | Publica hoy |
| :--- | :--- |
| `social-core` | Solo `chat_message`, sin `user_id`, `received_at` ni `source` |
| `identity-api` | `user_login`, `room_created`, `room_closed` (`reason=deleted`, solo el primer borrado) e `invitation_claimed`, con todos los campos comunes. Además entrega el analytics-ticket (`POST /rooms/:id/analytics-ticket`) |
| `sync-core` | Nada (el servicio aún no tiene WebSocket) |
| `media-worker` | Nada |
| `analytics` (consumidor) | Consume `analytics:events` (grupo `analytics-workers`), persiste en `telemetry_events`, consolida `room_kpis` con `room_closed`, purga a los 90 días y sirve la API de lectura. `room_id` solo se exige fuera de `user_login` y `media_processed` |
