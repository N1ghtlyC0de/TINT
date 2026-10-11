# 🤖 AGENT Guidelines — Domain: Core Social & Gamificación (`services/social-core`)

## Contexto & Responsabilidad
Gestionas la interactividad de la audiencia en **TINT**: reacciones con control de spam, agregación de Heatmaps, emisión de Ambilight en vivo y motor de Trivias con Leaderboards.

## Stack Técnico
- Go 1.22
- WebSockets (canal social, independiente de `/ws/sync`)
- Redis: Sorted Sets (leaderboards), Hashes/contadores (heatmaps), Pub/Sub
- Imagen Docker `distroless/static` (non-root)
- Verificación de Firebase ID tokens solo con la librería estándar (`crypto/rsa`, `crypto/x509`): sin dependencias nuevas.

## Responsabilidades
- Chat en vivo, reacciones y su rate limiting autoritativo (`internal/reactions`).
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
| `room:{id}:social` | Redis Pub/Sub | `chat_message` y `reaction` entre réplicas (dedup por `event_id`) |
| `room:{id}:sync` | Redis Pub/Sub (solo lectura) | Solo se consume `REVOKED` de identity-api |
| `token:revoked:{jti}` | Redis String (solo lectura) | Marca de revocación de identity-api |

## Autenticación de `/ws/social`
El verificador se elige por el `alg` del header del token; nada se acepta sin firma válida y todo falla cerrado.

| Token | Quién | Verificación |
| :--- | :--- | :--- |
| HS256 (guest token o sync-ticket de identity-api) | Invitado | Firma con `JWT_SECRET`, `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`, `exp` obligatorio, `sub` y `jti` no vacíos, `room_id` = sala (si no, 403). Un HS256 inválido **no** cae al camino de host. |
| RS256 (Firebase ID token) | Host | Firma contra el certificado del `kid` ([certificados públicos de Google](https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com), caché según `Cache-Control max-age`, refetch ante `kid` desconocido como mucho 1/min); `iss` = `https://securetoken.google.com/<FIREBASE_PROJECT_ID>`, `aud` = `FIREBASE_PROJECT_ID`, `exp` e `iat` obligatorios, `sub` no vacío. Sin `FIREBASE_PROJECT_ID` o sin certificados → 401. |

**Revocación (contrato con identity-api):** en el handshake se consulta `EXISTS token:revoked:{jti}` (revocado → 401; Redis caído → 503). La suscripción Pub/Sub de cada sala con clientes locales escucha también `room:{id}:sync` y, ante `type: "REVOKED"`, cierra con **4001** los sockets de ese `jti` (borrar una sala revoca todos sus `jti`). Sin `REDIS_URL` (modo memoria) no hay fuente de revocación.

**Conexiones:** ping cada 20 s (10 s para el pong) y plazo de 5 s por escritura; una conexión muerta se corta y emite el aviso de salida. Los orígenes del handshake se limitan con `ALLOWED_ORIGINS`.

## Variables de entorno
| Variable | Por defecto | Uso |
| :--- | :--- | :--- |
| `SOCIAL_CORE_ADDR` | `:8082` | Dirección de escucha |
| `JWT_SECRET` | — (**obligatoria**: sin ella no arranca) | Secreto HS256 compartido con identity-api |
| `JWT_ISSUER` | `tint-identity` | `iss` esperado en tokens HS256 |
| `JWT_AUDIENCE` | `tint:room` | `aud` esperado en tokens HS256 |
| `FIREBASE_PROJECT_ID` | — (vacía = se rechazan los host tokens) | Proyecto Firebase de los host tokens |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | Patrones de origen (host[:puerto]) aceptados en el handshake; en compose sale de `SOCIAL_ALLOWED_ORIGINS` |
| `REDIS_URL` | — (vacía = memoria, una réplica) | Historial, Pub/Sub entre réplicas, revocación y analítica |

## Reglas de Dominio
1. **Bucketing & Rate Limiting:** Limita las reacciones a 5/s por usuario. Agrupa datos en buckets de 5 segundos.
2. **Heatmaps:** Emite el evento de Heatmap en vivo cada 1 s. Consulta el histórico acumulado si existen ≥ 3 sesiones previas.
3. **Trivias:** Calcula el puntaje bonificando la velocidad (hasta 10 000 ms). Persiste los Leaderboards en Sorted Sets de Redis con TTL de 1 hora post-cierre de sala.
4. **TDD:** Pruebas rigurosas (prueba primero) de algoritmos de puntuación y límites de tasa, con relojes inyectados (nunca `time.Sleep` en tests). Cobertura mínima: **85%**.

## Comandos
```bash
go vet ./...
go test -race -coverprofile=coverage.out ./...
../../scripts/check-go-coverage.sh coverage.out 85
```
