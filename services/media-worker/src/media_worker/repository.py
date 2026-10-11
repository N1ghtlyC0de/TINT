"""Transiciones de estado de la tabla `videos` (el worker no crea filas ni esquema)."""

from __future__ import annotations

from media_worker.probe import VideoStatus

START_PROCESSING_SQL = (
    "UPDATE videos SET status = %s, updated_at = now() WHERE id = %s RETURNING id"
)
MARK_READY_SQL = (
    "UPDATE videos SET status = %s, duration_ms = %s, storage_key = %s, updated_at = now() "
    "WHERE id = %s"
)
MARK_FAILED_SQL = "UPDATE videos SET status = %s, updated_at = now() WHERE id = %s"
GET_VIDEO_SQL = "SELECT status, storage_key FROM videos WHERE id = %s"


class VideoRepository:
    """Envuelve una conexión psycopg en modo autocommit: cada UPDATE es idempotente."""

    def __init__(self, conn) -> None:
        self.conn = conn

    def get_video(self, video_id: str) -> tuple[str, str] | None:
        """`(status, storage_key)` del vídeo, o None si la fila no existe."""
        row = self.conn.execute(GET_VIDEO_SQL, (video_id,)).fetchone()
        return None if row is None else (row[0], row[1])

    def start_processing(self, video_id: str) -> bool:
        """Pasa el vídeo a `processing`; False si no existe la fila."""
        row = self.conn.execute(
            START_PROCESSING_SQL, (VideoStatus.PROCESSING.value, video_id)
        ).fetchone()
        return row is not None

    def mark_ready(self, video_id: str, duration_ms: int, storage_key: str) -> None:
        self.conn.execute(
            MARK_READY_SQL, (VideoStatus.READY.value, duration_ms, storage_key, video_id)
        )

    def mark_failed(self, video_id: str) -> None:
        self.conn.execute(MARK_FAILED_SQL, (VideoStatus.FAILED.value, video_id))
