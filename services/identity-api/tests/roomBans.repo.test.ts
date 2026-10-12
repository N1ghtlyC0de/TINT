import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, orderByMock, returningMock, valuesMock, onConflictMock, deleteWhereMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  orderByMock: vi.fn(),
  returningMock: vi.fn(),
  valuesMock: vi.fn(),
  onConflictMock: vi.fn(),
  deleteWhereMock: vi.fn(),
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
    insert: () => ({
      values: (v: unknown) => (
        valuesMock(v),
        { onConflictDoNothing: () => (onConflictMock(), { returning: returningMock }) }
      ),
    }),
    delete: () => ({ where: (...args: unknown[]) => (deleteWhereMock(...args), { returning: returningMock }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import { create, findByRoomAndDevice, findByRoomAndSub, listByRoom, removeById } from '../src/modules/bans/roomBans.repo.js';

const DEVICE = '77777777-7777-4777-8777-777777777777';
const ban = {
  id: '88888888-8888-4888-8888-888888888888',
  roomId: 'r1',
  deviceId: DEVICE,
  sub: 'guest:x',
  nick: 'Ana',
  createdAt: new Date('2026-10-10T10:00:00Z'),
  createdBy: 'h1',
};

beforeEach(() => vi.clearAllMocks());

describe('roomBans.repo', () => {
  it('create inserta sin chocar con el índice único y devuelve la fila', async () => {
    returningMock.mockResolvedValueOnce([ban]);
    const input = { roomId: 'r1', deviceId: DEVICE, sub: 'guest:x', nick: 'Ana', createdBy: 'h1' };
    await expect(create(input)).resolves.toEqual(ban);
    expect(valuesMock).toHaveBeenCalledWith(input);
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });

  it('create devuelve null si (room, device) ya estaba bloqueado', async () => {
    returningMock.mockResolvedValueOnce([]);
    await expect(create({ roomId: 'r1', deviceId: DEVICE, sub: 's', nick: 'n', createdBy: 'h1' })).resolves.toBeNull();
  });

  it('findByRoomAndDevice devuelve el bloqueo o null', async () => {
    whereMock.mockReturnValueOnce([ban]);
    await expect(findByRoomAndDevice('r1', DEVICE)).resolves.toEqual(ban);
    whereMock.mockReturnValueOnce([]);
    await expect(findByRoomAndDevice('r1', DEVICE)).resolves.toBeNull();
  });

  it('findByRoomAndSub devuelve el bloqueo o null', async () => {
    whereMock.mockReturnValueOnce([ban]);
    await expect(findByRoomAndSub('r1', 'guest:x')).resolves.toEqual(ban);
    whereMock.mockReturnValueOnce([]);
    await expect(findByRoomAndSub('r1', 'guest:y')).resolves.toBeNull();
  });

  it('listByRoom ordena de más reciente a más antiguo', async () => {
    orderByMock.mockResolvedValueOnce([ban]);
    await expect(listByRoom('r1')).resolves.toEqual([ban]);
    expect(orderByMock).toHaveBeenCalledTimes(1);
  });

  it('removeById borra el bloqueo de la sala y devuelve la fila o null', async () => {
    returningMock.mockResolvedValueOnce([ban]);
    await expect(removeById('r1', ban.id)).resolves.toEqual(ban);
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
    returningMock.mockResolvedValueOnce([]);
    await expect(removeById('r1', ban.id)).resolves.toBeNull();
  });
});
