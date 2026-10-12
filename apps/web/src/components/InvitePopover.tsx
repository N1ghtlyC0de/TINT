import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { CopyButton } from './CopyButton';
import { toAbsoluteInviteLink } from '../lib/invite';
import { pop } from '../lib/motion';

export interface InvitePopoverProps {
  /** Nick y rol visibles; null si no hay identidad local. */
  identity: { nick: string; role: string } | null;
  inviteLink: string | null;
  className?: string;
}

/**
 * Botón "Invitar" de la cabecera móvil: abre un panel de vidrio con la identidad y el
 * link de invitación. El contenido solo existe abierto (no duplica los chips de ≥ sm).
 * Se cierra con Escape o con un clic fuera, y devuelve el foco al botón.
 */
export function InvitePopover({ identity, inviteLink, className = '' }: InvitePopoverProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (!identity && !inviteLink) return null;

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="tint-glass inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-white transition-colors duration-300 hover:bg-white/[0.09] focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent sm:hidden"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="6.5" cy="5" r="2.4" />
          <path d="M1.8 13.5c.7-2.6 2.6-3.9 4.7-3.9s4 1.3 4.7 3.9M12.5 4.5v4M10.5 6.5h4" />
        </svg>
        Invitar
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            ref={panelRef}
            id={panelId}
            key="panel"
            variants={pop}
            initial="hidden"
            animate="show"
            exit="exit"
            style={{ transformOrigin: 'top right' }}
            className="tint-glass-panel absolute right-0 top-full z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl p-4 text-[13px]"
          >
            {identity && (
              <div>
                <p className="tint-eyebrow">Conectado como</p>
                <p className="mt-1 truncate font-semibold text-white">
                  {identity.nick} · {identity.role}
                </p>
              </div>
            )}
            {inviteLink && (
              <div className={identity ? 'mt-3 border-t border-white/10 pt-3' : ''}>
                <p className="tint-eyebrow">Link de invitación</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-tint-muted" title={toAbsoluteInviteLink(inviteLink)}>
                    {toAbsoluteInviteLink(inviteLink)}
                  </span>
                  <CopyButton link={inviteLink} className="min-h-10 px-4" />
                </div>
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
