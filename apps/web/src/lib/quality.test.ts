import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoQuality, normalizeQualities, readNetworkHints, resolveQuality, type PlaybackQuality } from './quality';

const ALL: PlaybackQuality[] = [
  { id: 'source', label: 'Original', url: 'https://minio/src' },
  { id: '720p', label: '720p', url: 'https://minio/720' },
  { id: '360p', label: '360p', url: 'https://minio/360' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeQualities', () => {
  it('servidor antiguo sin qualities → solo el original', () => {
    expect(normalizeQualities(undefined, 'https://minio/src')).toEqual([
      { id: 'source', label: 'Original', url: 'https://minio/src' },
    ]);
  });

  it('sin url ni qualities → lista vacía', () => {
    expect(normalizeQualities(undefined, null)).toEqual([]);
  });

  it('filtra entradas inválidas y conserva las válidas', () => {
    const raw = [
      { id: '720p', label: '720p', url: 'https://minio/720' },
      { id: '4k', label: '4K', url: 'x' },
      { id: '360p', url: 'https://minio/360' },
      { id: 'source', label: 'Original', url: '' },
      null,
      'texto',
    ];
    expect(normalizeQualities(raw, 'https://minio/src')).toEqual([
      { id: '720p', label: '720p', url: 'https://minio/720' },
      { id: '360p', label: '360p', url: 'https://minio/360' },
      { id: 'source', label: 'Original', url: 'https://minio/src' },
    ]);
  });

  it('lista vacía del servidor con url → original', () => {
    expect(normalizeQualities([], 'u')).toEqual([{ id: 'source', label: 'Original', url: 'u' }]);
  });

  it('no duplica el original si el servidor ya lo trae', () => {
    expect(normalizeQualities([{ id: 'source', label: 'Fuente', url: 'a' }], 'b')).toEqual([
      { id: 'source', label: 'Fuente', url: 'a' },
    ]);
  });
});

describe('autoQuality', () => {
  it.each([
    [{}, 'source'],
    [{ effectiveType: '4g', viewportWidth: 1280 }, 'source'],
    [{ effectiveType: '3g' }, '360p'],
    [{ effectiveType: 'slow-2g' }, '360p'],
    [{ saveData: true }, '360p'],
    [{ viewportWidth: 480 }, '720p'],
  ] as const)('%j → %s', (hints, out) => {
    expect(autoQuality(hints)).toBe(out);
  });
});

describe('resolveQuality', () => {
  it('sin calidades → null', () => {
    expect(resolveQuality('auto', [], {})).toBeNull();
  });

  it('auto con buena conexión → original', () => {
    expect(resolveQuality('auto', ALL, {})?.id).toBe('source');
  });

  it('auto con conexión lenta → 360p', () => {
    expect(resolveQuality('auto', ALL, { effectiveType: '2g' })?.id).toBe('360p');
  });

  it('elige la calidad pedida si existe', () => {
    expect(resolveQuality('720p', ALL, {})?.url).toBe('https://minio/720');
  });

  it('cae al original si la pedida no existe', () => {
    expect(resolveQuality('360p', [ALL[0], ALL[1]], {})?.id).toBe('source');
  });

  it('sin original usa la primera disponible', () => {
    expect(resolveQuality('360p', [ALL[1]], {})?.id).toBe('720p');
  });

  it('por defecto lee las pistas del navegador', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '2g' } });
    expect(resolveQuality('auto', ALL)?.id).toBe('360p');
  });
});

describe('readNetworkHints', () => {
  it('lee navigator.connection y el ancho de la ventana', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '3g', saveData: false } });
    expect(readNetworkHints()).toEqual({ effectiveType: '3g', saveData: false, viewportWidth: window.innerWidth });
  });

  it('sin Network Information API solo informa el ancho', () => {
    vi.stubGlobal('navigator', {});
    expect(readNetworkHints()).toEqual({ effectiveType: undefined, saveData: undefined, viewportWidth: window.innerWidth });
  });
});
