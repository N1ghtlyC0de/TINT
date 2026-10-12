import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, orderByMock, returningMock, valuesMock, setMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  orderByMock: vi.fn(),
  returningMock: vi.fn(),
  valuesMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          const result = whereMock(...args);
          return Object.assign(Promise.resolve(result), { orderBy: orderByMock });
        },
      }),
    }),
    insert: () => ({ values: (v: unknown) => (valuesMock(v), { returning: returningMock }) }),
    update: () => ({ set: (v: unknown) => (setMock(v), { where: () => ({ returning: returningMock }) }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import { create, findByJti, listByRoom, setRevoked, listActiveByRoom, setRevokedMany, listByRoomAndSub } from '../src/modules/guests/guestSessions.repo.js';

const session = {
  jti: '22222222-2222-4222-8222-222222222222',
  roomId: 'r1',
  sub: 'guest:x',
  nick: 'Ana',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: new Date('2026-01-01T04:00:00Z'),
  revoked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('guestSessions.repo', () => {
  it('create inserta la sesión y la retorna', async () => {
    returningMock.mockResolvedValueOnce([session]);
    await expect(create(session)).resolves.toEqual(session);
    expect(valuesMock).toHaveBeenCalledWith(session);
  });

  it('findByJti retorna la sesión o null', async () => {
    whereMock.mockReturnValueOnce([session]);
    await expect(findByJti(session.jti)).resolves.toEqual(session);
    whereMock.mockReturnValueOnce([]);
    await expect(findByJti('nope')).resolves.toBeNull();
  });

  it('listByRoom ordena por joinedAt', async () => {
    orderByMock.mockResolvedValueOnce([session]);
    await expect(listByRoom('r1')).resolves.toEqual([session]);
    expect(orderByMock).toHaveBeenCalledTimes(1);
  });

  it('setRevoked marca revoked y retorna la fila o null', async () => {
    returningMock.mockResolvedValueOnce([{ ...session, revoked: true }]);
    await expect(setRevoked(session.jti)).resolves.toMatchObject({ revoked: true });
    expect(setMock).toHaveBeenCalledWith({ revoked: true });
    returningMock.mockResolvedValueOnce([]);
    await expect(setRevoked('nope')).resolves.toBeNull();
  });

  it('listActiveByRoom devuelve las sesiones no revocadas y no vencidas de la sala', async () => {
    whereMock.mockReturnValueOnce([session]);
    await expect(listActiveByRoom('r1')).resolves.toEqual([session]);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('setRevokedMany marca varias sesiones y no consulta la BD con la lista vacía', async () => {
    returningMock.mockResolvedValueOnce([{ ...session, revoked: true }]);
    await expect(setRevokedMany([session.jti])).resolves.toHaveLength(1);
    expect(setMock).toHaveBeenCalledWith({ revoked: true });
    setMock.mockClear();
    await expect(setRevokedMany([])).resolves.toEqual([]);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('listByRoomAndSub devuelve las sesiones de ese invitado en la sala', async () => {
    whereMock.mockReturnValueOnce([session]);
    await expect(listByRoomAndSub('r1', 'guest:x')).resolves.toEqual([session]);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
