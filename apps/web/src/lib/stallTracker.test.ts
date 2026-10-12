import { describe, expect, it, vi } from 'vitest';
import { createStallTracker, MAX_STALL_MS, MIN_STALL_MS } from './stallTracker';

function setup() {
  let t = 0;
  const onStall = vi.fn();
  const tracker = createStallTracker({ now: () => t, onStall });
  const advance = (ms: number) => {
    t += ms;
  };
  return { tracker, onStall, advance };
}

describe('createStallTracker', () => {
  it('reporta un stall waiting → playing con su duración y la posición al reanudar', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(850);
    tracker.playing(12_345);
    expect(onStall).toHaveBeenCalledWith({ durationMs: 850, positionMs: 12_345 });
  });

  it(`ignora stalls triviales (< ${MIN_STALL_MS} ms)`, () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(MIN_STALL_MS - 1);
    tracker.playing(0);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('reporta justo en el umbral mínimo', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(MIN_STALL_MS);
    tracker.playing(0);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('descarta stalls más largos que el máximo del contrato', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(MAX_STALL_MS + 1);
    tracker.playing(0);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('playing sin waiting previo no reporta nada', () => {
    const { tracker, onStall } = setup();
    tracker.playing(1_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('un waiting repetido no reinicia el inicio del stall', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(300);
    tracker.waiting();
    advance(300);
    tracker.playing(0);
    expect(onStall).toHaveBeenCalledWith({ durationMs: 600, positionMs: 0 });
  });

  it('reporta cada stall una sola vez', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(200);
    tracker.playing(0);
    tracker.playing(0);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('descarta el stall provocado por un seek (waiting durante seeking)', () => {
    const { tracker, onStall, advance } = setup();
    tracker.seeking();
    tracker.waiting();
    advance(900);
    tracker.seeked();
    tracker.playing(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('descarta el stall si un seek ocurre mientras espera', () => {
    const { tracker, onStall, advance } = setup();
    tracker.waiting();
    advance(400);
    tracker.seeking();
    tracker.seeked();
    advance(400);
    tracker.playing(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('tras terminar el seek, un stall nuevo sí se reporta', () => {
    const { tracker, onStall, advance } = setup();
    tracker.seeking();
    tracker.seeked();
    tracker.waiting();
    advance(500);
    tracker.playing(7_000);
    expect(onStall).toHaveBeenCalledWith({ durationMs: 500, positionMs: 7_000 });
  });

  it('reset olvida el stall en curso (p. ej. cambio de vídeo)', () => {
    const { tracker, onStall, advance } = setup();
    tracker.seeking();
    tracker.reset();
    tracker.waiting();
    advance(500);
    tracker.reset();
    tracker.playing(0);
    expect(onStall).not.toHaveBeenCalled();
    tracker.waiting();
    advance(200);
    tracker.playing(0);
    expect(onStall).toHaveBeenCalledWith({ durationMs: 200, positionMs: 0 });
  });

  it('usa performance.now por defecto', () => {
    const spy = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(250);
    const onStall = vi.fn();
    const tracker = createStallTracker({ onStall });
    tracker.waiting();
    tracker.playing(0);
    expect(onStall).toHaveBeenCalledWith({ durationMs: 250, positionMs: 0 });
    spy.mockRestore();
  });
});
