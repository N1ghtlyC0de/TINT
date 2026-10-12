import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LASER_STREAM_LIMIT, useSocialSocket } from './useSocialSocket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  sentJson() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function connected() {
  const hook = renderHook(() =>
    useSocialSocket('r1', { createSocket: (url) => new FakeSocket(url) as unknown as WebSocket }),
  );
  const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
  act(() => ws.open());
  return { ...hook, ws };
}

const laser = (event_id: string, over: Record<string, unknown> = {}) => ({
  type: 'laser',
  event_id,
  user_id: 'u-host',
  nick: 'Host',
  x: 0.5,
  y: 0.5,
  end: false,
  ...over,
});

beforeEach(() => {
  FakeSocket.instances = [];
  localStorage.clear();
  vi.useFakeTimers();
});

describe('useSocialSocket — puntero láser', () => {
  it('acumula los puntos recibidos con tope', () => {
    const { result, ws } = connected();
    expect(result.current.laser).toEqual([]);
    act(() => {
      for (let i = 0; i < LASER_STREAM_LIMIT + 5; i += 1) ws.receive(laser(`e${i}`, { x: i / 100 }));
    });
    expect(result.current.laser).toHaveLength(LASER_STREAM_LIMIT);
    expect(result.current.laser[LASER_STREAM_LIMIT - 1]).toMatchObject({ event_id: `e${LASER_STREAM_LIMIT + 4}` });
  });

  it('sendLaser envía laser_point, lo pinta al instante y traga el eco', () => {
    const { result, ws } = connected();
    let ok = false;
    act(() => {
      ok = result.current.sendLaser(0.25, 0.75);
    });
    expect(ok).toBe(true);
    const [frame] = ws.sentJson();
    expect(frame).toMatchObject({ type: 'laser_point', room_id: 'r1', x: 0.25, y: 0.75 });
    expect(result.current.laser).toHaveLength(1);
    expect(result.current.laser[0]).toMatchObject({ event_id: frame.event_id, x: 0.25, y: 0.75, end: false, own: true });
    act(() => ws.receive(laser(frame.event_id as string, { x: 0.25, y: 0.75 })));
    expect(result.current.laser).toHaveLength(1);
  });

  it('sendLaser con end marca el final del trazo', () => {
    const { result, ws } = connected();
    act(() => {
      result.current.sendLaser(0.1, 0.2, true);
    });
    expect(ws.sentJson()[0]).toMatchObject({ end: true });
    expect(result.current.laser[0].end).toBe(true);
  });

  it('sendLaser con el socket cerrado no envía', () => {
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: (url) => new FakeSocket(url) as unknown as WebSocket }),
    );
    expect(result.current.sendLaser(0.5, 0.5)).toBe(false);
    expect(result.current.laser).toEqual([]);
  });
});
