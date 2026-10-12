import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clamp01, type LaserPoint } from '../lib/socialSocket';

/** Tiempo en que un punto del trazo se desvanece por completo. */
export const LASER_FADE_MS = 1_500;
/** Límite de social-core: 30 laser_point por segundo, incluido el `end: true`. */
export const LASER_POINTS_PER_SECOND = 30;
const LASER_WINDOW_MS = 1_000;

export interface LaserTrailPoint {
  x: number;
  y: number;
  /** Instante local (reloj del overlay) de llegada: nunca el reloj del emisor. */
  t: number;
  end: boolean;
}

type Trails = Map<string, LaserTrailPoint[]>;

const LASER_RGB = '255, 45, 45';
const LINE_WIDTH = 4;
const HEAD_RADIUS = 6;

const alphaAt = (p: LaserTrailPoint, now: number) => 1 - (now - p.t) / LASER_FADE_MS;

/**
 * Pinta los trazos (uno por usuario) con un brillo rojo que se apaga con la edad de cada
 * punto. Pura salvo por el contexto: se prueba con un contexto falso.
 */
export function drawTrails(ctx: CanvasRenderingContext2D, trails: Trails, now: number, width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LINE_WIDTH;
  ctx.shadowColor = `rgba(${LASER_RGB}, 0.9)`;
  ctx.shadowBlur = 12;
  for (const points of trails.values()) {
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      const alpha = alphaAt(from, now);
      if (from.end || alpha <= 0) continue;
      ctx.strokeStyle = `rgba(${LASER_RGB}, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(from.x * width, from.y * height);
      ctx.lineTo(to.x * width, to.y * height);
      ctx.stroke();
    }
    const head = points[points.length - 1];
    if (head && !head.end && alphaAt(head, now) > 0) {
      ctx.fillStyle = `rgba(${LASER_RGB}, ${alphaAt(head, now)})`;
      ctx.beginPath();
      ctx.arc(head.x * width, head.y * height, HEAD_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export interface LaserOverlayProps {
  /** Puntos del canal social (`useSocialSocket().laser`). */
  points: LaserPoint[];
  /** Modo láser del host: captura el puntero y emite puntos. */
  drawing?: boolean;
  onPoint?: (x: number, y: number, end: boolean) => void;
  /** Reloj local (inyectable para pruebas). */
  now?: () => number;
}

const defaultNow = () => performance.now();

/**
 * Lienzo sobre el vídeo (como ReactionOverlay). Todos ven el trazo rojo del host que se
 * desvanece en 1.5 s; quien tiene el modo láser dibuja con el puntero (máx. 30 puntos/s
 * contando el final, al que los movimientos le reservan un hueco).
 */
export function LaserOverlay({ points, drawing = false, onPoint, now = defaultNow }: LaserOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailsRef = useRef<Trails>(new Map());
  const seenRef = useRef<Set<string>>(new Set());
  const frameRef = useRef<number | null>(null);
  const nowRef = useRef(now);
  const activeRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    nowRef.current = now;
  });

  const prune = (t: number) => {
    for (const [user, list] of trailsRef.current) {
      const alive = list.filter((p) => t - p.t < LASER_FADE_MS);
      if (alive.length === 0) trailsRef.current.delete(user);
      else trailsRef.current.set(user, alive);
    }
  };

  const tick = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    const t = nowRef.current();
    prune(t);
    // Sin canvas 2D (p. ej. jsdom) no hay nada que animar.
    if (!canvas || !ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    drawTrails(ctx, trailsRef.current, t, width, height);
    if (trailsRef.current.size > 0) frameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const fresh = points.filter((p) => !seenRef.current.has(p.event_id));
    if (fresh.length === 0) return;
    const t = nowRef.current();
    for (const p of fresh) {
      seenRef.current.add(p.event_id);
      const list = trailsRef.current.get(p.user_id) ?? [];
      list.push({ x: p.x, y: p.y, t, end: p.end });
      trailsRef.current.set(p.user_id, list);
    }
    if (seenRef.current.size > 500) seenRef.current = new Set(points.map((p) => p.event_id));
    if (frameRef.current === null && typeof requestAnimationFrame === 'function') {
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [points, tick]);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** Envíos en la ventana deslizante (mismo patrón que useThrottle, con hueco reservado). */
  const sentRef = useRef<number[]>([]);

  /**
   * Ventana deslizante compartida por movimientos y finales: los movimientos dejan libre el
   * último hueco para que el `end` del trazo quepa dentro del límite del servidor.
   */
  const emit = (x: number, y: number, end: boolean) => {
    const t = Date.now();
    sentRef.current = sentRef.current.filter((c) => t - c < LASER_WINDOW_MS);
    const cap = end ? LASER_POINTS_PER_SECOND : LASER_POINTS_PER_SECOND - 1;
    if (sentRef.current.length >= cap) return;
    sentRef.current.push(t);
    onPoint?.(x, y, end);
  };

  const locate = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const pos = locate(e);
    if (!pos) return;
    activeRef.current = true;
    lastRef.current = pos;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    emit(pos.x, pos.y, false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || !activeRef.current) return;
    const pos = locate(e);
    if (!pos) return;
    lastRef.current = pos;
    emit(pos.x, pos.y, false);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const pos = locate(e) ?? lastRef.current;
    emit(pos.x, pos.y, true);
  };

  const onPointerCancel = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    emit(lastRef.current.x, lastRef.current.y, true);
  };

  return (
    <div
      data-testid="laser-overlay"
      className={`absolute inset-0 ${drawing ? 'cursor-crosshair touch-none' : 'pointer-events-none'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerLeave={finish}
      onPointerCancel={onPointerCancel}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="h-full w-full" />
      {drawing && (
        <p className="sr-only" role="status">
          Puntero láser activo: mantén pulsado y mueve sobre el vídeo para señalar.
        </p>
      )}
    </div>
  );
}
