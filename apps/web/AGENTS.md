# 🤖 AGENT Guidelines — Domain: Frontend Experience (`apps/web`)

## Contexto & Responsabilidad
Eres el agente especializado en la capa de presentación de **TINT**. Tu foco es desarrollar la UI web responsiva, accesible e inmersiva (estética Dark/Luxury) usando React, TypeScript y Tailwind CSS.

## Stack Técnico
- React 18 + TypeScript (modo `strict`) + Vite 5
- Tailwind CSS 3 (paleta `tint.*` en `tailwind.config.js`)
- Vitest + Testing Library (`jsdom`) + cobertura `v8`
- ESLint 9 (`typescript-eslint`, `react-hooks`)
- `@msgpack/msgpack` — codificación MessagePack opcional del Canal Sync (implementación oficial, sin dependencias, mismo modelo de datos que el JSON del protocolo).
- `framer-motion` 11.11.17 — animaciones declarativas (`AnimatePresence`, `MotionConfig reducedMotion="user"`) del cuestionario `/test-me`; respeta `prefers-reduced-motion` y evita escribir keyframes CSS a mano.

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
| `SyncEvent` | sync-core (`/ws/sync`) | `event_id`, `type` (`PLAY`/`PAUSE`/`SEEK`/`RATE`/`LOAD`/`VOLUME`/`QUALITY`/`STATE`/`HEARTBEAT`/`SYNC_CHECK`/`SYNC_CORRECTION`/`HOST_STATUS`/`CONTROL`/`ACK`/`ERROR`), `room_id`, `position_ms`, `version`, `occurred_at`, `received_at` + ancla (`status`, `rate`, `updated_at_ms`, `server_time_ms`) + v2: `media_id`, `can_control`, `rtt_ms`/`drift_ms` (HEARTBEAT), `volume` (0..1, ausente → 1) y `quality` (`auto`/`source`/`720p`/`360p`, ausente → `auto`) en cada snapshot. Contrato completo en [`services/sync-core/AGENTS.md`](../../services/sync-core/AGENTS.md) |
| `SyncTicket` | identity-api (`POST /rooms/:id/sync-ticket`) | `token` (HS256, `role: host`), `expiresAt` |
| `RoomPlayback` | identity-api (`GET /rooms/:id/playback`, host o guest token) | `mediaId`, `url` (GET prefirmado de MinIO), `expiresAt`, `status` (`pending`/`processing`/`ready`/`failed`/null), `ambilightUrl` (solo `ready`), `qualities` (`[{id: source\|720p\|360p, label, url}]`; ausente → solo el original) |
| `UploadTicket` | identity-api (`POST /rooms/:id/media/uploads`, host) | `videoId`, `uploadUrl` (PUT prefirmado), `storageKey`, `expiresAt`, `headers`; se confirma con `POST …/uploads/:videoId/complete` → `mediaId` |
| `RoomGuest` | identity-api (`GET /rooms/:id/guests`, `POST /rooms/:id/guests/:jti/revoke`) | `jti`, `nick`, `joinedAt`, `expiresAt`, `revoked` |
| `Reaction` | social-core | `user_id`, `emoji`, `position_ms` (bucket de 5 s) |
| `AmbilightFrame` | media-worker (`ambilight.json`) | `t_ms`, `top`, `bottom`, `left`, `right` (hex) |
| `TriviaQuestion` / `Leaderboard` | social-core | `trivia_id`, `options`, `score` |

## Canal Sync (implementado, contrato v2)
| Pieza | Rol |
| :--- | :--- |
| `src/lib/syncProtocol.ts` | Tipos del protocolo v2, `toServerMessage`/`parseServerMessage` defensivos, `buildCommand` (con `rate`/`media_id`/`volume`/`quality`), `normalizeVolume`/`normalizeQuality`, `buildSyncCheck`, `expectedPosition`, `estimateServerNow`, `backoffDelay` (500 ms → 10 s), `CLOSE_REVOKED` (4001), `CLOSE_EXPIRED` (4003), `RATE_OPTIONS`/`stepRate`. |
| `src/lib/syncCodec.ts` | Codificación JSON (default) o MessagePack (`tint.sync.msgpack`, `@msgpack/msgpack`); los frames se decodifican según su tipo real. |
| `src/lib/drift.ts` | `computeDrift`, `correctionAction`, `applyCorrection` (seek o `playbackRate` 1.05/0.95) y `shouldRestoreRate` (< 100 ms o 5 s). |
| `src/lib/syncQuality.ts` | Semáforo: verde RTT < 150 y \|drift\| < 200; amarillo RTT < 400 y \|drift\| ≤ 500; rojo el resto. |
| `src/hooks/useSyncSocket.ts` | Conexión y reconexión (`reconnect: { attempt, nextRetryAt }`); el host pide un sync-ticket en cada intento y el invitado usa `tint_guest_token`. Responde `HEARTBEAT` con `SYNC_CHECK`, descarta mensajes con `version` vieja, expone `canControl` (`STATE.can_control`/`CONTROL`; host → true antes del 1.er STATE), `rttMs`/`driftMs`, `lastBroadcast` (con `own` por `event_id`) y `revoked` (cierre 4001: no reconecta y borra `tint_guest_token`) y `expired` (cierre 4003, token caducado: el invitado no reconecta y borra `tint_guest_token`; el host pide un sync-ticket nuevo una vez —se rearma al recibir `STATE`— y si se repite se rinde). Si el sync-ticket del host responde 403/404/410 deja de reintentar y expone `fatalError` (`NOT_HOST`/`ROOM_GONE`). `sendCommand` admite PLAY/PAUSE/SEEK/RATE/LOAD/VOLUME/QUALITY (pre-valida `volume` ∈ [0, 1] y `quality`). Expone `volume`/`quality` maestros (STATE, broadcasts —filtrados por `version` como RATE— y `SYNC_CORRECTION`, que solo los pisa si los trae). |
| `src/hooks/useRoomPlayback.ts` | `GET /rooms/:id/playback` al montar, cuando cambia el `media_id` del estado sync y ~1 min antes de `expiresAt`. Expone `status`/`ambilightUrl` y, mientras el vídeo está `pending`/`processing`, re-consulta cada 5 s (máx. 120) sin cambiar el `src` (adopta las `qualities` nuevas conservando la URL del original). Expone `qualities`. Si el invitado recibe 401/403 borra `tint_guest_token` y expone `revoked` (pantalla "Tu invitación ya no es válida"). |
| `src/lib/quality.ts` | `normalizeQualities` (servidor sin `qualities` → original), `resolveQuality` (`auto` → 360p con `effectiveType` 2g/3g o `saveData`, 720p con ancho < 640 px, si no el original; la pedida que no exista cae al original) y `QUALITY_LABELS`. |
| `src/lib/upload.ts` | Subida directa al Blob Storage: `requestUpload` → `uploadToBlob` (XHR `PUT` con progreso, cabeceras exactas, sin `Authorization`, `AbortSignal`) → `completeUpload`; `uploadErrorMessage` (413/409/403/404/410). |
| `src/hooks/useSyncToasts.ts` · `src/components/sync/*` | Avisos de comandos ajenos (3 s, máx. 3, `aria-live`), semáforo de sincronía y "Reconectando… intento N · S s". |
| `src/hooks/usePlayerShortcuts.ts` | Atajos para quien controla: Espacio/K, ←/→ y J/L (±10 s), `[`/`]` (velocidad), `?` (ayuda); ignorados en campos de texto. |
| `src/components/player/SeekBar.tsx` | Barra de cine `role="slider"` (teclado y puntero), búfer, tiempo bajo el cursor y marcadores de saltos del host. |
| `src/components/SyncedPlayer.tsx` | `<video>` gobernado por el estado maestro; controles habilitados por `canControl`; barra del host (`HostControlBar`); aviso "Host desconectado" y de control temporal delegado; botón de autoplay; fundido al corregir con seek (sin él con `prefers-reduced-motion`); re-aplica el estado al cambiar el `src`; aplica el `volume` maestro a todos (el participante tiene un silencio local, `aria-pressed`) y cambia el `src` a la calidad maestra resuelta. |
| `src/components/host/*` | Paneles del host: "Cambiar vídeo" (subida desde el navegador con progreso y cancelar → `LOAD{media_id}`; secundaria: clave del bucket con `PUT /rooms/:id/media`) y "Participantes" (listar —se refresca cada 10 s y con "Actualizar"— y retirar invitados con confirmación). `HostControlBar` (solo con `canControl`, dentro de `SyncedPlayer`): volumen + silencio de la sala (`VOLUME`, deslizador con debounce de 150 ms), calidad (`Auto` + `playback.qualities` → `QUALITY`), velocidad (`RATE`, atajos `[`/`]`), puntero láser y "Crear encuesta". |

## Sesión y credenciales
- **Host:** `tint_token` guarda el ID token de Firebase (caduca a la hora). `src/lib/authSession.ts` (`startHostSession`, llamado en `main.tsx`) lo mantiene fresco con `onIdTokenChanged` y registra en `apiFetch` un proveedor que pide `auth.currentUser.getIdToken()`. Ante un 401 con credencial de host, `apiFetch` fuerza un refresco y reintenta una vez; si sigue en 401 borra `tint_token` y lleva a `/login?next=<ruta actual>`.
- **Invitado:** `tint_guest_token` (+ `tint_room_title`/`tint_invite_link` guardados al canjear) solo da acceso a `/watch/:roomId` si su payload (`guestTokenGrantsRoom`, sin verificar firma) tiene `room_id` igual a la sala y `exp` futuro; si no, se muestra la puerta.
- **Host en una invitación:** `InviteLanding` no borra `tint_token` en silencio: avisa de la sesión de host, ofrece "Entrar como host" (busca la sala en `GET /rooms` por el código) y solo canjea —y cierra la sesión de host— tras pulsar "Entrar como invitado". Tras crear una sala, `CreateRoom` ofrece "Entrar a la sala" (`/watch/:id`).

El cálculo del drift es **autoritativo en sync-core**: el cliente solo aplica las `SYNC_CORRECTION` que recibe. Flujos y diagramas en [`docs/dominio-reproduccion.md`](../../docs/dominio-reproduccion.md).

## Cuestionario oculto `/test-me`
Ruta sin `ProtectedRoute` ni enlaces desde la UI (solo por URL) para aprender cómo funciona el monorepo. Se carga con `React.lazy` para que `framer-motion` no entre al bundle principal.

| Pieza | Rol |
| :--- | :--- |
| `src/data/quizQuestions.ts` | Banco de 60 preguntas en 7 categorías; cada una cita sus archivos fuente. Su prueba verifica que las rutas existan en el repo, el conteo por categoría y que la respuesta correcta no se concentre en una posición. |
| `src/lib/quiz.ts` | Lógica pura: baraja (rng inyectable), 100 pts por acierto con multiplicador de racha (x2 desde 3, x3 desde 5), rangos y reducer. |
| `src/lib/quizSounds.ts` | Efectos sintetizados con Web Audio (sin archivos); silencio persistido en `localStorage.tint_quiz_muted`. |
| `src/hooks/useQuiz.ts` · `src/components/quiz/*` · `src/pages/TestMe.tsx` | Estado + sonidos, tarjeta, panel inferior con respuesta y fuentes, marcador y resumen con confeti. |

Si cambia un dato documentado (puertos, contratos, límites), actualiza la pregunta correspondiente. Al agregar preguntas, ajusta `expected` de la categoría y cita solo datos en los que la documentación no se contradiga.

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
| `VITE_SYNC_WS_URL` | `ws://localhost:8083/ws/sync` | Canal Sync de sync-core. |
| `VITE_SOCIAL_WS_URL` | `ws://localhost:8082/ws/social` | Canal social de social-core (chat y reacciones). |
| `VITE_SYNC_ENCODING` | `json` | Codificación del Canal Sync: `json` o `msgpack` (pide el subprotocolo `tint.sync.msgpack`; si sync-core no lo acepta, sigue en JSON). |
| `VITE_DEMO_VIDEO_URL` | vacío | Vídeo de respaldo, solo si la sala no tiene vídeo asignado en identity-api (`mediaId: null`). |
