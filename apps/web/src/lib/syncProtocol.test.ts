import {
  backoffDelay,
  buildCommand,
  buildSyncCheck,
  buildSyncUrl,
  estimateServerNow,
  expectedPosition,
  parseServerMessage,
  type SyncState,
} from './syncProtocol';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const base: SyncState = {
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 3,
  server_time_ms: 1_500,
};

describe('expectedPosition', () => {
  it('avanza la posición según el tiempo del servidor cuando reproduce', () => {
    expect(expectedPosition(base, 3_000)).toBe(12_000);
  });

  it('respeta la tasa de reproducción', () => {
    expect(expectedPosition({ ...base, rate: 2 }, 2_000)).toBe(12_000);
  });

  it('no avanza si está en pausa', () => {
    expect(expectedPosition({ ...base, status: 'paused' }, 9_999)).toBe(10_000);
  });

  it('no retrocede si el reloj estimado es anterior al ancla', () => {
    expect(expectedPosition(base, 500)).toBe(10_000);
  });
});

describe('estimateServerNow', () => {
  it('suma el tiempo local transcurrido desde la recepción', () => {
    expect(estimateServerNow({ ...base, received_at_perf: 100 }, 350)).toBe(1_750);
  });
});

describe('buildCommand', () => {
  it('construye un comando plano con uuid y fecha ISO', () => {
    const cmd = buildCommand('SEEK', 'r1', 1234.6, new Date('2026-01-01T00:00:00.000Z'));
    expect(cmd).toEqual({
      event_id: expect.stringMatching(UUID_RE),
      type: 'SEEK',
      room_id: 'r1',
      position_ms: 1235,
      occurred_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('genera event_id distintos', () => {
    expect(buildCommand('PLAY', 'r', 0).event_id).not.toBe(buildCommand('PLAY', 'r', 0).event_id);
  });
});

describe('buildSyncCheck', () => {
  it('incluye echo_server_ts y la posición redondeada', () => {
    const msg = buildSyncCheck('r1', 999.4, 5_000, new Date('2026-01-01T00:00:01.000Z'));
    expect(msg).toEqual({
      event_id: expect.stringMatching(UUID_RE),
      type: 'SYNC_CHECK',
      room_id: 'r1',
      position_ms: 999,
      occurred_at: '2026-01-01T00:00:01.000Z',
      echo_server_ts: 5_000,
    });
  });
});

describe('buildSyncUrl', () => {
  it('codifica room_id y token en la query', () => {
    expect(buildSyncUrl('ws://h/ws/sync', 'r 1', 'a.b&c')).toBe(
      'ws://h/ws/sync?room_id=r%201&token=a.b%26c',
    );
  });
});

describe('backoffDelay', () => {
  it.each([
    [0, 500],
    [1, 1_000],
    [2, 2_000],
    [4, 8_000],
    [5, 10_000],
    [20, 10_000],
  ])('intento %i → %i ms', (attempt, ms) => {
    expect(backoffDelay(attempt)).toBe(ms);
  });
});

describe('parseServerMessage', () => {
  it('parsea un mensaje con type conocido', () => {
    expect(parseServerMessage('{"type":"HEARTBEAT","server_time_ms":5}')).toEqual({
      type: 'HEARTBEAT',
      server_time_ms: 5,
    });
  });

  it.each(['no-json', '42', 'null', '{"type":"DESCONOCIDO"}', '{"sin":"type"}'])(
    'devuelve null para %s',
    (raw) => {
      expect(parseServerMessage(raw)).toBeNull();
    },
  );
});
