import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { pop } from '../../lib/motion';
import { Button } from './Button';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` pinta la acción en rojo (eliminar, retirar). */
  tone?: 'default' | 'danger';
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

/**
 * Confirmación modal accesible que reemplaza a `window.confirm`: `alertdialog`
 * con `aria-modal`, foco inicial en Cancelar, foco atrapado, Escape y clic en el
 * fondo cancelan, y al cerrar devuelve el foco a quien lo abrió.
 *
 * Uso: `const { confirm, dialog } = useConfirm();` → `if (!(await confirm({...}))) return;`
 * y renderizar `{dialog}` en el componente.
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPending({ ...opts, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  const dialog = (
    <AnimatePresence onExitComplete={() => opener.current?.focus()}>
      {pending && <ConfirmPanel key="confirm" options={pending} onSettle={settle} />}
    </AnimatePresence>
  );

  return { confirm, dialog };
}

function ConfirmPanel({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const danger = options.tone === 'danger';

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onSettle(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center px-4" onKeyDown={onKeyDown}>
      <m.div
        data-testid="confirm-backdrop"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => onSettle(false)}
      />
      <m.div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={options.body ? bodyId : undefined}
        variants={pop}
        initial="hidden"
        animate="show"
        exit="exit"
        className="tint-glass-panel relative w-full max-w-sm rounded-2xl p-6"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-white">
          {options.title}
        </h2>
        {options.body && (
          <p id={bodyId} className="mt-2 text-sm leading-relaxed text-tint-muted">
            {options.body}
          </p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} variant="ghost" onClick={() => onSettle(false)}>
            {options.cancelLabel ?? 'Cancelar'}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => onSettle(true)}
          >
            {options.confirmLabel ?? 'Confirmar'}
          </Button>
        </div>
      </m.div>
    </div>
  );
}
