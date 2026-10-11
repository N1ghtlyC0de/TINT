import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, returningMock, valuesMock, onConflictMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  valuesMock: vi.fn(),
  onConflictMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
    insert: () => ({
      values: (v: unknown) => (
        valuesMock(v),
        {
          returning: returningMock,
          onConflictDoUpdate: (cfg: unknown) => (onConflictMock(cfg), { returning: returningMock }),
        }
      ),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: returningMock }) }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import { users } from '../src/db/schema.js';
import {
  findByProviderSub,
  findById,
  create,
  upsertByProvider,
} from '../src/modules/users/users.repo.js';

const row = {
  id: 'u1',
  provider: 'firebase',
  providerSub: 'sub-1',
  email: 'a@b.c',
  displayName: 'AB',
  avatarUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('users.repo', () => {
  it('findByProviderSub retorna la fila o null', async () => {
    whereMock.mockResolvedValueOnce([row]);
    await expect(findByProviderSub('sub-1')).resolves.toEqual(row);
    whereMock.mockResolvedValueOnce([]);
    await expect(findByProviderSub('nope')).resolves.toBeNull();
  });

  it('findById retorna la fila o null', async () => {
    whereMock.mockResolvedValueOnce([row]);
    await expect(findById('u1')).resolves.toEqual(row);
    whereMock.mockResolvedValueOnce([]);
    await expect(findById('missing')).resolves.toBeNull();
  });

  it('create inserta y retorna', async () => {
    returningMock.mockResolvedValueOnce([row]);
    await expect(
      create({ provider: 'firebase', providerSub: 'sub-1' }),
    ).resolves.toEqual(row);
  });

  it('upsertByProvider es atómico: un solo INSERT ... ON CONFLICT (provider, provider_sub)', async () => {
    returningMock.mockResolvedValueOnce([row]);
    const result = await upsertByProvider({ providerSub: 'sub-1', email: 'a@b.c', displayName: 'AB' });
    expect(result).toEqual(row);
    // Sin SELECT previo: dos primeros logins concurrentes no pueden duplicar al usuario.
    expect(whereMock).not.toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalledWith({
      provider: 'firebase',
      providerSub: 'sub-1',
      email: 'a@b.c',
      displayName: 'AB',
      avatarUrl: null,
    });
    const cfg = onConflictMock.mock.calls[0][0];
    expect(cfg.target).toEqual([users.provider, users.providerSub]);
  });

  it('upsertByProvider refresca email, nombre y avatar si el usuario ya existía', async () => {
    returningMock.mockResolvedValueOnce([{ ...row, displayName: 'Nuevo' }]);
    await upsertByProvider({ providerSub: 'sub-1', email: 'n@b.c', displayName: 'Nuevo', avatarUrl: 'http://img' });
    const { set } = onConflictMock.mock.calls[0][0];
    expect(set).toMatchObject({ email: 'n@b.c', displayName: 'Nuevo', avatarUrl: 'http://img' });
    expect(set.updatedAt).toBeInstanceOf(Date);
  });
});
