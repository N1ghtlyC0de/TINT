"""Transiciones de estado de la tabla `videos` (solo UPDATE: el worker no crea filas ni esquema)."""

from __future__ import annotations

from media_worker.probe import VideoStatus

START_PROCESSING_SQL = (
    "UPDATE videos SET status = %s, updated_at = now() WHERE id = %s RETURNING storage_key"
)
MARK_READY_SQL = "UPDATE videos SET status = %s, duration_ms = %s, updated_at = now() WHERE id = %s"
MARK_FAILED_SQL = "UPDATE videos SET status = %s, updated_at = now() WHERE id = %s"


class VideoRepository:
    """Envuelve una conexión psycopg en modo autocommit: cada UPDATE es idempotente."""

    def __init__(self, conn) -> None:
        self.conn = conn

    def start_processing(self, video_id: str) -> str | None:
        """Pasa el vídeo a `processing` y devuelve su `storage_key` (None si no existe la fila)."""
        row = self.conn.execute(
            START_PROCESSING_SQL, (VideoStatus.PROCESSING.value, video_id)
        ).fetchone()
        if row is None:
            return None
        return row[0] or ""

    def mark_ready(self, video_id: str, duration_ms: int) -> None:
        self.conn.execute(MARK_READY_SQL, (VideoStatus.READY.value, duration_ms, video_id))

    def mark_failed(self, video_id: str) -> None:
        self.conn.execute(MARK_FAILED_SQL, (VideoStatus.FAILED.value, video_id))
