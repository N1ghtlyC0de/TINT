import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { inviteClaimErrorMessage } from '../lib/invite';
import { getDeviceId } from '../lib/deviceId';
import { Button } from '../components/ui/Button';
import { Field, ErrorAlert, Card } from '../components/ui/Primitives';

export default function InviteLanding() {
  const { code } = useParams();
  const [nick, setNick] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  // Con sesión de host, canjear la invitación la sustituye por una de invitado: se
  // avisa y solo se hace con confirmación explícita ("Entrar como invitado").
  const [hasHostSession] = useState(() => !!localStorage.getItem('tint_token'));
  /** Sala del host con esta invitación: undefined = buscando, null = no es suya. */
  const [hostRoomId, setHostRoomId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!hasHostSession) return;
    let cancelled = false;
    apiFetch('/rooms', { method: 'GET' }, 'host')
      .then((res: { rooms?: { id: string; invitation?: { code: string } | null }[] }) => {
        const own = (res.rooms ?? []).find((room) => room.invitation?.code === code);
        if (!cancelled) setHostRoomId(own?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setHostRoomId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasHostSession, code]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const deviceId = getDeviceId();
    try {
      const res = await apiFetch('/invitations/claim', {
        method: 'POST',
        // deviceId: permite al host bloquear por dispositivo (se omite si no hay UUID).
        body: JSON.stringify({ code, nick, ...(deviceId ? { deviceId } : {}) }),
      });
      localStorage.removeItem('tint_token');
      localStorage.setItem('tint_guest_token', res.token);
      // El invitado no tiene auth de host: se guarda el título y el link
      // para mostrarlos en la sala sin pedirlos al backend.
      // Sin título se borra el guardado: si no, se vería el de otra invitación.
      if (res.roomTitle) localStorage.setItem('tint_room_title', res.roomTitle);
      else localStorage.removeItem('tint_room_title');
      if (code) localStorage.setItem('tint_invite_link', `/invite/${code}`);
      navigate(`/watch/${res.roomId}`);
    } catch (err) {
      setError(inviteClaimErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="grid min-h-[100dvh] bg-tint-bg text-tint-muted md:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden md:block" aria-hidden="true">
        <img
          src="https://picsum.photos/seed/tint-guest/1200/1400"
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-45"
          loading="eager"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-tint-bg via-tint-bg/60 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-10">
          <h1 className="max-w-[18ch] text-4xl font-bold leading-[1.05] tracking-tighter text-white">
            Te invitaron a ver algo juntos
          </h1>
          <p className="mt-3 max-w-[44ch] text-sm leading-relaxed">
            Elige un nick y entra como participante. Sin cuenta, sin fricción.
          </p>
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md p-8">
          <p className="text-[11px] uppercase tracking-[0.18em] text-tint-accent">Invitación</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Unirse a la sala</h2>
          <p className="mt-2 text-sm leading-relaxed">
            Código <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[13px] text-white">{code}</span>
          </p>

          {hasHostSession && (
            <div role="note" className="mt-6 rounded-xl border border-tint-accent/30 bg-tint-accent/10 p-4 text-[13px] leading-relaxed">
              <p className="font-semibold text-white">Tienes una sesión de host abierta</p>
              <p className="mt-1">
                Si entras como invitado se cerrará tu sesión de host en este navegador.
              </p>
              {hostRoomId && (
                <Link
                  to={`/watch/${hostRoomId}`}
                  className="mt-3 inline-flex rounded-full bg-tint-accent px-4 py-2 text-sm font-semibold text-tint-bg transition hover:bg-tint-accentHover"
                >
                  Entrar como host
                </Link>
              )}
              {hostRoomId === null && (
                <Link to="/dashboard" className="mt-3 inline-flex text-tint-accent underline-offset-4 hover:underline">
                  Ir a mis salas
                </Link>
              )}
            </div>
          )}

          <form onSubmit={handleJoin} className="mt-6 space-y-5">
            <Field label="Nick" htmlFor="nick" helper="Así te verán en el chat y las reacciones.">
              <input
                id="nick"
                className="w-full rounded-xl border border-white/10 bg-tint-bg px-4 py-2.5 text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none"
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                placeholder="Nick"
                autoComplete="nickname"
                required
                minLength={2}
                maxLength={24}
              />
            </Field>
            <Button
              className="w-full"
              type="submit"
              variant={hasHostSession ? 'ghost' : undefined}
              disabled={loading || nick.trim().length < 2}
            >
              {loading ? 'Uniendo…' : hasHostSession ? 'Entrar como invitado' : 'Unirse'}
            </Button>
            {error && <ErrorAlert message={error} />}
          </form>

          <p className="mt-6 border-t border-white/10 pt-4 text-[13px]">
            ¿Eres el host?{' '}
            <Link to="/login" className="text-tint-accent underline-offset-4 hover:underline">
              Inicia sesión
            </Link>
          </p>
        </Card>
      </section>
    </div>
  );
}
