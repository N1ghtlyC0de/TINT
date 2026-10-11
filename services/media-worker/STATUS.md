# STATUS — media-worker

Última revisión: 2026-10-11 · Rama: `feat/media-worker-probe`
Tests: 98 passed · Cobertura: 100 % (245 stmts, 44 branches; mín. ≥ 85 %) · ruff: limpio

IDs oficiales según el documento "Dominio del worker" (no existe MED-BE-04).
Flujo de estado oficial: `processing -> ready | failed`.

## Tareas con ID oficial

| ID | Tarea | Estado | Evidencia |
| :-- | :-- | :-- | :-- |
| MED-BE-01 | Dockerfile y entorno (ffmpeg/ffprobe, conexiones a MinIO y SQL) | Hecha | `requirements.txt` (boto3, psycopg[binary]); `config.Settings.from_env`. Redis y el CLI (`__main__.py`) retirados el 2026-10-11; la imagen no tiene `CMD` hasta que exista la API |
| MED-BE-02 | Listener/consumidor de eventos de subida | Hecha (2026-10-11, rama `fix/flujo-completo`) | Retirado por la mañana y recuperado como adaptador: `consumer.py` + `jobs.py` + `__main__.py` hacen de "API" que llama a `process_video` sin modificarlo. Ver la decisión del 2026-10-11 (tarde) abajo |
| MED-BE-03 | VideoInspector con ffprobe, metadatos y paso a `failed` | Hecha | `probe.inspect_status` + `repository.VideoRepository.mark_failed`; `pipeline.process_video` marca `failed` si el archivo está corrupto, no existe o FFmpeg falla; en ese caso no se sube nada al bucket |
| MED-BE-05 | Persistir `ambilight.json` en el blob y transición a `ready` | Hecha | `ambilight.extract_ambilight` (FFmpeg `rgb24` 160×90 a 1 FPS en streaming), `storage.S3BlobStore.upload_file`/`put_json`, `repository.mark_ready` (guarda `storage_key`); vídeo y artefacto se suben antes de marcar `ready` |
| MED-TEST-01 | Pruebas de estrés de procesamiento | Hecha | `tests/test_stress.py` (`-m stress`): vídeo de 3 h leído fotograma a fotograma (~6 s) y memoria acotada. Las ráfagas de eventos duplicados se retiraron junto con Redis |
| MED-TEST-02 | Auditoría de cobertura ≥ 85 % | Hecha | 100 %; `fail_under = 85` |

## Sin ID oficial

| Tarea | Estado | Evidencia |
| :-- | :-- | :-- |
| Parseo de duración de ffprobe a ms (rechaza `nan`/`inf`/negativos) | Hecha | `probe.parse_duration_ms` |
| Estados `VideoStatus` = `processing`, `ready`, `failed` | Hecha | `test_video_status_flow_is_processing_ready_failed` |
| Geometría de franjas 10 % por borde y color promedio hex | Hecha | `ambilight.edge_regions`, `average_color`, `region_color` |
| Marcas de tiempo a 1 FPS (valida `0 < fps <= 1000`) | Hecha | `ambilight.sample_timestamps_ms` |
| Timeout en ffprobe (30 s) y en FFmpeg (3600 s, mata el proceso) | Hecha | `probe.DEFAULT_TIMEOUT_S`, `ambilight.DEFAULT_EXTRACT_TIMEOUT_S` |
| Extraer fotogramas con FFmpeg y generar `ambilight.json` | Hecha | `ambilight.extract_ambilight` (el CLI local `--ambilight` se retiró el 2026-10-11) |
| Idempotencia al reprocesar | Hecha | `test_reprocessing_overwrites_the_same_artifacts` |
| Publicar en el bucket solo vídeos preprocesados | Hecha | `pipeline.process_video` recibe el archivo local de la API y lo sube a `{video_id}/source.<ext>` solo tras validarlo y extraer el Ambilight; `test_corrupt_video_is_never_uploaded`, `test_video_is_not_uploaded_when_ambilight_fails` |
| Normalizar el vídeo a un formato estándar para los demás servicios | Pendiente | Parte del preprocesamiento; va entre ffprobe y Ambilight en `pipeline.process_video` (marcado en el código). El Ambilight se extraerá del vídeo normalizado y se subirá ese, no el original |
| Validación de `video_id` (evita claves como `../x` en el bucket) | Hecha | `pipeline.validate_video_id` → `InvalidVideoIdError` antes de tocar SQL o el bucket |
| E2E manual con Postgres real, S3 (moto) y FFmpeg real | Repetir | Se hizo vía Redis (2026-10-10); hay que repetirlo llamando a `process_video` cuando exista la API |
| Lint/format | Hecha | `ruff check` y `ruff format --check` OK |

## Decisiones tomadas

- Estado inicial `processing` (sin `pending`).
- Cobertura mínima ≥ 85 % en todos los documentos.
- Motivo del fallo: solo `logging`, no se guarda en SQL ni se toca el esquema `videos`.
- Numeración oficial de IDs (arriba).
- **Disparador (2026-10-11):** una API llama a `pipeline.process_video(video_id, source, repo, blobs)` con el archivo recibido en local. Sustituye a Redis Streams (`media:uploads`), que se retiró junto con el consumidor, su configuración y sus pruebas.
- **Contrato de entrada:** `video_id` y la ruta local del archivo recibido. El worker decide la clave del bucket (`{video_id}/source.<ext>`, extensión en minúsculas) y la guarda en `videos.storage_key` al marcar `ready`; quien llama no puede elegir otra clave.
- **Preprocesar antes de publicar (2026-10-11):** el vídeo recibido nunca se guarda directamente en el bucket. El preprocesamiento (validación con ffprobe, normalización pendiente y Ambilight) va primero, y solo si termina bien se sube. El archivo local pertenece a la API, que lo borra.
- **Lectura de píxeles:** FFmpeg con RGB crudo por pipe, un fotograma reducido por segundo (`fps=1,scale=160:90`, `rgb24`). Sin Pillow ni numpy: no hacen falta librerías de imagen, y los tests inyectan bytes falsos por el `runner`/`popen`. Se lee en streaming (un fotograma a la vez) para no cargar cientos de MB en vídeos largos.
- **Idempotencia:** siempre se sobrescriben las claves deterministas `{video_id}/source.<ext>` y `{video_id}/ambilight.json` (el PUT a S3 es atómico). El `UPDATE` de `status`, `duration_ms`, `storage_key` y `updated_at` también es idempotente. Mientras no haya normalización, reprocesar con otra extensión deja el `source` anterior en el bucket; al normalizar, la extensión será fija. Un vídeo en `failed` solo se reprocesa si se vuelve a pedir explícitamente (`failed -> processing`); no hay reintentos automáticos.
- **Errores:** `video_id` inválido → `InvalidVideoIdError`; fila inexistente → `VideoNotFoundError` (ninguno toca el estado). Fallos del vídeo (corrupto, inexistente, FFmpeg) → `failed`, no se sube nada y se devuelve `VideoStatus.FAILED`. Fallos de infraestructura (SQL, S3) → se propagan sin marcar `failed`, para que quien llama decida si reintenta.
- **Esquema `videos`:** el worker no cambia el esquema, solo hace `UPDATE` de columnas existentes. Cualquier columna nueva se pide en un PR aparte al dominio dueño del esquema.

- **Disparador recuperado (2026-10-11, tarde):** la subida directa del navegador al bucket es un requisito del producto, así que la "API" que llama a `process_video` es un adaptador dentro del worker: consume `media:uploads`, descarga el original de la zona de staging `incoming/{id}/original.<ext>` y llama a `process_video` tal cual. Se respeta "preprocesar antes de publicar": el original nunca está en `{id}/source.<ext>`; solo `process_video` publica ahí. El núcleo (`pipeline`, `repository`, `storage`, `Settings`) sigue sin conocer Redis: la configuración de Redis vive en `TriggerSettings`. `repository.get_video` añade un `SELECT` de `status` y `storage_key`. Servicio `media-worker` en `docker-compose.yml` y regla de ciclo de vida para `incoming/` en `minio-init`.

## Decisiones abiertas

1. **Quién crea la fila en `videos` con estado `processing`:** HU-MED-01 sugiere que la crea el worker, pero `AGENTS.md` dice que solo la transiciona. Propuesta: la crea quien atienda `POST /media` y el worker solo la actualiza. Confirmar con el equipo. **Implementado según la propuesta:** si la fila no existe, `process_video` lanza `VideoNotFoundError` sin procesar (cambiarlo a `INSERT` sería local a `repository.py`/`pipeline.py`).

## Fuera de este dominio / siguientes pasos

- ~~API~~ y ~~`docker-compose.yml`~~: resueltos con el disparador (arriba). La imagen tiene `CMD ["python", "-m", "media_worker"]`.
