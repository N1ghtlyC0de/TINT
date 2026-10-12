import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RecapMessage } from '../lib/socialSocket';
import { useRecapGate } from './useRecapGate';

const makeRecap = (n: number): RecapMessage => ({
  type: 'recap',
  room_id: 'r1',
  top_emoji_user: null,
  most_paused: null,
  peak_reactions: null,
  totals: { reactions: n, pauses: 0, rewinds: 0, polls: 0 },
});

type Props = { mediaKey: string | null; recap: RecapMessage | null };

function setup(initial: Props) {
  const requestRecap = vi.fn(() => true);
  const hook = renderHook((p: Props) => useRecapGate({ ...p, requestRecap }), { initialProps: initial });
  return { ...hook, requestRecap };
}

describe('useRecapGate', () => {
  it('al terminar pide el recap una vez y muestra "preparando" hasta que llega uno nuevo', () => {
    const old = makeRecap(1);
    const { result, rerender, requestRecap } = setup({ mediaKey: 'm1', recap: old });
    // Un recap previo (de antes de entrar) ya fue visto al montar: no abre nada.
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
    rerender({ mediaKey: 'm2', recap: old });
    act(() => result.current.onEnded());
    expect(requestRecap).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(true);
    expect(result.current.recap).toBeNull();
    const fresh = makeRecap(2);
    rerender({ mediaKey: 'm2', recap: fresh });
    expect(result.current.recap).toBe(fresh);
  });

  it('bug: dos `ended` seguidos no vuelven a pedir ni a abrir el recap', () => {
    const { result, rerender, requestRecap } = setup({ mediaKey: 'm1', recap: null });
    act(() => result.current.onEnded());
    act(() => result.current.onEnded());
    expect(requestRecap).toHaveBeenCalledTimes(1);
    rerender({ mediaKey: 'm1', recap: makeRecap(1) });
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
    act(() => result.current.onEnded());
    expect(requestRecap).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('bug: recaps nuevos para el mismo vídeo no reabren el modal ya cerrado', () => {
    const { result, rerender } = setup({ mediaKey: 'm1', recap: null });
    rerender({ mediaKey: 'm1', recap: makeRecap(1) });
    expect(result.current.open).toBe(true);
    act(() => result.current.dismiss());
    rerender({ mediaKey: 'm1', recap: makeRecap(2) });
    rerender({ mediaKey: 'm1', recap: makeRecap(3) });
    expect(result.current.open).toBe(false);
  });

  it('cambiar de vídeo rearma el recap', () => {
    const { result, rerender, requestRecap } = setup({ mediaKey: 'm1', recap: null });
    act(() => result.current.onEnded());
    act(() => result.current.dismiss());
    rerender({ mediaKey: 'm2', recap: null });
    act(() => result.current.onEnded());
    expect(requestRecap).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(true);
  });

  it('rearm ("volver a verla") cierra el modal y permite verlo al terminar de nuevo', () => {
    const { result, requestRecap } = setup({ mediaKey: 'm1', recap: null });
    act(() => result.current.onEnded());
    act(() => result.current.rearm());
    expect(result.current.open).toBe(false);
    act(() => result.current.onEnded());
    expect(requestRecap).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(true);
  });

  it('un recap que llega sin pedirlo se muestra una vez', () => {
    const recap = makeRecap(1);
    const { result } = setup({ mediaKey: 'm1', recap });
    expect(result.current.open).toBe(true);
    expect(result.current.recap).toBe(recap);
  });
});
