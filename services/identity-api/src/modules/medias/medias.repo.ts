import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { medias } from '../../db/schema.js';

export type Media = typeof medias.$inferSelect;
export type NewMedia = typeof medias.$inferInsert;
export type MediaStatus = 'processing' | 'ready' | 'failed';

export async function create(
  media: Omit<NewMedia, 'id' | 'createdAt' | 'updatedAt' | 'durationMs' | 'status'> &
    Partial<Pick<NewMedia, 'durationMs' | 'status'>>,
): Promise<Media> {
  const result = await db
    .insert(medias)
    .values({
      ...media,
      status: media.status ?? 'processing',
      durationMs: media.durationMs ?? 0,
    })
    .returning();
  return result[0];
}

export async function findById(id: string): Promise<Media | null> {
  const result = await db.select().from(medias).where(eq(medias.id, id));
  return result[0] || null;
}

export async function listByUserId(userId: string): Promise<Media[]> {
  const result = await db.select().from(medias).where(eq(medias.userId, userId));
  return result;
}

export async function updateStatus(
  id: string,
  status: MediaStatus,
  durationMs?: number,
): Promise<Media | null> {
  const values: Partial<NewMedia> = {
    status,
    updatedAt: new Date(),
  };
  if (durationMs !== undefined) {
    values.durationMs = durationMs;
  }
  const result = await db
    .update(medias)
    .set(values)
    .where(eq(medias.id, id))
    .returning();
  return result[0] || null;
}

export function isReady(media: Pick<Media, 'status'> | null | undefined): boolean {
  return !!media && media.status === 'ready';
}

