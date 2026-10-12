# 🤖 AGENT Guidelines — Domain: Media Worker (`services/media-worker`)

## Contexto & Responsabilidad

Eres el agente responsable del procesamiento multimedia asíncrono de **TINT**. Operas en Python y manejas los binarios de FFmpeg/ffprobe para validar vídeos y extraer paletas de color Ambilight.

## Stack Técnico

- Python 3.11
- Redis Streams (`redis==5.2.1`) solo en el disparador; el núcleo no depende de Redis
- FFmpeg / ffprobe (instalados en la imagen Docker)
- MinIO (Blob Storage) y PostgreSQL (estado del vídeo)
- pytest + pytest-cov, ruff

## Responsabilidades

- Inspección de vídeos subidos (`src/media_worker/probe.py`).
- Normalización a MP4 H.264 + AAC (`src/media_worker/normalize.py`).
- Extracción de paleta Ambilight por bordes (`src/media_worker/ambilight.py`).
- Calidades reducidas 720p/360p del vídeo normalizado (`src/media_worker/renditions.py`).
- Preprocesamiento del vídeo recibido (validación, normalización y Ambilight) antes de publicarlo en el bucket.
- Transición de estado del vídeo y publicación de artefactos en el bucket.
- Disparador: consumir `media:uploads` y procesar el original de `incoming/` (`consumer.py`, `jobs.py`, `__main__.py`).

## Límites de Dominio

- ❌ No sirvas vídeo ni gestiones salas o sockets (→ `sync-core` / `social-core`).
- ❌ No calcules KPIs ni analítica (→ `services/analytics`).
- ❌ Nunca ejecutes FFmpeg real en las pruebas unitarias: inyecta/mockea el `runner`.

## Modelo de Datos Involucrado

| Entidad | Almacén | Campos clave |
| :--- | :--- | :--- |
| `videos` | PostgreSQL | `id`, `storage_key` (lo escribe el worker al publicar), `duration_ms`, `status` (`processing` → `ready` \| `failed`), `renditions` (jsonb, alturas publicadas en orden descendente, p. ej. `[720,360]`; `[]` si no hay), `updated_at` |
| `incoming/{video_id}/original.*` | MinIO (`tint-media`) | Original subido por el navegador (staging; lo lee el worker, caduca a los 2 días) |
| `{video_id}/source.mp4` | MinIO (`tint-media`) | Vídeo normalizado (MP4 H.264 + AAC) (nunca el original sin preprocesar) |
| `media:uploads` | Redis Stream (grupo `media-workers`) | Evento `{video_id}` que publica identity-api al confirmar la subida |
| `{video_id}/ambilight.json` | MinIO (`tint-media`) | `[{ "t_ms", "top", "bottom", "left", "right" }]` colores hex a 1 FPS |
| `{video_id}/{720,360}p.mp4` | MinIO (`tint-media`) | Calidades reducidas (MP4 H.264 + AAC, `scale=-2:H`), solo las de altura estrictamente menor que la del original |

## Reglas de Dominio

1. **Inspección de Archivos:** Usa `ffprobe` para obtener la duración exacta en ms. Si el archivo está corrupto, actualiza el estado en SQL a `failed`.
2. **Extracción Ambilight:** Analiza una franja del 10% en cada uno de los 4 bordes del fotograma a 1 FPS. Genera el archivo `ambilight.json` y súbelo al Blob Storage.
3. **Calidades:** Tras publicar `source.mp4` y `ambilight.json`, genera `720p`/`360p` (solo alturas menores que el original). Son opcionales: una que falle se omite con un aviso y **no** marca `failed`.
4. **Persistencia:** Al finalizar con éxito, marca el vídeo como `ready` y escribe en `renditions` las calidades publicadas.
5. **Idempotencia:** Reprocesar el mismo vídeo debe producir el mismo resultado sin duplicar artefactos.
6. **TDD:** Escribe primero pruebas unitarias con `pytest` mockeando ejecuciones de FFmpeg. Cobertura obligatoria **≥ 85 %**.

## Comandos

```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
```
