@AGENTS.md
@../../AGENTS.md

## Estructura del proyecto (no hace falta re-explorarla)

- Monorepo en `/home/camilo/Work/tint`: `apps/web`, `services/{sync-core,social-core,media-worker,analytics}`, `scripts/`, `.github/workflows/` (CI/CD), `Makefile` (`make test-python`), `docker-compose.yml`.
- Este servicio (`services/media-worker`): `src/media_worker/` (`__main__.py` CLI, `probe.py`, `ambilight.py`), `tests/`, `videos/` (vídeos de prueba, fuera de `src/` para que el `Dockerfile`, que solo copia `src/`, no los incluya), `README.md` (uso), `STATUS.md`.

## Reglas de ramas (importante)

- Se trabaja SOLO en `feat/media-worker-probe`. Nunca cambies ni commitees en `main`.
- No crees ramas nuevas (ni locales ni remotas) sin autorización explícita del usuario.
- Si el entorno obliga a usar un worktree, créalo desde `feat/media-worker-probe` (no desde `main`) y lleva los commits a esa rama.

## Notas para Claude Code

- Uso del CLI: ver `README.md`.
- Estado actual del trabajo: ver `STATUS.md` (no se importa para no inflar el contexto).
- No edites ni commitees `.coverage`, `.pytest_cache/` ni `.ruff_cache/`.
