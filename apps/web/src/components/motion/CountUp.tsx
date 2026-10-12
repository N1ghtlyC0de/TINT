import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { ease } from '../../lib/motion';

/**
 * Número que cuenta desde el valor anterior hasta `value`. Con movimiento reducido
 * muestra el valor final al instante. `format` recibe enteros (redondeados) salvo
 * que `decimals` diga otra cosa.
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
  const [shown, setShown] = useState(reduced ? value : 0);
  const from = useRef(reduced ? value : 0);
  const factor = 10 ** decimals;

  useEffect(() => {
    if (reduced) {
      from.current = value;
      setShown(value);
      return;
    }
    const controls = animate(from.current, value, {
      duration: 0.9,
      ease,
      onUpdate: (n) => setShown(Math.round(n * factor) / factor),
      onComplete: () => setShown(value),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, reduced, factor]);

  return <span className={`tabular-nums ${className}`}>{format(shown)}</span>;
}
