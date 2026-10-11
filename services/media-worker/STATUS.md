# STATUS — media-worker

Última revisión: 2026-10-11 · Rama: `feat/media-worker-probe`, al día con `develop` (solo para esta tarea de documentación; el trabajo nuevo sale de `develop`).
Tests: 182 passed · Cobertura: 100 % (mín. ≥ 85 %) · ruff: limpio

Flujo de estado del worker: `processing -> ready | failed` (sin `pending`; ese estado es de `identity-api` antes de confirmar la subida).

## Tareas del documento "Dominio del worker"

| ID | Tarea | Estado |
| :-- | :-- | :-- |
| MED-BE-01 | Dockerfile y entorno (ffmpeg/ffprobe, MinIO, SQL) | Hecha; la imagen arranca `python -m media_worker` |
| MED-BE-02 | Consumidor de eventos de subida | Hecha: `consumer.py` + `jobs.py` + `__main__.py` consumen `media:uploads` y llaman a `process_video` |
| MED-BE-03 | Inspección con ffprobe y paso a `failed` | Hecha |
| MED-BE-05 | `ambilight.json` en el bucket y paso a `ready` | Hecha |
| MED-TEST-01 | Pruebas de estrés | Hecha |
| MED-TEST-02 | Cobertura ≥ 85 % | Hecha |

No existe MED-BE-04.

## Pendiente

| Tarea | Notas |
| :-- | :-- |
| Medir la **re-codificación** de una película de 2 a 3 h | Tiempo y memoria de `normalize.py` (timeout 4 h) con un original que no sea H.264 + AAC (el Ambilight de películas ya normalizadas está medido, ver Pruebas locales); con eso decidir límites de subida, el `preset` de x264 y los timeouts de FFmpeg |
| Revisar el consumidor con tareas largas | Que no reclame un mensaje que sigue en proceso y lo duplique |
| Borrar `videos/` | Los archivos llegan por la subida; comprobar antes que ningún test los use |
| Repetir el E2E manual | Postgres real, MinIO y FFmpeg reales, con `WAIT_WORKER=1 npm run test:integration` |

## Decisiones tomadas

- **Se adopta el flujo de `develop`:** subida directa a MinIO con URL firmada, `identity-api` dueño del esquema `videos`, cola Redis `media:uploads`. No se rediseña en este prototipo.
- **Preprocesar antes de publicar:** el original vive en `incoming/{id}/original.*` y nada se publica en `{id}/source.mp4` hasta pasar validación, normalización y Ambilight. Solo `process_video` publica ahí.
- **Núcleo sin Redis:** `pipeline`, `repository`, `storage` y `Settings` no conocen Redis; su configuración vive en `TriggerSettings`.
- **Formato estándar:** MP4 H.264 (yuv420p) + AAC con `+faststart`, clave fija `{id}/source.mp4`. Entrada admitida: `.mp4`, `.mov`, `.mkv` y `.webm` (`pipeline.SUPPORTED_EXTENSIONS`); cualquier otra lanza `UnsupportedFormatError` antes de tocar SQL o el bucket, y el disparador la marca `failed` sin descargar el archivo. El filtro en la firma del PUT de `identity-api` queda pendiente (otro dominio, otro PR).
- **Normalización:** `normalize.py` omite la re-codificación si ffprobe indica que el original ya es MP4 + H.264 `yuv420p` + AAC (o sin audio); en ese caso se publica tal cual (sin forzar `faststart` ni descartar pistas extra). Ante cualquier duda del chequeo se re-codifica. Primer vídeo y primer audio; el audio es opcional. Escribe en un directorio temporal que se borra siempre; el Ambilight se extrae del normalizado. Un fallo o timeout de FFmpeg marca `failed` y no sube nada.
- **Autenticación:** la verifica `identity-api` (Firebase); el worker no autentica.
- **Esquema `videos`:** el worker solo hace `UPDATE` de `status`, `duration_ms`, `storage_key` y `updated_at`. Si la fila no existe lanza `VideoNotFoundError`. Columnas nuevas se piden en un PR aparte a `identity-api`.
- **Errores:** `video_id` inválido → `InvalidVideoIdError`; vídeo corrupto o FFmpeg fallido → `failed` y no se sube nada; fallo de SQL o S3 → se propaga sin marcar `failed`.
- **Motivo del fallo:** solo `logging`, no se guarda en SQL.
- **Idempotencia:** las claves `{video_id}/source.mp4` y `{video_id}/ambilight.json` se sobrescriben y el `UPDATE` es idempotente. Un vídeo en `failed` solo se reprocesa si se pide de nuevo.
- **Lectura de píxeles:** FFmpeg con RGB crudo por pipe (`fps=1,scale=160:90`, `rgb24`), un fotograma a la vez, sin Pillow ni numpy.

## Rendimiento del Ambilight (medido con FFmpeg real)

| Vídeo (H.264) | Tiempo de extracción | RSS ffmpeg / Python |
| :-- | :-- | :-- |
| 1080p30, 10 min (390 MB) | ~26 s | 122 MB / 21 MB |
| 720p30, 1 h (1,2 GB) | ~39,5 s | 84 MB / 23 MB |

- El coste está en decodificar el vídeo completo (~99 % de la CPU). No hay opciones de FFmpeg que lo mejoren conservando la salida.
- `-skip_frame nokey` sería mucho más rápido (1 h: 37 s → 3,6 s) pero muestrea keyframes y cambia los colores: decisión de producto, no adoptada.

## Pruebas locales con películas reales (2026-10-11)

`process_video` con `ffprobe`/`ffmpeg` reales y repositorio/bucket en memoria (nada se guardó en disco ni en MinIO):

| Archivo | Resultado | Tiempo |
| :-- | :-- | :-- |
| `source.mp4` (2 h, 710 MB, H.264 + AAC) | `ready`, sin re-codificar (solo `ffprobe`); `source.mp4` publicado idéntico en tamaño al original | 153 s |
| `silence.mp4` (~2 h, 1,9 GB, H.264 + AAC) | `ready`, sin re-codificar; 7 112 muestras Ambilight | 305 s |
| `BadApple.webm` (3,6 min, AV1 + Opus) | `ready`, re-codificado a MP4 (`ffprobe` + `ffmpeg`); 219 muestras | 23 s |
| MKV de 30 s (H.264 + AAC) | `is_normalized` = `False`, se normalizaría | — |

- En lo ya normalizado el tiempo es casi todo Ambilight (~23 muestras/s de proceso).
- No se midió la re-codificación completa de una película de 2 h (ver Pendiente).
- Los formatos fuera de la lista admitida se cubren solo con pruebas unitarias.

## Siguiente prototipo

Se coordina con `identity-api` (PRs #11 y #18 abiertos):

- HLS en lugar de un solo archivo; más formatos de entrada (hoy solo mp4, mov, mkv y webm).
- Rechazar formatos no admitidos en `identity-api` al firmar el PUT (`incoming/{id}/original.<ext>`), para no subir archivos que el worker descartará.
- Quitar Redis del flujo de vídeo, con API propia y proceso en segundo plano en el worker.
- Biblioteca de vídeos reutilizable (hoy `videos.room_id` es NOT NULL).
- Acciones del dueño sobre sus vídeos (listar, borrar, reintentar).
- Metadatos (códecs, resolución) definidos con analytics.
- Límites de subida en `identity-api` (hoy `MAX_UPLOAD_BYTES` = 2 GiB) y límite del proxy.
