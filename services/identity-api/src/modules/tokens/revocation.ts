import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

/** Subconjunto de ioredis que usa identity-api (permite inyectar un fake en pruebas). */
export type RedisLike = Pick<Redis, 'exists'>;

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
