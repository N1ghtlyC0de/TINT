import { AnimatePresence, m } from 'framer-motion';
import type { SyncToast } from '../../hooks/useSyncToasts';
import { ease, spring } from '../../lib/motion';

/**
 * Pila de avisos de reproducción. La región `aria-live` existe siempre (aunque esté
 * vacía) para que los lectores de pantalla anuncien cada aviso nuevo. Cada aviso entra
 * desde arriba a la derecha con un spring y sale deslizándose hacia el borde.
 */
export function ToastStack({ toasts, className = '' }: { toasts: SyncToast[]; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none flex flex-col items-end gap-2 ${className}`}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <m.p
            key={t.id}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.25, ease } }}
            style={{ transformOrigin: 'top right' }}
            className="tint-glass-panel rounded-full px-4 py-1.5 text-[13px] text-white"
          >
            {t.text}
          </m.p>
        ))}
      </AnimatePresence>
    </div>
  );
}
