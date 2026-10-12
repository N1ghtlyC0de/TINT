import { describe, expect, it } from 'vitest';
import { colorsAt, findFrameIndex, mixHex, parseAmbilight, type AmbilightFrame } from './ambilight';

const frame = (t_ms: number, color: string): AmbilightFrame => ({ t_ms, top: color, right: color, bottom: color, left: color });

describe('parseAmbilight', () => {
  it('acepta el formato de media-worker y ordena por t_ms', () => {
    const json = [
      { t_ms: 1000, top: '#FFFFFF', bottom: '#000000', left: '#ff0000', right: '#00ff00' },
      { t_ms: 0, top: '#111111', bottom: '#222222', left: '#333333', right: '#444444' },
    ];
    const frames = parseAmbilight(json);
    expect(frames.map((f) => f.t_ms)).toEqual([0, 1000]);
    expect(frames[1]).toEqual({ t_ms: 1000, top: '#ffffff', bottom: '#000000', left: '#ff0000', right: '#00ff00' });
  });

  it('descarta entradas inválidas y lo que no es una lista', () => {
    expect(parseAmbilight({ frames: [] })).toEqual([]);
    expect(parseAmbilight(null)).toEqual([]);
    const frames = parseAmbilight([
      null,
      { t_ms: 'x', top: '#000000', bottom: '#000000', left: '#000000', right: '#000000' },
      { t_ms: 0, top: 'red', bottom: '#000000', left: '#000000', right: '#000000' },
      { t_ms: -5, top: '#000000', bottom: '#000000', left: '#000000', right: '#000000' },
      { t_ms: 5, top: '#000000', bottom: '#000000', left: '#000000' },
      { t_ms: 7, top: '#0a0b0c', bottom: '#000000', left: '#000000', right: '#000000' },
    ]);
    expect(frames).toHaveLength(1);
    expect(frames[0].t_ms).toBe(7);
  });
});

describe('findFrameIndex', () => {
  const frames = [frame(0, '#000000'), frame(1000, '#000000'), frame(2000, '#000000'), frame(3000, '#000000')];

  it('búsqueda binaria del último frame con t_ms ≤ t', () => {
    expect(findFrameIndex(frames, 0)).toBe(0);
    expect(findFrameIndex(frames, 999)).toBe(0);
    expect(findFrameIndex(frames, 1000)).toBe(1);
    expect(findFrameIndex(frames, 2500)).toBe(2);
    expect(findFrameIndex(frames, 99_999)).toBe(3);
  });

  it('antes del primer frame o sin frames', () => {
    expect(findFrameIndex([frame(500, '#000000')], 100)).toBe(0);
    expect(findFrameIndex([], 100)).toBe(-1);
  });
});

describe('mixHex', () => {
  it('interpola por canal y redondea', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#ff0000', '#0000ff', 0.25)).toBe('#bf0040');
  });
});

describe('colorsAt', () => {
  const frames = [
    { t_ms: 0, top: '#000000', right: '#ff0000', bottom: '#00ff00', left: '#0000ff' },
    { t_ms: 1000, top: '#ffffff', right: '#ff0000', bottom: '#000000', left: '#0000ff' },
  ];

  it('interpola entre los dos frames vecinos', () => {
    expect(colorsAt(frames, 500)).toEqual({ top: '#808080', right: '#ff0000', bottom: '#008000', left: '#0000ff' });
  });

  it('sin interpolar usa el frame vigente', () => {
    expect(colorsAt(frames, 900, false)).toEqual({ top: '#000000', right: '#ff0000', bottom: '#00ff00', left: '#0000ff' });
  });

  it('se queda en los extremos', () => {
    expect(colorsAt(frames, -10)?.top).toBe('#000000');
    expect(colorsAt(frames, 5_000)?.top).toBe('#ffffff');
  });

  it('sin frames no hay color', () => {
    expect(colorsAt([], 0)).toBeNull();
  });
});
