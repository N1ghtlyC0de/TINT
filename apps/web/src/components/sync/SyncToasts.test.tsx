import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncBroadcast } from '../../hooks/useSyncSocket';
import { describeBroadcast, useSyncToasts } from '../../hooks/useSyncToasts';
import { formatRate, formatTime } from '../../lib/time';
import { ToastStack } from './SyncToasts';

function bc(over: Partial<SyncBroadcast> = {}): SyncBroadcast {
  return { seq: 1, type: 'PAUSE', position_ms: 754_000, rate: 1, media_id: 'm', own: false, ...over };
}

describe('formatTime / formatRate', () => {
  it.each([
    [0, '0:00'],
    [-5, '0:00'],
    [9_999, '0:09'],
    [754_000, '12:34'],
    [3_723_000, '1:02:03'],
  ])('%i ms → %s', (ms, out) => {
    expect(formatTime(ms)).toBe(out);
  });

  it.each([
    [1, '1'],
    [1.5, '1.5'],
    [0.75, '0.75'],
    [1.25, '1.25'],
  ])('rate %f → %s', (r, out) => {
    expect(formatRate(r)).toBe(out);
  });
});

describe('describeBroadcast', () => {
  it.each([
    [bc({ type: 'PAUSE' }), 'El host pausó en 12:34'],
    [bc({ type: 'PLAY' }), 'El host reanudó en 12:34'],
    [bc({ type: 'SEEK' }), 'El host saltó a 12:34'],
    [bc({ type: 'RATE', rate: 1.5 }), 'El host cambió la velocidad a 1.5×'],
    [bc({ type: 'LOAD' }), 'El host cargó un nuevo vídeo'],
    [bc({ type: 'VOLUME', volume: 0.456 }), 'El host ajustó el volumen al 46 %'],
    [bc({ type: 'VOLUME', volume: 0 }), 'El host silenció el vídeo'],
    [bc({ type: 'VOLUME' }), 'El host ajustó el volumen al 100 %'],
    [bc({ type: 'QUALITY', quality: '720p' }), 'El host cambió la calidad a 720p'],
    [bc({ type: 'QUALITY', quality: 'source' }), 'El host cambió la calidad a Original'],
    [bc({ type: 'QUALITY', quality: 'auto' }), 'El host cambió la calidad a Auto'],
    [bc({ type: 'QUALITY' }), 'El host cambió la calidad a Auto'],
  ])('%#', (b, text) => {
    expect(describeBroadcast(b)).toBe(text);
  });
});

describe('useSyncToasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    return renderHook((p: { b: SyncBroadcast | null }) => useSyncToasts(p.b), {
      initialProps: { b: null as SyncBroadcast | null },
    });
  }

  it('crea un aviso por broadcast ajeno y lo oculta a los 3 s', () => {
    const { result, rerender } = setup();
    expect(result.current).toEqual([]);
    rerender({ b: bc() });
    expect(result.current.map((t) => t.text)).toEqual(['El host pausó en 12:34']);
    act(() => vi.advanceTimersByTime(2_999));
    expect(result.current).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toHaveLength(0);
  });

  it('no avisa de los comandos propios', () => {
    const { result, rerender } = setup();
    rerender({ b: bc({ own: true }) });
    expect(result.current).toEqual([]);
  });

  it('muestra como máximo 3 (descarta los más viejos)', () => {
    const { result, rerender } = setup();
    for (let i = 1; i <= 5; i++) rerender({ b: bc({ seq: i, type: 'SEEK', position_ms: i * 1_000 }) });
    expect(result.current.map((t) => t.text)).toEqual([
      'El host saltó a 0:03',
      'El host saltó a 0:04',
      'El host saltó a 0:05',
    ]);
  });

  it('cancela los temporizadores al desmontar', () => {
    const { rerender, unmount } = setup();
    rerender({ b: bc() });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ToastStack', () => {
  it('es una región aria-live polite con los avisos', () => {
    render(<ToastStack toasts={[{ id: 1, text: 'El host pausó en 0:10' }]} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('El host pausó en 0:10');
  });

  it('la región existe aunque esté vacía (para que se anuncien los nuevos)', () => {
    render(<ToastStack toasts={[]} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
