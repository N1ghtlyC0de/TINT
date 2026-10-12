import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { apiFetch, ApiError } from '../../lib/api';
import { Button } from '../ui/Button';
import { ErrorAlert, Skeleton } from '../ui/Primitives';
import { ease } from '../../lib/motion';

/** Intervalo de refresco automático de la lista de invitados. */
export const PARTICIPANTS_POLL_MS = 10_000;

export interface Guest {
  jti: string;
  nick: string;
  joinedAt: string;
  expiresAt: string;
  revoked: boolean;
}

function joinedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `se unió a las ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Panel del host (F5): lista los invitados (`GET /rooms/:id/guests`) y permite retirarlos
 * con confirmación (`POST /rooms/:id/guests/:jti/revoke`). sync-core cierra su socket con
 * 4001 y el invitado ve el aviso de expulsión.
 */
export function ParticipantsPanel({ roomId }: { roomId: string }) {
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const base = `/rooms/${encodeURIComponent(roomId)}/guests`;

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch(base, { method: 'GET' }, 'host')
      .then((res: { guests?: Guest[] }) => setGuests(res?.guests ?? []))
      .catch(() => setError('No se pudo cargar la lista de participantes.'))
      .finally(() => setLoading(false));
  }, [base]);

  useEffect(load, [load]);

  // Los invitados entran sin avisar al host: se re-consulta mientras el panel está montado.
  useEffect(() => {
    const timer = setInterval(load, PARTICIPANTS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const cancel = (jti: string) => {
    setConfirming(null);
    // Devuelve el foco al botón que abrió la confirmación.
    queueMicrotask(() => triggerRefs.current.get(jti)?.focus());
  };

  const revoke = async (jti: string) => {
    setRevoking(true);
    setError('');
    try {
      await apiFetch(`${base}/${encodeURIComponent(jti)}/revoke`, { method: 'POST' }, 'host');
      setGuests((list) => (list ?? []).map((g) => (g.jti === jti ? { ...g, revoked: true } : g)));
      setConfirming(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo retirar al participante.');
      setConfirming(null);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-white">Participantes</h2>
        <Button variant="quiet" className="px-3 py-1.5 text-[13px]" onClick={load} aria-label="Actualizar participantes">
          Actualizar
        </Button>
      </div>

      {loading && guests === null && (
        <div className="mt-3 space-y-2">
          <p className="sr-only">Cargando participantes…</p>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}

      {guests !== null && guests.length === 0 && (
        <p className="mt-3 text-[13px] text-tint-muted">Aún no hay invitados en la sala.</p>
      )}

      {guests !== null && guests.length > 0 && (
        <ul aria-label="Invitados" className="mt-3">
          {/* Quien sale de la lista se desvanece y colapsa su altura (sin saltos). */}
          <AnimatePresence initial={false}>
            {guests.map((g) => (
              <m.li
                key={g.jti}
                className="overflow-hidden"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease }}
              >
                <div className="mb-2 rounded-xl bg-white/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{g.nick}</p>
                      <p className="text-[12px] text-tint-muted">{joinedLabel(g.joinedAt)}</p>
                    </div>
                    {g.revoked ? (
                      <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-[12px] text-tint-muted">
                        Retirado
                      </span>
                    ) : (
                      confirming !== g.jti && (
                        <Button
                          ref={(el) => {
                            if (el) triggerRefs.current.set(g.jti, el);
                            else triggerRefs.current.delete(g.jti);
                          }}
                          variant="ghost"
                          className="px-3 py-1.5 text-[13px]"
                          aria-label={`Retirar a ${g.nick}`}
                          onClick={() => setConfirming(g.jti)}
                        >
                          Retirar
                        </Button>
                      )
                    )}
                  </div>
                  {confirming === g.jti && !g.revoked && (
                    <div
                      role="group"
                      aria-label={`Confirmar retirar a ${g.nick}`}
                      className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2"
                      onKeyDown={(e) => e.key === 'Escape' && cancel(g.jti)}
                    >
                      <p className="text-[13px] text-white">¿Retirar a {g.nick}? Perderá el acceso a la sala.</p>
                      <Button
                        ref={confirmRef}
                        className="px-3 py-1.5 text-[13px]"
                        disabled={revoking}
                        onClick={() => revoke(g.jti)}
                      >
                        Sí, retirar
                      </Button>
                      <Button variant="quiet" className="px-3 py-1.5 text-[13px]" onClick={() => cancel(g.jti)}>
                        Cancelar
                      </Button>
                    </div>
                  )}
                </div>
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <ErrorAlert message={error} />
        </div>
      )}
    </div>
  );
}
