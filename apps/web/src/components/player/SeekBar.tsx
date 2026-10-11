import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatTime } from '../../lib/time';

export interface SeekBarProps {
  currentMs: number;
  durationMs: number;
  /** Rangos en búfer [inicio, fin] en ms. */
  buffered: Array<[number, number]>;
  /** Posiciones (ms) de los últimos saltos del host. */
  marks: number[];
  /** Quien tiene el control: slider; el resto: barra de progreso de solo lectura. */
  interactive: boolean;
  disabled?: boolean;
  onSeek: (ms: number) => void;
}

const STEP_MS = 5_000;
const PAGE_MS = 30_000;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const pct = (ms: number, total: number) => `${total > 0 ? clamp((ms / total) * 100, 0, 100) : 0}%`;

/**
 * Barra de progreso "de cine": rangos en búfer, avance reproducido, tiempo bajo el
 * cursor y marcadores de los saltos del host. Para quien controla es un `role="slider"`
 * operable con teclado; el SEEK se confirma al soltar (tecla o puntero).
 */
export function SeekBar({ currentMs, durationMs, buffered, marks, interactive, disabled = false, onSeek }: SeekBarProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const draftRef = useRef<number | null>(null);

  const value = draft ?? currentMs;
  const canSeek = interactive && !disabled;

  const updateDraft = (ms: number | null) => {
    draftRef.current = ms;
    setDraft(ms);
  };

  const commit = () => {
    const ms = draftRef.current;
    if (ms === null) return;
    updateDraft(null);
    onSeek(Math.round(ms));
  };

  const msAt = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1) * durationMs;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canSeek) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    updateDraft(msAt(e));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const ms = msAt(e);
    setHover(ms);
    if (dragging.current) updateDraft(ms);
  };

  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    commit();
  };

  const keyTarget = (key: string, from: number): number | null => {
    switch (key) {
      case 'ArrowRight':
      case 'ArrowUp':
        return from + STEP_MS;
      case 'ArrowLeft':
      case 'ArrowDown':
        return from - STEP_MS;
      case 'PageUp':
        return from + PAGE_MS;
      case 'PageDown':
        return from - PAGE_MS;
      case 'Home':
        return 0;
      case 'End':
        return durationMs;
      default:
        return null;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canSeek) return;
    const next = keyTarget(e.key, draftRef.current ?? currentMs);
    if (next === null) return;
    e.preventDefault();
    updateDraft(clamp(next, 0, durationMs));
  };

  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canSeek || keyTarget(e.key, 0) === null) return;
    commit();
  };

  const visibleMarks = durationMs > 0 ? marks.filter((m) => m >= 0 && m <= durationMs) : [];
  const visibleBuffered = durationMs > 0 ? buffered : [];
  const percent = durationMs > 0 ? Math.round((currentMs / durationMs) * 100) : 0;

  const a11y = interactive
    ? {
        role: 'slider',
        tabIndex: disabled ? -1 : 0,
        'aria-label': 'Buscar posición',
        'aria-valuemin': 0,
        'aria-valuemax': durationMs,
        'aria-valuenow': Math.round(value),
        'aria-valuetext': `${formatTime(value)} de ${formatTime(durationMs)}`,
        'aria-disabled': disabled || undefined,
      }
    : {
        role: 'progressbar',
        'aria-label': 'Progreso',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': percent,
      };

  return (
    <div className="relative">
      <div
        {...a11y}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!dragging.current) setHover(null);
        }}
        className={`group relative flex h-5 touch-none items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent focus-visible:ring-offset-2 focus-visible:ring-offset-tint-bg ${
          canSeek ? 'cursor-pointer' : ''
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/15 transition-[height] group-hover:h-1.5 motion-reduce:transition-none">
          {visibleBuffered.map(([start, end]) => (
            <div
              key={`${start}-${end}`}
              data-testid="seek-buffered"
              className="absolute inset-y-0 bg-white/25"
              style={{ left: pct(start, durationMs), width: pct(end - start, durationMs) }}
            />
          ))}
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-tint-accentDark to-tint-accent"
            style={{ width: pct(value, durationMs) }}
          />
        </div>

        {visibleMarks.map((m, i) => (
          <span
            key={`${m}-${i}`}
            aria-hidden="true"
            data-testid="seek-mark"
            title={`Salto del host a ${formatTime(m)}`}
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80"
            style={{ left: pct(m, durationMs) }}
          />
        ))}

        {interactive && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow shadow-black/50 transition-transform group-hover:scale-110 motion-reduce:transition-none"
            style={{ left: pct(value, durationMs) }}
          />
        )}

        {hover !== null && (
          <span
            aria-hidden="true"
            data-testid="seek-hover"
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md border border-white/15 bg-black/85 px-2 py-0.5 text-[12px] tabular-nums text-white"
            style={{ left: pct(hover, durationMs) }}
          >
            {formatTime(hover)}
          </span>
        )}
      </div>
      {visibleMarks.length > 0 && (
        <p className="sr-only">Saltos recientes del host: {visibleMarks.map(formatTime).join(', ')}</p>
      )}
    </div>
  );
}
