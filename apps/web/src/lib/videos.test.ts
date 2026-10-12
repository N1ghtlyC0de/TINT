import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api';
import { assignVideo, assignVideoErrorMessage, formatDuration, listVideos, videoStatusLabel, videoTitle } from './videos';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

beforeEach(() => mockedApiFetch.mockReset());

describe('biblioteca de vídeos', () => {
  it('listVideos pide GET /videos con el token de host y tolera respuestas sin lista', async () => {
    const v = { id: 'v1', title: 'Peli', durationMs: 1000, status: 'ready', createdAt: 'x', previewUrl: 'https://p' };
    mockedApiFetch.mockResolvedValueOnce({ videos: [v] }).mockResolvedValueOnce({});
    await expect(listVideos()).resolves.toEqual([v]);
    await expect(listVideos()).resolves.toEqual([]);
    expect(mockedApiFetch).toHaveBeenCalledWith('/videos', { method: 'GET' }, 'host');
  });

  it('assignVideo usa PUT /rooms/:id/media {videoId}', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'v1', mediaKey: 'v1/source.mp4' });
    await expect(assignVideo('r 1', 'v1')).resolves.toEqual({ mediaId: 'v1', mediaKey: 'v1/source.mp4' });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media',
      { method: 'PUT', body: JSON.stringify({ videoId: 'v1' }) },
      'host',
    );
  });

  it.each([
    [new ApiError(404, 'x'), /ya no está disponible/],
    [new ApiError(403, 'x'), /permiso/],
    [new ApiError(410, 'x'), /cerrada/],
    [new ApiError(500, 'x'), /No se pudo poner el vídeo/],
    [new TypeError('x'), /No se pudo poner el vídeo/],
  ])('mensaje simple al asignar %#', (err, expected) => {
    expect(assignVideoErrorMessage(err)).toMatch(expected);
  });

  it.each([
    [null, ''],
    [0, ''],
    [45_000, '45 s'],
    [65_000, '1 min 05 s'],
    [5_400_000, '1 h 30 min'],
    [3_600_000, '1 h'],
  ])('formatDuration(%s) = %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('estado y título en palabras simples', () => {
    expect(videoStatusLabel('ready')).toBe('Listo');
    expect(videoStatusLabel('processing')).toBe('Preparando…');
    expect(videoStatusLabel('pending')).toBe('Preparando…');
    expect(videoTitle({ title: '  Mi peli ' })).toBe('Mi peli');
    expect(videoTitle({ title: null })).toBe('Vídeo sin nombre');
    expect(videoTitle({ title: '   ' })).toBe('Vídeo sin nombre');
  });
});
