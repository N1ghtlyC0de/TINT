import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host' };
    next();
  },
}));

vi.mock('../src/modules/rooms/rooms.repo.js', () => ({
  create: vi.fn(),
  listByHost: vi.fn(),
  findById: vi.fn(),
  isOwner: vi.fn(),
  setMedia: vi.fn(),
}));

vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
}));

vi.mock('../src/modules/guests/guestSessions.repo.js', () => ({
  create: vi.fn(),
  findByJti: vi.fn(),
  listByRoom: vi.fn(),
  setRevoked: vi.fn(),
}));

import app from '../src/app.js';
import { findById, isOwner } from '../src/modules/rooms/rooms.repo.js';
import { findByJti, listByRoom, setRevoked } from '../src/modules/guests/guestSessions.repo.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';

const JTI = '33333333-3333-4333-8333-333333333333';
const session = {
  jti: JTI,
  roomId: 'room-1',
  sub: 'guest:secreto',
  nick: 'Ana',
  joinedAt: new Date('2026-10-10T10:00:00.000Z'),
  expiresAt: new Date('2026-10-10T14:00:00.000Z'),
  revoked: false,
};

const redis = {
  set: vi.fn(async () => 'OK'),
  publish: vi.fn(async () => 1),
  exists: vi.fn(async () => 0),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Por defecto la sala existe y está activa (requireActiveRoom).
  vi.mocked(findById).mockResolvedValue({ id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null } as any);
  setRedisClient(redis as any);
});

afterEach(() => setRedisClient(null));

describe('GET /rooms/:id/guests', () => {
  it('el dueño lista los invitados ordenados por joinedAt sin exponer sub', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const later = { ...session, jti: '44444444-4444-4444-8444-444444444444', nick: 'Beto', joinedAt: new Date('2026-10-10T11:00:00.000Z'), revoked: true };
    vi.mocked(listByRoom).mockResolvedValueOnce([session, later] as any);
    const res = await request(app).get('/api/v1/rooms/room-1/guests');
    expect(res.status).toBe(200);
    expect(listByRoom).toHaveBeenCalledWith('room-1');
    expect(res.body).toEqual({
      guests: [
        { jti: JTI, nick: 'Ana', joinedAt: '2026-10-10T10:00:00.000Z', expiresAt: '2026-10-10T14:00:00.000Z', revoked: false },
        { jti: later.jti, nick: 'Beto', joinedAt: '2026-10-10T11:00:00.000Z', expiresAt: '2026-10-10T14:00:00.000Z', revoked: true },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('guest:secreto');
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v1/rooms/room-1/guests');
    expect(res.status).toBe(403);
    expect(listByRoom).not.toHaveBeenCalled();
  });
});

describe('POST /rooms/:id/guests/:jti/revoke', () => {
  it('revoca: marca BD, SET token:revoked:{jti} EXAT exp y PUBLISH REVOKED exacto', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findByJti).mockResolvedValueOnce(session as any);
    vi.mocked(setRevoked).mockResolvedValueOnce({ ...session, revoked: true } as any);
    const res = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(setRevoked).toHaveBeenCalledWith(JTI);
    expect(redis.set).toHaveBeenCalledWith(`token:revoked:${JTI}`, '1', 'EXAT', Math.floor(session.expiresAt.getTime() / 1000));
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0] as unknown as [string, string];
    expect(channel).toBe('room:room-1:sync');
    const evt = JSON.parse(raw);
    expect(Object.keys(evt)).toEqual([
      'event_id', 'type', 'room_id', 'jti', 'position_ms', 'version', 'occurred_at', 'received_at',
    ]);
    expect(evt).toMatchObject({ type: 'REVOKED', room_id: 'room-1', jti: JTI, position_ms: 0, version: 0 });
    expect(evt.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(evt.occurred_at).toISOString()).toBe(evt.occurred_at);
    expect(new Date(evt.received_at).toISOString()).toBe(evt.received_at);
  });

  it('es idempotente: revocar dos veces responde 200 y vuelve a publicar', async () => {
    vi.mocked(isOwner).mockResolvedValue(true);
    vi.mocked(findByJti).mockResolvedValueOnce(session as any).mockResolvedValueOnce({ ...session, revoked: true } as any);
    vi.mocked(setRevoked).mockResolvedValue({ ...session, revoked: true } as any);
    const first = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    const second = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledTimes(2);
  });

  it('404 si el jti pertenece a otra sala', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findByJti).mockResolvedValueOnce({ ...session, roomId: 'room-2' } as any);
    const res = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    expect(res.status).toBe(404);
    expect(setRevoked).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('404 si el jti no existe', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findByJti).mockResolvedValueOnce(null as any);
    const res = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    expect(res.status).toBe(404);
  });

  it('404 si el jti no es un uuid (sin consultar la BD)', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).post('/api/v1/rooms/room-1/guests/no-es-uuid/revoke');
    expect(res.status).toBe(404);
    expect(findByJti).not.toHaveBeenCalled();
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).post(`/api/v1/rooms/room-1/guests/${JTI}/revoke`);
    expect(res.status).toBe(403);
    expect(findByJti).not.toHaveBeenCalled();
  });
});
