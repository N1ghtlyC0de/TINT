import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

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
  create: vi.fn(async (s: unknown) => s),
  findByJti: vi.fn(),
  listByRoom: vi.fn(),
  listByRoomAndSub: vi.fn(),
  setRevoked: vi.fn(async () => null),
}));

vi.mock('../src/modules/bans/roomBans.repo.js', () => ({
  create: vi.fn(),
  findByRoomAndDevice: vi.fn(async () => null),
  findByRoomAndSub: vi.fn(async () => null),
  listByRoom: vi.fn(),
  removeById: vi.fn(),
}));

import app from '../src/app.js';
import { findById, isOwner } from '../src/modules/rooms/rooms.repo.js';
import { findByCode } from '../src/modules/invitations/invitations.repo.js';
import {
  create as createGuestSession,
  findByJti,
  listByRoomAndSub,
  setRevoked as setGuestSessionRevoked,
} from '../src/modules/guests/guestSessions.repo.js';
import {
  create as createBan,
  findByRoomAndDevice,
  findByRoomAndSub,
  listByRoom as listBans,
  removeById as removeBan,
} from '../src/modules/bans/roomBans.repo.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';

const JTI = '33333333-3333-4333-8333-333333333333';
const JTI2 = '44444444-4444-4444-8444-444444444444';
const DEVICE = '77777777-7777-4777-8777-777777777777';
const BAN_ID = '88888888-8888-4888-8888-888888888888';
const future = new Date(Date.now() + 60 * 60 * 1000);
const session = {
  jti: JTI,
  roomId: 'room-1',
  sub: 'guest:secreto',
  nick: 'Ana',
  joinedAt: new Date('2026-10-10T10:00:00.000Z'),
  expiresAt: future,
  revoked: false,
  deviceId: DEVICE,
};
const ban = {
  id: BAN_ID,
  roomId: 'room-1',
  deviceId: DEVICE,
  sub: 'guest:secreto',
  nick: 'Ana',
  createdAt: new Date('2026-10-10T12:00:00.000Z'),
  createdBy: 'host-1',
};
const invitation = {
  id: 'inv-1',
  code: 'abc123def456',
  roomId: 'room-1',
  createdBy: 'host-1',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  revoked: false,
};

const redis = {
  set: vi.fn(async () => 'OK'),
  publish: vi.fn(async () => 1),
  exists: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1-0'),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findById).mockResolvedValue({ id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null } as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  vi.mocked(findByRoomAndDevice).mockResolvedValue(null as any);
  vi.mocked(findByRoomAndSub).mockResolvedValue(null as any);
  setRedisClient(redis as any);
});

afterEach(() => setRedisClient(null));

const claim = (body: object) => request(app).post('/api/v1/invitations/claim').send(body);

describe('POST /invitations/claim con deviceId', () => {
  it('guarda el deviceId en la guest_session', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    const res = await claim({ code: 'abc123def456', nick: 'Ana', deviceId: DEVICE });
    expect(res.status).toBe(200);
    expect(findByRoomAndDevice).toHaveBeenCalledWith('room-1', DEVICE);
    const decoded = jwt.decode(res.body.token) as any;
    expect(createGuestSession).toHaveBeenCalledWith(expect.objectContaining({ jti: decoded.jti, deviceId: DEVICE }));
  });

  it('403 BANNED si el dispositivo está bloqueado en la sala, sin emitir token', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    vi.mocked(findByRoomAndDevice).mockResolvedValueOnce(ban as any);
    const res = await claim({ code: 'abc123def456', nick: 'Ana', deviceId: DEVICE });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'BANNED' });
    expect(createGuestSession).not.toHaveBeenCalled();
  });

  it('sin deviceId no consulta los bloqueos (clientes viejos) y guarda device_id null', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    const res = await claim({ code: 'abc123def456', nick: 'Ana' });
    expect(res.status).toBe(200);
    expect(findByRoomAndDevice).not.toHaveBeenCalled();
    expect(createGuestSession).toHaveBeenCalledWith(expect.objectContaining({ deviceId: null }));
  });

  it('400 si el deviceId no es un UUID', async () => {
    const res = await claim({ code: 'abc123def456', nick: 'Ana', deviceId: 'no-es-uuid' });
    expect(res.status).toBe(400);
    expect(findByCode).not.toHaveBeenCalled();
  });
});

const postBan = (body: object) => request(app).post('/api/v1/rooms/room-1/bans').send(body);

describe('POST /rooms/:id/bans', () => {
  it('por jti: bloquea el dispositivo, revoca todas las sesiones del invitado y responde el ban', async () => {
    const second = { ...session, jti: JTI2 };
    vi.mocked(findByJti).mockResolvedValueOnce(session as any);
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([session, second] as any);
    vi.mocked(createBan).mockResolvedValueOnce(ban as any);
    const res = await postBan({ jti: JTI });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ban: { id: BAN_ID, nick: 'Ana', createdAt: '2026-10-10T12:00:00.000Z' } });
    expect(listByRoomAndSub).toHaveBeenCalledWith('room-1', 'guest:secreto');
    expect(createBan).toHaveBeenCalledTimes(1);
    expect(createBan).toHaveBeenCalledWith({ roomId: 'room-1', deviceId: DEVICE, sub: 'guest:secreto', nick: 'Ana', createdBy: 'host-1' });
    const exp = Math.floor(future.getTime() / 1000);
    expect(redis.set).toHaveBeenCalledWith(`token:revoked:${JTI}`, '1', 'EXAT', exp);
    expect(redis.set).toHaveBeenCalledWith(`token:revoked:${JTI2}`, '1', 'EXAT', exp);
    expect(redis.publish).toHaveBeenCalledTimes(2);
    const evt = JSON.parse((redis.publish.mock.calls[0] as unknown as [string, string])[1]);
    expect(evt).toMatchObject({ type: 'REVOKED', room_id: 'room-1' });
    expect(setGuestSessionRevoked).toHaveBeenCalledWith(JTI);
    expect(setGuestSessionRevoked).toHaveBeenCalledWith(JTI2);
    expect(JSON.stringify(res.body)).not.toContain('guest:secreto');
    expect(JSON.stringify(res.body)).not.toContain(DEVICE);
  });

  it('por sub (desde el chat): resuelve las sesiones del invitado', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([session] as any);
    vi.mocked(createBan).mockResolvedValueOnce(ban as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(findByJti).not.toHaveBeenCalled();
    expect(listByRoomAndSub).toHaveBeenCalledWith('room-1', 'guest:secreto');
    expect(res.body.ban.id).toBe(BAN_ID);
  });

  it('una fila por dispositivo distinto del invitado; responde el primer ban', async () => {
    const OTHER = '99999999-9999-4999-8999-999999999999';
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([session, { ...session, jti: JTI2, deviceId: OTHER }, { ...session, jti: JTI2 }] as any);
    vi.mocked(createBan).mockResolvedValueOnce(ban as any).mockResolvedValueOnce({ ...ban, id: 'otro', deviceId: OTHER } as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(createBan).toHaveBeenCalledTimes(2);
    expect(createBan).toHaveBeenNthCalledWith(2, expect.objectContaining({ deviceId: OTHER }));
    expect(res.body.ban.id).toBe(BAN_ID);
  });

  it('es idempotente: si el dispositivo ya estaba bloqueado devuelve el ban existente y vuelve a revocar', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([{ ...session, revoked: true }] as any);
    vi.mocked(createBan).mockResolvedValueOnce(null as any);
    vi.mocked(findByRoomAndDevice).mockResolvedValueOnce(ban as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(res.body.ban).toEqual({ id: BAN_ID, nick: 'Ana', createdAt: '2026-10-10T12:00:00.000Z' });
    expect(findByRoomAndDevice).toHaveBeenCalledWith('room-1', DEVICE);
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('sesión sin device_id (cliente viejo): guarda el ban por sub y revoca igual', async () => {
    const legacy = { ...session, deviceId: null };
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([legacy] as any);
    vi.mocked(createBan).mockResolvedValueOnce({ ...ban, deviceId: null } as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(findByRoomAndSub).toHaveBeenCalledWith('room-1', 'guest:secreto');
    expect(createBan).toHaveBeenCalledWith(expect.objectContaining({ deviceId: null, sub: 'guest:secreto' }));
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(setGuestSessionRevoked).toHaveBeenCalledWith(JTI);
  });

  it('sin device_id e idempotente: reutiliza el ban por sub sin insertar otro', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([{ ...session, deviceId: null }] as any);
    vi.mocked(findByRoomAndSub).mockResolvedValueOnce({ ...ban, deviceId: null } as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(createBan).not.toHaveBeenCalled();
    expect(res.body.ban.id).toBe(BAN_ID);
  });

  it('no vuelve a marcar en Redis las sesiones ya vencidas', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([{ ...session, expiresAt: new Date(Date.now() - 1000) }] as any);
    vi.mocked(createBan).mockResolvedValueOnce(ban as any);
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(200);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('falla cerrado: 503 si Redis falla, sin marcar la BD; el ban queda guardado para el reintento', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([session] as any);
    vi.mocked(createBan).mockResolvedValueOnce(ban as any);
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    const res = await postBan({ sub: 'guest:secreto' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Service unavailable' });
    expect(createBan).toHaveBeenCalledTimes(1);
    expect(setGuestSessionRevoked).not.toHaveBeenCalled();
  });

  it('404 si el jti no existe o es de otra sala', async () => {
    vi.mocked(findByJti).mockResolvedValueOnce({ ...session, roomId: 'room-2' } as any);
    expect((await postBan({ jti: JTI })).status).toBe(404);
    vi.mocked(findByJti).mockResolvedValueOnce(null as any);
    expect((await postBan({ jti: JTI })).status).toBe(404);
    expect(createBan).not.toHaveBeenCalled();
  });

  it('404 si el sub no tiene sesiones en la sala (p. ej. el host)', async () => {
    vi.mocked(listByRoomAndSub).mockResolvedValueOnce([]);
    const res = await postBan({ sub: 'host-1' });
    expect(res.status).toBe(404);
    expect(createBan).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ jti: JTI, sub: 'guest:x' }], [{ jti: 'no-es-uuid' }], [{ sub: '' }]])('400 con cuerpo inválido %j', async (body) => {
    const res = await postBan(body);
    expect(res.status).toBe(400);
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await postBan({ jti: JTI });
    expect(res.status).toBe(403);
    expect(findByJti).not.toHaveBeenCalled();
  });

  it('410 si la sala está borrada', async () => {
    vi.mocked(findById).mockResolvedValueOnce({ id: 'room-1', hostId: 'host-1', status: 'deleted' } as any);
    const res = await postBan({ jti: JTI });
    expect(res.status).toBe(410);
  });
});

describe('GET /rooms/:id/bans', () => {
  it('lista los bloqueos sin exponer device_id ni sub', async () => {
    vi.mocked(listBans).mockResolvedValueOnce([ban] as any);
    const res = await request(app).get('/api/v1/rooms/room-1/bans');
    expect(res.status).toBe(200);
    expect(listBans).toHaveBeenCalledWith('room-1');
    expect(res.body).toEqual({ bans: [{ id: BAN_ID, nick: 'Ana', createdAt: '2026-10-10T12:00:00.000Z' }] });
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v1/rooms/room-1/bans');
    expect(res.status).toBe(403);
    expect(listBans).not.toHaveBeenCalled();
  });
});

describe('DELETE /rooms/:id/bans/:banId', () => {
  it('desbloquea', async () => {
    vi.mocked(removeBan).mockResolvedValueOnce(ban as any);
    const res = await request(app).delete(`/api/v1/rooms/room-1/bans/${BAN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(removeBan).toHaveBeenCalledWith('room-1', BAN_ID);
  });

  it('404 si el ban no existe en la sala', async () => {
    vi.mocked(removeBan).mockResolvedValueOnce(null as any);
    const res = await request(app).delete(`/api/v1/rooms/room-1/bans/${BAN_ID}`);
    expect(res.status).toBe(404);
  });

  it('404 si el banId no es un uuid (sin consultar la BD)', async () => {
    const res = await request(app).delete('/api/v1/rooms/room-1/bans/nope');
    expect(res.status).toBe(404);
    expect(removeBan).not.toHaveBeenCalled();
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).delete(`/api/v1/rooms/room-1/bans/${BAN_ID}`);
    expect(res.status).toBe(403);
    expect(removeBan).not.toHaveBeenCalled();
  });
});
