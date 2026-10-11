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
  softRemoveById: vi.fn(),
  updateTitle: vi.fn(),
}));

vi.mock('../src/modules/videos/videos.repo.js', () => ({
  create: vi.fn(async (v: any) => v),
  findById: vi.fn(),
  transitionStatus: vi.fn(),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { findById as findRoom, isOwner, setMedia } from '../src/modules/rooms/rooms.repo.js';
import { create as createVideo, findById as findVideo, transitionStatus } from '../src/modules/videos/videos.repo.js';
import { setMediaSigner } from '../src/modules/media/media.signer.js';
import { setMediaStore } from '../src/modules/media/media.store.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VID = '66666666-6666-4666-8666-666666666666';
const activeRoom = { id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null };
const pending = { id: VID, roomId: 'room-1', uploadedBy: 'host-1', storageKey: `${VID}/source.mp4`, contentType: 'video/mp4', sizeBytes: 10, status: 'pending' };

const presignPut = vi.fn(async (key: string, ct: string, ttl: number) => `http://minio.test/tint-media/${key}?put&ct=${ct}&ttl=${ttl}`);
const presignGet = vi.fn(async (key: string, ttl: number) => `http://minio.test/tint-media/${key}?ttl=${ttl}`);
const stat = vi.fn(async (): Promise<{ size: number } | null> => ({ size: 10 }));
const remove = vi.fn(async () => {});
const xadd = vi.fn(async () => '1-0');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findRoom).mockResolvedValue(activeRoom as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  setMediaSigner({ presignGet, presignPut });
  setMediaStore({ stat, remove });
  setRedisClient({ xadd, exists: vi.fn(async () => 0) } as any);
  vi.mocked(transitionStatus).mockImplementation(async (_id, _from, to) => ({ ...pending, status: to }) as any);
});

afterEach(() => {
  setMediaSigner(null);
  setMediaStore(null);
  setRedisClient(null);
});

const start = (body: object) => request(app).post('/api/v1/rooms/room-1/media/uploads').send(body);

describe('POST /rooms/:id/media/uploads', () => {
  it('crea el vídeo pendiente y devuelve una URL PUT firmada', async () => {
    const res = await start({ filename: 'Mi Peli.MP4', contentType: 'video/mp4', sizeBytes: 5_000_000 });
    expect(res.status).toBe(200);
    const { videoId, storageKey, uploadUrl, expiresAt, headers } = res.body;
    expect(videoId).toMatch(UUID_RE);
    expect(storageKey).toBe(`${videoId}/source.mp4`);
    expect(uploadUrl).toBe(`http://minio.test/tint-media/${storageKey}?put&ct=video/mp4&ttl=${env.UPLOAD_URL_TTL_SECONDS}`);
    expect(headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(createVideo).toHaveBeenCalledWith({
      id: videoId,
      roomId: 'room-1',
      uploadedBy: 'host-1',
      storageKey,
      contentType: 'video/mp4',
      sizeBytes: 5_000_000,
      status: 'pending',
    });
  });

  it.each([
    ['clip.webm', 'video/webm', '.webm'],
    ['sin-extension', 'video/quicktime', '.mov'],
    ['raro.exe', 'video/x-matroska', '.mkv'],
    ['otro', 'video/x-desconocido', ''],
  ])('extensión segura para %s (%s)', async (filename, contentType, ext) => {
    const res = await start({ filename, contentType, sizeBytes: 1 });
    expect(res.body.storageKey).toBe(`${res.body.videoId}/source${ext}`);
  });

  it('400 si no es vídeo o faltan campos', async () => {
    expect((await start({ filename: 'a.png', contentType: 'image/png', sizeBytes: 1 })).status).toBe(400);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4' })).status).toBe(400);
    expect((await start({ filename: '', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(400);
    expect(createVideo).not.toHaveBeenCalled();
  });

  it('413 si supera MAX_UPLOAD_BYTES', async () => {
    const res = await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: env.MAX_UPLOAD_BYTES + 1 });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File too large' });
  });

  it('403 si no es dueño y 410 si la sala está borrada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(403);
    vi.mocked(findRoom).mockResolvedValueOnce({ ...activeRoom, status: 'deleted' } as any);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(410);
  });
});

const complete = (id = VID) => request(app).post(`/api/v1/rooms/room-1/media/uploads/${id}/complete`);

describe('POST /rooms/:id/media/uploads/:videoId/complete', () => {
  it('verifica el objeto, encola el procesamiento y asigna el vídeo a la sala', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(setMedia).mockResolvedValueOnce({ ...activeRoom, mediaId: VID } as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: VID, mediaKey: pending.storageKey, status: 'processing' });
    expect(stat).toHaveBeenCalledWith(pending.storageKey);
    expect(transitionStatus).toHaveBeenCalledWith(VID, 'pending', 'processing');
    expect(xadd).toHaveBeenCalledWith('media:uploads', '*', 'video_id', VID);
    expect(setMedia).toHaveBeenCalledWith('room-1', { mediaId: VID, mediaKey: pending.storageKey });
  });

  it('409 si el archivo no llegó al bucket (no encola ni asigna)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce(null);
    const res = await complete();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Upload missing' });
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('413 si el objeto subido es mayor que el sizeBytes declarado: lo borra y no encola', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce({ size: pending.sizeBytes + 1 });
    const res = await complete();
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File too large' });
    expect(remove).toHaveBeenCalledWith(pending.storageKey);
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('413 si el objeto supera MAX_UPLOAD_BYTES aunque se declarara más grande', async () => {
    const big = env.MAX_UPLOAD_BYTES + 10;
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, sizeBytes: big } as any);
    stat.mockResolvedValueOnce({ size: env.MAX_UPLOAD_BYTES + 1 });
    const res = await complete();
    expect(res.status).toBe(413);
    expect(xadd).not.toHaveBeenCalled();
  });

  it('413 aunque falle el borrado del objeto (se registra y se responde igual)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce({ size: pending.sizeBytes + 1 });
    remove.mockRejectedValueOnce(new Error('minio down'));
    const res = await complete();
    expect(res.status).toBe(413);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('404 si el vídeo no existe, es de otra sala o el id no es uuid', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    expect((await complete()).status).toBe(404);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, roomId: 'otra' } as any);
    expect((await complete()).status).toBe(404);
    expect((await complete('no-uuid')).status).toBe(404);
  });

  it('503 si Redis no acepta el evento (el cliente puede reintentar)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    xadd.mockRejectedValueOnce(new Error('redis down'));
    const res = await complete();
    expect(res.status).toBe(503);
    expect(setMedia).not.toHaveBeenCalled();
    // Vuelve a pending para que el reintento pueda encolar.
    expect(transitionStatus).toHaveBeenLastCalledWith(VID, 'processing', 'pending');
  });

  it.each(['processing', 'ready', 'failed'])('es idempotente: si el vídeo ya está %s responde 200 sin re-encolar ni reasignar', async (status) => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status } as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: VID, mediaKey: pending.storageKey, status });
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('dos confirmaciones concurrentes: la que pierde la transición no re-encola', async () => {
    vi.mocked(findVideo)
      .mockResolvedValueOnce(pending as any)
      .mockResolvedValueOnce({ ...pending, status: 'processing' } as any);
    vi.mocked(transitionStatus).mockResolvedValueOnce(null as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('404 si la sala desaparece al asignar', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(setMedia).mockResolvedValueOnce(null as any);
    expect((await complete()).status).toBe(404);
  });
});

describe('GET /rooms/:id/playback con estado del procesamiento', () => {
  const play = () => request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', 'Bearer firebase');

  it('incluye status y, si está ready, la URL firmada de ambilight.json', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready' } as any);
    const res = await play();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.url).toBe(`http://minio.test/tint-media/${pending.storageKey}?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
    expect(res.body.ambilightUrl).toBe(`http://minio.test/tint-media/${VID}/ambilight.json?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
  });

  it('status pending sin ambilight mientras el worker procesa', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    const res = await play();
    expect(res.body).toMatchObject({ status: 'pending', ambilightUrl: null });
  });

  it('status null si el vídeo se asignó por clave manual (sin fila en videos)', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: 'manual/a.mp4' } as any);
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    const res = await play();
    expect(res.body).toMatchObject({ mediaId: VID, status: null, ambilightUrl: null });
  });
});
