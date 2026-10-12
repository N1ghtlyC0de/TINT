# Prueba de carga del Canal Sync (SYNC-TEST-01)

Script [k6](https://k6.io) que abre **500 conexiones WebSocket simultáneas** a una misma sala de `/ws/sync` y verifica los objetivos de latencia y precisión del dominio.

- **VU 1 = Host** (`role: host`): envía `PLAY` al recibir el `STATE` y un `SEEK` (+5 s) cada 10 s.
- **VUs 2..N = participantes** (`role: participant`): responden cada `HEARTBEAT` con `SYNC_CHECK`, calculando su posición a partir del ancla del Reloj Maestro (`position_ms + (server_time_ms − updated_at_ms + tiempo local transcurrido) × rate`), y aplican las `SYNC_CORRECTION`. Cada participante intenta además **un** `PAUSE` para comprobar que el servidor responde `FORBIDDEN`.

Los tokens HS256 se firman en `setup()` con `k6/crypto` usando el mismo formato que identity-api (`iss=tint-identity`, `aud=tint:room`, `room_id`, `role`, `nick`, `exp`). Por eso `JWT_SECRET` debe coincidir con el de sync-core.

## Cómo ejecutarla

```bash
# 1. Redis local
docker compose up -d redis

# 2. sync-core en :8083 (otra terminal)
cd services/sync-core
JWT_SECRET=dev-secret-change-in-prod SYNC_CORE_ADDR=:8083 REDIS_URL=redis://localhost:6379 go run .

# 3. Prueba (desde la raíz del monorepo)
k6 run -e ROOM_ID=sala-carga services/sync-core/loadtest/sync.js

# Humo rápido
k6 run -e ROOM_ID=sala-humo -e VUS=5 -e DURATION=10s services/sync-core/loadtest/sync.js
```

> k6 no envía cabecera `Origin`, así que `ALLOWED_ORIGINS` no interfiere. Para 500 conexiones conviene subir el límite de descriptores (`ulimit -n 4096`) en la máquina que corre k6 y sync-core.

### Variables (`-e NOMBRE=valor`)
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `BASE_URL` | `ws://localhost:8083` | Origen del servicio (sin ruta). |
| `ROOM_ID` | `loadtest-<timestamp>` | Sala; usa una nueva por corrida para empezar desde `version` 0. |
| `VUS` | `500` | Conexiones simultáneas (VU 1 es el Host). |
| `DURATION` | `60s` | Tiempo que cada VU mantiene su conexión (`ms`, `s`, `m`, `h`). |
| `SEEK_EVERY` | `10s` | Intervalo de `SEEK` del Host. |
| `JWT_SECRET` | `dev-secret-change-in-prod` | Secreto HS256 compartido con sync-core. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `tint-identity` / `tint:room` | Deben coincidir con la configuración del servicio. |
| `PROBE_FORBIDDEN` | `true` | `false` desactiva el intento de `PAUSE` de los participantes. |

## Cómo leer los resultados

| Métrica | Qué mide | Umbral |
| :--- | :--- | :--- |
| `sync_broadcast_latency_ms` | Recepción del broadcast en el participante − `occurred_at` del Host (mismo reloj: k6 corre todos los VUs en una máquina). Incluye Host → servidor → Redis Pub/Sub → servidor → participante. | `p(99) < 100` |
| `sync_drift_ms` | \|`drift_ms`\| de cada `SYNC_CORRECTION`; los chequeos sin corrección cuentan como 0. | `p(99) < 500` |
| `ws_connecting` | Duración del handshake WebSocket (incluye la validación del JWT). | `p(95) < 1000` |
| `sync_forbidden_errors` | Fracción de comandos de participantes rechazados con `FORBIDDEN`. Un valor < 1 indica un fallo de autorización. | `rate > 0.99` |
| `sync_corrections` | Total de `SYNC_CORRECTION` (etiqueta `strategy`: `rate`/`seek`). | informativo |
| `sync_server_errors` | `ERROR` inesperados (etiqueta `code`) y errores de socket. | informativo |
| `checks` | Handshakes con respuesta `101`. | `rate > 0.99` |

k6 marca con ✓/✗ cada umbral al final y termina con código distinto de 0 si alguno falla (útil en CI). Si falla:

- **Latencia alta**: revisar la latencia de Redis (Pub/Sub y `WATCH/MULTI`) y CPU del proceso; con un solo Host no debe haber reintentos de transacción.
- **Drift alto / muchas `seek`**: suele indicar heartbeats atrasados por saturación (colas de salida llenas) o cierres `1008` por cliente lento; revisar `sync_server_errors` y los logs de sync-core.
- **Handshakes lentos o fallidos**: límite de descriptores, `JWT_SECRET` distinto (respuesta `401`) o `ROOM_ID` con caracteres no válidos.

Para un reporte exportable: `k6 run --summary-export=resumen.json ...` (no versiones los resultados).
