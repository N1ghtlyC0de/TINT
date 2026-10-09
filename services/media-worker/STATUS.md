# STATUS — media-worker

Última revisión: 2026-10-08 · Rama: `feat/media-worker-probe`
Tests: 23 passed · Cobertura: 100 % (mín. 85 %) · ruff: limpio

> Los IDs `MED-BE-*` / `MED-TEST-*` son una numeración provisional derivada de `AGENTS.md`; confirmar contra el backlog.

## Backend (MED-BE)

| ID | Tarea | Estado | Evidencia |
| :-- | :-- | :-- | :-- |
| MED-BE-01 | Parsear duración de ffprobe a ms | Hecha | `probe.parse_duration_ms`; `test_parse_duration_ms_*` |
| MED-BE-02 | Ejecutar ffprobe con `runner` inyectable | Hecha | `probe.probe_duration_ms`, `FFPROBE_CMD`; `test_probe_duration_ms_*` |
| MED-BE-03 | Decidir estado `ready`/`failed` según archivo | Parcial | `probe.inspect_status` devuelve el estado pero no lo persiste en SQL; no captura `OSError` (ffprobe ausente) |
| MED-BE-04 | Geometría de franjas 10 % por borde | Hecha | `ambilight.edge_regions`; `test_edge_regions_*` |
| MED-BE-05 | Color promedio hex por franja | Hecha | `ambilight.average_color`; `test_average_color*` |
| MED-BE-06 | Marcas de tiempo a 1 FPS | Hecha | `ambilight.sample_timestamps_ms`; `test_sample_timestamps_*` |
| MED-BE-07 | Extraer fotogramas con FFmpeg y generar `ambilight.json` | Pendiente | No existe código; solo helpers puros |
| MED-BE-08 | Subir `ambilight.json` a MinIO (`tint-media`) | Pendiente | Sin cliente S3; `requirements.txt` vacío |
| MED-BE-09 | Persistir `status`/`duration_ms`/`updated_at` en PostgreSQL | Pendiente | Sin cliente SQL |
| MED-BE-10 | Idempotencia al reprocesar | Pendiente | Sin pipeline que verificar |
| MED-BE-11 | Consumo de cola / punto de entrada real | Pendiente | `__main__.main` solo imprime estados |

## Pruebas (MED-TEST)

| ID | Tarea | Estado | Evidencia |
| :-- | :-- | :-- | :-- |
| MED-TEST-01 | Tests de probe con runner mockeado | Hecha | `tests/test_probe.py` |
| MED-TEST-02 | Tests de ambilight | Hecha | `tests/test_ambilight.py` |
| MED-TEST-03 | Test del punto de entrada | Parcial | `tests/test_main.py` solo busca "failed"; nombre `reports_ready` engañoso |
| MED-TEST-04 | Cobertura ≥ 85 % | Hecha | 100 % (62 stmts, 12 branches) |
| MED-TEST-05 | Lint/format limpios | Hecha | `ruff check` y `ruff format --check` OK |
| MED-TEST-06 | Tests de pipeline, persistencia e idempotencia | Pendiente | Dependen de MED-BE-07..10 |
| MED-TEST-07 | Casos borde de probe (NaN/inf, `OSError`, timeout) | Pendiente | Sin tests |

## Inconsistencias código ↔ AGENTS.md

1. **Estado inicial:** `VideoStatus` = `PENDING|READY|FAILED`, sin `PROCESSING`; `AGENTS.md` (modificado, sin commitear) dice `processing → ready | failed`, `HEAD` decía `pending`.
2. **Reglas 1 y 3:** no hay escritura en SQL; `inspect_status` solo devuelve el estado.
3. **Regla 2:** no hay extracción de fotogramas, `ambilight.json` ni subida al bucket.
4. **Regla 4 (idempotencia):** sin implementar; `requirements.txt` sin dependencias (boto3/psycopg ausentes).
5. **Transición de estado y publicación de artefactos:** responsabilidad listada, sin módulo.
6. **Cobertura:** `AGENTS.md` dice "> 85 %"; `pyproject` (`fail_under = 85`) y raíz dicen mínimo 85 %.
7. **`test_main`:** pasa porque la salida contiene "failed", no porque `main()` reporte "ready".
8. **Robustez de probe:** `inspect_status` descarta el motivo; `OSError` y `nan`/`inf` en `parse_duration_ms` escapan como excepción en vez de terminar en `failed`.
9. **`sample_timestamps_ms`:** con `fps > 1000` el paso es 0 y `range` lanza un `ValueError` poco claro; excluye el último instante parcial.

## Decisiones abiertas

1. **Estado inicial:** `pending` vs `processing`; quién crea la fila y quién pasa a `processing` (posible `pending → processing → ready | failed`).
2. **Numeración de tareas:** origen oficial de los IDs `MED-BE` / `MED-TEST`.
3. **Disparador:** Redis, polling de SQL o evento de MinIO.
4. **Lectura de píxeles:** FFmpeg con RGB crudo por pipe vs Pillow/numpy (afecta dependencias y Dockerfile).
5. **Idempotencia:** sobrescribir `{video_id}/ambilight.json` vs comprobar antes; reintentos desde `failed`.
6. **Motivo del fallo:** guardar el error de `ProbeError` o descartarlo.
7. **Esquema `videos`:** compartido con otros dominios (regla "un cambio, un dominio").
8. **Umbral de cobertura:** unificar "> 85" y "≥ 85".
9. **Cambios sin commitear:** `AGENTS.md` y `CLAUDE.md` están staged; decidir si van en el mismo PR (`docs(media-worker)`).
