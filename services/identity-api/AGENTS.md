# 🤖 AGENT Guidelines — Domain: Identity & Catalog (`services/identity-api`)

## Contexto & Responsabilidad
Eres el agente especializado en la puerta de entrada estática y administrativa de **TINT**. Tu foco es gestionar el ciclo de vida de los usuarios (autenticación delegada y control de roles RBAC), el catálogo de medios procesados para salas independientes y la orquestación de salas privadas con invitaciones acotadas.

## Stack Técnico
- Node.js 22 + TypeScript (modo `strict`)
- Express 5 + Zod
- Drizzle ORM + PostgreSQL (`pg`)
- Vitest + Testing Library / Supertest + cobertura `v8`
- JWT (Firebase JWKS / HS256 para tokens de invitado)
- Redis (`ioredis`) para Streams de analítica (`analytics:events`) y estado de salas

## Responsabilidades
- Validación de JWT del proveedor externo (Firebase) y aprovisionamiento de perfiles de usuario.
- Control de roles (`public_host`, `private_host`, `participant`).
- Emisión de tokens de sesión acotados a la sala para participantes invitados (`guest tokens`).
- Catálogo multimedia y generación de URLs prefirmadas para MinIO.
- Creación, programación y control de acceso a salas/eventos (validando estado `ready` de medios).
- Publicación asíncrona de eventos de telemetría de login a Redis Streams (`analytics:events`).

## Límites de Dominio
- ❌ No gestiones contraseñas locales ni flujos directos de reset de password (la autenticación es delegada a Firebase).
- ❌ No proceses tráfico en tiempo real de reproducción (→ `services/sync-core`).
- ❌ No proceses sockets de chat, reacciones o presencia social (→ `services/social-core`).
- ❌ No ejecutes transcodificación ni extracción de metadatos pesados de video directamente (→ `services/media-worker`).

## Modelo de Datos Involucrado
| Entidad | Origen | Campos clave |
| :--- | :--- | :--- |
| `roles` | PostgreSQL | `id`, `name` (`public_host`, `private_host`, `participant`), `description` |
| `users` | PostgreSQL | `id`, `role_id`, `provider`, `provider_sub`, `email`, `display_name`, `avatar_url` |
| `medias` | PostgreSQL | `id`, `user_id`, `blob_url`, `duration_ms`, `status` (`processing`, `ready`, `failed`) |
| `rooms` | PostgreSQL / Redis | `id`, `host_id`, `media_id`, `title`, `status`, `scheduled_at`, `grace_period_until` |
| `invitations` | PostgreSQL | `id`, `code`, `room_id`, `created_by`, `expires_at`, `revoked` |

## Reglas de Dominio
1. **Autenticación Delegada:** Toda autenticación externa debe ser validada contra JWKS del proveedor y registrar/sincronizar el usuario en SQL sin contraseñas locales.
2. **RBAC:** Las rutas administrativas de Host deben verificar permisos mediante el middleware `requireRole`.
3. **Catálogo & Salas:** No se permite crear salas asociadas a un `media_id` que no esté en estado `ready`.
4. **TDD & Cobertura:** Todo módulo, repositorio y endpoint debe contar con pruebas unitarias/integración escritas antes o en conjunto con la solución (Red → Green → Refactor). Cobertura mínima **85%** en líneas, funciones, ramas y sentencias.

## Comandos
```bash
npm ci
npm run dev             # servidor de desarrollo con tsx
npm run build           # compilar con tsup
npm run typecheck       # tsc --noEmit
npm run test:coverage   # Vitest con umbral mínimo de 85%
```

