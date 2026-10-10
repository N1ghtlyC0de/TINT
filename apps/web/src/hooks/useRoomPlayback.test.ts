import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api';
import { useRoomPlayback, type UseRoomPlaybackOptions } from './useRoomPlayback';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const NOW = new Date('2026-01-01T00:00:00.000Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function playback(mediaId: string | null, url: string | null, expiresInMs = 15 * 60_000) {
  return { mediaId, url, expiresAt: url ? iso(Date.now() + expiresInMs) : null };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Props {
  roomId: string;
  mediaId: string | undefined;
  opts?: UseRoomPlaybackOptions;
}

function setup(initial: Props) {
  return renderHook((p: Props) => useRoomPlayback(p.roomId, p.mediaId, p.opts), { initialProps: initial });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomPlayback', () => {
  it('pide la URL firmada al montar con el token del rol', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1'));
    const { result } = setup({ roomId: 'r 1', mediaId: undefined, opts: { role: 'guest' } });
    expect(result.current.loading).toBe(true);
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/playback', { method: 'GET' }, 'guest');
    expect(result.current).toMatchObject({
      url: 'https://minio/m1?sig=1',
      mediaId: 'm1',
      loading: false,
      error: null,
    });
  });

  it('el host usa su token por defecto', async () => {
    mockedApiFetch.mockResolvedValue(playback(null, null));
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/playback', { method: 'GET' }, 'host');
    expect(result.current).toMatchObject({ url: null, mediaId: null, expiresAt: null, loading: false });
  });

  it('tolera respuestas sin campos (identity-api antigua)', async () => {
    mockedApiFetch.mockResolvedValue({});
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(result.current).toMatchObject({ url: null, mediaId: null });
  });

  it('vuelve a pedir solo cuando cambia el media_id del estado sync', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1'));
    const { result, rerender } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    rerender({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);

    mockedApiFetch.mockResolvedValue(playback('m2', 'https://minio/m2'));
    rerender({ roomId: 'r1', mediaId: 'm2' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe('https://minio/m2');

    rerender({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('"" (sala sin vídeo) equivale a mediaId null', async () => {
    mockedApiFetch.mockResolvedValue(playback(null, null));
    const { rerender } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    rerender({ roomId: 'r1', mediaId: '' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('descarta respuestas viejas si el vídeo cambió en vuelo', async () => {
    let resolveFirst!: (v: unknown) => void;
    mockedApiFetch
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(playback('m2', 'https://minio/m2'));
    const { result, rerender } = setup({ roomId: 'r1', mediaId: undefined });
    rerender({ roomId: 'r1', mediaId: 'm2' });
    await flush();
    resolveFirst(playback('m1', 'https://minio/m1'));
    await flush();
    expect(result.current.url).toBe('https://minio/m2');
  });

  it('refresca la URL un minuto antes de que expire', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1', 5 * 60_000));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=2', 5 * 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe('https://minio/m1?sig=2');
  });

  it('espera un mínimo antes de refrescar URLs casi vencidas', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1', 10_000));
    setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('ignora expiresAt inválido', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm1', url: 'u', expiresAt: 'no-es-fecha' });
    setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('expone el error y conserva la última URL válida', async () => {
    mockedApiFetch.mockResolvedValueOnce(playback('m1', 'https://minio/m1', 2 * 60_000));
    mockedApiFetch.mockRejectedValueOnce(new Error('500'));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.error).toMatch(/no se pudo cargar/i);
    expect(result.current.loading).toBe(false);
    expect(result.current.url).toBe('https://minio/m1');
  });

  it('limpia el temporizador al desmontar', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1', 2 * 60_000));
    const { unmount } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('enabled=false no pide nada', async () => {
    const { result } = setup({ roomId: 'r1', mediaId: 'm1', opts: { enabled: false } });
    await flush();
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
