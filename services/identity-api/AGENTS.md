# 🤖 AGENT Guidelines — Domain: Identity (`services/identity-api`)

## Contexto & Responsabilidad
Eres el agente encargado de la **identidad** de TINT. Te ocupas de los usuarios registrados (Host), las salas, las invitaciones, las sesiones de invitado y la emisión de los tokens HS256 que sync-core verifica. También asignas el vídeo de cada sala y firmas su URL de reproducción.

Documentación de referencia: [Usuarios, identidad y permisos](../../docs/usuarios-e-identidad.md) · [Arquitectura](../../docs/arquitectura.md).

## Stack Técnico
- Node.js 22 + TypeScript 5 (ESM) + Express 5. Validación con `zod`.
- PostgreSQL con Drizzle ORM (`drizzle-kit` para migraciones).
- Auth del Host: ID tokens de Firebase (RS256) verificados con `jwks-rsa` + `jsonwebtoken`.
- Tokens propios: `jsonwebtoken` HS256 con `JWT_SECRET`.
- Redis (`ioredis`): revocación de tokens y aviso a sync-core.
- MinIO/S3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`): URLs GET pre-firmadas, calculadas en local.
- Vitest + supertest + cobertura `v8`.

## Responsabilidades
- Crear o recuperar el usuario en su primer inicio de sesión (*upsert* por `provider_sub`).
- Salas (`rooms`) e invitaciones (`invitations`, código `nanoid(12)`).
- **Guest token** (`role: participant`, 4 h) al reclamar una invitación, registrado en `guest_sessions`.
- **Sync-ticket** (`role: host`, 10 min) para el Canal Sync.
- Vídeo de la sala (`media_id`, `media_key`) y URL firmada de reproducción.
- Listar y retirar invitados: BD + `token:revoked:{jti}` + `PUBLISH REVOKED`.

## Límites de Dominio
- ❌ No gestiones el estado de reproducción: el Reloj Maestro es de sync-core. Aquí solo se asigna el vídeo; el `LOAD` lo envía el cliente por el Canal Sync.
- ❌ No proceses vídeo: transcodificar, `ffprobe` y Ambilight son de `services/media-worker`.
- ❌ No escribas otras claves de Redis de sync-core que no sean `token:revoked:{jti}` y el `PUBLISH` de `REVOKED` (contrato v2 §5).
- ❌ No pongas datos personales en logs ni en eventos de analítica.
- ❌ No cambies los claims de los tokens sin actualizar también `services/sync-core/internal/auth` y [usuarios-e-identidad.md](../../docs/usuarios-e-identidad.md#4-esquemas-de-tokens).

## Modelo de Datos Involucrado
| Tabla / clave | Tipo | Descripción |
| :--- | :--- | :--- |
| `users` | PostgreSQL | `id`, `provider` (`firebase`), `provider_sub`, `email`, `display_name`, `avatar_url`, timestamps |
| `rooms` | PostgreSQL | `id`, `host_id` → `users`, `title` (≤150), `media_id`, `media_key`, timestamps |
| `invitations` | PostgreSQL | `id`, `code` (único, 12), `room_id`, `created_by`, `expires_at`, `revoked` |
| `guest_sessions` | PostgreSQL | `jti` (PK), `room_id`, `sub` (`guest:<uuid>`), `nick` (≤64), `joined_at`, `expires_at`, `revoked` |
| `token:revoked:{jti}` | Redis String | Marca de revocación con `EXAT` = `exp` del token (la lee sync-core) |
| `room:{id}:sync` | Redis Pub/Sub | Solo se publica `REVOKED{jti}` |

ER completo y ciclos de vida en [usuarios-e-identidad.md](../../docs/usuarios-e-identidad.md#3-esquema-de-datos-postgresql).

## API
Prefijo `/api/v1`. Los errores siempre tienen la forma `{ "error": "<texto>" }`; los 400 de zod añaden `details`.

| Método y ruta | Autorización | Descripción |
| :--- | :--- | :--- |
| `GET /healthz` | — | Estado del servicio |
| `POST /auth/verify` | Firebase | Verifica el token y crea o recupera el usuario |
| `POST /rooms` | Firebase | Crea sala + invitación inicial |
| `GET /rooms` | Firebase | Salas del usuario |
| `POST /rooms/:id/invitations` | Firebase + dueño | Nueva invitación (`ttlHours` opcional) |
| `POST /invitations/:code/revoke` | Firebase + dueño | Cierra la invitación (no retira a quienes ya entraron) |
| `POST /invitations/claim` | — | `{ code, nick }` → guest token. Errores: 404, 409 (revocada), 410 (vencida) |
| `POST /rooms/:id/sync-ticket` | Firebase + dueño | Sync-ticket HS256 para `/ws/sync` |
| `PUT /rooms/:id/media` | Firebase + dueño | `{ mediaKey }` → `{ mediaId, mediaKey }` |
| `GET /rooms/:id/playback` | dueño **o** guest token de la sala | `{ mediaId, url, expiresAt }` (o `null`s) |
| `GET /rooms/:id/guests` | Firebase + dueño | Invitados de la sala (sin `sub`) |
| `POST /rooms/:id/guests/:jti/revoke` | Firebase + dueño | Retira al invitado (idempotente) |

Middlewares: `requireAuthHost`, `requireRoomOwner`, `requireRoomGuest`, `requireRoomHostOrGuest` (decide según el `alg` del JWT) y `validate(schema)`.

## Reglas de Dominio
1. **Contratos compartidos:** los claims de los tokens, la clave `token:revoked:{jti}` y el payload `REVOKED` son contratos con sync-core. Cualquier cambio se coordina y se documenta.
2. **Falla cerrado:** si no se puede comprobar una revocación (BD o Redis caídos), responde 503; nunca aceptes el token por defecto.
3. **Secretos:** `JWT_SECRET` debe coincidir con el de sync-core. Nunca lo subas al repo; usa `.env` local.
4. **Migraciones:** todo cambio de `src/db/schema.ts` va acompañado de su migración generada con `npx drizzle-kit generate`, commiteada junto con `migrations/meta`.
5. **Dependencias inyectables:** Redis (`setRedisClient`), el firmado (`setMediaSigner`) y los repos se reemplazan por dobles en las pruebas. Las pruebas no dependen de Postgres, Redis ni MinIO reales.
6. **TDD:** prueba primero (supertest para rutas y mocks de repos). Cobertura mínima **85 %** (`vitest.config.ts`).
7. **Privacidad:** `GET /guests` nunca devuelve `sub`; no registres tokens ni emails en los logs.

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `IDENTITY_API_PORT` | `8081` | Puerto HTTP |
| `DATABASE_URL` | `postgres://tint:tint@localhost:5432/tint` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Revocación |
| `FIREBASE_PROJECT_ID` | — (**obligatoria**) | `iss`/`aud` de los ID tokens |
| `JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` | `dev-secret-change-in-prod` / `tint-identity` / `tint:room` | Iguales que en sync-core |
| `GUEST_TOKEN_TTL_HOURS` | `4` | Vida del guest token |
| `INVITATION_DEFAULT_TTL_HOURS` | `24` | Vida de una invitación |
| `SYNC_TICKET_TTL_SECONDS` | `600` | Vida del sync-ticket |
| `MINIO_ENDPOINT` / `MINIO_PUBLIC_ENDPOINT` | `http://localhost:9000` / = endpoint | El público es el host que ve el navegador (va dentro de la firma SigV4) |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` / `MINIO_REGION` | `tintadmin` / `tintadmin123` / `tint-media` / `us-east-1` | Firmado |
| `PLAYBACK_URL_TTL_SECONDS` | `3600` | Vida de la URL firmada |

## Comandos
```bash
npm ci                          # sin --legacy-peer-deps
npm run dev                     # :8081 con recarga
npm run typecheck
npx vitest run --coverage       # umbral 85 %
npx drizzle-kit generate        # nueva migración tras cambiar schema.ts
npx drizzle-kit migrate         # aplica migrations/ en DATABASE_URL
```
