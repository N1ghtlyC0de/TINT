import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, returningMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
    insert: () => ({ values: () => ({ returning: returningMock }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: returningMock }) }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import { create, findByCode, setRevoked, listByRoom, listLatestActiveByRooms } from '../src/modules/invitations/invitations.repo.js';

const invitation = {
  id: 'i1',
  code: 'abcdefgh1234',
  roomId: 'r1',
  createdBy: 'h1',
  expiresAt: new Date(),
  revoked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invitations.repo', () => {
  it('create genera un código de 12 caracteres', async () => {
    returningMock.mockResolvedValueOnce([invitation]);
    const result = await create({ roomId: 'r1', expiresAt: new Date(), revoked: false });
    expect(result).toEqual(invitation);
  });

  it('findByCode retorna la fila o null', async () => {
    whereMock.mockResolvedValueOnce([invitation]);
    await expect(findByCode('abcdefgh1234')).resolves.toEqual(invitation);
    whereMock.mockResolvedValueOnce([]);
    await expect(findByCode('missing')).resolves.toBeNull();
  });

  it('setRevoked actualiza y retorna', async () => {
    returningMock.mockResolvedValueOnce([{ ...invitation, revoked: true }]);
    const result = await setRevoked('i1', true);
    expect(result?.revoked).toBe(true);
    returningMock.mockResolvedValueOnce([]);
    await expect(setRevoked('missing')).resolves.toBeNull();
  });

  it('listByRoom retorna las invitaciones de la sala', async () => {
    whereMock.mockResolvedValueOnce([invitation]);
    await expect(listByRoom('r1')).resolves.toEqual([invitation]);
  });

  it('listLatestActiveByRooms retorna mapa vacio sin salas', async () => {
    await expect(listLatestActiveByRooms([])).resolves.toEqual(new Map());
    expect(whereMock).not.toHaveBeenCalled();
  });

  it('listLatestActiveByRooms elige la vigente mas reciente e ignora revocadas/expiradas', async () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const rows = [
      { ...invitation, id: 'vieja', roomId: 'r1', code: 'vieja1234567', createdAt: new Date('2026-10-09T12:00:00Z'), expiresAt: new Date('2026-10-11T12:00:00Z'), revoked: false },
      { ...invitation, id: 'nueva', roomId: 'r1', code: 'nueva1234567', createdAt: new Date('2026-10-10T11:00:00Z'), expiresAt: new Date('2026-10-11T12:00:00Z'), revoked: false },
      { ...invitation, id: 'rev', roomId: 'r1', code: 'revocada1234', createdAt: new Date('2026-10-10T11:30:00Z'), expiresAt: new Date('2026-10-11T12:00:00Z'), revoked: true },
      { ...invitation, id: 'exp', roomId: 'r2', code: 'expirada1234', createdAt: new Date('2026-10-10T11:00:00Z'), expiresAt: new Date('2026-10-09T12:00:00Z'), revoked: false },
    ];
    whereMock.mockResolvedValueOnce(rows);
    const result = await listLatestActiveByRooms(['r1', 'r2'], now);
    expect(result.get('r1')).toMatchObject({ id: 'nueva' });
    expect(result.has('r2')).toBe(false);
  });
});
