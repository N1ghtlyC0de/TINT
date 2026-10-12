import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { issueGuestToken, generateSyncTicket, generateHostTicket } from '../src/modules/auth/auth.service.js';
import { env } from '../src/config/env.js';

describe('issueGuestToken', () => {
  it('emite un guest JWT acotado a la sala con TTL de 4h', () => {
    const { token, payload } = issueGuestToken('room-123', '  Invitado1  ');
    expect(typeof token).toBe('string');
    expect(payload.room_id).toBe('room-123');
    expect(payload.role).toBe('participant');
    expect(payload.nick).toBe('Invitado1');
    expect(payload.iss).toBe(env.JWT_ISSUER);
    expect(payload.aud).toBe(env.JWT_AUDIENCE);
    expect(payload.sub.startsWith('guest:')).toBe(true);
    expect(payload.exp - payload.iat).toBe(4 * 60 * 60);
  });

  it('el token es verificable con JWT_SECRET', () => {
    const { token } = issueGuestToken('room-123', 'nick');
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    expect(decoded.room_id).toBe('room-123');
    expect(decoded.role).toBe('participant');
  });

  it('firma explícitamente con HS256', () => {
    const { token } = issueGuestToken('room-1', 'nick');
    expect(jwt.decode(token, { complete: true })!.header.alg).toBe('HS256');
    expect(() => jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })).not.toThrow();
  });
});

describe('generateSyncTicket', () => {
  const verifyOpts = {
    algorithms: ['HS256'] as jwt.Algorithm[],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  };

  it('emite un ticket HS256 de host verificable con secreto, issuer y audience', () => {
    const before = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = generateSyncTicket({ userId: 'user-1', roomId: 'room-9', nick: 'Ana' });
    const decoded = jwt.verify(token, env.JWT_SECRET, verifyOpts) as any;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.room_id).toBe('room-9');
    expect(decoded.role).toBe('host');
    expect(decoded.nick).toBe('Ana');
    expect(typeof decoded.jti).toBe('string');
    expect(env.SYNC_TICKET_TTL_SECONDS).toBe(600);
    expect(decoded.exp - decoded.iat).toBe(600);
    expect(Math.abs(decoded.exp - (before + 600))).toBeLessThanOrEqual(2);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBe(decoded.exp * 1000);
  });

  it('declara alg HS256 en el header', () => {
    const { token } = generateSyncTicket({ userId: 'u', roomId: 'r', nick: 'n' });
    expect(jwt.decode(token, { complete: true })!.header.alg).toBe('HS256');
  });

  it('usa "Host" como nick si viene vacío o nulo', () => {
    const { token } = generateSyncTicket({ userId: 'u', roomId: 'r', nick: '  ' });
    expect((jwt.decode(token) as any).nick).toBe('Host');
    const { token: t2 } = generateSyncTicket({ userId: 'u', roomId: 'r', nick: null });
    expect((jwt.decode(t2) as any).nick).toBe('Host');
  });

  it('genera un jti único por ticket', () => {
    const a = jwt.decode(generateSyncTicket({ userId: 'u', roomId: 'r', nick: 'n' }).token) as any;
    const b = jwt.decode(generateSyncTicket({ userId: 'u', roomId: 'r', nick: 'n' }).token) as any;
    expect(a.jti).not.toBe(b.jti);
  });
});

describe('generateHostTicket', () => {
  it('emite los mismos claims que el sync-ticket (sync y analítica comparten forma y TTL)', () => {
    const { token, expiresAt } = generateHostTicket({ userId: 'user-1', roomId: 'room-9', nick: 'Ana' });
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as any;
    expect(decoded).toMatchObject({ sub: 'user-1', room_id: 'room-9', role: 'host', nick: 'Ana' });
    expect(decoded.exp - decoded.iat).toBe(env.SYNC_TICKET_TTL_SECONDS);
    expect(expiresAt.getTime()).toBe(decoded.exp * 1000);
  });

  it('generateSyncTicket es un alias de generateHostTicket', () => {
    expect(generateSyncTicket).toBe(generateHostTicket);
  });
});
