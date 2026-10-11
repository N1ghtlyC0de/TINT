/** Calidad percibida de la sincronía a partir de lo que mide sync-core. */
export type SyncQuality = 'good' | 'fair' | 'poor' | 'unknown';

export const GOOD_RTT_MS = 150;
export const GOOD_DRIFT_MS = 200;
export const FAIR_RTT_MS = 400;
export const FAIR_DRIFT_MS = 500;

/**
 * Verde: RTT < 150 ms y |drift| < 200 ms. Amarillo: RTT < 400 ms y |drift| ≤ 500 ms
 * (el umbral de corrección de sync-core). Rojo: el resto. Sin RTT aún: desconocida.
 */
export function syncQuality(rttMs: number | null, driftMs: number | null): SyncQuality {
  if (rttMs === null) return 'unknown';
  const drift = Math.abs(driftMs ?? 0);
  if (rttMs < GOOD_RTT_MS && drift < GOOD_DRIFT_MS) return 'good';
  if (rttMs < FAIR_RTT_MS && drift <= FAIR_DRIFT_MS) return 'fair';
  return 'poor';
}
