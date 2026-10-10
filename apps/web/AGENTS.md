# 🤖 AGENT Guidelines — Domain: Frontend Experience (`apps/web`)

## Contexto & Responsabilidad
Eres el agente especializado en la capa de presentación de **TINT**. Tu foco es desarrollar la UI web responsiva, accesible e inmersiva (estética Dark/Luxury) usando React, TypeScript y Tailwind CSS.

## Stack Técnico
- React 18 + TypeScript (modo `strict`) + Vite 5
- Tailwind CSS 3 (paleta `tint.*` en `tailwind.config.js`)
- Vitest + Testing Library (`jsdom`) + cobertura `v8`
- ESLint 9 (`typescript-eslint`, `react-hooks`)

## Responsabilidades
- Reproductor, sala, chat, reacciones, trivias y visualización Ambilight/Heatmap.
- Cliente de los dos canales WebSocket: `/ws/sync` (sync-core) y canal social (social-core).
- Detección y corrección de desfase de reproducción del lado del cliente.

## Límites de Dominio
- ❌ No implementes lógica de negocio autoritativa (puntajes, rate limiting real, estado maestro): eso vive en `services/*`. La UI solo refleja y pre-valida.
- ❌ No modifiques archivos fuera de `apps/web/` sin coordinación con el dominio dueño.
- ❌ Nunca envíes texto de chat a telemetría (ver `services/analytics/AGENTS.md`).

## Modelo de Datos Involucrado
| Entidad | Origen | Campos clave |
| :--- | :--- | :--- |
| `SyncEvent` | sync-core (`/ws/sync`) | `event_id`, `type` (`PLAY`/`PAUSE`/`SEEK`/`STATE`/`HEARTBEAT`/`SYNC_CHECK`/`SYNC_CORRECTION`/`HOST_STATUS`/`ACK`/`ERROR`), `room_id`, `position_ms`, `version`, `occurred_at`, `received_at` + ancla (`status`, `rate`, `updated_at_ms`, `server_time_ms`). Contrato completo en [`services/sync-core/AGENTS.md`](../../services/sync-core/AGENTS.md) |
| `SyncTicket` | identity-api (`POST /rooms/:id/sync-ticket`) | `token` (HS256, `role: host`), `expiresAt` |
| `Reaction` | social-core | `user_id`, `emoji`, `position_ms` (bucket de 5 s) |
| `AmbilightFrame` | media-worker (`ambilight.json`) | `t_ms`, `top`, `bottom`, `left`, `right` (hex) |
| `TriviaQuestion` / `Leaderboard` | social-core | `trivia_id`, `options`, `score` |

## Canal Sync (implementado)
| Pieza | Rol |
| :--- | :--- |
| `src/lib/syncProtocol.ts` | Tipos del protocolo, parseo defensivo, `buildCommand`/`buildSyncCheck`, `expectedPosition`, `estimateServerNow`, `backoffDelay` (500 ms → 10 s). |
| `src/lib/drift.ts` | `computeDrift`, `correctionAction`, `applyCorrection` (seek o `playbackRate` 1.05/0.95) y `shouldRestoreRate` (< 100 ms o 5 s). |
| `src/hooks/useSyncSocket.ts` | Conexión y reconexión; el host pide un sync-ticket en cada intento y el invitado usa `tint_guest_token`. Responde `HEARTBEAT` con `SYNC_CHECK` y descarta mensajes con `version` vieja. |
| `src/components/SyncedPlayer.tsx` | `<video>` gobernado por el estado maestro; controles solo para quien puede controlar; aviso "Host desconectado" y botón de autoplay. |

El cálculo del drift es **autoritativo en sync-core**: el cliente solo aplica las `SYNC_CORRECTION` que recibe. Flujos y diagramas en [`docs/dominio-reproduccion.md`](../../docs/dominio-reproduccion.md).

## Reglas de Dominio
1. **Canales Aislados:** Mantén el uso de dos hooks separados: `useSyncSocket` (vídeo/comandos) y `useSocialSocket` (chat, reacciones, ambilight). Nunca mezcles los sockets.
2. **Auto-Alineación:** sync-core detecta el desfase (> 500 ms) y lo reporta a telemetría; el cliente aplica la corrección recibida con `src/lib/drift.ts` y nunca envía telemetría de sync por su cuenta.
3. **Throttling UI:** Garantiza que los botones de reacción no permitan más de 5 clics/segundo por usuario (`src/hooks/useThrottle.ts`).
4. **Accesibilidad:** Controles con `aria-label`, foco visible y contraste AA sobre fondo oscuro.
5. **TDD & Cobertura:** Todo componente, hook o utilidad debe contar con pruebas unitarias en Vitest escritas **antes** de la implementación (Red → Green → Refactor). Cobertura mínima **85%** (statements, branches, functions, lines) — configurada en `vitest.config.ts`.

## Comandos
```bash
npm ci
npm run dev             # servidor de desarrollo
npm run lint            # ESLint
npm run typecheck       # tsc
npm run test:coverage   # Vitest + umbral 85%
```

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `VITE_IDENTITY_API_URL` | `http://localhost:8081/api/v1` | identity-api (salas, invitaciones, sync-tickets). |
| `VITE_SYNC_WS_URL` | `ws://localhost:8082/ws/sync` | Canal Sync de sync-core. |
| `VITE_DEMO_VIDEO_URL` | vacío | Vídeo temporal de la sala hasta que exista el vínculo sala → vídeo. |
