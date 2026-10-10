import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';
import { requireRoomGuest, requireRoomHostOrGuest } from '../src/middlewares/guestAuth.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { issueGuestToken } from '../src/modules/auth/auth.service.js';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

async function run(token: string | undefined, roomId = 'room-1') {
  const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {}, params: { id: roomId } };
  const res = mockRes();
  const next = vi.fn();
  await requireRoomGuest(req, res, next);
  return { req, res, next };
}

function setRevokedKeys(...jtis: string[]) {
  setRedisClient({
    exists: vi.fn(async (k: string) => (jtis.some((j) => k === `token:revoked:${j}`) ? 1 : 0)),
  } as any);
}

function sign(claims: Record<string, unknown>, opts: { secret?: string; issuer?: string } = {}) {
  return jwt.sign(claims, opts.secret ?? env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: opts.issuer ?? env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: 60,
  });
}

afterEach(() => setRedisClient(null));

describe('requireRoomGuest', () => {
  it('acepta un guest token válido de la sala y expone req.guest', async () => {
    setRevokedKeys();
    const { token, payload } = issueGuestToken('room-1', 'Ana');
    const { req, next } = await run(token);
    expect(next).toHaveBeenCalled();
    expect(req.guest.jti).toBe(payload.jti);
  });

  it('401 sin Authorization', async () => {
    const { res, next } = await run(undefined);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con firma o emisor inválidos', async () => {
    setRevokedKeys();
    const claims = { room_id: 'room-1', role: 'participant', jti: 'x', sub: 's' };
    expect((await run(sign(claims, { secret: 'otro-secreto' }))).res.status).toHaveBeenCalledWith(401);
    expect((await run(sign(claims, { issuer: 'otro' }))).res.status).toHaveBeenCalledWith(401);
  });

  it('401 si el token no es de participante o le falta jti', async () => {
    setRevokedKeys();
    expect((await run(sign({ room_id: 'room-1', role: 'host', jti: 'x', sub: 's' }))).res.status).toHaveBeenCalledWith(401);
    expect((await run(sign({ room_id: 'room-1', role: 'participant', sub: 's' }))).res.status).toHaveBeenCalledWith(401);
  });

  it('403 si el token es de otra sala', async () => {
    setRevokedKeys();
    const { token } = issueGuestToken('room-2', 'Ana');
    const { res } = await run(token, 'room-1');
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('401 si el jti está revocado en Redis', async () => {
    const { token, payload } = issueGuestToken('room-1', 'Ana');
    setRevokedKeys(payload.jti);
    const { res, next } = await run(token);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token revoked' });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireRoomHostOrGuest sin token delega en requireAuthHost → 401', async () => {
    const req: any = { headers: {}, params: { id: 'room-1' } };
    const res = mockRes();
    const next = vi.fn();
    await requireRoomHostOrGuest(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('503 si no se puede comprobar la revocación (falla cerrado)', async () => {
    setRedisClient({ exists: vi.fn().mockRejectedValue(new Error('down')) } as any);
    const { token } = issueGuestToken('room-1', 'Ana');
    const { res, next } = await run(token);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
