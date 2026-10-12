import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getRedisClient,
  setRedisClient,
  isTokenRevoked,
  revokedKey,
  markTokenRevoked,
  publishRevoked,
} from '../src/modules/tokens/revocation.js';

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

  it('markTokenRevoked hace SET token:revoked:{jti} 1 EXAT <exp>', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    setRedisClient({ set } as any);
    await markTokenRevoked('j1', 1800000000);
    expect(set).toHaveBeenCalledWith('token:revoked:j1', '1', 'EXAT', 1800000000);
  });

  it('publishRevoked publica el payload REVOKED exacto del contrato en room:{id}:sync', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    setRedisClient({ publish } as any);
    const before = Date.now();
    const message = await publishRevoked('room-1', 'j1');
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publish.mock.calls[0];
    expect(channel).toBe('room:room-1:sync');
    expect(raw).toBe(message);
    const evt = JSON.parse(raw);
    expect(Object.keys(evt)).toEqual([
      'event_id', 'type', 'room_id', 'jti', 'position_ms', 'version', 'occurred_at', 'received_at',
    ]);
    expect(evt.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(evt).toMatchObject({ type: 'REVOKED', room_id: 'room-1', jti: 'j1', position_ms: 0, version: 0 });
    expect(new Date(evt.occurred_at).toISOString()).toBe(evt.occurred_at);
    expect(evt.received_at).toBe(evt.occurred_at);
    expect(new Date(evt.occurred_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('getRedisClient crea un cliente ioredis perezoso (sin conectar) y lo reutiliza', () => {
    const client = getRedisClient();
    expect(getRedisClient()).toBe(client);
    expect((client as any).status).toBe('wait');
    (client as any).disconnect();
  });
});
