# media-worker

Inspección de vídeos con ffprobe y extracción de la paleta Ambilight con FFmpeg. Requiere `ffprobe` y `ffmpeg` en el `PATH`.

## Uso local (un vídeo)

Desde `services/media-worker`:

```bash
export PYTHONPATH=src
python -m media_worker                     # sin argumentos: informa los estados soportados
python -m media_worker clip.mp4            # nombre suelto: busca videos/clip.mp4
python -m media_worker /ruta/otro.mp4      # ruta con directorios: se usa tal cual
python -m media_worker clip.mp4 --videos-dir /otra/carpeta
python -m media_worker clip.mp4 --ambilight /tmp/ambilight.json   # además genera la paleta
python -m media_worker --help
```

Salida: `<ruta>: ready (<N> ms)` o `<ruta>: failed`; con `--ambilight` se añade `; ambilight: <salida> (<N> muestras)`.

## Consumidor (`--consume`)

Es el comando por defecto de la imagen Docker. Lee eventos del Redis Stream `media:uploads` (grupo `media-workers`) y, por cada uno:

1. `UPDATE videos SET status = 'processing'` y lee `storage_key` (el worker no crea filas: si no existe, ignora el evento).
2. Descarga el original del bucket a un directorio temporal y lo inspecciona con ffprobe.
3. Extrae un fotograma `rgb24` de 160×90 por segundo con FFmpeg (en streaming) y calcula el color de cada franja del 10 %.
4. Sube `{video_id}/ambilight.json` (siempre sobrescribe la misma clave) y marca `ready` con `duration_ms`.

Si el archivo está corrupto, falta en el bucket o FFmpeg falla, el vídeo queda en `failed`. En todos esos casos el evento se confirma con `XACK`. Si falla la infraestructura (SQL, S3, Redis), el evento no se confirma y se reprocesa al reiniciar el worker. `SIGTERM` termina el vídeo en curso y detiene el bucle.

Evento esperado (lo publica quien atiende la subida):

```bash
redis-cli XADD media:uploads '*' video_id <uuid>
```

Variables de entorno:

| Variable | Obligatoria | Por defecto |
| :-- | :-- | :-- |
| `DATABASE_URL` | sí | — (p. ej. `postgresql://tint:tint@localhost:5432/tint`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | sí | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` si existen |
| `REDIS_URL` | no | `redis://localhost:6379/0` |
| `S3_ENDPOINT_URL` | no | `http://localhost:9000` |
| `MINIO_BUCKET` | no | `tint-media` |
| `MEDIA_WORKER_CONSUMER` | no | hostname (debe ser estable entre reinicios para recuperar pendientes) |

Con la infraestructura local levantada (`docker compose up -d` en la raíz):

```bash
set -a && source ../../.env && set +a
export PYTHONPATH=src DATABASE_URL=postgresql://tint:tint@localhost:5432/tint
python -m media_worker --consume
```

## Vídeos de prueba

Se guardan en `services/media-worker/videos/` (fuera de `src/`, por lo que no entran en la imagen Docker).
Los vídeos reales no se versionan salvo que se decida lo contrario; la carpeta se mantiene con `.gitkeep`.

## Desarrollo

```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
pytest -m stress          # solo las pruebas de estrés (MED-TEST-01)
pytest -m "not stress"    # ciclo rápido sin las pruebas de estrés
```

Las pruebas nunca ejecutan FFmpeg, Redis, S3 ni PostgreSQL reales: se inyectan dobles (`tests/fakes.py`).
