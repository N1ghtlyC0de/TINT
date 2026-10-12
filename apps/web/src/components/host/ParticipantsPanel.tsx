import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../lib/api';
import { banErrorMessage, banGuest, listBans, unbanGuest, type RoomBan } from '../../lib/bans';
import { Button } from '../ui/Button';
import { ErrorAlert, Skeleton } from '../ui/Primitives';

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

type PendingAction = { jti: string; kind: 'revoke' | 'ban' };

/**
 * Panel del host (F5): lista los invitados (`GET /rooms/:id/guests`) y permite retirarlos
 * (`POST /rooms/:id/guests/:jti/revoke`) o bloquearlos por dispositivo
 * (`POST /rooms/:id/bans {jti}`), ambos con confirmación. sync-core cierra su socket con
 * 4001. La sección "Bloqueados" (`GET /rooms/:id/bans`) permite desbloquear.
 */
export function ParticipantsPanel({ roomId }: { roomId: string }) {
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<PendingAction | null>(null);
  const [bans, setBans] = useState<RoomBan[] | null>(null);
  const [bansError, setBansError] = useState('');
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
    listBans(roomId)
      .then((list) => {
        setBans(list);
        setBansError('');
      })
      .catch(() => setBansError('No se pudo cargar la lista de bloqueados.'));
  }, [base, roomId]);

  useEffect(load, [load]);

  // Los invitados entran sin avisar al host: se re-consulta mientras el panel está montado.
  useEffect(() => {
    const timer = setInterval(load, PARTICIPANTS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const cancel = (action: PendingAction) => {
    setConfirming(null);
    // Devuelve el foco al botón que abrió la confirmación.
    queueMicrotask(() => triggerRefs.current.get(`${action.kind}:${action.jti}`)?.focus());
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

  const ban = async (guest: Guest) => {
    setRevoking(true);
    setError('');
    try {
      const created = await banGuest(roomId, { jti: guest.jti });
      setGuests((list) => (list ?? []).map((g) => (g.jti === guest.jti ? { ...g, revoked: true } : g)));
      setBans((list) => [...(list ?? []).filter((b) => b.id !== created.id), created]);
    } catch (err) {
      setError(banErrorMessage(err, guest.nick));
    } finally {
      setConfirming(null);
      setRevoking(false);
    }
  };

  const unban = async (entry: RoomBan) => {
    setError('');
    try {
      await unbanGuest(roomId, entry.id);
      setBans((list) => (list ?? []).filter((b) => b.id !== entry.id));
    } catch {
      setError(`No se pudo desbloquear a ${entry.nick}.`);
    }
  };

  const triggerRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) triggerRefs.current.set(key, el);
    else triggerRefs.current.delete(key);
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
        <ul aria-label="Invitados" className="mt-3 space-y-2">
          {guests.map((g) => (
            <li key={g.jti} className="rounded-xl bg-white/5 px-3 py-2">
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
                  confirming?.jti !== g.jti && (
                    <span className="flex shrink-0 gap-2">
                      <Button
                        ref={triggerRef(`revoke:${g.jti}`)}
                        variant="ghost"
                        className="px-3 py-1.5 text-[13px]"
                        aria-label={`Retirar a ${g.nick}`}
                        onClick={() => setConfirming({ jti: g.jti, kind: 'revoke' })}
                      >
                        Retirar
                      </Button>
                      <Button
                        ref={triggerRef(`ban:${g.jti}`)}
                        variant="ghost"
                        className="px-3 py-1.5 text-[13px] text-red-200"
                        aria-label={`Bloquear a ${g.nick}`}
                        onClick={() => setConfirming({ jti: g.jti, kind: 'ban' })}
                      >
                        Bloquear
                      </Button>
                    </span>
                  )
                )}
              </div>
              {confirming?.jti === g.jti && !g.revoked && (
                <div
                  role="group"
                  aria-label={`Confirmar ${confirming.kind === 'ban' ? 'bloquear' : 'retirar'} a ${g.nick}`}
                  className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2"
                  onKeyDown={(e) => e.key === 'Escape' && cancel(confirming)}
                >
                  <p className="text-[13px] text-white">
                    {confirming.kind === 'ban'
                      ? `¿Bloquear a ${g.nick}? Saldrá de la sala y no podrá volver a entrar desde este dispositivo.`
                      : `¿Retirar a ${g.nick}? Perderá el acceso a la sala.`}
                  </p>
                  <Button
                    ref={confirmRef}
                    className="px-3 py-1.5 text-[13px]"
                    disabled={revoking}
                    onClick={() => (confirming.kind === 'ban' ? ban(g) : revoke(g.jti))}
                  >
                    {confirming.kind === 'ban' ? 'Sí, bloquear' : 'Sí, retirar'}
                  </Button>
                  <Button variant="quiet" className="px-3 py-1.5 text-[13px]" onClick={() => cancel(confirming)}>
                    Cancelar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 text-[13px] font-semibold text-white">Bloqueados</h3>
      {bans !== null && bans.length === 0 && <p className="mt-2 text-[13px] text-tint-muted">Nadie está bloqueado.</p>}
      {bans !== null && bans.length > 0 && (
        <ul aria-label="Bloqueados" className="mt-2 space-y-2">
          {bans.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2">
              <p className="min-w-0 truncate text-sm text-white">{b.nick}</p>
              <Button
                variant="quiet"
                className="px-3 py-1.5 text-[13px]"
                aria-label={`Desbloquear a ${b.nick}`}
                onClick={() => unban(b)}
              >
                Desbloquear
              </Button>
            </li>
          ))}
        </ul>
      )}
      {bansError && <p className="mt-2 text-[13px] text-tint-muted">{bansError}</p>}

      {error && (
        <div className="mt-3">
          <ErrorAlert message={error} />
        </div>
      )}
    </div>
  );
}
