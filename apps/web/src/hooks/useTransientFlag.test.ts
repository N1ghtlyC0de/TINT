import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, useTransientFlag } from './useTransientFlag';

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('prefersReducedMotion', () => {
  it('lee la media query', () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('sin matchMedia (jsdom) asume que no', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('useTransientFlag', () => {
  it('se activa durante la duración y vuelve a false', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTransientFlag(180));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(179));
    expect(result.current[0]).toBe(true);
    // Re-disparar reinicia el temporizador.
    act(() => result.current[1]());
    act(() => vi.advanceTimersByTime(179));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
  });

  it('con prefers-reduced-motion nunca se activa', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTransientFlag(180));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
  });

  it('limpia el temporizador al desmontar', () => {
    stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useTransientFlag(180));
    act(() => result.current[1]());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
