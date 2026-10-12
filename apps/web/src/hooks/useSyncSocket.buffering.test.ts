import { decode } from '@msgpack/msgpack';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from '../test/mockWebSocket';
import { useSyncSocket, type UseSyncSocketOptions } from './useSyncSocket';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

const WS = 'ws://test/ws/sync';

function setup(opts: Partial<UseSyncSocketOptions> = {}) {
  return renderHook(() => useSyncSocket({ roomId: 'r1', role: 'guest', url: WS, encoding: 'json', ...opts }));
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
  localStorage.setItem('tint_guest_token', 'g');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSyncSocket — BUFFERING', () => {
  it('envía BUFFERING en JSON con el socket abierto (también un invitado sin control)', () => {
    const { result } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(result.current.canControl).toBe(false);
    let sent = false;
    act(() => {
      sent = result.current.sendBuffering(12_345, 850);
    });
    expect(sent).toBe(true);
    const [msg] = ws.sentJson();
    expect(msg).toMatchObject({ type: 'BUFFERING', room_id: 'r1', position_ms: 12_345, duration_ms: 850 });
    expect(typeof msg.event_id).toBe('string');
    expect(Number.isNaN(Date.parse(msg.occurred_at as string))).toBe(false);
  });

  it('usa MessagePack si el servidor aceptó el subprotocolo', () => {
    const { result } = setup({ encoding: 'msgpack' });
    const ws = MockWebSocket.last();
    act(() => ws.open('tint.sync.msgpack'));
    act(() => {
      result.current.sendBuffering(1_000, 300);
    });
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(decode(ws.sent[0] as Uint8Array)).toMatchObject({ type: 'BUFFERING', position_ms: 1_000, duration_ms: 300 });
  });

  it('no envía si el socket no está abierto', () => {
    const { result } = setup();
    const ws = MockWebSocket.last();
    expect(result.current.sendBuffering(1_000, 300)).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });

  it('no envía stalls triviales (< 100 ms)', () => {
    const { result } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(result.current.sendBuffering(1_000, 99)).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });
});
