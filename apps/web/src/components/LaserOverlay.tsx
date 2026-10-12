import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clamp01, type LaserPoint } from '../lib/socialSocket';
import { readStored, writeStored } from '../lib/safeStorage';

/** Tiempo en que un punto del trazo se desvanece por completo. */
export const LASER_FADE_MS = 2_500;
/** Duración del marcador fijo que queda al soltar (último punto del trazo). */
export const LASER_MARKER_MS = 3_000;
/** Duración del "ping" de un clic sin arrastre. */
export const LASER_PING_MS = 1_200;
/** Límite de social-core: 30 laser_point por segundo, incluido el `end: true`. */
export const LASER_POINTS_PER_SECOND = 30;
/** Clave de `localStorage` que recuerda que la ayuda del láser ya se mostró. */
export const LASER_HINT_KEY = 'tint_laser_hint_seen';
/** Tiempo que se ve la ayuda la primera vez. */
export const LASER_HINT_MS = 4_000;
const LASER_WINDOW_MS = 1_000;
/** Desplazamiento mínimo (px de pantalla) para que un clic pase a ser un trazo. */
const DRAG_THRESHOLD_PX = 4;

export interface LaserTrailPoint {
  x: number;
  y: number;
  /** Instante local (reloj del overlay) de llegada: nunca el reloj del emisor. */
  t: number;
  end: boolean;
}

/** Marcador fijo al soltar: último punto del trazo con el nick de quien lo dibujó. */
export interface LaserMarker {
  x: number;
  y: number;
  t: number;
  nick: string;
}

/** Ondas de un clic sin arrastre. */
export interface LaserPing {
  x: number;
  y: number;
  t: number;
}

type Trails = Map<string, LaserTrailPoint[]>;

/** Acento de TINT (#FF6B1A) para el halo; el núcleo es blanco para que se lea sobre cualquier vídeo. */
const ACCENT_RGB = '255, 107, 26';
const CORE_RGB = '255, 255, 255';
const HALO_WIDTH = 11;
const CORE_WIDTH = 3.5;
const HEAD_RADIUS = 5;
const MARKER_PULSE_MS = 1_000;
const MARKER_FADE_OUT_MS = 400;
const PING_RINGS = 3;
const PING_STAGGER_MS = 200;
const PING_RING_MS = LASER_PING_MS - (PING_RINGS - 1) * PING_STAGGER_MS;
const LABEL_MAX_CHARS = 24;

const alphaAt = (p: LaserTrailPoint, now: number) => 1 - (now - p.t) / LASER_FADE_MS;
const mid = (a: LaserTrailPoint, b: LaserTrailPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

/** Parte la lista de puntos de un usuario en trazos (cada `end` cierra uno). */
function splitStrokes(points: LaserTrailPoint[]): LaserTrailPoint[][] {
  const strokes: LaserTrailPoint[][] = [];
  let current: LaserTrailPoint[] = [];
  for (const p of points) {
    current.push(p);
    if (p.end) {
      strokes.push(current);
      current = [];
    }
  }
  if (current.length > 0) strokes.push(current);
  return strokes;
}

interface Segment {
  from: { x: number; y: number };
  control: { x: number; y: number } | null;
  to: { x: number; y: number };
  alpha: number;
}

/**
 * Tramos suavizados de un trazo: curvas cuadráticas con cada punto intermedio como control
 * y los puntos medios como extremos; el último tramo es recto hasta el punto final.
 */
function strokeSegments(stroke: LaserTrailPoint[], now: number): Segment[] {
  const segments: Segment[] = [];
  const m = stroke.length;
  for (let i = 1; i < m - 1; i += 1) {
    segments.push({
      from: i === 1 ? stroke[0] : mid(stroke[i - 1], stroke[i]),
      control: stroke[i],
      to: mid(stroke[i], stroke[i + 1]),
      alpha: alphaAt(stroke[i], now),
    });
  }
  if (m >= 2) {
    segments.push({
      from: m === 2 ? stroke[0] : mid(stroke[m - 2], stroke[m - 1]),
      control: null,
      to: stroke[m - 1],
      alpha: alphaAt(stroke[m - 2], now),
    });
  }
  return segments.filter((s) => s.alpha > 0);
}

/**
 * Pinta los trazos (uno por usuario): halo ancho en el color de acento y núcleo blanco,
 * con curvas suavizadas que se apagan con la edad de cada punto. Pura salvo por el
 * contexto: se prueba con un contexto falso.
 */
export function drawTrails(ctx: CanvasRenderingContext2D, trails: Trails, now: number, width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const heads: { p: LaserTrailPoint; alpha: number }[] = [];
  const segments: Segment[] = [];
  for (const points of trails.values()) {
    const strokes = splitStrokes(points);
    for (const stroke of strokes) segments.push(...strokeSegments(stroke, now));
    const last = strokes[strokes.length - 1];
    const head = last?.[last.length - 1];
    if (head && !head.end && alphaAt(head, now) > 0) heads.push({ p: head, alpha: alphaAt(head, now) });
  }

  const pass = (rgb: string, lineWidth: number, blur: number, alphaScale: number) => {
    ctx.lineWidth = lineWidth;
    ctx.shadowColor = `rgba(${ACCENT_RGB}, 0.9)`;
    ctx.shadowBlur = blur;
    for (const s of segments) {
      ctx.strokeStyle = `rgba(${rgb}, ${s.alpha * alphaScale})`;
      ctx.beginPath();
      ctx.moveTo(s.from.x * width, s.from.y * height);
      if (s.control) {
        ctx.quadraticCurveTo(s.control.x * width, s.control.y * height, s.to.x * width, s.to.y * height);
      } else {
        ctx.lineTo(s.to.x * width, s.to.y * height);
      }
      ctx.stroke();
    }
  };
  pass(ACCENT_RGB, HALO_WIDTH, 18, 0.55);
  pass(CORE_RGB, CORE_WIDTH, 6, 1);

  for (const { p, alpha } of heads) {
    ctx.shadowBlur = 16;
    ctx.fillStyle = `rgba(${CORE_RGB}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x * width, p.y * height, HEAD_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

/**
 * Marcador fijo al soltar: punto, dos anillos que pulsan hacia fuera y etiqueta con el nick.
 * Devuelve `false` cuando ya caducó (no pinta nada).
 */
export function drawMarker(ctx: CanvasRenderingContext2D, marker: LaserMarker, now: number, width: number, height: number): boolean {
  const age = Math.max(0, now - marker.t);
  if (age >= LASER_MARKER_MS) return false;
  const fade = Math.min(1, (LASER_MARKER_MS - age) / MARKER_FADE_OUT_MS);
  const cx = marker.x * width;
  const cy = marker.y * height;

  ctx.lineWidth = 2.5;
  ctx.shadowColor = `rgba(${ACCENT_RGB}, 0.9)`;
  ctx.shadowBlur = 10;
  for (const offset of [0, 0.5]) {
    const phase = ((age / MARKER_PULSE_MS + offset) % 1 + 1) % 1;
    ctx.strokeStyle = `rgba(${ACCENT_RGB}, ${(1 - phase) * fade})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 9 + 20 * phase, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(${ACCENT_RGB}, ${0.45 * fade})`;
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(${CORE_RGB}, ${fade})`;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  const nick = marker.nick.trim();
  if (nick) {
    const text = nick.length > LABEL_MAX_CHARS ? `${nick.slice(0, LABEL_MAX_CHARS - 1)}…` : nick;
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pillW = ctx.measureText(text).width + 16;
    const pillH = 22;
    let lx = cx + 14;
    if (lx + pillW > width) lx = Math.max(0, cx - 14 - pillW);
    let ly = cy - 14 - pillH;
    if (ly < 0) ly = Math.min(height - pillH, cy + 14);
    // Fondo oscuro casi opaco: texto blanco con contraste AA sobre cualquier fotograma.
    ctx.fillStyle = `rgba(30, 31, 34, ${0.9 * fade})`;
    ctx.fillRect(lx, ly, pillW, pillH);
    ctx.fillStyle = `rgba(${ACCENT_RGB}, ${fade})`;
    ctx.fillRect(lx, ly, 3, pillH);
    ctx.fillStyle = `rgba(${CORE_RGB}, ${fade})`;
    ctx.fillText(text, lx + 8, ly + pillH / 2);
  }
  return true;
}

/** Ondas expansivas de un clic: tres anillos escalonados. `false` cuando ya terminó. */
export function drawPing(ctx: CanvasRenderingContext2D, ping: LaserPing, now: number, width: number, height: number): boolean {
  const age = Math.max(0, now - ping.t);
  if (age >= LASER_PING_MS) return false;
  const cx = ping.x * width;
  const cy = ping.y * height;
  ctx.shadowColor = `rgba(${ACCENT_RGB}, 0.9)`;
  ctx.shadowBlur = 12;
  for (let k = 0; k < PING_RINGS; k += 1) {
    const progress = (age - k * PING_STAGGER_MS) / PING_RING_MS;
    if (progress < 0 || progress > 1) continue;
    ctx.lineWidth = 3 * (1 - progress) + 1;
    ctx.strokeStyle = `rgba(${k === 0 ? CORE_RGB : ACCENT_RGB}, ${1 - progress})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 4 + 40 * easeOut(progress), 0, Math.PI * 2);
    ctx.stroke();
  }
  const dotAlpha = 1 - age / LASER_PING_MS;
  ctx.fillStyle = `rgba(${CORE_RGB}, ${dotAlpha})`;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  return true;
}

/** Cursor de mira con el acento de TINT (SVG en línea, sin peticiones extra). */
const LASER_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<circle cx='12' cy='12' r='8' fill='none' stroke='%23FF6B1A' stroke-width='2'/>" +
  "<circle cx='12' cy='12' r='2.5' fill='white' stroke='%231E1F22' stroke-width='1'/></svg>";
const LASER_CURSOR = `url("data:image/svg+xml;utf8,${LASER_CURSOR_SVG}") 12 12, crosshair`;

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

interface PressState {
  pos: { x: number; y: number };
  clientX: number;
  clientY: number;
  dragging: boolean;
}

/**
 * Lienzo sobre el vídeo (como ReactionOverlay). Todos ven el trazo del host (núcleo blanco
 * con halo de acento) que se desvanece en 2,5 s; al soltar queda un marcador con su nick y
 * un clic sin arrastre hace un "ping". Quien tiene el modo láser dibuja con el puntero
 * (máx. 30 puntos/s contando el final, al que los movimientos le reservan un hueco).
 */
export function LaserOverlay({ points, drawing = false, onPoint, now = defaultNow }: LaserOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailsRef = useRef<Trails>(new Map());
  const markersRef = useRef<Map<string, LaserMarker>>(new Map());
  const pingsRef = useRef<LaserPing[]>([]);
  /** Usuarios con un trazo abierto: un `end` sin trazo abierto es un clic (ping). */
  const openRef = useRef<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const frameRef = useRef<number | null>(null);
  const nowRef = useRef(now);
  const pressRef = useRef<PressState | null>(null);
  const lastRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    nowRef.current = now;
  });

  // Ayuda breve solo la primera vez que se activa el láser en este navegador.
  useEffect(() => {
    if (!drawing || readStored(LASER_HINT_KEY) === '1') return;
    writeStored(LASER_HINT_KEY, '1');
    setShowHint(true);
    const timer = setTimeout(() => setShowHint(false), LASER_HINT_MS);
    return () => {
      clearTimeout(timer);
      setShowHint(false);
    };
  }, [drawing]);

  const prune = (t: number) => {
    for (const [user, list] of trailsRef.current) {
      const alive = list.filter((p) => t - p.t < LASER_FADE_MS);
      if (alive.length === 0) trailsRef.current.delete(user);
      else trailsRef.current.set(user, alive);
    }
    for (const [user, marker] of markersRef.current) {
      if (t - marker.t >= LASER_MARKER_MS) markersRef.current.delete(user);
    }
    pingsRef.current = pingsRef.current.filter((p) => t - p.t < LASER_PING_MS);
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
    for (const marker of markersRef.current.values()) drawMarker(ctx, marker, t, width, height);
    for (const ping of pingsRef.current) drawPing(ctx, ping, t, width, height);
    const alive = trailsRef.current.size > 0 || markersRef.current.size > 0 || pingsRef.current.length > 0;
    if (alive) frameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const fresh = points.filter((p) => !seenRef.current.has(p.event_id));
    if (fresh.length === 0) return;
    const t = nowRef.current();
    for (const p of fresh) {
      seenRef.current.add(p.event_id);
      const user = p.user_id;
      if (p.end && !openRef.current.has(user)) {
        pingsRef.current.push({ x: p.x, y: p.y, t });
        continue;
      }
      if (p.end) {
        openRef.current.delete(user);
        markersRef.current.set(user, { x: p.x, y: p.y, t, nick: p.nick ?? '' });
      } else {
        openRef.current.add(user);
        markersRef.current.delete(user);
      }
      const list = trailsRef.current.get(user) ?? [];
      list.push({ x: p.x, y: p.y, t, end: p.end });
      trailsRef.current.set(user, list);
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
    setShowHint(false);
    // El inicio se envía al confirmar el arrastre: así un clic llega como un único `end`.
    pressRef.current = { pos, clientX: e.clientX, clientY: e.clientY, dragging: false };
    lastRef.current = pos;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!drawing || !press) return;
    if (!press.dragging && Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) < DRAG_THRESHOLD_PX) return;
    const pos = locate(e);
    if (!pos) return;
    if (!press.dragging) {
      press.dragging = true;
      emit(press.pos.x, press.pos.y, false);
    }
    lastRef.current = pos;
    emit(pos.x, pos.y, false);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    if (!press.dragging) {
      emit(press.pos.x, press.pos.y, true);
      return;
    }
    const pos = locate(e) ?? lastRef.current;
    emit(pos.x, pos.y, true);
  };

  const onPointerCancel = () => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    if (press.dragging) emit(lastRef.current.x, lastRef.current.y, true);
  };

  return (
    <div
      data-testid="laser-overlay"
      className={`absolute inset-0 ${drawing ? 'touch-none' : 'pointer-events-none'}`}
      style={drawing ? { cursor: LASER_CURSOR } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerLeave={finish}
      onPointerCancel={onPointerCancel}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="h-full w-full" />
      {drawing && (
        <p className="sr-only" role="status">
          Puntero láser activo: arrastra sobre el vídeo para dibujar o haz clic para señalar.
        </p>
      )}
      {drawing && showHint && (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/15 bg-tint-bg/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg"
        >
          Arrastra para dibujar · haz clic para señalar
        </p>
      )}
    </div>
  );
}
