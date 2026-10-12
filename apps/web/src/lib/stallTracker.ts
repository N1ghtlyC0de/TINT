/**
 * Mide los stalls de reproducción del <video> para la analítica (mensaje BUFFERING).
 *
 * Un stall empieza con `waiting` y termina con el siguiente `playing`. Se descartan:
 * - los triviales (< MIN_STALL_MS),
 * - los que superan MAX_STALL_MS (sync-core rechazaría el mensaje como INVALID),
 * - los provocados por un seek intencional: si el `waiting` llega entre `seeking` y
 *   `seeked`, o si hay un `seeking` mientras se espera. Esto cubre los saltos del
 *   usuario, los comandos SEEK de la sala y las correcciones de drift por seek; la
 *   espera de datos tras un salto no es un problema de red sino del propio salto.
 */

/** Stalls más cortos no se reportan (contrato BUFFERING). */
export const MIN_STALL_MS = 100;
/** Máximo que acepta sync-core en `duration_ms`. */
export const MAX_STALL_MS = 120_000;

export interface Stall {
  durationMs: number;
  positionMs: number;
}

export interface StallTracker {
  waiting(): void;
  playing(positionMs: number): void;
  seeking(): void;
  seeked(): void;
  /** Olvida el stall y el seek en curso (p. ej. al cambiar de vídeo). */
  reset(): void;
}

export interface StallTrackerOptions {
  onStall: (stall: Stall) => void;
  /** Reloj monotónico (ms); por defecto performance.now. */
  now?: () => number;
}

export function createStallTracker({ onStall, now = () => performance.now() }: StallTrackerOptions): StallTracker {
  let startedAt: number | null = null;
  let causedBySeek = false;
  let seekInProgress = false;

  return {
    waiting() {
      if (startedAt !== null) return;
      startedAt = now();
      causedBySeek = seekInProgress;
    },
    playing(positionMs) {
      if (startedAt === null) return;
      const durationMs = Math.round(now() - startedAt);
      const discard = causedBySeek;
      startedAt = null;
      causedBySeek = false;
      if (discard || durationMs < MIN_STALL_MS || durationMs > MAX_STALL_MS) return;
      onStall({ durationMs, positionMs: Math.round(positionMs) });
    },
    seeking() {
      seekInProgress = true;
      if (startedAt !== null) causedBySeek = true;
    },
    seeked() {
      seekInProgress = false;
    },
    reset() {
      startedAt = null;
      causedBySeek = false;
      seekInProgress = false;
    },
  };
}
