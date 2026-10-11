import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { videos } from '../../db/schema.js';

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/** Estados de `videos.status` (los avanza media-worker después de `pending`). */
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed';

export async function create(video: NewVideo) {
  const result = await db.insert(videos).values(video).returning();
  return result[0];
}

export async function findById(id: string) {
  const result = await db.select().from(videos).where(eq(videos.id, id));
  return result[0] || null;
}

/**
 * `UPDATE videos SET status = to WHERE id = ? AND status = from RETURNING *`:
 * transición condicional y atómica. Devuelve null si el vídeo ya no estaba en `from`
 * (otra petición ganó la carrera o el worker ya lo avanzó).
 */
export async function transitionStatus(id: string, from: VideoStatus, to: VideoStatus) {
  const result = await db
    .update(videos)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(videos.id, id), eq(videos.status, from)))
    .returning();
  return result[0] || null;
}
