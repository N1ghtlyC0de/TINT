import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host' };
    next();
  },
}));

vi.mock('../src/modules/rooms/rooms.repo.js', () => ({
  create: vi.fn(),
  listByHost: vi.fn(),
  findById: vi.fn(),
  isOwner: vi.fn(async () => true),
  setMedia: vi.fn(),
}));

vi.mock('../src/modules/videos/videos.repo.js', () => ({
  create: vi.fn(),
  findById: vi.fn(),
  transitionStatus: vi.fn(),
  listByUploader: vi.fn(),
  updateTitle: vi.fn(),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { findById as findRoom, isOwner, setMedia } from '../src/modules/rooms/rooms.repo.js';
import { findById as findVideo, listByUploader, updateTitle } from '../src/modules/videos/videos.repo.js';
import { setMediaSigner } from '../src/modules/media/media.signer.js';

const VID = '66666666-6666-4666-8666-666666666666';
const VID2 = '77777777-7777-4777-8777-777777777777';
const ttl = env.PLAYBACK_URL_TTL_SECONDS;
const activeRoom = { id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null };
const ready = {
  id: VID,
  roomId: 'room-1',
  uploadedBy: 'host-1',
  title: 'Mi Peli',
  storageKey: `${VID}/source.mp4`,
  contentType: 'video/mp4',
  sizeBytes: 10,
  durationMs: 90_000,
  status: 'ready',
  renditions: [720, 360],
  createdAt: new Date('2026-10-10T12:00:00.000Z'),
  updatedAt: new Date('2026-10-10T12:00:00.000Z'),
};
const processing = {
  ...ready,
  id: VID2,
  title: 'Otra',
  storageKey: `incoming/${VID2}/original.mov`,
  durationMs: null,
  status: 'processing',
  renditions: [],
  createdAt: new Date('2026-10-11T08:00:00.000Z'),
};

const presignGet = vi.fn(async (key: string, t: number) => `http://minio.test/tint-media/${key}?ttl=${t}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findRoom).mockResolvedValue(activeRoom as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  setMediaSigner({ presignGet, presignPut: vi.fn() });
});

afterEach(() => setMediaSigner(null));

describe('GET /videos', () => {
  it('lista la biblioteca del host con previewUrl firmada (360p si está ready, si no storage_key)', async () => {
    vi.mocked(listByUploader).mockResolvedValueOnce([processing, ready] as any);
    const res = await request(app).get('/api/v1/videos');
    expect(res.status).toBe(200);
    expect(listByUploader).toHaveBeenCalledWith('host-1');
    expect(res.body).toEqual({
      videos: [
        {
          id: VID2,
          title: 'Otra',
          durationMs: null,
          status: 'processing',
          createdAt: '2026-10-11T08:00:00.000Z',
          previewUrl: `http://minio.test/tint-media/incoming/${VID2}/original.mov?ttl=${ttl}`,
        },
        {
          id: VID,
          title: 'Mi Peli',
          durationMs: 90_000,
          status: 'ready',
          createdAt: '2026-10-10T12:00:00.000Z',
          previewUrl: `http://minio.test/tint-media/${VID}/360p.mp4?ttl=${ttl}`,
        },
      ],
    });
  });

  it('ready sin 360p usa storage_key', async () => {
    vi.mocked(listByUploader).mockResolvedValueOnce([{ ...ready, renditions: [720] }] as any);
    const res = await request(app).get('/api/v1/videos');
    expect(res.body.videos[0].previewUrl).toBe(`http://minio.test/tint-media/${VID}/source.mp4?ttl=${ttl}`);
  });

  it('biblioteca vacía', async () => {
    vi.mocked(listByUploader).mockResolvedValueOnce([]);
    const res = await request(app).get('/api/v1/videos');
    expect(res.body).toEqual({ videos: [] });
  });
});

describe('PATCH /videos/:id', () => {
  it('el dueño renombra el vídeo', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(ready as any);
    vi.mocked(updateTitle).mockResolvedValueOnce({ ...ready, title: 'Estreno' } as any);
    const res = await request(app).patch(`/api/v1/videos/${VID}`).send({ title: '  Estreno ' });
    expect(res.status).toBe(200);
    expect(updateTitle).toHaveBeenCalledWith(VID, 'Estreno');
    expect(res.body).toEqual({
      video: {
        id: VID,
        title: 'Estreno',
        durationMs: 90_000,
        status: 'ready',
        createdAt: '2026-10-10T12:00:00.000Z',
        previewUrl: `http://minio.test/tint-media/${VID}/360p.mp4?ttl=${ttl}`,
      },
    });
  });

  it('404 si el vídeo no existe, es de otro host o el id no es uuid', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...ready, uploadedBy: 'otro' } as any);
    expect((await request(app).patch(`/api/v1/videos/${VID}`).send({ title: 'x' })).status).toBe(404);
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    expect((await request(app).patch(`/api/v1/videos/${VID}`).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).patch('/api/v1/videos/nope').send({ title: 'x' })).status).toBe(404);
    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('404 si la fila desaparece entre la lectura y el UPDATE', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(ready as any);
    vi.mocked(updateTitle).mockResolvedValueOnce(null as any);
    expect((await request(app).patch(`/api/v1/videos/${VID}`).send({ title: 'x' })).status).toBe(404);
  });

  it.each([[''], ['   '], ['a'.repeat(256)], [42]])('400 si el título es inválido (%j)', async (title) => {
    const res = await request(app).patch(`/api/v1/videos/${VID}`).send({ title });
    expect(res.status).toBe(400);
    expect(findVideo).not.toHaveBeenCalled();
  });
});

const put = (body: object) => request(app).put('/api/v1/rooms/room-1/media').send(body);

describe('PUT /rooms/:id/media con videoId', () => {
  it('reusa un vídeo de la biblioteca: media_id = video.id y media_key = storage_key', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(ready as any);
    vi.mocked(setMedia).mockResolvedValueOnce({ ...activeRoom, mediaId: VID, mediaKey: ready.storageKey } as any);
    const res = await put({ videoId: VID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: VID, mediaKey: ready.storageKey });
    expect(setMedia).toHaveBeenCalledWith('room-1', { mediaId: VID, mediaKey: ready.storageKey });
  });

  it('404 si el vídeo es de otro host, no existe o falló', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...ready, uploadedBy: 'otro' } as any);
    expect((await put({ videoId: VID })).status).toBe(404);
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    expect((await put({ videoId: VID })).status).toBe(404);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...ready, status: 'failed' } as any);
    expect((await put({ videoId: VID })).status).toBe(404);
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('404 si la sala desaparece al asignar', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(ready as any);
    vi.mocked(setMedia).mockResolvedValueOnce(null as any);
    expect((await put({ videoId: VID })).status).toBe(404);
  });

  it.each([[{ videoId: 'no-uuid' }], [{ videoId: VID, mediaKey: 'a.mp4' }], [{}]])('400 con cuerpo inválido %j', async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(findVideo).not.toHaveBeenCalled();
  });

  it('403 si no es el dueño de la sala', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    expect((await put({ videoId: VID })).status).toBe(403);
    expect(findVideo).not.toHaveBeenCalled();
  });
});
