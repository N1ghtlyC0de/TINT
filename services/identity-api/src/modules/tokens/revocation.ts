import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env.js';

/** Subconjunto de ioredis que usa identity-api (permite inyectar un fake en pruebas). */
export type RedisLike = Pick<Redis, 'exists' | 'set' | 'publish' | 'xadd'>;

let client: RedisLike | null = null;

export function getRedisClient(): RedisLike {
  if (!client) {
    // lazyConnect: no abre la conexión hasta el primer comando.
    client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }
  return client;
}

/** Inyección para pruebas (null restaura el cliente por defecto). */
export function setRedisClient(next: RedisLike | null) {
  client = next;
}

/** Clave compartida con sync-core (contrato v2 §5). */
export function revokedKey(jti: string) {
  return `token:revoked:${jti}`;
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  return (await getRedisClient().exists(revokedKey(jti))) > 0;
}

/** `SET token:revoked:{jti} 1 EXAT <exp>`: la marca vive exactamente lo que viviría el token. */
export async function markTokenRevoked(jti: string, expSeconds: number) {
  await getRedisClient().set(revokedKey(jti), '1', 'EXAT', expSeconds);
}

/**
 * Publica en `room:{roomId}:sync` el evento REVOKED del contrato v2 §5 para que
 * sync-core cierre (código 4001) las conexiones con ese jti. Devuelve el JSON publicado.
 */
export async function publishRevoked(roomId: string, jti: string) {
  const now = new Date().toISOString();
  const message = JSON.stringify({
    event_id: uuidv4(),
    type: 'REVOKED',
    room_id: roomId,
    jti,
    position_ms: 0,
    version: 0,
    occurred_at: now,
    received_at: now,
  });
  await getRedisClient().publish(`room:${roomId}:sync`, message);
  return message;
}
