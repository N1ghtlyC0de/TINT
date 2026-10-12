import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAmbilight } from './useAmbilight';

const FRAMES = [
  { t_ms: 0, top: '#000000', right: '#000000', bottom: '#000000', left: '#000000' },
  { t_ms: 1000, top: '#ffffff', right: '#ff0000', bottom: '#00ff00', left: '#0000ff' },
];

describe('useAmbilight', () => {
  let frames: FrameRequestCallback[];
  let video: { currentTime: number };
  let videoRef: RefObject<HTMLVideoElement>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    frames = [];
    video = { currentTime: 0 };
    videoRef = { current: video as unknown as HTMLVideoElement };
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(FRAMES) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runFrame = () => {
    const pending = frames;
    frames = [];
    act(() => pending.forEach((cb) => cb(0)));
  };

  it('sin URL no descarga ni da color', () => {
    const { result } = renderHook(() => useAmbilight(null, videoRef));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('descarga la paleta y sigue el tiempo del vídeo interpolando', async () => {
    const { result } = renderHook(() => useAmbilight('https://blob/m1/ambilight.json?sig=1', videoRef));
    expect(fetchMock).toHaveBeenCalledWith('https://blob/m1/ambilight.json?sig=1', expect.objectContaining({ signal: expect.anything() }));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    runFrame();
    expect(result.current).toEqual({ top: '#000000', right: '#000000', bottom: '#000000', left: '#000000' });
    video.currentTime = 0.5;
    runFrame();
    expect(result.current?.top).toBe('#808080');
  });

  it('solo re-renderiza cuando cambia el color', async () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useAmbilight('https://blob/m1/ambilight.json', videoRef);
    });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    runFrame();
    const after = renders;
    runFrame();
    runFrame();
    expect(renders).toBe(after);
  });

  it('sin interpolar salta de frame en frame', async () => {
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', videoRef, { interpolate: false }));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    video.currentTime = 0.9;
    runFrame();
    expect(result.current?.top).toBe('#000000');
  });

  it('una URL refirmada del mismo vídeo no vuelve a descargar', async () => {
    const { rerender } = renderHook(({ url }) => useAmbilight(url, videoRef), {
      initialProps: { url: 'https://blob/m1/ambilight.json?sig=1' },
    });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    rerender({ url: 'https://blob/m1/ambilight.json?sig=2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ url: 'https://blob/m2/ambilight.json?sig=1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('desactivado no da color ni anima', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useAmbilight('https://blob/a.json', videoRef, { enabled }), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    runFrame();
    expect(result.current).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('si la descarga falla no hay brillo', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }));
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', videoRef));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(frames).toHaveLength(0);
    expect(result.current).toBeNull();
  });

  it('sin vídeo montado espera sin fallar', async () => {
    const empty: RefObject<HTMLVideoElement> = { current: null };
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', empty));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    runFrame();
    expect(result.current).toBeNull();
    expect(frames).toHaveLength(1);
  });

  it('desmontar a mitad de la descarga la aborta', () => {
    const { unmount } = renderHook(() => useAmbilight('https://blob/a.json', videoRef));
    const signal = (fetchMock.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
