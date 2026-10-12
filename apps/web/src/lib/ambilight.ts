/**
 * Paleta de bordes extraída por media-worker (`{id}/ambilight.json`): una entrada por
 * segundo con el color promedio de cada franja de borde del fotograma.
 */
export interface AmbilightFrame {
  t_ms: number;
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export type AmbilightColors = Omit<AmbilightFrame, 't_ms'>;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const HEX = /^#[0-9a-f]{6}$/i;

function toFrame(value: unknown): AmbilightFrame | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const t = raw.t_ms;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  const frame: Partial<AmbilightFrame> = { t_ms: t };
  for (const side of SIDES) {
    const color = raw[side];
    if (typeof color !== 'string' || !HEX.test(color)) return null;
    frame[side] = color.toLowerCase();
  }
  return frame as AmbilightFrame;
}

/** Valida el JSON descargado (defensivo: ignora entradas mal formadas) y lo ordena por tiempo. */
export function parseAmbilight(json: unknown): AmbilightFrame[] {
  if (!Array.isArray(json)) return [];
  return json
    .map(toFrame)
    .filter((f): f is AmbilightFrame => f !== null)
    .sort((a, b) => a.t_ms - b.t_ms);
}

/** Búsqueda binaria del último frame con `t_ms ≤ tMs` (0 si `tMs` es anterior al primero; -1 sin frames). */
export function findFrameIndex(frames: AmbilightFrame[], tMs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const midIdx = (lo + hi + 1) >> 1;
    if (frames[midIdx].t_ms <= tMs) lo = midIdx;
    else hi = midIdx - 1;
  }
  return lo;
}

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

/** Mezcla lineal de dos colores `#rrggbb` (`f` = 0 → `a`, 1 → `b`). */
export function mixHex(a: string, b: string, f: number): string {
  let out = '#';
  for (let i = 0; i < 3; i += 1) {
    const v = Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * f);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/** Colores en el instante `tMs`: interpolados entre los frames vecinos (o el vigente si `interpolate` es false). */
export function colorsAt(frames: AmbilightFrame[], tMs: number, interpolate = true): AmbilightColors | null {
  const idx = findFrameIndex(frames, tMs);
  if (idx < 0) return null;
  const a = frames[idx];
  const b = frames[idx + 1];
  if (!interpolate || !b || tMs <= a.t_ms) return { top: a.top, right: a.right, bottom: a.bottom, left: a.left };
  const f = Math.min(1, (tMs - a.t_ms) / (b.t_ms - a.t_ms));
  return {
    top: mixHex(a.top, b.top, f),
    right: mixHex(a.right, b.right, f),
    bottom: mixHex(a.bottom, b.bottom, f),
    left: mixHex(a.left, b.left, f),
  };
}
