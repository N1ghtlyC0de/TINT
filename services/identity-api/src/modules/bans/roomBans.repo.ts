import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roomBans } from '../../db/schema.js';

export type RoomBan = typeof roomBans.$inferSelect;
export type NewRoomBan = typeof roomBans.$inferInsert;

/**
 * Inserta el bloqueo. `ON CONFLICT DO NOTHING` sobre el índice único
 * (room_id, device_id): devuelve null si ese dispositivo ya estaba bloqueado.
 */
export async function create(ban: NewRoomBan) {
  const result = await db.insert(roomBans).values(ban).onConflictDoNothing().returning();
  return result[0] || null;
}

export async function findByRoomAndDevice(roomId: string, deviceId: string) {
  const result = await db.select().from(roomBans).where(and(eq(roomBans.roomId, roomId), eq(roomBans.deviceId, deviceId)));
  return result[0] || null;
}

export async function findByRoomAndSub(roomId: string, sub: string) {
  const result = await db.select().from(roomBans).where(and(eq(roomBans.roomId, roomId), eq(roomBans.sub, sub)));
  return result[0] || null;
}

/** Bloqueos de la sala, de más reciente a más antiguo. */
export async function listByRoom(roomId: string) {
  return db.select().from(roomBans).where(eq(roomBans.roomId, roomId)).orderBy(desc(roomBans.createdAt));
}

/** Desbloquea: borra la fila solo si pertenece a la sala. */
export async function removeById(roomId: string, banId: string) {
  const result = await db.delete(roomBans).where(and(eq(roomBans.id, banId), eq(roomBans.roomId, roomId))).returning();
  return result[0] || null;
}
