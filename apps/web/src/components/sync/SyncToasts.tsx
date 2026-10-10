import type { SyncToast } from '../../hooks/useSyncToasts';

/**
 * Pila de avisos de reproducción. La región `aria-live` existe siempre (aunque esté
 * vacía) para que los lectores de pantalla anuncien cada aviso nuevo.
 */
export function ToastStack({ toasts, className = '' }: { toasts: SyncToast[]; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none flex flex-col items-end gap-2 ${className}`}
    >
      {toasts.map((t) => (
        <p
          key={t.id}
          className="rounded-full border border-white/15 bg-black/80 px-4 py-1.5 text-[13px] text-white shadow-lg shadow-black/40 backdrop-blur motion-safe:animate-[tint-toast-in_180ms_ease-out]"
        >
          {t.text}
        </p>
      ))}
    </div>
  );
}
