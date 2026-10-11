# media-worker

Preprocesamiento de los vídeos subidos antes de publicarlos en el bucket: validación con ffprobe, extracción de la paleta Ambilight con FFmpeg y, pendiente de implementar, normalización a un formato estándar. Requiere `ffprobe` y `ffmpeg` en el `PATH`.

El núcleo se invoca con `media_worker.pipeline.process_video(video_id, source, repo, blobs)`, donde `source` es la ruta local del archivo recibido.

## Disparador (`python -m media_worker`)

El navegador sube el original directo al bucket, a la zona de staging `incoming/{video_id}/original.<ext>` (URL PUT firmada por identity-api), y al confirmar identity-api hace `XADD media:uploads * video_id <id>`. El disparador es quien llama al núcleo:

1. `consumer.StreamConsumer` lee `media:uploads` con el grupo `media-workers` (`XREADGROUP`) y confirma con `XACK` cada evento procesado. Un fallo de SQL o S3 deja el evento pendiente: espera 5 s y lo reintenta hasta que salga bien, sin tumbar el worker.
2. `jobs.handle_upload` descarta ids que no son UUID (antes de tocar SQL), lee `status` y `storage_key` de `videos`, descarga el original a un archivo temporal y llama a `process_video` **sin modificarlo**. No reprocesa un vídeo ya publicado; si el original no está en el bucket, lo marca `failed`.
3. `process_video` publica `{video_id}/source.<ext>` solo si el vídeo es válido. El staging lo borra la regla de ciclo de vida de `minio-init` a los 2 días (no se borra al publicar para no cortar a quien ya lo reproducía).

Corre como servicio en `docker compose` (`tint-media-worker`). Variables propias del disparador (aparte de `Settings`, que no conoce Redis):

| Variable | Por defecto |
| :-- | :-- |
| `REDIS_URL` | `redis://localhost:6379` |
| `MEDIA_WORKER_CONSUMER` | nombre del host (estable por réplica: al reiniciar recupera sus pendientes) |

## Preprocesamiento (`pipeline.process_video`)

El vídeo recibido **nunca se guarda en el bucket sin preprocesar**:

1. Valida `video_id` (solo ids planos: `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`); si no, lanza `InvalidVideoIdError` sin tocar SQL ni el bucket.
2. `UPDATE videos SET status = 'processing'` (el worker no crea filas: si no existe, lanza `VideoNotFoundError`).
3. Inspecciona el archivo local con ffprobe y obtiene la duración en ms.
4. *(Pendiente)* Normaliza el vídeo a un formato estándar para los demás servicios.
5. Extrae un fotograma `rgb24` de 160×90 por segundo con FFmpeg (en streaming) y calcula el color de cada franja del 10 %.
6. Sube el vídeo a `{video_id}/source.<ext>` y `{video_id}/ambilight.json` (siempre las mismas claves) y marca `ready` con `duration_ms` y `storage_key`.

Si el archivo está corrupto, no existe o FFmpeg falla, el vídeo queda en `failed`, no se sube nada y se devuelve `VideoStatus.FAILED`. El archivo local pertenece a la API: el worker no lo borra. Si falla la infraestructura (SQL, minIO), la excepción se propaga sin marcar `failed`, para que quien llama decida si reintenta.

Variables de entorno (`config.Settings.from_env`):

| Variable | Obligatoria | Por defecto |
| :-- | :-- | :-- |
| `DATABASE_URL` | sí | — (p. ej. `postgresql://tint:tint@localhost:5432/tint`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | sí | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` si existen |
| `S3_ENDPOINT_URL` | no | `http://localhost:9000` |
| `MINIO_BUCKET` | no | `tint-media` |

## Desarrollo

```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
pytest -m stress          # solo las pruebas de estrés (MED-TEST-01)
pytest -m "not stress"    # ciclo rápido sin las pruebas de estrés
```

Las pruebas nunca ejecutan FFmpeg, S3, Redis ni PostgreSQL reales: se inyectan dobles (`tests/fakes.py`). El flujo con servicios reales se prueba desde identity-api: `WAIT_WORKER=1 npm run test:integration`.
