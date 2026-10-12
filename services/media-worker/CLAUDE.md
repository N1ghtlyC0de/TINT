@AGENTS.md
@../../AGENTS.md

## Estructura del proyecto (no hace falta re-explorarla)

- Monorepo en `/home/camilo/Work/tint`: `apps/web`, `services/{sync-core,social-core,media-worker,analytics}`, `scripts/`, `.github/workflows/` (CI/CD), `Makefile` (`make test-python`), `docker-compose.yml`.
- Este servicio (`services/media-worker`): `src/media_worker/` (sin CLI; `probe.py`, `normalize.py`, `ambilight.py`, `pipeline.py` (lo invoca la API), `storage.py`, `repository.py`, `config.py`), `tests/` (dobles en `tests/fakes.py`), `README.md` (uso), `STATUS.md`.

## Reglas de ramas (importante)

- Se trabaja SOLO en `feat/media-worker-probe`. Nunca cambies ni commitees en `main`.
- No crees ramas nuevas (ni locales ni remotas) sin autorización explícita del usuario.
- Si el entorno obliga a usar un worktree, créalo desde `feat/media-worker-probe` (no desde `main`) y lleva los commits a esa rama.

## Notas para Claude Code

- Uso y flujo de procesamiento: ver `README.md`.
- Estado actual del trabajo: ver `STATUS.md` (no se importa para no inflar el contexto).
- No edites ni commitees `.coverage`, `.pytest_cache/` ni `.ruff_cache/`.
