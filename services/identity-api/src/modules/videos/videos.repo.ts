import { eq } from 'drizzle-orm';
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
