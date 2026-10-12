import { describe, expect, it } from 'vitest';
import { buildLaserPoint, clamp01, parseSocialMessage } from './socialSocket';

describe('canal social — puntero láser', () => {
  it('parsea el broadcast laser', () => {
    const msg = { type: 'laser', event_id: 'e1', user_id: 'u1', nick: 'Host', x: 0.5, y: 0.25, end: false };
    expect(parseSocialMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it('buildLaserPoint arma laser_point con coordenadas normalizadas', () => {
    const frame = JSON.parse(buildLaserPoint('r1', 0.123456, 1.4, false, 'ev-1'));
    expect(frame).toEqual({ type: 'laser_point', event_id: 'ev-1', room_id: 'r1', x: 0.1235, y: 1 });
  });

  it('el último punto del trazo lleva end: true', () => {
    const frame = JSON.parse(buildLaserPoint('r1', -2, 0.5, true));
    expect(frame).toMatchObject({ type: 'laser_point', x: 0, y: 0.5, end: true });
    expect(typeof frame.event_id).toBe('string');
  });

  it.each([
    [Number.NaN, 0],
    [-1, 0],
    [0.5, 0.5],
    [2, 1],
  ])('clamp01(%f) → %f', (v, out) => {
    expect(clamp01(v)).toBe(out);
  });
});
