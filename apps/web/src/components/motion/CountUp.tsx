import { useEffect, useRef, useState } from 'react';
import { MotionGlobalConfig, useReducedMotion } from 'framer-motion';

const DURATION_MS = 900;
// Salida suave equivalente a la curva `ease` de lib/motion (sin el motor de `animate`,
// que sumaría ~18 KB gz al bundle principal por un simple contador).
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

/**
 * Número que cuenta desde el valor anterior hasta `value`. Con movimiento reducido
 * (o `MotionGlobalConfig.skipAnimations` en pruebas) muestra el valor final al
 * instante. `format` recibe el valor redondeado a `decimals`.
 */
export function CountUp({
  value,
  format = String,
  decimals = 0,
  className = '',
}: {
  value: number;
  format?: (n: number) => string;
  decimals?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const instant = Boolean(reduced) || MotionGlobalConfig.skipAnimations;
  const [shown, setShown] = useState(instant ? value : 0);
  const from = useRef(instant ? value : 0);
  const factor = 10 ** decimals;

  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (instant || start === value) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION_MS);
      setShown(t === 1 ? value : Math.round((start + (value - start) * easeOutQuart(t)) * factor) / factor);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, instant, factor]);

  return <span className={`tabular-nums ${className}`}>{format(shown)}</span>;
}
