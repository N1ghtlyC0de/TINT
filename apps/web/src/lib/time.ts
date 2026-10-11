/** Formatea ms como m:ss o h:mm:ss (posiciones de reproducción). */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/** Velocidad compacta: 1, 1.5, 0.75. */
export function formatRate(rate: number): string {
  return String(Math.round(rate * 100) / 100);
}
