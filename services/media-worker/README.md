# media-worker

Preprocesamiento de los vídeos subidos antes de publicarlos en el bucket: validación con ffprobe, extracción de la paleta Ambilight con FFmpeg y, pendiente de implementar, normalización a un formato estándar. Requiere `ffprobe` y `ffmpeg` en el `PATH`.

No tiene CLI ni comando propio: lo invoca la API con `media_worker.pipeline.process_video(video_id, source, repo, blobs)`, donde `source` es la ruta local del archivo recibido.

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

Las pruebas nunca ejecutan FFmpeg, S3 ni PostgreSQL reales: se inyectan dobles (`tests/fakes.py`).
