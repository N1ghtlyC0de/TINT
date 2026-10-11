import { useEffect, useRef, useState } from 'react';
import { toAbsoluteInviteLink } from '../lib/invite';

/** Tiempo que se muestra la confirmación antes de volver a `Copiar`. */
export const COPIED_RESET_MS = 3000;

interface CopyButtonProps {
  /** Link relativo (`/invite/:code`) o absoluto. Se normaliza al copiar. */
  link: string;
  className?: string;
  /** Ms que se muestra la confirmación (default 3000). Útil para tests. */
  resetMs?: number;
}

/** Botón de copiar link de invitación con confirmación temporal y estado de error. */
export function CopyButton({ link, className, resetMs = COPIED_RESET_MS }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toAbsoluteInviteLink(link));
      setState('copied');
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setState('idle'), resetMs);
    } catch {
      setState('error');
    }
  };

  const label = state === 'copied' ? 'Copiado' : state === 'error' ? 'Reintentar' : 'Copiar';
  const style =
    state === 'copied'
      ? 'border-tint-success/40 bg-tint-success/10 text-tint-success'
      : 'border-white/15 bg-white/5 text-white hover:bg-white/10';

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-live="polite"
      className={`shrink-0 rounded-full border px-3 py-1 text-[12px] font-medium transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent ${style} ${className ?? ''}`}
    >
      {label}
    </button>
  );
}
