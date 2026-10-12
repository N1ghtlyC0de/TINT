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

import { create, findById, transitionStatus, listByUploader, updateTitle } from '../src/modules/videos/videos.repo.js';

const video = {
  id: '55555555-5555-4555-8555-555555555555',
  roomId: 'r1',
  uploadedBy: 'h1',
  storageKey: '55555555-5555-4555-8555-555555555555/source.mp4',
  contentType: 'video/mp4',
  sizeBytes: 1024,
  status: 'pending',
};

beforeEach(() => vi.clearAllMocks());

describe('videos.repo', () => {
  it('create inserta la fila pendiente y la devuelve', async () => {
    returningMock.mockResolvedValueOnce([video]);
    await expect(create(video)).resolves.toEqual(video);
    expect(valuesMock).toHaveBeenCalledWith(video);
  });

  it('findById devuelve la fila o null', async () => {
    whereMock.mockResolvedValueOnce([{ ...video, renditions: [360, 720] }]);
    await expect(findById(video.id)).resolves.toEqual({ ...video, renditions: [720, 360] });
    whereMock.mockResolvedValueOnce([]);
    await expect(findById('x')).resolves.toBeNull();
  });

  it('transitionStatus cambia el estado solo desde el esperado y devuelve la fila o null', async () => {
    returningMock.mockResolvedValueOnce([{ ...video, status: 'processing' }]);
    await expect(transitionStatus(video.id, 'pending', 'processing')).resolves.toMatchObject({ status: 'processing' });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', updatedAt: expect.any(Date) }));
    returningMock.mockResolvedValueOnce([]);
    await expect(transitionStatus(video.id, 'pending', 'processing')).resolves.toBeNull();
  });

  it('listByUploader devuelve los vídeos del host (sin failed), recientes primero y con renditions normalizado', async () => {
    orderByMock.mockResolvedValueOnce([{ ...video, renditions: [360, 1080] }]);
    await expect(listByUploader('h1')).resolves.toEqual([{ ...video, renditions: [360] }]);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(orderByMock).toHaveBeenCalledTimes(1);
  });

  it('updateTitle renombra y devuelve la fila o null', async () => {
    returningMock.mockResolvedValueOnce([{ ...video, title: 'Nuevo', renditions: [] }]);
    await expect(updateTitle(video.id, 'Nuevo')).resolves.toMatchObject({ title: 'Nuevo', renditions: [] });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nuevo', updatedAt: expect.any(Date) }));
    returningMock.mockResolvedValueOnce([]);
    await expect(updateTitle('x', 'Nuevo')).resolves.toBeNull();
  });

  it('findById normaliza renditions: solo alturas conocidas (720, 360), enteras y sin duplicados', async () => {
    whereMock.mockResolvedValueOnce([{ ...video, renditions: [720, '360', 360.5, 1080, null, 360, 720, { h: 720 }] }]);
    await expect(findById(video.id)).resolves.toMatchObject({ renditions: [720, 360] });
  });

  it('findById devuelve renditions vacío si la columna no es un array', async () => {
    whereMock.mockResolvedValueOnce([{ ...video, renditions: null }]);
    await expect(findById(video.id)).resolves.toMatchObject({ renditions: [] });
    whereMock.mockResolvedValueOnce([{ ...video, renditions: { 720: true } }]);
    await expect(findById(video.id)).resolves.toMatchObject({ renditions: [] });
  });
});
