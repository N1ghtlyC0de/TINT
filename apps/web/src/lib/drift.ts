/** Umbral a partir del cual el cliente se re-alinea con el reloj maestro. */
export const DRIFT_THRESHOLD_MS = 500;

/**
 * Calcula el desfase (ms) entre la posición local y la posición esperada según el
 * estado maestro, compensando el tiempo transcurrido desde que se emitió.
 */
export function computeDrift(
  localPositionMs: number,
  masterPositionMs: number,
  masterUpdatedAtMs: number,
  nowMs: number,
  playing: boolean,
): number {
  const elapsed = playing ? Math.max(0, nowMs - masterUpdatedAtMs) : 0;
  return localPositionMs - (masterPositionMs + elapsed);
}

export function shouldResync(driftMs: number, thresholdMs = DRIFT_THRESHOLD_MS): boolean {
  return Math.abs(driftMs) > thresholdMs;
}

/** Velocidad para alcanzar al maestro cuando vamos atrasados. */
export const RATE_BEHIND = 1.05;
/** Velocidad para dejar que el maestro nos alcance cuando vamos adelantados. */
export const RATE_AHEAD = 0.95;
/** Desfase bajo el cual se restaura la velocidad normal. */
export const RATE_RESTORE_TOLERANCE_MS = 100;
/** Duración máxima de una corrección por velocidad. */
export const RATE_MAX_DURATION_MS = 5_000;

/** Corrección ordenada por sync-core (el cálculo autoritativo vive en el servidor). */
export interface Correction {
  target_ms: number;
  strategy: 'rate' | 'seek';
  /** Negativo = cliente atrasado; positivo = adelantado. */
  drift_ms: number;
}

export type CorrectionAction =
  | { kind: 'seek'; seconds: number }
  | { kind: 'rate'; playbackRate: number };

export function correctionAction(correction: Correction): CorrectionAction {
  if (correction.strategy === 'seek') {
    return { kind: 'seek', seconds: correction.target_ms / 1000 };
  }
  const playbackRate =
    correction.drift_ms < 0 ? RATE_BEHIND : correction.drift_ms > 0 ? RATE_AHEAD : 1;
  return { kind: 'rate', playbackRate };
}

/** Aplica la corrección sobre el vídeo (o cualquier objeto con la misma forma). */
export function applyCorrection(
  video: Pick<HTMLMediaElement, 'currentTime' | 'playbackRate'>,
  correction: Correction,
): CorrectionAction {
  const action = correctionAction(correction);
  if (action.kind === 'seek') {
    video.currentTime = action.seconds;
  } else {
    video.playbackRate = action.playbackRate;
  }
  return action;
}

/**
 * Indica si una corrección por velocidad debe terminar: el desfase ya es < 100 ms o
 * se alcanzó la duración máxima. Sin posición esperada solo cuenta el tiempo.
 */
export function shouldRestoreRate(
  localPositionMs: number,
  expectedPositionMs: number | null,
  elapsedMs: number,
): boolean {
  if (elapsedMs >= RATE_MAX_DURATION_MS) return true;
  if (expectedPositionMs === null) return false;
  return Math.abs(localPositionMs - expectedPositionMs) < RATE_RESTORE_TOLERANCE_MS;
}
