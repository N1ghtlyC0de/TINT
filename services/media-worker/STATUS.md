# STATUS — media-worker

Última revisión: 2026-10-08 · Rama: `feat/media-worker-probe`
Tests: 38 passed · Cobertura: 100 % (mín. ≥ 85 %) · ruff: limpio

IDs oficiales según el documento "Dominio del worker" (no existe MED-BE-04).
Flujo de estado oficial: `processing -> ready | failed`.

## Tareas con ID oficial

| ID | Tarea | Estado | Evidencia |
| :-- | :-- | :-- | :-- |
| MED-BE-01 | Dockerfile y entorno (ffmpeg/ffprobe, conexiones a MinIO y Redis/SQL) | Parcial | Existe `Dockerfile`; sin dependencias ni conexiones (`requirements.txt` vacío) — no revisado en esta fase |
| MED-BE-02 | Listener/consumidor de eventos de subida | Pendiente | `__main__.main` solo inspecciona una ruta dada; sin consumo de cola/evento |
| MED-BE-03 | VideoInspector con ffprobe, metadatos y paso a `failed` | Parcial | `probe.probe_duration_ms`, `inspect_status` (captura `ProbeError` y `OSError`, registra el motivo con `logging`); no persiste el estado en SQL |
| MED-BE-05 | Persistir `ambilight.json` en el blob y transición a `ready` | Pendiente | Sin extracción de fotogramas, cliente S3 ni cliente SQL |
| MED-TEST-01 | Pruebas de estrés de procesamiento | Pendiente | Sin pipeline que estresar |
| MED-TEST-02 | Auditoría de cobertura ≥ 85 % | Hecha | 100 % (79 stmts, 18 branches); `fail_under = 85` |

## Sin ID oficial

| Tarea | Estado | Evidencia |
| :-- | :-- | :-- |
| Parseo de duración de ffprobe a ms (rechaza `nan`/`inf`/negativos) | Hecha | `probe.parse_duration_ms`; `test_parse_duration_ms_*` |
| Estados `VideoStatus` = `processing`, `ready`, `failed` | Hecha | `test_video_status_flow_is_processing_ready_failed` |
| Geometría de franjas 10 % por borde | Hecha | `ambilight.edge_regions` |
| Color promedio hex por franja | Hecha | `ambilight.average_color` |
| Marcas de tiempo a 1 FPS (valida `0 < fps <= 1000`) | Hecha | `ambilight.sample_timestamps_ms`; `test_sample_timestamps_*` |
| Punto de entrada: reporta `ready (N ms)` / `failed` con runner inyectado | Hecha | `tests/test_main.py` |
| Extraer fotogramas con FFmpeg y generar `ambilight.json` | Pendiente | Solo helpers puros |
| Idempotencia al reprocesar | Pendiente | Sin pipeline |
| Timeout en ffprobe | Pendiente | `probe_duration_ms` no pasa `timeout` a `runner`, y `subprocess.TimeoutExpired` no se captura (no es `OSError`). Anotado, sin implementar |
| Lint/format | Hecha | `ruff check` y `ruff format --check` OK |

## Decisiones tomadas

- Estado inicial `processing` (sin `pending`).
- Cobertura mínima ≥ 85 % en todos los documentos.
- Motivo del fallo: solo `logging`, no se guarda en SQL ni se toca el esquema `videos`.
- Numeración oficial de IDs (arriba).

## Decisiones abiertas

1. **Disparador:** Redis, polling de SQL o evento de MinIO.
2. **Lectura de píxeles:** FFmpeg con RGB crudo por pipe vs Pillow/numpy (afecta dependencias y Dockerfile).
3. **Idempotencia:** sobrescribir `{video_id}/ambilight.json` vs comprobar antes; reintentos desde `failed`.
4. **Esquema `videos`:** compartido con otros dominios (regla "un cambio, un dominio").
