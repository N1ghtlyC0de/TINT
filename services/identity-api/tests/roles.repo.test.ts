import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, returningMock, selectAllMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  selectAllMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: whereMock,
        then: (resolve: any) => resolve(selectAllMock()),
      }),
    }),
    insert: () => ({ values: () => ({ returning: returningMock }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import {
  findByName,
  findById,
  create,
  listAll,
  ensureDefaultRoles,
} from '../src/modules/roles/roles.repo.js';

const roleRow = {
  id: 'r-1',
  name: 'public_host',
  description: 'Host con eventos públicos',
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('roles.repo', () => {
  it('findByName retorna el rol o null si no existe', async () => {
    whereMock.mockResolvedValueOnce([roleRow]);
    await expect(findByName('public_host')).resolves.toEqual(roleRow);

    whereMock.mockResolvedValueOnce([]);
    await expect(findByName('non_existent')).resolves.toBeNull();
  });

  it('findById retorna el rol o null', async () => {
    whereMock.mockResolvedValueOnce([roleRow]);
    await expect(findById('r-1')).resolves.toEqual(roleRow);

    whereMock.mockResolvedValueOnce([]);
    await expect(findById('missing')).resolves.toBeNull();
  });

  it('create inserta y retorna el rol', async () => {
    returningMock.mockResolvedValueOnce([roleRow]);
    await expect(
      create({ name: 'public_host', description: 'Desc' }),
    ).resolves.toEqual(roleRow);
  });

  it('listAll retorna la lista de roles', async () => {
    selectAllMock.mockReturnValueOnce([roleRow]);
    await expect(listAll()).resolves.toEqual([roleRow]);
  });

  it('ensureDefaultRoles crea los roles faltantes si no existen', async () => {
    // listAll() → selectAllMock returns only public_host
    selectAllMock.mockReturnValueOnce([roleRow]);

    // create() is called for private_host and participant (not public_host)
    returningMock
      .mockResolvedValueOnce([{ ...roleRow, id: 'r-2', name: 'private_host' }])
      .mockResolvedValueOnce([{ ...roleRow, id: 'r-3', name: 'participant' }]);

    const roles = await ensureDefaultRoles();
    expect(roles).toHaveLength(3);
    expect(returningMock).toHaveBeenCalledTimes(2);
  });
});
