import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drawMarker,
  drawPing,
  drawTrails,
  LASER_FADE_MS,
  LASER_HINT_KEY,
  LASER_MARKER_MS,
  LASER_PING_MS,
  LaserOverlay,
  type LaserTrailPoint,
} from './LaserOverlay';
import type { LaserPoint } from '../lib/socialSocket';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
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
    font: '',
    textAlign: '',
    textBaseline: '',
  };
}

type FakeCtx = ReturnType<typeof fakeCtx>;
const asCtx = (ctx: FakeCtx) => ctx as unknown as CanvasRenderingContext2D;
const pt = (x: number, y: number, t: number, end = false): LaserTrailPoint => ({ x, y, t, end });

describe('drawTrails', () => {
  it('limpia y dibuja el trazo suavizado con curvas cuadráticas, halo y núcleo', () => {
    const ctx = fakeCtx();
    const trails = new Map([['u1', [pt(0, 0, 0), pt(0.5, 0.5, 100), pt(1, 1, 200)]]]);
    drawTrails(asCtx(ctx), trails, 200, 200, 100);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 200, 100);
    // Curva por el punto intermedio (control) hasta el punto medio del siguiente tramo.
    expect(ctx.quadraticCurveTo).toHaveBeenCalledWith(100, 50, 150, 75);
    // Dos pasadas: halo de acento y núcleo blanco.
    const strokes = ctx.stroke.mock.calls.length;
    expect(strokes).toBeGreaterThanOrEqual(4);
    expect(strokes % 2).toBe(0);
    expect(ctx.strokeStyle).toMatch(/255, 255, 255/);
    // Cabeza del trazo abierto.
    expect(ctx.arc).toHaveBeenCalledWith(200, 100, expect.any(Number), 0, Math.PI * 2);
  });

  it('los tramos caducan con LASER_FADE_MS (2,5 s)', () => {
    expect(LASER_FADE_MS).toBe(2_500);
    const ctx = fakeCtx();
    const trails = new Map([['u1', [pt(0, 0, 0), pt(1, 1, 0)]]]);
    drawTrails(asCtx(ctx), trails, LASER_FADE_MS, 10, 10);
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.arc).not.toHaveBeenCalled();
    drawTrails(asCtx(ctx), trails, LASER_FADE_MS - 1, 10, 10);
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('corta el trazo después de un punto final', () => {
    const ctx = fakeCtx();
    const trails = new Map([['u1', [pt(0, 0, 100, true), pt(1, 1, 100)]]]);
    drawTrails(asCtx(ctx), trails, 100, 10, 10);
    expect(ctx.stroke).not.toHaveBeenCalled();
    // El punto suelto tras el final es la cabeza de un trazo nuevo.
    expect(ctx.arc).toHaveBeenCalledTimes(1);
  });

  it('no pinta la cabeza si el último punto cerró el trazo', () => {
    const ctx = fakeCtx();
    drawTrails(asCtx(ctx), new Map([['u1', [pt(0, 0, 0), pt(1, 1, 0, true)]]]), 0, 10, 10);
    expect(ctx.lineTo).toHaveBeenCalledWith(10, 10);
    expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe('drawMarker', () => {
  const marker = { x: 0.5, y: 0.5, t: 1_000, nick: 'Ana' };

  it('pinta punto, anillo pulsante y etiqueta con el nick mientras dura', () => {
    const ctx = fakeCtx();
    expect(drawMarker(asCtx(ctx), marker, 1_250, 200, 100)).toBe(true);
    const radii = ctx.arc.mock.calls.map((c) => c[2] as number);
    expect(ctx.arc).toHaveBeenCalledWith(100, 50, expect.any(Number), 0, Math.PI * 2);
    expect(new Set(radii).size).toBeGreaterThan(1);
    expect(ctx.fillText).toHaveBeenCalledWith('Ana', expect.any(Number), expect.any(Number));
  });

  it('el anillo crece con el tiempo (pulso)', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    drawMarker(asCtx(a), marker, 1_050, 200, 100);
    drawMarker(asCtx(b), marker, 1_400, 200, 100);
    const ring = (ctx: FakeCtx) => Math.max(...ctx.arc.mock.calls.map((c) => c[2] as number));
    expect(ring(b)).toBeGreaterThan(ring(a));
  });

  it('deja de pintarse tras LASER_MARKER_MS', () => {
    expect(LASER_MARKER_MS).toBe(3_000);
    const ctx = fakeCtx();
    expect(drawMarker(asCtx(ctx), marker, 1_000 + LASER_MARKER_MS, 200, 100)).toBe(false);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('sin nick no pinta etiqueta', () => {
    const ctx = fakeCtx();
    drawMarker(asCtx(ctx), { ...marker, nick: '' }, 1_100, 200, 100);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('la etiqueta no se sale por la derecha', () => {
    const ctx = fakeCtx();
    drawMarker(asCtx(ctx), { ...marker, x: 1 }, 1_100, 200, 100);
    const [, x] = ctx.fillText.mock.calls[0] as [string, number, number];
    expect(x + 40).toBeLessThanOrEqual(200);
  });
});

describe('drawPing', () => {
  const ping = { x: 0.25, y: 0.5, t: 0 };

  it('dibuja ondas expansivas en el punto', () => {
    const ctx = fakeCtx();
    expect(drawPing(asCtx(ctx), ping, 300, 200, 100)).toBe(true);
    expect(ctx.arc).toHaveBeenCalledWith(50, 50, expect.any(Number), 0, Math.PI * 2);
    expect(ctx.stroke.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('las ondas se agrandan con el tiempo', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    drawPing(asCtx(a), ping, 100, 200, 100);
    drawPing(asCtx(b), ping, 600, 200, 100);
    const max = (ctx: FakeCtx) => Math.max(...ctx.arc.mock.calls.map((c) => c[2] as number));
    expect(max(b)).toBeGreaterThan(max(a));
  });

  it('termina tras LASER_PING_MS', () => {
    const ctx = fakeCtx();
    expect(drawPing(asCtx(ctx), ping, LASER_PING_MS, 200, 100)).toBe(false);
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});

describe('LaserOverlay', () => {
  let frames: FrameRequestCallback[];
  let ctx: FakeCtx;
  let clock: number;

  beforeEach(() => {
    frames = [];
    clock = 0;
    ctx = fakeCtx();
    localStorage.clear();
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

  it('al soltar deja un marcador con el nick que dura LASER_MARKER_MS', () => {
    const { rerender } = render(<LaserOverlay points={[]} now={() => clock} />);
    rerender(
      <LaserOverlay
        points={[point('a', { x: 0.1 }), point('b', { x: 0.2 }), point('c', { x: 0.3, end: true })]}
        now={() => clock}
      />,
    );
    runFrame();
    expect(ctx.fillText).toHaveBeenCalledWith('Host', expect.any(Number), expect.any(Number));
    // El trazo ya se apagó, pero el marcador sigue animando.
    clock = LASER_FADE_MS + 10;
    runFrame();
    expect(frames).toHaveLength(1);
    clock = LASER_MARKER_MS + 10;
    ctx.fillText.mockClear();
    runFrame();
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it('un trazo de un solo punto con end es un ping (sin marcador)', () => {
    const { rerender } = render(<LaserOverlay points={[]} now={() => clock} />);
    rerender(<LaserOverlay points={[point('p', { x: 0.25, end: true })]} now={() => clock} />);
    runFrame();
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalled();
    clock = LASER_PING_MS + 1;
    runFrame();
    expect(frames).toHaveLength(0);
  });

  it('un trazo nuevo del mismo usuario retira su marcador anterior', () => {
    const { rerender } = render(<LaserOverlay points={[]} now={() => clock} />);
    const first = [point('a', { x: 0.1 }), point('b', { x: 0.3, end: true })];
    rerender(<LaserOverlay points={first} now={() => clock} />);
    runFrame();
    clock = 100;
    rerender(<LaserOverlay points={[...first, point('c', { x: 0.9 })]} now={() => clock} />);
    ctx.fillText.mockClear();
    runFrame();
    expect(ctx.fillText).not.toHaveBeenCalled();
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
      const view = render(<LaserOverlay points={[]} drawing onPoint={onPoint} now={() => clock} />);
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
      return { onPoint, surface, ...view };
    }

    it('usa un cursor propio mientras dibuja', () => {
      const { surface } = renderDrawing();
      expect(surface.style.cursor).toContain('url(');
      expect(surface.className).toContain('touch-none');
    });

    it('arrastrar envía el inicio, los puntos normalizados y cierra el trazo al soltar', () => {
      const { onPoint, surface } = renderDrawing();
      expect(screen.getByText(/Puntero láser activo/)).toBeInTheDocument();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      // Hasta que haya arrastre no se sabe si es un clic: no se envía nada.
      expect(onPoint).not.toHaveBeenCalled();
      fireEvent.pointerMove(surface, { clientX: 400, clientY: 0 });
      expect(onPoint).toHaveBeenNthCalledWith(1, 0.5, 0.5, false);
      expect(onPoint).toHaveBeenNthCalledWith(2, 1, 0, false);
      fireEvent.pointerUp(surface, { clientX: 400, clientY: 0 });
      expect(onPoint).toHaveBeenLastCalledWith(1, 0, true);
      // Mover sin botón pulsado no dibuja.
      onPoint.mockClear();
      fireEvent.pointerMove(surface, { clientX: 150, clientY: 60 });
      expect(onPoint).not.toHaveBeenCalled();
    });

    it('un clic sin arrastre envía un único punto con end (ping)', () => {
      const { onPoint, surface } = renderDrawing();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      // Un temblor de unos píxeles no cuenta como arrastre.
      fireEvent.pointerMove(surface, { clientX: 202, clientY: 101 });
      fireEvent.pointerUp(surface, { clientX: 202, clientY: 101 });
      expect(onPoint).toHaveBeenCalledTimes(1);
      expect(onPoint).toHaveBeenCalledWith(0.5, 0.5, true);
    });

    it('máx. 30 puntos/s contando el final: los movimientos le reservan su hueco', () => {
      const { onPoint, surface } = renderDrawing();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      for (let i = 0; i < 50; i += 1) fireEvent.pointerMove(surface, { clientX: 210 + i, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(29);
      fireEvent.pointerLeave(surface, { clientX: 250, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(30);
      expect(onPoint).toHaveBeenLastCalledWith(0.75, 0.5, true);
      // Ventana llena: ni otro clic ni otro final hasta que pase el segundo.
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      fireEvent.pointerUp(surface, { clientX: 200, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(30);
      vi.advanceTimersByTime(1_000);
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      fireEvent.pointerMove(surface, { clientX: 260, clientY: 100 });
      expect(onPoint).toHaveBeenCalledTimes(32);
      fireEvent.pointerCancel(surface);
      expect(onPoint).toHaveBeenCalledTimes(33);
      expect(onPoint).toHaveBeenLastCalledWith(0.8, 0.5, true);
    });

    it('cancelar un clic sin arrastre no envía nada', () => {
      const { onPoint, surface } = renderDrawing();
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      fireEvent.pointerCancel(surface);
      expect(onPoint).not.toHaveBeenCalled();
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
      fireEvent.pointerUp(surface, { clientX: 1, clientY: 1 });
      expect(onPoint).not.toHaveBeenCalled();
    });

    it('la primera vez muestra una ayuda breve y la recuerda', () => {
      const { surface, unmount } = renderDrawing();
      expect(screen.getByText('Arrastra para dibujar · haz clic para señalar')).toBeInTheDocument();
      expect(localStorage.getItem(LASER_HINT_KEY)).toBe('1');
      // Empezar a dibujar la oculta.
      fireEvent.pointerDown(surface, { clientX: 200, clientY: 100 });
      expect(screen.queryByText('Arrastra para dibujar · haz clic para señalar')).not.toBeInTheDocument();
      unmount();
      renderDrawing();
      expect(screen.queryByText('Arrastra para dibujar · haz clic para señalar')).not.toBeInTheDocument();
    });

    it('la ayuda se oculta sola a los pocos segundos', () => {
      renderDrawing();
      expect(screen.getByText('Arrastra para dibujar · haz clic para señalar')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText('Arrastra para dibujar · haz clic para señalar')).not.toBeInTheDocument();
    });
  });
});
