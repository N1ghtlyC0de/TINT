import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, returningMock, valuesMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  valuesMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
    insert: () => ({ values: (v: unknown) => (valuesMock(v), { returning: returningMock }) }),
  },
  pool: { end: () => Promise.resolve() },
}));

import { create, findById } from '../src/modules/videos/videos.repo.js';

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
    whereMock.mockResolvedValueOnce([video]);
    await expect(findById(video.id)).resolves.toEqual(video);
    whereMock.mockResolvedValueOnce([]);
    await expect(findById('x')).resolves.toBeNull();
  });
});
