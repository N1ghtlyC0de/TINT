import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from '../test/mockWebSocket';
import { useSyncSocket, type UseSyncSocketOptions } from './useSyncSocket';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const WS = 'ws://test/ws/sync';

const snapshot = {
  type: 'STATE',
  status: 'paused',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 5,
  server_time_ms: 1_200,
  online: true,
  media_id: 'm1',
} as const;

async function hostConnected() {
  mockedApiFetch.mockResolvedValue({ token: 't', expiresAt: 'x' });
  const hook = renderHook((props: UseSyncSocketOptions) => useSyncSocket(props), {
    initialProps: { roomId: 'r1', role: 'host', url: WS, encoding: 'json' } as UseSyncSocketOptions,
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const ws = MockWebSocket.last();
  act(() => ws.open());
  return { ...hook, ws };
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSyncSocket — VOLUME y QUALITY', () => {
  it('por defecto volumen 1 y calidad auto (servidor sin los campos)', async () => {
    const { result, ws } = await hostConnected();
    expect(result.current.volume).toBe(1);
    expect(result.current.quality).toBe('auto');
    act(() => ws.receive(snapshot));
    expect(result.current.volume).toBe(1);
    expect(result.current.quality).toBe('auto');
  });

  it('toma volume y quality del STATE', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive({ ...snapshot, volume: 0.3, quality: '360p' }));
    expect(result.current.volume).toBe(0.3);
    expect(result.current.quality).toBe('360p');
    expect(result.current.state?.volume).toBe(0.3);
  });

  it('envía VOLUME y QUALITY con sus campos', async () => {
    const { result, ws } = await hostConnected();
    act(() => {
      result.current.sendCommand('VOLUME', 1_000, { volume: 0.4 });
      result.current.sendCommand('QUALITY', 1_000, { quality: '720p' });
    });
    expect(ws.sentJson()).toEqual([
      expect.objectContaining({ type: 'VOLUME', volume: 0.4, position_ms: 1_000 }),
      expect.objectContaining({ type: 'QUALITY', quality: '720p', position_ms: 1_000 }),
    ]);
  });

  it.each([
    ['VOLUME', {}],
    ['VOLUME', { volume: -0.1 }],
    ['VOLUME', { volume: 1.5 }],
    ['VOLUME', { volume: Number.NaN }],
    ['QUALITY', {}],
    ['QUALITY', { quality: '4k' }],
  ] as const)('rechaza %s inválido %j', async (type, extra) => {
    const { result, ws } = await hostConnected();
    expect(result.current.sendCommand(type, 0, extra as never)).toBeNull();
    expect(ws.sent).toHaveLength(0);
  });

  it('acepta broadcasts VOLUME/QUALITY por versión, como RATE', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive(snapshot));
    act(() => ws.receive({ ...snapshot, type: 'VOLUME', volume: 0.2, version: 4 }));
    expect(result.current.volume).toBe(1);
    act(() => ws.receive({ ...snapshot, type: 'VOLUME', event_id: 'e1', volume: 0.2, version: 6 }));
    expect(result.current.volume).toBe(0.2);
    expect(result.current.lastBroadcast).toMatchObject({ type: 'VOLUME', volume: 0.2, own: false });
    act(() => ws.receive({ ...snapshot, type: 'QUALITY', quality: '720p', volume: 0.2, version: 7 }));
    expect(result.current.quality).toBe('720p');
    expect(result.current.lastBroadcast).toMatchObject({ type: 'QUALITY', quality: '720p' });
  });

  it('SYNC_CORRECTION con volume/quality actualiza el maestro sin tocar el snapshot', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive(snapshot));
    const before = result.current.state;
    act(() =>
      ws.receive({ type: 'SYNC_CORRECTION', target_ms: 1, strategy: 'seek', drift_ms: 900, version: 5, volume: 0.6, quality: '360p' }),
    );
    expect(result.current.volume).toBe(0.6);
    expect(result.current.quality).toBe('360p');
    expect(result.current.state).toBe(before);
    // Sin los campos (servidor viejo): conserva lo último conocido.
    act(() => ws.receive({ type: 'SYNC_CORRECTION', target_ms: 1, strategy: 'seek', drift_ms: 900, version: 5 }));
    expect(result.current.volume).toBe(0.6);
    expect(result.current.quality).toBe('360p');
  });
});
