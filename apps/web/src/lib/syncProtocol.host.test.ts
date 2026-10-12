import { describe, expect, it } from 'vitest';
import {
  buildCommand,
  isQualityPref,
  normalizeQuality,
  normalizeVolume,
  parseServerMessage,
  QUALITY_PREFS,
} from './syncProtocol';

describe('protocolo v2 — VOLUME y QUALITY', () => {
  it.each(['VOLUME', 'QUALITY'])('acepta el tipo %s', (type) => {
    expect(parseServerMessage(JSON.stringify({ type }))).toEqual({ type });
  });

  it('buildCommand incluye volume y quality cuando se dan', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(buildCommand('VOLUME', 'r1', 1_000.4, now, { volume: 0.5 })).toMatchObject({
      type: 'VOLUME',
      position_ms: 1_000,
      volume: 0.5,
    });
    const q = buildCommand('QUALITY', 'r1', 0, now, { quality: '720p' });
    expect(q).toMatchObject({ type: 'QUALITY', quality: '720p' });
    expect(q).not.toHaveProperty('volume');
  });

  it('volume 0 (silencio) también se envía', () => {
    expect(buildCommand('VOLUME', 'r1', 0, new Date(), { volume: 0 })).toHaveProperty('volume', 0);
  });

  it.each([
    [undefined, 1],
    [null, 1],
    ['0.5', 1],
    [Number.NaN, 1],
    [0.25, 0.25],
    [0, 0],
    [-1, 0],
    [3, 1],
  ])('normalizeVolume(%s) → %f', (raw, out) => {
    expect(normalizeVolume(raw)).toBe(out);
  });

  it.each([
    [undefined, 'auto'],
    ['4k', 'auto'],
    ['source', 'source'],
    ['720p', '720p'],
    ['360p', '360p'],
    ['auto', 'auto'],
  ])('normalizeQuality(%s) → %s', (raw, out) => {
    expect(normalizeQuality(raw)).toBe(out);
  });

  it('isQualityPref y QUALITY_PREFS', () => {
    expect(QUALITY_PREFS).toEqual(['auto', 'source', '720p', '360p']);
    expect(isQualityPref('720p')).toBe(true);
    expect(isQualityPref(720)).toBe(false);
  });
});
