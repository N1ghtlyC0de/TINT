# 🤖 AGENT Guidelines — Domain: Core Social & Gamificación (`services/social-core`)

## Contexto & Responsabilidad
Gestionas la interactividad de la audiencia en **TINT**: chat, reacciones con control de spam, puntero láser del host, encuestas en vivo, el resumen (recap) de la sesión, agregación de Heatmaps, emisión de Ambilight en vivo y motor de Trivias con Leaderboards.

## Stack Técnico
- Go 1.22
- WebSockets (canal social, independiente de `/ws/sync`)
- Redis: Sorted Sets (leaderboards), Hashes/contadores (heatmaps), Pub/Sub
- Imagen Docker `distroless/static` (non-root)
- Verificación de Firebase ID tokens solo con la librería estándar (`crypto/rsa`, `crypto/x509`): sin dependencias nuevas.

## Responsabilidades
- Chat en vivo, reacciones y su rate limiting autoritativo (`internal/reactions`).
- Puntero láser del host/cohost (efímero, 30/s por usuario).
- Encuestas en vivo (`internal/polls`): una activa por sala, voto cambiable, cierre por tiempo o manual.
- Métricas de la sala y mensaje `recap` (`internal/recap`).
- Heatmaps de emoción por buckets de 5 s.
- Retransmisión de colores Ambilight sincronizados con la posición del vídeo.
- Motor de trivias y puntuación (`internal/trivia`).

## Límites de Dominio
- ❌ No emitas ni modifiques comandos de reproducción (→ `services/sync-core`).
- ❌ No extraigas paletas de color de vídeo (→ `services/media-worker`); solo consumes `ambilight.json`.
- ❌ No persistas el texto del chat en analítica; publica solo metadatos (→ `services/analytics`).

## Modelo de Datos Involucrado
| Clave / Entidad | Tipo | Descripción |
| :--- | :--- | :--- |
| `room:{id}:heatmap` | Redis Hash | `bucket_index → {emoji: count}` (buckets de 5 s) |
| `video:{id}:heatmap:history` | Redis/SQL | Histórico acumulado entre sesiones |
| `room:{id}:trivia:{n}:leaderboard` | Redis Sorted Set | `user_id → score`, TTL 1 h tras cierre |
| `Reaction` | JSON | `user_id`, `emoji`, `position_ms` |
| `room:{id}:social` | Redis Pub/Sub | `chat_message`, `reaction`, `laser` y `poll_state` entre réplicas (dedup por `event_id`; se re-serializan por tipo) |
| `room:{id}:sync` | Redis Pub/Sub (solo lectura) | `REVOKED` de identity-api y comandos `PLAY`/`PAUSE`/`SEEK`/`RATE`/`LOAD` de sync-core (solo para el recap) |
| `room:{id}:poll` | Redis Hash, TTL 12 h | Encuesta actual: `id`, `question`, `options` (JSON), `n_options`, `closes_at_ms`, `closed` (solo al cerrarse, `HSETNX`) |
| `room:{id}:poll:{pid}:votes` | Redis Hash, TTL 12 h | `user_id → índice de opción` (un voto por usuario, cambiable) |
| `room:{id}:poll:flush` | Redis String, PX 2 s | Marca de broadcast coalescido pendiente (una réplica emite por ventana de 250 ms) |
| `room:{id}:recap:emojis_by_user` | Redis Hash, TTL 12 h | `user_id → reacciones enviadas` |
| `room:{id}:recap:nicks` | Redis Hash, TTL 12 h | `user_id → último nick` |
| `room:{id}:recap:reactions` | Redis Hash, TTL 12 h | `bucket (5 s) → reacciones` |
| `room:{id}:recap:laughs` | Redis Hash, TTL 12 h | `bucket → reacciones 😂` |
| `room:{id}:recap:pauses` | Redis Hash, TTL 12 h | `bucket → pausas + rebobinados` (el rebobinado cuenta en el bucket de destino del `SEEK`) |
| `room:{id}:recap:totals` | Redis Hash, TTL 12 h | `reactions`, `pauses`, `rewinds`, `polls` |
| `room:{id}:recap:last_pos` | Redis Hash, TTL 12 h | Ancla de reproducción conocida: `pos`, `status`, `rate`, `updated_at_ms`, `version` |
| `room:{id}:recap:seen:{event_id}` | Redis String, EX 1 h | Dedup entre réplicas de los eventos del bus de sync (`SET NX`) |
| `token:revoked:{jti}` | Redis String (solo lectura) | Marca de revocación de identity-api |
| `analytics:events` | Redis Stream (solo escritura) | `chat_message`, `presence` y `reaction` para `services/analytics` (ver abajo) |

## Protocolo del Canal Social
JSON sobre `/ws/social`. Todo lo que se emite a la sala viaja también por `room:{id}:social` a las demás réplicas (dedup por `event_id`). Al entrar, el cliente recibe `history` y, si hay encuesta, su `poll_state` (con `my_vote`).

| Cliente → servidor | Quién | Respuesta / efecto |
| :--- | :--- | :--- |
| `chat_send{event_id, room_id, text, occurred_at}` | Todos (5/s) | `chat_message` a la sala |
| `reaction_send{event_id, room_id, emoji, position_ms, occurred_at}` | Todos (5/s) | `reaction` a la sala; suma al heatmap y al recap |
| `laser_point{event_id, room_id?, x, y, end?}` (`x`,`y` ∈ [0,1]) | Host/cohost (30/s) | `laser{event_id, room_id, user_id, nick, x, y, end}` a la sala; efímero |
| `poll_create{event_id, room_id?, question, options, duration_s}` (1..140 / 2..4 de 1..60 / 10..300 s) | Host/cohost | `poll_state` a la sala; `POLL_ACTIVE` si ya hay una abierta |
| `poll_vote{event_id, room_id?, poll_id, option}` (índice) | Todos (10/s, compartido con `recap_request`) | `poll_state` con `my_vote` solo al votante; broadcast coalescido (≤ 1 por 250 ms y sala) |
| `poll_close{event_id, room_id?, poll_id}` | Host/cohost | `poll_state{closed: true}` a la sala |
| `recap_request{event_id, room_id?}` | Todos | `recap` solo al que lo pide |

| Servidor → cliente | Forma |
| :--- | :--- |
| `poll_state` | `{event_id, type, room_id, poll_id, question, options[], counts[], closes_at_ms, closed, my_vote?}` |
| `recap` | `{type, room_id, event_id_ref, top_emoji_user: {user_id, nick, count}\|null, most_paused: {position_ms, count}\|null, peak_reactions: {position_ms, count, laughs}\|null, totals: {reactions, pauses, rewinds, polls}}` |
| `error` | `{type, code, event_id_ref?}` |

Códigos de `error`: `INVALID_PAYLOAD`, `TEXT_TOO_LONG`, `INVALID_EMOJI`, `RATE_LIMITED`, `FORBIDDEN` (láser/encuesta sin ser host o cohost), `POLL_ACTIVE`, `POLL_CLOSED` (votar o cerrar una encuesta ya cerrada o vencida), `POLL_NOT_FOUND` (`poll_id` que no es la encuesta actual), `UNAVAILABLE` (sin Redis o Redis caído: encuestas y recap).

**Host/cohost** = un HS256 de identity-api ligado a la sala con `role` `host` o `cohost` (el sync-ticket). Un Firebase ID token no dice de qué sala es dueño el usuario, así que **no** da permisos de moderación (falla cerrado): la web debe abrir `/ws/social` con el sync-ticket para usar láser y encuestas.

**`my_vote`:** el broadcast es el mismo para todos, así que solo los mensajes dirigidos a un cliente (al entrar y la respuesta a su propio voto) llevan `my_vote`; los broadcasts lo omiten y el cliente conserva el último que conoció para ese `poll_id`.

**Encuestas multirréplica:** cada réplica con clientes en la sala agenda un timer de cierre a `closes_at_ms` (reloj y `AfterFunc` inyectables); cerrar es idempotente (`HSETNX closed`) y solo la réplica que gana emite el `poll_state` final. Si una encuesta vencida no se cerró (p. ej. réplicas reiniciadas), se cierra cuando alguien entra. Votar después de `closes_at_ms` ya da `POLL_CLOSED` aunque el cierre no se haya emitido.

**Recap:** pausas = `PAUSE`; rebobinados = `SEEK` que cae más de 1 s por debajo de la posición proyectada del ancla previa (`last_pos`; si se reproducía, avanza con `updated_at_ms` y `rate`). Los eventos con `version` menor que el ancla llegaron tarde y no la mueven. Solo se cuentan los eventos que ve alguna réplica con clientes en la sala (la suscripción existe mientras haya conexiones). Empates: bucket más temprano y `user_id` menor. Sin Redis, láser funciona en una réplica; encuestas y recap responden `UNAVAILABLE`.

## Autenticación de `/ws/social`
El verificador se elige por el `alg` del header del token; nada se acepta sin firma válida y todo falla cerrado.

| Token | Quién | Verificación |
| :--- | :--- | :--- |
| HS256 (guest token o sync-ticket de identity-api) | Invitado | Firma con `JWT_SECRET`, `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`, `exp` obligatorio, `sub` y `jti` no vacíos, `room_id` = sala (si no, 403). Un HS256 inválido **no** cae al camino de host. |
| RS256 (Firebase ID token) | Host | Firma contra el certificado del `kid` ([certificados públicos de Google](https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com), caché según `Cache-Control max-age`, refetch ante `kid` desconocido como mucho 1/min); `iss` = `https://securetoken.google.com/<FIREBASE_PROJECT_ID>`, `aud` = `FIREBASE_PROJECT_ID`, `exp` e `iat` obligatorios, `sub` no vacío. Sin `FIREBASE_PROJECT_ID` o sin certificados → 401. |

**Revocación (contrato con identity-api):** en el handshake se consulta `EXISTS token:revoked:{jti}` (revocado → 401; Redis caído → 503). La suscripción Pub/Sub de cada sala con clientes locales escucha también `room:{id}:sync` y, ante `type: "REVOKED"`, cierra con **4001** los sockets de ese `jti` (borrar una sala revoca todos sus `jti`). Sin `REDIS_URL` (modo memoria) no hay fuente de revocación.

**Conexiones:** ping cada 20 s (10 s para el pong) y plazo de 5 s por escritura; una conexión muerta se corta y emite el aviso de salida. Los orígenes del handshake se limitan con `ALLOWED_ORIGINS`.

## Analítica (`analytics:events`)
Contrato: [docs/contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md). Lo publica `internal/analytics`, con el mismo patrón que la telemetría de sync-core:

- **No bloqueante:** los `Track*` de `Deps` solo encolan en un canal con buffer (4096); una goroutine (`Emitter.Run`, arrancada en `server.Run`) hace `XADD analytics:events MAXLEN ~ 100000`. Con el buffer lleno el evento se descarta y se cuenta (`Dropped`); un `XADD` fallido se cuenta (`Failed`) y solo se registra en el log.
- **Sin `REDIS_URL`** (modo memoria) los `Track*` quedan en `nil`: no se publica nada.
- **Campos comunes:** `event_id`, `type`, `source=social-core`, `room_id`, `user_id` (`sub` del token), `occurred_at` y `received_at` (RFC 3339 UTC con milisegundos). **Nunca** `text` ni `nick` (Ley 1581).

| `type` | Cuándo | Campos propios | `event_id` |
| :--- | :--- | :--- | :--- |
| `chat_message` | Mensaje aceptado (tras validación y límite) | `message_length` (runas tras recortar) | El del `chat_message` difundido |
| `presence` | Se emite un aviso `joined`/`left` (el `left`, tras la gracia de 5 s; multipestaña y reingresos dentro de la gracia no generan evento) | `kind` (`joined`, `left`), `connected_users` | El del aviso (`notice`) |
| `reaction` | Reacción aceptada (después del límite de 5/s) | `emoji`, `position_ms` | El de la `reaction` difundida |

**Limitación de `connected_users`:** es el conteo de usuarios distintos con presencia **en esta réplica** (incluye a quien acaba de salir y sigue dentro de la gracia), tomado bajo el mismo lock que el cambio. La presencia no se comparte entre réplicas: con varias réplicas, cada una publica su propio conteo y Analítica no debe sumarlos como si fueran globales.

`trivia_answer` **no se publica**: el servidor todavía no evalúa respuestas de trivia (solo existe `trivia.Score`). Se agrega cuando exista el flujo de trivia por WebSocket.

## Variables de entorno
| Variable | Por defecto | Uso |
| :--- | :--- | :--- |
| `SOCIAL_CORE_ADDR` | `:8082` | Dirección de escucha |
| `JWT_SECRET` | — (**obligatoria**: sin ella no arranca) | Secreto HS256 compartido con identity-api |
| `JWT_ISSUER` | `tint-identity` | `iss` esperado en tokens HS256 |
| `JWT_AUDIENCE` | `tint:room` | `aud` esperado en tokens HS256 |
| `FIREBASE_PROJECT_ID` | — (vacía = se rechazan los host tokens) | Proyecto Firebase de los host tokens |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | Patrones de origen (host[:puerto]) aceptados en el handshake; en compose sale de `SOCIAL_ALLOWED_ORIGINS` |
| `REDIS_URL` | — (vacía = memoria, una réplica) | Historial, Pub/Sub entre réplicas, revocación, encuestas, recap y analítica |

## Reglas de Dominio
1. **Bucketing & Rate Limiting:** Limita las reacciones a 5/s por usuario, el láser a 30/s y votos/recap a 10/s. Agrupa datos en buckets de 5 segundos.
2. **Heatmaps:** Emite el evento de Heatmap en vivo cada 1 s. Consulta el histórico acumulado si existen ≥ 3 sesiones previas.
3. **Trivias:** Calcula el puntaje bonificando la velocidad (hasta 10 000 ms). Persiste los Leaderboards en Sorted Sets de Redis con TTL de 1 hora post-cierre de sala.
4. **TDD:** Pruebas rigurosas (prueba primero) de algoritmos de puntuación y límites de tasa, con relojes inyectados (nunca `time.Sleep` en tests). Cobertura mínima: **85%**.

## Comandos
```bash
go vet ./...
go test -race -coverprofile=coverage.out ./...
../../scripts/check-go-coverage.sh coverage.out 85
```
