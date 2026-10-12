import { useCallback, useEffect, useRef, useState } from 'react';

export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Bandera que se enciende `durationMs` y se apaga sola (p. ej. el fundido al corregir
 * con seek). Con `prefers-reduced-motion` nunca se enciende.
 */
export function useTransientFlag(durationMs: number): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const trigger = useCallback(() => {
    if (prefersReducedMotion()) return;
    clearTimeout(timer.current);
    setActive(true);
    timer.current = setTimeout(() => setActive(false), durationMs);
  }, [durationMs]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return [active, trigger];
}
