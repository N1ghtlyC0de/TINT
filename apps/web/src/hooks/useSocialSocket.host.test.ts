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

const pollState = (over: Record<string, unknown> = {}) => ({
  type: 'poll_state',
  poll_id: 'p1',
  question: '¿Quién es el culpable?',
  options: ['El mayordomo', 'La tía'],
  counts: [0, 0],
  closes_at_ms: 60_000,
  closed: false,
  ...over,
});

describe('useSocialSocket — encuestas', () => {
  it('createPoll envía poll_create y limpia el último error', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ type: 'error', code: 'POLL_ACTIVE', event_id_ref: 'x' }));
    expect(result.current.lastError).toEqual({ code: 'POLL_ACTIVE', event_id_ref: 'x' });
    let ok = false;
    act(() => {
      ok = result.current.createPoll('¿Final feliz?', ['Sí', 'No'], 60);
    });
    expect(ok).toBe(true);
    expect(ws.sentJson()[0]).toMatchObject({ type: 'poll_create', room_id: 'r1', question: '¿Final feliz?', options: ['Sí', 'No'], duration_s: 60 });
    expect(result.current.lastError).toBeNull();
  });

  it('createPoll pre-valida el borrador', () => {
    const { result, ws } = connected();
    expect(result.current.createPoll('', ['a', 'b'], 60)).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });

  it('expone poll_state y recuerda el voto propio si el servidor no lo envía', () => {
    const { result, ws } = connected();
    expect(result.current.poll).toBeNull();
    act(() => ws.receive(pollState()));
    expect(result.current.poll).toMatchObject({ poll_id: 'p1', my_vote: null });
    act(() => {
      result.current.votePoll('p1', 1);
    });
    expect(ws.sentJson()[0]).toMatchObject({ type: 'poll_vote', poll_id: 'p1', option: 1 });
    expect(result.current.poll?.my_vote).toBe(1);
    act(() => ws.receive(pollState({ counts: [0, 1] })));
    expect(result.current.poll).toMatchObject({ counts: [0, 1], my_vote: 1 });
    // El servidor manda si informa my_vote.
    act(() => ws.receive(pollState({ counts: [1, 1], my_vote: 0 })));
    expect(result.current.poll?.my_vote).toBe(0);
    // Otra encuesta: sin voto.
    act(() => ws.receive(pollState({ poll_id: 'p2' })));
    expect(result.current.poll?.my_vote).toBeNull();
  });

  it('closePoll envía poll_close', () => {
    const { result, ws } = connected();
    act(() => {
      result.current.closePoll('p1');
    });
    expect(ws.sentJson()[0]).toMatchObject({ type: 'poll_close', poll_id: 'p1' });
  });

  it('las acciones con el socket cerrado devuelven false', () => {
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: (url) => new FakeSocket(url) as unknown as WebSocket }),
    );
    expect(result.current.createPoll('¿?', ['a', 'b'], 60)).toBe(false);
    expect(result.current.votePoll('p1', 0)).toBe(false);
    expect(result.current.closePoll('p1')).toBe(false);
  });

  it('un error sin event_id_ref también se expone', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ type: 'error', code: 'FORBIDDEN' }));
    expect(result.current.lastError).toEqual({ code: 'FORBIDDEN', event_id_ref: undefined });
  });
});

describe('useSocialSocket — recap', () => {
  const recap = {
    type: 'recap',
    room_id: 'r1',
    top_emoji_user: { user_id: 'u1', nick: 'Ana', count: 12 },
    most_paused: { position_ms: 65_000, count: 3 },
    peak_reactions: null,
    totals: { reactions: 40, pauses: 5, rewinds: 2, polls: 1 },
  };

  it('requestRecap envía recap_request y expone el recap recibido', () => {
    const { result, ws } = connected();
    expect(result.current.recap).toBeNull();
    let ok = false;
    act(() => {
      ok = result.current.requestRecap();
    });
    expect(ok).toBe(true);
    expect(ws.sentJson()[0]).toMatchObject({ type: 'recap_request', room_id: 'r1' });
    act(() => ws.receive(recap));
    expect(result.current.recap).toMatchObject({ top_emoji_user: { nick: 'Ana' }, totals: { reactions: 40 } });
  });

  it('requestRecap con el socket cerrado devuelve false', () => {
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: (url) => new FakeSocket(url) as unknown as WebSocket }),
    );
    expect(result.current.requestRecap()).toBe(false);
  });
});
