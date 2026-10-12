import { useEffect, useId, useRef, type ReactNode } from 'react';
import { formatMmSs, type RecapMessage } from '../lib/socialSocket';
import { Button } from './ui/Button';

export interface RecapScreenProps {
  /** null mientras social-core prepara el recap. */
  recap: RecapMessage | null;
  onDismiss: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function RecapCard({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <li className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <p className="text-[12px] uppercase tracking-[0.14em] text-tint-muted">
        <span aria-hidden="true" className="mr-1.5 text-base">
          {icon}
        </span>
        {title}
      </p>
      <div className="mt-2">{children}</div>
    </li>
  );
}

function Highlight({ value, detail }: { value: string; detail: string }) {
  return (
    <>
      <p className="truncate text-2xl font-bold tracking-tight text-white">{value}</p>
      <p className="mt-0.5 text-[13px] text-tint-muted">{detail}</p>
    </>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-[14px] text-tint-text">{text}</p>;

/**
 * Infografía "Watch Party Recap" al terminar el vídeo: quién mandó más emojis, la escena
 * con más pausas/retrocesos y el momento con más reacciones, más los totales. Los datos
 * los calcula social-core; cada bloque puede venir null.
 */
export function RecapScreen({ recap, onDismiss }: RecapScreenProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/75 px-4 py-8 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl rounded-3xl border border-tint-accent/30 bg-tint-surface p-6 shadow-2xl sm:p-8"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-tint-accent">Fin de la función</p>
            <h2 id={titleId} className="mt-1 text-2xl font-bold tracking-tight text-white">
              Watch Party Recap
            </h2>
          </div>
          <Button ref={closeRef} variant="ghost" className="px-4 py-2" aria-label="Cerrar recap" onClick={onDismiss}>
            Cerrar
          </Button>
        </div>

        {recap === null ? (
          <p role="status" className="mt-6 text-[14px] text-tint-muted">
            Preparando el recap de la sesión…
          </p>
        ) : (
          <>
            <ul className="mt-6 grid gap-3 sm:grid-cols-3">
              <RecapCard icon="🏆" title="Rey del emoji">
                {recap.top_emoji_user ? (
                  <Highlight
                    value={recap.top_emoji_user.nick}
                    detail={plural(recap.top_emoji_user.count, 'emoji', 'emojis')}
                  />
                ) : (
                  <Empty text="Nadie envió emojis esta vez" />
                )}
              </RecapCard>
              <RecapCard icon="⏸️" title="Escena más pausada">
                {recap.most_paused ? (
                  <Highlight
                    value={formatMmSs(recap.most_paused.position_ms)}
                    detail={plural(recap.most_paused.count, 'pausa o retroceso', 'pausas y retrocesos')}
                  />
                ) : (
                  <Empty text="Nadie pausó: ¡atención total!" />
                )}
              </RecapCard>
              <RecapCard icon="😂" title="Momento más épico">
                {recap.peak_reactions ? (
                  <Highlight
                    value={formatMmSs(recap.peak_reactions.position_ms)}
                    detail={`${plural(recap.peak_reactions.count, 'reacción', 'reacciones')} · ${plural(
                      recap.peak_reactions.laughs,
                      'risa',
                      'risas',
                    )}`}
                  />
                ) : (
                  <Empty text="Sin reacciones registradas" />
                )}
              </RecapCard>
            </ul>

            <ul aria-label="Totales de la sesión" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  [recap.totals.reactions, 'Reacciones'],
                  [recap.totals.pauses, 'Pausas'],
                  [recap.totals.rewinds, 'Retrocesos'],
                  [recap.totals.polls, 'Encuestas'],
                ] as const
              ).map(([value, label]) => (
                <li key={label} className="rounded-xl border border-white/10 bg-tint-bg/60 px-3 py-2 text-center">
                  <span className="block text-xl font-bold tabular-nums text-white">{value}</span>
                  <span className="block text-[12px] text-tint-muted">{label}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
