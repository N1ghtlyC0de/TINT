import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { guestSessions } from '../../db/schema.js';

export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;

export async function create(session: NewGuestSession) {
  const result = await db.insert(guestSessions).values(session).returning();
  return result[0];
}

export async function findByJti(jti: string) {
  const result = await db.select().from(guestSessions).where(eq(guestSessions.jti, jti));
  return result[0] || null;
}

export async function listByRoom(roomId: string) {
  return db.select().from(guestSessions).where(eq(guestSessions.roomId, roomId)).orderBy(asc(guestSessions.joinedAt));
}

export async function setRevoked(jti: string) {
  const result = await db.update(guestSessions).set({ revoked: true }).where(eq(guestSessions.jti, jti)).returning();
  return result[0] || null;
}
