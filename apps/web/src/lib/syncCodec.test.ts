import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, MSGPACK_SUBPROTOCOL, resolveEncoding } from './syncCodec';

const msg = {
  event_id: 'e1',
  type: 'SYNC_CHECK',
  room_id: 'r1',
  position_ms: 1_234,
  echo_server_ts: 1_767_225_600_000,
  occurred_at: '2026-01-01T00:00:00.000Z',
};

describe('resolveEncoding', () => {
  it.each([
    [undefined, 'json'],
    ['', 'json'],
    ['json', 'json'],
    ['otro', 'json'],
    ['msgpack', 'msgpack'],
    [' MsgPack ', 'msgpack'],
  ])('%j → %s', (value, out) => {
    expect(resolveEncoding(value)).toBe(out);
  });

  it('usa el subprotocolo del contrato', () => {
    expect(MSGPACK_SUBPROTOCOL).toBe('tint.sync.msgpack');
  });
});

describe('encodeFrame', () => {
  it('JSON produce texto', () => {
    expect(encodeFrame(msg, 'json')).toBe(JSON.stringify(msg));
  });

  it('MessagePack produce binario con las mismas claves y timestamps como string ISO', () => {
    const frame = encodeFrame({ ...msg, extra: undefined }, 'msgpack');
    expect(frame).toBeInstanceOf(Uint8Array);
    const back = decode(frame as Uint8Array) as Record<string, unknown>;
    expect(back).toEqual(msg);
    expect(typeof back.occurred_at).toBe('string');
    expect(back).not.toHaveProperty('extra');
  });
});

describe('decodeFrame', () => {
  it('texto → JSON', () => {
    expect(decodeFrame('{"type":"HEARTBEAT"}')).toEqual({ type: 'HEARTBEAT' });
  });

  it('ArrayBuffer y Uint8Array → MessagePack', () => {
    const bytes = encode({ type: 'STATE', server_time_ms: 1_767_225_600_000, rate: 1.5 });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodeFrame(buffer)).toEqual({ type: 'STATE', server_time_ms: 1_767_225_600_000, rate: 1.5 });
    expect(decodeFrame(bytes)).toEqual({ type: 'STATE', server_time_ms: 1_767_225_600_000, rate: 1.5 });
  });

  it.each([['no-json'], [new Uint8Array([0xc1])], [42], [null], [new Blob(['x'])]])(
    'devuelve null para frames inválidos (%#)',
    (frame) => {
      expect(decodeFrame(frame)).toBeNull();
    },
  );
});
