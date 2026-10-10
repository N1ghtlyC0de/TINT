# ⏱️ Dominio de Reproducción — Canal Sync

> Documento técnico de la feature de reproducción sincronizada de TINT: qué se construyó, cómo funciona, qué se integró en cada dominio y cómo se verificó.
> Rama: `feat/reproductor` · Servicio principal: [`services/sync-core`](../services/sync-core) · Protocolo detallado: [`services/sync-core/AGENTS.md`](../services/sync-core/AGENTS.md).

## Índice
1. [Resumen](#1-resumen)
2. [Requisitos cubiertos](#2-requisitos-cubiertos)
3. [Vista general](#3-vista-general)
4. [Mapa de cambios por dominio](#4-mapa-de-cambios-por-dominio)
5. [El Reloj Maestro](#5-el-reloj-maestro)
6. [Flujos principales](#6-flujos-principales)
7. [Modelo de datos en Redis](#7-modelo-de-datos-en-redis)
8. [Arquitectura interna de sync-core](#8-arquitectura-interna-de-sync-core)
9. [Cliente web](#9-cliente-web)
10. [Seguridad y límites](#10-seguridad-y-límites)
11. [Configuración y ejecución local](#11-configuración-y-ejecución-local)
12. [Verificación y resultados](#12-verificación-y-resultados)
13. [Decisiones de diseño y desviaciones del plan](#13-decisiones-de-diseño-y-desviaciones-del-plan)
14. [Limitaciones conocidas](#14-limitaciones-conocidas)

---

## 1. Resumen

TINT es una *Watch Party*: todos los participantes de una sala deben ver **el mismo fotograma al mismo tiempo**. Esta feature implementa el *Core Sync Domain* completo:

- **sync-core (Go)**: servidor WebSocket `/ws/sync` con Reloj Maestro en Redis, comandos `PLAY`/`PAUSE`/`SEEK` autorizados por rol, difusión entre réplicas por Redis Pub/Sub, medición de RTT y corrección de *drift*, presencia del Host y telemetría no bloqueante.
- **identity-api (TypeScript)**: endpoint `POST /api/v1/rooms/:id/sync-ticket` que emite un token HS256 de vida corta para que el Host entre al Canal Sync.
- **web (React)**: hook `useSyncSocket` y componente `SyncedPlayer` integrados en la página `WatchRoom`.
- **infraestructura**: servicio `sync-core` en `docker-compose.yml`, variables en `.env.example`, caché de dependencias Go en CI y prueba de carga k6.

### Commits de la rama

```mermaid
gitGraph
    commit id: "84a5e7b base"
    branch feat/reproductor
    commit id: "3c0c542 reloj y drift"
    commit id: "0625aba contrato sync"
    commit id: "ebe9146 config y JWT"
    commit id: "665942d sync-ticket"
    commit id: "8d00d56 store Redis"
    commit id: "e0160a7 bus y telemetria"
    commit id: "e9cecd5 hub"
    commit id: "87ff669 handler WS"
    commit id: "a102af5 web sync"
    commit id: "524428b arranque"
    commit id: "8334b7f infra y CI"
    commit id: "1b43dc0 docs y k6"
    commit id: "aad0ad7 cache hub"
```

| Commit | Alcance | Contenido |
| :--- | :--- | :--- |
| `3c0c542` | sync-core | `internal/master` (ancla, `PositionAt`, `Apply`) e `internal/drift` (EWMA de RTT, umbrales). |
| `0625aba` | sync-core | Contrato `syncevent.Event` extendido: tipos, códigos de error, `Validate`/`ValidateInbound`, claves Redis. |
| `ebe9146` | sync-core | `internal/config` y `internal/auth` (verificación HS256, roles). |
| `665942d` | identity-api | `generateSyncTicket` + ruta `POST /rooms/:id/sync-ticket`. |
| `8d00d56` | sync-core | `internal/store`: estado con `WATCH/MULTI/EXEC`, dedupe, presencia de hosts. |
| `e0160a7` | sync-core | `internal/bus` (Pub/Sub) e `internal/telemetry` (`XADD analytics:events`). |
| `e9cecd5` | sync-core | `internal/hub`: salas, comandos, heartbeat, drift y `HOST_STATUS`. |
| `87ff669` | sync-core | `internal/ws`: handshake JWT, goroutines lectora/escritora, códigos de cierre. |
| `a102af5` | web | `syncProtocol.ts`, `drift.ts`, `useSyncSocket`, `SyncedPlayer`, integración en `WatchRoom`. |
| `524428b` | sync-core | `internal/server.Run`: Redis, ensamblado y apagado ordenado; `main.go` mínimo. |
| `8334b7f` | sync-core | Dockerfile, `docker-compose.yml`, `.env.example`, caché de CI. |
| `1b43dc0` | sync-core | Protocolo en `AGENTS.md` y prueba de carga `loadtest/sync.js`. |
| `aad0ad7` | sync-core | Caché del estado por sala en el hub (elimina un `HGETALL` por latido). |

---

## 2. Requisitos cubiertos

| Requisito | Descripción | Implementación |
| :--- | :--- | :--- |
| **HU-SYNC-01** | Canal `/ws/sync?room_id=X` aislado, estado inmediato al conectar | `internal/ws` + `hub.Connect` envía `STATE` antes de cualquier otro mensaje. |
| **REQ-27 / HU-SYNC-02** | `PLAY`/`PAUSE`/`SEEK` del Host a todos en < 100 ms; participantes sin control | `hub.Handle` → `store.Apply` (transacción + `PUBLISH`) → `bus` → todas las réplicas. Participante → `ERROR{FORBIDDEN}`. Medido: 2–4 ms extremo a extremo. |
| **REQ-28 / HU-SYNC-03** | Drift > 500 ms compensando RTT, corrección suave y métrica | `internal/drift`: estrategia `rate` (±5 %) o `seek`; `sync_drift` a `analytics:events`. |
| **REQ-07** | La sala sobrevive 12 h si el Host se cae | TTL de 12 h refrescado en cada comando, conexión y desconexión; la reproducción sigue el reloj sin conexiones. |
| **REQ-08 / SYNC-BE-05** | Escalado horizontal entre réplicas | Toda difusión pasa por Redis Pub/Sub; presencia de hosts en un ZSET compartido. |
| **SYNC-BE-01..04** | Handshake JWT, Reloj Maestro, comandos, RTT/drift | Paquetes `auth`, `master`, `store`, `drift`. |
| **SYNC-TEST-01** | 500 conexiones simultáneas | `loadtest/sync.js` (k6). Ver [resultados](#12-verificación-y-resultados). |
| **Ley 1581** | Analítica sin PII | `telemetry.DriftSample` no lleva `sub`, `nick` ni token. |

---

## 3. Vista general

```mermaid
flowchart LR
    subgraph Navegador
        H["Host<br/>WatchRoom + SyncedPlayer"]
        G["Invitados<br/>WatchRoom + SyncedPlayer"]
    end

    subgraph identity["identity-api :8081"]
        T["POST /rooms/:id/sync-ticket<br/>HS256 role=host"]
        GT["Guest token<br/>HS256 role=participant"]
    end

    subgraph sync["sync-core :8082 (N réplicas)"]
        WS["/ws/sync<br/>handler WS"]
        HUB["hub<br/>salas, comandos, drift"]
        ST["store<br/>WATCH/MULTI"]
        BUS["bus<br/>Pub/Sub"]
        TEL["telemetry<br/>buffer no bloqueante"]
    end

    subgraph redis["Redis"]
        S[("room:{id}:sync_state")]
        P{{"room:{id}:sync"}}
        Z[("room:{id}:hosts_online")]
        A[["analytics:events"]]
    end

    AN["analytics<br/>XREADGROUP"]

    H -- "1. pide ticket (Firebase)" --> T
    G -. "token al unirse" .-> GT
    H <-- "WebSocket" --> WS
    G <-- "WebSocket" --> WS
    WS --> HUB
    HUB --> ST
    HUB --> TEL
    ST --> S
    ST -- PUBLISH --> P
    ST --> Z
    P -- SUBSCRIBE --> BUS
    BUS --> HUB
    TEL -- XADD --> A
    A --> AN
```

**Idea central:** sync-core no guarda "el segundo actual" ni usa temporizadores. Guarda un **ancla** (posición + instante del servidor + velocidad) y cualquiera puede calcular la posición en cualquier momento. Cada comando es una sola escritura atómica que además publica el cambio para todas las réplicas.

---

## 4. Mapa de cambios por dominio

```mermaid
flowchart TB
    classDef nuevo fill:#0f5132,stroke:#75b798,color:#fff
    classDef mod fill:#664d03,stroke:#ffda6a,color:#fff

    subgraph SC["services/sync-core"]
        direction TB
        m1["internal/master"]:::nuevo
        m2["internal/drift"]:::nuevo
        m3["internal/syncevent"]:::mod
        m4["internal/config"]:::nuevo
        m5["internal/auth"]:::nuevo
        m6["internal/store"]:::nuevo
        m7["internal/bus"]:::nuevo
        m8["internal/telemetry"]:::nuevo
        m9["internal/hub"]:::nuevo
        m10["internal/ws"]:::nuevo
        m11["internal/server"]:::mod
        m12["main.go, go.mod, Dockerfile"]:::mod
        m13["loadtest/sync.js + README"]:::nuevo
        m14["AGENTS.md"]:::mod
    end

    subgraph ID["services/identity-api"]
        i1["auth.service.ts<br/>generateSyncTicket"]:::mod
        i2["rutas v1<br/>POST /rooms/:id/sync-ticket"]:::mod
        i3[".env.example<br/>SYNC_TICKET_TTL_SECONDS"]:::mod
    end

    subgraph WEB["apps/web"]
        w1["lib/syncProtocol.ts"]:::nuevo
        w2["lib/drift.ts<br/>applyCorrection"]:::mod
        w3["hooks/useSyncSocket.ts"]:::nuevo
        w4["components/SyncedPlayer.tsx"]:::nuevo
        w5["pages/WatchRoom.tsx"]:::mod
        w6["test/mockWebSocket.ts"]:::nuevo
    end

    subgraph INF["Raíz / infraestructura"]
        r1["docker-compose.yml<br/>servicio sync-core"]:::mod
        r2[".env.example<br/>JWT_*, SYNC_ALLOWED_ORIGINS"]:::mod
        r3["ci-pipeline.yml<br/>caché go.sum"]:::mod
    end

    i1 -- "contrato JWT HS256" --> m5
    w3 -- "protocolo JSON" --> m10
    w3 -- "pide ticket" --> i2
    r1 --> SC
```

🟩 nuevo · 🟨 modificado

| Dominio | Qué se integró |
| :--- | :--- |
| **sync-core** | Servicio completo (antes solo tenía `/healthz` y el contrato `Event`). |
| **identity-api** | Sync-ticket del Host con `role: host`, `jti`, `exp = ahora + SYNC_TICKET_TTL_SECONDS` (600 s); el guest token ahora fija HS256 explícitamente. Solo el dueño de la sala obtiene ticket (`requireAuthHost` + `requireRoomOwner`). |
| **web** | Cliente del Canal Sync que reemplaza el `TODO /ws/sync` de `WatchRoom`; el vídeo sale de `VITE_DEMO_VIDEO_URL`. |
| **infra** | `sync-core` en `docker compose` (puerto `8082`), dependencias Go cacheadas en CI. |

---

## 5. El Reloj Maestro

El estado de cada sala es un ancla:

| Campo | Significado |
| :--- | :--- |
| `status` | `playing` o `paused` |
| `position_ms` | Posición del vídeo **en el instante del ancla** |
| `updated_at_ms` | Instante del ancla, reloj del **servidor** (unix ms) |
| `rate` | Velocidad (1.0) |
| `version` | Contador monotónico: orden total de comandos |
| `host_id` | `sub` del último Host conectado |

```text
PositionAt(t) = position_ms + (t − updated_at_ms) × rate   si playing
              = position_ms                                 si paused
```

```mermaid
stateDiagram-v2
    [*] --> Paused: Init (position 0, version 0)
    Paused --> Playing: PLAY(pos)<br/>ancla = pos en recv − RTT/2
    Playing --> Paused: PAUSE(pos)<br/>congela en pos
    Playing --> Playing: SEEK(pos)<br/>nueva ancla, sigue reproduciendo
    Paused --> Paused: SEEK(pos)
    Playing --> Playing: PLAY (re-ancla)
    Paused --> Paused: PAUSE (re-ancla)
    note right of Playing
        Cada transición incrementa version.
        El ancla se fija en received_at − RTT/2
        del emisor para compensar la red.
    end note
```

`master.Apply` es una función pura (sin I/O) y es **la única** que calcula el siguiente estado; Redis solo lo persiste.

---

## 6. Flujos principales

### 6.1 Conexión (handshake)

```mermaid
sequenceDiagram
    autonumber
    actor Host
    participant ID as identity-api
    participant WS as sync-core ws
    participant HUB as hub
    participant R as Redis

    Host->>ID: POST /rooms/:id/sync-ticket (Bearer Firebase)
    ID-->>Host: { token HS256 role=host, expiresAt }
    Host->>WS: GET /ws/sync?room_id=X&token=JWT
    WS->>WS: Verify(token, room_id)<br/>alg, iss, aud, exp, room_id, rol
    alt token inválido
        WS-->>Host: 401 (sin upgrade)
    else token de otra sala / origen no permitido
        WS-->>Host: 403
    else válido
        WS-->>Host: 101 Switching Protocols
        WS->>HUB: Connect(claims)
        HUB->>R: SUBSCRIBE room:X:sync (si es el primer cliente local)
        HUB->>R: Init: HSETNX campos + PEXPIRE 12h
        HUB->>R: ZADD hosts_online (solo host/cohost)
        HUB-->>Host: STATE { ancla, version, online }
        opt primer host vivo
            HUB->>R: PUBLISH HOST_STATUS online=true
        end
    end
```

Los invitados siguen el mismo flujo con el guest token que emite identity-api al unirse (rol `participant`).

### 6.2 Comando del Host (PLAY / PAUSE / SEEK) entre réplicas

```mermaid
sequenceDiagram
    autonumber
    actor Host
    participant A as réplica A (hub)
    participant R as Redis
    participant B as réplica B (hub)
    actor Inv as Invitado en B

    Host->>A: SEEK { event_id, position_ms, occurred_at }
    A->>A: rate limit, ValidateInbound, rol host/cohost
    loop hasta 50 reintentos si hay conflicto
        A->>R: WATCH sync_state, evt:{event_id}
        A->>R: EXISTS evt + HGETALL sync_state
        A->>A: master.Apply(cmd, recv, RTT) → version+1
        A->>R: MULTI · SET evt PX 60s · HSET · PEXPIRE · PUBLISH · EXEC
    end
    A-->>Host: ACK { ref_event_id, version, duplicate=false }
    R-->>A: mensaje room:X:sync
    R-->>B: mensaje room:X:sync
    A-->>Host: SEEK { ancla nueva, version }
    B-->>Inv: SEEK { ancla nueva, version }
    Note over Host,Inv: El orden ACK/broadcast no está garantizado:<br/>los clientes filtran por version.
```

- Un **participante** que envía un comando recibe `ERROR{FORBIDDEN}` y el estado no cambia.
- Un `event_id` repetido (reintento tras reconexión) recibe `ACK{duplicate:true}` y no se difunde.
- La réplica emisora **no** difunde localmente: todos reciben el cambio por Pub/Sub, así hay un único camino y el mismo orden en todas las réplicas.

### 6.3 Heartbeat, RTT y drift

```mermaid
sequenceDiagram
    autonumber
    participant S as sync-core (escritora)
    participant C as Cliente
    participant H as hub
    participant T as telemetry
    participant R as Redis

    loop cada 1 s
        S->>C: HEARTBEAT { server_time_ms }
        C->>H: SYNC_CHECK { echo_server_ts, position_ms }
        H->>H: rtt = ahora − echo_server_ts (solo reloj del servidor)<br/>RTT = 0.8·RTT + 0.2·rtt
        H->>H: drift = pos_cliente − PositionAt(recv − RTT/2)
        alt |drift| > 500 ms
            H-->>C: SYNC_CORRECTION { target_ms, strategy, drift_ms, version }
            H-)T: EmitDrift (no bloqueante)
            T-)R: XADD analytics:events type=sync_drift
        end
    end
    Note over S,C: 3 latidos sin SYNC_CHECK → cierre 1008
```

```mermaid
flowchart TD
    A["SYNC_CHECK recibido"] --> B["drift = pos_cliente − PositionAt(recv − RTT/2)"]
    B --> C{"|drift| > 500 ms?"}
    C -- no --> D["Sin respuesta"]
    C -- sí --> E{"sala playing<br/>y |drift| ≤ 2000 ms?"}
    E -- sí --> F["strategy = rate<br/>cliente usa 1.05 si va atrasado<br/>o 0.95 si va adelantado"]
    E -- no --> G["strategy = seek<br/>salto directo a target_ms"]
    F --> H["target_ms = PositionAt(ahora + RTT/2)"]
    G --> H
    H --> I["SYNC_CORRECTION + sync_drift a analytics"]
```

El RTT se mide **solo con el reloj del servidor** (el cliente devuelve el `server_time_ms` que recibió), así que un reloj de cliente adelantado o atrasado no afecta el cálculo.

### 6.4 Presencia y caída del Host (REQ-07)

```mermaid
sequenceDiagram
    autonumber
    actor Host
    participant A as réplica A
    participant R as Redis
    actor Inv as Invitados

    Host-xA: conexión perdida
    A->>R: ZREM hosts_online conn_id
    A->>R: ZCOUNT hosts_online (latido en los últimos 5 s)
    alt no quedan hosts
        A->>R: PUBLISH HOST_STATUS online=false
        R-->>Inv: HOST_STATUS online=false
        Note over Inv: "Host desconectado"<br/>el vídeo sigue según el reloj maestro
    end
    A->>R: PEXPIRE sync_state 12h
    Note over R: El estado vive 12 h sin conexiones
    Host->>A: reconecta con ticket nuevo
    A-->>Host: STATE (recupera el control)
    A->>R: PUBLISH HOST_STATUS online=true
```

Si una réplica muere sin ejecutar `HostGone`, su entrada en el ZSET deja de contar a los 5 s porque el score es el último latido.

### 6.5 Ciclo de vida de una conexión

```mermaid
stateDiagram-v2
    [*] --> Validando: GET /ws/sync
    Validando --> Rechazada: 400 / 401 / 403
    Validando --> Conectada: 101 + hub.Connect
    Validando --> Cerrada1011: Redis no disponible
    state Conectada {
        [*] --> Activa
        Activa --> Activa: lectora → hub.Handle
        Activa --> Activa: escritora → cola + HEARTBEAT
    }
    Conectada --> Cerrada1008: cola llena (64) o 3 latidos sin respuesta
    Conectada --> Cerrada1009: mensaje > 4 KB
    Conectada --> Cerrada1000: cliente cierra
    Cerrada1008 --> Desconectada
    Cerrada1009 --> Desconectada
    Cerrada1000 --> Desconectada
    Desconectada --> [*]: hub.Disconnect (presencia + TTL)
```

---

## 7. Modelo de datos en Redis

```mermaid
erDiagram
    SALA ||--|| SYNC_STATE : "room:{id}:sync_state (Hash, TTL 12h)"
    SALA ||--o{ EVT : "room:{id}:evt:{event_id} (String, 1 min)"
    SALA ||--|| CANAL : "room:{id}:sync (Pub/Sub)"
    SALA ||--o{ HOST_CONN : "room:{id}:hosts_online (ZSET)"
    SALA ||--o{ SYNC_DRIFT : "analytics:events (Stream)"

    SYNC_STATE {
        string status "playing | paused"
        int position_ms
        int updated_at_ms "reloj del servidor"
        float rate
        int version "orden total"
        string host_id
    }
    EVT {
        string valor "1, solo para dedupe"
    }
    CANAL {
        json Event "comandos y HOST_STATUS"
    }
    HOST_CONN {
        string member "id de conexión"
        int score "último latido unix ms"
    }
    SYNC_DRIFT {
        string type "sync_drift"
        string room_id
        int drift_ms
        int rtt_ms
        string strategy "rate | seek"
        string role
        string occurred_at
        string received_at
    }
```

| Clave | Escrita por | Vida |
| :--- | :--- | :--- |
| `room:{id}:sync_state` | `store.Init`, `store.Apply`, `store.Touch` | 12 h desde la última actividad |
| `room:{id}:evt:{event_id}` | `store.Apply` | 1 min |
| `room:{id}:sync` | `store.Apply` (comandos), `hub` (`HOST_STATUS`) | efímero |
| `room:{id}:hosts_online` | `HostSeen` al conectar y en cada `SYNC_CHECK` de host; `HostGone` | 12 h; miembros cuentan 5 s desde su último latido |
| `analytics:events` | `telemetry.Run` | `MAXLEN ~100000` |

---

## 8. Arquitectura interna de sync-core

```mermaid
flowchart TD
    main["main.go<br/>signal.NotifyContext"] --> server
    server["server<br/>Run: config, Redis, ensamblado, Shutdown"] --> config
    server --> ws
    server --> hub
    server --> store
    server --> bus
    server --> telemetry
    ws["ws<br/>handshake, lectora/escritora"] --> auth
    ws --> hub
    hub["hub<br/>salas, caché, despacho"] --> master
    hub --> drift
    hub --> syncevent
    hub -. "interfaz StateStore" .-> store
    hub -. "interfaz Bus" .-> bus
    hub -. "interfaz Telemetry" .-> telemetry
    store["store<br/>WATCH/MULTI, presencia"] --> master
    store --> syncevent
    drift["drift<br/>EWMA, umbrales"] --> master
    master["master<br/>ancla pura"] --> syncevent
    auth["auth<br/>HS256"]
    bus["bus<br/>Pub/Sub"]
    telemetry["telemetry<br/>XADD"]
    config["config<br/>getenv"]
    syncevent["syncevent<br/>contrato Event"]
```

El hub depende de **interfaces** (`StateStore`, `Bus`, `Telemetry`), lo que permitió probarlo con dobles y con miniredis sin levantar Redis real.

### Concurrencia por conexión

```mermaid
flowchart LR
    subgraph conexión
        L["goroutine lectora<br/>conn.Read → hub.Handle"]
        W["goroutine escritora<br/>única dueña de conn.Write"]
        Q[("cola send<br/>buffer 64")]
    end
    BUS["bus (Pub/Sub)"] -- "Deliver → enqueue" --> Q
    L -- "ACK / ERROR / CORRECTION" --> Q
    Q --> W
    TK["ticker 1 s"] --> W
    W -- "HEARTBEAT o cierre con código" --> Socket(("socket"))
    L -. "ctx cancelado → Disconnect" .-> W
```

- `enqueue` **nunca bloquea**: si la cola de un cliente está llena se le desconecta (`1008`) y, al reconectar, recibe `STATE`. Un cliente lento no frena a los otros 499.
- Solo la escritora escribe y cierra el socket, con un código explícito; la lectora termina cuando el socket se cierra.
- **Caché por sala** (`aad0ad7`): el hub guarda el último estado de cada sala, lo actualiza con `Init` y con cada broadcast recibido (solo si la `version` es mayor) y lo refresca desde Redis cada 5 s. Antes, cada `SYNC_CHECK` hacía un `HGETALL`: con 500 clientes eran 500 lecturas/s por sala que competían con los comandos del Host.

---

## 9. Cliente web

```mermaid
flowchart TD
    WR["WatchRoom.tsx"] --> USS["useSyncSocket(roomId, role)"]
    WR --> SP["SyncedPlayer"]
    USS -- "{ state, correction, hostOnline,<br/>connected, lastError, sendCommand }" --> SP
    SP --> V["&lt;video&gt;"]

    USS --> C{"rol"}
    C -- host --> TK["POST /rooms/:id/sync-ticket<br/>en cada (re)conexión"]
    C -- guest --> LS["localStorage tint_guest_token"]
    TK --> OPEN["new WebSocket(VITE_SYNC_WS_URL)"]
    LS --> OPEN
    OPEN -- "onclose" --> BO["backoff 500 ms → 10 s"]
    BO --> C
```

| Mensaje recibido | Acción del hook / reproductor |
| :--- | :--- |
| `STATE` | Reemplaza el snapshot (siempre) y actualiza `hostOnline`. |
| `PLAY`/`PAUSE`/`SEEK` | Se aplica solo si `version` es mayor que la local. El reproductor salta a la posición esperada y hace `play()`/`pause()`. |
| `HEARTBEAT` | Responde `SYNC_CHECK` con la posición actual del `<video>`. |
| `SYNC_CORRECTION` | `seek` → `currentTime = target`; `rate` → `playbackRate` 1.05/0.95 hasta quedar a < 100 ms o 5 s como máximo. |
| `HOST_STATUS` | Muestra u oculta la etiqueta "Host desconectado". |
| `ERROR` | Mensaje legible (`FORBIDDEN`, `RATE_LIMITED`, …). |

Si el navegador bloquea el autoplay, el reproductor muestra el botón **"Unirse a la reproducción"**. Los controles se deshabilitan para participantes y mientras no hay conexión; el servidor sigue siendo la autoridad.

---

## 10. Seguridad y límites

| Aspecto | Medida |
| :--- | :--- |
| Autenticación | JWT HS256 de identity-api; `WithValidMethods(HS256)`, `iss=tint-identity`, `aud=tint:room`, `exp` obligatorio, `sub` no vacío, `room_id` igual al de la query. Se valida **antes** del upgrade. |
| Autorización | Solo `host`/`cohost` emiten comandos; `participant` → `FORBIDDEN`. |
| Origen | `OriginPatterns` desde `ALLOWED_ORIGINS` (403 si no coincide). |
| Token en la URL | Inevitable en WebSocket de navegador; el servicio nunca registra la URL y el sync-ticket dura 10 min. |
| Tamaño | 4 KB por mensaje (cierre `1009`). |
| Frecuencia | 20 mensajes/s por conexión (`ERROR{RATE_LIMITED}`). |
| Relojes de cliente | `received_at` siempre lo sella el servidor; `ValidateInbound` no compara relojes de máquinas distintas. |
| Privacidad | `sync_drift` sin `sub`, `nick` ni token (Ley 1581). |

---

## 11. Configuración y ejecución local

```mermaid
flowchart LR
    subgraph compose["docker compose"]
        PG[("postgres :5432")]
        RD[("redis :6379")]
        MI[("minio :9000/9001")]
        SC["sync-core :8082→8080"]
    end
    IDA["identity-api :8081<br/>(npm run dev)"]
    WEB["web :5173<br/>(npm run dev)"]
    SC --> RD
    IDA --> PG
    WEB -- "HTTP" --> IDA
    WEB -- "WebSocket" --> SC
```

```bash
cp .env.example .env                     # JWT_SECRET compartido por identity-api y sync-core
docker compose up -d                     # postgres, redis, minio y sync-core
cd services/identity-api && npm run dev  # :8081
cd apps/web && cp .env.example .env && npm run dev   # define VITE_DEMO_VIDEO_URL
```

Abrir `/watch/:roomId` como Host en una pestaña y como invitado en otra: los comandos del Host se reflejan en el invitado.

| Variable | Servicio | Valor por defecto |
| :--- | :--- | :--- |
| `JWT_SECRET` | sync-core, identity-api | `dev-secret-change-in-prod` (**cambiar en producción**) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | ambos | `tint-identity` / `tint:room` |
| `SYNC_ALLOWED_ORIGINS` → `ALLOWED_ORIGINS` | sync-core | `localhost:5173` |
| `ROOM_TTL` | sync-core | `12h` |
| `SYNC_TICKET_TTL_SECONDS` | identity-api | `600` |
| `VITE_SYNC_WS_URL` | web | `ws://localhost:8082/ws/sync` |
| `VITE_DEMO_VIDEO_URL` | web | vacío ("Sin video configurado") |

---

## 12. Verificación y resultados

| Suite | Resultado | Cobertura |
| :--- | :--- | :--- |
| sync-core (`go test -race`, `gofmt`, `go vet`) | ✅ todas pasan | **94,9 %** |
| web (Vitest) | ✅ 125 pruebas | **97,98 %** |
| identity-api (Vitest + `tsc`) | ✅ 50 pruebas | **97,85 %** |

Las pruebas de sync-core incluyen miniredis, clientes WebSocket reales, **dos hubs sobre el mismo Redis** (simulan réplicas), 20 comandos concurrentes sin pérdidas y 50 clientes concurrentes con `-race`.

**Prueba extremo a extremo con Redis real:**
- `STATE` inmediato al conectar.
- `PLAY` y `SEEK` del Host llegan al invitado en **2–4 ms**.
- `PAUSE` del invitado → `FORBIDDEN`, estado intacto.
- Invitado atrasado 11 s → `SYNC_CORRECTION` con `strategy=seek` y entrada `sync_drift` en `analytics:events` sin PII.
- Host desconectado → `HOST_STATUS online=false`; la sala sigue `playing` con `PTTL` ≈ 12 h.

**Prueba de carga k6 (500 VUs, misma máquina de 4 núcleos):**

| Umbral | Resultado |
| :--- | :--- |
| Handshakes `101` | ✅ 500/500 |
| `sync_drift_ms` p99 < 500 | ✅ 0 |
| `sync_forbidden_errors` > 99 % | ✅ 499/499 |
| `ws_connecting` p95 < 1 s | ✅ |
| `sync_broadcast_latency_ms` p99 < 100 | ❌ mediana ~18 ms, cola p99 entre 144 y 370 ms según la corrida |

Con 500 clientes escritos en Go contra el mismo servidor y Redis real, el p99 es **25 ms** y estable, y sync-core usa ~4 % de un núcleo durante la carga. Todo apunta a que la cola proviene de k6 programando 500 VUs de JavaScript en la misma máquina que el servidor, pero no está demostrado: **el umbral no se relajó** y la prueba debe repetirse con k6 en otra máquina.

---

## 13. Decisiones de diseño y desviaciones del plan

| Tema | Plan original | Implementado | Motivo |
| :--- | :--- | :--- | :--- |
| Escritura atómica | Script Lua | `WATCH/MULTI/EXEC` optimista con hasta 50 reintentos | `master.Apply` en Go sigue siendo la única fuente de verdad; no se duplica la lógica en Lua. Sigue siendo atómico entre réplicas. |
| Presencia del Host | Redis Set con TTL | ZSET con score = último latido | Permite expirar conexiones de réplicas caídas (timeout 5 s) sin TTL por miembro. |
| Validación de entrada | `Validate()` | `ValidateInbound()` para mensajes de clientes | `Validate()` rechazaba `received_at < occurred_at`, lo que expulsaría a clientes con el reloj adelantado. |
| Paquete `clock` | `Clock` inyectable | Funciones `now` inyectables por componente | Menos indirección para el mismo efecto en pruebas. |
| Lectura de estado en `SYNC_CHECK` | `HGETALL` por latido | Caché por sala alimentada por Pub/Sub | Hallazgo de la prueba de carga: saturaba el pool de go-redis. |
| Código de error `STALE` | Mensaje `ERROR` | Cierre `1008` | Un cliente que no responde latidos no leería el mensaje. |

---

## 14. Limitaciones conocidas

- **Latencia k6**: umbral p99 < 100 ms pendiente de confirmar desde una máquina separada (ver §12).
- **`make test-all`** se detiene en los servicios Python si el entorno no tiene `pytest`; no es un fallo de esta feature.
- **identity-api `npm ci`** requiere `--legacy-peer-deps` por un conflicto previo entre `vitest` y `@vitest/coverage-v8`; el CI podría fallar en ese paso.
- **Cohost en la web**: sync-core acepta `role: cohost`, pero nadie lo emite todavía y el cliente no sabe distinguirlo (vería los controles deshabilitados).
- **Usuario sin token**: en `WatchRoom`, quien no tiene guest token se trata como Host y pide un ticket (falla con 401/403 si no es el dueño).
- **Vídeo de la sala**: temporal en `VITE_DEMO_VIDEO_URL`; el vínculo sala → vídeo pertenece a media/identity.
- **Réplica caída**: no publica `HOST_STATUS offline`; la presencia expira por timeout, pero nadie avisa a los invitados hasta el siguiente evento de presencia.
- **Revocación de tokens**: no hay; un guest token sigue valiendo hasta su `exp`.
