import { and, asc, eq, gt, inArray } from 'drizzle-orm';
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

/** Todas las sesiones de un invitado (`sub`) en la sala, revocadas o no. */
export async function listByRoomAndSub(roomId: string, sub: string) {
  return db.select().from(guestSessions).where(and(eq(guestSessions.roomId, roomId), eq(guestSessions.sub, sub)));
}

export async function setRevoked(jti: string) {
  const result = await db.update(guestSessions).set({ revoked: true }).where(eq(guestSessions.jti, jti)).returning();
  return result[0] || null;
}

/** Sesiones que todavía pueden conectarse: ni revocadas ni vencidas. */
export async function listActiveByRoom(roomId: string) {
  return db
    .select()
    .from(guestSessions)
    .where(and(eq(guestSessions.roomId, roomId), eq(guestSessions.revoked, false), gt(guestSessions.expiresAt, new Date())));
}

export async function setRevokedMany(jtis: string[]) {
  if (jtis.length === 0) return [];
  return db.update(guestSessions).set({ revoked: true }).where(inArray(guestSessions.jti, jtis)).returning();
}
