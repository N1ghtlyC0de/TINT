# STATUS — media-worker

Última revisión: 2026-10-10 · Rama: `feat/media-worker-probe`
Tests: 127 passed · Cobertura: 100 % (387 stmts, 80 branches; mín. ≥ 85 %) · ruff: limpio

IDs oficiales según el documento "Dominio del worker" (no existe MED-BE-04).
Flujo de estado oficial: `processing -> ready | failed`.

## Tareas con ID oficial

| ID | Tarea | Estado | Evidencia |
| :-- | :-- | :-- | :-- |
| MED-BE-01 | Dockerfile y entorno (ffmpeg/ffprobe, conexiones a MinIO y Redis/SQL) | Hecha | `requirements.txt` (boto3, psycopg[binary], redis); `config.Settings.from_env`; `__main__.build_consumer`; `CMD --consume`; imagen construida y verificada (imports + error claro sin variables) |
| MED-BE-02 | Listener/consumidor de eventos de subida | Hecha | `consumer.StreamConsumer` (`XREADGROUP`/`XACK` sobre `media:uploads`, grupo `media-workers`, recuperación de pendientes al arrancar, parada con `SIGTERM`); `tests/test_consumer.py` |
| MED-BE-03 | VideoInspector con ffprobe, metadatos y paso a `failed` | Hecha | `probe.inspect_status` + `repository.VideoRepository.mark_failed`; `pipeline.process_video` marca `failed` si el archivo está corrupto, falta en el bucket o FFmpeg falla |
| MED-BE-05 | Persistir `ambilight.json` en el blob y transición a `ready` | Hecha | `ambilight.extract_ambilight` (FFmpeg `rgb24` 160×90 a 1 FPS en streaming), `storage.S3BlobStore.put_json`, `repository.mark_ready`; el artefacto se sube antes de marcar `ready` |
| MED-TEST-01 | Pruebas de estrés de procesamiento | Hecha | `tests/test_stress.py` (`-m stress`): vídeo de 3 h leído fotograma a fotograma (~6 s, memoria acotada), ráfaga de 600 eventos duplicados → 300 artefactos, ráfaga mixta con fallos aislados |
| MED-TEST-02 | Auditoría de cobertura ≥ 85 % | Hecha | 100 %; `fail_under = 85` |

## Sin ID oficial

| Tarea | Estado | Evidencia |
| :-- | :-- | :-- |
| Parseo de duración de ffprobe a ms (rechaza `nan`/`inf`/negativos) | Hecha | `probe.parse_duration_ms` |
| Estados `VideoStatus` = `processing`, `ready`, `failed` | Hecha | `test_video_status_flow_is_processing_ready_failed` |
| Geometría de franjas 10 % por borde y color promedio hex | Hecha | `ambilight.edge_regions`, `average_color`, `region_color` |
| Marcas de tiempo a 1 FPS (valida `0 < fps <= 1000`) | Hecha | `ambilight.sample_timestamps_ms` |
| Timeout en ffprobe (30 s) y en FFmpeg (3600 s, mata el proceso) | Hecha | `probe.DEFAULT_TIMEOUT_S`, `ambilight.DEFAULT_EXTRACT_TIMEOUT_S` |
| Extraer fotogramas con FFmpeg y generar `ambilight.json` | Hecha | `ambilight.extract_ambilight`; CLI `--ambilight SALIDA` para probar en local |
| Idempotencia al reprocesar | Hecha | `test_reprocessing_overwrites_the_same_artifact`, `test_burst_of_duplicate_events_produces_one_artifact_per_video` |
| Validación de `video_id` del evento (evita claves como `../x` en el bucket) | Hecha | `consumer.parse_video_id` |
| E2E manual con Postgres y Redis reales, S3 (moto) y FFmpeg real | Hecha | ok → `ready` 3000 ms + `ambilight.json` (3 muestras); corrupto y sin original → `failed`; id desconocido ignorado; evento inválido descartado; duplicado sin artefacto extra; `SIGTERM` → salida 0 |
| Lint/format | Hecha | `ruff check` y `ruff format --check` OK |

## Decisiones tomadas

- Estado inicial `processing` (sin `pending`).
- Cobertura mínima ≥ 85 % en todos los documentos.
- Motivo del fallo: solo `logging`, no se guarda en SQL ni se toca el esquema `videos`.
- Numeración oficial de IDs (arriba).
- **Disparador:** Redis Streams (stream `media:uploads`, consumo con `XREADGROUP` y confirmación con `XACK`). Descartados: polling de SQL (desperdicia recursos) y eventos de MinIO (configuración compleja en local). Coherente con `analytics`, que ya usa el mismo patrón.
- **Contrato del evento:** solo `video_id`; el `storage_key` se lee de la fila `videos` (fuente de verdad), así el evento no puede apuntar a otra clave del bucket.
- **Lectura de píxeles:** FFmpeg con RGB crudo por pipe, un fotograma reducido por segundo (`fps=1,scale=160:90`, `rgb24`). Sin Pillow ni numpy: no hacen falta librerías de imagen, y los tests inyectan bytes falsos por el `runner`/`popen`. Se lee en streaming (un fotograma a la vez) para no cargar cientos de MB en vídeos largos.
- **Idempotencia:** siempre se sobrescribe la clave determinista `{video_id}/ambilight.json` (el PUT a S3 es atómico). El `UPDATE` de `status`, `duration_ms` y `updated_at` también es idempotente. Un video en `failed` solo se reprocesa si se vuelve a encolar el evento explícitamente (`failed -> processing`); no hay reintentos automáticos.
- **Errores:** fallos del vídeo (corrupto, sin original, FFmpeg) → `failed` + `XACK`. Fallos de infraestructura (SQL, S3, Redis) → se propagan sin `XACK`; el evento queda pendiente y se reprocesa al reiniciar.
- **Esquema `videos`:** el worker no cambia el esquema, solo hace `UPDATE` de columnas existentes. Cualquier columna nueva se pide en un PR aparte al dominio dueño del esquema.

## Decisiones abiertas

1. **Quién crea la fila en `videos` con estado `processing`:** HU-MED-01 sugiere que la crea el worker, pero `AGENTS.md` dice que solo la transiciona. Propuesta: la crea quien atienda `POST /media` y el worker solo la actualiza. Confirmar con el equipo. **Implementado según la propuesta:** si la fila no existe, el worker registra un aviso y confirma el evento sin procesar (cambiarlo a `INSERT` sería local a `repository.py`/`pipeline.py`).

## Fuera de este dominio / siguientes pasos

- **Productor del evento:** quien atienda la subida debe hacer `XADD media:uploads * video_id <id>` tras guardar `{video_id}/source.*` y la fila.
- **`docker-compose.yml` (raíz):** no incluye el servicio del worker ni `REDIS_URL`/`DATABASE_URL` en `.env.example`; añadirlo es un cambio de infraestructura compartida (PR aparte). Además, `minio/minio:latest` ya no se puede descargar de Docker Hub (relacionado con la rama remota `fix/missing-minio-images`).
- **Consumidores huérfanos:** si un consumidor desaparece con eventos pendientes, otro no los reclama (`XAUTOCLAIM`); mientras tanto, mantener `MEDIA_WORKER_CONSUMER` estable.
