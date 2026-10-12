import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawTrails, LASER_FADE_MS, LaserOverlay, type LaserTrailPoint } from './LaserOverlay';
import type { LaserPoint } from '../lib/socialSocket';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    shadowBlur: 0,
    shadowColor: '',
    globalAlpha: 1,
  };
}

const pt = (x: number, y: number, t: number, end = false): LaserTrailPoint => ({ x, y, t, end });

describe('drawTrails', () => {
  it('limpia y dibuja segmentos de cada trazo con alfa según la edad', () => {
    const ctx = fakeCtx();
    const trails = new Map([['u1', [pt(0, 0, 0), pt(0.5, 0.5, 750), pt(1, 1, 1_500)]]]);
    drawTrails(ctx as unknown as CanvasRenderingContext2D, trails, 1_500, 200, 100);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 200, 100);
    // Segmento del punto 1→2 (el 0 ya caducó: edad = 1.5 s).
    expect(ctx.moveTo).toHaveBeenCalledWith(100, 50);
    expect(ctx.lineTo).toHaveBeenCalledWith(200, 100);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    // Cabeza del trazo (punto más reciente).
    expect(ctx.arc).toHaveBeenCalledWith(200, 100, expect.any(Number), 0, Math.PI * 2);
    expect(ctx.shadowColor).toMatch(/255/);
  });

  it('corta el trazo después de un punto final', () => {
    const ctx = fakeCtx();
    const trails = new Map([['u1', [pt(0, 0, 100, true), pt(1, 1, 100)]]]);
    drawTrails(ctx as unknown as CanvasRenderingContext2D, trails, 100, 10, 10);
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('no pinta la cabeza si el último punto cerró el trazo', () => {
    const ctx = fakeCtx();
    drawTrails(ctx as unknown as CanvasRenderingContext2D, new Map([['u1', [pt(0, 0, 0), pt(1, 1, 0, true)]]]), 0, 10, 10);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe('LaserOverlay', () => {
  let frames: FrameRequestCallback[];
  let ctx: ReturnType<typeof fakeCtx>;
  let clock: number;

  beforeEach(() => {
    frames = [];
    clock = 0;
    ctx = fakeCtx();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const runFrame = () => {
    const pending = frames;
    frames = [];
    act(() => pending.forEach((cb) => cb(clock)));
  };

  const point = (event_id: string, over: Partial<LaserPoint> = {}): LaserPoint => ({
    type: 'laser',
    event_id,
    user_id: 'u1',
    nick: 'Host',
    x: 0.5,
    y: 0.5,
    end: false,
    ...over,
  });

  it('anima los puntos que llegan y se detiene cuando se desvanecen', () => {
    const { rerender } = render(<LaserOverlay points={[]} now={() => clock} />);
    expect(frames).toHaveLength(0);
    rerender(<LaserOverlay points={[point('a'), point('b', { x: 0.6 })]} now={() => clock} />);
    expect(frames).toHaveLength(1);
    runFrame();
    expect(ctx.stroke).toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    clock = LASER_FADE_MS + 1;
    runFrame();
    expect(frames).toHaveLength(0);
    // Los ya vistos no se vuelven a pintar.
    rerender(<LaserOverlay points={[point('a'), point('b', { x: 0.6 })]} now={() => clock} />);
    expect(frames).toHaveLength(0);
  });

  it('sin canvas 2D (jsdom) no falla', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<LaserOverlay points={[point('a')]} now={() => clock} />);
    runFrame();
    expect(frames).toHaveLength(0);
  });

  it('sin requestAnimationFrame no anima', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    render(<LaserOverlay points={[point('a')]} now={() => clock} />);
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('desmontar cancela la animación', () => {
    const { unmount } = render(<LaserOverlay points={[point('a')]} now={() => clock} />);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('sin modo láser no captura el puntero', () => {
    const onPoint = vi.fn();
    render(<LaserOverlay points={[]} onPoint={onPoint} />);
    const surface = screen.getByTestId('laser-overlay');
    expect(surface.className).toContain('pointer-events-none');
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10 });
    expect(onPoint).not.toHaveBeenCalled();
  });

  describe('dibujo del host', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    function renderDrawing() {
      const onPoint = vi.fn();
      render(<LaserOverlay points={[]} drawing onPoint={onPoint} now={() => clock} />);
      const surface = screen.getByTestId('laser-overlay');
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 50,
        width: 200,
        height: 100,
        right: 300,
        bottom: 150,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      });
      return { onPoint, surface };
    }

    it('envía puntos normalizados y cierra el trazo al soltar', () => {
      const { onPoint, surface } = renderDrawing();
      expect(surface.className).toContain('cursor-crosshair');
      expect(screen.getByText(/Puntero láser activo/)).toBeInTheDocument();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      expect(onPoint).toHaveBeenLastCalledWith(0.5, 0.5, false);
      fireEvent.pointerMove(surface, { clientX: 400, clientY: 0 });
      expect(onPoint).toHaveBeenLastCalledWith(1, 0, false);
      fireEvent.pointerUp(surface, { clientX: 400, clientY: 0 });
      expect(onPoint).toHaveBeenLastCalledWith(1, 0, true);
      // Mover sin botón pulsado no dibuja.
      onPoint.mockClear();
      fireEvent.pointerMove(surface, { clientX: 150, clientY: 60 });
      expect(onPoint).not.toHaveBeenCalled();
    });

    it('limita a 30 puntos por segundo, pero siempre envía el final', () => {
      const { onPoint, surface } = renderDrawing();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      for (let i = 0; i < 50; i += 1) fireEvent.pointerMove(surface, { clientX: 200 + i, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(30);
      fireEvent.pointerLeave(surface, { clientX: 250, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(31);
      expect(onPoint).toHaveBeenLastCalledWith(0.75, 0.5, true);
      vi.advanceTimersByTime(1_000);
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(32);
      fireEvent.pointerCancel(surface);
      expect(onPoint).toHaveBeenCalledTimes(33);
    });

    it('ignora superficies sin tamaño', () => {
      const { onPoint, surface } = renderDrawing();
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      fireEvent.pointerDown(surface, { clientX: 1, clientY: 1 });
      expect(onPoint).not.toHaveBeenCalled();
    });
  });
});
