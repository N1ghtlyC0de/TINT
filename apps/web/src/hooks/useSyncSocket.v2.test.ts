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
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 5,
  server_time_ms: 1_200,
  online: true,
} as const;

function setup(opts: Partial<UseSyncSocketOptions> = {}) {
  return renderHook((props: UseSyncSocketOptions) => useSyncSocket(props), {
    initialProps: { roomId: 'r1', role: 'guest', url: WS, encoding: 'json', ...opts } as UseSyncSocketOptions,
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function hostConnected() {
  mockedApiFetch.mockResolvedValue({ token: 't', expiresAt: 'x' });
  const hook = setup({ role: 'host' });
  await flush();
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSyncSocket — control (v2)', () => {
  it('host puede controlar antes del primer STATE; después manda el servidor', async () => {
    const { result, ws } = await hostConnected();
    expect(result.current.canControl).toBe(true);
    act(() => ws.receive({ ...snapshot, can_control: false }));
    expect(result.current.canControl).toBe(false);
    expect(result.current.sendCommand('PLAY', 0)).toBeNull();
  });

  it('participante recibe control delegado con CONTROL y puede enviar comandos', () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(result.current.canControl).toBe(false);
    act(() => ws.receive({ ...snapshot, can_control: false }));
    act(() => ws.receive({ type: 'CONTROL', can_control: true, version: 5 }));
    expect(result.current.canControl).toBe(true);
    let id: string | null = null;
    act(() => {
      id = result.current.sendCommand('PAUSE', 10);
    });
    expect(id).not.toBeNull();
    expect(ws.sentJson()[0]).toMatchObject({ type: 'PAUSE', position_ms: 10 });
    // STATE sin can_control (servidor v1) no cambia el valor.
    act(() => ws.receive({ ...snapshot }));
    expect(result.current.canControl).toBe(true);
    act(() => ws.receive({ type: 'CONTROL', can_control: false }));
    expect(result.current.canControl).toBe(false);
  });
});

describe('useSyncSocket — RATE y LOAD (v2)', () => {
  it('envía RATE con rate y LOAD con media_id', async () => {
    const { result, ws } = await hostConnected();
    act(() => {
      result.current.sendCommand('RATE', 2_000, { rate: 1.5 });
      result.current.sendCommand('LOAD', 0, { media_id: 'm-2' });
    });
    expect(ws.sentJson()).toEqual([
      expect.objectContaining({ type: 'RATE', rate: 1.5, position_ms: 2_000 }),
      expect.objectContaining({ type: 'LOAD', media_id: 'm-2', position_ms: 0 }),
    ]);
  });

  it.each([
    ['RATE', {}],
    ['RATE', { rate: Number.NaN }],
    ['LOAD', {}],
    ['LOAD', { media_id: '' }],
    ['LOAD', { media_id: 'x'.repeat(129) }],
  ] as const)('rechaza %s inválido %j', async (type, extra) => {
    const { result, ws } = await hostConnected();
    expect(result.current.sendCommand(type, 0, extra)).toBeNull();
    expect(ws.sent).toHaveLength(0);
  });

  it('acepta broadcasts RATE/LOAD por versión y guarda media_id', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive({ ...snapshot, media_id: 'm-1' }));
    expect(result.current.state?.media_id).toBe('m-1');
    act(() => ws.receive({ ...snapshot, type: 'RATE', rate: 2, version: 4, media_id: 'm-1' }));
    expect(result.current.state?.rate).toBe(1);
    act(() => ws.receive({ ...snapshot, type: 'RATE', rate: 2, version: 6, media_id: 'm-1' }));
    expect(result.current.state?.rate).toBe(2);
    act(() =>
      ws.receive({
        ...snapshot,
        type: 'LOAD',
        status: 'paused',
        position_ms: 0,
        rate: 1,
        version: 7,
        media_id: 'm-2',
      }),
    );
    expect(result.current.state).toMatchObject({ media_id: 'm-2', status: 'paused', position_ms: 0 });
  });

  it('STATE sin media_id lo normaliza a cadena vacía', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive(snapshot));
    expect(result.current.state?.media_id).toBe('');
  });

  it('lastBroadcast marca los comandos propios por event_id', async () => {
    const { result, ws } = await hostConnected();
    act(() => ws.receive(snapshot));
    let own: string | null = null;
    act(() => {
      own = result.current.sendCommand('SEEK', 3_000);
    });
    act(() => ws.receive({ ...snapshot, type: 'SEEK', event_id: own, position_ms: 3_000, version: 6 }));
    expect(result.current.lastBroadcast).toMatchObject({ seq: 1, type: 'SEEK', own: true, position_ms: 3_000 });
    act(() => ws.receive({ ...snapshot, type: 'PAUSE', event_id: 'otro', status: 'paused', version: 7 }));
    expect(result.current.lastBroadcast).toMatchObject({ seq: 2, type: 'PAUSE', own: false });
    // Broadcast viejo: no genera aviso.
    act(() => ws.receive({ ...snapshot, type: 'PLAY', event_id: 'viejo', version: 3 }));
    expect(result.current.lastBroadcast?.seq).toBe(2);
  });
});

describe('useSyncSocket — calidad (v2)', () => {
  it('toma rtt_ms y drift_ms del HEARTBEAT y el drift de SYNC_CORRECTION', () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(result.current.rttMs).toBeNull();
    expect(result.current.driftMs).toBeNull();
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1, rtt_ms: 40, drift_ms: -120 }));
    expect(result.current.rttMs).toBe(40);
    expect(result.current.driftMs).toBe(-120);
    // v2 omite drift_ms cuando es 0.
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 2, rtt_ms: 35 }));
    expect(result.current.driftMs).toBe(0);
    act(() => ws.receive({ type: 'SYNC_CORRECTION', target_ms: 1, strategy: 'seek', drift_ms: 900, version: 1 }));
    expect(result.current.driftMs).toBe(900);
    // Servidor v1 (sin rtt_ms): conserva los últimos valores.
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 3 }));
    expect(result.current.rttMs).toBe(35);
    expect(result.current.driftMs).toBe(900);
  });
});

describe('useSyncSocket — reconexión explícita y revocación (v2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    localStorage.setItem('tint_guest_token', 'g');
  });

  it('expone el intento y el instante del próximo reintento', () => {
    const { result } = setup();
    expect(result.current.reconnect).toBeNull();
    const t0 = Date.now();
    act(() => MockWebSocket.last().close(1006));
    expect(result.current.reconnect).toEqual({ attempt: 1, nextRetryAt: t0 + 500 });
    act(() => vi.advanceTimersByTime(500));
    act(() => MockWebSocket.last().close(1006));
    expect(result.current.reconnect).toEqual({ attempt: 2, nextRetryAt: t0 + 500 + 1_000 });
    act(() => vi.advanceTimersByTime(1_000));
    act(() => MockWebSocket.last().open());
    expect(result.current.reconnect).toBeNull();
  });

  it('si falla el ticket también expone el reintento', async () => {
    mockedApiFetch.mockRejectedValue(new Error('500'));
    const { result } = setup({ role: 'host' });
    await flush();
    expect(result.current.reconnect).toMatchObject({ attempt: 1 });
  });

  it('cierre 4001: no reconecta, borra el guest token y marca revoked', () => {
    const { result } = setup();
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4001, 'token revocado'));
    expect(result.current.revoked).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(result.current.reconnect).toBeNull();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('un host con cierre 4001 tampoco reconecta y no toca el guest token', async () => {
    mockedApiFetch.mockResolvedValue({ token: 't', expiresAt: 'x' });
    const { result } = setup({ role: 'host' });
    await flush();
    act(() => MockWebSocket.last().close(4001));
    expect(result.current.revoked).toBe(true);
    expect(localStorage.getItem('tint_guest_token')).toBe('g');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
