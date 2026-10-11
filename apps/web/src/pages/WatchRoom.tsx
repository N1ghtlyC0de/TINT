import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { ReactionBar } from '../components/ReactionBar';
import { CopyButton } from '../components/CopyButton';
import { BackLink } from '../components/ui/BackLink';
import { BrandMark } from '../components/layout/AppShell';
import { Button } from '../components/ui/Button';
import { Card, Field } from '../components/ui/Primitives';
import { apiFetch } from '../lib/api';
import { toAbsoluteInviteLink, pickLatestActiveInvitation, parseInviteCode } from '../lib/invite';
import { formatChatTime, noticeText } from '../lib/socialSocket';
import { useSocialSocket } from '../hooks/useSocialSocket';

export default function WatchRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const guestToken = localStorage.getItem('tint_guest_token');
  const hostToken = localStorage.getItem('tint_token');
  // Sin ningún token no hay cómo autenticar el socket (401 + reconexión
  // infinita): se muestra la puerta en vez de la sala.
  const hasAccess = !!hostToken || !!guestToken;
  // Canal Social (/ws/social): el estado maestro del chat vive en social-core.
  const { messages, send, status } = useSocialSocket(hasAccess ? roomId : undefined);
  // Si hay sesión de host, manda el host aunque queden restos de invitado
  // (p. ej. guest token de una visita anterior al login). Coherente con
  // apiFetch, que prefiere el header de host.
  const isGuest = !localStorage.getItem('tint_token') && !!guestToken;
  const [chat, setChat] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteHint, setInviteHint] = useState('');
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chat.trim();
    if (!text) return;
    if (send(text)) setChat('');
  };

  // Título y link de invitación: el host los pide al backend; el invitado
  // usa los guardados al canjear (su token no tiene auth de host).
  useEffect(() => {
    if (!roomId || !hasAccess) return;
    if (isGuest) {
      setRoomTitle(localStorage.getItem('tint_room_title'));
      setInviteLink(localStorage.getItem('tint_invite_link'));
      return;
    }
    let cancelled = false;
    Promise.all([apiFetch(`/rooms/${roomId}`), apiFetch(`/rooms/${roomId}/invitations`)])
      .then(([roomRes, invRes]) => {
        if (cancelled) return;
        setRoomTitle(roomRes.room?.title ?? null);
        const list = (invRes.invitations ?? []) as { code: string; link?: string; expiresAt: string; createdAt?: string; revoked?: boolean }[];
        const latest = pickLatestActiveInvitation(
          list.filter((inv) => inv.link).map((inv) => ({ code: inv.code, link: inv.link as string, expiresAt: inv.expiresAt, createdAt: inv.createdAt, revoked: inv.revoked })),
        );
        setInviteLink(latest?.link ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setRoomTitle(null);
          setInviteLink(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, isGuest, hasAccess]);

  const heading = roomTitle?.trim() ? roomTitle : `Sala ${roomId}`;

  const chatStatus =
    status === 'open' ? 'Chat conectado' : status === 'closed' ? 'Chat desconectado' : 'Chat reconectando…';

  // Auto-scroll inteligente: baja al fondo solo si el usuario ya estaba abajo,
  // para no robar la lectura de mensajes antiguos cuando llegan nuevos.
  const listRef = useRef<HTMLUListElement | null>(null);
  const stickRef = useRef(true);

  const onListScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleGateJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const code = parseInviteCode(invite);
    if (!code) {
      setInviteHint('Ese link no parece válido. Revisa que incluya /invite/ o el código.');
      return;
    }
    setInviteHint('');
    navigate(`/invite/${code}`);
  };

  if (!hasAccess) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-tint-bg px-4 text-tint-muted">
        <Card className="w-full max-w-md p-8">
          <p className="text-[11px] uppercase tracking-[0.18em] text-tint-accent">Sala privada</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">Únete a esta sala</h1>
          <p className="mt-2 text-sm leading-relaxed">
            Necesitas un link de invitación o ser el host para ver el contenido y chatear.
          </p>
          <form onSubmit={handleGateJoin} className="mt-6 space-y-4">
            <Field label="Link de invitación" htmlFor="gate-invite" error={undefined}>
              <input
                id="gate-invite"
                className="w-full rounded-xl border border-white/10 bg-tint-bg px-4 py-2.5 text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder="Pega el link o el código"
                autoComplete="off"
              />
            </Field>
            {inviteHint && <p className="text-[13px] text-red-300">{inviteHint}</p>}
            <Button type="submit" disabled={invite.trim().length === 0} className="w-full">
              Continuar
            </Button>
          </form>
          <p className="mt-6 border-t border-white/10 pt-4 text-[13px]">
            ¿Eres el host?{' '}
            <Link
              to={`/login?next=${encodeURIComponent(`/watch/${roomId ?? ''}`)}`}
              className="text-tint-accent underline-offset-4 hover:underline"
            >
              Inicia sesión
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-tint-bg text-tint-muted">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-tint-bg/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <BackLink />
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-white" title={heading}>
              {heading}
            </h1>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] text-tint-muted">
              Rol: {isGuest ? 'participante (invitado)' : 'host (registrado)'}
            </span>
            {inviteLink && (
              <span className="hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1 text-[12px] sm:inline-flex">
                <span className="max-w-[180px] truncate text-tint-muted" title={toAbsoluteInviteLink(inviteLink)}>
                  {toAbsoluteInviteLink(inviteLink)}
                </span>
                <CopyButton link={inviteLink} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2" aria-label="Estado de sincronía">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-tint-success" />
            <span className="text-[13px] text-white">Sincronizado</span>
          </div>
          <p className="text-[12px]" role="status" aria-live="polite">
            {chatStatus}
          </p>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] gap-4 px-4 py-6 lg:grid-cols-[2fr_360px]">
        <section aria-label="Reproductor">
          <Card className="overflow-hidden">
            <div className="relative aspect-video bg-black">
              <img
                src={`https://picsum.photos/seed/tint-watch-${roomId}/1280/720`}
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-40"
                loading="eager"
              />
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex flex-col items-center gap-3">
                  <button
                    type="button"
                    aria-label="Reproducir"
                    className="grid h-16 w-16 place-items-center rounded-full bg-tint-accent text-tint-bg transition hover:bg-tint-accentHover active:scale-[0.98]"
                  >
                    <span aria-hidden="true" className="ml-1 text-xl">▶</span>
                  </button>
                  <p className="text-[13px]">Reproductor (simulado)</p>
                </div>
              </div>
              <div className="absolute inset-x-0 bottom-0 p-4">
                <div
                  className="h-1 overflow-hidden rounded-full bg-white/15"
                  role="progressbar"
                  aria-label="Progreso"
                  aria-valuenow={0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full w-0 bg-tint-accent" />
                </div>
              </div>
            </div>
            <div aria-hidden="true" className="h-1.5 bg-gradient-to-r from-tint-accentDark via-tint-accent to-tint-accentDark opacity-70 blur-[6px]" />
            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-medium text-white">Reproducción sincronizada</p>
                <p className="mt-0.5 text-[13px]">
                  Controles de host listos para /ws/sync
                </p>
              </div>
              <ReactionBar onReact={() => {}} />
            </div>
          </Card>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-[15px] font-semibold text-white">Trivia</h2>
              <p className="mt-1 text-[13px] leading-relaxed">
                Las preguntas de social-core aparecerán aquí durante la reproducción.
              </p>
            </Card>
            <Card className="p-5">
              <h2 className="text-[15px] font-semibold text-white">Ambilight</h2>
              <p className="mt-1 text-[13px] leading-relaxed">
                Visualización lista para ambilight.json de media-worker.
              </p>
              <div aria-hidden="true" className="mt-3 flex gap-1.5">
                {['#FF6B1A', '#C4520A', '#313338', '#B5BAC1', '#1E1F22'].map((c) => (
                  <span key={c} style={{ background: c }} className="h-6 flex-1 rounded-md border border-white/10" />
                ))}
              </div>
            </Card>
          </div>

          {/* TODO: conectar a /ws/sync (sync-core) */}
        </section>

        <aside aria-label="Social" className="flex min-h-0 flex-col gap-4">
          <Card className="flex h-[560px] min-h-0 flex-col p-5 lg:h-[calc(100dvh-7rem)]">
            <h2 className="text-[15px] font-semibold text-white">Chat en vivo</h2>
            {messages.length === 0 ? (
              <p className="mt-3 flex-1 rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-4 text-[13px] leading-relaxed">
                Sin mensajes aún. Saluda y prueba la sincronía con tu grupo.
              </p>
            ) : (
              <ul
                ref={listRef}
                onScroll={onListScroll}
                className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto"
                aria-live="polite"
              >
                {messages.map((m) =>
                  m.type === 'notice' ? (
                    <li
                      key={m.event_id}
                      className="px-3 py-1 text-center text-[12px] italic text-tint-muted/80"
                    >
                      {noticeText(m)}
                    </li>
                  ) : (
                    <li key={m.event_id} className="rounded-xl bg-white/5 px-3 py-2 text-[13px]">
                      <span className="font-semibold text-white">{m.nick}: </span>
                      <span>{m.text}</span>{' '}
                      {formatChatTime(m.occurred_at) && (
                        <time dateTime={m.occurred_at} className="text-[11px] text-tint-muted/70">
                          {formatChatTime(m.occurred_at)}
                        </time>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
            <form onSubmit={sendChat} className="mt-4 flex gap-2">
              <label htmlFor="chat-input" className="sr-only">
                Escribe un mensaje
              </label>
              <input
                id="chat-input"
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                placeholder="Escribe un mensaje"
                maxLength={280}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none"
              />
              <button
                type="submit"
                className="shrink-0 rounded-full bg-tint-accent px-4 py-2 text-sm font-semibold text-tint-bg transition hover:bg-tint-accentHover active:scale-[0.98]"
              >
                Enviar
              </button>
            </form>
          </Card>
        </aside>
      </main>
    </div>
  );
}
