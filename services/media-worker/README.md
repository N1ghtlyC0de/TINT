# media-worker

Inspección de vídeos con ffprobe (y, próximamente, extracción Ambilight). Requiere `ffprobe` en el `PATH`.

## Uso

Desde `services/media-worker`:

```bash
export PYTHONPATH=src
python -m media_worker                     # sin argumentos: informa los estados soportados
python -m media_worker clip.mp4            # nombre suelto: busca test-videos/clip.mp4
python -m media_worker /ruta/otro.mp4      # ruta con directorios: se usa tal cual
python -m media_worker clip.mp4 --videos-dir /otra/carpeta
python -m media_worker --help
```

Salida: `<ruta>: ready (<N> ms)` o `<ruta>: failed`.

## Vídeos de prueba

Se guardan en `services/media-worker/test-videos/` (fuera de `src/`, por lo que no entran en la imagen Docker).
Los vídeos reales no se versionan salvo que se decida lo contrario; la carpeta se mantiene con `.gitkeep`.

## Desarrollo

```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
```
