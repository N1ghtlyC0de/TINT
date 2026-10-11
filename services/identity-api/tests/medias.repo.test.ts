import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, returningMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: whereMock,
      }),
    }),
    insert: () => ({ values: () => ({ returning: returningMock }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: returningMock }) }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import {
  create,
  findById,
  listByUserId,
  updateStatus,
  isReady,
} from '../src/modules/medias/medias.repo.js';

const mediaRow = {
  id: 'm-1',
  userId: 'u-1',
  blobUrl: 'http://minio:9000/tint-media/video.mp4',
  durationMs: 120000,
  status: 'processing' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('medias.repo', () => {
  it('create inserta y retorna el media con estado processing por defecto', async () => {
    returningMock.mockResolvedValueOnce([mediaRow]);
    const res = await create({
      userId: 'u-1',
      blobUrl: 'http://minio:9000/tint-media/video.mp4',
    });
    expect(res).toEqual(mediaRow);
  });

  it('findById retorna el media o null', async () => {
    whereMock.mockResolvedValueOnce([mediaRow]);
    await expect(findById('m-1')).resolves.toEqual(mediaRow);

    whereMock.mockResolvedValueOnce([]);
    await expect(findById('missing')).resolves.toBeNull();
  });

  it('listByUserId retorna los medias del usuario', async () => {
    whereMock.mockResolvedValueOnce([mediaRow]);
    await expect(listByUserId('u-1')).resolves.toEqual([mediaRow]);
  });

  it('updateStatus actualiza el estado y opcionalmente durationMs', async () => {
    const updated = { ...mediaRow, status: 'ready' as const, durationMs: 180000 };
    returningMock.mockResolvedValueOnce([updated]);
    const res = await updateStatus('m-1', 'ready', 180000);
    expect(res).toEqual(updated);
  });

  it('isReady verifica si el media está listo para crear salas', () => {
    expect(isReady({ status: 'ready' } as any)).toBe(true);
    expect(isReady({ status: 'processing' } as any)).toBe(false);
    expect(isReady({ status: 'failed' } as any)).toBe(false);
    expect(isReady(null)).toBe(false);
  });
});

