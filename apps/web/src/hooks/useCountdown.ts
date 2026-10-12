import { useEffect, useState } from 'react';

/** Segundos que faltan (redondeo hacia arriba) hasta `until`; se refresca solo. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (until === null || until <= Date.now()) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}
