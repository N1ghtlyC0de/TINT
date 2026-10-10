# 🤖 AGENT Guidelines — Domain: Core Sync (`services/sync-core`)

## Contexto & Responsabilidad
Eres el agente encargado del corazón de reproducción en tiempo real de **TINT**, desarrollado en **Golang**. Tu única meta es garantizar latencia ultrabaja (<100 ms) y precisión en la sincronización.

## Stack Técnico
- Go 1.22 (`net/http` con patrones de ruta de Go 1.22). Dependencias externas, cada una justificada por su impacto en latencia:
  - `github.com/coder/websocket` — WebSocket con `context`, sin goroutines ocultas por conexión y con `SetReadLimit`; la librería estándar no implementa WebSocket.
  - `github.com/redis/go-redis/v9` — cliente Redis con pool de conexiones, `WATCH/MULTI/EXEC` y Pub/Sub sobre una única conexión por réplica.
  - `github.com/golang-jwt/jwt/v5` — validación HS256 de tokens de identity-api restringiendo algoritmo, `iss`, `aud` y `exp` (evita reimplementar criptografía).
  - `github.com/google/uuid` — `event_id` y `id` de conexión (UUID v4).
  - `github.com/alicebob/miniredis/v2` — **solo pruebas**: Redis en memoria para tests deterministas del store, bus y telemetría.
- WebSockets para `/ws/sync`
- Redis (estado maestro + Pub/Sub entre réplicas + presencia de hosts)
- Imagen Docker `distroless/static` (non-root)

## Responsabilidades
- Reloj maestro por sala y difusión de comandos de reproducción.
- Validación del contrato de eventos (`internal/syncevent`).
- Latidos (`HEARTBEAT`) para medir latencia y detectar clientes caídos.
- Detección y corrección de drift (> 500 ms) y presencia del Host.

## Límites de Dominio
- ❌ No proceses chat, reacciones, trivias ni Ambilight (→ `services/social-core`).
- ❌ No persistas telemetría directamente: publica eventos en `analytics:events` (→ `services/analytics`).
- ❌ No introduzcas dependencias externas sin justificar su impacto en latencia (y documentarla en el Stack Técnico).
- ❌ No emitas tokens: los firma identity-api; sync-core solo los verifica.

## Modelo de Datos Involucrado
| Clave / Entidad | Tipo | Descripción |
| :--- | :--- | :--- |
| `room:{id}:sync_state` | Redis Hash | Ancla del Reloj Maestro: `status` (playing/paused), `position_ms`, `updated_at_ms` (reloj del servidor), `rate`, `version` (orden total de comandos), `host_id`. TTL 12 h (`ROOM_TTL`), refrescado en cada comando y desconexión. |
| `room:{id}:evt:{event_id}` | Redis String | Idempotencia: un `event_id` ya aplicado se ignora durante 1 min (ACK con `duplicate: true`). |
| `room:{id}:sync` | Redis Pub/Sub | Difusión de `Event` (comandos y `HOST_STATUS`) entre réplicas. |
| `room:{id}:hosts_online` | Redis ZSET | Presencia de conexiones host/cohost: miembro = id de conexión, score = último latido (unix ms). Un host sin latir en 5 s se considera fuera. |
| `analytics:events` | Redis Stream | Eventos `type=sync_drift` (`room_id`, `drift_ms`, `rtt_ms`, `strategy`, `role`, timestamps) **sin PII** (ni `sub` ni `nick`). `MAXLEN ~100000`. |
| `Event` | JSON | `event_id` (UUID), `type`, `room_id`, `position_ms`, `occurred_at`, `received_at`, `version` + campos opcionales por tipo (ver protocolo). |

La posición nunca se guarda "en vivo": `posición(t) = position_ms + (t − updated_at_ms) × rate` si `status = playing`; si no, `position_ms`.

## Protocolo del Canal Sync

### Conexión
`GET /ws/sync?room_id={id}&token={JWT}` (el token va en la query porque el navegador no permite headers en WebSocket; **nunca registres la URL completa**).

Tokens HS256 firmados por identity-api con `JWT_SECRET`, `iss=tint-identity`, `aud=tint:room`, `exp` obligatorio, `sub` no vacío, `room_id` igual al de la query:
- **Guest token** (al unirse a la sala) → `role: participant`.
- **Sync-ticket** (`POST /api/v1/rooms/:id/sync-ticket`) → `role: host` (`cohost` también puede controlar).

| Handshake | Resultado |
| :--- | :--- |
| Falta `room_id` o `token` | `400` |
| Token inválido / expirado / algoritmo distinto de HS256 / rol desconocido | `401` |
| Token de otra sala | `403` |
| `Origin` fuera de `ALLOWED_ORIGINS` | `403` |
| Redis no disponible al conectar | upgrade y cierre `1011` |
| OK | `101` y el servidor envía de inmediato un `STATE` |

### Mensajes
Todos los mensajes son JSON con `event_id`, `type`, `room_id`, `position_ms`, `occurred_at`, `received_at`, `version`; los campos opcionales se omiten si no aplican. `received_at` lo sella siempre el servidor.

| Tipo | Dirección | Campos relevantes |
| :--- | :--- | :--- |
| `PLAY` / `PAUSE` / `SEEK` | C → S (solo host/cohost) | `event_id` (UUID, idempotencia), `room_id`, `position_ms` (posición del reproductor del Host), `occurred_at` |
| `PLAY` / `PAUSE` / `SEEK` | S → todos (broadcast vía Pub/Sub, incluido el emisor) | mismo `event_id` y `occurred_at` del Host, `received_at`, `version`, ancla: `status`, `position_ms`, `rate`, `updated_at_ms`, `server_time_ms` |
| `ACK` | S → emisor | `ref_event_id`, `version` resultante, `duplicate` |
| `STATE` | S → cliente al conectar | ancla completa + `online` (hay host vivo) |
| `HEARTBEAT` | S → C cada 1 s | `server_time_ms` |
| `SYNC_CHECK` | C → S (respuesta a cada `HEARTBEAT`) | `event_id`, `room_id`, `position_ms` (posición local actual), `echo_server_ts` (= `server_time_ms` del HEARTBEAT), `occurred_at` |
| `SYNC_CORRECTION` | S → C (solo si \|drift\| > 500 ms) | `target_ms` (= `position_ms`), `strategy` (`rate`/`seek`), `drift_ms` (+ adelantado, − atrasado), `version` |
| `HOST_STATUS` | S → todos (vía Pub/Sub) | `online` (primer host conectado / último host desconectado) |
| `ERROR` | S → C | `code` (`FORBIDDEN`, `INVALID`, `RATE_LIMITED`, `INTERNAL`), `ref_event_id` |

### Heartbeat, RTT y drift
1. El servidor envía `HEARTBEAT{server_time_ms}`; el cliente responde `SYNC_CHECK` con `echo_server_ts` y su posición.
2. RTT = `ahora − echo_server_ts` medido **solo con el reloj del servidor** (el skew del cliente no afecta), suavizado con EWMA α = 0.2; muestras negativas se descartan.
3. El cliente leyó su posición ~RTT/2 antes de la llegada: `drift = posición_cliente − posición_maestra(recepción − RTT/2)`.
4. `|drift| ≤ 500 ms` → sin respuesta. `> 500 ms` → `SYNC_CORRECTION` con `target_ms = posición_maestra(ahora + RTT/2)`; estrategia `rate` si la sala reproduce y `|drift| ≤ 2000 ms`, `seek` si no. Cada corrección se emite como `sync_drift` a `analytics:events`.
5. Los comandos fijan el ancla en `received_at − RTT/2` del Host.
6. El `SYNC_CHECK` de un host/cohost refresca además su presencia en `hosts_online`.

### Orden y versiones
- El orden entre el `ACK` (directo) y el broadcast (vía Pub/Sub) **no está garantizado**; el cliente no debe depender de él.
- Todo el estado viaja con `version`; el cliente descarta `STATE`/broadcast/`SYNC_CORRECTION` con `version` menor a la última aplicada.
- Un `event_id` repetido no cambia el estado ni se difunde: solo recibe `ACK{duplicate: true}`.

### Límites
| Límite | Valor | Consecuencia |
| :--- | :--- | :--- |
| Tamaño de mensaje entrante | 4 KB | cierre `1009` |
| Mensajes entrantes | 20 msg/s por conexión (ventana fija) | `ERROR{RATE_LIMITED}` |
| Cola de salida | 64 mensajes por cliente | cliente lento → cierre `1008` |
| Latidos sin `SYNC_CHECK` | 3 intervalos | cierre `1008` |
| Comando de un `participant` | — | `ERROR{FORBIDDEN}` |

## Arquitectura interna
| Paquete | Responsabilidad |
| :--- | :--- |
| `internal/config` | Configuración desde el entorno (`getenv` inyectable). |
| `internal/syncevent` | Contrato `Event`, tipos, códigos de error, validación y claves Redis. |
| `internal/master` | Reloj Maestro puro (sin I/O): ancla, `PositionAt`, `Apply`. |
| `internal/drift` | EWMA del RTT y decisión de corrección (`rate`/`seek`). |
| `internal/auth` | Verificación HS256 de tokens de identity-api y roles. |
| `internal/store` | `sync_state` con `WATCH/MULTI/EXEC` + `PUBLISH` atómico, dedupe y presencia. |
| `internal/bus` | Pub/Sub entre réplicas (una conexión por réplica, suscripción solo a salas con clientes locales). |
| `internal/telemetry` | Emisión no bloqueante de `sync_drift` (buffer; si se llena se descarta). |
| `internal/hub` | Salas locales, despacho de comandos, heartbeat/drift, presencia del host. Independiente del transporte. |
| `internal/ws` | Handshake y transporte WebSocket. |
| `internal/server` | Rutas HTTP (`/healthz`, `/ws/sync`). |

**Modelo de concurrencia:** cada conexión tiene una goroutine **lectora** (la del handler HTTP, llama a `hub.Handle`) y una **escritora** (única dueña de `conn.Write`, drena la cola y emite `HEARTBEAT`). Cada cliente tiene una cola con buffer (64); `enqueue` nunca bloquea, así un cliente lento no frena a los demás. La réplica emisora no difunde localmente: todo comando pasa por Redis Pub/Sub, lo que da un único camino y orden consistente entre réplicas. `hub.rooms` se protege con `sync.Mutex`; RTT y último latido son `atomic`.

## Reglas de Dominio
1. **Aislamiento:** El canal WebSocket `/ws/sync` es exclusivo para comandos `PLAY`, `PAUSE`, `SEEK` y latidos. No proceses mensajes de chat aquí.
2. **Reloj Maestro:** Mantén el estado maestro de la sala en Redis (`room:{id}:sync_state`) como ancla; nunca con timers en el servidor.
3. **Formato de Payload:** Todo evento transmitido debe incluir `event_id` (UUID), `occurred_at` y `received_at`.
4. **Concurrencia:** Todo estado compartido protegido (`sync.Mutex`/canales/`atomic`); las pruebas corren con `-race`.
5. **TDD:** Implementa pruebas unitarias e integración en Go con `go test -cover`, escribiendo la prueba primero. La cobertura no puede bajar del **85%**. `main.go` debe ser mínimo; la lógica vive en `internal/`.
6. **Privacidad:** La telemetría nunca incluye `sub`, `nick` ni tokens.

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `SYNC_CORE_ADDR` | `:8080` | Dirección de escucha HTTP. |
| `REDIS_URL` | `redis://localhost:6379` | Redis de estado, Pub/Sub y streams. |
| `JWT_SECRET` | — (**obligatoria**) | Secreto HS256; debe ser el mismo de identity-api. Sin él el servicio no arranca. |
| `JWT_ISSUER` | `tint-identity` | `iss` esperado. |
| `JWT_AUDIENCE` | `tint:room` | `aud` esperado. |
| `ALLOWED_ORIGINS` | `localhost:5173` | Patrones de host permitidos en el handshake, separados por coma. |
| `ROOM_TTL` | `12h` | Periodo de gracia de la sala (duración Go, positiva). |

## Comandos
```bash
go vet ./...
go test -race -coverprofile=coverage.out ./...
../../scripts/check-go-coverage.sh coverage.out 85

# Prueba de carga SYNC-TEST-01 (500 conexiones; ver loadtest/README.md)
k6 run -e ROOM_ID=sala-carga -e JWT_SECRET=$JWT_SECRET loadtest/sync.js
```
