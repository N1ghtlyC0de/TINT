import { useState } from 'react';
import { toAbsoluteInviteLink } from '../lib/invite';

interface CopyButtonProps {
  /** Link relativo (`/invite/:code`) o absoluto. Se normaliza al copiar. */
  link: string;
  className?: string;
}

/** Botón de copiar link de invitación con confirmación y estado de error. */
export function CopyButton({ link, className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toAbsoluteInviteLink(link));
      setState('copied');
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
