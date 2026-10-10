import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRedisClient, setRedisClient, isTokenRevoked, revokedKey } from '../src/modules/tokens/revocation.js';

afterEach(() => {
  setRedisClient(null);
});

describe('tokens/revocation', () => {
  it('revokedKey sigue el contrato token:revoked:{jti}', () => {
    expect(revokedKey('abc')).toBe('token:revoked:abc');
  });

  it('isTokenRevoked consulta la clave en Redis', async () => {
    const exists = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    setRedisClient({ exists } as any);
    await expect(isTokenRevoked('j1')).resolves.toBe(true);
    await expect(isTokenRevoked('j2')).resolves.toBe(false);
    expect(exists).toHaveBeenCalledWith('token:revoked:j1');
  });

  it('getRedisClient crea un cliente ioredis perezoso (sin conectar) y lo reutiliza', () => {
    const client = getRedisClient();
    expect(getRedisClient()).toBe(client);
    expect((client as any).status).toBe('wait');
    (client as any).disconnect();
  });
});
